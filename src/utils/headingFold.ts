/**
 * v0.15.0 需求2（R2 阅读区标题折叠）：**纯逻辑层**。
 *
 * ## 范围边界（设计冻结稿 §2）
 * 折叠只影响**阅读渲染层**（阅读态 ProseMirror / 编辑模式右侧 iframe 预览），
 * 不折叠源码 textarea、不折叠编辑 WYSIWYG，**不改 doc、不写 Markdown、不产生撤销历史**。
 * 本模块只做「顶层块描述数组 → 标题列表 / 隐藏块下标」的算术，不依赖 PM、DOM、
 * React，可在 Node 环境精确单测；DOM 与 PM 接线在
 * `src/components/editor/readingFold.ts`。
 *
 * ## 为什么输入是「顶层块描述数组」而不是 markdown 文本
 * 两个渲染面的**顶层块口径不同**：
 * - iframe 侧：markdown-it 顶层 token（`topLevelBlockStartLines` 同一过滤口径）；
 * - 阅读 PM 侧：doc 子节点（parser 会把空行还原成空段落，还多一个末尾垫段落）。
 * 因此块下标**不能跨面共享**，折叠状态只能用**标题 id**（`headingId`）表达：
 * 每个面拿自己的块数组算出 `HeadingInfo.blockIndex`，再由 id 决定折叠/隐藏。
 *
 * 本模块提供两条把「各自结构」转成块描述的适配器（都是结构化、无运行时依赖）：
 * `blocksFromTokens`（markdown-it token 形状）与 `collectDocChildBlocks`
 * （PM doc 形状：`{ childCount, child(i) }`）。
 *
 * ## 标题 id 口径
 * 与 `core/markdown/heading-anchor.ts` / `core/plugins/heading-id-sync.ts` 完全一致
 * （同一 `slugify` + 同名去重：首次无后缀，第 2 次 `-1`…）。调用方传入的
 * `headingId`（parser 已写入 heading 节点 attr / markdown-it 已写 token.attr）优先；
 * 缺失时用 `h<level>:<blockIndex>:<slug>` 兜底（blockIndex 已含唯一性）。
 *
 * ## 折叠真值口径
 * 折叠 H_n → 隐藏其后直到下一个 **level ≤ n** 的标题之前的全部顶层块；文末收尾。
 * 嵌套折叠取**并集**；被外层折叠隐藏的标题自身的折叠态**不生效**（否则会收窄外层
 * 区间）——与 v0.13.0 大纲折叠 `computeOutlineVisibility` 的折叠栈口径一致。
 */

import { slugify } from "../core/markdown/heading-anchor";

// ─── 类型 ────────────────────────────────────────────────────

/**
 * 一个顶层块的最小描述。
 *
 * `type` 用「去掉 `_open` 后缀」的 markdown-it token 类型名（`heading` /
 * `paragraph` / `fence` / `blockquote` / `table` / `bullet_list` …）或 PM 节点名。
 * 除了 `heading` 之外**都不算标题**：代码围栏内的 `#`、表格单元格里的 `#`、
 * 块引用内部的标题都因此天然被排除（它们不在顶层）。
 */
export interface FoldBlock {
  /** 顶层块类型（`heading` 表示标题） */
  type: string;
  /** 标题级别 1~6（仅 heading 有意义） */
  level?: number;
  /** 纯文本（标题用于兜底 slug） */
  text: string;
  /** 稳定标题 id（parser / heading-anchor 已算好并去重） */
  headingId?: string;
  /** 源码起始行（0 基，可缺省） */
  line?: number;
}

/** 收集到的标题（块下标属于**本面自己**的口径） */
export interface HeadingInfo {
  /** 稳定 id：折叠状态的唯一键 */
  id: string;
  /** 1~6 */
  level: number;
  /** 该标题在**本面**顶层块数组中的下标 */
  blockIndex: number;
  /** 源码起始行（0 基；未知为 -1） */
  line: number;
}

/**
 * 折叠状态（按文档保存）。
 *
 * 设计稿 §2.1：默认全展开；状态按 `docKey + headingId` 会话内保存（重启不恢复）。
 * 本层只存 `docKey`（调用方用来做文档归属闸门）与折叠 id 集合，**不持久化**。
 */
export interface FoldState {
  docKey: string;
  collapsed: Set<string>;
}

