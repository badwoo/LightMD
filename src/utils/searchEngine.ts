/**
 * searchEngine —— 搜索/替换的纯函数层（v0.14.0 需求2「搜索功能增强」）
 *
 * 为什么单独抽一层：
 * 1. 面板（SearchReplace.tsx）要同时服务阅读模式（ProseMirror）与编辑模式（textarea 源码），
 *    两条路径的「匹配集合」「范围约束」「替换后范围平移」必须完全一致，抽成纯函数才可能被
 *    单元测试逐条锁住（历史踩坑：两条路径各写一套，正则/偏移语义总是会漂）。
 * 2. 本层**不引入 React / DOM**（只 import prosemirror-model 的类型），可在 node 环境直接测。
 *
 * 术语：
 * - 「文本偏移」= 把文档摊平成纯文本后的字符下标（PM 走 buildOffsetMap 的 text，源码走
 *   textarea 值）；换行统一为 "\n"。
 * - 「范围」= 用户在「选取范围内」勾选瞬间捕获的文本区间 [start, end)，随替换增量平移。
 */
import type { Node as PMNode } from "prosemirror-model";

// ─── 基础类型 ─────────────────────────────────────────────

/** 匹配区间，`end` 不含端点 */
export interface MatchRange {
  start: number;
  end: number;
}

/**
 * 搜索选项（面板勾选项的纯数据形态）
 *
 * - `range`：仅当「选取范围内」勾选且成功取到选区时才有值；**空范围**用 `{start:0,end:0}`
 *   表示（面板在无选区时故意传空范围 → 匹配数 0，见 SearchReplace.tsx 里的注释）。
 */
export interface SearchOptions {
  caseSensitive?: boolean;
  useRegex?: boolean;
  wholeWord?: boolean;
  range?: { start: number; end: number } | null;
}

/** 单次搜索最多收集的匹配数（与 v0.4.2 的 1 万上限保持一致，防止病态正则拖死 UI） */
export const MAX_MATCHES = 10000;
/** 单文件最多收集的结果行数 */
export const MAX_FILE_RESULTS = 500;
/** 结果条幅最多收集的文件数（打开标签很多时的兜底；超出的文件不参与搜索） */
export const MAX_FILES = 200;
/** 结果条幅里单行内容的显示上限（超长行以命中处为中心裁剪） */
export const MAX_DISPLAY_LINE_LEN = 160;

// ─── 正则构造 ─────────────────────────────────────────────

/**
 * 全词匹配的「词字符」集合。
 *
 * 为什么用 Unicode 属性转义而不是 \w：
 * - \w 只认 ASCII 字母数字下划线，`中文` 会被当成非词字符 → 搜「测试」在「测试一下」里
 *   会被判成整词（错），在「我的测试」里也被判成整词（错）。
 * - `[\p{L}\p{N}_]` 覆盖所有语言的字母/数字 + 下划线：`cat` 不匹配 `concat`/`cats`，
 *   而「测试」不会匹配「我的测试」（"我" 是 \p{L}）。
 * 代价：必须开 `u` 标志（见 buildSearchRegexEx 里的说明）。
 */
const WORD_CHAR_CLASS = "[\\p{L}\\p{N}_]";

/**
 * 按选项构造全局正则（v0.14.0 扩展版）。
 *
 * 行为：
 * - 关闭正则：全量转义元字符（v0.4.2 字面量语义不变）
 * - 开启正则：直接按正则语义构造
 * - 全词匹配：用零宽断言包裹表达式体（不改匹配文本长度，只加两侧边界约束）
 * - 非法正则 → 返回 null（面板据此红字提示 + 禁用查找，绝不抛异常）
 *
 * 为什么只在「全词匹配」时才加 `u` 标志：
 * `\p{L}` 这类属性转义必须带 `u`；但在 `u` 模式下 `\{` `\}` 这类「恒等转义」会直接
 * 抛语法错误，而字面量搜索里 `{`/`}` 是完全合法的搜索内容（搜 `{a}` 很常见）。
 * 所以：需要\p{…} 时才开 `u`，其余情况保持历史 flags 不变，避免改变既有语义。
 *
 * 已知限制（写进 JSDoc 免踩）：全词匹配 + 正则模式下用户表达式必须满足 `u` 模式语法；
 * 另外全词匹配用的是 lookbehind（零宽反向断言），WebView2/Chromium 与 Node 18+ 均支持。
 *
 * @param searchText 用户关键词/表达式
 * @param opts 搜索选项（大小写、正则、全词）
 * @returns 带 `g` 标志的 RegExp；空关键词或非法表达式返回 null
 */
