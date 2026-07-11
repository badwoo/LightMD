/**
 * 启动恢复逻辑测试
 *
 * 覆盖 F2（文件恢复）和 F3（文件夹恢复）的所有场景：
 * - F2: N=1 / N=3 / N=50 / 边界值钳制 / 文件不存在静默跳过
 * - F3: 开关关闭 / N=1 / 文件夹不存在静默跳过
 *
 * 使用 mock localStorage 和 mock fileService，避免依赖真实文件系统
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// 先准备 mock localStorage
const mockStorage: Record<string, string> = {};

(globalThis as any).localStorage = {
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

// mock isTauri 始终返回 true（测试在 Tauri 环境中执行）
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

import { restoreRecentFiles, restoreRecentFolders } from "../utils/startupRestore";
import { fileService } from "../services/fileService";

/** 设置 localStorage 中的 settings */
function setSettings(s: Record<string, unknown>) {
  mockStorage["lightmd-settings"] = JSON.stringify({ state: s });
}

/** 设置 localStorage 中的 file-store */
function setFileStore(s: Record<string, unknown>) {
  mockStorage["lightmd-file-store"] = JSON.stringify({ state: s });
}

/** 生成 N 个 fake 文件条目 */
function genFiles(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    path: `/test/file-${i + 1}.md`,
    name: `file-${i + 1}.md`,
    accessedAt: 1000 + i,
  }));
}

/** 生成 N 个 fake 文件夹条目 */
function genFolders(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    path: `/test/folder-${i + 1}`,
    name: `folder-${i + 1}`,
    accessedAt: 1000 + i,
  }));
}

const mockedFileService = fileService as unknown as {
  readFile: ReturnType<typeof vi.fn>;
  listDir: ReturnType<typeof vi.fn>;
  exists: ReturnType<typeof vi.fn>;
};

