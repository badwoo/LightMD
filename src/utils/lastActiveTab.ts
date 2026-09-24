/**
 * v0.8.3 WP4 需求5：上次会话"活跃标签"的持久化。
 *
 * 背景（bug 根因）：
 * 启动恢复分两阶段——先恢复临时（未落盘）标签，再恢复真实文件；收尾时**写死**
 * "激活第一个恢复成功的真实文件"。当用户关闭前最后停留在临时文件时，重启后被
 * 强制切到真实文件，用户感知为"载入上次打开的文件对临时文件不生效"。
 *
 * 做法：把"上次会话结束时哪个标签是活跃的"记进 localStorage，
 * 恢复完成后优先按该记录定位（临时标签按 id，真实文件按 path）；
 * 记录缺失/失效时回退到既有逻辑（第一个真实文件），保证旧会话数据向后兼容。
 *
 * 键与值都很小（< 100 字节），写入只发生在标签切换 / 窗口关闭前，开销可忽略。
 */

import { safeSetItem } from "./safeStorage";
import type { TabInfo } from "../stores/useEditorStore";

export const LAST_ACTIVE_TAB_KEY = "lightmd-last-active-tab";

/** 持久化的上次活跃标签记录 */
export type StoredLastActiveTab =
  | { kind: "untitled"; id: string }
  | { kind: "file"; path: string };

/**
 * 保存"上次活跃标签"。
 *
 * - 临时（未落盘）标签：记录 `{ kind: "untitled", id }`（path 恒为空串，不能作为标识）
 * - 真实文件：记录 `{ kind: "file", path }`
 * - 无标签 / 无法识别：清除该键（下次启动走回退逻辑）
 */
export function saveLastActiveTab(tab: TabInfo | null | undefined): void {
  try {
    if (!tab) {
      clearLastActiveTab();
      return;
    }
    if (tab.isUntitled) {
      if (!tab.id) {
        clearLastActiveTab();
        return;
      }
      safeSetItem(LAST_ACTIVE_TAB_KEY, JSON.stringify({ kind: "untitled", id: tab.id }));
      return;
    }
    if (!tab.path) {
      clearLastActiveTab();
      return;
    }
    safeSetItem(LAST_ACTIVE_TAB_KEY, JSON.stringify({ kind: "file", path: tab.path }));
  } catch (err) {
    console.warn("[lastActiveTab] 保存失败（忽略）:", err);
  }
}

/** 读取上次活跃标签记录；无记录 / 数据损坏时返回 null */
export function loadLastActiveTab(): StoredLastActiveTab | null {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(LAST_ACTIVE_TAB_KEY) : null;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.kind === "untitled" && typeof parsed.id === "string" && parsed.id) {
      return { kind: "untitled", id: parsed.id };
    }
    if (parsed.kind === "file" && typeof parsed.path === "string" && parsed.path) {
      return { kind: "file", path: parsed.path };
    }
    return null;
  } catch {
    return null;
  }
}

/** 清除上次活跃标签记录（关闭"载入上次打开的文件"开关时调用） */
export function clearLastActiveTab(): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(LAST_ACTIVE_TAB_KEY);
  } catch {
    // 忽略
  }
}

/**
 * 在恢复出来的标签集合中定位"上次活跃标签"的下标。
 *
 * @param stored loadLastActiveTab() 的结果
 * @param tabs 恢复后的 openTabs
 * @returns 命中下标；未命中返回 -1（调用方回退到既有逻辑）
 */
export function resolveLastActiveIndex(
  stored: StoredLastActiveTab | null,
  tabs: ReadonlyArray<Pick<TabInfo, "path" | "isUntitled" | "id">>,
): number {
  if (!stored) return -1;
  if (stored.kind === "untitled") {
    return tabs.findIndex((t) => !!t.isUntitled && t.id === stored.id);
  }
  return tabs.findIndex((t) => !t.isUntitled && t.path === stored.path);
}
