// @vitest-environment jsdom
/**
 * v0.13.1 需求3 + 需求4：表格单元格内的删除边界 & 对齐作用面。
 *
 * ─── 本文件为什么必须存在 ───
 *
 * 两条需求都属于「纯函数/静态断言全绿、真实链路仍然错」的同一族缺陷，因此
 * 本文件**不做任何源码文本断言**，全部断言建立在
 *   · 真实 `markdownToDoc` 文档 +
 *   · 真实 `createEditor` 挂载的 `EditorView`（含全部插件与 NodeView）+
 *   · 真实 `keydown`/鼠标事件
 * 之上，并且只断言**可观测结果**：doc 的单元格数量与每格文本、每格 align 属性、
 * 以及 `docToMarkdown → markdownToDoc` 往返之后的结构。
 *
 * ─── 需求3：Backspace/Delete 不得跨越单元格边界 ───
 *
 * 根因（已在生产代码注释中详述）：`buildKeymap()` 此前没有登记 Backspace/Delete，
 * 于是格内退格落到 `keymap(baseKeymap)` 的
 * `backspace = chainCommands(deleteSelection, joinBackward, selectNodeBackward)`，
 * 而 `joinBackward → deleteBarrier` 的隔离判定只查**两个相邻 cell** 的
 * `spec.isolating`（table_cell/table_header 都没有）→ 把右邻格与本格合并。
 * 本文件既锁定"修复后的行为"，也用 `keymap(baseKeymap)` 单独复现旧行为，
 * 证明"如果没有守卫，doct 会真的变"，避免测试变成同义反复。
 *
 * ─── 需求4：有范围选区时对齐只作用于选中的单元格 ───
 *
 * 工具栏三个对齐按钮此前一律调用 `setColumnAlign`（按**物理下标**写整列）。
 * 现在有范围选区时走 `setRangeAlign`（按**逻辑网格**写矩形内的锚点格），
 * 并且按钮 title 必须如实说明作用面。
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { EditorView } from "prosemirror-view";
import { EditorState, TextSelection } from "prosemirror-state";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import type { Node as PMNode } from "prosemirror-model";
import { Schema } from "prosemirror-model";
import { createEditor } from "../core/editor";
import { buildKeymap } from "../core/keymap";
import { lightMDSchema } from "../core/schema";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import { setRangeAlign } from "../core/tableMerge";
import { t } from "../i18n/state";

const MD3 = "| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n";

// ══════════════════ 通用辅助 ══════════════════

/** 真实编辑器挂载（含全部插件 / NodeView，与生产完全同一条链） */
function mount(md: string): { view: EditorView; host: HTMLElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = createEditor({ parent: host, initialContent: md }) as EditorView;
  if (!view) throw new Error("createEditor 返回 null");
  return { view, host };
}

/** doc 中表格的全部单元格快照（文档顺序） */
function cellsOf(doc: PMNode): Array<{
  type: string;
  align: string;
  colspan: number;
  rowspan: number;
  text: string;
}> {
  const out: Array<{
    type: string;
    align: string;
    colspan: number;
    rowspan: number;
    text: string;
  }> = [];
  doc.descendants((n) => {
    if (n.type.name === "table_cell" || n.type.name === "table_header") {
      out.push({
        type: n.type.name,
        align: String(n.attrs.align),
        colspan: Number(n.attrs.colspan) || 1,
        rowspan: Number(n.attrs.rowspan) || 1,
        text: n.textContent,
      });
      return false;
    }
    return true;
  });
  return out;
}

const cellTexts = (doc: PMNode) => cellsOf(doc).map((c) => c.text);

/**
 * 第 i 个单元格（文档顺序）的内容起始位置。
 *
 * ⚠️ v0.13.1 返修：这里必须有 `found` 终止标志。
 * `doc.descendants` 的回调返回 `false` 只表示"不深入该节点的子树"，**并不会停止遍历**；
 * 旧写法命中后不置标志、也不再 `count++`，于是 `count === i` 对**其后每一个** cell
 * 都成立，`pos` 被反复覆盖 → 任意 i 都返回**最后一个**单元格的位置
 * （实测：`| A | B |` / `| abc | 2 |` 下 cellStart(0..3) 全等于 19，即 "2" 的格首）。
 * 这让"把光标放进第 i 格"的用例全部落到了错误的格子上。
 */
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

/** 把光标放进第 i 个单元格的指定偏移（0=格首，size=格尾） */
function caretIn(view: EditorView, i: number, offsetFromStart: number): number {
  const pos = cellStart(view.state.doc, i) + offsetFromStart;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
  return pos;
}

