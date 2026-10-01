/**
 * code-indent —— E2(v0.9.2):代码块 Tab 缩进/反缩进
 *
 * 此前 code_block 内按 Tab 落到浏览器默认行为,焦点直接移出编辑器,
 * 是代码编辑的第一体验断点。mermaid_block 与 code_block 同为
 * code:true、content:"text*" 的文本块,一并纳入(否则图表源码编辑时
 * Tab 仍会跳走,行为不一致)。
 *
 * - codeBlockIndent:插入 2 空格缩进单位
 * - codeBlockOutdent:删除光标前最近一个 2 空格缩进单位;
 *   行中(光标前恰为单空格)退化为删 1 个空格,无空格时返回 false
 */
import { Command, EditorState } from "prosemirror-state";

/** 光标是否直接位于代码类文本块内(块内容为纯文本,无中间节点层) */
function inCodeLikeBlock(state: EditorState): boolean {
  const parent = state.selection.$from.parent;
  return parent.type.name === "code_block" || parent.type.name === "mermaid_block";
}

export const codeBlockIndent: Command = (state, dispatch) => {
  if (!inCodeLikeBlock(state)) return false;
  if (dispatch) {
    dispatch(state.tr.insertText("  ", state.selection.$from.pos));
  }
  return true;
};

export const codeBlockOutdent: Command = (state, dispatch) => {
  if (!inCodeLikeBlock(state)) return false;
  const { $from } = state.selection;
  const text = $from.parent.textContent;
  const off = $from.parentOffset;
  // 当前行行首(code_block 内的换行就是 \n 文本)
  const lineStart = text.lastIndexOf("\n", Math.max(0, off - 1)) + 1;
  const before = text.slice(lineStart, off);
  const twoSpaces = / {2}$/.test(before);
  const oneSpace = text[off - 1] === " ";
  if (!twoSpaces && !oneSpace) return false;
  if (dispatch) {
    if (twoSpaces) {
      dispatch(state.tr.delete($from.pos - 2, $from.pos));
    } else {
      dispatch(state.tr.delete($from.pos - 1, $from.pos));
    }
  }
  return true;
};
