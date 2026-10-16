/**
 * v0.13.1 需求14：**跨标签切换**导致的自动保存误报（与静默跨文件覆盖）。
 *
 * ## 用户报告
 * 「我打开多个文件在编辑，切换不同文件时还是会提示『某某文件已在其他窗口保存，
 *  自动保存暂停，请按 Ctrl+S 手动保存并选择覆盖或另存为』，但我那文件一直是
 *  LightMD 在打开编辑，没有其他软件编辑占用。」
 *
 * 提示文案对应 `multiwindow.autoSavePaused`，由 `useAutoSave` 的提示 effect 在
 * 「**当前活动标签**被标记为 isExternallyChanged 且有未保存修改」时弹出。
 *
 * ## 根因（本文件锁定）
 * 旧 `save()` 同时使用三个**不同时刻**的状态：
 *   · `filePath` —— 来自 useCallback 的**闭包**（创建它那次渲染的文件，记为 A）；
 *   · `currentMarkdown()` —— 实时读取 `viewRef.current` / `sourceContentRef`
 *     （**当前显示**的文件，切换后是 B）；
 *   · `activeTabIdx` —— 函数开头从 store 实时读取（**当前活动**标签，切换后是 B）。
 *
 * 一轮 tick 若在 `await fileService.readFile(A)` 期间发生标签切换，三者分叉：
 *   ① 用「A 的磁盘」比「B 的内容」→ 既不等于磁盘、也不等于基线 → 判 conflict →
 *      把**用户刚切过去的 B** 标成「外部变更」→ 弹出上面那条误报；
 *   ② 若此时「A 的磁盘 === A 的基线」→ 判 write → `writeFile(A, markdown)` 会把
 *      **B 的内容写进 A**（静默跨文件覆盖，属数据损坏）。
 *
 * 修复：入口一次性捕获 `path`，每个 await 之后复核它仍是活动路径；
 * 标签标记一律**按路径**定位（`getTabByPath`），不再用可能过期的 `activeTabIdx`。
 *
 * ## 手法
 * 与 `v0130-fix-round3-autosave.test.tsx` 同款：桩化 Tauri IPC，用假定时器驱动
 * **真实** `useAutoSave`，并用一个**可控延迟的 read_file**把"读盘期间切换标签"
 * 这一时序竞态变成确定性事件。断言的是真实的 IPC 调用序列与 store 状态。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, cleanup, act } from "@testing-library/react";
import type { EditorView } from "prosemirror-view";

import { __resetDiskReadCacheForTest } from "../utils/autoSaveGuard";
import {
  noteDiskBaseline,
  __resetSelfWriteGuardForTest,
  __resetDiskBaselineForTest,
} from "../services/selfWriteGuard";
import { useAutoSave } from "../hooks/useAutoSave";
import { useEditorStore } from "../stores/useEditorStore";
import { useSettingsStore } from "../stores/useSettingsStore";

const A_PATH = "D:/docs/a.md";
const B_PATH = "D:/docs/b.md";

const A_BASELINE = "A_BASELINE"; // 打开 a.md 时磁盘上的内容（= 已登记基线）
const B_DISK = "B_DISK"; //        打开 b.md 时磁盘上的内容
const B_CONTENT = "B_CONTENT"; //  b 标签里**未保存**的编辑内容

const { listeners, rawCallbacks, seq } = vi.hoisted(() => ({
  listeners: new Map<string, (ev: { event: string; id: number; payload: unknown }) => void>(),
  rawCallbacks: new Map<number, (ev: unknown) => void>(),
  seq: { v: 1 },
}));

const invokeMock = vi.hoisted(() => vi.fn());

/** 各路径的磁盘内容（read_file 返回它；write_file 改写它） */
let disk: Record<string, string> = {};
/** 置 true 时，对 A_PATH 的 read_file 会**挂起**直到 releaseReadA() 被调用 */
let holdReadA = false;
let releaseReadA: (() => void) | null = null;

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

const notifyMock = vi.hoisted(() => vi.fn());
vi.mock("../services/notificationService", () => ({
  notify: (...args: unknown[]) => notifyMock(...args),
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
  setNotificationHandler: vi.fn(),
}));

