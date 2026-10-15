/**
 * v0.13.0 返修第二轮（审计发现）：需求 4–12 的遗留缺陷回归测试。
 *
 * 背景：第一轮修掉了用户实机报的 8 个问题，但那些缺陷的**同类问题**在 v0.13.0
 * 的其他需求里依然存在（尤其是"纯函数单测全绿、真实链路不可用"这一模式）。
 * 本文件覆盖第二轮审计确认的缺陷，全部为**行为级**断言：
 *
 * BLOCKER 1  表格合并的坐标换算：`posAtDOM(cellEl,0)` 返回的是 cell 内部位置
 *            （= cell 起点 + 1），旧实现直接与 cell 起点比较 → **每个单元格都
 *            返回 null** → rangeAnchor/cellRange 永不设置 → 合并按钮永久禁用，
 *            即"合并"在 UI 上完全无路径。本文件用**真实 EditorView + 真实 DOM 事件**
 *            验证拖拽跨格能真的高亮出范围。
 * BLOCKER 2  表头含合并格时，序列化出的表头物理格数 < 分隔行列数，
 *            markdown-it 硬性要求两者相等 → 整张表回读变成**一个段落**（全表丢失）。
 * HIGH       `Ctrl+/` 注释往返会永久残留反斜杠 / 注释被提前闭合；
 *            源码模式取消注释会吃字符甚至清空；
 *            图片对齐在预览与导出中完全丢失；alt 含竖线时宽度/对齐被破坏。
 * MEDIUM     DOCX/LaTeX 在合并格含行内格式时**泄漏字面 `<td>` 标签**；
 *            emoji 补全在时间/比例上误触发，且会把前一个行内原子节点内容改写。
 * LOW        有序列表标记忽略起始序号；大纲折叠在"折叠节点自身被隐藏"时提前失效。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import { lightMDSchema as schema } from "../core/schema";
import { cellPositionsOfGrid, buildTableGridFromTable } from "../core/tableGrid";
import { mergeCells } from "../core/tableMerge";
import { createEditor } from "../core/editor";
import { getRenderMarkdownIt } from "../core/renderPipeline";
import { parseMarkdownToBlocksDetailed } from "../utils/exportBlocks";
import { wrapSourceComment } from "../components/editor/sourceFormat";
import { detectEmojiState } from "../core/plugins/emoji-complete";
import { orderedListMarker } from "../utils/blockMarkers";
import { planRename } from "../utils/imageManager";
import { computeOutlineVisibility, type OutlineNode } from "../utils/outlineCollapse";
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";

const PLAIN_TABLE = "| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n";

function stateOf(md: string): EditorState {
  return EditorState.create({ doc: markdownToDoc(md), schema });
}

/** 真实挂载编辑器，并给每个单元格桩上互不重叠的矩形（jsdom 默认全 0 会落进缩放手势热区） */
function mountTable(md: string): { view: EditorView; host: HTMLElement; cells: HTMLElement[] } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = createEditor({ parent: host, initialContent: md }) as EditorView;
  const table = host.querySelector("td, th")?.closest("table") as HTMLElement | null;
  const cells = Array.from((table ?? host).querySelectorAll("td, th")) as HTMLElement[];
  const cols = 3;
  cells.forEach((el, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    el.getBoundingClientRect = () =>
      ({
        left: col * 100,
        right: col * 100 + 100,
        top: row * 30,
        bottom: row * 30 + 30,
        width: 100,
        height: 30,
        x: col * 100,
        y: row * 30,
        toJSON: () => ({}),
      }) as DOMRect;
  });
  return { view, host, cells };
}

function mouse(type: string, x: number, y: number, buttons = 0): MouseEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons, clientX: x, clientY: y });
}

beforeEach(() => {
  document.body.innerHTML = "";
  // jsdom 未实现 `document.elementFromPoint`，而 ProseMirror 的 `posAtCoords`
  // 会调用它 → 抛未处理异常（测试虽通过，但 vitest 会因此报错并以退出码 1 结束，
  // 还提示"可能造成假阳性"）。桩成返回 body 即可：本文件断言的是
  // `posAtDOM`（cellCoordOf）与 DOM class，不依赖 posAtCoords 的几何结果。
  (document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }).elementFromPoint =
    () => document.body;
});

