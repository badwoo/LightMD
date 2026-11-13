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

/** v0.12.0 需求9：专注模式多行聚焦区间（编辑/分屏模式用） */
export interface FocusRowRange {
  /** 区间起始字符位置（含） */
  start: number;
  /** 区间结束字符位置（不含） */
  end: number;
  /** 区间包含的硬换行行数（1 起） */
  rows: number;
}

/**
 * v0.12.0 需求9：取光标所在行 ± radius 行的合并区间（「上一行/当前行/下一行」全亮区）。
 *
 * 与 findParagraphRange 的区别：后者只返回光标所在单行；本函数向上下各扩
 * radius 行（默认 1 → 3 行窗），文档边界处自动收缩（首行 → 2 行、单行文档 → 1 行）。
 * 区间右端点取「下 radius 行」的行末换行符位置（不含），因此行间换行符包含在
 * 区间内部——若不含，换行处的空白仍是遮罩、亮区视觉断裂。
 *
 * 软换行说明：按 \n 切分，同一 \n 段内的自动折行整体位于区间内，属符合预期
 * （亮区 = 光标所在硬行段 ±radius 个硬行段）。
 *
 * @param text 文档全文
 * @param cursorPos 光标字符位置
 * @param radius 上下扩展的行数（默认 1；0 时退化为 findParagraphRange 语义）
 */
export function findFocusRowRange(text: string, cursorPos: number, radius = 1): FocusRowRange {
  const pos = Math.max(0, Math.min(cursorPos, text.length));
  // 需要越过的换行符个数：向前第 want 个 \n 界定「上 radius 行」的起点，
  // 向后第 want 个 \n 界定「下 radius 行」的末尾（光标恰在 \n 上时计入当前行末尾）
  const want = Math.max(0, Math.floor(radius)) + 1;

  // 向前：第 want 个 \n 的后一位 = 区间起点（不足则收缩到文档开头）
  let start = 0;
  let seen = 0;
  for (let i = pos - 1; i >= 0; i--) {
    if (text[i] === "\n") {
      seen++;
      if (seen === want) {
        start = i + 1;
        break;
      }
    }
  }

  // 向后：第 want 个 \n 的位置 = 区间终点（不含；不足则收缩到文档末尾）
  let end = text.length;
  seen = 0;
  for (let i = pos; i < text.length; i++) {
    if (text[i] === "\n") {
      seen++;
      if (seen === want) {
        end = i;
        break;
      }
    }
  }

  // 防御性处理：若起点越过终点（不应发生），返回光标位置
  if (start > end) {
    return { start: pos, end: pos, rows: 1 };
  }
  return { start, end, rows: countNewlines(text.substring(start, end)) + 1 };
}

/** `resolveFocusMeasureRange` 的结果：真正该喂给 `measureRangeContentY` 的区间 */
export interface FocusMeasureSpec {
  /** 测量区间起点（喂 `measureRangeContentY(start, end)` 的 start） */
  start: number;
  /** 测量区间终点（喂 `measureRangeContentY(start, end)` 的 end） */
  end: number;
  /**
   * 是否需要在测量结果上**再补一行高**。
   *
   * 仅在「窗口末行是**文档末尾**的空行」时为 true —— 那种情况没有"下一个字符"可借位，
   * 测量函数拿不到该空行的字形矩形（空行没有任何字符），只能事后补一行高。
   */
  extendEndByLineHeight: boolean;
  /** 诊断用：窗口末行是否为空行（= 命中了本次要修的缺陷形态） */
  lastLineEmpty: boolean;
}

