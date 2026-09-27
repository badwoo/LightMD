/**
 * fileScrollProgress —— 按文件/标签记录浏览进度（v0.7.0 bug 修复 + v0.8.3 需求6）
 *
 * 需求：
 * - v0.7.0：切换不同打开的文件（标签页切换）时浏览进度保留；
 *   重新打开该文件（文件树点击/关闭标签后再打开）时进度重置。
 * - v0.8.3 需求6：跨会话记住文档阅读位置——软件关闭重开后，被"启动时载入
 *   上次打开的文件"恢复的文档仍停留在上次阅读位置（临时文件同样适用）。
 *
 * 设计（开销最小化）：
 * - 模块级 Map<key, percent>，scroll 事件实时写入（同 key 覆盖，O(1)）
 * - 标签切换：EditorContainer 读 Map 恢复滚动位置
 * - 重新打开/关闭标签：App 层调用 clear 清除该文件记录
 * - 上限保护：超过 MAX_ENTRIES 删除最旧条目（Map 迭代序 = 插入序），
 *   每条仅一个 number，内存开销可忽略
 * - v0.8.3：**写路径**只在 5s 心跳 + 窗口关闭时落盘一次，且仅在进度确实变化
 *   （revision 变化）时写；滚动本身零新增开销（仍是内存 Map.set）。
 *   **读路径**仅启动时一次 JSON.parse（≤60 条 number）。
 *
 * 键约定：真实文件 = path，临时标签 = "untitled:<id>"（见 utils/tabKey.ts 单源）。
 */

import { safeSetItem } from "../utils/safeStorage";
import { withWindowSuffix } from "../utils/windowLabel";

export const SCROLL_PROGRESS_KEY = "lightmd-scroll-progress";

/**
 * v0.9.0：浏览进度是**窗口级**数据。
 *
 * 产品决策（PRD §3.2.4）：同一文件在不同窗口打开时滚动位置相互独立——
 * 这正符合"对照阅读"场景（窗口 A 看开头、窗口 B 看结尾）。
 * main 沿用无后缀旧 key（v0.8.5 数据原地可用，零迁移），sec-* 加 `-{label}` 后缀。
 */
function progressKey(): string {
  return withWindowSuffix(SCROLL_PROGRESS_KEY);
}

const progressMap = new Map<string, number>();
const MAX_ENTRIES = 60;

/**
 * 进度改动计数：任何 set/clear 都会递增。
 * `saveSnapshot` 记录上次落盘时的计数，心跳里据此判断"是否需要真的写盘"
 * （无变化时完全不动 localStorage）。
 */
let revision = 0;
let savedRevision = -1;

/** 读取标签浏览进度（0-1）；无记录返回 null（不恢复，保持顶部） */
function getProgress(key: string | null | undefined): number | null {
  const v = key ? progressMap.get(key) : null;
  return v ?? null;
}

/** 记录标签浏览进度（scroll 事件实时调用） */
function setProgress(key: string | null | undefined, percent: number): void {
  if (!key) return;
  progressMap.set(key, percent);
  revision++;
  if (progressMap.size > MAX_ENTRIES) {
    const oldest = progressMap.keys().next().value;
    // 防御：oldest === key 时删除自身无意义（单条超限不可能），跳过
    if (oldest !== undefined && oldest !== key) progressMap.delete(oldest);
  }
}

/** 清除单个标签进度（重新打开 / 关闭标签时调用） */
function clearProgress(key: string | null | undefined): void {
  if (key && progressMap.delete(key)) revision++;
}

/**
 * v0.8.3 需求6：把**指定键**的进度写入 localStorage（覆盖式）。
 *
 * 只写当前打开标签的键 → 快照大小 = 打开标签数 × ~40 字节（通常 < 2KB），
 * 且随标签关闭自动收敛（关闭标签时该键已从 Map 中 clear）。
 */
function saveSnapshot(keys: readonly string[]): void {
  try {
    const payload: Record<string, number> = {};
    let count = 0;
    for (const key of keys) {
      if (!key) continue;
      const v = progressMap.get(key);
      if (typeof v === "number" && Number.isFinite(v)) {
        if (payload[key] === undefined) count++;
        payload[key] = v;
      }
    }
    if (count === 0) {
      // 无任何可写条目：清掉历史键，避免"关闭开关/关闭全部标签后仍有残留"
      if (typeof localStorage !== "undefined") localStorage.removeItem(progressKey());
      savedRevision = revision;
      return;
    }
    safeSetItem(progressKey(), JSON.stringify(payload));
    savedRevision = revision;
  } catch (err) {
    console.warn("[fileScrollProgress] 快照写入失败（忽略）:", err);
  }
}

/** v0.8.3 需求6：启动时读回快照并注入 Map（数据损坏时静默忽略） */
function loadSnapshot(): void {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(progressKey()) : null;
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!key || typeof value !== "number" || !Number.isFinite(value)) continue;
      progressMap.set(key, value);
      if (progressMap.size > MAX_ENTRIES) {
        const oldest = progressMap.keys().next().value;
        if (oldest !== undefined && oldest !== key) progressMap.delete(oldest);
      }
    }
    // 注入的数据即"已落盘状态"，心跳不会立刻重复写
    revision++;
    savedRevision = revision;
  } catch (err) {
    console.warn("[fileScrollProgress] 快照读取失败（忽略）:", err);
  }
}

/** v0.8.3 需求6：清除全部内存进度与落盘快照（关闭"载入上次打开的文件"开关时） */
function clearAll(): void {
  progressMap.clear();
  revision++;
  savedRevision = revision;
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(progressKey());
  } catch {
    // 忽略
  }
}

/** 自上次落盘以来进度是否有变化（心跳据此跳过无意义的 localStorage 写） */
function hasUnsavedChanges(): boolean {
  return revision !== savedRevision;
}

/**
 * v0.8.3 需求6：把进度从旧键迁移到新键（临时标签另存为晋升为正式文件时调用）。
 * 不迁移的话，保存成功后该标签的进度键从 untitled:<id> 变成 path，
 * 用户会看到"刚保存就跳回文档顶部"。
 */
function moveProgress(fromKey: string | null | undefined, toKey: string | null | undefined): void {
  if (!fromKey || !toKey || fromKey === toKey) return;
  const v = progressMap.get(fromKey);
  if (typeof v !== "number") return;
  progressMap.delete(fromKey);
  progressMap.set(toKey, v);
  revision++;
}

export const fileScrollProgress = {
  get: getProgress,
  set: setProgress,
  // v0.8.0 修复 P1-2：移除 setAnchorLine/getAnchorLine——模式切换的编辑锚点改为
  // "切换瞬间从当前光标现算"，不再需要按文件持久化锚点（旧 API 写入后无人读取）
  clear: clearProgress,
  // v0.8.3 需求6：临时标签晋升为正式文件时把进度迁移到新键
  move: moveProgress,
  // ─── v0.8.3 需求6：跨会话快照 ───
  saveSnapshot,
  loadSnapshot,
  clearAll,
  hasUnsavedChanges,
  /** 测试用：当前内存条目数 */
  size: () => progressMap.size,
};

/**
 * v0.9.0：清理**指定槽位**的落盘快照（Rust 侧槽位复用时调用，避免上一轮
 * 该槽位的滚动进度混入新窗口）。内存 Map 属于当前窗口，无需处理。
 */
export function clearScrollProgressForLabel(label: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    const key = label === "main" ? SCROLL_PROGRESS_KEY : `${SCROLL_PROGRESS_KEY}-${label}`;
    localStorage.removeItem(key);
  } catch {
    // 忽略
  }
}