export function buildSearchRegexEx(searchText: string, opts: SearchOptions = {}): RegExp | null {
  if (!searchText) return null;
  const caseSensitive = opts.caseSensitive === true;
  const useRegex = opts.useRegex === true;
  const wholeWord = opts.wholeWord === true;
  const flags = `${caseSensitive ? "g" : "gi"}${wholeWord ? "u" : ""}`;
  // 字面量模式：转义正则元字符（与 buildSearchRegex 的字符集完全一致）
  const body = useRegex ? searchText : searchText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 非捕获组包住表达式体：用户写 `a|b` 时断言只作用于整体，而不是 `a` 或 `b(x)` 的局部
  const pattern = wholeWord ? `(?<!${WORD_CHAR_CLASS})(?:${body})(?!${WORD_CHAR_CLASS})` : body;
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

/**
 * 在文本中搜索匹配区间（v0.14.0 扩展版，textarea / PM 两条路径共用）。
 *
 * 范围过滤规则：**完全落在范围内才算命中**（部分重叠不算）。
 * 为什么不用「有交集就算」：勾选「选取范围内」后替换必须在范围内进行，只要允许部分重叠，
 * 替换就会改写范围外的字符（用户明确要求「替换的内容也必须是选取范围内」）。
 *
 * 零长匹配处理：`x*` 这类表达式在每处都产生零长结果，直接丢弃并强制 `lastIndex++`，
 * 否则 `exec` 会原地死循环（历史坑，v0.4.2 已踩过一次）。
 *
 * @returns 匹配区间数组；开启正则且表达式非法时返回 null；空关键词返回 []
 */
export function findMatchRangesEx(
  text: string,
  searchText: string,
  opts: SearchOptions = {},
): MatchRange[] | null {
  if (!searchText) return [];
  const regex = buildSearchRegexEx(searchText, opts);
  if (!regex) return null;
  const ranges: MatchRange[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match[0].length === 0) {
      // 零长匹配：前进一格，避免死循环
      regex.lastIndex++;
      continue;
    }
    ranges.push({ start: match.index, end: match.index + match[0].length });
    if (ranges.length > MAX_MATCHES) break;
  }
  const range = opts.range;
  if (!range) return ranges;
  return ranges.filter((r) => r.start >= range.start && r.end <= range.end);
}

// ─── 范围平移（「选取范围内」替换后仍成立的核心）──────────────

/**
 * 单次编辑后平移一个区间。
 *
 * 数学模型：把编辑看成一个「位置映射」
 * ```
 * map(pos) = pos                                   pos <= editStart        （编辑点及其左侧不变）
 *          = editStart + insertedLen                editStart < pos < editStart+removedLen
 *                                                   （落在被删掉的区间内部 → 收敛到替换文本末尾）
 *          = pos + insertedLen - removedLen        pos >= editStart+removedLen（右侧整体平移）
 * ```
 *
 * 三条边界说明（都是面板真实会遇到的场景）：
 * 1. **替换发生在范围内**（editStart 与 editStart+removedLen 都在 [start,end) 内）：
 *    start 不变，end 随增量伸缩 → 范围继续罩住同一段语义内容。
 * 2. **替换正好覆盖范围起点**（editStart === start）：start 保持不动（映射左端点粘左），
 *    若替换文本比原文长，范围会把替换文本罩进来（end 右移），这是「替换后范围仍成立」的正确解。
 * 3. **替换正好覆盖范围终点 / 完全在范围之外**：
 *    - 覆盖终点：end === editStart+removedLen → end 右移 delta（贴回替换文本末尾）；
 *    - 完全在范围之外（左侧）：start/end 同时平移 delta；
 *    - 完全在范围之外（右侧）：不变。
 *
 * 注意：本函数只处理**一次**编辑；连续多次编辑必须按「编辑发生的先后顺序」逐次调用，
 * 且每次传入的坐标是**当时那版文本**的坐标（见 SearchReplace.tsx 里 replaceAll 的 delta 累加）。
 *
 * @param range 待平移区间
 * @param editStart 编辑起点（文本偏移）
 * @param removedLen 被删除的字符数（纯插入为 0）
 * @param insertedLen 新插入的字符数（纯删除为 0）
 * @returns 新区间（保证 end >= start）
 */
