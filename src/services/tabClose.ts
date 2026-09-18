/**
 * v0.8.0 WP3 需求8：批量关闭标签的纯函数计算。
 * 只负责"算出要关哪些下标 + 统计未保存数量"，不触碰 DOM / store / window.confirm，
 * 便于单元测试；UI 层拿到下标后再统一确认一次并真正关闭。
 */
import type { TabInfo } from "../stores/useEditorStore";

export type BatchCloseAction =
  | "others" // 关闭其他所有（固定标签豁免，目标标签保留）
  | "othersKeepPinned" // 关闭固定标签页以外所有（即关闭所有未固定）
  | "left" // 关闭左侧所有（固定标签豁免）
  | "right" // 关闭右侧所有（固定标签豁免）
  | "unmodified"; // 关闭所有未修改

/**
 * 计算应当关闭的标签下标（升序）。
 * - 固定标签（pinned）在 others / left / right 中始终豁免（与 VS Code 一致）
 * - unmodified 不受固定豁免影响（固定但已修改的仍可关闭，符合"关闭所有未修改"语义）
 */
export function computeCloseIndices(
  tabs: TabInfo[],
  targetIdx: number,
  action: BatchCloseAction
): number[] {
  const result: number[] = [];
  tabs.forEach((tab, i) => {
    let shouldClose = false;
    switch (action) {
      case "others":
        shouldClose = i !== targetIdx && !tab.pinned;
        break;
      case "othersKeepPinned":
        // 关闭所有未固定（含目标本身，若其未固定）
        shouldClose = !tab.pinned;
        break;
      case "left":
        shouldClose = i < targetIdx && !tab.pinned;
        break;
      case "right":
        shouldClose = i > targetIdx && !tab.pinned;
        break;
      case "unmodified":
        shouldClose = !tab.isDirty;
        break;
    }
    if (shouldClose) result.push(i);
  });
  return result;
}

/** 统计给定下标中处于"未保存（isDirty）"状态的标签数量 */
export function countDirtyTabs(tabs: TabInfo[], indices: number[]): number {
  return indices.reduce((acc, i) => acc + (tabs[i]?.isDirty ? 1 : 0), 0);
}
