/**
 * src/core/unified/serialize.ts —— `MdNode[]` → Markdown 源码（B2 序列化收敛）。
 *
 * 这是 B 线的核心：`md → tree → md` 闭环的**右半边**。
 *
 * ## 两条路径（设计稿 §3.3 B2 的规则）
 *
 * 1. **未编辑块 → 原文切片**：`span` 内源码未变 → 直接 `source.slice(span)`。
 *    判定用 **span + revision** 比对，不再用 `blockSourceMap` 的 WeakMap 对象同一性
 *    —— 这是消除既有痛点的关键（设计稿 §3.3 B1「PM 重建 doc 导致 WeakMap 全 miss」）。
 * 2. **编辑过的块 → 规范序列化**：走各 kind 的序列化分支，`raw.*` 决定输出形态
 *    （`raw.setext` 输出下划线、`raw.delim` 输出 `1)` / `~~~` / `*` 列表符）。
 *
 * ## 为什么原文切片优先
 *
 * 未编辑块的**唯一保真做法就是原文切片** —— 任何"规范化"都会改变用户写的字。
 * 设计稿 G5 的四项保真（Setext 段末空行 / 图片对齐 / dd 内块 / `1)` 分隔符）
 * 在未编辑路径上**天然保真**（原文进原文出），只有编辑过的块才需要按 `raw` 重建。
 *
 * ## 复用 serializer 的转义层（不抄第二份）
 *
 * 转义逻辑（`escapeText` / `inlineCodeWrap` / `escapeDest` / `escapeContinuationLines`）
 * 是 6 个版本反复调校的产物（处理 `*`/`_`/`$`/`==`/`~`/`^`/`|`/续行行首 等形态）。
 * 本文件 **import 复用**，绝不复制 —— 两份转义必然漂移，那是"修一个坏一个"的经典来源。
 */

import {
  escapeText,
  escapeDest,
  escapeTitle,
  fenceBlock,
  stripZwsp,
  MARK_OUTER_ORDER,
} from "../markdown/serializer";
import type { InlineNode, MdNode, MdRaw } from "./model";

// ────────────────────────────────────────────────────────────────
// 行内序列化
// ────────────────────────────────────────────────────────────────

/** 把 InlineNode[] 的可见文本拼起来（供转义的 pairContext 用） */
function inlinePlainText(nodes: InlineNode[]): string {
  let out = "";
  for (const n of nodes) {
    if (n.kind === "image") out += n.text; // 图片原始 content 也算上下文
    else out += n.text;
  }
  return out;
}