export function shiftRange(
  range: MatchRange,
  editStart: number,
  removedLen: number,
  insertedLen: number,
): MatchRange {
  const delta = insertedLen - removedLen;
  const removedEnd = editStart + removedLen;
  const mapPos = (pos: number): number => {
    if (pos <= editStart) return pos;
    if (pos >= removedEnd) return pos + delta;
    return editStart + insertedLen;
  };
  const start = mapPos(range.start);
  const end = mapPos(range.end);
  return { start, end: Math.max(start, end) };
}

/**
 * 「一次替换」后平移区间（shiftRange 的替换语义包装）。
 *
 * 与 shiftRange 的差别只在语义表达与防御性夹取：替换路径传的是「命中区间 + 替换文本长度」，
 * 并负责兜底 `end >= start`（替换文本被删光时区间塌陷为空区间，面板据此显示「请重新选取」）。
 * 单独留一个函数名是为了让调用点读起来是「替换后范围怎么变」而不是裸坐标运算。
 *
 * @param range 待平移区间
 * @param replacedAt 被替换内容的起点（文本偏移）
 * @param removedLen 被替换掉的字符数（= 命中区间长度）
 * @param insertedLen 替换文本的字符数
 */
export function applyReplacementToRange(
  range: MatchRange,
  replacedAt: number,
  removedLen: number,
  insertedLen: number,
): MatchRange {
  return shiftRange(range, replacedAt, removedLen, insertedLen);
}

// ─── 换行归一化与偏移换算 ─────────────────────────────────

/**
 * 把 CRLF / CR 统一成 LF。
 *
 * 为什么必须先归一化：textarea.value 与 DOM 文本都只给 "\n"，而磁盘文件常见 "\r\n"。
 * 若直接在含 "\r" 的原始串上用归一化文本算出来的偏移，每遇到一个 "\r\n" 就错位一格
 * （v0.4.4 已踩过一次：高亮选中了错误的字符）。
 */
