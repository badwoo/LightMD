/**
 * G4 表格可视化编辑测试
 *
 * 测试 table-editor.ts 中 G4 阶段新增的纯函数：
 * - setColumnWidths / updateColumnWidth：列宽 attrs 修改
 * - setColumnAlign：整列对齐方式修改
 * - deleteTable：删除整个表格
 * - getTableColumnCount：列数计算
 * - insertColumnLeft/Right、deleteColumn 同步 columnWidths 数组
 *
 * 测试范围：纯函数部分（不涉及 DOM 交互、NodeView、工具栏 UI）
 * DOM 交互（列宽拖拽、工具栏点击）依赖运行时环境，不在单测覆盖
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
  setColumnWidths,
  updateColumnWidth,
  setColumnAlign,
  deleteTable,
  getTableColumnCount,
} from "../core/plugins/table-editor";
import { docToMarkdown } from "../core/markdown/serializer";

// ─── 构造辅助 ─────────────────────────────────────

/** 创建一个 cell（支持指定文本、是否表头、对齐方式） */
function makeCell(text: string, isHeader = false, align: "left" | "center" | "right" = "left"): Node {
  const type = isHeader ? schema.nodes.table_header : schema.nodes.table_cell;
  return type.create({ align }, text ? schema.text(text) : []);
}

/** 创建一个 row */
function makeRow(cells: Node[]): Node {
  return schema.nodes.table_row.create(null, cells);
}

/** 创建一个 table（可选 thead，至少 1 行 tbody；可选 columnWidths） */
function makeTable(
  headRow: Node | null,
  bodyRows: Node[],
  columnWidths: number[] | null = null
): Node {
  const children: Node[] = [];
  if (headRow) children.push(schema.nodes.table_head.create(null, headRow));
  children.push(schema.nodes.table_body.create(null, bodyRows));
  return schema.nodes.table.create({ columnWidths }, children);
}

/** 创建一个 doc，内容由 block 节点组成 */
function makeDoc(...blocks: Node[]): Node {
  return schema.topNodeType.create(null, blocks);
}

/** 构造标准测试表格：thead 1 行 + tbody 2 行，每行 2 cell */
function buildStandardTable(columnWidths: number[] | null = null): Node {
  return makeTable(
    makeRow([makeCell("H1", true), makeCell("H2", true)]),
    [makeRow([makeCell("A"), makeCell("B")]),
     makeRow([makeCell("C"), makeCell("D")])],
    columnWidths
  );
}

/** 查找 doc 中第 n 个 cell（0-indexed）的内容起始位置 */
function findCellContentPos(doc: Node, n: number): number | null {
  let count = 0;
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === "table_cell" || node.type.name === "table_header") {
      if (count === n) {
        found = pos + 1;
        return false;
      }
      count++;
      return false;
    }
    return true;
  });
  return found;
}

/** 在 doc 中第 n 个 cell 上应用 op，返回新 doc */
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

/** 应用 op 但允许返回 null */
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

// ─── getTableColumnCount 测试 ────────────────────────────

describe("getTableColumnCount", () => {
  it("标准表格（thead + tbody）列数 = 2", () => {
    const table = buildStandardTable();
    expect(getTableColumnCount(table)).toBe(2);
  });

  it("仅有 tbody 的表格也能正确计算列数", () => {
    const table = makeTable(null, [makeRow([makeCell("A"), makeCell("B"), makeCell("C")])]);
    expect(getTableColumnCount(table)).toBe(3);
  });

  it("空 table 返回 0", () => {
    // schema 要求 table_body 至少 1 行，但 getTableColumnCount 应防御性返回 0
    const table = makeTable(null, [makeRow([])]);
    expect(getTableColumnCount(table)).toBe(0);
  });
});

// ─── setColumnWidths / updateColumnWidth 测试 ────────────────────────────

