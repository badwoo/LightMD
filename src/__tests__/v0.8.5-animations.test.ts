/**
 * v0.8.5 需求6+7 + 反馈（第三版定稿）：纯视觉动画防回退测试
 *
 * A. NewFolderDialog / NewFileDialog 打开过渡动画（"动画期间背景杂乱闪动"修复）
 *    - 根因（用 Edge 逐帧定格复核）：弹窗本体动画里带 opacity 0→1，淡入前半程
 *      背后编辑器文字**透过弹窗**显形、且随 scale 逐帧位移 = 观感上的"背景杂乱闪动"；
 *      遮罩又从全透明起步，第一帧整屏全亮 → 一次全屏明暗跳变。
 *    - 修法：弹窗本体**完全不做 opacity 动画**（只做 transform），遮罩淡入留在
 *      overlay 的 ::before 独立层（纯色层透明度，代价极低）。
 *    - 配套：弹窗表单重置改用 useLayoutEffect（绘制前落定，动画途中不再改 DOM）。
 *
 * B. 底部栏搜索面板「从搜索按钮顺滑出现 / 顺滑收回」（延迟卸载壳）
 *    - 链路：StatusBar 搜索按钮（data-genie-anchor）→ useEditorStore.showSearch →
 *      EditorContainer 渲染 GenieSearchDialog → SearchReplaceDialog
 *    - 第三版定稿：验收反馈"尾巴特效观感偏怪" → **整体移除尾巴**，
 *      只保留窗口本体从按钮冒出 / 缩回按钮：
 *      · --genie-from-y   面板下沿对齐按钮上沿的位移（起点贴在按钮上）
 *      · --genie-origin-x 按钮中心相对面板左沿的位置（transform-origin 横向原点，
 *        面板朝按钮一侧收放 → "从按钮里冒出来"在视觉上成立）
 *    - 打开 0.48s easeOutCubic；收回 0.38s easeInCubic（先慢后快，像被吸回按钮）。
 *    - 面板同样不做 opacity 动画（避免淡入期间背景透出的闪动）。
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
 * 用于断言 GenieSearchDialog 的出现/收回几何变量注入。
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

// ═══ A. 需求6：新建文件夹/新建文件弹窗「打开过渡动画」 ═══

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

  it("表单重置走 useLayoutEffect（绘制前落定，动画途中不再改 DOM）", () => {
    const folderSrc = readSrc("../components/dialogs/NewFolderDialog.tsx");
    const fileSrc = readSrc("../components/dialogs/NewFileDialog.tsx");
    for (const src of [folderSrc, fileSrc]) {
      expect(src).toContain("useLayoutEffect");
      expect(src).not.toMatch(/import \{[^}]*\buseEffect\b/);
    }
  });
});

describe("v0.8.5 需求6+反馈：弹窗动画 CSS 源文本（背景透出闪动修复）", () => {
  it("NewFolderDialog.css 定义 overlay 淡入与本体 pop-in keyframes", () => {
    const fade = extractKeyframes(dialogCss, "dialog-overlay-fade-in");
    expect(fade).toContain("opacity: 0");
    expect(fade).toContain("opacity: 1");

    const pop = extractKeyframes(dialogCss, "dialog-pop-in");
    // 本体：轻微上移 + 缩放 → 原位
    expect(pop).toContain("translateY(12px)");
    expect(pop).toContain("scale(0.96)");
  });

  it("★核心防回退：弹窗本体动画不含 opacity（背景永不可能透过弹窗闪动）", () => {
    const pop = extractKeyframes(dialogCss, "dialog-pop-in");
    expect(pop).not.toContain("opacity");
    // pop-in 规则本身也不得引入 opacity / filter 之类会让背景透出的属性
    const popRule = extractRule(dialogCss, ".dialog-pop-in {");
    expect(popRule).not.toContain("opacity");
    expect(popRule).not.toContain("filter");
  });

  it("弹窗从第一帧起就是不透明实体（否则「背景透出」的根因又回来了）", () => {
    const dialogRule = extractRule(dialogCss, ".newfolder-dialog {");
    expect(dialogRule).toContain("background: var(--bg-primary)");
  });

  it("遮罩淡入挂在 overlay 的 ::before 独立层（与弹窗透明度解耦）", () => {
    const mask = extractRule(dialogCss, ".dialog-overlay-in::before");
    expect(mask).toContain("content:");
    // 半透明遮罩视觉不回退（遮罩背景由伪元素承载）
    expect(mask).toContain("background: rgba(0, 0, 0, 0.35)");
    // 合成层提升：遮罩仅 opacity 动画 + will-change
    expect(mask).toContain("animation: dialog-overlay-fade-in 0.15s ease-out both");
    expect(mask).toContain("will-change: opacity");
    // overlay 容器自身不再有 animation（透明度不再叠加到弹窗）
    const overlayRule = extractRule(dialogCss, ".newfolder-overlay {");
    expect(overlayRule).not.toContain("animation");
  });

  it("弹窗动画绑定时长且带 will-change 合成层提升（挂载即播放）", () => {
    const popRule = extractRule(dialogCss, ".dialog-pop-in {");
    expect(popRule).toContain("animation: dialog-pop-in 0.18s cubic-bezier(0.16, 1, 0.3, 1) both");
    expect(popRule).toContain("will-change: transform");
  });

  it("弹窗动画规则块不含 backdrop-filter / box-shadow 参与（掉帧嫌疑排除）", () => {
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

// ═══ B. 需求7+反馈：搜索面板「从按钮冒出 / 缩回按钮」动画 ═══

describe("v0.8.5 需求7+反馈：搜索面板出现/收回动画（延迟卸载壳）", () => {
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

  /** 推进壳内双层 rAF（面板初始定位完成 → 几何测量 → 挂 in 类） */
  function flushGenieMeasure() {
    act(() => {
      vi.advanceTimersByTime(10);
    });
  }

  it("初始未打开时不渲染面板壳（与原条件渲染行为一致）", () => {
    const { container } = render(createElement(GenieHarness));
    expect(container.querySelector('[data-testid="search-genie"]')).toBeNull();
  });

  it("点击底栏搜索按钮打开：测量完成前为 pending，测量后进入 search-genie-in", () => {
    const { container } = render(createElement(GenieHarness));
    const btn = clickSearchButton();
    // 按钮进入激活态
    expect(btn.className).toContain("active");
    expect(useEditorStore.getState().showSearch).toBe(true);
    const shell = container.querySelector('[data-testid="search-genie"]') as HTMLElement;
    expect(shell).toBeTruthy();
    // 几何变量注入前先藏住面板，避免动画首帧读到空变量而跳一下
    expect(shell.className).toContain("search-genie-pending");
    expect(shell.querySelector(".search-replace")).toBeTruthy();
    flushGenieMeasure();
    expect(shell.className).toContain("search-genie-in");
    expect(shell.className).not.toContain("search-genie-pending");
  });

  it("第三版定稿：壳内只有搜索面板，没有任何尾巴元素", () => {
    const { container } = render(createElement(GenieHarness));
    clickSearchButton();
    flushGenieMeasure();
    const shell = container.querySelector('[data-testid="search-genie"]') as HTMLElement;
    // 只有面板一个子节点（旧版的丝带/橡皮尾结构已彻底移除）
    expect(shell.children.length).toBe(1);
    expect(shell.firstElementChild?.className).toContain("search-replace");
    expect(shell.querySelector(".search-genie-tail")).toBeNull();
    expect(shell.querySelector(".search-genie-tail-clip")).toBeNull();
    expect(shell.querySelector(".search-genie-ribbon")).toBeNull();
    expect(shell.querySelector("svg")).toBeNull();
  });

  it("StatusBar 搜索按钮带 data-genie-anchor 锚点（出现/收回动画的几何依据）", () => {
    render(createElement(GenieHarness));
    expect(document.querySelector("[data-genie-anchor]")).toBeTruthy();
  });

  it("面板挂载后测量按钮/面板位置并注入出现·收回几何变量", () => {
    // 按钮 720..780 / 上沿 760；面板 300..760 × 120..200（下沿 200）
    const spy = mockGenieRects(
      { left: 720, top: 760, width: 60, height: 24 },
      { left: 300, top: 120, width: 460, height: 80 },
    );
    const { container } = render(createElement(GenieHarness));
    clickSearchButton();
    const shell = container.querySelector('[data-testid="search-genie"]') as HTMLElement;
    flushGenieMeasure();
    // 面板下沿对齐按钮上沿：760 − 200 = 560
    expect(shell.style.getPropertyValue("--genie-from-y")).toBe("560px");
    // 按钮中心 750 相对面板左沿 300 → 450（横向收放原点指向按钮）
    expect(shell.style.getPropertyValue("--genie-origin-x")).toBe("450px");
    spy.mockRestore();
  });

  it("窗口被拖到左侧时：横向收放原点随按钮位置变化（不是固定原点）", () => {
    const spy = mockGenieRects(
      { left: 720, top: 760, width: 60, height: 24 },
      { left: 60, top: 120, width: 460, height: 80 },
    );
    const { container } = render(createElement(GenieHarness));
    clickSearchButton();
    const shell = container.querySelector('[data-testid="search-genie"]') as HTMLElement;
    flushGenieMeasure();
    // 面板挪到左边后，按钮中心相对面板左沿变成 750 − 60 = 690
    expect(shell.style.getPropertyValue("--genie-origin-x")).toBe("690px");
    // 纵向位移仍按"面板下沿→按钮上沿"计算
    expect(shell.style.getPropertyValue("--genie-from-y")).toBe("560px");
    spy.mockRestore();
  });

  it("面板已被拖到贴着底栏时：位移夹到 0（原地收放，不会反向下坠）", () => {
    const spy = mockGenieRects(
      { left: 720, top: 760, width: 60, height: 24 },
      { left: 300, top: 700, width: 460, height: 80 },
    );
    const { container } = render(createElement(GenieHarness));
    clickSearchButton();
    const shell = container.querySelector('[data-testid="search-genie"]') as HTMLElement;
    flushGenieMeasure();
    expect(shell.style.getPropertyValue("--genie-from-y")).toBe("0px");
    spy.mockRestore();
  });

  it("底栏锚点不可见时兜底：用常规上升动画，面板照常显示（fail-open）", () => {
    const spy = mockGenieRects(
      { left: 0, top: 0, width: 0, height: 0 },
      { left: 300, top: 120, width: 460, height: 80 },
    );
    const { container } = render(createElement(GenieHarness));
    clickSearchButton();
    const shell = container.querySelector('[data-testid="search-genie"]') as HTMLElement;
    flushGenieMeasure();
    // 面板照常显示（不因测量失败而永远 pending）
    expect(shell.className).toContain("search-genie-in");
    expect(shell.style.getPropertyValue("--genie-from-y")).toBe("200px");
    expect(shell.style.getPropertyValue("--genie-origin-x")).toBe("50%");
    spy.mockRestore();
  });

  it("再次点击收回：壳切 search-genie-out，面板延迟卸载（收回动画期间仍在 DOM）", () => {
    const { container } = render(createElement(GenieHarness));
    clickSearchButton();
    flushGenieMeasure();
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

    // 收回动画 380ms 播完后真正卸载（GENIE_OUT_MS=440）
    act(() => {
      vi.advanceTimersByTime(440);
    });
    expect(container.querySelector('[data-testid="search-genie"]')).toBeNull();
  });

  it("收回中途再次呼出：定时器被取消，面板回到 in 态不卸载", () => {
    const { container } = render(createElement(GenieHarness));
    clickSearchButton();
    flushGenieMeasure();
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
      vi.advanceTimersByTime(600);
    });
    expect(container.querySelector('[data-testid="search-genie"]')).toBeTruthy();
    expect(useEditorStore.getState().showSearch).toBe(true);
  });

  it("onClose（面板关闭按钮路径）同样走收回动画后卸载", () => {
    const { container } = render(createElement(GenieHarness));
    clickSearchButton();
    flushGenieMeasure();
    // 模拟 SearchReplaceDialog 内部 onClose（Escape / 关闭按钮都走 store）
    act(() => {
      useEditorStore.getState().setShowSearch(false);
    });
    const shell = container.querySelector('[data-testid="search-genie"]') as HTMLElement;
    expect(shell.className).toContain("search-genie-out");
    act(() => {
      vi.advanceTimersByTime(440);
    });
    expect(container.querySelector('[data-testid="search-genie"]')).toBeNull();
  });
});

