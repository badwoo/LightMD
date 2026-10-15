/**
 * v0.13.0 需求12：表格合并/拆分 —— 事务层测试（tableMerge.ts）
 *
 * 用**真实 markdownToDoc 文档** + EditorState 事务验证：
 * - checkMergeable / checkSplittable 前置校验真值表
 * - mergeCells：合并后跨度正确、矩形外格不错位、序列化回 HTML 形态
 * - splitCell：跨度复位 + 补占位格（列不错位）
 * - 含合并表格上的列宽/对齐/表头删除不崩
 */
import { describe, it, expect } from "vitest";
import { EditorState } from "prosemirror-state";
import type { Node as PmNode } from "prosemirror-model";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import { lightMDSchema as schema } from "../core/schema";
import {
  mergeCells,
  splitCell,
  checkMergeable,
  checkSplittable,
  tableContainsSpan,
  tableColumnCount,
  type CellRect,
} from "../core/tableMerge";

/** 建一个带 doc 的 state（无插件即可跑事务） */
function stateOf(md: string): EditorState {
  return EditorState.create({ doc: markdownToDoc(md) });
}

/** 取 table 节点与位置 */
function tableOf(state: EditorState): { pos: number; node: PmNode } {
  let pos = -1;
  let node: PmNode | null = null;
  state.doc.descendants((n, p) => {
    if (n.type.name === "table" && pos < 0) {
      pos = p;
      node = n;
      return false;
    }
    return true;
  });
  if (!node) throw new Error("doc 中没有 table 节点");
  return { pos, node };
}

/** 应用合并并返回新 state */
function applyMerge(md: string, rect: CellRect): EditorState {
  const state = stateOf(md);
  const { pos, node } = tableOf(state);
  const tr = state.tr;
  const out = mergeCells(tr, pos, node, rect);
  expect(out).not.toBeNull();
  return state.apply(out!);
}

/** 取 doc 中第 idx 个 cell（0-based，按文档顺序） */
function cellAt(state: EditorState, idx: number) {
  let i = 0;
  let found: { colspan: number; rowspan: number; text: string } | null = null;
  state.doc.descendants((n) => {
    if (n.type.name !== "table_cell" && n.type.name !== "table_header") return true;
    const cur = i;
    i++; // 必须无条件自增：否则命中后 i 恒等于 idx，后续格会反复覆盖 found
    if (cur === idx) {
      found = {
        colspan: Number(n.attrs.colspan) || 1,
        rowspan: Number(n.attrs.rowspan) || 1,
        text: n.textContent,
      };
      return false;
    }
    return true;
  });
  return found!;
}

/** doc 中 cell 总数 */
function cellCount(state: EditorState): number {
  let n = 0;
  state.doc.descendants((node) => {
    if (node.type.name === "table_cell" || node.type.name === "table_header") n++;
    return true;
  });
  return n;
}

/** 序列化当前 state 的 doc */
function mdOf(state: EditorState): string {
  return docToMarkdown(state.doc);
}

const T3 = "| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n";

describe("v0.13.0 需求12 checkMergeable", () => {
  it("2×2 矩形（纯管道表格）→ ok", () => {
    const { node } = tableOf(stateOf(T3));
    expect(checkMergeable(node, { r0: 1, c0: 0, r1: 2, c1: 1 }, 4)).toEqual({ ok: true });
  });

  it("单格 → too-few", () => {
    const { node } = tableOf(stateOf(T3));
    expect(checkMergeable(node, { r0: 1, c0: 0, r1: 1, c1: 0 }, 4)).toEqual({
      ok: false,
      reason: "too-few",
    });
  });

  it("矩形切碎既有跨度格 → has-span", () => {
    // 行1 的 X 占 col0-1（colspan2），矩形 (1,0)-(2,0) 只覆盖 col0 → 切碎
    // （表格共 3 行：表头 + 2 数据行）
    const md = '| A | B | C |\n| --- | --- | --- |\n| <td colspan="2">X</td> | 3 |\n| 4 | 5 | 6 |\n';
    const { node } = tableOf(stateOf(md));
    expect(checkMergeable(node, { r0: 1, c0: 0, r1: 2, c1: 0 }, 3)).toEqual({
      ok: false,
      reason: "has-span",
    });
  });

  it("矩形只覆盖一个跨度格自身 → too-few（colspan=2 只算 1 个逻辑格）", () => {
    const md = '| A | B | C |\n| --- | --- | --- |\n| <td colspan="2">X</td> | 3 |\n| 4 | 5 | 6 |\n';
    const { node } = tableOf(stateOf(md));
    expect(checkMergeable(node, { r0: 1, c0: 0, r1: 1, c1: 1 }, 3)).toEqual({
      ok: false,
      reason: "too-few",
    });
  });

  it("矩形完整吞掉既有跨度格 + 另一个格 → ok", () => {
    const md = '| A | B | C |\n| --- | --- | --- |\n| <td colspan="2">X</td> | 3 |\n| 4 | 5 | 6 |\n';
    const { node } = tableOf(stateOf(md));
    // 矩形 (1,0)-(1,2)：完整吞掉 X（占 col0-1）+ 3（col2）= 2 个逻辑格
    expect(checkMergeable(node, { r0: 1, c0: 0, r1: 1, c1: 2 }, 3)).toEqual({ ok: true });
  });
});