afterEach(() => {
  document.body.innerHTML = "";
});

// ═════════ BLOCKER 1：合并的坐标换算 ═════════

describe("BLOCKER 1：表格 cell 位置 → 网格坐标", () => {
  it("cellPositionsOfGrid 覆盖每个单元格且坐标正确（普通表）", () => {
    const doc = markdownToDoc(PLAIN_TABLE);
    const table = doc.child(0);
    const map = cellPositionsOfGrid(table, 0);
    // 2 行 × 3 列 = 6 个主格
    expect(map.size).toBe(6);
    const coords = [...map.values()].map((c) => `${c.rowIdx},${c.colIdx}`).sort();
    expect(coords).toEqual(["0,0", "0,1", "0,2", "1,0", "1,1", "1,2"]);
  });

  it("含合并格时坐标按**逻辑列**而非物理下标（旧实现会错位）", () => {
    // 第 1 行前两格合并 → 该行物理上只有 2 个 cell，第 2 个的逻辑列是 2
    const md = '| A | B | C |\n| --- | --- | --- |\n| <td colspan="2">X</td> | 3 |\n';
    const doc = markdownToDoc(md);
    const map = cellPositionsOfGrid(doc.child(0), 0);
    const coords = [...map.values()].map((c) => `${c.rowIdx},${c.colIdx}`).sort();
    // 表头 3 格（0,0 / 0,1 / 0,2）+ 数据行 2 格（1,0 跨 2 列、1,2）
    expect(coords).toEqual(["0,0", "0,1", "0,2", "1,0", "1,2"]);
    // 合并格必须是 colspan=2 的主格
    const merged = [...map.values()].find((c) => c.rowIdx === 1 && c.colIdx === 0)!;
    const pos = [...map.entries()].find(([, c]) => c === merged)![0];
    expect(doc.nodeAt(pos)!.attrs.colspan).toBe(2);
  });

  it("真实编辑器：拖拽跨两格 → 两格都被高亮（合并按钮才能启用）", () => {
    const { cells } = mountTable(PLAIN_TABLE);
    expect(cells.length).toBeGreaterThanOrEqual(2);
    const [c0, c1] = cells;
    // 在 (0,0) 中部按下 → 起点锚定
    c0.dispatchEvent(mouse("mousedown", 50, 15, 1));
    // 拖到 (0,1) 中部
    c1.dispatchEvent(mouse("mousemove", 150, 15, 1));
    // 这是 cellCoordOf 修复的**直接可观测结果**：旧实现返回 null →
    // 永不 applyRangeHighlight → 两格都不会有 pm-cell-in-range
    expect(c0.classList.contains("pm-cell-in-range")).toBe(true);
    expect(c1.classList.contains("pm-cell-in-range")).toBe(true);
  });

  it("真实编辑器：单击单格不应把整张表全部高亮（问题1 的回归锁）", () => {
    const { cells } = mountTable(PLAIN_TABLE);
    const [c0] = cells;
    c0.dispatchEvent(mouse("mousedown", 50, 15, 1));
    c0.dispatchEvent(mouse("mouseup", 50, 15, 0));
    const highlighted = cells.filter((c) => c.classList.contains("pm-cell-in-range"));
    expect(highlighted.length).toBe(0);
  });
});

// ═════════ BLOCKER 2：表头合并格的序列化 ═════════

