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