/**
 * 派发**真实** keydown 到编辑器 DOM（与浏览器走同一条 `editHandlers.keydown` →
 * `someProp("handleKeyDown")` 链，插件顺序 = 生产顺序：
 * blockClipboard → dynamicShortcuts → buildKeymap → keymap(baseKeymap)）。
 */
function realKeyDown(
  view: EditorView,
  key: string,
  init: KeyboardEventInit & { keyCode?: number } = {},
): KeyboardEvent {
  const keyCode =
    init.keyCode ?? (key === "Backspace" ? 8 : key === "Delete" ? 46 : 0);
  const ev = new KeyboardEvent("keydown", {
    key,
    keyCode,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  view.dom.dispatchEvent(ev);
  return ev;
}

/**
 * 只跑「静态 keymap 插件链」的极简踏板：用于**单独**验证
 * `buildKeymap()` 是否吞键，以及 `keymap(baseKeymap)` 在无守卫时的破坏行为。
 * 不引入 EditorView（keymap 的 handler 只需要 state/dispatch/view）。
 */
function runKeymapChain(
  plugins: ReturnType<typeof keymap>[],
  doc: PMNode,
  pos: number,
  event: { key: string; keyCode: number; ctrlKey?: boolean; shiftKey?: boolean; metaKey?: boolean },
): { handled: boolean; doc: PMNode } {
  let state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, pos),
  });
  const viewStub = {
    state,
    get composing() {
      return false;
    },
    /**
     * baseKeymap 的 `selectNodeBackward` 会问 `view.endOfTextblock("backward", state)`：
     * **光标是否贴在该文本块的起始处**。桩若一律返回 false，这条链会被提前掐断，
     * 于是"根因复现"用例永远看不到跨格合并（假绿/假红）。
     * 这里按真实语义给出最小实现（只处理文本块方向判定）。
     */
    endOfTextblock: (dir: string) => {
      if (!state.selection.empty) return false;
      const $from = state.selection.$from;
      if (dir === "backward") return $from.parentOffset === 0;
      if (dir === "forward") return $from.parentOffset === $from.parent.content.size;
      return false;
    },
    dispatch(tr: Parameters<EditorView["dispatch"]>[0]) {
      state = state.apply(tr);
      viewStub.state = state;
    },
  } as unknown as EditorView;
  let handled = false;
  for (const p of plugins) {
    const h = p.props.handleKeyDown as
      | ((v: EditorView, e: KeyboardEvent) => boolean)
      | undefined;
    if (h && h(viewStub, event as unknown as KeyboardEvent)) {
      handled = true;
      break;
    }
  }
  return { handled, doc: state.doc };
}

