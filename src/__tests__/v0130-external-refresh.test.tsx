/**
 * v0.13.0 需求2：文件被外部修改时「以最新修改的为准」，同时**绝不静默丢弃**
 * 本地未保存修改。
 *
 * ## 规则
 *
 * | 策略 | 干净标签 | 脏标签 |
 * | --- | --- | --- |
 * | `reload-clean`（默认，v0.9.0 行为） | 自动重载 | 仅标记 + 提示 |
 * | `always-reload` | 自动重载 | 弹「取最新 / 保留本地 / 另存为」 |
 * | `ask` | 弹「取最新 / 保留本地」 | 弹「取最新 / 保留本地 / 另存为」 |
 *
 * 干净标签重载是既有行为（v0.9.0 WP9）；本版新增的是脏标签的三选对话框与
 * 「取最新」动作。
 *
 * ## 测试手法
 *
 * 纯函数层（`decideExternalChangeAction`）走真值表；集成层用 Tauri IPC 桩驱动
 * 真实 `App`，断言 `invoke` 调用序列与 store 状态，不是源码字符串。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { render, waitFor, act, cleanup } from "@testing-library/react";

import {
  decideExternalChangeAction,
  applyExternalChangeChoice,
  type ExternalChangePolicy,
} from "../utils/externalChangePolicy";
import App from "../App";
import { __setWindowLabelForTest } from "../utils/windowLabel";
import { useEditorStore } from "../stores/useEditorStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import {
  noteSelfWrittenFile,
  __resetSelfWriteGuardForTest,
} from "../services/selfWriteGuard";

const A_PATH = "D:/docs/a.md";
const FRESH = "FRESH-FROM-PEER";

/** 事件名 → App 注册的真实处理器；rawCallbacks 模拟 IPC 回调表 */
const { listeners, rawCallbacks, seq } = vi.hoisted(() => ({
  listeners: new Map<string, (ev: { event: string; id: number; payload: unknown }) => void>(),
  rawCallbacks: new Map<number, (ev: unknown) => void>(),
  seq: { v: 1 },
}));

/** 业务命令桩：`read_file` 内容由 diskContent 变量控制 */
const invokeMock = vi.hoisted(() => vi.fn());
let diskContent: string | null = FRESH;

async function routeInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  if (cmd === "plugin:event|listen") {
    const handler = rawCallbacks.get(args?.handler as number);
    const event = args?.event;
    if (handler && typeof event === "string") listeners.set(event, handler as never);
    return seq.v++;
  }
  if (cmd.startsWith("plugin:event|")) return seq.v++;
  return invokeMock(cmd, args);
}

function enterTauri(label: string) {
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    metadata: { currentWebview: { label } },
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
  // v0.13.1 需求11：大纲新增 DragOverlay（跟随光标的拖拽幽灵），替身需一并提供
  DragOverlay: ({ children }: { children?: unknown }) => children ?? null,
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
  (window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: unknown }).__TAURI_EVENT_PLUGIN_INTERNALS__ =
    { unregisterListener: () => {} };
  (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
});

beforeEach(() => {
  localStorage.clear();
  listeners.clear();
  rawCallbacks.clear();
  invokeMock.mockClear();
  notifyMock.mockClear();
  __resetSelfWriteGuardForTest();
  diskContent = FRESH;
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  __setWindowLabelForTest(null);
  invokeMock.mockImplementation(async (cmd: string): Promise<unknown> => {
    if (cmd === "take_window_boot") {
      return { label: "main", isPrimary: true, restore: false, fresh: false, files: [], movedTabs: [] };
    }
    if (cmd === "has_session") return false;
    if (cmd === "list_windows") return [];
    if (cmd === "query_file_open") return [];
    if (cmd === "get_window_session") return null;
    if (cmd === "restore_windows") return [];
    if (cmd === "read_file") {
      if (diskContent === null) throw new Error("no such file");
      return diskContent;
    }
    return undefined;
  });
  useEditorStore.setState({
    openTabs: [],
    activeTabIdx: 0,
    filePath: null,
    isDirty: false,
    viewMode: "edit",
  });
  useSettingsStore.setState({
    autoSaveIntervalMs: 60000,
    externalChangePolicy: "reload-clean",
  });
});

afterEach(async () => {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  cleanup();
  __resetSelfWriteGuardForTest();
});

/** 渲染 App 并等待 fileChanged 监听器注册完成 */
async function mountApp(label: string) {
  enterTauri(label);
  render(<App />);
  await waitFor(() => expect(listeners.has("lightmd:fileChanged")).toBe(true), { timeout: 3000 });
}

