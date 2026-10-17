// @vitest-environment jsdom
/**
 * v0.13.2 需求7：右侧大纲的**跟随滚动**（a）与**滚动位置记忆**（b）。
 *
 * ## 用户原话
 * 「需求12 右侧大纲……a、……只要标题在屏幕下半部分能看到，那么右侧大纲栏也能跟随滚动看到。
 *  b、……大纲栏……也要加上滚动位置记忆。」
 *
 * ## 两条改动的落点
 * a. `IntersectionObserver` 的 `rootMargin` 从 `"-10% 0px -70% 0px"`（只认上 10%~下 30%
 *    的窄带，标题必须爬到屏幕上方才被认领）改为 `"-10% 0px 0px 0px"` —— 标题只要进入
 *    视口（含最底部）就认领。
 * b. 新增 `services/outlineScrollMemory`（Map + localStorage，LRU 60，400ms 防抖），
 *    `Outline` 在滚动时写、切文档后双 rAF 恢复，并在短暂窗口内抑制跟随
 *    （否则切回"读到末尾"的文档时大纲会自己滚一下——正是用户抱怨的现象）。
 *
 * ## 手法
 * - 记忆服务：纯函数级断言（含 fake timers 验证 400ms 防抖真的落盘）。
 * - Outline 组件：真实渲染 + 假 `IntersectionObserver`（捕获构造参数）+ 可驱动的 rAF +
 *   真实 `useEditorStore` 切标签；滚动容器用 stub（jsdom 无布局）验证写入/恢复数值。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { markdownToDoc } from "../core/markdown/parser";
import { lightMDSchema } from "../core/schema";
import { Outline } from "../components/editor/Outline";
import { useEditorStore } from "../stores/useEditorStore";
import {
  setOutlineScroll,
  getOutlineScroll,
  clearOutlineScroll,
  clearAllOutlineScroll,
  loadOutlineScrollSnapshot,
  flushOutlineScroll,
  hasUnsavedOutlineScroll,
  __outlineScrollSize,
  __resetOutlineScrollForTest,
} from "../services/outlineScrollMemory";

// ───────── dnd-kit 替身（本项目未安装 @dnd-kit，既有测试同款替身） ─────────
vi.mock("@dnd-kit/core", () => ({
  DndContext: (props: { children?: ReactNode }) => <>{props.children}</>,
  DragOverlay: ({ children }: { children?: ReactNode }) => <>{children}</>,
  PointerSensor: class {},
  useSensor: () => ({}),
  useSensors: () => [],
  closestCenter: () => null,
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: (props: { children?: ReactNode }) => <>{props.children}</>,
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
  verticalListSortingStrategy: undefined,
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => undefined } },
}));

// ───────── 可手动触发的 IntersectionObserver（捕获构造参数） ─────────
type IOCallback = (entries: Array<{ target: Element; isIntersecting: boolean }>) => void;
const observers: Array<{
  cb: IOCallback;
  options: IntersectionObserverInit | undefined;
  targets: Element[];
}> = [];

/** 用 rAF 队列替代真实帧回调（jsdom 无渲染循环，便于确定性推进） */
let rafQueue: FrameRequestCallback[] = [];
function flushRaf(times = 1) {
  for (let round = 0; round < times; round++) {
    const queue = rafQueue.splice(0);
    act(() => {
      for (const cb of queue) cb(performance.now());
    });
  }
}

const MD = "# 一级标题\n\n## 二级 A\n\n### 三级 A1\n\n## 二级 B\n\n# 另一个一级\n";

/** 假 EditorView：nodeDOM 返回真实元素（供 IntersectionObserver 与跟随滚动使用） */
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

const DOC_A = "D:/docs/a.md";
const DOC_B = "D:/docs/b.md";

function setTabs(paths: string[]) {
  act(() => {
    useEditorStore.setState({
      openTabs: paths.map((p) => ({ path: p, name: p.split("/").pop()! })),
      activeTabIdx: 0,
    });
  });
}

