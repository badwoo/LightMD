/**
 * v0.13.0 需求9：大纲面板标题折叠（只做大纲面板，编辑区折叠推迟 0.14.0）。
 *
 * 覆盖：
 * - 纯函数 `computeOutlineVisibility` 的折叠栈真值表（含跨层级、多折叠、空集合）；
 * - `toggleCollapsed` 切换语义；
 * - `canCollapse`（无子级则无箭头）；
 * - `shouldApplyCollapse`（过滤优先于折叠）；
 * - 组件行为：折叠箭头渲染、点击隐藏子级、再点展开、搜索时忽略折叠。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { EditorState } from "prosemirror-state";
import {
  computeOutlineVisibility,
  toggleCollapsed,
  canCollapse,
  shouldApplyCollapse,
  type OutlineNode,
} from "../utils/outlineCollapse";
import { Outline } from "../components/editor/Outline";
import { lightMDSchema } from "../core/schema";
import { markdownToDoc } from "../core/markdown/parser";
import type { EditorView } from "prosemirror-view";

// mock dnd-kit 绑定层（与 v0.8.4-outline-search.test.tsx 同因：@dnd-kit 的 peer react
// 指向 React 19，与本项目 React 18 构成双副本导致 hooks 崩溃）。
// 这里仅替换 React 绑定，被测的折叠逻辑不受影响。
vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children?: ReactNode }) => <>{children}</>,
  PointerSensor: class {},
  useSensor: () => ({}),
  useSensors: () => [],
  closestCenter: () => null,
}));
vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children?: ReactNode }) => <>{children}</>,
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

// jsdom 未实现 IntersectionObserver（Outline 的 setupObserver 需要）
beforeAll(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  );
});

afterEach(cleanup);

// ───────── 纯函数：折叠可见性真值表 ─────────

describe("computeOutlineVisibility 折叠栈真值表", () => {
  const nodes: OutlineNode[] = [
    { pos: 0, level: 1 },
    { pos: 10, level: 2 },
    { pos: 20, level: 3 },
    { pos: 30, level: 2 },
    { pos: 40, level: 1 },
  ];

  it("无折叠 → 全部可见", () => {
    const v = computeOutlineVisibility(nodes, new Set());
    expect([...v.values()].every(Boolean)).toBe(true);
  });

  it("折叠 L1(pos=0) → 其下所有更深层级隐藏，直到同级 L1 恢复", () => {
    const v = computeOutlineVisibility(nodes, new Set([0]));
    expect(v.get(0)).toBe(true); // 自身可见
    expect(v.get(10)).toBe(false); // L2 隐藏
    expect(v.get(20)).toBe(false); // L3 隐藏（跨两级）
    expect(v.get(30)).toBe(false); // L2 仍隐藏
    expect(v.get(40)).toBe(true); // 同级 L1 → 清栈，恢复可见
  });

  it("折叠 L2(pos=10) → 只隐藏它下面的更深层级，兄弟 L2 不受影响", () => {
    const v = computeOutlineVisibility(nodes, new Set([10]));
    expect(v.get(0)).toBe(true);
    expect(v.get(10)).toBe(true);
    expect(v.get(20)).toBe(false); // L3 隐藏
    expect(v.get(30)).toBe(true); // 兄弟 L2 可见
    expect(v.get(40)).toBe(true);
  });

  it("多个折叠同时生效（不同子树各自独立）", () => {
    const v = computeOutlineVisibility(nodes, new Set([0, 30]));
    expect(v.get(0)).toBe(true);
    expect(v.get(10)).toBe(false); // 被 pos=0 折叠
    expect(v.get(20)).toBe(false);
    expect(v.get(30)).toBe(false); // 被 pos=0 折叠（连自身都看不到）
    expect(v.get(40)).toBe(true);
  });

  it("折叠后遇到更浅层级即失效（不会一路隐藏到文档末尾）", () => {
    const v = computeOutlineVisibility(nodes, new Set([20])); // 折叠最深的 L3
    expect(v.get(0)).toBe(true);
    expect(v.get(10)).toBe(true);
    expect(v.get(20)).toBe(true);
    expect(v.get(30)).toBe(true); // L2 更浅 → 折叠失效
    expect(v.get(40)).toBe(true);
  });

  it("空 nodes → 空 Map（不抛错）", () => {
    expect(computeOutlineVisibility([], new Set([0])).size).toBe(0);
  });

  it("折叠一个不存在的 pos → 不影响任何节点", () => {
    const v = computeOutlineVisibility(nodes, new Set([999]));
    expect([...v.values()].every(Boolean)).toBe(true);
  });
});

describe("toggleCollapsed", () => {
  it("未折叠 → 加入；已折叠 → 移除", () => {
    const a = toggleCollapsed(new Set(), 5);
    expect(a.has(5)).toBe(true);
    const b = toggleCollapsed(a, 5);
    expect(b.has(5)).toBe(false);
  });

  it("不改原集合（纯函数）", () => {
    const orig = new Set([1]);
    const next = toggleCollapsed(orig, 2);
    expect(orig.has(2)).toBe(false);
    expect(next.has(2)).toBe(true);
    expect(next).not.toBe(orig);
  });
});

describe("canCollapse", () => {
  const nodes: OutlineNode[] = [
    { pos: 0, level: 1 },
    { pos: 10, level: 2 },
    { pos: 20, level: 1 }, // 有子级（下一个是 L2）
    { pos: 30, level: 2 },
    { pos: 40, level: 3 },
    { pos: 50, level: 2 }, // 无子级（下一个是 L1，更浅）
  ];

  it("有更深子级 → true", () => {
    expect(canCollapse(nodes, 0)).toBe(true); // L1 → 下一个 L2
    expect(canCollapse(nodes, 2)).toBe(true); // L1 → 下一个 L2
    expect(canCollapse(nodes, 3)).toBe(true); // L2 → 下一个 L3
  });

  it("无子级 → false", () => {
    expect(canCollapse(nodes, 4)).toBe(false); // L3 → 下一个 L2（更浅）
    expect(canCollapse(nodes, 5)).toBe(false); // 末节点
  });

  it("越界下标 → false", () => {
    expect(canCollapse(nodes, 99)).toBe(false);
    expect(canCollapse([], 0)).toBe(false);
  });
});

describe("shouldApplyCollapse：过滤优先于折叠", () => {
  it("无关键字 → 应用折叠", () => {
    expect(shouldApplyCollapse("")).toBe(true);
    expect(shouldApplyCollapse("   ")).toBe(true);
  });

  it("有关键字 → 忽略折叠（搜到的标题一定显示）", () => {
    expect(shouldApplyCollapse("标题")).toBe(false);
  });
});

// ───────── 组件行为 ─────────

/** 构造假 EditorView：仅提供 Outline 读取的 state.doc / dispatch / nodeDOM */
function makeView(markdown: string): EditorView {
  const state = EditorState.create({ doc: markdownToDoc(markdown), schema: lightMDSchema });
  return {
    state,
    dispatch: vi.fn(),
    nodeDOM: () => null,
  } as unknown as EditorView;
}

