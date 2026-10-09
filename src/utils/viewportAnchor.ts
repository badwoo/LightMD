/**
 * v0.12.0 需求4：窗口/侧栏尺寸变化时保持阅读焦点（滚动视口锚点）
 *
 * 问题背景：拖窗口边缘、折叠侧栏、拖分屏分割条都会改变滚动容器的宽度，
 * 文本重排后 scrollTop（像素）不变 → 视口内容漂移（用户读到中段时折叠侧栏，
 * 眼前内容整个跳走）。
 *
 * 方案：尺寸变化**前**记录"视口首个可见块 + 其相对视口顶的偏移"，
 * 重排完成后（ResizeObserver 回调即重排后）量该块的新位置，用差值补偿 scrollTop。
 *
 * 两类锚点：
 * - 块锚点（阅读模式 .editor-container / 分屏 iframe 的文档滚动元素）：
 *   首个可见顶层块 + 偏移，块级粒度（避免落在被软换行拆开的行内节点上）；
 * - 行锚点（编辑/分屏左侧 textarea）：scrollTop 换算的**浮点行索引**
 *   （含行内偏移比例），行高变化（字号/缩放）后按新行高还原——textarea 无子元素，
 *   块锚点不适用。
 *
 * 副作用：补偿触发 scroll 事件 → fileScrollProgress 自动记录新百分比，
 * 无需额外处理。内容不足一屏（无可滚动空间）时跳过，不抖动不报错。
 */
import { resolveLineHeight, measureOffsetViewportY } from "./focus-paragraph";

/** 块锚点：某顶层元素在"尺寸变化前"相对容器视口顶部的偏移 */
export interface ViewportAnchor {
  /** 锚点元素（尺寸变化前视口内的第一个可见顶层块） */
  el: Element;
  /** 尺寸变化前：元素顶部相对容器视口顶部的偏移 px（可为负——块被滚出视口一部分） */
  offsetTop: number;
}

/**
 * 捕获块锚点：取视口内第一个"底部可见"的顶层块。
 *
 * @param container 滚动容器（阅读模式传 .editor-container；iframe 传其文档滚动元素）
 * @param blockSelector 顶层块选择器（默认容器直接子元素；阅读模式传 ".ProseMirror > *"
 *   以聚焦到段落/标题等块，避免只锚到整个 .ProseMirror）
 */
export function captureAnchor(
  container: Element,
  blockSelector = ":scope > *",
): ViewportAnchor | null {
  // 内容不足一屏 → 无滚动空间，无需补偿
  if (container.scrollHeight <= container.clientHeight) return null;
  const containerRect = container.getBoundingClientRect();
  let blocks: Element[];
  try {
    blocks = Array.from(container.querySelectorAll(blockSelector));
  } catch {
    return null;
  }
  for (const el of blocks) {
    const rect = el.getBoundingClientRect();
    // 第一个底部越过容器顶部的块 = 视口首个可见块（+1 容忍亚像素）
    if (rect.bottom > containerRect.top + 1) {
      return { el, offsetTop: rect.top - containerRect.top };
    }
  }
  return null;
}

/**
 * 恢复块锚点：量锚点块的新位置，把偏差补回 scrollTop（clamp 到合法范围）。
 * 锚点元素已从文档移除（如文件重载）或内容不足一屏时放弃。
 */
export function restoreAnchor(
  container: Element,
  anchor: ViewportAnchor | null | undefined,
): void {
  if (!anchor || !anchor.el || !anchor.el.isConnected) return;
  if (container.scrollHeight <= container.clientHeight) return;
  const containerRect = container.getBoundingClientRect();
  const rect = anchor.el.getBoundingClientRect();
  const delta = rect.top - containerRect.top - anchor.offsetTop;
  if (Math.abs(delta) < 0.5) return;
  const max = container.scrollHeight - container.clientHeight;
  container.scrollTop = Math.max(0, Math.min(max, container.scrollTop + delta));
}

/**
 * 捕获 textarea 行锚点：scrollTop 换算的浮点行索引（1 行 = 1 个 line-height，
 * 小数部分保留行内偏移比例）。padding-top 的不变常量在两次测量中抵消，
 * 不影响还原正确性。
 */
