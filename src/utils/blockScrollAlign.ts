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
 *
 * ## v0.14.0 需求4：三个实测确认的缺陷（本文件负责的修复）
 * 用户症状：左屏（源码）比右屏（渲染）长很多（块之间的空行不产生块元素），
 * 往下滚动时「右屏已经到底了，左屏还要滚很长才到底」。
 *
 * 1. **`estimateTopSourceLine` 的线性假设错误**：textarea 是 `white-space: pre-wrap`，
 *    长行会软换行 → 视觉行数 ≠ 逻辑行数（按 `\n` 计数）。按"总行数线性插值"估算
 *    视口顶行在长行文档上实测偏差达 10 个块。修复：接受**实测的按行轴**
 *    （`lineTops`，见 `buildSourceLineAxis`），二分 + 段内插值。
 * 2. **锚点表没有"末尾锚点"**：最后一个块之后的源码尾部（正是用户加的那堆空行）
 *    无法映射 → 右屏停在最后一个块、两屏底部不对齐。实测右屏滚到底时左屏只到
 *    78.7%（`_verify-out/v0140-probe-split-parity.txt`）。修复：`totalSourceLines`
 *    存在时追加"最后一行 ↔ 预览可滚动上限"的末尾锚点，尾部区间按比例映射。
 * 3. **块内比例在"锚点跨度极大"时会卡住**：旧实现用 `heights[index]` 做块内插值，
 *    而两个锚点之间真实可用高度是 `tops[i+1] - tops[i]`（含块间外边距）。修复：
 *    统一改为"锚点对之间分段线性插值"，块边界不再被插值污染。
 */

/** textarea（左屏源码）的度量 */
export interface SourceViewportMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** 源码总行数（≥1；按换行符切分的行数） */
  totalSourceLines: number;
  /**
   * v0.14.0 需求4：**实测的按行轴**（可选，长度应 ≥ totalSourceLines）。
   *
   * `lineTops[i]` = "把第 i 个逻辑行的行盒顶部对齐到 textarea 视口顶所需的 scrollTop"
   * （即该行在滚动内容坐标系里的顶部偏移）。由 `buildSourceLineAxis` 从
   * "顶层块起始行的实测顶部"补全成按行索引的密集轴。
   *
   * 提供时 `estimateTopSourceLine` / `mapSourceLineToScrollTop` 走二分插值（软换行感知）；
   * 未提供（或长度不足）时退回旧的线性公式，保持 v0.13.x 行为不变。
   */
  lineTops?: number[];
}

/** 取滚动上限（`scrollHeight - clientHeight`，非法时 0） */
function maxScrollOf(scrollHeight: number, clientHeight: number): number {
  const max = scrollHeight - clientHeight;
  return Number.isFinite(max) && max > 0 ? max : 0;
}

/** 把 `v` 钳到 `[lo, hi]`；`v` 非有限时取 `lo` */
function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 在一根**非递减**的按行轴上，求 `y` 落在第几行（浮点）。
 *
 * 段内线性插值；`y` 在轴首之前 → 0，在轴尾之后 → `n-1`。
 */
