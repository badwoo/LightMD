/**
 * 表格右键菜单功能测试
 *
 * 测试 table-editor.ts 中导出的行/列操作纯函数：
 * - insertRowAbove / insertRowBelow：插入行
 * - insertColumnLeft / insertColumnRight：插入列
 * - deleteRow / deleteColumn：删除行/列
 * - cellAround / rowAround / tableAround：表格结构定位工具
 *
 * 覆盖场景：thead/tbody 行差异、schema 边界保护、列同步操作
 */
import { describe, it, expect } from "vitest";
import { EditorState } from "prosemirror-state";
import { Node } from "prosemirror-model";
import { lightMDSchema as schema } from "../core/schema";
import {
  insertRowAbove,
  insertRowBelow,
  insertColumnLeft,
  insertColumnRight,
  deleteRow,
  deleteColumn,
  cellAround,
  rowAround,
  tableAround,
} from "../core/plugins/table-editor";

// ─── 构造辅助 ─────────────────────────────────────

/** 创建一个 cell（支持指定文本、是否表头、对齐方式） */
function makeCell(text: string, isHeader = false, align = "left"): Node {
  const type = isHeader ? schema.nodes.table_header : schema.nodes.table_cell;
  return type.create({ align }, text ? schema.text(text) : []);
}

/** 创建一个 row */
function makeRow(cells: Node[]): Node {
  return schema.nodes.table_row.create(null, cells);
}

/** 创建一个 table（可选 thead，至少 1 行 tbody） */
function makeTable(headRow: Node | null, bodyRows: Node[]): Node {
  const children: Node[] = [];
  if (headRow) children.push(schema.nodes.table_head.create(null, headRow));
  children.push(schema.nodes.table_body.create(null, bodyRows));
  return schema.nodes.table.create(null, children);
}

/** 创建一个 doc，内容由 block 节点组成 */
function makeDoc(...blocks: Node[]): Node {
  return schema.topNodeType.create(null, blocks);
}

/**
 * 查找 doc 中第 n 个 cell（0-indexed，按 doc 顺序）的内容起始位置。
 * 返回 cell 内的第一个位置（pos + 1）。
 */
function findCellContentPos(doc: Node, n: number): number | null {
  let count = 0;
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === "table_cell" || node.type.name === "table_header") {
      if (count === n) {
        found = pos + 1; // cell 内容起始位置
        return false;
      }
      count++;
      return false; // 不深入 cell
    }
    return true;
  });
  return found;
}

/**
 * 在 doc 中第 n 个 cell 上应用 op，返回新 doc。
 * 断言 op 不返回 null。
 */
function applyOp(
  doc: Node,
  cellIndex: number,
  op: (tr: EditorState["tr"], $pos: ReturnType<Node["resolve"]>) => typeof tr | null
): Node {
  const pos = findCellContentPos(doc, cellIndex);
  expect(pos).not.toBeNull();
  const state = EditorState.create({ doc });
  const tr = state.tr;
  const $pos = doc.resolve(pos!);
  const newTr = op(tr, $pos);
  expect(newTr).not.toBeNull();
  return newTr!.doc;
}

/** 应用 op 但允许返回 null（用于测试 schema 保护场景） */
function applyOpAllowNull(
  doc: Node,
  cellIndex: number,
  op: (tr: EditorState["tr"], $pos: ReturnType<Node["resolve"]>) => typeof tr | null
): typeof tr | null {
  const pos = findCellContentPos(doc, cellIndex);
  expect(pos).not.toBeNull();
  const state = EditorState.create({ doc });
  const tr = state.tr;
  const $pos = doc.resolve(pos!);
  return op(tr, $pos);
}

/** 构造标准测试表格：thead 1 行 + tbody 2 行，每行 2 cell */
function buildStandardTable(): Node {
  return makeTable(
    makeRow([makeCell("H1", true), makeCell("H2", true)]),
    [makeRow([makeCell("A"), makeCell("B")]),
     makeRow([makeCell("C"), makeCell("D")])]
  );
}

// ─── 工具函数测试 ──────────────────────────────────────

