/**
 * v0.15.2 需求1：阅读 ↔ 编辑模式切换的**滑入动画**。
 *
 * 用户原话：「增加阅读模式和编辑模式切换时的一个滑动效果…当阅读模式切换到编辑模式时，
 * 编辑模式的左右屏有一个顺滑的由左往右滑过来的动画，而从编辑模式切换为阅读模式时，
 * 动画效果则为文档从右往左滑回的。」
 *
 * 本文件锁三件事：
 * ① CSS 与 TS 的时长常量**必须相等**（否则动画会被 JS 在播完前摘掉 → 画面跳一下）；
 * ② 两个方向的位移**互为镜像**（to-edit 从左进来 / to-preview 从右进来），
 *    这正是用户两句话描述的观感；
 * ③ 动画只碰 transform、不碰 width/height（护住 v0.15.1 修好的滚动锚点链路），
 *    并且 `prefers-reduced-motion` 时必须退化为「不位移」。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MODE_SLIDE_MS } from "../components/editor/EditorContainer";

const CSS = readFileSync("src/styles/modeSwitchSlide.css", "utf-8");

/** 取出某个 `@keyframes name { ... }` 的完整块（含嵌套花括号） */
function keyframesOf(name: string): string {
  const start = CSS.indexOf(`@keyframes ${name} {`);
  expect(start, `缺少 @keyframes ${name}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = start; i < CSS.length; i++) {
    if (CSS[i] === "{") depth++;
    else if (CSS[i] === "}") {
      depth--;
      if (depth === 0) return CSS.slice(start, i + 1);
    }
  }
  throw new Error("keyframes 未闭合");
}

describe("v0.15.2 需求1 · 模式切换滑入动画", () => {
  it("JS 时长与 CSS 变量严格相等（否则动画被提前摘掉）", () => {
    const m = /--lmd-mode-slide-duration:\s*(\d+)ms/.exec(CSS);
    expect(m, "CSS 缺少 --lmd-mode-slide-duration").toBeTruthy();
    expect(Number(m![1])).toBe(MODE_SLIDE_MS);
  });

  it("阅读→编辑：编辑区（左栏 + 右屏）从**左**滑入", () => {
    const rule = /\.editor-main-area\[data-lmd-mode-anim="to-edit"\]\s*>([\s\S]*?)\{([\s\S]*?)\}/.exec(
      CSS,
    );
    expect(rule, "缺少 to-edit 的进场规则").toBeTruthy();
    const selectors = rule![1];
    // 左栏与右屏都要动，否则会出现"一栏先到、一栏后到"
    expect(selectors).toContain(".source-editor-wrapper");
    expect(selectors).toContain(".split-preview-shell");
    expect(rule![2]).toMatch(/animation:\s*lmd-mode-slide-in-from-left/);

    const kf = keyframesOf("lmd-mode-slide-in-from-left");
    // 起点在左侧屏外（-100%），终点归位
    expect(kf).toMatch(/from\s*\{[^}]*translateX\(-100%\)/);
    expect(kf).toMatch(/to\s*\{[^}]*translateX\(0\)/);
  });

  it("编辑→阅读：文档从**右**滑回（与去程互为镜像）", () => {
    const rule =
      /\.editor-main-area\[data-lmd-mode-anim="to-preview"\]\s*>([\s\S]*?)\{([\s\S]*?)\}/.exec(
        CSS,
      );
    expect(rule, "缺少 to-preview 的进场规则").toBeTruthy();
    expect(rule![1]).toContain(".editor-container");
    expect(rule![2]).toMatch(/animation:\s*lmd-mode-slide-in-from-right/);

    const kf = keyframesOf("lmd-mode-slide-in-from-right");
    expect(kf).toMatch(/from\s*\{[^}]*translateX\(100%\)/);
    expect(kf).toMatch(/to\s*\{[^}]*translateX\(0\)/);
  });

  it("★ 两个方向必须互为镜像（同向位移会让回程看着像又进来一次）", () => {
    const left = keyframesOf("lmd-mode-slide-in-from-left");
    const right = keyframesOf("lmd-mode-slide-in-from-right");
    expect(left).toContain("translateX(-100%)");
    expect(left).not.toContain("translateX(100%)");
    expect(right).toContain("translateX(100%)");
    expect(right).not.toContain("translateX(-100%)");
  });

  it("只动 transform，不动 width/height/margin（护住滚动锚点链路）", () => {
    // 两个进场规则里只允许 animation / will-change
    for (const dir of ["to-edit", "to-preview"]) {
      const m = new RegExp(
        `\\.editor-main-area\\[data-lmd-mode-anim="${dir}"\\][\\s\\S]*?\\{([\\s\\S]*?)\\}`,
      ).exec(CSS);
      expect(m).toBeTruthy();
      const body = m![1];
      for (const forbidden of ["width:", "height:", "margin", "padding", "left:", "top:"]) {
        expect(body, `${dir} 的进场规则不应改 ${forbidden}`).not.toContain(forbidden);
      }
    }
    // keyframes 内部同样禁止布局属性（只允许 transform / opacity 这类合成属性）
    for (const name of ["lmd-mode-slide-in-from-left", "lmd-mode-slide-in-from-right"]) {
      const kf = keyframesOf(name);
      expect(kf).not.toMatch(/\bwidth\s*:/);
      expect(kf).not.toMatch(/\bheight\s*:/);
      expect(kf).toMatch(/transform:\s*translateX\(/);
    }
  });

  it("动画窗口内临时关掉编辑区内部的宽度过渡（避免两套动画打架）", () => {
    const m =
      /\.editor-main-area\[data-lmd-mode-anim\]\s*>([\s\S]*?)\{([\s\S]*?)\}/.exec(CSS);
    expect(m, "缺少「动画期间屏蔽内部宽度过渡」的规则").toBeTruthy();
    expect(m![1]).toContain(".source-editor-wrapper");
    expect(m![1]).toContain(".split-preview-shell");
    expect(m![2]).toMatch(/transition:\s*none\s*!important/);
  });

  it("减少动效偏好：两个方向都不位移（模式照常切换）", () => {
    const m = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(CSS);
    expect(m, "缺少 prefers-reduced-motion 降级").toBeTruthy();
    const block = m![1];
    expect(block).toContain("to-edit");
    expect(block).toContain("to-preview");
    expect(block).toMatch(/animation:\s*none/);
  });
});
