/**
 * v0.17.0 P0-3 —— 语义签名（diff 分类的独立裁判）。
 *
 * 为什么需要独立裁判而不是直接比字符串：
 * 往返链路的合法归一化太多（ATX↔Setext、`  \n`↔`<br>`、表格分隔行补空格、CRLF、
 * 围栏字符/长度、列表符号…）。直接 diff 会把它们全报成失败，基线变噪音。
 *
 * 判据来源：`createMarkdownIt`（markdown-it + 本项目插件）**直接产 token 流**，
 * 不与 serializer（PM 出口）/ exportBlocks（Block[] 出口）共用代码路径 ——
 * 三条 oracle 的输出都用同一把尺子量，尺子本身不被 oracle 污染。
 *
 * 粒度设计（关键）：以「行内容器」为单位而不是 token 为单位。
 * 同一段文字被拆成 `["a", "b"]` 还是 `["a b"]` 属实现细节，逐 token 比会把
 * **run 切分差异**误判成内容丢失。故：
 *   atoms —— 每个行内容器/叶块一条「归一化后的可见文本」（内容丢失的判据）
 *   attrs —— 每个容器的格式指纹（strong/em/code/link/math/image/break 计数 + href）
 *   kinds —— 块种类 + token level 序列（结构破坏的判据）
 * 文本原子做「折叠空白、去 ZWSP、换行归一」→ 排版差异不进入内容判据。
 */
import { createMarkdownIt } from "../../core/markdown/parser";

/** 与编辑管线同配置的裁判实例（html:true + htmlBlockDisabled = v0.16.0 编辑实例口径） */
const judge = createMarkdownIt({ breaks: true, html: true, htmlBlockDisabled: true });

export interface Signature {
  /** 块种类 + 嵌套层级，如 ["heading@0", "list_item@1", "paragraph@2"] */
  kinds: string[];
  /** 块种类（去掉层级）：用于「只减不增」的子序列判定（导出链路的已声明能力边界） */
  kindsRaw: string[];
  /** 可见内容原子（每个行内容器/叶块一条） */
  atoms: string[];
  /** 语义/格式属性 */
  attrs: string[];
}

/** 归一化可见文本：去零宽占位、折叠水平空白、统一换行、trim */
export function normalizeText(text: string): string {
  // 注意：**所有**空白（含换行）折叠为单空格。
  // 理由：换行者是"载体"（`  \n` / `<br>` / 裸换行在 GFM 下渲染等价，且
  // Blocks 出口的 InlineRun 会把换行写成 `\n` 文本），把它留在内容原子会让
  // 「同一段文字被拆成不同 run / 不同换行载体」被误判成内容丢失。
  // 换行的**数量**改记进格式指纹（见 accumulate 的 hardbreak/softbreak 计数）。
  return text.replace(/\u200B/g, "").replace(/\s+/g, " ").trim();
}

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

/** 计入 kinds 的块级开启 token（结构判据词汇表） */
const KIND_TOKENS: Record<string, string> = {
  heading_open: "heading",
  paragraph_open: "paragraph",
  bullet_list_open: "bullet_list",
  ordered_list_open: "ordered_list",
  list_item_open: "list_item",
  task_list_open: "task_list",
  task_item_open: "task_item",
  blockquote_open: "blockquote",
  table_open: "table",
  thead_open: "thead",
  tbody_open: "tbody",
  tr_open: "tr",
  th_open: "th",
  td_open: "td",
  dl_open: "definition_list",
  dt_open: "definition_term",
  dd_open: "definition_description",
  footnote_block_open: "footnote_block",
  footnote_open: "footnote",
};

/** 行内格式 token → 指纹里的计数键 */
const FORMAT_TOKENS: Record<string, string> = {
  strong_open: "strong",
  em_open: "em",
  s_open: "strike",
  mark_open: "mark",
  sub_open: "sub",
  sup_open: "sup",
};

interface InlineAccum {
  text: string;
  formats: Map<string, number>;
  links: string[];
  images: string[];
}

