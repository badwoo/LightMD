/**
 * WYSIWYG 核心插件 —— 光标驱动的源码/渲染切换
 *
 * v0.12.0 需求3：块级标记改用 Decoration.node + CSS 伪元素（绝对定位）。
 * 原实现用 Decoration.widget 插入真实 <span>（marker-reveal）参与行内布局——
 * 光标进入标题/引用/代码块时文本被右移、离开时左移（用户报告的"标题符号抖动"）。
 * 绝对定位伪元素完全脱离文档流，布局零影响。
 *
 * 历史修复保留：
 * - 装饰位置使用 $from.before(depth) / $from.after(depth)（节点边界）
 * - 简化内联标记装饰，避免位置冲突
 */
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { EditorState, Transaction } from "prosemirror-state";
import type { Node } from "prosemirror-model";

export const wysiwygKey = new PluginKey("wysiwyg");

/** v0.12.0 需求3：可显示标记的块类型。
 * 其余块（段落/列表项等）不作为查找终点——继续向外层找最近的标记块，
 * 否则引用块内的段落会抢先命中导致 "> " 标记永远不可达（旧实现的缺陷） */
const MARKABLE_BLOCKS = new Set(["heading", "blockquote", "code_block"]);

/**
 * 获取光标所在（或最近外层）的**可标记块级节点**及其节点边界
 */
function getActiveBlockNode(
  state: EditorState
): { node: Node; start: number; end: number } | null {
  const { $from } = state.selection;

  for (let depth = $from.depth; depth >= 1; depth--) {
    const node = $from.node(depth);
    if (MARKABLE_BLOCKS.has(node.type.name)) {
      // v0.12.0 需求3：Decoration.node 需要**节点边界**（before/after）——
      // 不能用 $from.start(depth)（内容起点，装饰范围会偏移一个节点、标记挂到错误位置）。
      // focus-mode.ts 的 $from.start(d) - 1 即同一语义，可作参照。
      return { node, start: $from.before(depth), end: $from.after(depth) };
    }
  }
  return null;
}

// ─── 装饰计算 ────────────────────────────────────────────

function computeDecorations(state: EditorState): DecorationSet {
  const decorations: Decoration[] = [];
  const { empty } = state.selection;

  if (!empty) return DecorationSet.empty;

  // 块级标记装饰（标题的 #、引用的 >、代码块的 ```）
  const activeBlock = getActiveBlockNode(state);
  if (activeBlock) {
    addBlockDecorations(decorations, activeBlock.node, activeBlock.start, activeBlock.end);
  }

  return DecorationSet.create(state.doc, decorations);
}

// ─── 块级装饰 ────────────────────────────────────────────

function addBlockDecorations(
  decos: Decoration[],
  node: Node,
  start: number,
  end: number
): void {
  // 按块类型决定标记文本（不需要标记的块直接返回）
  let marker: string;
  switch (node.type.name) {
    case "heading":
      marker = "#".repeat(node.attrs.level || 1) + " ";
      break;
    case "blockquote":
      marker = "> ";
      break;
    case "code_block": {
      const lang = node.attrs.language || "";
      marker = "```" + lang;
      break;
    }
    default:
      return;
  }
  // v0.12.0 需求3：Decoration.node 装饰整个节点（PM 会把 class/data 属性应用到
  // 节点 DOM 上，含自定义 NodeView 的 dom——updateInner→updateOuterDeco 自动完成），
  // 标记文本由 CSS ::before 以绝对定位渲染（脱离文档流，零布局影响）
  decos.push(
    Decoration.node(start, end, {
      class: "pm-block-marker",
      "data-md-block-open": marker,
    })
  );
}

// ─── 插件定义 ────────────────────────────────────────────

export const wysiwygPlugin = new Plugin({
  key: wysiwygKey,

  state: {
    init(_config, state) {
      return computeDecorations(state);
    },

    apply(tr, oldDecos, _oldState, newState) {
      // 如果没有文档变化且没有选区变化，复用旧装饰
      if (!tr.docChanged && !tr.selectionSet) {
        return oldDecos;
      }

      // 文档变化时映射旧装饰
      if (tr.docChanged) {
        const mapped = oldDecos.map(tr.mapping, tr.doc);
        // 选区也变化时重新计算
        if (tr.selectionSet) {
          return computeDecorations(newState);
        }
        return mapped;
      }

      // 仅选区变化，重新计算
      if (tr.selectionSet) {
        return computeDecorations(newState);
      }

      return oldDecos;
    },
  },

  props: {
    decorations(state) {
      return this.getState(state);
    },
  },
});