describe("BLOCKER 2：表头含合并格时序列化不得丢整张表", () => {
  it("合并表头两格 → 回读仍是 table（旧实现变成一个段落，全表丢失）", () => {
    const st = stateOf(PLAIN_TABLE);
    const tr = mergeCells(st.tr, 0, st.doc.child(0) as PMNode, { r0: 0, c0: 0, r1: 0, c1: 1 });
    expect(tr).not.toBeNull();
    const md = docToMarkdown(st.apply(tr!).doc);
    const back = markdownToDoc(md);
    expect(back.child(0).type.name).toBe("table");
    // 内容不丢：合并格保留左上内容 + 其余格
    expect(back.textContent).toBe("AC123");
  });

  it("表头行物理格数必须等于分隔行列数（markdown-it 硬性要求）", () => {
    const st = stateOf(PLAIN_TABLE);
    const tr = mergeCells(st.tr, 0, st.doc.child(0) as PMNode, { r0: 0, c0: 0, r1: 0, c1: 1 })!;
    const md = docToMarkdown(st.apply(tr).doc);
    const lines = md.trim().split("\n");
    const countCells = (l: string) => l.split("|").slice(1, -1).length;
    expect(countCells(lines[0])).toBe(countCells(lines[1]));
  });

  it("二次序列化稳定（补位不能逐次膨胀列数）", () => {
    const st = stateOf(PLAIN_TABLE);
    const tr = mergeCells(st.tr, 0, st.doc.child(0) as PMNode, { r0: 0, c0: 0, r1: 0, c1: 1 })!;
    const a = docToMarkdown(st.apply(tr).doc);
    const b = docToMarkdown(markdownToDoc(a));
    expect(b).toBe(a);
  });

  it("数据行合并的往返不受影响（既有能力回归锁）", () => {
    const st = stateOf(PLAIN_TABLE);
    const tr = mergeCells(st.tr, 0, st.doc.child(0) as PMNode, { r0: 1, c0: 0, r1: 1, c1: 1 })!;
    const md = docToMarkdown(st.apply(tr).doc);
    expect(md).toContain('<td colspan="2">1</td>');
    expect(markdownToDoc(md).child(0).type.name).toBe("table");
  });

  it("无合并的普通表格仍逐字节零 diff（最重要的回归锁）", () => {
    expect(docToMarkdown(markdownToDoc(PLAIN_TABLE))).toBe(PLAIN_TABLE);
  });
});

// ═════════ HIGH：注释 / 图片 ═════════

describe("HIGH：Ctrl+/ 注释往返不得改写文本", () => {
  function commentRoundTrip(text: string) {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text(text, [schema.marks.comment.create()])]),
    ]);
    const md = docToMarkdown(doc);
    const back = markdownToDoc(md);
    return {
      md,
      text: back.textContent,
      marked: back.child(0).child(0)?.marks.some((m) => m.type.name === "comment") ?? false,
    };
  }

  it("含 markdown 元字符的注释体无损往返（旧实现永久残留反斜杠）", () => {
    for (const s of ["a**b", "x`y`z", "价格 $100", "中文 注释"]) {
      const r = commentRoundTrip(s);
      expect(r.marked).toBe(true);
      expect(r.text).toBe(s);
    }
  });

  it("含 `--` / `-->` / 结尾 `-` 的注释体仍是一个完整注释（旧实现会被提前闭合）", () => {
    for (const s of ["a--b", "a-->b", "a-", "a--->"]) {
      const r = commentRoundTrip(s);
      expect(r.marked).toBe(true);
      expect(r.text).toBe(s);
    }
  });

  it("源码模式：短注释取消后内容不丢（旧实现把 <!--ab--> 变成空串）", () => {
    expect(wrapSourceComment("<!--ab-->").replacement).toBe("ab");
    expect(wrapSourceComment("<!--abc-->").replacement).toBe("abc");
    expect(wrapSourceComment("<!--TODO-->").replacement).toBe("TODO");
    expect(wrapSourceComment("<!--a-->").replacement).toBe("a");
  });

  it("源码模式：包裹 → 取消 回到原文", () => {
    for (const orig of ["a", "TODO", "ab", "需要复核"]) {
      const wrapped = wrapSourceComment(orig).replacement;
      expect(wrapSourceComment(wrapped).replacement).toBe(orig);
    }
  });

  it("源码模式：未注释的普通行仍然被包裹（不能误判）", () => {
    expect(wrapSourceComment("普通文本").replacement).toBe("<!-- 普通文本 -->");
    expect(wrapSourceComment("<!--a--> b-->").replacement).toBe("<!-- <!--a--> b--> -->");
  });
});

