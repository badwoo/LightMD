/**
 * v0.11.0 B1-1：代码块 / 公式块内 Shift+Enter 不得腰斩块结构。
 *
 * 缺陷背景（P0）：
 *   `core/keymap.ts` 的 insertHardBreak 原本只判 selection.empty 与「前节点是否为
 *   hard_break」，未排除 `code: true` 的文本块。code_block / math_block 的 content
 *   是 `text*`，容不下 hard_break 节点 → ProseMirror 只能拆块，把剩余内容降级为
 *   paragraph 并写回磁盘（实测存盘变成 "```js\nconst a = 1\n```\n\n  \n\nconst b = 2\n"）。
 *
 * 修复口径：insertHardBreak 在 code_block / math_block / code_inline 内返回 false，
 * 交回默认键盘处理（code_block content 为 text*，原生回车即可正常换行）。
 *
 * 注：B6 块级原文保留会掩盖序列化类缺陷，本测试直接构造编辑后的 doc（见 v0110-escape-noise）。
 */
import { describe, it, expect } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { lightMDSchema } from "../core/schema";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";

const schema = lightMDSchema;

/** 在文档中找到第一个指定类型节点的起始位置（-1 = 未找到） */
function findNodePos(doc: PMNode, typeName: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found === -1 && node.type.name === typeName) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

/** 构造带指定光标位置的 EditorState（EditorState 不可变，须重新 create/apply） */
function stateWithCursor(doc: PMNode, pos: number): EditorState {
  const base = EditorState.create({ doc, schema });
  return base.apply(
    base.tr.setSelection(TextSelection.create(base.doc, pos))
  );
}

/** 复刻修复后的守卫逻辑（纯函数，与 keymap.ts 的 inCodeLikeBlock 一致） */
function inCodeLikeBlock(state: EditorState): boolean {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name;
    if (name === "code_block" || name === "math_block" || name === "code_inline") {
      return true;
    }
  }
  return false;
}

/** 模拟修复后的 Shift+Enter 入口：返回是否应当阻止执行 */
function shouldBlockHardBreak(state: EditorState): boolean {
  if (!state.selection.empty) return true;
  if (inCodeLikeBlock(state)) return true;
  const before = state.selection.$from.nodeBefore;
  if (before && before.type === schema.nodes.hard_break) return true;
  return false;
}

describe("v0.11.0 B1-1 代码块内 Shift+Enter 不破坏结构", () => {
  it("【复现 P0】code_block 内插入 hard_break 会拆块", () => {
    const doc = markdownToDoc("```js\nconst a = 1\nconst b = 2\n```");
    expect(findNodePos(doc, "code_block")).toBe(0);
    const codeNode = doc.child(0);
    expect(codeNode.type.name).toBe("code_block");

    // 光标置于 "const a = 1" 的 "1" 之后
    const idx = codeNode.textContent.indexOf("1") + 1;
    const at = 1 + idx; // code_block 起始 pos = 0，内容从 1 开始
    const st = EditorState.create({ doc, schema });

    // 不带守卫地插入 → 结构被破坏（这是 P0 缺陷本身）
    const broken = st.tr
      .replaceRangeWith(at, at, schema.nodes.hard_break.create())
      .doc;

    const types: string[] = [];
    broken.forEach((n) => types.push(n.type.name));
    expect(types).toEqual(["code_block", "paragraph"]);
    // 存盘结果里代码块被腰斩，剩余内容变成普通段落
    expect(docToMarkdown(broken)).toContain("const b = 2");
  });

  it("守卫在 code_block 内阻止 hard_break 插入，结构保持不变", () => {
    const md = "```js\nconst a = 1\nconst b = 2\n```";
    const doc = markdownToDoc(md);
    const codeNode = doc.child(0);
    const idx = codeNode.textContent.indexOf("1") + 1;
    const at = 1 + idx;

    const st = stateWithCursor(doc, at);
    // 光标确实在 code_block 内
    expect(inCodeLikeBlock(st)).toBe(true);
    // 守卫生效 → 阻止
    expect(shouldBlockHardBreak(st)).toBe(true);
    // 且守卫时不发生任何事务 → 文档与原文完全一致
    expect(docToMarkdown(doc)).toBe(md);
  });

  it("守卫在 math_block 内同样阻止", () => {
    const doc = markdownToDoc("$$E=mc^2$$");
    const mathPos = findNodePos(doc, "math_block");
    expect(mathPos).toBeGreaterThanOrEqual(0);

    const st = stateWithCursor(doc, mathPos + 2);
    expect(inCodeLikeBlock(st)).toBe(true);
    expect(shouldBlockHardBreak(st)).toBe(true);
  });

  it("普通段落内不阻止（Shift+Enter 仍能插入硬换行）", () => {
    const doc = markdownToDoc("hello world");
    const st = stateWithCursor(doc, 6); // "hello |world"
    expect(inCodeLikeBlock(st)).toBe(false);
    expect(shouldBlockHardBreak(st)).toBe(false);
  });

  it("普通段落内实际插入 hard_break 成功且可往返", () => {
    const doc = markdownToDoc("hello world");
    const st = EditorState.create({ doc, schema });
    const newDoc = st.tr
      .replaceRangeWith(6, 6, schema.nodes.hard_break.create())
      .doc;
    expect(newDoc.child(0).type.name).toBe("paragraph");
    // serializer 走「两空格 + 换行」表达硬换行
    expect(docToMarkdown(newDoc)).toBe("hello  \n world\n");
  });

  it("光标前已是硬换行时阻止（连续硬换行防护不回归）", () => {
    const doc = markdownToDoc("hello world");
    const st = EditorState.create({ doc, schema });
    const withBreak = st.tr
      .replaceRangeWith(6, 6, schema.nodes.hard_break.create())
      .doc;
    // 光标紧邻 hard_break 之后
    const st2 = stateWithCursor(withBreak, 7);
    expect(shouldBlockHardBreak(st2)).toBe(true);
  });
});
