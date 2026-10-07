/**
 * v0.11.0 B3-6：有序列表 `1)` 语法支持（解析→输入→序列化全链路对称）。
 *
 * 缺陷背景（P1·不对称）：
 *   markdown-it 解析端**支持** `1)`，但 inputrules 只注册 `/^(\d+)\.\s$/`
 *   → 用户无法用键盘打出 `1)` 列表（能打开、不能输入）；
 *   且 serializer 固定用 `1.` 递增 → 打开含 `1)` 的旧文档后**一旦编辑，
 *   `)` 被改写成 `.`**，用户/原文的写法被静默破坏。
 *
 * 修复：① schema 的 ordered_list 加 delim attr（默认 "."）；② parser 从
 *   token.markup 读原始分隔符；③ inputrules 抽出 makeOrderedListRule 工厂，
 *   同时注册 `.` 与 `)`；④ serializer 按 delim 输出。
 *
 * ⚠️ **B6 原文保留陷阱**：本测试用 `reparse` 重建节点对象强制走真实序列化，
 *   否则「编辑后 `)` 是否丢失」这一核心断言会被 B6 掩盖而恒通过。
 */
import { describe, it, expect } from "vitest";
import { lightMDSchema } from "../core/schema";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";

const schema = lightMDSchema;

/** 模拟「用户编辑过该块」：重建顶层块脱离 B6 原文映射 */
function reparse(md: string): string {
  const doc = markdownToDoc(md);
  const kids = [];
  for (let i = 0; i < doc.childCount; i++) {
    const c = doc.child(i);
    kids.push(c.type.create(c.attrs, c.content, c.marks));
  }
  return docToMarkdown(doc.type.create(doc.attrs, kids, doc.marks));
}

/** 取文档里第一个 ordered_list 节点 */
function firstOrdered(doc: import("prosemirror-model").Node) {
  let found: any = null;
  doc.descendants((node) => {
    if (!found && node.type.name === "ordered_list") found = node;
    return !found;
  });
  return found;
}

describe("v0.11.0 B3-6 有序列表 1) 对称性", () => {
  it("解析 `1)` 时记录 delim=')'", () => {
    const doc = markdownToDoc("1) foo\n2) bar");
    const list = firstOrdered(doc);
    expect(list).not.toBeNull();
    expect(list.type.name).toBe("ordered_list");
    expect(list.attrs.delim).toBe(")");
  });

  it("解析 `1.` 时 delim='.'（既有行为不回归）", () => {
    const doc = markdownToDoc("1. foo\n2. bar");
    const list = firstOrdered(doc);
    expect(list.attrs.delim).toBe(".");
  });

  it("未编辑时往返保持 `1)` 原样（B6 路径逐字节返回源文本）", () => {
    // B6 原文保留对未编辑块逐字节返回源文本，故此处无尾部换行
    expect(docToMarkdown(markdownToDoc("1) foo\n2) bar"))).toBe("1) foo\n2) bar");
  });

  it("【核心】编辑后 `)` 不被改写成 `.`（修复前会丢失写法）", () => {
    const out = reparse("1) foo\n2) bar");
    expect(out).toContain("1)");
    expect(out).not.toMatch(/^\d+\. foo$/m);
  });

  it("含 `1.` 的文档编辑后仍是 `.`（无回归）", () => {
    const out = reparse("1. foo\n2. bar");
    expect(out).toBe("1. foo\n2. bar\n");
  });

  it("起始序号与分隔符同时保留（`5)` 不被改成 `1)` 或 `5.`）", () => {
    const doc = markdownToDoc("5) five\n6) six");
    const list = firstOrdered(doc);
    expect(list.attrs.order).toBe(5);
    expect(list.attrs.delim).toBe(")");
    const out = reparse("5) five\n6) six");
    expect(out).toBe("5) five\n6) six\n");
  });

  it("旧文档无 delim attr 时回退 '.'（schema 默认值）", () => {
    // 手工构造无 delim 的节点（模拟旧版本序列化产物）
    const doc = markdownToDoc("1. x");
    const list = firstOrdered(doc);
    const legacy = schema.nodes.ordered_list.create({ order: 1 }, list.content);
    expect(legacy.attrs.delim).toBe(".");
    const wrapped = schema.nodes.doc.create(null, [legacy, schema.nodes.paragraph.create()]);
    expect(docToMarkdown(wrapped)).toContain("1. x");
  });

  it("toDOM 不因新 attr 产生额外属性（start 逻辑不变）", () => {
    const doc = markdownToDoc("3) c\n4) d");
    const list = firstOrdered(doc);
    const dom = schema.nodes.ordered_list.spec.toDOM!(list) as unknown as [string, Record<string, string>];
    expect(dom[0]).toBe("ol");
    // order=3 → start="3"；delim 不体现在 DOM（DOM 无分隔符概念）
    expect(dom[1].start).toBe("3");
  });
});
