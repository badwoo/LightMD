// @vitest-environment jsdom
/**
 * v0.13.2 需求9：文档末尾永远有一个可放置光标的段落。
 *
 * ## 用户原话
 * 「从 a 文档复制一个表格到新建文档 b 中，我想在 b 文档表格后面继续编辑内容，
 *  但没法将编辑符移到表格下面…点击文档空白处，那么就应该有插入符号，但现在没有，
 *  请同样测试下看有没有类似受限的编辑场景，找出来一并解决。」
 *
 * ## 实现口径（本文件锁定的行为）
 * - `withTrailingParagraph` / `trailingParagraphPlugin` 在文档以
 *   table / code_block / mermaid_block / math_block 结尾时补一个 `pad:true` 的空段落；
 * - 该段落是**结构补位**，`docToMarkdown` 必须跳过它（不写进文件）；
 * - 但**用户自己打的尾随空段落仍然必须序列化**（v0.7.0-fix2 的既有约束，不能收窄）；
 * - 用户在 pad 段落里输入内容后，`appendTransaction` 清掉 `pad` 标记
 *   （否则这段内容会在保存时被静默丢弃）。
 *
 * ## jsdom 限制
 * 真实"点击表格下方空白处"依赖坐标测量（`posAtCoords` / `elementFromPoint`），
 * jsdom 没有布局，无法复现真实点击。这里改为测**模型层等价行为**：
 * 文档末尾存在可放置光标的文本块、`Selection.near(doc.resolve(doc.content.size))`
 * 与 `TextSelection.create(doc, doc.content.size - 1)` 都能解析到表格之后的合法位置；
 * 对照组（没有 pad 段落）则解析进表格最后一个单元格 —— 正是用户报告的现象。
 */
import { describe, it, expect, afterEach } from "vitest";
import { EditorState, Selection, TextSelection } from "prosemirror-state";
import { history, undoDepth } from "prosemirror-history";
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { lightMDSchema as schema } from "../core/schema";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import { createEditor } from "../core/editor";
import {
  isPadParagraph,
  needsTrailingParagraph,
  trailingParagraphPlugin,
  withTrailingParagraph,
} from "../core/plugins/trailing-paragraph";

// ─────────────────────────── 辅助 ───────────────────────────

function para(text?: string, attrs?: Record<string, unknown>): PMNode {
  return schema.nodes.paragraph.create(
    attrs ?? null,
    text ? schema.text(text) : undefined,
  );
}

/** 程序化表格（故意**不**带解析期原文记录，确保走 serializer 的逐块路径） */
function tableNode(): PMNode {
  const headRow = schema.nodes.table_row.create(null, [
    schema.nodes.table_header.create(null, schema.text("H1")),
    schema.nodes.table_header.create(null, schema.text("H2")),
  ]);
  const bodyRow = schema.nodes.table_row.create(null, [
    schema.nodes.table_cell.create(null, schema.text("1")),
    schema.nodes.table_cell.create(null, schema.text("2")),
  ]);
  return schema.nodes.table.create(null, [
    schema.nodes.table_head.create(null, headRow),
    schema.nodes.table_body.create(null, bodyRow),
  ]);
}

/** 四类"尾部缺落点"的块节点 */
const BLOCK_FACTORY: Record<string, () => PMNode> = {
  table: tableNode,
  code_block: () => schema.nodes.code_block.create({ language: "js" }, schema.text("x = 1")),
  mermaid_block: () => schema.nodes.mermaid_block.create(null, schema.text("graph TD\nA-->B")),
  math_block: () => schema.nodes.math_block.create(null, schema.text("x^2 + y^2")),
};

function docOf(...nodes: PMNode[]): PMNode {
  return schema.topNodeType.create(null, nodes);
}

/** 每种块结尾的初始 markdown（用于 createEditor 集成测） */
const BLOCK_MARKDOWN: Record<string, string> = {
  table: "| A | B |\n| --- | --- |\n| 1 | 2 |\n",
  code_block: "```js\nconst x = 1;\n```\n",
  mermaid_block: "```mermaid\ngraph TD\nA-->B\n```\n",
  math_block: "$$\nx^2 + y^2\n$$\n",
};

function mount(content: string): { view: EditorView; host: HTMLElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = createEditor({ parent: host, initialContent: content })!;
  return { view, host };
}

afterEach(() => {
  document.body.innerHTML = "";
});

// ═══════════════════ 纯函数：补位判定 ═══════════════════

