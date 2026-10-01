/**
 * v0.9.0 自定义快捷键：**review 修复回归用例**（2026-09-30 代码评审后补）。
 *
 * 覆盖评审发现的历史缺陷，防止回退：
 * 1. 默认表与基线表**逐行**一致（WP0 验收「默认表与基线表逐项一致」此前只查了条数）；
 * 2. i18n 单花括号占位符（`{{name}}` 会渲染出多余花括号）；
 * 3. AltGr（右 Alt）不得参与快捷键匹配，否则德语/波兰语 AltGr+S 会吞掉输入字符；
 * 4. 非拉丁布局（俄语 Ctrl+S → e.key="с"）以 e.code 还原，Ctrl+S 仍能保存；
 * 5. "+" 键必须可表示，且「只剩修饰键」的空绑定必须被拒；
 * 6. 持久化覆盖表清洗（未登记 id / 非法键位 / 保留键 / 互相冲突 / 与默认值相同）；
 * 7. 恢复单项默认键位不得造出重复（不可达）绑定；
 * 8. 双击阈值 220ms 的 210/219/220/230 边界行为。
 *
 * 全部为纯函数/源码读取（node 环境）；store 写入类用例在
 * v0.9.0-shortcuts-dialog.test.tsx（jsdom）内覆盖，避免 jsdom 环境开销。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SHORTCUT_DEFS,
  comboFromEvent,
  findResetCollision,
  isLegalCombo,
  isSystemCombo,
  matchShortcut,
  normalizeCombo,
  sanitizeShortcutOverrides,
  setShortcutOverrides,
} from "../core/shortcuts";
import { evalDoublePress } from "../utils/modeSwitch";
import { commands } from "../core/commands";

/** 以本测试文件目录为基准读源码（不受进程 cwd 影响），p 相对 src/ */
const read = (p: string) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), "utf-8");
/** 读仓库根下的文件（.trae/documents/...） */
const readRoot = (p: string) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), "utf-8");

beforeEach(() => {
  setShortcutOverrides({});
});

// ─── 1. 基线表逐行一致性 ─────────────────────────────

/** 基线表 `.trae/documents/lightmd-v0.9.0-default-shortcuts-baseline.md` 的 ✅ 条目
 *（id → [分类, 默认键位]），作为默认表的独立校验源。 */
const BASELINE: Array<[string, string, string]> = [
  ["file.new", "file", "Ctrl+N"],
  ["file.open", "file", "Ctrl+O"],
  ["file.save", "file", "Ctrl+S"],
  ["file.saveAs", "file", "Ctrl+Shift+S"],
  ["export.html", "file", "Ctrl+Shift+E"],
  ["edit.undo", "edit", "Ctrl+Z"],
  ["edit.redo", "edit", "Ctrl+Y"],
  ["edit.redo2", "edit", "Ctrl+Shift+Z"],
  ["edit.find", "edit", "Ctrl+F"],
  ["edit.replace", "edit", "Ctrl+H"],
  ["edit.translate", "edit", "F6"],
  ["edit.translateDocument", "edit", "Shift+F6"],
  ["ai.chat", "edit", "Ctrl+K"],
  ["format.bold", "format", "Ctrl+B"],
  ["format.italic", "format", "Ctrl+I"],
  ["format.strikethrough", "format", "Ctrl+Alt+S"],
  ["format.inlineCode", "format", "Ctrl+`"],
  ["format.math", "format", "Ctrl+Shift+M"],
  ["format.heading1", "format", "Ctrl+1"],
  ["format.heading2", "format", "Ctrl+2"],
  ["format.heading3", "format", "Ctrl+3"],
  ["format.heading4", "format", "Ctrl+4"],
  ["format.heading5", "format", "Ctrl+5"],
  ["format.heading6", "format", "Ctrl+6"],
  ["format.paragraph", "format", "Ctrl+0"],
  ["format.bulletList", "format", "Ctrl+Shift+8"],
  ["format.orderedList", "format", "Ctrl+Shift+9"],
  ["format.blockquote", "format", "Ctrl+Shift+."],
  ["view.toggleTheme", "view", "Ctrl+Shift+T"],
  ["view.toggleFocusMode", "view", "F8"],
  ["view.toggleTypewriter", "view", "F9"],
  ["view.toggleOutline", "view", "Ctrl+Shift+O"],
  ["view.commandPalette", "view", "Ctrl+Shift+P"],
  ["view.snapshot", "view", "Ctrl+Alt+V"],
  ["view.settings", "view", "Ctrl+,"],
  ["view.toggleLeft", "view", "Ctrl+Alt+ArrowLeft"],
  ["view.toggleRight", "view", "Ctrl+Alt+ArrowRight"],
  ["view.toggleTag", "view", "Ctrl+Shift+B"],
  ["tab.next", "tab", "Ctrl+Tab"],
  ["tab.prev", "tab", "Ctrl+Shift+Tab"],
  ["tab.close", "tab", "Ctrl+W"],
  ["window.new", "window", "Ctrl+Shift+N"],
  ["window.close", "window", "Ctrl+Shift+W"],
  ["window.openInNew", "window", "Ctrl+Alt+O"],
  ["window.quit", "window", "Ctrl+Q"],
  ["window.mergeToPrimary", "window", "Ctrl+Shift+C"],
  ["insert.table", "insert", "Ctrl+Alt+T"],
  ["insert.taskList", "insert", "Ctrl+T"],
  // v0.9.3 E8:下划线 + 插入链接默认键位(同步基线表文档)
  ["format.underline", "format", "Ctrl+U"],
  ["insert.link", "insert", "Ctrl+Shift+K"],
];