/**
 * v0.17.0 第三轮缺陷 #7：把「专注 3 行窗」的字符区间翻译成**测量区间**。
 *
 * ## 为什么需要这道翻译（用户："空白行情况下只高亮了两行"）
 *
 * `findFocusRowRange` 返回的 `[start, end)` 语义是「**完整行**」：`end` 是
 * 「窗口末行之后那个 `\n` 的**下标**」（不含）。所以区间 `[start, end)` 里的
 * 内容形如 `"第1行\n第2行\n第3行"`，**不含**末行之后的换行符。
 *
 * 而 `SourceSurface.measureRangeContentY(start, end)` 的契约是
 * 「字符**字形矩形**」，实现里用 `coordsAtPos(end - 1)` 取「区间最后一个字符」的 bottom。
 *
 * 两个契约单独看都对，**组合起来在一种排版上就错**：窗口末行是**空行**时，
 * 该行没有任何字符，`end - 1` 落到了**上一行末尾的那个 `\n`** 上 →
 * `coordsAtPos` 给出的是**上一行的行尾 bottom** → 空行的行盒完全没被覆盖。
 *
 * ```
 * 文档:  正文A ␤ ␤ 正文B
 *             ↑  ↑
 *           end-1 end        ← 光标在 正文A 时，窗口末行是那个空行
 * 旧: measureRangeContentY(start, end)      → endY = 正文A 行底  ❌ 空行不亮
 * 新: measureRangeContentY(start, end + 1)  → endY = 空行行底    ✅
 * ```
 *
 * ## 为什么这个缺陷是**主路径**而不是边角情况
 *
 * markdown 用空行分隔段落，所以「窗口末行是空行」在正常文档里**极其常见**
 * （段落之间、标题与正文之间都有空行）。实测：光标在普通段落中间时，
 * 因为下一行恰好是空行，亮区只盖住 2 行 —— 用户几乎在任何位置都会看到"只亮两行"。
 *
 * ## 借位（`end + 1`）为什么能修好
 *
 * `end + 1` 之后 `measureRangeContentY` 内部的 `end - 1` 变成 `end`，
 * 而 `end` 正是那个**充当空行行界的 `\n`**。`coordsAtPos(该 `\n`)` 返回的是
 * 空行自身的行盒（该位置既是空行行首、也是空行行尾）→ bottom 就是空行行底。
 *
 * ⚠️ **必须有上界护栏**：`end + 1` 不能超过 `text.length`（越界会让
 * `coordsAtPos` 抛错 / 被 clamp 成错误位置）。文档以 `\n` 结尾时窗口末行是
 * 「末尾空行」，它后面没有字符可借位 → 只能退化成 `extendEndByLineHeight`
 * （由调用方补一行高）。
 *
 * @param text 文档全文
 * @param range `findFocusRowRange` 给出的完整行区间
 */
export function resolveFocusMeasureRange(text: string, range: FocusRowRange): FocusMeasureSpec {
  const len = text.length;
  const start = Math.max(0, Math.min(range.start, len));
  const end = Math.max(start, Math.min(range.end, len));

  // 窗口末行是否为空行：`end` 是「末行之后那个 \n 的下标」，若它前一个字符就是 `\n`，
  // 说明末行自身长度为 0（空行）。等价判据 `lineStart === end`，这里用字符形状更直观。
  const lastLineEmpty = end > start && text[end - 1] === "\n";
  if (!lastLineEmpty) {
    return { start, end, extendEndByLineHeight: false, lastLineEmpty: false };
  }
  // 末尾空行（后面没有字符可借位）→ 保持区间，让调用方补一行高
  if (end >= len) {
    return { start, end, extendEndByLineHeight: true, lastLineEmpty: true };
  }
  // 正常空行：借位到「下一个字符」，使 `end - 1` 恰好落在那个 `\n` 上
  return { start, end: end + 1, extendEndByLineHeight: false, lastLineEmpty: true };
}

/**
 * v0.17.0 第三轮缺陷 #7（续）：文档边界处把窗口**补齐**到目标行数。
 *
 * ## 为什么需要这一步（用户："上下行一共3行进行高亮"）
 *
 * `findFocusRowRange` 的既有语义是「光标行 ±radius，**文档边界自动收缩**」——
 * 首行只能向下取 1 行 → 共 2 行；末行只能向上取 1 行 → 共 2 行。
 * 这个收缩在 v0.12.0 就写进了注释与单测（`v0120-focus-row-range.test.ts`），
 * 当年按"上下各扩 radius 行，不够就不扩"实现。
 *
 * 但用户这次的表述是「以编辑符所在行为中心进行**上下行一共 3 行**」——
 * 强调的是**总共 3 行**，而不是"上下各 1 行"。两者在文档中部等价，在首/末行不等价：
 *
 * ```
 * 光标在末行（文档共 44 行，物理上完全够 3 行）
 *   既有：  [行42, 行43]                    = 2 行   ← 用户看到"只亮两行"
 *   期望：  [行41, 行42, 行43]              = 3 行   ← 向【有空间的一侧】补齐
 * ```
 *
 * ## 实测证明这不是"视口裁剪"（否则不该修）
 *
 * 末行场景实测（`_verify-out/t1-eof.log`）：
 * ```
 * scrollTop=564  maxScroll=608   → 还有 44px 可滚，第 3 行【物理上可达】
 * overlayH=759.41  窗 end=753.80 → 窗底离 overlay 底还有 5.6px，【没有被钳位】
 * 窗高=49.8（1.73 个字形行高）而正常 3 行窗=78.6 → 窗本身就算成了 2 行
 * bandTouchesOverlayBottom = false
 * ```
 * 所以是**窗口算错**，不是裁剪。
 *
 * ## 语义变更的边界（必须说清，别悄悄改）
 *
 * 本函数**不修改** `findFocusRowRange`（既有单测与语义原样保留），而是**新增**一步
 * 「不够就向有空位的一侧补」。调用方（专注遮罩）显式传 `targetRows=3` 才生效，
 * 其它既有调用点完全不受影响。文档本身不足 3 行时（单行/双行文档）补不满，
 * 那是**文档物理限制**，不是缺陷。
 *
 * @param text 文档全文
 * @param range `findFocusRowRange` 的结果
 * @param targetRows 目标总行数（专注遮罩传 3）
 */
