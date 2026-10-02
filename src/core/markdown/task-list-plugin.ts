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
  // E15：任务项内的缩进续行（嵌套普通列表/段落/代码块等），
  // 保留原始行（含缩进），emit 时相对化后交给 block 解析器二次解析
  extraLines: string[];
}

/** 将 extraLines 相对化（去除全部非空行的最小公共缩进）并拼为子文档源码 */
function relativizeExtraLines(lines: string[]): string {
  let min = Infinity;
  for (const line of lines) {
    if (!line.trim()) continue;
    const ind = line.match(/^\s*/)![0].length;
    if (ind < min) min = ind;
  }
  if (!Number.isFinite(min)) min = 0;
  return lines.map((line) => line.slice(min)).join("\n");
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
  // E15：条目流设计——任务项与缩进续行线性收集，buildTree 时按缩进归属，
  // 保证「与子任务平级的普通列表块」能正确挂回父任务项
  type Entry =
    | { kind: "item"; checked: boolean; content: string; indent: number; line: number }
    | { kind: "extra"; indent: number; text: string };
  const entries: Entry[] = [];
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
      // E15：空行记入条目流（缩进跟随前一 entry），维持子文档的段落分隔语义
      const prev = entries[entries.length - 1];
      entries.push({ kind: "extra", indent: prev ? prev.indent : 0, text: "" });
      nextLine++;
      continue;
    }
    const itemMatch = currentLineText.match(TASK_ITEM_RE);
    if (!itemMatch) {
      // E15：缩进的非任务项行（嵌套普通列表/段落/代码块等）记入条目流；
      // 顶层（缩进 0）的非任务项行结束任务列表，交还 markdown-it 处理
      const lineIndent = state.tShift[nextLine];
      if (entries.length > 0 && lineIndent > 0) {
        entries.push({ kind: "extra", indent: lineIndent, text: " ".repeat(lineIndent) + currentLineText });
        nextLine++;
        continue;
      }
      break;
    }

    const checked = itemMatch[3] !== " ";
    const content = currentLineText.slice(itemMatch[0].length);
    // 缩进来自 state.tShift（markdown-it 已展开 tab 为空格）
    entries.push({
      kind: "item",
      checked,
      content,
      indent: state.tShift[nextLine],
      line: nextLine,
    });
    nextLine++;
  }

  if (entries.length === 0) return false;

  // 将条目流构建为树形结构（基于缩进）
  // extra 行归属规则：挂到最近一个缩进严格小于它的 item；当前层找不到时
  // break 交回上层（它与上层 item 的内容平级）。空行无法归属时丢弃。
  const buildTree = (items: Entry[], startIdx: number, parentIndent: number): { nodes: TaskItemNode[]; nextIdx: number } => {
    const nodes: TaskItemNode[] = [];
    let i = startIdx;
    while (i < items.length) {
      const entry = items[i];
      if (entry.kind === "extra") {
        if (entry.indent > parentIndent) {
          let attached = false;
          for (let k = nodes.length - 1; k >= 0; k--) {
            if (nodes[k].indent < entry.indent) {
              nodes[k].extraLines.push(entry.text);
              attached = true;
              break;
            }
          }
          if (attached) {
            i++;
            continue;
          }
          if (entry.text === "") {
            // 悬空空行（无法归属任何 item）：丢弃，不中断收集
            i++;
            continue;
          }
        }
        break; // 交回上层归属
      }
      if (entry.indent <= parentIndent) break; // 回到父级或更高级，结束当前层级

      const node: TaskItemNode = {
        checked: entry.checked,
        content: entry.content,
        indent: entry.indent,
        children: [],
        extraLines: [],
      };

      // 递归处理子项（缩进大于当前项的）
      const childResult = buildTree(items, i + 1, entry.indent);
      node.children = childResult.nodes;
      i = childResult.nextIdx;

      nodes.push(node);
    }
    return { nodes, nextIdx: i };
  };

  const { nodes: rootNodes } = buildTree(entries, 0, -1);

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

      // 递归生成子任务列表（先于 extra 子块输出，使「任务子列表 + 普通块」
      // 的序列化顺序规范化、二次往返收敛；未编辑块仍走 B6 返回原文）
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

      // E15：任务项内的缩进续行（嵌套普通列表/段落等）作为块级子 token。
      // 子文档去除公共缩进后交给 markdown-it block 解析器解析，
      // token 结构与原生列表完全一致。
      if (node.extraLines.length > 0) {
        const subSrc = relativizeExtraLines(node.extraLines);
        if (subSrc.trim()) {
          const subTokens: any[] = [];
          state.md.block.parse(subSrc, state.md, state.env, subTokens);
          for (const st of subTokens) state.tokens.push(st);
        }
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
