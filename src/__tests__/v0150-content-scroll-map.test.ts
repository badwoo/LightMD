// @vitest-environment jsdom
/**
 * v0.15.0 需求7（R7a）：共享内容锚点映射 `utils/contentScrollMap.ts`。
 *
 * ## 本文件锁的是什么
 * 设计稿 §3.1 的验收语义是「切换后**同一个顶层块/标题**仍落在目标视口中央邻域」，
 * 并明确**禁止用"百分比一致"作为通过条件**。因此这里的断言全部是**内容几何**断言：
 * 采集 → 恢复 → 反查"目标滚动位置下视口中央是哪一块/块内比例"，必须回到同一处。
 *
 * ## 覆盖矩阵（设计稿 §3.5）
 * - 块类型：普通段落 / 超长软换行（多视觉行，块高远大于其它块 → 按实测轴而非线性）/
 *   代码块 / 表格 / 图片 / 嵌套列表 / 文末空行；
 * - 位置：顶部 / 50% / 底部往返；
 * - 折叠：`visible:false` 跳过、落到最近可见祖先标题、无祖先标题退最近可见块；
 * - 失败：无法映射返回 **null**（绝不返回 0 兜底 —— 这是"进度归零"缺陷的门禁）。
 *
 * 纯函数无 DOM 依赖：本文件不需要 jsdom 也能跑（头注释保留 jsdom 是为与仓库里
 * 其它 v01xx 测试的文件级约定一致，且能覆盖 `contentHeightOf` 在真实 DOM 下的口径）。
 */
import { describe, expect, it } from "vitest";
import {
  CONTENT_ANCHOR_EDGE_TOLERANCE_PX,
  blockGeometryFromLineAxis,
  captureContentAnchor,
  contentHeightOf,
  findBlockAtY,
  findNearestVisible,
  findVisibleAncestorHeading,
  resolveAnchorBlock,
  restoreContentAnchor,
  visibleBlocksOf,
  visibleHeadingChain,
  type BlockGeometry,
  type ContentAnchor,
} from "../utils/contentScrollMap";
import { clamp, maxScrollOf } from "../utils/blockScrollAlign";

// ═══════════════════════ 构造块几何的助手 ═══════════════════════

/**
 * 按"块高列表"顺序铺排块（`top` 由累加得出），模拟真实文档的内容坐标系。
 *
 * @param heights 各块高度；传 `null` 表示该块被折叠（`visible:false`，且**不占空间**）
 */
function layout(
  heights: Array<number | null>,
  extra?: (index: number) => Partial<BlockGeometry>,
): BlockGeometry[] {
  const out: BlockGeometry[] = [];
  let top = 0;
  for (let i = 0; i < heights.length; i++) {
    const h = heights[i];
    if (h === null) {
      // 被折叠（display:none）的块不占空间：top 仍记原位，height 0，visible false
      out.push({ index: i, top, height: 0, visible: false, ...(extra?.(i) ?? {}) });
      continue;
    }
    out.push({ index: i, top, height: h, visible: true, ...(extra?.(i) ?? {}) });
    top += h;
  }
  return out;
}

/** 给**指定下标**的块加标题身份（headingId / headingLevel / 源码行） */
function headingAt(index: number, id: string, level: number, line?: number) {
  return (i: number): Partial<BlockGeometry> =>
    i === index
      ? { headingId: id, headingLevel: level, ...(line === undefined ? {} : { sourceLine: line }) }
      : {};
}

/** 令第 index 块带源码行 */
function withSourceLine(...pairs: Array<[number, number]>) {
  const map = new Map(pairs);
  return (index: number): Partial<BlockGeometry> =>
    map.has(index) ? { sourceLine: map.get(index) } : {};
}

/** 合并多个 extra 工厂 */
function extras(
  ...fns: Array<((index: number) => Partial<BlockGeometry>) | undefined>
) {
  return (index: number): Partial<BlockGeometry> => {
    let acc: Partial<BlockGeometry> = {};
    for (const fn of fns) if (fn) acc = { ...acc, ...fn(index) };
    return acc;
  };
}

/** 反查：某 `scrollTop` 下视口中央落在哪一块、块内比例（模拟"用户眼前是什么"） */
function centerOf(blocks: BlockGeometry[], scrollTop: number, viewportHeight: number) {
  return findBlockAtY(blocks, scrollTop + viewportHeight / 2)!;
}

/** 往返一次（用同一份几何，即"切过去又切回来"的理想情形） */
function roundTrip(
  blocks: BlockGeometry[],
  scrollTop: number,
  viewportHeight: number,
  opts?: Parameters<typeof captureContentAnchor>[3],
): number | null {
  const anchor = captureContentAnchor(blocks, scrollTop, viewportHeight, opts);
  if (!anchor) return null;
  return restoreContentAnchor(blocks, anchor, viewportHeight, {
    contentHeight: opts?.contentHeight,
  });
}

const VIEWPORT = 800;

// ═══════════ ① 块类型 × 顶部 / 50% / 底部往返 ═══════════
//
// 一份"混合排版"文档：普通段落、超长软换行段落（块高 1200，是其它块的十几倍）、
// 代码块、表格、图片、嵌套列表、文末空行（末块之后的尾部空白）。
// 这是设计稿 §3.5 的测试矩阵本体：**不允许**用百分比换算（那样长软换行块必错）。
const MIXED: BlockGeometry[] = (() => {
  const blocks = layout(
    // 0 标题(h1) / 1 普通段落 / 2 超长软换行段落 / 3 代码块 / 4 表格 / 5 图片 / 6 嵌套列表 / 7 收尾段落
    [120, 260, 1200, 480, 640, 520, 380, 200],
    extras(
      headingAt(0, "sec-intro", 1, 0),
      (i) => (i === 2 ? { sourceLine: 40 } : {}),
    ),
  );
  return blocks;
})();
/** 文末空行区域：最后一块底部之后还有 300px（预览吞掉空行，但滚动内容真的有这么高） */
const MIXED_CONTENT_HEIGHT = contentHeightOf(MIXED) + 300;

