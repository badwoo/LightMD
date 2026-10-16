/**
 * v0.13.0 返修第三轮：表格选区 / 合并 / 右键菜单（用户实机反馈 ⑤⑥⑦）。
 *
 * ## 本文件为什么必须存在
 *
 * 上一轮已有 `v0130-fix-round2.test.ts` 覆盖"拖拽跨格能高亮"，但它在 jsdom 里
 * **直接给 cell 派发 mousedown/mousemove**，且几何被桩成互不重叠 —— 恰好绕开了
 * 真实鼠标手势的两个致命路径，因此实机上 ⑤⑦ 仍然完全不可用：
 *
 * ① **边缘热区吞掉起手点**（⑤⑦ 的真根因）：`onMouseDown` 与 `onRangeMouseDown`
 *    各自独立判定 cell 边缘热区，而前者先注册先执行 → 落在列宽热区 8px /
 *    行高热区 6px 内的按下都变成缩放拖拽。窄单元格下热区占 **40% 宽度**，
 *    行热区占 **20% 高度**，用户拖拽起手点极易落进去 → `rangeAnchor` 永不设置 →
 *    `cellRange` 永不赋值 → 合并按钮永久禁用。
 * ② **工具栏被裁掉**（⑤ 的可见症状）：工具栏定位在表格**上方**，
 *    表格贴近容器顶部时 `top` 为负，被祖先 overflow 裁掉 → 用户点不到合并按钮。
 * ③ **两个右键菜单**（⑥）：表格 NodeView 在自己的 dom 上弹表格菜单，
 *    EditorContainer 同时在祖先容器上弹行内格式菜单 → 两个菜单叠加互相遮挡。
 * ④ **合并后 DOM 不渲染跨度**（⑤ 的另一半真根因）：`mergeCells` 事务本身是生效的
 *    （doc 拿到 colspan、源码也正确序列化 `<th colspan="2">A</th>`），但 td/th 挂上
 *    `TableCellView` 后 DOM **完全由该 NodeView 创建**，PM 不再调用 schema.toDOM
 *    → `colspan`/`rowspan` 从未写进 DOM。浏览器按普通格排版：被吞掉的第二列宽度
 *    留在原位、内容凭空消失，用户看到的就是「点了合并没反应 / 合并错了」。
 *    实测（真实 Chrome）：doc `<th colspan="2">A</th>` ↔ DOM `<th>A</th><th>C</th>`。
 *    因此本文件除了断言 doc，还**必须**断言 DOM 属性 —— 否则这类"事务对了、
 *    界面没变"的缺陷会继续从测试网里漏过去。
 *
 * 本文件用**真实编辑器 + 真实手势序列**（含起手点落在热区内）锁定修复，
 * 并覆盖合并结果的往返保真（避免"合并后保存整表变段落"的历史坑）。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { EditorState, TextSelection } from "prosemirror-state";
import { createEditor } from "../core/editor";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import {
  buildContextMenuItems,
  toggleMarkOp,
  hitResizeZoneForTest,
} from "../core/plugins/table-editor";
import { mergeCells, checkMergeable } from "../core/tableMerge";
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";

const SRC = (p: string) => readFileSync(`src/${p}`, "utf-8");

const MD3 = "| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n";

/** 真实编辑器 + 每格互不重叠的几何（100×30，与 round2 同口径） */
function mountTable(md = MD3): { view: EditorView; host: HTMLElement; cells: HTMLElement[] } {
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

/** 派发一次鼠标事件（bubbles + 可取消，带按键与坐标） */
function mouseOn(
  el: Element,
  type: string,
  x: number,
  y: number,
  buttons = 0,
): MouseEvent {
  const e = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons,
    clientX: x,
    clientY: y,
  });
  el.dispatchEvent(e);
  return e;
}

/** 拖拽序列：在 a 上按下 → 在 b 上移动 → 在 b 上松开 */
function drag(a: Element, b: Element, from: [number, number], to: [number, number]): void {
  mouseOn(a, "mousedown", from[0], from[1], 1);
  mouseOn(b, "mousemove", to[0], to[1], 1);
  mouseOn(b, "mouseup", to[0], to[1], 0);
}

function highlighted(cells: HTMLElement[]): string {
  return cells.map((c) => (c.classList.contains("pm-cell-in-range") ? 1 : 0)).join("");
}

beforeEach(() => {
  document.body.innerHTML = "";
  (
    document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }
  ).elementFromPoint = () => document.body;
});

