/**
 * v0.11.0 B4-7：TOC 目录自动更新。
 *
 * 缺陷背景（P1）：
 *   parser 解析时把标题列表序列化进 toc 节点 attrs，schema 的 toDOM 只渲染
 *   该**快照** → 阅读模式改标题后 `[toc]` 不更新；而分屏/导出走 markdown-it
 *   每次重扫（正确）→ 两种编辑模式行为不一致。
 *
 * 本测试聚焦纯逻辑部分（collectHeadings / buildTocUpdateTransaction），
 * 不依赖真实 EditorView（appendTransaction 的 debounce 走的是 view）。
 */
import { describe, it, expect } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { lightMDSchema } from "../core/schema";
import { markdownToDoc } from "../core/markdown/parser";
import {
  collectHeadings,
  buildTocUpdateTransaction,
  buildTocHeadingsAttr,
} from "../core/plugins/toc-update";
import { slugify } from "../core/markdown/heading-anchor";

const schema = lightMDSchema;

describe("v0.11.0 B4-7 TOC 自动更新", () => {
  it("扫描出文档全部标题（含层级）", () => {
    const doc = markdownToDoc("# A\n\n## B\n\n### C\n");
    const hs = collectHeadings(doc);
    expect(hs.map((h) => h.text)).toEqual(["A", "B", "C"]);
    expect(hs.map((h) => h.level)).toEqual([1, 2, 3]);
  });

  it("无标题文档返回空数组", () => {
    expect(collectHeadings(markdownToDoc("just text\n"))).toEqual([]);
  });

  it("重名标题 id 自动去重（v0.11.0 B4-5：与 heading-anchor 统一为 -1）", () => {
    // 缺陷背景（B4-5 发现）：本模块原先自带 slugify 副本且去重口径与
    // markdown-it 侧 heading-anchor 不一致 —— 那边首次重名加 `-1`，
    // 这边加 `-2` → 阅读模式 TOC 里第二个「Same」链接指向 #same-2，
    // 而正文渲染出的标题 id 是 #same-1 → **点击跳不过去**。
    // 现共用 heading-anchor 的 slugify 与 `-1` 口径。
    const doc = markdownToDoc("# Same\n\n# Same\n");
    const hs = collectHeadings(doc);
    expect(hs.length).toBe(2);
    expect(hs[0].id).toBe("same");
    expect(hs[1].id).toBe("same-1");
    // 与 markdown-it 侧口径一致
    expect(hs[1].id).toBe(slugify("Same") + "-1");
  });

  it("标题文本压缩空白（多行标题不产生换行 id）", () => {
    const doc = markdownToDoc("# Title   with   spaces\n");
    const hs = collectHeadings(doc);
    expect(hs[0].text).toBe("Title with spaces");
    expect(hs[0].id).toBe("title-with-spaces");
  });

  it("中文标题可正常生成 id", () => {
    const doc = markdownToDoc("# 中文标题\n");
    const hs = collectHeadings(doc);
    expect(hs[0].text).toBe("中文标题");
    expect(hs[0].id.length).toBeGreaterThan(0);
  });

  it("有 toc 节点且标题变化时产生更新事务", () => {
    const doc = markdownToDoc("[toc]\n\n# A\n\n## BB\n");
    const st = EditorState.create({ doc, schema });
    // 定位二级标题的**内容结束**位置：heading 节点 pos + 1（开标签）+
    // content.size（内容长度），此位置即最后一个字符之后
    let insertAt = -1;
    doc.descendants((node, pos) => {
      if (insertAt === -1 && node.type.name === "heading" && node.attrs.level === 2) {
        insertAt = pos + 1 + node.content.size;
      }
      return true;
    });
    expect(insertAt).toBeGreaterThan(0);
    const next = st.apply(st.tr.insertText("C", insertAt));
    expect(collectHeadings(next.doc)[1].text).toBe("BBC");
    const tr = buildTocUpdateTransaction(next, collectHeadings(next.doc));
    expect(tr).not.toBeNull();
    const applied = next.apply(tr!);
    let tocHeadings = "";
    applied.doc.descendants((node) => {
      if (node.type.name === "toc") tocHeadings = String(node.attrs.headings);
      return true;
    });
    expect(tocHeadings).toContain("BBC");
    expect(tocHeadings).not.toContain('"BB"');
  });

  it("标题未变化时不产生事务（避免无谓 dispatch）", () => {
    const doc = markdownToDoc("[toc]\n\n# A\n\n## B\n");
    const st = EditorState.create({ doc, schema });
    // 先更新一次让 attrs 与实际一致
    const first = buildTocUpdateTransaction(st, collectHeadings(st.doc));
    if (first) st.apply(first);
    const st2 = EditorState.create({ doc: st.doc, schema });
    expect(buildTocUpdateTransaction(st2, collectHeadings(st2.doc))).toBeNull();
  });

  it("无 toc 节点时返回 null（零开销短路）", () => {
    const doc = markdownToDoc("# A\n\n## B\n");
    const st = EditorState.create({ doc, schema });
    expect(buildTocUpdateTransaction(st, collectHeadings(doc))).toBeNull();
  });

  it("headings 为空时写入 []（不残留旧目录）", () => {
    const doc = markdownToDoc("[toc]\n\n# A\n");
    const st = EditorState.create({ doc, schema });
    const tr = buildTocUpdateTransaction(st, []);
    expect(tr).not.toBeNull();
    const applied = st.apply(tr!);
    let attr = "";
    applied.doc.descendants((node) => {
      if (node.type.name === "toc") attr = String(node.attrs.headings);
      return true;
    });
    expect(attr).toBe("[]");
  });

  it("buildTocHeadingsAttr 输出合法 JSON", () => {
    const json = buildTocHeadingsAttr([{ level: 1, text: "A", id: "a" }]);
    expect(JSON.parse(json)).toEqual([{ level: 1, text: "A", id: "a" }]);
  });

  it("多个 toc 节点全部更新（解析期 attrs 已正确则无需更新）", () => {
    const doc = markdownToDoc("[toc]\n\n# A\n\n[toc]\n\n## B\n");
    const st = EditorState.create({ doc, schema });
    // 解析期两个 toc 的 headings 都已被正确填充 → 与重算结果一致 → 无需事务
    // （这正是「无变化不 dispatch」策略的体现）
    expect(buildTocUpdateTransaction(st, collectHeadings(doc))).toBeNull();

    // 改标题后，两个 toc 都应被更新
    let target = -1;
    doc.descendants((node, pos) => {
      if (target === -1 && node.type.name === "text" && node.text === "B") target = pos + 1;
      return true;
    });
    const next = st.apply(st.tr.insertText("X", target));
    const tr = buildTocUpdateTransaction(next, collectHeadings(next.doc));
    expect(tr).not.toBeNull();
    const applied = next.apply(tr!);
    let count = 0;
    let allUpdated = true;
    applied.doc.descendants((node) => {
      if (node.type.name === "toc") {
        count++;
        if (!String(node.attrs.headings).includes("BX")) allUpdated = false;
      }
      return true;
    });
    expect(count).toBe(2);
    expect(allUpdated).toBe(true);
  });
});
