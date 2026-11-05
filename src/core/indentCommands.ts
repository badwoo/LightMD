/**
 * indentCommands —— v0.16.0「缩进」一等公民命令（`indent` / `outdent`）
 *
 * ─── 为什么需要这一层 ───
 *
 * v0.15.6 的 Tab 链是：
 *   `chainCommands(pairTabOut, tableTab, codeBlockIndent, sinkListItem(task), sinkListItem(list))`
 * 链上**全部返回 false** 时落到 `keymap(baseKeymap)`（无 Tab 条目）→ 浏览器原生 Tab
 * → **焦点逃出编辑器**。于是段落 / 标题 / 引用块 / 公式块 / 列表首项 / NodeSelection
 * 这六类上下文里按 Tab 都会把焦点送到侧栏按钮（实测 `ProseMirror → sidebar-toggle-btn`）。
 *
 * 逐场景打补丁是修不完的（每加一种块类型就多一个逃逸点）。本文件改为**结构性保证**：
 * `indent` / `outdent` 是一个**按块类型分派的兜底入口**，除表格分支外**永不返回 false**。
 * 任何块类型按 Tab 都至少在命令层被接管（吞键 = 阻止浏览器默认行为），
 * 焦点逃逸从"逐个场景修复"变成"命令结构上不可能发生"。
 *
 * ─── 分派表（与实施方案 §3.1 决策 A 严格一致）───
 *
 * | 上下文 | indent（Tab） | outdent（Shift-Tab） |
 * |---|---|---|
 * | 表格 cell / header | **返回 false**（交 `tableTab` / `tableShiftTab`） | 同 |
 * | `code_block` / `mermaid_block` / `math_block` | 委托 `codeBlockIndent` | 委托 `codeBlockOutdent` |
 * | `list_item` / `task_item` | `sinkListItem`；失败 → 通知 + 吞键 | `liftListItem`；失败吞键 |
 * | 顶层段落 | 插入缩进单位 | 行首缩进区删一个单位，否则吞键 |
 * | 引用块 | `wrapIn(blockquote)` 加一层 `>` | `lift` 出引用；失败吞键 |
 * | 标题 | 吞键（不派发事务） | 吞键 |
 * | `NodeSelection` | 吞键（不派发事务） | 吞键 |
 * | 其余 | 吞键 | 吞键 |
 *
 * ─── 关键口径 ───
 *
 * 1. **永不 false**（表格除外）：这是「焦点不逃逸」的**结构性保证**，不是逐场景补丁。
 * 2. **代码块逻辑不在这里重写**：逐行缩进/反缩进的算法（D1/D8/D9/D10）全部在
 *    `plugins/code-indent.ts`（由 B2 负责），本文件只做**分派** —— 单一实现处。
 * 3. **每次缩进独立成一步撤销（Q4）**：所有**会改变文档**的派发统一走
 *    `dispatch(closeHistory(tr))`。`prosemirror-history` 的 `closeHistory` 给事务打
 *    `closeHistoryKey` 元数据，强制结束当前历史组 —— 实测两次缩进 → `undoDepth=2`，
 *    undo 一次只退一步。不依赖默认的 `newGroupDelay: 500` + `isAdjacentTo` 启发式。
 *    （只移动选区的分支（引用 lift 会改文档；列表 sink/lift 也改文档）由底层命令
 *    派发，`codeBlockIndent/Outdent` 内部已自带 closeHistory；本文件自建事务的
 *    paragraph / blockquote 分支统一套 closeHistory。）
 * 4. **缩进单位可配**：`readIndentUnit()` 读 `useSettingsStore.indentUnit`，
 *    沿用 `readAutoPairConfig()` 的既有先例（core 只**读** store，不 import 组件），
 *    与 `--lm-tab-size` CSS 变量同源，保证「插入的字符数」与「视觉宽度」自洽。
 *
 * ─── 用户已拍板（v0.16.0 §8 待评审确认项）───
 *
 * · Q1：段落 Tab **给产物**（插入缩进单位），不采用 Typora 的"静默无反应"；
 * · Q2：列表首项 Tab = **通知 + 吞键**（不造空父项，避免可序列化中间层）；
 * · Q3：缩进单位默认 `"2"`（与 v0.9.2 起 `codeBlockIndent` 的 2 空格口径自洽）。
 */
import { Command, EditorState, NodeSelection } from "prosemirror-state";
import type { Transaction } from "prosemirror-state";
import { liftListItem, sinkListItem } from "prosemirror-schema-list";
import { closeHistory } from "prosemirror-history";
import { findWrapping, liftTarget } from "prosemirror-transform";
import { lightMDSchema } from "./schema";
// B2 的逐行缩进实现：本文件只分派，不重复实现（导出名不变，B2 可继续重写内部）
import { codeBlockIndent, codeBlockOutdent } from "./plugins/code-indent";
import { useSettingsStore, indentUnitString } from "../stores/useSettingsStore";
import { notify } from "../services/notificationService";
import { t } from "../i18n/state";

