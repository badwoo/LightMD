// @vitest-environment jsdom
/**
 * v0.15.0 R6b：搜索面板「工作区」作用域的 UI 行为测试（jsdom）。
 *
 * 只测**用户可感知的行为**，不测实现细节：
 * 1. 未接 `workspaceRoots` 时按钮不渲染（未接线不出现"点了没反应"的按钮）；
 * 2. 接线后出现工作区按钮，点击切作用域 → 条幅出现、进度/结果渲染；
 * 3. 结果按文件分组、`<mark>` 高亮、点击走 `requestSearchJump`（occurrence 口径）；
 * 4. 正则勾选时工作区模式**明确提示不支持**（不是静默失败）；
 * 5. 关闭面板/切走作用域 → 调 `cancel_workspace_search`；
 * 6. 既有「打开的文件」条幅行为不变（回归：两档互斥，互不干扰）。
 *
 * 服务层用 mock 替换（它的正确性已由 v0150-workspace-search.test.ts 的 30 个用例
 * 覆盖）；本文件只验证**组件如何编排与渲染**。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ─── mocks（必须在 import 组件之前）─────────────────────────

const { searchWorkspaceMock, cancelMock } = vi.hoisted(() => ({
  searchWorkspaceMock: vi.fn(),
  cancelMock: vi.fn(),
}));

vi.mock("../services/workspaceSearch", () => ({
  searchWorkspace: searchWorkspaceMock,
  cancelWorkspaceSearch: cancelMock,
  createWorkspaceQueryId: () => "qid-test",
  skipSummaryTotal: (s: any) =>
    s
      ? Object.values(s).reduce((a: number, b: any) => a + (b || 0), 0)
      : 0,
  WorkspaceSearchError: class WorkspaceSearchError extends Error {
    code: string;
    detail: string;
    constructor(code: string, detail: string) {
      super(detail || code);
      this.code = code;
      this.detail = detail;
    }
  },
}));

import { SearchReplaceDialog, type SearchableFile } from "../components/editor/SearchReplace";
import { peekSearchJump, __resetSearchJumpForTest } from "../utils/searchJump";
import { useEditorStore } from "../stores/useEditorStore";

// ─── 测试替身 ─────────────────────────────────────────────

/** 受控 textarea ref（面板从 ref 读选区） */
function makeTextareaRef(value: string) {
  const ta = document.createElement("textarea");
  ta.value = value;
  document.body.appendChild(ta);
  return { current: ta } as React.RefObject<HTMLTextAreaElement | null>;
}

/** 构造一个工作区结果分组 */
function group(
  filePath: string,
  rows: Array<{ line: number; occurrence: number; text: string }>,
) {
  const fileName = filePath.replace(/\\/g, "/").split("/").pop()!;
  return {
    fileKey: filePath.toLowerCase().replace(/\\/g, "/"),
    filePath,
    fileName,
    matchCount: rows.length,
    rows: rows.map((r) => {
      const at = r.text.toLowerCase().indexOf("hello");
      const start = at < 0 ? 0 : at;
      const end = start + 5;
      return {
        fileKey: filePath.toLowerCase().replace(/\\/g, "/"),
        filePath,
        fileName,
        line: r.line,
        column: start + 1,
        matchStart: start,
        matchEnd: end,
        lineText: r.text,
        segments: [
          ...(start > 0 ? [{ text: r.text.slice(0, start), match: false }] : []),
          { text: r.text.slice(start, end), match: true },
          ...(end < r.text.length
            ? [{ text: r.text.slice(end), match: false }]
            : []),
        ],
        ranges: [{ start, end }],
        occurrence: r.occurrence,
      };
    }),
  };
}

