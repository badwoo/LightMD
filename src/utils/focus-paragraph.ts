/**
 * 源码模式专注遮罩行定位工具
 *
 * 在 textarea 中实现专注模式时，需要根据光标位置定位其所在行的起止字符位置，
 * 进而计算行在 textarea 视口中的 Y 坐标范围，用于绘制遮罩。
 *
 * 行定义：以单个 \n 分隔的连续文本块（行级高亮，非段落级）。
 * 文档开头和结尾自动视为行边界。
 *
 * 选择"行级"而非"段落级"的原因：
 * 源码模式下用户编辑的是 markdown 源码，每行独立可见。用户按回车键换行时，
 * 期望专注高亮立即跟随到新行。若按 markdown 段落语义（\n\n 分隔），
 * 单次回车不会创建新段落，高亮不跟随，用户体验不佳。
 *
 * ─── mirror div 测量方案（修复软换行导致的 Y 坐标偏移）──────
 * textarea 配置 `white-space: pre-wrap; word-break: break-word;` 会导致长行软换行，
 * 基于硬换行（\n）计算的行号与实际显示行号不一致，多行后高亮位置偏上
 * （用户报告"高亮在点击位置的上一行"）。
 *
 * 修复方案：创建与 textarea 样式一致的隐藏 mirror div，复制文本内容，
 * 在行起止位置插入 span 标记，通过 getBoundingClientRect 测量实际 Y 坐标。
 * 该方案能准确处理软换行，是业界标准做法（VS Code、Atlassian 等均采用）。
 */

/** 行在文档中的字符位置区间 [start, end) */
export interface ParagraphRange {
  /** 行起始字符位置（含） */
  start: number;
  /** 行结束字符位置（不含） */
  end: number;
}

/**
 * 根据光标位置查找其所在行的字符位置区间
 *
 * 算法：
 * - 向前扫描：从光标前一位开始，找到第一个 \n 位置，行起点为该位置后一位
 * - 向后扫描：从光标位置开始，找到第一个 \n 位置，行终点为该位置
 * - 文档边界（0 和 length）自动作为行边界
 *
 * @param text 文档全文
 * @param cursorPos 光标字符位置
 * @returns 行区间 [start, end)
 */
export function findParagraphRange(text: string, cursorPos: number): ParagraphRange {
  // 钳制光标位置到合法范围
  const pos = Math.max(0, Math.min(cursorPos, text.length));

  // 向前查找行起点：找到前一个 \n 之后的字符位置
  let start = 0;
  for (let i = pos - 1; i >= 0; i--) {
    if (text[i] === "\n") {
      start = i + 1;
      break;
    }
  }

  // 向后查找行终点：找到下一个 \n 之前的字符位置
  let end = text.length;
  for (let i = pos; i < text.length; i++) {
    if (text[i] === "\n") {
      end = i;
      break;
    }
  }

  // 防御性处理：若起点越过终点（不应发生），返回光标位置
  if (start > end) {
    return { start: pos, end: pos };
  }
  return { start, end };
}

/**
 * 计算段落起止行号（基于 0 的行号）
 *
 * @param text 文档全文
 * @param range 段落字符区间
 * @returns { startLine, endLine } startLine 为段落首行的行号，endLine 为段落末行的行号
 */
export function paragraphLineRange(
  text: string,
  range: ParagraphRange
): { startLine: number; endLine: number } {
  // 段落起点之前的换行符数量 = 段落首行行号
  const startLine = countNewlines(text.substring(0, range.start));
  // 段落终点之前的换行符数量 = 段落末行行号
  const endLine = countNewlines(text.substring(0, range.end));
  return { startLine, endLine };
}

/** 计算 string 中 \n 的数量 */
function countNewlines(s: string): number {
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) count++;
  }
  return count;
}

/**
 * 从 CSSStyleDeclaration 解析有效的 line-height 像素值
 *
 * 修复 bug：
 * 1. getComputedStyle 对 textarea 可能返回 "normal"，parseFloat 得到 NaN
 * 2. CSS line-height 设为无单位相对值（如 `line-height: 1.8`）时，
 *    getComputedStyle 返回字符串 "1.8"，parseFloat 得到 1.8（不是像素值），
 *    直接使用会导致每行偏移 27px（28.8 - 1.8），多行后高亮位置完全错位
 *    （用户报告的"高亮在点击位置的上一行"即由此产生）。
 *
 * 回退策略：
 * 1. 像素值字符串（"28.8px"）：直接使用 parseFloat 结果
 * 2. 无单位相对值（"1.8"）：用 fontSize * 相对值 计算像素值
 * 3. "normal" 或无效值：用 fontSize * 1.8 推算
 *    （editor.css 中 .source-editor 与 .ProseMirror 均为 line-height: 1.8）
 * 4. 若 fontSize 也无效，使用 16 * 1.8 = 28.8 作为最终兜底
 *
 * @param cs 元素的 getComputedStyle 结果
 * @returns 有效的 line-height 像素值
 */
