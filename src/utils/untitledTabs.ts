/**
 * v0.8.0 WP1：临时（未落盘）标签的持久化
 *
 * 需求：临时文件只有用户自行选择路径保存后才持久化到磁盘；但"启动时载入上次
 * 打开的文件"设置对临时文件同样生效——即软件关闭再打开后，临时标签应连同
 * 编辑中的内容一起恢复。
 *
 * 实现：把临时标签序列化进 localStorage（key: lightmd-untitled-tabs），
 * 与 recentFiles 走磁盘重读的机制不同，这里内容直接来自内存快照。
 *
 * 设计要点：
 * - 只存 isUntitled 的标签，正式文件不进来（避免与 recentFiles 重复）
 * - 用 safeSetItem，配额异常时静默降级，不影响编辑
 */

import { safeSetItem } from "./safeStorage";
import type { TabInfo } from "../stores/useEditorStore";

export const UNTITLED_TABS_KEY = "lightmd-untitled-tabs";

/** 持久化的临时标签条目 */
export interface StoredUntitledTab {
  id: string;
  name: string;
  content: string;
}

/**
 * 保存临时标签（覆盖式）。
 * 传入全部标签，内部只挑出 isUntitled 的；没有临时标签时清除该键。
 */
export function saveUntitledTabs(tabs: TabInfo[]): void {
  try {
    const payload: StoredUntitledTab[] = tabs
      .filter((tab) => tab.isUntitled && tab.id)
      .map((tab) => ({
        id: tab.id!,
        name: tab.name,
        content: tab.content ?? "",
      }));
    if (payload.length === 0) {
      clearUntitledTabs();
      return;
    }
    safeSetItem(UNTITLED_TABS_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn("[untitledTabs] 保存失败（忽略）:", err);
  }
}

/** 读取上次会话的临时标签（数据损坏时返回空数组） */
export function loadUntitledTabs(): StoredUntitledTab[] {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(UNTITLED_TABS_KEY) : null;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is StoredUntitledTab =>
        !!item && typeof item.id === "string" && typeof item.name === "string",
    ).map((item) => ({
      id: item.id,
      name: item.name,
      content: typeof item.content === "string" ? item.content : "",
    }));
  } catch {
    return [];
  }
}

/** 清除持久化的临时标签 */
export function clearUntitledTabs(): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(UNTITLED_TABS_KEY);
  } catch {
    // 忽略
  }
}

/**
 * v0.8.0 修复 P2-1：临时标签的写入与恢复共用"启动时载入上次打开的文件"开关。
 *
 * 直接读 localStorage 判定（与 startupRestore.readSettings 一致），避免 zustand
 * persist 的 hydration 时机问题。读取失败按"开启"处理。
 */
export function isUntitledRestoreEnabled(): boolean {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem("lightmd-settings") : null;
    if (!raw) return true;
    const s = JSON.parse(raw)?.state || {};
    return s.loadLastFileOnStartup !== false;
  } catch {
    return true;
  }
}
