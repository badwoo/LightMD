/**
 * v0.13.0 需求12：表格合并/拆分 —— 纯函数层测试（tableGrid.ts）
 *
 * 覆盖：
 * - extractTdWrapper：形态识别（colspan / rowspan / 两者 / 非 td 内容 / th）
 * - buildTableGrid：逻辑列网格展开（含 rowspan 跨行占位）
 * - tableHasSpan：合并态判定（serializer 走哪条管道的开关）
 * - computeMergeRect / countCellsInRect / rectContainsSpan：选区判定
 * - planSplit：拆分判定
 */
import { describe, it, expect } from "vitest";
import type { Node as PmNode } from "prosemirror-model";
import {
  extractTdWrapper,
  normalizeSpan,
  spanOf,
  buildTableGrid,
  gridColumnCount,
  tableHasSpan,
  computeMergeRect,
  countCellsInRect,
  rectContainsSpan,
  planSplit,
  type TableGrid,
} from "../core/tableGrid";

/** 构造一个最小 cell 桩节点（只提供 spanOf 需要的 attrs） */
function cell(colspan = 1, rowspan = 1): PmNode {
  return { attrs: { colspan, rowspan } } as unknown as PmNode;
}

/** 构造一个最小 row 桩节点（forEach 语义与 PM Node 一致） */
function row(cells: PmNode[]): PmNode {
  return {
    forEach(f: (n: PmNode, offset: number, index: number) => void) {
      cells.forEach((n, i) => f(n, 0, i));
    },
  } as unknown as PmNode;
}

/** 构造 table 桩节点（forEach 展开 section → row → cell） */
function table(rows: PmNode[]): PmNode {
  const section = {
    type: { name: "table_body" },
    forEach(f: (n: PmNode, offset: number, index: number) => void) {
      rows.forEach((n, i) => f(n, 0, i));
    },
  };
  return {
    forEach(f: (n: PmNode, offset: number, index: number) => void) {
      f(section as unknown as PmNode, 0, 0);
    },
  } as unknown as PmNode;
}

describe("v0.13.0 需求12 normalizeSpan / spanOf", () => {
  it("正整数 >1 生效；1 与非法值回落 1", () => {
    expect(normalizeSpan(3)).toBe(3);
    expect(normalizeSpan("2")).toBe(2);
    expect(normalizeSpan(1)).toBe(1);
    expect(normalizeSpan(0)).toBe(1);
    expect(normalizeSpan(-2)).toBe(1);
    expect(normalizeSpan("abc")).toBe(1);
    expect(normalizeSpan(undefined)).toBe(1);
    expect(normalizeSpan(null)).toBe(1);
  });

  it("spanOf 从 attrs 读跨度（缺省 1）", () => {
    expect(spanOf(cell())).toEqual({ colspan: 1, rowspan: 1 });
    expect(spanOf(cell(2, 3))).toEqual({ colspan: 2, rowspan: 3 });
  });
});

describe("v0.13.0 需求12 extractTdWrapper", () => {
  it("识别 <td colspan=\"2\">A</td>", () => {
    const r = extractTdWrapper('<td colspan="2">A</td>');
    expect(r).toEqual({ tag: "td", span: { colspan: 2, rowspan: 1 }, inner: "A" });
  });

  it("识别 colspan + rowspan（属性顺序任意）", () => {
    const r = extractTdWrapper('<td rowspan="2" colspan="3">X</td>');
    expect(r?.span).toEqual({ colspan: 3, rowspan: 2 });
    expect(r?.inner).toBe("X");
  });

  it("识别 <th>（表头合并）", () => {
    const r = extractTdWrapper('<th colspan="2">H</th>');
    expect(r?.tag).toBe("th");
    expect(r?.span.colspan).toBe(2);
  });

  it("单引号与无引号属性同样识别", () => {
    expect(extractTdWrapper("<td colspan='2'>A</td>")?.span.colspan).toBe(2);
    expect(extractTdWrapper("<td colspan=2>A</td>")?.span.colspan).toBe(2);
  });

  it("内层含 markdown 语法整体保留", () => {
    const r = extractTdWrapper('<td colspan="2">**粗** 和 `code`</td>');
    expect(r?.inner).toBe("**粗** 和 `code`");
  });

  it("内层为空字符串也识别（合并空单元格）", () => {
    const r = extractTdWrapper('<td colspan="2"></td>');
    expect(r).toEqual({ tag: "td", span: { colspan: 2, rowspan: 1 }, inner: "" });
  });

  it("非 td 整体包裹 → null（不误判普通单元格）", () => {
    expect(extractTdWrapper("A")).toBeNull();
    expect(extractTdWrapper("<span>A</span>")).toBeNull();
    expect(extractTdWrapper("A <td colspan=\"2\">B</td>")).toBeNull();
    expect(extractTdWrapper("")).toBeNull();
  });

  it("colspan=1 不构成合并 → 仍识别但 span 为 1（调用方据此走普通路径）", () => {
    const r = extractTdWrapper('<td colspan="1">A</td>');
    expect(r?.span).toEqual({ colspan: 1, rowspan: 1 });
  });

  it("内层再嵌套 td 不识别（只取最外层一层）", () => {
    expect(extractTdWrapper('<td colspan="2"><td>A</td></td>')).toBeNull();
  });
});

