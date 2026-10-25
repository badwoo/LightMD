/**
 * v0.14.0 返修（需求7 回归）：表格尺寸持久化的**第二段**断点 —— 重开文档后 NodeView
 * 没有把 columnWidths/rowHeights 应用到每个 td/th。
 *
 * ## 用户原话
 * 「之前修复的表格拖拽调整行高或列宽后保存，关闭文档重新打开后会失效 —— 又复现了。」
 *
 * ## 为什么 v0140-table-size.test.ts 全绿却仍然失效
 * 那 35 条用例只覆盖**纯函数层**（serializer ↔ parser 往返）：指令写盘、读回 attrs
 * 全部正确。断裂点在**渲染层**：
 *
 *   `new EditorView(...)` 的构造顺序是
 *     TableView constructor ──► PM 把 thead/tbody/tr/td 填进 contentDOM
 *   即构造期 `contentDOM.querySelectorAll("tr")` **恒为空**，于是
 *     · `table.style.width` 设上了（只用 attrs 求和，不依赖单元格）→ 表格总宽正确；
 *     · 每个 `td/th` 的 `style.width/height` **一个都没写**（查不到行）。
 *   而 PM 渲染完子节点后**不会再调用** `update()`（节点没变化）→ 尺寸永久缺失，
 *   `table-layout:fixed` 下按等宽均分 → 用户看到"列宽/行高失效"。
 *   拖拽时正常，是因为每次拖拽事务都产生**新表格节点** → `update()` 被调用。
 *
 * ## 本文件锁定的契约
 * ① 全新创建编辑器（= 关闭后重新打开）后，每个 td/th 都带 attrs 对应的内联
 *    width / height，且 table 自身宽度 = 各列之和；
 * ② 无尺寸的纯管道表格**零内联样式**（不得因为本次修复而给默认表格写死宽度）；
 * ③ 只有列宽时，行高不写（反之亦然）；
 * ④ 延后应用是幂等的：重复触发不会把样式改乱，也不会在视图销毁后抛错。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { EditorView } from "prosemirror-view";
import { createEditor } from "../core/editor";

/** 等两帧 + 微任务，确保 scheduleApplyAfterRender 的两条路径都跑过 */
async function settle() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  await new Promise((r) => setTimeout(r, 0));
}

const BASE = "| 姓名 | 年龄 | 备注 |\n| --- | --- | --- |\n| 张三 | 30 | x |\n| 李四 | 40 | y |\n";

function docWith(directive: string | null, tail = "\n尾段。\n"): string {
  const table = `${BASE}\n`;
  if (!directive) return table + tail;
  return `${table}\n${directive}\n${tail}`;
}

const DIRECTIVE =
  '<!-- lightmd-table-size: {"columnWidths":[316,176,246],"rowHeights":[30,81,30]} -->';

