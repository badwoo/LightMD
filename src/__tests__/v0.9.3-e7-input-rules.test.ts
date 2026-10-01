/**
 * E7(v0.9.3):输入规则补全 —— 公式 / 表格 / 图片 / 链接 / 脚注 / toc
 *
 * 打字即所得(Typora 对齐):
 * - $x$ 即时触发行内公式;$$ 触发块级公式
 * - [文本](url)、![alt|W](src)、[^1]、[^1]: 、[toc] 以空格触发
 *   (auto-pair overtype 会吞掉 ")",故不能用 ")" 触发,与 Typora 同款)
 * - 表格:分隔行输入完成(末键 - 或 |)且上一段为管道行时,两段转表格
 */
import { describe, it, expect } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import type { Node } from "prosemirror-model";
import { lightMDSchema as schema } from "../core/schema";
import { buildInputRules } from "../core/inputrules";
import { docToMarkdown } from "../core/markdown/serializer";
import { findPipeRowBefore } from "../core/inputrules";

/** 构造单段落文档 */
function doc1(text: string): Node {
  return schema.topNodeType.create(null, [
    schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined),
  ]);
}

/** 两段文档 */
function doc2(t1: string, t2: string): Node {
  return schema.topNodeType.create(null, [
    schema.nodes.paragraph.create(null, t1 ? schema.text(t1) : undefined),
    schema.nodes.paragraph.create(null, t2 ? schema.text(t2) : undefined),
  ]);
}

/**
 * 模拟在最后一个文本节点末尾追加输入一个字符,触发 InputRule。
 */
function typeChar(doc: Node, inputText: string): { doc: Node; handled: boolean } {
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

function firstNode(doc: Node, name: string): Node | null {
  let found: Node | null = null;
  doc.descendants((n) => {
    if (n.type.name === name && !found) found = n;
  });
  return found;
}

describe("E7: 行内公式 $x$(即时触发)", () => {
  it("顶层段落输入 $E=mc^2$ → math_inline,序列化往返", () => {
    const { handled, doc } = typeChar(doc1("$E=mc^2"), "$");
    expect(handled).toBe(true);
    const math = firstNode(doc, "math_inline")!;
    expect(math).toBeTruthy();
    expect(math!.attrs.latex).toBe("E=mc^2");
    expect(docToMarkdown(doc)).toBe("$E=mc^2$\n");
  });

  it("行中输入(前面有文字)也触发 —— 数学可出现在句中", () => {
    const { handled, doc } = typeChar(doc1("动能 $E=mc"), "$");
    expect(handled).toBe(true);
    expect(firstNode(doc, "math_inline")).toBeTruthy();
    expect(doc.textContent).toContain("动能 ");
  });

  it("行内公式可出现在表格单元格中(可输入 inline 的文本块)", () => {
    // 单元格内手工构造:$a$ 输入最后一个 $
    const cell = schema.nodes.table_cell.create({ align: "left" }, schema.text("$a"));
    const row = schema.nodes.table_row.create(null, [cell]);
    const body = schema.nodes.table_body.create(null, [row]);
    const table = schema.nodes.table.create(null, [body]);
    const doc = schema.topNodeType.create(null, [table]);
    let pos = 0;
    doc.descendants((n, p) => {
      if (n.isText) pos = p + n.nodeSize;
    });
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, pos),
      plugins: [buildInputRules()],
    });
    let newState = state;
    const plugin = buildInputRules();
    const fakeView = { state, dispatch: (tr: Parameters<typeof state.apply>[0]) => { newState = state.apply(tr); } };
    const props = (plugin.spec.props as Record<string, unknown>) ?? {};
    const handled = (props.handleTextInput as (v: unknown, f: number, t: number, s: string) => boolean)(
      fakeView, pos, pos, "$",
    );
    expect(handled).toBe(true);
    expect(firstNode(newState.doc, "math_inline")).toBeTruthy();
  });

  it("代码块内输入 $...$ 不触发(保持字面)", () => {
    const doc = schema.topNodeType.create(null, [
      schema.nodes.code_block.create({ language: "" }, schema.text("$a")),
    ]);
    let pos = 0;
    doc.descendants((n, p) => {
      if (n.isText) pos = p + n.nodeSize;
    });
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, pos),
      plugins: [buildInputRules()],
    });
    const plugin = buildInputRules();
    const fakeView = { state, dispatch: () => {} };
    const props = (plugin.spec.props as Record<string, unknown>) ?? {};
    const handled = (props.handleTextInput as (v: unknown, f: number, t: number, s: string) => boolean)(
      fakeView, pos, pos, "$",
    );
    expect(handled).toBe(false);
  });
});