/** 挂载 + 给每格桩上互不重叠的矩形（jsdom 默认全 0 会落进缩放手势热区） */
function mountTableWithRects(md = MD3): {
  view: EditorView;
  host: HTMLElement;
  cells: HTMLElement[];
} {
  const { view, host } = mount(md);
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

function mouseOn(el: Element, type: string, x: number, y: number, buttons = 0): MouseEvent {
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

/** 拖拽跨格建立范围选区：a 上按下 → b 上移动 → b 上松开 */
function dragRange(a: Element, b: Element, from: [number, number], to: [number, number]): void {
  mouseOn(a, "mousedown", from[0], from[1], 1);
  mouseOn(b, "mousemove", to[0], to[1], 1);
  mouseOn(b, "mouseup", to[0], to[1], 0);
}

/** 工具栏里的对齐按钮（按 data-align 取） */
function alignBtn(host: HTMLElement, align: string): HTMLButtonElement | null {
  return host.querySelector<HTMLButtonElement>(
    `button[data-action="align"][data-align="${align}"]`,
  );
}

function clickBtn(btn: HTMLElement): void {
  btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
}

beforeEach(() => {
  document.body.innerHTML = "";
  // jsdom 未实现 elementFromPoint，而 PM 的 posAtCoords 会调用它 →
  // 不桩会让 vitest 报未处理异常并以退出码 1 结束（见 v0130-fix-round2 注释）
  (
    document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }
  ).elementFromPoint = () => document.body;
});

// ══════════════════════════════════════════════════════════
// 需求3：Backspace / Delete 不得跨越单元格边界
// ══════════════════════════════════════════════════════════

describe("需求3 · 根因复现：没有加固时 baseKeymap 真的会改动表格结构", () => {
  /**
   * 去掉 `table_row.isolating` 的"未加固" schema。
   *
   * 修复分两层：keymap 显式守卫 + `table_row.isolating`。在生产 schema 上，
   * baseKeymap 这一半已被 isolating 挡住（`handled === false`、结构一字不动），
   * 于是"没有守卫会怎样"就无法在生产 schema 上复现。为了保住这两条用例
   * **证明缺陷真实存在**的价值（而不是同义反复），这里在未加固 schema 上跑同一条
   * baseKeymap。
   */
  const unhardenedSchema = new Schema({
    nodes: lightMDSchema.spec.nodes.update("table_row", {
      ...lightMDSchema.spec.nodes.get("table_row")!,
      isolating: false,
    }),
    marks: lightMDSchema.spec.marks,
  });
  const unhardenedDoc = (md: string) =>
    unhardenedSchema.nodeFromJSON(markdownToDoc(md).toJSON());

  it("**空格子**里继续退格 → 整格消失、右格内容左移（用户报告的原貌）", () => {
    const md = "| A | B |\n| --- | --- |\n|  | 2 |\n";
    const raw = unhardenedDoc(md);
    expect(cellTexts(raw)).toEqual(["A", "B", "", "2"]);

    const res = runKeymapChain([keymap(baseKeymap)], raw, cellStart(raw, 2), {
      key: "Backspace",
      keyCode: 8,
    });
    // 实测：4 格 → 3 格，空格的壳被删掉、"2" 左移到它的位置
    // —— 正是用户说的"右边单元格内容跑到被删单元格"。
    expect(cellsOf(res.doc)).toHaveLength(3);
    expect(cellTexts(res.doc)).toEqual(["A", "B", "2"]);
  });

  it("有内容的格首退格 → 右邻格被「吸」进本格（4 格 → 3 格，「1」+「2」=「12」）", () => {
    const md = "| A | B |\n| --- | --- |\n| 1 | 2 |\n";
    const raw = unhardenedDoc(md);
    // 光标落在 "2" 的格首
    const res = runKeymapChain([keymap(baseKeymap)], raw, cellStart(raw, 3), {
      key: "Backspace",
      keyCode: 8,
    });
    expect(cellsOf(res.doc)).toHaveLength(3);
    expect(cellTexts(res.doc)).toEqual(["A", "B", "12"]);
  });

  it("守卫 + 完整插件链（buildKeymap → baseKeymap）：每一格的格首/格尾退格与删除都不改结构", () => {
    // 这条才是**对所有位置都成立**的保证。
    // 为什么不能只靠 schema 的 isolating：实测（见上一个 describe）它有位置覆盖盲区 ——
    // 挡得住"有内容的格首"，却挡不住"前邻是空格"的格首（`|  | 2 |` 里把光标放到 "2" 的
    // 格首按退格，isolating 下仍然 4 格 → 3 格）。守卫按"光标是否贴在格的**内容边界**"
    // 判定，与前后邻格是什么无关，因此没有这个盲区。
    // 插件顺序与生产一致：守卫在前、baseKeymap 在后（editor.ts）。
    for (const md of [
      "| A | B |\n| --- | --- |\n|  | 2 |\n",
      "| A | B |\n| --- | --- |\n| 1 | 2 |\n",
      MD3,
    ]) {
      const doc = markdownToDoc(md);
      const before = cellsOf(doc);
      const texts = cellTexts(doc);
      for (let i = 0; i < before.length; i++) {
        const start = cellStart(doc, i);
        const end = start + doc.nodeAt(start - 1)!.content.size;
        for (const [pos, key] of [
          [start, "Backspace"],
          [start, "Delete"],
          [end, "Backspace"],
          [end, "Delete"],
        ] as Array<[number, string]>) {
          const res = runKeymapChain([buildKeymap(), keymap(baseKeymap)], doc, pos, {
            key,
            keyCode: key === "Backspace" ? 8 : 46,
          });
          expect(cellTexts(res.doc), `${md} / cell ${i} @${pos} ${key}`).toEqual(texts);
          expect(cellsOf(res.doc).length, `${md} / cell ${i} @${pos} ${key}`).toBe(
            before.length,
          );
        }
      }
    }
  });

  it("buildKeymap() 单独在格首退格 → 吞键且 doc 一字不动", () => {
    const doc = markdownToDoc("| A | B |\n| --- | --- |\n| 1 | 2 |\n");
    const start = cellStart(doc, 2);
    const res = runKeymapChain([buildKeymap()], doc, start, {
      key: "Backspace",
      keyCode: 8,
    });
    expect(res.handled).toBe(true);
    expect(cellTexts(res.doc)).toEqual(["A", "B", "1", "2"]);
  });
});

describe("需求3 · 空单元格里连续 Backspace 绝不改变表格结构", () => {
  it("cell 数、每格文本、相邻格文本在 5 次退格后全部不变", () => {
    const { view } = mount(MD3);
    const start = cellStart(view.state.doc, 3); // 第一数据行第 1 格："1"
    // 先把该格内容清空（模拟"用户已把这一格删干净"）
    view.dispatch(view.state.tr.delete(start, start + 1));
    const before = cellsOf(view.state.doc);
    expect(before.filter((c) => c.text === "").length).toBe(1);
    expect(before).toHaveLength(9);

    for (let i = 0; i < 5; i++) {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start)));
      const ev = realKeyDown(view, "Backspace");
      // 边界上必须被吞（阻止默认行为），但 doc 不产生任何事务效果
      expect(ev.defaultPrevented).toBe(true);
    }

    const after = cellsOf(view.state.doc);
    expect(after).toHaveLength(9);
    expect(after).toEqual(before);
    // 右邻格（"2"）的内容**没有**左移进来：被清空的是我们删的那一格（下标 3），
    // "2" 仍稳稳待在下标 4。
    // （旧断言把空串写在下标 4 上 —— 那是 cellStart 串位时代的产物，现已修正。）
    expect(cellTexts(view.state.doc)).toEqual(["A", "B", "C", "", "2", "3", "4", "5", "6"]);
  });

  it("含合并格的表格里格首退格也不塌格（跨度与格数全保持）", () => {
    const md = '| A | B | C |\n| --- | --- | --- |\n| <td colspan="2">X</td> | 3 |\n';
    const { view } = mount(md);
    const before = cellsOf(view.state.doc);
    expect(before.filter((c) => c.colspan === 2)).toHaveLength(1);
    // 落入合并主格（文档顺序第 3 格）的格首
    const start = cellStart(view.state.doc, 3);
    for (let i = 0; i < 3; i++) {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start)));
      realKeyDown(view, "Backspace");
    }
    const after = cellsOf(view.state.doc);
    expect(after).toHaveLength(before.length);
    expect(after).toEqual(before);
    expect(docToMarkdown(view.state.doc)).toContain('<td colspan="2">X</td>');
  });
});

