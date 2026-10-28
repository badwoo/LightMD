// @vitest-environment jsdom
/**
 * v0.15.1 需求6：跨模式撤销栈统一 —— **独立审计**用例（不复用上一轮结论）
 *
 * 用户原话：「跨模式撤销栈统一再检查下看有没有问题。」
 *
 * 本文件与 `v0151-cross-mode-undo.test.tsx`（上一轮回归）的分工：
 * - 那个文件锁**用户可见行为**（挂真 EditorContainer）；
 * - 本文件先对**纯逻辑层**做不变量/否定式审计（时间线自洽、怀疑清单 a~f），
 *   再用真实挂载覆盖「纯逻辑测不到」的跨模式链路。
 *
 * 纪律：
 * - 断言精确（文本逐字节、游标/条目数、通知条数），不为变绿放宽；
 * - 不用 `setTimeout` 真等：纯逻辑用注入时钟/定时器，集成用例才用 rAF/防抖的真实等待。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, cleanup, render } from "@testing-library/react";
import { useState } from "react";
import type { EditorView } from "prosemirror-view";
import {
  __baseTextForTest,
  __resetDocumentHistoryForTest,
  begin,
  canRedo,
  canUndo,
  commit,
  currentText,
  documentHistory,
  peekRedo,
  peekUndo,
  rebaseText,
  redo,
  snapshotForTest,
  undo,
  type DocumentHistoryApiEx,
} from "../services/documentHistory";
import {
  DEBOUNCE_MS,
  createPmAdapter,
  type PmAdapter,
  type PmCommitPlan,
} from "../editorHistory/pmAdapter";
import { createSourceAdapter } from "../editorHistory/sourceAdapter";
import {
  commitWholeText,
  makeHistoryCoordinator,
  type HistoryHost,
} from "../editorHistory/coordinator";
import {
  captureContentAnchor,
  restoreContentAnchor,
  type BlockGeometry,
} from "../utils/contentScrollMap";
import { EditorContainer } from "../components/editor/EditorContainer";
import { getMarkdownFromDoc } from "../core/editor";
import { markdownToDoc } from "../core/markdown/parser";
import { useEditorStore } from "../stores/useEditorStore";
import { setNotificationHandler, type Notification } from "../services/notificationService";

// ═════════════════════════════════════════════════════════════
// 0. 纯逻辑层测试基座
// ═════════════════════════════════════════════════════════════

/** 可控时钟 + 可控定时器（350/900ms 窗口在单测里精确可复现，不 sleep） */
function fakeClock() {
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
    advance(ms: number) {
      const target = t + ms;
      for (;;) {
        queue.sort((a, b) => a.at - b.at);
        const due = queue[0];
        if (!due || due.at > target) break;
        t = Math.max(t, due.at);
        queue.shift();
        due.fn();
      }
      t = target;
    },
    pendingCount: () => queue.length,
  };
}

/** 假宿主：记录 applyText / notifyBoundary / afterApply，文本可变 */
function fakeHost(initial: string, docKey = "doc.md") {
  const calls = {
    applyText: [] as Array<{ text: string; restore: unknown; meta: unknown }>,
    boundary: [] as string[],
    afterApply: [] as Array<{ text: string; direction: string }>,
  };
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
    getText: () => text,
    setText: (v: string) => {
      text = v;
    },
    setKey: (k: string | null) => {
      key = k;
    },
  };
}

/** 记录 rebaseText 调用的 API 代理（其余方法原样转发真实单例） */
function spyHistoryApi() {
  const rebase: Array<{ docKey: string; text: string; force: boolean }> = [];
  const api: DocumentHistoryApiEx = {
    ...documentHistory,
    rebaseText(docKey, text, opts) {
      rebase.push({ docKey, text, force: opts?.force === true });
      return documentHistory.rebaseText(docKey, text, opts);
    },
  };
  return { api, rebase };
}

/** 断言某文档时间线的不变量（链连续 / 游标与 knownText 对应 / 可用性标志一致） */
function expectTimelineInvariants(docKey: string, modelText: string, tag = "") {
  const snap = snapshotForTest(docKey);
  expect(snap, `${tag} 时间线应存在`).not.toBeNull();
  const s = snap!;
  expect(s.cursor, `${tag} 游标下界`).toBeGreaterThanOrEqual(0);
  expect(s.cursor, `${tag} 游标上界`).toBeLessThanOrEqual(s.entries.length);
  for (let i = 0; i + 1 < s.entries.length; i++) {
    expect(s.entries[i].after, `${tag} 条目链在 ${i}→${i + 1} 断开`).toBe(
      s.entries[i + 1].before,
    );
  }
  expect(currentText(docKey), `${tag} knownText 与模型文本一致`).toBe(modelText);
  if (s.cursor > 0) {
    expect(s.entries[s.cursor - 1].after, `${tag} knownText 应等于已应用末条 after`).toBe(
      modelText,
    );
  } else if (s.entries.length > 0) {
    // 游标 0：knownText 是「剩余条目第一条的 before」，或（预算淘汰后）检查点文本
    const base = __baseTextForTest(docKey);
    expect([s.entries[0].before, base], `${tag} 游标 0 的 knownText 语义`).toContain(modelText);
  }
  expect(canUndo(docKey), `${tag} canUndo 与游标一致`).toBe(s.cursor > 0);
  expect(canRedo(docKey), `${tag} canRedo 与游标一致`).toBe(s.cursor < s.entries.length);
}

/** 线性同余伪随机（审计随机游走用；仅需可复现，不用于密码学） */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

beforeEach(() => {
  __resetDocumentHistoryForTest();
});

// ═════════════════════════════════════════════════════════════
// ① 时间线不变量：模型化随机游走
// ═════════════════════════════════════════════════════════════
describe("① 时间线不变量：随机操作序列下 链/游标/knownText/可用性 始终自洽", () => {
  it("6 个种子 × 120 步 × 2 文档，逐步校验不变量（含归并/多文档/重置）", () => {
    const keys = ["audit-fuzz-a.md", "audit-fuzz-b.md"] as const;
    for (const seed of [1, 7, 42, 2026, 99991, 13579]) {
      __resetDocumentHistoryForTest();
      const rand = lcg(seed);
      const model: Record<string, string> = {};
      const lastGroup: Record<string, string | undefined> = {};
      begin(keys[0], "");
      model[keys[0]] = "";
      begin(keys[1], "起点");
      model[keys[1]] = "起点";
      let groupSeq = 0;

      for (let step = 0; step < 120; step++) {
        const key = rand() < 0.5 ? keys[0] : keys[1];
        const r = rand();
        if (r < 0.45) {
          // 提交一次编辑（50% 复用上一条 groupId，专门压归并分支）
          const add = ["a", "中", "\n", "😀", "尾"][Math.floor(rand() * 5)];
          const next =
            rand() < 0.2 && model[key].length > 0
              ? model[key].slice(0, -1)
              : model[key] + add;
          if (next === model[key]) continue;
          const groupId = rand() < 0.5 ? lastGroup[key] : `g${++groupSeq}`;
          const entry = commit(
            { before: model[key], after: next, origin: "source", groupId },
            key,
          );
          expect(entry, `种子 ${seed} 步 ${step}: before===knownText 时 commit 不应被拒`).not.toBeNull();
          model[key] = next;
          lastGroup[key] = groupId;
        } else if (r < 0.7) {
          const entry = undo(key);
          if (entry) model[key] = entry.before;
          else expect(canUndo(key), `种子 ${seed} 步 ${step}: undo 返回 null 时 canUndo 必须为 false`).toBe(false);
        } else if (r < 0.95) {
          const entry = redo(key);
          if (entry) model[key] = entry.after;
          else expect(canRedo(key), `种子 ${seed} 步 ${step}: redo 返回 null 时 canRedo 必须为 false`).toBe(false);
        } else {
          const fresh = `重置-${step}`;
          begin(key, fresh);
          model[key] = fresh;
          lastGroup[key] = undefined;
        }
        expectTimelineInvariants(key, model[key], `种子 ${seed} 步 ${step}`);
      }
    }
  });
});