describe("F2: restoreRecentFiles 多文件恢复", () => {
  beforeEach(() => {
    Object.keys(mockStorage).forEach((k) => delete mockStorage[k]);
    mockedFileService.readFile.mockReset();
    mockedFileService.listDir.mockReset();
  });

  it("N=1 时仅恢复第一个文件", async () => {
    setSettings({ loadLastFileOnStartup: true, loadLastFileCount: 1 });
    setFileStore({ recentFiles: genFiles(3) });
    mockedFileService.readFile.mockImplementation(async (path: string) => `content of ${path}`);

    const dispatched: Array<{ path: string; content: string }> = [];
    const result = await restoreRecentFiles({
      dispatchOpenFile: (detail) => dispatched.push(detail),
      removeRecentFile: () => {},
      isTauriEnv: true,
    });

    expect(result.restored).toBe(1);
    expect(result.skipped).toBe(0);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].path).toBe("/test/file-1.md");
  });

  it("N=3 时串行恢复 3 个文件", async () => {
    setSettings({ loadLastFileOnStartup: true, loadLastFileCount: 3 });
    setFileStore({ recentFiles: genFiles(5) });
    mockedFileService.readFile.mockImplementation(async (path: string) => `content of ${path}`);

    const dispatched: Array<{ path: string; content: string }> = [];
    const result = await restoreRecentFiles({
      dispatchOpenFile: (detail) => dispatched.push(detail),
      removeRecentFile: () => {},
      isTauriEnv: true,
    });

    expect(result.restored).toBe(3);
    expect(result.skipped).toBe(0);
    expect(dispatched).toHaveLength(3);
    // 串行打开顺序与 recentFiles 顺序一致
    expect(dispatched[0].path).toBe("/test/file-1.md");
    expect(dispatched[1].path).toBe("/test/file-2.md");
    expect(dispatched[2].path).toBe("/test/file-3.md");
  });

  it("N=50 时恢复最多 50 个文件", async () => {
    setSettings({ loadLastFileOnStartup: true, loadLastFileCount: 50 });
    setFileStore({ recentFiles: genFiles(60) });
    mockedFileService.readFile.mockImplementation(async (path: string) => `content of ${path}`);

    const dispatched: Array<{ path: string; content: string }> = [];
    const result = await restoreRecentFiles({
      dispatchOpenFile: (detail) => dispatched.push(detail),
      removeRecentFile: () => {},
      isTauriEnv: true,
    });

    expect(result.restored).toBe(50);
    expect(dispatched).toHaveLength(50);
  });

  it("N 超过 50 时被钳制到 50", async () => {
    setSettings({ loadLastFileOnStartup: true, loadLastFileCount: 100 });
    setFileStore({ recentFiles: genFiles(60) });
    mockedFileService.readFile.mockImplementation(async (path: string) => `content of ${path}`);

    const dispatched: Array<{ path: string; content: string }> = [];
    const result = await restoreRecentFiles({
      dispatchOpenFile: (detail) => dispatched.push(detail),
      removeRecentFile: () => {},
      isTauriEnv: true,
    });

    expect(result.restored).toBe(50);
    expect(dispatched).toHaveLength(50);
  });

  it("N 小于 1 时被钳制到 1", async () => {
    setSettings({ loadLastFileOnStartup: true, loadLastFileCount: 0 });
    setFileStore({ recentFiles: genFiles(3) });
    mockedFileService.readFile.mockImplementation(async (path: string) => `content of ${path}`);

    const dispatched: Array<{ path: string; content: string }> = [];
    const result = await restoreRecentFiles({
      dispatchOpenFile: (detail) => dispatched.push(detail),
      removeRecentFile: () => {},
      isTauriEnv: true,
    });

    expect(result.restored).toBe(1);
    expect(dispatched).toHaveLength(1);
  });

  it("NaN 的 N 值被钳制到 1", async () => {
    setSettings({ loadLastFileOnStartup: true, loadLastFileCount: Number.NaN });
    setFileStore({ recentFiles: genFiles(3) });
    mockedFileService.readFile.mockImplementation(async (path: string) => `content of ${path}`);

    const dispatched: Array<{ path: string; content: string }> = [];
    const result = await restoreRecentFiles({
      dispatchOpenFile: (detail) => dispatched.push(detail),
      removeRecentFile: () => {},
      isTauriEnv: true,
    });

    expect(result.restored).toBe(1);
  });

  it("文件不存在时静默跳过并调用 removeRecentFile", async () => {
    setSettings({ loadLastFileOnStartup: true, loadLastFileCount: 3 });
    setFileStore({ recentFiles: genFiles(3) });
    // 第 2 个文件读取失败
    mockedFileService.readFile.mockImplementation(async (path: string) => {
      if (path === "/test/file-2.md") {
        throw new Error("file not found");
      }
      return `content of ${path}`;
    });

    const dispatched: Array<{ path: string; content: string }> = [];
    const removedPaths: string[] = [];
    const result = await restoreRecentFiles({
      dispatchOpenFile: (detail) => dispatched.push(detail),
      removeRecentFile: (path) => removedPaths.push(path),
      isTauriEnv: true,
    });

    expect(result.restored).toBe(2);
    expect(result.skipped).toBe(1);
    expect(dispatched).toHaveLength(2);
    expect(removedPaths).toEqual(["/test/file-2.md"]);
    // 失败的文件未被 dispatch
    expect(dispatched.find((d) => d.path === "/test/file-2.md")).toBeUndefined();
  });

  it("loadLastFileOnStartup=false 时不恢复任何文件", async () => {
    setSettings({ loadLastFileOnStartup: false, loadLastFileCount: 5 });
    setFileStore({ recentFiles: genFiles(5) });

    const dispatched: Array<{ path: string; content: string }> = [];
    const result = await restoreRecentFiles({
      dispatchOpenFile: (detail) => dispatched.push(detail),
      removeRecentFile: () => {},
      isTauriEnv: true,
    });

    expect(result.restored).toBe(0);
    expect(dispatched).toHaveLength(0);
  });

  it("非 Tauri 环境不恢复", async () => {
    setSettings({ loadLastFileOnStartup: true, loadLastFileCount: 5 });
    setFileStore({ recentFiles: genFiles(5) });

    const dispatched: Array<{ path: string; content: string }> = [];
    const result = await restoreRecentFiles({
      dispatchOpenFile: (detail) => dispatched.push(detail),
      removeRecentFile: () => {},
      isTauriEnv: false,
    });

    expect(result.restored).toBe(0);
    expect(dispatched).toHaveLength(0);
  });

  it("recentFiles 为空时回退到 lightmd-last-file（向后兼容）", async () => {
    setSettings({ loadLastFileOnStartup: true, loadLastFileCount: 3 });
    setFileStore({ recentFiles: [] });
    mockStorage["lightmd-last-file"] = "/legacy/last.md";
    mockedFileService.readFile.mockImplementation(async (path: string) => `content of ${path}`);

    const dispatched: Array<{ path: string; content: string }> = [];
    const result = await restoreRecentFiles({
      dispatchOpenFile: (detail) => dispatched.push(detail),
      removeRecentFile: () => {},
      isTauriEnv: true,
    });

    expect(result.restored).toBe(1);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].path).toBe("/legacy/last.md");
  });

  it("recentFiles 和 lightmd-last-file 均为空时不恢复", async () => {
    setSettings({ loadLastFileOnStartup: true, loadLastFileCount: 3 });
    setFileStore({ recentFiles: [] });

    const dispatched: Array<{ path: string; content: string }> = [];
    const result = await restoreRecentFiles({
      dispatchOpenFile: (detail) => dispatched.push(detail),
      removeRecentFile: () => {},
      isTauriEnv: true,
    });

    expect(result.restored).toBe(0);
    expect(dispatched).toHaveLength(0);
  });

  it("串行 await 确保标签顺序：第 2 个文件在第 1 个 dispatch 后才读取", async () => {
    setSettings({ loadLastFileOnStartup: true, loadLastFileCount: 3 });
    setFileStore({ recentFiles: genFiles(3) });

    const callOrder: string[] = [];
    mockedFileService.readFile.mockImplementation(async (path: string) => {
      callOrder.push(`read:${path}`);
      // 模拟延迟，确保串行性
      await new Promise((r) => setTimeout(r, 10));
      callOrder.push(`done:${path}`);
      return `content of ${path}`;
    });

    const dispatchOrder: string[] = [];
    await restoreRecentFiles({
      dispatchOpenFile: (detail) => {
        dispatchOrder.push(`dispatch:${detail.path}`);
      },
      removeRecentFile: () => {},
      isTauriEnv: true,
    });

    // 串行：每个 read 都先于下一个 read，且 dispatch 在 read 完成后
    expect(callOrder[0]).toBe("read:/test/file-1.md");
    expect(callOrder[1]).toBe("done:/test/file-1.md");
    expect(callOrder[2]).toBe("read:/test/file-2.md");
    expect(callOrder[3]).toBe("done:/test/file-2.md");
    expect(callOrder[4]).toBe("read:/test/file-3.md");
    expect(callOrder[5]).toBe("done:/test/file-3.md");
    expect(dispatchOrder[0]).toBe("dispatch:/test/file-1.md");
    expect(dispatchOrder[1]).toBe("dispatch:/test/file-2.md");
    expect(dispatchOrder[2]).toBe("dispatch:/test/file-3.md");
  });

  it("所有文件都失败时仍正确返回 skipped 计数", async () => {
    setSettings({ loadLastFileOnStartup: true, loadLastFileCount: 3 });
    setFileStore({ recentFiles: genFiles(3) });
    mockedFileService.readFile.mockRejectedValue(new Error("all gone"));

    const dispatched: Array<{ path: string; content: string }> = [];
    const removedPaths: string[] = [];
    const result = await restoreRecentFiles({
      dispatchOpenFile: (detail) => dispatched.push(detail),
      removeRecentFile: (path) => removedPaths.push(path),
      isTauriEnv: true,
    });

    expect(result.restored).toBe(0);
    expect(result.skipped).toBe(3);
    expect(dispatched).toHaveLength(0);
    expect(removedPaths).toHaveLength(3);
  });
});

