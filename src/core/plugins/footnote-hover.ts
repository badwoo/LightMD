/**
 * footnote-hover 插件 —— 脚注引用悬浮预览（G2）
 *
 * 阅读模式下鼠标悬停脚注引用 [^id]，显示对应脚注定义内容的 tooltip。
 *
 * 行为：
 * - 鼠标悬停 100ms 后显示 tooltip（debounce，避免快速划过抖动）
 * - 鼠标移出后 200ms 延迟关闭（避免抖动）
 * - 文档滚动立即关闭（capture 阶段监听，捕获任何容器滚动）
 * - tooltip 内支持鼠标进入（可点击内部链接）
 *
 * 性能优化：
 * - 事件委托：在 view.dom 上监听 mouseover/mouseout，不为每个 ref 单独绑定
 * - findFootnoteDefinition 使用 descendants 提前退出（找到即停止遍历）
 * - 状态在 view() 闭包中管理，每个 EditorView 独立，避免模块级状态污染
 * - 仅在阅读模式渲染 footnote_ref，编辑/分屏模式源码不渲染，自然不触发
 *
 * 实现说明：
 * - 因 ProseMirror 的 handleDOMEvents 与 view() 是 Plugin 的同级属性，
 *   闭包变量无法跨属性共享，故在 view() 钩子内注册 DOM 事件监听器。
 * - destroy 时移除所有监听器与 tooltip，避免内存泄漏。
 */
import { Plugin, PluginKey } from "prosemirror-state";
import { DOMSerializer } from "prosemirror-model";
import type { Node as PMNode, Schema } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";

export const footnoteHoverKey = new PluginKey("footnoteHover");

// 显示延迟（ms）：避免快速划过抖动
const SHOW_DELAY = 100;
// 关闭延迟（ms）：避免抖动
const HIDE_DELAY = 200;
// tooltip 与目标元素的间距（px）
const TOOLTIP_GAP = 8;
// 视口边距（px），用于边界检查
const VIEWPORT_MARGIN = 8;

/**
 * 从 doc 中查找匹配 label 的 footnote_definition 节点
 * 找到后立即停止遍历，返回节点；未找到返回 null
 *
 * 纯函数，可单元测试
 */
export function findFootnoteDefinition(doc: PMNode, label: string): PMNode | null {
  let found: PMNode | null = null;
  doc.descendants((node) => {
    if (
      node.type.name === "footnote_definition" &&
      node.attrs.label === label
    ) {
      found = node;
      return false; // 找到后停止遍历
    }
    return true;
  });
  return found;
}

/**
 * 序列化 footnote_definition 内容为 DocumentFragment
 * 使用 DOMSerializer 渲染，保留格式（粗体、链接、代码等 inline marks）
 */
export function serializeFootnoteToHTML(
  node: PMNode,
  schema: Schema
): DocumentFragment {
  const serializer = DOMSerializer.fromSchema(schema);
  return serializer.serializeFragment(node.content) as DocumentFragment;
}

/**
 * 创建 tooltip DOM 元素并定位到目标上方
 * 调用方需确保 tooltip 已添加到 document.body 才能测量尺寸
 */
function createTooltipElement(
  content: DocumentFragment,
  targetRect: DOMRect
): HTMLDivElement {
  const tooltip = document.createElement("div");
  tooltip.className = "footnote-tooltip";
  tooltip.appendChild(content);

  // 先添加到 body 才能测量实际尺寸
  document.body.appendChild(tooltip);
  const tooltipRect = tooltip.getBoundingClientRect();

  // 水平居中于 target
  let left = targetRect.left + targetRect.width / 2 - tooltipRect.width / 2;
  // 默认定位到 target 上方
  let top = targetRect.top - tooltipRect.height - TOOLTIP_GAP;

  // 水平边界检查
  if (left < VIEWPORT_MARGIN) {
    left = VIEWPORT_MARGIN;
  }
  if (left + tooltipRect.width > window.innerWidth - VIEWPORT_MARGIN) {
    left = window.innerWidth - tooltipRect.width - VIEWPORT_MARGIN;
  }
  // 上方空间不足时，定位到 target 下方
  if (top < VIEWPORT_MARGIN) {
    top = targetRect.bottom + TOOLTIP_GAP;
  }

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
  return tooltip;
}

