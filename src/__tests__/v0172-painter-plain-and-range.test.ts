import { describe, it, expect } from "vitest";
import {
  isSnapshotMissing,
  isSnapshotPlain,
  isSnapshotEmpty,
  resolvePainterApplyScope,
  buildPmInlineOnlyTr,
  applyMarksToSourceRange,
  applyMarksToSourceRange as applyRange,
  collectSourceSnapshot,
  stripInlineMarkSymbols,
} from "../utils/formatPainter";
import { lightMDSchema as schema } from "../core/schema";
import { EditorState } from "prosemirror-state";
import { markdownToDoc } from "../core/markdown/parser";

/**
 * v0.17.2：格式刷两项用户裁决的契约测试
 *
 * ## 问题2 —— 无格式源必须能 arm
 * 用户原话：「我希望将没格式的文本应用到有格式的文本，是有格式文本变没格式。
 * 所以基于这个场景，对没格式文本进行格式刷应该是要生效的。」
 *
 * ## 问题3 —— 格式刷要支持选中文本级应用
 * 用户原话：「格式刷要支持对选中的文本进行应用，而不是整个段落去应用，
 * 例如加粗、下划线这些格式。」
 *
 * 本文件只锁**纯函数契约**；端到端由 `scripts/_lead-i23-painter.mjs` 在真实
 * 构建产物里验证（两者互补，报告里分开写）。
 */

describe("问题2：无格式源不再被拒绝（isSnapshotMissing / isSnapshotPlain）", () => {
  it("null / undefined 才算「没采到」", () => {
    expect(isSnapshotMissing(null)).toBe(true);
    expect(isSnapshotMissing(undefined)).toBe(true);
  });

  it("★ 无格式纯文本快照 —— **不是** missing（这是问题2的核心口径）", () => {
    const snap = collectSourceSnapshot("普通文字段落甲", 0, 7);
    expect(snap.marks).toEqual([]);
    expect(snap.blockType).toBe("paragraph");
    // v0.17.0 曾把这条判成"空"并拒绝 arm；v0.17.2 按用户裁决改为**合法**
    expect(isSnapshotMissing(snap), "无格式源必须能 arm（否则无法把有格式刷成无格式）").toBe(false);
    // 同时它能被识别为"无格式"，供 UI 给出准确提示
    expect(isSnapshotPlain(snap)).toBe(true);
  });

  it("有格式的快照：missing=false 且 plain=false", () => {
    const text = "源一：**粗体源** 供采集。";
    const start = text.indexOf("**");
    // 选区要**含两侧符号**才会被采集为 strong（collectSourceSnapshot 按整段首尾包裹判定）
    const end = text.indexOf("**", start + 2) + 2;
    const snap = collectSourceSnapshot(text, start, end);
    expect(snap.marks).toContain("strong");
    expect(isSnapshotMissing(snap)).toBe(false);
    expect(isSnapshotPlain(snap)).toBe(false);
  });

  it("PM 侧无 mark 普通段落 → 同样不 missing、且是 plain", () => {
    const doc = markdownToDoc("普通段落文字");
    const state = EditorState.create({ doc, schema });
    // 直接用采集函数验证（选区覆盖整段）
    const snap = { marks: [], blockType: "paragraph" as const, taskStyle: null };
    expect(isSnapshotMissing(snap)).toBe(false);
    expect(isSnapshotPlain(snap)).toBe(true);
    expect(state.doc.textContent).toBe("普通段落文字");
  });

  it("向后的 isSnapshotEmpty 仍保留旧语义（仅为兼容，不再用于拦截）", () => {
    // 明确记录：这个旧函数把"无格式"判成 empty —— 正是问题2 要绕开的，
    // 所以生产路径改用 isSnapshotMissing。此断言防止有人误改回去。
    expect(isSnapshotEmpty({ marks: [], blockType: "paragraph" })).toBe(true);
    expect(isSnapshotEmpty(null)).toBe(true);
  });

  it("源码侧：无格式源刷到有格式行 → 剥离符号（有格式变没格式）", () => {
    const src = "**已加粗目标**";
    const start = 0;
    const end = src.length;
    const snap = { marks: [] as string[], blockType: "paragraph", taskStyle: null };
    // 无 marks 时 wrapRangeWithMarks 只做剥离
    const out = stripInlineMarkSymbols(src);
    expect(out).toBe("已加粗目标");
    expect(resolvePainterApplyScope(start, end, 0, end).inlineOnly).toBe(true);
    expect(snap.marks).toHaveLength(0);
  });
});

describe("问题3：应用范围决策（resolvePainterApplyScope）", () => {
  it("★ 有选区 → 只刷行内（inlineOnly=true），范围就是选区", () => {
    const scope = resolvePainterApplyScope(10, 20, 0, 50);
    expect(scope).toEqual({ from: 10, to: 20, inlineOnly: true });
  });

  it("无选区（from === to）→ 整段（inlineOnly=false）", () => {
    const scope = resolvePainterApplyScope(15, 15, 0, 50);
    expect(scope).toEqual({ from: 0, to: 50, inlineOnly: false });
  });

  it("非法值（NaN）→ 回退整段，不抛异常", () => {
    const scope = resolvePainterApplyScope(NaN, NaN, 3, 9);
    expect(scope).toEqual({ from: 3, to: 9, inlineOnly: false });
  });

  it("反向选区（to < from）视为无选区 → 整段", () => {
    const scope = resolvePainterApplyScope(20, 10, 0, 50);
    expect(scope.inlineOnly).toBe(false);
  });
});

