/**
 * markdown-it → ProseMirror 解析器
 * 将 markdown-it token 流转换为 ProseMirror 文档节点
 */
import MarkdownIt from "markdown-it";
import markPlugin from "markdown-it-mark";
import subPlugin from "markdown-it-sub";
import supPlugin from "markdown-it-sup";
import { full as emojiPlugin } from "markdown-it-emoji";
import footnotePlugin from "markdown-it-footnote";
import deflistPlugin from "markdown-it-deflist";
import { lightMDSchema } from "../schema";
import type { Node } from "prosemirror-model";
import { mathPlugin } from "./katex-plugin";
import { taskListPlugin } from "./task-list-plugin";
import { headingAnchorPlugin, collectHeadings, type TocHeading } from "./heading-anchor";
import { tocPlugin } from "./toc-plugin";
import { setBlockSource } from "./blockSourceMap";

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

// v0.7.3 改进6(S2)：链接 URL scheme 白名单。
// 校验 LLM 输出/恶意文档写入的 href，javascript:/data:/vbscript:/file: 等
// 危险 scheme 拒绝，其余放行。拒绝时返回 null → 保留文本但不渲染为可点击链接。
export function sanitizeLinkHref(href: string): string | null {
  const h = href.trim();
  if (!h) return null; // 空链接
  const m = /^([a-z][a-z0-9.+-]*):/i.exec(h);
  if (!m) return h; // 无 scheme：相对路径/锚点/纯文本放行
  const protocol = m[1].toLowerCase();
  const BAD = ["javascript", "data", "vbscript", "file"];
  if (BAD.includes(protocol)) return null;
  return h; // http/https/ftp/mailto/tel 及未知 scheme 放行（与 markdown-it 语义对齐）
}

const schema = lightMDSchema;

// 配置 markdown-it
const md = new MarkdownIt("commonmark", {
  html: false,
  breaks: true,
  linkify: true,
  // v0.9.0 C5：关闭 typographer——智能引号会在解析层把直引号改写为弯引号，
  // 文档内容被静默改字（git diff 噪音）。保真优先；预览不再自动排版弯引号。
  typographer: false,
});

md.enable(["table", "strikethrough"]);
md.use(mathPlugin);
md.use(taskListPlugin);
// 标题锚点自动生成 id + [toc] 自动目录（分屏预览/导出 HTML 时生效）
md.use(headingAnchorPlugin);
md.use(tocPlugin);
// 高亮标记、上下标、emoji、脚注、定义列表
md.use(markPlugin);
md.use(subPlugin);
md.use(supPlugin);
md.use(emojiPlugin);
md.use(footnotePlugin);
md.use(deflistPlugin);

// v0.7.3 改进6(S2)：链接 scheme 白名单——markdown-it 在解析层即拒绝
// javascript:/data:/vbscript:/file: 链接（渲染为纯文本，不出 <a href="">），
// 与 PM 回写的 sanitizeLinkHref 双层防护（防提示注入产出的恶意链接）
md.validateLink = (url: string) => sanitizeLinkHref(url) !== null;

// ─── 公开 API ──────────────────────────────────────────────

export function markdownToDoc(markdown: string): Node {
  const env: Record<string, unknown> = {};
  const rawTokens = md.parse(markdown, env);
  const tokens = rawTokens as unknown as Token[];
  // 获取 heading-anchor 插件收集的标题列表，供 toc 节点使用
  const headings = (env.__headings as TocHeading[] | undefined) || collectHeadings(tokens);
  // v0.6.6 问题1：传入源码串，供顶层解析基于 token map 行号还原空行 → 空段落
  const content = parseBlockTokens(tokens, 0, tokens.length, headings, markdown);
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
  // v0.6.0 修复：parseInline 返回单个 inline token，其 children 才是行内 token 流
  // （此前直接传外层 token 导致始终返回空数组）
  const children = (rawTokens[0] as unknown as Token | undefined)?.children || [];
  return parseInlineTokens(children);
}

