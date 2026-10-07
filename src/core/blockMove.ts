/**
 * v0.11.0 B3-8：真正的块移动命令（moveBlockUp / moveBlockDown）。
 *
 * 缺陷背景（P1）：
 *   `core/keymap.ts` 把 `Alt-ArrowUp/Down` 绑到 `joinUp` / `lift`
 *   （**合并 / 提升**），与 UI 宣称的「移动块」语义完全不符 ——
 *   属**误导性半成品**：用户按 Alt+↑ 期望块上移一格，实际却是把当前块
 *   与上方块合并（内容会拼到一起）。
 *
 * 本模块实现真正的「交换相邻顶层块」：
 * - 仅处理**顶层块**（段落/标题/代码块/表格等）；嵌套结构（列表项/引用内）
 *   返回 false，交回静态 keymap 的既有行为，避免重排子树破坏 schema
 *   （如 list_item 要求首子为 paragraph）。
 * - 用单次 replaceStep 完成交换 → history 可正确记录为一次撤销单元。
 *
 * 依赖：prosemirror-transform（package.json 已有 ^1.10.0）。
 */
import type { Command, EditorState } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { TextSelection } from "prosemirror-state";

/** 计算第 index 个顶层块在 doc 中的起始 pos */
function posOfChild(doc: PMNode, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  return pos;
}

/**
 * 移动当前顶层块：dir = -1 上移 / +1 下移。
 */
function buildMove(dir: -1 | 1): Command {
  return (state, dispatch) => {
    const $from = state.selection.$from;
    // v0.11.0 B3-8 返修：**只在顶层生效**。
    // 光标落在列表项/引用等嵌套结构内时，$from.index(0) 取到的是**顶层祖先**
    // （整个列表 / 整个引用），移动它会重排整棵子树，与本文档承诺的
    // 「嵌套返回 false」以及 keymap 的注释都不符（既有 Alt+Shift+↑/↓ 承载
    // 原 joinUp/lift 语义，故这里不再"回退旧行为"，直接不处理）。
    if ($from.depth > 1) return false;
    // 顶层块索引：块级叶子（表格/图片/分隔线）被 NodeSelection 选中时
    // $from.depth === 0，其 index(0) 依然有效。旧实现在 depth < 1 时直接
    // return false，导致这些块完全移不动。
    const index = $from.index(0);
    const targetIndex = index + dir;
    if (index < 0 || targetIndex < 0 || targetIndex >= state.doc.childCount) return false;

    const cur = state.doc.child(index);
    const tgt = state.doc.child(targetIndex);
    if (!cur || !tgt) return false;

    if (dispatch) {
      const curPos = posOfChild(state.doc, index);
      const tgtPos = posOfChild(state.doc, targetIndex);
      // 替换区间覆盖两个块：from 取靠前者的起点，to 取靠后者的终点
      // （两者 nodeSize 必须分别加到各自的起点上求 max，不能对 nodeSize 取 max）
      const from = Math.min(curPos, tgtPos);
      const to = Math.max(curPos + cur.nodeSize, tgtPos + tgt.nodeSize);
      // 交换后的顺序：**被移动的块 cur 排到目标位置**
      //   上移（dir=-1）：[cur, tgt]（cur 原本在后，交换后到前面）
      //   下移（dir=+1）：[tgt, cur]（cur 原本在前，交换后到后面）
      const tr =
        dir === -1
          ? state.tr.replaceWith(from, to, [cur, tgt])
          : state.tr.replaceWith(from, to, [tgt, cur]);

      // 光标跟随被移动的块，保持块内相对偏移
      const offsetInCur = $from.pos - curPos;
      const newCurPos = dir === -1 ? tgtPos : curPos + tgt.nodeSize;
      const newPos = newCurPos + Math.min(offsetInCur, cur.nodeSize - 1);
      if (newPos > 0 && newPos <= tr.doc.content.size) {
        tr.setSelection(TextSelection.create(tr.doc, newPos));
      }
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/** 当前顶层块上移一位（与下块交换） */
export const moveBlockUp: Command = buildMove(-1);

/** 当前顶层块下移一位（与上块交换） */
export const moveBlockDown: Command = buildMove(1);

/**
 * 键位说明（导出便于测试与文档引用）。
 * Alt+↑/↓ = 块移动；Alt+Shift+↑/↓ = 原 joinUp/lift（合并/提升）。
 */
export const BLOCK_MOVE_KEYMAP_NOTE = {
  moveUp: "Alt-ArrowUp",
  moveDown: "Alt-ArrowDown",
  legacyJoinLift: ["Alt-Shift-ArrowUp", "Alt-Shift-ArrowDown"],
} as const;
