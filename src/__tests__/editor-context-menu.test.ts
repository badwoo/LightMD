/**
 * EditorContextMenu 右键菜单测试
 *
 * 测试 buildMenuItems 纯函数，验证：
 * - 菜单项的显示/隐藏逻辑（无选中文本时隐藏行内格式项）
 * - 撤销/恢复的禁用状态
 * - 剪切/复制的禁用状态
 * - 菜单项顺序和数量
 * - action 标识正确性
 */
import { describe, it, expect } from "vitest";
import { buildMenuItems, type MenuItemConfig } from "../components/editor/EditorContextMenu";

/** 提取所有非分隔符菜单项的 action */
function getItemActions(items: MenuItemConfig[]): string[] {
  return items.filter((i) => i.type === "item").map((i) => i.action!);
}

/** 提取所有非分隔符菜单项的 label */
function getItemLabels(items: MenuItemConfig[]): string[] {
  return items.filter((i) => i.type === "item").map((i) => i.label!);
}

/** 统计分隔符数量 */
function countSeparators(items: MenuItemConfig[]): number {
  return items.filter((i) => i.type === "separator").length;
}

describe("buildMenuItems - 菜单项配置构建", () => {
  // ─── 无选中文本的场景 ──────────────────────────
  it("无选中文本时应隐藏行内格式项", () => {
    const items = buildMenuItems(false, true, true);
    const actions = getItemActions(items);
    expect(actions).not.toContain("bold");
    expect(actions).not.toContain("italic");
    expect(actions).not.toContain("strikethrough");
    expect(actions).not.toContain("code");
  });

  it("无选中文本时剪切/复制应禁用", () => {
    const items = buildMenuItems(false, true, true);
    const cutItem = items.find((i) => i.action === "cut");
    const copyItem = items.find((i) => i.action === "copy");
    expect(cutItem?.disabled).toBe(true);
    expect(copyItem?.disabled).toBe(true);
  });

  it("无选中文本时粘贴应可用", () => {
    const items = buildMenuItems(false, true, true);
    const pasteItem = items.find((i) => i.action === "paste");
    expect(pasteItem?.disabled).toBe(false);
  });

  // ─── 有选中文本的场景 ──────────────────────────
  it("有选中文本时应显示行内格式项", () => {
    const items = buildMenuItems(true, true, true);
    const actions = getItemActions(items);
    expect(actions).toContain("bold");
    expect(actions).toContain("italic");
    expect(actions).toContain("strikethrough");
    expect(actions).toContain("code");
  });

  it("有选中文本时剪切/复制应可用", () => {
    const items = buildMenuItems(true, true, true);
    const cutItem = items.find((i) => i.action === "cut");
    const copyItem = items.find((i) => i.action === "copy");
    expect(cutItem?.disabled).toBe(false);
    expect(copyItem?.disabled).toBe(false);
  });

  // ─── 撤销/恢复状态 ──────────────────────────────
  it("canUndo=false 时撤销应禁用", () => {
    const items = buildMenuItems(true, false, true);
    const undoItem = items.find((i) => i.action === "undo");
    expect(undoItem?.disabled).toBe(true);
  });

  it("canUndo=true 时撤销应可用", () => {
    const items = buildMenuItems(true, true, false);
    const undoItem = items.find((i) => i.action === "undo");
    expect(undoItem?.disabled).toBe(false);
  });

  it("canRedo=false 时恢复应禁用", () => {
    const items = buildMenuItems(true, true, false);
    const redoItem = items.find((i) => i.action === "redo");
    expect(redoItem?.disabled).toBe(true);
  });

  it("canRedo=true 时恢复应可用", () => {
    const items = buildMenuItems(true, false, true);
    const redoItem = items.find((i) => i.action === "redo");
    expect(redoItem?.disabled).toBe(false);
  });

  // ─── 菜单项顺序和完整性 ──────────────────────
  it("无选中时菜单项顺序正确", () => {
    const items = buildMenuItems(false, true, true);
    const actions = getItemActions(items);
    // 预期顺序：undo, redo, cut, copy, paste, link, image, table, codeblock, mermaid
    expect(actions).toEqual(["undo", "redo", "cut", "copy", "paste", "link", "image", "table", "codeblock", "mermaid"]);
  });

  it("有选中时菜单项顺序正确", () => {
    const items = buildMenuItems(true, true, true);
    const actions = getItemActions(items);
    // 预期顺序：undo, redo, cut, copy, paste, bold, italic, strikethrough, code, link, image, table, codeblock, mermaid
    expect(actions).toEqual([
      "undo", "redo", "cut", "copy", "paste",
      "bold", "italic", "strikethrough", "code",
      "link", "image", "table", "codeblock", "mermaid",
    ]);
  });

  // ─── 分隔符 ──────────────────────────────────
  it("无选中时分隔符数量为 2（撤销组/剪贴组/插入组之间）", () => {
    const items = buildMenuItems(false, true, true);
    // 无选中时分隔符在：undo-redo组后、paste-link之间
    expect(countSeparators(items)).toBe(2);
  });

  it("有选中时分隔符数量为 3（含行内格式组分隔符）", () => {
    const items = buildMenuItems(true, true, true);
    expect(countSeparators(items)).toBe(3);
  });

  // ─── 快捷键提示 ──────────────────────────────
  it("撤销项应显示 Ctrl+Z 快捷键", () => {
    const items = buildMenuItems(true, true, true);
    const undoItem = items.find((i) => i.action === "undo");
    expect(undoItem?.shortcut).toBe("Ctrl+Z");
  });

  it("恢复项应显示 Ctrl+Y 快捷键", () => {
    const items = buildMenuItems(true, true, true);
    const redoItem = items.find((i) => i.action === "redo");
    expect(redoItem?.shortcut).toBe("Ctrl+Y");
  });

  it("加粗项应显示 Ctrl+B 快捷键", () => {
    const items = buildMenuItems(true, true, true);
    const boldItem = items.find((i) => i.action === "bold");
    expect(boldItem?.shortcut).toBe("Ctrl+B");
  });

  it("插入链接项不应显示快捷键", () => {
    const items = buildMenuItems(true, true, true);
    const linkItem = items.find((i) => i.action === "link");
    expect(linkItem?.shortcut).toBeUndefined();
  });

  // ─── 标签完整性 ──────────────────────────────
  it("所有菜单项都有 label", () => {
    const items = buildMenuItems(true, true, true);
    const labels = getItemLabels(items);
    labels.forEach((label) => {
      expect(label).toBeTruthy();
      expect(label.length).toBeGreaterThan(0);
    });
  });

  it("所有菜单项都有唯一的 action", () => {
    const items = buildMenuItems(true, true, true);
    const actions = getItemActions(items);
    const uniqueActions = new Set(actions);
    expect(uniqueActions.size).toBe(actions.length);
  });

  // ─── 边界场景 ──────────────────────────────────
  it("全部禁用状态（无选中、无撤销、无恢复）应正确构建", () => {
    const items = buildMenuItems(false, false, false);
    const undoItem = items.find((i) => i.action === "undo");
    const redoItem = items.find((i) => i.action === "redo");
    const cutItem = items.find((i) => i.action === "cut");
    const copyItem = items.find((i) => i.action === "copy");
    expect(undoItem?.disabled).toBe(true);
    expect(redoItem?.disabled).toBe(true);
    expect(cutItem?.disabled).toBe(true);
    expect(copyItem?.disabled).toBe(true);
  });
});
