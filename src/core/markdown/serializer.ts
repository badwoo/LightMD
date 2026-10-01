/**
 * ProseMirror 文档 → Markdown 字符串序列化器
 */
import type { Node, Mark } from "prosemirror-model";
import { getBlockSource, type BlockSourceInfo } from "./blockSourceMap";

/**
 * 将 ProseMirror 文档序列化为 Markdown 字符串
 *
 * v0.6.6 问题1：空段落（空行）往返一致性
 * - 空段落序列化为单个空行（"\n"）；空段之后紧跟的块不再追加间隔换行
 *   （否则每个空段膨胀为 2 个空行，md→doc→md 往返不收敛）
 * - 去掉原 trimEnd()：它会把用户显式输入的尾部空行（空段落）全部剪掉，
 *   导致切换页签/重开后换行丢失；现在仅保证恰好以单个换行结尾
 *
 * v0.9.0 B6：块级原文保留
 * - 快路径：全部顶层块携带解析期记录的原文行号（= doc 未被编辑）→
 *   逐字节返回源文本，未编辑文档保存零 diff
 * - 逐块路径：命中的块输出原文切片（含原尾随空行），未命中的块（编辑过/
 *   程序化构造）走规范序列化，块间按规范规则补空行
 * - v0.9.0 D2：删除「表格前不加块间空行」特判——列表块后的 "|" 行会被
 *   lazy continuation 吸进列表项导致表格丢失，统一走块间空行逻辑
 */
export function docToMarkdown(doc: Node): string {
  const blocks: Node[] = [];
  doc.forEach((node) => blocks.push(node));

  // ── B6 快路径：全部块命中且行号连续覆盖 → 原文逐字节返回 ──
  if (blocks.length > 0) {
    const infos = blocks.map(getBlockSource);
    if (infos.every(Boolean)) {
      const typed = infos as BlockSourceInfo[];
      let ok = typed[0].start === 0;
      for (let i = 1; ok && i < typed.length; i++) {
        if (typed[i].start <= typed[i - 1].start) ok = false;
      }
      if (ok) return typed[0].source;
    }
  }

  // ── 逐块路径 ──
  // v0.7.0 修复5：识别末尾连续空段落（仅 miss 的空段；hit 的尾段走原文切片）
  let trailing = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (!getBlockSource(b) && b.type.name === "paragraph" && b.content.size === 0) trailing++;
    else break;
  }
  const bodyCount = blocks.length - trailing;

  const parts: string[] = [];
  let prevWasMiss = false;
  let srcLines: string[] | null = null;
  let srcRef: string | null = null;
  const countLines = (s: string) => {
    const l = s.split("\n");
    return s.endsWith("\n") ? l.length - 1 : l.length;
  };

  blocks.forEach((node, index) => {
    const info = getBlockSource(node);
    if (info) {
      // 命中：输出原文行区间切片（含块间原有空行），不加规范间隔
      let end = info.end;
      const nextInfo = index + 1 < blocks.length ? getBlockSource(blocks[index + 1]) : undefined;
      if (nextInfo && nextInfo.start > end) end = nextInfo.start;
      if (index === blocks.length - 1) end = countLines(info.source);
      if (srcRef !== info.source) {
        srcRef = info.source;
        srcLines = info.source.split("\n");
      }
      const slice = (srcLines as string[]).slice(info.start, end).join("\n") + "\n";
      // 前一块是重新序列化的块：规范补一个空行分隔（原间隔未知，取规范形式）
      if (prevWasMiss && parts.length > 0) {
        const last = parts[parts.length - 1];
        if (last !== "\n" && !last.endsWith("\n\n")) parts.push("\n");
      }
      parts.push(slice);
      prevWasMiss = false;
      return;
    }

    const md = blockToMarkdown(node);
    if (md !== null) {
      // 在块之间添加空行（v0.9.0 D2：表格不再豁免——列表后的表格必须有空行隔开）
      if (index < bodyCount && parts.length > 0) {
        const last = parts[parts.length - 1];
        // 上一块为空段落（"\n"）时其自身已构成空行，无需再加间隔
        if (last !== "\n" && !last.endsWith("\n\n")) {
          parts.push("\n");
        }
      }
      parts.push(md);
    }
    prevWasMiss = true;
  });
  let out = parts.join("");
  if (out && !out.endsWith("\n")) out += "\n";
  return out;
}

