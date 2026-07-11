/**
 * G12 导出 Word（.docx）工具
 *
 * 设计原则：
 * - 纯函数优先：将 markdown → 中间结构 Block[] → docx 元素，两个阶段都可单测
 * - 不引入 pandoc：纯前端 docx 库实现
 * - 动态 import docx 库（约 200KB），避免首屏体积
 *
 * 支持的 markdown 元素：
 * - heading h1-h6 → HeadingLevel.HEADING_1 ~ HEADING_6
 * - paragraph → Paragraph + TextRun
 * - bullet_list / ordered_list → Paragraph with bullet/number
 * - code_block (fence) → Paragraph with monospace font + shading
 * - table → Table with header row + body rows
 * - blockquote → Paragraph with left indent
 * - hr → Paragraph with bottom border
 * - 行内格式：bold/italic/strike/code/link
 *
 * 不支持的元素（简化处理）：
 * - mermaid 图表 → 转为代码块
 * - 数学公式 → 转为纯文本（latex 源码）
 * - 任务列表 → 转为普通列表项前缀 [✓]/[ ]
 * - 脚注 → 转为行内文本
 */

import MarkdownIt from "markdown-it";
import markPlugin from "markdown-it-mark";
import subPlugin from "markdown-it-sub";
import supPlugin from "markdown-it-sup";
import { full as emojiPlugin } from "markdown-it-emoji";
import footnotePlugin from "markdown-it-footnote";
import deflistPlugin from "markdown-it-deflist";
import { mathPlugin } from "../core/markdown/katex-plugin";
import { taskListPlugin } from "../core/markdown/task-list-plugin";
import { headingAnchorPlugin } from "../core/markdown/heading-anchor";
import { tocPlugin } from "../core/markdown/toc-plugin";
import { notifyError, notifySuccess } from "../services/notificationService";
import { t } from "../i18n";

/** 从文件路径推导默认保存目录（用于 Tauri save 对话框的 defaultPath） */
function getDefaultDir(filePath: string | null | undefined): string | undefined {
  if (!filePath) return undefined;
  const idx = filePath.replace(/\\/g, "/").lastIndexOf("/");
  return idx > 0 ? filePath.substring(0, idx) : undefined;
}

// Token 类型兼容 markdown-it（与 parser.ts 保持一致，避免引入 markdown-it/lib/token 类型声明）
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

// ─── 中间结构（便于测试）──────────────────────────────

/** 行内片段：保留格式信息 */
export interface InlineRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  /** 链接 URL（简化：仅保留 href，不渲染为超链接） */
  href?: string;
}

/** 列表项 */
export interface ListItem {
  runs: InlineRun[];
  /** 嵌套子列表 */
  children?: ListItem[];
}

/** 块级元素中间结构 */
export type Block =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; runs: InlineRun[] }
  | { kind: "paragraph"; runs: InlineRun[] }
  | { kind: "bulletList"; items: ListItem[] }
  | { kind: "orderedList"; items: ListItem[]; start: number }
  | { kind: "codeBlock"; content: string; language: string }
  | { kind: "table"; header: InlineRun[][][]; rows: InlineRun[][][] }
  | { kind: "blockquote"; blocks: Block[] }
  | { kind: "hr" }
  | { kind: "mathBlock"; latex: string };

// ─── markdown-it token → Block[] 转换 ──────────────────────

/** 从 token.attrs 数组中获取属性值 */
function getTokenAttr(token: Token, name: string): string | null {
  if (!token.attrs) return null;
  const found = token.attrs.find(([key]: [string, string]) => key === name);
  return found ? found[1] : null;
}

/**
 * 将 inline token 数组转换为 InlineRun[]
 *
 * 处理的 token 类型：
 * - text → 普通文本
 * - code_inline → 行内代码
 * - strong_open/close → 后续 runs 加 bold
 * - em_open/close → 后续 runs 加 italic
 * - s_open/close → 后续 runs 加 strike
 * - link_open → 后续 runs 加 href
 * - softbreak → 空格
 * - hardbreak → 换行符 \n
 * - image → 转为 alt 文本（无法嵌入图片二进制）
 * - emoji → 直接使用 content（已是 unicode 字符）
 */
