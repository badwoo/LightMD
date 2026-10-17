// @vitest-environment jsdom
/**
 * v0.13.2 需求10：图片「激活 + 边缘拖拽缩放 + 右上角编辑手柄」。
 *
 * ## 用户原话
 * 「在图片右上角加上小手柄按钮，鼠标移动到图片上就会显现，将弹窗进入编辑的功能放在
 *  这个按钮里点击即可进入。而原来点击图片改为激活该图片，通过鼠标拖拽图片边缘
 *  可以进行图片大小调整。」方案确认：「只记宽度、保持宽高比」。
 *
 * ## 本文件锁定的行为
 * - NodeView DOM：wrapper / img / 右上角手柄 / 6 个缩放热区（e,w,se,sw,ne,nw）；
 * - 单击图片 = 激活（NodeSelection + `image-node-selected`），**不**派发编辑事件；
 * - 点手柄才派发 `lightmd:image-edit`，`detail.pos` 指向该 image 节点；
 * - 拖热区：拖拽中只改预览样式、不提交事务；mouseup **一次** `setNodeMarkup` 写回 width；
 * - 西侧方向（w/sw/nw）符号取反；宽度下限 MIN_WIDTH = 24；只写 width，不写 height；
 * - 只读标签（`view.editable === false`）下点图片放行给灯箱，不做激活。
 *
 * ## jsdom 限制
 * jsdom 没有布局，`getBoundingClientRect()` 恒为 0；实现用「渲染宽度（rect.width），
 * 缺失时回退 naturalWidth」作为拖拽起点，因此这里显式 stub img 的
 * `getBoundingClientRect`（width/height/left/top/right/bottom 自洽），
 * 让拖拽断言有真实意义。
 */
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { NodeSelection } from "prosemirror-state";
import { undo, undoDepth } from "prosemirror-history";
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { createEditor } from "../core/editor";

const IMAGE_MD = "![示例图片](img.png)\n";

function mount(
  content = IMAGE_MD,
  opts: { editable?: () => boolean } = {},
): { view: EditorView; host: HTMLElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = createEditor({
    parent: host,
    initialContent: content,
    ...(opts.editable ? { editableGetter: opts.editable } : {}),
  })!;
  return { view, host };
}

/** 派发一个左键 mouse 事件 */
function mouse(
  target: EventTarget,
  type: string,
  opts: { x?: number; y?: number; button?: number } = {},
): void {
  target.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: opts.button ?? 0,
      clientX: opts.x ?? 0,
      clientY: opts.y ?? 0,
    }),
  );
}

