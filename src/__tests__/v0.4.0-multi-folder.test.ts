/**
 * v0.4.0 多文件夹功能测试
 *
 * 覆盖：
 * 1. useFileStore 的 addOpenFolder / removeOpenFolder / updateFolderTree / isPathInOpenFolders
 * 2. 兼容字段 rootPath / fileTree 的同步维护
 * 3. setRootPath / setFileTree 的兼容行为
 * 4. persist partialize：openFolders 持久化路径但 fileTree 清空
 * 5. restoreRecentFolders(count) 多文件夹恢复（含路径不存在时移除）
 * 6. restoreRecentFolders 兼容模式（未传 addOpenFolder 时走旧逻辑）
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

// mock fileService（restoreRecentFolders 测试需要）
vi.mock("../services/fileService", () => ({
  fileService: {
    readFile: vi.fn(),
    listDir: vi.fn(),
    exists: vi.fn(),
    writeFile: vi.fn(),
    getFileSize: vi.fn(),
    createFile: vi.fn(),
    createDir: vi.fn(),
    deleteFile: vi.fn(),
    renameFile: vi.fn(),
  },
  isTauri: () => true,
}));

import { useFileStore } from "../stores/useFileStore";
import { restoreRecentFolders } from "../utils/startupRestore";
import { fileService } from "../services/fileService";

const mockedFileService = fileService as unknown as {
  listDir: ReturnType<typeof vi.fn>;
};

/** 设置 localStorage 中的 settings */
function setSettings(s: Record<string, unknown>) {
  localStorage.setItem("lightmd-settings", JSON.stringify({ state: s }));
}

/** 设置 localStorage 中的 file-store */
function setFileStore(s: Record<string, unknown>) {
  localStorage.setItem("lightmd-file-store", JSON.stringify({ state: s }));
}

/** 生成 N 个 fake 文件夹条目 */
function genFolders(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    path: `/test/folder-${i + 1}`,
    name: `folder-${i + 1}`,
    accessedAt: 1000 + i,
  }));
}

// ─── useFileStore 多文件夹操作 ──────────────────────────────