describe("HIGH：图片对齐必须在预览/导出中生效", () => {
  it("对齐后缀渲染出与编辑器同源的样式", () => {
    const md = getRenderMarkdownIt(false);
    const center = md.render("![alt|center](a.png)");
    expect(center).toContain('style="display:block;margin-left:auto;margin-right:auto"');
    expect(center).toContain('data-align="center"');
    const right = md.render("![alt|right](a.png)");
    expect(right).toContain('style="display:block;margin-left:auto"');
    expect(right).not.toContain("margin-right:auto");
  });

  it("宽度 + 对齐同时生效，且 alt 不被污染", () => {
    const html = getRenderMarkdownIt(false).render("![alt|300|center](a.png)");
    expect(html).toContain('alt="alt"');
    expect(html).toContain('width="300"');
    expect(html).toContain("margin-left:auto");
  });

  it("无后缀图片的输出完全不变（零回归）", () => {
    expect(getRenderMarkdownIt(false).render("![alt](a.png)").trim()).toBe(
      '<p><img src="a.png" alt="alt" /></p>',
    );
  });

  it("alt 含竖线时宽度/对齐不丢、也不凭空造出宽度", () => {
    const cases: Array<[string, number | null, string]> = [
      ["a|b", 300, "left"],
      ["a|b", null, "center"],
      ["a|1", null, "left"],
      ["表格 | 图", null, "center"],
    ];
    for (const [alt, width, align] of cases) {
      const doc = schema.node("doc", null, [
        schema.node("paragraph", null, [
          schema.nodes.image.create({ src: "x.png", alt, width, align }),
        ]),
      ]);
      const img = markdownToDoc(docToMarkdown(doc)).child(0).child(0);
      expect(img.attrs.alt).toBe(alt);
      expect(img.attrs.width).toBe(width);
      expect(img.attrs.align).toBe(align);
    }
  });
});

// ═════════ MEDIUM：导出降级 / emoji ═════════

describe("MEDIUM：DOCX/LaTeX 遇合并格含行内格式不得泄漏裸标签", () => {
  function runTexts(md: string): string[] {
    const { blocks } = parseMarkdownToBlocksDetailed(md);
    const table = blocks.find((b) => b.kind === "table");
    if (!table || table.kind !== "table") return [];
    return table.rows.flat().flat().map((r) => r.text);
  }

  it("纯文本合并格（既有行为）", () => {
    const md = '| A | B |\n| --- | --- |\n| <td colspan="2">M</td> |\n';
    const texts = runTexts(md);
    expect(texts.some((t) => t.includes("M"))).toBe(true);
    for (const t of texts) expect(t).not.toContain("<td");
  });

  it("含粗体 / 链接 / 行内代码的合并格：不出现 `</td>` / `<td` 字面量", () => {
    for (const cell of ['<td colspan="2">**M**</td>', '<td colspan="2">[x](y.md)</td>', '<td colspan="2">`c`</td>']) {
      const md = `| A | B | C |\n| --- | --- | --- |\n| ${cell} | 3 |\n`;
      const texts = runTexts(md);
      for (const t of texts) {
        expect(t).not.toContain("<td");
        expect(t).not.toContain("</td>");
      }
      // 内容仍然保留
      expect(texts.join("")).toMatch(/[Mcx]/);
    }
  });
});