/** 播种一个已打开 a.md 的标签 */
function seedTab(opts: { dirty?: boolean; content?: string } = {}) {
  useEditorStore.setState({
    openTabs: [
      { path: A_PATH, name: "a.md", content: opts.content ?? "OLD", isDirty: !!opts.dirty } as never,
    ],
    activeTabIdx: 0,
    filePath: A_PATH,
    isDirty: !!opts.dirty,
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

/** 决策对话框当前是否打开（DOM 层） */
function dialogOpen(): boolean {
  return !!document.body.querySelector('[role="dialog"], .choice-dialog, .dialog');
}

// ───────── 纯函数：策略真值表 ─────────

describe("decideExternalChangeAction 策略真值表", () => {
  it("reload-clean：干净 → reload；脏 → markOnly（v0.9.0 既有行为）", () => {
    expect(decideExternalChangeAction("reload-clean", false)).toBe("reload");
    expect(decideExternalChangeAction("reload-clean", true)).toBe("markOnly");
  });

  it("always-reload：干净 → reload；脏 → askThreeWay（以最新为准）", () => {
    expect(decideExternalChangeAction("always-reload", false)).toBe("reload");
    expect(decideExternalChangeAction("always-reload", true)).toBe("askThreeWay");
  });

  it("ask：两种情况都弹确认", () => {
    expect(decideExternalChangeAction("ask", false)).toBe("askThreeWay");
    expect(decideExternalChangeAction("ask", true)).toBe("askThreeWay");
  });

  it("策略值集合覆盖全部三种（防止拼写漂移）", () => {
    const all: ExternalChangePolicy[] = ["reload-clean", "always-reload", "ask"];
    for (const p of all) {
      expect(decideExternalChangeAction(p, false)).toBeTruthy();
      expect(decideExternalChangeAction(p, true)).toBeTruthy();
    }
  });
});

describe("applyExternalChangeChoice 映射", () => {
  it("takeLatest → reload（用磁盘内容替换标签）", () => {
    expect(applyExternalChangeChoice("takeLatest")).toBe("reload");
  });
  it("keepLocal → none（保留本地未保存修改）", () => {
    expect(applyExternalChangeChoice("keepLocal")).toBe("none");
  });
  it("saveAs → saveAs（本地编辑另存新文件）", () => {
    expect(applyExternalChangeChoice("saveAs")).toBe("saveAs");
  });
});

// ───────── 集成：驱动真实 App ─────────

describe("干净标签遇外部修改（既有行为不回归）", () => {
  it("自动重载到磁盘内容 + 提示", async () => {
    await mountApp("main");
    seedTab();
    diskContent = FRESH;
    await fireFileChanged({ path: A_PATH, mtime: 111, removed: false, source: ["sec-1"] });
    await waitFor(() => expect(useEditorStore.getState().openTabs[0].content).toBe(FRESH));
    expect(notifyMock).toHaveBeenCalledWith(expect.stringContaining("已自动重新载入"), "info");
  });

  it("自身保存回声不误报（回归 selfWriteGuard）", async () => {
    await mountApp("main");
    seedTab({ dirty: true });
    diskContent = "SELF-WRITTEN";
    noteSelfWrittenFile(A_PATH, "SELF-WRITTEN");
    await fireFileChanged({ path: A_PATH, mtime: 444, removed: false, source: [] });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(useEditorStore.getState().openTabs[0].isExternallyChanged).toBeFalsy();
    expect(useEditorStore.getState().openTabs[0].content).toBe("OLD");
    expect(notifyMock).not.toHaveBeenCalled();
  });
});

describe("脏标签遇外部修改：默认策略只标记不重载", () => {
  it("reload-clean：标记 isExternallyChanged + 提示，内容不动", async () => {
    await mountApp("sec-1");
    seedTab({ dirty: true, content: "MY-UNSAVED-EDITS" });
    diskContent = FRESH;
    await fireFileChanged({ path: A_PATH, mtime: 555, removed: false, source: ["main"] });
    await waitFor(() =>
      expect(useEditorStore.getState().openTabs[0].isExternallyChanged).toBe(true),
    );
    // 本地未保存内容原样保留（绝不静默替换）
    expect(useEditorStore.getState().openTabs[0].content).toBe("MY-UNSAVED-EDITS");
    expect(notifyMock).toHaveBeenCalledWith(expect.stringContaining("保存前请确认"), "warning");
  });
});

describe("脏标签遇外部修改：always-reload 弹三选", () => {
  it("弹三选对话框，本地编辑在用户选择前不被替换", async () => {
    useSettingsStore.setState({ externalChangePolicy: "always-reload" });
    await mountApp("sec-1");
    seedTab({ dirty: true, content: "MY-UNSAVED-EDITS" });
    diskContent = FRESH;
    await fireFileChanged({ path: A_PATH, mtime: 666, removed: false, source: ["main"] });
    // 等读盘 + 弹框
    await waitFor(() => expect(dialogOpen()).toBe(true), { timeout: 3000 });
    // 弹框期间本地编辑原样保留
    expect(useEditorStore.getState().openTabs[0].content).toBe("MY-UNSAVED-EDITS");
    expect(useEditorStore.getState().openTabs[0].isExternallyChanged).toBe(true);
  });

  it("磁盘内容 === 上次自写 → 视为自身回声，不弹框", async () => {
    useSettingsStore.setState({ externalChangePolicy: "always-reload" });
    await mountApp("sec-1");
    seedTab({ dirty: true, content: "MY-UNSAVED-EDITS" });
    diskContent = "SELF-WRITTEN";
    noteSelfWrittenFile(A_PATH, "SELF-WRITTEN");
    await fireFileChanged({ path: A_PATH, mtime: 777, removed: false, source: [] });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(useEditorStore.getState().openTabs[0].isExternallyChanged).toBeFalsy();
    expect(dialogOpen()).toBe(false);
  });
});

describe("设置项持久化", () => {
  it("externalChangePolicy 默认 reload-clean，可写可读", () => {
    expect(useSettingsStore.getState().externalChangePolicy).toBe("reload-clean");
    useSettingsStore.getState().setExternalChangePolicy("always-reload");
    expect(useSettingsStore.getState().externalChangePolicy).toBe("always-reload");
    useSettingsStore.getState().setExternalChangePolicy("ask");
    expect(useSettingsStore.getState().externalChangePolicy).toBe("ask");
  });
});