export function normalizeNewlines(s: string): string {
  // 仅当真的含 \r 时才开始替换：大文件上避免无谓的全量复制
  return s.indexOf("\r") === -1 ? s : s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * 构建「规范化偏移 → 原始偏移」映射表，用于把归一化文本上的替换区间贴回原始字符串。
 *
 * `map[k]` = 规范化文本第 k 个字符在原始串中的起始下标；`map[norm.length]` = 原始串长度。
 * 无 "\r" 时返回 null（调用方直接按原坐标用，零开销）。
 *
 * 边界：区间 [start,end) 若正好含 "\r\n"，map[start] 指向 "\r"、map[end] 指向换行后首字符，
 * 于是替换会整块吃掉 "\r\n"，不会残留孤立 "\r"。
 */
export function buildRawOffsetMap(raw: string): number[] | null {
  if (raw.indexOf("\r") === -1) return null;
  const map: number[] = [];
  let i = 0;
  while (i < raw.length) {
    map.push(i);
    if (raw[i] === "\r") {
      i += raw[i + 1] === "\n" ? 2 : 1;
    } else {
      i++;
    }
  }
  map.push(raw.length);
  return map;
}

/**
 * 把**原始串**上的偏移换算成**归一化文本**上的偏移（textarea 选区 → 搜索偏移）。
 *
 * 计数法：原始串前 rawOffset 个字符里每个 "\r\n"/"\r" 都多占 1 格，减掉即可。
 */
export function rawOffsetToNormalized(raw: string, rawOffset: number): number {
  if (raw.indexOf("\r") === -1) return rawOffset;
  const limit = Math.max(0, Math.min(rawOffset, raw.length));
  let norm = 0;
  for (let i = 0; i < limit; i++) {
    if (raw[i] === "\r") {
      if (raw[i + 1] === "\n") {
        i++; // "\r\n" 合起来算 1 个规范化字符
      }
      // 孤立 "\r" 也只算 1 个规范化字符
    }
    norm++;
  }
  return norm;
}

// ─── ProseMirror 文本偏移映射（从 SearchReplace.tsx 抽出的原实现，语义不变）──

/** 偏移映射块：记录每个文本节点在 textContent 中的偏移范围和对应的 PM 起始位置 */
export interface OffsetBlock {
  /** 该文本节点在 textContent 中的起始偏移 */
  textStart: number;
  /** 该文本节点在 textContent 中的结束偏移（不含） */
  textEnd: number;
  /** 该文本节点在 PM 文档中的起始位置 */
  pmStart: number;
}

/** 偏移映射结果：text 与 blocks 在同一趟遍历中产出，保证两者偏移完全一致 */
export interface OffsetMap {
  text: string;
  blocks: OffsetBlock[];
}

/**
 * 构建块级偏移映射数组，同时构建 textContent。
 *
 * 关键点（v0.3.5 修复过的问题2）：text 与 blocks **必须在同一次遍历中构建**。
 * 旧实现用 doc.textBetween 取 text、另一趟构建 blocks，两边的换行插入逻辑不一致，
 * 于是「高亮位置整体偏移」。
 *
 * 文本换行规则：块与块之间插一个 "\n"（连续多块只插一个，因为 lastBlockPos 用完即清）。
 */
export function buildOffsetMap(doc: PMNode): OffsetMap {
  const blocks: OffsetBlock[] = [];
  let textOffset = 0;
  let lastBlockPos = -1;
  let text = "";

  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      // 块边界换行符：textContent 在块边界插入换行符
      if (lastBlockPos >= 0) {
        textOffset += 1;
        text += "\n";
        lastBlockPos = -1;
      }
      blocks.push({
        textStart: textOffset,
        textEnd: textOffset + node.text.length,
        pmStart: pos,
      });
      text += node.text;
      textOffset += node.text.length;
    } else if (node.isBlock && !node.isInline && pos > 0) {
      lastBlockPos = pos;
    }
    return true;
  });

  return { text, blocks };
}

/**
 * 从文本偏移量查找 PM 位置（二分查找，O(log n)）。
 * @returns 落在某个文本块内时返回对应 PM 位置；落在块间隙（换行符）或越界时返回 undefined
 */
export function lookupPmPos(blocks: OffsetBlock[], textOffset: number): number | undefined {
  let lo = 0;
  let hi = blocks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const block = blocks[mid];
    if (textOffset < block.textStart) {
      hi = mid - 1;
    } else if (textOffset >= block.textEnd) {
      lo = mid + 1;
    } else {
      return block.pmStart + (textOffset - block.textStart);
    }
  }
  return undefined;
}

/**
 * 从 PM 位置反查文本偏移（lookupPmPos 的逆运算，「选取范围内」在阅读模式下取快照用）。
 *
 * 边界处理：
 * - pmPos 落在某块内部 → 精确换算；
 * - pmPos 落在块间隙（段落边界）→ 收敛到**前一块末尾**（textEnd），
 *   避免选区终点把下一块的换行吞进范围里；
 * - pmPos 早于第一个文本块 → undefined；晚于最后一块末尾 → 收敛到最后一块末尾。
 */
