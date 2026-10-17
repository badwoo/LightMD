/**
 * pmCommands —— E1(v0.9.2):阅读模式(ProseMirror)命令执行
 *
 * 此前 App.tsx 的 lightmd:command 路由在阅读模式下走 tr.insertText(语法串),
 * 程序化 insertText 不触发 InputRules,点"加粗"得到的是 `****` 字面文本——"假命令"。
 * 且与键盘快捷键(Ctrl+B 走 PM 命令)行为不一致。
 *
 * 现在的执行顺序:
 * ① getPMCommand(id) 命中 → 执行真命令(与快捷键同一命令源)
 * ② insert.* 类 → 构造对应节点(参考 slash-command.ts applyMenuItem 的既有构造)
 * ③ 均不命中 → 返回 false,由调用方回退(如 link/image 打开对话框)
 *
 * 注意:本模块仅处理 PM 视图,源码模式仍走 COMMAND_SYNTAX(sourceInsertHandler)。
 */
import type { EditorView } from "prosemirror-view";
import { Fragment, type Node as PMNode } from "prosemirror-model";
import { TextSelection } from "prosemirror-state";
import { lightMDSchema as schema } from "./schema";
import { getPMCommand } from "./keymap";

/** 构造 2×2 示例表格(表头 1 行 + 表体 2 行,与 SlashCommand 菜单一致) */
function makeTable() {
  const cell = (header: boolean) =>
    schema.nodes[header ? "table_header" : "table_cell"].create();
  const row = (header: boolean) =>
    schema.nodes.table_row.create(null, [cell(header), cell(header)]);
  return schema.nodes.table.create(null, [
    schema.nodes.table_head.create(null, row(true)),
    schema.nodes.table_body.create(null, [row(false), row(false)]),
  ]);
}

/**
 * 创建空的脚注定义节点(E15:内容模型为 block+,至少一个块)。
 * 空内容时放入一个空段落,保证节点合乎 schema 且光标可直接进入输入。
 */
export function insertFootnoteDefinition(label: string) {
  return schema.nodes.footnote_definition.create({ label }, schema.nodes.paragraph.create());
}

/** 收集文档中已占用的脚注 label,返回首个未用的数字 label("1"、"2"、…) */
function nextFootnoteLabel(doc: import("prosemirror-model").Node): string {
  const used = new Set<string>();
  doc.descendants((node) => {
    if (node.type.name === "footnote_ref" || node.type.name === "footnote_definition") {
      used.add(String(node.attrs.label));
    }
  });
  for (let i = 1; i < 1000; i++) {
    if (!used.has(String(i))) return String(i);
  }
  return "1";
}

/**
 * v0.11.0 B3-3：从 markdown **源码文本**求下一个未占用的脚注 label。
 *
 * 缺陷背景（P1）：源码模式插入脚注时固定写 `[^1]: `（App.tsx 的 COMMAND_SYNTAX），
 * 连续插入两次会产生两个 `[^1]:`，后者覆盖前者 → **脚注内容静默丢失**。
 * 阅读模式走 nextFootnoteLabel(PM doc) 自动取号，故只有源码模式有此问题。
 *
 * 与 PM 版同口径（从 1 开始找第一个未占用），保证两种模式行为一致。
 */
export function nextFootnoteLabelFromText(text: string): string {
  const used = new Set<string>();
  // 匹配脚注定义 `[^label]:` 与引用 `[^label]`
  for (const m of text.matchAll(/\[\^([^\]\s]+)\]/g)) {
    used.add(m[1]!);
  }
  for (let i = 1; i < 1000; i++) {
    if (!used.has(String(i))) return String(i);
  }
  return "1";
}

/** 列表类节点名（v0.13.2 需求2：Ctrl+T 在这些容器里要"提升当前项"） */
const LIST_TYPES = new Set(["ordered_list", "bullet_list", "task_list"]);
/** 列表项节点名 */
const LIST_ITEM_TYPES = new Set(["list_item", "task_item"]);

/** 取节点里第一个段落（列表项内容模型是 `paragraph block*`，首块通常是段落） */
function firstParagraphOf(node: PMNode): PMNode | null {
  let found: PMNode | null = null;
  node.forEach((child) => {
    if (found) return;
    if (child.type.name === "paragraph") found = child;
  });
  return found;
}

/**
 * 列表项在列表里的下标（0-based）。
 *
 * @param list 列表节点（ordered_list / bullet_list / task_list）
 * @param offsetInList 列表项相对列表节点起点的偏移（= `itemPos - listPos`）
 */
