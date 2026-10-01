/**
 * E2(v0.9.2):Tab 三处缺失——代码块缩进 / 任务项嵌套 / 表格导航
 *
 * 修复前:
 * - code_block 内 Tab 焦点移出编辑器(浏览器默认行为)
 * - task_item 无 Tab 嵌套(sinkListItem 只绑了 list_item)
 * - 表格无 Tab 逐格导航
 * 验收(经 buildKeymap 的 chainCommands 链):
 * ①表格 Tab 逐格前进/行末换行/末格追加行且光标落新行/Shift+Tab 反向
 * ②code_block Tab 缩进 2 空格、Shift+Tab 反缩进
 * ③task_item Tab 嵌套 / Shift+Tab 提升
 * ④普通段落 Tab 返回 false(浏览器默认,既有行为)
 */
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { Node } from "prosemirror-model";
import { lightMDSchema as schema } from "../core/schema";
import { buildKeymap } from "../core/keymap";

/** 构造文档 + 光标位置,返回经 buildKeymap 链处理的 Tab/Shift+Tab 结果 */
function pressKey(
  doc: Node,
  pos: number,
  key: "Tab" | "Shift-Tab"
): { handled: boolean; state: EditorState } {
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, pos) });
  const plugin = buildKeymap();
  let newState = state;
  const fakeView = {
    state,
    dispatch: (tr: Parameters<typeof state.apply>[0]) => {
      newState = state.apply(tr);
    },
  };
  const props = (plugin.spec.props ?? {}) as {
    handleKeyDown?: (view: unknown, event: unknown) => boolean;
  };
  const event = new KeyboardEvent("keydown", {
    key: key === "Tab" ? "Tab" : "Tab",
    shiftKey: key === "Shift-Tab",
    bubbles: true,
  });
  const handled = props.handleKeyDown?.(fakeView, event) ?? false;
  return { handled, state: newState };
}

/** 顶层段落 */
function paraDoc(text: string): Node {
  return schema.topNodeType.create(null, [
    schema.nodes.paragraph.create(null, schema.text(text)),
  ]);
}

/** 代码块文档,text 为块内文本(可含 \n) */
function codeDoc(text: string): Node {
  return schema.topNodeType.create(null, [
    schema.nodes.code_block.create(null, text ? schema.text(text) : []),
  ]);
}

/** 表格:head 1 行 + body 2 行,每行 2 列 */
function tableDoc(): Node {
  const row = (header: boolean) =>
    schema.nodes.table_row.create(null, [
      schema.nodes[header ? "table_header" : "table_cell"].create(null, schema.text(header ? "h" : "c")),
      schema.nodes[header ? "table_header" : "table_cell"].create(null, schema.text(header ? "h" : "c")),
    ]);
  return schema.topNodeType.create(null, [
    schema.nodes.table.create(null, [
      schema.nodes.table_head.create(null, row(true)),
      schema.nodes.table_body.create(null, [row(false), row(false)]),
    ]),
  ]);
}

/** 任务列表:两个未完成项 */
function taskDoc(): Node {
  const item = (text: string) =>
    schema.nodes.task_item.create({ checked: false }, [
      schema.nodes.paragraph.create(null, schema.text(text)),
    ]);
  return schema.topNodeType.create(null, [
    schema.nodes.task_list.create(null, [item("a"), item("b")]),
  ]);
}

/** 第 n 个 cell 的内容起始位置 */
function cellPos(doc: Node, n: number): number {
  let count = 0;
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.type.name === "table_cell" || node.type.name === "table_header") {
      if (count === n) {
        found = pos + 1;
        return false;
      }
      count++;
      return false;
    }
    return true;
  });
  if (found < 0) throw new Error("cell not found");
  return found;
}

/** 统计 tbody 行数 */
function bodyRowCount(doc: Node): number {
  let n = -1;
  doc.descendants((node) => {
    if (node.type.name === "table_body") {
      n = node.childCount;
      return false;
    }
    return true;
  });
  return n;
}

describe("E2: 表格 Tab 导航", () => {
  it("行内 Tab 前进到下一格", () => {
    const doc = tableDoc();
    const start = cellPos(doc, 2); // tbody 第 1 行第 1 格
    const { handled, state } = pressKey(doc, start, "Tab");
    expect(handled).toBe(true);
    expect(state.selection.from).toBe(cellPos(doc, 3)); // 同行第 2 格
  });

  it("行末 Tab 换到下一行首格", () => {
    const doc = tableDoc();
    const start = cellPos(doc, 3); // tbody 第 1 行第 2 格(行末)
    const { handled, state } = pressKey(doc, start, "Tab");
    expect(handled).toBe(true);
    expect(state.selection.from).toBe(cellPos(doc, 4)); // 第 2 行首格
  });

  it("head 行 Tab 跳到 tbody 首格", () => {
    const doc = tableDoc();
    const start = cellPos(doc, 0);
    const { handled, state } = pressKey(doc, start, "Tab");
    expect(handled).toBe(true);
    expect(state.selection.from).toBe(cellPos(doc, 1));
  });

  it("末行末格 Tab 追加新行,光标落新行首格", () => {
    const doc = tableDoc();
    const start = cellPos(doc, 5); // 最后一行末格
    const { handled, state } = pressKey(doc, start, "Tab");
    expect(handled).toBe(true);
    expect(bodyRowCount(state.doc)).toBe(3);
    // 光标落在新行(第 3 行)首格:即追加后第 6 个 cell 的内容起点
    expect(state.selection.from).toBe(cellPos(state.doc, 6));
  });

  it("Shift+Tab 反向:行内后退与反向换行", () => {
    const doc = tableDoc();
    const start = cellPos(doc, 4); // 第 2 行首格
    const r1 = pressKey(doc, start, "Shift-Tab");
    expect(r1.handled).toBe(true);
    expect(r1.state.selection.from).toBe(cellPos(doc, 3)); // 上一行末格
    const r2 = pressKey(r1.state.doc, r1.state.selection.from, "Shift-Tab");
    expect(r2.state.selection.from).toBe(cellPos(doc, 2));
  });

  it("首行首格 Shift+Tab 保持不动但吞掉事件(防焦点移出)", () => {
    const doc = tableDoc();
    const start = cellPos(doc, 0);
    const { handled, state } = pressKey(doc, start, "Shift-Tab");
    expect(handled).toBe(true);
    expect(state.selection.from).toBe(start);
    expect(bodyRowCount(state.doc)).toBe(2);
  });
});

