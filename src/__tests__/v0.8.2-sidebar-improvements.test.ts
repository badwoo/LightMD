/**
 * v0.8.2 版本功能测试
 *
 * 覆盖：
 * 1. 需求1/4：「打开的文件」栏标题栏缩小/放大按钮（关闭按钮已按 0.8.2 调整改掉，
 *    该栏随文件数据自动出现/消失）+ 首个区域标题栏可拖拽（useSectionSplit nextKey 配对）
 * 2. 需求2：四个栏标题栏双击缩小/放大（Favorites 组件双击行为 + 源码接线）
 * 3. 需求3：SlideWrap 滑入/滑出动画包装（挂载/延迟卸载/快照，0.8.2 调整放慢 50%）
 * 4. 需求5：内容高度测量纯函数（measureContentHeight / measureSectionContentHeight /
 *    findSectionByKey）——重新打开栏时上一栏收缩到内容高度
 * 5. 需求7：默认设置（新装默认值 + migrateSettings 一次性迁移，用户自定义值保留）
 * 6. 0.8.2 调整3：拖拽监听器泄漏修复（mousemove buttons===0 检测 + blur 兜底，
 *    useSectionSplit 与 useResizable 均覆盖）
 *
 * 注：需求6（新建菜单 hover 展开）为纯 UI 交互，在 TitleBar 源码接线测试中锁定。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderHook, act, render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  beginSectionDrag,
  computeSplit,
  useSectionSplit,
  SectionSizeContext,
  measureContentHeight,
  measureSectionContentHeight,
  findSectionByKey,
  type HeightNode,
} from "../hooks/useSectionSplit";
import { useResizable } from "../hooks/useResizable";
import { SlideWrap, FileTree } from "../components/sidebar/FileTree";
import { Favorites } from "../components/sidebar/Favorites";
import { syncTempFilesWithTabs } from "../utils/tempFilesSync";
import { useFileStore } from "../stores/useFileStore";
import { useSettingsStore, migrateSettings } from "../stores/useSettingsStore";
import { useEditorStore } from "../stores/useEditorStore";

// jsdom 未实现 ResizeObserver（SidebarScrollArrows 用其监听尺寸），mock 空实现，
// 供所有渲染 FileTree 的用例使用
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// ─── 2. 功能4：useSectionSplit nextKey（第一个区域改拖「本区+下区」） ──
// 注意：vitest 未开启 globals，@testing-library/react 的 auto-cleanup 不生效，
// 组件渲染类测试需在 afterEach 手动 cleanup，避免 DOM 残留影响 querySelector。
afterEach(() => cleanup());

function makeMouseEvent(clientY: number, target?: HTMLElement) {
  return {
    button: 0,
    clientX: 0,
    clientY,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    target: target ?? document.createElement("div"),
  } as unknown as React.MouseEvent;
}

const ctxWrapper = (value: unknown) => ({ children }: { children: React.ReactNode }) =>
  createElement(SectionSizeContext.Provider, { value: value as never }, children);

describe("v0.8.2 功能4：useSectionSplit nextKey 拖拽配对", () => {
  it("无 prevKey 有 nextKey：往下拖 → 本区(self)+delta 变高、下区(next)-delta 变矮", () => {
    const setPair = vi.fn();
    const sizes: Record<string, number> = { temp: 200, recent: 200 };
    const ctx = {
      sizes,
      sizeOf: (k: string) => sizes[k] ?? 0,
      setPair,
      minHeight: 80,
    };
    const { result } = renderHook(
      () => useSectionSplit({ selfKey: "temp", nextKey: "recent" }),
      { wrapper: ctxWrapper(ctx) as never },
    );

    act(() => result.current.onMouseDown(makeMouseEvent(100)));
    act(() => {
      document.dispatchEvent(new MouseEvent("mousemove", { clientY: 160, buttons: 1 })); // delta=+60
    });

    expect(setPair).toHaveBeenCalledWith("temp", "recent", 260, 140);
    act(() => document.dispatchEvent(new MouseEvent("mouseup")));
  });

  it("无 prevKey 有 nextKey：往上拖 → 本区变矮、下区变高（与分隔条方向一致）", () => {
    const setPair = vi.fn();
    const sizes: Record<string, number> = { temp: 200, recent: 200 };
    const ctx = { sizes, sizeOf: (k: string) => sizes[k] ?? 0, setPair, minHeight: 80 };
    const { result } = renderHook(
      () => useSectionSplit({ selfKey: "temp", nextKey: "recent" }),
      { wrapper: ctxWrapper(ctx) as never },
    );

    act(() => result.current.onMouseDown(makeMouseEvent(100)));
    act(() => document.dispatchEvent(new MouseEvent("mousemove", { clientY: 40, buttons: 1 }))); // delta=-60

    expect(setPair).toHaveBeenCalledWith("temp", "recent", 140, 260);
    act(() => document.dispatchEvent(new MouseEvent("mouseup")));
  });

  it("下区触底 minHeight 时本区吃掉剩余（守恒）", () => {
    const setPair = vi.fn();
    const sizes: Record<string, number> = { temp: 200, recent: 90 };
    const ctx = { sizes, sizeOf: (k: string) => sizes[k] ?? 0, setPair, minHeight: 80 };
    const { result } = renderHook(
      () => useSectionSplit({ selfKey: "temp", nextKey: "recent" }),
      { wrapper: ctxWrapper(ctx) as never },
    );

    act(() => result.current.onMouseDown(makeMouseEvent(100)));
    act(() => document.dispatchEvent(new MouseEvent("mousemove", { clientY: 160, buttons: 1 }))); // delta=+60

    // recent 90-60=30 < 80 → 钳到 80，temp = 290-80 = 210
    expect(setPair).toHaveBeenCalledWith("temp", "recent", 210, 80);
    act(() => document.dispatchEvent(new MouseEvent("mouseup")));
  });

  it("无 prevKey 也无 nextKey（唯一区域）→ 仍不可拖", () => {
    const setPair = vi.fn();
    const ctx = { sizes: {}, sizeOf: () => 200, setPair, minHeight: 80 };
    const { result } = renderHook(() => useSectionSplit({ selfKey: "temp" }), {
      wrapper: ctxWrapper(ctx) as never,
    });
    act(() => result.current.onMouseDown(makeMouseEvent(100)));
    act(() => document.dispatchEvent(new MouseEvent("mousemove", { clientY: 200, buttons: 1 })));
    expect(setPair).not.toHaveBeenCalled();
  });

  it("nextKey 拖拽起点使用 sizeOf 默认高度（未记录区域不从 0 起算）", () => {
    const setPair = vi.fn();
    const ctx = {
      sizes: { recent: 180 },
      sizeOf: (k: string) => (k === "recent" ? 180 : 250),
      setPair,
      minHeight: 80,
    };
    const { result } = renderHook(
      () => useSectionSplit({ selfKey: "temp", nextKey: "recent" }),
      { wrapper: ctxWrapper(ctx) as never },
    );

    act(() => result.current.onMouseDown(makeMouseEvent(100)));
    act(() => document.dispatchEvent(new MouseEvent("mousemove", { clientY: 130, buttons: 1 }))); // delta=+30

    expect(setPair).toHaveBeenCalledWith("temp", "recent", 280, 150);
    act(() => document.dispatchEvent(new MouseEvent("mouseup")));
  });
});

// ─── 3. 功能2：标题栏双击缩小/放大（Favorites 组件行为） ──
describe("v0.8.2 功能2：Favorites 标题栏双击切换折叠", () => {
  beforeEach(() => {
    localStorage.removeItem("lightmd-file-store");
    useFileStore.setState({
      favorites: [{ path: "C:/a.md", name: "a.md", addedAt: 1 }],
      recentFiles: [],
      recentFolders: [],
      tempFiles: [],
      fileTree: [],
      rootPath: null,
    });
  });

  function renderFavorites() {
    const setPair = vi.fn();
    const ctx = {
      sizes: { favorites: 200 },
      sizeOf: () => 200,
      setPair,
      minHeight: 80,
    };
    render(
      createElement(
        SectionSizeContext.Provider,
        { value: ctx as never },
        createElement(Favorites, { onOpen: () => {}, height: 200, sectionKey: "favorites" }),
      ),
    );
  }

  it("第一次双击标题栏 → 折叠（出现 collapsed class）", () => {
    renderFavorites();
    const header = document.querySelector(".favorites-header")!;
    fireEvent.dblClick(header);
    const section = document.querySelector(".favorites-section")!;
    expect(section.className).toContain("collapsed");
  });

  it("再次双击标题栏 → 还原（移除 collapsed class）", () => {
    renderFavorites();
    const header = document.querySelector(".favorites-header")!;
    fireEvent.dblClick(header);
    expect(document.querySelector(".favorites-section")!.className).toContain("collapsed");
    fireEvent.dblClick(header);
    expect(document.querySelector(".favorites-section")!.className).not.toContain("collapsed");
  });

  it("双击标题栏按钮不触发折叠", () => {
    renderFavorites();
    const btn = document.querySelector(".section-btn.section-minimize")!;
    fireEvent.dblClick(btn);
    expect(document.querySelector(".favorites-section")!.className).not.toContain("collapsed");
  });
});

// ─── 4. 功能3：SlideWrap 滑入/滑出动画包装 ──
/** 构造 SlideWrap 元素（children 写进 props 以满足 createElement 类型签名） */
const slide = (visible: boolean) =>
  createElement(SlideWrap, { visible, children: createElement("div", null, "content") });

