/**
 * 专注模式屏幕中央高亮 bug 修复测试
 *
 * Bug 场景（用户反馈问题5）：
 * - 进入专注模式时，如果能检查到编辑符号位置，则高亮编辑符所在区域
 * - 如果没有找到编辑符号位置，则默认高亮屏幕中央的内容
 *
 * 根因分析：
 * 1. 源码模式（textarea）：已修复，updateOverlay 中检查段落是否在可视区域，
 *    不在时高亮屏幕中央
 * 2. 阅读模式（ProseMirror）：focus-mode 插件基于 state.selection 高亮活跃块，
 *    如果光标不在可视区域（如用户浏览到中间但光标在文档开头），
 *    活跃块也不在可视区域，用户看不到高亮内容
 *
 * 修复方案：
 * - 进入专注模式时，检查 ProseMirror 光标是否在可视区域（复用 isCursorOutsideViewport）
 * - 如果不在，使用 computeViewportCenter 计算屏幕中央坐标
 * - 通过 view.posAtCoords 找到对应的文档位置
 * - 将 selection 设置到该位置，使 focus-mode 插件高亮屏幕中央的块
 *
 * 本测试覆盖：
 * - computeViewportCenter 纯函数
 * - isCursorOutsideViewport 在专注模式场景下的应用
 * - 完整流程模拟：光标在视口外 → 计算屏幕中央 → 高亮
 */
import { describe, it, expect } from "vitest";
import { computeViewportCenter, isCursorOutsideViewport } from "../utils/typewriter";

describe("computeViewportCenter - 屏幕中央坐标计算", () => {
  // ─── 正常场景 ──────────────────────────────────

  it("标准视口：left=0, top=0, width=800, height=600 → 中央(400, 300)", () => {
    const rect = { left: 0, top: 0, width: 800, height: 600 };
    expect(computeViewportCenter(rect)).toEqual({ left: 400, top: 300 });
  });

  it("偏移视口：left=100, top=50, width=600, height=400 → 中央(400, 250)", () => {
    const rect = { left: 100, top: 50, width: 600, height: 400 };
    expect(computeViewportCenter(rect)).toEqual({ left: 400, top: 250 });
  });

  it("大视口：width=1920, height=1080 → 中央(960, 540)", () => {
    const rect = { left: 0, top: 0, width: 1920, height: 1080 };
    expect(computeViewportCenter(rect)).toEqual({ left: 960, top: 540 });
  });

  it("小视口：width=320, height=240 → 中央(160, 120)", () => {
    const rect = { left: 0, top: 0, width: 320, height: 240 };
    expect(computeViewportCenter(rect)).toEqual({ left: 160, top: 120 });
  });

  // ─── 边界场景 ──────────────────────────────────

  it("零尺寸视口：width=0, height=0 → 中央(left, top)", () => {
    const rect = { left: 100, top: 200, width: 0, height: 0 };
    expect(computeViewportCenter(rect)).toEqual({ left: 100, top: 200 });
  });

  it("负偏移视口：left=-100, top=-50, width=400, height=300", () => {
    const rect = { left: -100, top: -50, width: 400, height: 300 };
    expect(computeViewportCenter(rect)).toEqual({ left: 100, top: 100 });
  });
});

describe("isCursorOutsideViewport - 专注模式光标可见性检查", () => {
  // ─── 光标在视口内（应高亮光标所在区域）──────────────────

  it("光标在视口中央：cursorTop=300, cursorBottom=320, height=600 → false", () => {
    expect(isCursorOutsideViewport(300, 320, 600)).toBe(false);
  });

  it("光标在视口顶部：cursorTop=0, cursorBottom=20, height=600 → false", () => {
    expect(isCursorOutsideViewport(0, 20, 600)).toBe(false);
  });

  it("光标在视口底部：cursorTop=580, cursorBottom=600, height=600 → false", () => {
    expect(isCursorOutsideViewport(580, 600, 600)).toBe(false);
  });

  // ─── 光标在视口外（应高亮屏幕中央）──────────────────

  it("光标在视口上方：cursorTop=-50, cursorBottom=-30 → true", () => {
    expect(isCursorOutsideViewport(-50, -30, 600)).toBe(true);
  });

  it("光标在视口下方：cursorTop=650, cursorBottom=670, height=600 → true", () => {
    expect(isCursorOutsideViewport(650, 670, 600)).toBe(true);
  });

  it("光标远在视口上方（文档开头）：cursorTop=-500, cursorBottom=-480 → true", () => {
    // 模拟用户浏览到文档中间，但光标在文档开头
    expect(isCursorOutsideViewport(-500, -480, 600)).toBe(true);
  });

  it("光标远在视口下方（文档末尾）：cursorTop=5000, cursorBottom=5020, height=600 → true", () => {
    // 模拟用户浏览到文档开头，但光标在文档末尾
    expect(isCursorOutsideViewport(5000, 5020, 600)).toBe(true);
  });
});