// ─── 块级序列化 ──────────────────────────────────────────

function blockToMarkdown(node: Node): string | null {
  switch (node.type.name) {
    case "paragraph":
      return inlineToMarkdown(node) + "\n";
    case "heading":
      return headingToMarkdown(node);
    case "blockquote":
      return blockquoteToMarkdown(node);
    case "code_block":
      return codeBlockToMarkdown(node);
    case "mermaid_block":
      return mermaidBlockToMarkdown(node);
    case "math_block":
      return mathBlockToMarkdown(node);
    case "bullet_list":
      return listToMarkdown(node, "-");
    case "ordered_list":
      return listToMarkdown(node, "1.");
    case "task_list":
      return taskListToMarkdown(node);
    case "horizontal_rule":
      return "---\n";
    case "table":
      return tableToMarkdown(node);
    case "footnote_definition":
      return footnoteDefinitionToMarkdown(node);
    case "definition_list":
      return definitionListToMarkdown(node);
    case "toc":
      // 目录节点序列化回 [toc] 标记
      return "[toc]\n";
    default:
      return null;
  }
}

// ─── 脚注定义 ──────────────────────────────────────────

function footnoteDefinitionToMarkdown(node: Node): string {
  const label = node.attrs.label || "";
  const content = inlineToMarkdown(node);
  return `[^${label}]: ${content}\n`;
}

// ─── 定义列表 ──────────────────────────────────────────

function definitionListToMarkdown(node: Node): string {
  const lines: string[] = [];
  node.forEach((child) => {
    if (child.type.name === "definition_term") {
      lines.push(inlineToMarkdown(child));
    } else if (child.type.name === "definition_description") {
      lines.push(`: ${inlineToMarkdown(child)}`);
    }
  });
  return lines.join("\n") + "\n";
}

// ─── 标题 ────────────────────────────────────────────────

function headingToMarkdown(node: Node): string {
  const level = node.attrs.level;
  const prefix = "#".repeat(level);
  const content = inlineToMarkdown(node);
  return `${prefix} ${content}\n`;
}

// ─── 引用块 ──────────────────────────────────────────────

/**
 * v0.9.0 C4：引用内空行不再丢弃。
 * 旧实现 filter(Boolean) 把引用内段落间空行吞掉，多段落往返后被合并成一段。
 * 现在：段落间输出 ">" 空行，行内空行输出 ">"（CommonMark 引用内空行形式）。
 */
function blockquoteToMarkdown(node: Node): string {
  const childBlocks: string[] = [];
  node.forEach((child) => {
    const childMd = blockToMarkdown(child);
    if (childMd) childBlocks.push(childMd.replace(/\n$/, ""));
  });
  if (childBlocks.length === 0) return ">\n";
  const lines: string[] = [];
  childBlocks.forEach((childMd, idx) => {
    if (idx > 0) lines.push(">");
    childMd.split("\n").forEach((line) => {
      lines.push(line ? "> " + line : ">");
    });
  });
  return lines.join("\n") + "\n";
}

// ─── 代码块 ──────────────────────────────────────────────

/** v0.9.0 D8：仅剥「整体占位」的零宽空格（parser 对空代码内容的占位），不碰真实内容 */
function stripZwsp(text: string): string {
  return text === "\u200B" ? "" : text;
}

/**
 * v0.9.0 C2：块级围栏长度按内容动态选择（CommonMark）。
 * 围栏长 = max(3, 最长反引号连续段+1, 行首反引号连续段+1)，
 * 保证内容中的反引号串不会被误认为围栏开/闭标记。
 */
