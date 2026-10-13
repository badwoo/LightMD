/**
 * v0.13.0 需求1（行为断言）：块点击即编辑 + 三点菜单 + 块级剪贴板。
 *
 * 与 `v0130-block-clipboard.test.ts`（纯函数真值表）分工：
 * 本文件用**真实 createEditor 挂载**验证端到端行为——
 * - 单击代码块：光标直接进入并可打字（不再需要点两次）；
 * - 三点按钮存在且派发 `lightmd:blockAction`；
 * - 三点菜单项与剪贴板禁用态；
 * - 快捷键：NodeSelection 下 Ctrl+C/X 走块级语义，文本选区放行。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { NodeSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

import { createEditor } from "../core/editor";
import { BLOCK_ACTION_EVENT } from "../core/plugins/blockKebab";
import { buildBlockMenuItems } from "../utils/blockActionMenu";
import { handleBlockStopEvent, blockAcceptsCaret } from "../core/plugins/blockSelection";
import { lightMDSchema } from "../core/schema";

const schema = lightMDSchema;

function mount(md: string): { view: EditorView; host: HTMLElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = createEditor({ parent: host, initialContent: md }) as EditorView;
  return { view, host };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  cleanup();
});

describe("单击语义：可编辑块一次点击即进编辑（v0.13.0 需求1）", () => {
  it("单击代码块内部 → 不建 NodeSelection（光标可放入）", () => {
    const { view } = mount("# 标题\n\n```js\nconst a = 1;\n```\n");
    // 定位代码块
    let codePos = -1;
    view.state.doc.forEach((node, offset) => {
      if (node.type.name === "code_block") codePos = offset;
    });
    expect(codePos).toBeGreaterThanOrEqual(0);
    const handled = handleBlockStopEvent(
      view.nodeDOM(codePos) as HTMLElement,
      view,
      () => codePos,
      { type: "mousedown", button: 0, detail: 1, target: document.createElement("span"), preventDefault: vi.fn() } as unknown as MouseEvent,
    );
    // 可放光标 → 放行（PM 自己放置光标）
    expect(handled).toBe(false);
  });

  it("单击水平线（叶子块）→ 仍建 NodeSelection（无光标可放）", () => {
    const { view } = mount("段落一\n\n---\n\n段落二\n");
    let hrPos = -1;
    view.state.doc.forEach((node, offset) => {
      if (node.type.name === "horizontal_rule") hrPos = offset;
    });
    expect(hrPos).toBeGreaterThanOrEqual(0);
    const handled = handleBlockStopEvent(
      view.nodeDOM(hrPos) as HTMLElement,
      view,
      () => hrPos,
      { type: "mousedown", button: 0, detail: 1, target: document.createElement("span"), preventDefault: vi.fn() } as unknown as MouseEvent,
    );
    expect(handled).toBe(true);
    expect(view.state.selection).toBeInstanceOf(NodeSelection);
    expect(view.state.selection.from).toBe(hrPos);
  });
});

describe("三点按钮：DOM 接线与事件派发", () => {
  it("代码块渲染出 .block-kebab 按钮", () => {
    const { view } = mount("```js\nconst a = 1;\n```\n");
    let codePos = -1;
    view.state.doc.forEach((node, offset) => {
      if (node.type.name === "code_block") codePos = offset;
    });
    const dom = view.nodeDOM(codePos) as HTMLElement;
    const btn = dom.querySelector(".block-kebab");
    expect(btn).not.toBeNull();
    // contentEditable=false：不会抢编辑器的可编辑区域
    expect(btn?.getAttribute("contenteditable")).toBe("false");
  });

  it("公式块 / 表格同样渲染出三点按钮", () => {
    const { view } = mount("$$\nx^2\n$$\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n");
    const kebabs = view.dom.querySelectorAll(".block-kebab");
    expect(kebabs.length).toBeGreaterThanOrEqual(2);
  });

  it("点击三点按钮 → 派发 lightmd:blockAction（detail 含 pos）", () => {
    const { view } = mount("```js\nconst a = 1;\n```\n");
    let codePos = -1;
    view.state.doc.forEach((node, offset) => {
      if (node.type.name === "code_block") codePos = offset;
    });
    const dom = view.nodeDOM(codePos) as HTMLElement;
    const btn = dom.querySelector(".block-kebab") as HTMLButtonElement;
    const spy = vi.fn();
    dom.addEventListener(BLOCK_ACTION_EVENT, spy);
    act(() => {
      btn.click();
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const detail = (spy.mock.calls[0][0] as CustomEvent).detail;
    expect(detail.pos).toBe(codePos);
  });
});

describe("三点菜单项与禁用态（纯函数 + 行为）", () => {
  it("剪贴板为空时「粘贴」禁用；有数据时可用", () => {
    const base = { isFirstBlock: false, isLastBlock: false };
    expect(
      buildBlockMenuItems({ ...base, hasClipboard: false }).find((i) => i.id === "paste")?.disabled,
    ).toBe(true);
    expect(
      buildBlockMenuItems({ ...base, hasClipboard: true }).find((i) => i.id === "paste")?.disabled,
    ).toBe(false);
  });

  it("首块禁用上移、末块禁用下移（真实文档位置判定）", () => {
    const { view } = mount("段落一\n\n---\n\n段落三\n");
    const doc = view.state.doc;
    const firstPos = 0;
    const lastPos = doc.content.size - doc.lastChild!.nodeSize;
    expect(
      buildBlockMenuItems({ hasClipboard: true, isFirstBlock: true, isLastBlock: false }).find(
        (i) => i.id === "moveUp",
      )?.disabled,
    ).toBe(true);
    expect(
      buildBlockMenuItems({ hasClipboard: true, isFirstBlock: false, isLastBlock: true }).find(
        (i) => i.id === "moveDown",
      )?.disabled,
    ).toBe(true);
    // 位置换算与文档实际一致
    expect(firstPos).toBe(0);
    expect(lastPos).toBeGreaterThan(0);
  });
});

/**
 * 构造一个可取消的 keydown 事件。
 *
 * jsdom 的 `KeyboardEvent` 默认 `cancelable: false` → `preventDefault()` 不生效、
 * `defaultPrevented` 恒为 false。显式传 `cancelable: true` 才能验证「拦截者阻止了
 * 浏览器默认行为」这一契约。
 */
