/**
 * 自定义键盘映射
 *
 * v0.9.0 自定义快捷键改造：
 * - **可自定义键**（undo/redo/格式类）迁入 `dynamicShortcutsPlugin`——每次 keydown
 *   读 core/shortcuts.ts 生效表（默认 + 用户覆盖），改键即时生效、无需重建 EditorView；
 * - **行为键**（Enter 列表分割、Shift+Enter 硬换行、Tab 缩进、Alt+↑↓ 移动块）保留静态
 *   keymap，不纳入自定义范围（见基线表第九节）；
 * - 删除线已按 D1 拍板统一为 Ctrl+Alt+S（原富文本 Ctrl+Shift+S 废弃，避开「另存为」）。
 */
import { undo, redo } from "prosemirror-history";
import type { Command } from "prosemirror-state";
import { Plugin } from "prosemirror-state";
import { toggleMark, setBlockType, wrapIn, joinUp, lift, chainCommands } from "prosemirror-commands";
import { wrapInList, splitListItem, liftListItem, sinkListItem } from "prosemirror-schema-list";
import { keymap } from "prosemirror-keymap";
import { lightMDSchema } from "./schema";
import { matchShortcut } from "./shortcuts";
// E2(v0.9.2):Tab 三处缺失的补齐
import { tableTab, tableShiftTab } from "./tableNav";
import { codeBlockIndent, codeBlockOutdent } from "./plugins/code-indent";

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

/**
 * 可自定义键 → ProseMirror 命令映射（id 对齐 core/shortcuts.ts SHORTCUT_DEFS）。
 * undo/redo 属 global-editor 作用域：PM 内由此表接管（用户改键后旧 Ctrl+Z 不再触发，
 * 因静态 keymap 不再登记 history 键）。
 */
const PM_COMMAND_BY_ID: Record<string, Command> = {
  "edit.undo": undo,
  "edit.redo": redo,
  "edit.redo2": redo,

  "format.bold": toggleMark(schema.marks.strong),
  "format.italic": toggleMark(schema.marks.em),
  "format.inlineCode": toggleMark(schema.marks.code),
  "format.strikethrough": toggleMark(schema.marks.strike),
  // E1(v0.9.2):高亮 ==text==(此前仅源码模式有语法串,阅读模式命令无归属)
  "format.highlight": toggleMark(schema.marks.mark),

  "format.heading1": setBlockType(schema.nodes.heading, { level: 1 }),
  "format.heading2": setBlockType(schema.nodes.heading, { level: 2 }),
  "format.heading3": setBlockType(schema.nodes.heading, { level: 3 }),
  "format.heading4": setBlockType(schema.nodes.heading, { level: 4 }),
  "format.heading5": setBlockType(schema.nodes.heading, { level: 5 }),
  "format.heading6": setBlockType(schema.nodes.heading, { level: 6 }),
  "format.paragraph": setBlockType(schema.nodes.paragraph),

  "format.bulletList": wrapInList(schema.nodes.bullet_list),
  "format.orderedList": wrapInList(schema.nodes.ordered_list),
  "format.blockquote": wrapIn(schema.nodes.blockquote),
};

/**
 * E1(v0.9.2):查询 id 对应的 PM 命令。
 * 动态快捷键(direct keydown)与阅读模式命令路由(App.tsx lightmd:command)
 * 共用同一命令源,保证两条路径行为一致(修复"假命令"问题)。
 */
export function getPMCommand(id: string): Command | undefined {
  return PM_COMMAND_BY_ID[id];
}

/**
 * v0.9.0：动态快捷键插件（必须注册在静态 keymap **之前**）。
 * 每次 keydown 读生效键位表做完全相等匹配，命中即执行对应 PM 命令；
 * 未命中返回 false 交回静态 keymap / baseKeymap（Enter、Tab 等行为键）。
 */
function dynamicShortcutsPlugin(): Plugin {
  return new Plugin({
    props: {
      handleKeyDown(view, event) {
        const def = matchShortcut(event, ["editor", "rich"]);
        if (!def) return false;
        const cmd = PM_COMMAND_BY_ID[def.id];
        if (!cmd) return false;
        return cmd(view.state, view.dispatch, view);
      },
    },
  });
}

export function buildKeymap() {
  return keymap({
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

    // Tab 缩进(E2:v0.9.2 补齐三处缺失——表格导航 > 代码块缩进 > 任务项/列表项嵌套)
    // chainCommands 顺序即优先级;各命令在不适用的上下文返回 false,
    // 全部不适用(普通段落)时交回浏览器默认行为,与既有行为一致
    Tab: chainCommands(
      tableTab,
      codeBlockIndent,
      sinkListItem(schema.nodes.task_item),
      sinkListItem(schema.nodes.list_item),
    ),
    "Shift-Tab": chainCommands(
      tableShiftTab,
      codeBlockOutdent,
      liftListItem(schema.nodes.task_item),
      liftListItem(schema.nodes.list_item),
    ),

    // Alt+上/下 移动块
    "Alt-ArrowUp": joinUp,
    "Alt-ArrowDown": lift,
  });
}

export { dynamicShortcutsPlugin };
