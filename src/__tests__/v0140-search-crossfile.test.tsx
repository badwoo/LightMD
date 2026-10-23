/**
 * v0.14.0 需求4 + 需求5 回归测试
 *
 * 需求4：「点击『查找所有打开文件』查找到多个文件上的内容然后进行内容替换，
 *        那么所有查找到的文件的内容都应该可以被替换。」
 * 需求5：「搜索框输入搜索内容后只对当前文档生效，我需要跨文档也生效，例如我在 a 文档
 *        开启了搜索框，点击内容搜索没搜到，我没关闭搜索框而是切换到另一个文档，
 *        那么这个搜索的内容应该立即激活并作用到切换的文档上进行搜索。」
 *
 * 测试策略（为什么这样测）：
 * - 需求4 的核心是「写回所有文件」，而面板自己只有 `applyFileText` 这一个出口 →
 *   用真实 SearchReplaceDialog + 假 collectFiles/applyFileText，断言**每个文件**都被写、
 *   写回内容逐字节正确、当前文档走 onSourceContentChange 而不是 applyFileText。
 * - 需求5 的核心是「docKey/contentVersion 变化触发重搜」→ 用 rerender 换 docKey
 *   与 sourceContent，断言匹配数立即跟着变（阅读模式那条路径单测不了 PM 的真实重建，
 *   但「换 docKey 必重搜」这个契约可以完整覆盖）。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { SearchReplaceDialog } from "../components/editor/SearchReplace";
import type { SearchableFile } from "../components/editor/SearchReplace";

// 面板会读 useEditorStore（viewMode / splitPreviewOpen），必须清干净避免串味
import { useEditorStore } from "../stores/useEditorStore";

const DOC_A = [
  "# 文档 A",
  "",
  "cat 在这里出现",
  "concat 也包含",
  "",
].join("\n");

const DOC_B = [
  "# 文档 B",
  "",
  "这里有 cat 一次",
  "还有 cat 第二次",
  "",
].join("\n");

const DOC_C = ["# 文档 C", "", "没有关键词", ""].join("\n");

/** 构造可搜索文件列表（getText 闭包读取可变对象，模拟"实时内容"） */
function makeFiles(texts: Record<string, string>): SearchableFile[] {
  return Object.entries(texts).map(([key, _]) => ({
    fileKey: key,
    filePath: `/tmp/${key}.md`,
    fileName: `${key}.md`,
    getText: () => texts[key],
  }));
}

type ApplyCall = { fileKey: string; newText: string };

function renderPanel(opts: {
  docKey: string;
  texts: Record<string, string>;
  onSourceContentChange?: (c: string) => void;
  applyFileText?: (k: string, t: string) => void;
  contentVersion?: number;
  isMdFile?: boolean;
}) {
  const collectFiles = () => makeFiles(opts.texts);
  const ui = (version: number) => (
    <SearchReplaceDialog
      onClose={() => {}}
      editorView={null}
      sourceContent={opts.texts[opts.docKey]}
      onSourceContentChange={opts.onSourceContentChange}
      isMdFile={opts.isMdFile ?? true}
      docKey={opts.docKey}
      collectFiles={collectFiles}
      applyFileText={opts.applyFileText}
      contentVersion={version}
    />
  );
  const r = render(ui(opts.contentVersion ?? 1));
  return {
    ...r,
    rerenderVersion: (v: number) => r.rerender(ui(v)),
  };
}

/** 在搜索框里输入关键词（受控 input，用 fireEvent.change） */
function typeSearch(text: string) {
  const input = document.querySelector(".search-row .search-input") as HTMLInputElement;
  expect(input).toBeTruthy();
  fireEvent.change(input, { target: { value: text } });
  return input;
}

function typeReplace(text: string) {
  const input = document.querySelector(".replace-row .search-input") as HTMLInputElement;
  expect(input).toBeTruthy();
  fireEvent.change(input, { target: { value: text } });
  return input;
}

/** 打开替换行（⟳ 按钮） */
function openReplaceRow() {
  const btn = document.querySelector(".search-toggle-btn") as HTMLButtonElement;
  fireEvent.click(btn);
}

function countText(): string {
  return (document.querySelector('[data-testid="search-count"]')?.textContent || "").trim();
}

beforeEach(() => {
  act(() => {
    useEditorStore.setState({ viewMode: "edit", splitPreviewOpen: false });
  });
});

afterEach(() => {
  cleanup();
});

// ─── 需求4：跨文件批量替换 ───────────────────────────────

