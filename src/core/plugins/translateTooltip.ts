/**
 * translateTooltip 插件 —— 选区「译」浮动按钮（v0.6.0）
 *
 * 行为：
 * - mouseup（含拖拽选择结束）后选区非空且可翻译 → 选区末尾渲染「译」按钮 widget
 * - v0.7.0 修复4：可配置延迟出现（translateBubbleDelayMs，默认 500ms）——
 *   每次 mouseup 重置计时器，延迟期间选区已清除则不显示
 * - click 触发翻译回调（mousedown preventDefault 保持选区不失焦）
 * - v0.7.0 修复1：右键按钮触发右键菜单回调（关闭 AI 翻译 / 隐藏翻译小气泡）
 * - 选区清除/文档变化时按钮自动隐藏
 * - code_block/math_block/mermaid 纯代码选区不显示（复用 translateBridge 判定）
 * - v0.7.4 功能7：「译」按钮右侧再排 [续][润][摘] 三个 AI 按钮，成一排浮动
 *   于选区右上角。onAiAction 触发 AI 任务；任一 AI 按钮右键 → onAiContextMenu
 *   （入口层渲染「隐藏...气泡」菜单）；isAiHidden 控制三个 AI 按钮是否隐藏
 *   （仅影响 AI 三个，不影响「译」）；getBubbleColor 为各 AI 按钮取边框/背景色。
 * - v0.7.5 功能2：AI 按钮扩为 [续][润][摘][问] 四个（「问」打开 AI 对话窗）；
 *   隐藏判定由整体布尔 isAiHidden 改为按任务的 isBubbleHidden(task)——
 *   右键只隐藏被点的那一个，其余照常显示（一排宽度按"可见数"计算，定位不偏移）。
 * - v0.7.5 功能3：「译」按钮支持颜色注入（getTranslateColor → --ai-btn-color），
 *   与 AI 按钮共用同一 CSS 变量与刷新循环。
 *
 * 实现说明：
 * - mouseup 时 PM 可能尚未同步选区 → setTimeout(延迟) 后刷新插件状态
 * - 拖放中（view.dragging）不显示，避免干扰 drag&drop
 * - view.dom → view 用 WeakMap 映射（多编辑器实例安全，无模块级单例污染）
 * - widget 点击时经 DOM 向上定位所属 view，再回调入口层
 */
import { Plugin, PluginKey } from "prosemirror-state";
import type { EditorState } from "prosemirror-state";
import { DecorationSet } from "prosemirror-view";
import type { EditorView } from "prosemirror-view";
import { extractSelectionText } from "../../services/translateBridge";

export const translateTooltipKey = new PluginKey<boolean>("translateTooltip");

/** v0.7.4 功能7：AI 辅助任务类型（续写/润色/摘要）
 *  v0.7.5 功能2：新增 "chat"（「问」气泡 → 打开 AI 对话窗） */
export type AiAssistTask = "continue" | "polish" | "summary" | "chat";

/**
 * v0.7.5 功能2：一排 AI 气泡的定义（顺序即渲染顺序，「问」排在「摘」右侧）
 * 导出供入口层/测试复用（右键菜单文案、齿轮面板勾选项均按此顺序）。
 */
export const AI_BUBBLE_DEFS: ReadonlyArray<{ task: AiAssistTask; text: string }> = Object.freeze([
  { task: "continue", text: "续" },
  { task: "polish", text: "润" },
  { task: "summary", text: "摘" },
  { task: "chat", text: "问" },
]);

/** 「译」浮动按钮尺寸（用于视口边界自适应定位） */
const TRIGGER_SIZE = { width: 28, height: 28 };
/** v0.7.4 功能7：一排按钮间的间隙（px） */
const BUTTON_GAP = 2;
/** v0.7.4 功能7：一排按钮（译 + AI 若干）的总宽度，用于定位计算
 *  v0.7.5 功能2：AI 按钮数量按"实际可见数"传入，隐藏任一后定位不偏移 */
