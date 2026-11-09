/**
 * src/__tests__/v0170-cm6/c14-intent-source.test.ts —— C14 三条修复用例
 *
 * ## 背景：C14 是 v0.15.0 起就存在的存量缺陷（P0 实测确认，非推测）
 *
 * 原 `EditorContainer.tsx` 声明了三个"一次性标记"——
 * `sourceComposingRef` / `sourceJustPairedRef` / `sourceJustPastedRef`（@1830-1832），
 * 在 `handleSourceChange` 里读取（@2996-2998）、清零两个（@3011-3012）。
 *
 * 实测事实：**全文件没有任何一处把它们置 true**。于是：
 *
 * - IME 组合输入 → `composing` 恒 false → 一次拼音被拆成多步撤销；
 * - 自动配对（`(` → `()`）→ `justPaired` 恒 false → 补全与后续打字被合并成一步；
 * - 粘贴 → `justPasted` 恒 false → 粘贴与后续打字被合并。
 *
 * 三者全部落回 `inferSourceEditKind` 的**文本形态猜测**，而猜测必然误判。
 *
 * ## 本文件锁的是**行为契约**，不是源码文本
 *
 * 判据（这也是 A 线把 P0 快照断言升级的方向）：
 * **删掉对应的 intent 传递逻辑，这些断言会不会红？** 会红 = 有效护栏。
 *
 * ## `sourceAdapter` 的真实归并语义（读实现核实，不是猜）
 *
 * `plan()` **总是**返回一份 `SourcePlan`（除非无变化）。"合并成一步"的机制是
 * **两条记录共用同一个 `groupId`**，时间线据此归并。而哪些 kind 才会分配 group：
 *
 * - `typing` / `delete` → 自动开新组 `src-typing-N`，窗口内且光标连续则**沿用**；
 * - `ime`（带 `groupId`）→ 用调用方给的组合组 id（一次组合 = 一步）；
 * - `ime`（不带）/ `paste` / `pair` / `replace` / `ai` → `groupId: undefined`，
 *   即**天然一次性一步**，不会被并进任何 typing 组。
 *
 * 因此 C14 的正确断言是：**pair / paste / ime 必须不落进 typing 组**
 * （这正是旧实现会搞错的点 —— 它把三类都猜成 typing，于是被合并）。
 */

import { describe, it, expect } from "vitest";
import { createSourceAdapter } from "../../editorHistory/sourceAdapter";

/** 可控时钟（合并窗口依赖时间，注入以免 sleep 造成 flaky） */
function makeClock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("C14 ①：一次 IME 组合 = 一步撤销", () => {
  it("带 compositionGroupId 时沿用调用方给的组合组（一次组合 = 一步）", () => {
    const clock = makeClock();
    const adapter = createSourceAdapter({ now: clock.now });

    // 拼音上屏：ni → nih → niha → nihao，同一组合会话（ime-1）
    const p1 = adapter.plan({
      before: "ni",
      text: "nih",
      kind: "ime",
      groupId: "ime-1",
      selection: { start: 3, end: 3, scrollTop: 0 },
    });
    expect(p1, "首次 IME 变更必须产出计划").not.toBeNull();
    expect(p1!.groupId, "IME 应使用调用方给的组合组 id").toBe("ime-1");

    clock.advance(30);
    const p2 = adapter.plan({
      before: "nih",
      text: "niha",
      kind: "ime",
      groupId: "ime-1",
      selection: { start: 4, end: 4, scrollTop: 0 },
    });
    expect(p2!.groupId, "同一组合会话内必须沿用同一 group（这就是'一步'的机制）").toBe("ime-1");

    clock.advance(30);
    const p3 = adapter.plan({
      before: "niha",
      text: "nihao",
      kind: "ime",
      groupId: "ime-1",
      selection: { start: 5, end: 5, scrollTop: 0 },
    });
    expect(p3!.groupId).toBe("ime-1");
  });

  it("IME 绝不并入 typing 组（否则一次拼音会跟前面的打字合成一步）", () => {
    const clock = makeClock();
    const adapter = createSourceAdapter({ now: clock.now });

    const typed = adapter.plan({
      before: "ab",
      text: "abc",
      kind: "typing",
      caret: 3,
      selection: { start: 3, end: 3, scrollTop: 0 },
    });
    const typingGroup = typed!.groupId;
    expect(typingGroup, "typing 应自动开组").toBeTruthy();

    clock.advance(30);
    // 同一时间窗 + 光标连续 —— 旧实现（把 IME 猜成 typing）会在这里合并
    const ime = adapter.plan({
      before: "abc",
      text: "abc中",
      kind: "ime",
      groupId: "ime-9",
      selection: { start: 4, end: 4, scrollTop: 0 },
    });
    expect(ime!.groupId, "IME 必须是自己的组，不得沿用它前面的 typing 组").toBe("ime-9");
    expect(ime!.groupId).not.toBe(typingGroup);
  });

  it("不同组合会话必须各自成组（不能把两次组合并成一步）", () => {
    const clock = makeClock();
    const adapter = createSourceAdapter({ now: clock.now });

    const a = adapter.plan({
      before: "ni",
      text: "niha",
      kind: "ime",
      groupId: "ime-1",
      selection: { start: 4, end: 4, scrollTop: 0 },
    });
    clock.advance(100);
    const b = adapter.plan({
      before: "niha",
      text: "nihao ma",
      kind: "ime",
      groupId: "ime-2",
      selection: { start: 8, end: 8, scrollTop: 0 },
    });
    expect(a!.groupId).toBe("ime-1");
    expect(b!.groupId, "新组合会话必须自成一组").toBe("ime-2");
  });
});

