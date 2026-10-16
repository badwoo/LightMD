/**
 * MathBlockView / MathInlineView —— KaTeX 数学公式 NodeView
 *
 * 设计：
 * - 预览态：调用 katex.renderToString() 将 LaTeX 渲染为 HTML
 * - 编辑态：显示 LaTeX 源码文本编辑区
 * - 双击切换编辑/预览态，默认预览态
 *
 * N3（v0.5.0）编辑态实时预览：
 * - 编辑时预览层不再隐藏，块级公式为「编辑区在上 + 预览在下」并列布局
 * - update() 时预览随源码实时刷新，输入即见渲染结果
 *
 * 性能优化：
 * - 缓存上次渲染的 LaTeX 文本，内容未变时跳过
 * - update() 用 rAF 合并渲染：连续输入只在下一帧渲染一次，减少 KaTeX 开销
 * - 语法错误时显示友好提示
 */
import type { NodeView, EditorView, ViewMutationRecord } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import katex from "katex";
// v0.12.0 需求6：块级选中（单击选中整块 → Delete 删除；行内公式不需要）
import { applyBlockSelected, clearBlockSelected, handleBlockStopEvent, placeCaretInsideBlock } from "./blockSelection";
// v0.13.0 需求1：右上角三点菜单（块级复制/剪切/删除/格式刷/移动）
import { createBlockKebabButton } from "./blockKebab";
// v0.13.1 需求6：就地编辑层的公共行为（尺寸自适应 / 点块外退出 / 过渡）
import {
  inlineEditorHiddenCss,
  inlineEditorVisibleCss,
  watchOutsidePointerDown,
} from "./inlineBlockEditor";

/** 行内公式 NodeView */
export class MathInlineView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private node: PMNode;
  private isEditing = false;
  private lastRenderedLatex = "";
  private rafId: number | null = null;
  private handleDblClick: () => void;

  constructor(node: PMNode, _view: EditorView, _getPos: () => number | undefined) {
    this.node = node;

    // 外层容器
    this.dom = document.createElement("span");
    this.dom.className = "math-inline-wrapper";
    this.dom.setAttribute("data-math", "inline");

    // 预览层
    this.contentDOM = document.createElement("span");
    this.contentDOM.className = "math-inline-content";
    this.contentDOM.setAttribute("contenteditable", "true");
    this.contentDOM.style.cssText =
      "display:none;white-space:pre-wrap;font-family:var(--font-mono);font-size:0.9em;";
    this.dom.appendChild(this.contentDOM);

    // 双击切换编辑/预览态
    this.handleDblClick = () => this.toggleEditMode();
    this.dom.addEventListener("dblclick", this.handleDblClick);

    // 初始渲染
    this.renderKatex();
  }

  private toggleEditMode() {
    this.isEditing = !this.isEditing;
    if (this.isEditing) {
      this.contentDOM.style.display = "inline";
      this.dom.classList.add("math-editing");
      // N3：进入编辑即渲染一次，保证预览与源码同步
      this.lastRenderedLatex = "";
      this.renderKatex();
    } else {
      this.contentDOM.style.display = "none";
      this.dom.classList.remove("math-editing");
      this.renderKatex();
    }
  }

  private renderKatex() {
    const latex = this.getLatex();
    if (latex === this.lastRenderedLatex) return;
    this.lastRenderedLatex = latex;

    if (!latex || latex === "\u200B") {
      this.dom.setAttribute("data-latex", "");
      return;
    }

    this.dom.setAttribute("data-latex", latex);

    try {
      const html = katex.renderToString(latex, {
        throwOnError: false,
        displayMode: false,
      });
      // 更新预览：在 contentDOM 之前插入预览节点
      const preview = this.dom.querySelector(".math-inline-preview");
      if (preview) preview.remove();
      const previewEl = document.createElement("span");
      previewEl.className = "math-inline-preview";
      previewEl.innerHTML = html;
      this.dom.insertBefore(previewEl, this.contentDOM);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const preview = this.dom.querySelector(".math-inline-preview");
      if (preview) preview.remove();
      const previewEl = document.createElement("span");
      previewEl.className = "math-inline-preview math-error";
      previewEl.textContent = `⚠ ${errorMsg}`;
      this.dom.insertBefore(previewEl, this.contentDOM);
    }
  }

  private getLatex(): string {
    // 优先使用 node 文本（ProseMirror 权威数据源），contentDOM 文本可能滞后
    const nodeText = this.node.textContent;
    if (nodeText && nodeText !== "\u200B") return nodeText;
    const contentDOMText = this.contentDOM.textContent;
    if (contentDOMText && contentDOMText !== "\u200B") return contentDOMText;
    return "";
  }

  /**
   * v0.13.0 返修第三轮（问题3）：忽略自身编辑态的 DOM 突变（与块级公式同因）。
   *
   * toggleEditMode() 改 `this.dom` 的 class 与 contentDOM 的 display，
   * 不忽略的话 PM 会把这些当成文档改动 → 重建节点 DOM → 编辑态被重置。
   * contentDOM 内的真实文本编辑照常放行。
   */
  ignoreMutation(mutation: ViewMutationRecord): boolean {
    const target = mutation.target as globalThis.Node;
    if (target === this.dom && mutation.type === "attributes") return true;
    if (target === this.contentDOM && mutation.type === "attributes") return true;
    return false;
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    // N3：rAF 合并渲染，连续输入只在下一帧渲染一次（编辑态实时预览）
    this.scheduleRender();
    return true;
  }

  /** N3：rAF 合并 KaTeX 渲染，避免每个按键触发一次全量渲染 */
  private scheduleRender() {
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.lastRenderedLatex = "";
      this.renderKatex();
    });
  }

  destroy() {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.dom.removeEventListener("dblclick", this.handleDblClick);
  }
}