describe("v0.13.0 需求12 checkSplittable / tableContainsSpan / tableColumnCount", () => {
  it("纯管道表格：不可拆分、无 span、列数正确", () => {
    const { node } = tableOf(stateOf(T3));
    expect(tableContainsSpan(node)).toBe(false);
    expect(tableColumnCount(node)).toBe(3);
    let firstCell: ReturnType<typeof node.child> | null = null;
    node.forEach((s) => s.forEach((r) => { if (!firstCell) firstCell = r.child(0); }));
    expect(checkSplittable(firstCell)).toBe(false);
  });

  it("含合并表格：可拆分、有 span", () => {
    const md = '| A | B |\n| --- | --- |\n| <td colspan="2">X</td> |\n';
    const { node } = tableOf(stateOf(md));
    expect(tableContainsSpan(node)).toBe(true);
    expect(tableColumnCount(node)).toBe(2);
    const body = node.child(1);
    expect(checkSplittable(body.child(0).child(0))).toBe(true);
  });
});

describe("v0.13.0 需求12 mergeCells", () => {
  it("横向合并 2 格：主格 colspan=2、被合并格消失、列不错位", () => {
    const next = applyMerge(T3, { r0: 1, c0: 0, r1: 1, c1: 1 });
    expect(cellCount(next)).toBe(3 /* 表头 */ + 2 /* 合并行: 主格 + C */ + 3 /* 行3 */);
    expect(cellAt(next, 3)).toEqual({ colspan: 2, rowspan: 1, text: "1" });
    expect(cellAt(next, 4).text).toBe("3");
    expect(cellAt(next, 5).text).toBe("4");
    expect(cellAt(next, 6).text).toBe("5");
    expect(cellAt(next, 7).text).toBe("6");
  });

  it("横向合并后序列化回 <td colspan> 形态", () => {
    const next = applyMerge(T3, { r0: 1, c0: 0, r1: 1, c1: 1 });
    const md = mdOf(next);
    expect(md).toContain('<td colspan="2">1</td>');
    expect(md).toContain("| 4 | 5 | 6 |");
  });

  it("纵向合并 2 格：主格 rowspan=2、下方行该格消失", () => {
    const next = applyMerge(T3, { r0: 1, c0: 0, r1: 2, c1: 0 });
    expect(cellAt(next, 3)).toEqual({ colspan: 1, rowspan: 2, text: "1" });
    // 表头 3 + 数据行1 3 格 + 数据行2 少一格（2 格）= 8
    expect(cellCount(next)).toBe(3 + 3 + 2);
    const md = mdOf(next);
    expect(md).toContain('<td rowspan="2">1</td>');
    expect(md).toContain("| 5 | 6 |");
  });

  it("2×2 矩形合并：colspan=2 + rowspan=2", () => {
    const next = applyMerge(T3, { r0: 1, c0: 0, r1: 2, c1: 1 });
    expect(cellAt(next, 3)).toEqual({ colspan: 2, rowspan: 2, text: "1" });
    const md = mdOf(next);
    expect(md).toContain('<td colspan="2" rowspan="2">1</td>');
  });

  it("合并后内容保留（锚点格内容不丢）", () => {
    const next = applyMerge(T3, { r0: 1, c0: 0, r1: 2, c1: 1 });
    const md = mdOf(next);
    expect(md).toContain("1"); // 锚点内容
    expect(md).toContain("3"); // 矩形外的格
    expect(md).toContain("6");
  });

  it("合并整行（colspan=3）", () => {
    const next = applyMerge(T3, { r0: 1, c0: 0, r1: 1, c1: 2 });
    expect(cellAt(next, 3).colspan).toBe(3);
    const md = mdOf(next);
    expect(md).toContain('<td colspan="3">1</td>');
    // 分隔行仍是 3 列
    expect(md).toContain("| --- | --- | --- |");
  });

  it("表头格参与合并 → 用 <th> 输出", () => {
    const next = applyMerge(T3, { r0: 0, c0: 0, r1: 0, c1: 1 });
    const md = mdOf(next);
    expect(md).toContain('<th colspan="2">A</th>');
  });

  it("合并后往返稳定（md → doc → md 不漂移）", () => {
    const next = applyMerge(T3, { r0: 1, c0: 0, r1: 2, c1: 1 });
    const md1 = mdOf(next);
    const md2 = docToMarkdown(markdownToDoc(md1));
    expect(md2).toBe(md1);
  });

  it("已合并表格上再合并相邻区域（嵌套合并）", () => {
    const next = applyMerge(T3, { r0: 1, c0: 0, r1: 1, c1: 1 });
    const next2 = next.apply(
      mergeCells(
        next.tr,
        tableOf(next).pos,
        tableOf(next).node,
        { r0: 2, c0: 0, r1: 2, c1: 1 },
      )!,
    );
    const md = mdOf(next2);
    expect(md).toContain('<td colspan="2">1</td>');
    expect(md).toContain('<td colspan="2">4</td>');
  });
});

