/**
 * v0.5.0 N1：自动配对补全（基线能力回归，v0.12.1 需求4 重写后同步更新）
 *
 * 验收标准：
 * 1. PM 端：无选区输入开符号 → 插入配对、光标居中；有选区 → 包裹并保持选中
 * 2. PM 端：输入闭符号且下一字符相同 → 跳过（光标右移）
 * 3. 开关关闭 / 代码块内 → 不处理（返回 false）
 * 4. textarea 端：EditorContainer 通过 beforeinput/规划器接入配对逻辑
 * 5. 设置 store 提供总开关（默认开启）+ 分组开关 + SettingsDialog 有开关项
 *
 * v0.12.1 需求4 变更（本文件随之更新的断言）：
 * - 新增「光标右侧是单词字符则不配对」规则 → 原先在 `ab|cd` 中间输入 `(` 的用例
 *   已改为"光标在行尾"这类真正的开符号场景；词中间的负向用例见
 *   v0121-auto-pair-rules.test.ts（规则层）。
 * - textarea 端补全入口由 keydown 改为 beforeinput（中文标点 IME 提交不派发单字符 keydown）。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createEditor } from "../core/editor";
import { autoPairPlugin, PAIR_MAP, PAIR_CLOSERS } from "../core/plugins/auto-pair";
import { useSettingsStore } from "../stores/useSettingsStore";
import type { EditorView } from "prosemirror-view";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readSrc(rel: string): string {
  return readFileSync(join(root, rel), "utf-8");
}

/** 测试专用：createEditor 在 jsdom 下不会返回 null，断言为非空简化用例 */
function mk(opts: { parent: HTMLElement; initialContent: string }): EditorView {
  return createEditor(opts) as EditorView;
}

type Handler = (
  view: EditorView,
  from: number,
  to: number,
  text: string,
  deflt?: () => unknown
) => boolean;

