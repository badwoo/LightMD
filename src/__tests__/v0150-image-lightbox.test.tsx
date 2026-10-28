/**
 * @vitest-environment jsdom
 *
 * v0.15.0 F1：图片灯箱组件行为测试（设计 §2.2/§2.3 验收项）。
 *
 * 覆盖：
 * 1. 懒渲染：未打开时不产生任何 DOM；
 * 2. portal 目标：主文档 → document.body；预览 iframe → iframe.ownerDocument.body；
 * 3. 交互：+/- 按钮缩放并钳制 25%/800%、滚轮缩放、双击 fit↔100%、Home 复位；
 * 4. 关闭：Esc / ✕ / 点遮罩 / 点图片本身**不**关闭；关闭后按**原值**还原滚动容器；
 * 5. 切图：←/→ 与按钮切图、索引回环、切图复位视图；单图隐藏切图控件；
 * 6. 生命周期：组件卸载强制关闭；切 document 不残留旧滚动锁；
 * 7. 无障碍：aria-modal、按钮 aria-label、坏图占位。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { ImageLightbox } from "../components/image/ImageLightbox";
import {
  LIGHTBOX_CLOSE_EVENT,
  LIGHTBOX_OPEN_EVENT,
  closeLightbox,
  isLightboxOpen,
  type LightboxOpenDetail,
} from "../core/plugins/image-lightbox";
import type { LightboxImage } from "../utils/imageLightbox";

/** 两张图的默认分组（多图 → 显示切图控件） */
const TWO_IMAGES: LightboxImage[] = [
  { src: "a.png", alt: "甲图" },
  { src: "b.png", alt: "乙图" },
];

/** 单图分组（单图 → 隐藏切图控件） */
const ONE_IMAGE: LightboxImage[] = [{ src: "only.png", alt: "独图" }];

/** 推送一次打开请求（模拟插件侧的点击采集结果） */
function emitOpen(images: LightboxImage[], index = 0, doc: Document = document) {
  act(() => {
    window.dispatchEvent(
      new CustomEvent<LightboxOpenDetail>(LIGHTBOX_OPEN_EVENT, {
        detail: { images, index, doc },
      }),
    );
  });
}

/** 查询灯箱根（默认主文档） */
function box(doc: Document = document): HTMLElement | null {
  return doc.querySelector<HTMLElement>('[data-testid="image-lightbox"]');
}

/** 视口内百分比文本 */
function percent(doc: Document = document): string | null {
  return doc.querySelector('[data-testid="lightbox-percent"]')?.textContent ?? null;
}

/** 渲染常驻挂载的灯箱（宿主接线形态） */
function mount() {
  return render(<ImageLightbox />);
}

/**
 * 模拟图片"已加载"：jsdom 不真正解码图片，`naturalWidth/naturalHeight` 恒为 0，
 * 于是 fit 与平移边界都退化。这里把 onload 语义补上（defineProperty + load 事件）。
 */
function simulateLoaded(naturalWidth: number, naturalHeight: number) {
  const img = document.querySelector<HTMLImageElement>('[data-testid="lightbox-image"]');
  if (!img) throw new Error("灯箱图片不存在");
  Object.defineProperty(img, "naturalWidth", { configurable: true, value: naturalWidth });
  Object.defineProperty(img, "naturalHeight", { configurable: true, value: naturalHeight });
  fireEvent.load(img);
}

beforeEach(() => {
  cleanup();
  closeLightbox();
  document.body.innerHTML = "";
  document.body.style.cssText = "";
  document.documentElement.style.cssText = "";
});

afterEach(() => {
  cleanup();
  closeLightbox();
});

