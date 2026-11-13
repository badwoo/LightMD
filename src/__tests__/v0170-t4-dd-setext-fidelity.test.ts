/**
 * v0.17.0 T4 —— 统一模型保真：dd 内块结构 + Setext 标题（PM 主路径）。
 *
 * ## 子问题 a) dd 内块结构丢失
 * 根因：`definition_description` content 是 `inline*`，parser 把 dd 内子块的
 * textContent 拼成 inline、serializer 只写 inline —— 代码块变纯文本、多段落
 * 粘连成一段。修复（同 footnote_definition E15 先例）：
 * - schema：`definition_description` content `inline*` → `block+`
 * - parser：dd_open..dd_close 逐块递归解析（parseBlockToken），保留块级结构
 * - serializer：dd 内块级子节点输出为 4 空格缩进续行（首段与 `: ` 同行）
 *
 * ## 子问题 b) Setext 归一化
 * 根因：`headingToMarkdown` 一律输出 ATX，编辑过一次的 Setext 标题被改写成
 * `# Title`（未编辑的走 B6 原文切片保真）。修复：
 * - parser 把 heading_open.markup（`=` / `-`）记入节点 attr `raw.setext`
 * - serializer 读 `raw.setext`：编辑后仍输出下划线式（下划线长度按新文字重算，
 *   与 unified/serialize.ts G5-1 同口径 `max(3, len)`）；新建标题仍 ATX；
 *   Setext 只能表达 H1/H2，改级到 3+ 时回退 ATX。
 *
 * ## 探针口径
 * 「往返后保留结构」用 **reserialize**（`Node.fromJSON(doc.toJSON())` 使
 * blockSourceMap 全 miss → 强制走规范序列化，同 fuzz 的 `md-doc-md#reserialize`），
 * 避免 B6 原文快路径把未编辑文档原样返回、探针空转（恒真）。
 */
import { describe, it, expect } from "vitest";
import { Node, Fragment } from "prosemirror-model";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";

/** JSON 往返剥离 blockSourceMap → 全部块走规范序列化（同 fuzz #reserialize 口径） */
function reserialize(doc: Node): Node {
  return Node.fromJSON(doc.type.schema, doc.toJSON());
}

/** dd 的块级子节点名列表 */
function ddKinds(doc: Node): string[] {
  const dl = doc.firstChild!;
  const dd = dl.child(1);
  const kinds: string[] = [];
  dd.forEach((c) => kinds.push(c.type.name));
  return kinds;
}

/** 模拟「编辑标题文字」：保留 attrs（含 raw），只换 inline 内容 */
function editText(doc: Node, text: string): Node {
  const h = doc.firstChild!;
  const edited = h.type.create(h.attrs, h.type.schema.text(text));
  return doc.copy(Fragment.fromArray([edited]));
}

