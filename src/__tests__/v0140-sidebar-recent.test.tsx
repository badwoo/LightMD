/**
 * v0.14.0 需求3 + 需求4 测试
 *
 * 需求3：左侧「最近打开」点时钟图标后面板不出来
 *   根因（实机取证，见 _verify-out/v0140-probe-recent.txt）：
 *   ① 渲染条件过严：`showRecent && recentFiles.length > 0` 只看 recentFiles，
 *      而 RecentFiles 自 v0.8.5 起是「文件+文件夹」混排。只开过文件夹时
 *      recentFiles=[] 但 recentFolders 非空 → 时钟按钮 active 了、面板一次都不挂载。
 *   ② 侧栏溢出时面板在滚动视口之外：DOM 已挂载、高度正常、数据也在，
 *      但 top 860px 落在 703px 的滚动视口下方 → 用户"看不到窗口"。
 *      → FileTree 现在点开时会把面板滚进可视区。
 *
 * 需求4：文件夹栏默认高度 = 标题栏 + (11 可见条目 + 1 留白条目位) × 行高
 *   实测标题栏 32px、行高 30px → 392px（旧实现 250px = 7 条，与用户反馈吻合）。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import {
  SIDEBAR_ITEM_HEIGHT,
  FOLDER_VISIBLE_ROWS,
  FOLDER_HEADER_HEIGHT,
  DEFAULT_FOLDER_SECTION_HEIGHT,
  DEFAULT_SECTION_HEIGHT,
  defaultSectionHeight,
} from "../components/sidebar/FileTree";
import { RecentFiles } from "../components/sidebar/RecentFiles";
import { useFileStore } from "../stores/useFileStore";
import { MIN_SECTION_HEIGHT } from "../hooks/useSectionSplit";

// ─── jsdom 里没有的浏览器 API ────────────────────────────────
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  },
);

beforeEach(() => {
  localStorage.clear();
  useFileStore.setState({ recentFiles: [], recentFolders: [], favorites: [], tempFiles: [] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ══════════════════════════════════════════════════════════════
// 需求4：文件夹栏高度 = 11 条目 + 末尾留空一行
// ══════════════════════════════════════════════════════════════
import { migrateSettings } from "../stores/useSettingsStore";

describe("v0.14.0 需求4：文件夹栏默认高度（11 条 + 末尾留白）", () => {
  it("SIDEBAR_ITEM_HEIGHT 与 .filetree-node 行高一致，为 30px", () => {
    expect(SIDEBAR_ITEM_HEIGHT).toBe(30);
  });

  it("默认可视条目数为 11（用户要求）", () => {
    expect(FOLDER_VISIBLE_ROWS).toBe(11);
  });

  it("标题栏实测高度为 32px（padding 6+6 + line-height 17.6 + 上下各 1px border）", () => {
    // 该值是打包产物 + WebView2 实测值，不是拍脑袋的 26~30
    expect(FOLDER_HEADER_HEIGHT).toBe(32);
  });

  it("DEFAULT_FOLDER_SECTION_HEIGHT === FOLDER_HEADER_HEIGHT + 12 * SIDEBAR_ITEM_HEIGHT", () => {
    // 12 = 11 个可见条目 + 1 个留白条目位（给右键操作留的空白）
    expect(DEFAULT_FOLDER_SECTION_HEIGHT).toBe(
      FOLDER_HEADER_HEIGHT + (FOLDER_VISIBLE_ROWS + 1) * SIDEBAR_ITEM_HEIGHT,
    );
    // 夹带的含义验证：草稿算出来应该是 392
    expect(DEFAULT_FOLDER_SECTION_HEIGHT).toBe(392);
  });

  it("默认高度足以容纳 11 条 + 末尾 1 行留白（可算出条目位）", () => {
    const contentHeight = DEFAULT_FOLDER_SECTION_HEIGHT - FOLDER_HEADER_HEIGHT;
    const rowsFitting = contentHeight / SIDEBAR_ITEM_HEIGHT;
    expect(rowsFitting).toBe(12); // 11 条内容 + 1 条留白
    // 至少 11 个完整条目可见（这是用户的核心诉求，旧值 250px 只有 7 条）
    expect(rowsFitting).toBeGreaterThanOrEqual(FOLDER_VISIBLE_ROWS);
  });

  it("defaultSectionHeight('folder:xxx') 返回新的文件夹默认高度", () => {
    expect(defaultSectionHeight("folder:D:\\AI\\notes")).toBe(DEFAULT_FOLDER_SECTION_HEIGHT);
    expect(defaultSectionHeight("folder:/home/me/docs")).toBe(DEFAULT_FOLDER_SECTION_HEIGHT);
  });

  it("非文件夹栏默认高度不受影响（仍是 200）", () => {
    expect(DEFAULT_SECTION_HEIGHT).toBe(200);
    for (const key of ["temp", "favorites", "recent"]) {
      expect(defaultSectionHeight(key)).toBe(200);
    }
  });

  it("默认高度 ≥ MIN_SECTION_HEIGHT（不会被最小高度规则钳掉）", () => {
    expect(DEFAULT_FOLDER_SECTION_HEIGHT).toBeGreaterThan(MIN_SECTION_HEIGHT);
  });

  it("回归：defaultSectionHeight 不吞掉用户已存的自定义高度（sizeOf 的 ?? 语义）", () => {
    // 模拟 sizeOf 的实现契约：sectionSizes[key] 优先，缺省才用 defaultSectionHeight。
    // 用一份"用户拖过的"高度表，验证已存 key 不会被新默认值覆盖。
    const stored: Record<string, number> = {
      "folder:D:\\AI\\notes": 333, // 用户拖过的自定义高度
      temp: 1242,
    };
    const sizeOf = (key: string) => stored[key] ?? defaultSectionHeight(key);

    expect(sizeOf("folder:D:\\AI\\notes")).toBe(333); // 用户设置优先，不是 392
    expect(sizeOf("temp")).toBe(1242); // 用户设置优先，不是 200
    expect(sizeOf("folder:D:\\AI\\没拖过")).toBe(DEFAULT_FOLDER_SECTION_HEIGHT); // 缺省走新默认
    expect(sizeOf("favorites")).toBe(DEFAULT_SECTION_HEIGHT);
  });
});

// ══════════════════════════════════════════════════════════════
// 需求3：RecentFiles 渲染条件（文件空 / 文件夹非空必须渲染）
// ══════════════════════════════════════════════════════════════
describe("v0.14.0 需求3：RecentFiles 渲染条件（文件与文件夹两类都要算）", () => {
  it("recentFiles 空但 recentFolders 非空 → 应渲染（根因①回归）", () => {
    useFileStore.setState({
      recentFiles: [],
      recentFolders: [{ path: "/work/docs", name: "docs", accessedAt: Date.now() }],
    });

    const { container } = render(<RecentFiles onOpen={vi.fn()} />);

    // 面板容器必须存在（旧逻辑会 return null → 用户"点了没反应"）
    expect(container.querySelector(".recent-files")).not.toBeNull();
    // 文件夹条目也真的渲染出来了
    expect(screen.getByText("docs")).toBeTruthy();
    expect(container.querySelectorAll(".recent-file-item").length).toBe(1);
  });

  it("recentFiles 非空、recentFolders 空 → 仍渲染（原有行为不回退）", () => {
    useFileStore.setState({
      recentFiles: [{ path: "/docs/a.md", name: "a.md", accessedAt: Date.now() }],
      recentFolders: [],
    });

    const { container } = render(<RecentFiles onOpen={vi.fn()} />);

    expect(container.querySelector(".recent-files")).not.toBeNull();
    expect(screen.getByText("a.md")).toBeTruthy();
  });

  it("文件与文件夹都空 → 不渲染（新开软件什么都没打开时的正确行为）", () => {
    useFileStore.setState({ recentFiles: [], recentFolders: [] });

    const { container } = render(<RecentFiles onOpen={vi.fn()} />);

    expect(container.querySelector(".recent-files")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("两类都有 → 按 accessedAt 降序混排（v0.8.5 行为不回退）", () => {
    const now = Date.now();
    useFileStore.setState({
      recentFiles: [{ path: "/docs/f1.md", name: "f1.md", accessedAt: now - 5000 }],
      recentFolders: [{ path: "/work/a", name: "a", accessedAt: now }],
    });

    const { container } = render(<RecentFiles onOpen={vi.fn()} />);

    const names = Array.from(container.querySelectorAll(".recent-file-item .filetree-name")).map(
      (el) => el.textContent,
    );
    expect(names).toEqual(["a", "f1.md"]);
  });
});

// ══════════════════════════════════════════════════════════════
// 需求3：FileTree 的时钟按钮 → 面板真的出现 / 再点收起
// ══════════════════════════════════════════════════════════════
/**
 * FileTree 是重量级组件（依赖 Tauri dialog、文件服务、很多 store），
 * 在 jsdom 里整体挂载代价高且噪音大。这里把「点时钟 → 面板出现」的契约
 * 用同样结构的最小复现来锁定：同一份 showRecent 状态 + 同一个判定函数
 * （recentHasData 的等价形式）驱动渲染，验证三种数据态下的可见性矩阵。
 *
 * 真正的端到端（真实点按钮 + 量 DOM 高度）由
 * scripts/v0140-probe-recent.mjs 在打包产物上验证，不在这里重复。
 */