describe("需求7 · 混合排版（段落/软换行/代码/表格/图片/嵌套列表/文末空行）", () => {
  it("顶部往返：贴顶采集 → 恢复 = 0（贴顶专用分支，不按中央硬套）", () => {
    const anchor = captureContentAnchor(MIXED, 0, VIEWPORT, {
      contentHeight: MIXED_CONTENT_HEIGHT,
    })!;
    expect(anchor.atTop).toBe(true);
    expect(anchor.atBottom).toBe(false);
    expect(restoreContentAnchor(MIXED, anchor, VIEWPORT, {
      contentHeight: MIXED_CONTENT_HEIGHT,
    })).toBe(0);
  });

  it("50% 往返：同一块、同一块内比例（中央内容不漂）", () => {
    const scrollTop = (MIXED_CONTENT_HEIGHT - VIEWPORT) / 2;
    const before = centerOf(MIXED, scrollTop, VIEWPORT);
    const after = roundTrip(MIXED, scrollTop, VIEWPORT, {
      contentHeight: MIXED_CONTENT_HEIGHT,
    })!;
    const now = centerOf(MIXED, after, VIEWPORT);
    expect(now.block.index).toBe(before.block.index);
    expect(now.ratio).toBeCloseTo(before.ratio, 2);
    // 中央内容点的误差必须在亚像素级（同几何往返应恒等）
    expect(Math.abs(after - scrollTop)).toBeLessThan(0.5);
  });

  it("底部往返：贴底采集 → 恢复 = 可滚动上限（文末空行不被吞掉进度）", () => {
    const maxScroll = MIXED_CONTENT_HEIGHT - VIEWPORT;
    const anchor = captureContentAnchor(MIXED, maxScroll, VIEWPORT, {
      contentHeight: MIXED_CONTENT_HEIGHT,
    })!;
    expect(anchor.atBottom).toBe(true);
    expect(restoreContentAnchor(MIXED, anchor, VIEWPORT, {
      contentHeight: MIXED_CONTENT_HEIGHT,
    })).toBe(maxScroll);
  });

  it("超长软换行块（高 1200）内往返：按实测几何，不用线性/百分比估算", () => {
    // 在大块内部取多个位置：块 tops = 120+260 = 380，块底 380+1200 = 1580
    const tall = MIXED[2];
    expect(tall.height).toBe(1200);
    for (const ratio of [0.1, 0.5, 0.9]) {
      const contentPoint = tall.top + ratio * tall.height;
      const scrollTop = contentPoint - VIEWPORT / 2;
      const after = roundTrip(MIXED, scrollTop, VIEWPORT, {
        contentHeight: MIXED_CONTENT_HEIGHT,
      })!;
      expect(Math.abs(after - scrollTop)).toBeLessThan(0.5);
      const now = centerOf(MIXED, after, VIEWPORT);
      expect(now.block.index).toBe(2);
      expect(now.ratio).toBeCloseTo(ratio, 3);
    }
  });

  it("代码块/表格/图片/嵌套列表各自内部往返都不漂", () => {
    for (const index of [3, 4, 5, 6]) {
      const block = MIXED[index];
      const scrollTop = block.top + block.height / 2 - VIEWPORT / 2;
      const after = roundTrip(MIXED, scrollTop, VIEWPORT, {
        contentHeight: MIXED_CONTENT_HEIGHT,
      })!;
      const now = centerOf(MIXED, after, VIEWPORT);
      expect(now.block.index, `块 ${index} 往返后中央块`).toBe(index);
      expect(now.ratio, `块 ${index} 往返后块内比例`).toBeCloseTo(0.5, 2);
    }
  });

  it("单块即可滚动（无块边界）时也不崩：比例往返恒等", () => {
    const one = layout([3000]);
    const scrollTop = 900;
    const after = roundTrip(one, scrollTop, VIEWPORT)!;
    expect(after).toBeCloseTo(scrollTop, 6);
  });
});

// ═══════════ ② 往返序列：阅读→编辑→阅读 ≥5 次无累计漂移 ═══════════

describe("需求7 · 多轮往返不累计漂移（设计稿 §3.5 的 ≥5 次）", () => {
  it("同一锚点连续恢复 5 次结果稳定（幂等，不逐次放大）", () => {
    const scrollTop = 2200;
    const anchor = captureContentAnchor(MIXED, scrollTop, VIEWPORT, {
      contentHeight: MIXED_CONTENT_HEIGHT,
    })!;
    const opts = { contentHeight: MIXED_CONTENT_HEIGHT };
    let prev = restoreContentAnchor(MIXED, anchor, VIEWPORT, opts)!;
    for (let i = 0; i < 5; i++) {
      const next = restoreContentAnchor(MIXED, anchor, VIEWPORT, opts)!;
      expect(next).toBe(prev);
      prev = next;
    }
  });

  it("把每轮恢复后的位置重新采集再恢复：5 轮后误差 < 1px", () => {
    const opts = { contentHeight: MIXED_CONTENT_HEIGHT };
    let cur = 3100;
    for (let i = 0; i < 5; i++) {
      const anchor = captureContentAnchor(MIXED, cur, VIEWPORT, opts)!;
      cur = restoreContentAnchor(MIXED, anchor, VIEWPORT, opts)!;
    }
    expect(Math.abs(cur - 3100)).toBeLessThan(1);
  });
});

// ═══════════ ③ 折叠支持 ═══════════