function itemIndexInList(list: PMNode, offsetInList: number): number {
  let pos = 1; // 列表内容从「开始 token 之后」算起
  for (let i = 0; i < list.childCount; i++) {
    if (pos === offsetInList) return i;
    pos += list.child(i).nodeSize;
  }
  return Math.max(0, list.childCount - 1);
}

/**
 * v0.13.2 需求2：把光标所在的**列表项**提升为任务项，并放到该列表**之前**。
 *
 * ─── 缺陷背景（用户报告）───
 * 「在阅读模式下，我在有序列表使用快捷键 Ctrl+T，想给这行加任务列表，
 *  结果任务列表没有自动加到有序列表前，而是回车换行了。」
 *
 * 旧实现（`insert.taskList` 分支）只认「当前块是顶层段落/标题」：
 * 列表项里的光标其 `parent` 仍是 paragraph，于是走 `replaceBlock` 把**列表项内的
 * 段落**替换成 task_list —— 任务列表被塞进有序列表项内部（视觉上就是"在原来那行
 * 下面多了一行"），而不是在有序列表之前新建一个任务列表。
 *
 * ─── 现在的口径（用户确认）───
 * 「把当前行『提升』为任务项」：
 * · 该行从有序列表里**摘出来**，作为任务项放进一个新任务列表；
 * · 新任务列表插在**原列表之前**（用户原话"自动加到有序列表前"）；
 * · 列表其余项原样保留（若原列表只有这一项，整表被任务列表替换）。
 *
 * @returns true = 已处理；false = 光标不在列表项内，交回调用方的原有分支
 */
function liftListItemToTaskList(view: EditorView): boolean {
  const { state } = view;
  const { $from } = state.selection;
  // 从内向外找最近的列表容器（嵌套列表时取最内层，语义最直观）
  let listDepth = -1;
  for (let d = $from.depth; d >= 1; d--) {
    if (LIST_TYPES.has($from.node(d).type.name)) {
      listDepth = d;
      break;
    }
  }
  if (listDepth < 0) return false;
  const itemDepth = listDepth + 1;
  if (itemDepth > $from.depth) return false;
  if (!LIST_ITEM_TYPES.has($from.node(itemDepth).type.name)) return false;

  const listNode = $from.node(listDepth);
  const listPos = $from.before(listDepth);
  const itemPos = $from.before(itemDepth);
  const itemNode = state.doc.nodeAt(itemPos);
  if (!itemNode) return false;

  // v0.13.2 返修（需求2）：**有序列表的序号必须保留**。
  //
  // 用户复测反馈：「给有序列表加任务列表，一加有序列表就消失了；我要的效果是
  // `- [ ] 1. xxx`。」任务列表本身只有 bullet 标记，被提升的项若丢掉 `1.`，
  // 用户看到的就是"编号没了"。因此把原序号（含 `)` 分隔符）作为**字面文本**
  // 写进任务项首段开头 —— 源码成为 `- [ ] 1. xxx`，阅读模式渲染为
  // ☐ 1. xxx，序号码与原列表完全一致。
  const isOrdered = listNode.type.name === "ordered_list";
  const orderedPrefix = isOrdered
    ? `${(Number(listNode.attrs.order) || 1) + itemIndexInList(listNode, itemPos - listPos)}${
        listNode.attrs.delim === ")" ? ")" : "."
      } `
    : "";
  // 任务项内容模型与 list_item 相同（`paragraph block*`），因此把**整项内容**原样搬入。
  //
  // ⚠️ 只搬首段会**静默丢失**该项里的第二段与嵌套子列表（v0.13.2 复审发现的
  // 数据丢失缺陷：源码 `1. bb1\n\n   bb2\n\n2. cc` 解析出「同一 list_item 里两个
  // 段落」，光标在 bb1 上按 Ctrl+T，旧实现只剩 `- [ ] bb1`，bb2 凭空消失）。
  // 内容模型不兼容时（理论上不该发生）退回首段，保证命令本身不会整个失败。
  let taskItem: PMNode;
  try {
    let content = itemNode.content;
    if (orderedPrefix) {
      const first = itemNode.firstChild;
      if (first && first.isTextblock) {
        const prefixed = first.type.create(
          first.attrs,
          Fragment.fromArray([schema.text(orderedPrefix), ...first.content.content]),
        );
        content = Fragment.fromArray([prefixed, ...itemNode.content.content.slice(1)]);
      }
    }
    taskItem = schema.nodes.task_item.create({ checked: false }, content);
  } catch {
    const para = firstParagraphOf(itemNode) ?? schema.nodes.paragraph.create();
    const fallback = orderedPrefix
      ? schema.nodes.paragraph.create(
          null,
          Fragment.fromArray([schema.text(orderedPrefix), ...para.content.content]),
        )
      : para;
    taskItem = schema.nodes.task_item.create({ checked: false }, fallback);
  }
  const taskList = schema.nodes.task_list.create(null, taskItem);

  const tr = state.tr;
  try {
    if (listNode.childCount <= 1) {
      // 只有这一项：整表被任务列表替换（等价于"提升这一行"）
      tr.replaceWith(listPos, listPos + listNode.nodeSize, taskList);
    } else {
      // 摘出该项，再把任务列表插到原列表之前
      tr.delete(itemPos, itemPos + itemNode.nodeSize);
      tr.insert(listPos, taskList);
    }
    // 光标落进新任务项的段落里（task_list +1 → task_item +1 → paragraph +1 → 文本 +1）
    const caret = Math.min(listPos + 3, tr.doc.content.size - 1);
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(1, caret))));
  } catch {
    return false;
  }
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

