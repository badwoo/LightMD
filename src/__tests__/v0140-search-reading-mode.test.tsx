/**
 * v0.14.0 需求2：搜索增强在**阅读模式**（真实 ProseMirror）下生效
 *
 * 为什么单独一个文件：用户明确要求「搜索功能要保证在阅读模式和编辑模式下都生效」，
 * 而 v0140-search-ui.test.tsx 走的是源码 textarea 路径。两条路径的坐标系完全不同
 * （PM 文档位置 vs 文本偏移），范围过滤与替换必须在 PM 路径上也被真实覆盖，
 * 否则「选取范围内」在阅读模式下静默退化成全文替换——这正是本次要防的回归。
 *
 * 这里用真实的 EditorView（jsdom 可跑）+ 真实 markdownToDoc，不 mock ProseMirror。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { render, fireEvent, cleanup, act } from "@testing-library/react";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import { SearchReplaceDialog } from "../components/editor/SearchReplace";
import { useEditorStore } from "../stores/useEditorStore";
import { buildOffsetMap } from "../utils/searchEngine";

/** 建一个真实的阅读模式 EditorView（挂到 document.body，供 highlightMatch 里的 DOM 查询使用） */
function makePmView(markdown: string): { view: EditorView; mount: HTMLElement } {
  const doc = markdownToDoc(markdown);
  const mount = document.createElement("div");
  mount.className = "editor-container";
  document.body.appendChild(mount);
  const view = new EditorView({ mount }, { state: EditorState.create({ doc }) });
  return { view, mount };
}

/** 在 PM 文档里选中「文本偏移区间 [start,end)」对应的位置 */
function selectTextRange(view: EditorView, start: number, end: number) {
  const map = buildOffsetMap(view.state.doc);
  // 在映射块里找到同时覆盖起终点的文本节点，换算 PM 位置
  const toPm = (offset: number) => {
    for (const b of map.blocks) {
      if (offset >= b.textStart && offset <= b.textEnd) {
        return b.pmStart + (offset - b.textStart);
      }
    }
    return undefined;
  };
  const from = toPm(start);
  const to = toPm(end);
  if (from === undefined || to === undefined) throw new Error(`无法映射选区间 [${start},${end})`);
  act(() => {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
  });
}

const getMatchCount = () =>
  Number(((document.querySelector('[data-testid="search-count"]') as HTMLElement).textContent ?? "")
    .split("/")[1] ?? 0);

