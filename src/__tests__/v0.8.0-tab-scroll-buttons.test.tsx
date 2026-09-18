/**
 * v0.8.0 修复 P5（需求5）测试
 *
 * 问题1：标签铺满后最右侧只显示了一个 ">"，需要 "<>" 两个按钮都在最右侧
 * 问题2：鼠标滚轮在标签栏上滚动不生效（监听因依赖 [] + 首挂载时无 DOM 而未绑定）
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { TabBar } from "../components/layout/TabBar";
import { useEditorStore, type TabInfo } from "../stores/useEditorStore";
import { hasOverflow, isAtStart, isAtEnd } from "../services/tabScroll";

// jsdom 无 ResizeObserver，TabBar 的按钮显隐依赖它
beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const tabs: TabInfo[] = [
  { path: "/a.md", name: "a.md", content: "A" },
  { path: "/b.md", name: "b.md", content: "B" },
  { path: "/c.md", name: "c.md", content: "C" },
];

/** jsdom 的 clientWidth/scrollWidth 只读且恒为 0，这里显式注入尺寸 */
function setMetrics(
  el: HTMLElement,
  m: { clientWidth: number; scrollWidth: number; scrollLeft?: number },
) {
  Object.defineProperty(el, "clientWidth", { configurable: true, value: m.clientWidth });
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: m.scrollWidth });
  if (m.scrollLeft !== undefined) el.scrollLeft = m.scrollLeft;
}

beforeEach(() => {
  useEditorStore.setState({ openTabs: tabs, activeTabIdx: 0 });
});

afterEach(() => {
  cleanup();
  useEditorStore.setState({ openTabs: [], activeTabIdx: 0 });
});

describe("v0.8.0 修复 P5 溢出判定纯函数", () => {
  it("hasOverflow：留 1px 容差", () => {
    expect(hasOverflow(600, 600)).toBe(false);
    expect(hasOverflow(600, 601)).toBe(false);
    expect(hasOverflow(600, 602)).toBe(true);
  });

  it("isAtStart / isAtEnd 边界", () => {
    expect(isAtStart(0)).toBe(true);
    expect(isAtStart(1)).toBe(false);
    expect(isAtEnd(0, 300, 300)).toBe(true);
    expect(isAtEnd(100, 300, 900)).toBe(false);
    expect(isAtEnd(600, 300, 900)).toBe(true);
  });
});

