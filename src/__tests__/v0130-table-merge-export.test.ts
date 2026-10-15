/**
 * v0.13.0 需求12：DOCX/LaTeX 导出降级测试
 *
 * 验收（plan §12.4）：DOCX/LaTeX（html:false）遇 `<td colspan>` →
 * 降级为「内容 + 空占位格」，**不得丢内容**。
 */
import { describe, it, expect } from "vitest";
import {
  parseMarkdownToBlocksDetailed,
  stripTdWrapperText,
} from "../utils/exportBlocks";

const MERGED = `| A | B | C |
| --- | --- | --- |
| <td colspan="2">M</td> | 3 |
| 7 | 8 | 9 |
`;

describe("v0.13.0 需求12 stripTdWrapperText", () => {
  it("剥掉 td 包裹保留内容", () => {
    expect(stripTdWrapperText('<td colspan="2">M</td>')).toBe("M");
  });
  it("剥掉 th 包裹保留内容", () => {
    expect(stripTdWrapperText('<th colspan="2">H</th>')).toBe("H");
  });
  it("colspan + rowspan 都剥", () => {
    expect(stripTdWrapperText('<td colspan="2" rowspan="2">X</td>')).toBe("X");
  });
  it("非 td 文本原样返回", () => {
    expect(stripTdWrapperText("普通文本")).toBe("普通文本");
    expect(stripTdWrapperText("<span>x</span>")).toBe("<span>x</span>");
  });
  it("空内容 → 空串", () => {
    expect(stripTdWrapperText("<td colspan=\"2\"></td>")).toBe("");
  });
});

describe("v0.13.0 需求12 DOCX/LaTeX 导出降级", () => {
  it("合并格内容不丢、不出现裸 HTML 标签", () => {
    const { blocks, unknownTokens } = parseMarkdownToBlocksDetailed(MERGED);
    expect(unknownTokens).toEqual([]);
    const table = blocks.find((b) => b.kind === "table");
    expect(table).toBeTruthy();
    if (table?.kind !== "table") return;
    // 第一数据行：M（内容保留）+ 3 + 空占位格
    const row0 = table.rows[0];
    expect(row0).toHaveLength(3);
    expect(row0[0].map((r) => r.text).join("")).toBe("M");
    expect(row0[1].map((r) => r.text).join("")).toBe("3");
    expect(row0[2].map((r) => r.text).join("")).toBe("");
    // 不得出现字面量 HTML
    for (const row of table.rows) {
      for (const cell of row) {
        for (const run of cell) {
          expect(run.text).not.toContain("<td");
          expect(run.text).not.toContain("</td>");
        }
      }
    }
  });

  it("纯管道表格导出不受影响（零回归）", () => {
    const { blocks } = parseMarkdownToBlocksDetailed(
      "| A | B |\n| --- | --- |\n| 1 | 2 |\n",
    );
    const table = blocks.find((b) => b.kind === "table");
    if (table?.kind !== "table") throw new Error("no table");
    expect(table.rows[0][0].map((r) => r.text).join("")).toBe("1");
    expect(table.rows[0][1].map((r) => r.text).join("")).toBe("2");
  });

  it("纵向合并不丢内容", () => {
    const md = `| A | B |
| --- | --- |
| <td rowspan="2">V</td> | Y |
|  | Z |
`;
    const { blocks } = parseMarkdownToBlocksDetailed(md);
    const table = blocks.find((b) => b.kind === "table");
    if (table?.kind !== "table") throw new Error("no table");
    const texts = table.rows.flat().flatMap((cell) => cell.map((r) => r.text));
    expect(texts).toContain("V");
    expect(texts).toContain("Y");
    expect(texts).toContain("Z");
    for (const t of texts) expect(t).not.toContain("<td");
  });
});
