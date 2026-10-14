/**
 * v0.13.0 需求7：块级标记显示补全（列表/任务/hr/math/toc）。
 *
 * 覆盖：
 * - 纯函数 `computeBlockMarker` / `orderedListMarker` / `bulletListMarker` /
 *   `taskListMarker` / `computeListItemOrdinal` / `listDelimiter` 的真值表；
 * - `MARKABLE_TYPES` 集合覆盖与「表格/图片明确不做」；
 * - 真实 `createEditor` 挂载：光标进入各类块时 DOM 上出现
 *   `.pm-block-marker` + `data-md-block-open`，移出后消失；
 * - **零位移回归**：标记是绝对定位伪元素，光标进出不改变文本几何。
 */
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { TextSelection, NodeSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { createEditor } from "../core/editor";
import {
  computeBlockMarker,
  orderedListMarker,
  bulletListMarker,
  taskListMarker,
  computeListItemOrdinal,
  listDelimiter,
  isMarkableType,
  MARKABLE_TYPES,
  type BlockMarkerInput,
} from "../utils/blockMarkers";

function mount(md: string): EditorView {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return createEditor({ parent: host, initialContent: md }) as EditorView;
}

/** 把光标放到 doc 的某个位置，返回当前 .pm-block-marker 的 data-md-block-open */
function markerAt(view: EditorView, pos: number): string | null {
  const doc = view.state.doc;
  const safe = Math.max(0, Math.min(pos, doc.content.size));
  view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, safe)));
  const el = view.dom.querySelector(".pm-block-marker");
  return el?.getAttribute("data-md-block-open") ?? null;
}

/** 用 NodeSelection 选中某个节点（叶子节点如 hr/toc 无文本位置，必须这样） */
function markerAtNode(view: EditorView, pos: number): string | null {
  const doc = view.state.doc;
  const node = doc.nodeAt(pos);
  if (!node) return null;
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(doc, pos)));
  const el = view.dom.querySelector(".pm-block-marker");
  return el?.getAttribute("data-md-block-open") ?? null;
}

/** 找某类型第一个节点的位置 */
function firstPosOf(view: EditorView, type: string): number {
  let found = -1;
  view.state.doc.descendants((node, pos) => {
    if (found === -1 && node.type.name === type) found = pos;
    return found === -1;
  });
  return found;
}

// ───────── 纯函数真值表 ─────────

describe("computeBlockMarker 真值表", () => {
  const base: Omit<BlockMarkerInput, "type" | "attrs"> = {};

  it("blockquote → '> '", () => {
    expect(computeBlockMarker({ ...base, type: "blockquote", attrs: {} })?.marker).toBe("> ");
  });

  it("code_block → ``` + language", () => {
    expect(computeBlockMarker({ ...base, type: "code_block", attrs: { language: "js" } })?.marker)
      .toBe("```js");
    expect(computeBlockMarker({ ...base, type: "code_block", attrs: { language: "" } })?.marker)
      .toBe("```");
  });

  it("mermaid_block → ```mermaid", () => {
    expect(
      computeBlockMarker({ ...base, type: "mermaid_block", attrs: { language: "mermaid" } })?.marker,
    ).toBe("```mermaid");
  });

  it("horizontal_rule → ---", () => {
    expect(computeBlockMarker({ ...base, type: "horizontal_rule", attrs: {} })?.marker).toBe("---");
  });

  it("math_block → $$", () => {
    expect(
      computeBlockMarker({ ...base, type: "math_block", attrs: { latex: "x^2" } })?.marker,
    ).toBe("$$");
  });

  it("toc → [toc]", () => {
    expect(computeBlockMarker({ ...base, type: "toc", attrs: { headings: "[]" } })?.marker).toBe(
      "[toc]",
    );
  });

  it("bullet_list → '- '", () => {
    expect(computeBlockMarker({ ...base, type: "bullet_list", attrs: {} })?.marker).toBe("- ");
  });

  it("ordered_list → 按序号 + delim", () => {
    expect(computeBlockMarker({ ...base, type: "ordered_list", attrs: { delim: "." }, ordinal: 3 })?.marker)
      .toBe("3. ");
    expect(computeBlockMarker({ ...base, type: "ordered_list", attrs: { delim: ")" }, ordinal: 12 })?.marker)
      .toBe("12) ");
  });

  it("task_list → 按 checked", () => {
    expect(computeBlockMarker({ ...base, type: "task_list", attrs: { checked: false } })?.marker)
      .toBe("- [ ] ");
    expect(computeBlockMarker({ ...base, type: "task_list", attrs: { checked: true } })?.marker)
      .toBe("- [x] ");
  });

  it("表格/图片/段落 → null（明确不做/无需标记）", () => {
    for (const t of ["table", "image", "paragraph", "heading", "text", "blockquote_x"]) {
      expect(computeBlockMarker({ ...base, type: t, attrs: {} })).toBeNull();
    }
  });

  it("所有结果都带 needsPositioning（CSS 依赖 position:relative）", () => {
    for (const t of ["blockquote", "code_block", "horizontal_rule", "math_block", "toc"]) {
      expect(computeBlockMarker({ ...base, type: t, attrs: {} })?.needsPositioning).toBe(true);
    }
  });
});

