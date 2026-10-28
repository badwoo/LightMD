/**
 * documentHistory —— v0.15.0 需求「跨模式撤销统一」的**纯逻辑时间线**（WP-B1 阶段 1）
 *
 * ## 为什么需要它
 *
 * 现状有**三条互不相干**的撤销栈：
 *
 * | 栈 | 位置 | 现状问题 |
 * |---|---|---|
 * | 源码 textarea diff 栈 | `EditorContainer.tsx:890-922`（`pushUndoEntry`，MAX_HISTORY=30） | 只覆盖源码模式；切到阅读模式后按键归 PM |
 * | ProseMirror history 插件栈 | `prosemirror-history`（`core/editor.ts` 的 state） | 只覆盖阅读模式；换文档 `resetHistory` 归零 |
 * | 跨文件替换记录 | `docHistoryStore.ts`（`crossFileUndo/Redo`） | 只有一条 before→after，且不参与统一时间线 |
 *
 * 用户要求的是「每个文档**一条**逻辑时间线」：`src-A → pm-B → src-C → undo×3 → redo×3`
 * 必须精确往返，撤销可穿过任意次模式切换，任何模式的新编辑立即截断 redo 分支。
 * 本模块就是这条时间线的唯一数据源：**纯字符串/纯数据，无 React、无 DOM、无 ProseMirror**，
 * 因此可以被 Node 里的单测直接驱动（proof 门禁，见 `documentHistory.test.ts`）。
 *
 * ## 两阶段存储（外部契约不变）
 *
 * - **本阶段（proof）**：每个条目存 `before/after` **全文快照**。语义最简单、最容易证明正确；
 *   内存上限用 `MAX_STEPS=200` + `MAX_CHARS=32MB`（每文档）兜住。
 * - **正式阶段（后续）**：内部改存 `{start, deleted, inserted}` diff 段 + 每 20 步一个全文检查点。
 *   本文件的对外 API / `HistoryEntry` 形状不变，只换内部表示 —— 这是设计文档 §1.2 冻结的契约。
 *
 * ## 两条不可妥协的纪律
 *
 * 1. **绝不存 base64 mask 后的文本**。源码模式的 textarea 显示层会把超长 data URL 换成
 *    `image-1.png` 短标记（`utils/base64ImageMask.ts`），但 journal 必须存**真实内容**：
 *    mask/unmask 只允许发生在编辑展示层进出（调用方负责），否则撤销一次就会把图片数据
 *    永久替换成短标记（写盘即损坏文件）。
 * 2. **绝不覆盖用户编辑**。`commit` 要求 `before` 与时间线已知的宿主文本**逐字节一致**，
 *    不一致直接拒绝（返回 null）而不是「修一下接着用」：宁可少记一步，也不能把撤销应用到
 *    错误的偏移/文本上（与 `docHistoryStore.loadDocHistory` 的 byte-identical 纪律同源）。
 */

// ─────────────────────────────────────────────────────────────
// 类型（设计文档 §1.2 冻结）
// ─────────────────────────────────────────────────────────────

/** 条目的来源：决定 undo/redo 时的安全护栏与提示文案 */
export type HistoryOrigin = "source" | "pm" | "cross-file" | "ai" | "replace" | "external";

/** 源码模式 textarea 的选区/滚动（撤销后恢复现场用） */
export interface SourceSelection {
  start: number;
  /** 与 start 相等表示纯光标（无选区） */
  end: number;
  scrollTop?: number;
}

/** 内容锚点（与设计文档 §3 的 contentScrollMap 同一类型，阅读侧恢复用） */
export interface ContentAnchor {
  /** 顶层块下标（与源码 topLevelBlockStartLines 同源） */
  blockIndex: number;
  /** 稳定标题 id（`heading-id-sync.ts` 生成；非标题块为 undefined） */
  headingId?: string;
  /** 块内比例 0..1 */
  ratioWithinBlock: number;
  /** 辅助校验用的源码行号 */
  sourceLine?: number;
}