export function pmPosToTextOffset(blocks: OffsetBlock[], pmPos: number): number | undefined {
  if (blocks.length === 0) return undefined;
  if (pmPos < blocks[0].pmStart) return undefined;
  let lo = 0;
  let hi = blocks.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid].pmStart <= pmPos) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return undefined;
  const block = blocks[found];
  const len = block.textEnd - block.textStart;
  const offsetInBlock = Math.max(0, Math.min(pmPos - block.pmStart, len));
  return block.textStart + offsetInBlock;
}

// ─── 多文件结果条幅 ───────────────────────────────────────

/** 结果行的一段文本：`match` 为 true 的段要在 UI 里加高亮 */
export interface SearchLineSegment {
  text: string;
  match: boolean;
}

/**
 * 一条搜索结果（「一行」一条，而不是「一处」一条）。
 *
 * 为什么按行合并：用户诉求是「条目后面是该文件搜索到的内容所在的行的内容」，
 * 同一行命中多次时展示整行、把该行所有命中都高亮才符合阅读习惯；
 * 若一处一条，同一行会重复出现多次，条幅又长又难分辨。
 *
 * 字段口径（很重要，UI/跳转都依赖）：
 * - `line` / `column`：1 基行号、1 基列号，指**原文**中该行首个命中的位置（跳转用）
 * - `lineText`：**用于显示**的行文本（超长时已裁剪并带省略号）
 * - `matchStart` / `matchEnd`：首个命中在 `lineText` 内的偏移（高亮/就地跳转定位用）
 * - `segments`：按 `lineText` 切好的分段，`match=true` 的段渲染成 `<mark>`
 * - `ranges`：该行**所有**命中在原文该行内的偏移（不含裁剪）；需要原文全局偏移时
 *   用 `行首偏移 + ranges[i].start` 换算
 */
export interface SearchFileResult {
  fileKey: string;
  filePath: string;
  fileName: string;
  line: number;
  column: number;
  matchStart: number;
  matchEnd: number;
  lineText: string;
  segments: SearchLineSegment[];
  ranges: MatchRange[];
  /**
   * 该行**首个**命中在本文件全部命中中的序号（0 基）。
   *
   * 用途同 SearchJumpTarget.occurrence：跨文本空间（源码 → PM 渲染文本）跳转时
   * 行号/列号会错位，但关键词出现的次序是稳定的，用「第 N 次出现」定位最可靠。
   * 一行多个命中时，后续命中可以用 `occurrence + 行内序号` 推算。
   */
  occurrence: number;
}

/** 文件元信息（由调用方提供，纯函数层不认识 store / 标签页） */
export interface SearchFileMeta {
  fileKey: string;
  filePath: string;
  fileName: string;
}

/**
 * 单文件搜索选项：SearchOptions + 关键词。
 *
 * 为什么关键词要跟选项一起传：collectFileResults 需要「内容 + 选项 + 关键词」三样，
 * 拆成 4 个位置参数后调用点容易把顺序写错；挂进选项对象后签名保持 (content, opts, meta)，
 * 与 findMatchRangesEx 的 (text, searchText, opts) 只差在「关键词的位置」。
 */
export interface FileSearchOptions extends SearchOptions {
  query: string;
}

/** collectFileResults 的返回结构 */
export interface CollectFileResults {
  /** 命中的行（最多 MAX_FILE_RESULTS 条） */
  results: SearchFileResult[];
  /** 是否因为超过 MAX_FILE_RESULTS 而截断（UI 需要提示「结果过多，仅显示前 N 条」） */
  truncated: boolean;
  /** 实际统计到的命中总数（截断时只统计到截断为止，UI 提示语据此区分） */
  matchCount: number;
}

/**
 * 把一行按命中区间切成「普通段 / 高亮段」。
 * 重叠区间（理论上不该出现）直接跳过后一个，避免同段文本被渲染两次。
 */
