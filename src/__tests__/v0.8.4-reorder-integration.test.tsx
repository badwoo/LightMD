/**
 * v0.8.4 需求3：文件夹内鼠标拖拽"同目录重排"端到端集成测试
 *
 * 复现用户反馈的 bug 链路（真实 DOM + 真实事件流）：
 *   mousedown(源行) → mousemove(位移 >4px，触发拖拽 + 落点高亮) → mouseup(目标行/空白)
 *   → beginFileDrag 三分流 → resolveDropAction=reorder → handleDragReorder
 *   → resolveInsertPlace → handleReorder（写 localStorage + UI 立即生效）
 *
 * 每个用例断言三层（缺一不可）：
 *   1. 拖拽过程中落点被高亮 = **未被 canDrop 拒绝**、确实进入 reorder 分支（而非静默取消/误判传输）；
 *   2. 渲染顺序发生预期变化（UI 立即生效）；
 *   3. localStorage["lightmd-manual-order"] 写入期望顺序（持久化正确）。
 *
 * 注：jsdom 未实现 document.elementFromPoint，用例内用 defineProperty 注入命中元素。
 *     vitest 未开启 globals，需显式 import 测试 API。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { render, fireEvent, cleanup, act } from "@testing-library/react";

// mock fileService（与既有集成测试同款）：isTauri=true 让 refreshTree 真正走到 listDir
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

import { FileTree } from "../components/sidebar/FileTree";
import { useFileStore } from "../stores/useFileStore";
import { useEditorStore } from "../stores/useEditorStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { fileService } from "../services/fileService";
import { DRAG_ACTIVE_CLASS } from "../utils/fileDragMouse";
import type { FileEntry } from "../services/fileService";

const STORAGE_KEY = "lightmd-manual-order";
const ROOT = "C:/proj";
const A = "C:/proj/a.md";
const B = "C:/proj/b.md";
const C = "C:/proj/c.md";
/** 反斜杠根路径场景（Tauri 目录选择对话框在 Windows 可能返回反斜杠） */
const ROOT_BS = "C:\\proj";
const SUB = "C:/proj/sub";

/** FileEntry 工厂（snake_case，与 Rust 返回一致） */
const entry = (name: string, path: string, isDir = false): FileEntry => ({
  name,
  path,
  is_dir: isDir,
  size: 0,
  modified_ms: 0,
  created_ms: 0,
});

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(async () => {
  cleanup();
  localStorage.removeItem(STORAGE_KEY);
  // 冲掉 fileDragMouse.suppressNextClick 的 setTimeout(0)：该 window 捕获监听会拦截
  // 下一个用例里的 window click，导致"刷新"按钮点击被吞（跨用例污染），必须等待其移除
  await new Promise((r) => setTimeout(r, 0));
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.removeItem(STORAGE_KEY);
  useEditorStore.setState({ openTabs: [], activeTabIdx: 0 });
  useSettingsStore.setState({ fileTreeSort: {} });
});

/** 设置打开一个文件夹（folderPath 可含反斜杠），并渲染 FileTree + 点"刷新"载入 childrenMap */
async function renderFolder(folderPath: string, entries: FileEntry[]) {
  useFileStore.setState({
    favorites: [],
    recentFiles: [],
    recentFolders: [],
    tempFiles: [],
    fileTree: [],
    rootPath: folderPath,
    openFolders: [{ path: folderPath, name: "proj", fileTree: entries.map(toNode) }],
  });
  vi.mocked(fileService.listDir).mockImplementation(async (p: string) =>
    p === folderPath ? entries : [],
  );
  render(createElement(FileTree));
  const refreshBtn = document.querySelector('.filetree-btn[title="刷新"]') as HTMLElement;
  expect(refreshBtn).toBeTruthy();
  await act(async () => {
    fireEvent.click(refreshBtn);
  });
}

function toNode(e: FileEntry) {
  return { name: e.name, path: e.path, isDir: e.is_dir, size: e.size };
}

