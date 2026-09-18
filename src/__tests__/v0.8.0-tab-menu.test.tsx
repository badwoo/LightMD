/**
 * v0.8.0 WP3 需求2 / 需求8：标签栏交互测试
 *
 * 覆盖：
 * - 需求2：空白区双击新建临时文件，双击标签自身不触发（守卫 target === currentTarget）
 * - 需求8：固定标签页（pin 排序在前 / unpin 恢复 / DOM 不渲染关闭按钮）
 * - 需求8：批量关闭下标计算（纯函数）+ dirty 只汇总确认一次（组件）
 * - 需求8：关闭后活跃标签与内容同步（store 层）
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { TabBar } from "../components/layout/TabBar";
import { useEditorStore, type TabInfo } from "../stores/useEditorStore";
import { computeCloseIndices, countDirtyTabs } from "../services/tabClose";
import { t } from "../i18n";

// jsdom 无 ResizeObserver，TabBar 的滚动按钮显隐依赖它，提供空实现
beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
  useEditorStore.setState({ openTabs: [], activeTabIdx: 0 });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeTabs(): TabInfo[] {
  return [
    { path: "/a.md", name: "a.md", content: "A", isDirty: false },
    { path: "/b.md", name: "b.md", content: "B", isDirty: true },
    { path: "/c.md", name: "c.md", content: "C", isDirty: false, pinned: true },
    { path: "/d.md", name: "d.md", content: "D", isDirty: true },
  ];
}

describe("需求2：空白双击新建临时文件（守卫）", () => {
  beforeEach(() => {
    useEditorStore.setState({ openTabs: makeTabs(), activeTabIdx: 0 });
  });

  it("双击标签自身（子元素）不触发新建", () => {
    const { container } = render(<TabBar />);
    const before = useEditorStore.getState().openTabs.length;
    const tabItem = container.querySelector(".tab-item") as HTMLElement;
    fireEvent.doubleClick(tabItem);
    expect(useEditorStore.getState().openTabs.length).toBe(before);
  });

  it("双击滚动容器空白区触发新建临时文件", () => {
    const { container } = render(<TabBar />);
    const before = useEditorStore.getState().openTabs.length;
    const scroll = container.querySelector(".tab-bar-scroll") as HTMLElement;
    fireEvent.doubleClick(scroll);
    const after = useEditorStore.getState().openTabs.length;
    expect(after).toBe(before + 1);
    const newTab = useEditorStore.getState().openTabs[after - 1];
    expect(newTab.isUntitled).toBe(true);
  });
});

describe("需求8：固定标签页", () => {
  beforeEach(() => {
    useEditorStore.setState({
      openTabs: [
        { path: "/a.md", name: "a.md" },
        { path: "/b.md", name: "b.md" },
        { path: "/c.md", name: "c.md" },
      ],
      activeTabIdx: 0,
    });
  });

  it("pin 后排序在最前，activeTabIdx 重映射回原活跃标签", () => {
    useEditorStore.getState().togglePin(2); // pin c.md
    const s = useEditorStore.getState();
    expect(s.openTabs.map((x) => x.name)).toEqual(["c.md", "a.md", "b.md"]);
    expect(s.openTabs[0].pinned).toBe(true);
    // 原活跃标签 a.md 在 idx0，pin 后应在 idx1
    expect(s.activeTabIdx).toBe(1);
  });

  it("unpin 取消固定（关闭按钮重新出现）", () => {
    useEditorStore.getState().togglePin(2); // pin c.md（重排到最前）
    useEditorStore.getState().togglePin(0); // 此时 c.md 在 idx0，再次 toggle 取消固定
    const s = useEditorStore.getState();
    expect(s.openTabs.every((x) => !x.pinned)).toBe(true);
    // 取消固定后所有标签都应重新渲染关闭按钮
    const { container } = render(<TabBar />);
    const items = container.querySelectorAll(".tab-item");
    items.forEach((it) => expect(it.querySelector(".tab-close")).not.toBeNull());
  });

  it("固定标签不渲染关闭按钮（DOM）", () => {
    useEditorStore.getState().togglePin(1);
    const { container } = render(<TabBar />);
    const pinnedItem = container.querySelector(".tab-item.tab-pinned") as HTMLElement;
    expect(pinnedItem).not.toBeNull();
    expect(pinnedItem.querySelector(".tab-close")).toBeNull();
    // 未固定的标签仍有关闭按钮
    expect(container.querySelector(".tab-item:not(.tab-pinned) .tab-close")).not.toBeNull();
  });
});

describe("需求8：批量关闭下标计算（纯函数）", () => {
  const tabs: TabInfo[] = [
    { path: "/a.md", name: "a.md", isDirty: false },
    { path: "/b.md", name: "b.md", isDirty: true },
    { path: "/c.md", name: "c.md", isDirty: false, pinned: true },
    { path: "/d.md", name: "d.md", isDirty: true },
    { path: "/e.md", name: "e.md", isDirty: false },
  ];

  it("closeOthers（目标0）：关掉未固定且非目标的 b,d,e，保留 a 与固定 c", () => {
    expect(computeCloseIndices(tabs, 0, "others")).toEqual([1, 3, 4]);
  });
  it("closeOthersKeepPinned：关掉所有未固定（含目标 a，因其未固定）", () => {
    expect(computeCloseIndices(tabs, 0, "othersKeepPinned")).toEqual([0, 1, 3, 4]);
  });
  it("closeLeft（目标3）：关掉左侧未固定 a,b（固定 c 豁免）", () => {
    expect(computeCloseIndices(tabs, 3, "left")).toEqual([0, 1]);
  });
  it("closeRight（目标1）：关掉右侧未固定 d,e（固定 c 豁免）", () => {
    expect(computeCloseIndices(tabs, 1, "right")).toEqual([3, 4]);
  });
  it("closeUnmodified：关掉所有未修改 a,c,e", () => {
    expect(computeCloseIndices(tabs, 0, "unmodified")).toEqual([0, 2, 4]);
  });
  it("countDirtyTabs 统计未保存数量", () => {
    expect(countDirtyTabs(tabs, [0, 1, 2, 3, 4])).toBe(2);
    expect(countDirtyTabs(tabs, [1, 3])).toBe(2);
  });
});

describe("需求8：批量关闭只汇总确认一次（组件）", () => {
  beforeEach(() => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    useEditorStore.setState({ openTabs: makeTabs(), activeTabIdx: 0 });
  });

  it("有未保存标签时只弹一次汇总确认，并传入正确下标", () => {
    const onCloseMany = vi.fn();
    const { container } = render(<TabBar onCloseMany={onCloseMany} />);
    fireEvent.contextMenu(container.querySelector(".tab-item") as HTMLElement);
    fireEvent.click(screen.getByText(t("tabbar.closeOthers")));
    // a.md 为目标，c.md 固定豁免；b.md/d.md 未保存 → dirty=2，仅确认一次
    expect((window.confirm as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(window.confirm).toHaveBeenCalledWith(t("tabbar.confirmCloseMany", { count: 2 }));
    expect(onCloseMany).toHaveBeenCalledTimes(1);
    expect(onCloseMany).toHaveBeenCalledWith([1, 3]);
  });

  it("无未保存标签时不弹确认，直接关闭", () => {
    const onCloseMany = vi.fn();
    useEditorStore.setState({
      openTabs: [
        { path: "/a.md", name: "a.md" },
        { path: "/b.md", name: "b.md" },
        { path: "/c.md", name: "c.md", pinned: true },
      ],
      activeTabIdx: 0,
    });
    const { container } = render(<TabBar onCloseMany={onCloseMany} />);
    fireEvent.contextMenu(container.querySelector(".tab-item") as HTMLElement);
    fireEvent.click(screen.getByText(t("tabbar.closeOthers")));
    expect(window.confirm).not.toHaveBeenCalled();
    expect(onCloseMany).toHaveBeenCalledWith([1]); // 关掉 b（c 固定豁免，a 是目标）
  });
});

describe("需求8：关闭后活跃标签与内容同步（store 层）", () => {
  it("批量关闭后剩余标签与活跃索引正确，内容同步到新活跃标签", () => {
    useEditorStore.setState({
      openTabs: [
        { path: "/a.md", name: "a.md", content: "AAA", isDirty: false },
        { path: "/b.md", name: "b.md", content: "BBB", isDirty: true },
        { path: "/c.md", name: "c.md", content: "CCC", isDirty: false, pinned: true },
      ],
      activeTabIdx: 1,
    });
    // 模拟 App.handleCloseMany 的核心：关闭 computeCloseIndices 计算出的下标（从后往前）
    const indices = computeCloseIndices(
      useEditorStore.getState().openTabs,
      1,
      "others"
    ); // 目标 b(idx1)：关 a(idx0)，c 固定豁免 → [0]
    const sorted = [...indices].sort((x, y) => y - x);
    for (const i of sorted) useEditorStore.getState().closeTab(i);
    const s = useEditorStore.getState();
    expect(s.openTabs.map((x) => x.name)).toEqual(["b.md", "c.md"]);
    // 原活跃标签 b 被保留，重映射后 activeTabIdx = 0
    expect(s.activeTabIdx).toBe(0);
    expect(s.openTabs[s.activeTabIdx].content).toBe("BBB");
  });
});