describe("E7: 块级公式 $$", () => {
  it("行首输入第二个 $ → math_block(光标在块内)", () => {
    const { handled, doc } = typeChar(doc1("$"), "$");
    expect(handled).toBe(true);
    expect(firstNode(doc, "math_block")).toBeTruthy();
  });

  it("行中输入 $$ 不触发块级(行首守卫)", () => {
    const { handled, doc } = typeChar(doc1("a$"), "$");
    expect(handled).toBe(false);
    expect(firstNode(doc, "math_block")).toBeNull();
  });
});

describe("E7: 链接 [文本](url) + 空格", () => {
  it("转换 text + link mark,空格保留在链接后", () => {
    const { handled, doc } = typeChar(doc1("[文本](https://a.b)"), " ");
    expect(handled).toBe(true);
    let linked = "";
    doc.descendants((n) => {
      const link = n.marks.find((m) => m.type.name === "link");
      if (n.isText && link) linked += n.text + "|" + link.attrs.href;
    });
    expect(linked).toBe("文本|https://a.b");
    expect(docToMarkdown(doc)).toBe("[文本](https://a.b) \n");
  });

  it("javascript: 危险 scheme 不转换(保留字面文本)", () => {
    const { handled, doc } = typeChar(doc1("[x](javascript:alert(1))"), " ");
    expect(handled).toBe(false);
    expect(doc.textContent).toContain("javascript:");
    let hasLink = false;
    doc.descendants((n) => {
      if (n.marks.some((m) => m.type.name === "link")) hasLink = true;
    });
    expect(hasLink).toBe(false);
  });

  it("图片语法 ![a](b) 不被链接规则抢先(图片规则在前)", () => {
    const { handled, doc } = typeChar(doc1("![a](b.png)"), " ");
    expect(handled).toBe(true);
    expect(firstNode(doc, "image")).toBeTruthy();
  });
});

describe("E7: 图片 ![alt|W](src) + 空格", () => {
  it("转换 image 节点,含尺寸属性", () => {
    const { handled, doc } = typeChar(doc1("![封面|300](x.png)"), " ");
    expect(handled).toBe(true);
    const img = firstNode(doc, "image")!;
    expect(img!.attrs.src).toBe("x.png");
    expect(img!.attrs.alt).toBe("封面");
    expect(img!.attrs.width).toBe(300);
    expect(docToMarkdown(doc)).toBe("![封面|300](x.png) \n");
  });

  it("无尺寸语法 → width=null", () => {
    const { handled, doc } = typeChar(doc1("![a](b.png)"), " ");
    expect(handled).toBe(true);
    expect(firstNode(doc, "image")!.attrs.width).toBeNull();
  });
});

describe("E7: 脚注 [^1] / [^1]: ", () => {
  it("行中 [^1] + 空格 → footnote_ref", () => {
    const { handled, doc } = typeChar(doc1("见注[^1]"), " ");
    expect(handled).toBe(true);
    const ref = firstNode(doc, "footnote_ref")!;
    expect(ref!.attrs.label).toBe("1");
    expect(doc.textContent).toContain("见注");
  });

  it("行首 [^1]: + 空格 → footnote_definition(整块替换)", () => {
    const { handled, doc } = typeChar(doc1("[^1]:"), " ");
    expect(handled).toBe(true);
    const def = firstNode(doc, "footnote_definition")!;
    expect(def).toBeTruthy();
    expect(def!.attrs.label).toBe("1");
    expect(docToMarkdown(doc)).toBe("[^1]: \n");
  });

  it("定义规则要求行首:行中输入 [^1]: + 空格 不转换", () => {
    const { handled, doc } = typeChar(doc1("x[^1]:"), " ");
    expect(handled).toBe(false);
    expect(firstNode(doc, "footnote_definition")).toBeNull();
  });
});

