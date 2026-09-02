/**
 * v0.6.0：translateBridge 序列化桥接测试
 *
 * 覆盖：
 * 1. extractSelectionText：空选区/格式保真（粗体/斜体/行内代码/链接）/跨段选区/
 *    code_block·math_block 拒绝/混合选区放行
 * 2. sanitizeTranslated：``` 包裹剥离、"以下是翻译："前缀、Translation: 前缀、
 *    尾部客套、干净文本原样
 * 3. buildApplyTransaction：行内替换保格式、块级替换、bilingual 引用块插入、
 *    空译文 null、NodeSelection 拒绝
 * 4. applyTranslation：view 包装 dispatch 生效
 */
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { EditorState, TextSelection, NodeSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import {
  extractSelectionText,
  extractFromIframe,
  sanitizeTranslated,
  buildApplyTransaction,
  applyTranslation,
} from "../services/translateBridge";

/** 构建编辑器状态 */
function makeState(md: string, from?: number, to?: number): EditorState {
  const doc = markdownToDoc(md);
  const selection =
    from !== undefined && to !== undefined
      ? TextSelection.create(doc, from, to)
      : undefined;
  return EditorState.create({ doc, selection });
}

/** 在文档中查找文本的位置范围（避免硬编码位置偏移） */
function findTextPos(doc: PMNode, needle: string): { from: number; to: number } {
  let found: { from: number; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    // 非 text 节点返回 true 继续深入其子节点
    if (!node.isText || !node.text) return true;
    const idx = node.text.indexOf(needle);
    if (idx >= 0) {
      found = { from: pos + idx, to: pos + idx + needle.length };
      return false;
    }
    return true;
  });
  if (!found) throw new Error(`text not found: ${needle}`);
  return found;
}

/** 选中指定文本的 state */
function stateWithSelection(md: string, needle: string): EditorState {
  const doc = markdownToDoc(md);
  const { from, to } = findTextPos(doc, needle);
  return EditorState.create({
    doc,
    selection: TextSelection.create(doc, from, to),
  });
}

describe("v0.6.0 translateBridge - extractSelectionText", () => {
  it("空选区返回 null", () => {
    const state = makeState("hello world");
    expect(extractSelectionText(state)).toBeNull();
  });

  it("纯文本选区提取文本", () => {
    const state = stateWithSelection("hello brave world", "brave");
    const r = extractSelectionText(state);
    expect(r).not.toBeNull();
    expect(r!.text).toBe("brave");
  });

  it("粗体/斜体/行内代码/链接格式保真", () => {
    const md = "这是**加粗**和*斜体*以及`代码`还有[链接](https://example.com)结束";
    const state = stateWithSelection(md, "这是");
    // 选整段：选区从段落内第一个位置到段落内容末尾
    const doc = state.doc;
    const para = doc.firstChild!;
    const sel = TextSelection.create(doc, 1, 1 + para.content.size);
    const fullState = EditorState.create({ doc, selection: sel });
    const r = extractSelectionText(fullState);
    expect(r).not.toBeNull();
    expect(r!.text).toContain("**加粗**");
    expect(r!.text).toContain("*斜体*");
    expect(r!.text).toContain("`代码`");
    expect(r!.text).toContain("[链接](https://example.com)");
  });

  it("多段选区提取两段文本", () => {
    const md = "第一段内容\n\n第二段内容";
    const doc = markdownToDoc(md);
    // 选中第一段中间到第二段末尾（needle 覆盖完整文本确保 to 到段尾）
    const p1 = findTextPos(doc, "第一段内容");
    const p2 = findTextPos(doc, "第二段内容");
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, p1.from, p2.to),
    });
    const r = extractSelectionText(state);
    expect(r).not.toBeNull();
    expect(r!.text).toContain("第一段内容");
    expect(r!.text).toContain("第二段内容");
    // 两个段落之间应有空行分隔
    expect(r!.text).toMatch(/第一段内容\s*\n\s*\n第二段内容/);
  });

  it("code_block 全选区拒绝（返回 null）", () => {
    const md = "```js\nconsole.log(1);\n```";
    const doc = markdownToDoc(md);
    const codeBlock = doc.firstChild!;
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1, codeBlock.content.size),
    });
    expect(extractSelectionText(state)).toBeNull();
  });

  it("math_block 选区拒绝（返回 null）", () => {
    const md = "$$\nE=mc^2\n$$";
    const doc = markdownToDoc(md);
    const mathBlock = doc.firstChild!;
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1, mathBlock.content.size),
    });
    expect(extractSelectionText(state)).toBeNull();
  });

  it("代码块+段落混合选区放行（不全为代码）", () => {
    const md = "```\ncode here\n```\n\n普通段落文本";
    const doc = markdownToDoc(md);
    const p = findTextPos(doc, "普通段落文本");
    // 从代码块开始选到段落
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1, p.to),
    });
    const r = extractSelectionText(state);
    expect(r).not.toBeNull();
    expect(r!.text).toContain("普通段落文本");
  });

  it("返回 pos 为选区末尾位置", () => {
    const state = stateWithSelection("hello brave world", "brave");
    const r = extractSelectionText(state);
    expect(r!.pos).toBe(state.selection.to);
  });
});