describe("需求3 · 光标不在边界时删除能力零损失", () => {
  it("格中退格：守卫不吞键（defaultPrevented=false），逐字符删除仍可用", () => {
    const { view } = mount("| A | B |\n| --- | --- |\n| abc | 2 |\n");
    const start = cellStart(view.state.doc, 2);
    // 光标停在 "abc" 中间
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start + 1)));
    const ev = realKeyDown(view, "Backspace");
    // 关键：守卫在非边界处必须放行 —— 阻止默认行为等于"吞掉"，会连字符删除一起吞掉
    expect(ev.defaultPrevented).toBe(false);

    // jsdom 不执行 contenteditable 的原生字符删除，这里用与浏览器原生删除**等价**
    // 的事务代替（守卫的职责只是"不干涉"，故此处断言的是"原生路径确实能删一个字符"）
    view.dispatch(view.state.tr.delete(start, start + 1));
    expect(cellTexts(view.state.doc)).toEqual(["A", "B", "bc", "2"]);
    expect(cellsOf(view.state.doc)).toHaveLength(4);
  });

  it("格尾 Delete：守卫不吞键，逐字符删除仍可用", () => {
    const { view } = mount("| A | B |\n| --- | --- |\n| 1 | abc |\n");
    const start = cellStart(view.state.doc, 3);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start + 1)));
    const ev = realKeyDown(view, "Delete");
    expect(ev.defaultPrevented).toBe(false);
    view.dispatch(view.state.tr.delete(start + 1, start + 2));
    expect(cellTexts(view.state.doc)).toEqual(["A", "B", "1", "ac"]);
    expect(cellsOf(view.state.doc)).toHaveLength(4);
  });

  it("把一格删空的全过程：只有这一格在变，邻格恒定", () => {
    const { view } = mount("| A | B |\n| --- | --- |\n| xyz | 2 |\n");
    const neighbours = () => cellTexts(view.state.doc).filter((_, i) => i !== 2);
    const n0 = neighbours();
    // 光标放到格尾，反复「退格」直到格空；之后守卫接管（吞键、什么都不发生）。
    //
    // ⚠️ v0.13.1 返修：旧写法 `Math.min(格尾, 当前选区)` 会在第一轮就把光标
    // 拉到更小的"当前位置"（初始选区常在文档开头），于是整个循环删的都不是这一格。
    // 这里每次显式把光标重新放到**当前格尾**（格内容在缩短，格尾要重算）。
    for (let i = 0; i < 8; i++) {
      const s = cellStart(view.state.doc, 2);
      const cell = view.state.doc.nodeAt(s - 1)!;
      const caret = s + cell.content.size; // 当前格尾
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, caret)));
      const ev = realKeyDown(view, "Backspace");
      // 非边界：守卫放行（浏览器原生逐字符删除）；边界：守卫吞键。
      if (!ev.defaultPrevented && caret > s) {
        view.dispatch(view.state.tr.delete(caret - 1, caret));
      }
    }
    expect(cellTexts(view.state.doc)[2]).toBe("");
    expect(neighbours()).toEqual(n0);
    expect(cellsOf(view.state.doc)).toHaveLength(4);
  });
});