beforeEach(() => {
  localStorage.clear();
  listeners.clear();
  rawCallbacks.clear();
  invokeMock.mockClear();
  notifyMock.mockClear();
  __resetDiskReadCacheForTest();
  __resetSelfWriteGuardForTest();
  __resetDiskBaselineForTest();
  // 必须进入 Tauri 分支：`save()` 里真正的「读盘 → 三路判定 → 写盘」只在 isTauri()
  // 为真时执行。漏掉这一步会让断言**空过**（什么都不发生，于是"没有写盘"恒成立）。
  enterTauri("main");
  holdReadA = false;
  releaseReadA = null;
  disk = { [A_PATH]: A_BASELINE, [B_PATH]: B_DISK };

  invokeMock.mockImplementation(
    async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
      const target = typeof args?.path === "string" ? args.path : "";
      if (cmd === "read_file") {
        // 可控延迟：把「读盘期间切换标签」变成确定性的时序
        if (target === A_PATH && holdReadA) {
          await new Promise<void>((res) => {
            releaseReadA = res;
          });
        }
        if (!(target in disk)) throw new Error("no such file");
        return disk[target];
      }
      if (cmd === "write_file") {
        if (target in disk) disk[target] = String(args?.content ?? "");
        return undefined;
      }
      return undefined;
    },
  );

  useEditorStore.setState({
    openTabs: [],
    activeTabIdx: 0,
    filePath: null,
    isDirty: false,
    suppressAutoSave: false,
    viewMode: "edit",
  });
  useSettingsStore.setState({ autoSaveIntervalMs: 60000 });
});

afterEach(() => {
  cleanup();
  __resetDiskReadCacheForTest();
  __resetSelfWriteGuardForTest();
  __resetDiskBaselineForTest();
  vi.useRealTimers();
});

// ───────── 工具 ─────────

/** 播种两个脏标签（a 在前），当前活动 = a */
function seedTwoDirtyTabs() {
  useEditorStore.setState({
    openTabs: [
      {
        path: A_PATH,
        name: "a.md",
        content: A_BASELINE,
        isDirty: true,
        isExternallyChanged: false,
      },
      {
        path: B_PATH,
        name: "b.md",
        content: B_CONTENT,
        isDirty: true,
        isExternallyChanged: false,
      },
    ] as never,
    activeTabIdx: 0,
    filePath: A_PATH,
    isDirty: true,
  });
  // 打开文件时登记的磁盘基线（App 在 open 时调用）
  noteDiskBaseline(A_PATH, A_BASELINE);
  noteDiskBaseline(B_PATH, B_DISK);
}

/** 切换到 b 标签（模拟用户点击标签） */
function switchToB() {
  useEditorStore.setState({ activeTabIdx: 1, filePath: B_PATH, isDirty: true });
}

function writesTo(path: string) {
  return invokeMock.mock.calls.filter(
    (c) => c[0] === "write_file" && (c[1] as Record<string, unknown> | undefined)?.path === path,
  );
}