function yToLine(axis: number[], y: number): number {
  const n = axis.length;
  if (n === 0) return 0;
  if (n === 1) return 0;
  if (y <= axis[0]) return 0;
  if (y >= axis[n - 1]) return n - 1;
  // 二分：最后一个 axis[i] <= y
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (axis[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  const start = axis[lo];
  const end = axis[lo + 1];
  const span = end - start;
  if (!(span > 0)) return lo; // 平台段（多个行共用同一顶部）：取该段首行
  return lo + Math.min(1, Math.max(0, (y - start) / span));
}

/** 按行轴上的逆向插值：行号 → y（不钳制，调用方负责钳到 [0, max]） */
function lineToY(axis: number[], line: number, max: number): number {
  const n = axis.length;
  if (n === 0) return 0;
  if (n === 1) return 0;
  // 最后一行代表"文档尾部"：滚到它即滚到底（保证右屏到底 ↔ 左屏到底）
  if (line >= n - 1) return max;
  const l = Math.max(0, line);
  const i = Math.floor(l);
  const frac = l - i;
  const start = axis[i];
  const end = axis[Math.min(i + 1, n - 1)];
  const span = end - start;
  if (!(span > 0)) return start;
  return start + span * frac;
}

/**
 * 估算"左屏视口顶部对应的源码行"（0-based，浮点）。
 *
 * - 传了 `lineTops`（实测按行轴）→ 二分 + 段内插值，**软换行感知**：
 *   长行折行后视觉行数多于逻辑行数，线性公式会系统性偏后（实测偏差可达 10 个块）。
 * - 否则退回线性公式：`ratio = scrollTop / (scrollHeight - clientHeight)`，
 *   行号 = `ratio × (总行数-1)`（v0.13.x 行为，等宽等高的短行文档下正确）。
 *
 * 边界：
 * - 内容不足一屏（`max <= 0`）→ 顶部恒为第 0 行；
 * - `scrollTop` 越界（滚动回弹/亚像素）→ 钳到 `[0, max]`；
 * - 单行文档 → 恒为 0。
 */
export function estimateTopSourceLine(m: SourceViewportMetrics): number {
  const total = Math.max(0, Math.floor(m.totalSourceLines));
  if (total <= 1) return 0;
  const max = maxScrollOf(m.scrollHeight, m.clientHeight);
  if (max <= 0) return 0;
  const y = clamp(m.scrollTop, 0, max);
  const axis = m.lineTops;
  if (Array.isArray(axis) && axis.length >= total) {
    const line = yToLine(axis, y);
    return clamp(line, 0, total - 1);
  }
  return (y / max) * (total - 1);
}

/**
 * v0.14.0 需求4：把"顶层块起始行的实测顶部"补全成**按行索引的密集轴**。
 *
 * 为什么只测块起始行：逐行测 1 万行要 1 万个 Range 布局查询，滚动时不可接受；
 * 而块起始行通常只有几十个。块之间在**行空间**上线性补全，恰好与
 * `locateSourceLine` 的"锚点对分段线性"完全同构 —— 于是
 * `estimateTopSourceLine` → `locateSourceLine` 的往返是**恒等**的（不会因为补全
 * 引入新的偏差），而软换行的真实折行高度通过实测点被如实带入。
 *
 * ## ⚠️ 轴里存的是**真实**行顶，不钳到 maxScroll（v0.14.0 实测修正）
 * 初版把每个实测点都 `clamp(y, 0, max)`，于是"底部那 40 多行"全被压成同一个
 * `maxScroll` 平台。后果：滚到最底时二分落在这个平台上，返回的是**最后一行**，
 * 而真实"视口顶所在行"是第 223 行 —— 两屏底部因此差 26px（实测 98.6% vs 100%）。
 * 现在轴里保留真实行顶（末尾几行可能 > maxScroll，这是对的：它们只能出现在视口
 * 下半部，永远滚不到顶部），由调用方把**查询的 y** 和**输出的 scrollTop** 各自
 * 钳到 `[0, max]`。
 *
 * 首端补 (0,0)：文档开头有前导空行时第 0 行不是块起始行。
 * 尾端补最后一行：它的真实行顶 > maxScroll，保证"最后一行 → 滚到底"仍成立。
 *
 * @param args.totalLines 源码逻辑行数（≥2）
 * @param args.blockLines 顶层块起始行（升序，与 blockTops 等长）
 * @param args.blockTops  对应行的实测顶部（scrollTop 口径，含 textarea 的 padding-top）
 * @param args.maxScroll  `scrollHeight - clientHeight`
 * @returns 长度 = totalLines 的非递减数组；数据不可用时 null（调用方退回线性估算）
 */
export function buildSourceLineAxis(args: {
  totalLines: number;
  blockLines: number[];
  blockTops: number[];
  maxScroll: number;
}): number[] | null {
  const total = Math.floor(args.totalLines);
  if (!(total > 1)) return null;
  const max = Number.isFinite(args.maxScroll) ? Math.max(0, args.maxScroll) : 0;
  if (max <= 0) return null;
  const blockLines = Array.isArray(args.blockLines) ? args.blockLines : [];
  const blockTops = Array.isArray(args.blockTops) ? args.blockTops : [];
  const n = Math.min(blockLines.length, blockTops.length);

  // 有效测量点：行号在 [0,total-1]、顶部有限、行号严格递增
  // （**不**钳到 max：真实行顶可能超出可滚动区间，见上面的说明）
  const pts: { line: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const line = Math.floor(blockLines[i]);
    const y = blockTops[i];
    if (!Number.isFinite(line) || !Number.isFinite(y)) continue;
    if (line < 0 || line >= total) continue;
    if (pts.length > 0 && line <= pts[pts.length - 1].line) continue;
    pts.push({ line, y: Math.max(0, y) });
  }
  if (pts.length === 0) return null;

  // 首端：文档开头有前导空行（第 0 行不是块起始行）时补 (0, 0)
  if (pts[0].line > 0) pts.unshift({ line: 0, y: 0 });

  // 尾端：最后一行必须有真实行顶（否则滚到底时二分到不了它）
  const lastLine = total - 1;
  const tail = pts[pts.length - 1];
  if (lastLine > tail.line) {
    // 尾部若干行没有实测点 → 用"内容总高"外推：最后一行的行顶 ≈ 内容高 - 一行高。
    // 取 maxScroll 作为下界（它至少不小于可滚动上限），保证"最后一行 → 到底"成立。
    pts.push({ line: lastLine, y: Math.max(tail.y, max) });
  }

  // 段间线性补全
  const axis = new Array<number>(total);
  axis[pts[0].line] = pts[0].y;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const spanLines = b.line - a.line;
    const spanY = b.y - a.y;
    for (let line = a.line + 1; line <= b.line; line++) {
      axis[line] = spanLines > 0 ? a.y + (spanY * (line - a.line)) / spanLines : a.y;
    }
  }
  // 防御：补齐未赋值项 + 强制非递减（测量噪声造成的回退）
  let prev = 0;
  for (let line = 0; line < total; line++) {
    const v = Number.isFinite(axis[line]) ? axis[line] : prev;
    axis[line] = v < prev ? prev : v;
    prev = axis[line];
  }
  return axis;
}

/**
 * v0.14.0 需求4：从按行轴算出"**左屏滚到最底时，视口顶所在的那一行**"。
 *
 * 为什么需要它：末尾锚点必须配这一行，而不是"最后一行"。滚到最底时最后一行只
 * 出现在视口**下半部**，视口顶其实是第 223 行（实测文档①：maxScroll 6489 对应
 * 行 223.79，而文档共 266 行）。若拿"最后一行"做末尾锚点，左屏到底会映射到右屏
 * 98.6% 而不是 100%（实测差 26px）。
 *
 * @returns 行号（浮点，钳到 [0, totalLines-1]）；轴不可用/不足一屏时 null
 */
export function lineAtMaxScroll(axis: number[] | null | undefined, maxScroll: number): number | null {
  if (!Array.isArray(axis) || axis.length < 2) return null;
  if (!Number.isFinite(maxScroll) || maxScroll <= 0) return null;
  const line = yToLine(axis, Math.min(maxScroll, axis[axis.length - 1]));
  return clamp(line, 0, axis.length - 1);
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

// ─── v0.14.0 需求4：左屏 textarea 的**实测按行轴**（唯一带 DOM 的函数）───────
//
// 本模块其余函数都是纯算术；只有下面这个测量函数需要真实布局，因此显式标注。
// 它只在 EditorContainer 的滚动联动 effect 里调用（按"文本/宽度/字号"变化才重算），
// 不在任何纯函数单测路径上。

/** 测量上限：超过这个文本长度就放弃实测（退回线性估算，避免拖慢滚动） */
const AXIS_MAX_TEXT_LENGTH = 2_000_000;

/**
 * 为 textarea 里每个"顶层块起始行"实测它在滚动内容坐标系中的顶部偏移，
 * 再交给 `buildSourceLineAxis` 补全成按行索引的密集轴。
 *
 * ## 为什么用 mirror div
 * textarea 不暴露"第 N 行的 Y 坐标"。唯一可靠办法是复制一份同样排版的可测量元素
 * （与 `utils/focus-paragraph.ts` 的 mirror 方案同法）：同样的宽度 / padding / 字体 /
 * 行高 / `white-space: pre-wrap`，于是软换行的折行位置与真实 textarea 一致。
 *
 * ## 为什么在行首插零宽标记
 * 空行的 Range 是空区间，`getBoundingClientRect()` 返回全 0 —— 用户这份文档里恰好
 * 有上百个连续空行，用 Range 会把它们全测成 0（实测踩过）。改在每行行首插一个
 * 只含 U+200B 的 span：零宽不改变换行，但会撑出真实行盒，`rect.top` 即该行顶部。
 *
 * @returns `{ totalLines, axis }`；无法测量（隐藏 / 空文本 / 过大 / 无有效点）时 null
 */
export function measureSourceLineAxis(args: {
  textarea: HTMLTextAreaElement;
  /** 顶层块起始行（升序；通常来自 `topLevelBlockStartLines`） */
  blockLines: number[];
  /** 文档对象（默认取 textarea.ownerDocument，便于单测注入） */
  doc?: Document;
}): { totalLines: number; axis: number[] } | null {
  const { textarea, blockLines } = args;
  if (!textarea) return null;
  const text = textarea.value;
  if (!text || text.length > AXIS_MAX_TEXT_LENGTH) return null;
  if (!(textarea.clientWidth > 0) || !(textarea.clientHeight > 0)) return null;
  const doc = args.doc ?? textarea.ownerDocument;
  if (!doc?.body) return null;

  const cs = doc.defaultView?.getComputedStyle(textarea);
  if (!cs) return null;

  const lines = text.split("\n");
  const totalLines = lines.length;
  if (totalLines <= 1) return null;

  const borderTop = parseFloat(cs.borderTopWidth) || 0;
  const borderLeft = parseFloat(cs.borderLeftWidth) || 0;
  const borderRight = parseFloat(cs.borderRightWidth) || 0;

  const mirror = doc.createElement("div");
  mirror.setAttribute("aria-hidden", "true");
  mirror.style.cssText =
    "position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;" +
    `box-sizing:border-box;width:${textarea.clientWidth + borderLeft + borderRight}px;` +
    `padding:${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft};` +
    "border-style:solid;" +
    `border-width:${cs.borderTopWidth} ${cs.borderRightWidth} ${cs.borderBottomWidth} ${cs.borderLeftWidth};` +
    "white-space:pre-wrap;word-break:break-word;margin:0;overflow:hidden;" +
    `font-family:${cs.fontFamily};font-size:${cs.fontSize};font-weight:${cs.fontWeight};` +
    `font-style:${cs.fontStyle};line-height:${cs.lineHeight};letter-spacing:${cs.letterSpacing};` +
    `tab-size:${cs.tabSize};`;
  doc.body.appendChild(mirror);

  try {
    const want = new Set<number>();
    for (const l of blockLines) {
      const n = Math.floor(l);
      if (Number.isFinite(n) && n >= 0 && n < totalLines) want.add(n);
    }
    const markers = new Map<number, HTMLElement>();
    for (let i = 0; i < totalLines; i++) {
      if (want.has(i)) {
        const m = doc.createElement("span");
        m.textContent = "\u200b";
        mirror.appendChild(m);
        markers.set(i, m);
      }
      mirror.appendChild(
        doc.createTextNode(lines[i] + (i < totalLines - 1 ? "\n" : "")),
      );
    }
    const boxTop = mirror.getBoundingClientRect().top;
    const measuredLines: number[] = [];
    const measuredTops: number[] = [];
    // 按行号升序输出（Map 迭代顺序为插入顺序，天然升序）
    for (const [line, marker] of markers) {
      const rect = marker.getBoundingClientRect();
      // mirror 是 border-box，boxTop 在边框外沿 → 减 borderTop 得到内容盒顶；
      // 行盒顶部相对内容盒顶的距离已包含 padding-top（textarea 的 padding 也随内容滚动）。
      const top = rect.top - boxTop - borderTop;
      if (!Number.isFinite(top)) continue;
      measuredLines.push(line);
      measuredTops.push(top);
    }
    const maxScroll = Math.max(0, textarea.scrollHeight - textarea.clientHeight);
    const axis = buildSourceLineAxis({
      totalLines,
      blockLines: measuredLines,
      blockTops: measuredTops,
      maxScroll,
    });
    if (!axis) return null;
    return { totalLines, axis };
  } catch {
    return null;
  } finally {
    mirror.remove();
  }
}

/**
 * 数量自校验：只有"顶层块数 === 预览顶层内容元素数"时才允许贴 `data-src-line`。
 *
 * 为什么保留这道校验：本渲染管线 `htmlBlockDisabled: true`，原始 HTML 被转义成段落，
 * 因此当前**实测数量总是相等**（见 v0131-block-scroll-align.test.ts）。但这条不变量
 * 依赖"每个顶层 token 恰好产出一个元素"这个实现细节 —— 一旦将来开启 html、
 * 或某个插件新增了没有 `map` 的 token、或渲染规则改成包裹/拆分元素，顺序就会整体错位。
 * 错位的后果比"退回百分比映射"严重得多（右侧跳到完全无关的位置），
 * 因此用一次 O(1) 的数量比较把它挡在门外。
 *
 * ⚠️ v0.14.0 需求4：比较的**右侧**必须是"内容元素"而不是 `body.children` 全部 ——
 * 见 `isAnchorablePreviewChild`（mermaid / katex 会往 body 注入 `<script>` 与
 * 自己的工具层 `<div class="mermaidTooltip">`，旧实现因此数量不符、整份文档放弃贴标，
 * 实测含 mermaid 的文档 `[data-src-line]` 数量为 0，只能退回百分比映射）。
 */
export function shouldTagPreview(blockCount: number, childCount: number): boolean {
  return blockCount > 0 && blockCount === childCount;
}

/**
 * v0.14.0 需求4：`body.children` 里哪些元素是"markdown 顶层块渲染出来的内容元素"。
 *
 * 排除两类**不是正文块**的子元素：
 * 1. 渲染器/脚本注入的非内容标签：`script` / `style` / `link` / `meta` / `template` …
 *    （分屏 iframe 的 HTML 把 mermaid / katex 的 `<script>` 写在 `</body>` 前，
 *    它们会成为 `body.children` 的成员）；
 * 2. 第三方库自己挂到 body 上的工具层：mermaid 的 `div.mermaidTooltip`。
 *
 * 这道过滤只影响"数量自校验的右侧基数"：过滤后数量仍必须与块数**严格相等**，
 * 否则照旧放弃贴标、退回百分比映射 —— 因此它只可能把"本来能对上的"救回来，
 * 不可能把错位的放进来。
 */
const NON_CONTENT_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "LINK",
  "META",
  "TEMPLATE",
  "NOSCRIPT",
  "TITLE",
  "BASE",
  "HEAD",
]);

