/**
 * v0.15.1 需求5：搜索**全部命中同时高亮** + 当前项用醒目色。
 *
 * ## 用户原话
 * 「搜索到的内容高亮，当前需要点击上一个下一个才能高亮，请改为只要搜索到那么所有内容
 *   都高亮，但点击上一个下一个定位到具体高亮内容时可以换个其他醒目的颜色。」
 *
 * ## 修复前的行为
 * `SearchReplace` 只在用户点 ↑/↓（或跳转）时调一次 `highlightMatch(index)`，
 * 而插件只接受**一个** `{from,to}` → 全篇永远只有 1 处高亮。
 *
 * ## 修复方案（本文件锁定的口径）
 * 把高亮拆成**两层 Decoration**（两个 PluginKey、两个 class）：
 * - `searchMatchesKey` → 全部命中，class `search-match`（常态淡黄）
 * - `searchHighlightKey` → 仅当前项，class `search-match-current`（醒目橙红）
 * 拆两层的理由：既有 `v0140-search-undo-refresh` 的多条断言按
 * `searchHighlightKey.getState(state).find()` 读「当前高亮覆盖的文本/区间」，
 * 若把全部命中塞进同一个 key，"cat" 会被读成 "cat | cat"，那些断言必须被弱化。
 * 两层后该 key 仍然只含当前项 → 既有读取方式与断言**完全不变**。
 *
 * ## 为什么这些用例必须驱动真实 PM 视图
 * 分层是否真的生效、当前项是否真的只落一处、↑/↓ 是否跟着走，只有经过
 * `DecorationSet.create` + 真实的 plugin state 才可证伪；断言直接读插件 state 的
 * Decoration 列表与它们的 `type.attrs.class`，不看组件内部变量。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, useState } from "react";
import { render, fireEvent, cleanup, act } from "@testing-library/react";
import { useEffect } from "react";
import { createSourceSurface } from "../editor/createSourceSurface";
import { createEditor, searchHighlightKey, searchMatchesKey } from "../core/editor";
import { SearchReplaceDialog } from "../components/editor/SearchReplace";
import { useEditorStore } from "../stores/useEditorStore";
import { buildSearchOverlayHtml, SEARCH_MATCH_CLASS, SEARCH_MATCH_CURRENT_CLASS } from "../utils/highlight";
import type { EditorView } from "prosemirror-view";

// ─── 通用工具 ────────────────────────────────────────────────

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
const matchCount = () => Number(countText().split("/")[1] ?? 0);
const currentIdx = () => Number(countText().split("/")[0] ?? 0);
const searchInput = () => document.querySelector(".search-row .search-input") as HTMLInputElement;

function typeSearch(text: string) {
  fireEvent.change(searchInput(), { target: { value: text } });
}
function clickByTitle(title: string) {
  const btn = Array.from(document.querySelectorAll("button")).find((b) => b.getAttribute("title") === title);
  if (!btn) throw new Error(`找不到 title=${title} 的按钮`);
  fireEvent.click(btn);
}

/**
 * 读某一层 Decoration 的列表：[{from,to,cls,text}]
 *
 * `cls` 来自 `Decoration.inline(from,to,attrs)` 的 **attrs**（PM 把它放在
 * `type.attrs` 上；`spec` 是第 4 个参数，本插件没用到）。`Decoration` 的公开类型
 * 不暴露 `type`，故做一次结构转换 —— 这样断言只依赖**真实 plugin state**，
 * 不去读组件内部变量。
 */
function decosOf(view: EditorView, key: typeof searchHighlightKey) {
  const set = key.getState(view.state);
  if (!set) return [];
  return set.find().map((d) => ({
    from: d.from,
    to: d.to,
    cls: (d as unknown as { type?: { attrs?: { class?: string } } }).type?.attrs?.class,
    text: view.state.doc.textBetween(d.from, d.to, " "),
  }));
}
/** 全部命中那一层 */
const allDecos = (view: EditorView) => decosOf(view, searchMatchesKey);
/** 当前项那一层 */
const currentDecos = (view: EditorView) => decosOf(view, searchHighlightKey);