describe("专注模式屏幕中央高亮 - 完整流程模拟", () => {
  // ─── 场景1：光标在视口内 → 高亮光标所在区域 ────────────

  it("场景1：光标在视口中央 → 不需要高亮屏幕中央", () => {
    // 模拟 ProseMirror 编辑器 rect
    const editorRect = { left: 0, top: 0, width: 800, height: 600 };
    // 光标在视口中央
    const cursorCoords = { top: 300, bottom: 320 };
    const cursorTop = cursorCoords.top - editorRect.top;
    const cursorBottom = cursorCoords.bottom - editorRect.top;
    const isOutside = isCursorOutsideViewport(cursorTop, cursorBottom, editorRect.height);

    expect(isOutside).toBe(false);
    // 光标在视口内，focus-mode 插件正常高亮光标所在块，无需特殊处理
  });

  // ─── 场景2：光标在视口外 → 高亮屏幕中央 ────────────

  it("场景2：光标在文档开头但视口在中间 → 需要高亮屏幕中央", () => {
    // 模拟 ProseMirror 编辑器 rect
    const editorRect = { left: 0, top: 0, width: 800, height: 600 };
    // 光标在文档开头，但用户已滚动到中间
    // coordsAtPos 返回的是屏幕坐标，光标在编辑器视口上方
    const cursorCoords = { top: -300, bottom: -280 };
    const cursorTop = cursorCoords.top - editorRect.top;
    const cursorBottom = cursorCoords.bottom - editorRect.top;
    const isOutside = isCursorOutsideViewport(cursorTop, cursorBottom, editorRect.height);

    expect(isOutside).toBe(true);
    // 需要计算屏幕中央坐标
    const center = computeViewportCenter(editorRect);
    expect(center).toEqual({ left: 400, top: 300 });
    // 后续 view.posAtCoords(center) 找到对应的文档位置
  });

  // ─── 场景3：光标在视口下方 → 高亮屏幕中央 ────────────

  it("场景3：光标在文档末尾但视口在开头 → 需要高亮屏幕中央", () => {
    const editorRect = { left: 0, top: 0, width: 800, height: 600 };
    // 光标在文档末尾，但用户在文档开头
    const cursorCoords = { top: 900, bottom: 920 };
    const cursorTop = cursorCoords.top - editorRect.top;
    const cursorBottom = cursorCoords.bottom - editorRect.top;
    const isOutside = isCursorOutsideViewport(cursorTop, cursorBottom, editorRect.height);

    expect(isOutside).toBe(true);
    const center = computeViewportCenter(editorRect);
    expect(center).toEqual({ left: 400, top: 300 });
  });

  // ─── 场景4：编辑器有偏移 ────────────────────────

  it("场景4：编辑器在屏幕中间偏移 → 正确计算相对坐标", () => {
    // 模拟编辑器在屏幕中间位置
    const editorRect = { left: 200, top: 100, width: 600, height: 400 };
    // 光标在视口上方（屏幕坐标 50，编辑器顶部 100）
    const cursorCoords = { top: 50, bottom: 70 };
    const cursorTop = cursorCoords.top - editorRect.top;
    const cursorBottom = cursorCoords.bottom - editorRect.top;
    const isOutside = isCursorOutsideViewport(cursorTop, cursorBottom, editorRect.height);

    expect(isOutside).toBe(true); // cursorTop = -50, 在视口上方
    const center = computeViewportCenter(editorRect);
    expect(center).toEqual({ left: 500, top: 300 });
  });

  // ─── 场景5：刚打开文件，光标在文档开头 ────────────

  it("场景5：刚打开文件光标在开头，用户未滚动 → 光标在视口内", () => {
    const editorRect = { left: 0, top: 0, width: 800, height: 600 };
    // 光标在文档开头，用户未滚动，光标在视口顶部
    const cursorCoords = { top: 10, bottom: 30 };
    const cursorTop = cursorCoords.top - editorRect.top;
    const cursorBottom = cursorCoords.bottom - editorRect.top;
    const isOutside = isCursorOutsideViewport(cursorTop, cursorBottom, editorRect.height);

    expect(isOutside).toBe(false);
    // 光标在视口内，正常高亮光标所在块
  });

  // ─── 场景6：大文档，光标在远处的段落 ────────────

  it("场景6：大文档光标在 5000px 外 → 需要高亮屏幕中央", () => {
    const editorRect = { left: 0, top: 0, width: 800, height: 600 };
    const cursorCoords = { top: 5000, bottom: 5020 };
    const cursorTop = cursorCoords.top - editorRect.top;
    const cursorBottom = cursorCoords.bottom - editorRect.top;
    const isOutside = isCursorOutsideViewport(cursorTop, cursorBottom, editorRect.height);

    expect(isOutside).toBe(true);
    const center = computeViewportCenter(editorRect);
    // posAtCoords 会找到屏幕中央对应的文档位置（约 scrollTop + height/2 处）
    expect(center).toEqual({ left: 400, top: 300 });
  });
});
