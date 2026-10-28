/**
 * 阶段2 模块自测：sourceAdapter / pmAdapter / coordinator
 *
 * 覆盖任务卡要求的**归并规则 / bridge 忽略 / 跨文件护栏**，全部为纯逻辑断言
 * （不挂 DOM、不建 ProseMirror view），与阶段 1 的 proof 单测同一纪律：
 * 断言精确、不为变绿放宽。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetDocumentHistoryForTest,
  begin,
  canRedo,
  canUndo,
  commit,
  currentText,
  documentHistory,
  peekUndo,
  snapshotForTest,
} from "../services/documentHistory";
import {
  DEBOUNCE_MS,
  MAX_WAIT_MS,
  createPmAdapter,
  isBridgeTransaction,
} from "./pmAdapter";
import {
  TYPING_MERGE_WINDOW_MS,
  createSourceAdapter,
  inferSourceEditKind,
} from "./sourceAdapter";
import {
  commitWholeText,
  crossFileEntryStillValid,
  makeHistoryCoordinator,
  type HistoryHost,
} from "./coordinator";

/** 可控时钟 + 可控定时器（让 350/900ms 窗口在单测里精确可复现，不依赖 sleep） */
function fakeTimers() {
  let t = 1_000_000;
  const queue: Array<{ id: number; at: number; fn: () => void }> = [];
  let nextId = 1;
  return {
    now: () => t,
    setTimer(fn: () => void, ms: number) {
      const id = nextId++;
      queue.push({ id, at: t + ms, fn });
      return id;
    },
    clearTimer(h: unknown) {
      const i = queue.findIndex((q) => q.id === h);
      if (i >= 0) queue.splice(i, 1);
    },
    /** 时间前进 ms 并触发到期的定时器（按时间序） */
    advance(ms: number) {
      t += ms;
      for (;;) {
        queue.sort((a, b) => a.at - b.at);
        const due = queue[0];
        if (!due || due.at > t) return;
        queue.shift();
        due.fn();
      }
    },
    /** 距离最近一次到期还剩多久（无队列 = Infinity） */
    nextIn(): number {
      const sorted = [...queue].sort((a, b) => a.at - b.at);
      return sorted[0] ? sorted[0].at - t : Infinity;
    },
    pendingCount: () => queue.length,
  };
}

/** 假宿主：记录 applyText / notifyBoundary 调用，文本可变 */
function fakeHost(initial: string, docKey = "doc.md") {
  const calls: {
    applyText: Array<{ text: string; restore: unknown; meta: { bridge: true; direction: string } }>;
    boundary: string[];
    afterApply: Array<{ text: string; direction: string }>;
  } = { applyText: [], boundary: [], afterApply: [] };
  let text = initial;
  let key: string | null = docKey;
  const host: HistoryHost = {
    docKey: () => key ?? "",
    currentText: () => text,
    currentMode: () => "source",
    applyText(next, restore, meta) {
      calls.applyText.push({ text: next, restore, meta });
      text = next;
    },
    notifyBoundary(kind) {
      calls.boundary.push(kind);
    },
    afterApply(next, direction) {
      calls.afterApply.push({ text: next, direction });
    },
  };
  return {
    host,
    calls,
    setText: (v: string) => {
      text = v;
    },
    getText: () => text,
    setKey: (k: string | null) => {
      key = k;
    },
  };
}

beforeEach(() => {
  __resetDocumentHistoryForTest();
});

