/**
 * v0.8.0 第三轮修复（P12-1 ~ P12-6）测试
 *
 * P12-1 文件夹空白区右键"粘贴"（剪贴板为空时置灰）
 * P12-2 标签栏滚轮平滑滚动（增量归一化 + rAF 缓动）
 * P12-3 活跃标签自动滚入可视区
 * P12-4 侧栏末栏可拖到底部 + 关闭末栏后上一栏自动填充
 * P12-5 侧栏"收藏 + 最近打开"同时打开时最近打开可拖、只有一个文件夹+打开的文件时后者可拖
 * P12-6 侧栏滚动条更细更无感
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  normalizeWheelDelta,
  clampScrollLeft,
  computeSmoothedScroll,
  computeScrollToReveal,
} from "../services/tabScroll";
import {
  computeExtendableMaxHeight,
  computeSplitExtendable,
  computeMaxSelfHeight,
  MIN_SECTION_HEIGHT,
} from "../hooks/useSectionSplit";

const read = (rel: string) => readFileSync(resolve(__dirname, rel), "utf-8");

// ─── P12-2 滚轮平滑滚动 ──────────────────────────────────
describe("P12-2 滚轮增量归一化", () => {
  it("像素模式原样返回", () => {
    expect(normalizeWheelDelta(40, 0)).toBe(40);
  });

  it("行模式按行高换算（默认 16px/行）", () => {
    expect(normalizeWheelDelta(3, 1)).toBe(48);
    expect(normalizeWheelDelta(3, 1, 20)).toBe(60);
  });

  it("页模式按页高换算（未给出时按 10 行估算）", () => {
    expect(normalizeWheelDelta(1, 2, 16, 500)).toBe(500);
    expect(normalizeWheelDelta(1, 2, 16, 0)).toBe(160);
  });

  it("方向保持不变（负增量仍为负）", () => {
    expect(normalizeWheelDelta(-3, 1)).toBe(-48);
  });
});

describe("P12-2 clampScrollLeft / computeSmoothedScroll", () => {
  it("钳制到可滚动范围", () => {
    expect(clampScrollLeft(-50, 300, 900)).toBe(0);
    expect(clampScrollLeft(100, 300, 900)).toBe(100);
    expect(clampScrollLeft(9999, 300, 900)).toBe(600);
    // 无溢出时恒为 0
    expect(clampScrollLeft(50, 300, 300)).toBe(0);
  });

  it("缓动：首帧只走一部分，逐渐逼近目标", () => {
    const first = computeSmoothedScroll(0, 100, 0.3);
    expect(first).toBeCloseTo(30);
    const second = computeSmoothedScroll(first, 100, 0.3);
    expect(second).toBeGreaterThan(first);
    expect(second).toBeLessThan(100);
  });

  it("剩余位移小于 1px 时直接吸附到目标（动画可终止）", () => {
    expect(computeSmoothedScroll(100.4, 100)).toBe(100);
    expect(computeSmoothedScroll(99.8, 100)).toBe(100);
  });

  it("反复迭代一定收敛到目标（不会无限循环）", () => {
    let cur = 0;
    for (let i = 0; i < 100 && cur !== 100; i++) cur = computeSmoothedScroll(cur, 100);
    expect(cur).toBe(100);
  });
});

// ─── P12-3 活跃标签自动滚入可视区 ────────────────────────
describe("P12-3 computeScrollToReveal", () => {
  it("已完全可见时不滚动（返回 null）", () => {
    expect(computeScrollToReveal(100, 150, 0, 600, 2000)).toBe(null);
    expect(computeScrollToReveal(0, 150, 0, 600, 2000)).toBe(null);
  });

  it("右侧被遮住 → 对齐到视口右边缘", () => {
    // 标签 [650, 800)，视口 [0, 600) → 目标 = 800 - 600 = 200
    expect(computeScrollToReveal(650, 150, 0, 600, 2000)).toBe(200);
  });

  it("左侧被遮住 → 对齐到视口左边缘", () => {
    expect(computeScrollToReveal(100, 150, 400, 600, 2000)).toBe(100);
  });

  it("结果钳制在可滚动范围内", () => {
    // 标签 [700,850)、视口 [0,600)、内容 800 → 目标 = 850-600 = 250，超过上限 200 → 钳到 200
    expect(computeScrollToReveal(700, 150, 0, 600, 800)).toBe(200);
    // 标签 [500,650)、视口 [0,600) → 目标 50（未超上限，保持）
    expect(computeScrollToReveal(500, 150, 0, 600, 800)).toBe(50);
  });

  it("视口宽为 0（未布局）时不滚动", () => {
    expect(computeScrollToReveal(100, 150, 0, 0, 2000)).toBe(null);
  });
});

// ─── P12-4 / P12-5 侧栏拖拽上限 ──────────────────────────
describe("P12-5 computeExtendableMaxHeight", () => {
  it("容器已溢出时仍可用守恒上限（压缩上区放大本区）", () => {
    // 收藏 200 + 最近 200 + 分隔条 4 = 404 > 容器 300（已溢出）：
    // 守恒上限 = 200 + (200-80) = 320，容器上限 = 300-0-4-80 = 216 → 取 320
    const max = computeExtendableMaxHeight(300, 200, 200, [], 4, 1, MIN_SECTION_HEIGHT);
    expect(max).toBe(320);
    // 拖到上限：最近 320、收藏 80，且确实变大（旧实现会返回 minHeight 导致拖不动）
    expect(computeSplitExtendable(200, 200, -500, MIN_SECTION_HEIGHT, max)).toEqual({
      top: 80,
      bottom: 320,
    });
  });

  it("只有一个文件夹 + 打开的文件时，后者可一直往上拖（容器上限生效）", () => {
    // 文件夹 250 + temp 200，容器 500：容器上限 = 500 - 0 - 4 - 80 = 416
    const max = computeExtendableMaxHeight(500, 250, 200, [], 4, 1, MIN_SECTION_HEIGHT);
    expect(max).toBe(416);
    const r = computeSplitExtendable(250, 200, -500, MIN_SECTION_HEIGHT, max);
    expect(r.bottom).toBe(416);
    expect(r.top).toBe(MIN_SECTION_HEIGHT);
  });

  it("多个其他区域存在时，其他区域高度计入容器上限", () => {
    const max = computeExtendableMaxHeight(500, 200, 200, [250, 200], 4, 3, MIN_SECTION_HEIGHT);
    // 容器上限 = 500 - 450 - 12 - 80 < 0 → 取守恒上限 320
    expect(max).toBe(320);
  });

  it("上限永不低于本区当前高度（避免向上拖时反向压缩）", () => {
    const max = computeExtendableMaxHeight(300, 100, 250, [400], 4, 1, MIN_SECTION_HEIGHT);
    const r = computeSplitExtendable(100, 250, -300, MIN_SECTION_HEIGHT, max);
    expect(r.bottom).toBeGreaterThanOrEqual(250);
  });
});

describe("P12-4 关闭末栏后上一栏自动填充", () => {
  it("computeMaxSelfHeight 不预留时正好填满容器底部", () => {
    // 容器 600、其他区域 200、1 条分隔条 → 末区 = 600 - 200 - 4 = 396
    expect(computeMaxSelfHeight(600, [200], 4, 1, MIN_SECTION_HEIGHT)).toBe(396);
  });

  it("最近打开栏为空时不参与布局（与实际渲染保持一致）", () => {
    expect(read("../components/sidebar/FileTree.tsx")).toContain(
      'if (showRecent && recentFiles.length > 0) ordered.push("recent");',
    );
  });

  it("RecentFiles 的拖拽 hook 先于空状态 return（否则 hook 数量变化会抛错）", () => {
    const src = read("../components/sidebar/RecentFiles.tsx");
    const hookIdx = src.indexOf("useSectionSplit({");
    // v0.8.5 适配：RecentFiles 新增「最近文件夹」区，空状态 return 条件同步含 recentFolders
    const returnIdx = src.indexOf(
      "if (recentFiles.length === 0 && recentFolders.length === 0) return null;",
    );
    expect(hookIdx).toBeGreaterThan(-1);
    expect(returnIdx).toBeGreaterThan(hookIdx);
  });

  it("FileTree 在可见区域集合变化后把末区扩展到底部", () => {
    const src = read("../components/sidebar/FileTree.tsx");
    expect(src).toContain("skipAutoFillRef");
    expect(src).toContain("orderedKey");
    // 总高不足容器时才扩展（已溢出交给滚动条）
    expect(src).toContain("if (total < container)");
    expect(src).toMatch(/next\[lastKey\] = target/);
  });
});

// ─── P12-1 文件夹空白区右键粘贴 ──────────────────────────
describe("P12-1 文件夹空白区右键粘贴", () => {
  const fileTreeSrc = read("../components/sidebar/FileTree.tsx");

  it("文件夹内容区绑定右键 → 打开粘贴菜单", () => {
    expect(fileTreeSrc).toContain("onFolderContextMenu");
    expect(fileTreeSrc).toMatch(/onContextMenu=\{\(e\) => \{[\s\S]{0,200}onFolderContextMenu\?\.\(folder\.path/);
  });

  it("菜单项根据剪贴板是否为空决定是否置灰", () => {
    // v0.8.4 反馈1：改用渲染期实时读取 hasClipboard()（去掉打开菜单时的 canPaste 快照），
    // 保证"复制/剪切后重开菜单即为可用态"
    expect(fileTreeSrc).toContain("disabled={!hasClipboard()}");
  });

  it("点击粘贴把剪贴板文件传送到该文件夹（模式由剪贴板决定，P13-1）", () => {
    // v0.8.4 反馈1：粘贴链路收敛到 handlePasteIntoDir，空白区菜单项与文件夹节点右键菜单共用
    expect(fileTreeSrc).toMatch(
      /const handlePasteIntoDir = useCallback\([\s\S]{0,400}?void transferTo\(\s*clip\.path,\s*targetDir,\s*clipboardTransferMode\(clip\)/,
    );
    expect(fileTreeSrc).toContain("handlePasteIntoDir(folderCtxMenu.dir)");
  });

  it("提供置灰时的提示文案（中英）", () => {
    expect(read("../i18n/locales/zh-CN.ts")).toContain('"filetree.pasteEmpty"');
    expect(read("../i18n/locales/en-US.ts")).toContain('"filetree.pasteEmpty"');
  });

  it("置灰菜单项有对应样式", () => {
    expect(read("../components/sidebar/FileTree.css")).toContain(".context-menu-item:disabled");
  });
});

// ─── P12-6 侧栏滚动条 ────────────────────────────────────
describe("P12-6 侧栏滚动条更细更无感", () => {
  // v0.8.1 需求1：侧栏滚动条样式已统一收敛到 global.css 的 .app-sidebar 作用域
  const css = read("../styles/global.css");

  it("v0.8.1：左右两栏宽度 2px 且默认透明，悬停该栏才显形", () => {
    expect(css).toMatch(
      /\.app-sidebar ::-webkit-scrollbar,[^{]*\.app-outline ::-webkit-scrollbar\s*\{[^}]*width:\s*2px/,
    );
    expect(css).toMatch(
      /\.app-sidebar ::-webkit-scrollbar-thumb,[^{]*\.app-outline ::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*transparent/,
    );
    expect(css).toMatch(/\.app-sidebar:hover ::-webkit-scrollbar-thumb/);
    expect(css).toMatch(/\.app-outline:hover ::-webkit-scrollbar-thumb/);
  });

  it("不声明标准属性 scrollbar-width / scrollbar-color（否则 Chromium 121+ 会忽略 2px）", () => {
    // 仅在注释中说明；一旦出现真实声明，::-webkit-scrollbar 全系列样式会被整体忽略
    expect(css).not.toMatch(/^\s*scrollbar-width\s*:/m);
    expect(css).not.toMatch(/^\s*scrollbar-color\s*:/m);
  });
});
