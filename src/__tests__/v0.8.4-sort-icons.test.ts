/**
 * v0.8.4 反馈5：排序按钮/菜单项图标对齐优化 —— 防回退断言。
 *
 * 覆盖：
 * 1. 名称组徽标小写（CSS text-transform: lowercase，不改 sortModeBadge 返回的 API 语义）
 * 2. 箭头"缩短/拉长"：SORT_ARROW_SIZE.time < SORT_ARROW_SIZE.name，
 *    且名称组箭头走 elongate（长箭头，viewBox 16×28），时间组仍为 16×16 短箭头
 * 3. 分组类名规则存在于 CSS，且标题栏按钮激活态与下拉菜单项**共用同一套类名**
 * 4. 两组字高规则存在于 CSS（时间组单大写字母；名称组小写竖排三行收紧行高）
 *
 * 约定：vitest 未开 globals → 显式 import；组件渲染用例 afterEach(cleanup())；
 *      jsdom 缺 ResizeObserver → mock 空实现。文件不含 JSX（用 createElement），故为 .ts。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, fireEvent, cleanup, act } from "@testing-library/react";

vi.mock("../services/fileService", () => ({
  fileService: {
    readFile: vi.fn(async () => ""),
    listDir: vi.fn(async () => []),
    exists: vi.fn(async () => false),
    writeFile: vi.fn(async () => {}),
    getFileSize: vi.fn(async () => 0),
    createFile: vi.fn(async () => {}),
    createDir: vi.fn(async () => {}),
    deleteFile: vi.fn(async () => {}),
    renameFile: vi.fn(async () => {}),
    copyFile: vi.fn(async () => {}),
    moveFile: vi.fn(async () => {}),
    revealInFolder: vi.fn(async () => {}),
    watchFolder: vi.fn(async () => {}),
    unwatchFolder: vi.fn(async () => {}),
    onFolderChanged: vi.fn(async () => () => {}),
  },
  isTauri: () => true,
}));

import { FileTree, SORT_ARROW_SIZE } from "../components/sidebar/FileTree";
import { useFileStore } from "../stores/useFileStore";
import { useEditorStore } from "../stores/useEditorStore";
import { useSettingsStore } from "../stores/useSettingsStore";

const css = readFileSync(join(__dirname, "..", "components", "sidebar", "FileTree.css"), "utf-8");

/** 截取以 marker 起始的 CSS 规则块源文本（从 marker 到配对大括号结束） */
function extractRule(marker: string): string {
  const start = css.indexOf(marker);
  expect(start, `FileTree.css 中应存在 ${marker}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  return css.slice(start);
}

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => cleanup());

const ROOT = "C:/proj";

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState({ fileTreeSort: {} });
  useEditorStore.setState({ openTabs: [], activeTabIdx: 0 });
  useFileStore.setState({
    favorites: [],
    recentFiles: [],
    recentFolders: [],
    tempFiles: [],
    fileTree: [],
    rootPath: null,
    openFolders: [
      {
        path: ROOT,
        name: "proj",
        fileTree: [
          { name: "a.md", path: `${ROOT}/a.md`, isDir: false, size: 1, modifiedMs: 100 },
          { name: "sub", path: `${ROOT}/sub`, isDir: true, size: 0 },
        ],
      },
    ],
  });
});

// ─── 1. 分组尺寸常量：时间组箭头缩短、名称组箭头拉长 ──────────
describe("v0.8.4 反馈5：两组箭头尺寸", () => {
  it("名称组箭头比时间组更长（缩短 U/C 组箭头、拉长 a-z 组箭头）", () => {
    expect(SORT_ARROW_SIZE.time).toBeLessThan(SORT_ARROW_SIZE.name);
  });

  it("两组尺寸都收敛在小尺寸区间（不撑破 22px 按钮与菜单行高）", () => {
    expect(SORT_ARROW_SIZE.time).toBeGreaterThanOrEqual(8);
    expect(SORT_ARROW_SIZE.time).toBeLessThanOrEqual(10);
    expect(SORT_ARROW_SIZE.name).toBeGreaterThanOrEqual(10);
    // 长箭头 viewBox 16×28 → 渲染高 = size × 1.75，须 ≤ 22px 按钮高
    expect(SORT_ARROW_SIZE.name * 1.75).toBeLessThanOrEqual(22);
  });

  it("名称组箭头走 elongate 长箭头（viewBox 16×28），时间组仍为 16×16 短箭头", () => {
    const src = readFileSync(join(__dirname, "..", "components", "sidebar", "FileTree.tsx"), "utf-8");
    // 长箭头分支：16×28 viewBox + sort-arrow-long 类名
    expect(src).toContain('viewBox="0 0 16 28"');
    expect(src).toContain("sort-arrow-long");
    // 短箭头分支保留
    expect(src).toContain('viewBox="0 0 16 16"');
  });
});

// ─── 2. CSS 分组规则 ────────────────────────────────────
describe("v0.8.4 反馈5：两组 CSS 对齐规则", () => {
  it("名称组徽标小写（text-transform: lowercase）", () => {
    expect(extractRule(".sort-icon-name .sort-badge")).toContain("text-transform: lowercase");
  });

  it("徽标基类不再固定字号（字号改由分组规则给出，避免两组共用同一字高）", () => {
    expect(extractRule("\n.sort-badge {")).not.toContain("font-size");
  });

  it("时间组：单大写字母（不改写大小写）+ 字号 9px 行高 1（与短箭头等高）", () => {
    const rule = extractRule(".sort-icon-time .sort-badge");
    expect(rule).toContain("font-size: 9px");
    expect(rule).toContain("line-height: 1");
    // 时间组不得改大小写（U/C 保持大写）
    expect(rule).not.toContain("text-transform");
  });

  it("名称组：小写竖排多行，行高收紧", () => {
    const rule = extractRule(".sort-icon-name .sort-badge");
    expect(rule).toContain("font-size: 7px");
    expect(rule).toContain("line-height: 0.9");
  });

  it("图标容器 .sort-icon 用 flex 垂直居中（保证箭头与字母落在同一条水平线）", () => {
    const rule = extractRule("\n.sort-icon {");
    expect(rule).toContain("display: inline-flex");
    expect(rule).toContain("align-items: center");
  });
});

// ─── 3. 渲染态：按钮激活态与菜单项共用同一套类名规则 ──────────
describe("v0.8.4 反馈5：按钮激活态与菜单项图标类名一致", () => {
  /** 渲染并返回标题栏排序按钮 */
  function renderSortBtn(): HTMLElement {
    render(createElement(FileTree));
    const btn = document.querySelector(".section-btn.section-sort") as HTMLElement | null;
    expect(btn).toBeTruthy();
    return btn!;
  }

  it("时间组：按钮激活态与菜单项图标都带 .sort-icon-time，箭头为短箭头", () => {
    act(() => {
      useSettingsStore.setState({ fileTreeSort: { [ROOT]: "modified-desc" } });
    });
    const btn = renderSortBtn();
    const btnIcon = btn.querySelector(".sort-icon") as HTMLElement;
    expect(btnIcon.classList.contains("sort-icon-time")).toBe(true);
    expect(btnIcon.querySelector(".sort-arrow-long")).toBeNull();
    // 短箭头：宽高相等，均为 SORT_ARROW_SIZE.time
    const svg = btnIcon.querySelector(".sort-arrow") as SVGElement;
    expect(svg.getAttribute("width")).toBe(String(SORT_ARROW_SIZE.time));
    expect(svg.getAttribute("height")).toBe(String(SORT_ARROW_SIZE.time));

    // 菜单项：同一套类名规则（.sort-icon + .sort-menu-icon + .sort-icon-time）
    fireEvent.click(btn);
    const timeItem = Array.from(document.querySelectorAll(".sort-menu-item")).find((b) =>
      (b.querySelector(".sort-menu-label")?.textContent ?? "").includes("修改时间（晚-早）"),
    ) as HTMLElement;
    const menuIcon = timeItem.querySelector(".sort-icon") as HTMLElement;
    expect(menuIcon.classList.contains("sort-menu-icon")).toBe(true);
    expect(menuIcon.classList.contains("sort-icon-time")).toBe(true);
    expect(menuIcon.querySelector(".sort-arrow-long")).toBeNull();
    const menuSvg = menuIcon.querySelector(".sort-arrow") as SVGElement;
    expect(menuSvg.getAttribute("width")).toBe(String(SORT_ARROW_SIZE.time));
  });

  it("名称组：按钮激活态与菜单项图标都带 .sort-icon-name，箭头为长箭头（拉长）", () => {
    act(() => {
      useSettingsStore.setState({ fileTreeSort: { [ROOT]: "name-desc" } });
    });
    const btn = renderSortBtn();
    const btnIcon = btn.querySelector(".sort-icon") as HTMLElement;
    expect(btnIcon.classList.contains("sort-icon-name")).toBe(true);
    const btnSvg = btnIcon.querySelector(".sort-arrow-long") as SVGElement;
    expect(btnSvg).toBeTruthy();
    expect(btnSvg.getAttribute("width")).toBe(String(SORT_ARROW_SIZE.name));
    // 长箭头渲染高 = size × 28/16 = size × 1.75，明显大于短箭头边长 → 体现"拉长"
    expect(Number(btnSvg.getAttribute("height"))).toBeGreaterThan(SORT_ARROW_SIZE.time);

    // 菜单项（六项里名称组两项都带 .sort-icon-name + 长箭头）
    fireEvent.click(btn);
    const nameItems = Array.from(document.querySelectorAll(".sort-menu-item")).filter((b) =>
      (b.querySelector(".sort-menu-label")?.textContent ?? "").startsWith("文件名（"),
    ) as HTMLElement[];
    expect(nameItems.length).toBe(2);
    nameItems.forEach((item) => {
      const icon = item.querySelector(".sort-icon") as HTMLElement;
      expect(icon.classList.contains("sort-menu-icon")).toBe(true);
      expect(icon.classList.contains("sort-icon-name")).toBe(true);
      expect(icon.querySelector(".sort-arrow-long")).toBeTruthy();
    });
  });

  it("菜单六项：名称组 2 项、时间组 4 项，全部使用同一套分组类名", () => {
    const btn = renderSortBtn();
    fireEvent.click(btn);
    const items = Array.from(document.querySelectorAll(".sort-menu-item"));
    expect(items.length).toBe(6);
    const groups = items.map((item) => {
      const icon = item.querySelector(".sort-icon") as HTMLElement;
      expect(icon).toBeTruthy();
      expect(icon.classList.contains("sort-menu-icon")).toBe(true);
      if (icon.classList.contains("sort-icon-name")) return "name";
      if (icon.classList.contains("sort-icon-time")) return "time";
      return "none";
    });
    expect(groups).toEqual(["name", "name", "time", "time", "time", "time"]);
  });

  it("默认态（SortBothIcon）语义不变：仍是双箭头、无徽标、无分组容器", () => {
    const btn = renderSortBtn();
    expect(btn.querySelector(".sort-arrow-both")).toBeTruthy();
    expect(btn.querySelector(".sort-badge")).toBeNull();
    expect(btn.querySelector(".sort-icon")).toBeNull();
  });
});