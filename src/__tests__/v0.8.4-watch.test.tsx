/**
 * v0.8.4 需求10：watch 实时刷新 —— 前端逻辑层测试（Rust 侧不测）
 *
 * 覆盖：
 * 1. resolveRefreshDirs 纯函数：变更路径 → 「childrenMap 已加载的最深祖先目录」映射
 *    （自身命中 / 逐级向上 / \ 分隔符归一化 / 未加载祖先链忽略 / 多路径去重 / 无关路径忽略）
 * 2. 事件按 root 300ms 去抖：同 root 连续事件合并为一个定时器（不重置），到点合并 paths 刷新
 * 3. hasRemove → stale 联动：recentFiles 与 favorites（P2 拍板收藏夹同标）条目标 stale，
 *    未匹配路径不误标
 * 4. refreshDir 在途去重：同目录刷新进行中不重复发起 listDir（模块级 refreshDirInFlight）
 * 5. 根目录被外部删除（P4 拍板）：toast 提示 + 该栏保持显示，不自动关闭
 * 6. watch 生命周期：打开文件夹 → watchFolder 注册；关闭文件夹 → unwatchFolder 注销
 *
 * mock 说明：fileService 整体 mock（isTauri=true 走真实订阅路径）；
 * onFolderChanged 记录 handler，由用例直接派发模拟事件载荷。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { render, fireEvent, cleanup, act } from "@testing-library/react";

/** onFolderChanged 注册的 handler 列表（用例经它派发模拟事件） */
let folderChangedHandlers: Array<(payload: {
  root: string;
  paths: string[];
  hasRemove: boolean;
}) => void> = [];

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
    // 记录 handler；返回 unlisten（从列表移除）
    onFolderChanged: vi.fn(async (h: (payload: unknown) => void) => {
      folderChangedHandlers.push(h as typeof folderChangedHandlers[number]);
      return () => {
        folderChangedHandlers = folderChangedHandlers.filter((x) => x !== h);
      };
    }),
  },
  isTauri: () => true,
}));

import {
  FileTree,
  resolveRefreshDirs,
  refreshDirInFlight,
  WATCH_DEBOUNCE_MS,
} from "../components/sidebar/FileTree";
import { fileService } from "../services/fileService";
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

const ROOT = "C:/proj";
const SUB = "C:/proj/sub";