export function computeTriggerRowWidth(aiButtonCount = 3, gap = BUTTON_GAP, width = TRIGGER_SIZE.width): number {
  return width * (1 + aiButtonCount) + gap * aiButtonCount;
}

/** view.dom → view 映射（WeakMap，随 view 回收自动释放） */
const viewByDom = new WeakMap<HTMLElement, EditorView>();

/** v0.7.0 修复4：view → 延迟显示计时器映射（每次 mouseup 重置；view 销毁时清理） */
const delayTimers = new WeakMap<EditorView, ReturnType<typeof setTimeout>>();

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
 * v0.7.3 问题3修复：计算浮动「译」按钮定位（纯函数，可测试）。
 * 按钮浮动于选区右上角（右对齐选区末端、位于选区首行上方），
 * 不再作为内联 widget 占位，避免文本抖动。coords 来自 view.coordsAtPos。
 */
export function positionFloatingTrigger(
  el: HTMLElement,
  from: { left: number; top: number; right: number; bottom: number },
  to: { left: number; top: number; right: number; bottom: number },
  viewport: { width: number; height: number },
  size = TRIGGER_SIZE
): { left: number; top: number } {
  const GAP = 4;
  const MARGIN = 8;
  // 选区右缘 = max(right)；选区首行 y = min(top)
  const right = Math.max(from.right, to.right);
  const top = Math.min(from.top, to.top);
  let x = right - size.width - GAP; // 按钮右缘贴合选区右缘
  let y = top - size.height - GAP;  // 按钮位于选区首行上方（右上角）
  if (y < MARGIN) y = top + GAP;    // 顶部越界 → 落到选区首行下方
  if (x < MARGIN) x = MARGIN;
  if (x + size.width > viewport.width - MARGIN) x = viewport.width - size.width - MARGIN;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  return { left: x, top: y };
}

/**
 * 创建翻译气泡图标按钮 DOM（v0.6.0 优化：SVG 气泡图标替代纯文字「译」）
 * mousedown 阻止失焦，click 回调携带按钮自身用于定位 view
 * v0.7.0 修复1：contextmenu 回调（入口层渲染快捷菜单）
 */
export function createTriggerButton(
  onClick: (btn: HTMLSpanElement) => void,
  onContextMenu?: (btn: HTMLSpanElement, e: MouseEvent) => void,
  title = "AI 翻译 (F6)"
): HTMLSpanElement {
  const btn = document.createElement("span");
  btn.className = "translate-trigger";
  // v0.7.3 改进8(D5)：title 由入口层注入（i18n），不再硬编码中文
  btn.title = title;
  // SVG 气泡 +「译」字：内联 SVG（跟随 CSS 变量着色，无需外部资源）
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
    '<path class="translate-trigger-bubble" d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9l-4.2 3.5c-.5.4-1.3.1-1.3-.6V17H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/>' +
    '<text class="translate-trigger-glyph" x="12" y="13.5" text-anchor="middle" font-size="10" font-weight="600">译</text>' +
    "</svg>";
  btn.addEventListener("mousedown", (e) => {
    // 阻止编辑器失焦与选区丢失（右键同样保持选区）
    e.preventDefault();
    e.stopPropagation();
  });
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick(btn);
  });
  // v0.7.0 修复1：右键 → 快捷菜单（关闭 AI 翻译 / 隐藏翻译小气泡）
  if (onContextMenu) {
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onContextMenu(btn, e);
    });
  }
  return btn;
}

/**
 * v0.7.4 功能7：创建「续/润/摘」AI 气泡按钮 DOM（纯文字小按钮，无 SVG 图标）。
 * 与「译」按钮同尺寸、同 mousedown 保持选区策略。
 * - color：若为有效颜色则写为 CSS 变量 --ai-btn-color（驱动边框/背景），
 *   空串/无效时回退主题 accent 默认色。
 * - onContextMenu：右键触发（入口层渲染「隐藏AI小气泡」菜单）。
 */
