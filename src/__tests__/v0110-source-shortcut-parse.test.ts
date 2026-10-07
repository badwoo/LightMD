/**
 * v0.11.0 B3-2 **返修**回归测试：源码模式快捷键必须真正端到端可用。
 *
 * 为什么必须有这个文件：
 *   首版只把 `shortcuts.ts` 里三条的 scope 改成 `rich-source`，却没有补
 *   `sourceFormat.ts` 的 `SOURCE_ACTION_BY_ID` 映射 →
 *   `parseShortcut()` 里 `matchShortcut(e, ["source"])` 命中后
 *   `SOURCE_ACTION_BY_ID[def.id] ?? null` 返回 **null** →
 *   `EditorContainer` 直接 `if (!action) return`，
 *   源码 textarea 里 Ctrl+Shift+8/9/. **仍然毫无反应**。
 *   既有测试只断言 `matchShortcut(..., ["source"])` 命中（低于缺陷层），
 *   所以完全没发现。本文件直接测 `parseShortcut`（真正被使用的入口）。
 */
import { describe, it, expect } from "vitest";
import { parseShortcut } from "../components/editor/sourceFormat";

function ev(key: string, code?: string, mods: { shift?: boolean; alt?: boolean } = {}) {
  return {
    ctrlKey: true,
    metaKey: false,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    key,
    code,
  };
}

describe("v0.11.0 B3-2 返修：源码模式 parseShortcut 端到端", () => {
  it("Ctrl+Shift+8/9/. 返回 ul / ol / quote（此前返回 null = 死键）", () => {
    expect(parseShortcut(ev("*", "Digit8", { shift: true }))).toBe("ul");
    expect(parseShortcut(ev("(", "Digit9", { shift: true }))).toBe("ol");
    expect(parseShortcut(ev(".", undefined, { shift: true }))).toBe("quote");
  });

  it("既有映射不回归（粗体/斜体/公式/标题/段落）", () => {
    expect(parseShortcut(ev("b"))).toBe("bold");
    expect(parseShortcut(ev("i"))).toBe("italic");
    expect(parseShortcut(ev("m", undefined, { shift: true }))).toBe("math");
    expect(parseShortcut(ev("1"))).toBe("heading1");
    expect(parseShortcut(ev("6"))).toBe("heading6");
    expect(parseShortcut(ev("0"))).toBe("paragraph");
  });

  it("未绑定组合返回 null（不误吞按键）", () => {
    expect(parseShortcut(ev("q", undefined, { shift: true }))).toBeNull();
  });
});
