/**
 * v0.12.1 需求4：三个模式行为一致性 + textarea 侧适配层
 *
 * 需求原文："当前软件实现了一版括号自动补全，但效果不佳且有 bug，请重新调调整，
 * 并且要求 3 个模式都要同样生效"。
 * 三个模式 = 阅读（ProseMirror，core/plugins/auto-pair） / 编辑（textarea） /
 * 分屏（textarea，与编辑共用同一 ref 与同一适配层）。
 *
 * 本文件的组织方式：
 * 1. **同场景双端对照**：同一组场景分别喂给 PM 插件（真实 EditorView）与
 *    textarea 规划器（utils/sourceAutoPair），断言二者结论完全一致 —— 这是
 *    "三模式一致"的可执行证明（两边共用 core/autoPairRules）。
 * 2. textarea 适配层的细节：包围选区、跳过、退格、Tab、IME 组合提交补齐、
 *    一次编辑 = 一条撤销记录（单次 execCommand 计划）。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createEditor } from "../core/editor";
import { autoPairPlugin, pairTabOut } from "../core/plugins/auto-pair";
import {
  planSourceChar,
  planSourceBackspace,
  planSourceTab,
  planSourceCompositionCommit,
  lineAround,
  type SourcePairConfig,
} from "../utils/sourceAutoPair";
import { DEFAULT_PAIR_KINDS } from "../core/autoPairRules";
import { useSettingsStore } from "../stores/useSettingsStore";
import type { EditorView } from "prosemirror-view";
import { TextSelection } from "prosemirror-state";

const PM_CFG: SourcePairConfig = { enabled: true, kinds: { ...DEFAULT_PAIR_KINDS } };

type Handler = (
  view: EditorView,
  from: number,
  to: number,
  text: string,
  deflt?: () => unknown,
) => boolean;

/** 段落内第 offset 个字符处的绝对位置（单段落文档 → 1 + offset） */
const posIn = (offset: number) => 1 + offset;

interface Scenario {
  name: string;
  /** 段落文本 */
  text: string;
  /** 光标（无选区）或选区起点 */
  caret: number;
  /** 选区终点（缺省 = caret） */
  caretTo?: number;
  char: string;
  /** 期望：补齐（插入 open+close） / 包围 / 跳过（不插字符，光标右移） / 不接管 */
  expect: "pair" | "surround" | "typeOver" | "none";
}

const SCENARIOS: Scenario[] = [
  { name: "行尾左圆括号 → 补全", text: "ab", caret: 2, char: "(", expect: "pair" },
  { name: "行尾左方括号 → 补全", text: "ab", caret: 2, char: "[", expect: "pair" },
  { name: "行尾左花括号 → 补全", text: "ab", caret: 2, char: "{", expect: "pair" },
  { name: "空白后双引号 → 补全", text: "ab ", caret: 3, char: '"', expect: "pair" },
  { name: "空白后单引号 → 补全", text: "ab ", caret: 3, char: "'", expect: "pair" },
  { name: "空白后反引号 → 补全", text: "ab ", caret: 3, char: "`", expect: "pair" },
  { name: "行尾中文圆括号 → 补全", text: "ab", caret: 2, char: "（", expect: "pair" },
  { name: "行尾中文引号 → 补全", text: "ab", caret: 2, char: "“", expect: "pair" },
  { name: "行尾中文方括号 → 补全", text: "ab", caret: 2, char: "【", expect: "pair" },
  { name: "词中间左括号 → 不补全", text: "abcd", caret: 2, char: "(", expect: "none" },
  { name: "右侧已是右括号 → 不补全", text: "a)b", caret: 1, char: "(", expect: "none" },
  { name: "撇号 don't → 不补全", text: "don", caret: 3, char: "'", expect: "none" },
  { name: "空配对内输入右括号 → 跳过", text: "()", caret: 1, char: ")", expect: "typeOver" },
  { name: "空中文配对内输入右括号 → 跳过", text: "（）", caret: 1, char: "）", expect: "typeOver" },
  { name: "自配对引号：右侧已是引号 → 跳过", text: 'a""b', caret: 2, char: '"', expect: "typeOver" },
  { name: "孤儿右括号 → 不接管", text: "ab)", caret: 2, char: ")", expect: "none" },
  { name: "选区加左括号 → 包围", text: "abcd", caret: 1, caretTo: 3, char: "(", expect: "surround" },
  { name: "选区加双引号 → 包围", text: "abcd", caret: 1, caretTo: 3, char: '"', expect: "surround" },
  { name: "选区加右括号 → 不包围（闭符号）", text: "abcd", caret: 1, caretTo: 3, char: "）", expect: "none" },
];

