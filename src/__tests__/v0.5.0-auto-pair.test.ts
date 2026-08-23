/**
 * v0.5.0 N1：自动配对补全
 *
 * 验收标准：
 * 1. PM 端：无选区输入开符号 → 插入配对、光标居中；有选区 → 包裹并保持选中
 * 2. PM 端：输入闭符号且下一字符相同 → 跳过（光标右移）
 * 3. 开关关闭 / 代码块内 → 不处理（返回 false）
 * 4. textarea 端：EditorContainer 源码 keydown 接入 PAIR_MAP 配对逻辑
 * 5. 设置 store 提供开关（默认开启）+ SettingsDialog 有开关项
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createEditor } from "../core/editor";
import { autoPairPlugin, PAIR_MAP, PAIR_CLOSERS } from "../core/plugins/auto-pair";
import { useSettingsStore } from "../stores/useSettingsStore";
import type { EditorView } from "prosemirror-view";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readSrc(rel: string): string {
  return readFileSync(join(root, rel), "utf-8");
}

/** 测试专用：createEditor 在 jsdom 下不会返回 null，断言为非空简化用例 */
function mk(opts: { parent: HTMLElement; initialContent: string }): EditorView {
  return createEditor(opts) as EditorView;
}

describe("v0.5.0 N1：自动配对补全", () => {
  let parent: HTMLDivElement;
  let view: EditorView | null;

  beforeEach(() => {
    parent = document.createElement("div");
    document.body.appendChild(parent);
    useSettingsStore.getState().setAutoPairEnabled(true);
  });

  afterEach(() => {
    if (view) {
      view.destroy();
      view = null;
    }
    parent.remove();
    useSettingsStore.getState().setAutoPairEnabled(true);
  });

  /** 获取段落内指定偏移处的绝对位置 */
  function posInParagraph(v: EditorView, offset: number): number {
    let pos = -1;
    v.state.doc.descendants((node, p) => {
      if (pos < 0 && node.type.name === "paragraph") {
        pos = p + 1 + Math.min(offset, node.content.size);
        return false;
      }
      return true;
    });
    return pos;
  }

  it("PAIR_MAP 覆盖括号与引号，闭符号集合与映射一致", () => {
    expect(PAIR_MAP["("]).toBe(")");
    expect(PAIR_MAP["["]).toBe("]");
    expect(PAIR_MAP["{"]).toBe("}");
    expect(PAIR_MAP['"']).toBe('"');
    expect(PAIR_MAP["'"]).toBe("'");
    expect(PAIR_MAP["`"]).toBe("`");
    // 不含 $（避免输入价格等普通文本时误配对）
    expect(PAIR_MAP["$"]).toBeUndefined();
    for (const open of Object.keys(PAIR_MAP)) {
      expect(PAIR_CLOSERS.has(PAIR_MAP[open])).toBe(true);
    }
  });

  it("PM：无选区输入 ( → 插入 () 且光标居中", () => {
    const v = mk({ parent, initialContent: "ab" });
    view = v;
    const pos = posInParagraph(v, 1); // a|b
    const handler = autoPairPlugin().props.handleTextInput as (
      view: EditorView, from: number, to: number, text: string, deflt?: () => unknown
    ) => boolean;
    const handled = handler(v, pos, pos, "(", () => v.state.tr);
    expect(handled).toBe(true);
    // 插入 "(" + ")" 配对，光标居中
    expect(v.state.doc.textContent).toBe("a()b");
    expect(v.state.selection.from).toBe(pos + 1);
  });

  it("PM：有选区输入 ( → 包裹选中文本并保持选中", () => {
    const v = mk({ parent, initialContent: "ab" });
    view = v;
    const from = posInParagraph(v, 0);
    const to = posInParagraph(v, 2); // 选中 "ab"
    const handler = autoPairPlugin().props.handleTextInput as (
      view: EditorView, from: number, to: number, text: string, deflt?: () => unknown
    ) => boolean;
    const handled = handler(v, from, to, "(", () => v.state.tr);
    expect(handled).toBe(true);
    expect(v.state.doc.textContent).toBe("(ab)");
    // 选区保持为被包裹的原文本
    expect(v.state.selection.from).toBe(from + 1);
    expect(v.state.selection.to).toBe(to + 1);
  });

  it("PM：输入 ) 且下一字符已是 ) → 跳过输入，光标右移", () => {
    const v = mk({ parent, initialContent: "()" });
    view = v;
    const pos = posInParagraph(v, 1); // (|) 光标在中间
    const handler = autoPairPlugin().props.handleTextInput as (
      view: EditorView, from: number, to: number, text: string, deflt?: () => unknown
    ) => boolean;
    const handled = handler(v, pos, pos, ")", () => v.state.tr);
    expect(handled).toBe(true);
    expect(v.state.doc.textContent).toBe("()"); // 未新增字符
    expect(v.state.selection.from).toBe(pos + 1);
  });

  it("PM：开关关闭时不处理", () => {
    useSettingsStore.getState().setAutoPairEnabled(false);
    const v = mk({ parent, initialContent: "ab" });
    view = v;
    const pos = posInParagraph(v, 1);
    const handler = autoPairPlugin().props.handleTextInput as (
      view: EditorView, from: number, to: number, text: string, deflt?: () => unknown
    ) => boolean;
    expect(handler(v, pos, pos, "(", () => v.state.tr)).toBe(false);
    expect(v.state.doc.textContent).toBe("ab");
  });

  it("PM：代码块内不配对", () => {
    const v = mk({ parent, initialContent: "```\nvar x = 1\n```" });
    view = v;
    // 找到 code_block 内的位置（var 后）
    let target = -1;
    v.state.doc.descendants((node, p) => {
      if (target < 0 && node.type.name === "code_block") {
        target = p + 1 + 5; // code_block 内容 "var x = 1" 偏移 5
        return false;
      }
      return true;
    });
    const handler = autoPairPlugin().props.handleTextInput as (
      view: EditorView, from: number, to: number, text: string, deflt?: () => unknown
    ) => boolean;
    expect(handler(v, target, target, "(", () => v.state.tr)).toBe(false);
  });

  it("PM：普通字符与多字符输入不处理", () => {
    const v = mk({ parent, initialContent: "ab" });
    view = v;
    const pos = posInParagraph(v, 1);
    const handler = autoPairPlugin().props.handleTextInput as (
      view: EditorView, from: number, to: number, text: string, deflt?: () => unknown
    ) => boolean;
    expect(handler(v, pos, pos, "x", () => v.state.tr)).toBe(false);
    expect(handler(v, pos, pos, "ab", () => v.state.tr)).toBe(false);
  });

  it("设置 store：autoPairEnabled 默认开启，setter 生效并持久化字段存在", () => {
    const src = readSrc("src/stores/useSettingsStore.ts");
    expect(src).toMatch(/autoPairEnabled: true/);
    expect(src).toMatch(/setAutoPairEnabled/);
    useSettingsStore.getState().setAutoPairEnabled(false);
    expect(useSettingsStore.getState().autoPairEnabled).toBe(false);
  });

  it("textarea 端：EditorContainer 接入 PAIR_MAP 配对逻辑", () => {
    const src = readSrc("src/components/editor/EditorContainer.tsx");
    // 导入配对表并在 keydown 中处理
    expect(src).toMatch(/import \{ PAIR_MAP, PAIR_CLOSERS \}/);
    expect(src).toMatch(/PAIR_MAP\[key\]/);
    expect(src).toMatch(/PAIR_CLOSERS\.has\(key\)/);
    // 包裹选区：单次插入 开符号+选中文本+闭符号（一次 undo）
    expect(src).toMatch(/insertText", false, key \+ selected \+ close/);
  });

  it("SettingsDialog 提供开关项 + i18n 文案（zh/en）", () => {
    expect(readSrc("src/components/dialogs/SettingsDialog.tsx")).toMatch(
      /settings\.autoPairEnabled/
    );
    expect(readSrc("src/i18n/locales/zh-CN.ts")).toMatch(
      /"settings\.autoPair":\s*"自动配对补全"/
    );
    expect(readSrc("src/i18n/locales/en-US.ts")).toMatch(
      /"settings\.autoPair":\s*"Auto Pair"/
    );
  });
});
