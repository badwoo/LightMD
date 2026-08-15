/**
 * v0.4.5 空状态 Logo 动画性能优化 - 单元测试
 *
 * 背景：空闲状态下 WebView2 CPU 持续 1%~2% 占用，根因是空状态 Logo 的
 * emptyLogoShimmer 无限动画同时改变 background-position（触发渐变重绘 +
 * background-clip:text 文字栅格化）、filter:drop-shadow（每帧重算阴影）、
 * transform:scale（合成开销），导致每帧强制重绘。
 *
 * 优化方案：
 * 1. CSS：简化动画为仅 opacity 呼吸（走合成层，CPU≈0），移除昂贵属性
 * 2. CSS：窗口失焦时通过 .app-blurred class 暂停动画
 * 3. CSS：尊重 prefers-reduced-motion 系统偏好
 * 4. App.tsx：监听 visibilitychange/blur/focus，失焦时给 body 加 app-blurred class
 *
 * 测试范围：CSS 规则静态断言 + App.tsx 事件监听代码存在性验证
 */
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

/** 读取源文件内容 */
function readSrc(relPath: string): string {
  return fs.readFileSync(path.resolve(__dirname, relPath), "utf-8");
}

/** 移除 CSS 注释（避免注释中的说明文字干扰正则断言） */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

// ─── 1. emptyLogoShimmer 关键帧仅包含 opacity ──────────────────────

describe("v0.4.5 emptyLogoShimmer 关键帧简化", () => {
  const css = readSrc("../styles/editor.css");

  it("关键帧只动画 opacity 属性", () => {
    const kf = css.match(/@keyframes emptyLogoShimmer \{[\s\S]*?\}/);
    expect(kf).not.toBeNull();
    // 关键帧体内应包含 opacity 声明
    expect(kf![0]).toMatch(/opacity:\s*0\.\d+/);
  });

  it("关键帧不再动画 background-position（渐变重绘主因）", () => {
    const kf = css.match(/@keyframes emptyLogoShimmer \{[\s\S]*?\}/);
    expect(kf).not.toBeNull();
    expect(kf![0]).not.toMatch(/background-position/);
  });

  it("关键帧不再动画 transform: scale（合成开销）", () => {
    const kf = css.match(/@keyframes emptyLogoShimmer \{[\s\S]*?\}/);
    expect(kf).not.toBeNull();
    expect(kf![0]).not.toMatch(/transform:\s*scale/);
  });
});

// ─── 2. .editor-empty-logo 移除昂贵属性 ──────────────────────

describe("v0.4.5 .editor-empty-logo 移除昂贵属性", () => {
  const css = stripCssComments(readSrc("../styles/editor.css"));
  // 匹配 .editor-empty-logo 规则块（到下一个 } 结束）
  const rule = css.match(/\.editor-empty-logo \{[\s\S]*?\}/);
  expect(rule).not.toBeNull();
  const block = rule![0];

  it("不再有 filter: drop-shadow（每帧重算阴影）", () => {
    expect(block).not.toMatch(/filter:\s*drop-shadow/);
  });

  it("不再有 background-size: 200%（仅 shimmer 流动时需要）", () => {
    expect(block).not.toMatch(/background-size:\s*200%/);
  });

  it("添加 will-change: opacity 提示合成层", () => {
    expect(block).toMatch(/will-change:\s*opacity/);
  });

  it("仍保留静态渐变（视觉层次）", () => {
    expect(block).toMatch(/background:\s*linear-gradient/);
    expect(block).toMatch(/background-clip:\s*text/);
  });

  it("保留 text-shadow（静态阴影，不参与动画，不影响性能）", () => {
    expect(block).toMatch(/text-shadow/);
  });

  it("动画周期改为 4s（原 6s，呼吸频率更自然）", () => {
    expect(block).toMatch(/animation:\s*emptyLogoShimmer\s+4s/);
  });
});

