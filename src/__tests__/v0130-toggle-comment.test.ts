/**
 * v0.13.0 需求6：选区多行批量注释 `Ctrl+/`。
 *
 * 覆盖：
 * - schema：`comment` mark 存在且 toDOM 为 `span[data-comment]`；
 * - parser：`<!--text-->` → 带 comment mark 的文本节点（注释内容不丢）；
 * - serializer：comment mark → `<!--text-->`；
 * - roundtrip：md → doc → md 注释保持（**再编辑 → 存盘 → 重开不丢**）；
 * - toggle 命令：有选区 toggle / 无选区整块 toggle / 再次按下取消；
 * - 源码模式 `wrapSourceComment`：多行逐行包裹、已包裹则取消、缩进保留；
 * - 快捷键登记：`format.comment` 默认 `Ctrl+/` 且 scope=rich-source；
 * - 导出排除：注释内容不出现在六种导出格式（走 exportBlocks 中间结构）。
 */
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { lightMDSchema } from "../core/schema";
import { createEditor } from "../core/editor";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import { toggleComment, isCommentMarkAvailable } from "../core/toggleComment";
import { buildFormatReplacement, wrapSourceComment } from "../components/editor/sourceFormat";
import { parseMarkdownToBlocks } from "../utils/exportBlocks";
import { SHORTCUT_DEFS, matchShortcut } from "../core/shortcuts";
import { renderMarkdownHtml } from "../core/renderPipeline";

const schema = lightMDSchema;

/** 取 doc 里所有带 comment mark 的文本 */
function commentedTexts(doc: ReturnType<typeof markdownToDoc>): string[] {
  const out: string[] = [];
  doc.descendants((n) => {
    if (n.isText && (n.marks ?? []).some((m) => m.type.name === "comment")) {
      out.push(n.text ?? "");
    }
  });
  return out;
}

/** 取 doc 里所有不带 comment 的文本 */
function plainTexts(doc: ReturnType<typeof markdownToDoc>): string[] {
  const out: string[] = [];
  doc.descendants((n) => {
    if (n.isText && !(n.marks ?? []).some((m) => m.type.name === "comment")) {
      out.push(n.text ?? "");
    }
  });
  return out;
}

// ───────── schema / parser / serializer ─────────

describe("schema：comment mark", () => {
  it("mark 存在且可用", () => {
    expect(schema.marks.comment).toBeTruthy();
    expect(isCommentMarkAvailable()).toBe(true);
  });

  it("toDOM → span[data-comment]", () => {
    const m = schema.marks.comment.create();
    const dom = m.type.spec.toDOM!(m, false) as [string, Record<string, string>];
    expect(dom[0]).toBe("span");
    expect(dom[1]["data-comment"]).toBe("");
  });

  it("parseDOM 认 span[data-comment]", () => {
    expect(schema.marks.comment.spec.parseDOM?.[0]?.tag).toBe("span[data-comment]");
  });
});

describe("parser：<!--text--> → comment mark", () => {
  it("行内注释内容被保留为带 mark 的文本（不丢）", () => {
    const doc = markdownToDoc("这是 <!--注释--> 文本\n");
    expect(commentedTexts(doc)).toEqual(["注释"]);
    expect(plainTexts(doc).join("")).toContain("这是");
    expect(plainTexts(doc).join("")).toContain("文本");
  });

  it("空注释 <!----> 不产生节点（PM 不允许空文本节点）", () => {
    const doc = markdownToDoc("A<!---->B\n");
    expect(commentedTexts(doc)).toEqual([]);
    expect(doc.textContent).toBe("AB");
  });

  it("注释内容含空格/标点也完整保留", () => {
    const doc = markdownToDoc("x <!--这是 一段 注释！--> y\n");
    expect(commentedTexts(doc)).toEqual(["这是 一段 注释！"]);
  });

  it("注释内容含 HTML 尖括号不破坏结构", () => {
    const doc = markdownToDoc("a <!--<b>粗</b>--> b\n");
    expect(commentedTexts(doc)).toEqual(["<b>粗</b>"]);
  });
});

describe("serializer：comment mark → <!--text-->", () => {
  it("普通注释序列化", () => {
    const doc = schema.nodes.doc.create(
      null,
      schema.nodes.paragraph.create(null, [
        schema.text("这是 "),
        schema.text("注释", [schema.marks.comment.create()]),
        schema.text(" 文本"),
      ]),
    );
    expect(docToMarkdown(doc)).toBe("这是 <!--注释--> 文本\n");
  });

  it("注释与其它 mark 共存（粗体在里层）", () => {
    const doc = schema.nodes.doc.create(
      null,
      schema.nodes.paragraph.create(null, [
        schema.text("粗体注释", [
          schema.marks.comment.create(),
          schema.marks.strong.create(),
        ]),
      ]),
    );
    const out = docToMarkdown(doc);
    expect(out).toContain("<!--");
    expect(out).toContain("**粗体注释**");
    expect(out).toContain("-->");
  });
});

