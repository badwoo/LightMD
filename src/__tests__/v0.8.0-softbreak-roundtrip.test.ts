/**
 * v0.8.0 WP5 修复6：模式切换丢失回车换行
 *
 * 背景：parser 把段内 softbreak 解析成 schema.text(" ")，serializer 把 hard_break
 * 序列化为裸 "\n"，导致段内单换行在 md→doc→md 往返后变成空格，切换模式/页签
 * 后内容丢失。同时列表项 / 表格单元格内用 .content join 也丢了段内换行。
 *
 * 修复：softbreak → hard_break 节点；hard_break → "  \n"（CommonMark 两空格硬换行）；
 * parseList / buildTableRow 改走 children 解析（与 inline 一致）。
 *
 * 验收：段内换行 doc→md→doc 往返保真；列表项内、表格单元格内换行保真；
 *      段落级换行（\n\n）仍稳定。
 */
import { describe, it, expect } from "vitest";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import { lightMDSchema as schema } from "../core/schema";
import { Node as PMNodeCtor } from "prosemirror-model";
import type { Node as PMNode } from "prosemirror-model";

/** 深拷贝重建 doc → 全部节点丢失原文记录（模拟 v0.9.0 miss / 编辑后路径） */
function missCopy(doc: PMNode): PMNode {
  return PMNodeCtor.fromJSON(schema, doc.toJSON());
}

/** 统计 doc 中各类节点数量 */
function countNodes(doc: PMNode): Record<string, number> {
  const m: Record<string, number> = {};
  doc.descendants((node) => {
    m[node.type.name] = (m[node.type.name] || 0) + 1;
    return true;
  });
  return m;
}

/** 段内换行数 = hard_break 节点数 */
function hardBreakCount(doc: PMNode): number {
  return countNodes(doc).hard_break || 0;
}

/** 提取首段落（顶层第一个 paragraph）的 inline 文本片段序列，便于断言 */
function firstParagraphText(doc: PMNode): string {
  let s = "";
  doc.firstChild?.forEach((child) => {
    if (child.isText) s += child.text;
    else if (child.type.name === "hard_break") s += "⏎";
  });
  return s;
}

describe("v0.8.0 修复6：段内单换行往返保真", () => {
  it("3 行段内文本：md→doc→md→doc 往返结构一致，含 2 个 hard_break", () => {
    const src = "a\nb\nc\n";
    const doc1 = markdownToDoc(src);
    expect(hardBreakCount(doc1)).toBe(2);
    expect(firstParagraphText(doc1)).toBe("a⏎b⏎c");

    const md = docToMarkdown(doc1);
    // v0.9.0 B6：未编辑 doc 走快路径逐字节返回原文（保真优先）
    expect(md).toBe(src);
    // v0.9.0：miss 路径（编辑过的块）仍按 CommonMark 规范输出两空格硬换行，
    // 与 parser 的 softbreak→hard_break 互逆（结构往返验证）
    const mdMiss = docToMarkdown(missCopy(doc1));
    expect(mdMiss).toBe("a  \nb  \nc\n");

    const doc2 = markdownToDoc(md);
    expect(doc1.eq(doc2)).toBe(true);
  });

  it("两段内文本（含混合标点）往返保真", () => {
    const src = "第一行文本\n第二行文本\n第三行\n";
    const doc1 = markdownToDoc(src);
    expect(hardBreakCount(doc1)).toBe(2);
    const md = docToMarkdown(doc1);
    const doc2 = markdownToDoc(md);
    expect(doc1.eq(doc2)).toBe(true);
  });

  it("段落级换行（\\n\\n）不被错误合并为 hard_break，仍是两个段落", () => {
    const src = "段落甲\n\n段落乙\n";
    const doc = markdownToDoc(src);
    // 仅 2 个段落，无 hard_break
    expect(hardBreakCount(doc)).toBe(0);
    const types: string[] = [];
    doc.forEach((n) => types.push(n.type.name));
    expect(types).toEqual(["paragraph", "paragraph"]);
    // 往返稳定（段落级换行本就稳定，回归防护）
    expect(docToMarkdown(markdownToDoc(src))).toBe(src);
  });

  it("单换行 + 段落级换行混合：段内换行保真、段落分隔保留", () => {
    const src = "甲第一行\n甲第二行\n\n乙第一行\n乙第二行\n";
    const doc1 = markdownToDoc(src);
    // 2 个段落，每段 1 个 hard_break
    expect(hardBreakCount(doc1)).toBe(2);
    const md = docToMarkdown(doc1);
    const doc2 = markdownToDoc(md);
    expect(doc1.eq(doc2)).toBe(true);
  });
});

