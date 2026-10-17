// @vitest-environment jsdom
/**
 * v0.13.2 需求8：分屏**双向映射**滚动的纯数学层。
 *
 * ## 用户原话
 * 「需求13 的分屏模式联动滚动优化要继续，左右屏滚动要跟着联动，但左右屏不是共用滚动条，
 *  而是映射关系……左右两屏看到的内容尽量能对齐。」选定方案：「双向映射」。
 *
 * ## 与既有测试的分工
 * - `v0131-block-scroll-align.test.ts` 覆盖 `topLevelBlockStartLines` / `pickAnchorIndex` /
 *   `estimateTopSourceLine` / `computeBlockAlignedScrollTop` 与「块对齐失败退回百分比」接线；
 * - `v0131-split-scroll-direction.test.ts` 覆盖双向接线与 `isSyncingScrollRef` 重入守卫；
 * - **本文件只覆盖本轮新增的 `PreviewAnchorSet` 映射层**：
 *   `locateSourceLine` / `mapSourceLineToPreviewScroll` / `mapPreviewScrollToSourceLine` /
 *   `mapSourceLineToScrollTop`，以及「双向共用同一份锚点采集、不互相驱动」的增量契约。
 *
 * 纯函数无 DOM 依赖，可以精确断言；只有最后一条接线锁需要读源码
 * （jsdom 无法建模真实 scroll 事件时序 —— iframe `contentDocument` 不参与布局）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  locateSourceLine,
  mapSourceLineToPreviewScroll,
  mapPreviewScrollToSourceLine,
  mapSourceLineToScrollTop,
  estimateTopSourceLine,
  type PreviewAnchorSet,
  type SourceViewportMetrics,
} from "../utils/blockScrollAlign";
import {
  SPLIT_SCROLL_LOCK_MS,
  createScrollDirectionLock,
  markScrollSource,
  resetScrollDirectionLock,
  shouldAcceptScroll,
} from "../utils/splitScrollSync";

/**
 * 典型锚点集（内容坐标系）：
 *
 * 源码行 0  → preview 0..100
 * 源码行 5  → preview 100..300
 * 源码行 12 → preview 300..600
 * 源码行 20 → preview 600..750
 */
const SET: PreviewAnchorSet = {
  lines: [0, 5, 12, 20],
  tops: [0, 100, 300, 600],
  heights: [100, 200, 300, 150],
  totalHeight: 750,
};

// ═══════════════ locateSourceLine：源码行 → (块下标, 块内比例) ═══════════════

describe("需求8 · locateSourceLine：定位源码行落在哪个块", () => {
  it("命中块内：按块起始行到下一块起始行线性求比例", () => {
    expect(locateSourceLine(SET, 0)).toEqual({ index: 0, ratio: 0 });
    expect(locateSourceLine(SET, 2.5)).toEqual({ index: 0, ratio: 0.5 });
    expect(locateSourceLine(SET, 5)).toEqual({ index: 1, ratio: 0 });
    expect(locateSourceLine(SET, 8.5)).toEqual({ index: 1, ratio: 0.5 });
    expect(locateSourceLine(SET, 12)).toEqual({ index: 2, ratio: 0 });
    // 12..20 共 8 行，行 16 是块内一半
    expect(locateSourceLine(SET, 16)).toEqual({ index: 2, ratio: 0.5 });
    expect(locateSourceLine(SET, 20)).toEqual({ index: 3, ratio: 0 });
  });

  it("落在第一个锚之前（前导空行/前言）→ 第 0 块、比例 0", () => {
    expect(locateSourceLine(SET, -1)).toEqual({ index: 0, ratio: 0 });
    expect(locateSourceLine(SET, -0.5)).toEqual({ index: 0, ratio: 0 });
  });

  it("落在最后一个锚之后 → 最后一块、比例夹到 1（不越界）", () => {
    expect(locateSourceLine(SET, 21)).toEqual({ index: 3, ratio: 1 });
    expect(locateSourceLine(SET, 999)).toEqual({ index: 3, ratio: 1 });
  });

  it("单锚点锚集：块内比例按 1 行跨度计算，不除零", () => {
    const single: PreviewAnchorSet = { lines: [3], tops: [40], heights: [120], totalHeight: 160 };
    expect(locateSourceLine(single, 3)).toEqual({ index: 0, ratio: 0 });
    expect(locateSourceLine(single, 3.5)).toEqual({ index: 0, ratio: 0.5 });
    expect(locateSourceLine(single, 4)).toEqual({ index: 0, ratio: 1 });
    expect(locateSourceLine(single, 100)).toEqual({ index: 0, ratio: 1 });
  });

  it("空锚集 → null（调用方退回百分比映射）", () => {
    expect(locateSourceLine({ ...SET, lines: [] }, 3)).toBeNull();
    expect(
      locateSourceLine({ ...SET, lines: undefined as unknown as number[] }, 3),
    ).toBeNull();
  });
});

