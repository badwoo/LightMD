/**
 * src/core/unified/parse.ts —— markdown-it token 流 → `MdNode[]`（B1 树构建）。
 *
 * 设计稿 §2.3 的核心决策：**不自己写解析器**。
 * 构建 = `createMarkdownIt` 工厂 + 现有插件 → token 流 → `MdNode[]`，
 * 转换器是把 `exportBlocks.ts` 的 token→Block 逻辑扩展为"保留 span / lines / raw"。
 *
 * ## 三条输出（一次 parse 全部产出，避免重复解析）
 *
 * 1. `tree`：带源码区间的语义树（四出口共用的单一事实源）
 * 2. `spm`：块/行/偏移双向索引（分屏对齐、搜索 offsetMap、撤销锚点共用）
 * 3. `unknownTokens`：未能映射的 token 类型（沿用 exportBlocks 的"绝不静默丢内容"机制）
 *
 * ## 行区间口径（硬约定，模型层测试锁死）
 *
 * `token.map` 是 markdown-it 的 `[startLine, endLine)`（endLine 是"末行 + 1"）。
 * `MdNode.lines` 规定 `{ start, end }` 且 **end 是块末行（含）** —— 即 `map[1] - 1`。
 * 换算在 `linesOfToken()` 一处完成，其他代码不得各自换算（口径分裂的根源）。
 *
 * ## 与 parser.ts 的关系（重要，别混）
 *
 * 本文件**不替代** `markdownToDoc`。B2 阶段 `markdownToDoc` 仍走既有路径
 * （设计稿 §3.3 B2：PmSync 暂用"tree→markdown-it 二次 parse 的既有 parser 路径"过渡），
 * 只有 `docToMarkdown` 的**内部**改为 tree 出口。这样 PM 面零行为变化，
 * 而写回链路立刻获得 span 级别的保真能力。
 */

import type MarkdownIt from "markdown-it";
import { createMarkdownIt } from "../markdown/parser";
import { collectHeadings, type TocHeading } from "../markdown/heading-anchor";
import { STRUCTURAL_TOKENS } from "../../utils/exportBlocks";

/**
 * 该 token 是否应计入 `unknownTokens`（"未能映射"上报）。
 *
 * 口径与 `exportBlocks.parseBlockTokensDetailed` 的 `markUnknown` 一致：
 * - `*_close`：配对标记，由对应 open 处理 → 不计
 * - `STRUCTURAL_TOKENS`（脚注块/inline/text/换行等结构类）→ 不计
 * 其余计入（如未知插件产出的新块类型）。
 */
function isUnknownToken(type: string): boolean {
  if (type.endsWith("_close")) return false;
  if (STRUCTURAL_TOKENS.has(type)) return false;
  return true;
}
import { parseImageSuffix } from "./imageSuffix";
import type { InlineNode, MdNode, MdRaw, MdSpan, NodeKind, SourcePosMap } from "./model";

// ────────────────────────────────────────────────────────────────
// markdown-it token 的最小结构（与 exportBlocks 的 Token 同形）
// ────────────────────────────────────────────────────────────────

interface Tk {
  type: string;
  tag: string;
  attrs: Array<[string, string]> | null;
  nesting: number;
  level: number;
  children: Tk[] | null;
  content: string;
  markup: string;
  info: string;
  block: boolean;
  hidden: boolean;
  map: [number, number] | null;
  meta: Record<string, unknown> | null;
}

function attr(t: Tk, name: string): string | null {
  if (!t.attrs) return null;
  const f = t.attrs.find(([k]) => k === name);
  return f ? f[1] : null;
}

// ────────────────────────────────────────────────────────────────
// 解析选项与输出
// ────────────────────────────────────────────────────────────────

export interface UnifiedParseOptions {
  /** 段内换行语义：true=GFM（默认，读爱设置）；false=CommonMark */
  breaks?: boolean;
  /** 预建的 markdown-it 实例（测试/复用；缺省按 breaks 取工厂实例） */
  mdInstance?: MarkdownIt;
}

export interface UnifiedParseResult {
  tree: MdNode[];
  /** 行首 offset 表（同时用于 span 计算与 spm） */
  lineStarts: number[];
  /** 源码总行数 */
  lineCount: number;
  spm: SourcePosMap;
  /** 未映射的 token 类型（去重；沿用 exportBlocks 的上报机制） */
  unknownTokens: string[];
  /** 标题列表（`[toc]` 节点与大纲共用；来自 heading-anchor 插件的 `env.__headings`） */
  headings: TocHeading[];
  /** 文档级 raw 标记（尾部空行数等） */
  raw: MdRaw;
}

// ────────────────────────────────────────────────────────────────
// 行/偏移换算（唯一换算点）
// ────────────────────────────────────────────────────────────────