/** jsdom 不做布局：scrollTop/scrollHeight/clientHeight 全部桩掉 */
function stubListMetrics(list: HTMLElement, opts: { clientHeight?: number; scrollHeight?: number; scrollTop?: number } = {}) {
  Object.defineProperty(list, "clientHeight", {
    configurable: true,
    get: () => opts.clientHeight ?? 200,
  });
  Object.defineProperty(list, "scrollHeight", {
    configurable: true,
    get: () => opts.scrollHeight ?? 1000,
  });
  Object.defineProperty(list, "scrollTop", {
    configurable: true,
    writable: true,
    value: opts.scrollTop ?? 0,
  });
}

const STORAGE_KEY = "lightmd-outline-scroll";

beforeEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  __resetOutlineScrollForTest();
  observers.length = 0;
  rafQueue = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      cb: IOCallback;
      options: IntersectionObserverInit | undefined;
      targets: Element[] = [];
      constructor(cb: IOCallback, options?: IntersectionObserverInit) {
        this.cb = cb;
        this.options = options;
        observers.push(this as unknown as (typeof observers)[number]);
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
  (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = vi.fn();
  setTabs([DOC_A]);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = "";
  localStorage.clear();
  __resetOutlineScrollForTest();
});

// ═══════════════════════ ① 记忆服务（纯逻辑） ═══════════════════════

