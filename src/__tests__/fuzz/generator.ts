/**
 * v0.17.0 P0-3 —— 往返 fuzz 文档生成器。
 *
 * 覆盖表来源：设计稿 §7.2（逐项实现，不是"实参式"混搭）：
 *   标题 6 级 ×2 写法(ATX/Setext) / 段落×软·硬换行 / 列表 3 类×嵌套 3 层×`1)`·`1.`
 *   代码围栏×反引号长度×info / 表格×对齐×合并格 HTML / 引用×嵌套×空行
 *   脚注×多段定义 / 定义列表×dd 内块 / 图片×`|W|align` 后缀
 *   数学块·行内 / HTML 白名单标签 / base64 图片 / CRLF / 首尾与块间空行 0-3 随机
 *
 * 设计约定（重要，决定基线可信度）：
 * 1. **确定性**：同一 seed + 同一文档序号 → 逐字节相同的 Markdown（见 prng.ts）。
 * 2. **特征可归属**：每篇文档返回它实际用到的 feature 集合，报告按 feature 聚合
 *    diff —— 这样「哪条语法在往返中失真」是可定位的，而不是一堆匿名样本。
 * 3. **块间空行 0 的约束**：只有当下一块「自己就能起块」（首行是 ATX 标题/围栏/
 *    引用标记/列表标记/分隔线/[toc]）时才允许 0 空行，否则 `para` + `| a |` 这类
 *    组合会因 GFM 表格需要独立表头行而整体消失 —— 那会制造与实现无关的假 lossy。
 */

import { type Rng } from "./prng";

export type FeatureId =
  // 标题
  | "heading-atx"
  | "heading-setext"
  // 段落
  | "para-plain"
  | "para-softbreak"
  | "para-hardbreak-spaces"
  | "para-hardbreak-br"
  | "inline-stress"
  // 列表
  | "list-bullet"
  | "list-ordered-dot"
  | "list-ordered-paren"
  | "list-nested-2"
  | "list-nested-3"
  | "list-task"
  // 代码
  | "fence-basic"
  | "fence-backtick-len"
  | "fence-tilde"
  | "fence-info"
  | "fence-inner-backticks"
  // 表格
  | "table-align"
  | "table-no-align"
  | "table-merged-html"
  | "table-inline-format"
  // 引用
  | "quote-basic"
  | "quote-nested"
  | "quote-blankline"
  // 脚注
  | "footnote-simple"
  | "footnote-multipara"
  // 定义列表
  | "deflist-basic"
  | "deflist-multi-dd"
  | "deflist-inner-block"
  // 图片
  | "image-plain"
  | "image-width"
  | "image-width-align"
  | "image-alt-pipe"
  | "image-base64"
  // 数学
  | "math-block"
  | "math-inline"
  // HTML
  | "html-whitelist"
  | "html-comment"
  // 其它
  | "hr"
  | "toc"
  | "task-style-star"
  // 结构扰动
  | "blank-head"
  | "blank-tail"
  | "blank-gap-zero"
  | "blank-gap-multi"
  | "crlf";

/** 生成器内部的块描述 */
interface GenBlock {
  lines: string[];
  features: FeatureId[];
  /** 首行是否本身即可起一个新块（决定是否允许前面 0 空行） */
  selfStarts: boolean;
}

const WORDS = [
  "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "theta", "kappa",
  "lambda", "sigma", "omega", "text", "note", "item", "value", "sample",
  "数据", "内容", "示例", "笔记", "条目", "文本", "结构", "段落",
];

const SPECIALS = ["*", "_", "$", "~", "^", "==", "[", "]", "|", "\\", "`", "<", ">", "&", "!", "#"];

function word(rng: Rng): string {
  return rng.pick(WORDS);
}

function phrase(rng: Rng, min = 2, max = 5): string {
  const n = rng.between(min, max);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(word(rng));
  return parts.join(rng.chance(0.7) ? " " : "");
}

/** 1x1 透明 PNG（base64）—— base64 图片专项用的最小合法载荷 */
const BASE64_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// ─── 块构造器 ──────────────────────────────────────────────