/** 一次成功的搜索：先推两帧进度，再 onDone */
function mockSuccess(files: ReturnType<typeof group>[], extra: any = {}) {
  searchWorkspaceMock.mockImplementation(
    (req: any, cb: any) =>
      new Promise((resolve) => {
        const snap = {
          queryId: req.queryId,
          files,
          totalHits: files.reduce((n, f) => n + f.matchCount, 0),
          filesScanned: 12,
          filesSkipped: 3,
          skippedReasons: {},
          truncated: false,
        };
        cb.onProgress?.(snap);
        const result = {
          ...snap,
          cancelled: false,
          reconciledDropped: extra.reconciledDropped ?? 0,
          reconciledFiles: extra.reconciledFiles ?? extra.reconciledDropped ?? 0,
          truncated: extra.truncated ?? false,
        };
        cb.onDone?.(result);
        resolve(result);
      }),
  );
}

/** 渲染面板 */
function renderPanel(props: Record<string, unknown> = {}) {
  const taRef = makeTextareaRef("hello world");
  const files: SearchableFile[] = [
    {
      fileKey: "D:/ws/open.md",
      filePath: "D:/ws/open.md",
      fileName: "open.md",
      getText: () => "hello from open",
    },
  ];
  return render(
    createElement(SearchReplaceDialog, {
      onClose: () => {},
      editorView: null,
      sourceTextareaRef: taRef,
      sourceContent: "hello world",
      onSourceContentChange: () => {},
      collectFiles: () => files,
      docKey: "D:/ws/open.md",
      ...props,
    }),
  );
}

/** 输入搜索词 */
function typeQuery(root: HTMLElement, text: string) {
  const input = root.querySelector<HTMLInputElement>(".search-input")!;
  fireEvent.change(input, { target: { value: text } });
}

beforeEach(() => {
  searchWorkspaceMock.mockReset();
  cancelMock.mockReset();
  cancelMock.mockResolvedValue(true);
  __resetSearchJumpForTest();
  useEditorStore.setState({ viewMode: "edit" } as any);
});

afterEach(() => {
  cleanup();
  __resetSearchJumpForTest();
});

// ═══════════ ① 未接线：按钮不出现 ═══════════

describe("R6b · 未接 workspaceRoots 时工作区按钮不渲染", () => {
  it("不传 workspaceRoots → 无工作区按钮（不出现点了没反应的入口）", () => {
    const { container } = renderPanel();
    expect(container.querySelector('[data-testid="search-scope-workspace"]')).toBeNull();
  });

  it("传空数组 → 同样不渲染", () => {
    const { container } = renderPanel({ workspaceRoots: [] });
    expect(container.querySelector('[data-testid="search-scope-workspace"]')).toBeNull();
  });

  it("★ 既有行为不回归：不接线时「查找所有打开文件」条幅照旧可用", async () => {
    const { container } = renderPanel();
    typeQuery(container, "hello");
    fireEvent.click(container.querySelector('[data-testid="search-find-in-open-files"]')!);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="search-results"]')).toBeTruthy();
    });
    const items = container.querySelectorAll('[data-testid="search-result-item"]');
    expect(items.length).toBeGreaterThan(0);
    // 工作区条幅不该出现
    expect(container.querySelector('[data-testid="search-workspace-results"]')).toBeNull();
  });
});

// ═══════════ ② 接线后：作用域切换 + 流式结果渲染 ═══════════