describe("v0.4.0: useFileStore 多文件夹操作", () => {
  beforeEach(() => {
    localStorage.removeItem("lightmd-file-store");
    // 每个测试前重置 store 状态，确保隔离
    useFileStore.setState({
      openFolders: [],
      rootPath: null,
      fileTree: [],
      recentFiles: [],
      recentFolders: [],
      favorites: [],
      tempFiles: [],
    });
  });

  describe("addOpenFolder", () => {
    it("添加文件夹后 openFolders 包含该路径，同步 rootPath/fileTree", () => {
      const store = useFileStore.getState();
      store.addOpenFolder("/test/folder-1");

      const state = useFileStore.getState();
      expect(state.openFolders).toHaveLength(1);
      expect(state.openFolders[0].path).toBe("/test/folder-1");
      expect(state.openFolders[0].name).toBe("folder-1");
      expect(state.openFolders[0].fileTree).toEqual([]);
      // 兼容字段同步
      expect(state.rootPath).toBe("/test/folder-1");
      expect(state.fileTree).toEqual([]);
    });

    it("追加多个文件夹（按顺序）", () => {
      const store = useFileStore.getState();
      store.addOpenFolder("/test/folder-1");
      store.addOpenFolder("/test/folder-2");
      store.addOpenFolder("/test/folder-3");

      const state = useFileStore.getState();
      expect(state.openFolders).toHaveLength(3);
      expect(state.openFolders.map((f) => f.path)).toEqual([
        "/test/folder-1",
        "/test/folder-2",
        "/test/folder-3",
      ]);
      // rootPath 始终指向第一个
      expect(state.rootPath).toBe("/test/folder-1");
    });

    it("去重：重复添加同一路径不重复添加", () => {
      const store = useFileStore.getState();
      store.addOpenFolder("/test/folder-1");
      store.addOpenFolder("/test/folder-2");
      store.addOpenFolder("/test/folder-1"); // 重复

      const state = useFileStore.getState();
      expect(state.openFolders).toHaveLength(2);
      expect(state.openFolders[0].path).toBe("/test/folder-1");
      expect(state.openFolders[1].path).toBe("/test/folder-2");
    });

    it("超过 MAX_OPEN_FOLDERS(5) 时截断到 5 个", () => {
      const store = useFileStore.getState();
      for (let i = 1; i <= 7; i++) {
        store.addOpenFolder(`/test/folder-${i}`);
      }
      const state = useFileStore.getState();
      expect(state.openFolders).toHaveLength(5);
      // 保留前 5 个（1-5），folder-6/7 被截断
      expect(state.openFolders[4].path).toBe("/test/folder-5");
    });

    it("同步更新 recentFolders（去重 + 头插）", () => {
      const store = useFileStore.getState();
      store.addOpenFolder("/test/folder-1");

      const state = useFileStore.getState();
      expect(state.recentFolders).toHaveLength(1);
      expect(state.recentFolders[0].path).toBe("/test/folder-1");
      expect(state.recentFolders[0].name).toBe("folder-1");
    });
  });

  describe("removeOpenFolder", () => {
    it("移除第一个后 rootPath 指向下一个", () => {
      const store = useFileStore.getState();
      store.addOpenFolder("/test/folder-1");
      store.addOpenFolder("/test/folder-2");
      store.removeOpenFolder("/test/folder-1");

      const state = useFileStore.getState();
      expect(state.openFolders).toHaveLength(1);
      expect(state.openFolders[0].path).toBe("/test/folder-2");
      expect(state.rootPath).toBe("/test/folder-2");
    });

    it("移除中间的文件夹不影响其他", () => {
      const store = useFileStore.getState();
      store.addOpenFolder("/test/folder-1");
      store.addOpenFolder("/test/folder-2");
      store.addOpenFolder("/test/folder-3");
      store.removeOpenFolder("/test/folder-2");

      const state = useFileStore.getState();
      expect(state.openFolders).toHaveLength(2);
      expect(state.openFolders[0].path).toBe("/test/folder-1");
      expect(state.openFolders[1].path).toBe("/test/folder-3");
      expect(state.rootPath).toBe("/test/folder-1");
    });

    it("移除最后一个后 rootPath 为 null，fileTree 为空", () => {
      const store = useFileStore.getState();
      store.addOpenFolder("/test/folder-1");
      store.removeOpenFolder("/test/folder-1");

      const state = useFileStore.getState();
      expect(state.openFolders).toHaveLength(0);
      expect(state.rootPath).toBe(null);
      expect(state.fileTree).toEqual([]);
    });

    it("移除不存在的文件夹无副作用", () => {
      const store = useFileStore.getState();
      store.addOpenFolder("/test/folder-1");
      store.removeOpenFolder("/test/not-exist");

      const state = useFileStore.getState();
      expect(state.openFolders).toHaveLength(1);
    });
  });

  describe("updateFolderTree", () => {
    it("正确更新对应文件夹的 fileTree", () => {
      const store = useFileStore.getState();
      store.addOpenFolder("/test/folder-1");
      store.addOpenFolder("/test/folder-2");

      const tree1 = [
        { name: "a.md", path: "/test/folder-1/a.md", isDir: false, size: 10 },
      ];
      store.updateFolderTree("/test/folder-1", tree1);

      const state = useFileStore.getState();
      expect(state.openFolders[0].fileTree).toEqual(tree1);
      // 第一个文件夹更新时同步 fileTree 兼容字段
      expect(state.fileTree).toEqual(tree1);
      // 第二个文件夹不受影响
      expect(state.openFolders[1].fileTree).toEqual([]);
    });

    it("更新非第一个文件夹不影响 fileTree 兼容字段", () => {
      const store = useFileStore.getState();
      store.addOpenFolder("/test/folder-1");
      store.addOpenFolder("/test/folder-2");

      const tree2 = [
        { name: "b.md", path: "/test/folder-2/b.md", isDir: false, size: 20 },
      ];
      store.updateFolderTree("/test/folder-2", tree2);

      const state = useFileStore.getState();
      expect(state.openFolders[1].fileTree).toEqual(tree2);
      // 兼容字段仍指向第一个文件夹（空）
      expect(state.fileTree).toEqual([]);
    });

    it("更新不存在的文件夹无副作用", () => {
      const store = useFileStore.getState();
      store.addOpenFolder("/test/folder-1");
      store.updateFolderTree("/test/not-exist", [
        { name: "x", path: "/test/not-exist/x", isDir: false, size: 0 },
      ]);

      const state = useFileStore.getState();
      expect(state.openFolders[0].fileTree).toEqual([]);
    });
  });

  describe("isPathInOpenFolders", () => {
    it("多个文件夹路径判断", () => {
      const store = useFileStore.getState();
      store.addOpenFolder("/test/folder-1");
      store.addOpenFolder("/test/folder-2");

      const state = useFileStore.getState();
      expect(state.isPathInOpenFolders("/test/folder-1/a.md")).toBe(true);
      expect(state.isPathInOpenFolders("/test/folder-2/sub/b.md")).toBe(true);
      expect(state.isPathInOpenFolders("/test/folder-1")).toBe(true);
      expect(state.isPathInOpenFolders("/test/other/c.md")).toBe(false);
      expect(state.isPathInOpenFolders("/test/folder-1-other/d.md")).toBe(false);
    });

    it("无打开文件夹时返回 false", () => {
      const state = useFileStore.getState();
      expect(state.isPathInOpenFolders("/any/path")).toBe(false);
    });
  });

  describe("兼容方法 setRootPath / setFileTree", () => {
    it("setRootPath(path) 替换为单个文件夹", () => {
      const store = useFileStore.getState();
      store.addOpenFolder("/test/folder-1");
      store.addOpenFolder("/test/folder-2");
      store.setRootPath("/test/folder-3");

      const state = useFileStore.getState();
      expect(state.openFolders).toHaveLength(1);
      expect(state.openFolders[0].path).toBe("/test/folder-3");
      expect(state.rootPath).toBe("/test/folder-3");
    });

    it("setRootPath(null) 清空所有文件夹", () => {
      const store = useFileStore.getState();
      store.addOpenFolder("/test/folder-1");
      store.setRootPath(null);

      const state = useFileStore.getState();
      expect(state.openFolders).toHaveLength(0);
      expect(state.rootPath).toBe(null);
    });

    it("setFileTree 更新 openFolders[0].fileTree", () => {
      const store = useFileStore.getState();
      store.addOpenFolder("/test/folder-1");
      const tree = [
        { name: "a.md", path: "/test/folder-1/a.md", isDir: false, size: 10 },
      ];
      store.setFileTree(tree);

      const state = useFileStore.getState();
      expect(state.openFolders[0].fileTree).toEqual(tree);
      expect(state.fileTree).toEqual(tree);
    });
  });

  describe("persist partialize", () => {
    // Issue 1 修复：openFolders 不再持久化，避免 zustand persist 启动时自动恢复文件夹，
    // 绕过 loadLastFolderOnStartup 开关检查。启动恢复只由 startupRestore.ts 控制。
    it("openFolders 不再被持久化（Issue 1 修复）", () => {
      const store = useFileStore.getState();
      store.addOpenFolder("/test/folder-1");
      const tree = [
        { name: "a.md", path: "/test/folder-1/a.md", isDir: false, size: 10 },
      ];
      store.updateFolderTree("/test/folder-1", tree);

      // 读取 localStorage 验证 partialize 结果
      const raw = localStorage.getItem("lightmd-file-store");
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw!);
      // openFolders 不应出现在持久化数据中
      expect(parsed.state.openFolders).toBeUndefined();
      // 但内存中的 store 仍然有 openFolders（只是不持久化）
      // 注意：需要重新 getState() 获取最新状态，store 是调用时的快照
      expect(useFileStore.getState().openFolders).toHaveLength(1);
      expect(useFileStore.getState().openFolders[0].path).toBe("/test/folder-1");
    });

    it("多个文件夹均不持久化（Issue 1 修复）", () => {
      const store = useFileStore.getState();
      store.addOpenFolder("/test/folder-1");
      store.addOpenFolder("/test/folder-2");
      store.updateFolderTree("/test/folder-1", [
        { name: "a.md", path: "/test/folder-1/a.md", isDir: false, size: 10 },
      ]);
      store.updateFolderTree("/test/folder-2", [
        { name: "b.md", path: "/test/folder-2/b.md", isDir: false, size: 20 },
      ]);

      const raw = localStorage.getItem("lightmd-file-store");
      const parsed = JSON.parse(raw!);
      // openFolders 不应出现在持久化数据中
      expect(parsed.state.openFolders).toBeUndefined();
      // 内存中的 store 仍然有多个文件夹（重新 getState 获取最新状态）
      expect(useFileStore.getState().openFolders).toHaveLength(2);
    });
  });
});

