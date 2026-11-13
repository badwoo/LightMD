// @vitest-environment jsdom
/**
 * v0.17.0 第四轮 · T2 `fix-scroll-r4` · 用户第 1 项 + 第 3 项 + P0 斜杠崩溃
 *
 * ## 本文件锁的契约（全部来自本轮**探针实测**，不是推演）
 *
 * | 契约 | 对应缺陷 | 实测证据 |
 * |---|---|---|
 * | `isRealTextarea` 守卫存在且被**所有**读取点使用 | **P0：空行行首 `/` → 整树崩溃** | `v0170-r4-slash-rec.mjs` |
 * | 语法栏插入走最小 diff（`applyEdit` 单事务） | #1 语法栏 174/257px 抖动 | `v0170-r4-scroll.mjs` |
 * | 最小 diff 之后**不再抢帧**（取消 60/160ms 重试） | #1 第二轮根因：3 写者 × 3 轮 | `v0170-r4-writer-attrib.mjs` |
 * | 撤销恢复的"小偏差不纠"阈值 | #3 撤销 16px + 回摆 | `v0170-r4-undo-attr.mjs` |
 * | `docChangedForSlash` 判据 | Esc 自噬环路（菜单关不掉） | `v0170-r4-slash-verify.mjs` S6 |
 *
 * ## 为什么"源码契约测试"在这里是合理的（并且必须诚实声明边界）
 *
 * 缺陷发生在三个 jsdom **无法建模**的东西里：
 * ① CM6 的 heightMap 分段测量（虚拟滚动）——jsdom 里 `coordsAtPos` 直接抛；
 * ② 逐帧 rAF 时序（3 写者在 3ms 内互斗）——jsdom 没有真实帧；
 * ③ `élement.scrollTop` 的钳位语义——jsdom 里是纯赋值。
 *
 * 所以本文件分两层：
 * - **纯函数层**：`computeMinimalEdit` 的最小化契约（这是"不整篇替换"的正确性基础）；
 * - **源码契约层**：锁住"哪几行防线必须存在、顺序必须对"
 *   —— 一旦有人删掉/调换，**探针会在真机上复现**，但单测能立刻红，不用等真机。
 *
 * ⚠️ 边界：源码契约只能证明"代码形态在"，**不能证明行为正确**。
 * 行为正确性由 `scripts/v0170-r4-scroll.mjs`（5/5）、`v0170-r4-undo-matrix.mjs`（8/8）、
 * `v0170-r4-slash-verify.mjs`（9/9）的逐帧数据负责。两者缺一不可
 * （R3 踩过"纯函数测试绿但 CSS 零 import"的坑：`v0152-mode-slide.test.ts`）。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { computeMinimalEdit, isRealTextarea } from "../components/editor/panes/sourcepane/SourcePane";
import { isRealTextarea as isRealTextareaSlash } from "../components/editor/SlashCommand";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const SOURCE_PANE = "src/components/editor/panes/sourcepane/SourcePane.tsx";
const MODE_SYNC = "src/components/editor/panes/modesync/ModeSync.tsx";
const SLASH = "src/components/editor/SlashCommand.tsx";
const EDITOR_CONTAINER = "src/components/editor/EditorContainer.tsx";

// ══════════════════════════════════════════════════════════════════════════
// A. P0：isRealTextarea 守卫（CM6 下 sourceTextareaRef 是中性 div）
// ══════════════════════════════════════════════════════════════════════════
describe("A. P0 斜杠崩溃：isRealTextarea 守卫的判定语义", () => {
  /**
   * 这条守卫的全部理由：CM6 下 `sourceTextareaRef.current` 是
   * `<div class="source-editor source-editor-cm6">`，**truthy 但没有 .value**。
   * 旧守卫 `if (!textarea) return;` 完全失效 → `.value.substring()` 抛 TypeError
   * → 因为发生在 render 期（`position` 的 useMemo），ErrorBoundary 接管**整棵树**。
   */
  it("div（CM6 中性宿主）→ 不是真 textarea", () => {
    const div = document.createElement("div");
    div.className = "source-editor source-editor-cm6";
    expect(isRealTextarea(div)).toBe(false);
    expect(isRealTextareaSlash(div)).toBe(false);
  });

  it("div 带 value 属性但类型不是 string → 仍判 false（防止半吊子实现）", () => {
    const div = document.createElement("div") as unknown as { value: unknown };
    div.value = 123;
    expect(isRealTextarea(div)).toBe(false);
  });

  it("真 textarea → true", () => {
    const ta = document.createElement("textarea");
    expect(isRealTextarea(ta)).toBe(true);
    expect(isRealTextareaSlash(ta)).toBe(true);
  });

  it("null / undefined → false（不抛）", () => {
    expect(isRealTextarea(null)).toBe(false);
    expect(isRealTextarea(undefined)).toBe(false);
    expect(isRealTextareaSlash(null)).toBe(false);
    expect(isRealTextareaSlash(undefined)).toBe(false);
  });

  it("两个模块导出的是**同一语义**的守卫（防止将来改一处漏一处）", () => {
    const cases: unknown[] = [null, undefined, document.createElement("textarea"), document.createElement("div")];
    for (const c of cases) {
      expect(isRealTextarea(c)).toBe(isRealTextareaSlash(c));
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// B. SlashCommand 源码契约：不许再出现裸读 .value / .selectionStart
// ══════════════════════════════════════════════════════════════════════════
describe("B. SlashCommand：所有文本/选区读取必须经 readText/readSelection", () => {
  const src = read(SLASH);

  it("导出了 isRealTextarea 守卫", () => {
    expect(src).toMatch(/export function isRealTextarea\(/);
  });

  it("存在统一的 readText / readSelection 入口", () => {
    expect(src).toMatch(/const readText = useCallback\(/);
    expect(src).toMatch(/const readSelection = useCallback\(/);
  });

  it("★ 守卫必须包住所有裸读点：每处 `textarea.value` 前都有 isRealTextarea 判断", () => {
    /**
     * 允许的形态只有两种：
     * 1. `isRealTextarea(textarea) ? textarea.value : ...`
     * 2. `return isRealTextarea(textarea) ? textarea.value : "";`
     * 任何 `textarea.value` 出现在没有 isRealTextarea 的同一行/上一行 = 潜在崩溃点。
     */
    const lines = src.split("\n");
    const offenders: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!/\btextarea\.value\b/.test(line)) continue;
      if (line.trim().startsWith("*") || line.trim().startsWith("//")) continue; // 注释不算
      const ctx = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
      if (!/isRealTextarea/.test(ctx)) offenders.push(`L${i + 1}: ${line.trim()}`);
    }
    expect(offenders, `这些行裸读了 textarea.value（P0 崩溃点）：\n${offenders.join("\n")}`).toEqual([]);
  });

  it("★ 渲染守卫用 hasSource（provider 或真 textarea），不再用 `!textarea`", () => {
    expect(src).toMatch(/const hasSource = !!getText \|\| isRealTextarea\(textarea\)/);
    expect(src).toMatch(/if \(!hasSource \|\| filteredItems\.length === 0\) return null/);
  });

  it("position 的 useMemo 有 try/catch 兜底（菜单定位再坏也不许让 render 抛错）", () => {
    const idx = src.indexOf("const position = useMemo(");
    expect(idx).toBeGreaterThan(0);
    const block = src.slice(idx, idx + 2200);
    expect(block).toMatch(/catch\s*\{/);
  });

  it("CM6 路径的键盘监听绑到 .cm-content（宿主 div 本身收不到键盘事件）", () => {
    expect(src).toMatch(/\.querySelector\?\.\("\.cm-content"\)/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// C. #1：语法栏插入必须走最小 diff（不是整篇 setSourceContent）
// ══════════════════════════════════════════════════════════════════════════
describe("C. #1 语法辅助栏：ModeSync.insertHandler 必须补最小 diff 落地", () => {
  const src = read(MODE_SYNC);
  const handlerStart = src.indexOf("const insertHandler = (");
  const handlerEnd = src.indexOf("setSourceInsertHandler(insertHandler)");
  const body = src.slice(handlerStart, handlerEnd > handlerStart ? handlerEnd : handlerStart + 12000);

  it("insertHandler 内存在源面是实现判断的守卫", () => {
    expect(body).toMatch(/sourceSurface\.impl === "cm6"/);
  });

  it("★ 存在 `sourceSurface.applyEdit(` 调用（最小 diff 走单事务）", () => {
    expect(body).toMatch(/sourceSurface\.applyEdit\(\{/);
    expect(body).toMatch(/kind:\s*"edit"/);
  });

  it("★★ 顺序铁律：`applyEdit` 必须在 `setSourceContent(newContent)` **之后**", () => {
    /**
     * 为什么这条顺序不能反（上一轮踩过）：
     * 必须先让 React state / sourceContentRef 指向新文本，受控写入 effect 才会认为
     * "已经是目标值"而**跳过整篇 setText**；反过来先 applyEdit 再 setSourceContent，
     * effect 会再写一次整篇 → 最小 diff 白做（scrollHeight 照样塌）。
     */
    const setIdx = body.indexOf("setSourceContent(newContent)");
    const editIdx = body.indexOf("sourceSurface.applyEdit({");
    expect(setIdx).toBeGreaterThan(0);
    expect(editIdx).toBeGreaterThan(0);
    expect(editIdx, "applyEdit 必须在 setSourceContent 之后").toBeGreaterThan(setIdx);
  });

  it("最小 diff 有『改动量预算』（超过 1/4 退回整篇路径，不做奇怪的局部编辑）", () => {
    expect(body).toMatch(/budget/);
    expect(body).toMatch(/\/\s*4/); // Math.max(64, Math.floor(... / 4))
  });

  it("注释写明『有意内联而非跨模块 import』及其原因（避免后人误改回 import）", () => {
    expect(body).toMatch(/内联/);
    expect(body).toMatch(/EditorContainer/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// D. #1 第二轮：最小 diff 成功后不许再抢帧
// ══════════════════════════════════════════════════════════════════════════
describe("D. restoreAfterDiscreteEdit：最小 diff 之后不再抢帧", () => {
  const src = read(SOURCE_PANE);
  const fnStart = src.indexOf("const restoreAfterDiscreteEdit = (");
  expect(fnStart).toBeGreaterThan(0);
  const body = src.slice(fnStart, fnStart + 9000);

  it("签名新增 minimalApplied 参数（默认 false，保持旧路径行为）", () => {
    expect(body).toMatch(/minimalApplied = false/);
  });

  it("★ minimalApplied 分支里**不调用** scrollToOffset（不主动滚，只纠偏）", () => {
    /**
     * 实测依据（`v0170-r4-writer-attrib.mjs`）：
     * 修复前 3 个写者 × 3 轮 = 6 次写入、两个方向交替(3617→3738→3703→3738→3703…)。
     * 其中"我们"那部分是 `scrollToOffset(center:true)` + 二次精修 setScrollTop。
     * 最小 diff 之后 CM6 已经把视口放对了，再 scrollToOffset 就是抢帧。
     */
    const minimalBranch = body.slice(
      body.indexOf("if (minimalApplied)"),
      body.indexOf("// 否则：**一次写入都不产生**") > 0
        ? body.indexOf("// 否则：**一次写入都不产生**")
        : undefined,
    );
    expect(minimalBranch.length).toBeGreaterThan(50);
    expect(minimalBranch, "minimalApplied 分支不应再调 scrollToOffset").not.toMatch(/scrollToOffset\(/);
  });

  it("★ minimalApplied 时**取消** 60/160ms 两轮重试（中间态不存在，重试只增加写入）", () => {
    expect(body).toMatch(/if \(!minimalApplied\)\s*\{[\s\S]{0,200}setTimeout\(apply, 60\)/);
  });

  it("兜底阈值是**半个视口**量级（不是 24px 那种『接近一行』的容差）", () => {
    /**
     * 24px 那版实测**仍然写了一次 58px**：插入的 3 行在锚点上方 → 锚点本来就要下移
     * ~3 行高，而 viewportY 是插入**前**的期望值 —— 拿旧期望比新现实必然"偏"。
     * 那个"纠偏"实际上把已经正确的视口又动了一次。
     */
    expect(body).toMatch(/clientHeight\s*\/\s*2/);
  });

  it("所有离散编辑调用点都把 minimalOk 透传下去（6 处）", () => {
    const calls = src.match(/restoreAfterDiscreteEdit\([^)]*minimalOk\)/g) ?? [];
    expect(calls.length, "每个 applyMinimalDiscreteEdit 调用点都要透传 minimalOk").toBeGreaterThanOrEqual(6);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// E. #3：阅读面撤销的"小偏差不纠"
// ══════════════════════════════════════════════════════════════════════════
describe("E. restorePreviewScrollFromAnchor：小偏差不纠（#3 撤销跳动）", () => {
  const src = read(SOURCE_PANE);
  const fnStart = src.indexOf("const restorePreviewScrollFromAnchor = (");
  expect(fnStart).toBeGreaterThan(0);
  const body = src.slice(fnStart, fnStart + 4000);

  it("★ 存在 rescueThreshold 判据，且在赋值 scrollTop **之前** return", () => {
    /**
     * 实测依据（`v0170-r4-undo-attr.mjs`，标题场景）：
     * ```
     * t2242: st1959 / 锚段Y 400.67 / sh 5151   ← 撤销本身已把锚段放对
     * t2259: st1946 / 锚段Y 413.67 / sh 5151   ← 我们写 st−13，把锚段推走 13px
     * ```
     * 回退该判据后：撤销段净位移从 −16（正确）变成 −3（差 13px）= 内容真的漂了。
     */
    expect(body).toMatch(/const delta = top - container\.scrollTop/);
    expect(body).toMatch(/rescueThreshold/);
    expect(body).toMatch(/if \(Math\.abs\(delta\) <= rescueThreshold\) return;/);
    const guardIdx = body.indexOf("if (Math.abs(delta) <= rescueThreshold) return;");
    const assignIdx = body.indexOf("container.scrollTop = top;");
    expect(assignIdx, "写 scrollTop 必须在守卫之后").toBeGreaterThan(guardIdx);
  });

  it("阈值下限被钳到 ≥120px（视口极小时也不能退化成『每帧都写』）", () => {
    expect(body).toMatch(/Math\.max\(120,/);
  });

  it("保留 v0.15.1『撤销后贴底』的防线：仍会在大偏差时纠正", () => {
    // 不能改成"完全不写"，否则 v0.15.1 修过的"撤销一次就滚到底"会回归
    expect(body).toMatch(/container\.scrollTop = top;/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// F. Esc 自噬环路：docChangedForSlash 判据
// ══════════════════════════════════════════════════════════════════════════
describe("F. 斜杠触发判据：纯选区变更不得重开菜单（Esc 关不掉的根因）", () => {
  const src = read(SOURCE_PANE);

  it("★ 存在 docChangedForSlash 判据，且同时排除 programmatic 写入", () => {
    /**
     * 自噬环路（`v0170-r4-slash-verify.mjs` S6 实测 menu 1→1）：
     * ```
     * Esc → onClose → setSlashCommandOpen(false)
     *     → handleSlashClose 的 rAF 恢复光标 → surface.setSelection()
     *     → CM6 dispatch 纯选区事务 → onDidChange(docChanged=false)
     *     → applySourceInput → findSlashTrigger(文本,col=1) 命中 → setSlashCommandOpen(true)
     * ```
     * textarea 路径不受影响（setSelectionRange 不发 input），**只有 CM6 会"Esc 后弹回来"**。
     */
    expect(src).toMatch(/const docChangedForSlash = opts\?\.docChanged !== false && opts\?\.origin !== "programmatic"/);
  });

  it("判据被接在 setSlashCommandOpen(true) 的条件上", () => {
    expect(src).toMatch(/if \(docChangedForSlash && trigger\.trigger && !isInCodeBlock/);
  });

  it("textarea 路径保持零行为变化：缺省 docChanged=undefined 视为 true", () => {
    // `!== false` 的写法保证 undefined → true（textarea 的 onChange 天然只在值变时触发）
    expect(src).toMatch(/opts\?\.docChanged !== false/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// G. EditorContainer 接线：SlashCommand 必须拿到纯值 provider
// ══════════════════════════════════════════════════════════════════════════
describe("G. EditorContainer：SlashCommand 注入 getText / getSelection", () => {
  const src = read(EDITOR_CONTAINER);

  it("★ 渲染处同时传 getText 与 getSelection（CM6 下不再直读 DOM）", () => {
    const idx = src.indexOf("<SlashCommand");
    expect(idx).toBeGreaterThan(0);
    const block = src.slice(idx, idx + 700);
    expect(block).toMatch(/getText=\{\(\) => sourceSurface\.getText\(\)\}/);
    expect(block).toMatch(/getSelection=\{\(\) => sourceSurface\.getSelection\(\)\}/);
    expect(block).toMatch(/textarea=\{sourceTextareaRef\.current\}/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// H. 纯函数：computeMinimalEdit 的最小化契约（#1 正确性的基础）
// ══════════════════════════════════════════════════════════════════════════
describe("H. computeMinimalEdit：语法栏插入的最小 diff 契约", () => {
  const DOC = "第一段内容\n第二段内容\n第三段内容\n";

  it("行内插入 `****` → 只替换 4 个字符，不是整篇", () => {
    const at = DOC.indexOf("第二段");
    const after = DOC.slice(0, at) + "****" + DOC.slice(at);
    const e = computeMinimalEdit(DOC, after);
    expect(e).not.toBeNull();
    expect(e!.text).toBe("****");
    expect(e!.from).toBe(at);
    expect(e!.to).toBe(at);
    // 关键：改动量远小于全文，applyEdit 才不会让 CM6 重估 heightMap
    expect(e!.text.length).toBeLessThan(DOC.length / 4);
  });

  it("多行模板插入（代码块 `\\n```\\n\\n```\\n`）→ 仍是最小替换", () => {
    const at = DOC.indexOf("第二段");
    const ins = "\n```\n\n```\n";
    const after = DOC.slice(0, at) + ins + DOC.slice(at);
    const e = computeMinimalEdit(DOC, after);
    expect(e).not.toBeNull();
    expect(e!.text).toBe(ins);
  });

  it("公共前缀/后缀都被夹掉（不把未变的部分算进替换）", () => {
    const before = "AAAAxxxxBBBB";
    const after = "AAAAyyyyBBBB";
    const e = computeMinimalEdit(before, after);
    expect(e).toEqual({ from: 4, to: 8, text: "yyyy", caret: 8 });
  });

  it("改动超过 1/4 → 返回 null（退回整篇路径，不做奇怪的局部编辑）", () => {
    const before = "a".repeat(100);
    const after = "b".repeat(100);
    expect(computeMinimalEdit(before, after)).toBeNull();
  });

  it("空 ↔ 非空 → null（整篇语义）", () => {
    expect(computeMinimalEdit("", "abc")).toBeNull();
    expect(computeMinimalEdit("abc", "")).toBeNull();
  });

  it("相同文本 → null", () => {
    expect(computeMinimalEdit(DOC, DOC)).toBeNull();
  });

  it("null / undefined 入参不抛（防御性）", () => {
    expect(() => computeMinimalEdit(null as unknown as string, "abc")).not.toThrow();
    expect(() => computeMinimalEdit("abc", undefined as unknown as string)).not.toThrow();
  });

  it("小改动时 caret 落在插入内容末尾", () => {
    const e = computeMinimalEdit("prefix_OLD_suffix", "prefix_NEW_suffix");
    expect(e).not.toBeNull();
    expect(e!.caret).toBe(e!.from + e!.text.length);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// I. 回归防线：不要为了修 #1/#3 把"整篇 setText"重新引入
// ══════════════════════════════════════════════════════════════════════════
describe("I. 回归防线：最小 diff 路径不得退化成整篇 setText", () => {
  const src = read(SOURCE_PANE);
  const sync = read(MODE_SYNC);

  it("ModeSync.insertHandler 内不出现 sourceSurface.setText(（必须是 applyEdit）", () => {
    const start = sync.indexOf("const insertHandler = (");
    const end = sync.indexOf("setSourceInsertHandler(insertHandler)");
    const body = sync.slice(start, end > start ? end : start + 12000);
    expect(body).not.toMatch(/sourceSurface\.setText\(/);
  });

  it("applyMinimalDiscreteEdit 只在 cm6 生效（textarea 的受控赋值本身就不需要）", () => {
    const idx = src.indexOf("const applyMinimalDiscreteEdit = (");
    const body = src.slice(idx, idx + 1600);
    expect(body).toMatch(/if \(sourceSurface\.impl !== "cm6"\) return false;/);
  });

  it("applyMinimalDiscreteEdit 返回 boolean（调用方据此决定是否放弃抢帧）", () => {
    const idx = src.indexOf("const applyMinimalDiscreteEdit = (");
    const body = src.slice(idx, idx + 1600);
    expect(body).toMatch(/\): boolean =>/);
    expect(body).toMatch(/return true;/);
  });
});
