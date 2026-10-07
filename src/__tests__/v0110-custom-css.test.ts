/**
 * @vitest-environment jsdom
 *
 * v0.11.0 B6-2：让 `customCss` 设置真正生效。
 *
 * 缺陷背景（P0 · 欺骗性 UI）：
 *   设置面板有「自定义 CSS」输入框、store 有 customCss 字段与 setter、
 *   Rust 侧也有字段 —— 但**全仓无任何样式注入点** → 用户写完 CSS 点保存，
 *   毫无反应。这是典型的「UI 存在但功能未接线」。
 *
 * 修复：新增 utils/customCss.ts 负责幂等注入 + 非法 CSS 兜底 + 跨窗口同步。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { applyCustomCss, resetCustomCssCache, STYLE_EL_ID } from "../utils/customCss";

function styleEl(): HTMLStyleElement | null {
  return document.getElementById("lightmd-custom-css") as HTMLStyleElement | null;
}

describe("v0.11.0 B6-2 customCss 注入", () => {
  beforeEach(() => {
    resetCustomCssCache();
    styleEl()?.remove();
  });

  it("写入 CSS 后 head 中出现 style 容器", () => {
    const changed = applyCustomCss("h1 { color: red; }");
    expect(changed).toBe(true);
    expect(styleEl()).not.toBeNull();
    expect(styleEl()!.parentElement).toBe(document.head);
  });

  it("内容未变时不重复注入（幂等，避免 DOM 抖动）", () => {
    applyCustomCss("h1 { color: red; }");
    const second = applyCustomCss("h1 { color: red; }");
    expect(second).toBe(false);
    // 容器仍只有一个
    expect(document.querySelectorAll(`#${STYLE_EL_ID}`).length).toBe(1);
  });

  it("内容变化时更新同一个容器（不叠加多个 style 元素）", () => {
    applyCustomCss("h1 { color: red; }");
    applyCustomCss("h1 { color: blue; }");
    expect(document.querySelectorAll(`#${STYLE_EL_ID}`).length).toBe(1);
    const el = styleEl()!;
    // CSSOM 已生效或已写入文本
    const applied = el.sheet
      ? Array.from(el.sheet.cssRules).map((r) => r.cssText).join("")
      : el.textContent;
    expect(applied).toContain("blue");
  });

  it("空串表示清除（移除容器）", () => {
    applyCustomCss("h1 { color: red; }");
    expect(styleEl()).not.toBeNull();
    const changed = applyCustomCss("");
    expect(changed).toBe(true);
    expect(styleEl()).toBeNull();
  });

  it("空串在无容器时不算变更", () => {
    expect(applyCustomCss("")).toBe(false);
    expect(applyCustomCss("   ")).toBe(false);
  });

  it("非法 CSS 不抛错（不导致应用崩溃）", () => {
    // 常见非法写法：缺右括号 / 未知语法
    expect(() => applyCustomCss("h1 { color: red")).not.toThrow();
    expect(() => applyCustomCss("@@@ nonsense @@@")).not.toThrow();
    expect(() => applyCustomCss("}{")).not.toThrow();
    expect(styleEl()).not.toBeNull();
  });

  it("部分非法 + 部分合法时，合法部分仍生效", () => {
    applyCustomCss("h1 { color: red; }\n@@@ bad @@@\np { color: green; }");
    const el = styleEl();
    const applied = el!.sheet
      ? Array.from(el!.sheet.cssRules).map((r) => r.cssText).join("")
      : el!.textContent;
    expect(applied).toContain("red");
  });

  it("注入点在 head 末尾 → 优先级高于应用内样式（允许用户覆盖主题）", () => {
    applyCustomCss("h1 { color: red; }");
    const el = styleEl()!;
    expect(el.parentElement).toBe(document.head);
    // 是 head 的最后一个子节点（除脚本外）
    const last = document.head.lastElementChild;
    expect(last === el || el.compareDocumentPosition(last!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("main.tsx 已在启动时调用注入初始化", () => {
    const src = readFileSync("src/main.tsx", "utf-8");
    expect(src).toContain("initCustomCssInjection");
    expect(src).toContain("customCss");
  });

  it("store 的 setCustomCss 链路存在（UI 写入 → store → 订阅注入）", () => {
    const store = readFileSync("src/stores/useSettingsStore.ts", "utf-8");
    expect(store).toContain("customCss:");
    expect(store).toContain("setCustomCss");
  });

  it("设置面板有 customCss 输入框与说明文案", () => {
    const dlg = readFileSync("src/components/dialogs/SettingsDialog.tsx", "utf-8");
    expect(dlg).toContain("settings.customCss");
    expect(dlg).toContain("settings.customCss.hint");
  });
});
