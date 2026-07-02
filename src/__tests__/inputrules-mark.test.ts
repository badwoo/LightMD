/**
 * InputRule 行为验证测试
 *
 * 验证 markRule 函数对现有规则（strong/em/strike）和新增规则（mark/sup/sub）的实际处理结果。
 * 通过模拟 handleTextInput 触发 InputRule，检查最终文档内容与 mark 范围是否正确。
 */
import { describe, it, expect } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { Node } from "prosemirror-model";
import { lightMDSchema as schema } from "../core/schema";
import { buildInputRules } from "../core/inputrules";

/** 创建只含一个段落的文档，段内文本为 text */
function createDoc(text: string): Node {
  const safe = text.length > 0 ? text : "\u200B";
  return schema.topNodeType.create(null, [
    schema.nodes.paragraph.create(null, schema.text(safe)),
  ]);
}

/**
 * 模拟在文档末尾输入 inputText，触发 InputRule。
 * 返回处理后的文档与是否被 InputRule 处理。
 */
function triggerInputAtEnd(docText: string, inputText: string): { doc: Node; handled: boolean } {
  const doc = createDoc(docText);
  // 光标位于段落内文本末尾：1（段落起始）+ 文本长度
  const pos = 1 + docText.length;
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, pos),
    plugins: [buildInputRules()],
  });
  const plugin = buildInputRules();
  let newState = state;
  const fakeView: any = {
    state,
    dispatch: (tr: any) => { newState = state.apply(tr); },
  };
  const props = plugin.spec.props as any;
  const handled = props?.handleTextInput ? props.handleTextInput(fakeView, pos, pos, inputText) : false;
  return { doc: newState.doc, handled: !!handled };
}

/** 获取段落内的纯文本内容 */
function paraText(doc: Node): string {
  let text = "";
  doc.forEach((block) => {
    block.forEach((node) => {
      if (node.isText) text += node.text || "";
    });
  });
  return text;
}

/** 检查文档段落内是否存在指定 mark */
function hasMark(doc: Node, markName: string): boolean {
  let found = false;
  doc.nodesBetween(0, doc.content.size, (node) => {
    if (node.isText && node.marks.some((m) => m.type.name === markName)) {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

/** 获取第一个带 mark 的文本节点的内容 */
function firstMarkedText(doc: Node, markName: string): string {
  let result = "";
  doc.nodesBetween(0, doc.content.size, (node) => {
    if (result) return false;
    if (node.isText && node.marks.some((m) => m.type.name === markName)) {
      result = node.text || "";
      return false;
    }
    return true;
  });
  return result;
}

// ─── 现有规则：strong（**text**） ────────────────────────────
describe("现有 InputRule: strong (**text**)", () => {
  it("输入 **text** 应触发 strong mark 且保留完整 text", () => {
    // 先输入 **text*（7 字符），再输入最后的 * 触发规则
    const { doc, handled } = triggerInputAtEnd("**text*", "*");
    expect(handled).toBe(true);
    expect(hasMark(doc, "strong")).toBe(true);
    // 关键：mark 应作用于完整的 "text"，而非截断的内容
    expect(firstMarkedText(doc, "strong")).toBe("text");
    // 段落剩余文本不应包含 ** 标记
    expect(paraText(doc)).toBe("text");
  });
});

// ─── 现有规则：em（*text*） ──────────────────────────────
describe("现有 InputRule: em (*text*)", () => {
  it("输入 *text* 应触发 em mark 且保留完整 text", () => {
    const { doc, handled } = triggerInputAtEnd("*text", "*");
    expect(handled).toBe(true);
    expect(hasMark(doc, "em")).toBe(true);
    expect(firstMarkedText(doc, "em")).toBe("text");
    expect(paraText(doc)).toBe("text");
  });
});

// ─── 现有规则：strike（~~text~~） ─────────────────────────
describe("现有 InputRule: strike (~~text~~)", () => {
  it("输入 ~~text~~ 应触发 strike mark 且保留完整 text", () => {
    const { doc, handled } = triggerInputAtEnd("~~text~", "~");
    expect(handled).toBe(true);
    expect(hasMark(doc, "strike")).toBe(true);
    expect(firstMarkedText(doc, "strike")).toBe("text");
    expect(paraText(doc)).toBe("text");
  });
});

// ─── 新增规则：mark（==text==） ──────────────────────────
describe("新增 InputRule: mark (==text==)", () => {
  it("输入 ==text== 应触发 mark 且保留完整 text", () => {
    const { doc, handled } = triggerInputAtEnd("==text=", "=");
    expect(handled).toBe(true);
    expect(hasMark(doc, "mark")).toBe(true);
    expect(firstMarkedText(doc, "mark")).toBe("text");
    expect(paraText(doc)).toBe("text");
  });
});

// ─── 新增规则：superscript（^sup^） ───────────────────────
describe("新增 InputRule: superscript (^sup^)", () => {
  it("输入 ^sup^ 应触发 superscript mark 且保留完整 sup", () => {
    const { doc, handled } = triggerInputAtEnd("^sup", "^");
    expect(handled).toBe(true);
    expect(hasMark(doc, "superscript")).toBe(true);
    expect(firstMarkedText(doc, "superscript")).toBe("sup");
    expect(paraText(doc)).toBe("sup");
  });
});

// ─── 新增规则：subscript（~sub~） ────────────────────────
describe("新增 InputRule: subscript (~sub~)", () => {
  it("输入 ~sub~ 应触发 subscript mark 且保留完整 sub", () => {
    const { doc, handled } = triggerInputAtEnd("~sub", "~");
    expect(handled).toBe(true);
    expect(hasMark(doc, "subscript")).toBe(true);
    expect(firstMarkedText(doc, "subscript")).toBe("sub");
    expect(paraText(doc)).toBe("sub");
  });

  it("下标 ~sub~ 不应与删除线 ~~text~~ 冲突", () => {
    // 输入 ~~text~ 后再输入 ~，应触发删除线而非下标
    const { doc, handled } = triggerInputAtEnd("~~text~", "~");
    expect(handled).toBe(true);
    // 应该是 strike 而非 subscript
    expect(hasMark(doc, "strike")).toBe(true);
    expect(hasMark(doc, "subscript")).toBe(false);
  });
});