describe("v0.9.0 review：默认表与基线表逐项一致", () => {
  it("50 条 ✅ 条目 id/分类/默认键位全部对上（双向，无多余无遗漏；v0.9.3 新增 2 条）", () => {
    expect(BASELINE).toHaveLength(50);
    const byId = new Map(SHORTCUT_DEFS.map((d) => [d.id, d]));
    for (const [id, category, combo] of BASELINE) {
      const def = byId.get(id);
      expect(def, `默认表缺少基线条 ${id}`).toBeTruthy();
      expect(def!.category, `${id} 分类`).toBe(category);
      expect(normalizeCombo(def!.defaultCombo), `${id} 默认键位`).toBe(normalizeCombo(combo));
      expect(def!.labelKey, `${id} 缺 i18n key`).toBeTruthy();
    }
    // 反向：默认表里不应出现基线表未列出的条目（防止偷偷加键位占位）
    const baselineIds = new Set(BASELINE.map(([id]) => id));
    for (const def of SHORTCUT_DEFS) {
      expect(baselineIds.has(def.id), `默认表多出基线未登记条目 ${def.id}`).toBe(true);
    }
  });

  it("基线表 🔒 保留项不在默认表中，但已登记进保留占用清单", () => {
    const ids = new Set(SHORTCUT_DEFS.map((d) => d.id));
    // window.full 是 🔒（F11），不得进自定义表，但要有命令面板入口
    expect(ids.has("window.full")).toBe(false);
    expect(commands.some((c) => c.id === "window.full")).toBe(true);
    const reserved = readRoot(".trae/documents/lightmd-v0.9.0-default-shortcuts-baseline.md");
    expect(reserved).toContain("window.full");
  });
});

// ─── 2. i18n 占位符 ─────────────────────────────────

describe("v0.9.0 review：i18n 占位符语法", () => {
  it("快捷键相关文案使用单花括号占位（t() 只替换单花括号）", () => {
    for (const locale of ["i18n/locales/zh-CN.ts", "i18n/locales/en-US.ts"]) {
      const src = read(locale);
      expect(src, `${locale} 出现双花括号占位符`).not.toMatch(/"[^"]*\{\{[a-z]+\}\}[^"]*"/);
    }
  });

  it("冲突提示渲染后无多余花括号", async () => {
    const { t } = await import("../i18n/state");
    expect(t("shortcuts.conflict", { name: "保存文件" })).toBe("该快捷键已被「保存文件」占用");
    expect(t("shortcuts.custom", { count: 3 })).toBe("3 项已自定义");
  });
});

