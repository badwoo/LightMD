/**
 * 模式切换后滚动位置丢失 bug 修复测试
 *
 * Bug 复现场景（通过 chrome-devtools 实时调试定位）：
 * - 用户在阅读模式（preview）滚动到 scrollTop=1000
 * - 双击 Ctrl 切换到编辑模式（edit），此时 ProseMirror 元素 display:none
 * - display:none 导致 scrollHeight=0, clientHeight=0, max=0
 * - 浏览器触发 scroll 事件，原代码 max > 0 ? scrollTop / max : 0
 * - 百分比被错误地置为 0（pmScrollPercentRef.current = 0）
 * - 切换回阅读模式时，applyScroll 设置 scrollTop = 0 * max = 0
 * - 用户看到页面跳到顶部，滚动位置丢失
 *
 * 修复方案（computeScrollPercent 纯函数）：
 * - max > 0：正常计算百分比
 * - max <= 0：返回 null，调用方不更新百分比 ref
 *
 * 这样切换模式时仍保留切换前记录的百分比，模式切换回来后正确恢复滚动位置
 */
import { describe, it, expect } from "vitest";
import { computeScrollPercent } from "../utils/typewriter";

describe("computeScrollPercent - 模式切换滚动位置丢失修复", () => {
  // ─── Bug 复现：display:none 时不应更新百分比 ─────────────

  it("Bug 复现场景：display:none 时 scrollHeight=0, clientHeight=0，应返回 null", () => {
    // 切换到其他模式后，原模式元素 display:none
    // scrollHeight 和 clientHeight 都变为 0
    expect(computeScrollPercent(0, 0, 0)).toBeNull();
  });

  it("display:none 时即使 scrollTop 非零（理论上不会发生），也应返回 null", () => {
    // 防御性测试：即使 scrollTop 有残留值，display:none 时也不应更新
    expect(computeScrollPercent(0, 0, 500)).toBeNull();
  });

  // ─── 正常场景：元素可见时正确计算百分比 ─────────────────

  it("正常滚动：scrollTop=500, max=1000，应返回 0.5", () => {
    // scrollHeight=1500, clientHeight=500, max=1000
    expect(computeScrollPercent(1500, 500, 500)).toBeCloseTo(0.5, 5);
  });

  it("顶部位置：scrollTop=0，应返回 0", () => {
    expect(computeScrollPercent(2000, 500, 0)).toBe(0);
  });

  it("底部位置：scrollTop=max，应返回 1", () => {
    // scrollHeight=2000, clientHeight=500, max=1500
    expect(computeScrollPercent(2000, 500, 1500)).toBeCloseTo(1, 5);
  });

  it("中间位置：scrollTop=750, max=1500，应返回 0.5", () => {
    expect(computeScrollPercent(2000, 500, 750)).toBeCloseTo(0.5, 5);
  });

  // ─── 边界场景：内容未超出视口 ──────────────────────────

  it("内容未超出视口：scrollHeight=clientHeight，max=0，应返回 null", () => {
    // 内容刚好填满视口，不需要滚动
    expect(computeScrollPercent(500, 500, 0)).toBeNull();
  });

  it("内容小于视口：scrollHeight < clientHeight，max < 0，应返回 null", () => {
    // 内容很少，不需要滚动
    expect(computeScrollPercent(300, 500, 0)).toBeNull();
  });

  // ─── 真实场景模拟：模式切换完整流程 ─────────────────────

  it("完整流程：preview 滚动 → 切换到 edit → 切换回 preview，百分比应保持", () => {
    // 1. preview 模式下滚动到中间位置
    //    scrollHeight=2000, clientHeight=500, scrollTop=750
    const percentBefore = computeScrollPercent(2000, 500, 750);
    expect(percentBefore).toBeCloseTo(0.5, 5);

    // 2. 切换到 edit 模式，ProseMirror 变为 display:none
    //    scroll 事件触发，但 max=0，应返回 null（不更新百分比）
    const percentAfterHide = computeScrollPercent(0, 0, 0);
    expect(percentAfterHide).toBeNull();

    // 3. 切换回 preview 模式，ProseMirror 恢复显示
    //    此时仍使用步骤 1 记录的百分比 0.5
    //    scrollHeight=2000, clientHeight=500, max=1500, newTop=0.5*1500=750
    const restoredScrollTop = (percentBefore ?? 0) * 1500;
    expect(restoredScrollTop).toBe(750);
  });

  it("完整流程：edit 滚动 → 切换到 preview → 切换回 edit，百分比应保持", () => {
    // 1. edit 模式下 textarea 滚动到 3/4 位置
    //    scrollHeight=4000, clientHeight=1000, max=3000, scrollTop=2250
    const percentBefore = computeScrollPercent(4000, 1000, 2250);
    expect(percentBefore).toBeCloseTo(0.75, 5);

    // 2. 切换到 preview 模式，textarea 变为 display:none
    //    scroll 事件触发，但 max=0，应返回 null
    const percentAfterHide = computeScrollPercent(0, 0, 0);
    expect(percentAfterHide).toBeNull();

    // 3. 切换回 edit 模式，textarea 恢复显示
    //    使用步骤 1 记录的百分比 0.75
    const restoredScrollTop = (percentBefore ?? 0) * 3000;
    expect(restoredScrollTop).toBe(2250);
  });

  // ─── 极端值：确保不会产生 NaN 或 Infinity ───────────────

  it("零值检查：所有参数为 0 时返回 null，不产生 NaN", () => {
    const result = computeScrollPercent(0, 0, 0);
    expect(result).not.toBeNaN();
    expect(result).toBeNull();
  });

  it("大文档场景：scrollHeight=100000, clientHeight=800, scrollTop=50000", () => {
    const result = computeScrollPercent(100000, 800, 50000);
    const expected = 50000 / (100000 - 800);
    expect(result).toBeCloseTo(expected, 5);
  });
});
