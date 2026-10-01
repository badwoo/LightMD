/**
 * ProseMirror InputRules —— Markdown 语法即时转换
 */
import { InputRule, inputRules } from "prosemirror-inputrules";
import { EditorState, TextSelection } from "prosemirror-state";
import type { NodeType, MarkType } from "prosemirror-model";
import { lightMDSchema } from "./schema";
// E7(v0.9.3):链接规则复用 scheme 白名单(危险 URL 不转换,保留字面文本)
import { sanitizeLinkHref } from "./markdown/parser";

const schema = lightMDSchema;

// ─── 辅助函数 ────────────────────────────────────────────

function blockRule(
  regexp: RegExp,
  nodeType: NodeType,
  getAttrs: (match: RegExpMatchArray) => Record<string, unknown> = () => ({})
): InputRule {
  return new InputRule(regexp, (state, match, start, end) => {
    const $start = state.doc.resolve(start);
    const parentType = $start.parent.type;

    if (
      parentType !== schema.nodes.paragraph &&
      parentType !== schema.nodes.heading
    ) {
      return null;
    }

    const blockStart = $start.start($start.depth);
    if (start !== blockStart) {
      return null;
    }

    const attrs = getAttrs(match);
    const tr = state.tr;
    tr.delete(start, end);
    tr.setBlockType(start, start, nodeType, attrs);
    tr.setSelection(TextSelection.create(tr.doc, start));
    return tr;
  });
}

