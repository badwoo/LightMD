/**
 * G2 脚注悬浮预览 - 纯函数单元测试
 *
 * 测试范围：
 * 1. findFootnoteDefinition：从 doc 中查找匹配 label 的 footnote_definition 节点
 *    - 找到对应 label 的节点
 *    - label 不匹配时返回 null
 *    - 无任何 definition 时返回 null
 *    - 多个 definition 时匹配正确的那个
 * 2. serializeFootnoteToHTML：序列化 definition 内容为 DocumentFragment
 *    - 保留纯文本
 *    - 保留 inline 格式（粗体、斜体、代码）
 *    - 保留链接
 *    - 空内容返回空 fragment
 *
 * DOM 交互部分（mouseover/mouseout/scroll）不写测试，靠模拟测试阶段验证。
 */
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { markdownToDoc } from "../core/markdown/parser";
import { lightMDSchema } from "../core/schema";
import {
  findFootnoteDefinition,
  serializeFootnoteToHTML,
} from "../core/plugins/footnote-hover";

describe("findFootnoteDefinition - 查找脚注定义", () => {
  it("找到对应 label 的 footnote_definition", () => {
    const doc = markdownToDoc(
      "Reference[^1]\n\n[^1]: This is the footnote content\n"
    );
    const node = findFootnoteDefinition(doc, "1");
    expect(node).not.toBeNull();
    expect(node!.type.name).toBe("footnote_definition");
    expect(node!.attrs.label).toBe("1");
    expect(node!.textContent).toContain("This is the footnote content");
  });

  it("label 不匹配时返回 null", () => {
    const doc = markdownToDoc("Reference[^1]\n\n[^1]: content\n");
    const node = findFootnoteDefinition(doc, "999");
    expect(node).toBeNull();
  });

  it("无任何 footnote_definition 时返回 null", () => {
    const doc = markdownToDoc("No footnote here.\n");
    const node = findFootnoteDefinition(doc, "1");
    expect(node).toBeNull();
  });

  it("多个 definition 时匹配正确的那个", () => {
    const doc = markdownToDoc(
      "First[^1] and second[^2]\n\n[^1]: one\n[^2]: two\n"
    );

    const node1 = findFootnoteDefinition(doc, "1");
    expect(node1).not.toBeNull();
    expect(node1!.attrs.label).toBe("1");
    expect(node1!.textContent).toContain("one");

    const node2 = findFootnoteDefinition(doc, "2");
    expect(node2).not.toBeNull();
    expect(node2!.attrs.label).toBe("2");
    expect(node2!.textContent).toContain("two");

    // 确保不是同一个节点
    expect(node1).not.toBe(node2);
  });

  it("空字符串 label 不抛异常，未找到返回 null", () => {
    const doc = markdownToDoc("Reference[^1]\n\n[^1]: content\n");
    const node = findFootnoteDefinition(doc, "");
    expect(node).toBeNull();
  });

  it("label 含特殊字符（非纯数字）也能匹配", () => {
    const doc = markdownToDoc(
      "Reference[^note-1]\n\n[^note-1]: content here\n"
    );
    const node = findFootnoteDefinition(doc, "note-1");
    expect(node).not.toBeNull();
    expect(node!.attrs.label).toBe("note-1");
  });

  it("空 doc 不抛异常", () => {
    const emptyDoc = lightMDSchema.topNodeType.create(null, []);
    const node = findFootnoteDefinition(emptyDoc, "1");
    expect(node).toBeNull();
  });
});

