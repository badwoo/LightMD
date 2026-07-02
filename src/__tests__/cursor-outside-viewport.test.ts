/**
 * 阅读模式编辑闪烁抖动 bug 修复测试（cursorWasOutside 逻辑）
 *
 * Bug 复现场景（通过 chrome-devtools 实时调试定位）：
 * - 阅读模式下，光标位于视口外（如 scrollTop=0 时光标在第 6 段，Y=2945）
 * - 用户按键输入字符 'a'
 * - savedScrollTop=0, beforeScroll=2230.67（浏览器 scrollIntoView 把 scrollTop 改为光标位置）
 * - keyup 时检测到 diff<=5，恢复 scrollTop 2230.67 -> 0
 * - 用户看到屏幕抖动（scrollTop 从 0 跳到 2230.67 再跳回 0）
 * - 由于光标仍在视口外（scrollTop 被恢复为 0），下次按键再次抖动
 * - 造成"每按一下键盘屏幕就抖动刷新一下"
 *
 * 修复方案（isCursorOutsideViewport 纯函数）：
 * - keydown 时检测光标是否在视口外，记录 cursorWasOutside
 * - keyup 时如果 cursorWasOutside=true，不恢复 scrollTop，让浏览器 scrollIntoView 生效
 * - 光标进入视口后，下次按键不再抖动
 * - 打字机模式开启时进一步 smooth 滚动到中央
 */
import { describe, it, expect } from "vitest";
import { isCursorOutsideViewport } from "../utils/typewriter";

