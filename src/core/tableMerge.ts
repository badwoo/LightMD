/**
 * v0.13.0 需求12：表格合并/拆分 —— 事务层
 *
 * ─── 为什么单独一个文件 ───
 * table-editor.ts 已 1300+ 行（列宽/行高/行列增删/工具栏/右键菜单/NodeView），
 * 合并拆分涉及「按行列范围重建整行」的完全不同的算法族，混进去只会互相干扰。
 * 本文件只做**纯事务构造**（输入 tr + 定位，输出 tr 或 null），
 * 不碰 DOM，可在 node 环境下用真实 doc 单测。
 *
 * ─── 算法 ───
 * 合并：按矩形范围重建受影响的每一行——
 *   · 锚点格（矩形左上）拿到 colspan/rowspan；
 *   · 矩形内的其它格**删除**；
 *   · 矩形外的格原样保留（顺序不变 → 列位置不错位）。
 * 为什么重建整行而不是逐格 delete：跨行合并时矩形内不同行的删除位置
 * 互相影响，逐格算偏移极易出错；重建行节点由 PM 自己算位置，零算术风险。
 *
 * 拆分：跨度复位为 1，并**补回占位格**保证列不错位——
 *   · colspan>1 → 在锚点后插入 (colspan-1) 个空格；
 *   · rowspan>1 → 在每个被覆盖的下方行的对应列插入一个空格。
 * 不补占位的后果：`| X(2) | Y |` 拆 X 后变成 `| X | Y |`，
 * Y 从第 3 列**漂到第 2 列**（数据错位），故必须补。
 */
import type { Node } from "prosemirror-model";
import type { Transaction } from "prosemirror-state";
import {
  buildTableGridFromTable,
  cellPositionsOfGrid,
  collectTableRows,
  gridColumnCount,
  normalizeSpan,
  spanOf,
  tableHasSpan,
} from "./tableGrid";

/** 矩形范围（逻辑行列） */
export interface CellRect {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

/** 合并前置校验结果 */
export type MergeCheck =
  | { ok: true }
  | { ok: false; reason: "too-few" | "no-table" | "has-span" | "empty" };

/**
 * 合并前置校验（纯函数，便于单测与 UI 禁用态）。
 *
 * 规则：
 * - 矩形内至少 2 个**真实格子**（占位 null 不计）；
 * - 矩形不得**部分切碎**既有跨度格（会破坏合并结构 → 提示先拆分）。
 */
export function checkMergeable(
  table: Node,
  rect: CellRect,
  rowCount: number,
): MergeCheck {
  if (rowCount < 2 && rect.r0 === rect.r1 && rect.c0 === rect.c1) {
    return { ok: false, reason: "too-few" };
  }
  if (rect.r0 === rect.r1 && rect.c0 === rect.c1) {
    return { ok: false, reason: "too-few" };
  }
  const rowNodes: Node[] = [];
  collectTableRows(table, 0).forEach((r) => rowNodes.push(r.row));
  const grid = buildTableGridFromTable(table);
  let real = 0;
  for (let r = rect.r0; r <= rect.r1; r++) {
    const row = grid[r];
    if (!row) continue;
    for (let c = rect.c0; c <= rect.c1; c++) if (row[c]) real++;
  }
  if (real < 2) return { ok: false, reason: "too-few" };
  // 矩形切碎既有跨度格 → 拒绝
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      const cell = grid[r][c];
      if (!cell || cell.rowIdx !== r || cell.colIdx !== c) continue;
      const cr1 = cell.rowIdx + cell.rowspan - 1;
      const cc1 = cell.colIdx + cell.colspan - 1;
      const intersects =
        cell.rowIdx <= rect.r1 && cr1 >= rect.r0 && cell.colIdx <= rect.c1 && cc1 >= rect.c0;
      if (!intersects) continue;
      const fullyInside =
        cell.rowIdx >= rect.r0 && cr1 <= rect.r1 && cell.colIdx >= rect.c0 && cc1 <= rect.c1;
      if (!fullyInside) return { ok: false, reason: "has-span" };
    }
  }
  return { ok: true };
}

/** 该格是否可拆分（跨度 >1） */
export function checkSplittable(cell: Node | null | undefined): boolean {
  if (!cell) return false;
  const { colspan, rowspan } = spanOf(cell);
  return colspan > 1 || rowspan > 1;
}

/**
 * 合并矩形内的单元格（单事务）。
 *
 * @param tr 事务（会被就地修改）
 * @param tablePos table 节点在 doc 中的起始位置
 * @param table table 节点
 * @param rect 矩形范围
 * @returns 修改后的 tr；校验失败返回 null（调用方不 dispatch）
 */
