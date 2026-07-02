/**
 * 打字机模式工具函数测试
 *
 * 验证修复屏幕跳动 bug 的核心逻辑：
 * 1. 普通字符输入不触发滚动
 * 2. 内容未超出视口时不滚动
 * 3. 阈值检查避免微小抖动
 */
import { describe, it, expect } from "vitest";
import { isTypewriterTriggerKey, computeTypewriterScrollTop } from "../utils/typewriter";

describe("isTypewriterTriggerKey", () => {
  it("导航键应触发滚动：Enter", () => {
    expect(isTypewriterTriggerKey("Enter")).toBe(true);
  });

  it("导航键应触发滚动：方向键", () => {
    expect(isTypewriterTriggerKey("ArrowUp")).toBe(true);
    expect(isTypewriterTriggerKey("ArrowDown")).toBe(true);
    expect(isTypewriterTriggerKey("ArrowLeft")).toBe(false); // 左右键不触发垂直滚动
    expect(isTypewriterTriggerKey("ArrowRight")).toBe(false);
  });

  it("导航键应触发滚动：翻页/Home/End", () => {
    expect(isTypewriterTriggerKey("PageUp")).toBe(true);
    expect(isTypewriterTriggerKey("PageDown")).toBe(true);
    expect(isTypewriterTriggerKey("Home")).toBe(true);
    expect(isTypewriterTriggerKey("End")).toBe(true);
  });

  it("普通字符不应触发滚动：字母", () => {
    expect(isTypewriterTriggerKey("a")).toBe(false);
    expect(isTypewriterTriggerKey("Z")).toBe(false);
    expect(isTypewriterTriggerKey("中")).toBe(false);
  });

  it("普通字符不应触发滚动：数字和符号", () => {
    expect(isTypewriterTriggerKey("0")).toBe(false);
    expect(isTypewriterTriggerKey("9")).toBe(false);
    expect(isTypewriterTriggerKey("!")).toBe(false);
    expect(isTypewriterTriggerKey(" ")).toBe(false); // 空格
  });

  it("修饰键不应触发滚动", () => {
    expect(isTypewriterTriggerKey("Shift")).toBe(false);
    expect(isTypewriterTriggerKey("Control")).toBe(false);
    expect(isTypewriterTriggerKey("Alt")).toBe(false);
    expect(isTypewriterTriggerKey("Tab")).toBe(false);
    expect(isTypewriterTriggerKey("Backspace")).toBe(false);
    expect(isTypewriterTriggerKey("Delete")).toBe(false);
  });
});

describe("computeTypewriterScrollTop", () => {
  it("内容未超出视口：返回 null（单行不滚动）", () => {
    // 视口 600px，内容仅 200px，光标在 50px 处
    const result = computeTypewriterScrollTop(50, 600, 200, 0);
    expect(result).toBeNull();
  });

  it("内容刚好等于视口高度：返回 null", () => {
    // 视口 600px，内容 600px，刚好填满，不滚动
    const result = computeTypewriterScrollTop(300, 600, 600, 0);
    expect(result).toBeNull();
  });

  it("内容超出视口且差距大于阈值：返回目标滚动位置", () => {
    // 视口 600px，内容 2000px，光标在 1000px 处
    // 目标位置 = 1000 - 300 = 700
    const result = computeTypewriterScrollTop(1000, 600, 2000, 0);
    expect(result).toBe(700);
  });

  it("光标在第一行（targetY 为负）：返回 0，不出现负值", () => {
    // 视口 600px，光标在 100px 处，targetY = 100 - 300 = -200，应钳制为 0
    // 但 currentScrollTop 也是 0，差距 200 > 阈值 5，应返回 Math.max(0, -200) = 0
    const result = computeTypewriterScrollTop(100, 600, 2000, 0);
    expect(result).toBe(0);
  });

  it("差距小于阈值：返回 null（避免微小抖动）", () => {
    // 视口 600px，光标在 800px 处，targetY = 800 - 300 = 500
    // 当前 scrollTop = 498，差距 2 < 阈值 5，应返回 null
    const result = computeTypewriterScrollTop(800, 600, 2000, 498);
    expect(result).toBeNull();
  });

  it("差距等于阈值：返回 null（边界条件，等于不滚动）", () => {
    // 视口 600px，光标在 800px 处，targetY = 500
    // 当前 scrollTop = 495，差距 5 == 阈值 5，应返回 null
    const result = computeTypewriterScrollTop(800, 600, 2000, 495);
    expect(result).toBeNull();
  });

  it("差距大于阈值：返回目标位置", () => {
    // 视口 600px，光标在 800px 处，targetY = 500
    // 当前 scrollTop = 490，差距 10 > 阈值 5，应返回 500
    const result = computeTypewriterScrollTop(800, 600, 2000, 490);
    expect(result).toBe(500);
  });

  it("自定义阈值生效：差距 8px，阈值 10 时不滚动", () => {
    // 视口 600px，光标在 800px 处，targetY = 500
    // 当前 scrollTop = 492，差距 8，默认阈值 5 会滚动，但自定义阈值 10 不滚动
    const result = computeTypewriterScrollTop(800, 600, 2000, 492, 10);
    expect(result).toBeNull();
  });

  it("自定义阈值生效：差距 12px，阈值 10 时滚动", () => {
    const result = computeTypewriterScrollTop(800, 600, 2000, 488, 10);
    expect(result).toBe(500);
  });

  it("光标在文档末尾附近：返回合理的目标位置", () => {
    // 视口 600px，内容 2000px，光标在 1900px 处
    // targetY = 1900 - 300 = 1600
    const result = computeTypewriterScrollTop(1900, 600, 2000, 0);
    expect(result).toBe(1600);
  });

  it("模拟连续打字场景：普通字符不触发（通过 isTypewriterTriggerKey 过滤）", () => {
    // 模拟用户连续输入 "hello" —— 每个字符都不应触发滚动
    const chars = ["h", "e", "l", "l", "o"];
    for (const ch of chars) {
      expect(isTypewriterTriggerKey(ch)).toBe(false);
    }
  });

  it("模拟回车换行场景：应触发滚动", () => {
    // 模拟用户按回车换行 —— 应触发滚动
    expect(isTypewriterTriggerKey("Enter")).toBe(true);
  });
});
