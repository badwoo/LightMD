/**
 * v0.9.0 自定义快捷键：设置入口（A1）+ 弹窗接线（A2 的渲染侧）。
 *
 * 此前 `data-testid="shortcuts-entry"` 在整个测试集中无人引用，
 * A1「设置→编辑器→最后一栏出现自定义快捷键入口」仅靠人工检查。
 * 本用例补上组件级断言：入口存在、位于「编辑器」分区最后一个字段、点击可打开弹窗、
 * 弹窗按分类渲染全部 48 条。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

// ─── mocks（必须在 import 组件之前） ───────────────────────
vi.mock("../services/translateService", () => ({
  translateService: {
    setKey: vi.fn(),
    hasKey: vi.fn(async () => false),
    testConnection: vi.fn(),
    listModels: vi.fn(async () => []),
  },
}));

import { SettingsDialog } from "../components/dialogs/SettingsDialog";
import { useSettingsStore } from "../stores/useSettingsStore";

afterEach(() => {
  cleanup();
  useSettingsStore.setState({ shortcuts: {} });
});

describe("v0.9.0 A1：设置弹窗内的自定义快捷键入口", () => {
  it("入口存在且是「编辑器」分区的最后一个字段，点击后打开快捷键弹窗", () => {
    render(<SettingsDialog onClose={() => {}} />);
    const entry = screen.getByTestId("shortcuts-entry");
    expect(entry).toBeTruthy();

    // 「编辑器」分区 = 含「自动配对」字段的那个 section
    const section = entry.closest("section");
    expect(section).toBeTruthy();
    expect(section!.textContent).toContain("自动配对");
    const fields = section!.querySelectorAll(".settings-field");
    expect(fields[fields.length - 1].contains(entry)).toBe(true);

    // 点击入口 → 弹出快捷键弹窗（48 行 + 搜索框）
    fireEvent.click(entry);
    expect(document.querySelector(".shortcut-settings-dialog")).toBeTruthy();
    expect(document.querySelectorAll(".shortcut-settings-row").length).toBe(48);
    expect(document.querySelector(".shortcut-settings-search")).toBeTruthy();
  });

  it("弹窗分组顺序为 文件→编辑→格式→视图→标签→窗口→插入", () => {
    render(<SettingsDialog onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("shortcuts-entry"));
    const groups = [...document.querySelectorAll(".shortcut-settings-group h3")].map(
      (el) => el.textContent,
    );
    expect(groups).toEqual(["文件", "编辑", "格式", "视图", "标签", "窗口", "插入"]);
  });
});