/** markdown-it token 的结构化形状（只声明用到的字段，避免依赖 markdown-it 类型） */
export interface MdTokenLike {
  type: string;
  tag?: string;
  level?: number;
  nesting?: number;
  map?: [number, number] | null;
  attrs?: Array<[string, string]> | null;
  children?: readonly MdTokenLike[] | null;
  content?: string;
}

/** PM doc 子节点的结构化形状（不 import prosemirror-model） */
export interface FoldNodeLike {
  type: { name: string };
  attrs?: Record<string, unknown> | null;
  textContent?: string;
}

/** 有 `childCount`/`child(i)` 的容器（PM 的 `doc`） */
export interface FoldDocLike {
  childCount: number;
  child(index: number): FoldNodeLike;
}

// ─── 状态构造 ────────────────────────────────────────────────

/** 建一个空白折叠状态（全展开） */
export function createFoldState(docKey: string, collapsed: Iterable<string> = []): FoldState {
  return { docKey, collapsed: new Set(collapsed) };
}

// ─── 标题收集 ────────────────────────────────────────────────

/** 级别钳到 1~6；非法值按 1（与 schema 默认值一致） */
function clampLevel(level: unknown): number {
  const n = Math.round(Number(level));
  return Number.isFinite(n) && n >= 1 && n <= 6 ? n : 1;
}

/**
 * 标题 id 兜底生成（调用方没给 `headingId` 时）。
 *
 * `blockIndex` 参与 id，因此同一文档内天然唯一，不会与 parser 的 slug 去重冲突。
 */
export function fallbackHeadingId(level: number, blockIndex: number, text: string): string {
  const slug = slugify(String(text ?? "").replace(/\s+/g, " ").trim()) || "heading";
  return `h${clampLevel(level)}:${blockIndex}:${slug}`;
}

/**
 * 从顶层块描述数组收集标题。
 *
 * 只认 `type === "heading"` 的块：**代码围栏/缩进代码块内的 `#`、表格单元格里的
 * `#`、块引用/列表项内部的标题都不是顶层 heading 块**，因此不会进入返回值。
 *
 * @param blocks 顶层块描述（按文档顺序）
 * @returns 标题列表（按文档顺序；`blockIndex` 即入参下标）
 */
export function collectHeadings(blocks: readonly FoldBlock[]): HeadingInfo[] {
  const out: HeadingInfo[] = [];
  const usedIds = new Map<string, number>();

  blocks.forEach((block, blockIndex) => {
    if (!block || block.type !== "heading") return;
    const level = clampLevel(block.level);

    let id = String(block.headingId ?? "").trim();
    if (!id) {
      out.push({
        id: fallbackHeadingId(level, blockIndex, block.text),
        level,
        blockIndex,
        line: typeof block.line === "number" && Number.isFinite(block.line) ? block.line : -1,
      });
      return;
    }

    // 兜底去重：正常调用方（heading-anchor / heading-id-sync）给的 id 已唯一，
    // 这里只防御上层拼装出的重复 id（两个渲染面会走同一条规则 → 结果一致）。
    const used = usedIds.get(id) ?? 0;
    usedIds.set(id, used + 1);
    if (used > 0) id = `${id}-${used}`;

    out.push({
      id,
      level,
      blockIndex,
      line: typeof block.line === "number" && Number.isFinite(block.line) ? block.line : -1,
    });
  });

  return out;
}

// ─── 块描述适配器 ────────────────────────────────────────────

/** `heading_open` → `heading` / `table_open` → `table` / 自闭合 token 原样 */
function stripOpenSuffix(type: string): string {
  return String(type ?? "").replace(/_open$/, "");
}

function readAttr(token: MdTokenLike, name: string): string {
  const attrs = token.attrs;
  if (!Array.isArray(attrs)) return "";
  for (const pair of attrs) {
    if (Array.isArray(pair) && pair[0] === name) return String(pair[1] ?? "");
  }
  return "";
}

/** 标题 inline token 的纯文本（保留 code_inline 内容，软/硬换行转空格） */
function inlineText(token: MdTokenLike | undefined): string {
  if (!token) return "";
  const children = token.children;
  if (!Array.isArray(children)) return String(token.content ?? "");
  let text = "";
  for (const child of children) {
    if (!child) continue;
    if (child.type === "text" || child.type === "code_inline") text += String(child.content ?? "");
    else if (child.type === "softbreak" || child.type === "hardbreak") text += " ";
  }
  return text;
}