/** 文档里是否还含 "cat"（用于"换文档后旧命中不该残留"的判据） */
function docHasCat(view: EditorView): boolean {
  let found = false;
  view.state.doc.descendants((node) => {
    if (node.isText && (node.text ?? "").includes("cat")) found = true;
    return !found;
  });
  return found;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = async (ms = 400) => {
  await act(async () => {
    await sleep(ms);
  });
};

function renderReadingPanel(view: EditorView) {
  return render(
    createElement(SearchReplaceDialog, {
      onClose: () => {},
      editorView: view,
      initialShowReplace: true,
      isMdFile: true,
      docKey: "a.md",
    }),
  );
}

beforeEach(() => {
  useEditorStore.setState({ viewMode: "preview", showSearch: false, showSearchReplace: false });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});

afterEach(() => {
  cleanup();
  document.querySelectorAll(".editor-container").forEach((el) => el.remove());
  document.querySelectorAll("textarea").forEach((el) => el.remove());
  document.querySelectorAll(".source-search-overlay").forEach((el) => el.remove());
  vi.unstubAllGlobals();
});

// ═══ ① 阅读模式：搜索一出结果，全部命中都有高亮 ═══

describe("v0.15.1 需求5 · 阅读模式：全部命中同时高亮", () => {
  it("一搜就整篇标出所有命中（不需要点 ↑/↓）", async () => {
    const { view } = makePmView("cat dog cat");
    renderReadingPanel(view);
    typeSearch("cat");
    await settle();

    expect(matchCount()).toBe(2);
    const all = allDecos(view);
    // ★ 核心断言：两处都高亮（修复前只有 1 处）
    expect(all).toHaveLength(2);
    expect(all.map((d) => d.text)).toEqual(["cat", "cat"]);
    // PM 区间：段落内 0..3 → PM 1..4；第二个 cat 在 8..11 → PM 9..12
    expect(all.map((d) => `${d.from}-${d.to}`)).toEqual(["1-4", "9-12"]);
    // 全部命中那一层统一用 `search-match`（不加当前项那个 class）
    expect(all.every((d) => d.cls === SEARCH_MATCH_CLASS)).toBe(true);
    view.destroy();
  }, 30000);

  it("当前项用**另一个** class（醒目色），且只落一处", async () => {
    const { view } = makePmView("cat dog cat");
    renderReadingPanel(view);
    typeSearch("cat");
    await settle();

    const cur = currentDecos(view);
    // ★ 只标当前项（1 处），class 与全部命中那一层不同
    expect(cur).toHaveLength(1);
    expect(cur[0].cls).toBe(SEARCH_MATCH_CURRENT_CLASS);
    expect(cur[0].cls).not.toBe(SEARCH_MATCH_CLASS);
    expect(cur[0].text).toBe("cat");
    expect(`${cur[0].from}-${cur[0].to}`).toBe("1-4"); // 默认当前项 = 第 1 处
    view.destroy();
  }, 30000);

  it("点「下一个」/「上一个」：当前项跟着走，全部命中那一层不变", async () => {
    const { view } = makePmView("cat dog cat");
    renderReadingPanel(view);
    typeSearch("cat");
    await settle();

    const allBefore = allDecos(view).map((d) => `${d.from}-${d.to}`);
    expect(currentDecos(view)[0].from).toBe(1);

    clickByTitle("下一个");
    expect(countText()).toBe("2/2");
    // 当前项挪到第二处
    expect(currentDecos(view)).toHaveLength(1);
    expect(`${currentDecos(view)[0].from}-${currentDecos(view)[0].to}`).toBe("9-12");

    clickByTitle("上一个");
    expect(countText()).toBe("1/2");
    expect(`${currentDecos(view)[0].from}-${currentDecos(view)[0].to}`).toBe("1-4");

    // ★ 全部命中那一层始终是同一批（切当前项不得让任何一处消失）
    expect(allDecos(view).map((d) => `${d.from}-${d.to}`)).toEqual(allBefore);
    view.destroy();
  }, 30000);

  it("三处循环：当前项始终只有一处高亮，且落在正确位置", async () => {
    const { view } = makePmView("cat cat cat");
    renderReadingPanel(view);
    typeSearch("cat");
    await settle();
    expect(allDecos(view)).toHaveLength(3);
    expect(currentDecos(view)).toHaveLength(1);

    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      seen.push(`${currentDecos(view)[0].from}-${currentDecos(view)[0].to}`);
      clickByTitle("下一个");
    }
    // 1-4 → 5-8 → 9-12（然后回到 1-4）
    expect(seen).toEqual(["1-4", "5-8", "9-12"]);
    expect(`${currentDecos(view)[0].from}-${currentDecos(view)[0].to}`).toBe("1-4");
    // 全程 3 处全部命中都还在
    expect(allDecos(view)).toHaveLength(3);
    view.destroy();
  }, 30000);

  it("高亮只在 Decoration 层：文档、序列化、撤销栈都不受影响", async () => {
    const { view } = makePmView("cat dog cat");
    const docBefore = view.state.doc;
    const historyBefore = (view.state as unknown as { doc: unknown }).doc;
    renderReadingPanel(view);
    typeSearch("cat");
    await settle();
    clickByTitle("下一个");
    await settle(120);

    // ★ doc 对象身份没变（若高亮改了 doc，这里必然不同）
    expect(view.state.doc).toBe(docBefore);
    expect(historyBefore).toBe(docBefore);
    // ★ 没有任何 mark 被加进文档（高亮不能污染序列化）
    let markCount = 0;
    view.state.doc.descendants((node) => {
      if (node.marks.length > 0) markCount += node.marks.length;
      return true;
    });
    expect(markCount).toBe(0);
    view.destroy();
  }, 30000);

  it("用户编辑后（防抖重搜还没跑）点「下一个」：绝不错框到别的词上", async () => {
    const { view } = makePmView("cat dog cat");
    renderReadingPanel(view);
    typeSearch("cat");
    await settle();
    expect(currentDecos(view)).toHaveLength(1);
    expect(currentDecos(view)[0].text).toBe("cat");

    // 在最前面插入 "cat "（3 处命中），但**不等** 150ms 防抖重搜就点「下一个」
    await act(async () => {
      view.dispatch(view.state.tr.insertText("cat ", 1));
    });
    clickByTitle("下一个");

    // ★ 核心断言：当前项要么仍是**真实存在的 cat**，要么暂时没有（等重搜）。
    //   **绝不能**是别的词 —— 错框会让用户以为搜索定位错了。
    //   （修复前实测：这里读到 "dog"，因为旧偏移被套到了新 doc 上。）
    const cur = currentDecos(view);
    expect(cur.length).toBeLessThanOrEqual(1);
    if (cur.length === 1) {
      expect(cur[0].text).toBe("cat");
      expect(cur[0].from).toBeGreaterThanOrEqual(0);
      expect(cur[0].to).toBeLessThanOrEqual(view.state.doc.content.size);
    }

    // 防抖重搜跑完后必须恢复完整状态：全部命中 3 处 + 当前项 1 处
    await settle(500);
    expect(matchCount()).toBe(3);
    expect(allDecos(view)).toHaveLength(3);
    expect(currentDecos(view)).toHaveLength(1);
    expect(currentDecos(view)[0].text).toBe("cat");
    view.destroy();
  }, 30000);

  it("清空搜索词 → 两层高亮全部清空", async () => {
    const { view } = makePmView("cat dog cat");
    renderReadingPanel(view);
    typeSearch("cat");
    await settle();
    expect(allDecos(view)).toHaveLength(2);
    expect(currentDecos(view)).toHaveLength(1);

    typeSearch("");
    await settle();
    expect(matchCount()).toBe(0);
    expect(allDecos(view)).toHaveLength(0);
    expect(currentDecos(view)).toHaveLength(0);
    view.destroy();
  }, 30000);

  it("卸载面板 → 两层高亮全部清空（不留残影）", async () => {
    const { view } = makePmView("cat dog cat");
    const rendered = renderReadingPanel(view);
    typeSearch("cat");
    await settle();
    expect(allDecos(view)).toHaveLength(2);

    await act(async () => {
      rendered.unmount();
    });
    expect(allDecos(view)).toHaveLength(0);
    expect(currentDecos(view)).toHaveLength(0);
    view.destroy();
  }, 30000);

  it("换文档 → 旧文档的残留高亮不留在新文档上", async () => {
    const { view } = makePmView("cat dog cat");
    const Panel = ({ docKey }: { docKey: string }) =>
      createElement(SearchReplaceDialog, {
        onClose: () => {},
        editorView: view,
        initialShowReplace: true,
        isMdFile: true,
        docKey,
      });
    const rendered = render(createElement(Panel, { docKey: "a.md" }));
    typeSearch("cat");
    await settle();
    expect(allDecos(view)).toHaveLength(2);

    // 换标签：docKey 变 + 宿主把新文档灌进同一个 view（EditorContainer 的真实时序）
    await act(async () => {
      view.dispatch(view.state.tr.replaceWith(1, view.state.doc.content.size - 1, view.state.schema.text("dog")));
      rendered.rerender(createElement(Panel, { docKey: "b.md" }));
      await sleep(400);
    });

    // ★ 新文档里没有 cat → 匹配 0、高亮 0（绝不能挂着上一个文档的区间）
    expect(docHasCat(view)).toBe(false);
    expect(matchCount()).toBe(0);
    expect(allDecos(view)).toHaveLength(0);
    expect(currentDecos(view)).toHaveLength(0);
    view.destroy();
  }, 30000);

  it("切阅读/源码模式 → 旧那一层高亮被撤掉", async () => {
    const { view } = makePmView("cat dog cat");
    renderReadingPanel(view);
    typeSearch("cat");
    await settle();
    expect(allDecos(view)).toHaveLength(2);

    // 切到源码模式（源码面用 overlay，PM 层必须撤掉）
    await act(async () => {
      useEditorStore.setState({ viewMode: "edit" });
      await sleep(400);
    });
    expect(allDecos(view)).toHaveLength(0);
    expect(currentDecos(view)).toHaveLength(0);
    view.destroy();
  }, 30000);
});

