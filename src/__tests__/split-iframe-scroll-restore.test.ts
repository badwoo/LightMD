/**
 * 分屏模式 iframe 滚动位置恢复 bug 修复测试
 *
 * Bug 复现场景（用户反馈）：
 * - 第一次打开文件切换至分屏模式时，右边渲染预览的页面滚动位置丢失
 * - 需要鼠标滚动一下，滚动位置才能同步
 *
 * 根因分析：
 * 1. applyScroll effect 的 else 分支（edit 和 split 共用）只恢复 textarea，
 *    不恢复 iframe 的滚动位置
 * 2. iframe 内容异步加载（mermaid/katex 脚本），scrollHeight 在脚本执行前不准确
 * 3. 即使在 applyScroll 中设置 iframe.scrollTop，也可能被后续 iframe 内容渲染冲掉
 *
 * 修复方案：
 * 1. 新增 pendingIframeScrollRef 记录 iframe 待恢复的滚动百分比
 * 2. applyScroll 中 targetMode === "split" 时设置 pendingIframeScrollRef
 *    并尝试立即设置 iframe.scrollTop（覆盖 iframe 已就绪的场景）
 * 3. iframe 写入完成后检查 pendingIframeScrollRef，使用延迟设置 scrollTop
 *    （完整重写含 mermaid/katex 时延迟 300ms，增量更新时 rAF）
 * 4. 提取 computeRestoreScrollTop 纯函数封装百分比 → scrollTop 计算
 *
 * computeRestoreScrollTop 是 computeScrollPercent 的逆运算：
 * - computeScrollPercent: (scrollHeight, clientHeight, scrollTop) → percent | null
 * - computeRestoreScrollTop: (percent, scrollHeight, clientHeight) → scrollTop | null
 */
import { describe, it, expect } from "vitest";
import { computeRestoreScrollTop, computeScrollPercent } from "../utils/typewriter";