// ─── 块级 token 解析 ──────────────────────────────────────

/**
 * v0.6.6 问题1：计算 markdown 源码的逻辑行数（末尾换行符后无内容不算一行）
 */
function countSourceLines(source: string): number {
  if (!source) return 0;
  const lines = source.split("\n");
  return source.endsWith("\n") ? lines.length - 1 : lines.length;
}

/**
 * v0.6.6 问题1：顶层解析时基于 token map 行号还原空行对应的空段落。
 *
 * markdown-it 不为空行生成 token，空文档/文档末尾的多个空行
 * （用户显式按回车产生）在解析后全部丢失——切页签/重开后换行消失。
 * 规则（与 serializer 的输出格式互逆）：
 * - 文档开头 m 个空行 → m 个空段落
 * - 相邻块之间 gap 个空行 → gap-1 个空段落（gap=1 为正常段落分隔）
 * - 文档末尾 t 个空行 → t-1 个空段落
 * - 全空白文档 w 个空行 → w 个空段落
 *
 * 仅顶层调用传入 source（嵌套块如引用块内部空行不还原，保持原行为）。
 */
function parseBlockTokens(tokens: Token[], start: number, end: number, headings?: TocHeading[], source?: string): Node[] {
  const nodes: Node[] = [];
  let i = start;
  let prevEndLine: number | null = null;
  // v0.7.0 修复1b：源码行缓存，供 map 尾部空行收缩判断
  const sourceLines: string[] | null = source !== undefined ? source.split("\n") : null;
  // v0.9.0 B6：顶层块原文行号记录（仅顶层调用传入 source 时启用）。
  // serializer 对命中记录的块直接输出原文切片，实现未编辑块零重排。
  const totalLines = source !== undefined ? countSourceLines(source) : 0;
  const recordBlock = (node: Node, blockStart: number, blockEnd: number) => {
    if (source !== undefined) setBlockSource(node, { start: blockStart, end: blockEnd, source });
  };

  while (i < end) {
    const token = tokens[i];
    // 块级 open/自闭合 token 携带 map（close/inline token 无有效 map）
    let anchorMap: [number, number] | null = null;
    if (source !== undefined && token.map && token.nesting >= 0 && token.block) {
      // v0.7.0 修复1b：markdown-it 的列表类 token map 会吞掉块后的连续空行
      // （如 "- a\n- b\n\n" 的 bullet_list map=[0,3]，末尾空行被并入 map），
      // 直接以 map[1] 作为结束行会把末尾/块间空段落数算成 0，切标签后空行丢失。
      // 修复：从 map 尾部收缩掉空行，得到实际内容结束行（对 fence/table 等尾部
      // 本就是内容行的块无影响，仅列表类会被收缩）。
      let endLine = token.map[1];
      while (
        sourceLines && endLine > token.map[0] &&
        endLine <= sourceLines.length && !sourceLines[endLine - 1].trim()
      ) {
        endLine--;
      }
      anchorMap = [token.map[0], endLine];
      if (prevEndLine === null) {
        for (let k = 0; k < token.map[0]; k++) {
          const p = schema.nodes.paragraph.create();
          recordBlock(p, k, k + 1); // B6：头部空段落记录（每个对应 1 个空行）
          nodes.push(p);
        }
      } else {
        const gap = token.map[0] - prevEndLine;
        for (let k = 1; k < gap; k++) {
          const p = schema.nodes.paragraph.create();
          recordBlock(p, prevEndLine + k, prevEndLine + k + 1); // B6：块间空段落记录
          nodes.push(p);
        }
      }
    }

    // v0.9.0 D3：脚注块特殊处理。footnote_block_open 不带 map，若走通用路径
    // prevEndLine 停留在脚注块之前，尾部空行还原会把脚注定义占的行数当空行
    // 还原（每往返一次尾部多 2 空行，永不收敛）。这里从源码行扫描脚注定义
    // 的起始行，更新 prevEndLine，并为每个定义节点记录 B6 原文区间。
    if (sourceLines && token.type === "footnote_block_open") {
      const result = parseBlockToken(tokens, i, end, headings);
      if (result) {
        const defs = [result.node, ...(result.extraNodes || [])];
        const scanFrom = prevEndLine ?? 0;
        const defStarts: number[] = [];
        for (let ln = scanFrom; ln < sourceLines.length; ln++) {
          if (/^\[\^[^\]]+\]:/.test(sourceLines[ln])) defStarts.push(ln);
        }
        defs.forEach((n, j) => {
          if (defStarts[j] !== undefined) {
            setBlockSource(n, {
              start: defStarts[j],
              end: defStarts[j + 1] ?? totalLines,
              source: source as string,
            });
          }
        });
        nodes.push(...defs);
        i = result.nextIndex;
        const lastStart = defStarts[defStarts.length - 1];
        if (lastStart !== undefined) {
          // 脚注块内容结束行 = 文档尾（尾部空行留给 tail 还原）
          prevEndLine = totalLines;
          // 收缩尾随空行（与通用路径同规则），保证 tail 语义一致
          let e = totalLines;
          while (e > lastStart + 1 && e <= sourceLines.length && !sourceLines[e - 1].trim()) {
            e--;
          }
          prevEndLine = e;
        }
        continue;
      }
    }

    const result = parseBlockToken(tokens, i, end, headings);
    if (result) {
      // 支持返回多个节点（如脚注块包含多个脚注定义）
      if (result.extraNodes && result.extraNodes.length > 0) {
        nodes.push(result.node, ...result.extraNodes);
      } else {
        nodes.push(result.node);
      }
      if (anchorMap) recordBlock(result.node, token.map![0], anchorMap[1]); // B6：内容块记录
      i = result.nextIndex;
    } else {
      i++;
    }
    if (anchorMap) prevEndLine = anchorMap[1];
  }

  // 尾部/全空白文档的空行还原
  if (source !== undefined) {
    if (prevEndLine !== null) {
      // v0.7.0 修复5：末尾 t 个换行 → t 个空段落（原 t-1）
      // 旧规则与旧序列化编码（首空段 2 换行）互逆；新序列化末尾空段每段单换行
      // （N 空段 = N+1 换行）后改为 t 个：与源码模式"每次回车 1 换行"语义对齐，
      // 修复用户末尾按回车后切标签/模式往返每次吞掉末尾空行的问题。
      // 注：首个换行是最后一块的行终止符（"abc\n" → 0 空段，标准结尾无空行）。
      const tail = totalLines - prevEndLine;
      for (let k = 0; k < tail; k++) {
        const p = schema.nodes.paragraph.create();
        setBlockSource(p, { start: prevEndLine + k, end: prevEndLine + k + 1, source });
        nodes.push(p);
      }
    } else if (totalLines > 0) {
      // 无任何块 token：全空白文档，空行数 = 空段落数
      for (let k = 0; k < totalLines; k++) {
        const p = schema.nodes.paragraph.create();
        setBlockSource(p, { start: k, end: k + 1, source });
        nodes.push(p);
      }
    }
  }
  return nodes;
}

