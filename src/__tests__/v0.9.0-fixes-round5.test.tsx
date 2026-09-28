/**
 * v0.9.0 第五轮用户反馈：同文件多窗口的**双向**即时刷新，以及"两个窗口同时编辑"的冲突规则。
 *
 * ## 规则（本轮确立）
 *
 * 1. 任一窗口保存 a.md 后，**其他**打开了 a.md 的窗口立即刷新：
 *    - 对方标签干净 → 立即重载并提示「已自动重新载入」；
 *    - 对方标签有未保存修改 → 不静默覆盖，标记「已被外部修改」并提示，保存时再确认。
 * 2. 磁盘内容始终以**最后一次成功保存**为准（后保存者胜），但**没有任何一次覆盖是静默的**：
 *    `Ctrl+S` / 关闭窗口时的「保存全部」/ 自动保存 三条写盘路径都必须让用户知情；
 *    自动保存（后台定时器）遇外部变更直接**暂停**并提示。
 *
 * ## 测试手法
 *
 * App.tsx 用 `await import("@tauri-apps/api/event")` 动态加载事件 API，`vi.mock` 拦不住
 * （既有冒烟用例里那批 `transformCallback is not a function` 噪声即由此而来）。这里改为
 * **桩化 Tauri IPC 层**（`__TAURI_INTERNALS__.transformCallback / invoke`），让真实的
 * `listen()` 正常注册 —— 于是本文件能真正驱动 App 的事件处理链路，而不是断言源码字符串。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { render, renderHook, cleanup, waitFor, act } from "@testing-library/react";
import type { EditorView } from "prosemirror-view";

/** 事件名 → App 注册的真实处理器；rawCallbacks 模拟 IPC 回调表（transformCallback 的产物） */
const { listeners, rawCallbacks, seq } = vi.hoisted(() => ({
  listeners: new Map<string, (ev: { event: string; id: number; payload: unknown }) => void>(),
  rawCallbacks: new Map<number, (ev: unknown) => void>(),
  seq: { v: 1 },
}));

/** App 调用的业务命令桩（事件插件的命令由 routeInvoke 拦截，不会走到这里） */
const invokeMock = vi.fn(async (cmd: string): Promise<unknown> => {
  if (cmd === "take_window_boot") {
    return { label: "main", isPrimary: true, restore: false, fresh: false, files: [], movedTabs: [] };
  }
  if (cmd === "has_session") return false;
  if (cmd === "list_windows") return [];
  if (cmd === "query_file_open") return [];
  if (cmd === "get_window_session") return null;
  if (cmd === "restore_windows") return [];
  return undefined;
});

/** 统一 IPC 路由：事件插件命令 → 注册回调；其余 → 业务命令桩 */
async function routeInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  if (cmd === "plugin:event|listen") {
    const handler = rawCallbacks.get(args?.handler as number);
    const event = args?.event;
    if (handler && typeof event === "string") listeners.set(event, handler as never);
    return seq.v++;
  }
  if (cmd.startsWith("plugin:event|")) return seq.v++;
  return invokeMock(cmd);
}

function enterTauri(label: string) {
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    metadata: { currentWebview: { label } },
    // 真实 @tauri-apps/api 的 listen() 依赖这两项
    transformCallback: (cb: (ev: unknown) => void) => {
      const id = seq.v++;
      rawCallbacks.set(id, cb);
      return id;
    },
    invoke: routeInvoke,
    convertFileSrc: (p: string) => p,
    plugins: {},
  };
  __setWindowLabelForTest(label);
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => routeInvoke(cmd, args),
  transformCallback: (cb: (ev: unknown) => void) => {
    const id = seq.v++;
    rawCallbacks.set(id, cb);
    return id;
  },
  Channel: class {
    onmessage: ((c: string) => void) | null = null;
  },
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "main",
    minimize: async () => {},
    toggleMaximize: async () => {},
    close: async () => {},
    isMaximized: async () => false,
    onResized: async () => () => {},
    onCloseRequested: async () => () => {},
    onFocusChanged: async () => () => {},
    onMoved: async () => () => {},
    setFocus: async () => {},
    requestUserAttention: async () => {},
  }),
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children?: unknown }) => children ?? null,
  PointerSensor: class {},
  useSensor: () => ({}),
  useSensors: () => [],
  closestCenter: () => [],
}));
vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children?: unknown }) => children ?? null,
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    transform: null,
    transition: null,
    isDragging: false,
  }),
  verticalListSortingStrategy: () => null,
}));
vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => undefined } },
}));

const notifyMock = vi.hoisted(() => vi.fn());
vi.mock("../services/notificationService", () => ({
  notify: (...args: unknown[]) => notifyMock(...args),
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
  setNotificationHandler: vi.fn(),
}));

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (globalThis as unknown as { matchMedia: unknown }).matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
});