function fenceBlock(content: string, info: string): string {
  let maxRun = 0;
  let run = 0;
  for (const ch of content) {
    if (ch === "`") {
      run++;
      if (run > maxRun) maxRun = run;
    } else {
      run = 0;
    }
  }
  let fenceLen = Math.max(3, maxRun + 1);
  for (const line of content.split("\n")) {
    let r = 0;
    while (line[r] === "`") r++;
    if (r >= fenceLen) fenceLen = r + 1;
  }
  const f = "`".repeat(fenceLen);
  // 空内容时省略内容行（避免多出空行，"```\n```" 往返保真）
  return f + info + "\n" + (content ? content + "\n" : "") + f + "\n";
}

function codeBlockToMarkdown(node: Node): string {
  // v0.9.0 D11：info 保留完整信息串（如 "js {highlight}"），language 仍取首词
  const info = node.attrs.info || node.attrs.language || "";
  return fenceBlock(stripZwsp(node.textContent), info);
}

// ─── Mermaid 图表块 ──────────────────────────────────────

function mermaidBlockToMarkdown(node: Node): string {
  const info = node.attrs.info || "mermaid";
  return fenceBlock(stripZwsp(node.textContent), info);
}

// ─── 块级数学公式 ──────────────────────────────────────

function mathBlockToMarkdown(node: Node): string {
  const content = stripZwsp(node.textContent || node.attrs.latex || "");
  // 空内容时省略内容行（避免多出空行，"$$\n$$" 往返保真）
  return "$$\n" + (content ? content + "\n" : "") + "$$\n";
}

// ─── 列表 ────────────────────────────────────────────────

function listToMarkdown(
  node: Node,
  marker: string
): string {
  const lines: string[] = [];
  // v0.9.0 D4：有序列表起始号从 attrs.order 取（parser 已读 markdown-it 的 start）
  let idx = marker === "1." ? (node.attrs.order || 1) : 1;

  node.forEach((listItem) => {
    // 对于有序列表，使用递增数字
    const prefix = marker === "1." ? `${idx}.` : marker;

    // 遍历列表项的所有子节点
    let isFirstChild = true;
    listItem.forEach((child) => {
      const childMd = blockToMarkdown(child);
      if (!childMd) return;

      if (isFirstChild && child.type.name === "paragraph") {
        // 第一个段落：与列表标记同行
        const content = inlineToMarkdown(child);
        lines.push(`${prefix} ${content}`);
        isFirstChild = false;
      } else {
        // 后续内容：4空格缩进（标准 Markdown 续行）
        // v0.8.0 修复 P11-6：后续**段落**前必须先插入空行，否则 markdown-it 会把
        // 缩进续行当作同一段落的软换行 → 多段落降级成"单段落 + hard_break"
        // （模式切换回来后段落结构丢失）。嵌套列表等块级节点不需要空行。
        if (child.type.name === "paragraph") lines.push("");
        const indent = "    ";
        const trimmed = childMd.trimEnd();
        trimmed.split("\n").forEach((line) => {
          if (line) {
            lines.push(`${indent}${line}`);
          }
        });
        isFirstChild = false;
      }
    });

    idx++;
  });

  return lines.join("\n") + "\n";
}

// ─── 任务列表 ──────────────────────────────────────────