/** 让 jsdom 里某个元素的 getBoundingClientRect 返回自洽的尺寸 */
function stubRect(
  el: Element,
  rect: { left?: number; top?: number; width: number; height: number },
): void {
  const left = rect.left ?? 0;
  const top = rect.top ?? 0;
  const r = {
    left,
    top,
    width: rect.width,
    height: rect.height,
    right: left + rect.width,
    bottom: top + rect.height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue(r);
}

/** 找文档里的第一个 image 节点 */
function findImage(view: EditorView): PMNode | null {
  let found: PMNode | null = null;
  view.state.doc.descendants((node) => {
    if (found) return false;
    if (node.type.name === "image") {
      found = node;
      return false;
    }
    return true;
  });
  return found;
}

function wrapper(host: HTMLElement): HTMLElement {
  return host.querySelector(".image-node-wrapper") as HTMLElement;
}

function zones(host: HTMLElement): HTMLElement[] {
  return Array.from(host.querySelectorAll(".image-resize-zone")) as HTMLElement[];
}

function zone(host: HTMLElement, dir: string): HTMLElement {
  return host.querySelector(`.image-resize-zone[data-dir="${dir}"]`) as HTMLElement;
}

function img(host: HTMLElement): HTMLImageElement {
  return host.querySelector(".image-node-wrapper img") as HTMLImageElement;
}

/** 完整拖拽一次（mousedown 在热区 → mousemove 到目标 x → mouseup） */
function drag(
  host: HTMLElement,
  dir: string,
  fromX: number,
  toX: number,
): void {
  mouse(zone(host, dir), "mousedown", { x: fromX });
  mouse(document, "mousemove", { x: toX });
  mouse(document, "mouseup", { x: toX });
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

// jsdom 未实现 document.elementFromPoint，而 PM 的 posAtCoords（连同 block-drag 的
// mousedown 热区探测）依赖它。补一个"命中不到任何元素"的最小桩：这是环境缺口，
// 与图片 NodeView 的行为无关；本文件所有缩放断言都由 stub 的 rect 驱动。
beforeAll(() => {
  (document as unknown as { elementFromPoint: unknown }).elementFromPoint = () => null;
});

// ═══════════════════ NodeView DOM 结构 ═══════════════════

describe("需求10：图片 NodeView 的 DOM 结构", () => {
  it("图片被包进 .image-node-wrapper，含 img、右上角手柄与尺寸提示", () => {
    const { view, host } = mount();
    try {
      const wrap = wrapper(host);
      expect(wrap).toBeTruthy();
      expect(wrap.querySelector("img")).toBe(img(host));
      expect(wrap.querySelector(".image-node-handle")).toBeTruthy();
      expect(wrap.querySelector(".image-node-size-tip")).toBeTruthy();
      // 手柄上有可访问名称（点它才进入编辑，不能是纯装饰 div）
      const handle = wrap.querySelector(".image-node-handle") as HTMLButtonElement;
      expect(handle.tagName).toBe("BUTTON");
      expect(handle.getAttribute("aria-label")?.length ?? 0).toBeGreaterThan(0);
      expect(img(host).alt).toBe("示例图片");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("六个缩放热区的 data-dir 齐全：e / w / se / sw / ne / nw", () => {
    const { view, host } = mount();
    try {
      expect(zones(host).map((z) => z.dataset.dir).sort()).toEqual([
        "e",
        "ne",
        "nw",
        "se",
        "sw",
        "w",
      ]);
    } finally {
      view.destroy();
      host.remove();
    }
  });
});

// ═══════════════════ 激活与编辑手柄 ═══════════════════

describe("需求10：点图片 = 激活；点手柄 = 进入编辑", () => {
  it("单击图片建立 NodeSelection 并加上选中描边，且**不**派发编辑事件", () => {
    const { view, host } = mount();
    const editEvents: CustomEvent[] = [];
    const onEdit = (e: Event) => editEvents.push(e as CustomEvent);
    window.addEventListener("lightmd:image-edit", onEdit);
    try {
      mouse(img(host), "mousedown", { x: 10, y: 10 });

      expect(view.state.selection).toBeInstanceOf(NodeSelection);
      const sel = view.state.selection as NodeSelection;
      expect(sel.node.type.name).toBe("image");
      expect(wrapper(host).classList.contains("image-node-selected")).toBe(true);
      // 原「点图弹编辑窗」的逻辑已移入手柄：点图不得弹窗
      expect(editEvents).toHaveLength(0);
    } finally {
      window.removeEventListener("lightmd:image-edit", onEdit);
      view.destroy();
      host.remove();
    }
  });

  it("点右上角手柄派发 lightmd:image-edit，detail.pos 是合法的 image 节点位置", () => {
    const { view, host } = mount();
    const editEvents: CustomEvent[] = [];
    const onEdit = (e: Event) => editEvents.push(e as CustomEvent);
    window.addEventListener("lightmd:image-edit", onEdit);
    try {
      const handle = host.querySelector(".image-node-handle") as HTMLElement;
      mouse(handle, "click", { x: 12, y: 12 });

      expect(editEvents).toHaveLength(1);
      const pos = (editEvents[0].detail as { pos: number }).pos;
      expect(typeof pos).toBe("number");
      expect(pos).toBeGreaterThanOrEqual(0);
      expect(pos).toBeLessThanOrEqual(view.state.doc.content.size);
      // pos 指向的正是该 image 节点（EditorContainer 据此打开 ImageEditDialog）
      expect(view.state.doc.nodeAt(pos)?.type.name).toBe("image");
    } finally {
      window.removeEventListener("lightmd:image-edit", onEdit);
      view.destroy();
      host.remove();
    }
  });

  it("只读标签（view.editable === false）：点图片不做激活（放行给灯箱）", () => {
    const { view, host } = mount(IMAGE_MD, { editable: () => false });
    try {
      expect(view.editable).toBe(false);
      mouse(img(host), "mousedown", { x: 10, y: 10 });

      // 没有建立 image 的 NodeSelection（灯箱走自己的冒泡监听）
      const sel = view.state.selection;
      const isImageNodeSel =
        sel instanceof NodeSelection && sel.node.type.name === "image";
      expect(isImageNodeSel).toBe(false);
      expect(wrapper(host).classList.contains("image-node-selected")).toBe(false);
    } finally {
      view.destroy();
      host.remove();
    }
  });
});

// ═══════════════════ 拖拽缩放 ═══════════════════

describe("需求10：边缘拖拽缩放（只记宽度、保持宽高比）", () => {
  it("东侧拖拽：拖拽中只改预览样式，mouseup 才一次事务写回 width", () => {
    const { view, host } = mount();
    try {
      stubRect(img(host), { left: 40, top: 20, width: 200, height: 100 });
      const docBefore = view.state.doc;

      // 按下：进入拖拽态（视觉反馈：image-resizing + 尺寸提示）
      mouse(zone(host, "e"), "mousedown", { x: 100, y: 50 });
      expect(wrapper(host).classList.contains("image-resizing")).toBe(true);
      const tip = host.querySelector(".image-node-size-tip") as HTMLElement;
      expect(tip.textContent).toBe("200px");

      // 拖动 +60px：只改 style，文档必须**还没**变
      mouse(document, "mousemove", { x: 160, y: 50 });
      expect(view.state.doc).toBe(docBefore);
      expect(findImage(view)!.attrs.width).toBeNull();
      expect(img(host).style.width).toBe("260px");
      expect(tip.textContent).toBe("260px");

      // 松手：一次 setNodeMarkup 写回 width
      mouse(document, "mouseup", { x: 160, y: 50 });
      expect(wrapper(host).classList.contains("image-resizing")).toBe(false);
      expect(tip.textContent).toBe("");

      const after = findImage(view)!;
      expect(after.attrs.width).toBe(260);
      // 只记宽度：节点上没有 height 属性被写进来（等比缩放交给浏览器）
      expect(Object.keys(after.attrs)).not.toContain("height");
      expect(img(host).style.width).toBe("260px");

      // 「一次事务 = 一次撤销」：撤销一步就回到未设宽度的原始状态
      expect(undoDepth(view.state)).toBe(1);
      undo(view.state, view.dispatch);
      expect(findImage(view)!.attrs.width).toBeNull();
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("西侧（w）方向符号取反：鼠标右移 → 宽度**减小**", () => {
    const { view, host } = mount();
    try {
      stubRect(img(host), { width: 200, height: 100 });
      drag(host, "w", 200, 260); // 向右拖 60px
      // 西侧向右拖 = 变窄：200 - 60 = 140
      expect(findImage(view)!.attrs.width).toBe(140);
      expect(findImage(view)!.attrs.width).toBeLessThan(200);
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("角落热区（se / nw）走同一套宽度逻辑", () => {
    const { view, host } = mount();
    try {
      stubRect(img(host), { width: 200, height: 100 });
      drag(host, "se", 100, 150); // 东南角向右拖 → 变宽
      expect(findImage(view)!.attrs.width).toBe(250);
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("最小宽度钳制：拖到极小也不会低于 24px", () => {
    const { view, host } = mount();
    try {
      stubRect(img(host), { width: 200, height: 100 });
      drag(host, "e", 100, -10000);
      expect(findImage(view)!.attrs.width).toBe(24);
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("点一下不拖（宽度变化 < 1px）不产生事务，撤销栈不被污染", () => {
    const { view, host } = mount();
    try {
      stubRect(img(host), { width: 200, height: 100 });
      const before = view.state.doc;
      mouse(zone(host, "e"), "mousedown", { x: 100, y: 50 });
      mouse(document, "mouseup", { x: 100, y: 50 });

      expect(view.state.doc).toBe(before);
      expect(findImage(view)!.attrs.width).toBeNull();
      expect(undoDepth(view.state)).toBe(0);
      expect(wrapper(host).classList.contains("image-resizing")).toBe(false);
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("从已有 width 继续拖拽：以当前宽度为起点（而不是原始尺寸）", () => {
    const { view, host } = mount("![图|120](img.png)\n");
    try {
      // 解析出的图片已带 width=120；stub 的渲染宽度与之一致
      expect(findImage(view)!.attrs.width).toBe(120);
      stubRect(img(host), { width: 120, height: 60 });
      drag(host, "e", 100, 130); // +30
      expect(findImage(view)!.attrs.width).toBe(150);
    } finally {
      view.destroy();
      host.remove();
    }
  });
});

