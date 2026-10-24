// @vitest-environment jsdom
/**
 * v0.14.0 需求4：左右屏**篇幅差异与滚动对齐**（不改渲染，只改滚动联动）。
 *
 * ## 用户症状
 * 「左屏内容加了分割线（`---`）后，无论中间加多少空行，右屏渲染都紧挨着、没有对应
 *  空行，导致左屏文档篇幅明显比右屏长；往下滚动时『右屏已经到底了，左屏还要滚很长
 *  才到底』。」
 *
 * ## 实测根因（三份文档，`_verify-out/v0140-probe-split-parity.txt`）
 * 改前基线（真机 CDP 采样）：
 *
 * | 文档 | 左 max | 右 max | 左到底时右 pct | 右到底时左 pct | 块对齐 Δ块（0.5 处） |
 * | --- | --- | --- | --- | --- | --- |
 * | ① 分割线 + 120 空行 | 4531 | 1048 | 1.000 | **0.787** | 0（尾部直接卡住） |
 * | ② 长行软换行 | 5798 | 4398 | 1.000 | **0.794** | **+7**（左行 76.5 → 右块 45，应 38） |
 * | ③ 表格/mermaid | 1364 | 1700 | 1.000 | 1.000 | 无锚点（`[data-src-line]` = **0**） |
 *
 * 三个独立缺陷：
 * 1. `estimateTopSourceLine` 的**线性假设**：textarea 是 `white-space: pre-wrap`，
 *    长行软换行 → 视觉行 ≫ 逻辑行，按 `scrollTop/max × (总行数-1)` 估算必然偏后
 *    （② 里 0.5 处估出 76.5 行，真值 38.2 行）。
 * 2. 锚点表**没有末尾锚点**：最后一个块之后的源码尾部（正是那 120 个空行）无法映射，
 *    右屏停在最后块 → ① 右屏到底时左屏只到 78.7%。
 * 3. `shouldTagPreview` 的右侧基数用了 `body.children` **全部**：分屏 iframe 在
 *    `</body>` 前注入 mermaid/katex 的 `<script>`，mermaid 还会挂一个
 *    `div.mermaidTooltip` → 数量不符 → 整份文档放弃贴标（③ 实测 0 个锚点），
 *    只能退回百分比映射，用户抱怨的"图表处对不齐"就是这样来的。
 *
 * ## 本文件的层次
 * - 纯算术：末尾锚点 / 软换行按行轴 / 分段插值 / 单调性 / 回退链；
 * - DOM 测量：`measureSourceLineAxis` 用 mirror div 实测行顶（jsdom 里用 stub 验证契约）；
 * - 接线契约：`EditorContainer` 必须把新参数接上（读源码断言，防止改一半）。
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildSourceLineAxis,
  estimateTopSourceLine,
  isAnchorablePreviewChild,
  lineAtMaxScroll,
  locateSourceLine,
  mapPreviewScrollToSourceLine,
  mapSourceLineToPreviewScroll,
  mapSourceLineToScrollTop,
  measureSourceLineAxis,
  pickAnchorIndex,
  shouldTagPreview,
  type PreviewAnchorSet,
  type SourceViewportMetrics,
} from "../utils/blockScrollAlign";

// ═════════════ ① 末尾锚点：两屏一起到底 ═════════════

describe("需求4 · 末尾锚点：左屏 max ↔ 右屏 max", () => {
  /**
   * 真实采样（`v0140-probe-split-parity.txt` 文档①）：
   * 左屏 198 行 / max 4531；右屏 5 个块，totalHeight 2299、clientHeight 1251（max 1048）。
   * 锚点：(行 0, top 78)、(行 2, top 139)、(行 33, top 1027)、(行 155, top 1053)、(行 157, top 1095)。
   * 尾部 157..197 共 41 行在右屏**没有对应块**（那 120 个空行被吞掉）。
   */
  const SET: PreviewAnchorSet = {
    lines: [0, 2, 33, 155, 157],
    tops: [78, 139, 1027, 1053, 1095],
    heights: [42, 864, 2, 29, 1152],
    totalHeight: 2299,
    totalSourceLines: 198,
  };
  const VIEWPORT = 1251;

  it("左屏滚到最后一行 → 右屏 scrollTop = 可滚动上限（而不是停在最后块）", () => {
    const target = mapSourceLineToPreviewScroll(SET, 197, VIEWPORT)!;
    expect(target).toBe(1048); // 2299 - 1251
  });

  it("右屏滚到底 → 反算回最后一行（旧实现只到 78.7% 的位置）", () => {
    const line = mapPreviewScrollToSourceLine(SET, 1048, VIEWPORT)!;
    expect(line).toBeCloseTo(197, 6);
  });

  it("往返恒等：末行 ↔ max 互逆（左到底 → 右到底 → 左到底）", () => {
    for (const line of [0, 2, 33, 100, 155, 157, 170, 197]) {
      const right = mapSourceLineToPreviewScroll(SET, line, VIEWPORT)!;
      const back = mapPreviewScrollToSourceLine(SET, right, VIEWPORT)!;
      expect(Math.abs(back - line)).toBeLessThan(1e-6);
    }
  });

  it("未提供 totalSourceLines 时行为与 v0.13.x 一致（不引入末尾锚点）", () => {
    const legacy: PreviewAnchorSet = { ...SET, totalSourceLines: undefined };
    // 旧语义：最后一块按 top+height 收尾 → 行 158 就到 1095+1152，被钳到 max
    expect(mapSourceLineToPreviewScroll(legacy, 999, VIEWPORT)).toBe(1048);
    // 但中间位置不会因为末尾锚点而改变
    expect(mapSourceLineToPreviewScroll(legacy, 33, VIEWPORT)).toBe(1027);
  });

  it("源码尾部很长（用户加了 120 个空行）时尾部区间按比例分摊，不是一跳到顶", () => {
    // 行 157..197 共 40 行映射到 1095..1048 —— 后者比前者小，会被钳制。
    // 关键：单调不减，且中间不会出现"没到底就已经到底"。
    let prev = -Infinity;
    for (let line = 157; line <= 197; line += 1) {
      const v = mapSourceLineToPreviewScroll(SET, line, VIEWPORT)!;
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(mapSourceLineToPreviewScroll(SET, 197, VIEWPORT)).toBe(1048);
  });

  it("maxScrollLine：末尾锚点用「滚到底时视口顶所在行」而不是最后一行", () => {
    // 真机实测（文档①）：预览 max=1048、last anchor line=157、totalSourceLines=198，
    // 但滚到最底时视口顶其实是第 223 行（整篇 266 行里的第 223 行）。
    // 这里用同一形状的小样本：预览只到 line 5，源码有 20 行。
    const set: PreviewAnchorSet = {
      lines: [0, 2, 3, 4, 5],
      tops: [0, 100, 300, 500, 700],
      heights: [100, 200, 200, 200, 200],
      totalHeight: 900,
      totalSourceLines: 20,
      maxScrollLine: 8, // 滚到底时视口顶在第 8 行（不是第 19 行）
    };
    const vh = 400; // max = 500
    // 左屏滚到底（→ 第 8 行）必须映射到右屏 max，而不是停在块 5 的 top=700 被钳到 500 前
    expect(mapSourceLineToPreviewScroll(set, 8, vh)).toBe(500);
    // 反算：右屏到底 → 第 8 行
    expect(mapPreviewScrollToSourceLine(set, 500, vh)).toBeCloseTo(8, 6);
  });

  it("line > maxScrollLine 的锚点被剔除（否则端点表 line 非单调 → 顺序查找提前 break）", () => {
    // 真机踩坑：预览比源码短时，末尾若干块的 line 大于 maxScrollLine。
    // 若不剔除，tailLine < 最后一个锚点 line，端点表乱序，左屏到底只到 98.6%。
    const set: PreviewAnchorSet = {
      lines: [0, 2, 10, 18], // 18 > maxScrollLine=8
      tops: [0, 100, 600, 800],
      heights: [100, 500, 200, 200],
      totalHeight: 1000,
      totalSourceLines: 20,
      maxScrollLine: 8,
    };
    const vh = 400; // max = 600
    // 必须能精确到底（若 18 号锚点还在表里，查找会在它之前断掉）
    expect(mapSourceLineToPreviewScroll(set, 8, vh)).toBe(600);
    expect(mapPreviewScrollToSourceLine(set, 600, vh)).toBeCloseTo(8, 6);
    // 单调
    let prev = -Infinity;
    for (let line = 0; line <= 8; line += 0.25) {
      const v = mapSourceLineToPreviewScroll(set, line, vh)!;
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

// ═════════════ ①b lineAtMaxScroll：滚到底时视口顶所在行 ═════════════

describe("需求4 · lineAtMaxScroll：滚到底时视口顶所在行", () => {
  it("轴尾大于 maxScroll 时返回中间行（不是最后一行）", () => {
    // 轴：每行 100px，共 20 行 → 行 0..19 在 0..1900；maxScroll=1200 → 第 12 行
    const axis = Array.from({ length: 20 }, (_, i) => i * 100);
    expect(lineAtMaxScroll(axis, 1200)).toBeCloseTo(12, 6);
    // 真实场景：最后几行在视口下半部，永远顶不上去
    expect(lineAtMaxScroll(axis, 1200)).toBeLessThan(19);
  });

  it("轴尾 <= maxScroll（内容不足或刚好）→ 钳到最后一行", () => {
    const axis = Array.from({ length: 5 }, (_, i) => i * 100); // 0..400
    expect(lineAtMaxScroll(axis, 400)).toBeCloseTo(4, 6);
    expect(lineAtMaxScroll(axis, 99999)).toBeCloseTo(4, 6);
  });

  it("轴不可用 / maxScroll 非法 → null（调用方退回 totalSourceLines-1）", () => {
    expect(lineAtMaxScroll(null, 100)).toBeNull();
    expect(lineAtMaxScroll(undefined, 100)).toBeNull();
    expect(lineAtMaxScroll([0], 100)).toBeNull();
    expect(lineAtMaxScroll([0, 10, 20], 0)).toBeNull();
    expect(lineAtMaxScroll([0, 10, 20], Number.NaN)).toBeNull();
  });

  it("与 buildSourceLineAxis 配合：左屏到底 → 反算行 → 右屏到底（端到端闭环）", () => {
    // 造一个"末尾有 40 行空行"的文档轴：前 60 行每行 40px，后 40 行被吞掉但左屏仍占位
    const totalLines = 100;
    const blockLines = [0, 10, 20, 30, 40, 50];
    const blockTops = blockLines.map((l) => l * 40);
    const maxScroll = 60 * 40 - 1000 + 500; // 造一个"滚不到最后一行"的上限
    const axis = buildSourceLineAxis({ totalLines, blockLines, blockTops, maxScroll })!;
    const msLine = lineAtMaxScroll(axis, maxScroll)!;
    expect(msLine).toBeLessThan(totalLines - 1);
    // 用这根轴：滚到底估出的行 == msLine
    expect(
      estimateTopSourceLine({
        scrollTop: maxScroll, scrollHeight: maxScroll + 1000, clientHeight: 1000,
        totalSourceLines: totalLines, lineTops: axis,
      }),
    ).toBeCloseTo(msLine, 6);
  });
});

// ═════════════ ② 软换行：按行轴估算（不再线性） ═════════════

describe("需求4 · estimateTopSourceLine：软换行感知", () => {
  /**
   * 构造一个"逻辑行等高、但每 3 行有一条长行折 3 折"的文档：
   * 20 个逻辑行，视觉高度 = 20 行 + 长行额外折出的行数。
   *
   * 轴语义：`axis[i]` = 第 i 行的行盒顶部偏移；第 i 行的高度 = `axis[i+1] - axis[i]`。
   * 因此"长行"是**高度大**的那一行，即 `axis[i+1] - axis[i]` 大（循环里要按 i 而不是 i-1 判断）。
   */
  const shortH = 41; // 短行（29px 行盒 + 12px 段间距）
  const longH = 123; // 长行折 3 折
  const lines = 20;
  const maxScroll = 2000;
  const axis: number[] = [0];
  for (let i = 0; i < lines - 1; i++) {
    axis.push(axis[i] + (i % 3 === 0 ? longH : shortH));
  }
  // 末尾行对齐到可滚动上限（buildSourceLineAxis 的口径：滚到最后一行即滚到底）
  axis[lines - 1] = maxScroll;
  const contentH = maxScroll + 200;
  const metrics: SourceViewportMetrics = {
    scrollTop: 0,
    scrollHeight: contentH,
    clientHeight: 200,
    totalSourceLines: lines,
    lineTops: axis,
  };

  it("传了按行轴 → 顶部/底部精确落在首/末行", () => {
    expect(estimateTopSourceLine({ ...metrics, scrollTop: 0 })).toBe(0);
    expect(estimateTopSourceLine({ ...metrics, scrollTop: maxScroll })).toBeCloseTo(lines - 1, 6);
  });

  it("长行区间内不再按逻辑行线性跳跃（旧公式在这里偏后）", () => {
    // 第 12 行是长行（123px 高），它的中点对应 scrollTop = axis[12] + 61.5
    const midOfLong = axis[12] + longH / 2;
    const actual = estimateTopSourceLine({ ...metrics, scrollTop: midOfLong });
    expect(actual).toBeCloseTo(12.5, 6);
    // 旧线性公式（不传 lineTops）在同一 scrollTop 上给出的值明显不同
    const linear = estimateTopSourceLine({ ...metrics, scrollTop: midOfLong, lineTops: undefined });
    expect(Math.abs(linear - 12.5)).toBeGreaterThan(1);
  });

  it("不传按行轴 → 退回 v0.13.x 线性公式（向后兼容，旧断言不变）", () => {
    const m = { scrollHeight: 2100, clientHeight: 100, totalSourceLines: 101 };
    expect(estimateTopSourceLine({ ...m, scrollTop: 0 })).toBe(0);
    expect(estimateTopSourceLine({ ...m, scrollTop: 2000 })).toBe(100);
    expect(estimateTopSourceLine({ ...m, scrollTop: 1000 })).toBeCloseTo(50, 5);
  });

  it("轴长度不足 totalSourceLines → 视作不可用，退回线性（不产生越界行号）", () => {
    const v = estimateTopSourceLine({
      scrollTop: 1000,
      scrollHeight: 2100,
      clientHeight: 100,
      totalSourceLines: 101,
      lineTops: [0, 10, 20], // 太短
    });
    expect(v).toBeCloseTo(50, 5);
    expect(v).toBeLessThanOrEqual(100);
  });

  it("mapSourceLineToScrollTop 与 estimateTopSourceLine 在按行轴上严格互逆", () => {
    for (const line of [0, 3.5, 12.5, 19]) {
      const top = mapSourceLineToScrollTop(metrics, line)!;
      expect(estimateTopSourceLine({ ...metrics, scrollTop: top })).toBeCloseTo(line, 6);
    }
  });

  it("最后一行 → scrollTop = max（滚到末尾行即到底，保证两屏一起到底）", () => {
    expect(mapSourceLineToScrollTop(metrics, lines - 1)).toBe(maxScroll);
  });
});

// ═════════════ ③ 数量自校验：只数"内容元素" ═════════════

describe("需求4 · 锚点数量自校验：过滤脚本 / 第三方工具层", () => {
  it("isAnchorablePreviewChild：正文块一律可贴标", () => {
    for (const tag of ["H1", "P", "TABLE", "PRE", "HR", "UL", "BLOCKQUOTE", "DIV"]) {
      expect(isAnchorablePreviewChild(tag)).toBe(true);
    }
  });

  it("isAnchorablePreviewChild：渲染器注入的 script/style/link 不算正文块", () => {
    for (const tag of ["SCRIPT", "STYLE", "LINK", "META", "TEMPLATE", "NOSCRIPT"]) {
      expect(isAnchorablePreviewChild(tag)).toBe(false);
    }
    // 小写 / 带命名空间前缀的写法也要认
    expect(isAnchorablePreviewChild("script")).toBe(false);
  });

  it("isAnchorablePreviewChild：mermaid 挂到 body 的 mermaidTooltip 不算正文块", () => {
    expect(isAnchorablePreviewChild("DIV", "mermaidTooltip")).toBe(false);
    expect(isAnchorablePreviewChild("DIV", "foo mermaidTooltip bar")).toBe(false);
    // 正常类名不受影响
    expect(isAnchorablePreviewChild("DIV", "mermaid-preview-container")).toBe(true);
    expect(isAnchorablePreviewChild("DIV", "")).toBe(true);
    expect(isAnchorablePreviewChild("DIV", null)).toBe(true);
  });

  it("过滤后数量仍必须**严格相等**，否则照旧拒绝贴标（防错位）", () => {
    // 真机实测（v0140-probe-split-parity-anchors.mjs）：
    //   mermaid 文档 body.children = h1,p,p,table,pre,p,script,div.mermaidTooltip
    //   → 过滤后 6 个内容元素；块数 6 → 可以贴标（旧实现 8 ≠ 6，直接放弃）
    const bodyTags = ["h1", "p", "p", "table", "pre", "p", "script", "div"];
    const classes = ["", "", "", "", "mermaid", "", "", "mermaidTooltip"];
    const contentCount = bodyTags.filter((t, i) => isAnchorablePreviewChild(t, classes[i])).length;
    expect(contentCount).toBe(6);
    expect(shouldTagPreview(6, contentCount)).toBe(true);
    // 少一个/多一个仍然拒绝
    expect(shouldTagPreview(7, contentCount)).toBe(false);
    expect(shouldTagPreview(5, contentCount)).toBe(false);
    expect(shouldTagPreview(0, 0)).toBe(false);
  });
});

// ═════════════ ④ 单调性 / 回退链 ═════════════

describe("需求4 · 单调性与回退链", () => {
  const SET: PreviewAnchorSet = {
    lines: [0, 2, 33, 155, 157],
    tops: [78, 139, 1027, 1053, 1095],
    heights: [42, 864, 2, 29, 1152],
    totalHeight: 2299,
    totalSourceLines: 198,
  };

  it("左屏 scrollTop 增大 → 右屏映射值不减小（不来回拉扯）", () => {
    const axis = buildSourceLineAxis({
      totalLines: 198,
      blockLines: SET.lines,
      blockTops: SET.tops.map((t) => t - 78),
      maxScroll: 4531,
    })!;
    let prevLine = -Infinity;
    let prevScroll = -Infinity;
    for (let st = 0; st <= 4531; st += 17) {
      const line = estimateTopSourceLine({
        scrollTop: st, scrollHeight: 5781, clientHeight: 1250, totalSourceLines: 198, lineTops: axis,
      });
      expect(line).toBeGreaterThanOrEqual(prevLine);
      prevLine = line;
      const right = mapSourceLineToPreviewScroll(SET, line, 1251)!;
      expect(right).toBeGreaterThanOrEqual(prevScroll);
      prevScroll = right;
    }
  });

  it("右屏 scrollTop 增大 → 源码行不减小", () => {
    let prev = -Infinity;
    for (let st = -50; st <= 1200; st += 5) {
      const line = mapPreviewScrollToSourceLine(SET, st, 1251)!;
      expect(line).toBeGreaterThanOrEqual(prev);
      prev = line;
    }
  });

  it("内容不足一屏 → 不写坏 scrollTop（两方向都返回 0）", () => {
    const tiny: SourceViewportMetrics = {
      scrollTop: 40, scrollHeight: 300, clientHeight: 300, totalSourceLines: 20,
    };
    expect(estimateTopSourceLine(tiny)).toBe(0);
    expect(mapSourceLineToScrollTop(tiny, 12)).toBe(0);
    // 预览也不足一屏 → 目标恒为 0
    expect(mapSourceLineToPreviewScroll({ ...SET, totalHeight: 300 }, 100, 1251)).toBe(0);
  });

  it("空锚集 / 非有限值 → null（调用方退回百分比映射）", () => {
    expect(mapSourceLineToPreviewScroll({ ...SET, lines: [] }, 3, 1251)).toBeNull();
    expect(mapPreviewScrollToSourceLine({ ...SET, lines: [] }, 3, 1251)).toBeNull();
    expect(mapSourceLineToPreviewScroll(SET, Number.NaN, 1251)).toBeNull();
    expect(mapPreviewScrollToSourceLine(SET, Number.NaN, 1251)).toBeNull();
    expect(mapSourceLineToPreviewScroll({ ...SET, tops: [0, Number.NaN, 1027, 1053, 1095] }, 5, 1251)).toBeNull();
  });

  it("locateSourceLine 的段内插值区间用 tops 差（含块间外边距），不再用 height", () => {
    // 行 0..2 之间 tops 差 61px；若用 heights[0]=42 会把 61px 的空间压成 42px
    expect(locateSourceLine(SET, 1)).toEqual({ index: 0, ratio: 0.5 });
    // 行 33..155 之间 tops 差 26px（几乎贴在一起，因为中间 120 个空行被吞）
    expect(locateSourceLine(SET, 94)!.index).toBe(2);
    expect(locateSourceLine(SET, 94)!.ratio).toBeCloseTo((94 - 33) / (155 - 33), 9);
  });
});

// ═════════════ ⑤ buildSourceLineAxis：轴构造 ═════════════

describe("需求4 · buildSourceLineAxis：把块起始行补全成按行轴", () => {
  it("首尾端点齐全：第 0 行 = 0，最后一行 = maxScroll", () => {
    const axis = buildSourceLineAxis({
      totalLines: 10, blockLines: [2, 5], blockTops: [50, 200], maxScroll: 500,
    })!;
    expect(axis).toHaveLength(10);
    expect(axis[0]).toBe(0);
    expect(axis[9]).toBe(500);
  });

  it("块之间在行空间线性补全（与 locateSourceLine 的分段线性同构 → 往返恒等）", () => {
    const axis = buildSourceLineAxis({
      totalLines: 8, blockLines: [0, 4], blockTops: [0, 400], maxScroll: 800,
    })!;
    expect(axis[0]).toBe(0);
    expect(axis[1]).toBe(100);
    expect(axis[2]).toBe(200);
    expect(axis[4]).toBe(400);
    // 4..7 是尾部区间（最后一行 ↔ maxScroll），3 段均分 400 → 800
    expect(axis[5]).toBeCloseTo(400 + 400 / 3, 6);
    expect(axis[6]).toBeCloseTo(400 + (400 * 2) / 3, 6);
    expect(axis[7]).toBe(800);
  });

  it("非递减（测量噪声 / 钳制造成平台段也不回退）", () => {
    const axis = buildSourceLineAxis({
      totalLines: 6, blockLines: [1, 2, 3], blockTops: [100, 100, 90], maxScroll: 400,
    })!;
    for (let i = 1; i < axis.length; i++) expect(axis[i]).toBeGreaterThanOrEqual(axis[i - 1]);
  });

  it("无效测量点被跳过（行号越界 / 非有限 / 非递增）", () => {
    const axis = buildSourceLineAxis({
      totalLines: 6,
      blockLines: [-1, 1, 1, 3, 99],
      blockTops: [0, 100, 150, 250, 400],
      maxScroll: 400,
    })!;
    expect(axis[1]).toBe(100); // 第二个 (1,150) 因行号重复被跳过
    expect(axis[3]).toBe(250);
  });

  it("数据不可用 → null（totalLines ≤ 1 / maxScroll ≤ 0 / 无有效点）", () => {
    expect(buildSourceLineAxis({ totalLines: 1, blockLines: [0], blockTops: [0], maxScroll: 100 })).toBeNull();
    expect(buildSourceLineAxis({ totalLines: 10, blockLines: [0], blockTops: [0], maxScroll: 0 })).toBeNull();
    expect(
      buildSourceLineAxis({ totalLines: 10, blockLines: [99], blockTops: [0], maxScroll: 100 }),
    ).toBeNull();
  });

  it("末尾行本来就等于最后块起始行时：轴存**真实**行顶，靠钳制查询值实现'到底'", () => {
    // v0.14.0 实测修正：轴里不再伪造"最后一行 = maxScroll"。真实行顶是 120，
    // 滚到 maxScroll=300 时查询值被钳到 min(300, axis[last]=120) → 落在最后一行。
    const axis = buildSourceLineAxis({
      totalLines: 4, blockLines: [0, 3], blockTops: [0, 120], maxScroll: 300,
    })!;
    expect(axis[3]).toBe(120);
    // 但"最后一行 → 滚到底"仍成立（lineToY 的特例）
    expect(mapSourceLineToScrollTop({
      scrollTop: 0, scrollHeight: 300 + 100, clientHeight: 100, totalSourceLines: 4, lineTops: axis,
    }, 3)).toBe(300);
    // 滚到底 → 反算回最后一行
    expect(estimateTopSourceLine({
      scrollTop: 300, scrollHeight: 400, clientHeight: 100, totalSourceLines: 4, lineTops: axis,
    })).toBeCloseTo(3, 6);
  });
});

// ═════════════ ⑥ measureSourceLineAxis：DOM 测量契约 ═════════════

describe("需求4 · measureSourceLineAxis：mirror 实测行顶", () => {
  const created: HTMLElement[] = [];

  afterEach(() => {
    for (const el of created.splice(0)) el.remove();
  });

  /** 造一个 textarea 并 stub 掉所有几何测量（jsdom 不做布局） */
  function makeTextarea(text: string, lineTops: number[], opts?: { padTop?: number }) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    created.push(ta);
    Object.defineProperty(ta, "clientWidth", { configurable: true, value: 600 });
    Object.defineProperty(ta, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(ta, "scrollHeight", { configurable: true, value: 1000 });
    // getBoundingClientRect：mirror 容器返回 top=0；行标记按行号返回其行顶
    const counter = { n: 0 };
    ta.getBoundingClientRect = () => ({ top: 0, bottom: 400, left: 0, right: 600, width: 600, height: 400 }) as DOMRect;
    return { ta, lineTops, counter, padTop: opts?.padTop ?? 0 };
  }

  it("隐藏（clientWidth/clientHeight = 0）→ null（不写坏滚动）", () => {
    const ta = document.createElement("textarea");
    ta.value = "a\nb\nc";
    document.body.appendChild(ta);
    created.push(ta);
    // jsdom 默认 clientWidth/clientHeight 均为 0
    expect(measureSourceLineAxis({ textarea: ta, blockLines: [0, 1] })).toBeNull();
  });

  it("空文本 → null", () => {
    const { ta } = makeTextarea("", [0]);
    expect(measureSourceLineAxis({ textarea: ta, blockLines: [0] })).toBeNull();
  });

  it("单行文本 → null（无按行轴可言）", () => {
    const { ta } = makeTextarea("只有一行", [0]);
    expect(measureSourceLineAxis({ textarea: ta, blockLines: [0] })).toBeNull();
  });

  it("测量点在 jsdom 里全为 0（无布局）→ 退化为等距轴而不是崩掉", () => {
    const { ta } = makeTextarea("a\nb\nc\nd", [0, 2]);
    const got = measureSourceLineAxis({ textarea: ta, blockLines: [0, 2] });
    // jsdom 下所有 rect.top 都是 0 → buildSourceLineAxis 仍能给出非递减轴
    if (got) {
      expect(got.totalLines).toBe(4);
      expect(got.axis).toHaveLength(4);
      for (let i = 1; i < got.axis.length; i++) {
        expect(got.axis[i]).toBeGreaterThanOrEqual(got.axis[i - 1]);
      }
    }
    // 允许返回 null（无有效测量点时），但绝不能抛异常
    expect(got === null || Array.isArray(got.axis)).toBe(true);
  });

  it("mirror 用完即移除（不在 DOM 里留垃圾）", () => {
    const { ta } = makeTextarea("a\nb\nc\nd", [0, 2]);
    const before = document.body.children.length;
    measureSourceLineAxis({ textarea: ta, blockLines: [0, 2] });
    expect(document.body.children.length).toBe(before);
  });
});

// ═════════════ ⑦ 接线契约：EditorContainer 必须接上新参数 ═════════════

describe("需求4 · 接线契约（读源码断言，防止只改一半）", () => {
  const src = readFileSync("src/components/editor/EditorContainer.tsx", "utf-8");

  it("贴标基数改用 isAnchorablePreviewChild 过滤（否则 mermaid 文档 0 锚点）", () => {
    expect(src).toContain("isAnchorablePreviewChild");
    // 不能再直接用 body.children 的长度做数量校验
    expect(src).not.toContain("if (!shouldTagPreview(lines.length, children.length)) return false;");
  });

  it("左→右 与 右→左 都传了按行轴 / 视口高（软换行 + 末尾锚点生效）", () => {
    expect(src).toContain("measureSourceLineAxis(");
    expect(src).toContain("lineTops");
    // 右→左必须传 viewportHeight，否则右屏到底反算不到末行
    expect(src).toMatch(/mapPreviewScrollToSourceLine\(\s*anchors,\s*preview\.scrollTop,\s*preview\.clientHeight,?\s*\)/);
  });

  it("锚点采集把总源码行数带上（末尾锚点开关）", () => {
    expect(src).toContain("totalSourceLines: totalSourceLines()");
  });

  it("既有防线全部保留：方向锁 + 重入守卫 + 百分比回退", () => {
    expect(src).toContain('shouldAcceptScroll(lock, "source"');
    expect(src).toContain('shouldAcceptScroll(lock, "preview"');
    expect(src).toContain("if (isSyncingScrollRef.current) return;");
    expect(src).toContain("if (!handled) {");
    expect(src).toContain("preview.scrollTop = computeSyncScrollTop(");
  });
});