/** 渲染期第三方库注入的工具层类名（mermaid 的 tooltip 容器） */
const INJECTED_TOOL_LAYER_CLASSES = ["mermaidTooltip"];

export function isAnchorablePreviewChild(
  tagName: string,
  className?: string | null,
): boolean {
  const tag = String(tagName ?? "").toUpperCase();
  if (!tag) return false;
  if (NON_CONTENT_TAGS.has(tag)) return false;
  // SVG 元素的 className 是 SVGAnimatedString（不是字符串），这里只做字符串判断
  if (typeof className === "string" && className) {
    const classes = className.split(/\s+/);
    for (const injected of INJECTED_TOOL_LAYER_CLASSES) {
      if (classes.includes(injected)) return false;
    }
  }
  return true;
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
  /**
   * v0.14.0 需求4：源码总行数（≥1）。提供时追加**末尾锚点**
   * （尾部行 ↔ 预览可滚动上限），使"源码尾部那段被吞掉的空行"也能映射到
   * 预览的底部区间，从而两屏一起到底。
   */
  totalSourceLines?: number;
  /**
   * v0.14.0 需求4（实测修正）：**左屏滚到最底时，视口顶所在的那一行**（浮点）。
   *
   * 为什么不直接用 `totalSourceLines - 1`：滚到最底时最后一行只出现在视口
   * **下半部**，视口顶其实是更靠前的一行（实测文档①：maxScroll 6489 对应行
   * 223.79，而文档共 266 行）。用最后一行当末尾锚点会让"左屏到底"只映射到右屏
   * 98.6%（实测差 26px）。由 `lineAtMaxScroll(axis, maxScroll)` 算出。
   *
   * 提供时优先使用；未提供时退回 `totalSourceLines - 1`（旧语义）。
   */
  maxScrollLine?: number;
}