describe("v0.13.0 需求12 splitCell", () => {
  /** 找 doc 中第一个带 span 的 cell 的位置 */
  function firstSpanCellPos(state: EditorState): number {
    let found = -1;
    state.doc.descendants((n, p) => {
      if (
        found < 0 &&
        (n.type.name === "table_cell" || n.type.name === "table_header") &&
        ((Number(n.attrs.colspan) || 1) > 1 || (Number(n.attrs.rowspan) || 1) > 1)
      ) {
        found = p;
        return false;
      }
      return true;
    });
    return found;
  }

  it("拆分 colspan=2：跨度复位 + 补一个占位格（列不错位）", () => {
    const state = stateOf('| A | B | C |\n| --- | --- | --- |\n| <td colspan="2">1</td> | 3 |\n');
    const { pos, node } = tableOf(state);
    const cellPos = firstSpanCellPos(state);
    expect(cellPos).toBeGreaterThan(0);
    const next = state.apply(splitCell(state.tr, pos, node, cellPos)!);
    // 主格变 1/1
    expect(cellAt(next, 3)).toEqual({ colspan: 1, rowspan: 1, text: "1" });
    // 补回的占位格在它后面，原 C 格仍在
    expect(cellAt(next, 4).text).toBe("");
    expect(cellAt(next, 5).text).toBe("3");
    // 序列化不再含 colspan
    expect(mdOf(next)).not.toContain("colspan");
  });

  it("拆分 rowspan=2：下方行补回占位格", () => {
    const state = stateOf(
      '| A | B |\n| --- | --- |\n| <td rowspan="2">1</td> | 2 |\n|  | 4 |\n',
    );
    const { pos, node } = tableOf(state);
    const cellPos = firstSpanCellPos(state);
    const next = state.apply(splitCell(state.tr, pos, node, cellPos)!);
    expect(cellAt(next, 2)).toEqual({ colspan: 1, rowspan: 1, text: "1" });
    expect(mdOf(next)).not.toContain("rowspan");
    // 下方行补回一格 → 该行有 2 格
    expect(cellCount(next)).toBe(2 + 2 + 2);
  });

  it("拆分 2×2：补回 1 个同行格 + 2 个下行格", () => {
    const state = stateOf(
      '| A | B | C |\n| --- | --- | --- |\n| <td colspan="2" rowspan="2">1</td> | 3 |\n|  |  | 6 |\n',
    );
    const { pos, node } = tableOf(state);
    const cellPos = firstSpanCellPos(state);
    const next = state.apply(splitCell(state.tr, pos, node, cellPos)!);
    expect(cellAt(next, 3)).toEqual({ colspan: 1, rowspan: 1, text: "1" });
    expect(mdOf(next)).not.toContain("colspan");
    expect(mdOf(next)).not.toContain("rowspan");
    // 表头 3 + 数据行1 3 格 + 数据行2 3 格
    expect(cellCount(next)).toBe(3 + 3 + 3);
  });

  it("拆分普通格 → null（不产生空事务）", () => {
    const state = stateOf(T3);
    const { pos, node } = tableOf(state);
    let firstCellPos = -1;
    state.doc.descendants((n, p) => {
      if (firstCellPos < 0 && n.type.name === "table_cell") {
        firstCellPos = p;
        return false;
      }
      return true;
    });
    expect(splitCell(state.tr, pos, node, firstCellPos)).toBeNull();
  });

  it("合并 → 拆分 → 合并 往返（结构可逆；被合并格内容不恢复，符合预期）", () => {
    const merged = applyMerge(T3, { r0: 1, c0: 0, r1: 1, c1: 1 });
    const { pos, node } = tableOf(merged);
    let spanPos = -1;
    merged.doc.descendants((n, p) => {
      if (spanPos < 0 && n.type.name === "table_cell" && (Number(n.attrs.colspan) || 1) > 1) {
        spanPos = p;
        return false;
      }
      return true;
    });
    const split = merged.apply(splitCell(merged.tr, pos, node, spanPos)!);
    expect(mdOf(split)).not.toContain("colspan");
    // 拆完应与原表格**同格数**（结构还原）
    expect(cellCount(split)).toBe(cellCount(stateOf(T3)));
    // 锚点格内容保留；被合并格的位置还原为**空格**——内容在合并时已丢弃，
    // 这是合并语义的固有代价（与 Typora/Word「仅保留左上内容」一致）。
    expect(cellAt(split, 3).text).toBe("1");
    expect(cellAt(split, 4).text).toBe("");
    expect(cellAt(split, 5).text).toBe("3");
    expect(cellAt(split, 6).text).toBe("4");
    // 列位置正确：后续格没有右移
    expect(mdOf(split)).toContain("| 3 |");
  });
});