describe("setColumnWidths", () => {
  it("设置 columnWidths 数组到 table attrs", () => {
    const doc = makeDoc(buildStandardTable());
    const newDoc = applyOp(doc, 0, (tr, $pos) => setColumnWidths(tr, $pos, [120, 80]));
    const table = newDoc.firstChild!;
    expect(table.attrs.columnWidths).toEqual([120, 80]);
  });

  it("传 null 重置为等宽（清空 columnWidths）", () => {
    // 先设置，再清空
    const doc = makeDoc(buildStandardTable([100, 100]));
    const newDoc = applyOp(doc, 0, (tr, $pos) => setColumnWidths(tr, $pos, null));
    expect(newDoc.firstChild!.attrs.columnWidths).toBeNull();
  });

  it("非表格位置返回 null", () => {
    const doc = makeDoc(schema.nodes.paragraph.create(null, schema.text("文本")));
    const state = EditorState.create({ doc });
    const tr = state.tr;
    const $pos = doc.resolve(1);
    expect(setColumnWidths(tr, $pos, [100, 100])).toBeNull();
  });
});

describe("updateColumnWidth", () => {
  it("在 null columnWidths 上更新单列：初始化为各列 100px 后修改指定列", () => {
    const doc = makeDoc(buildStandardTable());
    // colIdx=1 更新为 150px
    const newDoc = applyOp(doc, 0, (tr, $pos) => updateColumnWidth(tr, $pos, 1, 150));
    const widths = newDoc.firstChild!.attrs.columnWidths;
    expect(widths).toEqual([100, 150]);
  });

  it("在已有 columnWidths 上更新单列：仅修改指定列", () => {
    const doc = makeDoc(buildStandardTable([80, 120]));
    // colIdx=0 更新为 200px
    const newDoc = applyOp(doc, 0, (tr, $pos) => updateColumnWidth(tr, $pos, 0, 200));
    const widths = newDoc.firstChild!.attrs.columnWidths;
    expect(widths).toEqual([200, 120]);
  });

  it("宽度小于 20px 时被钳制为 20px（最小宽度限制）", () => {
    const doc = makeDoc(buildStandardTable());
    const newDoc = applyOp(doc, 0, (tr, $pos) => updateColumnWidth(tr, $pos, 0, 5));
    expect(newDoc.firstChild!.attrs.columnWidths![0]).toBe(20);
  });

  it("负宽度也被钳制为 20px", () => {
    const doc = makeDoc(buildStandardTable());
    const newDoc = applyOp(doc, 0, (tr, $pos) => updateColumnWidth(tr, $pos, 0, -50));
    expect(newDoc.firstChild!.attrs.columnWidths![0]).toBe(20);
  });

  it("宽度四舍五入到整数", () => {
    const doc = makeDoc(buildStandardTable());
    const newDoc = applyOp(doc, 0, (tr, $pos) => updateColumnWidth(tr, $pos, 0, 150.7));
    expect(newDoc.firstChild!.attrs.columnWidths![0]).toBe(151);
  });

  it("无效列索引返回 null", () => {
    const doc = makeDoc(buildStandardTable());
    const result = applyOpAllowNull(doc, 0, (tr, $pos) => updateColumnWidth(tr, $pos, 99, 100));
    expect(result).toBeNull();
  });

  it("负列索引返回 null", () => {
    const doc = makeDoc(buildStandardTable());
    const result = applyOpAllowNull(doc, 0, (tr, $pos) => updateColumnWidth(tr, $pos, -1, 100));
    expect(result).toBeNull();
  });

  it("非表格位置返回 null", () => {
    const doc = makeDoc(schema.nodes.paragraph.create(null, schema.text("文本")));
    const state = EditorState.create({ doc });
    const tr = state.tr;
    const $pos = doc.resolve(1);
    expect(updateColumnWidth(tr, $pos, 0, 100)).toBeNull();
  });
});

// ─── setColumnAlign 测试 ────────────────────────────────────

