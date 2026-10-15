/**
 * v0.13.0 返修第三轮（问题⑭）：自动保存「好像失效了」的回归测试。
 *
 * ## 用户报告
 *
 * 「自动保存好像失效了」；此前还收到过一条**误报**：
 * 「xxx 已在其他窗口保存，自动保存已暂停」，而实际并没有外部程序动过文件。
 *
 * ## 缺陷根因（本文件逐条锁定）
 *
 * ### 根因一：定时器一次性，续期依赖 React 依赖重跑
 * 旧实现在 effect 里 `setTimeout(save, interval)` 只排**一次**，续期完全靠 effect
 * 依赖变化。三条「没保存成功但也没清脏」的路径都会让依赖不变（用户继续打字时
 * isDirty 恒为 true）→ 定时器不再续期 → **本会话自动保存永久失效**：
 *   ① 三路判定 conflict；② `writeFile` 抛错；③ `externallyChanged` 早退。
 * 修复后：每轮结束按 store 实时状态**自续期**，与 React 依赖解耦。
 *
 * ### 根因二：暂停态不自愈
 * conflict 会标记 `isExternallyChanged`，旧实现此后永久早退；即使磁盘后来被证明
 * 并没有被第三方改过（watcher 误报 / 内容被改回原样）也不会恢复。
 * 修复后：暂停期间每轮**复核磁盘**，证明未变则解除暂停并保存；证明不了则继续暂停。
 *
 * ### 根因三：定时器被每次击键重置（退化成防抖）
 * `EditorContainer` 传入的 `autoSaveSourceRef` 是**每次渲染新建的对象字面量**，
 * 而 EditorContainer 每次击键都重渲染 → `save` 身份每次击键都变 → 定时 effect 被
 * 「清理 + 重建」→ 定时器不断重置。连续输入超过一个间隔（默认 60s）时自动保存
 * **永不触发**。修复后：`save` 身份稳定，定时器按固定周期反复触发。
 *
 * ## 测试手法
 *
 * 与 `v0130-autosave-conflict.test.tsx` 同款：桩化 Tauri IPC 层
 * （`__TAURI_INTERNALS__.transformCallback / invoke`），用假定时器驱动**真实**
 * `useAutoSave`，断言的是 `read_file` / `write_file` 的**真实调用序列**与 store 状态，
 * 不是源码字符串。根因三用「每次渲染都换身份的 sourceRef」显式复现。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, cleanup, act } from "@testing-library/react";
import type { EditorView } from "prosemirror-view";

import { __resetDiskReadCacheForTest } from "../utils/autoSaveGuard";
import {
  noteSelfWrittenFile,
  noteDiskBaseline,
  __resetSelfWriteGuardForTest,
  __resetDiskBaselineForTest,
} from "../services/selfWriteGuard";
import { useAutoSave } from "../hooks/useAutoSave";
import { useEditorStore } from "../stores/useEditorStore";
import { useSettingsStore } from "../stores/useSettingsStore";

const A_PATH = "D:/docs/a.md";

/** 事件名 → App 注册的真实处理器 */
const { listeners, rawCallbacks, seq } = vi.hoisted(() => ({
  listeners: new Map<string, (ev: { event: string; id: number; payload: unknown }) => void>(),
  rawCallbacks: new Map<number, (ev: unknown) => void>(),
  seq: { v: 1 },
}));

/** 业务命令桩：`read_file` 内容由 diskContent 变量控制 */
const invokeMock = vi.hoisted(() => vi.fn());
/** 写盘失败开关：置 true 时 write_file 抛错（模拟磁盘只读/被锁/IO 错误） */
let writeFails = false;
let diskContent: string | null = "OLD";

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
  writeFails = false;
  diskContent = "OLD";
  invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    // 只有针对被测文件 A_PATH 的读写才计入「磁盘状态」。
    // 版本快照服务也会 invoke("write_file", { path: <快照路径> })，
    // 若不加路径过滤，快照写入会污染 diskContent 与写盘计数（断言失真）。
    const target = typeof args?.path === "string" ? args.path : "";
    const isTargetFile = target === A_PATH;
    if (cmd === "read_file") {
      if (!isTargetFile) return "";
      if (diskContent === null) throw new Error("no such file");
      return diskContent;
    }
    if (cmd === "write_file") {
      if (!isTargetFile) return undefined; // 快照/其它路径：直接成功，不影响被测磁盘
      if (writeFails) throw new Error("磁盘只读 / 文件被锁");
      diskContent = String(args?.content ?? "");
      return undefined;
    }
    return undefined;
  });
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
});