interface ParseResult {
  node: Node;
  extraNodes?: Node[]; // 额外的节点（在 node 之后）
  nextIndex: number;
}

function parseBlockToken(tokens: Token[], index: number, end: number, headings?: TocHeading[]): ParseResult | null {
  const token = tokens[index];
  if (!token) return null;

  switch (token.type) {
    case "heading_open": return parseHeading(tokens, index);
    case "paragraph_open": return parseParagraph(tokens, index);
    case "bullet_list_open": return parseList(tokens, index, "bullet_list");
    case "ordered_list_open": return parseList(tokens, index, "ordered_list");
    case "task_list_open": return parseTaskList(tokens, index);
    case "blockquote_open": return parseBlockquote(tokens, index, headings);
    case "fence": return parseFence(tokens, index);
    // v0.8.0 修复 P11-6：缩进代码块（markdown-it 的 code_block token，无语言标识）。
    // 此前该 token 类型没有对应解析分支，顶层与列表项内的缩进代码块内容会**直接丢失**。
    case "code_block": return parseCodeBlock(tokens, index);
    case "math_block": return parseMathBlock(tokens, index);
    case "hr":
      return { node: schema.nodes.horizontal_rule.create(), nextIndex: index + 1 };
    case "table_open":
      return parseTable(tokens, index);
    case "footnote_block_open":
      return parseFootnoteBlock(tokens, index);
    case "dl_open":
      return parseDefinitionList(tokens, index);
    case "toc": {
      // 目录节点：将标题列表序列化为 JSON 存入 attrs，toDOM 渲染嵌套导航列表
      const headingsJson = JSON.stringify(headings || []);
      return {
        node: schema.nodes.toc.create({ headings: headingsJson }),
        nextIndex: index + 1,
      };
    }
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
  // 直接使用 markdown-it 已解析的 inline token children
  // 避免重新调用 md.parseInline 丢失上下文（如脚注引用需要完整解析才会生成 footnote_ref）
  const inlineNodes: Node[] = [];
  let i = index + 1;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "paragraph_close") break;
    if (t.type === "inline") {
      if (t.children) {
        inlineNodes.push(...parseInlineTokens(t.children).filter(n => !n.isText || (n.text && n.text.length > 0)));
      } else if (t.content) {
        // 回退：无 children 时用 parseInline 重新解析
        inlineNodes.push(...parseInline(t.content));
      }
    }
    if (t.type === "hardbreak") inlineNodes.push(schema.nodes.hard_break.create());
  }
  return {
    node: schema.nodes.paragraph.create(null, inlineNodes),
    nextIndex: i + 1,
  };
}