function taskListToMarkdown(node: Node): string {
  const lines: string[] = [];

  // 递归序列化任务列表，支持任意层级嵌套
  const serializeItems = (taskListNode: Node, indent: string) => {
    taskListNode.forEach((taskItem) => {
      const checked = taskItem.attrs.checked ? "x" : " ";
      let isFirstChild = true;
      // v0.7.0 修复1c：本项首行（"- [ ] xxx"）在 lines 中的索引。
      // task 项在 markdown 中只能单行表达（task-list-plugin 逐行解析），
      // item 内的后续段落若序列化为缩进续行，解析时会断裂列表并丢失内容。
      // 修复：后续块级内容取文本合并追加到首行，保证内容不丢失。
      let firstLineIdx = -1;
      taskItem.forEach((child) => {
        if (isFirstChild && child.type.name === "paragraph") {
          const content = inlineToMarkdown(child);
          lines.push(`${indent}- [${checked}] ${content}`);
          firstLineIdx = lines.length - 1;
          isFirstChild = false;
        } else if (child.type.name === "task_list") {
          // 嵌套任务列表：递归序列化，增加 2 空格缩进
          serializeItems(child, indent + "  ");
          isFirstChild = false;
        } else {
          // 其他块级内容：合并到首行（空段落跳过）
          const text = child.type.name === "paragraph" ? inlineToMarkdown(child) : child.textContent;
          if (text.trim() && firstLineIdx >= 0 && lines[firstLineIdx] !== undefined) {
            const sep = lines[firstLineIdx].endsWith(" ") ? "" : " ";
            lines[firstLineIdx] += sep + text;
          }
          isFirstChild = false;
        }
      });
    });
  };

  serializeItems(node, "");
  return lines.join("\n") + "\n";
}

// ─── 表格 ────────────────────────────────────────────────

function tableToMarkdown(node: Node): string {
  const rows: string[][] = [];
  const aligns: string[] = [];

  // 收集所有行
  node.forEach((section) => {
    section.forEach((row) => {
      const cells: string[] = [];
      row.forEach((cell, _offset, colIdx) => {
        cells.push(inlineToMarkdown(cell, "table").trim());
        // 从第一个thead行提取对齐
        if (aligns.length <= colIdx && section.type.name === "table_head") {
          aligns[colIdx] = cell.attrs.align || "left";
        }
      });
      rows.push(cells);
    });
  });

  if (rows.length === 0) return "";

  const colCount = rows[0]?.length || 0;
  if (colCount === 0) return "";

  const result: string[] = [];

  // 表头（第一行）
  result.push("| " + rows[0].map((c) => c || " ").join(" | ") + " |");

  // 分隔行
  const sep = aligns.map((a) => {
    switch (a) {
      case "center": return ":---:";
      case "right": return "---:";
      default: return "---";
    }
  });
  // 补齐缺少的对齐
  while (sep.length < colCount) sep.push("---");
  result.push("| " + sep.join(" | ") + " |");

  // 数据行
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    while (cells.length < colCount) cells.push("");
    result.push("| " + cells.map((c) => c || " ").join(" | ") + " |");
  }

  return result.join("\n") + "\n";
}

// ─── Inline 序列化 ───────────────────────────────────────

/**
 * v0.9.0 B2/B3/B4：mark 包裹显式优先级。
 * PM 的 marks 是扁平集合，其数组顺序不代表嵌套包含关系。CommonMark 规定
 * code span 内是字面文本（不能含其他强调），因此 code 恒为最内层；link
 * 承载 URL 语义放最外层。按此优先级排序后再包裹，嵌套关系不再颠倒。
 */
const MARK_OUTER_ORDER: Record<string, number> = {
  link: 0,
  strong: 1,
  em: 2,
  strike: 3,
  // E8(v0.9.3):下划线无 Markdown 原生语法,以 <u> 包裹,层级紧邻 strike
  underline: 4,
  mark: 5,
  subscript: 6,
  superscript: 7,
  code: 99,
};