/**
 * 脚注悬浮预览 plugin
 *
 * 在 view() 钩子内注册 DOM 事件监听器，每个 EditorView 拥有独立状态。
 */
export const footnoteHoverPlugin = new Plugin({
  key: footnoteHoverKey,
  view(initialView: EditorView) {
    const view = initialView;

    // 闭包内状态（每个 EditorView 独立）
    let showTimer: number | null = null;
    let hideTimer: number | null = null;
    let tooltip: HTMLDivElement | null = null;
    let currentRef: HTMLElement | null = null;

    const clearShowTimer = () => {
      if (showTimer !== null) {
        clearTimeout(showTimer);
        showTimer = null;
      }
    };
    const clearHideTimer = () => {
      if (hideTimer !== null) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
    };

    const removeTooltip = () => {
      if (tooltip) {
        tooltip.remove();
        tooltip = null;
      }
      currentRef = null;
    };

    const hideWithDelay = () => {
      clearShowTimer();
      clearHideTimer();
      hideTimer = window.setTimeout(() => {
        hideTimer = null;
        removeTooltip();
      }, HIDE_DELAY);
    };

    // 事件处理：mouseover（事件委托，监听 view.dom 上的所有 mouseover）
    const onMouseOver = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      // 鼠标进入 tooltip 区域：取消关闭
      if (tooltip && target.closest(".footnote-tooltip")) {
        clearHideTimer();
        return;
      }

      // 检测 target 是否在 .footnote-ref 内
      const refEl = target.closest(".footnote-ref") as HTMLElement | null;
      if (!refEl) return;

      const label = refEl.getAttribute("data-label");
      if (!label) return;

      // 同一个 ref：用户回到原 ref，取消关闭
      if (currentRef === refEl) {
        clearHideTimer();
        return;
      }

      // 切换到新 ref：清除所有 timer 和旧 tooltip
      clearShowTimer();
      clearHideTimer();
      removeTooltip();
      currentRef = refEl;

      // 100ms 后显示
      showTimer = window.setTimeout(() => {
        showTimer = null;
        // 二次校验：currentRef 可能已被滚动/destroy 清除
        if (!currentRef) return;

        const { state } = view;
        const defNode = findFootnoteDefinition(state.doc, label);
        if (!defNode) return; // 找不到定义，不显示

        const content = serializeFootnoteToHTML(defNode, state.schema);
        const rect = refEl.getBoundingClientRect();
        tooltip = createTooltipElement(content, rect);

        // tooltip 内鼠标进入：取消关闭；鼠标移出：延迟关闭
        tooltip.addEventListener("mouseenter", clearHideTimer);
        tooltip.addEventListener("mouseleave", hideWithDelay);
      }, SHOW_DELAY);
    };

    // 事件处理：mouseout
    const onMouseOut = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      // 仅处理从 .footnote-ref 或 tooltip 内移出
      const refEl = target.closest(".footnote-ref") as HTMLElement | null;
      const inTooltip = target.closest(".footnote-tooltip");
      if (!refEl && !inTooltip) return;

      const related = event.relatedTarget as HTMLElement | null;
      // 鼠标移动到 tooltip 内：保持显示
      if (related && related.closest(".footnote-tooltip")) {
        clearHideTimer();
        return;
      }
      // 鼠标移动到 ref 内：保持显示
      if (related && related.closest(".footnote-ref")) {
        clearHideTimer();
        return;
      }

      hideWithDelay();
    };

    // 全局滚动监听（capture 阶段）：任何滚动立即关闭 tooltip
    const onScroll = () => {
      clearShowTimer();
      clearHideTimer();
      removeTooltip();
    };

    // 注册事件监听器
    view.dom.addEventListener("mouseover", onMouseOver);
    view.dom.addEventListener("mouseout", onMouseOut);
    window.addEventListener("scroll", onScroll, true);

    return {
      destroy() {
        clearShowTimer();
        clearHideTimer();
        removeTooltip();
        view.dom.removeEventListener("mouseover", onMouseOver);
        view.dom.removeEventListener("mouseout", onMouseOut);
        window.removeEventListener("scroll", onScroll, true);
      },
    };
  },
});