/** 分段线性映射的一个端点：源码行 ↔ 预览滚动位置 */
interface MapPoint {
  line: number;
  /** 预览 scrollTop 空间的位置 */
  top: number;
}

/**
 * 把"超出可滚动上限"的端点**按比例压缩**进 `(startY, max]`，保证：
 * 1. 端点 `top` 非递减（二分/顺序查找的前提）；
 * 2. 最后一个端点恰为 `max`（右屏滚到底 ↔ 左屏滚到底）；
 * 3. 段与段一一对应、互不塌缩（→ 正反映射互逆）。
 *
 * 为什么不是简单 `clamp(top, 0, max)`：预览比源码短时，尾部会有**多个**块的真实顶部
 * 超过 `max`。全部钳到 `max` 会让这些块塌成同一个点 → 该区间内正反映射不再互逆
 * （左屏滚到块 N 就顶到底，右屏到底又反算到文档末行，中间位置全丢）。
 * 按比例压缩则把它们均匀摊在最后一段可滚动区间里：块内对齐精度略降（本来也压不进去），
 * 但单调、可逆、两端对齐都不丢。
 */
function normalizeTops(points: MapPoint[], max: number): MapPoint[] {
  const n = points.length;
  if (n === 0) return points;
  // 最后一个"自然位置就在可滚动区间内"的端点
  let k = -1;
  for (let i = 0; i < n; i++) {
    if (points[i].top <= max) k = i;
  }
  const out = points.map((p) => ({ line: p.line, top: p.top }));
  if (k < n - 1) {
    const startY = k >= 0 ? points[k].top : 0;
    const restCount = n - 1 - k;
    const span = Math.max(0, max - startY);
    for (let i = k + 1; i < n; i++) {
      out[i].top = startY + (span * (i - k)) / restCount;
    }
  }
  // 钳到 [0, max] 并强制非递减（测量噪声 / 负 padding 等情况）
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const v = Number.isFinite(out[i].top) ? out[i].top : prev;
    out[i].top = Math.min(max, Math.max(prev, v));
    prev = out[i].top;
  }
  return out;
}

