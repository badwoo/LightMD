/**
 * v0.12.0 需求6：块级选中删除测试
 *
 * 覆盖：
 * 1. shouldSelectBlockOnMouseDown 纯函数：左键单击 + 非交互控件 + 未选中 → true
 * 2. handleBlockStopEvent：单击建 NodeSelection / 双击放行 / 右键放行 /
 *    交互控件放行 / 已选中放行 / getPos 无效放行
 * 3. deleteSelection 对 NodeSelection 整节点删除（建得出即可删）
 * 4. 四个 NodeView（code_block / mermaid_block / math_block / table）的
 *    selectNode/deselectNode/stopEvent 接线（实例行为 + 源码断言）
 */
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { EditorState, NodeSelection } from "prosemirror-state";
import { deleteSelection } from "prosemirror-commands";
import type { EditorView } from "prosemirror-view";
import { readFileSync } from "node:fs";
import { lightMDSchema as schema } from "../core/schema";
import {
  shouldSelectBlockOnMouseDown,
  handleBlockStopEvent,
  BLOCK_SELECTED_CLASS,
} from "../core/plugins/blockSelection";
import { CodeBlockView } from "../core/plugins/code-block";
import { MathBlockView } from "../core/plugins/math-block";

const readSrc = (p: string) => readFileSync(`src/${p}`, "utf-8");

/** 构造 mock EditorView（state getter + dispatch 写回） */
function makeMockView(initial: EditorState) {
  let state = initial;
  const view = {
    get state() {
      return state;
    },
    dispatch: (tr: { doc: unknown } & Parameters<EditorState["apply"]>[0]) => {
      state = state.apply(tr as Parameters<EditorState["apply"]>[0]);
    },
    nodeDOM: () => null,
    dom: document.createElement("div"),
  } as unknown as EditorView;
  return {
    view,
    getState: () => state,
    setState: (s: EditorState) => {
      state = s;
    },
  };
}

function fakeMouseEvent(over: Partial<{ button: number; detail: number; target: EventTarget | null }>) {
  return {
    type: "mousedown",
    button: 0,
    detail: 1,
    target: document.createElement("div"),
    preventDefault: vi.fn(),
    ...over,
  } as unknown as MouseEvent;
}

describe("v0.12.0 需求6：shouldSelectBlockOnMouseDown（纯函数）", () => {
  it("左键单击 + 非交互 + 未选中 → true", () => {
    expect(
      shouldSelectBlockOnMouseDown({ isPlainLeftClick: true, onInteractive: false, alreadySelected: false }),
    ).toBe(true);
  });

  it("双击（detail≠1）/右键 / 交互控件 / 已选中 → false", () => {
    expect(
      shouldSelectBlockOnMouseDown({ isPlainLeftClick: false, onInteractive: false, alreadySelected: false }),
    ).toBe(false);
    expect(
      shouldSelectBlockOnMouseDown({ isPlainLeftClick: true, onInteractive: true, alreadySelected: false }),
    ).toBe(false);
    expect(
      shouldSelectBlockOnMouseDown({ isPlainLeftClick: true, onInteractive: false, alreadySelected: true }),
    ).toBe(false);
  });
});

