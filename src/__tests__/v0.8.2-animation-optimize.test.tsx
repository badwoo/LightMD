/**
 * v0.8.2 动画优化测试（打开/关闭文件夹与文件条目的串行动画 + 置顶排序）
 *
 * 覆盖本次优化：
 * 1. 关闭「打开的文件」中间条目：滑出块**留在原位置**（下方条目上移补位），
 *    而不是被追加到列表末尾；
 * 2. 文件夹栏关闭：快照保留到"滑出 + 停顿 + 高度收起"整条串行动画播完才清除
 *    （修复此前 360ms 提前卸载导致"左滑"与"上移"看起来同时发生）；
 * 3. 关闭文件夹栏快照按原位置插回（关闭中间那栏时下方栏平滑上移）；
 * 4. 文件树目录节点展开/收起：子节点容器带滑入/滑出动画类；
 * 5. 排序：最新打开的文件夹栏置顶；「打开的文件」条目最近使用置顶。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { render, act, cleanup } from "@testing-library/react";
import { FileTree, buildClosingSlotPositions } from "../components/sidebar/FileTree";
import { useFileStore } from "../stores/useFileStore";
import { useEditorStore } from "../stores/useEditorStore";

// jsdom 未实现 ResizeObserver（SidebarScrollArrows 用其监听尺寸）
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

afterEach(() => cleanup());

const fileTreeSrc = readFileSync(
  resolve(__dirname, "../components/sidebar/FileTree.tsx"),
  "utf-8",
);
const fileTreeCss = readFileSync(
  resolve(__dirname, "../components/sidebar/FileTree.css"),
  "utf-8",
);
const fileNodeSrc = readFileSync(
  resolve(__dirname, "../components/sidebar/FileNode.tsx"),
  "utf-8",
);

// ─── 1. 关闭块位置计算（纯函数） ─────────────────────────────

describe("v0.8.2 动画优化：关闭块原位置计算 buildClosingSlotPositions", () => {
  it("关闭中间条目 → 插回原下标（存活条目仍占据其前后的槽位）", () => {
    const pos = buildClosingSlotPositions(["a", "b", "c"], new Set(["a", "c"]));
    expect(pos.get("b")).toBe(1);
  });

  it("关闭首条目 → 下标 0", () => {
    const pos = buildClosingSlotPositions(["a", "b", "c"], new Set(["b", "c"]));
    expect(pos.get("a")).toBe(0);
  });

  it("关闭末条目 → 下标 = 存活条目数（落在列表末尾）", () => {
    const pos = buildClosingSlotPositions(["a", "b", "c"], new Set(["a", "b"]));
    expect(pos.get("c")).toBe(2);
  });

  it("同时关闭两条（相邻）：各自占据一个插入槽位", () => {
    const pos = buildClosingSlotPositions(["a", "b", "c", "d"], new Set(["a", "d"]));
    // b 在源码下标 1，前面没有关闭中条目 → 槽位 1
    expect(pos.get("b")).toBe(1);
    // c 在源码下标 2，前面有 1 个关闭中条目（b）→ 槽位 2 − 1 = 1
    // （b 与 c 各占一个槽位，按插入顺序排列为 … B C …，相对位置保持）
    expect(pos.get("c")).toBe(1);
  });

  it("同时关闭两条（不相邻）：各自落在正确的槽位", () => {
    const pos = buildClosingSlotPositions(["a", "b", "c", "d", "e"], new Set(["a", "e"]));
    // 槽位 k = "已渲染 k 个存活条目之后"：b/c/d 都排在 a 之后、e 之前 → 槽位 1
    expect(pos.get("b")).toBe(1);
    expect(pos.get("c")).toBe(1);
    expect(pos.get("d")).toBe(1);
    // 槽位 1 上有多个关闭块时，按它们在源码顺序中的先后依次排开
    const slots = ["b", "c", "d"].map((k) => pos.get(k));
    expect(slots).toEqual([1, 1, 1]);
  });

  it("关闭块位于不同存活条目之间 → 槽位递增", () => {
    const pos = buildClosingSlotPositions(["a", "x", "b", "y"], new Set(["a", "b"]));
    expect(pos.get("x")).toBe(1); // 排在 a 之后（存活 1 个）
    expect(pos.get("y")).toBe(2); // 排在 a、b 之后（存活 2 个）
  });

  it("全部关闭 → 均落在下标 0", () => {
    const pos = buildClosingSlotPositions(["a", "b"], new Set());
    expect(pos.get("a")).toBe(0);
    expect(pos.get("b")).toBe(0);
  });
});

// ─── 2. 关闭中间条目时滑出块留在原位 ────────────────────────

describe("v0.8.2 动画优化：关闭中间条目时滑出块留在原位置", () => {
  beforeEach(() => {
    vi.useFakeTimers();
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
        { path: "C:/temp/c.md", name: "c.md", content: "", isDirty: false },
      ] as never,
      activeTabIdx: 0,
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    useEditorStore.setState({ openTabs: [], activeTabIdx: 0 });
  });

  it("三个条目关闭中间那个：滑出块留在原位，其余条目上移补位", () => {
    render(createElement(FileTree));
    // 激活项是 a（已在最前）→ 列表保持打开顺序 [a, b, c]
    const before = Array.from(
      document.querySelectorAll(".filetree-temp-content > .filetree-node"),
    ).map((el) => el.getAttribute("title"));
    expect(before).toEqual(["C:/temp/a.md", "C:/temp/b.md", "C:/temp/c.md"]);

    // 关闭显示在第二位的 b
    act(() => {
      useEditorStore.getState().closeTab(1);
    });

    const outWrap = document.querySelector(".filetree-temp-content .item-slide-out");
    expect(outWrap).not.toBeNull();
    expect(outWrap!.textContent).toContain("b.md");

    // 滑出块的**原位置** = a 之后（关闭前 b 就在这个位置），
    // 即它留在原地滑出、下方条目（c）平滑上移补位，
    // 而不是被追加到列表末尾
    const order = Array.from(
      document.querySelectorAll(
        ".filetree-temp-content > .filetree-node, .filetree-temp-content > .item-slide-out",
      ),
    ).map((el) =>
      el.classList.contains("item-slide-out") ? "OUT:b.md" : el.getAttribute("title"),
    );
    expect(order).toEqual(["C:/temp/a.md", "OUT:b.md", "C:/temp/c.md"]);
  });

  it("关闭末位条目：滑出块落在列表末尾", () => {
    render(createElement(FileTree));
    // 列表 [a, c, b]；关闭显示在第三位的 b
    act(() => {
      useEditorStore.getState().closeTab(2);
    });
    const order = Array.from(
      document.querySelectorAll(
        ".filetree-temp-content > .filetree-node, .filetree-temp-content > .item-slide-out",
      ),
    ).map((el) =>
      el.classList.contains("item-slide-out") ? "OUT:b.md" : el.getAttribute("title"),
    );
    expect(order[order.length - 1]).toBe("OUT:b.md");
  });

  it("关闭显示在首位的条目：滑出块落在列表最前", () => {
    render(createElement(FileTree));
    // v0.8.2 调整后栏内顺序 = 打开顺序（切换标签不置顶）→ [a, b, c]，a 在首位
    act(() => {
      useEditorStore.getState().closeTab(0); // 关闭 a
    });

    const order = Array.from(
      document.querySelectorAll(
        ".filetree-temp-content > .filetree-node, .filetree-temp-content > .item-slide-out",
      ),
    ).map((el) =>
      el.classList.contains("item-slide-out") ? "OUT:a.md" : el.getAttribute("title"),
    );
    // a 原本就在首位 → 滑出块落在最前（其原位置），b/c 上移补位
    expect(order).toEqual(["OUT:a.md", "C:/temp/b.md", "C:/temp/c.md"]);
  });

  it("关闭动画总时长后才卸载（滑出 600 + 停顿 120 + 收起 400 = 1120ms）", () => {
    render(createElement(FileTree));
    act(() => {
      useEditorStore.getState().closeTab(1);
    });
    expect(document.querySelectorAll(".item-slide-out").length).toBe(1);

    act(() => vi.advanceTimersByTime(1000));
    // 尚在串行动画中（高度收起未完成）→ 快照仍在
    expect(document.querySelectorAll(".item-slide-out").length).toBe(1);

    act(() => vi.advanceTimersByTime(200));
    expect(document.querySelectorAll(".item-slide-out").length).toBe(0);
  });
});

// ─── 3. 文件夹栏关闭：串行总时长 + 原位置插回 ────────────────

describe("v0.8.2 动画优化：文件夹栏关闭的串行时序与原位置", () => {
  it("源码接线：关闭快照必须保留到串行动画总时长（不再是 SECTION_SLIDE_OUT_MS）", () => {
    // 修复点：此前用 SECTION_SLIDE_OUT_MS（360ms）清除快照，
    // 快照在高度收起前被卸载 → 下方栏瞬间跳位（看起来像"滑出与上移同时发生"）
    expect(fileTreeSrc).toContain("}, SECTION_OUT_TOTAL_MS);");
    expect(fileTreeSrc).not.toContain("}, SECTION_SLIDE_OUT_MS);");
    // 三段时长常量齐备且总时长由它们相加得出
    expect(fileTreeSrc).toContain("export const SECTION_OUT_TOTAL_MS =");
    expect(fileTreeSrc).toContain("SECTION_SLIDE_OUT_MS + SECTION_COLLAPSE_DELAY_MS + SECTION_COLLAPSE_MS");
  });

  it("关闭文件夹栏快照按原位置插回列表（不再统一追加到末尾）", () => {
    expect(fileTreeSrc).toContain("const closingSnapshots = closingFolders.map");
    expect(fileTreeSrc).toContain("const liveSections = treeDataByFolder.map");
    // 位置计算共用 buildClosingSlotPositions（关闭中条目/文件夹栏同一套坐标逻辑）
    expect(fileTreeSrc).toContain("const insertAt = buildClosingSlotPositions(sourceOrder, aliveSet);");
    // 坐标源来自"上一次渲染的文件夹栏顺序"（含正在滑出的栏）
    expect(fileTreeSrc).toContain("const prevCols = folderOrderRef.current;");
    // 旧实现：所有关闭快照追加在存活文件夹之后
    expect(fileTreeSrc).not.toContain("{closingFolders.map(({ folder, nodes }) =>");
  });

  it("关闭文件夹时不再整体清空该文件夹的子目录缓存（否则收起动画无内容可渲染）", () => {
    expect(fileTreeSrc).toContain("const collectLiveDirs = (items: FileNodeData[])");
    expect(fileTreeSrc).toContain("!liveDirs.has(key)");
  });
});

// ─── 4. 文件树目录节点展开/收起动画 ─────────────────────────

describe("v0.8.2 动画优化：文件树目录节点展开/收起动画", () => {
  it("FileTree 提供按路径固定 key 的子节点动画容器", () => {
    expect(fileTreeSrc).toContain("function TreeChildrenWrap");
    expect(fileTreeSrc).toContain("export function makeTreeChildrenWrap()");
    // key 绑定父文件夹路径：父组件重渲染（加载子目录/刷新）时不能重置动画计时
    expect(fileTreeSrc).toContain("<TreeChildrenWrap key={path} visible={visible}>");
    // 工厂必须是稳定引用（否则整棵子树重新挂载）
    expect(fileTreeSrc).toContain("const treeChildrenWrap = makeTreeChildrenWrap();");
    // 注入给 FolderSection → FileEntryNode
    expect(fileTreeSrc).toContain("childrenWrap={treeChildrenWrap}");
    expect(fileTreeSrc).toContain("childrenByPath={childrenMap}");
  });

  it("FileNode 接收并透传 childrenByPath / childrenWrap（递归传到底）", () => {
    expect(fileNodeSrc).toContain("childrenByPath?: Map<string, FileNodeData[]>");
    expect(fileNodeSrc).toContain(
      "childrenWrap?: (path: string, visible: boolean, children: React.ReactNode) => React.ReactNode",
    );
    expect(fileNodeSrc).toContain("return childrenWrap");
    expect(fileNodeSrc).toContain("childrenWrap(node.path, isExpanded, body)");
  });

  it("树节点容器：展开时 0→内容高展开、收起时锁定高度→0、播完才卸载", () => {
    expect(fileTreeSrc).toContain("export const TREE_SLIDE_EXPAND_MS = 450;");
    expect(fileTreeSrc).toContain("export const TREE_SLIDE_COLLAPSE_MS = 420;");
    expect(fileTreeSrc).toContain("el.style.transition = `height ${TREE_SLIDE_EXPAND_MS}ms ease`;");
    expect(fileTreeSrc).toContain("el.style.transition = `height ${TREE_SLIDE_COLLAPSE_MS}ms ease`;");
    // 首次挂载即展开时不播动画（避免启动恢复时整棵树一起"长出来"）
    expect(fileTreeSrc).toContain("if (firstPass) return;");
  });

  it("CSS：子节点滑入/滑出关键帧与时长（与 JS 常量同步）", () => {
    expect(fileTreeCss).toMatch(/\.filetree-children-slide \{\s*animation: tree-node-slide-in 0\.45s ease;/);
    expect(fileTreeCss).toMatch(
      /\.filetree-children-slide-out \{\s*animation: tree-node-slide-out 0\.42s ease forwards;/,
    );
    expect(fileTreeCss).toContain("@keyframes tree-node-slide-in");
    expect(fileTreeCss).toContain("@keyframes tree-node-slide-out");
    // v0.8.4 适配：需求6 将子节点动画方向由"水平滑入/滑出"改为"垂直展开/收回"
    // （滑出 to = translateY(-4px) 轻微上浮离场），新方向由 v0.8.4-anim-vertical.test.ts
    // 专门断言；此处同步更新防回退正则以匹配新语义，断言强度不变（仍锁定关键帧方向）。
    // 关键帧现含 from 块（旧实现只有 to 块），正则以 [\s\S]*? 跨过它再匹配 to 块。
    expect(fileTreeCss).toMatch(/@keyframes tree-node-slide-out \{[\s\S]*?to \{\s*opacity: 0;\s*transform: translateY\(-4px\);/);
  });

  it("文件夹子节点内容按任意深度的目录缓存挂载（否则深层目录收起无内容）", () => {
    expect(fileTreeSrc).toContain("children: f.isDir && cached ? mergeChildren(cached) : [],");
  });
});

// ─── 5. 置顶排序 ────────────────────────────────────────────

describe("v0.8.2 排序：最新打开的文件夹栏置顶", () => {
  beforeEach(() => {
    localStorage.removeItem("lightmd-file-store");
    useFileStore.setState({ openFolders: [], fileTree: [], rootPath: null });
  });

  it("依序打开三个文件夹 → 最新者第一，rootPath 同步指向它", () => {
    const store = useFileStore.getState();
    store.addOpenFolder("/p/one");
    store.addOpenFolder("/p/two");
    store.addOpenFolder("/p/three");

    const state = useFileStore.getState();
    expect(state.openFolders.map((f) => f.path)).toEqual([
      "/p/three",
      "/p/two",
      "/p/one",
    ]);
    expect(state.rootPath).toBe("/p/three");
  });

  it("侧栏渲染顺序与 store 顺序一致（最新文件夹栏在最上方）", () => {
    // 源码接线：文件夹栏按 treeDataByFolder 顺序渲染，后者由 openFolders 派生
    expect(fileTreeSrc).toContain("return openFolders.map((folder) => ({");
  });
});

describe("v0.8.2 排序：「打开的文件」条目仅新打开时置顶", () => {
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
        { path: "C:/a.md", name: "a.md", content: "", isDirty: false },
        { path: "C:/b.md", name: "b.md", content: "", isDirty: false },
        { path: "C:/c.md", name: "c.md", content: "", isDirty: false },
      ] as never,
      activeTabIdx: 0,
    });
  });
  afterEach(() => {
    useEditorStore.setState({ openTabs: [], activeTabIdx: 0 });
  });

  const titles = () =>
    Array.from(document.querySelectorAll(".filetree-temp-content > .filetree-node")).map(
      (el) => el.getAttribute("title"),
    );

  it("首次挂载：栏内顺序 = 打开顺序（不因激活项而重排）", () => {
    render(createElement(FileTree));
    expect(titles()).toEqual(["C:/a.md", "C:/b.md", "C:/c.md"]);
  });

  it("切换标签（点击栏内已打开文件）→ **不**重新置顶（v0.8.2 用户要求）", () => {
    render(createElement(FileTree));
    act(() => {
      useEditorStore.getState().setActiveTab(2);
    });
    // 顺序保持不变，只有选中态跟随激活项
    expect(titles()).toEqual(["C:/a.md", "C:/b.md", "C:/c.md"]);
    expect(
      document.querySelector(".filetree-temp-content > .filetree-node.active")?.getAttribute("title"),
    ).toBe("C:/c.md");

    act(() => {
      useEditorStore.getState().setActiveTab(1);
    });
    expect(titles()).toEqual(["C:/a.md", "C:/b.md", "C:/c.md"]);
    expect(
      document.querySelector(".filetree-temp-content > .filetree-node.active")?.getAttribute("title"),
    ).toBe("C:/b.md");
  });

  it("新打开文件 → 新条目出现在最上方（其余保持相对顺序）", () => {
    render(createElement(FileTree));
    act(() => {
      useEditorStore.setState({
        openTabs: [
          ...useEditorStore.getState().openTabs,
          { path: "C:/d.md", name: "d.md", content: "", isDirty: false },
        ] as never,
        activeTabIdx: 3,
      });
    });
    expect(titles()).toEqual(["C:/d.md", "C:/a.md", "C:/b.md", "C:/c.md"]);
  });

  it("再打开一个文件 → 继续插到最前", () => {
    render(createElement(FileTree));
    act(() => {
      useEditorStore.setState({
        openTabs: [
          ...useEditorStore.getState().openTabs,
          { path: "C:/d.md", name: "d.md", content: "", isDirty: false },
        ] as never,
        activeTabIdx: 3,
      });
    });
    act(() => {
      useEditorStore.setState({
        openTabs: [
          ...useEditorStore.getState().openTabs,
          { path: "C:/e.md", name: "e.md", content: "", isDirty: false },
        ] as never,
        activeTabIdx: 4,
      });
    });
    expect(titles()).toEqual(["C:/e.md", "C:/d.md", "C:/a.md", "C:/b.md", "C:/c.md"]);
  });

  it("新打开文件 → 新条目出现在最上方", () => {
    render(createElement(FileTree));
    act(() => {
      useEditorStore.setState({
        openTabs: [
          ...useEditorStore.getState().openTabs,
          { path: "C:/d.md", name: "d.md", content: "", isDirty: false },
        ] as never,
        activeTabIdx: 3,
      });
    });
    expect(titles()[0]).toBe("C:/d.md");
  });

  it("源码接线：条目按最近打开顺序排序（orderKeysByRecency），且不再跟随 activeItemKey", () => {
    expect(fileTreeSrc).toContain("const orderKeysByRecency = (keys: string[]): string[]");
    expect(fileTreeSrc).toContain("orderedTempEntries.forEach(({ file, idx }) =>");
    // 选中态/快捷键仍以 tempFiles 的原始下标为索引，排序不能改变它
    expect(fileTreeSrc).toContain("const isSelected = selectedTempIdx === idx;");
    // v0.8.2 调整：不得再把激活项提到最前（切换标签不置顶）
    const recencyFn = fileTreeSrc.slice(
      fileTreeSrc.indexOf("const orderKeysByRecency"),
      fileTreeSrc.indexOf("const buildTempItems"),
    );
    expect(recencyFn).not.toContain("activeItemKey");
  });
});

// ─── 6. 关闭中间文件夹栏的渲染顺序（渲染复现） ───────────────

describe("v0.8.2 动画优化：关闭中间文件夹栏时渲染顺序", () => {
  beforeEach(() => {
    // vitest 未开启 globals → @testing-library 的 auto-cleanup 不生效，
    // 显式清理，避免上一个用例残留的 DOM 干扰 querySelectorAll 计数
    cleanup();
    vi.useFakeTimers();
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
    useEditorStore.setState({ openTabs: [], activeTabIdx: 0 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("关闭中间文件夹：滑出快照插在它原来的位置（下方栏在它之后）", () => {
    // 三个文件夹（头插 → [three, two, one]）
    const store = useFileStore.getState();
    store.addOpenFolder("/p/one");
    store.addOpenFolder("/p/two");
    store.addOpenFolder("/p/three");
    const { container } = render(createElement(FileTree));

    const sectionNames = () =>
      Array.from(container.querySelectorAll(".filetree-root-name")).map(
        (el) => el.textContent,
      );
    expect(sectionNames()).toEqual(["three", "two", "one"]);

    // 关闭中间的 two：它应留在原位滑出（one 在其后）
    act(() => {
      const btns = Array.from(
        container.querySelectorAll(".filetree-folder-section"),
      );
      const twoSection = btns.find((el) =>
        el.querySelector(".filetree-root-name")?.textContent === "two",
      );
      (twoSection!.querySelector(".section-close") as HTMLElement).click();
    });

    // 只取 .filetree-scroll 的**直接子元素**（避免命中滑出快照内部嵌套的同名 section）
    const scroll = container.querySelector(".filetree-scroll")!;
    const rendered = Array.from(scroll.children)
      .filter(
        (el) =>
          el.classList.contains("section-slide") ||
          el.classList.contains("section-slide-out"),
      )
      .map((el) =>
        el.classList.contains("section-slide-out")
          ? `OUT:${el.querySelector(".filetree-root-name")?.textContent}`
          : el.querySelector(".filetree-root-name")?.textContent,
      );
    // three 在 two 之前，one 在 two 之后 → 滑出块位于中间
    expect(rendered).toEqual(["three", "OUT:two", "one"]);
  });

  it("关闭快照在串行动画播完前不会被卸载（960ms 之后才消失）", () => {
    const store = useFileStore.getState();
    store.addOpenFolder("/p/one");
    const { container } = render(createElement(FileTree));
    act(() => {
      (container.querySelector(".section-close") as HTMLElement).click();
    });
    // three 段时长：滑出 360 + 停顿 120 + 收起 480 = 960ms
    act(() => vi.advanceTimersByTime(700));
    expect(container.querySelectorAll(".section-slide-out").length).toBe(1);
    act(() => vi.advanceTimersByTime(400));
    expect(container.querySelectorAll(".section-slide-out").length).toBe(0);
    expect(container.querySelectorAll(".filetree-folder-section").length).toBe(0);
  });
});
