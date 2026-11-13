/**
 * src/utils/caretMap.ts —— **跨模式光标映射**（v0.17.0 第三轮 T5 / 用户第 6 项）
 *
 * ## 需求
 * 用户原话：「我在编辑模式下编辑符号在哪，切换到阅读模式编辑符号就应该在哪。」
 * 「编辑符号」= 插入符号 / 光标（caret）。要求**双向**保留，且来回切换不漂移。
 *
 * ## 为什么不能靠"行号"映射（既有实现的口径，实测证伪）
 *
 * 旧实现（`ModeSync.tsx` 的 `viewMode` effect）两个方向都按**行号**折行计数：
 * - 阅读→编辑：`lineIndexOfOffset(doc.textBetween(0, from, "\n", "\n"))` —— 用 PM 文本的
 *   第 N 个"换行"当源码第 N 行；
 * - 编辑→阅读：拿源码行号去遍历 PM 块，用 `(node.textContent||"").split("\n").length`
 *   累加行数找目标块。
 *
 * 两条都建立在一个**不成立的假设**上：PM 的块内文本换行数 == 源码行数。
 * 实测（`scripts/v0170-r3-blocks.mjs`，9 块夹具）反例：
 *
 * | 源码 | 行数 | PM 顶层块 | textContent 换行数 |
 * |---|---|---|---|
 * | `- K04 p1` / `- p2`（2 行） | 2 | `bullet_list`（**1 个块**） | **0** |
 * | `> K05 引用文字`（1 行） | 1 | `blockquote`（含 paragraph） | 0 |
 * | 表格 3 行 | 3 | `table`（**1 个块**） | 0 |
 *
 * 于是行计数**系统性偏小** → 目标块越找越靠后。实测落错块：
 * `源码 L12（代码块）→ PM table_header`、`源码 L19（H2）→ PM table_cell`。
 * 这不是"误差几个字符"，是**落进别的块**。
 *
 * ## 正解：用 parser 的**权威源码行区间**，不用行计数估算
 *
 * `core/markdown/parser.ts`（v0.9.0 B6）在解析期就给**每个顶层块**记了它在源文本里的
 * 行区间 `[start, end)`（`blockSourceMap`，并在 DOM 上以 `data-src-line` 暴露）。
 * 实测 9/9 块区间精确：`h1=0 / p=2 / p=4 / ul=6 / quote=9 / code=11 / table=15 / h2=19 / p=21`。
 * 本模块就以它为**块级权威坐标**：源码行 → 唯一块，不再估算。
 *
 * ## 块内怎么映射：源码列 → **可见字符序号**
 *
 * 块级定位解决"哪一块"，块内还剩 markdown 语法符的问题（`# `、`- `、`> `、`**`、
 * 围栏、表格竖线、对齐行）。做法是**文本对齐**（`alignBlockText`）：
 * 把「块的源码原文」与「块的可见文本」做单调双指针匹配 ——
 * 可见文本里的每个字符都能在源码里找到位置，源码里匹配不上的字符就是语法符。
 *
 * 这样得到的不是"估算"，而是**逐字符的实测对应关系**，并且天然给出自校验指标
 * （`unmatchedVisible === 0` 才认为对齐可信；否则调用方放弃映射、退回旧路径）。
 *
 * ⚠️ 口径选择（产品歧义，已与 Lead 确认按此实现）：
 * 「同一字符」指**同一可见字符**。例：源码 `**加粗内容**` 的第 3 个字符是 `*`（不可见），
 * 落进阅读面没有对应字形 —— 此时映射到「加粗内容」的块首，而不是硬凑源码第 3 列。
 * 理由：用户看的是**字形**，语法符在阅读面根本不存在，硬凑会造成可见字符错位。
 *
 * ## 纪律（沿用 `contentScrollMap` 同一套）
 * - **无法映射返回 `null`，绝不返回 0 / 块首兜底**（错误位置比不移动更坏）；
 * - 本模块**纯函数**：不碰 DOM、不 import ProseMirror 实现，只吃数字与字符串 → 可精确单测；
 * - DOM/PM 的几何与位置写入留在 `ModeSync.tsx`（`PM 位置 ↔ 可见序号` 的适配器
 *   `collectVisibleSegments` 也在本模块，但只依赖**鸭子类型**的 `forEachTextNode`，
 *   便于单测注入假实现）。
 */

/** 一个顶层块的源码行区间（0 基，`[startLine, endLine)`，与 `blockSourceMap` 同口径） */
export interface BlockSourceRange {
  startLine: number;
  endLine: number;
}

/**
 * 一段「可见文本」在 PM 文档里的位置信息。
 *
 * `pos` 是该文本节点第一个字符的**文档位置**（PM 的 `pos`），`text` 是它的内容。
 * 多个段按文档顺序拼接 = 块内可见文本。
 */
export interface VisibleTextSegment {
  pos: number;
  text: string;
}