describe("需求7 · 折叠：visible=false 跳过、落到最近可见祖先标题", () => {
  /**
   * 折叠文档：
   *   0 h1「装」
   *   1 段落
   *   2 h2「节A」(id=sec-a)
   *   3 段落（被折叠隐藏）
   *   4 代码块（被折叠隐藏）
   *   5 h2「节B」(id=sec-b)
   *   6 表格
   *   7 收尾段落
   * 折叠 sec-a 后 3/4 不可见且不占空间（height 0），5 的 top 前移到 2 的底部。
   */
  const FOLDED: BlockGeometry[] = (() => {
    const raw = [
      { h: 120, id: "sec-0", level: 1 },
      { h: 260 },
      { h: 120, id: "sec-a", level: 2 },
      { h: 300, hidden: true },
      { h: 400, hidden: true },
      { h: 120, id: "sec-b", level: 2 },
      { h: 540 },
      { h: 210 },
    ];
    const out: BlockGeometry[] = [];
    let top = 0;
    raw.forEach((r, i) => {
      if (r.hidden) {
        out.push({ index: i, top, height: 0, visible: false });
        return;
      }
      const b: BlockGeometry = { index: i, top, height: r.h, visible: true };
      if (r.id) b.headingId = r.id;
      if (r.level) b.headingLevel = r.level;
      out.push(b);
      top += r.h;
    });
    return out;
  })();

  it("visibleBlocksOf / contentHeightOf：隐藏块被跳过且不占高", () => {
    expect(visibleBlocksOf(FOLDED).map((b) => b.index)).toEqual([0, 1, 2, 5, 6, 7]);
    // 可见块高度和 = 120+260+120+120+540+210
    expect(contentHeightOf(FOLDED)).toBe(1370);
  });

  it("findBlockAtY：落在隐藏块区间时取相邻可见块（不会返回隐藏块）", () => {
    // 隐藏块 3 的区间（top 380 起）与隐藏块 4 —— 该范围内可见块的 top 分布是
    // 0 / 120 / 380(块2) / 500(块5)…，取"top<=y 的最后一个可见块"
    const hit = findBlockAtY(FOLDED, 460)!;
    expect(hit.block.visible).toBe(true);
    expect([2, 5]).toContain(hit.block.index);
  });

  it("目标块被折叠 → 落到最近可见祖先标题（headingId 优先，class='ancestor-heading'）", () => {
    const anchor: ContentAnchor = {
      blockIndex: 3, // 被折叠
      ratioWithinBlock: 0.5,
      sourceLine: undefined,
    };
    const resolved = resolveAnchorBlock(FOLDED, anchor)!;
    expect(resolved.via).toBe("ancestor-heading");
    expect(resolved.block.index).toBe(2);
    expect(resolved.block.headingId).toBe("sec-a");
    // 跨块兜底只用块顶对齐，不臆造块内比例
    expect(resolved.ratio).toBe(0);
    // 恢复值 = "sec-a 标题块顶(380) 对齐视口中线(400)" → 380-400 = -20 → 钳到 0
    // （钳位是合法结果，与"无法映射返回 null"是两回事：这里映射成功了）
    expect(restoreContentAnchor(FOLDED, anchor, VIEWPORT)).toBe(0);
  });

  it("目标块被折叠且其所在节无可见标题 → 最近可见块（class='nearest-visible'）", () => {
    // 构造一节没有标题的文档：0 段落 / 1 段落(隐藏) / 2 段落
    const noHeading: BlockGeometry[] = [
      { index: 0, top: 0, height: 300, visible: true },
      { index: 1, top: 300, height: 0, visible: false },
      { index: 2, top: 300, height: 400, visible: true },
    ];
    const resolved = resolveAnchorBlock(noHeading, {
      blockIndex: 1,
      ratioWithinBlock: 0.3,
    })!;
    expect(resolved.via).toBe("nearest-visible");
    expect(resolved.block.index).toBe(0); // 优先向前（内容流向上同一节）
    expect(findNearestVisible(noHeading, 1)!.index).toBe(0);
    // 恢复：把块 0 顶对齐中线（300 > 800/2 → 负数钳 0）
    expect(restoreContentAnchor(noHeading, {
      blockIndex: 1,
      ratioWithinBlock: 0.3,
    }, VIEWPORT)).toBe(0);
  });

  it("visibleHeadingChain：给出展开祖先链（供 headingFold.expandAncestors 接线）", () => {
    // h1(1) … h2(3) … h3(5) … 目标块 6 → 祖先链 [h1, h2, h3]
    const nested = layout([100, 100, 100, 100, 100, 100, 100, 100], extras(
      headingAt(1, "h1", 1),
      headingAt(3, "h2", 2),
      headingAt(5, "h3", 3),
    ));
    expect(visibleHeadingChain(nested, 6).map((b) => b.headingId)).toEqual([
      "h1",
      "h2",
      "h3",
    ]);
    // 同级标题只保留最后一个（上一条分支被弹出）
    const siblings = layout([100, 100, 100, 100, 100], extras(
      headingAt(0, "a", 2),
      headingAt(2, "b", 2),
    ));
    expect(visibleHeadingChain(siblings, 4).map((b) => b.headingId)).toEqual(["b"]);
    // 更深层级后再遇浅层：浅层成为新根，更深层被弹出
    const mixed = layout([100, 100, 100, 100], extras(
      headingAt(0, "h2", 2),
      headingAt(1, "h4", 4),
      headingAt(2, "h1", 1),
    ));
    expect(visibleHeadingChain(mixed, 3).map((b) => b.headingId)).toEqual(["h1"]);
    // 目标块之前没有标题 → 空数组；隐藏标题不进链
    expect(visibleHeadingChain(siblings, 0)).toEqual([]);
  });

  it("无祖先标题时 findVisibleAncestorHeading 返回 null（而不是乱选一个）", () => {
    const noHeading: BlockGeometry[] = [
      { index: 0, top: 0, height: 300, visible: true },
      { index: 1, top: 300, height: 0, visible: false },
    ];
    expect(findVisibleAncestorHeading(noHeading, 1)).toBeNull();
  });

  it("采集时中央落在隐藏块相邻可见块上（折叠后采集不产生隐藏块锚点）", () => {
    const anchor = captureContentAnchor(FOLDED, 0, VIEWPORT)!;
    expect(anchor).not.toBeNull();
    expect(anchor!.atTop).toBe(true);
    // 折叠后的内容高 1370 > 800，可滚动；中段采集
    const mid = captureContentAnchor(FOLDED, 285, VIEWPORT)!;
    expect(mid.blockIndex).not.toBe(3);
    expect(mid.blockIndex).not.toBe(4);
  });
});

