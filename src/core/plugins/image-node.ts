/**
 * v0.13.2 需求10：图片的「激活 + 边缘拖拽缩放 + 右上角编辑手柄」。
 *
 * ## 用户要求
 * 「当前点击文档中图片会弹窗进入编辑，现在需要进行功能调整：在图片右上角加上小手柄
 *  按钮，鼠标移动到图片上就会显现，将弹窗进入编辑的功能放在这个按钮里点击即可进入。
 *  而原来点击图片改为激活该图片，通过鼠标拖拽图片边缘可以进行图片大小调整。」
 *
 * ## 语义
 * - **单击图片** → 激活（选中该 image 节点，显示选中描边），**不弹编辑窗**；
 * - **悬停图片** → 右上角出现小手柄（齿轮/铅笔图标）；点它才打开 ImageEditDialog；
 * - **拖拽四边/四角** → 等比缩放，只记**宽度**（用户确认：只记宽度、保持宽高比），
 *   写回 `image.attrs.width` → 序列化为 `![alt|宽](src)`（既有 E11a 约定）；
 * - 拖拽期间显示实时尺寸提示，松手**一次事务**写入（= 一次撤销）。
 *
 * ## 为什么做成 NodeView 而不是"在 EditorContainer 里监听 DOM"
 * 缩放需要"拖拽起点 / 实时预览 / 松手提交"三段状态，且必须与 PM 的
 * `ignoreMutation` 协作（改 style 不能被当成文档改动）。NodeView 天然持有
 * `getPos` 与 `view`，比在容器层靠 `posAtDOM` 反查更稳。
 *
 * ## 与图片灯箱的关系
 * 灯箱（`image-lightbox.ts`）只在**只读标签**生效（`editable === false`）。
 * 本 NodeView 在可编辑时接管点击；只读时点击仍由灯箱处理（`onClick` 里判断）。
 */
