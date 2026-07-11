/**
 * G13 大纲拖拽排序 —— 纯函数单元测试
 *
 * 覆盖 src/utils/outlineDrag.ts 的三个纯函数：
 * 1. getSectionRange：获取标题及其内容的范围
 * 2. adjustHeadingLevel：调整标题级别
 * 3. calculateDragTransaction：计算拖拽产生的 transaction
 *
 * 测试策略：
 * - 用 markdownToDoc 构造真实文档（接近实际场景）
 * - 用辅助函数 findHeadingPos 动态查找标题 pos，避免硬编码
 * - 用 docToMarkdown 验证 transaction 应用后的文档结构
 */
import { describe, it, expect } from "vitest";
import { EditorState } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import { lightMDSchema as schema } from "../core/schema";
import {
  getSectionRange,
  adjustHeadingLevel,
  calculateDragTransaction,
} from "../utils/outlineDrag";

/** 在文档中查找指定文本的标题节点的 pos */
function findHeadingPos(doc: PMNode, text: string): number {
  let result = -1;
  doc.forEach((child, offset) => {
    if (child.type.name === "heading" && child.textContent === text) {
      result = offset;
    }
  });
  if (result < 0) throw new Error(`未找到标题: ${text}`);
  return result;
}

/** 创建 EditorState */
function makeState(doc: PMNode): EditorState {
  return EditorState.create({ doc, schema });
}

/** 应用 transaction 并返回新文档的 markdown */
function applyTrAndGetMarkdown(state: EditorState, tr: any): string {
  const newState = state.apply(tr);
  return docToMarkdown(newState.doc).trim();
}

// ─── getSectionRange ────────────────────────────────────
describe("getSectionRange", () => {
  it("单标题：范围应覆盖到文档末尾", () => {
    const doc = markdownToDoc("# 标题一\n段落内容\n");
    const pos = findHeadingPos(doc, "标题一");
    const range = getSectionRange(doc, pos);
    expect(range.start).toBe(pos);
    expect(range.end).toBe(doc.content.size);
  });

  it("多层级标题：H1 的范围应覆盖到下一个 H1 之前", () => {
    const doc = markdownToDoc("# A\n## A.1\n内容A1\n# B\n内容B\n");
    const posA = findHeadingPos(doc, "A");
    const posB = findHeadingPos(doc, "B");
    const range = getSectionRange(doc, posA);
    expect(range.start).toBe(posA);
    expect(range.end).toBe(posB); // H1 的范围到下一个 H1 之前
  });

  it("多层级标题：H2 的范围应覆盖到下一个同级或更高级标题之前", () => {
    const doc = markdownToDoc("# A\n## A.1\n内容A1\n## A.2\n内容A2\n# B\n");
    const posA1 = findHeadingPos(doc, "A.1");
    const posA2 = findHeadingPos(doc, "A.2");
    const range = getSectionRange(doc, posA1);
    expect(range.start).toBe(posA1);
    expect(range.end).toBe(posA2); // A.1 的范围到 A.2 之前
  });

  it("最后一个标题：范围应到文档末尾", () => {
    const doc = markdownToDoc("# A\n内容A\n## B\n内容B\n");
    const posB = findHeadingPos(doc, "B");
    const range = getSectionRange(doc, posB);
    expect(range.start).toBe(posB);
    expect(range.end).toBe(doc.content.size);
  });

  it("非标题位置：返回单点范围", () => {
    const doc = markdownToDoc("# A\n内容\n");
    // 传入一个非 heading 的 pos（比如段落 pos）
    const paraPos = findHeadingPos(doc, "A") + 3; // 标题节点 nodeSize=3
    const range = getSectionRange(doc, paraPos);
    expect(range.start).toBe(paraPos);
    expect(range.end).toBe(paraPos);
  });
});