describe("需求7b · outlineScrollMemory：按文档记 scrollTop", () => {
  it("set → get 往返（取整存储）", () => {
    setOutlineScroll(DOC_A, 123.6);
    expect(getOutlineScroll(DOC_A)).toBe(124);
    setOutlineScroll(DOC_A, 0);
    expect(getOutlineScroll(DOC_A)).toBe(0);
  });

  it("不同文档键互不干扰", () => {
    setOutlineScroll(DOC_A, 100);
    setOutlineScroll(DOC_B, 250);
    expect(getOutlineScroll(DOC_A)).toBe(100);
    expect(getOutlineScroll(DOC_B)).toBe(250);
    expect(getOutlineScroll("D:/docs/never.md")).toBeNull();
  });

  it("空键 / 负数 / NaN 不写入（防脏数据）", () => {
    setOutlineScroll(null, 10);
    setOutlineScroll(undefined, 10);
    setOutlineScroll("", 10);
    setOutlineScroll(DOC_A, -1);
    setOutlineScroll(DOC_B, Number.NaN);
    expect(__outlineScrollSize()).toBe(0);
    expect(getOutlineScroll(DOC_A)).toBeNull();
  });

  it("clearOutlineScroll 只清指定文档", () => {
    setOutlineScroll(DOC_A, 100);
    setOutlineScroll(DOC_B, 200);
    clearOutlineScroll(DOC_A);
    expect(getOutlineScroll(DOC_A)).toBeNull();
    expect(getOutlineScroll(DOC_B)).toBe(200);
  });

  it("LRU 上限 60：塞 61 个键 → 最早的被淘汰，最新的保留", () => {
    for (let i = 0; i < 60; i++) setOutlineScroll(`k${i}`, i);
    expect(__outlineScrollSize()).toBe(60);
    setOutlineScroll("k60", 600);
    expect(__outlineScrollSize()).toBe(60);
    expect(getOutlineScroll("k0")).toBeNull();
    expect(getOutlineScroll("k1")).toBe(1);
    expect(getOutlineScroll("k60")).toBe(600);
  });

  it("400ms 防抖后落盘；flushOutlineScroll 立即落盘", () => {
    vi.useFakeTimers();
    setOutlineScroll(DOC_A, 321);
    // 防抖期未到 → 内存有值但 localStorage 还没有
    expect(getOutlineScroll(DOC_A)).toBe(321);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(hasUnsavedOutlineScroll()).toBe(true);

    act(() => {
      vi.advanceTimersByTime(399);
    });
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(hasUnsavedOutlineScroll()).toBe(false);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({ [DOC_A]: 321 });

    // 下一轮改动 → 未到防抖点时 flush 必须立刻写
    setOutlineScroll(DOC_B, 77);
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain(DOC_B);
    flushOutlineScroll();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({
      [DOC_A]: 321,
      [DOC_B]: 77,
    });
  });

  it("loadOutlineScrollSnapshot 从 localStorage 读回，并过滤非数字/负数", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ [DOC_A]: 88, [DOC_B]: "nope", bad: -3, alsoBad: null }),
    );
    __resetOutlineScrollForTest();
    loadOutlineScrollSnapshot();
    expect(getOutlineScroll(DOC_A)).toBe(88);
    expect(getOutlineScroll(DOC_B)).toBeNull();
    expect(getOutlineScroll("bad")).toBeNull();
    expect(getOutlineScroll("alsoBad")).toBeNull();
  });

  it("损坏的 JSON / 非对象快照不抛错（从空开始）", () => {
    for (const raw of ["{not json", "null", "123", '"str"']) {
      __resetOutlineScrollForTest();
      localStorage.setItem(STORAGE_KEY, raw);
      expect(() => loadOutlineScrollSnapshot()).not.toThrow();
      expect(__outlineScrollSize()).toBe(0);
    }
  });

  it("clearAllOutlineScroll 清空全部", () => {
    setOutlineScroll(DOC_A, 1);
    setOutlineScroll(DOC_B, 2);
    clearAllOutlineScroll();
    expect(__outlineScrollSize()).toBe(0);
    expect(getOutlineScroll(DOC_A)).toBeNull();
  });

  it("App 的两个快照加载点都会读回记忆（跨会话恢复的接线）", () => {
    // 记忆服务本身已在上方验证；这里锁接线：App 启动/恢复会话两处都必须调用
    // `loadOutlineScrollSnapshot()`，否则新会话里记忆永远读不回来。
    const appSrc = readFileSync(resolve(__dirname, "..", "App.tsx"), "utf8");
    // 只锁**意图**（从这个模块导入了 loadOutlineScrollSnapshot）。不锁单行字面量：
    // 该 import 现为多行分组（同时引入 flush/clear 等落盘与清理函数），
    // 写死单行形态会让"多引一个合法符号"这一无害改动误报。
    expect(appSrc).toMatch(
      /import\s*\{[\s\S]*?\bloadOutlineScrollSnapshot\b[\s\S]*?\}\s*from\s*"\.\/services\/outlineScrollMemory"/,
    );
    const calls = appSrc.match(/loadOutlineScrollSnapshot\(\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});

// ═══════════════════════ ② Outline 组件：跟随 + 记忆 ═══════════════════════

describe("需求7a · IntersectionObserver 的 rootMargin 覆盖整个视口下半部分", () => {
  it("构造参数 rootMargin = '-10% 0px 0px 0px'、threshold 0", () => {
    const { view } = makeView(MD);
    render(<Outline editorView={view} />);
    flushRaf(1);

    expect(observers.length).toBeGreaterThan(0);
    const options = observers[observers.length - 1].options;
    expect(options?.rootMargin).toBe("-10% 0px 0px 0px");
    expect(options?.threshold).toBe(0);
    // 旧值把视口裁成上 10%~下 30% 的窄带 → 标题要滚到上方才被认领
    expect(options?.rootMargin).not.toContain("-70%");
  });
});

describe("需求7b · 大纲滚动写入与切文档恢复", () => {
  it("大纲列表滚动 → 按当前文档键记录 scrollTop", () => {
    const { view } = makeView(MD);
    render(<Outline editorView={view} />);
    flushRaf(1);

    const list = document.querySelector(".outline-list") as HTMLElement;
    stubListMetrics(list);
    list.scrollTop = 140;
    act(() => {
      list.dispatchEvent(new Event("scroll"));
    });
    expect(getOutlineScroll(DOC_A)).toBe(140);
  });

  it("切到另一文档再切回 → 双 rAF 后恢复记忆位置（scrollTop 写回）", () => {
    const { view } = makeView(MD);
    render(<Outline editorView={view} />);
    flushRaf(1);

    const list = document.querySelector(".outline-list") as HTMLElement;
    stubListMetrics(list);
    // 文档 A 读到中段
    list.scrollTop = 140;
    act(() => {
      list.dispatchEvent(new Event("scroll"));
    });
    expect(getOutlineScroll(DOC_A)).toBe(140);

    // 切到 B：B 没有记忆，大纲停在顶部
    setTabs([DOC_B]);
    flushRaf(2);
    list.scrollTop = 0;
    act(() => {
      list.dispatchEvent(new Event("scroll"));
    });
    expect(getOutlineScroll(DOC_B)).toBe(0);

    // 切回 A：恢复 140（不经过用户滚动）
    setTabs([DOC_A]);
    flushRaf(2);
    expect(list.scrollTop).toBe(140);
  });

  it("记住的位置超过可滚动上限 → 恢复时钳到 max（不会写越界值）", () => {
    setOutlineScroll(DOC_A, 5000);
    const { view } = makeView(MD);
    render(<Outline editorView={view} />);
    flushRaf(1);

    const list = document.querySelector(".outline-list") as HTMLElement;
    stubListMetrics(list, { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 });
    // headings 就绪后 restore effect 会跑（依赖 headings.length），这里再推进一组 rAF
    flushRaf(2);
    expect(list.scrollTop).toBe(800);
  });

  it("文档没有记忆时不写 0（避免覆盖式恢复），列表保持原状", () => {
    const { view } = makeView(MD);
    render(<Outline editorView={view} />);
    flushRaf(1);
    const list = document.querySelector(".outline-list") as HTMLElement;
    stubListMetrics(list, { scrollTop: 33 });
    flushRaf(2);
    expect(list.scrollTop).toBe(33);
    expect(getOutlineScroll(DOC_A)).toBeNull();
  });
});

describe("需求7b · 恢复后的宽限期内不被「跟随 active 标题」抢走滚动", () => {
  /** 活动行滚出可视带（保证若跟随生效就一定会调用 scrollIntoView） */
  function setupRects(activePos: number) {
    const list = document.querySelector(".outline-list") as HTMLElement;
    list.getBoundingClientRect = () =>
      ({ top: 100, bottom: 300, left: 0, right: 200, height: 200, width: 200, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect;
    const row = document.querySelector(
      `.outline-row[data-outline-pos="${activePos}"]`,
    ) as HTMLElement;
    expect(row).toBeTruthy();
    row.getBoundingClientRect = () =>
      ({ top: 400, bottom: 430, left: 0, right: 200, height: 30, width: 200, x: 0, y: 400, toJSON: () => ({}) }) as DOMRect;
  }

  function makeVisible(els: Element[]) {
    const obs = observers[observers.length - 1];
    act(() => {
      obs.cb(els.map((target) => ({ target, isIntersecting: true })));
    });
  }

  it("恢复位置后（600ms 宽限 + 1200ms 用户操作守卫内）不自动跟随；时间过去后恢复跟随", () => {
    vi.useFakeTimers();
    // 文档 A 已记忆位置 → 挂载即触发恢复
    setOutlineScroll(DOC_A, 140);
    const { view, domOf } = makeView(MD);
    render(<Outline editorView={view} />);
    flushRaf(1);

    const list = document.querySelector(".outline-list") as HTMLElement;
    stubListMetrics(list, { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 });
    flushRaf(2);
    expect(list.scrollTop).toBe(140);

    const positions = [...domOf.keys()].sort((a, b) => a - b);
    const scrollSpy = Element.prototype.scrollIntoView as unknown as ReturnType<typeof vi.fn>;

    // 恢复后立刻：标题被判定可见 → 跟随逻辑必须被宽限期/用户守卫挡住
    setupRects(positions[0]);
    makeVisible([domOf.get(positions[0])!]);
    expect(scrollSpy).not.toHaveBeenCalled();

    // 600ms 宽限期虽过，但「用户刚操作过大纲」的 1200ms 守卫仍在
    act(() => {
      vi.advanceTimersByTime(700);
    });
    makeVisible([domOf.get(positions[1])!]);
    expect(scrollSpy).not.toHaveBeenCalled();

    // 超过 1200ms → 跟随恢复，把活动标题滚进可视区
    act(() => {
      vi.advanceTimersByTime(600);
    });
    setupRects(positions[2]);
    makeVisible([domOf.get(positions[2])!]);
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(scrollSpy.mock.calls[0][0]).toMatchObject({ behavior: "smooth", block: "nearest" });
  });
});
