// @vitest-environment jsdom
/**
 * v0.17.0 第二轮 #8：模式切换「内容锚点」往返一致性（纯函数层护栏）。
 *
 * ## 缺陷背景
 * 用户报告：「阅读模式和编辑模式多次切换，文档的阅读进度会不断变化。」
 * 实测根因（`scripts/v0170-r2-mode-roundtrip.mjs`）：**编辑→阅读方向的内容锚点在 CM6 下
 * 恒为 null**（`captureSourceContentAnchor` 读的是中性宿主 div 的几何：
 * `scrollTop≡0`、`scrollHeight===clientHeight` → `maxScroll=0` → 直接返回 null）
 * → 该方向只能退回百分比 → 两种排版百分比不等价 → **每轮累积漂移**。
 *
 * ## 本测试锁什么
 * 1. `captureContentAnchor` 的**几何退化契约**：`maxScroll=0`（内容不足一屏）→ null。
 *    这正是 bug 的入口 —— 记牢"哪些输入会产生 null"，防止有人把"null 就退回百分比"
 *    这条兜底当成正常路径而放弃修几何源。
 * 2. **往返恒等**：同一份几何下 capture → restore → capture 必须收敛（漂移 0）。
 * 3. **跨排版往返有界**：两种不同块高分布（模拟阅读 vs 源码）之间往返 N 轮，
 *    锚点（blockIndex）不得单调漂移 —— 这是"百分比有损、锚点无损"的核心差异。
 *
 * ⚠️ 本测试**不**碰 DOM：几何是喂进去的纯数据。真实采集链路由
 * `scripts/v0170-r2-mode-roundtrip.mjs` 在浏览器里验（含 `cap-source.ok` 埋点）。
 */
import { describe, expect, it } from "vitest";
import {
  captureContentAnchor,
  restoreContentAnchor,
  type BlockGeometry,
} from "../utils/contentScrollMap";

/** 造一份块几何：等块高 + 等间隙（模拟"排版规整"的一面） */
function makeBlocks(n: number, height: number, gap: number): BlockGeometry[] {
  const out: BlockGeometry[] = [];
  let top = 0;
  for (let i = 0; i < n; i++) {
    out.push({ index: i, top, height, visible: true, sourceLine: i * 2 });
    top += height + gap;
  }
  return out;
}

/** 内容总高（与 `makeBlocks` 同口径） */
function contentHeightOf(blocks: BlockGeometry[]): number {
  const last = blocks[blocks.length - 1];
  return last ? last.top + last.height : 0;
}

/** 阅读面：块高较大（段落渲染 + 行高） */
const READER = makeBlocks(60, 73, 0);
/** 源码面：块高较小 + 块间空行间隙（markdown 源码的行数口径） */
const SOURCE = makeBlocks(60, 52, 9);
const VIEWPORT = 759;

describe("#8 captureContentAnchor 的几何退化契约（bug 的入口形状）", () => {
  it("★ maxScroll=0（scrollHeight === clientHeight，正是 CM6 宿主 div 的几何）→ 返回 null", () => {
    // CM6 中性宿主 div：scrollHeight === clientHeight === 759、scrollTop ≡ 0。
    // 这条断言把"为什么编辑→阅读方向恒无锚点"钉死成可执行规格。
    const anchor = captureContentAnchor(READER, 0, 759, { contentHeight: 759 });
    expect(anchor).toBeNull();
  });

  it("scrollHeight 小于 clientHeight（内容不足一屏）→ 同样 null", () => {
    expect(captureContentAnchor(READER, 0, 760, { contentHeight: 700 })).toBeNull();
  });

  it("viewportHeight 为 0（元素隐藏/未布局）→ null", () => {
    expect(captureContentAnchor(READER, 0, 0, { contentHeight: contentHeightOf(READER) })).toBeNull();
  });

  it("viewportTop 非有限 → null（不让 NaN 传播到 restore）", () => {
    expect(captureContentAnchor(READER, Number.NaN, VIEWPORT, { contentHeight: contentHeightOf(READER) })).toBeNull();
    expect(captureContentAnchor(READER, Infinity, VIEWPORT, { contentHeight: contentHeightOf(READER) })).toBeNull();
  });

  it("blocks 为空数组 → null", () => {
    expect(captureContentAnchor([], 0, VIEWPORT, { contentHeight: 5000 })).toBeNull();
  });

  it("正常几何 → 返回锚点（回归护栏：不要把 null 当常态）", () => {
    const anchor = captureContentAnchor(READER, 1803, VIEWPORT, { contentHeight: contentHeightOf(READER) });
    expect(anchor).not.toBeNull();
    expect(anchor!.blockIndex).toBeGreaterThan(0);
    expect(anchor!.ratioWithinBlock).toBeGreaterThanOrEqual(0);
    expect(anchor!.ratioWithinBlock).toBeLessThanOrEqual(1);
  });
});

