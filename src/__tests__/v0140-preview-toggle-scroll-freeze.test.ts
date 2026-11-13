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
const rawTsx = readFileSync(join(here, "../components/editor/EditorContainerSource.ts.txt"), "utf8");

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

describe("v0.14.0 第六/七批 · 组件：预览开合期间的滚动冻结窗口", () => {
  it("存在冻结窗口状态（原位置 + 是否贴底 + 视口中央内容锚点 + 真实读数）", () => {
    expect(tsx).toMatch(/scrollFreezeRef\s*=\s*useRef</);
    expect(tsx).toMatch(/scrollTop:\s*number/);
    expect(tsx).toMatch(/atBottom:\s*boolean/);
    expect(tsx).toMatch(/anchor:\s*TextContentAnchor \| null/);
    expect(tsx).toMatch(/programTop:\s*number/);
  });

  it("非底部必须捕获视口中央内容锚点（不是像素）", () => {
    // 核心契约：宽度变化后按"眼前中间那行字"还原，否则 3.1 会跳到 3.3
    //
    // v0.17.0 P1-3 更新：源码面几何改经 `sourceGeometry`（CM6 下没有可度量的 textarea）。
    // 契约不变 —— 中央锚点仍必须是**内容锚**（`captureTextAnchor` / `captureAt`），
    // 只是两条实现路径分开：真 textarea 走 mirror，CM6 走 `coordsAtPos` + 行轴。
    expect(tsx).toMatch(/ta\s*\n?\s*\?\s*captureTextAnchor\(ta, ta\.clientHeight \/ 2\)\s*\n?\s*:\s*sourceGeometry\.captureAt\(/);
    /**
     * v0.17.0 R3 第三轮（用户第 12 项）更新：还原动作从「直接调 `restoreTextAnchor(ta, cur.anchor)`」
     * 改为「先算后写」—— 经 `sourceGeometry.scrollTopForAnchor(cur.anchor)` 只**算**目标像素，
     * 与当前值比较后偏离超阈值才写一次。
     *
     * 为什么要改：实测预览开合窗口内 `setScrollTop`（我们）与 `measure`（CM6）交替写 7 次、
     * 含同方向反拉（4471→4442→4558），产生 4 次方向反转。**写一次就产生一次可见位移**，
     * 哪怕随后拉回用户也看到那一帧的抖。改成"先算后写 + 每帧至多一写"后反转 4→2。
     * 详见 `_plan/v0170-r3-t2-scroll-jitter.md` §5。
     *
     * **契约不变**：还原依据仍是**内容锚**（`cur.anchor` → `scrollTopForAnchor`），不是裸像素。
     * textarea 真元素路径仍直连 `restoreTextAnchor`（见下方断言）。
     */
    expect(tsx).toMatch(/sourceGeometry\.scrollTopForAnchor\(cur\.anchor\)/);
    // textarea（真元素）路径的既有直连实现必须保留，不得被"先算后写"顺手删掉
    expect(tsx).toMatch(/restoreTextAnchor\(ta, anchor\)/);
    // 贴顶/贴底两端不取中央锚点（否则会把文档从顶部拉下来）
    expect(tsx).toMatch(/const atTop = frozenTop <= 2;/);
    expect(tsx).toMatch(/const anchor = atBottom \|\| atTop/);
  });

  it("冻结窗口只由编辑模式内**单纯**开合预览触发，不参与阅读↔编辑切换", () => {
    // 依赖里必须有 viewMode，并用 modeChanged 排除模式切换（否则会覆盖 applyScroll 的进度恢复）
    expect(tsx).toMatch(/\},\s*\[previewShown, viewMode\]\);/);
    const idx = tsx.indexOf("const modeChanged = viewMode !== freezePrevViewModeRef.current;");
    expect(idx).toBeGreaterThan(-1);
    expect(tsx.slice(idx, idx + 900)).toMatch(/if \(modeChanged \|\| !shownChanged\) return;/);
  });

  it("左→右 / 右→左 两个联动同步方向都必须被冻结守卫拦住", () => {
    const syncToPreview = tsx.slice(tsx.indexOf("const syncToPreview = (force = false) =>"));
    expect(syncToPreview.slice(0, 600)).toMatch(/isScrollFrozen\(\)/);
    const syncToSource = tsx.slice(tsx.indexOf("const syncToSource = () =>"));
    expect(syncToSource.slice(0, 1400)).toMatch(/isScrollFrozen\(\)/);
  });

  it("宽度过渡期的 ResizeObserver 锚点补偿也必须被冻结守卫拦住", () => {
    const roIdx = tsx.indexOf("restoreTextAnchor(ta, textAnchorRef.current)");
    expect(roIdx).toBeGreaterThan(-1);
    const around = tsx.slice(Math.max(0, roIdx - 900), roIdx);
    expect(around).toMatch(/scrollFreezeRef\.current/);
  });

  it("窗口内用户主动滚动/输入优先（用输入事件判断，不把布局钳位误判成用户滚动）", () => {
    // 旧实现用 programTop 差值判断，宽度收缩导致浏览器自动钳位时会被误判 → 中央内容跳走
    expect(tsx).toMatch(/const abort = \(\) => \{/);
    // v0.17.0 P1-3 更新：事件宿主从 `textarea` 改为 `host`（= `sourceGeometry.host()`）。
    // 语义不变且更正确 —— 真 textarea 下 host 就是 textarea 本身；
    // CM6 下 host 是 `.cm-content` 的宿主 div，滚轮/按键都从这里冒泡上来
    //（绑 textarea 在 CM6 下等于**什么都没绑**）。
    expect(tsx).toMatch(/host\.addEventListener\("wheel", abort/);
    expect(tsx).toMatch(/host\.addEventListener\("keydown", onKeyDown\)/);
    // 双击 Shift 的第二次按键不能取消还原（否则又变回"关一次跳一次"）
    expect(tsx).toMatch(/k === "Shift" \|\| k === "Control"/);
    expect(tsx).toMatch(/let abortedByUser = false;/);
  });

  it("窗口关闭后用块锚点映射主动对齐右屏（不是百分比粗对齐）", () => {
    expect(tsx).toMatch(/syncPreviewAfterToggleRef/);
    expect(tsx).toMatch(/const syncPreviewAfterToggle = \(\) => syncToPreview\(true\);/);
    const finIdx = tsx.indexOf("const finalize = () =>");
    expect(finIdx).toBeGreaterThan(-1);
    const fin = tsx.slice(finIdx, finIdx + 1800);
    expect(fin).toMatch(/syncPreviewAfterToggleRef\.current\?\.\(\)/);
    // 必须在 iframe 异步渲染后重试，否则右屏在长文档上仍有几十像素偏差
    expect(fin).toMatch(/timerAt\(1000, syncRight\)/);
  });

  it("关窗后的最终裁决校验按同一内容锚点幂等拉回（兜住迟到的右→左同步）", () => {
    const vIdx = tsx.indexOf("const verifyAfterFinalize = (");
    expect(vIdx).toBeGreaterThan(-1);
    const verify = tsx.slice(vIdx, vIdx + 1600);
    expect(verify).toMatch(/restoreTextAnchor\(ta, anchor\)/);
    // 调用点在 finalize 里（verify 定义之前），断言全文存在即可
    expect(tsx).toMatch(/verifyAfterFinalize\(wasAtBottom, centerAnchor, expected, 5\)/);
  });

  it("还原动作要打标记，避免其派发的 scroll 事件被当成用户滚动去推右屏", () => {
    /**
     * v0.17.0 R3 第三轮更新：标记的**置真/复位**从"线性两句"改为 `try { … } finally { … }`。
     *
     * 为什么更好：`restore()` 现在内部有多条 `return`（贴底 / 有锚 / 兜底三路，
     * 见 `_plan/v0170-r3-t2-scroll-jitter.md` §5.3）。若仍用线性写法，
     * 每条 `return` 前都必须手动复位 —— 漏一处就会让标记**永久为真**，
     * 之后所有 scroll 事件都被当成"还原派发的"而忽略联动（右屏再也不跟随）。
     * `finally` 保证任一路径退出都复位。
     *
     * **契约不变**：置真期间派发的 scroll 事件仍被忽略（`isFrozenRestoreRef` 的用途未变）。
     */
    expect(tsx).toMatch(/isFrozenRestoreRef\.current = true;/);
    expect(tsx).toMatch(/isFrozenRestoreRef\.current = false;/);
    // 复位必须在 finally 里（保证所有 return 路径都复位），而不是可能被 return 跳过的线性语句
    const setIdx = tsx.indexOf("isFrozenRestoreRef.current = true;");
    expect(tsx.slice(setIdx, setIdx + 1800)).toMatch(/finally\s*\{\s*isFrozenRestoreRef\.current = false;/);
  });
});