describe("F1 灯箱：懒渲染与 portal 目标", () => {
  it("未打开时不渲染任何灯箱 DOM", () => {
    mount();
    expect(box()).toBeNull();
    expect(isLightboxOpen()).toBe(false);
  });

  it("打开后 portal 到主文档 body，并渲染图片与 ARIA 属性", () => {
    mount();
    emitOpen(TWO_IMAGES, 1);
    const root = box();
    expect(root).not.toBeNull();
    // portal 到 body：灯箱是 body 的直接子节点，不在 React 容器的子树里
    expect(root!.parentElement).toBe(document.body);
    expect(root!.getAttribute("role")).toBe("dialog");
    expect(root!.getAttribute("aria-modal")).toBe("true");
    expect(root!.getAttribute("data-target-doc")).toBe("main");
    // 图片：按索引渲染第 2 张，带 alt
    const img = root!.querySelector<HTMLImageElement>('[data-testid="lightbox-image"]');
    expect(img?.getAttribute("src")).toBe("b.png");
    expect(img?.getAttribute("alt")).toBe("乙图");
    // 多图：计数器就位
    expect(root!.querySelector('[data-testid="lightbox-counter"]')?.textContent).toContain("2 / 2");
    // 打开后状态可查（供宿主切文档时强制关闭）
    expect(isLightboxOpen()).toBe(true);
  });

  it("打开到预览 iframe 的 document（portal 用 iframe.ownerDocument.body）", () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const iframeDoc = iframe.contentDocument!;
    expect(iframeDoc).toBeTruthy();

    mount();
    emitOpen(TWO_IMAGES, 0, iframeDoc);

    // 灯箱挂在 iframe 文档里，主文档不应出现
    const inIframe = box(iframeDoc);
    expect(inIframe).not.toBeNull();
    expect(inIframe!.getAttribute("data-target-doc")).toBe("iframe");
    expect(box(document)).toBeNull();
  });

  it("滚动锁只作用于目标文档，关闭后按原值还原", () => {
    mount();
    // 主文档原本有内联 overflow（用户/其它模块设置过）→ 关闭后必须还原成该值
    document.body.style.setProperty("overflow", "scroll");
    const before = document.body.style.overflow;

    emitOpen(ONE_IMAGE);
    expect(document.body.style.overflow).toBe("hidden");

    act(() => {
      window.dispatchEvent(new CustomEvent(LIGHTBOX_CLOSE_EVENT));
    });
    expect(document.body.style.overflow).toBe(before);
  });

  it("原本没有内联 overflow 时，关闭后移除属性（不写空串残留）", () => {
    mount();
    expect(document.body.style.overflow).toBe("");
    emitOpen(ONE_IMAGE);
    expect(document.body.style.overflow).toBe("hidden");
    act(() => {
      window.dispatchEvent(new CustomEvent(LIGHTBOX_CLOSE_EVENT));
    });
    // removeProperty 后 attribute 里不残留 "overflow:" 片段
    expect(document.body.style.overflow).toBe("");
    expect(document.body.getAttribute("style") ?? "").not.toContain("overflow");
  });
});

