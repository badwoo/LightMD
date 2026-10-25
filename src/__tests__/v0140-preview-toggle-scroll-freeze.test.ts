/**
 * v0.14.0 第六批 —— 预览开合不再移动左屏滚动位置（反复开关不累积上漂）
 *
 * 用户原话：「文档拉到底，我在编辑模式不断重复关闭预览和打开预览的操作，
 * 即不断双击 shift 键，结果发现文档进度每一次会细微的往上滚动，这样文档不断
 * 在滚动就造成了阅读焦点不断的变。」
 *
 * ── 真机取证（scripts/v0140-probe-toggle-geometry.mjs / -scrollwriter.mjs）──
 * 修复前，文档在底部时开合一次预览：`scrollTop` 7582 → 7553.333（**每轮净丢
 * 28.67px**，且是带循环小数的值 → 必然有 JS 计算写回）。逐帧采样抓到的根因链：
 *
 *   ① 预览打开 → `.source-editor` 的 `padding-inline` 里含 `100%`，宽度一变就
 *      **瞬时重算**（实测 padding-left 582px → 30px，中间**没有过渡**）；
 *   ② 正文列宽因此瞬间跳变 → 软换行行数突变 → `scrollHeight` 8333 → 5954；
 *   ③ 浏览器把 `scrollTop` 钳到临时 max（7582 → 4702）；
 *   ④ 宽度过渡结束内容高度恢复 8833，但滚动位置已回不去，随后联动同步又按
 *      有损的行↔像素映射写了一次 → 停在被"吃掉"一截的位置；
 *   ⑤ 每次开关重复 ①~④ → 读者看到文档持续上移、阅读焦点乱跳。
 *
 * ── 修复（两层，本文件各锁一半）──────────────────────────────────
 *   · CSS 层（根因）：`padding-inline` 与两栏宽度用**同一条曲线同时长**过渡，
 *     正文列宽连续变化 → `scrollHeight` 全程平滑，不再被钳位。
 *   · 组件层（兜底）：开合期间开一个冻结窗口，窗口内左右联动同步与 ResizeObserver
 *     锚点补偿都不许改写左屏；窗口结束精确还原（原本贴底就对齐最新 max，
 *     普通位置写回原像素值），随后补一次左→右对齐让右屏跟上。
 *
 * ── 为什么是源码契约断言 ────────────────────────────────────────
 * 时长/曲线是 CSS 事实，冻结窗口是时序行为，jsdom 都不具备（不算样式、不跑布局、
 * 无 ResizeObserver 真实回调）。与 v0140-divider-preview-anim.test.ts、
 * v0140-block-scroll-align.test.ts 同款做法：读源码做契约断言。
 * 真实几何由上面两个探针在打包产物上验证（20 轮反复开合漂移 0.00px）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rawCss = readFileSync(join(here, "../styles/editor.css"), "utf8");
const rawTsx = readFileSync(join(here, "../components/editor/EditorContainer.tsx"), "utf8");

/** 去掉注释再断言：注释里刻意写了 "padding-inline" / "restore" 等字样解释原因，
 *  不去掉会把"解释"当成"实现"。 */
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, "");
const tsx = rawTsx.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** 取某个选择器的规则体（`^selector {` 精确匹配） */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, "m"));
  return m ? m[1] : "";
}

