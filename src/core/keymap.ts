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
import { Plugin, TextSelection, NodeSelection } from "prosemirror-state";
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
// v0.13.0 需求6：选区多行批量注释（Ctrl+/）
import { toggleComment } from "./toggleComment";
// v0.13.0 需求1：块级复制/剪切（NodeSelection 态下的快捷键拦截）
import { copySelectedBlock, cutSelectedBlock } from "../utils/blockClipboardOps";
import { notify } from "../services/notificationService";
import { t } from "../i18n/state";

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
 * v0.12.3 需求12：**阅读模式回车 = 换行（与源文本一一对应）**。
 *
 * ─── 缺陷背景（用户反馈） ───
 *
 * ① **凭空多空行**：阅读模式里按回车走 baseKeymap 的 `splitBlock`（新建段落），
 *    而 Markdown 的段落之间必须有空行 —— 用户只按了一次回车，切到编辑/分屏模式
 *    却看到 `第一行\n\n第二行`（多出一个空行），三模式观感不一致。
 * ② **行距忽大**：新建段落带 `.ProseMirror > p` 的 `0.8em` 上下 margin，段间间距
 *    比段内换行（仅 line-height）明显更大 —— 用户反馈"阅读模式编辑文字行间距很高，
 *    和打开的其他文档不一样"。
 *
 * 两个现象同源：**回车被解释成了"段落"而不是"换行"**。
 *
 * ─── 口径 ───
 *
 * 阅读模式按一次回车 = 源文本里多一个换行，与纯文本编辑器直觉一致：
 *   · 光标在**行内**（前有内容）→ 插入 `hard_break`（段内换行，源码 `"  \n"`）；
 *   · 光标已在**行首**（段首，或紧跟在段内换行之后）→ 兑现为**段落**（源码空行），
 *     即"再按一次回车才另起一段"。
 *
 * 于是 N 次回车恰好得到 N 个换行（1 → 相邻两行；2 → 中间一个空行；3 → 两个空行），
 * 与用户"阅读模式下有几个回车换行，编辑/分屏模式就对应几个"的要求一致。
 *
 * ─── 作用域与守卫 ───
 *
 * · **顶层普通段落**（`depth === 1` 且父节点是 paragraph）：列表项/任务项（回车必须
 *   继续分裂条目）、引用内段落、标题、表格单元格一律不接管，交回原有链
 *   （`splitListItem` / baseKeymap），语义零回归。
 * · **空选区守卫**：`replaceSelectionWith` 会先删除整个选区 —— 跨块选区按回车会把
 *   两段合并成一段（v0.12.2 P4 修过同类缺陷），非空选区一律交回 `splitBlock`。
 * · **IME 守卫**：中文输入法候选确认期间（`view.composing`）不接管，
 *   与 `insertHardBreak` / auto-pair 的 Backspace 守卫同口径。
 * · **行首兑现段落时先撤掉上一个硬换行**：Markdown 无法表达"段末硬换行"
 *   （行尾两空格会被解析器吞掉），留着会往返丢失，故删除后再分割块。
 */
const insertSoftBreakOnEnter: Command = (state, dispatch, view) => {
  const { selection } = state;
  const { $from } = selection;
  if (!selection.empty) return false;
  if ($from.depth !== 1) return false;
  if ($from.parent.type.name !== "paragraph") return false;
  if (!schema.nodes.hard_break) return false;
  if (view?.composing) return false;

  // 段首：不接管，交回 baseKeymap 的 splitBlock（与既有"段首回车另起一段"一致）
  if ($from.parentOffset === 0) return false;

  const before = $from.nodeBefore;
  if (before && before.type === schema.nodes.hard_break) {
    // 行首（上一次回车刚插入的段内换行）：这次回车兑现为段落。
    // 先撤掉那个硬换行（Markdown 无法表达"段末硬换行"，留着会往返丢失），
    // 再在同一位置分割块 —— **必须放在同一个事务里**：
    // 两次 dispatch 会各自基于旧 state 派生 tr，第二个 tr 与 view.state 不匹配
    // （实测抛 `RangeError: Applying a mismatched transaction`）。
    if (dispatch) {
      const breakFrom = $from.pos - before.nodeSize;
      const tr = state.tr.delete(breakFrom, $from.pos);
      const splitAt = tr.mapping.map(breakFrom);
      tr.split(splitAt);
      tr.setSelection(TextSelection.near(tr.doc.resolve(splitAt + 1)));
      dispatch(tr.scrollIntoView());
    }
    return true;
  }

  if (dispatch) {
    dispatch(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()));
  }
  return true;
};

