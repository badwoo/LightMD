/**
 * v0.6.6 问题2：阅读模式（ProseMirror 富文本）Slash 命令面板插件
 *
 * 职责：
 * - detectSlashState（纯函数）：检测光标所在块是否处于 `/` 触发状态
 *   （块内光标前文本匹配 ^\s*\/\w*$，仅 paragraph/heading，代码块等不触发）
 * - createSlashCommandPlugin：每次 transaction 后调用 detectSlashState，
 *   状态变化时通过 onStateChange 回调通知 React 层（EditorContainer 渲染菜单）
 * - applyMenuItem：菜单选择后删除触发的 `/query` 文本，并将当前块
 *   转换为对应节点（标题/引用/列表/代码块/表格/公式/分割线等）
 *
 * 设计与 translateTooltip 插件一致：插件只做状态检测与回调，
 * UI 渲染与键盘导航由 React 组件（SlashCommandPm）负责。
 */
import { Plugin, PluginKey, TextSelection } from "prosemirror-state";
import type { EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { NodeRange } from "prosemirror-model";
import { findWrapping } from "prosemirror-transform";
import { lightMDSchema as schema } from "../schema";

/** Slash 触发状态：from 为 `/` 字符位置，to 为光标位置（删除区间 [from, to]） */
export interface SlashState {
  from: number;
  to: number;
  query: string;
}

/**
 * 检测编辑器当前是否处于 Slash 触发状态（纯函数，便于单元测试）
 *
 * 触发条件（与源码模式 findSlashTrigger 语义对齐）：
 * - 光标为空选区，且位于 paragraph / heading 块内
 * - 光标前的块内文本匹配 ^\s*\/\w*$（行首 `/` + 可选过滤词）
 */
export function detectSlashState(state: EditorState): SlashState | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const $pos = selection.$from;
  const parent = $pos.parent;
  if (parent.type.name !== "paragraph" && parent.type.name !== "heading") return null;
  // 光标前的块内文本（块内偏移 0 ~ parentOffset）
  const textBefore = parent.textBetween(0, $pos.parentOffset, "\n", "\0");
  const m = textBefore.match(/^(\s*)\/(\w*)$/);
  if (!m) return null;
  return {
    from: $pos.start() + m[1].length,
    to: $pos.pos,
    query: m[2],
  };
}

/** 插件 key（外部可读取插件状态做断言） */
export const slashPluginKey = new PluginKey<SlashState | null>("slashCommandPm");

/**
 * 创建 Slash 命令插件
 *
 * @param onStateChange 状态变化回调（触发 → SlashState；失效 → null），
 *                      由 EditorContainer 注入，用于驱动 React 菜单渲染
 */
export function createSlashCommandPlugin(onStateChange: (s: SlashState | null) => void) {
  let last: SlashState | null = null;
  return new Plugin<SlashState | null>({
    key: slashPluginKey,
    view() {
      return {
        update(v: EditorView, prevState: EditorState) {
          // 仅在文档内容变化时检测（与源码模式一致：纯光标移动不触发菜单）
          if (v.state.doc === prevState.doc) return;
          const s = detectSlashState(v.state);
          // 状态未变化时不重复回调，避免每次输入都触发 React 渲染
          if (s?.from === last?.from && s?.to === last?.to && s?.query === last?.query) return;
          last = s;
          onStateChange(s);
        },
      };
    },
  });
}

/**
 * 应用菜单项：删除触发的 `/query` 文本，将当前块转换为对应节点
 *
 * @param view 编辑器视图
 * @param item 菜单项（仅需 id 字段；类型宽松以避免 core → components 反向依赖）
 * @param slash 触发状态（删除区间 [from, to]）
 * @returns 是否成功应用（inline 类菜单项在 PM 模式不适用，返回 false）
 */
