/**
 * v0.8.5 文件树打磨测试（需求1 / 3 / 4 / 5）
 *
 * 覆盖：
 * 1. 需求1：工具栏「文件管理」全局刷新按钮已移除（rootPath 有值——原渲染条件——也不渲染）；
 *    空白右键菜单「刷新」项保留（其余刷新入口：Ctrl+R / FileNode 文件夹右键「刷新」）
 * 2. v0.8.5 反馈1：md/markdown/mdown 节点图标恢复为原 📝 emoji（回滚内联 SVG 方案）；
 *    txt 等其他类型仍为 emoji 文本
 * 2b. v0.8.5 反馈7：「打开的文件」条目图标改为打开的小书本 SVG —— 未落盘临时文件
 *     黄 #e0a458 / 真实文件蓝 #5c9dff，形状为左右两页对称 path（中缝 x=7.5/8.5）
 * 3. 需求4：搜索面板挂载带展开动画类（search-panel-open）；toggle/Esc 关闭 → 收回动画类
 *    （search-panel-closing）→ 动画播完（180ms）才延迟卸载；输入过滤功能不回退
 * 4. 需求5：排序下拉挂载带展开动画类（sort-menu-open）；三条关闭路径
 *    （点外部 / 点菜单项 / 再次点按钮 toggle）均先播收回动画（sort-menu-closing）再延迟卸载（160ms）
 * 5. CSS 源文本断言：两组 keyframes 存在、含对应动画通道、prefers-reduced-motion 降级
 *    （参考 v0.8.4-anim-vertical.test.ts 读 CSS 源文本的惯例）
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { render, fireEvent, cleanup, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// mock fileService（与 v0.8.4-filetree-integration.test.tsx 同款：isTauri=true 走真实服务调用路径）
vi.mock("../services/fileService", () => ({
  fileService: {
    readFile: vi.fn(async () => ""),
    listDir: vi.fn(async () => []),
    exists: vi.fn(async () => false),
    writeFile: vi.fn(async () => {}),
    getFileSize: vi.fn(async () => 0),
    createFile: vi.fn(async () => {}),
    createDir: vi.fn(async () => {}),
    deleteFile: vi.fn(async () => {}),
    renameFile: vi.fn(async () => {}),
    copyFile: vi.fn(async () => {}),
    moveFile: vi.fn(async () => {}),
    revealInFolder: vi.fn(async () => {}),
    watchFolder: vi.fn(async () => {}),
    unwatchFolder: vi.fn(async () => {}),
    onFolderChanged: vi.fn(async () => () => {}),
  },
  isTauri: () => true,
}));

import { FileTree, SEARCH_PANEL_OUT_MS } from "../components/sidebar/FileTree";
import { useFileStore } from "../stores/useFileStore";
import { useEditorStore } from "../stores/useEditorStore";
import { useSettingsStore } from "../stores/useSettingsStore";

// jsdom 未实现 ResizeObserver（SidebarScrollArrows 用其监听尺寸），mock 空实现
beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

// vitest 未开启 globals → 手动 cleanup，避免 DOM 残留影响 querySelector
afterEach(() => cleanup());

const ROOT = "C:/proj";

/** 打开一个含 md 类文件（三种扩展名）+ txt + 子文件夹的工作区 */
function setupFolder() {
  useEditorStore.setState({ openTabs: [], activeTabIdx: 0 });
  useSettingsStore.setState({ fileTreeSort: {} });
  useFileStore.setState({
    favorites: [],
    recentFiles: [],
    recentFolders: [],
    tempFiles: [],
    fileTree: [],
    // v0.8.5 需求1：rootPath 有值（原全局刷新按钮的渲染条件），断言按钮已不渲染
    rootPath: ROOT,
    openFolders: [
      {
        path: ROOT,
        name: "proj",
        fileTree: [
          { name: "a.md", path: `${ROOT}/a.md`, isDir: false, size: 10 },
          { name: "b.markdown", path: `${ROOT}/b.markdown`, isDir: false, size: 10 },
          { name: "c.mdown", path: `${ROOT}/c.mdown`, isDir: false, size: 10 },
          { name: "d.txt", path: `${ROOT}/d.txt`, isDir: false, size: 10 },
          { name: "sub", path: `${ROOT}/sub`, isDir: true, size: 0 },
        ],
      },
    ],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setupFolder();
});

// ─── 需求1：工具栏全局刷新按钮移除 ────────────────────────
describe("v0.8.5 需求1：工具栏全局刷新按钮移除", () => {
  it("rootPath 有值时工具栏也无全局刷新按钮（filetree-btn[title=刷新] 不存在），搜索按钮保留", () => {
    render(createElement(FileTree));
    expect(document.querySelector('.filetree-btn[title="刷新"]')).toBeNull();
    expect(document.querySelector('.filetree-btn[title="搜索文件"]')).toBeTruthy();
  });

  it("空白右键菜单「刷新」项保留", () => {
    render(createElement(FileTree));
    const content = document.querySelector(".filetree-folder-content") as HTMLElement | null;
    expect(content).toBeTruthy();
    fireEvent.contextMenu(content!);
    const menu = document.querySelector(".filetree-context-menu") as HTMLElement | null;
    expect(menu).toBeTruthy();
    const refreshItem = Array.from(menu!.querySelectorAll("button")).find(
      (b) => b.textContent === "刷新",
    );
    expect(refreshItem).toBeTruthy();
  });
});

// ─── v0.8.5 反馈1：md 图标恢复 📝 emoji ────────────────────
describe("v0.8.5 反馈1：md 文件图标恢复 📝 emoji", () => {
  it("md/markdown/mdown 节点图标为 📝 文本（无 svg）", () => {
    render(createElement(FileTree));
    for (const name of ["a.md", "b.markdown", "c.mdown"]) {
      const icon = document.querySelector(
        `.filetree-node[title="${ROOT}/${name}"] .filetree-icon`,
      ) as HTMLElement | null;
      expect(icon, name).toBeTruthy();
      // 回滚内联 SVG 方案：不应再有 svg，且文本恢复为 📝 emoji
      expect(icon!.querySelector("svg"), name).toBeNull();
      expect(icon!.textContent, name).toBe("📝");
    }
  });

  it("txt 等其他类型仍为 emoji 文本（无 svg）", () => {
    render(createElement(FileTree));
    const icon = document.querySelector(
      `.filetree-node[title="${ROOT}/d.txt"] .filetree-icon`,
    ) as HTMLElement | null;
    expect(icon).toBeTruthy();
    expect(icon!.querySelector("svg")).toBeNull();
    expect(icon!.textContent).toBe("📄");
  });
});

// ─── v0.8.5 反馈7：「打开的文件」条目图标为打开的小书本 ──────────
describe("v0.8.5 反馈7：打开的文件条目图标为打开的小书本", () => {
  /** 在树形工作区基础上，追加一个未落盘临时标签 + 一个真实文件标签（面板同时承载两类条目） */
  function setupOpenFiles() {
    useEditorStore.setState({
      openTabs: [
        { path: "", name: "未命名", isUntitled: true, id: "untitled-1" },
        { path: `${ROOT}/a.md`, name: "a.md" },
      ],
      activeTabIdx: 0,
    });
    useFileStore.setState({
      tempFiles: [{ name: "a.md", path: `${ROOT}/a.md`, isDir: false, size: 10 }],
    });
  }

  it("未落盘临时条目图标为书本 SVG（黄色 #e0a458，两页 path 为书本形状）", () => {
    setupOpenFiles();
    render(createElement(FileTree));
    const icon = document.querySelector(
      ".filetree-untitled-node .filetree-icon",
    ) as HTMLElement | null;
    expect(icon).toBeTruthy();
    const svg = icon!.querySelector("svg");
    expect(svg).toBeTruthy();
    const html = svg!.innerHTML;
    // 颜色保持原黄色
    expect(html).toContain("#e0a458");
    // 书本形状：左右两页 path（中缝 x=7.5 / x=8.5）——替代旧"纸张"path（M9.5 1.1）
    expect(html).toContain("M7.5 3.7");
    expect(html).toContain("M8.5 3.7");
    expect(html).not.toContain("M9.5 1.1");
  });

  it("真实文件条目图标为书本 SVG（蓝色 #5c9dff，同款书本形状）", () => {
    setupOpenFiles();
    render(createElement(FileTree));
    const icon = document.querySelector(
      ".filetree-temp-node:not(.filetree-untitled-node) .filetree-icon",
    ) as HTMLElement | null;
    expect(icon).toBeTruthy();
    const svg = icon!.querySelector("svg");
    expect(svg).toBeTruthy();
    const html = svg!.innerHTML;
    // 颜色保持原蓝色
    expect(html).toContain("#5c9dff");
    expect(html).toContain("M7.5 3.7");
    expect(html).toContain("M8.5 3.7");
    expect(html).not.toContain("M9.5 1.1");
  });
});

// ─── 需求4：搜索面板展开/收回动画（延迟卸载） ─────────────
describe("v0.8.5 需求4：搜索面板展开/收回动画", () => {
  function getSearchBtn(): HTMLElement {
    const btn = document.querySelector('.filetree-btn[title="搜索文件"]') as HTMLElement | null;
    expect(btn).toBeTruthy();
    return btn!;
  }

  it("点击搜索按钮 → 面板挂载带展开动画类（search-panel-open）；输入过滤功能不回退", () => {
    render(createElement(FileTree));
    fireEvent.click(getSearchBtn());
    const panel = document.querySelector(".filetree-search-panel") as HTMLElement | null;
    expect(panel).toBeTruthy();
    expect(panel!.classList.contains("search-panel-open")).toBe(true);
    // 输入过滤仍工作：输入命中 a.md → 结果列表出现
    const input = document.querySelector(".filetree-search-input") as HTMLInputElement | null;
    expect(input).toBeTruthy();
    fireEvent.change(input!, { target: { value: "a.md" } });
    const results = document.querySelector(".filetree-search-results");
    expect(results).toBeTruthy();
    expect(results!.textContent).toContain("a.md");
  });

  it("再点搜索按钮（toggle）→ 收回动画类，动画播完（180ms）才卸载", () => {
    vi.useFakeTimers();
    try {
      render(createElement(FileTree));
      fireEvent.click(getSearchBtn());
      expect(document.querySelector(".filetree-search-panel")).toBeTruthy();
      fireEvent.click(getSearchBtn());
      const closing = document.querySelector(".filetree-search-panel") as HTMLElement | null;
      expect(closing).toBeTruthy();
      expect(closing!.classList.contains("search-panel-closing")).toBe(true);
      // 收回动画未播完仍挂载（180ms - 1 时仍在）
      act(() => {
        vi.advanceTimersByTime(SEARCH_PANEL_OUT_MS - 1);
      });
      expect(document.querySelector(".filetree-search-panel")).toBeTruthy();
      // 播完到点 → 卸载
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(document.querySelector(".filetree-search-panel")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Esc 关闭同样走收回动画（延迟卸载）", () => {
    vi.useFakeTimers();
    try {
      render(createElement(FileTree));
      fireEvent.click(getSearchBtn());
      const input = document.querySelector(".filetree-search-input") as HTMLInputElement;
      fireEvent.keyDown(input, { key: "Escape" });
      const closing = document.querySelector(".filetree-search-panel") as HTMLElement | null;
      expect(closing).toBeTruthy();
      expect(closing!.classList.contains("search-panel-closing")).toBe(true);
      act(() => {
        vi.advanceTimersByTime(SEARCH_PANEL_OUT_MS);
      });
      expect(document.querySelector(".filetree-search-panel")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── 需求5：排序下拉展开/收回动画（三条关闭路径） ──────────
describe("v0.8.5 需求5：排序下拉展开/收回动画", () => {
  function getSortBtn(): HTMLElement {
    const btn = document.querySelector(".section-btn.section-sort") as HTMLElement | null;
    expect(btn).toBeTruthy();
    return btn!;
  }

  it("点击排序按钮 → 菜单挂载带展开动画类（sort-menu-open）", () => {
    render(createElement(FileTree));
    fireEvent.click(getSortBtn());
    const menu = document.querySelector(".filetree-sort-menu") as HTMLElement | null;
    expect(menu).toBeTruthy();
    expect(menu!.classList.contains("sort-menu-open")).toBe(true);
  });

  it("关闭路径①：点击外部 → 收回动画类，160ms 后卸载", () => {
    vi.useFakeTimers();
    try {
      render(createElement(FileTree));
      fireEvent.click(getSortBtn());
      expect(document.querySelector(".filetree-sort-menu")).toBeTruthy();
      fireEvent.click(document.body);
      const closing = document.querySelector(".filetree-sort-menu") as HTMLElement | null;
      expect(closing).toBeTruthy();
      expect(closing!.classList.contains("sort-menu-closing")).toBe(true);
      act(() => {
        vi.advanceTimersByTime(160); // 与 FileTree.tsx SORT_MENU_OUT_MS 同步
      });
      expect(document.querySelector(".filetree-sort-menu")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("关闭路径②：点击菜单项 → 排序写入记忆 + 收回动画后卸载", () => {
    vi.useFakeTimers();
    try {
      render(createElement(FileTree));
      fireEvent.click(getSortBtn());
      const menu = document.querySelector(".filetree-sort-menu") as HTMLElement;
      const item = Array.from(menu.querySelectorAll("button.sort-menu-item")).find(
        (b) => b.querySelector(".sort-menu-label")?.textContent === "修改时间（晚-早）",
      ) as HTMLElement | undefined;
      expect(item).toBeTruthy();
      fireEvent.click(item!);
      expect(useSettingsStore.getState().fileTreeSort[ROOT]).toBe("modified-desc");
      expect(document.querySelector(".filetree-sort-menu.sort-menu-closing")).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(160);
      });
      expect(document.querySelector(".filetree-sort-menu")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("关闭路径③：再次点击排序按钮（toggle）→ 收回动画后卸载", () => {
    vi.useFakeTimers();
    try {
      render(createElement(FileTree));
      const btn = getSortBtn();
      fireEvent.click(btn);
      expect(document.querySelector(".filetree-sort-menu")).toBeTruthy();
      fireEvent.click(btn);
      const closing = document.querySelector(".filetree-sort-menu") as HTMLElement | null;
      expect(closing).toBeTruthy();
      expect(closing!.classList.contains("sort-menu-closing")).toBe(true);
      act(() => {
        vi.advanceTimersByTime(160);
      });
      expect(document.querySelector(".filetree-sort-menu")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── 需求4/5：FileTree.css 动画源文本断言 ──────────────────
const treeCss = readFileSync(join(__dirname, "../components/sidebar/FileTree.css"), "utf-8");

/** 截取指定 keyframes 块源文本（从 @keyframes 名称到配对大括号结束） */
function extractKeyframes(css: string, name: string): string {
  const marker = `@keyframes ${name}`;
  const start = css.indexOf(marker);
  expect(start, `应存在 ${marker}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = start; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  throw new Error(`keyframes ${name} 未闭合`);
}

/** 截取指定选择器规则块源文本（从选择器到配对大括号结束） */
function extractRule(css: string, selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `应存在 ${selector}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = start; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  throw new Error(`规则 ${selector} 未闭合`);
}

describe("v0.8.5 需求4/5：FileTree.css 动画源文本断言", () => {
  it("搜索面板动画为水平方向：keyframes 含 max-width/opacity/translateX，无 max-height/translateY 残留", () => {
    // 反馈2：动画通道从垂直（max-height + translateY）改为水平（max-width + translateX）
    const inAnim = extractKeyframes(treeCss, "search-panel-in");
    expect(inAnim).toContain("max-width");
    expect(inAnim).toContain("opacity");
    expect(inAnim).toContain("translateX(-8px)");
    expect(inAnim).toContain("translateX(0)");
    expect(inAnim).not.toContain("max-height");
    expect(inAnim).not.toContain("translateY");
    const outAnim = extractKeyframes(treeCss, "search-panel-out");
    expect(outAnim).toContain("max-width");
    expect(outAnim).toContain("opacity");
    expect(outAnim).toContain("translateX(-8px)");
    expect(outAnim).not.toContain("max-height");
    expect(outAnim).not.toContain("translateY");
    // 基础规则：max-height 已删除；overflow:hidden 保证宽度动画裁剪内容而非回流挤压
    const panelRule = extractRule(treeCss, ".filetree-search-panel {");
    expect(panelRule).not.toContain("max-height");
    expect(panelRule).toContain("overflow: hidden");
  });

  it("排序下拉两组 keyframes 存在且含 opacity/translateY 动画通道", () => {
    const inAnim = extractKeyframes(treeCss, "sort-menu-in");
    expect(inAnim).toContain("opacity");
    expect(inAnim).toContain("translateY(-6px)");
    const outAnim = extractKeyframes(treeCss, "sort-menu-out");
    expect(outAnim).toContain("opacity");
    expect(outAnim).toContain("translateY(-6px)");
  });

  it("prefers-reduced-motion 降级存在（两组动画均直接显示/隐藏）", () => {
    // 各自的降级 media 块内：animation: none 直接显示；收回态 display:none 直接隐藏
    expect(treeCss).toMatch(
      /prefers-reduced-motion[\s\S]*?search-panel-closing\s*\{[^}]*display:\s*none/,
    );
    expect(treeCss).toMatch(
      /prefers-reduced-motion[\s\S]*?sort-menu-closing\s*\{[^}]*display:\s*none/,
    );
  });
});