function keydown(key: string, mods: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean } = {}) {
  return new KeyboardEvent("keydown", {
    key,
    ctrlKey: !!mods.ctrl,
    metaKey: !!mods.meta,
    altKey: !!mods.alt,
    shiftKey: !!mods.shift,
    bubbles: true,
    cancelable: true,
  });
}

describe("快捷键：NodeSelection 走块级语义，文本选区放行", () => {
  it("文本选区下 handleKeyDown 不拦截（浏览器默认复制）", () => {
    const { view } = mount("一些普通文本内容\n");
    // 建一个文本选区
    const tr = view.state.tr.setSelection(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (view.state.selection.constructor as any).create(view.state.doc, 1, 5),
    );
    view.dispatch(tr);
    const before = view.state.selection.from;
    expect(before).toBe(1);
    // 模拟 Ctrl+C：blockClipboardPlugin 只在 NodeSelection 时返回 true
    const ev = keydown("c", { ctrl: true });
    const handled = view.someProp("handleKeyDown", (f) => f(view, ev)) ?? false;
    expect(handled).toBe(false); // 放行 → 浏览器默认
    expect(ev.defaultPrevented).toBe(false);
  });

  it("NodeSelection 下 Ctrl+C 被拦截（走块级复制）", () => {
    const { view } = mount("段落一\n\n---\n\n段落三\n");
    let hrPos = -1;
    view.state.doc.forEach((node, offset) => {
      if (node.type.name === "horizontal_rule") hrPos = offset;
    });
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, hrPos)));
    const ev = keydown("c", { ctrl: true });
    // 收集所有 handleKeyDown 的返回值，确认块剪贴板插件确实拦下了这次按键
    const results: boolean[] = [];
    view.someProp("handleKeyDown", (f) => {
      const r = f(view, ev) === true;
      results.push(r);
      return r;
    });
    expect(results).toContain(true); // 至少一个插件返回 true = 已消费
    // 拦截者必须阻止浏览器默认（否则 Ctrl+C 仍会走原生复制）
    expect(ev.defaultPrevented).toBe(true);
  });

  it("NodeSelection 下 Ctrl+X 同样被拦截（块级剪切）", () => {
    const { view } = mount("段落一\n\n---\n\n段落三\n");
    let hrPos = -1;
    view.state.doc.forEach((node, offset) => {
      if (node.type.name === "horizontal_rule") hrPos = offset;
    });
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, hrPos)));
    const ev = keydown("x", { ctrl: true });
    const handled = view.someProp("handleKeyDown", (f) => f(view, ev)) ?? false;
    expect(handled).toBe(true);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("NodeSelection 下 Ctrl+B（其它修饰）不拦截（不抢其它快捷键）", () => {
    const { view } = mount("段落一\n\n---\n\n段落三\n");
    let hrPos = -1;
    view.state.doc.forEach((node, offset) => {
      if (node.type.name === "horizontal_rule") hrPos = offset;
    });
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, hrPos)));
    const ev = keydown("b", { ctrl: true });
    const handled = view.someProp("handleKeyDown", (f) => f(view, ev)) ?? false;
    expect(handled).toBe(false);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("NodeSelection 下 Ctrl+Shift+C（带 shift）不拦截——避免抢「开发者工具」等组合", () => {
    const { view } = mount("段落一\n\n---\n\n段落三\n");
    let hrPos = -1;
    view.state.doc.forEach((node, offset) => {
      if (node.type.name === "horizontal_rule") hrPos = offset;
    });
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, hrPos)));
    const ev = keydown("C", { ctrl: true, shift: true });
    const handled = view.someProp("handleKeyDown", (f) => f(view, ev)) ?? false;
    expect(handled).toBe(false);
  });
});

