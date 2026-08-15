/**
 * v0.4.5 关闭文件夹/文件后启动不再载入 - 单元测试
 *
 * 验证 Issue 1 修复：
 * 1. removeOpenFolder 同步从 recentFolders 中移除，避免下次启动恢复已关闭的文件夹
 * 2. closeTab 后调用 removeRecentFile，避免下次启动恢复已关闭的文件
 * 3. App.tsx 中两处 closeTab 调用都同步清理 recentFiles
 *
 * 测试策略：
 * - 直接测试 useFileStore.removeOpenFolder 的副作用（recentFolders 同步移除）
 * - 模拟启动恢复场景：关闭文件夹后 recentFolders 为空，restoreRecentFolders 不会恢复
 * - 验证 App.tsx 源码中 closeTab 调用处包含 removeRecentFile 清理逻辑
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { useFileStore } from "../stores/useFileStore";
import { restoreRecentFolders } from "../utils/startupRestore";

/** 读取源文件内容 */
function readSrc(relPath: string): string {
  return fs.readFileSync(path.resolve(__dirname, relPath), "utf-8");
}

// ─── mock localStorage（zustand persist 需要）────────────
const mockStorage: Record<string, string> = {};
const mockLocalStorage = {
  getItem: vi.fn((key: string) => mockStorage[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    mockStorage[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete mockStorage[key];
  }),
  clear: vi.fn(() => {
    Object.keys(mockStorage).forEach((k) => delete mockStorage[k]);
  }),
};
Object.defineProperty(globalThis, "localStorage", {
  value: mockLocalStorage,
  configurable: true,
  writable: true,
});

// ─── Issue 1: removeOpenFolder 同步清理 recentFolders ──────────────────────

describe("Issue 1: 关闭文件夹后启动不再载入", () => {
  beforeEach(() => {
    useFileStore.setState({
      openFolders: [],
      recentFiles: [],
      recentFolders: [],
      favorites: [],
      tempFiles: [],
      rootPath: null,
      fileTree: [],
    });
    Object.keys(mockStorage).forEach((k) => delete mockStorage[k]);
  });

  it("removeOpenFolder 同步从 recentFolders 中移除该文件夹", () => {
    const store = useFileStore.getState();
    // 模拟打开文件夹
    store.addOpenFolder("/test/folder-1");
    // 验证 recentFolders 已记录
    expect(useFileStore.getState().recentFolders).toHaveLength(1);
    expect(useFileStore.getState().recentFolders[0].path).toBe("/test/folder-1");

    // 关闭文件夹
    store.removeOpenFolder("/test/folder-1");

    // 验证 recentFolders 也被同步移除（v0.4.5 修复）
    expect(useFileStore.getState().openFolders).toHaveLength(0);
    expect(useFileStore.getState().recentFolders).toHaveLength(0);
  });

  it("关闭一个文件夹不影响其他文件夹的 recentFolders 记录", () => {
    const store = useFileStore.getState();
    store.addOpenFolder("/test/folder-1");
    store.addOpenFolder("/test/folder-2");

    expect(useFileStore.getState().recentFolders).toHaveLength(2);

    // 关闭 folder-1
    store.removeOpenFolder("/test/folder-1");

    // recentFolders 中应只剩 folder-2
    expect(useFileStore.getState().recentFolders).toHaveLength(1);
    expect(useFileStore.getState().recentFolders[0].path).toBe("/test/folder-2");
    expect(useFileStore.getState().openFolders).toHaveLength(1);
    expect(useFileStore.getState().openFolders[0].path).toBe("/test/folder-2");
  });

  it("关闭所有文件夹后 recentFolders 为空，启动恢复不会载入任何文件夹", async () => {
    // 模拟用户打开文件夹后关闭
    const store = useFileStore.getState();
    store.addOpenFolder("/test/folder-1");
    store.removeOpenFolder("/test/folder-1");

    // 验证 recentFolders 为空
    expect(useFileStore.getState().recentFolders).toHaveLength(0);

    // 模拟启动恢复：settings 开启 loadLastFolderOnStartup，count=1
    mockStorage["lightmd-settings"] = JSON.stringify({
      state: {
        loadLastFolderOnStartup: true,
        loadLastFolderCount: 1,
      },
    });
    // 模拟 recentFolders 持久化到 localStorage（空数组）
    mockStorage["lightmd-file-store"] = JSON.stringify({
      state: {
        recentFolders: useFileStore.getState().recentFolders,
        recentFiles: [],
        favorites: [],
      },
    });

    const addOpenFolder = vi.fn();
    const removeRecentFolder = vi.fn();
    const result = await restoreRecentFolders({
      storage: mockLocalStorage,
      fileServiceImpl: {
        readFile: vi.fn(),
        listDir: vi.fn(async () => []),
      },
      addOpenFolder,
      updateFolderTree: vi.fn(),
      removeRecentFolder,
      isTauriEnv: true,
      count: 1,
    });

    // 启动恢复应返回 restored=0，不调用 addOpenFolder
    expect(result.restored).toBe(0);
    expect(addOpenFolder).not.toHaveBeenCalled();
  });

  it("未关闭的文件夹仍可在下次启动时恢复", async () => {
    // 模拟用户打开两个文件夹，关闭其中一个
    const store = useFileStore.getState();
    store.addOpenFolder("/test/folder-1");
    store.addOpenFolder("/test/folder-2");
    store.removeOpenFolder("/test/folder-1");

    // recentFolders 中应只剩 folder-2
    expect(useFileStore.getState().recentFolders).toHaveLength(1);
    expect(useFileStore.getState().recentFolders[0].path).toBe("/test/folder-2");

    // 模拟启动恢复
    mockStorage["lightmd-settings"] = JSON.stringify({
      state: {
        loadLastFolderOnStartup: true,
        loadLastFolderCount: 1,
      },
    });
    mockStorage["lightmd-file-store"] = JSON.stringify({
      state: {
        recentFolders: useFileStore.getState().recentFolders,
        recentFiles: [],
        favorites: [],
      },
    });

    const addOpenFolder = vi.fn();
    const result = await restoreRecentFolders({
      storage: mockLocalStorage,
      fileServiceImpl: {
        readFile: vi.fn(),
        listDir: vi.fn(async () => []),
      },
      addOpenFolder,
      updateFolderTree: vi.fn(),
      removeRecentFolder: vi.fn(),
      isTauriEnv: true,
      count: 1,
    });

    // 应恢复 folder-2（未关闭的文件夹）
    expect(result.restored).toBe(1);
    expect(addOpenFolder).toHaveBeenCalledWith("/test/folder-2");
  });
});

// ─── Issue 1: 关闭文件标签页后启动不再载入 ──────────────────────

describe("Issue 1: 关闭文件标签页后启动不再载入", () => {
  it("App.tsx handleTabClose 中 closeTab 后调用 removeRecentFile", () => {
    const src = readSrc("../App.tsx");
    // 定位 handleTabClose 函数
    const handleTabCloseSection = src.match(/const handleTabClose[\s\S]*?\}, \[closeTab/);
    expect(handleTabCloseSection).not.toBeNull();
    // 验证 closeTab 后有 removeRecentFile 调用
    expect(handleTabCloseSection![0]).toMatch(/closeTab\(idx\)/);
    expect(handleTabCloseSection![0]).toMatch(/removeRecentFile\(tab\.path\)/);
  });

  it("App.tsx lightmd:closeFile 事件处理中 closeTab 后调用 removeRecentFile", () => {
    const src = readSrc("../App.tsx");
    // 定位文件关闭事件处理区域（从 "文件关闭事件" 注释到 addEventListener）
    const closeFileSection = src.match(/文件关闭事件[\s\S]*?addEventListener\("lightmd:closeFile"/);
    expect(closeFileSection).not.toBeNull();
    // 验证 closeTab 后有 removeRecentFile 调用
    expect(closeFileSection![0]).toMatch(/closeTab\(activeTabIdx\)/);
    expect(closeFileSection![0]).toMatch(/removeRecentFile\(closedTab\.path\)/);
  });

  it("removeRecentFile 正确从 recentFiles 中移除指定路径", () => {
    useFileStore.setState({
      recentFiles: [
        { path: "/test/file1.md", name: "file1.md", accessedAt: Date.now() },
        { path: "/test/file2.md", name: "file2.md", accessedAt: Date.now() },
      ],
      openFolders: [],
      recentFolders: [],
      favorites: [],
      tempFiles: [],
    });

    useFileStore.getState().removeRecentFile("/test/file1.md");

    expect(useFileStore.getState().recentFiles).toHaveLength(1);
    expect(useFileStore.getState().recentFiles[0].path).toBe("/test/file2.md");
  });

  it("关闭文件后 recentFiles 不再包含该文件，启动恢复不会载入", () => {
    // 模拟打开两个文件
    useFileStore.setState({
      recentFiles: [
        { path: "/test/file1.md", name: "file1.md", accessedAt: Date.now() },
        { path: "/test/file2.md", name: "file2.md", accessedAt: Date.now() },
      ],
      openFolders: [],
      recentFolders: [],
      favorites: [],
      tempFiles: [],
    });

    // 关闭 file1.md（模拟 App.tsx 中的 closeTab + removeRecentFile）
    useFileStore.getState().removeRecentFile("/test/file1.md");

    // recentFiles 中应只剩 file2.md
    expect(useFileStore.getState().recentFiles).toHaveLength(1);
    expect(useFileStore.getState().recentFiles[0].path).toBe("/test/file2.md");
  });
});
