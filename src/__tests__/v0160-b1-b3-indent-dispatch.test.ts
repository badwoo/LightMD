// @vitest-environment jsdom
/**
 * v0.16.0 B1+B3：Tab / Shift+Tab 分派兜底（D3 / D4 / D5 / D11 / D6 / D7 / D16）
 *
 * 全部断言建立在**可观测结果**上（`handled` 返回值 / doc 文本 / selection / 补全行为），
 * 不做源码正则断言。
 *
 * 修复前的缺陷（v0.15.6 实测，见实施方案 §2）：
 *  - D3  段落 / 标题 / 引用块 Tab 返回 false → 焦点逃出编辑器到 `.sidebar-toggle-btn`
 *  - D4  math_block Tab 不缩进 → 焦点逃到 `.block-kebab`
 *  - D5  列表首项 / 任务项首项 / 嵌套中间层首个子项 Tab 返回 false → 焦点逃逸
 *  - D11 NodeSelection 态 Tab 完全不处理 → 焦点逃逸
 *  - D6  表格 cell 内 `| () |` 光标居中按 Tab 只右移 1（pairTabOut 抢走，不换格）
 *  - D7  mermaid_block 内 `f()` 按 Tab 不缩进只跳光标
 *  - D16 decidePairTabOut 无 isComposing 守卫
 */
import { describe, it, expect } from "vitest";
import { EditorState, TextSelection, NodeSelection } from "prosemirror-state";
import type { Command } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { lightMDSchema as schema } from "../core/schema";
import { buildKeymap } from "../core/keymap";
import { indent, outdent } from "../core/indentCommands";
import { decidePairTabOut } from "../core/autoPairRules";
import { inDisabledNodeState, inPairTabDisabledState, pairTabOut } from "../core/plugins/auto-pair";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";

const T = schema.topNodeType;
const para = (text: string) => schema.nodes.paragraph.create(null, text ? schema.text(text) : []);

/** 用真实 keymap 链（与生产完全同一条路径）按 Tab / Shift+Tab */
function pressChain(
  doc: PMNode,
  from: number,
  kind: "Tab" | "Shift-Tab",
  to?: number,
): { handled: boolean; state: EditorState } {
  const sel =
    to === undefined ? TextSelection.create(doc, from) : TextSelection.create(doc, from, to);
  const state = EditorState.create({ doc, selection: sel });
  let newState = state;
  const plugin = buildKeymap();
  const fakeView = { state, dispatch: (tr: Parameters<EditorState["apply"]>[0]) => {
    newState = state.apply(tr);
  } };
  const handled = (plugin.spec.props as { handleKeyDown?: (v: unknown, e: unknown) => boolean })
    .handleKeyDown?.(fakeView, new KeyboardEvent("keydown", { key: "Tab", shiftKey: kind === "Shift-Tab" })) ?? false;
  return { handled, state: newState };
}

/** 直接驱动单个 Command（绕过链，用于验证"永不 false"的契约） */
function pressCmd(
  doc: PMNode,
  cmd: Command,
  from: number,
  to?: number,
): { handled: boolean; state: EditorState } {
  const sel =
    to === undefined ? TextSelection.create(doc, from) : TextSelection.create(doc, from, to);
  const state = EditorState.create({ doc, selection: sel });
  let newState = state;
  const handled = cmd(state, (tr) => {
    newState = state.apply(tr);
  }, null as never);
  return { handled, state: newState };
}

function findP(doc: PMNode, text: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text && node.text.indexOf(text) >= 0) {
      found = pos + node.text.indexOf(text);
      return false;
    }
    return true;
  });
  return found;
}

