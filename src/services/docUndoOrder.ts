/**
 * v0.13.2 需求5：跨文档**顺序**撤销 / 恢复（Word 语义）的纯逻辑层。
 *
 * ## 用户报告
 * 「我在 a 文档编辑内容，切换 b 文档编辑再切换回来后，发现 a 文档编辑的内容无法撤销了。
 *  a 文档编辑内容撤销应该要生效，并且撤销和恢复应该是顺序的：打开 a、b 两个文档，
 *  在 a 编辑了 3 处、再到 b 编辑了 2 处，现在在 b 撤销了 b 的 2 处，再撤销就自动跳到
 *  a 文档进行 a 的撤销。逻辑和 Word 文档应该一致。」
 *
 * ## 两个独立的缺陷
 * 1. **切走就丢历史**：v0.13.1 为修「撤销跨文档污染」，换文档时直接清空了撤销栈
 *    （`resetHistory`）。代价是「切回来撤不了」——本条需求要的正是把这个代价补回来。
 * 2. **没有全局顺序**：撤销只作用于当前文档，不知道"最近编辑的是另一个文档"。
 *
 * ## 本模块的职责（只做账本，不碰文档内容）
 * - 记录**文档的编辑先后顺序**：每个文档键最多出现一次，最近编辑的排在末尾；
 * - `takeUndoTarget` / `takeRedoTarget`：给出「下一次撤销/恢复应该作用于哪个文档」；
 * - 撤销/恢复时把该文档在两侧账本之间搬移（与编辑器自身的 undo/redo 栈同步）。
 *
 * 「这个文档还能不能撤」由调用方判定（只有它持有该文档的 PM 视图 / 源码 diff 栈），
 * 本模块通过注入的 `canUndo` 回调询问。这样纯逻辑可单测，且不需要知道
 * ProseMirror / textarea 的任何细节。
 */

/** 文档键（与 fileScrollProgress / tabKey 同源：真实文件 = 路径，临时标签 = untitled:<id>） */
export type DocKey = string;

/** 撤销账本：按"最近一次编辑"排序，末尾 = 最近编辑的文档 */
let undoOrder: DocKey[] = [];
/** 恢复账本：被撤销过的文档，末尾 = 最近被撤销的文档 */
let redoOrder: DocKey[] = [];

/** 账本最大文档数（超长会话防护；正常远达不到） */
const MAX_DOCS = 500;

/**
 * 跨文档撤销/恢复的**待执行请求**。
 *
 * 跨文档操作必须「先切到目标文档 → 等内容装载 → 再执行撤销」，
 * 而切标签是 App 层的 React 状态变更，无法在同一个调用栈内完成。
 * 因此这里放一次性请求，由 `EditorContainer` 在换文档 effect 末尾消费。
 */
let pending: { key: DocKey; kind: "undo" | "redo" } | null = null;

function trim(list: DocKey[]): DocKey[] {
  return list.length > MAX_DOCS ? list.slice(list.length - MAX_DOCS) : list;
}

/**
 * 登记一次编辑：该文档成为「最近编辑」。
 *
 * 同时**只**从恢复账本里移除该文档——新的编辑让**这个文档**的 redo 语义作废
 * （与所有编辑器的 redo 一致：编辑后 redo 栈清空）。
 * ⚠️ 不能清空整个恢复账本：那会连带毁掉**其他文档**的恢复能力，
 * 而本需求要的正是"每文档独立的撤销 / 恢复栈"（Word 语义）。
 */
export function noteEdit(key: DocKey | null | undefined): void {
  if (!key) return;
  undoOrder = trim(undoOrder.filter((k) => k !== key));
  undoOrder.push(key);
  redoOrder = redoOrder.filter((k) => k !== key);
}

/**
 * 取下一次**撤销**的目标文档。
 *
 * 从账本尾部往前找第一个仍可撤销的文档（`canUndo` 为真）。
 * 尾部那些"已经撤不动"的文档被就地剔除——否则下一次撤销会选中一个空栈文档，
 * 表现为"按 Ctrl+Z 毫无反应"。
 *
 * @returns 目标文档键；全部撤完返回 null
 */
export function takeUndoTarget(canUndo: (key: DocKey) => boolean): DocKey | null {
  for (let i = undoOrder.length - 1; i >= 0; i--) {
    const key = undoOrder[i];
    if (canUndo(key)) {
      // 只保留到目标为止（其后的都已撤不动）
      undoOrder = undoOrder.slice(0, i + 1);
      return key;
    }
  }
  undoOrder = [];
  return null;
}

/** 取下一次**恢复**的目标文档（与 takeUndoTarget 对称） */
export function takeRedoTarget(canRedo: (key: DocKey) => boolean): DocKey | null {
  for (let i = redoOrder.length - 1; i >= 0; i--) {
    const key = redoOrder[i];
    if (canRedo(key)) {
      redoOrder = redoOrder.slice(0, i + 1);
      return key;
    }
  }
  redoOrder = [];
  return null;
}

