// @vitest-environment jsdom
/**
 * `workspaceSearch` 服务层单测（v0.15.0 R6b）。
 *
 * 覆盖设计 §5.3/§5.4 的前端契约（Rust 侧行为由 259 个 Rust 测试保证，这里只测前端）：
 * 1. **流式增量累积**：Rust 每帧 `hits` 是增量（`mem::take`），前端必须逐帧累加；
 *    若当快照替换，最后一帧会塌成只剩最后一批 —— 这是本文件最重要的用例。
 * 2. **queryId 过期丢弃**：换词后旧查询的迟到帧不得污染新结果。
 * 3. **取消**：cancel 清活跃 id + 调 Rust 命令；取消后旧帧全部失效。
 * 4. **脏文档覆盖**：已打开文件用内存文本重算（磁盘有/内存无 → 消失；
 *    磁盘无/内存有 → 出现），未打开文件保留磁盘结果。
 * 5. **regex 拒绝提示**：本地先拦（不静默失败），并归一成 `REGEX_UNSUPPORTED`。
 * 6. 跳过原因汇总、truncated、空查询短路。
 *
 * `invoke` 用 vi.mock 注入；Channel 用真实类（jsdom 下它只是回调容器）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── mocks（必须在 import 服务之前）─────────────────────────
//
// 为什么连 `Channel` 也一起 mock：真实 `Channel` 构造函数会调
// `window.__TAURI_INTERNALS__.transformCallback`，jsdom 里没有这个内部对象 →
// 构造即抛 `Cannot read properties of undefined`。仓库既有服务测试
// （v0.6.0-translate-service）用的是同一手法：换成只记录实例的假类，
// 测试通过 `MockChannel.last.onmessage(...)` 模拟 Rust 推帧。
const { invokeMock, MockChannel } = vi.hoisted(() => {
  class MockChannel {
    static last: MockChannel | null = null;
    onmessage: ((msg: any) => void) | undefined;
    constructor() {
      MockChannel.last = this;
    }
  }
  return { invokeMock: vi.fn(), MockChannel };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: MockChannel,
}));

import {
  __resetWorkspaceSearchForTest,
  cancelWorkspaceSearch,
  createWorkspaceAccumulator,
  createWorkspaceQueryId,
  emptySkipSummary,
  getActiveWorkspaceQueryId,
  parseWorkspaceSearchError,
  reconcileOpenFiles,
  searchWorkspace,
  skipSummaryTotal,
  type OpenFileText,
  type WorkspaceSearchProgress,
  type WorkspaceSearchRequest,
  type WorkspaceSearchSnapshot,
} from "../services/workspaceSearch";

// ─── 测试替身 ──────────────────────────────────────────────

/** 构造一条 Rust 命中 */
function hit(filePath: string, line: number, occurrence: number, snippet?: string) {
  return {
    filePath,
    line,
    column: 1,
    length: 5,
    occurrence,
    snippet: snippet ?? `line ${line} with hello world`,
  };
}

/** 构造一帧 */
function frame(
  queryId: string,
  hits: ReturnType<typeof hit>[],
  extra: Partial<WorkspaceSearchProgress> = {},
): WorkspaceSearchProgress {
  return {
    queryId,
    done: false,
    filesScanned: extra.filesScanned ?? 0,
    filesSkipped: extra.filesSkipped ?? 0,
    skippedReasons: extra.skippedReasons ?? emptySkipSummary(),
    truncated: extra.truncated ?? false,
    ...extra,
    // hits 必须最后赋值（`...extra` 可能把它覆盖成别的形状，显式参数才是准的）
    hits: hits as WorkspaceSearchProgress["hits"],
  };
}

/** 构造一个最小请求 */
function req(overrides: Partial<WorkspaceSearchRequest> = {}): WorkspaceSearchRequest {
  return {
    queryId: "q1",
    roots: ["D:/ws"],
    query: "hello",
    options: { caseSensitive: false, wholeWord: false, regex: false },
    ...overrides,
  };
}