describe("v0.8.0 修复 P5-1 最右侧成对显示 < > 按钮", () => {
  it("未溢出时不显示滚动按钮", () => {
    const { container } = render(<TabBar />);
    const scroll = container.querySelector(".tab-bar-scroll") as HTMLElement;
    setMetrics(scroll, { clientWidth: 600, scrollWidth: 600 });
    fireEvent.scroll(scroll);
    expect(container.querySelector(".tab-scroll-btns")).toBe(null);
  });

  it("溢出时同时渲染两个按钮，且位于滚动容器之后（标签区最右侧）", () => {
    const { container } = render(<TabBar />);
    const scroll = container.querySelector(".tab-bar-scroll") as HTMLElement;
    setMetrics(scroll, { clientWidth: 300, scrollWidth: 900 });
    fireEvent.scroll(scroll);

    const btns = container.querySelector(".tab-scroll-btns") as HTMLElement;
    expect(btns).not.toBe(null);
    const left = btns.querySelector(".tab-scroll-btn.left") as HTMLButtonElement;
    const right = btns.querySelector(".tab-scroll-btn.right") as HTMLButtonElement;
    expect(left).not.toBe(null);
    expect(right).not.toBe(null);
    // 起始位置：左按钮禁用（已到最左），右按钮可用
    expect(left.disabled).toBe(true);
    expect(right.disabled).toBe(false);
    // DOM 顺序：滚动容器 → 按钮组
    expect(
      scroll.compareDocumentPosition(btns) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("滚到最右端时右按钮禁用、左按钮可用", () => {
    const { container } = render(<TabBar />);
    const scroll = container.querySelector(".tab-bar-scroll") as HTMLElement;
    setMetrics(scroll, { clientWidth: 300, scrollWidth: 900, scrollLeft: 600 });
    fireEvent.scroll(scroll);

    const left = container.querySelector(".tab-scroll-btn.left") as HTMLButtonElement;
    const right = container.querySelector(".tab-scroll-btn.right") as HTMLButtonElement;
    expect(left.disabled).toBe(false);
    expect(right.disabled).toBe(true);
  });

  it("普通点击按一个标签滚动；Shift 点击直达首/尾", () => {
    const { container } = render(<TabBar />);
    const scroll = container.querySelector(".tab-bar-scroll") as HTMLElement;
    setMetrics(scroll, { clientWidth: 300, scrollWidth: 900, scrollLeft: 100 });
    fireEvent.scroll(scroll);

    // v0.8.0 修复 P11-3：按"一个标签"为单位滚动（滚到相邻标签的左边缘），
    // jsdom 的 offsetLeft 恒为 0，这里显式注入（每标签宽 150）
    const items = Array.from(scroll.querySelectorAll(".tab-item")) as HTMLElement[];
    items.forEach((it, i) =>
      Object.defineProperty(it, "offsetLeft", { configurable: true, value: i * 150 }),
    );

    const scrollTo = vi.fn();
    (scroll as unknown as { scrollTo: unknown }).scrollTo = scrollTo;

    // 向右：视口左边界(100)右侧的第一个标签 → offsetLeft=150
    fireEvent.click(container.querySelector(".tab-scroll-btn.right") as HTMLElement);
    expect(scrollTo).toHaveBeenCalledWith({ left: 150, behavior: "smooth" });

    // 向左：视口左边界左侧的最近标签 → offsetLeft=0
    fireEvent.click(container.querySelector(".tab-scroll-btn.left") as HTMLElement);
    expect(scrollTo).toHaveBeenCalledWith({ left: 0, behavior: "smooth" });

    // Shift 点击直达尾部 / 首部
    fireEvent.click(container.querySelector(".tab-scroll-btn.right") as HTMLElement, {
      shiftKey: true,
    });
    expect(scrollTo).toHaveBeenCalledWith({ left: 900, behavior: "smooth" });

    fireEvent.click(container.querySelector(".tab-scroll-btn.left") as HTMLElement, {
      shiftKey: true,
    });
    expect(scrollTo).toHaveBeenCalledWith({ left: 0, behavior: "smooth" });
  });
});

describe("v0.8.0 修复 P5-2 / P12-2 标签栏滚轮滚动", () => {
  /** 手动驱动 rAF：把回调入队后按帧冲刷，避免依赖真实动画时序 */
  function installRafDriver() {
    const queue: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      queue.push(cb);
      return queue.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    return {
      flush(frames = 80) {
        for (let i = 0; i < frames && queue.length > 0; i++) {
          queue.shift()!(0);
        }
      },
    };
  }

  it("有溢出时滚轮垂直滚动映射为横向滚动（经 rAF 缓动后到达目标）", () => {
    const raf = installRafDriver();
    const { container } = render(<TabBar />);
    const scroll = container.querySelector(".tab-bar-scroll") as HTMLElement;
    setMetrics(scroll, { clientWidth: 300, scrollWidth: 900, scrollLeft: 100 });

    fireEvent.wheel(scroll, { deltaY: 40 });
    raf.flush();
    expect(scroll.scrollLeft).toBe(140);

    fireEvent.wheel(scroll, { deltaY: -60 });
    raf.flush();
    expect(scroll.scrollLeft).toBe(80);
  });

  it("滚动过程是缓动的（首帧位移小于总位移）", () => {
    const raf = installRafDriver();
    const { container } = render(<TabBar />);
    const scroll = container.querySelector(".tab-bar-scroll") as HTMLElement;
    setMetrics(scroll, { clientWidth: 300, scrollWidth: 900, scrollLeft: 0 });

    fireEvent.wheel(scroll, { deltaY: 100 });
    raf.flush(1); // 只走一帧
    expect(scroll.scrollLeft).toBeGreaterThan(0);
    expect(scroll.scrollLeft).toBeLessThan(100);
  });

  it("连续滚轮事件累加目标位置，不新建动画循环", () => {
    const raf = installRafDriver();
    const { container } = render(<TabBar />);
    const scroll = container.querySelector(".tab-bar-scroll") as HTMLElement;
    setMetrics(scroll, { clientWidth: 300, scrollWidth: 900, scrollLeft: 0 });

    fireEvent.wheel(scroll, { deltaY: 30 });
    fireEvent.wheel(scroll, { deltaY: 30 });
    fireEvent.wheel(scroll, { deltaY: 40 });
    raf.flush();
    expect(scroll.scrollLeft).toBe(100);
  });

  it("滚轮增量按 deltaMode 归一化（按行滚动 ×16）", () => {
    const raf = installRafDriver();
    const { container } = render(<TabBar />);
    const scroll = container.querySelector(".tab-bar-scroll") as HTMLElement;
    setMetrics(scroll, { clientWidth: 300, scrollWidth: 900, scrollLeft: 0 });

    fireEvent.wheel(scroll, { deltaY: 2, deltaMode: 1 }); // 2 行 → 32px
    raf.flush();
    expect(scroll.scrollLeft).toBe(32);
  });

  it("目标位置被钳制在可滚动范围内", () => {
    const raf = installRafDriver();
    const { container } = render(<TabBar />);
    const scroll = container.querySelector(".tab-bar-scroll") as HTMLElement;
    setMetrics(scroll, { clientWidth: 300, scrollWidth: 900, scrollLeft: 550 });

    fireEvent.wheel(scroll, { deltaY: 9999 });
    raf.flush();
    expect(scroll.scrollLeft).toBe(600); // max = 900 - 300
  });

  it("无溢出时不接管滚轮（scrollLeft 不变）", () => {
    const { container } = render(<TabBar />);
    const scroll = container.querySelector(".tab-bar-scroll") as HTMLElement;
    setMetrics(scroll, { clientWidth: 600, scrollWidth: 600, scrollLeft: 0 });

    fireEvent.wheel(scroll, { deltaY: 40 });
    expect(scroll.scrollLeft).toBe(0);
  });
});