// @vitest-environment jsdom
/**
 * v0.16.0 第三次调整：收藏「+」选择器 —— 候选范围扩展 + 展开/取消动画
 *
 * 覆盖两条用户需求：
 *   ① 候选 = 已打开标签 ∪ **所有已打开工作区文件夹（递归子目录）中的可打开文本文件**
 *   ② 「+ 展开文件列表」与「取消添加」两段过程都有顺滑动画过渡（延迟卸载 + 反向动画）
 *
 * 本文件只测**可脱离真实 WebView2 判定**的部分：
 * - 候选合并/过滤/去重纯函数（mergeFavoriteCandidates）
 * - 组件侧异步加载、失败降级、竞态丢弃、过滤不清空已选、已收藏置灰
 * - 关闭走延迟卸载（fake timers 精确断言 180ms 前仍挂载、之后卸载）
 * - 结构与类名契约（探针 scripts/v0160-probe-favorites-picker.mjs 依赖同一套选择器）
 * - CSS 源文本契约（关键帧/时长/类名/reduced-motion）
 *
 * ⚠️ 不在这里测的：真实的逐帧 translateY/opacity 曲线、真实递归扫盘 ——
 * 那属于实机探针（jsdom 没有动画帧，且 readDir 是 mock 的，自证无意义）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const readSrc = (rel: string): string =>
  require("node:fs").readFileSync(require("node:path").join(__dirname, rel), "utf8");

// fileService 必须在 import 之前 mock（Favorites 在模块顶层 import 它）
const listWorkspaceFiles = vi.fn();
vi.mock("../services/fileService", async () => {
  const actual = await vi.importActual<typeof import("../services/fileService")>("../services/fileService");
  return {
    ...actual,
    fileService: { ...actual.fileService, listWorkspaceFiles: (...args: unknown[]) => listWorkspaceFiles(...args) },
  };
});

import {
  Favorites,
  collectFavoriteCandidates,
  mergeFavoriteCandidates,
  FAVORITES_PICKER_IN_MS,
  FAVORITES_PICKER_OUT_MS,
  MAX_RENDERED_CANDIDATES,
} from "../components/sidebar/Favorites";
import { useEditorStore, type TabInfo } from "../stores/useEditorStore";
import { useFileStore } from "../stores/useFileStore";

const tab = (path: string, name: string, isUntitled = false): TabInfo => ({ path, name, isUntitled });
const WORK = "/ws/work";

beforeEach(() => {
  localStorage.clear();
  listWorkspaceFiles.mockReset();
  listWorkspaceFiles.mockResolvedValue({ files: [], truncated: false });
  useFileStore.setState({
    favorites: [],
    openFolders: [{ path: WORK, name: "work", fileTree: [] }],
  });
  useEditorStore.setState({
    openTabs: [tab("D:\\Docs\\A.md", "A.md"), tab("D:/Docs/B.md", "B.md")],
  });
});

afterEach(cleanup);

// ─── 纯函数：候选合并 ────────────────────────────────────────
describe("mergeFavoriteCandidates：候选范围 = 已打开标签 ∪ 工作区递归文件", () => {
  it("工作区文件（含深层子目录）进入候选，与已打开标签分成两组且顺序固定", () => {
    const merged = mergeFavoriteCandidates(
      [tab("D:/Docs/A.md", "A.md")],
      [
        { name: "root.md", path: `${WORK}/root.md` },
        { name: "sub.md", path: `${WORK}/sub/sub.md` },       // 一层子目录
        { name: "deep.md", path: `${WORK}/sub/deep/deep.md` }, // 两层子目录
      ],
    );
    expect(merged.openTabs.map((f) => f.name)).toEqual(["A.md"]);
    expect(merged.workspace.map((f) => f.name)).toEqual(["root.md", "sub.md", "deep.md"]);
  });

  it("已打开标签优先：同一路径若也在工作区结果里，只保留在 openTabs 组", () => {
    const merged = mergeFavoriteCandidates(
      [tab("/ws/work/same.md", "same.md")],
      [{ name: "same.md", path: `${WORK}/same.md` }],
    );
    expect(merged.openTabs).toHaveLength(1);
    expect(merged.workspace).toHaveLength(0);
  });

  it("反斜杠/大小写差异也按 pathCompareKey 去重（Windows 语义）", () => {
    const merged = mergeFavoriteCandidates(
      [tab("D:\\ws\\WORK\\Same.md", "Same.md")],
      [{ name: "same.md", path: "D:/ws/work/same.md" }],
    );
    expect(merged.openTabs).toHaveLength(1);
    expect(merged.workspace).toHaveLength(0);
  });

  it("非文本文件被 isSupportedTextFile 过滤（图片/无扩展名/二进制）", () => {
    const merged = mergeFavoriteCandidates([], [
      { name: "pic.png", path: `${WORK}/pic.png` },
      { name: "blob", path: `${WORK}/blob` },
      { name: "ok.md", path: `${WORK}/ok.md` },
      { name: "code.ts", path: `${WORK}/code.ts` },
    ]);
    expect(merged.workspace.map((f) => f.name)).toEqual(["ok.md", "code.ts"]);
  });

  it("已收藏项不过滤（仍要展示以便置灰提示「已收藏」）", () => {
    const merged = mergeFavoriteCandidates(
      [],
      [{ name: "fav.md", path: `${WORK}/fav.md` }],
      new Set([`${WORK}/fav.md`.toLowerCase()]),
    );
    expect(merged.workspace.map((f) => f.name)).toEqual(["fav.md"]);
  });

  it("collectFavoriteCandidates 语义不变（未命名/空路径剔除、按比较键去重）", () => {
    const candidates = collectFavoriteCandidates([
      tab("D:\\Docs\\A.md", "A.md"),
      tab("d:/docs/a.md", "重复.md"),
      tab("", "未命名.md", true),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].name).toBe("A.md");
  });
});

// ─── 组件：候选来源与加载态 ──────────────────────────────────
describe("选择器：异步加载工作区候选", () => {
  it("点击「+」后先显示已打开标签分组，工作区分组随读取结果补齐", async () => {
    listWorkspaceFiles.mockResolvedValue({
      files: [
        { name: "root.md", path: `${WORK}/root.md` },
        { name: "sub.md", path: `${WORK}/sub/sub.md` },
      ],
      truncated: false,
    });
    render(<Favorites onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加收藏" }));

    // 首屏：已打开标签组已可见（不阻塞），工作区在读取
    expect(screen.getByText("已打开的文件")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /^A\.md/ })).toBeTruthy();

    await waitFor(() => expect(screen.getByText("工作区文件")).toBeTruthy());
    expect(screen.getByRole("checkbox", { name: /^root\.md/ })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /^sub\.md/ })).toBeTruthy();
    expect(screen.queryByText("正在读取工作区文件…")).toBeNull();
  });

  it("调用 fileService.listWorkspaceFiles 时传入所有已打开工作区根（silent）", async () => {
    render(<Favorites onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加收藏" }));
    await waitFor(() => expect(listWorkspaceFiles).toHaveBeenCalled());
    expect(listWorkspaceFiles.mock.calls[0][0]).toEqual([WORK]);
    expect(listWorkspaceFiles.mock.calls[0][1]).toEqual({ silent: true });
  });

  it("读取失败时静默降级为「仅已打开标签」并提示，不抛未捕获错误", async () => {
    listWorkspaceFiles.mockRejectedValue(new Error("boom"));
    render(<Favorites onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加收藏" }));

    await waitFor(() => expect(screen.getByRole("checkbox", { name: /^A\.md/ })).toBeTruthy());
    // 同一句文案出现在两处：panel 级 feedback（关掉选择器后仍可见）+ 选择器内 error 区
    expect(screen.getAllByText("读取工作区文件失败，仅显示已打开的文件").length).toBeGreaterThanOrEqual(1);
    expect(document.querySelector(".favorites-picker-error")).toBeTruthy();
    expect(screen.queryByText("工作区文件")).toBeNull();
    // 加载态必须消失（否则永远转圈）
    expect(screen.queryByText("正在读取工作区文件…")).toBeNull();
  });

  it("未打开任何文件夹时不读取工作区（直接降级为仅已打开标签）", async () => {
    useFileStore.setState({ openFolders: [] });
    render(<Favorites onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加收藏" }));
    expect(listWorkspaceFiles).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: /^A\.md/ })).toBeTruthy();
    expect(screen.queryByText("正在读取工作区文件…")).toBeNull();
  });

  it("truncated 为 true 时提示仅读取前 20000 项", async () => {
    listWorkspaceFiles.mockResolvedValue({ files: [{ name: "a.md", path: `${WORK}/a.md` }], truncated: true });
    render(<Favorites onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加收藏" }));
    await waitFor(() => expect(screen.getByText(/仅读取前 20000 项/)).toBeTruthy());
  });

  it("关闭选择器后到达的旧响应被丢弃（不污染下次打开）", async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    listWorkspaceFiles.mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }));
    listWorkspaceFiles.mockResolvedValue({ files: [], truncated: false });
    render(<Favorites onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加收藏" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    // 旧响应在关闭后才回来
    await act(async () => { resolveFirst({ files: [{ name: "stale.md", path: `${WORK}/stale.md` }], truncated: false }); });
    fireEvent.click(screen.getByRole("button", { name: "添加收藏" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /^A\.md/ })).toBeTruthy());
    expect(screen.queryByRole("checkbox", { name: /^stale\.md/ })).toBeNull();
  });
});

// ─── 组件：过滤与选择语义 ────────────────────────────────────
describe("选择器：过滤框不破坏选择语义", () => {
  it("过滤只影响显示，已选计数不变，提交仍按已选集合生效", async () => {
    listWorkspaceFiles.mockResolvedValue({
      files: [
        { name: "delta.md", path: `${WORK}/sub/deep/delta.md` },
        { name: "zeta.md", path: `${WORK}/zeta.md` },
      ],
      truncated: false,
    });
    render(<Favorites onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加收藏" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /^zeta\.md/ })).toBeTruthy());

    fireEvent.click(screen.getByRole("checkbox", { name: /^zeta\.md/ }));
    expect(screen.getByText("已选择 1 项")).toBeTruthy();

    const input = screen.getByPlaceholderText("搜索文件名或路径…");
    fireEvent.change(input, { target: { value: "delta" } });
    // 过滤后 zeta 不显示，但已选计数保留
    expect(screen.queryByRole("checkbox", { name: /^zeta\.md/ })).toBeNull();
    expect(screen.getByRole("checkbox", { name: /^delta\.md/ })).toBeTruthy();
    expect(screen.getByText("已选择 1 项")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "添加至收藏" }));
    expect(useFileStore.getState().favorites.map((f) => f.name)).toEqual(["zeta.md"]);
  });

  it("过滤无匹配时显示「没有匹配的文件」", async () => {
    render(<Favorites onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加收藏" }));
    // 先等工作区读取结束：加载态期间空态文案刻意不显示（避免"没文件"与"还在读"同时出现）
    await waitFor(() => expect(screen.queryByText("正在读取工作区文件…")).toBeNull());
    fireEvent.change(screen.getByPlaceholderText("搜索文件名或路径…"), { target: { value: "nothing-here" } });
    expect(screen.getByText("没有匹配的文件")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("已收藏项置灰 disabled、aria-checked=true 且显示「已收藏」", async () => {
    useFileStore.setState({ favorites: [{ path: `${WORK}/root.md`, name: "root.md", addedAt: 1 }] });
    listWorkspaceFiles.mockResolvedValue({ files: [{ name: "root.md", path: `${WORK}/root.md` }], truncated: false });
    render(<Favorites onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加收藏" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /^root\.md/ })).toBeTruthy());
    const box = screen.getByRole("checkbox", { name: /^root\.md/ }) as HTMLButtonElement;
    expect(box.disabled).toBe(true);
    expect(box.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("已收藏")).toBeTruthy();
  });

  it("候选超过 MAX_RENDERED_CANDIDATES 时只渲染上限条数并给提示", async () => {
    const many = Array.from({ length: MAX_RENDERED_CANDIDATES + 30 }, (_, i) => ({
      name: `f${i}.md`, path: `${WORK}/f${i}.md`,
    }));
    listWorkspaceFiles.mockResolvedValue({ files: many, truncated: false });
    render(<Favorites onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加收藏" }));
    await waitFor(() => expect(screen.getByText(new RegExp(`仅显示前 ${MAX_RENDERED_CANDIDATES} 项`))).toBeTruthy());
    expect(screen.getAllByRole("checkbox").length).toBe(MAX_RENDERED_CANDIDATES + 2); // 2 个已打开标签也计入
  });
});

// ─── 动画：延迟卸载 + 结构与类名契约 ──────────────────────────
describe("动画：展开/取消的延迟卸载与类名契约", () => {
  it("展开态带 favorites-picker-open 与 expanded，取消后进入 favorites-picker-closing", async () => {
    render(<Favorites onOpen={vi.fn()} />);
    const addBtn = screen.getByRole("button", { name: "添加收藏" });
    fireEvent.click(addBtn);

    const picker = document.querySelector(".favorites-add-picker")!;
    expect(picker.className).toContain("favorites-picker-open");
    expect(document.querySelector(".favorites-picker-inner")).toBeTruthy();
    expect(document.querySelector(".favorites-picker-clip")).toBeTruthy();
    expect(addBtn.className).toContain("expanded");
    expect(addBtn.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    const closing = document.querySelector(".favorites-add-picker")!;
    expect(closing.className).toContain("favorites-picker-closing");
    expect(closing.getAttribute("inert")).not.toBeNull();
    expect(screen.getByRole("button", { name: "添加收藏" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("取消后 OUT_MS 内仍挂载，之后卸载并恢复收藏列表（延迟卸载生效）", async () => {
    vi.useFakeTimers();
    try {
      render(<Favorites onOpen={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: "添加收藏" }));
      expect(document.querySelector(".favorites-add-picker")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "取消" }));
      // 刚点完：仍在 DOM 里播反向动画
      expect(document.querySelector(".favorites-add-picker")).toBeTruthy();
      // 差 10ms 到点：仍挂载
      act(() => { vi.advanceTimersByTime(FAVORITES_PICKER_OUT_MS - 10); });
      expect(document.querySelector(".favorites-add-picker")).toBeTruthy();
      // 到点后：卸载，空态列表回来
      act(() => { vi.advanceTimersByTime(20); });
      expect(document.querySelector(".favorites-add-picker")).toBeNull();
      expect(document.querySelector(".favorites-empty")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("重复取消 / 连按 Esc 幂等：只卸载一次且不会卡在 closing 态", async () => {
    vi.useFakeTimers();
    try {
      render(<Favorites onOpen={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: "添加收藏" }));
      const cancel = screen.getByRole("button", { name: "取消" });
      fireEvent.click(cancel);
      fireEvent.click(cancel);
      fireEvent.keyDown(window, { key: "Escape" });
      fireEvent.keyDown(window, { key: "Escape" });
      act(() => { vi.advanceTimersByTime(FAVORITES_PICKER_OUT_MS + 20); });
      expect(document.querySelector(".favorites-add-picker")).toBeNull();
      // 能再次正常打开（没有残留计时器把它又关掉）
      fireEvent.click(screen.getByRole("button", { name: "添加收藏" }));
      expect(document.querySelector(".favorites-add-picker")).toBeTruthy();
      act(() => { vi.advanceTimersByTime(FAVORITES_PICKER_OUT_MS + 20); });
      expect(document.querySelector(".favorites-add-picker")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("确认添加同样走延迟卸载，反馈文案保留", async () => {
    vi.useFakeTimers();
    try {
      render(<Favorites onOpen={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: "添加收藏" }));
      fireEvent.click(screen.getByRole("checkbox", { name: /^A\.md/ }));
      fireEvent.click(screen.getByRole("button", { name: "添加至收藏" }));
      expect(document.querySelector(".favorites-add-picker")).toBeTruthy(); // 仍在退出动画
      act(() => { vi.advanceTimersByTime(FAVORITES_PICKER_OUT_MS + 20); });
      expect(document.querySelector(".favorites-add-picker")).toBeNull();
      expect(useFileStore.getState().favorites).toHaveLength(1);
      expect(screen.getByRole("status").textContent).toContain("1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("条目入场错峰：前 8 项 animationDelay 递增（0/22/44…），第 9 项起封顶", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `f${i}.md`, path: `${WORK}/f${i}.md` }));
    listWorkspaceFiles.mockResolvedValue({ files: many, truncated: false });
    render(<Favorites onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加收藏" }));
    await waitFor(() => expect(screen.getAllByRole("checkbox").length).toBeGreaterThan(9));
    const delays = screen.getAllByRole("checkbox").slice(0, 12).map((el) => (el as HTMLElement).style.animationDelay);
    expect(delays[0]).toBe("0ms");
    expect(delays[1]).toBe("22ms");
    expect(delays[8]).toBe("176ms");
    expect(delays[9]).toBe("176ms"); // Math.min(index, 8) 封顶
    expect(delays[11]).toBe("176ms");
  });

  it("减少动态效果时取消立即卸载（不等待 OUT_MS）", async () => {
    const original = window.matchMedia;
    (window as any).matchMedia = (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    });
    try {
      render(<Favorites onOpen={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: "添加收藏" }));
      fireEvent.click(screen.getByRole("button", { name: "取消" }));
      expect(document.querySelector(".favorites-add-picker")).toBeNull();
    } finally {
      (window as any).matchMedia = original;
    }
  });
});

// ─── CSS / 源文本契约（与探针共用同一套选择器）─────────────────
describe("CSS 契约：类名、关键帧、时长、reduced-motion", () => {
  const css = () => readSrc("../components/sidebar/FileTree.css");

  it("展开/取消两段动画的关键帧与时长与 TSX 常量同步", () => {
    const src = css();
    expect(src).toMatch(
      new RegExp(`\\.favorites-picker-open \\.favorites-picker-inner\\s*\\{[^}]*animation:\\s*favorites-picker-in ${FAVORITES_PICKER_IN_MS}ms`)
    );
    expect(src).toMatch(
      new RegExp(`\\.favorites-picker-closing \\.favorites-picker-inner\\s*\\{[^}]*animation:\\s*favorites-picker-out ${FAVORITES_PICKER_OUT_MS}ms`)
    );
    expect(src).toMatch(/@keyframes favorites-picker-in\s*\{\s*from\s*\{[^}]*opacity:\s*0[^}]*translateY\(-10px\)[^}]*\}[\s\S]*?to\s*\{[^}]*(opacity:\s*1|transform:\s*none)[^}]*\}/);
    expect(src).toMatch(/@keyframes favorites-picker-out\s*\{\s*from\s*\{[^}]*opacity:\s*1[^}]*\}/);
  });

  it("关闭中禁用交互且不重播条目入场", () => {
    const src = css();
    expect(src).toMatch(/\.favorites-picker-closing\s*\{\s*pointer-events:\s*none;\s*\}/);
    expect(src).toMatch(/\.favorites-picker-closing \.favorite-picker-item\s*\{\s*animation:\s*none;\s*\}/);
  });

  it("条目入场动画与「+」旋转态存在，clip 负责裁切", () => {
    const src = css();
    expect(src).toMatch(/\.favorites-picker-open \.favorite-picker-item\s*\{[^}]*animation:\s*favorite-picker-item-in/);
    expect(src).toMatch(/@keyframes favorite-picker-item-in/);
    expect(src).toMatch(/\.favorites-picker-clip\s*\{[^}]*overflow:\s*hidden/);
    expect(src).toMatch(/\.favorites-add-btn\.expanded svg\s*\{\s*transform:\s*rotate\(45deg\)/);
    expect(src).toMatch(/\.favorites-add-btn svg\s*\{[^}]*transition:\s*transform/);
  });

  it("减少动态效果下三段动画与旋转过渡全部停用", () => {
    const src = css();
    const block = src.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    const body = block![0];
    expect(body).toMatch(/\.favorites-picker-open \.favorites-picker-inner/);
    expect(body).toMatch(/\.favorites-picker-closing \.favorites-picker-inner/);
    expect(body).toMatch(/\.favorites-picker-open \.favorite-picker-item/);
    expect(body).toMatch(/\.favorites-add-btn svg\s*\{\s*transition:\s*none/);
  });

  it("新增/删除的 i18n key 在两种语言里一一对应", () => {
    const zh = readSrc("../i18n/locales/zh-CN.ts");
    const en = readSrc("../i18n/locales/en-US.ts");
    for (const key of [
      "favorites.selectFiles", "favorites.filterPlaceholder",
      "favorites.group.openTabs", "favorites.group.workspace",
      "favorites.loadingWorkspace", "favorites.noSelectableFiles",
      "favorites.noMatch", "favorites.workspaceTruncated",
      "favorites.pickerLimitHint", "favorites.addFailed",
    ]) {
      expect(zh, `zh-CN 缺 ${key}`).toMatch(new RegExp(`"${key.replace(/\./g, "\\.")}":`));
      expect(en, `en-US 缺 ${key}`).toMatch(new RegExp(`"${key.replace(/\./g, "\\.")}":`));
    }
    // 被取代的旧 key 必须两边同时删除
    expect(zh).not.toMatch(/"favorites\.selectOpened":/);
    expect(en).not.toMatch(/"favorites\.selectOpened":/);
    expect(zh).not.toMatch(/"favorites\.noOpenedFiles":/);
    expect(en).not.toMatch(/"favorites\.noOpenedFiles":/);
  });

  it("Rust 命令已注册且前端封装走 IPC", () => {
    const lib = readSrc("../../src-tauri/src/lib.rs");
    expect(lib).toMatch(/file_ops::list_workspace_files/);
    const ops = readSrc("../../src-tauri/src/commands/file_ops.rs");
    expect(ops).toMatch(/pub async fn list_workspace_files/);
    expect(ops).toMatch(/MAX_WORKSPACE_FILES:\s*usize\s*=\s*20_000/);
    expect(ops).toMatch(/EXCLUDED_DIRS:\s*&\[&str\]\s*=\s*&\["node_modules",\s*"target",\s*"dist",\s*"build",\s*".git"\]/);
    const svc = readSrc("../services/fileService.ts");
    expect(svc).toMatch(/async listWorkspaceFiles\(/);
    expect(svc).toMatch(/invoke<WorkspaceFileList>\("list_workspace_files",\s*\{\s*roots\s*\}\)/);
    expect(svc).toMatch(/if \(!isTauri\(\)\) return \{ files: \[\], truncated: false \}/);
  });
});