/** 时间线上的一个条目：一次「逻辑编辑」的前后全文 + 恢复现场 */
export interface HistoryEntry {
  /** 全局单调递增 id（不随淘汰复用；`drop` 按 id 定点删除用） */
  id: number;
  /** 编辑前全文（undo 的目标） */
  before: string;
  /** 编辑后全文（redo 的目标 + 一致性格栏的基准） */
  after: string;
  origin: HistoryOrigin;
  /**
   * 成组标识：IME composition / 自动配对 / 一次粘贴 / 连续 typing 归并共用同一 groupId。
   * 同 groupId 且相邻的条目在 `commit` 里会被**合并成一步**（见设计文档 §1.3 归并规则）。
   */
  groupId?: string;
  beforeSelection?: SourceSelection;
  afterSelection?: SourceSelection;
  beforeAnchor?: ContentAnchor;
  afterAnchor?: ContentAnchor;
}

/** 一个文档的完整时间线（测试/诊断快照形状；设计文档冻结） */
export interface DocumentHistory {
  docKey: string;
  /** 按时间升序 */
  entries: HistoryEntry[];
  /** `entries[0..cursor)` 已应用；0 = 全部已撤销 */
  cursor: number;
}

/**
 * `commit` 的输入：`HistoryEntry` 去掉 id。
 *
 * 额外允许**省略 `before`**（缺省取时间线已知的宿主文本）—— 这覆盖两种等价的调用习惯：
 * - 设计文档 §1.2 的 `commit(entry)`（adapter 自己算好 before/after）；
 * - 需求卡里的 `commit(source, "ab")`（只给 after，before 由时间线当前文本推出）。
 * 显式给了 `before` 就必须与已知宿主文本逐字节一致，否则拒绝（见文件头纪律 2）。
 */
export type CommitInput = Omit<HistoryEntry, "id" | "before"> & { before?: string };

/**
 * 设计文档 §1.2 冻结的 API 形状。
 *
 * 注意：实现里的 `commit/undo/redo/canUndo/canRedo/currentText/peek*` 都多了一个**可选**
 * `docKey` 参数（缺省 = 最近一次 `begin` 的活跃文档），因此本实现对象可直接赋给这个接口 ——
 * TS 里「参数更宽的实现」对「参数更窄的接口」是兼容的。加可选参数的唯一原因是跨文件替换：
 * 它要往**未激活**目标文档的时间线里记一条 `origin="cross-file"`，此刻活跃文档不是它。
 */
export interface DocumentHistoryApi {
  /** 打开文档 / 外部重载：`content` 为**真实内容**（unmask 后） */
  begin(docKey: string, content: string): void;
  commit(entry: Omit<HistoryEntry, "id">): HistoryEntry | null;
  undo(): HistoryEntry | null;
  redo(): HistoryEntry | null;
  canUndo(): boolean;
  canRedo(): boolean;
  forget(docKey: string): void;
  snapshotForTest(docKey: string): DocumentHistory | null;
}

/**
 * 供 coordinator 使用的扩展 API（阶段 2）。比冻结接口多的能力都是**只读 / 定点删除**，
 * 不改变上面 8 个方法的语义：
 *
 * - `currentText`：时间线已知的宿主文本（adapter 组 `before` 的基准，避免再读一次宿主）；
 * - `peekUndo/peekRedo`：**先校验再消费**。设计文档要求「跨文件条目护栏不通过就丢弃且不应用」，
 *   若先 `undo()` 再校验，失败时游标已经动了、时间线也脏了；
 * - `drop`：丢弃指定条目（设计文档 §1.4 步骤 2 的「丢弃该条目」动作）。
 */
export interface DocumentHistoryApiEx extends DocumentHistoryApi {
  commit(entry: CommitInput, docKey?: string): HistoryEntry | null;
  undo(docKey?: string): HistoryEntry | null;
  redo(docKey?: string): HistoryEntry | null;
  canUndo(docKey?: string): boolean;
  canRedo(docKey?: string): boolean;
  currentText(docKey?: string): string | null;
  peekUndo(docKey?: string): HistoryEntry | null;
  peekRedo(docKey?: string): HistoryEntry | null;
  drop(docKey: string, entryId: number): boolean;
  rebaseText(docKey: string, text: string, opts?: { force?: boolean }): boolean;
}

// ─────────────────────────────────────────────────────────────
// 预算常量（设计文档 §1.2 冻结）
// ─────────────────────────────────────────────────────────────

/** 每文档最大步数（条目数） */
export const MAX_STEPS = 200;

/** 每文档最大字符预算：32MB（before/after 全文 + 检查点全文一起算） */
export const MAX_CHARS = 32 * 1024 * 1024;

/**
 * 多文档 LRU 上限。与 `docHistoryStore.MAX_DOCS=40` 对齐，便于迁移期两边口径一致。
 * 超限丢**最久未使用**的整份历史（不是丢条目）。
 */
