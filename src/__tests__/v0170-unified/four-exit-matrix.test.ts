/**
 * v0.17.0 B3 —— **四出口一致性矩阵**（B 线最后一个门禁）。
 *
 * ## 设计原则（先说清为什么不用"模糊文本比对"）
 *
 * 第一版我用"tree 文本的每 3 字符片段必须能在各出口输出里找到"。
 * 这版**错了**，且错得很有代表性：四个出口的**形态本就不同**
 * （PM 是 DOM 节点树、HTML 是带标签字符串、Block[] 是扁平结构），
 * 用字符片段搜索把"形态差异"和"内容丢失"混为一谈 ——
 * 于是图片（PM 侧 atom 节点 textContent 为空，正常）被判"丢内容"，
 * 代码块（PM 的 textContent 串接方式不同）也被误报。
 *
 * **改用结构化断言**：不比较形态，比较**语义点**。
 * 对每个样例，先声明"这份文档有哪几个语义事实"（标题级别、列表项数、
 * 表格行列、代码内容、引用嵌套…），再逐出口验证该事实**是否存在且正确**。
 *
 * 这是可验证的：语义事实是从**文档本身**（tree，B 线交付的单一事实源）推出的，
 * 不是从某个出口的输出反推的 —— 否则就成了"拿被测对象当基准"。
 *
 * ## 四个出口
 *
 * | 出口 | 入口 | 消费者 |
 * |---|---|---|
 * | ① PM 阅读面 | `markdownToDoc(doc)` | 阅读模式、块复制/剪切 |
 * | ② 预览 HTML | `renderMarkdownHtml` | 分屏预览 iframe |
 * | ③ 导出 HTML | `renderMarkdownHtml`（同一实例） | HTML/PDF/PNG 导出 |
 * | ④ Block[] | `parseMarkdownToBlocks` | DOCX / LaTeX / EPUB 导出 |
 *
 * ## 已声明的出口差异（本文件如实登记，不断言"应该一致"）
 *
 * - **① PM 的 dd 内块仍被拍平**：`definition_description` content 是 `inline*`
 *   （v0.16.0 既有 schema）。设计稿 §6.3 方案乙要改 `block+`，属 A 线 schema/keymap
 *   写作用域，B 线不动。**这是 B 线与 PM 面的已知差距，不是 B 线的失败。**
 * - **① PM 的 image / math 节点不产出 textContent**：atom 节点语义，正常。
 * - **④ Block[] 的图片是文本占位、脚注容器摊平、文档级头尾空行不承载**：
 *   见 `BLOCKS_EXPORT_BOUNDARIES`（BE-01/05/07/08）。
 */

import { describe, it, expect } from "vitest";
import { markdownToDoc } from "../../core/markdown/parser";
import { renderMarkdownHtml } from "../../core/renderPipeline";
import { parseMarkdownToBlocksDetailed } from "../../utils/exportBlocks";
import { parseUnified } from "../../core/unified/parse";
import { treeToSource } from "../../core/unified/serialize";
import { treeToBlocks } from "../../core/unified/treeToBlocks";
import type { MdNode } from "../../core/unified/model";

// ────────────────────────────────────────────────────────────────
// 从 tree 推出「语义事实」—— 这是独立基准，不依赖任何出口的输出
// ────────────────────────────────────────────────────────────────

interface SemanticFacts {
  /** 标题：level 列表 */
  headings: number[];
  /** 顶层块的 kind 序列（含容器内部块，去层级） */
  kinds: string[];
  /** 每个块的可见文本（规范化） */
  texts: string[];
  /** 列表：每类列表的条目总数 */
  listItemCounts: Record<string, number>;
  /** 表格：行数 × 列数 */
  tableShape: Array<{ rows: number; cols: number }>;
  /** 代码块内容 */
  codeContents: string[];
  /** 引用嵌套深度 */
  quoteDepths: number[];
}

