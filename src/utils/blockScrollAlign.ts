/**
 * v0.13.1 需求13（按块定位对齐）：分屏"左 → 右"滚动的**块级对齐**纯函数层。
 *
 * ## 为什么要有这一层
 * 用户报告：「左屏编辑、右屏渲染因为篇幅问题会出现阅读位置偏差，例如左侧编辑图表，
 * 但右侧渲染要把屏幕往下拉一拉才能看到。所以这个滚动进度不能强绑定……可以考虑是否
 * 可以根据块来定位对齐」。
 *
 * 上一轮已把**方向**收紧为"只左 → 右"（右屏可独立滚动），并在内容重渲染后补了一次
 * 重同步。但那仍是**百分比**映射：`左屏 scrollTop / 左屏可滚动高度` ↔ 右屏同比例。
 * 百分比映射在"左右两侧块高差异大"时必然错位 —— 一个 3 行的 mermaid 源码在右侧可能
 * 渲染成 400px 高的图，同一百分比对应到的内容完全不同。
 *
 * 本层改用**块锚点**：找到左屏视口顶部对应的源码行 → 找到该行所属的顶层块在右侧的
 * 元素 → 把该元素对齐到右侧视口顶部。
 *
 * ## 分层
 * - 行号来源（markdown-it token → 源码行）在 `core/renderPipeline.ts`
 *   （`topLevelBlockStartLines`），本模块**只做算术与选择**，输入输出全是数字/数组，
 *   因此可以在 jsdom 里被精确单测（不依赖任何真实布局）。
 * - DOM 测量与写入（iframe 文档、textarea 度量）留在 `EditorContainer`。
 */

/** textarea（左屏源码）的度量 */
export interface SourceViewportMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** 源码总行数（≥1；按换行符切分的行数） */
  totalSourceLines: number;
}

/**
 * 估算"左屏视口顶部对应的源码行"（0-based，浮点）。
 *
 * textarea 的每一行等高等宽（`white-space: pre` + 统一行高），所以行号与滚动位置
 * 在可滚动区间内是**线性**的：`ratio = scrollTop / (scrollHeight - clientHeight)`。
 *
 * 边界：
 * - 内容不足一屏（`max <= 0`）→ 顶部恒为第 0 行；
 * - `scrollTop` 越界（滚动回弹/亚像素）→ 钳到 `[0, 1]`；
 * - 单行文档 → 恒为 0。
 */
export function estimateTopSourceLine(m: SourceViewportMetrics): number {
  const total = Math.max(0, Math.floor(m.totalSourceLines));
  if (total <= 1) return 0;
  const max = m.scrollHeight - m.clientHeight;
  if (!Number.isFinite(max) || max <= 0) return 0;
  const raw = m.scrollTop / max;
  const ratio = Math.min(1, Math.max(0, Number.isFinite(raw) ? raw : 0));
  // 最后一行是 total-1：滚到底应当对齐到"最后一个块"，而不是越过文档末尾
  return ratio * (total - 1);
}

/**
 * 在**升序**的顶层块起始行表里选出锚点下标。
 *
 * 规则：取 `srcLines[i] <= line` 的**最后一个**（即包含目标行的那一块）；
 * 目标行在第一个块之前（源码开头的空行/前言）→ 取第 0 块。
 *
 * @returns 下标；表为空时返回 -1（调用方应退回百分比映射）
 */
export function pickAnchorIndex(srcLines: number[], line: number): number {
  if (!Array.isArray(srcLines) || srcLines.length === 0) return -1;
  let best = 0;
  for (let i = 0; i < srcLines.length; i++) {
    if (srcLines[i] <= line) best = i;
    else break; // 升序：一旦超过目标行就不可能再命中
  }
  return best;
}

/**
 * 数量自校验：只有"顶层块数 === 预览顶层元素数"时才允许贴 `data-src-line`。
 *
 * 为什么保留这道校验：本渲染管线 `htmlBlockDisabled: true`，原始 HTML 被转义成段落，
 * 因此当前**实测数量总是相等**（见 v0131-block-scroll-align.test.ts）。但这条不变量
 * 依赖"每个顶层 token 恰好产出一个元素"这个实现细节 —— 一旦将来开启 html、
 * 或某个插件新增了没有 `map` 的 token、或渲染规则改成包裹/拆分元素，顺序就会整体错位。
 * 错位的后果比"退回百分比映射"严重得多（右侧跳到完全无关的位置），
 * 因此用一次 O(1) 的数量比较把它挡在门外。
 */
export function shouldTagPreview(blockCount: number, childCount: number): boolean {
  return blockCount > 0 && blockCount === childCount;
}

/**
 * 计算"把锚点块对齐到预览视口顶部"所需的 `scrollTop`（纯计算，已钳到合法区间）。
 *
 * @param previewScrollTop    预览当前 scrollTop
 * @param anchorTopInViewport 锚点元素的 `getBoundingClientRect().top`（含预览自身滚动偏移）
 * @param viewportTop         预览视口顶部的 `getBoundingClientRect().top`
 * @param maxScrollTop        预览可滚动上限（`scrollHeight - clientHeight`）
 */
export function computeBlockAlignedScrollTop(args: {
  previewScrollTop: number;
  anchorTopInViewport: number;
  viewportTop: number;
  maxScrollTop: number;
}): number {
  const { previewScrollTop, anchorTopInViewport, viewportTop, maxScrollTop } = args;
  const delta = anchorTopInViewport - viewportTop;
  if (!Number.isFinite(delta)) return previewScrollTop;
  const max = Number.isFinite(maxScrollTop) ? Math.max(0, maxScrollTop) : 0;
  const next = previewScrollTop + delta;
  if (!Number.isFinite(next)) return previewScrollTop;
  return Math.min(Math.max(0, next), max);
}
