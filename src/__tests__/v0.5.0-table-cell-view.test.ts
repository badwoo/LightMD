/**
 * v0.5.0 F1 修复：阅读模式表格内部框线拖拽无反应
 *
 * 根因：TableView 拖拽时直接写 td/th 的 style.width，ProseMirror DOMObserver
 * 捕获 attributes 型 mutation → readDOMChange → 重建 thead/tbody → 宽度丢失。
 *
 * 修复：为 table_cell/table_header 挂 TableCellView NodeView，
 * ignoreMutation 忽略 attributes 型 mutation。
 *
 * 验收标准：
 * 1. TableCellView 为 table_header/table_cell 分别创建 th/td 元素
 * 2. align 属性正确同步到 style.textAlign
 * 3. ignoreMutation 仅忽略 attributes，内容编辑（childList/characterData）放行
 * 4. 编辑器中 td/th 由 TableCellView 接管（注册生效）
 * 5. 拖拽写 style.width 后 cell DOM 不被 PM 重建（isConnected 保持 true）
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createEditor } from "../core/editor";
import { lightMDSchema } from "../core/schema";
import { TableCellView } from "../core/plugins/table-editor";
import type { EditorView } from "prosemirror-view";

const TABLE_MD = "| H1 | H2 | H3 |\n| --- | --- | --- |\n| A | B | C |\n";

/** 构造 MutationRecord 的最小 mock */
function fakeMutation(type: MutationRecord["type"]): MutationRecord {
  return { type } as MutationRecord;
}

describe("v0.5.0 TableCellView（F1 修复）", () => {
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

  it("table_header 创建 th 元素，table_cell 创建 td 元素", () => {
    const headerNode = lightMDSchema.nodes.table_header.create(
      { align: "left" },
      lightMDSchema.text("H")
    );
    const cellNode = lightMDSchema.nodes.table_cell.create(
      { align: "left" },
      lightMDSchema.text("c")
    );
    const headerView = new TableCellView(headerNode);
    const cellView = new TableCellView(cellNode);
    expect(headerView.dom.tagName).toBe("TH");
    expect(cellView.dom.tagName).toBe("TD");
    expect(headerView.contentDOM).toBe(headerView.dom);
    expect(cellView.contentDOM).toBe(cellView.dom);
  });

  it("align 属性同步到 style.textAlign（left 清空，center/right 保留）", () => {
    const centerCell = lightMDSchema.nodes.table_cell.create(
      { align: "center" },
      lightMDSchema.text("c")
    );
    const leftCell = lightMDSchema.nodes.table_cell.create(
      { align: "left" },
      lightMDSchema.text("c")
    );
    expect(new TableCellView(centerCell).dom.style.textAlign).toBe("center");
    expect(new TableCellView(leftCell).dom.style.textAlign).toBe("");
  });

  it("ignoreMutation：attributes 返回 true（忽略），childList/characterData 返回 false（放行）", () => {
    const cellNode = lightMDSchema.nodes.table_cell.create(
      { align: "left" },
      lightMDSchema.text("c")
    );
    const cellView = new TableCellView(cellNode);
    expect(cellView.ignoreMutation(fakeMutation("attributes"))).toBe(true);
    expect(cellView.ignoreMutation(fakeMutation("childList"))).toBe(false);
    expect(cellView.ignoreMutation(fakeMutation("characterData"))).toBe(false);
  });

  it("update：同类型节点返回 true 并刷新 align，异类型返回 false", () => {
    const cellNode = lightMDSchema.nodes.table_cell.create(
      { align: "left" },
      lightMDSchema.text("c")
    );
    const cellView = new TableCellView(cellNode);
    const changedCell = lightMDSchema.nodes.table_cell.create(
      { align: "right" },
      lightMDSchema.text("c")
    );
    expect(cellView.update(changedCell)).toBe(true);
    expect(cellView.dom.style.textAlign).toBe("right");

    const headerNode = lightMDSchema.nodes.table_header.create(
      { align: "left" },
      lightMDSchema.text("H")
    );
    expect(cellView.update(headerNode)).toBe(false);
  });

  it("编辑器中 TableCellView 注册生效：td/th 存在且拖拽写样式后不被 PM 重建", async () => {
    view = createEditor({ parent, initialContent: TABLE_MD });
    const table = parent.querySelector("table.pm-table") as HTMLTableElement;
    const firstRow = table.querySelector("tr") as HTMLTableRowElement;
    const cells = Array.from(firstRow.querySelectorAll("th, td")) as HTMLElement[];
    expect(cells.length).toBe(3);

    // mock 单元格几何：3 列等宽 100px
    cells.forEach((cell, i) => {
      const left = i * 100;
      cell.getBoundingClientRect = () => ({
        left,
        right: left + 100,
        top: 0,
        bottom: 30,
        width: 100,
        height: 30,
        x: left,
        y: 0,
        toJSON: () => ({}),
      });
    });

    // 拖拽内部框线（第 1/2 列之间，x=100）往右 30px
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

    // 列宽互补：第 1 列 +30，第 2 列 -30，总宽不变
    expect(cells[0].style.width).toBe("130px");
    expect(cells[1].style.width).toBe("70px");

    // F1 核心断言：拖拽写 style 后 cell DOM 仍连接在文档中。
    // 若未挂 TableCellView，PM 的 DOMObserver 会捕获 attributes mutation
    // 并重建 thead/tbody，旧 cell 将从文档断开（isConnected === false）。
    await new Promise((r) => setTimeout(r, 50));
    expect(cells[0].isConnected).toBe(true);
    expect(cells[1].isConnected).toBe(true);
    expect(cells[2].isConnected).toBe(true);

    // 重建后新 DOM 的宽度应与持久化的 columnWidths 一致（从 DOM 重新查询验证）
    const newCells = Array.from(
      (table.querySelector("tr") as HTMLTableRowElement).querySelectorAll("th, td")
    ) as HTMLElement[];
    expect(newCells.length).toBe(3);
    // 新 DOM 与拖拽时的是同一批节点（未重建）
    expect(newCells[0]).toBe(cells[0]);
  });

  it("内部框线从右 cell 左边缘触发：点击第 2 列左边缘，colIdx 归一到前一列", () => {
    view = createEditor({ parent, initialContent: TABLE_MD });
    const table = parent.querySelector("table.pm-table") as HTMLTableElement;
    const firstRow = table.querySelector("tr") as HTMLTableRowElement;
    const cells = Array.from(firstRow.querySelectorAll("th, td")) as HTMLElement[];

    cells.forEach((cell, i) => {
      const left = i * 100;
      cell.getBoundingClientRect = () => ({
        left,
        right: left + 100,
        top: 0,
        bottom: 30,
        width: 100,
        height: 30,
        x: left,
        y: 0,
        toJSON: () => ({}),
      });
    });

    // 从第 2 列（cells[1]）左边缘 x=100 发起拖拽，往右 40px
    cells[1].dispatchEvent(
      new MouseEvent("mousedown", {
        clientX: 100,
        clientY: 15,
        button: 0,
        bubbles: true,
        cancelable: true,
      })
    );
    document.dispatchEvent(
      new MouseEvent("mousemove", { clientX: 140, clientY: 15, bubbles: true })
    );
    // 等价于拖第 1 列右边缘往右 40px：第 1 列 140，第 2 列 60
    expect(cells[0].style.width).toBe("140px");
    expect(cells[1].style.width).toBe("60px");

    document.dispatchEvent(
      new MouseEvent("mouseup", { clientX: 140, clientY: 15, bubbles: true })
    );
  });
});