// ═══════════════════════════════════════════════════════════════
// D3：段落 / 标题 / 引用块 —— 链必须返回 true（焦点不再逃逸）
// ═══════════════════════════════════════════════════════════════
describe("D3 段落/标题/引用块 Tab 不再落回浏览器", () => {
  it("顶层普通段落：handled=true 且有缩进产物（Q1 给产物）", () => {
    const doc = T.create(null, [para("hello")]);
    const r = pressChain(doc, 1 + 3, "Tab");
    expect(r.handled).toBe(true);
    // 默认缩进单位 "2"：光标处插两个空格
    expect(r.state.doc.textContent).toBe("hel  lo");
  });

  it("顶层段落 Shift+Tab 也 handled=true（即使无可删）", () => {
    const doc = T.create(null, [para("hello")]);
    const r = pressChain(doc, 1, "Shift-Tab");
    expect(r.handled).toBe(true);
    expect(r.state.doc.textContent).toBe("hello");
  });

  it("标题：handled=true 且文档不变（标题无缩进语义，但必须吞键）", () => {
    const doc = T.create(null, [schema.nodes.heading.create({ level: 2 }, schema.text("标题"))]);
    const r = pressChain(doc, 2, "Tab");
    expect(r.handled).toBe(true);
    expect(r.state.doc.textContent).toBe("标题");
  });

  it("引用块：handled=true 且加一层引用", () => {
    const doc = T.create(null, [schema.nodes.blockquote.create(null, [para("quoted")])]);
    const r = pressChain(doc, findP(doc, "quoted"), "Tab");
    expect(r.handled).toBe(true);
    // 嵌套后序列化应出现两层 ">"（或 blockquote 内再套 blockquote）
    const md = docToMarkdown(r.state.doc);
    expect(md.split("\n").filter((l) => l.includes("quoted")).join("")).toMatch(/^> ?>/);
  });

  it("引用块 Shift+Tab：handled=true（已在顶层时吞键不抛错）", () => {
    const doc = T.create(null, [schema.nodes.blockquote.create(null, [para("quoted")])]);
    const r = pressChain(doc, findP(doc, "quoted"), "Shift-Tab");
    expect(r.handled).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// D4：math_block / mermaid_block 缩进
// ═══════════════════════════════════════════════════════════════
describe("D4 公式块与图表块可缩进", () => {
  it("math_block 行首 Tab → 插缩进单位", () => {
    const doc = T.create(null, [schema.nodes.math_block.create({ latex: "" }, schema.text("x + y"))]);
    const r = pressChain(doc, 1, "Tab");
    expect(r.handled).toBe(true);
    expect(r.state.doc.child(0).textContent).toBe("  x + y");
  });

  it("mermaid_block（D7）内 `f()` 居中按 Tab → **缩进生效**，不再只跳光标", () => {
    const doc = T.create(null, [schema.nodes.mermaid_block.create(null, schema.text("f()"))]);
    // 光标放在 `(` 与 `)` 之间（旧实现被 pairTabOut 抢走，只右移 1）
    const r = pressChain(doc, 3, "Tab");
    expect(r.handled).toBe(true);
    // mermaid_block 已在 DISABLED_NODES（D7）→ pairTabOut 不生效 → 落到 codeBlockIndent
    expect(r.state.doc.child(0).textContent).toBe("f(  )");
  });
});

// ═══════════════════════════════════════════════════════════════
// D5：列表 / 任务列表首项 —— 通知 + 吞键（Q2）
// ═══════════════════════════════════════════════════════════════
describe("D5 列表首项 Tab 吞键（不再逃逸）", () => {
  const twoItems = (kind: "list_item" | "task_item") => {
    const mk = (t: string) => schema.nodes[kind].create(
      kind === "task_item" ? { checked: false } : null,
      [para(t)],
    );
    return T.create(null, [schema.nodes[kind === "task_item" ? "task_list" : "bullet_list"].create(null, [mk("a"), mk("b")])]);
  };

  it("bullet_list 首项：handled=true + 文档结构不变", () => {
    const doc = twoItems("list_item");
    const r = pressChain(doc, findP(doc, "a"), "Tab");
    expect(r.handled).toBe(true);
    expect(docToMarkdown(r.state.doc)).toBe(docToMarkdown(doc));
  });

  it("bullet_list 第二项：正常嵌套（不回归）", () => {
    const doc = twoItems("list_item");
    const r = pressChain(doc, findP(doc, "b"), "Tab");
    expect(r.handled).toBe(true);
    expect(docToMarkdown(r.state.doc)).toBe("- a\n    - b\n");
  });

  it("task_list 首项：handled=true + 结构不变", () => {
    const doc = twoItems("task_item");
    const r = pressChain(doc, findP(doc, "a"), "Tab");
    expect(r.handled).toBe(true);
    expect(docToMarkdown(r.state.doc)).toBe(docToMarkdown(doc));
  });

  it("task_list 第二项：正常嵌套", () => {
    const doc = twoItems("task_item");
    const r = pressChain(doc, findP(doc, "b"), "Tab");
    expect(r.handled).toBe(true);
    expect(docToMarkdown(r.state.doc)).toBe("- [ ] a\n  - [ ] b\n");
  });

  it("嵌套中间层的首个子项也吞键（旧实现在这里也是 false）", () => {
    const doc = markdownToDoc("- a\n    - a1\n    - a2\n");
    const r = pressChain(doc, findP(doc, "a1"), "Tab");
    expect(r.handled).toBe(true);
  });

  it("列表首项 Shift+Tab：handled=true（已在最外层，吞键）", () => {
    const doc = twoItems("list_item");
    const r = pressChain(doc, findP(doc, "a"), "Shift-Tab");
    expect(r.handled).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// D11：NodeSelection（整块选中）态 Tab
// ═══════════════════════════════════════════════════════════════
describe("D11 整块选中态 Tab 吞键", () => {
  it("NodeSelection 选中 code_block：handled=true + 文档不变", () => {
    const doc = T.create(null, [schema.nodes.code_block.create(null, schema.text("x"))]);
    const state = EditorState.create({ doc, selection: NodeSelection.create(doc, 0) });
    let newState = state;
    const handled = indent(state, (tr) => {
      newState = state.apply(tr);
    }, null as never);
    expect(handled).toBe(true);
    expect(newState.doc.textContent).toBe("x");
  });

  it("NodeSelection + Shift+Tab 同样吞键", () => {
    const doc = T.create(null, [schema.nodes.code_block.create(null, schema.text("x"))]);
    const state = EditorState.create({ doc, selection: NodeSelection.create(doc, 0) });
    const handled = outdent(state, () => {}, null as never);
    expect(handled).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// D6：pairTabOut 不再抢表格的 Tab
// ═══════════════════════════════════════════════════════════════
describe("D6 表格内 Tab 恒为逐格导航", () => {
  function tableWith(text: string): PMNode {
    const cell = (t: string) => schema.nodes.table_cell.create(null, t ? schema.text(t) : []);
    const row = (cells: PMNode[]) => schema.nodes.table_row.create(null, cells);
    return T.create(null, [
      schema.nodes.table.create(null, [
        schema.nodes.table_head.create(null, row([
          schema.nodes.table_header.create(null, schema.text("h1")),
          schema.nodes.table_header.create(null, schema.text("h2")),
        ])),
        schema.nodes.table_body.create(null, [row([cell(text), cell("B")])]),
      ]),
    ]);
  }

  it("cell 内容为 `()` 光标居中 → 换到下一格（不再只右移 1）", () => {
    const doc = tableWith("()");
    const p = findP(doc, "()");
    const r = pressChain(doc, p + 1, "Tab");
    expect(r.handled).toBe(true);
    // 下一格 "B" 的内容起点
    expect(r.state.selection.from).toBe(findP(r.state.doc, "B"));
  });

  it("对照：cell 内容为 `abc` 光标居中 → 同样换格（证明不是只有配对符号异常）", () => {
    const doc = tableWith("abc");
    const p = findP(doc, "abc");
    const r = pressChain(doc, p + 1, "Tab");
    expect(r.state.selection.from).toBe(findP(r.state.doc, "B"));
  });

  it("inPairTabDisabledState 在表格 cell 内为 true，在普通段落内为 false", () => {
    const tableDoc = tableWith("()");
    const tableState = EditorState.create({
      doc: tableDoc,
      selection: TextSelection.create(tableDoc, findP(tableDoc, "()") + 1),
    });
    expect(inPairTabDisabledState(tableState)).toBe(true);

    const paraDoc = T.create(null, [para("()")]);
    const paraState = EditorState.create({
      doc: paraDoc,
      selection: TextSelection.create(paraDoc, 2),
    });
    expect(inPairTabDisabledState(paraState)).toBe(false);
  });

  it("两个判定必须分离：表格里「Tab 跳出」禁用，但「自动补全」仍可用", () => {
    // 若把 table_cell 塞进 DISABLED_NODES（错误做法），inDisabledNodeState 会为 true，
    // 连带把表格内的自动补全也禁掉 —— 用户的 `(` 就不再补成 `()`。
    const tableDoc = tableWith("(");
    const inCell = EditorState.create({
      doc: tableDoc,
      selection: TextSelection.create(tableDoc, findP(tableDoc, "(") + 1),
    });
    expect(inPairTabDisabledState(inCell)).toBe(true); // Tab 跳出：禁用
    expect(inDisabledNodeState(inCell)).toBe(false); // 自动补全：可用
  });

  it("pairTabOut 命令本身：表格 cell 内返回 false（让位给 tableTab）", () => {
    const tableDoc = tableWith("()");
    const inCell = EditorState.create({
      doc: tableDoc,
      selection: TextSelection.create(tableDoc, findP(tableDoc, "()") + 1),
    });
    expect(pairTabOut(inCell, () => {}, undefined as never)).toBe(false);
    // 对照组：普通段落里同样的 `()` 居中 → 命令接管（既有能力不回归）
    const p = T.create(null, [para("()")]);
    const paraState = EditorState.create({ doc: p, selection: TextSelection.create(p, 2) });
    expect(pairTabOut(paraState, () => {}, undefined as never)).toBe(true);
  });

  it("代码块内仍能「Tab 跳出配对」（既有能力不回归）", () => {
    // code_block 在 DISABLED_NODES → pairTabOut 不生效 → 落到缩进
    // 这是**设计变更**：旧实现在 code_block 里也不跳（DISABLED_NODES 早就含它），
    // 故此断言只保证"仍然不跳、确实缩进"，与 v0.15.6 行为一致。
    const doc = T.create(null, [schema.nodes.code_block.create(null, schema.text("f()"))]);
    const r = pressChain(doc, 3, "Tab");
    expect(r.handled).toBe(true);
    expect(r.state.doc.child(0).textContent).toBe("f(  )");
  });

  it("普通段落内 `()` 光标居中仍能 Tab 跳出（pairTabOut 能力保留）", () => {
    const doc = T.create(null, [para("()")]);
    const r = pressChain(doc, 2, "Tab");
    expect(r.handled).toBe(true);
    // 跳到闭符号右侧：位置 3
    expect(r.state.selection.from).toBe(3);
    expect(r.state.doc.textContent).toBe("()"); // 未插入缩进
  });
});

// ═══════════════════════════════════════════════════════════════
// D16：decidePairTabOut 的 isComposing 守卫
// ═══════════════════════════════════════════════════════════════
describe("D16 组合态守卫", () => {
  const baseCtx = {
    before: "(",
    after: ")",
    selectionEmpty: true,
    inDisabledContext: false,
    isComposing: false,
    enabled: true,
    kinds: { bracket: true, quote: true, cjk: true },
  };

  it("正常态：光标夹在 () 中间 → true", () => {
    expect(decidePairTabOut(baseCtx)).toBe(true);
  });

  it("组合态（isComposing=true）→ false（不再误跳）", () => {
    expect(decidePairTabOut({ ...baseCtx, isComposing: true })).toBe(false);
  });

  it("禁用上下文 → false；总开关关闭 → false；非折叠光标 → false", () => {
    expect(decidePairTabOut({ ...baseCtx, inDisabledContext: true })).toBe(false);
    expect(decidePairTabOut({ ...baseCtx, enabled: false })).toBe(false);
    expect(decidePairTabOut({ ...baseCtx, selectionEmpty: false })).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 契约：indent / outdent 除表格外永不返回 false（结构性保证）
// ═══════════════════════════════════════════════════════════════
describe("契约：indent/outdent 除表格外永不 false", () => {
  it("各块类型逐一验证", () => {
    const cases: Array<{ label: string; doc: PMNode; pos: number }> = [
      { label: "段落", doc: T.create(null, [para("p")]), pos: 1 },
      { label: "标题", doc: T.create(null, [schema.nodes.heading.create({ level: 1 }, schema.text("h"))]), pos: 1 },
      { label: "引用块", doc: T.create(null, [schema.nodes.blockquote.create(null, [para("q")])]), pos: findP(T.create(null, [schema.nodes.blockquote.create(null, [para("q")])]), "q") },
      { label: "代码块", doc: T.create(null, [schema.nodes.code_block.create(null, schema.text("c"))]), pos: 1 },
      { label: "公式块", doc: T.create(null, [schema.nodes.math_block.create({ latex: "" }, schema.text("m"))]), pos: 1 },
      { label: "图表块", doc: T.create(null, [schema.nodes.mermaid_block.create(null, schema.text("mm"))]), pos: 1 },
      { label: "列表项", doc: markdownToDoc("- a\n- b\n"), pos: findP(markdownToDoc("- a\n- b\n"), "a") },
    ];
    for (const c of cases) {
      const ri = pressCmd(c.doc, indent, c.pos);
      const ro = pressCmd(c.doc, outdent, c.pos);
      expect(ri.handled, `${c.label} indent 必须 true`).toBe(true);
      expect(ro.handled, `${c.label} outdent 必须 true`).toBe(true);
    }
  });

  it("表格 cell 内 indent/outdent 返回 false（让位给 tableTab/tableShiftTab）", () => {
    const cell = schema.nodes.table_cell.create(null, schema.text("v"));
    const doc = T.create(null, [
      schema.nodes.table.create(null, [
        schema.nodes.table_head.create(null, schema.nodes.table_row.create(null, [
          schema.nodes.table_header.create(null, schema.text("h")),
        ])),
        schema.nodes.table_body.create(null, [schema.nodes.table_row.create(null, [cell])]),
      ]),
    ]);
    const pos = findP(doc, "v");
    expect(pressCmd(doc, indent, pos).handled).toBe(false);
    expect(pressCmd(doc, outdent, pos).handled).toBe(false);
  });
});
