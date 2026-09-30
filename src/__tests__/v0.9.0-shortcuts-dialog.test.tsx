/**
 * v0.9.0 自定义快捷键：ShortcutSettingsDialog 组件测试（验收 A2/A3/A4/A6）。
 *
 * 覆盖：
 * - A2：按分类渲染全部 48 条可自定义条目 + 搜索过滤；
 * - A3：录制态按物理键盘组合录入成功（写入 store + 运行时生效）；
 * - A4：冲突（其他条目占用 / 保留键 / D5 违规）显示错误且不写入；
 * - A6：Backspace 清除单条绑定、恢复全部默认设置。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ShortcutSettingsDialog } from "../components/dialogs/ShortcutSettingsDialog";
import { useSettingsStore } from "../stores/useSettingsStore";
import { getShortcutLabel, setShortcutOverrides } from "../core/shortcuts";

/** 构造 window keydown 事件（fireEvent 包装 act，确保 React 状态同步刷入 DOM） */
function pressKey(init: {
  key: string; code?: string; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean;
}) {
  fireEvent.keyDown(window, init);
}

function openDialog() {
  render(<ShortcutSettingsDialog onClose={() => {}} />);
}

function rowByLabel(label: string): HTMLElement {
  const rows = screen.getAllByText(label);
  expect(rows.length).toBeGreaterThan(0);
  return rows[0].closest(".shortcut-settings-row") as HTMLElement;
}

beforeEach(() => {
  useSettingsStore.setState({ shortcuts: {} });
  setShortcutOverrides({});
});

afterEach(() => {
  cleanup();
  useSettingsStore.setState({ shortcuts: {} });
  setShortcutOverrides({});
});

describe("v0.9.0 ShortcutSettingsDialog：渲染与搜索（A2）", () => {
  it("按分类渲染全部 48 条可自定义条目", () => {
    openDialog();
    for (const label of ["新建文件", "保存文件", "另存为", "撤销", "加粗", "删除线", "标题 4",
      "命令面板", "左侧栏展开/收缩", "标签栏展开/收缩", "下一个标签", "新建窗口", "插入表格"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    const rows = document.querySelectorAll(".shortcut-settings-row");
    expect(rows.length).toBe(48);
  });

  it("搜索框按功能名过滤", () => {
    openDialog();
    const search = document.querySelector(".shortcut-settings-search") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "删除线" } });
    expect(document.querySelectorAll(".shortcut-settings-row").length).toBe(1);
    expect(screen.getByText("删除线")).toBeTruthy();
  });
});

describe("v0.9.0 ShortcutSettingsDialog：录制与冲突（A3/A4）", () => {
  it("点击条目进入录制态，按组合键成功录入并即时生效", () => {
    openDialog();
    fireEvent.click(rowByLabel("新建文件"));
    expect(document.querySelector(".shortcut-settings-recording-pill")).toBeTruthy();
    pressKey({ key: "j", ctrlKey: true });
    // 退出录制态 + store 写入 + 运行时生效
    expect(document.querySelector(".shortcut-settings-recording-pill")).toBeNull();
    expect(useSettingsStore.getState().shortcuts["file.new"]).toBe("Ctrl+J");
    expect(getShortcutLabel("file.new")).toBe("Ctrl+J");
  });

  it("冲突：绑定到其他条目键位显示占用提示且不写入", () => {
    openDialog();
    fireEvent.click(rowByLabel("新建文件"));
    pressKey({ key: "s", ctrlKey: true }); // Ctrl+S 已被「保存文件」占用
    const errors = document.querySelectorAll(".shortcut-settings-error");
    expect(errors.length).toBe(1);
    expect(errors[0].textContent).toContain("保存文件");
    expect(useSettingsStore.getState().shortcuts["file.new"]).toBeUndefined();
  });

  it("保留键（Backspace 录入场景之外如 Ctrl+R）提示系统保留", () => {
    openDialog();
    fireEvent.click(rowByLabel("新建文件"));
    pressKey({ key: "r", ctrlKey: true });
    expect(document.querySelector(".shortcut-settings-error")?.textContent).toContain("保留");
    expect(useSettingsStore.getState().shortcuts["file.new"]).toBeUndefined();
  });

  it("D5 违规：裸字母键拒绝录入", () => {
    openDialog();
    fireEvent.click(rowByLabel("新建文件"));
    pressKey({ key: "t", shiftKey: true }); // Shift+t ≡ 输入大写 T
    expect(document.querySelector(".shortcut-settings-error")?.textContent).toContain("Ctrl");
    expect(useSettingsStore.getState().shortcuts["file.new"]).toBeUndefined();
  });

  it("Esc 取消录制不修改；Backspace 清除绑定恢复默认", () => {
    useSettingsStore.getState().setShortcut("file.new", "Ctrl+J");
    expect(useSettingsStore.getState().shortcuts["file.new"]).toBe("Ctrl+J");
    openDialog();
    fireEvent.click(rowByLabel("新建文件"));
    pressKey({ key: "Escape" });
    expect(document.querySelector(".shortcut-settings-recording-pill")).toBeNull();
    expect(useSettingsStore.getState().shortcuts["file.new"]).toBe("Ctrl+J");
    // 再次录制 → Backspace 清除
    fireEvent.click(rowByLabel("新建文件"));
    pressKey({ key: "Backspace" });
    expect(useSettingsStore.getState().shortcuts["file.new"]).toBeUndefined();
    expect(getShortcutLabel("file.new")).toBe("Ctrl+N");
  });
});

describe("v0.9.0 ShortcutSettingsDialog：恢复默认（A6）", () => {
  it("恢复全部默认设置清空全部自定义", () => {
    useSettingsStore.getState().setShortcut("file.new", "Ctrl+J");
    useSettingsStore.getState().setShortcut("file.save", "Ctrl+Shift+J");
    expect(Object.keys(useSettingsStore.getState().shortcuts).length).toBe(2);
    openDialog();
    fireEvent.click(screen.getByText("恢复全部默认设置"));
    expect(useSettingsStore.getState().shortcuts).toEqual({});
    expect(getShortcutLabel("file.new")).toBe("Ctrl+N");
    expect(getShortcutLabel("file.save")).toBe("Ctrl+S");
  });
});
