/**
 * TableEditor —— 表格 NodeView（可视化编辑）
 *
 * G0 阶段：右键菜单行/列操作（基于 ProseMirror Transform，不引入新依赖）
 * G4 阶段增强：
 *   1. 列宽拖拽（mousedown 监听 th/td 右边缘，拖拽时显示垂直指示线）
 *   2. 表格浮动工具栏（行列增删、对齐、删除表格）
 *   3. align 通过 markdown 语法持久化（serializer 已支持 :---:、---: 语法）
 *
 * 设计要点：
 * - table 节点 attrs.columnWidths: number[] | null（null 表示等宽，默认）
 * - table_cell/table_header attrs.align: 'left' | 'center' | 'right'（默认 'left'）
 * - 列宽仅影响编辑器内显示，不影响 markdown 输出（markdown 表格无列宽概念）
 * - 行列增删时同步更新 columnWidths 数组，保持长度与列数一致
 */
import type { NodeView, EditorView, ViewMutationRecord } from "prosemirror-view";
import type { Node, ResolvedPos } from "prosemirror-model";
import type { Transaction } from "prosemirror-state";
import { lightMDSchema as schema } from "../schema";
// 直接从 state.ts 导入 t，避免触发 i18n/index.ts 的 useSettingsStore 副作用订阅
import { t } from "../../i18n/state";

// ─── TableCellView —— td/th 的轻量 NodeView（F1 修复） ────────────────

/**
 * F1 修复（v0.5.0）：阅读模式下表格列宽拖拽不生效的根因。
 *
 * TableView 拖拽时直接写 td/th 的 style.width/height，ProseMirror 的 DOMObserver
 * 会捕获这些 attributes 型 mutation（nearestDesc 找到的是 td 自身的普通
 * NodeViewDesc，其 ignoreMutation 对含 contentDOM 的节点返回 false），
 * 进而 readDOMChange → 整体重建 thead/tbody → 刚写入的宽度随旧节点被丢弃。
 *
 * 挂上本 NodeView 后，td/th 的 desc 变为 CustomNodeViewDesc，其 ignoreMutation
 * 会转发到本实例：这里仅忽略 attributes 型 mutation（我们自己写的 style），
 * childList/characterData（正常内容编辑）仍交由 PM 解析，不影响文字输入。
 */
export class TableCellView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  /** 创建时的标签类型（th/td），update 时校验节点类型一致，避免 td/th 标签错乱 */
  private readonly tagName: string;

  constructor(node: Node) {
    this.tagName = node.type.name === "table_header" ? "th" : "td";
    this.dom = document.createElement(this.tagName);
    // contentDOM 指向自身：内容仍由 ProseMirror 管理渲染
    this.contentDOM = this.dom;
    this.applyAlign(node);
  }

  /** 同步 align 属性到 DOM（与 schema.toDOM 的 text-align 输出保持一致） */
  private applyAlign(node: Node) {
    const align = node.attrs.align as string;
    this.dom.style.textAlign = align && align !== "left" ? align : "";
  }

  update(node: Node): boolean {
    // 节点类型必须与创建时的标签匹配（td↔table_cell、th↔table_header），
    // 不匹配时返回 false 交由 PM 销毁重建，避免 td/th 标签错乱
    const expected = this.tagName === "th" ? "table_header" : "table_cell";
    if (node.type.name !== expected) {
      return false;
    }
    this.applyAlign(node);
    return true;
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    // 仅忽略属性变化（列宽/行高/对齐直接写 style），内容编辑与选区变化照常交给 PM
    return mutation.type === "attributes";
  }
}


let activeMenu: HTMLElement | null = null;

function closeMenu() {
  if (activeMenu) { activeMenu.remove(); activeMenu = null; }
}

// 全局拖拽指示线引用（同一时间只允许一个拖拽）
let resizeIndicator: HTMLElement | null = null;

function removeResizeIndicator() {
  if (resizeIndicator) { resizeIndicator.remove(); resizeIndicator = null; }
}

// ─── 拖拽热区判定（F1 修复：onHover/onMouseDown/stopEvent 统一使用） ────────

/** 列宽热区半宽（px）：cell 左/右边缘命中范围 */
const COL_RESIZE_HOTZONE = 8;
/** 行高热区高度（px）：cell 底边缘命中范围 */
const ROW_RESIZE_HOTZONE = 6;

/**
 * 判定坐标相对 cell 的拖拽热区
 * F1 修复：抽取统一判定逻辑，消除 onMouseDown 与 stopEvent 判定不一致
 * 导致的"第一列左边缘"死区（stopEvent 拦截了事件但 onMouseDown 不响应）。
 */
function hitResizeZone(
  cell: HTMLElement,
  clientX: number,
  clientY: number
): { col: boolean; row: boolean } {
  const rect = cell.getBoundingClientRect();
  // border-collapse 下相邻 cell 边框共享，取 rect 边界 ±hotzone 判定
  const inRightEdge = Math.abs(clientX - rect.right) <= COL_RESIZE_HOTZONE;
  const inLeftEdge = Math.abs(rect.left - clientX) <= COL_RESIZE_HOTZONE;
  const inBottomEdge = Math.abs(clientY - rect.bottom) <= ROW_RESIZE_HOTZONE;
  // 列宽热区优先于行高热区
  return { col: inRightEdge || inLeftEdge, row: inBottomEdge };
}

/** 判断 cell 是否为其所在行的第一个单元格（第一列） */
function isFirstCellInRow(cell: HTMLElement): boolean {
  const row = cell.parentElement;
  if (!row) return false;
  const first = row.querySelector("td, th");
  return first === cell;
}


// ─── 表格结构工具函数（导出供测试） ────────────────────────────

/** 查找位置所在的 cell 节点（table_cell 或 table_header） */
export function cellAround($pos: ResolvedPos): { pos: number; node: Node; depth: number } | null {
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (node.type.name === "table_cell" || node.type.name === "table_header") {
      return { pos: $pos.before(d), node, depth: d };
    }
  }
  return null;
}

/** 查找位置所在的 row 节点 */
export function rowAround($pos: ResolvedPos): { pos: number; node: Node; depth: number } | null {
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (node.type.name === "table_row") {
      return { pos: $pos.before(d), node, depth: d };
    }
  }
  return null;
}