/**
 * 收集 inline token 流的可见文本与格式指纹。
 *
 * 文本拼接规则（两侧同规则，故可比）：
 * - text/emoji → 原样
 * - code_inline → 内容（`code:` 前缀会破坏"同一段文字"判定，故不加前缀，
 *   用 code 计数进入格式指纹）
 * - math_inline → 内容
 * - image → `[图片: <raw content>]`（与 exportBlocks 的占位文本同构，
 *   但裁判层用中性形态：alt 原文 + src）
 * - footnote_ref → `[^label]`
 * - hardbreak / softbreak → "\n"
 * - html_inline → 白名单标签不计入文本（它是结构，进格式指纹）；注释内容不计入
 *   （注释是旁路指令/标注，不是可见内容 —— 与 exportBlocks 的显式剥离一致）
 */
function accumulate(tokens: Tk[], acc: InlineAccum): void {
  for (const t of tokens) {
    switch (t.type) {
      case "text":
        acc.text += t.content || "";
        break;
      case "emoji":
        // 本项目保留 shortcode 原文
        acc.text += t.content || "";
        break;
      case "code_inline":
        acc.text += t.content || "";
        acc.formats.set("code", (acc.formats.get("code") || 0) + 1);
        break;
      case "math_inline":
        acc.text += t.content || "";
        acc.formats.set("math", (acc.formats.get("math") || 0) + 1);
        break;
      case "image": {
        const raw = (t.content || "").replace(/\\\|/g, "|");
        const src = (attr(t, "src") || "").trim();
        acc.text += `[图片: ${raw}]`;
        acc.images.push(`${raw}|${src}`);
        acc.formats.set("image", (acc.formats.get("image") || 0) + 1);
        break;
      }
      case "footnote_ref": {
        const label = (t.meta as { label?: string } | null)?.label ?? "";
        acc.text += `[^${label}]`;
        acc.formats.set("footnote_ref", (acc.formats.get("footnote_ref") || 0) + 1);
        break;
      }
      case "hardbreak":
      case "softbreak":
        // GFM 口径（settings.paragraphBreaks 默认 gfm）下二者**渲染等价**（都出 <br>），
        // 只是源码写法不同：裸换行 → softbreak token，`  \n` → hardbreak token。
        // 故指纹统一记 "break"，只比**数量**；写法差异退化为承载层差异。
        // 若不统一，quote/list_item/脚注等容器里的软换行都会被误判成属性丢失。
        acc.text += " ";
        acc.formats.set("break", (acc.formats.get("break") || 0) + 1);
        break;
      case "html_inline": {
        const trimmed = (t.content || "").trim();
        if (/^<!--[\s\S]*-->$/.test(trimmed)) break; // 注释：不计可见内容
        const m = /^<(\/?[a-zA-Z][a-zA-Z0-9]*)/.exec(trimmed);
        const tag = m ? m[1]!.toLowerCase().replace(/^\//, "") : "";
        // `<br>` 是**换行载体**：必须贡献一个分隔符，否则 "a<br>b" 会与 "a  \nb"
        // 归一成不同原子（前者 glue 成 "ab"），把纯载体差异误判为内容差异。
        if (tag === "br") {
          acc.text += " ";
          acc.formats.set("break", (acc.formats.get("break") || 0) + 1);
          break;
        }
        if (tag) acc.formats.set("html:" + tag, (acc.formats.get("html:" + tag) || 0) + 1);
        // 非白名单标签内容由 text token 承载，标签本身不计
        break;
      }
      case "link_open": {
        const href = attr(t, "href") || "";
        acc.links.push(href);
        acc.formats.set("link", (acc.formats.get("link") || 0) + 1);
        break;
      }
      case "text_special":
        // 转义字符（`\|` 等）的还原形态：内容是实际字符
        acc.text += t.content || "";
        break;
      default: {
        const key = FORMAT_TOKENS[t.type];
        if (key) acc.formats.set(key, (acc.formats.get(key) || 0) + 1);
        break;
      }
    }
  }
}

function formatFingerprint(acc: InlineAccum, inTable: boolean): string {
  const parts: string[] = [];
  for (const [k, v] of [...acc.formats.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    parts.push(`${k}=${v}`);
  }
  if (acc.links.length) parts.push("href=" + acc.links.join("|"));
  if (acc.images.length) parts.push("img=" + acc.images.join("|"));
  void inTable;
  return parts.join(",");
}

export function computeSignature(markdown: string): Signature {
  const sig: Signature = { kinds: [], kindsRaw: [], atoms: [], attrs: [] };
  let tokens: Tk[];
  try {
    tokens = judge.parse(markdown, {}) as unknown as Tk[];
  } catch {
    return { kinds: ["__parse_error__"], kindsRaw: ["__parse_error__"], atoms: [], attrs: [] };
  }

  const tableDepths: number[] = [];

  for (const t of tokens) {
    const kind = KIND_TOKENS[t.type];
    if (kind) {
      sig.kinds.push(`${kind}@${t.level}`);
      sig.kindsRaw.push(kind);
      if (t.type === "table_open") tableDepths.push(t.level);
      if (t.type === "table_close") tableDepths.pop();
      if (t.type === "heading_open") sig.attrs.push("heading:level=" + (t.tag || ""));
      if (t.type === "ordered_list_open") {
        sig.attrs.push("ordered:start=" + (attr(t, "start") || "1"));
        sig.attrs.push("ordered:delim=" + (t.markup === ")" ? ")" : "."));
      }
      if (t.type === "task_item_open") {
        const checked = attr(t, "data-checked") ?? attr(t, "checked");
        if (checked !== null) sig.attrs.push("task:checked=" + checked);
        const style = attr(t, "style") || "";
        if (style) sig.attrs.push("task:style=" + style);
      }
      if (t.type === "th_open" || t.type === "td_open") {
        const style = attr(t, "style") || "";
        const m = /text-align\s*:\s*(left|center|right)/i.exec(style);
        sig.attrs.push("cell:align=" + (m ? m[1]!.toLowerCase() : "left"));
      }
      if (t.type === "footnote_open") {
        const label = (t.meta as { label?: string } | null)?.label ?? "";
        sig.attrs.push("footnote:label=" + String(label));
      }
      continue;
    }

    if (t.type === "inline" && t.children) {
      const acc: InlineAccum = { text: "", formats: new Map(), links: [], images: [] };
      accumulate(t.children, acc);
      const text = normalizeText(acc.text);
      if (text) sig.atoms.push(text);
      const fp = formatFingerprint(acc, tableDepths.length > 0);
      if (fp) sig.attrs.push("inline:" + fp);
      continue;
    }

    // 叶块
    switch (t.type) {
      case "hr":
        sig.kinds.push("hr");
        sig.kindsRaw.push("hr");
        break;
      case "toc":
        sig.kinds.push("toc");
        sig.kindsRaw.push("toc");
        break;
      case "fence":
      case "code_block":
      case "math_block": {
        const kindName = t.type === "fence" ? "code_block" : t.type;
        sig.kinds.push(kindName);
        sig.kindsRaw.push(kindName);
        const body = normalizeText(t.content || "");
        if (body) sig.atoms.push((t.type === "math_block" ? "math:" : "code:") + body);
        const info = normalizeText(t.info || "");
        if (info) sig.attrs.push("code:info=" + info);
        break;
      }
      case "html_block": {
        sig.kinds.push("html_block");
        sig.kindsRaw.push("html_block");
        const trimmed = (t.content || "").trim();
        if (!trimmed.startsWith("<!--")) {
          const body = normalizeText(trimmed);
          if (body) sig.atoms.push("html_block:" + body);
        }
        break;
      }
      default:
        break;
    }
  }
  return sig;
}

export interface SignatureDiff {
  kindsEqual: boolean;
  atomsEqual: boolean;
  attrsEqual: boolean;
  /** 输入有、输出缺（内容丢失 → lossy） */
  missingAtoms: string[];
  /** 输出多出来（凭空造内容 → corrupt） */
  extraAtoms: string[];
  kindsOnlyInInput: string[];
  kindsOnlyInOutput: string[];
  attrsOnlyInInput: string[];
  attrsOnlyInOutput: string[];
  /** 结构是否被破坏：kinds 序列不等（含顺序/数量） */
  structuralBreak: boolean;
  /** 是否有内容丢失 */
  contentLost: boolean;
  /** 是否有内容凭空增加 */
  contentAdded: boolean;
  anyDiff: boolean;
}

function multisetDiff(a: string[], b: string[]): { missing: string[]; extra: string[] } {
  const counts = new Map<string, number>();
  for (const x of b) counts.set(x, (counts.get(x) || 0) + 1);
  const missing: string[] = [];
  for (const x of a) {
    const c = counts.get(x) || 0;
    if (c > 0) counts.set(x, c - 1);
    else missing.push(x);
  }
  const extra: string[] = [];
  for (const [x, c] of counts) for (let i = 0; i < c; i++) extra.push(x);
  return { missing, extra };
}

export function diffSignatures(a: Signature, b: Signature): SignatureDiff {
  const kindsEqual = a.kinds.length === b.kinds.length && a.kinds.every((k, i) => k === b.kinds[i]);
  // kinds 的差异用**多重集**算（不是逐位比较）：块插入/删除会让后面的位置全部错位，
  // 逐位比较会把一次「缺一个 footnote_block」报成几十项差异，掩盖真实原因。
  const kinds = multisetDiff(a.kinds, b.kinds);
  const atoms = multisetDiff(a.atoms, b.atoms);
  const attrs = multisetDiff(a.attrs, b.attrs);
  const structuralBreak = !kindsEqual;
  const contentLost = atoms.missing.length > 0;
  const contentAdded = atoms.extra.length > 0;
  return {
    kindsEqual,
    atomsEqual: !contentLost && !contentAdded,
    attrsEqual: attrs.missing.length === 0 && attrs.extra.length === 0,
    missingAtoms: atoms.missing,
    extraAtoms: atoms.extra,
    kindsOnlyInInput: kinds.missing,
    kindsOnlyInOutput: kinds.extra,
    attrsOnlyInInput: attrs.missing,
    attrsOnlyInOutput: attrs.extra,
    structuralBreak,
    contentLost,
    contentAdded,
    anyDiff: structuralBreak || contentLost || contentAdded
      || attrs.missing.length > 0 || attrs.extra.length > 0,
  };
}

/**
 * 结构「只减不增」判定：输出 kinds 是输入 kinds 的子序列。
 *
 * 用途：Blocks 出口（DOCX/LaTeX）刻意不承载某些结构（脚注定义块、定义列表的
 * dd 内块等），那属于**已声明的能力边界**，不是结构破坏。只有当输出 kinds
 * 不是输入的子序列（序列被重排/替换）时才判 corrupt。
 */
export function isKindSubsequence(inKinds: string[], outKinds: string[]): boolean {
  let j = 0;
  for (const k of inKinds) {
    if (j < outKinds.length && outKinds[j] === k) j++;
  }
  return j === outKinds.length;
}

/**
 * 结构「只减不增 + 允许重排」判定（Blocks 出口专用）。
 *
 * 为什么用**多重集包含**而不是子序列：导出链路的 blockquote/脚注付款顺序与
 * 顶层原文顺序本来就不同 —— 实测 `footnote_block` 被摊平成普通段落并挪到文末
 * （exportBlocks 的已声明行为），子序列判定会把这种**合法的重排**误报为结构破坏。
 *
 * 语义：out 的每个 kind 都必须在 in 里能找到对应数量 → 只减不增（可重排）。
 */
export function isKindMultisetSubset(inKinds: string[], outKinds: string[]): boolean {
  const avail = new Map<string, number>();
  for (const k of inKinds) avail.set(k, (avail.get(k) || 0) + 1);
  for (const k of outKinds) {
    const c = avail.get(k) || 0;
    if (c === 0) return false;
    avail.set(k, c - 1);
  }
  return true;
}
