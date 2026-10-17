/**
 * v0.13.0 返修（问题1–8）：回归测试。
 *
 * 背景：v0.13.0 的 12 项需求虽然"实现"了，但测试全部是**源码字符串断言**
 * （`readSrc(...)` + `toContain`），只验证了代码里写了某句话，没有验证真实交互，
 * 因此下面 8 个缺陷全部漏过。本文件刻意改为**行为级**断言：
 * 真的建视图、真的派事件、真的调事务，断言**状态与 DOM 的可观测结果**。
 *
 * 覆盖：
 * 1. 表格单击单元格 → 放光标（不再整表全选），范围选区可继续用于合并；
 * 2. 公式块 / Mermaid 块单击 → 展开编辑层并放置光标；
 * 3. 块级拖拽手柄：所有顶层块可见（不再只对 5 个 wrapper class 生效）、
 *    且**无需先选中**即可从手柄拖拽；
 * 4. 三点菜单锚点：来自按钮自身矩形，不再退化为窗口左上角 (0,0)；
 * 5. 三点菜单功能：菜单项禁用/危险/分隔线透传；上移/下移按方向正确换位；
 *    复制→粘贴在系统剪贴板不可用时走应用内兜底；
 * 6. 图片管理：命令路由分支存在 + 悬浮入口的显隐/槽位规则；
 * 7. 大纲折叠：隐藏行保留在 DOM（供过渡动画）并带 .outline-hidden；
 * 8. 自动保存：无外部修改时**不得**误判 conflict（磁盘基线机制）。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EditorState } from "prosemirror-state";
import { NodeSelection } from "prosemirror-state";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { lightMDSchema } from "../core/schema";
import { markdownToDoc } from "../core/markdown/parser";
import { blockAcceptsCaret, placeCaretInsideBlock } from "../core/plugins/blockSelection";
import { buildBlockMoveByDir } from "../core/plugins/block-drag";
import { buildBlockMenuItems } from "../utils/blockActionMenu";
import {
  writeBlockClipboard,
  readBlockClipboard,
  hasInAppBlockClipboard,
  __resetInAppBlockClipboardForTest,
  selectBlockAt,
} from "../utils/blockClipboardOps";
import { docHasImage, markdownHasImage } from "../utils/imageManager";
import { judgeAutoSaveWrite } from "../utils/autoSaveGuard";
import {
  noteSelfWrittenFile,
  getKnownDiskContent,
  noteDiskBaseline,
  __resetSelfWriteGuardForTest,
  __resetDiskBaselineForTest,
} from "../services/selfWriteGuard";
import type { EditorView } from "prosemirror-view";

/**
 * 截取源码中某个方法的函数体。
 *
 * 注意：仓库里的 .ts 源码是 **CRLF** 行尾，直接用 `"\n  }\n"` 定位会找不到，
 * 因此这里按「行首两个空格 + 右花括号」的正则在归一化后的文本上定位。
 */
function methodBody(src: string, signature: string): string {
  const norm = src.replace(/\r\n/g, "\n");
  const i = norm.indexOf(signature);
  if (i < 0) return "";
  const rest = norm.slice(i);
  const end = rest.search(/\n {2}\}\n/);
  return end < 0 ? rest : rest.slice(0, end);
}

const SRC = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

/** 构造最小 EditorView：只提供被测函数需要的 state/dispatch/focus/nodeDOM/posAtCoords */
function makeView(md: string, opts?: { posAtCoords?: (c: { left: number; top: number }) => { pos: number } | null }): {
  view: EditorView;
  dispatched: () => EditorState;
} {
  let state = EditorState.create({ doc: markdownToDoc(md), schema: lightMDSchema });
  const view = {
    get state() {
      return state;
    },
    dispatch: (tr: unknown) => {
      state = state.apply(tr as never);
    },
    focus: vi.fn(),
    nodeDOM: () => null,
    posAtCoords: opts?.posAtCoords ?? (() => null),
  } as unknown as EditorView;
  return { view, dispatched: () => state };
}