export function applyMenuItem(
  view: EditorView,
  item: { id: string },
  slash: SlashState
): boolean {
  const { state } = view;
  // 1. 删除触发的 `/` + 过滤词
  let tr = state.tr.delete(slash.from, slash.to);
  // 2. 删除后重新定位当前块（delete 会同步更新映射）
  const $pos = tr.doc.resolve(slash.from);
  const parent = $pos.parent;
  if (!parent.isBlock || parent.type.name === "doc") return false;
  const blockStart = $pos.before();
  const blockEnd = blockStart + parent.nodeSize;

  // 任务列表项内容只能是 paragraph block*，heading 需降级为空段落
  const para = schema.nodes.paragraph.create();
  const listContent = parent.type.name === "paragraph" ? parent : para;

  /** 将光标设置到指定块内文本起点 */
  const cursorAt = (pos: number) => {
    tr = tr.setSelection(TextSelection.create(tr.doc, Math.min(pos, tr.doc.content.size)));
  };

  /**
   * 基于当前块构造包裹范围并解析完整 wrapper 链
   * findWrapping 会自动填充中间层节点（如 bullet_list 内的 list_item），
   * 直接传单层 wrapper 会导致 "Content does not fit" 错误
   */
  const wrapBlock = (nodeType: typeof schema.nodes.blockquote) => {
    // resolve 到块内部（depth ≥ 1），blockRange 才能返回以块为单位的范围
    const $from = tr.doc.resolve(Math.min(blockStart + 1, tr.doc.content.size));
    const $to = tr.doc.resolve(Math.max(blockEnd - 1, blockStart + 1));
    const range = $from.blockRange($to);
    if (!range) return false;
    const wrapping = findWrapping(range, nodeType);
    if (!wrapping) return false;
    tr = tr.wrap(range, wrapping);
    return true;
  };

  switch (item.id) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
      tr = tr.setBlockType(blockStart, blockEnd, schema.nodes.heading, {
        level: Number(item.id.slice(1)),
      });
      break;
    case "quote":
      if (!wrapBlock(schema.nodes.blockquote)) return false;
      break;
    case "hr":
      tr = tr.replaceWith(blockStart, blockEnd, [schema.nodes.horizontal_rule.create(), para]);
      cursorAt(blockStart + 1);
      break;
    case "codeblock":
      tr = tr.setBlockType(blockStart, blockEnd, schema.nodes.code_block);
      break;
    case "ul":
      if (!wrapBlock(schema.nodes.bullet_list)) return false;
      break;
    case "ol":
      if (!wrapBlock(schema.nodes.ordered_list)) return false;
      break;
    case "task":
    case "task-done": {
      const checked = item.id === "task-done";
      const list = schema.nodes.task_list.create(
        null,
        schema.nodes.task_item.create({ checked }, listContent)
      );
      tr = tr.replaceWith(blockStart, blockEnd, list);
      break;
    }
    case "math":
      tr = tr.replaceWith(blockStart, blockEnd, schema.nodes.math_block.create());
      cursorAt(blockStart + 1);
      break;
    case "mermaid":
      tr = tr.replaceWith(
        blockStart,
        blockEnd,
        schema.nodes.mermaid_block.create(null, schema.text("graph TD\n    A --> B"))
      );
      cursorAt(blockStart + 1);
      break;
    case "table": {
      const cell = (header: boolean) =>
        schema.nodes[header ? "table_header" : "table_cell"].create();
      const row = (header: boolean) =>
        schema.nodes.table_row.create(null, [cell(header), cell(header)]);
      const table = schema.nodes.table.create(null, [
        schema.nodes.table_head.create(null, row(true)),
        schema.nodes.table_body.create(null, [row(false), row(false)]),
      ]);
      tr = tr.replaceWith(blockStart, blockEnd, [table, para]);
      cursorAt(blockStart + table.nodeSize + 1);
      break;
    }
    default:
      // bold/italic 等行内格式需要选中文本，PM slash 触发时为空选区，不适用
      return false;
  }

  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}