describe("列表 marker 工具函数", () => {
  it("orderedListMarker：序号 + 分隔符", () => {
    expect(orderedListMarker(1, { delim: "." })).toBe("1. ");
    expect(orderedListMarker(7, { delim: ")" })).toBe("7) ");
  });

  it("orderedListMarker：非法序号回落 1", () => {
    expect(orderedListMarker(0, {})).toBe("1. ");
    expect(orderedListMarker(-5, {})).toBe("1. ");
    expect(orderedListMarker(Number.NaN, {})).toBe("1. ");
  });

  it("listDelimiter：只认 ')'，其余回落 '.'", () => {
    expect(listDelimiter({ delim: ")" })).toBe(")");
    expect(listDelimiter({ delim: "." })).toBe(".");
    expect(listDelimiter({ delim: "x" })).toBe(".");
    expect(listDelimiter({})).toBe(".");
  });

  it("bulletListMarker 固定 '- '", () => {
    expect(bulletListMarker()).toBe("- ");
  });

  it("taskListMarker：checked 只有 true 才打勾", () => {
    expect(taskListMarker({ checked: true })).toBe("- [x] ");
    expect(taskListMarker({ checked: false })).toBe("- [ ] ");
    expect(taskListMarker({})).toBe("- [ ] ");
    expect(taskListMarker({ checked: "yes" })).toBe("- [ ] ");
  });

  it("computeListItemOrdinal：按同级项计数", () => {
    // 假的父节点：两个 list_item（offset 0 与 10）
    const parent = {
      forEach(cb: (node: { type: { name: string } }, offset: number) => void) {
        cb({ type: { name: "list_item" } }, 0);
        cb({ type: { name: "list_item" } }, 10);
        cb({ type: { name: "list_item" } }, 20);
      },
    };
    expect(computeListItemOrdinal(parent, 0)).toBe(1);
    expect(computeListItemOrdinal(parent, 10)).toBe(2);
    expect(computeListItemOrdinal(parent, 20)).toBe(3);
  });

  it("computeListItemOrdinal：null 父节点 / 越界 offset → 1", () => {
    expect(computeListItemOrdinal(null, 5)).toBe(1);
    expect(computeListItemOrdinal(undefined, 5)).toBe(1);
    const parent = {
      forEach(cb: (node: { type: { name: string } }, offset: number) => void) {
        cb({ type: { name: "list_item" } }, 0);
      },
    };
    expect(computeListItemOrdinal(parent, 99)).toBe(2); // 前面有 1 项
  });
});

describe("MARKABLE_TYPES 集合", () => {
  it("覆盖本版新增 5 类 + 既有 3 类", () => {
    for (const t of [
      "heading",
      "blockquote",
      "code_block",
      "mermaid_block",
      "bullet_list",
      "ordered_list",
      "list_item",
      "task_list",
      "task_item",
      "horizontal_rule",
      "math_block",
      "toc",
    ]) {
      expect(MARKABLE_TYPES).toContain(t);
      expect(isMarkableType(t)).toBe(true);
    }
  });

  it("表格 / 图片明确不做", () => {
    expect(isMarkableType("table")).toBe(false);
    expect(isMarkableType("image")).toBe(false);
  });
});

// ───────── 真实编辑器链路 ─────────

