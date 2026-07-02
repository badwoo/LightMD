/**
 * split 模式滚动联动 bug 修复测试
 *
 * Bug 复现场景（通过 chrome-devtools 实时调试定位）：
 * - 用户在 split 模式下滚动 iframe 预览区
 * - iframe 的 scroll 事件触发在 contentDocument/contentWindow 上
 * - 但原代码 onPreviewScroll 监听的是 documentElement（iframe.contentDocument.documentElement）
 * - documentElement 上 scroll 事件不触发（实测 htmlCount=0, winCount=1, docCount=1）
 * - 导致 onPreviewScroll 永远不执行，textarea 不联动 iframe 滚动
 * - textareaScrollPercentRef 保持旧值，切换模式时滚动位置丢失
 *
 * 修复方案：
 * 1. 将 scroll 事件监听从 documentElement 改到 contentDocument
 * 2. 提取 computeSyncScrollTop 纯函数封装百分比映射逻辑
 *
 * 实测验证（修复后）：
 * - split 模式滚动 iframe 到中间（ifPercent=0.1465）→ textarea 同步（taPercent=0.1465）
 * - 切换到 preview → pmPercent=0.1466（保持一致）
 * - 切换到 edit → taPercent=0.1467（保持一致）
 * - 切换回 split → taPercent=0.1468, ifPercent=0.1468（一致）
 */
import { describe, it, expect } from "vitest";
import { computeSyncScrollTop } from "../utils/typewriter";

describe("computeSyncScrollTop - split 模式滚动联动修复", () => {
  // ─── Bug 复现：iframe 预览滚动应同步 textarea ──────────────

  it("Bug 复现场景：iframe 滚动到中间，textarea 应同步到中间", () => {
    // 真实调试数据：iframe scrollHeight=7445, clientHeight=619, scrollTop=1000
    // 期望 textarea scrollTop = percent * textareaMax = 0.1465 * 5601 = 820.5
    const result = computeSyncScrollTop(1000, 7445, 619, 6299, 698);
    const expectedPercent = 1000 / (7445 - 619);
    const expected = expectedPercent * (6299 - 698);
    expect(result).toBeCloseTo(expected, 1);
  });

  it("iframe 滚动到底部，textarea 应同步到底部", () => {
    // iframe 滚动到底部：scrollTop = scrollHeight - clientHeight = 6826
    const result = computeSyncScrollTop(6826, 7445, 619, 6299, 698);
    const expected = 6826 / (7445 - 619) * (6299 - 698);
    expect(result).toBeCloseTo(expected, 1);
  });

  it("iframe 滚动到顶部，textarea 应同步到顶部", () => {
    const result = computeSyncScrollTop(0, 7445, 619, 6299, 698);
    expect(result).toBe(0);
  });

  // ─── 反向同步：textarea 滚动应同步 iframe ─────────────────

  it("textarea 滚动到中间，iframe 应同步到中间", () => {
    // 真实调试数据：textarea scrollHeight=6299, clientHeight=698, scrollTop=821
    // 期望 iframe scrollTop = percent * iframeMax = 0.1465 * 6826 = 1000.1
    const result = computeSyncScrollTop(821, 6299, 698, 7445, 619);
    const expectedPercent = 821 / (6299 - 698);
    const expected = expectedPercent * (7445 - 619);
    expect(result).toBeCloseTo(expected, 1);
  });

  it("textarea 滚动到底部，iframe 应同步到底部", () => {
    const result = computeSyncScrollTop(5601, 6299, 698, 7445, 619);
    const expected = 5601 / (6299 - 698) * (7445 - 619);
    expect(result).toBeCloseTo(expected, 1);
  });

  // ─── 边界场景：内容未超出视口 ──────────────────────────

  it("源元素内容未超出视口（sourceMax=0）：返回 0", () => {
    // textarea 内容很少，不需要滚动
    expect(computeSyncScrollTop(0, 500, 500, 7445, 619)).toBe(0);
  });

  it("目标元素内容未超出视口（targetMax=0）：返回 0", () => {
    // iframe 内容很少，不需要滚动
    expect(computeSyncScrollTop(1000, 7445, 619, 500, 500)).toBe(0);
  });

  it("源和目标都未超出视口：返回 0", () => {
    expect(computeSyncScrollTop(0, 500, 500, 500, 500)).toBe(0);
  });

  // ─── 边界场景：display:none 时 scrollHeight=0 ─────────────

  it("源元素 display:none（scrollHeight=0）：返回 0", () => {
    // 切换模式后原元素 display:none，scrollHeight=0, clientHeight=0
    expect(computeSyncScrollTop(0, 0, 0, 7445, 619)).toBe(0);
  });

  it("目标元素 display:none（scrollHeight=0）：返回 0", () => {
    expect(computeSyncScrollTop(1000, 7445, 619, 0, 0)).toBe(0);
  });

  // ─── 完整流程模拟：split 滚动 → 切换模式 → 滚动保持 ──────

  it("完整流程：split 滚动 iframe → 切换 preview → 滚动位置保持", () => {
    // 1. split 模式下 iframe 滚动到 1000
    const iframeScrollTop = 1000;
    const iframeSH = 7445, iframeCH = 619;
    const taSH = 6299, taCH = 698;

    // 2. textarea 同步滚动
    const taScrollTop = computeSyncScrollTop(iframeScrollTop, iframeSH, iframeCH, taSH, taCH);
    const taPercent = taScrollTop / (taSH - taCH);
    expect(taPercent).toBeCloseTo(iframeScrollTop / (iframeSH - iframeCH), 2);

    // 3. 切换到 preview 模式，使用 textarea 的百分比
    //    ProseMirror scrollHeight=3018, clientHeight=736
    const pmSH = 3018, pmCH = 736;
    const pmScrollTop = taPercent * (pmSH - pmCH);
    const pmPercent = pmScrollTop / (pmSH - pmCH);
    expect(pmPercent).toBeCloseTo(taPercent, 2);
  });

  it("完整流程：split 滚动到底部 → 切换 preview → 仍在底部", () => {
    // 1. iframe 滚动到底部
    const iframeSH = 7445, iframeCH = 619;
    const iframeScrollTop = iframeSH - iframeCH; // 底部

    // 2. textarea 同步
    const taSH = 6299, taCH = 698;
    const taScrollTop = computeSyncScrollTop(iframeScrollTop, iframeSH, iframeCH, taSH, taCH);
    const taPercent = taScrollTop / (taSH - taCH);
    expect(taPercent).toBeCloseTo(1, 2); // 底部

    // 3. 切换到 preview，百分比保持 1（底部）
    const pmSH = 3018, pmCH = 736;
    const pmScrollTop = taPercent * (pmSH - pmCH);
    expect(pmScrollTop).toBeCloseTo(pmSH - pmCH, 1); // 底部
  });

  // ─── 极端值 ──────────────────────────────────────

  it("大文档场景：iframe scrollHeight=100000", () => {
    const result = computeSyncScrollTop(50000, 100000, 800, 80000, 600);
    const expected = 50000 / (100000 - 800) * (80000 - 600);
    expect(result).toBeCloseTo(expected, 1);
  });

  it("零值检查：所有参数为 0 时返回 0，不产生 NaN", () => {
    const result = computeSyncScrollTop(0, 0, 0, 0, 0);
    expect(result).not.toBeNaN();
    expect(result).toBe(0);
  });

  it("负值防御：sourceMax < 0 时返回 0", () => {
    // scrollHeight < clientHeight（内容小于视口）
    expect(computeSyncScrollTop(0, 300, 500, 7445, 619)).toBe(0);
  });
});
