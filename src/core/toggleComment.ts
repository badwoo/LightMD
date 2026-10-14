/**
 * v0.13.0 需求6：选区多行批量注释 `Ctrl+/`。
 *
 * ## 语义
 *
 * | 场景 | 行为 |
 * | --- | --- |
 * | 阅读模式有选区（跨多行/多块） | 对整段选区切换 `comment` mark |
 * | 阅读模式无选区（光标在某块内） | 整块内容切换（Obsidian 语义） |
 * | 再按一次 | 取消注释（toggle），内容复原 |
 * | 选区**部分**已注释 | 全部加上（不是取消） |
 *
 * ## 为什么用 mark
 *
 * 三模式必须行为一致：只在源码模式做「行首插 `<!-- `、行尾插 ` -->`」的话，
 * 阅读模式的 PM 选区做不到同样的事。用 mark 后两模式都能表达同一语义，
 * 序列化时统一输出 `<!--text-->`（见 serializer 的 `applyMark`）。
 *
 * ## add / remove 方向为什么自己判定
 *
 * PM 的 `toggleMark` 在「选区里只有部分文本带该 mark」时走**移除**分支——
 * 于是想给「二三四」加注释（其中「二三」已有注释）反而会把「二三」的注释去掉。
 * 本命令因此不用 `toggleMark`，改用 `addMark` / `removeMark` 并自己判定方向：
 * 区间内文本**全部**已注释 → 移除；否则 → 添加。
 *
 * ## 导出排除
 *
 * - HTML/PDF/PNG：`renderPipeline` 的 `html_inline` 规则把注释原样透传，
 *   浏览器忽略注释内容 → 视觉上不出现；
 * - DOCX/EPUB/LaTeX：`exportBlocks.parseInlineTokens` 显式剔除注释 token
 *   （其实例 `html:false`，注释是普通 text token，必须按内容形态过滤）。
 */
import type { Command, EditorState } from "prosemirror-state";
import { TextSelection } from "prosemirror-state";
import { lightMDSchema } from "./schema";

const schema = lightMDSchema;

/** comment mark 是否存在（schema 未启用时优雅降级） */
function commentMark() {
  return schema.marks.comment ?? null;
}

/**
 * 在 [from, to) 内为所有文本节点**添加或移除** mark。
 *
 * PM 自带命令只有 `toggleMark`，其「部分命中走移除」启发式不符合本需求
 * （想给「二三四」加注释时，「二三」已有注释会被误判为移除），故自己实现：
 * `tr.addMark` / `tr.removeMark` 对整段区间生效，且能跨块。
 *
 * @param markType mark 类型（`schema.marks.comment`），内部 create() 出实例
 */
function markCommand(markType: import("prosemirror-model").MarkType, add: boolean): Command {
  return (state, dispatch) => {
    const { from, to } = state.selection;
    if (from === to) return false;
    if (dispatch) {
      const tr = state.tr;
      const mark = markType.create();
      if (add) tr.addMark(from, to, mark);
      else tr.removeMark(from, to, mark);
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/**
 * 区间 [from, to) 内的**所有**文本节点是否都带 comment mark。
 *
 * - 区间内没有文本节点 → false（无可注释内容）；
 * - 有任一文本节点没带 mark → false；
 * - 全部带 → true。
 */
function selectionRangeFullyCommented(state: EditorState, from: number, to: number): boolean {
  let sawText = false;
  let missing = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return true;
    sawText = true;
    const has = (node.marks ?? []).some((m) => m.type.name === "comment");
    if (!has) missing = true;
    return !missing; // 已发现未注释文本 → 提前结束遍历
  });
  return sawText && !missing;
}

/**
 * `Ctrl+/` 命令：切换注释。
 *
 * - 有选区 → 对选区切换；
 * - 无选区 → 扩展到所在**顶层块**的整块内容（Obsidian 语义）。
 */
export const toggleComment: Command = (state, dispatch, view) => {
  const mark = commentMark();
  if (!mark) return false;

  const { selection } = state;
  const { from, to } = selection;

  // 无选区：扩展到光标所在的顶层块（depth 1）
  let rangeFrom = from;
  let rangeTo = to;
  if (from === to) {
    const $from = selection.$from;
    if ($from.depth < 1) return false;
    const blockStart = $from.start(1);
    const blockEnd = $from.end(1);
    if (blockEnd <= blockStart) return false;
    rangeFrom = blockStart;
    rangeTo = blockEnd;
  }

  if (rangeTo <= rangeFrom) return false;

  // 方向判定见模块 jsdoc：全部已注释 → 移除，否则 → 添加
  const allCommented = selectionRangeFullyCommented(state, rangeFrom, rangeTo);
  const sel = TextSelection.create(state.doc, rangeFrom, rangeTo);
  const ranged = state.apply(state.tr.setSelection(sel));
  return markCommand(mark, !allCommented)(ranged, dispatch, view);
};

/** 供设置/命令面板查询：comment mark 是否可用 */
export function isCommentMarkAvailable(): boolean {
  return !!commentMark();
}