describe("isCursorOutsideViewport - 阅读模式编辑闪烁抖动修复（cursorWasOutside 逻辑）", () => {
  // ─── Bug 复现：光标在视口外时应返回 true ──────────────────

  it("Bug 复现场景：光标在视口下方很远（scrollTop=0 时光标 Y=2945）", () => {
    // 真实调试数据：msgid=503 场景
    // scrollTop=0, clientHeight=600, 光标 Y=2945（远在视口下方）
    // cursorTop 相对视口 = 2945 - 0 = 2945（但此处用相对坐标）
    // 假设 coords.top - editorRect.top = 2945, clientHeight = 600
    // cursorBottom = 2945 + 28 = 2973
    expect(isCursorOutsideViewport(2945, 2973, 600)).toBe(true);
  });

  it("光标在视口上方：cursorTop < 0 时应返回 true", () => {
    // 光标顶部在视口上方 100px
    expect(isCursorOutsideViewport(-100, -72, 600)).toBe(true);
  });

  it("光标在视口下方：cursorBottom > clientHeight 时应返回 true", () => {
    // 光标底部超出视口下方 20px
    expect(isCursorOutsideViewport(580, 620, 600)).toBe(true);
  });

  it("光标完全在视口上方：cursorTop 和 cursorBottom 都为负", () => {
    expect(isCursorOutsideViewport(-200, -172, 600)).toBe(true);
  });

  it("光标完全在视口下方：cursorTop 已超过 clientHeight", () => {
    expect(isCursorOutsideViewport(700, 728, 600)).toBe(true);
  });

  // ─── 正常场景：光标在视口内时应返回 false ─────────────────

  it("光标在视口中间：应返回 false", () => {
    expect(isCursorOutsideViewport(280, 308, 600)).toBe(false);
  });

  it("光标在视口顶部：cursorTop=0 应返回 false", () => {
    // 边界：cursorTop=0 不满足 < 0，光标顶部刚好在视口顶部
    expect(isCursorOutsideViewport(0, 28, 600)).toBe(false);
  });

  it("光标在视口底部：cursorBottom=clientHeight 应返回 false", () => {
    // 边界：cursorBottom=600 不满足 > 600，光标底部刚好在视口底部
    expect(isCursorOutsideViewport(572, 600, 600)).toBe(false);
  });

  it("光标在视口顶部边缘：cursorTop=1", () => {
    expect(isCursorOutsideViewport(1, 29, 600)).toBe(false);
  });

  it("光标在视口底部边缘：cursorBottom=clientHeight-1", () => {
    expect(isCursorOutsideViewport(571, 599, 600)).toBe(false);
  });

  // ─── 边界条件 ──────────────────────────────────────

  it("视口高度为 0：任何光标都在视口外（cursorBottom > 0）", () => {
    // 防御性：视口高度为 0 时，光标底部只要 > 0 就在视口外
    expect(isCursorOutsideViewport(0, 28, 0)).toBe(true);
  });

  it("视口高度为 0 且光标顶部为负：应在视口外", () => {
    expect(isCursorOutsideViewport(-10, 18, 0)).toBe(true);
  });

  it("光标顶部刚好为 -1：应在视口外（边界值）", () => {
    // -1 < 0 满足条件
    expect(isCursorOutsideViewport(-1, 27, 600)).toBe(true);
  });

  it("光标底部刚好为 clientHeight+1：应在视口外（边界值）", () => {
    // 601 > 600 满足条件
    expect(isCursorOutsideViewport(573, 601, 600)).toBe(true);
  });

  // ─── 真实场景模拟：连续按键的抖动复现 ─────────────────────

  it("模拟 Bug 场景：scrollTop=0 时光标在视口外，按键触发抖动", () => {
    // 真实调试数据：
    // 1. 初始状态：scrollTop=0，光标 Y=2945（视口外）
    // 2. 用户按 'a'，浏览器 scrollIntoView 把 scrollTop 改为 2230.67
    // 3. keyup 检测 diff<=5，恢复 scrollTop 为 0
    // 4. 用户看到抖动（2230.67 -> 0）
    //
    // 修复后：keydown 时 cursorWasOutside=true（光标 Y=2945 在视口外）
    //        keyup 时不恢复 scrollTop，让 scrollIntoView 生效
    const cursorTop = 2945; // 相对 editorRect.top
    const cursorBottom = 2973;
    const clientHeight = 600;
    expect(isCursorOutsideViewport(cursorTop, cursorBottom, clientHeight)).toBe(true);
  });

  it("模拟修复后第二次按键：光标已进入视口，不再抖动", () => {
    // 修复后流程：
    // 1. 第一次按键：cursorWasOutside=true，不恢复 scrollTop，光标进入视口
    // 2. 浏览器 scrollIntoView 后，scrollTop=2282.67，光标 Y=2945-2282.67=662.33
    //    假设打字机模式进一步 smooth 滚动到中央，scrollTop 调整后光标在视口中央
    // 3. 第二次按键：光标已在视口内，cursorWasOutside=false
    //
    // 假设第二次按键时光标相对视口：cursorTop=280, cursorBottom=308
    expect(isCursorOutsideViewport(280, 308, 600)).toBe(false);
  });

  it("模拟连续输入 hello：光标始终在视口内，全程 cursorWasOutside=false", () => {
    // 修复后：光标在视口内时正常输入，不触发抖动
    const inputs = [
      { cursorTop: 280, cursorBottom: 308 },
      { cursorTop: 280, cursorBottom: 308 },
      { cursorTop: 280, cursorBottom: 308 },
      { cursorTop: 280, cursorBottom: 308 },
      { cursorTop: 280, cursorBottom: 308 },
    ];
    for (const input of inputs) {
      expect(isCursorOutsideViewport(input.cursorTop, input.cursorBottom, 600)).toBe(false);
    }
  });

  // ─── 极端值 ──────────────────────────────────────

  it("大文档场景：光标在视口下方很远（cursorTop=50000）", () => {
    expect(isCursorOutsideViewport(50000, 50028, 600)).toBe(true);
  });

  it("大文档场景：光标在视口上方很远（cursorTop=-50000）", () => {
    expect(isCursorOutsideViewport(-50000, -49972, 600)).toBe(true);
  });

  it("零值检查：cursorTop=0, cursorBottom=0, viewportHeight=0 应返回 false", () => {
    // 边界：cursorTop=0 不满足 < 0，cursorBottom=0 不满足 > 0
    // 这个场景理论上不会发生（光标高度至少为字体大小），但应保证不报错
    expect(isCursorOutsideViewport(0, 0, 0)).toBe(false);
  });
});
