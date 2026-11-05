// @vitest-environment jsdom
/**
 * v0.16.0 B2+B6：代码块按选区逐行缩进（D1 / D8 / D9 / D10 / D4 / D15）
 *
 * 全部断言建立在**可观测结果**上（doc 文本 / selection / undoDepth），
 * 不做源码正则断言。
 *
 * 修复前的缺陷（均在 v0.15.6 实测复现，见实施方案 §2）：
 *  - D1  有选区 Tab 只在 `$from` 单点插空格 → `"line1\nl  ine2\nline3"`
 *  - D10 有选区 Shift+Tab 只删起点行 → `line3` 未动
 *  - D8  行中 Shift+Tab 吃空格 → `"a b"` 变 `"ab"`（`"a  b"` 一次吃 2 个）
 *  - D9  `"\tx"` 行首 Shift+Tab 返回 false（不识别 `\t`，焦点逃逸）
 *  - D4  `math_block` 不缩进（`inCodeLikeBlock` 漏配）
 *  - D15 连续缩进的撤销粒度依赖 500ms 窗口（不确定）
 */
import { describe, it, expect } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { history, undoDepth } from "prosemirror-history";
import type { Node as PMNode } from "prosemirror-model";
import { lightMDSchema as schema } from "../core/schema";
import {
  codeBlockIndent,
  codeBlockOutdent,
  inCodeLikeBlock,
  lineStartsInRange,
  outdentLen,
} from "../core/plugins/code-indent";
import { buildKeymap } from "../core/keymap";

const T = schema.topNodeType;

/** 造一个只含单个文本块的文档（块内容起点的文档坐标 = 1） */
function mkTextBlock(typeName: "code_block" | "mermaid_block" | "math_block", text: string): PMNode {
  return T.create(null, [schema.nodes[typeName].create(null, text ? schema.text(text) : [])]);
}

/**
 * 在某文本块内按 Tab / Shift+Tab，返回新文本与 handled。
 * `off` = 相对块内容的偏移。
 */
function press(
  text: string,
  off: number,
  kind: "Tab" | "Shift-Tab",
  opts: { to?: number; typeName?: "code_block" | "mermaid_block" | "math_block" } = {},
): { handled: boolean; text: string; selFrom: number; selTo: number } {
  const doc = mkTextBlock(opts.typeName ?? "code_block", text);
  const from = 1 + off;
  const sel =
    opts.to === undefined
      ? TextSelection.create(doc, from)
      : TextSelection.create(doc, from, 1 + opts.to);
  const state = EditorState.create({ doc, selection: sel });
  let newState = state;
  const cmd = kind === "Tab" ? codeBlockIndent : codeBlockOutdent;
  const handled = cmd(state, (tr) => {
    newState = state.apply(tr);
  });
  return {
    handled,
    text: newState.doc.child(0).textContent,
    selFrom: newState.selection.from,
    selTo: newState.selection.to,
  };
}

// ═══════════════════════════════════════════════════════════════
// D1：有选区时 Tab 必须「按行整体缩进」，不能缝在选区起点
// ═══════════════════════════════════════════════════════════════
describe("D1 有选区 Tab 按行整体缩进", () => {
  it("多行选区（line2..line3）→ 两行各加 2 空格", () => {
    const text = "line1\nline2\nline3";
    const r = press(text, text.indexOf("line2"), "Tab", { to: text.length });
    expect(r.handled).toBe(true);
    expect(r.text).toBe("line1\n  line2\n  line3");
    // 修复前的错误结果（回归护栏）：空格被缝在选区起点
    expect(r.text).not.toContain("l  ine2");
  });

  it("单行部分选区（选中 a 字符）→ 整行缩进，不插在字符中间", () => {
    const text = "const a = 1;";
    const i = text.indexOf("a");
    const r = press(text, i, "Tab", { to: i + 1 });
    expect(r.handled).toBe(true);
    expect(r.text).toBe("  const a = 1;");
    // 修复前的错误结果：`"const   a = 1;"`
    expect(r.text).not.toBe("const   a = 1;");
  });

  it("选区终点恰在下一行行首 → 不含该行（只缩进 bbb）", () => {
    const text = "aaa\nbbb\nccc";
    const r = press(text, text.indexOf("bbb"), "Tab", { to: text.indexOf("ccc") });
    expect(r.handled).toBe(true);
    expect(r.text).toBe("aaa\n  bbb\nccc");
  });

  it("选区起点在行中、跨到下一行 → 两行都缩进", () => {
    const text = "abc\ndef";
    const r = press(text, 1, "Tab", { to: text.indexOf("def") + 2 });
    expect(r.handled).toBe(true);
    expect(r.text).toBe("  abc\n  def");
  });

  it("空选区（折叠光标）在行中 → 光标处插一个缩进单位", () => {
    const r = press("hello", 2, "Tab");
    expect(r.handled).toBe(true);
    expect(r.text).toBe("he  llo");
  });
});