export function parseInlineTokens(tokens: Token[]): InlineRun[] {
  const runs: InlineRun[] = [];

  // 格式栈：记录当前激活的格式
  const boldStack: boolean[] = [];
  const italicStack: boolean[] = [];
  const strikeStack: boolean[] = [];
  const linkStack: string[] = [];

  const makeRun = (text: string): InlineRun => ({
    text,
    bold: boldStack.length > 0 || undefined,
    italic: italicStack.length > 0 || undefined,
    strike: strikeStack.length > 0 || undefined,
    href: linkStack.length > 0 ? linkStack[linkStack.length - 1] : undefined,
  });

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;

    switch (t.type) {
      case "text":
      case "emoji":
        if (t.content) runs.push(makeRun(t.content));
        break;
      case "code_inline":
        // 行内代码：独立 run，标记 code:true
        runs.push({
          text: t.content || "",
          code: true,
        });
        break;
      case "softbreak":
        runs.push(makeRun(" "));
        break;
      case "hardbreak":
        runs.push(makeRun("\n"));
        break;
      case "strong_open":
        boldStack.push(true);
        break;
      case "strong_close":
        boldStack.pop();
        break;
      case "em_open":
        italicStack.push(true);
        break;
      case "em_close":
        italicStack.pop();
        break;
      case "s_open":
        strikeStack.push(true);
        break;
      case "s_close":
        strikeStack.pop();
        break;
      case "link_open": {
        const href = getTokenAttr(t, "href") || "";
        linkStack.push(href);
        break;
      }
      case "link_close":
        linkStack.pop();
        break;
      case "image": {
        // 图片无法直接转为 docx TextRun，使用 alt 文本占位
        const alt = getTokenAttr(t, "alt") || t.content || "";
        if (alt) runs.push(makeRun(`[图片: ${alt}]`));
        break;
      }
      case "footnote_ref":
        // 脚注引用 [^label]，简化为上标文本
        if (t.meta && typeof t.meta === "object" && "label" in t.meta) {
          runs.push(makeRun(`[^${(t.meta as { label: string }).label}]`));
        }
        break;
      default:
        // 忽略其他 inline token（如 math_inline 等）
        break;
    }
  }

  // 过滤空文本 run（保留 code:true 的空 run 以维持格式）
  return runs.filter((r) => r.text.length > 0);
}

/**
 * 解析列表（bullet_list / ordered_list）
 *
 * @param tokens 完整 token 数组
 * @param startIdx list_open 的索引
 * @returns { items, nextIndex, start } items 为列表项树，nextIndex 为 list_close 之后的索引
 */
function parseList(
  tokens: Token[],
  startIdx: number,
): { items: ListItem[]; nextIndex: number; start: number } {
  const openType = tokens[startIdx]?.type;
  const isOrdered = openType === "ordered_list_open";
  const closeType = isOrdered ? "ordered_list_close" : "bullet_list_close";
  const itemOpenType = "list_item_open";

  // 有序列表起始序号（从 attrs.start 读取，默认 1）
  let start = 1;
  if (isOrdered) {
    const startAttr = getTokenAttr(tokens[startIdx]!, "start");
    if (startAttr) {
      const n = parseInt(startAttr, 10);
      if (Number.isFinite(n) && n > 0) start = n;
    }
  }

  const items: ListItem[] = [];
  let i = startIdx + 1;
  let depth = 1;

  while (i < tokens.length && depth > 0) {
    const t = tokens[i]!;
    if (t.type === openType) {
      depth++;
      i++;
      continue;
    }
    if (t.type === closeType) {
      depth--;
      i++;
      continue;
    }

    if (t.type === itemOpenType && depth === 1) {
      // 收集 list_item_open 到 list_item_close 之间的内容
      const itemStart = i + 1;
      let itemEnd = itemStart;
      let itemDepth = 1;
      while (itemEnd < tokens.length && itemDepth > 0) {
        const it = tokens[itemEnd]!;
        if (it.type === itemOpenType) itemDepth++;
        if (it.type === "list_item_close") itemDepth--;
        if (itemDepth > 0) itemEnd++;
      }

      // 提取 inline 内容（在 item 顶层，跳过嵌套列表）
      const runs: InlineRun[] = [];
      const children: ListItem[] = [];
      let j = itemStart;
      while (j < itemEnd) {
        const jt = tokens[j]!;
        // 嵌套列表开始
        if (jt.type === "bullet_list_open" || jt.type === "ordered_list_open") {
          const nested = parseList(tokens, j);
          children.push(...nested.items);
          j = nested.nextIndex;
          continue;
        }
        if (jt.type === "inline") {
          if (jt.children) {
            runs.push(...parseInlineTokens(jt.children));
          } else if (jt.content) {
            runs.push({ text: jt.content });
          }
        }
        j++;
      }

      items.push({ runs, children: children.length > 0 ? children : undefined });
      i = itemEnd + 1; // 跳过 list_item_close
      continue;
    }

    i++;
  }

  return { items, nextIndex: i, start };
}

