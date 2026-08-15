/**
 * v0.4.5 阅读模式表格列宽拖拽 - 模拟人工拖拽集成测试
 *
 * 验证目标：
 * 1. 阅读模式（preview）下使用 ProseMirror EditorView + TableView NodeView
 * 2. 模拟人工拖拽：mousedown → mousemove → mouseup
 * 3. 验证列宽实时更新和持久化
 *
 * 测试策略：
 * - 使用 createEditor 创建真实的 ProseMirror EditorView（含 TableView NodeView）
 * - mock getBoundingClientRect 返回合理的 cell 几何信息
 * - 通过 dispatchEvent 派发原生鼠标事件，模拟人工拖拽
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createEditor } from "../core/editor";
import type { EditorView } from "prosemirror-view";

/** mock 单元格的 getBoundingClientRect，返回指定的几何信息 */
function mockCellRect(el: HTMLElement, left: number, right: number, top: number, bottom: number) {
  el.getBoundingClientRect = () => ({
    left,
    right,
    top,
    bottom,
    width: right - left,
    height: bottom - top,
    x: left,
    y: top,
    toJSON: () => ({}),
  });
}

/** mock 多个单元格的几何信息（等宽布局） */
function mockTableCells(cells: HTMLElement[], startX = 0, cellWidth = 100, rowHeight = 30) {
  cells.forEach((cell, i) => {
    const left = startX + i * cellWidth;
    const right = left + cellWidth;
    mockCellRect(cell, left, right, 0, rowHeight);
  });
}

/** 构造包含表格的 markdown 内容 */
const TABLE_MD = "| H1 | H2 | H3 |\n| --- | --- | --- |\n| A | B | C |\n";

// mock document.elementFromPoint（ProseMirror mousedown 处理器调用，jsdom 默认无此方法）
if (typeof document.elementFromPoint !== "function") {
  document.elementFromPoint = () => null;
}