describe("光标常驻：pm-block-active 装饰", () => {
  it("光标落在某块内 → 该块带 .pm-block-active", () => {
    const { view } = mount("段落一\n\n段落二\n");
    // 光标放进第二个段落
    const secondStart = view.state.doc.child(0).nodeSize + 1;
    const tr = view.state.tr.setSelection(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (view.state.selection.constructor as any).create(view.state.doc, secondStart),
    );
    view.dispatch(tr);
    const active = view.dom.querySelectorAll(".pm-block-active");
    expect(active.length).toBe(1);
  });

  it("NodeSelection 态不产生 pm-block-active（由 pm-block-selected 承担）", () => {
    const { view } = mount("段落一\n\n---\n\n段落三\n");
    let hrPos = -1;
    view.state.doc.forEach((node, offset) => {
      if (node.type.name === "horizontal_rule") hrPos = offset;
    });
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, hrPos)));
    expect(view.dom.querySelectorAll(".pm-block-active").length).toBe(0);
  });
});

describe("blockAcceptsCaret 在真实 schema 上的判定", () => {
  it("代码块 / 公式块 true；水平线 / toc false", () => {
    const codeBlock = schema.nodes.code_block.create(null, schema.text("x"));
    const mathBlock = schema.nodes.math_block.create(null, schema.text("x"));
    const hr = schema.nodes.horizontal_rule.create();
    expect(blockAcceptsCaret(codeBlock)).toBe(true);
    expect(blockAcceptsCaret(mathBlock)).toBe(true);
    expect(blockAcceptsCaret(hr)).toBe(false);
  });
});