describe("表格结构定位工具", () => {
  it("cellAround 应识别 table_header 节点", () => {
    const doc = makeDoc(buildStandardTable());
    // cellIndex 0 = thead "H1"
    const $pos = doc.resolve(findCellContentPos(doc, 0)!);
    const cell = cellAround($pos);
    expect(cell).not.toBeNull();
    expect(cell!.node.type.name).toBe("table_header");
  });

  it("cellAround 应识别 table_cell 节点", () => {
    const doc = makeDoc(buildStandardTable());
    // cellIndex 2 = tbody "A"
    const $pos = doc.resolve(findCellContentPos(doc, 2)!);
    const cell = cellAround($pos);
    expect(cell).not.toBeNull();
    expect(cell!.node.type.name).toBe("table_cell");
  });

  it("cellAround 在非 cell 位置应返回 null", () => {
    const doc = makeDoc(schema.nodes.paragraph.create(null, schema.text("文本")));
    const $pos = doc.resolve(1);
    expect(cellAround($pos)).toBeNull();
  });

  it("rowAround 应识别 row 节点", () => {
    const doc = makeDoc(buildStandardTable());
    const $pos = doc.resolve(findCellContentPos(doc, 2)!);
    const row = rowAround($pos);
    expect(row).not.toBeNull();
    expect(row!.node.type.name).toBe("table_row");
  });

  it("tableAround 应识别 table 节点", () => {
    const doc = makeDoc(buildStandardTable());
    const $pos = doc.resolve(findCellContentPos(doc, 2)!);
    const tbl = tableAround($pos);
    expect(tbl).not.toBeNull();
    expect(tbl!.node.type.name).toBe("table");
  });
});

// ─── 插入行测试 ──────────────────────────────────────

describe("插入行", () => {
  it("上方插入行（tbody 行）：tbody 行数 +1，新行在原行上方且为空", () => {
    const doc = makeDoc(buildStandardTable());
    // cellIndex 2 = tbody "A"（第一行第一列）
    const newDoc = applyOp(doc, 2, insertRowAbove);
    const table = newDoc.firstChild!;
    // 结构保持：thead + tbody
    expect(table.firstChild!.type.name).toBe("table_head");
    expect(table.lastChild!.type.name).toBe("table_body");
    const body = table.lastChild!;
    expect(body.childCount).toBe(3); // 原 2 行 + 新 1 行
    // 新行是 tbody 第一行（空 cell）
    const newRow = body.child(0);
    newRow.forEach((cell) => {
      expect(cell.childCount).toBe(0); // 空 cell
    });
    // 原行 "A" 现在是第二行
    expect(body.child(1).child(0).textContent).toBe("A");
  });

  it("下方插入行（tbody 行）：tbody 行数 +1，新行在原行下方且为空", () => {
    const doc = makeDoc(buildStandardTable());
    const newDoc = applyOp(doc, 2, insertRowBelow);
    const body = newDoc.firstChild!.lastChild!;
    expect(body.childCount).toBe(3);
    // 原行 "A" 仍是第一行
    expect(body.child(0).child(0).textContent).toBe("A");
    // 新行是第二行（空 cell）
    const newRow = body.child(1);
    newRow.forEach((cell) => {
      expect(cell.childCount).toBe(0);
    });
    // 原行 "C" 仍是第三行
    expect(body.child(2).child(0).textContent).toBe("C");
  });

  it("上方插入行（thead 行）：受 schema 限制，转为在 tbody 顶部插入", () => {
    const doc = makeDoc(buildStandardTable());
    // cellIndex 0 = thead "H1"
    const newDoc = applyOp(doc, 0, insertRowAbove);
    const table = newDoc.firstChild!;
    // thead 仍为 1 行
    expect(table.firstChild!.childCount).toBe(1);
    // tbody 行数 +1
    const body = table.lastChild!;
    expect(body.childCount).toBe(3);
  });

  it("下方插入行（thead 行）：在 tbody 顶部插入新行", () => {
    const doc = makeDoc(buildStandardTable());
    const newDoc = applyOp(doc, 0, insertRowBelow);
    const table = newDoc.firstChild!;
    expect(table.firstChild!.childCount).toBe(1); // thead 不变
    const body = table.lastChild!;
    expect(body.childCount).toBe(3);
    // 新行在 tbody 第一行（空 cell）
    body.child(0).forEach((cell) => {
      expect(cell.childCount).toBe(0);
    });
  });

  it("插入行后保持 cell 数量一致", () => {
    const doc = makeDoc(buildStandardTable());
    const newDoc = applyOp(doc, 2, insertRowBelow);
    const body = newDoc.firstChild!.lastChild!;
    body.forEach((row) => {
      expect(row.childCount).toBe(2); // 每行仍是 2 cell
    });
  });
});

