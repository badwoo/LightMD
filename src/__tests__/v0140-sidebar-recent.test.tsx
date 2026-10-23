/**
 * v0.14.0 需求2 + 需求3 测试
 *
 * 需求3：左侧「最近打开」点时钟图标后面板不出来 / 展开动画卡顿 + 左侧栏抖动
 *   根因①（上一轮已修）：渲染条件 `showRecent && recentFiles.length > 0` 只看 recentFiles，
 *     而 RecentFiles 自 v0.8.5 起是「文件+文件夹」混排 → 只开过文件夹时面板一次都不挂载。
 *   根因②（本轮）：点开收藏/最近时，temp 栏收缩（CSS `transition: height 0.3s`）与面板展开
 *     （SlideInWrap 内联 height 0→px）**时长不同步、起始帧差 ~25ms** → 两栏高度之和在
 *     动画中段先少 33px 再补回 → 面板底边先上浮再掉回来，且竖直滚动条反复出现
 *     （内容宽度 254→252）→ 用户看到的"卡顿 + 左侧栏抖动"。
 *   根因③（本轮）：reveal 用 [0,40,160,320,560]ms 五个固定延时反复校正 scrollTop，
 *     等于在 0.3s 高度过渡期间连续抢滚动（实测 0→14→21→155→217px 四跳）。
 *
 *   本轮修法：SlideInWrap 改到"父布局收敛后的那一帧"用 rAF 起动画、高度时长对齐 CSS 0.3s；
 *   两个高度自适应 effect 改 useLayoutEffect 同提交完成；scrollbar-gutter: stable 固定滚动条槽位；
 *   reveal 改为"布局稳定后至多一次校正"，并覆盖收藏栏（用户同时抱怨星标与时钟）。
 *   实机时序证据：_verify-out/v0140-probe-sidebar-anim.txt（scripts/v0140-probe-sidebar-anim.mjs）。
 *
 * 需求2：文件夹栏 = 总 11 个条目位 = 10 个文件栏位 + 1 个常驻空白栏位
 *   标题栏实测 32px、行高 30px → section 362px（内容区 330 = 列表 300 + 空白 30）。
 *   上一轮做成「11 条可见 + 末尾再留 1 行」= 392px（12 行）与用户本轮口径不符，已修正。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import {
  SIDEBAR_ITEM_HEIGHT,
  FOLDER_ITEM_SLOTS,
  FOLDER_FILE_ROWS,
  FOLDER_BLANK_SLOT_HEIGHT,
  FOLDER_HEADER_HEIGHT,
  DEFAULT_FOLDER_SECTION_HEIGHT,
  DEFAULT_SECTION_HEIGHT,
  SECTION_HEIGHT_ANIM_MS,
  REVEAL_STABLE_FRAMES,
  REVEAL_SETTLE_MAX_MS,
  revealSectionAfterLayoutSettled,
  defaultSectionHeight,
} from "../components/sidebar/FileTree";
import { RecentFiles } from "../components/sidebar/RecentFiles";
import { useFileStore } from "../stores/useFileStore";
import { MIN_SECTION_HEIGHT } from "../hooks/useSectionSplit";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
// 需求2：文件夹栏 = 11 个条目位 = 10 文件栏位 + 1 空白栏位
// ══════════════════════════════════════════════════════════════
import { migrateSettings } from "../stores/useSettingsStore";

describe("v0.14.0 需求2：文件夹栏 11 个条目位（10 文件栏位 + 1 空白栏位）", () => {
  it("SIDEBAR_ITEM_HEIGHT 与 .filetree-node 行高一致，为 30px", () => {
    expect(SIDEBAR_ITEM_HEIGHT).toBe(30);
  });

  it("总条目位 11 = 10 文件栏位 + 1 空白栏位（用户本轮口径）", () => {
    expect(FOLDER_ITEM_SLOTS).toBe(11);
    expect(FOLDER_FILE_ROWS).toBe(10);
    expect(FOLDER_BLANK_SLOT_HEIGHT).toBe(SIDEBAR_ITEM_HEIGHT);
    expect(FOLDER_FILE_ROWS + 1).toBe(FOLDER_ITEM_SLOTS);
  });

  it("标题栏实测高度为 32px（padding 6+6 + line-height 17.6 + 上下各 1px border）", () => {
    // 该值是打包产物 + WebView2 实测值，不是拍脑袋的 26~30
    expect(FOLDER_HEADER_HEIGHT).toBe(32);
  });

  it("DEFAULT_FOLDER_SECTION_HEIGHT = 32 + 11×30 = 362px（不是上一版的 392px）", () => {
    expect(DEFAULT_FOLDER_SECTION_HEIGHT).toBe(
      FOLDER_HEADER_HEIGHT + FOLDER_ITEM_SLOTS * SIDEBAR_ITEM_HEIGHT,
    );
    // 夹带的含义验证：本轮口径算出来应该是 362
    expect(DEFAULT_FOLDER_SECTION_HEIGHT).toBe(362);
    // 上一轮按「11 可见 + 1 留白」做的 392px 是 12 行，用户明确纠正过
    expect(DEFAULT_FOLDER_SECTION_HEIGHT).not.toBe(392);
  });

  it("内容区 330px = 10 行文件栏位(300) + 1 行空白栏位(30)：第 11 个文件行不完整可见", () => {
    const contentHeight = DEFAULT_FOLDER_SECTION_HEIGHT - FOLDER_HEADER_HEIGHT;
    expect(contentHeight).toBe(330);
    const fileArea = contentHeight - FOLDER_BLANK_SLOT_HEIGHT;
    // 列表滚动区恰好 10 行：能完整看到 10 个文件，第 11 个文件行落在滚动区之外
    expect(fileArea).toBe(FOLDER_FILE_ROWS * SIDEBAR_ITEM_HEIGHT);
    expect(fileArea / SIDEBAR_ITEM_HEIGHT).toBe(10);
    // 末尾空白正好一个条目位（给空白处右键用）
    expect(contentHeight - fileArea).toBe(SIDEBAR_ITEM_HEIGHT);
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

    expect(sizeOf("folder:D:\\AI\\notes")).toBe(333); // 用户设置优先，不是 362
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

// ══════════════════════════════════════════════════════════════
// 需求2：源码/CSS 接线（空白栏位真的渲染、滚动区恰好 10 行）
// ══════════════════════════════════════════════════════════════
describe("v0.14.0 需求2：源码/CSS 接线（空白栏位 + 10 行滚动区）", () => {
  const fileTreeSrc = readFileSync(
    resolve(process.cwd(), "src/components/sidebar/FileTree.tsx"),
    "utf-8",
  );
  const cssSrc = readFileSync(
    resolve(process.cwd(), "src/components/sidebar/FileTree.css"),
    "utf-8",
  );

  it("列表下方渲染**常驻**空白栏位 .filetree-folder-blank-slot（高度 = 一个条目位）", () => {
    expect(fileTreeSrc).toContain('className="filetree-folder-blank-slot"');
    // 高度与行高常量同源，不在 CSS 里再硬编码一个 30
    expect(fileTreeSrc).toContain("style={{ height: FOLDER_BLANK_SLOT_HEIGHT }}");
    expect(cssSrc).toMatch(/\.filetree-folder-blank-slot\s*\{[^}]*flex-shrink:\s*0/);
    // 不在折叠态渲染（折叠 = 只留标题栏）
    const blankIdx = fileTreeSrc.indexOf('className="filetree-folder-blank-slot"');
    expect(blankIdx).toBeGreaterThan(fileTreeSrc.indexOf('className="filetree-folder-content"'));
  });

  it("空白栏位接的是同一套文件夹右键菜单（用户要在这片空白处右键）", () => {
    const blankBlock = fileTreeSrc.slice(
      fileTreeSrc.indexOf('className="filetree-folder-blank-slot"'),
      fileTreeSrc.indexOf('className="filetree-folder-blank-slot"') + 700,
    );
    expect(blankBlock).toContain("onFolderContextMenu?.(folder.path");
    expect(blankBlock).toContain("e.preventDefault()");
  });

  it("文件夹栏**不参与**「还原到内容高度」——否则文件少时窗口又会缩成 N 条", () => {
    // v0.8.2 功能5 的通用还原规则会把"曾被撑满的上一栏"缩到内容自然高度。
    // 文件夹栏必须例外：它的契约是固定 11 个条目位。
    // 实机证据：5 个文件的文件夹「打开→点开一个文件」后被缩到 213px
    // （scripts/v0140-probe-folder-rows.mjs 会话 B）。
    expect(fileTreeSrc).toContain('if (filled.key.startsWith("folder:")) {');
    expect(fileTreeSrc).toContain("next[filled.key] = filled.prevHeight;");
  });
});

// ══════════════════════════════════════════════════════════════
// 需求3：展开动画同步契约（防「总量回弹 + 滚动条闪 + reveal 连滚」回归）
// ══════════════════════════════════════════════════════════════
describe("v0.14.0 需求3：展开动画同步契约", () => {
  const fileTreeSrc = readFileSync(
    resolve(process.cwd(), "src/components/sidebar/FileTree.tsx"),
    "utf-8",
  );
  const cssSrc = readFileSync(
    resolve(process.cwd(), "src/components/sidebar/FileTree.css"),
    "utf-8",
  );

  it("面板高度动画与 CSS section 高度过渡同长（0.3s）——不同步会让两栏高度和凹 33px", () => {
    expect(SECTION_HEIGHT_ANIM_MS).toBe(300);
    // CSS 侧仍是四栏统一 0.3s（v0.8.2 起的高度过渡契约）
    expect(cssSrc).toMatch(
      /\.filetree-folder-section,\s*\n\.filetree-temp-section,\s*\n\.favorites-section,\s*\n\.recent-files \{\s*\n\s*transition: height 0\.3s ease;/,
    );
    // SlideInWrap 的高度过渡必须用同一时长常量，不能再是 330ms（水平滑入时长）
    expect(fileTreeSrc).toContain("height ${SECTION_HEIGHT_ANIM_MS}ms ease");
    expect(fileTreeSrc).not.toContain("height ${SECTION_SLIDE_IN_MS}ms ease");
  });

  it("SlideInWrap 在 rAF 里量目标高度并起动画（父布局收敛后同帧同起同止）", () => {
    const start = fileTreeSrc.indexOf("export function SlideInWrap");
    expect(start).toBeGreaterThan(-1);
    const block = fileTreeSrc.slice(start, start + 3000);
    expect(block).toContain("requestAnimationFrame");
    // 先压 0（禁用过渡）→ 下一帧量最终高度再起过渡
    expect(block).toContain('el.style.height = "0px"');
    expect(block).toContain("const target = el.scrollHeight");
  });

  it("收藏/最近面板**不叠** wrapper 高度动画（高度交给 section 0.3s transition）", () => {
    // 实机第二轮时序采样（_verify-out/v0140-probe-sidebar-anim.txt）：wrapper 的
    // 0→高 动画目标会与父组件布局提交赛跑（夹在 204px，371ms 后突然弹到 720px）。
    // 因此面板高度只由 section 自身的 transition 驱动，wrapper 只做水平滑入。
    expect(fileTreeSrc).toContain("<SlideInWrap animateHeight={false}>{children}</SlideInWrap>");
    // 文件夹栏仍保留 v0.8.2 的"下方栏被平滑推下去"（wrapper 高度展开）
    expect(fileTreeSrc).toContain("<SlideInWrap>{section}</SlideInWrap>");
  });

  it("两个高度自适应 effect 用 useLayoutEffect（同一提交内完成，不跨帧）", () => {
    // 收缩 effect：favRecentCompact 分支
    expect(fileTreeSrc).toContain("useLayoutEffect(() => {\n    if (!favRecentCompact) {");
    // auto-fill effect：orderedKey 分支
    expect(fileTreeSrc).toContain("}, [orderedKey]);");
    // 两个 effect 都不再包 requestAnimationFrame（跨帧会与 SlideInWrap 错拍）
    expect(fileTreeSrc).not.toContain("return () => cancelAnimationFrame(raf);");
  });

  it("reveal 不再用 5 个固定延时，改为布局稳定后至多一次校正", () => {
    // 上一版是 `export const REVEAL_CHECK_DELAYS = [0,40,160,320,560]` + for 循环多拍校正；
    // 本轮只保留"历史说明"注释，代码里不能再有该常量与多拍循环。
    expect(fileTreeSrc).not.toContain("export const REVEAL_CHECK_DELAYS");
    expect(fileTreeSrc).not.toMatch(/for \(const delay of REVEAL_CHECK_DELAYS\)/);
    expect(fileTreeSrc).toContain("export function revealSectionAfterLayoutSettled");
    expect(REVEAL_STABLE_FRAMES).toBe(2);
    expect(REVEAL_SETTLE_MAX_MS).toBeGreaterThanOrEqual(600);
    // 整个文件里只有 helper 里那一次 scrollTo（不再是 for 循环里的多拍校正）
    expect(fileTreeSrc.match(/sc\.scrollTo\(/g)?.length).toBe(1);
  });

  it("收藏栏也接 reveal（用户同时抱怨星标与时钟，不能只修最近打开）", () => {
    expect(fileTreeSrc).toContain('revealSectionAfterLayoutSettled(scrollRef.current, "favorites")');
    expect(fileTreeSrc).toContain('revealSectionAfterLayoutSettled(scrollRef.current, "recent")');
  });

  it("滚动条槽位固定（scrollbar-gutter: stable）——滚动条闪现不再挤动内容宽度", () => {
    expect(cssSrc).toMatch(/\.filetree-scroll\s*\{[^}]*scrollbar-gutter:\s*stable/);
  });
});

// ══════════════════════════════════════════════════════════════
// 需求3：revealSectionAfterLayoutSettled 行为（稳定后最多一次、已可见不滚）
// ══════════════════════════════════════════════════════════════
describe("v0.14.0 需求3：reveal 单次校正行为", () => {
  /** 造一对「滚动容器 + 面板」并注入指定几何（jsdom 不会真布局） */
  const setup = (
    panelRect: { top: number; bottom: number },
    opts: { scrollTop?: number; scrollHeight?: number; clientHeight?: number } = {},
  ) => {
    const sc = document.createElement("div");
    sc.className = "filetree-scroll";
    const panel = document.createElement("div");
    panel.dataset.sectionKey = "recent";
    sc.appendChild(panel);
    document.body.appendChild(sc);

    const scRect = { top: 100, bottom: 1100, left: 0, right: 250, width: 250, height: 1000 };
    sc.getBoundingClientRect = () => scRect as DOMRect;
    panel.getBoundingClientRect = () => panelRect as DOMRect;
    Object.defineProperty(sc, "clientHeight", { value: opts.clientHeight ?? 1000, configurable: true });
    Object.defineProperty(sc, "scrollHeight", { value: opts.scrollHeight ?? 1500, configurable: true });
    Object.defineProperty(sc, "scrollTop", { value: opts.scrollTop ?? 0, writable: true, configurable: true });
    const scrollTo = vi.fn();
    (sc as unknown as { scrollTo: typeof scrollTo }).scrollTo = scrollTo;
    return { sc, panel, scrollTo };
  };

  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("面板在视口下方 → 布局稳定后**只滚一次**（旧的 5 拍会被这里抓成 5 次）", () => {
    vi.useFakeTimers();
    const { sc, scrollTo } = setup({ top: 1200, bottom: 1400 });
    revealSectionAfterLayoutSettled(sc, "recent");
    act(() => vi.advanceTimersByTime(REVEAL_SETTLE_MAX_MS + 100));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    // 顶边对齐滚动区顶部（受 maxTop=500 钳制）
    expect(scrollTo.mock.calls[0][0]).toEqual({ top: 500, behavior: "auto" });
  });

  it("面板已完整可见 → 一次都不滚（不打扰用户自己的滚动位置）", () => {
    vi.useFakeTimers();
    const { sc, scrollTo } = setup({ top: 200, bottom: 900 });
    revealSectionAfterLayoutSettled(sc, "recent");
    act(() => vi.advanceTimersByTime(REVEAL_SETTLE_MAX_MS + 100));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("用户在稳定前自己滚动/点击了侧栏 → 直接放弃，不再抢滚动", () => {
    vi.useFakeTimers();
    const { sc, scrollTo } = setup({ top: 1200, bottom: 1400 });
    revealSectionAfterLayoutSettled(sc, "recent");
    act(() => {
      sc.dispatchEvent(new Event("wheel"));
    });
    act(() => vi.advanceTimersByTime(REVEAL_SETTLE_MAX_MS + 100));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("面板不存在（如空数据不渲染）→ 不滚也不抛错", () => {
    vi.useFakeTimers();
    const sc = document.createElement("div");
    sc.className = "filetree-scroll";
    document.body.appendChild(sc);
    sc.getBoundingClientRect = () => ({ top: 100, bottom: 1100 }) as DOMRect;
    Object.defineProperty(sc, "scrollHeight", { value: 1500, configurable: true });
    Object.defineProperty(sc, "clientHeight", { value: 1000, configurable: true });
    const scrollTo = vi.fn();
    (sc as unknown as { scrollTo: typeof scrollTo }).scrollTo = scrollTo;
    revealSectionAfterLayoutSettled(sc, "recent");
    act(() => vi.advanceTimersByTime(REVEAL_SETTLE_MAX_MS + 100));
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

// ─── v0.14.0 需求2：老用户持久化高度迁移 ─────────────────────────
//
// 背景：`sizeOf()` 是 `sectionSizes[key] ?? defaultSectionHeight(key)`，而用户
// **拖拽过任何一栏**时整张 `sidebarSectionSizes` 都会被持久化（含 `folder:` 当时的
// 默认高度）。因此只改默认值对老用户无效 —— 他们升级后仍看到 7 条（250）或 12 条（392）。
// persist version 5 → 6 的迁移：只清**历史默认值本身**（250 / 392），其余一律保留。
describe("需求2：settings 迁移清掉历史默认文件夹栏高度（否则老用户仍不是 11 条目位）", () => {
  it("folder 高度 = 旧默认 250 → 删除该键（回落到新默认 362）", () => {
    const out = migrateSettings(
      { sidebarSectionSizes: { "folder:C:/ws": 250, temp: 900 } },
      4,
    );
    expect(out.sidebarSectionSizes).toEqual({ temp: 900 });
  });

  it("folder 高度 = 上一版默认 392 → 删除该键（version 5 升级上来也要清）", () => {
    const out = migrateSettings(
      { sidebarSectionSizes: { "folder:C:/ws": 392, temp: 500 } },
      5,
    );
    expect(out.sidebarSectionSizes).toEqual({ temp: 500 });
  });

  it("folder 高度比旧默认更矮（被拖小过，version<5 旧口径）→ 也删除，回到新默认", () => {
    const out = migrateSettings({ sidebarSectionSizes: { "folder:C:/ws": 180 } }, 4);
    expect(out.sidebarSectionSizes).toEqual({});
  });

  it("用户自定义高度（250~392 之间的 300 / 大于旧默认的 620）→ **保留不动**", () => {
    const out = migrateSettings(
      {
        sidebarSectionSizes: {
          "folder:C:/ws-300": 300, // 用户自己拖到的中间值，不能按区间一刀切
          "folder:C:/ws-620": 620, // 明确拖大
          "folder:C:/ws-333": 333,
        },
      },
      5,
    );
    expect(out.sidebarSectionSizes).toEqual({
      "folder:C:/ws-300": 300,
      "folder:C:/ws-620": 620,
      "folder:C:/ws-333": 333,
    });
  });

  it("非 folder 栏的旧默认 200 不受影响（那是别的栏的约定值）", () => {
    const out = migrateSettings({ sidebarSectionSizes: { temp: 200, recent: 200 } }, 4);
    expect(out.sidebarSectionSizes).toEqual({ temp: 200, recent: 200 });
  });

  it("已是 version 6 → 不再迁移（用户之后把文件夹栏拖到 392 也不该被清）", () => {
    const out = migrateSettings({ sidebarSectionSizes: { "folder:C:/ws": 392 } }, 6);
    expect(out.sidebarSectionSizes).toEqual({ "folder:C:/ws": 392 });
  });

  it("没有该字段 / 字段是脏数据时不崩", () => {
    expect(() => migrateSettings({}, 4)).not.toThrow();
    expect(() => migrateSettings({ sidebarSectionSizes: null }, 4)).not.toThrow();
    expect(migrateSettings({ sidebarSectionSizes: null }, 4).sidebarSectionSizes).toBeNull();
  });
});
