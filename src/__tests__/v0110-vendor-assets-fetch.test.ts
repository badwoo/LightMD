/**
 * v0.11.0 B2-1 **返修**回归测试：导出资源必须能从 webview 源读到。
 *
 * 为什么必须有这个文件：
 *   首版实现的 `collectInlineAssets` 从 Tauri `resourceDir()` 用 plugin-fs 读
 *   `vendor/...`，但 public/vendor 经 Vite 打进 dist 并由 **webview 源**提供，
 *   `tauri.conf.json` 又没有 `bundle.resources` → 该路径恒返回 null →
 *   内联恒失败、恒静默回退 CDN（打包产物实测：导出 HTML 仅 4.7KB、3 条 jsdelivr、
 *   0 个 data:font、无 `_assets/`）。而 `v0110-vendor-inline.test.ts:14-15` 明确把
 *   `collectInlineAssets` **排除在测试之外**（理由是"依赖 Tauri runtime"），
 *   于是这条 P0 带着全绿测试出了门。
 *
 *   返修改为走 `fetch`（开发态 Vite、打包态内嵌 dist 都能取到），并去掉
 *   `isTauri()` 前置短路 → 本文件用 mock fetch 直接覆盖真实读取与字体内联逻辑。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  assetUrl,
  collectInlineAssets,
  renderKatexCss,
  renderKatexJs,
  renderMermaidJs,
  buildMermaidInitScript,
  EXPORT_ASSETS_DIR,
} from "../utils/vendorAssets";

const CSS = [
  ".katex{color:#000}",
  '@font-face{font-family:KaTeX_Main;src:url(fonts/KaTeX_Main-Regular.woff2) format("woff2"),url(fonts/KaTeX_Main-Regular.woff) format("woff"),url(fonts/KaTeX_Main-Regular.ttf) format("truetype");}',
  '@font-face{font-family:KaTeX_Math;src:url(fonts/KaTeX_Math-Italic.woff2) format("woff2"),url(fonts/KaTeX_Math-Italic.woff) format("woff");}',
].join("\n");
const KATEX_JS = "window.katex={render:function(){}};";
const MERMAID_JS = "window.mermaid={initialize:function(){},run:function(){}};";

/** 只有 woff2 真实存在（与仓库 dist/vendor/katex/fonts 的 20 个 woff2 一致） */
const AVAILABLE: Record<string, string> = {
  "vendor/katex/katex.min.css": CSS,
  "vendor/katex/katex.min.js": KATEX_JS,
  "vendor/mermaid/mermaid.min.js": MERMAID_JS,
  "vendor/katex/fonts/KaTeX_Main-Regular.woff2": "MAIN-WOFF2-BYTES",
  "vendor/katex/fonts/KaTeX_Math-Italic.woff2": "MATH-WOFF2-BYTES",
};

function stubFetch(map: Record<string, string>) {
  const enc = new TextEncoder();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const u = String(url);
      const key = Object.keys(map).find((k) => u.endsWith(k));
      if (!key) {
        return {
          ok: false,
          status: 404,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
      const body = map[key]!;
      const bytes = enc.encode(body);
      return {
        ok: true,
        status: 200,
        text: async () => body,
        arrayBuffer: async () => bytes.buffer.slice(0),
      };
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("v0.11.0 B2-1 返修：导出资源经 webview 源读取", () => {
  beforeEach(() => {
    stubFetch(AVAILABLE);
  });

  it("assetUrl 相对 webview 根解析（开发态与打包态同一路径）", () => {
    expect(assetUrl({ src: "vendor/katex/katex.min.css", dest: "" }, "http://tauri.localhost/")).toBe(
      "http://tauri.localhost/vendor/katex/katex.min.css",
    );
    expect(assetUrl({ src: "vendor/katex/katex.min.css", dest: "" }, "http://localhost:1420/")).toBe(
      "http://localhost:1420/vendor/katex/katex.min.css",
    );
  });

  it("collectInlineAssets 真的能读到三类资源（首版此路径恒 null）", async () => {
    const a = await collectInlineAssets(true);
    expect(a.ok).toBe(true);
    expect(a.missing).toEqual([]);
    expect(a.katexCss).toContain(".katex");
    expect(a.katexJs).toContain("window.katex");
    expect(a.mermaidJs).toContain("window.mermaid");
  });

  it("KaTeX 字体转 base64 data URL（离线自包含的关键）", async () => {
    const css = await renderKatexCss();
    expect(css).toBeTruthy();
    expect(css!).toContain("url(data:font/woff2;base64,");
    // 两条 woff2 都被内联
    expect((css!.match(/data:font\/woff2;base64,/g) || []).length).toBe(2);
  });

  it("不存在的 woff/ttf 连同 format() 一起被移除（不留死引用）", async () => {
    const css = await renderKatexCss();
    expect(css).toBeTruthy();
    expect(css!).not.toContain("KaTeX_Main-Regular.woff)");
    expect(css!).not.toContain("KaTeX_Main-Regular.ttf)");
    expect(css!).not.toContain("KaTeX_Math-Italic.woff)");
    // 清理后不应留下空 src 或重复逗号之类的残渣
    expect(css!).not.toMatch(/src:\s*;/);
    expect(css!).not.toMatch(/,\s*;/);
  });

  it("读不到资源时 ok=false 且 missing 精确列出（供导出侧提示用户）", async () => {
    stubFetch({});
    const a = await collectInlineAssets(true);
    expect(a.ok).toBe(false);
    expect(a.missing).toEqual(["katexCss", "katexJs", "mermaidJs"]);
    expect(await renderKatexJs()).toBeNull();
    expect(await renderMermaidJs()).toBeNull();
  });

  it("字体缺失但 CSS/JS 可读时仍算 ok（避免整份资源被判定失败）", async () => {
    stubFetch({
      "vendor/katex/katex.min.css": CSS,
      "vendor/katex/katex.min.js": KATEX_JS,
      "vendor/mermaid/mermaid.min.js": MERMAID_JS,
    });
    const css = await renderKatexCss();
    // 字体全取不到 → 保留 CSS，但不残留任何字体 url 引用
    expect(css).toContain(".katex");
    expect(css).not.toContain("url(fonts/");
    const a = await collectInlineAssets(true);
    expect(a.ok).toBe(true);
  });

  it("mermaid 初始化脚本默认收紧为 strict", () => {
    expect(buildMermaidInitScript("dark")).toContain('securityLevel:"strict"');
    expect(buildMermaidInitScript("dark")).not.toContain("loose");
  });

  it("旁置资源目录名与引用一致（_assets）", () => {
    expect(EXPORT_ASSETS_DIR).toBe("_assets");
  });
});