/**
 * markdown-it token 流 → 顶层块描述数组。
 *
 * **过滤口径必须与 `core/renderPipeline.ts` 的 `topLevelBlockStartLines` 严格一致**
 * （`level === 0` + 有 `map` + `nesting ∈ {0, 1}`），否则块下标与源码行号表错位，
 * 折叠隐藏的块和 iframe 里的元素会对不上。两处若将来要改，必须同改。
 *
 * 因为 markdown-it 已把代码围栏 / 缩进代码 / 表格 / 块引用各自解析成**一个**顶层
 * token（内容里的 `#` 只出现在 text/children 里），本函数天然满足「围栏内 `#`
 * 不是标题」「表格内 `#` 不是标题」「块引用内标题不算顶层标题」三条口径。
 */
export function blocksFromTokens(tokens: readonly MdTokenLike[]): FoldBlock[] {
  const blocks: FoldBlock[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    const level = token.level ?? 0;
    if (level !== 0) continue;
    const nesting = token.nesting ?? 0;
    if (nesting !== 0 && nesting !== 1) continue;
    if (!token.map || token.map.length < 1) continue;
    const start = token.map[0];
    if (typeof start !== "number" || !Number.isFinite(start)) continue;

    const type = stripOpenSuffix(token.type);
    if (!type) continue;

    const block: FoldBlock = { type, text: "", line: start };
    if (type === "heading") {
      const tag = String(token.tag ?? "");
      block.level = /^h[1-6]$/i.test(tag) ? Number(tag.slice(1)) : 1;
      const headingId = readAttr(token, "id");
      if (headingId) block.headingId = headingId;
      const next = tokens[i + 1];
      if (next && next.type === "inline") block.text = inlineText(next);
    }
    blocks.push(block);
  }

  return blocks;
}

/**
 * PM doc 子节点 → 顶层块描述数组。
 *
 * 只读 `type.name` / `attrs.level` / `attrs.id`，不接触 PM API，
 * 因此可用 `{ childCount, child(i) }` 形状的假对象单测。
 *
 * ⚠️ **非标题块不读 `textContent`**：本函数在 `props.decorations` 里每次事务
 * 都会跑一遍，而 `Node.textContent` 是 O(节点内文本长度) 的字符串拼接 +
 * 替换空白 —— 长文档逐块读会让**每次按键**都退化成 O(全文)** 扫描。
 * 折叠逻辑只需要标题的 id/level（非标题块的文本完全用不到），故只对标题取文本
 * （且仅在 id 缺失、需要 fallback slug 时才有意义；这里仍取，成本 O(标题数)）。
 */
export function collectDocChildBlocks(doc: FoldDocLike): FoldBlock[] {
  const blocks: FoldBlock[] = [];
  const rawCount = Number(doc?.childCount);
  const count = Number.isFinite(rawCount) ? Math.max(0, Math.floor(rawCount)) : 0;

  for (let i = 0; i < count; i++) {
    const node = doc.child(i);
    const type = String(node?.type?.name ?? "");
    const block: FoldBlock = { type, text: "" };
    if (type !== "heading") {
      blocks.push(block);
      continue;
    }
    const attrs = (node?.attrs ?? {}) as Record<string, unknown>;
    const level = Number(attrs.level);
    const headingId = typeof attrs.id === "string" ? attrs.id : "";
    if (Number.isFinite(level)) block.level = level;
    if (headingId) block.headingId = headingId;
    // 只在**确实需要 fallback id** 时才读题面文本（正常路径 id 已由 parser 写好）
    if (!headingId) block.text = String(node?.textContent ?? "");
    blocks.push(block);
  }

  return blocks;
}

// ─── 折叠算术 ────────────────────────────────────────────────

function headingMapByBlock(headings: readonly HeadingInfo[]): Map<number, HeadingInfo> {
  const map = new Map<number, HeadingInfo>();
  for (const heading of headings) {
    if (!heading) continue;
    if (!Number.isFinite(heading.blockIndex) || heading.blockIndex < 0) continue;
    if (map.has(heading.blockIndex)) continue;
    map.set(heading.blockIndex, heading);
  }
  return map;
}