// ─── 插入列测试 ──────────────────────────────────────

describe("插入列", () => {
  it("左侧插入列：所有 row 的 cell 数 +1，新 cell 在原 cell 之前", () => {
    const doc = makeDoc(buildStandardTable());
    // cellIndex 2 = tbody "A"（第一列）
    const newDoc = applyOp(doc, 2, insertColumnLeft);
    const table = newDoc.firstChild!;
    // thead 仍 1 行
    const head = table.firstChild!;
    expect(head.childCount).toBe(1);
    expect(head.child(0).childCount).toBe(3); // 原 2 cell + 新 1 cell = 3 cell
    // 第一个 cell 是新插入的（空）
    expect(head.child(0).child(0).childCount).toBe(0);
    // tbody 仍 2 行
    const body = table.lastChild!;
    expect(body.childCount).toBe(2);
    body.forEach((row) => {
      expect(row.childCount).toBe(3); // 3 cell
      // 第一个 cell 是新插入的（空）
      expect(row.child(0).childCount).toBe(0);
    });
  });

  it("右侧插入列：所有 row 的 cell 数 +1，新 cell 在原 cell 之后", () => {
    const doc = makeDoc(buildStandardTable());
    const newDoc = applyOp(doc, 2, insertColumnRight);
    const body = newDoc.firstChild!.lastChild!;
    body.forEach((row) => {
      expect(row.childCount).toBe(3);
      // 第一个 cell 是原来的（"A" 或 "C"）
      expect(row.child(0).textContent).toMatch(/[AC]/);
      // 第二个 cell 是新插入的（空）
      expect(row.child(1).childCount).toBe(0);
    });
  });

  it("右侧插入列（最后一列）：新 cell 在最后一列之后", () => {
    const doc = makeDoc(buildStandardTable());
    // cellIndex 3 = tbody "B"（最后一列）
    const newDoc = applyOp(doc, 3, insertColumnRight);
    const body = newDoc.firstChild!.lastChild!;
    body.forEach((row) => {
      expect(row.childCount).toBe(3);
      // 最后一个 cell 是新插入的（空）
      expect(row.child(2).childCount).toBe(0);
    });
  });

  it("插入列时保持原 cell 的 align 属性", () => {
    // 构造 align=center 的 cell
    const table = makeTable(
      makeRow([makeCell("H1", true, "center"), makeCell("H2", true, "center")]),
      [makeRow([makeCell("A", false, "center"), makeCell("B", false, "center")])]
    );
    const doc = makeDoc(table);
    const newDoc = applyOp(doc, 2, insertColumnLeft);
    const body = newDoc.firstChild!.lastChild!;
    body.forEach((row) => {
      // 新插入的 cell 应继承 align=center
      expect(row.child(0).attrs.align).toBe("center");
    });
  });
});

// ─── 删除行测试 ──────────────────────────────────────

describe("删除行", () => {
  it("删除 tbody 中间行：tbody 行数 -1", () => {
    const doc = makeDoc(buildStandardTable());
    // cellIndex 4 = tbody "C"（第二行第一列）
    const newDoc = applyOp(doc, 4, deleteRow);
    const body = newDoc.firstChild!.lastChild!;
    expect(body.childCount).toBe(1);
    expect(body.child(0).child(0).textContent).toBe("A");
  });

  it("删除 thead 行：删除整个 table_head", () => {
    const doc = makeDoc(buildStandardTable());
    // cellIndex 0 = thead "H1"
    const newDoc = applyOp(doc, 0, deleteRow);
    const table = newDoc.firstChild!;
    // thead 已删除，第一个子节点是 tbody
    expect(table.firstChild!.type.name).toBe("table_body");
    // tbody 仍 2 行
    expect(table.firstChild!.childCount).toBe(2);
  });

  it("删除 tbody 仅剩的一行：返回 null（schema 保护）", () => {
    const table = makeTable(
      makeRow([makeCell("H1", true), makeCell("H2", true)]),
      [makeRow([makeCell("A"), makeCell("B")])] // 仅 1 行 tbody
    );
    const doc = makeDoc(table);
    const result = applyOpAllowNull(doc, 2, deleteRow);
    expect(result).toBeNull();
  });

  it("删除非表格位置：返回 null", () => {
    const doc = makeDoc(schema.nodes.paragraph.create(null, schema.text("文本")));
    const state = EditorState.create({ doc });
    const tr = state.tr;
    const $pos = doc.resolve(1);
    expect(deleteRow(tr, $pos)).toBeNull();
  });
});

