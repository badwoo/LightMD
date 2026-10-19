/**
 * v0.13.0 需求12：表格合并/拆分 —— 解析/序列化往返测试
 *
 * 覆盖：
 * ① **纯管道表格 md → doc → md 零 diff**（最高优先级回归锁，回归 v0.11.0-table-delete-head）
 * ② 横向合并（colspan）往返
 * ③ 纵向合并（rowspan）往返
 * ④ 混合表格（部分行有合并）往返
 * ⑤ 表头合并
 * ⑥ 拆分还原为独立格
 * ⑦ 含合并表格上的对齐/列宽不崩
 * ⑧ DOM 输出含 colspan/rowspan 属性（schema toDOM）
 */
import { describe, it, expect } from "vitest";
import type { Node as PmNode } from "prosemirror-model";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import { lightMDSchema as schema } from "../core/schema";

/** 往返一次 */
function roundtrip(src: string): string {
  return docToMarkdown(markdownToDoc(src));
}

/** 找 doc 中的 table 节点 */
function findTable(doc: PmNode): PmNode | null {
  let found: PmNode | null = null;
  doc.descendants((n) => {
    if (n.type.name === "table" && !found) {
      found = n;
      return false;
    }
    return true;
  });
  return found;
}

/** 收集 table 的全部 cell 节点（含 thead/tbody） */
function collectCells(table: PmNode) {
  const cells: Array<{ colspan: number; rowspan: number; text: string }> = [];
  table.forEach((section) => {
    if (section.type.name !== "table_head" && section.type.name !== "table_body") return;
    section.forEach((row) => {
      row.forEach((cell) => {
        cells.push({
          colspan: Number(cell.attrs.colspan) || 1,
          rowspan: Number(cell.attrs.rowspan) || 1,
          text: cell.textContent,
        });
      });
    });
  });
  return cells;
}

describe("v0.13.0 需求12 回归锁：纯管道表格零 diff", () => {
  it("简单 2×3 表格往返恒等", () => {
    const src = "| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n";
    expect(roundtrip(src)).toBe(src);
  });

  it("含对齐的表格往返恒等", () => {
    const src = "| A | B | C |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |\n";
    expect(roundtrip(src)).toBe(src);
  });

  it("空单元格往返恒等", () => {
    const src = "| A | B |\n| --- | --- |\n|  | 2 |\n";
    expect(roundtrip(src)).toBe(src);
  });

  it("多数据行往返恒等", () => {
    const src = "| H1 | H2 |\n| --- | --- |\n| a | b |\n| c | d |\n| e | f |\n";
    expect(roundtrip(src)).toBe(src);
  });

  it("单元格内含行内格式往返恒等", () => {
    const src = "| **粗** | *斜* | `code` |\n| --- | --- | --- |\n| [链接](a.md) | ~~删~~ | 普通 |\n";
    expect(roundtrip(src)).toBe(src);
  });

  it("纯管道表格的 cell attrs 恒为 1/1（未引入 span）", () => {
    const table = findTable(markdownToDoc("| A | B |\n| --- | --- |\n| 1 | 2 |\n"));
    expect(table).toBeTruthy();
    for (const c of collectCells(table!)) {
      expect(c.colspan).toBe(1);
      expect(c.rowspan).toBe(1);
    }
  });
});

describe("v0.13.0 需求12 横向合并（colspan）", () => {
  it("解析后主格带 colspan=2，编辑器不再显示裸 HTML", () => {
    const table = findTable(
      markdownToDoc('| A | B | C |\n| --- | --- | --- |\n| <td colspan="2">M</td> | C |\n'),
    );
    expect(table).toBeTruthy();
    const cells = collectCells(table!);
    // v0.13.2 返修：markdown-it 补齐出来的行尾占位格会在解析后裁掉，
    // 因此这里是 表头 3 + 数据行 2 = 5（不再多出一个空单元格）
    expect(cells).toHaveLength(5);
    const merged = cells[3];
    expect(merged.colspan).toBe(2);
    expect(merged.rowspan).toBe(1);
    expect(merged.text).toBe("M");
    expect(cells[4].text).toBe("C");
  });

  it("合并行序列化回 <td colspan=\"2\"> 形态", () => {
    const md = docToMarkdown(
      markdownToDoc('| A | B | C |\n| --- | --- | --- |\n| <td colspan="2">M</td> | C |\n'),
    );
    expect(md).toContain('<td colspan="2">M</td>');
    // 分隔行仍按逻辑列数 3 输出
    expect(md).toContain("| --- | --- | --- |");
  });

  it("横向合并往返：md → doc → md 保持合并", () => {
    const src = '| A | B | C |\n| --- | --- | --- |\n| <td colspan="2">M</td> | C |\n';
    const md1 = roundtrip(src);
    expect(md1).toContain('<td colspan="2">M</td>');
    // 二次往返必须稳定（不漂移）
    const md2 = docToMarkdown(markdownToDoc(md1));
    expect(md2).toBe(md1);
  });

  it("整行合并（colspan=3）", () => {
    const src = '| A | B | C |\n| --- | --- | --- |\n| <td colspan="3">全宽</td> |\n';
    const table = findTable(markdownToDoc(src));
    const cells = collectCells(table!);
    expect(cells[3].colspan).toBe(3);
    expect(roundtrip(src)).toContain('<td colspan="3">全宽</td>');
  });
});