describe("v0.13.0 需求12 buildTableGrid", () => {
  it("纯管道表格（无合并）→ 每格占一列，与行内顺序一致", () => {
    const grid = buildTableGrid([row([cell(), cell(), cell()]), row([cell(), cell()])]);
    expect(grid).toHaveLength(2);
    expect(grid[0]).toHaveLength(3);
    expect(grid[1]).toHaveLength(2);
    expect(grid[0][0]?.node).toBeDefined();
    expect(grid[0][2]?.colIdx).toBe(2);
  });

  it("colspan=2 → 主格记录跨度，右侧一列被占位（null）", () => {
    // row([cell(2), cell()]) = `| <td colspan="2">A</td> | B |`：
    // A 占列 0-1，B 落到列 2 → 该行逻辑宽度 3
    const grid = buildTableGrid([row([cell(2), cell()])]);
    expect(grid[0]).toHaveLength(3);
    expect(grid[0][0]?.colspan).toBe(2);
    expect(grid[0][1]).toBeNull();
    expect(grid[0][2]).not.toBeNull();
  });

  it("rowspan=2 → 下方行同列被占位（null）", () => {
    // 行0: [A(1x2), B]；行1: [C, D]
    // A 占 rows0-1 col0 → 行1 的 C 落 col1、D 落 col2
    const grid = buildTableGrid([row([cell(1, 2), cell()]), row([cell(), cell()])]);
    expect(grid).toHaveLength(2);
    expect(grid[0][0]?.rowspan).toBe(2);
    // 第二行第 0 列被 rowspan 占据
    expect(grid[1][0]).toBeNull();
    expect(grid[1][1]).not.toBeNull();
    expect(grid[1][2]).not.toBeNull();
  });

  it("colspan+rowspan 同时存在 → 占位矩形正确", () => {
    // 行0: [X(2x2), C]；行1: [D, E]
    // X 占 rows0-1 × cols0-1；C 在 row0 col2；
    // 行1 的 col0/col1 被 X 的 rowspan 占据 → D 落 col2、E 落 col3
    const grid = buildTableGrid([
      row([cell(2, 2), cell()]),
      row([cell(), cell()]),
    ]);
    expect(grid[0][0]?.colspan).toBe(2);
    expect(grid[0][0]?.rowspan).toBe(2);
    expect(grid[0][1]).toBeNull(); // 本行右格被 colspan 占
    expect(grid[0][2]).not.toBeNull(); // C
    expect(grid[1][0]).toBeNull(); // 下行 col0 被 rowspan 占
    expect(grid[1][1]).toBeNull(); // 下行 col1 被 rowspan 占
    expect(grid[1][2]).not.toBeNull(); // D
    expect(grid[1][3]).not.toBeNull(); // E
  });

  it("rowspan 落在不同起始列 → 各自独立占位", () => {
    // 行0: [A(1x2), B(1x2)]；行1: [C, D]
    const grid = buildTableGrid([row([cell(1, 2), cell(1, 2)]), row([cell(), cell()])]);
    expect(grid[1][0]).toBeNull();
    expect(grid[1][1]).toBeNull();
  });

  it("空表（无行）→ 空网格", () => {
    expect(buildTableGrid([])).toEqual([]);
  });

  it("gridColumnCount 取最长行", () => {
    expect(gridColumnCount(buildTableGrid([row([cell(), cell()]), row([cell(), cell(), cell()])]))).toBe(3);
    expect(gridColumnCount(buildTableGrid([]))).toBe(0);
  });
});

describe("v0.13.0 需求12 tableHasSpan", () => {
  it("纯管道表格 → false（serializer 走原管道，零 diff）", () => {
    expect(tableHasSpan(table([row([cell(), cell()])]))).toBe(false);
  });

  it("含 colspan → true", () => {
    expect(tableHasSpan(table([row([cell(2), cell()])]))).toBe(true);
  });

  it("含 rowspan → true", () => {
    expect(tableHasSpan(table([row([cell(1, 2), cell()]), row([cell(), cell()])]))).toBe(true);
  });
});

