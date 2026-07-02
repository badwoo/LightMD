/**
 * MermaidBlockView —— Mermaid 图表 NodeView
 *
 * 设计：
 * - 预览态：调用 mermaid.render() 将源码渲染为 SVG 图表
 * - 编辑态：显示 mermaid 源码文本编辑区（类似 CodeBlockView 的双层结构）
 * - 点击节点可切换编辑/预览态，默认预览态
 *
 * 性能优化：
 * - 防抖渲染（500ms），内容未变时跳过
 * - 缓存上次渲染的源码文本
 * - 语法错误时显示友好提示而非崩溃
 */
import type { NodeView, EditorView, ViewMutationRecord } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import mermaid from "mermaid";

// 初始化 mermaid 配置（只执行一次）
let mermaidInitialized = false;
let currentMermaidTheme: "default" | "dark" = "default";

function initMermaid() {
  if (mermaidInitialized) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: currentMermaidTheme,
    securityLevel: "loose",
    fontFamily: "inherit",
  });
  mermaidInitialized = true;
}

/**
 * 更新 mermaid 主题（亮色/暗色）
 * 修复：原代码硬编码 theme: "default"，暗色主题下 mermaid 图表渲染异常
 * 在 EditorContainer 中监听 theme 变化时调用此函数
 */
export function setMermaidTheme(isDark: boolean) {
  const newTheme = isDark ? "dark" : "default";
  if (newTheme === currentMermaidTheme && mermaidInitialized) return;
  currentMermaidTheme = newTheme;
  mermaid.initialize({
    startOnLoad: false,
    theme: newTheme,
    securityLevel: "loose",
    fontFamily: "inherit",
  });
  mermaidInitialized = true;
}

// 渲染计数器，用于生成唯一 ID
let renderCount = 0;

export class MermaidBlockView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private node: PMNode;
  private view: EditorView;
  private getPos: () => number | undefined;

  // 渲染相关
  private previewLayer: HTMLElement;
  private isEditing = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRenderedCode = "";
  private observer: MutationObserver | null = null;
  private handleDblClick: () => void;

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    initMermaid();
    this.node = node;
    this.view = view;
    this.getPos = getPos;

    // 外层容器
    this.dom = document.createElement("div");
    this.dom.className = "mermaid-block-wrapper";
    this.dom.setAttribute("data-language", "mermaid");

    // 预览层（显示渲染后的 SVG）
    this.previewLayer = document.createElement("div");
    this.previewLayer.className = "mermaid-preview-layer";
    this.dom.appendChild(this.previewLayer);

    // 编辑层（ProseMirror 管理的文本编辑区）
    this.contentDOM = document.createElement("code");
    this.contentDOM.className = "language-mermaid";
    this.contentDOM.setAttribute("contenteditable", "true");
    this.contentDOM.style.cssText =
      "display:none !important;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:break-word;" +
      "padding:1em;font-family:var(--font-mono);font-size:0.9em;line-height:1.5;";
    this.dom.appendChild(this.contentDOM);

    // 点击切换编辑/预览态
    this.handleDblClick = () => this.toggleEditMode();
    this.dom.addEventListener("dblclick", this.handleDblClick);

    // 初始渲染
    this.renderMermaid();

    // 监听内容变化，防抖重新渲染
    this.observer = new MutationObserver(() => {
      this.debouncedRender();
    });
    this.observer.observe(this.contentDOM, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }

  /** 切换编辑/预览态 */
  private toggleEditMode() {
    this.isEditing = !this.isEditing;
    if (this.isEditing) {
      // 切换到编辑态
      this.previewLayer.style.display = "none";
      this.contentDOM.style.display = "block";
      this.contentDOM.style.cssText =
        "display:block !important;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:break-word;" +
        "padding:1em;font-family:var(--font-mono);font-size:0.9em;line-height:1.5;" +
        "color:var(--text-primary);caret-color:var(--text-primary);background:transparent;";
      this.dom.classList.add("mermaid-editing");
    } else {
      // 切换到预览态
      this.contentDOM.style.display = "none";
      this.previewLayer.style.display = "block";
      this.dom.classList.remove("mermaid-editing");
      this.renderMermaid();
    }
  }

  /** 防抖渲染 */
  private debouncedRender() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.renderMermaid();
    }, 500);
  }

  /** 渲染 mermaid 图表 */
  private async renderMermaid() {
    const code = this.getCode();
    // 缓存命中：内容未变时跳过
    if (code === this.lastRenderedCode) return;
    this.lastRenderedCode = code;

    if (!code || code === "\u200B") {
      this.previewLayer.innerHTML = '<div class="mermaid-empty">双击编辑 Mermaid 图表</div>';
      return;
    }

    try {
      const id = `mermaid-${++renderCount}`;
      const { svg } = await mermaid.render(id, code);
      this.previewLayer.innerHTML = svg;
    } catch (err) {
      // 语法错误时显示友好提示
      const errorMsg = err instanceof Error ? err.message : String(err);
      // 清理 mermaid 产生的错误 DOM（mermaid 渲染失败时会创建 id 为 d+id 的元素）
      const errorEl = document.getElementById(`dmermaid-${renderCount}`);
      if (errorEl) errorEl.remove();
      this.previewLayer.innerHTML = `<div class="mermaid-error"><span class="mermaid-error-icon">⚠</span> 图表语法错误<div class="mermaid-error-detail">${this.escapeHtml(errorMsg)}</div></div>`;
    }
  }

  /** 获取当前 mermaid 源码文本 */
  private getCode(): string {
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
    this.lastRenderedCode = "";
    this.renderMermaid();
    return true;
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    // 忽略预览层的 DOM 突变
    if (this.previewLayer.contains(mutation.target as globalThis.Node)) {
      return true;
    }
    return false;
  }

  destroy() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.observer?.disconnect();
    this.observer = null;
    this.dom.removeEventListener("dblclick", this.handleDblClick);
  }
}
