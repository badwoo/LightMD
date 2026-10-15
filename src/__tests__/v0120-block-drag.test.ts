/**
 * v0.12.0 需求11：块级拖拽移动测试
 *
 * 覆盖：
 * 1. DRAGGABLE_BLOCKS 白名单（toc 排除；块级类型齐全）
 * 2. isDraggableBlock：白名单 + 顶层判定（列表/引用内部不开放）
 * 3. computeDropInsertPos：块上半/下半插入点、块间边界、原位 → null
 * 4. buildBlockMoveTr：删除 + 插入 + mapping（一次撤销单元）；drop 后结构合法
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { EditorState, NodeSelection } from "prosemirror-state";
import { history, undo } from "prosemirror-history";
import { lightMDSchema as schema } from "../core/schema";
import {
  DRAGGABLE_BLOCKS,
  isDraggableBlock,
  computeDropInsertPos,
  buildBlockMoveTr,
} from "../core/plugins/block-drag";

const editorCss = readFileSync("src/styles/editor.css", "utf-8");

/** 构造三段文档：p(a) / code(x) / p(b) */
function makeDoc3() {
  return schema.node("doc", null, [
    schema.node("paragraph", null, [schema.text("a")]),
    schema.node("code_block", { language: "" }, [schema.text("x")]),
    schema.node("paragraph", null, [schema.text("b")]),
  ]);
}

describe("v0.12.0 需求11：白名单与顶层判定", () => {
  it("白名单包含全部块级类型且排除 toc", () => {
    for (const name of [
      "paragraph", "heading", "blockquote", "bullet_list", "ordered_list",
      "code_block", "mermaid_block", "math_block", "table", "horizontal_rule",
    ]) {
      expect(DRAGGABLE_BLOCKS.has(name)).toBe(true);
    }
    expect(DRAGGABLE_BLOCKS.has("toc")).toBe(false);
  });

  it("isDraggableBlock：顶层白名单块 → true", () => {
    const doc = makeDoc3();
    expect(isDraggableBlock(doc, 0)).toBe(true); // paragraph
    const codePos = doc.child(0).nodeSize;
    expect(isDraggableBlock(doc, codePos)).toBe(true); // code_block
  });

  it("isDraggableBlock：列表内部（depth>0）→ false（仅顶层开放）", () => {
    const doc = schema.node("doc", null, [
      schema.node("bullet_list", null, [
        schema.node("list_item", null, [
          schema.node("paragraph", null, [schema.text("item")]),
        ]),
      ]),
    ]);
    // 列表顶层可拖
    expect(isDraggableBlock(doc, 0)).toBe(true);
    // 列表项内的段落（depth=3）不可拖
    const itemParaPos = 1 + 1 + 1; // bullet_list(1) → list_item(1) → paragraph 起点
    expect(doc.resolve(itemParaPos).depth).toBeGreaterThan(0);
    expect(isDraggableBlock(doc, itemParaPos)).toBe(false);
  });

  it("isDraggableBlock：越界/不存在 → false", () => {
    const doc = makeDoc3();
    expect(isDraggableBlock(doc, -1)).toBe(false);
    expect(isDraggableBlock(doc, doc.content.size + 10)).toBe(false);
  });
});

describe("v0.12.0 需求11：computeDropInsertPos", () => {
  const doc = makeDoc3();
  const p1Pos = 0;
  const p1Size = doc.child(0).nodeSize;
  const codePos = p1Size;
  const codeSize = doc.child(1).nodeSize;
  const p2Pos = codePos + codeSize;

  it("鼠标在目标块上半 → 插到该块前", () => {
    // 源 = p1（0），目标 = p2（6）：上半 → before(1) = p2Pos
    const result = computeDropInsertPos(doc, p2Pos + 1, true, p1Pos);
    expect(result).toBe(p2Pos);
  });

  it("鼠标在目标块下半 → 插到该块后", () => {
    const result = computeDropInsertPos(doc, p2Pos + 1, false, p1Pos);
    expect(result).toBe(doc.content.size); // 文档末尾
  });

  it("目标紧邻源块后（插到前 === 源块后）→ 视为原位 null", () => {
    // 源 = code（3, srcEnd=6），目标 = p2 上半 → 6 === srcEnd → null
    expect(computeDropInsertPos(doc, p2Pos + 1, true, codePos)).toBeNull();
  });

  it("插到自身前/后（原位）→ null", () => {
    // 目标块 = code 自己：上半 → codePos（=== srcPos）→ null
    expect(computeDropInsertPos(doc, codePos + 1, true, codePos)).toBeNull();
    // 下半 → codePos + codeSize（=== srcEnd）→ null
    expect(computeDropInsertPos(doc, codePos + 1, false, codePos)).toBeNull();
  });

  it("落点为块间边界（depth=0）→ 使用边界位置；与源原位 → null", () => {
    // p1 与 code 之间：pos = p1Size（= codePos，源=code 时即原位）→ null
    expect(computeDropInsertPos(doc, p1Size, true, codePos)).toBeNull();
    // 源 = code 时，文档起点边界 0 有效（插到最前）
    expect(computeDropInsertPos(doc, 0, true, codePos)).toBe(0);
  });
});