// ═════════════════════════════════════════════════════════════
// sourceAdapter：归并规则
// ═════════════════════════════════════════════════════════════
describe("sourceAdapter：连续 typing 900ms 内合并为一步", () => {
  it("相邻偏移 + 无光标跳转 + 900ms 内 → 合并；超窗 → 新开一步", () => {
    const clock = fakeTimers();
    const adapter = createSourceAdapter({ now: clock.now });

    // 连续三次键入（光标始终在末尾）
    const p1 = adapter.plan({ text: "ab", before: "a", kind: "typing", caret: 2 })!;
    const p2 = adapter.plan({ text: "abc", before: "ab", kind: "typing", caret: 3 })!;
    expect(p2.groupId).toBe(p1.groupId); // 合并进同一组
    // 超窗（> 900ms）后再打 → 新组
    clock.advance(TYPING_MERGE_WINDOW_MS + 1);
    const p3 = adapter.plan({ text: "abcd", before: "abc", kind: "typing", caret: 4 })!;
    expect(p3.groupId).not.toBe(p1.groupId);
    expect(TYPING_MERGE_WINDOW_MS).toBe(900);
  });

  it("光标跳转（非相邻偏移）→ 独立一步", () => {
    const clock = fakeTimers();
    const adapter = createSourceAdapter({ now: clock.now });
    const p1 = adapter.plan({ text: "ab", before: "a", kind: "typing", caret: 2 })!;
    // 光标跳到开头插入（caret 不是 lastCaret+delta）
    const p2 = adapter.plan({ text: "Xab", before: "ab", kind: "typing", caret: 1 })!;
    expect(p2.groupId).not.toBe(p1.groupId);
  });

  it("IME composition 一步、自动配对一步、粘贴一步：各自独立（不与 typing 合并）", () => {
    const clock = fakeTimers();
    const adapter = createSourceAdapter({ now: clock.now });
    const t1 = adapter.plan({ text: "a", before: "", kind: "typing", caret: 1 })!;
    const t2 = adapter.plan({ text: "a中", before: "a", kind: "typing", caret: 2 })!;
    expect(t2.groupId).toBe(t1.groupId);

    const ime = adapter.plan({ text: "a中文", before: "a中", kind: "ime", caret: 3 })!;
    expect(ime.groupId).toBeUndefined(); // 独立一步
    const pair = adapter.plan({ text: "a中文(", before: "a中文", kind: "pair", caret: 4 })!;
    expect(pair.groupId).toBeUndefined();
    const paste = adapter.plan({
      text: "a中文(粘贴内容",
      before: "a中文(",
      kind: "paste",
      caret: 7,
    })!;
    expect(paste.groupId).toBeUndefined();
    // IME/pair/paste 之后的 typing 必须开新组（不能并进上面任一步）
    const after = adapter.plan({
      text: "a中文(粘贴内容X",
      before: "a中文(粘贴内容",
      kind: "typing",
      caret: 8,
    })!;
    expect(after.groupId).not.toBe(ime.groupId);
    expect(after.groupId).toBeDefined();
  });

  it("纯选区 / 无变化不产生计划（也不打断归并组）", () => {
    const clock = fakeTimers();
    const adapter = createSourceAdapter({ now: clock.now });
    const p1 = adapter.plan({ text: "ab", before: "a", kind: "typing", caret: 2 })!;
    // 纯选区：返回 null
    expect(adapter.plan({ text: "ab", before: "ab", kind: "selection" })).toBeNull();
    // 无变化
    expect(adapter.plan({ text: "ab", before: "ab", kind: "typing" })).toBeNull();
    // 组上下文仍在：仍能并进上一条
    const p2 = adapter.plan({ text: "abc", before: "ab", kind: "typing", caret: 3 })!;
    expect(p2.groupId).toBe(p1.groupId);
  });

  it("连删（delete）可与 typing 互相合并；与粘贴不合并", () => {
    const clock = fakeTimers();
    const adapter = createSourceAdapter({ now: clock.now });
    const p1 = adapter.plan({ text: "abc", before: "ab", kind: "typing", caret: 3 })!;
    const p2 = adapter.plan({ text: "ab", before: "abc", kind: "delete", caret: 2 })!;
    expect(p2.groupId).toBe(p1.groupId);
    const p3 = adapter.plan({ text: "a", before: "ab", kind: "delete", caret: 1 })!;
    expect(p3.groupId).toBe(p1.groupId);

    const paste = adapter.plan({ text: "aXYZ", before: "a", kind: "paste", caret: 4 })!;
    const typing = adapter.plan({ text: "aXYZq", before: "aXYZ", kind: "typing", caret: 5 })!;
    expect(typing.groupId).not.toBe(paste.groupId);
  });

  it("reset() 清空归并上下文（切文档后绝不跨文档合并）", () => {
    const clock = fakeTimers();
    const adapter = createSourceAdapter({ now: clock.now });
    const p1 = adapter.plan({ text: "ab", before: "a", kind: "typing", caret: 2 })!;
    adapter.reset();
    const p2 = adapter.plan({ text: "ab", before: "a", kind: "typing", caret: 2 })!;
    expect(p2.groupId).not.toBe(p1.groupId);
  });

  it("inferSourceEditKind：composing/paste/pair/删除 的判据", () => {
    expect(inferSourceEditKind({ before: "a", after: "ab", composing: true })).toBe("ime");
    expect(inferSourceEditKind({ before: "a", after: "ab", justPasted: true })).toBe("paste");
    expect(inferSourceEditKind({ before: "a", after: "a(", justPaired: true })).toBe("pair");
    expect(inferSourceEditKind({ before: "abc", after: "ab" })).toBe("delete");
    expect(inferSourceEditKind({ before: "ab", after: "abc" })).toBe("typing");
  });
});