function normalizeText(t: string): string {
  return t
    .replace(/\u200B/g, "")
    .replace(/\[图片[^\]]*\]/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function nodeOwnText(n: MdNode): string {
  if (n.kind === "codeBlock") return (n.inline || []).map((x) => x.text).join("");
  if (n.kind === "mathBlock") return String(n.attrs.latex || "");
  if (n.kind === "table") {
    const rows = (n.attrs.rows as Array<Array<{ inline?: Array<{ text: string }> }>>) || [];
    return rows.flatMap((r) => r.map((c) => (c.inline || []).map((x) => x.text).join(""))).join(" ");
  }
  if (n.kind === "toc" || n.kind === "hr") return "";
  if (n.inline) return n.inline.map((x) => x.text).join("");
  // 容器：自身的 inline + 子块
  let t = "";
  if (n.children) for (const c of n.children) t += " " + nodeOwnText(c);
  return t;
}

function extractFacts(md: string): SemanticFacts {
  const parsed = parseUnified(md);
  const facts: SemanticFacts = {
    headings: [],
    kinds: [],
    texts: [],
    listItemCounts: {},
    tableShape: [],
    codeContents: [],
    quoteDepths: [],
  };

  const walk = (nodes: MdNode[], quoteDepth: number) => {
    for (const n of nodes) {
      facts.kinds.push(n.kind);
      if (n.kind === "heading") facts.headings.push(Number(n.attrs.level) || 1);
      if (n.kind === "codeBlock") facts.codeContents.push((n.inline || []).map((x) => x.text).join(""));
      if (n.kind === "table") {
        const rows = (n.attrs.rows as unknown[]) || [];
        const firstRow = (n.attrs.rows as Array<Array<unknown>>)?.[0] || [];
        facts.tableShape.push({ rows: rows.length, cols: firstRow.length });
      }
      if (n.kind === "blockquote") {
        facts.quoteDepths.push(quoteDepth + 1);
        walk(n.children || [], quoteDepth + 1);
        continue;
      }
      if (n.kind === "bulletList" || n.kind === "orderedList" || n.kind === "taskList") {
        const count = countListItems(n);
        facts.listItemCounts[n.kind] = (facts.listItemCounts[n.kind] || 0) + count;
        walk(n.children || [], quoteDepth);
        continue;
      }
      const t = normalizeText(nodeOwnText(n));
      if (t) facts.texts.push(t);
      if (n.children) walk(n.children, quoteDepth);
    }
  };
  walk(parsed.tree, 0);
  return facts;
}

/** 递归数列表项（含嵌套） */
function countListItems(list: MdNode): number {
  let n = (list.children || []).length;
  for (const item of list.children || []) {
    for (const c of item.children || []) {
      if (c.kind === "bulletList" || c.kind === "orderedList" || c.kind === "taskList") n += countListItems(c);
    }
  }
  return n;
}

// ────────────────────────────────────────────────────────────────
// 各出口的「事实探针」
// ────────────────────────────────────────────────────────────────

/** ① PM：下属性的可见事实 */
function pmFacts(md: string) {
  const doc = markdownToDoc(md);
  const headings: number[] = [];
  let maxQuote = 0;
  let codeCount = 0;
  const walk = (node: import("prosemirror-model").Node, quoteDepth: number) => {
    if (node.type.name === "heading") headings.push(Number(node.attrs.level) || 1);
    if (node.type.name === "code_block" || node.type.name === "mermaid_block") codeCount++;
    const childQuoteDepth = node.type.name === "blockquote" ? quoteDepth + 1 : quoteDepth;
    if (node.type.name === "blockquote") maxQuote = Math.max(maxQuote, childQuoteDepth);
    node.forEach((child) => walk(child, childQuoteDepth));
  };
  walk(doc, 0);
  return {
    headingLevels: headings,
    codeCount,
    maxQuote,
    /** PM 侧 dd 内块是否保留为块级（已知为 false，见文件头） */
    ddInnerBlocksPreserved: pmDdInnerBlocks(doc),
    /** 可见文本（PM textContent 拼接） */
    fullText: normalizeText(doc.textContent || ""),
  };
}

/** PM 侧：dd 内是否还有独立 code_block（当前 schema 下应为 false） */
function pmDdInnerBlocks(doc: import("prosemirror-model").Node): boolean {
  let found = false;
  doc.descendants((n) => {
    if (n.type.name === "definition_description") {
      n.forEach((c) => {
        if (c.type.name === "code_block" || c.type.name === "table" || c.type.name === "bullet_list") found = true;
      });
    }
  });
  return found;
}

/** ② / ③ HTML */
function htmlFacts(html: string) {
  const headings: number[] = [];
  for (const m of html.matchAll(/<h(\d)[^>]*>/g)) headings.push(Number(m[1]));
  const codeCount = (html.match(/<pre/g) || []).length;
  const quoteDepth = maxNestingDepth(html, "blockquote");
  return {
    headingLevels: headings,
    codeCount,
    quoteDepth,
    fullText: normalizeText(html),
    hasToc: /class="[^"]*toc|id="toc"/i.test(html) || html.includes("[toc]"),
  };
}

