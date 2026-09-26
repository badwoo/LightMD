/**
 * v0.8.5 需求6+7 + 反馈3/5：纯视觉动画防回退测试
 *
 * 需求6 + 反馈3：NewFolderDialog / NewFileDialog 打开过渡动画（闪动修复）
 *   - 遮罩淡入挂在 overlay 的 ::before 独立层（与弹窗 pop-in 透明度解耦，
 *     修复双层 opacity 相乘导致动画期间背景透出的"杂乱闪动"），
 *     遮罩/弹窗加 will-change 强制合成层提升（WebView2 掉帧嫌疑排除）
 *   - 弹窗本体 pop-in（translateY(6px)+scale(0.96) → 原位，180ms）
 *   - 动画不含 backdrop-filter / box-shadow 参与
 *
 * 需求7 + 反馈5：底部栏搜索面板「神灯精灵」丝带动画重做
 *   - 链路：StatusBar 搜索按钮（data-genie-anchor）→ useEditorStore.showSearch →
 *     EditorContainer 渲染 GenieSearchDialog（延迟卸载壳）→ SearchReplaceDialog
 *   - 丝带 .search-genie-ribbon：连接按钮与面板的垂直光带（fixed + CSS 变量定位，
 *     壳挂载后 JS 一次性测量注入坐标）
 *   - 打开三拍：丝带向上生长(0-40%) → 面板沿丝带滑出(20-80%, overshoot) → 丝带淡出(70-100%)
 *   - 关闭：丝带亮起(0-30%) → 面板滑回按钮 → 丝带向下收回归零（350ms，400ms 后卸载）
 *   - prefers-reduced-motion 降级
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

/** 截取指定选择器规则块源文本（从选择器出现处到配对大括号结束） */
function extractRule(css: string, selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `应存在选择器 ${selector}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  let end = start;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
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

/** 点击底栏搜索按钮（statusbar-center 内第一个 toggle，即 data-genie-anchor 锚点） */
function clickSearchButton() {
  const btn = document.querySelector(".statusbar-center .statusbar-toggle") as HTMLButtonElement;
  expect(btn, "底栏应存在搜索按钮").toBeTruthy();
  fireEvent.click(btn);
  return btn;
}

/**
 * mock getBoundingClientRect：按钮/面板返回给定矩形，其余元素返回全 0。
 * 用于断言 GenieSearchDialog 的丝带坐标变量注入（反馈5）。
 */
function mockGenieRects(
  btn: { left: number; top: number; width: number; height: number },
  panel: { left: number; top: number; width: number; height: number },
) {
  const toRect = (r: { left: number; top: number; width: number; height: number }) =>
    ({
      x: r.left,
      y: r.top,
      ...r,
      right: r.left + r.width,
      bottom: r.top + r.height,
      toJSON: () => ({}),
    }) as DOMRect;
  return vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: DOMRect) {
      // 运行时 this 实为 HTMLElement（调用方元素），vitest 类型签名按 DOMRect 推断
      const el = this as unknown as HTMLElement;
      if (el.hasAttribute("data-genie-anchor")) return toRect(btn);
      if (el.classList.contains("search-replace")) return toRect(panel);
      return toRect({ left: 0, top: 0, width: 0, height: 0 });
    });
}

beforeEach(() => {
  // 复位搜索相关 store 状态，避免用例间串扰
  useEditorStore.setState({ showSearch: false, showSearchReplace: false });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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

describe("v0.8.5 需求6+反馈3：弹窗动画 CSS 源文本（闪动修复）", () => {
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

  it("反馈3：遮罩淡入挂在 overlay 的 ::before 独立层（与弹窗透明度解耦）", () => {
    const mask = extractRule(dialogCss, ".dialog-overlay-in::before");
    expect(mask).toContain("content:");
    // 半透明遮罩视觉不回退（遮罩背景由伪元素承载）
    expect(mask).toContain("background: rgba(0, 0, 0, 0.35)");
    // 合成层提升：遮罩仅 opacity 动画 + will-change
    expect(mask).toContain("animation: dialog-overlay-fade-in 0.16s ease-out both");
    expect(mask).toContain("will-change: opacity");
    // overlay 容器自身不再有 animation（透明度不再叠加到弹窗）
    const overlayRule = extractRule(dialogCss, ".newfolder-overlay {");
    expect(overlayRule).not.toContain("animation");
  });

  it("反馈3：弹窗动画绑定时长且带 will-change 合成层提升（挂载即播放）", () => {
    const popRule = extractRule(dialogCss, ".dialog-pop-in {");
    expect(popRule).toContain("animation: dialog-pop-in 0.18s ease-out both");
    expect(popRule).toContain("will-change: transform, opacity");
  });

  it("反馈3：弹窗动画规则块不含 backdrop-filter / box-shadow 参与（掉帧嫌疑排除）", () => {
    // 限定在动画规则块与 keyframes 内断言（CSS 注释的根因说明允许提及这些词）
    const maskRule = extractRule(dialogCss, ".dialog-overlay-in::before {");
    const popRule = extractRule(dialogCss, ".dialog-pop-in {");
    for (const rule of [maskRule, popRule]) {
      expect(rule).not.toContain("backdrop-filter");
      expect(rule).not.toContain("box-shadow");
      expect(rule).not.toContain("transition");
    }
    // 两组 keyframes 内均不得引入 box-shadow（阴影随合成层静态栅格化，不逐帧重绘）
    expect(extractKeyframes(dialogCss, "dialog-overlay-fade-in")).not.toContain("box-shadow");
    expect(extractKeyframes(dialogCss, "dialog-pop-in")).not.toContain("box-shadow");
  });

  it("弹窗动画含 prefers-reduced-motion 降级（含伪元素遮罩）", () => {
    const m = dialogCss.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(m).toBeGreaterThanOrEqual(0);
    const block = dialogCss.slice(m, dialogCss.indexOf("}", m) + 1);
    expect(block).toContain(".dialog-overlay-in::before");
    expect(block).toContain(".dialog-pop-in");
    expect(block).toContain("animation: none");
  });
});

// ═══ 需求7+反馈5：底部栏搜索面板「神灯精灵」丝带动画 ═══

describe("v0.8.5 需求7+反馈5：搜索面板神灯丝带动画（延迟卸载壳）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // rAF 统一 stub 为 0ms 定时器，fake timers 可精确推进（壳内双层 rAF = 两次 tick）
    // 注：fake timers 环境下 setTimeout 返回 Timeout 而非 number，经 unknown 双重断言对齐签名
    vi.stubGlobal(
      "requestAnimationFrame",
      ((cb: FrameRequestCallback) =>
        setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame,
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      ((id: number) => clearTimeout(id)) as typeof cancelAnimationFrame,
    );
  });

  it("初始未打开时不渲染面板壳与丝带（与原条件渲染行为一致）", () => {
    const { container } = render(createElement(GenieHarness));
    expect(container.querySelector('[data-testid="search-genie"]')).toBeNull();
    expect(container.querySelector(".search-genie-ribbon")).toBeNull();
  });

  it("点击底栏搜索按钮呼出：壳带 search-genie-in，面板与丝带已挂载", () => {
    const { container } = render(createElement(GenieHarness));
    const btn = clickSearchButton();
    // 按钮进入激活态
    expect(btn.className).toContain("active");
    expect(useEditorStore.getState().showSearch).toBe(true);
    // 面板挂载并处于呼出动画态；丝带元素随壳渲染
    const shell = container.querySelector('[data-testid="search-genie"]') as HTMLElement;
    expect(shell).toBeTruthy();
    expect(shell.className).toContain("search-genie-in");
    expect(shell.querySelector(".search-replace")).toBeTruthy();
    expect(shell.querySelector(".search-genie-ribbon")).toBeTruthy();
  });

  it("反馈5：StatusBar 搜索按钮带 data-genie-anchor 锚点（丝带定位依据）", () => {
    render(createElement(GenieHarness));
    expect(document.querySelector("[data-genie-anchor]")).toBeTruthy();
  });

  it("反馈5：面板挂载后测量按钮/面板位置并注入丝带坐标 CSS 变量", () => {
    // 按钮中心 x=520+60/2=550；面板 top=120/bottom=200 → 丝带高 760-200=560
    const spy = mockGenieRects(
      { left: 520, top: 760, width: 60, height: 24 },
      { left: 300, top: 120, width: 460, height: 80 },
    );
    const { container } = render(createElement(GenieHarness));
    clickSearchButton();
    const shell = container.querySelector('[data-testid="search-genie"]') as HTMLElement;
    // 推进双层 rAF（内部等待面板初始定位完成后再测量）
    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(shell.style.getPropertyValue("--genie-x")).toBe("550px");
    expect(shell.style.getPropertyValue("--genie-from-y")).toBe("640px");
    expect(shell.style.getPropertyValue("--ribbon-top")).toBe("200px");
    expect(shell.style.getPropertyValue("--ribbon-h")).toBe("560px");
    spy.mockRestore();
  });

  it("再次点击收回：壳切 search-genie-out，面板延迟卸载（收回动画期间仍在 DOM）", () => {
    const { container } = render(createElement(GenieHarness));
    clickSearchButton();
    let shell = container.querySelector('[data-testid="search-genie"]') as HTMLElement;
    expect(shell.className).toContain("search-genie-in");

    clickSearchButton();
    expect(useEditorStore.getState().showSearch).toBe(false);
    shell = container.querySelector('[data-testid="search-genie"]') as HTMLElement;
    // 进入收回态：out 类 + 面板/丝带尚未卸载（延迟卸载，给收回动画留时间）
    expect(shell).toBeTruthy();
    expect(shell.className).toContain("search-genie-out");
    expect(shell.className).not.toContain("search-genie-in");
    expect(shell.querySelector(".search-replace")).toBeTruthy();
    expect(shell.querySelector(".search-genie-ribbon")).toBeTruthy();

    // 收回动画 350ms 播完后真正卸载（GENIE_OUT_MS=400）
    act(() => {
      vi.advanceTimersByTime(400);
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
      vi.advanceTimersByTime(500);
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
      vi.advanceTimersByTime(400);
    });
    expect(container.querySelector('[data-testid="search-genie"]')).toBeNull();
  });
});

describe("v0.8.5 需求7+反馈5：神灯丝带动画 CSS 源文本", () => {
  it("定义打开/关闭四组 keyframes（丝带生长·收回 + 面板滑出·滑回）", () => {
    for (const name of [
      "search-genie-panel-in",
      "search-genie-panel-out",
      "search-genie-ribbon-grow",
      "search-genie-ribbon-return",
    ]) {
      expect(searchCss.indexOf(`@keyframes ${name}`)).toBeGreaterThanOrEqual(0);
    }
  });

  it("丝带为独立元素：fixed 光带连到按钮（CSS 变量定位 + 圆角发光 + 低于面板层级）", () => {
    const ribbon = extractRule(searchCss, ".search-genie-ribbon {");
    expect(ribbon).toContain("position: fixed");
    expect(ribbon).toContain("left: var(--genie-x");
    expect(ribbon).toContain("top: var(--ribbon-top");
    expect(ribbon).toContain("height: var(--ribbon-h");
    expect(ribbon).toContain("width: 4px");
    expect(ribbon).toContain("border-radius:");
    expect(ribbon).toContain("box-shadow:");
    expect(ribbon).toContain("z-index: 9999");
    expect(ribbon).toContain("transform-origin: bottom center");
    expect(ribbon).toContain("pointer-events: none");
  });

  it("打开编排：面板从按钮位置(var(--genie-from-y))滑出，overshoot 落定", () => {
    const block = extractKeyframes(searchCss, "search-genie-panel-in");
    expect(block).toContain("var(--genie-from-y");
    expect(block).toContain("scale(0.3)");
    expect(block).toContain("blur(6px)");
    // 80% 处轻微 overshoot 后回弹落定
    expect(block).toContain("translateY(-6px)");
    expect(block).toContain("scale(1.02)");
  });

  it("打开编排：丝带向上生长（scaleY 0→1）后顺滑淡出", () => {
    const block = extractKeyframes(searchCss, "search-genie-ribbon-grow");
    expect(block).toContain("scaleY(0)");
    expect(block).toContain("scaleY(1)");
    expect(block).toContain("opacity: 0");
  });

  it("关闭编排：面板滑回按钮位置（translateY 回 from-y）并淡出", () => {
    const block = extractKeyframes(searchCss, "search-genie-panel-out");
    expect(block).toContain("var(--genie-from-y");
    expect(block).toContain("scale(0.3)");
    expect(block).toContain("opacity: 0");
  });

  it("关闭编排：丝带重新亮起后向下收回归零（scaleY 1→0）", () => {
    const block = extractKeyframes(searchCss, "search-genie-ribbon-return");
    expect(block).toContain("scaleY(1)");
    expect(block).toContain("scaleY(0)");
    expect(block).toContain("opacity: 0");
  });

  it("编排时长绑定：打开 420ms / 收回 350ms，卸载定时 400ms 覆盖收回动画", () => {
    expect(searchCss).toMatch(
      /\.search-genie-in > \.search-replace\s*\{[^}]*animation:\s*search-genie-panel-in\s+0\.42s/,
    );
    expect(searchCss).toMatch(
      /\.search-genie-out > \.search-replace\s*\{[^}]*animation:\s*search-genie-panel-out\s+0\.35s\s+ease-in/,
    );
    expect(searchCss).toMatch(
      /\.search-genie-in \.search-genie-ribbon\s*\{[^}]*animation:\s*search-genie-ribbon-grow\s+0\.42s/,
    );
    expect(searchCss).toMatch(
      /\.search-genie-out \.search-genie-ribbon\s*\{[^}]*animation:\s*search-genie-ribbon-return\s+0\.35s/,
    );
    // 壳源码：延迟卸载常量覆盖 350ms 收回动画
    const src = readSrc("../components/editor/SearchReplace.tsx");
    expect(src).toContain("GENIE_OUT_MS = 400");
  });

  it("动画全部走合成层属性（transform/opacity/filter），丝带带 will-change", () => {
    const ribbon = extractRule(searchCss, ".search-genie-ribbon {");
    expect(ribbon).toContain("will-change: transform, opacity");
  });

  it("收回期间禁交互（pointer-events: none）", () => {
    const block = extractRule(searchCss, ".search-genie-out > .search-replace {");
    expect(block).toContain("pointer-events: none");
  });

  it("神灯动画含 prefers-reduced-motion 降级（丝带隐藏 + 面板直接显隐）", () => {
    const m = searchCss.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(m).toBeGreaterThanOrEqual(0);
    const block = searchCss.slice(m);
    expect(block).toContain(".search-genie-ribbon");
    expect(block).toContain("display: none");
    expect(block).toContain(".search-genie-in > .search-replace");
    expect(block).toContain("animation: none");
    expect(block).toContain("opacity: 0");
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