// ─── adjustHeadingLevel ────────────────────────────────────
describe("adjustHeadingLevel", () => {
  it("H2 → H3：级别正确调整", () => {
    const node = schema.nodes.heading.create(
      { level: 2 },
      schema.text("标题"),
    );
    const newNode = adjustHeadingLevel(node, 3);
    expect(newNode.attrs.level).toBe(3);
    expect(newNode.textContent).toBe("标题");
  });

  it("H3 → H1：级别正确调整", () => {
    const node = schema.nodes.heading.create(
      { level: 3 },
      schema.text("标题"),
    );
    const newNode = adjustHeadingLevel(node, 1);
    expect(newNode.attrs.level).toBe(1);
    expect(newNode.textContent).toBe("标题");
  });

  it("超出 6 上限：截断为 6", () => {
    const node = schema.nodes.heading.create(
      { level: 2 },
      schema.text("标题"),
    );
    const newNode = adjustHeadingLevel(node, 7);
    expect(newNode.attrs.level).toBe(6);
  });

  it("低于 1 下限：截断为 1", () => {
    const node = schema.nodes.heading.create(
      { level: 3 },
      schema.text("标题"),
    );
    const newNode = adjustHeadingLevel(node, 0);
    expect(newNode.attrs.level).toBe(1);
  });

  it("级别未变：返回原节点", () => {
    const node = schema.nodes.heading.create(
      { level: 2 },
      schema.text("标题"),
    );
    const newNode = adjustHeadingLevel(node, 2);
    expect(newNode).toBe(node); // 同一引用
  });

  it("非 heading 节点：返回原节点", () => {
    const node = schema.nodes.paragraph.create(null, schema.text("段落"));
    const newNode = adjustHeadingLevel(node, 1);
    expect(newNode).toBe(node);
  });
});

