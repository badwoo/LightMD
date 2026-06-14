/**
 * MathBlockView / MathInlineView —— KaTeX 数学公式 NodeView
 *
 * 设计：
 * - 预览态：调用 katex.renderToString() 将 LaTeX 渲染为 HTML
 * - 编辑态：显示 LaTeX 源码文本编辑区
 * - 双击切换编辑/预览态，默认预览态
 *
 * 性能优化：
 * - 缓存上次渲染的 LaTeX 文本，内容未变时跳过
 * - 语法错误时显示友好提示
 */
import type { NodeView, EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import katex from "katex";

/** 行内公式 NodeView */
export class MathInlineView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private node: PMNode;
  private isEditing = false;
  private lastRenderedLatex = "";
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

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    // 强制清除缓存，因为 node 已更新
    this.lastRenderedLatex = "";
    this.renderKatex();
    return true;
  }

  destroy() {
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
  private previewLayer: HTMLElement;
  private handleDblClick: () => void;

  constructor(node: PMNode, _view: EditorView, _getPos: () => number | undefined) {
    this.node = node;

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
    this.contentDOM.style.cssText =
      "display:none;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:break-word;" +
      "padding:1em;font-family:var(--font-mono);font-size:0.9em;line-height:1.5;";
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
      this.previewLayer.style.display = "none";
      this.contentDOM.style.display = "block";
      this.contentDOM.style.cssText =
        "display:block !important;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:break-word;" +
        "padding:1em;font-family:var(--font-mono);font-size:0.9em;line-height:1.5;" +
        "color:var(--text-primary);caret-color:var(--text-primary);background:transparent;";
      this.dom.classList.add("math-editing");
    } else {
      this.contentDOM.style.display = "none";
      this.previewLayer.style.display = "block";
      this.dom.classList.remove("math-editing");
      this.renderKatex();
    }
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
    // 强制清除缓存，因为 node 已更新
    this.lastRenderedLatex = "";
    this.renderKatex();
    return true;
  }

  destroy() {
    this.dom.removeEventListener("dblclick", this.handleDblClick);
  }
}
