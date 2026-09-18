/**
 * v0.8.0 修复4：打字机模式开启时即时把光标行滚到屏幕中央
 *
 * 根因：PM 侧滚动 effect 依赖数组为 [viewMode, forceUpdateKey]，不含 typewriterMode，
 * 开关切换不重跑该 effect，初始居中（shouldSkipInitialScrollToCenter 守卫内的
 * scrollToCenter）不执行，只有回车（触发视口外判定）后才居中。
 *
 * 修复：effect deps 增加 typewriterMode；onSelectionChange 在打字机开启且非恢复滚动时
 * 经 scrollToCenterRef 用 rAF 调用 scrollToCenter（computeTypewriterScrollTop 自带
 * 5px 阈值防抖）。本文件对两个相关纯函数做行为验证。
 */
import { describe, it, expect } from "vitest";
import {
  shouldSkipInitialScrollToCenter,
  computeTypewriterScrollTop,
} from "../utils/typewriter";

describe("shouldSkipInitialScrollToCenter - 打字机开启即时居中的守卫", () => {
  it("模式切换恢复滚动期间（isRestoring=true）→ 跳过居中，避免 smooth 覆盖 applyScroll", () => {
    expect(shouldSkipInitialScrollToCenter(true, true)).toBe(true);
    expect(shouldSkipInitialScrollToCenter(true, false)).toBe(true);
  });

  it("打字机关闭（isTypewriterMode=false）→ 跳过居中（无需光标居中）", () => {
    expect(shouldSkipInitialScrollToCenter(false, false)).toBe(true);
  });

  it("打字机开启且非恢复滚动（false, true）→ 不跳过，应当居中", () => {
    // 与修复前（effect 不含 typewriterMode、onSelectionChange 不触发）对比：
    // 修复后开关切换瞬间即应走居中分支，返回 false 表示"执行居中"
    expect(shouldSkipInitialScrollToCenter(false, true)).toBe(false);
  });
});

describe("computeTypewriterScrollTop - 开启打字机后的居中目标", () => {
  it("光标已位于视口中央附近（差距 < 阈值）→ 返回 null，不抖动", () => {
    // 视口 600，光标在 300（正中），当前 scrollTop=0 → targetY=0，差距 0 < 5
    const result = computeTypewriterScrollTop(300, 600, 2000, 0);
    expect(result).toBeNull();
  });

  it("光标在文档中部、当前未居中 → 返回居中目标，且 > 0", () => {
    // 视口 600，光标在 1200，targetY = 1200 - 300 = 900
    const result = computeTypewriterScrollTop(1200, 600, 5000, 0);
    expect(result).toBe(900);
  });

  it("打字机开启切换瞬间：光标在第一行 → targetY 为负，钳制为 0", () => {
    const result = computeTypewriterScrollTop(100, 600, 3000, 0);
    expect(result).toBe(0);
  });

  it("阈值边界：差距等于阈值（5px）不滚动，差 6px 滚动", () => {
    // 视口 600，光标 900，targetY = 600；当前 scrollTop=595 → 差距 5 → null
    expect(computeTypewriterScrollTop(900, 600, 4000, 595)).toBeNull();
    // 当前 scrollTop=594 → 差距 6 → 返回 600
    expect(computeTypewriterScrollTop(900, 600, 4000, 594)).toBe(600);
  });

  it("内容未超出视口 → null（少量内容不强制居中）", () => {
    expect(computeTypewriterScrollTop(50, 600, 400, 0)).toBeNull();
  });
});