describe("v0.8.2 功能3：SlideWrap 挂载/延迟卸载", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("visible=true → 渲染 children 且带滑入动画 class", () => {
    render(slide(true));
    expect(screen.getByText("content")).toBeTruthy();
    expect(document.querySelector(".section-slide")).toBeTruthy();
  });

  it("visible=false → 立即切换为滑出动画（不立即卸载），动画结束后移除", () => {
    const { rerender } = render(slide(true));
    rerender(slide(false));
    // 滑出动画期间仍渲染（wrapper 切到 out class）
    expect(screen.getByText("content")).toBeTruthy();
    expect(document.querySelector(".section-slide-out")).toBeTruthy();
    // 串行三拍（滑出 360 + 停顿 120 + 收起 480）共 960ms，1100ms 时必已卸载
    act(() => vi.advanceTimersByTime(1100));
    expect(screen.queryByText("content")).toBeNull();
  });

  it("从未显示过（visible 初始 false）→ 不渲染也无退出动画", () => {
    render(slide(false));
    expect(screen.queryByText("content")).toBeNull();
    act(() => vi.advanceTimersByTime(400));
    expect(screen.queryByText("content")).toBeNull();
  });

  it("关闭动画期间重新打开 → 立即恢复可见（不闪烁）", () => {
    const { rerender } = render(slide(true));
    rerender(slide(false));
    act(() => vi.advanceTimersByTime(150)); // 动画进行中（< 360ms）
    rerender(slide(true));
    expect(screen.getByText("content")).toBeTruthy();
    expect(document.querySelector(".section-slide-out")).toBeNull();
    // 计时器被清除，不会在稍后卸载
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByText("content")).toBeTruthy();
  });
});