// ═══════════════════════════════════════════════════════════════
// D10：有选区 Shift+Tab 按行整体反缩进
// ═══════════════════════════════════════════════════════════════
describe("D10 有选区 Shift+Tab 按行整体反缩进", () => {
  it("多行选区反缩进 → 两行各减 2 空格", () => {
    const text = "  line1\n  line2\n  line3";
    const r = press(text, text.indexOf("  line2"), "Shift-Tab", { to: text.length });
    expect(r.handled).toBe(true);
    expect(r.text).toBe("  line1\nline2\nline3");
  });

  it("无缩进的多行选区 → 文档不变但吞键（不逃逸焦点）", () => {
    const text = "line1\nline2";
    const r = press(text, 0, "Shift-Tab", { to: text.length });
    expect(r.handled).toBe(true);
    expect(r.text).toBe(text);
  });

  it("行首缩进不足一个单位时整行收敛为 0（不报错）", () => {
    const text = " aaa\n  bbb";
    const r = press(text, 0, "Shift-Tab", { to: text.length });
    expect(r.handled).toBe(true);
    expect(r.text).toBe("aaa\nbbb");
  });
});

// ═══════════════════════════════════════════════════════════════
// D8：行中 Shift+Tab 一个字都不许删
// ═══════════════════════════════════════════════════════════════
describe("D8 行中 Shift+Tab 不删字符", () => {
  it.each([
    ["a b", 2, "光标在 a␠ 之后"],
    ["a  b", 3, "光标在 a␠␠ 之后（旧实现一次吃 2 个）"],
    ["a 中", 2, "光标在 a␠ 之后（中文）"],
    ["abc", 1, "行中无空格"],
  ])("%s @%i Shift+Tab → 不变（%s）", (text, off) => {
    const r = press(text as string, off as number, "Shift-Tab");
    expect(r.handled).toBe(true);
    expect(r.text).toBe(text);
  });

  it("行首无缩进 → 不变且吞键", () => {
    const r = press("abc", 0, "Shift-Tab");
    expect(r.handled).toBe(true);
    expect(r.text).toBe("abc");
  });

  it("行中前面恰有两空格但更左侧有非空白 → 仍然不删", () => {
    const r = press("if (a)  {}", 7, "Shift-Tab");
    expect(r.handled).toBe(true);
    expect(r.text).toBe("if (a)  {}");
  });
});

// ═══════════════════════════════════════════════════════════════
// D9：真实 \t 缩进必须能被反缩进
// ═══════════════════════════════════════════════════════════════
describe("D9 真实 \\t 缩进识别", () => {
  it("\\ta 行首 Shift+Tab → a", () => {
    const r = press("\ta", 1, "Shift-Tab");
    expect(r.handled).toBe(true);
    expect(r.text).toBe("a");
  });

  it("\\t\\tx 行首 Shift+Tab → 只减一个（\\tx）", () => {
    const r = press("\t\tx", 2, "Shift-Tab");
    expect(r.handled).toBe(true);
    expect(r.text).toBe("\tx");
  });

  it("空格+tab（\\x20\\tx）行首 Shift+Tab → 先删空格单位", () => {
    const r = press(" \tx", 1, "Shift-Tab");
    expect(r.handled).toBe(true);
    expect(r.text).toBe("\tx");
  });

  it("多行含 \\t 的选区反缩进", () => {
    const text = "\ta\n\tb";
    const r = press(text, 0, "Shift-Tab", { to: text.length });
    expect(r.handled).toBe(true);
    expect(r.text).toBe("a\nb");
  });
});

// ═══════════════════════════════════════════════════════════════
// 行首反缩进收敛链（必须与 v0.9.2 既有口径一致：一次只减一层）
// ═══════════════════════════════════════════════════════════════
describe("行首反缩进只减一个单位（不是清零）", () => {
  it.each([
    ["  a", 2, "a", "2→0"],
    ["    a", 4, "  a", "4→2（关键：不能变成空）"],
    ["      a", 6, "    a", "6→4"],
    ["   x", 3, " x", "3→1 奇数收敛"],
    [" x", 1, "x", "1→0"],
  ])("%s @%i → %s（%s）", (text, off, expected) => {
    const r = press(text as string, off as number, "Shift-Tab");
    expect(r.handled).toBe(true);
    expect(r.text).toBe(expected);
  });
});