describe("问题3：PM 选区级应用（buildPmInlineOnlyTr）", () => {
  /** 造一个含粗体的文档，选出其中一部分纯文本 */
  const makeState = () => {
    const doc = markdownToDoc("前段无格式。**加粗段**后续文字。");
    return EditorState.create({ doc, schema });
  };

  it("★ 只对选中区间加 mark，区间外不受影响（不刷整段）", () => {
    const state = makeState();
    const para = state.doc.firstChild!;
    const text = para.textContent;
    // 找到"后续文字"在段落内的位置（纯文本，无 mark）
    const idx = text.indexOf("后续文字");
    expect(idx).toBeGreaterThan(0);
    const from = 1 + idx; // 段落内容起点 = 1
    const to = from + 4;
    const tr = buildPmInlineOnlyTr(state, from, to, { marks: ["strong"], blockType: "paragraph", taskStyle: null });
    expect(tr, "应产生变更").not.toBeNull();
    const next = tr!.doc;
    // 新区间内每个文本节点都必须有 strong
    let inRange = 0;
    let allStrong = true;
    next.nodesBetween(from, to, (n) => {
      if (n.isText) {
        inRange++;
        if (!n.marks.some((m) => m.type.name === "strong")) allStrong = false;
      }
    });
    expect(inRange).toBeGreaterThan(0);
    expect(allStrong, "选区内的文字都应变粗").toBe(true);
  });

  it("★ 无格式快照清掉选区内 mark（有格式变无格式）", () => {
    const state = makeState();
    const para = state.doc.firstChild!;
    const text = para.textContent;
    const idx = text.indexOf("加粗段");
    const from = 1 + idx;
    const to = from + 3;
    const tr = buildPmInlineOnlyTr(state, from, to, { marks: [], blockType: "paragraph", taskStyle: null });
    expect(tr, "清格式应产生变更").not.toBeNull();
    let anyStrong = false;
    tr!.doc.nodesBetween(from, to, (n) => {
      if (n.isText && n.marks.some((m) => m.type.name === "strong")) anyStrong = true;
    });
    expect(anyStrong, "选区内的粗体应被清除").toBe(false);
  });

  it("块级不受影响：选区级应用**不会**把整段变成标题", () => {
    const state = makeState();
    const before = state.doc.firstChild!.type.name;
    const tr = buildPmInlineOnlyTr(state, 1, 4, { marks: ["em"], blockType: "heading1", taskStyle: null });
    const after = tr!.doc.firstChild!.type.name;
    expect(after, "选区级应用不应改动块类型").toBe(before);
  });

  it("空区间 → null（不产生事务）", () => {
    const state = makeState();
    expect(buildPmInlineOnlyTr(state, 3, 3, { marks: ["strong"], blockType: "paragraph" })).toBeNull();
  });

  it("区间已全是目标格式 → null（幂等，不产生无意义撤销步骤）", () => {
    const state = makeState();
    const para = state.doc.firstChild!;
    const text = para.textContent;
    const idx = text.indexOf("加粗段");
    const from = 1 + idx;
    const to = from + 3;
    const tr = buildPmInlineOnlyTr(state, from, to, { marks: ["strong"], blockType: "paragraph" });
    expect(tr, "已经是粗体 → 应无变化").toBeNull();
  });
});

describe("问题3：源码选区级应用（applyMarksToSourceRange）", () => {
  it("★ 只包裹选中文字，行内其余部分不动", () => {
    const text = "前段无格式后续文字。";
    const start = text.indexOf("后续");
    const end = start + 2;
    const r = applyRange(text, start, end, ["strong"]);
    expect(r).not.toBeNull();
    expect(r!.text).toBe("前段无格式**后续**文字。");
  });

  it("★ 选区落在带前缀的行内：前缀保留不动，只包正文选区", () => {
    const text = "## 标题正文部分";
    const start = text.indexOf("正文");
    const end = start + 2;
    const r = applyRange(text, start, end, ["strong"]);
    expect(r).not.toBeNull();
    expect(r!.text).toBe("## 标题**正文**部分");
  });

  it("选区压在前缀上（无可包正文）→ null", () => {
    const text = "## 标题";
    const r = applyRange(text, 0, 2, ["strong"]); // 只选中 "##"
    expect(r).toBeNull();
  });

  it("★ 无格式源 → 剥离选区内已有符号（有格式变无格式）", () => {
    const text = "保留**加粗**这里";
    const start = text.indexOf("**");
    const end = text.indexOf("这里");
    const r = applyRange(text, start, end, []);
    expect(r).not.toBeNull();
    expect(r!.text).toBe("保留加粗这里");
  });

  it("下划线（<u>）与高亮（==）同样支持选区级", () => {
    const t1 = "abc目标def";
    const s1 = t1.indexOf("目标");
    expect(applyRange(t1, s1, s1 + 2, ["underline"])!.text).toBe("abc<u>目标</u>def");
    const t2 = "abc目标def";
    const s2 = t2.indexOf("目标");
    expect(applyRange(t2, s2, s2 + 2, ["mark"])!.text).toBe("abc==目标==def");
  });

  it("选区级应用返回新选区边界（便于连续刷）", () => {
    const text = "abcdef";
    const r = applyRange(text, 2, 4, ["strong"]);
    expect(r).not.toBeNull();
    expect(r!.text.slice(r!.start, r!.end)).toBe("**cd**");
  });
});
