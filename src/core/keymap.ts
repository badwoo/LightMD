/**
 * 自定义键盘映射
 */
import { undo, redo } from "prosemirror-history";
import type { Command } from "prosemirror-state";
import { toggleMark, setBlockType, wrapIn, joinUp, lift, chainCommands } from "prosemirror-commands";
import { wrapInList, splitListItem, liftListItem, sinkListItem } from "prosemirror-schema-list";
import { keymap } from "prosemirror-keymap";
import { lightMDSchema } from "./schema";

const schema = lightMDSchema;

/**
 * v0.8.0 修复 P11-6：Shift+Enter 插入段内硬换行（对应 Markdown 的"两空格 + 换行"）。
 *
 * 背景：用户"在阅读模式下每行末尾回车换行"，若用 Shift+Enter 表达段内换行，
 * 此前没有对应命令、行为不确定。这里显式支持，且与 serializer 的 hard_break ↔ "  \n"
 * 互逆，模式切换往返稳定。
 * 防护：光标前紧邻硬换行时不再插入，避免出现连续硬换行（CommonMark 中没有意义）。
 */
const insertHardBreak: Command = (state, dispatch) => {
  if (!schema.nodes.hard_break) return false;
  const { selection } = state;
  if (!selection.empty) return false;
  const before = selection.$from.nodeBefore;
  if (before && before.type === schema.nodes.hard_break) return false;
  if (dispatch) {
    dispatch(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()));
  }
  return true;
};

const mac = typeof navigator !== "undefined" ? /Mac/.test(navigator.platform) : false;

export function buildKeymap() {
  return keymap({
    "Mod-z": undo,
    "Shift-Mod-z": redo,
    ...(mac ? { "Mod-y": redo } : { "Ctrl-y": redo }),

    "Mod-b": toggleMark(schema.marks.strong),
    "Mod-i": toggleMark(schema.marks.em),
    "Mod-`": toggleMark(schema.marks.code),
    // 删除线：Mod+Shift+S（参考 toggleBold/toggleItalic 实现）
    "Shift-Mod-s": toggleMark(schema.marks.strike),

    "Mod-1": setBlockType(schema.nodes.heading, { level: 1 }),
    "Mod-2": setBlockType(schema.nodes.heading, { level: 2 }),
    "Mod-3": setBlockType(schema.nodes.heading, { level: 3 }),
    "Mod-4": setBlockType(schema.nodes.heading, { level: 4 }),
    "Mod-5": setBlockType(schema.nodes.heading, { level: 5 }),
    "Mod-6": setBlockType(schema.nodes.heading, { level: 6 }),
    "Mod-0": setBlockType(schema.nodes.paragraph),

    "Shift-Mod-8": wrapInList(schema.nodes.bullet_list),
    "Shift-Mod-9": wrapInList(schema.nodes.ordered_list),
    "Shift-Mod-.": wrapIn(schema.nodes.blockquote),

    // 列表项 / 任务项 Enter 分割（v0.8.0 修复 P11-6）
    // 说明：本 keymap 必须在 baseKeymap **之前**注册（见 editor.ts 插件顺序），
    // 否则 Enter 会命中 baseKeymap 的 splitBlock，在同一列表项内新建段落，
    // 序列化时被合并成一行 → 模式切换后换行丢失。
    // chainCommands：两个命令互斥（各自在不适用的上下文返回 false），
    // 都不适用时返回 false，交回 baseKeymap 的 splitBlock 处理普通段落。
    Enter: chainCommands(
      splitListItem(schema.nodes.task_item),
      splitListItem(schema.nodes.list_item),
    ),

    // 段内硬换行（Shift+Enter）
    "Shift-Enter": insertHardBreak,

    // Tab 缩进列表项
    Tab: sinkListItem(schema.nodes.list_item),
    "Shift-Tab": liftListItem(schema.nodes.list_item),

    // Alt+上/下 移动块
    "Alt-ArrowUp": joinUp,
    "Alt-ArrowDown": lift,
  });
}