/**
 * 解析表格
 *
 * 简化处理：将每个单元格的 inline 内容合并为 InlineRun[]
 * header 是表头行数组（每行 = 单元格数组 = run 数组）
 * rows 是表体行数组（同上）
 *
 * 三维结构：[行][单元格][run]
 * - header[0] 是第一个表头行
 * - header[0][0] 是第一个表头单元格的 runs
 * - header[0][0][0] 是该单元格的第一个 run
 */
function parseTable(
  tokens: Token[],
  startIdx: number,
): { header: InlineRun[][][]; rows: InlineRun[][][]; nextIndex: number } {
  const header: InlineRun[][][] = [];
  const rows: InlineRun[][][] = [];
  let currentRow: InlineRun[][] = [];
  let currentCell: InlineRun[] = [];
  let isHeader = false;
  let depth = 0;

  let i = startIdx;
  for (; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type === "table_open") {
      depth++;
      continue;
    }
    if (t.type === "table_close") {
      depth--;
      if (depth === 0) break;
      continue;
    }
    if (t.type === "thead_open") {
      isHeader = true;
      continue;
    }
    if (t.type === "thead_close") {
      isHeader = false;
      continue;
    }
    if (t.type === "tbody_open" || t.type === "tbody_close") continue;
    if (t.type === "tr_open") {
      currentRow = [];
      continue;
    }
    if (t.type === "tr_close") {
      if (currentRow.length > 0) {
        if (isHeader) header.push(currentRow);
        else rows.push(currentRow);
      }
      currentRow = [];
      continue;
    }
    if (t.type === "th_open" || t.type === "td_open") {
      currentCell = [];
      continue;
    }
    if (t.type === "th_close" || t.type === "td_close") {
      currentRow.push(currentCell);
      currentCell = [];
      continue;
    }
    if (t.type === "inline") {
      if (t.children) {
        currentCell.push(...parseInlineTokens(t.children));
      } else if (t.content) {
        currentCell.push({ text: t.content });
      }
    }
  }

  return { header, rows, nextIndex: i + 1 };
}

/**
 * 解析引用块：将内部 token 递归解析为 Block[]
 */
function parseBlockquote(
  tokens: Token[],
  startIdx: number,
): { blocks: Block[]; nextIndex: number } {
  const innerTokens: Token[] = [];
  let depth = 0;
  let i = startIdx;
  for (; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type === "blockquote_open") {
      depth++;
      if (depth === 1) continue;
    }
    if (t.type === "blockquote_close") {
      depth--;
      if (depth === 0) break;
    }
    if (depth >= 1) innerTokens.push(t);
  }
  const blocks = parseBlockTokens(innerTokens, 0, innerTokens.length);
  return { blocks, nextIndex: i + 1 };
}

/**
 * 解析块级 token 流为 Block[] 数组
 *
 * @param tokens markdown-it parse 输出的 token 数组
 * @param start 起始索引（含）
 * @param end 结束索引（不含）
 */
