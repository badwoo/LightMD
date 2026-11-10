// @vitest-environment jsdom
/**
 * v0.17.0 A3：keymap **优先级拆分**的契约（Tab 必须最高、撤销键位必须普通）
 *
 * ## 这条为什么必须锁（Lead 实机探针实证，我上一轮的判断是错的）
 *
 * 我上轮推断"Tab 走 CM6 的 `handleTab`"。Lead 在 `handleTab` 入口打日志 → **零命中**，
 * 但按 Tab 后文本确实多了两个空格 → 那 2 个空格来自 **CM6 内建的 contenteditable
 * Tab 行为**，不是 `planSourceIndent`。
 *
 * 后果比"缩进不对"严重：缩进与设置里的「缩进单位」（Tab / 2 / 4 空格）**完全脱钩**
 * —— 用户设 4 空格，源码面永远 2 空格；`sourceJustPairedRef` 不置位 → 撤销粒度也错。
 *
 * 修法必须**两边分开**，这是本文件的核心：
 * - `Tab` / `Shift-Tab` → `Prec.highest(...)`，必须压过 contenteditable 内建行为；
 * - `Mod-z` 等 `run: () => false` 的"**不处理**"键位 → **必须留在普通优先级**。
 *   若把它们也放进 `Prec.highest`，最高优先级的 `run: false` 会**提前截断**事件，
 *   宿主的 window 监听就再也收不到 Ctrl+Z → 撤销彻底失效。
 *
 * ⚠️ 本文件是**源码结构契约**（读源码文本）：优先级是静态声明，jsdom 无法模拟
 * "contenteditable 内建行为"的真实竞争，只有实机能验证。实机侧由 Lead 的探针覆盖，
 * 这里锁的是"实现形态不能退化"。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const SRC = readFileSync("src/editor/cm6/CmSourceSurface.ts", "utf-8");

describe("A3 keymap 优先级拆分（Tab 最高 / 撤销键位普通）", () => {
  /**
   * ⚠️ **本组断言已随实现变更更新**（重要历史，勿删）
   *
   * 本节最初锁的是「`Tab` 必须在 `Prec.highest(keymap.of([...]))` 内」。
   * 后续实机验证发现**该方案本身是失败的**：
   * - `keymap` 方案：输给 contenteditable 内建 Tab（缩进不是 `planSourceIndent` 做的）；
   * - `Prec.highest(keymap)` 方案：缩进生效，但**焦点逃逸到 BODY**，
   *   且之后 Shift-Tab 完全无效（v0.15.6 焦点口径回归）。
   *
   * 最终采用 `contentDOM` 上的**捕获阶段原生监听**（见 `tab-focus-contract.test.ts`）。
   * 因此这里改为断言"Tab 不再走 keymap 方案"，避免旧断言把失败的实现固化下来。
   */
  it("Tab / Shift-Tab 不得再走 keymap 方案（已实测失败，改走原生捕获监听）", () => {
    expect(SRC, "不得在 keymap 里绑 Tab").not.toMatch(
      /key:\s*"Tab",\s*run:\s*\(\)\s*=>\s*v\.handleTab\(false\)/,
    );
    expect(SRC, "Tab 必须走 contentDOM 捕获监听").toMatch(
      /target\.addEventListener\("keydown",\s*onTabKeydown,\s*true\)/,
    );
  });

  it("★ 撤销/搜索键位的 run:false **不得**放进 Prec.highest", () => {
    const at = SRC.indexOf("Prec.highest(keymap.of([");
    const block = SRC.slice(at, SRC.indexOf("]))", at));
    /**
     * 若这里出现 Mod-z，说明有人把"不处理"的键位提到了最高优先级 ——
     * 那会提前截断事件，宿主 window 监听收不到 Ctrl+Z，**撤销彻底失效**。
     */
    expect(block, "Mod-z 必须在普通优先级（放 highest 会截断事件、撤销失效）").not.toMatch(
      /key:\s*"Mod-z"/,
    );
    expect(block).not.toMatch(/key:\s*"Mod-f"/);
  });

  it("撤销/搜索键位仍以 run:false 存在（不接管，交回宿主统一时间线）", () => {
    // 硬约束 1：不装 history()，撤销必须交回宿主
    expect(SRC, "不得引入 history() 扩展（撤销归统一时间线）").not.toMatch(
      /^import[^;]*\bhistory\b/m,
    );
    expect(SRC).toMatch(/key:\s*"Mod-z",\s*run:\s*\(\)\s*=>\s*false/);
    expect(SRC).toMatch(/key:\s*"Mod-Shift-z",\s*run:\s*\(\)\s*=>\s*false/);
    expect(SRC).toMatch(/key:\s*"Mod-y",\s*run:\s*\(\)\s*=>\s*false/);
    expect(SRC).toMatch(/key:\s*"Mod-f",\s*run:\s*\(\)\s*=>\s*false/);
  });

  it("Tab 处理必须经 handleTab（而非放任 contenteditable 默认行为）", () => {
    // 实现方式变了（原生捕获监听），但"必须经 handleTab"这个实质要求不变
    const at = SRC.indexOf("const onTabKeydown =");
    expect(at, "onTabKeydown 必须存在").toBeGreaterThan(-1);
    const body = SRC.slice(at, SRC.indexOf('target.addEventListener("keydown", onTabKeydown', at));
    expect(body, "必须调用 handleTab 且传入 shiftKey 决定方向").toMatch(
      /this\.handleTab\(e\.shiftKey\)/,
    );
  });

  it("handleTab 必须真的用 planSourceIndent / planSourceOutdent（缩进单位跟随设置）", () => {
    const at = SRC.indexOf("private handleTab(");
    expect(at, "handleTab 必须存在").toBeGreaterThan(-1);
    const body = SRC.slice(at, at + 3000);
    expect(body, "缩进必须走纯函数规划器（否则缩进单位设置脱钩）").toMatch(/planSourceIndent/);
    expect(body, "反缩进同理").toMatch(/planSourceOutdent/);
    expect(body, "落地必须经 applyEdit（单事务单步）").toMatch(/applyEdit/);
  });
});
