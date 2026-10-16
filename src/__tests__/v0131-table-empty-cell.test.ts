// @vitest-environment jsdom
/**
 * v0.13.1 需求2：**空单元格（含行尾空单元格）必须能被拖拽选中**，
 * 以便用它作为起点/终点参与单元格合并。
 *
 * ## 用户报告
 * 「表格单元格合并还有点小问题，发现没有内容的单元格没法通过拖拽选中，
 *  这就导致没法进行单元格合并。」
 *
 * ## 根因（本文件锁定）
 * `TableView.cellCoordOf` 先做
 * `view.posAtDOM(cellEl, 0)`，再用 `cellPositionsOfGrid` 查网格坐标；查不到就
 * 返回 null → `onRangeMouseDown` 提前 return（锚点永不设置）→ 拖拽跨格选不出范围
 * → 合并按钮恒灰。
 *
 * 而 `cellPositionsOfGrid` 依赖 `trimRowTrailingEmpties`，旧实现**只按"是不是空格"**
 * 裁剪行尾：于是用户**真实写的行尾空单元格**被当成 markdown-it 的补齐幻影格一起丢掉，
 * 它在网格里没有条目 → 查不到坐标 → 永远选不中（需求2 的根因）。
 *
 * ## 真正的判据
 * markdown-it 的表格规则（`lib/rules_block/table.mjs`）用**表头行的源列数**作为
 * `columnCount`，并对每一行**恒定输出 `columnCount` 个 cell**、对缺失的列补空
 * （第 202-213 行 `columns[i] ? columns[i].trim() : ''`）。所以：
 *   · 幻影格是"补齐到 columnCount"的产物 → 它布点后的**逻辑列必然 ≥ logicalCols**；
 *   · 用户真实写的空单元格一定落在 `[0, logicalCols)` 内。
 * 二者在节点层面完全同形（都是 `content.size === 0`、span 1/1），
 * **只有"布点后的逻辑列"能区分**——不能只看"是不是空格"，也不能只看物理下标
 * （`| X(cs3) | | |` 的两个补齐格物理下标是 1、2 却落在逻辑列 3、4）。
 *
 * 本文件同时锁住"裁剪口径不能把网格撑宽"（否则分隔行列数漂移、往返不幂等）。
 */
import { describe, it, expect } from "vitest";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import {
  buildTableGridFromTable,
  cellPositionsOfGrid,
  gridColumnCount,
  tableLogicalColumnCount,
} from "../core/tableGrid";

/** 覆盖：真实空格 / 补齐幻影格 / 合并格 / 行尾空格 / 短行 */
const CASES: Array<{ name: string; md: string }> = [
  { name: "plain 2x2", md: "| H1 | H2 |\n| --- | --- |\n| A | B |\n" },
  { name: "3 列 · 行尾真实空格", md: "| A | B | C |\n| --- | --- | --- |\n| 1 | 2 |  |\n" },
  { name: "colspan2 + 补齐幻影格", md: '| A | B | C |\n| --- | --- | --- |\n| <td colspan="2">M</td> | C |\n' },
  { name: "colspan3 + 两个补齐幻影格", md: '| A | B | C |\n| --- | --- | --- |\n| <td colspan="3">M</td> |\n' },
  { name: "短行（源文只写 1 格）", md: "| A | B | C |\n| --- | --- | --- |\n| 1 |\n" },
  { name: "rowspan2（含占位空格）", md: '| A | B |\n| --- | --- |\n| <td rowspan="2">R</td> | 1 |\n|  | 2 |\n' },
  { name: "行首空格", md: "| A | B |\n| --- | --- |\n|  | 9 |\n" },
  { name: "多行行尾空格", md: "| A | B | C |\n| --- | --- | --- |\n| 1 | 2 |  |\n| 3 | 4 |  |\n" },
];

function tableOf(md: string) {
  const t = markdownToDoc(md).child(0);
  expect(t.type.name).toBe("table");
  return t;
}

// ═════════ ① 逻辑列数口径 ═════════

