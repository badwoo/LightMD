/**
 * v0.13.2 需求5：**每个文档自己的撤销历史**（跨标签保留）。
 *
 * ## 缺陷背景
 * v0.13.1 为了修「在 B 里撤销把 A 的内容带进来」，在换文档时直接清空了撤销栈
 * （`core/editor.ts` 的 `resetHistory` → 重建 state）。数据安全是保住了，但代价是：
 * 用户切走再切回，**这个文档之前的编辑就再也撤不回来了**（本轮用户报告的第二半）。
 *
 * ## 做法
 * 换文档时把**离开的那个文档**的撤销状态存起来，回来时再装回去：
 * - ProseMirror：`EditorState` 上的 history 插件状态（含 undo / redo 两条分支）；
 * - 源码模式：diff 栈（`HistoryEntry[]`，由 EditorContainer 持有）。
 *
 * 两者都是「位置敏感的」——只在**文档内容与保存时逐字节一致**时才装回，
 * 否则位置会错位（把撤销应用到错误的字符偏移上，比丢历史严重得多）。
 * 内容不一致时该文档的历史被丢弃（与 v0.13.1 的行为一致）。
 */

/** 一个文档的撤销历史快照 */
export interface DocHistorySnapshot {
  /** 保存时的 Markdown（用于判定"能不能安全装回"） */
  content: string;
  /**
   * ProseMirror history 插件状态（`EditorState[historyKey.key]`）。
   * 类型是 prosemirror-history 的内部 `HistoryState`，这里不引入其类型，
   * 由调用方（core/editor 的封装）原样存取。
   */
  pmHistory: unknown;
  /** 源码模式的撤销 / 恢复栈（`HistoryEntry[]`） */
  sourceUndo: unknown[];
  sourceRedo: unknown[];
}

/** 文档键 → 快照（只保留最近活跃的若干个，防超长会话内存膨胀） */
const store = new Map<string, DocHistorySnapshot>();

/** 最多保留的文档数 */
const MAX_DOCS = 40;