// ─── 列表 ────────────────────────────────────────────────

function parseList(tokens: Token[], index: number, listType: "bullet_list" | "ordered_list"): ParseResult {
  const closeType = listType === "bullet_list" ? "bullet_list_close" : "ordered_list_close";
  const listNodeType = listType === "bullet_list" ? schema.nodes.bullet_list : schema.nodes.ordered_list;

  const items: Node[] = [];
  let i = index + 1; // 跳过 list_open

  while (i < tokens.length) {
    const t = tokens[i];
    if (t.type === closeType) {
      i++;
      break;
    }
    if (t.type !== "list_item_open") {
      i++;
      continue;
    }

    // v0.8.0 修复 P11-6：list_item 的内容是一串**块级子节点**
    // （段落 / 嵌套列表 / 代码块 / 引用块…）。旧实现把项内所有 inline token
    // 累积进同一个 paragraph，导致：
    //   ① 项内多段落被粘连成一段（"第一行第二行"，模式切换后换行彻底消失）；
    //   ② 嵌套列表、项内代码块被完全忽略 → 内容丢失。
    // 这里改为复用通用块解析（parseBlockToken），按真实结构构建块序列。
    const blocks: Node[] = [];
    i++; // 进入 list_item
    while (i < tokens.length && tokens[i].type !== "list_item_close") {
      const consumed = parseBlockToken(tokens, i, tokens.length);
      if (consumed && consumed.nextIndex > i) {
        blocks.push(consumed.node, ...(consumed.extraNodes || []));
        i = consumed.nextIndex;
      } else {
        // 兜底：裸 inline token（无 paragraph 包裹）按段落内容处理
        const raw = tokens[i];
        if (raw.type === "inline") {
          const kids = raw.children ? parseInlineTokens(raw.children) : parseInline(raw.content);
          blocks.push(
            schema.nodes.paragraph.create(
              null,
              kids.filter((n) => !n.isText || (n.text && n.text.length > 0)),
            ),
          );
        }
        i++;
      }
    }
    if (i < tokens.length && tokens[i].type === "list_item_close") i++;

    // list_item 的 content 为 "paragraph block*"：首个子节点必须是段落
    if (blocks.length === 0) {
      blocks.push(schema.nodes.paragraph.create());
    } else if (blocks[0].type.name !== "paragraph") {
      blocks.unshift(schema.nodes.paragraph.create());
    }

    items.push(schema.nodes.list_item.create(null, blocks));
  }

  // v0.9.0 D4：读取 markdown-it 的 start 属性（"5. x" → start=5），
  // 旧实现固定 order:1 导致起始号被改写为 1
  const attrs =
    listType === "ordered_list"
      ? { order: Number(getAttr(tokens[index], "start")) || 1 }
      : {};
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
      // 从 attrs 读取 data-checked 属性（与 task-list-plugin 的输出对齐）
      const checkedAttr = getAttr(t, "data-checked");
      const checked = checkedAttr === "true";
      let content = "";
      const childBlocks: Node[] = [];
      i++;
      // 收集 inline 内容和嵌套的 task_list
      while (i < tokens.length && tokens[i].type !== "task_item_close") {
        if (tokens[i].type === "inline") {
          content += tokens[i].content;
        } else if (tokens[i].type === "task_list_open") {
          // 递归解析嵌套的任务列表
          const childResult = parseTaskList(tokens, i);
          childBlocks.push(childResult.node);
          i = childResult.nextIndex;
          continue; // i 已被 parseTaskList 更新，跳过下面的 i++
        }
        i++;
      }
      // 跳过 task_item_close
      if (i < tokens.length && tokens[i].type === "task_item_close") i++;

      const para = schema.nodes.paragraph.create(null, parseInline(content));
      // task_item 的 content 为 "paragraph block*"，嵌套 task_list 作为 block*
      const children = [para, ...childBlocks];
      items.push(schema.nodes.task_item.create({ checked }, children));
    } else {
      i++;
    }
  }

  return { node: schema.nodes.task_list.create(null, items), nextIndex: i };
}