describe("v0.12.0 需求6：handleBlockStopEvent", () => {
  const doc = schema.node("doc", null, [
    schema.node("paragraph", null, [schema.text("a")]),
    schema.node("code_block", { language: "" }, [schema.text("x")]),
    schema.node("paragraph", null, [schema.text("b")]),
  ]);
  const codePos = doc.child(0).nodeSize;

  it("单击 → 拦下并建立 NodeSelection（preventDefault 被调）", () => {
    const { view, getState } = makeMockView(EditorState.create({ doc, schema }));
    const dom = document.createElement("div");
    const e = fakeMouseEvent({});
    const handled = handleBlockStopEvent(dom, view, () => codePos, e);
    expect(handled).toBe(true);
    const sel = getState().selection;
    expect(sel).toBeInstanceOf(NodeSelection);
    expect(sel.from).toBe(codePos);
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it("双击（detail=2）→ 放行（可进源码编辑态）", () => {
    const { view, getState } = makeMockView(EditorState.create({ doc, schema }));
    const e = fakeMouseEvent({ detail: 2 });
    expect(handleBlockStopEvent(document.createElement("div"), view, () => codePos, e)).toBe(false);
    expect(getState().selection).not.toBeInstanceOf(NodeSelection);
  });

  it("右键（button=2）→ 放行", () => {
    const { view } = makeMockView(EditorState.create({ doc, schema }));
    const e = fakeMouseEvent({ button: 2 });
    expect(handleBlockStopEvent(document.createElement("div"), view, () => codePos, e)).toBe(false);
  });

  it("点击目标在交互控件内（select/button）→ 放行（不抢交互）", () => {
    const { view, getState } = makeMockView(EditorState.create({ doc, schema }));
    const select = document.createElement("select");
    const option = document.createElement("option");
    select.appendChild(option);
    document.body.appendChild(select);
    const e = fakeMouseEvent({ target: option });
    expect(handleBlockStopEvent(document.createElement("div"), view, () => codePos, e)).toBe(false);
    expect(getState().selection).not.toBeInstanceOf(NodeSelection);
  });

  it("已选中本块时再次单击 → 放行（第二次点击进编辑/交互）", () => {
    const initial = EditorState.create({
      doc,
      schema,
      selection: NodeSelection.create(doc, codePos),
    });
    const { view } = makeMockView(initial);
    const e = fakeMouseEvent({});
    expect(handleBlockStopEvent(document.createElement("div"), view, () => codePos, e)).toBe(false);
  });

  it("getPos 无效（undefined）→ 放行", () => {
    const { view } = makeMockView(EditorState.create({ doc, schema }));
    expect(
      handleBlockStopEvent(document.createElement("div"), view, () => undefined, fakeMouseEvent({})),
    ).toBe(false);
  });

  it("deleteSelection：NodeSelection 整节点删除（存盘无残留）", () => {
    const state = EditorState.create({ doc, schema, selection: NodeSelection.create(doc, codePos) });
    let newDoc = state.doc;
    const handled = deleteSelection(state, (tr) => {
      newDoc = state.apply(tr).doc;
    });
    expect(handled).toBe(true);
    expect(newDoc.childCount).toBe(2);
    expect(newDoc.child(0).textContent).toBe("a");
    expect(newDoc.child(1).textContent).toBe("b");
  });
});

describe("v0.12.0 需求6：NodeView 选中接线", () => {
  it("CodeBlockView：selectNode/deselectNode 增删 pm-block-selected", () => {
    const node = schema.node("code_block", { language: "" }, [schema.text("const a = 1;")]);
    const { view } = makeMockView(EditorState.create({ doc: schema.node("doc", null, [node]) }));
    const nv = new CodeBlockView(node, view, () => 0);
    nv.selectNode!();
    expect(nv.dom.classList.contains(BLOCK_SELECTED_CLASS)).toBe(true);
    nv.deselectNode!();
    expect(nv.dom.classList.contains(BLOCK_SELECTED_CLASS)).toBe(false);
    expect(typeof nv.stopEvent).toBe("function");
  });

  it("MathBlockView：同上（并验证 view/getPos 已保存可建 NodeSelection）", () => {
    const node = schema.node("math_block", null, [schema.text("x^2")]);
    const { view, getState } = makeMockView(
      EditorState.create({ doc: schema.node("doc", null, [node]) }),
    );
    const nv = new MathBlockView(node, view, () => 0);
    nv.selectNode!();
    expect(nv.dom.classList.contains(BLOCK_SELECTED_CLASS)).toBe(true);
    nv.deselectNode!();
    expect(nv.dom.classList.contains(BLOCK_SELECTED_CLASS)).toBe(false);
    // 单击建 NodeSelection（view/getPos 已保存）
    const handled = nv.stopEvent!(fakeMouseEvent({}));
    expect(handled).toBe(true);
    expect(getState().selection).toBeInstanceOf(NodeSelection);
  });

  it("MermaidBlockView / TableView 源码接线（构造重，避免实例化）", () => {
    const mermaid = readSrc("core/plugins/mermaid-block.ts");
    expect(mermaid).toContain("selectNode = () => applyBlockSelected(this.dom)");
    expect(mermaid).toContain("handleBlockStopEvent(this.dom, this.view, this.getPos, event)");
    const table = readSrc("core/plugins/table-editor.ts");
    expect(table).toContain("selectNode = () => applyBlockSelected(this.dom)");
    expect(table).toContain("handleBlockStopEvent(this.dom, this.view, this.getPos, event)");
  });

  it("选中样式用 outline（不得用 border——会改变表格布局）", () => {
    const css = readSrc("styles/editor.css");
    expect(css).toContain(".ProseMirror .pm-block-selected {");
    expect(css).toMatch(/\.pm-block-selected \{[^}]*outline: 2px solid var\(--accent-color\)/);
  });
});