// ─── 5. 功能5：内容高度测量（重新打开栏时上一栏收缩到内容高度） ──
/** 构造两层假 DOM 节点（满足 HeightNode 结构类型） */
const node = (offsetHeight: number, children: HeightNode[] = []): HeightNode => ({
  offsetHeight,
  children,
});

describe("v0.8.2 功能5：section 内容高度测量", () => {
  it("标题栏 + 未压缩列表：直接取各子元素自身高度之和（+2 border）", () => {
    // header 34 + list 150（自身高度即内容高度）→ 184 + 2
    const section = node(0, [node(34), node(150)]);
    expect(measureContentHeight(section)).toBe(186);
  });

  it("列表被 flex 拉伸（撑满）时：取内部条目之和（真实内容高度）", () => {
    // 上一栏被撑满：列表容器 offsetHeight=500，但内容只有 5 条 ×30=150
    const section = node(0, [node(34), node(500, [node(30), node(30), node(30), node(30), node(30)])]);
    expect(measureContentHeight(section)).toBe(186);
  });

  it("折叠栏（列表 display:none 高度 0）→ 结果 = 标题栏高度", () => {
    const section = node(0, [node(34), node(0, [node(0), node(0)])]);
    expect(measureContentHeight(section)).toBe(36);
  });

  it("空态容器（无条目，如收藏为空提示）→ 取容器自身高度", () => {
    // header 34 + 空态提示自身 36（grandSum=0 → 用容器自身高度）
    const section = node(0, [node(34), node(36)]);
    expect(measureContentHeight(section)).toBe(72);
  });

  it("空 section / null → null（无法测量）", () => {
    expect(measureContentHeight(node(0, []))).toBeNull();
    expect(measureContentHeight(null)).toBeNull();
    expect(measureSectionContentHeight(null)).toBeNull();
    // 全 0 高度（jsdom 无布局）→ 视为无法测量
    expect(measureContentHeight(node(0, [node(0), node(0)]))).toBeNull();
  });

  it("findSectionByKey：按 data-section-key 查找元素（key 含特殊字符）", () => {
    const root = document.createElement("div");
    const a = document.createElement("div");
    a.dataset.sectionKey = "temp";
    const b = document.createElement("div");
    b.dataset.sectionKey = "folder:C:/my project/子目录";
    root.append(a, b);
    document.body.appendChild(root);

    expect(findSectionByKey(document, "temp")).toBe(a);
    expect(findSectionByKey(document, "folder:C:/my project/子目录")).toBe(b);
    expect(findSectionByKey(document, "missing")).toBeNull();
    document.body.removeChild(root);
  });

  it("源码接线：四个栏的根元素都带 data-section-key（供测量定位）", () => {
    const fileTreeSrc = readFileSync(
      resolve(__dirname, "../components/sidebar/FileTree.tsx"),
      "utf-8",
    );
    const favoritesSrc = readFileSync(
      resolve(__dirname, "../components/sidebar/Favorites.tsx"),
      "utf-8",
    );
    const recentSrc = readFileSync(
      resolve(__dirname, "../components/sidebar/RecentFiles.tsx"),
      "utf-8",
    );
    expect(fileTreeSrc).toContain('data-section-key="temp"');
    expect(fileTreeSrc).toContain("data-section-key={sectionKey ?? `folder:${folder.path}`}");
    expect(favoritesSrc).toContain('data-section-key={sectionKey ?? "favorites"}');
    expect(recentSrc).toContain('data-section-key={sectionKey ?? "recent"}');
  });
});

// ─── 6. 功能7：默认设置 + 一次性迁移 ──
describe("v0.8.2 功能7：默认设置", () => {
  it("新装默认值：自动保存 60s、载入文件 30（开启）、文件夹恢复开启且 5 个", () => {
    const s = useSettingsStore.getState();
    expect(s.autoSaveIntervalMs).toBe(60000);
    expect(s.loadLastFileOnStartup).toBe(true);
    expect(s.loadLastFileCount).toBe(30);
    expect(s.loadLastFolderOnStartup).toBe(true);
    expect(s.loadLastFolderCount).toBe(5);
  });
});

describe("v0.8.2 功能7：migrateSettings 一次性迁移", () => {
  it("v1 老数据（旧默认值）→ 迁移为新默认值", () => {
    const migrated = migrateSettings(
      {
        autoSaveIntervalMs: 30000,
        loadLastFileOnStartup: true,
        loadLastFileCount: 1,
        loadLastFolderOnStartup: false,
        loadLastFolderCount: 1,
      },
      1,
    );
    expect(migrated.autoSaveIntervalMs).toBe(60000);
    expect(migrated.loadLastFileCount).toBe(30);
    expect(migrated.loadLastFolderOnStartup).toBe(true);
    expect(migrated.loadLastFolderCount).toBe(5);
  });

  it("用户自定义值保留（不被迁移改写）", () => {
    const migrated = migrateSettings(
      {
        autoSaveIntervalMs: 120000, // 用户已改为 120s
        loadLastFileCount: 10, // 用户已改为 10
        loadLastFolderCount: 3,
      },
      1,
    );
    expect(migrated.autoSaveIntervalMs).toBe(120000);
    expect(migrated.loadLastFileCount).toBe(10);
    expect(migrated.loadLastFolderCount).toBe(3);
  });

  it("version<1 数据同时完成宽度迁移与 v2 默认值迁移", () => {
    const migrated = migrateSettings(
      {
        sidebarWidth: 260,
        outlineWidth: 240,
        autoSaveIntervalMs: 30000,
        loadLastFileCount: 1,
        loadLastFolderOnStartup: false,
        loadLastFolderCount: 1,
      },
      0,
    );
    expect(migrated.sidebarWidth).toBe(279);
    expect(migrated.outlineWidth).toBe(259);
    expect(migrated.autoSaveIntervalMs).toBe(60000);
    expect(migrated.loadLastFileCount).toBe(30);
    expect(migrated.loadLastFolderOnStartup).toBe(true);
    expect(migrated.loadLastFolderCount).toBe(5);
  });

  it("空数据迁移不抛错", () => {
    expect(() => migrateSettings(null, 0)).not.toThrow();
    expect(() => migrateSettings({}, 2)).not.toThrow();
  });

  it("persist options version 已升到 4（v0.9.0 新增自定义快捷键）", () => {
    expect((useSettingsStore.persist as unknown as { getOptions: () => { version: number } }).getOptions().version).toBe(4);
  });
});

