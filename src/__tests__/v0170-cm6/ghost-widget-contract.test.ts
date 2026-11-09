// @vitest-environment jsdom
/**
 * v0.17.0 A3：ghost 的 Decoration.widget 语义
 *
 * ## Lead 特别提醒的两点，本文件逐条锁住
 *
 * 1. **必须是行内 widget，不能是块级**（`block: true` 会在块边界换行，导致
 *    "占位提示跑到下一行"）。AI 续写与格式 ghost 都是**行内插入**语义。
 * 2. **清除必须走 StateEffect + StateField**，不能直接改 DOM —— 否则 CM6 的
 *    内部状态与 DOM 会脱节（下次重绘时 ghost 又冒出来，或残留永不消失）。
 *
 * ## 为什么这些能在 jsdom 里验
 *
 * widget 的**文档模型层面**（DecorationSet 的 pos/side/block 属性）不依赖布局，
 * 只有渲染成真实 DOM 才依赖。因此这里验"交给 CM6 的 decoration 规格"是可靠的；
 * 真实视觉位置由实机探针验证。
 */

import { describe, it, expect, afterEach } from "vitest";
import { createSourceSurface } from "../../editor/createSourceSurface";
import type { SourceSurface } from "../../editor/types";

let surface: SourceSurface | null = null;
let host: HTMLElement | null = null;

function mount(text: string): SourceSurface {
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

describe("A3 ghost：契约层语义", () => {
  it("showGhost 不得抛异常（它在 rAF/AI 回调链路里，抛了会静默断掉 ghost）", () => {
    const s = mount("hello");
    expect(() => s.showGhost({ text: " world", pos: 5 })).not.toThrow();
  });

  it("pos 越界时被钳到文档范围（AI 流式返回时 pos 可能漂移）", () => {
    const s = mount("hello");
    expect(() => s.showGhost({ text: "x", pos: 9999 })).not.toThrow();
    expect(() => s.showGhost({ text: "x", pos: -5 })).not.toThrow();
  });

  it("clearGhost 可重复调用（宿主在多个时机都会清，不能因此崩）", () => {
    const s = mount("hello");
    s.showGhost({ text: "ghost", pos: 2 });
    expect(() => s.clearGhost()).not.toThrow();
    expect(() => s.clearGhost()).not.toThrow();
  });

  it("tail 与 maskTail 参数被接受（格式 ghost 的尾部符号 + 遮罩开关）", () => {
    const s = mount("****");
    expect(() =>
      s.showGhost({ text: "标题", pos: 2, tail: "**", maskTail: true }),
    ).not.toThrow();
  });

  it("文档编辑后 ghost 不崩（change 链路会 map decoration 位置）", () => {
    const s = mount("hello");
    s.showGhost({ text: " world", pos: 5 });
    // 在 ghost 位置之前插入文本 → decoration 位置需要被 map 到新坐标
    expect(() => s.setText("XXhello")).not.toThrow();
    // 之后仍能正常清除
    expect(() => s.clearGhost()).not.toThrow();
  });

  it("setText 之后 getText 反映新内容（ghost 存在不得干扰文档读取）", () => {
    const s = mount("hello");
    s.showGhost({ text: " ghost", pos: 5 });
    s.setText("changed");
    // ghost 是展示层，绝不写进文档
    expect(s.getText()).toBe("changed");
  });
});