/** 派发一条 watch 聚合事件（经 mock 记录的 handler） */
function emitFolderChanged(payload: { root: string; paths: string[]; hasRemove: boolean }) {
  for (const h of folderChangedHandlers) h(payload);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  folderChangedHandlers = [];
  refreshDirInFlight.clear();
  vi.mocked(fileService.listDir).mockImplementation(async () => []);
  localStorage.removeItem("lightmd-file-store");
  localStorage.removeItem("lightmd-editor-store");
  useEditorStore.setState({ openTabs: [], activeTabIdx: 0 });
  useSettingsStore.setState({ fileTreeSort: {} });
  useFileStore.setState({
    favorites: [],
    recentFiles: [],
    recentFolders: [],
    tempFiles: [],
    fileTree: [],
    rootPath: null,
    openFolders: [],
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** 渲染 FileTree 并等订阅建立（onFolderChanged 是 async 注册） */
async function renderTree() {
  render(createElement(FileTree));
  // flush 微任务：useEffect 中 onFolderChanged(...).then 注册完成
  await act(async () => {});
  expect(folderChangedHandlers.length).toBeGreaterThan(0);
}

/** 打开一个含 sub 子文件夹的工作区（根层渲染自 store.fileTree） */
function setupProject() {
  useFileStore.setState({
    openFolders: [
      {
        path: ROOT,
        name: "proj",
        fileTree: [
          { name: "a.md", path: `${ROOT}/a.md`, isDir: false, size: 10 },
          { name: "sub", path: SUB, isDir: true, size: 0 },
        ],
      },
    ],
  });
}

// ─── 1. resolveRefreshDirs 纯函数 ──────────────────────
describe("v0.8.4 需求10：resolveRefreshDirs 变更路径 → 最深已加载祖先", () => {
  it("路径自身已加载 → 命中自身", () => {
    expect(resolveRefreshDirs([SUB], [ROOT, SUB])).toEqual([SUB]);
  });

  it("深层路径 → 逐级向上命中最深已加载祖先", () => {
    // deep 未加载，其父 sub 已加载 → 刷 sub 即可（展开时自然读最新）
    expect(resolveRefreshDirs([`${SUB}/deep/f.md`], [ROOT, SUB])).toEqual([SUB]);
  });

  it("Windows 反斜杠路径归一化匹配正斜杠缓存", () => {
    expect(resolveRefreshDirs(["C:\\proj\\sub\\a.md"], [ROOT, SUB])).toEqual([SUB]);
  });

  it("多个路径命中同一祖先 → 去重为一个目录", () => {
    expect(resolveRefreshDirs([`${ROOT}/a.md`, `${ROOT}/b.md`], [ROOT])).toEqual([ROOT]);
  });

  it("祖先链完全未加载 → 忽略（展开时自然读最新）", () => {
    expect(resolveRefreshDirs([`${ROOT}/ghost/deep/f.md`], [])).toEqual([]);
  });

  it("已打开文件夹之外的路径 → 忽略", () => {
    expect(resolveRefreshDirs(["D:/other/x.md"], [ROOT])).toEqual([]);
  });

  it("混合命中与忽略：仅返回命中的目录", () => {
    expect(resolveRefreshDirs([`${ROOT}/a.md`, "D:/other/x.md"], [ROOT])).toEqual([ROOT]);
  });
});

// ─── 2. 事件 300ms 按 root 去抖合并 ──────────────────────
describe("v0.8.4 需求10：事件去抖合并 + 定向刷新", () => {
  it("同 root 连续事件合并为一个定时器（不重置），到点合并 paths 一次性刷新", async () => {
    setupProject();
    await renderTree();

    // 展开 sub → childrenMap 写入 "C:/proj/sub"（后续 deep 变更能命中它）
    const subNode = document.querySelector(`.filetree-node[title="${SUB}"]`) as HTMLElement;
    expect(subNode).toBeTruthy();
    await act(async () => {
      fireEvent.click(subNode);
    });
    // 展开产生的 listDir 调用清掉，隔离后续断言
    vi.mocked(fileService.listDir).mockClear();

    // 事件1：根层文件变更
    emitFolderChanged({ root: ROOT, paths: [`${ROOT}/a.md`], hasRemove: false });
    // 去抖窗口内（<300ms）不刷新
    await act(async () => {
      vi.advanceTimersByTime(WATCH_DEBOUNCE_MS - 50);
    });
    expect(vi.mocked(fileService.listDir)).not.toHaveBeenCalled();

    // 事件2：250ms 时到达 → 合并进同一窗口（不重置定时器）
    emitFolderChanged({ root: ROOT, paths: [`${SUB}/deep/f.md`], hasRemove: false });
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    // 到点（距事件1 恰 300ms）→ 合并刷新：
    // - a.md 未命中已加载祖先（childrenMap 无 root key，根层渲染自 store.fileTree）→ 兜底根
    //   ——但 deep/f.md 已命中 sub（非空结果），故仅定向刷 sub
    // - deep/f.md → 最深已加载祖先 = sub
    expect(vi.mocked(fileService.listDir)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fileService.listDir)).toHaveBeenCalledWith(SUB);

    // 合并语义：定时器未被事件2 重置 → 此后不会再有第二次 flush
    await act(async () => {
      vi.advanceTimersByTime(WATCH_DEBOUNCE_MS * 2);
    });
    expect(vi.mocked(fileService.listDir)).toHaveBeenCalledTimes(1);
  });

  it("变更未命中任何已加载目录 → 兜底刷新根层（启动恢复场景 childrenMap 为空）", async () => {
    setupProject();
    await renderTree();
    // 不展开任何目录 → childrenMap 为空
    emitFolderChanged({ root: ROOT, paths: [`${ROOT}/new.md`], hasRemove: false });
    await act(async () => {
      vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
    });
    expect(vi.mocked(fileService.listDir)).toHaveBeenCalledWith(ROOT);
  });

  it("不同 root 的事件各自独立去抖（互不合并）", async () => {
    setupProject();
    useFileStore.setState({
      openFolders: [
        ...useFileStore.getState().openFolders,
        { path: "D:/work", name: "work", fileTree: [] },
      ],
    });
    await renderTree();
    emitFolderChanged({ root: ROOT, paths: [`${ROOT}/a.md`], hasRemove: false });
    emitFolderChanged({ root: "D:/work", paths: ["D:/work/x.md"], hasRemove: false });
    await act(async () => {
      vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
    });
    // 两个 root 各自 flush 一次
    expect(vi.mocked(fileService.listDir)).toHaveBeenCalledWith(ROOT);
    expect(vi.mocked(fileService.listDir)).toHaveBeenCalledWith("D:/work");
  });
});

// ─── 3. hasRemove → stale 联动 ──────────────────────
describe("v0.8.4 需求10：删除事件 → 最近打开/收藏 stale 联动", () => {
  it("hasRemove → 匹配的 recentFiles 与 favorites 条目标 stale（P2 拍板收藏夹同标）", async () => {
    setupProject();
    useFileStore.setState({
      recentFiles: [
        { path: `${ROOT}/a.md`, name: "a.md", accessedAt: 1 },
        { path: `${ROOT}/keep.md`, name: "keep.md", accessedAt: 2 },
      ],
      favorites: [
        { path: `${ROOT}/fav.md`, name: "fav.md", addedAt: 1 },
      ],
    });
    await renderTree();
    emitFolderChanged({
      root: ROOT,
      paths: [`${ROOT}/a.md`, `${ROOT}/fav.md`],
      hasRemove: true,
    });
    await act(async () => {
      vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
    });
    const { recentFiles, favorites } = useFileStore.getState();
    expect(recentFiles.find((f) => f.path === `${ROOT}/a.md`)?.stale).toBe(true);
    // 未匹配路径不受影响
    expect(recentFiles.find((f) => f.path === `${ROOT}/keep.md`)?.stale).toBeUndefined();
    expect(favorites.find((f) => f.path === `${ROOT}/fav.md`)?.stale).toBe(true);
  });

  it("无删除（hasRemove=false）→ 不标 stale", async () => {
    setupProject();
    useFileStore.setState({
      recentFiles: [{ path: `${ROOT}/a.md`, name: "a.md", accessedAt: 1 }],
    });
    await renderTree();
    emitFolderChanged({ root: ROOT, paths: [`${ROOT}/a.md`], hasRemove: false });
    await act(async () => {
      vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
    });
    expect(useFileStore.getState().recentFiles[0]?.stale).toBeUndefined();
  });

  it("stale 匹配容忍反斜杠分隔符（Windows 事件路径）", async () => {
    setupProject();
    useFileStore.setState({
      recentFiles: [{ path: `${ROOT}/a.md`, name: "a.md", accessedAt: 1 }],
    });
    await renderTree();
    emitFolderChanged({ root: ROOT, paths: ["C:\\proj\\a.md"], hasRemove: true });
    await act(async () => {
      vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
    });
    expect(useFileStore.getState().recentFiles[0]?.stale).toBe(true);
  });
});

// ─── 4. refreshDir 在途去重 ──────────────────────
describe("v0.8.4 需求10：refreshDir 在途去重", () => {
  it("同目录刷新进行中再次触发 → 不重复发起 listDir；完成后集合清空", async () => {
    setupProject();
    await renderTree();

    // listDir 挂起（模拟 IO 慢）：第一次调用后保持 pending
    let resolveIo: (() => void) | null = null;
    vi.mocked(fileService.listDir).mockImplementation(
      () =>
        new Promise<never[]>((resolve) => {
          resolveIo = () => resolve([]);
        }),
    );

    // 事件1 → flush → refreshDir(ROOT) 开始，listDir 发起并挂起
    emitFolderChanged({ root: ROOT, paths: [`${ROOT}/a.md`], hasRemove: false });
    await act(async () => {
      vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
    });
    expect(vi.mocked(fileService.listDir)).toHaveBeenCalledTimes(1);
    expect(refreshDirInFlight.has(ROOT)).toBe(true);

    // 事件2（同目录）→ 在途去重 → 不再发起 listDir
    emitFolderChanged({ root: ROOT, paths: [`${ROOT}/b.md`], hasRemove: false });
    await act(async () => {
      vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
    });
    expect(vi.mocked(fileService.listDir)).toHaveBeenCalledTimes(1);

    // IO 完成 → 在途集合清空（finally 保证）
    await act(async () => {
      resolveIo?.();
    });
    expect(refreshDirInFlight.size).toBe(0);
  });
});

// ─── 5. 根目录被外部删除（P4 拍板） ──────────────────────
describe("v0.8.4 需求10：根目录被外部删除 → 保持该栏 + toast", () => {
  it("事件含根路径自身且 hasRemove → toast 提示，文件夹不被自动关闭", async () => {
    setupProject();
    await renderTree();
    emitFolderChanged({ root: ROOT, paths: [ROOT, `${ROOT}/a.md`], hasRemove: true });
    await act(async () => {
      vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
    });
    // toast 文案（zh-CN）
    const toast = document.querySelector(".filetree-toast");
    expect(toast?.textContent).toContain("文件夹已在外部被删除或移动");
    // 不自动关闭：openFolders 仍保留该栏
    expect(useFileStore.getState().openFolders).toHaveLength(1);
    expect(useFileStore.getState().openFolders[0]?.path).toBe(ROOT);
  });

  it("普通子路径删除 → 不弹根删除 toast", async () => {
    setupProject();
    await renderTree();
    emitFolderChanged({ root: ROOT, paths: [`${ROOT}/a.md`], hasRemove: true });
    await act(async () => {
      vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
    });
    expect(document.querySelector(".filetree-toast")).toBeNull();
  });
});

// ─── 6. watch 生命周期：打开注册 / 关闭注销 ──────────────────────
describe("v0.8.4 需求10：watch 生命周期", () => {
  it("打开文件夹成功 → watchFolder 以该路径注册", async () => {
    vi.mocked(fileService.listDir).mockImplementation(async (p: string) =>
      p === ROOT ? [{ name: "a.md", path: `${ROOT}/a.md`, is_dir: false, size: 1, modified_ms: 0, created_ms: 0 }] : [],
    );
    await renderTree();
    // 经 lightmd:openFolder 事件总线触发 openFolderAt（与拖拽打开同一路径）
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("lightmd:openFolder", { detail: { path: ROOT } }),
      );
    });
    expect(vi.mocked(fileService.watchFolder)).toHaveBeenCalledWith(ROOT);
  });

  it("关闭文件夹 → unwatchFolder 以该路径注销", async () => {
    setupProject();
    await renderTree();
    const closeBtn = document.querySelector(".section-close") as HTMLButtonElement;
    expect(closeBtn).toBeTruthy();
    await act(async () => {
      fireEvent.click(closeBtn);
    });
    expect(vi.mocked(fileService.unwatchFolder)).toHaveBeenCalledWith(ROOT);
    expect(useFileStore.getState().openFolders).toHaveLength(0);
  });
});