export function parseBlockTokens(tokens: Token[], start: number, end: number): Block[] {
  const blocks: Block[] = [];
  let i = start;

  while (i < end) {
    const token = tokens[i];
    if (!token) {
      i++;
      continue;
    }

    switch (token.type) {
      case "heading_open": {
        const level = parseInt(token.tag?.slice(1) || "1", 10) as 1 | 2 | 3 | 4 | 5 | 6;
        // 收集 heading_open 到 heading_close 之间的 inline 内容
        let inlineChildren: Token[] = [];
        let j = i + 1;
        for (; j < end; j++) {
          const jt = tokens[j]!;
          if (jt.type === "heading_close") break;
          if (jt.type === "inline" && jt.children) {
            inlineChildren = jt.children;
          }
        }
        const runs = parseInlineTokens(inlineChildren);
        blocks.push({ kind: "heading", level, runs });
        i = j + 1;
        break;
      }
      case "paragraph_open": {
        let inlineChildren: Token[] = [];
        let j = i + 1;
        for (; j < end; j++) {
          const jt = tokens[j]!;
          if (jt.type === "paragraph_close") break;
          if (jt.type === "inline" && jt.children) {
            inlineChildren = jt.children;
          }
        }
        const runs = parseInlineTokens(inlineChildren);
        blocks.push({ kind: "paragraph", runs });
        i = j + 1;
        break;
      }
      case "bullet_list_open":
      case "ordered_list_open": {
        const result = parseList(tokens, i);
        if (token.type === "ordered_list_open") {
          blocks.push({ kind: "orderedList", items: result.items, start: result.start });
        } else {
          blocks.push({ kind: "bulletList", items: result.items });
        }
        i = result.nextIndex;
        break;
      }
      case "fence": {
        const language = (token.info || "").trim().split(/\s+/)[0] || "";
        // mermaid 代码块简化为普通代码块（无法在 docx 中渲染图表）
        blocks.push({ kind: "codeBlock", content: token.content || "", language });
        i = i + 1;
        break;
      }
      case "code_block": {
        blocks.push({ kind: "codeBlock", content: token.content || "", language: "" });
        i = i + 1;
        break;
      }
      case "math_block": {
        blocks.push({ kind: "mathBlock", latex: token.content || "" });
        i = i + 1;
        break;
      }
      case "hr": {
        blocks.push({ kind: "hr" });
        i = i + 1;
        break;
      }
      case "table_open": {
        const result = parseTable(tokens, i);
        blocks.push({ kind: "table", header: result.header, rows: result.rows });
        i = result.nextIndex;
        break;
      }
      case "blockquote_open": {
        const result = parseBlockquote(tokens, i);
        blocks.push({ kind: "blockquote", blocks: result.blocks });
        i = result.nextIndex;
        break;
      }
      default:
        // 忽略未识别的 token（如 footnote_block_open 等）
        i++;
        break;
    }
  }

  return blocks;
}

// ─── markdown-it 实例创建 ──────────────────────

/**
 * 创建默认的 markdown-it 实例（与主解析器 parser.ts 保持一致的插件配置）
 *
 * 必须与 parser.ts 一致，否则导出的 Word 文档结构与预览不一致。
 */
function createDefaultMarkdownIt(): MarkdownIt {
  const md = new MarkdownIt("commonmark", {
    html: false,
    breaks: true,
    linkify: true,
    typographer: true,
  });
  md.enable(["table", "strikethrough"]);
  md.use(mathPlugin);
  md.use(taskListPlugin);
  md.use(headingAnchorPlugin);
  md.use(tocPlugin);
  md.use(markPlugin);
  md.use(subPlugin);
  md.use(supPlugin);
  md.use(emojiPlugin);
  md.use(footnotePlugin);
  md.use(deflistPlugin);
  return md;
}

/**
 * 将 markdown 字符串解析为 Block[] 中间结构
 *
 * @param markdown markdown 源码
 * @param mdInstance 可选的 markdown-it 实例（用于测试或自定义插件配置）
 * @returns Block[] 块级元素数组
 */
export function parseMarkdownToBlocks(
  markdown: string,
  mdInstance?: MarkdownIt,
): Block[] {
  const md = mdInstance || createDefaultMarkdownIt();
  const tokens = md.parse(markdown, {});
  return parseBlockTokens(tokens, 0, tokens.length);
}

// ─── Block[] → docx 元素转换 ──────────────────────

/**
 * 将 InlineRun[] 转换为 docx TextRun[] 数组
 *
 * 返回 any[] 是为了绕过 docx 库 ParagraphChild 类型联合的复杂签名，
 * 实际元素都是 TextRun 实例。
 */
async function inlineRunsToTextRuns(runs: InlineRun[]): Promise<any[]> {
  const { TextRun } = await import("docx");
  const result: any[] = [];
  for (const r of runs) {
    const props: Record<string, unknown> = {};
    if (r.bold) props.bold = true;
    if (r.italic) props.italics = true;
    if (r.strike) props.strike = true;
    if (r.code) {
      props.font = "Consolas";
      props.shading = { type: "clear", fill: "f4f4f4", color: "auto" };
    }
    // 简化：链接转为带颜色的文本（docx 超链接需要 ExternalHyperlink，实现复杂）
    if (r.href) props.color = "0078d4";
    // 处理文本中的换行符（hardbreak）：按行拆分，每行一个 TextRun，非首行加 break:1
    if (r.text.includes("\n")) {
      const lines = r.text.split("\n");
      lines.forEach((line, idx) => {
        result.push(
          new TextRun({
            ...props,
            text: line,
            break: idx > 0 ? 1 : undefined,
          }),
        );
      });
    } else {
      result.push(new TextRun({ ...props, text: r.text }));
    }
  }
  return result;
}