describe("v0.12.1 需求4：三模式同场景双端对照（阅读 PM ⇄ 编辑/分屏 textarea）", () => {
  let parent: HTMLDivElement;

  beforeEach(() => {
    parent = document.createElement("div");
    document.body.appendChild(parent);
    useSettingsStore.getState().setAutoPairEnabled(true);
    useSettingsStore.getState().setAutoPairKind("brackets", true);
    useSettingsStore.getState().setAutoPairKind("quotes", true);
    useSettingsStore.getState().setAutoPairKind("cjk", true);
  });

  afterEach(() => {
    parent.remove();
  });

  /** 在 PM 里执行一次输入，返回实际发生的动作 */
  function pmAct(sc: Scenario): string {
    const v = createEditor({ parent, initialContent: sc.text }) as EditorView;
    const from = posIn(sc.caret);
    const to = posIn(sc.caretTo ?? sc.caret);
    if (from !== to) v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, from, to)));
    const handler = autoPairPlugin().props.handleTextInput as Handler;
    const handled = handler(v, from, to, sc.char, () => v.state.tr);
    const after = v.state.doc.textContent;
    const sel = v.state.selection;
    let action = "none";
    if (handled) {
      if (after === sc.text) action = "typeOver";
      else if (!sel.empty) action = "surround";
      else action = "pair";
    }
    v.destroy();
    return action;
  }

  /** 在 textarea 规划器里执行一次输入，返回实际发生的动作 */
  function sourceAct(sc: Scenario): string {
    const plan = planSourceChar(
      {
        value: sc.text,
        start: sc.caret,
        end: sc.caretTo ?? sc.caret,
        cfg: PM_CFG,
        inDisabledContext: false,
      },
      sc.char,
    );
    if (plan.kind !== "edit") return "none";
    if (plan.edit.text === "") return "typeOver";
    // 开+闭：包围时 text = open + 选中文本 + close
    const open = sc.char;
    const close = plan.edit.text.slice(-open.length);
    if (plan.edit.text === open + close) return "pair";
    if (plan.edit.text === open + sc.text.slice(sc.caret, sc.caretTo) + close) return "surround";
    return "unknown";
  }

  it.each(SCENARIOS)("PM（阅读模式）：$name", (sc) => {
    expect(pmAct(sc)).toBe(sc.expect);
  });

  it.each(SCENARIOS)("textarea（编辑/分屏）与 PM 结论一致：$name", (sc) => {
    expect(sourceAct(sc)).toBe(pmAct(sc));
  });
});

// ─── textarea 适配层细节 ────────────────────────────────────

describe("v0.12.1 需求4：textarea 规划器细节", () => {
  const base = {
    value: "",
    start: 0,
    end: 0,
    cfg: PM_CFG,
    inDisabledContext: false,
  };

  it("补全只产生一次编辑（open+close 一次落地 = 一次撤销）", () => {
    const plan = planSourceChar({ ...base, value: "ab", start: 2, end: 2 }, "(");
    expect(plan).toEqual({
      kind: "edit",
      edit: { from: 2, to: 2, text: "()", caret: 3 },
    });
  });

  it("包围选区：替换区间含原选中文本，光标与选区同步偏移", () => {
    const plan = planSourceChar({ ...base, value: "abcd", start: 1, end: 3 }, "[");
    expect(plan).toEqual({
      kind: "edit",
      edit: { from: 1, to: 3, text: "[bc]", caret: 2, caretEnd: 4 },
    });
  });

  it("跳过输入：不产生字符写入，只移动光标", () => {
    const plan = planSourceChar({ ...base, value: "()", start: 1, end: 1 }, ")");
    expect(plan).toEqual({ kind: "edit", edit: { from: 1, to: 1, text: "", caret: 2 } });
  });

  it("退格：删除 [start-1, end+1) 区间", () => {
    // 文本 "a()c"，光标在左括号与右括号之间（index 2）
    const plan = planSourceBackspace({ ...base, value: "a()c", start: 2, end: 2 });
    expect(plan).toEqual({ kind: "edit", edit: { from: 1, to: 3, text: "", caret: 1 } });
    // 配对内有内容 → 不接管
    expect(planSourceBackspace({ ...base, value: "(x)", start: 2, end: 2 }).kind).toBe("none");
  });

  it("Tab：跳出配对 = 光标右移一位", () => {
    const plan = planSourceTab({ ...base, value: "a()b", start: 2, end: 2 });
    expect(plan).toEqual({ kind: "edit", edit: { from: 2, to: 2, text: "", caret: 3 } });
    expect(planSourceTab({ ...base, value: "ab", start: 2, end: 2 }).kind).toBe("none");
  });

  it("IME 组合提交后补闭符号（提交后相位：只补 close，光标留在原处）", () => {
    // 组合已把中文左括号写进 value，光标在其右侧（index 3）
    const plan = planSourceCompositionCommit({
      ...base,
      value: "ab（",
      start: 3,
      end: 3,
      char: "（",
      commitEnd: 3,
    });
    expect(plan).toEqual({ kind: "edit", edit: { from: 3, to: 3, text: "）", caret: 3 } });
  });

  it("IME 提交后：右侧是单词字符 / 分组关闭 → 不补", () => {
    expect(
      planSourceCompositionCommit({
        ...base,
        value: "ab（c",
        start: 3,
        end: 3,
        char: "（",
        commitEnd: 3,
      }).kind,
    ).toBe("none");
    expect(
      planSourceCompositionCommit({
        ...base,
        value: "ab（",
        start: 3,
        end: 3,
        cfg: { enabled: true, kinds: { ...DEFAULT_PAIR_KINDS, cjk: false } },
        char: "（",
        commitEnd: 3,
      }).kind,
    ).toBe("none");
  });

  it("代码块 / 行内代码 / 公式上下文内不补全（由调用方传入 inDisabledContext）", () => {
    expect(
      planSourceChar({ ...base, value: "```\n", start: 4, end: 4, inDisabledContext: true }, "(").kind,
    ).toBe("none");
  });

  it("lineAround：只取当前行（textarea 的块 = 一行）", () => {
    // "aa\nbb"：index 3 = 第二行行首
    expect(lineAround("aa\nbb\ncc", 4)).toEqual({ before: "b", after: "b" });
    expect(lineAround("aa\nbb", 3)).toEqual({ before: "", after: "bb" });
    expect(lineAround("aa\nbb", 5)).toEqual({ before: "bb", after: "" });
    // 光标正好落在换行符上：算作上一行行尾
    expect(lineAround("aa\nbb", 2)).toEqual({ before: "aa", after: "" });
  });
});

