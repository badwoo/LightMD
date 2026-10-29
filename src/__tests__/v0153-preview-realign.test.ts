// @vitest-environment jsdom
/**
 * v0.15.3 返修（缺陷 B）—— 模式切换进编辑后**右屏延迟重对齐**的静态契约 + 纯函数。
 *
 * ## 用户症状（Lead 在打包产物上实机复现）
 * 从阅读模式双击 Ctrl 进编辑模式（右侧预览同时打开）后，左右两屏**停在错位位置**：
 * 实测（`scripts/v0153-probe-align-async.mjs`，含 mermaid 的文档）
 * - t=0ms：`[data-src-line]` 贴标 **0 个**、右屏 `scrollHeight=0` → 无从对齐；
 * - t=480ms：贴标 78 个、右屏 `scrollHeight=7868`；
 * - 稳定后左右仍差 **5.1 个源码行**；用户手动滚一下左屏立刻降到 **0.09 行**。
 * 结论：块锚点映射本身是对的，**只是切换后没人再触发一次对齐** —— 旧实现的
 * `syncPreviewAfterToggleRef` 重试只挂在「预览开合冻结窗」的 `finalize` 里，
 * 而 `modeChanged` 会让冻结窗直接 return，模式切换那条路径上完全没有重对齐。
 *
 * ## 为什么是静态契约 + 纯函数（不渲染组件）
 * jsdom 不跑布局、iframe 内容文档不渲染、`scrollHeight/clientHeight` 恒为 0——
 * "右屏是否对齐"在 jsdom 里**不可观测**，渲染组件只会得到假绿灯。与既有
 * `v0140-preview-toggle-scroll-freeze.test.ts` 同款做法：读源码做契约断言。
 * 真实几何由 Lead 在打包产物上用探针验证（左差 5.1 行 → 0.09 行）。
 *
 * ## 签名对齐（纪律要求）
 * 实现 `src/utils/textOffsetRemap.ts` 已导出
 * `PREVIEW_REALIGN_DELAYS = [0,160,480,1000,1600] as const`、
 * `PREVIEW_REALIGN_WINDOW_MS = 2500`、
 * `shouldContinuePreviewRealign({cancelled,userScrolled,elapsedMs})`，
 * 与任务书假设**一致**（无偏差）；因此本文件既测静态契约，也直接测该纯函数。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PREVIEW_REALIGN_DELAYS,
  PREVIEW_REALIGN_WINDOW_MS,
  shouldContinuePreviewRealign,
} from "../utils/textOffsetRemap";

const here = dirname(fileURLToPath(import.meta.url));
const rawTsx = readFileSync(join(here, "../components/editor/EditorContainer.tsx"), "utf8");
const rawUtil = readFileSync(join(here, "../utils/textOffsetRemap.ts"), "utf8");

/**
 * 去掉注释再断言：实现里刻意在注释中解释了 `PREVIEW_REALIGN_DELAYS`、`wheel`、
 * `clearTimeout` 等字样（取证说明）。不去掉会把「解释」当成「实现」→ 假绿灯。
 */
const tsx = rawTsx.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const util = rawUtil.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * 取重对齐逻辑的区域：从 `const realignGen` 起到该 `useEffect` 的清理函数结束。
 *
 * ⚠️ 不能用"固定 2600 字符切片"：v0.15.3 返修在固定时点之外又加了**布局驱动**的
 * 重对齐（`ResizeObserver` 盯 `textarea.scrollHeight/clientWidth`），代码变长后
 * 固定窗口会把清理段（`removeEventListener`）截到窗口外，导致 3 条断言假失败
 * —— 判据应该跟着**代码结构**走，而不是跟着字符数走。
 */
function realignRegion(): string {
  const i = tsx.indexOf("const realignGen");
  expect(i, "缺少 realignGen（延时重对齐的代际标记）").toBeGreaterThan(-1);
  // 以该 effect 的依赖数组为右边界（`}, [viewMode, previewHtml, previewSourceMarkdown]);`）
  const boundary = tsx.indexOf("}, [viewMode, previewHtml, previewSourceMarkdown]);", i);
  expect(boundary, "找不到分屏同步 effect 的依赖数组（区域右边界）").toBeGreaterThan(i);
  return tsx.slice(i, boundary + 60);
}

