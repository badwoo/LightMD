/**
 * v0.8.0 修复 P1-3：行内代码 / 行内公式的光标上下文判定
 *
 * 背景：源码模式（textarea）的自动配对与 Backspace 成对删除，原本只用
 * isInCodeBlock（只统计 ``` 围栏）判定上下文——光标位于行内 `code` 或
 * 行内公式 $...$ 内时仍会触发配对/成对删除，破坏代码与公式。
 * PM 侧由 inDisabledNode（code_inline/math_inline 节点判定）覆盖，两侧不对称。
 *
 * 本函数补齐 textarea 侧的行内判定。
 *
 * 启发式（与 isInCodeBlock 的围栏计数同一类）：
 * 统计**当前行**光标之前未被 \ 转义的 ` 与 $ 的数量，奇数 = 处于未闭合区间内。
 * 局限：不覆盖跨行的行内代码/公式（行内语法跨行极罕见，且 markdown-it
 * 的行内解析同样以行为界）。
 */

/** 统计 line 中未被 \ 转义的指定字符数量 */
function countUnescaped(line: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === ch && line[i - 1] !== "\\") n++;
  }
  return n;
}

/**
 * 光标是否位于行内代码（`...`）或行内公式（$...$）内。
 * @param text 全文
 * @param cursorPos 光标字符偏移
 */
export function isInInlineCodeOrMath(text: string, cursorPos: number): boolean {
  const before = text.slice(0, Math.max(0, cursorPos));
  const lineStart = before.lastIndexOf("\n") + 1;
  const lineBefore = before.slice(lineStart);
  return countUnescaped(lineBefore, "`") % 2 === 1 || countUnescaped(lineBefore, "$") % 2 === 1;
}