describe("需求9：needsTrailingParagraph / withTrailingParagraph", () => {
  it.each(Object.keys(BLOCK_FACTORY))(
    "以 %s 结尾的文档：需要补位，补出的是带 pad 标记的空段落",
    (name) => {
      const doc = docOf(BLOCK_FACTORY[name]());
      expect(needsTrailingParagraph(doc)).toBe(true);

      const out = withTrailingParagraph(doc);
      expect(out.childCount).toBe(doc.childCount + 1);
      expect(isPadParagraph(out.lastChild!)).toBe(true);
      expect(out.lastChild!.content.size).toBe(0);
      // 原来的块结构原样保留
      expect(out.firstChild!.type.name).toBe(name);
    },
  );

  it("以普通段落结尾的文档不需要补位（返回原 doc，零改动）", () => {
    const doc = docOf(para("普通内容"));
    expect(needsTrailingParagraph(doc)).toBe(false);
    expect(withTrailingParagraph(doc)).toBe(doc);
  });

  it("horizontal_rule 结尾**不补**段落（原子叶块天然有前后位置，补了会多空行）", () => {
    const doc = docOf(para("before"), schema.nodes.horizontal_rule.create());
    expect(needsTrailingParagraph(doc)).toBe(false);
    expect(withTrailingParagraph(doc)).toBe(doc);
  });

  it("已经补过位的文档再次调用是 no-op（幂等）", () => {
    const once = withTrailingParagraph(docOf(tableNode()));
    const twice = withTrailingParagraph(once);
    expect(twice).toBe(once);
    expect(twice.childCount).toBe(2);
  });

  it("isPadParagraph 只认「paragraph + pad:true」", () => {
    expect(isPadParagraph(para("", { pad: true }))).toBe(true);
    expect(isPadParagraph(para(""))).toBe(false); // 用户自己的空段落不是补位段落
    expect(isPadParagraph(para("x", { pad: false }))).toBe(false);
    // 非段落节点即便带了同名属性也不算
    expect(isPadParagraph(schema.nodes.code_block.create({ pad: true }))).toBe(false);
  });
});

// ═══════════════════ 序列化：pad 不写文件，但用户空段落必须写 ═══════════════════

describe("需求9：pad 段落与 Markdown 序列化", () => {
  it.each(Object.keys(BLOCK_FACTORY))(
    "以 %s 结尾：补位前后序列化结果**完全一致**（pad 不写进 Markdown）",
    (name) => {
      const doc = docOf(BLOCK_FACTORY[name]());
      const before = docToMarkdown(doc);
      const after = docToMarkdown(withTrailingParagraph(doc));
      expect(after).toBe(before);
      // 空白文档/空字符串会让"相等"失去意义，这里确认基线确有内容
      expect(before.length).toBeGreaterThan(0);
    },
  );

  it("表格 + pad：输出只有表格本身，末尾**不**多出空行", () => {
    const plain = docOf(tableNode());
    const padded = withTrailingParagraph(plain);
    const md = docToMarkdown(padded);
    expect(md).toContain("| H1 | H2 |");
    expect(md.endsWith("\n")).toBe(true);
    // 表格 canonical 输出以单个 \n 结尾；pad 若被写出会变成 "\n\n"
    expect(md.endsWith("\n\n")).toBe(false);
    expect(md).toBe(docToMarkdown(plain));
  });

  it("**用户自己打的**尾随空段落仍然必须序列化（v0.7.0-fix2 回归锁）", () => {
    const tableOnly = docOf(tableNode());
    const withUserEmptyParagraph = docOf(tableNode(), para()); // 注意：非 pad
    const md = docToMarkdown(withUserEmptyParagraph);
    // 表格 + 一个用户空段落 = 表格输出 + 一个额外换行
    expect(md).toBe(docToMarkdown(tableOnly) + "\n");
    expect(md.endsWith("\n\n")).toBe(true);

    // 往返一致：解析回来仍是「表格 + 1 个空段落」
    const restored = markdownToDoc(md);
    let emptyParagraphs = 0;
    restored.forEach((n) => {
      if (n.type.name === "paragraph" && n.content.size === 0) emptyParagraphs++;
    });
    expect(emptyParagraphs).toBe(1);
  });

  it("同一个 doc 里 pad 与用户空段落并存：只跳过 pad，用户那一个照常输出", () => {
    const doc = docOf(tableNode(), para("", { pad: true }), para());
    const md = docToMarkdown(doc);
    // 只有表格 + 一个用户空段落（pad 被跳过）
    expect(md).toBe(docToMarkdown(docOf(tableNode())) + "\n");
  });
});

// ═══════════════════ 插件：appendTransaction ═══════════════════

