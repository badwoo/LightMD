/**
 * v0.8.0 WP3 需求5：标签溢出滚动的纯函数测试
 *
 * 把"滚轮方向映射"和"左右按钮显隐边界"抽成纯函数后，这里直接验证映射与边界，
 * 不依赖 DOM，保证需求5的核心判定逻辑稳定、可读。
 */
import { describe, it, expect } from "vitest";
import {
  applyWheelScroll,
  shouldShowLeftBtn,
  shouldShowRightBtn,
} from "../services/tabScroll";

describe("v0.8.0 WP3 需求5：滚动纯函数", () => {
  describe("applyWheelScroll（滚轮方向映射）", () => {
    it("滚轮往下（deltaY > 0）→ scrollLeft 增大（看右侧标签）", () => {
      expect(applyWheelScroll(100, 50)).toBe(150);
    });
    it("滚轮往上（deltaY < 0）→ scrollLeft 减小（看左侧标签）", () => {
      expect(applyWheelScroll(100, -50)).toBe(50);
    });
    it("deltaY 为 0 时不变", () => {
      expect(applyWheelScroll(100, 0)).toBe(100);
    });
  });

  describe("shouldShowLeftBtn（左按钮显隐）", () => {
    it("scrollLeft === 0 时不显示（已是最左）", () => {
      expect(shouldShowLeftBtn(0)).toBe(false);
    });
    it("scrollLeft > 0 时显示", () => {
      expect(shouldShowLeftBtn(1)).toBe(true);
      expect(shouldShowLeftBtn(120)).toBe(true);
    });
  });

  describe("shouldShowRightBtn（右按钮显隐）", () => {
    it("未溢出时不显示（scrollLeft + clientWidth >= scrollWidth）", () => {
      // 内容完全可见：scrollLeft=0, clientWidth=800, scrollWidth=800
      expect(shouldShowRightBtn(0, 800, 800)).toBe(false);
    });
    it("恰好到达右边界（留 1px 容差）不显示", () => {
      // scrollLeft + clientWidth === scrollWidth - 1 → 不显示
      expect(shouldShowRightBtn(0, 800, 801)).toBe(false);
      // 还差 2px → 显示
      expect(shouldShowRightBtn(0, 800, 802)).toBe(true);
    });
    it("右侧仍有内容时显示", () => {
      expect(shouldShowRightBtn(100, 800, 2000)).toBe(true);
    });
    it("已滚到最右不显示", () => {
      // scrollLeft=1200, clientWidth=800, scrollWidth=2000 → 2000-1=1999; 1200+800=2000 >= 1999 → 不显示
      expect(shouldShowRightBtn(1200, 800, 2000)).toBe(false);
    });
  });
});