function typeSearch(text: string) {
  const input = document.querySelector(".search-row .search-input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: text } });
}

function typeReplace(text: string) {
  const input = document.querySelector(".replace-row .search-input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: text } });
}

function clickButtonByTitle(title: string) {
  const btn = Array.from(document.querySelectorAll("button")).find((b) => b.getAttribute("title") === title);
  expect(btn, `应存在 title=${title} 的按钮`).toBeTruthy();
  fireEvent.click(btn!);
}

beforeEach(() => {
  // 阅读模式：viewMode === "preview"（isSourceMode 为 false）
  useEditorStore.setState({ viewMode: "preview", showSearch: false, showSearchReplace: false });
  // highlightMatch 的滚动逻辑走 requestAnimationFrame + coordsAtPos；jsdom 下直接同步执行并容忍异常
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});

afterEach(() => {
  cleanup();
  document.querySelectorAll(".editor-container").forEach((el) => el.remove());
  vi.unstubAllGlobals();
});

describe("v0.14.0 阅读模式：基础匹配", () => {
  it("在 PM 文档中能搜到匹配（匹配数来自 offsetMap.text）", () => {
    const { view } = makePmView("hello world hello");
    render(
      createElement(SearchReplaceDialog, {
        onClose: () => {},
        editorView: view,
        sourceContent: undefined,
        initialShowReplace: true,
        isMdFile: true,
      }),
    );
    typeSearch("hello");
    expect(getMatchCount()).toBe(2);
    view.destroy();
  });

  it("全词匹配在阅读模式同样生效", () => {
    const { view } = makePmView("concat cat cats");
    render(
      createElement(SearchReplaceDialog, {
        onClose: () => {},
        editorView: view,
        initialShowReplace: true,
        isMdFile: true,
      }),
    );
    typeSearch("cat");
    expect(getMatchCount()).toBe(3);
    fireEvent.click(document.querySelector('[data-testid="search-whole-word"]')!);
    expect(getMatchCount()).toBe(1);
    view.destroy();
  });

  it("匹配大小写在阅读模式同样生效", () => {
    const { view } = makePmView("Foo foo FOO");
    render(
      createElement(SearchReplaceDialog, {
        onClose: () => {},
        editorView: view,
        initialShowReplace: true,
        isMdFile: true,
      }),
    );
    typeSearch("foo");
    expect(getMatchCount()).toBe(3);
    fireEvent.click(document.querySelector('[data-testid="search-match-case"]')!);
    expect(getMatchCount()).toBe(1);
    view.destroy();
  });
});

describe("v0.14.0 阅读模式：选取范围内", () => {
  it("从 PM 选区捕获范围快照，只统计范围内的命中", () => {
    const { view } = makePmView("aaa bbb aaa bbb");
    // "aaa bbb aaa bbb"：第一个 aaa 在 [0,3)，第二个 aaa 在 [8,11)
    render(
      createElement(SearchReplaceDialog, {
        onClose: () => {},
        editorView: view,
        initialShowReplace: true,
        isMdFile: true,
      }),
    );
    typeSearch("aaa");
    expect(getMatchCount()).toBe(2);
    // 只选第二个 aaa
    selectTextRange(view, 8, 11);
    fireEvent.click(document.querySelector('[data-testid="search-in-selection"]')!);
    expect(document.querySelector('[data-testid="search-selection-hint"]')).toBeNull();
    expect(getMatchCount()).toBe(1);
    view.destroy();
  });

  it("无选区时勾选 → 提示且匹配数 0", () => {
    const { view } = makePmView("aaa bbb aaa");
    render(
      createElement(SearchReplaceDialog, {
        onClose: () => {},
        editorView: view,
        initialShowReplace: true,
        isMdFile: true,
      }),
    );
    typeSearch("aaa");
    expect(getMatchCount()).toBe(2);
    fireEvent.click(document.querySelector('[data-testid="search-in-selection"]')!);
    expect(document.querySelector('[data-testid="search-selection-hint"]')).toBeTruthy();
    expect(getMatchCount()).toBe(0);
    view.destroy();
  });

  it("★阅读模式全部替换只在范围内生效（旧实现会全文替换）", () => {
    const { view } = makePmView("aaa bbb aaa bbb aaa");
    render(
      createElement(SearchReplaceDialog, {
        onClose: () => {},
        editorView: view,
        initialShowReplace: true,
        isMdFile: true,
      }),
    );
    typeSearch("aaa");
    typeReplace("X");
    // 只选中中间那个 aaa：[8, 11)
    selectTextRange(view, 8, 11);
    fireEvent.click(document.querySelector('[data-testid="search-in-selection"]')!);
    expect(getMatchCount()).toBe(1);
    clickButtonByTitle("全部替换");
    // 只有范围内的 aaa 被替换，两端保持不变
    expect(docToMarkdown(view.state.doc).trimEnd()).toBe("aaa bbb X bbb aaa");
    view.destroy();
  });

  it("★阅读模式替换当前同样受范围约束", () => {
    const { view } = makePmView("aaa bbb aaa");
    render(
      createElement(SearchReplaceDialog, {
        onClose: () => {},
        editorView: view,
        initialShowReplace: true,
        isMdFile: true,
      }),
    );
    typeSearch("aaa");
    typeReplace("Y");
    selectTextRange(view, 8, 11);
    fireEvent.click(document.querySelector('[data-testid="search-in-selection"]')!);
    expect(getMatchCount()).toBe(1);
    clickButtonByTitle("替换当前");
    expect(docToMarkdown(view.state.doc).trimEnd()).toBe("aaa bbb Y");
    view.destroy();
  });

  it("阅读模式下选区跨段落时范围过滤仍按文本偏移正确工作", () => {
    // 两个段落：第一段 "foo bar"，第二段 "foo baz"
    const { view } = makePmView("foo bar\n\nfoo baz");
    render(
      createElement(SearchReplaceDialog, {
        onClose: () => {},
        editorView: view,
        initialShowReplace: true,
        isMdFile: true,
      }),
    );
    typeSearch("foo");
    expect(getMatchCount()).toBe(2);
    // 只选第一段（文本偏移 [0,3)）
    selectTextRange(view, 0, 3);
    fireEvent.click(document.querySelector('[data-testid="search-in-selection"]')!);
    expect(getMatchCount()).toBe(1);
    view.destroy();
  });
});
