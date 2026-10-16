// @vitest-environment jsdom
/**
 * v0.13.1 需求8：撤销（Ctrl+Z）**绝不跨文档**。
 *
 * ## 用户报告
 * 「我在 a 文档编辑，然后切到 b 文档去使用 Ctrl+Z 撤销，结果切回来 a 文档后，
 *  a 文档的内容都变成了 b 文档的内容。」
 *
 * ## 根因
 * 所有标签共用**同一个 EditorView**，而撤销历史是 **EditorState 内部**的
 * （`prosemirror-history` 的 state 字段）。换文档此前只是 dispatch 一条
 * `replaceWith(0, size, newDoc)`：
 *   · 这条事务本身被记进历史 → Ctrl+Z 会把「切换文档」撤销掉，编辑器当场回到
 *     **上一个文档**的内容，而活动标签已是新文档 → onDocChange 把旧文档内容写进
 *     新标签 → 下一次保存就把 A 的内容写进 B 的文件（静默跨文件数据损坏）；
 *   · 即便排除它，历史里仍留着**上一个文档**的编辑步骤，撤销会拿那些步骤去改
 *     当前文档（位置完全不同）→ 内容错乱。
 *
 * ## 修复
 * 换文档事务带 `addToHistory:false` + `resetHistory:true`；`core/editor.ts` 的
 * dispatchTransaction 在 `resetHistory` 时**重建 state**（复用同一批插件实例），
 * 撤销栈随之归零。同文件内的模式切换 / 翻译回写只加 `addToHistory:false`，
 * **不清空**历史（否则"切个模式就丢掉全部撤销记录"）。
 *
 * ## 手法
 * 挂载**真实** `createEditor`（真实插件流水线，含 history 与新的 reset 逻辑），
 * 用真实的撤销命令驱动，断言 doc 的**文本内容**而不是源码字符串。
 */
import { describe, it, expect, afterEach } from "vitest";
import { undo, redo, undoDepth } from "prosemirror-history";
import { TextSelection } from "prosemirror-state";
import { createEditor } from "../core/editor";
import { markdownToDoc } from "../core/markdown/parser";

/** 挂载真实编辑器 */
function mount(content: string) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = createEditor({ parent: host, initialContent: content } as never)!;
  return { view, host };
}

/** 模拟 EditorContainer 的换文档：整篇替换 + fileSwitch/resetHistory 元数据 */
function fileSwitch(view: import("prosemirror-view").EditorView, content: string) {
  const newDoc = markdownToDoc(content);
  const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, newDoc.content);
  tr.setSelection(TextSelection.atStart(tr.doc));
  tr.setMeta("fileSwitch", true);
  tr.setMeta("addToHistory", false);
  tr.setMeta("resetHistory", true);
  view.dispatch(tr);
}

/** 模拟"同文件内模式切换"的整篇重解析（只排除自身入历史，不清空历史） */
function modeSwitch(view: import("prosemirror-view").EditorView, content: string) {
  const newDoc = markdownToDoc(content);
  const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, newDoc.content);
  tr.setSelection(TextSelection.atStart(tr.doc));
  tr.setMeta("fileSwitch", true);
  tr.setMeta("addToHistory", false);
  view.dispatch(tr);
}

/** 在文档末尾插入文本（制造一条真实的编辑历史） */
function typeAtEnd(view: import("prosemirror-view").EditorView, text: string) {
  const end = view.state.doc.content.size - 1;
  const tr = view.state.tr.insertText(text, end);
  view.dispatch(tr);
}