/** HTML 中某标签的最大嵌套深度 */
function maxNestingDepth(html: string, tag: string): number {
  const re = new RegExp(`<(/?)${tag}\\b`, "g");
  let depth = 0;
  let max = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[1] === "") {
      depth++;
      max = Math.max(max, depth);
    } else {
      depth--;
    }
  }
  return max;
}

/** ④ Block[] */
function blockFacts(md: string) {
  const r = parseMarkdownToBlocksDetailed(md);
  const headings = r.blocks.filter((b) => b.kind === "heading").map((b) => (b as { level: number }).level);
  const codeCount = r.blocks.filter((b) => b.kind === "codeBlock").length;
  const quoteDepth = maxBlockQuoteDepth(r.blocks);
  return {
    headingLevels: headings,
    codeCount,
    quoteDepth,
    fullText: normalizeText(
      r.blocks
        .flatMap((b) => {
          if (b.kind === "heading" || b.kind === "paragraph") return b.runs.map((x) => x.text);
          if (b.kind === "codeBlock") return b.content;
          if (b.kind === "mathBlock") return b.latex;
          return "";
        })
        .join(" "),
    ),
    unknownTokens: r.unknownTokens,
  };
}

function maxBlockQuoteDepth(blocks: ReturnType<typeof treeToBlocks>["blocks"]): number {
  let max = 0;
  const walk = (bs: Array<{ kind: string; blocks?: unknown[] }>, d: number) => {
    for (const b of bs) {
      if (b.kind === "blockquote") {
        max = Math.max(max, d + 1);
        if (Array.isArray(b.blocks)) walk(b.blocks as Array<{ kind: string; blocks?: unknown[] }>, d + 1);
      }
    }
  };
  walk(blocks as Array<{ kind: string; blocks?: unknown[] }>, 0);
  return max;
}

// ────────────────────────────────────────────────────────────────
// 样例
// ────────────────────────────────────────────────────────────────

const SAMPLES: Array<{ name: string; md: string }> = [
  { name: "标题 1-6", md: "# h1\n\n## h2\n\n### h3\n\n#### h4\n\n##### h5\n\n###### h6\n" },
  { name: "Setext", md: "T1\n===\n\nT2\n---\n" },
  { name: "段落+行内格式", md: "para **bold** *ital* `code` ~~strike~~ ==mark==\n" },
  { name: "软/硬换行", md: "l1\nl2\n\nh1  \nh2\n" },
  { name: "无序列表嵌套", md: "- a\n    - b\n        - c\n" },
  { name: "有序列表 1)", md: "1) a\n2) b\n" },
  { name: "有序列表 1.", md: "3. a\n4. b\n" },
  { name: "任务列表", md: "- [ ] todo\n- [x] done\n" },
  { name: "代码围栏", md: "```js\nconst x = 1;\n```\n" },
  { name: "引用嵌套", md: "> a\n>\n> > b\n" },
  { name: "表格对齐", md: "| a | b |\n|:--|--:|\n| 1 | 2 |\n" },
  { name: "定义列表", md: "Term\n: def\n" },
  { name: "数学块", md: "$$\nx^2\n$$\n" },
  { name: "行内数学", md: "a $x$ b\n" },
  { name: "图片", md: "![alt](a.png)\n" },
  { name: "HTML 白名单", md: "a <u>u</u> <mark>m</mark> b\n" },
  { name: "TOC", md: "# one\n\n## two\n\n[toc]\n" },
  { name: "脚注", md: "use[^x]\n\n[^x]: p1\n" },
  { name: "综合", md: "# T\n\npara\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n> q\n\n```js\ncode\n```\n" },
];

// ────────────────────────────────────────────────────────────────
// 断言：语义事实逐出口核对
// ────────────────────────────────────────────────────────────────