describe("setColumnAlign", () => {
  it("设置整列对齐：thead + tbody 同列所有 cell 同步", () => {
    const doc = makeDoc(buildStandardTable());
    // colIdx=0 (第一列) 设置为 center
    const newDoc = applyOp(doc, 0, (tr, $pos) => setColumnAlign(tr, $pos, "center"));
    const table = newDoc.firstChild!;
    // 收集所有 cell 的 align
    const aligns: string[] = [];
    table.forEach((section) => {
      section.forEach((row) => {
        row.forEach((cell, i) => {
          if (i === 0) aligns.push(cell.attrs.align);
        });
      });
    });
    // 第一列所有 cell 应为 center
    expect(aligns.every((a) => a === "center")).toBe(true);
    // 第二列保持 left
    const aligns2: string[] = [];
    table.forEach((section) => {
      section.forEach((row) => {
        row.forEach((cell, i) => {
          if (i === 1) aligns2.push(cell.attrs.align);
        });
      });
    });
    expect(aligns2.every((a) => a === "left")).toBe(true);
  });

  it("设置右对齐", () => {
    const doc = makeDoc(buildStandardTable());
    // colIdx=1 (第二列) 设置为 right
    const newDoc = applyOp(doc, 1, (tr, $pos) => setColumnAlign(tr, $pos, "right"));
    const table = newDoc.firstChild!;
    table.forEach((section) => {
      section.forEach((row) => {
        expect(row.child(1).attrs.align).toBe("right");
      });
    });
  });

  it("已有 align=center 时再设置 center：仍正确执行（无副作用）", () => {
    const table = makeTable(
      makeRow([makeCell("H1", true, "center"), makeCell("H2", true)]),
      [makeRow([makeCell("A", false, "center"), makeCell("B")])]
    );
    const doc = makeDoc(table);
    const newDoc = applyOp(doc, 0, (tr, $pos) => setColumnAlign(tr, $pos, "center"));
    // 验证仍为 center
    newDoc.firstChild!.forEach((section) => {
      section.forEach((row) => {
        expect(row.child(0).attrs.align).toBe("center");
      });
    });
  });

  it("align 通过 markdown 序列化输出 :---: 语法", () => {
    // 设置第一列 center，第二列 right
    let doc = makeDoc(buildStandardTable());
    doc = applyOp(doc, 0, (tr, $pos) => setColumnAlign(tr, $pos, "center"));
    doc = applyOp(doc, 1, (tr, $pos) => setColumnAlign(tr, $pos, "right"));
    const md = docToMarkdown(doc);
    // 第一列 center → :---:
    expect(md).toContain(":---:");
    // 第二列 right → ---:
    expect(md).toContain("---:");
  });

  it("非表格位置返回 null", () => {
    const doc = makeDoc(schema.nodes.paragraph.create(null, schema.text("文本")));
    const state = EditorState.create({ doc });
    const tr = state.tr;
    const $pos = doc.resolve(1);
    expect(setColumnAlign(tr, $pos, "center")).toBeNull();
  });
});

// ─── deleteTable 测试 ────────────────────────────────────

describe("deleteTable", () => {
  it("删除整个表格：doc 中表格消失", () => {
    const table = buildStandardTable();
    const doc = makeDoc(table);
    const newDoc = applyOp(doc, 0, deleteTable);
    // doc schema 要求至少一个 block，ProseMirror 删除唯一 block 后自动填充空段落
    expect(newDoc.childCount).toBe(1);
    expect(newDoc.firstChild!.type.name).toBe("paragraph");
    expect(newDoc.firstChild!.textContent).toBe("");
  });

  it("表格后还有内容时，仅删除表格本身", () => {
    const table = buildStandardTable();
    const para = schema.nodes.paragraph.create(null, schema.text("后面的段落"));
    const doc = makeDoc(table, para);
    const newDoc = applyOp(doc, 0, deleteTable);
    expect(newDoc.childCount).toBe(1);
    expect(newDoc.firstChild!.type.name).toBe("paragraph");
    expect(newDoc.firstChild!.textContent).toBe("后面的段落");
  });

  it("非表格位置返回 null", () => {
    const doc = makeDoc(schema.nodes.paragraph.create(null, schema.text("文本")));
    const state = EditorState.create({ doc });
    const tr = state.tr;
    const $pos = doc.resolve(1);
    expect(deleteTable(tr, $pos)).toBeNull();
  });
});

