// @vitest-environment jsdom
/**
 * v0.12.3 需求12：阅读模式回车 = 换行（三模式换行数一一对应）
 *
 * 用户反馈（v0.12.2 实机）：
 *   ① 阅读模式编辑文本，只按了一次回车，切到编辑/分屏模式却多出一个**空行**；
 *   ② 阅读模式里编辑文字**行间距很高**，与其他文档观感不一致。
 * 两者同源：回车被 `baseKeymap.splitBlock` 解释成"新建段落"，而 Markdown 的段落
 * 之间必须空行（`第一行\n\n第二行`），且段落带 0.8em 上下 margin。
 *
 * 目标口径：**N 次回车 → 源文本恰好 N 个换行**。
 *
 * 测试形态（吸取 0.12.1 教训）：全部走**真实 createEditor 挂载 + 真实 keymap 插件链**，
 * 断言"按键后的 doc 结构 + 真实序列化文本 + 重开后的结构"，而非源码文本正则。
 */
import { describe, it, expect } from "vitest";
import type { EditorView } from "prosemirror-view";
import { TextSelection } from "prosemirror-state";
import { createEditor } from "../core/editor";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import { lightMDSchema } from "../core/schema";

/** 挂载真实编辑器（真实 createEditor + 全部插件/NodeView） */
function mount(md: string): EditorView {
  const place = document.createElement("div");
  document.body.appendChild(place);
  const view = createEditor({ parent: place, initialContent: md });
  if (!view) throw new Error("createEditor 返回 null");
  view.focus();
  return view;
}

/**
 * 通过**真实 keymap 插件链**派发按键。
 * 与浏览器事件走同一条 `someProp("handleKeyDown")` 路径（插件顺序 = 生产顺序：
 * dynamicShortcuts → buildKeymap → keymap(baseKeymap)），从而证明"回车究竟落到哪个命令"。
 */
function press(
  view: EditorView,
  key: string,
  opts: { shift?: boolean; composing?: boolean } = {},
): boolean {
  const event = {
    key,
    keyCode: key === "Enter" ? 13 : 0,
    shiftKey: !!opts.shift,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    preventDefault() {},
    stopPropagation() {},
  } as unknown as KeyboardEvent;
  const run = () => view.someProp("handleKeyDown", (f) => f(view, event)) ?? false;
  if (!opts.composing) return run();
  // EditorView.composing 是原型上的 getter，测试里用自有属性临时遮蔽
  Object.defineProperty(view, "composing", { value: true, configurable: true });
  try {
    return run();
  } finally {
    delete (view as unknown as Record<string, unknown>).composing;
  }
}

const caretToEnd = (view: EditorView) =>
  view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));

const type = (view: EditorView, text: string) =>
  view.dispatch(view.state.tr.insertText(text));

/** 真实序列化文本（= 切到编辑/分屏模式时 textarea 看到的内容） */
const source = (view: EditorView) => docToMarkdown(view.state.doc);

/** 结构指纹：顶层块类型 + 每块内的段内换行数（用于"重开是否等价"断言） */
function shape(view: EditorView): string {
  const out: string[] = [];
  view.state.doc.forEach((n) => {
    let hb = 0;
    n.descendants((c) => {
      if (c.type.name === "hard_break") hb++;
      return true;
    });
    out.push(hb ? `${n.type.name}#${hb}` : n.type.name);
  });
  return out.join(",");
}

function shapeOfMarkdown(md: string): string {
  const doc = markdownToDoc(md);
  const out: string[] = [];
  doc.forEach((n) => {
    let hb = 0;
    n.descendants((c) => {
      if (c.type.name === "hard_break") hb++;
      return true;
    });
    out.push(hb ? `${n.type.name}#${hb}` : n.type.name);
  });
  return out.join(",");
}

const countBlocks = (view: EditorView) => view.state.doc.childCount;

