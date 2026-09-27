/**
 * v0.9.0 WP3/WP8：窗口槽位（label）的生命周期辅助。
 *
 * Rust 侧采用**固定槽位** label（`sec-1`~`sec-7`）：窗口关闭释放槽位，新建窗口
 * 复用最小空闲槽位。槽位复用意味着上一轮该槽位遗留的窗口级 localStorage 数据
 * 会被新窗口读到（表现为"新建窗口里冒出上次的临时文件"）。
 *
 * 因此「全新分配的槽位」（`WindowBoot.fresh === true`）在挂载时必须清一次残留。
 * **Primary（main）绝不清理**：它的窗口级 key 是无后缀的 v0.8.5 旧 key，清掉等于
 * 丢掉老用户的临时标签/滚动进度/浏览位置。
 */

import { MAIN_WINDOW_LABEL } from "./windowLabel";
import { clearUntitledTabsForLabel } from "./untitledTabs";
import { clearLastActiveTabForLabel } from "./lastActiveTab";
import { clearScrollProgressForLabel } from "../services/fileScrollProgress";
import { safeSetItem } from "./safeStorage";

/** 窗口级「当前内容」scratch key（`lightmd-content` 的窗口级变体） */
export const CONTENT_KEY_BASE = "lightmd-content";
/** 窗口级「最近打开的文件路径」key（`lightmd-last-file` 的窗口级变体） */
export const LAST_FILE_KEY_BASE = "lightmd-last-file";

/**
 * 清理某槽位遗留的窗口级 localStorage 数据。
 *
 * @param label 目标槽位 label；`main` 时直接返回（保护 v0.8.5 旧数据）
 */
export function clearSlotResidue(label: string): void {
  if (label === MAIN_WINDOW_LABEL) return;
  clearUntitledTabsForLabel(label);
  clearLastActiveTabForLabel(label);
  clearScrollProgressForLabel(label);
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(`${CONTENT_KEY_BASE}-${label}`);
    localStorage.removeItem(`${LAST_FILE_KEY_BASE}-${label}`);
    // v0.9.0：迁移中转载荷（「移动到新窗口」的大内容走 localStorage 中转）
    for (const key of migrationKeys()) {
      if (key.includes(`-${label}-`)) localStorage.removeItem(key);
    }
  } catch {
    // 忽略清理失败（隐私模式/配额）
  }
}

function migrationKeys(): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("lightmd-move-payload-")) keys.push(k);
    }
  } catch {
    // 忽略
  }
  return keys;
}

/** 读取本窗口的 scratch 内容（无则空串） */
export function readWindowContent(key: string): string {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(key) || "" : "";
  } catch {
    return "";
  }
}

/** 写入本窗口的 scratch 内容 */
export function writeWindowContent(key: string, value: string): void {
  safeSetItem(key, value);
}