export function expandFocusRangeToRows(
  text: string,
  range: FocusRowRange,
  targetRows: number,
): FocusRowRange {
  // `NaN`/`Infinity` 一类非法值一律退回 1（最小合法窗口），避免把 NaN 传播到 coordsAtPos
  const target = Number.isFinite(targetRows) ? Math.max(1, Math.floor(targetRows)) : 1;
  const start0 = Math.max(0, Math.min(range.start, text.length));
  const end0 = Math.max(start0, Math.min(range.end, text.length));
  const rows0 = countNewlines(text.substring(start0, end0)) + 1;
  if (rows0 === target) return { start: start0, end: end0, rows: rows0 };
  /**
   * 窗口**已经比目标宽**时也要收窄（`targetRows=1` 的调用者期望单行）。
   *
   * 为什么不能只在 `rows0 < target` 时才动手：`findFocusRowRange(..., radius=1)`
   * 恒返回 ≥2 行（只要文档够长）。若调用方传 `targetRows=1`，只判"不够就补"
   * 会让它原样返回 2 行 —— 那是**静默忽略入参**，比报错更糟。
   * 这里按「以光标行所在位置为基准收窄」处理：保留 `range` 起点那一段。
   */
  const truncate = rows0 > target;

  // 拆成「行号」计算：在字符上反复找 \n 极容易 off-by-one，行号模型一目了然
  const lineStarts = buildLineStartIndex(text);
  const totalLines = lineStarts.length;
  const firstLine = countNewlines(text.substring(0, start0));
  const lastLine = countNewlines(text.substring(0, end0));

  if (truncate) {
    // 收窄：从起首行开始只保留 target 行
    const newFirst = firstLine;
    const newLast = Math.min(totalLines - 1, firstLine + target - 1);
    const start = lineStarts[newFirst];
    const end = newLast + 1 < totalLines ? lineStarts[newLast + 1] - 1 : text.length;
    const clampedEnd = Math.max(start, Math.min(end, text.length));
    return { start, end: clampedEnd, rows: countNewlines(text.substring(start, clampedEnd)) + 1 };
  }

  const need = target - rows0;

  /**
   * 补齐策略：**优先向上补**，上方没有余量再全部转给下方。
   *
   * 为什么优先上方：光标在末行时，上方内容已在视口内（是"已读过的上下文"），
   * 向下补会触发滚动把光标推离中心；反之在首行时下方还有空间、补下方不引起滚动。
   *
   * ⚠️ 实测确认（`_verify-out/t1-diag-sideeffects.log`）：首行向下补 1 行后
   * **光标屏幕 Y 位移 = 0px、scrollTop 变化 = 0** —— 因为 overlay 只是**绘制**，
   * 不调用 `scrollIntoView`，"补出来的那一行"落在哪都不改变滚动位置。
   */
  const upAvail = firstLine;                              // 上方还有几行
  const downAvail = totalLines - 1 - lastLine;            // 下方还有几行
  const up = Math.min(upAvail, need);
  const down = Math.min(downAvail, need - up);
  let newFirst = firstLine - up;
  let newLast = lastLine + down;
  // 两侧都到边界仍有缺口（文档总行数 < target）→ 文档物理限制，补不满即止
  const leftover = need - up - down;
  if (leftover > 0) {
    const extraUp = Math.min(newFirst, leftover);
    newFirst -= extraUp;
    const extraDown = Math.min(totalLines - 1 - newLast, leftover - extraUp);
    newLast += extraDown;
  }

  const start = lineStarts[newFirst];
  // end 语义与 findFocusRowRange 一致：指向「末行之后那个 \n」的下标（不含）；
  // 末行是文档最后一行（没有后续 \n）→ text.length。
  const end = newLast + 1 < totalLines ? lineStarts[newLast + 1] - 1 : text.length;
  const clampedEnd = Math.max(start, Math.min(end, text.length));
  return {
    start,
    end: clampedEnd,
    rows: countNewlines(text.substring(start, clampedEnd)) + 1,
  };
}

