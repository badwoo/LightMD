/**
 * 关闭文件夹/文件后的行为测试（v0.8.5 需求6 重写）
 *
 * 语义变更说明（v0.8.5 需求6，用户拍板「最近打开 = 纯历史记录」）：
 * - 旧 v0.4.5 行为：关闭文件夹/文件时同步从 recentFolders/recentFiles 中移除条目，
 *   以避免下次启动恢复已关闭的条目。
 * - 新行为：最近打开条目永不随关闭而消失；启动恢复改读 sessionFolders
 *   （上次会话结束时的打开文件夹快照），与 recentFolders 历史彻底解耦。
 *   本文件原「关闭同步移除」的断言已按新语义适配为「关闭不移除 + 快照同步」。
 *
 * 覆盖：
 * 1. removeOpenFolder 只更新会话快照 sessionFolders，recentFolders 历史条目保留
 * 2. 关闭文件夹后启动恢复不会载入（数据源 = sessionFolders 为空）
 * 3. 未关闭的文件夹仍可在下次启动时恢复
 * 4. App.tsx 各关闭路径（handleTabClose / lightmd:closeFile / closeTabsByPath /
 *    handleCloseMany）不再调用 removeRecentFile
 * 5. removeRecentFile action 本身仍正确（保留供未来手动清理功能使用）
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

// ─── 需求6: removeOpenFolder 与历史/快照的关系 ──────────────────────

describe("v0.8.5 需求6: 关闭文件夹不移除最近打开历史", () => {
  beforeEach(() => {
    useFileStore.setState({
      openFolders: [],
      recentFiles: [],
      recentFolders: [],
      sessionFolders: [],
      favorites: [],
      tempFiles: [],
      rootPath: null,
      fileTree: [],
    });
    Object.keys(mockStorage).forEach((k) => delete mockStorage[k]);
  });

  it("removeOpenFolder 后 recentFolders 历史条目保留（纯历史，不再同步移除）", () => {
    const store = useFileStore.getState();
    // 模拟打开文件夹
    store.addOpenFolder("/test/folder-1");
    // 验证 recentFolders 已记录
    expect(useFileStore.getState().recentFolders).toHaveLength(1);
    expect(useFileStore.getState().recentFolders[0].path).toBe("/test/folder-1");

    // 关闭文件夹
    store.removeOpenFolder("/test/folder-1");

    // openFolders 已移除；v0.8.5 需求6：历史条目保留在「最近打开」中
    expect(useFileStore.getState().openFolders).toHaveLength(0);
    expect(useFileStore.getState().recentFolders).toHaveLength(1);
    expect(useFileStore.getState().recentFolders[0].path).toBe("/test/folder-1");
    // 会话快照同步移除（启动恢复数据源）
    expect(useFileStore.getState().sessionFolders).toEqual([]);
  });

  it("关闭一个文件夹不影响其他文件夹的历史条目，快照只剩未关闭的", () => {
    const store = useFileStore.getState();
    store.addOpenFolder("/test/folder-1");
    store.addOpenFolder("/test/folder-2");

    expect(useFileStore.getState().recentFolders).toHaveLength(2);

    // 关闭 folder-1
    store.removeOpenFolder("/test/folder-1");

    // 历史条目两条都保留（folder-1 关闭后仍出现在「最近打开」）
    expect(useFileStore.getState().recentFolders).toHaveLength(2);
    // 会话快照只剩 folder-2
    expect(useFileStore.getState().sessionFolders).toEqual(["/test/folder-2"]);
    expect(useFileStore.getState().openFolders).toHaveLength(1);
    expect(useFileStore.getState().openFolders[0].path).toBe("/test/folder-2");
  });

  it("关闭所有文件夹后 sessionFolders 为空，启动恢复不会载入任何文件夹（历史条目仍在）", async () => {
    // 模拟用户打开文件夹后关闭
    const store = useFileStore.getState();
    store.addOpenFolder("/test/folder-1");
    store.removeOpenFolder("/test/folder-1");

    // 历史条目仍在；会话快照为空
    expect(useFileStore.getState().recentFolders).toHaveLength(1);
    expect(useFileStore.getState().sessionFolders).toEqual([]);

    // 模拟启动恢复：settings 开启 loadLastFolderOnStartup，count=1
    mockStorage["lightmd-settings"] = JSON.stringify({
      state: {
        loadLastFolderOnStartup: true,
        loadLastFolderCount: 1,
      },
    });
    // 模拟持久化（zustand persist partialize 已包含 sessionFolders）
    mockStorage["lightmd-file-store"] = JSON.stringify({
      state: {
        sessionFolders: useFileStore.getState().sessionFolders,
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
      markRecentFolderStale: vi.fn(),
      isTauriEnv: true,
      count: 1,
    });

    // 启动恢复应返回 restored=0，不调用 addOpenFolder（即使 recentFolders 历史有条目）
    expect(result.restored).toBe(0);
    expect(addOpenFolder).not.toHaveBeenCalled();
  });

  it("未关闭的文件夹仍可在下次启动时恢复（数据源 = sessionFolders 快照）", async () => {
    // 模拟用户打开两个文件夹，关闭其中一个
    const store = useFileStore.getState();
    store.addOpenFolder("/test/folder-1");
    store.addOpenFolder("/test/folder-2");
    store.removeOpenFolder("/test/folder-1");

    // 会话快照只剩 folder-2；历史两条都在
    expect(useFileStore.getState().sessionFolders).toEqual(["/test/folder-2"]);
    expect(useFileStore.getState().recentFolders).toHaveLength(2);

    // 模拟启动恢复
    mockStorage["lightmd-settings"] = JSON.stringify({
      state: {
        loadLastFolderOnStartup: true,
        loadLastFolderCount: 1,
      },
    });
    mockStorage["lightmd-file-store"] = JSON.stringify({
      state: {
        sessionFolders: useFileStore.getState().sessionFolders,
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
      markRecentFolderStale: vi.fn(),
      isTauriEnv: true,
      count: 1,
    });

    // 应恢复 folder-2（未关闭的文件夹）
    expect(result.restored).toBe(1);
    expect(addOpenFolder).toHaveBeenCalledWith("/test/folder-2");
  });
});

// ─── 需求6: 关闭文件标签页不再移除 recentFiles ──────────────────────

describe("v0.8.5 需求6: 关闭文件标签页不移除最近打开历史", () => {
  it("App.tsx handleTabClose 中不再调用 removeRecentFile（v0.8.5 纯历史）", () => {
    const src = readSrc("../App.tsx");
    // 定位 handleTabClose 函数
    const handleTabCloseSection = src.match(/const handleTabClose[\s\S]*?\}, \[closeTab/);
    expect(handleTabCloseSection).not.toBeNull();
    // 仍有关闭逻辑
    expect(handleTabCloseSection![0]).toMatch(/closeTab\(idx\)/);
    // v0.8.5 需求6：关闭标签不再移除最近打开条目（旧 v0.4.5 行为已废弃）
    expect(handleTabCloseSection![0]).not.toMatch(/removeRecentFile\(/);
  });

  it("App.tsx lightmd:closeFile 事件处理中不再调用 removeRecentFile", () => {
    const src = readSrc("../App.tsx");
    // 定位文件关闭事件处理区域（从 "文件关闭事件" 注释到 addEventListener）
    const closeFileSection = src.match(/文件关闭事件[\s\S]*?addEventListener\("lightmd:closeFile"/);
    expect(closeFileSection).not.toBeNull();
    expect(closeFileSection![0]).toMatch(/closeTab\(activeTabIdx\)/);
    // v0.8.5 需求6：关闭标签不再移除最近打开条目
    expect(closeFileSection![0]).not.toMatch(/removeRecentFile\(/);
  });

  it("App.tsx 全文不再有任何 removeRecentFile 调用（handleTabClose / closeFile 事件 / closeTabsByPath / handleCloseMany / 启动恢复回调均已移除）", () => {
    const src = readSrc("../App.tsx");
    // v0.8.5 需求6：最近打开 = 纯历史记录，所有业务路径都不再删除条目
    // （文件被删除/移动的失效提示由 markRecentStale 标 ⚠，条目永不删除）
    expect(src).not.toMatch(/removeRecentFile\(/);
    // 启动恢复失败回调已改为注入 markRecentStale（标 stale 不移除）
    expect(src).toMatch(/markRecentStale: \(path\)/);
  });

  it("removeRecentFile action 本身仍正确移除指定路径（action 保留，业务不再调用）", () => {
    useFileStore.setState({
      recentFiles: [
        { path: "/test/file1.md", name: "file1.md", accessedAt: Date.now() },
        { path: "/test/file2.md", name: "file2.md", accessedAt: Date.now() },
      ],
      openFolders: [],
      recentFolders: [],
      sessionFolders: [],
      favorites: [],
      tempFiles: [],
    });

    useFileStore.getState().removeRecentFile("/test/file1.md");

    expect(useFileStore.getState().recentFiles).toHaveLength(1);
    expect(useFileStore.getState().recentFiles[0].path).toBe("/test/file2.md");
  });
});
