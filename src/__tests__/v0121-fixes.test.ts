/**
 * v0.12.1 需求2 & 需求3
 *
 * 需求2：文件夹展开子文件夹动画再放慢 50%
 *   v0.12.0 已放慢过一次（450→675 / 420→630），本次再 ×1.5（675→1013 / 630→945）。
 *   JS 常量（FileTree.tsx 的 TREE_SLIDE_*_MS 驱动容器高度过渡）与 CSS 关键帧时长
 *   必须严格同步，否则出现"容器到位、子节点还在飘"的错位。
 *
 * 需求3：编辑模式的可滚动区域 = 整个编辑区（滚动条贴最右），与阅读模式一致
 *   旧实现：wrapper 上 maxWidth + margin:auto，textarea（=滚动容器）只有 960px 宽
 *          → 滚动条停在正文右缘；
 *   新实现：textarea 铺满编辑区（滚动条贴最右），正文靠 padding-inline 居中。
 *   注意：正文观感不变、ghost/专注遮罩仍与 textarea 同构（padding 由
 *   syncTextareaMetrics 从计算样式复制）。
 */
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readSrc = (rel: string) => readFileSync(join(root, rel), "utf-8");

const fileTreeSrc = readSrc("src/components/sidebar/FileTree.tsx");
const fileTreeCss = readSrc("src/components/sidebar/FileTree.css");
const editorCss = readSrc("src/styles/editor.css");
const containerSrc = readSrc("src/components/editor/EditorContainerSource.ts.txt");

// ─── 需求2：文件夹动画再放慢 50% ───────────────────────────