// ─── 行列增删同步 columnWidths 测试 ────────────────────────────

describe("行列操作同步 columnWidths", () => {
  it("左侧插入列：columnWidths 长度 +1，新列宽度 100px 在 colIdx 位置", () => {
    const doc = makeDoc(buildStandardTable([80, 120]));
    // colIdx=1 (第二列) 左侧插入
    const newDoc = applyOp(doc, 1, insertColumnLeft);
    const widths = newDoc.firstChild!.attrs.columnWidths;
    expect(widths).toEqual([80, 100, 120]);
  });

  it("左侧插入列（第一列）：columnWidths 在头部插入 100px", () => {
    const doc = makeDoc(buildStandardTable([80, 120]));
    // colIdx=0 (第一列) 左侧插入
    const newDoc = applyOp(doc, 0, insertColumnLeft);
    const widths = newDoc.firstChild!.attrs.columnWidths;
    expect(widths).toEqual([100, 80, 120]);
  });

  it("右侧插入列：columnWidths 长度 +1，新列宽度 100px 在 colIdx+1 位置", () => {
    const doc = makeDoc(buildStandardTable([80, 120]));
    // colIdx=0 (第一列) 右侧插入
    const newDoc = applyOp(doc, 0, insertColumnRight);
    const widths = newDoc.firstChild!.attrs.columnWidths;
    expect(widths).toEqual([80, 100, 120]);
  });

  it("右侧插入列（最后一列）：columnWidths 在尾部追加 100px", () => {
    const doc = makeDoc(buildStandardTable([80, 120]));
    // colIdx=1 (最后一列) 右侧插入
    const newDoc = applyOp(doc, 1, insertColumnRight);
    const widths = newDoc.firstChild!.attrs.columnWidths;
    expect(widths).toEqual([80, 120, 100]);
  });

  it("删除列：columnWidths 长度 -1，删除位置正确", () => {
    const doc = makeDoc(buildStandardTable([80, 120]));
    // colIdx=0 (第一列) 删除
    const newDoc = applyOp(doc, 0, deleteColumn);
    const widths = newDoc.firstChild!.attrs.columnWidths;
    expect(widths).toEqual([120]);
  });

  it("删除中间列：columnWidths 正确移除中间元素", () => {
    // 3 列表格
    const table = makeTable(
      makeRow([makeCell("H1", true), makeCell("H2", true), makeCell("H3", true)]),
      [makeRow([makeCell("A"), makeCell("B"), makeCell("C")])],
      [50, 100, 150]
    );
    const doc = makeDoc(table);
    // colIdx=1 (中间列) 删除
    const newDoc = applyOp(doc, 1, deleteColumn);
    const widths = newDoc.firstChild!.attrs.columnWidths;
    expect(widths).toEqual([50, 150]);
  });

  it("columnWidths 为 null 时插入列：保持 null（不自动初始化）", () => {
    const doc = makeDoc(buildStandardTable(null));
    const newDoc = applyOp(doc, 0, insertColumnRight);
    // null 时不同步，保持 null
    expect(newDoc.firstChild!.attrs.columnWidths).toBeNull();
  });

  it("columnWidths 为 null 时删除列：保持 null", () => {
    const doc = makeDoc(buildStandardTable(null));
    const newDoc = applyOp(doc, 0, deleteColumn);
    expect(newDoc.firstChild!.attrs.columnWidths).toBeNull();
  });

  it("插入行不影响 columnWidths", () => {
    const doc = makeDoc(buildStandardTable([80, 120]));
    const newDoc = applyOp(doc, 0, insertRowBelow);
    expect(newDoc.firstChild!.attrs.columnWidths).toEqual([80, 120]);
  });

  it("删除行不影响 columnWidths", () => {
    const doc = makeDoc(buildStandardTable([80, 120]));
    // 删除 tbody 第二行（cellIndex 4 = "C"）
    const newDoc = applyOp(doc, 4, deleteRow);
    expect(newDoc.firstChild!.attrs.columnWidths).toEqual([80, 120]);
  });
});