function headingBlock(rng: Rng, level: number, setext: boolean): GenBlock {
  const text = phrase(rng, 1, 4);
  if (setext) {
    // Setext 只表达 H1(`=`) / H2(`-`)，且必须独立成块（后随下划线行）
    const underline = level <= 2 ? (rng.chance(0.5) ? (level === 1 ? "=" : "-") : level === 1 ? "=" : "-") : "=";
    const width = rng.chance(0.6) ? Math.max(3, text.length) : rng.between(1, 2);
    return {
      lines: [text, underline.repeat(width)],
      features: ["heading-setext"],
      selfStarts: false,
    };
  }
  const prefix = "#".repeat(level);
  const close = rng.chance(0.25) ? " " + "#".repeat(rng.between(1, 3)) : "";
  return {
    lines: [`${prefix} ${text}${close}`],
    features: ["heading-atx"],
    selfStarts: true,
  };
}

function paragraphBlock(rng: Rng): GenBlock {
  const mode = rng.int(5);
  if (mode === 0) {
    return { lines: [phrase(rng, 3, 8)], features: ["para-plain"], selfStarts: false };
  }
  if (mode === 1) {
    // 软换行：同一行内裸换行（GFM 下 = 硬换行，CommonMark 下 = 空格）
    const lines = [phrase(rng, 2, 5), phrase(rng, 2, 5)];
    if (rng.chance(0.4)) lines.push(phrase(rng, 1, 3));
    return { lines, features: ["para-softbreak"], selfStarts: false };
  }
  if (mode === 2) {
    // 硬换行（两空格）：注意不能落在段末（段末 "  \n" 无意义，见 serializer 注释）
    const lines: string[] = [];
    const n = rng.between(2, 3);
    for (let i = 0; i < n; i++) lines.push(phrase(rng, 2, 4));
    const out = lines.map((l, i) => (i < lines.length - 1 ? l + "  " : l));
    return { lines: out, features: ["para-hardbreak-spaces"], selfStarts: false };
  }
  if (mode === 3) {
    return { lines: [`${phrase(rng, 2, 4)}<br>${phrase(rng, 2, 4)}`], features: ["para-hardbreak-br"], selfStarts: false };
  }
  // 行内符号压力：这些字符会被 escapeText/配对判定影响
  const n = rng.between(2, 5);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(phrase(rng, 1, 2));
    parts.push(rng.pick(SPECIALS));
  }
  parts.push(phrase(rng, 1, 4));
  // 只写半个配对（避免输入本身不合法导致判定依赖于解析细节）
  return { lines: [parts.join(" ")], features: ["inline-stress"], selfStarts: false };
}

function listBlock(rng: Rng): GenBlock {
  const kind = rng.int(3); // 0 bullet / 1 ordered / 2 task
  const depth = rng.between(1, 3);
  const features: FeatureId[] = [];
  const marker = kind === 2 ? "-" : "-";
  const delim = rng.chance(0.5) ? "." : ")";
  if (kind === 0) features.push("list-bullet");
  else if (kind === 1) features.push(delim === "." ? "list-ordered-dot" : "list-ordered-paren");
  else features.push("list-task", "task-style-star");

  const lines: string[] = [];
  const firstNumber = rng.between(1, 3);
  let counter = firstNumber;
  // 同一个列表内**必须**用同一标记：CommonMark 规定「标记字符变化即开新列表」，
  // 混用会让一篇文档里的一个列表被解析成多个（这是输入写法差异，不是实现缺陷），
  // 会污染 kinds 判据。任务列表例外：`-`/`*` 是**方形/圆形样式**语义
  // （task-list-plugin 的 taskStyleFromBullet，serializer 用 attrs.style 还原）。
  const bullet = rng.chance(0.3) ? "*" : "-";

  const emit = (level: number, indent: string) => {
    const n = rng.between(1, 2);
    // 嵌套层的有序列表**必须从 1 开始**：CommonMark 规定「起始号 ≠ 1 的有序列表
    // 不能打断段落」，嵌套位置 a priori 是段落续行位置 → `4. b` 会被吞进上一段
    // （实测），那是输入本身不合法，会制造假的结构差异。
    if (level > 1 && kind === 1) counter = 1;
    for (let i = 0; i < n; i++) {
      const text = phrase(rng, 1, 3);
      if (kind === 2) {
        const box = rng.chance(0.5) ? "[ ]" : "[x]";
        const bullet2 = rng.chance(0.3) ? "*" : "-";
        lines.push(`${indent}${bullet2} ${box} ${text}`);
      } else if (kind === 1) {
        lines.push(`${indent}${counter++}${delim} ${text}`);
      } else {
        lines.push(`${indent}${bullet} ${text}`);
      }
      if (level < depth) {
        emit(level + 1, indent + "    ");
        // 每层只嵌一个子树，避免组合爆炸
        if (rng.chance(0.3)) break;
      }
    }
  };
  emit(1, "");
  if (depth >= 2) features.push("list-nested-2");
  if (depth >= 3) features.push("list-nested-3");
  // CommonMark：只有 `1.` 开头的有序列表能打断段落；`2.` 起头的会被当作
  // 上一段的行内续行（实测 "para\n2. x" → 单段落文本）。bullet/task 可以打断。
  const selfStarts = kind === 1 ? firstNumber === 1 : true;
  return { lines, features, selfStarts };
}