function buildSegments(text: string, ranges: MatchRange[]): SearchLineSegment[] {
  const segments: SearchLineSegment[] = [];
  let cursor = 0;
  for (const r of ranges) {
    if (r.start < cursor) continue;
    if (r.start > cursor) segments.push({ text: text.slice(cursor, r.start), match: false });
    segments.push({ text: text.slice(r.start, r.end), match: true });
    cursor = r.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
  return segments;
}

/** 裁剪结果：displayText 与重新映射后的命中区间（display 坐标系） */
interface ClipResult {
  displayText: string;
  ranges: MatchRange[];
  clippedHead: boolean;
}

/**
 * 以「首个命中」为中心裁剪超长行（内部实现，供 clipLineForDisplay 与 collectFileResults 共用）。
 *
 * 为什么以命中为中心：命中可能落在 5000 字的一行末尾，从头截 160 字根本看不到关键词。
 * 省略号计入 maxLen；`clippedHead` 为 true 表示显示文本前面有「…」（头部被裁）。
 */
function clipLineInternal(lineText: string, ranges: MatchRange[], maxLen: number): ClipResult {
  const limit = Math.max(8, maxLen);
  if (lineText.length <= limit) {
    return { displayText: lineText, ranges: ranges.map((r) => ({ ...r })), clippedHead: false };
  }
  const focus = ranges[0] ?? { start: 0, end: 0 };
  const matchLen = Math.max(1, focus.end - focus.start);
  const before = Math.max(0, Math.floor((limit - matchLen) / 2));
  // 先按「命中前留 before 个字」定窗口，再夹进 [0, len-limit]（贴边时窗口整体内移）
  let sliceStart = focus.start - before;
  sliceStart = Math.max(0, Math.min(sliceStart, Math.max(0, lineText.length - limit)));
  const sliceEnd = Math.min(lineText.length, sliceStart + limit);
  const clippedHead = sliceStart > 0;
  const clippedTail = sliceEnd < lineText.length;
  const headMarker = clippedHead ? "…" : "";
  const tailMarker = clippedTail ? "…" : "";
  const displayText = `${headMarker}${lineText.slice(sliceStart, sliceEnd)}${tailMarker}`;
  const shift = (clippedHead ? 1 : 0) - sliceStart;
  const mapped = ranges
    .map((r) => ({
      start: Math.max(0, Math.min(displayText.length, r.start + shift)),
      end: Math.max(0, Math.min(displayText.length, r.end + shift)),
    }))
    .filter((r) => r.end > r.start);
  return { displayText, ranges: mapped, clippedHead };
}

/** 行裁剪结果（UI 可直接用：高亮偏移已是 displayText 内的坐标） */
export interface ClippedLine {
  displayText: string;
  displayMatchStart: number;
  displayMatchEnd: number;
  /** 头部是否被裁（displayText 以「…」开头） */
  clippedHead: boolean;
}

/**
 * 视觉行裁剪：行太长时以命中处为中心裁剪并加省略号，保证高亮位置仍然正确。
 *
 * @param lineText 原始行文本
 * @param matchStart 命中在该行内的起始偏移
 * @param matchEnd 命中在该行内的结束偏移（不含）
 * @param maxLen 显示上限（含省略号；内部至少按 8 处理）
 */
export function clipLineForDisplay(
  lineText: string,
  matchStart: number,
  matchEnd: number,
  maxLen = MAX_DISPLAY_LINE_LEN,
): ClippedLine {
  const clipped = clipLineInternal(lineText, [{ start: matchStart, end: matchEnd }], maxLen);
  const first = clipped.ranges[0];
  if (!first) {
    // 命中完全在窗口外（理论上不会：窗口以命中为中心；这里兜底成行首 0 宽高亮）
    return {
      displayText: clipped.displayText,
      displayMatchStart: 0,
      displayMatchEnd: 0,
      clippedHead: clipped.clippedHead,
    };
  }
  return {
    displayText: clipped.displayText,
    displayMatchStart: first.start,
    displayMatchEnd: first.end,
    clippedHead: clipped.clippedHead,
  };
}

/**
 * 按行收集单个文件的搜索结果（纯函数；IO 由调用方负责，面板只调 getText()）。
 *
 * 规则：
 * - CRLF/CR 先归一化成 LF 再算行号/列号（否则 \r 会污染列号）
 * - 每行**一条**结果，该行所有命中都进 `segments`（见 SearchFileResult 的注释）
 * - 跨行匹配（正则里写了 `[\s\S]` 之类）归到**起始行**，高亮截到行尾
 * - `opts.range` 按本文本自身坐标过滤（面板只对「当前文档」传 range：
 *   选区范围是当前文档的坐标，套到别的文件上毫无意义，且会误杀所有结果）
 * - 超过 MAX_FILE_RESULTS 行 → `truncated = true` 并停止收集
 *
 * @param content 文件全文（原始串，可含 CRLF）
 * @param opts 关键词 + 选项
 * @param meta 文件标识（fileKey/filePath/fileName 原样回填给 UI）
 */
export function collectFileResults(
  content: string,
  opts: FileSearchOptions,
  meta: SearchFileMeta,
): CollectFileResults {
  const query = opts.query;
  if (!query) return { results: [], truncated: false, matchCount: 0 };
  const text = normalizeNewlines(content);
  const all = findMatchRangesEx(text, query, opts);
  if (!all || all.length === 0) return { results: [], truncated: false, matchCount: 0 };

  // 行首偏移表（1 基行号 = 下标 + 1）
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") lineStarts.push(i + 1);
  }

  const results: SearchFileResult[] = [];
  let truncated = false;
  let matchCount = 0;
  let mi = 0;
  // 全局命中序号（跨行累计），用于给每行回填 occurrence
  let occurrenceCursor = 0;
  for (let li = 0; li < lineStarts.length; li++) {
    const lineStart = lineStarts[li];
    // 行尾：下一行行首 - 1（去掉 \n）；最后一行直接到文末
    const lineEnd = li + 1 < lineStarts.length ? lineStarts[li + 1] - 1 : text.length;
    const lineRanges: MatchRange[] = [];
    const lineFirstOccurrence = occurrenceCursor;
    while (mi < all.length && all[mi].start < lineEnd) {
      const m = all[mi];
      mi++;
      const start = Math.max(0, m.start - lineStart);
      const end = Math.min(lineEnd - lineStart, m.end - lineStart);
      // 跨行匹配截到行尾后可能为空（例如命中正好落在行尾换行上），此时忽略
      if (end > start) {
        lineRanges.push({ start, end });
        occurrenceCursor++;
      }
    }
    if (lineRanges.length === 0) continue;
    matchCount += lineRanges.length;
    if (results.length >= MAX_FILE_RESULTS) {
      truncated = true;
      break;
    }
    const fullLine = text.slice(lineStart, lineEnd);
    const clipped = clipLineInternal(fullLine, lineRanges, MAX_DISPLAY_LINE_LEN);
    const first = clipped.ranges[0] ?? { start: 0, end: 0 };
    results.push({
      fileKey: meta.fileKey,
      filePath: meta.filePath,
      fileName: meta.fileName,
      line: li + 1,
      column: lineRanges[0].start + 1,
      matchStart: first.start,
      matchEnd: first.end,
      lineText: clipped.displayText,
      segments: buildSegments(clipped.displayText, clipped.ranges),
      ranges: lineRanges,
      occurrence: lineFirstOccurrence,
    });
  }
  return { results, truncated, matchCount };
}

