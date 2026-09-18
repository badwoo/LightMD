/**
 * v0.8.0 WP3 需求3：标签关闭按钮 hover 抖动修复的回归守卫
 *
 * 抖动根因：关闭按钮原用 display:none → hover 时 display:flex，
 * 按钮出现即新增 16px 宽 + 4px gap，flex 布局重排 → 标签被"拉长抖动"。
 *
 * 修复方式：按钮常驻占位（固定宽高），仅用 opacity/pointer-events 切换显隐。
 * 本测试直接对 CSS 断言，防止后续有人改回 display 切换导致抖动回归。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync(
  new URL("../components/layout/TabBar.css", import.meta.url),
  "utf-8",
  // 剥离注释：注释里会提到"旧实现用 display:none"等说明文字，不能参与断言
).replace(/\/\*[\s\S]*?\*\//g, "");

/** 取出指定选择器的声明块（首次匹配） */
function blockOf(selector: string): string {
  const idx = css.indexOf(selector + " {");
  if (idx === -1) return "";
  const end = css.indexOf("}", idx);
  return css.slice(idx, end);
}

describe("v0.8.0 WP3 标签关闭按钮不抖动", () => {
  it(".tab-close 常驻占位，不用 display:none 隐藏", () => {
    const block = blockOf(".tab-close");
    expect(block).not.toBe("");
    expect(block).not.toMatch(/display:\s*none/);
    expect(block).toMatch(/display:\s*flex/);
  });

  it(".tab-close 靠 opacity 控制显隐（默认不可见、不接收点击）", () => {
    const block = blockOf(".tab-close");
    expect(block).toMatch(/opacity:\s*0/);
    expect(block).toMatch(/pointer-events:\s*none/);
    // 固定宽高：保证 hover 前后占据的空间一致
    expect(block).toMatch(/width:\s*16px/);
    expect(block).toMatch(/height:\s*16px/);
    expect(block).toMatch(/flex-shrink:\s*0/);
  });

  it("hover 时仅切换透明度，不改变布局属性", () => {
    const block = blockOf(".tab-item:hover .tab-close");
    expect(block).not.toBe("");
    expect(block).toMatch(/opacity:\s*1/);
    expect(block).toMatch(/pointer-events:\s*auto/);
    expect(block).not.toMatch(/display:\s*flex/);
  });
});