/**
 * 将 Block[] 转换为 docx 文档元素数组（Paragraph/Table 等）
 *
 * @param blocks Block[] 中间结构
 * @param indentLevel 缩进级别（用于 blockquote 嵌套）
 * @returns docx 元素数组（用于 Document 的 sections.children）
 */
export async function convertBlocksToDocxElements(
  blocks: Block[],
  indentLevel: number = 0,
): Promise<unknown[]> {
  const docx = await import("docx");
  const {
    Paragraph,
    TextRun,
    HeadingLevel,
    BorderStyle,
    Table,
    TableRow,
    TableCell,
    WidthType,
    ShadingType,
  } = docx;

  const elements: unknown[] = [];

  for (const block of blocks) {
    switch (block.kind) {
      case "heading": {
        const headingMap: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
          1: HeadingLevel.HEADING_1,
          2: HeadingLevel.HEADING_2,
          3: HeadingLevel.HEADING_3,
          4: HeadingLevel.HEADING_4,
          5: HeadingLevel.HEADING_5,
          6: HeadingLevel.HEADING_6,
        };
        const headingLevel = headingMap[block.level] || HeadingLevel.HEADING_1;
        const textRuns = await inlineRunsToTextRuns(block.runs);
        elements.push(
          new Paragraph({
            heading: headingLevel,
            children: textRuns,
          }),
        );
        break;
      }
      case "paragraph": {
        const textRuns = await inlineRunsToTextRuns(block.runs);
        elements.push(
          new Paragraph({
            children: textRuns,
            indent: indentLevel > 0 ? { left: indentLevel * 720 } : undefined,
          }),
        );
        break;
      }
      case "bulletList": {
        for (const item of block.items) {
          const textRuns = await inlineRunsToTextRuns(item.runs);
          elements.push(
            new Paragraph({
              bullet: { level: 0 },
              children: textRuns,
            }),
          );
          // 嵌套子项
          if (item.children) {
            for (const child of item.children) {
              const childRuns = await inlineRunsToTextRuns(child.runs);
              elements.push(
                new Paragraph({
                  bullet: { level: 1 },
                  children: childRuns,
                }),
              );
            }
          }
        }
        break;
      }
      case "orderedList": {
        for (let idx = 0; idx < block.items.length; idx++) {
          const item = block.items[idx]!;
          const textRuns = await inlineRunsToTextRuns(item.runs);
          elements.push(
            new Paragraph({
              numbering: { reference: "default-numbering", level: 0 },
              children: textRuns,
            }),
          );
          if (item.children) {
            for (const child of item.children) {
              const childRuns = await inlineRunsToTextRuns(child.runs);
              elements.push(
                new Paragraph({
                  numbering: { reference: "default-numbering", level: 1 },
                  children: childRuns,
                }),
              );
            }
          }
        }
        break;
      }
      case "codeBlock": {
        // 代码块：每行一个 TextRun，monospace 字体 + 灰色背景
        const lines = block.content.replace(/\n$/, "").split("\n");
        const codeRuns: any[] = [];
        lines.forEach((line, idx) => {
          codeRuns.push(
            new TextRun({
              text: line,
              font: "Consolas",
              break: idx > 0 ? 1 : undefined,
              color: "1a1a1a",
            }),
          );
        });
        elements.push(
          new Paragraph({
            children: codeRuns,
            shading: { type: ShadingType.CLEAR, fill: "f4f4f4", color: "auto" },
          }),
        );
        break;
      }
      case "mathBlock": {
        // 数学公式：保留 latex 源码（无法在 docx 中渲染 KaTeX）
        elements.push(
          new Paragraph({
            children: [
              new TextRun({ text: block.latex, font: "Consolas", italics: true }),
            ],
          }),
        );
        break;
      }
      case "table": {
        // 使用 any[] 绕过 docx 库 TableRow 实例类型在 TS 中的使用限制
        // （TableRow 是值而非类型，无法直接作为类型注解）
        const rows: any[] = [];
        // 表头（三维结构：header[行][单元格][run]）
        for (const headerRow of block.header) {
          const headerCells = headerRow.map(
            (cellRuns) =>
              new TableCell({
                children: [
                  new Paragraph({
                    children: cellRuns.map(
                      (r) =>
                        new TextRun({
                          text: r.text,
                          bold: true,
                        }),
                    ),
                  }),
                ],
                shading: { type: ShadingType.CLEAR, fill: "f5f5f5", color: "auto" },
              }),
          );
          rows.push(new TableRow({ tableHeader: true, children: headerCells }));
        }
        // 表体（三维结构：rows[行][单元格][run]）
        for (const row of block.rows) {
          const cells = row.map(
            (cellRuns) =>
              new TableCell({
                children: [
                  new Paragraph({
                    children: cellRuns.map((r) => new TextRun({ text: r.text })),
                  }),
                ],
              }),
          );
          rows.push(new TableRow({ children: cells }));
        }
        elements.push(
          new Table({
            rows,
            width: { size: 100, type: WidthType.PERCENTAGE },
          }),
        );
        break;
      }
      case "blockquote": {
        // 引用块：递归转换内部块，添加左缩进
        const innerElements = await convertBlocksToDocxElements(
          block.blocks,
          indentLevel + 1,
        );
        elements.push(...innerElements);
        break;
      }
      case "hr": {
        elements.push(
          new Paragraph({
            border: {
              bottom: { color: "999999", space: 1, style: BorderStyle.SINGLE, size: 6 },
            },
          }),
        );
        break;
      }
    }
  }

  return elements;
}