/**
 * 块的「源码 ↔ 可见文本」对齐结果。
 *
 * `srcToVisible[i]`：源码第 i 个字符对应的可见字符序号；`-1` 表示该字符是语法符
 * （在可见文本里没有对应字形）。
 */
export interface BlockTextAlignment {
  /** 源码字符数 */
  sourceLength: number;
  /** 可见字符数 */
  visibleLength: number;
  /** sourceIndex → visibleIndex（-1 = 语法符 / 未匹配） */
  srcToVisible: number[];
  /** visibleIndex → sourceIndex */
  visibleToSrc: number[];
  /** 可见文本里**无法**在源码中找到的字符数（0 = 对齐可信） */
  unmatchedVisible: number;
  /** 源码里被判为语法符（不可见）的字符数 */
  skippedSource: number;
}

/**
 * 把块的「源码原文」与「可见文本」做单调逐字符对齐。
 *
 * ## 算法（贪心双指针，O(n+m)）
 * 对每个可见字符，在源码里**从当前位置往后**找第一个相同字符：
 * - 跳过（记为语法符）中间所有不匹配的源码字符；
 * - 找到就记录 `srcToVisible[srcIdx] = visibleIdx`、`visibleToSrc[visibleIdx] = srcIdx`；
 * - 找不到（`indexOf` 返回 -1）→ 该可见字符记为 `unmatchedVisible`，游标不前进。
 *
 * ## 为什么贪心在这里够用（而不是上 LCS/diff）
 * 语法符是**成对/定长**的短标记（`**`、`# `、`- `、`> `、`|`、围栏行），而可见文本是
 * 原文把这些标记删掉后的**子序列** —— 单调双指针在"目标序列是源序列子序列"时
 * 是正确的（每个可见字符取它在源码中最早的可用位置）。
 * 真正需要 LCS 的情形（可见文本字符顺序与源码不同）在本场景不会出现：
 * 阅读面渲染不重排字符，只**删除**语法符。
 *
 * ⚠️ 因此 `unmatchedVisible` 是**对齐质量哨兵**：只要 > 0 就说明假设被打破
 * （例如某个 NodeView 往可见文本里塞了源码没有的字），调用方必须放弃映射，
 * 不许"带着错位的对齐继续用"。
 */
export function alignBlockText(source: string, visible: string): BlockTextAlignment {
  const srcToVisible = new Array<number>(source.length).fill(-1);
  const visibleToSrc = new Array<number>(visible.length).fill(-1);
  let cursor = 0;
  let unmatchedVisible = 0;
  for (let v = 0; v < visible.length; v++) {
    const ch = visible[v];
    // 从游标处往后找第一个相同字符（含游标本身）
    let found = -1;
    for (let s = cursor; s < source.length; s++) {
      if (source[s] === ch) {
        found = s;
        break;
      }
    }
    if (found === -1) {
      unmatchedVisible++;
      continue;
    }
    srcToVisible[found] = v;
    visibleToSrc[v] = found;
    cursor = found + 1;
  }
  let skippedSource = 0;
  for (let s = 0; s < srcToVisible.length; s++) if (srcToVisible[s] === -1) skippedSource++;
  return {
    sourceLength: source.length,
    visibleLength: visible.length,
    srcToVisible,
    visibleToSrc,
    unmatchedVisible,
    skippedSource,
  };
}

/**
 * 源码在**块内**的偏移 → 可见字符序号。
 *
 * 语义（对应用户可见行为）：
 * - 落在可见字符上 → 该字符序号；
 * - 落在**语法符区间内**（例如光标停在 `**` 中间）→ 取**其后第一个可见字符**
 *   （"光标在这段标记里"在阅读面最自然的落点就是这段标记所修饰内容的开头）；
 * - 落在块尾之后 → 可见文本末尾（"光标在行尾"）。
 *
 * @returns 可见序号；对齐不可信（`unmatchedVisible > 0`）或参数非法时返回 `null`
 */
export function sourceOffsetToVisibleIndex(
  alignment: BlockTextAlignment,
  offsetInBlock: number,
): number | null {
  if (alignment.unmatchedVisible > 0) return null;
  if (!Number.isFinite(offsetInBlock)) return null;
  const n = Math.max(0, Math.min(alignment.sourceLength, Math.trunc(offsetInBlock)));
  // 从该位置往后找第一个"可见"的源码字符
  for (let s = n; s < alignment.srcToVisible.length; s++) {
    if (alignment.srcToVisible[s] >= 0) return alignment.srcToVisible[s];
  }
  // 后面没有可见字符（光标在块尾 / 全语法符块）→ 落到可见文本末尾
  return alignment.visibleLength;
}

/**
 * 可见字符序号 → 源码在块内的偏移（反向）。
 *
 * - 序号等于可见长度 → 返回**最后一个可见字符之后**的源码位置（块内文本末尾，
 *   不含尾部语法符之前的收缩；用于"光标在行尾"）；
 * - 越界/对齐不可信 → `null`。
 */