const schema = lightMDSchema;

/**
 * 当前缩进单位字符串（`"  "` / `"    "` / `"\t"`）。
 *
 * `useSettingsStore.indentUnit` 是唯一事实来源：设置项改动即时生效，
 * PM 命令与源码模式（B4 的 `planSourceIndent`）共用同一口径。
 */
export function readIndentUnit(): string {
  return indentUnitString(useSettingsStore.getState().indentUnit);
}

/** 光标是否位于表格单元格内（table_cell / table_header，祖先链判定） */
function inTableCell(state: EditorState): boolean {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name;
    if (name === "table_cell" || name === "table_header") return true;
  }
  return false;
}

/** 光标所在的列表项类型（list_item / task_item），不在列表项内返回 null */
function listItemKind(state: EditorState): "list_item" | "task_item" | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name;
    if (name === "list_item" || name === "task_item") return name;
  }
  return null;
}

/** 光标是否位于引用块内（blockquote 祖先链判定） */
function inBlockquote(state: EditorState): boolean {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === "blockquote") return true;
  }
  return false;
}

/** 顶层普通段落（`depth === 1` 且父节点是 paragraph；与 keymap 的回车口径同源） */
function inTopLevelParagraph(state: EditorState): boolean {
  const { $from } = state.selection;
  return $from.depth === 1 && $from.parent.type.name === "paragraph";
}

/** 光标所在文本块是标题（heading 的 content 为 inline*，同段落层） */
function inHeading(state: EditorState): boolean {
  const { $from } = state.selection;
  return $from.parent.type.name === "heading";
}

/**
 * 从「光标到行首之间的全部空白」里算「删一个缩进单位」的长度。
 *
 * · 紧邻光标的是 `\t` → 删 1 个字符（1 个 `\t` 恒等于 1 个缩进单位，与设置无关，
 *   粘贴来的 `\t` 缩进代码必须能被反缩进）；
 * · 否则删 `min(unit.length, 行首空白数)` 个空格 —— 奇数/不足一个单位时自然收敛。
 *
 * @returns 0 = 无可删（调用方应吞键）
 */
function trailingIndentLen(indentText: string, unit: string): number {
  if (indentText.endsWith("\t")) return 1;
  const spaces = / +$/.exec(indentText)?.[0].length ?? 0;
  if (spaces === 0) return 0;
  return Math.min(unit.length, spaces);
}

/**
 * 把下游命令的 dispatch 包一层 `closeHistory`。
 *
 * 为什么需要：`sinkListItem` / `liftListItem` / `codeBlockIndent` / `codeBlockOutdent`
 * 都是**自己派发事务**的 Command，我们拿不到它们的 `tr`。但它们内部的事务同样代表
 * 「一次缩进操作」，必须遵守 Q4「每次缩进独立成步」的口径 —— 否则快速连按两次
 * 列表 Tab 会被 `prosemirror-history` 的 500ms 窗口 + 位置相邻启发式合并成一步。
 *
 * 包装是幂等的：`closeHistory` 只是 `tr.setMeta(closeHistoryKey, true)`，
 * 即使下游自己也打过（`codeBlockIndent/Outdent` 内部已打），重复设置无副作用。
 */
function withCloseHistory(dispatch: ((tr: Transaction) => void) | undefined) {
  if (!dispatch) return undefined;
  return (tr: Transaction) => dispatch(closeHistory(tr));
}

/**
 * Tab：按块类型分派缩进。
 *
 * 除表格分支（返回 false 交 `tableTab`）外**永不返回 false** —— 结构性消除焦点逃逸。
 */
