/**
 * WYSIWYG 核心插件 —— 光标驱动的源码/渲染切换
 *
 * 修复：
 * - 装饰位置使用 $from.before(depth) 而非 $from.start(depth)
 * - 简化内联标记装饰，避免位置冲突
 */
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { EditorState, Transaction } from "prosemirror-state";
import type { Node } from "prosemirror-model";

export const wysiwygKey = new PluginKey("wysiwyg");

/**
 * 获取光标所在的块级节点及其内容起始位置
 */
function getActiveBlockNode(
  state: EditorState
): { node: Node; pos: number } | null {
  const { $from } = state.selection;

  for (let depth = $from.depth; depth >= 1; depth--) {
    const node = $from.node(depth);
    if (node.type.isBlock && node.type.name !== "doc") {
      // 使用 start(depth) 直接获取节点内容起始位置，
      // 避免手动 pos+1 带来的边界错误
      const pos = $from.start(depth);
      return { node, pos };
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
    addBlockDecorations(decorations, activeBlock.node, activeBlock.pos);
  }

  return DecorationSet.create(state.doc, decorations);
}

// ─── 块级装饰 ────────────────────────────────────────────

function addBlockDecorations(
  decos: Decoration[],
  node: Node,
  pos: number
): void {
  // pos 已经是节点内容的起始位置（来自 $from.start(depth)），
  // 直接使用无需再加偏移
  switch (node.type.name) {
    case "heading": {
      const level = node.attrs.level || 1;
      const marker = "#".repeat(level) + " ";
      decos.push(
        Decoration.widget(pos, createMarkerDOM(marker), {
          side: -1,
        })
      );
      break;
    }
    case "blockquote": {
      decos.push(
        Decoration.widget(pos, createMarkerDOM("> "), {
          side: -1,
        })
      );
      break;
    }
    case "code_block": {
      const lang = node.attrs.language || "";
      const prefix = "```" + lang;
      decos.push(
        Decoration.widget(pos, createMarkerDOM(prefix), {
          side: -1,
        })
      );
      break;
    }
  }
}

// ─── DOM 创建 ────────────────────────────────────────────

function createMarkerDOM(text: string, inline = false): HTMLElement {
  const span = document.createElement("span");
  span.className = inline ? "marker-reveal marker-inline" : "marker-reveal marker-block";
  span.textContent = text;
  span.contentEditable = "false";
  return span;
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
