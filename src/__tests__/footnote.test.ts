/**
 * 脚注功能测试（P7）
 *
 * 验证：
 * 1. [^1] 引用被解析为 footnote_ref inline 节点
 * 2. [^1]: content 被解析为 footnote_definition block 节点
 * 3. 序列化往返一致
 *
 * 简化方案：阅读模式（ProseMirror）下，footnote_ref 作为 inline 节点，
 * footnote_definition 作为 block 节点。分屏预览/导出由 markdown-it-footnote 渲染。
 */
import { describe, it, expect } from "vitest";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import { md } from "../core/markdown/parser";

describe("脚注 [^1]", () => {
  it("分屏预览应渲染脚注为 HTML", () => {
    const html = md.render("Here is a footnote reference,[^1]\n\n[^1]: This is the footnote content\n");
    // markdown-it-footnote 渲染为带 class 的 sup 和 section
    expect(html).toMatch(/fnref/);
    expect(html).toMatch(/footnote/);
  });

  it("应该解析 [^1] 引用为 footnote_ref 节点", () => {
    const src = "Here is a footnote reference,[^1]\n\n[^1]: This is the footnote content\n";
    const doc = markdownToDoc(src);
    // 第一个节点是包含 footnote_ref 的段落
    const para = doc.firstChild!;
    expect(para.type.name).toBe("paragraph");
    // 找到 footnote_ref 节点
    let foundRef = false;
    para.forEach((child) => {
      if (child.type.name === "footnote_ref") {
        expect(child.attrs.label).toBe("1");
        foundRef = true;
      }
    });
    expect(foundRef).toBe(true);
  });

  it("应该解析 [^1]: content 为 footnote_definition 节点", () => {
    const src = "Here is a footnote reference,[^1]\n\n[^1]: This is the footnote content\n";
    const doc = markdownToDoc(src);
    // 找到 footnote_definition 节点
    let foundDef = false;
    doc.forEach((node) => {
      if (node.type.name === "footnote_definition") {
        expect(node.attrs.label).toBe("1");
        expect(node.textContent).toContain("This is the footnote content");
        foundDef = true;
      }
    });
    expect(foundDef).toBe(true);
  });

  it("序列化 footnote_ref 为 [^label]", () => {
    const src = "Reference[^1]\n\n[^1]: content\n";
    const doc = markdownToDoc(src);
    const out = docToMarkdown(doc);
    expect(out).toContain("[^1]");
    expect(out).toContain("[^1]: content");
  });

  it("往返序列化应保持一致", () => {
    const src = "Reference[^1]\n\n[^1]: content here\n";
    const doc = markdownToDoc(src);
    const out = docToMarkdown(doc);
    // 验证关键部分
    expect(out).toContain("Reference[^1]");
    expect(out).toContain("[^1]: content here");
  });

  it("支持多个脚注", () => {
    const src = "First[^1] and second[^2]\n\n[^1]: one\n[^2]: two\n";
    const doc = markdownToDoc(src);
    // 验证有两个 footnote_definition
    let defCount = 0;
    doc.forEach((node) => {
      if (node.type.name === "footnote_definition") defCount++;
    });
    expect(defCount).toBe(2);
  });
});