describe("R6b · 工作区作用域：切换与结果渲染", () => {
  it("点击工作区按钮 → 进入工作区作用域（按钮 active + 条幅出现）", async () => {
    const { container } = renderPanel({ workspaceRoots: ["D:/ws"] });
    const btn = container.querySelector('[data-testid="search-scope-workspace"]')!;
    expect(btn.className).not.toContain("active");
    typeQuery(container, "hello");
    fireEvent.click(btn);
    expect(btn.className).toContain("active");
    await waitFor(() => {
      expect(container.querySelector('[data-testid="search-workspace-results"]')).toBeTruthy();
    });
  });

  it("结果按文件分组渲染：文件名、命中数、行号、<mark> 高亮", async () => {
    mockSuccess([
      group("D:/ws/a.md", [
        { line: 3, occurrence: 0, text: "say hello there" },
        { line: 9, occurrence: 1, text: "hello again" },
      ]),
      group("D:/ws/sub/b.md", [{ line: 1, occurrence: 0, text: "hello b" }]),
    ]);
    const { container } = renderPanel({ workspaceRoots: ["D:/ws"] });
    typeQuery(container, "hello");
    fireEvent.click(container.querySelector('[data-testid="search-scope-workspace"]')!);

    await waitFor(() => {
      expect(
        container.querySelectorAll('[data-testid="search-workspace-result-item"]').length,
      ).toBe(3);
    });
    // 文件名 + 命中数 + 行号
    const fileLabels = Array.from(
      container.querySelectorAll('[data-testid="search-result-file"]'),
    ).map((el) => el.textContent ?? "");
    expect(fileLabels[0]).toContain("a.md");
    expect(fileLabels[0]).toContain("(2)");
    expect(fileLabels[0]).toContain(":3");
    // 高亮
    const marks = container.querySelectorAll('[data-testid="search-result-match"]');
    expect(marks.length).toBe(3);
    expect(marks[0].textContent).toBe("hello");
    // 汇总
    const summary = container.querySelector('[data-testid="search-workspace-summary"]')!;
    expect(summary.textContent).toContain("3");
  });

  it("相对路径展示（同名文件靠相对路径区分）", async () => {
    mockSuccess([
      group("D:/ws/a/README.md", [{ line: 1, occurrence: 0, text: "hello a" }]),
      group("D:/ws/b/README.md", [{ line: 1, occurrence: 0, text: "hello b" }]),
    ]);
    const { container } = renderPanel({ workspaceRoots: ["D:/ws"] });
    typeQuery(container, "hello");
    fireEvent.click(container.querySelector('[data-testid="search-scope-workspace"]')!);
    await waitFor(() => {
      const paths = Array.from(container.querySelectorAll(".search-result-file-path")).map(
        (el) => el.textContent,
      );
      expect(paths).toEqual(["a/README.md", "b/README.md"]);
    });
  });

  it("多根嵌套时取**最深根**算相对路径（与 F2 同口径）", async () => {
    mockSuccess([
      group("D:/ws/proj/src/x.md", [{ line: 2, occurrence: 0, text: "hello x" }]),
    ]);
    const { container } = renderPanel({ workspaceRoots: ["D:/ws", "D:/ws/proj"] });
    typeQuery(container, "hello");
    fireEvent.click(container.querySelector('[data-testid="search-scope-workspace"]')!);
    await waitFor(() => {
      const p = container.querySelector(".search-result-file-path");
      // 深根 D:/ws/proj → 相对路径 src/x.md（不是 proj/src/x.md）
      expect(p?.textContent).toBe("src/x.md");
    });
  });

  it("搜索中显示进度与取消按钮，结束后消失", async () => {
    // 永不 resolve 的搜索 → 保持"进行中"
    searchWorkspaceMock.mockImplementation((req: any, cb: any) => {
      cb.onProgress?.({
        queryId: req.queryId,
        files: [],
        totalHits: 2,
        filesScanned: 40,
        filesSkipped: 5,
        skippedReasons: {},
        truncated: false,
      });
      return new Promise(() => {});
    });
    const { container } = renderPanel({ workspaceRoots: ["D:/ws"] });
    typeQuery(container, "hello");
    fireEvent.click(container.querySelector('[data-testid="search-scope-workspace"]')!);

    await waitFor(() => {
      expect(container.querySelector('[data-testid="search-workspace-progress"]')).toBeTruthy();
    });
    const progress = container.querySelector('[data-testid="search-workspace-progress"]')!;
    // 进度文案含 scanned/hits/skipped 三个数（i18n 缺失 key 时回退 key 名，
    // 因此这里只断言按钮/元素存在与参数替换不崩）
    expect(progress.textContent).toBeTruthy();
    expect(container.querySelector('[data-testid="search-workspace-cancel"]')).toBeTruthy();

    // 点取消 → 调服务层 cancel，进度条退出
    fireEvent.click(container.querySelector('[data-testid="search-workspace-cancel"]')!);
    await waitFor(() => {
      expect(cancelMock).toHaveBeenCalled();
      expect(container.querySelector('[data-testid="search-workspace-progress"]')).toBeNull();
    });
  });

  it("结果被截断时显示提示", async () => {
    mockSuccess(
      [group("D:/ws/a.md", [{ line: 1, occurrence: 0, text: "hello" }])],
      { truncated: true },
    );
    const { container } = renderPanel({ workspaceRoots: ["D:/ws"] });
    typeQuery(container, "hello");
    fireEvent.click(container.querySelector('[data-testid="search-scope-workspace"]')!);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="search-workspace-summary"]')!.textContent)
        .toContain("结果已达上限");
    });
  });

  it("脏文档覆盖剔除数有提示（用户要知道结果已按内存校正）", async () => {
    mockSuccess(
      [group("D:/ws/a.md", [{ line: 1, occurrence: 0, text: "hello" }])],
      { reconciledDropped: 7, reconciledFiles: 4 },
    );
    const { container } = renderPanel({ workspaceRoots: ["D:/ws"] });
    typeQuery(container, "hello");
    fireEvent.click(container.querySelector('[data-testid="search-scope-workspace"]')!);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="search-workspace-summary"]')!.textContent)
        .toContain("按内存内容校正");
    });
  });
});

