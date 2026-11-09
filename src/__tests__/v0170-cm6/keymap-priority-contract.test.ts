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
  it("Tab / Shift-Tab 必须在 Prec.highest 内", () => {
    // 取出 Prec.highest(...) 括起来的片段
    const at = SRC.indexOf("Prec.highest(keymap.of([");
    expect(at, "必须存在 Prec.highest(keymap.of([...])) 结构").toBeGreaterThan(-1);
    const block = SRC.slice(at, SRC.indexOf("]))", at));
    expect(block, "Tab 必须在最高优先级里（否则被 contenteditable 内建行为抢先）").toMatch(
      /key:\s*"Tab"/,
    );
    expect(block, "Shift-Tab 同理").toMatch(/key:\s*"Shift-Tab"/);
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
    expect(SRC).toMatch(/key:\s*"Tab",\s*run:\s*\(\)\s*=>\s*v\.handleTab\(false\)/);
    expect(SRC).toMatch(/key:\s*"Shift-Tab",\s*run:\s*\(\)\s*=>\s*v\.handleTab\(true\)/);
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
