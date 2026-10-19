// @vitest-environment jsdom
/**
 * v0.13.2 返修：**合并单元格存盘 → 重开**后，合并的那一行不得多出单元格。
 *
 * ## 用户实测
 * 「表格单元格合并操作正常，但关闭文档重新打开后，合并单元格的那行会多出一个
 *  单元格，破坏了表格的整体结构。」
 *
 * ## 根因（markdown-it 表格规则）
 * 数据行恒定输出 `columnCount` 个 `<td>`（缺列补空），而合并序列化**跳过被占位的空洞**：
 *   · 横向合并：`| <td colspan="2">1</td> | 3 |` 只有 2 格 → 补齐出第 3 格，
 *     其逻辑列 ≥ columnCount（被 colspan 挤出表外）；
 *   · 纵向合并：`| 4 | 5 |` 只有 2 格 → 补齐出的空格正好落在被 rowspan 占据的列。
 * 这些补齐格在网格层被识别（合并/序列化本身正确），但**节点留在文档里**，
 * 表格 NodeView 会渲染成真实单元格 → 用户看到"合并那行多一格"。
 *
 * ## 修复
 * `core/tableGrid.trimTablePlaceholderCells`：解析后按与网格同一套布点规则
 * 裁掉**行尾**的占位格（rowspan 空洞 / 逻辑列越界的空普通格）。
 * 纯管道表格无 span → 原节点直接返回，零 diff 回归锁不受影响。
 */
import { describe, it, expect } from "vitest";
import { EditorState } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import { mergeCells } from "../core/tableMerge";
import {
  planTableRowTrim,
  trimTablePlaceholderCells,
  tableHasSpan,
} from "../core/tableGrid";

const MD3 = "| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n";

/** 每行的 cell 数量（文档顺序） */
function rowCellCounts(doc: PMNode): number[] {
  const out: number[] = [];
  doc.descendants((n) => {
    if (n.type.name === "table_row") {
      out.push(n.childCount);
      return false;
    }
    return true;
  });
  return out;
}

/** 每行的 (colspan,rowspan,text) 摘要 */
function rowCells(doc: PMNode): string[][] {
  const out: string[][] = [];
  doc.descendants((n) => {
    if (n.type.name === "table_row") {
      const cells: string[] = [];
      n.forEach((c) => cells.push(`${c.attrs.colspan}/${c.attrs.rowspan}:${c.textContent}`));
      out.push(cells);
      return false;
    }
    return true;
  });
  return out;
}

function tableOf(doc: PMNode): { table: PMNode; pos: number } {
  let pos = -1;
  let table: PMNode | null = null;
  doc.descendants((n, p) => {
    if (n.type.name === "table" && pos < 0) {
      pos = p;
      table = n;
      return false;
    }
    return true;
  });
  if (!table) throw new Error("没有表格");
  return { table, pos };
}

/** 真实合并 → 序列化 → 重新解析（等价于"存盘后关闭再打开"） */
function mergeAndReopen(rect: { r0: number; c0: number; r1: number; c1: number }) {
  const doc = markdownToDoc(MD3);
  const { table, pos } = tableOf(doc);
  const state = EditorState.create({ doc });
  const tr = state.tr;
  const merged = mergeCells(tr, pos, table, rect);
  expect(merged).not.toBeNull();
  const mergedDoc = state.apply(merged!).doc;
  const md = docToMarkdown(mergedDoc);
  const reopened = markdownToDoc(md);
  return { mergedDoc, md, reopened };
}

describe("v0.13.2 返修：合并单元格重开后不多出单元格", () => {
  it("横向合并（第 2 行前两格）→ 重开仍为 2 格，且稳定往返", () => {
    const { mergedDoc, md, reopened } = mergeAndReopen({ r0: 1, c0: 0, r1: 1, c1: 1 });
    // 合并后：第 2 行是 [colspan2, 3] 共 2 格
    expect(rowCellCounts(mergedDoc)).toEqual([3, 2, 3]);
    // 重开（markdown-it 会补列）后仍必须 2 格 —— 这是用户报的缺陷点
    expect(rowCellCounts(reopened)).toEqual([3, 2, 3]);
    expect(rowCells(reopened)[1][0].startsWith("2/1:")).toBe(true);
    // 二次往返稳定
    expect(docToMarkdown(reopened)).toBe(md);
  });

  it("纵向合并（第 2/3 行最后一列）→ 重开末行不多出空格", () => {
    const { mergedDoc, md, reopened } = mergeAndReopen({ r0: 1, c0: 2, r1: 2, c1: 2 });
    expect(rowCellCounts(mergedDoc)).toEqual([3, 3, 2]);
    expect(rowCellCounts(reopened)).toEqual([3, 3, 2]);
    expect(rowCells(reopened)[1][2].startsWith("1/2:")).toBe(true);
    expect(docToMarkdown(reopened)).toBe(md);
  });

  it("2×2 合并 → 重开结构不变（第 3 行只剩 1 格）", () => {
    const { mergedDoc, md, reopened } = mergeAndReopen({ r0: 1, c0: 0, r1: 2, c1: 1 });
    expect(rowCellCounts(mergedDoc)).toEqual([3, 2, 1]);
    expect(rowCellCounts(reopened)).toEqual([3, 2, 1]);
    expect(docToMarkdown(reopened)).toBe(md);
  });

  it("表头横向合并 → 重开表头格数不被补齐格污染", () => {
    const { mergedDoc, md, reopened } = mergeAndReopen({ r0: 0, c0: 0, r1: 0, c1: 1 });
    expect(rowCellCounts(mergedDoc)).toEqual([2, 3, 3]);
    // 表头需要补足到与分隔行相同的物理格数（否则整表退化成段落），
    // 但数据行必须保持 3 格、不得被裁
    expect(rowCellCounts(reopened)[1]).toBe(3);
    expect(rowCellCounts(reopened)[2]).toBe(3);
    expect(docToMarkdown(reopened)).toBe(md);
  });

  it("纯管道表格（无合并）：解析结果逐节点不变（零 diff 回归锁）", () => {
    const doc = markdownToDoc(MD3);
    const { table } = tableOf(doc);
    expect(tableHasSpan(table)).toBe(false);
    // 无合并 → trim 原样返回（引用相等），不会改动任何节点
    expect(trimTablePlaceholderCells(table)).toBe(table);
    expect(planTableRowTrim(table).every((d) => d.length === 0)).toBe(true);
    expect(docToMarkdown(doc)).toBe(MD3);
  });

  it("用户真实写的行尾空单元格**不被裁掉**（只在合并表格里裁占位格）", () => {
    // 纯管道表格：末尾空单元格是用户写的，必须保留
    const md = "| A | B | C |\n| --- | --- | --- |\n| 1 | 2 |  |\n";
    const doc = markdownToDoc(md);
    expect(rowCellCounts(doc)).toEqual([3, 3]);
    expect(docToMarkdown(doc)).toBe(md);
  });
});