// ═══════════════ mapSourceLineToPreviewScroll：左 → 右 ═══════════════

describe("需求8 · mapSourceLineToPreviewScroll：源码行 → 预览 scrollTop", () => {
  it("块内比例精确命中：行 0 / 8.5 / 16 / 21（viewport=0 时不被钳制）", () => {
    expect(mapSourceLineToPreviewScroll(SET, 0, 0)).toBe(0);
    expect(mapSourceLineToPreviewScroll(SET, 8.5, 0)).toBe(200); // 100 + 200×0.5
    expect(mapSourceLineToPreviewScroll(SET, 16, 0)).toBe(450); // 300 + 300×0.5
    expect(mapSourceLineToPreviewScroll(SET, 21, 0)).toBe(750); // 600 + 150×1
  });

  it("锚点所在行精确落在它的 top（块边界不被插值污染）", () => {
    for (let i = 0; i < SET.lines.length; i++) {
      expect(mapSourceLineToPreviewScroll(SET, SET.lines[i], 0)).toBe(SET.tops[i]);
    }
  });

  it("单调：源码行增大 → 目标 scrollTop 非减", () => {
    let prev = -Infinity;
    for (let line = -2; line <= 24; line += 0.25) {
      const v = mapSourceLineToPreviewScroll(SET, line, 400)!;
      expect(v).not.toBeNull();
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it("两端夹紧到 [0, totalHeight - viewportHeight]", () => {
    // viewport 400 → 可滚动上限 350
    expect(mapSourceLineToPreviewScroll(SET, 0, 400)).toBe(0);
    expect(mapSourceLineToPreviewScroll(SET, -5, 400)).toBe(0);
    expect(mapSourceLineToPreviewScroll(SET, 16, 400)).toBe(350);
    expect(mapSourceLineToPreviewScroll(SET, 999, 400)).toBe(350);
    // 视口比内容还高 → 只能停在 0
    expect(mapSourceLineToPreviewScroll(SET, 16, 1000)).toBe(0);
  });

  it("totalHeight 为 0（预览未布局）→ 恒为 0，不产生 NaN", () => {
    const set: PreviewAnchorSet = { ...SET, totalHeight: 0 };
    for (const line of [-1, 0, 8.5, 999]) {
      const v = mapSourceLineToPreviewScroll(set, line, 400);
      expect(v).toBe(0);
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("数据不可用（空锚集 / 非有限 top 或 height）→ null，让调用方退回百分比", () => {
    expect(mapSourceLineToPreviewScroll({ ...SET, lines: [] }, 3, 400)).toBeNull();
    expect(
      mapSourceLineToPreviewScroll({ ...SET, heights: [Number.NaN, 200, 300, 150] }, 0, 400),
    ).toBeNull();
    expect(
      mapSourceLineToPreviewScroll({ ...SET, tops: [0, Number.POSITIVE_INFINITY, 300, 600] }, 5, 400),
    ).toBeNull();
  });
});

// ═══════════════ mapPreviewScrollToSourceLine：右 → 左 ═══════════════

describe("需求8 · mapPreviewScrollToSourceLine：预览 scrollTop → 源码行", () => {
  it("块内线性反算（含块边界归属：scrollTop 恰等于 top 时归下一块）", () => {
    expect(mapPreviewScrollToSourceLine(SET, 0)).toBe(0);
    expect(mapPreviewScrollToSourceLine(SET, 50)).toBeCloseTo(2.5, 10);
    expect(mapPreviewScrollToSourceLine(SET, 100)).toBe(5);
    expect(mapPreviewScrollToSourceLine(SET, 200)).toBeCloseTo(8.5, 10);
    expect(mapPreviewScrollToSourceLine(SET, 300)).toBe(12);
    expect(mapPreviewScrollToSourceLine(SET, 450)).toBeCloseTo(16, 10);
    expect(mapPreviewScrollToSourceLine(SET, 600)).toBe(20);
    expect(mapPreviewScrollToSourceLine(SET, 700)).toBeCloseTo(20 + 100 / 150, 10);
  });

  it("滚过头 / 负 scrollTop → 夹紧到文档首尾（不返回越界行）", () => {
    expect(mapPreviewScrollToSourceLine(SET, 9999)).toBe(21);
    expect(mapPreviewScrollToSourceLine(SET, -50)).toBe(0);
  });

  it("单调：scrollTop 增大 → 源码行非减", () => {
    let prev = -Infinity;
    for (let top = -50; top <= 900; top += 5) {
      const v = mapPreviewScrollToSourceLine(SET, top)!;
      expect(v).not.toBeNull();
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it("与左→右互为逆映射：round-trip 误差 ≤ 1e-6 行（允许实现层的 0 行容差）", () => {
    for (let line = 0; line <= 21; line += 0.25) {
      const scroll = mapSourceLineToPreviewScroll(SET, line, 0)!;
      const back = mapPreviewScrollToSourceLine(SET, scroll)!;
      expect(Math.abs(back - line)).toBeLessThan(1e-6);
    }
  });

  it("0 高度块：不除零、不产生 NaN（比例兜底为 0）", () => {
    const set: PreviewAnchorSet = {
      lines: [0, 5, 10],
      tops: [0, 100, 250],
      heights: [100, 0, 150],
      totalHeight: 400,
    };
    const atZeroHeight = mapPreviewScrollToSourceLine(set, 100);
    expect(atZeroHeight).toBe(5);
    expect(Number.isFinite(atZeroHeight!)).toBe(true);
    // 该块之后仍能正常定位
    expect(mapPreviewScrollToSourceLine(set, 250)).toBe(10);
    expect(mapPreviewScrollToSourceLine(set, 400)).toBe(11);
  });

  it("数据不可用（空锚集 / 非有限 scrollTop / 非有限 top）→ null", () => {
    expect(mapPreviewScrollToSourceLine({ ...SET, lines: [] }, 0)).toBeNull();
    expect(mapPreviewScrollToSourceLine(SET, Number.NaN)).toBeNull();
    expect(mapPreviewScrollToSourceLine(SET, Number.POSITIVE_INFINITY)).toBeNull();
    expect(
      mapPreviewScrollToSourceLine({ ...SET, tops: [Number.NaN, 100, 300, 600] }, 0),
    ).toBeNull();
  });
});

// ═══════════════ mapSourceLineToScrollTop：源码行 → textarea ═══════════════

describe("需求8 · mapSourceLineToScrollTop：源码行 → 左屏 textarea scrollTop", () => {
  const metrics: SourceViewportMetrics = {
    scrollTop: 0,
    scrollHeight: 2100,
    clientHeight: 100,
    totalSourceLines: 101,
  };

  it("行号与滚动位置线性对应（total=101 → 可滚动 2000px / 100 行距）", () => {
    expect(mapSourceLineToScrollTop(metrics, 0)).toBe(0);
    expect(mapSourceLineToScrollTop(metrics, 50)).toBe(1000);
    expect(mapSourceLineToScrollTop(metrics, 100)).toBe(2000);
    expect(mapSourceLineToScrollTop(metrics, 37)).toBe(740);
  });

  it("越界行号钳到首尾", () => {
    expect(mapSourceLineToScrollTop(metrics, -10)).toBe(0);
    expect(mapSourceLineToScrollTop(metrics, 200)).toBe(2000);
    expect(mapSourceLineToScrollTop(metrics, Number.POSITIVE_INFINITY)).toBe(2000);
  });

  it("是 estimateTopSourceLine 的逆运算（往返回到同一行）", () => {
    for (const line of [0, 12.5, 37, 80.25, 100]) {
      const scrollTop = mapSourceLineToScrollTop(metrics, line)!;
      expect(estimateTopSourceLine({ ...metrics, scrollTop })).toBeCloseTo(line, 10);
    }
  });

  it("单行/空文档/不足一屏 → 0（不产生 NaN）", () => {
    expect(mapSourceLineToScrollTop({ ...metrics, totalSourceLines: 1 }, 5)).toBe(0);
    expect(mapSourceLineToScrollTop({ ...metrics, totalSourceLines: 0 }, 5)).toBe(0);
    expect(
      mapSourceLineToScrollTop({ ...metrics, scrollHeight: 100, clientHeight: 100 }, 50),
    ).toBe(0);
  });

  it("非有限行号（NaN）→ null（调用方不写滚动位置）", () => {
    expect(mapSourceLineToScrollTop(metrics, Number.NaN)).toBeNull();
  });
});

// ═══════════════ 双向联动的端到端（纯数学链路） ═══════════════

describe("需求8 · 端到端：左屏滚动 → 右屏 → 回推左屏，位置不漂移", () => {
  const metrics: SourceViewportMetrics = {
    scrollTop: 0,
    scrollHeight: 2100,
    clientHeight: 100,
    totalSourceLines: 101,
  };

  it("锚点覆盖范围内，任取左屏位置经右→左回算后与原始 scrollTop 一致（±1px）", () => {
    // 锚点覆盖源码行 0..21（→ textarea scrollTop 0..420）；超出末锚点的位置
    // 两个方向都会夹紧到文档末尾（见下一条），因此这里只在有效区间内验证不漂移。
    for (const scrollTop of [0, 170, 300, 420]) {
      // 左 → 右：当前左屏顶部行 → 预览 scrollTop
      const line = estimateTopSourceLine({ ...metrics, scrollTop });
      const previewTop = mapSourceLineToPreviewScroll(SET, line, 0)!;
      // 右 → 左：预览 scrollTop → 行 → textarea scrollTop
      const backLine = mapPreviewScrollToSourceLine(SET, previewTop)!;
      const backTop = mapSourceLineToScrollTop(metrics, backLine)!;
      expect(Math.abs(backTop - scrollTop)).toBeLessThanOrEqual(1);
    }
  });

  it("超出末锚点：两侧都夹紧在文档末尾（右侧没有更多内容可对齐）", () => {
    // 源码行 50/100 都超出最后锚点行 20 → 预览停在内容底 750
    expect(mapSourceLineToPreviewScroll(SET, 50, 0)).toBe(750);
    expect(mapSourceLineToPreviewScroll(SET, 100, 0)).toBe(750);
    // 反算给出末块的最后一行（不是原始行号）——这是"预览比源码短"的固有上限
    expect(mapPreviewScrollToSourceLine(SET, 750)).toBe(21);
    expect(mapSourceLineToScrollTop(metrics, 100)).toBe(2000);
  });

  it("块高差异极大时仍对齐到同一块（3 行 mermaid 源码 ↔ 400px 图）", () => {
    // 第二个块（源码行 5..12，共 7 行）在右侧被渲染成 400px 高
    const skewed: PreviewAnchorSet = {
      lines: [0, 5, 12, 20],
      tops: [0, 100, 500, 800],
      heights: [100, 400, 300, 150],
      totalHeight: 950,
    };
    // 源码行 8.5（第二个块中间）→ 右侧应在第二个块中间（300px 处），而不是按总比例乱跳
    const previewTop = mapSourceLineToPreviewScroll(skewed, 8.5, 0)!;
    expect(previewTop).toBe(300);
    // 反算仍落回同一行
    expect(mapPreviewScrollToSourceLine(skewed, previewTop)).toBeCloseTo(8.5, 10);
  });
});

// ═══════════════ 接线：双向共用同一份锚点采集（jsdom 观测不到事件时序） ═══════════════

describe("需求8 · 接线契约：两方向共用 collectAnchors 且各自写自己的容器", () => {
  // 分屏联动发生在真实 EditorContainer effect 里，依赖 iframe 文档与实际滚动事件；
  // jsdom 的 iframe contentDocument 不参与布局，行为断言会空过。映射数学已在上方精确覆盖。
  const src = readFileSync("src/components/editor/EditorContainer.tsx", "utf-8");

  function fnBody(startMarker: string, endMarker: string): string {
    const at = src.indexOf(startMarker);
    expect(at).toBeGreaterThan(-1);
    const end = src.indexOf(endMarker, at);
    expect(end).toBeGreaterThan(at);
    return src.slice(at, end);
  }

  it("syncToPreview 与 syncToSource 都从同一份 collectAnchors 取锚点", () => {
    const previewFn = fnBody("const syncToPreview = () =>", "const syncToSource = () =>");
    const sourceFn = fnBody("const syncToSource = () =>", 'textarea.addEventListener("scroll", syncToPreview');
    expect(previewFn).toContain("collectAnchors()");
    expect(sourceFn).toContain("collectAnchors()");
    // 采集函数把视口坐标换算回内容坐标（scrollTop 也在内容坐标系）。
    // 注意：根元素 rect.top 恒等于 -scrollTop，**不能**再减它，否则锚点虚高。
    expect(src).toContain("tops.push(rect.top + preview.scrollTop);");
    expect(src).not.toContain("rect.top - previewRectTop + preview.scrollTop");
  });

  it("方向锁在两侧都先检查再登记（异步 scroll 回声不会把另一侧反推回去）", () => {
    const previewFn = fnBody("const syncToPreview = () =>", "const syncToSource = () =>");
    const sourceFn = fnBody("const syncToSource = () =>", 'textarea.addEventListener("scroll", syncToPreview');
    // 两道防线：方向锁（跨帧回声）+ isSyncingScrollRef（同调用栈重入）
    expect(previewFn).toContain('shouldAcceptScroll(lock, "source"');
    expect(previewFn).toContain('markScrollSource(lock, "source"');
    expect(sourceFn).toContain('shouldAcceptScroll(lock, "preview"');
    expect(sourceFn).toContain('markScrollSource(lock, "preview"');
    for (const fn of [previewFn, sourceFn]) {
      expect(fn).toContain("if (isSyncingScrollRef.current) return;");
      expect(fn).toContain("isSyncingScrollRef.current = true;");
      expect(fn).toContain("isSyncingScrollRef.current = false;");
    }
    // 两个方向写的是各自的容器，不共用滚动条
    expect(previewFn).toContain("preview.scrollTop = next;");
    expect(sourceFn).toContain("textarea.scrollTop = top;");
  });

  it("每次同步都现取预览滚动容器（完整重写会换掉 documentElement）", () => {
    expect(src).toContain("const getPreviewScroller = (): HTMLElement | null =>");
    expect(src).toContain("d?.scrollingElement ?? d?.documentElement ?? d?.body");
    // collectAnchors 与写入路径都必须经由 getPreviewScroller，不能缓存 preview 引用
    expect(src).toContain("const preview = getPreviewScroller();");
    expect(src).not.toContain("const preview = previewDoc?.documentElement");
  });
});

// ═══════════════ 方向锁：异步 scroll 回声不会反推（v0.13.2 返修） ═══════════════

describe("需求8 返修 · 滚动方向锁", () => {
  it("初始为空锁：两侧都能发起同步", () => {
    const lock = createScrollDirectionLock();
    expect(lock.active).toBeNull();
    expect(shouldAcceptScroll(lock, "source", 0)).toBe(true);
    expect(shouldAcceptScroll(lock, "preview", 0)).toBe(true);
  });

  it("左屏发起后 250ms 内：右屏（程序写入的回声）被忽略，左屏后续滚动仍接受", () => {
    const lock = createScrollDirectionLock();
    markScrollSource(lock, "source", 1000);
    expect(lock.active).toBe("source");
    expect(lock.until).toBe(1000 + SPLIT_SCROLL_LOCK_MS);
    // 右屏回声（下一帧）→ 忽略
    expect(shouldAcceptScroll(lock, "preview", 1020)).toBe(false);
    // 用户继续滚左屏 → 接受（并可在调用处续期）
    expect(shouldAcceptScroll(lock, "source", 1100)).toBe(true);
    // 锁过期后用户改滚右屏 → 接受
    expect(shouldAcceptScroll(lock, "preview", 1260)).toBe(true);
  });

  it("右屏发起后同理：左屏回声被忽略", () => {
    const lock = createScrollDirectionLock();
    markScrollSource(lock, "preview", 5000);
    expect(shouldAcceptScroll(lock, "source", 5010)).toBe(false);
    expect(shouldAcceptScroll(lock, "preview", 5100)).toBe(true);
    expect(shouldAcceptScroll(lock, "source", 5000 + SPLIT_SCROLL_LOCK_MS + 1)).toBe(true);
  });

  it("续期：同一侧连续滚动会不断把窗口往后推", () => {
    const lock = createScrollDirectionLock();
    markScrollSource(lock, "source", 1000);
    const firstUntil = lock.until;
    markScrollSource(lock, "source", 1150);
    expect(lock.until).toBeGreaterThan(firstUntil);
    // 原窗口刚过、续期窗口内，右屏回声仍被忽略
    expect(shouldAcceptScroll(lock, "preview", firstUntil + 10)).toBe(false);
  });

  it("reset 后回到初始状态（effect 清理 / 模式切换）", () => {
    const lock = createScrollDirectionLock();
    markScrollSource(lock, "preview", 1);
    resetScrollDirectionLock(lock);
    expect(lock).toEqual({ active: null, until: 0 });
    expect(shouldAcceptScroll(lock, "source", 2)).toBe(true);
  });

  it("非法 now 不制造 NaN 死锁（按可接受处理）", () => {
    const lock = createScrollDirectionLock();
    expect(shouldAcceptScroll(lock, "source", Number.NaN)).toBe(true);
    expect(shouldAcceptScroll(lock, "preview", Number.NaN)).toBe(true);
  });
});
