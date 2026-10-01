/**
 * E8+E10(v0.9.3):下划线 mark 与 HTML 最小白名单
 *
 * 修复前:schema 无 underline mark(Ctrl+U 不存在);html:false 使 <u>/<br>/<sub>/
 * <sup>/<mark> 全部字面显示,块级 HTML 也字面(但导出与编辑配置无区分)。
 * 修复后:
 * 1. underline mark + Ctrl+U(format.underline)/命令面板/源码 <u> 包裹
 * 2. 编辑管线:html:true + disable html_block(块级 HTML 字面段落,防 default 分支丢内容)
 *    + html_inline 白名单(<u>/<br>/<sub>/<sup>/<mark> 转结构,其余标签剥离保留内容)
 * 3. 分屏预览(共享编辑实例):白名单外标签在渲染层转义(iframe 带 allow-scripts,防注入)
 * 4. 导出 HTML 管线(ExportDialog):html:true 全放行(不经 PM)
 * 5. DOCX/LaTeX 导出(exportBlocks Block[] 中间结构):维持 html:false(字面文本不丢内容)
 */
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { EditorState, TextSelection, Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { lightMDSchema as schema } from "../core/schema";
import { markdownToDoc, createMarkdownIt, getMarkdownIt } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import { getPMCommand } from "../core/keymap";
import { matchShortcut, findDuplicateCombos, normalizeCombo } from "../core/shortcuts";
import { buildFormatReplacement } from "../components/editor/sourceFormat";

/** 段落文档,光标可选区间 [selFrom, selTo) */
function paraState(text: string, selFrom?: number, selTo?: number): EditorState {
  const para = text
    ? schema.nodes.paragraph.create(null, schema.text(text))
    : schema.nodes.paragraph.create();
  const doc = schema.topNodeType.create(null, [para]);
  const from = selFrom ?? 1 + text.length;
  const to = selTo ?? from;
  return EditorState.create({ doc, selection: TextSelection.create(doc, from, to) });
}

/** 测试用 stub EditorView:记录 dispatch 后的状态 */
function stubView(state: EditorState): { view: EditorView; get: () => EditorState } {
  let current = state;
  const view = {
    get state() {
      return current;
    },
    dispatch: (tr: Transaction) => {
      current = current.apply(tr);
    },
    focus: () => {},
  } as unknown as EditorView;
  return { view, get: () => current };
}

describe("E8: 下划线 mark 与 Ctrl+U 命令", () => {
  it("选中态 format.underline → underline mark,序列化为 <u>", () => {
    const state = paraState("hello", 2, 5); // 选中 "ell"
    const { view, get } = stubView(state);
    const cmd = getPMCommand("format.underline");
    expect(cmd).toBeDefined();
    expect(cmd!(view.state, view.dispatch, view)).toBe(true);
    const doc = get().doc;
    let hasUnderline = false;
    doc.descendants((n) => {
      if (n.marks.some((m) => m.type.name === "underline")) hasUnderline = true;
    });
    expect(hasUnderline).toBe(true);
    // 手工构造的 doc 无 B6 原文记录 → 走规范序列化
    expect(docToMarkdown(doc)).toContain("<u>ell</u>");
  });

  it("再次执行 format.underline → 取消下划线(toggle)", () => {
    const state = paraState("hello", 2, 5);
    const { view, get } = stubView(state);
    const cmd = getPMCommand("format.underline")!;
    cmd(view.state, view.dispatch, view);
    cmd(get(), view.dispatch, view);
    const doc = get().doc;
    let hasUnderline = false;
    doc.descendants((n) => {
      if (n.marks.some((m) => m.type.name === "underline")) hasUnderline = true;
    });
    expect(hasUnderline).toBe(false);
  });

  it("matchShortcut:Ctrl+U 命中 format.underline(rich 作用域)", () => {
    const def = matchShortcut(
      { key: "u", ctrlKey: true, altKey: false, shiftKey: false, metaKey: false },
      ["rich"],
    );
    expect(def?.id).toBe("format.underline");
  });

  it("matchShortcut:Ctrl+Shift+K 命中 insert.link", () => {
    const def = matchShortcut(
      { key: "k", ctrlKey: true, altKey: false, shiftKey: true, metaKey: false },
      ["global"],
    );
    expect(def?.id).toBe("insert.link");
  });

  it("默认键位表无重复绑定(新增两条后回归)", () => {
    expect(findDuplicateCombos()).toEqual([]);
  });

  it("源码模式 buildFormatReplacement:underline 包裹 <u>", () => {
    expect(buildFormatReplacement("underline", "x")).toEqual({
      replacement: "<u>x</u>",
      cursorOffset: 8,
    });
    expect(buildFormatReplacement("underline", "")?.replacement).toBe("<u>下划线文本</u>");
  });
});

describe("E8: 行内 HTML 白名单解析", () => {
  it("<u>x</u> → underline mark,文本保留", () => {
    const doc = markdownToDoc("<u>x</u>");
    let underlineText = "";
    doc.descendants((n) => {
      if (n.isText && n.marks.some((m) => m.type.name === "underline")) {
        underlineText += n.text;
      }
    });
    expect(underlineText).toBe("x");
  });

  it("<br> → hard_break 节点", () => {
    const doc = markdownToDoc("a<br>b");
    let brCount = 0;
    doc.descendants((n) => {
      if (n.type.name === "hard_break") brCount++;
    });
    expect(brCount).toBe(1);
    expect(doc.textContent).toBe("ab");
  });

  it("<sub>/<sup>/<mark> → 对应既有 mark", () => {
    const doc = markdownToDoc("<sub>s</sub><sup>p</sup><mark>m</mark>");
    const found = new Set<string>();
    doc.descendants((n) => {
      for (const m of n.marks) found.add(m.type.name);
    });
    expect(found.has("subscript")).toBe(true);
    expect(found.has("superscript")).toBe(true);
    expect(found.has("mark")).toBe(true);
  });

  it("<span>hi</span> → 标签剥离内容保留(非白名单)", () => {
    const doc = markdownToDoc('<span title="t">hi</span>');
    expect(doc.textContent).toBe("hi");
  });

  it("块级 <div> 禁用 html_block 后按段落字面保留(不丢内容)", () => {
    const doc = markdownToDoc('<div class="x">\ninner\n</div>');
    expect(doc.textContent).toContain("<div");
    expect(doc.textContent).toContain("inner");
    expect(doc.textContent).toContain("</div>");
  });

  it("<u>**x**</u> 嵌套:strong 与 underline 同时存在", () => {
    const doc = markdownToDoc("<u>**x**</u>");
    let ok = false;
    doc.descendants((n) => {
      if (
        n.isText &&
        n.text === "x" &&
        n.marks.some((m) => m.type.name === "strong") &&
        n.marks.some((m) => m.type.name === "underline")
      ) {
        ok = true;
      }
    });
    expect(ok).toBe(true);
  });
});

describe("E8: 序列化往返", () => {
  it("手工构造 underline doc → docToMarkdown 输出 <u>(无 B6 原文路径)", () => {
    const doc = schema.topNodeType.create(null, [
      schema.nodes.paragraph.create(null, [
        schema.text("a"),
        schema.text("u", [schema.mark("underline")]),
        schema.text("b"),
      ]),
    ]);
    expect(docToMarkdown(doc)).toBe("a<u>u</u>b\n");
  });

  it("markdownToDoc(<u>x</u>) → docToMarkdown:B6 未编辑逐字节返回原文", () => {
    const doc = markdownToDoc("<u>x</u>");
    expect(docToMarkdown(doc)).toBe("<u>x</u>");
  });
});

describe("E10: 渲染层配置(编辑管线 vs 导出管线)", () => {
  it("编辑实例(分屏预览共用):<u> 放行渲染,非白名单行内标签剥离、块级标签转义", () => {
    const md = getMarkdownIt(true);
    const safe = md.render("<u>hi</u>");
    expect(safe).toContain("<u>hi</u>");
    const span = md.render('<span onclick="x()">y</span>');
    // iframe 带 allow-scripts,非白名单行内标签不得注入 DOM(与编辑器"标签剥离"一致)
    expect(span).not.toContain("<span");
    expect(span).toContain("y");
    // 块级/CDATA 标签(script 等)按字面转义显示,不执行
    const script = md.render("<script>alert(1)</script>");
    expect(script).not.toContain("<script>");
    expect(script).toContain("&lt;script&gt;");
  });

  it("编辑实例:块级 <div> 字面文本(转义),不注入 HTML", () => {
    const md = getMarkdownIt(true);
    expect(md.render("<div>x</div>")).not.toContain("<div>x</div>");
  });

  it("导出 HTML 实例(html:true 全放行):块级与行内 HTML 保真输出", () => {
    const md = createMarkdownIt({ breaks: true, html: true });
    expect(md.render("<div>x</div>")).toContain("<div>x</div>");
    expect(md.render("<u>hi</u>")).toContain("<u>hi</u>");
  });

  it("DOCX/LaTeX 导出实例(缺省 html:false):HTML 字面转义,内容不丢", () => {
    // exportBlocks 的 Block[] 中间结构无法承载 html_block token(default 分支会丢内容),
    // 维持 html:false —— 块级 HTML 保持字面文本
    const md = createMarkdownIt({ breaks: true, typographer: true, validateLink: false });
    expect(md.render("<div>x</div>")).toContain("&lt;div&gt;");
  });
});