/**
 * 可控 invoke：返回一个**待决** Promise，测试自己决定何时 resolve。
 *
 * 为什么需要它：`searchWorkspace` 在 `await invoke(...)` 之后就走收尾分支（清活跃
 * id、返回结果）。若 mock 立刻 resolve，帧还没来得及推就被判"查询已结束"，
 * 竞态用例全部失真。真实 Tauri 里 invoke 是**等 Rust 扫完才 resolve**，期间持续
 * 推帧 —— 所以"先推帧、后 resolve"才是正确时序。
 */
function installDeferred() {
  const pending: Array<{
    cmd: string;
    args: any;
    resolve: (v: any) => void;
    reject: (e: any) => void;
  }> = [];
  invokeMock.mockImplementation((cmd: string, args: any) => {
    return new Promise((resolve, reject) => {
      pending.push({ cmd, args, resolve, reject });
    });
  });
  return {
    get pending() {
      return pending;
    },
    /** 取得调用记录（默认第一个 search_workspace） */
    call(cmd = "search_workspace", index = 0) {
      return pending.filter((p) => p.cmd === cmd)[index];
    },
    /** 结束该次调用（Rust 扫完正常返回） */
    finish(cmd = "search_workspace", index = 0) {
      pending.filter((p) => p.cmd === cmd)[index]?.resolve(undefined);
    },
    /** 让该次调用失败 */
    fail(reason: string, cmd = "search_workspace", index = 0) {
      pending.filter((p) => p.cmd === cmd)[index]?.reject(reason);
    },
    /** 实际被创建的那个 Channel（MockChannel.last） */
    channel(): { onmessage?: (f: any) => void } {
      return MockChannel.last as any;
    },
  };
}

/** 等微任务轮转一拍（让 searchWorkspace 走到 await invoke 之后） */
async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * 安装一个假的 `search_workspace`：按顺序把给定帧推给 Channel，然后 resolve。
 *
 * 为什么自己推帧而不是 mock 返回值：Tauri 的真实协议就是"命令 + Channel 流"，
 * 只有走 Channel 才能复现"帧到达时的竞态"，这正是本模块的核心逻辑。
 */