export function resolveLineHeight(cs: CSSStyleDeclaration): number {
  const raw = cs.lineHeight;
  const lh = parseFloat(raw);
  // 无效或非正值：回退到 fontSize * 1.8
  if (isNaN(lh) || lh <= 0) {
    const fontSize = parseFloat(cs.fontSize) || 16;
    return fontSize * 1.8;
  }
  // 像素值（含 "px" 单位）：直接返回
  if (typeof raw === "string" && raw.includes("px")) {
    return lh;
  }
  // 无单位相对值（如 "1.8"）：需乘以 fontSize 才得到像素值
  // 判定：lh 在典型相对值范围（0.5~5），且字符串非 "px" 结尾
  // 注意：像素值通常 >= 10，相对值通常在 [0.8, 3.0] 区间
  const fontSize = parseFloat(cs.fontSize) || 16;
  return fontSize * lh;
}

// ─── mirror div 测量方案 ────────────────────────────
// 通过创建与 textarea 样式一致的隐藏 div，复制文本并测量 DOM 元素位置，
// 准确获取段落起止 Y 坐标，解决软换行导致的行号计算偏移问题。

/** mirror div 缓存：通过 WeakMap 与 textarea 关联，避免重复创建 */
const mirrorCache = new WeakMap<HTMLTextAreaElement, HTMLDivElement>();

/**
 * 获取或创建与 textarea 关联的 mirror div
 *
 * mirror div 复用策略：通过 WeakMap 缓存，textarea 销毁时自动 GC
 * 创建后挂载到 textarea 的父节点（确保继承相同的环境样式）
 */
function getOrCreateMirror(textarea: HTMLTextAreaElement): HTMLDivElement {
  let mirror = mirrorCache.get(textarea);
  if (mirror) return mirror;
  mirror = document.createElement("div");
  // 固定样式：绝对定位、不可见、不影响布局
  mirror.setAttribute("aria-hidden", "true");
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  mirror.style.zIndex = "-1";
  mirror.style.overflow = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.wordBreak = "break-word";
  mirror.style.borderStyle = "solid";
  // 挂载到 body（避免父容器布局影响）
  document.body.appendChild(mirror);
  mirrorCache.set(textarea, mirror);
  return mirror;
}

/**
 * 同步 mirror div 的样式与 textarea 一致
 *
 * 关键样式：box-sizing、width、padding、font、line-height、border
 * 这些样式直接影响文本布局和软换行行为，必须与 textarea 完全一致
 *
 * 宽度对齐原理（关键）：
 * - textarea 的 clientWidth = 可用 content width + padding（不含 border、不含 scrollbar 占用区域）
 * - textarea 是 border-box 时，offsetWidth = border + padding + content（含 scrollbar 占用区域）
 * - scrollbar 占用 content 区域，使"可用 content width" = content area - scrollbar
 * - mirror 无 scrollbar，要使 mirror 的 content width = textarea 的可用 content width
 * - mirror 使用 border-box，width = border + padding + 可用 content width
 *   = border + clientWidth = clientWidth + borderLeft + borderRight
 *
 * 注意：clientWidth 已不含 scrollbar 占用区域，所以不需要再减去 scrollbar 宽度
 */
function syncMirrorStyle(textarea: HTMLTextAreaElement, mirror: HTMLDivElement): void {
  const cs = getComputedStyle(textarea);
  const borderLeft = parseFloat(cs.borderLeftWidth) || 0;
  const borderRight = parseFloat(cs.borderRightWidth) || 0;
  // mirror 使用 border-box，width = clientWidth + border
  // 这样 mirror 的 content width = textarea 的可用 content width（软换行行为一致）
  const width = textarea.clientWidth + borderLeft + borderRight;

  mirror.style.boxSizing = "border-box";
  mirror.style.width = `${width}px`;
  mirror.style.paddingTop = cs.paddingTop;
  mirror.style.paddingRight = cs.paddingRight;
  mirror.style.paddingBottom = cs.paddingBottom;
  mirror.style.paddingLeft = cs.paddingLeft;
  mirror.style.fontFamily = cs.fontFamily;
  mirror.style.fontSize = cs.fontSize;
  mirror.style.fontWeight = cs.fontWeight;
  mirror.style.lineHeight = cs.lineHeight;
  mirror.style.letterSpacing = cs.letterSpacing;
  mirror.style.tabSize = cs.tabSize;
  mirror.style.borderTopWidth = cs.borderTopWidth;
  mirror.style.borderRightWidth = cs.borderRightWidth;
  mirror.style.borderBottomWidth = cs.borderBottomWidth;
  mirror.style.borderLeftWidth = cs.borderLeftWidth;
}