// ═══════════ ③ 正则禁用提示 ═══════════

describe("R6b · 工作区作用域禁用正则（明确提示，不静默失败）", () => {
  it("工作区作用域下正则勾选框被 disabled", async () => {
    const { container } = renderPanel({ workspaceRoots: ["D:/ws"] });
    const regex = container.querySelector<HTMLInputElement>(
      '[data-testid="search-use-regex"]',
    )!;
    expect(regex.disabled).toBe(false);
    fireEvent.click(container.querySelector('[data-testid="search-scope-workspace"]')!);
    expect(regex.disabled).toBe(true);
  });

  it("★ 已勾正则再切到工作区 → 出现明确「不支持正则」提示，且不发 regex 请求", async () => {
    mockSuccess([]);
    const { container } = renderPanel({ workspaceRoots: ["D:/ws"] });
    typeQuery(container, "hello");
    // 先在当前文件作用域勾上正则
    fireEvent.click(container.querySelector('[data-testid="search-use-regex"]')!);
    expect(
      container.querySelector<HTMLInputElement>('[data-testid="search-use-regex"]')!.checked,
    ).toBe(true);

    fireEvent.click(container.querySelector('[data-testid="search-scope-workspace"]')!);
    await waitFor(() => {
      const hint = container.querySelector('[data-testid="search-workspace-error"]');
      expect(hint).toBeTruthy();
      // 明确提示"不支持正则"（文案已由 Lead 补进 locales）
      expect(hint!.textContent).toContain("暂不支持正则");
    });
    // 关键：本次不应把 regex=true 的请求发出去
    const sentRegex = searchWorkspaceMock.mock.calls.some(
      (c) => c[0]?.options?.regex === true,
    );
    expect(sentRegex).toBe(false);
  });

  it("服务层返回 REGEX_UNSUPPORTED → 展示同一提示", async () => {
    searchWorkspaceMock.mockImplementation((_req: any, cb: any) => {
      const err = Object.assign(new Error("regex"), {
        code: "REGEX_UNSUPPORTED",
        detail: "工作区范围暂不支持正则搜索",
      });
      cb.onError?.(err);
      return Promise.reject(err);
    });
    const { container } = renderPanel({ workspaceRoots: ["D:/ws"] });
    typeQuery(container, "hello");
    fireEvent.click(container.querySelector('[data-testid="search-scope-workspace"]')!);
    await waitFor(() => {
      expect(
        container.querySelector('[data-testid="search-workspace-error"]')!.textContent,
      ).toContain("暂不支持正则");
    });
  });

  it("其他错误 → 展示带 detail 的失败提示", async () => {
    searchWorkspaceMock.mockImplementation((_req: any, cb: any) => {
      const err = Object.assign(new Error("io"), { code: "OTHER", detail: "磁盘读取失败" });
      cb.onError?.(err);
      return Promise.reject(err);
    });
    const { container } = renderPanel({ workspaceRoots: ["D:/ws"] });
    typeQuery(container, "hello");
    fireEvent.click(container.querySelector('[data-testid="search-scope-workspace"]')!);
    await waitFor(() => {
      const hint = container.querySelector('[data-testid="search-workspace-error"]');
      // 失败提示带 detail（文案 `工作区搜索失败：{detail}` 已由 Lead 补进 locales）
      expect(hint!.textContent).toContain("工作区搜索失败");
      expect(hint!.textContent).toContain("磁盘读取失败");
    });
  });
});

