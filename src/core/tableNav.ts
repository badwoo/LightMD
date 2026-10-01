/**
 * tableNav —— E2(v0.9.2):表格 Tab 逐格导航
 *
 * 此前表格无 Tab/Shift+Tab 处理,按键落到浏览器默认行为导致焦点移出编辑器。
 * 这里实现 Typora/Excel 风格导航:
 * - Tab:行内下一格 → 行末跳下一行首格 → 末行末格时在末尾追加一行并落入新行首格
 * - Shift+Tab:反向;首行首格时保持不动(吞掉事件,防止焦点移出编辑器)
 *
 * 依赖 table-editor.ts 的 insertRowBelow(末格追加行复用同一插入逻辑),
 * 纯函数 nextCellPos 独立于 DOM,便于单元测试。
 */
import { Command, EditorState, TextSelection } from "prosemirror-state";
import type { Node } from "prosemirror-model";
import { insertRowBelow, isInHead, rowAround, tableAround } from "./plugins/table-editor";

/** 收集 table 中所有 row(thead 行在前)及其绝对位置(与 table-editor 内部逻辑一致) */
function collectRows(table: Node, tablePos: number): Array<{ pos: number; node: Node }> {
  const rows: Array<{ pos: number; node: Node }> = [];
  let sectionPos = tablePos + 1;
  table.forEach((section) => {
    if (section.type.name === "table_head" || section.type.name === "table_body") {
      let rowPos = sectionPos + 1;
      section.forEach((row) => {
        rows.push({ pos: rowPos, node: row });
        rowPos += row.nodeSize;
      });
    }
    sectionPos += section.nodeSize;
  });
  return rows;
}

/** 光标是否位于表格 cell(table_cell/table_header)内 */
export function inTableCell(state: EditorState): boolean {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name;
    if (name === "table_cell" || name === "table_header") return true;
  }
  return false;
}

/**
 * 计算相邻 cell 的光标位置(纯函数)。
 * dir=1:行内下一格 → 下一行首格;末行末格返回 null(由 tableTab 追加行)。
 * dir=-1:行内上一格 → 上一行末格;首行首格返回 null。
 * 不在 cell 内时返回 null。
 */
export function nextCellPos(state: EditorState, dir: 1 | -1): number | null {
  const { $from } = state.selection;
  let cellDepth = -1;
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name;
    if (name === "table_cell" || name === "table_header") {
      cellDepth = d;
      break;
    }
  }
  if (cellDepth < 0) return null;
  const rowDepth = cellDepth - 1;
  const row = $from.node(rowDepth);
  if (row.type.name !== "table_row") return null;
  const cellPos = $from.before(cellDepth);
  const rowPos = $from.before(rowDepth);

  // 当前 cell 在行内索引
  let idx = -1;
  let p = rowPos + 1;
  for (let i = 0; i < row.childCount; i++) {
    if (p === cellPos) {
      idx = i;
      break;
    }
    p += row.child(i).nodeSize;
  }
  if (idx < 0) return null;

  // 定位 table 及全部行
  let tableDepth = -1;
  for (let d = rowDepth - 1; d > 0; d--) {
    if ($from.node(d).type.name === "table") {
      tableDepth = d;
      break;
    }
  }
  if (tableDepth < 0) return null;
  const tablePos = $from.before(tableDepth);
  const rows = collectRows($from.node(tableDepth), tablePos);
  const rowIdx = rows.findIndex((r) => r.pos === rowPos);
  if (rowIdx < 0) return null;

  if (dir === 1) {
    if (idx < row.childCount - 1) {
      // 行内下一格:cell 起点 + 1(内容起点)
      let cp = rowPos + 1;
      for (let i = 0; i <= idx; i++) cp += row.child(i).nodeSize;
      return cp + 1;
    }
    const nextRow = rows[rowIdx + 1];
    if (!nextRow) return null;
    // 下一行首格内容起点:row 开(1) + 首 cell 开(1)
    return nextRow.pos + 2;
  }

  // dir === -1
  if (idx > 0) {
    let cp = rowPos + 1;
    for (let i = 0; i < idx - 1; i++) cp += row.child(i).nodeSize;
    return cp + 1;
  }
  const prevRow = rows[rowIdx - 1];
  if (!prevRow) return null;
  // 上一行末格内容起点:row 起点 + rowSize - 末cell size
  const lastCell = prevRow.node.lastChild;
  if (!lastCell) return null;
  return prevRow.pos + prevRow.node.nodeSize - lastCell.nodeSize;
}

/** 表格内 Tab:逐格前进,末行末格追加新行 */
export const tableTab: Command = (state, dispatch) => {
  if (!inTableCell(state)) return false;
  const next = nextCellPos(state, 1);
  if (next !== null) {
    if (dispatch) {
      dispatch(
        state.tr
          .setSelection(TextSelection.create(state.doc, Math.min(next, state.doc.content.size)))
          .scrollIntoView()
      );
    }
    return true;
  }

  // 末行末格:在末尾追加一行,光标落入新行首格(与 insertRowBelow 共用插入逻辑)
  const { $from } = state.selection;
  const rowInfo = rowAround($from);
  const tableInfo = tableAround($from);
  if (!rowInfo || !tableInfo) return false;
  // 计算插入点(与 insertRowBelow 的插入位置一致,插入点之前无内容变化,前后坐标相同)
  let insertPos: number;
  if (isInHead($from)) {
    const head = tableInfo.node.firstChild;
    const body = tableInfo.node.maybeChild(1);
    if (!head || head.type.name !== "table_head" || !body || body.type.name !== "table_body") {
      return false;
    }
    insertPos = tableInfo.pos + 1 + head.nodeSize + 1;
  } else {
    insertPos = rowInfo.pos + rowInfo.node.nodeSize;
  }
  const tr = insertRowBelow(state.tr, $from);
  if (!tr) return false;
  if (dispatch) {
    // 新行内容起点 = row 开(1) + 首 cell 开(1);near 兜底落合法文本位
    const $target = tr.doc.resolve(Math.min(insertPos + 2, tr.doc.content.size));
    dispatch(tr.setSelection(TextSelection.near($target)).scrollIntoView());
  }
  return true;
};

/** 表格内 Shift+Tab:逐格后退;首行首格保持不动(吞事件防焦点移出) */
export const tableShiftTab: Command = (state, dispatch) => {
  if (!inTableCell(state)) return false;
  const next = nextCellPos(state, -1);
  if (next === null) return true;
  if (dispatch) {
    dispatch(
      state.tr
        .setSelection(TextSelection.create(state.doc, Math.min(next, state.doc.content.size)))
        .scrollIntoView()
    );
  }
  return true;
};
