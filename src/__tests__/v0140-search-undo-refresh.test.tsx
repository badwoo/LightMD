/**
 * v0.14.0 需求2（续修）：搜索/替换后 Ctrl+Z 撤销 → 搜索框失效。
 *
 * ## 用户原话
 * 「在阅读模式或编辑模式里搜索到内容并执行了替换，然后按快捷键撤销（Ctrl+Z），
 *   内容确实恢复了，但搜索框随之失效（匹配数/定位/高亮不再跟随，或点了没反应）。」
 *
 * ## 实测到的两个**独立**失效点（本文件同时锁定，缺一不可）
 *
 * ① **阅读模式：撤销后 `performSearch` 根本不会重跑。**
 *    `performSearch` 的依赖是
 *    `[searchText, searchOptions, isSourceMode, sourceContent, editorView, isMdFile, viewMode]`。
 *    阅读模式下替换走 PM 事务、撤销走 PM history，两者都**只改 `editorView.state.doc`**：
 *    - `editorView` 还是同一个对象（视图从不重建）；
 *    - `sourceContent`（源码侧 state）在阅读模式**不同步**；
 *    → 依赖一个都没变 → effect 不跑 → `matchesRef` / `offsetMapRef` 仍是撤销前的旧值。
 *    实机/单测证据（修复前）：
 *      `cat dog cat` 搜 cat → 1/2；替换掉第一处 → 1/1；Ctrl+Z 撤销 → 内容回到
 *      `cat dog cat`，但计数**一直停在 1/1**，高亮 Decoration 停在 `9-12`（映射后的残影，
 *      本该回到 `1-4`），点「下一个」原地不动。
 *    宿主传的 `contentVersion` 只在**换文档**时 +1，撤销不会让它变。
 *
 * ② **两种模式共用：替换后 50ms 的 `setTimeout(() => performSearch(), 50)` 捕获了旧闭包。**
 *    源码模式下 `performSearch` 读闭包里的 `sourceContent` 字符串；替换 → 宿主
 *    `setSourceContent(newContent)` → 新 `performSearch` 先算出 1/1，随后那个 50ms 的
 *    **旧闭包**才跑，用旧文本把结果覆盖回 1/2（实测：替换后 700ms 仍显示 1/2）。
 *    阅读模式因为闭包里读的是 `editorView.state.doc`（活对象）才侥幸没暴露。
 *
 * ## 修复
 * - 新增 MutationObserver（只在阅读模式挂载）监听 PM DOM 变化，**用 doc 对象身份做闸门**：
 *   我们自己的高亮 Decoration 事务只改 meta 不改 doc，因此不会自激成环；
 *   doc 换了对象（替换/撤销/恢复/用户输入）就重算。
 *   不用「包 `editorView.dispatch`」：Outline.tsx 已经在包且卸载时还原，两处会互相覆盖。
 * - **doc 变化触发的重搜带 150ms 短防抖**（`CONTENT_RESYNC_DEBOUNCE_MS`）：
 *   连续打字每一击都是新 doc，若每帧全量重扫，几 MB 文档会变成稳定输入卡顿。
 *   替换/全部替换是离散操作，走 `runContentResync()` 立即重算（不等防抖），
 *   并顺带把「已见 doc」闸门推新，避免观察器再补一次重复扫描。
 * - 三处延迟重搜（replaceCurrent / replaceAll / replaceAllAcrossFiles）全部收口到
 *   `runContentResync()` → `performSearchRef.current()`（永远最新闭包）。
 *
 * ## 本文件的测试强度
 * 全部用例都驱动**真实 ProseMirror 视图**（`createEditor` 完整插件栈，含
 * `prosemirror-history`），撤销/恢复通过 **`prosemirror-history` 的 `undo`/`redo`
 * 命令**（`undo(view.state, view.dispatch)`）触发 —— 与 EditorContainer.doLocalUndo
 * 阅读模式分支的调用完全一致，不是纯函数或 mock。
 * 防抖用例通过 spy `findMatchRangesEx` 计数**全文扫描次数**（这是 performSearch 里
 * 唯一的 O(全文) 入口），因此「12 次连续变更只扫 ≤2 次」是可证伪的强断言。
 *
 * ## 修复必须满足（本文件锁定的验收口径）
 * - 撤销/恢复后：匹配数正确、当前索引合理、高亮落在**正确位置**、上下跳转可用；
 * - 搜索词与 4 个勾选项**保持不变**（绝不重建面板、不丢输入）。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, useState } from "react";
import { render, fireEvent, cleanup, act } from "@testing-library/react";
import { undo, redo } from "prosemirror-history";
import { createEditor, searchHighlightKey } from "../core/editor";
import { docToMarkdown } from "../core/markdown/serializer";
import { SearchReplaceDialog } from "../components/editor/SearchReplace";
import { useEditorStore } from "../stores/useEditorStore";
import type { EditorView } from "prosemirror-view";

// ─── 全文扫描计数器（性能断言用）────────────────────────────
//
// 「防抖是否真的生效」只能靠**扫描次数**来断言，不能靠最终匹配数（最终值必然一样）。
// `findMatchRangesEx` 是 performSearch 里唯一的 O(全文) 正则扫描入口，
// 因此对它计数即等价于「全文扫描次数」。
const scan = vi.hoisted(() => ({ count: 0 }));
vi.mock("../utils/searchEngine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/searchEngine")>();
  return {
    ...actual,
    findMatchRangesEx: (...args: Parameters<typeof actual.findMatchRangesEx>) => {
      scan.count++;
      return actual.findMatchRangesEx(...args);
    },
  };
});

// ─── 通用工具 ────────────────────────────────────────────────

/** 建一个真实的阅读模式 EditorView（含完整插件栈 + prosemirror-history） */
function makePmView(markdown: string): { view: EditorView; mount: HTMLElement } {
  const mount = document.createElement("div");
  mount.className = "editor-container";
  document.body.appendChild(mount);
  const view = createEditor({ parent: mount, initialContent: markdown });
  if (!view) throw new Error("createEditor 失败");
  return { view, mount };
}