describe("roundtrip：注释保持且重开不丢", () => {
  it("md → doc → md 逐字节一致", () => {
    const md = "这是 <!--注释--> 文本\n";
    expect(docToMarkdown(markdownToDoc(md))).toBe(md);
  });

  it("编辑后存盘再重开：注释仍在（B6 快路径之外的逐块路径）", () => {
    // 先插入注释
    const doc1 = markdownToDoc("这是 <!--注释--> 文本\n");
    // 在段末追加文字（该块变成「编辑过」，走规范序列化路径）
    const pos = doc1.content.size - 1;
    const tr = EditorState.create({ doc: doc1, schema }).tr.insertText("！", pos);
    const doc2 = tr.doc;
    const md2 = docToMarkdown(doc2);
    expect(md2).toContain("<!--注释-->");
    // 重开
    expect(docToMarkdown(markdownToDoc(md2))).toContain("<!--注释-->");
  });

  it("未注释文档零 diff（回归锁）", () => {
    const md = "# 标题\n\n普通段落，没有任何注释。\n";
    expect(docToMarkdown(markdownToDoc(md))).toBe(md);
  });
});

// ───────── toggle 命令 ─────────

/** 建一个 EditorState（可选选区） */
function stateWith(text: string, sel?: [number, number]) {
  const doc = markdownToDoc(text);
  const base = EditorState.create({ doc, schema });
  if (!sel) return base;
  return base.apply(base.tr.setSelection(TextSelection.create(doc, sel[0], sel[1])));
}

/** 执行 toggleComment 并返回新 state */
function applyToggle(state: EditorState) {
  let next = state;
  toggleComment(state, (tr) => {
    next = state.apply(tr);
  });
  return next;
}

describe("toggleComment 命令", () => {
  it("有选区 → 加注释", () => {
    const doc = markdownToDoc("一二三四五\n");
    // 选区覆盖「二三」（doc 位置：段落起始 1）
    const state = stateWith("一二三四五\n", [2, 4]);
    const next = applyToggle(state);
    expect(commentedTexts(next.doc)).toEqual(["二三"]);
  });

  it("再次执行 → 取消注释（toggle 语义）", () => {
    const state = stateWith("一二三四五\n", [2, 4]);
    const once = applyToggle(state);
    expect(commentedTexts(once.doc)).toEqual(["二三"]);
    const twice = applyToggle(once);
    expect(commentedTexts(twice.doc)).toEqual([]);
  });

  it("无选区 → 整块内容切换（Obsidian 语义）", () => {
    const state = stateWith("整块都要注释\n");
    const next = applyToggle(state);
    expect(commentedTexts(next.doc)).toEqual(["整块都要注释"]);
  });

  it("跨块选区 → 覆盖的所有文本都被注释", () => {
    // 两段：para1(第一段) 占 0..4，para2(第二段) 占 5..9
    const state = stateWith("第一段\n\n第二段\n", [1, 9]);
    const next = applyToggle(state);
    const commented = commentedTexts(next.doc);
    expect(commented.length).toBeGreaterThanOrEqual(2);
    expect(commented.join("|")).toContain("第一段");
    expect(commented.join("|")).toContain("第二段");
  });

  it("部分选区已注释 → 全部加上（不是取消）", () => {
    // 已注释「二三」，再对「二三四」选区 → 结果应全部注释
    const state = stateWith("一二三四五\n", [2, 4]);
    const once = applyToggle(state);
    const sel = TextSelection.create(once.doc, 2, 5);
    const twice = applyToggle(once.apply(once.tr.setSelection(sel)));
    expect(commentedTexts(twice.doc)).toEqual(["二三四"]);
  });

  it("命令后选中区被保留（不跳到文档头）", () => {
    const state = stateWith("一二三四五\n", [2, 4]);
    const next = applyToggle(state);
    expect(next.selection.from).toBeGreaterThanOrEqual(2);
    expect(next.selection.to).toBeLessThanOrEqual(5);
  });
});

// ───────── 源码模式 ─────────