// ───────── 工具 ─────────

/** 播种一个已打开 a.md 的脏标签 */
function seedTab(content: string, opts: { externallyChanged?: boolean } = {}) {
  useEditorStore.setState({
    openTabs: [
      {
        path: A_PATH,
        name: "a.md",
        content,
        isDirty: true,
        isExternallyChanged: !!opts.externallyChanged,
      } as never,
    ],
    activeTabIdx: 0,
    filePath: A_PATH,
    isDirty: true,
  });
}

function callsOf(cmd: string) {
  // 只统计针对被测文件 A_PATH 的调用：版本快照服务也会写文件，
  // 计入会让「是否写了正文」的断言失真。
  return invokeMock.mock.calls.filter(
    (c) => c[0] === cmd && (c[1] as Record<string, unknown> | undefined)?.path === A_PATH,
  );
}

/**
 * 渲染真实 hook，并用**每次渲染都换身份**的 sourceRef 复现根因三。
 *
 * `EditorContainer` 传入的 `autoSaveSourceRef` 是对象字面量（带 getter），
 * 每次父组件重渲染都会新建 → 身份变化。这里用 `makeSourceRef()` 在每次渲染时
 * 返回新对象，忠实还原该行为；若不修复根因三，定时器会被不断重置。
 */
function renderAutoSave(content: string, opts: { churningSourceRef?: boolean } = {}) {
  const viewRef = { current: {} as EditorView };
  const stableRef = { current: content };
  const churning = opts.churningSourceRef === true;
  return renderHook(() =>
    useAutoSave(
      viewRef,
      churning ? ({ current: content } as { current: string }) : stableRef,
    ),
  );
}

/** 推进假定时器并让所有已排队的微任务结算 */
async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await Promise.resolve();
  });
}

// ───────── 根因一：冲突 / 写盘失败不得永久杀死自动保存 ─────────

