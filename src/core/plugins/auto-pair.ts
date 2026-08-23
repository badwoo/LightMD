/**
 * AutoPair —— N1 自动配对补全（v0.5.0）
 *
 * PM 端插件：输入开符号（([{ 和引号）时自动补全配对；
 * 有选区时包裹选中文本；输入闭符号且下一字符已是该闭符号时跳过（光标右移）。
 * textarea（源码模式）的配对逻辑在 EditorContainer 中，共用本模块的 PAIR_MAP。
 *
 * 设计要点：
 * - 仅处理单字符输入（text.length === 1），不干扰 IME 组合输入
 * - code_block / math_block / code_inline 内禁用（避免干扰代码输入）
 * - 设置开关：settings.autoPairEnabled（默认开启），通过 store.getState() 读取
 *   （plugin 无法订阅 React 状态，getState 在每次输入时读取最新值）
 */
import { Plugin, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { useSettingsStore } from "../../stores/useSettingsStore";

/** 开符号 → 闭符号映射（不含 $：避免输入价格等普通文本时误配对） */
export const PAIR_MAP: Record<string, string> = {
  "(": ")",
  "[": "]",
  "{": "}",
  '"': '"',
  "'": "'",
  "`": "`",
};

/** 闭符号集合（用于跳过逻辑） */
export const PAIR_CLOSERS = new Set(Object.values(PAIR_MAP));

/** 判断选区是否位于禁用自动配对的节点内（代码/公式）；smart-paste 插件复用 */
export function inDisabledNode(view: EditorView): boolean {
  const { $from } = view.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name;
    if (name === "code_block" || name === "math_block" || name === "code_inline") {
      return true;
    }
  }
  return false;
}

/** N1：自动配对补全插件 */
export function autoPairPlugin(): Plugin {
  return new Plugin({
    props: {
      handleTextInput(view, from, to, text) {
        if (!useSettingsStore.getState().autoPairEnabled) return false;
        // 仅处理单字符输入，避免干扰 IME 组合输入
        if (text.length !== 1) return false;
        if (inDisabledNode(view)) return false;

        const { state } = view;
        const close = PAIR_MAP[text];

        // 输入闭符号：若下一字符已是该闭符号，跳过输入（光标右移一位）
        if (!close && PAIR_CLOSERS.has(text)) {
          const next = state.doc.textBetween(to, to + 1);
          if (next === text) {
            const tr = state.tr;
            tr.setSelection(TextSelection.create(tr.doc, to + 1));
            view.dispatch(tr);
            return true;
          }
          return false;
        }
        if (!close) return false;

        const tr = state.tr;
        if (from !== to) {
          // 有选区：开闭符号包裹选中文本，并保持选中
          tr.insertText(text, from);
          tr.insertText(close, to + 1);
          tr.setSelection(TextSelection.create(tr.doc, from + 1, to + 1));
        } else {
          // 无选区：插入配对符号，光标置于中间
          tr.insertText(text + close, from, to);
          tr.setSelection(TextSelection.create(tr.doc, from + 1));
        }
        view.dispatch(tr);
        return true;
      },
    },
  });
}
