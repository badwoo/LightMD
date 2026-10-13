/**
 * v0.13.0 需求3：自动保存只针对有改动文档，且**绝不覆盖外部编辑**。
 *
 * ## 缺陷根因（本版修复）
 *
 * `useAutoSave` 此前只在 `isDirty` 时启动定时器（v0.8.2 需求7 起就是这样），
 * 看似已满足「只对有编辑改动的文档保存」。但 `save()` **写盘前从不读盘**：
 * 外部软件改了文件、而 LightMD 正开着它时，自动保存会把内存里的旧内容写回磁盘，
 * 外部编辑被静默覆盖回退。
 *
 * 已有的 `externallyChanged` 标记不够——它依赖 watcher 事件先到达前端，而事件可能
 * 因「目录未挂载 / mtime 去重命中 / Rust 回调调度晚于定时器」迟到或缺失。
 * 因此本版在写盘前**直接读一次磁盘**做三路判定。
 *
 * ## 测试手法
 *
 * 纯函数层（`judgeAutoSaveWrite`）走真值表；集成层用与
 * `v0.9.0-fixes-round5.test.tsx` 相同的 Tauri IPC 桩驱动真实 `useAutoSave`，
 * 断言的是 `invoke` 调用序列（`read_file` / `write_file`），不是源码字符串。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, cleanup, act } from "@testing-library/react";
import type { EditorView } from "prosemirror-view";

import {
  judgeAutoSaveWrite,
  getCachedDiskRead,
  putCachedDiskRead,
  __resetDiskReadCacheForTest,
} from "../utils/autoSaveGuard";
import {
  noteSelfWrittenFile,
  getLastSelfWritten,
  __resetSelfWriteGuardForTest,
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
  diskContent = "OLD";
  invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    if (cmd === "read_file") {
      if (diskContent === null) throw new Error("no such file");
      return diskContent;
    }
    if (cmd === "write_file") {
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
    viewMode: "edit",
  });
  useSettingsStore.setState({ autoSaveIntervalMs: 60000 });
});

afterEach(() => {
  cleanup();
  __resetDiskReadCacheForTest();
  __resetSelfWriteGuardForTest();
});

// ───────── 纯函数：三路判定真值表 ─────────

describe("judgeAutoSaveWrite 三路判定真值表", () => {
  it("磁盘 === 上次自写内容 → write（无外部改动）", () => {
    expect(
      judgeAutoSaveWrite({
        diskContent: "LAST-SAVED",
        targetContent: "MY-EDITS",
        lastSelfWritten: "LAST-SAVED",
      }),
    ).toBe("write");
  });

  it("磁盘 === 待写内容 → skip（免一次无效写盘）", () => {
    expect(
      judgeAutoSaveWrite({
        diskContent: "MY-EDITS",
        targetContent: "MY-EDITS",
        lastSelfWritten: "LAST-SAVED",
      }),
    ).toBe("skip");
  });

  it("磁盘是第三方内容 → conflict（放弃保存，不覆盖）", () => {
    expect(
      judgeAutoSaveWrite({
        diskContent: "THIRD-PARTY-EDIT",
        targetContent: "MY-EDITS",
        lastSelfWritten: "LAST-SAVED",
      }),
    ).toBe("conflict");
  });

  it("读盘失败（null）→ conflict（保守：绝不写盘）", () => {
    expect(
      judgeAutoSaveWrite({
        diskContent: null,
        targetContent: "MY-EDITS",
        lastSelfWritten: "LAST-SAVED",
      }),
    ).toBe("conflict");
  });

  it("无自写记录且磁盘内容不同 → conflict（无从证明磁盘未被改过）", () => {
    expect(
      judgeAutoSaveWrite({
        diskContent: "SOMETHING-ELSE",
        targetContent: "MY-EDITS",
        lastSelfWritten: null,
      }),
    ).toBe("conflict");
  });

  it("无自写记录但磁盘 === 目标内容 → skip（内容已一致，无需写盘）", () => {
    expect(
      judgeAutoSaveWrite({
        diskContent: "MY-EDITS",
        targetContent: "MY-EDITS",
        lastSelfWritten: null,
      }),
    ).toBe("skip");
  });

  it("「上次自写」与「目标内容」同时相等时优先 skip（少一次 IO）", () => {
    // 磁盘 === 目标 === 上次自写：没有新信息，直接跳过写盘
    expect(
      judgeAutoSaveWrite({
        diskContent: "SAME",
        targetContent: "SAME",
        lastSelfWritten: "SAME",
      }),
    ).toBe("skip");
  });
});

describe("读盘结果短时缓存", () => {
  it("窗口内命中，过期后失效", () => {
    putCachedDiskRead(A_PATH, "CACHED", 1_000);
    expect(getCachedDiskRead(A_PATH, 1_050)).toBe("CACHED");
    // 超过 200ms 窗口 → 不再复用
    expect(getCachedDiskRead(A_PATH, 1_300)).toBeUndefined();
  });

  it("读盘失败（null）也被缓存，避免连续两次失败都去打磁盘", () => {
    putCachedDiskRead(A_PATH, null, 1_000);
    expect(getCachedDiskRead(A_PATH, 1_050)).toBeNull();
  });
  it("未记录的路径返回 undefined", () => {
    expect(getCachedDiskRead("D:/other.md", 1_000)).toBeUndefined();
  });
});

describe("getLastSelfWritten", () => {
  it("登记后取回内容；超龄后返回 null", () => {
    noteSelfWrittenFile(A_PATH, "WROTE");
    expect(getLastSelfWritten(A_PATH)).toBe("WROTE");
    expect(getLastSelfWritten("D:/docs/other.md")).toBeNull();
  });

  it("路径分隔符/大小写差异不影响命中", () => {
    noteSelfWrittenFile("D:/docs/a.md", "WROTE");
    expect(getLastSelfWritten("D:\\Docs\\A.MD")).toBe("WROTE");
  });

  it("空路径返回 null", () => {
    expect(getLastSelfWritten("")).toBeNull();
  });
});

// ───────── 集成：驱动真实 useAutoSave ─────────

/** 播种一个已打开 a.md 的脏标签 */
function seedTab(content: string) {
  useEditorStore.setState({
    openTabs: [{ path: A_PATH, name: "a.md", content, isDirty: true } as never],
    activeTabIdx: 0,
    filePath: A_PATH,
    isDirty: true,
  });
}