/** 查找位置所在的 table 节点 */
export function tableAround($pos: ResolvedPos): { pos: number; node: Node; depth: number } | null {
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (node.type.name === "table") {
      return { pos: $pos.before(d), node, depth: d };
    }
  }
  return null;
}

/** 判断位置是否在 table_head 中 */
function isInHead($pos: ResolvedPos): boolean {
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name === "table_head") return true;
  }
  return false;
}

/** 计算 cell 在所属 row 中的索引 */
function cellIndexInRow(row: Node, cellPos: number, rowPos: number): number {
  let pos = rowPos + 1;
  for (let i = 0; i < row.childCount; i++) {
    const child = row.child(i);
    if (pos === cellPos) return i;
    pos += child.nodeSize;
  }
  return -1;
}

/** 创建一个空 cell（与给定 cell 类型相同，保持 align） */
function createEmptyCellLike(cell: Node): Node {
  return cell.type.create({ align: cell.attrs.align }, []);
}

/** 基于给定 row 创建一个新空 row（cell 类型和 align 与原行一致） */
function createEmptyRowLike(row: Node): Node {
  const cells: Node[] = [];
  for (let i = 0; i < row.childCount; i++) {
    cells.push(createEmptyCellLike(row.child(i)));
  }
  return schema.nodes.table_row.create(null, cells);
}