/** 源码 → 行首 offset 表（UTF-16 偏移；行数 = split("\n").length） */
export function buildLineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

/** 行号（0 基）→ 该行首 offset；越界钳到 [0, source.length] */
function offsetOfLineFrom(lineStarts: number[], line: number, sourceLen: number): number {
  if (line <= 0) return 0;
  if (line >= lineStarts.length) return sourceLen;
  return lineStarts[line]!;
}

/**
 * token.map → `MdNode.lines`（**end 转成"末行含"**）。
 *
 * map 缺失（footnote_open / dt_open 等）时返回 null，由调用方按上下文推导。
 */
function linesOfToken(map: [number, number] | null, lineCount: number): { start: number; end: number } | null {
  if (!map) return null;
  const start = Math.max(0, map[0]);
  // map[1] 是"末行 + 1"；MdNode.lines.end 是"末行（含）" → 减 1
  const end = Math.max(start, Math.min(lineCount - 1, map[1] - 1));
  return { start, end };
}

/** 由行区间推字符区间 */
function spanOfLines(
  lines: { start: number; end: number },
  lineStarts: number[],
  source: string,
): MdSpan {
  const start = offsetOfLineFrom(lineStarts, lines.start, source.length);
  // 末行末尾 = 下一行首（若无下一行则到源码尾）；再剥掉行尾换行符
  const nextStart = offsetOfLineFrom(lineStarts, lines.end + 1, source.length);
  let end = nextStart;
  if (end > start && source[end - 1] === "\n") end -= 1;
  if (end > start && source[end - 1] === "\r") end -= 1;
  return { start: Math.min(start, source.length), end: Math.min(end, source.length) };
}

// ────────────────────────────────────────────────────────────────
// 行内 token → InlineNode[]
// ────────────────────────────────────────────────────────────────

interface MarkStack {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  mark?: boolean;
  sub?: boolean;
  sup?: boolean;
  href?: string;
}

function inlineFromTokens(
  children: Tk[],
  lineStarts: number[],
  source: string,
  /** 段内换行语义：gfm(true)=裸换行即 hardbreak；commonmark(false)=空格 */
  breaks: boolean,
): InlineNode[] {
  const out: InlineNode[] = [];
  const stack: MarkStack = {};

  const marksOf = (): InlineNode["marks"] | undefined => {
    // 只复制**已激活**的标记（避免每个 node 都带一堆 false）
    if (
      !stack.bold && !stack.italic && !stack.strike &&
      !stack.mark && !stack.sub && !stack.sup && stack.href === undefined
    ) {
      return undefined;
    }
    const m: NonNullable<InlineNode["marks"]> = {};
    if (stack.bold) m.bold = true;
    if (stack.italic) m.italic = true;
    if (stack.strike) m.strike = true;
    if (stack.mark) m.mark = true;
    if (stack.sub) m.sub = true;
    if (stack.sup) m.sup = true;
    if (stack.href !== undefined) m.href = stack.href;
    return m;
  };

  for (const t of children) {
    switch (t.type) {
      case "text":
      case "text_special":
        if (t.content) out.push({ text: t.content, kind: "text", marks: marksOf() });
        break;
      case "emoji":
        // 本项目保留 shortcode 原文（v0.9.0 D9：doc 层不做 unicode 转换）
        if (t.content) out.push({ text: t.content, kind: "text", marks: marksOf() });
        break;
      case "code_inline": {
        const m = marksOf() || {};
        m.code = true;
        out.push({ text: t.content || "", kind: "text", marks: m });
        break;
      }
      case "math_inline":
        out.push({
          text: t.content || "",
          kind: "mathInline",
          payload: t.content || "",
          marks: marksOf(),
        });
        break;
      case "image": {
        const raw = t.content || "";
        const parsed = parseImageSuffix(raw);
        out.push({
          // text 存"原始 content"（含后缀），保证 serialize 能原样写回；
          // 结构化信息放 payload/marks，供渲染出口直接消费
          text: raw,
          kind: "image",
          payload: attr(t, "src") || "",
          marks: marksOf(),
        });
        void parsed;
        break;
      }
      case "footnote_ref": {
        const label = (t.meta as { label?: string } | null)?.label ?? "";
        out.push({ text: `[^${label}]`, kind: "text", payload: String(label), marks: marksOf() });
        break;
      }
      case "softbreak":
        // v0.17.0 B1：**必须在模型层分派**（与 parser.ts 的 activeBreaks 同口径）。
        //
        // 关键实测：markdown-it 的 `breaks` 选项只在**渲染期**
        // （`renderer.rules.softbreak`）生效，**解析期 token 类型相同**（恒为 softbreak）。
        // 本项目的语义分派发生在 PM 解析层（parser.ts 读 settings 决定映射成
        // hard_break 还是空格文本）。UnifiedDoc 作为四出口的共同事实源，
        // 必须在这里做出同样的分派 —— 否则 gfm/commonmark 两种模式下 tree 完全相同，
        // 「缓存键含 paragraphBreaks」就失去意义，且预览出口会拿到错误语义。
        if (breaks) {
          out.push({ text: "\n", kind: "softbreak" });
        } else {
          out.push({ text: " ", kind: "text" });
        }
        break;
      case "hardbreak":
        out.push({ text: "\n", kind: "hardbreak" });
        break;
      case "strong_open":
        stack.bold = true;
        break;
      case "strong_close":
        stack.bold = false;
        break;
      case "em_open":
        stack.italic = true;
        break;
      case "em_close":
        stack.italic = false;
        break;
      case "s_open":
        stack.strike = true;
        break;
      case "s_close":
        stack.strike = false;
        break;
      case "mark_open":
        stack.mark = true;
        break;
      case "mark_close":
        stack.mark = false;
        break;
      case "sub_open":
        stack.sub = true;
        break;
      case "sub_close":
        stack.sub = false;
        break;
      case "sup_open":
        stack.sup = true;
        break;
      case "sup_close":
        stack.sup = false;
        break;
      case "link_open":
        stack.href = attr(t, "href") || "";
        break;
      case "link_close":
        stack.href = undefined;
        break;
      case "html_inline": {
        // 白名单行内标签与注释：渲染出口需要原文（`<u>` 不能丢），
        // 故整段作为文本原子保留（kind=text），由 serialize 判断是否原样写回
        const trimmed = (t.content || "").trim();
        if (/^<!--[\s\S]*-->$/.test(trimmed)) {
          out.push({ text: trimmed, kind: "text", marks: { ...(marksOf() || {}), } });
        } else if (/^<\/?(?:u|br|sub|sup|mark)\s*\/?>$/i.test(trimmed)) {
          out.push({ text: trimmed, kind: "text", marks: marksOf() });
        } else {
          // 非白名单：标签剥离、内容由后续 text token 承载 —— 与 PM 解析层同口径
        }
        break;
      }
      default:
        // 其它行内 token（如 footnote_anchor）不产出节点
        break;
    }
  }
  void lineStarts;
  void source;
  return out;
}