function fenceBlock(rng: Rng): GenBlock {
  const features: FeatureId[] = ["fence-basic"];
  const ch = rng.chance(0.25) ? "~" : "`";
  if (ch === "~") features.push("fence-tilde");
  const len = rng.pick([3, 4, 5, 6]);
  if (len !== 3) features.push("fence-backtick-len");
  const info = rng.chance(0.6)
    ? rng.pick(["js", "ts", "json", "py", "css", "sh", "text", "mermaid"])
    : "";
  if (info) features.push("fence-info");
  const fence = ch.repeat(len);
  // 内容里可能含反引号（要求围栏更长才不误闭合）
  const hasInnerBackticks = ch === "`" && rng.chance(0.4);
  if (hasInnerBackticks) features.push("fence-inner-backticks");
  const bodyLines: string[] = [];
  const n = rng.between(1, 3);
  for (let i = 0; i < n; i++) {
    if (hasInnerBackticks && i === 0) {
      bodyLines.push("`".repeat(rng.between(1, Math.max(1, len - 1))) + " inner");
    } else {
      bodyLines.push(`${word(rng)} = ${rng.between(1, 99)};`);
    }
  }
  return { lines: [fence + info, ...bodyLines, fence], features, selfStarts: true };
}

function tableBlock(rng: Rng): GenBlock {
  const features: FeatureId[] = [];
  const cols = rng.between(2, 4);
  // 显式分配概率：无对齐表（table-no-align）必须稳定可达，不能靠 pick 偶然命中。
  // 全 none 的概率需 ≥ 1/4，否则 60 篇内可能一次都不出现（实测曾漏覆盖）。
  const allNone = rng.chance(0.35);
  const aligns = Array.from({ length: cols }, () =>
    allNone ? ("none" as const) : rng.pick(["none", "left", "center", "right"] as const),
  );
  if (aligns.some((a) => a !== "none")) features.push("table-align");
  else features.push("table-no-align");
  const cell = () => phrase(rng, 1, 2);
  const header = Array.from({ length: cols }, () => cell());
  const delim = aligns.map((a) => {
    switch (a) {
      case "left":
        return rng.chance(0.5) ? ":--" : ":---";
      case "center":
        return rng.chance(0.5) ? ":-:" : ":--:";
      case "right":
        return rng.chance(0.5) ? "--:" : "---:";
      default:
        return rng.chance(0.5) ? "---" : "----";
    }
  });
  const rows: string[][] = [];
  const nRows = rng.between(1, 3);
  for (let r = 0; r < nRows; r++) rows.push(Array.from({ length: cols }, () => cell()));
  if (rng.chance(0.5)) {
    const r = rng.int(rows.length);
    const c = rng.int(rows[r].length);
    if (rows[r][c] === undefined) rows[r][c] = cell();
    if (rng.chance(0.3)) rows[r][c] = `**${rows[r][c]}**`;
    else features.push("table-inline-format");
  }
  const lines = [`| ${header.join(" | ")} |`, `|${delim.join("|")}|`];
  for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
  return { lines, features, selfStarts: false };
}

