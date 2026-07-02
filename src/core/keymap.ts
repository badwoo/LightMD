/**
 * 自定义键盘映射
 */
import { undo, redo } from "prosemirror-history";
import { toggleMark, setBlockType, wrapIn, joinUp, lift } from "prosemirror-commands";
import { wrapInList, splitListItem, liftListItem, sinkListItem } from "prosemirror-schema-list";
import { keymap } from "prosemirror-keymap";
import { lightMDSchema } from "./schema";

const schema = lightMDSchema;

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

    // 列表项 Enter 分割
    Enter: splitListItem(schema.nodes.list_item),

    // Tab 缩进列表项
    Tab: sinkListItem(schema.nodes.list_item),
    "Shift-Tab": liftListItem(schema.nodes.list_item),

    // Alt+上/下 移动块
    "Alt-ArrowUp": joinUp,
    "Alt-ArrowDown": lift,
  });
}
