// @vitest-environment jsdom
/**
 * v0.13.2 需求5（返修后口径）：撤销历史**按文档独立**保存 / 恢复，**不跨文档**。
 *
 * ## 用户最新原话
 * 「跨文档顺序撤销功能重新调整，不再跨文档，当前文档的编辑撤销和恢复只在当前文档
 *  生效，切换到其他文档进行撤销恢复也是在对应文档，互不干扰。」
 *
 * 上一轮实现的「跨文档顺序撤销」（docUndoOrder 账本 + 自动切标签）已被移除：
 * Ctrl+Z / Ctrl+Y 只作用于**当前文档**。本文件锁住两件事：
 * 1. 每个文档的撤销历史被独立保管（切走再切回来仍能撤），互不污染；
 * 2. 当前文档撤到底时，撤销**不会**切到别的文档去动它的内容。
 *
 * ## 关键坑位（与实现注释同源）
 * history 里的 step 是相对「保存时那份 doc」的，因此快照的 content 必须是**离开时**的
 * `docToMarkdown(view.state.doc)`；装回到内容不一致的 doc 上会抛
 * `RangeError: Position N out of range`。本文件因此既测「内容严格配对时能装回」，
 * 也测「内容不匹配时 `loadDocHistory` 安全丢弃快照」。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeHistory, redo, redoDepth, undo, undoDepth } from "prosemirror-history";
import { EditorState, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import {
  __docHistorySize,
  __resetDocHistoryForTest,
  docHistoryRedoDepth,
  docHistoryUndoDepth,
  forgetDocHistory,
  loadDocHistory,
  pmRedoDepth,
  pmUndoDepth,
  saveDocHistory,
} from "../services/docHistoryStore";
import {
  createEditor,
  getPmHistoryState,
  pmHistoryDepth,
  withPmHistoryState,
} from "../core/editor";
import { docToMarkdown } from "../core/markdown/serializer";
import { markdownToDoc } from "../core/markdown/parser";

// ─────────────────────────── 辅助 ───────────────────────────

/** 挂载真实编辑器（真实插件流水线，含 history） */
function mount(content: string): { view: EditorView; host: HTMLElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = createEditor({ parent: host, initialContent: content })!;
  return { view, host };
}

/**
 * 在文档末尾插入文本，制造一条**独立**的编辑历史。
 *
 * `closeHistory` 把上一次 history 分组切断：连续两次 insertText 在默认 500ms
 * 窗口内会被 prosemirror-history 合并成**一个**事件，那样「3 次编辑」的深度
 * 就只有 1，无法验证逐次撤销。
 */
function typeAtEnd(view: EditorView, text: string): void {
  const end = view.state.doc.content.size - 1;
  const tr = view.state.tr.insertText(text, end);
  closeHistory(tr);
  view.dispatch(tr);
}

/** 模拟 EditorContainer 的换文档：整篇替换 + fileSwitch/resetHistory（+ 可选装回历史） */
function fileSwitch(view: EditorView, content: string, restoreHistory?: unknown): void {
  const newDoc = markdownToDoc(content);
  const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, newDoc.content);
  tr.setSelection(TextSelection.atStart(tr.doc));
  tr.setMeta("fileSwitch", true);
  tr.setMeta("addToHistory", false);
  tr.setMeta("resetHistory", true);
  if (restoreHistory !== undefined) tr.setMeta("restoreHistory", restoreHistory);
  view.dispatch(tr);
}

/** 保存当前文档的撤销快照（与 EditorContainer 的保存口径一致） */
function saveCurrent(view: EditorView, key: string): void {
  saveDocHistory(key, {
    content: docToMarkdown(view.state.doc),
    pmHistory: getPmHistoryState(view.state),
    sourceUndo: [],
    sourceRedo: [],
  });
}

/** 按快照切到目标文档（内容严格配对时才装回历史） */
function switchDoc(view: EditorView, key: string, content: string): void {
  const snap = loadDocHistory(key, content);
  fileSwitch(view, content, snap?.pmHistory);
}

