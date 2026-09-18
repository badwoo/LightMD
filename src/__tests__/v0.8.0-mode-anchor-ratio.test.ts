/**
 * v0.8.0 修复 P10（重点问题2）：模式切换的"编辑锚点按同比例对齐"测试
 *
 * 需求：
 * - 光标在源模式视口内可见 → 切到目标模式后把同一内容位置放在视口相同相对位置；
 * - 光标不可见（用户在别处浏览）→ 不使用锚点，回退滚动百分比，
 *   修正 0.8.0 早期"强制把光标行滚到视口上 1/3"导致的跳变。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  computeViewportRatio,
  computeAnchorScrollTop,
  lineIndexOfOffset,
} from "../utils/modeAnchor";

const editorSrc = readFileSync(
  resolve(__dirname, "../components/editor/EditorContainer.tsx"),
  "utf-8",
);

describe("v0.8.0 修复 P10 computeViewportRatio（光标可见性 + 相对位置）", () => {
  it("视口内：返回 0~1 的比例", () => {
    // 内容 Y=500, scrollTop=400 → 视口内 100；视口高 400 → 0.25
    expect(computeViewportRatio(500, 400, 400)).toBeCloseTo(0.25);
    // 顶点
    expect(computeViewportRatio(400, 400, 400)).toBe(0);
    // 底点（含边界）
    expect(computeViewportRatio(800, 400, 400)).toBe(1);
  });

  it("视口外：返回 null（调用方据此回退滚动百分比）", () => {
    // 光标在视口上方
    expect(computeViewportRatio(300, 400, 400)).toBe(null);
    // 光标在视口下方
    expect(computeViewportRatio(801, 400, 400)).toBe(null);
  });

  it("视口高度无效（隐藏/未布局）时返回 null", () => {
    expect(computeViewportRatio(100, 0, 0)).toBe(null);
    expect(computeViewportRatio(Number.NaN, 0, 400)).toBe(null);
  });
});

describe("v0.8.0 修复 P10 computeAnchorScrollTop（按同比例反算滚动位置）", () => {
  it("把锚点放到视口相同相对位置", () => {
    // 内容 Y=1200、ratio=0.25、视口高 400 → target = 1200 - 100 = 1100
    expect(computeAnchorScrollTop(1200, 0.25, 400, 3000)).toBe(1100);
    // ratio=0 → 锚点贴视口顶部
    expect(computeAnchorScrollTop(500, 0, 400, 3000)).toBe(500);
  });

  it("结果钳制在可滚动范围内", () => {
    // 目标超过底部 → 取 max
    expect(computeAnchorScrollTop(2900, 0.5, 400, 3000)).toBe(2600);
    // 目标为负 → 取 0
    expect(computeAnchorScrollTop(50, 0.9, 400, 3000)).toBe(0);
  });

  it("内容不足一屏（scrollHeight <= clientHeight）→ 滚动位置为 0", () => {
    expect(computeAnchorScrollTop(100, 0.5, 400, 300)).toBe(0);
  });

  it("参数无效时返回 null（回退百分比）", () => {
    expect(computeAnchorScrollTop(-1, 0.5, 400, 3000)).toBe(null);
    expect(computeAnchorScrollTop(100, 0.5, 0, 3000)).toBe(null);
  });
});

describe("v0.8.0 修复 P10 lineIndexOfOffset（不分配数组的行号统计）", () => {
  it("与 split 实现等价", () => {
    const text = "a\nb\n\nc";
    for (let i = 0; i <= text.length; i++) {
      expect(lineIndexOfOffset(text, i)).toBe(text.slice(0, i).split("\n").length - 1);
    }
  });

  it("越界与空串安全", () => {
    expect(lineIndexOfOffset("", 0)).toBe(0);
    expect(lineIndexOfOffset("a", 999)).toBe(0);
    expect(lineIndexOfOffset("a\nb", -5)).toBe(0);
    expect(lineIndexOfOffset("a\nb\nc", 999)).toBe(2);
  });
});

describe("v0.8.0 修复 P10 接线（源码断言，防回归）", () => {
  it("恢复时按 anchorRatio 同比例对齐，且不再强制滚动到视口上 1/3", () => {
    expect(editorSrc).toContain("computeAnchorScrollTop(");
    // 旧的强制定位写法（cursorY - clientHeight / 3）必须消失
    expect(editorSrc).not.toContain("container.clientHeight / 3");
    expect(editorSrc).not.toContain("textarea.clientHeight / 3");
  });

  it("锚点仅在光标可见（anchorRatio 非空）时生效，否则回退百分比", () => {
    expect(editorSrc).toContain("anchorLine != null && anchorRatio != null");
    expect(editorSrc).toContain("computeRestoreScrollTop(percent");
  });

  it("三条切换路径都捕捉编辑锚点（阅读→源码 / 源码→阅读 / 编辑分屏）", () => {
    const ratioCalls = editorSrc.match(/computeViewportRatio\(/g) || [];
    expect(ratioCalls.length).toBeGreaterThanOrEqual(3);
  });
});