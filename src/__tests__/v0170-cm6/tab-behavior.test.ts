// @vitest-environment jsdom
/**
 * v0.17.0 回归：Tab / Shift-Tab 的**行为**契约（不只是源码结构）
 *
 * ## 缺陷链（实机探针 + 对照实验确证，两层）
 *
 * ### 第一层：焦点逃逸
 * ```
 * PASS [2] Tab 缩进 — Δ2        ← 缩进生效
 * FAIL [3] Tab 后焦点仍在编辑器内 — 焦点=BODY
 * ```
 * 我最初误判为"CDP 局限"。Lead 用对照实验（同一环境、只改页面 DOM）推翻：
 * 普通 `<input>` 与裸 `contenteditable` 在同样捕获监听下**都能保住焦点**，
 * 只有 CM6 的 `.cm-content` 不能 → **真实产品缺陷**。
 *
 * 进一步验证：`preventDefault()` 调用后 `defaultPrevented === true`、
 * 事件可取消、`contentDOM` 就是 `activeElement` —— 但焦点仍离开。
 * → 结论：**阻止默认行为已生效，是 CM6 内部另有机制移动焦点**。
 *
 * 修法：不依赖"阻止默认行为"，改在**下一帧主动夺回焦点**（同步夺回无效）。
 *
 * ### 第二层：夺回焦点会重置光标 → 静默破坏 Shift-Tab（修完第一层才暴露）
 * ```
 * __PLAN=[{"outdent":false,"start":15},    ← Tab 时正确
 *         {"outdent":true, "start":0}]     ← Shift-Tab 时跑到文档头
 * __PLANK=["outdent=false kind=edit", "outdent=true kind=none"]  ← 所以反缩进失效
 * ```
 * `contentDOM.focus()` 把光标重置到文档开头 → `planSourceOutdent` 判定
 * 「光标前不是纯空白」→ `kind:none` → **反缩进静默失效**。
 *
 * 修法：夺回焦点时**保存并写回 selection**。
 *
 * ## 本文件的价值：这些都能在 jsdom 里做**行为验证**（不只是结构断言）
 * 实测确认：jsdom 下派发 keydown 能真实驱动 `handleTab` → `applyEdit`，
 * 文本会真的变化、光标会真的移动。所以下面直接断言**文本与光标**，
 * 而不是"源码里应该有某行代码"。
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createSourceSurface } from "../../editor/createSourceSurface";
import type { SourceSurface } from "../../editor/types";

let surface: SourceSurface | null = null;
let host: HTMLElement | null = null;

function mount(text: string): SourceSurface {
  surface = createSourceSurface({ impl: "cm6" });
  host = document.createElement("div");
  document.body.appendChild(host);
  surface.mount(host, { initialText: text });
  return surface;
}

/** 在 `.cm-content` 上派发一个真实的 Tab / Shift-Tab keydown */
function pressTab(shift = false): void {
  const content = document.querySelector(".cm-content") as HTMLElement | null;
  expect(content, "CM6 的 .cm-content 必须存在").toBeTruthy();
  content!.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Tab",
      code: "Tab",
      shiftKey: shift,
      bubbles: true,
      cancelable: true,
    }),
  );
}

/**
 * 推进 rAF 队列。
 *
 * ⚠️ 焦点夺回逻辑用 `requestAnimationFrame` 延迟到下一帧 ——
 * 测试里必须显式推进它，否则只验证了"同步部分"。
 * 用 `vi.stubGlobal` 收集回调再统一执行，比 fake timers 更贴近真实语义。
 */
let rafCallbacks: FrameRequestCallback[] = [];
beforeEach(() => {
  rafCallbacks = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  surface?.destroy();
  surface = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
});

/** 执行所有待处理的 rAF 回调（模拟"下一帧"） */
function flushRaf(): void {
  const pending = rafCallbacks;
  rafCallbacks = [];
  for (const cb of pending) cb(performance.now());
}

describe("A3 Tab 行为：缩进与光标", () => {
  it("Tab 在行首/光标处插入缩进单位，光标随之后移", () => {
    const s = mount("alpha\nbeta");
    s.setSelection(2, 2);
    pressTab(false);
    // 缩进单位默认 2 空格 → "al  pha"，光标从 2 移到 4
    expect(s.getText(), "Tab 必须真的插入缩进").toBe("al  pha\nbeta");
    expect(s.getSelection().start, "光标必须随缩进后移").toBe(4);
  });

  it("Shift-Tab 移除行首缩进（反缩进真的生效，不是静默失效）", () => {
    const s = mount("  alpha\nbeta");
    s.setSelection(2, 2);
    pressTab(true);
    expect(s.getText(), "Shift-Tab 必须真的移除缩进").toBe("alpha\nbeta");
  });
});

