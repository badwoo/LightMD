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
import { SHORTCUT_COLUMN_LAYOUT } from "../components/dialogs/ShortcutSettingsDialog";
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
    expect(document.querySelectorAll(".shortcut-settings-row").length).toBe(50);
    expect(document.querySelector(".shortcut-settings-search")).toBeTruthy();
  });

  it("弹窗按横向 3×3 分列渲染：7 个分类各出现一次，每列不超过 3 张分类卡片（v0.9.1 需求4）", () => {
    render(<SettingsDialog onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("shortcuts-entry"));
    const categoryLabel: Record<string, string> = {
      file: "文件", edit: "编辑", format: "格式", view: "视图",
      tab: "标签", window: "窗口", insert: "插入",
    };
    const expectedOrder = SHORTCUT_COLUMN_LAYOUT.flat().map((c) => categoryLabel[c]);
    const groups = [...document.querySelectorAll(".shortcut-settings-group h3")].map(
      (el) => el.textContent,
    );
    // DOM 顺序 = 分列方案的自左而右、列内自上而下（视觉阅读顺序）
    expect(groups).toEqual(expectedOrder);
    expect(new Set(groups).size).toBe(7);

    const columns = [...document.querySelectorAll(".shortcut-settings-column")];
    expect(columns.length).toBe(3);
    for (const col of columns) {
      const cards = col.querySelectorAll(".shortcut-settings-group").length;
      expect(cards).toBeGreaterThan(0);
      expect(cards).toBeLessThanOrEqual(3); // 3×3 的"3 层"上限
    }
  });
});
