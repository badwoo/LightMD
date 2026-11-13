/**
 * 定义列表功能测试（P19）
 *
 * 验证：
 * 1. 术语\n: 定义 语法被解析为 definition_list 节点
 * 2. definition_term 和 definition_description 节点正确生成
 * 3. 序列化往返一致
 *
 * 简化方案：阅读模式下 definition_list 作为容器节点，
 * 分屏预览/导出由 markdown-it-deflist 渲染。
 */
import { describe, it, expect } from "vitest";
import { Node } from "prosemirror-model";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import { md } from "../core/markdown/parser";

describe("定义列表", () => {
  it("分屏预览应渲染定义列表为 HTML", () => {
    const html = md.render("Apple\n: A fruit\n");
    expect(html).toMatch(/<dl>/);
    expect(html).toMatch(/<dt>/);
    expect(html).toMatch(/<dd>/);
  });

  it("应该解析为 definition_list 节点", () => {
    const src = "Apple\n: A fruit\n";
    const doc = markdownToDoc(src);
    const dl = doc.firstChild!;
    expect(dl.type.name).toBe("definition_list");
  });

  it("应该正确生成 definition_term 和 definition_description", () => {
    const src = "Apple\n: A fruit\n";
    const doc = markdownToDoc(src);
    const dl = doc.firstChild!;
    expect(dl.childCount).toBe(2);
    expect(dl.child(0).type.name).toBe("definition_term");
    expect(dl.child(0).textContent).toBe("Apple");
    expect(dl.child(1).type.name).toBe("definition_description");
    expect(dl.child(1).textContent).toBe("A fruit");
  });

  it("应该支持多个术语-定义对", () => {
    const src = "Apple\n: A fruit\n\nBanana\n: A yellow fruit\n";
    const doc = markdownToDoc(src);
    const dl = doc.firstChild!;
    expect(dl.type.name).toBe("definition_list");
    // 4 个子节点：2 个 term + 2 个 description
    expect(dl.childCount).toBe(4);
    expect(dl.child(0).type.name).toBe("definition_term");
    expect(dl.child(0).textContent).toBe("Apple");
    expect(dl.child(2).type.name).toBe("definition_term");
    expect(dl.child(2).textContent).toBe("Banana");
  });

  it("序列化为 术语\\n: 定义 格式", () => {
    const src = "Apple\n: A fruit\n";
    const doc = markdownToDoc(src);
    const out = docToMarkdown(doc);
    expect(out).toContain("Apple");
    expect(out).toContain(": A fruit");
  });

  it("往返序列化应保持一致", () => {
    const src = "Apple\n: A fruit\n";
    const doc = markdownToDoc(src);
    const out = docToMarkdown(doc);
    // 验证关键部分
    expect(out).toContain("Apple");
    expect(out).toContain(": A fruit");
  });

  /**
   * v0.17.0 T4：dd 内块结构保真（内容模型 inline* → block+）。
   * 旧实现把 dd 内子块 textContent 拍平成 inline —— 代码块变纯文本、
   * 多段落粘连成一段。这里锁「解析保留块级结构」与「往返后结构仍在」。
   */
  it("dd 内代码块保留为独立 code_block（v0.17.0 T4）", () => {
    const doc = markdownToDoc("Term\n: def\n\n    ```js\n    x = 1;\n    ```\n");
    const dd = doc.firstChild!.child(1);
    const kinds: string[] = [];
    dd.forEach((c) => kinds.push(c.type.name));
    expect(kinds).toEqual(["paragraph", "code_block"]);
  });

  it("dd 内块在往返（reserialize）后结构保留（v0.17.0 T4）", () => {
    const src = "Term\n: def\n\n    ```js\n    x = 1;\n    ```\n";
    const doc = markdownToDoc(src);
    // JSON 往返剥离 blockSourceMap → 强制走规范序列化（同 fuzz #reserialize 口径）
    const out = docToMarkdown(Node.fromJSON(doc.type.schema, doc.toJSON()));
    expect(out).toContain("```js");
    expect(out).toContain("x = 1;");
    const dd = markdownToDoc(out).firstChild!.child(1);
    const kinds: string[] = [];
    dd.forEach((c) => kinds.push(c.type.name));
    expect(kinds).toEqual(["paragraph", "code_block"]);
  });

  it("dd 内多段落保持分段（v0.17.0 T4）", () => {
    const doc = markdownToDoc("Term\n: p1\n\n    p2\n");
    const dd = doc.firstChild!.child(1);
    const kinds: string[] = [];
    dd.forEach((c) => kinds.push(c.type.name));
    expect(kinds).toEqual(["paragraph", "paragraph"]);
    expect(dd.child(0).textContent).toBe("p1");
    expect(dd.child(1).textContent).toBe("p2");
  });
});
