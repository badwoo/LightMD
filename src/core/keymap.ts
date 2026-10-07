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
import type { Command, EditorState } from "prosemirror-state";
import { Plugin } from "prosemirror-state";
import { toggleMark, setBlockType, wrapIn, joinUp, lift, chainCommands } from "prosemirror-commands";
import { wrapInList, splitListItem, liftListItem, sinkListItem } from "prosemirror-schema-list";
import { keymap } from "prosemirror-keymap";
import { lightMDSchema } from "./schema";
import { matchShortcut } from "./shortcuts";
// E2(v0.9.2):Tab 三处缺失的补齐
import { tableTab, tableShiftTab } from "./tableNav";
import { codeBlockIndent, codeBlockOutdent } from "./plugins/code-indent";
// v0.11.0 B3-8：真正的块移动（Alt+↑/↓）
import { moveBlockUp, moveBlockDown } from "./blockMove";

const schema = lightMDSchema;

/**
 * v0.8.0 修复 P11-6：Shift+Enter 插入段内硬换行（对应 Markdown 的"两空格 + 换行"）。
 *
 * v0.11.0 B1-1（P0 修复）：**必须排除 `code: true` 的文本块**。
 *
 * 缺陷：原实现只判 selection.empty 与「前节点是否为 hard_break」，未考虑块类型。
 * code_block / math_block 的 content 是 `text*`（schema.ts），容不下 hard_break 节点，
 * ProseMirror 只能拆块 → 代码块被腰斩、剩余内容降级为 paragraph 并写回磁盘
 * （实测存盘变成 "```js\nconst a = 1\n```\n\n  \n\nconst b = 2\n"，语法高亮失效）。
 *
 * 修复：新增 inCodeLikeBlock 守卫，在代码/公式块内返回 false 交回默认键盘处理。
 * 由于 code_block 的 content 是 text*，**原生回车本就能正常换行**，
 * 阻止 hard_break 不损失任何能力。守卫逻辑与 auto-pair.ts 的 inDisabledNode 一致，
 * 但不依赖 view（Command 签名只有 state/dispatch），故独立实现而非复用。
 */
const inCodeLikeBlock = (state: EditorState): boolean => {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name;
    if (name === "code_block" || name === "math_block" || name === "code_inline") {
      return true;
    }
  }
  return false;
};

const insertHardBreak: Command = (state, dispatch) => {
  if (!schema.nodes.hard_break) return false;
  const { selection } = state;
  if (!selection.empty) return false;
  // v0.11.0 B1-1：代码块/公式块内不得插入 hard_break（会拆块并损坏文档）
  if (inCodeLikeBlock(state)) return false;
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
  // E8(v0.9.3):下划线 Ctrl+U(与 format.underline 快捷键条目同源)
  "format.underline": toggleMark(schema.marks.underline),

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

  // v0.11.0 B3-7：插入行内公式（此前本表无此条目 → 阅读模式 Ctrl+Shift+M 是死键）。
  // 构造与 inputrules 的 mathInlineRule 同款：单个 math_inline 节点，
  // 内容为占位空格随后清空，光标落在公式内可直接输入 LaTeX。
  "format.math": (state, dispatch) => {
    const node = schema.nodes.math_inline.create({ latex: "" }, schema.text(" "));
    if (dispatch) dispatch(state.tr.replaceSelectionWith(node, false));
    return true;
  },
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
    // v0.11.0 B1-1：包一层 IME 守卫——中文输入法候选确认过程中（view.composing）
    // 若触发 Shift+Enter，不得执行命令。理由与 auto-pair.ts 的 Backspace 守卫一致：
    // 不加此守卫时，候选确认会被误判为命令按键，进而在代码块内触发破坏性拆块。
    "Shift-Enter": (state, dispatch, view) => {
      if (view?.composing) return false;
      return insertHardBreak(state, dispatch);
    },

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

    // v0.11.0 B3-8：Alt+↑/↓ 由 joinUp/lift 改为**真正的块移动**。
    // 缺陷背景（P1）：原绑到 joinUp（与上块合并）/ lift（提升层级），
    // 与 UI 宣称的「移动块」语义完全不符 —— 用户按 Alt+↑ 期望块上移一格，
    // 实际却是把内容与上方块拼到一起，属误导性半成品。
    // 原合并/提升能力**移到 Alt+Shift+↑/↓**，避免功能丢失。
    "Alt-ArrowUp": moveBlockUp,
    "Alt-ArrowDown": moveBlockDown,
    "Alt-Shift-ArrowUp": joinUp,
    "Alt-Shift-ArrowDown": lift,
  });
}

export { dynamicShortcutsPlugin };