/**
 * 建「行号 → 行首字符下标」索引。长度 = **行数**（不额外塞哨兵）。
 *
 * 末尾带 `\n` 时最后一项恰为 `text.length`，那是文本语义上的"最后一个空行"，
 * 所以不需要再 push 一次 `text.length` 当哨兵 —— 加了会让行数多算 1
 *（第一版就是这么错的，`"aaa\n"` 的补齐结果少了一行）。
 *
 * 为什么不用 `text.split("\n")` 累加长度：那会为每行建子串，长文档下是 O(n) 内存抖动；
 * 本函数只扫一遍、只存行首下标（O(行数)）。
 */
function buildLineStartIndex(text: string): number[] {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
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
 * v0.12.0 返修：mirror 内"全文文本节点"缓存。
 * measureOffsetViewportY 用 Range 定位该节点中的字符，无需每次重建 innerHTML。
 */
const mirrorTextNodeCache = new WeakMap<HTMLTextAreaElement, Node>();

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
 * v0.12.0 返修（问题2/4/5）：用 mirror + Range 测量某字符偏移的**视口 Y**坐标。
 *
 * 与 measureTextareaCursorY 等价，但**不重建 mirror 的 innerHTML**（直接用 Range
 * 定位文本节点中的字符），因此适合「二分查找」这类需要连续多次测量的场景
 * （重建 innerHTML 是 O(文本长度)，连续调用会明显卡顿）。
 *
 * @returns 相对 textarea 视口顶部的 Y（可负）；无法测量（空文本等）返回 null
 */
export function measureOffsetViewportY(
  textarea: HTMLTextAreaElement,
  offset: number
): number | null {
  const text = textarea.value;
  if (!text) return null;
  const p = Math.max(0, Math.min(offset, text.length - 1));
  const mirror = getOrCreateMirror(textarea);
  syncMirrorStyle(textarea, mirror);
  // 复用文本节点：内容变化（node.data !== text）或节点已被替换时重建
  let node: Node | null = mirrorTextNodeCache.get(textarea) ?? null;
  if (!node || (node as Text).data !== text || node.parentNode !== mirror) {
    mirror.textContent = text;
    node = mirror.firstChild;
    if (!node) return null;
    mirrorTextNodeCache.set(textarea, node);
  }
  const range = document.createRange();
  try {
    range.setStart(node, p);
    range.setEnd(node, Math.min(p + 1, text.length));
  } catch {
    return null;
  }
  const rect = range.getBoundingClientRect();
  const mirrorRect = mirror.getBoundingClientRect();
  const paddingTop = parseFloat(getComputedStyle(textarea).paddingTop) || 0;
  // 文档坐标（含 padding-top）→ 视口坐标
  return rect.top - mirrorRect.top - paddingTop - textarea.scrollTop;
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
  mirrorTextNodeCache.delete(textarea);
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

/**
 * 将一个与 textarea 同构的普通可见元素（如 source ghost overlay）的对齐样式
 * 与 textarea 保持一致：字体、行高、padding、border、white-space 等。
 *
 * v0.7.3 改进10（source 模式续写 ghost 对齐）：
 * overlay 覆在 textarea 之上（absolute inset），通过复制相同的排版样式，
 * 使 overlay 内"透明全文 + 光标处灰斜体 ghost"的字符换行与 textarea 完全一一对应，
 * 从而实现续写 ghost 与 PM 模式一致的光标处流式预览体验。
 */
export function syncTextareaMetrics(textarea: HTMLTextAreaElement, el: HTMLElement): void {
  const cs = getComputedStyle(textarea);
  el.style.boxSizing = "border-box";
  // v0.12.0 返修：显式对齐内容宽度。overlay 以 inset:0 铺满 wrapper，宽度含
  // textarea 的滚动条区域；textarea 的可用内容宽 = clientWidth（已扣滚动条）。
  // 不同步宽度时 overlay 与 textarea 换行位置不一致，ghost/续写预览会漂移
  // （用户反馈"ghost 文本是浮动的"）。算法与 syncMirrorStyle 一致：
  // overlay 为 border-box，width = clientWidth + 左右 border。
  const borderLeft = parseFloat(cs.borderLeftWidth) || 0;
  const borderRight = parseFloat(cs.borderRightWidth) || 0;
  el.style.width = `${textarea.clientWidth + borderLeft + borderRight}px`;
  el.style.fontFamily = cs.fontFamily;
  el.style.fontSize = cs.fontSize;
  el.style.fontWeight = cs.fontWeight;
  el.style.lineHeight = cs.lineHeight;
  el.style.letterSpacing = cs.letterSpacing;
  el.style.tabSize = cs.tabSize;
  el.style.paddingTop = cs.paddingTop;
  el.style.paddingRight = cs.paddingRight;
  el.style.paddingBottom = cs.paddingBottom;
  el.style.paddingLeft = cs.paddingLeft;
  el.style.borderTopWidth = cs.borderTopWidth;
  el.style.borderRightWidth = cs.borderRightWidth;
  el.style.borderBottomWidth = cs.borderBottomWidth;
  el.style.borderLeftWidth = cs.borderLeftWidth;
  el.style.borderStyle = "solid";
  el.style.whiteSpace = "pre-wrap";
  el.style.wordBreak = "break-word";
  el.style.overflow = "hidden";
}

/** HTML 转义（防注入；source ghost overlay 用 innerHTML 构建需转义原文） */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 构建 source 续写 ghost overlay 的 HTML：
 * 透明复刻 textarea 全文（保证换行与 textarea 完全一致），
 * 在光标 pos 处插入灰斜体 ghost 预览。
 *
 * 使用说明：将返回值赋给覆盖 textarea 的 overlay 的 innerHTML，
 * overlay 样式需经 syncTextareaMetrics 与 textarea 对齐
 * （透明 via CSS color: transparent；ghost 部分覆盖为灰斜体 -> 见 AI ghost 样式）
 *
 * v0.12.0 需求1 返修：新增 opts.tail / opts.maskBg，用于"格式 ghost 落在格式符中间"。
 * 行内格式（如粗体）在光标处插入的成对符号 `**|**`，光标停在两对符号中间：
 * - opts.tail：光标之后仍属于本次插入的**尾部符号**（渲染为可见普通色，跟在占位文字后）；
 * - opts.maskBg：给 ghost 段加不透明底色，遮住 textarea 里被占位文字压住的那些符号
 *   （仅当该行尾部无其他内容时启用，否则会把用户已有文字一起遮住——由调用方判定）。
 * 不传 opts 时行为与旧版完全一致（AI 续写 ghost / 无尾符号的格式）。
 *
 * @param text textarea 当前全文（raw，内部会转义）
 * @param pos 续写插入点（发起任务时的光标位置）
 * @param ghostText 流式累积的续写文本
 * @param hintText 采纳提示文案（i18n）
 * @param isPlaceholder v0.7.5：是否为"续写中…"占位态（加占位样式类，与正文 ghost 区分）
 * @param opts v0.12.0 返修：格式 ghost 的尾部符号与遮罩开关
 */
export function buildSourceGhostHtml(
  text: string,
  pos: number,
  ghostText: string,
  hintText: string,
  isPlaceholder = false,
  opts?: { tail?: string; maskBg?: boolean }
): string {
  const p = Math.max(0, Math.min(pos, text.length));
  const tail = opts?.maskBg ? (opts.tail ?? "") : "";
  const before = text.substring(0, p);
  const after = text.substring(p + tail.length);
  const cls =
    `ai-ghost-text${isPlaceholder ? " ai-ghost-placeholder" : ""}` +
    `${opts?.maskBg ? " format-ghost-mask" : ""}`;
  return (
    `<span style="color:transparent">${escapeHtml(before)}</span>` +
    `<span class="${cls}">${escapeHtml(ghostText)}` +
    (tail ? `<span class="format-ghost-tail">${escapeHtml(tail)}</span>` : "") +
    `</span>` +
    `<span class="ai-ghost-hint">${escapeHtml(hintText)}</span>` +
    `<span style="color:transparent">${escapeHtml(after)}</span>`
  );
}