describe("v0.14.0 需求4：条幅展开后「全部替换」作用于所有命中文件", () => {
  it("条幅展开 + 全部替换 → 每个命中文件都被写回（含未激活标签）", async () => {
    const texts: Record<string, string> = { A: DOC_A, B: DOC_B, C: DOC_C };
    const applied: ApplyCall[] = [];
    const currentWrites: string[] = [];
    renderPanel({
      docKey: "A",
      texts,
      onSourceContentChange: (c) => currentWrites.push(c),
      applyFileText: (k, t) => {
        applied.push({ fileKey: k, newText: t });
        texts[k] = t; // 模拟宿主写回后实时文本更新
      },
    });

    typeSearch("cat");
    await waitFor(() => expect(countText()).toContain("/"));

    // 展开条幅（会列出 A 与 B 的命中；C 无命中）
    fireEvent.click(screen.getByTestId("search-find-in-open-files"));
    await waitFor(() => expect(screen.getByTestId("search-results")).toBeTruthy());
    const items = screen.getAllByTestId("search-result-item");
    expect(items.length).toBeGreaterThan(0);

    openReplaceRow();
    typeReplace("DOG");

    // 条幅展开时按钮文案切换为「全部替换（所有文件）」
    const replaceAllBtn = screen.getByTestId("search-replace-all");
    expect(replaceAllBtn.textContent).toContain("所有文件");

    fireEvent.click(replaceAllBtn);

    // 当前文档走 onSourceContentChange（不走 applyFileText）
    expect(currentWrites.length).toBe(1);
    expect(currentWrites[0]).not.toContain("cat");
    expect(currentWrites[0]).toContain("DOG");
    // 非当前文档 B 必须经 applyFileText 写回，且两处 cat 全换
    const bCall = applied.find((x) => x.fileKey === "B");
    expect(bCall).toBeTruthy();
    expect(bCall!.newText).not.toContain("cat");
    expect((bCall!.newText.match(/DOG/g) || []).length).toBe(2);
    // C 没有命中 → 不应被写（避免无意义地置脏）
    expect(applied.find((x) => x.fileKey === "C")).toBeFalsy();
    // 当前文档不应同时走 applyFileText（否则会重复写、且可能绕过编辑区 state）
    expect(applied.find((x) => x.fileKey === "A")).toBeFalsy();
  });

  it("条幅收起时「全部替换」仍只替换当前文档（不误改未展示的文件）", async () => {
    const texts: Record<string, string> = { A: DOC_A, B: DOC_B };
    const applied: ApplyCall[] = [];
    const currentWrites: string[] = [];
    renderPanel({
      docKey: "A",
      texts,
      onSourceContentChange: (c) => currentWrites.push(c),
      applyFileText: (k, t) => applied.push({ fileKey: k, newText: t }),
    });

    typeSearch("cat");
    await waitFor(() => expect(countText()).toContain("/"));
    openReplaceRow();
    typeReplace("DOG");
    // 不点「查找所有打开文件」，直接点全部替换（按钮仍是旧文案）
    const replaceAllBtn = screen.getByTestId("search-replace-all");
    expect(replaceAllBtn.textContent).not.toContain("所有文件");
    fireEvent.click(replaceAllBtn);

    expect(currentWrites.length).toBe(1);
    expect(applied.length).toBe(0);
  });

  it("替换后条幅自动刷新（命中消失）", async () => {
    const texts: Record<string, string> = { A: DOC_A, B: DOC_B };
    const applied: ApplyCall[] = [];
    const r = renderPanel({
      docKey: "A",
      texts,
      onSourceContentChange: (c) => {
        texts.A = c;
      },
      applyFileText: (k, t) => {
        applied.push({ fileKey: k, newText: t });
        texts[k] = t;
      },
    });

    typeSearch("cat");
    await waitFor(() => expect(countText()).toContain("/"));
    fireEvent.click(screen.getByTestId("search-find-in-open-files"));
    await waitFor(() => expect(screen.getByTestId("search-results")).toBeTruthy());
    openReplaceRow();
    typeReplace("DOG");
    fireEvent.click(screen.getByTestId("search-replace-all"));

    // 两个文件都被改写（B 走 applyFileText，A 走 onSourceContentChange）
    expect(applied.find((x) => x.fileKey === "B")).toBeTruthy();
    expect(texts.B).not.toContain("cat");
    expect(texts.A).not.toContain("cat");

    // 宿主把新内容灌回面板（真实链路里 EditorContainer 的 sourceContent state 会更新）
    r.rerender(
      <SearchReplaceDialog
        onClose={() => {}}
        editorView={null}
        sourceContent={texts.A}
        isMdFile
        docKey="A"
        collectFiles={() => makeFiles(texts)}
        applyFileText={(k, t) => {
          texts[k] = t;
        }}
        contentVersion={9}
      />,
    );

    await waitFor(
      () => {
        const summary = document.querySelector('[data-testid="search-results-summary"]')?.textContent || "";
        // 全部替换后两个文件都不再有 cat → 汇总应变成「无匹配结果」
        expect(summary).toContain("无匹配");
      },
      { timeout: 3000 },
    );
  });

  it("「选取范围内」勾选时跨文件替换只动当前文档（其他文件没有选区坐标）", async () => {
    const texts: Record<string, string> = { A: DOC_A, B: DOC_B };
    const applied: ApplyCall[] = [];
    const currentWrites: string[] = [];
    renderPanel({
      docKey: "A",
      texts,
      onSourceContentChange: (c) => currentWrites.push(c),
      applyFileText: (k, t) => applied.push({ fileKey: k, newText: t }),
    });

    typeSearch("cat");
    await waitFor(() => expect(countText()).toContain("/"));
    fireEvent.click(screen.getByTestId("search-find-in-open-files"));
    await waitFor(() => expect(screen.getByTestId("search-results")).toBeTruthy());
    openReplaceRow();
    typeReplace("DOG");
    // 勾上「选取范围内」（jsdom 下 textarea 不存在 → 无选区 → 范围为空）
    fireEvent.click(screen.getByTestId("search-in-selection"));
    fireEvent.click(screen.getByTestId("search-replace-all"));

    // 其他文件一律不写（范围只属于当前文档）
    expect(applied.length).toBe(0);
  });

  it("没有 collectFiles 时（独立渲染）退化为只替换当前文档，不崩", async () => {
    const writes: string[] = [];
    render(
      <SearchReplaceDialog
        onClose={() => {}}
        editorView={null}
        sourceContent={DOC_A}
        onSourceContentChange={(c) => writes.push(c)}
        isMdFile
      />,
    );
    typeSearch("cat");
    await waitFor(() => expect(countText()).toContain("/"));
    openReplaceRow();
    typeReplace("DOG");
    fireEvent.click(screen.getByTestId("search-replace-all"));
    expect(writes.length).toBe(1);
    expect(writes[0]).toContain("DOG");
  });
});