describe("C14 ②：一次自动配对 = 一步撤销（pair 不与后续打字合并）", () => {
  it("pair 之后紧接着的 typing 不得并入 pair（旧实现会把它们并成一步）", () => {
    const clock = makeClock();
    const adapter = createSourceAdapter({ now: clock.now });

    // 用户按 `(` → 自动补成 `()`：一次离散编辑 → 天然一次性一步（groupId undefined）
    const pairPlan = adapter.plan({
      before: "",
      text: "()",
      kind: "pair",
      selection: { start: 1, end: 1, scrollTop: 0 },
    });
    expect(pairPlan, "配对必须产出计划").not.toBeNull();
    expect(pairPlan!.groupId, "pair 是天然一次性一步，不应被分配 typing 组").toBeUndefined();

    // 紧接在括号里打字（同一时间窗、光标连续）——旧实现会把这步并进上一步
    clock.advance(100);
    const typingPlan = adapter.plan({
      before: "()",
      text: "(a)",
      kind: "typing",
      caret: 2,
      selection: { start: 2, end: 2, scrollTop: 0 },
    });
    expect(
      typingPlan!.groupId,
      "pair 之后的打字必须是独立的一步（不得沿用 pair 的 group）",
    ).not.toBe(pairPlan!.groupId);
    expect(typingPlan!.groupId, "打字应开自己的 typing 组").toBeTruthy();
  });
});

describe("C14 ③：一次粘贴 = 一步撤销（paste 不与后续打字合并）", () => {
  it("paste 之后紧接着的 typing 不得并入 paste", () => {
    const clock = makeClock();
    const adapter = createSourceAdapter({ now: clock.now });

    const pastePlan = adapter.plan({
      before: "hello",
      text: "hello world",
      kind: "paste",
      selection: { start: 11, end: 11, scrollTop: 0 },
    });
    expect(pastePlan, "粘贴必须产出计划").not.toBeNull();
    expect(pastePlan!.groupId, "paste 是天然一次性一步").toBeUndefined();

    clock.advance(50);
    const typingPlan = adapter.plan({
      before: "hello world",
      text: "hello world!",
      kind: "typing",
      caret: 12,
      selection: { start: 12, end: 12, scrollTop: 0 },
    });
    expect(
      typingPlan!.groupId,
      "paste 之后的打字必须是独立的一步（不得沿用 paste 的 group）",
    ).not.toBe(pastePlan!.groupId);
  });
});

describe("C14 ④：修复不得破坏既有的正常归并", () => {
  it("连续打字（同 kind + 光标连续 + 窗口内）仍合并成一步", () => {
    const clock = makeClock();
    const adapter = createSourceAdapter({ now: clock.now });

    const t1 = adapter.plan({
      before: "ab",
      text: "abc",
      kind: "typing",
      caret: 3,
      selection: { start: 3, end: 3, scrollTop: 0 },
    });
    const g1 = t1!.groupId;
    clock.advance(100);
    const t2 = adapter.plan({
      before: "abc",
      text: "abcd",
      kind: "typing",
      caret: 4,
      selection: { start: 4, end: 4, scrollTop: 0 },
    });
    expect(t2!.groupId, "连续打字必须合并（既有正确行为）").toBe(g1);
  });

  it("时长超窗后必须开新组（900ms 窗口语义）", () => {
    const clock = makeClock();
    const adapter = createSourceAdapter({ now: clock.now });

    const t1 = adapter.plan({
      before: "ab",
      text: "abc",
      kind: "typing",
      caret: 3,
      selection: { start: 3, end: 3, scrollTop: 0 },
    });
    clock.advance(5000); // 远超 900ms
    const t2 = adapter.plan({
      before: "abc",
      text: "abcd",
      kind: "typing",
      caret: 4,
      selection: { start: 4, end: 4, scrollTop: 0 },
    });
    expect(t2!.groupId, "超窗后必须开新组").not.toBe(t1!.groupId);
  });
});