// ─── 3./4. 键盘布局（AltGr 与非拉丁布局） ─────────────

describe("v0.9.0 review：键盘布局兼容", () => {
  it("AltGr（右 Alt）输入任何字符都不参与快捷键匹配", () => {
    // 德语 AltGr+S → "ß"，波兰语 AltGr+O → "ó"：不得被当成 Ctrl+Alt+S / Ctrl+Alt+O
    const altGrS = {
      key: "ß", code: "KeyS", ctrlKey: true, altKey: true, shiftKey: false, metaKey: false,
      getModifierState: (k: string) => k === "AltGraph",
    };
    expect(comboFromEvent(altGrS)).toBeNull();
    expect(matchShortcut(altGrS, ["global", "editor", "rich", "source"])).toBeUndefined();

    const altGrO = {
      key: "ó", code: "KeyO", ctrlKey: true, altKey: true, shiftKey: false, metaKey: false,
      getModifierState: (k: string) => k === "AltGraph",
    };
    expect(matchShortcut(altGrO, ["global"])).toBeUndefined();
  });

  it("非拉丁布局（俄语）以 e.code 还原物理键：Ctrl+S 仍是保存", () => {
    const ruSave = {
      key: "с", code: "KeyS", ctrlKey: true, altKey: false, shiftKey: false, metaKey: false,
    };
    expect(comboFromEvent(ruSave)).toBe("Ctrl+S");
    expect(matchShortcut(ruSave, ["global"])?.id).toBe("file.save");
  });

  it("AZERTY 等字母重排布局沿用 e.key（按 A 不该记成 Q）", () => {
    const azertyA = {
      key: "a", code: "KeyQ", ctrlKey: true, altKey: false, shiftKey: false, metaKey: false,
    };
    expect(comboFromEvent(azertyA)).toBe("Ctrl+A");
  });

  it("Shift 移位字符仍以 e.code 还原（Ctrl+Shift+8 → 8，而非 *）", () => {
    const star = {
      key: "*", code: "Digit8", ctrlKey: true, altKey: false, shiftKey: true, metaKey: false,
    };
    expect(comboFromEvent(star)).toBe("Ctrl+Shift+8");
    expect(matchShortcut(star, ["rich"])?.id).toBe("format.bulletList");
  });
});

// ─── 5. "+" 键与空绑定 ──────────────────────────────

describe("v0.9.0 review：键名归一化边界", () => {
  it("NumpadAdd 等产出的 \"+\" 有明确键名，不会退化成修饰键组合", () => {
    const numpadAdd = {
      key: "+", code: "NumpadAdd", ctrlKey: true, altKey: false, shiftKey: true, metaKey: false,
    };
    expect(comboFromEvent(numpadAdd)).toBe("Ctrl+Shift+Plus");
    expect(normalizeCombo("Ctrl+Shift+Plus")).toBe("Ctrl+Shift+Plus");
  });

  it("只剩修饰键的空绑定一律判为非法（可存储但永远触发不了）", () => {
    expect(isLegalCombo("Ctrl+Shift")).toBe(false);
    expect(isLegalCombo("Ctrl")).toBe(false);
    expect(isLegalCombo("")).toBe(false);
    expect(isLegalCombo("Ctrl+Shift++")).toBe(false);
  });
});

// ─── 6. 持久化清洗 ──────────────────────────────────

describe("v0.9.0 review：持久化覆盖表清洗", () => {
  it("保留合法覆盖，丢弃未登记 id / 非法键位 / 保留键 / 与默认值相同的冗余项", () => {
    const cleaned = sanitizeShortcutOverrides({
      "file.new": "Ctrl+J",        // 合法
      "hack.id": "Ctrl+H",         // 未登记 id
      "file.open": 123,            // 非字符串
      "file.save": "T",            // D5 违规（裸字母会吞掉输入）
      "file.saveAs": "Ctrl+R",     // 保留占用（文件树刷新）
      "format.bold": "Ctrl+B",     // 与默认值相同 → 不保留覆盖
    });
    expect(cleaned).toEqual({ "file.new": "Ctrl+J" });
  });

  it("互相冲突的覆盖按默认表顺序保留第一条，避免出现两条同键位绑定", () => {
    // 顺序即 SHORTCUT_DEFS 顺序：file.open 在 file.save 之前 → open 先占住 Ctrl+J
    const cleaned = sanitizeShortcutOverrides({
      "file.save": "Ctrl+J",
      "file.open": "Ctrl+J",
    });
    expect(cleaned).toEqual({ "file.open": "Ctrl+J" });
  });

  it("非对象/数组/字符串一律归一为空表", () => {
    expect(sanitizeShortcutOverrides(undefined)).toEqual({});
    expect(sanitizeShortcutOverrides(null)).toEqual({});
    expect(sanitizeShortcutOverrides(["x"])).toEqual({});
    expect(sanitizeShortcutOverrides("x")).toEqual({});
  });
});