/**
 * 构造分段线性映射的端点表。
 *
 * 两种模式：
 * - **v0.14.0 需求4 模式**（`totalSourceLines` 提供）：追加**末尾锚点**
 *   （最后一行 ↔ 可滚动上限），并把超界的端点压缩进区间 —— 两屏一起到底。
 * - **v0.13.x 兼容模式**（未提供）：最后一块按 `top + height` 收尾，`top` 原样使用。
 *   既有单测（v0131 / v0132）锁的就是这个语义，不能改。
 *
 * @param viewportHeight 预览视口高。提供时上限取 `totalHeight - viewportHeight`
 *   （scrollTop 的真实上界）；未提供时用 `totalHeight`（内容坐标系，`locateSourceLine` 用）。
 * @returns 端点表（长度 ≥ 2）；数据不可用（空表 / 非有限值）时 null
 */
function buildMapPoints(
  set: PreviewAnchorSet,
  viewportHeight?: number,
): MapPoint[] | null {
  const { lines, tops, heights, totalHeight } = set;
  if (!Array.isArray(lines) || lines.length === 0) return null;
  if (!Array.isArray(tops) || !Array.isArray(heights)) return null;
  const n = Math.min(lines.length, tops.length, heights.length);
  if (n === 0) return null;

  const vh = typeof viewportHeight === "number" && Number.isFinite(viewportHeight)
    ? Math.max(0, viewportHeight)
    : null;
  const totalH = Number.isFinite(totalHeight) ? Math.max(0, totalHeight) : 0;
  const max = vh === null ? totalH : Math.max(0, totalH - vh);

  const pts: MapPoint[] = [];
  for (let i = 0; i < n; i++) {
    const line = lines[i];
    const top = tops[i];
    const height = heights[i];
    if (!Number.isFinite(line) || !Number.isFinite(top) || !Number.isFinite(height)) {
      return null;
    }
    pts.push({ line, top });
  }
  const last = pts[pts.length - 1];
  const lastHeight = heights[n - 1];
  const total = Number.isFinite(set.totalSourceLines as number)
    ? Math.floor(set.totalSourceLines as number)
    : 0;

  if (total > 0) {
    // ── v0.14.0 需求4：末尾锚点 + 压缩进可滚动区间 ──
    //
    // 末尾锚点的"源码行"是**滚到最底时视口顶所在的那一行**（maxScrollLine），
    // 不是最后一行 —— 见 PreviewAnchorSet.maxScrollLine 的说明。
    const totalLast = total - 1;
    const tailLine = Number.isFinite(set.maxScrollLine as number)
      ? Math.min(totalLast, Math.max(0, set.maxScrollLine as number))
      : totalLast;
    // ⚠️ 关键：line > tailLine 的锚点**永远不可能出现在视口顶**
    // （预览比源码短时，末尾那些块只能出现在视口下半部，滚到 max 也顶不上去）。
    // 必须把它们剔除，否则端点表的 line 不再单调递增（tailLine 可能小于最后一个
    // 锚点的行号），后面的顺序查找会提前 break → 左屏到底只映射到 98.6%（实测差 26px）。
    const kept = pts.filter((p) => p.line <= tailLine);
    if (kept.length === 0) return null;
    const lastKept = kept[kept.length - 1];
    if (tailLine > lastKept.line) {
      // 尾部行（最后一块之后那些被吞掉的空行）自然位置 = 最后一块底部；
      // 越过 max 的部分由 normalizeTops 按比例摊进最后一段可滚动区间。
      kept.push({ line: tailLine, top: Math.max(lastKept.top + lastHeight, max) });
    } else {
      // 最后一个可用锚点就覆盖到末尾：把它的自然位置抬到 max，保证"滚到底 = 到底"
      kept[kept.length - 1] = { line: lastKept.line, top: Math.max(lastKept.top, max) };
    }
    return normalizeTops(kept, max);
  }

  // ── v0.13.x 兼容模式：原样使用 top，末块按 top+height 收尾 ──
  pts.push({ line: last.line + 1, top: last.top + lastHeight });
  return pts;
}

