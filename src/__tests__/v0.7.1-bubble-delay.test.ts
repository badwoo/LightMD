/**
 * v0.7.1 问题1修复验证：选中文本翻译气泡延迟设置生效
 *
 * 根因：plugin.apply 的 selectionSet 分支在鼠标拖选期间（PM selectionchange
 * 事务）立即置为可见，mouseup 延迟定时器到点时状态已可见 → 延迟失效。
 * 修复：可显示时保持 prev，显示仅由 mouseup 延迟 dispatch 驱动。
 *
 * 同时回归验证：
 * - 延迟期间选区清除 → 不显示
 * - getDelay 动态读取（设置变化后 mouseup 用新值）
 * - 选区清除/开关关闭 → 按钮立即隐藏（既有语义保持）
 */
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { markdownToDoc } from "../core/markdown/parser";
import {
  translateTooltipKey,
  createTranslateTooltipPlugin,
} from "../core/plugins/translateTooltip";

let view: EditorView | null = null;
let mount: HTMLElement | null = null;

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

/** 挂载带选区的编辑器（模拟用户已用鼠标选中文本后的状态） */
function mountWithSelection(md: string, needle: string, getDelay?: () => number): void {
  const doc = markdownToDoc(md);
  const pos = findTextPos(doc, needle);
  const plugin = createTranslateTooltipPlugin(
    () => {},
    () => true,
    getDelay ? { getDelay } : {}
  );
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, pos.from, pos.to),
    plugins: [plugin],
  });
  mount = document.createElement("div");
  document.body.appendChild(mount);
  // { mount } 形式：view.dom 即 mount 根节点（事件直接命中 view.dom）
  view = new EditorView({ mount }, { state });
}

/** 模拟鼠标拖选期间 PM 的 selectionchange 事务（selectionSet，无 mouseup） */
function dispatchSelectionChange(): void {
  const v = view!;
  const pos = v.state.selection;
  v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, pos.from, pos.to)));
}

function mouseUp(): void {
  mount!.dispatchEvent(
    new MouseEvent("mouseup", { bubbles: true, button: 0, cancelable: true })
  );
}

/** v0.7.3：浮动「译」按钮挂载于 body（display:none 即隐藏） */
function floatingTriggerVisible(): boolean {
  const floatEl = document.body.querySelector(
    ".translate-trigger-float"
  ) as HTMLElement | null;
  return !!floatEl && floatEl.style.display !== "none";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

afterEach(() => {
  view?.destroy();
  view = null;
  mount?.remove();
  mount = null;
  vi.restoreAllMocks();
});

describe("v0.7.1 问题1：翻译气泡延迟生效", () => {
  it("拖选期间 selectionchange 事务不立即显示（延迟生效核心）", () => {
    mountWithSelection("hello world", "world");
    // 初始隐藏
    expect(translateTooltipKey.getState(view!.state)).toBe(false);
    // 模拟拖选期间 PM dispatch 的 selectionSet 事务（修复前此处立即变 true，延迟失效）
    dispatchSelectionChange();
    expect(translateTooltipKey.getState(view!.state)).toBe(false);
    expect(floatingTriggerVisible()).toBe(false);
  });

  it("mouseup 后按 getDelay 延迟显示", async () => {
    mountWithSelection("hello world", "world", () => 80);
    dispatchSelectionChange();
    mouseUp();
    // 延迟未到：不显示
    expect(translateTooltipKey.getState(view!.state)).toBe(false);
    await sleep(120);
    // 延迟已到：显示
    expect(translateTooltipKey.getState(view!.state)).toBe(true);
    expect(floatingTriggerVisible()).toBe(true);
  });

  it("延迟 0 立即显示", async () => {
    mountWithSelection("hello world", "world", () => 0);
    mouseUp();
    await sleep(10);
    expect(translateTooltipKey.getState(view!.state)).toBe(true);
  });

  it("getDelay 动态读取：设置修改后新 mouseup 用新延迟值", async () => {
    let delay = 80;
    mountWithSelection("hello world", "world", () => delay);
    // 第一次：80ms 延迟
    mouseUp();
    await sleep(120);
    expect(translateTooltipKey.getState(view!.state)).toBe(true);
    // 清除选区隐藏按钮（模拟再次选择前状态）
    view!.dispatch(
      view!.state.tr.setSelection(TextSelection.create(view!.state.doc, 12))
    );
    expect(translateTooltipKey.getState(view!.state)).toBe(false);
    // 重新选中（模拟用户再次拖选，选区恢复）
    const doc = view!.state.doc;
    const p = findTextPos(doc, "world");
    view!.dispatch(view!.state.tr.setSelection(TextSelection.create(doc, p.from, p.to)));
    // 修改设置：延迟变长
    delay = 300;
    mouseUp();
    await sleep(120);
    expect(translateTooltipKey.getState(view!.state)).toBe(false); // 300ms 未到
    await sleep(250);
    expect(translateTooltipKey.getState(view!.state)).toBe(true); // 300ms 已到
  });

  it("延迟期间选区清除 → 定时器到点后不显示", async () => {
    mountWithSelection("hello world", "world", () => 80);
    mouseUp();
    // 延迟期间清除选区（点击别处）
    view!.dispatch(
      view!.state.tr.setSelection(TextSelection.create(view!.state.doc, 12))
    );
    await sleep(120);
    expect(translateTooltipKey.getState(view!.state)).toBe(false);
    expect(floatingTriggerVisible()).toBe(false);
  });

  it("连续 mouseup 重置计时器（不叠多个定时器）", async () => {
    mountWithSelection("hello world", "world", () => 100);
    mouseUp();
    await sleep(60);
    mouseUp(); // 重置：从现在起再等 100ms
    await sleep(60);
    expect(translateTooltipKey.getState(view!.state)).toBe(false); // 第一次的 100ms 已过但仍未显示
    await sleep(80);
    expect(translateTooltipKey.getState(view!.state)).toBe(true);
  });

  it("已显示后选区清除 → 立即隐藏（既有语义保持）", async () => {
    mountWithSelection("hello world", "world", () => 0);
    mouseUp();
    await sleep(10);
    expect(translateTooltipKey.getState(view!.state)).toBe(true);
    view!.dispatch(
      view!.state.tr.setSelection(TextSelection.create(view!.state.doc, 12))
    );
    expect(translateTooltipKey.getState(view!.state)).toBe(false);
    expect(floatingTriggerVisible()).toBe(false);
  });
});
