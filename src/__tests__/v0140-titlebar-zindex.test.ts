/**
 * v0.14.0 第三批 需求6 —— 标题栏菜单置顶（层级 / stacking context）回归锁
 *
 * 用户原话：
 *   「新打开软件，鼠标滑动到"打开"或"窗口"下栏的菜单会被中间的编辑区挡住，
 *     请检查和修复这个问题，要保证菜单栏上的操作和显示是置顶的。」
 *
 * ─── 真根因（实机 WebView2 + CDP 取证，见 scripts/v0140-probe-titlebar-menu.mjs）───
 *   ① `.titlebar` 只有 position:relative、**z-index:auto** → 不创建 stacking context，
 *      与后面的兄弟 `.app-shell` / `.editor-main-area` 同处 <body> 根上下文，
 *      按 DOM 顺序**画在它们之后**（即被编辑区盖住）。
 *   ② 下拉菜单自己的 z-index:1000 救不了：它被 `.titlebar-left { z-index:1 }`
 *      夹进那个 z-index=1 的小 stacking context —— z-index 只在自己最近的
 *      stacking context 内比较，"1000"根本没和编辑区同场竞技。
 *   ③ 新开软件时编辑区有一层 `.editor-empty-state`（absolute / z-index:10 /
 *      整块不透明白底 / pointer-events:none）：它画在菜单之上，把下探到编辑区的
 *      那截菜单完全吃掉，用户看到的就是"菜单被编辑区挡住"。
 *   实测（修复前）：窗口菜单矩形 35 个采样点，**菜单内暗色文字像素 = 0**（全被白底盖住）；
 *      假设隐藏 .editor-empty-state 后同区域暗色像素 = 15867、变化 19343 像素。
 *   注意：`elementFromPoint` 会报"全部命中菜单项"——**假阳性**，它跳过
 *      pointer-events:none 的层：指针穿得过白底，但白底照样画在菜单上面。
 *
 * ─── 修复（两件事缺一不可）───
 *   a) `.titlebar` 显式 `z-index: var(--z-titlebar, 100)`（+ position:relative 已有）
 *      → 整个标题栏子树成为根上下文里一个高 z-index 的层，压过 .app-shell 及内部。
 *   b) **不给** .app-shell / .app-sidebar / .app-outline / .editor-main-area 加
 *      任何 z-index → 它们保持 auto，其内部那些 position:fixed 弹层（搜索面板 10000、
 *      右键菜单 10000、任务下拉 1200…）继续以 10000 参与根上下文排序，
 *      不会被"关进"一个 z-index 更低的小上下文里反被标题栏压住。
 *
 * 本文件只作**源码回归锁**：真正的行为验证靠 scripts/v0140-probe-titlebar-menu.mjs
 * （真实 WebView2 + 像素 diff）。源码断言便宜、能在 CI 里拦住"有人把 z-index 删了"的回归。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const readSrc = (rel: string) => readFileSync(join(here, rel), "utf8");

const titlebarCss = readSrc("../components/layout/TitleBar.css");
const appShellCss = readSrc("../components/layout/AppShell.css");
const globalCss = readSrc("../styles/global.css");
const editorCss = readSrc("../styles/editor.css");

const stripCssComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "");

function ruleBody(cssText: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = cssText.match(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, "m"));
  return m ? m[1] : "";
}

/** 解析某个 z-index 声明的数值（支持 var(--z-x) 形式的令牌，回落到其定义值） */
function zIndexOf(body: string): number | null {
  const m = body.match(/z-index:\s*([^;]+);/);
  if (!m) return null;
  const raw = m[1].trim();
  if (/^\d+$/.test(raw)) return Number(raw);
  const varName = raw.match(/var\(\s*(--[\w-]+)\s*(?:,\s*(\d+))?\s*\)/);
  if (varName) {
    const defined = globalCss.match(new RegExp(`${varName[1].replace(/[-]/g, "\\-")}\\s*:\\s*(\\d+)`));
    if (defined) return Number(defined[1]);
    if (varName[2]) return Number(varName[2]);
  }
  return null;
}

// ═══════════════════════════════════════════════════════════
// 1. 标题栏有明确层级
// ═══════════════════════════════════════════════════════════