describe("v0.13.0 需求12 既有 table-editor 行为在含合并表格上不崩", () => {
  const MERGED = '| A | B | C |\n| --- | --- | --- |\n| <td colspan="2">1</td> | 3 |\n| 4 | 5 | 6 |\n';

  it("schema 校验通过（可被 EditorState 接受）", () => {
    const state = stateOf(MERGED);
    expect(state.doc.textContent).toContain("1");
  });

  it("列数计算正确（逻辑列 3，不是行首 cell 数）", () => {
    const { node } = tableOf(stateOf(MERGED));
    expect(tableColumnCount(node)).toBe(3);
  });

  it("序列化后重开仍合法（往返稳定）", () => {
    const md1 = docToMarkdown(markdownToDoc(MERGED));
    const md2 = docToMarkdown(markdownToDoc(md1));
    expect(md2).toBe(md1);
  });

  it("含合并表格上再跑一次合并（不同区域）不抛错", () => {
    const state = stateOf(MERGED);
    const { pos, node } = tableOf(state);
    const out = mergeCells(state.tr, pos, node, { r0: 3, c0: 0, r1: 3, c1: 1 });
    expect(out).not.toBeNull();
    expect(() => state.apply(out!)).not.toThrow();
  });
});

describe("v0.13.0 需求12 schema 兼容性", () => {
  it("手工构造带 span 的 cell 不违反 schema", () => {
    const cell = schema.nodes.table_cell.create(
      { align: "left", colspan: 2, rowspan: 2 },
      [schema.text("X")],
    );
    expect(cell.attrs.colspan).toBe(2);
    expect(cell.attrs.rowspan).toBe(2);
  });

  it("table_header 同样支持 span", () => {
    const th = schema.nodes.table_header.create(
      { align: "left", colspan: 3, rowspan: 1 },
      [schema.text("H")],
    );
    expect(th.attrs.colspan).toBe(3);
  });
});