// ────────────────────────────────────────────────────────────────
// 块级遍历
// ────────────────────────────────────────────────────────────────

interface Ctx {
  source: string;
  lineStarts: number[];
  lineCount: number;
  tokens: Tk[];
  unknown: Set<string>;
  headings: TocHeading[];
  /** 段内换行语义（gfm=true）—— 决定 softbreak 映射成 break 还是空格 */
  breaks: boolean;
}

/** 找配对 close token 的索引（`startIdx` 是 open token） */
function findClose(tokens: Tk[], startIdx: number, openType: string, closeType: string): number {
  let depth = 0;
  for (let i = startIdx; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type === openType) depth++;
    else if (t.type === closeType) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return tokens.length - 1;
}

/** 该区间内第一个 inline token 的 children（heading/paragraph 的文本源） */
function firstInlineChildren(tokens: Tk[], from: number, to: number): Tk[] | null {
  for (let i = from; i <= to && i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type === "inline" && t.children) return t.children;
  }
  return null;
}

/**
 * 由 token 的 map（或其子 token 的 map）推 lines。
 *
 * 为什么需要：部分容器 token 自身无 map（footnote_open / dt_open 的 map 是
 * `[n, n]` 退化形态），但**内部段落有 map** —— 用内部 map 的并集更准确，
 * 也省掉 parser.ts 那套"源码行扫描 defStarts"的特判。
 */
function deriveLines(ctx: Ctx, fromIdx: number, toIdx: number): { start: number; end: number } | null {
  let start = Infinity;
  let end = -Infinity;
  for (let i = fromIdx; i <= toIdx && i < ctx.tokens.length; i++) {
    const t = ctx.tokens[i]!;
    if (!t.map) continue;
    const l = linesOfToken(t.map, ctx.lineCount);
    if (!l) continue;
    start = Math.min(start, l.start);
    end = Math.max(end, l.end);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start, end };
}

function makeNode(
  ctx: Ctx,
  kind: NodeKind,
  lines: { start: number; end: number } | null,
  attrs: Record<string, unknown>,
  extra?: { children?: MdNode[]; inline?: InlineNode[]; raw?: MdRaw },
): MdNode {
  const ln = lines ?? { start: 0, end: 0 };
  return {
    kind,
    span: spanOfLines(ln, ctx.lineStarts, ctx.source),
    lines: ln,
    attrs,
    ...(extra?.children ? { children: extra.children } : {}),
    ...(extra?.inline ? { inline: extra.inline } : {}),
    ...(extra?.raw ? { raw: extra.raw } : {}),
  };
}