// ─── 需求5：切文档后搜索立即生效 ─────────────────────────

describe("v0.14.0 需求5：搜索面板打开期间切换文档，搜索立即作用到新文档", () => {
  it("docKey + contentVersion 变化 → 匹配数立即按新文档重算", async () => {
    const texts: Record<string, string> = { A: DOC_A, B: DOC_B };
    const r = renderPanel({ docKey: "A", texts, contentVersion: 1 });

    typeSearch("cat");
    await waitFor(() => expect(countText()).toContain("/"));
    // A 里有 2 处 cat（cat 与 concat 各一）
    expect(countText()).toMatch(/\/2$/);

    // 切到 B（3 处：一次 / 第二次 = 2 处 + 标题外… 实际 B 里 2 处 cat）
    // ⚠️ 用 rerender 同时改 docKey 与 contentVersion —— 与真实切标签同构
    r.rerenderVersion(2);
    // 上面只改了 version，docKey 还是 A；再补一次真正的 docKey 变化
    r.rerender(
      <SearchReplaceDialog
        onClose={() => {}}
        editorView={null}
        sourceContent={texts.B}
        isMdFile
        docKey="B"
        collectFiles={() => makeFiles(texts)}
        contentVersion={3}
      />,
    );

    await waitFor(() => {
      // B 里 "cat" 出现 2 次（"这里有 cat 一次" + "还有 cat 第二次"）
      expect(countText()).toMatch(/\/2$/);
    });
  });

  it("换文档后「无结果」→ 有结果：搜索立即激活（用户描述的核心场景）", async () => {
    const texts: Record<string, string> = { A: DOC_C, B: DOC_B };
    const r = renderPanel({ docKey: "A", texts, contentVersion: 1 });
    typeSearch("cat");
    await waitFor(() => expect(countText()).toBe("无结果"));

    r.rerender(
      <SearchReplaceDialog
        onClose={() => {}}
        editorView={null}
        sourceContent={texts.B}
        isMdFile
        docKey="B"
        collectFiles={() => makeFiles(texts)}
        contentVersion={2}
      />,
    );
    await waitFor(() => expect(countText()).toMatch(/\/\d+$/), { timeout: 2000 });
    expect(countText()).not.toBe("无结果");
  });

  it("contentVersion 变化（同一 docKey，内容被外部改过）也会重搜", async () => {
    const texts: Record<string, string> = { A: DOC_C };
    const r = renderPanel({ docKey: "A", texts, contentVersion: 1 });
    typeSearch("cat");
    await waitFor(() => expect(countText()).toBe("无结果"));

    // 同一文件内容被替换成含 cat 的文本 + version +1
    texts.A = DOC_A;
    r.rerender(
      <SearchReplaceDialog
        onClose={() => {}}
        editorView={null}
        sourceContent={texts.A}
        isMdFile
        docKey="A"
        collectFiles={() => makeFiles(texts)}
        contentVersion={2}
      />,
    );
    await waitFor(() => expect(countText()).toMatch(/\/2$/), { timeout: 2000 });
  });

  it("搜索词为空时不因换文档而误触发（无副作用）", async () => {
    const texts: Record<string, string> = { A: DOC_A, B: DOC_B };
    const r = renderPanel({ docKey: "A", texts, contentVersion: 1 });
    await waitFor(() => expect(countText()).toBe("无结果"));
    r.rerender(
      <SearchReplaceDialog
        onClose={() => {}}
        editorView={null}
        sourceContent={texts.B}
        isMdFile
        docKey="B"
        collectFiles={() => makeFiles(texts)}
        contentVersion={2}
      />,
    );
    await new Promise((res) => setTimeout(res, 200));
    expect(countText()).toBe("无结果");
  });
});
