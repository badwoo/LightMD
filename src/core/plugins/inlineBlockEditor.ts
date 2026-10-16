/**
 * v0.13.1 需求6：公式块 / Mermaid 块「就地编辑层」的公共行为。
 *
 * ## 用户报告
 * 「公式/Mermaid 点击进入编辑模式的窗口太大，要尽量根据内容；点击其他区域要立即恢复
 *  渲染；进入/恢复的过程要平滑、不抖动。」
 *
 * ## 三个缺陷与对策
 * 1. **窗口太大**：旧的编辑层 CSS 是 `padding:1em` + 块级占满整行，一个 20 字符的
 *    公式也会撑出一整行高的大方框。
 *    → 单行型（LaTeX）用 `width:fit-content; max-width:100%`（**收窄到内容宽度**）；
 *      多行型（Mermaid）保持整行宽但**按内容高度**、并给 `max-height` 兜底（超高内部滚动）。
 * 2. **点击其他区域不恢复**：旧实现只在 `dblclick` 上 toggle，没有任何"点别处就退出"的
 *    监听 —— 用户点到正文别的地方，块仍然停在编辑态。
 *    → `watchOutsidePointerDown`：编辑态期间在 **document 捕获阶段**监听
 *      `pointerdown`/`mousedown`，落在块外立即退出。
 * 3. **进入/恢复抖动**：旧实现把编辑层 `display:none ↔ block` 且**不声明任何过渡**，
 *    高度突变 + 预览层一起切换 → 肉眼可见的跳动。
 *    → 编辑层声明 `transition`（padding / background / opacity），并给进入态一个
 *      纯 opacity 的淡入动画（`inlineEditorEnterAnimation`），避免高度动画带来的抖动。
 *
 * 本模块只产出纯字符串与一个副作用订阅函数，方便两个 NodeView 复用同一口径。
 */

/** 编辑层的**隐藏**态：PM 找不到可见的可编辑位置就无法放置光标，故必须 display:none */
export const INLINE_EDITOR_HIDDEN_CSS = "display:none;";

/**
 * 隐藏态与可见态**共用**的尺寸/排版声明。
 *
 * 关键：两态只有 `display` 不同。旧实现隐藏态是 `padding:1em`、可见态另写一套，
 * 于是**进入/退出时光内边距就突变**，叠加高度变化就是肉眼可见的跳动
 * （用户反馈「进入/恢复的过程要平滑、不抖动」）。共用一套后，状态切换只影响
 * 是否参与布局，不再改内边距。
 */
function commonInlineEditorCss(multiline: boolean): string {
  const sizing = multiline
    ? // 多行：整行宽（源码换行才有意义），高度随内容，超过 45vh 内部滚动；
      // 不再用 1em 大内边距撑高
      "width:100%;max-height:45vh;overflow:auto;box-sizing:border-box;"
    : // 单行：**关键**——收窄到内容宽度，短公式不再撑满整行
      "width:fit-content;max-width:100%;min-width:6ch;box-sizing:border-box;";
  return (
    sizing +
    "white-space:pre-wrap;word-wrap:break-word;overflow-wrap:break-word;" +
    "padding:0.4em 0.6em;border-radius:4px;" +
    "font-family:var(--font-mono);font-size:0.9em;line-height:1.5;" +
    "color:var(--text-primary);caret-color:var(--text-primary);"
  );
}

/** 隐藏态 CSS（与可见态同尺寸，仅 display 不同） */
export function inlineEditorHiddenCss(multiline: boolean): string {
  return "display:none;" + commonInlineEditorCss(multiline);
}

/** 进入态共用的过渡：只动 padding/background/opacity，**不动** height/width，避免抖动 */
const COMMON_TRANSITION =
  "transition:padding 0.12s ease,background 0.12s ease,opacity 0.12s ease;";

/**
 * 进入编辑态的**可见** CSS。
 *
 * @param multiline true = Mermaid 这类多行源码（整行宽 + 限高滚动）；
 *                  false = LaTeX 这类短源码（收窄到内容宽度）。
 */
export function inlineEditorVisibleCss(multiline: boolean): string {
  return (
    "display:block !important;" +
    commonInlineEditorCss(multiline) +
    // 先给一个不依赖 color-mix 的等价底色兜底（老内核不认 color-mix 时忽略后者）
    "background:rgba(74,158,255,0.07);" +
    "background:color-mix(in srgb, var(--accent-color, #4a9eff) 7%, transparent);" +
    COMMON_TRANSITION +
    `animation:${INLINE_EDITOR_ENTER_ANIMATION} 0.14s ease-out;`
  );
}

/**
 * 进入态的淡入动画名。
 *
 * 注意：`@keyframes` 与「减少动态效果」的 `@media` **不能**写在 `style.cssText` 里
 * （内联样式不支持 at-rule，写了会被整条丢弃）——它们定义在 `styles/editor.css`，
 * 那里同时提供 `prefers-reduced-motion: reduce` 下的 `animation: none`。
 */
export const INLINE_EDITOR_ENTER_ANIMATION = "inline-editor-enter";

/**
 * 编辑态期间监听「点击块外」→ 立即回调（退出编辑）。
 *
 * - 用 **捕获阶段**：必须在 ProseMirror / 外层容器的处理之前跑，否则点击落点已经被
 *   改掉（例如 PM 把光标移过去、容器把块标记为选中），退出判断会失真。
 * - 同时监听 `pointerdown` 与 `mousedown`：前者在触屏/手写笔上更可靠，后者兜底
 *   （jsdom 与老浏览器可能没有 PointerEvent）。回调是**幂等**的，重复触发无副作用。
 * - 忽略落在 `dom` 内部的按下（含块自身的三点菜单，它是 dom 的子节点）。
 *
 * @returns 取消订阅函数（必须在退出编辑态 / destroy 时调用）
 */
export function watchOutsidePointerDown(
  dom: HTMLElement,
  onOutside: () => void,
): () => void {
  const handler = (e: Event) => {
    const target = e.target as globalThis.Node | null;
    if (target && dom.contains(target)) return;
    onOutside();
  };
  document.addEventListener("pointerdown", handler, true);
  document.addEventListener("mousedown", handler, true);
  return () => {
    document.removeEventListener("pointerdown", handler, true);
    document.removeEventListener("mousedown", handler, true);
  };
}