export function mergeCells(
  tr: Transaction,
  tablePos: number,
  table: Node,
  rect: CellRect,
): Transaction | null {
  const rows = collectTableRows(table, tablePos);
  if (rows.length === 0) return null;

  const grid = buildTableGridFromTable(table, tablePos);

  const colspan = rect.c1 - rect.c0 + 1;
  const rowspan = rect.r1 - rect.r0 + 1;

  // 自底向上重建受影响的行（位置不会被后续 replaceWith 影响）
  for (let r = rect.r1; r >= rect.r0; r--) {
    const gridRow = grid[r] ?? [];
    const rowRef = rows[r];
    if (!rowRef) continue;
    const newCells: Node[] = [];
    for (let c = 0; c < gridRow.length; c++) {
      const cell = gridRow[c];
      if (!cell) continue; // 占位
      const inRect =
        cell.rowIdx >= rect.r0 &&
        cell.rowIdx <= rect.r1 &&
        cell.colIdx >= rect.c0 &&
        cell.colIdx <= rect.c1;
      if (!inRect) {
        newCells.push(cell.node);
        continue;
      }
      // 矩形内：只有锚点格保留（拿到跨度）
      if (cell.rowIdx === rect.r0 && cell.colIdx === rect.c0) {
        newCells.push(
          cell.node.type.create(
            { ...cell.node.attrs, colspan, rowspan },
            cell.node.content,
          ),
        );
      }
      // 矩形内其它格：删除
    }
    if (newCells.length === 0) return null; // 不会发生（锚点必保留），防御
    const newRow = rowRef.row.type.create(null, newCells);
    tr.replaceWith(rowRef.pos, rowRef.pos + rowRef.row.nodeSize, newRow);
  }
  return tr;
}

/**
 * 拆分指定格（单事务）：跨度复位 1 + 补回占位格保证列不错位。
 *
 * @param tr 事务
 * @param tablePos table 起始位置
 * @param table table 节点
 * @param cellPos 目标 cell 在 doc 中的起始位置
 */
export function splitCell(
  tr: Transaction,
  tablePos: number,
  table: Node,
  cellPos: number,
): Transaction | null {
  const rows = collectTableRows(table, tablePos);
  if (rows.length === 0) return null;

  // 定位目标格所在的行与列。
  // 注意：这里必须用**真实行**（未裁剪）做位置遍历——cellPos 是 doc 绝对
  // 位置，裁剪后的行索引与它对不上；而网格坐标反查用裁剪后的 grid，
  // 两者通过「第几个 cell」对齐（裁剪只丢行尾空格，不影响前面格的下标）。
  const grid = buildTableGridFromTable(table, tablePos);
  let targetR = -1;
  let targetC = -1;
  let targetCell: Node | null = null;
  for (let r = 0; r < rows.length; r++) {
    const posInRow = cellPos - (rows[r].pos + 1);
    if (posInRow < 0) continue;
    let acc = 0;
    for (let c = 0; c < rows[r].row.childCount; c++) {
      const child = rows[r].row.child(c);
      if (acc === posInRow) {
        // 找到：反查该格在网格中的锚点坐标
        const gc = grid[r]?.[c];
        if (gc && gc.rowIdx === r && gc.colIdx === c) {
          targetR = r;
          targetC = c;
          targetCell = child;
        }
        break;
      }
      acc += child.nodeSize;
    }
  }
  if (targetR < 0 || targetC < 0 || !targetCell) return null;

  const { colspan, rowspan } = spanOf(targetCell);
  if (colspan <= 1 && rowspan <= 1) return null; // 普通格无需拆分

  // 自底向上重建受影响的行（目标行 + 被 rowspan 覆盖的下方行）
  const lastR = Math.min(targetR + rowspan - 1, rows.length - 1);
  for (let r = lastR; r >= targetR; r--) {
    const rowRef = rows[r];
    const newCells: Node[] = [];
    const gridRow = grid[r] ?? [];
    for (let c = 0; c < gridRow.length; c++) {
      const gc = gridRow[c];
      if (!gc) {
        // 占位 null：若处于"被目标 rowspan 覆盖"的列区间，则补一个空格
        if (
          r > targetR &&
          c >= targetC &&
          c < targetC + colspan
        ) {
          newCells.push(makeEmptyCellLike(targetCell));
        }
        continue;
      }
      if (gc.rowIdx === targetR && gc.colIdx === targetC) {
        // 锚点格：跨度复位 1；colspan>1 时在其后补 (colspan-1) 个空格
        newCells.push(
          gc.node.type.create(
            { ...gc.node.attrs, colspan: 1, rowspan: 1 },
            gc.node.content,
          ),
        );
        for (let k = 1; k < colspan; k++) newCells.push(makeEmptyCellLike(gc.node));
        continue;
      }
      newCells.push(gc.node);
    }
    const newRow = rowRef.row.type.create(null, newCells);
    tr.replaceWith(rowRef.pos, rowRef.pos + rowRef.row.nodeSize, newRow);
  }
  return tr;
}