// ═════════════════════════════════════════════════════════════
// ① 延时时点：单一来源 + ≥4 个不同时点
// ═════════════════════════════════════════════════════════════
describe("v0.15.3 · 缺陷 B 静态契约：延时时点的单一来源", () => {
  it("PREVIEW_REALIGN_DELAYS 是单一来源常量，且覆盖 0/160/480/1000/1600 五个时点", () => {
    // 为什么必须≥4 个不同时点：iframe 的 `doc.open()/write()` → body 就绪 → 贴标
    // （t≈480ms）→ mermaid/katex 异步渲染撑高（实测到 1427ms 仍有几何动作）是多段异步的，
    // 单点重试必然踩不到"内容已就绪"那一刻。实机取证：480ms 时右屏才从 0 变 7868。
    expect(Array.isArray(PREVIEW_REALIGN_DELAYS)).toBe(true);
    expect(PREVIEW_REALIGN_DELAYS.length).toBeGreaterThanOrEqual(4);
    // 去重后仍需 ≥4 个不同时点（防有人写成 [0,0,0,0] 凑个数）
    expect(new Set(PREVIEW_REALIGN_DELAYS).size).toBeGreaterThanOrEqual(4);
    // 实机取证决定的关键时点必须都在（480 = 贴标完成；1600 = 末次异步渲染之后）
    for (const d of [0, 480, 1600]) {
      expect(PREVIEW_REALIGN_DELAYS as readonly number[], `缺少关键时点 ${d}ms`).toContain(d);
    }
    // 升序是执行顺序契约（后一个时点必须比前一个晚，否则重试无意义）
    const sorted = [...PREVIEW_REALIGN_DELAYS].sort((a, b) => a - b);
    expect([...PREVIEW_REALIGN_DELAYS]).toEqual(sorted);
  });

  it("组件从 utils 模块 import 该常量，并用 `for (const d of PREVIEW_REALIGN_DELAYS)` 排定时器", () => {
    // 单一来源的意义：时点被探针验证后改一处即可，不能在组件里散落手写字面量
    // （散落字面量正是 v0.14.0 时代 finalize 里 timerAt(160/480/1000) 的写法，
    //  那次修好后模式切换路径并没有受益 —— 因为写的不是同一份常量）。
    expect(tsx, "EditorContainer 必须从 textOffsetRemap import 该常量").toMatch(
      /import\s*\{[^}]*PREVIEW_REALIGN_DELAYS[^}]*\}\s*from\s*["']\.\.\/\.\.\/utils\/textOffsetRemap["']/,
    );
    // 真正被使用（只 import 不调用是无效接线）
    expect(tsx).toMatch(/for\s*\(\s*const\s+d\s+of\s+PREVIEW_REALIGN_DELAYS\s*\)\s*runRealign\(d\)/);
  });

  it("组件里**不得**出现硬编码的 `runRealign(<数字>)`（必须走常量，否则又成分散字面量）", () => {
    // 否定式断言：这是"单一来源"的硬约束。允许 finalize 里旧的 timerAt(...) 保留
    // （那是预览开合路径上的另一条链路，不在本次返修范围），但 runRealign 的入参只能是常量。
    expect(tsx.match(/runRealign\(\s*\d+\s*\)/g), "发现硬编码时点的 runRealign 调用").toBeNull();
  });

  it("常量在 utils 侧确实以数组字面量定义（可被 import 断言，不是运行期计算出来的）", () => {
    // 若改成 Math.random/循环生成，上面的"单一来源"断言会失去意义（不可静态核对）。
    expect(util).toMatch(/export\s+const\s+PREVIEW_REALIGN_DELAYS\s*=\s*\[[^\]]*\]\s*as\s+const/);
  });
});

