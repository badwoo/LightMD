/**
 * E6(v0.9.4)：行内语法标记显示（inline-mark-reveal）
 *
 * 修复前：阅读模式仅 heading/blockquote/code_block 三种块级前缀显示源码，
 * 所有行内 mark（**、*、`、~~、==、~、^、<u>）与链接从不显示。
 * 修复后：光标进入某个行内 mark 区间（含边界 ±1）时，以 Decoration.inline +
 * 伪元素（CSS content: attr(...)）显示对应源码符号；有选区时不显示；
 * 仅扫描光标所在文本块（性能红线）。
 */
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { lightMDSchema as schema } from "../core/schema";
import {
  inlineMarkRevealPlugin,
  inlineMarkRevealKey,
  collectRevealRanges,
} from "../core/plugins/inline-mark-reveal";

/** 读取 Decoration 上的 attrs（Decoration.type 为 @internal，运行期存在） */
function attrsOf(deco: unknown): Record<string, string> {
  const type = (deco as { type?: { attrs?: Record<string, string> } }).type;
  return type?.attrs || {};
}

/** 构造一段：p("ab" + strong("xy") + "cd")，内容位置 ab=1..3, xy=3..5, cd=5..7 */
function boldDoc(): ReturnType<typeof schema.topNodeType.create> {
  return schema.topNodeType.create(null, [
    schema.nodes.paragraph.create(null, [
      schema.text("ab"),
      schema.text("xy", [schema.mark("strong")]),
      schema.text("cd"),
    ]),
  ]);
}

function stateWith(doc: ReturnType<typeof schema.topNodeType.create>, from: number, to = from): EditorState {
  return EditorState.create({
    doc,
    selection: TextSelection.create(doc, from, to),
    plugins: [inlineMarkRevealPlugin],
  });
}

describe("E6：行内 mark 区间收集（纯函数）", () => {
  it("光标在加粗区间内 → 收集到 ** 包裹区间", () => {
    const doc = boldDoc();
    const para = doc.firstChild!;
    // para 内容起始 = 1
    const ranges = collectRevealRanges(para, 1, 4);
    expect(ranges).toEqual([{ from: 3, to: 5, open: "**", close: "**" }]);
  });

  it("光标在标记外 → 不收集", () => {
    const doc = boldDoc();
    const para = doc.firstChild!;
    expect(collectRevealRanges(para, 1, 7)).toEqual([]);
  });

  it("光标紧贴区间边界（±1）→ 仍收集", () => {
    const doc = boldDoc();
    const para = doc.firstChild!;
    expect(collectRevealRanges(para, 1, 2).length).toBe(1); // to = from-1 = 2
    expect(collectRevealRanges(para, 1, 6).length).toBe(1); // to = to+1 = 6
  });

  it("link 区间 → open='[' 且 close='](href)'", () => {
    const doc = schema.topNodeType.create(null, [
      schema.nodes.paragraph.create(null, [
        schema.text("ab"),
        schema.text("go", [schema.mark("link", { href: "https://x.dev" })]),
      ]),
    ]);
    const ranges = collectRevealRanges(doc.firstChild!, 1, 4);
    expect(ranges).toEqual([
      { from: 3, to: 5, open: "[", close: "](https://x.dev)", href: "https://x.dev" },
    ]);
  });

  it("相邻同 mark 文本节点合并为一个区间", () => {
    const doc = schema.topNodeType.create(null, [
      schema.nodes.paragraph.create(null, [
        schema.text("a", [schema.mark("em")]),
        schema.text("b", [schema.mark("em")]),
      ]),
    ]);
    const ranges = collectRevealRanges(doc.firstChild!, 1, 2);
    expect(ranges.length).toBe(1);
    expect(ranges[0].open).toBe("*");
    expect(ranges[0]).toEqual({ from: 1, to: 3, open: "*", close: "*" });
  });
});

describe("E6：插件装饰行为", () => {
  it("光标进入加粗文本 → 生成 md-reveal 装饰", () => {
    const state = stateWith(boldDoc(), 4);
    const set = inlineMarkRevealKey.getState(state)!;
    const decos = set.find();
    expect(decos.length).toBe(1);
    expect(decos[0].from).toBe(3);
    expect(decos[0].to).toBe(5);
    expect(attrsOf(decos[0])).toMatchObject({
      class: "md-reveal",
      "data-md-open": "**",
      "data-md-close": "**",
    });
  });

  it("光标移出标记 → 装饰消失", () => {
    const doc = boldDoc();
    let state = stateWith(doc, 4);
    expect(inlineMarkRevealKey.getState(state)!.find().length).toBe(1);
    // 把光标移到段末（标记之外）
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 7)));
    expect(inlineMarkRevealKey.getState(state)!.find().length).toBe(0);
  });

  it("有选区时不显示（与块级 marker 行为一致）", () => {
    const state = stateWith(boldDoc(), 3, 5);
    expect(inlineMarkRevealKey.getState(state)!.find().length).toBe(0);
  });

  it("link 装饰带 data-href", () => {
    const doc = schema.topNodeType.create(null, [
      schema.nodes.paragraph.create(null, [
        schema.text("go", [schema.mark("link", { href: "https://a.b" })]),
      ]),
    ]);
    const decos = inlineMarkRevealKey.getState(stateWith(doc, 2))!.find();
    expect(decos.length).toBe(1);
    expect(attrsOf(decos[0])["data-href"]).toBe("https://a.b");
    expect(attrsOf(decos[0])["data-md-open"]).toBe("[");
  });

  it("仅扫描光标所在文本块：其他块的 mark 不产生装饰", () => {
    // 两个段落各含一处加粗：p0 内容 1..8，p1 内容 9..16
    const doc = schema.topNodeType.create(null, [
      schema.nodes.paragraph.create(null, [
        schema.text("aa"),
        schema.text("xy", [schema.mark("strong")]),
      ]),
      schema.nodes.paragraph.create(null, [
        schema.text("bb"),
        schema.text("zz", [schema.mark("strong")]),
      ]),
    ]);
    // 光标在 p0 的加粗内（pos 4）
    const decos = inlineMarkRevealKey.getState(stateWith(doc, 4))!.find();
    expect(decos.length).toBe(1);
    // 只有 p0 内的 3..5，p1 内的加粗（11..13）未被扫描
    expect(decos[0].from).toBe(3);
    expect(decos[0].to).toBe(5);
    expect(decos.some((d) => d.from >= 9)).toBe(false);
  });

  it("文档变化后重算：删除 mark 文本 → 装饰同步消失", () => {
    let state = stateWith(boldDoc(), 4);
    expect(inlineMarkRevealKey.getState(state)!.find().length).toBe(1);
    // 删除整段内容（0..doc.content.size 内容区间 1..7）
    state = state.apply(state.tr.delete(1, 7));
    expect(inlineMarkRevealKey.getState(state)!.find().length).toBe(0);
  });
});