/**
 * 在 `PreviewAnchorSet` 里定位"某个源码行"落在哪一段、段内比例多少。
 *
 * 与 v0.13.2 的差别：段内插值区间由 `tops[i+1] - tops[i]` 决定（而非
 * `heights[i]`）。两者在"块紧挨着"时相等；有块间外边距时前者才是真实可映射高度，
 * 且与 `estimateTopSourceLine` 的行轴同构（往返恒等）。
 *
 * @returns `{ index, ratio }`；表为空时 null
 */
export function locateSourceLine(
  set: PreviewAnchorSet,
  line: number,
): { index: number; ratio: number } | null {
  const pts = buildMapPoints(set);
  if (!pts) return null;
  const segCount = pts.length - 1;
  let idx = 0;
  for (let i = 0; i < segCount; i++) {
    if (pts[i].line <= line) idx = i;
    else break;
  }
  const from = pts[idx];
  const to = pts[idx + 1];
  const span = Math.max(1e-9, to.line - from.line);
  const ratio = Math.min(1, Math.max(0, (line - from.line) / span));
  return { index: idx, ratio };
}

/**
 * v0.13.2 需求8：**左 → 右**（源码行 → 预览 scrollTop）。
 *
 * 用户要求：「左右两屏不是共用滚动条，而是映射关系。因为左屏的文档长度会比右屏
 * 渲染的文档长度小，如果共用滚动条就导致左右看到的内容不一致或有偏差，
 * 所以要实现左右两屏能联动滚动，但左右两屏看到的内容尽量能对齐。」
 *
 * 映射口径：源码行 → 分段线性插值到预览滚动位置。
 * 与百分比映射的本质差别：段内比例只在**相邻两个块锚点之间**线性，跨块时按块的
 * 真实位置跳转，因此 3 行 mermaid 源码 ↔ 400px 的图也能对齐到同一个块。
 *
 * @returns 目标 scrollTop（已钳到 [0, maxScrollTop]）；数据不可用时 null（调用方退回百分比）
 */