describe("#8 往返恒等：同一份几何下 capture → restore → capture 不漂移", () => {
  it("★ 同一几何往返 10 轮，锚点完全不变（这是「锚点无损」的定义）", () => {
    const total = contentHeightOf(READER);
    let top = 1803;
    const seen: number[] = [];
    for (let i = 0; i < 10; i++) {
      const anchor = captureContentAnchor(READER, top, VIEWPORT, { contentHeight: total });
      expect(anchor).not.toBeNull();
      const back = restoreContentAnchor(READER, anchor, VIEWPORT, { contentHeight: total });
      expect(back).not.toBeNull();
      seen.push(anchor!.blockIndex);
      top = back!;
    }
    // 10 轮后中心块必须是同一个
    expect(new Set(seen).size).toBe(1);
    // 绝对像素也必须收敛（容差 1px，浮点乘除）
    expect(Math.abs(top - 1803)).toBeLessThanOrEqual(1);
  });

  it("贴顶标志：atTop 恢复恒为 0", () => {
    const total = contentHeightOf(READER);
    const anchor = captureContentAnchor(READER, 0, VIEWPORT, { contentHeight: total });
    expect(anchor?.atTop).toBe(true);
    expect(restoreContentAnchor(READER, anchor, VIEWPORT, { contentHeight: total })).toBe(0);
  });

  it("贴底标志：atBottom 恢复恒为可滚动上限", () => {
    const total = contentHeightOf(READER);
    const maxScroll = total - VIEWPORT;
    const anchor = captureContentAnchor(READER, maxScroll, VIEWPORT, { contentHeight: total });
    expect(anchor?.atBottom).toBe(true);
    expect(restoreContentAnchor(READER, anchor, VIEWPORT, { contentHeight: total })).toBe(maxScroll);
  });
});