describe("v0.4.5 阅读模式表格列宽拖拽 - 模拟人工拖拽", () => {
  let parent: HTMLDivElement;
  let view: EditorView | null;

  beforeEach(() => {
    parent = document.createElement("div");
    document.body.appendChild(parent);
  });

  afterEach(() => {
    if (view) {
      view.destroy();
      view = null;
    }
    parent.remove();
  });

  it("阅读模式下 TableView NodeView 正确渲染表格", () => {
    view = createEditor({ parent, initialContent: TABLE_MD });
    expect(view).not.toBeNull();
    // 表格通过 TableView 渲染，外层是 .table-wrapper
    const wrapper = parent.querySelector(".table-wrapper");
    expect(wrapper).not.toBeNull();
    // 内层是 table.pm-table
    const table = parent.querySelector("table.pm-table");
    expect(table).not.toBeNull();
    // 验证表头和正文行
    const rows = table!.querySelectorAll("tr");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    // 第一行应有 3 个单元格
    const firstRowCells = rows[0].querySelectorAll("th, td");
    expect(firstRowCells.length).toBe(3);
  });

  it("模拟拖拽第 1 列右边缘往右 30px：第 1 列增大，第 2 列减小，总宽度不变", () => {
    view = createEditor({ parent, initialContent: TABLE_MD });
    const table = parent.querySelector("table.pm-table") as HTMLTableElement;
    const firstRow = table.querySelector("tr") as HTMLTableRowElement;
    const cells = Array.from(firstRow.querySelectorAll("th, td")) as HTMLElement[];
    expect(cells.length).toBe(3);

    // mock 单元格几何：3 列等宽 100px，从 x=0 开始
    mockTableCells(cells, 0, 100);

    // 模拟 mousedown 在第 1 列右边缘（x=100，cell 右边缘 ±8px 热区）
    const mousedown = new MouseEvent("mousedown", {
      clientX: 100,
      clientY: 15,
      button: 0,
      bubbles: true,
      cancelable: true,
    });
    cells[0].dispatchEvent(mousedown);

    // 模拟 mousemove 往右拖拽 30px
    document.dispatchEvent(
      new MouseEvent("mousemove", { clientX: 130, clientY: 15, bubbles: true })
    );

    // 验证列宽已实时更新
    expect(cells[0].style.width).toBe("130px");
    expect(cells[1].style.width).toBe("70px");
    expect(cells[2].style.width).toBe("100px");

    // 模拟 mouseup 结束拖拽
    document.dispatchEvent(
      new MouseEvent("mouseup", { clientX: 130, clientY: 15, bubbles: true })
    );

    // 验证拖拽结束后列宽保持
    expect(cells[0].style.width).toBe("130px");
    expect(cells[1].style.width).toBe("70px");
  });

  it("模拟拖拽最后一列右边缘往右 50px：只调整最后一列，总宽度可变", () => {
    view = createEditor({ parent, initialContent: TABLE_MD });
    const table = parent.querySelector("table.pm-table") as HTMLTableElement;
    const firstRow = table.querySelector("tr") as HTMLTableRowElement;
    const cells = Array.from(firstRow.querySelectorAll("th, td")) as HTMLElement[];

    mockTableCells(cells, 0, 100);

    // 模拟 mousedown 在最后一列（第 3 列）右边缘（x=300）
    cells[2].dispatchEvent(
      new MouseEvent("mousedown", {
        clientX: 300,
        clientY: 15,
        button: 0,
        bubbles: true,
        cancelable: true,
      })
    );

    // 模拟 mousemove 往右拖拽 50px
    document.dispatchEvent(
      new MouseEvent("mousemove", { clientX: 350, clientY: 15, bubbles: true })
    );

    // 验证只有最后一列增大 50px，其他列不变
    expect(cells[0].style.width).toBe("100px");
    expect(cells[1].style.width).toBe("100px");
    expect(cells[2].style.width).toBe("150px");

    // 结束拖拽
    document.dispatchEvent(
      new MouseEvent("mouseup", { clientX: 350, clientY: 15, bubbles: true })
    );
  });

  it("模拟拖拽第 2 列左边缘往左 20px：等价于调整第 1 列右边缘，第 1 列减小", () => {
    view = createEditor({ parent, initialContent: TABLE_MD });
    const table = parent.querySelector("table.pm-table") as HTMLTableElement;
    const firstRow = table.querySelector("tr") as HTMLTableRowElement;
    const cells = Array.from(firstRow.querySelectorAll("th, td")) as HTMLElement[];

    mockTableCells(cells, 0, 100);

    // 第 2 列左边缘在 x=100，模拟 mousedown 在左边缘（cellIdx=1，左边缘触发 colIdx=0）
    cells[1].dispatchEvent(
      new MouseEvent("mousedown", {
        clientX: 100,
        clientY: 15,
        button: 0,
        bubbles: true,
        cancelable: true,
      })
    );

    // 往左拖拽 20px（deltaX = 80 - 100 = -20）
    document.dispatchEvent(
      new MouseEvent("mousemove", { clientX: 80, clientY: 15, bubbles: true })
    );

    // 第 1 列减小 20px，第 2 列增大 20px
    expect(cells[0].style.width).toBe("80px");
    expect(cells[1].style.width).toBe("120px");
    expect(cells[2].style.width).toBe("100px");

    document.dispatchEvent(
      new MouseEvent("mouseup", { clientX: 80, clientY: 15, bubbles: true })
    );
  });

  it("模拟拖拽受 minWidth 限制：相邻列不会被压缩到 0", () => {
    view = createEditor({ parent, initialContent: TABLE_MD });
    const table = parent.querySelector("table.pm-table") as HTMLTableElement;
    const firstRow = table.querySelector("tr") as HTMLTableRowElement;
    const cells = Array.from(firstRow.querySelectorAll("th, td")) as HTMLElement[];

    mockTableCells(cells, 0, 100);

    // mousedown 在第 1 列右边缘
    cells[0].dispatchEvent(
      new MouseEvent("mousedown", {
        clientX: 100,
        clientY: 15,
        button: 0,
        bubbles: true,
        cancelable: true,
      })
    );

    // 往右拖拽 200px，但第 2 列只有 100px，minWidth=20，最多压缩 80px
    document.dispatchEvent(
      new MouseEvent("mousemove", { clientX: 300, clientY: 15, bubbles: true })
    );

    // 第 1 列增大 80px（100+80=180），第 2 列减小到 20px（minWidth）
    expect(cells[0].style.width).toBe("180px");
    expect(cells[1].style.width).toBe("20px");

    document.dispatchEvent(
      new MouseEvent("mouseup", { clientX: 300, clientY: 15, bubbles: true })
    );
  });

  it("点击 cell 中心不触发列宽拖拽（仅边缘 8px 内触发）", () => {
    view = createEditor({ parent, initialContent: TABLE_MD });
    const table = parent.querySelector("table.pm-table") as HTMLTableElement;
    const firstRow = table.querySelector("tr") as HTMLTableRowElement;
    const cells = Array.from(firstRow.querySelectorAll("th, td")) as HTMLElement[];

    mockTableCells(cells, 0, 100);

    // 点击第 1 列中心（x=50，远离边缘）
    cells[0].dispatchEvent(
      new MouseEvent("mousedown", {
        clientX: 50,
        clientY: 15,
        button: 0,
        bubbles: true,
        cancelable: true,
      })
    );

    // mousemove 不应触发列宽更新（resizing 未启动）
    document.dispatchEvent(
      new MouseEvent("mousemove", { clientX: 80, clientY: 15, bubbles: true })
    );

    // 列宽应保持不变
    expect(cells[0].style.width).toBe("");
    expect(cells[1].style.width).toBe("");
  });

  it("模拟拖拽后列宽持久化到 table 节点 attrs.columnWidths", () => {
    view = createEditor({ parent, initialContent: TABLE_MD });
    const table = parent.querySelector("table.pm-table") as HTMLTableElement;
    const firstRow = table.querySelector("tr") as HTMLTableRowElement;
    const cells = Array.from(firstRow.querySelectorAll("th, td")) as HTMLElement[];

    mockTableCells(cells, 0, 100);

    // 模拟拖拽第 1 列右边缘往右 30px
    cells[0].dispatchEvent(
      new MouseEvent("mousedown", {
        clientX: 100,
        clientY: 15,
        button: 0,
        bubbles: true,
        cancelable: true,
      })
    );
    document.dispatchEvent(
      new MouseEvent("mousemove", { clientX: 130, clientY: 15, bubbles: true })
    );
    document.dispatchEvent(
      new MouseEvent("mouseup", { clientX: 130, clientY: 15, bubbles: true })
    );

    // 遍历 doc 找到 table 节点，验证 columnWidths attrs 已持久化
    let tableNode: { attrs: { columnWidths: number[] | null } } | null = null;
    view!.state.doc.descendants((node) => {
      if (tableNode) return false;
      if (node.type.name === "table") {
        tableNode = node as unknown as { attrs: { columnWidths: number[] | null } };
        return false;
      }
      return true;
    });
    expect(tableNode).not.toBeNull();
    expect(tableNode!.attrs.columnWidths).toEqual([130, 70, 100]);
  });
});