describe("v0.6.0 translateBridge - extractFromIframe", () => {
  it("有选区返回文本", () => {
    const div = document.createElement("div");
    div.textContent = "selected text";
    document.body.appendChild(div);
    const range = document.createRange();
    range.selectNodeContents(div);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    expect(extractFromIframe(document)).toBe("selected text");
    document.body.removeChild(div);
  });

  it("无选区/空选区返回 null", () => {
    const sel = window.getSelection();
    sel?.removeAllRanges();
    expect(extractFromIframe(document)).toBeNull();
  });
});

describe("v0.6.0 translateBridge - sanitizeTranslated", () => {
  it("剥离首尾代码围栏包裹", () => {
    expect(sanitizeTranslated("```\n你好世界\n```")).toBe("你好世界");
  });

  it("剥离带语言标注的围栏", () => {
    expect(sanitizeTranslated("```markdown\n你好世界\n```")).toBe("你好世界");
  });

  it("剥离'以下是翻译：'前缀", () => {
    expect(sanitizeTranslated("以下是翻译：你好世界")).toBe("你好世界");
  });

  it("剥离'好的，以下是翻译：'前缀", () => {
    expect(sanitizeTranslated("好的，以下是翻译：你好世界")).toBe("你好世界");
  });

  it("剥离 Translation: 英文前缀", () => {
    expect(sanitizeTranslated("Translation: Hello world")).toBe("Hello world");
  });

  it("剥离尾部客套语", () => {
    expect(sanitizeTranslated("你好世界。希望对你有帮助。")).toBe("你好世界。");
  });

  it("围栏+前缀叠加剥离", () => {
    expect(sanitizeTranslated("以下是翻译：\n```\n你好\n```")).toBe("你好");
  });

  it("干净文本原样保留", () => {
    expect(sanitizeTranslated("  你好世界  ")).toBe("你好世界");
    expect(sanitizeTranslated("**加粗**译文")).toBe("**加粗**译文");
  });

  it("空文本/纯空白返回空串", () => {
    expect(sanitizeTranslated("")).toBe("");
    expect(sanitizeTranslated("   \n  ")).toBe("");
  });
});