// ═══════════ ④ 定位优先级：headingId → blockIndex → sourceLine ═══════════

describe("需求7 · 定位优先级 headingId > blockIndex，sourceLine 辅助校验", () => {
  it("headingId 命中优先于 blockIndex（块表位移后仍指回同一节）", () => {
    // 锚点记 blockIndex 3，但目标侧该 index 已是别的块；headingId 命中真正的标题块 5
    const target = layout([100, 100, 100, 100, 100, 120, 300], extras(
      headingAt(5, "keep-me", 2, 12),
    ));
    const resolved = resolveAnchorBlock(target, {
      blockIndex: 3,
      headingId: "keep-me",
      ratioWithinBlock: 0.4,
    })!;
    expect(resolved.via).toBe("heading");
    expect(resolved.block.index).toBe(5);
  });

  it("无 headingId → blockIndex 命中（class='index'）", () => {
    const resolved = resolveAnchorBlock(MIXED, {
      blockIndex: 4,
      ratioWithinBlock: 0.25,
    })!;
    expect(resolved.via).toBe("index");
    expect(resolved.block.index).toBe(4);
    expect(resolved.ratio).toBe(0.25);
  });

  it("headingId 查不到（标题被删/改名）→ 回落到 blockIndex", () => {
    const resolved = resolveAnchorBlock(MIXED, {
      blockIndex: 6,
      headingId: "gone",
      ratioWithinBlock: 0.5,
    })!;
    expect(resolved.via).toBe("index");
    expect(resolved.block.index).toBe(6);
  });

  it("sourceLine 与命中块的相差在容差内 → 信任 blockIndex", () => {
    const blocks = layout([100, 200, 300], withSourceLine([0, 0], [1, 5], [2, 10]));
    const resolved = resolveAnchorBlock(blocks, {
      blockIndex: 1,
      ratioWithinBlock: 0.5,
      sourceLine: 6, // 与块 1 的 5 差 1（容差内）
    })!;
    expect(resolved.via).toBe("index");
    expect(resolved.block.index).toBe(1);
  });

  it("sourceLine 与命中块相差过大 → 按源码行纠偏到更接近的块", () => {
    const blocks = layout([100, 200, 300, 400], withSourceLine([0, 0], [1, 5], [2, 10], [3, 20]));
    const resolved = resolveAnchorBlock(blocks, {
      blockIndex: 1, // 该块源码行 5
      ratioWithinBlock: 0.5,
      sourceLine: 20, // 实际应是块 3
    })!;
    expect(resolved.via).toBe("source-line");
    expect(resolved.block.index).toBe(3);
  });

  it("headingId/blockIndex 都失效 → 按 sourceLine 反查（class='source-line'）", () => {
    // blockIndex 99 越界，headingId 不存在，只有源码行可用
    const blocks = layout([100, 200, 300], withSourceLine([0, 0], [1, 5], [2, 10]));
    const resolved = resolveAnchorBlock(blocks, {
      blockIndex: 99,
      headingId: "nope",
      ratioWithinBlock: 0.5,
      sourceLine: 11,
    })!;
    expect(resolved.via).toBe("source-line");
    expect(resolved.block.index).toBe(2);
  });
});

// ═══════════ ④b 几何边界：块间空隙 / 文末空行 / 入参乱序 / 异步变高 ═══════════

describe("需求7 · 几何边界（块间空隙、文末空行、乱序入参、异步变高）", () => {
  it("块间空隙（外边距/被吞空行）：落在空隙仍返回前一块 ratio=1，且单调不跳", () => {
    // 块 0: [0,100)，留 40px 空隙；块 1: [140,260)
    const gapped: BlockGeometry[] = [
      { index: 0, top: 0, height: 100, visible: true },
      { index: 1, top: 140, height: 120, visible: true },
    ];
    const inGap = findBlockAtY(gapped, 120)!;
    expect(inGap.block.index).toBe(0);
    expect(inGap.ratio).toBe(1); // "刚过这一块"，不是 0 或 NaN
    const atNext = findBlockAtY(gapped, 140)!;
    expect(atNext.block.index).toBe(1);
    expect(atNext.ratio).toBe(0);
  });

  it("y 在首块之前（前导空行）→ 首块 ratio 0", () => {
    const gapped: BlockGeometry[] = [
      { index: 0, top: 60, height: 100, visible: true },
    ];
    const hit = findBlockAtY(gapped, 10)!;
    expect(hit.block.index).toBe(0);
    expect(hit.ratio).toBe(0);
  });

  it("y 越过末块（文末空行）→ 末块 ratio 1（不返回 null 也不越界）", () => {
    const hit = findBlockAtY(MIXED, MIXED_CONTENT_HEIGHT + 500)!;
    expect(hit.block.index).toBe(MIXED.length - 1);
    expect(hit.ratio).toBe(1);
  });

  it("入参乱序（未按 index/top 排序）→ 内部排序，结果与有序入参一致", () => {
    const ordered = MIXED;
    const shuffled = [...MIXED].reverse();
    const a = captureContentAnchor(ordered, 2200, VIEWPORT, {
      contentHeight: MIXED_CONTENT_HEIGHT,
    })!;
    const b = captureContentAnchor(shuffled, 2200, VIEWPORT, {
      contentHeight: MIXED_CONTENT_HEIGHT,
    })!;
    expect(b.blockIndex).toBe(a.blockIndex);
    expect(b.ratioWithinBlock).toBeCloseTo(a.ratioWithinBlock, 6);
  });

  it("目标侧异步变高（块 top/height 变了）：仍按『同一块 + 同一比例』落点，不按像素", () => {
    const before = MIXED;
    const anchor = captureContentAnchor(before, 1800, VIEWPORT, {
      contentHeight: MIXED_CONTENT_HEIGHT,
    })!;
    // 模拟 mermaid/katex 把块 0 撑高 200 → 其后所有块 top 整体 +200、总高 +200
    const grown: BlockGeometry[] = MIXED.map((b, i) => ({
      ...b,
      top: b.top + (i >= 1 ? 200 : 0),
      height: i === 0 ? b.height + 200 : b.height,
    }));
    const grownHeight = MIXED_CONTENT_HEIGHT + 200;
    const after = restoreContentAnchor(grown, anchor, VIEWPORT, {
      contentHeight: grownHeight,
    })!;
    const now = centerOf(grown, after, VIEWPORT);
    expect(now.block.index).toBe(anchor.blockIndex);
    expect(now.ratio).toBeCloseTo(anchor.ratioWithinBlock, 2);
  });

  it("headingId 目标在新区块表里位移（前面插入了块）：按 headingId 回到同一标题", () => {
    // 目标侧：块 0/1 是新插入的内容，原 heading 从 0 挪到 3
    const moved = layout([80, 80, 80, 140, 400, 300], extras(
      headingAt(3, "sec-intro", 1, 0),
    ));
    const resolved = resolveAnchorBlock(moved, {
      blockIndex: 0,
      headingId: "sec-intro",
      ratioWithinBlock: 0.2,
    })!;
    expect(resolved.via).toBe("heading");
    expect(resolved.block.index).toBe(3);
    // 标题块位移后，块内比例不再沿用（跨位移比值无意义），只对齐标题顶
    expect(resolved.ratio).toBe(0);
  });

  it("同一内容不足一屏时 restore 得 0 属『映射成功』；但几何不可信仍必须 null", () => {
    const short = layout([300]);
    expect(restoreContentAnchor(short, { blockIndex: 0, ratioWithinBlock: 0.8 }, VIEWPORT)).toBe(0);
    const bogus: BlockGeometry[] = [
      { index: 0, top: 0, height: 0, visible: true }, // 高度 0 且唯一块 → 内容高 0
    ];
    expect(restoreContentAnchor(bogus, { blockIndex: 0, ratioWithinBlock: 0.5 }, VIEWPORT)).toBeNull();
  });
});

