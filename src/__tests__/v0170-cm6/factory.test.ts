// @vitest-environment jsdom
/**
 * v0.17.0 A1：SourceSurface 工厂选型契约
 *
 * 这些断言保护的是**工厂的选型决策**（A 线的生命线）：
 * jsdom 下必须回退 textarea，否则 6600+ 条既有测试会因为 CM6 布局不可用而大面积红。
 *
 * 它们不是"源码文本长相"断言，而是**行为契约断言** —— A 线的方向就是把 P0 遗留的
 * 文本断言升级成这种形态。
 */
import { describe, it, expect } from "vitest";
import {
  createSourceSurface,
  isJsdomLike,
  canUseCm6,
} from "../../editor/createSourceSurface";
import type { SourceSurface } from "../../editor/types";

/**
 * 识别实现：用**构造器身份**而不是 legacyTextareaRef()。
 * 后者在 mount 前恒为 null（textarea 实现的 ta 还没赋值），据此判别会误判。
 */
const isCm6 = (s: SourceSurface): boolean =>
  s.constructor.name === "CmSourceSurface";

describe("A1 工厂：jsdom 兜底是 A 线的保绿前提", () => {
  it("jsdom 环境下判定为不可用 CM6", () => {
    expect(isJsdomLike()).toBe(true);
    expect(canUseCm6()).toBe(false);
  });

  it("自动选型在 jsdom 下回退到 textarea 实现（否则全量测试会大面积红）", () => {
    const surface = createSourceSurface();
    expect(isCm6(surface)).toBe(false);
  });

  it("显式 impl=textarea 必须拿到 textarea 能力", () => {
    const surface = createSourceSurface({ impl: "textarea" });
    const host = document.createElement("div");
    document.body.appendChild(host);
    surface.mount(host, { initialText: "abc" });
    expect(surface.legacyTextareaRef()).not.toBeNull();
    expect(surface.getText()).toBe("abc");
    surface.destroy();
    host.remove();
  });

  it("显式 impl=cm6 返回 CM6 实现且不静默回退（探针要明确结论）", () => {
    const surface = createSourceSurface({ impl: "cm6" });
    expect(isCm6(surface)).toBe(true);

    const host = document.createElement("div");
    document.body.appendChild(host);
    surface.mount(host, { initialText: "# hi" });

    // 基本内容读写可用（jsdom 下 CM6 构造成功、文档模型正常）
    expect(surface.getText()).toBe("# hi");
    surface.setText("## changed");
    expect(surface.getText()).toBe("## changed");

    // 选区可用
    surface.setSelection(0, 2);
    expect(surface.getSelection()).toEqual({ start: 0, end: 2 });

    surface.destroy();
    host.remove();
  });

  it("jsdom 下 CM6 的度量必须优雅退化（返回 null，而不是抛进渲染流程）", () => {
    const surface = createSourceSurface({ impl: "cm6" });
    const host = document.createElement("div");
    document.body.appendChild(host);
    surface.mount(host, { initialText: "a\nb\nc" });

    // 关键：coordsAtPos 在 jsdom 会抛，度量必须被吞掉并返回 null
    expect(surface.measureBlockTops([0, 1, 2])).toBeNull();
    expect(surface.captureViewportAnchor()).toBeNull();
    // 但 getMetrics 仍应给出可用数字（文档模型层面成立）
    expect(surface.getMetrics().totalLines).toBe(3);

    surface.destroy();
    host.remove();
  });
});