/** 块级公式 NodeView */
export class MathBlockView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private node: PMNode;
  private isEditing = false;
  private lastRenderedLatex = "";
  private rafId: number | null = null;
  private previewLayer: HTMLElement;
  private handleDblClick: (e: MouseEvent) => void;
  /** v0.13.0 返修（问题2）：最近一次进入编辑态的时刻（区分"单击进编辑"引发的 dblclick） */
  private lastEnterEditAt = 0;
  /** v0.13.1 需求6：编辑态期间"点块外退出"的取消订阅句柄 */
  private outsideWatchCleanup: (() => void) | null = null;
  // v0.12.0 需求6：块级选中需要 view/getPos（原实现未保存，无法建 NodeSelection）
  private view: EditorView;
  private getPos: () => number | undefined;
  // v0.12.0 需求6：块级选中（单击选中整块 → Delete 删除；双击进编辑）
  selectNode = () => applyBlockSelected(this.dom);
  deselectNode = () => clearBlockSelected(this.dom);
  stopEvent = (event: Event) =>
    handleBlockStopEvent(this.dom, this.view, this.getPos, event);
  /** v0.13.0 需求1：右上角三点菜单按钮（常驻显示由 CSS 控制） */
  private kebabButton: HTMLButtonElement | null = null;

  /**
   * v0.13.0 返修第三轮（问题3）：**忽略自身编辑态造成的全部 DOM 突变**。
   *
   * 缺陷背景（用户报告「mermaid 图表块和公式块单击没有立即进入编辑，点击整个块会闪动」）：
   * `enterEditMode()` 改了三处 DOM：contentDOM 的 `style`（display:none→block）、
   * previewLayer 的 `style`、以及 `this.dom` 的 `class`（math-editing）与 `data-latex`。
   * 这些都是**编辑器自己的**变化，但本类没有实现 `ignoreMutation` → ProseMirror 的
   * DOMObserver 把它们当成「文档内容被外部改动」→ 节点标脏 → 下一帧**重建整个节点 DOM**
   * （实测 80ms 后 wrapper 与 contentDOM 都换成新对象、class 与 display 全部回到初始值）。
   * 用户看到的就是编辑层一闪即没（"闪动"），等于没进编辑态。
   *
   * 实测抓到的突变序列：contentDOM.style / previewLayer.style /
   * wrapper.class / wrapper.data-latex / previewLayer 子节点变化。
   * 本方法把它们全部忽略；**contentDOM 内部的真实文本编辑**（characterData /
   * childList）仍交给 PM 正常处理，否则在公式里打字不会进文档。
   */
  ignoreMutation(mutation: ViewMutationRecord): boolean {
    const target = mutation.target as globalThis.Node;
    // 预览层：整体是渲染产物，与文档内容无关
    if (this.previewLayer.contains(target)) return true;
    // 编辑层自身的 style 变化（display 切换）不是文档内容
    if (target === this.contentDOM && mutation.type === "attributes") return true;
    // wrapper 自身的 class / data-latex（编辑态标记 + 预览缓存）
    if (target === this.dom && mutation.type === "attributes") return true;
    return false;
  }

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;

    // 外层容器
    this.dom = document.createElement("div");
    this.dom.className = "math-block-wrapper";
    this.dom.setAttribute("data-math", "block");

    // 预览层
    this.previewLayer = document.createElement("div");
    this.previewLayer.className = "math-block-preview";
    this.dom.appendChild(this.previewLayer);

    // 编辑层
    this.contentDOM = document.createElement("code");
    this.contentDOM.className = "math-block-content";
    this.contentDOM.setAttribute("contenteditable", "true");
    this.contentDOM.style.cssText = inlineEditorHiddenCss(false);
    this.dom.appendChild(this.contentDOM);

    // 双击切换编辑/预览态（保留：双击预览层可切回预览）
    this.handleDblClick = (e: MouseEvent) => this.onDblClick(e);
    this.dom.addEventListener("dblclick", this.handleDblClick);
    // v0.13.0 返修（问题2）：**单击即进入编辑**。
    // 编辑层默认 display:none，PM 找不到可见的可编辑位置 → 单击无反应。
    // 这里在左键单击时先展开编辑层，再把光标放进块内（与代码块表现一致）。
    this.dom.addEventListener("mousedown", this.handleMouseDown);

    // v0.13.0 需求1：右上角三点菜单（常驻显示由 CSS 控制）
    this.kebabButton = createBlockKebabButton(this.dom, this.getPos);

    // 初始渲染
    this.renderKatex();
  }

  /**
   * v0.13.0 返修（问题2）：单击展开编辑层并放置光标。
   *
   * 只在「左键单击 + 未处于编辑态 + 非交互控件」时生效；右键/交互控件放行，
   * 双击仍由 dblclick 走 toggleEditMode（切换回预览）。
   */
  private handleMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest?.("button, select, input, textarea, a")) return;
    if (this.isEditing) return;
    e.preventDefault();
    e.stopPropagation();
    this.enterEditMode();
    const pos = this.getPos();
    if (pos == null) return;
    placeCaretInsideBlock(this.view, pos, e.clientX, e.clientY);
  };

  /**
   * v0.13.0 返修（问题2）：双击语义。
   *
   * 单击已经进入编辑态，因此双击**不能**再简单地 toggle —— 否则「单击进编辑、
   * 紧接着的第二次点击（dblclick）又退出」，用户看到的是双击后什么都没发生；
   * 而且在编辑区内双击选词也会意外退出编辑。
   *
   * 规则：
   * - 双击落在**编辑区**内 → 放行（交给浏览器选词），不切换状态；
   * - 刚由单击进入编辑（同一手势的 dblclick）→ 忽略，保持编辑态；
   * - 其余情况（双击预览层）→ 切换（可切回预览）。
   */
  private onDblClick(e: MouseEvent) {
    const target = e.target as HTMLElement | null;
    if (this.isEditing && target && this.contentDOM.contains(target)) return;
    if (this.isEditing && Date.now() - this.lastEnterEditAt < 600) return;
    this.toggleEditMode();
  }

  /**
   * 切换编辑/预览态。
   *
   * v0.13.1 需求6 修复：**不要**在这里先 `isEditing = !isEditing`。
   * `exitEditMode()` 开头有 `if (!this.isEditing) return;`（幂等保护），
   * 若外面已经把它翻成 false，退出路径会被自己的守卫挡掉 → 双击永远退不出编辑态
   * （实测：类名 math-editing 一直挂着）。状态改由 enter/exit 各自拥有。
   */
  private toggleEditMode() {
    if (this.isEditing) {
      this.exitEditMode();
    } else {
      this.enterEditMode();
    }
  }

  /**
   * v0.13.1 需求6：退出编辑态 = **恢复渲染**。
   *
   * 从 enterEditMode / toggleEditMode /「点击块外」三处共用，保证状态一致
   * （旧实现把退出逻辑内联在 toggleEditMode 里，导致新增的"点块外退出"无法复用）。
   */
  private exitEditMode() {
    if (!this.isEditing) return;
    this.isEditing = false;
    // 先撤掉"点块外"监听，避免退出过程里重复触发
    this.stopOutsideWatch();
    this.contentDOM.style.cssText = inlineEditorHiddenCss(false) + "white-space:pre-wrap;";
    this.dom.classList.remove("math-editing");
    this.renderKatex();
  }

  private stopOutsideWatch() {
    this.outsideWatchCleanup?.();
    this.outsideWatchCleanup = null;
  }

  /** v0.13.0 返修（问题2）：进入编辑态（单击 / 双击共用同一入口，保证状态一致） */
  private enterEditMode() {
    this.isEditing = true;
    this.lastEnterEditAt = Date.now();
    // N3：编辑态实时预览 —— 编辑区在上、预览层在下并列显示（不再隐藏预览）
    //
    // v0.13.1 需求6：尺寸改为**按内容**（单行 LaTeX → width:fit-content，
    // 短公式不再撑满整行的大方框）；并声明过渡 + 淡入动画，进入过程平滑不抖动。
    this.contentDOM.style.cssText = inlineEditorVisibleCss(false);
    this.previewLayer.style.display = "block";
    this.dom.classList.add("math-editing");
    this.lastRenderedLatex = "";
    this.renderKatex();
    // v0.13.1 需求6：点击**块外**任何地方立即恢复渲染
    this.stopOutsideWatch();
    this.outsideWatchCleanup = watchOutsidePointerDown(this.dom, () => this.exitEditMode());
  }

  private renderKatex() {
    const latex = this.getLatex();
    if (latex === this.lastRenderedLatex) return;
    this.lastRenderedLatex = latex;

    this.dom.setAttribute("data-latex", latex);

    if (!latex || latex === "\u200B") {
      this.previewLayer.innerHTML = '<div class="math-empty">双击编辑数学公式</div>';
      return;
    }

    try {
      const html = katex.renderToString(latex, {
        throwOnError: false,
        displayMode: true,
      });
      this.previewLayer.innerHTML = html;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.previewLayer.innerHTML = `<div class="math-error"><span class="math-error-icon">⚠</span> 公式语法错误<div class="math-error-detail">${this.escapeHtml(errorMsg)}</div></div>`;
    }
  }

  private getLatex(): string {
    // 优先使用 node 文本（ProseMirror 权威数据源），contentDOM 文本可能滞后
    const nodeText = this.node.textContent;
    if (nodeText && nodeText !== "\u200B") return nodeText;
    const contentDOMText = this.contentDOM.textContent;
    if (contentDOMText && contentDOMText !== "\u200B") return contentDOMText;
    return "";
  }

  private escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    // N3：rAF 合并渲染，连续输入只在下一帧渲染一次（编辑态实时预览）
    this.scheduleRender();
    return true;
  }

  /** N3：rAF 合并 KaTeX 渲染，避免每个按键触发一次全量渲染 */
  private scheduleRender() {
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.lastRenderedLatex = "";
      this.renderKatex();
    });
  }

  destroy() {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.dom.removeEventListener("dblclick", this.handleDblClick);
    this.dom.removeEventListener("mousedown", this.handleMouseDown);
    // v0.13.1 需求6：销毁时必须摘掉 document 级的"点块外"监听，避免泄漏
    this.stopOutsideWatch();
    // v0.13.0 需求1：移除三点按钮
    this.kebabButton?.remove();
    this.kebabButton = null;
  }
}