const A_DOC = "AAA_original\n";
const B_DOC = "BBB_original\n";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("v0.13.1 需求8：换文档后撤销不得回到上一个文档", () => {
  it("A 里编辑 → 切到 B → Ctrl+Z：doc 不得变回 A 的内容", () => {
    const { view, host } = mount(A_DOC);
    // 在 A 里编辑，制造历史
    typeAtEnd(view, "EDITED_IN_A");
    expect(view.state.doc.textContent).toContain("EDITED_IN_A");

    fileSwitch(view, B_DOC);
    expect(view.state.doc.textContent).toContain("BBB_original");

    // 在 B 里按 Ctrl+Z（真实撤销命令）。**反复按**，把"历史里残留的 A 步骤"
    // 这条路径也覆盖到：旧实现下总有一次会退回 A 的内容。
    for (let i = 0; i < 5; i++) {
      undo(view.state, view.dispatch);
      const t = view.state.doc.textContent;
      expect(t, `第 ${i + 1} 次撤销后不应出现 A 的内容`).not.toContain("AAA_original");
      expect(t, `第 ${i + 1} 次撤销后不应出现 A 的编辑`).not.toContain("EDITED_IN_A");
    }

    const text = view.state.doc.textContent;
    // 而且应当仍是 B 的文档
    expect(text).toContain("BBB_original");

    host.remove();
    view.destroy();
  });

  it("换文档会清空撤销栈（undoDepth 归零）——这是「撤销不跨文档」的直接保证", () => {
    const { view, host } = mount(A_DOC);
    typeAtEnd(view, "X1");
    typeAtEnd(view, "X2");
    expect(undoDepth(view.state)).toBeGreaterThan(0);

    fileSwitch(view, B_DOC);
    // 新文档的撤销栈从空开始
    expect(undoDepth(view.state)).toBe(0);

    host.remove();
    view.destroy();
  });

  it("B 里自己的编辑仍可正常撤销（修复不得把撤销功能一起关掉）", () => {
    const { view, host } = mount(A_DOC);
    typeAtEnd(view, "EDITED_IN_A");

    fileSwitch(view, B_DOC);
    typeAtEnd(view, "B_EDIT");
    expect(view.state.doc.textContent).toContain("B_EDIT");

    undo(view.state, view.dispatch);
    // 本次撤销只撤掉 B 自己的编辑
    expect(view.state.doc.textContent).not.toContain("B_EDIT");
    expect(view.state.doc.textContent).toContain("BBB_original");
    expect(view.state.doc.textContent).not.toContain("AAA_original");

    host.remove();
    view.destroy();
  });

  it("「切换文档」这一步自身不可撤销（addToHistory:false）", () => {
    const { view, host } = mount(A_DOC);
    fileSwitch(view, B_DOC);
    // 只做过一次换文档：撤销栈应为空 → 撤销是 no-op，doc 保持 B
    expect(undoDepth(view.state)).toBe(0);
    undo(view.state, view.dispatch);
    expect(view.state.doc.textContent).toContain("BBB_original");
    expect(view.state.doc.textContent).not.toContain("AAA_original");

    host.remove();
    view.destroy();
  });

  it("同文件内的模式切换**不得清空**撤销历史（避免「切个模式丢全部历史」回归）", () => {
    const { view, host } = mount(A_DOC);
    typeAtEnd(view, "EDITED");
    const depthBefore = undoDepth(view.state);
    expect(depthBefore).toBeGreaterThan(0);

    // 同一份 markdown 整篇重解析（等价于源码→阅读的模式切换）
    modeSwitch(view, A_DOC.replace("\n", "EDITED\n"));

    // 历史必须保留（只排除了"模式切换"这一步本身）
    expect(undoDepth(view.state)).toBeGreaterThan(0);

    host.remove();
    view.destroy();
  });

  it("撤销后重做（Ctrl+Y）同样不会跨文档", () => {
    const { view, host } = mount(A_DOC);
    typeAtEnd(view, "EDITED_IN_A");
    fileSwitch(view, B_DOC);
    typeAtEnd(view, "B_EDIT");

    undo(view.state, view.dispatch);
    expect(view.state.doc.textContent).not.toContain("B_EDIT");
    redo(view.state, view.dispatch);
    // 重做只恢复 B 自己的编辑，绝不出现 A 的内容
    expect(view.state.doc.textContent).toContain("B_EDIT");
    expect(view.state.doc.textContent).not.toContain("AAA_original");

    host.remove();
    view.destroy();
  });
});