export const MAX_DOCS = 40;

// ─────────────────────────────────────────────────────────────
// 内部状态
// ─────────────────────────────────────────────────────────────

/**
 * 一个文档的存储单元。
 *
 * - `knownText`：**时间线认为宿主现在持有的文本** —— 唯一的一致性格栏基准。
 *   更新点只有三个：`begin`、`commit` 的 after、`undo/redo` 的 before/after。
 *   它独立于条目链存在，因此「护栏失败被 `drop` 掉一条」之后仍能正确表示宿主文本，
 *   下一次 `commit` 不会因为链断掉而误判失配。
 * - `baseText`：**检查点**。游标为 0 时的文档文本；预算淘汰最旧条目时把它前移到
 *   被淘汰条目的 `after`。它保证淘汰之后「仍能 undo 到一个确切的内容」而不是把历史清空。
 */
interface DocStore {
  docKey: string;
  entries: HistoryEntry[];
  cursor: number;
  knownText: string;
  baseText: string;
  /** `entries` 里 before+after 的字符数总和（增量维护，O(1) 预算判定） */
  entryChars: number;
}

/** docKey → 存储单元。Map 插入序 = LRU 序（访问时 delete+set 提权） */
const docs = new Map<string, DocStore>();

/** 最近一次 `begin` 的文档键；`commit/undo/...` 省略 docKey 时作用于它 */
let activeKey: string | null = null;

/** 全局条目 id 计数器（跨文档单调递增，便于日志排查） */
let nextEntryId = 1;

/** 可配置预算（测试用 `__configureDocumentHistoryForTest` 临时调小，避免造 32MB 字符串） */
let stepsLimit = MAX_STEPS;
let charsLimit = MAX_CHARS;
let docsLimit = MAX_DOCS;

// ─────────────────────────────────────────────────────────────
// 内部工具
// ─────────────────────────────────────────────────────────────

/** LRU 提权：已存在则移到最新 */
function touch(docKey: string): void {
  const doc = docs.get(docKey);
  if (!doc) return;
  docs.delete(docKey);
  docs.set(docKey, doc);
}

/** 多文档 LRU 淘汰：超限丢最久未使用（Map 迭代序最前）的整份历史 */
function trimDocs(): void {
  while (docs.size > docsLimit) {
    const oldest = docs.keys().next().value;
    if (oldest === undefined) break;
    docs.delete(oldest);
    if (activeKey === oldest) activeKey = null;
  }
}

/** 当前占用字符数：条目全文 + 检查点全文 */
function usageOf(doc: DocStore): number {
  return doc.entryChars + doc.baseText.length;
}

/** 取存储单元；不存在时按「宿主文本 = initialText」新建一条空时间线 */
function ensureDoc(docKey: string, initialText: string): DocStore {
  const existing = docs.get(docKey);
  if (existing) return existing;
  const doc: DocStore = {
    docKey,
    entries: [],
    cursor: 0,
    knownText: initialText,
    baseText: initialText,
    entryChars: 0,
  };
  docs.set(docKey, doc);
  trimDocs();
  return doc;
}

/**
 * 丢弃游标之后的 redo 分支（新编辑截断 redo）。
 * @returns 是否真的丢弃了分支（true = 编辑前处于"已撤销若干步"的状态）
 */
function truncateRedo(doc: DocStore): boolean {
  if (doc.cursor >= doc.entries.length) return false;
  for (let i = doc.cursor; i < doc.entries.length; i++) {
    const e = doc.entries[i];
    doc.entryChars -= e.before.length + e.after.length;
  }
  doc.entries.length = doc.cursor;
  return true;
}

/**
 * 淘汰最旧一条并把检查点前移到它的 `after`。
 *
 * 前提（由调用方保证）：`cursor === entries.length`，故被淘汰的条目一定是**已应用**过的。
 * 淘汰后「derived 文本 = baseText」的一致性由 `knownText` 兜住（它不动）。
 */
function evictOldest(doc: DocStore): void {
  if (doc.cursor !== doc.entries.length) return;
  const dropped = doc.entries.shift();
  if (!dropped) return;
  doc.entryChars -= dropped.before.length + dropped.after.length;
  doc.baseText = dropped.after;
  doc.cursor = doc.entries.length;
}