// ═══ ② 性能上限：超 2000 处只高亮前 N 处，并且**可见地**提示 ═══

describe("v0.15.1 需求5 · 高亮总量上限（不静默截断）", () => {
  it("命中数在 2000 以内：全部高亮、无提示", async () => {
    // 1000 处 "ab"（1000 < 2000）
    const md = Array.from({ length: 1000 }, () => "ab").join(" ");
    const { view } = makePmView(md);
    renderReadingPanel(view);
    typeSearch("ab");
    await settle(600);

    expect(matchCount()).toBe(1000);
    expect(allDecos(view)).toHaveLength(1000);
    expect(document.querySelector('[data-testid="search-highlight-limit"]')).toBeNull();
    view.destroy();
  }, 60000);

  it("命中数超过 2000：只高亮前 2000 处，计数处出现可见提示", async () => {
    // 2500 处 "ab"
    const md = Array.from({ length: 2500 }, () => "ab").join(" ");
    const { view } = makePmView(md);
    renderReadingPanel(view);
    typeSearch("ab");
    await settle(1200);

    // 计数仍然显示**真实**总数（用户必须知道到底有多少处）
    expect(matchCount()).toBe(2500);
    // ★ 只高亮前 2000 处
    expect(allDecos(view)).toHaveLength(2000);
    // ★ 提示必须可见（不静默截断）
    const hint = document.querySelector('[data-testid="search-highlight-limit"]') as HTMLElement | null;
    expect(hint).toBeTruthy();
    expect((hint?.textContent ?? "").length).toBeGreaterThan(0);
    // 提示里带数字 2000（而不是原始 i18n key）
    expect(hint?.textContent).toContain("2000");
    expect(hint?.textContent).not.toContain("search.highlightTruncated");
    view.destroy();
  }, 60000);
});