/** 造一个最小可用的 EditorView 桩（阅读模式下 currentMarkdown 会读 state.doc） */
function makeViewRef() {
  const doc = {
    textContent: "",
    forEach: () => {},
    content: { size: 0 },
  };
  return { current: { state: { doc }, isDestroyed: false } as unknown as EditorView };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// ───────── ① 误报：读盘期间切换标签，不得把新标签标成"外部变更" ─────────

describe("v0.13.1 需求14：读盘期间切换标签不得误报", () => {
  it("A 的读盘挂起时切到 B → 不写 A、不写 B、B 不得被标记 isExternallyChanged", async () => {
    vi.useFakeTimers();
    seedTwoDirtyTabs();
    // 让 b.md 的磁盘内容与基线一致（即"没有任何外部改动"）
    const viewRef = makeViewRef();
    const sourceRef = { current: A_BASELINE };
    renderHook(() => useAutoSave(viewRef, sourceRef));

    holdReadA = true; // 让 a.md 的读盘挂起
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000); // 定时器到点 → 进入 save() 并阻塞在读盘
    });

    // 读盘挂起期间，用户切换到 b.md
    await act(async () => {
      switchToB();
    });
    // 释放 a.md 的读盘
    await act(async () => {
      releaseReadA?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    await flush();

    // ① 绝不能把 b.md 标成外部变更（这就是用户看到的那条误报）
    const tabs = useEditorStore.getState().openTabs;
    expect(tabs[1].isExternallyChanged).toBe(false);
    expect(tabs[0].isExternallyChanged).toBe(false);
    // ② 不得写 a.md：B 的内容绝不能被写进 A
    const aWrites = writesTo(A_PATH);
    expect(aWrites.map((c) => (c[1] as Record<string, unknown>).content)).not.toContain(B_CONTENT);
    // ③ 本轮作废，不该有任何正文写入
    expect(writesTo(A_PATH)).toHaveLength(0);
    // ④ 不应弹出"已在其他窗口保存"这类暂停提示
    const pausedCalls = notifyMock.mock.calls.filter((c) =>
      String(c[0]).includes("已在其他窗口保存"),
    );
    expect(pausedCalls).toHaveLength(0);
  });

  it("A 磁盘 === A 基线（旧实现会判 write）时，也绝不能把 B 的内容写进 A", async () => {
    vi.useFakeTimers();
    seedTwoDirtyTabs();
    const viewRef = makeViewRef();
    const sourceRef = { current: B_CONTENT }; // 切换后实时内容 = B 的内容
    renderHook(() => useAutoSave(viewRef, sourceRef));

    holdReadA = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    await act(async () => {
      switchToB();
    });
    await act(async () => {
      releaseReadA?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    await flush();

    // 磁盘上的 A 必须原封不动 —— 这是本轮最重要的数据安全断言
    expect(disk[A_PATH]).toBe(A_BASELINE);
    expect(writesTo(A_PATH)).toHaveLength(0);
  });
});

// ───────── ② 正常路径不受影响：切换后下一轮保存的是 B 自己的内容 ─────────

describe("v0.13.1 需求14：修复不得破坏正常的自动保存", () => {
  it("切到 B 之后下一轮 tick 把 B 的内容写进 B（而不是 A）", async () => {
    vi.useFakeTimers();
    seedTwoDirtyTabs();
    const viewRef = makeViewRef();
    const sourceRef = { current: B_CONTENT };
    renderHook(() => useAutoSave(viewRef, sourceRef));

    // 先切到 B（切换会让定时 effect 以 B 重建并重新计时）
    await act(async () => {
      switchToB();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    await flush();

    const bWrites = writesTo(B_PATH);
    expect(bWrites.length).toBeGreaterThanOrEqual(1);
    expect(bWrites[bWrites.length - 1][1]).toMatchObject({ content: B_CONTENT });
    expect(disk[B_PATH]).toBe(B_CONTENT);
    // B 的脏标记应被清掉，且不残留"外部变更"
    const tabs = useEditorStore.getState().openTabs;
    expect(tabs[1].isDirty).toBe(false);
    expect(tabs[1].isExternallyChanged).toBe(false);
  });

  it("真实的外部改动仍会被判为 conflict，并且标记的是**那个文件自己的标签**", async () => {
    vi.useFakeTimers();
    seedTwoDirtyTabs();
    // 模拟第三方改了 a.md：磁盘内容与基线不再一致
    disk[A_PATH] = "CHANGED_BY_OUTSIDE";
    const viewRef = makeViewRef();
    const sourceRef = { current: A_BASELINE };
    renderHook(() => useAutoSave(viewRef, sourceRef));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    await flush();

    // 绝不写盘（安全边界）
    expect(writesTo(A_PATH)).toHaveLength(0);
    const tabs = useEditorStore.getState().openTabs;
    // 标记落在 a.md（标签 0）自己身上——不能因为 activeTabIdx 过期而落到别的文件
    expect(tabs[0].isExternallyChanged).toBe(true);
    expect(tabs[1].isExternallyChanged).toBe(false);
  });
});