// ─── restoreRecentFolders 多文件夹恢复 ──────────────────────────────

describe("v0.4.0: restoreRecentFolders 多文件夹恢复", () => {
  beforeEach(() => {
    localStorage.clear();
    mockedFileService.listDir.mockReset();
  });

  it("count=3 时串行恢复 3 个文件夹，每个调用 addOpenFolder + updateFolderTree", async () => {
    setSettings({ loadLastFolderOnStartup: true });
    setFileStore({ recentFolders: genFolders(5) });
    mockedFileService.listDir.mockResolvedValue([]);

    const added: string[] = [];
    const updated: Array<{ path: string; entries: unknown[] }> = [];
    const result = await restoreRecentFolders({
      count: 3,
      addOpenFolder: (path) => added.push(path),
      updateFolderTree: (path, entries) => updated.push({ path, entries }),
      removeRecentFolder: () => {},
      isTauriEnv: true,
      delayMs: 0,
    });

    expect(result.restored).toBe(3);
    expect(result.skipped).toBe(0);
    // 串行顺序：folder-1, folder-2, folder-3
    expect(added).toEqual(["/test/folder-1", "/test/folder-2", "/test/folder-3"]);
    expect(updated).toHaveLength(3);
    expect(updated[0].path).toBe("/test/folder-1");
    expect(updated[1].path).toBe("/test/folder-2");
    expect(updated[2].path).toBe("/test/folder-3");
  });

  it("路径不存在时移除并继续恢复其他（listDir 抛错）", async () => {
    setSettings({ loadLastFolderOnStartup: true });
    setFileStore({ recentFolders: genFolders(3) });
    mockedFileService.listDir.mockImplementation(async (path: string) => {
      if (path === "/test/folder-2") throw new Error("not exists");
      return [];
    });

    const added: string[] = [];
    const removed: string[] = [];
    const result = await restoreRecentFolders({
      count: 3,
      addOpenFolder: (path) => added.push(path),
      updateFolderTree: () => {},
      removeRecentFolder: (path) => removed.push(path),
      isTauriEnv: true,
      delayMs: 0,
    });

    expect(result.restored).toBe(2);
    expect(result.skipped).toBe(1);
    // folder-2 失败被跳过，folder-1 和 folder-3 成功
    expect(added).toEqual(["/test/folder-1", "/test/folder-3"]);
    expect(removed).toEqual(["/test/folder-2"]);
  });

  it("所有路径都不存在时全部跳过，restored=0", async () => {
    setSettings({ loadLastFolderOnStartup: true });
    setFileStore({ recentFolders: genFolders(3) });
    mockedFileService.listDir.mockRejectedValue(new Error("all gone"));

    const added: string[] = [];
    const removed: string[] = [];
    const result = await restoreRecentFolders({
      count: 3,
      addOpenFolder: (path) => added.push(path),
      updateFolderTree: () => {},
      removeRecentFolder: (path) => removed.push(path),
      isTauriEnv: true,
      delayMs: 0,
    });

    expect(result.restored).toBe(0);
    expect(result.skipped).toBe(3);
    expect(added).toHaveLength(0);
    expect(removed).toHaveLength(3);
  });

  it("count 超过 5 时被钳制到 5", async () => {
    setSettings({ loadLastFolderOnStartup: true });
    setFileStore({ recentFolders: genFolders(8) });
    mockedFileService.listDir.mockResolvedValue([]);

    const added: string[] = [];
    const result = await restoreRecentFolders({
      count: 100,
      addOpenFolder: (path) => added.push(path),
      updateFolderTree: () => {},
      removeRecentFolder: () => {},
      isTauriEnv: true,
      delayMs: 0,
    });

    expect(result.restored).toBe(5);
    expect(added).toHaveLength(5);
  });

  it("loadLastFolderOnStartup=false 时不恢复", async () => {
    setSettings({ loadLastFolderOnStartup: false });
    setFileStore({ recentFolders: genFolders(3) });
    mockedFileService.listDir.mockResolvedValue([]);

    const added: string[] = [];
    const result = await restoreRecentFolders({
      count: 3,
      addOpenFolder: (path) => added.push(path),
      updateFolderTree: () => {},
      isTauriEnv: true,
      delayMs: 0,
    });

    expect(result.restored).toBe(0);
    expect(added).toHaveLength(0);
  });

  it("未传 addOpenFolder 时走兼容模式（仅恢复第一个为 rootPath）", async () => {
    setSettings({ loadLastFolderOnStartup: true, loadLastFolderCount: 3 });
    setFileStore({ recentFolders: genFolders(3) });
    mockedFileService.listDir.mockResolvedValue([]);

    let setRootPathValue: string | null = null;
    const result = await restoreRecentFolders({
      setRootPath: (path) => {
        setRootPathValue = path;
      },
      removeRecentFolder: () => {},
      isTauriEnv: true,
      delayMs: 0,
    });

    // 兼容模式：仅恢复第一个
    expect(result.restored).toBe(1);
    expect(setRootPathValue).toBe("/test/folder-1");
  });

  it("未传 count 时从 settings.loadLastFolderCount 读取", async () => {
    setSettings({ loadLastFolderOnStartup: true, loadLastFolderCount: 2 });
    setFileStore({ recentFolders: genFolders(5) });
    mockedFileService.listDir.mockResolvedValue([]);

    const added: string[] = [];
    const result = await restoreRecentFolders({
      addOpenFolder: (path) => added.push(path),
      updateFolderTree: () => {},
      removeRecentFolder: () => {},
      isTauriEnv: true,
      delayMs: 0,
    });

    expect(result.restored).toBe(2);
    expect(added).toEqual(["/test/folder-1", "/test/folder-2"]);
  });
});
