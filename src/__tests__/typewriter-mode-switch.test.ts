/**
 * 打字机模式下模式切换滚动位置丢失 bug 修复测试
 *
 * Bug 复现场景（通过 chrome-devtools 实时调试定位）：
 * - 用户开启打字机模式
 * - 在 split 模式下滚动 iframe 预览到 0.8
 * - 切换到 preview 模式
 * - 期望 pm=0.8，实际 pm=0（滚动位置丢失）
 *
 * 根因：
 * - 模式切换时 applyScroll 用 instant 方式设置 pmEditor.scrollTop = 0.8 * max
 * - 但打字机 effect 的初始 scrollToCenter 使用 smooth 滚动（异步多帧）
 * - scrollToCenter 在 applyScroll 之后继续滚动，覆盖了 applyScroll 的设置
 * - 导致 scrollTop 被拉回光标居中位置（通常为 0），滚动位置丢失
 *
 * 修复方案（shouldSkipInitialScrollToCenter 纯函数）：
 * - 正在恢复滚动位置（isRestoringScroll=true）：跳过 scrollToCenter
 * - 打字机关闭：跳过（不需要居中）
 * - 否则：执行 scrollToCenter（文件切换等场景需要光标居中）
 *
 * 实测验证（修复后，通过 chrome-devtools）：
 * - 打字机模式 split(0.5) → preview(0.5) → edit(0.5) → split(0.5) ✓
 * - 打字机模式 split iframe滚动(0.8) → preview(0.8) → edit(0.8) → split(0.8) ✓
 * - 非打字机模式多轮切换保持 0.8 ✓
 */
import { describe, it, expect } from "vitest";
import { shouldSkipInitialScrollToCenter } from "../utils/typewriter";

describe("shouldSkipInitialScrollToCenter - 打字机模式切换滚动位置丢失修复", () => {
  // ─── Bug 复现：模式切换时应跳过 scrollToCenter ──────────────

  it("Bug 复现：打字机开启 + 正在恢复滚动位置 → 应跳过", () => {
    // 模式切换后 applyScroll 尚未执行完，isRestoringScroll=true
    // 此时 scrollToCenter 的 smooth 滚动会覆盖 applyScroll 的 instant 设置
    expect(shouldSkipInitialScrollToCenter(true, true)).toBe(true);
  });

  // ─── 正常场景：文件切换时执行 scrollToCenter ──────────────

  it("打字机开启 + 未在恢复滚动位置 → 应执行（文件切换场景）", () => {
    // 文件切换时 forceUpdateKey 变化，打字机 effect 重新执行
    // 此时 isRestoringScroll=false，需要光标居中
    expect(shouldSkipInitialScrollToCenter(false, true)).toBe(false);
  });

  it("打字机关闭 + 未在恢复滚动位置 → 应跳过（不需要居中）", () => {
    expect(shouldSkipInitialScrollToCenter(false, false)).toBe(true);
  });

  it("打字机关闭 + 正在恢复滚动位置 → 应跳过", () => {
    // isRestoringScroll 优先级高于 typewriterMode
    expect(shouldSkipInitialScrollToCenter(true, false)).toBe(true);
  });

  // ─── 边界场景 ──────────────────────────────────────

  it("isRestoringScroll 优先于 typewriterMode 判断", () => {
    // 无论 typewriterMode 是否开启，isRestoringScroll=true 时都应跳过
    expect(shouldSkipInitialScrollToCenter(true, true)).toBe(true);
    expect(shouldSkipInitialScrollToCenter(true, false)).toBe(true);
  });

  it("仅在打字机开启且未在恢复时才执行 scrollToCenter", () => {
    // 唯一返回 false（执行 scrollToCenter）的场景
    expect(shouldSkipInitialScrollToCenter(false, true)).toBe(false);
    // 其他所有组合都应跳过
    expect(shouldSkipInitialScrollToCenter(false, false)).toBe(true);
    expect(shouldSkipInitialScrollToCenter(true, true)).toBe(true);
    expect(shouldSkipInitialScrollToCenter(true, false)).toBe(true);
  });
});