describe("回车 = 换行：阅读模式与源文本一一对应", () => {
  it("单次回车 → 源码只多一个换行（不出现空行）", () => {
    const view = mount("第一行");
    caretToEnd(view);
    expect(press(view, "Enter")).toBe(true);
    type(view, "第二行");

    // 关键断言：编辑/分屏模式里看到的是相邻两行，不是"第一行 / 空行 / 第二行"
    expect(source(view)).toBe("第一行  \n第二行\n");
    expect(shape(view)).toBe("paragraph#1");
    expect(shapeOfMarkdown(source(view))).toBe(shape(view));
  });

  it("连续两次回车 → 源码出现一个空行（2 个换行）", () => {
    const view = mount("第一行");
    caretToEnd(view);
    press(view, "Enter");
    press(view, "Enter");
    type(view, "第二行");

    expect(source(view)).toBe("第一行\n\n第二行\n");
    expect(shape(view)).toBe("paragraph,paragraph");
    // 展开结构：换行数一一对应且往返稳定
    expect(shapeOfMarkdown(source(view))).toBe(shape(view));
  });

  it("连续三次回车 → 源码出现两个空行（3 个换行）", () => {
    const view = mount("第一行");
    caretToEnd(view);
    press(view, "Enter");
    press(view, "Enter");
    press(view, "Enter");
    type(view, "第二行");

    expect(source(view)).toBe("第一行\n\n\n第二行\n");
    // 去掉文件末尾换行后，正文之间恰好 3 个换行
    expect(source(view).replace(/\n$/, "").split("\n").length - 1).toBe(3);
    expect(shapeOfMarkdown(source(view))).toBe(shape(view));
  });

  it("N 次回车 = N 个换行（1→4 全覆盖）", () => {
    const newlineCount = (md: string) => md.replace(/\n$/, "").split("\n").length - 1;
    for (let n = 1; n <= 4; n++) {
      const view = mount("A");
      caretToEnd(view);
      for (let i = 0; i < n; i++) press(view, "Enter");
      type(view, "B");
      const md = source(view);
      expect(newlineCount(md), `n=${n} → ${JSON.stringify(md)}`).toBe(n);
      expect(shapeOfMarkdown(md), `n=${n} 结构往返`).toBe(shape(view));
    }
  });

  it("列模式：单回车行的视觉行距 = 行高（不再有段落 margin 叠加）", () => {
    // 结构断言：单回车不产生新段落 → 不会叠加 `.ProseMirror > p` 的 0.8em 上下 margin
    const view = mount("第一行");
    caretToEnd(view);
    press(view, "Enter");
    type(view, "第二行");
    expect(countBlocks(view)).toBe(1);
  });
});

describe("回车语义的作用域与守卫（零回归）", () => {
  it("列表项内回车仍然分裂条目（不被段内换行接管）", () => {
    const view = mount("- 项目一");
    caretToEnd(view);
    expect(press(view, "Enter")).toBe(true);
    type(view, "项目二");

    expect(source(view)).toBe("- 项目一\n- 项目二\n");
    expect(shape(view)).toBe("bullet_list");
    expect(shapeOfMarkdown(source(view))).toBe(shape(view));
  });

  it("引用块内回车仍然新建段落（depth ≥ 2 不接管）", () => {
    const view = mount("> 引用一");
    caretToEnd(view);
    press(view, "Enter");
    type(view, "引用二");
    expect(source(view)).toBe("> 引用一\n>\n> 引用二\n");
  });

  it("段首回车仍然另起一段（交回 baseKeymap，不插入段内换行）", () => {
    const view = mount("第一行");
    // 光标置于段首（doc 起点后第 1 个位置 = 段内 offset 0）
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
    press(view, "Enter");
    expect(shape(view)).toBe("paragraph,paragraph");
    expect(source(view)).toBe("\n第一行\n");
  });

  it("跨块选区内回车不插入段内换行（v0.12.2 P4 守卫保持）", () => {
    // v0.12.2 P4 的缺陷是：无空选区守卫时 replaceSelectionWith(hard_break) 会先删掉整个
    // 跨块选区并把两段并成一段。现在非空选区一律交回 splitBlock（不产生 hard_break）。
    const view = mount("第一段\n\n第二段");
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, 2, 6)),
    );
    press(view, "Enter");
    let hb = 0;
    view.state.doc.descendants((n) => {
      if (n.type.name === "hard_break") hb++;
      return true;
    });
    expect(hb).toBe(0);
  });

  it("IME 组合期回车不插入段内换行", () => {
    const view = mount("第一行");
    caretToEnd(view);
    press(view, "Enter", { composing: true });
    // 组合期不产生 hard_break（PM 本身也会在 inOrNearComposition 时直接 return）
    expect(shape(view)).not.toContain("#");
  });

  it("Shift+回车在顶层段落新建段落（与回车对调，保留一次性按键入口）", () => {
    const view = mount("第一行");
    caretToEnd(view);
    expect(press(view, "Enter", { shift: true })).toBe(true);
    type(view, "第二行");
    expect(source(view)).toBe("第一行\n\n第二行\n");
    expect(shape(view)).toBe("paragraph,paragraph");
  });

  it("代码块内回车仍走原生换行（不插入 hard_break 拆块）", () => {
    const view = mount("```js\nconst a = 1\n```");
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, 12)),
    );
    press(view, "Enter");
    expect(shape(view)).toBe("code_block");
  });
});