// ─── 引用块 ──────────────────────────────────────────────

function parseBlockquote(tokens: Token[], index: number, headings?: TocHeading[]): ParseResult {
  let depth = 0;
  const innerTokens: Token[] = [];
  let i = index;

  // v0.9.0 D1：嵌套引用内容保留。
  // 旧实现在 depth 变 2 后 `if (depth === 1)` 恒假，内层块的全部 token
  // （含内层 open/close）都不进 innerTokens，递归解析拿不到内层块 → 内层
  // 引用整体丢失。现在：内层 blockquote_open 起整体收集（含边界 token 与
  // 匹配的 close），交给现有递归 parseBlockquote 解析。
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "blockquote_open") {
      depth++;
      if (depth >= 2) innerTokens.push(t);
      continue;
    }
    if (t.type === "blockquote_close") {
      depth--;
      if (depth === 0) break; // 外层 close：结束
      innerTokens.push(t); // 内层 close：收集（供递归配对）
      continue;
    }
    if (depth >= 1) innerTokens.push(t);
  }

  const content = parseBlockTokens(innerTokens, 0, innerTokens.length, headings);
  return { node: schema.nodes.blockquote.create(null, content), nextIndex: i + 1 };
}

// ─── 代码块 / Mermaid 图表块 ──────────────────────────────