describe("根因一：一次保存失败不得让自动保存永久失效", () => {
  it("冲突后磁盘被证明未变 → 后续 tick 恢复写盘（不再永久停摆）", async () => {
    vi.useFakeTimers();
    try {
      enterTauri("main");
      seedTab("MY-EDITS");
      // 打开文件时登记的基线是 OLD；此刻磁盘是第三方内容 → 首次判定 conflict
      noteDiskBaseline(A_PATH, "OPENED-CONTENT");
      diskContent = "EXTERNAL-EDIT";
      useSettingsStore.setState({ autoSaveIntervalMs: 1000 });
      renderAutoSave("MY-EDITS");

      // 第一轮：真冲突 → 不写盘 + 标记 + 提示
      await tick(1500);
      expect(callsOf("write_file")).toHaveLength(0);
      expect(useEditorStore.getState().openTabs[0].isExternallyChanged).toBe(true);
      expect(useEditorStore.getState().isDirty).toBe(true);

      // 磁盘被改回「本应用所知的基线内容」→ 冲突已不存在（外部程序撤销了改动）
      diskContent = "OPENED-CONTENT";
      notifyMock.mockClear();
      await tick(1500);

      // 关键断言：自动保存**没有**因为上一次冲突而永久失效 —— 现在真的写了盘
      expect(callsOf("write_file").length).toBeGreaterThanOrEqual(1);
      expect(useEditorStore.getState().isDirty).toBe(false);
      expect(diskContent).toBe("MY-EDITS");
    } finally {
      vi.useRealTimers();
    }
  });

  it("写盘失败（磁盘只读）后 → 下一轮自动重试并成功", async () => {
    vi.useFakeTimers();
    try {
      enterTauri("main");
      seedTab("MY-EDITS");
      noteDiskBaseline(A_PATH, "OLD");
      diskContent = "OLD"; // 磁盘 === 基线 → 判定 write
      writeFails = true; // 但写盘失败
      useSettingsStore.setState({ autoSaveIntervalMs: 1000 });
      renderAutoSave("MY-EDITS");

      // 第一轮：判定 write，但 write_file 抛错 → 脏标记保留（旧实现就此停摆）
      await tick(1500);
      expect(callsOf("write_file").length).toBeGreaterThanOrEqual(1);
      expect(useEditorStore.getState().isDirty).toBe(true);

      // 磁盘恢复可写 → 下一轮必须自动重试成功
      writeFails = false;
      await tick(1500);
      expect(useEditorStore.getState().isDirty).toBe(false);
      expect(diskContent).toBe("MY-EDITS");
    } finally {
      vi.useRealTimers();
    }
  });

  it("连续多轮失败后仍持续重试（循环不因失败而终止）", async () => {
    vi.useFakeTimers();
    try {
      enterTauri("main");
      seedTab("MY-EDITS");
      noteDiskBaseline(A_PATH, "OLD");
      diskContent = "OLD";
      writeFails = true;
      useSettingsStore.setState({ autoSaveIntervalMs: 1000 });
      renderAutoSave("MY-EDITS");

      // 连续 5 轮都失败
      for (let i = 0; i < 5; i++) await tick(1000);
      const failedWrites = callsOf("write_file").length;
      expect(failedWrites).toBeGreaterThanOrEqual(3); // 确实在反复重试，而不是只试一次
      expect(useEditorStore.getState().isDirty).toBe(true);

      // 恢复后仍能保存成功
      writeFails = false;
      await tick(1000);
      expect(useEditorStore.getState().isDirty).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("暂停态（isExternallyChanged 已置）也会自愈：磁盘回到基线即恢复写盘", async () => {
    vi.useFakeTimers();
    try {
      enterTauri("main");
      // 标签已处于暂停态（例如 App 侧 watcher 事件或上一轮冲突留下的标记）
      seedTab("MY-EDITS", { externallyChanged: true });
      noteDiskBaseline(A_PATH, "OPENED-CONTENT");
      diskContent = "OPENED-CONTENT"; // 磁盘 === 基线 → 无第三方改动
      useSettingsStore.setState({ autoSaveIntervalMs: 1000 });
      renderAutoSave("MY-EDITS");

      await tick(1500);
      // 自愈：暂停标记被清除，且本轮就完成了写盘
      expect(useEditorStore.getState().openTabs[0].isExternallyChanged).toBe(false);
      expect(callsOf("write_file").length).toBeGreaterThanOrEqual(1);
      expect(useEditorStore.getState().isDirty).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ───────── 根因二：绝不静默覆盖真正的外部修改 ─────────

describe("根因二：真正的外部修改仍绝不被自动保存覆盖", () => {
  it("磁盘持续是第三方内容 → 反复 tick 也绝不写盘", async () => {
    vi.useFakeTimers();
    try {
      enterTauri("main");
      seedTab("MY-EDITS");
      noteDiskBaseline(A_PATH, "OPENED-CONTENT");
      diskContent = "EXTERNAL-EDIT"; // 真分叉，且一直不变
      useSettingsStore.setState({ autoSaveIntervalMs: 1000 });
      renderAutoSave("MY-EDITS");

      // 多轮复核都证明磁盘是第三方内容 → 一轮都不许写盘
      for (let i = 0; i < 5; i++) await tick(1000);
      expect(callsOf("write_file")).toHaveLength(0);
      // 外部内容原样保留在磁盘上
      expect(diskContent).toBe("EXTERNAL-EDIT");
      // 本地未保存修改保留，暂停标记保持
      expect(useEditorStore.getState().isDirty).toBe(true);
      expect(useEditorStore.getState().openTabs[0].isExternallyChanged).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("无任何基线/自写记录可证明安全 → 保守不写盘", async () => {
    vi.useFakeTimers();
    try {
      enterTauri("main");
      seedTab("MY-EDITS");
      // 刻意不登记任何基线（模拟无从证明磁盘未被改过）
      diskContent = "UNKNOWN-CONTENT";
      useSettingsStore.setState({ autoSaveIntervalMs: 1000 });
      renderAutoSave("MY-EDITS");

      await tick(3000);
      expect(callsOf("write_file")).toHaveLength(0);
      expect(diskContent).toBe("UNKNOWN-CONTENT");
      expect(useEditorStore.getState().isDirty).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("读盘失败（文件被删/被锁）→ 保守不写盘，且不崩", async () => {
    vi.useFakeTimers();
    try {
      enterTauri("main");
      seedTab("MY-EDITS");
      noteDiskBaseline(A_PATH, "OLD");
      diskContent = null; // read_file 抛错
      useSettingsStore.setState({ autoSaveIntervalMs: 1000 });
      renderAutoSave("MY-EDITS");

      await tick(3000);
      expect(callsOf("write_file")).toHaveLength(0);
      expect(useEditorStore.getState().isDirty).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("暂停态下磁盘是第三方内容 → 保持暂停、绝不写盘（自愈不越界）", async () => {
    vi.useFakeTimers();
    try {
      enterTauri("main");
      seedTab("MY-EDITS", { externallyChanged: true });
      noteDiskBaseline(A_PATH, "OPENED-CONTENT");
      diskContent = "EXTERNAL-EDIT";
      useSettingsStore.setState({ autoSaveIntervalMs: 1000 });
      renderAutoSave("MY-EDITS");

      await tick(3000);
      expect(callsOf("write_file")).toHaveLength(0);
      expect(useEditorStore.getState().openTabs[0].isExternallyChanged).toBe(true);
      expect(diskContent).toBe("EXTERNAL-EDIT");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ───────── 根因三：定时器不随击键重置 ─────────

describe("根因三：定时器按固定周期触发，不被父组件重渲染重置", () => {
  it("sourceRef 每次渲染都换身份时，定时器仍能按周期触发", async () => {
    vi.useFakeTimers();
    try {
      enterTauri("main");
      seedTab("MY-EDITS");
      noteDiskBaseline(A_PATH, "OLD");
      diskContent = "OLD";
      useSettingsStore.setState({ autoSaveIntervalMs: 1000 });
      // 忠实还原 EditorContainer：每次渲染新建 sourceRef 对象
      const { rerender } = renderAutoSave("MY-EDITS", { churningSourceRef: true });

      // 每 600ms 重渲染一次（模拟用户持续输入），**始终不给定时器留出
      // 一个完整的 1000ms 静默窗口** —— 旧实现下定时器会被每次重渲染重置，
      // 累计 2400ms 也不会触发；修复后应在 1000ms / 2000ms 各触发一次。
      for (let i = 0; i < 4; i++) {
        await tick(600);
        await act(async () => {
          rerender();
        });
      }
      expect(callsOf("write_file").length).toBeGreaterThanOrEqual(1);
      expect(useEditorStore.getState().isDirty).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ───────── 需求2/3 既有保证不回归 ─────────

describe("需求2/3 既有保证不回归", () => {
  it("无路径（临时标签）→ 永不写盘、不清脏", async () => {
    vi.useFakeTimers();
    try {
      enterTauri("main");
      useEditorStore.setState({
        openTabs: [{ path: "", name: "新文件1", content: "临时内容", isDirty: true, isUntitled: true } as never],
        activeTabIdx: 0,
        filePath: "",
        isDirty: true,
      });
      useSettingsStore.setState({ autoSaveIntervalMs: 1000 });
      renderAutoSave("临时内容");

      await tick(5000);
      expect(callsOf("write_file")).toHaveLength(0);
      expect(callsOf("read_file")).toHaveLength(0);
      expect(useEditorStore.getState().isDirty).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("autoSaveIntervalMs <= 0（关闭自动保存）→ 永不写盘", async () => {
    vi.useFakeTimers();
    try {
      enterTauri("main");
      seedTab("MY-EDITS");
      noteDiskBaseline(A_PATH, "OLD");
      diskContent = "OLD";
      useSettingsStore.setState({ autoSaveIntervalMs: 0 });
      renderAutoSave("MY-EDITS");

      await tick(60000);
      expect(callsOf("write_file")).toHaveLength(0);
      expect(useEditorStore.getState().isDirty).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("文档没有编辑（isDirty=false）→ 不启动定时器、不写盘", async () => {
    vi.useFakeTimers();
    try {
      enterTauri("main");
      seedTab("MY-EDITS");
      noteDiskBaseline(A_PATH, "OLD");
      diskContent = "OLD";
      useEditorStore.setState({ isDirty: false });
      useSettingsStore.setState({ autoSaveIntervalMs: 1000 });
      renderAutoSave("MY-EDITS");

      await tick(5000);
      expect(callsOf("write_file")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("翻译回写抑制期间（suppressAutoSave）→ 不写盘", async () => {
    vi.useFakeTimers();
    try {
      enterTauri("main");
      seedTab("MY-EDITS");
      noteDiskBaseline(A_PATH, "OLD");
      diskContent = "OLD";
      useEditorStore.setState({ suppressAutoSave: true });
      useSettingsStore.setState({ autoSaveIntervalMs: 1000 });
      renderAutoSave("MY-EDITS");

      await tick(5000);
      expect(callsOf("write_file")).toHaveLength(0);
      expect(useEditorStore.getState().isDirty).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("磁盘 === 目标内容 → skip（不写盘）且清脏，不打扰用户", async () => {
    vi.useFakeTimers();
    try {
      enterTauri("main");
      seedTab("MY-EDITS");
      noteDiskBaseline(A_PATH, "OLD");
      diskContent = "MY-EDITS"; // 磁盘已是目标内容
      useSettingsStore.setState({ autoSaveIntervalMs: 1000 });
      renderAutoSave("MY-EDITS");

      await tick(1500);
      expect(callsOf("write_file")).toHaveLength(0);
      expect(useEditorStore.getState().isDirty).toBe(false);
      expect(notifyMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("正常路径：磁盘 === 本应用所知内容 → 按时写盘（既有行为不回归）", async () => {
    vi.useFakeTimers();
    try {
      enterTauri("main");
      seedTab("MY-EDITS");
      noteSelfWrittenFile(A_PATH, "LAST-SAVED");
      diskContent = "LAST-SAVED";
      useSettingsStore.setState({ autoSaveIntervalMs: 1000 });
      renderAutoSave("MY-EDITS");

      await tick(1500);
      expect(callsOf("write_file").length).toBeGreaterThanOrEqual(1);
      expect(useEditorStore.getState().isDirty).toBe(false);
      expect(notifyMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("保存成功后循环停止（不再空转打磁盘）", async () => {
    vi.useFakeTimers();
    try {
      enterTauri("main");
      seedTab("MY-EDITS");
      noteDiskBaseline(A_PATH, "OLD");
      diskContent = "OLD";
      useSettingsStore.setState({ autoSaveIntervalMs: 1000 });
      renderAutoSave("MY-EDITS");

      await tick(1500);
      const writesAfterFirst = callsOf("write_file").length;
      expect(writesAfterFirst).toBeGreaterThanOrEqual(1);
      // 已清脏 → 后续不应再有新的写盘
      await tick(5000);
      expect(callsOf("write_file").length).toBe(writesAfterFirst);
    } finally {
      vi.useRealTimers();
    }
  });

  it("非 Tauri（浏览器）环境：不读盘，走 localStorage", async () => {
    vi.useFakeTimers();
    try {
      delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
      seedTab("BROWSER-CONTENT");
      localStorage.clear();
      useSettingsStore.setState({ autoSaveIntervalMs: 1000 });
      renderAutoSave("BROWSER-CONTENT");

      await tick(1500);
      expect(localStorage.getItem("lightmd-content")).toBe("BROWSER-CONTENT");
      expect(callsOf("read_file")).toHaveLength(0);
      expect(callsOf("write_file")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
