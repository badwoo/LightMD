/**
 * v0.8.4 需求7 UI 测试 —— 文件树排序按钮 / 下拉菜单 / 接线
 *
 * 前置（WP2 已覆盖，此处不重复）：fileSort.ts 纯函数（sortNodes/sortModeBadge/badge 映射）、
 * settings store persist v3 记忆口径。
 *
 * 本文件覆盖：
 * 1. 标题栏排序按钮：默认态上下双箭头；激活态箭头+竖排徽标（↑A-Z/↓Z-A/↑U/↓U/↑C/↓C 六种）
 * 2. 下拉菜单：3 组 6 项齐全、组间分隔、每项右侧语义小图标（C2：↑=升序，↓=降序）
 * 3. 点击未激活项 → setFileTreeSort(root, mode)；再次点击激活项 → 取消（null）+ toast
 * 4. 排序对渲染生效：乱序数据经 sortChildren（sortNodes）后 DOM 顺序变化
 * 5. 记忆轻量断言：settings persist（localStorage）包含 fileTreeSort
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { render, fireEvent, cleanup, act } from "@testing-library/react";

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
    // v0.8.4 需求10：watch 接入（FileTree 挂载即订阅事件）
    watchFolder: vi.fn(async () => {}),
    unwatchFolder: vi.fn(async () => {}),
    onFolderChanged: vi.fn(async () => () => {}),
  },
  isTauri: () => true,
}));

import { FileTree } from "../components/sidebar/FileTree";
import { useFileStore } from "../stores/useFileStore";
import { useEditorStore } from "../stores/useEditorStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import type { SortMode } from "../utils/fileSort";

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

/** 根层乱序数据：c.md(修改 300) / a.md(修改 100) / sub（无时间=未知，应排最后） */
function setupFolder() {
  useEditorStore.setState({ openTabs: [], activeTabIdx: 0 });
  useFileStore.setState({
    favorites: [],
    recentFiles: [],
    recentFolders: [],
    tempFiles: [],
    fileTree: [],
    rootPath: null,
    openFolders: [
      {
        path: ROOT,
        name: "proj",
        fileTree: [
          { name: "c.md", path: `${ROOT}/c.md`, isDir: false, size: 3, modifiedMs: 300 },
          { name: "a.md", path: `${ROOT}/a.md`, isDir: false, size: 1, modifiedMs: 100 },
          { name: "sub", path: `${ROOT}/sub`, isDir: true, size: 0 },
        ],
      },
    ],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // 复位排序记忆 + 清 persist（防止跨用例残留影响记忆断言）
  useSettingsStore.setState({ fileTreeSort: {} });
  window.localStorage.removeItem("lightmd-settings");
  setupFolder();
});

/** 渲染 FileTree，返回标题栏排序按钮 */
function renderAndGetSortBtn(): HTMLElement {
  render(createElement(FileTree));
  const btn = document.querySelector(".section-btn.section-sort") as HTMLElement | null;
  expect(btn).toBeTruthy();
  return btn!;
}

/** 打开排序下拉菜单（点击排序按钮），返回菜单元素 */
function openSortMenu(): HTMLElement {
  const btn = renderAndGetSortBtn();
  fireEvent.click(btn);
  const menu = document.querySelector(".filetree-sort-menu") as HTMLElement | null;
  expect(menu).toBeTruthy();
  return menu!;
}

/** 取菜单全部项文本（按 DOM 顺序） */
function menuItemTexts(menu: HTMLElement): string[] {
  return Array.from(menu.querySelectorAll(".sort-menu-label")).map((el) =>
    (el.textContent ?? "").trim()
  );
}

/** 取菜单分隔线个数 */
function menuDividerCount(menu: HTMLElement): number {
  return menu.querySelectorAll(".context-menu-divider").length;
}

/** 按菜单项文案找按钮 */
function findMenuItem(menu: HTMLElement, text: string): HTMLButtonElement {
  const btn = Array.from(menu.querySelectorAll("button")).find(
    (b) => (b.querySelector(".sort-menu-label")?.textContent ?? "").trim() === text
  );
  expect(btn).toBeTruthy();
  return btn as HTMLButtonElement;
}

/** 断言排序按钮处于激活态且徽标为指定箭头方向 + 竖排 label */
function expectBtnBadge(arrow: "up" | "down", label: string) {
  const btn = document.querySelector(".section-btn.section-sort") as HTMLElement;
  expect(btn.classList.contains("sort-active")).toBe(true);
  expect(btn.querySelector(`.sort-arrow-${arrow}`)).toBeTruthy();
  expect(btn.querySelector(".sort-badge")?.textContent).toBe(label);
}

// ─── 1. 标题栏排序按钮：默认态与激活态徽标 ────────────────
describe("v0.8.4 需求7：排序按钮默认态与激活态徽标", () => {
  it("默认态：双箭头图标，无激活类、无徽标", () => {
    renderAndGetSortBtn();
    const btn = document.querySelector(".section-btn.section-sort") as HTMLElement;
    expect(btn.classList.contains("sort-active")).toBe(false);
    expect(btn.querySelector(".sort-arrow-both")).toBeTruthy();
    expect(btn.querySelector(".sort-badge")).toBeNull();
  });

  // 六种模式的按钮徽标（C2 语义：↑=升序 / ↓=降序；U=修改、C=创建）
  const badgeCases: Array<[SortMode, "up" | "down", string]> = [
    ["name-asc", "up", "A-Z"],
    ["name-desc", "down", "Z-A"],
    ["modified-asc", "up", "U"],
    ["modified-desc", "down", "U"],
    ["created-asc", "up", "C"],
    ["created-desc", "down", "C"],
  ];
  it.each(badgeCases)("激活 %s → 按钮 %s + 徽标 %s", (mode, arrow, label) => {
    act(() => {
      useSettingsStore.setState({ fileTreeSort: { [ROOT]: mode } });
    });
    renderAndGetSortBtn();
    expectBtnBadge(arrow, label);
  });
});

// ─── 2. 下拉菜单：结构与语义图标 ──────────────────────
describe("v0.8.4 需求7：排序下拉菜单结构", () => {
  it("点击按钮弹出菜单：6 项齐全、顺序正确、3 组 2 条分隔线、每项带右侧图标", () => {
    const menu = openSortMenu();
    expect(menuItemTexts(menu)).toEqual([
      "文件名（A-Z）",
      "文件名（Z-A）",
      "修改时间（晚-早）",
      "修改时间（早-晚）",
      "创建时间（晚-早）",
      "创建时间（早-晚）",
    ]);
    expect(menuDividerCount(menu)).toBe(2);
    const items = menu.querySelectorAll("button.sort-menu-item");
    expect(items.length).toBe(6);
    items.forEach((item) => {
      // 每项右侧图标 = 箭头 svg + 竖排徽标
      const icon = item.querySelector(".sort-menu-icon");
      expect(icon).toBeTruthy();
      expect(icon!.querySelector(".sort-arrow")).toBeTruthy();
      expect(icon!.querySelector(".sort-badge")?.textContent).toBeTruthy();
    });
  });

  // 菜单项右侧图标语义表（C2）：A-Z→↑、Z-A→↓、晚-早→↓、早-晚→↑；U=修改、C=创建
  const iconCases: Array<[string, "up" | "down", string]> = [
    ["文件名（A-Z）", "up", "A-Z"],
    ["文件名（Z-A）", "down", "Z-A"],
    ["修改时间（晚-早）", "down", "U"],
    ["修改时间（早-晚）", "up", "U"],
    ["创建时间（晚-早）", "down", "C"],
    ["创建时间（早-晚）", "up", "C"],
  ];
  it.each(iconCases)("菜单项「%s」右侧图标 = %s + 竖排 %s", (text, arrow, label) => {
    const menu = openSortMenu();
    const item = findMenuItem(menu, text);
    const icon = item.querySelector(".sort-menu-icon") as HTMLElement;
    expect(icon.querySelector(`.sort-arrow-${arrow}`)).toBeTruthy();
    expect(icon.querySelector(".sort-badge")?.textContent).toBe(label);
  });

  it("点击外部关闭菜单；再次点击按钮也可关闭（v0.8.5 需求5：均先播收回动画，结束后才卸载）", () => {
    // v0.8.5 需求5 适配：菜单关闭改为"先播收回动画（160ms）再延迟卸载"，
    // 故用 fake timers 前进动画时长后再断言卸载
    vi.useFakeTimers();
    try {
      const btn = renderAndGetSortBtn();
      fireEvent.click(btn);
      expect(document.querySelector(".filetree-sort-menu")).toBeTruthy();
      // 点外部（window click）→ 进入收回动画（仍挂载、带 closing 类）
      fireEvent.click(document.body);
      const closing = document.querySelector(".filetree-sort-menu") as HTMLElement | null;
      expect(closing).toBeTruthy();
      expect(closing!.classList.contains("sort-menu-closing")).toBe(true);
      act(() => {
        vi.advanceTimersByTime(160);
      });
      expect(document.querySelector(".filetree-sort-menu")).toBeNull();
      // 再点按钮打开，再点按钮（toggle）→ 收回动画后关闭
      fireEvent.click(btn);
      expect(document.querySelector(".filetree-sort-menu")).toBeTruthy();
      fireEvent.click(btn);
      act(() => {
        vi.advanceTimersByTime(160);
      });
      expect(document.querySelector(".filetree-sort-menu")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── 3. 接线：选择 / 取消排序 ────────────────────────
describe("v0.8.4 需求7：排序选择与取消", () => {
  it("点击未激活项 → setFileTreeSort(root, mode) 写入记忆，菜单关闭", () => {
    // v0.8.5 需求5 适配：菜单关闭改为先播收回动画再延迟卸载，fake timers 前进后断言
    vi.useFakeTimers();
    try {
      const menu = openSortMenu();
      fireEvent.click(findMenuItem(menu, "修改时间（晚-早）"));
      expect(useSettingsStore.getState().fileTreeSort[ROOT]).toBe("modified-desc");
      // 收回动画期间仍挂载（closing 类），动画结束后才卸载
      expect(document.querySelector(".filetree-sort-menu.sort-menu-closing")).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(160);
      });
      expect(document.querySelector(".filetree-sort-menu")).toBeNull();
      // 按钮进入激活态（箭头+U 徽标）
      expectBtnBadge("down", "U");
    } finally {
      vi.useRealTimers();
    }
  });

  it("激活态下打开菜单，激活项高亮；再次点击激活项 → 取消排序（删 key）+ toast「已取消排序」", () => {
    act(() => {
      useSettingsStore.setState({ fileTreeSort: { [ROOT]: "modified-desc" } });
    });
    const menu = openSortMenu();
    const activeItem = findMenuItem(menu, "修改时间（晚-早）");
    expect(activeItem.classList.contains("sort-active")).toBe(true);
    // 再次点击激活项 = 取消排序
    fireEvent.click(activeItem);
    expect(useSettingsStore.getState().fileTreeSort[ROOT]).toBeUndefined();
    // toast 反馈
    const toast = document.querySelector(".filetree-toast");
    expect(toast?.textContent).toContain("已取消排序");
    // 按钮回到默认态（双箭头、无徽标）
    const btn = document.querySelector(".section-btn.section-sort") as HTMLElement;
    expect(btn.classList.contains("sort-active")).toBe(false);
    expect(btn.querySelector(".sort-arrow-both")).toBeTruthy();
  });

  it("点击另一未激活项直接切换模式（不经过取消）", () => {
    act(() => {
      useSettingsStore.setState({ fileTreeSort: { [ROOT]: "name-asc" } });
    });
    const menu = openSortMenu();
    fireEvent.click(findMenuItem(menu, "创建时间（早-晚）"));
    expect(useSettingsStore.getState().fileTreeSort[ROOT]).toBe("created-asc");
  });
});

// ─── 4. 排序对渲染生效（sortChildren → sortNodes → DOM 顺序） ──
describe("v0.8.4 需求7：排序作用于渲染顺序", () => {
  /** 取根层节点 title 顺序（sub 未展开、文件无子级 → 全部 .filetree-node 均为根层） */
  function renderedTitles(): string[] {
    return Array.from(
      document.querySelectorAll(".filetree-folder-content .filetree-node")
    ).map((el) => el.getAttribute("title")!);
  }

  it("无排序：默认顺序（文件夹在前 + 字母序）", () => {
    render(createElement(FileTree));
    expect(renderedTitles()).toEqual([`${ROOT}/sub`, `${ROOT}/a.md`, `${ROOT}/c.md`]);
  });

  it("激活修改时间（晚-早）：按 modifiedMs 降序，未知时间（sub）排最后", () => {
    act(() => {
      useSettingsStore.setState({ fileTreeSort: { [ROOT]: "modified-desc" } });
    });
    render(createElement(FileTree));
    expect(renderedTitles()).toEqual([`${ROOT}/c.md`, `${ROOT}/a.md`, `${ROOT}/sub`]);
  });

  it("激活修改时间（早-晚）：升序；取消排序后回默认顺序", () => {
    act(() => {
      useSettingsStore.setState({ fileTreeSort: { [ROOT]: "modified-asc" } });
    });
    render(createElement(FileTree));
    expect(renderedTitles()).toEqual([`${ROOT}/a.md`, `${ROOT}/c.md`, `${ROOT}/sub`]);
    // 经菜单点击取消 → 恢复默认（无需手动刷新，zustand 订阅即响应）
    const btn = document.querySelector(".section-btn.section-sort") as HTMLElement;
    fireEvent.click(btn);
    const menu = document.querySelector(".filetree-sort-menu") as HTMLElement;
    fireEvent.click(findMenuItem(menu, "修改时间（早-晚）"));
    expect(renderedTitles()).toEqual([`${ROOT}/sub`, `${ROOT}/a.md`, `${ROOT}/c.md`]);
  });
});

// ─── 5. 记忆轻量断言：settings persist 包含 fileTreeSort ──────
describe("v0.8.4 需求7：排序记忆持久化（轻量）", () => {
  it("选择排序后 localStorage 的 lightmd-settings 含 fileTreeSort[root]（persist v3）", () => {
    const menu = openSortMenu();
    fireEvent.click(findMenuItem(menu, "文件名（Z-A）"));
    const raw = window.localStorage.getItem("lightmd-settings");
    expect(raw).toBeTruthy();
    const persisted = JSON.parse(raw!) as { state?: { fileTreeSort?: Record<string, string> } };
    expect(persisted.state?.fileTreeSort?.[ROOT]).toBe("name-desc");
  });
});
