/**
 * v0.9.0 自定义快捷键：默认表回归（原 WP2 应用级绑定表测试升级版）。
 *
 * 目的：
 * 1. 默认表（SHORTCUT_DEFS）与基线表一致，无重复绑定、不落入保留占用；
 * 2. 既有绑定一条都没有被改动（REG-4）；
 * 3. D5 录入校验、冲突检测、生效解析（resolve/matchShortcut）行为正确；
 * 4. settings 持久化 v4 迁移与 setShortcut 写入防御。
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  SHORTCUT_DEFS,
  RESERVED_COMBOS,
  normalizeCombo,
  findDuplicateCombos,
  findShortcutConflict,
  isLegalCombo,
  matchShortcut,
  setShortcutOverrides,
  comboFromEvent,
  effectiveCombo,
  getShortcutLabel,
} from "../core/shortcuts";
import { commands } from "../core/commands";
import { migrateSettings } from "../stores/useSettingsStore";
import { buildMenuItems } from "../components/editor/EditorContextMenu";
import { FORMAT_BUTTONS, formatButtonTitle } from "../components/editor/sourceFormat";

// ─── 构造键盘事件对象 ─────────────────────────────
function kbd(
  key: string,
  opts: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean; code?: string } = {},
) {
  return {
    key,
    code: opts.code,
    ctrlKey: !!opts.ctrl,
    shiftKey: !!opts.shift,
    altKey: !!opts.alt,
    metaKey: !!opts.meta,
  };
}

describe("v0.9.0 自定义快捷键：默认表完整性", () => {
  it("不存在任何重复绑定", () => {
    expect(findDuplicateCombos()).toEqual([]);
  });

  it("默认表与保留占用清单无交叉", () => {
    const reserved = new Set(RESERVED_COMBOS.map((c) => normalizeCombo(c)));
    for (const def of SHORTCUT_DEFS) {
      expect(reserved.has(normalizeCombo(def.defaultCombo)), `${def.id} 落入保留键位`).toBe(false);
    }
  });

  it("48 条可自定义条目按分类登记", () => {
    const byCategory: Record<string, number> = {};
    for (const def of SHORTCUT_DEFS) byCategory[def.category] = (byCategory[def.category] || 0) + 1;
    expect(byCategory).toEqual({ file: 5, edit: 8, format: 15, view: 10, tab: 3, window: 5, insert: 2 });
  });

  it("既有绑定完整保留（REG-4 回归清单）", () => {
    const combos = SHORTCUT_DEFS.map((d) => normalizeCombo(d.defaultCombo));
    for (const expected of [
      "Ctrl+N", "Ctrl+O", "Ctrl+S", "Ctrl+Shift+S", "Ctrl+Shift+E", "Ctrl+,",
      "Ctrl+Z", "Ctrl+Y", "Ctrl+Shift+Z", "Ctrl+F", "Ctrl+H",
      "F6", "Shift+F6", "Ctrl+K",
      "Ctrl+B", "Ctrl+I", "Ctrl+Alt+S", "Ctrl+`", "Ctrl+Shift+M",
      "Ctrl+1", "Ctrl+2", "Ctrl+3", "Ctrl+4", "Ctrl+5", "Ctrl+6", "Ctrl+0",
      "Ctrl+Shift+8", "Ctrl+Shift+9", "Ctrl+Shift+.",
      "Ctrl+Shift+T", "F8", "F9", "Ctrl+Shift+O", "Ctrl+Shift+P", "Ctrl+Alt+V",
      "Ctrl+Tab", "Ctrl+Shift+Tab", "Ctrl+W",
      "Ctrl+Shift+N", "Ctrl+Shift+W", "Ctrl+Alt+O", "Ctrl+Q",
    ]) {
      expect(combos, `缺少绑定 ${expected}`).toContain(normalizeCombo(expected));
    }
  });

  it("D1 已拍板：删除线统一 Ctrl+Alt+S（富文本+源码单条绑定）", () => {
    const defs = SHORTCUT_DEFS.filter((d) => d.id.startsWith("format.strikethrough"));
    expect(defs).toHaveLength(1);
    expect(defs[0].defaultCombo).toBe("Ctrl+Alt+S");
    expect(defs[0].scope).toBe("rich-source");
  });

  it("🆕 新功能条目已登记（折叠/全屏/插入转正）", () => {
    const ids = new Set(SHORTCUT_DEFS.map((d) => d.id));
    for (const id of ["view.toggleLeft", "view.toggleRight", "view.toggleTag", "window.mergeToPrimary", "insert.table", "insert.taskList"]) {
      expect(ids.has(id), `缺少 ${id}`).toBe(true);
    }
    const left = SHORTCUT_DEFS.find((d) => d.id === "view.toggleLeft")!;
    expect(left.defaultCombo).toBe("Ctrl+Alt+ArrowLeft");
    expect(left.editableGate).toBe(true);
    // F11 全屏为 🔒 保留项，不进自定义表
    expect(ids.has("window.full")).toBe(false);
    expect(RESERVED_COMBOS.map((c) => normalizeCombo(c))).toContain("F11");
    // 文件树等效关闭键 v0.9.0 由 Ctrl+2 改为 Backspace
    expect(RESERVED_COMBOS.map((c) => normalizeCombo(c))).toContain("Backspace");
    expect(RESERVED_COMBOS.map((c) => normalizeCombo(c))).not.toContain("Ctrl+2");
  });

  it("归一化对修饰键顺序与字母大小写不敏感", () => {
    expect(normalizeCombo("Shift+Ctrl+N")).toBe("Ctrl+Shift+N");
    expect(normalizeCombo("ctrl+shift+n")).toBe("Ctrl+Shift+N");
    expect(normalizeCombo("Ctrl+Shift+Tab")).toBe("Ctrl+Shift+Tab");
  });

  it("命令面板中的窗口命令快捷键与默认表一致", () => {
    for (const [id, combo] of [
      ["window.new", "Ctrl+Shift+N"],
      ["window.close", "Ctrl+Shift+W"],
      ["window.openInNew", "Ctrl+Alt+O"],
      ["window.quit", "Ctrl+Q"],
    ] as const) {
      const cmd = commands.find((c) => c.id === id);
      expect(cmd, `${id} 未注册`).toBeTruthy();
      expect(normalizeCombo(cmd?.shortcut ?? "")).toBe(combo);
      const def = SHORTCUT_DEFS.find((d) => d.id === id)!;
      expect(normalizeCombo(def.defaultCombo)).toBe(combo);
    }
  });
});

describe("v0.9.0 自定义快捷键：D5 录入校验（isLegalCombo）", () => {
  it("F1~F12 可裸绑", () => {
    expect(isLegalCombo("F5")).toBe(true);
    expect(isLegalCombo("F12")).toBe(true);
    expect(isLegalCombo("F6")).toBe(true);
  });

  it("带 Ctrl/Alt/Meta 修饰的任意键可绑", () => {
    expect(isLegalCombo("Ctrl+J")).toBe(true);
    expect(isLegalCombo("Alt+T")).toBe(true);
    expect(isLegalCombo("Ctrl+Alt+T")).toBe(true);
    expect(isLegalCombo("Ctrl+Shift+8")).toBe(true);
    expect(isLegalCombo("Ctrl+,")).toBe(true);
  });

  it("裸字母/数字/符号与 Shift+字母 拒绝（吞正常输入）", () => {
    expect(isLegalCombo("T")).toBe(false);
    expect(isLegalCombo("Shift+T")).toBe(false);
    expect(isLegalCombo("1")).toBe(false);
    expect(isLegalCombo("Shift+1")).toBe(false);
    expect(isLegalCombo("`")).toBe(false);
  });

  it("非 F 键的功能键裸绑拒绝", () => {
    expect(isLegalCombo("Enter")).toBe(false);
    expect(isLegalCombo("Escape")).toBe(false);
    expect(isLegalCombo("ArrowLeft")).toBe(false);
  });
});

describe("v0.9.0 自定义快捷键：冲突检测（findShortcutConflict）", () => {
  beforeEach(() => setShortcutOverrides({}));

  it("与其他条目默认键位冲突 → type=def", () => {
    expect(findShortcutConflict("file.new", "Ctrl+S")).toEqual({ type: "def", id: "file.save" });
  });

  it("落入保留占用 → type=reserved", () => {
    expect(findShortcutConflict("file.new", "Ctrl+R")).toEqual({ type: "reserved", combo: "Ctrl+R" });
    expect(findShortcutConflict("file.new", "F11")).toEqual({ type: "reserved", combo: "F11" });
    expect(findShortcutConflict("file.new", "Backspace")).toEqual({ type: "reserved", combo: "Backspace" });
  });

  it("违反 D5 → type=illegal", () => {
    expect(findShortcutConflict("file.new", "Shift+T")).toEqual({ type: "illegal" });
  });

  it("用户覆盖后按生效键位查重（默认值让位给覆盖）", () => {
    setShortcutOverrides({ "file.save": "Ctrl+J" });
    // Ctrl+S 已被 file.save 的覆盖让出 → file.new 可绑
    expect(findShortcutConflict("file.new", "Ctrl+S")).toBeNull();
    // Ctrl+J 被 file.save 覆盖占用 → 拒绝
    expect(findShortcutConflict("file.new", "Ctrl+J")).toEqual({ type: "def", id: "file.save" });
  });

  it("同 id 重绑自身当前键位不算冲突", () => {
    expect(findShortcutConflict("file.save", "Ctrl+J")).toBeNull();
  });
});

describe("v0.9.0 自定义快捷键：生效解析（matchShortcut / comboFromEvent）", () => {
  beforeEach(() => setShortcutOverrides({}));

  it("按作用域匹配：global 只匹配 global", () => {
    expect(matchShortcut(kbd("s", { ctrl: true }), ["global"])?.id).toBe("file.save");
    // format.bold 属 rich-source，全局维度不匹配
    expect(matchShortcut(kbd("b", { ctrl: true }), ["global"])).toBeUndefined();
  });

  it("全修饰键精确相等：Ctrl+S 不误触 Ctrl+Alt+S", () => {
    expect(matchShortcut(kbd("s", { ctrl: true, alt: true }), ["global", "editor"])).toBeUndefined();
  });

  it("editor 维度匹配 undo/redo（global-editor）", () => {
    expect(matchShortcut(kbd("z", { ctrl: true }), ["editor"])?.id).toBe("edit.undo");
    expect(matchShortcut(kbd("Z", { ctrl: true, shift: true }), ["editor"])?.id).toBe("edit.redo2");
    expect(matchShortcut(kbd("y", { ctrl: true }), ["editor"])?.id).toBe("edit.redo");
  });

  it("rich/source 维度匹配格式键", () => {
    expect(matchShortcut(kbd("b", { ctrl: true }), ["rich"])?.id).toBe("format.bold");
    expect(matchShortcut(kbd("s", { ctrl: true, alt: true }), ["rich"])?.id).toBe("format.strikethrough");
    expect(matchShortcut(kbd("s", { ctrl: true, alt: true }), ["source"])?.id).toBe("format.strikethrough");
    expect(matchShortcut(kbd("m", { ctrl: true, shift: true }), ["source"])?.id).toBe("format.math");
    expect(matchShortcut(kbd("m", { ctrl: true, shift: true }), ["rich"])).toBeUndefined();
  });

  it("Ctrl+Shift+数字 按 e.code 还原主键（Shift+8 产出 * 不影响匹配）", () => {
    expect(matchShortcut(kbd("*", { ctrl: true, shift: true, code: "Digit8" }), ["rich"])?.id).toBe("format.bulletList");
    expect(matchShortcut(kbd("(", { ctrl: true, shift: true, code: "Digit9" }), ["rich"])?.id).toBe("format.orderedList");
    expect(comboFromEvent(kbd("*", { ctrl: true, shift: true, code: "Digit8" }))).toBe("Ctrl+Shift+8");
  });

  it("修饰键自身按下不构成组合", () => {
    expect(comboFromEvent(kbd("Control", { ctrl: true }))).toBeNull();
    expect(comboFromEvent(kbd("Shift", { shift: true }))).toBeNull();
  });

  it("用户覆盖后按生效键位匹配", () => {
    setShortcutOverrides({ "file.save": "Ctrl+J" });
    expect(matchShortcut(kbd("j", { ctrl: true }), ["global"])?.id).toBe("file.save");
    expect(matchShortcut(kbd("s", { ctrl: true }), ["global"])).toBeUndefined();
    expect(getShortcutLabel("file.save")).toBe("Ctrl+J");
  });

  it("Ctrl 与 Meta 等价（Mod 语义）", () => {
    expect(matchShortcut(kbd("k", { meta: true }), ["global"])?.id).toBe("ai.chat");
  });

  it("effectiveCombo 覆盖优先", () => {
    const def = SHORTCUT_DEFS.find((d) => d.id === "file.new")!;
    expect(effectiveCombo(def)).toBe("Ctrl+N");
    setShortcutOverrides({ "file.new": "Ctrl+Alt+N" });
    expect(effectiveCombo(def)).toBe("Ctrl+Alt+N");
    setShortcutOverrides({});
  });
});

describe("v0.9.0 自定义快捷键：settings v4 迁移", () => {
  it("v3 旧数据迁移后 shortcuts 归一为 {}", () => {
    const migrated = migrateSettings({ theme: "dark", shortcuts: undefined }, 3);
    expect(migrated.shortcuts).toEqual({});
  });

  it("非法 shortcuts 值（数组/字符串）归一为 {}", () => {
    expect(migrateSettings({ shortcuts: ["x"] }, 4).shortcuts).toEqual({});
    expect(migrateSettings({ shortcuts: "x" }, 4).shortcuts).toEqual({});
  });

  it("未登记 id 与非法值被过滤", () => {
    const migrated = migrateSettings(
      { shortcuts: { "file.new": "Ctrl+Alt+N", "hack.id": "Ctrl+H", "file.open": 123 } },
      4,
    );
    expect(migrated.shortcuts).toEqual({ "file.new": "Ctrl+Alt+N" });
  });
});

describe("v0.9.0 自定义快捷键：A8 展示点动态化", () => {
  it("右键菜单显示生效键位（改键后跟随变化）", () => {
    const undo = buildMenuItems(true, true, true).find((i) => i.action === "undo");
    expect(undo?.shortcut).toBe("Ctrl+Z");
    setShortcutOverrides({ "edit.undo": "Ctrl+Shift+U" });
    const undo2 = buildMenuItems(true, true, true).find((i) => i.action === "undo");
    expect(undo2?.shortcut).toBe("Ctrl+Shift+U");
    setShortcutOverrides({});
  });

  it("D1：删除线右键菜单显示统一后的 Ctrl+Alt+S", () => {
    const strikethrough = buildMenuItems(true, true, true).find((i) => i.action === "strikethrough");
    expect(strikethrough?.shortcut).toBe("Ctrl+Alt+S");
  });

  it("工具栏 tooltip 动态拼接生效键位", () => {
    const undoBtn = FORMAT_BUTTONS.find((b) => b.action === "undo")!;
    expect(formatButtonTitle(undoBtn)).toBe("撤销 (Ctrl+Z)");
    setShortcutOverrides({ "edit.undo": "Ctrl+Shift+U" });
    expect(formatButtonTitle(undoBtn)).toBe("撤销 (Ctrl+Shift+U)");
    // 无键位条目只显示基础文案
    const imageBtn = FORMAT_BUTTONS.find((b) => b.action === "image")!;
    expect(formatButtonTitle(imageBtn)).toBe("图片");
    setShortcutOverrides({});
  });
});