describe("v0.6.0 translateBridge - buildApplyTransaction", () => {
  it("空译文返回 null", () => {
    const state = stateWithSelection("hello world", "world");
    expect(buildApplyTransaction(state, "", "replace")).toBeNull();
    expect(buildApplyTransaction(state, "   ", "bilingual")).toBeNull();
  });

  it("行内替换：译文格式标记解析为 marks", () => {
    const state = stateWithSelection("hello world", "world");
    const tr = buildApplyTransaction(state, "**世界**", "replace");
    expect(tr).not.toBeNull();
    const newDoc = tr!.doc;
    // 替换后段落文本应为 "hello **世界**"（世界带 strong mark；world 前的空格保留）
    expect(newDoc.textContent).toBe("hello 世界");
    const para = newDoc.firstChild!;
    const boldNode = para.child(1);
    expect(boldNode.marks.some((m) => m.type.name === "strong")).toBe(true);
  });

  it("行内替换：纯文本译文直接替换", () => {
    const state = stateWithSelection("hello world", "world");
    const tr = buildApplyTransaction(state, "世界", "replace");
    expect(tr!.doc.textContent).toBe("hello 世界");
  });

  it("行内替换：链接译文保留链接结构", () => {
    const state = stateWithSelection("见 world 详情", "world");
    const tr = buildApplyTransaction(state, "[世界](https://example.com)", "replace");
    expect(tr).not.toBeNull();
    // 遍历段落子节点找带 link mark 的文本节点（"见 " 在前）
    let linkMark = null;
    tr!.doc.firstChild!.forEach((child) => {
      const m = child.marks.find((mk) => mk.type.name === "link");
      if (m) linkMark = m;
    });
    expect(linkMark).toBeTruthy();
    expect(linkMark!.attrs.href).toBe("https://example.com");
  });

  it("块级替换：跨段选区替换为多段", () => {
    const md = "第一段甲乙\n\n第二段丙丁";
    const doc = markdownToDoc(md);
    const p1 = findTextPos(doc, "甲乙");
    const p2 = findTextPos(doc, "丙丁");
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, p1.from, p2.to),
    });
    const tr = buildApplyTransaction(state, "段落A内容\n\n段落B内容", "replace");
    expect(tr).not.toBeNull();
    const mdOut = docToMarkdown(tr!.doc);
    expect(mdOut).toContain("段落A内容");
    expect(mdOut).toContain("段落B内容");
    // 原文应被替换掉
    expect(mdOut).not.toContain("甲乙");
    expect(mdOut).not.toContain("丙丁");
  });

  it("bilingual：译文插入为引用块且原文保留", () => {
    const state = stateWithSelection("hello world", "world");
    const tr = buildApplyTransaction(state, "世界", "bilingual");
    expect(tr).not.toBeNull();
    const mdOut = docToMarkdown(tr!.doc);
    expect(mdOut).toContain("hello world");
    expect(mdOut).toContain("> 世界");
  });

  it("bilingual：多段译文插入同一引用块", () => {
    const state = stateWithSelection("hello world", "world");
    const tr = buildApplyTransaction(state, "段一\n\n段二", "bilingual");
    expect(tr).not.toBeNull();
    const mdOut = docToMarkdown(tr!.doc);
    expect(mdOut).toContain("> 段一");
    expect(mdOut).toContain("> 段二");
  });

  it("NodeSelection 下 replace 拒绝（返回 null）", () => {
    const doc = markdownToDoc("第一段\n\n第二段");
    const para2 = doc.child(1);
    // NodeSelection 需要节点位置：第二段前有 1(段1)+1(边界)=2
    const pos = 1 + doc.child(0).nodeSize;
    expect(doc.nodeAt(pos)).toBeTruthy();
    const state = EditorState.create({
      doc,
      selection: NodeSelection.create(doc, pos),
    });
    expect(buildApplyTransaction(state, "译文", "replace")).toBeNull();
    // 不再引用 para2 避免 unused
    expect(para2.type.name).toBe("paragraph");
  });

  it("清洗在回写前生效（译文带围栏包裹）", () => {
    const state = stateWithSelection("hello world", "world");
    const tr = buildApplyTransaction(state, "```\n世界\n```", "replace");
    expect(tr!.doc.textContent).toBe("hello 世界");
  });
});

describe("v0.6.0 translateBridge - applyTranslation (view 包装)", () => {
  it("dispatch 生效并返回 true", () => {
    const state = stateWithSelection("hello world", "world");
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const view = new EditorView({ mount }, { state });
    const ok = applyTranslation(view, "世界", "replace");
    expect(ok).toBe(true);
    expect(view.state.doc.textContent).toBe("hello 世界");
    view.destroy();
    document.body.removeChild(mount);
  });

  it("译文无效返回 false 且不 dispatch", () => {
    const state = stateWithSelection("hello world", "world");
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const view = new EditorView({ mount }, { state });
    const before = view.state.doc;
    const ok = applyTranslation(view, "  ", "replace");
    expect(ok).toBe(false);
    expect(view.state.doc).toBe(before);
    view.destroy();
    document.body.removeChild(mount);
  });
});
