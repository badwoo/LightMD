/**
 * markdown-it → ProseMirror 解析器
 * 将 markdown-it token 流转换为 ProseMirror 文档节点
 */
import MarkdownIt from "markdown-it";
import { lightMDSchema } from "../schema";
import type { Node } from "prosemirror-model";
import { mathPlugin } from "./katex-plugin";
import { taskListPlugin } from "./task-list-plugin";

// Token 类型兼容 markdown-it
interface Token {
  type: string;
  tag: string;
  attrs: Array<[string, string]> | null;
  nesting: number;
  level: number;
  children: Token[] | null;
  content: string;
  markup: string;
  info: string;
  block: boolean;
  hidden: boolean;
  map: [number, number] | null;
  meta: Record<string, unknown> | null;
}

/** 从 token attrs 数组中获取属性值 */
function getAttr(token: Token, name: string): string | null {
  if (!token.attrs) return null;
  const found = token.attrs.find(([key]) => key === name);
  return found ? found[1] : null;
}

const schema = lightMDSchema;

// 配置 markdown-it
const md = new MarkdownIt("commonmark", {
  html: false,
  breaks: true,
  linkify: true,
  typographer: true,
});

md.enable(["table", "strikethrough"]);
md.use(mathPlugin);
md.use(taskListPlugin);

// ─── 公开 API ──────────────────────────────────────────────

export function markdownToDoc(markdown: string): Node {
  const rawTokens = md.parse(markdown, {});
  const tokens = rawTokens as unknown as Token[];
  const content = parseBlockTokens(tokens, 0, tokens.length);
  try {
    return schema.topNodeType.create(null, content);
  } catch (e) {
    // 如果创建文档失败（可能因为空文本节点等），尝试用空段落替代
    console.warn("[markdownToDoc] 创建文档失败，使用 fallback:", e);
    const fallbackContent = content.length > 0
      ? content
      : [schema.nodes.paragraph.create(null, schema.text("\u200B"))];
    return schema.topNodeType.create(null, fallbackContent);
  }
}

export function markdownToInline(markdown: string): Node[] {
  const rawTokens = md.parseInline(markdown, {});
  return parseInlineTokens(rawTokens as unknown as Token[]);
}

// ─── 块级 token 解析 ──────────────────────────────────────

function parseBlockTokens(tokens: Token[], start: number, end: number): Node[] {
  const nodes: Node[] = [];
  let i = start;

  while (i < end) {
    const token = tokens[i];
    const result = parseBlockToken(tokens, i, end);
    if (result) {
      nodes.push(result.node);
      i = result.nextIndex;
    } else {
      i++;
    }
  }
  return nodes;
}

interface ParseResult {
  node: Node;
  nextIndex: number;
}

function parseBlockToken(tokens: Token[], index: number, end: number): ParseResult | null {
  const token = tokens[index];
  if (!token) return null;

  switch (token.type) {
    case "heading_open": return parseHeading(tokens, index);
    case "paragraph_open": return parseParagraph(tokens, index);
    case "bullet_list_open": return parseList(tokens, index, "bullet_list");
    case "ordered_list_open": return parseList(tokens, index, "ordered_list");
    case "task_list_open": return parseTaskList(tokens, index);
    case "blockquote_open": return parseBlockquote(tokens, index);
    case "fence": return parseFence(tokens, index);
    case "math_block": return parseMathBlock(tokens, index);
    case "hr":
      return { node: schema.nodes.horizontal_rule.create(), nextIndex: index + 1 };
    case "table_open":
      return parseTable(tokens, index);
    default:
      return null;
  }
}

// ─── 标题 ────────────────────────────────────────────────

function parseHeading(tokens: Token[], index: number): ParseResult {
  const openToken = tokens[index];
  const level = parseInt(openToken.tag?.slice(1) || "1", 10);
  let content = "";

  for (let i = index + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "heading_close") {
      return {
        node: schema.nodes.heading.create({ level }, parseInline(content)),
        nextIndex: i + 1,
      };
    }
    if (t.type === "inline") content += t.content;
  }
  return {
    node: schema.nodes.heading.create({ level }, parseInline(content)),
    nextIndex: index + 3,
  };
}