describe("需求3 · Delete 在格尾不得把右格内容拉进来", () => {
  it("格尾 Delete：格数与两侧文本完全不变", () => {
    const { view } = mount(MD3);
    const start = cellStart(view.state.doc, 3); // "1"
    const before = cellsOf(view.state.doc);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start + 1)));
    const ev = realKeyDown(view, "Delete");
    expect(ev.defaultPrevented).toBe(true);
    expect(cellsOf(view.state.doc)).toEqual(before);
    // 右邻格 "2" 没有被合并/左移
    expect(cellTexts(view.state.doc)).toEqual(["A", "B", "C", "1", "2", "3", "4", "5", "6"]);
  });

  it("空格的格尾连续 Delete：结构不变", () => {
    const { view } = mount("| A | B |\n| --- | --- |\n|  | 2 |\n");
    const start = cellStart(view.state.doc, 2); // 空格
    const before = cellsOf(view.state.doc);
    for (let i = 0; i < 4; i++) {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start)));
      realKeyDown(view, "Delete");
    }
    expect(cellsOf(view.state.doc)).toEqual(before);
    expect(cellTexts(view.state.doc)).toEqual(["A", "B", "", "2"]);
  });
});

describe("需求3 · Mod-Backspace / Mod-Delete 同样不得跨格", () => {
  it("Ctrl+Backspace 在格首 → 吞键、结构不变", () => {
    const { view } = mount(MD3);
    const start = cellStart(view.state.doc, 3);
    const before = cellsOf(view.state.doc);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start)));
    const ev = realKeyDown(view, "Backspace", { ctrlKey: true, keyCode: 8 });
    expect(ev.defaultPrevented).toBe(true);
    expect(cellsOf(view.state.doc)).toEqual(before);
  });

  it("Ctrl+Delete 在格尾 → 吞键、结构不变", () => {
    const { view } = mount(MD3);
    const start = cellStart(view.state.doc, 3);
    const before = cellsOf(view.state.doc);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start + 1)));
    const ev = realKeyDown(view, "Delete", { ctrlKey: true, keyCode: 46 });
    expect(ev.defaultPrevented).toBe(true);
    expect(cellsOf(view.state.doc)).toEqual(before);
  });

  it("Ctrl+Backspace 在格中 → 不吞键（原生的按词删除仍然可用）", () => {
    const { view } = mount("| A | B |\n| --- | --- |\n| hello world | 2 |\n");
    const start = cellStart(view.state.doc, 2);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start + 9)));
    const ev = realKeyDown(view, "Backspace", { ctrlKey: true, keyCode: 8 });
    expect(ev.defaultPrevented).toBe(false);
    expect(cellsOf(view.state.doc)).toHaveLength(4);
  });
});

describe("需求3 · Shift-Backspace 保持原生语义（未被登记为边界守卫）", () => {
  it("非空选区上 Shift+Backspace 删除选区（而不是被吞在边界上）", () => {
    const { view } = mount("| A | B |\n| --- | --- |\n| xy | 2 |\n");
    const start = cellStart(view.state.doc, 2);
    // 选中 "x"（非空选区）
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, start, start + 1)),
    );
    const ev = realKeyDown(view, "Backspace", { shiftKey: true, keyCode: 8 });
    // Shift-Backspace 未登记在守卫里，走的仍是 baseKeymap 的
    // `deleteSelection` 分支（选区删除**本来就只影响本格**）。
    // 断言可观测结果：doc 结构完好、格数不变、选区被删掉的内容只在两格之一内。
    expect(ev.defaultPrevented).toBe(true);
    expect(cellsOf(view.state.doc)).toHaveLength(4);
    expect(cellTexts(view.state.doc).slice(0, 4)).toEqual(["A", "B", "y", "2"]);
  });

  it("格中 Shift+Backspace 同样不吞键（保留原生退格语义）", () => {
    const { view } = mount("| A | B |\n| --- | --- |\n| ab | 2 |\n");
    const start = cellStart(view.state.doc, 2);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start + 2)));
    const ev = realKeyDown(view, "Backspace", { shiftKey: true, keyCode: 8 });
    // 非空选区/非边界都不是本守卫的作用面 → 不能 preventDefault
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe("需求3 · 光标始终留在本格（不被移动到邻格）", () => {
  it("格首退格后选区仍在原格内部", () => {
    const { view } = mount(MD3);
    const start = cellStart(view.state.doc, 3);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start)));
    realKeyDown(view, "Backspace");
    expect(view.state.selection.from).toBe(start);
    // 该位置仍解析在同一格内
    const $from = view.state.selection.$from;
    let inCell = false;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type.name === "table_cell") inCell = true;
    }
    expect(inCell).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════