describe("v0.13.1 需求2：tableLogicalColumnCount = 表头的源列数", () => {
  it("表头无合并时等于表头的 cell 数", () => {
    for (const c of CASES.slice(0, 5).concat(CASES.slice(6))) {
      const t = tableOf(c.md);
      // table → table_head → table_row → N cells
      const headCells = t.child(0).child(0).childCount;
      expect(tableLogicalColumnCount(t), c.name).toBe(headCells);
    }
  });

  it("表头有合并格时仍按**源列数**（`<th colspan=2>` 只算一格）", () => {
    // 表头源文 2 格（其中一格 colspan=2），分隔行也必须是 2 列，否则 markdown-it
    // 直接判定不是表格（`columnCount !== aligns.length`）。
    const md = '| <th colspan="2">H</th> | C |\n| --- | --- |\n| 1 | 2 |\n';
    const t = tableOf(md);
    expect(tableLogicalColumnCount(t)).toBe(2);
  });
});

// ═════════ ② 真实空单元格必须拿到网格坐标（需求2 的直接锁） ═════════

describe("v0.13.1 需求2：行尾真实空单元格可被选中（有网格坐标）", () => {
  it("3 列 · 行尾空格：坐标覆盖 3 列（旧实现缺 (1,2)）", () => {
    const map = cellPositionsOfGrid(tableOf(CASES[1].md), 0);
    const coords = [...map.values()].map((c) => `${c.rowIdx},${c.colIdx}`).sort();
    expect(coords).toEqual(["0,0", "0,1", "0,2", "1,0", "1,1", "1,2"]);
  });

  it("多行行尾空格：每一行的末列都有坐标", () => {
    const map = cellPositionsOfGrid(tableOf(CASES[7].md), 0);
    const coords = [...map.values()].map((c) => `${c.rowIdx},${c.colIdx}`).sort();
    expect(coords).toEqual([
      "0,0", "0,1", "0,2",
      "1,0", "1,1", "1,2",
      "2,0", "2,1", "2,2",
    ]);
  });

  it("行首空格（本来就可选）仍然有坐标（回归锁）", () => {
    const map = cellPositionsOfGrid(tableOf(CASES[6].md), 0);
    const coords = [...map.values()].map((c) => `${c.rowIdx},${c.colIdx}`).sort();
    expect(coords).toEqual(["0,0", "0,1", "1,0", "1,1"]);
  });
});

// ═════════ ③ 补齐幻影格必须仍被裁掉（否则网格被撑宽） ═════════

describe("v0.13.1 需求2：补齐幻影格不得撑宽网格", () => {
  it("colspan2 行 + 补齐格 → 网格仍是 3 列", () => {
    const grid = buildTableGridFromTable(tableOf(CASES[2].md), 0);
    expect(gridColumnCount(grid)).toBe(3);
  });

  it("colspan3 行 + 两个补齐格 → 网格仍是 3 列（按物理下标判会变 5 列）", () => {
    const t = tableOf(CASES[3].md);
    const grid = buildTableGridFromTable(t, 0);
    expect(gridColumnCount(grid)).toBe(3);
    expect(tableLogicalColumnCount(t)).toBe(3);
  });

  it("短行（源文 1 格）不会把网格撑宽", () => {
    const grid = buildTableGridFromTable(tableOf(CASES[4].md), 0);
    expect(gridColumnCount(grid)).toBe(3);
  });
});

// ═════════ ④ 序列化往返必须幂等（尤其是合并格） ═════════

describe("v0.13.1 需求2：序列化往返稳定", () => {
  for (const c of CASES) {
    it(`稳定：${c.name}`, () => {
      const md1 = docToMarkdown(markdownToDoc(c.md));
      const md2 = docToMarkdown(markdownToDoc(md1));
      expect(md2).toBe(md1);
    });
  }

  it("合并格仍以 <td colspan> 形态往返（不丢合并）", () => {
    const md1 = docToMarkdown(markdownToDoc(CASES[2].md));
    expect(md1).toContain('<td colspan="2">M</td>');
    const md2 = docToMarkdown(markdownToDoc(md1));
    expect(md2).toBe(md1);
  });

  it("**纯管道表格逐字节零 diff**（最重要的回归锁）", () => {
    for (const md of [
      CASES[0].md,
      CASES[1].md,
      CASES[6].md,
      CASES[7].md,
      "| H1 | H2 |\n| --- | --- |\n| a | b |\n| c | d |\n",
    ]) {
      expect(docToMarkdown(markdownToDoc(md))).toBe(md);
    }
  });
});
