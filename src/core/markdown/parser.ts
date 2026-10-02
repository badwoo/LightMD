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
import type { Node, Mark } from "prosemirror-model";
import { mathPlugin } from "./katex-plugin";
import { taskListPlugin } from "./task-list-plugin";
import { headingAnchorPlugin, collectHeadings, type TocHeading } from "./heading-anchor";
import { tocPlugin } from "./toc-plugin";
import { setBlockSource } from "./blockSourceMap";
// E14(v0.9.2):段内换行语义默认值取自设置(与 auto-pair 同款 getState 先例)
import { useSettingsStore } from "../../stores/useSettingsStore";

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

// ─── markdown-it 实例管理(E14,v0.9.2) ──────────────────────

/**
 * markdown-it 工厂:插件、validateLink、linkify 等配置全部集中于此。
 * 此前 parser.ts / exportBlocks.ts / ExportDialog.tsx 三处独立实例化且
 * 各自硬编码 breaks,配置变更需改三处且已出现漂移。
 *
 * @param opts.breaks 段内单换行语义:true=GFM(即换行,默认);false=CommonMark(渲染为空格)
 * @param opts.typographer 智能排版(弯引号等);编辑管线恒 false,导出管线维持 true(R1 统一)
 * @param opts.validateLink 链接 scheme 白名单;默认开启(编辑管线)。
 *   导出管线须传 false:导出 HTML 不经 PM,base64 图片(data:)依赖默认放行,
 *   白名单贯通会使 EPUB/PNG 导出丢图;安全策略统一在 R1 处理
 * @param opts.html HTML 放行开关(E8,v0.9.3)。false(默认)=html:false,HTML 全部字面转义——
 *   DOCX/LaTeX 导出(exportBlocks)的 Block[] 中间结构无法承载块级 HTML token,
 *   开启会走 default 分支丢内容,故维持字面文本;
 *   true=html:true 放行,供 HTML/PDF/PNG 导出(ExportDialog)保真输出
 * @param opts.htmlBlockDisabled 编辑管线的 HTML 最小白名单(E8,v0.9.3),仅在 html:true 下有意义:
 *   ① disable html_block——块级 HTML(<div>/<script>)禁用后按普通段落文本字面保留,
 *     否则 token 走 default 分支被跳过、内容直接丢失;
 *   ② 行内 HTML 白名单——渲染层仅放行 <u>/<br>/<sub>/<sup>/<mark>,其余转义。
 *     分屏预览与 PM 解析共用编辑实例,而分屏 iframe 带 allow-scripts + allow-same-origin,
 *     放行任意行内 HTML 等于注入脚本,必须白名单化
 */
export function createMarkdownIt(opts: {
  breaks: boolean;
  typographer?: boolean;
  validateLink?: boolean;
  html?: boolean;
  htmlBlockDisabled?: boolean;
}): MarkdownIt {
  const instance = new MarkdownIt("commonmark", {
    html: opts.html ?? false,
    breaks: opts.breaks,
    linkify: true,
    // 编辑管线保持 v0.9.0 C5 决策:关闭 typographer——智能引号会在解析层把
    // 直引号改写为弯引号,文档内容被静默改字(git diff 噪音)。保真优先。
    typographer: opts.typographer ?? false,
  });
  instance.enable(["table", "strikethrough"]);
  instance.use(mathPlugin);
  instance.use(taskListPlugin);
  // 标题锚点自动生成 id + [toc] 自动目录(分屏预览/导出 HTML 时生效)
  instance.use(headingAnchorPlugin);
  instance.use(tocPlugin);
  // 高亮标记、上下标、emoji、脚注、定义列表
  instance.use(markPlugin);
  instance.use(subPlugin);
  instance.use(supPlugin);
  instance.use(emojiPlugin);
  instance.use(footnotePlugin);
  instance.use(deflistPlugin);

  // E8(v0.9.3):编辑管线的 HTML 最小白名单(详见 jsdoc)
  if (opts.html && opts.htmlBlockDisabled) {
    instance.disable("html_block");
    instance.renderer.rules.html_inline = (tokens, idx) => {
      const content = tokens[idx]?.content || "";
      const trimmed = content.trim();
      // 三层语义与 PM 解析层一致:
      // ① 白名单无属性标签放行(渲染为真实结构);
      // ② 块级标签转义为字面文本(编辑器内按原文显示,分屏一致);
      // ③ 其余行内标签剥离(编辑器同样剥标签保内容)
      if (INLINE_HTML_WHITELIST_RE.test(trimmed)) return content;
      if (isBlockLevelHtmlTag(trimmed)) return instance.utils.escapeHtml(content);
      return "";
    };
  }

  // v0.7.3 改进6(S2):链接 scheme 白名单——markdown-it 在解析层即拒绝
  // javascript:/data:/vbscript:/file: 链接(渲染为纯文本,不出 <a href="">),
  // 与 PM 回写的 sanitizeLinkHref 双层防护(防提示注入产出的恶意链接)。
  // 仅编辑管线启用;导出管线传 validateLink:false 保持 base64 图片可用
  if (opts.validateLink !== false) {
    instance.validateLink = (url: string) => sanitizeLinkHref(url) !== null;
  }
  return instance;
}

