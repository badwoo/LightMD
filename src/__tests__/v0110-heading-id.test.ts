/**
 * v0.11.0 B4-5：标题锚点 id 提升为节点 attr（三处口径统一）。
 *
 * 缺陷背景（P1）：
 *   锚点此前只存在于 markdown-it 的**渲染输出**（heading-anchor 写
 *   token.attrs），而阅读模式走 ProseMirror 的 toDOM → 渲染出的
 *   `<h1>~<h3>` **没有 id 属性** → 文内 `[链接](#标题)` 在阅读模式点不动。
 *   文档内锚点跳转只在 markdown-it 路径（分屏预览 / 导出）有效，
 *   两种编辑模式行为不一致。
 *
 * 修复：id 提升为 heading 节点的 attr，三处统一：
 *   ① parser 从 token.attrs 读入写入节点；
 *   ② schema.toDOM 输出 id（空串则不输出）；
 *   ③ serializer 忽略（`## 标题` 标准语法不带 id，不写回源码）。
 *
 * 同时修掉一个 B4-7 引入的真实 bug：toc-update 自带 slugify 副本且
 * 重名去重口径与 heading-anchor 不一致（那边 `-1`，这边 `-2`）→
 * 阅读模式 TOC 里第二个「Same」指向 #same-2，而正文 id 是 #same-1，跳不过去。
 */
import { describe, it, expect } from "vitest";
import { lightMDSchema } from "../core/schema";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import { collectHeadings as collectHeadingsFromTokens } from "../core/markdown/heading-anchor";
import { createDefaultMarkdownIt } from "../utils/exportBlocks";
import { collectHeadings } from "../core/plugins/toc-update";

const schema = lightMDSchema;

/** 收集 doc 中全部 heading 节点 */
function headingNodes(md: string) {
  const out: { level: number; id: string; text: string }[] = [];
  markdownToDoc(md).forEach((node: any) => {
    if (node.type.name === "heading") {
      out.push({ level: node.attrs.level, id: node.attrs.id, text: node.textContent });
    }
  });
  return out;
}

describe("v0.11.0 B4-5 标题锚点 id 提升为 attr", () => {
  it("schema.heading 有 id attr（默认空串，兼容旧节点）", () => {
    const spec: any = schema.nodes.heading.spec;
    expect(spec.attrs).toHaveProperty("id");
    expect(spec.attrs.id.default).toBe("");
  });

  it("解析时把 markdown-it 算出的 id 写入节点", () => {
    const hs = headingNodes("# Hello World\n\n## 二级标题\n");
    expect(hs[0].id).toBe("hello-world");
    expect(hs[1].id).toBe("二级标题");
  });

  it("toDOM 输出 id 属性（阅读模式可跳转的前提）", () => {
    const doc = markdownToDoc("# Anchor Target\n");
    const h: any = doc.child(0);
    const dom = schema.nodes.heading.spec.toDOM!(h) as unknown as [string, Record<string, string>];
    expect(dom[0]).toBe("h1");
    expect(dom[1]).toHaveProperty("id", "anchor-target");
  });

  it("id 为空时不输出 id 属性（保持与旧渲染一致）", () => {
    const h = schema.nodes.heading.create({ level: 2, id: "" }, schema.text("x"));
    const dom = schema.nodes.heading.spec.toDOM!(h) as unknown as [string, unknown];
    // 无 attrs 参数 → 退化为 [tag, 0]
    expect(dom[1]).toBe(0);
  });

  it("同名标题去重与 markdown-it 侧完全一致（-1 口径）", () => {
    // markdown-it 侧
    const inst = createDefaultMarkdownIt();
    const tokens = inst.parse("# Same\n\n# Same\n", {});
    const fromTokens = collectHeadingsFromTokens(tokens as never);
    // PM 侧
    const fromDoc = headingNodes("# Same\n\n# Same\n");
    expect(fromTokens.map((h) => h.id)).toEqual(fromDoc.map((h) => h.id));
    expect(fromDoc[0].id).toBe("same");
    expect(fromDoc[1].id).toBe("same-1");
  });

  it("toc-update 的 collectHeadings 与 heading 节点 id 一致（B4-7/B4-5 口径统一）", () => {
    const md = "# Alpha\n\n## Beta\n\n# Alpha\n";
    const doc = markdownToDoc(md);
    const nodeIds = collectHeadings(doc).map((h) => h.id);
    // toc-update 独立重算的 id 应与节点 attr 完全一致
    const attrIds: string[] = [];
    doc.forEach((n: any) => {
      if (n.type.name === "heading") attrIds.push(n.attrs.id);
    });
    expect(nodeIds).toEqual(attrIds);
  });

  it("序列化不把 id 写回 Markdown 源码（`## 标题` 语法不带 id）", () => {
    const doc = markdownToDoc("# Hello World\n");
    const out = docToMarkdown(doc);
    expect(out).toContain("# Hello World");
    expect(out).not.toContain("hello-world");
    expect(out).not.toContain("{#");
  });

  it("旧文档（无 id 的 heading 节点）序列化不回归", () => {
    // 手工构造无 id 的节点，模拟旧版本产物
    const h = schema.nodes.heading.create({ level: 1 }, schema.text("Legacy"));
    const doc = schema.topNodeType.create(null, [h]);
    expect(docToMarkdown(doc)).toContain("# Legacy");
  });

  it("标题内含行内代码时 slug 正确（保留代码内容）", () => {
    const hs = headingNodes("# Use `npm run build` Now\n");
    expect(hs[0].id).toBe("use-npm-run-build-now");
  });

  it("空文本标题得到 'heading' 兜底 id（不留空 id）", () => {
    // 纯符号标题经 slugify 会变空串
    const hs = headingNodes("# !!!\n");
    expect(hs[0].id).toBe("heading");
    expect(hs[0].id.length).toBeGreaterThan(0);
  });

  it("三级及以上标题同样带 id（不止 h1-h3）", () => {
    const hs = headingNodes("#### H4\n\n##### H5\n\n###### H6\n");
    expect(hs.map((h) => h.id)).toEqual(["h4", "h5", "h6"]);
  });
});