/** 解析一个列表（bullet / ordered / task），返回节点与"下一个未消费 token 索引" */
function parseList(ctx: Ctx, startIdx: number): { node: MdNode; next: number } {
  const openTok = ctx.tokens[startIdx]!;
  const kind: NodeKind =
    openTok.type === "ordered_list_open"
      ? "orderedList"
      : openTok.type === "task_list_open"
        ? "taskList"
        : "bulletList";
  const closeType =
    openTok.type === "ordered_list_open"
      ? "ordered_list_close"
      : openTok.type === "task_list_open"
        ? "task_list_close"
        : "bullet_list_close";
  const itemOpen = openTok.type === "task_list_open" ? "task_item_open" : "list_item_open";
  const itemClose = openTok.type === "task_list_open" ? "task_item_close" : "list_item_close";

  const closeIdx = findClose(ctx.tokens, startIdx, openTok.type, closeType);
  const items: MdNode[] = [];

  let i = startIdx + 1;
  while (i < closeIdx) {
    const t = ctx.tokens[i]!;
    if (t.type !== itemOpen) {
      i++;
      continue;
    }
    const itemEnd = findClose(ctx.tokens, i, itemOpen, itemClose);
    const lines = deriveLines(ctx, i, itemEnd);
    const attrs: Record<string, unknown> = {};
    const markup = t.markup || openTok.markup;
    if (markup) attrs.delim = markup;
    if (openTok.type === "ordered_list_open" && t.info) {
      const n = Number(t.info);
      if (Number.isFinite(n) && n > 0) attrs.order = n;
    }
    if (openTok.type === "task_list_open") {
      const raw = attr(t, "data-checked") ?? attr(t, "checked");
      attrs.checked = raw === "true" || raw === "1" || raw === "";
    }

    // 列表项内容：可能是 inline（紧列表）或 blocks（含段落/嵌套列表/表格…）
    const childBlocks: MdNode[] = [];
    let j = i + 1;
    while (j < itemEnd) {
      const child = ctx.tokens[j]!;
      if (child.type === "inline") {
        // 紧列表项的裸 inline（无 paragraph_open 包裹时会走到这里）
        const inline = inlineFromTokens(child.children || [], ctx.lineStarts, ctx.source, ctx.breaks);
        if (inline.length > 0) {
          const ln = linesOfToken(child.map, ctx.lineCount) ?? { start: lines?.start ?? 0, end: lines?.end ?? 0 };
          childBlocks.push(makeNode(ctx, "paragraph", ln, {}, { inline }));
        }
        j++;
        continue;
      }
      if (child.type === "paragraph_open") {
        const pEnd = findClose(ctx.tokens, j, "paragraph_open", "paragraph_close");
        const ln = deriveLines(ctx, j, pEnd) ?? { start: lines?.start ?? 0, end: lines?.end ?? 0 };
        childBlocks.push(
          makeNode(ctx, "paragraph", ln, {}, {
            inline: inlineFromTokens(firstInlineChildren(ctx.tokens, j, pEnd) || [], ctx.lineStarts, ctx.source, ctx.breaks),
          }),
        );
        j = pEnd + 1;
        continue;
      }
      if (
        child.type === "bullet_list_open" ||
        child.type === "ordered_list_open" ||
        child.type === "task_list_open"
      ) {
        const r = parseList(ctx, j);
        childBlocks.push(r.node);
        j = r.next;
        continue;
      }
      if (child.type === "blockquote_open") {
        const r = parseBlockquote(ctx, j);
        childBlocks.push(r.node);
        j = r.next;
        continue;
      }
      if (child.type === "table_open") {
        const r = parseTable(ctx, j);
        childBlocks.push(r.node);
        j = r.next;
        continue;
      }
      if (child.type === "dl_open") {
        const r = parseDefList(ctx, j);
        childBlocks.push(r.node);
        j = r.next;
        continue;
      }
      if (
        child.type === "fence" || child.type === "code_block" ||
        child.type === "math_block" || child.type === "hr" || child.type === "toc"
      ) {
        const node = leafNode(ctx, j);
        if (node) childBlocks.push(node);
        j++;
        continue;
      }
      j++;
    }

    items.push(makeNode(ctx, "paragraph" === openTok.type ? "paragraph" : "listItem" as NodeKind, lines, attrs, {
      children: childBlocks,
    }));
    i = itemEnd + 1;
  }

  const node = makeNode(ctx, kind, deriveLines(ctx, startIdx, closeIdx), {
    ...(openTok.type === "ordered_list_open"
      ? { order: Number(attr(openTok, "start") || 1) || 1, delim: openTok.markup === ")" ? ")" : "." }
      : {}),
    ...(openTok.type === "bullet_list_open" ? { delim: openTok.markup || "-" } : {}),
  }, { children: items });
  return { node, next: closeIdx + 1 };
}