describe("真实编辑器：光标进入各类块时显示源码标记", () => {
  it("无序列表 → '- '", () => {
    const view = mount("- 甲\n- 乙\n");
    const pos = firstPosOf(view, "bullet_list");
    expect(markerAt(view, pos + 2)).toBe("- ");
  });

  it("有序列表第 2 项 → '2. '（按实际序号）", () => {
    const view = mount("1. 甲\n2. 乙\n3. 丙\n");
    const pos = firstPosOf(view, "ordered_list");
    // list_item 位置：列表起点 + 1（第一个 item），第二项在第一个 item 之后
    const items: number[] = [];
    view.state.doc.descendants((node, p) => {
      if (node.type.name === "list_item") items.push(p);
      return true;
    });
    expect(items.length).toBe(3);
    expect(markerAt(view, items[1] + 1)).toBe("2. ");
  });

  it("有序列表 delim=')' → '1) '", () => {
    const view = mount("1) 甲\n2) 乙\n");
    const pos = firstPosOf(view, "ordered_list");
    expect(markerAt(view, pos + 2)).toBe("1) ");
  });

  it("任务列表未勾选 → '- [ ] '；勾选 → '- [x] '", () => {
    const view = mount("- [ ] 未做\n- [x] 已做\n");
    const items: number[] = [];
    view.state.doc.descendants((node, p) => {
      if (node.type.name === "task_item") items.push(p);
      return true;
    });
    expect(markerAt(view, items[0] + 1)).toBe("- [ ] ");
    expect(markerAt(view, items[1] + 1)).toBe("- [x] ");
  });

  it("水平线 → '---'", () => {
    const view = mount("段落\n\n---\n\n段落二\n");
    const pos = firstPosOf(view, "horizontal_rule");
    // hr 是叶子节点（无内容可放光标），只能用 NodeSelection 选中它
    expect(markerAtNode(view, pos)).toBe("---");
  });

  it("块级公式 → '$$'", () => {
    const view = mount("$$\nx^2\n$$\n");
    const pos = firstPosOf(view, "math_block");
    expect(markerAt(view, pos + 2)).toBe("$$");
  });

  it("[toc] → '[toc]'", () => {
    const view = mount("[toc]\n\n# 标题\n");
    const pos = firstPosOf(view, "toc");
    expect(markerAtNode(view, pos)).toBe("[toc]");
  });

  it("Mermaid 图 → '```mermaid'", () => {
    const view = mount("```mermaid\ngraph TD\n  A-->B\n```\n");
    const pos = firstPosOf(view, "mermaid_block");
    expect(markerAt(view, pos + 2)).toBe("```mermaid");
  });

  it("代码块 → ```js（既有行为不回归）", () => {
    const view = mount("```js\nconst a = 1;\n```\n");
    const pos = firstPosOf(view, "code_block");
    expect(markerAt(view, pos + 2)).toBe("```js");
  });

  it("引用块 → '> '（既有行为不回归）", () => {
    const view = mount("> 引用内容\n");
    const pos = firstPosOf(view, "blockquote");
    expect(markerAt(view, pos + 2)).toBe("> ");
  });

  it("光标移出块 → 标记消失（不残留）", () => {
    const view = mount("- 列表项\n\n普通段落\n");
    const listPos = firstPosOf(view, "bullet_list");
    expect(markerAt(view, listPos + 2)).toBe("- ");
    // 移到普通段落（文档末尾附近）
    const end = view.state.doc.content.size - 2;
    const after = markerAt(view, end);
    // 段落不作为标记终点（继续向外层找不到可标记块）→ null
    expect(after).toBeNull();
  });

  it("引用块内嵌列表：光标在列表项里时显示列表 marker（不再是 '> '）", () => {
    const view = mount("> - 甲\n> - 乙\n");
    const items: number[] = [];
    view.state.doc.descendants((node, p) => {
      if (node.type.name === "list_item") items.push(p);
      return true;
    });
    // 最近的可标记块是 list_item（在内层），不是 blockquote
    expect(markerAt(view, items[0] + 1)).toBe("- ");
  });
});

describe("零位移回归（v0.12.0 需求3 的几何保证不被破坏）", () => {
  it("标记用 CSS ::before 绝对定位（源码里 className/data 属性，非插入真实元素）", () => {
    const view = mount("- 列表项\n");
    const pos = firstPosOf(view, "bullet_list");
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 2)));
    const li = view.dom.querySelector("li");
    expect(li).not.toBeNull();
    // data-md-block-open 落在 li 上（CSS ::before 以 attr() 取它渲染标记）
    expect(li!.getAttribute("data-md-block-open")).toBe("- ");
    // 没有插入任何「标记专用」真实元素（伪元素不进 DOM）
    expect(li!.querySelector(".md-marker, .marker-reveal, [data-marker]")).toBeNull();
    // li 的子节点只有 PM 管理的内容（段落/文本），没有额外包裹层
    const childTags = Array.from(li!.children).map((c) => c.tagName);
    expect(childTags).not.toContain("SPAN");
  });

  it("标题仍走徽标 widget（不是 pm-block-marker 文本）", () => {
    const view = mount("# 标题\n");
    const pos = firstPosOf(view, "heading");
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 2)));
    expect(view.dom.querySelector(".pm-heading-badge")).not.toBeNull();
  });
});
