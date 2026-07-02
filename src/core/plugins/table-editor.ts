/**
 * TableEditor —— 表格 NodeView（可视化编辑）
 *
 * 修复：添加 contentDOM 让 ProseMirror 管理表格内容编辑
 * 实现右键菜单的行/列操作（基于 ProseMirror Transform，不引入新依赖）
 */
import type { NodeView, EditorView } from "prosemirror-view";
import type { Node, ResolvedPos } from "prosemirror-model";
import type { Transaction } from "prosemirror-state";
import { lightMDSchema as schema } from "../schema";

let activeMenu: HTMLElement | null = null;

function closeMenu() {
  if (activeMenu) { activeMenu.remove(); activeMenu = null; }
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

/** 左侧插入列：在当前 cell 之前插入新 cell（所有 row 同步，倒序避免位置偏移） */
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
  return tr;
}

/** 右侧插入列：在当前 cell 之后插入新 cell（所有 row 同步，倒序避免位置偏移） */
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

/** 删除当前列（所有 row 同步删除对应 cell；任一 row 仅剩 1 cell 时不删除） */
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
  return tr;
}

export class TableView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private view: EditorView;
  private getPos: () => number | undefined;

  constructor(node: Node, view: EditorView, getPos: () => number | undefined) {
    this.view = view;
    this.getPos = getPos;

    this.dom = document.createElement("div");
    this.dom.className = "table-wrapper";

    // contentDOM 是 ProseMirror 管理的 DOM 节点
    // ProseMirror 会自动将表格内容渲染到这里
    this.contentDOM = document.createElement("table");
    this.contentDOM.className = "pm-table";
    this.dom.appendChild(this.contentDOM);

    // 右键菜单
    this.dom.addEventListener("contextmenu", (e) => this.onContextMenu(e));
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
      btn.addEventListener("mouseenter", () => btn.style.background = "var(--bg-hover)");
      btn.addEventListener("mouseleave", () => btn.style.background = "none");
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
    return true;
  }

  ignoreMutation(): boolean {
    return false;
  }

  destroy() {
    closeMenu();
  }
}