// ─── PM 侧：Tab 跳出命令与退化行为 ──────────────────────────

describe("v0.12.1 需求4：PM 的 Tab 跳出配对命令", () => {
  let parent: HTMLDivElement;
  let view: EditorView | null = null;

  beforeEach(() => {
    parent = document.createElement("div");
    document.body.appendChild(parent);
  });
  afterEach(() => {
    view?.destroy();
    view = null;
    parent.remove();
  });

  it("光标在括号之间按 Tab → 光标移到闭符号右侧（一次事务）", () => {
    const v = createEditor({ parent, initialContent: "a()b" }) as EditorView;
    view = v;
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, posIn(2)))); // a(|)b
    let dispatched = 0;
    const orig = v.dispatch.bind(v);
    v.dispatch = (tr) => {
      dispatched++;
      return orig(tr);
    };
    const handled = pairTabOut(v.state, v.dispatch, v);
    expect(handled).toBe(true);
    expect(v.state.selection.from).toBe(posIn(3)); // 跳到右括号右侧
    expect(dispatched).toBe(1); // 一次事务 = 一次撤销
  });

  it("普通段落（不在配对中）按 Tab → 不接管（交回表格/缩进/嵌套链）", () => {
    const v = createEditor({ parent, initialContent: "abc" }) as EditorView;
    view = v;
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, posIn(1))));
    expect(pairTabOut(v.state, v.dispatch, v)).toBe(false);
  });

  it("代码块内 Tab 不跳出配对（交给代码块缩进）", () => {
    const v = createEditor({ parent, initialContent: "```\nx()y\n```" }) as EditorView;
    view = v;
    let target = -1;
    v.state.doc.descendants((node, p) => {
      if (target < 0 && node.type.name === "code_block") {
        target = p + 1 + 2; // x(|)y
        return false;
      }
      return true;
    });
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, target)));
    expect(pairTabOut(v.state, v.dispatch, v)).toBe(false);
  });
});

// ─── PM 侧：退格成对删除的边界 ──────────────────────────────

describe("v0.12.1 需求4：PM 退格成对删除的边界", () => {
  let parent: HTMLDivElement;
  let view: EditorView | null = null;

  beforeEach(() => {
    parent = document.createElement("div");
    document.body.appendChild(parent);
  });
  afterEach(() => {
    view?.destroy();
    view = null;
    parent.remove();
  });

  const keyHandler = () =>
    autoPairPlugin().props.handleKeyDown as (v: EditorView, e: KeyboardEvent) => boolean;

  it("空配对退格删一对（圆括号 / 引号 / 中文括号）", () => {
    for (const [text, caret] of [
      ["a()b", 2],
      ['a""b', 2],
      ["a（）b", 2],
    ] as Array<[string, number]>) {
      const v = createEditor({ parent, initialContent: text }) as EditorView;
      v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, posIn(caret))));
      expect(keyHandler()(v, { key: "Backspace" } as KeyboardEvent)).toBe(true);
      v.destroy();
    }
  });

  it("配对内有内容 → 不拦截", () => {
    const v = createEditor({ parent, initialContent: "a(x)b" }) as EditorView;
    view = v;
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, posIn(2))));
    expect(keyHandler()(v, { key: "Backspace" } as KeyboardEvent)).toBe(false);
  });
});