import App from "../App";
import { __setWindowLabelForTest } from "../utils/windowLabel";
import { useEditorStore } from "../stores/useEditorStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useAutoSave } from "../hooks/useAutoSave";

const A_PATH = "D:/docs/a.md";
const FRESH = "FRESH-FROM-PEER";

beforeEach(() => {
  localStorage.clear();
  listeners.clear();
  rawCallbacks.clear();
  invokeMock.mockClear();
  notifyMock.mockClear();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  __setWindowLabelForTest(null);
  useEditorStore.setState({
    openTabs: [],
    activeTabIdx: 0,
    filePath: null,
    isDirty: false,
    viewMode: "edit",
  });
  useSettingsStore.setState({ autoSaveIntervalMs: 60000 });
});

afterEach(() => {
  cleanup();
  __setWindowLabelForTest(null);
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

/** 渲染 App（指定窗口身份）并等待 fileChanged 监听器注册完成 */
async function mountApp(label: string) {
  enterTauri(label);
  render(<App />);
  await waitFor(() => expect(listeners.has("lightmd:fileChanged")).toBe(true), { timeout: 3000 });
}

/** 播种一个已打开 a.md 的标签（App 启动流程跑完之后） */
function seedTab(opts: { dirty?: boolean; content?: string } = {}) {
  useEditorStore.setState({
    openTabs: [
      {
        path: A_PATH,
        name: "a.md",
        content: opts.content ?? "OLD",
        isDirty: !!opts.dirty,
      } as never,
    ],
    activeTabIdx: 0,
    filePath: A_PATH,
    isDirty: !!opts.dirty,
  });
}

/** 让 `read_file` 返回对方刚保存的内容 */
function diskContentIs(content: string) {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "read_file") return content;
    return undefined;
  });
}

/** 触发一次 lightmd:fileChanged（走真实 listen 注册的处理器） */
async function fireFileChanged(payload: Record<string, unknown>) {
  await act(async () => {
    listeners.get("lightmd:fileChanged")?.({
      event: "lightmd:fileChanged",
      id: 1,
      payload,
    });
    await Promise.resolve();
  });
}

// ───────── 双向即时刷新：谁保存都通知对方（本轮核心诉求） ─────────