/** 构造一个任意快照（只看深度/存储语义的用例用） */
function snap(content: string, undoN = 0, redoN = 0, sourceUndo: unknown[] = []) {
  return {
    content,
    pmHistory: {
      done: { eventCount: undoN },
      undone: { eventCount: redoN },
    },
    sourceUndo,
    sourceRedo: [],
  };
}

beforeEach(() => {
  __resetDocHistoryForTest();
});

afterEach(() => {
  document.body.innerHTML = "";
  __resetDocHistoryForTest();
});

// ═══════════════════════ (b) 快照仓库 ═══════════════════════

describe("需求5(b)：每文档历史快照仓库（docHistoryStore）", () => {
  it("save→load 往返：内容一致时能取回同一份快照", () => {
    saveDocHistory("a.md", snap("AAA", 2, 1, [1]));
    const loaded = loadDocHistory("a.md", "AAA");
    expect(loaded).not.toBeNull();
    expect(loaded!.content).toBe("AAA");
    expect(pmUndoDepth(loaded!.pmHistory)).toBe(2);
    expect(pmRedoDepth(loaded!.pmHistory)).toBe(1);
    expect(loaded!.sourceUndo).toEqual([1]);
  });

  it("content 不匹配 → 丢弃快照（宁可丢历史，也不能把撤销应用到错误偏移）", () => {
    saveDocHistory("a.md", snap("AAA"));
    expect(loadDocHistory("a.md", "AAA-edited")).toBeNull();
    // 已丢弃：用原内容也取不回来了
    expect(loadDocHistory("a.md", "AAA")).toBeNull();
  });

  it("LRU 上限 40：超出的最早文档被淘汰，最近用过的被保留", () => {
    for (let i = 0; i < 40; i++) saveDocHistory(`doc-${i}`, snap(`c${i}`));
    expect(__docHistorySize()).toBe(40);
    saveDocHistory("doc-40", snap("c40"));
    expect(__docHistorySize()).toBe(40);
    expect(loadDocHistory("doc-0", "c0")).toBeNull(); // 被淘汰
    expect(loadDocHistory("doc-40", "c40")).not.toBeNull();
  });

  it("load 会提升活跃度（最近用过的不会被紧接的新文档挤掉）", () => {
    for (let i = 0; i < 40; i++) saveDocHistory(`doc-${i}`, snap(`c${i}`));
    expect(loadDocHistory("doc-1", "c1")).not.toBeNull();
    saveDocHistory("doc-40", snap("c40")); // 淘汰 doc-0
    saveDocHistory("doc-41", snap("c41")); // 淘汰 doc-2（doc-1 刚用过而幸免）
    expect(loadDocHistory("doc-1", "c1")).not.toBeNull();
    expect(loadDocHistory("doc-2", "c2")).toBeNull();
  });

  it("深度汇报 = PM 历史深度 + 源码 diff 栈深度", () => {
    saveDocHistory("a.md", snap("AAA", 3, 1, [1, 2]));
    expect(docHistoryUndoDepth("a.md")).toBe(5);
    expect(docHistoryRedoDepth("a.md")).toBe(1);
    expect(docHistoryUndoDepth("missing.md")).toBe(0);
  });

  it("pmUndoDepth / pmRedoDepth 对残缺结构做防御性读取（不抛错）", () => {
    expect(pmUndoDepth(null)).toBe(0);
    expect(pmUndoDepth({})).toBe(0);
    expect(pmUndoDepth({ done: { eventCount: -1 } })).toBe(0);
    expect(pmRedoDepth({ undone: { eventCount: 4 } })).toBe(4);
  });

  it("forgetDocHistory：关闭文档即丢弃其历史", () => {
    saveDocHistory("a.md", snap("AAA"));
    forgetDocHistory("a.md");
    expect(loadDocHistory("a.md", "AAA")).toBeNull();
  });
});

// ═══════════════════════ (c) 真实 ProseMirror 往返 ═══════════════════════

