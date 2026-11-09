// @vitest-environment jsdom
/**
 * v0.17.0 A3：CM6 `measureBlockTops` 的兜底语义（R2）
 *
 * ## 设计稿 R2 的具体风险
 *
 * CM6 只渲染**虚拟视口内**的行。视口外的行 `coordsAtPos` 可能返回 null 或退化值。
 * 而分屏对齐要的是**整篇所有块起始行**的顶部 —— 大文档里绝大多数块都在视口外。
 *
 * 若实现直接逐行 `coordsAtPos`，会大面积失败，表现为"对齐随机不准"，
 * 而根因是**测量失败**（不是对齐算法坏了）。
 *
 * ## 本文件的断言方向
 *
 * 1. 布局不可用（jsdom）→ 返回 null（**不抛异常**，不许把异常冒进渲染流程）；
 * 2. 布局可用时 → 必须能给出**全文档**可用的顶部值（不是只有视口内的那几行）；
 * 3. 结果里至少有一部分是有限数（否则上层应当降级为百分比映射）。
 *
 * ⚠️ jsdom 下 CM6 的布局测量整体不可用（`coordsAtPos`/`getClientRects` 都会抛，
 * 已由 A1 的工厂能力探测确认），因此这里主要锁 **第 1 条**（优雅降级）+ 方法契约；
 * 真实布局下的第 2/3 条由实机探针验证（Lead 已安排）。
 */

import { describe, it, expect, afterEach } from "vitest";
import { createSourceSurface } from "../../editor/createSourceSurface";
import type { SourceSurface } from "../../editor/types";

let surface: SourceSurface | null = null;
let host: HTMLElement | null = null;

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

describe("A3：CM6 measureBlockTops 必须优雅降级（R2）", () => {
  it("布局不可用（jsdom）时返回 null —— 不许抛异常进渲染流程", () => {
    const s = mountCm6("a\nb\nc\nd\ne");
    // 关键：不能 throw。分屏对齐调用点在 render/effect 链路里，抛了就白屏。
    expect(() => s.measureBlockTops([0, 1, 2, 3, 4])).not.toThrow();
    expect(s.measureBlockTops([0, 1, 2, 3, 4])).toBeNull();
  });

  it("空 blockLines 也不抛（调用方可能传空数组）", () => {
    const s = mountCm6("a\nb");
    expect(() => s.measureBlockTops([])).not.toThrow();
    // jsdom 下仍应为 null（布局不可用）；有布局时应返回空数组而非 null
    expect(s.measureBlockTops([])).toBeNull();
  });

  it("越界行号不得抛（文档可能刚变短，调用方的行号是旧的）", () => {
    const s = mountCm6("only one line");
    expect(() => s.measureBlockTops([0, 5, 999])).not.toThrow();
  });

  it("getMetrics 在 jsdom 下仍给出可用的文档模型数字（行数可信）", () => {
    const s = mountCm6("l1\nl2\nl3");
    const m = s.getMetrics();
    // 行数来自 CM6 文档模型（不依赖布局）→ jsdom 下也准确
    expect(m.totalLines).toBe(3);
    // 尺寸类字段在 jsdom 下为 0，这是预期的（调用方据此降级）
    expect(m.scrollHeight).toBe(0);
    expect(m.clientHeight).toBe(0);
  });
});

describe("A3：measureBlockTops 与行轴构建的衔接契约", () => {
  it("返回 null 时上层必须能走百分比兜底（决策函数不崩）", async () => {
    const { measureLineAxis, surfaceMeasureSource } = await import(
      "../../editor/surface/sourceLineAxis"
    );
    const s = mountCm6("x\ny\nz");
    const reasons: string[] = [];
    const out = measureLineAxis(surfaceMeasureSource(s), [0, 1, 2], (r) => reasons.push(r));
    // jsdom 无布局 → null，且**原因可观测**（R2）
    expect(out).toBeNull();
    expect(reasons.length, "降级必须给出可观测原因，不能静默").toBeGreaterThan(0);
  });
});