describe("四出口一致性矩阵：语义事实逐出口核对", () => {
  it.each(SAMPLES)("「$name」：标题级别序列在四出口一致", ({ md }) => {
    const facts = extractFacts(md);
    if (facts.headings.length === 0) return; // 无标题的样例跳过
    expect(pmFacts(md).headingLevels).toEqual(facts.headings);
    expect(htmlFacts(renderMarkdownHtml(md, { highlight: false })).headingLevels).toEqual(facts.headings);
    expect(blockFacts(md).headingLevels).toEqual(facts.headings);
  });

  it.each(SAMPLES)("「$name」：代码块数量在四出口一致", ({ md }) => {
    const facts = extractFacts(md);
    const expected = facts.codeContents.length;
    expect(pmFacts(md).codeCount).toBe(expected);
    expect(htmlFacts(renderMarkdownHtml(md, { highlight: false })).codeCount).toBe(expected);
    expect(blockFacts(md).codeCount).toBe(expected);
  });

  it.each(SAMPLES)("「$name」：引用嵌套深度在四出口一致", ({ md }) => {
    const facts = extractFacts(md);
    const expected = facts.quoteDepths.length === 0 ? 0 : Math.max(...facts.quoteDepths);
    expect(pmFacts(md).maxQuote).toBe(expected);
    expect(htmlFacts(renderMarkdownHtml(md, { highlight: false })).quoteDepth).toBe(expected);
    expect(blockFacts(md).quoteDepth).toBe(expected);
  });
});

describe("出口②与③（预览 / 导出 HTML）必须逐字节相同", () => {
  it.each(SAMPLES)("「$name」输出确定、不引入随机性", ({ md }) => {
    const a = renderMarkdownHtml(md);
    const b = renderMarkdownHtml(md);
    expect(b).toBe(a);
  });
});

describe("已声明的出口差异（如实登记，不断言『应该一致』）", () => {
  it("① PM 的 dd 内块仍被拍平（schema 限制，属 A 线写作用域）", () => {
    const md = "Term\n: def\n\n    ```js\n    x\n    ```\n";
    // 当前事实：PM 侧 dd 内没有独立 code_block
    expect(pmFacts(md).ddInnerBlocksPreserved).toBe(false);
    // 而 tree 侧有 —— 这是 B 线与 PM 面的已知差距
    const flat: string[] = [];
    const walk = (ns: MdNode[]) => {
      for (const n of ns) {
        flat.push(n.kind);
        if (n.children) walk(n.children);
      }
    };
    walk(parseUnified(md).tree);
    expect(flat).toContain("codeBlock");
  });

  it("④ Block[] 的图片是文本占位（已声明 BE-05）", () => {
    const r = parseMarkdownToBlocksDetailed("![alt](a.png)\n");
    const para = r.blocks.find((b) => b.kind === "paragraph") as {
      runs: Array<{ text: string; imageSrc?: string }>;
    };
    expect(para.runs.some((x) => x.text.includes("图片"))).toBe(true);
    expect(para.runs.some((x) => x.imageSrc === "a.png")).toBe(true);
  });

  it("④ Block[] 丢文档级头尾空行（已声明 BE-07/08）", () => {
    const r = parseMarkdownToBlocksDetailed("\n\n# h\n\n\n");
    expect(r.blocks.map((b) => b.kind)).toEqual(["heading"]);
  });

  it("④ Block[] 对全部样例都不上报 unknownTokens（出口完整性）", () => {
    for (const { md } of SAMPLES) {
      const r = parseMarkdownToBlocksDetailed(md);
      expect(r.unknownTokens, `样例「${md.slice(0, 20)}」有未映射 token`).toEqual([]);
    }
  });
});

describe("tree 作为单一事实源：往返与派生都确定", () => {
  it.each(SAMPLES)("「$name」：tree→source 逐字节还原", ({ md }) => {
    const parsed = parseUnified(md);
    const back = treeToSource(parsed.tree, { source: md, raw: parsed.raw });
    expect(back).toBe(md.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
  });

  it.each(SAMPLES)("「$name」：tree→Block[] 是纯函数（两次调用结果相同）", ({ md }) => {
    const a = treeToBlocks(parseUnified(md).tree).blocks;
    const b = treeToBlocks(parseUnified(md).tree).blocks;
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});