describe("v0.5.0 N1：自动配对补全", () => {
  let parent: HTMLDivElement;
  let view: EditorView | null;

  beforeEach(() => {
    parent = document.createElement("div");
    document.body.appendChild(parent);
    useSettingsStore.getState().setAutoPairEnabled(true);
    useSettingsStore.getState().setAutoPairKind("brackets", true);
    useSettingsStore.getState().setAutoPairKind("quotes", true);
    useSettingsStore.getState().setAutoPairKind("cjk", true);
  });

  afterEach(() => {
    if (view) {
      view.destroy();
      view = null;
    }
    parent.remove();
    useSettingsStore.getState().setAutoPairEnabled(true);
  });

  /** 获取段落内指定偏移处的绝对位置 */
  function posInParagraph(v: EditorView, offset: number): number {
    let pos = -1;
    v.state.doc.descendants((node, p) => {
      if (pos < 0 && node.type.name === "paragraph") {
        pos = p + 1 + Math.min(offset, node.content.size);
        return false;
      }
      return true;
    });
    return pos;
  }

  it("PAIR_MAP 覆盖括号与引号，闭符号集合与映射一致", () => {
    expect(PAIR_MAP["("]).toBe(")");
    expect(PAIR_MAP["["]).toBe("]");
    expect(PAIR_MAP["{"]).toBe("}");
    expect(PAIR_MAP['"']).toBe('"');
    expect(PAIR_MAP["'"]).toBe("'");
    expect(PAIR_MAP["`"]).toBe("`");
    // 不含 $（避免输入价格等普通文本时误配对）
    expect(PAIR_MAP["$"]).toBeUndefined();
    for (const open of Object.keys(PAIR_MAP)) {
      expect(PAIR_CLOSERS.has(PAIR_MAP[open])).toBe(true);
    }
  });

  it("PM：无选区在行尾输入 ( → 插入 () 且光标居中", () => {
    const v = mk({ parent, initialContent: "ab" });
    view = v;
    const pos = posInParagraph(v, 2); // ab|
    const handler = autoPairPlugin().props.handleTextInput as Handler;
    const handled = handler(v, pos, pos, "(", () => v.state.tr);
    expect(handled).toBe(true);
    // 插入 "(" + ")" 配对，光标居中
    expect(v.state.doc.textContent).toBe("ab()");
    expect(v.state.selection.from).toBe(pos + 1);
  });

  it("PM：词中间（右侧是单词字符）不配对，交给默认输入", () => {
    const v = mk({ parent, initialContent: "ab" });
    view = v;
    const pos = posInParagraph(v, 1); // a|b
    const handler = autoPairPlugin().props.handleTextInput as Handler;
    // v0.12.1 需求4：右侧是单词字符 → 只插单字符（返回 false 走 PM 默认插入）
    expect(handler(v, pos, pos, "(", () => v.state.tr)).toBe(false);
    expect(v.state.doc.textContent).toBe("ab");
  });

  it("PM：有选区输入 ( → 包裹选中文本并保持选中", () => {
    const v = mk({ parent, initialContent: "ab" });
    view = v;
    const from = posInParagraph(v, 0);
    const to = posInParagraph(v, 2); // 选中 "ab"
    const handler = autoPairPlugin().props.handleTextInput as Handler;
    const handled = handler(v, from, to, "(", () => v.state.tr);
    expect(handled).toBe(true);
    expect(v.state.doc.textContent).toBe("(ab)");
    // 选区保持为被包裹的原文本
    expect(v.state.selection.from).toBe(from + 1);
    expect(v.state.selection.to).toBe(to + 1);
  });

  it("PM：输入 ) 且下一字符已是 ) → 跳过输入，光标右移", () => {
    const v = mk({ parent, initialContent: "()" });
    view = v;
    const pos = posInParagraph(v, 1); // (|) 光标在中间
    const handler = autoPairPlugin().props.handleTextInput as Handler;
    const handled = handler(v, pos, pos, ")", () => v.state.tr);
    expect(handled).toBe(true);
    expect(v.state.doc.textContent).toBe("()"); // 未新增字符
    expect(v.state.selection.from).toBe(pos + 1);
  });

  it("PM：开关关闭时不处理", () => {
    useSettingsStore.getState().setAutoPairEnabled(false);
    const v = mk({ parent, initialContent: "ab" });
    view = v;
    const pos = posInParagraph(v, 2);
    const handler = autoPairPlugin().props.handleTextInput as Handler;
    expect(handler(v, pos, pos, "(", () => v.state.tr)).toBe(false);
    expect(v.state.doc.textContent).toBe("ab");
  });

  it("PM：代码块内不配对", () => {
    const v = mk({ parent, initialContent: "```\nvar x = 1\n```" });
    view = v;
    // 找到 code_block 内的位置（var 后）
    let target = -1;
    v.state.doc.descendants((node, p) => {
      if (target < 0 && node.type.name === "code_block") {
        target = p + 1 + 5; // code_block 内容 "var x = 1" 偏移 5
        return false;
      }
      return true;
    });
    const handler = autoPairPlugin().props.handleTextInput as Handler;
    expect(handler(v, target, target, "(", () => v.state.tr)).toBe(false);
  });

  it("PM：行内公式（math_inline）内不配对（v0.12.1 补齐旧 inDisabledNode 漏判）", () => {
    const v = mk({ parent, initialContent: "文本 $x$ 结尾" });
    view = v;
    // math_inline 节点内部位置：找到节点后落到其内容里
    let target = -1;
    v.state.doc.descendants((node, p) => {
      if (target < 0 && node.type.name === "math_inline") {
        target = p + 1;
        return false;
      }
      return true;
    });
    expect(target).toBeGreaterThan(-1);
    const handler = autoPairPlugin().props.handleTextInput as Handler;
    expect(handler(v, target, target, "(", () => v.state.tr)).toBe(false);
  });

  it("PM：普通字符与多字符输入不处理", () => {
    const v = mk({ parent, initialContent: "ab" });
    view = v;
    const pos = posInParagraph(v, 2);
    const handler = autoPairPlugin().props.handleTextInput as Handler;
    expect(handler(v, pos, pos, "x", () => v.state.tr)).toBe(false);
    expect(handler(v, pos, pos, "ab", () => v.state.tr)).toBe(false);
  });

  it("PAIR_MAP 覆盖中文标点（引号/括号/书名号/直角引号），闭符号集合与映射一致", () => {
    expect(PAIR_MAP["“"]).toBe("”");
    expect(PAIR_MAP["‘"]).toBe("’");
    expect(PAIR_MAP["（"]).toBe("）");
    expect(PAIR_MAP["【"]).toBe("】");
    expect(PAIR_MAP["《"]).toBe("》");
    expect(PAIR_MAP["「"]).toBe("」");
    // 不与英文引号/括号冲突（中文闭符号不作为开符号）
    expect(PAIR_MAP["”"]).toBeUndefined();
    expect(PAIR_MAP["）"]).toBeUndefined();
    expect(PAIR_MAP["】"]).toBeUndefined();
    expect(PAIR_MAP["》"]).toBeUndefined();
    expect(PAIR_MAP["」"]).toBeUndefined();
    // 全部开符号的闭符号均在 PAIR_CLOSERS 中
    for (const open of Object.keys(PAIR_MAP)) {
      expect(PAIR_CLOSERS.has(PAIR_MAP[open])).toBe(true);
    }
  });

  it("PM：行尾输入中文开符号「（」补全成对且光标居中", () => {
    const v = mk({ parent, initialContent: "ab" });
    view = v;
    const pos = posInParagraph(v, 2); // ab|
    const handler = autoPairPlugin().props.handleTextInput as Handler;
    const handled = handler(v, pos, pos, "（", () => v.state.tr);
    expect(handled).toBe(true);
    expect(v.state.doc.textContent).toBe("ab（）");
    expect(v.state.selection.from).toBe(pos + 1);
  });

  it("PM：输入中文闭符号「）」且下一字符相同 → 跳过（光标右移）", () => {
    const v = mk({ parent, initialContent: "（）" });
    view = v;
    const pos = posInParagraph(v, 1); // （|）
    const handler = autoPairPlugin().props.handleTextInput as Handler;
    const handled = handler(v, pos, pos, "）", () => v.state.tr);
    expect(handled).toBe(true);
    expect(v.state.doc.textContent).toBe("（）");
    expect(v.state.selection.from).toBe(pos + 1);
  });

  it("PM：空配对 Backspace 删一对", () => {
    const v = mk({ parent, initialContent: "ab" });
    view = v;
    const pos = posInParagraph(v, 2);
    const inHandler = autoPairPlugin().props.handleTextInput as Handler;
    inHandler(v, pos, pos, "（", () => v.state.tr); // ab（）光标居中
    const keyHandler = autoPairPlugin().props.handleKeyDown as (
      view: EditorView,
      ev: KeyboardEvent
    ) => boolean;
    const handled = keyHandler(v, { key: "Backspace" } as KeyboardEvent);
    expect(handled).toBe(true);
    expect(v.state.doc.textContent).toBe("ab");
  });

  it("PM：配对内有内容时 Backspace 只删内容不吞闭符号（不拦截）", () => {
    const v = mk({ parent, initialContent: "ab" });
    view = v;
    const pos = posInParagraph(v, 2);
    const inHandler = autoPairPlugin().props.handleTextInput as Handler;
    inHandler(v, pos, pos, "（", () => v.state.tr); // ab（）
    const cur = v.state.selection.from;
    // 配对内填入普通内容 x（handleTextInput 对非配对字符返回 false，由 PM 默认插入）
    v.dispatch(v.state.tr.insertText("x", cur)); // ab（x）
    expect(v.state.doc.textContent).toBe("ab（x）");
    const keyHandler = autoPairPlugin().props.handleKeyDown as (
      view: EditorView,
      ev: KeyboardEvent
    ) => boolean;
    const handled = keyHandler(v, { key: "Backspace" } as KeyboardEvent);
    // 不拦截：默认 Backspace 仅删光标前单字符（x），闭符号「）」保留
    expect(handled).toBe(false);
    expect(v.state.doc.textContent).toBe("ab（x）");
  });

  it("设置 store：autoPairEnabled 默认开启，setter 生效并持久化字段存在", () => {
    const src = readSrc("src/stores/useSettingsStore.ts");
    expect(src).toMatch(/autoPairEnabled: true/);
    expect(src).toMatch(/setAutoPairEnabled/);
    // v0.12.1 需求4：分组开关同样落库
    expect(src).toMatch(/autoPairBrackets: true/);
    expect(src).toMatch(/autoPairQuotes: true/);
    expect(src).toMatch(/autoPairCjk: true/);
    expect(src).toMatch(/setAutoPairKind/);
    useSettingsStore.getState().setAutoPairEnabled(false);
    expect(useSettingsStore.getState().autoPairEnabled).toBe(false);
  });

  it("textarea 端：EditorContainer 的补全入口走 beforeinput + 规划器（v0.12.1 接线）", () => {
    const src = readSrc("src/components/editor/EditorContainer.tsx");
    // 导入规划器与运行时配置
    expect(src).toMatch(/from "\.\.\/\.\.\/utils\/sourceAutoPair"/);
    expect(src).toMatch(/planSourceChar/);
    expect(src).toMatch(/planSourceCompositionCommit/);
    // beforeinput 才是补全入口（中文标点 IME 提交没有单字符 keydown）
    expect(src).toMatch(/addEventListener\("beforeinput", onBeforeInput\)/);
    expect(src).toMatch(/addEventListener\("compositionend", onCompositionEnd\)/);
    expect(src).toMatch(/ie\.isComposing/);
  });

  it("textarea 端：EditorContainer 接入退格成对删除与 Tab 跳出", () => {
    const src = readSrc("src/components/editor/EditorContainer.tsx");
    expect(src).toMatch(/planSourceBackspace/);
    expect(src).toMatch(/planSourceTab/);
    expect(src).toMatch(/applySourcePairPlan/);
    // 落地走一条 execCommand → 一次撤销
    expect(src).toMatch(/document\.execCommand\("insertText", false, text\)/);
  });

  it("SettingsDialog 提供开关项 + i18n 文案（zh/en）", () => {
    expect(readSrc("src/components/dialogs/SettingsDialog.tsx")).toMatch(
      /settings\.autoPairEnabled/
    );
    expect(readSrc("src/i18n/locales/zh-CN.ts")).toMatch(
      /"settings\.autoPair":\s*"自动配对补全"/
    );
    expect(readSrc("src/i18n/locales/en-US.ts")).toMatch(
      /"settings\.autoPair":\s*"Auto Pair"/
    );
    // v0.12.1 需求4：分组开关 UI + 文案
    const dialog = readSrc("src/components/dialogs/SettingsDialog.tsx");
    expect(dialog).toMatch(/data-testid="auto-pair-kinds"/);
    expect(dialog).toMatch(/settings\.autoPair\.brackets/);
    expect(readSrc("src/i18n/locales/zh-CN.ts")).toMatch(
      /"settings\.autoPair\.brackets":\s*"括号/
    );
    expect(readSrc("src/i18n/locales/en-US.ts")).toMatch(
      /"settings\.autoPair\.brackets":\s*"Brackets/
    );
  });
});