// 端到端：sourceAdapter → documentHistory（groupId 合并真的变成一步）
describe("sourceAdapter → documentHistory 端到端：连续打字只占一步", () => {
  it("三次连续键入 → 时间线只 1 条；undo 一次回到起点", () => {
    const clock = fakeTimers();
    const adapter = createSourceAdapter({ now: clock.now });
    begin("doc.md", "a");
    const steps = [
      { text: "ab", before: "a", caret: 2 },
      { text: "abc", before: "ab", caret: 3 },
      { text: "abcd", before: "abc", caret: 4 },
    ];
    for (const s of steps) {
      const plan = adapter.plan({ ...s, kind: "typing" })!;
      expect(documentHistory.commit(plan, "doc.md")).not.toBeNull();
    }
    const snap = snapshotForTest("doc.md")!;
    expect(snap.entries.length).toBe(1);
    expect(snap.entries[0].before).toBe("a");
    expect(snap.entries[0].after).toBe("abcd");
    expect(peekUndo("doc.md")!.before).toBe("a");
  });
});

// ═════════════════════════════════════════════════════════════
// pmAdapter：bridge 忽略 + 序列化节流
// ═════════════════════════════════════════════════════════════
describe("pmAdapter：bridge 事务必须被忽略（防无限循环）", () => {
  it("tr.getMeta('historyBridge') 的事务 → 整批忽略，不序列化、不提交", () => {
    const clock = fakeTimers();
    const serialize = vi.fn(() => "NEW");
    const commitSpy = vi.fn();
    const rebaseSpy = vi.fn();
    const adapter = createPmAdapter({
      serialize,
      commit: commitSpy,
      rebase: rebaseSpy,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    adapter.reset("OLD");

    const bridgeTr = { docChanged: true, getMeta: (k: string) => (k === "historyBridge" ? true : undefined) };
    expect(isBridgeTransaction(bridgeTr)).toBe(true);
    const reason = adapter.handleTransactions(null, [bridgeTr], "docAfterUndo");

    expect(reason).toBe("bridge");
    expect(serialize).not.toHaveBeenCalled(); // 连序列化都不做
    expect(commitSpy).not.toHaveBeenCalled();
    expect(rebaseSpy).not.toHaveBeenCalled(); // 也不 rebase（baseline 由 coordinator 负责）
    expect(adapter.pending()).toBe(false);
    // 时间前进也不会突然提交
    clock.advance(2000);
    expect(commitSpy).not.toHaveBeenCalled();
  });

  it("一批里只要有一条带 historyBridge → 整批忽略（含同批的普通事务）", () => {
    const clock = fakeTimers();
    const commitSpy = vi.fn();
    const adapter = createPmAdapter({
      serialize: () => "X",
      commit: commitSpy,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    adapter.reset("B");
    const trs = [
      { docChanged: true, getMeta: () => undefined },
      { docChanged: true, getMeta: (k: string) => (k === "historyBridge" ? true : undefined) },
    ];
    expect(adapter.handleTransactions(null, trs, "after")).toBe("bridge");
    clock.advance(5000);
    expect(commitSpy).not.toHaveBeenCalled();
  });
});

describe("pmAdapter：序列化节流（禁止每次按键同步全篇序列化）", () => {
  it("连续 5 次变化只序列化 1 次（防抖窗口末尾）", () => {
    const clock = fakeTimers();
    const serialize = vi.fn(() => "T5");
    const commitSpy = vi.fn();
    const adapter = createPmAdapter({
      serialize,
      commit: commitSpy,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    adapter.reset("T0");

    const docChanged = { docChanged: true, getMeta: (k: string) => (k === "addToHistory" ? true : undefined) };
    for (let i = 0; i < 5; i++) {
      adapter.handleTransactions(null, [docChanged], `doc${i}`);
      clock.advance(50); // 每次间隔 50ms，远小于 350ms 防抖
    }
    expect(serialize).not.toHaveBeenCalled(); // 全部还在队列里
    expect(commitSpy).not.toHaveBeenCalled();

    clock.advance(DEBOUNCE_MS);
    expect(serialize).toHaveBeenCalledTimes(1); // 只序列化一次
    expect(serialize).toHaveBeenCalledWith("doc4"); // 用的是最后一次 doc
    expect(commitSpy).toHaveBeenCalledTimes(1);
    expect(commitSpy).toHaveBeenCalledWith({ before: "T0", after: "T5", origin: "pm" });
  });

  it("连续不停输入时最多攒 MAX_WAIT_MS 就切一步（不会打整段才一步）", () => {
    const clock = fakeTimers();
    let serialized = 0;
    const commits: string[] = [];
    const adapter = createPmAdapter({
      serialize: (doc) => {
        serialized++;
        return String(doc);
      },
      commit: (p) => commits.push(p.after),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    adapter.reset("d0");
    const docChanged = { docChanged: true, getMeta: () => undefined };

    // 每 100ms 打一次，持续 2 秒：应当多次切步
    let n = 1;
    for (let elapsed = 0; elapsed < 2000; elapsed += 100) {
      adapter.handleTransactions(null, [docChanged], `d${n++}`);
      clock.advance(100);
    }
    expect(MAX_WAIT_MS).toBe(900);
    // 至少切了 2 步（900ms 上限；2s 内必然 ≥2）
    expect(commits.length).toBeGreaterThanOrEqual(2);
    // 但远少于按键次数（20 次输入）
    expect(commits.length).toBeLessThan(10);
    expect(serialized).toBe(commits.length);
  });

  it("flush() 立即落地（undo 前必须 flush，否则丢最后一段打字）", () => {
    const clock = fakeTimers();
    const commitSpy = vi.fn();
    const adapter = createPmAdapter({
      serialize: () => "LATEST",
      commit: commitSpy,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    adapter.reset("BEFORE");
    adapter.handleTransactions(null, [{ docChanged: true, getMeta: () => undefined }], "doc");
    expect(adapter.pending()).toBe(true);
    expect(commitSpy).not.toHaveBeenCalled();

    expect(adapter.flush()).toBe(true);
    expect(commitSpy).toHaveBeenCalledWith({ before: "BEFORE", after: "LATEST", origin: "pm" });
    expect(adapter.pending()).toBe(false);
    // 二次 flush 不重复提交
    expect(adapter.flush()).toBe(false);
  });

  it("addToHistory:false 的事务 → 只 rebase baseline，不产生条目", () => {
    const clock = fakeTimers();
    const commitSpy = vi.fn();
    const rebaseSpy = vi.fn();
    let serialized = "SWITCHED";
    const adapter = createPmAdapter({
      serialize: () => serialized,
      commit: commitSpy,
      rebase: rebaseSpy,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    adapter.reset("OLD");
    const tr = {
      docChanged: true,
      getMeta: (k: string) => (k === "addToHistory" ? false : undefined),
    };
    expect(adapter.handleTransactions(null, [tr], "doc")).toBe("rebase");
    expect(rebaseSpy).toHaveBeenCalledWith("SWITCHED");
    clock.advance(5000);
    expect(commitSpy).not.toHaveBeenCalled();

    // baseline 已前移到 SWITCHED：序列化出**同样文本**时不算变化（before===after → 不提交）
    adapter.handleTransactions(null, [{ docChanged: true, getMeta: () => undefined }], "doc2");
    adapter.flush();
    expect(commitSpy).not.toHaveBeenCalled();

    // 真正的新编辑：before 必须是 rebase 后的 SWITCHED（证明 baseline 确实前移了）
    serialized = "SWITCHED+edit";
    adapter.handleTransactions(null, [{ docChanged: true, getMeta: () => undefined }], "doc3");
    adapter.flush();
    expect(commitSpy).toHaveBeenCalledWith({
      before: "SWITCHED",
      after: "SWITCHED+edit",
      origin: "pm",
    });
  });

  it("无变化事务（selectionSet only）→ 不排入队列", () => {
    const clock = fakeTimers();
    const serialize = vi.fn(() => "X");
    const adapter = createPmAdapter({
      serialize,
      commit: vi.fn(),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    adapter.reset("A");
    expect(
      adapter.handleTransactions(null, [{ docChanged: false, getMeta: () => undefined }], "doc"),
    ).toBe("no-change");
    clock.advance(2000);
    expect(serialize).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════
// coordinator：护栏 + 唯一出口
// ═════════════════════════════════════════════════════════════
describe("coordinator：undo/redo 唯一出口与 bridge 落地", () => {
  it("undo 把 entry.before 交给 host.applyText，且 meta.bridge===true", () => {
    const h = fakeHost("ab");
    begin("doc.md", "A");
    commit({ after: "ab", origin: "source" });
    const coord = makeHistoryCoordinator({ api: documentHistory, host: h.host });

    expect(coord.canUndo()).toBe(true);
    expect(coord.handleUndo()).toBe(true);
    expect(h.calls.applyText.length).toBe(1);
    expect(h.calls.applyText[0].text).toBe("A");
    expect(h.calls.applyText[0].meta.bridge).toBe(true);
    expect(h.calls.applyText[0].meta.direction).toBe("undo");
    expect(h.getText()).toBe("A");
    expect(h.calls.afterApply).toEqual([{ text: "A", direction: "undo" }]);
    // 撤到底 → 边界提示，不再写回
    expect(coord.handleUndo()).toBe(false);
    expect(h.calls.boundary).toEqual(["undo"]);
    expect(h.calls.applyText.length).toBe(1);

    // redo 反向
    expect(coord.handleRedo()).toBe(true);
    expect(h.calls.applyText[1].text).toBe("ab");
    expect(h.calls.applyText[1].meta.direction).toBe("redo");
    expect(h.getText()).toBe("ab");
    expect(coord.handleRedo()).toBe(false);
    expect(h.calls.boundary).toEqual(["undo", "redo"]);
  });

  it("恢复现场：源码条目带 beforeSelection → 交给 applyText", () => {
    const h = fakeHost("ab");
    begin("doc.md", "A");
    commit({ after: "ab", origin: "source", beforeSelection: { start: 1, end: 1, scrollTop: 40 } });
    const coord = makeHistoryCoordinator({ api: documentHistory, host: h.host });
    coord.handleUndo();
    expect(h.calls.applyText[0].restore).toEqual({ start: 1, end: 1, scrollTop: 40 });
  });

  it("commitFromSource / commitFromPm 入库 + onCommitted 回调", () => {
    const h = fakeHost("A");
    const committed: number[] = [];
    begin("doc.md", "A");
    const coord = makeHistoryCoordinator({
      api: documentHistory,
      host: h.host,
      onCommitted: (e) => committed.push(e.id),
    });
    const e1 = coord.commitFromSource({ before: "A", after: "ab", origin: "source", groupId: "t" });
    const e2 = coord.commitFromPm({ before: "ab", after: "abc", origin: "pm" });
    expect(e1).not.toBeNull();
    expect(e2).not.toBeNull();
    expect(committed.length).toBe(2);
    expect(snapshotForTest("doc.md")!.entries.length).toBe(2);
  });

  it("flushPending 在 peek 之前被调用（防止丢最后一段打字）", () => {
    const order: string[] = [];
    const h = fakeHost("ab");
    begin("doc.md", "A");
    commit({ after: "ab", origin: "source" });
    const coord = makeHistoryCoordinator({
      api: documentHistory,
      host: h.host,
      flushPending: () => order.push("flush"),
    });
    const origApply = h.host.applyText;
    h.host.applyText = (...args) => {
      order.push("apply");
      origApply(...args);
    };
    coord.handleUndo();
    expect(order).toEqual(["flush", "apply"]);
  });

  it("docKey 为空时不动作（不误撤别的文档）", () => {
    const h = fakeHost("A", "");
    begin("other.md", "A");
    commit({ after: "ab", origin: "source" }, "other.md");
    const coord = makeHistoryCoordinator({ api: documentHistory, host: h.host });
    expect(coord.handleUndo()).toBe(false);
    expect(coord.canUndo()).toBe(false);
    expect(h.calls.applyText.length).toBe(0);
    // other.md 的历史完好
    expect(peekUndo("other.md")).not.toBeNull();
  });
});

describe("coordinator：跨文件 origin=cross-file 护栏（绝不覆盖用户编辑）", () => {
  it("currentText() === entry.after → 正常应用撤销", () => {
    // 目标文档时间线：cat → DOG（跨文件替换记入）
    begin("b.md", "hello cat\n");
    commitWholeText(documentHistory, "b.md", "hello cat\n", "hello DOG\n", "cross-file");
    // 用户已切到 b.md，宿主文本仍逐字节等于 entry.after → 护栏通过
    const h = fakeHost("hello DOG\n", "b.md");
    const coord = makeHistoryCoordinator({ api: documentHistory, host: h.host });

    expect(coord.handleUndo()).toBe(true);
    expect(h.calls.applyText[0].text).toBe("hello cat\n");
    expect(h.calls.applyText[0].meta.bridge).toBe(true);
    expect(h.getText()).toBe("hello cat\n");
    expect(h.calls.boundary).toEqual([]);
    // 再 undo 已到底（普通边界），redo 可回到替换后
    expect(coord.handleUndo()).toBe(false);
    expect(h.calls.boundary).toEqual(["undo"]);
    expect(coord.handleRedo()).toBe(true);
    expect(h.getText()).toBe("hello DOG\n");
  });

  it("currentText() !== entry.after → 丢弃条目 + cross-file-stale 提示，**绝不覆盖**", () => {
    const h = fakeHost("hello DOG\n用户又手改了这一行\n");
    begin("b.md", "hello cat\n");
    commitWholeText(documentHistory, "b.md", "hello cat\n", "hello DOG\n", "cross-file");
    const coord = makeHistoryCoordinator({
      api: documentHistory,
      host: { ...h.host, docKey: () => "b.md" },
    });

    expect(coord.handleUndo()).toBe(false);
    // 绝不写回
    expect(h.calls.applyText.length).toBe(0);
    // 用户手改的内容原封不动
    expect(h.getText()).toBe("hello DOG\n用户又手改了这一行\n");
    // 精准提示
    expect(h.calls.boundary).toEqual(["cross-file-stale"]);
    // 条目被丢弃（不在栈顶卡住）
    expect(peekUndo("b.md")).toBeNull();
    expect(canUndo("b.md")).toBe(false);
  });

  it("护栏只对 cross-file 生效：同文档 source 条目内容对不上也不做逐字节校验", () => {
    // docKey 必须与 begin 的一致，否则查不到条目（这里显式对齐）
    const h = fakeHost("ab", "s.md");
    begin("s.md", "A");
    commit({ after: "ab", origin: "source" });
    const coord = makeHistoryCoordinator({ api: documentHistory, host: h.host });
    // 宿主文本被非编辑动作推偏（模拟程序化写回没同步）
    h.setText("ab+something");
    // source 条目不受护栏限制 → 仍然应用（宁可应用也不静默丢历史）
    expect(coord.handleUndo()).toBe(true);
    expect(h.calls.applyText[0].text).toBe("A");
    expect(h.calls.boundary).toEqual([]);
  });

  it("crossFileEntryStillValid 是纯函数：按方向比对「将要被替换掉」的那一端", () => {
    const srcEntry = {
      id: 1,
      before: "a",
      after: "b",
      origin: "source" as const,
    };
    expect(crossFileEntryStillValid(srcEntry, "anything")).toBe(true);
    const cfEntry = { ...srcEntry, origin: "cross-file" as const };
    // undo：宿主必须还等于 after
    expect(crossFileEntryStillValid(cfEntry, "b", "undo")).toBe(true);
    expect(crossFileEntryStillValid(cfEntry, "b+edit", "undo")).toBe(false);
    // redo：宿主必须还等于 before（撤销之后的合法态，绝不能被判成"过期"）
    expect(crossFileEntryStillValid(cfEntry, "a", "redo")).toBe(true);
    expect(crossFileEntryStillValid(cfEntry, "a+edit", "redo")).toBe(false);
    expect(crossFileEntryStillValid(cfEntry, "b", "redo")).toBe(false);
  });
});

describe("commitWholeText：跨文件替换往未激活文档记条目", () => {
  it("目标文档时间线不存在 / knownText 不匹配时都能正确入库", () => {
    begin("active.md", "cur");
    // 目标文档根本没有时间线
    const e1 = commitWholeText(documentHistory, "target.md", "cat", "DOG", "cross-file");
    expect(e1).not.toBeNull();
    expect(currentText("target.md")).toBe("DOG");
    expect(peekUndo("target.md")!.before).toBe("cat");
    // 活跃文档完全不受影响
    expect(currentText("active.md")).toBe("cur");
    expect(canUndo("active.md")).toBe(false);
  });

  it("knownText 与 before 不一致 → rebase 后入库（否则用户切过去无法撤销）", () => {
    begin("t2.md", "v1");
    commit({ after: "v2", origin: "source" }, "t2.md");
    expect(currentText("t2.md")).toBe("v2");
    // 调用方从 store 读到的是 v3（中间有别的路径改过）
    const e = commitWholeText(documentHistory, "t2.md", "v3", "v4", "cross-file");
    expect(e).not.toBeNull();
    expect(e!.before).toBe("v3");
    expect(peekUndo("t2.md")!.before).toBe("v3");
  });

  it("before === after 不产生条目", () => {
    expect(commitWholeText(documentHistory, "x.md", "same", "same", "cross-file")).toBeNull();
    expect(canRedo("x.md")).toBe(false);
  });
});