// ─── 段落 ────────────────────────────────────────────────

function parseParagraph(tokens: Token[], index: number): ParseResult {
  let content = "";
  let i = index + 1;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "paragraph_close") break;
    if (t.type === "inline") content += t.content;
    if (t.type === "hardbreak") content += "\n";
  }
  return {
    node: schema.nodes.paragraph.create(null, parseInline(content)),
    nextIndex: i + 1,
  };
}

// ─── 列表 ────────────────────────────────────────────────

function parseList(tokens: Token[], index: number, listType: "bullet_list" | "ordered_list"): ParseResult {
  const openType = listType === "bullet_list" ? "bullet_list_open" : "ordered_list_open";
  const closeType = listType === "bullet_list" ? "bullet_list_close" : "ordered_list_close";
  const listNodeType = listType === "bullet_list" ? schema.nodes.bullet_list : schema.nodes.ordered_list;

  let depth = 0;
  const items: Node[] = [];
  let currentContent: string[] = [];
  let i = index;

  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === openType) { depth++; continue; }
    if (t.type === closeType) {
      depth--;
      if (depth === 0) break;
      continue;
    }
    if (depth === 1) {
      if (t.type === "list_item_open") {
        currentContent = [];
      } else if (t.type === "list_item_close") {
        const para = schema.nodes.paragraph.create(null, parseInline(currentContent.join("")));
        items.push(schema.nodes.list_item.create(null, [para]));
      } else if (t.type === "inline") {
        currentContent.push(t.content);
      }
    }
  }

  const attrs = listType === "ordered_list" ? { order: 1 } : {};
  return { node: listNodeType.create(attrs, items), nextIndex: i };
}

// ─── 任务列表 ──────────────────────────────────────────

function parseTaskList(tokens: Token[], index: number): ParseResult {
  const items: Node[] = [];
  let i = index + 1; // 跳过 task_list_open

  while (i < tokens.length) {
    const t = tokens[i];
    if (t.type === "task_list_close") {
      i++;
      break;
    }
    if (t.type === "task_item_open") {
      // 从 attrs 读取 checked 属性
      const checkedAttr = getAttr(t, "checked");
      const checked = checkedAttr === "true";
      let content = "";
      i++;
      // 收集 inline 内容
      while (i < tokens.length && tokens[i].type !== "task_item_close") {
        if (tokens[i].type === "inline") {
          content += tokens[i].content;
        }
        i++;
      }
      // 跳过 task_item_close
      if (i < tokens.length && tokens[i].type === "task_item_close") i++;

      const para = schema.nodes.paragraph.create(null, parseInline(content));
      items.push(schema.nodes.task_item.create({ checked }, [para]));
    } else {
      i++;
    }
  }

  return { node: schema.nodes.task_list.create(null, items), nextIndex: i };
}

// ─── 引用块 ──────────────────────────────────────────────

function parseBlockquote(tokens: Token[], index: number): ParseResult {
  let depth = 0;
  const innerTokens: Token[] = [];
  let i = index;

  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "blockquote_open") { depth++; if (depth === 1) continue; }
    if (t.type === "blockquote_close") { depth--; if (depth === 0) break; continue; }
    if (depth === 1) innerTokens.push(t);
  }

  const content = parseBlockTokens(innerTokens, 0, innerTokens.length);
  return { node: schema.nodes.blockquote.create(null, content), nextIndex: i + 1 };
}

// ─── 代码块 / Mermaid 图表块 ──────────────────────────────