describe("v0.12.1 需求2：文件夹展开/收起动画再放慢 50%", () => {
  it("JS 常量：675 → 1013、630 → 945（即再 ×1.5）", () => {
    expect(fileTreeSrc).toContain("export const TREE_SLIDE_EXPAND_MS = 1013;");
    expect(fileTreeSrc).toContain("export const TREE_SLIDE_COLLAPSE_MS = 945;");
    // 与 v0.12.0 的基准值保持严格的 1.5 倍关系（四舍五入到整数毫秒）
    expect(Math.round(675 * 1.5)).toBe(1013);
    expect(Math.round(630 * 1.5)).toBe(945);
  });

  it("CSS 关键帧时长与 JS 常量同步（展开 1.013s / 收起 0.945s）", () => {
    expect(fileTreeCss).toMatch(/\.filetree-children-slide \{\s*animation: tree-node-slide-in 1\.013s ease;/);
    expect(fileTreeCss).toMatch(
      /\.filetree-children-slide-out \{\s*animation: tree-node-slide-out 0\.945s ease forwards;/,
    );
  });

  it("容器高度过渡仍由 JS 常量驱动（两处 transition 都引用常量）", () => {
    expect(fileTreeSrc).toContain("el.style.transition = `height ${TREE_SLIDE_EXPAND_MS}ms ease`;");
    expect(fileTreeSrc).toContain("el.style.transition = `height ${TREE_SLIDE_COLLAPSE_MS}ms ease`;");
    // 收起动画播完才卸载子节点（时长常量即卸载定时器的时间）
    expect(fileTreeSrc).toContain("}, TREE_SLIDE_COLLAPSE_MS);");
  });

  it("只影响文件夹展开动画，不动其它动画（搜索面板/条目/栏目）", () => {
    // 搜索面板仍为 220/180ms
    expect(fileTreeSrc).toContain("export const SEARCH_PANEL_IN_MS = 220;");
    expect(fileTreeSrc).toContain("export const SEARCH_PANEL_OUT_MS = 180;");
    // 条目滑出/收起仍是 600/400ms（不随本次需求变化）
    expect(fileTreeSrc).toContain("const ITEM_SLIDE_OUT_MS = 600;");
    expect(fileTreeSrc).toContain("const ITEM_COLLAPSE_MS = 400;");
  });
});

// ─── 需求3：编辑模式滚动区域 ────────────────────────────────

describe("v0.12.1 需求3：编辑模式滚动条移到最右（整区可滚动）", () => {
  it(".source-editor：铺满宽度 + 内容靠 padding 居中（不再 max-width + margin auto）", () => {
    const idx = editorCss.indexOf("\n.source-editor {");
    expect(idx).toBeGreaterThan(-1);
    const block = editorCss.slice(idx, editorCss.indexOf("}", idx));
    expect(block).toMatch(/width:\s*100%/);
    expect(block).toMatch(/padding-block:\s*40px/);
    // 正文列与旧版逐像素一致：(W - CM)/2 + 60（W ≤ CM 时退化为 60）——
    // 该 "+60px" 不可省：漏掉会把正文列放宽 120px（已用真实 Chromium 量过，见
    // _verify-out/v0121-edit-scroll-geometry.mjs）
    //
    // ⚠️ v0.17.0 第二轮更新（2026-11-11）：兜底值 960 → **860**。
    // 理由：`--editor-content-max-width` 未设置时，阅读面 `.ProseMirror` 走
    // `max-width: var(--editor-content-max-width, 860px)`，而源码面此前各自走 960px
    // → 两模式正文列宽差 100px，正是用户报的「阅读模式和编辑模式文档没有对齐」。
    // 同一个变量只能有一个兜底值。断言意图（正文列 = CM - 120）不变，故同步期望值。
    expect(block).toMatch(
      /padding-inline:\s*max\(\s*60px,\s*calc\(\(100% - var\(--editor-content-max-width, 860px\)\) \/ 2 \+ 60px\)\s*\)/,
    );
    expect(block).toMatch(/overflow-y:\s*auto/);
    // 旧实现的两条关键声明必须消失（否则滚动条又回到正文右缘）
    expect(block).not.toMatch(/max-width:/);
    expect(block).not.toMatch(/margin:\s*0 auto/);
  });

  it("wrapper 不再收窄/居中（编辑模式的可滚动区域 = 整个编辑区）", () => {
    expect(containerSrc).not.toMatch(
      /viewMode === "edit"[\s\S]{0,200}?maxWidth: "var\(--editor-content-max-width, 960px\)"/,
    );
    expect(containerSrc).toMatch(/v0\.12\.1 需求3：编辑模式的可滚动区域/);
  });

  it("分屏模式不参与居中（.split-editor 覆盖 padding，滚动条贴分栏右缘）", () => {
    /**
     * ⚠️ v0.17.0 第二轮更新（2026-11-11）：选择器从 `.split-editor {` 变成
     * `.split-editor:not(.source-editor-cm6) {`，**意图不变**（分栏内缩 40/30）。
     *
     * 为什么要加 `:not()`：CM6 路径下 `.split-editor` 挂在**中性宿主 div** 上，
     * 而该 div 的滚动与内边距已归 `.cm-scroller`（见 editor.css 的
     * 「内边距只留在滚动容器」一段）。若 `.split-editor` 仍无条件写
     * `padding: 40px 30px`，它会与 scroller 的内边距**叠加** → 正文被内缩两倍、
     * 左右两屏正文左缘差 64px（用户第 9/5 项）。所以只对**真 textarea** 生效。
     *
     * 断言意图（textarea 路径分栏内缩仍为 40/30、且规则仍位于 .source-editor 之后）
     * 完全保留；只是把选择器形态的期望同步为修好后的样子。
     */
    const splitIdx = editorCss.indexOf(".split-editor:not(.source-editor-cm6) {");
    expect(splitIdx, "split-editor 规则必须存在（带 :not 排除 CM6 宿主）").toBeGreaterThan(-1);
    const block = editorCss.slice(splitIdx, editorCss.indexOf("}", splitIdx));
    expect(block).toMatch(/padding:\s*40px 30px/);
    // 且该规则位于 .source-editor 之后（同特异性下后者生效）
    expect(splitIdx).toBeGreaterThan(editorCss.indexOf("\n.source-editor {"));
    // 反向护栏：CM6 宿主自身不得再带内边距（否则双重内缩复发）
    const cmHostIdx = editorCss.indexOf(".source-editor-cm6 {");
    expect(cmHostIdx).toBeGreaterThan(-1);
    const cmHostBlock = editorCss.slice(cmHostIdx, editorCss.indexOf("}", cmHostIdx));
    expect(cmHostBlock, "CM6 宿主必须 padding: 0（内边距归 .cm-scroller）").toMatch(/padding:\s*0/);
  });

  it("阅读模式（对照基线）滚动容器仍为整个 .editor-container，overflow: auto", () => {
    // 两种模式的可滚动区域现在是同一层级的整块区域，滚动条位置一致
    const idx = containerSrc.indexOf('className="editor-container"');
    expect(idx).toBeGreaterThan(-1);
    const block = containerSrc.slice(idx, idx + 400);
    expect(block).toMatch(/overflow:\s*"auto"/);
  });

  it("ghost / 专注遮罩对齐不变：padding 由 syncTextareaMetrics 从 textarea 计算样式复制", () => {
    const focusSrc = readSrc("src/utils/focus-paragraph.ts");
    expect(focusSrc).toMatch(/el\.style\.paddingLeft = cs\.paddingLeft;/);
    expect(focusSrc).toMatch(/el\.style\.paddingRight = cs\.paddingRight;/);
    expect(focusSrc).toMatch(/el\.style\.width = `\$\{textarea\.clientWidth \+ borderLeft \+ borderRight\}px`;/);
  });

  it("水印/遮罩层仍铺满 wrapper（inset: 0），与铺满的 textarea 天然同宽", () => {
    expect(editorCss).toMatch(/\.source-ghost-overlay \{\s*position: absolute;\s*inset: 0;/);
    expect(editorCss).toMatch(/\.source-focus-overlay \{\s*position: absolute;\s*inset: 0;/);
  });
});
