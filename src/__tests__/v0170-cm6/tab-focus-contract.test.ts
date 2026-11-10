// @vitest-environment jsdom
/**
 * v0.17.0 回归：Tab / Shift-Tab 必须**阻止默认焦点移动**
 *
 * ## 缺陷（实机探针确证）
 * ```
 * PASS [2] Tab 在行首插入缩进单位 — Δ2       ← 缩进生效
 * FAIL [3] Tab 后焦点仍在编辑器内 — 焦点=BODY  ← 焦点逃逸
 * FAIL [4] Shift-Tab 反缩进 — Δ0             ← 反缩进无效
 * ```
 * 违反 v0.15.6 已发布口径：「Tab/Shift-Tab 不会把焦点移出编辑器」。
 *
 * ## 为什么前三次修复都失败（都实测过）
 * 1. `keymap.of([{key:"Tab"}])` → 输给 contenteditable 内建 Tab，缩进不是我们做的；
 * 2. `Prec.highest(keymap.of(...))` → 缩进生效但焦点逃逸（"消费"≠"阻止默认行为"）；
 * 3. `Prec.highest(EditorView.domEventHandlers(...))` → handler 根本没被调用。
 *
 * ## 采用方案：`contentDOM` 上的**捕获阶段原生监听**
 * 先用页面内三层监听实测确认：我们的 handler **确实被调用**
 *（`content-capture:Tab` 命中），因此问题不在"没接上"，而在
 * `preventDefault()` 是否执行到 —— `handleTab()` 内任何异常都会跳过它。
 *
 * 故最终顺序：**先 `preventDefault()`，再 try/catch 包住 `handleTab()`**。
 *
 * ## 本文件的断言边界（重要）
 * jsdom 无法真实模拟"Tab 的焦点移动"（那是浏览器的默认行为），
 * 所以这里锁的是**实现结构契约**：
 * - 监听必须绑在 `contentDOM` 的**捕获阶段**；
 * - `preventDefault()` 必须在 `handleTab()` **之前**调用；
 * - `handleTab()` 必须被 try/catch 包住（异常不得跳过 preventDefault）。
 * 真实焦点行为由实机验证（见报告「待补验项」）。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const SRC = readFileSync("src/editor/cm6/CmSourceSurface.ts", "utf-8");

describe("A3 Tab 焦点保持：实现结构契约", () => {
  it("Tab 监听必须绑在 contentDOM 的**捕获阶段**", () => {
    expect(SRC, "必须有 contentDOM 上的 keydown 监听").toMatch(
      /target\.addEventListener\("keydown",\s*onTabKeydown,\s*true\)/,
    );
    expect(SRC, "解绑时同样要匹配捕获阶段（否则泄漏）").toMatch(
      /target\.removeEventListener\("keydown",\s*onTabKeydown,\s*true\)/,
    );
  });

  it("★ `preventDefault()` 必须在 `handleTab()` **之前**（实测定位的关键顺序）", () => {
    const at = SRC.indexOf("const onTabKeydown =");
    expect(at, "onTabKeydown 必须存在").toBeGreaterThan(-1);
    // 截到下一条房标：cleanup 注册处
    const body = SRC.slice(at, SRC.indexOf('target.addEventListener("keydown", onTabKeydown', at));

    const pdAt = body.indexOf("e.preventDefault()");
    const htAt = body.indexOf("this.handleTab(");
    expect(pdAt, "必须调用 preventDefault").toBeGreaterThan(-1);
    expect(htAt, "必须调用 handleTab").toBeGreaterThan(-1);
    expect(
      pdAt,
      "preventDefault 必须在 handleTab 之前 —— 否则 handleTab 抛异常会跳过它，焦点逃逸",
    ).toBeLessThan(htAt);
  });

  it("`handleTab()` 必须被 try/catch 包住（异常不得冒到事件循环）", () => {
    const at = SRC.indexOf("const onTabKeydown =");
    const body = SRC.slice(at, SRC.indexOf('target.addEventListener("keydown", onTabKeydown', at));
    expect(body, "handleTab 调用必须包在 try 块内").toMatch(/try\s*\{[\s\S]*this\.handleTab\(/);
    expect(body, "必须有 catch 兜底").toMatch(/catch\s*\(/);
  });

  it("IME 组合态不得抢 Tab（输入法优先）", () => {
    const at = SRC.indexOf("const onTabKeydown =");
    const body = SRC.slice(at, SRC.indexOf('target.addEventListener("keydown", onTabKeydown', at));
    expect(body, "组合态必须放行（否则抢输入法的 Tab）").toMatch(
      /if\s*\(e\.isComposing\s*\|\|\s*this\.composing\)\s*return/,
    );
  });

  it("Tab keymap 不得回退到 keymap 方案（三次实测都失败的路径）", () => {
    /**
     * ⚠️ 反向断言：`keymap.of([{key:"Tab"...}])` 与
     * `Prec.highest(keymap.of([{key:"Tab"...}]))` 都**实测失败**：
     * - 前者输给 contenteditable 内建行为；
     * - 后者缩进生效但焦点逃逸（"消费"不等于"阻止默认行为"）。
     * 若有人改回 keymap 方案，Tab 焦点缺陷会立刻回归。
     */
    expect(SRC, "不得在 keymap 里绑 Tab（已实测失败的方案）").not.toMatch(
      /key:\s*"Tab",\s*run:\s*\(\)\s*=>\s*v\.handleTab\(false\)/,
    );
  });
});
