/**
 * E5(v0.9.2):IME 组合态 isComposing 守卫
 *
 * 修复前:PM 端 auto-pair 的 Backspace 成对删除与源码模式 textarea 的
 * 成对删除均未检查组合态——部分输入法组合期 isComposing=false 但
 * keyCode=229,拼音未上屏按 Backspace 会误触成对删除。
 * 验收:
 * 1. PM 端:组合态(isComposing / keyCode=229)Backspace → 不成对删除
 * 2. 非组合态空配对处 Backspace → 成对删除仍生效(回归)
 * 3. 源码模式 keydown 已接入同样守卫(源码断言)
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createEditor } from "../core/editor";
import { autoPairPlugin } from "../core/plugins/auto-pair";
import { useSettingsStore } from "../stores/useSettingsStore";
import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readSrc(rel: string): string {
  return readFileSync(join(root, rel), "utf-8");
}

/** 构造 keydown 事件对象(plain object,可控 isComposing/keyCode) */
function keyEvent(opts: { key: string; isComposing?: boolean; keyCode?: number }) {
  return {
    key: opts.key,
    isComposing: opts.isComposing ?? false,
    keyCode: opts.keyCode ?? 0,
    preventDefault: () => {},
    stopPropagation: () => {},
  };
}

describe("E5: PM 端成对删除 IME 守卫", () => {
  let parent: HTMLDivElement;
  let view: EditorView | null;

  beforeEach(() => {
    parent = document.createElement("div");
    document.body.appendChild(parent);
    useSettingsStore.getState().setAutoPairEnabled(true);
  });

  afterEach(() => {
    if (view) {
      view.destroy();
      view = null;
    }
    parent.remove();
    useSettingsStore.getState().setAutoPairEnabled(true);
  });

  /** 建立含空配对 "(x)" → 光标置于 ) 前即 (x|) 的文档 */
  function mkEditorWithEmptyPair(): EditorView {
    const v = createEditor({ parent, initialContent: "()" }) as EditorView;
    // 光标移到 ( 与 ) 之间(位置 2)
    const pos = 2;
    const tr = v.state.tr;
    v.dispatch(tr.setSelection(TextSelection.create(v.state.doc, pos)));
    return v;
  }

  it("非组合态空配对处 Backspace → 成对删除(回归)", () => {
    const v = mkEditorWithEmptyPair();
    view = v;
    const before = v.state.doc.textContent;
    expect(before).toBe("()");
    const plugin = autoPairPlugin();
    const props = (plugin.spec.props ?? {}) as {
      handleKeyDown?: (view: EditorView, event: unknown) => boolean;
    };
    const handled = props.handleKeyDown?.(v, keyEvent({ key: "Backspace" })) ?? false;
    expect(handled).toBe(true);
    expect(v.state.doc.textContent).toBe("");
  });

  it("isComposing=true 的 Backspace → 不触发成对删除", () => {
    const v = mkEditorWithEmptyPair();
    view = v;
    const plugin = autoPairPlugin();
    const props = (plugin.spec.props ?? {}) as {
      handleKeyDown?: (view: EditorView, event: unknown) => boolean;
    };
    const handled = props.handleKeyDown?.(v, keyEvent({ key: "Backspace", isComposing: true })) ?? true;
    expect(handled).toBe(false);
    expect(v.state.doc.textContent).toBe("()");
  });

  it("keyCode=229 的 Backspace(部分输入法组合期)→ 不触发成对删除", () => {
    const v = mkEditorWithEmptyPair();
    view = v;
    const plugin = autoPairPlugin();
    const props = (plugin.spec.props ?? {}) as {
      handleKeyDown?: (view: EditorView, event: unknown) => boolean;
    };
    const handled = props.handleKeyDown?.(v, keyEvent({ key: "Backspace", keyCode: 229 })) ?? true;
    expect(handled).toBe(false);
    expect(v.state.doc.textContent).toBe("()");
  });
});

describe("E5: 源码模式 textarea 成对删除 IME 守卫(源码断言)", () => {
  it("EditorContainer keydown 的 Backspace 成对删除已检查 isComposing/keyCode", () => {
    const src = readSrc("src/components/editor/EditorContainer.tsx");
    expect(src).toMatch(/isComposing\s*\|\|\s*\w+\.keyCode\s*===\s*229/);
  });

  it("auto-pair PM 端 handleKeyDown 已检查 isComposing/keyCode", () => {
    const src = readSrc("src/core/plugins/auto-pair.ts");
    expect(src).toMatch(/isComposing\s*\|\|\s*event\.keyCode\s*===\s*229/);
  });
});