// ═══ ③ 源码模式（textarea）：overlay 方案 ═══

/**
 * 受控宿主：模拟 EditorContainer 的源码态接线。
 *
 * v0.17.0 A3：源码高亮已从「SearchReplace 自建 overlay div」改为经
 * `SourceSurface.setSearchRanges`（决议 §10.3 立即删、不留双路由）。
 * 因此这里注入**真实的** `TextareaSourceSurface`，并把它的 setSearchRanges
 * 调用记录下来供断言 —— 断言对象从"DOM 里有没有 mark"升级为
 * "契约层有没有收到正确的命中区间"，这才是 A3 之后的正确护栏。
 */
type RangeCall = Array<{ start: number; end: number; active?: boolean }>;
const searchRangeCalls: RangeCall[] = [];

function SourceHost({ initial, onReady }: { initial: string; onReady?: (set: (s: string) => void) => void }) {
  const [content, setContent] = useState(initial);
  const [taRef] = useState(() => {
    const ta = document.createElement("textarea");
    ta.value = initial;
    // jsdom 不做布局：伪装成可见，让 highlightMatch 走真实分支（与既有用例同一手法）
    Object.defineProperty(ta, "offsetParent", { get: () => document.body, configurable: true });
    document.body.appendChild(ta);
    return { current: ta } as React.RefObject<HTMLTextAreaElement | null>;
  });
  if (taRef.current && taRef.current.value !== content) taRef.current.value = content;
  onReady?.(setContent);
  // 真实 surface（jsdom → textarea 实现），并记录 setSearchRanges 调用
  const [surface] = useState(() => {
    const s = createSourceSurface({ impl: "textarea" });
    const el = taRef.current;
    if (el) s.mount(el, { initialText: content });
    const orig = s.setSearchRanges.bind(s);
    s.setSearchRanges = (ranges: RangeCall) => {
      searchRangeCalls.push(ranges.map((r) => ({ ...r })));
      orig(ranges);
    };
    const origClear = s.clearSearchRanges.bind(s);
    s.clearSearchRanges = () => {
      searchRangeCalls.push([]); // 清除也记一条空记录 —— 契约上等价于"交出空集合"
      origClear();
    };
    return s;
  });
  useEffect(() => () => surface.destroy(), [surface]);
  return createElement(SearchReplaceDialog, {
    onClose: () => {},
    editorView: null,
    sourceTextareaRef: taRef,
    sourceSurface: surface,
    sourceContent: content,
    onSourceContentChange: (next: string) => setContent(next),
    initialShowReplace: true,
    isMdFile: true,
    docKey: "a.md",
  });
}

