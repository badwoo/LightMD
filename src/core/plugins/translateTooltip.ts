/**
 * translateTooltip 插件 —— 选区「译」浮动按钮（v0.6.0）
 *
 * 行为：
 * - mouseup（含拖拽选择结束）后选区非空且可翻译 → 选区末尾渲染「译」按钮 widget
 * - 点击按钮触发翻译回调（mousedown preventDefault 保持选区不失焦）
 * - 选区清除/文档变化时按钮自动隐藏
 * - code_block/math_block/mermaid 纯代码选区不显示（复用 translateBridge 判定）
 *
 * 实现说明：
 * - mouseup 时 PM 可能尚未同步选区 → setTimeout(0) 延迟刷新插件状态
 * - 拖放中（view.dragging）不显示，避免干扰 drag&drop
 * - view.dom → view 用 WeakMap 映射（多编辑器实例安全，无模块级单例污染）
 * - widget 点击时经 DOM 向上定位所属 view，再回调入口层
 */
import { Plugin, PluginKey } from "prosemirror-state";
import type { EditorState } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { EditorView } from "prosemirror-view";
import { extractSelectionText } from "../../services/translateBridge";

export const translateTooltipKey = new PluginKey<boolean>("translateTooltip");

/** view.dom → view 映射（WeakMap，随 view 回收自动释放） */
const viewByDom = new WeakMap<HTMLElement, EditorView>();

/** 是否应显示「译」按钮：选区非空且可提取翻译文本 */
export function shouldShowTrigger(state: EditorState): boolean {
  return extractSelectionText(state) !== null;
}

/** 从 widget DOM 向上查找所属 EditorView（跨 .ProseMirror 根节点） */
export function findViewFromDOM(el: Element): EditorView | null {
  const root = el.closest(".ProseMirror") as HTMLElement | null;
  return root ? viewByDom.get(root) ?? null : null;
}

/**
 * 创建翻译气泡图标按钮 DOM（v0.6.0 优化：SVG 气泡图标替代纯文字「译」）
 * mousedown 阻止失焦，click 回调携带按钮自身用于定位 view
 */
export function createTriggerButton(
  onClick: (btn: HTMLSpanElement) => void
): HTMLSpanElement {
  const btn = document.createElement("span");
  btn.className = "translate-trigger";
  btn.title = "AI 翻译 (F6)";
  // SVG 气泡 +「译」字：内联 SVG（跟随 CSS 变量着色，无需外部资源）
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
    '<path class="translate-trigger-bubble" d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9l-4.2 3.5c-.5.4-1.3.1-1.3-.6V17H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/>' +
    '<text class="translate-trigger-glyph" x="12" y="13.5" text-anchor="middle" font-size="10" font-weight="600">译</text>' +
    "</svg>";
  btn.addEventListener("mousedown", (e) => {
    // 阻止编辑器失焦与选区丢失
    e.preventDefault();
    e.stopPropagation();
  });
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick(btn);
  });
  return btn;
}

/** 构建按钮 widget decoration（置于选区末尾，点击经 findViewFromDOM 定位 view） */
export function buildTriggerDecorations(
  state: EditorState,
  onTrigger: (view: EditorView) => void
): DecorationSet {
  const widget = Decoration.widget(
    state.selection.to,
    () =>
      createTriggerButton((btn) => {
        const view = findViewFromDOM(btn);
        if (view) onTrigger(view);
      }),
    { key: "translate-trigger", side: 1 }
  );
  return DecorationSet.create(state.doc, [widget]);
}

/**
 * 创建翻译浮动按钮插件。
 * - onTrigger 收到所属 view，由入口层提取文本并打开气泡
 * - enabled：总开关 getter（动态读取设置 store，关闭时不显示按钮）
 */
export function createTranslateTooltipPlugin(
  onTrigger: (view: EditorView) => void,
  enabled: () => boolean = () => true
): Plugin<boolean> {
  return new Plugin<boolean>({
    key: translateTooltipKey,
    state: {
      init: () => false,
      apply(tr, prev, _oldState, newState) {
        const meta = tr.getMeta(translateTooltipKey);
        if (meta !== undefined) return meta as boolean;
        // 选区/文档变化时重算可见性（打字时选区为空，extractSelectionText 快速返回）
        if (tr.selectionSet || tr.docChanged) {
          return shouldShowTrigger(newState) && enabled();
        }
        return prev;
      },
    },
    props: {
      decorations(state) {
        if (!translateTooltipKey.getState(state) || !enabled()) return DecorationSet.empty;
        return buildTriggerDecorations(state, onTrigger);
      },
      handleDOMEvents: {
        mouseup: (view, event) => {
          // 拖放中不处理（避免与 drag&drop 冲突）
          if ((view as EditorView & { dragging?: unknown }).dragging) return false;
          const mouseEvent = event as MouseEvent;
          // 仅响应主键（左键）mouseup
          if (mouseEvent.button !== 0) return false;
          // 延迟到 PM 同步选区后刷新按钮状态
          setTimeout(() => {
            if (view.isDestroyed) return;
            const visible = shouldShowTrigger(view.state) && enabled();
            if (visible !== translateTooltipKey.getState(view.state)) {
              view.dispatch(view.state.tr.setMeta(translateTooltipKey, visible));
            }
          }, 0);
          return false;
        },
      },
    },
    view(editorView) {
      viewByDom.set(editorView.dom, editorView);
      return {
        destroy() {
          viewByDom.delete(editorView.dom);
        },
      };
    },
  });
}
