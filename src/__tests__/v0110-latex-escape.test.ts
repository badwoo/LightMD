/**
 * v0.11.0 B5-5：LaTeX 导出四问题修复。
 *
 * 缺陷背景（P1）：
 * ① `\href{url}` 未转义 —— URL 含 & % # _ { } 会破坏 LaTeX 语法
 *    （& 是列分隔符、% 起注释、# 非法参数符）→ **含特殊字符的链接使整篇编译失败**；
 * ② `\includegraphics{src}` 同样未转义；
 * ③ 表格列规格恒 `"l".repeat(n)` —— l 列不换行不限宽 → **表格溢出页面被裁切**；
 * ④ Mermaid 只输出 lstlisting 源码（v0.8.0 起即如此，本次改为显式标注）。
 *
 * 注：图片**内容本身**仍需用户把图片放到 .tex 同目录（v0.8.0 已知限制，
 * 本期未变——改为内联 base64 需改用 lualatex，兼容性风险高）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { escapeLatexPath, blocksToLatex, inlineRunsToLatex } from "../utils/exportLatex";
import { createDefaultMarkdownIt, parseBlockTokensDetailed } from "../utils/exportBlocks";

const src = readFileSync("src/utils/exportLatex.ts", "utf-8");

function parseBlocks(md: string) {
  const inst = createDefaultMarkdownIt();
  const tokens = inst.parse(md, {});
  return parseBlockTokensDetailed(tokens, 0, tokens.length).blocks;
}

describe("v0.11.0 B5-5 LaTeX 转义", () => {
  it("escapeLatexPath 转义 & % # _ { }", () => {
    expect(escapeLatexPath("a&b")).toBe("a\\&b");
    expect(escapeLatexPath("100%")).toBe("100\\%");
    expect(escapeLatexPath("a#b")).toBe("a\\#b");
    expect(escapeLatexPath("a_b")).toBe("a\\_b");
    expect(escapeLatexPath("a{b}c")).toBe("a\\{b\\}c");
  });

  it("Windows 路径分隔符反斜杠**不转义**（路径语义）", () => {
    // 转义反斜杠会把 C:\images\a.png 变成不可用的路径
    expect(escapeLatexPath("C:\\images\\a.png")).toBe("C:\\images\\a.png");
  });

  it("~ 与 ^ 转义为安全命令", () => {
    expect(escapeLatexPath("a~b")).toContain("textasciitilde");
    expect(escapeLatexPath("a^b")).toContain("textasciicircum");
  });

  it("href 参数经转义（此前未转义）", () => {
    const out = inlineRunsToLatex([{ text: "link", href: "http://x.com?a=1&b=2" }]);
    expect(out).toContain("\\href{http://x.com?a=1\\&b=2}");
    // 不应出现裸的未转义 &
    expect(out).not.toMatch(/href\{[^}]*[^\\]&\s*\}/);
  });

  it("includegraphics 路径经转义", () => {
    const out = inlineRunsToLatex([{ text: "图", imageSrc: "images/a_b.png" }]);
    expect(out).toContain("a\\_b.png");
  });

  it("href 中含 % 的 URL 不再破坏编译", () => {
    const out = inlineRunsToLatex([{ text: "x", href: "http://a.com/100%25" }]);
    expect(out).toContain("\\%");
  });
});

describe("v0.11.0 B5-5 LaTeX 表格列宽", () => {
  it("不再使用恒定 l 列", () => {
    expect(src).toContain("function buildColumnSpec");
    expect(src).toContain("p{");
  });

  it("列规格按列数均分页面宽度且为定宽可换行列", () => {
    const blocks = parseBlocks("| A | B |\n| --- | --- |\n| 1 | 2 |");
    const out = blocksToLatex(blocks);
    // 应含 p{<width>cm} 形式的列规格
    expect(out).toMatch(/begin\{tabular\}\{.*p\{[\d.]+cm\}/);
  });

  it("列数越多每列越窄（总宽可控，不溢出）", () => {
    const two = blocksToLatex(parseBlocks("| A | B |\n| --- | --- |\n| 1 | 2 |"));
    const five = blocksToLatex(
      parseBlocks("| A | B | C | D | E |\n| --- | --- | --- | --- | --- |\n| 1 | 2 | 3 | 4 | 5 |"),
    );
    const w2 = Number(/p\{([\d.]+)cm\}/.exec(two)?.[1]);
    const w5 = Number(/p\{([\d.]+)cm\}/.exec(five)?.[1]);
    expect(w2).toBeGreaterThan(w5);
  });

  it("preamble 含 array 宏包（>{\\raggedright\\arraybackslash} 依赖）", () => {
    expect(src).toContain("\\usepackage{array}");
  });

  it("单列与超多列均不产生非法规格", () => {
    const one = blocksToLatex(parseBlocks("| A |\n| --- |\n| 1 |"));
    expect(one).toMatch(/p\{[\d.]+cm\}/);
    const wide = blocksToLatex(
      parseBlocks("| A | B | C | D | E | F | G | H |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |"),
    );
    // 列宽有下限（不会算成 0 或负数）
    const w = Number(/p\{([\d.]+)cm\}/.exec(wide)?.[1]);
    expect(w).toBeGreaterThan(0);
  });
});