// ═════════ ⑤ 横向选区 + 合并 ═════════

describe("⑤ 横向选中两格并合并", () => {
  /**
   * v0.13.1 需求5：**起手点落在列框线热区内、且横向拖拽 = 缩放列宽**。
   *
   * 这里替换掉的旧用例断言的是"热区内横向拖拽也能选出范围"——那是 v0.13.0 第三轮
   * 为修"合并选不中"而立的模型，却把用户真正需要的**列宽拖拽**一起吞掉了
   * （用户实测反馈：「鼠标放在列框线上拖拽符出来了，但拖拽变成了选中单元格内容」）。
   * 现在按动作方向仲裁：横向 → 缩放；纵向 → 范围选区（见下一条）。
   *
   * 注意起手点选在 cells[0] 的**右缘**（x=100）而不是左缘：第一列的左缘本来
   * 就不是可拖拽的框线（`beginResizeFromGesture` 对 `firstCell + 左缘` 明确放行）。
   */
  it("需求5：从列框线横向拖拽 → 真的调整列宽，且不产生范围高亮", () => {
    const { view, cells } = mountTable();
    const before = view.state.doc.child(0).attrs.columnWidths;
    drag(cells[0], cells[1], [100, 15], [180, 15]);
    // ① 缩放真的发生了：列宽写入 table.attrs.columnWidths（互补调整，第 1 列变宽）
    const after = view.state.doc.child(0).attrs.columnWidths as number[] | null;
    expect(Array.isArray(after)).toBe(true);
    expect(after).not.toEqual(before);
    expect(after![0]).toBeGreaterThan(after![1]);
    // ② 旧 bug 的可见症状就是"变成选中单元格内容" → 必须**没有**范围高亮
    expect(highlighted(cells)).toBe("000000000");
    // ③ 拖拽结束不得残留缩放指示线
    expect(document.querySelector(".table-resize-indicator")).toBeNull();
  });

  it("需求5：热区内**纵向**拖拽仍然选出范围（不能把竖选/合并一起吞掉）", () => {
    const { cells } = mountTable();
    // 起手 x=8（列热区内），但纵向移动 → 主导轴是纵向 → 判为范围选区
    drag(cells[0], cells[3], [8, 15], [10, 60]);
    expect(highlighted(cells)).toBe("100100000");
  });

  it("起手点落在格中央（普通路径）同样能选出范围", () => {
    const { cells } = mountTable();
    drag(cells[0], cells[1], [50, 15], [150, 15]);
    expect(highlighted(cells)).toBe("110000000");
  });

  it("合并按钮可用且点击后**真的合并**（colspan 写进文档）", () => {
    const { view, host, cells } = mountTable();
    drag(cells[0], cells[1], [50, 15], [150, 15]);
    // 工具栏靠 click 事件显示
    mouseOn(cells[0], "click", 50, 15);
    const btn = host.querySelector<HTMLButtonElement>('button[data-action="mergeCells"]');
    expect(btn).toBeTruthy();
    expect(btn!.disabled).toBe(false);
    btn!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    // 文档层断言：table → table_head → table_row → 首个 cell 跨 2 列
    const table = view.state.doc.child(0);
    const head = table.child(0);
    const row = head.child(0);
    expect(row.child(0).attrs.colspan).toBe(2);
    expect(row.childCount).toBe(2);
  });

  it("合并结果往返（docToMarkdown → markdownToDoc）后仍是 table（不丢整表）", () => {
    const { view, host, cells } = mountTable();
    drag(cells[0], cells[1], [50, 15], [150, 15]);
    mouseOn(cells[0], "click", 50, 15);
    host
      .querySelector<HTMLButtonElement>('button[data-action="mergeCells"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    const md = docToMarkdown(view.state.doc);
    const back = markdownToDoc(md);
    expect(back.child(0).type.name).toBe("table");
    // 内容不丢
    expect(back.textContent).toContain("A");
    expect(back.textContent).toContain("C");
    expect(back.textContent).toContain("6");
  });

  /**
   * ④ 合并后 DOM 必须真的渲染出跨度。
   *
   * 这条是本轮最关键的回归锁：旧实现里合并事务完全正确（doc 有 colspan、
   * 源码也正确序列化），但 td/th 由 TableCellView 自建、PM 不再走 schema.toDOM，
   * 于是 colspan 从未写进 DOM —— 用户界面毫无变化，看起来就是"点了没反应"。
   * 只断言 doc 的测试**永远抓不到**它。
   */
  it("合并后 DOM 的 td/th 必须带上 colspan（旧实现从未写入 → 视觉上像没合并）", () => {
    const { view, host, cells } = mountTable();
    drag(cells[0], cells[1], [50, 15], [150, 15]);
    mouseOn(cells[0], "click", 50, 15);
    host
      .querySelector<HTMLButtonElement>('button[data-action="mergeCells"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    // 先确认事务层确实生效，避免"两边都没动"被误判为通过
    expect(view.state.doc.child(0).child(0).child(0).child(0).attrs.colspan).toBe(2);

    const after = Array.from(host.querySelectorAll("td, th")) as HTMLElement[];
    const merged = after[0];
    expect(merged.textContent).toBe("A");
    expect(merged.getAttribute("colspan")).toBe("2");
    expect(merged.getAttribute("rowspan")).toBeNull();
    // 合并后该行物理格数从 3 降到 2（被合并的 B 格被删除）
    const rowCells = Array.from(merged.parentElement!.querySelectorAll("td, th"));
    expect(rowCells.length).toBe(2);
  });

  it("未合并的普通表格 DOM 不输出跨度属性（与旧版逐字节一致，零回归）", () => {
    const { host } = mountTable();
    const cells = Array.from(host.querySelectorAll("td, th")) as HTMLElement[];
    expect(cells.length).toBe(9);
    for (const c of cells) {
      expect(c.getAttribute("colspan")).toBeNull();
      expect(c.getAttribute("rowspan")).toBeNull();
    }
  });

  it("拆分后 DOM 的跨度属性被清掉（applySpan 双向同步）", () => {
    const { view, host, cells } = mountTable();
    drag(cells[0], cells[1], [50, 15], [150, 15]);
    mouseOn(cells[0], "click", 50, 15);
    host
      .querySelector<HTMLButtonElement>('button[data-action="mergeCells"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    expect((host.querySelector("td, th") as HTMLElement).getAttribute("colspan")).toBe("2");

    // 拆分：光标落在合并格内（合并后工具栏会重建按钮，重新查询）
    const merged = host.querySelector("td, th") as HTMLElement;
    // 在合并格文本（"A"）上建立光标 —— 用文档位置而非几何，避免依赖 posAtCoords
    let textPos = -1;
    view.state.doc.descendants((n, pos) => {
      if (textPos < 0 && n.isText && n.text === "A") {
        textPos = pos;
        return false;
      }
      return true;
    });
    expect(textPos).toBeGreaterThan(-1);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, textPos)));
    merged.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    const splitBtn = host.querySelector<HTMLButtonElement>('button[data-action="splitCell"]');
    expect(splitBtn).toBeTruthy();
    splitBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    const after = Array.from(host.querySelectorAll("td, th")) as HTMLElement[];
    expect(after[0].getAttribute("colspan")).toBeNull();
    // 结构还原为 3 格
    expect(Array.from(after[0].parentElement!.querySelectorAll("td, th")).length).toBe(3);
  });

  it("单击单格不产生范围（回归锁：不能「一点就全选」）", () => {
    const { cells } = mountTable();
    mouseOn(cells[0], "mousedown", 50, 15, 1);
    mouseOn(cells[0], "mouseup", 50, 15, 0);
    expect(highlighted(cells)).toBe("000000000");
  });
});

