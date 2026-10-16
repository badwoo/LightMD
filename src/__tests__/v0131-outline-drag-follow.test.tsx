// @vitest-environment jsdom
/**
 * v0.13.1 需求11 + 需求12：大纲拖拽的**可视性**与**跟随滚动**。
 *
 * ## 需求11（用户原话）
 * 「大纲拖拽的时候，拖拽移动过程中路径会变成灰色，我需要拖动过程中能看到我拖动的标题，
 *  也能看到背景目录，也能看清拖拽的落点。」
 *
 * 旧实现的三个缺陷：
 *  ① **发灰**：`SortableHeadingItem` 内联 `opacity: isDragging ? 0.5 : 1`，CSS 里
 *     `.outline-item.dragging` 又叠一次 `opacity: .5` → 源项被淡化两遍，整个列表发灰；
 *  ② **拖动的标题看不见**：没有任何 DragOverlay，跟随光标的就是那个被淡化的真实行，
 *     而 `.outline-row { max-height:60px; overflow:hidden }` 会把位移动画裁掉
 *     （拖出约 ±30px 就消失）；
 *  ③ **落点看不清**：既无插入指示线，也无目标行高亮；
 *     而且 `SortableContext.items` 用的是含**折叠隐藏行**的列表 —— 拖拽可能落到
 *     一个 `max-height:0; visibility:hidden` 的看不见的目标上。
 *
 * ## 需求12（用户原话）
 * 「阅读文档，右侧大纲也要跟随滚动到对应的标题位置下，当前问题是大纲没有跟随滚动。」
 * 活动标题由 IntersectionObserver 算出并高亮，但**从来没有人把大纲自己滚过去**。
 *
 * ## 手法
 * 用**可驱动的** dnd-kit 替身（把 DndContext 的 props 抓出来，测试里直接触发
 * `onDragStart/onDragOver/onDragEnd`）+ 可手动触发的 IntersectionObserver，
 * 断言真实 DOM（幽灵、指示线、内联样式、滚动调用参数），不是源码字符串。
 * 仅"CSS 里不得再有 0.5 淡化"一条读 CSS 文件（jsdom 不解析样式表，只能读源）。
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { readFileSync } from "node:fs";

import { markdownToDoc } from "../core/markdown/parser";
import { lightMDSchema } from "../core/schema";
import { Outline } from "../components/editor/Outline";

// ───────── 可驱动的 dnd-kit 替身 ─────────

const dndProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
const sortableState = vi.hoisted(() => ({
  isDragging: false,
  items: [] as number[],
  renderCount: 0,
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: (props: { children?: ReactNode }) => {
    dndProps.current = props as unknown as Record<string, unknown>;
    return <>{props.children}</>;
  },
  // 替身保留 children 并打标记，便于断言"幽灵真的被渲染了"
  DragOverlay: ({ children }: { children?: ReactNode }) => (
    <div data-testid="dnd-drag-overlay">{children}</div>
  ),
  PointerSensor: class {},
  useSensor: () => ({}),
  useSensors: () => [],
  closestCenter: () => null,
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: (props: { children?: ReactNode; items?: number[] }) => {
    sortableState.items = props.items ?? [];
    sortableState.renderCount += 1;
    return <>{props.children}</>;
  },
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    transform: null,
    transition: undefined,
    isDragging: sortableState.isDragging,
  }),
  verticalListSortingStrategy: undefined,
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => undefined } },
}));

// ───────── 可手动触发的 IntersectionObserver ─────────

type IOCallback = (entries: Array<{ target: Element; isIntersecting: boolean }>) => void;
const observers: Array<{ cb: IOCallback; targets: Element[] }> = [];

beforeAll(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      cb: IOCallback;
      targets: Element[] = [];
      constructor(cb: IOCallback) {
        this.cb = cb;
        observers.push(this as unknown as { cb: IOCallback; targets: Element[] });
      }
      observe(el: Element) {
        this.targets.push(el);
      }
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  );
});

/** 触发最近一个 observer：把给定 pos 对应的 DOM 元素标为可见 */
function makeVisible(els: Element[]) {
  const obs = observers[observers.length - 1];
  act(() => {
    obs.cb(els.map((target) => ({ target, isIntersecting: true })));
  });
}