/** 收集 table 中所有 row 节点及其在 doc 中的绝对位置 */
function collectRows(table: Node, tablePos: number): Array<{ pos: number; node: Node }> {
  const rows: Array<{ pos: number; node: Node }> = [];
  // table 内容：table_head? table_body，子节点起始位置 = tablePos + 1
  let sectionPos = tablePos + 1;
  table.forEach((section) => {
    if (section.type.name === "table_head" || section.type.name === "table_body") {
      // section 节点起始位置 = sectionPos，第一个 row 在 sectionPos + 1
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

// ─── 行/列操作（纯函数：基于传入 transaction 修改并返回） ───────

/** 上方插入行：在当前 row 节点之前插入新 row（thead 行受 schema 限制，转为在 tbody 顶部插入） */
export function insertRowAbove(tr: Transaction, $pos: ResolvedPos): Transaction | null {
  const rowInfo = rowAround($pos);
  if (!rowInfo) return null;
  const newRow = createEmptyRowLike(rowInfo.node);
  // thead 仅允许一行：在 thead 上方无法再插 thead，转为在 tbody 顶部插入
  if (isInHead($pos)) {
    const tableInfo = tableAround($pos);
    if (!tableInfo) return null;
    const head = tableInfo.node.firstChild;
    if (!head || head.type.name !== "table_head") return null;
    const body = tableInfo.node.maybeChild(1);
    if (!body || body.type.name !== "table_body") return null;
    // tbody 起始位置 = table 起始 + 1（table 内偏移） + head 大小 + 1（tbody 节点开始）
    const bodyStart = tableInfo.pos + 1 + head.nodeSize + 1;
    return tr.insert(bodyStart, newRow);
  }
  // tbody 行：在当前 row 之前插入
  return tr.insert(rowInfo.pos, newRow);
}

/** 下方插入行：在当前 row 节点之后插入新 row（thead 行视为在 tbody 顶部插入） */
export function insertRowBelow(tr: Transaction, $pos: ResolvedPos): Transaction | null {
  const rowInfo = rowAround($pos);
  if (!rowInfo) return null;
  const newRow = createEmptyRowLike(rowInfo.node);
  // thead 行下方插入：作为 tbody 第一行
  if (isInHead($pos)) {
    const tableInfo = tableAround($pos);
    if (!tableInfo) return null;
    const head = tableInfo.node.firstChild;
    if (!head || head.type.name !== "table_head") return null;
    const body = tableInfo.node.maybeChild(1);
    if (!body || body.type.name !== "table_body") return null;
    const bodyStart = tableInfo.pos + 1 + head.nodeSize + 1;
    return tr.insert(bodyStart, newRow);
  }
  // tbody 行：在当前 row 之后插入
  const insertPos = rowInfo.pos + rowInfo.node.nodeSize;
  return tr.insert(insertPos, newRow);
}

/** 左侧插入列：在当前 cell 之前插入新 cell（所有 row 同步，倒序避免位置偏移）；同步 columnWidths */
export function insertColumnLeft(tr: Transaction, $pos: ResolvedPos): Transaction | null {
  const cellInfo = cellAround($pos);
  const rowInfo = rowAround($pos);
  const tableInfo = tableAround($pos);
  if (!cellInfo || !rowInfo || !tableInfo) return null;
  const colIdx = cellIndexInRow(rowInfo.node, cellInfo.pos, rowInfo.pos);
  if (colIdx < 0) return null;

  const rows = collectRows(tableInfo.node, tableInfo.pos);
  // 倒序处理，避免插入操作导致后续位置偏移
  for (let i = rows.length - 1; i >= 0; i--) {
    const { pos: rowPos, node: row } = rows[i];
    if (colIdx >= row.childCount) continue;
    let cellPos = rowPos + 1;
    for (let j = 0; j < colIdx; j++) {
      cellPos += row.child(j).nodeSize;
    }
    const refCell = row.child(colIdx);
    const newCell = createEmptyCellLike(refCell);
    tr.insert(cellPos, newCell);
  }
  // G4：同步 columnWidths（仅当已设置时，在 colIdx 位置插入默认宽度 100px）
  syncColumnWidthsAfterInsert(tr, tableInfo, colIdx);
  return tr;
}

/** 右侧插入列：在当前 cell 之后插入新 cell（所有 row 同步，倒序避免位置偏移）；同步 columnWidths */
export function insertColumnRight(tr: Transaction, $pos: ResolvedPos): Transaction | null {
  const cellInfo = cellAround($pos);
  const rowInfo = rowAround($pos);
  const tableInfo = tableAround($pos);
  if (!cellInfo || !rowInfo || !tableInfo) return null;
  const colIdx = cellIndexInRow(rowInfo.node, cellInfo.pos, rowInfo.pos);
  if (colIdx < 0) return null;

  const rows = collectRows(tableInfo.node, tableInfo.pos);
  for (let i = rows.length - 1; i >= 0; i--) {
    const { pos: rowPos, node: row } = rows[i];
    if (colIdx >= row.childCount) continue;
    // 计算目标 cell 之后的位置
    let cellPos = rowPos + 1;
    for (let j = 0; j <= colIdx; j++) {
      cellPos += row.child(j).nodeSize;
    }
    const refCell = row.child(colIdx);
    const newCell = createEmptyCellLike(refCell);
    tr.insert(cellPos, newCell);
  }
  // G4：同步 columnWidths（右侧插入 → 在 colIdx+1 位置插入）
  syncColumnWidthsAfterInsert(tr, tableInfo, colIdx + 1);
  return tr;
}

/** 删除当前行（thead 行视为删除整个 thead；tbody 仅剩一行时不删除） */
export function deleteRow(tr: Transaction, $pos: ResolvedPos): Transaction | null {
  const rowInfo = rowAround($pos);
  if (!rowInfo) return null;

  // thead 中的行：删除整个 table_head 节点（保留 tbody）
  if (isInHead($pos)) {
    for (let d = $pos.depth; d > 0; d--) {
      const node = $pos.node(d);
      if (node.type.name === "table_head") {
        const headPos = $pos.before(d);
        return tr.delete(headPos, headPos + node.nodeSize);
      }
    }
    return null;
  }

  // tbody 中的行：检查 tbody 是否仅剩这一行（schema 要求 table_body 至少一行）
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (node.type.name === "table_body") {
      if (node.childCount <= 1) return null;
      break;
    }
  }
  return tr.delete(rowInfo.pos, rowInfo.pos + rowInfo.node.nodeSize);
}

/** 删除当前列（所有 row 同步删除对应 cell；任一 row 仅剩 1 cell 时不删除）；同步 columnWidths */
export function deleteColumn(tr: Transaction, $pos: ResolvedPos): Transaction | null {
  const cellInfo = cellAround($pos);
  const rowInfo = rowAround($pos);
  const tableInfo = tableAround($pos);
  if (!cellInfo || !rowInfo || !tableInfo) return null;
  const colIdx = cellIndexInRow(rowInfo.node, cellInfo.pos, rowInfo.pos);
  if (colIdx < 0) return null;

  const rows = collectRows(tableInfo.node, tableInfo.pos);
  // 任一 row 仅剩 1 cell 时拒绝删除（避免破坏 schema）
  for (const { node: row } of rows) {
    if (row.childCount <= 1) return null;
  }

  // 倒序处理，避免删除导致后续位置偏移
  for (let i = rows.length - 1; i >= 0; i--) {
    const { pos: rowPos, node: row } = rows[i];
    if (colIdx >= row.childCount) continue;
    let cellPos = rowPos + 1;
    for (let j = 0; j < colIdx; j++) {
      cellPos += row.child(j).nodeSize;
    }
    const cellNode = row.child(colIdx);
    tr.delete(cellPos, cellPos + cellNode.nodeSize);
  }
  // G4：同步 columnWidths（删除 colIdx 位置的宽度）
  syncColumnWidthsAfterDelete(tr, tableInfo, colIdx);
  return tr;
}

// ─── G4 新增纯函数：列宽 / 对齐 / 删除表格（导出供测试） ───────────────

/** 计算 table 的列数（取第一个 row 的 cell 数量；无 row 时返回 0） */
export function getTableColumnCount(table: Node): number {
  let colCount = 0;
  table.forEach((section) => {
    if (
      (section.type.name === "table_head" || section.type.name === "table_body") &&
      section.firstChild &&
      colCount === 0
    ) {
      colCount = section.firstChild.childCount;
    }
  });
  return colCount;
}

/**
 * 设置 table 的 columnWidths 属性
 * @param widths 每列像素宽度数组；null 表示重置为等宽
 */
export function setColumnWidths(
  tr: Transaction,
  $pos: ResolvedPos,
  widths: number[] | null
): Transaction | null {
  const tableInfo = tableAround($pos);
  if (!tableInfo) return null;
  return tr.setNodeMarkup(tableInfo.pos, undefined, {
    ...tableInfo.node.attrs,
    columnWidths: widths,
  });
}

/**
 * Issue 8 修复：计算列宽拖拽后的新宽度数组（纯函数，便于单元测试）
 *
 * 拖拽行为：
 * - 非最后一列：调整 colIdx 和 colIdx+1 列宽，保持总宽度不变
 *   * 拖拽列 colIdx 右边缘往右：colIdx 列宽增大，colIdx+1 列宽减小
 *   * 拖拽列 colIdx 右边缘往左：colIdx 列宽减小，colIdx+1 列宽增大
 * - 最后一列：只调整该列，总宽度可变
 * - 两列宽度均不小于 minWidth（默认 20px），通过限制 delta 范围实现
 *
 * @param startWidths 拖拽开始时各列的初始宽度
 * @param colIdx 被拖拽右边缘的列索引
 * @param deltaX 鼠标水平位移（正数=往右拖拽，负数=往左拖拽）
 * @param minWidth 最小列宽，默认 20px
 * @returns 新的列宽数组（长度与 startWidths 相同）
 */
export function computeResizedWidths(
  startWidths: number[],
  colIdx: number,
  deltaX: number,
  minWidth = 20
): number[] {
  if (startWidths.length === 0 || colIdx < 0 || colIdx >= startWidths.length) {
    return startWidths.map((w) => Math.round(w));
  }
  const isLastColumn = colIdx >= startWidths.length - 1;
  if (isLastColumn) {
    // 最后一列：只调整该列，总宽度可变
    const newWidth = Math.max(minWidth, startWidths[colIdx] + deltaX);
    return startWidths.map((w, i) =>
      i === colIdx ? Math.round(newWidth) : Math.round(w)
    );
  }
  // 非最后一列：调整 colIdx 和 colIdx+1，保持总宽度不变
  const startWidth = startWidths[colIdx];
  const adjacentStartWidth = startWidths[colIdx + 1];
  // 限制 delta 范围，确保两列都不小于 minWidth：
  // colIdx 列：startWidth + delta >= minWidth → delta >= minWidth - startWidth
  // colIdx+1 列：adjacentStartWidth - delta >= minWidth → delta <= adjacentStartWidth - minWidth
  const minDelta = minWidth - startWidth;
  const maxDelta = adjacentStartWidth - minWidth;
  const actualDelta = Math.max(minDelta, Math.min(deltaX, maxDelta));
  const newColWidth = startWidth + actualDelta;
  const newAdjacentWidth = adjacentStartWidth - actualDelta;
  return startWidths.map((w, i) => {
    if (i === colIdx) return Math.round(newColWidth);
    if (i === colIdx + 1) return Math.round(newAdjacentWidth);
    return Math.round(w);
  });
}

/**
 * 更新单列宽度（基于现有 columnWidths 复制后修改）
 * 如果当前 columnWidths 为 null（等宽），先初始化为各列 100px
 * @param colIdx 列索引（0-based）
 * @param width 新宽度（像素，最小 20px）
 */
export function updateColumnWidth(
  tr: Transaction,
  $pos: ResolvedPos,
  colIdx: number,
  width: number
): Transaction | null {
  const tableInfo = tableAround($pos);
  if (!tableInfo) return null;
  const colCount = getTableColumnCount(tableInfo.node);
  if (colCount <= 0) return null;
  // 复制现有 widths 或初始化为默认值 100px
  const widths = Array.isArray(tableInfo.node.attrs.columnWidths)
    ? [...tableInfo.node.attrs.columnWidths]
    : new Array(colCount).fill(100);
  // 确保 widths 长度与 colCount 一致（防御性）
  while (widths.length < colCount) widths.push(100);
  if (colIdx < 0 || colIdx >= widths.length) return null;
  // 最小宽度 20px，避免负值或过小
  widths[colIdx] = Math.max(20, Math.round(width));
  return setColumnWidths(tr, $pos, widths);
}

/**
 * 更新单行高度（基于现有 rowHeights 复制后修改）
 * 如果当前 rowHeights 为 null（自动高度），先初始化为各行默认高度
 * @param rowIdx 行索引（0-based，含 thead 行）
 * @param height 新高度（像素，最小 20px）
 */
export function updateRowHeight(
  tr: Transaction,
  $pos: ResolvedPos,
  rowIdx: number,
  height: number
): Transaction | null {
  const tableInfo = tableAround($pos);
  if (!tableInfo) return null;
  // 计算总行数（thead + tbody 的所有行）
  let rowCount = 0;
  tableInfo.node.forEach((section) => {
    if (section.type.name === "table_head" || section.type.name === "table_body") {
      section.forEach(() => rowCount++);
    }
  });
  if (rowCount <= 0) return null;
  // 复制现有 heights 或初始化为默认值 30px
  const heights = Array.isArray(tableInfo.node.attrs.rowHeights)
    ? [...tableInfo.node.attrs.rowHeights]
    : new Array(rowCount).fill(30);
  while (heights.length < rowCount) heights.push(30);
  if (rowIdx < 0 || rowIdx >= heights.length) return null;
  heights[rowIdx] = Math.max(20, Math.round(height));
  return tr.setNodeMarkup(tableInfo.pos, undefined, {
    ...tableInfo.node.attrs,
    rowHeights: heights,
  });
}

/**
 * 设置整列对齐（同列所有 cell 同步 align，含 thead 和 tbody）
 * @param align 'left' | 'center' | 'right'
 */
export function setColumnAlign(
  tr: Transaction,
  $pos: ResolvedPos,
  align: "left" | "center" | "right"
): Transaction | null {
  const cellInfo = cellAround($pos);
  const rowInfo = rowAround($pos);
  const tableInfo = tableAround($pos);
  if (!cellInfo || !rowInfo || !tableInfo) return null;
  const colIdx = cellIndexInRow(rowInfo.node, cellInfo.pos, rowInfo.pos);
  if (colIdx < 0) return null;

  const rows = collectRows(tableInfo.node, tableInfo.pos);
  // 倒序处理，避免 setNodeMarkup 导致位置偏移
  for (let i = rows.length - 1; i >= 0; i--) {
    const { pos: rowPos, node: row } = rows[i];
    if (colIdx >= row.childCount) continue;
    let cellPos = rowPos + 1;
    for (let j = 0; j < colIdx; j++) {
      cellPos += row.child(j).nodeSize;
    }
    const cellNode = row.child(colIdx);
    // 仅当 align 变化时才设置（避免无意义 transaction）
    if (cellNode.attrs.align !== align) {
      tr.setNodeMarkup(cellPos, undefined, { ...cellNode.attrs, align });
    }
  }
  return tr;
}

/** 删除整个表格 */
export function deleteTable(tr: Transaction, $pos: ResolvedPos): Transaction | null {
  const tableInfo = tableAround($pos);
  if (!tableInfo) return null;
  return tr.delete(tableInfo.pos, tableInfo.pos + tableInfo.node.nodeSize);
}

// ─── columnWidths 同步辅助函数（内部） ─────────────────────────

/**
 * 在列插入后同步 columnWidths（仅当 table 已设置 columnWidths 时）
 * @param insertIdx 插入位置的列索引
 */
function syncColumnWidthsAfterInsert(
  tr: Transaction,
  tableInfo: { pos: number; node: Node },
  insertIdx: number
): void {
  const widths = tableInfo.node.attrs.columnWidths;
  if (!Array.isArray(widths)) return;
  const newWidths = [...widths];
  // 在 insertIdx 位置插入默认宽度 100px（不超过数组末尾）
  const safeIdx = Math.min(insertIdx, newWidths.length);
  newWidths.splice(safeIdx, 0, 100);
  tr.setNodeMarkup(tableInfo.pos, undefined, {
    ...tableInfo.node.attrs,
    columnWidths: newWidths,
  });
}

/**
 * 在列删除后同步 columnWidths（仅当 table 已设置 columnWidths 时）
 * @param deleteIdx 删除位置的列索引
 */
function syncColumnWidthsAfterDelete(
  tr: Transaction,
  tableInfo: { pos: number; node: Node },
  deleteIdx: number
): void {
  const widths = tableInfo.node.attrs.columnWidths;
  if (!Array.isArray(widths)) return;
  if (deleteIdx < 0 || deleteIdx >= widths.length) return;
  const newWidths = [...widths];
  newWidths.splice(deleteIdx, 1);
  tr.setNodeMarkup(tableInfo.pos, undefined, {
    ...tableInfo.node.attrs,
    columnWidths: newWidths,
  });
}

// ─── NodeView ──────────────────────────────────────────────

export class TableView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private view: EditorView;
  private getPos: () => number | undefined;
  private toolbar: HTMLElement | null = null;
  // 列宽拖拽状态
  private resizing: {
    colIdx: number;
    startX: number;
    cellEl: HTMLElement;
    /** 拖拽开始时所有列的初始宽度，Issue 8 修复后用于计算相邻列调整 */
    startWidths: number[];
  } | null = null;
  // 行高拖拽状态
  private rowResizing: {
    rowIdx: number;
    startY: number;
    startHeight: number;
    rowEl: HTMLElement;
  } | null = null;

  constructor(node: Node, view: EditorView, getPos: () => number | undefined) {
    this.view = view;
    this.getPos = getPos;

    this.dom = document.createElement("div");
    this.dom.className = "table-wrapper";
    // 工具栏 absolute 定位需要 wrapper 作为定位上下文
    this.dom.style.position = "relative";

    // contentDOM 是 ProseMirror 管理的 DOM 节点
    // ProseMirror 会自动将表格内容渲染到这里
    this.contentDOM = document.createElement("table");
    this.contentDOM.className = "pm-table";
    this.dom.appendChild(this.contentDOM);

    // 右键菜单
    this.dom.addEventListener("contextmenu", (e) => this.onContextMenu(e));
    // 列宽拖拽：mousedown 监听 cell 右边缘
    this.dom.addEventListener("mousedown", (e) => this.onMouseDown(e));
    // 列宽拖拽视觉提示：mousemove 检测鼠标是否靠近 cell 右边缘，显示 col-resize 光标
    this.dom.addEventListener("mousemove", (e) => this.onHover(e));
    // 点击表格内任意位置时显示工具栏
    this.dom.addEventListener("click", () => this.showToolbar());

    // 初始应用列宽和行高
    this.applyColumnWidths(node);
    this.applyRowHeights(node);
  }

  // ─── 列宽/行高应用 ──────────────────────────────────────

  /** 将 columnWidths attrs 应用到 DOM（每个 td/th 设置 width style） */
  private applyColumnWidths(node: Node) {
    const widths = node.attrs.columnWidths;
    if (!Array.isArray(widths) || widths.length === 0) {
      // 清除所有 cell 的 width style
      const cells = this.contentDOM.querySelectorAll("td, th");
      cells.forEach((c) => ((c as HTMLElement).style.width = ""));
      // 无 columnWidths 时 table 宽度 100% 等宽
      this.contentDOM.style.width = "100%";
      return;
    }
    // v0.4.4 修复：设置 table width = widths 之和，让 table.width = cellWidthSum。
    // table-layout:fixed 下，当 table.width = cell width 之和时，浏览器按 cell width 绝对值分配列宽，不缩放。
    // 之前用 width:auto 在某些情况下会导致表格坍缩（border-collapse:collapse 下
    // getBoundingClientRect().width 之和 ≠ table.offsetWidth，width:auto 使 table 收缩到内容大小）。
    const totalWidth = widths.reduce((sum, w) => sum + w, 0);
    this.contentDOM.style.width = `${totalWidth}px`;
    // 遍历 DOM 中所有 row，按列索引设置 cell 宽度
    const rows = this.contentDOM.querySelectorAll("tr");
    rows.forEach((row) => {
      const cells = row.querySelectorAll("td, th");
      cells.forEach((cell, i) => {
        if (i < widths.length) {
          (cell as HTMLElement).style.width = `${widths[i]}px`;
        }
      });
    });
  }

  /** 将 rowHeights attrs 应用到 DOM（每个 tr 内的 td/th 设置 height style） */
  private applyRowHeights(node: Node) {
    const heights = node.attrs.rowHeights;
    const rows = this.contentDOM.querySelectorAll("tr");
    if (!Array.isArray(heights) || heights.length === 0) {
      // 清除所有 cell 的 height style
      rows.forEach((row) => {
        const cells = row.querySelectorAll("td, th");
        cells.forEach((c) => ((c as HTMLElement).style.height = ""));
      });
      return;
    }
    rows.forEach((row, rowIdx) => {
      if (rowIdx < heights.length) {
        const cells = row.querySelectorAll("td, th");
        cells.forEach((cell) => {
          (cell as HTMLElement).style.height = `${heights[rowIdx]}px`;
        });
      }
    });
  }

  // ─── 列宽拖拽 ──────────────────────────────────────

  /**
   * mousemove 视觉提示：检测鼠标是否靠近 cell 左/右边缘，显示 col-resize 光标
   * v0.4.5 修复：同时检测 cell 左边缘和右边缘，实现内部列框线拖拽
   * 性能考量：仅修改 cursor style，不触发 DOM 重建，开销极小
   */
  private onHover(e: MouseEvent) {
    // 拖拽中不更新 cursor
    if (this.resizing || this.rowResizing) return;
    const target = e.target as HTMLElement;
    const cell = target.closest("td, th") as HTMLElement;
    if (!cell) {
      this.contentDOM.style.cursor = "";
      return;
    }
    // F1 修复：统一使用 hitResizeZone 判定（与 onMouseDown/stopEvent 一致）
    const zone = hitResizeZone(cell, e.clientX, e.clientY);
    if (zone.col) {
      this.contentDOM.style.cursor = "col-resize";
    } else if (zone.row) {
      this.contentDOM.style.cursor = "row-resize";
    } else {
      this.contentDOM.style.cursor = "";
    }
  }

  private onMouseDown(e: MouseEvent) {
    // 仅响应左键
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const cell = target.closest("td, th") as HTMLElement;
    if (!cell) return;

    // F1 修复：统一使用 hitResizeZone 判定
    const rect = cell.getBoundingClientRect();
    const zone = hitResizeZone(cell, e.clientX, e.clientY);
    const inLeftEdge = Math.abs(rect.left - e.clientX) <= COL_RESIZE_HOTZONE;
    const inRightEdge = Math.abs(e.clientX - rect.right) <= COL_RESIZE_HOTZONE;

    // 行高拖拽：cell 底边缘热区内（且不在列宽热区内）
    if (zone.row && !zone.col) {
      e.preventDefault();
      const row = cell.parentElement as HTMLTableRowElement | null;
      if (!row) return;
      const rows = Array.from(this.contentDOM.querySelectorAll("tr"));
      const rowIdx = rows.indexOf(row);
      if (rowIdx < 0) return;
      this.startRowResize(rowIdx, e.clientY, row);
      return;
    }

    // 列宽拖拽：cell 左边缘或右边缘热区内
    if (!zone.col) return;

    // 第一列左边缘不触发拖拽（表格左外侧框线无相邻列可调整），
    // 事件放行给 ProseMirror（stopEvent 同步返回 false，见下），避免死区
    if (inLeftEdge && !inRightEdge && isFirstCellInRow(cell)) return;

    e.preventDefault();
    // 计算列索引
    const row = cell.parentElement;
    if (!row) return;
    const cells = Array.from(row.querySelectorAll("td, th"));
    const cellIdx = cells.indexOf(cell);
    if (cellIdx < 0) return;

    // 计算被拖拽的列索引：
    // - 右边缘触发：colIdx = cellIdx（当前列右边缘，调整当前列和下一列）
    // - 左边缘触发：colIdx = cellIdx - 1（前一列右边缘，调整前一列和当前列）
    let colIdx = cellIdx;
    if (inLeftEdge && !inRightEdge && cellIdx > 0) {
      colIdx = cellIdx - 1;
    }

    this.startResize(colIdx, e.clientX, cell);
  }

  private startResize(colIdx: number, clientX: number, cellEl: HTMLElement) {
    // 记录所有列的初始宽度，拖拽时用于计算相邻列调整（Issue 8 修复）
    // v0.4.4 修复：Math.round 取整，确保 startWidths 之和 = table.style.width（整数像素）
    const firstRow = this.contentDOM.querySelector("tr");
    const allCells = firstRow ? Array.from(firstRow.querySelectorAll("td, th")) : [];
    const startWidths = allCells.map((c) => Math.round(c.getBoundingClientRect().width));

    this.resizing = {
      colIdx,
      startX: clientX,
      cellEl,
      startWidths,
    };

    // 创建垂直指示线（贯穿整个视口高度）
    if (!resizeIndicator) {
      resizeIndicator = document.createElement("div");
      resizeIndicator.className = "table-resize-indicator";
      resizeIndicator.style.cssText =
        "position:fixed;width:1px;background:#1976d2;z-index:10000;pointer-events:none;top:0;bottom:0;";
      document.body.appendChild(resizeIndicator);
    }
    this.updateResizeIndicator(clientX);

    document.addEventListener("mousemove", this.onMouseMove);
    document.addEventListener("mouseup", this.onMouseUp);
    // 拖拽时禁用文本选择
    document.body.style.userSelect = "none";
  }

  private updateResizeIndicator(clientX: number) {
    if (!resizeIndicator) return;
    resizeIndicator.style.left = `${clientX}px`;
  }

  // 箭头函数属性：保持 this 绑定，便于 addEventListener / removeEventListener
  private onMouseMove = (e: MouseEvent) => {
    if (!this.resizing) return;
    e.preventDefault();
    // 实时更新指示线位置
    this.updateResizeIndicator(e.clientX);
    // v0.4.4 修复：拖拽某列右边缘时，调整该列和相邻列（colIdx+1）的宽度，
    // 保持总宽度不变（非最后一列）；最后一列则只调整该列，总宽度可变。
    // 关键修复：设置 table.style.width = newWidths 之和，让 table.width = cellWidthSum。
    // table-layout:fixed 下，当 table.width = cell width 之和时，浏览器按 cell width 绝对值
    // 分配列宽，不缩放。之前用 width:auto 在某些情况下会导致表格坍缩。
    const deltaX = e.clientX - this.resizing.startX;
    const { colIdx, startWidths } = this.resizing;
    const newWidths = computeResizedWidths(startWidths, colIdx, deltaX);
    // 保持 table.width = newWidths 之和，避免等比例缩放
    const totalWidth = newWidths.reduce((sum, w) => sum + w, 0);
    this.contentDOM.style.width = `${totalWidth}px`;
    const rows = this.contentDOM.querySelectorAll("tr");
    rows.forEach((row) => {
      const cells = row.querySelectorAll("td, th");
      cells.forEach((cell, i) => {
        if (i < newWidths.length) {
          (cell as HTMLElement).style.width = `${newWidths[i]}px`;
        }
      });
    });
  };

  private onMouseUp = (e: MouseEvent) => {
    if (!this.resizing) return;
    const { colIdx, startWidths, startX, cellEl } = this.resizing;
    const deltaX = e.clientX - startX;

    // 清理拖拽状态
    this.resizing = null;
    document.removeEventListener("mousemove", this.onMouseMove);
    document.removeEventListener("mouseup", this.onMouseUp);
    document.body.style.userSelect = "";
    removeResizeIndicator();

    // Issue 8 修复：使用 computeResizedWidths 计算最终宽度，
    // 通过 setColumnWidths 持久化整个宽度数组（含相邻列的调整）
    const newWidths = computeResizedWidths(startWidths, colIdx, deltaX);
    // 通过 cellEl 的 DOM 位置反查 ProseMirror 位置
    try {
      const cellPos = this.view.posAtDOM(cellEl, 0);
      const $pos = this.view.state.doc.resolve(cellPos);
      const tr = this.view.state.tr;
      const newTr = setColumnWidths(tr, $pos, newWidths);
      if (newTr) this.view.dispatch(newTr);
    } catch {
      // posAtDOM 在 DOM 不在文档中时可能抛出
    }
  };

  // ─── 行高拖拽 ──────────────────────────────────────

  private startRowResize(rowIdx: number, clientY: number, rowEl: HTMLElement) {
    this.rowResizing = {
      rowIdx,
      startY: clientY,
      startHeight: rowEl.getBoundingClientRect().height,
      rowEl,
    };

    // 创建水平指示线
    if (!resizeIndicator) {
      resizeIndicator = document.createElement("div");
      resizeIndicator.className = "table-resize-indicator-h";
      resizeIndicator.style.cssText =
        "position:fixed;height:1px;background:#1976d2;z-index:10000;pointer-events:none;left:0;right:0;";
      document.body.appendChild(resizeIndicator);
    }
    this.updateRowResizeIndicator(clientY);

    document.addEventListener("mousemove", this.onRowMouseMove);
    document.addEventListener("mouseup", this.onRowMouseUp);
    document.body.style.userSelect = "none";
  }

  private updateRowResizeIndicator(clientY: number) {
    if (!resizeIndicator) return;
    resizeIndicator.style.top = `${clientY}px`;
  }

  private onRowMouseMove = (e: MouseEvent) => {
    if (!this.rowResizing) return;
    e.preventDefault();
    this.updateRowResizeIndicator(e.clientY);
    const deltaY = e.clientY - this.rowResizing.startY;
    const newHeight = Math.max(20, this.rowResizing.startHeight + deltaY);
    // 实时更新该行所有 cell 的高度
    const cells = this.rowResizing.rowEl.querySelectorAll("td, th");
    cells.forEach((cell) => {
      (cell as HTMLElement).style.height = `${newHeight}px`;
    });
  };

  private onRowMouseUp = (e: MouseEvent) => {
    if (!this.rowResizing) return;
    const { rowIdx, startHeight, startY, rowEl } = this.rowResizing;
    const deltaY = e.clientY - startY;
    const newHeight = Math.max(20, startHeight + deltaY);

    this.rowResizing = null;
    document.removeEventListener("mousemove", this.onRowMouseMove);
    document.removeEventListener("mouseup", this.onRowMouseUp);
    document.body.style.userSelect = "";
    removeResizeIndicator();

    try {
      const cellEl = rowEl.querySelector("td, th");
      if (!cellEl) return;
      const cellPos = this.view.posAtDOM(cellEl as HTMLElement, 0);
      const $pos = this.view.state.doc.resolve(cellPos);
      const tr = this.view.state.tr;
      const newTr = updateRowHeight(tr, $pos, rowIdx, newHeight);
      if (newTr) this.view.dispatch(newTr);
    } catch {
      // posAtDOM 在 DOM 不在文档中时可能抛出
    }
  };

  // ─── 工具栏 ──────────────────────────────────────

  private showToolbar() {
    // 仅当选中表格（光标在表格内）时显示
    if (!this.isSelectionInTable()) {
      this.hideToolbar();
      return;
    }
    if (this.toolbar) {
      this.positionToolbar();
      return;
    }

    const toolbar = document.createElement("div");
    toolbar.className = "table-toolbar";
    toolbar.style.cssText =
      "position:absolute;display:flex;gap:2px;padding:4px;background:var(--bg-primary,#fff);border:1px solid var(--border-color,#ddd);border-radius:6px;box-shadow:var(--shadow-md,0 2px 8px rgba(0,0,0,0.15));z-index:100;font-size:13px;line-height:1;";

    type Btn = {
      label: string;
      title: string;
      op?: (tr: Transaction, $pos: ResolvedPos) => Transaction | null;
      align?: "left" | "center" | "right";
      danger?: boolean;
    };
    const buttons: Btn[] = [
      { label: "⬆️", title: t("table.addRowAbove"), op: insertRowAbove },
      { label: "⬇️", title: t("table.addRowBelow"), op: insertRowBelow },
      { label: "⬅️", title: t("table.addColumnLeft"), op: insertColumnLeft },
      { label: "➡️", title: t("table.addColumnRight"), op: insertColumnRight },
      { label: "↕", title: t("table.deleteRow"), op: deleteRow, danger: true },
      { label: "↔", title: t("table.deleteColumn"), op: deleteColumn, danger: true },
      { label: "🗑", title: t("table.deleteTable"), op: deleteTable, danger: true },
      { label: "⟸", title: t("table.alignLeft"), align: "left" },
      { label: "⟺", title: t("table.alignCenter"), align: "center" },
      { label: "⟹", title: t("table.alignRight"), align: "right" },
    ];

    buttons.forEach(({ label, title, op, align, danger }) => {
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.title = title;
      btn.type = "button";
      btn.style.cssText =
        "padding:3px 6px;border:1px solid transparent;background:none;cursor:pointer;border-radius:3px;";
      if (danger) btn.style.color = "#d32f2f";
      btn.addEventListener("mouseenter", () => (btn.style.background = "var(--bg-hover,#f0f0f0)"));
      btn.addEventListener("mouseleave", () => (btn.style.background = "none"));
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        const $pos = this.getCurrentCellPos();
        if (!$pos) return;
        const tr = this.view.state.tr;
        let newTr: Transaction | null = null;
        if (op) {
          newTr = op(tr, $pos);
        } else if (align) {
          newTr = setColumnAlign(tr, $pos, align);
        }
        if (newTr) this.view.dispatch(newTr);
      });
      toolbar.appendChild(btn);
    });

    this.dom.appendChild(toolbar);
    this.toolbar = toolbar;
    this.positionToolbar();

    // 延迟注册 document click listener，避免当前 click 立即触发隐藏
    setTimeout(() => {
      document.addEventListener("click", this.onDocClick);
    }, 0);
  }

  private onDocClick = (e: MouseEvent) => {
    if (!this.toolbar) return;
    // 使用 HTMLElement 避免 ProseMirror Node 类型冲突（e.target 是 DOM EventTarget）
    const target = e.target as HTMLElement | null;
    // 点击发生在工具栏或表格内：保持显示
    if (target && (this.toolbar.contains(target) || this.dom.contains(target))) return;
    this.hideToolbar();
  };

  private hideToolbar() {
    if (this.toolbar) {
      this.toolbar.remove();
      this.toolbar = null;
    }
    document.removeEventListener("click", this.onDocClick);
  }

  /** 工具栏定位：表格上方居中（absolute 相对于 dom wrapper） */
  private positionToolbar() {
    if (!this.toolbar) return;
    const tableRect = this.contentDOM.getBoundingClientRect();
    const wrapperRect = this.dom.getBoundingClientRect();
    // 工具栏顶部 = table 顶部 - wrapper 顶部 - 工具栏高度（约 32px）- 4px 间距
    const top = tableRect.top - wrapperRect.top - 36;
    // 水平居中于 wrapper
    const left = Math.max(0, (this.dom.offsetWidth - this.toolbar.offsetWidth) / 2);
    this.toolbar.style.top = `${top}px`;
    this.toolbar.style.left = `${left}px`;
  }

  /** 判断当前 selection 是否在表格内 */
  private isSelectionInTable(): boolean {
    const pos = this.getPos();
    if (pos === undefined) return false;
    const sel = this.view.state.selection;
    const tableNode = this.view.state.doc.nodeAt(pos);
    if (!tableNode) return false;
    const tableEnd = pos + tableNode.nodeSize;
    return sel.$from.pos >= pos && sel.$to.pos <= tableEnd;
  }

  /**
   * 获取当前 cell 的 ResolvedPos（用于工具栏操作）
   * 优先使用 selection.$from；若光标不在表格内，回退到表格起始位置
   */
  private getCurrentCellPos(): ResolvedPos | null {
    const pos = this.getPos();
    if (pos === undefined) return null;
    const sel = this.view.state.selection;
    const tableNode = this.view.state.doc.nodeAt(pos);
    if (!tableNode) return null;
    const tableEnd = pos + tableNode.nodeSize;
    if (sel.$from.pos >= pos && sel.$from.pos <= tableEnd) {
      return sel.$from;
    }
    // 光标不在表格内（如刚加载时），使用表格起始位置
    return this.view.state.doc.resolve(pos + 1);
  }

  // ─── 右键菜单 ──────────────────────────────────────

  private onContextMenu(e: MouseEvent) {
    e.preventDefault();
    const cell = (e.target as HTMLElement).closest("td, th") as HTMLElement;
    if (!cell) return;

    closeMenu();
    // 通过 DOM 节点直接定位 ProseMirror 位置（不依赖 selection）
    let $pos: ResolvedPos | null = null;
    try {
      const pos = this.view.posAtDOM(cell, 0);
      if (pos >= 0) $pos = this.view.state.doc.resolve(pos);
    } catch {
      // posAtDOM 在 DOM 不在文档中时可能抛出
    }
    if (!$pos) return;

    const menu = document.createElement("div");
    menu.className = "table-context-menu";
    menu.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;z-index:999;background:var(--bg-primary);border:1px solid var(--border-color);border-radius:6px;box-shadow:var(--shadow-md);padding:4px 0;min-width:155px;font-size:13px;color:var(--text-primary);`;

    // 菜单项与对应操作（label 中含 "删除" 视为危险操作）
    const actions: Array<{ label: string; op?: (tr: Transaction, $pos: ResolvedPos) => Transaction | null }> = [
      { label: "⬆ 上方插入行", op: insertRowAbove },
      { label: "⬇ 下方插入行", op: insertRowBelow },
      { label: "-" },
      { label: "⬅ 左侧插入列", op: insertColumnLeft },
      { label: "➡ 右侧插入列", op: insertColumnRight },
      { label: "-" },
      { label: "🗑 删除当前行", op: deleteRow },
      { label: "🗑 删除当前列", op: deleteColumn },
    ];

    actions.forEach(({ label, op }) => {
      if (label === "-") {
        const sep = document.createElement("div");
        sep.style.cssText = "height:1px;background:var(--border-light);margin:3px 0;";
        menu.appendChild(sep);
        return;
      }
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.style.cssText = "display:block;width:100%;padding:5px 12px;border:none;background:none;text-align:left;cursor:pointer;";
      if (label.includes("删除")) btn.style.color = "#d32f2f";
      btn.addEventListener("mouseenter", () => (btn.style.background = "var(--bg-hover)"));
      btn.addEventListener("mouseleave", () => (btn.style.background = "none"));
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        closeMenu();
        // 执行表格操作；op 返回 null 表示受 schema 限制不执行
        if (op) {
          const tr = this.view.state.tr;
          const newTr = op(tr, $pos!);
          if (newTr) this.view.dispatch(newTr);
        }
      });
      menu.appendChild(btn);
    });

    document.body.appendChild(menu);
    activeMenu = menu;
    setTimeout(() => document.addEventListener("click", closeMenu, { once: true }), 0);
  }

  // ─── NodeView 接口 ─────────────────────────────────

  update(node: Node): boolean {
    if (node.type.name !== "table") return false;
    // 拖拽进行中时跳过 apply，避免覆盖正在设置的临时宽度/高度
    if (!this.resizing) {
      this.applyColumnWidths(node);
    }
    if (!this.rowResizing) {
      this.applyRowHeights(node);
    }
    return true;
  }

  // stopEvent：在 cell 左/右边缘 8px 或底边缘 6px 范围内的 mousedown 阻止 ProseMirror 处理
  // 否则 PM 会先设置选区，干扰列宽/行高拖拽逻辑
  // v0.4.5 修复：同时检测 cell 左边缘，配合 onMouseDown 的左边缘拖拽逻辑
  stopEvent(event: Event): boolean {
    if (event.type === "mousedown" && event instanceof MouseEvent) {
      if (event.button !== 0) return false;
      const target = event.target as HTMLElement | null;
      if (!target) return false;
      const cell = target.closest("td, th") as HTMLElement | null;
      if (!cell) return false;
      const rect = cell.getBoundingClientRect();
      // v0.4.5 修复：同时检测左边缘和右边缘
      const offsetXRight = event.clientX - rect.right;
      const offsetXLeft = rect.left - event.clientX;
      const offsetY = event.clientY - rect.bottom;
      // 列宽热区（左边缘或右边缘 8px）或行高热区（底边缘 6px）
      if (Math.abs(offsetXRight) <= 8) return true;
      if (Math.abs(offsetXLeft) <= 8) return true;
      if (Math.abs(offsetY) <= 6) return true;
    }
    return false;
  }

  // ignoreMutation 返回 true：让 ProseMirror 忽略 NodeView 内部的 DOM 变化
  // （applyColumnWidths 修改 td/th 的 style.width 不应触发 PM 重新渲染）
  // 否则 PM 的 MutationObserver 会捕获 style 变化 → markDirty → 重建 DOM → 死循环
  ignoreMutation(): boolean {
    return true;
  }

  destroy() {
    closeMenu();
    this.hideToolbar();
    removeResizeIndicator();
    document.removeEventListener("mousemove", this.onMouseMove);
    document.removeEventListener("mouseup", this.onMouseUp);
    document.removeEventListener("mousemove", this.onRowMouseMove);
    document.removeEventListener("mouseup", this.onRowMouseUp);
    document.removeEventListener("click", this.onDocClick);
  }
}