describe("F1 灯箱：缩放与平移", () => {
  it("+ / - 按钮按 step 缩放并同步百分比", () => {
    mount();
    emitOpen(ONE_IMAGE);
    expect(percent()).toBe("100%");

    fireEvent.click(document.querySelector('[data-testid="lightbox-zoom-in"]')!);
    expect(percent()).toBe("120%");

    fireEvent.click(document.querySelector('[data-testid="lightbox-zoom-out"]')!);
    expect(percent()).toBe("100%");
  });

  it("缩放下限 25%：到达下限后 - 按钮禁用", () => {
    mount();
    emitOpen(ONE_IMAGE);
    const zoomOut = () => document.querySelector<HTMLButtonElement>('[data-testid="lightbox-zoom-out"]')!;
    // 100% → 连续缩小 9 次已越过 25%，应停在下限
    for (let i = 0; i < 9; i += 1) fireEvent.click(zoomOut());
    expect(percent()).toBe("25%");
    expect(zoomOut().disabled).toBe(true);
    // 再点也不会越过下限
    fireEvent.click(zoomOut());
    expect(percent()).toBe("25%");
  });

  it("缩放上限 800%：到达上限后 + 按钮禁用", () => {
    mount();
    emitOpen(ONE_IMAGE);
    const zoomIn = () => document.querySelector<HTMLButtonElement>('[data-testid="lightbox-zoom-in"]')!;
    for (let i = 0; i < 20; i += 1) fireEvent.click(zoomIn());
    expect(percent()).toBe("800%");
    expect(zoomIn().disabled).toBe(true);
    fireEvent.click(zoomIn());
    expect(percent()).toBe("800%");
  });

  it("滚轮：向上放大、向下缩小", () => {
    mount();
    emitOpen(ONE_IMAGE);
    const root = box()!;
    // jsdom 的 getBoundingClientRect 全为 0 → 组件退化为中心缩放（不影响倍率断言）
    fireEvent.wheel(root, { deltaY: -100 });
    expect(percent()).toBe("110%");
    fireEvent.wheel(root, { deltaY: 100 });
    expect(percent()).toBe("100%");
  });

  it("Home / 复位按钮把视图拉回 fit（并清掉平移）", () => {
    mount();
    emitOpen(ONE_IMAGE);
    fireEvent.click(document.querySelector('[data-testid="lightbox-zoom-in"]')!);
    expect(percent()).toBe("120%");
    fireEvent.click(document.querySelector('[data-testid="lightbox-reset"]')!);
    expect(percent()).toBe("100%");

    fireEvent.click(document.querySelector('[data-testid="lightbox-zoom-in"]')!);
    fireEvent.keyDown(document, { key: "Home" });
    expect(percent()).toBe("100%");
  });

  it("双击切换 fit ⇄ 100%（两次邻近 pointerdown）", () => {
    mount();
    emitOpen(ONE_IMAGE);
    const stage = document.querySelector('[data-testid="lightbox-stage"]')!;
    // fit 态（natural 未知时 fit=1，先缩到 120% 制造 custom 态）
    fireEvent.click(document.querySelector('[data-testid="lightbox-zoom-in"]')!);
    expect(percent()).toBe("120%");
    // 双击 → 回 fit（100%）
    fireEvent.pointerDown(stage, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerDown(stage, { button: 0, clientX: 11, clientY: 11, pointerId: 1 });
    expect(percent()).toBe("100%");
    // 再双击 → 100% 态下仍为 fit，倍数不变（fit=1 时"100%"既是 fit 也是 100%）
    fireEvent.pointerDown(stage, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerDown(stage, { button: 0, clientX: 11, clientY: 11, pointerId: 1 });
    expect(percent()).toBe("100%");
  });

  it("双击派生出的 click 不会把灯箱关掉（实机高频踩坑）", () => {
    mount();
    emitOpen(ONE_IMAGE);
    const stage = document.querySelector('[data-testid="lightbox-stage"]')!;
    const root = box()!;

    fireEvent.pointerDown(stage, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerDown(stage, { button: 0, clientX: 11, clientY: 11, pointerId: 1 });
    // 浏览器在第二次 pointerup 后仍会向遮罩派发一次 click
    fireEvent.click(root);

    expect(box()).not.toBeNull();
  });

  it("拖拽平移后的 click 不会把灯箱关掉（拖一下不该关闭）", () => {
    mount();
    emitOpen(ONE_IMAGE);
    // jsdom 不加载图片：手动造出"自然尺寸已量得"，否则 canPan 恒为 false（无平移空间）
    simulateLoaded(2000, 2000);
    const stage = document.querySelector('[data-testid="lightbox-stage"]')!;
    const root = box()!;
    // 放大一档，使渲染高度超出视口 → 可平移
    fireEvent.click(document.querySelector('[data-testid="lightbox-zoom-in"]')!);
    expect(stage.className).toContain("is-pannable");

    fireEvent.pointerDown(stage, { button: 0, clientX: 10, clientY: 10, pointerId: 2 });
    fireEvent.pointerMove(stage, { clientX: 60, clientY: 60, pointerId: 2 });
    fireEvent.pointerUp(stage, { clientX: 60, clientY: 60, pointerId: 2 });
    // 浏览器在 pointerup 后仍会派发 click
    fireEvent.click(root);

    expect(box()).not.toBeNull();
  });

  it("onload 后按自然尺寸算 fit：大图缩小到适应窗口（不越界）", () => {
    mount();
    emitOpen(ONE_IMAGE);
    // jsdom 视口 1024×768 → 显示区 944×640；自然 2000×2000 → fit = min(0.472, 0.32, 1) = 0.32
    simulateLoaded(2000, 2000);
    expect(percent()).toBe("32%");
    // 显式宽高按 fit 应用到 img（缩放靠它，而不是只靠 CSS 撑）
    const img = document.querySelector<HTMLImageElement>('[data-testid="lightbox-image"]')!;
    expect(parseFloat(img.style.width)).toBeCloseTo(2000 * 0.32, 1);
    expect(parseFloat(img.style.height)).toBeCloseTo(2000 * 0.32, 1);
  });

  it("onload 后小图不放大（fit 上限 100%）", () => {
    mount();
    emitOpen(ONE_IMAGE);
    simulateLoaded(40, 40);
    expect(percent()).toBe("100%");
  });

  it("自然尺寸量得 + 放大到超出视口 → 舞台进入可拖拽态", () => {
    mount();
    emitOpen(ONE_IMAGE);
    simulateLoaded(2000, 2000);
    const stage = () => document.querySelector('[data-testid="lightbox-stage"]')!;
    // fit 态（32%）图片完全在视口内 → 不可拖
    expect(stage().className).not.toContain("is-pannable");
    // 32% × 120% = 38.4% → 2000×0.384=768 > 显示区 640，竖向已可拖
    fireEvent.click(document.querySelector('[data-testid="lightbox-zoom-in"]')!);
    expect(stage().className).toContain("is-pannable");
  });

  it("切图后自然尺寸重置，等新图 onload 再重算 fit", () => {
    mount();
    emitOpen(TWO_IMAGES, 0);
    simulateLoaded(2000, 2000);
    expect(percent()).toBe("32%");
    fireEvent.click(document.querySelector('[data-testid="lightbox-next"]')!);
    // 新图未加载 → fit 回落 1（100%），加载后再按新尺寸算
    expect(percent()).toBe("100%");
    simulateLoaded(400, 400);
    // 400×400 在 944×640 内 → fit 仍是 1
    expect(percent()).toBe("100%");
  });
});

describe("F1 灯箱：关闭路径", () => {
  it("Esc 关闭并还原滚动锁", () => {
    mount();
    emitOpen(TWO_IMAGES);
    expect(box()).not.toBeNull();
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(box()).toBeNull();
    expect(document.body.style.overflow).toBe("");
    expect(isLightboxOpen()).toBe(false);
  });

  it("✕ 按钮关闭", () => {
    mount();
    emitOpen(ONE_IMAGE);
    fireEvent.click(document.querySelector('[data-testid="lightbox-close"]')!);
    expect(box()).toBeNull();
  });

  it("点击遮罩空白处关闭", () => {
    mount();
    emitOpen(ONE_IMAGE);
    fireEvent.click(box()!);
    expect(box()).toBeNull();
  });

  it("点击图片本身**不**关闭（设计 §2.3 明确要求）", () => {
    mount();
    emitOpen(ONE_IMAGE);
    const img = document.querySelector('[data-testid="lightbox-image"]')!;
    fireEvent.click(img);
    expect(box()).not.toBeNull();
    // 点工具栏也保持打开（避免一次点击同时触发缩放与关闭）
    fireEvent.click(document.querySelector('[data-testid="lightbox-percent"]')!);
    expect(box()).not.toBeNull();
  });

  it("onClose 回调在关闭时被调用一次", () => {
    const onClose = vi.fn();
    render(<ImageLightbox onClose={onClose} />);
    emitOpen(ONE_IMAGE);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("组件卸载强制关闭并还原滚动锁（防浮层/监听残留）", () => {
    const view = mount();
    emitOpen(ONE_IMAGE);
    expect(document.body.style.overflow).toBe("hidden");
    view.unmount();
    expect(document.body.style.overflow).toBe("");
    expect(isLightboxOpen()).toBe(false);
    expect(box()).toBeNull();
  });
});

describe("F1 灯箱：切图", () => {
  it("多图显示切图控件；单图隐藏", () => {
    mount();
    emitOpen(ONE_IMAGE);
    expect(document.querySelector('[data-testid="lightbox-prev"]')).toBeNull();
    expect(document.querySelector('[data-testid="lightbox-next"]')).toBeNull();
    expect(document.querySelector('[data-testid="lightbox-counter"]')).toBeNull();
    act(() => {
      window.dispatchEvent(new CustomEvent(LIGHTBOX_CLOSE_EVENT));
    });

    emitOpen(TWO_IMAGES);
    expect(document.querySelector('[data-testid="lightbox-prev"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="lightbox-next"]')).not.toBeNull();
  });

  it("→ / ← 键切图并索引回环", () => {
    mount();
    emitOpen(TWO_IMAGES, 0);
    const img = () => document.querySelector<HTMLImageElement>('[data-testid="lightbox-image"]')!;
    expect(img().getAttribute("src")).toBe("a.png");

    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(img().getAttribute("src")).toBe("b.png");
    // 回环：末尾再 → 回到第 1 张
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(img().getAttribute("src")).toBe("a.png");
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(img().getAttribute("src")).toBe("b.png");
  });

  it("切图按钮切图并复位缩放（设计 §2.3：切图复位 scale/offset）", () => {
    mount();
    emitOpen(TWO_IMAGES, 0);
    fireEvent.click(document.querySelector('[data-testid="lightbox-zoom-in"]')!);
    expect(percent()).toBe("120%");

    fireEvent.click(document.querySelector('[data-testid="lightbox-next"]')!);
    expect(document.querySelector<HTMLImageElement>('[data-testid="lightbox-image"]')!.getAttribute("src")).toBe(
      "b.png",
    );
    // 缩放复位（fit；natural 未加载时 fit=1 → 100%）
    expect(percent()).toBe("100%");
  });

  it("图注取 alt（没有 alt 时取 title），无文案时不渲染图注", () => {
    mount();
    emitOpen([{ src: "x.png", alt: "", title: "悬停提示" }]);
    expect(document.querySelector('[data-testid="lightbox-caption"]')?.textContent).toBe("悬停提示");

    act(() => {
      window.dispatchEvent(new CustomEvent(LIGHTBOX_CLOSE_EVENT));
    });
    emitOpen([{ src: "y.png", alt: "", title: "" }]);
    expect(document.querySelector('[data-testid="lightbox-caption"]')).toBeNull();
  });
});

describe("F1 灯箱：坏图与无障碍", () => {
  it("图片加载失败显示占位，灯箱保持打开（仍可切图 / 关闭）", () => {
    mount();
    emitOpen(TWO_IMAGES, 0);
    const img = document.querySelector('[data-testid="lightbox-image"]')!;
    fireEvent.error(img);
    expect(document.querySelector('[data-testid="lightbox-broken"]')).not.toBeNull();
    // 图片被占位替换
    expect(document.querySelector('[data-testid="lightbox-image"]')).toBeNull();
    // 仍可关闭
    fireEvent.keyDown(document, { key: "Escape" });
    expect(box()).toBeNull();
  });

  it("按钮都带 aria-label（无障碍验收项）", () => {
    mount();
    emitOpen(TWO_IMAGES);
    const testIds = ["lightbox-zoom-out", "lightbox-zoom-in", "lightbox-reset", "lightbox-close", "lightbox-prev", "lightbox-next"];
    for (const id of testIds) {
      const el = document.querySelector(`[data-testid="${id}"]`);
      expect(el, id).not.toBeNull();
      expect(el!.getAttribute("aria-label"), id).toBeTruthy();
    }
  });

  it("打开后焦点进入灯箱（键盘可达）", () => {
    mount();
    emitOpen(ONE_IMAGE);
    const root = box()!;
    expect(root.contains(document.activeElement)).toBe(true);
  });

  it("空分组不打开（防止插件误发事件产生空浮层）", () => {
    mount();
    emitOpen([], 0);
    expect(box()).toBeNull();
    expect(isLightboxOpen()).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// v0.15.1 需求7：入口改双击 + 全链路（NodeView → 采集层 → 灯箱组件）
// ═══════════════════════════════════════════════════════════════════
describe("v0.15.1 需求7：双击入口全链路", () => {
  it("阅读模式（viewMode=preview）：单击只选中、双击打开灯箱", async () => {
    const { createEditor } = await import("../core/editor");
    const { useEditorStore } = await import("../stores/useEditorStore");
    const { NodeSelection } = await import("prosemirror-state");
    const prevMode = useEditorStore.getState().viewMode;
    useEditorStore.setState({ viewMode: "preview" });

    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = createEditor({ parent: host, initialContent: "![甲](a.png)\n\n![乙](b.png)\n" })!;
    mount();
    try {
      // 关键前提：普通文档在阅读模式下 PM 仍是 editable === true（旧闸门失效的根因）
      expect(view.editable).toBe(true);
      const imgs = host.querySelectorAll<HTMLImageElement>(".image-node-wrapper img");
      expect(imgs).toHaveLength(2);

      // 单击 → 只选中（NodeSelection），不打开灯箱
      act(() => {
        imgs[1]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
      });
      expect(view.state.selection).toBeInstanceOf(NodeSelection);
      expect((view.state.selection as InstanceType<typeof NodeSelection>).node.type.name).toBe("image");
      expect(box()).toBeNull();
      expect(isLightboxOpen()).toBe(false);

      // 双击 → 打开灯箱，且分组为全文 2 张、索引为被双击的那张
      act(() => {
        imgs[1]!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      });
      const root = box();
      expect(root).not.toBeNull();
      expect(root!.querySelector('[data-testid="lightbox-counter"]')?.textContent).toContain("2 / 2");
      expect(
        root!.querySelector<HTMLImageElement>('[data-testid="lightbox-image"]')!.getAttribute("src"),
      ).toContain("b.png");
      expect(isLightboxOpen()).toBe(true);
    } finally {
      view.destroy();
      host.remove();
      useEditorStore.setState({ viewMode: prevMode });
    }
  });

  it("编辑模式（viewMode=edit）：双击图片**不**打开灯箱（保持选中 + 拖拽缩放）", async () => {
    const { createEditor } = await import("../core/editor");
    const { useEditorStore } = await import("../stores/useEditorStore");
    const prevMode = useEditorStore.getState().viewMode;
    useEditorStore.setState({ viewMode: "edit" });

    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = createEditor({ parent: host, initialContent: "![甲](a.png)\n" })!;
    mount();
    try {
      const img = host.querySelector<HTMLImageElement>(".image-node-wrapper img")!;
      act(() => {
        img.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
        img.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      });
      expect(box()).toBeNull();
      expect(isLightboxOpen()).toBe(false);
    } finally {
      view.destroy();
      host.remove();
      useEditorStore.setState({ viewMode: prevMode });
    }
  });

  it("灯箱打开后：Esc 关闭、←/→ 切图、+/- 缩放全部可用（复用既有状态机）", () => {
    mount();
    emitOpen(TWO_IMAGES, 0);
    const src = () => document.querySelector<HTMLImageElement>('[data-testid="lightbox-image"]')!.getAttribute("src");

    // 缩放：100% → 120% → 回 100%
    fireEvent.click(document.querySelector('[data-testid="lightbox-zoom-in"]')!);
    expect(percent()).toBe("120%");
    fireEvent.click(document.querySelector('[data-testid="lightbox-zoom-out"]')!);
    expect(percent()).toBe("100%");

    // 前后切换：→ 到 b，← 回 a，再 ← 回环到 b
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(src()).toBe("b.png");
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(src()).toBe("a.png");
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(src()).toBe("b.png");

    // Esc 关闭 + 滚动锁还原
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(box()).toBeNull();
    expect(document.body.style.overflow).toBe("");
    expect(isLightboxOpen()).toBe(false);
  });

  it("缩放上下限在双击入口链路上仍被钳制（25% / 800%）", () => {
    mount();
    emitOpen(ONE_IMAGE);
    const zoomOut = () => document.querySelector<HTMLButtonElement>('[data-testid="lightbox-zoom-out"]')!;
    const zoomIn = () => document.querySelector<HTMLButtonElement>('[data-testid="lightbox-zoom-in"]')!;
    for (let i = 0; i < 12; i += 1) fireEvent.click(zoomOut());
    expect(percent()).toBe("25%");
    for (let i = 0; i < 40; i += 1) fireEvent.click(zoomIn());
    expect(percent()).toBe("800%");
  });

  it("灯箱不进 PM 文档：打开/切图/关闭不产生事务与撤销历史", async () => {
    const { createEditor } = await import("../core/editor");
    const { undoDepth } = await import("prosemirror-history");
    const { useEditorStore } = await import("../stores/useEditorStore");
    const prevMode = useEditorStore.getState().viewMode;
    useEditorStore.setState({ viewMode: "preview" });

    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = createEditor({ parent: host, initialContent: "![甲](a.png)\n\n![乙](b.png)\n" })!;
    mount();
    try {
      const docBefore = view.state.doc;
      const undoBefore = undoDepth(view.state);
      const img = host.querySelector<HTMLImageElement>(".image-node-wrapper img")!;

      act(() => {
        img.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      });
      expect(box()).not.toBeNull();

      // 灯箱内切图 + 缩放
      act(() => {
        fireEvent.keyDown(document, { key: "ArrowRight" });
        fireEvent.click(document.querySelector('[data-testid="lightbox-zoom-in"]')!);
        fireEvent.keyDown(document, { key: "Escape" });
      });

      // 文档对象身份不变、撤销栈不增长 → 灯箱完全不参与序列化/撤销
      expect(view.state.doc).toBe(docBefore);
      expect(undoDepth(view.state)).toBe(undoBefore);
    } finally {
      view.destroy();
      host.remove();
      useEditorStore.setState({ viewMode: prevMode });
    }
  });
});

