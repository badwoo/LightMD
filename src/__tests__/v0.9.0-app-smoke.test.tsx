/**
 * v0.9.0 交付冒烟：主窗口与辅助窗口都能挂载 App 而不抛错。
 *
 * 这是 v0.9.0 新增大量启动期副作用（窗口引导、广播订阅、跨窗口监听、状态上报）
 * 之后最关键的一条保险：任何一处同步异常都会让**整个窗口白屏**。
 *
 * 断言只做「挂载成功 + 关键 UI 存在 + 窗口引导被调用」，细节行为由其它
 * v0.9.0-* 用例覆盖。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";

/**
 * `invoke` 桩：返回值随命令变化，故用宽松签名（`Promise<unknown>`），
 * 避免每个用例的 mockImplementation 都被字面量类型收紧。
 */
const invokeMock = vi.fn(async (cmd: string): Promise<unknown> => {
  // 默认实现：窗口引导返回空壳；其余命令返回 undefined / 空数组
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

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...(args as [string])),
  Channel: class {
    onmessage: ((c: string) => void) | null = null;
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async () => () => {},
  emit: async () => {},
  once: async () => () => {},
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "main",
    minimize: async () => {},
    toggleMaximize: async () => {},
    close: async () => {},
    isMaximized: async () => false,
    onResized: async () => () => {},
  }),
}));

/**
 * `@dnd-kit/*` 只声明在工作区**根** package.json，lightmd 自己的 node_modules 里没有。
 * Vite 的解析器能处理这种提升，但 vitest 走 Node 解析时会失败（表现为
 * Outline 组件里 React 命名空间为 null）。本冒烟用例只关心 App 自身的多窗口接线，
 * 故对 dnd-kit 做最小桩实现。
 */
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

/**
 * 让 App 启动期的动态 import / 事件注册链在**模块 mock 仍然生效时**全部结算。
 *
 * App 的每个 useEffect 都会 `await import("@tauri-apps/api/event")` 后注册监听；
 * 这些 Promise 若在测试结束后才 resolve，就会落到**真实** Tauri 模块上，
 * 抛 `transformCallback is not a function` 的 unhandled rejection，
 * 使 `vitest run` 即使全部用例通过也以非 0 退出（v0.9.0 review 修复）。
 */
async function flushStartupMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, i < 4 ? 0 : 5));
    });
  }
}

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockClear();
  useEditorStore.setState({ openTabs: [], activeTabIdx: 0, filePath: null, isDirty: false });
  __setWindowLabelForTest(null);
});

/**
 * 完整 Tauri 运行时桩：真实 `@tauri-apps/api/event` 的 listen/unlisten 会读写
 * `window.__TAURI_INTERNALS__`（transformCallback / invoke / unregisterListener），
 * 桩不完整时会在挂载/卸载期间抛 unhandled rejection（v0.9.0 review 修复）。
 */
function installTauriStub(label: string): void {
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    metadata: { currentWebview: { label } },
    transformCallback: () => 0,
    invoke: async () => 0,
    unregisterListener: async () => {},
    convertFileSrc: (p: string) => p,
    plugins: {},
  };
}

function removeTauriStub(): void {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

/**
 * 真实 `@tauri-apps/api/event` 的 unlisten 依赖
 * `window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener`（由 Tauri 事件插件注入）。
 * jsdom 下该全局缺失 → 每次卸载期 unlisten 都抛 unhandled rejection，
 * 使 `vitest run` 即使全部用例通过也以非 0 退出（v0.9.0 review 修复）。
 */
beforeAll(() => {
  (window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: unknown }).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => {},
  };
  // jsdom 未实现 IntersectionObserver；大纲组件在其 rAF 回调里构造，缺失会抛
  // ReferenceError（同样是「用例通过但 unhandled error」的来源）
  (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
});

afterEach(async () => {
  // 先让启动期的动态 import / 事件注册结算完（此时桩仍在），再卸载、再删桩
  await flushStartupMicrotasks();
  cleanup();
  await flushStartupMicrotasks();
  __setWindowLabelForTest(null);
  removeTauriStub();
  vi.restoreAllMocks();
});

describe("v0.9.0 冒烟：App 挂载", () => {
  it("主窗口（非 Tauri / 浏览器态）挂载不抛错", async () => {
    expect(() => render(<App />)).not.toThrow();
    // 品牌名在标题栏与空状态各出现一次
    await waitFor(() => expect(screen.getAllByText("LightMD").length).toBeGreaterThan(0));
  });

  it("主窗口挂载后调用一次窗口引导（take_window_boot）", async () => {
    // jsdom 下 isTauri() 为 false → windowService 走非 Tauri 短路，不 invoke。
    // 这里注入 __TAURI_INTERNALS__ 让 Tauri 分支生效（桩必须完整，见 installTauriStub）。
    installTauriStub("main");
    __setWindowLabelForTest(null);
    render(<App />);
    await waitFor(() =>
      expect(invokeMock.mock.calls.map(([c]) => c)).toContain("take_window_boot"),
    );
    // 引导完成后上报本窗口状态（会话快照 / 冲突检测数据源）
    await waitFor(
      () => expect(invokeMock.mock.calls.map(([c]) => c)).toContain("sync_window_state"),
      { timeout: 2000 },
    );
  });

  it("窗口引导返回 fresh 时清理该槽位残留（不清理 main）", async () => {
    installTauriStub("sec-1");
    __setWindowLabelForTest("sec-1");
    localStorage.setItem("lightmd-untitled-tabs-sec-1", JSON.stringify([{ id: "untitled-1", name: "x", content: "stale" }]));
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "take_window_boot") {
        return { label: "sec-1", isPrimary: false, restore: false, fresh: true, files: [], movedTabs: [] };
      }
      if (cmd === "has_session") return false;
      if (cmd === "list_windows") return [];
      if (cmd === "restore_windows") return [];
      return undefined;
    });
    render(<App />);
    await waitFor(() =>
      expect(localStorage.getItem("lightmd-untitled-tabs-sec-1")).toBeNull(),
    );
  });

  it("窗口引导返回 files 时打开该文件（右键「在新窗口中打开」链路）", async () => {
    installTauriStub("sec-1");
    __setWindowLabelForTest("sec-1");
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "take_window_boot") {
        return {
          label: "sec-1",
          isPrimary: false,
          restore: false,
          fresh: true,
          files: ["D:/docs/new.md"],
          movedTabs: [],
        };
      }
      if (cmd === "read_file") return "# 新窗口文件\n\n正文";
      if (cmd === "get_file_size") return 10;
      if (cmd === "list_dir") return [];
      if (cmd === "query_file_open") return [];
      if (cmd === "list_windows") return [];
      void args;
      return undefined;
    });
    render(<App />);
    await waitFor(() =>
      expect(useEditorStore.getState().openTabs.some((tb) => tb.path === "D:/docs/new.md")).toBe(true),
    );
  });

  it("辅助窗口不继承主窗口 scratch 内容（初始为空）", () => {
    localStorage.setItem("lightmd-content", "主窗口的残留内容");
    __setWindowLabelForTest("sec-2");
    render(<App />);
    // 空状态：当前无标签、无文件路径
    expect(useEditorStore.getState().openTabs).toEqual([]);
    expect(useEditorStore.getState().filePath).toBeNull();
  });
});
