/**
 * v0.9.0 WP0/WP9：窗口 IPC 服务层与冲突判定。
 *
 * 覆盖：
 * - `windowService` 各命令的 invoke 载荷（camelCase 参数名与 Rust 侧一致）
 * - 非 Tauri 环境的安全降级（返回默认值 / no-op，不抛错）
 * - `createWindow` 对 Rust `LIMIT|` 错误码的映射
 * - `evaluateOpenConflict` 的冲突判定矩阵（AC-8 / 单窗口不弹框）
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...(args as [])),
  Channel: class {},
}));

import { windowService } from "../services/windowService";
import { evaluateOpenConflict } from "../services/openConflict";
import { __setWindowLabelForTest } from "../utils/windowLabel";

function enterTauri(label = "main") {
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    metadata: { currentWebview: { label } },
  };
}

function exitTauri() {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

beforeEach(() => {
  invokeMock.mockReset();
  __setWindowLabelForTest(null);
});

afterEach(() => {
  exitTauri();
  __setWindowLabelForTest(null);
  vi.restoreAllMocks();
});

describe("v0.9.0 WP0：windowService 命令载荷", () => {
  it("createWindow：无参时显式传 null（Rust 侧 Option 参数）", async () => {
    enterTauri("main");
    invokeMock.mockResolvedValue("sec-1");
    const label = await windowService.createWindow();
    expect(label).toBe("sec-1");
    expect(invokeMock).toHaveBeenCalledWith("create_window", { files: null, movedTabs: null });
  });

  it("createWindow：指定文件时透传 files", async () => {
    enterTauri("main");
    invokeMock.mockResolvedValue("sec-2");
    await windowService.createWindow({ files: ["D:/a.md"] });
    expect(invokeMock).toHaveBeenCalledWith("create_window", {
      files: ["D:/a.md"],
      movedTabs: null,
    });
  });

  it("createWindow：LIMIT| 前缀映射为窗口上限错误（AC-15）", async () => {
    enterTauri("main");
    invokeMock.mockRejectedValue("LIMIT|窗口数量已达上限（最多 8 个）");
    await expect(windowService.createWindow()).rejects.toThrow("LIMIT");
  });

  it("createWindow：其他错误原样抛出（供 toast 展示细节）", async () => {
    enterTauri("main");
    invokeMock.mockRejectedValue("创建窗口失败: boom");
    await expect(windowService.createWindow()).rejects.toThrow("创建窗口失败: boom");
  });

  it("syncWindowState：整体作为 report 传入（Rust 侧下划线转 camelCase）", async () => {
    enterTauri("sec-1");
    invokeMock.mockResolvedValue(undefined);
    const report = {
      label: "sec-1",
      activeTabIdx: 1,
      tabs: [
        {
          kind: "file" as const,
          path: "D:/a.md",
          untitledId: null,
          name: "a.md",
          pinned: false,
          isDirty: true,
        },
      ],
      folderPaths: ["D:/docs"],
    };
    await windowService.syncWindowState(report);
    expect(invokeMock).toHaveBeenCalledWith("sync_window_state", { report });
  });

  it("queryFileOpen：返回注册表记录", async () => {
    enterTauri("main");
    invokeMock.mockResolvedValue([{ label: "sec-1", isDirty: true }]);
    await expect(windowService.queryFileOpen("D:/a.md")).resolves.toEqual([
      { label: "sec-1", isDirty: true },
    ]);
    expect(invokeMock).toHaveBeenCalledWith("query_file_open", { path: "D:/a.md" });
  });

  it("getWindowSession / restoreWindows / hasSession 参数正确", async () => {
    enterTauri("sec-3");
    invokeMock.mockResolvedValue(null);
    await windowService.getWindowSession("sec-3");
    expect(invokeMock).toHaveBeenCalledWith("get_window_session", { label: "sec-3" });

    invokeMock.mockResolvedValue(["sec-1", "sec-2"]);
    await expect(windowService.restoreWindows()).resolves.toEqual(["sec-1", "sec-2"]);
    expect(invokeMock).toHaveBeenCalledWith("restore_windows");

    invokeMock.mockResolvedValue(true);
    await expect(windowService.hasSession()).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("has_session");
  });

  it("关闭流程命令：abort_close / confirm_close / request_close_window", async () => {
    enterTauri("sec-1");
    invokeMock.mockResolvedValue(undefined);
    await windowService.abortClose();
    expect(invokeMock).toHaveBeenCalledWith("abort_close");
    await windowService.confirmClose();
    expect(invokeMock).toHaveBeenCalledWith("confirm_close");
    await windowService.requestCloseWindow("sec-1");
    expect(invokeMock).toHaveBeenCalledWith("request_close_window", { label: "sec-1" });
  });

  it("takeBoot：非 Tauri 环境回退为主窗口空引导（不 invoke）", async () => {
    const boot = await windowService.takeBoot();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(boot.label).toBe("main");
    expect(boot.restore).toBe(false);
    expect(boot.files).toEqual([]);
  });

  it("非 Tauri 环境：所有写操作静默成功，查询返回安全默认值", async () => {
    await expect(windowService.syncWindowState({
      label: "main",
      activeTabIdx: 0,
      tabs: [],
      folderPaths: [],
    })).resolves.toBeUndefined();
    await expect(windowService.focusWindow("sec-1")).resolves.toBeUndefined();
    await expect(windowService.queryFileOpen("D:/a.md")).resolves.toEqual([]);
    await expect(windowService.hasSession()).resolves.toBe(false);
    await expect(windowService.restoreWindows()).resolves.toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("查询类命令 invoke 失败时降级为空结果（不阻断打开文件）", async () => {
    enterTauri("main");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    invokeMock.mockRejectedValue(new Error("ipc down"));
    await expect(windowService.queryFileOpen("D:/a.md")).resolves.toEqual([]);
    await expect(windowService.listWindows()).resolves.toEqual([]);
    await expect(windowService.getWindowSession("main")).resolves.toBeNull();
    errSpy.mockRestore();
  });
});

describe("v0.9.0 WP9：冲突判定矩阵", () => {
  it("无人打开该文件 → 无冲突", () => {
    expect(evaluateOpenConflict([], "main")).toEqual({
      hasConflict: false,
      dirtyLabels: [],
      otherLabels: [],
    });
  });

  it("只有本窗口打开（自己开自己的文件不算冲突）", () => {
    const r = evaluateOpenConflict([{ label: "main", isDirty: true }], "main");
    expect(r.hasConflict).toBe(false);
    expect(r.otherLabels).toEqual([]);
  });

  it("其他窗口打开但不脏 → 直接打开（同文件多开合法）", () => {
    const r = evaluateOpenConflict(
      [{ label: "sec-1", isDirty: false }, { label: "main", isDirty: true }],
      "main",
    );
    expect(r.hasConflict).toBe(false);
    expect(r.otherLabels).toEqual(["sec-1"]);
  });

  it("其他窗口脏 → 冲突（AC-8）", () => {
    const r = evaluateOpenConflict(
      [
        { label: "sec-2", isDirty: true },
        { label: "sec-1", isDirty: false },
      ],
      "main",
    );
    expect(r.hasConflict).toBe(true);
    expect(r.dirtyLabels).toEqual(["sec-2"]);
    expect(r.otherLabels).toEqual(["sec-1", "sec-2"]);
  });

  it("多窗口同时脏 → 全部列出（对话框展示所有来源）", () => {
    const r = evaluateOpenConflict(
      [
        { label: "sec-3", isDirty: true },
        { label: "sec-1", isDirty: true },
      ],
      "main",
    );
    expect(r.dirtyLabels).toEqual(["sec-1", "sec-3"]);
  });

  it("单窗口（仅自身）永不冲突 → 单窗口下不弹任何新对话框", () => {
    const r = evaluateOpenConflict([{ label: "main", isDirty: true }], "main");
    expect(r.hasConflict).toBe(false);
  });
});
