/**
 * v0.9.0 WP9：打开文件前的跨窗口冲突判定（纯函数，便于单测）。
 *
 * Rust 侧 `OPEN_FILES` 注册表记录「哪个窗口打开了哪个文件、是否 dirty」。
 * 判定规则（实施计划 N20）：
 * - **只统计其他窗口**：本窗口已打开同一文件属于普通标签切换，不是冲突；
 * - 其他窗口打开同一文件但**都不脏** → 直接打开（同文件多开本身合法，
 *   浏览进度已按窗口隔离）；
 * - 其他窗口存在 **dirty** → 冲突，需弹「只读打开 / 强制编辑 / 切换到已有窗口 / 取消」。
 */

import type { OpenFileRef } from "./windowService";

export interface OpenConflictEvaluation {
  /** 是否需要弹冲突对话框 */
  hasConflict: boolean;
  /** 其他窗口中当前被标记为 dirty 的窗口 label（按 label 排序，稳定可断言） */
  dirtyLabels: string[];
  /** 其他打开同一文件的窗口 label（含非 dirty） */
  otherLabels: string[];
}

/** 判定某文件的跨窗口打开冲突；`selfLabel` 为本窗口 label（自身记录忽略） */
export function evaluateOpenConflict(
  refs: readonly OpenFileRef[],
  selfLabel: string,
): OpenConflictEvaluation {
  const others = refs.filter((r) => r && r.label && r.label !== selfLabel);
  const dirtyLabels = others
    .filter((r) => r.isDirty)
    .map((r) => r.label)
    .sort();
  const otherLabels = others.map((r) => r.label).sort();
  return {
    hasConflict: dirtyLabels.length > 0,
    dirtyLabels,
    otherLabels,
  };
}
