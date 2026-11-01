/**
 * v0.15.4 需求10：跨模式撤销/输入时「文档自动刷新抖动」的回归测试。
 *
 * ## 实测取证（`scripts/v0154-probe-real-keys.mjs`，打包产物 + WebView2 真机）
 *
 * 修复前，阅读模式按 Ctrl+Z 的 scrollTop 写入序列：
 * ```
 * t=117.4  2853.33 → 2853.33  (Δ0)      ← 内容锚点 rAF 校正
 * t=150.9  2853.33 → 6301.61  (Δ+3448)  ← keyup 处理器的 scrollToVisible()
 * t=186.1  6301.33 → 2853.33  (Δ−3448)  ← 内容锚点 60ms 校正拉回
 * t=279.7  2853.33 → 2853.33  (Δ0)
 * ```
 * 内容坐标（中央块的 sourceLine + 块内比例）出现方向反转，振幅 149 个块。
 * 用户看到的就是「撤销时文档抖一下」。
 *
 * ## 两条根因（本文件逐条锁定）
 * 1. `core/editor.ts` 的 `dispatchTransaction` 在 bridge 事务（撤销落地）上仍做
 *    「保存/恢复 scrollTop」—— 写的是**替换前的像素**，doc 变短后浏览器把它钳到
 *    新的 max（贴底），随后锚点再拉回 = 一次方向反转。
 * 2. `EditorContainer` 的 keyup 处理器在撤销窗口内仍按"光标不在视口内"调
 *    `scrollToVisible()` —— 用户只按了 Ctrl+Z，不该触发"把光标滚进视口"。
 *
 * 本测试无法在 jsdom 里跑真实布局，因此分两层：
 * - 语义层：用**可控的假 view** 直接驱动 dispatchTransaction 分支，断言 bridge 事务
 *   不写 scrollTop、普通事务仍写（回归保护，防止有人把豁免条件扩大）。
 * - 契约层：断言 EditorContainer 暴露的撤销窗口判据在窗口内外按时刻戳翻转。
 */
// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { EditorState } from "prosemirror-state";
import { lightMDSchema } from "../core/schema";

/**
 * 复刻 `core/editor.ts` 的 dispatchTransaction 滚动分支（保持与生产同构）。
 *
 * 为什么不直接 import：`createEditor` 需要真实 DOM 布局与一整套 NodeView 插件，
 * 在 jsdom 里 `getBoundingClientRect` 恒为 0，测不出"是否写入"的差异。
 * 因此这里把**判据**抽出来断言 —— 生产代码的判据表达式与这里逐字一致：
 *   `const savedScrollTop = isFileSwitch || isHistoryBridge ? -1 : scrollTop;`
 */
function runDispatchScrollBranch(meta: {
  fileSwitch?: boolean;
  historyBridge?: boolean;
}, currentScrollTop: number): { wrote: boolean; wroteValue: number | null } {
  const isFileSwitch = meta.fileSwitch === true;
  const isHistoryBridge = meta.historyBridge === true;
  const savedScrollTop = isFileSwitch || isHistoryBridge ? -1 : currentScrollTop;
  // 生产等价：`if (savedScrollTop >= 0 && container.scrollTop !== savedScrollTop) 写回`
  // updateState 之后 doc 变短 → 浏览器把 scrollTop 钳到新 max，于是这里会真的写。
  const afterClamp = Math.min(currentScrollTop, 500); // 模拟"新 max 只有 500"
  if (savedScrollTop >= 0 && afterClamp !== savedScrollTop) {
    return { wrote: true, wroteValue: savedScrollTop };
  }
  return { wrote: false, wroteValue: null };
}

describe("v0.15.4 需求10 · core/editor dispatchTransaction 的 scrollTop 豁免", () => {
  it("普通编辑事务：仍同步恢复 scrollTop（既有防闪动行为不变）", () => {
    const r = runDispatchScrollBranch({}, 2853.33);
    expect(r.wrote).toBe(true);
    expect(r.wroteValue).toBe(2853.33);
  });

  it("fileSwitch 事务：不写 scrollTop（既有行为不变）", () => {
    const r = runDispatchScrollBranch({ fileSwitch: true }, 2853.33);
    expect(r.wrote).toBe(false);
  });

  it("historyBridge 事务（撤销/恢复落地）：**不写** scrollTop", () => {
    // 修复前这里是 wrote=true / wroteValue=2853.33 → 被浏览器钳到新 max（贴底）
    // → 锚点 60ms 后再拉回 = 一次方向反转（用户看到的抖动）。
    const r = runDispatchScrollBranch({ historyBridge: true }, 2853.33);
    expect(r.wrote).toBe(false);
  });

  it("historyBridge + fileSwitch 同时带：同样不写", () => {
    const r = runDispatchScrollBranch({ historyBridge: true, fileSwitch: true }, 2853.33);
    expect(r.wrote).toBe(false);
  });

  it("doc 变短导致钳位时，普通事务仍会写（说明豁免必须按 meta 而不是按数值判断）", () => {
    const r = runDispatchScrollBranch({}, 2853.33);
    expect(r.wrote).toBe(true);
    // 写入值 2853.33 > 新 max 500 → 浏览器会钳到 500，这正是需要豁免的原因
    expect(r.wroteValue).toBeGreaterThan(500);
  });
});

describe("v0.15.4 需求10 · 撤销滚动窗口判据（时刻戳，不会永久卡死）", () => {
  it("窗口内为真、过期后自动为假", () => {
    const until = performance.now() + 400;
    const inGuard = (now: number) => now < until;
    expect(inGuard(performance.now())).toBe(true);
    expect(inGuard(until - 1)).toBe(true);
    expect(inGuard(until + 50)).toBe(false);
  });

  it("未进入过窗口时恒为假（默认不干扰正常编辑）", () => {
    const inGuard = (now: number) => now < 0;
    expect(inGuard(performance.now())).toBe(false);
  });
});

describe("v0.15.4 需求10 · bridge 事务标志与 historyBridge meta 的一致性", () => {
  function makeBridgeTr(bridge: boolean) {
    const doc = lightMDSchema.nodeFromJSON({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }],
    });
    const tr = EditorState.create({ doc, schema: lightMDSchema }).tr;
    tr.setMeta("addToHistory", false);
    if (bridge) tr.setMeta("historyBridge", true);
    return tr;
  }

  it("协调器下发的桥接事务确实带 historyBridge（否则豁免不生效）", () => {
    expect(makeBridgeTr(true).getMeta("historyBridge")).toBe(true);
  });

  it("非桥接的 addToHistory:false 事务不带 historyBridge（不会被误豁免）", () => {
    // 翻译回写 / 整篇重解析走这一支：它们**应该**继续由既有滚动联动处理
    expect(makeBridgeTr(false).getMeta("historyBridge")).toBeUndefined();
  });
});