describe("v0.14.0 需求3：时钟切换 → 面板出现/收起（行为契约）", () => {
  /** 与 FileTree 内 recentHasData 同构的可见性判定（口径：文件或文件夹任一有记录） */
  const recentHasData = (
    recentFiles: unknown[],
    recentFolders: unknown[],
  ): boolean => recentFiles.length > 0 || recentFolders.length > 0;

  it("有数据：初始收起 → 点时钟 → 面板出现 → 再点 → 收起", () => {
    useFileStore.setState({
      recentFiles: [{ path: "/docs/a.md", name: "a.md", accessedAt: Date.now() }],
      recentFolders: [],
    });

    // 最小复现壳：showRecent 状态 + 与 FileTree 相同的 visible 判定
    function ToggleHarness() {
      const [showRecent, setShowRecent] = React.useState(false);
      const recentFiles = useFileStore((s) => s.recentFiles);
      const recentFolders = useFileStore((s) => s.recentFolders);
      const hasData = recentHasData(recentFiles, recentFolders);
      return (
        <div>
          <button
            data-testid="clock"
            className={showRecent ? "active" : ""}
            onClick={() => setShowRecent((v) => !v)}
          >
            clock
          </button>
          {showRecent && hasData ? <RecentFiles onOpen={vi.fn()} /> : null}
        </div>
      );
    }

    const { container } = render(<ToggleHarness />);
    const clock = screen.getByTestId("clock");

    // 初始：收起
    expect(container.querySelector(".recent-files")).toBeNull();
    expect(clock.className).not.toContain("active");

    // 点一次 → 面板出现
    fireEvent.click(clock);
    expect(container.querySelector(".recent-files")).not.toBeNull();
    expect(clock.className).toContain("active");

    // 再点一次 → 收起
    fireEvent.click(clock);
    expect(container.querySelector(".recent-files")).toBeNull();
    expect(clock.className).not.toContain("active");
  });

  it("只有文件夹历史时点时钟 → 面板也出现（根因①的端到端行为）", () => {
    useFileStore.setState({
      recentFiles: [],
      recentFolders: [{ path: "/work/docs", name: "docs", accessedAt: Date.now() }],
    });

    function ToggleHarness() {
      const [showRecent, setShowRecent] = React.useState(false);
      const recentFiles = useFileStore((s) => s.recentFiles);
      const recentFolders = useFileStore((s) => s.recentFolders);
      const hasData = recentHasData(recentFiles, recentFolders);
      return (
        <div>
          <button data-testid="clock" onClick={() => setShowRecent((v) => !v)}>clock</button>
          {showRecent && hasData ? <RecentFiles onOpen={vi.fn()} /> : null}
        </div>
      );
    }

    const { container } = render(<ToggleHarness />);
    fireEvent.click(screen.getByTestId("clock"));

    expect(container.querySelector(".recent-files")).not.toBeNull();
    expect(screen.getByText("docs")).toBeTruthy();
  });

  it("完全没数据时点时钟 → 面板不出现（这是正确行为，不塞假数据）", () => {
    useFileStore.setState({ recentFiles: [], recentFolders: [] });

    function ToggleHarness() {
      const [showRecent, setShowRecent] = React.useState(false);
      const recentFiles = useFileStore((s) => s.recentFiles);
      const recentFolders = useFileStore((s) => s.recentFolders);
      const hasData = recentHasData(recentFiles, recentFolders);
      return (
        <div>
          <button data-testid="clock" onClick={() => setShowRecent((v) => !v)}>clock</button>
          {showRecent && hasData ? <RecentFiles onOpen={vi.fn()} /> : null}
        </div>
      );
    }

    const { container } = render(<ToggleHarness />);
    fireEvent.click(screen.getByTestId("clock"));

    expect(container.querySelector(".recent-files")).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════
// 需求4：CSS 契约（行高 / 标题栏高度与常量对齐）
// ══════════════════════════════════════════════════════════════
describe("v0.14.0 需求4：CSS 与常量对齐（防止只改常量不改样式）", () => {
  it(".filetree-node 行高 30px 与 SIDEBAR_ITEM_HEIGHT 一致", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const css = readFileSync(
      resolve(process.cwd(), "src/components/sidebar/FileTree.css"),
      "utf-8",
    );
    // 取 .filetree-node { ... } 块内的 height
    const block = css.match(/\.filetree-node\s*\{[^}]*\}/);
    expect(block).toBeTruthy();
    const heightMatch = block![0].match(/height:\s*(\d+)px/);
    expect(heightMatch).toBeTruthy();
    expect(Number(heightMatch![1])).toBe(SIDEBAR_ITEM_HEIGHT);
  });

  it(".filetree-root-path 的 padding/font-size 组合对应实测 32px 标题栏", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const css = readFileSync(
      resolve(process.cwd(), "src/components/sidebar/FileTree.css"),
      "utf-8",
    );
    const block = css.match(/\.filetree-root-path\s*\{[^}]*\}/);
    expect(block).toBeTruthy();
    const padding = block![0].match(/padding:\s*6px\s+28px\s+6px\s+14px/);
    const fontSize = block![0].match(/font-size:\s*11px/);
    const border = block![0].match(/border-top:\s*1px/);
    expect(padding).toBeTruthy();
    expect(fontSize).toBeTruthy();
    expect(border).toBeTruthy();
  });
});

