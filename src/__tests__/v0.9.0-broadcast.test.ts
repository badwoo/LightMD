/**
 * v0.9.0 WP5：全局状态广播。
 *
 * 覆盖：
 * - `diffFields` 字段级 diff（含"只同步持久化白名单字段"的性能契约）
 * - 自忽略：`sourceWindowId === 本窗口` 的广播不触发 rehydrate（防乒乓）
 * - 循环防护：应用对端广播引起的本地变化**不回播**
 * - `setupBroadcastListeners` 幂等 + teardown 清理
 *
 * 注意：这里**不能**用自建 mock 替换 localStorage —— zustand 的
 * `createJSONStorage` 在 store 创建（模块导入）时就固定了 storage 引用，
 * 之后的替换对它无效。jsdom 环境下的真实 localStorage 才是它实际读写的对象。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/** 事件监听注册表：{ eventName: handler } */
const eventHandlers: Record<string, (ev: { payload: unknown }) => void> = {};
const emitMock = vi.fn(async () => {});

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, cb: (ev: { payload: unknown }) => void) => {
    eventHandlers[event] = cb;
    return () => {
      delete eventHandlers[event];
    };
  },
  emit: (...args: unknown[]) => emitMock(...(args as [])),
}));

import {
  setupBroadcastListeners,
  teardownBroadcastListeners,
  diffFields,
  FILESTORE_SYNCED_FIELDS,
  SETTINGS_CHANGED_EVENT,
  FILESTORE_CHANGED_EVENT,
} from "../utils/broadcast";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useFileStore } from "../stores/useFileStore";
import { __setWindowLabelForTest } from "../utils/windowLabel";

/** 让本窗口看起来运行在 Tauri 环境（label = main） */
function enterTauri() {
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    metadata: { currentWebview: { label: "main" } },
  };
}

function exitTauri() {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  localStorage.clear();
  __setWindowLabelForTest(null);
  emitMock.mockClear();
  for (const k of Object.keys(eventHandlers)) delete eventHandlers[k];
  useSettingsStore.setState({ theme: "light", fontSize: 16 });
  useFileStore.setState({ recentFiles: [], recentFolders: [], favorites: [] });
});