export function visibleIndexToSourceOffset(
  alignment: BlockTextAlignment,
  visibleIndex: number,
): number | null {
  if (alignment.unmatchedVisible > 0) return null;
  if (!Number.isFinite(visibleIndex)) return null;
  const v = Math.trunc(visibleIndex);
  if (v < 0) return null;
  if (v >= alignment.visibleLength) {
    // 末尾：最后一个可见字符的源码位置 +1
    if (alignment.visibleLength === 0) return 0;
    const last = alignment.visibleToSrc[alignment.visibleLength - 1];
    if (last < 0) return null;
    return last + 1;
  }
  const s = alignment.visibleToSrc[v];
  return s < 0 ? null : s;
}

/**
 * 按源码行号找它所属的**顶层块下标**。
 *
 * `ranges` 必须按 `startLine` 升序（`blockSourceMap` 天然满足：parser 自上而下产出）。
 * 语义与 `contentScrollMap.resolveBySourceLine` 的"取 `sourceLine <= 目标行` 的最后一个块"
 * 一致 —— 这样块间空行、以及落在块尾空行上的光标都归到**上方那个块**，
 * 与阅读面"空行归属于上一块末尾"的视觉一致。
 *
 * @returns 块下标；`ranges` 为空 / 目标行在所有块之前 → `null`
 */
export function findBlockIndexByLine(
  ranges: ReadonlyArray<BlockSourceRange>,
  line: number,
): number | null {
  if (!ranges.length || !Number.isFinite(line)) return null;
  const target = Math.trunc(line);
  let at: number | null = null;
  for (let i = 0; i < ranges.length; i++) {
    if (ranges[i].startLine <= target) at = i;
    else break;
  }
  return at;
}

/**
 * 把「可见文本分段」拼成一个字符串（= 块内可见文本的权威口径）。
 *
 * 为什么不用 `node.textContent`：`textContent` 用 `"\n"` 作块分隔符，且会带上
 * leaf node 的文本（`hard_break` / 图片）—— 这些字符在源码里没有对应物，
 * 会对齐出 `unmatchedVisible`。这里只取**文本节点**，两端口径严格一致。
 */
export function joinVisibleSegments(segments: ReadonlyArray<VisibleTextSegment>): string {
  let out = "";
  for (const seg of segments) out += seg.text;
  return out;
}

/**
 * 可见字符序号 → PM 文档位置。
 *
 * ## 位置语义（单测踩过的坑，写下来防重蹈）
 *
 * 分段的 `pos` 是**该文本节点首字符**的文档位置，分段之间隔着 mark 边界/内联节点
 * 的边界位置 —— 这些"边界位置"在 PM 里是**共享**的：`text` 节点结束位置 ==
 * 下一个节点的起始位置。所以：
 * - 序号落在**某分段内部** → `seg.pos + (idx - acc)`；
 * - 序号正好等于**某分段的结束** → 必须返回**下一个分段的起始** `pos`
 *   （= 同一位置的另一种表述，但只有它能保证与 `docPosToVisibleIndex` 往返一致）。
 *
 * 第一版按"`visibleIndex < acc + len` 才算命中，否则 acc += len"实现，
 * 结果 `序号=2`（第一段 "前 " 的末尾）被算成 `1+2=3`，而下一段的起点是 4 ——
 * 差 1 且往返不闭合（`3` 反查回来是序号 2 之外的 1）。修正为"恰好到段尾时用下一段起点"。
 */
export function visibleIndexToDocPos(
  segments: ReadonlyArray<VisibleTextSegment>,
  visibleIndex: number,
): number | null {
  if (!Number.isFinite(visibleIndex) || visibleIndex < 0) return null;
  const v = Math.trunc(visibleIndex);
  let acc = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const len = seg.text.length;
    if (v < acc + len) return seg.pos + (v - acc);
    if (v === acc + len && i + 1 < segments.length) {
      // 恰好落到本段末尾 → 用下一段起点（两者在文档上是同一位置的邻接表示）
      return segments[i + 1].pos;
    }
    acc += len;
  }
  // 末尾（或空分段列表）：最后一个分段的结束位置
  if (!segments.length) return null;
  const last = segments[segments.length - 1];
  return last.pos + last.text.length;
}

/**
 * PM 文档位置 → 可见字符序号（反向）。
 *
 * 与 `visibleIndexToDocPos` 严格互逆：位置落在某分段起点时归到该段的**第一个序号**。
 */
export function docPosToVisibleIndex(
  segments: ReadonlyArray<VisibleTextSegment>,
  pos: number,
): number | null {
  if (!Number.isFinite(pos)) return null;
  let acc = 0;
  for (const seg of segments) {
    const len = seg.text.length;
    if (pos < seg.pos) return acc; // 落在分段之前（例如块的起始边界）→ 归到当前累计
    if (pos < seg.pos + len) return acc + (pos - seg.pos);
    acc += len;
  }
  return acc; // 落在所有分段之后 → 可见文本末尾
}