describe("#8 跨排版往返：锚点有界，百分比有损（缺陷对照）", () => {
  /** 用锚点在两份不同排版几何间往返 N 轮 */
  function roundTripWithAnchor(from: BlockGeometry[], to: BlockGeometry[], startTop: number, rounds: number) {
    const fromH = contentHeightOf(from);
    const toH = contentHeightOf(to);
    let top = startTop;
    const centers: number[] = [];
    for (let i = 0; i < rounds; i++) {
      const a1 = captureContentAnchor(from, top, VIEWPORT, { contentHeight: fromH });
      if (!a1) throw new Error("capture(from) 不可为 null");
      centers.push(a1.blockIndex);
      const toTop = restoreContentAnchor(to, a1, VIEWPORT, { contentHeight: toH });
      if (toTop === null) throw new Error("restore(to) 不可为 null");
      const a2 = captureContentAnchor(to, toTop, VIEWPORT, { contentHeight: toH });
      if (!a2) throw new Error("capture(to) 不可为 null");
      const back = restoreContentAnchor(from, a2, VIEWPORT, { contentHeight: fromH });
      if (back === null) throw new Error("restore(from) 不可为 null");
      top = back;
    }
    return { centers, endTop: top };
  }

  /** 用百分比在两份不同排版几何间往返（模拟"锚点恒 null 时"的退化路径） */
  function roundTripWithPercent(from: BlockGeometry[], to: BlockGeometry[], startTop: number, rounds: number) {
    const fromMax = contentHeightOf(from) - VIEWPORT;
    const toMax = contentHeightOf(to) - VIEWPORT;
    let top = startTop;
    const centers: number[] = [];
    for (let i = 0; i < rounds; i++) {
      // 中心块（用于比对）
      const a = captureContentAnchor(from, top, VIEWPORT, { contentHeight: contentHeightOf(from) });
      centers.push(a ? a.blockIndex : -1);
      const pct = top / fromMax;
      const toTop = pct * toMax;
      const pct2 = toTop / toMax;
      top = pct2 * fromMax;
    }
    return { centers, endTop: top };
  }

  it("★ 用锚点：阅读↔源码往返 10 轮，中心块漂移 ≤1", () => {
    const start = Math.round((contentHeightOf(READER) - VIEWPORT) * 0.5);
    const { centers, endTop } = roundTripWithAnchor(READER, SOURCE, start, 10);
    const drift = Math.abs(centers[centers.length - 1] - centers[0]);
    expect(drift).toBeLessThanOrEqual(1);
    // 绝对位置也应基本不变（排版不同 → 允许同块内比例差，但不应单调累积）
    expect(Math.abs(endTop - start)).toBeLessThan(120);
  });

  it("★ 对照：只用百分比，同一往返会漂移（证明锚点恒 null、退回百分比就是 bug）", () => {
    const start = Math.round((contentHeightOf(READER) - VIEWPORT) * 0.5);
    const anchored = roundTripWithAnchor(READER, SOURCE, start, 10);
    const percent = roundTripWithPercent(READER, SOURCE, start, 10);
    // 百分比路径的末态偏离应大于锚点路径（这就是用户看到的"越切越偏"）
    const anchorDrift = Math.abs(anchored.endTop - start);
    const percentDrift = Math.abs(percent.endTop - start);
    expect(percentDrift).toBeGreaterThan(anchorDrift);
  });

  it("锚点路径不会单调同向累积（逐轮中心块不得单向前进 3 段以上）", () => {
    const start = Math.round((contentHeightOf(READER) - VIEWPORT) * 0.5);
    const { centers } = roundTripWithAnchor(READER, SOURCE, start, 10);
    const first = centers[0];
    const last = centers[centers.length - 1];
    expect(Math.abs(last - first)).toBeLessThanOrEqual(1);
  });
});

describe("#8 恢复契约：无法映射必须 null，绝不 0 兜底", () => {
  it("anchor 为 null → null", () => {
    expect(restoreContentAnchor(READER, null, VIEWPORT, { contentHeight: contentHeightOf(READER) })).toBeNull();
    expect(restoreContentAnchor(READER, undefined, VIEWPORT, { contentHeight: contentHeightOf(READER) })).toBeNull();
  });

  it("blocks 为空 → null", () => {
    const anchor = { blockIndex: 3, ratioWithinBlock: 0.5 };
    expect(restoreContentAnchor([], anchor, VIEWPORT, { contentHeight: 5000 })).toBeNull();
  });

  it("viewportHeight 为 0 → null（不要在隐藏面上写 scrollTop=0）", () => {
    const anchor = { blockIndex: 3, ratioWithinBlock: 0.5 };
    expect(restoreContentAnchor(READER, anchor, 0, { contentHeight: contentHeightOf(READER) })).toBeNull();
  });

  it("★ blockIndex 越界（目标侧块数不同）→ 不返回 0，要么纠偏要么 null", () => {
    // 目标侧只有 10 块（但总高仍 > 视口，保证"内容不足一屏"分支不干扰本用例），
    // 锚点却指向第 50 块 —— 这是"两侧块数不一致"的真实场景（§4-34 的 429 vs 303）
    const small = makeBlocks(10, 300, 0);
    expect(contentHeightOf(small)).toBeGreaterThan(VIEWPORT);
    // sourceLine 也给一个越界的，逼它走"纠偏失败"分支
    const anchor = { blockIndex: 50, ratioWithinBlock: 0.5, sourceLine: 500 };
    const r = restoreContentAnchor(small, anchor, VIEWPORT, { contentHeight: contentHeightOf(small) });
    // 关键契约：**绝不能**是 0（0 会让用户直接掉回文档顶部）
    if (r !== null) expect(r).toBeGreaterThan(0);
  });
});