// ═══════════ ⑤ 无法映射 → null（绝不 0 兜底） ═══════════
describe("需求7 · 无法映射必须返回 null（绝不返回 0）", () => {
  it("空块表 → null（capture 与 restore 都是）", () => {
    expect(captureContentAnchor([], 100, VIEWPORT)).toBeNull();
    expect(restoreContentAnchor([], { blockIndex: 0, ratioWithinBlock: 0.5 }, VIEWPORT)).toBeNull();
  });

  it("全块隐藏 → null", () => {
    const hidden = layout([null, null, null]);
    expect(captureContentAnchor(hidden, 0, VIEWPORT)).toBeNull();
    expect(restoreContentAnchor(hidden, { blockIndex: 0, ratioWithinBlock: 0.5 }, VIEWPORT)).toBeNull();
  });

  it("锚点为 null/undefined → null", () => {
    expect(restoreContentAnchor(MIXED, null, VIEWPORT)).toBeNull();
    expect(restoreContentAnchor(MIXED, undefined, VIEWPORT)).toBeNull();
  });

  it("锚点的 blockIndex 越界且无 headingId/sourceLine → null（不是 0）", () => {
    expect(restoreContentAnchor(MIXED, { blockIndex: 999, ratioWithinBlock: 0.5 }, VIEWPORT)).toBeNull();
    expect(restoreContentAnchor(MIXED, {
      blockIndex: -1,
      ratioWithinBlock: 0.5,
    }, VIEWPORT)).toBeNull();
  });

  it("viewportHeight 非法（0/负数/NaN）→ null", () => {
    const anchor: ContentAnchor = { blockIndex: 1, ratioWithinBlock: 0.5 };
    expect(restoreContentAnchor(MIXED, anchor, 0)).toBeNull();
    expect(restoreContentAnchor(MIXED, anchor, -1)).toBeNull();
    expect(restoreContentAnchor(MIXED, anchor, Number.NaN)).toBeNull();
  });

  it("几何全不可信（top/height 非有限）→ null", () => {
    const broken: BlockGeometry[] = [
      { index: 0, top: Number.NaN, height: 100, visible: true },
      { index: 1, top: 100, height: Number.NaN, visible: true },
    ];
    expect(captureContentAnchor(broken, 0, VIEWPORT)).toBeNull();
    expect(restoreContentAnchor(broken, { blockIndex: 0, ratioWithinBlock: 0.5 }, VIEWPORT)).toBeNull();
  });

  it("内容不足一屏：capture 返回 null；restore 的合法落点是 0（不是错误兜底）", () => {
    const short = layout([300]);
    expect(captureContentAnchor(short, 0, VIEWPORT)).toBeNull();
    // 目标侧内容不足一屏：唯一位置就是顶部，0 是"映射成功"的精确值
    expect(restoreContentAnchor(short, { blockIndex: 0, ratioWithinBlock: 0.8 }, VIEWPORT)).toBe(0);
  });

  it("★ 关键门禁：无法定位时必须 null，而不是旧实现 `newTop ?? 0` 的 0", () => {
    // 目标侧块表整体换过（换文档/外部重载）：锚点里的块下标与源码行都不存在
    const other = layout([400, 400]);
    const stale: ContentAnchor = {
      blockIndex: 7,
      headingId: "chapter-old",
      ratioWithinBlock: 0.6,
      sourceLine: 99,
    };
    const got = restoreContentAnchor(other, stale, VIEWPORT);
    expect(got).toBeNull();
    expect(got).not.toBe(0);
  });
});

// ═══════════ ⑥ 贴顶/贴底专用分支的边界 ═══════════

