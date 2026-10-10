/**
 * TaskItemView —— 任务列表项 NodeView
 *
 * 设计：
 * - 渲染 checkbox + 文本内容
 * - 点击 checkbox 切换 checked 状态
 * - checked 状态下文本显示删除线效果
 *
 * v0.12.1 需求5：两种复选框样式（方形/圆形）+ 阅读模式样式手柄
 * - 样式由 `task_item.attrs.style` 决定（square/circle），li 上同步
 *   `task-item-circle` class 与 `data-style`（与 schema.toDOM / markdown-it renderer 同构）；
 * - 复选框左侧的浅色手柄 `::`：点击弹出"方形 / 圆形"下拉，选择即 setNodeMarkup
 *   改属性 —— 序列化端据此把列表符号写成 `-` / `*`（见 core/markdown/task-style.ts）；
 * - 菜单**挂到 document.body**（fixed 定位），不放编辑器 DOM 里：既避免被 .ProseMirror
 *   的 contenteditable / 选区体系干扰，也避免 NodeView 的 li 子节点在挂载后被增删，
 *   触发 ProseMirror 的 MutationObserver 重解析（那会破坏内容）。
 */
import type { NodeView, EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { normalizeTaskStyle, type TaskStyle } from "../markdown/task-style";
import { t } from "../../i18n/state";

export class TaskItemView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private node: PMNode;
  private view: EditorView;
  private getPos: () => number | undefined;
  private checkbox: HTMLInputElement;
  private handleChange: () => void;
  /** v0.12.1 需求5：样式手柄（浅色 :: ）与它的下拉菜单 */
  private styleHandle: HTMLButtonElement;
  private styleMenu: HTMLElement | null = null;
  private onHandleClick: (e: MouseEvent) => void;
  private onDocMouseDown: ((e: MouseEvent) => void) | null = null;

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;

    const style = normalizeTaskStyle(node.attrs.style);

    // 外层容器
    this.dom = document.createElement("li");
    this.dom.className = style === "circle" ? "task-item task-item-circle" : "task-item";
    this.dom.setAttribute("data-checked", String(node.attrs.checked));
    this.dom.setAttribute("data-style", style);

    // v0.12.1 需求5：复选框前的浅色样式手柄（不参与内容流，见 editor.css 的绝对定位）
    this.styleHandle = document.createElement("button");
    this.styleHandle.type = "button";
    this.styleHandle.className = "task-style-handle";
    this.styleHandle.textContent = "::";
    this.styleHandle.setAttribute("contenteditable", "false");
    this.styleHandle.setAttribute("aria-haspopup", "menu");
    this.styleHandle.setAttribute("aria-label", t("task.style.handle"));
    this.styleHandle.title = t("task.style.handle");
    this.onHandleClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.styleMenu) this.closeMenu();
      else this.openMenu();
    };
    this.styleHandle.addEventListener("click", this.onHandleClick);
    this.dom.appendChild(this.styleHandle);

    // checkbox
    this.checkbox = document.createElement("input");
    this.checkbox.type = "checkbox";
    this.checkbox.checked = node.attrs.checked;
    this.checkbox.className = "task-checkbox";
    this.handleChange = () => this.toggleChecked();
    this.checkbox.addEventListener("change", this.handleChange);
    this.dom.appendChild(this.checkbox);

    // 内容区域
    this.contentDOM = document.createElement("div");
    this.contentDOM.className = "task-content";
    if (node.attrs.checked) {
      this.contentDOM.classList.add("task-checked");
    }
    this.dom.appendChild(this.contentDOM);
  }

  private currentStyle(): TaskStyle {
    return normalizeTaskStyle(this.node.attrs.style);
  }

  private toggleChecked() {
    const pos = this.getPos();
    if (pos === undefined) return;
    const checked = this.checkbox.checked;
    const tr = this.view.state.tr.setNodeMarkup(pos, undefined, {
      ...this.node.attrs,
      checked,
    });
    this.view.dispatch(tr);
  }

  /** v0.12.1 需求5：切换样式（square ⇄ circle）——一次 setNodeMarkup，可整体撤销 */
  private setStyle(style: TaskStyle) {
    if (style === this.currentStyle()) return;
    const pos = this.getPos();
    if (pos === undefined) return;
    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, style }),
    );
  }

  /** 打开样式下拉（挂到 body，fixed 定位在手柄左侧） */
  private openMenu() {
    const menu = document.createElement("div");
    menu.className = "task-style-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("data-testid", "task-style-menu");
    const current = this.currentStyle();
    (["square", "circle"] as TaskStyle[]).forEach((style) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `task-style-item${style === current ? " active" : ""}`;
      item.setAttribute("role", "menuitemradio");
      item.setAttribute("aria-checked", String(style === current));
      item.dataset.style = style;
      const preview = document.createElement("span");
      preview.className = `task-style-preview${style === "circle" ? " circle" : ""}`;
      const label = document.createElement("span");
      label.textContent = t(style === "circle" ? "task.style.circle" : "task.style.square");
      item.appendChild(preview);
      item.appendChild(label);
      // mousedown 阻止默认：不抢焦点、不让编辑器选区跳到别处
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      item.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.setStyle(style);
        this.closeMenu();
      });
      menu.appendChild(item);
    });

    // 先挂到 body 再量宽度：菜单贴手柄**左侧**展开（不遮挡任务文字）
    menu.style.position = "fixed";
    menu.style.left = "-9999px";
    menu.style.top = "-9999px";
    document.body.appendChild(menu);
    const rect = this.styleHandle.getBoundingClientRect();
    const menuWidth = menu.offsetWidth || 116;
    const menuHeight = menu.offsetHeight || 72;
    menu.style.left = `${Math.max(6, rect.left - menuWidth - 8)}px`;
    menu.style.top = `${Math.max(6, Math.min(rect.top, window.innerHeight - menuHeight - 8))}px`;
    this.styleMenu = menu;

    // 点击菜单外部 / Esc / 滚动 → 关闭（捕获阶段，先于编辑器处理）
    this.onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target && menu.contains(target)) return;
      if (target && this.styleHandle.contains(target)) return;
      this.closeMenu();
    };
    document.addEventListener("mousedown", this.onDocMouseDown, true);
    document.addEventListener("keydown", this.onMenuKey, true);
  }

  private onMenuKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.closeMenu();
    }
  };

  private closeMenu() {
    if (!this.styleMenu) return;
    this.styleMenu.remove();
    this.styleMenu = null;
    if (this.onDocMouseDown) {
      document.removeEventListener("mousedown", this.onDocMouseDown, true);
      this.onDocMouseDown = null;
    }
    document.removeEventListener("keydown", this.onMenuKey, true);
  }

  /** 手柄与菜单不在 contentDOM 内：事件一律不交给 ProseMirror */
  stopEvent = (event: Event): boolean => {
    const target = event.target as Node | null;
    if (!target) return false;
    if (this.styleHandle.contains(target)) return true;
    if (this.styleMenu && this.styleMenu.contains(target)) return true;
    return false;
  };

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.checkbox.checked = node.attrs.checked;
    this.dom.setAttribute("data-checked", String(node.attrs.checked));
    // v0.12.1 需求5：样式跟随节点属性。用 classList.toggle 而非重设 className——
    // 块级选中（pm-block-selected）等装饰类挂在同一个 li 上，整体重设会把它抹掉。
    const style = normalizeTaskStyle(node.attrs.style);
    this.dom.classList.toggle("task-item-circle", style === "circle");
    this.dom.setAttribute("data-style", style);
    if (node.attrs.checked) {
      this.contentDOM.classList.add("task-checked");
    } else {
      this.contentDOM.classList.remove("task-checked");
    }
    return true;
  }

  destroy() {
    this.checkbox.removeEventListener("change", this.handleChange);
    this.styleHandle.removeEventListener("click", this.onHandleClick);
    this.closeMenu();
  }
}