describe("E7: 目录 [toc] + 空格", () => {
  it("行首 [toc] + 空格 → toc 节点 + 后随空段落", () => {
    const { handled, doc } = typeChar(doc1("[toc]"), " ");
    expect(handled).toBe(true);
    expect(firstNode(doc, "toc")).toBeTruthy();
    expect(docToMarkdown(doc)).toBe("[toc]\n\n");
  });

  it("[[toc]] 变体同样触发", () => {
    const { handled, doc } = typeChar(doc1("[[toc]]"), " ");
    expect(handled).toBe(true);
    expect(firstNode(doc, "toc")).toBeTruthy();
  });

  it("行中 [toc] 不触发(须独占一行)", () => {
    const { handled, doc } = typeChar(doc1("xx [toc]"), " ");
    expect(handled).toBe(false);
    expect(firstNode(doc, "toc")).toBeNull();
  });
});

describe("E7: 表格(分隔行末尾 | 触发)", () => {
  it("上一段为管道行 + 分隔行完成 → 两段转表格(表头+空表体)", () => {
    const { handled, doc } = typeChar(doc2("a | b", "| --- | ---"), "|");
    expect(handled).toBe(true);
    const table = firstNode(doc, "table")!;
    expect(table).toBeTruthy();
    // 原两段被替换;转换后仅剩表后空段落供继续输入
    expect(doc.childCount).toBe(2);
    expect(doc.lastChild!.type.name).toBe("paragraph");
    expect(doc.lastChild!.content.size).toBe(0);
    // 表头单元格
    const headers: string[] = [];
    doc.descendants((n) => {
      if (n.type.name === "table_header") headers.push(n.textContent);
    });
    expect(headers).toEqual(["a", "b"]);
    // 序列化:表头 + 分隔行 + 一行空表体
    expect(docToMarkdown(doc)).toBe("| a | b |\n| --- | --- |\n|   |   |\n\n");
  });

  it("无尾管道分隔行(| --- | --- + -)同样触发", () => {
    const { handled, doc } = typeChar(doc2("a | b", "| --- | ---"), "-");
    expect(handled).toBe(true);
    expect(firstNode(doc, "table")).toBeTruthy();
  });

  it("带对齐分隔行 → 对齐写入单元格 attrs", () => {
    const { handled, doc } = typeChar(doc2("a | b | c", "| :--- | :---: | ---:"), "|");
    expect(handled).toBe(true);
    const aligns: string[] = [];
    doc.descendants((n) => {
      if (n.type.name === "table_header") aligns.push(n.attrs.align);
    });
    expect(aligns).toEqual(["left", "center", "right"]);
  });

  it("上一段非管道行 → 不转换(分隔行保持文本)", () => {
    const { handled, doc } = typeChar(doc2("普通段落", "| --- | ---"), "|");
    expect(handled).toBe(false);
    expect(firstNode(doc, "table")).toBeNull();
  });

  it("--- 仍走水平线规则(分隔行无管道时让位,回归 E3)", () => {
    const { handled, doc } = typeChar(doc1("--"), "-");
    expect(handled).toBe(true);
    expect(firstNode(doc, "horizontal_rule")).toBeTruthy();
    expect(firstNode(doc, "table")).toBeNull();
  });
});

describe("E7: findPipeRowBefore 纯函数", () => {
  it("返回上一段管道行内容与区间", () => {
    const doc = doc2("a | b", "x");
    // 段1 nodeSize = 5+2 = 7;第二段内容起点 = 7+1
    const row = findPipeRowBefore(doc, 7 + 1);
    expect(row).toBeTruthy();
    expect(row!.cells).toEqual(["a", "b"]);
    expect(row!.from).toBe(0);
  });

  it("上一段无管道 → null", () => {
    const doc = doc2("纯文本", "x");
    // 段1 nodeSize = 3+2 = 5;第二段内容起点 = 5+1
    const row = findPipeRowBefore(doc, 5 + 1);
    expect(row).toBeNull();
  });

  it("首段之前无上一段 → null", () => {
    const doc = doc1("a | b");
    expect(findPipeRowBefore(doc, 1)).toBeNull();
  });
});
