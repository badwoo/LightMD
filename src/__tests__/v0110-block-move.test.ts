/**
 * v0.11.0 B3-8：真正的块移动命令（修正 Alt+↑↓ 的误导性绑定）。
 *
 * 缺陷背景（P1）：
 *   `core/keymap.ts` 把 `Alt-ArrowUp/Down` 绑到 `joinUp` / `lift`
 *   （**合并 / 提升**），与 UI 宣称的「移动块」语义完全不符 ——
 *   属**误导性半成品**：用户按 Alt+↑ 期望块上移一格，实际却是把当前块
 *   与上方块合并。
 *
 * 修复：实现 moveBlockUp / moveBlockDown 真正交换相邻块；
 * 原 joinUp/lift 能力移到 Alt+Shift+↑/↓（避免功能丢失）。
 *
 * 依赖：`prosemirror-transform@^1.10.0` 已在 package.json（实测确认）。
 */
import { describe, it, expect } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { readFileSync } from "node:fs";
import { lightMDSchema } from "../core/schema";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import { moveBlockUp, moveBlockDown } from "../core/blockMove";

const schema = lightMDSchema;

/** 构造指定顶层块内的光标位置（offsetInBlock 为块内字符偏移） */
function stateWithCursor(md: string, offsetInBlock: number, blockIndex: number) {
  const doc = markdownToDoc(md);
  const st = EditorState.create({ doc, schema });
  let blockPos = 0;
  for (let i = 0; i < blockIndex; i++) blockPos += doc.child(i).nodeSize;
  const pos = blockPos + 1 + offsetInBlock;
  return st.apply(st.tr.setSelection(TextSelection.create(st.doc, pos)));
}

/** 用 command 的标准 (state, dispatch) 签名执行，返回新 state 或 null（未执行） */
function run(cmd: typeof moveBlockUp, st: EditorState): EditorState | null {
  let next: EditorState | null = null;
  cmd(st, (tr) => {
    next = st.apply(tr);
  });
  return next;
}

/** 取 doc 的顶层块文本序列（避开 B6 原文保留，直接看结构） */
function topLevelTexts(doc: import("prosemirror-model").Node): string[] {
  const out: string[] = [];
  for (let i = 0; i < doc.childCount; i++) {
    out.push(doc.child(i).textContent.trim());
  }
  return out;
}

describe("v0.11.0 B3-8 块移动命令", () => {
  it("moveBlockUp 交换当前块与上块（内容顺序反转）", () => {
    const md = "first\n\nsecond\n\nthird\n";
    const st = stateWithCursor(md, 1, 1); // 光标在 "second"
    const next = run(moveBlockUp, st);
    expect(next).not.toBeNull();
    // 注：不能断言 docToMarkdown —— B6 原文保留会逐字节返回源文本，
    // 掩盖移动结果（这正是 B3-4 测试要规避的同一陷阱）。直接看 doc 结构。
    expect(topLevelTexts(next!.doc)).toEqual(["second", "first", "third"]);
  });

  it("moveBlockDown 交换当前块与下块", () => {
    const md = "first\n\nsecond\n\nthird\n";
    const st = stateWithCursor(md, 1, 1); // 光标在 "second"
    const next = run(moveBlockDown, st);
    expect(next).not.toBeNull();
    expect(topLevelTexts(next!.doc)).toEqual(["first", "third", "second"]);
  });

  it("顶层首块 moveBlockUp 返回 false（无可移动方向）", () => {
    const md = "first\n\nsecond\n";
    const st = stateWithCursor(md, 1, 0); // 光标在 "first"
    expect(moveBlockUp(st)).toBe(false);
  });

  it("顶层末块 moveBlockDown 返回 false", () => {
    const md = "first\n\nsecond\n";
    const st = stateWithCursor(md, 1, 1); // 光标在 "second"
    expect(moveBlockDown(st)).toBe(false);
  });

  it("移动后内容不丢失（三个块都在）", () => {
    const md = "alpha\n\nbeta\n\ngamma\n";
    const st = stateWithCursor(md, 1, 2); // 光标在 "gamma"
    const next = run(moveBlockUp, st);
    expect(next).not.toBeNull();
    const text = next!.doc.textContent;
    for (const w of ["alpha", "beta", "gamma"]) {
      expect(text).toContain(w);
    }
  });

  it("单块文档两个方向都返回 false", () => {
    const st = stateWithCursor("only\n", 1, 0);
    expect(moveBlockUp(st)).toBe(false);
    expect(moveBlockDown(st)).toBe(false);
  });

  it("源码中 Alt+↑↓ 已改为块移动、Alt+Shift+↑↓ 为原合并/提升", () => {
    // 用源码断言锁定绑定关系（避免只测纯函数而漏掉「键位没换」的情况）
    const src = readFileSync("src/core/keymap.ts", "utf-8");
    expect(src).toContain("moveBlockUp");
    expect(src).toContain("moveBlockDown");
    expect(src).toContain('"Alt-Shift-ArrowUp": joinUp');
    expect(src).toContain('"Alt-Shift-ArrowDown": lift');
    // 不再把 Alt+↑↓ 直接绑到 joinUp/lift
    expect(src).not.toMatch(/"Alt-ArrowUp":\s*joinUp/);
    expect(src).not.toMatch(/"Alt-ArrowDown":\s*lift/);
  });
});