describe("v0.14.0 第六批 · CSS：padding-inline 必须参与宽度过渡（根因）", () => {
  it(".source-editor 的 padding-inline 仍按内容列居中推导（不能退化成固定值）", () => {
    const body = ruleBody(".source-editor");
    expect(body).toContain("padding-inline");
    // 居中推导公式：max(60px, calc((100% - 内容宽)/2 + 60px))
    expect(body).toMatch(/padding-inline:\s*max\(\s*60px,\s*calc\(\(100% - var\(--editor-content-max-width/);
  });

  it(".source-editor 必须给 padding-inline 加过渡（否则宽度变化时正文列宽瞬变）", () => {
    const body = ruleBody(".source-editor");
    // 缺陷正是"padding 随宽度瞬时重算"：必须有 padding-inline 的 transition
    expect(body).toMatch(/transition:[^;]*padding-inline/);
  });

  it("padding 过渡的时长与曲线必须与两栏宽度过渡完全一致（否则两栏相位差）", () => {
    const body = ruleBody(".source-editor");
    const m = body.match(/transition:[^;]*padding-inline\s+([\d.]+s)\s+(cubic-bezier\([^)]*\))/);
    expect(m).not.toBeNull();
    const [, dur, curve] = m!;
    // 两栏/分割条的宽度过渡（v0.14.0 需求3 定的 0.42s smoothstep）
    const shell = ruleBody(".split-preview-shell");
    expect(shell).toContain(`width ${dur} ${curve}`);
    const leftWrap = ruleBody(".editor-main-area > .source-editor-wrapper");
    expect(leftWrap).toContain(`width ${dur} ${curve}`);
  });
});

describe("v0.14.0 第六批 · 组件：预览开合期间的滚动冻结窗口", () => {
  it("存在冻结窗口状态（记录原位置 + 是否贴底 + 程序写入后的真实读数）", () => {
    expect(tsx).toMatch(/scrollFreezeRef\s*=\s*useRef</);
    expect(tsx).toMatch(/scrollTop:\s*number/);
    expect(tsx).toMatch(/atBottom:\s*boolean/);
    expect(tsx).toMatch(/programTop:\s*number/);
  });

  it("冻结窗口由 previewShown 变化触发，且只在编辑模式生效", () => {
    // 找一个 effect：依赖数组是 [previewShown]，且体内有 viewMode !== "edit" 的早退
    const m = tsx.match(/\},\s*\[previewShown\]\);/);
    expect(m).not.toBeNull();
    expect(tsx).toMatch(/if \(viewMode !== "edit"\) return;/);
  });

  it("左→右 / 右→左 两个联动同步方向都必须被冻结守卫拦住", () => {
    // syncToPreview（左→右）：冻结时不推右屏
    const syncToPreview = tsx.slice(tsx.indexOf("const syncToPreview = () =>"));
    expect(syncToPreview.slice(0, 700)).toMatch(/isScrollFrozen\(\)/);
    // syncToSource（右→左）：冻结时绝对不写左屏（这是累积上漂的直接来源）
    const syncToSource = tsx.slice(tsx.indexOf("const syncToSource = () =>"));
    expect(syncToSource.slice(0, 1400)).toMatch(/isScrollFrozen\(\)/);
  });

  it("宽度过渡期的 ResizeObserver 锚点补偿也必须被冻结守卫拦住", () => {
    // restoreTextAnchor 在 RO 回调里，宽度逐帧变化时会被调用；开关预览不改内容，
    // 此刻补偿带亚像素误差且会累积 → 冻结窗口内必须跳过
    const roIdx = tsx.indexOf("restoreTextAnchor(ta, textAnchorRef.current)");
    expect(roIdx).toBeGreaterThan(-1);
    const around = tsx.slice(Math.max(0, roIdx - 900), roIdx);
    expect(around).toMatch(/scrollFreezeRef\.current/);
  });

  it("贴底时还原到**最新 max**，非贴底时写回原像素值", () => {
    expect(tsx).toMatch(/cur\.atBottom \? max : Math\.min\(Math\.max\(0, cur\.scrollTop\), max\)/);
  });

  it("窗口内用户主动滚动优先：位置被外部改动就放弃还原（否则会「滚不动」）", () => {
    expect(tsx).toMatch(/Math\.abs\(ta\.scrollTop - cur\.programTop\) > 1\.5/);
  });

  it("窗口关闭后补一次左→右对齐（否则重开的右屏永远停在顶部）", () => {
    // 冻结期间 syncToPreview 被拦，而打开预览时 iframe 是新建的（停在 0）
    const finIdx = tsx.indexOf("const finalize = () =>");
    expect(finIdx).toBeGreaterThan(-1);
    const fin = tsx.slice(finIdx, finIdx + 2500);
    expect(fin).toMatch(/previewIframeRef\.current/);
    expect(fin).toMatch(/scrollTo\(0,/);
  });

  it("还原动作要打标记，避免其派发的 scroll 事件被当成用户滚动去推右屏", () => {
    expect(tsx).toMatch(/isFrozenRestoreRef\.current = true;/);
    // 标记必须在写入前后成对出现
    const setIdx = tsx.indexOf("isFrozenRestoreRef.current = true;");
    expect(tsx.slice(setIdx, setIdx + 400)).toContain("isFrozenRestoreRef.current = false;");
  });
});
