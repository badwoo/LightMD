/**
 * v0.9.0 WP2：快捷键绑定表回归。
 *
 * 目的：确保 v0.9.0 新增的三条窗口快捷键**不与任何既有应用级快捷键冲突**
 * （历史上 PRD 误判 Ctrl+Shift+O 空闲，实际已被大纲栏占用 —— 实施计划 F9），
 * 且既有绑定一条都没有被改动（REG-4）。
 */
import { describe, it, expect } from "vitest";
import {
  APP_SHORTCUTS,
  normalizeCombo,
  findDuplicateCombos,
  type ShortcutBinding,
} from "../core/shortcuts";
import { commands } from "../core/commands";

describe("v0.9.0 WP2：应用级快捷键绑定表", () => {
  it("不存在任何重复绑定", () => {
    expect(findDuplicateCombos()).toEqual([]);
  });

  it("新增的窗口快捷键已在表中且标记 since090", () => {
    const added = APP_SHORTCUTS.filter((s) => s.since090).map((s) => normalizeCombo(s.combo));
    expect(added).toEqual(["Ctrl+Shift+N", "Ctrl+Shift+W", "Ctrl+Alt+O", "Ctrl+Q"]);
  });

  it("新增快捷键与既有绑定无冲突（逐条核对）", () => {
    const existing = APP_SHORTCUTS.filter((s) => !s.since090).map((s) => normalizeCombo(s.combo));
    for (const added of ["Ctrl+Shift+N", "Ctrl+Shift+W", "Ctrl+Alt+O", "Ctrl+Q"]) {
      expect(existing).not.toContain(added);
    }
  });

  it("Ctrl+Shift+O 归大纲栏，不被窗口功能抢走", () => {
    const entry = APP_SHORTCUTS.find((s) => normalizeCombo(s.combo) === "Ctrl+Shift+O");
    expect(entry?.action).toBe("切换大纲栏");
  });

  it("既有绑定完整保留（REG-4 回归清单）", () => {
    const combos = APP_SHORTCUTS.map((s) => normalizeCombo(s.combo));
    for (const expected of [
      "Ctrl+N",
      "Ctrl+O",
      "Ctrl+S",
      "Ctrl+Shift+S",
      "Ctrl+Shift+E",
      "Ctrl+,",
      "Ctrl+Z",
      "Ctrl+Y",
      "Ctrl+F",
      "Ctrl+H",
      "F6",
      "Shift+F6",
      "Ctrl+K",
      "Ctrl+Shift+T",
      "F8",
      "F9",
      "Ctrl+Shift+O",
      "Ctrl+Shift+P",
      "Ctrl+Alt+V",
      "Ctrl+Tab",
      "Ctrl+Shift+Tab", // 同一 Tab 键的 Shift 变体独立成项
      "Ctrl+W",
    ]) {
      expect(combos, `缺少绑定 ${expected}`).toContain(normalizeCombo(expected));
    }
  });

  it("归一化对修饰键顺序与字母大小写不敏感", () => {
    expect(normalizeCombo("Shift+Ctrl+N")).toBe("Ctrl+Shift+N");
    expect(normalizeCombo("ctrl+shift+n")).toBe("Ctrl+Shift+N");
    expect(normalizeCombo("Ctrl+Alt+O")).toBe("Ctrl+Alt+O");
    expect(normalizeCombo("Ctrl+Shift+Tab")).toBe("Ctrl+Shift+Tab");
  });

  it("命令面板中的窗口命令快捷键与绑定表一致", () => {
    for (const [id, combo] of [
      ["window.new", "Ctrl+Shift+N"],
      ["window.close", "Ctrl+Shift+W"],
      ["window.openInNew", "Ctrl+Alt+O"],
      ["window.quit", "Ctrl+Q"],
    ] as const) {
      const cmd = commands.find((c) => c.id === id);
      expect(cmd, `${id} 未注册`).toBeTruthy();
      expect(normalizeCombo(cmd?.shortcut ?? "")).toBe(combo);
    }
  });

  it("命令面板中不存在重复快捷键（跨分组）", () => {
    const withShortcut = commands.filter((c) => c.shortcut);
    const normalized = withShortcut.map((c) => normalizeCombo(c.shortcut!));
    expect(new Set(normalized).size).toBe(normalized.length);
  });
});