/** 预算收敛：先按步数丢，再按字符预算丢；**至少保留 1 条**（否则一步都撤不了） */
function trimBudget(doc: DocStore): void {
  while (doc.entries.length > stepsLimit) evictOldest(doc);
  while (usageOf(doc) > charsLimit && doc.entries.length > 1) evictOldest(doc);
}

/** 解析目标文档键（显式参数优先，否则活跃文档） */
function requireActiveOr(docKey: string | undefined): string | null {
  const key = docKey ?? activeKey;
  return key ?? null;
}

// ─────────────────────────────────────────────────────────────
// 公开 API
// ─────────────────────────────────────────────────────────────

/**
 * 打开文档 / 外部重载。
 *
 * 语义：
 * - 该 docKey **已有**时间线，且其已知宿主文本与 `content` 逐字节一致 → 保留历史（切标签回来
 *   仍可继续撤销），只提升 LRU 活跃度；
 * - 否则**重置**为一条以 `content` 为检查点的空时间线（外部重载 / 保存后重开 / 内容已被
 *   第三方改动时，旧历史的位置语义已失效，必须丢弃 —— 与 docHistoryStore 同一纪律）。
 *
 * ⚠️ `content` 必须是**真实内容**（源码模式 unmask 之后），不得传 mask 后的展示文本。
 */
export function begin(docKey: string, content: string): void {
  if (!docKey) return;
  const existing = docs.get(docKey);
  if (existing && existing.knownText === content) {
    touch(docKey);
    activeKey = docKey;
    return;
  }
  docs.delete(docKey);
  const doc: DocStore = {
    docKey,
    entries: [],
    cursor: 0,
    knownText: content,
    baseText: content,
    entryChars: 0,
  };
  docs.set(docKey, doc);
  activeKey = docKey;
  trimDocs();
}

/**
 * 记录一次逻辑编辑。
 *
 * @param raw    `before`（可选，缺省取已知宿主文本）/ `after` / origin / groupId / 选区锚点
 * @param docKey 目标文档（缺省 = 活跃文档）。跨文件替换往未激活文档记条目时显式传。
 * @returns 入库（或合并进上一条）后的条目；**无变化 / 文本失配时返回 null**
 *
 * 文本失配（`before !== knownText`）的处置是**拒绝**而不是覆盖：调用方随后应
 * `begin(docKey, hostText)` 重新同步（阶段 2 的 coordinator 会这么做）。这保证任何情况下
 * 都不会把一条基于旧文本的改动接在新文本后面（撤销会错位、甚至覆盖用户编辑）。
 */
export function commit(raw: CommitInput, docKey?: string): HistoryEntry | null {
  const key = requireActiveOr(docKey);
  if (!key) return null;
  if (typeof raw.after !== "string") return null;

  const doc = ensureDoc(key, raw.before ?? "");
  touch(key);

  // 显式给了 before 就逐字节校验；没给则用已知宿主文本推出（两者等价）
  const before = raw.before ?? doc.knownText;
  if (before === raw.after) return null; // 无变化
  if (before !== doc.knownText) return null; // 失配：拒绝，等 begin 重同步

  // 新编辑立即截断 redo 分支（无论是否会被合并）。
  // `truncated=true` 表示编辑前处于"已撤销若干步"状态：此时**禁止**与栈顶合并 ——
  // 用户的心理模型是"撤销后重新输入 = 新的一步"，合并会让这次新输入跟撤销掉的旧输入
  // 混在同一条里，redo 时把两者一起吐出来。
  const truncated = truncateRedo(doc);

  // ── 成组合并：同 groupId + 同 origin + 相邻，合并为一步（IME/粘贴/连续 typing）──
  const last = doc.entries[doc.entries.length - 1];
  if (
    !truncated &&
    last &&
    raw.groupId &&
    last.groupId === raw.groupId &&
    last.origin === raw.origin &&
    last.after === before
  ) {
    doc.entryChars += raw.after.length - last.after.length;
    last.after = raw.after;
    if (raw.afterSelection) last.afterSelection = raw.afterSelection;
    if (raw.afterAnchor) last.afterAnchor = raw.afterAnchor;
    doc.cursor = doc.entries.length;
    doc.knownText = raw.after;
    trimBudget(doc);
    return last;
  }

  const entry: HistoryEntry = {
    ...raw,
    before,
    id: nextEntryId++,
  };
  doc.entries.push(entry);
  doc.cursor = doc.entries.length;
  doc.knownText = entry.after;
  doc.entryChars += entry.before.length + entry.after.length;
  trimBudget(doc);
  return entry;
}

