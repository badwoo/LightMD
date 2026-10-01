/**
 * E4(v0.9.2):表格右键菜单 i18n + danger 判定重构 + 表头禁删
 *
 * 修复前:
 * - 菜单 6 项文案硬编码中文,英文界面穿帮
 * - danger 样式以 label.includes("删除") 判定,i18n 化后失效
 * - 表头行"删除行"删除整个 table_head,行为反直觉
 * 验收:
 * 1. 菜单项数据驱动(i18n key),en-US 下文案为英文
 * 2. 删除行/列带 danger 标记
 * 3. 表头行位置无"删除行"项(仍可删列)
 * 4. deleteRow 既有行为回归(tbody 单行禁删、thead 删除整个 head)
 */
import { describe, it, expect } from "vitest";
import { EditorState } from "prosemirror-state";
import { Node, ResolvedPos } from "prosemirror-model";
import { lightMDSchema as schema } from "../core/schema";
import { buildContextMenuItems, deleteRow, insertRowAbove } from "../core/plugins/table-editor";
import { t, _setCurrentLanguage } from "../i18n/state";

// ─── 构造辅助(与 table-context-menu.test.ts 同款) ──────────

function makeCell(text: string, isHeader = false): Node {
  const type = isHeader ? schema.nodes.table_header : schema.nodes.table_cell;
  return type.create({}, text ? schema.text(text) : []);
}

function makeTable(headRow: Node | null, bodyRows: Node[]): Node {
  const children: Node[] = [];
  if (headRow) children.push(schema.nodes.table_head.create(null, headRow));
  children.push(schema.nodes.table_body.create(null, bodyRows));
  return schema.nodes.table.create(null, children);
}

/** 查找第 n 个 cell(0-indexed)内容起始位置 */
function findCellContentPos(doc: Node, n: number): ResolvedPos | null {
  let count = 0;
  let found: ResolvedPos | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === "table_cell" || node.type.name === "table_header") {
      if (count === n) {
        found = doc.resolve(pos + 1);
        return false;
      }
      count++;
      return false;
    }
    return true;
  });
  return found;
}

/** 建立带表头(1 行) + 表体(2 行)、每行 2 列的文档 */
function makeDocWithTable(): Node {
  const row = (header: boolean) =>
    schema.nodes.table_row.create(null, [makeCell("a", header), makeCell("b", header)]);
  return schema.topNodeType.create(null, [
    makeTable(row(true), [row(false), row(false)]),
  ]);
}

function keysOf(items: ReturnType<typeof buildContextMenuItems>): string[] {
  return items.filter((i) => i.key !== null).map((i) => i.key as string);
}

describe("E4: buildContextMenuItems 数据驱动", () => {
  it("tbody cell 的菜单:行操作/分隔/列操作/分隔/删除行+删除列", () => {
    const $pos = findCellContentPos(makeDocWithTable(), 2); // tbody 第 1 行第 1 格
    expect($pos).not.toBeNull();
    const items = buildContextMenuItems($pos!);
    expect(keysOf(items)).toEqual([
      "table.addRowAbove",
      "table.addRowBelow",
      "table.addColumnLeft",
      "table.addColumnRight",
      "table.deleteRow",
      "table.deleteColumn",
    ]);
  });

  it("删除行/删除列带 danger 标记,插入类不带", () => {
    const $pos = findCellContentPos(makeDocWithTable(), 2)!;
    const items = buildContextMenuItems($pos);
    const byKey = Object.fromEntries(
      items.filter((i) => i.key).map((i) => [i.key, i])
    );
    expect(byKey["table.deleteRow"].danger).toBe(true);
    expect(byKey["table.deleteColumn"].danger).toBe(true);
    expect(byKey["table.addRowAbove"].danger).toBeFalsy();
    expect(byKey["table.addColumnLeft"].danger).toBeFalsy();
  });

  it("表头行位置:无删除行项,仍可删列", () => {
    const $pos = findCellContentPos(makeDocWithTable(), 0); // table_header
    expect($pos).not.toBeNull();
    const items = buildContextMenuItems($pos!);
    const keys = keysOf(items);
    expect(keys).not.toContain("table.deleteRow");
    expect(keys).toContain("table.deleteColumn");
  });

  it("en-US 下菜单项文案为英文", () => {
    _setCurrentLanguage("en-US");
    try {
      const $pos = findCellContentPos(makeDocWithTable(), 2)!;
      const items = buildContextMenuItems($pos);
      const texts = items.filter((i) => i.key).map((i) => t(i.key as string));
      expect(texts).toContain("Add Row Above");
      expect(texts).toContain("Delete Row");
      expect(texts).toContain("Delete Column");
      // 不应再出现硬编码中文
      expect(texts.some((s) => /[\u4e00-\u9fff]/.test(s))).toBe(false);
    } finally {
      _setCurrentLanguage("zh-CN");
    }
  });
});

describe("E4: deleteRow 既有行为回归", () => {
  it("tbody 单行禁删(schema 保护,返回 null)", () => {
    const row = () =>
      schema.nodes.table_row.create(null, [makeCell("a"), makeCell("b")]);
    const doc = schema.topNodeType.create(null, [makeTable(null, [row()])]);
    const $pos = findCellContentPos(doc, 0)!;
    const tr = EditorState.create({ doc }).tr;
    expect(deleteRow(tr, $pos)).toBeNull();
  });

  it("tbody 多行删除其中一行仍正常", () => {
    const doc = makeDocWithTable();
    const $pos = findCellContentPos(doc, 2)!;
    const tr = EditorState.create({ doc }).tr;
    const result = deleteRow(tr, $pos);
    expect(result).not.toBeNull();
    let bodyRows = 0;
    result!.doc.descendants((node) => {
      if (node.type.name === "table_body") bodyRows = node.childCount;
    });
    expect(bodyRows).toBe(1);
  });

  it("insertRowAbove 与菜单 op 引用一致(接线回归)", () => {
    const $pos = findCellContentPos(makeDocWithTable(), 2)!;
    const items = buildContextMenuItems($pos);
    const rowAbove = items.find((i) => i.key === "table.addRowAbove");
    expect(rowAbove?.op).toBe(insertRowAbove);
  });
});
