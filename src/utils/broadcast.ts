/**
 * v0.9.0 WP5：全局状态的跨窗口同步。
 *
 * ## 同步范围（PRD §3.3）
 *
 * 只有**真正全局**的状态需要跨窗口同步：
 * - `useSettingsStore`（主题/字体/侧栏宽度/AI 配置/启动恢复开关…）；
 * - `useFileStore` 的持久化字段（最近文件/最近文件夹/收藏夹/sessionFolders）。
 *
 * 窗口级状态（编辑器标签、临时标签、浏览进度、打开文件夹列表）**不参与广播**
 * ——它们本就按窗口隔离（内存态独立 + localStorage key 带窗口后缀）。
 *
 * ## 为什么用 `store.subscribe` 而不是在各 setter 末尾手写 broadcast
 *
 * 手写需要在 ~25 个 setter 里各加一行，新增 setter 极易漏掉。改为订阅 store
 * 变化 + 字段级 diff：
 * - 只比较**持久化白名单字段**（引用比较，O(1) 级），`setTempFiles` 这类高频
 *   变更不会误触发广播；
 * - 用 `suppressBroadcast` 屏蔽「对端 rehydrate 引起的自身变化」，彻底避免
 *   A 广播 → B rehydrate → B 广播 → A rehydrate 的乒乓风暴；
 * - 广播延后到当前同步栈结束（`setTimeout 0`）并合并同一 tick 内的多次变更：
 *   zustand persist 是在 `setState` 之后才写 localStorage，必须等写盘完成再通知
 *   对端，否则对端 rehydrate 读到的还是旧值。
 */

import { isTauri } from "../services/fileService";
import { getWindowLabel } from "../utils/windowLabel";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useFileStore } from "../stores/useFileStore";

/** 设置变更事件（payload 见 PRD §3.3.1） */
export const SETTINGS_CHANGED_EVENT = "lightmd:settingsChanged";
/** 文件库变更事件 */
export const FILESTORE_CHANGED_EVENT = "lightmd:filestoreChanged";

/** 参与跨窗口同步的文件库字段（与 persist.partialize 保持一致） */
export const FILESTORE_SYNCED_FIELDS = [
  "recentFiles",
  "recentFolders",
  "favorites",
  "sessionFolders",
] as const;

type Unlisten = () => void;

let unlisteners: Unlisten[] = [];
let started = false;
/** 正在应用对端广播（此期间本窗口的变化不再回播，防乒乓） */
let suppressBroadcast = false;

// ───────────────────────── 变更广播（发送侧） ─────────────────────────

let pendingSettingsKeys = new Set<string>();
let settingsTimer: ReturnType<typeof setTimeout> | null = null;
let pendingFilestoreFields = new Set<string>();
let filestoreTimer: ReturnType<typeof setTimeout> | null = null;

async function emitEvent(event: string, payload: unknown): Promise<void> {
  if (!isTauri()) return;
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(event, payload);
  } catch (err) {
    // 同步失败不影响本窗口功能
    console.warn("[broadcast] 事件发送失败（忽略）:", err);
  }
}

/** 合并同一 tick 内的多次设置变更后统一广播 */
function queueSettingsBroadcast(changedKeys: string[]): void {
  if (!isTauri()) return;
  for (const k of changedKeys) pendingSettingsKeys.add(k);
  if (settingsTimer) return;
  settingsTimer = setTimeout(() => {
    settingsTimer = null;
    const keys = [...pendingSettingsKeys];
    pendingSettingsKeys.clear();
    if (keys.length === 0) return;
    void emitEvent(SETTINGS_CHANGED_EVENT, {
      sourceWindowId: getWindowLabel(),
      changedKeys: keys,
      timestamp: Date.now(),
    });
  }, 0);
}

/** 合并同一 tick 内的多次文件库变更后统一广播 */
function queueFilestoreBroadcast(changedFields: string[]): void {
  if (!isTauri()) return;
  for (const f of changedFields) pendingFilestoreFields.add(f);
  if (filestoreTimer) return;
  filestoreTimer = setTimeout(() => {
    filestoreTimer = null;
    const fields = [...pendingFilestoreFields];
    pendingFilestoreFields.clear();
    if (fields.length === 0) return;
    void emitEvent(FILESTORE_CHANGED_EVENT, {
      sourceWindowId: getWindowLabel(),
      changedFields: fields,
      timestamp: Date.now(),
    });
  }, 0);
}

