// @vitest-environment jsdom
/**
 * v0.15.3 返修（缺陷 A）—— 跨模式撤销时**源码面滚动恢复**的锚点链路。
 *
 * ## 本文件锁三件事（都用「纯逻辑 + 假宿主」，**不渲染真 EditorContainer**）
 * ① **BUG-A 的前提**：阅读模式（ProseMirror）产生的条目，coordinator 传给宿主的
 *    `restore` 是 **undefined**（PM 侧 `beforeSelection` 从未接线）；源码条目才是
 *    `{start,end,scrollTop}`。若这一条不成立，"撤销贴底"的成因分析就是错的。
 * ② **决策函数** `decideSourceScrollRestore`：锚点优先 / 同长度才允许像素 / 否则 none
 *    （**绝不返回 0** —— 那是"丢进度"的老 bug，v0.14.0 需求2 P1）。
 * ③ **目标文本变短后 offset 被 clamp**：`remapOffsetAcrossTextChange` 的返回值必须
 *    ≤ `toText.length`，否则 `restoreTextAnchor` 会因为越界**直接放弃恢复**（= 贴底复现）。
 *
 * ## 为什么不渲染真 EditorContainer
 * 真实挂载需要 mock 一大票 Tauri API（`__TAURI_INTERNALS__`、插件 fs/dialog/sql）、
 * store 初值、iframe 与 ProseMirror 布局；jsdom 里 `scrollHeight`/`clientHeight` 恒为 0，
 * 任何"滚动是否贴底"的断言都会变成**假绿灯**（`captureTextAnchor` 因不足一屏直接返回
 * null，测试却"通过"）。因此与既有 `src/__tests__/v0151-cross-mode-undo-audit.test.tsx`
 * 同款做法：用假宿主记录 `applyText` 的 `restore` 参数，把**决策与坐标变换**锁在纯逻辑层。
 * 真实几何由 Lead 在打包产物上用探针验证（`scripts/v0153-probe-undo-big.mjs`）。
 *
 * ## 签名偏差说明（纪律要求）
 * 任务书假设的 `decideSourceScrollRestore({ textLengthChanged, anchor, pixelScrollTop })`
 * 与实现 `src/utils/textOffsetRemap.ts` **一致**（实现的入参对 anchor/pixelScrollTop 多允许
 * `| null | undefined`，比假设更宽）；`remapOffsetAcrossTextChange(offset, fromText, toText)`
 * 亦完全一致。**未发现签名偏差**，本文件按实现签名书写。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import {
  __resetDocumentHistoryForTest,
  begin,
  commit,
  documentHistory,
  snapshotForTest,
} from "../services/documentHistory";
import {
  makeHistoryCoordinator,
  type HistoryHost,
  type RestoreTarget,
} from "../editorHistory/coordinator";
import { createPmAdapter, type PmCommitPlan } from "../editorHistory/pmAdapter";
import { createSourceAdapter } from "../editorHistory/sourceAdapter";
import {
  decideSourceScrollRestore,
  remapOffsetAcrossTextChange,
  type SourceScrollRestoreDecision,
} from "../utils/textOffsetRemap";

/** 假宿主：记录 applyText 的 restore / meta，文本可变（复刻 coordinator 的落地契约） */
function fakeHost(initial: string, docKey = "v0153-doc.md") {
  const calls: {
    applyText: Array<{ text: string; restore: RestoreTarget | undefined; meta: unknown }>;
    boundary: string[];
    afterApply: Array<{ text: string; direction: "undo" | "redo" }>;
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
    getText: () => text,
    setText: (v: string) => {
      text = v;
    },
  };
}

/** 可控时钟（pmAdapter 的 350/900ms 防抖窗口在单测里精确可复现，不 sleep） */
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
    clearTimer(handle: unknown) {
      const i = queue.findIndex((q) => q.id === handle);
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
    pending: () => queue.length,
  };
}

beforeEach(() => {
  __resetDocumentHistoryForTest();
});

afterEach(() => {
  cleanup();
});

