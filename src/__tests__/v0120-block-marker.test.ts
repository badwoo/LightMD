/**
 * v0.12.0 需求3：块级语法标记零位移测试
 *
 * 覆盖：
 * 1. 装饰类型为 Decoration.node（NodeType）而非 Decoration.widget
 * 2. 装饰位置为节点边界（before/after），而非 $from.start(depth) 的内容起点
 * 3. blockquote / code_block 标记文本正确（data-md-block-open）
 * 4. 非块（段落）/ 非空选区 → 无装饰
 *
 * v0.12.1 需求1 变更：**标题**不再有 `#`/`##` 标记文本 —— 改为
 * 「节点装饰（.pm-heading-marker，提供定位上下文）+ 绝对定位的级别徽标 widget」。
 * 本文件同步更新标题相关断言；徽标/菜单的行为与交互由 v0121-heading-badge.test.ts 覆盖。
 */
import { describe, it, expect } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import type { Decoration } from "prosemirror-view";
import { wysiwygPlugin } from "../core/plugins/wysiwyg";
import { lightMDSchema as schema } from "../core/schema";

/** Decoration 内部结构视图（公开 .d.ts 隐藏了 widget/type，运行时存在） */
interface DecoInternals {
  widget: boolean;
  type: { attrs: Record<string, string> };
}
const internals = (d: Decoration) => d as unknown as DecoInternals;

function decosFor(doc: PMNode) {
  const state = EditorState.create({ doc, plugins: [wysiwygPlugin] });
  return wysiwygPlugin.getState(state)!.find();
}

/** 只要节点装饰（非 widget）的那一个 */
function nodeDeco(decos: readonly Decoration[]): Decoration {
  const found = decos.find((d) => !internals(d).widget);
  expect(found).toBeTruthy();
  return found!;
}

describe("v0.12.0 需求3：块级标记改用节点装饰（零位移）", () => {
  it("标题：节点装饰只做定位（class=pm-heading-marker），标记由徽标 widget 承担", () => {
    const heading = schema.node("heading", { level: 2 }, [schema.text("标题")]);
    const doc = schema.node("doc", null, [heading]);
    const found = decosFor(doc);
    // 节点装饰 + 级别徽标 widget
    expect(found).toHaveLength(2);

    const node = nodeDeco(found);
    // 关键断言：节点装饰不是 widget（旧实现是 widget + 真实 span，参与行内布局）
    expect(internals(node).widget).toBe(false);
    expect(internals(node).type.attrs.class).toBe("pm-heading-marker");
    // v0.12.1 需求1：标题的 # 语法标记已取消
    expect(internals(node).type.attrs["data-md-block-open"]).toBeUndefined();

    // 节点边界：from=0（before），to=nodeSize=4；内容起点是 1（start(depth)），
    // 用旧值会导致装饰范围偏移一个节点
    expect(node.from).toBe(0);
    expect(node.to).toBe(heading.nodeSize);
    expect(node.from).not.toBe(1);

    // 徽标 widget 落在标题内容起点（start + 1），side = -1
    const badge = found.find((d) => internals(d).widget)!;
    expect(badge.from).toBe(1);
  });

  it("引用块：标记 '> '", () => {
    const quote = schema.node("blockquote", null, [
      schema.node("paragraph", null, [schema.text("引用")]),
    ]);
    const doc = schema.node("doc", null, [quote]);
    const found = decosFor(doc);
    expect(found).toHaveLength(1);
    expect(internals(found[0]).widget).toBe(false);
    expect(internals(found[0]).type.attrs["data-md-block-open"]).toBe("> ");
    expect(found[0].from).toBe(0);
    expect(found[0].to).toBe(quote.nodeSize);
  });

  it("代码块：标记 ``` + 语言；无语言时仅 ```", () => {
    const code = schema.node("code_block", { language: "js" }, [schema.text("const a = 1;")]);
    const doc = schema.node("doc", null, [code]);
    const found = decosFor(doc);
    expect(found).toHaveLength(1);
    expect(internals(found[0]).type.attrs["data-md-block-open"]).toBe("```js");

    const codeNoLang = schema.node("code_block", { language: "" }, [schema.text("x")]);
    const found2 = decosFor(schema.node("doc", null, [codeNoLang]));
    expect(internals(found2[0]).type.attrs["data-md-block-open"]).toBe("```");
  });

  it("光标在普通段落 → 无任何块级装饰", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("普通段落")]),
    ]);
    expect(decosFor(doc)).toHaveLength(0);
  });

  it("非空选区（有选中文本）→ 不显示装饰", () => {
    const heading = schema.node("heading", { level: 1 }, [schema.text("标题")]);
    const doc = schema.node("doc", null, [heading]);
    const state = EditorState.create({ doc, plugins: [wysiwygPlugin] });
    // 选区覆盖部分文本（非空）
    const tr = state.tr.setSelection(TextSelection.create(doc, 1, 2));
    const newState = state.apply(tr);
    expect(wysiwygPlugin.getState(newState)!.find()).toHaveLength(0);
  });

  it("标题 3 级：节点装饰为定位类，徽标 widget 存在", () => {
    const heading = schema.node("heading", { level: 3 }, [schema.text("h3")]);
    const found = decosFor(schema.node("doc", null, [heading]));
    const badge = found.find((d) => internals(d).widget)!;
    expect(badge).toBeTruthy();
    // 徽标 DOM 由 createHeadingBadge 构建（H3 文案等），见 v0121-heading-menu.test.tsx
    expect(internals(nodeDeco(found)).type.attrs.class).toBe("pm-heading-marker");
  });
});