/**
 * 顶层普通段落（v0.12.3 需求12 两种回车语义的作用面，判定与 insertSoftBreakOnEnter 同源）。
 */
const inTopLevelParagraph = (state: EditorState): boolean => {
  const { $from } = state.selection;
  return $from.depth === 1 && $from.parent.type.name === "paragraph";
};

/**
 * v0.13.1 需求3：光标是否位于某个表格单元格（table_cell / table_header）内。
 *
 * 只看**祖先链上的节点类型**，与 auto-pair.ts 的 inDisabledNode 同口径
 * （不依赖 view —— Command 签名只有 state/dispatch）。
 */
const inTableCell = (state: EditorState): boolean => {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name;
    if (name === "table_cell" || name === "table_header") return true;
  }
  return false;
};

/**
 * v0.13.1 需求3：光标是否**恰好贴在单元格内容的边界**上。
 *
 * @param atStart true = 左边界（Backspace）；false = 右边界（Delete）
 */
const atCellContentBoundary = (state: EditorState, atStart: boolean): boolean => {
  const { selection } = state;
  // 非空选区一律放行：选区删除（deleteSelection）本来就是"只影响本格"，
  // 且 Shift+Backspace / 成对删除等语义都依赖它。
  if (!selection.empty) return false;
  if (!inTableCell(state)) return false;
  const { $from } = selection;
  const boundary = atStart ? 0 : $from.parent.content.size;
  return $from.parentOffset === boundary;
};

/**
 * v0.13.1 需求3：**Backspace / Delete 不得跨越表格单元格边界**。
 *
 * ─── 缺陷背景（用户实测）───
 *
 * `buildKeymap()` 此前只登记 Enter/Shift-Enter/Tab/ArrowRight/Alt-arrows，
 * 没有 Backspace/Delete，于是表格单元格里的退格落到 `keymap(baseKeymap)`
 * （editor.ts 中注册在本 keymap **之后**，故本 keymap 优先）：
 * `backspace = chainCommands(deleteSelection, joinBackward, selectNodeBackward)`，
 * 而 `joinBackward → deleteBarrier` 的 `isolated` 只看两个**相邻**节点的
 * `spec.isolating`——table_cell/table_header 都没有 isolating，
 * 于是光标在格首按退格会**把右邻格与本格合并**：
 *
 *   实测（真实 createEditor 挂载，`| A | B |` / `| 1 | 2 |`）：
 *   光标置入 `1` 的格首按一次 Backspace →
 *   doc 的 cell 数由 4 掉到 3、内容变成 `12`（右邻格的 `2` 被"吸"进本格），
 *   光标同时左移。用户感知为"退格把右边的字吞进来了 / 表格塌了一格"。
 *
 * ─── 修复口径 ───
 *
 * 在**内容边界**上直接吞掉按键（返回 true = 阻止默认行为，但**不派发事务**）：
 * 不合并单元格、不删除任何节点、不移动光标 —— 与浏览器原生 contenteditable
 * 里"单元格首/尾退格什么都不发生"的直觉一致。
 *
 * 非边界位置（`$from.parentOffset > 0` / `< content.size`）返回 false，
 * 交回 baseKeymap / 浏览器原生删除，**逐字符删除能力零损失**。
 *
 * 同一个守卫也登记给 `Mod-Backspace` / `Mod-Delete`（Ctrl/Cmd + 删除词），
 * 否则"按词删除"仍会跨格合并。**不登记 Shift-Backspace**：它必须保持
 * "删除选区 / 普通退格"的原生语义（见基线表第九节保留键位）。
 *
 * @param atStart true = Backspace（左边界）；false = Delete（右边界）
 */