describe("MEDIUM：emoji 补全的触发条件与位置换算", () => {
  function atEnd(s: string): EditorState {
    const st = EditorState.create({ doc: markdownToDoc(s + "\n"), schema });
    const end = st.doc.content.size;
    return st.apply(st.tr.setSelection(TextSelection.create(st.doc, end - 1)));
  }

  it("时间 / 比例不再误触发（旧实现会弹出 emoji 菜单）", () => {
    for (const s of ["3:1", "ratio 2:3", "12:30", "John 3:16", "时间 10:00"]) {
      expect(detectEmojiState(atEnd(s))).toBeNull();
    }
  });

  it("真实短码仍然触发（含数字开头的短码）", () => {
    expect(detectEmojiState(atEnd(":sm"))?.query).toBe("sm");
    expect(detectEmojiState(atEnd("行首 :sm"))?.query).toBe("sm");
    expect(detectEmojiState(atEnd(":100"))?.query).toBe("100");
  });

  it("`::` 不触发", () => {
    expect(detectEmojiState(atEnd("::"))).toBeNull();
  });

  it("行内原子节点之后的 from 位置正确（旧实现会把公式内容吃掉）", () => {
    const st = atEnd("$x^2$ :sm");
    const r = detectEmojiState(st);
    expect(r).not.toBeNull();
    expect(r!.query).toBe("sm");
    const after = st.apply(st.tr.replaceWith(r!.from, r!.to, schema.text(":smile:")));
    // 关键：公式节点仍在，短码范围精确替换
    expect(after.doc.textContent).toBe("x^2 :smile:");
    expect(after.doc.child(0).child(0).type.name).toBe("math_inline");
    expect(after.doc.child(0).child(0).textContent).toBe("x^2");
  });
});

// ═════════ LOW ═════════

describe("LOW：有序列表标记带起始序号", () => {
  it("`3.` 开头的列表显示 3/4 而非 1/2", () => {
    expect(orderedListMarker(1, { order: 3, delim: "dot" })).toBe("3. ");
    expect(orderedListMarker(2, { order: 3, delim: "dot" })).toBe("4. ");
  });
  it("默认（order=1 / 缺省）不变", () => {
    expect(orderedListMarker(1, {})).toBe("1. ");
    expect(orderedListMarker(2, { order: 1 })).toBe("2. ");
    // schema 的 delim 取值是 ")"（不是 "paren"）
    expect(orderedListMarker(1, { order: 3, delim: ")" })).toBe("3) ");
  });
});

describe("LOW：图片重命名的目标冲突", () => {
  it("改成文档内已存在的名字 → 拒绝（否则批量重命名中途失败）", () => {
    expect(planRename("./assets/a.png", "b.png", ["a.png", "b.png"])).toBeNull();
    // 大小写不敏感
    expect(planRename("./assets/a.png", "B.PNG", ["b.png"])).toBeNull();
  });

  it("改成自己的名字 → 拒绝（无意义的重命名）", () => {
    expect(planRename("./assets/a.png", "a.png", ["a.png"])).toBeNull();
  });

  it("不冲突时照常产出，且保留目录前缀", () => {
    expect(planRename("./assets/a.png", "c.png", ["a.png", "b.png"])).toEqual({
      oldSrc: "./assets/a.png",
      newSrc: "./assets/c.png",
      fileName: "c.png",
    });
    // 不传 existingNames 时保持旧行为
    expect(planRename("a.png", "b.png")?.newSrc).toBe("b.png");
  });
});

describe("LOW：大纲折叠的多层嵌套", () => {  const nodes: OutlineNode[] = [
    { pos: 0, level: 1 },
    { pos: 10, level: 3 },
    { pos: 20, level: 2 },
    { pos: 30, level: 1 },
  ];

  it("被折叠节点自身落在外层折叠区间内时，外层折叠不得提前失效", () => {
    const v = computeOutlineVisibility(nodes, new Set([0, 10]));
    expect(v.get(0)).toBe(true);
    expect(v.get(10)).toBe(false);
    // 旧实现把这里判为可见（H1@0 明明还折叠着）
    expect(v.get(20)).toBe(false);
    expect(v.get(30)).toBe(true);
  });

  it("单层折叠 / 两层同级折叠的既有语义不变", () => {
    expect(computeOutlineVisibility(nodes, new Set([0])).get(20)).toBe(false);
    expect(computeOutlineVisibility(nodes, new Set([10])).get(20)).toBe(true);
    expect(computeOutlineVisibility(nodes, new Set([10])).get(0)).toBe(true);
  });
});
