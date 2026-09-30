/**
 * Mod+Shift+S 删除线快捷键测试
 *
 * 测试内容：
 * 1. toggleMark(schema.marks.strike) 命令的功能（添加/切换/移除 strike mark）
 * 2. buildKeymap() 返回的 Plugin 包含 handleKeyDown 处理器
 * 3. 通过 mock KeyboardEvent 触发快捷键，验证删除线被添加
 */
import { describe, it, expect } from "vitest";
import { EditorState, TextSelection, Plugin } from "prosemirror-state";
import { Node } from "prosemirror-model";
import { toggleMark } from "prosemirror-commands";
import { lightMDSchema as schema } from "../core/schema";
import { buildKeymap, dynamicShortcutsPlugin } from "../core/keymap";
import { setShortcutOverrides } from "../core/shortcuts";

const isMac = typeof navigator !== "undefined" ? /Mac/.test(navigator.platform) : false;

function makeDocWithText(text: string): Node {
  return schema.topNodeType.create(null, [
    schema.nodes.paragraph.create(null, schema.text(text)),
  ]);
}

function makeDocWithMarkedText(text: string, marks: ReturnType<typeof schema.mark>[]): Node {
  const textNode = schema.text(text, marks);
  return schema.topNodeType.create(null, [
    schema.nodes.paragraph.create(null, textNode),
  ]);
}

function makeKeyEvent(key: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}): any {
  return {
    key,
    code: `Key${key.toUpperCase()}`,
    ctrlKey: !!mods.ctrl,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    metaKey: !!mods.meta,
    preventDefault: () => {},
    stopPropagation: () => {},
  };
}

function dispatchKey(state: EditorState, event: any): { handled: boolean; newState: EditorState } {
  // v0.9.0 自定义快捷键：动态键位插件（生效表匹配）先行，未命中 fallthrough 静态 keymap
  const plugins = [dynamicShortcutsPlugin(), buildKeymap()];
  let newState = state;
  const fakeView: any = {
    state,
    dispatch: (tr: any) => { newState = state.apply(tr); },
  };
  let handled = false;
  for (const plugin of plugins) {
    const props = plugin.spec.props as any;
    if (props?.handleKeyDown && props.handleKeyDown(fakeView, event)) {
      handled = true;
      break;
    }
  }
  return { handled, newState };
}

function rangeHasMark(doc: Node, from: number, to: number, markName: string): boolean {
  let found = false;
  doc.nodesBetween(from, to, (node) => {
    if (node.isText && node.marks.some(m => m.type.name === markName)) {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

describe("toggleMark(schema.marks.strike) 命令功能", () => {
  it("为选中文本添加删除线 mark", () => {
    const doc = makeDocWithText("hello world");
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1, 6),
    });
    let newTr: any = null;
    const result = toggleMark(schema.marks.strike)(state, (tr) => { newTr = tr; });
    expect(result).toBe(true);
    expect(newTr).not.toBeNull();
    expect(rangeHasMark(newTr.doc, 1, 6, "strike")).toBe(true);
    expect(rangeHasMark(newTr.doc, 7, 11, "strike")).toBe(false);
  });

  it("切换删除线（已有 strike mark 时移除）", () => {
    const strikeMark = schema.mark("strike");
    const doc = makeDocWithMarkedText("hello", [strikeMark]);
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1, 6),
    });
    let newTr: any = null;
    toggleMark(schema.marks.strike)(state, (tr) => { newTr = tr; });
    expect(rangeHasMark(newTr.doc, 1, 6, "strike")).toBe(false);
  });

  it("保留其他 mark（同时有 strong 和 strike，仅切换 strike）", () => {
    const boldMark = schema.mark("strong");
    const strikeMark = schema.mark("strike");
    const doc = makeDocWithMarkedText("hi", [boldMark, strikeMark]);
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1, 3),
    });
    let newTr: any = null;
    toggleMark(schema.marks.strike)(state, (tr) => { newTr = tr; });
    expect(rangeHasMark(newTr.doc, 1, 3, "strike")).toBe(false);
    expect(rangeHasMark(newTr.doc, 1, 3, "strong")).toBe(true);
  });

  it("在已有 strong mark 的文本上添加 strike mark（叠加）", () => {
    const boldMark = schema.mark("strong");
    const doc = makeDocWithMarkedText("hi", [boldMark]);
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1, 3),
    });
    let newTr: any = null;
    toggleMark(schema.marks.strike)(state, (tr) => { newTr = tr; });
    expect(rangeHasMark(newTr.doc, 1, 3, "strike")).toBe(true);
    expect(rangeHasMark(newTr.doc, 1, 3, "strong")).toBe(true);
  });

  it("对包含中文的选区添加删除线", () => {
    const doc = makeDocWithText("你好世界");
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1, 5),
    });
    let newTr: any = null;
    toggleMark(schema.marks.strike)(state, (tr) => { newTr = tr; });
    expect(rangeHasMark(newTr.doc, 1, 5, "strike")).toBe(true);
  });
});

describe("buildKeymap 插件集成", () => {
  it("buildKeymap 应返回有效 Plugin 实例", () => {
    const plugin = buildKeymap();
    expect(plugin).toBeInstanceOf(Plugin);
    expect(typeof (plugin.spec.props as any)?.handleKeyDown).toBe("function");
  });

  it("Ctrl+Alt+S（Windows/Linux，D1 统一键位）应触发 toggleMark(strike)", () => {
    if (isMac) return;
    const doc = makeDocWithText("hello world");
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1, 6),
    });
    const event = makeKeyEvent("s", { ctrl: true, alt: true });
    const { handled, newState } = dispatchKey(state, event);
    expect(handled).toBe(true);
    expect(rangeHasMark(newState.doc, 1, 6, "strike")).toBe(true);
  });

  it("旧键 Ctrl+Shift+S 不再触发删除线（D1：让位给另存为）", () => {
    if (isMac) return;
    setShortcutOverrides({});
    const doc = makeDocWithText("hello world");
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1, 6),
    });
    const event = makeKeyEvent("s", { ctrl: true, shift: true });
    const { handled } = dispatchKey(state, event);
    expect(handled).toBe(false);
  });

  it("Cmd+Alt+S（Mac，D1 统一键位）应触发 toggleMark(strike)", () => {
    if (!isMac) return;
    const doc = makeDocWithText("hello world");
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1, 6),
    });
    const event = makeKeyEvent("s", { meta: true, alt: true });
    const { handled, newState } = dispatchKey(state, event);
    expect(handled).toBe(true);
    expect(rangeHasMark(newState.doc, 1, 6, "strike")).toBe(true);
  });

  it("仅按 S（无修饰键）不应触发删除线", () => {
    const doc = makeDocWithText("hello");
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1, 5),
    });
    const event = makeKeyEvent("s", {});
    const { handled } = dispatchKey(state, event);
    expect(handled).toBe(false);
  });

  it("Ctrl+S（无 Shift）不应触发删除线", () => {
    const doc = makeDocWithText("hello");
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1, 5),
    });
    const event = makeKeyEvent("s", { ctrl: true });
    const { handled } = dispatchKey(state, event);
    expect(handled).toBe(false);
  });
});