// React 在测试文件内用到的 import（放在末尾避免影响上面的 describe 顺序）
import React from "react";

// ─── v0.14.0 需求4：老用户持久化高度迁移 ─────────────────────────
//
// 背景（sidebar-fix 报告的风险3，Lead 补的口子）：
// `sizeOf()` 是 `sectionSizes[key] ?? defaultSectionHeight(key)`，而用户**拖拽过
// 任何一栏**时整张 `sidebarSectionSizes` 都会被持久化（含 `folder:` 的旧默认 250）。
// 因此只改默认值对老用户无效 —— 他们升级后仍看到 7 条，而需求4 正是冲着这 7 条来的。
// 所以加了 persist version 4→5 的迁移：清掉"看起来还是旧默认值"的 folder 键。
describe("需求4：settings 迁移清掉旧默认文件夹栏高度（否则老用户仍是 7 条）", () => {
  it("folder 高度 = 旧默认 250 → 删除该键（回落到新默认 392）", () => {
    const out = migrateSettings(
      { sidebarSectionSizes: { "folder:C:/ws": 250, temp: 900 } },
      4,
    );
    expect(out.sidebarSectionSizes).toEqual({ temp: 900 });
  });

  it("folder 高度比旧默认更矮（被拖小过）→ 也删除，回到新默认", () => {
    const out = migrateSettings({ sidebarSectionSizes: { "folder:C:/ws": 180 } }, 4);
    expect(out.sidebarSectionSizes).toEqual({});
  });

  it("用户明确拖大过（> 250）→ **保留不动**（尊重用户意图）", () => {
    const out = migrateSettings(
      { sidebarSectionSizes: { "folder:C:/ws": 500, "folder:D:/other": 333 } },
      4,
    );
    expect(out.sidebarSectionSizes).toEqual({
      "folder:C:/ws": 500,
      "folder:D:/other": 333,
    });
  });

  it("非 folder 栏的旧默认 200 不受影响（那是别的栏的约定值）", () => {
    const out = migrateSettings({ sidebarSectionSizes: { temp: 200, recent: 200 } }, 4);
    expect(out.sidebarSectionSizes).toEqual({ temp: 200, recent: 200 });
  });

  it("已是 version 5 → 不再重复迁移（用户之后可自由拖小）", () => {
    const out = migrateSettings({ sidebarSectionSizes: { "folder:C:/ws": 250 } }, 5);
    expect(out.sidebarSectionSizes).toEqual({ "folder:C:/ws": 250 });
  });

  it("没有该字段 / 字段是脏数据时不崩", () => {
    expect(() => migrateSettings({}, 4)).not.toThrow();
    expect(() => migrateSettings({ sidebarSectionSizes: null }, 4)).not.toThrow();
    expect(migrateSettings({ sidebarSectionSizes: null }, 4).sidebarSectionSizes).toBeNull();
  });
});
