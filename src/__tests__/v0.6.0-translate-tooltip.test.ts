/**
 * v0.6.0 + v0.7.3：translateTooltip 插件测试
 *
 * 覆盖：
 * 1. shouldShowTrigger：空选区 false / 文本选区 true / code_block 选区 false
 * 2. v0.7.3 positionFloatingTrigger：真浮动定位（右缘对齐、顶部越界回落、视口钳制）
 * 3. createTriggerButton：click 触发回调 / mousedown 阻止默认行为
 * 4. 插件状态机：mouseup 后显示、选区清除后隐藏（apply 重算）
 * 5. 集成：EditorView 渲染浮动按钮（挂载于 body，不再占文本空间）、点击回调 view
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { markdownToDoc } from "../core/markdown/parser";
import {
  translateTooltipKey,
  shouldShowTrigger,
  createTriggerButton,
  positionFloatingTrigger,
  createTranslateTooltipPlugin,
  findViewFromDOM,
} from "../core/plugins/translateTooltip";

/** 查找文本位置 */
function findTextPos(doc: PMNode, needle: string): { from: number; to: number } {
  let found: { from: number; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (!node.isText || !node.text) return true;
    const idx = node.text.indexOf(needle);
    if (idx >= 0) {
      found = { from: pos + idx, to: pos + idx + needle.length };
      return false;
    }
    return true;
  });
  if (!found) throw new Error(`text not found: ${needle}`);
  return found;
}

/** 选中指定文本的 state（含翻译插件） */
function makeState(md: string, needle?: string, onTrigger?: (view: EditorView) => void) {
  const doc = markdownToDoc(md);
  const plugin = createTranslateTooltipPlugin(onTrigger ?? (() => {}));
  const selection =
    needle
      ? TextSelection.create(doc, findTextPos(doc, needle).from, findTextPos(doc, needle).to)
      : TextSelection.create(doc, 1);
  return EditorState.create({ doc, selection, plugins: [plugin] });
}

/** 创建挂载的 view */
function mountView(state: EditorState): { view: EditorView; mount: HTMLElement } {
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const view = new EditorView({ mount }, { state });
  return { view, mount };
}

/** 等待 setTimeout(0) 刷新 */
function flushTimeout(): Promise<void> {
  return new Promise((r) => setTimeout(r, 5));
}

/** 获取 body 下当前可见的浮动「译」按钮（v0.7.3：浮动元素挂载于 body） */
function floatingBtn(): HTMLSpanElement | null {
  const floatEl = document.body.querySelector(
    ".translate-trigger-float"
  ) as HTMLElement | null;
  if (!floatEl) return null;
  if (floatEl.style.display === "none") return null;
  return floatEl.querySelector(".translate-trigger") as HTMLSpanElement | null;
}

describe("v0.6.0 translateTooltip - shouldShowTrigger", () => {
  it("空选区不显示", () => {
    const state = makeState("hello world");
    expect(shouldShowTrigger(state)).toBe(false);
  });

  it("文本选区显示", () => {
    const state = makeState("hello world", "world");
    expect(shouldShowTrigger(state)).toBe(true);
  });

  it("code_block 选区不显示", () => {
    const state = makeState("```\nconst a = 1;\n```", "const");
    expect(shouldShowTrigger(state)).toBe(false);
  });
});

describe("v0.7.3 translateTooltip - positionFloatingTrigger 真浮动定位", () => {
  function rect(l: number, t: number, r: number, b: number) {
    return { left: l, top: t, right: r, bottom: b };
  }
  const SIZE = { width: 28, height: 28 };

  it("浮动于选区右上角（右缘贴合选区、位于选区首行上方）", () => {
    const el = document.createElement("div");
    const from = rect(100, 200, 300, 220);
    const to = rect(300, 200, 500, 220);
    const { left, top } = positionFloatingTrigger(el, from, to, { width: 800, height: 600 }, SIZE);
    // 右缘 = max(right)=500，按钮右缘贴选区右缘 → x = 500 - 28 - 4 = 468
    // 首行 y = min(top)=200，按钮在选区上方 → y = 200 - 28 - 4 = 168
    expect(left).toBe(468);
    expect(top).toBe(168);
    expect(el.style.left).toBe("468px");
    expect(el.style.top).toBe("168px");
  });

  it("顶部越界时落到选区首行下方", () => {
    const el = document.createElement("div");
    const from = rect(100, 2, 300, 22);
    const to = rect(300, 2, 500, 22);
    const { left, top } = positionFloatingTrigger(el, from, to, { width: 800, height: 600 }, SIZE);
    // y = 2 - 28 - 4 = -30 < MARGIN(8) → 落到首行下方 y = 2 + 4 = 6
    expect(top).toBe(6);
  });

  it("左侧越界时钳制到 MARGIN", () => {
    const el = document.createElement("div");
    const from = rect(0, 200, 30, 220);
    const to = rect(30, 200, 40, 220);
    const { left } = positionFloatingTrigger(el, from, to, { width: 800, height: 600 }, SIZE);
    // x = max(right)-28-4 = 40-32 = 8，未小于 MARGIN(8) → 8
    expect(left).toBe(8);
  });

  it("右侧越界时钳制回视口内", () => {
    const el = document.createElement("div");
    const from = rect(760, 200, 790, 220);
    const to = rect(790, 200, 800, 220);
    const { left } = positionFloatingTrigger(el, from, to, { width: 800, height: 600 }, SIZE);
    // x = 800-32 = 768 > 宽-MARGIN-width... 检查越界 → 钳制
    expect(left).toBe(800 - SIZE.width - 8);
  });
});

