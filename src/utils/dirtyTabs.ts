/**
 * v0.9.0：关闭窗口 / 退出应用前的「未保存确认」判定。
 *
 * ## 为什么临时标签不参与确认
 *
 * 临时（未命名）标签的内容由**窗口级 localStorage 自动记忆**（`lightmd-untitled-tabs`
 * 及其 `-sec-N` 变体），下次启动会原样恢复；它们也不参与版本快照。因此关闭软件时
 * 拦截用户没有意义，反而多一次打扰（v0.9.0 用户反馈）。
 *
 * 只有**已落盘（有真实路径）且编辑未保存**的文件才需要确认——这类改动一旦丢失
 * 就无法找回。
 */

import type { TabInfo } from "../stores/useEditorStore";

/** 需要「关闭前确认」的标签：已落盘 + 有未保存修改 */
export function tabsNeedingCloseConfirm(tabs: readonly TabInfo[]): TabInfo[] {
  return tabs.filter((tb) => !!tb.isDirty && !tb.isUntitled && !!tb.path);
}

/** 是否存在需要确认的标签（避免每次都为判断构造数组） */
export function hasUnsavedPersistedTabs(tabs: readonly TabInfo[]): boolean {
  return tabs.some((tb) => !!tb.isDirty && !tb.isUntitled && !!tb.path);
}

/**
 * 批量保存的目标集合：与确认集合一致（已落盘 + 未保存）。
 * 临时标签不在其中——它们不需要用户决策，且「保存全部」时弹另存为对话框会打断
 * 关闭流程（用户可能只想直接退出）。
 */
export function tabsToSaveBeforeClose(tabs: readonly TabInfo[]): TabInfo[] {
  return tabsNeedingCloseConfirm(tabs);
}