describe("serializeFootnoteToHTML - 序列化为 HTML", () => {
  /** 工具函数：将 fragment 转为 HTML 字符串便于断言 */
  function fragmentToHTML(fragment: DocumentFragment): string {
    const div = document.createElement("div");
    div.appendChild(fragment.cloneNode(true));
    return div.innerHTML;
  }

  it("序列化纯文本内容", () => {
    const doc = markdownToDoc(
      "Reference[^1]\n\n[^1]: plain text content\n"
    );
    const node = findFootnoteDefinition(doc, "1")!;
    const fragment = serializeFootnoteToHTML(node, lightMDSchema);

    expect(fragment).toBeInstanceOf(DocumentFragment);
    expect(fragment.textContent).toContain("plain text content");
  });

  it("保留 inline 格式：粗体", () => {
    const doc = markdownToDoc(
      "Reference[^1]\n\n[^1]: this is **bold** text\n"
    );
    const node = findFootnoteDefinition(doc, "1")!;
    const html = fragmentToHTML(serializeFootnoteToHTML(node, lightMDSchema));

    expect(html).toContain("<strong>bold</strong>");
  });

  it("保留 inline 格式：斜体", () => {
    const doc = markdownToDoc(
      "Reference[^1]\n\n[^1]: this is *italic* text\n"
    );
    const node = findFootnoteDefinition(doc, "1")!;
    const html = fragmentToHTML(serializeFootnoteToHTML(node, lightMDSchema));

    expect(html).toContain("<em>italic</em>");
  });

  it("保留 inline 格式：行内代码", () => {
    const doc = markdownToDoc(
      "Reference[^1]\n\n[^1]: see `code` here\n"
    );
    const node = findFootnoteDefinition(doc, "1")!;
    const html = fragmentToHTML(serializeFootnoteToHTML(node, lightMDSchema));

    // code mark 可能带 class（如 inline-code），用正则匹配更稳健
    expect(html).toMatch(/<code[^>]*>code<\/code>/);
  });

  it("保留链接（href 正确）", () => {
    const doc = markdownToDoc(
      "Reference[^1]\n\n[^1]: see [link](https://example.com)\n"
    );
    const node = findFootnoteDefinition(doc, "1")!;
    const html = fragmentToHTML(serializeFootnoteToHTML(node, lightMDSchema));

    expect(html).toMatch(/<a href="https:\/\/example\.com"/);
    expect(html).toMatch(/<a [^>]*>link<\/a>/);
  });

  it("混合格式同时保留", () => {
    const doc = markdownToDoc(
      "Reference[^1]\n\n[^1]: **bold** and *italic* and `code` and [link](https://test.com)\n"
    );
    const node = findFootnoteDefinition(doc, "1")!;
    const html = fragmentToHTML(serializeFootnoteToHTML(node, lightMDSchema));

    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    // code mark 可能带 class（如 inline-code），用正则匹配更稳健
    expect(html).toMatch(/<code[^>]*>code<\/code>/);
    expect(html).toMatch(/<a href="https:\/\/test\.com"/);
  });

  it("空内容返回空 fragment", () => {
    // 直接构造空内容的 footnote_definition 节点
    const emptyNode = lightMDSchema.nodes.footnote_definition.create(
      { label: "1" }
    );
    const fragment = serializeFootnoteToHTML(emptyNode, lightMDSchema);

    expect(fragment.childNodes.length).toBe(0);
  });
});

describe("集成：查找 + 序列化联动", () => {
  it("查找节点后序列化内容正确", () => {
    const doc = markdownToDoc(
      "Reference[^1]\n\n[^1]: the **content** here\n"
    );
    const node = findFootnoteDefinition(doc, "1");
    expect(node).not.toBeNull();

    const div = document.createElement("div");
    div.appendChild(serializeFootnoteToHTML(node!, lightMDSchema));

    expect(div.innerHTML).toContain("<strong>content</strong>");
    expect(div.textContent).toContain("the content here");
  });

  it("多个脚注查找互不干扰", () => {
    const doc = markdownToDoc(
      "First[^1] second[^2] third[^3]\n\n[^1]: one\n[^2]: two\n[^3]: three\n"
    );

    const node2 = findFootnoteDefinition(doc, "2");
    expect(node2).not.toBeNull();
    expect(node2!.textContent).toContain("two");

    const div = document.createElement("div");
    div.appendChild(serializeFootnoteToHTML(node2!, lightMDSchema));
    expect(div.textContent).toContain("two");
    // 确保不会包含其他 definition 的内容
    expect(div.textContent).not.toContain("one");
    expect(div.textContent).not.toContain("three");
  });
});