function parseBlockquote(ctx: Ctx, startIdx: number): { node: MdNode; next: number } {
  const closeIdx = findClose(ctx.tokens, startIdx, "blockquote_open", "blockquote_close");
  const inner: Tk[] = [];
  let depth = 0;
  for (let i = startIdx; i <= closeIdx; i++) {
    const t = ctx.tokens[i]!;
    if (t.type === "blockquote_open") {
      depth++;
      if (depth === 1) continue; // 跳过最外层 open（内层保留）
    }
    if (t.type === "blockquote_close") {
      depth--;
      if (depth === 0) break;
    }
    inner.push(t);
  }
  const sub: Ctx = { ...ctx, tokens: inner, unknown: ctx.unknown };
  const children = parseTokenRange(sub, 0, inner.length, /* topLevel */ false);
  const node = makeNode(ctx, "blockquote", deriveLines(ctx, startIdx, closeIdx), {}, { children });
  return { node, next: closeIdx + 1 };
}

function parseTable(ctx: Ctx, startIdx: number): { node: MdNode; next: number } {
  const closeIdx = findClose(ctx.tokens, startIdx, "table_open", "table_close");
  interface Cell {
    inline: InlineNode[];
    header: boolean;
    align: string;
    colspan: number;
    rowspan: number;
  }
  const rows: Cell[][] = [];
  let curRow: Cell[] = [];
  let isHeader = false;
  let alignCol: string[] = [];
  let pending: { inline: InlineNode[]; header: boolean; align: string; colspan: number; rowspan: number } | null = null;

  for (let i = startIdx + 1; i < closeIdx; i++) {
    const t = ctx.tokens[i]!;
    if (t.type === "thead_open") { isHeader = true; continue; }
    if (t.type === "thead_close") { isHeader = false; continue; }
    if (t.type === "tbody_open" || t.type === "tbody_close") continue;
    if (t.type === "tr_open") { curRow = []; continue; }
    if (t.type === "tr_close") { if (curRow.length) rows.push(curRow); curRow = []; continue; }
    if (t.type === "th_open" || t.type === "td_open") {
      const style = attr(t, "style") || "";
      const m = /text-align\s*:\s*(left|center|right)/i.exec(style);
      const align = m ? m[1]!.toLowerCase() : "left";
      const col = curRow.length;
      if (alignCol.length <= col) alignCol[col] = align;
      const inline = inlineFromTokens(firstInlineChildren(ctx.tokens, i, Math.min(i + 3, closeIdx)) || [], ctx.lineStarts, ctx.source, ctx.breaks);
      pending = { inline, header: isHeader, align, colspan: 1, rowspan: 1 };
      continue;
    }
    if (t.type === "th_close" || t.type === "td_close") {
      if (pending) curRow.push(pending);
      pending = null;
      continue;
    }
  }
  if (curRow.length) rows.push(curRow);

  const node = makeNode(ctx, "table", deriveLines(ctx, startIdx, closeIdx), {
    /** 列对齐（由 th/td 的 style 推出；序列化用 raw.alignSyntax 保写法） */
    aligns: alignCol,
    /** 行 × 单元格（含 colspan/rowspan，来自格内 HTML 的 `<td colspan>`） */
    rows: rows.map((r) => r.map((c) => ({ inline: c.inline, header: c.header, colspan: c.colspan, rowspan: c.rowspan }))),
  });
  return { node, next: closeIdx + 1 };
}

function parseDefList(ctx: Ctx, startIdx: number): { node: MdNode; next: number } {
  const closeIdx = findClose(ctx.tokens, startIdx, "dl_open", "dl_close");
  const items: MdNode[] = [];
  let i = startIdx + 1;
  while (i < closeIdx) {
    const t = ctx.tokens[i]!;
    if (t.type === "dt_open") {
      const dtEnd = findClose(ctx.tokens, i, "dt_open", "dt_close");
      const termInline = inlineFromTokens(firstInlineChildren(ctx.tokens, i, dtEnd) || [], ctx.lineStarts, ctx.source, ctx.breaks);
      // 该 dt 之后连续的 dd 归属此术语
      const dds: MdNode[] = [];
      let j = dtEnd + 1;
      while (j < closeIdx && ctx.tokens[j]!.type === "dd_open") {
        const ddEnd = findClose(ctx.tokens, j, "dd_open", "dd_close");
        // dd 内是完整块级内容（**不拍平成 inline** —— 设计稿 §6.3 方案乙）
        const ddCtx: Ctx = { ...ctx, tokens: ctx.tokens.slice(j + 1, ddEnd), unknown: ctx.unknown };
        const ddChildren = parseTokenRange(ddCtx, 0, ddCtx.tokens.length, false);
        dds.push(
          makeNode(ctx, "definition_description", deriveLines(ctx, j, ddEnd), {}, { children: ddChildren }),
        );
        j = ddEnd + 1;
      }
      items.push(
        makeNode(ctx, "definition_term", deriveLines(ctx, i, dtEnd), {}, { inline: termInline }),
        ...dds,
      );
      i = j;
      continue;
    }
    i++;
  }
  return { node: makeNode(ctx, "defList", deriveLines(ctx, startIdx, closeIdx), { items }, { children: items }), next: closeIdx + 1 };
}