// ═════════════════════════════════════════════════════════════
// ① BUG-A 的前提：PM 条目的 restore 必须是 undefined
// ═════════════════════════════════════════════════════════════
describe("① BUG-A 前提：阅读模式条目没有 beforeSelection → coordinator 传 undefined", () => {
  it("pm 条目：restore 是 undefined（源码分支的恢复滚动代码整段不执行）", () => {
    // 这是一切分析的地基：`EditorContainer.applyHistoryText` 的源码分支里
    // `const sel = restore as {...} | undefined; if (sel) { ...恢复滚动... }`。
    // PM 条目没有 beforeSelection（`pmAdapter` 的 buildAnchor 至今没接线），
    // 所以 coordinator 的 restoreOf() 返回 undefined → **完全没有滚动恢复**。
    begin("bug-a.md", "初始\n");
    const entry = commit({ before: "初始\n", after: "初始\nPM 追加", origin: "pm" }, "bug-a.md");
    expect(entry).not.toBeNull();
    expect(entry!.origin).toBe("pm");
    expect(entry!.beforeSelection).toBeUndefined(); // 前提：PM 条目无像素/选区现场
    expect(entry!.beforeAnchor).toBeUndefined(); // 且连内容锚也没有（PM 侧未接线）

    const h = fakeHost("初始\nPM 追加", "bug-a.md");
    const coord = makeHistoryCoordinator({ api: documentHistory, host: h.host });
    expect(coord.handleUndo()).toBe(true);
    expect(h.getText()).toBe("初始\n"); // 文本确实回退了
    // 关键断言：restore 是 undefined → 宿主的源码分支无从恢复滚动
    expect(h.calls.applyText[0].restore).toBeUndefined();
    // 落脚 meta 仍必须是 bridge（否则撤销动作会被记成新编辑）
    expect((h.calls.applyText[0].meta as { bridge?: boolean }).bridge).toBe(true);
  });

  it("source 条目：restore 是 {start,end,scrollTop}（与 PM 条目形成对照）", () => {
    // 源码条目的现场由 sourceAdapter 从 textarea 采（含 scrollTop 像素）。
    // 这条断言同时锁住"像素快路径"的**唯一**可用来源：只有源码条目带它。
    begin("src-mb.md", "A");
    const h = fakeHost("A", "src-mb.md");
    const coord = makeHistoryCoordinator({ api: documentHistory, host: h.host });
    expect(
      coord.commitFromSource({
        before: "A",
        after: "AB",
        origin: "source",
        groupId: "src-typing-1",
        beforeSelection: { start: 1, end: 1, scrollTop: 21531 },
        afterSelection: { start: 2, end: 2, scrollTop: 21531 },
      }),
    ).not.toBeNull();

    h.setText("AB");
    expect(coord.handleUndo()).toBe(true);
    expect(h.getText()).toBe("A");
    expect(h.calls.applyText[0].restore).toEqual({ start: 1, end: 1, scrollTop: 21531 });
  });

  it("sourceAdapter 的真实 plan：beforeSelection 一路透传到时间线与 restore", () => {
    // 用真实 adapter（而非手写 plan）再证一次：这是对 ② 的"像素来源"更强的前提锁定。
    const clock = fakeClock();
    const adapter = createSourceAdapter({ now: clock.now });
    begin("src-adapter.md", "A");
    const plan = adapter.plan({
      before: "A",
      text: "AB",
      kind: "typing",
      caret: 2,
      beforeSelection: { start: 1, end: 1, scrollTop: 1200 },
      selection: { start: 2, end: 2, scrollTop: 1200 },
    });
    expect(plan, "typing 变化必须产生 plan").not.toBeNull();
    expect(plan!.beforeSelection).toEqual({ start: 1, end: 1, scrollTop: 1200 });

    const h = fakeHost("A", "src-adapter.md");
    const coord = makeHistoryCoordinator({ api: documentHistory, host: h.host });
    expect(coord.commitFromSource(plan!)).not.toBeNull();
    h.setText("AB");
    expect(coord.handleUndo()).toBe(true);
    expect(h.calls.applyText[0].restore).toEqual({ start: 1, end: 1, scrollTop: 1200 });
  });

  it("跨模式时间线（source → pm）：只有 source 条目带 restore，PM 条目不带", () => {
    // 真实用户路径：源码打一步 → 切阅读打一步 → 切回源码撤销。
    // 撤销栈顶那条是 PM 条目 → restore undefined → 贴底缺陷（BUG-A）。
    const clock = fakeClock();
    begin("cross.md", "L0");
    const h = fakeHost("L0", "cross.md");
    let pmAdapter!: ReturnType<typeof createPmAdapter>;
    const coord = makeHistoryCoordinator({
      api: documentHistory,
      host: h.host,
      flushPending: () => pmAdapter.flush(),
      syncAdapterBaseline: (t) => pmAdapter.setBaseline(t),
    });
    pmAdapter = createPmAdapter({
      serialize: (doc) => String(doc),
      commit: (plan: PmCommitPlan) => coord.commitFromPm(plan),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    pmAdapter.reset("L0");

    // ① 源码面打一步（带 scrollTop 现场）
    expect(
      coord.commitFromSource({
        before: "L0",
        after: "L0-src",
        origin: "source",
        beforeSelection: { start: 0, end: 0, scrollTop: 1200 },
      }),
    ).not.toBeNull();
    h.setText("L0-src");

    // ② 切到阅读面：flush（空队列）+ 整篇替换事务（rebase，不产生条目）
    pmAdapter.flush();
    expect(
      pmAdapter.handleTransactions(
        null,
        [{ docChanged: true, getMeta: (k: string) => (k === "addToHistory" ? false : undefined) }],
        "L0-src",
      ),
    ).toBe("rebase");

    // ③ 阅读面打一步（无 beforeSelection，这是 PM 条目的固有形状）
    pmAdapter.handleTransactions(null, [{ docChanged: true, getMeta: () => undefined }], "L0-src-pm");
    expect(pmAdapter.flush()).toBe(true);
    h.setText("L0-src-pm");
    expect(snapshotForTest("cross.md")!.entries.length).toBe(2);

    // ④ 撤销栈顶（PM 条目）→ restore undefined（BUG-A 现场）
    expect(coord.handleUndo()).toBe(true);
    expect(h.getText()).toBe("L0-src");
    expect(h.calls.applyText[0].restore).toBeUndefined();

    // ⑤ 再撤一步（源码条目）→ 这次有像素现场
    expect(coord.handleUndo()).toBe(true);
    expect(h.getText()).toBe("L0");
    expect(h.calls.applyText[1].restore).toEqual({ start: 0, end: 0, scrollTop: 1200 });

    // ⑥ 恢复回顶：PM 条目 redo 后仍无现场（对称）
    expect(coord.handleRedo()).toBe(true);
    expect(h.getText()).toBe("L0-src");
    expect(h.calls.applyText[2].restore).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════
// ② 决策函数：锚点优先 / 同长度才允许像素 / 否则 none
// ═════════════════════════════════════════════════════════════
describe("② decideSourceScrollRestore：锚点优先、像素只做同长度快路径、绝不返回 0", () => {
  it("anchor 存在 → 永远 kind=anchor（即使长度变了、即使有历史像素）", () => {
    // 字符偏移与「排版 / 字号 / 软换行 / 文档长度」全都无关，是唯一可靠的锚。
    // 优先级不能被像素抢走：像素在变长/变短的文本上会指向完全不同的内容。
    const d = decideSourceScrollRestore({
      textLengthChanged: true,
      anchor: { offset: 1234, viewportY: 40 },
      pixelScrollTop: 21531,
    });
    expect(d.kind).toBe("anchor");
    expect((d as { anchor: { offset: number; viewportY: number } }).anchor).toEqual({
      offset: 1234,
      viewportY: 40,
    });
  });

  it("anchor 存在且长度未变 → 仍是 anchor（像素不得抢优先级）", () => {
    // 长度没变时像素也"可信"，但锚点更精确（像素会因软换行重排而指向别的内容）。
    const d = decideSourceScrollRestore({
      textLengthChanged: false,
      anchor: { offset: 10, viewportY: 2 },
      pixelScrollTop: 99,
    });
    expect(d.kind).toBe("anchor");
    expect(d).not.toEqual({ kind: "pixel", scrollTop: 99 });
  });

  it("anchor 为 null + 长度未变 + 像素非 null → kind=pixel（等长替换的快路径）", () => {
    // 等长替换（例如同长度重命名）时像素语义等价，且能保住字节级的滚动位置。
    const d = decideSourceScrollRestore({
      textLengthChanged: false,
      anchor: null,
      pixelScrollTop: 21531,
    });
    expect(d).toEqual({ kind: "pixel", scrollTop: 21531 });
  });

  it("anchor 为 null + **长度变了** + 像素非 null → kind=none（像素已失效，必须放弃）", () => {
    // 这是 BUG-A 的核心判断：文本变短后同一像素指向别处，**不能**用它。
    // 放弃（none）比写错位置好：写错位置就是用户看到的贴底/跳走。
    const d = decideSourceScrollRestore({
      textLengthChanged: true,
      anchor: null,
      pixelScrollTop: 21112,
    });
    expect(d).toEqual({ kind: "none" });
  });

  it("全部缺失（无锚、无像素）→ none，且绝不是 pixel/0（写 0 = 跳回顶部老 bug）", () => {
    // 老 bug（v0.14.0 需求2 P1）是 `newTop ?? 0` —— 恢复失败就写 0 = 文档跳回顶部。
    // 这里用否定式断言把"写 0 兜底"钉死：既不是 pixel，也不能是 anchor 到 0。
    const d = decideSourceScrollRestore({
      textLengthChanged: true,
      anchor: null,
      pixelScrollTop: null,
    });
    expect(d.kind).toBe("none");
    expect(d).not.toEqual({ kind: "pixel", scrollTop: 0 });
  });

  it("像素值为 0 本身是合法快路径（0 只因「缺失」才禁止，不因「等于 0」被误判）", () => {
    // 区分"用户就在顶部"(合法 0) 与"恢复失败兜底 0"(缺陷)：判据是**长度是否变化** +
    // **像素是否真的存在**（null 才算缺失）。这条防止有人用 `if (pixelScrollTop)` 误判。
    const d = decideSourceScrollRestore({
      textLengthChanged: false,
      anchor: null,
      pixelScrollTop: 0,
    });
    expect(d).toEqual({ kind: "pixel", scrollTop: 0 });
  });

  it("anchor 的坐标非有限数（NaN）→ 视为不可用，退到像素分支（不把 NaN 交给 scrollTop）", () => {
    // `measureOffsetViewportY` 失败时会返回 null（focus-paragraph 的兼容行为）。
    // 把 NaN 传进 restoreTextAnchor 会让整次写入被浏览器忽略 → 静默丢恢复。
    const d = decideSourceScrollRestore({
      textLengthChanged: false,
      anchor: { offset: Number.NaN, viewportY: 5 },
      pixelScrollTop: 777,
    });
    expect(d).toEqual({ kind: "pixel", scrollTop: 777 });
  });

  it("undefined 与 null 等价（宿主传 undefined 时不得走进 anchor 分支）", () => {
    const d = decideSourceScrollRestore({
      textLengthChanged: true,
      anchor: undefined,
      pixelScrollTop: undefined,
    });
    expect(d).toEqual({ kind: "none" });
  });

  it("决策是纯函数：同样输入重复调用返回相等结果，且不修改入参", () => {
    // 实现里 rAF/60ms/160ms 三段校正会**重复应用**同一计划 → 必须幂等。
    const anchor = { offset: 5, viewportY: 3 };
    const args = { textLengthChanged: true, anchor, pixelScrollTop: 100 };
    expect(decideSourceScrollRestore(args)).toEqual(decideSourceScrollRestore(args));
    expect(anchor).toEqual({ offset: 5, viewportY: 3 }); // 未被实现"顺便 normalize"改写
  });

  it("决策结果可直接驱动恢复动作：none 分支必须原样不动（不写 0）", () => {
    // 用类型收窄模拟宿主的三支落地，锁住"none 分支不写任何值"（防有人给 none 加兜底 0）。
    const land = (plan: SourceScrollRestoreDecision, before: number): number => {
      if (plan.kind === "anchor") return before; // 锚点分支由 restoreTextAnchor 改 scrollTop
      if (plan.kind === "pixel") return plan.scrollTop;
      return before; // none：原样不动（**不写 0**）
    };
    const nonePlan = decideSourceScrollRestore({
      textLengthChanged: true,
      anchor: null,
      pixelScrollTop: 5000,
    });
    expect(land(nonePlan, 21531)).toBe(21531); // 保持原位，不被写成 0
    const pixelPlan = decideSourceScrollRestore({
      textLengthChanged: false,
      anchor: null,
      pixelScrollTop: 5000,
    });
    expect(land(pixelPlan, 21531)).toBe(5000);
  });
});

// ═════════════════════════════════════════════════════════════
// ③ 变短文本的 clamp：remap 结果不得越界
// ═════════════════════════════════════════════════════════════
describe("③ 目标文本变短后 anchor.offset 被 clamp（restoreTextAnchor 的前置条件）", () => {
  it("撤销删掉尾部一大段：offset 落在被删区 → 得到 ≤ toText.length 的合法偏移", () => {
    // 实机形态：长文档撤销后文本变短（探针 21948px → 21113px）。
    // 若 remap 返回越界值，`restoreTextAnchor` 里 `anchor.offset >= text.length` 会
    // **直接 return** → 一行都不恢复 = 贴底。这条锁住"永远给得出合法偏移"。
    const from = "A".repeat(9000);
    const to = "A".repeat(8000);
    const mapped = remapOffsetAcrossTextChange(8500, from, to);
    expect(mapped).toBeLessThanOrEqual(to.length);
    expect(mapped).toBeGreaterThanOrEqual(0);
    // "AAAA…" 前后缀全重叠的特殊形状：P 会夹到 min(from,to)，故贴到 8000（= 末尾）
    expect(mapped).toBe(8000);
  });

  it("真实缺陷形状（撤销前后文本长度不同）：任意锚点都落进新文本范围", () => {
    // 用探针里的真实数字造型：长文档删掉末段后，历史像素 21531 已无意义，
    // 但内容锚的 offset 必须还能落到新文本范围里（否则恢复不了）。
    const from = `# 标题\n\n${"正文行\n".repeat(1200)}`;
    const to = `# 标题\n\n${"正文行\n".repeat(1100)}`; // 少 100 行
    expect(from.length).toBeGreaterThan(to.length);
    for (const offset of [0, 10, 3000, to.length, from.length - 1, from.length]) {
      const mapped = remapOffsetAcrossTextChange(offset, from, to);
      expect(mapped, `offset=${offset} 不得越界`).toBeLessThanOrEqual(to.length);
      expect(mapped, `offset=${offset} 不得为负`).toBeGreaterThanOrEqual(0);
    }
  });

  it("fromText 极长 / toText 极短：收敛到 toText 范围内（含空串）", () => {
    // 极端场景：撤销把整篇内容清空（before 为空 / 只留一行标题）。
    // 空串时唯一合法值是 0 —— 这是"内容不足一屏"的合法 0，不是缺陷兜底 0。
    const from = "x".repeat(10000);
    for (const to of ["", "ab", "x"]) {
      for (const offset of [0, 5000, 10000, 12000]) {
        const mapped = remapOffsetAcrossTextChange(offset, from, to);
        expect(mapped, `to=${JSON.stringify(to)} offset=${offset}`).toBeLessThanOrEqual(to.length);
      }
    }
  });

  it("base64 文档（真实内容 230 字符 ↔ 展示 mask 19 字符）：两向映射都不越界", () => {
    // 时间线存真实内容，textarea 展示 mask 后的短标记：两个文本空间长度差极大，
    // 这段映射必须两边都给出合法偏移（否则含图片的文档撤销就恢复不了滚动）。
    const real = "![img](data:image/png;base64," + "A".repeat(200) + ")";
    const masked = "![img](image-1.png)";
    expect(real.length).toBe(230);
    expect(masked.length).toBe(19);
    for (const offset of [0, 7, 27, 100, 229, 230]) {
      const m1 = remapOffsetAcrossTextChange(offset, real, masked);
      expect(m1).toBeLessThanOrEqual(masked.length);
      const m2 = remapOffsetAcrossTextChange(m1, masked, real);
      expect(m2).toBeLessThanOrEqual(real.length);
    }
  });
});

// ═════════════════════════════════════════════════════════════
// ④ 组合链路：把 ①~③ 串成"撤销一次"的完整决策
// ═════════════════════════════════════════════════════════════
describe("④ 组合链路：撤销一次时宿主应得到的滚动恢复参数（纯逻辑推演）", () => {
  it("PM 条目 + 视口中央锚点 → 决策为 anchor，offset 已按目标文本重映射", () => {
    // 复刻 `applyHistoryText` 源码分支的计算顺序：
    //   写入前 captureTextAnchor → beforeText/masked 长度差 → remap → decide → restore。
    // 这里只推演纯函数部分（真实测量由 Lead 的探针在打包产物上验证）。
    const beforeText = "A".repeat(600) + "B".repeat(100);
    const afterText = "A".repeat(600); // 撤销删掉尾部 100 字符（文本变短）
    const histAnchor = { offset: 550, viewportY: 200 }; // 视口中央落在"A"段中部
    const plan = decideSourceScrollRestore({
      textLengthChanged: afterText.length !== beforeText.length,
      anchor: {
        offset: remapOffsetAcrossTextChange(histAnchor.offset, beforeText, afterText),
        viewportY: histAnchor.viewportY,
      },
      pixelScrollTop: null, // PM 条目没有像素（① 已证）
    });
    expect(plan.kind).toBe("anchor");
    expect((plan as { anchor: { offset: number; viewportY: number } }).anchor.offset).toBe(550);
    expect((plan as { anchor: { offset: number; viewportY: number } }).anchor.viewportY).toBe(200);
  });

  it("视口中央落在被删除的尾部 → 映射到变更区间起点：不贴底也不跳顶", () => {
    // 用户原来看到的是"将被删掉的那段"（offset 落在删除区）。
    // 语义上只能贴到变更起点（那里是仍存在的内容的末端）—— 既不是 0（跳顶），
    // 也不是新 max（贴底）。
    const beforeText = "KEEP" + "D".repeat(400);
    const afterText = "KEEP";
    const plan = decideSourceScrollRestore({
      textLengthChanged: true,
      anchor: {
        offset: remapOffsetAcrossTextChange(300, beforeText, afterText), // 300 在删除区
        viewportY: 100,
      },
      pixelScrollTop: null,
    });
    expect(plan.kind).toBe("anchor");
    const off = (plan as { anchor: { offset: number } }).anchor.offset;
    expect(off).toBe(4); // = P（"KEEP" 长度 4）
    expect(off).toBeLessThanOrEqual(afterText.length);
    expect(off).toBeGreaterThan(0); // 关键：不是 0（不跳顶）
  });

  it("源码条目（有像素）+ 文本长度未变 → 走 pixel 快路径（保住字节级位置）", () => {
    // 等长替换（例如批量同长度改名）时像素是权威值，避免测量不可用时退化成 none。
    begin("eq.md", "abcdef");
    commit(
      {
        before: "abcdef",
        after: "abXYef",
        origin: "source",
        beforeSelection: { start: 2, end: 4, scrollTop: 21531 },
      },
      "eq.md",
    );
    const h = fakeHost("abXYef", "eq.md");
    const coord = makeHistoryCoordinator({ api: documentHistory, host: h.host });
    expect(coord.handleUndo()).toBe(true);
    expect(h.calls.applyText[0].restore).toEqual({ start: 2, end: 4, scrollTop: 21531 });
    // 条目里确实带着像素现场（快路径来源）
    expect(snapshotForTest("eq.md")!.entries[0].beforeSelection).toEqual({
      start: 2,
      end: 4,
      scrollTop: 21531,
    });
    const plan = decideSourceScrollRestore({
      textLengthChanged: "abXYef".length !== "abcdef".length,
      anchor: null, // 假设此刻测量不可用（jsdom / 短文档常见）
      pixelScrollTop: 21531,
    });
    expect(plan).toEqual({ kind: "pixel", scrollTop: 21531 });
  });
});
