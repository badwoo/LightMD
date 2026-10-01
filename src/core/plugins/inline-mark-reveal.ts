/**
 * E6(v0.9.4)：行内语法标记显示插件
 *
 * 光标位于某个行内 mark（strong/em/code/strike/mark/sub/sup/underline/link）
 * 的区间内（含边界 ±1）时，在该区间两侧以伪元素显示对应的 Markdown 源码符号
 * （`**`、`*`、`` ` ``、`~~`、`==`、`~`、`^`、`<u>`/`</u>`、`[`/`](url)`），
 * 向 Typora「光标所在元素显示源码」的语义靠拢。
 *
 * 实现要点：
 * - 使用 `Decoration.inline` + class + CSS `::before/::after { content: attr(...) }`，
 *   不新增可编辑 DOM 节点，Decoration 随事务自动 map（undo/redo 安全）。
 * - 仅扫描**光标所在文本块**（O(块内)），禁止全文档遍历（性能红线）。
 * - 有选区时不显示（与 wysiwyg.ts 的块级 marker 行为一致）。
 * - 与 wysiwyg.ts 的块级 widget 装饰并存互补（PM 会合并多个插件的 decorations）。
 *
 * 已知限制（第一版接受）：嵌套 mark（如粗斜体 `***x***`）会同时显示两组符号，
 * 与源码书写形态一致但不做合并。
 */
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { EditorState } from "prosemirror-state";
import type { Mark, Node } from "prosemirror-model";

export const inlineMarkRevealKey = new PluginKey<DecorationSet>("inlineMarkReveal");

/** mark 类型 → 显示的源码符号（link 单独处理） */
const MARK_SYMBOLS: Record<string, { open: string; close: string }> = {
  strong: { open: "**", close: "**" },
  em: { open: "*", close: "*" },
  code: { open: "`", close: "`" },
  strike: { open: "~~", close: "~~" },
  mark: { open: "==", close: "==" },
  subscript: { open: "~", close: "~" },
  superscript: { open: "^", close: "^" },
  underline: { open: "<u>", close: "</u>" },
};

/** 单条待显示的行内区间 */
export interface RevealRange {
  from: number;
  to: number;
  /** 起始侧要显示的源码符号 */
  open: string;
  /** 结束侧要显示的源码符号 */
  close: string;
  /** link 专用的完整 href（其余 mark 无此字段） */
  href?: string;
}

/** mark 的唯一键（类型 + 属性），用于合并相邻同 mark 文本节点 */
function markKey(mark: Mark): string {
  return mark.type.name + ":" + JSON.stringify(mark.attrs);
}

/** 把「进行中的区间」转为带源码符号的 RevealRange */
function toRange(r: { mark: Mark; from: number; to: number }): RevealRange {
  if (r.mark.type.name === "link") {
    const href = String(r.mark.attrs.href || "");
    return { from: r.from, to: r.to, open: "[", close: `](${href})`, href };
  }
  const sym = MARK_SYMBOLS[r.mark.type.name];
  return { from: r.from, to: r.to, open: sym.open, close: sym.close };
}

/**
 * 收集文本块内、光标所在的 mark 区间（纯函数，便于单测）。
 *
 * @param parent     光标所在文本块节点（content 为 inline*）
 * @param contentStart 该块内容起始的绝对文档位置（$from.start()）
 * @param cursorPos  光标绝对位置
 */
export function collectRevealRanges(
  parent: Node,
  contentStart: number,
  cursorPos: number,
): RevealRange[] {
  const ranges: RevealRange[] = [];
  // markKey → 进行中的区间（相邻同 mark 文本节点会合并）
  const open = new Map<string, { mark: Mark; from: number; to: number }>();
  let offset = 0;

  parent.forEach((child) => {
    const childStart = contentStart + offset;
    offset += child.nodeSize;

    if (!child.isText) {
      // 非文本行内节点（image/math_inline/hard_break 等）不承载 mark：终止全部区间
      for (const r of open.values()) ranges.push(toRange(r));
      open.clear();
      return;
    }

    const childEnd = childStart + child.nodeSize;
    const present = new Set<string>();
    for (const mark of child.marks) {
      const name = mark.type.name;
      if (name !== "link" && !(name in MARK_SYMBOLS)) continue;
      const key = markKey(mark);
      present.add(key);
      const cur = open.get(key);
      if (cur) cur.to = childEnd;
      else open.set(key, { mark, from: childStart, to: childEnd });
    }
    // 关闭本节点不再携带的 mark 区间
    for (const [key, r] of open) {
      if (!present.has(key)) {
        ranges.push(toRange(r));
        open.delete(key);
      }
    }
  });
  for (const r of open.values()) ranges.push(toRange(r));

  // 仅保留包含光标的区间（含紧邻边界 ±1，光标贴着标记边缘也显示符号）
  return ranges.filter((r) => cursorPos >= r.from - 1 && cursorPos <= r.to + 1);
}

/** 依据当前选区/文档计算装饰集 */
function computeDecorations(state: EditorState): DecorationSet {
  const { selection } = state;
  if (!selection.empty) return DecorationSet.empty;

  const $from = selection.$from;
  // 仅在文本块内生效（paragraph/heading/table_cell…）
  if (!$from.parent.inlineContent) return DecorationSet.empty;

  const ranges = collectRevealRanges($from.parent, $from.start(), $from.pos);
  if (ranges.length === 0) return DecorationSet.empty;

  const decos = ranges.map((r) => {
    const attrs: Record<string, string> = {
      class: "md-reveal",
      "data-md-open": r.open,
      "data-md-close": r.close,
    };
    if (r.href) attrs["data-href"] = r.href;
    return Decoration.inline(r.from, r.to, attrs);
  });
  return DecorationSet.create(state.doc, decos);
}

/** E6：行内语法标记显示插件 */
export const inlineMarkRevealPlugin = new Plugin<DecorationSet>({
  key: inlineMarkRevealKey,

  state: {
    init(_config, state) {
      return computeDecorations(state);
    },

    apply(tr, old, _oldState, newState) {
      // 文档与选区都没变 → 复用（零成本）
      if (!tr.docChanged && !tr.selectionSet) return old;
      // 文本块内扫描成本极低（O(块内)），直接重算，保证 mark 增删即时反映
      return computeDecorations(newState);
    },
  },

  props: {
    decorations(state) {
      return this.getState(state);
    },
  },
});