/**
 * 记一次撤销：该文档在撤销账本里**保留并置到末尾**，同时登记进恢复账本。
 *
 * ⚠️ 不能把该文档从撤销账本里删掉。撤销一次后这个文档**通常还有剩余步数**
 * （用户在 b 编辑 2 处，撤第 1 次后还剩 1 步），而本模块无法判断剩余深度。
 * 早期实现把文档直接搬去恢复账本，导致「在 b 撤了 1 次，第 2 次就跳到 a」——
 * 正是用户报的那个错误顺序（Word 的撤销栈是全局线性的：B2 → B1 → A3 → A2 → A1）。
 * 真正把文档移出撤销账本的是 `takeUndoTarget` 的 `canUndo` 剪枝：撤不动时才剔除。
 *
 * 因此一次撤销后，同一文档可能**同时**出现在两侧账本里（中间态：还能继续撤，
 * 也还能恢复），这是正确且必需的。
 */
export function noteUndone(key: DocKey): void {
  if (!key) return;
  undoOrder = trim(undoOrder.filter((k) => k !== key));
  undoOrder.push(key);
  redoOrder = redoOrder.filter((k) => k !== key);
  redoOrder = trim(redoOrder);
  redoOrder.push(key);
}

/**
 * 记一次恢复：该文档在恢复账本里**保留并置到末尾**，同时登记回撤销账本。
 *
 * 与 `noteUndone` 完全对称：恢复一次后该文档通常还有剩余可恢复步数
 * （在 a 里连撤 2 次再连按 2 次 Ctrl+Y，第 2 次必须还能恢复 a），
 * 真正的移除由 `takeRedoTarget` 的 `canRedo` 剪枝完成。
 */
export function noteRedone(key: DocKey): void {
  if (!key) return;
  redoOrder = trim(redoOrder.filter((k) => k !== key));
  redoOrder.push(key);
  undoOrder = undoOrder.filter((k) => k !== key);
  undoOrder = trim(undoOrder);
  undoOrder.push(key);
}

/** 文档被关闭：清掉它的全部账目与待执行请求 */
export function forgetDoc(key: DocKey | null | undefined): void {
  if (!key) return;
  undoOrder = undoOrder.filter((k) => k !== key);
  redoOrder = redoOrder.filter((k) => k !== key);
  if (pending?.key === key) pending = null;
}

/** 登记「切到某文档后要执行的撤销/恢复」 */
export function setPendingRequest(req: { key: DocKey; kind: "undo" | "redo" } | null): void {
  pending = req;
}

/** 取出并清空待执行请求 */
export function consumePendingRequest(): { key: DocKey; kind: "undo" | "redo" } | null {
  const req = pending;
  pending = null;
  return req;
}

/** 是否有待执行请求（只读，供诊断/测试） */
export function hasPendingRequest(): boolean {
  return pending !== null;
}

/** 账本快照（测试用；生产代码不应依赖） */
export function __ledgerSnapshot(): { undo: DocKey[]; redo: DocKey[] } {
  return { undo: [...undoOrder], redo: [...redoOrder] };
}

/** 清空全部账本（测试 / 应用重置） */
export function __resetDocUndoOrderForTest(): void {
  undoOrder = [];
  redoOrder = [];
  pending = null;
  bridge = null;
}

// ─── 路由桥（由 EditorContainer / App 注册，供 keymap 与工具栏共用） ────────

/**
 * 撤销/恢复路由需要的三项能力。
 *
 * 为什么要"注册"而不是直接 import：
 * - `depthOf` 只有持有 ProseMirror 视图与源码栈的 `EditorContainer` 知道；
 * - `switchTo` 只有编排标签的 `App` 知道。
 * 放在本模块（零依赖的纯账本）里注册，`core/keymap.ts` 才能在不引入
 * React / store 依赖的情况下走同一条跨文档撤销逻辑。
 */
export interface UndoBridge {
  /** 当前活动文档键（无文档时 null） */
  activeKey: () => DocKey | null;
  /** 该文档还能撤/恢复几步（含"未活动文档"的离线快照深度） */
  depthOf: (key: DocKey, kind: "undo" | "redo") => number;
  /** 切到目标文档；成功返回 true */
  switchTo: (key: DocKey) => boolean;
}

let bridge: UndoBridge | null = null;

/** 注册路由桥（EditorContainer / App 挂载时调用，卸载时传 null） */
export function registerUndoBridge(b: UndoBridge | null): void {
  bridge = b;
}

/** 当前活动文档键（桥未注册时 null） */
export function getActiveDocKey(): DocKey | null {
  return bridge ? bridge.activeKey() : null;
}

/**
 * 路由一次撤销/恢复。
 *
 * @returns
 * - `"local"`    → 目标就是当前文档，调用方执行本地撤销/恢复；
 * - `"switched"` → 目标在别的文档，已切过去并登记了待执行请求，调用方直接返回；
 * - `"none"`     → 没有任何文档可撤（调用方可给出"已到撤销边界"提示）。
 */
export function routeUndo(kind: "undo" | "redo"): "local" | "switched" | "none" {
  if (!bridge) return "local";
  const active = bridge.activeKey();
  const pick = kind === "undo" ? takeUndoTarget : takeRedoTarget;
  const target = pick((key) => bridge!.depthOf(key, kind) > 0);
  if (!target) return "none";
  if (target === active) return "local";
  if (!bridge.switchTo(target)) {
    // 目标文档已不在（标签被关掉等）→ 从账本剔除后重试一次，避免死循环
    forgetDoc(target);
    const again = pick((key) => bridge!.depthOf(key, kind) > 0);
    if (!again) return "none";
    if (again === active) return "local";
    if (!bridge.switchTo(again)) return "none";
    setPendingRequest({ key: again, kind });
    return "switched";
  }
  setPendingRequest({ key: target, kind });
  return "switched";
}