describe("v0.13.0 需求12 纵向合并（rowspan）", () => {
  it("解析后主格带 rowspan=2", () => {
    const table = findTable(
      markdownToDoc(
        '| A | B |\n| --- | --- |\n| <td rowspan="2">V</td> | Y |\n|  | Z |\n',
      ),
    );
    expect(table).toBeTruthy();
    const cells = collectCells(table!);
    expect(cells[2].rowspan).toBe(2);
    expect(cells[2].text).toBe("V");
  });

  it("纵向合并往返：md → doc → md 保持合并", () => {
    const src = '| A | B |\n| --- | --- |\n| <td rowspan="2">V</td> | Y |\n|  | Z |\n';
    const md1 = roundtrip(src);
    expect(md1).toContain('<td rowspan="2">V</td>');
    const md2 = docToMarkdown(markdownToDoc(md1));
    expect(md2).toBe(md1);
  });
});

describe("v0.13.0 需求12 混合表格", () => {
  it("部分行有合并 → 往返保持", () => {
    const src =
      '| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| <td colspan="2">M</td> | 6 |\n| 7 | 8 | 9 |\n';
    const md1 = roundtrip(src);
    expect(md1).toContain('<td colspan="2">M</td>');
    expect(md1).toContain("| 7 | 8 | 9 |");
    const md2 = docToMarkdown(markdownToDoc(md1));
    expect(md2).toBe(md1);
  });

  it("同一表内既有 colspan 又有 rowspan", () => {
    const src =
      '| A | B | C |\n| --- | --- | --- |\n| <td colspan="2" rowspan="2">X</td> | 3 |\n|  | 6 |\n| 7 | 8 | 9 |\n';
    const md1 = roundtrip(src);
    expect(md1).toContain('<td colspan="2" rowspan="2">X</td>');
    const md2 = docToMarkdown(markdownToDoc(md1));
    expect(md2).toBe(md1);
  });
});

describe("v0.13.0 需求12 表头合并", () => {
  it("表头跨列用 <th> 输出", () => {
    const src = '| <th colspan="2">H</th> | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n';
    const md1 = roundtrip(src);
    expect(md1).toContain('<th colspan="2">H</th>');
    const md2 = docToMarkdown(markdownToDoc(md1));
    expect(md2).toBe(md1);
  });
});

describe("v0.13.0 需求12 拆分", () => {
  it("跨度复位为 1 后 schema 仍接受（不抛 Invalid content）", () => {
    const table = findTable(
      markdownToDoc('| A | B |\n| --- | --- |\n| <td colspan="2">M</td> |\n'),
    );
    expect(table).toBeTruthy();
    // 构造一个 span 复位的行，验证 schema 允许
    const section = table!.child(1);
    const row = section.child(0);
    const merged = row.child(0);
    const plain = schema.nodes.table_cell.create(
      { align: merged.attrs.align, colspan: 1, rowspan: 1 },
      merged.content,
    );
    expect(Number(plain.attrs.colspan)).toBe(1);
    expect(plain.textContent).toBe("M");
    // 拆分行重新组装后仍能序列化（v0.13.2 返修后该数据行只剩 1 个真实格：
    // markdown-it 补齐的幻影格已在解析阶段被裁掉）
    const newRow = schema.nodes.table_row.create(null, [plain]);
    const newBody = schema.nodes.table_body.create(null, [newRow]);
    const newTable = schema.nodes.table.create(null, [table!.child(0), newBody]);
    const md = docToMarkdown(schema.nodes.doc.create(null, [newTable]));
    expect(md).not.toContain("colspan");
    expect(md).toContain("M");
  });
});

describe("v0.13.0 需求12 schema toDOM", () => {
  it("colspan/rowspan >1 时输出属性", () => {
    const cell = schema.nodes.table_cell.create(
      { align: "left", colspan: 2, rowspan: 3 },
      [schema.text("X")],
    );
    const dom = cell.type.spec.toDOM?.(cell) as unknown as [
      string,
      Record<string, unknown>,
      number,
    ];
    const attrs = dom[1];
    expect(attrs.colspan).toBe(2);
    expect(attrs.rowspan).toBe(3);
  });

  it("未合并时不输出 span 属性（DOM 与旧版一致）", () => {
    const cell = schema.nodes.table_cell.create({ align: "left", colspan: 1, rowspan: 1 }, []);
    const dom = cell.type.spec.toDOM?.(cell) as unknown as [
      string,
      Record<string, unknown>,
      number,
    ];
    expect(dom[1].colspan).toBeUndefined();
    expect(dom[1].rowspan).toBeUndefined();
  });

  it("对齐样式与 span 属性可共存", () => {
    const cell = schema.nodes.table_cell.create(
      { align: "center", colspan: 2, rowspan: 1 },
      [],
    );
    const dom = cell.type.spec.toDOM?.(cell) as unknown as [
      string,
      Record<string, unknown>,
      number,
    ];
    expect(dom[1].style).toBe("text-align:center");
    expect(dom[1].colspan).toBe(2);
  });
});

describe("v0.13.0 需求12 既有 table-editor 行为不崩", () => {
  it("含合并表格仍能被 schema 校验通过", () => {
    const doc = markdownToDoc(
      '| A | B | C |\n| --- | --- | --- |\n| <td colspan="2">M</td> | 3 |\n| <td rowspan="2">V</td> | 6 |\n|  | 9 |\n',
    );
    expect(doc).toBeTruthy();
    // 能再次序列化即说明结构合法
    expect(docToMarkdown(doc)).toContain("colspan");
  });
});