/**
 * 将 markdown 转换为 .docx 文件并下载
 *
 * @param markdown markdown 源码
 * @param filename 下载文件名（不含扩展名）
 * @returns 成功返回 true，失败返回 false
 *
 * 修复 v0.3.0：Tauri 环境下使用 save 对话框选择保存路径，writeFile 写入二进制
 *
 * @param opts.filePath 当前编辑文件路径，用于推导默认保存目录
 */
export async function markdownToDocx(
  markdown: string,
  filename: string,
  filePath?: string | null,
): Promise<boolean> {
  try {
    const { Document, Packer, AlignmentType, LevelFormat } = await import("docx");

    // 1. markdown → Block[]
    const blocks = parseMarkdownToBlocks(markdown);

    // 2. Block[] → docx 元素
    const children = await convertBlocksToDocxElements(blocks);

    // 3. 构造 Document（含有序列表 numbering 配置）
    const doc = new Document({
      numbering: {
        config: [
          {
            reference: "default-numbering",
            levels: [
              {
                level: 0,
                format: LevelFormat.DECIMAL,
                text: "%1.",
                alignment: AlignmentType.START,
              },
              {
                level: 1,
                format: LevelFormat.LOWER_LETTER,
                text: "%2.",
                alignment: AlignmentType.START,
              },
            ],
          },
        ],
      },
      sections: [
        {
          properties: {},
          children: children as any,
        },
      ],
    });

    // 4. 生成 Blob 并下载
    const blob = await Packer.toBlob(doc);
    const finalName = filename.endsWith(".docx") ? filename : `${filename}.docx`;

    // Tauri 环境：使用 save 对话框选择保存路径，writeFile 写入二进制
    const { isTauri } = await import("../services/fileService");
    if (isTauri()) {
      try {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const { writeFile } = await import("@tauri-apps/plugin-fs");
        const defaultDir = getDefaultDir(filePath);
        const selected = await save({
          defaultPath: defaultDir ? `${defaultDir}/${finalName}` : finalName,
          filters: [{ name: "Word", extensions: ["docx"] }],
        });
        if (selected) {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          await writeFile(selected, bytes);
          notifySuccess(t("export.word.exported", { name: finalName }));
          return true;
        }
        return false; // 用户取消
      } catch (err) {
        console.error("Tauri 导出 Word 失败，回退到浏览器下载:", err);
        // 回退到浏览器下载
      }
    }

    // 浏览器模式：触发下载
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = finalName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    notifySuccess(t("export.word.exported", { name: finalName }));
    return true;
  } catch (err) {
    console.error("Word 导出失败:", err);
    notifyError(
      t("export.word.exportFailed", {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return false;
  }
}