const swallowAtCellBoundary = (atStart: boolean): Command => (state) =>
  atCellContentBoundary(state, atStart);

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
  // v0.13.0 需求6：批量注释 Ctrl+/（comment mark，序列化为 <!--text-->）。
  // 注册在动态表而非静态 keymap：用户改键后仍生效（静态键位不支持自定义）。
  "format.comment": toggleComment,

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

/**
 * v0.13.0 需求1：块级剪贴板快捷键拦截。
 *
 * 仅在**当前是 NodeSelection（整块选中）**时拦截 `Ctrl+C` / `Ctrl+X`：
 * 文本选区一律放行浏览器默认行为（否则会与普通复制打架）。
 *
 * `Ctrl+C`/`Ctrl+X` 在 `shortcuts.ts` 的「保留键位不可自定义」清单里，
 * 所以此处不新增快捷键条目，只在 PM 侧加一层拦截。
 *
 * 放在动态快捷键插件**之前**注册（越靠前优先级越高），保证 NodeSelection 态下
 * 一定走块级语义。
 */
function blockClipboardPlugin(): Plugin {
  return new Plugin({
    props: {
      handleKeyDown(view, event) {
        // 仅 NodeSelection 才走块级语义
        if (!(view.state.selection instanceof NodeSelection)) return false;
        const mod = event.ctrlKey || event.metaKey;
        if (!mod || event.altKey || event.shiftKey) return false;
        const key = event.key.toLowerCase();
        if (key !== "c" && key !== "x") return false;
        event.preventDefault();
        void (key === "c" ? copySelectedBlock(view) : cutSelectedBlock(view)).then((ok) => {
          if (!ok) notify(t("blockMenu.clipboardFailed"), "warning");
        });
        return true;
      },
    },
  });
}

export function buildKeymap() {
  return keymap({
    // v0.13.1 需求3：Backspace / Delete **在单元格内容边界上**被吞掉，
    // 绝不跨越 cell 边界（否则 baseKeymap 的 joinBackward 会把相邻两格并成一格）。
    // 非边界位置返回 false → 交回 baseKeymap / 浏览器原生，逐字符删除不受影响。
    // 必须登记在 baseKeymap 之前（editor.ts 的插件顺序已保证）。
    Backspace: swallowAtCellBoundary(true),
    "Mod-Backspace": swallowAtCellBoundary(true),
    Delete: swallowAtCellBoundary(false),
    "Mod-Delete": swallowAtCellBoundary(false),
    // 列表项 / 任务项 Enter 分割（v0.8.0 修复 P11-6）
    // 说明：本 keymap 必须在 baseKeymap **之前**注册（见 editor.ts 插件顺序），
    // 否则 Enter 会命中 baseKeymap 的 splitBlock，在同一列表项内新建段落，
    // 序列化时被合并成一行 → 模式切换后换行丢失。
    // chainCommands：两个命令互斥（各自在不适用的上下文返回 false），
    // 都不适用时返回 false，交回 baseKeymap 的 splitBlock 处理普通段落。
    // v0.12.3 需求12：**顶层普通段落**里回车 = 换行（不再凭空新建段落，源码不出现多余空行）。
    // 必须排在列表分裂之前：列表项内的段落 depth ≥ 2，本命令自动放行 → 仍走 splitListItem。
    Enter: chainCommands(
      insertSoftBreakOnEnter,
      splitListItem(schema.nodes.task_item),
      splitListItem(schema.nodes.list_item),
    ),

    // Shift+Enter：段内硬换行（列表/引用/标题/表格内语义不变）
    // v0.11.0 B1-1：包一层 IME 守卫——中文输入法候选确认过程中（view.composing）
    // 若触发 Shift+Enter，不得执行命令。理由与 auto-pair.ts 的 Backspace 守卫一致：
    // 不加此守卫时，候选确认会被误判为命令按键，进而在代码块内触发破坏性拆块。
    // v0.12.3 需求12：与回车**对调**——顶层普通段落里 Shift+回车 = 新建段落，
    // 保证"另起一段（源码空行）"始终有一个一次按键的入口；其余位置保持原有硬换行语义。
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

export { dynamicShortcutsPlugin, blockClipboardPlugin };