/**
 * 使用 mirror div 测量 textarea 中指定字符区间 [startPos, endPos) 的实际 Y 坐标
 *
 * 算法：
 * 1. 创建/复用与 textarea 样式一致的 mirror div
 * 2. 在 mirror 中插入完整文本，但在 startPos 处插入空 span 作为起始标记，
 *    在 endPos 处插入空 span 作为结束标记
 * 3. 通过 getBoundingClientRect 测量两个 span 的 Y 坐标
 * 4. 减去 textarea.scrollTop 转换为 textarea 视口坐标
 *
 * 坐标系换算：
 * - mirror 的 padding-top 与 textarea 一致，scrollTop=0
 * - startMarkerRect.top - mirrorRect.top = mirror 顶部到标记点的距离
 *   （此距离已包含 padding-top，等于 textarea 中标记点的"文档坐标"）
 * - textarea 视口坐标 = 文档坐标 - scrollTop
 *
 * 优势：
 * - 准确处理软换行（white-space: pre-wrap 导致的长行自动换行）
 * - 不依赖硬换行计数，避免行号累计偏移
 *
 * @param textarea 目标 textarea 元素
 * @param startPos 段落起始字符位置（含）
 * @param endPos 段落结束字符位置（不含）
 * @returns { startY, endY } 段落起止 Y 坐标（相对 textarea 视口顶部）
 */
export function measureTextareaRangeY(
  textarea: HTMLTextAreaElement,
  startPos: number,
  endPos: number
): { startY: number; endY: number } {
  const mirror = getOrCreateMirror(textarea);
  syncMirrorStyle(textarea, mirror);

  const text = textarea.value;
  const beforeStart = text.substring(0, startPos);
  const between = text.substring(startPos, endPos);
  const afterEnd = text.substring(endPos);

  // 构建 mirror 内容：在段落起止位置插入 span 标记
  // startMarker 是空 span，其位置即为段落起点
  // contentSpan 包含段落内容，其 bottom 即为段落终点
  mirror.innerHTML = "";
  mirror.appendChild(document.createTextNode(beforeStart));
  const startMarker = document.createElement("span");
  mirror.appendChild(startMarker);
  const contentSpan = document.createElement("span");
  contentSpan.textContent = between;
  mirror.appendChild(contentSpan);
  mirror.appendChild(document.createTextNode(afterEnd));

  // 测量标记位置
  const mirrorRect = mirror.getBoundingClientRect();
  const startMarkerRect = startMarker.getBoundingClientRect();
  const contentSpanRect = contentSpan.getBoundingClientRect();

  // 段落起止 Y 坐标（相对 textarea 视口顶部）
  // startMarkerRect.top - mirrorRect.top = mirror 顶部到段落起点的距离（含 padding-top）
  // 这等于 textarea 中段落起点的"文档坐标"（无滚动时的 Y）
  // 减去 scrollTop 得到 textarea 视口坐标
  const startY = startMarkerRect.top - mirrorRect.top - textarea.scrollTop;
  const endY = contentSpanRect.bottom - mirrorRect.top - textarea.scrollTop;

  return { startY, endY };
}

/**
 * 销毁与 textarea 关联的 mirror div（textarea 卸载时调用）
 */
export function destroyMirror(textarea: HTMLTextAreaElement): void {
  const mirror = mirrorCache.get(textarea);
  if (mirror) {
    mirror.remove();
    mirrorCache.delete(textarea);
  }
}

/**
 * 使用 mirror div 测量 textarea 中指定字符位置的 Y 坐标（相对内容顶部）
 *
 * 用于打字机模式：准确获取光标所在位置的 Y 坐标，计算居中滚动位置。
 * 与基于硬换行的计算不同，本函数能准确处理软换行场景。
 *
 * @param textarea 目标 textarea 元素
 * @param cursorPos 光标字符位置
 * @returns 光标位置的 Y 坐标（相对 textarea 内容顶部，不含 padding-top）
 */
export function measureTextareaCursorY(
  textarea: HTMLTextAreaElement,
  cursorPos: number
): number {
  const mirror = getOrCreateMirror(textarea);
  syncMirrorStyle(textarea, mirror);

  const text = textarea.value;
  const before = text.substring(0, cursorPos);
  const after = text.substring(cursorPos);

  mirror.innerHTML = "";
  mirror.appendChild(document.createTextNode(before));
  const marker = document.createElement("span");
  mirror.appendChild(marker);
  mirror.appendChild(document.createTextNode(after));

  const mirrorRect = mirror.getBoundingClientRect();
  const markerRect = marker.getBoundingClientRect();

  // 光标 Y 坐标（相对 textarea 内容顶部，不含 padding-top）
  // markerRect.top - mirrorRect.top = mirror 顶部到光标的距离（含 padding-top）
  // 减去 padding-top 得到相对内容顶部的距离
  const paddingTop = parseFloat(getComputedStyle(textarea).paddingTop) || 0;
  return markerRect.top - mirrorRect.top - paddingTop;
}