/**
 * 源码文本里每行的起始偏移（0 基行号 → 字符 offset）。
 *
 * 生成一次可复用；`lineStarts[k]` = 第 k 行第一个字符的 offset。
 * 行数口径与 `lineIndexOfOffset` 一致（`\r\n` 不特殊处理 —— 源码面文本统一为 `\n`，
 * 见 `eolPreserve` 的既有约定）。
 */
export function computeLineStarts(text: string): number[] {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/** 取某行的起始 offset（越界钳制到最后一行起点） */
export function lineStartOffset(lineStarts: ReadonlyArray<number>, line: number): number {
  if (!lineStarts.length) return 0;
  const i = Math.max(0, Math.min(lineStarts.length - 1, Math.trunc(line)));
  return lineStarts[i];
}

/**
 * 截取某块在源码里的原文切片（`[startLine, endLine)`）。
 *
 * 与 `blockSourceMap` 记录的区间**同一口径**：不含块后空行。
 * 用行起点拼接而不是 `source.slice`（需要总长度）→ 边界更直观，也便于单测。
 */
export function sliceBlockSource(
  text: string,
  lineStarts: ReadonlyArray<number>,
  range: BlockSourceRange,
): string {
  if (!lineStarts.length) return "";
  const from = lineStartOffset(lineStarts, range.startLine);
  // 结束行起点 - 1 = 该块最后一行的 `\n`（末行没换行时就是文本末尾）
  const endLineStart =
    range.endLine < lineStarts.length
      ? lineStarts[range.endLine]
      : text.length + 1;
  const to = Math.max(from, Math.min(text.length, endLineStart - 1));
  return text.slice(from, to);
}

/* ══════════════════════════════════════════════════════════════════════
 * 块行区间的**采集**（顶层块 → [startLine, endLine)）
 * ══════════════════════════════════════════════════════════════════════ */

/** 只依赖 `forEach` 的最小文档接口（PM `Node` 天然满足；单测可注入假实现） */
interface ForEachableDoc {
  forEach(cb: (node: unknown) => void): void;
}

/**
 * 从块节点上读源码区间的注入函数。
 *
 * 形状刻意与 `core/markdown/blockSourceMap` 的 `BlockSourceInfo` 一致
 *（`{start, end}`），这样生产环境可以**直接把 `getBlockSource` 传进来**，
 * 不需要中间适配层（少一层适配就少一处可能写错的地方）。
 */
export type BlockSourceProbe = (node: unknown) => { start: number; end: number } | undefined;

/**
 * 采集顶层块的源码行区间。
 *
 * ## 为什么必须"照抄 parser 的记录"而不是自己推算
 * 旧实现（`ModeSync.tsx` 编辑→阅读方向）用
 * `(node.textContent||"").split("\n").length` 累加行数来估算每个块占几行。
 * 实测证伪（`scripts/v0170-r3-blocks.mjs`）：
 *
 * | 源码 | 真实行数 | 块内 textContent 换行数 |
 * |---|---|---|
 * | `- a` / `- b` | 2 | **0**（`bullet_list` 一个块） |
 * | 表格 3 行 | 3 | **0**（`table` 一个块） |
 * | `> 引用` | 1 | 0 |
 *
 * → 估算值**系统性偏小** → 目标块越找越靠后，实测落进 `table_header` / `table_cell`。
 *
 * `parser.ts`（v0.9.0 B6）在解析期已经给每个顶层块记了权威区间
 *（`blockSourceMap`，并在 DOM 上以 `data-src-line` 暴露），直接复用即可。
 *
 * ## 跳过"结构填充段落"
 * `parser` 也会给 `emptyLine` / `pad` 段落记录区间（它们确实占了源码行），
 * 但**不参与跨面块索引**（与 `collectPmBlockGeometry` 的 `skipStructuralFill` 同口径）。
 * 这里同样跳过，保证下标与阅读面/源码行轴两侧的块索引一致。
 *
 * @param _text    源码文本（保留参数：便于将来核对行号越界，当前实现不依赖它）
 * @param probe    读块区间的注入函数（生产环境 = `getBlockSource`）
 * @param doc      顶层文档（`doc.forEach` 只遍历顶层块）
 */
export function scanBlockRanges(
  _text: string,
  probe: BlockSourceProbe,
  doc: ForEachableDoc | null | undefined,
): BlockSourceRange[] {
  if (!doc) return [];
  const out: BlockSourceRange[] = [];
  doc.forEach((node) => {
    const n = node as { type?: { name?: string }; attrs?: Record<string, unknown> };
    const info = probe(node);
    if (!info) return;
    // 结构填充段落不参与块索引（与跨面块索引同口径，见上）
    const isFill =
      n.type?.name === "paragraph" &&
      (n.attrs?.emptyLine === true || n.attrs?.pad === true);
    if (isFill) return;
    if (!Number.isFinite(info.start) || !Number.isFinite(info.end)) return;
    out.push({ startLine: info.start, endLine: info.end });
  });
  return out;
}

/* ══════════════════════════════════════════════════════════════════════
 * 编排层：源码字符 offset ↔ PM 文档 pos（#6 的落地入口）
 * ══════════════════════════════════════════════════════════════════════ */

/** 鸭子类型的 PM 文档（`forEach` 只遍历顶层块） */
export interface CaretDocLike {
  forEach(cb: (node: unknown, offset: number, index: number) => void): void;
}

/** 鸭子类型的 PM 块节点（只需要 `descendants` + 类型/属性） */
interface CaretNodeLike {
  type?: { name?: string };
  attrs?: Record<string, unknown>;
  descendants(cb: (node: CaretChildLike, pos: number) => boolean | void): void;
}

interface CaretChildLike {
  isText?: boolean;
  text?: string;
}

/**
 * 一个顶层块的完整映射上下文（权威源码区间 + 可见文本对齐）。
 *
 * `aligned === false` 表示该块的"源码原文"与"可见文本"对不上（例如块内含
 * base64 图片：源码侧是 mask 后的 `image-1.png`，PM 侧是未 mask 的长 base64）
 * —— 这种块**不做光标映射**，调用方必须回退旧路径，不许带着错位硬用。
 */
export interface PmBlockCaretInfo {
  /** doc 的顶层块下标（**含**结构填充段落，即 `doc.forEach` 的 index） */
  docIndex: number;
  /** 该块在 PM doc 中的起始 offset */
  docOffset: number;
  /** 权威源码行区间（来自 `blockSourceMap`）；缺失则为 null（新敲出来的块） */
  range: BlockSourceRange | null;
  /** 块源码（masked 展示坐标） */
  sourceText: string;
  /** 块的源码起始字符 offset */
  sourceStart: number;
  /** 块内可见文本分段 */
  segments: VisibleTextSegment[];
  /** 对齐结果；null = 无源码区间（无法建对齐） */
  alignment: BlockTextAlignment | null;
  /** 是否可直接用于光标映射 */
  aligned: boolean;
}

/**
 * 采集整个文档的"块 → 光标映射上下文"。
 *
 * ## 为什么要一次性采全文
 * 双向映射都需要"在哪个块"这个前提。按块懒采会退化成"每次都要重新建对齐"，
 * 而 `alignBlockText` 是 O(块长) —— 切一次模式遍历全文一次，与既有
 * `measureSourceBlocks` / `collectPmBlockGeometry` 同一量级，可接受。
 *
 * ## 为什么必须跳过结构填充段落的**区间**但仍保留其 `docIndex`
 * 跳过的是"不给它建对齐"（它是解析器造出来的空段落，源码区间无意义），
 * 但 `docIndex` 必须保留 **`doc.forEach` 的真实下标** —— 因为由它算
 * `docOffset`（PM pos 的基准）。两者混用会整体错位一格。
 */
export function collectPmBlockCaretInfo(
  mdText: string,
  doc: CaretDocLike | null | undefined,
  probe: BlockSourceProbe,
): PmBlockCaretInfo[] {
  if (!doc) return [];
  const lineStarts = computeLineStarts(mdText);
  const out: PmBlockCaretInfo[] = [];
  doc.forEach((rawNode, docOffset, docIndex) => {
    const node = rawNode as CaretNodeLike;
    const isFill =
      node.type?.name === "paragraph" &&
      (node.attrs?.emptyLine === true || node.attrs?.pad === true);
    if (isFill) return;
    const info = probe(rawNode);
    const range =
      info && Number.isFinite(info.start) && Number.isFinite(info.end)
        ? { startLine: info.start, endLine: info.end }
        : null;
    // 收集块内**文本节点**（不用 textContent：它会把 leaf 文本与 "\\n" 分隔符带进来，
    // 那些字符在源码里没有对应物，会让对齐凭空产生 unmatchedVisible）
    const segments: VisibleTextSegment[] = [];
    node.descendants?.((child, pos) => {
      if (child.isText && child.text) {
        segments.push({ pos: docOffset + 1 + pos, text: child.text });
      }
      return true;
    });
    const sourceStart = range ? lineStartOffset(lineStarts, range.startLine) : 0;
    const sourceText = range ? sliceBlockSource(mdText, lineStarts, range) : "";
    const visibleText = joinVisibleSegments(segments);
    const alignment = range ? alignBlockText(sourceText, visibleText) : null;
    /**
     * 判定"这块能不能用来映射光标"，需要**两道**守卫（第二道是单测抓出来的）：
     *
     * ① `unmatchedVisible > 0` → 可见文本里有源码没有的字符（对齐假设被打破）；
     * ② **可见文本为空但源码非空** → 这种块 PM 侧没有任何文本节点，
     *    光标只能落在节点边界上，映射过去的位置对用户没有意义。
     *    ⚠️ 单测实测：只判 ① 的话，纯图片块会**假通过** ——
     *    `alignBlockText("![image](image-1.png)", "")` 的 `unmatchedVisible` 天然是 0
     *    （没有可见字符，就没有字符能"找不到"），于是被判为 aligned，进而把光标映射到
     *    一个空块上。这说明 `unmatchedVisible` 单独**不足以**当哨兵，
     *    必须配"两侧是否都有可比内容"这一条。
     *
     * 反例边界：空段落（源码 ""、可见 ""）**允许**对齐 —— 两侧都空，语义一致。
     */
    const aligned =
      !!alignment &&
      alignment.unmatchedVisible === 0 &&
      !(alignment.visibleLength === 0 && sourceText.length > 0);
    out.push({ docIndex, docOffset, range, sourceText, sourceStart, segments, alignment, aligned });
  });
  return out;
}

/** 源码 offset 所在的行号（0 基），与 `lineIndexOfOffset` 同义 */
function lineOfOffset(text: string, offset: number): number {
  const n = Math.max(0, Math.min(text.length, offset));
  let line = 0;
  for (let i = 0; i < n; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** 找到包含某源码 offset 的块（按权威行区间） */
export function findBlockBySourceOffset(
  blocks: ReadonlyArray<PmBlockCaretInfo>,
  mdText: string,
  offset: number,
): PmBlockCaretInfo | null {
  if (!blocks.length) return null;
  const line = lineOfOffset(mdText, offset);
  const withRange = blocks.filter((b) => b.range);
  if (!withRange.length) return null;
  const idx = findBlockIndexByLine(
    withRange.map((b) => b.range as BlockSourceRange),
    line,
  );
  if (idx === null) return null;
  return withRange[idx];
}

/**
 * **源码字符 offset → PM 文档位置**（编辑 → 阅读方向）。
 *
 * @returns PM pos；无法可靠映射时 `null`（调用方必须回退，不许猜）
 */
export function sourceOffsetToPmPos(
  blocks: ReadonlyArray<PmBlockCaretInfo>,
  mdText: string,
  offset: number,
): number | null {
  const block = findBlockBySourceOffset(blocks, mdText, offset);
  if (!block || !block.alignment || !block.aligned) return null;
  const inBlock = Math.max(0, Math.min(block.sourceText.length, offset - block.sourceStart));
  const visIdx = sourceOffsetToVisibleIndex(block.alignment, inBlock);
  if (visIdx === null) return null;
  return visibleIndexToDocPos(block.segments, visIdx);
}

/**
 * **PM 文档位置 → 源码字符 offset**（阅读 → 编辑方向）。
 *
 * @returns 源码 offset；无法可靠映射时 `null`
 */
export function pmPosToSourceOffset(
  blocks: ReadonlyArray<PmBlockCaretInfo>,
  mdText: string,
  pos: number,
): number | null {
  if (!blocks.length || !Number.isFinite(pos)) return null;
  // 找容纳该 pos 的块（docOffset <= pos <= docOffset + 块大小）
  let hit: PmBlockCaretInfo | null = null;
  for (const b of blocks) {
    if (pos >= b.docOffset) hit = b;
    else break;
  }
  if (!hit || !hit.alignment || !hit.aligned) return null;
  const visIdx = docPosToVisibleIndex(hit.segments, pos);
  if (visIdx === null) return null;
  const inBlock = visibleIndexToSourceOffset(hit.alignment, visIdx);
  if (inBlock === null) return null;
  return hit.sourceStart + inBlock;
}

/* ══════════════════════════════════════════════════════════════════════
 * #11：打开文档时滚动落点的**决策**（纯函数，便于单测钉死语义）
 * ══════════════════════════════════════════════════════════════════════ */

/** 打开文档时滚动落点的决策结果 */
export interface OpenScrollTarget {
  /** 应写入的 scrollTop（px） */
  top: number;
  /** 是否应当执行写入（当前实现恒为 true —— 见函数注释） */
  write: boolean;
  /** 决策依据（诊断用） */
  reason: "no-progress" | "progress" | "not-scrollable";
}

/**
 * 决定「打开一个文档后滚动条应该落在哪」。
 *
 * ## 缺陷背景（用户第 11 项「新打开的文档会自动跳到文档底部」）
 *
 * 旧实现（`ModeSync.tsx:866-870`）：
 * ```ts
 * const percent = fileScrollProgress.get(progressKeyRef.current);
 * if (percent === null) return;      // ← 错在这里
 * ```
 * 「这个文件没有进度快照」被当成「**什么都不做**」。但滚动容器
 *（CM6 的 `.cm-scroller`）是**跨文档复用**的同一个 DOM 节点 ——
 * 不写就保留**上一个文档**的 `scrollTop`。
 *
 * 更糟的是 CM6 自己的 scroll anchoring 会把这个残留值**放大成"到底"**：
 * ```js
 * scrolledToBottom = elt.scrollTop > Math.max(1, sh - ch - 4);   // 旧的贴底状态
 * scrollAnchor = this.scrolledToBottom ? null : ...;             // → null
 * scrollAnchorPos = -1;
 * // 补偿：else if (scrollAnchorPos < 0) scroll.scrollTop = scroll.scrollHeight;
 * ```
 * 实测（`scripts/v0170-r3-grad-ab.mjs`，单变量）：A 在顶部 → B 落 0；
 * A 在 50% → B 落 65px；A 在底部 → **B 落 max（100%）**。
 *
 * ## 正确语义（本函数）
 * - 有合法进度 → 按百分比恢复（**同一文件**的进度，不能因为修这个缺陷而废掉）；
 * - **无进度 / 进度非法 / 内容不足一屏 → 明确写 0**（回顶部）；
 * - 永不返回"不写"（`write` 恒 true）——
 *   "不写"正是缺陷本身。返回值里保留 `write` 字段是为了让调用点读起来是
 *   "决策 → 执行"两段，而不是"我提前 return 了"这种容易再次写错的形态。
 *
 * ⚠️ 本函数**不做几何校验**：写完 0 之后 CM6 的 measure 仍可能在后续帧覆盖它
 *（`scrollAnchorPos < 0` 分支）。调用方必须做「写 → 下一帧复核 → 不是 0 就重写」，
 * 见 `ModeSync.tsx` 的 `[forceUpdateKey]` effect。
 */
export function resolveOpenScrollTarget(args: {
  percent: number | null | undefined;
  scrollHeight: number;
  clientHeight: number;
}): OpenScrollTarget {
  const { percent, scrollHeight, clientHeight } = args;
  const max = Math.max(0, scrollHeight - clientHeight);
  // 内容不足一屏：唯一合法落点就是顶部
  if (!(max > 0)) return { top: 0, write: true, reason: "not-scrollable" };
  const legal =
    typeof percent === "number" && Number.isFinite(percent) && percent >= 0 && percent <= 1;
  if (!legal) return { top: 0, write: true, reason: "no-progress" };
  return { top: Math.round(percent * max), write: true, reason: "progress" };
}

/* ══════════════════════════════════════════════════════════════════════
 * 偏移重映射：原始（解析期）文本 → 序列化后文本（行局部编辑容忍）
 * v0.17.0 R5（V2-4 跨模式光标记忆真机失效）配套
 * ══════════════════════════════════════════════════════════════════════ */

/** 行内容（不含行尾 `\n`），越界钳制到最后一行 */
function lineContentAt(text: string, lineStarts: ReadonlyArray<number>, line: number): string {
  const from = lineStartOffset(lineStarts, line);
  const to = line + 1 < lineStarts.length ? lineStarts[line + 1] - 1 : text.length;
  return text.slice(from, to);
}

/**
 * 把字符偏移从 `fromText` 重映射到 `toText`（**行局部编辑**容忍版）。
 *
 * ## 与 `utils/textOffsetRemap.ts` 的 `remapOffsetAcrossTextChange` 的区别
 * 那个函数把差异夹成**单一连续区间**（公共前缀 + 公共后缀），适合"一次编辑"
 * 场景（撤销/恢复）。但「阅读 → 编辑」的原文 → 序列化文本分歧是**多区域**的：
 * - 块前后补空行（多处行插入/删除，实测 +3）；
 * - `normalizeOrderedLists` 改写有序列表标记长度（多处行首变化）；
 * - 硬换行补 `"  "`（一段 200 行各 +2 字符 = 200 处行尾变化）。
 * 公共前缀/后缀口径会把这些并成一个巨型变更区间 → 区间内偏移全部被"贴边"到
 * 首个分歧行 —— 光标直接飞到文档前部（V2-4 实测落 31/32/33 就是这类形态）。
 *
 * ## 算法（锚点切段 + 段内贪心 + 行内三条规则）
 * ① **锚点**：内容在两侧都**唯一**出现的行（同内容只出现一次 ⇒ 必然对应同一
 *    逻辑行），按序配对。⚠️ 不能只靠双指针贪心：重复空行在歧义点会被错配
 *    （实测「双空行收敛 + 列表前补空行」会让下一行内容被误判成删除行），
 *    锚点把两文本切成小段后这个问题不存在。
 * ② **段内**（锚点之间的小段）：等值行即配对；对不上时按**剩余行数差**处理
 *    （from 多 = 删除该行、to 多 = 跳过该行、相等 = 同一逻辑行被改写）。
 * ③ **行内**（与 `remapOffsetAcrossTextChange` 同三条规则）：
 *    行内容未变 → **恒等**（Lead 口径「非列表块偏移不变，直接使用」）；
 *    否则：偏移在公共前缀内 → 不动；在公共后缀内（含行尾）→ 跟随行尾平移；
 *    落在行内变更区 → 贴到变更起点（不按比例凭空造位置）。
 *    被删除的行 → 贴到删除点（当前 to 行首）。
 *
 * ## 纪律
 * - 纯函数；越界 / 非有限数一律钳制，绝不返回 NaN；
 * - 不确定时宁可贴边，绝不返回 0 兜底（0 是"回顶部"的老 bug 口径）。
 */
export function remapOffsetAcrossLineEdits(
  fromText: string,
  toText: string,
  offset: number,
): number {
  const from = String(fromText ?? "");
  const to = String(toText ?? "");
  const off0 = Number.isFinite(offset)
    ? Math.max(0, Math.min(from.length, Math.trunc(offset)))
    : 0;
  if (from.length === 0) return Math.min(off0, to.length);
  if (to.length === 0) return 0;
  if (from === to) return off0;

  const fromStarts = computeLineStarts(from);
  const toStarts = computeLineStarts(to);
  const nFrom = fromStarts.length;
  const nTo = toStarts.length;
  const fLine = (i: number) => lineContentAt(from, fromStarts, i);
  const tLine = (j: number) => lineContentAt(to, toStarts, j);

  // ① 唯一内容行 = 锚点（两侧各只出现一次 ⇒ 同一逻辑行，配对无歧义）
  const fromCount = new Map<string, number>();
  for (let i = 0; i < nFrom; i++) {
    const f = fLine(i);
    fromCount.set(f, (fromCount.get(f) ?? 0) + 1);
  }
  const toCount = new Map<string, number>();
  const toFirst = new Map<string, number>();
  for (let j = 0; j < nTo; j++) {
    const t = tLine(j);
    toCount.set(t, (toCount.get(t) ?? 0) + 1);
    if (!toFirst.has(t)) toFirst.set(t, j);
  }
  const anchors: Array<[number, number]> = [];
  let lastJ = -1;
  for (let i = 0; i < nFrom; i++) {
    const f = fLine(i);
    if ((fromCount.get(f) ?? 0) !== 1) continue;
    const j = toFirst.get(f);
    if (j === undefined || (toCount.get(f) ?? 0) !== 1) continue;
    if (j <= lastJ) continue; // 保序过滤（同源文本不重排，理论不触发）
    anchors.push([i, j]);
    lastJ = j;
  }

  // ② 锚点切段 + 段内贪心。pairTo[i]：配对的 to 行；-2 = 被删除。
  // delTarget[i]：被删除行的"贴边"目标（to 行号；nTo = 贴 to 末尾）。
  const pairTo = new Array<number>(nFrom).fill(-2);
  const delTarget = new Array<number>(nFrom).fill(nTo);
  let pi = 0;
  let pj = 0;
  const segEnds: Array<[number, number]> = [...anchors, [nFrom, nTo]];
  for (const [ai, aj] of segEnds) {
    let i = pi;
    let j = pj;
    while (i < ai && j < aj) {
      if (fLine(i) === tLine(j)) {
        pairTo[i] = j;
        i++;
        j++;
        continue;
      }
      const nfRem = ai - i;
      const ntRem = aj - j;
      if (nfRem > ntRem) {
        // from 侧多行 → 该行在 to 中被删除，贴到当前位置（删除点）
        pairTo[i] = -2;
        delTarget[i] = j;
        i++;
      } else if (ntRem > nfRem) {
        j++; // to 侧多行 → 插入行，from 不动
      } else {
        // 行数相等却对不上 → 同一逻辑行被改写（列表标记改宽 / 行尾补 "  "）
        pairTo[i] = j;
        i++;
        j++;
      }
    }
    for (; i < ai; i++) {
      pairTo[i] = -2;
      delTarget[i] = j;
    }
    pi = ai;
    pj = aj;
    if (pi < nFrom) {
      // 锚点行自身：等值配对（锚点定义即内容相同）
      pairTo[pi] = pj;
    }
    pi++;
    pj++;
  }

  // ③ offset 所在的 from 行
  let L = 0;
  for (let k = nFrom - 1; k >= 0; k--) {
    if (fromStarts[k] <= off0) {
      L = k;
      break;
    }
  }
  const inLine = off0 - fromStarts[L];
  const J = pairTo[L];

  // ④ 行内映射
  if (J >= 0) {
    const f = fLine(L);
    const t = tLine(J);
    if (f === t) return toStarts[J] + inLine;
    let p = 0;
    const minLen = Math.min(f.length, t.length);
    while (p < minLen && f.charCodeAt(p) === t.charCodeAt(p)) p++;
    if (inLine <= p) return toStarts[J] + inLine;
    let s = 0;
    const sMax = minLen - p;
    while (s < sMax && f.charCodeAt(f.length - 1 - s) === t.charCodeAt(t.length - 1 - s)) s++;
    const tailDist = f.length - inLine;
    if (tailDist <= s) return toStarts[J] + (t.length - tailDist);
    return toStarts[J] + Math.min(p, t.length);
  }

  // ⑤ 被删除的行：贴到删除点（当前 to 行首）；删到文末则贴 to 末尾
  const dTarget = delTarget[L];
  return dTarget >= nTo ? to.length : toStarts[dTarget];
}

