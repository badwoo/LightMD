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

// ─── v0.13.2 需求8：**双向映射**滚动（左右屏不共用滚动条） ─────────────────

/**
 * 右侧渲染区的"行号表 ↔ 元素"锚点结构。
 *
 * 由 `EditorContainer` 在贴完 `data-src-line` 后构造，纯函数层只做算术。
 */
export interface PreviewAnchorSet {
  /** 升序的顶层块源码起始行（0-based） */
  lines: number[];
  /** 各锚点元素相对预览内容顶部的偏移（px，已扣除滚动） */
  tops: number[];
  /** 各锚点元素的高度（px） */
  heights: number[];
  /** 预览内容总高（px） */
  totalHeight: number;
}

/**
 * 在 `PreviewAnchorSet` 里定位"某个源码行"落在哪个块、块内比例多少。
 *
 * @returns `{ index, ratio }`；表为空时 null
 */
export function locateSourceLine(
  set: PreviewAnchorSet,
  line: number,
): { index: number; ratio: number } | null {
  const { lines } = set;
  if (!Array.isArray(lines) || lines.length === 0) return null;
  const idx = pickAnchorIndex(lines, line);
  if (idx < 0) return null;
  // 块内比例：本块起始行 → 下一块起始行
  const startLine = lines[idx];
  const endLine = idx + 1 < lines.length ? lines[idx + 1] : startLine + 1;
  const span = Math.max(1, endLine - startLine);
  const ratio = Math.min(1, Math.max(0, (line - startLine) / span));
  return { index: idx, ratio };
}

/**
 * v0.13.2 需求8：**左 → 右**（源码行 → 预览 scrollTop）。
 *
 * 用户要求：「左右两屏不是共用滚动条，而是映射关系。因为左屏的文档长度会比右屏
 * 渲染的文档长度小，如果共用滚动条就导致左右看到的内容不一致或有偏差，
 * 所以要实现左右两屏能联动滚动，但左右两屏看到的内容尽量能对齐。」
 *
 * 映射口径：源码行 → 它所属的**顶层块** → 该块在右侧的**块内比例位置**。
 * 与百分比映射的本质差别：块内比例只在**同一个块**里线性，跨块时按块的真实高度
 * 跳转，因此 3 行 mermaid 源码 ↔ 400px 的图也能对齐到同一个块。
 *
 * @returns 目标 scrollTop（已钳到 [0, maxScrollTop]）；数据不可用时 null（调用方退回百分比）
 */
export function mapSourceLineToPreviewScroll(
  set: PreviewAnchorSet,
  line: number,
  viewportHeight: number,
): number | null {
  const loc = locateSourceLine(set, line);
  if (!loc) return null;
  const top = set.tops[loc.index];
  const height = set.heights[loc.index];
  if (!Number.isFinite(top) || !Number.isFinite(height)) return null;
  // 块内比例位置对齐到视口顶部；减去一点余量让读者能看到该行的上文
  const target = top + height * loc.ratio;
  const max = Math.max(0, set.totalHeight - viewportHeight);
  if (!Number.isFinite(target)) return null;
  return Math.min(Math.max(0, target), max);
}

/**
 * v0.13.2 需求8：**右 → 左**（预览 scrollTop → 源码行）。
 *
 * 找到预览视口顶部落在哪个块内、块内比例多少，反算源码行。
 *
 * @returns 源码行（0-based，浮点）；数据不可用时 null
 */
export function mapPreviewScrollToSourceLine(
  set: PreviewAnchorSet,
  scrollTop: number,
): number | null {
  const { lines, tops, heights } = set;
  if (!Array.isArray(lines) || lines.length === 0) return null;
  if (!Number.isFinite(scrollTop)) return null;
  // 找"内容偏移 ≤ scrollTop 的最后一个块"（含块底边界的归属）
  let idx = 0;
  for (let i = 0; i < tops.length; i++) {
    if (Number.isFinite(tops[i]) && tops[i] <= scrollTop) idx = i;
    else break;
  }
  const top = tops[idx];
  const height = heights[idx];
  if (!Number.isFinite(top) || !Number.isFinite(height)) return null;
  const ratio = height > 0 ? Math.min(1, Math.max(0, (scrollTop - top) / height)) : 0;
  const startLine = lines[idx];
  const endLine = idx + 1 < lines.length ? lines[idx + 1] : startLine + 1;
  const span = Math.max(1, endLine - startLine);
  return startLine + span * ratio;
}

/**
 * v0.13.2 需求8：源码行 → 左屏 textarea 的 scrollTop（右 → 左联动的落点）。
 *
 * textarea 行等高等宽，行号与滚动位置在可滚动区间内线性
 * （与 `estimateTopSourceLine` 互为逆运算）。
 *
 * @returns 目标 scrollTop（已钳到 [0, maxScrollTop]）；行数不可用时 null
 */
export function mapSourceLineToScrollTop(m: SourceViewportMetrics, line: number): number | null {
  const total = Math.max(0, Math.floor(m.totalSourceLines));
  if (total <= 1) return 0;
  const max = m.scrollHeight - m.clientHeight;
  if (!Number.isFinite(max) || max <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, line / (total - 1)));
  if (!Number.isFinite(ratio)) return null;
  return ratio * max;
}
