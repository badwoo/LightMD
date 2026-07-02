/**
 * markdown-it 任务列表插件
 * 识别 - [ ] / - [x] / - [X] 语法，生成 task_list / task_item token
 * 支持嵌套任务列表（缩进的子任务项）
 *
 * 设计：在 markdown-it 的 list 规则之前拦截任务列表语法，
 * 不匹配的普通无序列表仍由原生 list 规则处理。
 */
import type MarkdownIt from "markdown-it";

// 任务列表项正则：匹配行首的 "- [ ]" / "- [x]" / "- [X]" / "* [ ]" / "* [x]" / "* [X]"
const TASK_ITEM_RE = /^(\s*)([-*])\s+\[([ xX])\]\s+/;

interface TaskItemNode {
  checked: boolean;
  content: string;
  indent: number; // 缩进空格数
  children: TaskItemNode[];
}

function taskListBlock(state: any, startLine: number, endLine: number, silent: boolean): boolean {
  // 检查当前行是否匹配任务列表项
  const lineText = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine]);
  const match = lineText.match(TASK_ITEM_RE);
  if (!match) return false;

  if (silent) return true;

  // 只有当第一行是顶层（indent=0）时才作为任务列表处理
  // state.tShift[line] 是该行的前导空格数（已展开 tab）
  if (state.tShift[startLine] > 0) return false;

  // 收集连续的任务列表项（包括缩进的子任务项）
  interface RawItem {
    checked: boolean;
    content: string;
    indent: number; // 缩进空格数（来自 state.tShift）
    line: number;
  }
  const rawItems: RawItem[] = [];
  let nextLine = startLine;

  while (nextLine <= endLine) {
    // 跳过空行
    if (state.tShift[nextLine] < 0 || state.sCount[nextLine] < 0) {
      nextLine++;
      continue;
    }
    // 获取行文本（去除前导空格后的内容）
    const currentLineText = state.src.slice(
      state.bMarks[nextLine] + state.tShift[nextLine],
      state.eMarks[nextLine]
    );
    // 空行跳过（但不中断，允许任务项之间有空行）
    if (currentLineText.trim() === "") {
      nextLine++;
      continue;
    }
    const itemMatch = currentLineText.match(TASK_ITEM_RE);
    if (!itemMatch) break;

    const checked = itemMatch[3] !== " ";
    const content = currentLineText.slice(itemMatch[0].length);
    // 缩进来自 state.tShift（markdown-it 已展开 tab 为空格）
    const indent = state.tShift[nextLine];
    rawItems.push({
      checked,
      content,
      indent,
      line: nextLine,
    });
    nextLine++;
  }

  if (rawItems.length === 0) return false;

  // 将扁平列表构建为树形结构（基于缩进）
  const buildTree = (items: RawItem[], startIdx: number, parentIndent: number): { nodes: TaskItemNode[]; nextIdx: number } => {
    const nodes: TaskItemNode[] = [];
    let i = startIdx;
    while (i < items.length) {
      const item = items[i];
      if (item.indent <= parentIndent) break; // 回到父级或更高级，结束当前层级

      const node: TaskItemNode = {
        checked: item.checked,
        content: item.content,
        indent: item.indent,
        children: [],
      };

      // 递归处理子项（缩进大于当前项的）
      const childResult = buildTree(items, i + 1, item.indent);
      node.children = childResult.nodes;
      i = childResult.nextIdx;

      nodes.push(node);
    }
    return { nodes, nextIdx: i };
  };

  const { nodes: rootNodes } = buildTree(rawItems, 0, -1);

  // 递归生成 token
  const emitNodes = (nodes: TaskItemNode[], itemLineOffset: number) => {
    for (let idx = 0; idx < nodes.length; idx++) {
      const node = nodes[idx];
      // task_item_open
      const itemOpen = state.push("task_item_open", "li", 1);
      itemOpen.attrs = [["data-checked", String(node.checked)], ["class", "task-item"]];
      itemOpen.markup = "-";
      itemOpen.map = [startLine + idx, startLine + idx + 1];

      // inline 内容
      const inlineToken = state.push("inline", "", 0);
      inlineToken.content = node.content;
      inlineToken.map = [startLine + idx, startLine + idx + 1];
      inlineToken.children = [];

      // 递归生成子任务列表
      if (node.children.length > 0) {
        // task_list_open (嵌套)
        const childListOpen = state.push("task_list_open", "ul", 1);
        childListOpen.attrs = [["class", "task-list"]];
        childListOpen.markup = "-";

        emitNodes(node.children, itemLineOffset);

        // task_list_close (嵌套)
        const childListClose = state.push("task_list_close", "ul", -1);
        childListClose.markup = "-";
      }

      // task_item_close
      const itemClose = state.push("task_item_close", "li", -1);
      itemClose.markup = "-";
    }
  };

  // task_list_open
  const listOpen = state.push("task_list_open", "ul", 1);
  listOpen.attrs = [["class", "task-list"]];
  listOpen.markup = "-";
  listOpen.map = [startLine, nextLine];

  emitNodes(rootNodes, 0);

  // task_list_close
  const listClose = state.push("task_list_close", "ul", -1);
  listClose.markup = "-";

  state.line = nextLine;
  return true;
}

export function taskListPlugin(md: MarkdownIt): void {
  // 在 list 规则之前注册，优先匹配任务列表语法
  md.block.ruler.before("list", "task_list", taskListBlock);

  // 注册渲染规则：输出 checkbox + content 结构，与阅读模式 NodeView 的 DOM 对齐
  // 未注册 renderer.rules 时，markdown-it 默认渲染 <li> 不含 checkbox，
  // 导致分屏模式下 CSS 选择器 .task-item input[type="checkbox"] 无法匹配
  md.renderer.rules.task_item_open = function (tokens, idx) {
    const token = tokens[idx];
    const checked = token.attrGet("data-checked") === "true";
    const checkbox = `<input type="checkbox" class="task-checkbox"${checked ? " checked" : ""} data-checked="${checked}">`;
    return `<li class="task-item" data-checked="${checked}">${checkbox}<div class="task-content${checked ? " task-checked" : ""}">`;
  };

  md.renderer.rules.task_item_close = function () {
    return "</div></li>\n";
  };
}