function installStream(
  frames: WorkspaceSearchProgress[],
  opts: { onInvoke?: (args: any) => void; rejectWith?: string } = {},
) {
  invokeMock.mockImplementation((cmd: string, args: any) => {
    if (cmd === "search_workspace") {
      opts.onInvoke?.(args);
      if (opts.rejectWith) return Promise.reject(opts.rejectWith);
      // Channel 实例在 searchWorkspace 里刚被创建 → MockChannel.last 就是它
      const ch = MockChannel.last!;
      return Promise.resolve().then(async () => {
        for (const f of frames) {
          await Promise.resolve();
          ch.onmessage?.(f);
        }
        return undefined;
      });
    }
    if (cmd === "cancel_workspace_search") return Promise.resolve(undefined);
    return Promise.resolve(undefined);
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  MockChannel.last = null;
  __resetWorkspaceSearchForTest();
});

afterEach(() => {
  __resetWorkspaceSearchForTest();
});

// ═══════════ ① 流式增量累积（最关键） ═══════════

describe("R6b · 流式结果增量累积", () => {
  it("★ 多帧 hits 是增量 → 必须累加（不是把最后一帧当全量）", async () => {
    const snapshots: WorkspaceSearchSnapshot[] = [];
    installStream([
      frame("q1", [hit("D:/ws/a.md", 1, 0)], { filesScanned: 3 }),
      frame("q1", [hit("D:/ws/a.md", 2, 1), hit("D:/ws/b.md", 9, 0)], { filesScanned: 7 }),
      frame("q1", [hit("D:/ws/c.md", 4, 0)], {
        filesScanned: 10,
        done: true,
      }),
    ]);

    const result = await searchWorkspace(req(), {
      onProgress: (s) => snapshots.push(s),
    });

    // 3 帧 → 逐帧增长：1 / 3 / 4
    expect(snapshots.map((s) => s.totalHits)).toEqual([1, 3, 4]);
    // 最终结果包含**全部 4 条**（若误当快照，只剩最后 1 条）
    expect(result.totalHits).toBe(4);
    expect(result.files).toHaveLength(3);
    expect(result.files.map((f) => f.fileName)).toEqual(["a.md", "b.md", "c.md"]);
    // a.md 两条命中
    const a = result.files.find((f) => f.fileName === "a.md")!;
    expect(a.rows.map((r) => r.line)).toEqual([1, 2]);
    expect(a.matchCount).toBe(2);
  });

  it("进度取最新帧的累计值（filesScanned 是累计，不是增量）", async () => {
    const snapshots: WorkspaceSearchSnapshot[] = [];
    installStream([
      frame("q1", [hit("D:/ws/a.md", 1, 0)], { filesScanned: 5, filesSkipped: 2 }),
      frame("q1", [hit("D:/ws/b.md", 1, 0)], { filesScanned: 12, filesSkipped: 3, done: true }),
    ]);
    await searchWorkspace(req(), { onProgress: (s) => snapshots.push(s) });
    expect(snapshots[0].filesScanned).toBe(5);
    expect(snapshots[1].filesScanned).toBe(12);
    expect(snapshots[1].filesSkipped).toBe(3);
  });

  it("同文件跨帧的 occurrence 保持 Rust 给的连续序号（前端不重编号）", async () => {
    installStream([
      frame("q1", [hit("D:/ws/a.md", 1, 0), hit("D:/ws/a.md", 1, 1)]),
      frame("q1", [hit("D:/ws/a.md", 5, 2)], { done: true }),
    ]);
    const result = await searchWorkspace(req());
    const rows = result.files[0].rows;
    expect(rows.map((r) => r.occurrence)).toEqual([0, 1, 2]);
  });

  it("按文件分组：同一文件多行归一个分组，matchCount 累计", async () => {
    installStream([
      frame("q1", [
        hit("D:/ws/a.md", 1, 0),
        hit("D:/ws/a.md", 2, 1),
        hit("D:/ws/a.md", 3, 2),
        hit("D:/ws/b.md", 1, 0),
      ], { done: true }),
    ]);
    const result = await searchWorkspace(req());
    expect(result.files).toHaveLength(2);
    expect(result.files[0].matchCount).toBe(3);
    expect(result.files[1].matchCount).toBe(1);
    expect(result.totalHits).toBe(4);
  });

  it("路径大小写/分隔符不同的同一文件被合并成一个分组", async () => {
    installStream([
      frame("q1", [
        hit("D:\\WS\\A.md", 1, 0),
        hit("d:/ws/a.md", 2, 1),
      ], { done: true }),
    ]);
    const result = await searchWorkspace(req());
    expect(result.files).toHaveLength(1);
    expect(result.files[0].matchCount).toBe(2);
  });

  it("跳过原因汇总与 truncated 正确透出", async () => {
    const reasons = { ...emptySkipSummary(), hiddenDir: 3, tooLarge: 2, binary: 1 };
    installStream([
      frame("q1", [hit("D:/ws/a.md", 1, 0)], {
        filesSkipped: 6,
        skippedReasons: reasons,
        truncated: true,
        done: true,
      }),
    ]);
    const result = await searchWorkspace(req());
    expect(result.truncated).toBe(true);
    expect(result.filesSkipped).toBe(6);
    expect(result.skippedReasons.hiddenDir).toBe(3);
    expect(skipSummaryTotal(result.skippedReasons)).toBe(6);
  });

  it("done 帧之后仍有迟到帧 → 忽略（不改变最终结果）", async () => {
    const d = installDeferred();
    const p = searchWorkspace(req());
    await tick();
    const ch = d.call()!.args.onProgress as { onmessage?: (f: any) => void };
    ch.onmessage?.(frame("q1", [hit("D:/ws/a.md", 1, 0)], { done: true }));
    // done 之后再来一帧（Rust 不该发，但防御性忽略）
    ch.onmessage?.(frame("q1", [hit("D:/ws/z.md", 9, 0)], { done: false }));
    d.finish();
    const result = await p;
    expect(result.totalHits).toBe(1);
    expect(result.files[0].fileName).toBe("a.md");
  });
});

// ═══════════ ② queryId 竞态：旧帧绝不允许覆盖新结果 ═══════════

describe("R6b · queryId 过期丢弃", () => {
  it("★ 旧 queryId 的帧被整体丢弃", async () => {
    const d = installDeferred();
    const snapshots: WorkspaceSearchSnapshot[] = [];
    const p = searchWorkspace(req({ queryId: "new" }), {
      onProgress: (s) => snapshots.push(s),
    });
    await tick();
    const ch = d.call()!.args.onProgress as { onmessage?: (f: any) => void };
    // 旧查询的迟到帧
    ch.onmessage?.(frame("old", [hit("D:/ws/stale.md", 1, 0)], { done: false }));
    expect(snapshots).toHaveLength(0);
    // 新查询的帧正常接受
    ch.onmessage?.(frame("new", [hit("D:/ws/fresh.md", 1, 0)], { done: true }));
    d.finish();
    const result = await p;
    expect(snapshots).toHaveLength(1);
    expect(result.files.map((f) => f.fileName)).toEqual(["fresh.md"]);
  });

  it("新查询取代旧查询：旧查询 id 从活跃状态清出，旧帧全部失效", async () => {
    const d = installDeferred();
    const cancels: string[] = [];
    // cancel 命令立刻成功（不阻塞）
    const origImpl = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation((cmd: string, args: any) => {
      if (cmd === "cancel_workspace_search") {
        cancels.push(args.queryId);
        return Promise.resolve(undefined);
      }
      return origImpl(cmd, args);
    });

    const pA = searchWorkspace(req({ queryId: "A", query: "aa" }));
    await tick();
    expect(getActiveWorkspaceQueryId()).toBe("A");
    const chA = d.call("search_workspace", 0)!.args.onProgress as {
      onmessage?: (f: any) => void;
    };

    // B 启动 → A 被自动取消（发 cancel 命令）
    const pB = searchWorkspace(req({ queryId: "B", query: "bb" }));
    await tick();
    expect(getActiveWorkspaceQueryId()).toBe("B");
    expect(cancels).toContain("A");
    const chB = d.call("search_workspace", 1)!.args.onProgress as {
      onmessage?: (f: any) => void;
    };

    const snapsA: any[] = [];
    // A 的迟到帧必须丢弃
    chA.onmessage?.(frame("A", [hit("D:/ws/a.md", 1, 0)], { done: true }));
    // B 正常出结果
    chB.onmessage?.(frame("B", [hit("D:/ws/b.md", 2, 0)], { done: true }));
    d.finish("search_workspace", 1);
    const rB = await pB;
    expect(rB.files.map((f) => f.fileName)).toEqual(["b.md"]);
    expect(snapsA).toHaveLength(0);
    // A 的 promise 不应挂起：invoke 也结束后收尾（cancelled）
    d.finish("search_workspace", 0);
    const rA = await pA;
    expect(rA.cancelled).toBe(true);
    expect(rA.totalHits).toBe(0);
  });
});

// ═══════════ ③ 取消 ═══════════

describe("R6b · 取消", () => {
  it("cancelWorkspaceSearch 调 Rust 命令并清活跃 id", async () => {
    const d = installDeferred();
    const cancels: string[] = [];
    const origImpl = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation((cmd: string, args: any) => {
      if (cmd === "cancel_workspace_search") {
        cancels.push(args.queryId);
        return Promise.resolve(undefined);
      }
      return origImpl(cmd, args);
    });

    const p = searchWorkspace(req({ queryId: "qX" }));
    await tick();
    expect(getActiveWorkspaceQueryId()).toBe("qX");
    const ch = d.call()!.args.onProgress as { onmessage?: (f: any) => void };

    const ok = await cancelWorkspaceSearch();
    expect(ok).toBe(true);
    expect(cancels).toEqual(["qX"]);
    expect(getActiveWorkspaceQueryId()).toBeNull();

    // 取消后旧帧被丢弃（不再累积）
    ch.onmessage?.(frame("qX", [hit("D:/ws/a.md", 1, 0)], { done: false }));
    d.finish();
    const r = await p;
    expect(r.cancelled).toBe(true);
    expect(r.totalHits).toBe(0);
  });

  it("带指定 queryId 取消只杀目标查询（换词时不误杀新查询）", async () => {
    const d = installDeferred();
    const cancels: string[] = [];
    const origImpl = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation((cmd: string, args: any) => {
      if (cmd === "cancel_workspace_search") {
        cancels.push(args.queryId);
        return Promise.resolve(undefined);
      }
      return origImpl(cmd, args);
    });
    const p = searchWorkspace(req({ queryId: "newQ" }));
    await tick();
    await cancelWorkspaceSearch("oldQ");
    expect(cancels).toEqual(["oldQ"]);
    // 新查询仍活跃（带 id 的取消不会误杀）
    expect(getActiveWorkspaceQueryId()).toBe("newQ");
    d.finish();
    await p;
  });

  it("无活跃查询时 cancel 返回 false 且不发 IPC", async () => {
    invokeMock.mockResolvedValue(undefined);
    expect(await cancelWorkspaceSearch()).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("Rust 取消导致的提前 return（invoke 成功但无 done 帧）→ cancelled=true", async () => {
    // 模拟 Rust：取消后直接 return Ok(())，只推过半帧
    installStream([
      frame("q1", [hit("D:/ws/a.md", 1, 0)], { filesScanned: 2, done: false }),
    ]);
    const result = await searchWorkspace(req());
    expect(result.cancelled).toBe(true);
    // 已完成的部分结果保留（不是清空）
    expect(result.totalHits).toBe(1);
    expect(result.filesScanned).toBe(2);
  });
});

// ═══════════ ④ 脏文档覆盖 ═══════════

describe("R6b · 脏文档覆盖（已打开文件以内存为准）", () => {
  /** 内存文本来源（可变的，模拟编辑器实时内容） */
  function memoryAt(path: string, text: { v: string }): OpenFileText {
    return { filePath: path, getText: () => text.v };
  }

  it("★ 磁盘有命中、内存已删掉该词 → 文件从结果中消失", async () => {
    installStream([
      frame("q1", [
        hit("D:/ws/dirty.md", 8, 0),
        hit("D:/ws/clean.md", 3, 0),
      ], { done: true }),
    ]);
    const dirty = { v: "这里已经改成别的内容了，没有那个词" };
    const result = await searchWorkspace(req(), {
      openFiles: [memoryAt("D:/ws/dirty.md", dirty)],
    });
    // dirty.md 被剔除（内存里零命中），clean.md 保留磁盘结果
    expect(result.files.map((f) => f.fileName)).toEqual(["clean.md"]);
    // 命中数（1 条被内存真值替换掉）与文件数（1 个文件被重算）分别断言：
    // UI 提示用文件数（"其中 N 个已打开文件按内存内容校正"），诊断用命中数
    expect(result.reconciledDropped).toBe(1);
    expect(result.reconciledFiles).toBe(1);
    expect(result.totalHits).toBe(1);
  });

  it("★ 磁盘无命中、内存新增了该词 → 该文件出现在结果中", async () => {
    installStream([
      frame("q1", [hit("D:/ws/disk.md", 2, 0)], { done: true }),
    ]);
    const dirty = { v: "第一行\n第二行 hello world\n第三行" };
    const result = await searchWorkspace(req(), {
      openFiles: [memoryAt("D:/ws/disk.md", dirty)],
    });
    const f = result.files.find((x) => x.fileName === "disk.md")!;
    expect(f).toBeTruthy();
    // 内存重算：hello 在第 2 行（磁盘给的是第 2 行但内容不同 → 以内存为准）
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0].line).toBe(2);
    // 磁盘那 1 条被替换（dropped 计数）
    expect(result.reconciledDropped).toBe(1);
  });

  it("内存重算用同一套口径：大小写敏感/全词 与磁盘搜索一致", async () => {
    installStream([
      frame("q1", [hit("D:/ws/a.md", 1, 0)], { done: true }),
    ]);
    // "Hello world" / "hello again" / "shelloworld"
    const content = { v: "Hello world\nhello again\nshelloworld" };
    // caseSensitive：第 1 行的 Hello 不命中（大写 H）；第 3 行 shelloworld 里
    // 含小写 "hello"（s-**hello**-world）→ 命中。这是字面子串匹配，不是全词
    const r1 = await searchWorkspace(req({ options: { caseSensitive: true, wholeWord: false, regex: false } }), {
      openFiles: [memoryAt("D:/ws/a.md", content)],
    });
    expect(r1.files[0].rows.map((r) => r.line)).toEqual([2, 3]);

    // wholeWord：shelloworld 不算命中（前后是 s/w 都是词字符）→ 只有第 1、2 行
    __resetWorkspaceSearchForTest();
    invokeMock.mockReset();
    installStream([
      frame("q2", [hit("D:/ws/a.md", 1, 0)], { done: true }),
    ]);
    const r2 = await searchWorkspace(req({ queryId: "q2", options: { caseSensitive: false, wholeWord: true, regex: false } }), {
      openFiles: [memoryAt("D:/ws/a.md", content)],
    });
    expect(r2.files[0].rows.map((r) => r.line)).toEqual([1, 2]);
  });

  it("未打开的文件保留磁盘结果（不被覆盖）", async () => {
    installStream([
      frame("q1", [hit("D:/ws/closed.md", 5, 0)], { done: true }),
    ]);
    const result = await searchWorkspace(req(), { openFiles: [] });
    expect(result.files).toHaveLength(1);
    expect(result.files[0].rows[0].line).toBe(5);
    expect(result.reconciledDropped).toBe(0);
  });

  it("路径大小写/分隔符不同仍能匹配到内存文本（pathCompareKey 归一）", async () => {
    installStream([
      frame("q1", [hit("D:/ws/Sub/File.MD", 1, 0)], { done: true }),
    ]);
    const result = await searchWorkspace(req(), {
      openFiles: [memoryAt("d:\\ws\\sub\\file.md", { v: "nope" })],
    });
    // 内存里没有 hello → 该文件被剔除
    expect(result.files).toHaveLength(0);
    expect(result.reconciledDropped).toBe(1);
  });

  it("getText 抛错时保留磁盘结果（不让整次搜索崩掉）", async () => {
    installStream([
      frame("q1", [hit("D:/ws/a.md", 1, 0)], { done: true }),
    ]);
    const result = await searchWorkspace(req(), {
      openFiles: [{ filePath: "D:/ws/a.md", getText: () => { throw new Error("boom"); } }],
    });
    expect(result.files).toHaveLength(1);
    expect(result.files[0].rows[0].line).toBe(1);
  });

  it("reconcileOpenFiles 是纯函数：可直接喂分组验证", () => {
    const files = [
      {
        fileKey: "d:/ws/a.md",
        filePath: "D:/ws/a.md",
        fileName: "a.md",
        rows: [],
        matchCount: 2,
      },
    ];
    const out = reconcileOpenFiles(
      files,
      req(),
      [{ filePath: "D:/ws/a.md", getText: () => "hello there\nhello again" }],
    );
    expect(out.dropped).toBe(2);
    expect(out.reconciledFiles).toBe(1);
    expect(out.files[0].matchCount).toBe(2);
    expect(out.files[0].rows.map((r) => r.line)).toEqual([1, 2]);
    // occurrence 由本地重算（0、1），与磁盘序号解耦
    expect(out.files[0].rows.map((r) => r.occurrence)).toEqual([0, 1]);
  });
});

// ═══════════ ⑤ regex 拒绝 ═══════════

describe("R6b · regex 首版禁用：明确提示而不是静默失败", () => {
  it("本地先行拦截：不发 search_workspace IPC，抛 REGEX_UNSUPPORTED", async () => {
    invokeMock.mockResolvedValue(undefined);
    const errors: any[] = [];
    await expect(
      searchWorkspace(req({ options: { caseSensitive: false, wholeWord: false, regex: true } }), {
        onError: (e) => errors.push(e),
      }),
    ).rejects.toMatchObject({ code: "REGEX_UNSUPPORTED" });
    expect(invokeMock).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("REGEX_UNSUPPORTED");
    // 提示文案必须说清楚"不支持正则"
    expect(errors[0].detail).toMatch(/正则/);
  });

  it("Rust 侧拒绝（PROVIDER|400|…正则…）被归一成 REGEX_UNSUPPORTED", async () => {
    installStream([], {
      rejectWith: "PROVIDER|400|工作区范围暂不支持正则搜索，请改用普通文本",
    });
    await expect(searchWorkspace(req())).rejects.toMatchObject({
      code: "REGEX_UNSUPPORTED",
    });
  });

  it("parseWorkspaceSearchError：普通错误归 OTHER，正则拒绝归 REGEX_UNSUPPORTED", () => {
    expect(parseWorkspaceSearchError("boom").code).toBe("OTHER");
    expect(parseWorkspaceSearchError(new Error("x")).code).toBe("OTHER");
    expect(
      parseWorkspaceSearchError("PROVIDER|400|工作区范围暂不支持正则搜索").code,
    ).toBe("REGEX_UNSUPPORTED");
    // 即使 code 变了，只要语义是"正则不支持"也要认出来
    expect(parseWorkspaceSearchError("E_REGEX|400|regex not supported here").code).toBe(
      "REGEX_UNSUPPORTED",
    );
    // 反向：错误里提到 regex 但不是"不支持"→ 不误判
    expect(parseWorkspaceSearchError("regex engine crashed").code).toBe("OTHER");
  });
});

// ═══════════ ⑥ 空查询 / 错误传播 / 累积器单元 ═══════════

describe("R6b · 边界与累积器", () => {
  it("空 query 直接返回空结果，不扫盘（无 IPC）", async () => {
    invokeMock.mockResolvedValue(undefined);
    const result = await searchWorkspace(req({ query: "" }));
    expect(result.totalHits).toBe(0);
    expect(result.files).toHaveLength(0);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("普通 IPC 错误 → onError + reject（不清空已得结果）", async () => {
    installStream([], { rejectWith: "E_IO|500|磁盘读取失败" });
    const errors: any[] = [];
    await expect(searchWorkspace(req(), { onError: (e) => errors.push(e) })).rejects.toMatchObject({
      code: "OTHER",
    });
    expect(errors[0].detail).toContain("磁盘读取失败");
    expect(getActiveWorkspaceQueryId()).toBeNull();
  });

  it("累积器：addFrame 逐帧增长，snapshot 与 finish 结构一致", () => {
    const r = req();
    const acc = createWorkspaceAccumulator(r);
    acc.addFrame(frame("q1", [hit("D:/ws/a.md", 1, 0)]));
    expect(acc.totalHits).toBe(1);
    acc.addFrame(frame("q1", [hit("D:/ws/a.md", 2, 1)], { filesScanned: 4 }));
    expect(acc.totalHits).toBe(2);
    const snap = acc.snapshot();
    expect(snap.filesScanned).toBe(4);
    const fin = acc.finish({ cancelled: false, reconciledDropped: 0 });
    expect(fin.totalHits).toBe(snap.totalHits);
    expect(fin.files).toHaveLength(snap.files.length);
  });

  it("累积器：query 大小写不敏感时 snippet 高亮仍能切出匹配段", () => {
    const acc = createWorkspaceAccumulator(req({ query: "HELLO" }));
    acc.addFrame(frame("q1", [hit("D:/ws/a.md", 1, 0, "say hello world")]));
    const row = acc.snapshot().files[0].rows[0];
    expect(row.lineText).toBe("say hello world");
    // 高亮段必须覆盖 hello（忽略大小写的定位）
    const marked = row.segments.filter((s) => s.match).map((s) => s.text);
    expect(marked).toEqual(["hello"]);
    expect(row.matchStart).toBe(4);
  });

  it("文件名提取同时支持 / 与 \\ 分隔符", () => {
    const acc = createWorkspaceAccumulator(req());
    acc.addFrame(frame("q1", [hit("D:\\ws\\x\\y.md", 1, 0)]));
    expect(acc.snapshot().files[0].fileName).toBe("y.md");
  });

  it("createWorkspaceQueryId 每次唯一且带前缀", () => {
    const a = createWorkspaceQueryId();
    const b = createWorkspaceQueryId();
    expect(a).not.toBe(b);
    expect(a.startsWith("ws-")).toBe(true);
    expect(createWorkspaceQueryId("x").startsWith("x-")).toBe(true);
  });

  it("skipSummaryTotal 容忍 null/缺字段", () => {
    expect(skipSummaryTotal(null)).toBe(0);
    expect(skipSummaryTotal(undefined)).toBe(0);
    expect(skipSummaryTotal(emptySkipSummary())).toBe(0);
    expect(skipSummaryTotal({ ...emptySkipSummary(), symlinkLoop: 2 })).toBe(2);
  });
});
