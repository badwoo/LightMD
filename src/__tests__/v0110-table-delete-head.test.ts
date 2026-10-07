/**
 * v0.11.0 B1-2：表格「删除行」不得导致原表头内容丢失。
 *
 * 缺陷背景（P0）：
 *   plugins/table-editor.ts 的 deleteRow 在 isInHead 时直接删掉整个 table_head 节点，
 *   而 schema 的 table content 是 `table_head? table_body`（head **可选**），故 PM 不报错；
 *   但 serializer 的 tableToMarkdown 无条件把 rows[0] 当表头输出 →
 *   实测 `| A | B |` 被删后输出 `| 1 | 2 |`，A/B 永久消失、数据行顶替表头。
 *
 *   另存在内部不一致：右键菜单 buildContextMenuItems 已排除表头的删除行，
 *   工具栏按钮却未排除 → 同一操作两个入口两种行为。
 *
 * 修复口径（三重防线）：
 *   ① deleteRow 在表头内返回 null（拒绝删除），与 tbody 仅剩一行时的既有策略一致；
 *   ② serializer 在**无 table_head** 时不把首行当表头（数据安全最后一道闸，
 *      防止未来新增调用入口再次失守）；
 *   ③ 表体行删除行为不变。
 */
import { describe, it, expect } from "vitest";
import { EditorState } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { lightMDSchema } from "../core/schema";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import { deleteRow, deleteColumn } from "../core/plugins/table-editor";

const schema = lightMDSchema;

const SRC = "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n";

/** 找到 table 节点位置（-1 = 未找到） */
function findTablePos(doc: PMNode): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found === -1 && node.type.name === "table") {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

/**
 * 找到 table 内 table_head 内第一个单元格的位置。
 *
 * 实测文档结构（| A | B | + 分隔行 + 2 行数据）：
 *   0 table / 1 table_head / 2 table_row / 3 table_header("A") / 6 table_header("B")
 *   11 table_body / 12 table_row / 13 table_cell("1") …
 * cellAround / isInHead 需要 $pos 落在单元格**内容**内，故返回 pos+1。
 */
function findHeadCellPos(doc: PMNode): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found !== -1) return false;
    if (node.type.name === "table_header" || node.type.name === "table_cell") {
      // 先确认祖先链里有 table_head
      let d = pos + 1;
      let inHead = false;
      const $ = doc.resolve(d);
      for (let i = $.depth; i > 0; i--) {
        if ($.node(i).type.name === "table_head") {
          inHead = true;
          break;
        }
      }
      if (inHead) found = d;
      return false;
    }
    return true;
  });
  return found;
}

/** 找到 table 内 table_body 内第一个单元格的位置（同上，返回内容 pos） */
function findBodyCellPos(doc: PMNode): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found !== -1) return false;
    if (node.type.name === "table_header" || node.type.name === "table_cell") {
      const d = pos + 1;
      const $ = doc.resolve(d);
      for (let i = $.depth; i > 0; i--) {
        if ($.node(i).type.name === "table_body") {
          found = d;
          break;
        }
      }
      return false;
    }
    return true;
  });
  return found;
}

describe("v0.11.0 B1-2 表格删除行不丢表头", () => {
  it("【复现 P0】无 table_head 时 serializer 不得把首行当表头", () => {
    const doc = markdownToDoc(SRC);
    const tablePos = findTablePos(doc);
    expect(tablePos).toBeGreaterThanOrEqual(0);

    // 人工构造「删掉 table_head」的文档（复现缺陷场景）
    const table = doc.child(tablePos);
    const head = table.child(0);
    const body = table.child(1);
    expect(head.type.name).toBe("table_head");

    // table_head? 可选 → 删掉后文档仍合法
    const brokenTable = schema.nodes.table.create(
      null,
      body, // 只有 table_body
    );
    // 顶层块替换：B6 机制下用新对象确保走真实序列化
    const brokenDoc = doc.type.create(doc.attrs, schema.nodes.paragraph.create(), doc.marks);
    const withBroken = schema.nodes.doc.create(null, [
      brokenTable,
      schema.nodes.paragraph.create(),
    ]);

    const out = docToMarkdown(withBroken);
    // 数据行不得被当成表头输出：| 1 | 2 | 不应出现在表头位置
    const lines = out.trim().split("\n");
    expect(lines[0]).not.toBe("| 1 | 2 |");
    // 且原表头 A/B 已随 head 删除而不存在——关键是不能把数据伪装成表头
    expect(lines.length).toBeGreaterThan(0);
  });

  it("deleteRow 在表头内被拒绝（返回 null）", () => {
    const doc = markdownToDoc(SRC);
    const headCellPos = findHeadCellPos(doc);
    expect(headCellPos).toBeGreaterThanOrEqual(0);

    const st = EditorState.create({ doc, schema });
    const $pos = st.doc.resolve(headCellPos);
    const result = deleteRow(st.tr, $pos);

    // 修复后：拒绝删除 → 返回 null，不产生事务
    expect(result).toBeNull();
  });

  it("表头行删除被拒后，文档内容与原文完全一致", () => {
    const doc = markdownToDoc(SRC);
    const headCellPos = findHeadCellPos(doc);
    const st = EditorState.create({ doc, schema });
    const result = deleteRow(st.tr, st.doc.resolve(headCellPos));

    expect(result).toBeNull();
    // 原文档未被改动（B6 原文保留 → 逐字节一致）
    expect(docToMarkdown(doc)).toBe(SRC);
    // 关键：A/B 表头仍在
    expect(docToMarkdown(doc)).toContain("| A | B |");
  });

  it("表体行删除行为不变（删除末行成功，且不删唯一行）", () => {
    const doc = markdownToDoc(SRC);
    const bodyCellPos = findBodyCellPos(doc);
    expect(bodyCellPos).toBeGreaterThanOrEqual(0);

    const st = EditorState.create({ doc, schema });
    const result = deleteRow(st.tr, st.doc.resolve(bodyCellPos));
    // tbody 有 2 行，删除首行应成功
    expect(result).not.toBeNull();
    const out = docToMarkdown(result!.doc);
    // 表头保留
    expect(out).toContain("| A | B |");
    // 被删的是「1 | 2」行，保留「3 | 4」
    expect(out).toContain("| 3 | 4 |");
    expect(out).not.toContain("| 1 | 2 |");
  });

  it("表体仅剩一行时拒绝删除（既有策略不回归）", () => {
    // 单行表体
    const doc = markdownToDoc("| A | B |\n| --- | --- |\n| 1 | 2 |");
    const bodyCellPos = findBodyCellPos(doc);
    const st = EditorState.create({ doc, schema });
    const result = deleteRow(st.tr, st.doc.resolve(bodyCellPos));
    expect(result).toBeNull();
  });

  it("deleteColumn 行为不变（表头列可删，各行同步）", () => {
    const doc = markdownToDoc(SRC);
    const headCellPos = findHeadCellPos(doc);
    const st = EditorState.create({ doc, schema });
    const result = deleteColumn(st.tr, st.doc.resolve(headCellPos));
    expect(result).not.toBeNull();
    // 删除首列后只剩 B 列
    const out = docToMarkdown(result!.doc);
    expect(out).toContain("| B |");
    expect(out).not.toContain("| A |");
  });
});