describe("需求7 · 贴顶/贴底：容差与优先级", () => {
  it("容差内视为贴顶（2px 内）", () => {
    const a = captureContentAnchor(MIXED, CONTENT_ANCHOR_EDGE_TOLERANCE_PX, VIEWPORT, {
      contentHeight: MIXED_CONTENT_HEIGHT,
    })!;
    expect(a.atTop).toBe(true);
  });

  it("刚出容差就不算贴顶（走中央锚点）", () => {
    const a = captureContentAnchor(MIXED, CONTENT_ANCHOR_EDGE_TOLERANCE_PX + 1, VIEWPORT, {
      contentHeight: MIXED_CONTENT_HEIGHT,
    })!;
    expect(a.atTop).toBe(false);
  });

  it("容差内视为贴底", () => {
    const maxScroll = MIXED_CONTENT_HEIGHT - VIEWPORT;
    const a = captureContentAnchor(MIXED, maxScroll - 1, VIEWPORT, {
      contentHeight: MIXED_CONTENT_HEIGHT,
    })!;
    expect(a.atBottom).toBe(true);
  });

  it("opts 强制 atTop / atBottom 覆盖几何判定（atBottom 优先）", () => {
    const a = captureContentAnchor(MIXED, 2000, VIEWPORT, {
      atTop: true,
      contentHeight: MIXED_CONTENT_HEIGHT,
    })!;
    expect(a.atTop).toBe(true);
    expect(restoreContentAnchor(MIXED, a, VIEWPORT, { contentHeight: MIXED_CONTENT_HEIGHT })).toBe(0);

    const both = captureContentAnchor(MIXED, 2000, VIEWPORT, {
      atTop: true,
      atBottom: true,
      contentHeight: MIXED_CONTENT_HEIGHT,
    })!;
    expect(restoreContentAnchor(MIXED, both, VIEWPORT, {
      contentHeight: MIXED_CONTENT_HEIGHT,
    })).toBe(MIXED_CONTENT_HEIGHT - VIEWPORT);
  });

  it("贴底优先于中央映射：即使锚点块只到内容中部，也落到底", () => {
    const maxScroll = MIXED_CONTENT_HEIGHT - VIEWPORT;
    const got = restoreContentAnchor(MIXED, {
      blockIndex: 1, // 中部的段落
      ratioWithinBlock: 0.5,
      atBottom: true,
    }, VIEWPORT, { contentHeight: MIXED_CONTENT_HEIGHT });
    expect(got).toBe(maxScroll);
  });
});

// ═══════════ ⑦ 与 blockScrollAlign 的复用契约 ═══════════

describe("需求7 · 复用 blockScrollAlign 的口径（不重复实现）", () => {
  it("maxScrollOf / clamp 已从 blockScrollAlign 导出且行为不变", () => {
    expect(maxScrollOf(1000, 400)).toBe(600);
    expect(maxScrollOf(300, 400)).toBe(0); // 内容不足一屏 → 0
    expect(maxScrollOf(Number.NaN, 400)).toBe(0);
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(Number.NaN, 2, 3)).toBe(2); // 非有限 → 取 lo
    expect(clamp(2.5, 0, 3)).toBe(2.5);
  });

  it("contentScrollMap 与 blockScrollAlign 的 maxScroll 口径一致（同输入同输出）", () => {
    const contentHeight = 5000;
    const vh = 800;
    // restore 的贴底落点 === blockScrollAlign 口径的 maxScrollOf
    const got = restoreContentAnchor(MIXED, {
      blockIndex: 0,
      ratioWithinBlock: 0,
      atBottom: true,
    }, vh, { contentHeight });
    expect(got).toBe(maxScrollOf(contentHeight, vh));
  });

  it("块聚合的内容高与实测覆盖：覆盖值生效（贴底精度依赖它）", () => {
    const aggregated = contentHeightOf(MIXED); // 末块底部（不含尾部空行）
    expect(aggregated).toBeLessThan(MIXED_CONTENT_HEIGHT);
    // 取一个"按聚合口径已经到底、按实测口径还没到底"的位置
    const probe = aggregated - VIEWPORT + 100; // = 聚合 max + 100
    const a = captureContentAnchor(MIXED, probe, VIEWPORT)!;
    // 未给覆盖值：聚合 max 更小，probe 会被钳到聚合 max → 判定为贴底
    expect(a.atBottom).toBe(true);
    // 给了实测高（含尾部空行）：同一个 scrollTop 离真底还差 200 → 不再算贴底
    const b = captureContentAnchor(MIXED, probe, VIEWPORT, {
      contentHeight: MIXED_CONTENT_HEIGHT,
    })!;
    expect(b.atBottom).toBe(false);
  });
});

// ═══════════ ⑨ 与 documentHistory.ContentAnchor 的类型互操作（Lead 接线契约） ═══════════
//
// 设计稿 §1.2 要求撤销历史的 `beforeAnchor/afterAnchor` 与 §3.2 的坐标系**同一类型**。
// task-3 交付的 `documentHistory.ts` 里已有一份四字段版本；本模块的类型是它的超集
// （多 `atTop/atBottom` 两个可选边缘标志），因此可双向赋值。这条测试锁住该契约，
// 防止任一侧「顺手改字段名」导致接线时才发现（那时改动成本高得多）。
describe("需求7 · 与 documentHistory.ContentAnchor 互操作", () => {
  it("documentHistory 的锚点可直接喂给 restoreContentAnchor（结构子类型）", () => {
    // 用结构化对象模拟 documentHistory.ContentAnchor（避免测试耦合对方模块内部）
    const fromHistory: {
      blockIndex: number;
      headingId?: string;
      ratioWithinBlock: number;
      sourceLine?: number;
    } = { blockIndex: 4, ratioWithinBlock: 0.5, sourceLine: 200 };
    const got = restoreContentAnchor(MIXED, fromHistory, VIEWPORT, {
      contentHeight: MIXED_CONTENT_HEIGHT,
    });
    expect(got).not.toBeNull();
    const now = centerOf(MIXED, got!, VIEWPORT);
    expect(now.block.index).toBe(4);
    expect(now.ratio).toBeCloseTo(0.5, 2);
  });

  it("captureContentAnchor 的结果可赋给 documentHistory.ContentAnchor（超集兼容）", () => {
    const anchor = captureContentAnchor(MIXED, 2400, VIEWPORT, {
      contentHeight: MIXED_CONTENT_HEIGHT,
    })!;
    const asHistoryShape: {
      blockIndex: number;
      headingId?: string;
      ratioWithinBlock: number;
      sourceLine?: number;
    } = anchor; // 若本类型不再兼容，此处 tsc 报错
    expect(typeof asHistoryShape.blockIndex).toBe("number");
    expect(asHistoryShape.ratioWithinBlock).toBeGreaterThanOrEqual(0);
    expect(asHistoryShape.ratioWithinBlock).toBeLessThanOrEqual(1);
    // 贴顶/贴底标志是对 §1.2 的**增补**（可选），历史侧不感知也不影响其往返
    expect(anchor.atTop === undefined || typeof anchor.atTop === "boolean").toBe(true);
  });
});