/**
 * E8(v0.9.3):行内 HTML 白名单(无属性开/闭标签)。
 * PM 解析层(parseInlineTokens)与 markdown-it 渲染层共用同一判定,
 * 保证"编辑器里转成结构的标签"与"分屏预览里放行渲染的标签"一致。
 */
const INLINE_HTML_WHITELIST_RE = /^<\/?(?:u|br|sub|sup|mark)\s*\/?>$/i;

/**
 * E8(v0.9.3):CommonMark 块级 HTML 标签(html_block 语义)。
 * html_block 禁用后,块级标签会以 html_inline token 形式漏到行内流
 * (如 "<div class=\"x\">")——这些标签按**字面文本**保留(与 html:false 时代行为一致,
 * 防止文档保存时标签被静默剥离);仅非块级的未白名单行内标签(如 <span>)做"标签剥离"。
 */
const BLOCK_HTML_TAGS = new Set([
  "address", "article", "aside", "base", "basefont", "blockquote", "body", "caption",
  "center", "col", "colgroup", "dd", "details", "dialog", "dir", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "frame", "frameset",
  "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hr", "html", "iframe",
  "legend", "li", "link", "main", "menu", "menuitem", "nav", "noframes", "ol",
  "optgroup", "option", "p", "param", "pre", "script", "search", "section", "style",
  "summary", "table", "tbody", "td", "textarea", "tfoot", "th", "thead", "title",
  "tr", "track", "ul",
]);

function isBlockLevelHtmlTag(trimmed: string): boolean {
  const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(trimmed);
  return !!m && BLOCK_HTML_TAGS.has(m[2].toLowerCase());
}

/** 默认实例:GFM 段内换行(即换行),供既有引用平滑过渡(E8:开启编辑管线 HTML 白名单) */
const md = createMarkdownIt({ breaks: true, html: true, htmlBlockDisabled: true });

/** CommonMark 实例(懒创建缓存,仅 commonmark 设置的用户使用) */
let commonmarkInstance: MarkdownIt | null = null;

/**
 * 按段内换行语义获取 markdown-it 实例(分屏预览等渲染方使用)。
 * @param breaks true=GFM(默认);false=CommonMark
 */
export function getMarkdownIt(breaks: boolean): MarkdownIt {
  if (breaks) return md;
  if (!commonmarkInstance) {
    commonmarkInstance = createMarkdownIt({ breaks: false, html: true, htmlBlockDisabled: true });
  }
  return commonmarkInstance;
}

/** 解析选项:段内换行语义覆盖(未显式传入时读 settings.paragraphBreaks) */
export interface ParseOptions {
  /** true=GFM 即换行;false=CommonMark;缺省读 settings */
  breaks?: boolean;
}