/** 按 title 属性（= 节点路径）精确定位节点行（避免反斜杠在 CSS 选择器中的转义问题） */
function findNodeRowByPath(path: string): HTMLElement {
  const all = Array.from(document.querySelectorAll(".filetree-node")) as HTMLElement[];
  const hit = all.find((el) => el.getAttribute("title") === path);
  expect(hit).toBeTruthy();
  return hit!;
}

/** 读取某容器下直属节点行的渲染顺序（仅取直属 wrapper 的显示名） */
function childNames(container: Element | null): string[] {
  if (!container) return [];
  return Array.from(container.children)
    .filter((el) => el.classList.contains("filetree-node-wrapper"))
    .map(
      (el) =>
        (el.querySelector(":scope > .filetree-node > .filetree-name") as HTMLElement | null)
          ?.textContent ?? "",
    );
}

/** 注入 elementFromPoint 命中元素（jsdom 未实现；每次拖拽前调用） */
function injectHit(el: Element | null) {
  Object.defineProperty(document, "elementFromPoint", {
    value: () => el,
    configurable: true,
  });
}

/** 给某行注入几何信息（决定 before/after 的垂直中点） */
function stubRect(el: Element, top: number, height: number) {
  (el as HTMLElement).getBoundingClientRect = () =>
    ({
      top,
      height,
      left: 0,
      right: 100,
      bottom: top + height,
      width: 100,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
}

/**
 * 执行一次完整鼠标拖拽：源行 mousedown → document mousemove(位移>4px) → document mouseup。
 * 返回拖拽过程中落点是否获得高亮（= 未被 canDrop 拒绝的直接证据）。
 */
function mouseDrag(srcPath: string, hitEl: Element | null, clientY: number): boolean {
  injectHit(hitEl);
  const srcRow = findNodeRowByPath(srcPath);
  fireEvent.mouseDown(srcRow, { button: 0, clientX: 0, clientY: 0 });
  act(() => {
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 30, clientY: 30 }));
  });
  const highlighted = document.querySelector(`.${DRAG_ACTIVE_CLASS}`) !== null;
  act(() => {
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 30, clientY }));
  });
  return highlighted;
}

const readTable = () => JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");

describe("v0.8.4 需求3：同目录拖拽重排端到端（根目录内）", () => {
  it("拖到同目录另一行之前 → 未被拒绝、渲染顺序变化、localStorage 写入期望顺序", async () => {
    await renderFolder(ROOT, [entry("a.md", A), entry("b.md", B), entry("c.md", C)]);
    const list = document.querySelector(".filetree-folder-content");
    expect(childNames(list)).toEqual(["a.md", "b.md", "c.md"]);

    // 把 c.md 拖到 a.md 行上方（before）
    const targetRow = findNodeRowByPath(A).closest(".filetree-node-wrapper") as HTMLElement;
    stubRect(targetRow, 100, 20);
    const highlighted = mouseDrag(C, targetRow, 105);

    // 断言1：落点高亮 = canDrop 未拒绝、进入 reorder 分支
    expect(highlighted).toBe(true);
    // 断言2：UI 立即生效
    expect(childNames(list)).toEqual(["c.md", "a.md", "b.md"]);
    // 断言3：持久化
    expect(readTable()[ROOT]).toEqual(["c.md", "a.md", "b.md"]);
  });

  it("拖到列表空白处（命中区域容器而非某行）→ 源移动到末尾", async () => {
    await renderFolder(ROOT, [entry("a.md", A), entry("b.md", B), entry("c.md", C)]);
    const list = document.querySelector(".filetree-folder-content");
    // 命中容器自身（无 .filetree-node-wrapper 祖先）→ resolveInsertPlace=end
    const highlighted = mouseDrag(A, list, 500);
    expect(highlighted).toBe(true);
    expect(childNames(list)).toEqual(["b.md", "c.md", "a.md"]);
    expect(readTable()[ROOT]).toEqual(["b.md", "c.md", "a.md"]);
  });

  it("根路径为反斜杠（真实 Windows 场景）时同目录判定与重排仍成立（归一化容错）", async () => {
    // 文件夹根用反斜杠（Tauri 目录对话框返回值），而节点路径由 Rust list_dir 归一为正斜杠——
    // childrenMap 的 key 是根路径（反斜杠），handleReorder 的 dir 却是 getParentDirOf（正斜杠）。
    // 修复前 childrenMap.get(dir) 落空 → 重排静默无效（本用例即为该 bug 的回归守卫）。
    await renderFolder(ROOT_BS, [entry("a.md", A), entry("b.md", B), entry("c.md", C)]);
    const list = document.querySelector(".filetree-folder-content");
    expect(childNames(list)).toEqual(["a.md", "b.md", "c.md"]);

    const targetRow = findNodeRowByPath(A).closest(".filetree-node-wrapper") as HTMLElement;
    stubRect(targetRow, 100, 20);
    const highlighted = mouseDrag(C, targetRow, 105);

    expect(highlighted).toBe(true);
    expect(childNames(list)).toEqual(["c.md", "a.md", "b.md"]);
    // 手动顺序表存的是归一化后的 key（正斜杠）
    expect(readTable()[ROOT]).toEqual(["c.md", "a.md", "b.md"]);
  });
});