function parseFence(tokens: Token[], index: number): ParseResult {
  const token = tokens[index];
  const info = token.info || "";
  // 高亮语言仍取 info 首词
  const language = info.trim().split(/\s+/)[0] || "";
  // v0.9.0 D11：attrs.info 保留完整信息串（如 "js {highlight}"），序列化原样输出
  // v0.7.0 修复1b：markdown-it 的 fence content 含最后行的换行符（"x\n"），
  // 若不去掉，序列化时 close 标记前会多出一个空行（"```js\nx\n\n```"）。
  // 只去一个尾随换行，块内末尾空行（"a\n\n" → "a\n"）仍完整保留。
  const textContent = (token.content || "").replace(/\n$/, "") || "\u200B";

  // mermaid 语言使用专用的 mermaid_block 节点
  if (language === "mermaid") {
    return {
      node: schema.nodes.mermaid_block.create(
        { language: "mermaid", info },
        [schema.text(textContent)]
      ),
      nextIndex: index + 1,
    };
  }

  return {
    node: schema.nodes.code_block.create(
      { language, info },
      [schema.text(textContent)]
    ),
    nextIndex: index + 1,
  };
}

/**
 * v0.8.0 修复 P11-6：缩进代码块（4 空格缩进，markdown-it 输出 code_block token）。
 * 与 fence 的区别是没有任何语言标识。
 */
function parseCodeBlock(tokens: Token[], index: number): ParseResult {
  const token = tokens[index];
  const textContent = (token.content || "").replace(/\n$/, "") || "\u200B";
  return {
    node: schema.nodes.code_block.create({ language: "" }, [schema.text(textContent)]),
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
    // v0.8.0 WP5 修复6：改用 children 解析累积节点流（与 inline 一致），
    // 避免 .content join 丢失表格单元格内的段内换行（softbreak）。
    let inlineNodes: Node[] = [];
    for (const t of cellTokens) {
      if (t.type === "inline") {
        const kids = t.children
          ? parseInlineTokens(t.children, true)
          : parseInline(t.content, true);
        for (const n of kids) {
          if (!n.isText || (n.text && n.text.length > 0)) inlineNodes.push(n);
        }
      }
    }
    const cellType = isHeader ? schema.nodes.table_header : schema.nodes.table_cell;
    cellNodes.push(cellType.create({ align }, inlineNodes));
  }
  return schema.nodes.table_row.create(null, cellNodes);
}

// ─── 脚注块 ────────────────────────────────────────────
// 解析 footnote_block_open 到 footnote_block_close 之间的内容
// 每个 footnote_open/footnote_close 对应一个 footnote_definition 节点
// 简化处理：取 footnote 内各段落 inline 内容（空格连接）作为脚注定义内容

function parseFootnoteBlock(tokens: Token[], index: number): ParseResult {
  const defs: Node[] = [];
  let i = index + 1; // 跳过 footnote_block_open

  while (i < tokens.length) {
    const t = tokens[i];
    if (t.type === "footnote_block_close") {
      i++;
      break;
    }
    if (t.type === "footnote_open") {
      // 从 meta 读取 label
      const label = (t.meta as { label?: string })?.label ?? "";
      // 收集 footnote_open 到 footnote_close 之间的内容
      let content = "";
      i++;
      while (i < tokens.length && tokens[i].type !== "footnote_close") {
        // 跳过 footnote_anchor（这是 markdown-it 内部的回链标记）
        if (tokens[i].type === "inline") {
          if (content && !content.endsWith(" ")) content += " ";
          content += tokens[i].content;
        } else if (
          tokens[i].type !== "footnote_anchor" &&
          tokens[i].type !== "paragraph_open" &&
          tokens[i].type !== "paragraph_close"
        ) {
          // v0.9.0 D6：脚注内非段落类的块级内容（代码块等）递归解析取文本
          // 拼接，防止内容整体丢失（接受结构扁平化，先保证不丢）。
          // 注意段落仍走 inline 收集（保留 inline 格式），多段落以空格连接。
          const sub = parseBlockToken(tokens, i, tokens.length);
          if (sub && sub.nextIndex > i) {
            if (content && !content.endsWith(" ")) content += " ";
            content += sub.node.textContent;
            i = sub.nextIndex;
            continue;
          }
        }
        i++;
      }
      // 跳过 footnote_close
      if (i < tokens.length && tokens[i].type === "footnote_close") i++;

      // 创建 footnote_definition 节点
      const inlineNodes = parseInline(content);
      defs.push(schema.nodes.footnote_definition.create({ label }, inlineNodes));
    } else {
      i++;
    }
  }

  // footnote_block 至少需要一个返回节点；若为空则用占位段落
  if (defs.length === 0) {
    defs.push(schema.nodes.paragraph.create());
  }

  const [first, ...rest] = defs;
  return { node: first, extraNodes: rest, nextIndex: i };
}