function effectiveBreaks(opts?: ParseOptions): boolean {
  if (opts?.breaks !== undefined) return opts.breaks;
  // auto-pair.ts 已有 getState 读取先例(插件无法订阅 React 状态,取值时读最新)
  return useSettingsStore.getState().paragraphBreaks !== "commonmark";
}

/**
 * 当前解析会话的段内换行语义(模块级上下文)。
 * 解析为同步过程:入口(markdownToDoc / markdownToInline / parseInline)设置,
 * 深层函数(softbreak 映射等)读取;无异步,无竞态。
 */
let activeBreaks = true;

// ─── 公开 API ──────────────────────────────────────────────

export function markdownToDoc(markdown: string, opts?: ParseOptions): Node {
  activeBreaks = effectiveBreaks(opts);
  const inst = getMarkdownIt(activeBreaks);
  const env: Record<string, unknown> = {};
  const rawTokens = inst.parse(markdown, env);
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

export function markdownToInline(markdown: string, opts?: ParseOptions): Node[] {
  activeBreaks = effectiveBreaks(opts);
  const inst = getMarkdownIt(activeBreaks);
  const rawTokens = inst.parseInline(markdown, {});
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
      // 冲刷当前累积的 inline 内容为段落（E15：任务项内多段落不再合并）
      const flushParagraph = () => {
        if (content) {
          childBlocks.push(schema.nodes.paragraph.create(null, parseInline(content)));
          content = "";
        }
      };
      i++;
      // 收集 inline 内容和嵌套的 task_list
      while (i < tokens.length && tokens[i].type !== "task_item_close") {
        if (tokens[i].type === "inline") {
          content += tokens[i].content;
        } else if (tokens[i].type === "task_list_open") {
          flushParagraph();
          // 递归解析嵌套的任务列表
          const childResult = parseTaskList(tokens, i);
          childBlocks.push(childResult.node);
          i = childResult.nextIndex;
          continue; // i 已被 parseTaskList 更新，跳过下面的 i++
        } else if (tokens[i].type === "paragraph_open") {
          // E15：嵌套段落开始（首个 inline 无段落包裹，后续段落有）
          flushParagraph();
        } else if (tokens[i].type === "paragraph_close") {
          flushParagraph();
        } else {
          // E15：任务项内嵌套的普通列表/代码块等块级 token
          // （task-list-plugin 已将缩进续行解析为子块 token 插入）
          const sub = parseBlockToken(tokens, i, tokens.length);
          if (sub && sub.nextIndex > i) {
            flushParagraph();
            childBlocks.push(sub.node);
            if (sub.extraNodes?.length) childBlocks.push(...sub.extraNodes);
            i = sub.nextIndex;
            continue;
          }
        }
        i++;
      }
      flushParagraph();
      // 跳过 task_item_close
      if (i < tokens.length && tokens[i].type === "task_item_close") i++;

      // task_item 的 content 为 "paragraph block*"，首块必须是段落；
      // 无任何内容时空段落占位
      const children =
        childBlocks.length > 0
          ? childBlocks
          : [schema.nodes.paragraph.create(null, parseInline(content))];
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
// E15：footnote_definition 内容模型为 block+，多段落/块级内容逐块解析不再压平

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
      // E15：逐块收集 footnote_open 到 footnote_close 之间的内容
      const blocks: Node[] = [];
      i++;
      while (i < tokens.length && tokens[i].type !== "footnote_close") {
        // 跳过 footnote_anchor（markdown-it 内部的回链标记）与段落边界 token
        // （paragraph 交给 parseBlockToken 整体组装）
        if (tokens[i].type === "footnote_anchor" || tokens[i].type === "paragraph_open" || tokens[i].type === "paragraph_close") {
          i++;
          continue;
        }
        if (tokens[i].type === "inline") {
          // markdown-it-footnote 的单行定义可能直接给出 inline（无段落包裹）
          blocks.push(schema.nodes.paragraph.create(null, parseInline(tokens[i].content)));
          i++;
          continue;
        }
        // 其余块级 token（段落、代码块、列表等）递归解析
        const sub = parseBlockToken(tokens, i, tokens.length);
        if (sub && sub.nextIndex > i) {
          blocks.push(sub.node);
          if (sub.extraNodes?.length) blocks.push(...sub.extraNodes);
          i = sub.nextIndex;
          continue;
        }
        i++;
      }
      // 跳过 footnote_close
      if (i < tokens.length && tokens[i].type === "footnote_close") i++;

      // block+ 至少一个块：空脚注用空段落占位
      const content = blocks.length > 0 ? blocks : [schema.nodes.paragraph.create()];
      defs.push(schema.nodes.footnote_definition.create({ label }, content));
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

/**
 * E8(v0.9.3):白名单 HTML 标签 → 对应 mark。
 * <u> → underline(Markdown 无原生下划线语法);<sub>/<sup>/<mark> → 既有 mark。
 */
function htmlTagMark(tag: string): Mark {
  switch (tag) {
    case "u": return schema.mark("underline");
    case "sub": return schema.mark("subscript");
    case "sup": return schema.mark("superscript");
    default: return schema.mark("mark");
  }
}

function parseInline(text: string, inTableCell = false): Node[] {
  if (!text) return [];
  const rawTokens = getMarkdownIt(activeBreaks).parseInline(text, {});
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
  // E8(v0.9.3):html_inline 白名单开启标签栈——<u>内容</u> 中间的内容携带对应 mark。
  // 仅 text 节点可携带 mark(schema 中其他 inline 节点 marks:""),出栈直接丢弃。
  const htmlMarkStack: Mark[] = [];
  let i = 0;

  while (i < tokens.length) {
    const t = tokens[i];

    // E8(v0.9.3):行内 HTML 白名单分支
    // - <br> → hard_break;<u>/<sub>/<sup>/<mark> 开闭标签 → mark 栈;
    // - 其余标签(含带属性形式)剥离,包裹的内容随 text token 自然保留;
    // - 白名单判定与渲染层(INLINE_HTML_WHITELIST_RE)一致,分屏预览与 PM 结构不漂移
    if (t.type === "html_inline") {
      const content = t.content || "";
      const trimmed = content.trim();
      if (/^<br\s*\/?>$/i.test(trimmed)) {
        nodes.push(schema.nodes.hard_break.create());
      } else {
        const open = /^<(u|sub|sup|mark)\s*>$/i.exec(trimmed);
        if (open) {
          htmlMarkStack.push(htmlTagMark(open[1].toLowerCase()));
        } else if (/^<\/(u|sub|sup|mark)\s*>$/i.test(trimmed)) {
          htmlMarkStack.pop();
        } else if (isBlockLevelHtmlTag(trimmed)) {
          // 块级标签:字面文本保留(编辑器内可见原文,保存不丢)
          nodes.push(schema.text(content, htmlMarkStack.length ? htmlMarkStack.slice() : undefined));
        }
        // 其余(非块级未白名单):标签剥离,包裹的内容随 text token 自然保留
      }
      i++; continue;
    }

    if (t.type === "text") {
      // 跳过空文本节点（ProseMirror 不允许空文本节点）
      if (t.content) {
        // v0.8.0 修复 P0-1：表格单元格内的换行由 serializer 写成 <br>（真实换行
        // "  \n" 会截断 GFM 表格行）。md 配置 html:false，<br> 落在 text token 里，
        // 此处仅在表格单元格上下文把它还原为 hard_break，保证表格内换行往返保真。
        // （E8 开启 html:true 后 <br> 走上方 html_inline 分支，本分支保留兜底。）
        if (inTableCell && /<br\s*\/?>/i.test(t.content)) {
          const segs = t.content.split(/<br\s*\/?>/gi);
          segs.forEach((seg, sIdx) => {
            if (sIdx > 0) nodes.push(schema.nodes.hard_break.create());
            if (seg) nodes.push(schema.text(seg, htmlMarkStack.length ? htmlMarkStack.slice() : undefined));
          });
        } else {
          nodes.push(schema.text(t.content, htmlMarkStack.length ? htmlMarkStack.slice() : undefined));
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
      // emoji 是文本形态节点,允许携带 mark(E8:html 白名单栈穿透)
      if (shortcode) nodes.push(schema.text(shortcode, htmlMarkStack.length ? htmlMarkStack.slice() : undefined));
      i++; continue;
    }
    if (t.type === "hardbreak") { nodes.push(schema.nodes.hard_break.create()); i++; continue; }
    // 段内单换行(softbreak)按设置分派(E14,v0.9.2):
    // - GFM(默认):hard_break 节点,与 serializer "  \n" 互逆,往返保真(v0.8.0 WP5 修复6)
    // - CommonMark:同段空格(渲染语义);"  \n" 硬换行仍走 hardbreak 分支不受影响
    if (t.type === "softbreak") {
      if (activeBreaks) {
        nodes.push(schema.nodes.hard_break.create());
      } else {
        nodes.push(schema.text(" ", htmlMarkStack.length ? htmlMarkStack.slice() : undefined));
      }
      i++; continue;
    }
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
      // E8(v0.9.3):外层 html 白名单栈穿透到内层节点(<u>**x**</u> 双重包裹场景)。
      // 仅 text 节点可携带 mark(math_inline 等节点 marks:"" 不允许)
      const htmlWrapped =
        htmlMarkStack.length > 0
          ? innerNodes.map((n) => (n.isText ? n.mark([...n.marks, ...htmlMarkStack]) : n))
          : innerNodes;
      if (markType === "link") {
        const href = getAttr(t, "href") || "";
        const title = getAttr(t, "title") || "";
        // v0.7.3 改进6(S2)：危险 scheme 拒绝 → 保留文本但不渲染为可点击链接
        const safeHref = sanitizeLinkHref(href);
        if (safeHref) {
          nodes.push(...htmlWrapped.map((n) => n.mark([...n.marks, schema.mark("link", { href: safeHref, title })])));
        } else {
          nodes.push(...htmlWrapped);
        }
      } else if (markType === "strong") {
        nodes.push(...htmlWrapped.map((n) => n.mark([...n.marks, schema.mark("strong")])));
      } else if (markType === "em") {
        nodes.push(...htmlWrapped.map((n) => n.mark([...n.marks, schema.mark("em")])));
      } else if (markType === "s") {
        nodes.push(...htmlWrapped.map((n) => n.mark([...n.marks, schema.mark("strike")])));
      } else if (markType === "mark") {
        // 高亮标记 ==text==
        nodes.push(...htmlWrapped.map((n) => n.mark([...n.marks, schema.mark("mark")])));
      } else if (markType === "sub") {
        // 下标 ~sub~
        nodes.push(...htmlWrapped.map((n) => n.mark([...n.marks, schema.mark("subscript")])));
      } else if (markType === "sup") {
        // 上标 ^sup^
        nodes.push(...htmlWrapped.map((n) => n.mark([...n.marks, schema.mark("superscript")])));
      } else {
        nodes.push(...htmlWrapped);
      }
      continue;
    }

    if (t.type === "image") {
      // E11a(v0.9.3):alt 支持 Typora 风格尺寸后缀 ![alt|300](src) → alt + width
      const rawAlt = getAttr(t, "alt") || t.content || "";
      let alt = rawAlt;
      let width: number | null = null;
      const wMatch = /^(.*)\|(\d+)$/.exec(rawAlt);
      if (wMatch) {
        alt = wMatch[1];
        width = Number(wMatch[2]);
      }
      nodes.push(schema.nodes.image.create({
        src: getAttr(t, "src") || "",
        alt,
        title: getAttr(t, "title") || "",
        width,
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