describe("同文件多窗口：双向即时刷新", () => {
  it("新窗口保存 → 主窗口立即刷新并提示（第四轮已通，防回归）", async () => {
    await mountApp("main");
    seedTab();
    diskContentIs(FRESH);
    await fireFileChanged({ path: A_PATH, mtime: 111, removed: false, source: ["sec-1"] });
    await waitFor(() => expect(useEditorStore.getState().openTabs[0].content).toBe(FRESH));
    expect(notifyMock).toHaveBeenCalledWith(expect.stringContaining("已自动重新载入"), "info");
  });

  it("主窗口保存 → 新窗口立即刷新并提示（本轮保障：完全对称）", async () => {
    await mountApp("sec-1");
    seedTab();
    diskContentIs(FRESH);
    await fireFileChanged({ path: A_PATH, mtime: 222, removed: false, source: ["main"] });
    await waitFor(() => expect(useEditorStore.getState().openTabs[0].content).toBe(FRESH));
    expect(notifyMock).toHaveBeenCalledWith(expect.stringContaining("已自动重新载入"), "info");
  });

  it("连续多次保存（双方轮流）→ 每次都刷新到最新内容", async () => {
    await mountApp("sec-1");
    seedTab();
    diskContentIs("V1");
    await fireFileChanged({ path: A_PATH, mtime: 300, removed: false, source: ["main"] });
    await waitFor(() => expect(useEditorStore.getState().openTabs[0].content).toBe("V1"));
    diskContentIs("V2");
    await fireFileChanged({ path: A_PATH, mtime: 400, removed: false, source: ["main"] });
    await waitFor(() => expect(useEditorStore.getState().openTabs[0].content).toBe("V2"));
  });

  it("写入窗口自身（source 含本窗口）→ 忽略回声，不重载不提示", async () => {
    await mountApp("sec-1");
    seedTab();
    diskContentIs(FRESH);
    await fireFileChanged({ path: A_PATH, mtime: 333, removed: false, source: ["sec-1"] });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(useEditorStore.getState().openTabs[0].content).toBe("OLD");
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("写入登记竞态（source 为空）+ 磁盘内容 === 自身写盘内容 → 内容指纹兜底忽略", async () => {
    await mountApp("main");
    seedTab({ dirty: true });
    diskContentIs("SELF-WRITTEN");
    const { noteSelfWrittenFile, __resetSelfWriteGuardForTest } = await import(
      "../services/selfWriteGuard"
    );
    noteSelfWrittenFile(A_PATH, "SELF-WRITTEN");
    try {
      await fireFileChanged({ path: A_PATH, mtime: 444, removed: false, source: [] });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(useEditorStore.getState().openTabs[0].isExternallyChanged).toBeFalsy();
      expect(useEditorStore.getState().openTabs[0].content).toBe("OLD");
      expect(notifyMock).not.toHaveBeenCalled();
    } finally {
      __resetSelfWriteGuardForTest();
    }
  });

  it("本窗口没打开该文件 → 忽略（不影响无关标签）", async () => {
    await mountApp("main");
    seedTab();
    diskContentIs(FRESH);
    await fireFileChanged({
      path: "D:/docs/other.md",
      mtime: 500,
      removed: false,
      source: ["sec-1"],
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(useEditorStore.getState().openTabs[0].content).toBe("OLD");
    expect(notifyMock).not.toHaveBeenCalled();
  });
});

// ───────── 冲突规则：两窗口同时编辑，后保存者为准但不静默覆盖 ─────────

describe("两个窗口同时编辑同一文件", () => {
  it("对方标签有未保存修改 → 不静默覆盖：保留本地编辑 + 标记「已被外部修改」+ 提示", async () => {
    await mountApp("sec-1");
    seedTab({ dirty: true, content: "MY-UNSAVED-EDITS" });
    diskContentIs(FRESH);
    await fireFileChanged({ path: A_PATH, mtime: 555, removed: false, source: ["main"] });
    await waitFor(() => expect(useEditorStore.getState().openTabs[0].isExternallyChanged).toBe(true));
    // 本地未保存内容原样保留（绝不静默替换）
    expect(useEditorStore.getState().openTabs[0].content).toBe("MY-UNSAVED-EDITS");
    expect(notifyMock).toHaveBeenCalledWith(expect.stringContaining("保存前请确认"), "warning");
  });

  it("自动保存遇到外部变更 → 暂停写盘（不静默覆盖对方刚保存的内容）", async () => {
    vi.useFakeTimers();
    try {
      enterTauri("main"); // 必须：否则 writeFile 走浏览器分支，用例会变成假阳性
      seedTab({ dirty: true, content: "MY-UNSAVED-EDITS" });
      useEditorStore.setState((s) => ({
        openTabs: [{ ...s.openTabs[0], isExternallyChanged: true } as never],
        isDirty: true,
      }));
      useSettingsStore.setState({ autoSaveIntervalMs: 1000 });
      const viewRef = { current: {} as EditorView };
      renderHook(() => useAutoSave(viewRef, { current: "MY-UNSAVED-EDITS" }));
      await act(async () => {
        vi.advanceTimersByTime(5000);
        await Promise.resolve();
      });
      expect(invokeMock.mock.calls.some((c) => c[0] === "write_file")).toBe(false);
      // 并且明确告知用户「自动保存已暂停」
      expect(notifyMock).toHaveBeenCalledWith(
        expect.stringContaining("自动保存已暂停"),
        "warning",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("自动保存正常情况下仍按时写盘（暂停只在外部变更时生效）", async () => {
    vi.useFakeTimers();
    try {
      enterTauri("main");
      seedTab({ dirty: true, content: "MY-EDITS" });
      useSettingsStore.setState({ autoSaveIntervalMs: 1000 });
      const viewRef = { current: {} as EditorView };
      renderHook(() => useAutoSave(viewRef, { current: "MY-EDITS" }));
      await act(async () => {
        vi.advanceTimersByTime(1500);
        await Promise.resolve();
      });
      expect(invokeMock.mock.calls.some((c) => c[0] === "write_file")).toBe(true);
      expect(notifyMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("三条写盘路径都知情：Ctrl+S、批量保存（关闭窗口「保存全部」）、自动保存", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const read = (rel: string) =>
      readFileSync(resolve(__dirname, rel), "utf-8").replace(/\r\n/g, "\n");
    const appSrc = read("../App.tsx");
    const autoSaveSrc = read("../hooks/useAutoSave.ts");

    // ① Ctrl+S（既有）
    expect(appSrc).toContain("if (activeTabForSave?.isExternallyChanged) {");
    // ② 批量保存
    const bulk = appSrc.slice(appSrc.indexOf("const saveDirtyTabs = useCallback"));
    expect(bulk).toContain("if (current.isExternallyChanged) {");
    expect(bulk).toContain('if (choice === "saveAs") {');
    expect(bulk).toContain('if (choice !== "overwrite") return false;');
    expect(bulk).toContain("setTabExternallyChanged(idx, false)");
    // ③ 自动保存：暂停 + 一次性提示
    expect(autoSaveSrc).toContain("if (externallyChanged) return;");
    expect(autoSaveSrc).toContain('t("multiwindow.autoSavePaused"');
    expect(autoSaveSrc).toContain("pausedNotifiedRef.current = false;");
    // 中英文案齐备
    const zh = read("../i18n/locales/zh-CN.ts");
    const en = read("../i18n/locales/en-US.ts");
    expect(zh).toContain('"multiwindow.autoSavePaused"');
    expect(en).toContain('"multiwindow.autoSavePaused"');
  });
});
