/**
 * v0.8.0 修复 P8-1（需求8 问题1）：固定标签页右上角显示小图钉图标
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { TabBar } from "../components/layout/TabBar";
import { useEditorStore, type TabInfo } from "../stores/useEditorStore";

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const tabs: TabInfo[] = [
  { path: "/pinned.md", name: "pinned.md", pinned: true },
  { path: "/plain.md", name: "plain.md" },
];

beforeEach(() => {
  useEditorStore.setState({ openTabs: tabs, activeTabIdx: 0 });
});

afterEach(() => {
  cleanup();
  useEditorStore.setState({ openTabs: [], activeTabIdx: 0 });
});

describe("v0.8.0 修复 P8-1 固定标签页图钉", () => {
  it("固定标签渲染右上角图钉，并且不渲染关闭按钮", () => {
    const { container } = render(<TabBar />);
    const items = container.querySelectorAll(".tab-item");
    expect(items.length).toBe(2);

    const pinnedItem = container.querySelector(".tab-item.tab-pinned") as HTMLElement;
    expect(pinnedItem).not.toBe(null);
    expect(pinnedItem.querySelector(".tab-pin")).not.toBe(null);
    expect(pinnedItem.querySelector(".tab-close")).toBe(null);
  });

  it("未固定标签没有图钉，且保留关闭按钮", () => {
    const { container } = render(<TabBar />);
    const items = Array.from(container.querySelectorAll(".tab-item"));
    const plain = items.find((el) => !el.classList.contains("tab-pinned")) as HTMLElement;
    expect(plain.querySelector(".tab-pin")).toBe(null);
    expect(plain.querySelector(".tab-close")).not.toBe(null);
  });

  it("点击图钉可取消固定（P11-9）", () => {
    const { container } = render(<TabBar />);
    const pin = container.querySelector(".tab-pin") as HTMLElement;
    expect(pin).not.toBe(null);
    fireEvent.click(pin);
    // store 中该标签已取消固定，图钉随之消失
    expect(useEditorStore.getState().openTabs.some((t) => t.pinned)).toBe(false);
    expect(container.querySelector(".tab-pin")).toBe(null);
  });

  it("点击图钉会阻断冒泡（不触发标签切换/拖拽）", () => {
    const src = readFileSync(resolve(__dirname, "../components/layout/TabBar.tsx"), "utf-8");
    const pinBlock = src.slice(src.indexOf('className="tab-pin"'), src.indexOf('className="tab-pin"') + 400);
    expect(pinBlock).toContain("e.stopPropagation()");
    expect(pinBlock).toContain("onMouseDown={(e) => e.stopPropagation()}");
  });

  it("取消固定后图钉消失", () => {
    useEditorStore.setState({
      openTabs: [{ path: "/pinned.md", name: "pinned.md", pinned: false }],
      activeTabIdx: 0,
    });
    const { container } = render(<TabBar />);
    expect(container.querySelector(".tab-pin")).toBe(null);
  });
});