export const indent: Command = (state, dispatch, view) => {
  const { selection } = state;
  // 下游命令的派发统一套 closeHistory（见 withCloseHistory 的注释）
  const dispatchChild = withCloseHistory(dispatch);

  // ① 表格优先交出去：Tab 在表格里的语义是「逐格导航」（Typora/Excel 同款），
  //    优先级高于一切缩进语义。`indent` 在链上排在 `tableTab` 之后，此处是双保险。
  if (inTableCell(state)) return false;

  // ② NodeSelection（整块选中）：整块缩进在 Markdown 的**顶层块**上没有对应物
  //    （顶层块的前后缩进会被解析器吞掉或改变块类型），故吞键并明确「块级不可缩进」。
  //    放在最前面：任何 Command 在 NodeSelection 态下都应先挡住，否则各分支
  //    （要求文本选区）会一路返回 false → 焦点逃逸。
  if (selection instanceof NodeSelection) return true;

  // ③ 代码类文本块（code_block / mermaid_block / math_block）：
  //    委托 B2 的逐行实现（空选区单点插入、有选区按行插入、一个事务 = 一次撤销）。
  //    这里的 `false` 是「不在代码类块内」的信号，由后续分支继续分派，不是逃逸。
  if (codeBlockIndent(state, dispatchChild, view)) return true;

  // ④ 列表项 / 任务项：`sinkListItem` 要求「存在前一个兄弟项」才能嵌套，
  //    首项天然不满足 —— 旧实现此时返回 false → 焦点逃逸（D5）。
  const listKind = listItemKind(state);
  if (listKind) {
    const sink = sinkListItem(schema.nodes[listKind]);
    if (sink(state, dispatchChild, view)) return true;
    // 首项兜底（Q2 已拍板：**通知 + 吞键**，不造空父项以免插入可序列化中间层）
    if (dispatch) notify(t("indent.cannotNestFirstItem"), "info");
    return true;
  }

  // ⑤ 引用块：加一层 `>`（内层再嵌套一层 blockquote）。
  //    `wrapIn` 的判定/落地用 `findWrapping` 直接复用（避免 wrapIn 内部 dispatch
  //    绕过 closeHistory，破坏 Q4「每次缩进独立成步」）。
  if (inBlockquote(state)) {
    const { $from, $to } = selection;
    const range = $from.blockRange($to);
    const wrapping = range && findWrapping(range, schema.nodes.blockquote);
    if (!range || !wrapping) return true; // 已在最内层 / 不可再嵌 → 吞键
    if (dispatch) dispatch(closeHistory(state.tr.wrap(range, wrapping).scrollIntoView()));
    return true;
  }

  // ⑥ 标题：无缩进语义，但**必须吞键**（否则浏览器默认 Tab 会把焦点送出编辑器）。
  if (inHeading(state)) return true;

  // ⑦ 顶层段落（Q1 已拍板：**给产物** —— 插入缩进单位）。
  //    Markdown 里段落前后空格无语法意义，但有明确的视觉缩进价值，且
  //    「按了有反应」比「按了没反应」更可发现（与 Typora 的取舍不同）。
  if (inTopLevelParagraph(state)) {
    if (dispatch) {
      const tr = state.tr.insertText(readIndentUnit(), selection.$from.pos);
      dispatch(closeHistory(tr));
    }
    return true;
  }

  // ⑧ 其余（定义列表项 / 脚注定义内段落 / 水平线旁 / 只读态……）：吞键。
  return true;
};

/**
 * Shift+Tab：按块类型分派反缩进。
 *
 * 与 `indent` 对称：除表格分支外**永不返回 false**。
 */
export const outdent: Command = (state, dispatch, view) => {
  const { selection } = state;
  // 下游命令的派发统一套 closeHistory（见 withCloseHistory 的注释）
  const dispatchChild = withCloseHistory(dispatch);

  // ① 表格：交 `tableShiftTab` 逐格后退（首行首格由它吞键）。
  if (inTableCell(state)) return false;

  // ② NodeSelection：吞键，不派发事务（同 indent）。
  if (selection instanceof NodeSelection) return true;

  // ③ 代码类文本块：委托 B2 的逐行反缩进。
  //    注意：它在「行中 / 行首无缩进」时**吞键**（返回 true），不会落回浏览器。
  if (codeBlockOutdent(state, dispatchChild, view)) return true;

  // ④ 列表项 / 任务项：`liftListItem` 提升层级；失败也吞键（防逃逸）。
  const listKind = listItemKind(state);
  if (listKind) {
    const lift = liftListItem(schema.nodes[listKind]);
    if (lift(state, dispatchChild, view)) return true;
    return true;
  }

  // ⑤ 引用块：`lift` 出引用；已是顶层 / 不可提升 → 吞键。
  if (inBlockquote(state)) {
    const { $from, $to } = selection;
    const range = $from.blockRange($to);
    const target = range && liftTarget(range);
    if (!range || target == null) return true;
    if (dispatch) dispatch(closeHistory(state.tr.lift(range, target).scrollIntoView()));
    return true;
  }

  // ⑥ 标题：吞键（同 indent）。
  if (inHeading(state)) return true;

  // ⑦ 顶层段落：光标位于「行首缩进区」时删一个缩进单位，否则吞键。
  //    「行首缩进区」= 光标到行首之间**全是空白** —— 这是区分「正常反缩进」与
  //    「光标在行尾、右边那些是硬换行标记空格」的唯一可靠判据。
  //    `textBetween` 的 leafText 传 `"\n"` 是为了让段内 `hard_break` 也算行界。
  if (inTopLevelParagraph(state)) {
    const { $from } = selection;
    const before = state.doc.textBetween($from.start(), $from.pos, "\n", "\n");
    const lineIndent = before.slice(before.lastIndexOf("\n") + 1);
    const len = /^[ \t]+$/.test(lineIndent) ? trailingIndentLen(lineIndent, readIndentUnit()) : 0;
    if (len > 0 && dispatch) dispatch(closeHistory(state.tr.delete($from.pos - len, $from.pos)));
    return true;
  }

  // ⑧ 其余：吞键。
  return true;
};