// ─── 列宽不影响 markdown 输出测试 ────────────────────────────

describe("列宽不影响 markdown 输出", () => {
  it("设置 columnWidths 后 markdown 输出与未设置时一致", () => {
    const docNoWidths = makeDoc(buildStandardTable(null));
    const docWithWidths = makeDoc(buildStandardTable([100, 200]));
    expect(docToMarkdown(docNoWidths)).toBe(docToMarkdown(docWithWidths));
  });

  it("调整列宽后 markdown 输出不变", () => {
    const doc = makeDoc(buildStandardTable());
    const docResized = applyOp(doc, 0, (tr, $pos) => updateColumnWidth(tr, $pos, 0, 500));
    // 重新构造未调整的 doc
    const docOriginal = makeDoc(buildStandardTable());
    expect(docToMarkdown(docResized)).toBe(docToMarkdown(docOriginal));
  });
});

// ─── 综合场景测试 ────────────────────────────────────

describe("综合场景", () => {
  it("插入列后调整新列宽度", () => {
    const doc = makeDoc(buildStandardTable([80, 120]));
    // colIdx=0 右侧插入新列（columnWidths = [80, 100, 120]）
    const docAfterInsert = applyOp(doc, 0, insertColumnRight);
    // 调整新列（colIdx=1）为 200px
    const docAfterResize = applyOp(docAfterInsert, 1, (tr, $pos) =>
      updateColumnWidth(tr, $pos, 1, 200)
    );
    expect(docAfterResize.firstChild!.attrs.columnWidths).toEqual([80, 200, 120]);
  });

  it("设置 align 后插入新列：新列继承参考 cell 的 align（已有设计，保持一致性）", () => {
    const doc = makeDoc(buildStandardTable());
    // 第一列设为 center
    const docAfterAlign = applyOp(doc, 0, (tr, $pos) => setColumnAlign(tr, $pos, "center"));
    // 右侧插入新列（新 cell 继承 refCell.attrs.align = center，与现有"保持原 cell align"行为一致）
    const docAfterInsert = applyOp(docAfterAlign, 0, insertColumnRight);
    const table = docAfterInsert.firstChild!;
    // 第一列保持 center
    table.forEach((section) => {
      section.forEach((row) => {
        expect(row.child(0).attrs.align).toBe("center");
        // 新列继承参考 cell 的 align = center（与 table-context-menu.test.ts 中"插入列时保持原 cell 的 align 属性"一致）
        expect(row.child(1).attrs.align).toBe("center");
      });
    });
  });

  it("对齐 + 列宽同时设置：互不干扰", () => {
    const doc = makeDoc(buildStandardTable());
    // 设置第一列 center
    let newDoc = applyOp(doc, 0, (tr, $pos) => setColumnAlign(tr, $pos, "center"));
    // 设置第一列宽度 200px
    newDoc = applyOp(newDoc, 0, (tr, $pos) => updateColumnWidth(tr, $pos, 0, 200));
    const table = newDoc.firstChild!;
    // 验证 align 和 columnWidths 都正确
    expect(table.attrs.columnWidths).toEqual([200, 100]);
    table.forEach((section) => {
      section.forEach((row) => {
        expect(row.child(0).attrs.align).toBe("center");
      });
    });
  });
});