describe("v0.14.0 返修：重开文档后表格尺寸必须真正应用到 DOM", () => {
  let parent: HTMLDivElement;
  let view: EditorView | null;

  beforeEach(() => {
    parent = document.createElement("div");
    document.body.appendChild(parent);
  });

  afterEach(() => {
    view?.destroy();
    view = null;
    parent.remove();
  });

  /** 量当前 DOM 里的表格尺寸事实 */
  function readDom() {
    const table = parent.querySelector(".pm-table") as HTMLElement | null;
    const rows = table ? Array.from(table.querySelectorAll("tr")) : [];
    const firstRowCells = rows.length
      ? (Array.from(rows[0].querySelectorAll("td, th")) as HTMLElement[])
      : [];
    return {
      tableWidth: table?.style.width || "",
      firstRowWidths: firstRowCells.map((c) => c.style.width || ""),
      rowHeights: rows.map((tr) => {
        const c = tr.querySelector("td, th") as HTMLElement | null;
        return c?.style.height || "";
      }),
    };
  }

  it("① 重开后（全新 EditorView）：每格宽度/高度都生效", async () => {
    view = createEditor({ parent, initialContent: docWith(DIRECTIVE) }) as EditorView;
    await settle();

    const dom = readDom();
    // 列宽：与指令中的 columnWidths 一一对应
    expect(dom.firstRowWidths).toEqual(["316px", "176px", "246px"]);
    // 行高：与指令中的 rowHeights 一一对应
    expect(dom.rowHeights).toEqual(["30px", "81px", "30px"]);
    // table 自身宽度 = 各列之和（table-layout:fixed 按绝对值分配的前提）
    expect(dom.tableWidth).toBe("738px");
  });

  it("② 无尺寸的纯管道表格：不得写任何内联 width/height（零 diff 契约）", async () => {
    view = createEditor({ parent, initialContent: docWith(null) }) as EditorView;
    await settle();

    const dom = readDom();
    expect(dom.firstRowWidths).toEqual(["", "", ""]);
    // 表头 1 行 + 数据 2 行 = 3 行
    expect(dom.rowHeights).toEqual(["", "", ""]);
    // 无 columnWidths 时表格宽度回落 100% 等宽
    expect(dom.tableWidth).toBe("100%");
  });

  it("③ 只有列宽 → 只写宽度，不写行高（反之亦然）", async () => {
    const onlyCols =
      '<!-- lightmd-table-size: {"columnWidths":[300,150,200]} -->';
    view = createEditor({ parent, initialContent: docWith(onlyCols) }) as EditorView;
    await settle();
    let dom = readDom();
    expect(dom.firstRowWidths).toEqual(["300px", "150px", "200px"]);
    // 只有列宽时不得写行高（表头 1 行 + 数据 2 行 = 3 行）
    expect(dom.rowHeights).toEqual(["", "", ""]);

    view.destroy();
    parent.innerHTML = "";

    const onlyRows = '<!-- lightmd-table-size: {"rowHeights":[44,66]} -->';
    view = createEditor({ parent, initialContent: docWith(onlyRows) }) as EditorView;
    await settle();
    dom = readDom();
    expect(dom.firstRowWidths).toEqual(["", "", ""]);
    // 只有行高时不得写列宽。
    // 行高数组长度 2 < 实际行数 3 → parser 按契约补齐到行数（缺省行 30px，
    // 见 tableSizeDirective.ts 的 sanitizeSizeArray），故第三行是 30px。
    expect(dom.rowHeights).toEqual(["44px", "66px", "30px"]);
  });

  it("④ 幂等：重复触发应用不会改乱样式，销毁后也不抛错", async () => {
    view = createEditor({ parent, initialContent: docWith(DIRECTIVE) }) as EditorView;
    await settle();
    const first = readDom();

    // 再等若干帧（scheduleApplyAfterRender 的 rAF 可能重复执行）
    await settle();
    await settle();
    expect(readDom()).toEqual(first);

    // 销毁后不应有未捕获异常
    expect(() => view!.destroy()).not.toThrow();
    view = null;
  });

  it("⑤ 回归锁：列宽与行高同时存在时，真实渲染宽度 = attrs 数值", async () => {
    view = createEditor({ parent, initialContent: docWith(DIRECTIVE) }) as EditorView;
    await settle();
    const cells = Array.from(
      // ⚠️ 不能用 `tr:first-child td/th`：会同时命中 thead 的 tr 与 tbody 的 tr（3+3=6）。
      // 表头行的单元格是 th，精确限定到 thead 内。
      parent.querySelectorAll(".pm-table thead tr:first-child th"),
    ) as HTMLElement[];
    // jsdom 不做真实布局 → getBoundingClientRect 恒 0，故以**内联样式**为准，
    // 但也要确认样式确实写在了 DOM 上（而不是只存在于 attrs）
    expect(cells.length).toBe(3);
    expect(cells.map((c) => c.style.width)).toEqual(["316px", "176px", "246px"]);
  });
});