const countText = () =>
  (document.querySelector('[data-testid="search-count"]') as HTMLElement).textContent ?? "";
/** 匹配总数（"当前/总数" 的后半段） */
const matchCount = () => Number(countText().split("/")[1] ?? 0);
/** 当前匹配序号（1-based；无结果时 0） */
const currentIdx = () => Number(countText().split("/")[0] ?? 0);

const searchInput = () => document.querySelector(".search-row .search-input") as HTMLInputElement;
const replaceInput = () => document.querySelector(".replace-row .search-input") as HTMLInputElement;

function typeSearch(text: string) {
  fireEvent.change(searchInput(), { target: { value: text } });
}
function typeReplace(text: string) {
  fireEvent.change(replaceInput(), { target: { value: text } });
}
function clickByTitle(title: string) {
  const btn = Array.from(document.querySelectorAll("button")).find((b) => b.getAttribute("title") === title);
  if (!btn) throw new Error(`找不到 title=${title} 的按钮`);
  fireEvent.click(btn);
}
function checkbox(id: string) {
  return document.querySelector(`[data-testid="${id}"]`) as HTMLInputElement;
}

/** 读当前搜索高亮 Decoration 覆盖的文本（多处用 " | " 分隔；无高亮返回 ""） */
function highlightedText(view: EditorView): string {
  const set = searchHighlightKey.getState(view.state);
  if (!set) return "";
  return set
    .find()
    .map((d) => view.state.doc.textBetween(d.from, d.to, " "))
    .join(" | ");
}

