/**
 * v0.8.5 需求6+7：纯视觉动画防回退测试
 *
 * 需求6：NewFolderDialog / NewFileDialog 打开过渡动画
 *   - overlay 淡入（160ms）+ 弹窗本体 pop-in（translateY(6px)+scale(0.96) → 原位，180ms）
 *   - 两弹窗共用同一套动画类（dialog-overlay-in / dialog-pop-in），条件渲染挂载即自动播放
 *
 * 需求7：底部栏搜索面板「神灯精灵」呼出/收回动画
 *   - 链路：StatusBar 搜索按钮 → useEditorStore.showSearch → EditorContainer 渲染
 *     GenieSearchDialog（延迟卸载壳）→ SearchReplaceDialog
 *   - 呼出 search-genie-in（260ms ease-out 弧线 overshoot + blur）
 *   - 收回 search-genie-out（220ms ease-in 反向缩回），动画结束后才真正卸载
 *   - 尾巴残影：面板 ::before/::after 丝带块延迟副本（45/90ms，峰值递减）
 *   - prefers-reduced-motion 直接显示/隐藏降级
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, Fragment } from "react";
import { render, fireEvent, cleanup, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// StatusBar 依赖 translateService.cancel（mock 掉，避免真发 invoke；照抄 v0.8.1 惯例）
vi.mock("../services/translateService", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../services/translateService")>();
  return {
    ...orig,
    translateService: {
      ...orig.translateService,
      cancel: vi.fn().mockResolvedValue(undefined),
    },
  };
});

import { NewFolderDialog } from "../components/dialogs/NewFolderDialog";
import { NewFileDialog } from "../components/dialogs/NewFileDialog";
import { StatusBar } from "../components/layout/StatusBar";
import { GenieSearchDialog } from "../components/editor/SearchReplace";
import { useEditorStore } from "../stores/useEditorStore";

// ─── CSS 源文本断言工具（参考 v0.8.4-anim-vertical.test.ts 惯例）──────────

function readSrc(rel: string): string {
  return readFileSync(join(__dirname, rel), "utf-8");
}

/** 截取指定 keyframes 块源文本（从 @keyframes 名称到配对大括号结束） */
function extractKeyframes(css: string, name: string): string {
  const marker = `@keyframes ${name}`;
  const start = css.indexOf(marker);
  expect(start, `应存在 ${marker}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  let end = start;
  for (let i = start; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  return css.slice(start, end);
}

const dialogCss = readSrc("../components/dialogs/NewFolderDialog.css");
const searchCss = readSrc("../components/editor/SearchReplace.css");

// ─── 测试组件：模拟 EditorContainer 的真实接线（StatusBar + 延迟卸载壳）────

function GenieHarness() {
  const active = useEditorStore((s) => s.showSearch || s.showSearchReplace);
  return createElement(
    Fragment,
    null,
    createElement(StatusBar),
    createElement(GenieSearchDialog, {
      active,
      onClose: () => {
        useEditorStore.getState().setShowSearch(false);
        useEditorStore.getState().setShowSearchReplace(false);
      },
      editorView: null,
      isMdFile: true,
    }),
  );
}

/** 点击底栏搜索按钮（statusbar-center 内第一个 toggle） */
function clickSearchButton() {
  const btn = document.querySelector(".statusbar-center .statusbar-toggle") as HTMLButtonElement;
  expect(btn, "底栏应存在搜索按钮").toBeTruthy();
  fireEvent.click(btn);
  return btn;
}

beforeEach(() => {
  // 复位搜索相关 store 状态，避免用例间串扰
  useEditorStore.setState({ showSearch: false, showSearchReplace: false });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ═══ 需求6：新建文件夹/新建文件弹窗「打开过渡动画」 ═══

describe("v0.8.5 需求6：弹窗打开过渡动画类", () => {
  it("NewFolderDialog 打开时 overlay 带 dialog-overlay-in、本体带 dialog-pop-in", () => {
    const { container } = render(
      createElement(NewFolderDialog, {
        open: true,
        openFolders: [{ path: "D:/docs", name: "docs" }],
        onClose: () => {},
        onConfirm: () => {},
      }),
    );
    const overlay = container.querySelector(".newfolder-overlay") as HTMLElement;
    const dialog = container.querySelector(".newfolder-dialog") as HTMLElement;
    expect(overlay).toBeTruthy();
    expect(overlay.className).toContain("dialog-overlay-in");
    expect(dialog.className).toContain("dialog-pop-in");
  });

  it("NewFileDialog 复用同一套动画类（打开时同样带 pop-in）", () => {
    const { container } = render(
      createElement(NewFileDialog, {
        open: true,
        parentPath: "D:/docs",
        onClose: () => {},
        onConfirm: async () => {},
      }),
    );
    const overlay = container.querySelector(".newfile-overlay") as HTMLElement;
    const dialog = container.querySelector(".newfolder-dialog") as HTMLElement;
    expect(overlay).toBeTruthy();
    expect(overlay.className).toContain("dialog-overlay-in");
    expect(dialog.className).toContain("dialog-pop-in");
  });

  it("open=false 时不渲染（动画类不会在关闭态出现）", () => {
    const { container } = render(
      createElement(NewFolderDialog, {
        open: false,
        openFolders: [],
        onClose: () => {},
        onConfirm: () => {},
      }),
    );
    expect(container.querySelector(".newfolder-overlay")).toBeNull();
  });
});

describe("v0.8.5 需求6：弹窗动画 CSS 源文本", () => {
  it("NewFolderDialog.css 定义 overlay 淡入与本体 pop-in keyframes", () => {
    const fade = extractKeyframes(dialogCss, "dialog-overlay-fade-in");
    expect(fade).toContain("opacity: 0");
    expect(fade).toContain("opacity: 1");

    const pop = extractKeyframes(dialogCss, "dialog-pop-in");
    // 本体：轻微上移 + 缩放 → 原位（需求给定参数）
    expect(pop).toContain("translateY(6px)");
    expect(pop).toContain("scale(0.96)");
    expect(pop).toContain("opacity: 0");
  });

  it("动画类绑定时长（160ms overlay / 180ms 本体）且挂载即播放", () => {
    expect(dialogCss).toMatch(/\.dialog-overlay-in\s*\{[^}]*animation:\s*dialog-overlay-fade-in\s+0\.16s/);
    expect(dialogCss).toMatch(/\.dialog-pop-in\s*\{[^}]*animation:\s*dialog-pop-in\s+0\.18s/);
  });

  it("弹窗动画含 prefers-reduced-motion 降级", () => {
    const m = dialogCss.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(m).toBeGreaterThanOrEqual(0);
    const block = dialogCss.slice(m, dialogCss.indexOf("}", m) + 1);
    expect(block).toContain("dialog-overlay-in");
    expect(block).toContain("dialog-pop-in");
    expect(block).toContain("animation: none");
  });
});

// ═══ 需求7：底部栏搜索面板「神灯精灵」呼出/收回动画 ═══

describe("v0.8.5 需求7：搜索面板神灯动画（延迟卸载壳）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("初始未打开时不渲染面板壳（与原条件渲染行为一致）", () => {
    const { container } = render(createElement(GenieHarness));
    expect(container.querySelector('[data-testid="search-genie"]')).toBeNull();
  });

  it("点击底栏搜索按钮呼出面板：壳带 search-genie-in 类，面板已挂载", () => {
    const { container } = render(createElement(GenieHarness));
    const btn = clickSearchButton();
    // 按钮进入激活态
    expect(btn.className).toContain("active");
    expect(useEditorStore.getState().showSearch).toBe(true);
    // 面板挂载并处于呼出动画态
    const shell = container.querySelector('[data-testid="search-genie"]') as HTMLElement;
    expect(shell).toBeTruthy();
    expect(shell.className).toContain("search-genie-in");
    expect(shell.querySelector(".search-replace")).toBeTruthy();
  });

  it("再次点击收回：壳切 search-genie-out，面板延迟卸载（收回动画期间仍在 DOM）", () => {
    const { container } = render(createElement(GenieHarness));
    clickSearchButton();
    let shell = container.querySelector('[data-testid="search-genie"]') as HTMLElement;
    expect(shell.className).toContain("search-genie-in");

    clickSearchButton();
    expect(useEditorStore.getState().showSearch).toBe(false);
    shell = container.querySelector('[data-testid="search-genie"]') as HTMLElement;
    // 进入收回态：out 类 + 面板尚未卸载（延迟卸载，给收回动画留时间）
    expect(shell).toBeTruthy();
    expect(shell.className).toContain("search-genie-out");
    expect(shell.className).not.toContain("search-genie-in");
    expect(shell.querySelector(".search-replace")).toBeTruthy();

    // 动画（含尾巴 40ms delay + 220ms）播完后真正卸载
    act(() => {
      vi.advanceTimersByTime(280);
    });
    expect(container.querySelector('[data-testid="search-genie"]')).toBeNull();
  });

  it("收回中途再次呼出：定时器被取消，面板回到 in 态不卸载", () => {
    const { container } = render(createElement(GenieHarness));
    clickSearchButton();
    clickSearchButton();
    expect(
      (container.querySelector('[data-testid="search-genie"]') as HTMLElement).className,
    ).toContain("search-genie-out");

    // 收回动画未结束就重新打开
    clickSearchButton();
    const shell = container.querySelector('[data-testid="search-genie"]') as HTMLElement;
    expect(shell.className).toContain("search-genie-in");
    // 推进超过原卸载定时：面板不应被误卸载
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(container.querySelector('[data-testid="search-genie"]')).toBeTruthy();
    expect(useEditorStore.getState().showSearch).toBe(true);
  });

  it("onClose（面板关闭按钮路径）同样走收回动画后卸载", () => {
    const { container } = render(createElement(GenieHarness));
    clickSearchButton();
    // 模拟 SearchReplaceDialog 内部 onClose（Escape / 关闭按钮都走 store）
    act(() => {
      useEditorStore.getState().setShowSearch(false);
    });
    const shell = container.querySelector('[data-testid="search-genie"]') as HTMLElement;
    expect(shell.className).toContain("search-genie-out");
    act(() => {
      vi.advanceTimersByTime(280);
    });
    expect(container.querySelector('[data-testid="search-genie"]')).toBeNull();
  });
});

describe("v0.8.5 需求7：神灯动画 CSS 源文本", () => {
  it("定义呼出/收回/尾巴四组 keyframes", () => {
    for (const name of [
      "search-genie-in",
      "search-genie-out",
      "search-genie-tail-in",
      "search-genie-tail-out",
    ]) {
      expect(searchCss.indexOf(`@keyframes ${name}`)).toBeGreaterThanOrEqual(0);
    }
  });

  it("呼出弧线：从按钮方向(下方44px)小尺寸+模糊飞入，60% 处 overshoot", () => {
    const block = extractKeyframes(searchCss, "search-genie-in");
    expect(block).toContain("translateY(44px)");
    expect(block).toContain("scale(0.3)");
    expect(block).toContain("blur(6px)");
    // 弧线 overshoot 上冲回弹
    expect(block).toContain("translateY(-6px)");
    expect(block).toContain("scale(1.03)");
  });

  it("收回弧线：反向缩回按钮方向并淡出", () => {
    const block = extractKeyframes(searchCss, "search-genie-out");
    expect(block).toContain("translateY(44px)");
    expect(block).toContain("scale(0.3)");
    expect(block).toContain("opacity: 0");
  });

  it("动画绑定呼出 260ms ease-out / 收回 220ms ease-in，时长满足 ≤300ms/≤250ms", () => {
    expect(searchCss).toMatch(/\.search-genie-in > \.search-replace\s*\{[^}]*animation:\s*search-genie-in\s+0\.26s\s+ease-out/);
    expect(searchCss).toMatch(/\.search-genie-out > \.search-replace\s*\{[^}]*animation:\s*search-genie-out\s+0\.22s\s+ease-in/);
  });

  it("transform-origin 定位到底部中心（搜索按钮一侧）", () => {
    expect(searchCss.match(/transform-origin:\s*50%\s+100%/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("尾巴残影：面板 ::before/::after 延迟副本（45ms/90ms）且透明度递减", () => {
    // 尾巴块定位在面板底部（朝按钮方向拖出）
    expect(searchCss).toMatch(/\.search-genie-in > \.search-replace::before\s*\{[^}]*animation-delay:\s*0\.045s/);
    expect(searchCss).toMatch(/\.search-genie-in > \.search-replace::after\s*\{[^}]*animation-delay:\s*0\.09s/);
    // 峰值透明度经 --tail-peak 注入：第二层（::after）低于第一层
    expect(searchCss).toContain("--tail-peak: 0.32");
    expect(searchCss).toContain("--tail-peak: 0.16");
    expect(searchCss).toContain("var(--tail-peak");
  });

  it("收回期间禁交互（pointer-events: none）", () => {
    const m = searchCss.indexOf(".search-genie-out > .search-replace {");
    const block = searchCss.slice(m, searchCss.indexOf("}", m) + 1);
    expect(block).toContain("pointer-events: none");
  });

  it("神灯动画含 prefers-reduced-motion 直接显示/隐藏降级", () => {
    const m = searchCss.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(m).toBeGreaterThanOrEqual(0);
    const block = searchCss.slice(m, searchCss.indexOf("}", m) + 1);
    expect(block).toContain("search-genie-in > .search-replace");
    expect(block).toContain("animation: none");
  });
});

describe("v0.8.5 需求7：EditorContainer 呼出链路接线（防回退）", () => {
  it("EditorContainer 用 GenieSearchDialog 包裹搜索面板并以 showSearch 驱动 active", () => {
    const src = readSrc("../components/editor/EditorContainer.tsx");
    expect(src).toContain("GenieSearchDialog");
    expect(src).toContain("active={showSearch || showSearchReplace}");
    // 原 props 透传保持不变
    expect(src).toMatch(/initialShowReplace=\{showSearchReplace\}/);
  });
});