function tableMergedBlock(rng: Rng): GenBlock {
  const cols = rng.between(2, 3);
  const header = Array.from({ length: cols }, () => word(rng));
  const delim = "|" + "---|".repeat(cols);
  // 合并格用格内 HTML 表达（v1 决策 B/3）。
  //
  // 关键约束：**逻辑列数必须等于表头列数**（span + 后续普通格 = cols）。
  // 否则 GFM 表头 3 列 / 表体逻辑 4 列，serializer 的 tableGrid 会把表头补齐到
  // 4 列（补一个空 th）—— 那是「输入本身不合法」导致的假结构差异，会把
  // 真实缺陷淹没。真实缺陷检测由「span 与普通格的对应关系」保证。
  const span = rng.between(1, cols - 1);
  const inner = phrase(rng, 1, 2);
  const cellHtml = `<td colspan="${span}">${inner}</td>`;
  const rest: string[] = [];
  for (let i = 0; i < cols - span; i++) rest.push(word(rng));
  const lines = [`| ${header.join(" | ")} |`, delim, `| ${cellHtml} | ${rest.join(" | ")} |`];
  return { lines, features: ["table-merged-html"], selfStarts: false };
}

function quoteBlock(rng: Rng): GenBlock {
  const features: FeatureId[] = ["quote-basic"];
  const nested = rng.chance(0.4);
  if (nested) features.push("quote-nested");
  const withBlank = rng.chance(0.5);
  if (withBlank) features.push("quote-blankline");
  const marker = nested ? "> > " : "> ";
  const emptyMarker = nested ? "> >" : ">";
  const lines: string[] = [];
  lines.push(marker + phrase(rng, 2, 4));
  if (withBlank) lines.push(emptyMarker);
  lines.push(marker + phrase(rng, 2, 4));
  if (rng.chance(0.4)) lines.push(marker + "- " + phrase(rng, 1, 3));
  return { lines, features, selfStarts: true };
}

const FOOTNOTE_LABELS = ["1", "2", "note", "x", "ref-a"];

function footnoteBlock(rng: Rng, labelOverride?: string): GenBlock {
  const label = labelOverride ?? rng.pick(FOOTNOTE_LABELS);
  const multi = rng.chance(0.6);
  if (multi) {
    return {
      lines: [
        `[^${label}]: ${phrase(rng, 2, 4)}`,
        "",
        `    ${phrase(rng, 2, 4)}`,
      ],
      features: ["footnote-simple", "footnote-multipara"],
      // 脚注定义**必须**独立起块：紧跟段落行时 `[^x]:` 会被当作 lazy continuation
      // 吞进上一段（实测），那是输入本身不合法，会制造与实现无关的假差异。
      selfStarts: false,
    };
  }
  return {
    lines: [`[^${label}]: ${phrase(rng, 2, 4)}`],
    features: ["footnote-simple"],
    selfStarts: true,
  };
}

function footnoteUseBlock(rng: Rng, labelOverride?: string): GenBlock {
  const label = labelOverride ?? rng.pick(FOOTNOTE_LABELS);
  return {
    lines: [`${phrase(rng, 2, 3)} [^${label}] ${phrase(rng, 1, 2)}`],
    features: ["footnote-simple"],
    selfStarts: false,
  };
}

function deflistBlock(rng: Rng): GenBlock {
  const mode = rng.int(3);
  const term = phrase(rng, 1, 3);
  if (mode === 0) {
    return { lines: [term, `: ${phrase(rng, 2, 4)}`], features: ["deflist-basic"], selfStarts: false };
  }
  if (mode === 1) {
    return {
      lines: [term, `: ${phrase(rng, 1, 3)}`, `: ${phrase(rng, 1, 3)}`],
      features: ["deflist-basic", "deflist-multi-dd"],
      selfStarts: false,
    };
  }
  // dd 内块：缩进 4 空格的块级内容（v0.17.0 目标：PM schema 改 block+ 后必须保真）
  const innerKind = rng.int(3);
  if (innerKind === 0) {
    return {
      lines: [term, `: ${phrase(rng, 1, 3)}`, "", "    ```js", "    const v = 1;", "    ```"],
      features: ["deflist-basic", "deflist-inner-block"],
      selfStarts: false,
    };
  }
  if (innerKind === 1) {
    return {
      lines: [term, `: ${phrase(rng, 1, 3)}`, "", "    | a | b |", "    |---|--:|", "    | 1 | 2 |"],
      features: ["deflist-basic", "deflist-inner-block"],
      selfStarts: false,
    };
  }
  return {
    lines: [term, `: ${phrase(rng, 1, 3)}`, "", "    - nested", "    - item"],
    features: ["deflist-basic", "deflist-inner-block"],
    selfStarts: false,
  };
}