// ═════════ ⑦ 纵向选区 + 合并 ═════════

describe("⑦ 纵向选中两格并合并", () => {
  /**
   * v0.13.1 需求5：**起手点落在行框线热区内、且纵向拖拽 = 缩放行高**。
   *
   * 这条替换掉了旧用例「起手点落在行高热区内也能纵向选出范围」——那属于 v0.13.0
   * 第三轮为"合并选不中"立的模型，代价是**行高拖拽再也无法启动**（用户本轮实测
   * 反馈就是"鼠标放在列框线上拖拽调整行高列宽不起作用了"）。
   *
   * 现行仲裁按动作方向：
   *   · 行热区 + 纵向主导 → 行高缩放（本条）；
   *   · 行热区 + 横向主导 → 范围选区；
   *   · 单元格**主体内**纵向拖拽 → 范围选区（下一条，需求2 要的"纵向拖拽选中"）。
   * 行热区只有 6px（单元格高 30px），主体还有 24px 可供起手，两者不冲突。
   */
  it("需求5：起手点落在行框线热区内纵向拖拽 → 真的调整行高（不再被当成选范围）", () => {
    const { view, cells } = mountTable();
    // `startRowResize` 读的是 **<tr> 的 rect**（不是 cell 的），而 mountTable 只桩了
    // cell 的几何 → jsdom 下 tr 的 height 恒为 0，缩放会被 `Math.max(20, …)` 兜到底。
    // 这里补桩行矩形，让行高基准与真实布局一致（30px），断言才有意义。
    const row = cells[0].parentElement as HTMLElement;
    row.getBoundingClientRect = () =>
      ({ left: 0, right: 300, top: 0, bottom: 30, width: 300, height: 30, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const before = view.state.doc.child(0).attrs.rowHeights;

    // y=28 距首行 cell 底缘 30 只有 2px —— 在 ROW_RESIZE_HOTZONE(6) 内
    drag(cells[0], cells[3], [50, 28], [50, 45]);

    const after = view.state.doc.child(0).attrs.rowHeights as number[] | null;
    expect(Array.isArray(after)).toBe(true);
    expect(after).not.toEqual(before);
    // 起手高度 30 + 位移 17 = 47（互补逻辑只作用于列宽，行高按绝对值）
    expect(after![0]).toBe(47);
    // 缩放不得产生范围高亮
    expect(highlighted(cells)).toBe("000000000");
    expect(document.querySelector(".table-resize-indicator-h")).toBeNull();
  });

  it("格中央纵向拖拽同样能选出范围", () => {
    const { cells } = mountTable();
    drag(cells[0], cells[3], [50, 15], [50, 45]);
    expect(highlighted(cells)).toBe("100100000");
  });

  it("纵向合并表头+数据行：rowspan 写进文档且往返后仍是 table", () => {
    const { view, host, cells } = mountTable();
    drag(cells[0], cells[3], [50, 15], [50, 45]);
    mouseOn(cells[0], "click", 50, 15);
    const btn = host.querySelector<HTMLButtonElement>('button[data-action="mergeCells"]');
    expect(btn!.disabled).toBe(false);
    btn!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    const table = view.state.doc.child(0);
    // table → table_head → table_row → 首格
    expect(table.child(0).child(0).child(0).attrs.rowspan).toBe(2);
    const md = docToMarkdown(view.state.doc);
    expect(markdownToDoc(md).child(0).type.name).toBe("table");
  });

  it("数据行纵向合并（第 1 列两行）也生效", () => {
    const { view, host, cells } = mountTable();
    // cells[3] = 数据行1 第1列，cells[6] = 数据行2 第1列
    drag(cells[3], cells[6], [50, 45], [50, 75]);
    mouseOn(cells[3], "click", 50, 45);
    const btn = host.querySelector<HTMLButtonElement>('button[data-action="mergeCells"]');
    expect(btn!.disabled).toBe(false);
    btn!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    // table → table_body → 第 1 数据行 → 首格
    const body = view.state.doc.child(0).child(1);
    expect(body.child(0).child(0).attrs.rowspan).toBe(2);
    const md = docToMarkdown(view.state.doc);
    expect(markdownToDoc(md).child(0).type.name).toBe("table");
  });

  /** ④ 的纵向版本：rowspan 同样必须落到 DOM */
  it("纵向合并后 DOM 必须带上 rowspan", () => {
    const { view, host, cells } = mountTable();
    drag(cells[0], cells[3], [50, 15], [50, 45]);
    mouseOn(cells[0], "click", 50, 15);
    const btn = host.querySelector<HTMLButtonElement>('button[data-action="mergeCells"]');
    expect(btn!.disabled).toBe(false);
    btn!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    // doc 层确认
    expect(view.state.doc.child(0).child(0).child(0).child(0).attrs.rowspan).toBe(2);
    const merged = host.querySelector("td, th") as HTMLElement;
    expect(merged.textContent).toBe("A");
    expect(merged.getAttribute("rowspan")).toBe("2");
    expect(merged.getAttribute("colspan")).toBeNull();
  });

  it("纵向合并往返：表头物理格数 = 分隔行列数，表格不退化（BLOCKER-2 模式）", () => {
    const { view, host, cells } = mountTable();
    drag(cells[0], cells[3], [50, 15], [50, 45]);
    mouseOn(cells[0], "click", 50, 15);
    host
      .querySelector<HTMLButtonElement>('button[data-action="mergeCells"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    const md = docToMarkdown(view.state.doc);
    expect(md).toContain('<th rowspan="2">A</th>');
    const lines = md.trim().split("\n");
    const countCells = (l: string) => l.split("|").slice(1, -1).length;
    // markdown-it 硬性要求表头物理格数 == 分隔行列数，否则整表变段落
    expect(countCells(lines[0])).toBe(countCells(lines[1]));

    const back = markdownToDoc(md);
    expect(back.child(0).type.name).toBe("table");
    // 结构保真：rowspan 仍在
    expect(back.child(0).child(0).child(0).child(0).attrs.rowspan).toBe(2);
    // 二次序列化稳定（不逐次膨胀列数）
    expect(docToMarkdown(back)).toBe(md);
  });
});

// ═════════ ⑤⑦ 缩放手势不被破坏（回归锁） ═════════

describe("⑤⑦ 回归锁：列宽/行高拖拽仍然可用", () => {
  it("沿边框轴拖动 → 走缩放（不误判为范围选区）", () => {
    const { cells } = mountTable();
    const before = cells[0].style.width;
    // 起手在右边缘热区内，水平向右拖 30px（仍在本 cell 内）
    mouseOn(cells[0], "mousedown", 100, 15, 1);
    document.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 130, clientY: 15, buttons: 1 }),
    );
    // 列宽被调整（互补：第 1 列变宽）
    expect(cells[0].style.width).not.toBe(before);
    expect(cells[0].style.width).toBe("130px");
    // 未产生范围高亮
    expect(highlighted(cells)).toBe("000000000");
    document.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, clientX: 130, clientY: 15 }),
    );
  });

  it("从右 cell 左边缘发起（内部框线）→ colIdx 归一到前一列", () => {
    const { cells } = mountTable();
    mouseOn(cells[1], "mousedown", 100, 15, 1);
    document.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 140, clientY: 15, buttons: 1 }),
    );
    expect(cells[0].style.width).toBe("140px");
    expect(cells[1].style.width).toBe("60px");
    document.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, clientX: 140, clientY: 15 }),
    );
  });

  it("点一下就松开（未移动）→ 不启动缩放、也不产生范围", () => {
    const { cells } = mountTable();
    mouseOn(cells[0], "mousedown", 100, 15, 1);
    mouseOn(cells[0], "mouseup", 100, 15, 0);
    expect(cells[0].style.width).toBe("");
    expect(highlighted(cells)).toBe("000000000");
  });

  it("热区判定口径未变（列宽 8px / 行高 6px）", () => {
    const cell = document.createElement("td");
    cell.getBoundingClientRect = () =>
      ({ left: 100, right: 200, top: 0, bottom: 30, width: 100, height: 30, x: 100, y: 0, toJSON: () => ({}) }) as DOMRect;
    // 右缘内 8px
    expect(hitResizeZoneForTest(cell, 195, 15).col).toBe(true);
    // 左缘内 8px
    expect(hitResizeZoneForTest(cell, 105, 15).col).toBe(true);
    // 中央
    expect(hitResizeZoneForTest(cell, 150, 15).col).toBe(false);
    // 底缘内 6px
    expect(hitResizeZoneForTest(cell, 150, 27).row).toBe(true);
    expect(hitResizeZoneForTest(cell, 150, 10).row).toBe(false);
  });
});