/**
 * 撤销一步：游标后移并返回**被撤销的条目**。
 *
 * 调用方应把 `entry.before` 写回宿主（源码写 textarea / PM 做 bridge 事务）。
 * 返回 null = 已撤到底（此时调用方提示边界，且**不得**做任何写回）。
 */
export function undo(docKey?: string): HistoryEntry | null {
  const key = requireActiveOr(docKey);
  if (!key) return null;
  const doc = docs.get(key);
  if (!doc || doc.cursor <= 0) return null;
  touch(key);
  doc.cursor -= 1;
  const entry = doc.entries[doc.cursor];
  doc.knownText = entry.before;
  return entry;
}

/**
 * 恢复一步：返回**被恢复的条目**，调用方把 `entry.after` 写回宿主。
 * 返回 null = 没有可恢复分支（新编辑已截断 / 从未撤销过）。
 */
export function redo(docKey?: string): HistoryEntry | null {
  const key = requireActiveOr(docKey);
  if (!key) return null;
  const doc = docs.get(key);
  if (!doc || doc.cursor >= doc.entries.length) return null;
  touch(key);
  const entry = doc.entries[doc.cursor];
  doc.cursor += 1;
  doc.knownText = entry.after;
  return entry;
}

/** 还能撤销吗（不消费游标） */
export function canUndo(docKey?: string): boolean {
  return peekUndo(docKey) !== null;
}

/** 还能恢复吗（不消费游标） */
export function canRedo(docKey?: string): boolean {
  return peekRedo(docKey) !== null;
}

/** 关闭文档：丢弃整份历史（含检查点）。若是活跃文档则清空活跃指针 */
export function forget(docKey: string): void {
  if (!docKey) return;
  docs.delete(docKey);
  if (activeKey === docKey) activeKey = null;
}

/** 时间线已知的宿主文本（纯逻辑视角；源码模式调用方应喂 unmask 后的真实内容） */
export function currentText(docKey?: string): string | null {
  const key = requireActiveOr(docKey);
  if (!key) return null;
  const doc = docs.get(key);
  return doc ? doc.knownText : null;
}

/** 只看下一步撤销条目，不消费游标（coordinator 的先校验后应用） */
export function peekUndo(docKey?: string): HistoryEntry | null {
  const key = requireActiveOr(docKey);
  if (!key) return null;
  const doc = docs.get(key);
  if (!doc || doc.cursor <= 0) return null;
  return doc.entries[doc.cursor - 1];
}

/** 只看下一步恢复条目，不消费游标 */
export function peekRedo(docKey?: string): HistoryEntry | null {
  const key = requireActiveOr(docKey);
  if (!key) return null;
  const doc = docs.get(key);
  if (!doc || doc.cursor >= doc.entries.length) return null;
  return doc.entries[doc.cursor];
}

/**
 * 定点丢弃一条条目（设计文档 §1.4 步骤 2 的「丢弃该条目」）。
 *
 * 用于**跨文件护栏不通过**时：该条目的 `after` 与宿主当前文本已不一致，说明替换之后文档
 * 又被改过（而那次改动没进本文档时间线）。此时既不能应用它，也不该让它卡在栈顶，
 * 定点删除并让调用方提示用户。其余条目原样保留（每条都存全文，不依赖被删条目的链）：
 * `knownText` **不变**（宿主确实还是那个文本），因此后续 `commit` 仍能正常入库。
 */
export function drop(docKey: string, entryId: number): boolean {
  if (!docKey) return false;
  const doc = docs.get(docKey);
  if (!doc) return false;
  const idx = doc.entries.findIndex((e) => e.id === entryId);
  if (idx < 0) return false;
  const entry = doc.entries[idx];
  doc.entryChars -= entry.before.length + entry.after.length;
  doc.entries.splice(idx, 1);
  // 删除的是"已应用"的条目（idx < cursor）→ 游标跟着退一位；删除 redo 分支则不动游标
  if (idx < doc.cursor) doc.cursor -= 1;
  doc.cursor = Math.max(0, Math.min(doc.cursor, doc.entries.length));
  return true;
}

// ─────────────────────────────────────────────────────────────
// 测试/诊断
// ─────────────────────────────────────────────────────────────

