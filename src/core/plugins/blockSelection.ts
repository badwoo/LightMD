/**
 * v0.12.0 需求6：通用块级选中能力（阅读模式单击选中整块 → Delete 删除 / 右键「删除 XX」）
 *
 * 根因：5 个自定义 NodeView（CodeBlockView / MermaidBlockView / MathBlockView /
 * TableView 等）都没有 selectNode/stopEvent —— 它们的预览层盖住了 contentDOM，
 * 点击后 PM 找不到可放光标的位置、也建不出 NodeSelection，导致按 Delete 无事发生。
 *
 * 方案（统一混入，不为每种块单独写逻辑）：
 * 1. selectNode/deselectNode → 增删 .pm-block-selected（描边用 outline，
 *    不用 border —— border 会改变表格布局、触发列宽重算，与 TableView 冲突）；
 * 2. stopEvent 只拦「左键单击（mousedown + button===0 + detail===1）」→ 建 NodeSelection；
 *    双击 / 右键 / 其它一律放行（双击仍可进源码编辑态）；
 * 3. 块内交互控件（语言下拉 / 表格工具栏按钮等）放行，不抢既有交互；
 * 4. 已选中本块时的再次单击放行 —— 第二次点击进入编辑/交互，
 *    避免"单击选中后永远无法放光标编辑"的体验坑。
 *
 * 删除：PM baseKeymap 已含 Backspace/Delete → deleteSelection，对 NodeSelection
 * 整节点删除 —— 建得出 NodeSelection 就自然可删，无需改 keymap。
 */
import { NodeSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

/** 选中态 class（CSS 描边，见 editor.css） */
export const BLOCK_SELECTED_CLASS = "pm-block-selected";

/** 块内交互控件选择器：这些元素上的 mousedown 一律放行 */
const INTERACTIVE_SELECTOR = "button, select, input, textarea, a, .table-toolbar";

export interface BlockClickContext {
  /** 是否为左键单击（mousedown + button===0 + detail===1） */
  isPlainLeftClick: boolean;
  /** 点击目标是否位于块内交互控件 */
  onInteractive: boolean;
  /** 当前选区是否已经是该块的 NodeSelection */
  alreadySelected: boolean;
}

/**
 * 纯函数：本次 mousedown 是否应拦下并建立块级选中。
 * 三个条件同时满足才拦：左键单击 + 非交互控件 + 尚未选中本块。
 */
export function shouldSelectBlockOnMouseDown(ctx: BlockClickContext): boolean {
  return ctx.isPlainLeftClick && !ctx.onInteractive && !ctx.alreadySelected;
}

/**
 * 块级 NodeView 的 stopEvent 公共实现（各 NodeView 在其 stopEvent 中调用）。
 *
 * @param dom  NodeView 根元素（选中态 class 的目标）
 * @param view ProseMirror EditorView
 * @param getPos NodeView 的当前位置 getter
 * @param event 原始事件
 * @returns true = 已拦下（PM 不再处理）
 */
export function handleBlockStopEvent(
  dom: HTMLElement,
  view: EditorView,
  getPos: () => number | undefined,
  event: Event,
): boolean {
  const e = event as MouseEvent;
  const isPlainLeftClick = e.type === "mousedown" && e.button === 0 && e.detail === 1;
  if (!isPlainLeftClick) return false;
  const target = e.target as HTMLElement | null;
  const onInteractive = !!target?.closest?.(INTERACTIVE_SELECTOR);
  const pos = getPos();
  if (pos == null) return false;
  const { state } = view;
  const alreadySelected =
    state.selection instanceof NodeSelection && state.selection.from === pos;
  if (!shouldSelectBlockOnMouseDown({ isPlainLeftClick, onInteractive, alreadySelected })) {
    return false;
  }
  const node = state.doc.nodeAt(pos);
  if (!node) return false;
  view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, pos)));
  e.preventDefault();
  return true;
}

/** selectNode 公共实现：加描边 class */
export function applyBlockSelected(dom: HTMLElement): void {
  dom.classList.add(BLOCK_SELECTED_CLASS);
}

/** deselectNode 公共实现：移除描边 class */
export function clearBlockSelected(dom: HTMLElement): void {
  dom.classList.remove(BLOCK_SELECTED_CLASS);
}