describe("wrapSourceComment（源码模式）", () => {
  it("单行：加包裹符", () => {
    const r = wrapSourceComment("hello");
    expect(r.replacement).toBe("<!-- hello -->");
  });

  it("多行：逐行包裹", () => {
    const r = wrapSourceComment("a\nb\nc");
    expect(r.replacement).toBe("<!-- a -->\n<!-- b -->\n<!-- c -->");
  });

  it("已全部注释 → 取消包裹", () => {
    const r = wrapSourceComment("<!-- a -->\n<!-- b -->");
    expect(r.replacement).toBe("a\nb");
  });

  it("部分注释 → 全部加上（幂等 toggle 的另一半）", () => {
    const r = wrapSourceComment("<!-- a -->\nb");
    expect(r.replacement).toBe("<!-- <!-- a --> -->\n<!-- b -->");
  });

  it("取消时保留缩进", () => {
    const r = wrapSourceComment("  <!-- a -->");
    expect(r.replacement).toBe("  a");
  });

  it("无选区 → 只插符号 + ghost 占位（占位不落盘）", () => {
    const r = wrapSourceComment("");
    expect(r.replacement).toBe("<!--  -->");
    expect(r.cursorOffset).toBe(5);
    expect(r.ghostText).toBe("注释内容");
  });

  it("经 buildFormatReplacement('comment', ...) 走同一路径", () => {
    expect(buildFormatReplacement("comment", "x")?.replacement).toBe("<!-- x -->");
  });
});

// ───────── 快捷键登记 ─────────

describe("真实编辑器链路：Ctrl+/ 走通", () => {
  it("createEditor 挂载后 NodeSelection/TextSelection 下 Ctrl+/ 被消费并加注释", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = createEditor({ parent: host, initialContent: "一二三四五\n" }) as EditorView;
    try {
      const sel = TextSelection.create(view.state.doc, 2, 4);
      view.dispatch(view.state.tr.setSelection(sel));
      const ev = new KeyboardEvent("keydown", {
        key: "/",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      const handled = view.someProp("handleKeyDown", (f) => f(view, ev)) ?? false;
      expect(handled).toBe(true); // 动态快捷键表已接管
      // 注释真的落到了 doc 上
      const commented: string[] = [];
      view.state.doc.descendants((n) => {
        if (n.isText && (n.marks ?? []).some((m) => m.type.name === "comment")) {
          commented.push(n.text ?? "");
        }
      });
      expect(commented).toEqual(["二三"]);
    } finally {
      view.destroy();
      host.remove();
    }
  });
});

describe("快捷键：format.comment（Ctrl+/）", () => {
  it("已登记、默认 Ctrl+/、scope=rich-source（三模式中的两种编辑面一致）", () => {
    const def = SHORTCUT_DEFS.find((d) => d.id === "format.comment");
    expect(def).toBeTruthy();
    expect(def!.defaultCombo).toBe("Ctrl+/");
    expect(def!.scope).toBe("rich-source");
    expect(def!.labelKey).toBe("shortcut.format.comment");
  });

  it("Ctrl+/ 能被 matchShortcut 命中（key='/'）", () => {
    const e = new KeyboardEvent("keydown", { key: "/", ctrlKey: true });
    const def = matchShortcut(e, ["editor", "rich"]);
    expect(def?.id).toBe("format.comment");
  });

  it("与其它格式键不冲突", () => {
    const combos = SHORTCUT_DEFS.map((d) => d.defaultCombo);
    expect(combos.filter((c) => c === "Ctrl+/")).toHaveLength(1);
  });

  it("基线 51 → 52（新增这一条）", () => {
    expect(SHORTCUT_DEFS.length).toBe(52);
  });
});

// ───────── 导出排除 ─────────

describe("导出：注释内容不出现", () => {
  const MD = "开头 <!--这是注释--> 结尾\n";

  it("DOCX/EPUB/LaTeX 的中间结构（exportBlocks）不含注释文本", () => {
    const blocks = parseMarkdownToBlocks(MD);
    const allText = blocks
      .map((b) => ("runs" in b && Array.isArray(b.runs) ? b.runs.map((r) => r.text).join("") : ""))
      .join("");
    expect(allText).toContain("开头");
    expect(allText).toContain("结尾");
    expect(allText).not.toContain("这是注释");
  });

  it("HTML 渲染侧：注释以 HTML 注释透传，浏览器不显示其内容", () => {
    const html = renderMarkdownHtml(MD);
    // 注释内容可以以 HTML 注释形式存在（视觉上不出现），但绝不能作为可见文本
    const visible = html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<[^>]+>/g, "");
    expect(visible).toContain("开头");
    expect(visible).toContain("结尾");
    expect(visible).not.toContain("这是注释");
  });
});
