/**
 * v0.5.0 N2：智能粘贴 URL→链接
 *
 * 验收标准：
 * 1. PM 端：无选区粘贴 URL → 插入文本并附加 link mark，光标在链接后
 * 2. PM 端：有选区粘贴 URL → 选中文本变为链接（文字不变、href 为 URL）
 * 3. PM 端：代码块内 / 非 URL 文本 → 不处理（返回 false）
 * 4. textarea 端：EditorContainer 源码模式接入 onPaste，无选区 → [url](url)，有选区 → [选中](url)
 * 5. 插件已在 editor.ts 插件列表注册
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TextSelection } from "prosemirror-state";
import { createEditor } from "../core/editor";
import { smartPastePlugin, isHttpUrl } from "../core/plugins/smart-paste";
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

/** 构造含 text/plain 数据的剪贴板事件（供 handlePaste 调用） */
function makePasteEvent(text: string): ClipboardEvent {
  const clipboardData = {
    getData: (type: string) => (type === "text/plain" ? text : ""),
  };
  return { clipboardData } as unknown as ClipboardEvent;
}

describe("v0.5.0 N2：智能粘贴 URL→链接", () => {
  let parent: HTMLDivElement;
  let view: EditorView | null;

  beforeEach(() => {
    parent = document.createElement("div");
    document.body.appendChild(parent);
  });

  afterEach(() => {
    if (view) {
      view.destroy();
      view = null;
    }
    parent.remove();
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

  it("isHttpUrl：识别 http/https URL，拒绝带空白与非 URL 文本", () => {
    expect(isHttpUrl("https://example.com")).toBe(true);
    expect(isHttpUrl("http://a.b/c?d=1&e=2")).toBe(true);
    expect(isHttpUrl("  https://example.com  ")).toBe(false); // 调用方已 trim，此处直接判 false
    expect(isHttpUrl("https://example.com path")).toBe(false);
    expect(isHttpUrl("ftp://example.com")).toBe(false);
    expect(isHttpUrl("example.com")).toBe(false);
    expect(isHttpUrl("查看 https://example.com")).toBe(false);
  });

  it("PM：无选区粘贴 URL → 插入文本并附加 link mark，光标在链接后", () => {
    const v = mk({ parent, initialContent: "ab" });
    view = v;
    const pos = posInParagraph(v, 1); // a|b
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, pos)));
    const handler = smartPastePlugin().props.handlePaste as (
      view: EditorView, event: ClipboardEvent, slice: unknown
    ) => boolean;
    const handled = handler(v, makePasteEvent("https://example.com"), v.state.doc.slice(pos, pos));
    expect(handled).toBe(true);
    expect(v.state.doc.textContent).toBe("ahttps://example.comb");
    // 检查插入的 URL 文本带 link mark
    const { from } = v.state.selection;
    const marks = v.state.doc.resolve(from - 1).marks();
    expect(marks.some((m) => m.type.name === "link" && m.attrs.href === "https://example.com")).toBe(true);
  });

  it("PM：有选区粘贴 URL → 选中文本变为链接，文字不变", () => {
    const v = mk({ parent, initialContent: "ab" });
    view = v;
    const from = posInParagraph(v, 0);
    const to = posInParagraph(v, 2); // 选中 "ab"
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, from, to)));
    const handler = smartPastePlugin().props.handlePaste as (
      view: EditorView, event: ClipboardEvent, slice: unknown
    ) => boolean;
    const handled = handler(v, makePasteEvent("https://example.com"), v.state.doc.slice(from, to));
    expect(handled).toBe(true);
    expect(v.state.doc.textContent).toBe("ab"); // 文字未变
    // 选中范围的文字带 link mark
    const marks = v.state.doc.resolve(from + 1).marks();
    expect(marks.some((m) => m.type.name === "link" && m.attrs.href === "https://example.com")).toBe(true);
  });

  it("PM：代码块内粘贴 URL 不处理", () => {
    const v = mk({ parent, initialContent: "```\nvar x = 1\n```" });
    view = v;
    let target = -1;
    v.state.doc.descendants((node, p) => {
      if (target < 0 && node.type.name === "code_block") {
        target = p + 1 + 5;
        return false;
      }
      return true;
    });
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, target)));
    const handler = smartPastePlugin().props.handlePaste as (
      view: EditorView, event: ClipboardEvent, slice: unknown
    ) => boolean;
    expect(handler(v, makePasteEvent("https://example.com"), v.state.doc.slice(target, target))).toBe(false);
  });

  it("PM：非 URL 文本粘贴不处理", () => {
    const v = mk({ parent, initialContent: "ab" });
    view = v;
    const handler = smartPastePlugin().props.handlePaste as (
      view: EditorView, event: ClipboardEvent, slice: unknown
    ) => boolean;
    expect(handler(v, makePasteEvent("hello world"), v.state.doc.slice(1, 1))).toBe(false);
    expect(handler(v, makePasteEvent(""), v.state.doc.slice(1, 1))).toBe(false);
  });

  it("插件已在 editor.ts 注册，inDisabledNode 已从 auto-pair 导出", () => {
    const src = readSrc("src/core/editor.ts");
    expect(src).toMatch(/smartPastePlugin\(\)/);
    expect(readSrc("src/core/plugins/smart-paste.ts")).toMatch(
      /import \{ inDisabledNode \} from "\.\/auto-pair"/
    );
  });

  it("textarea 端：EditorContainer 源码模式接入 onPaste 智能粘贴", () => {
    const src = readSrc("src/components/editor/EditorContainer.tsx");
    expect(src).toMatch(/import \{ isHttpUrl \} from "\.\.\/\.\.\/core\/plugins\/smart-paste"/);
    expect(src).toMatch(/onPaste=\{handleSourcePaste\}/);
    // 无选区 → [url](url)；有选区 → [选中](url)
    expect(src).toMatch(/`\[\$\{selected \|\| text\}\]\(\$\{text\}\)`/);
    // 代码块内不处理
    expect(src).toMatch(/isInCodeBlock\(ta\.value, start\)/);
  });
});