/** 读当前搜索高亮 Decoration 的 PM 区间（无高亮返回 ""） */
function highlightedRange(view: EditorView): string {
  const set = searchHighlightKey.getState(view.state);
  if (!set) return "";
  return set
    .find()
    .map((d) => `${d.from}-${d.to}`)
    .join(" | ");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 等到面板内所有延迟调度（50ms 重搜 / 160ms 兜底 / MutationObserver 帧）彻底静默 */
const settle = async (ms = 400) => {
  await act(async () => {
    await sleep(ms);
  });
};

beforeEach(() => {
  useEditorStore.setState({ viewMode: "preview", showSearch: false, showSearchReplace: false });
  // highlightMatch 的滚动走 rAF + coordsAtPos；jsdom 下同步执行并容忍异常
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});

afterEach(() => {
  cleanup();
  document.querySelectorAll(".editor-container").forEach((el) => el.remove());
  document.querySelectorAll("textarea").forEach((el) => el.remove());
  vi.unstubAllGlobals();
});

function renderReadingPanel(view: EditorView) {
  render(
    createElement(SearchReplaceDialog, {
      onClose: () => {},
      editorView: view,
      initialShowReplace: true,
      isMdFile: true,
      docKey: "a.md",
    }),
  );
}

// ═══ ① 阅读模式：替换 → 撤销 ═══

describe("v0.14.0 阅读模式：替换后 Ctrl+Z 撤销，搜索框必须继续有效", () => {
  it("撤销后匹配数恢复正确（不是替换后的旧值）", async () => {
    const { view } = makePmView("cat dog cat");
    renderReadingPanel(view);
    typeSearch("cat");
    typeReplace("DOG"); // 替换文本里不含 cat → 替换后命中数真的会变
    await settle();
    expect(matchCount()).toBe(2);

    clickByTitle("替换当前");
    await settle();
    expect(docToMarkdown(view.state.doc).trimEnd()).toBe("DOG dog cat");
    expect(matchCount()).toBe(1);

    // 模拟真实撤销入口：EditorContainer.doLocalUndo → PM undo（同一调用）
    await act(async () => {
      undo(view.state, view.dispatch);
    });
    await settle();

    expect(docToMarkdown(view.state.doc).trimEnd()).toBe("cat dog cat");
    // ★ 核心断言：撤销后必须重算（修复前一直停在 1）
    expect(matchCount()).toBe(2);
    expect(currentIdx()).toBe(1);
    view.destroy();
  }, 30000);

  it("撤销后高亮 Decoration 落在正确的词上（不是映射错位的残影）", async () => {
    const { view } = makePmView("cat dog cat");
    renderReadingPanel(view);
    typeSearch("cat");
    typeReplace("DOG");
    await settle();
    clickByTitle("替换当前");
    await settle();
    await act(async () => {
      undo(view.state, view.dispatch);
    });
    await settle();
    // 当前匹配 = 第 1 处，高亮必须正好罩住第一个 "cat"（PM 1..4）
    expect(highlightedText(view)).toBe("cat");
    expect(highlightedRange(view)).toBe("1-4");
    view.destroy();
  }, 30000);

  it("撤销后点「下一个」能正确定位到第 2 处，再「上一个」回到第 1 处", async () => {
    const { view } = makePmView("cat dog cat");
    renderReadingPanel(view);
    typeSearch("cat");
    typeReplace("DOG");
    await settle();
    clickByTitle("替换当前");
    await settle();
    await act(async () => {
      undo(view.state, view.dispatch);
    });
    await settle();

    clickByTitle("下一个");
    expect(countText()).toBe("2/2");
    expect(highlightedText(view)).toBe("cat");
    // 第二个 cat 的 PM 区间：段落内偏移 8..11 → PM 9..12
    expect(highlightedRange(view)).toBe("9-12");

    clickByTitle("上一个");
    expect(countText()).toBe("1/2");
    expect(highlightedRange(view)).toBe("1-4");
    view.destroy();
  }, 30000);

  it("撤销后再「恢复」（Ctrl+Y）匹配数同样正确", async () => {
    const { view } = makePmView("cat dog cat");
    renderReadingPanel(view);
    typeSearch("cat");
    typeReplace("DOG");
    await settle();
    clickByTitle("替换当前");
    await settle();
    await act(async () => {
      undo(view.state, view.dispatch);
    });
    await settle();
    expect(matchCount()).toBe(2);
    await act(async () => {
      redo(view.state, view.dispatch);
    });
    await settle();
    expect(docToMarkdown(view.state.doc).trimEnd()).toBe("DOG dog cat");
    expect(matchCount()).toBe(1);
    expect(highlightedText(view)).toBe("cat");
    view.destroy();
  }, 30000);

  it("撤销后搜索词与 4 个勾选项保持不变（面板绝不重建/丢输入）", async () => {
    const { view } = makePmView("Cat cat cat");
    renderReadingPanel(view);
    typeSearch("cat");
    typeReplace("DOG");
    // 勾上「匹配大小写」+「全词匹配」
    fireEvent.click(checkbox("search-match-case"));
    fireEvent.click(checkbox("search-whole-word"));
    await settle();
    expect(matchCount()).toBe(2); // Cat 被大小写排除，剩下 2 处小写 cat
    clickByTitle("全部替换");
    await settle();
    expect(docToMarkdown(view.state.doc).trimEnd()).toBe("Cat DOG DOG");
    expect(matchCount()).toBe(0);
    await act(async () => {
      undo(view.state, view.dispatch);
    });
    await settle();

    // ★ 输入与勾选项原样保留
    expect(searchInput().value).toBe("cat");
    expect(replaceInput().value).toBe("DOG");
    expect(checkbox("search-match-case").checked).toBe(true);
    expect(checkbox("search-whole-word").checked).toBe(true);
    expect(checkbox("search-in-selection").checked).toBe(false);
    expect(checkbox("search-use-regex").checked).toBe(false);
    // 且匹配数按原选项重算（Cat 仍被排除）
    expect(matchCount()).toBe(2);
    view.destroy();
  }, 30000);

  it("用户直接编辑 PM（非替换）后搜索也会跟随（同一套内容变化侦测）", async () => {
    const { view } = makePmView("cat dog");
    renderReadingPanel(view);
    typeSearch("cat");
    await settle();
    expect(matchCount()).toBe(1);
    // 模拟用户在阅读模式里插入一个 cat（真实键盘输入也是 doc 变化）
    await act(async () => {
      view.dispatch(view.state.tr.insertText(" cat", 8));
    });
    await settle();
    expect(matchCount()).toBe(2);
    view.destroy();
  }, 30000);

  it("高亮 Decoration 自身不会引发无限重算（doc 身份闸门）", async () => {
    const { view } = makePmView("cat cat cat");
    renderReadingPanel(view);
    typeSearch("cat");
    await settle();
    // 连续点 5 次「下一个」：每次都只改 meta（不改 doc），不得触发重算
    // （若触发，currentMatch 会被 performSearch 重置回 1，表现为点了不动）
    for (let i = 0; i < 5; i++) {
      clickByTitle("下一个");
      await settle(60);
    }
    // 3 处命中循环：1→2→3→1→2→3，第 5 次点击后应在第 3 处
    expect(countText()).toBe("3/3");
    view.destroy();
  }, 30000);

  it("连续快速内容变更（模拟连续输入）时重搜被合并（全文扫描次数远小于击键数）", async () => {
    const { view } = makePmView("cat ");
    renderReadingPanel(view);
    typeSearch("cat");
    await settle();
    expect(matchCount()).toBe(1);

    scan.count = 0;
    // 模拟连续击键：12 次插入，间隔 20ms（远小于 150ms 防抖窗口）
    for (let i = 0; i < 12; i++) {
      await act(async () => {
        view.dispatch(view.state.tr.insertText("cat ", view.state.doc.content.size - 1));
        await sleep(20);
      });
    }
    await settle(400);
    // ★ 关键断言：12 次 doc 变更不得产生 12 次全文扫描。
    // 有防抖时：中间只可能有 1~2 次（防抖到期的那次 + 最终一次），远小于 12。
    expect(scan.count).toBeLessThanOrEqual(2);
    expect(scan.count).toBeGreaterThan(0);
    // 结果仍然正确：初始 1 处 + 新增 12 处 = 13 处
    expect(matchCount()).toBe(13);
    view.destroy();
  }, 30000);
});

// ═══ ② 编辑/源码模式：替换 → 撤销 ═══

/** 受控宿主：模拟 EditorContainer 的源码态接线（sourceContent + onSourceContentChange） */
let sourceApi: { setContent: (s: string) => void } | null = null;

function SourceHost({ initial }: { initial: string }) {
  const [content, setContent] = useState(initial);
  const [taRef] = useState(() => {
    const ta = document.createElement("textarea");
    ta.value = initial;
    // jsdom 不做布局，textarea.offsetParent 恒为 null → highlightMatch 会走
    // 「不可见就只显示计数、不设选区」的分支。这里把它伪装成可见，
    // 好让「撤销后上下跳转仍能定位」这条断言真正覆盖 setSelectionRange 路径。
    Object.defineProperty(ta, "offsetParent", { get: () => document.body, configurable: true });
    document.body.appendChild(ta);
    return { current: ta } as React.RefObject<HTMLTextAreaElement | null>;
  });
  if (taRef.current && taRef.current.value !== content) taRef.current.value = content;
  sourceApi = { setContent };
  return createElement(
    "div",
    null,
    createElement("span", { "data-testid": "content-probe" }, content),
    createElement(SearchReplaceDialog, {
      onClose: () => {},
      editorView: null,
      sourceTextareaRef: taRef,
      sourceContent: content,
      onSourceContentChange: (next: string) => setContent(next),
      initialShowReplace: true,
      isMdFile: true,
      docKey: "a.md",
    }),
  );
}

const contentProbe = () =>
  (document.querySelector('[data-testid="content-probe"]') as HTMLElement).textContent ?? "";

describe("v0.14.0 编辑/源码模式：替换后 Ctrl+Z 撤销，搜索框必须继续有效", () => {
  beforeEach(() => {
    useEditorStore.setState({ viewMode: "edit" });
    sourceApi = null;
  });

  it("替换后匹配数立即正确（50ms 旧闭包不得覆盖新结果）", async () => {
    render(createElement(SourceHost, { initial: "cat dog cat" }));
    typeSearch("cat");
    typeReplace("DOG");
    await settle();
    expect(matchCount()).toBe(2);

    clickByTitle("替换当前");
    await settle();
    expect(contentProbe()).toBe("DOG dog cat");
    // ★ 旧实现：替换后 50ms 的旧闭包把它覆盖回 2
    expect(matchCount()).toBe(1);
  }, 30000);

  it("撤销（宿主回退内容）后匹配数恢复正确，且搜索词/勾选项保留", async () => {
    render(createElement(SourceHost, { initial: "cat dog cat" }));
    typeSearch("cat");
    typeReplace("DOG");
    fireEvent.click(checkbox("search-match-case"));
    await settle();
    clickByTitle("替换当前");
    await settle();
    expect(contentProbe()).toBe("DOG dog cat");
    expect(matchCount()).toBe(1);

    // 模拟宿主撤销：EditorContainer.doLocalUndo 源码分支 → setSourceContent(undoneContent)
    act(() => {
      sourceApi!.setContent("cat dog cat");
    });
    await settle();
    expect(matchCount()).toBe(2);
    expect(currentIdx()).toBe(1);
    expect(searchInput().value).toBe("cat");
    expect(replaceInput().value).toBe("DOG");
    expect(checkbox("search-match-case").checked).toBe(true);
  }, 30000);

  it("撤销后点「下一个」仍可定位（索引在有效范围内）", async () => {
    render(createElement(SourceHost, { initial: "cat dog cat" }));
    typeSearch("cat");
    typeReplace("DOG");
    await settle();
    clickByTitle("替换当前");
    await settle();
    act(() => {
      sourceApi!.setContent("cat dog cat");
    });
    await settle();
    expect(countText()).toBe("1/2");

    clickByTitle("下一个");
    expect(countText()).toBe("2/2");
    const ta = document.querySelector("textarea") as HTMLTextAreaElement;
    expect(ta.selectionStart).toBe(8);
    expect(ta.selectionEnd).toBe(11);
  }, 30000);
});
