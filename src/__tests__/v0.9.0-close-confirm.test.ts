/**
 * v0.9.0 用户反馈修复的回归用例。
 *
 * 三个问题的根因与断言：
 * 1. **已关闭的窗口在重启后复活** —— 会话快照必须只记录「退出时仍存活的窗口」；
 *    「恢复其他窗口」开关决定是否连同辅助窗口一起还原。
 * 2. **保存后误报「文件已被外部修改」** —— 应用自身写盘必须被 watcher 去重，
 *    否则保存 → 误判 → 覆盖 → 再误判，形成无限黄色提示；
 *    改名/移动产生的「移出」事件也不能当成删除。
 * 3. **临时标签触发关闭确认** —— 关闭/退出确认只针对「已落盘且未保存」的文件。
 */
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import {
  tabsNeedingCloseConfirm,
  hasUnsavedPersistedTabs,
  tabsToSaveBeforeClose,
} from "../utils/dirtyTabs";
import type { TabInfo } from "../stores/useEditorStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { __setWindowLabelForTest } from "../utils/windowLabel";

function fileTab(path: string, dirty: boolean): TabInfo {
  return { path, name: path.split("/").pop() || "x.md", content: "c", isDirty: dirty };
}
function untitledTab(id: string, dirty: boolean): TabInfo {
  return { id, path: "", name: `新文件${id}`, content: "c", isUntitled: true, isDirty: dirty };
}

afterEach(() => __setWindowLabelForTest(null));

describe("修复 3：关闭确认只针对已落盘且未保存的文件", () => {
  it("临时标签（即使有内容）不触发关闭确认", () => {
    const tabs = [untitledTab("untitled-1", true), untitledTab("untitled-2", true)];
    expect(tabsNeedingCloseConfirm(tabs)).toEqual([]);
    expect(hasUnsavedPersistedTabs(tabs)).toBe(false);
  });

  it("已落盘且未保存 → 需要确认", () => {
    const tabs = [fileTab("D:/a.md", true)];
    expect(tabsNeedingCloseConfirm(tabs)).toHaveLength(1);
    expect(hasUnsavedPersistedTabs(tabs)).toBe(true);
  });

  it("已落盘但已保存 → 不确认", () => {
    expect(tabsNeedingCloseConfirm([fileTab("D:/a.md", false)])).toEqual([]);
  });

  it("混合场景：只挑出落盘未保存的那个（用户报告的核心场景）", () => {
    const tabs = [
      untitledTab("untitled-1", true), // 临时文件（下次会恢复，不提示）
      fileTab("D:/saved.md", false), // 已保存（不提示）
      fileTab("D:/dirty.md", true), // 落盘未保存（提示）
    ];
    const need = tabsNeedingCloseConfirm(tabs);
    expect(need).toHaveLength(1);
    expect(need[0].path).toBe("D:/dirty.md");
    expect(tabsToSaveBeforeClose(tabs)).toEqual(need);
  });

  it("isUntitled 但带路径的异常数据仍按临时标签处理（不提示）", () => {
    const odd: TabInfo = { path: "D:/x.md", name: "x.md", isUntitled: true, isDirty: true };
    expect(tabsNeedingCloseConfirm([odd])).toEqual([]);
  });

  it("空集合安全", () => {
    expect(tabsNeedingCloseConfirm([])).toEqual([]);
    expect(hasUnsavedPersistedTabs([])).toBe(false);
  });
});

describe("修复 1：「恢复其他窗口」开关", () => {
  it("默认关闭（只恢复主窗口，行为最保守）", () => {
    expect(useSettingsStore.getState().restoreOtherWindows).toBe(false);
  });

  it("可开启/关闭并持久化到设置 state", () => {
    useSettingsStore.getState().setRestoreOtherWindows(true);
    expect(useSettingsStore.getState().restoreOtherWindows).toBe(true);
    useSettingsStore.getState().setRestoreOtherWindows(false);
    expect(useSettingsStore.getState().restoreOtherWindows).toBe(false);
  });

  it("开关与「外部文件打开方式」相互独立", () => {
    useSettingsStore.getState().setRestoreOtherWindows(true);
    useSettingsStore.getState().setOpenExternalFileIn("newWindow");
    expect(useSettingsStore.getState().restoreOtherWindows).toBe(true);
    expect(useSettingsStore.getState().openExternalFileIn).toBe("newWindow");
    useSettingsStore.getState().setOpenExternalFileIn("currentWindow");
    useSettingsStore.getState().setRestoreOtherWindows(false);
  });
});