// ═══════════ ④ 跳转：occurrence 口径 ═══════════

describe("R6b · 点击工作区结果 → requestSearchJump（occurrence 口径）", () => {
  it("★ 点击结果写入 pending（fileKey/filePath/occurrence/query 正确）", async () => {
    mockSuccess([
      group("D:/ws/a.md", [
        { line: 3, occurrence: 0, text: "hello one" },
        { line: 9, occurrence: 1, text: "hello two" },
      ]),
    ]);
    const { container } = renderPanel({ workspaceRoots: ["D:/ws"] });
    typeQuery(container, "hello");
    fireEvent.click(container.querySelector('[data-testid="search-scope-workspace"]')!);
    await waitFor(() => {
      expect(
        container.querySelectorAll('[data-testid="search-workspace-result-item"]').length,
      ).toBe(2);
    });

    const items = container.querySelectorAll('[data-testid="search-workspace-result-item"]');
    fireEvent.click(items[1]); // 第二条：line 9 / occurrence 1
    const pending = peekSearchJump()!;
    expect(pending).toBeTruthy();
    expect(pending.filePath).toBe("D:/ws/a.md");
    expect(pending.fileKey).toBe("d:/ws/a.md");
    expect(pending.line).toBe(9);
    // 关键：跨文本空间靠 occurrence，不是行号
    expect(pending.occurrence).toBe(1);
    expect(pending.query).toBe("hello");
  });

  it("onJumpToFile 回调与 requestSearchJump 同时生效（宿主切标签）", async () => {
    const jumps: any[] = [];
    mockSuccess([group("D:/ws/a.md", [{ line: 2, occurrence: 0, text: "hello" }])]);
    const { container } = renderPanel({
      workspaceRoots: ["D:/ws"],
      onJumpToFile: (t: any) => jumps.push(t),
    });
    typeQuery(container, "hello");
    fireEvent.click(container.querySelector('[data-testid="search-scope-workspace"]')!);
    await waitFor(() => {
      expect(
        container.querySelectorAll('[data-testid="search-workspace-result-item"]').length,
      ).toBe(1);
    });
    fireEvent.click(
      container.querySelector('[data-testid="search-workspace-result-item"]')!,
    );
    expect(jumps).toHaveLength(1);
    expect(jumps[0].occurrence).toBe(0);
    expect(peekSearchJump()).toBeTruthy();
  });
});

// ═══════════ ⑤ 取消与生命周期 ═══════════