// ───────── 假 EditorView（nodeDOM 返回真实元素，供 observer 工作） ─────────

const MD = "# 一级标题\n\n## 二级 A\n\n### 三级 A1\n\n## 二级 B\n\n# 另一个一级\n";

function makeView(markdown: string): { view: EditorView; domOf: Map<number, HTMLElement> } {
  const doc = markdownToDoc(markdown);
  const state = EditorState.create({ doc, schema: lightMDSchema });
  const domOf = new Map<number, HTMLElement>();
  doc.descendants((node, pos) => {
    if (node.type.name === "heading") {
      const el = document.createElement("h1");
      el.textContent = node.textContent;
      document.body.appendChild(el);
      domOf.set(pos, el);
    }
  });
  const view = {
    state,
    dispatch: vi.fn(),
    nodeDOM: (pos: number) => domOf.get(pos) ?? null,
  } as unknown as EditorView;
  return { view, domOf };
}

/** 让 requestAnimationFrame 回调（setupObserver 内部）跑完 */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}

const scrollSpy = vi.fn();
beforeEach(() => {
  observers.length = 0;
  dndProps.current = null;
  sortableState.isDragging = false;
  sortableState.items = [];
  sortableState.renderCount = 0;
  scrollSpy.mockClear();
  // jsdom 未实现 scrollIntoView
  (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scrollSpy;
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

// ═════════ 需求11 ═════════

describe("v0.13.1 需求11：拖拽过程中看得见标题、背景目录与落点", () => {
  it("源项被标记为 dragging，但**不得**被淡化（内联 opacity 必须是空的）", async () => {
    const { view } = makeView(MD);
    const utils = render(<Outline editorView={view} />);
    sortableState.isDragging = true;
    utils.rerender(<Outline editorView={view} />);

    const dragged = document.querySelectorAll(".outline-item.dragging");
    expect(dragged.length).toBeGreaterThan(0);
    for (const el of Array.from(dragged)) {
      // 旧实现这里是 style="opacity: 0.5" → 发灰的根因之一
      expect((el as HTMLElement).style.opacity).toBe("");
    }
  });

  it("Outline.css 的 .outline-item.dragging 规则里不得再出现 0.5 淡化", () => {
    const css = readFileSync("src/components/editor/Outline.css", "utf-8");
    const start = css.indexOf(".outline-item.dragging");
    expect(start).toBeGreaterThan(-1);
    const body = css.slice(start, css.indexOf("}", start));
    expect(body).not.toContain("opacity: 0.5");
    expect(body).not.toContain("opacity: .5");
    // 也未退回叠加的通用淡化
    expect(body).toContain("outline");
  });

  it("拖拽开始 → 渲染跟随光标的实心幽灵，内容是**被拖动的标题文本**", async () => {
    const { view } = makeView(MD);
    render(<Outline editorView={view} />);
    expect(document.querySelector('[data-testid="outline-drag-ghost"]')).toBeNull();

    const firstPos = [...(view as unknown as { state: EditorState }).state.doc.content.content[0].type.name
      ? [] // 占位，避免误用
      : []];
    void firstPos;
    // 第一个标题的 pos = 0
    act(() => {
      (dndProps.current!.onDragStart as (e: unknown) => void)({ active: { id: 0 } });
    });

    const ghost = document.querySelector('[data-testid="outline-drag-ghost"]');
    expect(ghost).toBeTruthy();
    expect(ghost!.textContent).toBe("一级标题");
    // 幽灵必须是**实心**卡片（有自己的背景），否则仍会与背景目录糊在一起
    const ghostCss = readFileSync("src/components/editor/Outline.css", "utf-8");
    const gi = ghostCss.indexOf(".outline-drag-ghost");
    const gbody = ghostCss.slice(gi, ghostCss.indexOf("}", gi));
    expect(gbody).toContain("var(--bg-primary)");
    expect(gbody).toContain("box-shadow");
  });

  it("拖拽经过 → 出现落点插入线（带 top 定位），拖拽结束立即清除", async () => {
    const { view, domOf } = makeView(MD);
    render(<Outline editorView={view} />);
    await settle();

    const list = document.querySelector(".outline-list") as HTMLElement;
    // 让列表视口与内容坐标一致
    list.getBoundingClientRect = () =>
      ({ top: 100, bottom: 400, left: 0, right: 200, height: 300, width: 200, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect;
    Object.defineProperty(list, "scrollTop", { value: 0, writable: true });

    act(() => {
      (dndProps.current!.onDragStart as (e: unknown) => void)({ active: { id: 0 } });
    });
    // 悬停在第二个标题所在行（视口 top=200，高 30），指针落在其下半部
    act(() => {
      (dndProps.current!.onDragOver as (e: unknown) => void)({
        active: { id: 0 },
        over: { id: 20, rect: { top: 200, height: 30 } },
        activatorEvent: { clientY: 225 },
      });
    });

    const line = document.querySelector('[data-testid="outline-drop-indicator"]') as HTMLElement;
    expect(line).toBeTruthy();
    // top = (200+30) - 100 + 0 = 130
    expect(line.style.top).toBe("130px");

    act(() => {
      (dndProps.current!.onDragEnd as (e: unknown) => void)({ active: { id: 0 }, over: { id: 20 } });
    });
    expect(document.querySelector('[data-testid="outline-drop-indicator"]')).toBeNull();
    expect(document.querySelector('[data-testid="outline-drag-ghost"]')).toBeNull();
    void domOf;
  });

  it("折叠隐藏的行**不参与**拖拽目标（避免落到看不见的位置）", async () => {
    const { view, domOf } = makeView(MD);
    render(<Outline editorView={view} />);
    await settle();

    // 标题的 pos 由文档结构决定（不是 0/10/20），必须从实际节点取
    const positions = [...domOf.keys()].sort((a, b) => a - b);
    expect(positions).toHaveLength(5);
    const [p0, p1, p2, p3, p4] = positions;

    expect([...sortableState.items].sort((a, b) => a - b)).toEqual(positions);

    // 折叠 L1(pos=p0) → 其下 L2/L3 应移出 droppable 集合
    const toggle = document.querySelector(".outline-collapse-toggle") as HTMLElement;
    expect(toggle).toBeTruthy();
    act(() => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    });

    expect(sortableState.items).not.toContain(p1);
    expect(sortableState.items).not.toContain(p2);
    // 折叠 L1 会一路隐藏到下一个同级 L1 之前的**所有更深层级**（见
    // computeOutlineVisibility 真值表），所以 L2 的 p3 也在隐藏之列
    expect(sortableState.items).not.toContain(p3);
    // 只剩自身 p0 与下一个同级 L1 的 p4
    expect([...sortableState.items].sort((a, b) => a - b)).toEqual([p0, p4]);
  });
});

// ═════════ 需求12 ═════════

describe("v0.13.1 需求12：大纲跟随文档滚动到活动标题", () => {
  /** 让活动行"在可视带之外"，并把列表矩形桩好 */
  function setupRects(activePos: number, opts: { rowVisible?: boolean } = {}) {
    const list = document.querySelector(".outline-list") as HTMLElement;
    list.getBoundingClientRect = () =>
      ({ top: 100, bottom: 300, left: 0, right: 200, height: 200, width: 200, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect;
    const row = document.querySelector(`.outline-row[data-outline-pos="${activePos}"]`) as HTMLElement;
    expect(row).toBeTruthy();
    row.getBoundingClientRect = () =>
      opts.rowVisible
        ? ({ top: 150, bottom: 180, left: 0, right: 200, height: 30, width: 200, x: 0, y: 150, toJSON: () => ({}) } as DOMRect)
        : ({ top: 400, bottom: 430, left: 0, right: 200, height: 30, width: 200, x: 0, y: 400, toJSON: () => ({}) } as DOMRect);
    return row;
  }

  it("活动标题滚出可视区 → 平滑滚进可视区（smooth + block:nearest）", async () => {
    const { view, domOf } = makeView(MD);
    render(<Outline editorView={view} />);
    await settle();

    setupRects(0);
    makeVisible([domOf.get(0)!]);

    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(scrollSpy.mock.calls[0][0]).toMatchObject({ behavior: "smooth", block: "nearest" });
    // 必须是**活动行**被滚动
    expect((scrollSpy.mock.instances[0] as unknown as HTMLElement).getAttribute("data-outline-pos")).toBe("0");
  });

  it("活动行**已在**可视带内 → 不滚动（避免每次微小变化都动、造成抖动）", async () => {
    const { view, domOf } = makeView(MD);
    render(<Outline editorView={view} />);
    await settle();

    setupRects(0, { rowVisible: true });
    makeVisible([domOf.get(0)!]);
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it("用户刚在大纲列表上主动操作过 → 1200ms 内不自动跟随（不与用户抢滚动）", async () => {
    const { view, domOf } = makeView(MD);
    render(<Outline editorView={view} />);
    await settle();

    const list = document.querySelector(".outline-list") as HTMLElement;
    setupRects(0);
    // 用户按下鼠标/滚动过大纲列表
    act(() => {
      list.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    makeVisible([domOf.get(0)!]);
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it("被折叠隐藏的活动行不滚动（它根本不可见）", async () => {
    const { view, domOf } = makeView(MD);
    render(<Outline editorView={view} />);
    await settle();

    const positions = [...domOf.keys()].sort((a, b) => a - b);
    const hiddenPos = positions[1]; // L2，会被 L1 折叠隐藏

    // 折叠 L1（第一个标题）→ 隐藏其下的 L2/L3
    const toggle = document.querySelector(".outline-collapse-toggle") as HTMLElement;
    act(() => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    });
    await settle();

    const hiddenRow = document.querySelector(
      `.outline-row[data-outline-pos="${hiddenPos}"]`,
    ) as HTMLElement;
    expect(hiddenRow.getAttribute("aria-hidden")).toBe("true");

    setupRects(hiddenPos);
    makeVisible([domOf.get(hiddenPos)!]);
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it("活动行的 pos 变了但穹已可见时不会重复滚动（幂等）", async () => {
    const { view, domOf } = makeView(MD);
    render(<Outline editorView={view} />);
    await settle();

    const positions = [...domOf.keys()].sort((a, b) => a - b);
    setupRects(positions[0]);
    makeVisible([domOf.get(positions[0])!]);
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    // 同一个 activeId 再次触发（例如 headings 因编辑重建）→ 已可见，不应再滚
    setupRects(positions[0], { rowVisible: true });
    act(() => {
      const obs = observers[observers.length - 1];
      obs.cb([{ target: domOf.get(positions[0])!, isIntersecting: true }]);
    });
    expect(scrollSpy).toHaveBeenCalledTimes(1);
  });
});

// ═════════ 需求11 补充：悬停高亮 + 末尾落点（本人补齐的缺口） ═════════

describe("v0.13.1 需求11：悬停目标行高亮与末尾落点可达", () => {
  it("拖拽经过某行 → 该行获得 .outline-row--over（旧实现只 setState，样式是死的）", async () => {
    const { view } = makeView(MD);
    render(<Outline editorView={view} />);
    await settle();

    const list = document.querySelector(".outline-list") as HTMLElement;
    list.getBoundingClientRect = () =>
      ({ top: 100, bottom: 400, left: 0, right: 200, height: 300, width: 200, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect;

    const positions = [...document.querySelectorAll(".outline-row[data-outline-pos]")].map(
      (el) => Number(el.getAttribute("data-outline-pos")),
    );
    const targetPos = positions[1];

    act(() => {
      (dndProps.current!.onDragStart as (e: unknown) => void)({ active: { id: positions[0] } });
    });
    act(() => {
      (dndProps.current!.onDragOver as (e: unknown) => void)({
        active: { id: positions[0] },
        over: { id: targetPos, rect: { top: 200, height: 30 } },
        activatorEvent: { clientY: 205 }, // 上半部
      });
    });

    const overRow = document.querySelector(
      `.outline-row[data-outline-pos="${targetPos}"]`,
    ) as HTMLElement;
    expect(overRow.classList.contains("outline-row--over")).toBe(true);
    // 且不会同时高亮到别的行
    expect(document.querySelectorAll(".outline-row--over").length).toBe(1);

    // 拖拽结束后高亮必须撤掉（否则会长期残留一个假"落点"）
    act(() => {
      (dndProps.current!.onDragEnd as (e: unknown) => void)({
        active: { id: positions[0] },
        over: { id: targetPos },
      });
    });
    expect(document.querySelectorAll(".outline-row--over").length).toBe(0);
  });

  it("指针越过最后一个可见行 → 渲染高亮的末尾落点条（拖到最末可达）", async () => {
    const { view } = makeView(MD);
    render(<Outline editorView={view} />);
    await settle();

    const list = document.querySelector(".outline-list") as HTMLElement;
    list.getBoundingClientRect = () =>
      ({ top: 100, bottom: 400, left: 0, right: 200, height: 300, width: 200, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect;
    Object.defineProperty(list, "scrollTop", { value: 0, writable: true });

    const rows = [...document.querySelectorAll(".outline-row[data-outline-pos]")];
    const first = Number(rows[0].getAttribute("data-outline-pos"));
    const last = Number(rows[rows.length - 1].getAttribute("data-outline-pos"));

    // 末尾落点条常驻存在（但默认不高亮）
    const drop = document.querySelector('[data-testid="outline-end-drop"]') as HTMLElement;
    expect(drop).toBeTruthy();
    expect(drop.classList.contains("over")).toBe(false);
    // 使用本轮新增的 i18n key（此前无人使用）
    expect(drop.textContent).toBe("放到此处");

    act(() => {
      (dndProps.current!.onDragStart as (e: unknown) => void)({ active: { id: first } });
    });
    // 悬停在最后一行、且指针越过其下缘 → 落点记为文档末尾
    act(() => {
      (dndProps.current!.onDragOver as (e: unknown) => void)({
        active: { id: first },
        over: { id: last, rect: { top: 300, height: 30 } },
        activatorEvent: { clientY: 340 },
      });
    });
    expect(drop.classList.contains("over")).toBe(true);
    // 此时不应同时高亮某个中间行（末尾落点优先）
    expect(document.querySelectorAll(".outline-row--over").length).toBe(0);

    // 落在最后一行**中部**时，仍是"插到最后一行之前/之后"，不是末尾
    act(() => {
      (dndProps.current!.onDragOver as (e: unknown) => void)({
        active: { id: first },
        over: { id: last, rect: { top: 300, height: 30 } },
        activatorEvent: { clientY: 310 },
      });
    });
    expect(drop.classList.contains("over")).toBe(false);
    expect(document.querySelectorAll(".outline-row--over").length).toBe(1);
  });

  it("末尾落点提交为文档末尾：dispatch 的 transaction 把源标题移到最后", async () => {
    const { view } = makeView(MD);
    // Outline 挂载时会把 view.dispatch 换成自己的 patchedDispatch（内部再调用原函数），
    // 所以必须在 render 之前抓住原始的 vi.fn 引用，否则拿到的是包装函数。
    const dispatchSpy = (view as unknown as { dispatch: ReturnType<typeof vi.fn> }).dispatch;
    render(<Outline editorView={view} />);
    await settle();

    const list = document.querySelector(".outline-list") as HTMLElement;
    list.getBoundingClientRect = () =>
      ({ top: 100, bottom: 400, left: 0, right: 200, height: 300, width: 200, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect;

    const rows = [...document.querySelectorAll(".outline-row[data-outline-pos]")];
    const first = Number(rows[0].getAttribute("data-outline-pos"));
    const last = Number(rows[rows.length - 1].getAttribute("data-outline-pos"));

    act(() => {
      (dndProps.current!.onDragStart as (e: unknown) => void)({ active: { id: first } });
    });
    act(() => {
      (dndProps.current!.onDragOver as (e: unknown) => void)({
        active: { id: first },
        over: { id: last, rect: { top: 300, height: 30 } },
        activatorEvent: { clientY: 340 },
      });
    });
    act(() => {
      (dndProps.current!.onDragEnd as (e: unknown) => void)({
        active: { id: first },
        over: { id: last },
      });
    });

    // 走的是 calculateDragTransaction（而非把 over.id 当目标）：
    // 目标是 doc.content.size，因此 dispatch 被调用且文档确实变了
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    // 提交的 transaction 必须真的改动了文档（把首个 H1 段移到最后）
    const tr = dispatchSpy.mock.calls[0][0] as { docChanged: boolean };
    expect(tr.docChanged).toBe(true);
  });
});