// ─── 删除列测试 ──────────────────────────────────────

describe("删除列", () => {
  it("删除列：所有 row 的 cell 数 -1", () => {
    const doc = makeDoc(buildStandardTable());
    // cellIndex 2 = tbody "A"（第一列）
    const newDoc = applyOp(doc, 2, deleteColumn);
    const table = newDoc.firstChild!;
    // thead 仍 1 行
    const head = table.firstChild!;
    expect(head.child(0).childCount).toBe(1); // 原 2 cell → 1 cell
    // 验证删除的是第一列：剩余 cell 文本应为 "H2"
    expect(head.child(0).child(0).textContent).toBe("H2");
    // tbody 仍 2 行，每行 1 cell
    const body = table.lastChild!;
    body.forEach((row) => {
      expect(row.childCount).toBe(1);
    });
    expect(body.child(0).child(0).textContent).toBe("B");
    expect(body.child(1).child(0).textContent).toBe("D");
  });

  it("删除最后一列：剩余 cell 是第一列", () => {
    const doc = makeDoc(buildStandardTable());
    // cellIndex 3 = tbody "B"（最后一列）
    const newDoc = applyOp(doc, 3, deleteColumn);
    const body = newDoc.firstChild!.lastChild!;
    body.forEach((row) => {
      expect(row.childCount).toBe(1);
    });
    expect(body.child(0).child(0).textContent).toBe("A");
    expect(body.child(1).child(0).textContent).toBe("C");
  });

  it("任一 row 仅剩 1 cell 时不删除（schema 保护）", () => {
    // thead 只有 1 cell，tbody 有 2 cell
    const table = makeTable(
      makeRow([makeCell("H1", true)]),
      [makeRow([makeCell("A"), makeCell("B")])]
    );
    const doc = makeDoc(table);
    // cellIndex 1 = tbody "A"
    const result = applyOpAllowNull(doc, 1, deleteColumn);
    expect(result).toBeNull();
  });

  it("删除非表格位置：返回 null", () => {
    const doc = makeDoc(schema.nodes.paragraph.create(null, schema.text("文本")));
    const state = EditorState.create({ doc });
    const tr = state.tr;
    const $pos = doc.resolve(1);
    expect(deleteColumn(tr, $pos)).toBeNull();
  });
});

// ─── 边界场景测试 ──────────────────────────────────────

describe("边界场景", () => {
  it("仅有 tbody 的表格也支持插入行", () => {
    // 没有 thead 的表格
    const table = makeTable(
      null,
      [makeRow([makeCell("A"), makeCell("B")]),
       makeRow([makeCell("C"), makeCell("D")])]
    );
    const doc = makeDoc(table);
    // cellIndex 0 = "A"
    const newDoc = applyOp(doc, 0, insertRowAbove);
    const body = newDoc.firstChild!.firstChild!;
    expect(body.type.name).toBe("table_body");
    expect(body.childCount).toBe(3); // 原 2 行 + 新 1 行
  });

  it("插入列后再删除列，表格结构恢复", () => {
    const doc = makeDoc(buildStandardTable());
    // 插入列
    const docAfterInsert = applyOp(doc, 2, insertColumnRight);
    // 在新插入的列上删除列（cellIndex 3 = 新插入的空 cell）
    const docAfterDelete = applyOp(docAfterInsert, 3, deleteColumn);
    const body = docAfterDelete.firstChild!.lastChild!;
    body.forEach((row) => {
      expect(row.childCount).toBe(2); // 恢复为 2 cell
    });
  });
});