/** 应用一个 mark 到文本（与 serializer.applyMark 同构，覆盖 unified 的 marks 形状） */
function applyMarks(text: string, marks: NonNullable<InlineNode["marks"]>, inTable: boolean): string {
  // 按 MARK_OUTER_ORDER 从外到内（与 serializer 一致，保证嵌套顺序稳定）
  const order: Array<[string, boolean | undefined]> = [
    ["underline", undefined], // 无 mark 字段（HTML 白名单走 inline text）
    ["strong", marks.bold],
    ["em", marks.italic],
    ["code", marks.code],
    ["strike", marks.strike],
    ["mark", marks.mark],
    ["subscript", marks.sub],
    ["superscript", marks.sup],
  ];
  let out = text;
  // 先按优先级 sort（数字小的在外层）
  const active = order
    .filter(([, on]) => on)
    .sort((a, b) => (MARK_OUTER_ORDER[a[0]] ?? 50) - (MARK_OUTER_ORDER[b[0]] ?? 50));
  for (const [name] of active) {
    switch (name) {
      case "strong":
        out = `**${out}**`;
        break;
      case "em":
        out = `*${out}*`;
        break;
      case "code": {
        // CommonMark 围栏：最长反引号段 +1；首尾反引号/双空格时补空格
        let inner = inTable ? out.replace(/\|/g, "\\|") : out;
        const longest = (inner.match(/`+/g) || []).reduce((a, b) => Math.max(a, b.length), 0);
        const fence = "`".repeat(longest + 1);
        if (inner.startsWith("`") || inner.endsWith("`") || (inner.startsWith(" ") && inner.endsWith(" "))) {
          inner = " " + inner + " ";
        }
        out = fence + inner + fence;
        break;
      }
      case "strike":
        out = `~~${out}~~`;
        break;
      case "mark":
        out = `==${out}==`;
        break;
      case "subscript":
        out = `~${out}~`;
        break;
      case "superscript":
        out = `^${out}^`;
        break;
      default:
        break;
    }
  }
  if (marks.href !== undefined) {
    out = `[${out}](${escapeDest(marks.href)})`;
  }
  return out;
}

/**
 * InlineNode[] → markdown 行内文本。
 *
 * @param context `"table"`：表格单元格内（`|` 需转义、换行写成 `<br>`）
 *                `"top"`：顶层段落（段末硬换行用两空格写法）
 */
export function inlineToSource(nodes: InlineNode[], context?: "table" | "top"): string {
  const parts: string[] = [];
  const pairContext = inlinePlainText(nodes);
  const inTable = context === "table";

  nodes.forEach((n, index) => {
    switch (n.kind) {
      case undefined:
      case "text": {
        // HTML 白名单标签 / 注释是**整段原子**，原样输出（不能转义，否则 <br> 变 &lt;br&gt;）
        const trimmed = n.text.trim();
        if (/^<!--[\s\S]*-->$/.test(trimmed) || /^<\/?(?:u|br|sub|sup|mark)\s*\/?>$/i.test(trimmed)) {
          parts.push(trimmed);
          return;
        }
        const marks = n.marks;
        const hasCode = !!marks?.code;
        // 与 serializer 同口径：非 code 文本走转义层
        const text = hasCode ? n.text : escapeText(n.text, inTable, pairContext);
        parts.push(marks ? applyMarks(text, marks, inTable) : text);
        return;
      }
      case "softbreak":
        // gfm 语义：裸换行（在模型层已分派；此处按"软换行"输出裸换行）
        parts.push(inTable ? "<br>" : "\n");
        return;
      case "hardbreak": {
        // v0.12.3 口径（与 serializer 完全一致）：
        // 段首 / 相邻硬换行 / 表格内 / 非顶层段末 → `<br>`；顶层段中/段末 → 两空格
        const prevIsBreak = index > 0 && nodes[index - 1]!.kind === "hardbreak";
        const nextIsBreak = index + 1 < nodes.length && nodes[index + 1]!.kind === "hardbreak";
        const isTrailing = index === nodes.length - 1;
        const useBr = inTable || index === 0 || prevIsBreak || nextIsBreak || (isTrailing && context !== "top");
        parts.push(useBr ? "<br>" : "  \n");
        return;
      }
      case "image": {
        // `n.text` 是**原始 content**（含 `|W|align` 后缀，已由 parse 保留）→ 原样写出
        const raw = n.text;
        const src = n.payload || "";
        parts.push(`![${raw}](${escapeDest(src)})`);
        return;
      }
      case "mathInline":
        parts.push(`$${stripZwsp(n.payload || n.text)}$`);
        return;
      default:
        // 未知行内类型：保留文本，绝不静默丢
        if (n.text) parts.push(n.text);
        return;
    }
  });
  return parts.join("");
}

// ────────────────────────────────────────────────────────────────
// 块级序列化
// ────────────────────────────────────────────────────────────────

/** 列表项：首行与列表符同行，后续块 4 空格缩进（与 serializer.listToMarkdown 同口径） */
function listItemsToSource(
  items: MdNode[],
  markerOf: (idx: number, item: MdNode) => string,
): string {
  const lines: string[] = [];
  items.forEach((item, idx) => {
    const marker = markerOf(idx, item);
    let isFirst = true;
    for (const child of item.children || []) {
      if (isFirst && child.kind === "paragraph") {
        // 首段落与列表符同行
        lines.push(`${marker} ${inlineToSource(child.inline || [])}`.trimEnd());
        isFirst = false;
        continue;
      }
      if (child.kind === "paragraph") {
        // P11-6：后续段落前必须空行，否则被当同段软换行（结构丢失）
        lines.push("");
      }
      const sub = blockToSource(child);
      for (const line of sub.replace(/\n$/, "").split("\n")) {
        lines.push(line ? `    ${line}` : "");
      }
      isFirst = false;
    }
    if (isFirst) {
      // 空列表项（无子块）→ 只输出标记
      lines.push(marker);
    }
  });
  return lines.join("\n") + "\n";
}

/** 表格：cells 是行 × 单元格（含 header 标记）；aligns 决定分隔行 */
function tableToSource(node: MdNode): string {
  const rows = (node.attrs.rows as Array<Array<{ inline: InlineNode[]; header: boolean }>>) || [];
  const aligns = (node.attrs.aligns as string[]) || [];
  if (rows.length === 0) return "";
  const headerRow = rows.find((r) => r[0]?.header) || rows[0]!;
  const bodyRows = rows.filter((r) => r !== headerRow);

  const cellText = (r: Array<{ inline: InlineNode[] }>) =>
    r.map((c) => inlineToSource(c.inline || [], "table")).join(" | ");

  const lines: string[] = [];
  lines.push(`| ${cellText(headerRow)} |`);
  const cols = Math.max(headerRow.length, aligns.length);
  const sep: string[] = [];
  for (let i = 0; i < cols; i++) {
    const a = aligns[i];
    sep.push(a === "left" ? ":--" : a === "center" ? ":-:" : a === "right" ? "--:" : "---");
  }
  lines.push(`|${sep.join("|")}|`);
  for (const r of bodyRows) lines.push(`| ${cellText(r)} |`);
  return lines.join("\n") + "\n";
}

/** 定义描述（dd）：`: ` 开头 + 内块 4 空格缩进（§6.3 方案乙要求 children 是完整块级树） */
function ddToSource(node: MdNode): string {
  const lines: string[] = [];
  let first = true;
  for (const child of node.children || []) {
    if (first && child.kind === "paragraph") {
      lines.push(`: ${inlineToSource(child.inline || [])}`.trimEnd());
      first = false;
      continue;
    }
    if (child.kind === "paragraph") lines.push("");
    const sub = blockToSource(child).replace(/\n$/, "");
    for (const line of sub.split("\n")) lines.push(line ? `    ${line}` : "");
    first = false;
  }
  if (first) lines.push(":");
  return lines.join("\n");
}

/** 定义列表：term 行 + 若干 dd */
function defListToSource(node: MdNode): string {
  const items = node.children || [];
  const lines: string[] = [];
  let i = 0;
  while (i < items.length) {
    const t = items[i]!;
    if (t.kind !== "definition_term") {
      i++;
      continue;
    }
    lines.push(inlineToSource(t.inline || []));
    i++;
    while (i < items.length && items[i]!.kind === "definition_description") {
      lines.push(ddToSource(items[i]!));
      i++;
    }
  }
  return lines.join("\n") + "\n";
}

/** 脚注定义：首段与 `[^label]: ` 同行，后续块 4 空格缩进（与 serializer 同口径） */
function footnoteToSource(node: MdNode): string {
  const label = String(node.attrs.label ?? "");
  const lines: string[] = [];
  let headerDone = false;
  for (const child of node.children || []) {
    if (!headerDone && child.kind === "paragraph") {
      lines.push(`[^${label}]: ${inlineToSource(child.inline || [])}`.trimEnd());
      headerDone = true;
      continue;
    }
    if (!headerDone) {
      lines.push(`[^${label}]:`);
      headerDone = true;
    } else if (child.kind === "paragraph") {
      lines.push("");
    }
    const sub = blockToSource(child).replace(/\n$/, "");
    for (const line of sub.split("\n")) lines.push(line ? `    ${line}` : "");
  }
  if (lines.length === 0) return `[^${label}]:\n`;
  return lines.join("\n") + "\n";
}

/** 引用块：子块逐行加 `> `，子块之间用 `>` 空行（v0.9.0 C4 口径） */
function blockquoteToSource(node: MdNode): string {
  const subs: string[] = [];
  for (const child of node.children || []) {
    subs.push(blockToSource(child).replace(/\n$/, ""));
  }
  if (subs.length === 0) return ">\n";
  const lines: string[] = [];
  subs.forEach((sub, idx) => {
    if (idx > 0) lines.push(">");
    for (const line of sub.split("\n")) lines.push(line ? `> ${line}` : ">");
  });
  return lines.join("\n") + "\n";
}

/** 单个块 → markdown（含尾部换行） */
export function blockToSource(node: MdNode, topLevel = false): string {
  switch (node.kind) {
    case "paragraph": {
      const body = inlineToSource(node.inline || [], topLevel ? "top" : undefined);
      // 段末硬换行（正文以 "  \n" 结尾）时不再追加段落终止换行（v0.12.3 口径）
      return body.endsWith("\n") ? body : body + "\n";
    }
    case "heading": {
      const level = Number(node.attrs.level ?? 1) || 1;
      const text = inlineToSource(node.inline || []);
      // G5-1 保真：raw.setext 时按**下划线写法**重建（不是归一化成 ATX）
      if (node.raw?.setext) {
        const underlineChar = level === 1 ? "=" : "-";
        // 下划线长度按新文字重算（设计稿 §10 决议 1）
        const underline = underlineChar.repeat(Math.max(3, text.length));
        return `${text}\n${underline}\n`;
      }
      return `${"#".repeat(level)} ${text}\n`;
    }
    case "codeBlock": {
      const info = String(node.attrs.info || node.attrs.language || "");
      return fenceBlock(stripZwsp((node.inline || []).map((n) => n.text).join("")), info);
    }
    case "mathBlock":
      return "$$" + "\n" + (stripZwsp(String(node.attrs.latex || "")) ? stripZwsp(String(node.attrs.latex || "")) + "\n" : "") + "$$\n";
    case "hr":
      return "---\n";
    case "toc":
      return "[toc]\n";
    case "bulletList":
      return listItemsToSource(node.children || [], () => "-");
    case "orderedList": {
      const start = Number(node.attrs.order ?? 1) || 1;
      const delim = node.attrs.delim === ")" ? ")" : ".";
      return listItemsToSource(node.children || [], (idx) => `${start + idx}${delim}`);
    }
    case "taskList":
      return listItemsToSource(node.children || [], (_idx, item) => {
        const checked = item.attrs.checked ? "x" : " ";
        // v0.12.1 需求5：`*` = 圆形样式，`-` = 方形（style 决定列表符）
        const bullet = item.attrs.style === "circle" ? "*" : "-";
        return `${bullet} [${checked}]`;
      });
    case "table":
      return tableToSource(node);
    case "defList":
      return defListToSource(node);
    case "footnote":
      return footnoteToSource(node);
    case "blockquote":
      return blockquoteToSource(node);
    case "listItem":
      // 单独序列化列表项（不应发生；兜底按段落处理）
      return (node.children || []).map((c) => blockToSource(c)).join("");
    default:
      // 未知 kind：绝不静默丢 —— 用原文切片兜底
      return "";
  }
}

// ────────────────────────────────────────────────────────────────
// 文档级序列化（B2 主入口）
// ────────────────────────────────────────────────────────────────

/** 块间空行策略（与 serializer.docToMarkdown 的逐块路径同口径） */
function needsBlankBetween(prev: MdNode, next: MdNode): boolean {
  // 空段落（用户显式空行）自身就是分隔
  if (prev.kind === "paragraph" && (prev.inline || []).length === 0) return false;
  void next;
  return true;
}

/**
 * `MdNode[]` → Markdown 源码。
 *
 * @param options.normalize 是否强制规范化（false = 尽量原文切片，默认 true）
 *
 * 原文切片路径需要 `source`：调用方（DocStore 快照）提供；纯树（如程序化构造的
 * 节点）没有 source 时传空串即全走规范序列化。
 */
export function treeToSource(
  tree: MdNode[],
  options?: {
    source?: string;
    /** 文档级 raw（头部/尾部空行数） */
    raw?: MdRaw;
  },
): string {
  // ⚠️ CRLF（关键，实测踩坑）：`node.span` 是按**归一化后**的文本算的
  // （parseUnified 入口把 `\r\n` 归一化为 `\n`），而调用方传入的 `source`
  // 可能是含 `\r\n` 的原文 —— 用归一化偏移去切未归一化文本会**错位切出别的内容**
  // （实测 doc#1/#4 等 44 篇 CRLF 文档被切出 `[ c]` / `xt = 27;` 这类碎片）。
  // 故这里在入口统一归一化：本文件全程只认 `\n`。
  // 写盘的 CRLF 还原由 eolPreserve 负责（设计稿 §3.2 A2 契约）。
  const source = (options?.source ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const raw = options?.raw;

  // ── 路径 A：纯未编辑文档 → **原文逐字节返回**（最保真，零风险）──
  //
  // 判定：所有顶层块的 span 都有效，且拼起来能完整覆盖源码的可见部分。
  // 这不是新发明 —— 它与既有 `docToMarkdown` 的 B6 快路径同思想，但判定依据
  // 从"blockSourceMap 的 WeakMap 原样"换成"**span 覆盖**"，因此 PM 重建 doc
  // （对象身份全变、WeakMap 全 miss）后仍然有效 —— 这是 B2 要消除的既有痛点。
  //
  // 为什么优先走这条：未编辑文档的**唯一完全保真做法**就是原文返回。
  // 任何"按块重组"都会在块间空行/头部尾部空行/脚注重排这些细节上出偏差
  // （实测：按块重组曾在 200 篇里造成 42 篇结构失真）。

  if (source && canReturnSourceVerbatim(tree, source)) {
    return source;
  }

  // ── 路径 B：有编辑过的块 → 逐块重建（未编辑块仍切片，编辑块规范序列化）──
  const parts: string[] = [];
  let prevEnd = -1; // 上一块结束 offset（-1 = 还没有块）

  for (let i = 0; i < tree.length; i++) {
    const node = tree[i]!;
    const slice = source && node.span.start < node.span.end ? source.slice(node.span.start, node.span.end) : "";

    // 块间空隙：直接取**源码原样**（不尝试估算空行数 —— 估算必错）
    if (prevEnd >= 0 && node.span.start > prevEnd) {
      const gapText = source.slice(prevEnd, node.span.start);
      // 只在空隙里确实只有空白时才沿用源码（否则按规范一个空行）
      if (/^\s*$/.test(gapText)) parts.push(gapText);
      else parts.push("\n");
    } else if (prevEnd >= 0) {
      // span 乱序（脚注重排）：按规范补一个空行
      parts.push("\n");
    }

    if (slice.length > 0) {
      parts.push(slice);
      prevEnd = node.span.end;
      continue;
    }

    // 编辑过的块 / 无 span：规范序列化
    const md = blockToSource(node, true);
    if (!md) continue;
    parts.push(md.replace(/\n$/, ""));
    prevEnd = -1; // 规范序列化后无法继续用源码间距
  }

  let out = parts.join("");
  if (out && !out.endsWith("\n")) out += "\n";

  // 头部/尾部空行保真（仅在走重建路径时需要；原文返回路径天然保真）
  if (raw) {
    const head = Math.max(0, raw.headBlankLines ?? 0);
    if (head > 0) out = "\n".repeat(head) + out.replace(/^\n+/, "");
    const tail = Math.max(0, raw.trailingBlankLines ?? 0);
    if (tail > 0) out = out.replace(/\n+$/, "") + "\n".repeat(tail + 1);
  }
  return out;
}

/**
 * 判断能否**原文逐字节返回**（= 没有任何块被编辑过）。
 *
 * 判据（全部满足）：
 * 1. 每个顶层块的 span 都有效（start < end，且不越界）
 * 2. 所有块的 span **互不重叠**、且按 start 升序（脚注明细见下）
 * 3. 各块 span 覆盖了源码里**所有非空白内容**（块间/头尾只允许是空白）
 *
 * 关于脚注：markdown-it 把 footnote_block 放 token 流末尾，我们在 parse 时
 * 已按源码行号把它插回正确位置，故 `lines/span` 是单调的 —— 顺序判据能过。
 *
 * 为什么判据 3 必要：若源码里有某段内容没被任何块覆盖（如解析器漏掉的
 * 未知 token），原文返回会"悄悄保留"它，但那意味着模型树不完整；
 * 此时应走重建路径，让缺失暴露出来（fuzz 会发现 lossy）。
 */
function canReturnSourceVerbatim(tree: MdNode[], source: string): boolean {
  let cursor = 0;
  for (const node of tree) {
    if (!(node.span.start < node.span.end)) return false;
    if (node.span.end > source.length) return false;
    if (node.span.start < cursor) return false; // 重叠或乱序
    // 块与块之间（以及首个块之前）必须只有空白
    if (!/^\s*$/.test(source.slice(cursor, node.span.start))) return false;
    cursor = node.span.end;
  }
  // 末尾剩余也必须是空白
  return /^\s*$/.test(source.slice(cursor));
}
