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
  // v0.8.0 修复5：中文标点补全（IME 提交单字符触发 handleTextInput，text.length===1 可通过）
  "“": "”", // 中文双引号
  "‘": "’", // 中文单引号
  "（": "）", // 中文圆括号
  "【": "】", // 中文方括号
  "《": "》", // 书名号
  "「": "」", // 中文直角引号（『』 不加）
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

        // v0.8.0 修复 P11-5：输入闭符号时"跳过已有右符号"（overtype）。
        //
        // 该判断必须在补全逻辑之前，且要对**自配对字符**（" ' ` 及中文引号）同样生效。
        // 旧实现的条件是 `!close`，即只处理 )]} 这类"非开符号"；而 " 在 PAIR_MAP 中
        // value 就是它自己（close 恒为真），永远走不到跳过分支 → 在文字中间输入第二个 "
        // 会被当成开符号再插入一对，出现 4 个引号。主流实现（VS Code closeBrackets /
        // CodeMirror closeBrackets）同样是"紧邻右侧已有相同字符则仅移动光标"。
        if (from === to && PAIR_CLOSERS.has(text)) {
          const next = state.doc.textBetween(to, to + 1);
          if (next === text) {
            const tr = state.tr;
            tr.setSelection(TextSelection.create(tr.doc, to + 1));
            view.dispatch(tr);
            return true;
          }
          // 非自配对闭符号（) ] } 等）且右侧不是同类字符 → 交给默认输入
          if (!close) return false;
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

    // v0.8.0 修复5：Backspace 空配对成对删除
    // 光标前为开符号、光标后为对应闭符号（即空配对 "()"、"“”" 等）→ 一次删掉一对。
    // 有内容时（"（x）"）不拦截：默认 Backspace 仅删光标前单字符，不吞闭符号。
    // Delete 键删右侧单字符、之后 Backspace 删左侧单字符为浏览器/PM 默认行为，无需实现。
    handleKeyDown(view, event) {
      if (!useSettingsStore.getState().autoPairEnabled) return false;
      if (event.key !== "Backspace") return false;
      if (inDisabledNode(view)) return false;

      const { state } = view;
      const { from, to } = state.selection;
      // 仅处理光标无选区（collapsed）场景
      if (from !== to) return false;

      const before = state.doc.textBetween(from - 1, from);
      const after = state.doc.textBetween(to, to + 1);
      const close = PAIR_MAP[before];
      if (close && after === close) {
        const tr = state.tr.delete(from - 1, to + 1);
        view.dispatch(tr);
        return true;
      }
      return false;
    },
  },
  });
}