// ═══════════════════════════════════════════════════════════════
// D4：math_block / mermaid_block 同构纳入
// ═══════════════════════════════════════════════════════════════
describe("D4 math_block 与 mermaid_block 同样可缩进", () => {
  it("math_block 行首 Tab → 插缩进单位", () => {
    const r = press("x + y = 1", 0, "Tab", { typeName: "math_block" });
    expect(r.handled).toBe(true);
    expect(r.text).toBe("  x + y = 1");
  });

  it("math_block 行首 2 空格 Shift+Tab → 反缩进", () => {
    const r = press("  x + y = 1", 2, "Shift-Tab", { typeName: "math_block" });
    expect(r.handled).toBe(true);
    expect(r.text).toBe("x + y = 1");
  });

  it("mermaid_block 行首 Tab → 插缩进单位", () => {
    const r = press("graph TD", 0, "Tab", { typeName: "mermaid_block" });
    expect(r.handled).toBe(true);
    expect(r.text).toBe("  graph TD");
  });

  it("inCodeLikeBlock 三种块都认", () => {
    for (const typeName of ["code_block", "mermaid_block", "math_block"] as const) {
      const doc = mkTextBlock(typeName, "z");
      const state = EditorState.create({ doc, selection: TextSelection.create(doc, 1) });
      expect(inCodeLikeBlock(state)).toBe(true);
    }
    // 普通段落不认
    const paraDoc = T.create(null, [schema.nodes.paragraph.create(null, schema.text("z"))]);
    const paraState = EditorState.create({ doc: paraDoc, selection: TextSelection.create(paraDoc, 1) });
    expect(inCodeLikeBlock(paraState)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// D15：每次缩进独立成一步撤销（closeHistory）
// ═══════════════════════════════════════════════════════════════
describe("D15 撤销粒度：一次缩进 = 一步撤销", () => {
  it("连续两次 Tab → undoDepth 为 2（不依赖 500ms 窗口）", () => {
    let state = EditorState.create({
      doc: mkTextBlock("code_block", "x"),
      selection: TextSelection.create(mkTextBlock("code_block", "x"), 1),
      plugins: [history()],
    });
    const depth0 = undoDepth(state);
    // 第一次 Tab
    let next = state;
    const h1 = codeBlockIndent(state, (tr) => {
      next = state.apply(tr);
    });
    expect(h1).toBe(true);
    state = next;
    const depth1 = undoDepth(state);
    // 第二次 Tab
    let next2 = state;
    const h2 = codeBlockIndent(state, (tr) => {
      next2 = state.apply(tr);
    });
    expect(h2).toBe(true);
    state = next2;
    const depth2 = undoDepth(state);

    expect(state.doc.child(0).textContent).toBe("    x");
    // 说明：光标停在行首时，缩进插在**光标之前** ⇒ 第二次 Tab 得到更深的缩进
    // `"    x"`（而不是 `"x    "`）。这正是"行首按 Tab = 层层加缩进"的正确语义。
    expect(depth0).toBe(0);
    expect(depth1).toBe(1);
    // 关键：closeHistory 让第二次缩进另起一步（修复前同批次两次会合并成 depth=1）
    expect(depth2).toBe(2);
  });

  it("有选区多行缩进 → 整次操作只占一步", () => {
    const text = "line1\nline2\nline3";
    const doc = mkTextBlock("code_block", text);
    const sel = TextSelection.create(doc, 1 + text.indexOf("line2"), 1 + text.length);
    let state = EditorState.create({ doc, selection: sel, plugins: [history()] });
    const before = undoDepth(state);
    let next = state;
    codeBlockIndent(state, (tr) => {
      next = state.apply(tr);
    });
    state = next;
    // N 行缩进 = 一个事务 = 一步（不是 N 步）
    expect(undoDepth(state)).toBe(before + 1);
    expect(state.doc.child(0).textContent).toBe("line1\n  line2\n  line3");
  });
});

// ═══════════════════════════════════════════════════════════════
// 纯函数单测（算法边界，便于回归定位）
// ═══════════════════════════════════════════════════════════════
describe("纯函数：lineStartsInRange / outdentLen", () => {
  it("lineStartsInRange 覆盖选区行、排除恰在行首的终点行", () => {
    expect(lineStartsInRange("line1\nline2\nline3", 6, 17)).toEqual([6, 12]);
    expect(lineStartsInRange("aaa\nbbb\nccc", 4, 7)).toEqual([4]);
    expect(lineStartsInRange("abc", 0, 3)).toEqual([0]);
    expect(lineStartsInRange("a\nb", 0, 1)).toEqual([0]);
  });

  it("outdentLen 收敛链", () => {
    expect(outdentLen("    ", "  ")).toBe(2); // 4→2
    expect(outdentLen("      ", "  ")).toBe(2); // 6→ 只减一个单位
    expect(outdentLen("   ", "  ")).toBe(2); // 3→1
    expect(outdentLen(" ", "  ")).toBe(1); // 1→0
    expect(outdentLen("\t", "  ")).toBe(1); // \t 恒 1
    expect(outdentLen("\t\t", "  ")).toBe(1); // 只减一个
    expect(outdentLen("\t", "    ")).toBe(1); // 设置 4 也认 \t
  });
});

// ═══════════════════════════════════════════════════════════════
// 经 buildKeymap 的**真实命令链**：`handled` 是"是否吞键（阻止浏览器默认 Tab）"
//
// 这条链在 v0.16.0 的语义发生过一次**有意变更**（决策 A，D3/D8/D9 的结构性后果）：
// 旧链上全部命令返回 false 时，`handled=false` ⇒ 浏览器原生 Tab ⇒ 焦点逃出编辑器。
// 新链尾 `indent`/`outdent` 永不返回 false（表格分支除外）⇒ 代码块内**行首无缩进**的
// Shift+Tab 也从 `false` 变成 `true`。文档一个字都不改，只是不再逃逸 ——
// 这正是 D8/D9 的修复目标，也是 v0.9.2 用例「无缩进 Shift+Tab 不处理」需要改断言的
// 唯一原因（该断言原文把 false 当作"不处理"，而 false 在新口径下恰是缺陷本身）。
// ═══════════════════════════════════════════════════════════════
describe("命令链层：代码块内 Shift+Tab 一律吞键（文档不变、焦点不逃逸）", () => {
  /** 经 keymap 插件 props.handleKeyDown 派发（与真实编辑器同一入口） */
  function pressViaKeymap(
    typeName: "code_block" | "mermaid_block" | "math_block",
    text: string,
    off: number,
  ): { handled: boolean; text: string } {
    const doc = mkTextBlock(typeName, text);
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 1 + off) });
    let newState = state;
    const plugin = buildKeymap();
    const props = (plugin.spec.props ?? {}) as {
      handleKeyDown?: (view: unknown, event: unknown) => boolean;
    };
    const handled =
      props.handleKeyDown?.(
        {
          state,
          dispatch: (tr: Parameters<EditorState["apply"]>[0]) => {
            newState = state.apply(tr);
          },
        },
        new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
      ) ?? false;
    return { handled, text: newState.doc.child(0).textContent };
  }

  it("code_block 行首无缩进 Shift+Tab → handled=true 且文本不变（旧实现 false=焦点逃逸）", () => {
    const r = pressViaKeymap("code_block", "x", 1);
    expect(r.handled).toBe(true);
    expect(r.text).toBe("x");
  });

  it("code_block 行中 Shift+Tab → handled=true 且文本不变（D8 经真实链也成立）", () => {
    for (const [text, off] of [
      ["a b", 2],
      ["a  b", 3],
      ["a 中", 2],
    ] as const) {
      const r = pressViaKeymap("code_block", text, off);
      expect(r.handled).toBe(true);
      expect(r.text).toBe(text);
    }
  });

  it("math_block 行首 Tab → 真实链上插进缩进单位（D4 端到端）", () => {
    const doc = mkTextBlock("math_block", "x + y = 1");
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 1) });
    let newState = state;
    const plugin = buildKeymap();
    const props = (plugin.spec.props ?? {}) as {
      handleKeyDown?: (view: unknown, event: unknown) => boolean;
    };
    const handled =
      props.handleKeyDown?.(
        {
          state,
          dispatch: (tr: Parameters<EditorState["apply"]>[0]) => {
            newState = state.apply(tr);
          },
        },
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
      ) ?? false;
    expect(handled).toBe(true);
    expect(newState.doc.child(0).textContent).toBe("  x + y = 1");
  });
});
