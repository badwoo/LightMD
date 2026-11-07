/**
 * v0.16.0 第二轮侧栏调整
 *
 * 覆盖：
 * 1. 头部还原为「文件管理」标题 + 功能图标形式（取消大号「＋ 新建」按钮，
 *    新建文件回到图标行第一个位置，仍复用 file.new 命令）；
 * 2. 搜索面板展开/收回动画重做（此前只动 max-width：内容先瞬移、收起后再瞬移回来）：
 *    ①高度通道 grid-template-rows 0fr↔1fr —— 下方文件列表被平滑推下 / 平滑回填；
 *    ②水平通道 inner translateX(-100%)↔0 —— 展开时向右"移出"、关闭时向左滑出；
 *    ③减弱动态效果偏好下直接显隐。
 */
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const fileTreeSrc = readFileSync(join(root, "components/sidebar/FileTree.tsx"), "utf-8");
const fileTreeCss = readFileSync(join(root, "components/sidebar/FileTree.css"), "utf-8");

/** 截取 .filetree-search-panel 基础规则块（选择器到配对大括号结束） */
function extractRule(css: string, selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `应存在 ${selector}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = start; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  throw new Error(`规则 ${selector} 未闭合`);
}

/** 截取指定 keyframes 块源文本（从 @keyframes 名称到配对大括号结束） */
function extractKeyframes(css: string, name: string): string {
  const marker = `@keyframes ${name}`;
  const start = css.indexOf(marker);
  expect(start, `应存在 ${marker}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = start; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  throw new Error(`keyframes ${name} 未闭合`);
}

describe("v0.16.0 第二轮：文件管理头部还原", () => {
  it("头部为「文件管理」标题 + 功能图标，不再渲染大号新建按钮", () => {
    expect(fileTreeSrc).toContain('<span className="filetree-title">{t("filetree.title")}</span>');
    expect(fileTreeSrc).toContain('title={t("filetree.newFileTitle")}');
    expect(fileTreeSrc).toContain('{ id: "file.new" }');
    expect(fileTreeSrc).not.toContain("filetree-new-primary");
    expect(fileTreeSrc).not.toContain("filetree.newPrimary");
    expect(fileTreeCss).not.toContain(".filetree-new-primary");
  });

  it("CSS：头部单行排布；窄侧栏下隐藏标题、图标行可压缩（不横向溢出）", () => {
    const header = extractRule(fileTreeCss, ".filetree-header {");
    expect(header).toContain("justify-content: space-between");
    expect(header).toContain("container-type: inline-size");
    expect(header).not.toContain("flex-direction: column");
    // 极窄宽度下标题整体隐藏（容器查询；比较的是头部内容盒，内容宽 ≤232px 时隐藏）
    expect(fileTreeCss).toContain("@container (max-width: 232px)");
    const title = extractRule(fileTreeCss, ".filetree-title {");
    expect(title).toContain("min-width: 0");
    expect(title).toContain("overflow: hidden");
    const actions = extractRule(fileTreeCss, ".filetree-actions {");
    expect(actions).toContain("min-width: 0");
    expect(actions).toContain("flex: 0 1 auto");
    // 按钮允许从 28px 收缩（否则最小 180px 侧栏放不下 6 个图标）
    const btn = extractRule(fileTreeCss, ".filetree-btn {");
    expect(btn).toContain("width: 28px");
    expect(btn).toContain("min-width: 0");
    expect(btn).toContain("flex: 0 1 auto");
  });
});

describe("v0.16.0 第二轮：搜索面板顺滑动画", () => {
  it("结构：panel > clip > inner（可压缩 grid 子项 + 承载搜索框/结果的位移层）", () => {
    expect(fileTreeSrc).toContain('className="filetree-search-clip"');
    expect(fileTreeSrc).toContain('className="filetree-search-inner"');
    const panelIdx = fileTreeSrc.indexOf("className={`filetree-search-panel");
    expect(panelIdx).toBeGreaterThanOrEqual(0);
    const clipIdx = fileTreeSrc.indexOf('className="filetree-search-clip"');
    const innerIdx = fileTreeSrc.indexOf('className="filetree-search-inner"');
    expect(panelIdx).toBeLessThan(clipIdx);
    expect(clipIdx).toBeLessThan(innerIdx);
    // clip 是可压缩 grid 子项（0fr 才能真正压到 0）
    expect(extractRule(fileTreeCss, ".filetree-search-clip {")).toContain("min-height: 0");
  });

  it("高度通道：展开 0fr→1fr、收回 1fr→0fr（下方内容平滑下移/上移回填）", () => {
    const expand = extractKeyframes(fileTreeCss, "search-panel-expand");
    expect(expand).toContain("grid-template-rows: 0fr");
    expect(expand).toContain("grid-template-rows: 1fr");
    const collapse = extractKeyframes(fileTreeCss, "search-panel-collapse");
    expect(collapse).toContain("grid-template-rows: 1fr");
    expect(collapse).toContain("grid-template-rows: 0fr");
    // 容器必须是 grid 且隐藏溢出，否则行高动画不产生"推下/回填"效果
    const panel = extractRule(fileTreeCss, ".filetree-search-panel {");
    expect(panel).toContain("display: grid");
    expect(panel).toContain("overflow: hidden");
  });

  it("水平通道：展开 translateX(-100%→0)（往右移出）、收回 0→-100%（往左滑出）", () => {
    const slideIn = extractKeyframes(fileTreeCss, "search-box-slide-in");
    expect(slideIn).toContain("translateX(-100%)");
    expect(slideIn).toContain("translateX(0)");
    const slideOut = extractKeyframes(fileTreeCss, "search-box-slide-out");
    expect(slideOut).toContain("translateX(0)");
    expect(slideOut).toContain("translateX(-100%)");
    // 两段动画分别挂在 open/closing 状态的 inner 上（类名与 TSX 保持一致）
    expect(fileTreeCss).toContain(
      ".filetree-search-panel.search-panel-open .filetree-search-inner",
    );
    expect(fileTreeCss).toContain(
      ".filetree-search-panel.search-panel-closing .filetree-search-inner",
    );
  });

  it("动画时长与 TSX 常量同步（展开 220ms / 收回 180ms）", () => {
    expect(fileTreeSrc).toContain("export const SEARCH_PANEL_IN_MS = 220;");
    expect(fileTreeSrc).toContain("export const SEARCH_PANEL_OUT_MS = 180;");
    expect(fileTreeCss).toContain("animation: search-panel-expand 220ms");
    expect(fileTreeCss).toContain("animation: search-panel-collapse 180ms");
  });

  it("减弱动态效果：两段动画降级、收回态直接隐藏", () => {
    // 定位搜索面板自己的 reduced-motion 块（文件里还有侧栏面板/排序菜单两处同款媒体查询）
    const searchStart = fileTreeCss.indexOf(".filetree-search-panel {");
    const mediaStart = fileTreeCss.indexOf("@media (prefers-reduced-motion: reduce)", searchStart);
    expect(mediaStart).toBeGreaterThanOrEqual(0);
    const block = fileTreeCss.slice(mediaStart, mediaStart + 900);
    expect(block).toContain(".filetree-search-inner");
    expect(block).toContain("animation: none");
    expect(block).toMatch(/search-panel-closing\s*\{[^}]*display:\s*none/);
  });
});