export function createAiAssistButton(
  task: AiAssistTask,
  text: string,
  title: string,
  onClick: (btn: HTMLSpanElement, task: AiAssistTask) => void,
  color: string,
  onContextMenu?: (btn: HTMLSpanElement, e: MouseEvent) => void
): HTMLSpanElement {
  const btn = document.createElement("span");
  btn.className = "translate-ai-trigger";
  btn.dataset.task = task;
  btn.textContent = text;
  btn.title = title;
  if (color && color.trim()) {
    btn.style.setProperty("--ai-btn-color", color.trim());
  }
  btn.addEventListener("mousedown", (e) => {
    // 与「译」按钮一致：阻止编辑器失焦与选区丢失（右键同样保持选区）
    e.preventDefault();
    e.stopPropagation();
  });
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick(btn, task);
  });
  if (onContextMenu) {
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onContextMenu(btn, e);
    });
  }
  return btn;
}

/**
 * 创建翻译浮动按钮插件（v0.7.3：真浮动模式）。
 *
 * v0.7.3 问题3修复之前的实现：把「译」按钮作为 `Decoration.widget` 内联插入
 * 选区末尾——widget 是行内元素，会占用文本横向空间，导致选中文本时整行
 * 布局抖动/撑宽。现改为：decorations 恒返回空（不再占用文档空间），由
 * view() 持有一个 position:fixed 的浮动元素，在 update() 时用
 * view.coordsAtPos 定位到选区右上角。既消除抖动，又保持位置贴近选区。
 *
 * - onTrigger 收到所属 view，由入口层提取文本并打开气泡
 * - enabled：总开关 getter（动态读取设置 store，关闭时不显示按钮）
 * - getDelay：延迟出现毫秒数 getter（v0.7.0 修复4）
 * - onContextMenu：右键菜单回调（v0.7.0 修复1）
 */