// ═════════ ⑥ 右键菜单合并为一栏 ═════════

describe("⑥ 表格右键菜单与行内格式合并为一个（上下两栏）", () => {
  it("onContextMenu 阻止冒泡（否则应用层行内菜单会叠上来）", () => {
    const src = SRC("core/plugins/table-editor.ts");
    const body = src.slice(src.indexOf("private onContextMenu(e: MouseEvent)"));
    const head = body.slice(0, 400);
    expect(head).toContain("e.preventDefault()");
    expect(head).toContain("e.stopPropagation()");
  });

  it("真实右键：祖先容器收不到 contextmenu（应用层菜单不会出现）", () => {
    const { cells } = mountTable();
    let ancestorGot = 0;
    document.body.addEventListener("contextmenu", () => ancestorGot++);
    const ev = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: 50,
      clientY: 15,
    });
    cells[0].dispatchEvent(ev);
    document.body.removeEventListener("contextmenu", () => ancestorGot++);
    expect(ancestorGot).toBe(0);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.querySelector(".table-context-menu")).toBeTruthy();
  });

  it("无文本选区：菜单只有表格操作，不含行内格式", () => {
    const doc = markdownToDoc(MD3);
    const $pos = doc.resolve(1 + 1 + 1);
    const keys = buildContextMenuItems($pos, false).map((i) => i.key);
    expect(keys).toContain("table.mergeCells");
    expect(keys).toContain("table.splitCell");
    expect(keys).not.toContain("menu.bold");
  });

  it("有文本选区：表格操作在上、行内格式在下（分栏顺序）", () => {
    const doc = markdownToDoc(MD3);
    const $pos = doc.resolve(1 + 1 + 1);
    const keys = buildContextMenuItems($pos, true).map((i) => i.key).filter(Boolean) as string[];
    const iMerge = keys.indexOf("table.mergeCells");
    const iSplit = keys.indexOf("table.splitCell");
    const iBold = keys.indexOf("menu.bold");
    const iUnderline = keys.indexOf("menu.underline");
    expect(iMerge).toBeGreaterThan(-1);
    expect(iBold).toBeGreaterThan(-1);
    // 上半栏（表格操作）全部在前，下半栏（格式）在后
    expect(iMerge).toBeLessThan(iBold);
    expect(iSplit).toBeLessThan(iBold);
    // 格式项齐全且顺序固定
    expect(keys.slice(iBold)).toEqual([
      "menu.bold",
      "menu.italic",
      "menu.strikethrough",
      "menu.inlineCode",
      "menu.highlight",
      "menu.underline",
    ]);
    expect(iUnderline).toBeGreaterThan(iBold);
  });

  it("行内格式项真的能给选区加 mark（不是只渲染不生效）", () => {
    const doc = markdownToDoc("| A |\n| --- |\n| 1 |\n");
    // 选中「1」这个字符：定位 cell 内的文本
    let textPos = -1;
    doc.descendants((n, pos) => {
      if (n.isText && n.text === "1") textPos = pos;
      return true;
    });
    expect(textPos).toBeGreaterThan(-1);
    const st = EditorState.create({ doc, selection: undefined });
    const tr = st.tr.setSelection(
      (st.selection.constructor as unknown as { create: (d: unknown, a: number, b: number) => never }).create(
        st.doc,
        textPos,
        textPos + 1,
      ) as never,
    );
    const out = toggleMarkOp(tr, "strong");
    expect(out).not.toBeNull();
    const marked = st.apply(out!).doc;
    let hasStrong = false;
    marked.descendants((n) => {
      if (n.marks.some((m) => m.type.name === "strong")) hasStrong = true;
      return true;
    });
    expect(hasStrong).toBe(true);
  });

  it("未知 mark 名 / 空选区 → 返回 null（点了不动，不抛错）", () => {
    const doc = markdownToDoc(MD3);
    const st = EditorState.create({ doc });
    expect(toggleMarkOp(st.tr, "no_such_mark")).toBeNull();
    // 空选区
    expect(toggleMarkOp(st.tr, "strong")).toBeNull();
  });

  it("菜单项用既有 i18n key（不新增翻译键）", () => {
    const zh = SRC("i18n/locales/zh-CN.ts");
    const en = SRC("i18n/locales/en-US.ts");
    for (const k of ["menu.bold", "menu.italic", "menu.strikethrough", "menu.inlineCode", "menu.highlight", "menu.underline"]) {
      expect(zh).toContain(`"${k}"`);
      expect(en).toContain(`"${k}"`);
    }
  });
});

