/**
 * v0.12.1 需求4：自动配对补全规则引擎（纯函数）
 *
 * 逐条覆盖需求里列出的规则——"会补全 / 跳过 / 不补全 / 配套交互"四类共 20+ 场景：
 * 一、可以自动补全：配对符号（括号类/引号类），光标右侧不是单词字符、不是闭符号
 * 二、跳过输入（typeover）
 * 三、不应该自动补全：右侧单词字符/闭符号、孤儿闭符号、上下文禁用（代码/公式）、
 *     开关关闭、多行选区引号、IME 组合期、英文撇号、转义态
 * 四、退格成对删除 / Tab 跳出 / 嵌套判断的轻量栈扫描
 */
import { describe, it, expect } from "vitest";
import {
  AUTO_PAIRS,
  DEFAULT_PAIR_KINDS,
  PAIR_CLOSERS,
  PAIR_OPENERS,
  decideAutoPair,
  decideCompositionCommit,
  decidePairBackspace,
  decidePairTabOut,
  endsWithEscape,
  hasUnclosedOpener,
  isCloser,
  isOpener,
  isWordChar,
  pairAroundCaret,
  pairByCloser,
  pairByOpen,
  type AutoPairContext,
  type PairKind,
} from "../core/autoPairRules";

/** 构造规则上下文（默认：折叠光标、总开关开、三组全开、非禁用上下文） */
function ctx(patch: Partial<AutoPairContext> = {}): AutoPairContext {
  return {
    char: "(",
    before: "",
    after: "",
    selectionEmpty: true,
    inDisabledContext: false,
    isComposing: false,
    enabled: true,
    kinds: { ...DEFAULT_PAIR_KINDS },
    ...patch,
  };
}

function kinds(off: PairKind): Record<PairKind, boolean> {
  return { ...DEFAULT_PAIR_KINDS, [off]: false };
}

// ─── 一、会补全 ────────────────────────────────────────────

describe("v0.12.1 需求4 · 会补全", () => {
  it("配对表覆盖括号类与引号类，且开/闭符号集合自洽", () => {
    for (const p of AUTO_PAIRS) {
      expect(pairByOpen(p.open)).toBe(p);
      expect(pairByCloser(p.close)).toBe(p);
      expect(PAIR_OPENERS.has(p.open)).toBe(true);
      expect(PAIR_CLOSERS.has(p.close)).toBe(true);
    }
    expect(isOpener("(")).toBe(true);
    expect(isOpener(")")).toBe(false);
    expect(isCloser(")")).toBe(true);
    expect(isCloser("(")).toBe(false);
    // $ 有意不配对（价格/公式场景误伤）
    expect(pairByOpen("$")).toBeUndefined();
  });

  it("光标在行尾输入各类开符号 → 补全配对", () => {
    const cases: Array<[string, string]> = [
      ["(", ")"],
      ["[", "]"],
      ["{", "}"],
      ['"', '"'],
      ["'", "'"],
      ["`", "`"],
      ["“", "”"],
      ["‘", "’"],
      ["（", "）"],
      ["【", "】"],
      ["《", "》"],
      ["「", "」"],
    ];
    for (const [open, close] of cases) {
      // 左侧是空格：避开英文撇号规则（'）对"左侧单词字符"的限制
      const action = decideAutoPair(ctx({ char: open, before: "abc ", after: "" }));
      expect(action).toEqual({ type: "pair", open, close });
    }
  });

  it("右侧是空白/标点（非单词字符、非闭符号）→ 补全", () => {
    for (const after of [" ", ",", "。", "-", "\t", "\ufffc"]) {
      expect(decideAutoPair(ctx({ char: "(", before: "a", after }))).toEqual({
        type: "pair",
        open: "(",
        close: ")",
      });
    }
  });

  it("有选区 → 用配对符号包围选中文本（单行/多行都包围）", () => {
    for (const selected of ["selected", "line1\nline2", "中\n文"]) {
      expect(
        decideAutoPair(
          ctx({ char: "(", selectionEmpty: false, before: "a", after: `b${selected}c` }),
        ),
      ).toEqual({ type: "surround", open: "(", close: ")" });
    }
    // 引号同样包围（多行也不拒绝：Markdown 中多行强调/引用合法）
    expect(
      decideAutoPair(
        ctx({ char: '"', selectionEmpty: false, before: "a", after: "x\ny" }),
      ),
    ).toEqual({ type: "surround", open: '"', close: '"' });
    expect(
      decideAutoPair(
        ctx({ char: "（", selectionEmpty: false, before: "", after: "选中" }),
      ),
    ).toEqual({ type: "surround", open: "（", close: "）" });
  });

  it("同字符既当开又当闭的引号：左侧无同类字符时仍视为开符号", () => {
    expect(decideAutoPair(ctx({ char: '"', before: "她说 ", after: "" }))).toEqual({
      type: "pair",
      open: '"',
      close: '"',
    });
  });
});

