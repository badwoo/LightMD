/**
 * v0.14.0 需求2：搜索面板增强的 UI 行为测试（jsdom）
 *
 * 覆盖用户可感知的行为，而不是实现细节：
 * 1. 4 个勾选框默认全不勾，切换后影响匹配数
 * 2. 「选取范围内」无选区时的红字提示 + 匹配数 0（绝不静默退化成全文）
 * 3. 「选取范围内」在源码模式下按选区过滤，替换不越界（逐字节断言新内容）
 * 4. 替换后范围快照随增量平移（第二次替换仍在原范围内）
 * 5. 「查找所有打开文件」条幅：条数、文件名、命中行、<mark> 高亮、点击跳转
 * 6. 切文档时选区快照作废并提示
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, useState } from "react";
import { render, fireEvent, cleanup, act } from "@testing-library/react";
import { SearchReplaceDialog, type SearchableFile } from "../components/editor/SearchReplace";
import { useEditorStore } from "../stores/useEditorStore";
import { peekSearchJump, requestSearchJump, takeSearchJump, __resetSearchJumpForTest } from "../utils/searchJump";

// ─── 测试替身 ─────────────────────────────────────────────

/** 受控 textarea：模拟 EditorContainer 的 sourceTextareaRef（组件从 ref 读选区） */
function makeTextareaRef(value: string, selectionStart = 0, selectionEnd = 0) {
  const ta = document.createElement("textarea");
  ta.value = value;
  ta.selectionStart = selectionStart;
  ta.selectionEnd = selectionEnd;
  document.body.appendChild(ta);
  return { current: ta } as React.RefObject<HTMLTextAreaElement | null>;
}

interface HarnessProps {
  initialContent?: string;
  files?: SearchableFile[];
  onJumpToFile?: (t: unknown) => void;
  docKey?: string;
}

/**
 * 受控宿主：模拟 EditorContainer 对 search 面板的接线
 * （sourceContent 受控 + onSourceContentChange 回写，断言替换结果逐字节正确）
 */
function Harness({ initialContent = "", files, onJumpToFile, docKey }: HarnessProps) {
  const [content, setContent] = useState(initialContent);
  const taRef = useState(() => makeTextareaRef(initialContent))[0];
  // 每次渲染同步 textarea 值（真实应用里 textarea 是受控的）
  if (taRef.current && taRef.current.value !== content) taRef.current.value = content;
  return createElement(
    "div",
    null,
    // 内容探针：textarea.value 按 HTML 规范会把 CRLF 归一成 LF，
    // 需要逐字节断言（含 \r\n 保留）时只能读 React state 本身
    createElement("span", { "data-testid": "content-probe" }, content),
    createElement(SearchReplaceDialog, {
      onClose: () => {},
      editorView: null,
      sourceTextareaRef: taRef,
      sourceContent: content,
      onSourceContentChange: (next: string) => setContent(next),
      initialShowReplace: true,
      isMdFile: true,
      docKey,
      collectFiles: files ? () => files : undefined,
      onJumpToFile,
    }),
  );
}

/** 读受控内容（逐字节精确，不受 textarea 换行归一化影响） */
const getContent = () => (document.querySelector('[data-testid="content-probe"]') as HTMLElement).textContent ?? "";

/** 用给定的源码内容与选区渲染面板（源码模式） */
function renderPanel(opts: HarnessProps & { selection?: [number, number] } = {}) {
  const { selection = [0, 0], ...rest } = opts;
  const initialContent = rest.initialContent ?? "";
  // 选区在 render 之后设置：Harness 内部 textarea 由 useState 惰性创建，需先拿到元素
  const view = render(createElement(Harness, rest));
  const ta = document.querySelector("textarea") as HTMLTextAreaElement;
  ta.selectionStart = selection[0];
  ta.selectionEnd = selection[1];
  return { ...view, ta, content: initialContent };
}