describe("F3: restoreRecentFolders 文件夹恢复", () => {
  beforeEach(() => {
    Object.keys(mockStorage).forEach((k) => delete mockStorage[k]);
    mockedFileService.readFile.mockReset();
    mockedFileService.listDir.mockReset();
  });

  it("loadLastFolderOnStartup=false 时不恢复", async () => {
    setSettings({ loadLastFolderOnStartup: false, loadLastFolderCount: 1 });
    setFileStore({ recentFolders: genFolders(3) });

    let setRootCalled = false;
    const result = await restoreRecentFolders({
      setRootPath: () => {
        setRootCalled = true;
      },
      removeRecentFolder: () => {},
      isTauriEnv: true,
      delayMs: 0,
    });

    expect(result.restored).toBe(0);
    expect(setRootCalled).toBe(false);
  });

  it("N=1 时恢复第一个文件夹为 rootPath", async () => {
    setSettings({ loadLastFolderOnStartup: true, loadLastFolderCount: 1 });
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

    expect(result.restored).toBe(1);
    expect(setRootPathValue).toBe("/test/folder-1");
  });

  it("N 超过 5 时被钳制到 5", async () => {
    setSettings({ loadLastFolderOnStartup: true, loadLastFolderCount: 100 });
    setFileStore({ recentFolders: genFolders(8) });
    mockedFileService.listDir.mockResolvedValue([]);

    const result = await restoreRecentFolders({
      setRootPath: () => {},
      removeRecentFolder: () => {},
      isTauriEnv: true,
      delayMs: 0,
    });

    // 仅恢复第一个能访问的文件夹，其他不调用 listDir
    expect(result.restored).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("第一个文件夹不存在时尝试下一个", async () => {
    setSettings({ loadLastFolderOnStartup: true, loadLastFolderCount: 3 });
    setFileStore({ recentFolders: genFolders(3) });
    // 第 1 个失败，第 2 个成功
    mockedFileService.listDir.mockImplementation(async (path: string) => {
      if (path === "/test/folder-1") throw new Error("not exists");
      return [];
    });

    let setRootPathValue: string | null = null;
    const removedFolders: string[] = [];
    const result = await restoreRecentFolders({
      setRootPath: (path) => {
        setRootPathValue = path;
      },
      removeRecentFolder: (path) => removedFolders.push(path),
      isTauriEnv: true,
      delayMs: 0,
    });

    expect(result.restored).toBe(1);
    expect(result.skipped).toBe(1);
    expect(setRootPathValue).toBe("/test/folder-2");
    expect(removedFolders).toEqual(["/test/folder-1"]);
  });

  it("所有文件夹都不存在时静默跳过所有，不调用 setRootPath", async () => {
    setSettings({ loadLastFolderOnStartup: true, loadLastFolderCount: 3 });
    setFileStore({ recentFolders: genFolders(3) });
    mockedFileService.listDir.mockRejectedValue(new Error("all gone"));

    let setRootCalled = false;
    const removedFolders: string[] = [];
    const result = await restoreRecentFolders({
      setRootPath: () => {
        setRootCalled = true;
      },
      removeRecentFolder: (path) => removedFolders.push(path),
      isTauriEnv: true,
      delayMs: 0,
    });

    expect(result.restored).toBe(0);
    expect(result.skipped).toBe(3);
    expect(setRootCalled).toBe(false);
    expect(removedFolders).toHaveLength(3);
  });

  it("非 Tauri 环境不恢复", async () => {
    setSettings({ loadLastFolderOnStartup: true, loadLastFolderCount: 3 });
    setFileStore({ recentFolders: genFolders(3) });

    let setRootCalled = false;
    const result = await restoreRecentFolders({
      setRootPath: () => {
        setRootCalled = true;
      },
      removeRecentFolder: () => {},
      isTauriEnv: false,
      delayMs: 0,
    });

    expect(result.restored).toBe(0);
    expect(setRootCalled).toBe(false);
  });

  it("recentFolders 为空时不恢复", async () => {
    setSettings({ loadLastFolderOnStartup: true, loadLastFolderCount: 3 });
    setFileStore({ recentFolders: [] });

    let setRootCalled = false;
    const result = await restoreRecentFolders({
      setRootPath: () => {
        setRootCalled = true;
      },
      removeRecentFolder: () => {},
      isTauriEnv: true,
      delayMs: 0,
    });

    expect(result.restored).toBe(0);
    expect(setRootCalled).toBe(false);
  });

  it("delayMs > 0 时延迟执行", async () => {
    setSettings({ loadLastFolderOnStartup: true, loadLastFolderCount: 1 });
    setFileStore({ recentFolders: genFolders(1) });
    mockedFileService.listDir.mockResolvedValue([]);

    const start = Date.now();
    await restoreRecentFolders({
      setRootPath: () => {},
      removeRecentFolder: () => {},
      isTauriEnv: true,
      delayMs: 50,
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40); // 容忍 ±10ms 误差
  });

  it("N 小于 1 时被钳制到 1", async () => {
    setSettings({ loadLastFolderOnStartup: true, loadLastFolderCount: 0 });
    setFileStore({ recentFolders: genFolders(3) });
    mockedFileService.listDir.mockResolvedValue([]);

    const result = await restoreRecentFolders({
      setRootPath: () => {},
      removeRecentFolder: () => {},
      isTauriEnv: true,
      delayMs: 0,
    });

    expect(result.restored).toBe(1);
  });

  // ─── v0.3.0 问题2：dispatchOpenFolder 派发事件 ──────────────────────
  describe("v0.3.0 问题2：恢复文件夹时派发 openFolder 事件", () => {
    it("恢复成功时调用 dispatchOpenFolder 派发恢复的文件夹路径", async () => {
      setSettings({ loadLastFolderOnStartup: true, loadLastFolderCount: 1 });
      setFileStore({ recentFolders: genFolders(3) });
      mockedFileService.listDir.mockResolvedValue([]);

      let dispatchedPath: string | null = null;
      const result = await restoreRecentFolders({
        setRootPath: () => {},
        dispatchOpenFolder: (path) => {
          dispatchedPath = path;
        },
        removeRecentFolder: () => {},
        isTauriEnv: true,
        delayMs: 0,
      });

      expect(result.restored).toBe(1);
      expect(dispatchedPath).toBe("/test/folder-1");
    });

    it("dispatchOpenFolder 在 setRootPath 之前调用（确保 FileTree 先加载文件树）", async () => {
      setSettings({ loadLastFolderOnStartup: true, loadLastFolderCount: 1 });
      setFileStore({ recentFolders: genFolders(1) });
      mockedFileService.listDir.mockResolvedValue([]);

      const callOrder: string[] = [];
      await restoreRecentFolders({
        setRootPath: () => {
          callOrder.push("setRootPath");
        },
        dispatchOpenFolder: () => {
          callOrder.push("dispatchOpenFolder");
        },
        removeRecentFolder: () => {},
        isTauriEnv: true,
        delayMs: 0,
      });

      // dispatchOpenFolder 必须先于 setRootPath 调用
      expect(callOrder).toEqual(["dispatchOpenFolder", "setRootPath"]);
    });

    it("所有文件夹都不存在时不调用 dispatchOpenFolder", async () => {
      setSettings({ loadLastFolderOnStartup: true, loadLastFolderCount: 3 });
      setFileStore({ recentFolders: genFolders(3) });
      mockedFileService.listDir.mockRejectedValue(new Error("not exists"));

      let dispatchedCount = 0;
      const result = await restoreRecentFolders({
        setRootPath: () => {},
        dispatchOpenFolder: () => {
          dispatchedCount++;
        },
        removeRecentFolder: () => {},
        isTauriEnv: true,
        delayMs: 0,
      });

      expect(result.restored).toBe(0);
      expect(dispatchedCount).toBe(0);
    });

    it("第一个文件夹失败、第二个成功时，dispatchOpenFolder 派发的是成功文件夹路径", async () => {
      setSettings({ loadLastFolderOnStartup: true, loadLastFolderCount: 3 });
      setFileStore({ recentFolders: genFolders(3) });
      mockedFileService.listDir.mockImplementation(async (path: string) => {
        if (path === "/test/folder-1") throw new Error("not exists");
        return [];
      });

      let dispatchedPath: string | null = null;
      const result = await restoreRecentFolders({
        setRootPath: () => {},
        dispatchOpenFolder: (path) => {
          dispatchedPath = path;
        },
        removeRecentFolder: () => {},
        isTauriEnv: true,
        delayMs: 0,
      });

      expect(result.restored).toBe(1);
      expect(dispatchedPath).toBe("/test/folder-2");
    });

    it("未传入 dispatchOpenFolder 时向后兼容（不报错）", async () => {
      setSettings({ loadLastFolderOnStartup: true, loadLastFolderCount: 1 });
      setFileStore({ recentFolders: genFolders(1) });
      mockedFileService.listDir.mockResolvedValue([]);

      let setRootPathValue: string | null = null;
      // 不传 dispatchOpenFolder，应该正常执行不报错
      const result = await restoreRecentFolders({
        setRootPath: (path) => {
          setRootPathValue = path;
        },
        removeRecentFolder: () => {},
        isTauriEnv: true,
        delayMs: 0,
      });

      expect(result.restored).toBe(1);
      expect(setRootPathValue).toBe("/test/folder-1");
    });

    it("loadLastFolderOnStartup=false 时不调用 dispatchOpenFolder", async () => {
      setSettings({ loadLastFolderOnStartup: false, loadLastFolderCount: 1 });
      setFileStore({ recentFolders: genFolders(3) });

      let dispatchedCount = 0;
      const result = await restoreRecentFolders({
        setRootPath: () => {},
        dispatchOpenFolder: () => {
          dispatchedCount++;
        },
        removeRecentFolder: () => {},
        isTauriEnv: true,
        delayMs: 0,
      });

      expect(result.restored).toBe(0);
      expect(dispatchedCount).toBe(0);
    });

    it("非 Tauri 环境不调用 dispatchOpenFolder", async () => {
      setSettings({ loadLastFolderOnStartup: true, loadLastFolderCount: 1 });
      setFileStore({ recentFolders: genFolders(3) });

      let dispatchedCount = 0;
      const result = await restoreRecentFolders({
        setRootPath: () => {},
        dispatchOpenFolder: () => {
          dispatchedCount++;
        },
        removeRecentFolder: () => {},
        isTauriEnv: false,
        delayMs: 0,
      });

      expect(result.restored).toBe(0);
      expect(dispatchedCount).toBe(0);
    });
  });
});