/** 保存一个文档的撤销历史（已存在则覆盖，并把它的活跃度提到最新） */
export function saveDocHistory(key: string | null | undefined, snap: DocHistorySnapshot): void {
  if (!key) return;
  store.delete(key);
  store.set(key, snap);
  while (store.size > MAX_DOCS) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/**
 * 取回一个文档的撤销历史。
 *
 * @param content 该文档**当前**的内容。与快照不一致时返回 null 并丢弃快照
 *                （位置会错位，宁可丢历史也不能把撤销应用到错误位置）。
 */
export function loadDocHistory(
  key: string | null | undefined,
  content: string,
): DocHistorySnapshot | null {
  if (!key) return null;
  const snap = store.get(key);
  if (!snap) return null;
  if (snap.content !== content) {
    store.delete(key);
    return null;
  }
  // 提升活跃度（LRU 语义：最近用过的排到最后）
  store.delete(key);
  store.set(key, snap);
  return snap;
}

/** 文档关闭 / 被外部整体替换时丢弃其历史 */
export function forgetDocHistory(key: string | null | undefined): void {
  if (!key) return;
  store.delete(key);
}

/**
 * 某个文档「还能撤几步」。
 *
 * 用于跨文档顺序撤销时判断"这个文档撤完了没有"。只读快照，不需要装载文档。
 * 当前活动文档由调用方自行用真实视图判断（快照可能落后于最新状态）。
 */
export function docHistoryUndoDepth(key: string | null | undefined): number {
  if (!key) return 0;
  const snap = store.get(key);
  if (!snap) return 0;
  return pmUndoDepth(snap.pmHistory) + snap.sourceUndo.length;
}

/** 某个文档「还能恢复几步」 */
export function docHistoryRedoDepth(key: string | null | undefined): number {
  if (!key) return 0;
  const snap = store.get(key);
  if (!snap) return 0;
  return pmRedoDepth(snap.pmHistory) + snap.sourceRedo.length;
}

/**
 * 读 ProseMirror history 状态的撤销深度。
 *
 * `HistoryState.done` 是 prosemirror-history 的 `Branch`，其 `eventCount`
 * 就是 `undoDepth()` 的返回值（见该库实现）。这里做**防御性**读取：
 * 结构对不上时返回 0（宁可当作不可撤销，也不抛错打断撤销流程）。
 */
export function pmUndoDepth(pmHistory: unknown): number {
  const done = (pmHistory as { done?: { eventCount?: number } } | null | undefined)?.done;
  const n = done?.eventCount;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/** 读 ProseMirror history 状态的恢复深度 */
export function pmRedoDepth(pmHistory: unknown): number {
  const undone = (pmHistory as { undone?: { eventCount?: number } } | null | undefined)?.undone;
  const n = undone?.eventCount;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/** 清空全部（测试 / 应用重置） */
export function __resetDocHistoryForTest(): void {
  store.clear();
  crossFileUndo.clear();
  crossFileRedo.clear();
}

/** 已保存的文档数（测试/诊断） */
export function __docHistorySize(): number {
  return store.size;
}

// ─────────────────────────────────────────────────────────────
// v0.14.0 需求2：**跨文件替换的撤销记录**
//
// 用户原话：「通过搜索替换也要进入到撤销栈中，当前没有生效，而且跨文件搜索和替换，
// 切换到对应文件后也能使用撤销或恢复。」
//
// 为什么不能复用上面的 PM / 源码栈：
// - 跨文件替换改的是**未激活**的标签，它们此刻没有 EditorView，也没有 textarea
//   撤销栈（内容只存在于 store 的 `openTabs[i].content`）→ 无栈可记；
// - 用户切过去时 PM state 是**按内容重建**的（`resetHistory` + 可能的
//   `restoreHistory`），重建出来的历史里天然没有"替换"这一步。
//
// 因此按文档键单独记一条「整篇文本级」的撤销对（before → after）：
// - 切到该文档后按 Ctrl+Z，`EditorContainer.doLocalUndo` 先看这里有没有待撤销的
//   外部替换 → 有就把文本写回 before（并把这个动作转成一条可恢复的记录）；
// - **位置敏感护栏**：只有当前文本与 `after` 逐字节一致时才应用。用户若在替换后
//   又手改过这个文件，这条记录会被丢弃并落到常规撤销栈 —— 宁可少撤一步，
//   也绝不能把整篇文本覆盖回去抹掉用户的手工编辑（与上方 `loadDocHistory`
//   同一套安全纪律）。
// ─────────────────────────────────────────────────────────────

/** 一次跨文件替换的前后文本（用于撤销） */
export interface CrossFileEdit {
  /** 替换前（撤销目标） */
  before: string;
  /** 替换后（校验基准：只有当前文本仍等于它才能安全撤销） */
  after: string;
}

/** 文档键 → 待撤销的跨文件替换（最多一层：连续多次替换合并为 before→最新 after） */
const crossFileUndo = new Map<string, CrossFileEdit>();
/** 文档键 → 待恢复的跨文件替换（撤销之后的对称记录） */
const crossFileRedo = new Map<string, CrossFileEdit>();

/**
 * 记录一次跨文件替换（供之后撤销）。
 *
 * 同一个文档被连续替换多次时**合并**：保留最早的 before + 最新的 after，
 * 这样一次 Ctrl+Z 就能把该文件恢复成"本轮跨文件替换之前"的样子
 * （用户的心智模型是"撤回那次批量替换"，而不是撤其中一处）。
 */
export function recordCrossFileEdit(key: string | null | undefined, before: string, after: string): void {
  if (!key || before === after) return;
  const prev = crossFileUndo.get(key);
  crossFileUndo.set(key, { before: prev ? prev.before : before, after });
  // 新的编辑使旧的恢复记录失效（forward 分支被改写）
  crossFileRedo.delete(key);
}

/** 取待撤销的跨文件替换（不删除；调用方按内容校验后再决定用不用） */
export function peekCrossFileUndo(key: string | null | undefined): CrossFileEdit | null {
  if (!key) return null;
  return crossFileUndo.get(key) ?? null;
}

/** 用掉 / 丢弃待撤销记录 */
export function dropCrossFileUndo(key: string | null | undefined): void {
  if (!key) return;
  crossFileUndo.delete(key);
}

/** 取待恢复的跨文件替换 */
export function peekCrossFileRedo(key: string | null | undefined): CrossFileEdit | null {
  if (!key) return null;
  return crossFileRedo.get(key) ?? null;
}

/** 撤销发生后登记可恢复记录；恢复发生后登记可撤销记录 */
export function pushCrossFileRedo(key: string | null | undefined, edit: CrossFileEdit): void {
  if (!key) return;
  crossFileRedo.set(key, edit);
}

export function pushCrossFileUndo(key: string | null | undefined, edit: CrossFileEdit): void {
  if (!key) return;
  crossFileUndo.set(key, edit);
}

export function dropCrossFileRedo(key: string | null | undefined): void {
  if (!key) return;
  crossFileRedo.delete(key);
}

/** 该文档是否有待生效的跨文件替换撤销/恢复（测试与诊断用） */
export function hasCrossFileUndo(key: string | null | undefined): boolean {
  return !!key && crossFileUndo.has(key);
}

export function hasCrossFileRedo(key: string | null | undefined): boolean {
  return !!key && crossFileRedo.has(key);
}
