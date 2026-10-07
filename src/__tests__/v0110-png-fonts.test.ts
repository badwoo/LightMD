/**
 * v0.11.0 B2-3：PNG 导出公式字体不再丢失。
 *
 * 缺陷背景（P0）：
 *   `exportImage.exportElementAsPng` 设 `skipFonts: true`，注释理由是「字体嵌入
 *   需 fetch @font-face，失败会导致 SVG foreignObject 渲染空白」。但公式依赖
 *   KaTeX Web 字体（index.html 引入 /vendor/katex）→ **截图内公式回退/错形**。
 *   同时 `exportDocx.ts` 未设 skipFonts → 两条导出路径字体行为不一致。
 *
 * 修复：保持 skipFonts（避免 html-to-image 自动 fetch 失败导致整图空白），
 * 改为显式传入 `fontEmbedCSS`（复用 B2-1 的 vendorAssets 字体内联能力，
 * 字体已 base64 内联，无跨域问题）；读不到字体时给出明确提示而非静默错形。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync("src/utils/exportImage.ts", "utf-8");

describe("v0.11.0 B2-3 PNG 导出公式字体", () => {
  it("显式传入 fontEmbedCSS（不再单纯跳过字体）", () => {
    expect(src).toContain("fontEmbedCSS");
    expect(src).toContain("renderKatexCss");
  });

  it("复用 B2-1 的 vendorAssets 字体内联能力", () => {
    // 动态 import（避免首屏加载 vendor 资源）
    expect(src).toContain('import("./vendorAssets")');
  });

  it("仍保持 skipFonts: true（避免自动 fetch 失败导致整图空白）", () => {
    // skipFonts 的原意（避免跨域字体 fetch 失败 → foreignObject 整块渲染失败）仍成立，
    // 改为用 fontEmbedCSS 显式提供字体，两者并存而非二选一。
    expect(src).toMatch(/skipFonts:\s*true/);
  });

  it("字体未就绪时给出明确提示（而非静默输出错形）", () => {
    expect(src).toContain("notifyWarning");
    expect(src).toContain("公式可能显示异常");
  });

  it("fontEmbedCSS 为空时不传该键（避免传 undefined 引发库内异常）", () => {
    expect(src).toContain("...(fontEmbedCSS ? { fontEmbedCSS } : {})");
  });
});