// ─── 二、跳过输入（typeover）────────────────────────────────

describe("v0.12.1 需求4 · 跳过输入（typeover）", () => {
  it("输入 ) 且右侧紧邻同一闭符号、左侧有未闭合的开符号 → 跳过", () => {
    expect(decideAutoPair(ctx({ char: ")", before: "(", after: ")" }))).toEqual({
      type: "typeOver",
    });
    // 配对中已有内容
    expect(decideAutoPair(ctx({ char: ")", before: "(x", after: ")y" }))).toEqual({
      type: "typeOver",
    });
    // 嵌套
    expect(decideAutoPair(ctx({ char: "]", before: "[[a", after: "]]" }))).toEqual({
      type: "typeOver",
    });
  });

  it("中文闭符号同样支持跳过", () => {
    expect(decideAutoPair(ctx({ char: "）", before: "（", after: "）" }))).toEqual({
      type: "typeOver",
    });
    expect(decideAutoPair(ctx({ char: "”", before: "“", after: "”" }))).toEqual({
      type: "typeOver",
    });
  });

  it("自配对引号：右侧紧邻同一字符 → 跳过（不再补成 4 个引号）", () => {
    for (const q of ['"', "'", "`"]) {
      expect(decideAutoPair(ctx({ char: q, before: "x ", after: q }))).toEqual({
        type: "typeOver",
      });
    }
  });

  it("孤儿闭符号：左侧没有未闭合的开符号 → 不跳过，只插单字符", () => {
    // 用户规则三.2：输入 ) 时左侧没有对应的未闭合 ( → 只插入单个字符
    expect(decideAutoPair(ctx({ char: ")", before: "", after: ")" }))).toEqual({ type: "none" });
    expect(decideAutoPair(ctx({ char: ")", before: "abc", after: ")" }))).toEqual({ type: "none" });
    expect(decideAutoPair(ctx({ char: "）", before: "abc", after: "）" }))).toEqual({ type: "none" });
    // 闭合平衡后不再是孤儿：`(a)b` 之后再输入 )... 左上下文已闭合 → 仍视为孤儿
    expect(decideAutoPair(ctx({ char: ")", before: "(a)", after: ")" }))).toEqual({ type: "none" });
  });
});

// ─── 三、不应该自动补全 ────────────────────────────────────

