/**
 * v0.12.1 需求6：代码块末尾按 → 退出代码块
 *
 * 缺陷（用户报告 + 真机复现）：
 *   阅读模式下点一下代码块（块级选中）或把光标放到最后一行末尾后按 →，ProseMirror 的
 *   默认行为只会把**浏览器光标**留在代码块内容末端（真机实测：DOM 选区停在
 *   `code[contenteditable]` 的末尾、甚至落进高亮覆盖层的 <span> 里），连按多次都走不出去，
 *   既无法在块后继续输入，看起来又像"换了一行"。文档最后一个块是代码块时更明显。
 *
 * 期望（已与用户确认）：按 → 应该**退出代码块**，光标落到块后面的下一个块；
 *   若代码块已是文档最后一个块，则自动在它下面新建一个空段落并把光标放进去。
 *
 * 接管条件（其余一律返回 false，交回浏览器默认的光标移动）：
 *   ① 代码块/公式块被**整块选中**（NodeSelection）——阅读模式单击块的默认结果；
 *   ② 空选区且光标已在块内容**末尾**（parentOffset === content.size）。
 *   · 仅**顶层块**（depth === 1）：嵌在引用/列表里的块退出语义不同，交回默认；
 *   · 只认 code_block / math_block（两者 content 均为 `text*`，存在同一"末尾走不出去"的问题）。
 */
import type { Command, EditorState, Transaction } from "prosemirror-state";
import { NodeSelection, TextSelection } from "prosemirror-state";

/** 参与"末尾退出"的块类型（内容为纯文本行、无内置退出路径） */
const EXITABLE_BLOCKS = new Set(["code_block", "math_block"]);

/**
 * 把光标移到 blockStart 所指数块的**后面**：
 * 有下一个块 → 落到它内部最近的可编辑文本位置；已是最后一个块 → 新建空段落。
 * 两类入口（整块选中 / 光标在末尾）复用同一段逻辑。
 */
function exitAfterBlock(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  blockStart: number,
): boolean {
  const block = state.doc.nodeAt(blockStart);
  if (!block || !EXITABLE_BLOCKS.has(block.type.name)) return false;
  const blockEnd = blockStart + block.nodeSize; // 块之后的边界位置

  if (dispatch) {
    const tr = state.tr;
    if (blockEnd < state.doc.content.size) {
      // 有下一个块：光标进入它内部最近的可编辑文本位置
      const $after = tr.doc.resolve(blockEnd);
      tr.setSelection(TextSelection.near($after, 1));
    } else {
      // 已是最后一个块：新建空段落并落光标（一次事务，可整体撤销）
      tr.insert(blockEnd, state.schema.nodes.paragraph.create());
      tr.setSelection(TextSelection.create(tr.doc, blockEnd + 1));
    }
    tr.scrollIntoView();
    dispatch(tr);
  }
  return true;
}

export const exitCodeBlockForward: Command = (state, dispatch) => {
  const { selection } = state;

  // ① 整块选中（阅读模式单击代码块的默认结果）→ 直接退到块后面。
  //    这是用户"点一下代码块、按 → 想在下面接着打字"最自然的预期。
  if (selection instanceof NodeSelection) {
    if (!EXITABLE_BLOCKS.has(selection.node.type.name)) return false;
    return exitAfterBlock(state, dispatch, selection.from);
  }

  // ② 空选区且光标已在块内容末尾
  if (!selection.empty) return false;
  const { $from } = selection;
  const parent = $from.parent;
  if (!EXITABLE_BLOCKS.has(parent.type.name)) return false;
  if ($from.parentOffset !== parent.content.size) return false;
  // 仅顶层块：嵌套场景（引用/列表内）退出语义不同，交回默认
  if ($from.depth !== 1) return false;

  return exitAfterBlock(state, dispatch, $from.before(1));
};