describe("段内换行的序列化边界（往返保真，防数据损坏）", () => {
  it("危险续行行首被转义：回车后写 --- 不再被吞成 Setext 标题", () => {
    const view = mount("abc");
    caretToEnd(view);
    press(view, "Enter");
    type(view, "---");

    const md = source(view);
    expect(md).toBe("abc  \n\\---\n");
    // 重开后必须仍是"一段 + 一个段内换行"，而不是 heading
    expect(shapeOfMarkdown(md)).toBe("paragraph#1");
    const reopened = markdownToDoc(md);
    expect(reopened.firstChild?.type.name).toBe("paragraph");
    expect(reopened.textContent).toBe("abc---");
  });

  it("危险续行覆盖：列表 / 标题 / 引用 / 围栏 / 有序列表 / 链接定义", () => {
    const cases: Array<[string, string]> = [
      ["- item", "abc  \n\\- item\n"],
      ["# h", "abc  \n\\# h\n"],
      ["> quote", "abc  \n\\> quote\n"],
      // escapeText 已把每个反引号转义为 \`（合法 CommonMark 转义），续行守卫不再叠加
      ["```", "abc  \n\\`\\`\\`\n"],
      ["1. item", "abc  \n1\\. item\n"],
      ["=== ", "abc  \n\\=== \n"],
    ];
    for (const [typed, expected] of cases) {
      const view = mount("abc");
      caretToEnd(view);
      press(view, "Enter");
      type(view, typed);
      expect(source(view), JSON.stringify(typed)).toBe(expected);
      // 重开后仍是单段落（未被块级规则劫持）
      expect(shapeOfMarkdown(source(view)), JSON.stringify(typed)).toBe("paragraph#1");
    }
  });

  it("段末换行用 <br> 表达（Markdown 无法写行尾硬换行，否则往返丢失）", () => {
    const view = mount("第一行");
    caretToEnd(view);
    press(view, "Enter");
    // 尚未输入下一行：这是一个"段末硬换行"
    expect(source(view)).toBe("第一行<br>\n");
    expect(shapeOfMarkdown(source(view))).toBe("paragraph#1");
  });

  it("连续段内换行不会把段落拆成两块", () => {
    // 直接构造含相邻 hard_break 的文档（如 <br><br> 来源），序列化必须可原样回读
    const md = "第一行<br><br>第二行\n";
    expect(shapeOfMarkdown(md)).toBe("paragraph#2");
    expect(docToMarkdown(markdownToDoc(md))).toBe(md);
  });

  it("行内 marks 跨段内换行不丢失", () => {
    const view = mount("**粗体甲**");
    caretToEnd(view);
    press(view, "Enter");
    type(view, "粗体乙");
    // 给新行加上同样的 strong mark（模拟用户在加粗状态下的连续输入）
    const end = view.state.selection.from;
    view.dispatch(
      view.state.tr.addMark(end - 3, end, lightMDSchema.marks.strong.create()),
    );

    const md = source(view);
    expect(md).toBe("**粗体甲**  \n**粗体乙**\n");
    expect(shapeOfMarkdown(md)).toContain("paragraph#1");
    // 两处 strong 都在（段内换行不吞 mark）
    let strong = 0;
    markdownToDoc(md).descendants((n) => {
      if (n.marks.some((m) => m.type.name === "strong")) strong++;
      return true;
    });
    expect(strong).toBe(2);
  });
});