describe("v0.12.0 需求11：buildBlockMoveTr（drop 后结构合法）", () => {
  it("把 code 移到文档末尾：一次事务、结构正确、选中跟随", () => {
    const doc = makeDoc3();
    const codePos = doc.child(0).nodeSize;
    const state = EditorState.create({
      doc,
      schema,
      selection: NodeSelection.create(doc, codePos),
    });
    const tr = buildBlockMoveTr(state, codePos, doc.content.size);
    expect(tr).not.toBeNull();
    const newState = state.apply(tr!);
    // 顺序：p(a) / p(b) / code(x)
    expect(newState.doc.childCount).toBe(3);
    expect(newState.doc.child(0).textContent).toBe("a");
    expect(newState.doc.child(1).textContent).toBe("b");
    expect(newState.doc.child(2).type.name).toBe("code_block");
    expect(newState.doc.child(2).textContent).toBe("x");
    // 选中跟随到新位置（NodeSelection）
    expect(newState.selection).toBeInstanceOf(NodeSelection);
    const sel = newState.selection as NodeSelection;
    expect(newState.doc.nodeAt(sel.from)?.type.name).toBe("code_block");
  });

  it("把最后一段移到最前（insertPos < srcPos，mapping 修正）", () => {
    const doc = makeDoc3();
    const codePos = doc.child(0).nodeSize;
    const src = codePos + doc.child(1).nodeSize; // p2
    const state = EditorState.create({
      doc,
      schema,
      selection: NodeSelection.create(doc, src),
    });
    const tr = buildBlockMoveTr(state, src, 0);
    expect(tr).not.toBeNull();
    const newState = state.apply(tr!);
    // 顺序：p(b) / p(a) / code(x)
    expect(newState.doc.child(0).textContent).toBe("b");
    expect(newState.doc.child(1).textContent).toBe("a");
    expect(newState.doc.child(2).type.name).toBe("code_block");
  });

  it("撤销一步即完整还原（history 按事务分组 = 一次撤销单元）", () => {
    // 用 prosemirror-history 验证：单事务移动后 undo 一次恢复原文
    const doc = makeDoc3();
    const codePos = doc.child(0).nodeSize;
    let state = EditorState.create({
      doc,
      schema,
      selection: NodeSelection.create(doc, codePos),
      plugins: [history()],
    });
    state = state.apply(buildBlockMoveTr(state, codePos, doc.content.size)!);
    expect(state.doc.child(2).type.name).toBe("code_block");
    // undo 一次
    undo(state, (tr) => {
      state = state.apply(tr);
    });
    expect(state.doc.eq(doc)).toBe(true);
  });
});

/**
 * v0.12.0 返修（问题2）：拖拽手柄必须对**所有可拖块**可见。
 *
 * 缺陷背景：手柄此前用 `::before` 伪元素画在选中块左缘外 20px，但：
 *  ① 代码块/图表/公式的 wrapper 已用 `::before` 画语言角标，
 *     `.code-block-wrapper.has-lang-select::before { display: none }` 同权重且更靠后，
 *     把 before 版手柄一并 display:none 掉 → 只有无该规则的表格能看到手柄；
 *  ② 这三类 wrapper 都设了 `overflow: hidden`，左侧外 20px 的手柄会被裁掉。
 * 修复：改用 `::after` + 选中态放开 overflow。
 */
describe("v0.12.0 返修（问题2）：拖拽手柄视觉（CSS 落点断言）", () => {
  it("手柄画在选中块的 ::after（避开 wrapper 的 ::before 语言角标）", () => {
    expect(editorCss).toContain(".ProseMirror > .pm-block-selected::after");
    expect(editorCss).toContain(".ProseMirror > .ProseMirror-selectednode::after");
    expect(editorCss).toContain('content: "⋮⋮"');
    // 不能再有 ::before 版手柄（否则会与语言角标规则冲突而不可见）
    expect(editorCss).not.toContain(".ProseMirror > .pm-block-selected::before");
    expect(editorCss).not.toContain(".ProseMirror > .ProseMirror-selectednode::before");
  });

  it("选中态放开三类 wrapper 的 overflow，让左缘外手柄不被裁剪", () => {
    for (const cls of ["code-block-wrapper", "mermaid-block-wrapper", "math-block-wrapper"]) {
      expect(editorCss).toContain(`.ProseMirror > .${cls}.pm-block-selected`);
      expect(editorCss).toContain(`.ProseMirror > .${cls}.ProseMirror-selectednode`);
    }
    // v0.13.0 返修（问题3）：只放开选中态不够——手柄在 hover / .pm-block-active
    // 两态也要显示，而 wrapper 的 overflow:hidden 会把左缘外 20px 的手柄裁掉。
    // 因此该组规则同时覆盖 hover 与 .pm-block-active，规则体仍为 overflow: visible。
    for (const cls of ["code-block-wrapper", "mermaid-block-wrapper", "math-block-wrapper"]) {
      expect(editorCss).toContain(`.ProseMirror > .${cls}:hover`);
      expect(editorCss).toContain(`.ProseMirror > .${cls}.pm-block-active`);
    }
    expect(editorCss).toMatch(
      /\.math-block-wrapper\.pm-block-active\s*\{\s*overflow: visible;/,
    );
  });

  it("手柄定位在选中块左缘外（left: -20px），与拖拽热区（左 18px）对齐", () => {
    expect(editorCss).toMatch(/content: "⋮⋮";[\s\S]*?left: -20px;/);
  });
});