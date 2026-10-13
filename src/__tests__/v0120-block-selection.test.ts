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

/** 构造 mock EditorView（state getter + dispatch 写回 + focus 记录） */
function makeMockView(initial: EditorState) {
  let state = initial;
  const focusCalls: number[] = [];
  const view = {
    get state() {
      return state;
    },
    dispatch: (tr: { doc: unknown } & Parameters<EditorState["apply"]>[0]) => {
      state = state.apply(tr as Parameters<EditorState["apply"]>[0]);
    },
    // v0.12.1 需求6：块级选中后要 view.focus()（真机 EditorView 有此方法）
    focus: () => {
      focusCalls.push(1);
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
    focusCalls,
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
  it("左键单击 + 非交互 + 未选中 + 块不可放光标 → true", () => {
    expect(
      shouldSelectBlockOnMouseDown({
        isPlainLeftClick: true,
        onInteractive: false,
        alreadySelected: false,
        acceptsCaret: false,
      }),
    ).toBe(true);
  });

  it("双击（detail≠1）/右键 / 交互控件 / 已选中 → false", () => {
    expect(
      shouldSelectBlockOnMouseDown({
        isPlainLeftClick: false,
        onInteractive: false,
        alreadySelected: false,
        acceptsCaret: false,
      }),
    ).toBe(false);
    expect(
      shouldSelectBlockOnMouseDown({
        isPlainLeftClick: true,
        onInteractive: true,
        alreadySelected: false,
        acceptsCaret: false,
      }),
    ).toBe(false);
    expect(
      shouldSelectBlockOnMouseDown({
        isPlainLeftClick: true,
        onInteractive: false,
        alreadySelected: true,
        acceptsCaret: false,
      }),
    ).toBe(false);
  });

  // v0.13.0 需求1：可放光标的块（代码块/公式块/表格单元格文本）不拦——
  // 单击即进入编辑，不再需要点两次
  it("块可放光标（acceptsCaret=true）→ false：单击直接进编辑", () => {
    expect(
      shouldSelectBlockOnMouseDown({
        isPlainLeftClick: true,
        onInteractive: false,
        alreadySelected: false,
        acceptsCaret: true,
      }),
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
  // v0.13.0 需求1：不可放光标的叶子块才拦 mousedown。用 horizontal_rule（无 content）
  // 代表这一类——代码块/公式块现在都直接放行（单击即编辑）。
  const leafDoc = schema.node("doc", null, [
    schema.node("paragraph", null, [schema.text("a")]),
    schema.node("horizontal_rule"),
    schema.node("paragraph", null, [schema.text("b")]),
  ]);
  const hrPos = leafDoc.child(0).nodeSize;

  it("单击叶子块（horizontal_rule）→ 拦下并建立 NodeSelection（preventDefault 被调）", () => {
    const { view, getState, focusCalls } = makeMockView(EditorState.create({ doc: leafDoc, schema }));
    const dom = document.createElement("div");
    const e = fakeMouseEvent({});
    const handled = handleBlockStopEvent(dom, view, () => hrPos, e);
    expect(handled).toBe(true);
    const sel = getState().selection;
    expect(sel).toBeInstanceOf(NodeSelection);
    expect(sel.from).toBe(hrPos);
    expect(e.preventDefault).toHaveBeenCalled();
    // v0.12.1 需求6：preventDefault 会吃掉浏览器的自动聚焦，必须显式把焦点交还编辑器，
    // 否则后续按键（→ 退出代码块 / Delete 删块）都到不了 ProseMirror
    expect(focusCalls.length).toBe(1);
  });

  // v0.13.0 需求1：代码块可放光标 → 不拦 mousedown，单击直接进编辑
  it("单击代码块 → 放行（不再需要点两次才能编辑）", () => {
    const { view, getState, focusCalls } = makeMockView(EditorState.create({ doc, schema }));
    const e = fakeMouseEvent({});
    const handled = handleBlockStopEvent(document.createElement("div"), view, () => codePos, e);
    expect(handled).toBe(false);
    expect(getState().selection).not.toBeInstanceOf(NodeSelection);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(focusCalls.length).toBe(0);
  });

  it("放行路径（双击/右键/交互控件）不得抢焦点", () => {
    const { view, focusCalls } = makeMockView(EditorState.create({ doc, schema }));
    handleBlockStopEvent(document.createElement("div"), view, () => codePos, fakeMouseEvent({ detail: 2 }));
    handleBlockStopEvent(document.createElement("div"), view, () => codePos, fakeMouseEvent({ button: 2 }));
    expect(focusCalls.length).toBe(0);
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
    // v0.13.0 需求1：公式块可放光标 → 单击放行（直接进编辑，不再建 NodeSelection）
    const handled = nv.stopEvent!(fakeMouseEvent({}));
    expect(handled).toBe(false);
    expect(getState().selection).not.toBeInstanceOf(NodeSelection);
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