describe("需求5(c)：真实 PM —— 每个文档独立撤销 / 恢复", () => {
  it("A 编辑 3 处 → 切 B 编辑 2 处 → 切回 A：A 的 3 步完整可用，B 不受影响", () => {
    const { view } = mount("AAA");
    typeAtEnd(view, "1");
    typeAtEnd(view, "2");
    typeAtEnd(view, "3");
    expect(undoDepth(view.state)).toBe(3);
    const contentA = docToMarkdown(view.state.doc);
    saveCurrent(view, "A");

    // 切到 B：全新历史，编辑 2 处
    switchDoc(view, "B", "BBB");
    expect(undoDepth(view.state)).toBe(0); // 不继承 A 的历史（不跨文档污染）
    typeAtEnd(view, "x");
    typeAtEnd(view, "y");
    expect(undoDepth(view.state)).toBe(2);
    const contentB = docToMarkdown(view.state.doc);
    saveCurrent(view, "B");

    // 在 B 里连续撤销 2 次 → 回到 B 初始内容，且**不会**跳到 A
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(docToMarkdown(view.state.doc).trimEnd()).toBe("BBB");
    // 再撤销：当前文档已到底 → false，内容和文档都不变
    const beforeExtra = docToMarkdown(view.state.doc);
    expect(undo(view.state, view.dispatch)).toBe(false);
    expect(docToMarkdown(view.state.doc)).toBe(beforeExtra);

    // 切回 A：历史装回，3 步都在
    switchDoc(view, "A", contentA);
    expect(undoDepth(view.state)).toBe(3);
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(docToMarkdown(view.state.doc).trimEnd()).toBe("AAA");
    // 撤到底后再撤不会去动 B
    expect(undo(view.state, view.dispatch)).toBe(false);
    expect(docToMarkdown(view.state.doc).trimEnd()).toBe("AAA");

    // B 的快照仍然完好（互不干扰）
    expect(loadDocHistory("B", contentB)).not.toBeNull();
  });

  it("A 撤销后切到 B，B 的恢复栈只恢复 B 自己的编辑", () => {
    const { view } = mount("AAA");
    typeAtEnd(view, "1");
    const contentA = docToMarkdown(view.state.doc);
    saveCurrent(view, "A");

    switchDoc(view, "B", "BBB");
    typeAtEnd(view, "x");
    typeAtEnd(view, "y");
    const contentB = docToMarkdown(view.state.doc);
    saveCurrent(view, "B");
    undo(view.state, view.dispatch);
    expect(redoDepth(view.state)).toBe(1);

    // 切回 A：A 的历史里是「撤 A 自己」的方向，不能把 B 的 redo 带过来
    switchDoc(view, "A", contentA);
    expect(redoDepth(view.state)).toBe(0);
    // A 撤 1 步 → 回到 AAA，再恢复 → 回到 A 编辑后
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(docToMarkdown(view.state.doc).trimEnd()).toBe("AAA");
    expect(redo(view.state, view.dispatch)).toBe(true);
    expect(docToMarkdown(view.state.doc)).toBe(contentA);

    // B 的历史快照独立保留且可恢复（快照是在那次 undo **之前**保存的，故 redo 为 0）
    switchDoc(view, "B", contentB);
    expect(undoDepth(view.state)).toBe(2);
    expect(redoDepth(view.state)).toBe(0);
  });

  it("content 不匹配 → 装回被安全丢弃，history 强度为 0（不会 RangeError）", () => {
    const { view } = mount("AAA");
    typeAtEnd(view, "1");
    saveCurrent(view, "A");
    const contentA = docToMarkdown(view.state.doc);

    // 外部程序改过文件：内容不再逐字节一致
    switchDoc(view, "A", "AAA externally changed");
    expect(undoDepth(view.state)).toBe(0);
    expect(docToMarkdown(view.state.doc)).not.toBe(contentA);
  });

  it("withPmHistoryState：结构非法的快照安全降级为原 state", () => {
    const { view } = mount("AAA");
    typeAtEnd(view, "1");
    const hist = getPmHistoryState(view.state);
    const base = EditorState.create({
      doc: markdownToDoc("BBB"),
      plugins: view.state.plugins,
    });
    expect(withPmHistoryState(base, null)).toBe(base);
    expect(withPmHistoryState(base, {})).toBe(base);
    expect(withPmHistoryState(base, { done: { eventCount: 2 } })).toBe(base);
    const restored = withPmHistoryState(base, hist);
    expect(restored).not.toBe(base);
    expect(pmHistoryDepth(restored).undo).toBe(1);
  });
});