/** 叶块（fence / code_block / math_block / hr / toc） */
function leafNode(ctx: Ctx, idx: number): MdNode | null {
  const t = ctx.tokens[idx]!;
  const lines = linesOfToken(t.map, ctx.lineCount);
  switch (t.type) {
    case "fence":
    case "code_block": {
      // info 保留完整串（如 "js {highlight}"），language 取首词（与 serializer 同口径）
      const info = (t.info || "").trim();
      const language = info.split(/\s+/)[0] || "";
      const isMermaid = language === "mermaid";
      return makeNode(ctx, isMermaid ? "codeBlock" : "codeBlock", lines, {
        info,
        language,
        /** 围栏写法（``` / ~~~ 与长度）—— 保真用 */
        fenceChar: (t.markup || "```").charAt(0),
        fenceLen: (t.markup || "```").length,
      }, {
        inline: [{ text: t.content || "", kind: "text" }],
        raw: { delim: t.markup || undefined },
      });
    }
    case "math_block":
      return makeNode(ctx, "mathBlock", lines, { latex: t.content || "" }, { raw: { delim: t.markup || "$$" } });
    case "hr":
      return makeNode(ctx, "hr", lines, { markup: t.markup || "---" }, { raw: { delim: t.markup || undefined } });
    case "toc":
      return makeNode(ctx, "toc", lines, { headings: ctx.headings }, {});
    default:
      return null;
  }
}

// ────────────────────────────────────────────────────────────────
// 顶层遍历
// ────────────────────────────────────────────────────────────────

function parseTokenRange(ctx: Ctx, from: number, to: number, topLevel: boolean): MdNode[] {
  const nodes: MdNode[] = [];
  let i = from;
  while (i < to) {
    const t = ctx.tokens[i]!;

    // ── 容器：列表 ──
    if (t.type === "bullet_list_open" || t.type === "ordered_list_open" || t.type === "task_list_open") {
      const r = parseList(ctx, i);
      nodes.push(r.node);
      i = r.next;
      continue;
    }
    // ── 容器：引用 ──
    if (t.type === "blockquote_open") {
      const r = parseBlockquote(ctx, i);
      nodes.push(r.node);
      i = r.next;
      continue;
    }
    // ── 容器：表格 ──
    if (t.type === "table_open") {
      const r = parseTable(ctx, i);
      nodes.push(r.node);
      i = r.next;
      continue;
    }
    // ── 容器：定义列表 ──
    if (t.type === "dl_open") {
      const r = parseDefList(ctx, i);
      nodes.push(r.node);
      i = r.next;
      continue;
    }
    // ── 容器：脚注块（定义本体摊平后并入，`footnote` 节点承载定义）──
    if (t.type === "footnote_block_open") {
      const closeIdx = findClose(ctx.tokens, i, "footnote_block_open", "footnote_block_close");
      let j = i + 1;
      while (j < closeIdx) {
        const ft = ctx.tokens[j]!;
        if (ft.type !== "footnote_open") {
          j++;
          continue;
        }
        const fnEnd = findClose(ctx.tokens, j, "footnote_open", "footnote_close");
        // 标签：markdown-it-footnote 把 label 放在 footnote_open 的 meta，
        // 但实测 meta 为空 —— 从内部 footnote_ref 或 env 取不可靠，
        // 故回退到"按源码行扫描 `[^label]:`"（与 parser.ts:342-359 同源）。
        const inner: Tk[] = ctx.tokens.slice(j + 1, fnEnd);
        const innerCtx: Ctx = { ...ctx, tokens: inner, unknown: ctx.unknown };
        const children = parseTokenRange(innerCtx, 0, inner.length, false);
        const lines = deriveLines(ctx, j, fnEnd);
        const label = findFootnoteLabel(ctx, lines, j);
        nodes.push(
          makeNode(ctx, "footnote", lines, { label }, { children }),
        );
        j = fnEnd + 1;
      }
      i = closeIdx + 1;
      continue;
    }
    // ── 标题 ──
    if (t.type === "heading_open") {
      const hEnd = findClose(ctx.tokens, i, "heading_open", "heading_close");
      const lines = linesOfToken(t.map, ctx.lineCount);
      const level = parseInt((t.tag || "h1").slice(1), 10) || 1;
      // Setext：markup 是 `=` 或 `-`（ATX 是 `#`）
      const setext = t.markup === "=" || t.markup === "-";
      const inline = inlineFromTokens(firstInlineChildren(ctx.tokens, i, hEnd) || [], ctx.lineStarts, ctx.source, ctx.breaks);
      const trailing = lines && lines.end > lines.start ? 1 : 0;
      nodes.push(
        makeNode(ctx, "heading", lines, { level }, {
          inline,
          raw: {
            setext,
            delim: t.markup || undefined,
            trailingBlankLines: trailing,
          },
        }),
      );
      i = hEnd + 1;
      continue;
    }
    // ── 段落 ──
    if (t.type === "paragraph_open") {
      const pEnd = findClose(ctx.tokens, i, "paragraph_open", "paragraph_close");
      const lines = deriveLines(ctx, i, pEnd);
      nodes.push(
        makeNode(ctx, "paragraph", lines, {}, {
          inline: inlineFromTokens(firstInlineChildren(ctx.tokens, i, pEnd) || [], ctx.lineStarts, ctx.source, ctx.breaks),
        }),
      );
      i = pEnd + 1;
      continue;
    }
    // ── 叶块 ──
    if (t.type === "fence" || t.type === "code_block" || t.type === "math_block" || t.type === "hr" || t.type === "toc") {
      const node = leafNode(ctx, i);
      if (node) nodes.push(node);
      i++;
      continue;
    }
    // ── 未知 token（绝不静默丢内容）──
    if (!STRUCTURAL_TOKENS.has(t.type) && isUnknownToken(t.type)) {
      ctx.unknown.add(t.type);
    }
    i++;
  }
  void topLevel;
  return nodes;
}