export function createTranslateTooltipPlugin(
  onTrigger: (view: EditorView) => void,
  enabled: () => boolean = () => true,
  options: {
    getDelay?: () => number;
    onContextMenu?: (btn: HTMLSpanElement, e: MouseEvent) => void;
    // v0.7.3 改进8(D5)：按钮 title（i18n 注入）
    title?: string;
    // v0.7.4 功能7：AI 气泡相关回调与 getter
    onAiAction?: (task: AiAssistTask) => void;
    onAiContextMenu?: (btn: HTMLSpanElement, e: MouseEvent) => void;
    /**
     * v0.7.5 功能2：按任务判定气泡是否隐藏（取代 v0.7.4 的整体布尔 isAiHidden）。
     * 入口层实现为 `!aiAssistBubbleEnable || hiddenTasks.includes(task)`
     * （总开关关闭 → 全部隐藏；否则按各自任务独立隐藏）。
     */
    isBubbleHidden?: (task: AiAssistTask) => boolean;
    /** 各 AI 按钮颜色 getter（返回空串 = 用主题默认色） */
    getBubbleColor?: (task: AiAssistTask) => string | undefined;
    /** v0.7.5 功能3：「译」按钮颜色 getter（返回空串 = 用主题默认色） */
    getTranslateColor?: () => string | undefined;
    /** 各 AI 按钮 title getter（i18n 注入，如「AI 续写」） */
    getAiTitle?: (task: AiAssistTask) => string;
    /** v0.7.4 修复2：AI 三个气泡出现延迟毫秒数 getter（从 mouseup 起算，独立于「译」） */
    getAiDelay?: () => number;
  } = {}
): Plugin<boolean> {
  const { getDelay, onContextMenu, title, onAiAction, onAiContextMenu, isBubbleHidden, getBubbleColor, getAiTitle, getAiDelay, getTranslateColor } = options;
  // v0.7.4 修复2：AI 气泡延迟基准时间戳（mouseup 时刷新）。
  // 声明在插件实例级，使 props.mouseup 与 view() 的 updateFloating 共享同一基准。
  let aiDelayBaseAt = 0;
  return new Plugin<boolean>({
    key: translateTooltipKey,
    state: {
      init: () => false,
      apply(tr, prev, _oldState, newState) {
        const meta = tr.getMeta(translateTooltipKey);
        if (meta !== undefined) return meta as boolean;
        // 选区/文档变化时重算可见性（打字时选区为空，extractSelectionText 快速返回）
        if (tr.selectionSet || tr.docChanged) {
          // v0.7.1 修复：延迟失效根因——鼠标拖选期间 PM 的 selectionchange
          // 事务（selectionSet）会立即走到本分支，若此处直接返回 true，
          // 按钮在 mouseup 前就已渲染，mouseup 延迟定时器到点时状态已可见，
          // 延迟设置形同虚设。改为：可显示时保持 prev（显示仅由 mouseup
          // 延迟 dispatch 驱动）；不可显示时立即隐藏（保持"选区清除/
          // 开关关闭按钮即刻消失"语义）
          return shouldShowTrigger(newState) && enabled() ? prev : false;
        }
        return prev;
      },
    },
    props: {
      // v0.7.3：恒为空 decoration——「译」按钮改由 view() 浮动渲染，不占文本空间
      decorations() {
        return DecorationSet.empty;
      },
      handleDOMEvents: {
        mouseup: (view, event) => {
          // 拖放中不处理（避免与 drag&drop 冲突）
          if ((view as EditorView & { dragging?: unknown }).dragging) return false;
          const mouseEvent = event as MouseEvent;
          // 仅响应主键（左键）mouseup
          if (mouseEvent.button !== 0) return false;
          // v0.7.4 修复2：记录本次触发时间，作为 AI 气泡独立延迟的基准（见 updateFloating）
          aiDelayBaseAt = performance.now();
          // v0.7.0 修复4：延迟显示——每次 mouseup 重置计时器（连续操作不叠多个定时器）；
          // 延迟到 PM 同步选区后刷新按钮状态
          const prev = delayTimers.get(view);
          if (prev) clearTimeout(prev);
          const delay = Math.max(0, getDelay?.() ?? 0);
          delayTimers.set(
            view,
            setTimeout(() => {
              delayTimers.delete(view);
              if (view.isDestroyed) return;
              const visible = shouldShowTrigger(view.state) && enabled();
              if (visible !== translateTooltipKey.getState(view.state)) {
                view.dispatch(view.state.tr.setMeta(translateTooltipKey, visible));
              }
            }, delay)
          );
          return false;
        },
      },
    },
    view(editorView) {
      viewByDom.set(editorView.dom, editorView);
      // 浮动元素：position:fixed 挂到 document.body（不受编辑器祖先 transform/裁剪影响）
      const floatEl = document.createElement("span");
      floatEl.className = "translate-trigger-float";
      floatEl.style.position = "fixed";
      floatEl.style.zIndex = "900"; // 高于编辑器内容、低于翻译气泡(1000)
      floatEl.style.display = "none";
      // 点击直接回调当前 view（浮动元素不在 .ProseMirror 内，findViewFromDOM 无法定位）
      const btn = createTriggerButton(
        () => onTrigger(editorView),
        onContextMenu ? (b, e) => onContextMenu(b, e) : undefined,
        title
      );
      floatEl.appendChild(btn);

      // v0.7.4 功能7：创建 AI 按钮（续/润/摘）成一排，位于「译」右侧。
      // v0.7.5 功能2：扩为四个（+「问」），定义见 AI_BUBBLE_DEFS。
      // 样式由 .translate-ai-trigger 提供；颜色 getBubbleColor 注入 CSS 变量。
      const aiBtns = AI_BUBBLE_DEFS.map(({ task, text }) =>
        createAiAssistButton(
          task,
          text,
          getAiTitle ? getAiTitle(task) : "",
          (_b, t) => onAiAction?.(t),
          getBubbleColor ? getBubbleColor(task) ?? "" : "",
          onAiContextMenu ? (b, e) => onAiContextMenu(b, e) : undefined
        )
      );
      aiBtns.forEach((b) => floatEl.appendChild(b));
      document.body.appendChild(floatEl);

      // v0.7.4 修复2：AI 按钮延迟显示的定时器（到点或 floatEl 隐藏时清理）
      let aiRevealTimer: ReturnType<typeof setTimeout> | null = null;
      const clearAiRevealTimer = () => {
        if (aiRevealTimer !== null) {
          clearTimeout(aiRevealTimer);
          aiRevealTimer = null;
        }
      };

      const updateFloating = () => {
        if (editorView.isDestroyed) return;
        const visible = Boolean(translateTooltipKey.getState(editorView.state)) && enabled();
        if (!visible) {
          floatEl.style.display = "none";
          clearAiRevealTimer();
          return;
        }
        // v0.7.4 修复2 / v0.7.5 功能3：每次刷新重读颜色设置并写回 CSS 变量，
        // 使设置面板改色即时生效（「译」按钮与 AI 按钮合并为同一循环）。
        const tc = (getTranslateColor ? getTranslateColor() : undefined) ?? "";
        if (tc.trim()) btn.style.setProperty("--ai-btn-color", tc.trim());
        else btn.style.removeProperty("--ai-btn-color");
        aiBtns.forEach((b, i) => {
          const c = (getBubbleColor ? getBubbleColor(AI_BUBBLE_DEFS[i].task) : undefined) ?? "";
          if (c.trim()) b.style.setProperty("--ai-btn-color", c.trim());
          else b.style.removeProperty("--ai-btn-color");
        });
        // v0.7.4 功能7 / 修复2 / v0.7.5 功能2：逐按钮刷新可见性（设置驱动，不依赖 PM 事务）。
        // 隐藏只影响被判定的那一个（总开关关闭时逐按钮判定同样全部为隐藏）；
        // 延迟以 mouseup 时间戳为基准独立生效（不随刷新累加）。
        clearAiRevealTimer();
        const hiddenFlags = AI_BUBBLE_DEFS.map((d) => (isBubbleHidden ? isBubbleHidden(d.task) : false));
        // 一排宽度按"设置上可见"的按钮数计算（与延迟揭示无关，避免揭示时宽度跳动）
        const visibleAiCount = hiddenFlags.filter((h) => !h).length;
        const aiDelay = Math.max(0, getAiDelay?.() ?? 0);
        const elapsed = performance.now() - aiDelayBaseAt;
        const revealed = elapsed >= aiDelay;
        let needReveal = false;
        aiBtns.forEach((b, i) => {
          if (hiddenFlags[i]) {
            b.style.display = "none";
          } else if (revealed) {
            b.style.display = "";
          } else {
            // 未到点：先隐藏，到点后再刷新一次
            b.style.display = "none";
            needReveal = true;
          }
        });
        if (needReveal) {
          aiRevealTimer = setTimeout(() => {
            aiRevealTimer = null;
            updateFloating();
          }, Math.max(0, aiDelay - elapsed));
        }
        // 坐标计算可能因要素缺失/环境无布局（如 jsdom）失败——失败时不强制定位，
        // 仍显示按钮（真实生产环境 coordsAtPos 正常，此处仅为健壮性兜底）
        try {
          const from = editorView.coordsAtPos(editorView.state.selection.from);
          const to = editorView.coordsAtPos(editorView.state.selection.to);
          if (
            from &&
            to &&
            typeof from.right === "number" &&
            typeof to.right === "number"
          ) {
            // v0.7.4 功能7 / v0.7.5 功能2：一排按钮的总宽度参与定位
            // （只计可见 AI 按钮，右缘贴选区、不抖动）
            positionFloatingTrigger(floatEl, from, to, {
              width: window.innerWidth,
              height: window.innerHeight,
            }, {
              width: computeTriggerRowWidth(visibleAiCount),
              height: TRIGGER_SIZE.height,
            });
          }
        } catch {
          // 忽略坐标定位失败，按钮照常显示在预设位置
        }
        floatEl.style.display = "";
      };
      updateFloating();

      return {
        update(view) {
          if (view !== editorView) return;
          updateFloating();
        },
        destroy() {
          viewByDom.delete(editorView.dom);
          floatEl.remove();
          clearAiRevealTimer();
          const t = delayTimers.get(editorView);
          if (t) {
            clearTimeout(t);
            delayTimers.delete(editorView);
          }
        },
      };
    },
  });
}
