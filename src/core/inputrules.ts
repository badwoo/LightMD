/**
 * ProseMirror InputRules —— Markdown 语法即时转换
 */
import { InputRule, inputRules } from "prosemirror-inputrules";
import { TextSelection } from "prosemirror-state";
import type { NodeType, MarkType } from "prosemirror-model";
import { lightMDSchema } from "./schema";

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

const hrRule = new InputRule(/^(---|\*\*\*)$/, (state, match, start, end) => {
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
  markRule(
    /(`)(.*?)\1$/,
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
      ...markRules,
    ],
  });
}