const MD = "# 一级标题\n\n## 二级 A\n\n### 三级 A1\n\n## 二级 B\n\n# 另一个一级\n";

function mountOutline() {
  const utils = render(<Outline editorView={makeView(MD)} />);
  return utils;
}

describe("Outline 组件：折叠行为", () => {
  it("默认渲染全部标题，且仅有子级的标题带折叠箭头", () => {
    const { container } = mountOutline();
    // 5 个标题
    expect(container.querySelectorAll(".outline-item").length).toBe(5);
    // 可折叠的只有 2 个：「一级标题」（下有 二级A）与「二级 A」（下有 三级A1）。
    // 三级A1 下一个是 二级B（更浅）、二级B 下一个是一级（更浅）、末节点无后继 → 都不可折叠
    expect(container.querySelectorAll('[data-testid="outline-collapse-toggle"]').length).toBe(2);
  });

  it("点击折叠箭头 → 子级隐藏；再点 → 恢复", () => {
    const { container } = mountOutline();
    const toggles = container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="outline-collapse-toggle"]',
    );
    // 第一个 toggle = 「一级标题」，折叠后隐藏 二级A/三级A1/二级B（3 项）
    act(() => {
      fireEvent.click(toggles[0]);
    });
    expect(container.querySelectorAll(".outline-item").length).toBe(2); // 只剩两个一级
    // 再点恢复
    act(() => {
      fireEvent.click(toggles[0]);
    });
    expect(container.querySelectorAll(".outline-item").length).toBe(5);
  });

  it("折叠箭头点击不触发标题跳转（stopPropagation）", () => {
    const { container } = mountOutline();
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="outline-collapse-toggle"]',
    );
    // scrollIntoView 在 jsdom 未实现，若被调用会抛错 → 正好作为「未跳转」的判据
    (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = () => {
      throw new Error("should not scroll");
    };
    expect(() => act(() => fireEvent.click(toggle!))).not.toThrow();
  });

  it("折叠态不影响大纲计数（计数仍是文档标题总数）", () => {
    const { container } = mountOutline();
    const before = container.querySelector(".outline-count")?.textContent;
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="outline-collapse-toggle"]',
    );
    act(() => {
      fireEvent.click(toggle!);
    });
    expect(container.querySelector(".outline-count")?.textContent).toBe(before);
  });

  it("重开文档后折叠态重置（不持久化）", () => {
    const first = mountOutline();
    const toggle = first.container.querySelector<HTMLButtonElement>(
      '[data-testid="outline-collapse-toggle"]',
    );
    act(() => {
      fireEvent.click(toggle!);
    });
    expect(first.container.querySelectorAll(".outline-item").length).toBe(2);
    first.unmount();
    cleanup();
    // 重新挂载 → 折叠态丢失，全部显示
    const again = mountOutline();
    expect(again.container.querySelectorAll(".outline-item").length).toBe(5);
  });
});