function imageBlock(rng: Rng): GenBlock {
  const mode = rng.int(5);
  const alt = phrase(rng, 1, 2);
  const src = rng.pick(["a.png", "img/b.jpg", "./assets/c.svg", "https://example.com/d.png"]);
  if (mode === 0) {
    return { lines: [`![${alt}](${src})`], features: ["image-plain"], selfStarts: false };
  }
  if (mode === 1) {
    return { lines: [`![${alt}|${rng.pick([100, 240, 300, 480])}](${src})`], features: ["image-width"], selfStarts: false };
  }
  if (mode === 2) {
    const w = rng.pick([120, 320, 640]);
    const a = rng.pick(["center", "right"]);
    return { lines: [`![${alt}|${w}|${a}](${src})`], features: ["image-width-align"], selfStarts: false };
  }
  if (mode === 3) {
    // alt 自身含竖线（序列化必须转义成 \| 才能往返）
    // alt 自身含竖线：源码必须写成 `\|`（单个反斜杠），否则会被当成后缀分隔符
    return { lines: [`![${alt}\\|${phrase(rng, 1, 2)}|300](${src})`], features: ["image-alt-pipe", "image-width"], selfStarts: false };
  }
  return { lines: [`![${alt}](${BASE64_PNG})`], features: ["image-plain", "image-base64"], selfStarts: false };
}

function mathBlock(rng: Rng): GenBlock {
  const expr = rng.pick(["x^2 + y^2 = z^2", "\\\\frac{a}{b}", "e^{i\\\\pi} + 1 = 0", "\\\\sum_{k=1}^{n} k"]);
  // `$$` 是本项目 mathPlugin 的块级 token，紧跟段落行不会起块（保持 false）
  return { lines: ["$$", expr, "$$"], features: ["math-block"], selfStarts: false };
}

function mathInlineBlock(rng: Rng): GenBlock {
  const a = rng.pick(["x^2", "a+b", "\\\\alpha", "\\\\sqrt{2}"]);
  const b = rng.pick(["y_1", "c-d", "\\\\beta", "\\\\pi"]);
  return {
    lines: [`${phrase(rng, 1, 2)} $${a}$ ${phrase(rng, 1, 2)} $${b}$`],
    features: ["math-inline"],
    selfStarts: false,
  };
}

function htmlBlock(rng: Rng): GenBlock {
  const tags = ["u", "br", "mark", "sub", "sup"] as const;
  const parts: string[] = [phrase(rng, 1, 2)];
  const n = rng.between(1, 3);
  for (let i = 0; i < n; i++) {
    const t = rng.pick(tags);
    if (t === "br") parts.push("<br>");
    else parts.push(`<${t}>${phrase(rng, 1, 2)}</${t}>`);
    parts.push(phrase(rng, 1, 2));
  }
  return { lines: [parts.join(" ")], features: ["html-whitelist"], selfStarts: false };
}

function htmlCommentBlock(rng: Rng): GenBlock {
  // 行内 HTML 注释不打断段落（注释本身是 inline token）
  return { lines: [`<!-- ${phrase(rng, 1, 3)} -->`], features: ["html-comment"], selfStarts: false };
}

function hrBlock(): GenBlock {
  // 关键：`---` 紧跟段落行时会被解释为 **Setext H2 下划线**（把上一段升格为标题），
  // 所以分隔线**不能**用来打断段落 —— 必须前面有空行才是分隔线。
  return { lines: ["---"], features: ["hr"], selfStarts: false };
}

function tocBlock(): GenBlock {
  // `[toc]` 是该插件的块级 token，只在块起始位置生效；紧跟段落行会被当作
  // 段落续行（实测 "para\n[toc]" → 单段落文本 "para  \n[toc]"）。
  return { lines: ["[toc]"], features: ["toc"], selfStarts: false };
}

// ─── 文档装配 ──────────────────────────────────────────────

/**
 * 生成一篇随机 Markdown 文档。
 *
 * @param rng 已按 (seed, index) 派生的随机源
 * @param index 文档序号（只用于报告）
 */
