/**
 * CodeBlockView —— 代码块 NodeView（双层结构）
 *
 * 设计：
 * - 高亮层（highlightLayer）：只读展示，显示 PrismJS 高亮后的 HTML
 * - 编辑层（contentDOM）：ProseMirror 管理，透明叠加在高层之上
 *
 * 用户看到的是高亮语法，实际编辑的是底层纯文本。
 * 不再直接修改 contentDOM.innerHTML，避免破坏 ProseMirror DOM 追踪。
 *
 * 性能优化：
 * - MutationObserver 防抖，避免 ProseMirror 批量 DOM 修改时频繁触发高亮
 * - 缓存上次高亮的 code 文本，内容未变时跳过高亮计算
 * - 去掉 escapeHtml 比较，直接判断高亮结果是否包含 token span
 */
import type { NodeView, EditorView, ViewMutationRecord } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { highlightCode } from "../../utils/highlight";

export class CodeBlockView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private highlightLayer: HTMLElement;
  private node: PMNode;
  private observer: MutationObserver | null = null;
  // 防抖定时器
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  // 缓存上次高亮的文本，避免重复计算
  private lastHighlightedCode = "";

  constructor(node: PMNode, _view: EditorView, _getPos: () => number | undefined) {
    this.node = node;
    const lang = node.attrs.language || "";

    // 外层容器
    this.dom = document.createElement("div");
    this.dom.className = "code-block-wrapper";
    if (lang) this.dom.setAttribute("data-language", lang);
    // 阻止 click 事件导致光标异常
    this.dom.style.position = "relative";

    // 高亮展示层（在编辑层下方）
    this.highlightLayer = document.createElement("code");
    this.highlightLayer.className = `prism-highlighted${lang ? ` language-${lang}` : ""}`;
    // 确保高亮层始终有可见的文字颜色，padding 与编辑层一致
    this.highlightLayer.style.cssText =
      "display:block !important;position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none;" +
      "white-space:pre-wrap;word-wrap:break-word;overflow-wrap:break-word;" +
      "padding:1em;color:var(--prism-text, #383a42) !important;background:transparent !important;" +
      "overflow:hidden;z-index:0;";
    this.dom.appendChild(this.highlightLayer);

    // ProseMirror 编辑层（透明，用户在上方打字）
    this.contentDOM = document.createElement("code");
    this.contentDOM.className = lang ? `language-${lang}` : "";
    this.contentDOM.style.cssText =
      "display:block !important;position:relative;color:transparent !important;caret-color:var(--text-primary);" +
      "white-space:pre-wrap;word-wrap:break-word;overflow-wrap:break-word;" +
      "background:transparent !important;z-index:1;padding:1em;";
    // 让 contentDOM 可被 ProseMirror 识别为可编辑区域
    this.contentDOM.setAttribute("contenteditable", "true");
    this.dom.appendChild(this.contentDOM);

    // 立即同步高亮（node.textContent 在构造时始终可用）
    this.syncHighlight();

    // 监听 contentDOM 内容变化，防抖同步高亮
    this.observer = new MutationObserver(() => {
      this.debouncedSyncHighlight();
    });
    this.observer.observe(this.contentDOM, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }

  /** 防抖同步高亮：合并短时间内多次 DOM 变更 */
  private debouncedSyncHighlight() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.syncHighlight();
    }, 30);
  }

  /** 将编辑层文本同步到高亮层 */
  private syncHighlight() {
    const lang = this.node.attrs.language || "";
    // contentDOM 有实际内容时优先使用（实时编辑场景），
    // 否则使用 node.textContent（文件打开时 contentDOM 可能还未填充）
    const contentDOMText = this.contentDOM.textContent;
    const nodeText = this.node.textContent;
    const code = (contentDOMText && contentDOMText !== "\u200B")
      ? contentDOMText
      : (nodeText && nodeText !== "\u200B")
        ? nodeText
        : "";

    // 缓存命中：内容未变时跳过高亮计算
    if (code === this.lastHighlightedCode) return;
    this.lastHighlightedCode = code;

    // 始终保持 prism-highlighted 类，确保绝对定位样式生效
    this.highlightLayer.classList.add("prism-highlighted");
    if (code) {
      if (lang) {
        try {
          const highlighted = highlightCode(code, lang);
          // 检查高亮结果是否包含 token span（有则说明产生了语法高亮）
          if (highlighted.includes('class="token')) {
            this.highlightLayer.innerHTML = highlighted;
          } else {
            // 无语法高亮 token，直接显示文本
            this.highlightLayer.textContent = code;
          }
        } catch {
          this.highlightLayer.textContent = code;
        }
      } else {
        // 没有语言标识，直接显示文本（使用 prism-text 颜色）
        this.highlightLayer.textContent = code;
      }
    } else {
      this.highlightLayer.textContent = "";
    }
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    const oldLang = this.node.attrs.language;
    this.node = node;
    const newLang = node.attrs.language || "";

    if (newLang !== oldLang) {
      this.contentDOM.className = newLang ? `language-${newLang}` : "";
      this.highlightLayer.className = `prism-highlighted${newLang ? ` language-${newLang}` : ""}`;
      this.dom.setAttribute("data-language", newLang || "");
      // 语言变化时需要重新高亮，清除缓存
      this.lastHighlightedCode = "";
    }

    // 内容变化后同步高亮（update 时 node 已更新，直接同步即可）
    this.syncHighlight();
    return true;
  }

  // 忽略 ProseMirror 对 DOM 突变的检测——我们通过 update() 同步
  ignoreMutation(mutation: ViewMutationRecord): boolean {
    // 如果突变发生在高亮层（我们手动修改的），忽略
    if (this.highlightLayer.contains(mutation.target as globalThis.Node)) {
      return true;
    }
    // contentDOM 内的突变由 ProseMirror 正常处理
    return false;
  }

  destroy() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.observer?.disconnect();
    this.observer = null;
  }
}