// ═════════════════════════════════════════════════════════════
// ② 定时器清理：必须有 clearTimeout（防泄漏 + 防旧轮次写坏新一轮）
// ═════════════════════════════════════════════════════════════
describe("v0.15.3 · 缺陷 B 静态契约：定时器清理与代际作废", () => {
  it("所有重对齐定时器集中登记在 realignTimers，并在 effect 清理函数里逐个 clearTimeout", () => {
    // 为什么必须清理：effect 依赖 `[viewMode, previewHtml, previewSourceMarkdown]`，
    // 模式来回切换会**频繁重跑**。不清理的话 1600ms 内可能堆几批定时器，
    // 旧批次会把新一轮刚对齐好的右屏又按旧左屏位置写一遍 → 用户看到"切完还在抖"。
    const region = realignRegion();
    expect(region, "缺少定时器登记数组").toMatch(
      /const\s+realignTimers\s*:\s*Array<ReturnType<typeof setTimeout>>\s*=\s*\[\]/,
    );
    expect(region, "每个定时器必须 push 进登记数组").toMatch(/realignTimers\.push\(timer\)/);
    // clearTimeout 必须在**清理函数**里（return () => {...}），而不是立即执行
    expect(region, "清理函数里必须逐个 clearTimeout").toMatch(
      /for\s*\(\s*const\s+t\s+of\s+realignTimers\s*\)\s*clearTimeout\(t\)/,
    );
    // 清理后清空数组，避免残留引用（长生命周期组件里数组会一直增长）
    expect(region, "清理后应清空数组").toMatch(/realignTimers\.length\s*=\s*0/);
  });

  it("代际标记：新一轮重对齐必须把上一轮整体作废（不只是清定时器）", () => {
    // 清定时器只挡住"尚未触发"的；已经在执行中的回调需要靠代际号判断。
    // `cancelled: realignCancelled || previewRealignGenRef.current !== realignGen`
    // 这一条正是 v0.15.1 滚动恢复"代际"同一套路（用户连续切模式时的经典缺陷）。
    const region = realignRegion();
    expect(region, "缺少代际自增").toMatch(/const\s+realignGen\s*=\s*\+\+previewRealignGenRef\.current/);
    expect(region, "每次回调必须校验代际").toMatch(
      /previewRealignGenRef\.current\s*!==\s*realignGen/,
    );
    expect(region, "卸载时置 cancelled").toMatch(/realignCancelled\s*=\s*true/);
  });

  it("重对齐调用的是 force 版入口（syncPreviewAfterToggle = syncToPreview(true)）", () => {
    // 为什么要 force：普通 syncToPreview 受**方向锁**（shouldAcceptScroll）约束，
    // 程序主动对齐不是用户滚动，必须跳过方向锁；但仍受 isScrollFrozen/isSyncing 守卫。
    const region = realignRegion();
    expect(region, "必须调用 force 版入口").toMatch(/syncPreviewAfterToggle\(\)/);
    expect(tsx, "force 入口定义必须存在").toMatch(
      /const\s+syncPreviewAfterToggle\s*=\s*\(\)\s*=>\s*syncToPreview\(true\)/,
    );
    // 且它注册进 ref（冻结窗那条路径共用同一个入口）
    expect(tsx).toMatch(/syncPreviewAfterToggleRef\.current\s*=\s*syncPreviewAfterToggle/);
  });

  it("重对齐发生在分屏同步 effect 内（依赖 viewMode，模式切换必然触发）", () => {
    // 关键契约：模式切换后必须真的会跑到这段逻辑。该 effect 的依赖里必须有 viewMode，
    // 且 effect 开头有 previewShown 守卫（未开预览时不该挂监听/排定时器）。
    const effectIdx = tsx.indexOf("const realignGen");
    expect(effectIdx).toBeGreaterThan(-1);
    // 向前找到该 effect 的开口与守卫
    const head = tsx.slice(Math.max(0, effectIdx - 30000), effectIdx);
    const lastEffectOpen = head.lastIndexOf("useEffect(() => {");
    expect(lastEffectOpen, "重对齐必须位于某个 useEffect 内").toBeGreaterThan(-1);
    const effectHead = head.slice(lastEffectOpen, lastEffectOpen + 400);
    expect(effectHead, "分屏同步 effect 必须有 previewShown 守卫").toMatch(
      /if\s*\(\s*!previewShown\s*\)\s*return/,
    );
    // 依赖数组含 viewMode（找该 effect 的收尾）
    const depIdx = tsx.indexOf("}, [viewMode, previewHtml, previewSourceMarkdown]);", effectIdx);
    expect(depIdx, "分屏同步 effect 的依赖数组必须含 viewMode").toBeGreaterThan(-1);
  });
});