/**
 * 在阅读模式 PM 视图上执行格式/插入命令。
 * 返回是否已处理;false 时调用方可回退到对话框/其他通道。
 */
export function runPreviewCommand(id: string, view: EditorView): boolean {
  // ① 真命令:bold/italic/strike/inlineCode/highlight/heading1-6/paragraph/list/quote/undo/redo
  const cmd = getPMCommand(id);
  if (cmd) {
    const ok = cmd(view.state, view.dispatch, view);
    if (ok) view.focus();
    return ok;
  }

  const { state } = view;
  const { $from } = state.selection;
  const parent = $from.parent;
  const blockStart = $from.before();
  const blockEnd = blockStart + parent.nodeSize;

  /** 替换当前所在块为给定节点(块级转换语义,与 Slash 菜单一致) */
  const replaceBlock = (nodes: Parameters<typeof state.tr.replaceWith>[2]) => {
    const tr = state.tr.replaceWith(blockStart, blockEnd, nodes);
    view.dispatch(tr.scrollIntoView());
    view.focus();
    return true;
  };

  switch (id) {
    // ② insert 类(当前块必须为段落/标题才执行,代码块/表格内不处理)
    case "insert.codeblock": {
      if (parent.type.name !== "paragraph" && parent.type.name !== "heading") return false;
      const tr = state.tr.setBlockType(blockStart, blockEnd, schema.nodes.code_block);
      view.dispatch(tr.scrollIntoView());
      view.focus();
      return true;
    }
    case "insert.mermaid": {
      if (parent.type.name !== "paragraph" && parent.type.name !== "heading") return false;
      // 空格占位与输入规则(```mermaid)的构造一致
      return replaceBlock(
        schema.nodes.mermaid_block.create(null, schema.text(" "))
      );
    }
    case "insert.table": {
      if (parent.type.name !== "paragraph" && parent.type.name !== "heading") return false;
      const para = schema.nodes.paragraph.create();
      return replaceBlock([makeTable(), para]);
    }
    case "insert.taskList": {
      // v0.13.2 需求2：光标在列表项里 → **把当前行提升为任务项**，
      // 新任务列表插到原列表之前（用户确认的语义）。
      if (liftListItemToTaskList(view)) return true;
      if (parent.type.name !== "paragraph" && parent.type.name !== "heading") return false;
      // 任务项内容只能是 paragraph block*,heading 降级为空段落(与 Slash 菜单一致)
      const listContent = parent.type.name === "paragraph" ? parent : schema.nodes.paragraph.create();
      return replaceBlock(
        schema.nodes.task_list.create(null,
          schema.nodes.task_item.create({ checked: false }, listContent))
      );
    }
    case "insert.footnote": {
      // 光标处插入脚注引用,文末追加定义(label 取首个未用编号)
      const label = nextFootnoteLabel(state.doc);
      const ref = schema.nodes.footnote_ref.create({ label });
      const def = insertFootnoteDefinition(label);
      const tr = state.tr.replaceSelectionWith(ref);
      tr.insert(tr.doc.content.size, def);
      view.dispatch(tr.scrollIntoView());
      view.focus();
      return true;
    }
    default:
      // ③ insert.link / insert.image 等由调用方处理(打开对话框)
      return false;
  }
}
