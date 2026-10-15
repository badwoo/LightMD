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
import { NodeSelection, TextSelection } from "prosemirror-state";
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
 * - `isAtom` 且无内容（`horizontal_rule`、`toc`、行内 `image`）→ false；
 * - `content` 声明为 `text*` / `inline*` 且非 atom → true
 *   （`code_block` / `mermaid_block` / `math_block` 内的文本）；
 * - **容器块**（`table`）→ 递归看是否含可放光标的子块（`table_cell` 是 `inline*`）
 *   → true。
 *
 * v0.13.0 返修（问题1）：表格此前被判为「不可放光标」→ 单击表格任意单元格会
 * 建立整表 NodeSelection，用户**一点就全选整张表**，无法选中多个单元格、
 * 也就无法合并。表格显然可以在单元格内放光标，必须递归判定。
 *
 * 纯函数，便于单测真值表。
 */
export function blockAcceptsCaret(node: PMNode | null | undefined): boolean {
  if (!node) return false;
  if (node.isText) return false;
  // atom 且无内容 = 真正的叶子（horizontal_rule / toc / image）：没有可放光标的位置
  if (node.isAtom && node.content.size === 0) return false;
  return nodeAcceptsCaret(node);
}

/** 递归判定：该节点或其任意后代能容纳文本光标 */
function nodeAcceptsCaret(node: PMNode): boolean {
  const content = node.type.spec.content ?? "";
  if (content === "") return false;
  if (content.includes("inline") || content.includes("text")) return true;
  // 容器块（table → table_body → table_row → table_cell）：看子节点
  if (typeof node.forEach !== "function") return false;
  let found = false;
  node.forEach((child) => {
    if (found) return;
    if (nodeAcceptsCaret(child)) found = true;
  });
  return found;
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

/**
 * v0.13.0 返修（问题2）：把光标放进指定块内部（单击即编辑用）。
 *
 * 缺陷背景：公式块 / Mermaid 块的编辑层（contentDOM）默认 `display:none`，
 * 只有双击才会显示。而 v0.13.0 的「单击即编辑」只做到了「不拦 mousedown」——
 * 对这两个块来说 PM 根本没有可见的可编辑位置可放光标，用户单击后**毫无反应**，
 * 必须再双击一次。这与代码块（编辑层常驻可见）的表现不一致。
 *
 * 做法：调用方先让 contentDOM 可见，再用本函数把选区落到块内文本上。
 * 位置优先按点击坐标换算；换算不出（或落在块外）时退到块内容起点。
 *
 * @param view 编辑器视图
 * @param pos 块节点在文档中的位置
 * @param clientX/clientY 点击坐标（可选；缺省则落到块内容起点）
 */
export function placeCaretInsideBlock(
  view: EditorView,
  pos: number,
  clientX?: number,
  clientY?: number,
): void {
  const node = view.state.doc.nodeAt(pos);
  if (!node || node.isAtom || node.isText) return;
  const start = pos + 1;
  const end = pos + node.content.size;
  let target = start;
  if (clientX !== undefined && clientY !== undefined) {
    const coords = view.posAtCoords({ left: clientX, top: clientY });
    if (coords) target = coords.pos;
  }
  // 点击坐标可能落在块外（预览层/角标）→ 收敛到块内容区间内
  target = Math.max(start, Math.min(end, target));
  try {
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, target)),
    );
  } catch {
    // 位置非法（结构变化等）→ 静默放弃，至少不抛错
    return;
  }
  view.focus();
}