describe("v0.8.0 修复6：列表项内换行保真", () => {
  it("无序列表项内段内换行：往返保真且保留 hard_break", () => {
    const src = "- 项目一第一行\n  项目一第二行\n- 项目二\n";
    const doc1 = markdownToDoc(src);
    // doc1 含 1 个 hard_break（第一个 list item 内）
    expect(hardBreakCount(doc1)).toBe(1);
    const md = docToMarkdown(doc1);
    const doc2 = markdownToDoc(md);
    expect(doc1.eq(doc2)).toBe(true);
  });

  it("多行列表项往返：内容不丢失、换行结构一致", () => {
    const src = "1. 第一步\n   第二步\n2. 另一项\n";
    const doc1 = markdownToDoc(src);
    const md = docToMarkdown(doc1);
    const doc2 = markdownToDoc(md);
    expect(doc1.eq(doc2)).toBe(true);
  });
});
describe("v0.8.0 修复6：表格单元格内换行保真", () => {
  // 说明：markdown-it 的 GFM 表格不支持单元格内多行（源码中单元格内的 \n 会被
  // 解析成新行而非单元格内换行），这是 markdown-it 限制而非本修复回归。
  // 因此本组测试聚焦：buildTableRow 已改走 children 解析（与 inline 一致），
  // 单元格内 hard_break 节点经序列化输出 "  \n" 且不丢文本；普通表格 roundtrip 零回归。

  /** 构造含单元格内 hard_break 的表格 doc（程序化，绕过 markdown-it 表格语法限制） */
  function docWithCellBreak(): PMNode {
    const text = (s: string) => schema.text(s);
    const br = schema.nodes.hard_break.create();
    const cell = schema.nodes.table_cell.create(
      { align: "left" },
      [text("第一行"), br, text("第二行")]
    );
    const row = schema.nodes.table_row.create(null, [cell]);
    const headCell = schema.nodes.table_header.create({ align: "left" }, [text("内容")]);
    const headRow = schema.nodes.table_row.create(null, [headCell]);
    const table = schema.nodes.table.create(null, [
      schema.nodes.table_head.create(null, [headRow]),
      schema.nodes.table_body.create(null, [row]),
    ]);
    return schema.topNodeType.create(null, [table]);
  }

  it("单元格内 hard_break：序列化输出 <br>（P0-1，真实换行会截断 GFM 表格行）", () => {
    const doc1 = docWithCellBreak();
    expect(hardBreakCount(doc1)).toBe(1);
    const md = docToMarkdown(doc1);
    // v0.8.0 修复 P0-1：单元格内换行必须写成 <br>，绝不能出现真实换行（会把表格截成两段）
    expect(md).toContain("第一行<br>第二行");
    expect(md).not.toContain("第一行  \n第二行");
    // 表格结构完整：序列化结果重解析仍是单个表格
    const doc2 = markdownToDoc(md);
    let tableCount = 0;
    doc2.descendants((n) => { if (n.type.name === "table") tableCount++; return true; });
    expect(tableCount).toBe(1);
    // 换行保真：还原后单元格内仍是 hard_break，且文本不丢
    expect(hardBreakCount(doc2)).toBe(1);
    let allText = "";
    doc2.descendants((n) => { if (n.isText) allText += n.text; return true; });
    expect(allText).toContain("第一行");
    expect(allText).toContain("第二行");
  });

  it("源文件表格里的 <br>（GFM 表格多行单元格惯例）解析为 hard_break 并往返为 <br>", () => {
    const src = "| 内容 |\n| --- |\n| 甲<br>乙 |\n";
    const doc1 = markdownToDoc(src);
    expect(hardBreakCount(doc1)).toBe(1);
    const md = docToMarkdown(doc1);
    expect(md).toContain("甲<br>乙");
    const doc2 = markdownToDoc(md);
    expect(hardBreakCount(doc2)).toBe(1);
  });

  it("普通表格（无单元格换行）roundtrip 零回归：结构一致", () => {
    const src = "| A | B |\n| --- | --- |\n| a | b |\n| c | d |\n";
    const doc1 = markdownToDoc(src);
    expect(hardBreakCount(doc1)).toBe(0);
    const md = docToMarkdown(doc1);
    const doc2 = markdownToDoc(md);
    expect(doc1.eq(doc2)).toBe(true);
  });
});