describe("v0.8.5 需求7+反馈：出现/收回动画 CSS 源文本", () => {
  it("只定义面板的出现/收回两组 keyframes（尾巴相关关键帧已全部删除）", () => {
    for (const name of ["search-genie-panel-in", "search-genie-panel-out"]) {
      expect(searchCss.indexOf(`@keyframes ${name}`)).toBeGreaterThanOrEqual(0);
    }
    for (const gone of [
      "search-genie-tail-follow-in",
      "search-genie-tail-absorb",
      "search-genie-tail-drip",
      "search-genie-tail-follow-out",
    ]) {
      expect(searchCss.indexOf(`@keyframes ${gone}`), `${gone} 应已删除`).toBe(-1);
    }
  });

  it("尾巴相关样式（丝带/橡皮尾/裁剪窗）已彻底移除", () => {
    for (const gone of [
      ".search-genie-ribbon",
      ".search-genie-tail",
      ".search-genie-tail-clip",
      ".search-genie-tail-shape",
    ]) {
      expect(searchCss.indexOf(gone), `${gone} 应已删除`).toBe(-1);
    }
    // 也不再有发光光带样式
    expect(searchCss).not.toContain("box-shadow: 0 0 8px");
  });

  it("打开：面板从「贴在按钮上」的压扁态顺滑长回自身位置与尺寸", () => {
    const block = extractKeyframes(searchCss, "search-genie-panel-in");
    // 起点：位移由 --genie-from-y 驱动（面板下沿对齐按钮上沿）+ 压扁 + 朝按钮收拢
    expect(block).toContain("translateY(var(--genie-from-y");
    expect(block).toContain("scale(0.5, 0.25)");
    // 终点：回到自身位置与尺寸
    expect(block).toContain("translateY(0) scale(1, 1)");
    // 不做淡入（否则又会"背景透过面板闪动"）
    expect(block).not.toContain("opacity");
  });

  it("收回：原路压扁着缩回按钮（位移 + 收拢 + 压扁，先慢后快）", () => {
    const block = extractKeyframes(searchCss, "search-genie-panel-out");
    expect(block).toContain("translateY(var(--genie-from-y");
    expect(block).toContain("scale(0.4, 0.06)");
    expect(searchCss).toMatch(
      /\.search-genie-out > \.search-replace\s*\{[^}]*animation:\s*search-genie-panel-out\s+0\.38s\s+cubic-bezier\(0\.32, 0, 0\.67, 0\)\s+both/,
    );
    // 收回立即开始（没有"先等尾巴垂落"的延迟）
    expect(searchCss).not.toMatch(/search-genie-panel-out\s+0\.38s[^;]*\d+\.\d+s/);
  });

  it("transform-origin 横向取实测的按钮位置（窗口位置不同，收放方向也不同）", () => {
    const inRule = extractRule(searchCss, ".search-genie-in > .search-replace {");
    const outRule = extractRule(searchCss, ".search-genie-out > .search-replace {");
    for (const rule of [inRule, outRule]) {
      expect(rule).toContain("transform-origin: var(--genie-origin-x");
      expect(rule).toContain("100%");
    }
  });

  it("打开/收回时长绑定：0.48s / 0.38s，卸载定时 440ms 覆盖收回动画", () => {
    expect(searchCss).toMatch(
      /\.search-genie-in > \.search-replace\s*\{[^}]*animation:\s*search-genie-panel-in\s+0\.48s\s+cubic-bezier\(0\.33, 1, 0\.68, 1\)\s+both/,
    );
    const src = readSrc("../components/editor/SearchReplace.tsx");
    expect(src).toContain("GENIE_OUT_MS = 440");
    // 几何变量只有两个：位移起点 + 横向原点；尾巴相关的变量名不应再出现
    expect(src).toContain("--genie-from-y");
    expect(src).toContain("--genie-origin-x");
    for (const gone of ["--genie-len", "--genie-rot", "--genie-anchor-y", "GENIE_TAIL_PATH", "preserveAspectRatio"]) {
      expect(src.indexOf(gone), `${gone} 应已删除`).toBe(-1);
    }
  });

  it("待命态藏住面板（避免动画首帧读到未注入变量而跳一下）", () => {
    const pending = extractRule(searchCss, ".search-genie-pending > .search-replace {");
    expect(pending).toContain("opacity: 0");
  });

  it("收回期间禁交互（pointer-events: none）", () => {
    const block = extractRule(searchCss, ".search-genie-out > .search-replace {");
    expect(block).toContain("pointer-events: none");
  });

  it("出现/收回动画含 prefers-reduced-motion 降级（面板直接显隐）", () => {
    const m = searchCss.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(m).toBeGreaterThanOrEqual(0);
    const block = searchCss.slice(m);
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
