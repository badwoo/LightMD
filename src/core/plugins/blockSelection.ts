/**
 * v0.12.0 需求6：通用块级选中能力
 * v0.13.0 需求1：单击语义改为「能放光标的块直接进编辑」。
 *
 * 根因：5 个自定义 NodeView（CodeBlockView / MermaidBlockView / MathBlockView /
 * TableView 等）都没有 selectNode/stopEvent —— 它们的预览层盖住了 contentDOM，
 * 点击后 PM 找不到可放光标的位置、也建不出 NodeSelection，导致按 Delete 无事发生。
 *
 * v0.13.0 需求1 的改动：v0.12.0 的做法是「首次单击即建 NodeSelection 并
 * preventDefault()」，把块"占住"——用户必须**再点一次**才能编辑块内内容，
 * 而代码块 / 公式块 / 表格单元格本来就是可以直接放光标编辑的，这一步纯属多余。
 * 现在：
 * - **可放置光标的块**（content 为 inline/text*）→ 不拦 mousedown，交回 PM
 *   默认放置光标，一次点击即可编辑；
 * - **不可放置光标的叶子块**（`horizontal_rule` / `toc` / Mermaid 预览态）
 *   → 仍建 NodeSelection（没有可放光标的位置，保持可删除/可拖拽）。
 *
 * 显式选中途径（不再依赖双击的副作用）：三点菜单「选中该块」、`Esc`
 * （PM 自带 `selectParentNode`）。
 *
 * 方案（统一混入，不为每种块单独写逻辑）：
 * 1. selectNode/deselectNode → 增删 .pm-block-selected（描边用 outline，
 *    不用 border —— border 会改变表格布局、触发列宽重算，与 TableView 冲突）；
 * 2. stopEvent 只拦「左键单击（mousedown + button===0 + detail===1）」；
 *    双击 / 右键 / 其它一律放行（双击仍可进源码编辑态）；
 * 3. 块内交互控件（语言下拉 / 表格工具栏按钮等）放行，不抢既有交互；
 * 4. v0.13.0 需求1：`blockAcceptsCaret` 为真的块放行（见上）。
 *
 * 删除：PM baseKeymap 已含 Backspace/Delete → deleteSelection，对 NodeSelection
 * 整节点删除 —— 建得出 NodeSelection 就自然可删，无需改 keymap。
 */
import { NodeSelection } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
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
  /** v0.13.0 需求1：目标块是否能容纳文本光标（可编辑） */
  acceptsCaret: boolean;
}

/**
 * 纯函数：本次 mousedown 是否应拦下并建立块级选中。
 *
 * 四个条件同时满足才拦：左键单击 + 非交互控件 + 尚未选中本块 +
 * **该块不能容纳光标**（v0.13.0 需求1）。
 */
export function shouldSelectBlockOnMouseDown(ctx: BlockClickContext): boolean {
  return (
    ctx.isPlainLeftClick &&
    !ctx.onInteractive &&
    !ctx.alreadySelected &&
    // v0.13.0 需求1：能放光标的块不拦——单击即进入编辑
    !ctx.acceptsCaret
  );
}

/**
 * v0.13.0 需求1：该节点是否能容纳文本光标。
 *
 * 判据（与「PM 能不能在此放置 TextSelection」一致）：
 * - `isAtom` / 无 content 的叶子节点（`horizontal_rule`、`toc`）→ false；
 * - `content` 声明为 `text*` / `inline*` 且非 atom → true
 *   （`code_block` / `mermaid_block` / `math_block` / `table_cell` 内的文本）。
 *
 * 纯函数，便于单测真值表。
 */
export function blockAcceptsCaret(node: PMNode | null | undefined): boolean {
  if (!node) return false;
  if (node.isAtom) return false;
  if (node.isText) return false;
  // 有 inline 内容说明可以放光标；`text*`（代码类块）同样可放
  const content = node.type.spec.content ?? "";
  if (content === "") return false;
  return content.includes("inline") || content.includes("text");
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
  const node = state.doc.nodeAt(pos);
  // v0.13.0 需求1：可放光标的块不拦，单击直接进编辑
  const acceptsCaret = blockAcceptsCaret(node);
  if (
    !shouldSelectBlockOnMouseDown({
      isPlainLeftClick,
      onInteractive,
      alreadySelected,
      acceptsCaret,
    })
  ) {
    return false;
  }
  if (!node) return false;
  // v0.12.1 需求6：块级选中后必须**把焦点交还编辑器**。
  // 下面的 preventDefault() 阻止了浏览器「点击 contenteditable 自动聚焦」的默认行为，
  // 不显式 focus 的话 activeElement 会停在 BODY：随后的所有按键（→ 退出代码块、
  // Delete 删除整块、Esc 取消选中）根本到不了编辑器 —— 真机实测（WebView2 + CDP）
  // 点击代码块后 activeElement=BODY，连按 → 毫无反应，用户看到的就是
  // "点了代码块之后方向键乱跳/走不出去"。
  view.focus();
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