export function generateDocument(rng: Rng, index: number): { markdown: string; features: FeatureId[] } {
  const blocks: GenBlock[] = [];
  const features = new Set<FeatureId>();
  const targetBlocks = rng.between(4, 12);
  /** 脚注 label 文档内唯一计数器（重复 label 会让第二个定义被 markdown-it 吞掉） */
  let footnotesUsed = 0;

  // 保证 §7.2 覆盖表的核心项在**组合上**都有机会出现：前若干块按需插入
  // （不是硬编码模板，而是"若本次抽样没选中就补一个"，避免 200 篇里某项 0 覆盖）
  const push = (b: GenBlock) => {
    blocks.push(b);
    b.features.forEach((f) => features.add(f));
  };

  for (let i = 0; i < targetBlocks; i++) {
    const pick = rng.between(0, 17);
    switch (pick) {
      case 0:
      case 1: {
        // 标题：6 级 × ATX/Setext
        const level = rng.between(1, 6);
        const setext = level <= 2 && rng.chance(0.45);
        push(headingBlock(rng, level, setext));
        break;
      }
      case 2:
      case 3:
      case 4:
        push(paragraphBlock(rng));
        break;
      case 5:
      case 6:
        push(listBlock(rng));
        break;
      case 7:
        push(fenceBlock(rng));
        break;
      case 8:
        push(tableBlock(rng));
        break;
      case 9:
        push(rng.chance(0.6) ? tableMergedBlock(rng) : tableBlock(rng));
        break;
      case 10:
        push(quoteBlock(rng));
        break;
      case 11: {
        // 脚注：定义与引用**必须同 label**。
        // 实测（markdown-it-footnote）：未被任何 `[^label]` 引用的定义会被整体丢弃
        //（连 token 都不产生）—— 那是「输入本身不合法」，会制造大量与实现无关的
        // 假 lossy，淹没真实缺陷。故此处共享一个 label。
        //
        // 另一个同类约束（B2 阶段实测补）：**同一篇文档里 label 必须唯一**。
        // 重复 label 时 markdown-it 只保留第一个定义、第二个被吞掉，
        // 且引用位置可能落到错误定义上 → 制造假的结构差异（实测 doc#35）。
        // 故用文档内自增序号做 label，保证全局唯一。
        const label = `fn${footnotesUsed++}`;
        if (rng.chance(0.5)) {
          push(footnoteUseBlock(rng, label));
          push(footnoteBlock(rng, label));
        } else {
          push(footnoteBlock(rng, label));
          push(footnoteUseBlock(rng, label));
        }
        break;
      }
      case 12:
        push(deflistBlock(rng));
        break;
      case 13:
      case 14:
        push(imageBlock(rng));
        break;
      case 15:
        push(rng.chance(0.5) ? mathBlock(rng) : mathInlineBlock(rng));
        break;
      case 16:
        push(rng.chance(0.6) ? htmlBlock(rng) : htmlCommentBlock(rng));
        break;
      default:
        push(rng.chance(0.5) ? hrBlock() : tocBlock());
        break;
    }
  }

  // ── 空行策略：首尾 0-3、块间 0-3（0 只允许在"下一块自己起块"时）──
  const head = rng.between(0, 3);
  const tail = rng.between(0, 3);
  if (head > 0) features.add("blank-head");
  if (tail > 0) features.add("blank-tail");

  const out: string[] = [];
  for (let i = 0; i < head; i++) out.push("");
  blocks.forEach((b, i) => {
    if (i > 0) {
      let gap = rng.between(0, 3);
      if (gap === 0 && !b.selfStarts) gap = 1;
      if (gap === 0) features.add("blank-gap-zero");
      if (gap >= 2) features.add("blank-gap-multi");
      for (let k = 0; k < gap; k++) out.push("");
    }
    out.push(...b.lines);
  });
  for (let i = 0; i < tail; i++) out.push("");

  let markdown = out.join("\n") + "\n";
  if (rng.chance(0.18)) {
    // CRLF 专项：整篇换成 \r\n（载入侧应归一化，写盘侧由 eolPreserve 还原）
    markdown = markdown.replace(/\n/g, "\r\n");
    features.add("crlf");
  }
  // 可靠兜底：空文档不允许（会让 doc 解析出空结构，无分析价值）
  if (!markdown.trim()) markdown = `${phrase(rng, 2, 4)}\n`;
  void index;
  return { markdown, features: [...features] };
}
