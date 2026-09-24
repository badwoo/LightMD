/**
 * v0.8.3 WP1 需求2：「打开的文件」栏双高亮修复
 *
 * 覆盖：
 * 1. 纯函数 shouldResetTempSelection（激活来源判据）
 * 2. 渲染复现：点击栏内条目 A → 从标签栏切到 B → 栏内不再有两个高亮
 * 3. 键盘语义不回退：栏内点击 A 后 selectedTempIdx 仍指向 A（Delete/Ctrl+2 目标）
 * 4. 源码 / CSS 接线：状态联动 + 视觉降级双保险
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { render, act, fireEvent, cleanup } from "@testing-library/react";
import { shouldResetTempSelection } from "../utils/tempSelection";
import { useFileStore } from "../stores/useFileStore";
import { useEditorStore } from "../stores/useEditorStore";
import { FileTree } from "../components/sidebar/FileTree";

const fileTreeSrc = readFileSync(
  resolve(__dirname, "../components/sidebar/FileTree.tsx"),
  "utf-8",
);
const cssSrc = readFileSync(
  resolve(__dirname, "../components/sidebar/FileTree.css"),
  "utf-8",
);

// jsdom 未实现 ResizeObserver（SidebarScrollArrows 用其监听尺寸）
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

afterEach(() => {
  cleanup();
  useEditorStore.setState({ openTabs: [], activeTabIdx: 0 });
});

beforeEach(() => {
  localStorage.removeItem("lightmd-file-store");
  localStorage.removeItem("lightmd-editor-store");
  useFileStore.setState({
    favorites: [],
    recentFiles: [],
    recentFolders: [],
    tempFiles: [],
    fileTree: [],
    rootPath: null,
    openFolders: [],
  });
  useEditorStore.setState({
    openTabs: [
      { path: "C:/temp/a.md", name: "a.md", content: "", isDirty: false },
      { path: "C:/temp/b.md", name: "b.md", content: "", isDirty: false },
    ] as never,
    activeTabIdx: 0,
  });
});

describe("v0.8.3 需求2：shouldResetTempSelection 判定", () => {
  it("激活键为空（全部标签关闭）→ 清空键盘选中", () => {
    expect(shouldResetTempSelection(null, "temp-C:/a.md")).toBe(true);
    expect(shouldResetTempSelection(null, null)).toBe(true);
  });

  it("本次激活正来自栏内点击（来源键相同）→ 保留键盘选中", () => {
    expect(shouldResetTempSelection("temp-C:/a.md", "temp-C:/a.md")).toBe(false);
  });

  it("激活键变化且非栏内点击来源（标签栏切换）→ 清空键盘选中", () => {
    expect(shouldResetTempSelection("temp-C:/b.md", "temp-C:/a.md")).toBe(true);
    // 来源键为空（未落盘条目点击 / 非栏内激活）同样清空
    expect(shouldResetTempSelection("temp-C:/b.md", null)).toBe(true);
  });
});

describe("v0.8.3 需求2：双高亮渲染回归", () => {
  /** 取「打开的文件」栏中指定 title 的条目 */
  function item(title: string): HTMLElement {
    const el = document.querySelector<HTMLElement>(
      `.filetree-temp-content > .filetree-temp-node[title="${title}"]`,
    );
    if (!el) throw new Error(`未找到条目 ${title}`);
    return el;
  }

  it("点击栏内条目 A 后直接（不切标签）键盘选中仍在 A —— 键盘语义不回退", () => {
    render(createElement(FileTree));
    act(() => {
      fireEvent.click(item("C:/temp/a.md"));
    });
    // 栏内点击来源 = a；激活键未变化 → effect 不介入，selectedTempIdx 保留
    expect(
      document.querySelectorAll(".filetree-temp-content > .filetree-temp-node.selected"),
    ).toHaveLength(1);
    expect(item("C:/temp/a.md").className).toContain("selected");
  });

  it("点击栏内条目 A → 从标签栏切到 B → 栏内仅 B 带激活高亮、无残留 selected", () => {
    render(createElement(FileTree));
    act(() => {
      fireEvent.click(item("C:/temp/a.md"));
    });
    expect(document.querySelectorAll(".filetree-temp-node.selected")).toHaveLength(1);

    // 模拟从标签栏（或 Ctrl+Tab）切到 B：栏内不经过点击，来源键仍为 a
    act(() => {
      useEditorStore.getState().setActiveTab(1);
    });

    const actives = document.querySelectorAll(".filetree-temp-content > .filetree-temp-node.active");
    expect(actives).toHaveLength(1);
    expect(actives[0].getAttribute("title")).toBe("C:/temp/b.md");
    // 修复前这里会残留 1 个 .selected（A）→ 视觉上两个高亮块
    expect(document.querySelectorAll(".filetree-temp-node.selected")).toHaveLength(0);
  });

  it("未落盘条目点击后（来源键置空）真实文件条目的 selected 被清除", () => {
    useEditorStore.setState({
      openTabs: [
        { id: "untitled-1", path: "", name: "未命名 1", content: "", isUntitled: true, isDirty: false },
        { path: "C:/temp/a.md", name: "a.md", content: "", isDirty: false },
      ] as never,
      activeTabIdx: 1,
    });
    render(createElement(FileTree));
    act(() => {
      fireEvent.click(item("C:/temp/a.md"));
    });
    expect(document.querySelectorAll(".filetree-temp-node.selected")).toHaveLength(1);

    // 点击未落盘条目：来源键置空（它不能作为 Delete 目标）→ 激活键变化后清空
    // （测试内无 App 监听 tab.activate，故一并模拟 App 的激活切换）
    const untitledEl = document.querySelector<HTMLElement>(".filetree-untitled-node");
    act(() => {
      fireEvent.click(untitledEl!);
      useEditorStore.getState().setActiveTab(0);
    });
    expect(document.querySelectorAll(".filetree-temp-node.selected")).toHaveLength(0);
  });
});

describe("v0.8.3 需求2：源码 / CSS 接线（双保险）", () => {
  it("状态联动：activeItemKey 变化时经纯函数判定清空键盘选中", () => {
    expect(fileTreeSrc).toContain("shouldResetTempSelection(activeItemKey, sidebarClickKeyRef.current)");
    expect(fileTreeSrc).toContain("const sidebarClickKeyRef = useRef<string | null>(null);");
  });

  it("栏内点击记录来源键（真实文件条目）/ 置空（未落盘条目）", () => {
    expect(fileTreeSrc).toContain("sidebarClickKeyRef.current = itemKey;");
    expect(fileTreeSrc).toContain("sidebarClickKeyRef.current = null;");
  });

  it("视觉降级：.selected 不再使用与 .active 相同的背景填充", () => {
    // 取 .filetree-temp-node.selected 规则块本体
    const m = cssSrc.match(/\.filetree-temp-node\.selected\s*\{([^}]*)\}/);
    expect(m).not.toBeNull();
    expect(m![1]).toContain("background: none");
    expect(m![1]).not.toContain("--bg-selection");
    // 改用左侧 2px accent 竖线指示键盘目标
    expect(cssSrc).toMatch(/\.filetree-temp-node\.selected::after\s*\{[^}]*width:\s*2px/);
  });
});