// ─── 跨组件跳转定位 ───────────────────────────────────────

/**
 * 按「行号 + 列号 + 关键词」在文本里定位命中偏移（结果条幅点击跳转用）。
 *
 * 为什么不是单纯的 line/column 换算：条幅结果与当前文档可能来自**不同时刻**的文本
 * （用户刚改过字、或 PM 文本与源码文本存在换行差异），只按行列硬算会跳到错位置。
 * 所以分三级降级：
 * 1. 行列换算出的位置处文本正好等于关键词（大小写不敏感）→ 直接采用；
 * 2. 否则在该行内找关键词；再不行在全文找首个关键词；
 * 3. 都不行 → 仍然返回行列换算结果（正则模式下关键词不是字面文本，只能信行列）。
 *
 * @returns 文本偏移；行号越界到无法换算时返回 -1
 */
export function resolveJumpOffset(
  text: string,
  target: { line: number; column: number; query: string },
): number {
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") lineStarts.push(i + 1);
  }
  const lineIdx = Math.max(0, Math.min(target.line - 1, lineStarts.length - 1));
  const lineStart = lineStarts[lineIdx];
  const lineEnd = lineIdx + 1 < lineStarts.length ? lineStarts[lineIdx + 1] - 1 : text.length;
  const candidate = Math.min(lineStart + Math.max(0, target.column - 1), text.length);
  const query = target.query;
  if (!query) return candidate;
  const sameText = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const atCandidate = text.slice(candidate, candidate + query.length);
  if (atCandidate.length === query.length && sameText(atCandidate, query)) return candidate;
  // 行内找（列号因换行差异偏了几格时仍能命中）
  const lineText = text.slice(lineStart, lineEnd);
  const inLine = lineText.toLowerCase().indexOf(query.toLowerCase());
  if (inLine >= 0) return lineStart + inLine;
  // 全文兜底
  const global = text.toLowerCase().indexOf(query.toLowerCase());
  if (global >= 0) return global;
  return candidate;
}