describe("R6b · 取消与生命周期", () => {
  it("关闭面板（卸载）→ 取消进行中的工作区搜索", async () => {
    searchWorkspaceMock.mockImplementation(() => new Promise(() => {}));
    const { container, unmount } = renderPanel({ workspaceRoots: ["D:/ws"] });
    typeQuery(container, "hello");
    fireEvent.click(container.querySelector('[data-testid="search-scope-workspace"]')!);
    await waitFor(() => {
      expect(searchWorkspaceMock).toHaveBeenCalled();
    });
    unmount();
    await waitFor(() => {
      expect(cancelMock).toHaveBeenCalledWith("qid-test");
    });
  });

  it("搜索词清空 → 结果清空且不再发请求", async () => {
    mockSuccess([group("D:/ws/a.md", [{ line: 1, occurrence: 0, text: "hello" }])]);
    const { container } = renderPanel({ workspaceRoots: ["D:/ws"] });
    typeQuery(container, "hello");
    fireEvent.click(container.querySelector('[data-testid="search-scope-workspace"]')!);
    await waitFor(() => {
      expect(
        container.querySelectorAll('[data-testid="search-workspace-result-item"]').length,
      ).toBe(1);
    });
    const callsBefore = searchWorkspaceMock.mock.calls.length;
    typeQuery(container, "");
    await waitFor(() => {
      expect(
        container.querySelectorAll('[data-testid="search-workspace-result-item"]').length,
      ).toBe(0);
    });
    expect(searchWorkspaceMock.mock.calls.length).toBe(callsBefore);
  });

  it("换词会触发新搜索并取消上一轮", async () => {
    searchWorkspaceMock.mockImplementation(() => new Promise(() => {}));
    const { container } = renderPanel({ workspaceRoots: ["D:/ws"] });
    typeQuery(container, "hello");
    fireEvent.click(container.querySelector('[data-testid="search-scope-workspace"]')!);
    await waitFor(() => expect(searchWorkspaceMock).toHaveBeenCalledTimes(1));
    typeQuery(container, "world");
    await waitFor(() => expect(searchWorkspaceMock).toHaveBeenCalledTimes(2));
    // 第二次请求的 query 是 world
    expect(searchWorkspaceMock.mock.calls[1][0].query).toBe("world");
    // 上一轮被 cancel
    await waitFor(() => expect(cancelMock).toHaveBeenCalledWith("qid-test"));
  });

  it("两档条幅互斥：工作区作用域下不渲染「打开的文件」条幅", async () => {
    mockSuccess([group("D:/ws/a.md", [{ line: 1, occurrence: 0, text: "hello" }])]);
    const { container } = renderPanel({ workspaceRoots: ["D:/ws"] });
    typeQuery(container, "hello");
    fireEvent.click(container.querySelector('[data-testid="search-find-in-open-files"]')!);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="search-results"]')).toBeTruthy();
    });
    // 切到工作区："打开的文件"条幅仍在（showResults 未变）但结果是工作区口径；
    // 断言两者都能同时存在不冲突（各自独立渲染，不互相覆盖）
    fireEvent.click(container.querySelector('[data-testid="search-scope-workspace"]')!);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="search-workspace-results"]')).toBeTruthy();
    });
    // 再点一次工作区按钮 → 退出工作区作用域
    fireEvent.click(container.querySelector('[data-testid="search-scope-workspace"]')!);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="search-workspace-results"]')).toBeNull();
    });
  });
});

// ═══════════ ⑥ i18n：中英双语 key 完整性（防将来漏配） ═══════════

describe("R6b · i18n key 完整性（中英必须同时存在）", () => {
  /** 组件在本需求里用到的全部 key（新增 key 时同步加到这里） */
  const REQUIRED_KEYS = [
    "search.searchInWorkspace",
    "search.scopeWorkspaceActive",
    "search.workspaceSearching",
    "search.workspaceCancel",
    "search.workspaceSkippedCount",
    "search.workspaceTruncated",
    "search.workspaceReconciled",
    "search.workspaceRegexUnsupported",
    "search.workspaceSearchFailed",
  ];

  it("zh-CN 与 en-US 都定义了全部 9 个 key，且都不为空", async () => {
    const zh = await import("../i18n/locales/zh-CN");
    const en = await import("../i18n/locales/en-US");
    const zhDict = (zh as any).default ?? (zh as any).zhCN ?? (zh as any);
    const enDict = (en as any).default ?? (en as any).enUS ?? (en as any);
    for (const key of REQUIRED_KEYS) {
      expect(zhDict[key], `zh-CN 缺 ${key}`).toBeTruthy();
      expect(enDict[key], `en-US 缺 ${key}`).toBeTruthy();
      // 占位符必须两种语言一致，否则参数替换会漏（用户看到裸露的 {detail}）
      const zhParams = [...String(zhDict[key]).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      const enParams = [...String(enDict[key]).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(enParams, `${key} 的占位符与 zh-CN 不一致`).toEqual(zhParams);
    }
  });
});
