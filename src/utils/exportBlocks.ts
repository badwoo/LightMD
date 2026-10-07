/**
 * 导出共用中间结构：markdown-it token → Block[] / InlineRun[]
 *
 * 设计原则：
 * - 纯函数优先：将 markdown → 中间结构 Block[]，下游（docx / latex / 其它）各自渲染
 * - 从 exportDocx.ts 抽取，供多导出器共用，避免各导出器重复实现解析逻辑
 * - 下游导出器（docx / latex）只读取关心的字段；扩展的字段（mark/sub/sup/math/imageSrc）
 *   对既有的 docx 渲染无副作用（docx 忽略它们）
 *
 * 支持的 markdown 元素：
 * - heading h1-h6
 * - paragraph
 * - bullet_list / ordered_list（支持嵌套）
 * - code_block（fence）/ code_block（缩进）
 * - table（含表头）
 * - blockquote
 * - hr
 * - math_block（$$...$$）
 * - 行内格式：bold/italic/strike/code/link/mark/sub/sup/数学公式（行内 $...$）
 * - image（转为带 imageSrc 的占位 run，下游自行决定渲染方式）
 */

import MarkdownIt from "markdown-it";
// R1(v0.10.0):实例统一由 renderPipeline 创建（内部走 parser 工厂），配置单一来源
import { getDocxLatexMarkdownIt } from "../core/renderPipeline";

// Token 类型兼容 markdown-it（与 parser.ts 保持一致，避免引入 markdown-it/lib/token 类型声明）
export interface Token {
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
  /** 高亮（mark 插件，==text==），LaTeX 渲染为 \\hl{} */
  mark?: boolean;
  /** 下标（sub 插件），LaTeX 渲染为 \\textsubscript{} */
  sub?: boolean;
  /** 上标（sup 插件），LaTeX 渲染为 \\textsuperscript{} */
  sup?: boolean;
  /** 行内数学公式（LaTeX 源码，不含 $...$），渲染为 $...$ */
  math?: string;
  /** 图片原始 src（image token），LaTeX 渲染为 \\includegraphics{} */
  imageSrc?: string;
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
export function getTokenAttr(token: Token, name: string): string | null {
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
 * - mark_open/close → 后续 runs 加 mark
 * - sub_open/close → 后续 runs 加 sub
 * - sup_open/close → 后续 runs 加 sup
 * - link_open → 后续 runs 加 href
 * - math_inline → 行内数学公式（LaTeX 源码）
 * - softbreak → 空格
 * - hardbreak → 换行符 \n
 * - image → 转为带 imageSrc 的占位 run
 * - emoji → 直接使用 content（已是 unicode 字符）
 */
export function parseInlineTokens(tokens: Token[]): InlineRun[] {
  const runs: InlineRun[] = [];

  // 格式栈：记录当前激活的格式
  const boldStack: boolean[] = [];
  const italicStack: boolean[] = [];
  const strikeStack: boolean[] = [];
  const markStack: boolean[] = [];
  const subStack: boolean[] = [];
  const supStack: boolean[] = [];
  const linkStack: string[] = [];

  const makeRun = (text: string): InlineRun => ({
    text,
    bold: boldStack.length > 0 || undefined,
    italic: italicStack.length > 0 || undefined,
    strike: strikeStack.length > 0 || undefined,
    mark: markStack.length > 0 || undefined,
    sub: subStack.length > 0 || undefined,
    sup: supStack.length > 0 || undefined,
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
      case "math_inline":
        // 行内公式：保留 LaTeX 源码，渲染为 $...$
        runs.push({ text: t.content || "", math: t.content || "" });
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
      case "mark_open":
        markStack.push(true);
        break;
      case "mark_close":
        markStack.pop();
        break;
      case "sub_open":
        subStack.push(true);
        break;
      case "sub_close":
        subStack.pop();
        break;
      case "sup_open":
        supStack.push(true);
        break;
      case "sup_close":
        supStack.pop();
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
        // 图片：保留 src 供下游渲染（LaTeX → \includegraphics），同时提供 alt 占位文本
        const src = getTokenAttr(t, "src") || "";
        const alt = getTokenAttr(t, "alt") || t.content || "";
        const run: InlineRun = { text: alt ? `[图片: ${alt}]` : "[图片]", imageSrc: src || undefined };
        runs.push(run);
        break;
      }
      case "footnote_ref":
        // 脚注引用 [^label]，简化为上标文本
        if (t.meta && typeof t.meta === "object" && "label" in t.meta) {
          runs.push(makeRun(`[^${(t.meta as { label: string }).label}]`));
        }
        break;
      default:
        // 忽略其他 inline token
        break;
    }
  }

  // 过滤空文本 run（保留 code:true / imageSrc 的 run 以维持格式与图片信息）
  return runs.filter((r) => r.text.length > 0 || r.imageSrc !== undefined);
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
        // mermaid 代码块简化为普通代码块（无法在多数下游渲染为图表）
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
 * 创建默认的 markdown-it 实例(R1,v0.10.0:统一走 renderPipeline 配置)
 *
 * - typographer false(与编辑器一致,导出不静默改写弯引号——R1 消除漂移)
 * - validateLink 白名单强制(javascript: 等危险 scheme 的链接解析为字面文本,
 *   不再进入 DOCX/LaTeX——R1 安全统一;data:image 放行,base64 图不受影响)
 * - html 维持 false:Block[] 中间结构无法承载 html token,开启会丢内容(E14 factory jsdoc)
 */
export function createDefaultMarkdownIt(): MarkdownIt {
  return getDocxLatexMarkdownIt();
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