// ─── 7. 源码接线：功能1/2/6 的 UI 结构锁定 ──
describe("v0.8.2 源码接线（UI 结构锁定）", () => {
  const fileTreeSrc = readFileSync(
    resolve(__dirname, "../components/sidebar/FileTree.tsx"),
    "utf-8",
  );
  const titleBarSrc = readFileSync(
    resolve(__dirname, "../components/layout/TitleBar.tsx"),
    "utf-8",
  );
  const favoritesSrc = readFileSync(
    resolve(__dirname, "../components/sidebar/Favorites.tsx"),
    "utf-8",
  );
  const recentSrc = readFileSync(
    resolve(__dirname, "../components/sidebar/RecentFiles.tsx"),
    "utf-8",
  );

  it("0.8.2 调整1：temp 栏标题栏只有缩小/放大（无关闭按钮、无 temp.closeAll 命令）", () => {
    expect(fileTreeSrc).toContain('setTempCollapsed((c) => !c); setTempMaximized(false)');
    expect(fileTreeSrc).toContain("setTempMaximized((m) => !m); setTempCollapsed(false)");
    // 关闭按钮已移除：不应再有关闭命令与确认文案引用
    expect(fileTreeSrc).not.toContain("temp.closeAll");
    expect(fileTreeSrc).not.toContain("handleCloseTempSection");
    expect(fileTreeSrc).not.toContain("closeAllConfirm");
  });

  it("0.8.2 调整3：四个栏标题栏在折叠/放大状态下均禁用拖拽", () => {
    // v0.9.5 问题6 修订2：temp 恢复 sizeOf 分区高度（收缩写入 sizeOf），拖拽正常
    expect(fileTreeSrc).toContain("if (tempCollapsed || tempMaximized) return;");
    expect(fileTreeSrc).toContain("if (!collapsed && !maximized) onMouseDown(e);");
    expect(favoritesSrc).toContain("if (!collapsed && !maximized) onMouseDown(e);");
    expect(recentSrc).toContain("if (!collapsed && !maximized) onMouseDown(e);");
  });

  it("0.9.5 问题6 修订2：条目位空档由「打开的文件」栏收缩高度承担（面板内无 spacer）", () => {
    // 收缩目标 = 列表内容自然高度 + 一个条目位（面板整体从空档之后开始）
    expect(fileTreeSrc).toContain("export const SIDEBAR_ITEM_HEIGHT = 30;");
    expect(fileTreeSrc).toContain("Math.max(MIN_SECTION_HEIGHT, contentH + SIDEBAR_ITEM_HEIGHT)");
    // 面板内不再渲染空档，间距由上一栏高度承担
    expect(favoritesSrc).not.toContain("filetree-temp-spacer");
    expect(recentSrc).not.toContain("filetree-temp-spacer");
    // 末栏（含收藏/最近）无条件撑满到底部
    expect(fileTreeSrc).toContain("if (total < container) {");
    expect(fileTreeSrc).not.toContain("lastIsFavOrRecent");
    // 收缩高度不写回设置（否则收藏栏打开时退出会残留空档）
    expect(fileTreeSrc).toContain("{ ...sectionSizes, temp: prevTempSizeRef.current }");
  });

  it("0.8.2 调整3：beginSectionDrag 具备 buttons===0 检测与 blur 兜底（防监听器泄漏）", () => {
    const hookSrc = readFileSync(
      resolve(__dirname, "../hooks/useSectionSplit.ts"),
      "utf-8",
    );
    expect(hookSrc).toContain("if (ev.buttons === 0)");
    expect(hookSrc.match(/addEventListener\("blur"/g)?.length).toBe(1);
    expect(hookSrc.match(/removeEventListener\("blur"/g)?.length).toBe(1);
  });

  it("0.8.2 调整3：useResizable 同样具备 buttons===0 检测与 blur 兜底", () => {
    const hookSrc = readFileSync(
      resolve(__dirname, "../hooks/useResizable.ts"),
      "utf-8",
    );
    expect(hookSrc).toContain("if (e.buttons === 0)");
    expect(hookSrc).toContain('window.removeEventListener("blur", handleMouseUp)');
  });

  it("0.8.2 调整2：滑入/滑出动画时长放慢 50%（0.33s/0.36s，JS 卸载延时同步 360ms）", () => {
    const cssSrc = readFileSync(
      resolve(__dirname, "../components/sidebar/FileTree.css"),
      "utf-8",
    );
    expect(cssSrc).toMatch(/section-slide-in 0\.33s ease/);
    expect(cssSrc).toMatch(/section-slide-out 0\.36s ease forwards/);
    expect(fileTreeSrc).toContain("const SECTION_SLIDE_OUT_MS = 360;");
  });

  it("功能2：四个栏标题栏都注册 onDoubleClick 切换折叠", () => {
    // FolderSection / temp header 在 FileTree.tsx，Favorites/RecentFiles 在各自组件
    expect(fileTreeSrc.match(/onDoubleClick=/g)?.length).toBeGreaterThanOrEqual(2);
    expect(favoritesSrc).toContain("onDoubleClick={handleHeaderDoubleClick}");
    expect(recentSrc).toContain("onDoubleClick={handleHeaderDoubleClick}");
  });

  it("功能3：正常渲染的文件夹/收藏/最近都包了 section-slide 动画（temp 走 SlideWrap）", () => {
    expect(fileTreeSrc).toContain('className="section-slide"');
    expect(fileTreeSrc.match(/<SlideWrap /g)?.length).toBe(4);
  });

  it("动画优化：滑入展开/滑出收起 wrapper + section 高度过渡 + 拖拽禁用过渡", () => {
    // SlideInWrap：挂载时 0→内容高展开（下方栏被平滑推下去）
    // SlideOutWrap：挂载时锁定当前高→0 收起（下方栏平滑顶上来）
    expect(fileTreeSrc).toContain("export function SlideInWrap");
    expect(fileTreeSrc).toContain("export function SlideOutWrap");
    // 文件夹正常渲染走 SlideInWrap、关闭快照走 SlideOutWrap
    expect(fileTreeSrc).toContain("<SlideOutWrap key={`closing-${folder.path}`}>");
    expect(fileTreeSrc).toContain("<SlideInWrap>{section}</SlideInWrap>");
    // 拖拽期间标记 body.section-dragging（CSS 据此禁用高度过渡保证跟手）
    const hookSrc = readFileSync(
      resolve(__dirname, "../hooks/useSectionSplit.ts"),
      "utf-8",
    );
    expect(hookSrc).toContain('document.body.classList.add("section-dragging")');
    expect(hookSrc).toContain('document.body.classList.remove("section-dragging")');
    const cssSrc = readFileSync(
      resolve(__dirname, "../components/sidebar/FileTree.css"),
      "utf-8",
    );
    expect(cssSrc).toMatch(/\.filetree-folder-section,\s*\n\.filetree-temp-section,\s*\n\.favorites-section,\s*\n\.recent-files \{\s*\n\s*transition: height 0\.3s ease;/);
    expect(cssSrc).toContain("body.section-dragging .filetree-temp-section");
  });

  it("功能4：FolderSection/Favorites/RecentFiles 都接线 nextSectionKey", () => {
    expect(fileTreeSrc).toContain("nextSectionKey={opts?.closing ? undefined : nextOf(fkey)}");
    expect(fileTreeSrc).toContain('nextSectionKey={nextOf("favorites")}');
    expect(fileTreeSrc).toContain('nextSectionKey={nextOf("recent")}');
  });

  it("功能6：新建菜单 hover 自动展开、移出整体区域收起", () => {
    expect(titleBarSrc).toContain("onMouseEnter={() => setShowNewMenu(true)}");
    expect(titleBarSrc).toContain("onMouseLeave={() => setShowNewMenu(false)}");
  });
});

// ─── 8. 0.8.2 调整3：拖拽监听器泄漏修复（行为测试） ──
describe("0.8.2 调整3：beginSectionDrag 拖拽监听器泄漏修复", () => {
  it("mousemove 检测到 buttons===0（mouseup 丢失场景）→ 立即结束拖拽，后续 mousemove 不再 setPair", () => {
    const setPair = vi.fn();
    const ctx = {
      sizes: { a: 200, b: 200 },
      sizeOf: (k: string) => ({ a: 200, b: 200 } as Record<string, number>)[k] ?? 0,
      setPair,
      minHeight: 80,
    };
    const { result } = renderHook(() => useSectionSplit({ selfKey: "b", prevKey: "a" }), {
      wrapper: ctxWrapper(ctx) as never,
    });

    act(() => result.current.onMouseDown(makeMouseEvent(100)));
    // 正常拖拽（buttons=1）
    act(() => document.dispatchEvent(new MouseEvent("mousemove", { clientY: 130, buttons: 1 })));
    expect(setPair).toHaveBeenCalledTimes(1);
    expect(setPair).toHaveBeenLastCalledWith("a", "b", 230, 170);

    // 模拟 mouseup 丢失：mousemove 时按键已全部松开（buttons=0）→ 清理监听
    act(() => document.dispatchEvent(new MouseEvent("mousemove", { clientY: 150, buttons: 0 })));
    expect(setPair).toHaveBeenCalledTimes(1); // buttons=0 不触发高度改写

    // 残留监听器已被清理：后续 mousemove（即使 buttons=1）不再改写高度
    act(() => document.dispatchEvent(new MouseEvent("mousemove", { clientY: 180, buttons: 1 })));
    expect(setPair).toHaveBeenCalledTimes(1);
  });

  it("窗口 blur → 立即结束拖拽（mouseup 丢失兜底）", () => {
    const setPair = vi.fn();
    const ctx = {
      sizes: { a: 200, b: 200 },
      sizeOf: (k: string) => ({ a: 200, b: 200 } as Record<string, number>)[k] ?? 0,
      setPair,
      minHeight: 80,
    };
    const { result } = renderHook(() => useSectionSplit({ selfKey: "b", prevKey: "a" }), {
      wrapper: ctxWrapper(ctx) as never,
    });

    act(() => result.current.onMouseDown(makeMouseEvent(100)));
    act(() => window.dispatchEvent(new Event("blur")));
    // blur 后监听已清理：mousemove 不再触发 setPair
    act(() => document.dispatchEvent(new MouseEvent("mousemove", { clientY: 180, buttons: 1 })));
    expect(setPair).not.toHaveBeenCalled();
  });

  it("beginSectionDrag（非 hook 入口）同样具备 buttons===0 兜底", () => {
    const setPair = vi.fn();
    act(() => {
      beginSectionDrag(
        "a",
        "b",
        () => ({ top: 200, bottom: 200 }),
        setPair,
        80,
        makeMouseEvent(100),
      );
    });
    act(() => document.dispatchEvent(new MouseEvent("mousemove", { clientY: 130, buttons: 1 })));
    expect(setPair).toHaveBeenCalledTimes(1);
    act(() => document.dispatchEvent(new MouseEvent("mousemove", { clientY: 150, buttons: 0 })));
    act(() => document.dispatchEvent(new MouseEvent("mousemove", { clientY: 180, buttons: 1 })));
    expect(setPair).toHaveBeenCalledTimes(1);
  });
});

describe("0.8.2 调整3：useResizable 拖拽监听器泄漏修复", () => {
  function makeDown(clientX: number): React.MouseEvent {
    return {
      button: 0,
      clientX,
      clientY: 0,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      currentTarget: document.createElement("div"),
    } as unknown as React.MouseEvent;
  }

  it("mousemove 检测到 buttons===0 → 结束拖拽，宽度不再变化", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useResizable({ direction: "left", initialWidth: 200, minWidth: 100, maxWidth: 480, onChange }),
    );

    act(() => result.current.onMouseDown(makeDown(0)));
    // 正常拖拽（buttons=1）：200 + 50 = 250
    act(() => document.dispatchEvent(new MouseEvent("mousemove", { clientX: 50, buttons: 1 })));
    expect(onChange).toHaveBeenLastCalledWith(250);

    // mouseup 丢失 + buttons=0 → 清理监听
    act(() => document.dispatchEvent(new MouseEvent("mousemove", { clientX: 100, buttons: 0 })));
    expect(result.current.isDragging).toBe(false);

    // 残留监听器已被清理：后续 mousemove 不再改宽度
    act(() => document.dispatchEvent(new MouseEvent("mousemove", { clientX: 200, buttons: 1 })));
    expect(onChange).toHaveBeenLastCalledWith(250);
  });

  it("窗口 blur → 结束拖拽（mouseup 丢失兜底）", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useResizable({ direction: "left", initialWidth: 200, minWidth: 100, maxWidth: 480, onChange }),
    );

    act(() => result.current.onMouseDown(makeDown(0)));
    act(() => window.dispatchEvent(new Event("blur")));
    act(() => document.dispatchEvent(new MouseEvent("mousemove", { clientX: 200, buttons: 1 })));
    expect(onChange).not.toHaveBeenCalled();
    expect(result.current.isDragging).toBe(false);
  });
});