describe("E2: 代码块 Tab 缩进", () => {
  it("code_block 内 Tab 在光标处插入 2 空格且命令接管(焦点不移出)", () => {
    const doc = codeDoc("x = 1");
    const pos = 1; // 内容起点(行首)
    const { handled, state } = pressKey(doc, pos, "Tab");
    expect(handled).toBe(true);
    expect(state.doc.textContent).toBe("  x = 1");
    expect(state.selection.from).toBe(3);
  });

  it("行首缩进后 Shift+Tab 删除 2 空格", () => {
    const doc = codeDoc("  x = 1");
    const pos = 1 + 2; // 光标紧邻行首 2 空格之后
    const { handled, state } = pressKey(doc, pos, "Shift-Tab");
    expect(handled).toBe(true);
    expect(state.doc.textContent).toBe("x = 1");
  });

  it("4 空格缩进 Shift+Tab 只删一个缩进单位", () => {
    const doc = codeDoc("    x");
    const pos = 1 + 4; // 光标紧邻 4 空格之后
    const { handled, state } = pressKey(doc, pos, "Shift-Tab");
    expect(handled).toBe(true);
    expect(state.doc.textContent).toBe("  x");
  });

  it("无缩进 Shift+Tab 不处理", () => {
    const { handled } = pressKey(codeDoc("x"), 1 + 1, "Shift-Tab");
    expect(handled).toBe(false);
  });

  it("mermaid_block 内 Tab 同样缩进(与 code_block 同构)", () => {
    const doc = schema.topNodeType.create(null, [
      schema.nodes.mermaid_block.create(null, schema.text("graph TD")),
    ]);
    const pos = 1; // 内容起点
    const { handled, state } = pressKey(doc, pos, "Tab");
    expect(handled).toBe(true);
    expect(state.doc.textContent).toBe("  graph TD");
  });
});

describe("E2: 任务项 Tab 嵌套", () => {
  it("第二项 Tab 嵌套为第一项子项", () => {
    const doc = taskDoc();
    // 第二个 task_item 的段落内容起点
    let pos = -1;
    doc.descendants((node, p) => {
      if (pos < 0 && node.type.name === "paragraph" && node.textContent === "b") {
        pos = p + 1;
        return false;
      }
      return true;
    });
    const { handled, state } = pressKey(doc, pos, "Tab");
    expect(handled).toBe(true);
    // 嵌套后:第一个 task_item 内出现子 task_item
    let nested = false;
    state.doc.descendants((node) => {
      if (node.type.name === "task_item" && node.childCount > 1) nested = true;
    });
    expect(nested).toBe(true);
  });

  it("嵌套后 Shift+Tab 提升回原层级", () => {
    const doc = taskDoc();
    let pos = -1;
    doc.descendants((node, p) => {
      if (pos < 0 && node.type.name === "paragraph" && node.textContent === "b") {
        pos = p + 1;
        return false;
      }
      return true;
    });
    const r1 = pressKey(doc, pos, "Tab");
    expect(r1.handled).toBe(true);
    // 光标跟随:sink 后重新定位到 "b" 段落
    let bPos = -1;
    r1.state.doc.descendants((node, p) => {
      if (bPos < 0 && node.type.name === "paragraph" && node.textContent === "b") {
        bPos = p + 1;
        return false;
      }
      return true;
    });
    const r2 = pressKey(r1.state.doc, bPos, "Shift-Tab");
    expect(r2.handled).toBe(true);
    let nested = false;
    r2.state.doc.descendants((node) => {
      if (node.type.name === "task_item" && node.childCount > 1) nested = true;
    });
    expect(nested).toBe(false);
  });
});

describe("E2: 既有行为回归", () => {
  it("普通段落 Tab 全链不处理(浏览器默认)", () => {
    const { handled } = pressKey(paraDoc("hello"), 1 + 5, "Tab");
    expect(handled).toBe(false);
  });

  it("普通列表项 Tab 嵌套仍生效(既有能力)", () => {
    const item = (text: string) =>
      schema.nodes.list_item.create(null, [schema.nodes.paragraph.create(null, schema.text(text))]);
    const doc = schema.topNodeType.create(null, [
      schema.nodes.bullet_list.create(null, [item("a"), item("b")]),
    ]);
    let pos = -1;
    doc.descendants((node, p) => {
      if (pos < 0 && node.type.name === "paragraph" && node.textContent === "b") {
        pos = p + 1;
        return false;
      }
      return true;
    });
    const { handled, state } = pressKey(doc, pos, "Tab");
    expect(handled).toBe(true);
    let nested = false;
    state.doc.descendants((node) => {
      if (node.type.name === "list_item" && node.childCount > 1) nested = true;
    });
    expect(nested).toBe(true);
  });
});