describe("需求6：.titlebar 有明确 z-index（不再靠 auto 吃 DOM 顺序亏）", () => {
  const body = ruleBody(stripCssComments(titlebarCss), ".titlebar");

  it(".titlebar 规则存在", () => {
    expect(body.length).toBeGreaterThan(0);
  });

  it("仍然是 position: relative（保持文件名居中的定位参照与拖拽行为）", () => {
    expect(body).toMatch(/position:\s*relative/);
  });

  it("有明确的 z-index（非 auto）", () => {
    const z = zIndexOf(body);
    expect(z).not.toBeNull();
    expect(z).toBeGreaterThan(0);
  });

  it("z-index 有令牌兜底值（var(--z-titlebar, N)）或直接数值，二者必居其一", () => {
    expect(body).toMatch(/z-index:\s*(var\(\s*--z-titlebar[^)]*\)|\d+)\s*;/);
  });

  it("overflow 不是 hidden（否则会裁掉下探出标题栏的菜单）", () => {
    // 用户报的"被挡住"另一种可能成因就是祖先 overflow:hidden 裁切。
    // 标题栏必须允许下拉菜单画到自身盒子之外。
    expect(body).not.toMatch(/overflow:\s*hidden/);
    expect(body).toMatch(/overflow:\s*visible/);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. 内容区不得被抬到标题栏之上（也不得创建会困住弹层的上下文）
// ═══════════════════════════════════════════════════════════

describe("需求6：内容区（.app-shell 及内部）不压过标题栏", () => {
  const shell = ruleBody(stripCssComments(appShellCss), ".app-shell");
  const sidebar = ruleBody(stripCssComments(appShellCss), ".app-sidebar");
  const outline = ruleBody(stripCssComments(appShellCss), ".app-outline");
  const main = ruleBody(stripCssComments(editorCss), ".editor-main-area");

  it(".app-shell 不设 z-index（保持 auto，避免创建困住内部 fixed 弹层的上下文）", () => {
    expect(shell).not.toMatch(/z-index:\s*(?!auto)\S+/);
  });

  it(".app-sidebar / .app-outline 不设 z-index", () => {
    expect(sidebar).not.toMatch(/z-index:\s*(?!auto)\S+/);
    expect(outline).not.toMatch(/z-index:\s*(?!auto)\S+/);
  });

  it(".editor-main-area 不设 z-index", () => {
    expect(main).not.toMatch(/z-index:\s*(?!auto)\S+/);
  });

  it("标题栏层级高于内容区内部会把菜单盖住的那层（.editor-empty-state z-index:10）", () => {
    const titlebarZ = zIndexOf(ruleBody(stripCssComments(titlebarCss), ".titlebar"))!;
    const emptyStateZ = zIndexOf(ruleBody(stripCssComments(editorCss), ".editor-empty-state"))!;
    expect(titlebarZ).toBeGreaterThan(emptyStateZ);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. 标题栏内部：下拉菜单仍是最高层，且左侧 z-index:1 可保留
// ═══════════════════════════════════════════════════════════

describe("需求6：标题栏内部层级（下拉菜单 vs 左侧按钮组）", () => {
  const dropdown = ruleBody(stripCssComments(titlebarCss), ".titlebar-dropdown");
  const left = ruleBody(stripCssComments(titlebarCss), ".titlebar-left");

  it(".titlebar-dropdown 仍是 position:absolute + z-index:1000（不改成 fixed）", () => {
    // 不用 position:fixed 硬改菜单定位：那会和拖拽/窗口缩放冲突。
    // 层级问题靠标题栏自身的 stacking context 解决，菜单仍是相对按钮的 absolute。
    expect(dropdown).toMatch(/position:\s*absolute/);
    expect(zIndexOf(dropdown)).toBe(1000);
    expect(dropdown).not.toMatch(/position:\s*fixed/);
  });

  it(".titlebar-left 的 z-index:1 保留且低于下拉菜单（按钮可点、菜单仍在上）", () => {
    // 修复后整个 .titlebar 是一个 z-index:100 的 stacking context，
    // 编辑区在它外面；菜单"压过编辑区"由标题栏这一整层负责。
    // 因此 .titlebar-left 的 z-index:1 可以保留（继续保证左侧按钮压过居中的文件名）。
    const leftZ = zIndexOf(left);
    expect(leftZ).toBe(1);
    expect(zIndexOf(dropdown)!).toBeGreaterThan(leftZ!);
  });

  it("菜单展开不依赖任何 filter/transform 祖先（避免意外 stacking context）", () => {
    const body = ruleBody(stripCssComments(titlebarCss), ".titlebar");
    expect(body).not.toMatch(/filter\s*:\s*(?!none)/);
    expect(body).not.toMatch(/transform\s*:\s*(?!none)/);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. 层级令牌与全局约定
// ═══════════════════════════════════════════════════════════

describe("需求6：层级令牌（--z-titlebar）与弹窗层级约定", () => {
  it("global.css 定义了 --z-titlebar", () => {
    expect(stripCssComments(globalCss)).toMatch(/--z-titlebar:\s*\d+/);
  });

  it("标题栏层级低于对话框/Toast（否则设置、导出等弹窗会被标题栏盖住）", () => {
    const z = Number(stripCssComments(globalCss).match(/--z-titlebar:\s*(\d+)/)![1]);
    // 项目既有弹窗层级：1000（设置/导出）/ 1100（命令面板）/ 1200（对话框）/ 10000（Toast）
    expect(z).toBeLessThan(1000);
  });

  it("没有把 .app 的 overflow 改成 visible（那会破坏整个应用的滚动）", () => {
    const appCss = readSrc("../App.css");
    const app = ruleBody(stripCssComments(appCss), ".app");
    expect(app).toMatch(/overflow:\s*hidden/);
  });
});
