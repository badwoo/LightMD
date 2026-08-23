/**
 * CodeBlockView —— 代码块 NodeView（双层结构 + 行号层）
 *
 * 设计：
 * - 高亮层（highlightLayer）：只读展示，显示 PrismJS 高亮后的 HTML
 * - 行号层（lineNumbersLayer）：G9 新增，显示行号 1, 2, 3, ...
 * - 编辑层（contentDOM）：ProseMirror 管理，透明叠加在高层之上
 *
 * 用户看到的是高亮语法，实际编辑的是底层纯文本。
 * 不再直接修改 contentDOM.innerHTML，避免破坏 ProseMirror DOM 追踪。
 *
 * 性能优化：
 * - MutationObserver 防抖，避免 ProseMirror 批量 DOM 修改时频繁触发高亮
 * - 缓存上次高亮的 code 文本，内容未变时跳过高亮计算（行号也不会变）
 * - 行号在 syncHighlight 中一并生成，避免额外 reflow
 */
import type { NodeView, EditorView, ViewMutationRecord } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { highlightCode } from "../../utils/highlight";
import { detectLanguage } from "../../utils/detect-language";
import { useSettingsStore } from "../../stores/useSettingsStore";

/** 行号层固定宽度（em） */
const LINE_NUMBERS_WIDTH_EM = 3;
/** 行号层右内边距（em），与代码层留出间距 */
const LINE_NUMBERS_RIGHT_PADDING_EM = 0.5;
/** 行号层与代码层 padding-left 合计偏移（em） */
const CODE_PADDING_LEFT_WITH_NUMBERS = `calc(1em + ${LINE_NUMBERS_WIDTH_EM + LINE_NUMBERS_RIGHT_PADDING_EM}em)`;

export class CodeBlockView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private highlightLayer: HTMLElement;
  /** G9：行号层，显示 1,2,3,... 行号 */
  private lineNumbersLayer: HTMLElement;
  private node: PMNode;
  private observer: MutationObserver | null = null;
  // 防抖定时器
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  // 缓存上次高亮的文本，避免重复计算
  private lastHighlightedCode = "";
  /** G9：当前是否显示行号（从 settings store 同步） */
  private showLineNumbers: boolean;
  /** G9：settings store 订阅取消函数 */
  private unsubscribeStore: (() => void) | null = null;

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

    // G9：行号层，绝对定位在左侧，pointer-events:none 不影响编辑
    // user-select:none 确保复制代码时不包含行号
    this.lineNumbersLayer = document.createElement("div");
    this.lineNumbersLayer.className = "code-line-numbers";
    this.dom.appendChild(this.lineNumbersLayer);

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

    // G9：读取初始 showCodeLineNumbers 设置
    this.showLineNumbers = useSettingsStore.getState().showCodeLineNumbers;
    this.applyLineNumbersVisibility();

    // 立即同步高亮（node.textContent 在构造时始终可用），同时生成行号
    this.syncHighlight();

    // G9：订阅 settings store，开关切换时实时响应（不依赖文档变化触发 update）
    this.unsubscribeStore = useSettingsStore.subscribe((state, prevState) => {
      if (state.showCodeLineNumbers !== prevState.showCodeLineNumbers) {
        this.showLineNumbers = state.showCodeLineNumbers;
        this.applyLineNumbersVisibility();
      }
    });

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

  /** 将编辑层文本同步到高亮层，并生成行号 */
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

    // 缓存命中：内容未变时跳过高亮计算（行号也不会变）
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
        // N4：无语言标识时静默检测语言并高亮（仅用于本层显示，不写回文档属性）
        const detected = detectLanguage(code);
        this.highlightLayer.className = `prism-highlighted${detected ? ` language-${detected}` : ""}`;
        if (detected) {
          try {
            const highlighted = highlightCode(code, detected);
            if (highlighted.includes('class="token')) {
              this.highlightLayer.innerHTML = highlighted;
            } else {
              // 检测到的语言未产生语法 token，直接显示文本
              this.highlightLayer.textContent = code;
            }
          } catch {
            this.highlightLayer.textContent = code;
          }
        } else {
          // 未识别出语言，直接显示文本（使用 prism-text 颜色）
          this.highlightLayer.textContent = code;
        }
      }
    } else {
      this.highlightLayer.textContent = "";
    }

    // G9：行号生成（复用 syncHighlight 调用，避免额外 reflow）
    this.lineNumbersLayer.textContent = generateLineNumbers(code);
  }

  /** G9：根据 showLineNumbers 切换行号层显示，并调整代码层 padding 以给行号留出空间 */
  private applyLineNumbersVisibility() {
    if (this.showLineNumbers) {
      this.lineNumbersLayer.style.display = "block";
      // 给高亮层和编辑层留出行号宽度空间
      this.highlightLayer.style.paddingLeft = CODE_PADDING_LEFT_WITH_NUMBERS;
      this.contentDOM.style.paddingLeft = CODE_PADDING_LEFT_WITH_NUMBERS;
    } else {
      this.lineNumbersLayer.style.display = "none";
      this.highlightLayer.style.paddingLeft = "1em";
      this.contentDOM.style.paddingLeft = "1em";
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

    // G9：兜底检查 showLineNumbers 是否变化（subscribe 已实时响应，这里仅作保险）
    const currentShowLineNumbers = useSettingsStore.getState().showCodeLineNumbers;
    if (currentShowLineNumbers !== this.showLineNumbers) {
      this.showLineNumbers = currentShowLineNumbers;
      this.applyLineNumbersVisibility();
    }

    // 内容变化后同步高亮（update 时 node 已更新，直接同步即可）
    this.syncHighlight();
    return true;
  }

  // 忽略 ProseMirror 对 DOM 突变的检测——我们通过 update() 同步
  ignoreMutation(mutation: ViewMutationRecord): boolean {
    // 如果突变发生在高亮层或行号层（我们手动修改的），忽略
    if (this.highlightLayer.contains(mutation.target as globalThis.Node)) {
      return true;
    }
    if (this.lineNumbersLayer.contains(mutation.target as globalThis.Node)) {
      return true;
    }
    // contentDOM 内的突变由 ProseMirror 正常处理
    return false;
  }

  destroy() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.observer?.disconnect();
    this.observer = null;
    // G9：取消 settings store 订阅，避免内存泄漏
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
  }
}

/**
 * G9：根据代码文本生成行号字符串，每行一个数字（用 \n 分隔），从 1 开始。
 * - 空代码返回空字符串
 * - 末尾换行不算一行（与可见行数一致）
 * - 单行代码返回 "1"
 *
 * 抽离为独立纯函数便于单元测试。
 */
export function generateLineNumbers(code: string): string {
  if (!code) return "";
  const lines = code.split("\n");
  // 末尾换行不算一行（与可见行数一致）
  const lineCount = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  if (lineCount <= 0) return "";
  // 使用循环拼接，避免大代码块创建中间数组
  let result = "1";
  for (let i = 2; i <= lineCount; i++) {
    result += "\n" + i;
  }
  return result;
}