// ═════════ 合并的前置校验（纯函数层回归锁） ═════════

describe("合并前置校验：纵向/横向矩形都放行，单格拒绝", () => {
  it("横向 2 格 / 纵向 2 格 → ok；单格 → too-few", () => {
    const table = markdownToDoc(MD3).child(0) as PMNode;
    expect(checkMergeable(table, { r0: 0, c0: 0, r1: 0, c1: 1 }, 3).ok).toBe(true);
    expect(checkMergeable(table, { r0: 0, c0: 0, r1: 1, c1: 0 }, 3).ok).toBe(true);
    expect(checkMergeable(table, { r0: 0, c0: 0, r1: 0, c1: 0 }, 3).ok).toBe(false);
  });

  it("纵向合并事务真的产出 rowspan", () => {
    const doc = markdownToDoc(MD3);
    const st = EditorState.create({ doc });
    const out = mergeCells(st.tr, 0, doc.child(0) as PMNode, { r0: 1, c0: 0, r1: 2, c1: 0 });
    expect(out).not.toBeNull();
    const merged = st.apply(out!).doc;
    // table → table_body(1) → table_row(0) → 首格
    expect(merged.child(0).child(1).child(0).child(0).attrs.rowspan).toBe(2);
    // 往返仍是 table
    expect(markdownToDoc(docToMarkdown(merged)).child(0).type.name).toBe("table");
  });
});