describe("computeRestoreScrollTop - 分屏 iframe 滚动位置恢复", () => {
  // ─── 正常场景：根据百分比恢复 scrollTop ──────────────────

  it("中间位置：percent=0.5, max=1000，应返回 500", () => {
    // scrollHeight=1500, clientHeight=500, max=1000
    expect(computeRestoreScrollTop(0.5, 1500, 500)).toBe(500);
  });

  it("顶部位置：percent=0，应返回 0", () => {
    expect(computeRestoreScrollTop(0, 2000, 500)).toBe(0);
  });

  it("底部位置：percent=1, max=1500，应返回 1500", () => {
    // scrollHeight=2000, clientHeight=500, max=1500
    expect(computeRestoreScrollTop(1, 2000, 500)).toBe(1500);
  });

  it("30% 位置：percent=0.3, max=1000，应返回 300", () => {
    expect(computeRestoreScrollTop(0.3, 1500, 500)).toBe(300);
  });

  // ─── Bug 复现：iframe 内容未就绪时不应设置 scrollTop ────────

  it("Bug 复现：iframe 未写入内容（scrollHeight=0），应返回 null", () => {
    // applyScroll 执行时 iframe 可能还没写入内容
    // scrollHeight=0, clientHeight=0, max=0
    expect(computeRestoreScrollTop(0.5, 0, 0)).toBeNull();
  });

  it("iframe 内容未超出视口（scrollHeight=clientHeight），应返回 null", () => {
    // 内容很少，不需要滚动
    expect(computeRestoreScrollTop(0.5, 500, 500)).toBeNull();
  });

  it("iframe 内容小于视口（scrollHeight < clientHeight），应返回 null", () => {
    // scrollHeight=300, clientHeight=500, max=-200
    expect(computeRestoreScrollTop(0.5, 300, 500)).toBeNull();
  });

  // ─── 完整流程模拟：模式切换 → iframe 滚动恢复 ──────────────

  it("完整流程：preview 滚动到中间 → 切换 split → iframe 恢复到中间", () => {
    // 1. preview 模式下 ProseMirror 滚动到中间
    const pmScrollTop = 500;
    const pmSH = 1500, pmCH = 500;
    const percent = computeScrollPercent(pmSH, pmCH, pmScrollTop);
    expect(percent).toBeCloseTo(0.5, 5);

    // 2. 切换到 split 模式，使用百分比恢复 iframe
    //    iframe scrollHeight=7445, clientHeight=619
    const iframeSH = 7445, iframeCH = 619;
    const iframeScrollTop = computeRestoreScrollTop(percent!, iframeSH, iframeCH);
    expect(iframeScrollTop).not.toBeNull();
    // 验证百分比一致
    const iframePercent = iframeScrollTop! / (iframeSH - iframeCH);
    expect(iframePercent).toBeCloseTo(0.5, 5);
  });

  it("完整流程：edit 滚动到 30% → 切换 split → iframe 恢复到 30%", () => {
    // 1. edit 模式下 textarea 滚动到 30%
    const taSH = 6299, taCH = 698;
    const taPercent = 0.3;
    const taScrollTop = taPercent * (taSH - taCH);

    // 2. 切换到 split 模式，使用百分比恢复 iframe
    const iframeSH = 7445, iframeCH = 619;
    const iframeScrollTop = computeRestoreScrollTop(taPercent, iframeSH, iframeCH);
    expect(iframeScrollTop).toBeCloseTo(taPercent * (iframeSH - iframeCH), 1);

    // 验证 textarea 和 iframe 的百分比一致
    const iframePercent = iframeScrollTop! / (iframeSH - iframeCH);
    expect(iframePercent).toBeCloseTo(taPercent, 5);
  });

  // ─── 时序场景：iframe 异步加载 ──────────────────────────

  it("时序场景：applyScroll 时 iframe 未就绪 → 写入后恢复", () => {
    // 模拟 applyScroll 时 iframe scrollHeight=0（未就绪）
    const percent = 0.5;
    const applyScrollResult = computeRestoreScrollTop(percent, 0, 0);
    expect(applyScrollResult).toBeNull(); // 未就绪，不设置

    // 模拟 iframe 写入完成后 scrollHeight 就绪
    const finalScrollTop = computeRestoreScrollTop(percent, 7445, 619);
    expect(finalScrollTop).toBeCloseTo(0.5 * (7445 - 619), 1);
  });

  it("时序场景：mermaid 异步渲染导致 scrollHeight 变化 → 延迟设置", () => {
    // 模拟 mermaid 渲染前 scrollHeight 较小
    const percent = 0.5;
    const beforeRender = computeRestoreScrollTop(percent, 3000, 619);
    // mermaid 渲染后 scrollHeight 增大
    const afterRender = computeRestoreScrollTop(percent, 7445, 619);

    expect(beforeRender).not.toBe(afterRender);
    // 应使用渲染后的 scrollHeight 设置 scrollTop
    expect(afterRender).toBeCloseTo(0.5 * (7445 - 619), 1);
  });

  // ─── 与 computeScrollPercent 的互逆性 ──────────────────────

  it("互逆性：computeScrollPercent → computeRestoreScrollTop 应还原原 scrollTop", () => {
    // 给定 scrollTop，计算百分比，再用百分比恢复 scrollTop
    const originalScrollTop = 750;
    const scrollHeight = 2000, clientHeight = 500;

    const percent = computeScrollPercent(scrollHeight, clientHeight, originalScrollTop);
    expect(percent).not.toBeNull();

    const restoredScrollTop = computeRestoreScrollTop(percent!, scrollHeight, clientHeight);
    expect(restoredScrollTop).not.toBeNull();
    expect(restoredScrollTop).toBeCloseTo(originalScrollTop, 5);
  });

  it("互逆性：边界值 scrollTop=0", () => {
    const percent = computeScrollPercent(2000, 500, 0);
    expect(percent).toBe(0);
    const restored = computeRestoreScrollTop(percent!, 2000, 500);
    expect(restored).toBe(0);
  });

  it("互逆性：边界值 scrollTop=max", () => {
    const max = 1500;
    const percent = computeScrollPercent(2000, 500, max);
    expect(percent).toBeCloseTo(1, 5);
    const restored = computeRestoreScrollTop(percent!, 2000, 500);
    expect(restored).toBeCloseTo(max, 5);
  });

  // ─── 边界值与防御性测试 ──────────────────────────────

  it("百分比越界：percent > 1 时应钳制为 1", () => {
    // 异常场景：百分比可能因浮点误差略超 1
    expect(computeRestoreScrollTop(1.5, 2000, 500)).toBe(1500);
  });

  it("百分比越界：percent < 0 时应钳制为 0", () => {
    expect(computeRestoreScrollTop(-0.5, 2000, 500)).toBe(0);
  });

  it("零值检查：所有参数为 0 时返回 null，不产生 NaN", () => {
    const result = computeRestoreScrollTop(0.5, 0, 0);
    expect(result).not.toBeNaN();
    expect(result).toBeNull();
  });

  it("大文档场景：scrollHeight=100000", () => {
    const result = computeRestoreScrollTop(0.5, 100000, 800);
    expect(result).toBeCloseTo(0.5 * (100000 - 800), 1);
  });

  // ─── 真实调试数据验证 ──────────────────────────────────

  it("真实数据：iframe scrollHeight=7445, clientHeight=619, percent=0.1465", () => {
    // 来自 chrome-devtools 实测数据
    const result = computeRestoreScrollTop(0.1465, 7445, 619);
    const expected = 0.1465 * (7445 - 619);
    expect(result).toBeCloseTo(expected, 1);
  });

  it("真实数据：textarea scrollHeight=6299, clientHeight=698, percent=0.1465", () => {
    const result = computeRestoreScrollTop(0.1465, 6299, 698);
    const expected = 0.1465 * (6299 - 698);
    expect(result).toBeCloseTo(expected, 1);
  });
});
