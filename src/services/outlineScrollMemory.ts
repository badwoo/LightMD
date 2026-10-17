/**
 * v0.13.2 需求7b：**右侧大纲的滚动位置记忆**（按文档）。
 *
 * ## 用户报告
 * 「右侧大纲栏和文档阅读位置一样也要有记忆。当前文档阅读到底部了，每次切换其他文档
 *  再切回来，右侧大纲栏都要自动滚动一次，这个效果不好。所以大纲栏既然已经跟随文档
 *  阅读滚动了，那么也要加上滚动位置记忆。」
 *
 * ## 为什么会出现"每次切回来都自动滚一次"
 * v0.13.1 让大纲跟随文档滚动（把活动标题滚进可视区）。切回一个"读到末尾"的文档时：
 * ① 大纲列表初始 scrollTop = 0；② 文档恢复滚动到底部；③ IntersectionObserver 算出
 * 活动标题在很靠后的位置；④ 跟随逻辑把大纲平滑滚过去 —— 用户看到的就是
 * "切回来大纲自己滚一下"。
 *
 * ## 做法
 * 按**文档键**记住大纲列表的 scrollTop（与 `fileScrollProgress` 同源的键：
 * 真实文件 = 路径，临时标签 = `untitled:<id>`）：
 * - 大纲列表滚动时实时写入（节流）；
 * - 文档切换后，列表挂载/标题就绪时**先恢复记忆位置**，并在短暂窗口内抑制跟随
 *   （否则跟随会立刻把位置又改掉）。
 *
 * 内存 Map + 可选持久化（走 localStorage 快照，跨会话也记得）。
 * 上限 60 条，与 `fileScrollProgress` 的 LRU 口径一致。
 */

const STORAGE_KEY = "lightmd-outline-scroll";

/** 最多记录的文档数（与 fileScrollProgress 同口径） */
const MAX_ENTRIES = 60;

/** 文档键 → 大纲列表 scrollTop（px） */
const memory = new Map<string, number>();

/** 是否有未落盘的改动 */
let dirty = false;

/** 节流用的挂起定时器 */
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** 写入某个文档的大纲滚动位置 */
export function setOutlineScroll(key: string | null | undefined, top: number): void {
  if (!key) return;
  if (!Number.isFinite(top) || top < 0) return;
  const rounded = Math.round(top);
  if (memory.get(key) === rounded) return;
  memory.set(key, rounded);
  // LRU：超限时删最早插入的一条
  while (memory.size > MAX_ENTRIES) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
  dirty = true;
  schedulePersist();
}

/** 读取某个文档的大纲滚动位置（无记录返回 null） */
export function getOutlineScroll(key: string | null | undefined): number | null {
  if (!key) return null;
  const v = memory.get(key);
  return typeof v === "number" ? v : null;
}

/** 清理某个文档的记忆（关闭标签时调用） */
export function clearOutlineScroll(key: string | null | undefined): void {
  if (!key) return;
  if (memory.delete(key)) {
    dirty = true;
    schedulePersist();
  }
}

/** 清空全部（应用重置 / 测试） */
export function clearAllOutlineScroll(): void {
  memory.clear();
  dirty = true;
  schedulePersist();
}

/** 是否有未落盘改动（诊断/测试） */
export function hasUnsavedOutlineScroll(): boolean {
  return dirty;
}

/** 条目数（测试） */
export function __outlineScrollSize(): number {
  return memory.size;
}

/** 延迟落盘（合并同一轮多次滚动） */
function schedulePersist(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persist();
  }, 400);
}

/** 落盘到 localStorage（失败静默：这只是体验优化，不能影响主流程） */
function persist(): void {
  if (typeof localStorage === "undefined") return;
  try {
    const obj: Record<string, number> = {};
    for (const [k, v] of memory) obj[k] = v;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
    dirty = false;
  } catch {
    // 配额满 / 隐私模式：忽略
  }
}

/** 启动时读回快照 */
export function loadOutlineScrollSnapshot(): void {
  if (typeof localStorage === "undefined") return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return;
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) memory.set(k, Math.round(v));
    }
    while (memory.size > MAX_ENTRIES) {
      const oldest = memory.keys().next().value;
      if (oldest === undefined) break;
      memory.delete(oldest);
    }
    dirty = false;
  } catch {
    // 快照损坏：忽略，从空开始
  }
}

/** 立即落盘（卸载/退出时） */
export function flushOutlineScroll(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (dirty) persist();
}

/** 测试用：清空且不落盘 */
export function __resetOutlineScrollForTest(): void {
  memory.clear();
  dirty = false;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}