/**
 * 把时间线的「已知宿主文本」前移到 `text`，**不产生条目**。
 *
 * 何时需要：宿主文本被**非编辑类**动作改变（模式切换整篇重解析、翻译回写、外部重载之外的
 * 程序化写回、格式刷等 addToHistory:false 的整篇替换）。这些动作不该进用户可见时间线，
 * 但如果不同步 knownText，下一次 `commit` 会因失配被拒绝 → 用户从此**再也撤不回来**
 * （比丢一步历史严重得多）。
 *
 * 语义边界（刻意保守）：
 * - 若 `text` 与 knownText 一致 → 无事可做，返回 false；
 * - 若时间线**有未应用的 redo 分支**（cursor < entries.length）且未传 `force` → 不改
 *   knownText，返回 false。因为此时「宿主文本 = 某条已撤销条目的 after」是**合法的中间态**,
 *   改它会让 redo 失败；
 * - `force: true`（coordinator 在"宿主文本确实已经偏离"时用）：先按常规截断 redo 分支
 *   （宿主既然已经变了，旧 redo 本来就该失效），再推进 knownText；
 * - 否则只推进 knownText（条目不动）。调用方若要"外部重载"语义（连历史一起丢），用 `begin`。
 */
export function rebaseText(
  docKey: string,
  text: string,
  opts?: { force?: boolean },
): boolean {
  if (!docKey || typeof text !== "string") return false;
  const doc = docs.get(docKey);
  if (!doc) return false;
  if (doc.knownText === text) return false;
  if (doc.cursor < doc.entries.length) {
    if (!opts?.force) return false;
    truncateRedo(doc);
  }
  doc.knownText = text;
  return true;
}

/**
 * 测试/诊断：取一份时间线的快照（条目逐条浅拷贝，避免测试被内部合并/淘汰的原地修改干扰）。
 */
export function snapshotForTest(docKey: string): DocumentHistory | null {
  const doc = docs.get(docKey);
  if (!doc) return null;
  return {
    docKey: doc.docKey,
    entries: doc.entries.map((e) => ({ ...e })),
    cursor: doc.cursor,
  };
}

// ─────────────────────────────────────────────────────────────
// 冻结接口的默认实现实例（coordinator 依赖注入用）
// ─────────────────────────────────────────────────────────────

/**
 * 默认单例实现。coordinator 通过参数接收这个接口，单测可以注入替身
 * （例如统计 "undo 被调用了几次"）。
 */
export const documentHistory: DocumentHistoryApiEx = {
  begin,
  commit,
  undo,
  redo,
  canUndo,
  canRedo,
  forget,
  snapshotForTest,
  currentText,
  peekUndo,
  peekRedo,
  drop,
  rebaseText,
};

// ─────────────────────────────────────────────────────────────
// 测试钩子（生产代码不得调用）
// ─────────────────────────────────────────────────────────────

/** 清空全部文档历史并复位预算（每个测试用例前调用，保证用例间零泄漏） */
export function __resetDocumentHistoryForTest(): void {
  docs.clear();
  activeKey = null;
  nextEntryId = 1;
  stepsLimit = MAX_STEPS;
  charsLimit = MAX_CHARS;
  docsLimit = MAX_DOCS;
}

/** 临时调小预算（用真实 32MB 字符串测淘汰会拖慢/撑爆 CI，改由小预算等价验证） */
export function __configureDocumentHistoryForTest(opts: {
  maxSteps?: number;
  maxChars?: number;
  maxDocs?: number;
}): void {
  if (typeof opts.maxSteps === "number" && opts.maxSteps > 0) stepsLimit = opts.maxSteps;
  if (typeof opts.maxChars === "number" && opts.maxChars > 0) charsLimit = opts.maxChars;
  if (typeof opts.maxDocs === "number" && opts.maxDocs > 0) docsLimit = opts.maxDocs;
}

/** 当前字符占用（预算收敛断言用） */
export function __charUsageForTest(docKey: string): number {
  const doc = docs.get(docKey);
  return doc ? usageOf(doc) : 0;
}

/** 当前保留的文档数（LRU 断言用） */
export function __docCountForTest(): number {
  return docs.size;
}

/** 当前活跃文档键（诊断用） */
export function __activeDocKeyForTest(): string | null {
  return activeKey;
}

/** 某个文档的检查点文本（淘汰后仍可 undo 到检查点的断言用） */
export function __baseTextForTest(docKey: string): string | null {
  const doc = docs.get(docKey);
  return doc ? doc.baseText : null;
}