describe("v0.8.4 需求3：子文件夹内的重排（子列表容器承载落点）", () => {
  const X = "C:/proj/sub/x.md";
  const Y = "C:/proj/sub/y.md";
  const Z = "C:/proj/sub/z.md";

  /** 根 = a.md + sub；sub 展开后含 x.md/y.md/z.md */
  async function renderWithSub() {
    vi.mocked(fileService.listDir).mockImplementation(async (p: string) => {
      if (p === ROOT) return [entry("a.md", A), entry("sub", SUB, true)];
      if (p === SUB) return [entry("x.md", X), entry("y.md", Y), entry("z.md", Z)];
      return [];
    });
    useFileStore.setState({
      favorites: [],
      recentFiles: [],
      recentFolders: [],
      tempFiles: [],
      fileTree: [],
      rootPath: ROOT,
      openFolders: [
        {
          path: ROOT,
          name: "proj",
          fileTree: [toNode(entry("a.md", A)), toNode(entry("sub", SUB, true))],
        },
      ],
    });
    render(createElement(FileTree));
    await act(async () => {
      fireEvent.click(document.querySelector('.filetree-btn[title="刷新"]') as HTMLElement);
    });
    // 展开 sub（childrenMap 写入 SUB 的子节点）
    await act(async () => {
      fireEvent.click(findNodeRowByPath(SUB));
    });
  }

  it("子文件夹内拖到另一行前 → 重排（落点为该子文件夹，而非被区域根截获误判为传输）", async () => {
    await renderWithSub();
    const subContainer = findNodeRowByPath(SUB)
      .closest(".filetree-node-wrapper")!
      .querySelector(".filetree-children");
    expect(subContainer).toBeTruthy();
    expect(childNames(subContainer)).toEqual(["x.md", "y.md", "z.md"]);

    // 把 z.md 拖到 x.md 行上方
    const targetRow = findNodeRowByPath(X).closest(".filetree-node-wrapper") as HTMLElement;
    stubRect(targetRow, 100, 20);
    const highlighted = mouseDrag(Z, targetRow, 105);

    expect(highlighted).toBe(true);
    expect(childNames(subContainer)).toEqual(["z.md", "x.md", "y.md"]);
    expect(readTable()[SUB]).toEqual(["z.md", "x.md", "y.md"]);
  });

  it("子文件夹内拖到子列表空白处 → 源移动到该子文件夹末尾", async () => {
    await renderWithSub();
    const subContainer = findNodeRowByPath(SUB)
      .closest(".filetree-node-wrapper")!
      .querySelector(".filetree-children") as HTMLElement;

    const highlighted = mouseDrag(X, subContainer, 500);
    expect(highlighted).toBe(true);
    expect(childNames(subContainer)).toEqual(["y.md", "z.md", "x.md"]);
    expect(readTable()[SUB]).toEqual(["y.md", "z.md", "x.md"]);
  });
});