/**
 * 按「第 N 次出现」把跨文件跳转目标落到**当前文本空间**的字符偏移。
 *
 * 为什么不用行号：搜索结果是在**源码空间**算的（collectFiles 的 getText 返回 markdown 源码），
 * 而跳到目标文件后若处于阅读模式，当前文本空间是 PM 渲染文本（语法记号已被解析掉/重排），
 * 行号/列号必然错位。关键词出现的**次序**在两个空间里是稳定的
 * （渲染文本是源码去掉语法记号后的子序列），所以用 occurrence 定位，退化为「第 N 次出现」。
 *
 * 三级降级（顺序不可换，越靠前越精确）：
 * 1. occurrence 在范围内且该处文本确实是关键词 → 直接用它
 *    （用 `opts` 的选项做匹配，保证与搜索时的口径一致）；
 * 2. 文本里只有**唯一**一处 query → 用那一处（源码里出现多次、渲染文本只合并成一处的
 *    情况很常见，比如链接文字与 URL 相同）；
 * 3. 都不行 → 返回 null，调用方给「无法跳转」提示（不瞎跳，跳错比不跳更让人困惑）。
 *
 * @param text 当前文本空间的内容（阅读模式 = buildOffsetMap().text，编辑模式 = 源码归一化文本）
 * @param query 搜索关键词（原文大小写）
 * @param occurrence 0 基的出现序号
 * @param opts 搜索选项（大小写/正则/全词；**不要**传 range —— 跨空间的范围没有可比性）
 * @returns 命中起始字符偏移；无法定位返回 null
 */
export function resolveJumpByOccurrence(
  text: string,
  query: string,
  occurrence: number,
  opts: SearchOptions = {},
): number | null {
  if (!query) return null;
  // 跨空间不能带范围约束（源码里的范围坐标在渲染文本里毫无意义）
  const ranges = findMatchRangesEx(text, query, {
    caseSensitive: opts.caseSensitive,
    useRegex: opts.useRegex,
    wholeWord: opts.wholeWord,
    range: null,
  });
  if (!ranges || ranges.length === 0) return null;
  // ① 首选：按次序命中（occurrence 必须**在范围之内**才算命中；
  //    越界时不能夹到最后一处 —— 那等于跳到另一个位置，跳错比不跳更糟）
  if (Number.isFinite(occurrence) && occurrence >= 0 && occurrence < ranges.length) {
    return ranges[occurrence].start;
  }
  // ② 兜底：全文只有唯一一处
  if (ranges.length === 1) return ranges[0].start;
  // ③ 次序越界且有多处 → 不猜，交给调用方提示
  return null;
}