/**
 * 计算当前折叠状态下**需要隐藏**的顶层块下标集合。
 *
 * 规则（设计稿 §2.1）：折叠 H_n → 隐藏其后直到下一个 **level ≤ n** 的标题之前的
 * 全部顶层块，文末收尾；多个折叠取并集（嵌套折叠自然成立）。
 *
 * 实现用「生效中的折叠级别栈」（与大纲折叠 `computeOutlineVisibility` 同一套）：
 * - 遇到标题：先弹掉级别不小（`<=`）于自己的栈顶，此时栈非空说明它在外层折叠里
 *   → 隐藏；**可见且被折叠**的标题才压栈（被隐藏的标题的折叠态不生效）。
 * - 非标题块：栈非空即隐藏。
 *
 * @param headings 标题列表（按文档顺序，`collectHeadings` 的输出）
 * @param totalBlocks 本面顶层块总数
 * @param collapsed 被折叠标题的 id 集合
 * @returns 隐藏块下标集合（空集合=全展开）
 */
export function hiddenBlockIndexes(
  headings: readonly HeadingInfo[],
  totalBlocks: number,
  collapsed: ReadonlySet<string>,
): Set<number> {
  const hidden = new Set<number>();
  const rawTotal = Number(totalBlocks);
  const total = Number.isFinite(rawTotal) ? Math.max(0, Math.floor(rawTotal)) : 0;
  if (total === 0) return hidden;

  const byBlock = headingMapByBlock(headings);
  /** 生效中的折叠级别栈（自浅至深） */
  const stack: number[] = [];

  for (let blockIndex = 0; blockIndex < total; blockIndex++) {
    const heading = byBlock.get(blockIndex);
    if (heading) {
      while (stack.length > 0 && heading.level <= stack[stack.length - 1]) stack.pop();
      if (stack.length > 0) {
        hidden.add(blockIndex);
        continue;
      }
      if (collapsed.has(heading.id)) stack.push(heading.level);
      continue;
    }
    if (stack.length > 0) hidden.add(blockIndex);
  }

  return hidden;
}

/**
 * 哪些标题**可折叠**（真能藏起至少一个块）。
 *
 * 判据：本标题与「下一个 level ≤ 本级别的标题」之间（或文末）至少还有一个块。
 * 无子内容的标题不显示折叠三角（与大纲面板 `canCollapse` 的用户预期一致）。
 *
 * 复杂度 O(标题数 × 6)：从后往前维护「每个级别最近一次出现的位置」，
 * 再对 `1..level` 取最近者。为什么在意：本函数在 `props.decorations` 里
 * **每次事务**都跑，标题密集的文档若用 O(n²) 双循环，长文输入会明显卡顿。
 */
export function foldableHeadingIds(
  headings: readonly HeadingInfo[],
  totalBlocks: number,
): Set<string> {
  const out = new Set<string>();
  const rawTotal = Number(totalBlocks);
  const total = Number.isFinite(rawTotal) ? Math.max(0, Math.floor(rawTotal)) : 0;
  const list = headings.slice();

  /** lastAtLevel[l] = 已扫描（更靠后）部分中级别为 l 的最近标题 blockIndex（无则 -1） */
  const lastAtLevel = [-1, -1, -1, -1, -1, -1, -1];

  for (let i = list.length - 1; i >= 0; i--) {
    const heading = list[i];
    if (!heading) continue;
    const level = Math.min(6, Math.max(1, Math.round(Number(heading.level) || 1)));
    // 「下一个 level ≤ 本级别」= 级别 1..level 中最近的那个
    let boundary = total;
    for (let l = 1; l <= level; l++) {
      const candidate = lastAtLevel[l];
      if (candidate >= 0 && candidate < boundary) boundary = candidate;
    }
    lastAtLevel[level] = heading.blockIndex;
    if (boundary > heading.blockIndex + 1) out.add(heading.id);
  }

  return out;
}

// ─── 状态变更（全部返回新对象，不改入参）────────────────────

/** 切换单个标题的折叠态；状态未变化时返回**原对象**（便于 React 浅比较） */
export function toggleFold(state: FoldState, id: string): FoldState {
  const key = String(id ?? "");
  if (!key) return state;
  const next = new Set(state.collapsed);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return { docKey: state.docKey, collapsed: next };
}

/** 全部展开（清空折叠集合） */
export function expandAll(state: FoldState): FoldState {
  if (state.collapsed.size === 0) return state;
  return { docKey: state.docKey, collapsed: new Set() };
}

/** 全部折叠（折叠所有**可折叠**标题；无子内容的标题不加入，避免空状态） */
export function collapseAll(
  state: FoldState,
  headings: readonly HeadingInfo[],
  totalBlocks: number,
): FoldState {
  const targets = foldableHeadingIds(headings, totalBlocks);
  if (targets.size === 0) return state;
  return { docKey: state.docKey, collapsed: new Set(targets) };
}