function parseFence(tokens: Token[], index: number): ParseResult {
  const token = tokens[index];
  const language = token.info?.trim().split(/\s+/)[0] || "";
  // 代码块内容为空时用零宽空格占位（ProseMirror 不允许空文本节点）
  const textContent = token.content || "\u200B";

  // mermaid 语言使用专用的 mermaid_block 节点
  if (language === "mermaid") {
    return {
      node: schema.nodes.mermaid_block.create(
        { language: "mermaid" },
        [schema.text(textContent)]
      ),
      nextIndex: index + 1,
    };
  }

  return {
    node: schema.nodes.code_block.create(
      { language },
      [schema.text(textContent)]
    ),
    nextIndex: index + 1,
  };
}

// ─── 块级数学公式 ──────────────────────────────────────

function parseMathBlock(tokens: Token[], index: number): ParseResult {
  const token = tokens[index];
  const latex = token.content || "\u200B";
  return {
    node: schema.nodes.math_block.create(
      { latex },
      [schema.text(latex)]
    ),
    nextIndex: index + 1,
  };
}

// ─── 表格 ────────────────────────────────────────────────

function parseTable(tokens: Token[], index: number): ParseResult {
  let depth = 0;
  const headRows: Node[] = [];
  const bodyRows: Node[] = [];
  let isHead = false;
  let currentRowCells: Token[][] = [[]];
  let cellIdx = 0;
  const cellAligns: string[] = [];
  let hasSeenHead = false;

  let i = index;
  for (; i < tokens.length; i++) {
    const t = tokens[i];

    if (t.type === "table_open") { depth++; continue; }
    if (t.type === "table_close") { depth--; if (depth === 0) break; continue; }

    if (t.type === "thead_open") { isHead = true; hasSeenHead = true; continue; }
    if (t.type === "thead_close") {
      if (currentRowCells.length > 0 && currentRowCells.some(c => c.length > 0)) {
        headRows.push(buildTableRow(currentRowCells, cellAligns, true));
      }
      currentRowCells = [[]]; cellIdx = 0; isHead = false;
      continue;
    }
    if (t.type === "tbody_open") { isHead = false; continue; }
    if (t.type === "tbody_close") {
      if (currentRowCells.length > 0 && currentRowCells.some(c => c.length > 0)) {
        bodyRows.push(buildTableRow(currentRowCells, cellAligns, false));
      }
      currentRowCells = [[]]; cellIdx = 0;
      continue;
    }

    if (t.type === "tr_open") { currentRowCells = [[]]; cellIdx = 0; continue; }
    if (t.type === "tr_close") {
      const row = buildTableRow(currentRowCells, cellAligns, isHead && !hasSeenHead);
      // 第一行没有 thead 包裹时视为表头
      const effectiveIsHead = isHead || (!hasSeenHead && headRows.length === 0 && bodyRows.length === 0);
      if (effectiveIsHead) {
        headRows.push(buildTableRow(currentRowCells, cellAligns, true));
      } else {
        bodyRows.push(buildTableRow(currentRowCells, cellAligns, false));
      }
      currentRowCells = [[]]; cellIdx = 0;
      continue;
    }

    if (t.type === "th_open" || t.type === "td_open") {
      const styleVal = getAttr(t, "style") || "";
      const align = styleVal.replace("text-align:", "") || "left";
      cellAligns[cellIdx] = align;
      currentRowCells[cellIdx] = [];
      continue;
    }
    if (t.type === "th_close" || t.type === "td_close") { cellIdx++; continue; }
    if (t.type === "inline" && currentRowCells[cellIdx]) {
      currentRowCells[cellIdx].push(t);
    }
  }

  const tableChildren: Node[] = [];
  if (headRows.length > 0) {
    tableChildren.push(schema.nodes.table_head.create(null, headRows));
  }
  if (bodyRows.length > 0) {
    tableChildren.push(schema.nodes.table_body.create(null, bodyRows));
  }
  if (tableChildren.length === 0) {
    const emptyPara = schema.nodes.paragraph.create();
    const emptyCell = schema.nodes.table_cell.create({ align: "left" }, [emptyPara]);
    const emptyRow = schema.nodes.table_row.create(null, [emptyCell]);
    tableChildren.push(schema.nodes.table_body.create(null, [emptyRow]));
  }

  return { node: schema.nodes.table.create(null, tableChildren), nextIndex: i };
}