// ─── 9. 0.8.2：「打开的文件」条目滑入/滑出动画（渲染层 diff 全链路） ──
describe("0.8.2：「打开的文件」条目滑入/滑出动画", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.removeItem("lightmd-file-store");
    localStorage.removeItem("lightmd-editor-store");
    useFileStore.setState({
      favorites: [],
      recentFiles: [],
      recentFolders: [],
      // v0.8.2：栏条目改由 openTabs 同步生成，tempFiles 初始为空即可
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

  it("关闭单个文件：条目以滑出快照补渲染（.item-slide-out），动画结束后移除", () => {
    render(createElement(FileTree));
    expect(screen.getByTitle("C:/temp/a.md")).toBeTruthy();
    expect(screen.getByTitle("C:/temp/b.md")).toBeTruthy();

    // v0.8.2：关闭标签（栏条目随之同步消失）
    act(() => {
      useEditorStore.getState().closeTab(1);
    });
    // 被关闭的条目以快照进入滑出动画（数据已移除但视觉保留至动画结束）
    const outWraps = document.querySelectorAll(".item-slide-out");
    expect(outWraps.length).toBe(1);
    expect(outWraps[0].textContent).toContain("b.md");
    // 未关闭的条目正常渲染
    expect(screen.getByTitle("C:/temp/a.md")).toBeTruthy();

    // 串行三拍（滑出 600 + 停顿 120 + 收起 400）共 1120ms，1300ms 时必已移除
    act(() => vi.advanceTimersByTime(1300));
    expect(document.querySelectorAll(".item-slide-out").length).toBe(0);
    expect(screen.queryByTitle("C:/temp/b.md")).toBeNull();
  });

  it("同时关闭多个文件（栏仍有剩余条目）：各自进入滑出动画并按时移除", () => {
    render(createElement(FileTree));
    act(() => {
      // 从后往前关闭 b、c（避免索引漂移），保留 a
      useEditorStore.getState().closeTab(2);
      useEditorStore.getState().closeTab(1);
    });
    // 两个被关闭的条目并行动画，剩余 a.md 正常渲染（栏不整体关闭）
    expect(document.querySelectorAll(".item-slide-out").length).toBe(2);
    expect(screen.getByTitle("C:/temp/a.md")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1300));
    expect(document.querySelectorAll(".item-slide-out").length).toBe(0);
  });

  it("全部文件关闭：整栏进入滑出动画（section-slide-out）后卸载", () => {
    render(createElement(FileTree));
    expect(document.querySelector(".filetree-temp-section")).toBeTruthy();
    act(() => {
      useEditorStore.getState().closeTab(2);
      useEditorStore.getState().closeTab(1);
      useEditorStore.getState().closeTab(0);
    });
    // 栏整体在滑出动画中（关闭前一帧快照，条目完整）
    expect(document.querySelector(".section-slide-out")).toBeTruthy();
    // 串行三拍（滑出 360 + 停顿 120 + 收起 480）共 960ms，1100ms 时必已卸载
    act(() => vi.advanceTimersByTime(1100));
    expect(document.querySelector(".filetree-temp-section")).toBeNull();
  });

  it("源码接线：条目 diff 渲染层 + CSS 滑入/滑出动画", () => {
    const fileTreeSrc = readFileSync(
      resolve(__dirname, "../components/sidebar/FileTree.tsx"),
      "utf-8",
    );
    const cssSrc = readFileSync(
      resolve(__dirname, "../components/sidebar/FileTree.css"),
      "utf-8",
    );
    // 渲染层 diff：条目统一构造 + 关闭快照补渲染
    expect(fileTreeSrc).toContain("const buildTempItems = ()");
    expect(fileTreeSrc).toContain("function ItemSlideOut");
    expect(fileTreeSrc).toContain("<ItemSlideOut key={`out-${c.key}`}>{c.el}</ItemSlideOut>");
    // 关闭动画串行三拍：先水平滑出 → 停顿 → 再收起高度（避免两阶段视觉上同时发生）
    expect(fileTreeSrc).toContain("const SECTION_SLIDE_OUT_MS = 360;");
    expect(fileTreeSrc).toContain("const SECTION_COLLAPSE_DELAY_MS = 120;");
    expect(fileTreeSrc).toContain("const SECTION_COLLAPSE_MS = 480;");
    expect(fileTreeSrc).toContain("const ITEM_SLIDE_OUT_MS = 600;");
    expect(fileTreeSrc).toContain("const ITEM_COLLAPSE_DELAY_MS = 120;");
    expect(fileTreeSrc).toContain("const ITEM_COLLAPSE_MS = 400;");
    expect(fileTreeSrc).toContain("ITEM_SLIDE_OUT_MS + ITEM_COLLAPSE_DELAY_MS");
    expect(fileTreeSrc).toContain("SECTION_SLIDE_OUT_MS + SECTION_COLLAPSE_DELAY_MS");
    // 快照图标紧跟「打开的文件」标题右侧（header-left 组）
    expect(fileTreeSrc).toContain('className="filetree-temp-header-left"');
    const leftIdx = fileTreeSrc.indexOf("filetree-temp-header-left");
    const snapshotIdx = fileTreeSrc.indexOf("filetree-temp-snapshot-btn");
    const titleIdx = fileTreeSrc.indexOf('>{t("filetree.openedFiles")}<');
    expect(leftIdx).toBeGreaterThan(-1);
    expect(titleIdx).toBeGreaterThan(leftIdx);
    expect(snapshotIdx).toBeGreaterThan(titleIdx); // 快照按钮在标题之后（紧跟）
    // CSS：滑入/滑出动画时长（条目再放慢 50%）+ 滑出快照禁止重播滑入
    expect(cssSrc).toMatch(/\.filetree-temp-content \.filetree-node \{\s*animation: item-slide-in 0\.5s ease;/);
    expect(cssSrc).toMatch(/\.item-slide-out \{\s*animation: item-slide-out 0\.6s ease forwards;/);
    expect(cssSrc).toMatch(/\.item-slide-out \.filetree-node \{\s*animation: none;/);
    expect(cssSrc).toContain(".filetree-temp-header-left");
    expect(cssSrc).not.toContain(".filetree-temp-header-controls");
  });
});

// ─── 10. 0.8.2 根因修复：栏条目数与标签数一致、激活条目选中色一致 ──
describe("0.8.2：syncTempFilesWithTabs 栏条目对齐纯函数", () => {
  type TF = { path: string; name: string; isDir: boolean; size: number };
  // 空数组需显式类型，否则 T 被推断为 never（泛型由首个参数决定）
  const EMPTY: TF[] = [];
  const t = (path: string, name: string, isUntitled = false) => ({ path, name, isUntitled });

  it("把已打开的真实文件标签映射为栏条目（顺序与标签一致）", () => {
    const { next } = syncTempFilesWithTabs(EMPTY, [
      t("C:/a.md", "a.md"),
      t("C:/b.md", "b.md"),
    ]);
    expect(next.map((f) => f.path)).toEqual(["C:/a.md", "C:/b.md"]);
  });

  it("未落盘标签（isUntitled / 空 path）不计入栏条目", () => {
    const { next } = syncTempFilesWithTabs(EMPTY, [
      t("", "未命名 1", true),
      t("C:/a.md", "a.md"),
      t("", "未命名 2", true),
    ]);
    expect(next.map((f) => f.path)).toEqual(["C:/a.md"]);
    expect(next).toHaveLength(1);
  });

  it("保留已有条目的 size / 以标签名为准（重命名后跟随）", () => {
    const { next } = syncTempFilesWithTabs(
      [{ path: "C:/a.md", name: "旧名.md", isDir: false, size: 2048 }],
      [t("C:/a.md", "新名.md")],
    );
    expect(next[0].size).toBe(2048);
    expect(next[0].name).toBe("新名.md");
  });

  it("幽灵条目（标签已关但条目残留）被清除 —— 复现原『数量不一致』", () => {
    const { next, changed } = syncTempFilesWithTabs(
      [
        { path: "C:/a.md", name: "a.md", isDir: false, size: 0 },
        { path: "C:/ghost.md", name: "ghost.md", isDir: false, size: 0 },
      ],
      [t("C:/a.md", "a.md")],
    );
    expect(changed).toBe(true);
    expect(next.map((f) => f.path)).toEqual(["C:/a.md"]);
  });

  it("缺失条目被补齐（另存为晋升 / 打开文件夹内文件）", () => {
    const { next, changed } = syncTempFilesWithTabs(EMPTY, [
      t("C:/folder/inner.md", "inner.md"),
    ]);
    expect(changed).toBe(true);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ path: "C:/folder/inner.md", isDir: false, size: 0 });
  });

  it("已对齐时 changed=false（不会触发无意义的 store 写入）", () => {
    const aligned = [{ path: "C:/a.md", name: "a.md", isDir: false, size: 0 }];
    const { changed } = syncTempFilesWithTabs(aligned, [t("C:/a.md", "a.md")]);
    expect(changed).toBe(false);
  });

  it("顺序变化也视为 changed（栏内顺序与标签顺序保持一致）", () => {
    const { changed, next } = syncTempFilesWithTabs(
      [
        { path: "C:/b.md", name: "b.md", isDir: false, size: 0 },
        { path: "C:/a.md", name: "a.md", isDir: false, size: 0 },
      ],
      [t("C:/a.md", "a.md"), t("C:/b.md", "b.md")],
    );
    expect(changed).toBe(true);
    expect(next.map((f) => f.path)).toEqual(["C:/a.md", "C:/b.md"]);
  });
});

describe("0.8.2：栏条目数与标签数一致 / 激活条目选中色一致（渲染复现）", () => {
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
  });
  afterEach(() => {
    useEditorStore.setState({ openTabs: [], activeTabIdx: 0 });
  });

  it("打开文件夹内的文件同样出现在栏中（原：不进 tempFiles → 数量偏少）", () => {
    useEditorStore.setState({
      openTabs: [
        { path: "C:/proj/inner.md", name: "inner.md", content: "", isDirty: false },
        { path: "C:/outside.md", name: "outside.md", content: "", isDirty: false },
      ] as never,
      activeTabIdx: 0,
    });
    // 即使有文件夹打开着（旧逻辑会跳过 addTempFile），栏条目仍与标签一一对应
    useFileStore.setState({ openFolders: [{ path: "C:/proj", name: "proj", fileTree: [] }] });

    render(createElement(FileTree));

    const items = document.querySelectorAll(".filetree-temp-content > .filetree-node");
    expect(items.length).toBe(2);
    expect(useFileStore.getState().tempFiles.map((f) => f.path)).toEqual([
      "C:/proj/inner.md",
      "C:/outside.md",
    ]);
  });

  it("激活的真实文件标签对应条目带 active（选中色）且唯一", () => {
    useEditorStore.setState({
      openTabs: [
        { path: "C:/a.md", name: "a.md", content: "", isDirty: false },
        { path: "C:/b.md", name: "b.md", content: "", isDirty: false },
      ] as never,
      activeTabIdx: 1,
    });

    render(createElement(FileTree));

    const activeItems = document.querySelectorAll(".filetree-temp-content > .filetree-node.active");
    expect(activeItems.length).toBe(1);
    expect(activeItems[0].getAttribute("title")).toBe("C:/b.md");
  });

  it("未落盘标签与真实文件混合：激活者为未落盘标签时只有该条目带 active", () => {
    useEditorStore.setState({
      openTabs: [
        { id: "untitled-1", path: "", name: "未命名 1", content: "", isUntitled: true, isDirty: false },
        { path: "C:/a.md", name: "a.md", content: "", isDirty: false },
      ] as never,
      activeTabIdx: 0,
    });

    render(createElement(FileTree));

    const activeItems = document.querySelectorAll(".filetree-temp-content > .filetree-node.active");
    expect(activeItems.length).toBe(1);
    expect(activeItems[0].textContent).toContain("未命名 1");
  });

  it("切换激活标签后 active 跟随移动（两类条目判定标准统一）", () => {
    useEditorStore.setState({
      openTabs: [
        { path: "C:/a.md", name: "a.md", content: "", isDirty: false },
        { path: "C:/b.md", name: "b.md", content: "", isDirty: false },
      ] as never,
      activeTabIdx: 0,
    });

    render(createElement(FileTree));
    expect(
      document.querySelector(".filetree-temp-content > .filetree-node.active")?.getAttribute("title"),
    ).toBe("C:/a.md");

    act(() => {
      useEditorStore.getState().setActiveTab(1);
    });
    const after = document.querySelectorAll(".filetree-temp-content > .filetree-node.active");
    expect(after.length).toBe(1);
    expect(after[0].getAttribute("title")).toBe("C:/b.md");
  });

  it("关闭标签后栏条目随之减少（无幽灵条目）", () => {
    useEditorStore.setState({
      openTabs: [
        { path: "C:/a.md", name: "a.md", content: "", isDirty: false },
        { path: "C:/b.md", name: "b.md", content: "", isDirty: false },
      ] as never,
      activeTabIdx: 1,
    });

    render(createElement(FileTree));
    act(() => {
      useEditorStore.getState().closeTab(1);
    });

    expect(useFileStore.getState().tempFiles.map((f) => f.path)).toEqual(["C:/a.md"]);
    const items = document.querySelectorAll(".filetree-temp-content > .filetree-node");
    expect(items.length).toBe(1);
  });

  it("源码接线：栏条目以 openTabs 为真相源（同步 effect + 统一 activeItemKey）", () => {
    const fileTreeSrc = readFileSync(
      resolve(__dirname, "../components/sidebar/FileTree.tsx"),
      "utf-8",
    );
    expect(fileTreeSrc).toContain("syncTempFilesWithTabs(tempFiles, editorOpenTabs)");
    expect(fileTreeSrc).toContain("const activeItemKey = useMemo(");
    expect(fileTreeSrc).toContain("const isActive = itemKey === activeItemKey;");
    // 旧的两套判定标准不应再出现
    expect(fileTreeSrc).not.toContain("idx === editorActiveTabIdx && !globalFilePath");
    expect(fileTreeSrc).not.toContain("const isActive = activePath === file.path;");
  });
});
