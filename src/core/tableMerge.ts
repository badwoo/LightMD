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