/** 浅比较两个 state 指定字段的变化（引用比较；列表较小，开销可忽略） */
export function diffFields<T extends object>(
  prev: T,
  next: T,
  fields: readonly (keyof T)[] | null,
): string[] {
  const changed: string[] = [];
  if (fields) {
    for (const f of fields) {
      if (prev[f] !== next[f]) changed.push(String(f));
    }
    return changed;
  }
  // fields = null：比较全部非函数字段（设置 store 全部字段都可持久化）
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const k of keys) {
    const a = (prev as Record<string, unknown>)[k];
    const b = (next as Record<string, unknown>)[k];
    if (typeof a === "function" || typeof b === "function") continue;
    if (a !== b) changed.push(k);
  }
  return changed;
}

// ───────────────────────── 接收侧 ─────────────────────────

async function applyRemoteSettings(payload: {
  sourceWindowId?: string;
  changedKeys?: string[];
}): Promise<void> {
  if (payload?.sourceWindowId === getWindowLabel()) return; // 自忽略（防循环）
  suppressBroadcast = true;
  try {
    // 全量重置为 localStorage 中的最新值：不做逐字段合并，新增字段不会漏
    await useSettingsStore.persist.rehydrate();
  } catch (err) {
    console.warn("[broadcast] 设置同步失败（忽略）:", err);
  } finally {
    suppressBroadcast = false;
  }
}

async function applyRemoteFileStore(payload: {
  sourceWindowId?: string;
  changedFields?: string[];
}): Promise<void> {
  if (payload?.sourceWindowId === getWindowLabel()) return;
  suppressBroadcast = true;
  try {
    await useFileStore.persist.rehydrate();
  } catch (err) {
    console.warn("[broadcast] 文件库同步失败（忽略）:", err);
  } finally {
    suppressBroadcast = false;
  }
}

/**
 * 启动跨窗口同步：订阅两个全局 store 的变更并广播；同时监听对端广播并 rehydrate。
 *
 * 幂等：重复调用不会重复注册（StrictMode 双挂载安全）。
 * 返回取消函数（组件卸载 / 测试清理用）。
 */
export async function setupBroadcastListeners(): Promise<Unlisten> {
  if (started) return teardownBroadcastListeners;
  started = true;

  // 1. 发送侧：store 变化 → 广播
  const unsubSettings = useSettingsStore.subscribe((state, prev) => {
    if (suppressBroadcast) return;
    const changed = diffFields(prev, state, null);
    if (changed.length === 0) return;
    queueSettingsBroadcast(changed);
  });
  const unsubFileStore = useFileStore.subscribe((state, prev) => {
    if (suppressBroadcast) return;
    const changed = diffFields(prev, state, FILESTORE_SYNCED_FIELDS);
    if (changed.length === 0) return;
    queueFilestoreBroadcast(changed);
  });

  // 2. 接收侧：监听对端广播
  const local: Unlisten[] = [unsubSettings, unsubFileStore];
  if (isTauri()) {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      local.push(
        await listen<{ sourceWindowId: string; changedKeys: string[] }>(
          SETTINGS_CHANGED_EVENT,
          (ev) => void applyRemoteSettings(ev.payload),
        ),
      );
      local.push(
        await listen<{ sourceWindowId: string; changedFields: string[] }>(
          FILESTORE_CHANGED_EVENT,
          (ev) => void applyRemoteFileStore(ev.payload),
        ),
      );
    } catch (err) {
      console.error("[broadcast] 事件订阅失败:", err);
    }
  }

  unlisteners = local;
  return teardownBroadcastListeners;
}

/** 取消全部订阅与待发广播 */
export function teardownBroadcastListeners(): void {
  for (const un of unlisteners) {
    try {
      un();
    } catch {
      // 忽略单个取消失败
    }
  }
  unlisteners = [];
  started = false;
  if (settingsTimer) {
    clearTimeout(settingsTimer);
    settingsTimer = null;
  }
  if (filestoreTimer) {
    clearTimeout(filestoreTimer);
    filestoreTimer = null;
  }
  pendingSettingsKeys.clear();
  pendingFilestoreFields.clear();
}

/** 测试用：当前是否处于「应用对端广播」的抑制窗口内 */
export function __isBroadcastSuppressed(): boolean {
  return suppressBroadcast;
}