// 需求4：对齐的作用面
// ══════════════════════════════════════════════════════════

describe("需求4 · setRangeAlign 纯函数契约", () => {
  function tableOf(doc: PMNode): { pos: number; node: PMNode } {
    let pos = -1;
    let node: PMNode | null = null;
    doc.descendants((n, p) => {
      if (n.type.name === "table" && pos < 0) {
        pos = p;
        node = n;
        return false;
      }
      return true;
    });
    if (!node) throw new Error("doc 无 table");
    return { pos, node };
  }

  function alignOf(doc: PMNode): string[] {
    return cellsOf(doc).map((c) => c.align);
  }

  it("只改矩形内的锚点格，矩形外的格（含同列其它行）保持原样", () => {
    const st = EditorState.create({ doc: markdownToDoc(MD3) });
    const { pos, node } = tableOf(st.doc);
    const out = setRangeAlign(st.tr, pos, node, { r0: 1, c0: 0, r1: 1, c1: 1 }, "right");
    expect(out).not.toBeNull();
    const next = st.apply(out!);
    // 只有 (1,0) 与 (1,1) 变 right
    expect(alignOf(next.doc)).toEqual([
      "left", "left", "left",
      "right", "right", "left",
      "left", "left", "left",
    ]);
  });

  it("无改动时返回 null（不产生空事务）", () => {
    const st = EditorState.create({ doc: markdownToDoc(MD3) });
    const { pos, node } = tableOf(st.doc);
    expect(setRangeAlign(st.tr, pos, node, { r0: 1, c0: 0, r1: 1, c1: 1 }, "left")).toBeNull();
  });

  it("含合并格时按**逻辑列**定位（物理下标会改错列）", () => {
    // 第一数据行前两列合并：该行物理上只有 2 个 cell，第 2 个的逻辑列是 2
    const md = '| A | B | C |\n| --- | --- | --- |\n| <td colspan="2">X</td> | 3 |\n';
    const st = EditorState.create({ doc: markdownToDoc(md) });
    const { pos, node } = tableOf(st.doc);
    // 只改逻辑列 2（= 物理第 2 格 "3"）
    const out = setRangeAlign(st.tr, pos, node, { r0: 1, c0: 2, r1: 1, c1: 2 }, "center");
    expect(out).not.toBeNull();
    const next = st.apply(out!);
    const cells = cellsOf(next.doc);
    // v0.13.2 返修：markdown-it 按表头源列数（3）补齐出来的行尾空单元格，
    // 现在会在**解析阶段**被 `trimTablePlaceholderCells` 裁掉（否则重开文档后
    // 合并的那一行会多出一格，破坏表格结构）。因此这里是 3 + 2 = 5 个 cell。
    expect(cells.map((c) => `${c.text}:${c.align}`)).toEqual([
      "A:left", "B:left", "C:left",
      "X:left", "3:center",
    ]);
    // 关键回归点：改的是**逻辑列 2**（"3"），而不是物理下标 2（那会落到幻影格上）
    expect(cells.find((c) => c.text === "3")!.align).toBe("center");
    expect(cells.find((c) => c.text === "X")!.align).toBe("left");
  });

  it("跨度格落在矩形内时整体改对齐（一个格子的 align 无法只改一半）", () => {
    const md = '| A | B | C |\n| --- | --- | --- |\n| <td colspan="2">X</td> | 3 |\n';
    const st = EditorState.create({ doc: markdownToDoc(md) });
    const { pos, node } = tableOf(st.doc);
    // 矩形覆盖逻辑列 0..0 —— 正是合并主格的锚点列，它整体变 right
    const out = setRangeAlign(st.tr, pos, node, { r0: 1, c0: 0, r1: 1, c1: 0 }, "right");
    expect(out).not.toBeNull();
    const next = st.apply(out!);
    const spanCell = cellsOf(next.doc).find((c) => c.text === "X")!;
    expect(spanCell.align).toBe("right");
    expect(spanCell.colspan).toBe(2);
  });

  it("非 table 节点 / 非法矩形 → null", () => {
    const st = EditorState.create({
      doc: markdownToDoc("普通段落"),
    });
    const para = st.doc.child(0);
    expect(setRangeAlign(st.tr, 0, para, { r0: 0, c0: 0, r1: 0, c1: 0 }, "center")).toBeNull();
  });
});