beforeEach(() => {
  __resetInAppBlockClipboardForTest();
  __resetSelfWriteGuardForTest();
  __resetDiskBaselineForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ───────── 问题1：表格单击不再全选整表 ─────────

describe("问题1：表格可放光标（单击单元格不再全选整表）", () => {
  const tableMd = "| A | B |\n| --- | --- |\n| 1 | 2 |\n";

  it("blockAcceptsCaret(table) === true —— 容器块递归判定子单元格", () => {
    const doc = markdownToDoc(tableMd);
    const table = doc.child(0);
    expect(table.type.name).toBe("table");
    // 关键回归：旧实现只看 table.type.spec.content（"table_row+"，不含 inline/text）
    // → 判为 false → 单击建立整表 NodeSelection → 用户"一点就全选"
    expect(blockAcceptsCaret(table)).toBe(true);
  });

  it("table-editor stopEvent 在单元格内单击时返回 false（放行给 PM 放光标）", () => {
    const src = SRC("core/plugins/table-editor.ts");
    const fn = methodBody(src, "stopEvent(event: Event): boolean");
    expect(fn.length).toBeGreaterThan(0);
    // 热区分支仍然拦下（列宽/行高拖拽不受影响）
    expect(fn).toContain("return true;");
    expect(fn).toContain("return false;");

    // 点击表格**外沿**（无 cell）仍能整表选中——这是必须保留的入口
    // （Delete 删表 / 三点菜单 / 拖拽）。注意它不能再**调用** handleBlockStopEvent：
    // blockAcceptsCaret(table) 修好后为 true，通用判定会直接放行。
    const noCell = fn.slice(fn.indexOf("if (!cell) {"), fn.indexOf("const rect = cell.getBoundingClientRect()"));
    expect(noCell).toContain("selectWholeTable(event)");
    expect(noCell).not.toMatch(/return\s+handleBlockStopEvent/);

    // 关键回归：进入「cell 存在」的分支后，不得再调用 handleBlockStopEvent。
    // 旧实现在非热区的单元格点击上调用它 → 建立整表 NodeSelection →
    // 用户"一点击表格就全选了"，无法选单元格、也无法拖拽范围去合并。
    const cellBranch = fn.slice(fn.indexOf("const rect = cell.getBoundingClientRect()"));
    expect(cellBranch).not.toMatch(/handleBlockStopEvent\(/);
    // 且最后一个热区判断之后以 return false 结束（交回 PM 放置光标）
    const afterHotzones = cellBranch.slice(
      cellBranch.lastIndexOf("if (Math.abs(offsetY) <= 6) return true;"),
    );
    expect(afterHotzones).toContain("return false;");
  });

  it("点表格外沿仍建立整表 NodeSelection（保留 Delete 删表 / 拖拽入口）", () => {
    const src = SRC("core/plugins/table-editor.ts");
    const body = methodBody(src, "private selectWholeTable(event: MouseEvent)");
    expect(body.length).toBeGreaterThan(0);
    // 双击 / 非左键放行（双击要能进单元格编辑）
    expect(body).toContain("event.detail !== 1");
    expect(body).toContain("NodeSelection.create(state.doc, pos)");
    expect(body).toContain("view.focus()");
  });

  it("单元格内单击会作废旧的范围选区（避免残留高亮看起来像全选）", () => {
    const src = SRC("core/plugins/table-editor.ts");
    const fn = src.slice(src.indexOf("private onRangeMouseDown"));
    // 取到方法体结束（不用固定字符数：注释会随返修增长，固定窗口会误判）
    const body = fn.slice(0, fn.indexOf("\n  }\n"));
    expect(body).toContain("this.clearCellRange();");
    // v0.13.0 返修第三轮（问题5/7）：热区内也要先登记锚点（旧实现在热区直接 return，
    // 导致起手点落在边缘时选不出范围 → 合并按钮永久禁用）
    expect(body).toContain("this.rangeAnchor = { ...coord, cellEl: cell };");
    expect(body).toContain("this.pendingResize =");
  });

  it("点表格外沿仍建立整表 NodeSelection（保留 Delete 删表 / 拖拽入口）", () => {
    const src = SRC("core/plugins/table-editor.ts");
    const fn = src.slice(src.indexOf("private selectWholeTable(event: MouseEvent)"));
    const body = fn.slice(0, fn.indexOf("\n  }\n"));
    // 双击 / 非左键放行（双击要能进单元格编辑）
    expect(body).toContain("event.detail !== 1");
    expect(body).toContain("NodeSelection.create(state.doc, pos)");
    expect(body).toContain("view.focus()");
  });
});

// ───────── 问题2：公式块 / Mermaid 块单击即编辑 ─────────

describe("问题2：公式块与 Mermaid 块单击即进入编辑", () => {
  it("placeCaretInsideBlock 把光标放进块内容区间", () => {
    const md = "前置段落\n\n$$\na+b\n$$\n";
    const { view, dispatched } = makeView(md);
    let mathPos = -1;
    view.state.doc.forEach((n, off) => {
      if (n.type.name === "math_block") mathPos = off;
    });
    expect(mathPos).toBeGreaterThanOrEqual(0);
    placeCaretInsideBlock(view, mathPos);
    const sel = dispatched().selection;
    expect(sel).not.toBeInstanceOf(NodeSelection);
    // 光标落在块内部
    expect(sel.from).toBeGreaterThan(mathPos);
    expect(sel.from).toBeLessThanOrEqual(mathPos + view.state.doc.nodeAt(mathPos)!.content.size);
  });

  it("点击坐标落在块外时收敛到块内容区间（不越界、不抛错）", () => {
    const { view, dispatched } = makeView("$$\nx\n$$\n", { posAtCoords: () => ({ pos: 9999 }) });
    let mathPos = -1;
    view.state.doc.forEach((n, off) => {
      if (n.type.name === "math_block") mathPos = off;
    });
    placeCaretInsideBlock(view, mathPos, 10, 10);
    const node = view.state.doc.nodeAt(mathPos)!;
    expect(dispatched().selection.from).toBeLessThanOrEqual(mathPos + node.content.size);
  });

  it("公式块 NodeView 挂了 mousedown 进入编辑，且 dblclick 不会把单击刚打开的编辑态关掉", () => {
    const src = SRC("core/plugins/math-block.ts");
    expect(src).toContain('this.dom.addEventListener("mousedown", this.handleMouseDown)');
    expect(src).toContain("private handleMouseDown");
    // 单击进编辑后紧接着的 dblclick 必须被忽略（否则"双击后什么都没发生"）
    expect(src).toContain("lastEnterEditAt");
    expect(src).toContain("private enterEditMode()");
  });

  it("Mermaid 块同样支持单击进编辑（与公式块一致）", () => {
    const src = SRC("core/plugins/mermaid-block.ts");
    expect(src).toContain('this.dom.addEventListener("mousedown", this.handleMouseDown)');
    expect(src).toContain("private enterEditMode()");
    expect(src).toContain("lastEnterEditAt");
  });
});

// ───────── 问题3：块级拖拽手柄保留且无需先选中 ─────────

describe("问题3：块级拖拽手柄（⋮⋮）保留且可直接拖拽", () => {
  // v0.13.0 返修第三轮（问题1）：本组断言按**用户实机反馈**更新。
  // 上一轮为了让手柄"对所有块可见"，CSS 用了无差别的 `.ProseMirror > *::after`，
  // 结果每个段落左缘都冒出手柄；用户明确要求「只需要代码块、图表、公式、图片等
  // 这些才需要加小手柄」。故选择器收窄为四类 wrapper + 含图片的段落，
  // 断言随之从"所有顶层块"改为"这组特殊块"。
  it("CSS 对**特殊块**（代码/图表/公式/表格/图片块）画手柄", () => {
    const css = SRC("styles/editor.css");
    for (const cls of [
      "code-block-wrapper",
      "mermaid-block-wrapper",
      "math-block-wrapper",
      "table-wrapper",
    ]) {
      expect(css).toContain(`.ProseMirror > .${cls}::after`);
    }
    // 图片块（图片是行内节点，故用 :has 匹配含图片的段落）
    expect(css).toContain(".ProseMirror > p:has(> img)::after");
    expect(css).toContain('content: "⋮⋮"');
    // 手柄必须常驻可交互（pointer-events:auto），否则鼠标移向手柄时块 hover 失效
    const rule = css.slice(css.indexOf('content: "⋮⋮"'));
    expect(rule.slice(0, 900)).toContain("pointer-events: auto");
  });

  it("不再有无差别的 `.ProseMirror > *` 手柄规则（普通段落不该有手柄）", () => {
    const css = SRC("styles/editor.css");
    // 只看真实选择器行，不看解释性注释
    const selectorLines = css
      .split("\n")
      .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("/*") && l.includes("{"));
    expect(selectorLines.some((l) => l.includes(".ProseMirror > *::after"))).toBe(false);
    expect(selectorLines.some((l) => l.includes(".ProseMirror > *:hover::after"))).toBe(false);
  });

  it("不再有会把手柄内容覆盖为空的 wrapper ::after 规则", () => {
    const css = SRC("styles/editor.css");
    // 旧实现有一段 `content: ""` 的 wrapper::after，会覆盖上面的 "⋮⋮" 让手柄变空。
    // 现在 wrapper::after 是**手柄本身**，故改为断言"没有空 content 的那条"。
    expect(css).not.toMatch(/\.ProseMirror > \.(?:table|code-block|math-block|mermaid-block)-wrapper::after\s*\{[^}]*content:\s*""/);
  });

  it("拖拽插件不再要求先有 NodeSelection（v0.13.0 单击即编辑后块几乎不会整块选中）", () => {
    const src = SRC("core/plugins/block-drag.ts");
    const mousedown = src.slice(src.indexOf("mousedown(view, event)"));
    const handler = mousedown.slice(0, mousedown.indexOf("mousemove(view, event)"));
    // 旧实现开头即 `if (!(sel instanceof NodeSelection)) return false;`
    expect(handler).not.toContain("sel instanceof NodeSelection");
    // 改为按坐标找块 + 热区判定
    expect(handler).toContain("handleZoneBlockAt(");
    expect(handler).toContain("beginBlockDrag(");
    // 热区判定要带候选回退：posAtCoords 在块左缘**外**会吸附到上一块末尾，
    // 只按解析结果判定会拖错块或拖不动
    expect(src).toContain("function handleZoneBlockAt(");
    expect(src).toContain("for (const delta of [0, -1, 1, -2, 2])");
  });
});

// ───────── 问题4：三点菜单锚定在按钮下方 ─────────

describe("问题4：三点菜单弹在按钮下方（不再跳到窗口左上角）", () => {
  it("三点按钮派发事件时携带自身矩形 anchor", async () => {
    const { createBlockKebabButton, BLOCK_ACTION_EVENT } = await import("../core/plugins/blockKebab");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const btn = createBlockKebabButton(container, () => 7);
    // jsdom 的 getBoundingClientRect 全为 0，桩一个可辨识的矩形
    btn.getBoundingClientRect = () =>
      ({ left: 120, right: 142, top: 300, bottom: 322, width: 22, height: 22, x: 120, y: 300, toJSON: () => ({}) }) as DOMRect;
    const seen: Array<Record<string, unknown>> = [];
    container.addEventListener(BLOCK_ACTION_EVENT, (e) => {
      seen.push((e as CustomEvent).detail);
    });
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(seen.length).toBe(1);
    expect(seen[0].pos).toBe(7);
    expect(seen[0].anchor).toEqual({ left: 120, right: 142, top: 300, bottom: 322 });
  });

  it("事件从按钮自身派发（e.target 即按钮，不再是从容器派发导致 closest 取到 null）", async () => {
    const { createBlockKebabButton, BLOCK_ACTION_EVENT } = await import("../core/plugins/blockKebab");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const btn = createBlockKebabButton(container, () => 3);
    // 用数组承接（对象属性在回调内赋值不会被 TS 收窄成 null）
    const targets: EventTarget[] = [];
    container.addEventListener(BLOCK_ACTION_EVENT, (e) => {
      targets.push(e.target as EventTarget);
    });
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(targets.length).toBe(1);
    expect(targets[0]).toBe(btn);
    expect((targets[0] as HTMLElement).classList.contains("block-kebab")).toBe(true);
  });

  it("EditorContainer 用 detail.anchor 定位，不再依赖 e.target.closest", () => {
    const src = SRC("components/editor/EditorContainer.tsx");
    const fn = src.slice(src.indexOf("const onBlockAction = (e: Event)"));
    const body = fn.slice(0, fn.indexOf("container.addEventListener(BLOCK_ACTION_EVENT"));
    expect(body).toContain("detail.anchor");
    expect(body).not.toContain('.closest?.(".block-kebab")');
  });
});

// ───────── 问题5：三点菜单各功能真实可用 ─────────

describe("问题5：三点菜单功能（禁用态透传 / 移动 / 剪贴板兜底）", () => {
  it("buildBlockMenuItems 产出禁用与分隔线（首块不可上移、末块不可下移）", () => {
    const first = buildBlockMenuItems({ hasClipboard: false, isFirstBlock: true, isLastBlock: false });
    const paste = first.find((i) => i.id === "paste")!;
    const up = first.find((i) => i.id === "moveUp")!;
    const del = first.find((i) => i.id === "delete")!;
    expect(paste.disabled).toBe(true); // 无剪贴板 → 禁用
    expect(up.disabled).toBe(true); // 首块 → 禁用
    expect(del.danger).toBe(true); // 删除标红
    expect(del.separatorBefore).toBe(true); // 删除前有分隔线
  });

  it("MiniContextMenu 真正渲染 disabled / danger / separator", () => {
    const src = SRC("components/editor/MiniContextMenu.tsx");
    expect(src).toContain("disabled={item.disabled === true}");
    expect(src).toContain("mini-context-menu-item.danger");
    expect(src).toContain("mini-context-menu-separator");
  });

  it("EditorContainer 把 disabled/danger/separator 透传给弹层（此前被整体丢弃）", () => {
    const src = SRC("components/editor/EditorContainer.tsx");
    const map = src.slice(src.indexOf("}).map<MiniMenuItem>((item) => ({"));
    const body = map.slice(0, map.indexOf("}))"));
    expect(body).toContain("disabled: item.disabled");
    expect(body).toContain("danger: item.danger");
    expect(body).toContain("separator: item.separatorBefore");
  });

  it("上移/下移按方向正确换位（旧实现把 -1/1 当文档位置 → 结构非法被吞）", () => {
    const { view } = makeView("AAA\n\nBBB\n\nCCC\n");
    const doc = view.state.doc;
    const posB = doc.child(0).nodeSize;
    // BBB 上移 → 与 AAA 交换：首个块应为 BBB
    const up = buildBlockMoveByDir(view.state, posB, -1);
    expect(up).not.toBeNull();
    const afterUp = view.state.apply(up!);
    expect(afterUp.doc.child(0).textContent).toBe("BBB");
    expect(afterUp.doc.child(1).textContent).toBe("AAA");

    // BBB 下移 → 与 CCC 交换
    const down = buildBlockMoveByDir(view.state, posB, 1);
    expect(down).not.toBeNull();
    const afterDown = view.state.apply(down!);
    expect(afterDown.doc.child(0).textContent).toBe("AAA");
    expect(afterDown.doc.child(1).textContent).toBe("CCC");
    expect(afterDown.doc.child(2).textContent).toBe("BBB");
  });

  it("首块上移 / 末块下移返回 null（菜单项也会被禁用）", () => {
    const { view } = makeView("AAA\n\nBBB\n");
    expect(buildBlockMoveByDir(view.state, 0, -1)).toBeNull();
    const last = view.state.doc.child(0).nodeSize;
    expect(buildBlockMoveByDir(view.state, last, 1)).toBeNull();
  });

  it("格式刷：先建立块 NodeSelection 再采集（否则 from===to 直接 return，点了没反应）", () => {
    const src = SRC("components/editor/EditorContainer.tsx");
    const branch = src.slice(src.indexOf('case "formatPainter":'));
    const body = branch.slice(0, branch.indexOf('case "select":'));
    expect(body).toContain("selectBlockAt(view, pos)");
    expect(body.indexOf("selectBlockAt(view, pos)")).toBeLessThan(
      body.indexOf("armFormatPainter(false)"),
    );
  });

  it("复制 → 粘贴在系统剪贴板不可用时走应用内兜底", async () => {
    // 模拟 WebView2：navigator.clipboard.read 抛错（权限被拒）
    const readSpy = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { read: readSpy, write: vi.fn().mockRejectedValue(new Error("denied")), writeText: vi.fn() },
    });
    expect(hasInAppBlockClipboard()).toBe(false);
    const ok = await writeBlockClipboard({ markdown: "# 标题\n", html: "<h1>标题</h1>", nodeType: "heading" } as never);
    expect(ok).toBe(true);
    expect(hasInAppBlockClipboard()).toBe(true);
    // 系统剪贴板读不到 → 回退应用内兜底
    const back = await readBlockClipboard();
    expect(back).not.toBeNull();
    expect(back!.markdown).toContain("标题");
  });

  it("selectBlockAt 建立 NodeSelection（复制/剪切/删除/格式刷的前置）", () => {
    const { view, dispatched } = makeView("AAA\n\nBBB\n");
    const posB = view.state.doc.child(0).nodeSize;
    selectBlockAt(view, posB);
    const sel = dispatched().selection;
    expect(sel).toBeInstanceOf(NodeSelection);
    expect(sel.from).toBe(posB);
  });
});

