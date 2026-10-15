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
// v0.12.0 需求6：块级选中（单击选中整块 → Delete 删除）
import { applyBlockSelected, clearBlockSelected, handleBlockStopEvent, placeCaretInsideBlock } from "./blockSelection";
// v0.13.0 需求1：右上角三点菜单（块级复制/剪切/删除/格式刷/移动）
import { createBlockKebabButton } from "./blockKebab";
// v0.12.2 P7：内联提示文案走 i18n（此前硬编码中文，英文界面穿帮）
import { t } from "../../i18n/state";

// 初始化 mermaid 配置（只执行一次）
let mermaidInitialized = false;
let currentMermaidTheme: "default" | "dark" = "default";

/**
 * v0.11.0 返修（B2-1 ④ 收口）：与应用内其它渲染路径统一为 strict。
 *
 * 导出侧（`buildMermaidInitScript` 默认值、`exportMathRender`）本已是 strict/antiscript，
 * 若编辑器仍用 loose，会出现「编辑器里 HTML 标签正常、导出后变成字面标签」的不一致；
 * strict 同时消除注入面。**副作用**：图表标签内的 HTML 不再被解释，按字面显示。
 */
const MERMAID_SECURITY_LEVEL = "strict";

function initMermaid() {
  if (mermaidInitialized) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: currentMermaidTheme,
    securityLevel: MERMAID_SECURITY_LEVEL,
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
    securityLevel: MERMAID_SECURITY_LEVEL,
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
  private handleDblClick: (e: MouseEvent) => void;
  /** v0.13.0 返修（问题2）：最近一次进入编辑态的时刻（区分"单击进编辑"引发的 dblclick） */
  private lastEnterEditAt = 0;
  /** v0.13.0 需求1：右上角三点菜单按钮（常驻显示由 CSS 控制） */
  private kebabButton: HTMLButtonElement | null = null;

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

    // 点击切换编辑/预览态（双击预览层可切回预览）
    this.handleDblClick = (e: MouseEvent) => this.onDblClick(e);
    this.dom.addEventListener("dblclick", this.handleDblClick);
    // v0.13.0 返修（问题2）：**单击即进入编辑**（编辑层默认 display:none，
    // 不展开则 PM 找不到可见的可编辑位置，单击毫无反应）
    this.dom.addEventListener("mousedown", this.handleMouseDown);

    // v0.13.0 需求1：右上角三点菜单（常驻显示由 CSS 控制）
    this.kebabButton = createBlockKebabButton(this.dom, this.getPos);

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

  /**
   * v0.13.0 返修（问题2）：单击展开编辑层并放置光标。
   * 只在「左键单击 + 未处于编辑态 + 非交互控件」时生效。
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
   * v0.13.0 返修（问题2）：双击语义（与公式块同款，避免"单击进编辑、
   * 紧接着的 dblclick 又退出"）。
   */
  private onDblClick(e: MouseEvent) {
    const target = e.target as HTMLElement | null;
    if (this.isEditing && target && this.contentDOM.contains(target)) return;
    if (this.isEditing && Date.now() - this.lastEnterEditAt < 600) return;
    this.toggleEditMode();
  }

  /** 进入编辑态（单击 / 双击共用，保证状态一致） */
  private enterEditMode() {
    this.isEditing = true;
    this.lastEnterEditAt = Date.now();
    this.previewLayer.style.display = "none";
    this.contentDOM.style.cssText =
      "display:block !important;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:break-word;" +
      "padding:1em;font-family:var(--font-mono);font-size:0.9em;line-height:1.5;" +
      "color:var(--text-primary);caret-color:var(--text-primary);background:transparent;";
    this.dom.classList.add("mermaid-editing");
  }

  /** 切换编辑/预览态 */
  private toggleEditMode() {
    this.isEditing = !this.isEditing;
    if (this.isEditing) {
      this.enterEditMode();
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
      this.previewLayer.innerHTML = `<div class="mermaid-empty">${t("mermaid.empty")}</div>`;
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
      this.previewLayer.innerHTML = `<div class="mermaid-error"><span class="mermaid-error-icon">⚠</span> ${t("mermaid.syntaxError")}<div class="mermaid-error-detail">${this.escapeHtml(errorMsg)}</div></div>`;
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
    // 不再强制清缓存:renderMermaid 内部按 getCode() 结果与 lastRenderedCode 比对,
    // 内容未变的 update(选区/属性等无关事务)直接命中缓存跳过渲染
    this.renderMermaid();
    return true;
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    const target = mutation.target as globalThis.Node;
    // 忽略预览层的 DOM 突变
    if (this.previewLayer.contains(target)) {
      return true;
    }
    // v0.13.0 返修第三轮（问题3）：**自身编辑态的突变也必须忽略**。
    //
    // 缺陷背景（用户报告「mermaid 图表块单击没有立即进入编辑，点击整个块会闪动」）：
    // enterEditMode() 改 contentDOM 的 style、previewLayer 的 style、以及 this.dom 的
    // class（mermaid-editing）。这些是编辑器自己的 DOM 变化，但本方法此前只忽略
    // previewLayer 内的突变 → PM 的 DOMObserver 把其余变化当成"文档被外部改动" →
    // 节点标脏 → 下一帧重建整个节点 DOM（实测 80ms 后 wrapper 与 contentDOM 都换成
    // 新对象、class 与 display 全部回到初始值）。
    // 用户看到的就是编辑层一闪即没（"闪动"），等于没进编辑态。
    // 注意：contentDOM 内的**文本编辑**（characterData / childList）必须放行，
    // 否则在图表源码里打字不会进文档。
    if (target === this.contentDOM && mutation.type === "attributes") return true;
    if (target === this.dom && mutation.type === "attributes") return true;
    return false;
  }

  // ─── v0.12.0 需求6：块级选中（单击选中整块 → Delete 删除；双击进编辑） ───
  selectNode = () => applyBlockSelected(this.dom);
  deselectNode = () => clearBlockSelected(this.dom);
  stopEvent = (event: Event) =>
    handleBlockStopEvent(this.dom, this.view, this.getPos, event);

  destroy() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.observer?.disconnect();
    this.observer = null;
    this.dom.removeEventListener("dblclick", this.handleDblClick);
    this.dom.removeEventListener("mousedown", this.handleMouseDown);
    // v0.13.0 需求1：移除三点按钮
    this.kebabButton?.remove();
    this.kebabButton = null;
  }
}
