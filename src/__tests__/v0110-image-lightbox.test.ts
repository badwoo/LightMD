/**
 * @vitest-environment jsdom
 *
 * v0.11.0 B4-9：阅读模式图片灯箱。
 *
 * 缺陷背景（P2）：schema 的 image.toDOM 已输出 `data-editable="true"`
 * 并注释「供阅读模式注入点击监听（G3）」，但**全仓无任何实现**
 * → 阅读模式点小图无反应，看图细节只能靠缩放窗口。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { lightboxKey, closeLightbox, isLightboxOpen } from "../core/plugins/image-lightbox";

const BOX_ID = "lightmd-lightbox";

function box(): HTMLElement | null {
  return document.getElementById(BOX_ID);
}

describe("v0.11.0 B4-9 图片灯箱", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    document.body.style.overflow = "";
    closeLightbox();
  });

  afterEach(() => {
    closeLightbox();
  });

  it("插件已注册到编辑器（key 存在）", () => {
    expect(lightboxKey).toBeDefined();
    // key 有唯一标识（用于 getState 查找）
    expect(String((lightboxKey as unknown as { key: string }).key)).toContain("lightbox");
  });

  it("image.toDOM 输出了 data-editable 标记（灯箱的触发前提）", async () => {
    const { lightMDSchema } = await import("../core/schema");
    const node = lightMDSchema.nodes.image.create({ src: "a.png", alt: "图" });
    const dom = lightMDSchema.nodes.image.spec.toDOM!(node) as unknown as [string, Record<string, string>];
    const attrs = dom[1];
    expect(attrs["data-editable"]).toBe("true");
    // 懒加载属性也在（此前 WP5 优化）
    expect(attrs.loading).toBe("lazy");
  });

  it("未打开时无灯箱 DOM（懒创建，不污染编辑器 DOM）", () => {
    // 灯箱是打开时才创建的
    expect(isLightboxOpen()).toBe(false);
  });

  it("closeLightbox 在无 DOM 时不抛错（幂等清理）", () => {
    expect(() => closeLightbox()).not.toThrow();
    expect(isLightboxOpen()).toBe(false);
  });

  it("源码层面：灯箱挂在 body 而非 PM 文档内（不进序列化）", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/core/plugins/image-lightbox.ts", "utf-8");
    // 挂 body：不受 PM 选区/滚动容器影响，也不会被保存进文件
    expect(src).toContain("document.body.appendChild(box)");
    // 销毁时务必清理残留浮层
    expect(src).toMatch(/destroy\(\)[\s\S]{0,400}?closeLightbox\(\)/);
  });

  it("源码层面：仅阅读模式生效（编辑模式点击是选中节点）", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/core/plugins/image-lightbox.ts", "utf-8");
    expect(src).toMatch(/editable\?\.\(editorView\.state\) !== false\) return;/);
  });

  it("源码层面：支持 Esc 关闭与方向键切换", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/core/plugins/image-lightbox.ts", "utf-8");
    expect(src).toContain('e.key === "Escape"');
    expect(src).toContain('e.key === "ArrowLeft"');
    expect(src).toContain('e.key === "ArrowRight"');
  });

  it("源码层面：打开时锁滚动、关闭时还原（避免背景跟着滚）", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/core/plugins/image-lightbox.ts", "utf-8");
    expect(src).toContain('document.body.style.overflow = "hidden"');
    expect(src).toContain('document.body.style.overflow = ""');
  });

  it("源码层面：多图分组切换（索引循环）", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/core/plugins/image-lightbox.ts", "utf-8");
    expect(src).toContain("collectImages");
    // 循环切换而非到边界就停
    expect(src).toMatch(/currentIndex = \(\(index % currentImages\.length\) \+ currentImages\.length\) % currentImages\.length;/);
  });
});