// ═════════════════════════════════════════════════════════════
// ② 场景1/2：步序与逐字节往返（纯逻辑，source/pm 交替）
// ═════════════════════════════════════════════════════════════
describe("② 场景1/2：跨模式步序 + 逐字节往返", () => {
  it("source 一步 → pm 一步 → undo×2：先撤 pm 那步，再撤 source 那步", () => {
    const clock = fakeClock();
    begin("order.md", "初始\n");
    const h = fakeHost("初始\n", "order.md");
    const sourceAdapter = createSourceAdapter({ now: clock.now });
    let pmAdapter!: PmAdapter;
    const coord = makeHistoryCoordinator({
      api: documentHistory,
      host: h.host,
      flushPending: () => pmAdapter.flush(),
      syncAdapterBaseline: (text) => pmAdapter.setBaseline(text),
    });
    pmAdapter = createPmAdapter({
      serialize: (doc) => String(doc),
      commit: (plan: PmCommitPlan) => coord.commitFromPm(plan),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    pmAdapter.reset("初始\n");

    // ① 源码面打一步（同步提交）。注意：真实环境里源码编辑**不会**推进 pmAdapter 的
    //    基线，它由随后的「切换模式整篇替换事务」的 rebase 分支推进（见下），
    //    本夹具必须复刻这一步，否则 PM 侧 before 会停在旧文本。
    const plan = sourceAdapter.plan({
      before: "初始\n",
      text: "初始\n编辑",
      kind: "typing",
      caret: 4,
    })!;
    expect(coord.commitFromSource(plan)).not.toBeNull();
    // 编辑 → 阅读 的模式切换：先 flush（无队列），再整篇替换（addToHistory:false）
    pmAdapter.flush();
    expect(
      pmAdapter.handleTransactions(
        null,
        [{ docChanged: true, getMeta: (k: string) => (k === "addToHistory" ? false : undefined) }],
        "初始\n编辑",
      ),
    ).toBe("rebase");

    // ② 切到阅读面：PM 打一步（防抖队列 → flush 入库），宿主文本随之变化
    pmAdapter.handleTransactions(null, [{ docChanged: true, getMeta: () => undefined }], "初始\n编辑中");
    expect(pmAdapter.flush()).toBe(true);
    h.setText("初始\n编辑中");

    // ③ undo ×2：步序必须是「阅读那步先撤」
    expect(coord.handleUndo()).toBe(true);
    expect(h.getText()).toBe("初始\n编辑");
    expect(coord.handleUndo()).toBe(true);
    expect(h.getText()).toBe("初始\n");
    expect(coord.handleUndo()).toBe(false);
    expect(h.calls.boundary).toEqual(["undo"]);

    // ④ redo ×2 精确回顶
    expect(coord.handleRedo()).toBe(true);
    expect(h.getText()).toBe("初始\n编辑");
    expect(coord.handleRedo()).toBe(true);
    expect(h.getText()).toBe("初始\n编辑中");
    expect(coord.handleRedo()).toBe(false);
    expect(h.calls.boundary).toEqual(["undo", "redo"]);

    // 落地必须带 bridge 标记（否则撤销动作本身会被记成新编辑）
    for (const c of h.calls.applyText) {
      expect((c.meta as { bridge?: boolean }).bridge).toBe(true);
    }
  });

  it("undo ×N / redo ×N 多轮逐字节：中文 / 换行 / emoji 均精确往返", () => {
    begin("bytes.md", "");
    const steps = ["第一行\n", "第一行\n\n第二段中文", "第一行\n\n第二段中文😀", "第一行\n\n第二段中文😀\n尾"];
    const texts: string[] = [""];
    for (const t of steps) {
      expect(commit({ before: texts[texts.length - 1], after: t, origin: "source" })).not.toBeNull();
      texts.push(t);
    }
    for (let round = 0; round < 3; round++) {
      for (let i = texts.length - 2; i >= 0; i--) {
        const entry = undo();
        expect(entry, `第 ${round + 1} 轮 undo 到 ${i}`).not.toBeNull();
        expect(entry!.before).toBe(texts[i]);
        expect(currentText("bytes.md")).toBe(texts[i]);
      }
      expect(undo()).toBeNull();
      for (let i = 1; i < texts.length; i++) {
        const entry = redo();
        expect(entry, `第 ${round + 1} 轮 redo 到 ${i}`).not.toBeNull();
        expect(entry!.after).toBe(texts[i]);
        expect(currentText("bytes.md")).toBe(texts[i]);
      }
      expect(redo()).toBeNull();
    }
    expectTimelineInvariants("bytes.md", texts[texts.length - 1], "多轮往返后");
  });
});

// ═════════════════════════════════════════════════════════════
// ③ 场景3：边界提示只一次 + 边界之后 undo/redo 都还能用
// ═════════════════════════════════════════════════════════════
describe("③ 场景3：边界语义（只提示一次、不写回、之后仍可用）", () => {
  it("单次边界撤销：恰好一次 notifyBoundary，零次 applyText，游标不动", () => {
    const h = fakeHost("A", "b1.md");
    begin("b1.md", "A");
    commit({ after: "AB", origin: "source" });
    const coord = makeHistoryCoordinator({ api: documentHistory, host: h.host });

    expect(coord.handleUndo()).toBe(true);
    expect(h.calls.applyText.length).toBe(1);
    const cursorAfterUndo = snapshotForTest("b1.md")!.cursor;

    // 撤到底后再按一次（= App 的一次 Ctrl+Z）
    expect(coord.handleUndo()).toBe(false);
    expect(h.calls.boundary).toEqual(["undo"]); // 一次按键 = 一条提示
    expect(h.calls.applyText.length).toBe(1); // 不写回
    expect(snapshotForTest("b1.md")!.cursor).toBe(cursorAfterUndo); // 游标不动

    // 仍能恢复（旧缺陷：一次边界后 redo 也废）
    expect(coord.handleRedo()).toBe(true);
    expect(h.getText()).toBe("AB");
    expect(coord.handleRedo()).toBe(false);
    expect(h.calls.boundary).toEqual(["undo", "redo"]);
  });

  it("连续 5 轮「撤到底 → 边界按键 ×2 → 恢复到顶」后时间线仍完整可用", () => {
    const h = fakeHost("A", "b2.md");
    begin("b2.md", "A");
    commit({ after: "AB", origin: "source" });
    commit({ after: "ABC", origin: "source" });
    const coord = makeHistoryCoordinator({ api: documentHistory, host: h.host });

    for (let round = 0; round < 5; round++) {
      expect(coord.handleUndo()).toBe(true);
      expect(coord.handleUndo()).toBe(true);
      expect(coord.handleUndo()).toBe(false);
      expect(h.getText()).toBe("A");
      expect(coord.handleRedo()).toBe(true);
      expect(coord.handleRedo()).toBe(true);
      expect(h.getText()).toBe("ABC");
      expect(coord.handleRedo()).toBe(false);
    }
    // 5 轮 × (2 次 undo 边界 + 1 次 redo 边界)
    expect(h.calls.boundary.filter((k) => k === "undo").length).toBe(5);
    expect(h.calls.boundary.filter((k) => k === "redo").length).toBe(5);
    expectTimelineInvariants("b2.md", "ABC", "5 轮边界后");
  });
});

// ═════════════════════════════════════════════════════════════
// ④ 场景4：撤销后新编辑截断 redo（同 groupId 也不得合并回旧组）
// ═════════════════════════════════════════════════════════════
describe("④ 场景4：撤销后输入必须截断 redo 分支", () => {
  it("undo 后用同一 groupId 提交：既不合并旧组、也不允许 redo 出「未来」内容", () => {
    begin("trunc.md", "A");
    commit({ before: "A", after: "AB", origin: "source", groupId: "typing-1" });
    expect(undo()!.before).toBe("A");
    expect(canRedo("trunc.md")).toBe(true);

    // 撤销后的新输入：即便 groupId 与旧组相同，也必须开新一步（truncated 禁止合并）
    const entry = commit({
      before: "A",
      after: "AX",
      origin: "source",
      groupId: "typing-1",
      beforeSelection: { start: 1, end: 1 },
    });
    expect(entry).not.toBeNull();
    expect(entry!.before).toBe("A");
    expect(entry!.after).toBe("AX");
    expect(canRedo("trunc.md")).toBe(false); // redo 分支被截断
    const snap = snapshotForTest("trunc.md")!;
    expect(snap.entries.length).toBe(1); // 旧的 AB 已被丢弃（不是变成两步）
    expect(snap.cursor).toBe(1);
    expect(redo()).toBeNull();
    expect(undo()!.before).toBe("A");
  });

  it("归并窗口内的「撤销后再打字」：adapter 会开新组，commit 侧还有 truncated 双保险", () => {
    const clock = fakeClock();
    const adapter = createSourceAdapter({ now: clock.now });
    begin("m.md", "A");
    const p1 = adapter.plan({ before: "A", text: "AB", kind: "typing", caret: 2 })!;
    commit(p1);
    undo(); // knownText 回到 A，存在 redo 分支
    expect(canRedo("m.md")).toBe(true);

    // 撤销后文本变回 A ≠ adapter.lastText(AB) → 必然开新组（第一层保险）
    const p2 = adapter.plan({ before: "A", text: "AX", kind: "typing", caret: 2 })!;
    expect(p2.groupId).not.toBe(p1.groupId);

    // 即便调用方硬塞回旧 groupId（模拟 adapter 状态陈旧），commit 的 truncated 分支也不得合并
    commit({ before: "A", after: "AX", origin: "source", groupId: p1.groupId });
    const snap = snapshotForTest("m.md")!;
    expect(snap.entries.length).toBe(1);
    expect(snap.entries[0].before).toBe("A");
    expect(snap.entries[0].after).toBe("AX");
    expect(canRedo("m.md")).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════
// ⑤ 场景5/6：恢复现场契约（selection 优先、合并取组起点、滚动锚点数学）
// ═════════════════════════════════════════════════════════════
describe("⑤ 场景5/6：撤销/恢复的现场（光标·选区·滚动锚点）", () => {
  it("连续 typing 合并成一步时，beforeSelection 保留整组起点（撤销回组起点）", () => {
    const clock = fakeClock();
    const adapter = createSourceAdapter({ now: clock.now });
    begin("sel.md", "abc");
    const p1 = adapter.plan({
      before: "abc",
      text: "abcz",
      kind: "typing",
      caret: 4,
      beforeSelection: { start: 3, end: 3, scrollTop: 120 },
      selection: { start: 4, end: 4, scrollTop: 120 },
    })!;
    const p2 = adapter.plan({
      before: "abcz",
      text: "abczy",
      kind: "typing",
      caret: 5,
      beforeSelection: { start: 4, end: 4, scrollTop: 120 },
      selection: { start: 5, end: 5, scrollTop: 120 },
    })!;
    expect(p2.groupId).toBe(p1.groupId);
    expect(p2.beforeSelection).toEqual({ start: 3, end: 3, scrollTop: 120 });

    commit(p1);
    commit(p2);
    const snap = snapshotForTest("sel.md")!;
    expect(snap.entries.length).toBe(1);
    expect(snap.entries[0].beforeSelection).toEqual({ start: 3, end: 3, scrollTop: 120 });

    const h = fakeHost("abczy", "sel.md");
    const coord = makeHistoryCoordinator({ api: documentHistory, host: h.host });
    expect(coord.handleUndo()).toBe(true);
    expect(h.calls.applyText[0].restore).toEqual({ start: 3, end: 3, scrollTop: 120 });
  });

  it("restoreOf 优先级：undo 用 beforeSelection（无则 beforeAnchor），redo 用 after*", () => {
    begin("prio.md", "A");
    commit({
      before: "A",
      after: "AB",
      origin: "source",
      beforeSelection: { start: 1, end: 1 },
      beforeAnchor: { blockIndex: 2, ratioWithinBlock: 0.5 },
      afterSelection: { start: 2, end: 2 },
      afterAnchor: { blockIndex: 3, ratioWithinBlock: 0.25 },
    });
    const h = fakeHost("AB", "prio.md");
    const coord = makeHistoryCoordinator({ api: documentHistory, host: h.host });
    expect(coord.handleUndo()).toBe(true);
    expect(h.calls.applyText[0].restore).toEqual({ start: 1, end: 1 });
    expect(coord.handleRedo()).toBe(true);
    expect(h.calls.applyText[1].restore).toEqual({ start: 2, end: 2 });

    // 只有 anchor 的条目（阅读面历史）：按 anchor 恢复
    begin("prio2.md", "A");
    commit({
      before: "A",
      after: "AB",
      origin: "pm",
      beforeAnchor: { blockIndex: 4, ratioWithinBlock: 0.3 },
      afterAnchor: { blockIndex: 5, ratioWithinBlock: 0.6 },
    });
    const h2 = fakeHost("AB", "prio2.md");
    const coord2 = makeHistoryCoordinator({ api: documentHistory, host: h2.host });
    expect(coord2.handleUndo()).toBe(true);
    expect(h2.calls.applyText[0].restore).toEqual({ blockIndex: 4, ratioWithinBlock: 0.3 });
    expect(coord2.handleRedo()).toBe(true);
    expect(h2.calls.applyText[1].restore).toEqual({ blockIndex: 5, ratioWithinBlock: 0.6 });
  });

  it("阅读面滚动锚点：撤销后文档变短时落在同一内容位置（不落 0 / 不贴底）", () => {
    const blocks = (n: number, h: number): BlockGeometry[] =>
      Array.from({ length: n }, (_, i) => ({
        index: i,
        top: i * h,
        height: h,
        visible: true,
        sourceLine: i,
      }));
    const old = blocks(20, 100); // 撤销前：20 块
    // 视口停在 500（视口中央 650 → 第 6 块中部）
    const anchor = captureContentAnchor(old, 500, 300, { contentHeight: 2000 })!;
    expect(anchor.blockIndex).toBe(6);

    // 撤销把尾部 10 块删掉（内容高 2000 → 1000，可滚动上限 1000-300=700）
    const after = blocks(10, 100);
    const top = restoreContentAnchor(after, anchor, 300, { contentHeight: 1000 });
    expect(top).not.toBeNull();
    expect(top).toBe(500); // 同一内容点（块 6 顶 600 − 视口半高 150 → 450？按区域比例如实计算）
    expect(top!).toBeGreaterThan(0);
    expect(top!).toBeLessThanOrEqual(700); // 不贴底（浏览器钳位后的 max）
  });

  it("锚点无法映射时返回 null（绝不写 0 兜底）；内容不足一屏时 0 才是合法唯一值", () => {
    const make = (n: number, h: number, withLine: boolean): BlockGeometry[] =>
      Array.from({ length: n }, (_, i) => ({
        index: i,
        top: i * h,
        height: h,
        visible: true,
        ...(withLine ? { sourceLine: i } : {}),
      }));
    // 旧几何：20 块 × 100，无 sourceLine（此时唯一映射依据是 blockIndex）
    const old = make(20, 100, false);
    const anchor = captureContentAnchor(old, 500, 300, { contentHeight: 2000 })!;
    expect(anchor.blockIndex).toBe(6);
    expect(anchor.sourceLine).toBeUndefined();
    // 新内容只剩 5 块（仍可滚动：500−300=200），块 6 越界且无 sourceLine 兜底 → null
    expect(restoreContentAnchor(make(5, 100, false), anchor, 300, { contentHeight: 500 })).toBeNull();
    // 首块锚点在「不足一屏」的短内容里是合法 0（唯一位置，不是缺陷性跳顶）
    const firstAnchor = captureContentAnchor(old, 0, 300, { contentHeight: 2000 })!;
    expect(restoreContentAnchor(make(2, 100, true), firstAnchor, 300, { contentHeight: 200 })).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════
// ⑥ 场景7：空文档 / 无 docKey / 多文档隔离
// ═════════════════════════════════════════════════════════════
describe("⑥ 场景7：空文档 / 无 docKey / 多文档时间线互不串档", () => {
  it("空文档：撤销/恢复边界不抛错，首条编辑可正常往返", () => {
    begin("empty.md", "");
    expect(canUndo("empty.md")).toBe(false);
    expect(canRedo("empty.md")).toBe(false);
    expect(undo()).toBeNull();
    expect(redo()).toBeNull();
    expect(commit({ after: "中文\n", origin: "source" })).not.toBeNull();
    expect(undo()!.before).toBe("");
    expect(currentText("empty.md")).toBe("");
    expect(redo()!.after).toBe("中文\n");
  });

  it("多文档：undo/redo 只作用于显式 docKey，另一文档条目与 knownText 不动", () => {
    begin("a.md", "A0");
    commit({ after: "A1", origin: "source" }, "a.md");
    begin("b.md", "B0");
    commit({ after: "B1", origin: "source" }, "b.md");

    expect(peekUndo("a.md")!.before).toBe("A0");
    expect(peekUndo("b.md")!.before).toBe("B0");
    expect(undo("b.md")!.before).toBe("B0");
    expect(currentText("b.md")).toBe("B0");
    expect(currentText("a.md")).toBe("A1"); // a 不受影响
    expect(canUndo("a.md")).toBe(true);
    expect(canRedo("b.md")).toBe(true);
    expectTimelineInvariants("a.md", "A1", "a.md");
    expectTimelineInvariants("b.md", "B0", "b.md");
  });

  it("docKey 为空：协调器不动作、不误弹边界、不动任何时间线", () => {
    const h = fakeHost("A", "");
    begin("real.md", "A");
    commit({ after: "AB", origin: "source" }, "real.md");
    const coord = makeHistoryCoordinator({ api: documentHistory, host: h.host });
    expect(coord.handleUndo()).toBe(false);
    expect(coord.handleRedo()).toBe(false);
    expect(h.calls.applyText.length).toBe(0);
    expect(h.calls.boundary.length).toBe(0); // docKey 空不是「到边界」
    expect(currentText("real.md")).toBe("AB");
  });
});

// ═════════════════════════════════════════════════════════════
// ⑦ 场景8：外部写回各一步 + rebase 失败路径可见
// ═════════════════════════════════════════════════════════════
describe("⑦ 场景8：外部写回（跨文件替换 / 整篇写回）一步且不打坏时间线", () => {
  it("commitWholeText 一次替换 = 恰好一步，可撤销/恢复", () => {
    commitWholeText(documentHistory, "x.md", "cat", "DOG", "cross-file");
    expect(snapshotForTest("x.md")!.entries.length).toBe(1);
    expect(undo("x.md")!.before).toBe("cat");
    expect(redo("x.md")!.after).toBe("DOG");
  });

  it("整篇写回（addToHistory:false 事务 + 显式 commit）只记一步，不重复记步", () => {
    // 复刻 writeBackCurrentDoc 的真实顺序：先 dispatch 排除事务，再显式 commit
    const clock = fakeClock();
    begin("wb.md", "A");
    const h = fakeHost("A", "wb.md");
    const commits: PmCommitPlan[] = [];
    const coord = makeHistoryCoordinator({ api: documentHistory, host: h.host });
    const adapter = createPmAdapter({
      serialize: (doc) => String(doc),
      commit: (plan) => {
        commits.push(plan);
        coord.commitFromPm(plan);
      },
      rebase: (text) => documentHistory.rebaseText("wb.md", text),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    adapter.reset("A");
    // 整篇替换事务：只带 addToHistory:false（不带 historyBridge）
    const excluded = {
      docChanged: true,
      getMeta: (k: string) => (k === "addToHistory" ? false : undefined),
    };
    expect(adapter.handleTransactions(null, [excluded], "B")).toBe("rebase");
    expect(snapshotForTest("wb.md")!.entries.length).toBe(0); // 不产生条目
    clock.advance(2000);
    expect(commits.length).toBe(0);

    // 写回方显式记一步（writeBackCurrentDoc 的 commit）：before 必须是写回前文本
    expect(coord.commitFromSource({ before: "A", after: "B", origin: "replace" })).not.toBeNull();
    expect(snapshotForTest("wb.md")!.entries.length).toBe(1);
    expect(currentText("wb.md")).toBe("B");
    h.setText("B");
    expect(coord.handleUndo()).toBe(true);
    expect(h.getText()).toBe("A");
    expect(coord.handleRedo()).toBe(true);
    expect(h.getText()).toBe("B");
  });

  it("rebaseText 存在 redo 分支时非 force **明确返回 false**（失败可见，不静默改写基线）", () => {
    begin("rb.md", "A");
    commit({ after: "AB", origin: "source" });
    commit({ after: "ABC", origin: "source" });
    undo(); // knownText=AB，redo 分支 = [ABC]
    expect(currentText("rb.md")).toBe("AB");

    // 非 force：拒绝（调用方必须知道失败；否则静默漂移）
    expect(rebaseText("rb.md", "AB-规范化")).toBe(false);
    expect(currentText("rb.md")).toBe("AB"); // 基线没被悄悄改写
    expect(canRedo("rb.md")).toBe(true);

    // force：允许，但代价明确 —— redo 分支被清空
    expect(rebaseText("rb.md", "AB-规范化", { force: true })).toBe(true);
    expect(currentText("rb.md")).toBe("AB-规范化");
    expect(canRedo("rb.md")).toBe(false);
    expect(snapshotForTest("rb.md")!.entries.length).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════
// ⑧ 怀疑 a：pmAdapter 节流队列 ↔ 模式切换 flush ↔ 整篇替换
// ═════════════════════════════════════════════════════════════
describe("⑧ 怀疑 a：flush 与整篇替换之间的丢步窗口", () => {
  function build() {
    const clock = fakeClock();
    const commits: PmCommitPlan[] = [];
    let serialized = "A";
    const adapter = createPmAdapter({
      serialize: () => serialized,
      commit: (plan) => commits.push(plan),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    adapter.reset("A");
    return {
      clock,
      commits,
      adapter,
      setSerialized: (v: string) => {
        serialized = v;
      },
    };
  }

  it("先 flush 再整篇替换：最后一段打字不丢、不重复", () => {
    const { clock, commits, adapter, setSerialized } = build();
    // 阅读面打字（进入 350ms 防抖队列）
    setSerialized("B");
    adapter.handleTransactions(null, [{ docChanged: true, getMeta: () => undefined }], "B");
    expect(adapter.pending()).toBe(true);
    expect(commits.length).toBe(0);

    // 模式切换：先 flush（落一步 A→B）
    expect(adapter.flush()).toBe(true);
    expect(commits).toEqual([{ before: "A", after: "B", origin: "pm" }]);

    // 随后整篇替换事务（模式切换同步 / 翻译整篇回写）：addToHistory:false
    setSerialized("B");
    expect(
      adapter.handleTransactions(
        null,
        [{ docChanged: true, getMeta: (k: string) => (k === "addToHistory" ? false : undefined) }],
        "B",
      ),
    ).toBe("rebase");
    clock.advance(5000);
    expect(commits.length).toBe(1); // 不重复记步
  });

  it("反证：不先 flush 就整篇替换 → 队列被 rebase 清掉，那一步永久丢失（说明现有接线顺序是必需的）", () => {
    const { clock, commits, adapter, setSerialized } = build();
    setSerialized("B");
    adapter.handleTransactions(null, [{ docChanged: true, getMeta: () => undefined }], "B");
    expect(adapter.pending()).toBe(true);
    // 直接整篇替换（没有 flush）
    adapter.handleTransactions(
      null,
      [{ docChanged: true, getMeta: (k: string) => (k === "addToHistory" ? false : undefined) }],
      "B",
    );
    expect(adapter.pending()).toBe(false);
    clock.advance(5000);
    expect(commits.length).toBe(0); // B 这一步没有入库 → 撤销撤不到它
  });
});

// ═════════════════════════════════════════════════════════════
// ⑨ 怀疑 b：commit 被拒是否静默丢步
// ═════════════════════════════════════════════════════════════
describe("⑨ 怀疑 b：协调器 commit 被拒 = 静默丢步？", () => {
  it("否证（主路径）：syncBaseline(force) 后任意 before 失配都能入库，不丢步", () => {
    const cases: Array<{ known: string; before: string }> = [
      { known: "A", before: "A" },
      { known: "A", before: "A-外部改过" },
      { known: "中文\n", before: "中文\n追加" },
      { known: "", before: "x" },
      { known: "long text", before: "" },
    ];
    for (const [i, c] of cases.entries()) {
      __resetDocumentHistoryForTest();
      const key = `b-${i}.md`;
      begin(key, c.known);
      const h = fakeHost(c.before, key);
      const coord = makeHistoryCoordinator({ api: documentHistory, host: h.host });
      const after = `${c.before}!`;
      const entry = coord.commitFromSource({ before: c.before, after, origin: "source" });
      expect(entry, `case ${i}: before=${JSON.stringify(c.before)} 应入库`).not.toBeNull();
      expect(currentText(key)).toBe(after);
      expect(canUndo(key)).toBe(true);
    }
  });

  it("确认（接口缺口）：pmAdapter 的 commit 回调无返回值 → 协调器若拒绝，adapter 仍前移基线 = 静默丢步", () => {
    const clock = fakeClock();
    const commits: PmCommitPlan[] = [];
    let serialized = "B";
    const adapter = createPmAdapter({
      serialize: () => serialized,
      // 生产签名是 void：adapter 无法知道 commit 是否真的入库
      commit: (plan) => {
        commits.push(plan);
        // 模拟协调器拒绝（例如 host.docKey() 为空 → commitFromPm 直接 return null）
        documentHistory.commit({ before: "绝不匹配", after: plan.after, origin: "pm" }, "缺口.md");
      },
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    adapter.reset("A");
    begin("缺口.md", "别处文本");
    adapter.handleTransactions(null, [{ docChanged: true, getMeta: () => undefined }], "B");
    expect(adapter.flush()).toBe(true);
    expect(snapshotForTest("缺口.md")!.entries.length).toBe(0); // 这一步没入库（被拒）

    serialized = "C";
    adapter.handleTransactions(null, [{ docChanged: true, getMeta: () => undefined }], "C");
    expect(adapter.flush()).toBe(true);
    // 第二次提交的 before 已经是 B（基线前移了）→ A→B 这一步永久丢失且无任何提示
    expect(commits.map((p) => p.before)).toEqual(["A", "B"]);
    expect(snapshotForTest("缺口.md")!.entries.length).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════
// ⑩ 怀疑 c：force-rebase 的 truncateRedo 代价
// ═════════════════════════════════════════════════════════════
describe("⑩ 怀疑 c：rebaseText(force) 清 redo 的代价只应出现在「外部改了宿主文本」路径", () => {
  it("撤销后正常打字：全程不调用 rebaseText，redo 由 commit 自身截断", () => {
    const { api, rebase } = spyHistoryApi();
    const h = fakeHost("AB", "c.md");
    begin("c.md", "A");
    commit({ after: "AB", origin: "source" });
    const coord = makeHistoryCoordinator({ api, host: h.host });
    expect(coord.handleUndo()).toBe(true);
    expect(h.getText()).toBe("A");
    h.setText("A"); // 宿主已落地 = 撤销目标

    const entry = coord.commitFromSource({ before: "A", after: "AX", origin: "source" });
    expect(entry).not.toBeNull();
    expect(rebase.length).toBe(0); // 「只是打了个字」不应触发 force-rebase
    expect(canRedo("c.md")).toBe(false); // redo 仍被截断（语义正确）
    expectTimelineInvariants("c.md", "AX", "打字后");
  });

  it("时间线与宿主失配（外部改动）时才 force-rebase，且代价可观察", () => {
    const { api, rebase } = spyHistoryApi();
    begin("c2.md", "A");
    commit({ after: "AB", origin: "source" });
    commit({ after: "ABC", origin: "source" });
    undo(); // knownText = AB，存在 redo 分支
    const h = fakeHost("ABC-外部", "c2.md"); // 宿主被别的路径改成 ABC-外部
    const coord = makeHistoryCoordinator({ api, host: h.host });
    expect(coord.commitFromSource({ before: "ABC-外部", after: "ABC-外部打字", origin: "source" })).not.toBeNull();
    expect(rebase.length).toBe(1);
    expect(rebase[0].force).toBe(true);
    expect(canRedo("c2.md")).toBe(false); // 代价：redo 分支被清（外部改动后位置语义已失效）

    // ⚠️ 已知语义（不是缺陷）：rebase 不产生条目 → 时间线里**没有**记录 AB→ABC-外部 这段
    //    外部改动，因此条目链会出现一次「跳跃」。撤销跨过它时会直接落到上一个已记录状态。
    const snap = snapshotForTest("c2.md")!;
    expect(snap.entries.length).toBe(2);
    expect(snap.entries[0].after).toBe("AB");
    expect(snap.entries[1].before).toBe("ABC-外部"); // 链在此处跳跃（外部改动无条目）
    expect(snap.cursor).toBe(2);
    expect(currentText("c2.md")).toBe("ABC-外部打字");
    expect(undo()!.before).toBe("ABC-外部");
    expect(undo()!.before).toBe("A");
  });
});

// ═════════════════════════════════════════════════════════════
// ⑪ 怀疑 d：bridge 写回不得被记成新编辑
// ═════════════════════════════════════════════════════════════
describe("⑪ 怀疑 d：撤销落地（bridge 事务）不被记成新编辑", () => {
  it("coordinator 全链路：undo/redo 各走一次 bridge 事务，时间线条目数/游标如期变化", () => {
    const clock = fakeClock();
    begin("bridge.md", "A");
    commit({ after: "AB", origin: "pm" });
    let serialized = "AB";
    const adapter = createPmAdapter({
      serialize: () => serialized,
      commit: () => {
        throw new Error("bridge 事务不得触发 commit");
      },
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    adapter.reset("AB");
    let text = "AB";
    const host: HistoryHost = {
      docKey: () => "bridge.md",
      currentText: () => text,
      currentMode: () => "pm",
      applyText: (next, restore, meta) => {
        // 复刻 EditorContainer.applyHistoryText 的 PM 分支：addToHistory:false + historyBridge:true
        expect((meta as { bridge?: boolean }).bridge).toBe(true);
        const tr = {
          docChanged: true,
          getMeta: (k: string) =>
            k === "historyBridge" ? true : k === "addToHistory" ? false : undefined,
        };
        expect(adapter.handleTransactions(null, [tr], next)).toBe("bridge");
        text = next;
        serialized = next;
      },
      notifyBoundary: () => undefined,
    };
    const coord = makeHistoryCoordinator({
      api: documentHistory,
      host,
      flushPending: () => adapter.flush(),
      syncAdapterBaseline: (t) => adapter.setBaseline(t),
    });

    expect(coord.handleUndo()).toBe(true);
    expect(text).toBe("A");
    expect(snapshotForTest("bridge.md")!.entries.length).toBe(1); // 没有多记一步
    expect(snapshotForTest("bridge.md")!.cursor).toBe(0);

    expect(coord.handleRedo()).toBe(true);
    expect(text).toBe("AB");
    expect(snapshotForTest("bridge.md")!.entries.length).toBe(1); // 依然一步
    expect(snapshotForTest("bridge.md")!.cursor).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════
// ⑫ 怀疑 e/f：入口返回值语义
// ═════════════════════════════════════════════════════════════
describe("⑫ 怀疑 f：handleUndo/handleRedo 返回值只在真边界/无效态为 false", () => {
  it("成功 true、边界 false、docKey 空 false；返回值不用于写回", () => {
    begin("f.md", "A");
    commit({ after: "AB", origin: "source" });
    const h = fakeHost("AB", "f.md");
    const coord = makeHistoryCoordinator({ api: documentHistory, host: h.host });
    expect(coord.handleUndo()).toBe(true);
    expect(coord.handleUndo()).toBe(false);
    expect(coord.handleRedo()).toBe(true);
    expect(coord.handleRedo()).toBe(false);
    h.setKey("");
    expect(coord.handleUndo()).toBe(false);
    expect(coord.canUndo()).toBe(false);
    expect(coord.canRedo()).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════
// ⑬ 集成：真实 EditorContainer（跨模式链路，纯逻辑测不到的部分）
// ═════════════════════════════════════════════════════════════

const DOC_KEY = "D:/tmp/audit-cross-mode.md";
const DOC = "# 标题\n\n正文段落，含中文。\n";

function installTauriStub() {
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    metadata: { currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async () => 0,
    unregisterListener: async () => {},
    convertFileSrc: (p: string) => `asset://localhost/${p}`,
    plugins: {},
  };
}
function removeTauriStub() {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

let view: EditorView | null = null;
let notifications: Notification[] = [];

function sourceTextarea(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>("textarea.source-editor");
}

/** 当前可见面的**真实文本**（阅读面必须用序列化结果，textContent 会丢掉换行/标记） */
function currentReal(): string {
  if (useEditorStore.getState().viewMode === "preview") {
    return view ? getMarkdownFromDoc(view.state.doc) : "";
  }
  return sourceTextarea()?.value ?? "";
}

async function waitMs(ms: number) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

function undoOnce() {
  act(() => {
    useEditorStore.getState().undoHandler?.();
  });
}
function redoOnce() {
  act(() => {
    useEditorStore.getState().redoHandler?.();
  });
}

/** 在源码 textarea 当前光标处打字（真实 input 链路 → sourceAdapter → 时间线） */
function typeInSource(text: string) {
  const ta = sourceTextarea();
  if (!ta) throw new Error("找不到源码 textarea");
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? start;
  const next = ta.value.slice(0, start) + text + ta.value.slice(end);
  const caret = start + text.length;
  act(() => {
    setter?.call(ta, next);
    ta.setSelectionRange(caret, caret);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** 在阅读面 PM 末尾打字（真实 dispatch → dispatchTransaction → pmAdapter 节流） */
function typeInPm(text: string) {
  if (!view) throw new Error("view 未就绪");
  act(() => {
    view!.dispatch(view!.state.tr.insertText(text, view!.state.doc.content.size - 1));
  });
}

/** 父组件回传 content（复刻 App：onContentChange → setContent → content prop 变化） */
function Harness({ initial }: { initial: string }) {
  const [content, setContent] = useState(initial);
  return (
    <EditorContainer
      content={content}
      filePath={DOC_KEY}
      forceUpdateKey={1}
      onContentChange={setContent}
      onEditorReady={(v) => {
        view = v;
      }}
    />
  );
}

async function mountEditor(initial = DOC) {
  render(<Harness initial={initial} />);
  await waitMs(60); // onEditorReady 在 rAF 里回调
  expect(view).not.toBeNull();
}

beforeEach(() => {
  localStorage.clear();
  installTauriStub();
  __resetDocumentHistoryForTest();
  notifications = [];
  setNotificationHandler((n) => notifications.push(n));
  view = null;
  act(() => {
    useEditorStore.setState({
      viewMode: "edit",
      splitPreviewOpen: false,
      openTabs: [
        { id: "t1", name: "audit-cross-mode.md", path: DOC_KEY, content: DOC, isDirty: false } as never,
      ],
      activeTabIdx: 0,
    });
  });
});

afterEach(() => {
  cleanup();
  setNotificationHandler(null);
  removeTauriStub();
  document.body.innerHTML = "";
  view = null;
});

describe("⑬ 集成：PM 文本往返恒等（逐字节断言的前提）", () => {
  it("markdownToDoc → getMarkdownFromDoc 对本文档样本恒等", () => {
    const samples = [
      DOC,
      "# 标题\n\n正文段落，含中文。A\n",
      "第一行\n\n第二段中文😀",
      "> 引用\n\n普通段落\n",
    ];
    for (const s of samples) {
      expect(getMarkdownFromDoc(markdownToDoc(s)), `往返非恒等：${JSON.stringify(s)}`).toBe(s);
    }
  });
});

describe("⑬ 集成：场景1 阅读面连续打字 → 撤销×N → 恢复×N 逐字节", () => {
  it("3 步（防抖窗口各自落地）逐字节往返", async () => {
    act(() => {
      useEditorStore.setState({ viewMode: "preview" });
    });
    await mountEditor();
    const seq: string[] = [currentReal()];
    for (const chunk of ["甲", "乙\n", "丙😀"]) {
      typeInPm(chunk);
      await waitMs(460); // > DEBOUNCE_MS(350)，让每一步各自落地
      seq.push(currentReal());
    }
    expect(DEBOUNCE_MS).toBeLessThan(460);
    // 时间线里应有 3 步（不多不少）
    expect(snapshotForTest(DOC_KEY)!.entries.length).toBe(3);

    for (let i = seq.length - 2; i >= 0; i--) {
      undoOnce();
      expect(currentReal(), `撤销到第 ${i} 步应逐字节一致`).toBe(seq[i]);
    }
    for (let i = 1; i < seq.length; i++) {
      redoOnce();
      expect(currentReal(), `恢复到第 ${i} 步应逐字节一致`).toBe(seq[i]);
    }
  });
});

describe("⑬ 集成：场景1 补充 —— 防抖窗口内的快速连打只能算「一步」", () => {
  it("阅读面快速连打 3 次（未过防抖）→ 立即撤销：先 flush 成一步，再整步撤掉（逐字节）", async () => {
    act(() => {
      useEditorStore.setState({ viewMode: "preview" });
    });
    await mountEditor();
    const t0 = currentReal();
    typeInPm("甲");
    typeInPm("乙");
    typeInPm("丙");
    const t1 = currentReal();
    expect(t1).not.toBe(t0);
    expect(snapshotForTest(DOC_KEY)!.entries.length).toBe(0); // 还没到 350ms，队列未落地

    undoOnce(); // 协调器先 flush（落一步）再撤 → 必须回到 t0
    expect(currentReal()).toBe(t0);
    redoOnce();
    expect(currentReal()).toBe(t1);
    undoOnce();
    expect(currentReal()).toBe(t0);
  });
});

describe("⑬ 集成：场景3 补充 —— 编辑面撤到底同样只提示一次", () => {
  it("编辑模式：一次边界按键 = 一条提示，之后 redo 仍可回到编辑后", async () => {
    await mountEditor();
    const t0 = currentReal();
    typeInSource("X");
    const t1 = currentReal();
    undoOnce();
    expect(currentReal()).toBe(t0);
    undoOnce(); // 边界
    const msgs = notifications.filter((n) => n.message.includes("边界"));
    expect(msgs.length, `一次边界按键应恰好一条提示，实际 ${msgs.length}`).toBe(1);
    redoOnce();
    expect(currentReal()).toBe(t1);
  });
});

describe("⑬ 集成：场景2 编辑打字 → 阅读打字 → 撤销×2 的顺序", () => {
  it("先撤阅读那步，再撤编辑那步；恢复按原顺序回顶", async () => {
    await mountEditor();
    const t0 = currentReal();
    typeInSource("编辑");
    const tSource = currentReal();
    act(() => {
      useEditorStore.setState({ viewMode: "preview" });
    });
    const tSwitch = currentReal();
    typeInPm("阅读");
    await waitMs(460);
    const tPm = currentReal();
    expect(tPm).not.toBe(tSwitch);

    undoOnce();
    expect(currentReal()).toBe(tSwitch); // 先撤阅读那步
    undoOnce();
    expect(currentReal()).toBe(t0); // 再撤编辑那步（回到最初文本）
    redoOnce();
    expect(currentReal()).toBe(tSwitch);
    redoOnce();
    expect(currentReal()).toBe(tPm);
    void tSource;
  });
});

describe("⑬ 集成：场景3 阅读面撤到底：提示只弹一次且之后仍可恢复", () => {
  it("一次边界按键恰好一条提示；redo 仍可回到编辑后", async () => {
    act(() => {
      useEditorStore.setState({ viewMode: "preview" });
    });
    await mountEditor();
    const t0 = currentReal();
    typeInPm("X");
    await waitMs(460);
    const t1 = currentReal();

    undoOnce();
    expect(currentReal()).toBe(t0);
    // 再按一次（边界）：只弹一条
    undoOnce();
    const boundaryMsgs = notifications.filter((n) => n.message.includes("边界"));
    expect(boundaryMsgs.length, `边界提示应恰好 1 条，实际 ${boundaryMsgs.length}`).toBe(1);

    redoOnce();
    expect(currentReal()).toBe(t1); // 边界之后恢复仍可用
  });
});

describe("⑬ 集成：场景4 阅读面撤销后再输入，redo 不得吐回「未来」内容", () => {
  it("redo 后文本仍是新输入的内容（redo 分支被截断）", async () => {
    act(() => {
      useEditorStore.setState({ viewMode: "preview" });
    });
    await mountEditor();
    const t0 = currentReal();
    typeInPm("X");
    await waitMs(460);
    undoOnce();
    expect(currentReal()).toBe(t0);

    typeInPm("Y");
    const tY = currentReal();
    expect(tY).toContain("Y");
    redoOnce(); // 先 flush 新输入（截断 redo），再 peekRedo → 空
    expect(currentReal()).toBe(tY);
    expect(canRedo(DOC_KEY)).toBe(false);
    void t0;
  });
});

describe("⑬ 集成：场景5 源码撤销后的光标位置（含 App 回传 content 的二次受控提交）", () => {
  it("撤销后光标回到编辑前位置，不被复位到文首", async () => {
    await mountEditor();
    const ta = sourceTextarea()!;
    const mid = Math.floor(ta.value.length / 2);
    act(() => {
      ta.focus();
      ta.setSelectionRange(mid, mid);
    });
    typeInSource("ZZZ");
    undoOnce();
    await waitMs(340); // 覆盖 250ms 选区保护窗 + 二次受控提交
    expect(Math.abs(ta.selectionStart - mid)).toBeLessThanOrEqual(1);
  });

  it("阅读面撤销后选区不跳到文首（PM 整篇 replaceWith 后仍在文档中段）", async () => {
    act(() => {
      useEditorStore.setState({ viewMode: "preview" });
    });
    await mountEditor();
    typeInPm("X");
    await waitMs(460);
    undoOnce();
    expect(view).not.toBeNull();
    const from = view!.state.selection.from;
    const size = view!.state.doc.content.size;
    expect(from, "撤销后选区不得落到文首(1)").toBeGreaterThan(1);
    expect(from).toBeLessThanOrEqual(size);
  });
});

describe("⑬ 集成：再审计缺陷回归 —— 撤销后立即输入，光标不被滞后定时器抢回", () => {
  /**
   * 再审计实测缺陷（怀疑清单 e 确认项）：撤销后 60ms 内开始打字，字符插对了，但
   * `applyHistoryText` 里排下的 `rAF / setTimeout(…, 60)` 兜底会在 250ms 后把光标
   * **拽回撤销时的位置**（实测 selectionStart 8 → 9 → 8），用户下一个字符就插错位置。
   * 修法是"输入即作废"的代际 token（`sourceSelectionRestoreTokenRef`）；本用例锁住它。
   */
  it("undo → 立刻键入 Q：280ms 后光标仍在 Q 之后（保护窗 + 兜底定时器都不得抢光标）", async () => {
    await mountEditor();
    const ta = sourceTextarea()!;
    const mid = Math.floor(ta.value.length / 2);
    act(() => {
      ta.focus();
      ta.setSelectionRange(mid, mid);
    });
    typeInSource("ZZZ");
    undoOnce();
    const posAfterUndo = ta.selectionStart;
    expect(Math.abs(posAfterUndo - mid)).toBeLessThanOrEqual(1);

    typeInSource("Q"); // 撤销后立刻输入
    const posAfterType = ta.selectionStart;
    expect(posAfterType).toBe(posAfterUndo + 1);

    await waitMs(280); // 覆盖 rAF + 60ms 兜底 + 250ms 选区保护窗
    expect(ta.selectionStart, "撤销的滞后定时器不得把光标抢回撤销位置").toBe(posAfterType);
    expect(ta.value).toContain("Q");
  });
});

describe("⑬ 集成：场景9 撤销后切走再切回，时间线与基线不漂", () => {
  it("撤销 → 阅读 → 编辑 → 恢复：文本精确回顶；再撤销仍可用", async () => {
    await mountEditor();
    const t0 = currentReal();
    typeInSource("AAA");
    const t1 = currentReal();
    expect(t1).not.toBe(t0);

    undoOnce();
    expect(currentReal()).toBe(t0);

    act(() => {
      useEditorStore.setState({ viewMode: "preview" });
    });
    act(() => {
      useEditorStore.setState({ viewMode: "edit" });
    });
    // 两次模式切换后时间线基线不得漂移（host 文本 === knownText）
    expect(currentText(DOC_KEY)).toBe(t0);

    redoOnce();
    expect(currentReal()).toBe(t1);
    undoOnce();
    expect(currentReal()).toBe(t0);
  });
});

describe("⑬ 集成：行为变更锁 —— 源码通道「外部写回」必须进统一时间线（Lead 已落地）", () => {
  /**
   * 再审计发现 2 的收口：翻译回写 / AI 润色的源码分支、AI 续写·摘要「插入光标处」、
   * AI 对话「插入光标处」「替换选区」、AI 续写 ghost 的 Tab 采纳 —— 共 6 处，
   * 过去只 `setSourceContent`（不进时间线：撤不回 + 下次打字 force-rebase 静默清 redo），
   * 现在都必须调用 `recordDiscreteSourceEdit(...)`。
   *
   * 为什么用源码契约断言而不是行为用例：这些入口依赖 translate/AI store + 服务层，
   * jsdom 里驱动成本高且易 flaky；本仓已有同类做法（见 v0140-undo-entry-routing.test.ts）。
   * 断言只锁「写回点附近必须有记录调用」与 5 参 `afterCaret` 的存在，不锁行号。
   */
  it("6 处外部写回点附近都存在 recordDiscreteSourceEdit 调用，且支持 afterCaret（重做落点）", () => {
    const src = readFileSync(
      path.join(__dirname, "..", "components/editor/EditorContainer.tsx"),
      "utf8",
    );
    const occurrences = (needle: string): number[] => {
      const out: number[] = [];
      let i = src.indexOf(needle);
      while (i >= 0) {
        out.push(i);
        i = src.indexOf(needle, i + 1);
      }
      return out;
    };
    const sites: Array<{ name: string; anchor: string; window: number }> = [
      {
        name: "翻译回写（源码通道）",
        anchor: "buildSourceRewrite(sourceContentRef.current, ctx.start, ctx.end, translated, mode)",
        window: 1600,
      },
      {
        name: "AI 润色（源码通道）",
        anchor: 'buildSourceRewrite(sourceContentRef.current, ctx.start, ctx.end, text, "replace")',
        window: 1600,
      },
      {
        // 该形态在「AI 续写/摘要插入光标处」与「AI 对话插入光标处」各出现一次
        name: "AI 续写/摘要·对话插入光标处（源码通道）",
        anchor: "const newContent = content.slice(0, pos) + text + content.slice(pos);",
        window: 1400,
      },
      {
        name: "AI 对话替换选区（源码通道）",
        anchor: 'buildSourceRewrite(sourceContentRef.current, ctx.srcStart, ctx.srcEnd, text, "replace")',
        window: 1600,
      },
      {
        name: "AI 续写 ghost 的 Tab 采纳",
        anchor: "const newContent = textarea.value.slice(0, pos) + ghost + textarea.value.slice(pos);",
        window: 1400,
      },
    ];
    for (const site of sites) {
      const idxs = occurrences(site.anchor);
      expect(idxs.length, `${site.name}：锚点未找到（源码结构变了，请更新本契约断言）`).toBeGreaterThan(0);
      for (const i of idxs) {
        expect(
          src.slice(i, i + site.window).includes("recordDiscreteSourceEdit("),
          `${site.name}：写回路径缺少 recordDiscreteSourceEdit（外部写回必须进统一时间线）`,
        ).toBe(true);
      }
    }
    expect(src.includes("afterCaret?: number"), "recordDiscreteSourceEdit 应支持 afterCaret（重做落点）").toBe(true);
  });
});

describe("⑬ 集成：场景7 空文档撤销/恢复", () => {
  it("空文档：打字 → 撤销回到空 → 恢复 → 再撤销到边界只提示一次", async () => {
    await mountEditor("");
    expect(currentReal()).toBe("");
    typeInSource("空");
    const t1 = currentReal();
    expect(t1).toBe("空");
    undoOnce();
    expect(currentReal()).toBe("");
    redoOnce();
    expect(currentReal()).toBe(t1);
    undoOnce();
    expect(currentReal()).toBe("");
    undoOnce(); // 边界
    const msgs = notifications.filter((n) => n.message.includes("边界"));
    expect(msgs.length).toBe(1);
  });
});
