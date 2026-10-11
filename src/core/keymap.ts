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
import { Plugin, TextSelection } from "prosemirror-state";
import { toggleMark, setBlockType, wrapIn, joinUp, lift, chainCommands, splitBlock } from "prosemirror-commands";
import { wrapInList, splitListItem, liftListItem, sinkListItem } from "prosemirror-schema-list";
import { keymap } from "prosemirror-keymap";
import { lightMDSchema } from "./schema";
import { matchShortcut } from "./shortcuts";
// E2(v0.9.2):Tab 三处缺失的补齐
import { tableTab, tableShiftTab } from "./tableNav";
import { codeBlockIndent, codeBlockOutdent } from "./plugins/code-indent";
// v0.12.1 需求6：代码块末尾按 → 退出代码块（落到块后的下一个块；末块则新建段落）
import { exitCodeBlockForward } from "./plugins/code-block-exit";
// v0.12.1 需求4：Tab 跳出配对（光标夹在配对符号之间时）
import { pairTabOut } from "./plugins/auto-pair";
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
 * v0.12.1 需求10 / v0.12.2 P3+F3+F4：**回车 = 段内换行**（顶层普通段落内）。
 *
 * 用户反馈："阅读模式编辑的文字没有隔行，切到编辑/分屏就出现了隔行" —— 根因是
 * 阅读模式里按回车走的是 baseKeymap 的 splitBlock（新建段落），序列化后端每行之间
 * 多出一个空行（`第一行\n\n第二行`）；而阅读模式视觉上只是普通行距，三模式观感不一致。
 *
 * 口径（已与用户确认）：**回车 = 段内换行（一个 hard_break，源码里两行相邻）**，
 * **Shift+回车 = 新建段落**（与旧的回车语义对调）。
 *
 * 作用域严格限定在**顶层普通段落**（depth === 1 且父节点是 paragraph）：
 * 列表项/任务项（回车必须继续分裂条目）、引用内段落、标题、表格单元格一律不接管，
 * 交回原有链（splitListItem / baseKeymap），语义零回归。
 *
 * ─── v0.12.2 修复三处缺陷 ───
 *
 * **F4（跨块选区合并段落）**：原实现没有空选区守卫，而 `replaceSelectionWith`
 * 会先删除整个选区 —— 选中跨两个段落的文字后按回车，两段被合并成一段。
 * 现补 `selection.empty` 守卫，非空选区交回 `splitBlock`（与 `insertHardBreak` 口径一致）。
 *
 * **F3（段末换行存盘丢失）**：段落**末尾**的 `hard_break` 在 Markdown 里
 * **无法表达**。实测（markdown-it，GFM 与 CommonMark 均同）：
 *   `"abc  \n\n"` → paragraph（**无 hardbreak token**）
 *   `"abc\\\n\n"` → paragraph（反斜杠同样无效，且反斜杠会被当字面文本）
 *   `"abc  \ndef\n"` → hardbreak（只有"后面还有内容"才能往返）
 * 即段末回车产生的换行存盘后必然静默丢失。现改为：光标已在段落末尾时返回 false，
 * 交回 baseKeymap 的 `splitBlock` 新建段落 —— 既不丢内容，也与"回车换行"的直觉一致。
 *
 * 综合效果：段中回车 = 段内换行（可往返）；段末回车 = 新建段落（可往返）。
 */
const insertSoftBreakOnEnter: Command = (state, dispatch) => {
  const { selection } = state;
  const { $from } = selection;
  if ($from.depth !== 1) return false;
  if ($from.parent.type.name !== "paragraph") return false;
  // F4：非空选区交回 splitBlock（replaceSelectionWith 会删除整个选区并合并块）
  if (!selection.empty) return false;
  // F3：段落末尾交回 splitBlock（段末 hard_break 无法在 Markdown 中表达，存盘必丢）
  if ($from.parentOffset === $from.parent.content.size) return false;
  if (!schema.nodes.hard_break) return false;
  if (dispatch) {
    // 空选区=光标处插入
    dispatch(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()));
  }
  return true;
};

/** 顶层普通段落（需求10 两种回车语义的适用面，判定与 insertSoftBreakOnEnter 同源） */
const inTopLevelParagraph = (state: EditorState): boolean => {
  const { $from } = state.selection;
  return $from.depth === 1 && $from.parent.type.name === "paragraph";
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
    if (dispatch) {
      const tr = state.tr.replaceSelectionWith(node, false);
      // v0.11.0 B3-7 返修：把光标**放进刚插入的公式节点内**。
      // 原实现只 replaceSelectionWith 就结束，选区落到节点之后（`$ $|`），
      // 与注释「光标落在公式内可直接输入」不符 —— 用户接着打字会输到公式**外**
      // 得到 `$ $x^2`。math_inline 非 atom（content 为 text*），可定位。
      const start = tr.selection.from - node.nodeSize;
      try {
        tr.setSelection(TextSelection.create(tr.doc, start + 1));
      } catch {
        /* 定位失败时保持 replaceSelectionWith 的默认选区 */
      }
      dispatch(tr);
    }
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
    // v0.12.1 需求10：**顶层普通段落**里回车 = 段内换行（不再新建段落，源码不出现空行）。
    // 必须排在列表分裂之前：列表项内的段落 depth ≥ 3，本命令自动放行 → 仍走 splitListItem。
    Enter: chainCommands(
      insertSoftBreakOnEnter,
      splitListItem(schema.nodes.task_item),
      splitListItem(schema.nodes.list_item),
    ),

    // 段内硬换行（Shift+Enter）
    // v0.11.0 B1-1：包一层 IME 守卫——中文输入法候选确认过程中（view.composing）
    // 若触发 Shift+Enter，不得执行命令。理由与 auto-pair.ts 的 Backspace 守卫一致：
    // 不加此守卫时，候选确认会被误判为命令按键，进而在代码块内触发破坏性拆块。
    // v0.12.1 需求10：与回车**对调**——顶层普通段落里 Shift+回车 = 新建段落，
    // 其余位置（列表项内 / 引用内 / 标题内）保持原有的段内硬换行语义。
    "Shift-Enter": (state, dispatch, view) => {
      if (view?.composing) return false;
      if (inTopLevelParagraph(state)) return splitBlock(state, dispatch);
      return insertHardBreak(state, dispatch);
    },

    // v0.12.1 需求6：代码块/公式块末尾按 → 退出本块（落到下一个块；已是末块则新建空段落）。
    // 不在块末尾 / 非顶层块 / 非空选区时返回 false，交回浏览器默认的光标移动。
    ArrowRight: exitCodeBlockForward,

    // Tab 缩进(E2:v0.9.2 补齐三处缺失——表格导航 > 代码块缩进 > 任务项/列表项嵌套)
    // v0.12.1 需求4：**最优先**判断「Tab 跳出配对」——光标夹在 ()/"" 之间时
    // 跳到闭符号右侧（VS Code/CodeMirror 同款习惯）；不在配对中则回落原有链。
    // chainCommands 顺序即优先级;各命令在不适用的上下文返回 false,
    // 全部不适用(普通段落)时交回浏览器默认行为,与既有行为一致
    Tab: chainCommands(
      pairTabOut,
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