describe("需求4 · 工具栏：有范围选区 → 只改选中的格；无 → 整列", () => {
  it("表头行范围 (0,0)-(0,1) 点居中对齐 → 只有这两格的 align 变", () => {
    const { view, host, cells } = mountTableWithRects();
    dragRange(cells[0], cells[1], [50, 15], [150, 15]);
    // 把光标放进表格，工具栏才会显示
    caretIn(view, 0, 0);
    mouseOn(cells[0], "click", 50, 15);

    const before = cellsOf(view.state.doc);
    const btn = alignBtn(host, "center");
    expect(btn).toBeTruthy();
    clickBtn(btn!);

    const after = cellsOf(view.state.doc);
    expect(after.map((c) => c.align)).toEqual([
      "center", "center", "left",
      "left", "left", "left",
      "left", "left", "left",
    ]);
    // 文本与格数不动
    expect(after.map((c) => c.text)).toEqual(before.map((c) => c.text));
    expect(after).toHaveLength(9);
  });

  it("数据行范围 (1,0)-(1,1) 点右对齐 → 只有该行这两格变（列内其余行不变）", () => {
    const { view, host, cells } = mountTableWithRects();
    // cells 顺序 = th×3 + 第 1 数据行×3 + 第 2 数据行×3
    dragRange(cells[3], cells[4], [50, 45], [150, 45]);
    caretIn(view, 3, 0);
    mouseOn(cells[3], "click", 50, 45);

    clickBtn(alignBtn(host, "right")!);
    expect(cellsOf(view.state.doc).map((c) => c.align)).toEqual([
      "left", "left", "left",
      "right", "right", "left",
      "left", "left", "left",
    ]);
  });

  it("无范围选区（仅光标在格内）点居中对齐 → 整列所有行（含表头）都变", () => {
    const { view, host, cells } = mountTableWithRects();
    // 不拖拽 → cellRange 为 null
    caretIn(view, 4, 0); // 第 1 数据行第 2 格 "2"
    mouseOn(cells[4], "click", 150, 45);

    clickBtn(alignBtn(host, "center")!);
    expect(cellsOf(view.state.doc).map((c) => c.align)).toEqual([
      "left", "center", "left",
      "left", "center", "left",
      "left", "center", "left",
    ]);
  });

  it("先有范围、清掉后（重新点击）→ 回到整列语义", () => {
    const { view, host, cells } = mountTableWithRects();
    dragRange(cells[0], cells[1], [50, 15], [150, 15]);
    caretIn(view, 0, 0);
    mouseOn(cells[0], "click", 50, 15);
    // 在格内重新按下（onRangeMouseDown 会 clearCellRange）→ 范围作废
    mouseOn(cells[0], "mousedown", 50, 15, 1);
    mouseOn(cells[0], "mouseup", 50, 15, 0);
    clickBtn(alignBtn(host, "right")!);
    // 又变回整列：第 1 列全部 right
    expect(cellsOf(view.state.doc).map((c) => c.align)).toEqual([
      "right", "left", "left",
      "right", "left", "left",
      "right", "left", "left",
    ]);
  });
});

describe("需求4 · 按钮 title 如实说明作用面，并随范围实时刷新", () => {
  it("无范围 → 整列文案；拖出范围 → 选中单元格文案", () => {
    const { view, host, cells } = mountTableWithRects();
    caretIn(view, 0, 0);
    mouseOn(cells[0], "click", 50, 15);

    // 初始（工具栏创建时已调用 refreshAlignButtons）：整列
    expect(alignBtn(host, "left")!.title).toBe(t("table.alignLeftColumn"));
    expect(alignBtn(host, "center")!.title).toBe(t("table.alignCenterColumn"));
    expect(alignBtn(host, "right")!.title).toBe(t("table.alignRightColumn"));

    // 拖出范围 → onRangeMouseMove 里会同步刷新
    dragRange(cells[0], cells[1], [50, 15], [150, 15]);
    expect(alignBtn(host, "left")!.title).toBe(t("table.alignLeftRange"));
    expect(alignBtn(host, "center")!.title).toBe(t("table.alignCenterRange"));
    expect(alignBtn(host, "right")!.title).toBe(t("table.alignRightRange"));
  });

  it("范围生效期间点对齐后 title 保持范围口径（不退回整列）", () => {
    const { view, host, cells } = mountTableWithRects();
    dragRange(cells[0], cells[1], [50, 15], [150, 15]);
    caretIn(view, 0, 0);
    mouseOn(cells[0], "click", 50, 15);
    clickBtn(alignBtn(host, "center")!);
    expect(alignBtn(host, "center")!.title).toBe(t("table.alignCenterRange"));
  });
});

