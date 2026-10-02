/**
 * v0.9.5 三问题修复批次测试:启动恢复
 *
 * 问题2:legacy 启动恢复以「退出时刻打开的文件标签列表」为数据源,
 *       手动关闭的标签不再被恢复(旧版本无快照时回退历史 N 条)
 * 问题3:启动恢复读取已删除文件时静默(readFile 收到 silent 选项),
 *       只标 ⚠ 不弹红色错误提示
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

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

import { restoreRecentFiles } from "../utils/startupRestore";
import { fileService } from "../services/fileService";

const readFileMock = fileService.readFile as unknown as ReturnType<typeof vi.fn>;

function setSettings(s: Record<string, unknown>) {
  mockStorage["lightmd-settings"] = JSON.stringify({ state: s });
}

function setFileStore(s: Record<string, unknown>) {
  mockStorage["lightmd-file-store"] = JSON.stringify({ state: s });
}

beforeEach(() => {
  Object.keys(mockStorage).forEach((k) => delete mockStorage[k]);
  readFileMock.mockReset();
});

describe("v0.9.5 问题2:退出时标签列表为恢复源", () => {
  it("只恢复快照列表中的文件,历史里已关闭的标签不再被恢复", async () => {
    setSettings({ loadLastFileOnStartup: true, loadLastFileCount: 30 });
    setFileStore({
      recentFiles: [
        { path: "/a.md", name: "a.md", accessedAt: 3000 },
        { path: "/b.md", name: "b.md", accessedAt: 2000 },
        { path: "/c.md", name: "c.md", accessedAt: 1000 },
      ],
    });
    // 退出时刻只有 A、B 开着(C 已被用户手动关闭)
    mockStorage["lightmd-open-file-tabs"] = JSON.stringify([
      { path: "/a.md", name: "a.md" },
      { path: "/b.md", name: "b.md" },
    ]);
    readFileMock.mockImplementation((p: string) =>
      p === "/b.md" ? Promise.reject(new Error("文件不存在")) : Promise.resolve("content-" + p)
    );
    const stale: string[] = [];
    const opened: string[] = [];
    const r = await restoreRecentFiles({
      dispatchOpenFile: (d) => opened.push(d.path),
      markRecentStale: (p) => stale.push(p),
    });
    expect(opened).toEqual(["/a.md"]);
    expect(stale).toEqual(["/b.md"]);
    expect(r.restored).toBe(1);
    expect(r.skipped).toBe(1);
  });

  it("快照列表不存在(旧版本升级)时回退历史 N 条旧行为", async () => {
    setSettings({ loadLastFileOnStartup: true, loadLastFileCount: 2 });
    setFileStore({
      recentFiles: [
        { path: "/a.md", name: "a.md", accessedAt: 3000 },
        { path: "/b.md", name: "b.md", accessedAt: 2000 },
        { path: "/c.md", name: "c.md", accessedAt: 1000 },
      ],
    });
    readFileMock.mockResolvedValue("content");
    const opened: string[] = [];
    await restoreRecentFiles({
      dispatchOpenFile: (d) => opened.push(d.path),
    });
    expect(opened).toEqual(["/a.md", "/b.md"]);
  });

  it("开关关闭时不恢复", async () => {
    setSettings({ loadLastFileOnStartup: false });
    mockStorage["lightmd-open-file-tabs"] = JSON.stringify([{ path: "/a.md", name: "a.md" }]);
    readFileMock.mockResolvedValue("content");
    const opened: string[] = [];
    const r = await restoreRecentFiles({
      dispatchOpenFile: (d) => opened.push(d.path),
    });
    expect(opened).toEqual([]);
    expect(r.restored).toBe(0);
  });
});

describe("v0.9.5 问题3:启动恢复读取静默", () => {
  it("readFile 以 silent:true 调用(不弹红色提示)", async () => {
    setSettings({ loadLastFileOnStartup: true });
    mockStorage["lightmd-open-file-tabs"] = JSON.stringify([{ path: "/a.md", name: "a.md" }]);
    readFileMock.mockResolvedValue("content");
    await restoreRecentFiles({
      dispatchOpenFile: () => {},
    });
    expect(readFileMock).toHaveBeenCalledWith("/a.md", { silent: true });
  });
});
