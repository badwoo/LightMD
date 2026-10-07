/**
 * v0.11.0 B2-2：PDF 页眉/页脚真实生效，页码选项诚实降级。
 *
 * 缺陷背景（P1）：
 *   `generatePrintCss` 此前在 `@page` 内生成 `@top-center` / `@bottom-center`
 *   （页眉/页脚）与 `counter(page)`（页码），但导出走 Chromium `--print-to-pdf`
 *   （src-tauri/commands/export.rs）——**Chromium 不支持 CSS 分页上下文
 *   （margin box）**，这些规则被静默忽略 → PdfExportDialog 的 4 个排版选项中
 *   3 个实际无效（用户设了页码，导出里没有）。
 *
 * 修复口径（用户拍板：降级为「仅页脚、不含页码」）：
 *   ① 页眉/页脚改用 `position: fixed` 常规元素 —— Chromium 打印时每页重复；
 *   ② 页码停用（buildPageNumberRule 恒空、UI 选项移除）；
 *   ③ includeCSS=false 时不再无条件注入 printCss。
 */
import { describe, it, expect } from "vitest";
import {
  generatePrintCss,
  generateFullPrintStylesheet,
  generateFixedMarginBoxCss,
  generateFixedMarginBoxHtml,
  DEFAULT_PDF_EXPORT_OPTIONS,
  type PdfExportOptions,
} from "../utils/pdfExport";

const DATE = "2026-10-07";

function opts(over: Partial<PdfExportOptions> = {}): PdfExportOptions {
  return { ...DEFAULT_PDF_EXPORT_OPTIONS, ...over };
}

describe("v0.11.0 B2-2 PDF 页眉页脚与页码降级", () => {
  it("@page 内不再生成 margin box（Chromium 会静默忽略）", () => {
    const css = generatePrintCss(opts({ headerText: "{title}", footerText: "{date}" }), "doc", DATE);
    expect(css).not.toContain("@top-center");
    expect(css).not.toContain("@bottom-center");
    expect(css).not.toContain("counter(page)");
    // size / margin 仍需保留
    expect(css).toContain("size:");
    expect(css).toContain("margin:");
  });

  it("页码规则恒为空（三种格式都不再生成 counter）", () => {
    for (const fmt of ["none", "bottom-center", "bottom-right"] as const) {
      const css = generatePrintCss(opts({ pageNumberFormat: fmt }), "doc", DATE);
      expect(css).not.toContain("counter(page)");
    }
  });

  it("页眉页脚改用 fixed 元素样式（每页重复）", () => {
    const css = generateFixedMarginBoxCss(opts({ headerText: "{title}" }), "我的文档", DATE);
    expect(css).toContain(".pdf-header");
    expect(css).toContain("position: fixed");
    expect(css).toContain("top:");
  });

  it("页脚同样用 fixed 元素", () => {
    const css = generateFixedMarginBoxCss(opts({ footerText: "{date}" }), "doc", DATE);
    expect(css).toContain(".pdf-footer");
    expect(css).toContain("position: fixed");
    expect(css).toContain("bottom:");
  });

  it("页眉页脚都为空时不生成任何 fixed 样式", () => {
    const css = generateFixedMarginBoxCss(opts({ headerText: "", footerText: "" }), "doc", DATE);
    expect(css).toBe("");
  });

  it("页眉页脚输出真实 DOM 节点（CSS content 对普通元素不生效）", () => {
    const html = generateFixedMarginBoxHtml(opts({ headerText: "{title}", footerText: "{date}" }), "我的文档", DATE);
    expect(html).toContain('<div class="pdf-header">我的文档</div>');
    expect(html).toContain('<div class="pdf-footer">2026-10-07</div>');
  });

  it("{page} 占位符被剔除而非留下永不替换的占位符", () => {
    const html = generateFixedMarginBoxHtml(opts({ headerText: "第 {page} 页" }), "doc", DATE);
    expect(html).not.toContain("{page}");
  });

  it("页眉页脚内容做 HTML 转义（防注入）", () => {
    const html = generateFixedMarginBoxHtml(
      opts({ headerText: '<script>alert(1)</script>' }),
      "doc",
      DATE,
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("完整样式表同时包含 @page 与 fixed 页眉页脚样式", () => {
    const css = generateFullPrintStylesheet(opts({ headerText: "{title}" }), "doc", DATE);
    expect(css).toContain("@page");
    expect(css).toContain(".pdf-header");
    // body 基础样式仍在
    expect(css).toContain("font-family");
  });

  it("页眉页脚用零偏移贴在页面盒边缘（不随边距变化，无负偏移）", () => {
    const narrow = generateFixedMarginBoxCss(opts({ margin: "narrow", headerText: "H" }), "d", DATE);
    const wide = generateFixedMarginBoxCss(opts({ margin: "wide", headerText: "H" }), "d", DATE);
    // [返修] 本用例此前断言 narrow/wide 的偏移量不同、且 narrow 含 "top: -4mm" ——
    // 那正是导致「页眉在末页丢失、页脚在首页丢失、短文档多出一页空白页」的实现。
    // 实测（本机 Edge 154 对照实验）Chromium 打印时 position:fixed 以**页面盒**
    // 为基准，top:0 / bottom:0 已经落在页边距区内、不会压正文且每页齐全；
    // 故两种边距下输出应完全一致，且不得再出现负偏移。
    expect(narrow).toBe(wide);
    expect(narrow).toContain("top: 0;");
    expect(narrow).toContain("bottom: 0;");
    expect(narrow).not.toMatch(/top:\s*-/);
    expect(narrow).not.toMatch(/bottom:\s*-/);
  });
});