function markRule(
  regexp: RegExp,
  markType: MarkType,
  getAttrs: (match: RegExpMatchArray) => Record<string, unknown> = () => ({})
): InputRule {
  // 正则约定：match[1]=开始标记，match[2]=内容
  // 注意：InputRule 的 end 是输入前光标位置（to 参数），不含新输入字符
  // 因此文档中只有 match[0] 去掉最后一个字符的部分
  return new InputRule(regexp, (state, match, start, end) => {
    const content = match[2];
    const contentLen = content.length;

    // 检查开始标记前的字符，避免在单词中间触发（如 word**bold**）
    if (markType.name !== "code" && start > 0) {
      const charBefore = state.doc.textBetween(start - 1, start);
      if (charBefore && !/\s|[(\[{<"']/.test(charBefore)) {
        return null;
      }
    }

    const attrs = getAttrs(match);
    const tr = state.tr;

    // 删除整个匹配范围（文档中的部分，end 不含新输入字符）
    tr.delete(start, end);
    // 插入内容文本
    tr.insertText(content, start);
    // 给内容添加 mark
    tr.addMark(start, start + contentLen, markType.create(attrs));
    // 光标移到内容末尾
    tr.setSelection(TextSelection.create(tr.doc, start + contentLen));
    // 移除存储的 mark，避免后续输入继续应用
    tr.removeStoredMark(markType);
    return tr;
  });
}

// ─── 标题规则 ────────────────────────────────────────────

const headingRules = [
  blockRule(/^#{6}\s$/, schema.nodes.heading, () => ({ level: 6 })),
  blockRule(/^#{5}\s$/, schema.nodes.heading, () => ({ level: 5 })),
  blockRule(/^#{4}\s$/, schema.nodes.heading, () => ({ level: 4 })),
  blockRule(/^#{3}\s$/, schema.nodes.heading, () => ({ level: 3 })),
  blockRule(/^#{2}\s$/, schema.nodes.heading, () => ({ level: 2 })),
  blockRule(/^#{1}\s$/, schema.nodes.heading, () => ({ level: 1 })),
];

// ─── 列表规则 ────────────────────────────────────────────

// 任务列表规则：匹配 "- [ ] " 或 "- [x] "（需在 bulletListRule 之前）
const taskListRule = new InputRule(/^[-*]\s\[[ xX]\]\s$/, (state, _match, start, end) => {
  const $start = state.doc.resolve(start);
  if ($start.parent.type !== schema.nodes.paragraph && $start.parent.type !== schema.nodes.heading) return null;
  if (start !== $start.start($start.depth)) return null;
  const match = _match[0];
  const checked = /\[[xX]\]/.test(match);
  const tr = state.tr;
  tr.delete(start, end);
  const taskList = schema.nodes.task_list.create(null, [
    schema.nodes.task_item.create({ checked }, [schema.nodes.paragraph.create()]),
  ]);
  tr.replaceWith(start, start, taskList);
  tr.setSelection(TextSelection.create(tr.doc, start + 3)); // inside task_item paragraph
  return tr;
});

const bulletListRule = new InputRule(/^[-+*]\s$/, (state, _match, start, end) => {
  const $start = state.doc.resolve(start);
  if ($start.parent.type !== schema.nodes.paragraph && $start.parent.type !== schema.nodes.heading) return null;
  if (start !== $start.start($start.depth)) return null;
  const tr = state.tr;
  tr.delete(start, end);
  const list = schema.nodes.bullet_list.create(null, [
    schema.nodes.list_item.create(null, [schema.nodes.paragraph.create()]),
  ]);
  tr.replaceWith(start, start, list);
  tr.setSelection(TextSelection.create(tr.doc, start + 2)); // inside list_item paragraph
  return tr;
});

const orderedListRule = new InputRule(/^(\d+)\.\s$/, (state, match, start, end) => {
  const $start = state.doc.resolve(start);
  if ($start.parent.type !== schema.nodes.paragraph && $start.parent.type !== schema.nodes.heading) return null;
  if (start !== $start.start($start.depth)) return null;
  const order = Number(match[1]) || 1;
  const tr = state.tr;
  tr.delete(start, end);
  const list = schema.nodes.ordered_list.create({ order }, [
    schema.nodes.list_item.create(null, [schema.nodes.paragraph.create()]),
  ]);
  tr.replaceWith(start, start, list);
  tr.setSelection(TextSelection.create(tr.doc, start + 2));
  return tr;
});

const listRules = [bulletListRule, orderedListRule];

// ─── 引用规则 ────────────────────────────────────────────

const blockquoteRule = blockRule(/^>\s$/, schema.nodes.blockquote);

// ─── 分割线规则 ──────────────────────────────────────────

/**
 * E3(v0.9.2):块级转换守卫(hrRule / codeBlockRule 专用)。
 *
 * 此前两条规则为裸 InputRule,在列表项、引用块等嵌套块内输入 --- 或 ```
 * 也会被转换为水平线/代码块,序列化时嵌套结构易错乱。
 * 仅照搬 blockRule 的 parent + 行首守卫并不够:列表项/引用内的段落
 * 同样满足"parent 为 paragraph + 行首",必须再限定 $start.depth === 1
 * (仅顶层块触发),嵌套上下文中保持字面文本。
 */
function topLevelParagraphGuard(state: EditorState, start: number): boolean {
  const $start = state.doc.resolve(start);
  if ($start.depth !== 1) return false;
  const parentType = $start.parent.type;
  if (parentType !== schema.nodes.paragraph && parentType !== schema.nodes.heading) {
    return false;
  }
  return start === $start.start($start.depth);
}

const hrRule = new InputRule(/^(---|\*\*\*|___)$/, (state, match, start, end) => {
  // E3:列表项/引用内等嵌套块中输入 ---/*** 不再误转水平线;新增 ___ 变体
  if (!topLevelParagraphGuard(state, start)) return null;
  const tr = state.tr;
  tr.replaceRangeWith(start, end, schema.nodes.horizontal_rule.create());
  const para = schema.nodes.paragraph.create();
  tr.insert(tr.mapping.map(start + 1), para);
  return tr;
});

// ─── 内联标记规则 ────────────────────────────────────────

const markRules = [
  markRule(
    /(\*\*|__)(.*?)\1$/,
    schema.marks.strong
  ),
  // em 规则：match[1]=开始标记 *，match[2]=内容
  // 使用否定断言避免与 ** (strong) 冲突
  markRule(
    /(?<!\*)(\*)(?!\*)(.+?)(?<!\*)\1(?!\*)$/,
    schema.marks.em
  ),
  // E3:code 规则内容要求"非空且不含反引号"——修复前 (.*?)(空内容) 会把
  // 打代码块路径中的 `` / ``` 吞成行内代码(顶层被 codeBlockRule 掩盖,
  // 嵌套块内守卫生效后暴露),导致围栏代码块无法通过打字进入
  markRule(
    /(`)([^`]+)\1$/,
    schema.marks.code
  ),
  markRule(
    /(~~)(.*?)\1$/,
    schema.marks.strike
  ),
  // 高亮标记 ==text==
  markRule(
    /(==)([^=]+)\1$/,
    schema.marks.mark
  ),
  // 上标 ^sup^（仅匹配非 ^ 字符，避免与代码块冲突）
  markRule(
    /(\^)([^^]+)\1$/,
    schema.marks.superscript
  ),
  // 下标 ~sub~（仅匹配单个 ~，避免与 ~~删除线~~ 冲突）
  // 使用否定断言：前面不是 ~，并且内部不是 ~
  markRule(
    /(?<!~)(~)([^~]+)\1(?!\~)$/,
    schema.marks.subscript
  ),
];

// ─── 代码块 / Mermaid 图表块规则 ──────────────────────────

const codeBlockRule = new InputRule(
  /^```(\w*)\s*$/,
  (state, match, start, end) => {
    // E3:列表项/引用内等嵌套块中输入 ``` 不再误转代码块
    if (!topLevelParagraphGuard(state, start)) return null;
    const tr = state.tr;
    const language = match[1] || "";

    // mermaid 语言使用专用的 mermaid_block 节点
    if (language === "mermaid") {
      tr.delete(start, end);
      const mermaidBlock = schema.nodes.mermaid_block.create(
        { language: "mermaid" },
        schema.text(" ")
      );
      tr.replaceSelectionWith(mermaidBlock);
      const pos = tr.selection.from - 1;
      tr.delete(pos, pos + 1);
      tr.setSelection(TextSelection.create(tr.doc, pos));
      return tr;
    }

    tr.delete(start, end);
    const codeBlock = schema.nodes.code_block.create(
      { language },
      schema.text(" ")
    );
    tr.replaceSelectionWith(codeBlock);
    const pos = tr.selection.from - 1;
    tr.delete(pos, pos + 1);
    tr.setSelection(TextSelection.create(tr.doc, pos));
    return tr;
  }
);

// ─── E7(v0.9.3):输入规则补全(公式/表格/图片/链接/脚注/toc) ──────────

/**
 * E7:行内规则守卫——父块须为可输入 inline 内容的文本块
 * (段落/标题/表格单元格/脚注定义/定义列表项)。
 * 代码块/数学块也是 textblock,但 code:true 已被 inputRules 机制排除。
 */
function inlineTextblockGuard(state: EditorState, pos: number): boolean {
  const $pos = state.doc.resolve(pos);
  return $pos.parent.isTextblock;
}

/** 行内公式 $x$:输入闭合 $ 即时触发(Typora 同款;内容非空且不含 $ 与空白开头) */
const mathInlineRule = new InputRule(/\$([^$\s][^$]*?)\$$/, (state, match, start, end) => {
  if (!inlineTextblockGuard(state, start)) return null;
  const latex = match[1];
  const tr = state.tr;
  // 单步替换(以纯文本构造,原区间内残留的 mark 一并清除)
  const node = schema.nodes.math_inline.create({ latex }, schema.text(latex));
  tr.replaceWith(start, end, node);
  tr.setSelection(TextSelection.create(tr.doc, start + node.nodeSize));
  return tr;
});

/** 块级公式 $$:行首输入第二个 $ 触发,构造与 codeBlockRule 同款(空格占位后删除) */
const mathBlockRule = new InputRule(/^\$\$$/, (state, _match, start, end) => {
  if (!topLevelParagraphGuard(state, start)) return null;
  const tr = state.tr;
  tr.delete(start, end);
  const block = schema.nodes.math_block.create({ latex: "" }, schema.text(" "));
  tr.replaceSelectionWith(block);
  const pos = tr.selection.from - 1;
  tr.delete(pos, pos + 1);
  tr.setSelection(TextSelection.create(tr.doc, pos));
  return tr;
});

// ─── E7:空格触发的行内规则 ──────────────────────────────
// 关键前提:auto-pair 的 overtype 在光标紧邻 ")" 时跳过不产生真实输入,
// InputRule 收不到 ")",因此链接/图片/脚注引用/toc 一律空格触发(Typora 同款)。

/** 图片 ![alt|W](src) + 空格:必须在链接规则**之前**(链接正则是其子串) */
const imageInputRule = new InputRule(/!\[([^\]|]*)(?:\|(\d+))?\]\(([^)]*)\)\s$/, (state, match, start, end) => {
  if (!inlineTextblockGuard(state, start)) return null;
  const alt = match[1] || "";
  const width = match[2] ? Number(match[2]) : null;
  const src = match[3] || "";
  const tr = state.tr;
  const img = schema.nodes.image.create({ src, alt, width });
  // 尾随空格保留(用户输入的一部分,天然分隔后续文字)
  tr.replaceWith(start, end, [img, schema.text(" ")]);
  tr.setSelection(TextSelection.create(tr.doc, start + img.nodeSize + 1));
  return tr;
});

/** 链接 [文本](url) + 空格;(?<!!) 防止吃掉图片语法(图片规则在前已兜底) */
const linkInputRule = new InputRule(/(?<!!)\[([^\]]*)\]\(([^)]*)\)\s$/, (state, match, start, end) => {
  if (!inlineTextblockGuard(state, start)) return null;
  const safeHref = sanitizeLinkHref(match[2] || "");
  if (!safeHref) return null; // 危险 scheme:不转换,保留字面文本
  const text = match[1] || "";
  const tr = state.tr;
  const linkMark = schema.mark("link", { href: safeHref, title: "" });
  // 显式构造:链接文本带 mark,尾随空格不带(避免空格继承链接)
  const nodes = text ? [schema.text(text, [linkMark]), schema.text(" ")] : [schema.text(" ")];
  tr.replaceWith(start, end, nodes);
  if (!text) tr.addStoredMark(linkMark); // 空文本:以存储态让后续输入成为链接
  tr.setSelection(TextSelection.create(tr.doc, start + text.length + 1));
  return tr;
});

/** 脚注引用 [^label] + 空格(行中可触发) */
const footnoteRefInputRule = new InputRule(/\[\^([^\]]+)\]\s$/, (state, match, start, end) => {
  if (!inlineTextblockGuard(state, start)) return null;
  const label = match[1];
  const tr = state.tr;
  const ref = schema.nodes.footnote_ref.create({ label });
  tr.replaceWith(start, end, [ref, schema.text(" ")]);
  tr.setSelection(TextSelection.create(tr.doc, start + ref.nodeSize + 1));
  return tr;
});

/** 脚注定义 [^label]: + 空格:仅顶层段落行首触发(定义是独立块) */
const footnoteDefInputRule = new InputRule(/\[\^([^\]]+)\]:\s$/, (state, match, start, end) => {
  const $start = state.doc.resolve(start);
  if ($start.depth !== 1 || $start.parent.type !== schema.nodes.paragraph) return null;
  if (start !== $start.start($start.depth)) return null;
  const tr = state.tr;
  tr.delete(start, end);
  // 整块转 footnote_definition(label 写入 attrs,内容为空待输入)
  tr.setBlockType(start, start, schema.nodes.footnote_definition, { label: match[1] });
  return tr;
});

/** 目录 [toc] / [[toc]] + 空格:仅顶层段落行首触发(须独占一行,与 toc-plugin 语法一致) */
const tocInputRule = new InputRule(/\[\[?toc\]?\]\s$/i, (state, _match, start, end) => {
  const $start = state.doc.resolve(start);
  if ($start.depth !== 1 || $start.parent.type !== schema.nodes.paragraph) return null;
  if (start !== $start.start($start.depth)) return null;
  const tr = state.tr;
  // 整段替换为 toc 节点(匹配文本必在段内,一并清除);后随空段落供继续输入
  const paraStart = $start.before($start.depth);
  const paraEnd = paraStart + $start.parent.nodeSize;
  tr.replaceWith(paraStart, paraEnd, schema.nodes.toc.create());
  tr.insert(paraStart + 1, schema.nodes.paragraph.create()); // toc 为原子节点,nodeSize=1
  return tr;
});

// ─── E7:表格规则 ────────────────────────────────────────

/**
 * E7:解析管道行(表格行语法)为单元格数组。
 * "| a | b |" → ["a","b"];"a | b" → ["a","b"](首尾边界管道可省略);
 * 无 "|" → null。支持 \| 转义;单元格内容 trim。
 */
export function parsePipeRow(text: string): string[] | null {
  if (!text.includes("|")) return null;
  const parts = text.split(/(?<!\\)\|/);
  if (parts[0]?.trim() === "") parts.shift(); // 首边界管道产生的空段
  if (parts.length > 0 && parts[parts.length - 1]?.trim() === "") parts.pop(); // 尾边界
  if (parts.length === 0) return null;
  return parts.map((p) => p.trim().replace(/\\\|/g, "|"));
}

/** E7:分隔行单元格判定(:--- / ---: / :---: / ---) */
function isDelimiterCells(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

/** E7:分隔行单元格 → 对齐 */
function parseAlign(cell: string): "left" | "center" | "right" {
  if (/^:---:$/.test(cell)) return "center";
  if (/^---:$/.test(cell)) return "right";
  return "left";
}

/**
 * E7:查找 pos 所在块**之前的相邻文本块**,是管道行则返回其内容与区间(纯函数)。
 * 用于表格输入规则:表头行(上一段) + 分隔行(当前输入行) 两段转表格。
 */
export function findPipeRowBefore(
  doc: import("prosemirror-model").Node,
  pos: number,
): { text: string; cells: string[]; from: number; to: number } | null {
  const $pos = doc.resolve(pos);
  const depth = $pos.depth;
  if (depth === 0) return null;
  // 容器是 depth-1 层的节点(doc / 列表项等),当前块是其第 index 个子节点
  const container = $pos.node(depth - 1);
  const index = $pos.index(depth - 1);
  if (index === 0) return null;
  const prev = container.child(index - 1);
  if (prev.type.name !== "paragraph") return null;
  const cells = parsePipeRow(prev.textContent);
  if (!cells || cells.length === 0) return null;
  const to = $pos.before(depth); // 当前块起点 = 上一块终点
  return { text: prev.textContent, cells, from: to - prev.nodeSize, to };
}

/**
 * E7:表格输入规则——分隔行输入完成(末键 - 或 |)且上一段为管道行时,
 * 两段替换为 table 节点(表头 + 一行空表体,光标落首格,与 Typora 一致)。
 * 正则只负责"在 - / | 击键时进入 handler",完整校验在 handler 内做:
 * 当前行(含本次输入字符)必须整体是分隔行,且光标位于块末尾。
 */
const tableInputRule = new InputRule(/(?:-|\|)$/, (state, match, start, end) => {
  const $end = state.doc.resolve(end);
  const parent = $end.parent;
  if (parent.type !== schema.nodes.paragraph) return null;
  if (end !== $end.start($end.depth) + parent.content.size) return null; // 须在块末尾
  // 重构当前行全文(文档内文本 + 本次输入字符)
  const typedChar = match[0].slice(-1);
  const lineStart = $end.start($end.depth);
  const curLine = state.doc.textBetween(lineStart, end, "\n", "\ufffc") + typedChar;
  const curCells = parsePipeRow(curLine);
  if (!curCells || !isDelimiterCells(curCells)) return null;
  const prevRow = findPipeRowBefore(state.doc, end);
  if (!prevRow) return null;

  const aligns = curCells.map(parseAlign);
  const headerCells = prevRow.cells;
  // 单元格内容为 inline*(schema),直接放 text 节点(空表头格无内容)
  const headerRow = schema.nodes.table_row.create(
    null,
    headerCells.map((c, i) =>
      schema.nodes.table_header.create(
        { align: aligns[i] ?? "left" },
        c ? schema.text(c) : undefined,
      ),
    ),
  );
  const bodyRow = schema.nodes.table_row.create(
    null,
    headerCells.map((_c, i) => schema.nodes.table_cell.create({ align: aligns[i] ?? "left" })),
  );
  const table = schema.nodes.table.create(null, [
    schema.nodes.table_head.create(null, [headerRow]),
    schema.nodes.table_body.create(null, [bodyRow]),
  ]);
  const tr = state.tr;
  tr.replaceWith(prevRow.from, end, table);
  // 后随空段落供继续输入(替换会吞掉当前分隔行所在段落)
  tr.insert(prevRow.from + table.nodeSize, schema.nodes.paragraph.create());
  // 光标落入空表体首格(与 Typora 一致):table→head→行→…逐层推进
  let pos = prevRow.from + 1; // table 内容起点 = table_head
  pos += 1; // 表头行起点
  pos += headerRow.nodeSize; // 越过表头行 → table_body 起点
  pos += 1; // 表体行起点
  pos += 1; // 首格起点
  pos += 1; // 首格内容起点(空格内文本位置)
  tr.setSelection(TextSelection.near(tr.doc.resolve(pos), 1));
  return tr;
});

// ─── 聚合所有 InputRules 插件 ────────────────────────────

export function buildInputRules() {
  return inputRules({
    rules: [
      ...headingRules,
      taskListRule,
      ...listRules,
      blockquoteRule,
      codeBlockRule,
      hrRule,
      // E7(v0.9.3):顺序敏感——image 在 link 前(链接正则是图片正则的子串);
      // table 在 mark 规则前无特殊要求,但 hrRule 须在前("---" 单独成行仍走水平线)
      mathBlockRule,
      mathInlineRule,
      tableInputRule,
      imageInputRule,
      linkInputRule,
      footnoteRefInputRule,
      footnoteDefInputRule,
      tocInputRule,
      ...markRules,
    ],
  });
}