export function mapSourceLineToPreviewScroll(
  set: PreviewAnchorSet,
  line: number,
  viewportHeight: number,
): number | null {
  if (!Number.isFinite(line)) return null;
  // 正反两向必须用**同一份**端点表，否则往返不互逆（中间位置漂移）。
  const pts = buildMapPoints(set, viewportHeight);
  if (!pts) return null;
  const segCount = pts.length - 1;
  let idx = 0;
  for (let i = 0; i < segCount; i++) {
    if (pts[i].line <= line) idx = i;
    else break;
  }
  const from = pts[idx];
  const to = pts[idx + 1];
  const span = to.line - from.line;
  const ratio = span > 0 ? Math.min(1, Math.max(0, (line - from.line) / span)) : 0;
  const target = from.top + (to.top - from.top) * ratio;
  if (!Number.isFinite(target)) return null;
  const max = maxScrollOf(set.totalHeight, viewportHeight);
  return Math.min(Math.max(0, target), max);
}

/**
 * v0.13.2 需求8：**右 → 左**（预览 scrollTop → 源码行）。
 *
 * 找到预览视口顶落在哪一段、段内比例多少，反算源码行。
 *
 * v0.14.0 需求4：新增可选 `viewportHeight`。提供时把锚点钳到可滚动区间并追加
 * 末尾锚点 —— 否则"右屏已滚到底"会反算到文档中部（实测左屏只到 78.7%），
 * 也就是用户看到的"右屏到底了、左屏还要滚很长"。
 *
 * @returns 源码行（0-based，浮点）；数据不可用时 null
 */