function buildTableRow(cells: Token[][], aligns: string[], isHeader: boolean): Node {
  const cellNodes: Node[] = [];
  for (let idx = 0; idx < cells.length; idx++) {
    const cellTokens = cells[idx];
    if (!cellTokens) continue;
    const align = aligns[idx] || "left";
    const text = cellTokens.map((t) => t.content).join("");
    const inlineNodes = parseInline(text);
    const cellType = isHeader ? schema.nodes.table_header : schema.nodes.table_cell;
    cellNodes.push(cellType.create({ align }, inlineNodes));
  }
  return schema.nodes.table_row.create(null, cellNodes);
}

// ─── Inline 解析 ─────────────────────────────────────────

function parseInline(text: string): Node[] {
  if (!text) return [];
  const rawTokens = md.parseInline(text, {});
  const allTokens = rawTokens as unknown as Token[];

  // md.parseInline wraps results in an "inline" token with children
  // Extract actual tokens from children
  const inlineToken = allTokens.find((t) => t.type === "inline");
  if (inlineToken?.children) {
    return parseInlineTokens(inlineToken.children).filter(n => {
      // 过滤掉空文本节点
      return !n.isText || (n.text && n.text.length > 0);
    });
  }
  return parseInlineTokens(allTokens).filter(n => {
    return !n.isText || (n.text && n.text.length > 0);
  });
}

function parseInlineTokens(tokens: Token[]): Node[] {
  const nodes: Node[] = [];
  let i = 0;

  while (i < tokens.length) {
    const t = tokens[i];

    if (t.type === "text") {
      // 跳过空文本节点（ProseMirror 不允许空文本节点）
      if (t.content) nodes.push(schema.text(t.content));
      i++; continue;
    }
    if (t.type === "hardbreak") { nodes.push(schema.nodes.hard_break.create()); i++; continue; }
    if (t.type === "softbreak") { nodes.push(schema.text(" ")); i++; continue; }
    if (t.type === "code_inline") {
      // code_inline 内容可能为空，用零宽空格占位
      nodes.push(schema.text(t.content || "\u200B", [schema.mark("code")]));
      i++; continue;
    }
    if (t.type === "math_inline") {
      // 行内数学公式
      const latex = t.content || "\u200B";
      nodes.push(schema.nodes.math_inline.create(
        { latex },
        [schema.text(latex)]
      ));
      i++; continue;
    }

    if (t.type.endsWith("_open")) {
      const markType = t.type.replace("_open", "");
      const closeType = t.type.replace("open", "close");
      const innerTokens: Token[] = [];
      let depth = 1;
      i++;
      while (i < tokens.length && depth > 0) {
        const inner = tokens[i];
        if (inner.type === t.type) depth++;
        if (inner.type === closeType) depth--;
        if (depth > 0) { innerTokens.push(inner); i++; }
      }
      i++;

      const innerNodes = parseInlineTokens(innerTokens);
      if (markType === "link") {
        const href = getAttr(t, "href") || "";
        const title = getAttr(t, "title") || "";
        nodes.push(...innerNodes.map((n) => n.mark([...n.marks, schema.mark("link", { href, title })])));
      } else if (markType === "strong") {
        nodes.push(...innerNodes.map((n) => n.mark([...n.marks, schema.mark("strong")])));
      } else if (markType === "em") {
        nodes.push(...innerNodes.map((n) => n.mark([...n.marks, schema.mark("em")])));
      } else if (markType === "s") {
        nodes.push(...innerNodes.map((n) => n.mark([...n.marks, schema.mark("strike")])));
      } else {
        nodes.push(...innerNodes);
      }
      continue;
    }

    if (t.type === "image") {
      nodes.push(schema.nodes.image.create({
        src: getAttr(t, "src") || "",
        alt: getAttr(t, "alt") || t.content || "",
        title: getAttr(t, "title") || "",
      }));
      i++;
      continue;
    }

    i++;
  }

  return nodes;
}

export { md };
