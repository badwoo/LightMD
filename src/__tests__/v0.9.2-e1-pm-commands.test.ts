/**
 * E1(v0.9.2):阅读模式格式命令真命令化
 *
 * 修复前:App.tsx 阅读模式分支走 tr.insertText(语法串),程序化 insertText
 * 不触发 InputRules,点"加粗"得到 **** 字面文本("假命令"),与 Ctrl+B 行为不一致。
 * 验收:
 * 1. format.* 经 getPMCommand 与快捷键同源,选中态 toggle mark、序列化含语法
 * 2. 无选区进入存储态(storedMarks)
 * 3. insert.* 构造真实节点(codeblock/table/mermaid/taskList/footnote)
 * 4. insert.link/insert.image 交由调用方打开对话框(返回 false)
 * 5. 源码模式 COMMAND_SYNTAX 分支保持不变(源码断言)
 */
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { EditorState, TextSelection, Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { lightMDSchema as schema } from "../core/schema";
import { runPreviewCommand } from "../core/pmCommands";
import { getPMCommand } from "../core/keymap";
import { docToMarkdown } from "../core/markdown/serializer";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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

describe("E1: format 真命令(与快捷键同源)", () => {
  it("选中态 format.bold → strong mark,序列化含 **", () => {
    const state = paraState("hello", 2, 5); // 选中 "ell"
    const { view, get } = stubView(state);
    expect(runPreviewCommand("format.bold", view)).toBe(true);
    const doc = get().doc;
    const md = docToMarkdown(doc);
    expect(md).toContain("**ell**");
    // 与快捷键路径一致:同一命令对象
    expect(getPMCommand("format.bold")).toBeDefined();
  });

  it("无选区 format.bold → 进入存储态(后续输入加粗)", () => {
    const state = paraState("hello");
    const { view, get } = stubView(state);
    expect(runPreviewCommand("format.bold", view)).toBe(true);
    const stored = get().storedMarks;
    expect(stored?.some((m) => m.type.name === "strong")).toBe(true);
  });

  it("format.highlight → mark(==text==)", () => {
    const state = paraState("hello", 2, 5);
    const { view, get } = stubView(state);
    expect(runPreviewCommand("format.highlight", view)).toBe(true);
    expect(docToMarkdown(get().doc)).toContain("==ell==");
  });

  it("format.heading2 → 标题节点", () => {
    const state = paraState("hello");
    const { view, get } = stubView(state);
    expect(runPreviewCommand("format.heading2", view)).toBe(true);
    expect(get().doc.firstChild?.type.name).toBe("heading");
    expect(get().doc.firstChild?.attrs.level).toBe(2);
  });
});

describe("E1: insert 节点构造", () => {
  it("insert.codeblock → 当前段落转为代码块", () => {
    const state = paraState("code here");
    const { view, get } = stubView(state);
    expect(runPreviewCommand("insert.codeblock", view)).toBe(true);
    expect(get().doc.firstChild?.type.name).toBe("code_block");
  });

  it("insert.table → 表格节点 + 后随段落", () => {
    const state = paraState("");
    const { view, get } = stubView(state);
    expect(runPreviewCommand("insert.table", view)).toBe(true);
    const childTypes: string[] = [];
    get().doc.forEach((n) => childTypes.push(n.type.name));
    expect(childTypes).toContain("table");
    expect(childTypes).toContain("paragraph");
  });

  it("insert.mermaid → mermaid_block", () => {
    const state = paraState("");
    const { view, get } = stubView(state);
    expect(runPreviewCommand("insert.mermaid", view)).toBe(true);
    const childTypes: string[] = [];
    get().doc.forEach((n) => childTypes.push(n.type.name));
    expect(childTypes).toContain("mermaid_block");
  });

  it("insert.taskList → task_list/task_item", () => {
    const state = paraState("todo");
    const { view, get } = stubView(state);
    expect(runPreviewCommand("insert.taskList", view)).toBe(true);
    const childTypes: string[] = [];
    get().doc.forEach((n) => childTypes.push(n.type.name));
    expect(childTypes).toContain("task_list");
    // 原段落文本并入任务项,不丢失
    expect(get().doc.textContent).toContain("todo");
  });

  it("insert.footnote → 光标处脚注引用 + 文末定义", () => {
    const state = paraState("text");
    const { view, get } = stubView(state);
    expect(runPreviewCommand("insert.footnote", view)).toBe(true);
    let refLabel = "";
    let defLabel = "";
    get().doc.descendants((n) => {
      if (n.type.name === "footnote_ref") refLabel = String(n.attrs.label);
      if (n.type.name === "footnote_definition") defLabel = String(n.attrs.label);
    });
    expect(refLabel).toBe("1");
    expect(defLabel).toBe("1");
    const md = docToMarkdown(get().doc);
    expect(md).toContain("[^1]");
  });

  it("代码块内 insert.table 不处理(块级守卫)", () => {
    const doc = schema.topNodeType.create(null, [
      schema.nodes.code_block.create(null, schema.text("x")),
    ]);
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 2) });
    const { view, get } = stubView(state);
    expect(runPreviewCommand("insert.table", view)).toBe(false);
    expect(get().doc.firstChild?.type.name).toBe("code_block");
  });
});

describe("E1: 对话框类命令与源码分支回归", () => {
  it("insert.link / insert.image 返回 false(由 App 层打开对话框)", () => {
    const state = paraState("hello");
    const { view } = stubView(state);
    expect(runPreviewCommand("insert.link", view)).toBe(false);
    expect(runPreviewCommand("insert.image", view)).toBe(false);
  });

  it("源码模式 COMMAND_SYNTAX 语法串保持不变", () => {
    const src = readFileSync(join(root, "src/App.tsx"), "utf-8");
    expect(src).toContain('"format.bold": { syntax: "****", cursorOffset: 2 }');
    expect(src).toContain('"insert.codeblock": { syntax: "\\n```\\n\\n```\\n", cursorOffset: 5 }');
  });
});