// ─── 定义列表 ──────────────────────────────────────────
// 解析 dl_open 到 dl_close 之间的内容
// dt_open/dt_close 之间的 inline 作为 definition_term
// dd_open/dd_close 之间的段落内容作为 definition_description（取第一个段落）

function parseDefinitionList(tokens: Token[], index: number): ParseResult {
  const items: Node[] = [];
  let i = index + 1; // 跳过 dl_open

  while (i < tokens.length) {
    const t = tokens[i];
    if (t.type === "dl_close") {
      i++;
      break;
    }
    if (t.type === "dt_open") {
      // 收集 dt_open 到 dt_close 之间的 inline 内容
      let content = "";
      i++;
      while (i < tokens.length && tokens[i].type !== "dt_close") {
        if (tokens[i].type === "inline") content += tokens[i].content;
        i++;
      }
      if (i < tokens.length && tokens[i].type === "dt_close") i++;
      items.push(schema.nodes.definition_term.create(null, parseInline(content)));
    } else if (t.type === "dd_open") {
      // 收集 dd_open 到 dd_close 之间的内容
      let content = "";
      i++;
      while (i < tokens.length && tokens[i].type !== "dd_close") {
        if (tokens[i].type === "inline") {
          if (content && !content.endsWith(" ")) content += " ";
          content += tokens[i].content;
        } else if (
          tokens[i].type !== "paragraph_open" &&
          tokens[i].type !== "paragraph_close"
        ) {
          // v0.9.0 D6：dd 内非段落类的块级内容（代码块/嵌套块等）递归解析
          // 取文本拼接，防止内容整体丢失（接受结构扁平化，先保证不丢）。
          // 段落仍走 inline 收集（保留 inline 格式），多段落以空格连接。
          const sub = parseBlockToken(tokens, i, tokens.length);
          if (sub && sub.nextIndex > i) {
            if (content && !content.endsWith(" ")) content += " ";
            content += sub.node.textContent;
            i = sub.nextIndex;
            continue;
          }
        }
        i++;
      }
      if (i < tokens.length && tokens[i].type === "dd_close") i++;
      items.push(schema.nodes.definition_description.create(null, parseInline(content)));
    } else {
      i++;
    }
  }

  if (items.length === 0) {
    items.push(schema.nodes.definition_term.create());
  }

  return { node: schema.nodes.definition_list.create(null, items), nextIndex: i };
}

// ─── Inline 解析 ─────────────────────────────────────────

function parseInline(text: string, inTableCell = false): Node[] {
  if (!text) return [];
  const rawTokens = md.parseInline(text, {});
  const allTokens = rawTokens as unknown as Token[];

  // md.parseInline wraps results in an "inline" token with children
  // Extract actual tokens from children
  const inlineToken = allTokens.find((t) => t.type === "inline");
  if (inlineToken?.children) {
    return parseInlineTokens(inlineToken.children, inTableCell).filter(n => {
      // 过滤掉空文本节点
      return !n.isText || (n.text && n.text.length > 0);
    });
  }
  return parseInlineTokens(allTokens, inTableCell).filter(n => {
    return !n.isText || (n.text && n.text.length > 0);
  });
}

