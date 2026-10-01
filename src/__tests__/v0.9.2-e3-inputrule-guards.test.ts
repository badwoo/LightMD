/**
 * E3(v0.9.2):hrRule 与 codeBlockRule 行首守卫测试
 *
 * 修复前:hrRule / codeBlockRule 无任何守卫,在列表项、引用块等嵌套块内
 * 输入 --- 或 ``` 也会被转换为水平线/代码块,序列化时嵌套结构易错乱。
 * 修复后:仅顶层 paragraph/heading 行首触发;嵌套块内保持字面文本。
 * 同时 hr 规则支持 ___ 变体(与 ---/*** 等价)。
 */
import { describe, it, expect } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import type { Node } from "prosemirror-model";
import { lightMDSchema as schema } from "../core/schema";
import { buildInputRules } from "../core/inputrules";

/** 构造单段落文档 */
function doc1(text: string): Node {
  return schema.topNodeType.create(null, [
    schema.nodes.paragraph.create(null, schema.text(text)),
  ]);
}

/**
 * 模拟在指定文档的段落文本末尾追加输入一个字符,触发 InputRule。
 * 返回是否被 InputRule 处理及处理后的文档。
 */
function typeChar(doc: Node, inputText: string): { doc: Node; handled: boolean } {
  // 光标:唯一段落(顶层或嵌套)文本末尾——由调用方保证文档只有一个叶子段落
  let pos = 0;
  doc.descendants((node, p) => {
    if (node.isText) pos = p + node.nodeSize;
  });
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, pos),
    plugins: [buildInputRules()],
  });
  let newState = state;
  const plugin = buildInputRules();
  const fakeView = {
    state,
    dispatch: (tr: Parameters<typeof state.apply>[0]) => {
      newState = state.apply(tr);
    },
  };
  const props = (plugin.spec.props as Record<string, unknown>) ?? {};
  const handleTextInput = props.handleTextInput as
    | ((view: unknown, from: number, to: number, text: string) => boolean)
    | undefined;
  const handled = handleTextInput
    ? handleTextInput(fakeView, pos, pos, inputText)
    : false;
  return { doc: newState.doc, handled: !!handled };
}

/** 顶层段落,已有 "--",输入 "-" → 应转换为水平线 */
function topLevelPara(text: string): Node {
  return doc1(text);
}

/** 列表项内段落 */
function paraInListItem(text: string): Node {
  return schema.topNodeType.create(null, [
    schema.nodes.bullet_list.create(null, [
      schema.nodes.list_item.create(null, [
        schema.nodes.paragraph.create(null, schema.text(text)),
      ]),
    ]),
  ]);
}

/** 引用块内段落 */
function paraInQuote(text: string): Node {
  return schema.topNodeType.create(null, [
    schema.nodes.blockquote.create(null, [
      schema.nodes.paragraph.create(null, schema.text(text)),
    ]),
  ]);
}

function hasHorizontalRule(doc: Node): boolean {
  let found = false;
  doc.descendants((node) => {
    if (node.type.name === "horizontal_rule") found = true;
  });
  return found;
}

function hasCodeBlock(doc: Node): boolean {
  let found = false;
  doc.descendants((node) => {
    if (node.type.name === "code_block") found = true;
  });
  return found;
}

describe("E3: hrRule 行首守卫与 ___ 变体", () => {
  it("顶层段落行首输入第三个 - → 转换为水平线(既有行为回归)", () => {
    const { handled, doc } = typeChar(topLevelPara("--"), "-");
    expect(handled).toBe(true);
    expect(hasHorizontalRule(doc)).toBe(true);
  });

  it("顶层段落行首输入第三个 * → 转换为水平线(既有行为回归)", () => {
    const { handled, doc } = typeChar(topLevelPara("**"), "*");
    expect(handled).toBe(true);
    expect(hasHorizontalRule(doc)).toBe(true);
  });

  it("顶层段落行首输入第三个 _ → 转换为水平线(新增 ___ 变体)", () => {
    const { handled, doc } = typeChar(topLevelPara("__"), "_");
    expect(handled).toBe(true);
    expect(hasHorizontalRule(doc)).toBe(true);
  });

  it("列表项内段落输入第三个 - → 保持文本", () => {
    const { handled, doc } = typeChar(paraInListItem("--"), "-");
    expect(handled).toBe(false);
    expect(hasHorizontalRule(doc)).toBe(false);
  });

  it("引用块内段落输入第三个 - → 保持文本", () => {
    const { handled, doc } = typeChar(paraInQuote("--"), "-");
    expect(handled).toBe(false);
    expect(hasHorizontalRule(doc)).toBe(false);
  });

  it("顶层段落行中输入(前有文本)不触发 —— 正则 ^ 锚定固有行首语义", () => {
    const { handled, doc } = typeChar(topLevelPara("abc--"), "-");
    expect(handled).toBe(false);
    expect(hasHorizontalRule(doc)).toBe(false);
  });
});

describe("E3: codeBlockRule 行首守卫", () => {
  it("顶层段落行首输入第三个 ` → 转换为代码块(既有行为回归)", () => {
    const { handled, doc } = typeChar(topLevelPara("``"), "`");
    expect(handled).toBe(true);
    expect(hasCodeBlock(doc)).toBe(true);
  });

  it("列表项内段落输入第三个 ` → 保持文本", () => {
    const { handled, doc } = typeChar(paraInListItem("``"), "`");
    expect(handled).toBe(false);
    expect(hasCodeBlock(doc)).toBe(false);
  });

  it("引用块内段落输入第三个 ` → 保持文本", () => {
    const { handled, doc } = typeChar(paraInQuote("``"), "`");
    expect(handled).toBe(false);
    expect(hasCodeBlock(doc)).toBe(false);
  });
});