describe("v0.6.0 translateTooltip - createTriggerButton", () => {
  it("click 触发回调并携带按钮元素", () => {
    const onClick = vi.fn();
    const btn = createTriggerButton(onClick);
    expect(btn.className).toBe("translate-trigger");
    expect(btn.textContent).toBe("译");
    btn.click();
    expect(onClick).toHaveBeenCalledWith(btn);
  });

  it("mousedown 阻止默认行为（保持选区）", () => {
    const btn = createTriggerButton(() => {});
    const event = new MouseEvent("mousedown", { cancelable: true });
    btn.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("v0.6.0 translateTooltip - 插件状态机", () => {
  it("初始状态为隐藏", () => {
    const state = makeState("hello world", "world");
    // init 为 false：即使构造时选区非空，也要等 mouseup 刷新（避免加载即显示）
    expect(translateTooltipKey.getState(state)).toBe(false);
  });

  it("meta dispatch 更新可见性", () => {
    const state = makeState("hello world", "world");
    const tr = state.tr.setMeta(translateTooltipKey, true);
    const newState = state.apply(tr);
    expect(translateTooltipKey.getState(newState)).toBe(true);
  });

  it("选区清除后 apply 重算为隐藏", () => {
    let state = makeState("hello world", "world");
    // 先显示
    state = state.apply(state.tr.setMeta(translateTooltipKey, true));
    expect(translateTooltipKey.getState(state)).toBe(true);
    // 折叠选区（selectionSet）→ 重算为 false
    const collapsed = state.tr.setSelection(
      TextSelection.create(state.doc, state.selection.to)
    );
    const newState = state.apply(collapsed);
    expect(translateTooltipKey.getState(newState)).toBe(false);
  });
});

describe("v0.6.0 translateTooltip - EditorView 集成（v0.7.3 真浮动）", () => {
  let view: EditorView;
  let mount: HTMLElement;

  afterEach(() => {
    view?.destroy();
    mount?.remove();
  });

  it("mouseup 后浮动按钮显示于 body，点击触发回调", async () => {
    const onTrigger = vi.fn();
    const state = makeState("hello world", "world", onTrigger);
    ({ view, mount } = mountView(state));

    // 初始无可见按钮（浮动元素 display:none）
    expect(floatingBtn()).toBeNull();

    // 模拟 mouseup（左键）——{ mount } 模式下 mount 即 .ProseMirror 根节点
    mount.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, button: 0, cancelable: true })
    );
    await flushTimeout();

    // 状态刷新为可见，浮动按钮渲染（挂载于 body，不占文档空间）
    expect(translateTooltipKey.getState(view.state)).toBe(true);
    const btn = floatingBtn();
    expect(btn).not.toBeNull();

    // 点击按钮 → onTrigger 携带 view
    btn!.click();
    expect(onTrigger).toHaveBeenCalledWith(view);
  });

  it("选区清除后按钮隐藏", async () => {
    const state = makeState("hello world", "world");
    ({ view, mount } = mountView(state));

    // 触发显示
    view.dispatch(view.state.tr.setMeta(translateTooltipKey, true));
    expect(floatingBtn()).not.toBeNull();

    // 折叠选区 → apply 重算隐藏，浮动元素 display:none
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, 12))
    );
    expect(floatingBtn()).toBeNull();
  });

  it("findViewFromDOM 对未挂载元素返回 null", () => {
    const orphan = document.createElement("span");
    expect(findViewFromDOM(orphan)).toBeNull();
  });

  // ─── v0.6.0 优化：气泡图标 + 总开关 ──────────
  it("浮动按钮渲染 SVG 气泡图标（含「译」字与气泡轮廓）", async () => {
    const state = makeState("hello world", "world");
    ({ view, mount } = mountView(state));
    mount.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, button: 0, cancelable: true })
    );
    await flushTimeout();
    const btn = floatingBtn() as HTMLSpanElement;
    // SVG 气泡轮廓 + 译字 glyph
    expect(btn.querySelector("svg .translate-trigger-bubble")).not.toBeNull();
    expect(btn.querySelector("svg .translate-trigger-glyph")?.textContent).toBe("译");
    // title 提示 F6 快捷键
    expect(btn.title).toContain("F6");
  });

  it("enabled 返回 false 时按钮不显示（总开关关闭）", async () => {
    const doc = markdownToDoc("hello world");
    const pos = findTextPos(doc, "world");
    const plugin = createTranslateTooltipPlugin(
      () => {},
      () => false // 总开关关闭
    );
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, pos.from, pos.to),
      plugins: [plugin],
    });
    ({ view, mount } = mountView(state));
    mount.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, button: 0, cancelable: true })
    );
    await flushTimeout();
    // 有选区但开关关闭 → 不显示
    expect(translateTooltipKey.getState(view.state)).toBe(false);
    expect(floatingBtn()).toBeNull();
  });
});