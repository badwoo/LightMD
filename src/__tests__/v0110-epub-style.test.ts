/**
 * v0.11.0 B2-6：EPUB 样式与 mermaid 渲染修正。
 *
 * 缺陷背景（P1）：
 * ① STYLE_CSS 缺 `.token.*`（代码高亮 span 已生成但无颜色规则）、脚注、
 *    任务列表、TOC、mark/sub/sup、math 样式 → EPUB 里对应内容无样式或不可见；
 * ② `replaceMermaidBlocksInDom` 只配了 `flowchart.htmlLabels: false`，
 *    sequence/class/state 等图种仍默认走 `<foreignObject>`，
 *    而 foreignObject 在 XHTML 中**不合法** → epubcheck 报错、严格阅读器拒开；
 * ③ mermaid securityLevel 为 "loose"，导出产物可传播，存在脚本执行面。
 *
 * 本测试聚焦可静态断言的部分：样式表内容、mermaid 配置、源码级约束。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const epubSrc = readFileSync("src/utils/exportEpub.ts", "utf-8");
const mathSrc = readFileSync("src/utils/exportMathRender.ts", "utf-8");

/** 从 exportEpub.ts 提取 STYLE_CSS 模板字符串内容 */
function extractStyleCss(): string {
  const m = epubSrc.match(/const STYLE_CSS = `([\s\S]*?)`;/);
  expect(m).not.toBeNull();
  return m![1];
}

describe("v0.11.0 B2-6 EPUB 样式与 mermaid", () => {
  it("代码高亮：.token 各类别有颜色规则（此前无 → 无语法色）", () => {
    const css = extractStyleCss();
    expect(css).toContain(".token.comment");
    expect(css).toContain(".token.keyword");
    expect(css).toContain(".token.string");
    expect(css).toContain(".token.number");
    expect(css).toContain(".token.function");
  });

  it("脚注有样式规则", () => {
    const css = extractStyleCss();
    expect(css).toContain(".footnotes");
    expect(css).toContain(".footnotes-list");
    expect(css).toContain(".footnote-ref");
  });

  it("任务列表有样式规则（checkbox 布局）", () => {
    const css = extractStyleCss();
    expect(css).toContain(".task-list");
    expect(css).toContain(".task-item");
    expect(css).toContain("checkbox");
  });

  it("自动目录有层级缩进样式", () => {
    const css = extractStyleCss();
    expect(css).toContain("nav.toc");
  });

  it("高亮与上下标有视觉区分", () => {
    const css = extractStyleCss();
    expect(css).toContain("mark {");
    expect(css).toContain("sub, sup");
  });

  it("公式有居中与溢出处理", () => {
    const css = extractStyleCss();
    expect(css).toContain(".katex-display");
    expect(css).toContain("overflow-x: auto");
  });

  it("mermaid 改用顶层 htmlLabels（mermaid 11 已废弃图种内设置）", () => {
    // 图种内的 flowchart.htmlLabels 只对流程图生效，sequence/class 等仍走
    // foreignObject → 非法 XHTML。顶层设置对所有图种生效。
    expect(mathSrc).toMatch(/^\s*htmlLabels: false,/m);
    expect(mathSrc).not.toContain("flowchart: { htmlLabels: false }");
  });

  it("mermaid securityLevel 收紧为 antiscript（导出产物可传播）", () => {
    expect(mathSrc).toContain('securityLevel: "antiscript"');
    expect(mathSrc).not.toContain('securityLevel: "loose"');
  });

  it("既有基础样式不回归（代码/引用/表格/图片）", () => {
    const css = extractStyleCss();
    expect(css).toContain("pre {");
    expect(css).toContain("code {");
    expect(css).toContain("blockquote {");
    expect(css).toContain("table {");
    expect(css).toContain("img {");
  });

  it("章节切分逻辑保留（按 H1/H2 切章）", () => {
    expect(epubSrc).toContain("splitChapters");
    expect(epubSrc).toContain('"H1"');
    expect(epubSrc).toContain('"H2"');
  });
});
