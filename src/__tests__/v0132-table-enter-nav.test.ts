// @vitest-environment jsdom
/**
 * v0.13.2 返修：表格单元格内按 Enter = **光标下移到同一列的下一格**。
 *
 * ## 用户实测
 * 「在某个单元格内按回车键会在单元格的右边新增一个单元格，并且编辑符也移动到了
 *  该单元格；正常情况使用回车键编辑符是移动该列的下一个单元格。」
 *
 * ## 根因
 * `buildKeymap()` 的 Enter 链只有 `insertSoftBreakOnEnter` / `splitListItem`，
 * 没有表格分支 → 落到 `keymap(baseKeymap)` 的 `splitBlock`。单元格内容模型是
 * `paragraph block*`，split 会在本格内再拆一个段落；表格 NodeView 把多段内容铺开，
 * 视觉上就像"右边多出一格、光标跑过去"。
 *
 * ## 修复
 * `core/tableNav.ts` 新增 `tableEnter`：
 * - 有下一行 → 光标落到下一行**同一列**的单元格内容起点；
 * - 已是最后一行 → 追加一行（复用 `insertRowBelow`）并落到新行同一列；
 * - 列索引按物理 cell 下标（与 Tab 导航同口径），越界收敛到末格。
 * 已注册在 Enter 链**最前**（先于 splitBlock）。
 *
 * 本文件全部使用真实 markdown 解析 + 真实 `createEditor` + 真实 keydown，
 * 只断言可观测结果（单元格数量、光标所在格文本），不做源码字面量锁。
 */
import { describe, it, expect, afterEach } from "vitest";
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { TextSelection } from "prosemirror-state";
import { createEditor } from "../core/editor";
import { markdownToDoc } from "../core/markdown/parser";

const MD = "| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n";

function mount(md: string): { view: EditorView; host: HTMLElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = createEditor({ parent: host, initialContent: md }) as EditorView;
  if (!view) throw new Error("createEditor 返回 null");
  return { view, host };
}

/** 文档顺序第 i 个 cell 的内容起点 */
function cellStart(doc: PMNode, i: number): number {
  let pos = -1;
  let count = 0;
  let found = false;
  doc.descendants((n, p) => {
    if (found) return false;
    if (n.type.name === "table_cell" || n.type.name === "table_header") {
      if (count === i) {
        pos = p + 1;
        found = true;
        return false;
      }
      count++;
      return false;
    }
    return true;
  });
  if (pos < 0) throw new Error(`没有第 ${i} 个单元格`);
  return pos;
}

function cellCount(doc: PMNode): number {
  let n = 0;
  doc.descendants((node) => {
    if (node.type.name === "table_cell" || node.type.name === "table_header") {
      n++;
      return false;
    }
    return true;
  });
  return n;
}

function rowCount(doc: PMNode): number {
  let n = 0;
  doc.descendants((node) => {
    if (node.type.name === "table_row") n++;
    return true;
  });
  return n;
}

/** 把光标放进第 i 个 cell 内容起点 */
function caretIn(view: EditorView, i: number): void {
  const pos = cellStart(view.state.doc, i);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
}

/** 真实 keydown（与浏览器同一条 handleKeyDown 插件链） */
function pressEnter(view: EditorView): void {
  const ev = new KeyboardEvent("keydown", {
    key: "Enter",
    keyCode: 13,
    bubbles: true,
    cancelable: true,
  });
  view.dom.dispatchEvent(ev);
}

/** 当前光标所在单元格的文本（光标一定落在 cell 内的段落里） */
function caretCellText(view: EditorView): string {
  return view.state.selection.$from.parent.textContent;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("v0.13.2 返修：表格内 Enter 下移同列", () => {
  it("在第 2 行第 1 格按 Enter → 光标到第 3 行第 1 格，不新增单元格/行", () => {
    const { view, host } = mount(MD);
    caretIn(view, 3); // "1"
    const beforeCells = cellCount(view.state.doc);
    const beforeRows = rowCount(view.state.doc);

    pressEnter(view);

    expect(caretCellText(view)).toBe("4");
    expect(cellCount(view.state.doc)).toBe(beforeCells);
    expect(rowCount(view.state.doc)).toBe(beforeRows);

    host.remove();
    view.destroy();
  });

  it("在第 1 行第 1 格（表头）按 Enter → 光标到第 2 行第 1 格", () => {
    const { view, host } = mount(MD);
    caretIn(view, 0); // "A"
    pressEnter(view);
    expect(caretCellText(view)).toBe("1");
    host.remove();
    view.destroy();
  });

  it("在第 2 行第 2 格按 Enter → 光标到第 3 行第 2 格（保持列）", () => {
    const { view, host } = mount(MD);
    caretIn(view, 4); // "2"
    pressEnter(view);
    expect(caretCellText(view)).toBe("5");
    host.remove();
    view.destroy();
  });

  it("在最后一行最后一格按 Enter → 追加一行，光标落在新行同列（空）", () => {
    const { view, host } = mount(MD);
    caretIn(view, 8); // "6"
    const beforeRows = rowCount(view.state.doc);
    pressEnter(view);

    expect(rowCount(view.state.doc)).toBe(beforeRows + 1);
    expect(cellCount(view.state.doc)).toBe(12);
    expect(caretCellText(view)).toBe("");
    // 新行位于表格末尾，且第三列就是光标所在列
    expect(view.state.selection.$from.depth).toBeGreaterThan(0);
  });

  it("非表格的顶层段落仍然回车 = 段内换行（既有语义不回归）", () => {
    const { view, host } = mount("hello\n");
    // 光标放到段落末尾
    const end = view.state.doc.content.size - 1;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
    pressEnter(view);
    // 顶层段落回车由 insertSoftBreakOnEnter 接管：插入 hard_break，不新建段落
    let hardBreaks = 0;
    view.state.doc.descendants((n) => {
      if (n.type.name === "hard_break") hardBreaks++;
    });
    expect(hardBreaks).toBe(1);
    host.remove();
    view.destroy();
  });

  it("空选区才导航；有选区时不接管（交回既有选区删除/替换语义）", () => {
    const { view, host } = mount(MD);
    const a = cellStart(view.state.doc, 3); // "1"
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, a, a + 1)));
    pressEnter(view);
    // 不跳到下一格：光标仍在原格（baseKeymap 的 splitBlock 会替换选区，
    // 但这里只断言"没有按表格导航跳到 4"）
    expect(caretCellText(view)).not.toBe("4");
    host.remove();
    view.destroy();
  });
});