describe("需求4 · 往返：对齐的持久化能力（如实记录 GFM 的列级限制）", () => {
  /** 应用范围对齐后做一次 docToMarkdown → markdownToDoc */
  function roundTrip(doc: PMNode, rect: { r0: number; c0: number; r1: number; c1: number }, align: "left" | "center" | "right"): PMNode {
    const st = EditorState.create({ doc });
    let pos = -1;
    let node: PMNode | null = null;
    doc.descendants((n, p) => {
      if (n.type.name === "table" && pos < 0) {
        pos = p;
        node = n;
        return false;
      }
      return true;
    });
    const out = setRangeAlign(st.tr, pos, node!, rect, align);
    expect(out).not.toBeNull();
    const next = st.apply(out!);
    return markdownToDoc(docToMarkdown(next.doc));
  }

  it("表头行范围的对齐**能**在往返后保留（选中格的对齐不变）", () => {
    const back = roundTrip(markdownToDoc(MD3), { r0: 0, c0: 0, r1: 0, c1: 1 }, "center");
    const cells = cellsOf(back);
    // 选中的两格（表头 A / B）往返后仍是 center —— 这正是"选中单元格对齐必须保留"的验收点
    expect(cells[0].align).toBe("center");
    expect(cells[1].align).toBe("center");
    // 未选中的第 3 列（表头 C）不受影响
    expect(cells[2].align).toBe("left");
    // 序列化后的分隔行确实表达了这两列
    expect(docToMarkdown(back)).toContain(":---:");
  });

  it("[如实记录] 表头行范围的对齐会**顺带**覆盖同列数据行 —— GFM 分隔行是列级语法", () => {
    const back = roundTrip(markdownToDoc(MD3), { r0: 0, c0: 0, r1: 0, c1: 1 }, "center");
    const cells = cellsOf(back);
    // markdown-it 的表头分隔行只带"列"信息，无法表达"仅表头这一格居中"：
    // 于是同列的 1 / 4 也被解析成 center。这是**保存格式的固有上限**，
    // 不是本函数的事务行为问题（事务本身只改了选中的两格，见上面的纯函数测试）。
    expect(cells[3].align).toBe("center");
    expect(cells[6].align).toBe("center");
    // 未被选中的第 3 列不受影响
    expect(cells[5].align).toBe("left");
    expect(cells[8].align).toBe("left");
  });

  it("[如实记录] 数据行范围的对齐**无法**在往返后保留（保存格式不表达格级对齐）", () => {
    const back = roundTrip(
      markdownToDoc(MD3),
      { r0: 1, c0: 0, r1: 1, c1: 1 },
      "right",
    );
    const cells = cellsOf(back);
    // 事务层确实只改了 (1,0)/(1,1)（见 setRangeAlign 测试），但序列化端目前
    // **只**通过 GFM 分隔行表达对齐（列级），没有 `text-align` 的格级输出，
    // 因此数据行上的格级对齐在存盘往返后会丢失。
    // 按需求约定：这里断言**实际观测到的行为**并把限制写清楚，
    // 而不是把断言悄悄放宽成"只要能跑通就行"。
    // ⚠️ 若要实现"数据行格级对齐也持久化"，需要在 serializer 的
    //    `serializeGridRow` 里为 align ≠ 列值的格子输出 `<td ... style="text-align:...">`,
    //    而 serializer.ts 不在本次改动的文件范围内（由调用方决定是否跟进）。
    expect(cells[3].align).toBe("left");
    expect(cells[4].align).toBe("left");
    // 往返后表格结构本身完好（没有丢表/丢行）
    expect(cells).toHaveLength(9);
    expect(cells.map((c) => c.text)).toEqual(["A", "B", "C", "1", "2", "3", "4", "5", "6"]);
  });

  it("整列（无范围）对齐的往返保持——旧行为零回归", () => {
    // 用 setRangeAlign 覆盖整列（等价于无范围时的 setColumnAlign 效果）
    const back = roundTrip(markdownToDoc(MD3), { r0: 0, c0: 0, r1: 3, c1: 0 }, "center");
    const cells = cellsOf(back);
    expect(cells.filter((_, i) => i % 3 === 0).map((c) => c.align)).toEqual([
      "center", "center", "center",
    ]);
    expect(cells.filter((_, i) => i % 3 !== 0).map((c) => c.align)).toEqual([
      "left", "left", "left", "left", "left", "left",
    ]);
  });
});