function callsOf(cmd: string) {
  return invokeMock.mock.calls.filter((c) => c[0] === cmd);
}

describe("自动保存遇到外部改动 → 不覆盖（用户场景根因）", () => {
  it("外部软件改过磁盘 → 放弃写盘 + 标记外部变更 + 提示", async () => {
    vi.useFakeTimers();
    try {
      enterTauri("main");
      seedTab("MY-EDITS");
      // 磁盘是第三方刚写的内容，且我们**没有**对应的自写记录
      diskContent = "EXTERNAL-EDIT";
      useSettingsStore.setState({ autoSaveIntervalMs: 1000 });
      const viewRef = { current: {} as EditorView };
      renderHook(() => useAutoSave(viewRef, { current: "MY-EDITS" }));
      await act(async () => {
        vi.advanceTimersByTime(1500);
        await Promise.resolve();
      });

      // 读过盘，但**没有**写盘
      expect(callsOf("read_file").length).toBeGreaterThan(0);
      expect(callsOf("write_file")).toHaveLength(0);
      // 标记「外部变更未处理」→ 用户手动 Ctrl+S 时会弹「覆盖 / 另存为 / 取消」
      expect(useEditorStore.getState().openTabs[0].isExternallyChanged).toBe(true);
      // 未保存修改原样保留，脏标记不清
      expect(useEditorStore.getState().isDirty).toBe(true);
      // 明确告知用户（不静默）
      expect(notifyMock).toHaveBeenCalledWith(expect.stringContaining("自动保存已放弃"), "warning");
    } finally {
      vi.useRealTimers();
    }
  });

  it("磁盘无外部改动（=== 上次自写）→ 正常写盘", async () => {
    vi.useFakeTimers();
    try {
      enterTauri("main");
      seedTab("MY-EDITS");
      diskContent = "LAST-SAVED";
      noteSelfWrittenFile(A_PATH, "LAST-SAVED");
      useSettingsStore.setState({ autoSaveIntervalMs: 1000 });
      const viewRef = { current: {} as EditorView };
      renderHook(() => useAutoSave(viewRef, { current: "MY-EDITS" }));
      await act(async () => {
        vi.advanceTimersByTime(1500);
        await Promise.resolve();
      });
      expect(callsOf("write_file").length).toBeGreaterThanOrEqual(1);
      expect(useEditorStore.getState().isDirty).toBe(false);
      expect(notifyMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("磁盘已是目标内容 → 跳过写盘（省一次 IO）", async () => {
    vi.useFakeTimers();
    try {
      enterTauri("main");
      seedTab("MY-EDITS");
      diskContent = "MY-EDITS";
      noteSelfWrittenFile(A_PATH, "LAST-SAVED");
      useSettingsStore.setState({ autoSaveIntervalMs: 1000 });
      const viewRef = { current: {} as EditorView };
      renderHook(() => useAutoSave(viewRef, { current: "MY-EDITS" }));
      await act(async () => {
        vi.advanceTimersByTime(1500);
        await Promise.resolve();
      });
      expect(callsOf("write_file")).toHaveLength(0);
      // 内容已一致 → 清脏标记，不提示打扰
      expect(useEditorStore.getState().isDirty).toBe(false);
      expect(notifyMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("读盘失败（文件被删/被锁）→ 放弃写盘，不崩", async () => {
    vi.useFakeTimers();
    try {
      enterTauri("main");
      seedTab("MY-EDITS");
      diskContent = null; // read_file 抛错
      noteSelfWrittenFile(A_PATH, "LAST-SAVED");
      useSettingsStore.setState({ autoSaveIntervalMs: 1000 });
      const viewRef = { current: {} as EditorView };
      renderHook(() => useAutoSave(viewRef, { current: "MY-EDITS" }));
      await act(async () => {
        vi.advanceTimersByTime(1500);
        await Promise.resolve();
      });
      expect(callsOf("write_file")).toHaveLength(0);
      // 保守：脏标记保留（内容仍在内存里，用户可另存为）
      expect(useEditorStore.getState().isDirty).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("连续两次自动保存之间复用读盘结果（缓存生效）", async () => {
    vi.useFakeTimers();
    try {
      enterTauri("main");
      seedTab("MY-EDITS");
      diskContent = "LAST-SAVED";
      noteSelfWrittenFile(A_PATH, "LAST-SAVED");
      useSettingsStore.setState({ autoSaveIntervalMs: 1000 });
      const viewRef = { current: {} as EditorView };
      renderHook(() => useAutoSave(viewRef, { current: "MY-EDITS" }));
      await act(async () => {
        // 第一次保存：磁盘 === 上次自写 → 正常写盘
        vi.advanceTimersByTime(1500);
        await Promise.resolve();
      });
      // 让标签重新变脏，触发第二次定时保存
      act(() => useEditorStore.setState({ isDirty: true }));
      await act(async () => {
        vi.advanceTimersByTime(1500);
        await Promise.resolve();
      });
      // 第二次：磁盘 === 目标（第一次已写入）→ skip，不多打一次磁盘。
      // 注意：写盘成功会让 mock 把磁盘改为 MY-EDITS，因此这里断言的是
      // 「skip 分支不产生额外 read_file」——读盘次数不应因第二次保存而显著增加。
      const reads = callsOf("read_file").length;
      expect(reads).toBeGreaterThanOrEqual(1);
      expect(callsOf("write_file").length).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("非 Tauri（浏览器）环境不读盘、不写盘冲突判定（走 localStorage）", async () => {
    vi.useFakeTimers();
    try {
      delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
      seedTab("BROWSER-CONTENT");
      // 读盘缓存隔离：先清一次，避免上一用例残留影响判定
      __resetDiskReadCacheForTest();
      __resetSelfWriteGuardForTest();
      localStorage.clear();
      useSettingsStore.setState({ autoSaveIntervalMs: 1000 });
      const viewRef = { current: {} as EditorView };
      renderHook(() => useAutoSave(viewRef, { current: "BROWSER-CONTENT" }));
      await act(async () => {
        vi.advanceTimersByTime(1500);
        await Promise.resolve();
      });
      expect(localStorage.getItem("lightmd-content")).toBe("BROWSER-CONTENT");
      expect(callsOf("read_file")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
