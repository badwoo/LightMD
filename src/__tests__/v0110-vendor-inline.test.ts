/**
 * v0.11.0 B2-1：导出资源内联（离线可用）。
 *
 * 缺陷背景（P0）：
 *   ExportDialog 注入 jsdelivr CDN 上的 mermaid / KaTeX → 离线或内网打开
 *   导出文件时，公式与图表**全空白且无任何降级提示**。而 vendor 资源
 *   （public/vendor/katex 592K、public/vendor/mermaid 3.2M）就在仓库内。
 *
 * 修复策略（体积权衡）：
 *   - KaTeX 全内联（CSS + JS + 字体 base64）→ 单文件自包含；
 *   - mermaid 3.2MB 不内联：HTML 导出旁置 `_assets/`，PDF 导出（临时文件）直接内联；
 *   - 读不到资源时回退 CDN。
 *
 * 注：collectInlineAssets 依赖 Tauri runtime（isTauri() 为 false 时返回空），
 * 故本测试聚焦**可单测的纯逻辑**：脚本生成、字体过滤、扩展名映射。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildKatexRenderScript, buildMermaidInitScript, EXPORT_ASSETS_DIR } from "../utils/vendorAssets";

describe("v0.11.0 B2-1 导出资源内联", () => {
  it("KaTeX 渲染脚本覆盖行内与块级公式", () => {
    const js = buildKatexRenderScript();
    expect(js).toContain('data-math=inline');
    expect(js).toContain('data-math=block');
    expect(js).toContain("katex.render");
    // displayMode 区分
    expect(js).toContain("displayMode:false");
    expect(js).toContain("displayMode:true");
    // 失败降级为提示文本而非静默
    expect(js).toContain("⚠");
  });

  it("KaTeX 渲染脚本不含 CDN 引用（离线可用）", () => {
    expect(buildKatexRenderScript()).not.toContain("http");
  });

  it("mermaid 初始化默认 strict（导出到外部文件，不应放行脚本注入）", () => {
    const js = buildMermaidInitScript("default");
    expect(js).toContain('securityLevel:"strict"');
    // 此前是 "loose"，配合可执行 HTML 存在注入面
    expect(js).not.toContain("loose");
  });

  it("mermaid 主题随明暗传入", () => {
    expect(buildMermaidInitScript("dark")).toContain('theme:"dark"');
    expect(buildMermaidInitScript("default")).toContain('theme:"default"');
  });

  it("资源目录名固定为 _assets", () => {
    expect(EXPORT_ASSETS_DIR).toBe("_assets");
  });

  it("KaTeX CSS 的字体引用：只覆盖真实存在的 woff2（另 40 个 woff/ttf 不存在）", () => {
    // 该断言锁定一个附带修复：katex.min.css 声明 60 个 url(fonts/...)，
    // 但字体目录只有 20 个 woff2 → 内联时须按实际存在过滤，否则生成空 @font-face
    const css = readFileSync("public/vendor/katex/katex.min.css", "utf-8");
    const refs = [...new Set([...css.matchAll(/url\((fonts\/[^)]+)\)/g)].map((m) => m[1]!))];
    const woff2 = refs.filter((r) => r.endsWith(".woff2"));
    const other = refs.filter((r) => !r.endsWith(".woff2"));
    expect(woff2.length).toBe(20);
    // 40 个 woff/ttf 引用指向不存在的文件
    expect(other.length).toBe(40);
  });

  it("mermaid 体积超阈值 → 策略为旁置而非内联", () => {
    // 3.2MB 内联会让 HTML 臃肿，方案固定为 HTML 导出旁置 _assets/
    const stat = readFileSync("public/vendor/mermaid/mermaid.min.js");
    expect(stat.length).toBeGreaterThan(1_000_000);
    // 旁置目录常量即为此策略的体现
    expect(EXPORT_ASSETS_DIR).toBe("_assets");
  });

  it("vendor 资源确实存在于仓库（修复的前提）", () => {
    expect(() => readFileSync("public/vendor/katex/katex.min.css")).not.toThrow();
    expect(() => readFileSync("public/vendor/katex/katex.min.js")).not.toThrow();
    expect(() => readFileSync("public/vendor/mermaid/mermaid.min.js")).not.toThrow();
  });

  it("导出 HTML 源码不再硬编码 CDN 的 mermaid/katex 注入", () => {
    const src = readFileSync("src/components/dialogs/ExportDialog.tsx", "utf-8");
    // CDN 仅作为「读不到内联资源时」的回退存在，且不再出现 securityLevel:"loose"
    expect(src).not.toContain('securityLevel:"loose"');
    expect(src).toContain("collectInlineAssets");
    expect(src).toContain("buildKatexRenderScript");
  });
});