describe("v0.12.1 需求4 · 不应该自动补全", () => {
  it("总开关关闭 / 分组开关关闭 → 不处理", () => {
    expect(decideAutoPair(ctx({ char: "(", enabled: false }))).toEqual({ type: "none" });
    expect(decideAutoPair(ctx({ char: "(", kinds: kinds("bracket") }))).toEqual({ type: "none" });
    expect(decideAutoPair(ctx({ char: "(", kinds: kinds("bracket") }))).toEqual({ type: "none" });
    expect(decideAutoPair(ctx({ char: "'", kinds: kinds("quote") }))).toEqual({ type: "none" });
    expect(decideAutoPair(ctx({ char: "（", kinds: kinds("cjk") }))).toEqual({ type: "none" });
    // 关掉括号不影响引号/中文标点
    expect(decideAutoPair(ctx({ char: "“", kinds: kinds("bracket") }))).toEqual({
      type: "pair",
      open: "“",
      close: "”",
    });
  });

  it("分组归属正确：括号 / 引号 / 中文标点", () => {
    expect(pairByOpen("(")!.kind).toBe("bracket");
    expect(pairByOpen("[")!.kind).toBe("bracket");
    expect(pairByOpen("{")!.kind).toBe("bracket");
    expect(pairByOpen('"')!.kind).toBe("quote");
    expect(pairByOpen("'")!.kind).toBe("quote");
    expect(pairByOpen("`")!.kind).toBe("quote");
    for (const cjk of ["“", "‘", "（", "【", "《", "「"]) {
      expect(pairByOpen(cjk)!.kind).toBe("cjk");
    }
  });

  it("光标右侧是单词字符（abc|def 词中间）→ 只插单字符", () => {
    for (const after of ["d", "0", "_", "中", "あ", "한"]) {
      expect(decideAutoPair(ctx({ char: "(", before: "abc", after }))).toEqual({ type: "none" });
    }
  });

  it("光标右侧是闭符号 → 只插单字符（用户规则三.1）", () => {
    expect(decideAutoPair(ctx({ char: "(", before: "a", after: ")" }))).toEqual({ type: "none" });
    expect(decideAutoPair(ctx({ char: "[", before: "a", after: "]" }))).toEqual({ type: "none" });
    expect(decideAutoPair(ctx({ char: "（", before: "a", after: "）" }))).toEqual({ type: "none" });
    // 右侧是"另一种"闭符号同样不配对
    expect(decideAutoPair(ctx({ char: "(", before: "a", after: "]" }))).toEqual({ type: "none" });
  });

  it("英文撇号：左侧是单词字符时不配对（don't / it's）", () => {
    expect(decideAutoPair(ctx({ char: "'", before: "don", after: "" }))).toEqual({ type: "none" });
    expect(decideAutoPair(ctx({ char: "'", before: "it", after: "" }))).toEqual({ type: "none" });
    // 左侧是空白/标点 → 正常配对
    expect(decideAutoPair(ctx({ char: "'", before: "he said ", after: "" }))).toEqual({
      type: "pair",
      open: "'",
      close: "'",
    });
    // 双引号不受该规则限制（英文引号常紧贴单词）
    expect(decideAutoPair(ctx({ char: '"', before: "said", after: " " }))).toEqual({
      type: "pair",
      open: '"',
      close: '"',
    });
  });

  it("转义态：反斜杠之后的符号不配对", () => {
    // 1 个反斜杠 → 转义态
    expect(decideAutoPair(ctx({ char: "(", before: "\\", after: "" }))).toEqual({ type: "none" });
    // 2 个反斜杠 = 字面量反斜杠本身 → 可以配对
    expect(decideAutoPair(ctx({ char: "(", before: "a\\\\", after: "" }))).toEqual({
      type: "pair",
      open: "(",
      close: ")",
    });
    // 3 个反斜杠 → 又回到转义态
    expect(decideAutoPair(ctx({ char: "(", before: "a\\\\\\", after: "" }))).toEqual({
      type: "none",
    });
  });

  it("代码块 / 行内代码 / 公式内不配对（字符串与注释内不配对的 Markdown 等价物）", () => {
    for (const char of ["(", '"', "`", "（"]) {
      expect(decideAutoPair(ctx({ char, inDisabledContext: true }))).toEqual({ type: "none" });
    }
  });

  it("IME 组合输入期间暂停配对", () => {
    for (const char of ["(", "（", '"']) {
      expect(decideAutoPair(ctx({ char, isComposing: true }))).toEqual({ type: "none" });
    }
  });

  it("非单字符（粘贴/整段上屏）不处理", () => {
    expect(decideAutoPair(ctx({ char: "()" }))).toEqual({ type: "none" });
    expect(decideAutoPair(ctx({ char: "" }))).toEqual({ type: "none" });
  });
});

// ─── 四、配套交互：退格 / Tab / 栈扫描 ─────────────────────

describe("v0.12.1 需求4 · 退格成对删除", () => {
  const base = {
    selectionEmpty: true,
    inDisabledContext: false,
    isComposing: false,
    enabled: true,
    kinds: { ...DEFAULT_PAIR_KINDS },
  };

  it("空配对内按退格 → 成对删除", () => {
    expect(decidePairBackspace({ ...base, before: "a(", after: ")b" })).toBe(true);
    expect(decidePairBackspace({ ...base, before: "（", after: "）" })).toBe(true);
    expect(decidePairBackspace({ ...base, before: '"', after: '"' })).toBe(true);
  });

  it("配对内有内容 / 非配对 / 有选区 / 禁用上下文 → 不拦截（走默认退格）", () => {
    expect(decidePairBackspace({ ...base, before: "(x", after: ")" })).toBe(false);
    expect(decidePairBackspace({ ...base, before: "ab", after: "" })).toBe(false);
    expect(decidePairBackspace({ ...base, before: "(", after: "", selectionEmpty: false })).toBe(false);
    expect(decidePairBackspace({ ...base, before: "(", after: ")", inDisabledContext: true })).toBe(false);
    expect(decidePairBackspace({ ...base, before: "(", after: ")", enabled: false })).toBe(false);
    expect(decidePairBackspace({ ...base, before: "(", after: ")", isComposing: true })).toBe(false);
    // 分组关闭同样不删
    expect(decidePairBackspace({ ...base, before: "(", after: ")", kinds: kinds("bracket") })).toBe(false);
  });
});