// ─── 7. 恢复默认的占用守卫 ───────────────────────────

describe("v0.9.0 review：恢复单项默认不得造出重复绑定", () => {
  it("findResetCollision 能识别默认键位已被他人改绑占用", () => {
    // italic 让出 Ctrl+I 后 bold 占用它，此时 italic 恢复默认就会撞车
    setShortcutOverrides({ "format.italic": "Ctrl+Shift+I", "format.bold": "Ctrl+I" });
    expect(findResetCollision("format.italic")).toEqual({ id: "format.bold", combo: "Ctrl+I" });
    // 未被占用的条目可安全恢复
    expect(findResetCollision("format.bold")).toBeNull();
    expect(findResetCollision("format.italic")).not.toBeNull();
  });

  it("占用者让出后即可安全恢复", () => {
    setShortcutOverrides({ "format.bold": "Ctrl+I" });
    expect(findResetCollision("format.italic")).toEqual({ id: "format.bold", combo: "Ctrl+I" });
    setShortcutOverrides({});
    expect(findResetCollision("format.italic")).toBeNull();
  });

  it("清洗后的覆盖表不会出现两条同键位绑定", () => {
    const cleaned = sanitizeShortcutOverrides({
      "format.italic": "Ctrl+Shift+I",
      "format.bold": "Ctrl+Shift+I",
    });
    setShortcutOverrides(cleaned);
    const combos = SHORTCUT_DEFS.map((d) =>
      normalizeCombo(cleaned[d.id] ?? d.defaultCombo),
    );
    expect(new Set(combos).size).toBe(combos.length);
  });
});

// ─── 8. 双击阈值边界（A5） ───────────────────────────

describe("v0.9.0 review：双击阈值 220ms 边界（A5）", () => {
  const THRESHOLD = 220;

  it("210ms 内第二次按下 → 触发切换", () => {
    expect(evalDoublePress(1000 + 210, 1000, THRESHOLD, false)).toBe("toggle");
  });

  it("219ms → 触发；220ms（恰好等于阈值）→ 不触发（按 < 判定）", () => {
    expect(evalDoublePress(1219, 1000, THRESHOLD, false)).toBe("toggle");
    expect(evalDoublePress(1220, 1000, THRESHOLD, false)).toBe("record");
  });

  it("230ms → 不触发，重新计时", () => {
    expect(evalDoublePress(1230, 1000, THRESHOLD, false)).toBe("record");
  });

  it("长按 repeat 一律 skip，且不刷新时间戳（避免松开后被误判为双击）", () => {
    expect(evalDoublePress(1100, 1000, THRESHOLD, true)).toBe("skip");
    expect(evalDoublePress(1300, 1000, THRESHOLD, true)).toBe("skip");
  });
});

// ─── 9. 系统级组合键提示（计划 §2.3） ────────────────

describe("v0.9.0 review：系统级组合键仅提示不拒绝", () => {
  it("Alt+F4 等被识别为系统级（允许绑定但提示）", () => {
    expect(isSystemCombo("Alt+F4")).toBe(true);
    expect(isSystemCombo("alt+f4")).toBe(true);
    expect(isSystemCombo("Ctrl+J")).toBe(false);
    // 系统键不在保留清单里 —— 允许写入，只提示
    expect(isLegalCombo("Alt+F4")).toBe(true);
  });
});