export function mapPreviewScrollToSourceLine(
  set: PreviewAnchorSet,
  scrollTop: number,
  viewportHeight?: number,
): number | null {
  if (!Number.isFinite(scrollTop)) return null;
  const vh = typeof viewportHeight === "number" && Number.isFinite(viewportHeight)
    ? viewportHeight
    : undefined;
  const pts = buildMapPoints(set, vh);
  if (!pts) return null;
  const segCount = pts.length - 1;
  // 取"最后一个 top <= scrollTop 的段起点"（平台段取到其末尾，避免卡在段首）
  let idx = 0;
  for (let i = 0; i < segCount; i++) {
    if (pts[i].top <= scrollTop) idx = i;
  }
  const from = pts[idx];
  const to = pts[idx + 1];
  const span = to.top - from.top;
  let ratio: number;
  if (span > 0) ratio = Math.min(1, Math.max(0, (scrollTop - from.top) / span));
  // 平台段（多个源码行映射到同一预览位置，例如被吞掉的空行）：滚到该位置即取段末
  else ratio = scrollTop >= from.top ? 1 : 0;
  return from.line + (to.line - from.line) * ratio;
}

/**
 * v0.13.2 需求8：源码行 → 左屏 textarea 的 scrollTop（右 → 左联动的落点）。
 *
 * 传了 `lineTops`（实测按行轴）→ 按行轴插值（软换行感知，与
 * `estimateTopSourceLine` 严格互逆）；否则退回线性公式（v0.13.x 行为）。
 *
 * @returns 目标 scrollTop（已钳到 [0, maxScrollTop]）；行数不可用时 null
 */
export function mapSourceLineToScrollTop(
  m: SourceViewportMetrics,
  line: number,
): number | null {
  // NaN → null（调用方不写滚动位置）；±Infinity 是"越界"，按钳制处理（见下）
  if (Number.isNaN(line)) return null;
  const total = Math.max(0, Math.floor(m.totalSourceLines));
  if (total <= 1) return 0;
  const max = maxScrollOf(m.scrollHeight, m.clientHeight);
  if (max <= 0) return 0;
  const axis = m.lineTops;
  if (Array.isArray(axis) && axis.length >= total) {
    return clamp(lineToY(axis, line, max), 0, max);
  }
  const ratio = Math.min(1, Math.max(0, line / (total - 1)));
  if (!Number.isFinite(ratio)) return null;
  return ratio * max;
}