// ─── calculateDragTransaction ────────────────────────────────────
describe("calculateDragTransaction", () => {
  it("源标题移动到目标位置后文档结构正确", () => {
    // 文档：# A, 段A, # B, 段B
    // 拖 B 到 A 之前 → # B, 段B, # A, 段A
    const doc = markdownToDoc("# A\n段A\n# B\n段B\n");
    const posA = findHeadingPos(doc, "A");
    const posB = findHeadingPos(doc, "B");
    const state = makeState(doc);

    const tr = calculateDragTransaction(state, posB, posA);
    expect(tr).not.toBeNull();
    const md = applyTrAndGetMarkdown(state, tr!);
    // B 应在 A 之前
    const idxB = md.indexOf("B");
    const idxA = md.indexOf("A");
    expect(idxB).toBeLessThan(idxA);
    expect(md).toContain("段A");
    expect(md).toContain("段B");
  });

  it("跨层级拖拽自动调整级别（H2 拖到 H1 之前变 H1）", () => {
    // 文档：# A, ## B, 内容
    // 拖 B 到 A 之前 → B 变成 H1
    const doc = markdownToDoc("# A\n## B\n内容\n");
    const posA = findHeadingPos(doc, "A");
    const posB = findHeadingPos(doc, "B");
    const state = makeState(doc);

    const tr = calculateDragTransaction(state, posB, posA);
    expect(tr).not.toBeNull();
    const newState = state.apply(tr!);
    // B 应在 A 之前，且 B 的级别变为 1
    const newDoc = newState.doc;
    let bLevel: number | null = null;
    let aLevel: number | null = null;
    let bIdx = -1;
    let aIdx = -1;
    newDoc.forEach((child, offset, index) => {
      if (child.type.name === "heading") {
        if (child.textContent === "B") {
          bLevel = child.attrs.level;
          bIdx = index;
        }
        if (child.textContent === "A") {
          aLevel = child.attrs.level;
          aIdx = index;
        }
      }
    });
    expect(bLevel).toBe(1); // B 变成 H1
    expect(aLevel).toBe(1); // A 仍为 H1
    expect(bIdx).toBeLessThan(aIdx); // B 在 A 之前
  });

  it("跨层级拖拽保持子标题相对层级（H3+H4 拖到 H1 前变 H1+H2）", () => {
    // 文档：# A, ### B, #### B.1, # C
    // 拖 B section 到 A 之前：
    //   - B 变 H1（与目标 A 同级，delta = 1-3 = -2）
    //   - B.1 变 H2（按相同 delta 调整，保持相对层级差）
    const doc = markdownToDoc("# A\n### B\n#### B.1\n# C\n");
    const posA = findHeadingPos(doc, "A");
    const posB = findHeadingPos(doc, "B");
    const state = makeState(doc);

    const tr = calculateDragTransaction(state, posB, posA);
    expect(tr).not.toBeNull();
    const newState = state.apply(tr!);
    const newDoc = newState.doc;

    // 收集所有标题级别
    const headings: { text: string; level: number }[] = [];
    newDoc.forEach((child) => {
      if (child.type.name === "heading") {
        headings.push({ text: child.textContent, level: child.attrs.level });
      }
    });
    // B 应在 A 之前
    const bIdx = headings.findIndex((h) => h.text === "B");
    const aIdx = headings.findIndex((h) => h.text === "A");
    expect(bIdx).toBeLessThan(aIdx);
    // B 从 H3 变 H1（与目标 A 同级），B.1 从 H4 变 H2（保持 -1 相对差）
    expect(headings[bIdx].level).toBe(1);
    expect(headings[bIdx + 1].level).toBe(2); // B.1
    expect(headings[bIdx + 1].text).toBe("B.1");
  });

  it("无效拖拽（目标在源 section 内部）返回 null", () => {
    // 文档：# A, ## B, 内容
    // 拖 A 到 B 之前：B 在 A 的 section 内部，应返回 null
    const doc = markdownToDoc("# A\n## B\n内容\n");
    const posA = findHeadingPos(doc, "A");
    const posB = findHeadingPos(doc, "B");
    const state = makeState(doc);

    const tr = calculateDragTransaction(state, posA, posB);
    expect(tr).toBeNull();
  });

  it("相同位置返回 null", () => {
    const doc = markdownToDoc("# A\n## B\n");
    const posA = findHeadingPos(doc, "A");
    const state = makeState(doc);

    const tr = calculateDragTransaction(state, posA, posA);
    expect(tr).toBeNull();
  });

  it("源位置非 heading 返回 null", () => {
    const doc = markdownToDoc("# A\n段A\n# B\n");
    const posA = findHeadingPos(doc, "A");
    const paraPos = posA + 3; // 标题节点 nodeSize=3，下一个是段落
    const posB = findHeadingPos(doc, "B");
    const state = makeState(doc);

    const tr = calculateDragTransaction(state, paraPos, posB);
    expect(tr).toBeNull();
  });

  it("拖到末尾：源移动到文档末尾，使用最后一个标题的层级", () => {
    // 文档：## A, 段A, ## B, 段B（两个同级 H2）
    // 拖 A section 到文档末尾：A 应出现在 B 之后
    const doc = markdownToDoc("## A\n段A\n## B\n段B\n");
    const posA = findHeadingPos(doc, "A");
    const state = makeState(doc);

    const tr = calculateDragTransaction(state, posA, doc.content.size);
    expect(tr).not.toBeNull();
    const newState = state.apply(tr!);
    const newDoc = newState.doc;
    // A 应在 B 之后
    let aIdx = -1;
    let bIdx = -1;
    newDoc.forEach((child, _offset, index) => {
      if (child.type.name === "heading") {
        if (child.textContent === "A") aIdx = index;
        if (child.textContent === "B") bIdx = index;
      }
    });
    expect(aIdx).toBeGreaterThan(bIdx);
    // A 仍为 H2（与末尾最后一个标题 B 同级）
    const aNode = newDoc.child(aIdx);
    expect(aNode.attrs.level).toBe(2);
  });

  it("同层级拖拽不改变标题级别", () => {
    // 文档：## A, 段A, ## B, 段B
    // 拖 B 到 A 之前，B 仍为 H2
    const doc = markdownToDoc("## A\n段A\n## B\n段B\n");
    const posA = findHeadingPos(doc, "A");
    const posB = findHeadingPos(doc, "B");
    const state = makeState(doc);

    const tr = calculateDragTransaction(state, posB, posA);
    expect(tr).not.toBeNull();
    const newState = state.apply(tr!);
    const newDoc = newState.doc;
    // B 仍为 H2
    let bLevel: number | null = null;
    newDoc.forEach((child) => {
      if (child.type.name === "heading" && child.textContent === "B") {
        bLevel = child.attrs.level;
      }
    });
    expect(bLevel).toBe(2);
  });
});