function parseInlineTokens(tokens: Token[], inTableCell = false): Node[] {
  const nodes: Node[] = [];
  let i = 0;

  while (i < tokens.length) {
    const t = tokens[i];

    if (t.type === "text") {
      // 跳过空文本节点（ProseMirror 不允许空文本节点）
      if (t.content) {
        // v0.8.0 修复 P0-1：表格单元格内的换行由 serializer 写成 <br>（真实换行
        // "  \n" 会截断 GFM 表格行）。md 配置 html:false，<br> 落在 text token 里，
        // 此处仅在表格单元格上下文把它还原为 hard_break，保证表格内换行往返保真。
        if (inTableCell && /<br\s*\/?>/i.test(t.content)) {
          const segs = t.content.split(/<br\s*\/?>/gi);
          segs.forEach((seg, sIdx) => {
            if (sIdx > 0) nodes.push(schema.nodes.hard_break.create());
            if (seg) nodes.push(schema.text(seg));
          });
        } else {
          nodes.push(schema.text(t.content));
        }
      }
      i++; continue;
    }
    if (t.type === "emoji") {
      // v0.9.0 D9：保留 shortcode 原文（:smile:），doc 层不做 unicode 转换——
      // 旧实现存 unicode 字符导致源码写法丢失且不可逆。分屏预览走 md.render
      // 仍由 emoji 插件渲染为图形。
      // 注意 markdown-it-emoji 的 markup 是不含冒号的短码（"smile"）
      const raw = (t.markup as string) || "";
      const shortcode = raw ? (raw.startsWith(":") ? raw : `:${raw}:`) : t.content;
      if (shortcode) nodes.push(schema.text(shortcode));
      i++; continue;
    }
    if (t.type === "hardbreak") { nodes.push(schema.nodes.hard_break.create()); i++; continue; }
    // v0.8.0 WP5 修复6：段内单换行（softbreak）原本被解析成 schema.text(" ")，
    // 导致 md→doc→md 往返丢换行（"a\nb" 变 "a b"）。改为 hard_break 节点，
    // 与 serializer 的 "  \n"（CommonMark 两空格硬换行）互逆，保真往返。
    if (t.type === "softbreak") { nodes.push(schema.nodes.hard_break.create()); i++; continue; }
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
        // v0.7.3 改进6(S2)：危险 scheme 拒绝 → 保留文本但不渲染为可点击链接
        const safeHref = sanitizeLinkHref(href);
        if (safeHref) {
          nodes.push(...innerNodes.map((n) => n.mark([...n.marks, schema.mark("link", { href: safeHref, title })])));
        } else {
          nodes.push(...innerNodes);
        }
      } else if (markType === "strong") {
        nodes.push(...innerNodes.map((n) => n.mark([...n.marks, schema.mark("strong")])));
      } else if (markType === "em") {
        nodes.push(...innerNodes.map((n) => n.mark([...n.marks, schema.mark("em")])));
      } else if (markType === "s") {
        nodes.push(...innerNodes.map((n) => n.mark([...n.marks, schema.mark("strike")])));
      } else if (markType === "mark") {
        // 高亮标记 ==text==
        nodes.push(...innerNodes.map((n) => n.mark([...n.marks, schema.mark("mark")])));
      } else if (markType === "sub") {
        // 下标 ~sub~
        nodes.push(...innerNodes.map((n) => n.mark([...n.marks, schema.mark("subscript")])));
      } else if (markType === "sup") {
        // 上标 ^sup^
        nodes.push(...innerNodes.map((n) => n.mark([...n.marks, schema.mark("superscript")])));
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
    if (t.type === "footnote_ref") {
      // 脚注引用 [^label]，从 meta 读取 label
      const label = (t.meta as { label?: string })?.label ?? "";
      nodes.push(schema.nodes.footnote_ref.create({ label }));
      i++; continue;
    }

    i++;
  }

  return nodes;
}

export { md };