describe("v0.12.1 需求4 · Tab 跳出配对", () => {
  const base = {
    selectionEmpty: true,
    inDisabledContext: false,
    isComposing: false,
    enabled: true,
    kinds: { ...DEFAULT_PAIR_KINDS },
  };

  it("光标夹在配对符号之间 → 可跳出", () => {
    expect(decidePairTabOut({ ...base, before: "a(", after: ")b" })).toBe(true);
    expect(decidePairTabOut({ ...base, before: "（", after: "）" })).toBe(true);
  });

  it("不满足条件 → 不拦截（交回默认 Tab：缩进/焦点移动）", () => {
    expect(decidePairTabOut({ ...base, before: "ab", after: "" })).toBe(false);
    expect(decidePairTabOut({ ...base, before: "(x", after: ")" })).toBe(false);
    expect(decidePairTabOut({ ...base, before: "(", after: ")", enabled: false })).toBe(false);
    expect(decidePairTabOut({ ...base, before: "(", after: ")", inDisabledContext: true })).toBe(false);
    expect(decidePairTabOut({ ...base, before: "(", after: ")", selectionEmpty: false })).toBe(false);
  });

  it("pairAroundCaret 返回命中的配对定义", () => {
    expect(pairAroundCaret("a(", ")b", DEFAULT_PAIR_KINDS)!.open).toBe("(");
    expect(pairAroundCaret("a[", "]", DEFAULT_PAIR_KINDS)!.open).toBe("[");
    expect(pairAroundCaret("a(", "]b", DEFAULT_PAIR_KINDS)).toBeNull();
  });
});

describe("v0.12.1 需求4 · 轻量栈扫描与字符分类", () => {
  it("hasUnclosedOpener：向前扫描嵌套深度", () => {
    expect(hasUnclosedOpener("(", "(", ")")).toBe(true);
    expect(hasUnclosedOpener("(a(b", "(", ")")).toBe(true);
    // 已经闭合：()`()` 形式
    expect(hasUnclosedOpener("()", "(", ")")).toBe(false);
    expect(hasUnclosedOpener("(())", "(", ")")).toBe(false);
    // 多一层未闭合
    expect(hasUnclosedOpener("(()", "(", ")")).toBe(true);
    expect(hasUnclosedOpener("abc", "(", ")")).toBe(false);
    // 转义的开符号不算
    expect(hasUnclosedOpener("\\)(", "(", ")")).toBe(true);
    expect(hasUnclosedOpener("\\((", "(", ")")).toBe(true);
    expect(hasUnclosedOpener("\\(", "(", ")")).toBe(false);
  });

  it("isWordChar：字母/数字/下划线/CJK/假名/谚文为单词字符，空白与标点不是", () => {
    for (const ch of ["a", "Z", "0", "_", "中", "あ", "한", "é"]) {
      expect(isWordChar(ch)).toBe(true);
    }
    for (const ch of [" ", "-", ".", ")", "（", "\n", "", undefined]) {
      expect(isWordChar(ch as string)).toBe(false);
    }
  });

  it("endsWithEscape：奇数个反斜杠为转义态", () => {
    expect(endsWithEscape("\\")).toBe(true);
    expect(endsWithEscape("\\\\")).toBe(false);
    expect(endsWithEscape("\\\\\\")).toBe(true);
    expect(endsWithEscape("abc")).toBe(false);
  });
});

// ─── 五、组合输入提交后相位 ────────────────────────────────

describe("v0.12.1 需求4 · IME 组合提交后补闭符号", () => {
  it("中文标点提交后（组合期不补、提交后补）", () => {
    // 提交后相位：before 不含刚提交的字符
    expect(
      decideCompositionCommit(ctx({ char: "（", before: "abc", after: "" })),
    ).toEqual({ type: "pair", open: "（", close: "）" });
    expect(
      decideCompositionCommit(ctx({ char: "“", before: "他说", after: "" })),
    ).toEqual({ type: "pair", open: "“", close: "”" });
  });

  it("提交后相位同样遵守不补全规则（右侧单词字符 / 分组关闭 / 总开关关闭）", () => {
    expect(decideCompositionCommit(ctx({ char: "（", before: "a", after: "b" }))).toEqual({
      type: "none",
    });
    expect(
      decideCompositionCommit(ctx({ char: "（", before: "a", after: "", kinds: kinds("cjk") })),
    ).toEqual({ type: "none" });
    expect(
      decideCompositionCommit(ctx({ char: "（", before: "a", after: "", enabled: false })),
    ).toEqual({ type: "none" });
  });

  it("提交后相位强制按折叠光标处理（组合提交必然不保留选区）", () => {
    expect(
      decideCompositionCommit(ctx({ char: "（", before: "a", after: "", selectionEmpty: false })),
    ).toEqual({ type: "pair", open: "（", close: "）" });
  });
});