function inlineToMarkdown(node: Node, context?: "table"): string {
  const parts: string[] = [];

  node.forEach((child) => {
    if (child.type.name === "text") {
      let text = child.text || "";

      const marks = child.marks;
      // v0.9.0 C1：非 code 文本走转义层（code 内容是字面文本不转义；
      // 表格上下文的管道转义见 applyMark/code 与 escapeText 的 inTableCell）
      const hasCode = marks.some((m) => m.type.name === "code");
      if (!hasCode) text = escapeText(text, context === "table");

      // 从外到内按优先级应用标记（B2/B3/B4 修复）
      const ordered = [...marks].sort(
        (a, b) =>
          (MARK_OUTER_ORDER[a.type.name] ?? 50) - (MARK_OUTER_ORDER[b.type.name] ?? 50)
      );
      for (const m of ordered) {
        text = applyMark(text, m, context === "table");
      }

      parts.push(text);
    } else if (child.type.name === "image") {
      const { src, alt, title, width } = child.attrs;
      const titlePart = title ? ` "${escapeTitle(title)}"` : "";
      // E11a(v0.9.3):宽度以 Typora 风格 |W 后缀表达;无宽度保持旧语法兼容旧文档
      const widthPart = typeof width === "number" && width > 0 ? `|${width}` : "";
      // v0.9.0 C3：目标地址含空格/括号/尖括号时用 <...> 包裹
      parts.push(`![${escapeText(alt || "")}${widthPart}](${escapeDest(src)}${titlePart})`);
    } else if (child.type.name === "hard_break") {
      // v0.8.0 WP5 修复6：硬换行序列化为 CommonMark 两空格硬换行（"  \n"），
      // 与 parser 的 softbreak→hard_break 互逆，保证 md→doc→md 段内换行保真。
      // v0.8.0 修复 P0-1：表格单元格内不能写 "  \n"（真实换行会截断 GFM 表格行），
      // 改用 <br>，parser 端在表格上下文会把它还原为 hard_break。
      parts.push(context === "table" ? "<br>" : "  \n");
    } else if (child.type.name === "math_inline") {
      // 行内数学公式（v0.9.0 D8：剥整体 ZWSP 占位）
      const latex = stripZwsp(child.textContent || child.attrs.latex || "");
      parts.push(`$${latex}$`);
    } else if (child.type.name === "footnote_ref") {
      // 脚注引用 [^label]
      parts.push(`[^${child.attrs.label || ""}]`);
    }
  });

  return parts.join("");
}

function applyMark(text: string, mark: Mark, inTableCell = false): string {
  switch (mark.type.name) {
    case "strong":
      return `**${text}**`;
    case "em":
      return `*${text}*`;
    case "code":
      return inlineCodeWrap(text, inTableCell);
    case "strike":
      return `~~${text}~~`;
    case "underline":
      // E8(v0.9.3):下划线序列化为 HTML <u> 标签(Markdown 无原生语法)
      return `<u>${text}</u>`;
    case "mark":
      // 高亮标记 ==text==
      return `==${text}==`;
    case "subscript":
      // 下标 ~sub~
      return `~${text}~`;
    case "superscript":
      // 上标 ^sup^
      return `^${text}^`;
    case "link": {
      const { href, title } = mark.attrs;
      const titlePart = title ? ` "${escapeTitle(title)}"` : "";
      return `[${text}](${escapeDest(href)}${titlePart})`;
    }
    default:
      return text;
  }
}

/**
 * v0.9.0 B1/B5：行内 code 围栏按 CommonMark 规则选择。
 * - 围栏长度 = 内容中最长反引号连续段 + 1（旧实现只做「含反引号→双反引号」
 *   二分，多 span 相邻时产生多连反引号损坏）
 * - 内容以反引号开头/结尾、或首尾皆空格时，首尾各补一个空格
 *   （否则解析时会因围栏粘连/首尾空格剥离而丢字符）
 * - v0.9.0 D5：表格上下文中内容里的 "|" 写成 "\|"
 *   （GFM 允许 \| 穿透 code span，markdown-it 遵循）
 */
function inlineCodeWrap(content: string, inTableCell: boolean): string {
  let inner = inTableCell ? content.replace(/\|/g, "\\|") : content;
  let max = 0;
  let run = 0;
  for (const ch of inner) {
    if (ch === "`") {
      run++;
      if (run > max) max = run;
    } else {
      run = 0;
    }
  }
  const fence = "`".repeat(max + 1);
  if (
    inner.startsWith("`") ||
    inner.endsWith("`") ||
    (inner.startsWith(" ") && inner.endsWith(" "))
  ) {
    inner = " " + inner + " ";
  }
  return fence + inner + fence;
}

