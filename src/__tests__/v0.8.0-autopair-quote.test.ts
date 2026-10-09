/**
 * v0.8.0 修复 P11-5：标点自动补全的"跳过已有右符号"（overtype）
 *
 * 用户问题：在文字中间输入一个双引号、再输入一个双引号，被补成了 4 个引号。
 * 根因：`"` 在 PAIR_MAP 中 value 就是它自己（close 恒为真），旧的跳过分支条件是
 * `!close`，因此自配对字符（" ' ` 及中文引号）永远走不到跳过逻辑。
 * 修复后：紧邻右侧已有相同字符时只移动光标（与 VS Code / CodeMirror 行为一致）。
 *
 * v0.12.1 需求4 变更：新增「右侧是单词字符则不配对」规则后，"文字中间"不再补全，
 * 因此这些用例改为在**行尾 / 右邻非单词字符**的真实开符号场景下验证 overtype
 * （词中间的负向行为由 v0121-auto-pair-rules.test.ts 覆盖）。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createEditor } from "../core/editor";
import { autoPairPlugin, PAIR_MAP } from "../core/plugins/auto-pair";
import { useSettingsStore } from "../stores/useSettingsStore";
import type { EditorView } from "prosemirror-view";

function mk(initialContent: string, parent: HTMLElement): EditorView {
  return createEditor({ parent, initialContent }) as EditorView;
}

type Handler = (
  view: EditorView,
  from: number,
  to: number,
  text: string,
  deflt?: () => unknown,
) => boolean;

const handler = autoPairPlugin().props.handleTextInput as Handler;

describe("v0.8.0 修复 P11-5 自配对字符的 overtype", () => {
  let parent: HTMLDivElement;
  let view: EditorView | null = null;

  beforeEach(() => {
    parent = document.createElement("div");
    document.body.appendChild(parent);
    useSettingsStore.getState().setAutoPairEnabled(true);
    useSettingsStore.getState().setAutoPairKind("quotes", true);
    useSettingsStore.getState().setAutoPairKind("cjk", true);
  });

  afterEach(() => {
    view?.destroy();
    view = null;
    parent.remove();
    useSettingsStore.getState().setAutoPairEnabled(true);
  });

  /** 段落内第 offset 个字符处的绝对位置 */
  function posInParagraph(v: EditorView, offset: number): number {
    return 1 + offset;
  }

  it("行尾连续输入两个双引号 → 只得到一对（不再变成 4 个）", () => {
    const v = mk("abcd", parent);
    view = v;

    // 第一次：abcd| → 补全成 abcd""
    let pos = posInParagraph(v, 4);
    expect(handler(v, pos, pos, '"', () => v.state.tr)).toBe(true);
    expect(v.state.doc.textContent).toBe('abcd""');
    expect(v.state.selection.from).toBe(pos + 1);

    // 第二次：光标在两引号中间，右侧已是 " → 只跳过（光标右移），不再插入
    pos = v.state.selection.from;
    expect(handler(v, pos, pos, '"', () => v.state.tr)).toBe(true);
    expect(v.state.doc.textContent).toBe('abcd""');
    expect(v.state.selection.from).toBe(pos + 1);
  });

  it("单引号 / 反引号同样支持跳过", () => {
    for (const q of ["'", "`"]) {
      // 左侧是连字符（非单词字符，撇号规则允许配对）、光标在行尾
      const v2 = mk("ab-", parent);
      let pos = posInParagraph(v2, 3);
      handler(v2, pos, pos, q, () => v2.state.tr);
      expect(v2.state.doc.textContent).toBe(`ab-${q}${q}`);
      pos = v2.state.selection.from;
      handler(v2, pos, pos, q, () => v2.state.tr);
      expect(v2.state.doc.textContent).toBe(`ab-${q}${q}`);
      expect(v2.state.selection.from).toBe(pos + 1);
      v2.destroy();
    }
  });

  it("已有空引号对中再次输入 → 跳过（overtype）", () => {
    const v = mk('ab""cd', parent);
    view = v;
    const pos = posInParagraph(v, 3); // ab"|"cd
    expect(handler(v, pos, pos, '"', () => v.state.tr)).toBe(true);
    expect(v.state.doc.textContent).toBe('ab""cd');
    expect(v.state.selection.from).toBe(pos + 1);
  });

  it("中文引号：输入 “ 补 ”；再输入 ” 时跳过", () => {
    const v = mk("abcd", parent);
    view = v;
    let pos = posInParagraph(v, 4); // 行尾
    handler(v, pos, pos, "“", () => v.state.tr);
    expect(v.state.doc.textContent).toBe("abcd“”");
    pos = v.state.selection.from;
    handler(v, pos, pos, "”", () => v.state.tr);
    expect(v.state.doc.textContent).toBe("abcd“”");
    expect(v.state.selection.from).toBe(pos + 1);
  });

  it("括号类闭符号行为保持不变（右侧不是同类字符时交给默认输入）", () => {
    const v = mk("ab", parent);
    view = v;
    const pos = posInParagraph(v, 2);
    expect(handler(v, pos, pos, ")", () => v.state.tr)).toBe(false);
    expect(v.state.doc.textContent).toBe("ab");
  });

  it("有选区时不做跳过，仍然包裹选中文本", () => {
    const v = mk("abcd", parent);
    view = v;
    const from = posInParagraph(v, 1);
    const to = posInParagraph(v, 3); // 选中 bc
    expect(handler(v, from, to, '"', () => v.state.tr)).toBe(true);
    expect(v.state.doc.textContent).toBe('a"bc"d');
  });

  it("PAIR_MAP 仍覆盖引号（防止误删映射）", () => {
    expect(PAIR_MAP['"']).toBe('"');
    expect(PAIR_MAP["'"]).toBe("'");
    expect(PAIR_MAP["`"]).toBe("`");
  });
});