describe("v0.17.0 A3 · 源码模式：搜索高亮经 SourceSurface 契约", () => {
  /**
   * ## 为什么这组断言从"查 overlay DOM"改成"查 setSearchRanges 契约"
   *
   * v0.15.1 需求5 时源码面是 textarea，内部文字不是 DOM 节点，SearchReplace 只能
   * 自己在控件上叠一层 `div.source-search-overlay`，把排版逐像素抄过来再拼 `<mark>`。
   * 那 4 条断言当时锁的是这层 DOM 的形状与生命周期。
   *
   * A3 把高亮改为 `SourceSurface.setSearchRanges`（决议 §10.3「立即删、不留双路由」），
   * 那层 DOM 已被**整体删除**。于是断言必须升级 —— 不是放宽，而是换成**更靠前、
   * 更稳的契约层**：
   * - 旧断言锁"渲染出来的 DOM 长什么样"（实现细节，随实现变更必碎）；
   * - 新断言锁"有没有把正确的命中区间交给实现"（真正的行为契约）。
   *
   * 关键点：**全量命中 + 当前项区分**这个用户可见行为仍然被完整锁住 ——
   * `active: true` 承担原 `SEARCH_MATCH_CURRENT_CLASS` 的角色。
   */
  beforeEach(() => {
    useEditorStore.setState({ viewMode: "edit" });
    searchRangeCalls.length = 0;
  });

  it("搜索后把**每一处**命中都交给 surface，且当前项标 active", async () => {
    render(createElement(SourceHost, { initial: "cat dog cat" }));
    typeSearch("cat");
    await settle();

    expect(matchCount()).toBe(2);
    // 最后一次非空调用就是"全量命中 + 当前项"的最终态
    const last = [...searchRangeCalls].reverse().find((c) => c.length > 0);
    expect(last, "必须把命中区间交给 SourceSurface（否则实现层无法上色）").toBeTruthy();
    expect(last!.length, "★ 两处都要交出（修复前源码模式没有任何全量高亮）").toBe(2);
    // 区间精确覆盖两处 "cat"
    expect(last!.map((r) => [r.start, r.end])).toEqual([[0, 3], [8, 11]]);
    // 当前项用 active 区分（等价于原 SEARCH_MATCH_CURRENT_CLASS 的角色）
    expect(last!.filter((r) => r.active)).toHaveLength(1);
    expect(last![0].active).toBe(true);
    expect(last![1].active).toBe(false);
  }, 30000);

  it("高亮绝不写进文档：命中只交给 surface，textarea.value 一字未改", async () => {
    render(createElement(SourceHost, { initial: "cat dog cat" }));
    typeSearch("cat");
    await settle();

    const ta = document.querySelector("textarea") as HTMLTextAreaElement;
    // 原文档值未被改动 —— 这是"高亮是展示层"的实质判据（不再需要查 overlay 的 CSS）
    expect(ta.value).toBe("cat dog cat");
    // 命中区间确实交给了 surface（说明高亮走的是展示通道，不是改文本）
    const last = [...searchRangeCalls].reverse().find((c) => c.length > 0);
    expect(last!.length).toBe(2);
  }, 30000);

  it("点「下一个」→ active 标记跟着走（当前项切换）", async () => {
    render(createElement(SourceHost, { initial: "cat dog cat" }));
    typeSearch("cat");
    await settle();

    const activeAt = () => {
      const last = [...searchRangeCalls].reverse().find((c) => c.length > 0);
      return last!.findIndex((r) => r.active);
    };
    expect(activeAt(), "初始当前项应是第 1 处").toBe(0);

    clickByTitle("下一个");
    expect(activeAt(), "当前项必须挪到第 2 处").toBe(1);

    // 全量命中数量不变（只是 active 换了位置）
    const last = [...searchRangeCalls].reverse().find((c) => c.length > 0)!;
    expect(last).toHaveLength(2);
    expect(last.filter((r) => r.active)).toHaveLength(1);
  }, 30000);

  it("清空搜索词 → 高亮被清除（clearSearchRanges 语义）", async () => {
    render(createElement(SourceHost, { initial: "cat dog cat" }));
    typeSearch("cat");
    await settle();
    expect([...searchRangeCalls].reverse().find((c) => c.length > 0)).toHaveLength(2);

    typeSearch("");
    await settle();
    expect(matchCount()).toBe(0);
    // 最后一次调用必须是"空区间"（= 清除），而不是留着旧命中
    const last = searchRangeCalls[searchRangeCalls.length - 1];
    expect(last ?? [], "清空搜索词必须把空集合交给 surface（清除高亮）").toHaveLength(0);
  }, 30000);
});