// ═══════════ ⑩ 源码侧适配：blockGeometryFromLineAxis（实测行轴 → 块几何） ═══════════
//
// 设计稿 §3.2 硬要求：「空行/软换行：源码侧沿用 `measureSourceLineAxis`……不再用线性
// 百分比估算」。textarea 没有子元素可量，只能用 blockScrollAlign 的实测按行轴还原块几何。
// 这里用"手动构造的轴"模拟镜像 div 的测量结果（真实测量由 DOM 层负责）。
describe("需求7 · blockGeometryFromLineAxis：从实测行轴还原块几何", () => {
  /**
   * 模拟一份软换行文档：共 8 逻辑行，第 3 行是超长行（软换行占 3 个视觉行高度）。
   * 轴值 = 每逻辑行的实测行顶（内容坐标）。
   *   行0:0 / 行1:30 / 行2:60 / 行3:90（长行起）/ 行4:180（长行结束，占 90px）
   *   行5:210 / 行6:240 / 行7:270
   */
  const TOTAL = 8;
  const AXIS = [0, 30, 60, 90, 180, 210, 240, 270];
  const BLOCK_LINES = [0, 2, 3, 5, 7]; // 顶层块起始行（段落 / 段落 / 长行段 / 段落 / 段落）

  it("块 top 取实测行顶；块高取下一块行顶减本块行顶（软换行被如实表达）", () => {
    const blocks = blockGeometryFromLineAxis({
      totalLines: TOTAL,
      lineAxis: AXIS,
      blockLines: BLOCK_LINES,
      contentHeight: 330,
    })!;
    expect(blocks).toHaveLength(5);
    expect(blocks.map((b) => b.sourceLine)).toEqual(BLOCK_LINES);
    expect(blocks.map((b) => b.top)).toEqual([0, 60, 90, 210, 270]);
    // 长行段(行3)高 = 行5 顶(210) − 行3 顶(90) = 120；按逻辑行线性只会算 30 → 差 4 倍
    expect(blocks[2].height).toBe(120);
    expect(blocks[0].height).toBe(60);
    expect(blocks[0].visible).toBe(true);
  });

  it("最后一块延伸到内容底（贴底/尾部锚点不会落在半空）", () => {
    const blocks = blockGeometryFromLineAxis({
      totalLines: TOTAL,
      lineAxis: AXIS,
      blockLines: BLOCK_LINES,
      contentHeight: 330,
    })!;
    const last = blocks[blocks.length - 1];
    expect(last.top + last.height).toBe(330);
  });

  it("★ 用该几何往返：软换行处不再出现线性估算的整块级偏差", () => {
    const blocks = blockGeometryFromLineAxis({
      totalLines: TOTAL,
      lineAxis: AXIS,
      blockLines: BLOCK_LINES,
      contentHeight: 330,
    })!;
    const vh = 100;
    // 在长行段内部取点往返
    const tallBlock = blocks[2];
    const scrollTop = tallBlock.top + tallBlock.height / 2 - vh / 2;
    const after = roundTrip(blocks, scrollTop, vh, { contentHeight: 330 })!;
    expect(Math.abs(after - scrollTop)).toBeLessThan(0.5);
    const now = centerOf(blocks, after, vh);
    expect(now.block.index).toBe(2);
    expect(now.ratio).toBeCloseTo(0.5, 3);
  });

  it("块行无效/轴长度不符/内容高非法 → null（调用方退回百分比，不硬算）", () => {
    const base = { totalLines: TOTAL, blockLines: BLOCK_LINES, contentHeight: 330 };
    expect(blockGeometryFromLineAxis({ ...base, lineAxis: null })).toBeNull();
    expect(blockGeometryFromLineAxis({ ...base, lineAxis: [0, 30] })).toBeNull(); // 长度≠totalLines
    expect(blockGeometryFromLineAxis({ ...base, lineAxis: AXIS, contentHeight: 0 })).toBeNull();
    expect(blockGeometryFromLineAxis({
      ...base,
      lineAxis: AXIS,
      blockLines: [], // 无有效块
    })).toBeNull();
    expect(blockGeometryFromLineAxis({
      ...base,
      lineAxis: AXIS,
      blockLines: [0, 2, 99], // 越界项被剔除，仍剩有效项
    })!.map((b) => b.sourceLine)).toEqual([0, 2]);
  });

  it("测量噪声（轴回退）被强制非递减，height 不为负", () => {
    const noisy = [0, 30, 60, 50, 180, 210, 240, 270]; // 行3 的行顶回退了
    const blocks = blockGeometryFromLineAxis({
      totalLines: TOTAL,
      lineAxis: noisy,
      blockLines: BLOCK_LINES,
      contentHeight: 330,
    })!;
    for (let i = 0; i < blocks.length; i++) {
      expect(blocks[i].height).toBeGreaterThanOrEqual(0);
      if (i > 0) expect(blocks[i].top).toBeGreaterThanOrEqual(blocks[i - 1].top);
    }
  });
});

