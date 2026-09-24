/**
 * v0.8.3 WP4 需求6：标签的「持久化键」——浏览进度（fileScrollProgress）的键。
 *
 * 为什么需要它：
 * 旧实现的进度键就是文件路径，导致
 * 1. 临时（未落盘）标签的 path 恒为空串 → 进度从未被记录（fileScrollProgress
 *    对空 path 直接 return）；
 * 2. 关闭标签 / 重新打开文件时无法按"标签"维度清理。
 *
 * 约定（读写两侧必须一致，单源在此）：
 * - 真实文件：`<path>`（保持旧数据兼容，历史 localStorage 快照可直接复用）
 * - 临时标签：`untitled:<id>`
 */

import type { TabInfo } from "../stores/useEditorStore";

/** 临时标签进度键前缀 */
export const UNTITLED_PROGRESS_PREFIX = "untitled:";

/**
 * 计算单个标签的进度键。
 *
 * @param tab 标签对象（只需 path / isUntitled / id）
 * @param fallbackIdx 临时标签无 id 时的兜底序号（与侧栏 activeItemKey 的兜底一致）
 * @returns 进度键；无路径且无 id 时返回 null（调用方跳过读写）
 */
export function tabProgressKey(
  tab: Pick<TabInfo, "path" | "isUntitled" | "id"> | null | undefined,
  fallbackIdx = 0,
): string | null {
  if (!tab) return null;
  if (tab.isUntitled) return `${UNTITLED_PROGRESS_PREFIX}${tab.id ?? fallbackIdx}`;
  return tab.path || null;
}

/** 计算标签数组对应的全部进度键（用于快照落盘） */
export function tabsProgressKeys(
  tabs: ReadonlyArray<Pick<TabInfo, "path" | "isUntitled" | "id">>,
): string[] {
  const keys: string[] = [];
  for (let i = 0; i < tabs.length; i++) {
    const key = tabProgressKey(tabs[i], i);
    if (key) keys.push(key);
  }
  return keys;
}

/** 临时标签的进度键（关闭临时标签 / 晋升为正式文件时清理旧键） */
export function untitledProgressKey(id: string | undefined): string | null {
  return id ? `${UNTITLED_PROGRESS_PREFIX}${id}` : null;
}
