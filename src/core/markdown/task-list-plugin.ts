/**
 * markdown-it 任务列表插件
 * 识别 - [ ] / - [x] / - [X] 语法，生成 task_list / task_item token
 *
 * 设计：在 markdown-it 的 list 规则之前拦截任务列表语法，
 * 不匹配的普通无序列表仍由原生 list 规则处理。
 */
import type MarkdownIt from "markdown-it";

// 任务列表项正则：匹配行首的 "- [ ]" / "- [x]" / "- [X]" / "* [ ]" / "* [x]" / "* [X]"
const TASK_ITEM_RE = /^(\s*)([-*])\s+\[([ xX])\]\s+/;

function taskListBlock(state: any, startLine: number, endLine: number, silent: boolean): boolean {
  // 检查当前行是否匹配任务列表项
  const lineText = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine]);
  const match = lineText.match(TASK_ITEM_RE);
  if (!match) return false;

  if (silent) return true;

  // 收集连续的任务列表项
  const items: Array<{ checked: boolean; content: string; indent: string; marker: string }> = [];
  let nextLine = startLine;

  while (nextLine <= endLine) {
    const currentLineText = state.src.slice(
      state.bMarks[nextLine] + state.tShift[nextLine],
      state.eMarks[nextLine]
    );
    const itemMatch = currentLineText.match(TASK_ITEM_RE);
    if (!itemMatch) break;

    const checked = itemMatch[3] !== " ";
    const content = currentLineText.slice(itemMatch[0].length);
    items.push({
      checked,
      content,
      indent: itemMatch[1],
      marker: itemMatch[2],
    });
    nextLine++;
  }

  // 生成 token
  // task_list_open
  const listOpen = state.push("task_list_open", "ul", 1);
  listOpen.attrs = [["class", "task-list"]];
  listOpen.markup = "-";
  listOpen.map = [startLine, nextLine];

  for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
    const item = items[itemIdx];
    // task_item_open
    const itemOpen = state.push("task_item_open", "li", 1);
    itemOpen.attrs = [["checked", String(item.checked)], ["class", "task-item"]];
    itemOpen.markup = "-";

    // inline 内容
    const inlineToken = state.push("inline", "", 0);
    inlineToken.content = item.content;
    inlineToken.map = [startLine + itemIdx, startLine + itemIdx + 1];
    inlineToken.children = [];

    // task_item_close
    const itemClose = state.push("task_item_close", "li", -1);
    itemClose.markup = "-";
  }

  // task_list_close
  const listClose = state.push("task_list_close", "ul", -1);
  listClose.markup = "-";

  state.line = nextLine;
  return true;
}

export function taskListPlugin(md: MarkdownIt): void {
  // 在 list 规则之前注册，优先匹配任务列表语法
  md.block.ruler.before("list", "task_list", taskListBlock);
}
