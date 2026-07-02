/**
 * 阅读模式编辑闪烁抖动 bug 修复测试
 *
 * Bug 复现场景（通过 chrome-devtools 实时调试定位）：
 * - 阅读模式下，光标位于第 6 段开头，scrollTop=700
 * - 连续输入 87 个字符后触发软换行（white-space: pre-wrap）
 * - 行 N-1 内容被挤到行 N，光标跟随内容上移
 * - cursorY 从 499.23 减小到 470.44（diff=28.79，超过阈值 5）
 * - 早期实现触发 scrollToVisible，检测到 cursorTop=-153.56 < 0
 * - 强制 scrollTop 大幅跳跃到 450.67，用户感受到屏幕闪烁抖动
 *
 * 修复方案（shouldSkipScrollForCharInput 纯函数）：
 * - 普通字符输入 + 光标在视口内 → 跳过滚动（修复核心）
 * - 普通字符输入 + 光标离开视口 → 触发滚动（保留可见性）
 * - 导航键 + 任何情况 → 触发滚动（确保光标可见）
 */
import { describe, it, expect } from "vitest";
import { shouldSkipScrollForCharInput } from "../utils/typewriter";

describe("shouldSkipScrollForCharInput - 阅读模式闪烁抖动修复", () => {
  // ─── Bug 复现：软换行场景应跳过滚动 ──────────────────────

  it("Bug 复现场景：软换行时光标在视口内，普通字符输入应跳过滚动", () => {
    // 真实调试数据：视口高度 600，光标在视口内（cursorTop=200, cursorBottom=228）
    // 软换行导致 cursorY 减小 28.79px，但光标仍在视口内
    // 期望：跳过滚动，避免 scrollToVisible 强制跳跃
    expect(shouldSkipScrollForCharInput("a", 200, 228, 600)).toBe(true);
  });

  it("软换行边界：光标在视口顶部边缘，普通字符输入应跳过滚动", () => {
    // 光标顶部刚好在视口顶部（cursorTop=0）
    expect(shouldSkipScrollForCharInput("中", 0, 28, 600)).toBe(true);
  });

  it("软换行边界：光标在视口底部边缘，普通字符输入应跳过滚动", () => {
    // 光标底部刚好在视口底部（cursorBottom=clientHeight）
    expect(shouldSkipScrollForCharInput("z", 572, 600, 600)).toBe(true);
  });

  // ─── 普通字符输入：光标离开视口时仍触发滚动 ─────────────

  it("普通字符输入 + 光标在视口上方：不跳过滚动（需触发滚动让光标可见）", () => {
    // 真实调试数据：软换行前 cursorTop=-153.56（光标在视口上方 153px）
    // 此时确实需要滚动让光标可见
    expect(shouldSkipScrollForCharInput("a", -153, -125, 600)).toBe(false);
  });

  it("普通字符输入 + 光标在视口下方：不跳过滚动（需触发滚动让光标可见）", () => {
    // 光标底部超出视口（cursorBottom > clientHeight）
    expect(shouldSkipScrollForCharInput("a", 580, 620, 600)).toBe(false);
  });

  it("普通字符输入 + 光标顶部为负但底部在视口内：不跳过（部分可见仍需滚动）", () => {
    // 光标顶部 -10（部分超出视口上方），底部 18（在视口内）
    // 按修复逻辑：cursorTop < 0 不满足"在视口内"条件，应触发滚动
    expect(shouldSkipScrollForCharInput("a", -10, 18, 600)).toBe(false);
  });

  // ─── 导航键：始终触发滚动（不跳过）─────────────────────

  it("导航键 Enter + 光标在视口内：不跳过（始终触发滚动）", () => {
    expect(shouldSkipScrollForCharInput("Enter", 200, 228, 600)).toBe(false);
  });

  it("导航键 ArrowDown + 光标在视口内：不跳过（始终触发滚动）", () => {
    expect(shouldSkipScrollForCharInput("ArrowDown", 200, 228, 600)).toBe(false);
  });

  it("导航键 ArrowUp + 光标在视口内：不跳过（始终触发滚动）", () => {
    expect(shouldSkipScrollForCharInput("ArrowUp", 200, 228, 600)).toBe(false);
  });

  it("导航键 PageDown + 光标在视口内：不跳过（始终触发滚动）", () => {
    expect(shouldSkipScrollForCharInput("PageDown", 200, 228, 600)).toBe(false);
  });

  it("导航键 PageUp + 光标在视口内：不跳过（始终触发滚动）", () => {
    expect(shouldSkipScrollForCharInput("PageUp", 200, 228, 600)).toBe(false);
  });

  it("导航键 Home + 光标在视口内：不跳过（始终触发滚动）", () => {
    expect(shouldSkipScrollForCharInput("Home", 200, 228, 600)).toBe(false);
  });

  it("导航键 End + 光标在视口内：不跳过（始终触发滚动）", () => {
    expect(shouldSkipScrollForCharInput("End", 200, 228, 600)).toBe(false);
  });

  it("导航键 Enter + 光标在视口外：不跳过（始终触发滚动）", () => {
    expect(shouldSkipScrollForCharInput("Enter", -100, -72, 600)).toBe(false);
  });

  // ─── 普通字符类型：字母/数字/符号/中文均应跳过 ──────────

  it("各类普通字符 + 光标在视口内：均应跳过滚动", () => {
    const chars = ["a", "Z", "0", "9", "!", " ", "中", "。", ",", "."];
    for (const ch of chars) {
      expect(shouldSkipScrollForCharInput(ch, 200, 228, 600)).toBe(true);
    }
  });

  it("各类普通字符 + 光标在视口外：均不跳过滚动", () => {
    const chars = ["a", "Z", "0", "中", " "];
    for (const ch of chars) {
      expect(shouldSkipScrollForCharInput(ch, -100, -72, 600)).toBe(false);
    }
  });

  // ─── 修饰键：按普通字符处理（光标在视口内时跳过）─────────

  it("修饰键 + 光标在视口内：跳过滚动（修饰键不移动光标）", () => {
    // Shift/Control/Alt 等修饰键不移动光标，按普通字符处理
    expect(shouldSkipScrollForCharInput("Shift", 200, 228, 600)).toBe(true);
    expect(shouldSkipScrollForCharInput("Control", 200, 228, 600)).toBe(true);
    expect(shouldSkipScrollForCharInput("Alt", 200, 228, 600)).toBe(true);
  });

  // ─── 边界条件 ──────────────────────────────────────

  it("视口高度为 0：光标底部 > 0 不满足视口内条件，不跳过", () => {
    // 防御性：视口高度为 0 时不应误判为"在视口内"
    expect(shouldSkipScrollForCharInput("a", 0, 28, 0)).toBe(false);
  });

  it("光标顶部等于视口高度：底部必然超出，不跳过", () => {
    // cursorTop = clientHeight，cursorBottom 必然 > clientHeight
    expect(shouldSkipScrollForCharInput("a", 600, 628, 600)).toBe(false);
  });

  // ─── 综合：模拟连续输入场景 ──────────────────────────

  it("模拟连续输入 hello：每个字符都应跳过滚动（光标在视口内）", () => {
    // 模拟用户连续输入 "hello" —— 每个字符光标都在视口内，都不应触发滚动
    const chars = ["h", "e", "l", "l", "o"];
    for (const ch of chars) {
      expect(shouldSkipScrollForCharInput(ch, 250, 278, 600)).toBe(true);
    }
  });

  it("模拟软换行连续输入：cursorY 持续减小但光标仍在视口内，全程跳过滚动", () => {
    // 模拟软换行场景：每次输入 cursorY 减小，但光标始终在视口内
    // 真实调试数据：cursorY 从 499.23 减小到 470.44（diff=28.79）
    // 假设视口高度 600，光标 coordsTop 在视口内变化
    const inputs = [
      { key: "a", cursorTop: 300, cursorBottom: 328 }, // 初始
      { key: "b", cursorTop: 285, cursorBottom: 313 }, // 软换行后 Y 减小
      { key: "c", cursorTop: 270, cursorBottom: 298 }, // 继续减小
      { key: "d", cursorTop: 255, cursorBottom: 283 }, // 继续减小
    ];
    for (const input of inputs) {
      // 光标始终在视口内（0 <= cursorTop, cursorBottom <= 600），应跳过滚动
      expect(shouldSkipScrollForCharInput(input.key, input.cursorTop, input.cursorBottom, 600)).toBe(true);
    }
  });

  it("模拟回车换行：导航键应触发滚动（不跳过）", () => {
    // 回车换行应始终触发滚动，让新行可见
    expect(shouldSkipScrollForCharInput("Enter", 200, 228, 600)).toBe(false);
  });
});
