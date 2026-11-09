// @vitest-environment jsdom
/**
 * v0.17.0 A3：`onDidScroll` 契约（分屏双向联动）
 *
 * ## 为什么这个能力必须存在
 *
 * 分屏双向联动要求"左屏滚动 → 右屏跟随"。左屏是源码面，它的滚动容器在两种实现下**不同**：
 * - textarea → 元素自身的 `scroll`
 * - CM6 → **`view.scrollDOM`**（绑 `.cm-content` 或外层 host 都收不到事件）
 *
 * 宿主无法知道该绑哪个节点，所以必须由实现层提供订阅能力。
 *
 * ## Lead 的硬要求（本文件逐条锁住）
 * 1. 回调必须带 **`scrollTop` / `scrollHeight` / `clientHeight` 三个值**
 *    （分屏映射要算比例，只给 scrollTop 不够）；
 * 2. 两个实现都要能收到事件；
 * 3. 返回的取消函数必须真正解绑（防泄漏）；
 * 4. `destroy()` 后不得残留监听。
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { createSourceSurface } from "../../editor/createSourceSurface";
import type { SourceSurface } from "../../editor/types";

let surface: SourceSurface | null = null;
let host: HTMLElement | null = null;

function mountTextarea(text: string): { surface: SourceSurface; ta: HTMLTextAreaElement } {
  surface = createSourceSurface({ impl: "textarea" });
  host = document.createElement("div");
  document.body.appendChild(host);
  const ta = document.createElement("textarea");
  ta.value = text;
  host.appendChild(ta);
  surface.mount(ta, { initialText: text });
  return { surface, ta };
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

describe("A3 onDidScroll：契约语义", () => {
  it("两个实现都提供该方法", () => {
    const { surface: s } = mountTextarea("abc");
    expect(typeof s.onDidScroll).toBe("function");
  });

  it("textarea 实现：scroll 事件能收到，且带三个值（不是只有 scrollTop）", () => {
    const { surface: s, ta } = mountTextarea("line1\nline2\nline3");
    const events: Array<{ scrollTop: number; scrollHeight: number; clientHeight: number }> = [];
    const off = s.onDidScroll((ev) => events.push({ ...ev }));

    // jsdom 无布局 → 三个值都是 0，但**键必须齐全**
    ta.scrollTop = 10;
    ta.dispatchEvent(new Event("scroll"));

    expect(events.length, "必须能收到 scroll 事件").toBe(1);
    expect(Object.keys(events[0]).sort()).toEqual(["clientHeight", "scrollHeight", "scrollTop"]);
    off();
  });

  it("返回的取消函数真正解绑（再派发不再触发）", () => {
    const { surface: s, ta } = mountTextarea("abc");
    const listener = vi.fn();
    const off = s.onDidScroll(listener);

    ta.dispatchEvent(new Event("scroll"));
    expect(listener).toHaveBeenCalledTimes(1);

    off();
    ta.dispatchEvent(new Event("scroll"));
    expect(listener, "取消后不得再收到事件").toHaveBeenCalledTimes(1);
  });

  it("多个订阅者互不影响（联动 + 诊断可同时订阅）", () => {
    const { surface: s, ta } = mountTextarea("abc");
    const a = vi.fn();
    const b = vi.fn();
    const offA = s.onDidScroll(a);
    const offB = s.onDidScroll(b);

    ta.dispatchEvent(new Event("scroll"));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    offA();
    ta.dispatchEvent(new Event("scroll"));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b, "取消 A 不得影响 B").toHaveBeenCalledTimes(2);
    offB();
  });

  it("CM6 实现：可订阅且不抛（滚动容器是 view.scrollDOM）", () => {
    const s = mountCm6("a\nb\nc");
    expect(() => {
      const off = s.onDidScroll(() => {});
      off();
    }).not.toThrow();
  });

  it("destroy 后不得残留监听（CM6 的 scrollDOM 会随 view 丢弃，残留即泄漏）", () => {
    const { surface: s, ta } = mountTextarea("abc");
    const listener = vi.fn();
    s.onDidScroll(listener);
    s.destroy();
    surface = null; // afterEach 不再重复 destroy

    ta.dispatchEvent(new Event("scroll"));
    expect(listener, "destroy 后监听必须已解绑").not.toHaveBeenCalled();
    host?.remove();
    host = null;
  });

  it("未 mount 时订阅返回空操作取消函数（不抛）", () => {
    surface = createSourceSurface({ impl: "textarea" });
    expect(() => {
      const off = surface!.onDidScroll(() => {});
      off();
    }).not.toThrow();
  });
});