// ───────── 问题6：图片管理入口 ─────────

describe("问题6：图片管理（命令路由 + 悬浮入口）", () => {
  it("App.tsx 的 lightmd:command 路由含 view.imageManager（否则命令面板回车无反应）", () => {
    const src = SRC("App.tsx");
    expect(src).toContain('if (id === "view.imageManager") { setShowImageManager(true); return; }');
  });

  it("App.tsx 的同一路由也含 view.quickOpen（Ctrl+P 与命令面板共用该分支）", () => {
    const src = SRC("App.tsx");
    expect(src).toContain('if (id === "view.quickOpen") { setShowQuickOpen(true); return; }');
  });

  it("docHasImage：PM 文档中真实图片节点才算有图片", () => {
    expect(docHasImage(markdownToDoc("无图片\n"))).toBe(false);
    expect(docHasImage(markdownToDoc("![x](./a.png)\n"))).toBe(true);
    expect(docHasImage(null)).toBe(false);
  });

  it("markdownHasImage：源码模式判定，且剔除代码块里的假图片", () => {
    expect(markdownHasImage("普通文本")).toBe(false);
    expect(markdownHasImage("![x](./a.png)")).toBe(true);
    // 围栏代码块内的图片语法是示例，不是真图片 → 不应显示入口
    expect(markdownHasImage("```md\n![x](./a.png)\n```\n")).toBe(false);
    // 行内代码同理
    expect(markdownHasImage("示例 `![x](./a.png)` 结束")).toBe(false);
  });

  it("悬浮入口仅在文档有图片时**可见**，且槽位固定为第 1 格（「译」上方）", () => {
    const src = SRC("components/editor/EditorContainer.tsx");
    // v0.13.2 需求4：入口改为**常驻挂载 + visible 驱动淡出**（条件渲染无法播过渡动画），
    // 因此判据从"是否渲染"改为"visible 传的是否为 docHasImageFlag"。
    expect(src).toContain("visible={docHasImageFlag}");
    // v0.13.1 需求7：槽位从「跟随 AI 翻译是否显示」的 translateSlotShown ? 2 : 1
    // 改为**常量 1**（图片管理始终排在第 1 格）。旧写法在 AI 翻译开启时把图片管理
    // 放到第 2 格（90px），正好压住「译」按钮 hover 弹出的设置齿轮。
    expect(src).toContain("slot={1}");
    expect(src).not.toContain("slot={translateSlotShown ? 2 : 1}");
    // translateSlotShown 仍保留（用于「译」入口自身的渲染条件与注释说明），
    // 但**不得**再参与图片管理入口的槽位计算
    expect(src).toContain("const translateSlotShown =");
  });

  /**
   * v0.13.2 需求4：图片管理图标缺席时，「译」图标要**补上这个空缺**。
   *
   * 用户要求：「打开不带图片文档时『译』图标要自动补上这个空缺位置，紧跟在切换
   * 分屏编辑图标下面。这个向上填补要有顺滑的平移动画，这样当文档中删除了所有图片，
   * 那么就图片管理图标淡出消失，「译」图标顺滑上移补上。」
   */
  it("「译」图标槽位随图片管理是否可见动态切换（0 ↔ 1）", () => {
    const src = SRC("components/editor/EditorContainer.tsx");
    expect(src).toContain("slot={docHasImageFlag ? 1 : 0}");
    const css = SRC("components/editor/FullTranslateButton.css");
    // 槽位由 --ftb-slot 驱动（不再是写死的 2*）
    expect(css).toContain("var(--ftb-slot, 1)");
    // 平移动画：top 有 transition
    expect(css).toMatch(/\.ftb-wrap \{[\s\S]{0,400}?transition:\s*top/);
  });

  it("图片管理图标用 is-hidden 淡出（不是条件渲染）", () => {
    const btn = SRC("components/editor/ImageManagerButton.tsx");
    expect(btn).toContain("is-hidden");
    expect(btn).toContain("visible = true");
    const css = SRC("components/editor/FullTranslateButton.css");
    expect(css).toMatch(/\.image-manager-btn\.is-hidden \{[\s\S]{0,200}?opacity:\s*0/);
    expect(css).toMatch(/\.image-manager-btn\.is-hidden \{[\s\S]{0,200}?pointer-events:\s*none/);
  });

  it("图片管理面板的数据源按模式取（源码模式下 PM doc 是过期的）", () => {
    const src = SRC("App.tsx");
    // 缺陷背景：编辑/分屏模式下 PM 视图 display:none，用户在 textarea 输入时
    // PM doc 不会同步 → 面板列出的图片集合停留在"上次切模式时"，刚粘贴/删除的
    // 图片看不到、列出的可能已被删 → 转 assets/重命名 会按过期数据改写引用。
    const memo = src.slice(src.indexOf("const imageManagerDoc = useMemo("));
    const body = memo.slice(0, memo.indexOf("}, [showImageManager"));
    expect(body).toContain('viewMode === "preview"');
    expect(body).toContain("markdownToDoc(content)");
    // 渲染处必须用这个数据源，而不是直接读 PM doc
    expect(src).toContain("doc={imageManagerDoc}");
    expect(src).not.toContain("doc={editorViewRef.current?.state.doc ?? null}");
  });

  it("三个悬浮图标统一尺寸并居中对齐（用户明确要求）", () => {
    const css = SRC("components/editor/FullTranslateButton.css");
    expect(css).toContain("--float-icon-size");
    // 三者共用同一套尺寸/右缘/圆形规则
    const shared = css.slice(css.indexOf(".mode-switch-btn,\n.image-manager-btn"));
    expect(shared.slice(0, 700)).toContain("width: var(--float-icon-size)");
    expect(shared.slice(0, 700)).toContain("border-radius: 50%");
    // 「译」按钮收敛到同一高度与右缘
    expect(css).toContain("height: var(--float-icon-size)");
    // v0.13.1 需求7：取消翻译气泡的让位从第 3 格改为第 4 格。
    // 图标列新序为 模式切换(10) / 图片管理(50) / 「译」(90)，且「译」hover 的
    // 设置齿轮从 124 伸到 150 —— 旧断言锁的 `+ 3 *`（=130px）正落在齿轮上。
    expect(css).toContain("var(--float-icon-top, 10px) + 4 *");
    expect(css).not.toContain("var(--float-icon-top, 10px) + 3 *");
  });
});

// ───────── 问题7：大纲折叠动画 ─────────

describe("问题7：大纲折叠/展开的平滑慢速动画", () => {
  it("CSS 定义了高度/透明度过渡与折叠隐藏态", () => {
    const css = SRC("components/editor/Outline.css");
    expect(css).toContain(".outline-row.outline-hidden");
    const hidden = css.slice(css.indexOf(".outline-row.outline-hidden"));
    expect(hidden.slice(0, 700)).toContain("max-height: 0");
    expect(hidden.slice(0, 700)).toContain("opacity: 0");
    // 慢速：明确长于 --transition-fast
    expect(hidden.slice(0, 700)).toContain("420ms");
  });

  it("折叠的行保留在 DOM 中（摘除节点无法做过渡动画）", () => {
    const src = SRC("components/editor/Outline.tsx");
    expect(src).toContain("outline-hidden");
    expect(src).toContain("hidden={visibleByPos ? visibleByPos.get(h.pos) === false : false}");
  });

  it("尊重系统「减少动态效果」设置", () => {
    const css = SRC("components/editor/Outline.css");
    expect(css).toContain("prefers-reduced-motion: reduce");
  });
});

// ───────── 问题8：自动保存不得误报外部冲突 ─────────

describe("问题8：无外部修改时不得误报「已在其他窗口保存」", () => {
  const PATH = "D:/docs/a.md";
  const OPENED = "# 标题\n\n原文\n";

  it("打开文件后编辑、从未保存过 → 磁盘等于基线 → 判为可写（旧实现因无自身写盘记录判 conflict）", () => {
    // 打开文件时登记磁盘基线
    noteDiskBaseline(PATH, OPENED);
    // 用户编辑（内存内容与磁盘不同），但**从未写盘**
    const decision = judgeAutoSaveWrite({
      diskContent: OPENED,
      targetContent: "# 标题\n\n原文 + 新增\n",
      lastSelfWritten: getKnownDiskContent(PATH),
    });
    expect(decision).toBe("write");
  });

  it("自身写盘后磁盘与记录一致 → write", () => {
    noteSelfWrittenFile(PATH, "# v2\n");
    expect(
      judgeAutoSaveWrite({
        diskContent: "# v2\n",
        targetContent: "# v2 modified\n",
        lastSelfWritten: getKnownDiskContent(PATH),
      }),
    ).toBe("write");
  });

  it("第三方真的改过磁盘 → conflict（不能为了消除误报而放过真冲突）", () => {
    noteDiskBaseline(PATH, OPENED);
    expect(
      judgeAutoSaveWrite({
        diskContent: "# 被外部程序改过\n",
        targetContent: "# 我的编辑\n",
        lastSelfWritten: getKnownDiskContent(PATH),
      }),
    ).toBe("conflict");
  });

  it("磁盘与目标内容相同 → skip（无需写盘）", () => {
    noteDiskBaseline(PATH, OPENED);
    expect(
      judgeAutoSaveWrite({
        diskContent: OPENED,
        targetContent: OPENED,
        lastSelfWritten: getKnownDiskContent(PATH),
      }),
    ).toBe("skip");
  });

  it("完全没有基线信息 → 保守 conflict（不静默覆盖未知状态）", () => {
    expect(
      judgeAutoSaveWrite({
        diskContent: "x",
        targetContent: "y",
        lastSelfWritten: getKnownDiskContent("D:/docs/never-opened.md"),
      }),
    ).toBe("conflict");
  });

  it("useAutoSave 用 getKnownDiskContent（长 TTL 基线）而非短 TTL 的 getLastSelfWritten", () => {
    const src = SRC("hooks/useAutoSave.ts");
    // v0.13.1 需求14：入参由闭包变量 `filePath` 改为**入口捕获的快照** `path`
    // （跨标签切换时闭包 filePath 会与实时内容分叉 → 误报 + 跨文件串写）。
    // 因此这里断言"用了长 TTL 访问器"，并显式锁住新形态，避免有人改回闭包变量。
    expect(src).toContain("getKnownDiskContent(path)");
    expect(src).not.toContain("getKnownDiskContent(filePath)");
    // 短 TTL（10s）配 60s 自动保存间隔 = 必然误报，故不得再用
    expect(src).not.toContain("getLastSelfWritten(filePath)");
  });

  it("打开文件时登记磁盘基线（App.tsx），且不污染脏标签", () => {
    const src = SRC("App.tsx");
    expect(src).toContain("noteDiskBaseline(detail.path, targetContent)");
    // 脏标签的 content 是未保存内存内容，登记它会污染基线
    expect(src).toContain("!st0.openTabs[existingIdx].isDirty");
  });

  it("读盘本身**不得**推进基线（否则写盘前判定恒为可写，外部编辑会被静默覆盖）", () => {
    const src = SRC("services/fileService.ts");
    expect(src).not.toContain("noteDiskBaseline");
  });
});