/**
 * 展开目标块的**全部祖先标题**（搜索命中 / TOC / 锚点跳转前调用）。
 *
 * 祖先 = 折叠区间覆盖目标块的标题（即目标块之前、级别逐级收紧的标题链）。
 * 目标块自身若是标题，**不**改变它自己的折叠态（折叠的标题行本身可见）。
 *
 * @param targetBlockIndex 目标块在**本面**顶层块数组中的下标
 */
export function expandAncestors(
  state: FoldState,
  headings: readonly HeadingInfo[],
  targetBlockIndex: number,
): FoldState {
  if (state.collapsed.size === 0) return state;
  const target = Number(targetBlockIndex);
  if (!Number.isFinite(target)) return state;

  /** 祖先链（自浅至深） */
  const stack: HeadingInfo[] = [];
  for (const heading of headings) {
    if (!heading) continue;
    if (heading.blockIndex >= target) break;
    while (stack.length > 0 && heading.level <= stack[stack.length - 1].level) stack.pop();
    stack.push(heading);
  }

  const remove = new Set<string>();
  for (const heading of stack) {
    if (state.collapsed.has(heading.id)) remove.add(heading.id);
  }
  if (remove.size === 0) return state;

  const collapsed = new Set(state.collapsed);
  for (const id of remove) collapsed.delete(id);
  return { docKey: state.docKey, collapsed };
}

/** `expandAncestors` 的按标题 id 版本（TOC / 锚点链接给的是 headingId） */
export function expandAncestorsForHeadingId(
  state: FoldState,
  headings: readonly HeadingInfo[],
  headingId: string,
): FoldState {
  const heading = headings.find((item) => item && item.id === headingId);
  if (!heading) return state;
  return expandAncestors(state, headings, heading.blockIndex);
}

/** 按 id 找标题（找不到返回 null） */
export function headingById(
  headings: readonly HeadingInfo[],
  headingId: string,
): HeadingInfo | null {
  return headings.find((item) => item && item.id === headingId) ?? null;
}

/**
 * 文档修改后复算折叠状态：**按 headingId 保留有效折叠，标题删除则清理**。
 *
 * 这正是不用块下标做键的原因：编辑会让块下标整体位移，而 id 只在标题文本
 * 真正变化时才变（`heading-id-sync` 重算 slug）。文本改了的标题 → 旧 id 不存在
 * → 自动丢弃（用户看到该节回到展开，符合"折叠状态按 id 复算"的口径）。
 */
export function reconcileFoldState(
  state: FoldState,
  headings: readonly HeadingInfo[],
): FoldState {
  if (state.collapsed.size === 0) return state;
  const live = new Set(headings.map((heading) => heading.id));
  let changed = false;
  const collapsed = new Set<string>();
  for (const id of state.collapsed) {
    if (live.has(id)) collapsed.add(id);
    else changed = true;
  }
  if (!changed) return state;
  return { docKey: state.docKey, collapsed };
}

/** 目标块是否被当前折叠状态隐藏（滚动映射 / 搜索跳转前的判定） */
export function isBlockHidden(
  blockIndex: number,
  headings: readonly HeadingInfo[],
  totalBlocks: number,
  collapsed: ReadonlySet<string>,
): boolean {
  return hiddenBlockIndexes(headings, totalBlocks, collapsed).has(blockIndex);
}

/** 目标块被隐藏时，最近可见的祖先标题（滚动映射的落点，设计稿 §2.4） */
export function nearestVisibleAncestorHeading(
  blockIndex: number,
  headings: readonly HeadingInfo[],
  totalBlocks: number,
  collapsed: ReadonlySet<string>,
): HeadingInfo | null {
  const hidden = hiddenBlockIndexes(headings, totalBlocks, collapsed);
  if (!hidden.has(blockIndex)) return null;
  /** 祖先链（自浅至深） */
  const stack: HeadingInfo[] = [];
  for (const heading of headings) {
    if (!heading) continue;
    if (heading.blockIndex >= blockIndex) break;
    while (stack.length > 0 && heading.level <= stack[stack.length - 1].level) stack.pop();
    stack.push(heading);
  }
  // 自深向浅找第一个"自身可见"的祖先标题
  for (let i = stack.length - 1; i >= 0; i--) {
    if (!hidden.has(stack[i].blockIndex)) return stack[i];
  }
  return null;
}