import type { NodeView, EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { NodeSelection } from "prosemirror-state";
import { t } from "../../i18n/state";
import { resolveImageSrc } from "../../utils/imagePath";

/** 最小宽度（px）：再小就看不清，也容易拖不回来 */
const MIN_WIDTH = 24;
/** 手柄尺寸（px） */
const HANDLE_SIZE = 12;

/**
 * v0.13.2 需求10：图片 NodeView。
 *
 * 只负责"激活 / 缩放 / 编辑手柄"三件事，图片本身的 src/alt/对齐仍由
 * `schema.image.toDOM` 决定 —— 这里把 `toDOM` 的输出包进一个 wrapper，
 * 从而能在图片上方叠加热区与手柄（而不改 Markdown 表达）。
 */
export class ImageView implements NodeView {
  /** NodeView 根（wrapper，含图片 + 手柄 + 热区） */
  dom: HTMLElement;
  /** 图片元素（PM 认为的"节点本体"，选中描边画在它上面） */
  private img: HTMLImageElement;
  private node: PMNode;
  private view: EditorView;
  private getPos: () => number | undefined;
  /** 右上角编辑手柄 */
  private editHandle: HTMLButtonElement;
  /** 拖拽中的实时宽度（px）；null = 未在拖拽 */
  private dragWidth: number | null = null;
  /** 拖拽起始状态 */
  private dragStart: {
    pointerX: number;
    startWidth: number;
    /** 拖拽的是哪条边/角（决定宽度增减方向） */
    dir: "e" | "w" | "se" | "sw" | "ne" | "nw";
  } | null = null;
  /** 尺寸提示气泡 */
  private sizeTip: HTMLElement;
  /** 拖拽中的全局监听清理 */
  private cleanupDrag: (() => void) | null = null;

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;

    this.dom = document.createElement("span");
    this.dom.className = "image-node-wrapper";
    // 关键：wrapper 必须 `inline-block` 且 `position:relative`，
    // 手柄与热区才能相对图片定位；同时不能打断行内排版（图片本是 inline 节点）。
    this.dom.style.cssText = "position:relative;display:inline-block;max-width:100%;line-height:0;";

    this.img = document.createElement("img");
    this.dom.appendChild(this.img);
    this.syncAttrs();

    // 右上角编辑手柄（hover 显现；点它才打开编辑弹窗）
    this.editHandle = document.createElement("button");
    this.editHandle.type = "button";
    this.editHandle.className = "image-node-handle";
    this.editHandle.setAttribute("contenteditable", "false");
    this.editHandle.setAttribute("aria-label", t("image.editHandle"));
    this.editHandle.title = t("image.editHandle");
    this.editHandle.dataset.testid = "image-edit-handle";
    this.editHandle.innerHTML =
      '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
    this.editHandle.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      e.preventDefault();
    });
    this.editHandle.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.openEditor();
    });
    this.dom.appendChild(this.editHandle);

    // 尺寸提示（拖拽中显示）
    this.sizeTip = document.createElement("span");
    this.sizeTip.className = "image-node-size-tip";
    this.sizeTip.setAttribute("contenteditable", "false");
    this.dom.appendChild(this.sizeTip);

    // 四边/四角热区（拖拽缩放）
    for (const dir of ["e", "w", "se", "sw", "ne", "nw"] as const) {
      const zone = document.createElement("span");
      zone.className = `image-resize-zone image-resize-${dir}`;
      zone.setAttribute("contenteditable", "false");
      zone.dataset.dir = dir;
      zone.addEventListener("mousedown", (e) => this.startResize(e, dir));
      this.dom.appendChild(zone);
    }

    // 点击图片 = 激活（选中该 image 节点），不弹编辑窗
    this.img.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      // 只读标签：放行给图片灯箱（image-lightbox 的冒泡监听）
      if (view.editable === false) return;
      e.preventDefault();
      e.stopPropagation();
      this.activate();
    });
  }
  /** v0.13.2 需求10：激活图片（建立 NodeSelection，显示选中描边） */
  private activate() {
    const pos = this.getPos();
    if (pos == null) return;
    const { state } = this.view;
    try {
      this.view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, pos)));
      this.view.focus();
    } catch {
      /* 位置失效（文档刚被改过）→ 忽略 */
    }
  }

  /** v0.13.2 需求10：打开图片编辑弹窗（由 EditorContainer 监听该事件） */
  private openEditor() {
    const pos = this.getPos();
    if (pos == null) return;
    window.dispatchEvent(
      new CustomEvent("lightmd:image-edit", { detail: { pos } }),
    );
  }

  /** 把 node attrs 同步到 img（src/alt/title/width/align） */
  private syncAttrs() {
    const { src, alt, title, width, align } = this.node.attrs;
    // src 必须经 resolveImageSrc 解析（相对路径 → asset://），与 schema.toDOM 同源
    this.img.src = resolveImageSrc(src);
    this.img.alt = alt || "";
    this.img.title = title || "";
    this.img.setAttribute("data-editable", "true");
    this.img.setAttribute("loading", "lazy");
    this.img.setAttribute("decoding", "async");
    if (typeof width === "number" && width > 0) {
      this.img.style.width = `${width}px`;
    } else {
      this.img.style.width = "";
    }
    // 对齐：非 left 用 display:block + margin auto（与 schema 的 toDOM 同口径）
    if (align === "center" || align === "right") {
      this.img.style.display = "block";
      this.img.style.marginLeft = "auto";
      this.img.style.marginRight = align === "center" ? "auto" : "0";
    } else {
      this.img.style.display = "";
      this.img.style.marginLeft = "";
      this.img.style.marginRight = "";
    }
  }

  /**
   * v0.13.2 需求10：开始拖拽缩放。
   *
   * 宽度方向：拖东侧（e/se/ne）向右增宽；拖西侧（w/sw/nw）向左增宽。
   * 高度不单独记录（用户确认「只记宽度、保持宽高比」），由浏览器按原始比例缩放。
   */
  private startResize(e: MouseEvent, dir: "e" | "w" | "se" | "sw" | "ne" | "nw") {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = this.img.getBoundingClientRect();
    // 起始宽度取**当前渲染宽度**（未设 width 时是图片原始显示宽度）
    const startWidth = rect.width > 0 ? rect.width : this.img.naturalWidth || MIN_WIDTH;
    this.dragStart = { pointerX: e.clientX, startWidth, dir };
    this.dragWidth = startWidth;
    this.dom.classList.add("image-resizing");
    this.sizeTip.textContent = `${Math.round(startWidth)}px`;

    const onMove = (ev: MouseEvent) => this.onResizeMove(ev);
    const onUp = () => this.endResize();
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp, { once: true });
    this.cleanupDrag = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }

  /** 拖拽中：实时改 img 宽度（只动 style，不进文档；由 ignoreMutation 屏蔽） */
  private onResizeMove(e: MouseEvent) {
    if (!this.dragStart) return;
    const { pointerX, startWidth, dir } = this.dragStart;
    // 西侧（含左上/左下角）向右拖是**变窄**，故取反
    const sign = dir === "w" || dir === "sw" || dir === "nw" ? -1 : 1;
    const delta = (e.clientX - pointerX) * sign;
    const next = Math.max(MIN_WIDTH, Math.round(startWidth + delta));
    this.dragWidth = next;
    this.img.style.width = `${next}px`;
    this.sizeTip.textContent = `${next}px`;
  }

  /** 松手：一次事务写回 width（= 一次撤销） */
  private endResize() {
    this.cleanupDrag?.();
    this.cleanupDrag = null;
    const width = this.dragWidth;
    const start = this.dragStart;
    this.dragStart = null;
    this.dragWidth = null;
    this.dom.classList.remove("image-resizing");
    this.sizeTip.textContent = "";
    if (width === null || !start) return;
    // 没真正改变（点了一下没拖）→ 不产生事务，避免污染撤销栈
    if (Math.abs(width - start.startWidth) < 1) {
      this.syncAttrs();
      return;
    }
    const pos = this.getPos();
    if (pos == null) return;
    const { state } = this.view;
    try {
      const tr = state.tr.setNodeMarkup(pos, undefined, {
        ...this.node.attrs,
        width,
      });
      this.view.dispatch(tr);
    } catch {
      this.syncAttrs();
    }
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    // 拖拽中不覆盖实时宽度（update 可能由其他事务触发）
    if (this.dragWidth === null) this.syncAttrs();
    return true;
  }

  /**
   * v0.13.2 需求10：忽略**自身**的属性变更。
   *
   * 拖拽时会直接改 `img.style.width` 与 wrapper 的 class —— 这些是编辑器自己的
   * DOM 变化，不忽略的话 PM 的 DOMObserver 会把它当成"文档被外部改动"，
   * 触发整块重建（拖拽立刻中断、宽度回弹）。
   * 注意：`img.src` 由 syncAttrs 改，也属于自身变更，同样忽略。
   */
  ignoreMutation(): boolean {
    return true;
  }

  /** v0.13.2 需求10：选中态描边（复用块级选中的视觉语言） */
  selectNode = () => {
    this.dom.classList.add("image-node-selected");
  };

  deselectNode = () => {
    this.dom.classList.remove("image-node-selected");
  };

  /** 阻止拖拽手柄/热区上的事件冒泡到编辑器（否则会移动光标、打断拖拽） */
  stopEvent = (event: Event): boolean => {
    const target = event.target as HTMLElement | null;
    if (!target) return false;
    // 手柄与热区上的所有鼠标事件都由本 NodeView 处理
    return !!target.closest(".image-node-handle, .image-resize-zone, .image-node-size-tip");
  };

  destroy() {
    this.cleanupDrag?.();
    this.cleanupDrag = null;
  }
}

/** 手柄/热区尺寸常量导出（供 CSS 对齐与测试断言） */
export const IMAGE_HANDLE_SIZE = HANDLE_SIZE;