/**
 * v0.13.1 需求4：把对齐**只应用到矩形范围内的单元格**（事务层）。
 *
 * ─── 为什么不能复用 setColumnAlign ───
 * `table-editor.setColumnAlign` 按 `row.child(colIdx)` 的**物理下标**写整列：
 *   · 语义上它改的是"整列"，用户拖拽选出 (0,0)-(0,1) 后点居中还应该只改这两格；
 *   · 实现上物理下标在含合并格的表格里**与逻辑列错位**——`| <td colspan="2">X</td> | C |`
 *     第 2 个物理格代表逻辑列 2，按物理下标就会改错列。
 * 本函数走 [`buildTableGridFromTable`] 的同一套逻辑网格（与合并/拆分/序列化同口径），
 * 因此跨度格不会错位。
 *
 * ─── 语义细节 ───
 * - 只改**锚点格**（`cell.rowIdx === r && cell.colIdx === c`）：跨列/跨行的合并格
 *   在网格里会在被占位的列上表现为 `null` 或重复引用，按锚点判定才能一格只改一次；
 *   合并格的锚点若落在矩形内，它就整体算"选中格"（跨度超出矩形的部分一并改——
 *   一个格子的 align 属性是整体的，无法只改它的一半）。
 * - 只对 `align` 真的不同的格调用 `setNodeMarkup`：全部已一致时返回 **null**，
 *   调用方据此不 dispatch（避免产生"空事务"污染撤销栈 / 触发幽灵的 docChange）。
 *
 * @param tr 事务（会被就地修改）
 * @param tablePos table 节点在 doc 中的起始位置
 * @param table table 节点
 * @param rect 矩形范围（逻辑行列，含端点）
 * @param align 'left' | 'center' | 'right'
 * @returns 有实际改动时返回 tr；无格可改 / 全部已是目标对齐时返回 null
 */
export function setRangeAlign(
  tr: Transaction,
  tablePos: number,
  table: Node,
  rect: CellRect,
  align: "left" | "center" | "right",
): Transaction | null {
  if (!table || table.type.name !== "table") return null;
  if (rect.r1 < rect.r0 || rect.c1 < rect.c0) return null;
  const grid = buildTableGridFromTable(table, tablePos);
  // cellPositionsOfGrid 给出的是「doc 位置 → 网格坐标」；这里要的是反向查表
  // （网格坐标 → doc 位置），故按坐标建索引。用 `pos` 而不是节点对象作 key：
  // 网格里的跨格镜像项引用同一节点，坐标索引能天然区分它们。
  const posByCoord = new Map<string, number>();
  for (const [pos, coord] of cellPositionsOfGrid(table, tablePos)) {
    posByCoord.set(`${coord.rowIdx},${coord.colIdx}`, pos);
  }

  let changed = false;
  for (let r = rect.r0; r <= rect.r1; r++) {
    const row = grid[r];
    if (!row) continue;
    for (let c = rect.c0; c <= rect.c1; c++) {
      const cell = row[c];
      // 只取锚点（跳过占位 null 与跨度的镜像项）
      if (!cell || cell.rowIdx !== r || cell.colIdx !== c) continue;
      if (cell.node.attrs.align === align) continue;
      const pos = posByCoord.get(`${r},${c}`);
      if (pos === undefined) continue; // 位置反查失败：跳过而不是写错位置
      const live = tr.doc.nodeAt(pos);
      const attrs = { ...(live ?? cell.node).attrs, align };
      tr.setNodeMarkup(pos, undefined, attrs);
      changed = true;
    }
  }
  return changed ? tr : null;
}

/** 造一个与给定 cell 同类型的空格（保留 align） */
function makeEmptyCellLike(cell: Node): Node {
  return cell.type.create({ ...cell.attrs, colspan: 1, rowspan: 1 }, []);
}

/** 表格是否含合并（供 UI 决定是否显示"拆分"入口） */
export function tableContainsSpan(table: Node): boolean {
  return tableHasSpan(table);
}

/** 逻辑列数（UI 展示/调试用） */
export function tableColumnCount(table: Node): number {
  return gridColumnCount(buildTableGridFromTable(table, 0));
}

export { normalizeSpan };