export function captureLineAnchor(textarea: HTMLTextAreaElement): number | null {
  if (textarea.scrollHeight <= textarea.clientHeight) return null;
  const lineHeight = resolveLineHeight(getComputedStyle(textarea));
  if (!(lineHeight > 0)) return null;
  const paddingTop = parseFloat(getComputedStyle(textarea).paddingTop) || 0;
  return (textarea.scrollTop - paddingTop) / lineHeight;
}

/** 恢复 textarea 行锚点：按**当前行高**（可能因字号/缩放变化）还原滚动位置 */
export function restoreLineAnchor(
  textarea: HTMLTextAreaElement,
  lineIndex: number | null | undefined,
): void {
  if (lineIndex === null || lineIndex === undefined) return;
  const lineHeight = resolveLineHeight(getComputedStyle(textarea));
  if (!(lineHeight > 0)) return;
  const paddingTop = parseFloat(getComputedStyle(textarea).paddingTop) || 0;
  const target = paddingTop + lineIndex * lineHeight;
  const max = textarea.scrollHeight - textarea.clientHeight;
  textarea.scrollTop = Math.max(0, Math.min(max, target));
}

// ─── v0.12.0 返修：textarea 内容锚点（编辑/分屏模式窗口缩放保持焦点） ──────────

/**
 * textarea 内容锚点：视口顶部那一行内容的**字符偏移** + 其视口 Y 偏移。
 *
 * 为什么不用行索引锚点（captureLineAnchor）：行索引 = scrollTop / lineHeight，是
 * **视觉行**序号。textarea 的 `white-space: pre-wrap` 会软换行，宽度变化后同一视觉行
 * 序号指向完全不同的内容（行索引在本行高不变时还原结果 = 原 scrollTop，等于没补偿）。
 * 字符偏移锚点直接绑定"视口顶部看到的是哪一段内容"，宽度重排 / 行高变化后都能准确回到。
 */
export interface TextContentAnchor {
  /** 视口顶部（第一个可见）字符偏移 */
  offset: number;
  /** 该偏移字符相对视口顶部的 Y（通常 0 ~ +lineHeight；可为微小负值） */
  viewportY: number;
}

/**
 * 纯逻辑：在 [0, length) 上二分查找"Y 首次 >= targetY"的偏移。
 * Y(offset) 随偏移单调不减（文本自上而下流式排列）。测量函数由调用方注入，便于单测。
 */
export function findFirstOffsetAtOrBelow(
  length: number,
  targetY: number,
  measureY: (offset: number) => number,
): number {
  if (length <= 0) return 0;
  let lo = 0;
  let hi = length - 1;
  if (measureY(hi) < targetY) return hi;
  if (measureY(lo) >= targetY) return lo;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (measureY(mid) >= targetY) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * 捕获 textarea 内容锚点（视口顶部字符偏移 + 其视口 Y）。
 * 内容不足一屏 / 空文本 / 无法测量时返回 null（调用方跳过补偿）。
 */
export function captureTextAnchor(textarea: HTMLTextAreaElement): TextContentAnchor | null {
  if (textarea.scrollHeight <= textarea.clientHeight) return null;
  const text = textarea.value;
  if (!text) return null;
  const offset = findFirstOffsetAtOrBelow(
    text.length,
    0,
    (o) => measureOffsetViewportY(textarea, o) ?? -Infinity,
  );
  const y = measureOffsetViewportY(textarea, offset);
  if (y === null) return null;
  return { offset, viewportY: y };
}

/**
 * 恢复 textarea 内容锚点：量该偏移字符的新视口 Y，把偏差补回 scrollTop（clamp）。
 * 偏移越界（内容被替换/缩短）或无法测量时安全返回。
 */
export function restoreTextAnchor(
  textarea: HTMLTextAreaElement,
  anchor: TextContentAnchor | null | undefined,
): void {
  if (!anchor) return;
  const text = textarea.value;
  if (!text || anchor.offset >= text.length) return;
  const y = measureOffsetViewportY(textarea, anchor.offset);
  if (y === null) return;
  const delta = y - anchor.viewportY;
  if (Math.abs(delta) < 0.5) return;
  const max = textarea.scrollHeight - textarea.clientHeight;
  textarea.scrollTop = Math.max(0, Math.min(max, textarea.scrollTop + delta));
}