// ═══════════ ⑪ 块间空隙：往返幂等（v0.15.1 需求3 第四次返修） ═══════════
//
// 真实阅读面每块都是元素 rect（高度**不含**外边距），块与块之间自然留有空隙；
// 而源码面按实测行轴把「空行/margin」算进上一块的高度（块与块首尾相接）。
// 于是"块内比例"在两套排版的空隙区间里不可比：`findBlockAtY` 把空隙里的比例钳到
// 前一块的 1，空隙里那段真实偏移就被抹掉了。
//
// 实机后果（v0.15.1 探针，用户报"连续双击 Ctrl 后视野偏移"）：把视口停在段落空隙里
// 再往返切换一次，阅读面 scrollTop 一次性跳 11px（不累积，但"切一下视野挪了一行"）。
// 修法：采集/恢复改用「块顶 → 下一块顶」的**连续区域**取比例，空隙算进前一块的区域。
describe("需求7 · 块间空隙：往返幂等（v0.15.1 需求3 第四次返修）", () => {
  /** 模拟阅读面：块高 80、块间空隙 40（如段落 margin 塌陷后的间距） */
  const GAPPED: BlockGeometry[] = [
    { index: 0, top: 0, height: 80, visible: true },
    { index: 1, top: 120, height: 80, visible: true },
    { index: 2, top: 240, height: 80, visible: true },
  ];
  const G_VH = 100;
  const G_CONTENT = 320;

  it("中央落在空隙里：按区域取比例，同一几何往返**像素级**幂等", () => {
    // 中央 = scrollTop + 50；取 scrollTop=50 → 中央 100（第 0 块 [0,80) 之后的空隙里）
    const scrollTop = 50;
    const anchor = captureContentAnchor(GAPPED, scrollTop, G_VH, { contentHeight: G_CONTENT })!;
    expect(anchor.blockIndex).toBe(0);
    // 区域 0 = [0,120)（本块 80 + 空隙 40）→ 比例 100/120，不再被钳成 1
    expect(anchor.ratioWithinBlock).toBeCloseTo(100 / 120, 6);
    const back = restoreContentAnchor(GAPPED, anchor, G_VH, { contentHeight: G_CONTENT })!;
    expect(back).toBeCloseTo(scrollTop, 6);
  });

  it("中央落在块内：比例按整个区域归一（口径与源码面一致）", () => {
    // 视口高 60、停在顶部 → 中央 30 → 区域 0 内 30/120
    const anchor = captureContentAnchor(GAPPED, 0, 60, { contentHeight: G_CONTENT })!;
    expect(anchor.blockIndex).toBe(0);
    expect(anchor.ratioWithinBlock).toBeCloseTo(30 / 120, 6);
  });

  it("区域比例跨越排版仍单调：目标侧空隙更窄时落点不会被推过下一块", () => {
    // 目标侧空隙更小（块 0 高 80、空隙只有 4px → 区域 0 = [0,84)）
    const tightGap: BlockGeometry[] = [
      { index: 0, top: 0, height: 80, visible: true },
      { index: 1, top: 84, height: 80, visible: true },
      { index: 2, top: 204, height: 80, visible: true },
    ];
    const anchor = captureContentAnchor(GAPPED, 50, G_VH, { contentHeight: G_CONTENT })!;
    const got = restoreContentAnchor(tightGap, anchor, G_VH, { contentHeight: G_CONTENT })!;
    // 比例 100/120 → 0 + (100/120)*84 = 70 → 70 − 50 = 20（仍落在块 0 区域里）
    expect(got).toBeCloseTo((100 / 120) * 84 - G_VH / 2, 6);
    expect(got).toBeLessThan(tightGap[1].top - G_VH / 2 + 1);
  });

  it("块被折叠改指祖先标题时按目标块自身区域换算（不套用旧块比例）", () => {
    const withHiddenFirst: BlockGeometry[] = [
      { index: 0, top: 0, height: 0, visible: false }, // 被折叠：不占空间
      { index: 1, top: 100, height: 80, visible: true },
      { index: 2, top: 220, height: 80, visible: true },
    ];
    const got = restoreContentAnchor(
      withHiddenFirst,
      // 目标块已不可见 → 只能落到最近可见块，比例按 ratio=0 落在块顶
      { blockIndex: 0, ratioWithinBlock: 1 },
      G_VH,
      { contentHeight: G_CONTENT },
    )!;
    // 落到 index=1 的块顶：100 − 50 = 50
    expect(got).toBeCloseTo(50, 6);
  });

  it("往返后视口中央仍是同一处的同一个比例关系（内容点不漂）", () => {
    const scrollTop = 130; // 中央 180 → 第 1 块内部
    const anchor = captureContentAnchor(GAPPED, scrollTop, G_VH, { contentHeight: G_CONTENT })!;
    const back = restoreContentAnchor(GAPPED, anchor, G_VH, { contentHeight: G_CONTENT })!;
    expect(back).toBeCloseTo(scrollTop, 6);
    const now = centerOf(GAPPED, back, G_VH);
    expect(now.block.index).toBe(anchor.blockIndex);
  });
});

// ═══════════ ⑧ 纯函数纪律：无 React / 无 DOM 依赖（源码级门禁） ═══════════

describe("需求7 · 纯函数纪律（读源码断言，防接线时被污染）", () => {
  it("contentScrollMap.ts 只依赖 blockScrollAlign，不 import React/DOM 模块", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../utils/contentScrollMap.ts"),
      "utf8",
    );
    const imports = [...src.matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    // 纯函数层只允许复用 blockScrollAlign（不得引入 React 组件/store/service）
    expect(imports).toEqual(["./blockScrollAlign"]);
    expect(src).not.toMatch(/from\s+"react/);
    expect(src).not.toMatch(/from\s+"[^"]*(components|stores|services)\//);
    // 不得访问浏览器全局（本层不测量、不写滚动）
    expect(src).not.toMatch(/[^.\w]document\./);
    expect(src).not.toMatch(/[^.\w]window\./);
    // 关键契约注释必须在场（防后来者把 null 改回 0）
    expect(src).toContain("无法映射返回 `null`，绝不返回 0");
  });
});