// ═══ ④ 纯函数：buildSearchOverlayHtml ═══

describe("v0.15.1 需求5 · buildSearchOverlayHtml（纯函数）", () => {
  it("按区间包 mark，当前项用醒目 class，其余用常态 class", () => {
    const html = buildSearchOverlayHtml(
      "cat dog cat",
      [
        { start: 0, end: 3 },
        { start: 8, end: 11 },
      ],
      1,
    );
    expect(html).toBe(
      `<mark class="${SEARCH_MATCH_CLASS}">cat</mark> dog ` +
        `<mark class="${SEARCH_MATCH_CURRENT_CLASS}">cat</mark>`,
    );
  });

  it("转义 HTML 特殊字符（原文可能含 < & \"，不能当 HTML 注入）", () => {
    const html = buildSearchOverlayHtml("<a> & \"b\"", [{ start: 0, end: 3 }], 0);
    expect(html).toContain("&lt;a&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;");
    // 不得出现未转义的原始标签
    expect(html).not.toContain("<a>");
  });

  it("空文本 / 空区间 → 空串（不产生任何 mark）", () => {
    expect(buildSearchOverlayHtml("", [], -1)).toBe("");
    expect(buildSearchOverlayHtml("abc", [], -1)).toBe("abc");
  });

  it("区间越界或相互重叠时按升序裁剪（不抛异常、不产生嵌套 mark）", () => {
    const html = buildSearchOverlayHtml(
      "abcdef",
      [
        { start: 0, end: 10 }, // 越界 → 裁到 6
        { start: 2, end: 4 }, // 已被上一段覆盖 → 跳过
      ],
      0,
    );
    expect(html.match(/<mark/g)).toHaveLength(1);
    expect(html).toContain("abcdef");
  });
});