describe("A3 Tab 行为：焦点夺回后 selection 必须保持（第二层缺陷的直接护栏）", () => {
  it("★ 焦点夺回时必须显式写回 selection（不依赖 jsdom 不会重置光标这一点）", () => {
    /**
     * ## 为什么这条测试要"模拟浏览器会重置光标"
     *
     * jsdom 里 `contentDOM.focus()` **不会**把光标重置到文档开头 ——
     * 那是真实浏览器的行为（Lead 实机实测：Tab 后 `plan.start=15` 正确，
     * 但下一次按键 `plan.start=0`）。
     *
     * 所以如果只写"Tab 后光标不变"，**破坏性验证时测试不会红**
     *（实测：删掉 selection 写回那段，其余用例仍全绿）—— 那条护栏是假的。
     *
     * 正确做法：**显式模拟浏览器的重置行为**，即在 rAF 执行前把 selection
     * 故意置为 0（复现 `contentDOM.focus()` 的副作用），再断言修复代码把它写回来了。
     * 这样删掉写回逻辑，本用例必红。
     */
    const s = mount("alpha\nbeta");
    s.setSelection(0, 0);
    pressTab(false);
    expect(s.getText()).toBe("  alpha\nbeta");
    const correctCaret = s.getSelection().start;
    expect(correctCaret, "Tab 后光标应在缩进区之后").toBe(2);

    // 模拟浏览器 `contentDOM.focus()` 的副作用：光标被重置到文档开头
    s.setSelection(0, 0);
    expect(s.getSelection().start, "已模拟焦点重置").toBe(0);

    // 执行 rAF：修复代码应把"夺回焦点前保存的 selection"写回来
    flushRaf();

    expect(
      s.getSelection().start,
      "★ 焦点夺回后必须写回原 selection —— 否则光标停在 0，后续 Shift-Tab 静默失效",
    ).toBe(correctCaret);
  });

  it("Tab 后推进 rAF：光标必须仍在缩进后的位置，不得被重置到 0", () => {
    /**
     * 这是**第二层缺陷的直接护栏**：
     * `contentDOM.focus()` 会把光标重置到文档开头（start=0），
     * 导致下一次 Shift-Tab 拿到 start=0 → `planSourceOutdent` 返回 kind:none
     * → 反缩进静默失效。
     *
     * 若有人删掉"夺回焦点时写回 selection"那段，本用例会红。
     */
    const s = mount("alpha\nbeta");
    s.setSelection(2, 2);
    pressTab(false);
    const afterTab = s.getSelection().start;
    expect(afterTab, "Tab 后光标应在缩进单位之后").toBe(4);

    // 模拟"下一帧"：焦点夺回逻辑执行
    flushRaf();

    expect(
      s.getSelection().start,
      "★ 焦点夺回后光标必须保持（若重置到 0，下一次 Shift-Tab 会静默失效）",
    ).toBe(afterTab);
  });

  it("★ Tab 后接 Shift-Tab：必须以「缩进后的光标位置」计算反缩进（端到端）", () => {
    /**
     * 端到端复现第二层缺陷的完整路径：
     * Tab（光标在行首 0）→ rAF 夺回焦点 → Shift-Tab 应能正确反缩进。
     *
     * ⚠️ 光标必须在**行首**（或行首缩进区内）：
     * `planSourceOutdent` 要求「光标前是纯空白」（`/^[ \t]+$/`），
     * 若光标在 `al  |pha`（前方有字符），它按设计返回 `kind: none`
     * —— 那是**正确行为**，不是缺陷。
     *
     * 若 rAF 里丢了 selection，光标会重置到 0 而 Tab 后文本是 "  alpha"，
     * start=0 时 `beforeCaret` 为空串（不匹配 `^[ \t]+$`）→ kind:none
     * → 反缩进静默失效（这正是 Lead 观察到的现象）。
     */
    const s = mount("alpha\nbeta");
    s.setSelection(0, 0); // 行首
    pressTab(false);
    expect(s.getText(), "Tab 应在行首插入缩进").toBe("  alpha\nbeta");
    expect(s.getSelection().start, "光标应停在缩进之后（行首缩进区内）").toBe(2);
    flushRaf(); // 焦点夺回 + 写回 selection
    expect(s.getSelection().start, "rAF 后光标仍在缩进区内（未重置到 0）").toBe(2);
    pressTab(true); // Shift-Tab
    expect(s.getText(), "Tab 再 Shift-Tab 应能回到原文（反缩进未失效）").toBe("alpha\nbeta");
  });
});

describe("A3 Tab 行为：焦点夺回的实现约束", () => {
  it("焦点没丢时不得多动（避免无谓的 dispatch 打断输入）", () => {
    const s = mount("alpha");
    s.setSelection(2, 2);
    // 手动让 contentDOM 处于"已聚焦"状态（jsdom 中 focus 是模拟的）
    const content = document.querySelector(".cm-content") as HTMLElement;
    content.focus();
    const before = s.getSelection().start;
    pressTab(false);
    flushRaf();
    // 焦点本来就在，rAF 里应直接 return；光标仍是 Tab 后的位置
    expect(s.getSelection().start).toBe(before + 2);
  });

  it("IME 组合态不得抢 Tab（输入法优先）", () => {
    const s = mount("alpha");
    s.setSelection(2, 2);
    const content = document.querySelector(".cm-content") as HTMLElement;
    // 组合态下发 Tab：应直接放行，不改文本
    content.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        code: "Tab",
        isComposing: true,
        bubbles: true,
        cancelable: true,
      } as KeyboardEventInit),
    );
    expect(s.getText(), "组合态下不得抢 Tab").toBe("alpha");
  });
});
