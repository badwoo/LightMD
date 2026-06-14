/**
 * markdown-it KaTeX 插件
 * 识别 $...$ 行内公式和 $$...$$ 块级公式
 */
import type MarkdownIt from "markdown-it";

// 行内公式规则：$...$
function mathInline(state: any, silent: boolean): boolean {
  const start = state.pos;
  const max = state.posMax;

  // 检查起始 $
  if (state.src.charCodeAt(start) !== 0x24 /* $ */) return false;
  // 不允许连续 $$（那是块级公式）
  if (start + 1 < max && state.src.charCodeAt(start + 1) === 0x24) return false;

  // 查找结束 $
  let pos = start + 1;
  let found = false;
  while (pos < max) {
    const code = state.src.charCodeAt(pos);
    if (code === 0x24 /* $ */) {
      // 不允许结束也是 $$
      if (pos + 1 < max && state.src.charCodeAt(pos + 1) === 0x24) {
        pos += 2;
        continue;
      }
      found = true;
      break;
    }
    if (code === 0x5C /* \ */) pos++; // 跳过转义字符
    pos++;
  }

  if (!found) return false;
  if (pos === start + 1) return false; // 空公式 $$

  const content = state.src.slice(start + 1, pos);

  if (!silent) {
    const token = state.push("math_inline", "span", 0);
    token.content = content;
    token.markup = "$";
  }

  state.pos = pos + 1;
  return true;
}

// 块级公式规则：$$...$$
function mathBlock(state: any, startLine: number, endLine: number, silent: boolean): boolean {
  let pos = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];

  // 检查起始 $$
  if (pos + 1 > max) return false;
  if (state.src.charCodeAt(pos) !== 0x24 || state.src.charCodeAt(pos + 1) !== 0x24) return false;

  // 检查同一行是否有结束 $$
  let nextLine = startLine;
  let content = "";
  let foundEnd = false;

  // 先检查同行结束
  const inlineContent = state.src.slice(pos + 2, max);
  const sameLineEnd = inlineContent.indexOf("$$");
  if (sameLineEnd !== -1) {
    content = inlineContent.slice(0, sameLineEnd).trim();
    foundEnd = true;
    nextLine = startLine;
  }

  if (!foundEnd) {
    // 多行模式
    content = inlineContent.trim();
    for (nextLine = startLine + 1; nextLine <= endLine; nextLine++) {
      const linePos = state.bMarks[nextLine] + state.tShift[nextLine];
      const lineMax = state.eMarks[nextLine];
      const lineText = state.src.slice(linePos, lineMax);

      if (lineText.trim() === "$$") {
        foundEnd = true;
        break;
      }
      if (lineText.endsWith("$$")) {
        content += "\n" + lineText.slice(0, -2).trim();
        foundEnd = true;
        break;
      }
      content += "\n" + lineText;
    }
  }

  if (!foundEnd) return false;

  if (silent) return true;

  const token = state.push("math_block", "div", 0);
  token.content = content;
  token.markup = "$$";
  token.block = true;
  token.map = [startLine, nextLine + 1];

  state.line = nextLine + 1;
  return true;
}

export function mathPlugin(md: MarkdownIt): void {
  // 块级公式规则（在 blockquote 之前处理）
  md.block.ruler.after("blockquote", "math_block", mathBlock);
  // 行内公式规则
  md.inline.ruler.after("escape", "math_inline", mathInline);

  // 渲染规则：输出带 data-math 和 data-latex 属性的 HTML，供分屏预览 iframe 中的 KaTeX 脚本渲染
  md.renderer.rules.math_inline = (tokens, idx) => {
    const latex = tokens[idx].content;
    // HTML 转义，防止 XSS
    const escaped = latex.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<span data-math="inline" data-latex="${escaped}"></span>`;
  };

  md.renderer.rules.math_block = (tokens, idx) => {
    const latex = tokens[idx].content;
    const escaped = latex.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<div data-math="block" data-latex="${escaped}"></div>`;
  };
}
