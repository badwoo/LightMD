/**
 * E9(v0.9.4)：Markdown 感知粘贴 + 富文本粘贴（clipboard-paste）
 *
 * 修复前：全项目无 transformPasted/handlePaste 富文本转换——粘贴 Markdown 文本按纯文本
 * 处理，粘贴富文本只能走 schema parseDOM 降级（结构易丢）。
 * 修复后：text/html → turndown → markdownToDoc → 富文本结构；text/plain 命中
 * Markdown 特征 ≥2 项时同样按 Markdown 解析；代码块/公式内与关闭设置时保持字面。
 */
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { Node } from "prosemirror-model";
import { lightMDSchema as schema } from "../core/schema";
import { markdownToDoc } from "../core/markdown/parser";
import { useSettingsStore } from "../stores/useSettingsStore";
import {
  clipboardPastePlugin,
  looksLikeMarkdown,
  htmlToMarkdown,
  buildPasteSlice,
} from "../core/plugins/clipboard-paste";

/** 构造伪 ClipboardEvent（只用 getData / types / items） */
function clipEvent(map: Record<string, string>, types?: string[]): ClipboardEvent {
  const typeList = types ?? Object.keys(map);
  return {
    clipboardData: {
      types: typeList,
      items: [],
      getData: (t: string) => map[t] ?? "",
    },
  } as unknown as ClipboardEvent;
}

/** stub EditorView：state getter + dispatch 应用事务 */
function pasteView(doc: Node, from: number, to = from): { view: EditorView; get: () => EditorState } {
  let state = EditorState.create({ doc, selection: TextSelection.create(doc, from, to) });
  const view = {
    get state() {
      return state;
    },
    dispatch: (tr: import("prosemirror-state").Transaction) => {
      state = state.apply(tr);
    },
    focus: () => {},
  } as unknown as EditorView;
  return { view, get: () => state };
}

function paraDoc(text: string): Node {
  return schema.topNodeType.create(null, [
    schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined),
  ]);
}

// handlePaste 是 Plugin 的 props 方法（this 绑定 Plugin），此处包一层以便直接调用
const pastePlugin = clipboardPastePlugin();
const handlePaste = (view: EditorView, event: ClipboardEvent): boolean =>
  !!pastePlugin.props.handlePaste!.call(pastePlugin, view, event, null as never);

afterEach(() => {
  useSettingsStore.getState().setPasteMarkdownEnabled(true);
});

describe("E9：Markdown 特征启发式", () => {
  it("普通文本不判定为 Markdown", () => {
    expect(looksLikeMarkdown("今天天气不错，出去走走吧。")).toBe(false);
  });

  it("标题 + 列表（≥2 项特征）→ 判定为 Markdown", () => {
    expect(looksLikeMarkdown("# 标题\n\n- a\n- b")).toBe(true);
  });

  it("单个粗体（仅 1 项特征）→ 不判定", () => {
    expect(looksLikeMarkdown("这是 **粗体**")).toBe(false);
  });
});

describe("E9：HTML→Markdown 与 Slice 构造", () => {
  it("富文本 HTML 转 Markdown 保留粗体与列表", () => {
    const md = htmlToMarkdown("<p>Hello <strong>world</strong></p><ul><li>x</li><li>y</li></ul>");
    expect(md).toContain("**world**");
    // turndown 列表前缀为 "-   "（3 空格），语义等价
    expect(md).toMatch(/-\s+x/);
    expect(md).toMatch(/-\s+y/);
  });

  it("单个段落 → openStart/openEnd = 1（行内合并）", () => {
    const slice = buildPasteSlice(markdownToDoc("**bold**"));
    expect(slice?.openStart).toBe(1);
    expect(slice?.openEnd).toBe(1);
  });

  it("多块内容 → openStart/openEnd = 0（按块插入）", () => {
    const slice = buildPasteSlice(markdownToDoc("# t\n\n- a"));
    expect(slice?.openStart).toBe(0);
    expect(slice?.openEnd).toBe(0);
  });
});

describe("E9：handlePaste 行为", () => {
  it("纯文本 Markdown → 解析为富文本结构（标题/列表/粗体）", () => {
    const md = "# Title\n\n- a\n- b\n\n**bold**";
    const { view, get } = pasteView(paraDoc("hello"), 6);
    const handled = handlePaste(view, clipEvent({ "text/plain": md }));
    expect(handled).toBe(true);
    const doc = get().doc;
    const seen = new Set<string>();
    doc.descendants((n) => {
      seen.add(n.type.name);
    });
    expect(seen.has("heading")).toBe(true);
    expect(seen.has("bullet_list")).toBe(true);
  });

  it("HTML 片段 → turndown → 结构还原", () => {
    const { view, get } = pasteView(paraDoc("x"), 2);
    const handled = handlePaste(
      view,
      clipEvent({ "text/html": "<p>A <strong>B</strong></p><ul><li>item</li></ul>" }),
    );
    expect(handled).toBe(true);
    const doc = get().doc;
    let strongText = "";
    let hasList = false;
    doc.descendants((n) => {
      if (n.isText && n.marks.some((m) => m.type.name === "strong")) strongText += n.text;
      if (n.type.name === "bullet_list") hasList = true;
    });
    expect(strongText).toContain("B");
    expect(hasList).toBe(true);
  });

  it("代码块内粘贴 → 不转换（返回 false，交默认字面粘贴）", () => {
    const doc = markdownToDoc("```\ncode\n```");
    // 光标落在代码块内容中（位置 2）
    const { view } = pasteView(doc, 2);
    expect(handlePaste(view, clipEvent({ "text/plain": "# Title\n\n- a" }))).toBe(false);
  });

  it("设置关闭 → 整体不介入（返回 false）", () => {
    useSettingsStore.getState().setPasteMarkdownEnabled(false);
    const { view } = pasteView(paraDoc("hello"), 6);
    expect(handlePaste(view, clipEvent({ "text/plain": "# Title\n\n- a" }))).toBe(false);
  });

  it("剪贴板含文件 → 放行给 image-paste（返回 false）", () => {
    const { view } = pasteView(paraDoc("hello"), 6);
    const evt = clipEvent({ "text/plain": "# Title\n\n- a" }, ["Files", "text/plain"]);
    expect(handlePaste(view, evt)).toBe(false);
  });

  it("非 Markdown 纯文本 → 返回 false（字面粘贴）", () => {
    const { view } = pasteView(paraDoc("hello"), 6);
    expect(handlePaste(view, clipEvent({ "text/plain": "普通一句话" }))).toBe(false);
  });

  it("无文本内容 → 返回 false", () => {
    const { view } = pasteView(paraDoc("hello"), 6);
    expect(handlePaste(view, clipEvent({}))).toBe(false);
  });
});

describe("E9：设置项契约", () => {
  it("pasteMarkdownEnabled 默认开启", () => {
    expect(useSettingsStore.getState().pasteMarkdownEnabled).toBe(true);
  });

  it("setPasteMarkdownEnabled 可切换", () => {
    useSettingsStore.getState().setPasteMarkdownEnabled(false);
    expect(useSettingsStore.getState().pasteMarkdownEnabled).toBe(false);
  });
});
