/**
 * v0.13.0 需求1：块级复制 / 剪切 / 删除（三点菜单 + 右键菜单 + 快捷键）。
 *
 * ## 覆盖
 *
 * 1. `blockClipboard.ts` 纯逻辑：三份格式序列化 / 三级降级读取 / Markdown 特征判定；
 * 2. `blockActionMenu.ts` 纯逻辑：菜单项构建（含 disabled 态）；
 * 3. `blockSelection.ts` 新语义：`blockAcceptsCaret` 真值表 + 单击放行；
 * 4. `blockClipboardOps.ts` 执行层：序列化 / 删除（删空补空段落）。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EditorState, NodeSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

import { lightMDSchema } from "../core/schema";
import {
  BLOCK_CLIPBOARD_MIME,
  parseBlockClipboard,
  serializeBlockClipboard,
  looksLikeMarkdown,
  hasBlockClipboardData,
} from "../utils/blockClipboard";
import { buildBlockMenuItems } from "../utils/blockActionMenu";
import {
  selectedBlockNode,
  serializeBlock,
  deleteSelectedBlock,
} from "../utils/blockClipboardOps";
import { blockAcceptsCaret, shouldSelectBlockOnMouseDown } from "../core/plugins/blockSelection";

const schema = lightMDSchema;

function makeDoc(...children: Parameters<typeof schema.node>[1][] extends never ? never[] : never[]) {
  return children;
}

describe("blockClipboard：剪贴板三份格式与三级降级", () => {
  it("专用格式优先：解析回 markdown/from/to", () => {
    const entries = [
      {
        type: BLOCK_CLIPBOARD_MIME,
        content: serializeBlockClipboard({
          markdown: "```js\nconst a = 1;\n```",
          from: 0,
          to: 5,
          at: 1,
        }),
      },
      { type: "text/plain", content: "ignored" },
    ];
    const parsed = parseBlockClipboard(entries);
    expect(parsed?.markdown).toBe("```js\nconst a = 1;\n```");
    expect(parsed?.from).toBe(0);
    expect(parsed?.to).toBe(5);
  });

  it("无专用格式但 text/plain 像 Markdown（≥2 特征）→ 走文本降级", () => {
    const md = "# 标题\n\n- 列表项\n- 第二项";
    const parsed = parseBlockClipboard([{ type: "text/plain", content: md }]);
    expect(parsed?.markdown).toBe(md);
  });

  it("纯文本（<2 特征）→ 返回 null（调用方按普通文本处理）", () => {
    expect(parseBlockClipboard([{ type: "text/plain", content: "hello world" }])).toBeNull();
    expect(parseBlockClipboard([{ type: "text/plain", content: "just a line" }])).toBeNull();
  });

  it("专用格式 JSON 损坏 → 落到 text/plain 分支", () => {
    const parsed = parseBlockClipboard([
      { type: BLOCK_CLIPBOARD_MIME, content: "{ 坏 JSON" },
      { type: "text/plain", content: "# 标题\n\n> 引用" },
    ]);
    expect(parsed?.markdown).toBe("# 标题\n\n> 引用");
  });

  it("hasBlockClipboardData：有块数据 true / 纯文本 false", () => {
    expect(
      hasBlockClipboardData([{ type: "text/plain", content: "# a\n\n- b" }]),
    ).toBe(true);
    expect(hasBlockClipboardData([{ type: "text/plain", content: "plain" }])).toBe(false);
  });

  it("序列化往返：JSON 字符串含全部字段", () => {
    const s = serializeBlockClipboard({
      markdown: "x",
      html: "<p>x</p>",
      from: 1,
      to: 2,
      at: 3,
    });
    const back = JSON.parse(s);
    expect(back).toEqual({ markdown: "x", html: "<p>x</p>", from: 1, to: 2, at: 3 });
  });
});

describe("looksLikeMarkdown 特征判定", () => {
  it("单项特征不算 Markdown（避免把普通文本误当块）", () => {
    expect(looksLikeMarkdown("just # one hash")).toBe(false);
    expect(looksLikeMarkdown("a | b")).toBe(false);
  });

  it("≥2 项特征即判定为 Markdown", () => {
    expect(looksLikeMarkdown("# 标题\n\n- 列表项")).toBe(true);
    expect(looksLikeMarkdown("```js\ncode\n```\n\n# t")).toBe(true);
    expect(looksLikeMarkdown("- a\n- b\n\n# 标题")).toBe(true);
    expect(looksLikeMarkdown("| a | b |\n| --- | --- |")).toBe(true);
    expect(looksLikeMarkdown("# 标题\n\n**粗**")).toBe(true);
    expect(looksLikeMarkdown("- 列表\n\n![img](a.png)")).toBe(true);
  });

  it("单项特征 → false（每个特征单独出现都不足以判定）", () => {
    // 这正是「纯文本保底」需要守住的边界：宁可少认，也不能把普通文本
    // 当成块结构去解析（那会改变用户粘贴纯文本的语义）
    expect(looksLikeMarkdown("**粗**")).toBe(false);
    expect(looksLikeMarkdown("- 单个列表项")).toBe(false);
    expect(looksLikeMarkdown("| a | b |")).toBe(false);
    expect(looksLikeMarkdown("> 只有一句引用")).toBe(false);
  });

  // v0.13.1 需求1：**自包含块构造**单独出现即判定为 Markdown，
  // 否则阅读模式复制一个代码块/表格/公式块再 Ctrl+V，只会粘出字面文本。
  it("自包含块构造（围栏代码块 / $$ 公式块 / 带分隔行的表格）→ true", () => {
    expect(looksLikeMarkdown("```\n只有一段代码\n```")).toBe(true);
    expect(looksLikeMarkdown("```js\nconst a = 1;\n```")).toBe(true);
    expect(looksLikeMarkdown("~~~\nx\n~~~")).toBe(true);
    expect(looksLikeMarkdown("$$\nE = mc^2\n$$")).toBe(true);
    expect(looksLikeMarkdown("| a | b |\n| --- | --- |")).toBe(true);
  });

  it("空串 → false", () => {
    expect(looksLikeMarkdown("")).toBe(false);
  });
});

describe("blockActionMenu：菜单项构建", () => {
  it("完整 8 项 + 禁用态正确", () => {
    const items = buildBlockMenuItems({
      hasClipboard: true,
      isFirstBlock: false,
      isLastBlock: false,
    });
    expect(items.map((i) => i.id)).toEqual([
      "cut",
      "copy",
      "paste",
      "delete",
      "formatPainter",
      "select",
      "moveUp",
      "moveDown",
    ]);
    expect(items.every((i) => !i.disabled)).toBe(true);
    // 删除是危险操作
    expect(items.find((i) => i.id === "delete")?.danger).toBe(true);
    // 分隔线：删除前、格式刷前、上移前
    expect(items.find((i) => i.id === "delete")?.separatorBefore).toBe(true);
    expect(items.find((i) => i.id === "formatPainter")?.separatorBefore).toBe(true);
    expect(items.find((i) => i.id === "moveUp")?.separatorBefore).toBe(true);
  });

  it("剪贴板为空 → 「粘贴」禁用", () => {
    const items = buildBlockMenuItems({
      hasClipboard: false,
      isFirstBlock: false,
      isLastBlock: false,
    });
    expect(items.find((i) => i.id === "paste")?.disabled).toBe(true);
  });

  it("首块禁用上移；末块禁用下移", () => {
    const items = buildBlockMenuItems({
      hasClipboard: true,
      isFirstBlock: true,
      isLastBlock: true,
    });
    expect(items.find((i) => i.id === "moveUp")?.disabled).toBe(true);
    expect(items.find((i) => i.id === "moveDown")?.disabled).toBe(true);
  });
});

describe("blockAcceptsCaret 真值表（v0.13.0 需求1）", () => {
  it("代码块 / 公式块 / Mermaid 块 → true（可放光标，单击即编辑）", () => {
    expect(blockAcceptsCaret(schema.nodes.code_block.create(null, schema.text("x")))).toBe(true);
    expect(blockAcceptsCaret(schema.nodes.math_block.create(null, schema.text("x")))).toBe(true);
    expect(blockAcceptsCaret(schema.nodes.mermaid_block.create(null, schema.text("x")))).toBe(true);
  });

  it("水平线 / toc（叶子 atom）→ false（无光标可放，保持块选中）", () => {
    expect(blockAcceptsCaret(schema.nodes.horizontal_rule.create())).toBe(false);
    expect(blockAcceptsCaret(schema.nodes.toc.create({ headings: "[]" }))).toBe(false);
  });

  it("段落 / 标题 → true", () => {
    expect(blockAcceptsCaret(schema.nodes.paragraph.create())).toBe(true);
    expect(blockAcceptsCaret(schema.nodes.heading.create({ level: 1 }))).toBe(true);
  });

  it("null / undefined → false", () => {
    expect(blockAcceptsCaret(null)).toBe(false);
    expect(blockAcceptsCaret(undefined)).toBe(false);
  });
});

describe("单击语义：可编辑块不再需要点两次", () => {
  it("可放光标的块 → 不拦 mousedown（单击直接进编辑）", () => {
    expect(
      shouldSelectBlockOnMouseDown({
        isPlainLeftClick: true,
        onInteractive: false,
        alreadySelected: false,
        acceptsCaret: true,
      }),
    ).toBe(false);
  });

  it("不可放光标的叶子块 → 仍拦（保持可删除/可拖拽）", () => {
    expect(
      shouldSelectBlockOnMouseDown({
        isPlainLeftClick: true,
        onInteractive: false,
        alreadySelected: false,
        acceptsCaret: false,
      }),
    ).toBe(true);
  });
});

describe("blockClipboardOps：执行层", () => {
  const doc = schema.node("doc", null, [
    schema.node("paragraph", null, [schema.text("a")]),
    schema.node("code_block", { language: "js", info: "js" }, [schema.text("const a = 1;")]),
    schema.node("horizontal_rule"),
  ]);
  const codePos = doc.child(0).nodeSize;
  const hrPos = doc.child(0).nodeSize + doc.child(1).nodeSize;

  it("selectedBlockNode：NodeSelection 返回节点，其它选区返回 null", () => {
    const state = EditorState.create({ doc, schema, selection: NodeSelection.create(doc, codePos) });
    expect(selectedBlockNode(state)?.type.name).toBe("code_block");
    const plain = EditorState.create({ doc, schema });
    expect(selectedBlockNode(plain)).toBeNull();
  });

  it("serializeBlock：产出 Markdown 源码 + 正确 from/to", () => {
    const state = EditorState.create({ doc, schema });
    const data = serializeBlock(state, codePos);
    expect(data).not.toBeNull();
    expect(data!.markdown).toContain("```js");
    expect(data!.markdown).toContain("const a = 1;");
    expect(data!.from).toBe(codePos);
    expect(data!.to).toBe(codePos + doc.child(1).nodeSize);
  });

  it("serializeBlock：越界位置返回 null（不抛错）", () => {
    const state = EditorState.create({ doc, schema });
    expect(serializeBlock(state, 99999)).toBeNull();
  });

  it("deleteSelectedBlock：删除整块且一次事务", () => {
    const state = EditorState.create({ doc, schema, selection: NodeSelection.create(doc, codePos) });
    let dispatched = 0;
    const view = {
      get state() {
        return state;
      },
      dispatch: (tr: { doc: typeof doc }) => {
        dispatched++;
        void tr;
      },
      focus: vi.fn(),
    } as unknown as EditorView;
    deleteSelectedBlock(view);
    expect(dispatched).toBe(1); // 一次事务 = 一次撤销
  });

  it("删空文档后自动补空段落（PM 要求 doc 至少一个块）", () => {
    const single = schema.node("doc", null, [
      schema.node("code_block", { language: "", info: "" }, [schema.text("only")]),
    ]);
    const state = EditorState.create({
      doc: single,
      schema,
      selection: NodeSelection.create(single, 0),
    });
    let newChildCount = -1;
    const view = {
      get state() {
        return state;
      },
      dispatch: (tr: { doc: typeof single }) => {
        newChildCount = tr.doc.childCount;
      },
      focus: vi.fn(),
    } as unknown as EditorView;
    deleteSelectedBlock(view);
    // 不应为空 doc（空 doc 会让 PM 抛错）
    expect(newChildCount).toBeGreaterThanOrEqual(1);
  });
});
