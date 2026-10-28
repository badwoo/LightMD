/**
 * @vitest-environment jsdom
 *
 * v0.11.0 B4-9：阅读模式图片灯箱。
 * v0.15.0 F1：合并为「灯箱」验收（插件收敛为事件采集 + 组件渲染）。
 *
 * 缺陷背景（P2，v0.11.0）：schema 的 image.toDOM 已输出 `data-editable="true"`
 * 并注释「供阅读模式注入点击监听（G3）」，但**全仓无任何实现**
 * → 阅读模式点小图无反应，看图细节只能靠缩放窗口。
 *
 * v0.15.0 改造后架构：
 *   `core/plugins/image-lightbox.ts` = 点击采集 + 打开请求（事件层，无渲染）
 *   `components/image/ImageLightbox.tsx` = React portal 渲染（缩放/平移/切图/无障碍）
 *
 * 因此本文件保留 v0.11.0 的**行为契约**断言（可查看标记、仅阅读模式、幂等关闭、
 * 不进 PM 文档），并把原先锁定在插件源码里的实现细节断言迁移到新归属文件。
 * 交互细节（缩放/平移/键盘）由 `v0150-image-lightbox.test.tsx` 覆盖。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  lightboxKey,
  closeLightbox,
  isLightboxOpen,
  LIGHTBOX_IMAGE_SELECTOR,
  LIGHTBOX_OPEN_EVENT,
} from "../core/plugins/image-lightbox";

describe("v0.11.0 B4-9 / v0.15.0 F1 图片灯箱", () => {
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
    // 插件侧的采集选择器必须与 toDOM 的标记同源（改一处不漏另一处）
    expect(LIGHTBOX_IMAGE_SELECTOR).toBe('img[data-editable]');
  });

  it("未打开时无灯箱 DOM（懒渲染，不污染编辑器 DOM）", () => {
    expect(isLightboxOpen()).toBe(false);
    // v0.15.0：渲染在 React 组件里，插件不再创建任何 DOM
    expect(document.getElementById("lightmd-lightbox")).toBeNull();
  });

  it("closeLightbox 在未打开时不抛错（幂等清理）", () => {
    expect(() => closeLightbox()).not.toThrow();
    expect(() => closeLightbox()).not.toThrow();
    expect(isLightboxOpen()).toBe(false);
  });

  it("插件层面：监听编辑器 DOM 点击，且只在阅读模式放行", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/core/plugins/image-lightbox.ts", "utf-8");
    // 点击采集仍挂在编辑器 DOM 上（不再把浮层挂 body）
    expect(src).toContain("bindImageLightbox(editorView.dom");
    // v0.15.1 需求7：闸门由「只读标签(editable)」改为「阅读模式(viewMode === "preview")」。
    // 旧判据 `editable === false` 只看标签只读标志、与 viewMode 无关，导致普通文档
    // 在阅读模式下 editable 仍为 true → 灯箱永远打不开（详见 imageLightboxPlugin 注释）。
    // 语义不变：仍只允许阅读模式放行，编辑模式 PM 面不弹灯箱。
    expect(src).toContain("isEnabled: isReadOnlyViewMode");
    expect(src).toContain('viewMode === "preview"');
    // 插件销毁时务必清理「已打开」标记，避免宿主误判残留浮层
    expect(src).toMatch(/destroy\(\)[\s\S]{0,300}?isLightboxOpen\(\)\) closeLightbox\(\)/);
    // 收敛：插件不再自建灯箱 DOM / 不再维护模块级渲染单例
    // （只看代码，不做全文匹配——注释里会出现这些词）
    expect(src).not.toMatch(/\.innerHTML\s*=/);
    expect(src).not.toContain("document.body.appendChild");
    expect(src).not.toMatch(/^let current(Images|Index)/m);
    expect(src).not.toContain("ensureBox");
  });

  it("事件契约：插件以事件请求组件打开（跨 document 由 detail.doc 承载）", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/core/plugins/image-lightbox.ts", "utf-8");
    expect(LIGHTBOX_OPEN_EVENT).toBe("lightmd:lightbox-open");
    expect(src).toContain("window.dispatchEvent");
    // 目标 document 随载荷传递（主文档 / 预览 iframe 各自 portal）
    expect(src).toContain("doc: ownerDocumentOf(root)");
  });
});
