/**
 * 高亮标记 ==text== 功能测试（P6）
 *
 * 验证：
 * 1. markdown-it-mark 解析 ==text== 生成 mark_open/mark_close token
 * 2. parser 将 mark token 转换为 ProseMirror mark 节点
 * 3. serializer 将 mark 节点序列化回 ==text==
 * 4. 往返序列化保持一致
 */
import { describe, it, expect } from "vitest";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import { lightMDSchema } from "../core/schema";

describe("高亮标记 ==text==", () => {
  it("应该正确解析 ==text== 为 mark 标记", () => {
    const md = "这是 ==高亮文本== 测试\n";
    const doc = markdownToDoc(md);
    const para = doc.firstChild!;
    expect(para.type.name).toBe("paragraph");
    // 找到带 mark 的文本节点
    const textNode = para.firstChild!;
    expect(textNode.isText).toBe(true);
    // 第一个文本节点应该是 "这是 "（无 mark）
    expect(textNode.text).toBe("这是 ");
    // 第二个节点应该带 mark
    const markedNode = para.child(1)!;
    expect(markedNode.marks.some((m) => m.type.name === "mark")).toBe(true);
    expect(markedNode.text).toBe("高亮文本");
  });

  it("应该正确序列化 mark 标记为 ==text==", () => {
    const doc = lightMDSchema.topNodeType.create(null, [
      lightMDSchema.nodes.paragraph.create(null, [
        lightMDSchema.text("前"),
        lightMDSchema.text("高亮", [lightMDSchema.mark("mark")]),
        lightMDSchema.text("后"),
      ]),
    ]);
    const md = docToMarkdown(doc);
    expect(md).toContain("==高亮==");
  });

  it("往返序列化应保持一致", () => {
    const src = "这是 ==高亮== 测试\n";
    const doc = markdownToDoc(src);
    const out = docToMarkdown(doc);
    expect(out.trim()).toBe("这是 ==高亮== 测试");
  });

  it("多个高亮标记应分别处理", () => {
    const src = "==第一个== 和 ==第二个==\n";
    const doc = markdownToDoc(src);
    const para = doc.firstChild!;
    // 计数带 mark 的节点
    let count = 0;
    para.forEach((child) => {
      if (child.marks.some((m) => m.type.name === "mark")) count++;
    });
    expect(count).toBe(2);
  });

  it("高亮与其他标记可共存", () => {
    const src = "==**粗高亮**==\n";
    const doc = markdownToDoc(src);
    const para = doc.firstChild!;
    const node = para.firstChild!;
    expect(node.marks.some((m) => m.type.name === "mark")).toBe(true);
    expect(node.marks.some((m) => m.type.name === "strong")).toBe(true);
  });
});
