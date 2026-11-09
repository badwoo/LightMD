// @vitest-environment jsdom
/**
 * v0.17.0 A3：源码面「按行轴」统一测量入口的契约
 *
 * ## 这层为什么必须存在（它的价值不在"多一个文件"）
 *
 * A3 要把分屏对齐的数据源从 `measureSourceLineAxis`（mirror div）换成 CM6 的
 * 行块几何。但下游有 **3 处**独立调用，各自改一遍会让**兜底策略写 3 份并必然漂移**。
 * 因此把「测量源（谁去量）」与「行轴构建（怎么算，纯函数一行不改）」拆开。
 *
 * ## R2：降级必须"可观测"
 *
 * 设计稿 R2 警告 CM6 视口外测量不稳。若测量失败只表现为"对齐不准"，
 * 会被误判成对齐算法坏了。因此本层的每个失败路径都要给出**明确原因**。
 * 下面的用例逐条锁住这些原因 —— 删掉任一降级分支，对应断言会红。
 */

import { describe, it, expect } from "vitest";
import {
  measureLineAxis,
  surfaceMeasureSource,
  textareaMeasureSource,
  type LineAxisDegradeReason,
  type LineAxisMeasureSource,
} from "../../editor/surface/sourceLineAxis";

/** 造一个可控的测量源（模拟各种降级场景） */
function fakeSource(over: Partial<{
  tops: number[] | null;
  totalLines: number;
  scrollHeight: number;
  clientHeight: number;
}>): LineAxisMeasureSource {
  return {
    measureBlockTops: () =>
      over.tops === undefined ? [0, 100, 200] : over.tops,
    metrics: () => ({
      scrollHeight: over.scrollHeight ?? 1000,
      clientHeight: over.clientHeight ?? 200,
      totalLines: over.totalLines ?? 30,
    }),
  };
}

describe("A3 行轴统一入口：正常路径", () => {
  it("能构建出非递减的行轴（纯函数层 buildSourceLineAxis 一行未改）", () => {
    const src = fakeSource({ tops: [0, 100, 200], totalLines: 30, scrollHeight: 1000, clientHeight: 200 });
    const out = measureLineAxis(src, [0, 10, 20]);
    expect(out).not.toBeNull();
    expect(out!.totalLines).toBe(30);
    expect(out!.axis.length).toBe(30);
    // 非递减
    for (let i = 1; i < out!.axis.length; i++) {
      expect(out!.axis[i]).toBeGreaterThanOrEqual(out!.axis[i - 1]);
    }
  });
});

describe("A3 行轴统一入口：降级必须可观测（R2）", () => {
  const reasons: LineAxisDegradeReason[] = [];
  const collect = (r: LineAxisDegradeReason) => reasons.push(r);

  it("blockLines 为空 → no_block_lines", () => {
    reasons.length = 0;
    expect(measureLineAxis(fakeSource({}), [], collect)).toBeNull();
    expect(reasons).toContain("no_block_lines");
  });

  it("内容不足一屏（maxScroll=0）→ max_scroll_zero", () => {
    reasons.length = 0;
    const src = fakeSource({ scrollHeight: 200, clientHeight: 200 });
    expect(measureLineAxis(src, [0, 1], collect)).toBeNull();
    expect(reasons).toContain("max_scroll_zero");
  });

  it("测量源返回 null（CM6 视口外/布局不可用）→ axis_source_unavailable", () => {
    reasons.length = 0;
    const src = fakeSource({ tops: null });
    expect(measureLineAxis(src, [0, 1], collect)).toBeNull();
    expect(reasons, "测不到必须报 axis_source_unavailable，别静默").toContain(
      "axis_source_unavailable",
    );
  });

  it("测量源返回全 NaN（CM6 视口外全部不可测）→ no_measured_tops", () => {
    reasons.length = 0;
    const src = fakeSource({ tops: [Number.NaN, Number.NaN] });
    expect(measureLineAxis(src, [0, 1], collect)).toBeNull();
    expect(reasons, "全 NaN 与'测不到'是不同原因，要分开报").toContain("no_measured_tops");
  });

  it("降级回调是可选的（不传也不崩）", () => {
    expect(() => measureLineAxis(fakeSource({ tops: null }), [0])).not.toThrow();
    expect(measureLineAxis(fakeSource({ tops: null }), [0])).toBeNull();
  });
});

describe("A3 行轴统一入口：两种测量源语义一致", () => {
  it("textarea 源在 jsdom（无布局）下应降级而不是抛异常", () => {
    const ta = document.createElement("textarea");
    ta.value = "a\nb\nc\nd";
    document.body.appendChild(ta);
    // jsdom 无布局：scrollHeight/clientHeight 均为 0 → 应降级为 null
    const reasons: LineAxisDegradeReason[] = [];
    const out = measureLineAxis(textareaMeasureSource(ta), [0, 2], (r) => reasons.push(r));
    expect(out).toBeNull();
    expect(reasons.length).toBeGreaterThan(0);
  });

  it("surface 源的 metrics 语义与 textarea 源对齐（都是 scrollHeight/clientHeight/totalLines）", () => {
    const ta = document.createElement("textarea");
    ta.value = "x\ny";
    document.body.appendChild(ta);
    const taM = textareaMeasureSource(ta).metrics();
    expect(taM).toHaveProperty("scrollHeight");
    expect(taM).toHaveProperty("clientHeight");
    expect(taM.totalLines).toBe(2);

    // surface 源：用一个最小 stub（这里只验字段形状，真 CM6 在 factory 测试里覆盖）
    const stub = {
      measureBlockTops: () => null,
      getMetrics: () => ({ totalLines: 5, scrollHeight: 500, clientHeight: 100, clientWidth: 300 }),
    } as unknown as Parameters<typeof surfaceMeasureSource>[0];
    const sM = surfaceMeasureSource(stub).metrics();
    expect(sM).toEqual({ scrollHeight: 500, clientHeight: 100, totalLines: 5 });
  });
});