describe("需求9：trailingParagraphPlugin 的 appendTransaction", () => {
  it("文档被改成以表格结尾时，自动补一个 pad 段落", () => {
    const state = EditorState.create({
      doc: docOf(para("intro")),
      plugins: [trailingParagraphPlugin()],
    });
    const tr = state.tr.replaceWith(0, state.doc.content.size, docOf(tableNode()).content);
    const next = state.apply(tr);

    expect(next.doc.childCount).toBe(2);
    expect(next.doc.firstChild!.type.name).toBe("table");
    expect(isPadParagraph(next.doc.lastChild!)).toBe(true);
  });

  it("纯选区事务（doc 未变）不触发补位，doc 引用保持不变", () => {
    const start = EditorState.create({
      doc: withTrailingParagraph(docOf(tableNode())),
      plugins: [trailingParagraphPlugin()],
    });
    const next = start.apply(start.tr.setSelection(Selection.atStart(start.doc)));
    expect(next.doc).toBe(start.doc);
  });

  it("补位事务不进撤销历史（addToHistory:false）", () => {
    const state = EditorState.create({
      doc: docOf(para("intro")),
      plugins: [history(), trailingParagraphPlugin()],
    });
    const tr = state.tr.replaceWith(0, state.doc.content.size, docOf(tableNode()).content);
    // 用户这次"换成表格"的操作用 addToHistory:false 模拟（等价于换文档/整篇重解析），
    // 于是唯一可能进历史的就是补位事务 —— 它必须被排除。
    tr.setMeta("addToHistory", false);
    const next = state.apply(tr);

    expect(isPadParagraph(next.doc.lastChild!)).toBe(true);
    expect(undoDepth(next)).toBe(0);
  });

  it("用户在 pad 段落里输入内容后，pad 标记被清掉（内容不得被保存逻辑丢弃）", () => {
    const { view, host } = mount(BLOCK_MARKDOWN.table);
    try {
      expect(isPadParagraph(view.state.doc.lastChild!)).toBe(true);

      // 在 pad 段落内输入（位置 = 文档末尾的前一个位置，即空段落内部）
      const pos = view.state.doc.content.size - 1;
      view.dispatch(view.state.tr.insertText("继续编辑", pos));

      const last = view.state.doc.lastChild!;
      expect(last.type.name).toBe("paragraph");
      expect(last.attrs.pad).not.toBe(true);
      expect(last.textContent).toContain("继续编辑");
      // 序列化必须包含这段用户内容
      expect(docToMarkdown(view.state.doc)).toContain("继续编辑");
    } finally {
      view.destroy();
      host.remove();
    }
  });
});

// ═══════════════════ 真实编辑器：初始文档与落点 ═══════════════════

describe("需求9：createEditor 集成（真实 NodeView 流水线）", () => {
  it.each(Object.keys(BLOCK_MARKDOWN))(
    "打开以 %s 结尾的文档：末尾已有 pad 段落，且序列化零改动",
    (name) => {
      const source = BLOCK_MARKDOWN[name];
      const { view, host } = mount(source);
      try {
        expect(isPadParagraph(view.state.doc.lastChild!)).toBe(true);
        // 补位段落不进 Markdown：打开再保存必须原样
        expect(docToMarkdown(view.state.doc)).toBe(source);
      } finally {
        view.destroy();
        host.remove();
      }
    },
  );

  it("表格后存在可放置光标的文本块：Selection.near / TextSelection.create 都能解析到 pad 内", () => {
    const { view, host } = mount(BLOCK_MARKDOWN.table);
    try {
      const doc = view.state.doc;
      const last = doc.lastChild!;
      expect(last.type.name).toBe("paragraph");
      expect(last.attrs.pad).toBe(true);

      // ① Selection.near(文档末尾) → 落在最后一个文本块（pad 段落）内
      const near = Selection.near(doc.resolve(doc.content.size));
      expect(near).toBeInstanceOf(TextSelection);
      expect(near.$from.parent.type.name).toBe("paragraph");
      expect(near.$from.parent.attrs.pad).toBe(true);

      // ② 文档末尾前一个位置 = pad 空段落内部，可建合法 TextSelection
      const pos = doc.content.size - 1;
      const sel = TextSelection.create(doc, pos);
      expect(sel.$from.parent.attrs.pad).toBe(true);
      expect(sel.from).toBe(pos);
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("对照组（没有 pad 段落）：文档末尾解析进表格最后一个单元格——正是用户报告的现象", () => {
    // 不经 createEditor（它会补 pad），直接用解析后的表格 doc 演示模型层现象
    const doc = markdownToDoc(BLOCK_MARKDOWN.table);
    expect(doc.lastChild!.type.name).toBe("table");
    const near = Selection.near(doc.resolve(doc.content.size));
    // 表格是 isolating 的：doc 末尾附近能落光标的只有单元格内容
    expect(["table_cell", "table_header"]).toContain(near.$from.parent.type.name);
    // 而补位后同一位置落到了段落里（上一条测试），说明补位解决了"表格后无落点"
  });
});