afterEach(() => {
  teardownBroadcastListeners();
  exitTauri();
  __setWindowLabelForTest(null);
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("v0.9.0 WP5：diffFields", () => {
  it("null 字段表 → 比较全部非函数字段", () => {
    const a = { theme: "light", fontSize: 16, setTheme: () => {} };
    const b = { theme: "dark", fontSize: 16, setTheme: () => {} };
    expect(diffFields(a, b, null)).toEqual(["theme"]);
  });

  it("指定字段表 → 只比较白名单（高频非持久化字段不触发广播）", () => {
    const recentFiles = [1];
    const a = { recentFiles, tempFiles: [1], openFolders: [1] };
    const b = { recentFiles, tempFiles: [2], openFolders: [2] };
    // 只有 tempFiles/openFolders 变了，但它们不在同步白名单 → 无变化
    expect(diffFields(a, b, FILESTORE_SYNCED_FIELDS as unknown as (keyof typeof a)[])).toEqual([]);
    const c = { recentFiles: [2], tempFiles: [1], openFolders: [1] };
    expect(diffFields(a, c, FILESTORE_SYNCED_FIELDS as unknown as (keyof typeof a)[])).toEqual([
      "recentFiles",
    ]);
  });

  it("引用未变的字段不报变化（zustand 不可变更新语义）", () => {
    const same = [1, 2];
    expect(diffFields({ recentFiles: same }, { recentFiles: same }, ["recentFiles"])).toEqual([]);
  });
});

describe("v0.9.0 WP5：跨窗口同步", () => {
  it("非 Tauri 环境不注册事件监听（浏览器 dev 安全）", async () => {
    await setupBroadcastListeners();
    expect(eventHandlers[SETTINGS_CHANGED_EVENT]).toBeUndefined();
    expect(eventHandlers[FILESTORE_CHANGED_EVENT]).toBeUndefined();
  });

  it("收到对端设置广播 → rehydrate 到最新值（AC-5 主题同步）", async () => {
    enterTauri();
    await setupBroadcastListeners();
    const handler = eventHandlers[SETTINGS_CHANGED_EVENT];
    expect(handler).toBeTruthy();

    // 模拟对端已把新值写入共享 localStorage（真实 jsdom storage）
    localStorage.setItem(
      "lightmd-settings",
      JSON.stringify({ state: { theme: "night", fontSize: 20 }, version: 3 }),
    );
    handler({ payload: { sourceWindowId: "sec-1", changedKeys: ["theme"], timestamp: 1 } });
    await tick();

    expect(useSettingsStore.getState().theme).toBe("night");
    expect(useSettingsStore.getState().fontSize).toBe(20);
  });

  it("自忽略：sourceWindowId 等于本窗口时不 rehydrate（防乒乓）", async () => {
    enterTauri();
    await setupBroadcastListeners();
    const handler = eventHandlers[SETTINGS_CHANGED_EVENT];

    localStorage.setItem(
      "lightmd-settings",
      JSON.stringify({ state: { theme: "solarized" }, version: 3 }),
    );
    handler({ payload: { sourceWindowId: "main", changedKeys: ["theme"], timestamp: 1 } });
    await tick();

    // 保持本地值不变（忽略自身广播）
    expect(useSettingsStore.getState().theme).toBe("light");
  });

  it("循环防护：应用对端广播引起的本地变化不回播", async () => {
    enterTauri();
    await setupBroadcastListeners();
    const handler = eventHandlers[FILESTORE_CHANGED_EVENT];

    localStorage.setItem(
      "lightmd-file-store",
      JSON.stringify({
        state: { recentFiles: [{ path: "D:/x.md", name: "x.md", accessedAt: 1 }] },
        version: 0,
      }),
    );
    handler({ payload: { sourceWindowId: "sec-1", changedFields: ["recentFiles"], timestamp: 1 } });
    await tick();

    expect(useFileStore.getState().recentFiles[0]?.path).toBe("D:/x.md");
    // rehydrate 引起的 store 变化被抑制，不产生回播
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("本窗口用户操作会广播（payload 含 sourceWindowId / changedKeys / timestamp）", async () => {
    enterTauri();
    await setupBroadcastListeners();
    useSettingsStore.getState().setTheme("github");
    await tick();

    expect(emitMock).toHaveBeenCalled();
    const call = emitMock.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(call[0]).toBe(SETTINGS_CHANGED_EVENT);
    expect(call[1].sourceWindowId).toBe("main");
    expect(call[1].changedKeys).toContain("theme");
    expect(typeof call[1].timestamp).toBe("number");
  });

  it("文件库高频非同步字段变化不触发广播（性能契约）", async () => {
    enterTauri();
    await setupBroadcastListeners();
    // tempFiles 是「打开的文件」栏镜像，随标签高频变化，但不参与同步
    useFileStore.setState({ tempFiles: [{ name: "x", path: "D:/x", isDir: false, size: 0 }] });
    await tick();
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("setupBroadcastListeners 幂等（StrictMode 双挂载不重复注册）", async () => {
    enterTauri();
    await setupBroadcastListeners();
    const first = eventHandlers[SETTINGS_CHANGED_EVENT];
    await setupBroadcastListeners();
    expect(eventHandlers[SETTINGS_CHANGED_EVENT]).toBe(first);
  });

  it("teardown 后不再广播", async () => {
    enterTauri();
    await setupBroadcastListeners();
    teardownBroadcastListeners();
    emitMock.mockClear();
    useSettingsStore.getState().setTheme("dark");
    await tick();
    expect(emitMock).not.toHaveBeenCalled();
  });
});
