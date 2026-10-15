/**
 * v0.13.0 需求1：块右上角三点菜单按钮（`⋮`）的共享工厂。
 *
 * ## 为什么抽工厂
 *
 * 4 个 NodeView（code_block / math_block / mermaid_block / table）都要加同一个
 * 按钮，逻辑（`contentEditable=false` + `stopPropagation` + 事件派发）完全一致。
 * 抽成工厂避免四份重复实现漂移。
 *
 * ## 交互约定
 *
 * - 按钮**常驻显示由 CSS 控制**（hover / 光标在块内 / NodeSelection 三态），
 *   JS 只负责创建与派发事件，不自行改 display；
 * - 点击时 `stopPropagation`：不让 mousedown/click 冒泡到编辑器
 *   （否则会把块选中态/光标位置改掉，与语言下拉同款处理）；
 * - 派发自定义事件 `lightmd:blockAction`（detail: `{ action, pos }`），
 *   由 EditorContainer 统一监听并执行——NodeView 不直接依赖业务层。
 */

/** 三点按钮派发的事件名（detail: { action, pos }） */
export const BLOCK_ACTION_EVENT = "lightmd:blockAction";

/** 块操作 id（与 utils/blockActionMenu.ts 的 BlockActionId 对齐） */
export type BlockActionKind =
  | "cut"
  | "copy"
  | "paste"
  | "delete"
  | "formatPainter"
  | "select"
  | "moveUp"
  | "moveDown";

export interface BlockActionDetail {
  action: BlockActionKind;
  /** 块在文档中的位置（NodeView 的 getPos()） */
  pos: number;
  /**
   * v0.13.0 返修（问题4）：按钮的视口矩形，供菜单锚点定位。
   *
   * 缺陷背景：此前事件从 NodeView 的 `dom`（容器）派发，`e.target` 是容器而非
   * 按钮本身 → 监听方 `closest(".block-kebab")` 取到 null → 锚点退化成 (0,4)
   * → **菜单弹在窗口左上角**。现在改为从按钮自身派发并直接带上矩形，
   * 定位不再依赖 `e.target` 的形态。
   */
  anchor?: { left: number; right: number; top: number; bottom: number };
}

/**
 * 在给定容器里创建三点按钮并挂载。
 *
 * @param container NodeView 的 `dom`
 * @param getPos NodeView 的位置 getter
 * @returns 创建的按钮元素（便于测试/destroy）
 */
export function createBlockKebabButton(
  container: HTMLElement,
  getPos: () => number | undefined,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "block-kebab";
  // contentEditable=false：不让按钮进入 PM 的可编辑内容流。
  // 必须用 setAttribute（而非 `btn.contentEditable = "false"`）——后者在
  // WebView2/jsdom 里不会反映为 DOM attribute，无法被 CSS/测试读取。
  btn.setAttribute("contenteditable", "false");
  // 无文本：图标走 CSS ::before（三个竖点），避免 i18n 侵入 DOM 结构
  btn.setAttribute("aria-label", "⋮");
  btn.dataset.testid = "block-kebab";
  // 与语言下拉同款：事件不冒泡到编辑器，避免改选区/光标
  btn.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    e.preventDefault();
  });
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    const pos = getPos();
    if (pos == null) return;
    // v0.13.0 返修（问题4）：**从按钮自身派发**（而不是从 container），
    // 这样 e.target 就是按钮，配合 detail.anchor 让菜单精确锚定在按钮下方。
    const r = btn.getBoundingClientRect();
    // 由 EditorContainer 统一监听并弹出菜单（它持有 MiniContextMenu 状态），
    // NodeView 不直接依赖业务层。
    btn.dispatchEvent(
      new CustomEvent<BlockActionDetail>(BLOCK_ACTION_EVENT, {
        detail: {
          action: "select",
          pos,
          anchor: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
        },
        bubbles: true,
      }),
    );
  });
  container.appendChild(btn);
  return btn;
}

/** 便捷判断：NodeView 是否需要三点按钮（所有参与块选中的块都要） */
export function shouldHaveKebab(nodeView: { getPos?: unknown }): boolean {
  return typeof nodeView.getPos === "function";
}