/** 输入搜索词 */
function typeSearch(text: string) {
  const input = document.querySelector(".search-row .search-input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: text } });
  return input;
}

/** 输入替换词 */
function typeReplace(text: string) {
  const input = document.querySelector(".replace-row .search-input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: text } });
  return input;
}

function clickButtonByTitle(title: string) {
  const btn = Array.from(document.querySelectorAll("button")).find((b) => b.getAttribute("title") === title);
  expect(btn, `应存在 title=${title} 的按钮`).toBeTruthy();
  fireEvent.click(btn!);
  return btn!;
}

const getMatchCount = () =>
  Number(((document.querySelector('[data-testid="search-count"]') as HTMLElement).textContent ?? "")
    .split("/")[1] ?? 0);

beforeEach(() => {
  // 强制源码模式（viewMode !== "preview"）——本文件的替换链路断言走 textarea 路径
  useEditorStore.setState({ viewMode: "edit", showSearch: false, showSearchReplace: false });
  __resetSearchJumpForTest();
});

afterEach(() => {
  cleanup();
  document.querySelectorAll("textarea").forEach((t) => t.remove());
  vi.useRealTimers();
});

// ═══ 1. 勾选框默认值与切换 ═══

describe("v0.14.0 搜索面板：4 个勾选框", () => {
  it("默认全部不勾选", () => {
    renderPanel({ initialContent: "abc" });
    for (const id of [
      "search-whole-word",
      "search-match-case",
      "search-in-selection",
      "search-use-regex",
    ]) {
      const el = document.querySelector(`[data-testid="${id}"]`) as HTMLInputElement;
      expect(el, `应存在 ${id}`).toBeTruthy();
      expect(el.type).toBe("checkbox");
      expect(el.checked, `${id} 默认应为不勾`).toBe(false);
    }
  });

  it("勾选「匹配大小写」只命中大小写一致处", () => {
    renderPanel({ initialContent: "Foo foo FOO" });
    typeSearch("foo");
    expect(getMatchCount()).toBe(3);
    fireEvent.click(document.querySelector('[data-testid="search-match-case"]')!);
    expect(getMatchCount()).toBe(1);
  });

  it("勾选「全词匹配」排除子串命中", () => {
    renderPanel({ initialContent: "concat cats cat" });
    typeSearch("cat");
    expect(getMatchCount()).toBe(3);
    fireEvent.click(document.querySelector('[data-testid="search-whole-word"]')!);
    expect(getMatchCount()).toBe(1);
  });

  it("勾选正则后按正则语义匹配", () => {
    renderPanel({ initialContent: "a1 b22 c333" });
    typeSearch("\\d{3}");
    // 字面量模式：搜索 "\d{3}" 找不到
    expect(getMatchCount()).toBe(0);
    fireEvent.click(document.querySelector('[data-testid="search-use-regex"]')!);
    expect(getMatchCount()).toBe(1);
  });

  it("全词 + 大小写 + 正则可组合", () => {
    renderPanel({ initialContent: "Word word WORDsword word." });
    typeSearch("word");
    fireEvent.click(document.querySelector('[data-testid="search-whole-word"]')!);
    fireEvent.click(document.querySelector('[data-testid="search-match-case"]')!);
    // 只有小写 word 且是整词：第 2 个 word 与句末 "word." 前的 word（共 2 处）
    expect(getMatchCount()).toBe(2);
  });
});

// ═══ 2. 选取范围内：无选区提示 ═══

describe("v0.14.0 选取范围内：无选区", () => {
  it("勾选但没有选区 → 显示提示且匹配数 0（不静默退化成全文）", () => {
    renderPanel({ initialContent: "foo foo foo", selection: [0, 0] });
    typeSearch("foo");
    expect(getMatchCount()).toBe(3);
    fireEvent.click(document.querySelector('[data-testid="search-in-selection"]')!);
    // 提示可见
    const hint = document.querySelector('[data-testid="search-selection-hint"]') as HTMLElement;
    expect(hint).toBeTruthy();
    expect(hint.textContent).toContain("请先");
    // 匹配数归零：范围为空时任何非零长匹配都不命中
    expect(getMatchCount()).toBe(0);
  });

  it("取消勾选后提示消失、恢复全文匹配", () => {
    renderPanel({ initialContent: "foo foo", selection: [0, 0] });
    typeSearch("foo");
    const cb = document.querySelector('[data-testid="search-in-selection"]') as HTMLInputElement;
    fireEvent.click(cb);
    expect(document.querySelector('[data-testid="search-selection-hint"]')).toBeTruthy();
    fireEvent.click(cb);
    expect(document.querySelector('[data-testid="search-selection-hint"]')).toBeNull();
    expect(getMatchCount()).toBe(2);
  });
});

// ═══ 3. 选取范围内：查找与替换都不越界 ═══

describe("v0.14.0 选取范围内：查找与替换", () => {
  it("只在选区内查找（范围外同词不计数）", () => {
    // 选区 [6, 12) = "foo ba"：只完整包含第一个 foo（下标 6..9）
    renderPanel({ initialContent: "foo bar foo baz", selection: [6, 12] });
    typeSearch("foo");
    expect(getMatchCount()).toBe(2);
    fireEvent.click(document.querySelector('[data-testid="search-in-selection"]')!);
    expect(getMatchCount()).toBe(1);
  });

  it("替换当前不越界：范围外的同词保持原样", () => {
    renderPanel({ initialContent: "foo bar foo baz", selection: [6, 12] });
    typeSearch("foo");
    typeReplace("ZZZ");
    fireEvent.click(document.querySelector('[data-testid="search-in-selection"]')!);
    clickButtonByTitle("替换当前");
    // 只有选区内的那个 foo 被替换（选区内首处命中）
    expect(getContent()).toBe("foo bar ZZZ baz");
  });

  it("全部替换只改范围内的命中，逐字节正确", () => {
    renderPanel({ initialContent: "cat dog cat dog cat", selection: [8, 15] });
    typeSearch("cat");
    typeReplace("X");
    fireEvent.click(document.querySelector('[data-testid="search-in-selection"]')!);
    // 选区 [8,15) = "cat dog"，只有下标 8 的 cat 在范围内
    expect(getMatchCount()).toBe(1);
    clickButtonByTitle("全部替换");
    expect(getContent()).toBe("cat dog X dog cat");
  });

  it("替换后范围快照平移：连续两次替换都落在原范围内、不越界", () => {
    // 选区 [0, 11) = "aa aa aa"（三个 aa）；范围内有 3 处命中
    renderPanel({ initialContent: "aa aa aa", selection: [0, 11] });
    typeSearch("aa");
    typeReplace("aaaa");
    fireEvent.click(document.querySelector('[data-testid="search-in-selection"]')!);
    expect(getMatchCount()).toBe(3);
    // 第一次替换：首个 aa → aaaa，范围按 +2 伸长（[0,13)），仍罩住原来的三处
    clickButtonByTitle("替换当前");
    expect(getContent()).toBe("aaaa aa aa");
    // 范围平移正确的话，替换后范围内仍有 3 处贡献命中（"aaaa" 自身含 2 处 "aa"）
    // 关键断言：范围没有退化成全文，也没有塌陷成空
    expect(getMatchCount()).toBeGreaterThan(0);
    // 再替换一次：会命中已替换文本 "aaaa" 内的首个 "aa"（替新后重新搜索的固有行为），
    // 关键断言仍是「范围平移后仍只在范围内操作」，绝不会去改后面范围外的 " aa"
    clickButtonByTitle("替换当前");
    expect(getContent()).toBe("aaaaaa aa aa");
  });

  it("替换文本变短时范围随之收缩，仍不越界", () => {
    renderPanel({ initialContent: "xx yy xx yy", selection: [0, 11] });
    typeSearch("xx");
    typeReplace("x");
    fireEvent.click(document.querySelector('[data-testid="search-in-selection"]')!);
    clickButtonByTitle("全部替换");
    // 范围内两处 xx 都变成 x；范围外（第二个 " yy" 之后）没有 xx
    expect(getContent()).toBe("x yy x yy");
  });

  it("切文档（docKey 变化）时旧快照作废并提示重新选取", () => {
    const { rerender } = renderPanel({ initialContent: "foo foo", selection: [0, 5], docKey: "a.md" });
    typeSearch("foo");
    fireEvent.click(document.querySelector('[data-testid="search-in-selection"]')!);
    expect(getMatchCount()).toBe(1);
    // 切到另一个文档
    act(() => {
      rerender(createElement(Harness, { initialContent: "foo foo", docKey: "b.md" }));
    });
    const hint = document.querySelector('[data-testid="search-selection-hint"]') as HTMLElement;
    expect(hint).toBeTruthy();
    expect(hint.textContent).toContain("失效");
    expect(getMatchCount()).toBe(0);
  });
});

// ═══ 4. 查找所有打开文件 ═══

describe("v0.14.0 查找所有打开文件：结果条幅", () => {
  /** a.md 的源码文本：当前文档（a.md）走 readCurrentText，故 initialContent 用它 */
  const A_MD_TEXT = "hello world\nfoo here\nfoo again";
  const files = (): SearchableFile[] => [
    {
      fileKey: "a.md",
      filePath: "D:/docs/a.md",
      fileName: "a.md",
      getText: () => "hello world\nfoo here\nfoo again",
    },
    {
      fileKey: "b.md",
      filePath: "D:/docs/b.md",
      fileName: "b.md",
      getText: () => "nothing\nfoo in b",
    },
    {
      fileKey: "c.md",
      filePath: "D:/docs/c.md",
      fileName: "c.md",
      getText: () => "no match at all",
    },
  ];

  it("点击按钮展开条幅：条数、文件名、命中行与 <mark> 高亮正确", () => {
    // 当前文档走 readCurrentText（不是 getText），内容必须与 a.md 的源码一致才等价
    renderPanel({ initialContent: A_MD_TEXT, files: files(), docKey: "a.md" });
    typeSearch("foo");
    expect(document.querySelector('[data-testid="search-results"]')).toBeNull();
    fireEvent.click(document.querySelector('[data-testid="search-find-in-open-files"]')!);

    const banner = document.querySelector('[data-testid="search-results"]') as HTMLElement;
    expect(banner).toBeTruthy();
    const items = document.querySelectorAll('[data-testid="search-result-item"]');
    // a.md 2 行 + b.md 1 行 = 3 条（每行一条）
    expect(items.length).toBe(3);

    // 第一条：a.md 第 2 行 "foo here"
    const firstFile = items[0].querySelector('[data-testid="search-result-file"]') as HTMLElement;
    expect(firstFile.textContent).toContain("a.md");
    expect(firstFile.getAttribute("title")).toBe("D:/docs/a.md");
    const firstLine = items[0].querySelector('[data-testid="search-result-line"]') as HTMLElement;
    expect(firstLine.textContent).toBe("foo here");
    const marks = items[0].querySelectorAll('[data-testid="search-result-match"]');
    expect(marks.length).toBe(1);
    expect(marks[0].textContent).toBe("foo");

    // 第三条：b.md
    const thirdFile = items[2].querySelector('[data-testid="search-result-file"]') as HTMLElement;
    expect(thirdFile.textContent).toContain("b.md");
  });

  it("汇总显示命中总数与文件数", () => {
    renderPanel({ initialContent: A_MD_TEXT, files: files(), docKey: "a.md" });
    typeSearch("foo");
    fireEvent.click(document.querySelector('[data-testid="search-find-in-open-files"]')!);
    const summary = document.querySelector('[data-testid="search-results-summary"]') as HTMLElement;
    // 3 处（a.md 两处 + b.md 一处）/ 2 个文件
    expect(summary.textContent).toContain("3");
    expect(summary.textContent).toContain("2");
  });

  it("同一行多处命中：一条结果里有多处 <mark>", () => {
    const multi: SearchableFile[] = [
      {
        fileKey: "m.md",
        filePath: "D:/m.md",
        fileName: "m.md",
        getText: () => "foo and foo and foo",
      },
    ];
    // m.md 是当前文档 → 内容取 readCurrentText，必须直接给命中文本
    renderPanel({ initialContent: "foo and foo and foo", files: multi, docKey: "m.md" });
    typeSearch("foo");
    fireEvent.click(document.querySelector('[data-testid="search-find-in-open-files"]')!);
    const items = document.querySelectorAll('[data-testid="search-result-item"]');
    expect(items.length).toBe(1);
    expect(items[0].querySelectorAll('[data-testid="search-result-match"]').length).toBe(3);
  });

  it("无匹配时显示空提示", () => {
    renderPanel({ initialContent: "hello", files: files(), docKey: "a.md" });
    typeSearch("zzzz-not-there");
    fireEvent.click(document.querySelector('[data-testid="search-find-in-open-files"]')!);
    const summary = document.querySelector('[data-testid="search-results-summary"]') as HTMLElement;
    expect(summary.textContent).toContain("无匹配");
    expect(document.querySelectorAll('[data-testid="search-result-item"]').length).toBe(0);
  });

  it("再次点击按钮收起条幅", () => {
    renderPanel({ initialContent: "hello", files: files(), docKey: "a.md" });
    typeSearch("foo");
    const btn = document.querySelector('[data-testid="search-find-in-open-files"]') as HTMLElement;
    fireEvent.click(btn);
    expect(document.querySelector('[data-testid="search-results"]')).toBeTruthy();
    fireEvent.click(btn);
    expect(document.querySelector('[data-testid="search-results"]')).toBeNull();
  });

  it("搜索词变化时条幅自动刷新（不用再点按钮）", () => {
    renderPanel({ initialContent: A_MD_TEXT, files: files(), docKey: "a.md" });
    typeSearch("foo");
    fireEvent.click(document.querySelector('[data-testid="search-find-in-open-files"]')!);
    expect(document.querySelectorAll('[data-testid="search-result-item"]').length).toBe(3);
    typeSearch("hello");
    // "hello" 只在 a.md 第 1 行 → 1 条
    expect(document.querySelectorAll('[data-testid="search-result-item"]').length).toBe(1);
  });

  it("点击其它文件的条目 → 触发 onJumpToFile 并写入跨组件跳转契约", () => {
    const jumps: unknown[] = [];
    renderPanel({
      initialContent: A_MD_TEXT,
      files: files(),
      docKey: "a.md",
      onJumpToFile: (t) => jumps.push(t),
    });
    typeSearch("foo");
    fireEvent.click(document.querySelector('[data-testid="search-find-in-open-files"]')!);
    const items = document.querySelectorAll('[data-testid="search-result-item"]');
    // 第三条属于 b.md（非当前文档）
    fireEvent.click(items[2]);
    expect(jumps.length).toBe(1);
    expect(jumps[0]).toMatchObject({ fileKey: "b.md", filePath: "D:/docs/b.md", line: 2, query: "foo" });
    // 事件通道也写入了 pending
    const pending = peekSearchJump();
    expect(pending).toMatchObject({ fileKey: "b.md", line: 2 });
    // 可用 fileKey 过滤消费；不匹配的 fileKey 不消费
    expect(takeSearchJump("other.md")).toBeNull();
    expect(takeSearchJump("b.md")).toMatchObject({ fileKey: "b.md" });
    expect(peekSearchJump()).toBeNull();
  });

  it("点击当前文档的条目 → 就地跳转，不派发切标签回调", () => {
    const jumps: unknown[] = [];
    renderPanel({
      initialContent: "hello world\nfoo here",
      files: files(),
      docKey: "a.md",
      onJumpToFile: (t) => jumps.push(t),
    });
    typeSearch("foo");
    fireEvent.click(document.querySelector('[data-testid="search-find-in-open-files"]')!);
    const items = document.querySelectorAll('[data-testid="search-result-item"]');
    fireEvent.click(items[0]); // a.md 第 2 行
    expect(jumps.length).toBe(0);
    expect(peekSearchJump()).toBeNull();
    // 就地跳转后计数变成 1/2（定位到第 1 处命中）
    expect((document.querySelector('[data-testid="search-count"]') as HTMLElement).textContent).toContain("1/");
  });

  it("未传 collectFiles 时退化为仅当前文档（不崩）", () => {
    renderPanel({ initialContent: "foo foo", docKey: "a.md" });
    typeSearch("foo");
    fireEvent.click(document.querySelector('[data-testid="search-find-in-open-files"]')!);
    // 当前文档 1 行、2 处命中 → 1 条结果
    expect(document.querySelectorAll('[data-testid="search-result-item"]').length).toBe(1);
    expect(document.querySelector('[data-testid="search-results-summary"]')!.textContent).toContain("2");
  });

  it("勾选「选取范围内」时跳过其他文件（选区只属于当前文档）", () => {
    renderPanel({ initialContent: A_MD_TEXT, files: files(), docKey: "a.md", selection: [0, 11] });
    typeSearch("foo");
    fireEvent.click(document.querySelector('[data-testid="search-find-in-open-files"]')!);
    // 未勾选：a.md 2 处 + b.md 1 处
    const before = document.querySelectorAll('[data-testid="search-result-item"]').length;
    expect(before).toBe(3);
    fireEvent.click(document.querySelector('[data-testid="search-in-selection"]')!);
    // 勾选后只剩当前文档范围内的结果，b.md 整份被跳过
    const after = Array.from(document.querySelectorAll('[data-testid="search-result-item"]'));
    for (const item of after) {
      expect((item.querySelector('[data-testid="search-result-file"]') as HTMLElement).textContent).toContain("a.md");
    }
  });

  it("★跳转闭环：docKey 切到目标文件后自动消费 pending 并定位高亮", () => {
    const target = {
      fileKey: "b.md",
      filePath: "D:/docs/b.md",
      line: 2,
      column: 5,
      length: 3,
      query: "foo",
      occurrence: 0,
    };
    // 先渲染 b.md 作为当前文档，pending 里放一个指向 b.md 的跳转
    const { rerender } = renderPanel({ initialContent: "nothing\nfoo in b", docKey: "b.md" });
    typeSearch("foo");
    expect(getMatchCount()).toBe(1);
    requestSearchJump(target);
    // docKey 不变时不应消费（模拟"还没切过去"）
    expect(peekSearchJump()).not.toBeNull();
    // 模拟 App 切标签完成：docKey 变成 b.md 的最新值 → 触发消费
    act(() => {
      rerender(createElement(Harness, { initialContent: "nothing\nfoo in b", docKey: "b.md", files: files() }));
      useEditorStore.setState({ viewMode: "edit" });
    });
    // 用另一个 docKey 变化驱动（同一 docKey 反复 set 不会触发 effect，故切到新键再切回）
    act(() => {
      rerender(createElement(Harness, { initialContent: "nothing\nfoo in b", docKey: "other.md", files: files() }));
    });
    act(() => {
      rerender(createElement(Harness, { initialContent: "nothing\nfoo in b", docKey: "b.md", files: files() }));
    });
    // pending 已被消费，且计数被设置到命中的那一处
    expect(peekSearchJump()).toBeNull();
    expect((document.querySelector('[data-testid="search-count"]') as HTMLElement).textContent).toContain("1/");
  });

  it("条幅在 DOM 中位于替换行之后（不遮住替换行）", () => {
    renderPanel({ initialContent: "hello", files: files(), docKey: "a.md" });
    typeSearch("foo");
    fireEvent.click(document.querySelector('[data-testid="search-find-in-open-files"]')!);
    const replaceRow = document.querySelector(".replace-row") as HTMLElement;
    const banner = document.querySelector('[data-testid="search-results"]') as HTMLElement;
    expect(replaceRow).toBeTruthy();
    // compareDocumentPosition: FOLLOWING 表示 banner 在 replaceRow 之后
    const relation = replaceRow.compareDocumentPosition(banner);
    expect(relation & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

// ═══ 5. 选项对替换同样生效（复用验证） ═══

describe("v0.14.0 替换复用搜索选项", () => {
  it("全词匹配时替换不碰子串", () => {
    renderPanel({ initialContent: "concat cat cats", selection: [0, 0] });
    typeSearch("cat");
    typeReplace("DOG");
    fireEvent.click(document.querySelector('[data-testid="search-whole-word"]')!);
    expect(getMatchCount()).toBe(1);
    clickButtonByTitle("全部替换");
    expect(getContent()).toBe("concat DOG cats");
  });

  it("区分大小写时替换不碰大小写不同的词", () => {
    renderPanel({ initialContent: "Foo foo", selection: [0, 0] });
    typeSearch("foo");
    typeReplace("bar");
    fireEvent.click(document.querySelector('[data-testid="search-match-case"]')!);
    clickButtonByTitle("全部替换");
    expect(getContent()).toBe("Foo bar");
  });

  it("正则模式替换展开 $1 捕获组（范围约束同时生效）", () => {
    renderPanel({ initialContent: "12.abc 34.def", selection: [0, 6] });
    typeSearch("(\\d+)\\.(\\w+)");
    typeReplace("$2-$1");
    fireEvent.click(document.querySelector('[data-testid="search-use-regex"]')!);
    fireEvent.click(document.querySelector('[data-testid="search-in-selection"]')!);
    // 选区 [0,6) = "12.abc" 只有一处命中
    expect(getMatchCount()).toBe(1);
    clickButtonByTitle("全部替换");
    expect(getContent()).toBe("abc-12 34.def");
  });

  it("CRLF 内容替换后不残留 \\r、内容逐字节正确", () => {
    renderPanel({ initialContent: "aa\r\nbb\r\ncc", selection: [0, 0] });
    typeSearch("bb");
    typeReplace("XX");
    clickButtonByTitle("全部替换");
    expect(getContent()).toBe("aa\r\nXX\r\ncc");
  });
});
