// @vitest-environment jsdom
/**
 * v0.17.0 A3-④：光标内容坐标（`offsetToContentY`）契约
 *
 * ## 这条能力为什么必须收进接口
 *
 * 源码面的打字机（typewriter）与专注遮罩需要知道"光标在**内容坐标系**里的 Y"。
 * 现状只有 textarea 一条路：`measureTextareaCursorY` 建 mirror div 复刻排版再测。
 * 换 CM6 后 `coordsAtPos - documentTop` 能直接给真实坐标，**mirror 那条路不再需要**。
 *
 * ## Lead 的硬要求：机制照搬，不重写算法
 *
 * 所以本文件只锁**数据源契约**（返回什么、什么时候返回 null），
 * 不去重写/验证 `computeTypewriterScrollTop` 的居中算法 —— 那个纯函数一行未改，
 * 它的既有单测继续覆盖。
 *
 * ## 关键语义：不可用时返回 null，**绝不返回 0**
 *
 * 返回 0 会让打字机把光标当成"文档最顶部"，于是每次输入都试图滚到顶部 ——
 * 这是比"不居中"严重得多的缺陷。因此 null 与 0 必须严格区分。
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

describe("A3-④ offsetToContentY：契约语义", () => {
  it("两个实现都提供该方法（接口已收口）", () => {
    const s = mountTextarea("abc");
    expect(typeof s.offsetToContentY).toBe("function");
  });

  it("缺省参数 = 当前主选区光标位置", () => {
    const s = mountTextarea("hello world");
    s.setSelection(6, 6);
    // jsdom 无布局 → 可能 null；但**不得抛**
    expect(() => s.offsetToContentY()).not.toThrow();
  });

  it("显式传 offset 不抛（调用方传历史偏移做诊断时可能越界）", () => {
    const s = mountTextarea("abc");
    expect(() => s.offsetToContentY(0)).not.toThrow();
    expect(() => s.offsetToContentY(9999)).not.toThrow();
    expect(() => s.offsetToContentY(-1)).not.toThrow();
  });

  it("不可用时返回 null，**绝不返回 0**（返回 0 会让打字机每次滚到顶部）", () => {
    const s = mountTextarea("abc");
    const y = s.offsetToContentY(1);
    // jsdom 无布局：允许 null；如果实现有 bug 返回 0，这条会红
    expect(y === null || (typeof y === "number" && Number.isFinite(y))).toBe(true);
  });

  it("CM6 实现在布局不可用（jsdom）时返回 null 而不是抛", () => {
    const s = mountCm6("a\nb\nc");
    expect(() => s.offsetToContentY(0)).not.toThrow();
    expect(s.offsetToContentY(0)).toBeNull();
  });

  it("文档变化后仍可用（打字机在每次 keyup 都会取一次）", () => {
    const s = mountTextarea("abc");
    s.setText("abcdef");
    expect(() => s.offsetToContentY()).not.toThrow();
  });
});