/** 脚注定义标签：从该区块的源码行扫描 `[^label]:`（markdown-it 不把 label 进 token） */
function findFootnoteLabel(
  ctx: Ctx,
  lines: { start: number; end: number } | null,
  _idx: number,
): string {
  if (!lines) return "";
  const srcLines = ctx.source.split("\n");
  for (let ln = lines.start; ln <= lines.end && ln < srcLines.length; ln++) {
    const m = /^\[\^([^\]]+)\]:/.exec(srcLines[ln] || "");
    if (m) return m[1]!;
  }
  // 回退：向后扫整个文档（脚注块 map 缺失时可能落到 0）
  for (let ln = 0; ln < srcLines.length; ln++) {
    const m = /^\[\^([^\]]+)\]:/.exec(srcLines[ln] || "");
    if (m) return m[1]!;
  }
  return "";
}

// ────────────────────────────────────────────────────────────────
// SourcePosMap
// ────────────────────────────────────────────────────────────────

/**
 * 构建 spm。
 *
 * `blockStartLines` 必须与 `topLevelBlockStartLines`（renderPipeline.ts:282）
 * **逐项一致** —— 那是 `data-src-line` 贴标的来源，两套口径混用会让 iframe 贴标
 * 整体错位（模型层 test 用真实 renderPipeline 做对照断言，锁死这条）。
 *
 * 因此本函数不复用"tree 的顶层节点行号"，而是**重新按 token 口径**计算：
 * `level === 0 && (nesting===1 || nesting===0) && map` —— 与旧实现完全同源。
 */
