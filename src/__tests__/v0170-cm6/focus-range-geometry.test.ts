// @vitest-environment jsdom
/**
 * v0.17.0 A3-④：专注遮罩的区间几何（`measureRangeContentY`）契约
 *
 * ## 为什么专注遮罩必须单独有"区间"能力
 *
 * 专注模式画的是**一条连续行区间的遮罩带**（`findFocusRowRange` 给 `[start, end)`）。
 * 用两个单点 `offsetToContentY` 拼是**错的**：软换行时区间中间可能跨行，
 * 两端点 Y 之差 ≠ 区间实际高度，遮罩带会偏窄或偏宽。
 *
 * ## 这次的缺陷形态特别值得记录：**静默失效**
 *
 * 改之前，`FormatMenuHost` 的专注遮罩直接读 `sourceTextareaRef.current`，
 * 而 CM6 路径下它为 **null** → `if (!ta) return` → **整个专注遮罩静默不工作**：
 * 没有报错、没有提示，用户只会觉得"专注模式点了没反应"。
 * 而 jsdom 测试走 textarea 路径、依然全绿 —— 这是最难发现的一类缺陷。
 *
 * ## 本文件锁两条
 * 1. 两个实现都提供该能力，且不可测时返回 **null 而非 `{startY:0,endY:0}`**；
 * 2. 返回 `{0,0}` 会让遮罩画在顶部一小条 —— 用户以为"专注模式坏了但还在工作"，
 *    比明确不画更糟。因此 null 与 0 必须严格区分。
 */

import { describe, it, expect, afterEach } from "vitest";
import { createSourceSurface } from "../../editor/createSourceSurface";
import type { SourceSurface } from "../../editor/types";

let surface: SourceSurface | null = null;
let host: HTMLElement | null = null;

function mountTextarea(text: string): SourceSurface {
  surface = createSourceSurface({ impl: "textarea" });
  host = document.createElement("div");
  document.body.appendChild(host);
  const ta = document.createElement("textarea");
  ta.value = text;
  host.appendChild(ta);
  surface.mount(ta, { initialText: text });
  return surface;
}

function mountCm6(text: string): SourceSurface {
  surface = createSourceSurface({ impl: "cm6" });
  host = document.createElement("div");
  document.body.appendChild(host);
  surface.mount(host, { initialText: text });
  return surface;
}

afterEach(() => {
  surface?.destroy();
  surface = null;
  host?.remove();
  host = null;
});

describe("A3-④ measureRangeContentY：专注遮罩的区间几何", () => {
  it("两个实现都提供该方法（否则专注遮罩在 CM6 下静默失效）", () => {
    const s = mountTextarea("line1\nline2\nline3");
    expect(typeof s.measureRangeContentY).toBe("function");
  });

  it("有效区间：不抛；不可测时返回 null（jsdom 无布局）", () => {
    const s = mountTextarea("line1\nline2\nline3");
    const r = s.measureRangeContentY(0, 5);
    // jsdom 下 mirror 测不出真实 Y → 允许 null；关键是**不许抛**
    expect(r === null || (typeof r.startY === "number" && typeof r.endY === "number")).toBe(true);
  });

  it("★ 不可测时必须返回 null，绝不返回 {startY:0,endY:0}", () => {
    const s = mountCm6("a\nb\nc");
    const r = s.measureRangeContentY(0, 1);
    // CM6 在 jsdom 布局不可用 → 必须 null
    expect(r).toBeNull();
    // 若实现退化成 {0,0}，上面已红；这里再显式说明为什么这很重要
    expect(r, "返回 {0,0} 会让遮罩画在顶部一小条，用户以为专注模式坏但还在工作").not.toEqual({
      startY: 0,
      endY: 0,
    });
  });

  it("空区间（start >= end）返回 null，不画零高遮罩", () => {
    const s = mountTextarea("abc");
    expect(s.measureRangeContentY(2, 2)).toBeNull();
    expect(s.measureRangeContentY(3, 1)).toBeNull();
  });

  it("越界区间被 clamp 后不抛（文档刚变短时行区间可能失效）", () => {
    const s = mountTextarea("abc");
    expect(() => s.measureRangeContentY(0, 9999)).not.toThrow();
    expect(() => s.measureRangeContentY(-5, 9999)).not.toThrow();
  });

  it("CM6 实现行为：不可用时 null 且不抛（它在 selectionchange 链路里，高频调用）", () => {
    const s = mountCm6("x\ny\nz");
    expect(() => s.measureRangeContentY(0, 3)).not.toThrow();
    expect(s.measureRangeContentY(0, 3)).toBeNull();
  });
});