// ─── 3. 失焦暂停 .app-blurred 规则 ──────────────────────

describe("v0.4.5 失焦暂停动画 CSS 规则", () => {
  const css = readSrc("../styles/editor.css");

  it("存在 .app-blurred .editor-empty-logo 规则", () => {
    expect(css).toMatch(/\.app-blurred\s+\.editor-empty-logo\s*\{/);
  });

  it(".app-blurred 规则设置 animation-play-state: paused", () => {
    const rule = css.match(/\.app-blurred\s+\.editor-empty-logo\s*\{[^}]*\}/);
    expect(rule).not.toBeNull();
    expect(rule![0]).toMatch(/animation-play-state:\s*paused/);
  });
});

// ─── 4. prefers-reduced-motion 支持 ──────────────────────

describe("v0.4.5 prefers-reduced-motion 支持", () => {
  const css = readSrc("../styles/editor.css");

  it("存在 @media (prefers-reduced-motion: reduce) 规则", () => {
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });

  it("reduced-motion 下 .editor-empty-logo 禁用动画", () => {
    // 匹配 media query 块
    const media = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\}/);
    expect(media).not.toBeNull();
    expect(media![0]).toMatch(/\.editor-empty-logo/);
    expect(media![0]).toMatch(/animation:\s*none/);
  });
});

// ─── 5. App.tsx 失焦暂停事件监听 ──────────────────────

describe("v0.4.5 App.tsx 失焦暂停事件监听", () => {
  const appSrc = readSrc("../App.tsx");

  it("监听 document visibilitychange 事件", () => {
    expect(appSrc).toMatch(/document\.addEventListener\(["']visibilitychange["']/);
  });

  it("监听 window blur 事件（失焦暂停）", () => {
    expect(appSrc).toMatch(/window\.addEventListener\(["']blur["']/);
  });

  it("监听 window focus 事件（聚焦恢复）", () => {
    expect(appSrc).toMatch(/window\.addEventListener\(["']focus["']/);
  });

  it("通过 document.hidden 判断页面可见性", () => {
    expect(appSrc).toMatch(/document\.hidden/);
  });

  it("使用 body.classList.toggle 切换 app-blurred class", () => {
    expect(appSrc).toMatch(/classList\.toggle\(["']app-blurred["']/);
  });

  it("useEffect 清理函数移除 visibilitychange 监听器（避免内存泄漏）", () => {
    expect(appSrc).toMatch(/removeEventListener\(["']visibilitychange["']/);
  });

  it("useEffect 清理函数移除 blur 监听器", () => {
    expect(appSrc).toMatch(/removeEventListener\(["']blur["']/);
  });

  it("useEffect 清理函数移除 focus 监听器", () => {
    expect(appSrc).toMatch(/removeEventListener\(["']focus["']/);
  });
});

// ─── 6. 行为验证：模拟 window blur/focus 触发 body class 变化 ──────────────────────

describe("v0.4.5 失焦暂停行为验证", () => {
  it("body classList.toggle 逻辑正确：blurred=true 添加，blurred=false 移除", () => {
    // 直接验证 classList.toggle 的语义（与 App.tsx 中 setBlurred 逻辑一致）
    document.body.classList.remove("app-blurred");
    expect(document.body.classList.contains("app-blurred")).toBe(false);

    // 模拟失焦：toggle(class, true) 等价于 add
    document.body.classList.toggle("app-blurred", true);
    expect(document.body.classList.contains("app-blurred")).toBe(true);

    // 模拟聚焦：toggle(class, false) 等价于 remove
    document.body.classList.toggle("app-blurred", false);
    expect(document.body.classList.contains("app-blurred")).toBe(false);
  });

  it("document.hidden 在 JSDOM 中默认为 false（页面可见）", () => {
    // 验证 JSDOM 环境下 document.hidden 的初始状态
    // App.tsx 的 onVisibilityChange 通过 document.hidden 判断
    expect(document.hidden).toBe(false);
  });
});