// ═════════════════════════════════════════════════════════════
// ③ 用户滚动退场：输入事件判定 + 与 shouldContinue 关联
// ═════════════════════════════════════════════════════════════
describe("v0.15.3 · 缺陷 B 静态契约：用户主动滚动即退场", () => {
  it("挂 wheel / pointerdown / touchstart 三个输入事件（不用 scrollTop 差值判定）", () => {
    // 口径与语义地图 §4-31 一致：浏览器因 scrollHeight 收缩而**自动钳位** scrollTop
    // 不是用户操作，用差值判定会把钳位误判成"用户滚了"从而放弃还原。
    // 三个事件覆盖鼠标滚轮 / 拖滚动条与点击 / 触屏，缺任一种就有用户场景被漏掉。
    const region = realignRegion();
    expect(region).toMatch(/textarea\.addEventListener\("wheel",\s*markRealignUser/);
    expect(region).toMatch(/textarea\.addEventListener\("pointerdown",\s*markRealignUser/);
    expect(region).toMatch(/textarea\.addEventListener\("touchstart",\s*markRealignUser/);
    // 清理时必须解绑（否则 effect 重跑会重复叠加监听器）
    expect(region).toMatch(/textarea\.removeEventListener\("wheel",\s*markRealignUser/);
    expect(region).toMatch(/textarea\.removeEventListener\("pointerdown",\s*markRealignUser/);
    expect(region).toMatch(/textarea\.removeEventListener\("touchstart",\s*markRealignUser/);
  });

  it("用户滚动标记与取消判据**关联**进 shouldContinuePreviewRealign（不是只记不用）", () => {
    // 只挂监听不消费 = 用户滚了还会被程序改回去（"用户意图优先"失效）。
    // 契约：把 userScrolledRealign 作为 `userScrolled` 传进纯函数，且 cancelled 同时带代际。
    const region = realignRegion();
    const callIdx = region.indexOf("shouldContinuePreviewRealign({");
    expect(callIdx).toBeGreaterThan(-1);
    const call = region.slice(callIdx, callIdx + 320);
    expect(call, "必须把用户滚动标记传进判据").toMatch(/userScrolled:\s*userScrolledRealign/);
    expect(call, "cancelled 必须同时带代际与卸载标记").toMatch(
      /cancelled:\s*realignCancelled\s*\|\|\s*previewRealignGenRef\.current\s*!==\s*realignGen/,
    );
    expect(call, "必须传已耗时（窗口上限用）").toMatch(/elapsedMs:/);
    // 且判据为 false 时必须**提前返回**（不执行 syncPreviewAfterToggle）
    expect(region.slice(callIdx, callIdx + 900)).toMatch(/if\s*\(\s*!cont\s*\)/);
  });
});

// ═════════════════════════════════════════════════════════════
// ④ 纯函数：shouldContinuePreviewRealign
// ═════════════════════════════════════════════════════════════
describe("v0.15.3 · shouldContinuePreviewRealign 纯函数（三条终止条件）", () => {
  it("正常窗口内（未取消、用户未滚动、未超时）→ 继续", () => {
    // 基线：这才是重试链能跑起来的前提（0/160/480/1000/1600 全部落在 2500ms 内）。
    expect(shouldContinuePreviewRealign({ cancelled: false, userScrolled: false, elapsedMs: 0 })).toBe(true);
    expect(shouldContinuePreviewRealign({ cancelled: false, userScrolled: false, elapsedMs: 1600 })).toBe(true);
    // 窗口末点之前的最后一毫秒仍应继续（边界是 `<` 而非 `<=` 造成的语义要写清）
    expect(shouldContinuePreviewRealign({ cancelled: false, userScrolled: false, elapsedMs: 2499 })).toBe(true);
  });

  it("cancelled（卸载 / 新一代接管）→ 立即停止（即使其它条件都满足）", () => {
    // effect 清理后仍有在飞回调；不认 cancelled 会把已卸载组件的右屏写坏
    // （且旧轮次会和新轮次抢同一个 syncPreviewAfterToggleRef）。
    expect(shouldContinuePreviewRealign({ cancelled: true, userScrolled: false, elapsedMs: 0 })).toBe(false);
    expect(shouldContinuePreviewRealign({ cancelled: true, userScrolled: false, elapsedMs: 100 })).toBe(false);
  });

  it("userScrolled（用户主动滚动左屏）→ 立即停止，用户意图优先", () => {
    // 与 scrollFreezeRef 的"用户接管即放弃还原"同一条口径：
    // 用户已经滚到想看的地方，程序再改回去就是"抢滚动条"。
    expect(shouldContinuePreviewRealign({ cancelled: false, userScrolled: true, elapsedMs: 0 })).toBe(false);
    expect(shouldContinuePreviewRealign({ cancelled: false, userScrolled: true, elapsedMs: 480 })).toBe(false);
  });

  it("超过 2500ms 窗口 → 停止（兜底，防定时器链失控/永远在纠）", () => {
    // 末点时点 1600ms < 2500ms，故正常链路全部会执行；
    // 一旦因为性能抖动/大文档拖慢导致 elapsed 越界，就必须停手（否则长期和用户抢滚动）。
    expect(PREVIEW_REALIGN_WINDOW_MS).toBe(2500);
    expect(shouldContinuePreviewRealign({ cancelled: false, userScrolled: false, elapsedMs: 2500 })).toBe(false);
    expect(shouldContinuePreviewRealign({ cancelled: false, userScrolled: false, elapsedMs: 9999 })).toBe(false);
  });

  it("elapsedMs 非有限数（NaN）→ 停止（不把 NaN 当「还在窗口内」）", () => {
    // `performance.now()` 在某些 mock/测试环境里可能被替身成 undefined；
    // NaN 比较恒为 false，若实现写成 `!(elapsedMs >= WINDOW)` 就会**永远继续**。
    expect(shouldContinuePreviewRealign({ cancelled: false, userScrolled: false, elapsedMs: Number.NaN })).toBe(false);
    expect(shouldContinuePreviewRealign({ cancelled: false, userScrolled: false, elapsedMs: Infinity })).toBe(false);
  });

  it("纯函数性与单调性：三条终止条件互不干扰（任一为真即 false）", () => {
    // 组合矩阵：确保没有"某个条件把另一个条件短路掉"的实现错误。
    const rows = [
      { cancelled: true, userScrolled: true, elapsedMs: 0 },
      { cancelled: true, userScrolled: false, elapsedMs: 3000 },
      { cancelled: false, userScrolled: true, elapsedMs: 3000 },
      { cancelled: false, userScrolled: false, elapsedMs: 0 },
    ];
    expect(rows.map((r) => shouldContinuePreviewRealign(r))).toEqual([false, false, false, true]);
    // 同样输入重复调用结果一致（定时器回调会重复执行，必须幂等）
    expect(shouldContinuePreviewRealign(rows[3])).toBe(shouldContinuePreviewRealign(rows[3]));
  });

  it("PRIMARY 链路自检：PREVIEW_REALIGN_DELAYS 全部落在窗口内（否则末点永远不执行）", () => {
    // 这是两个常量之间的**跨常量不变式**：若有人把窗口改成 1200ms，
    // 1600ms 那个时点就永远不会触发（右屏在 mermaid 文档上仍会偏 5 行），
    // 而分开看两个常量都"看起来没问题"。这条把它们的耦合关系钉住。
    for (const d of PREVIEW_REALIGN_DELAYS) {
      expect(
        d,
        `时点 ${d}ms 超出重对齐窗口 ${PREVIEW_REALIGN_WINDOW_MS}ms → 该时点永远不会执行`,
      ).toBeLessThan(PREVIEW_REALIGN_WINDOW_MS);
    }
  });
});