describe("T4 a) dd 内块结构保真", () => {
  it("schema：definition_description 内容模型为 block+", () => {
    const spec = markdownToDoc("T\n: d\n").type.schema.nodes.definition_description.spec;
    expect(spec.content).toBe("block+");
  });

  it("dd 内代码块解析为独立 code_block（不再拍平成文本）", () => {
    const doc = markdownToDoc("Term\n: def\n\n    ```js\n    x = 1;\n    ```\n");
    expect(ddKinds(doc)).toEqual(["paragraph", "code_block"]);
  });

  it("dd 内表格 / 列表解析为独立块级子节点", () => {
    const tbl = markdownToDoc("Term\n: def\n\n    | x | y |\n    |---|---|\n    | 1 | 2 |\n");
    expect(ddKinds(tbl)).toEqual(["paragraph", "table"]);
    const lst = markdownToDoc("Term\n: def\n\n    - a\n    - b\n");
    expect(ddKinds(lst)).toEqual(["paragraph", "bullet_list"]);
  });

  it("dd 内多段落保持分段（不再以空格粘连）", () => {
    const doc = markdownToDoc("Term\n: p1\n\n    p2\n");
    expect(ddKinds(doc)).toEqual(["paragraph", "paragraph"]);
  });

  it("reserialize 往返后 dd 内代码块/表格/列表结构保留", () => {
    for (const md of [
      "Term\n: def\n\n    ```js\n    x = 1;\n    ```\n",
      "Term\n: def\n\n    | x | y |\n    |---|---|\n    | 1 | 2 |\n",
      "Term\n: def\n\n    - a\n    - b\n",
    ]) {
      const doc = markdownToDoc(md);
      const out = docToMarkdown(reserialize(doc));
      const doc2 = markdownToDoc(out);
      expect(ddKinds(doc2), `往返后 dd 结构丢失：${JSON.stringify(md)} → ${JSON.stringify(out)}`).toEqual(
        ddKinds(doc),
      );
    }
  });

  it("reserialize 往返后 dd 内代码块内容逐字保留", () => {
    const md = "Term\n: def\n\n    ```js\n    x = 1;\n    ```\n";
    const out = docToMarkdown(reserialize(markdownToDoc(md)));
    expect(out).toContain("```js");
    expect(out).toContain("x = 1;");
    const doc2 = markdownToDoc(out);
    const code = doc2.firstChild!.child(1).child(1);
    expect(code.type.name).toBe("code_block");
    expect(code.textContent).toContain("x = 1;");
  });

  it("多组 dt/dd 往返后组数不变（组间空行分隔，lazy 续行不吞下一术语）", () => {
    const md = "Apple\n: A fruit\n\nBanana\n: A yellow fruit\n";
    const doc = markdownToDoc(md);
    expect(doc.firstChild!.childCount).toBe(4);
    const out = docToMarkdown(reserialize(doc));
    const doc2 = markdownToDoc(out);
    const dl = doc2.firstChild!;
    expect(dl.type.name).toBe("definition_list");
    expect(dl.childCount).toBe(4);
    expect(dl.child(0).textContent).toBe("Apple");
    expect(dl.child(2).textContent).toBe("Banana");
  });

  it("dd 内块 + 新组：往返后结构与组数都不变", () => {
    const md = "T1\n: a\n\n    ```js\n    x\n    ```\n\nT2\n: b\n";
    const doc = markdownToDoc(md);
    const out = docToMarkdown(reserialize(doc));
    const doc2 = markdownToDoc(out);
    const dl = doc2.firstChild!;
    expect(dl.childCount).toBe(4);
    expect(ddKinds(doc2)).toEqual(["paragraph", "code_block"]);
    expect(dl.child(3).textContent).toBe("b");
  });
});

describe("T4 b) Setext 标题保真", () => {
  it("解析记录 raw.setext（= 为 H1、- 为 H2）", () => {
    expect(markdownToDoc("T1\n===\n").firstChild!.attrs.raw).toEqual({ setext: true });
    expect(markdownToDoc("T2\n---\n").firstChild!.attrs.raw).toEqual({ setext: true });
    expect(markdownToDoc("# ATX\n").firstChild!.attrs.raw).toBeNull();
  });

  it("reserialize 后 Setext 仍输出下划线式（不归一化成 ATX）", () => {
    // 下划线长度按新文字重算（G5-1 口径 max(3, len)）
    expect(docToMarkdown(reserialize(markdownToDoc("T1\n===\n")))).toBe("T1\n===\n");
    expect(docToMarkdown(reserialize(markdownToDoc("T2\n---\n")))).toBe("T2\n---\n");
  });

  it("编辑文字后仍输出 Setext，下划线长度按新文字重算 max(3, len)", () => {
    const doc = editText(markdownToDoc("T1\n===\n"), "Brand New Title");
    // 编辑过的块 blockSourceMap miss → 走规范序列化（无需 reserialize）
    const out = docToMarkdown(doc);
    expect(out).toBe(`Brand New Title\n${"=".repeat("Brand New Title".length)}\n`);
  });

  it("编辑后 H2 用 - 下划线，短标题下划线最短 3 字符", () => {
    const doc = editText(markdownToDoc("Old\n---\n"), "N");
    const out = docToMarkdown(doc);
    expect(out).toBe("N\n---\n");
  });

  it("新建标题（无 raw）仍输出 ATX", () => {
    const h = markdownToDoc("# seed\n").firstChild!;
    const fresh = h.type.create({ level: 2 }, h.type.schema.text("Fresh"));
    const out = docToMarkdown(markdownToDoc("# seed\n").copy(Fragment.fromArray([fresh])));
    expect(out).toBe("## Fresh\n");
  });

  it("Setext 标题改级到 3+ 回退 ATX（下划线式无法表达 H3）", () => {
    const h = markdownToDoc("T\n===\n").firstChild!;
    const h3 = h.type.create({ ...h.attrs, level: 3 }, h.type.schema.text("T"));
    const out = docToMarkdown(markdownToDoc("T\n===\n").copy(Fragment.fromArray([h3])));
    expect(out).toBe("### T\n");
  });

  it("未编辑 Setext 走 B6 原文切片：逐字节不变（回归锁）", () => {
    const md = "T1\n===========\n";
    expect(docToMarkdown(markdownToDoc(md))).toBe(md);
  });
});