describe("v0.13.0 需求12 computeMergeRect", () => {
  it("2×2 矩形", () => {
    const rect = computeMergeRect([
      { rowIdx: 0, colIdx: 0 },
      { rowIdx: 0, colIdx: 1 },
      { rowIdx: 1, colIdx: 0 },
      { rowIdx: 1, colIdx: 1 },
    ]);
    expect(rect).toEqual({ r0: 0, c0: 0, r1: 1, c1: 1 });
  });

  it("单行 1×3 矩形", () => {
    expect(
      computeMergeRect([
        { rowIdx: 2, colIdx: 0 },
        { rowIdx: 2, colIdx: 1 },
        { rowIdx: 2, colIdx: 2 },
      ]),
    ).toEqual({ r0: 2, c0: 0, r1: 2, c1: 2 });
  });

  it("少于 2 个 cell → null", () => {
    expect(computeMergeRect([{ rowIdx: 0, colIdx: 0 }])).toBeNull();
    expect(computeMergeRect([])).toBeNull();
  });
});

describe("v0.13.0 需求12 countCellsInRect", () => {
  // 行0: [X(2x2), C] → X 占 col0-1，C 落 col2
  // 行1: [D, E]  → D 落 col2，E 落 col3
  const grid: TableGrid = buildTableGrid([
    row([cell(2, 2), cell()]),
    row([cell(), cell()]),
  ]);

  it("矩形覆盖真实格子才计数（占位 null 不计）", () => {
    // 行0 的 2 列只有 1 个真实格子（X）
    expect(countCellsInRect(grid, { r0: 0, c0: 0, r1: 0, c1: 1 })).toBe(1);
    // (0,0)-(1,1)：X + 两个占位 = 1 个真实格
    expect(countCellsInRect(grid, { r0: 0, c0: 0, r1: 1, c1: 1 })).toBe(1);
    // 全表：X / C / D / E = 4
    expect(countCellsInRect(grid, { r0: 0, c0: 0, r1: 1, c1: 3 })).toBe(4);
  });

  it("矩形越界 → 不崩，按实际存在的格计数", () => {
    expect(countCellsInRect(grid, { r0: 0, c0: 0, r1: 9, c1: 9 })).toBe(4);
  });
});

describe("v0.13.0 需求12 rectContainsSpan", () => {
  it("矩形内除锚点外无跨度 → false（可合并）", () => {
    const grid = buildTableGrid([row([cell(), cell(), cell()]), row([cell(), cell(), cell()])]);
    expect(rectContainsSpan(grid, { r0: 0, c0: 0, r1: 1, c1: 1 })).toBe(false);
  });

  it("矩形把别的跨度格切碎 → true（需先拆分）", () => {
    // 行0: [X(2x1), B] → X 占 col0-1；行1: [C, D]
    const grid = buildTableGrid([row([cell(2), cell()]), row([cell(), cell()])]);
    // 矩形 (0,0)-(1,0)：X 只被部分覆盖（col1 在矩形外）→ 破坏
    expect(rectContainsSpan(grid, { r0: 0, c0: 0, r1: 1, c1: 0 })).toBe(true);
    // 矩形 (0,0)-(0,1)：完整吞掉 X（锚点自身可带跨度）→ 不破坏
    expect(rectContainsSpan(grid, { r0: 0, c0: 0, r1: 0, c1: 1 })).toBe(false);
    // 矩形 (0,0)-(1,1)：X 完整落在内 → 不破坏
    expect(rectContainsSpan(grid, { r0: 0, c0: 0, r1: 1, c1: 1 })).toBe(false);
  });

  it("rowspan 被部分覆盖 → true", () => {
    // 行0: [A(1x3), B]；行1: [C, D]；行2: [E, F]
    // A 占 rows0-2 col0
    const grid = buildTableGrid([
      row([cell(1, 3), cell()]),
      row([cell(), cell()]),
      row([cell(), cell()]),
    ]);
    // 矩形只覆盖 rows0-1 col0 → A 的 rowspan 伸出矩形（row2）→ 破坏
    expect(rectContainsSpan(grid, { r0: 0, c0: 0, r1: 1, c1: 0 })).toBe(true);
    // 矩形覆盖 rows0-2 col0 → 完整吞掉 A
    expect(rectContainsSpan(grid, { r0: 0, c0: 0, r1: 2, c1: 0 })).toBe(false);
  });

  it("锚点自身有跨度且完整落在矩形内 → 不算破坏", () => {
    const grid = buildTableGrid([row([cell(2, 2), cell()]), row([cell(), cell()])]);
    // 锚点 (0,0) 自身 2x2，矩形就是它自己
    expect(rectContainsSpan(grid, { r0: 0, c0: 0, r1: 1, c1: 1 })).toBe(false);
  });
});

describe("v0.13.0 需求12 planSplit", () => {
  it("跨度格 → 复位为 1", () => {
    expect(planSplit({ colspan: 2, rowspan: 1, node: cell(), rowIdx: 0, colIdx: 0 })).toEqual({
      colspan: 1,
      rowspan: 1,
    });
  });

  it("普通格 → null（无需拆分）", () => {
    expect(planSplit({ colspan: 1, rowspan: 1, node: cell(), rowIdx: 0, colIdx: 0 })).toBeNull();
  });

  it("null 格 → null", () => {
    expect(planSplit(null)).toBeNull();
  });
});