function buildSpm(source: string, tokens: Tk[], lineStarts: number[], lineCount: number): SourcePosMap {
  const blockStartLines: number[] = [];
  for (const token of tokens) {
    if (token.level !== 0) continue;
    if (!token.map || token.map.length < 1) continue;
    const isOpener = token.nesting === 1;
    const isSelfClosingBlock = token.nesting === 0;
    if (!isOpener && !isSelfClosingBlock) continue;
    const start = token.map[0];
    if (typeof start !== "number" || !Number.isFinite(start)) continue;
    blockStartLines.push(start);
  }

  // 一次 O(n) 预计算：行首 offset 表已经是 lineStarts，直接复用
  return {
    blockStartLines,
    blockAtOffset(off: number): number {
      if (off < 0) return -1;
      // 顶层块按源码起始 offset 升序；二分找"最后一个 start <= off"
      if (blockStartLines.length === 0) return -1;
      let lo = 0;
      let hi = blockStartLines.length - 1;
      let ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const startOff = offsetOfLineFrom(lineStarts, blockStartLines[mid]!, source.length);
        if (startOff <= off) {
          ans = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return ans;
    },
    lineAtOffset(off: number): number {
      if (off <= 0) return 0;
      let lo = 0;
      let hi = lineStarts.length - 1;
      let ans = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (lineStarts[mid]! <= off) {
          ans = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return ans;
    },
    offsetOfLine(line: number): number {
      return offsetOfLineFrom(lineStarts, line, source.length);
    },
  };
  void lineCount;
}

// ────────────────────────────────────────────────────────────────
// 公开入口
// ────────────────────────────────────────────────────────────────

/**
 * 解析 Markdown → `UnifiedParseResult`。
 *
 * 一次 parse 同时产出 tree / spm / unknownTokens / headings —— 四个消费方
 * 不再各自解析（现状是 `markdownToDoc` / `renderMarkdownHtml` / `exportBlocks` /
 * `docToMarkdown` 各解析一遍，这是四出口漂移的根源）。
 */
export function parseUnified(sourceRaw: string, opts?: UnifiedParseOptions): UnifiedParseResult {
  // CRLF 契约（设计稿 §3.2 A2）：载入侧统一归一化为 \n，写盘时由 eolPreserve 还原。
  // 四个出口都在内存层用 \n，故模型层必须先归一化 —— 否则 span 偏移与
  // markdown-it 的 token.map（按 \n 计行）会错位，且往返会漏 \r。
  const source = sourceRaw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const md =
    opts?.mdInstance ??
    createMarkdownIt({ breaks: opts?.breaks ?? true, html: true, htmlBlockDisabled: true });

  const env: Record<string, unknown> = {};
  const rawTokens = md.parse(source, env) as unknown as Tk[];
  const headings =
    (env.__headings as TocHeading[] | undefined) || collectHeadings(rawTokens as never);

  const lineStarts = buildLineStarts(source);
  const lineCount = lineStarts.length;

  const unknown = new Set<string>();
  const breaks = opts?.breaks ?? true;
  const ctx: Ctx = { source, lineStarts, lineCount, tokens: rawTokens, unknown, headings, breaks };
  const tree = parseTokenRange(ctx, 0, rawTokens.length, true);

  // ── 脚注节点按源码行序插回正确位置（关键修正）──
  //
  // markdown-it-footnote 把 `footnote_block` 统一放到 token 流**末尾**
  // （无论定义写在源码哪里）。若照 token 顺序建树，脚注定义会被挪到文末 ——
  // 那是**内容位置失真**（fuzz 实测 doc#3 的 `[^x]: ...` 从第 3 行被搬到最后）。
  //
  // 修正：取出所有 footnote 节点，按 `lines.start` 归位到 tree 的正确索引。
  const footnotes = tree.filter((n) => n.kind === "footnote");
  if (footnotes.length > 0) {
    const others = tree.filter((n) => n.kind !== "footnote");
    for (const fn of footnotes) {
      // 找到第一个起始行 > 该脚注起始行的块，插在它前面
      let at = others.findIndex((n) => n.lines.start > fn.lines.start);
      if (at < 0) at = others.length;
      others.splice(at, 0, fn);
    }
    tree.length = 0;
    tree.push(...others);
  }

  // 文档级头部空行数（首个块之前的空行）—— 与 trailingBlankLines 对称的保真项
  let headBlankLines = 0;
  for (const line of source.split("\n")) {
    if ((line || "").trim()) break;
    headBlankLines++;
  }
  // "整篇皆空"时上面会把所有行都算成头部空行，此时头尾不该重复计
  const onlyBlank = source.split("\n").every((l) => !(l || "").trim());

  // 文档级尾部空行数（保真用：末尾 N 个空行要写回 N 个）
  const srcLines = source.split("\n");
  let trailingBlankLines = 0;
  for (let i = srcLines.length - 1; i >= 0; i--) {
    if ((srcLines[i] || "").trim()) break;
    trailingBlankLines++;
  }
  // "以 \n 结尾"本身不算一个空行（`a\n` 的 tail 是 0，`a\n\n` 是 1）
  if (trailingBlankLines > 0) trailingBlankLines -= 1;

  return {
    tree,
    lineStarts,
    lineCount,
    spm: buildSpm(source, rawTokens, lineStarts, lineCount),
    unknownTokens: [...unknown],
    headings,
    raw: {
      trailingBlankLines: onlyBlank ? 0 : trailingBlankLines,
      headBlankLines: onlyBlank ? 0 : headBlankLines,
    },
  };
}

/** 顶层块起始行（= 旧 `topLevelBlockStartLines` 的模型化产出，供 B3 切换用） */
export function topLevelBlockStartLinesFromSource(source: string, opts?: UnifiedParseOptions): number[] {
  return parseUnified(source, opts).spm.blockStartLines;
}
