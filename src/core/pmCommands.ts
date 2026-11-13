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
 * 把光标所在的**列表项**原地转换为任务项，并**保留原列表的其余项**。
 *
 * ─── 口径演进（四层，务必别再走回头路）───
 *
 * **① v0.13.2 之前**：任务列表被塞进列表项**内部** → 视觉上就是"回车换行"。
 *
 * **② v0.13.2 需求2**：「把当前行**提升**为任务项」——从列表摘出来，新任务列表插在
 * 原列表**之前**，并把原序号作为**字面文本**写进任务项（`- [ ] 2. bb`）。
 * 缺陷：3 项列表转第 2 项后阅读视图是 `☐ 2. bb` → `1. aa` → `2. cc`，**序号视觉 2/1/2**。
 *
 * **③ v0.17.0 R3（C2 就地转换）**：任务项不带序号、列表断成两段、
 * 后段 `order` 续号 → `1. aa` / `☐ bb` / `2. cc`。
 * 缺陷（用户 R4 反馈）：「在有序列表上加任务待办会**把有序列表弄没**」——
 * 视觉上任务项挤在列表中间，把列表"劈开"了，用户认为列表被弄没了。
 *
 * **④ v0.17.0 R4（本轮，用户 2026-11-12 17:07 裁决，取代 C2）**：
 * ```
 * 1. aa          ← 原样保留（逐字节不变，不重编号）
 * - [ ] 2. bb    ← 原地变待办，**带字面序号 `2.`**
 * 3. cc          ← 原样保留（`3.` 不变，不重编号）
 * ```
 * 关键点：
 * 1. **任务项带字面序号**（`2. `）—— 用户原话「正确例子如**在 2. 上加任务，
 *    那么结果应该是 `- [ ] 2.`**」。序号写进**首段文本开头**（任务项自己没有序号 attr）。
 * 2. **前后两段有序列表的字面序号保持原值**：前段 `order` 沿用原 `attrs.order`；
 *    后段的 `order` 必须设成 **`startOrder + itemIndex + 1`**（即原列表里"下一项"的
 *    字面序号），这样序列化出来才是 `3.` 而不是 `1.`/`2.`。
 *    —— 注意这与 C2 不同：C2 是 `+ itemIndex`（续待办占位），R4 是 `+ itemIndex + 1`
 *    （因为待办项**自己保留了序号**，后续项不能再顶替它的位置）。
 * 3. **整项内容一起搬**（`paragraph block*` 多段 + 嵌套子列表）；v0.13.2 复审修过
 *    "第二段与嵌套子列表静默丢失"，别回退。
 * 4. **唯一一项**：整表被待办项替换，不留空列表（`ordered_list` 要求 `list_item+`）。
 *
 * ─── 为什么这个形态在 markdown 里是稳的（已实测）───
 * `1. aa / - [ ] 2. bb / 3. cc` 解析出 **3 个独立块**
 * （`ordered_list(order=1)` / `task_list` / `ordered_list(order=3)`），
 * 序列化回来**逐字节一致** —— 即"列表没有消失，三行都在"，
 * 且重新打开文件视觉不变。这是用户要的形态，不是权宜之计。
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

  const isOrdered = listNode.type.name === "ordered_list";
  const startOrder = Number(listNode.attrs.order) || 1;
  const itemIndex = itemIndexInList(listNode, itemPos - listPos);
  // 有序列表保留分隔符风格（`1.` / `1)`）—— v0.11.0 B3-6 的既有契约
  const delim = listNode.attrs.delim === ")" ? ")" : ".";

  /**
   * 任务项首段的**字面序号前缀**（R4 核心）。
   *
   * 只有有序列表才需要：序号 = 该项在原列表里的字面序号 = `startOrder + itemIndex`。
   * 无序列表保持不加前缀（`- x` → `- [ ] x`）。
   *
   * ⚠️ 注意 `2. ` 后**必须有一个空格**：用户要的形态是 `- [ ] 2. bb`（序号与正文分开），
   * 少了空格会变成 `- [ ] 2.bb`，视觉上序号和正文粘一起。
   */
  const orderedPrefix = isOrdered ? `${startOrder + itemIndex}${delim} ` : "";

  // ── 任务项：整项内容原样搬入；有序列表在首段开头插入字面序号 ──
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
    const prefixed = orderedPrefix
      ? schema.nodes.paragraph.create(
          null,
          Fragment.fromArray([schema.text(orderedPrefix), ...para.content.content]),
        )
      : para;
    taskItem = schema.nodes.task_item.create({ checked: false }, prefixed);
  }
  const firstLen = taskItem.firstChild ? taskItem.firstChild.textContent.length : 0;

  const tr = state.tr;
  let caretPos: number;
  try {
    if (listNode.childCount <= 1) {
      // 唯一一项：整表被任务项替换，**不留空列表**（`ordered_list` 要求 `list_item+`）
      const taskList = schema.nodes.task_list.create(null, taskItem);
      tr.replaceWith(listPos, listPos + listNode.nodeSize, taskList);
      caretPos = listPos + 3 + firstLen;
    } else {
      // ── 拆成「前段列表 + 任务列表 + 后段列表」 ──
      // 只放**非空**的段：空 ordered_list 不满足 `list_item+`，会直接抛 schema 错误。
      const beforeItems = Fragment.fromArray(
        Array.from({ length: itemIndex }, (_, i) => listNode.child(i)),
      );
      const afterItems = Fragment.fromArray(
        Array.from(
          { length: listNode.childCount - itemIndex - 1 },
          (_, i) => listNode.child(itemIndex + 1 + i),
        ),
      );
      // 前段：序号**保持原值**（`1. aa` 逐字节不变 —— 用户明确要求不重编号）
      const beforeList = beforeItems.size > 0 ? listNode.type.create(listNode.attrs, beforeItems) : null;
      /**
       * 后段列表的 `order` —— **R4 与 C2 的关键差异**（写错就跳号或复位）。
       *
       * R4 下**待办项自己保留了字面序号**（`- [ ] 2. bb` 里的 `2.` 是文本），
       * 所以后段不能"顶替"待办的位置，必须**接着待办后面**继续数：
       * 后段起始号 = 被转换项的字面序号 **+ 1** = `startOrder + itemIndex + 1`。
       *
       * 示例（`1. aa / 2. bb / 3. cc` 转第 2 项，`itemIndex=1, startOrder=1`）：
       * - ✅ 正确 `+1` → order=3 → 序列化 `3. cc`（与原列表完全一致，逐字节不变）
       * - ❌ 用 C2 的 `+0` → order=2 → `2. cc`（跳号：2 出现两次）
       * - ❌ 不设（默认 1）→ order=1 → `1. cc`（复位，重复的 1）
       *
       * ⚠️ 注意 `+1` 只在"待办项真的带了序号前缀"时才对。无序列表没有序号，
       * 后段也不需要改 order（沿用原 attrs 即可）。下面用 `orderedPrefix` 是否存在区分。
       */
      const afterOrder = orderedPrefix ? startOrder + itemIndex + 1 : startOrder;
      const afterList =
        afterItems.size > 0
          ? listNode.type.create({ ...listNode.attrs, order: afterOrder }, afterItems)
          : null;

      const parts: PMNode[] = [];
      if (beforeList) parts.push(beforeList);
      parts.push(schema.nodes.task_list.create(null, taskItem));
      if (afterList) parts.push(afterList);
      tr.replaceWith(listPos, listPos + listNode.nodeSize, parts);

      caretPos = listPos + (beforeList ? beforeList.nodeSize : 0) + 3 + firstLen;
    }
    /**
     * 光标落点：**任务项首段文本末尾**（"转换完可以直接接着打字"）。
     *
     * ⚠️ⓘ 两轮踩坑记录（同一处，两次）：
     * - v0.13.2 用 `listPos + 3`（段首），而同一版又把 `2. ` 写成字面文本塞在段首
     *   → caret 落在序号**之前** → 用户接着敲字得到 `- [ ] X2. bb`，序号被"吃断"。
     * - v0.17.0 R3（C2）去掉字面序号后修正为"首段末尾"。
     * - **v0.17.0 R4 又恢复字面序号** → 所以 caret **必须**仍然落在首段**末尾**：
     *   `firstLen` 已包含序号前缀 `2. ` 的长度，因此 `/ - [ ] 2. bbX` 而不是 `/ - [ ] X2. bb`。
     */
    const clamped = Math.max(1, Math.min(caretPos, tr.doc.content.size - 1));
    tr.setSelection(TextSelection.near(tr.doc.resolve(clamped)));
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