/**
 * v0.9.0 C3：链接/图片目标地址转义。
 * 含空白、括号或尖括号的地址用 <...> 包裹（CommonMark pointy 形式），
 * 内部的 < > \ 用反斜杠转义；markdown-it 原生支持该形式，往返闭合。
 */
function escapeDest(dest: string): string {
  if (!dest) return dest;
  if (!/[\s()<>]/.test(dest)) return dest;
  return "<" + dest.replace(/([<>\\])/g, "\\$1") + ">";
}

/** v0.9.0 C3：link/image title 中的引号转义 */
function escapeTitle(title: string): string {
  return title.replace(/"/g, '\\"');
}

/**
 * v0.9.0 C1：普通文本转义层（仅应用于无 code mark 的 text 节点）。
 *
 * text token 的 content 是已解码形态（源文 "\*" 进 doc 后就是 "*"），
 * 不转义直接输出会被重新解析变义（如 "2*3*4" → 强调）。转义规则按
 * 「确实会被重新解析变义才转义」的最小必要原则，避免全量转义的噪音：
 * - 反斜杠最先把已有序列转义为字面
 * - "*"：同 run 内 ≥2 个才可能配对成强调，转义；单个不转义（零噪音）
 * - "_"：CommonMark 词内下划线无法构成强调，仅转义词外的
 * - "=="、"!["、实体引用 &name;、autolink 形态 <scheme:、链接形态 ](：
 *   按语法形态条件转义
 * - "~"、"^"、"$"：低频且易与插件语法冲突，直接转义
 * - 表格上下文中 "|" 转义（GFM）
 */
function escapeText(text: string, inTableCell = false): string {
  if (!text) return text;
  let out = text.replace(/\\/g, "\\\\");

  // 反引号：任何出现都可能与其他 run 的反引号配对成 code span
  out = out.replace(/`/g, "\\`");

  // 星号：≥2 个才可能构成强调对
  if ((out.match(/\*/g) || []).length >= 2) {
    out = out.replace(/\*/g, "\\*");
  }

  // 下划线：仅转义词外的（前后不同时为字母数字）
  if (out.includes("_")) {
    const isWord = (c: string | undefined) => c !== undefined && /[a-zA-Z0-9]/.test(c);
    let s = "";
    for (let i = 0; i < out.length; i++) {
      const ch = out[i];
      if (ch === "_" && isWord(out[i - 1]) && isWord(out[i + 1])) {
        s += ch;
      } else if (ch === "_") {
        s += "\\_";
      } else {
        s += ch;
      }
    }
    out = s;
  }

  // 高亮标记 ==：成对出现时逐字符转义
  out = out.replace(/==/g, "\\=\\=");

  // 图片起始 ![（仅在后随 [ 时有意义）
  out = out.replace(/!(?=\[)/g, "\\!");

  // 链接/引用形态的方括号：存在 ]( 或 ][ 配对时才转义
  if (/\]\s*\(/.test(out) || /\]\[/.test(out)) {
    out = out.replace(/[[\]]/g, "\\$&");
  }

  // 实体引用形态的 &（防 &copy; 类被解码变义）
  out = out.replace(/&(?=[a-zA-Z][a-zA-Z0-9]*;|#[0-9]+;|#[xX][0-9a-fA-F]+;)/g, "\\&");

  // autolink 形态的 <（防 <scheme:...> 被解析为链接）
  out = out.replace(/<(?=[a-zA-Z][a-zA-Z0-9.+-]*:)/g, "\\<");

  // 波浪线 / 脱字符 / 美元符：低频，直接转义（$ 防两个裸 $ 配对成行内公式）
  out = out.replace(/~/g, "\\~").replace(/\^/g, "\\^").replace(/\$/g, "\\$");

  if (inTableCell) {
    out = out.replace(/\|/g, "\\|");
  }
  return out;
}
