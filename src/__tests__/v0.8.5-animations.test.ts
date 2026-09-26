/**
 * v0.8.5 需求6+7 + 反馈（第二版）：纯视觉动画防回退测试
 *
 * A. NewFolderDialog / NewFileDialog 打开过渡动画（"动画期间背景杂乱闪动"修复）
 *    - 根因（用 Edge 逐帧定格复核）：弹窗本体动画里带 opacity 0→1，淡入前半程
 *      背后编辑器文字**透过弹窗**显形、且随 scale 逐帧位移 = 观感上的"背景杂乱闪动"；
 *      遮罩又从全透明起步，第一帧整屏全亮 → 一次全屏明暗跳变。
 *    - 修法：弹窗本体**完全不做 opacity 动画**（只做 transform），遮罩淡入留在
 *      overlay 的 ::before 独立层（纯色层透明度，代价极低）。
 *    - 配套：弹窗表单重置改用 useLayoutEffect（绘制前落定，动画途中不再改 DOM）。
 *
 * B. 底部栏搜索面板「神灯 / 橡皮尾」呼出·收回动画（延迟卸载壳）
 *    - 链路：StatusBar 搜索按钮（data-genie-anchor）→ useEditorStore.showSearch →
 *      EditorContainer 渲染 GenieSearchDialog → SearchReplaceDialog
 *    - 尾巴 .search-genie-tail：与面板同色同边、从按钮长出来的"被拉长的本体"，
 *      几何（长度/宽度/朝向/裁剪窗）由开合瞬间实测注入 → 随窗口位置变化。
 *    - 「永远连得住」的不变量：面板与尾巴共用同一段 translateY 关键帧
 *      （同 duration / 同 easing / 同延迟），面板 transform-origin 取 50% 100%。
 *    - 打开两拍：面板+尾巴被拉出来（0.52s）→ 尾巴被吸回本体（0.32s 起 0.2s）。
 *    - 关闭两拍：尾巴先垂落连到按钮（0.16s）→ 面板+尾巴一起被吸回底栏（0.3s）。
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
 * 用于断言 GenieSearchDialog 的尾巴几何变量注入。
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

// ═══ B. 需求7+反馈：底部栏搜索面板「神灯 / 橡皮尾」动画 ═══

describe("v0.8.5 需求7+反馈：搜索面板橡皮尾动画（延迟卸载壳）", () => {
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

  it("初始未打开时不渲染面板壳与尾巴（与原条件渲染行为一致）", () => {
    const { container } = render(createElement(GenieHarness));
    expect(container.querySelector('[data-testid="search-genie"]')).toBeNull();
    expect(container.querySelector(".search-genie-tail")).toBeNull();
  });

  it("点击底栏搜索按钮呼出：测量完成前为 pending，测量后进入 search-genie-in", () => {
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
    // 尾巴三段结构（裁剪窗 / 箱体 / 轮廓）随壳渲染
    expect(shell.querySelector(".search-genie-tail-clip")).toBeTruthy();
    expect(shell.querySelector(".search-genie-tail")).toBeTruthy();
    expect(shell.querySelector(".search-genie-tail-shape path")).toBeTruthy();
  });

  it("StatusBar 搜索按钮带 data-genie-anchor 锚点（尾巴定位依据）", () => {
    render(createElement(GenieHarness));
    expect(document.querySelector("[data-genie-anchor]")).toBeTruthy();
  });

  it("面板挂载后测量按钮/面板位置并注入尾巴几何变量（随窗口位置变化）", () => {
    // 按钮上沿中心 x=550 / y=760；面板 300..760 × 120..200（下沿 200）
    const spy = mockGenieRects(
      { left: 520, top: 760, width: 60, height: 24 },
      { left: 300, top: 120, width: 460, height: 80 },
    );
    const { container } = render(createElement(GenieHarness));
    clickSearchButton();
    const shell = container.querySelector('[data-testid="search-genie"]') as HTMLElement;
    flushGenieMeasure();
    expect(shell.style.getPropertyValue("--genie-x")).toBe("550px");
    // 按钮上沿 y：既是尾巴固定端，也是裁剪窗高度（尾巴不会盖住底栏）
    expect(shell.style.getPropertyValue("--genie-anchor-y")).toBe("760px");
    // 面板起始位移 = 按钮上沿 − 面板上沿
    expect(shell.style.getPropertyValue("--genie-from-y")).toBe("640px");
    // 尾巴长度 = 按钮到面板最近点距离(560) + 搭接量(18)
    expect(shell.style.getPropertyValue("--genie-len")).toBe("578px");
    expect(shell.style.getPropertyValue("--genie-w")).toBe("145px");
    // 面板正上方 → 尾巴竖直（0deg）
    expect(shell.style.getPropertyValue("--genie-rot")).toBe("0deg");
    spy.mockRestore();
  });

  it("窗口被拖到左侧时：尾巴朝向随之偏转、宽度变细（不是固定不变的尾巴）", () => {
    // 面板 60..520，按钮中心 550 在面板右外侧 → 挂接点被夹到面板下沿内侧
    const spy = mockGenieRects(
      { left: 520, top: 760, width: 60, height: 24 },
      { left: 60, top: 120, width: 460, height: 80 },
    );
    const { container } = render(createElement(GenieHarness));
    clickSearchButton();
    const shell = container.querySelector('[data-testid="search-genie"]') as HTMLElement;
    flushGenieMeasure();
    const rot = parseFloat(shell.style.getPropertyValue("--genie-rot"));
    expect(Math.abs(rot)).toBeGreaterThan(5); // 尾巴斜着连回按钮
    expect(parseFloat(shell.style.getPropertyValue("--genie-w"))).toBeGreaterThan(0);
    spy.mockRestore();
  });

  it("底栏锚点不可见时兜底：无尾巴但面板动画仍可用（fail-open）", () => {
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
    expect(shell.style.getPropertyValue("--genie-anchor-y")).toBe("0px");
    expect(shell.style.getPropertyValue("--genie-len")).toBe("0px");
    expect(shell.style.getPropertyValue("--genie-from-y")).toBe("200px");
    spy.mockRestore();
  });

  it("再次点击收回：壳切 search-genie-out，面板与尾巴延迟卸载", () => {
    const { container } = render(createElement(GenieHarness));
    clickSearchButton();
    flushGenieMeasure();
    let shell = container.querySelector('[data-testid="search-genie"]') as HTMLElement;
    expect(shell.className).toContain("search-genie-in");

    clickSearchButton();
    expect(useEditorStore.getState().showSearch).toBe(false);
    shell = container.querySelector('[data-testid="search-genie"]') as HTMLElement;
    // 进入收回态：out 类 + 面板/尾巴尚未卸载（延迟卸载，给收回动画留时间）
    expect(shell).toBeTruthy();
    expect(shell.className).toContain("search-genie-out");
    expect(shell.className).not.toContain("search-genie-in");
    expect(shell.querySelector(".search-replace")).toBeTruthy();
    expect(shell.querySelector(".search-genie-tail")).toBeTruthy();

    // 收回动画 460ms 播完后真正卸载（GENIE_OUT_MS=520）
    act(() => {
      vi.advanceTimersByTime(520);
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
      vi.advanceTimersByTime(520);
    });
    expect(container.querySelector('[data-testid="search-genie"]')).toBeNull();
  });
});

describe("v0.8.5 需求7+反馈：橡皮尾动画 CSS 源文本", () => {
  it("定义打开/关闭六组 keyframes（面板拉出·吸回 + 尾巴跟随·吸收·垂落）", () => {
    for (const name of [
      "search-genie-panel-in",
      "search-genie-tail-follow-in",
      "search-genie-tail-absorb",
      "search-genie-tail-drip",
      "search-genie-tail-follow-out",
      "search-genie-panel-out",
    ]) {
      expect(searchCss.indexOf(`@keyframes ${name}`)).toBeGreaterThanOrEqual(0);
    }
  });

  it("尾巴与面板同色同边（不是蓝色激光/发光丝带）", () => {
    const shape = extractRule(searchCss, ".search-genie-tail-shape path {");
    expect(shape).toContain("fill: var(--bg-primary)");
    expect(shape).toContain("stroke: var(--border-color)");
    // 旧实现的"发光光带"已彻底移除
    expect(searchCss).not.toContain(".search-genie-ribbon");
    expect(searchCss).not.toContain("box-shadow: 0 0 8px");
  });

  it("尾巴几何全部来自实测 CSS 变量（位置/长度/宽度/朝向 → 随窗口位置变化）", () => {
    const tail = extractRule(searchCss, ".search-genie-tail {");
    expect(tail).toContain("position: absolute");
    expect(tail).toContain("left: calc(var(--genie-x");
    expect(tail).toContain("top: calc(var(--genie-anchor-y");
    expect(tail).toContain("width: var(--genie-w");
    expect(tail).toContain("height: var(--genie-len");
    expect(tail).toContain("rotate(var(--genie-rot");
    // 固定端 = 按钮：旋转/缩放原点在箱体底端中心
    expect(tail).toContain("transform-origin: 50% 100%");
    expect(tail).toContain("pointer-events: none");
    expect(tail).toContain("will-change: transform");
  });

  it("裁剪窗只覆盖按钮上沿以上 + 层级低于面板（尾巴从底栏长出来、不盖底栏）", () => {
    const clip = extractRule(searchCss, ".search-genie-tail-clip {");
    expect(clip).toContain("position: fixed");
    expect(clip).toContain("height: var(--genie-anchor-y");
    expect(clip).toContain("overflow: hidden");
    expect(clip).toContain("pointer-events: none");
    expect(clip).toContain("z-index: 9999");
    expect(extractRule(searchCss, ".search-replace {")).toContain("z-index: 10000");
  });

  it("★核心不变量：面板与尾巴共用同一段位移关键帧（同 duration / 同 easing / 同延迟）", () => {
    // 打开：两者都是 0.52s + 同一条 cubic-bezier，无延迟
    expect(searchCss).toMatch(
      /\.search-genie-in > \.search-replace\s*\{[^}]*animation:\s*search-genie-panel-in\s+0\.52s\s+cubic-bezier\(0\.16, 1, 0\.3, 1\)\s+both/,
    );
    expect(searchCss).toMatch(
      /\.search-genie-in \.search-genie-tail\s*\{[^}]*animation:\s*search-genie-tail-follow-in\s+0\.52s\s+cubic-bezier\(0\.16, 1, 0\.3, 1\)\s+both/,
    );
    // 关闭：两者都是 0.3s + 0.16s 延迟 + 同一条 cubic-bezier
    expect(searchCss).toMatch(
      /\.search-genie-out > \.search-replace\s*\{[^}]*animation:\s*search-genie-panel-out\s+0\.3s\s+cubic-bezier\(0\.4, 0, 0\.7, 1\)\s+0\.16s\s+both/,
    );
    expect(searchCss).toMatch(
      /\.search-genie-out \.search-genie-tail\s*\{[^}]*animation:\s*search-genie-tail-follow-out\s+0\.3s\s+cubic-bezier\(0\.4, 0, 0\.7, 1\)\s+0\.16s\s+both/,
    );
    // 面板缩放原点在下沿中心：缩放不会挪动下沿 → 尾巴顶端不会脱开
    expect(extractRule(searchCss, ".search-genie-in > .search-replace {")).toContain(
      "transform-origin: 50% 100%",
    );
    expect(extractRule(searchCss, ".search-genie-out > .search-replace {")).toContain(
      "transform-origin: 50% 100%",
    );
  });

  it("打开编排：面板从按钮位置(var(--genie-from-y))纵向压扁着被拉出来（X 不缩放）", () => {
    const block = extractKeyframes(searchCss, "search-genie-panel-in");
    expect(block).toContain("var(--genie-from-y");
    expect(block).toContain("scale(1, 0.3)");
    expect(block).toContain("scale(1, 1)");
    // 打开阶段不得淡入（避免背景透过面板闪动）
    expect(block).not.toContain("opacity");
    // 不做 X 向缩放：面板下沿与尾巴顶端才能始终对齐
    expect(block).not.toMatch(/scale\(0\.\d+, 0\./);
  });

  it("打开第二拍：尾巴自面板一端被吸回本体后消失（scaleY 1→0 + 淡出）", () => {
    const block = extractKeyframes(searchCss, "search-genie-tail-absorb");
    expect(block).toContain("scaleY(1)");
    expect(block).toContain("scaleY(0)");
    expect(block).toContain("opacity: 0");
    // 轮廓自面板一端收缩 → 原点在箱体顶端
    expect(extractRule(searchCss, ".search-genie-tail-shape {")).toContain(
      "transform-origin: 50% 0%",
    );
    // 面板落定后才开始吸收（0.32s 延迟 + 0.2s 时长，落在 0.52s 打开编排之内）
    expect(searchCss).toMatch(
      /\.search-genie-in \.search-genie-tail-shape\s*\{[^}]*animation:\s*search-genie-tail-absorb\s+0\.2s[^}]*0\.32s\s+both/,
    );
  });

  it("关闭第一拍：尾巴先从面板垂落连到按钮（scaleY 0→1，0.16s）", () => {
    const block = extractKeyframes(searchCss, "search-genie-tail-drip");
    expect(block).toContain("scaleY(0)");
    expect(block).toContain("scaleY(1)");
    expect(block).toContain("opacity: 1");
    expect(searchCss).toMatch(
      /\.search-genie-out \.search-genie-tail-shape\s*\{[^}]*animation:\s*search-genie-tail-drip\s+0\.16s/,
    );
  });

  it("关闭第二拍：面板压扁着被吸回底栏（translateY 回 from-y + scale(1, 0.3)）", () => {
    const block = extractKeyframes(searchCss, "search-genie-panel-out");
    expect(block).toContain("var(--genie-from-y");
    expect(block).toContain("scale(1, 0.3)");
  });

  it("编排时长绑定：打开 0.52s / 收回 0.46s，卸载定时 520ms 覆盖收回动画", () => {
    expect(searchCss).toMatch(/search-genie-panel-in\s+0\.52s/);
    // 收回 = 0.16s 垂落 + 0.3s 吸回
    expect(searchCss).toMatch(/search-genie-panel-out\s+0\.3s[^;]*0\.16s/);
    const src = readSrc("../components/editor/SearchReplace.tsx");
    expect(src).toContain("GENIE_OUT_MS = 520");
    // 尾巴轮廓为内联 SVG（preserveAspectRatio=none → 拉长自然变细）
    expect(src).toContain('preserveAspectRatio="none"');
    expect(src).toContain("GENIE_TAIL_PATH");
  });

  it("收回期间禁交互（pointer-events: none）", () => {
    const block = extractRule(searchCss, ".search-genie-out > .search-replace {");
    expect(block).toContain("pointer-events: none");
  });

  it("神灯动画含 prefers-reduced-motion 降级（尾巴隐藏 + 面板直接显隐）", () => {
    const m = searchCss.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(m).toBeGreaterThanOrEqual(0);
    const block = searchCss.slice(m);
    expect(block).toContain(".search-genie-tail-clip");
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
