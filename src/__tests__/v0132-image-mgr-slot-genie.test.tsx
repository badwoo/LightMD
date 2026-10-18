// @vitest-environment jsdom
/**
 * v0.13.2 需求4 + 需求6：图片管理图标的「补位」几何，以及弹窗的精灵（genie）开合动画。
 *
 * ## 需求4 用户原话
 * 「需求7 的图片管理图标位置继续优化……当打开不带图片文档时『译』图标要自动补上这个空缺
 *  位置，紧跟在切换分屏编辑图标下面。这个向上填补要有顺滑的平移动画……」
 *
 * ## 需求6 用户原话
 * 「需求10 的图片管理弹窗特效请改为类似底部栏搜索框的特效，点击图片管理图片，弹窗顺滑的
 *  从该按钮跑出来，关闭再顺滑跑回去。」
 *
 * ## 本文件的层次
 * 1. **JSX 注入的槽位变量**：`--ftb-slot` / `--imb-slot` —— 真实渲染组件读 inline style；
 * 2. **常驻挂载的可见性契约**：图片管理按钮不可见时仍在 DOM（否则 CSS 过渡没机会播），
 *    带 `is-hidden` / `data-visible=false` / `aria-hidden` / `tabIndex=-1`；
 * 3. **CSS 契约**（jsdom 不解析级联与 calc()，只能读源文本；注释里逐条说明原因）：
 *    槽位公式、top 过渡、`.is-hidden` 三件套、reduced-motion 覆盖；
 * 4. **GenieDialogShell 行为**：延迟卸载（300ms 内仍在 DOM 且带 out 类）、双 rAF 后
 *    pending → in、几何变量写入 inline style、关闭时重新测量、重新打开。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactElement } from "react";

import { ImageManagerButton } from "../components/editor/ImageManagerButton";
import { FullTranslateButton } from "../components/editor/FullTranslateButton";
import { GenieDialogShell, IMAGE_MGR_GENIE_OUT_MS } from "../components/dialogs/GenieDialogShell";

const SRC = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

/** 取 `selector { ... }` 规则体（避免注释里的同名文本干扰） */
function ruleBody(css: string, selector: string): string {
  const norm = css.replace(/\r\n/g, "\n");
  const at = norm.indexOf(`\n${selector} {`);
  if (at < 0) return "";
  const rest = norm.slice(at);
  const end = rest.indexOf("}");
  return end < 0 ? rest : rest.slice(0, end);
}

/** 取**包含指定片段**的那条规则体（同一选择器可能有多个规则块） */
function ruleOfSnippet(css: string, selector: string, snippet: string): string {
  const norm = css.replace(/\r\n/g, "\n");
  const at = norm.indexOf(snippet);
  if (at < 0) return "";
  const head = norm.lastIndexOf(`\n${selector} {`, at);
  if (head < 0) return "";
  const end = norm.indexOf("}", head);
  return end < 0 ? norm.slice(head) : norm.slice(head, end);
}

/** 取所有 `@media (prefers-reduced-motion: reduce) { ... }` 块（大括号配对） */
function reducedMotionBlocks(css: string): string[] {
  const norm = css.replace(/\r\n/g, "\n");
  const blocks: string[] = [];
  let from = 0;
  for (;;) {
    const head = norm.indexOf("@media (prefers-reduced-motion: reduce)", from);
    if (head < 0) break;
    const open = norm.indexOf("{", head);
    if (open < 0) break;
    let depth = 0;
    let end = norm.length - 1;
    for (let i = open; i < norm.length; i++) {
      if (norm[i] === "{") depth++;
      else if (norm[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    blocks.push(norm.slice(open, end + 1));
    from = end + 1;
  }
  return blocks;
}

// ───────────────────── 可手动驱动的 requestAnimationFrame ─────────────────────

let rafQueue: FrameRequestCallback[] = [];

/** 依次执行当前排队的 rAF 回调（双 rAF 需要调用两次） */
function flushRaf(times = 1) {
  for (let round = 0; round < times; round++) {
    const queue = rafQueue.splice(0);
    act(() => {
      for (const cb of queue) cb(performance.now());
    });
  }
}

beforeEach(() => {
  rafQueue = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

// ═══════════ 需求4：槽位与可见性（组件行为） ═══════════

describe("需求4 · 「译」的槽位由 JSX 注入（无图时上移补位）", () => {
  it("slot=0（文档无图片）→ .ftb-wrap 的 --ftb-slot 是 0", () => {
    const { container } = render(<FullTranslateButton onStart={() => {}} slot={0} />);
    const wrap = container.querySelector(".ftb-wrap") as HTMLElement;
    expect(wrap).toBeTruthy();
    expect(wrap.style.getPropertyValue("--ftb-slot")).toBe("0");
  });

  it("slot=1（文档有图片）→ --ftb-slot 是 1", () => {
    const { container } = render(<FullTranslateButton onStart={() => {}} slot={1} />);
    const wrap = container.querySelector(".ftb-wrap") as HTMLElement;
    expect(wrap.style.getPropertyValue("--ftb-slot")).toBe("1");
  });

  it("不传 slot 时默认 1（保持旧几何，不与模式切换按钮重叠）", () => {
    const { container } = render(<FullTranslateButton onStart={() => {}} />);
    const wrap = container.querySelector(".ftb-wrap") as HTMLElement;
    expect(wrap.style.getPropertyValue("--ftb-slot")).toBe("1");
  });

  it("图片管理按钮：slot 仍由 --imb-slot 注入（常量 1，不随翻译开关漂移）", () => {
    const { container } = render(<ImageManagerButton slot={1} onOpen={() => {}} />);
    const btn = container.querySelector('[data-testid="image-manager-btn"]') as HTMLElement;
    expect(btn.style.getPropertyValue("--imb-slot")).toBe("1");
  });
});

describe("需求4 · 图片管理按钮：不可见时仍常驻 DOM（过渡才有机会播放）", () => {
  it("visible=false → 仍在 DOM，带 is-hidden / data-visible=false / aria-hidden / tabIndex=-1", () => {
    const { container } = render(
      <ImageManagerButton slot={1} visible={false} onOpen={() => {}} />,
    );
    const btn = container.querySelector('[data-testid="image-manager-btn"]') as HTMLElement;
    // 关键：不是条件渲染（旧实现 `{cond && <Btn/>}` 会瞬间摘除，过渡不可能存在）
    expect(btn).toBeTruthy();
    expect(btn.classList.contains("image-manager-btn")).toBe(true);
    expect(btn.classList.contains("is-hidden")).toBe(true);
    expect(btn.getAttribute("data-visible")).toBe("false");
    expect(btn.getAttribute("aria-hidden")).toBe("true");
    expect(btn.tabIndex).toBe(-1);
  });

  it("visible=true（默认）→ 无 is-hidden、data-visible=true、可进入 Tab 序列", () => {
    const { container } = render(<ImageManagerButton slot={1} onOpen={() => {}} />);
    const btn = container.querySelector('[data-testid="image-manager-btn"]') as HTMLElement;
    expect(btn.classList.contains("is-hidden")).toBe(false);
    expect(btn.getAttribute("data-visible")).toBe("true");
    expect(btn.getAttribute("aria-hidden")).toBeNull();
    expect(btn.tabIndex).toBe(0);
  });

  it("visible 从 true 翻 false 是**同一个 DOM 节点**（淡出而非重建，class 原地切换）", () => {
    const utils = render(<ImageManagerButton slot={1} visible onOpen={() => {}} />);
    const before = utils.container.querySelector('[data-testid="image-manager-btn"]');
    utils.rerender(<ImageManagerButton slot={1} visible={false} onOpen={() => {}} />);
    const after = utils.container.querySelector('[data-testid="image-manager-btn"]');
    expect(after).toBe(before);
    expect((after as HTMLElement).classList.contains("is-hidden")).toBe(true);
  });
});

// ═══════════ 需求4：CSS 契约（jsdom 不解析级联/calc，只能读源） ═══════════

describe("需求4 · CSS 契约：槽位公式、平移过渡、淡出三件套、reduced-motion", () => {
  const css = () => SRC("components/editor/FullTranslateButton.css");

  it(".ftb-wrap 的 top 用 --ftb-slot 计算（不写死槽位，才能补位）", () => {
    const body = ruleOfSnippet(css(), ".ftb-wrap", "var(--ftb-slot, 1)");
    expect(body).toContain("top: calc(");
    expect(body).toContain("var(--float-icon-top)");
    expect(body).toContain("var(--ftb-slot, 1)");
    expect(body).toContain("var(--float-icon-size) + var(--float-icon-gap)");
    expect(body).not.toMatch(/top:\s*\d+px/);
  });

  it(".ftb-wrap 有 top 的平滑过渡（用户要求「顺滑的平移动画」）", () => {
    const body = ruleOfSnippet(css(), ".ftb-wrap", "var(--ftb-slot, 1)");
    expect(body).toMatch(/transition:\s*top\s+0\.22s\s+cubic-bezier\(/);
  });

  it(".image-manager-btn 的过渡覆盖 top / opacity / transform", () => {
    const body = ruleOfSnippet(css(), ".image-manager-btn", "var(--imb-slot, 1)");
    expect(body).toMatch(/transition:[^;]*opacity\s+0\.18s/);
    expect(body).toMatch(/transition:[^;]*top\s+0\.22s/);
    expect(body).toMatch(/transition:[^;]*transform\s+0\.18s/);
  });

  it(".is-hidden 三件套齐全：opacity 0 + pointer-events none + transform scale", () => {
    const body = ruleBody(css(), ".image-manager-btn.is-hidden");
    expect(body).toMatch(/opacity:\s*0\s*;/);
    expect(body).toContain("pointer-events: none");
    expect(body).toMatch(/transform:\s*scale\(0\.86\)/);
  });

  it("reduced-motion：图标平移/缩放动画被关掉（不强迫动效）", () => {
    // 两条独立的 @media 块：图标槽位（.ftb-wrap / .image-manager-btn）与弹窗动画。
    const blocks = reducedMotionBlocks(css());
    const all = blocks.join("\n");
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    expect(all).toContain(".ftb-wrap");
    expect(all).toMatch(/transition:\s*none/);
    expect(all).toContain(".image-manager-btn");
    expect(all).toContain(".image-manager-btn.is-hidden");
    expect(all).toContain("transform: none");
  });

  it("EditorContainer 的接线：无图 → 「译」slot 1 且图片管理 visible=false；有图 → 「译」slot 2", () => {
    // 需要完整 App + 编辑器上下文才能渲染这一段（EditorContainer 依赖 Tauri/iframe/
    // 预览渲染），因此按项目既有做法锁接线源码；组件的变量注入行为已在上方覆盖。
    const src = SRC("components/editor/EditorContainer.tsx");
    expect(src).toContain('data-genie-anchor="image-manager"');
    expect(src).toContain("visible={docHasImageFlag}");
    // v0.13.2 返修：模式切换 slot0 / 图片管理 slot1 /「译」无图 slot1、有图 slot2。
    // 旧值 `1 : 0` 会让「译」与图片管理或模式切换完全重合。
    expect(src).toContain("slot={docHasImageFlag ? 2 : 1}");
    expect(src).not.toContain("slot={docHasImageFlag ? 1 : 0}");
    // 图片管理入口自身固定 slot=1
    expect(src).toContain("slot={1}");
  });
});

// ═══════════ 需求6：genie 开合行为 ═══════════

/** 矩形桩（jsdom 不做布局，rect 恒为 0） */
function stubRect(
  el: Element,
  r: { left: number; top: number; width: number; height: number },
) {
  el.getBoundingClientRect = () =>
    ({
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
      right: r.left + r.width,
      bottom: r.top + r.height,
      x: r.left,
      y: r.top,
      toJSON: () => ({}),
    }) as DOMRect;
}

const ANCHOR_RECT = { left: 1200, top: 50, width: 34, height: 34 };

function Harness({ active, withAnchor = true }: { active: boolean; withAnchor?: boolean }): ReactElement {
  return (
    <div>
      {withAnchor && (
        <span data-genie-anchor="image-manager">
          <button type="button" data-testid="image-manager-btn">
            img
          </button>
        </span>
      )}
      <GenieDialogShell active={active}>
        <div className="image-mgr-dialog" data-testid="stub-panel">
          panel-content
        </div>
      </GenieDialogShell>
    </div>
  );
}

const shellOf = () => document.querySelector('[data-testid="image-mgr-genie"]') as HTMLElement | null;

describe("需求6 · GenieDialogShell：延迟卸载 + 双 rAF 入场", () => {
  it("active=false → 壳与面板都不渲染", () => {
    render(<Harness active={false} />);
    expect(shellOf()).toBeNull();
    expect(document.querySelector(".image-mgr-dialog")).toBeNull();
  });

  it("active=true 首帧是 pending（先藏面板防跳），双 rAF 后变 in", () => {
    render(<Harness active />);
    // 挂载后、rAF 未跑：几何变量还没注入
    expect(shellOf()).toBeTruthy();
    expect(shellOf()!.classList.contains("image-mgr-genie-pending")).toBe(true);
    expect(shellOf()!.classList.contains("image-mgr-genie-in")).toBe(false);

    flushRaf(1);
    // 只跑完第一帧（第二帧还在队列里）→ 仍是 pending
    expect(shellOf()!.classList.contains("image-mgr-genie-pending")).toBe(true);

    flushRaf(1);
    expect(shellOf()!.classList.contains("image-mgr-genie-in")).toBe(true);
    expect(shellOf()!.classList.contains("image-mgr-genie-pending")).toBe(false);
    // 面板内容确实渲染了
    expect(document.querySelector('[data-testid="stub-panel"]')).toBeTruthy();
  });

  it("关闭：300ms 之前内容仍在 DOM 且带 image-mgr-genie-out（退场动画来得及播）", () => {
    vi.useFakeTimers();
    const utils = render(<Harness active />);
    flushRaf(2);
    expect(shellOf()!.classList.contains("image-mgr-genie-in")).toBe(true);

    utils.rerender(<Harness active={false} />);
    // 立即：仍是 out 态，面板没有卸载
    expect(shellOf()).toBeTruthy();
    expect(shellOf()!.classList.contains("image-mgr-genie-out")).toBe(true);
    expect(shellOf()!.classList.contains("image-mgr-genie-in")).toBe(false);
    expect(document.querySelector(".image-mgr-dialog")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(IMAGE_MGR_GENIE_OUT_MS - 1);
    });
    expect(document.querySelector(".image-mgr-dialog")).toBeTruthy();
    expect(shellOf()).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(shellOf()).toBeNull();
    expect(document.querySelector(".image-mgr-dialog")).toBeNull();
  });

  it("关闭后重新打开 → 重新走 pending → in（状态被复位，不会卡在 out）", () => {
    vi.useFakeTimers();
    const utils = render(<Harness active />);
    flushRaf(2);
    utils.rerender(<Harness active={false} />);
    expect(shellOf()!.classList.contains("image-mgr-genie-out")).toBe(true);
    act(() => {
      vi.advanceTimersByTime(IMAGE_MGR_GENIE_OUT_MS);
    });
    expect(shellOf()).toBeNull();

    utils.rerender(<Harness active />);
    expect(shellOf()).toBeTruthy();
    expect(shellOf()!.classList.contains("image-mgr-genie-pending")).toBe(true);
    flushRaf(2);
    expect(shellOf()!.classList.contains("image-mgr-genie-in")).toBe(true);
  });
});

describe("需求6 · 几何变量：从按钮中心长出来 / 缩回按钮", () => {
  it("打开时按 anchor 与面板矩形写入 4 个变量（精确像素）", () => {
    render(<Harness active />);
    const anchor = document.querySelector('[data-testid="image-manager-btn"]')!;
    stubRect(anchor, ANCHOR_RECT);
    const panel = document.querySelector(".image-mgr-dialog")!;
    stubRect(panel, { left: 400, top: 100, width: 680, height: 500 });

    flushRaf(2);
    const style = shellOf()!.style;
    // 按钮中心 (1217, 67)；面板中心 (740, 350) → 位移 (477, -283)
    expect(style.getPropertyValue("--genie-from-x")).toBe("477px");
    expect(style.getPropertyValue("--genie-from-y")).toBe("-283px");
    // 按钮中心相对面板左上角 (1217-400, 67-100)
    expect(style.getPropertyValue("--genie-origin-x")).toBe("817px");
    expect(style.getPropertyValue("--genie-origin-y")).toBe("-33px");
  });

  it("关闭时重新测量（面板可能已被滚动/布局移动）→ 变量更新为当前位置", () => {
    const utils = render(<Harness active />);
    const anchor = document.querySelector('[data-testid="image-manager-btn"]')!;
    stubRect(anchor, ANCHOR_RECT);
    const panel = document.querySelector(".image-mgr-dialog")!;
    stubRect(panel, { left: 400, top: 100, width: 680, height: 500 });
    flushRaf(2);
    expect(shellOf()!.style.getPropertyValue("--genie-from-x")).toBe("477px");

    // 面板移动到 (300, 200)：按钮中心 (1217,67) − 面板中心 (640,450)
    stubRect(panel, { left: 300, top: 200, width: 680, height: 500 });
    act(() => {
      utils.rerender(<Harness active={false} />);
    });
    const style = shellOf()!.style;
    expect(style.getPropertyValue("--genie-from-x")).toBe("577px");
    expect(style.getPropertyValue("--genie-from-y")).toBe("-383px");
    expect(style.getPropertyValue("--genie-origin-x")).toBe("917px");
    expect(style.getPropertyValue("--genie-origin-y")).toBe("-133px");
  });

  it("量不到按钮（如无图片时按钮 is-hidden）→ 兜底为右上角方向，变量仍是合法值", () => {
    render(<Harness active withAnchor={false} />);
    flushRaf(2);
    const style = shellOf()!.style;
    const values = ["--genie-from-x", "--genie-from-y", "--genie-origin-x", "--genie-origin-y"].map(
      (k) => style.getPropertyValue(k),
    );
    for (const v of values) expect(v).not.toBe("");
    expect(style.getPropertyValue("--genie-from-x")).toBe("0px");
    expect(style.getPropertyValue("--genie-from-y")).toBe("-40px");
    expect(style.getPropertyValue("--genie-origin-x")).toBe("100%");
    expect(style.getPropertyValue("--genie-origin-y")).toBe("0%");
  });
});

// ═══════════ 需求6：CSS / 常量的时序对应（jsdom 观测不到动画时序） ═══════════

describe("需求6 · 时序与 keyframes 常量对齐", () => {
  it("GenieDialogShell 的退场阈值 440ms（与 0.38s 退场动画对齐，留 60ms 余量）", () => {
    expect(IMAGE_MGR_GENIE_OUT_MS).toBe(440);
  });

  it("ImageManagerDialog.css：genie 入场 0.48s / 退场 0.38s，遮罩为静态亮度", () => {
    // CSS 动画时长无法在 jsdom 里被观测（无渲染引擎），只能锁源文本。
    const css = SRC("components/dialogs/ImageManagerDialog.css");
    expect(css).toContain("@keyframes image-mgr-genie-in");
    expect(css).toContain("@keyframes image-mgr-genie-out");
    const inRule = ruleOfSnippet(
      css,
      ".image-mgr-genie-in .image-mgr-dialog",
      ".image-mgr-genie-in .image-mgr-dialog {",
    );
    expect(inRule).toMatch(/animation:\s*image-mgr-genie-in\s+0\.48s/);
    const outRule = ruleOfSnippet(
      css,
      ".image-mgr-genie-out .image-mgr-dialog",
      ".image-mgr-genie-out .image-mgr-dialog {",
    );
    expect(outRule).toMatch(/animation:\s*image-mgr-genie-out\s+0\.38s/);
    expect(outRule).toContain("pointer-events: none");
    // v0.13.2 返修：遮罩不再淡入（整屏半透明层 opacity 动画在 iframe 上方会闪）
    expect(css).not.toContain("image-mgr-scrim-in");
    expect(css).not.toContain("image-mgr-scrim-out");
    expect(IMAGE_MGR_GENIE_OUT_MS).toBeGreaterThan(380);
  });

  it("弹窗不再自持关闭延迟（退场由壳统一负责，避免 open=false 后无 DOM 可动画）", () => {
    const src = SRC("components/dialogs/ImageManagerDialog.tsx");
    expect(src).not.toContain("IMAGE_MGR_CLOSE_MS");
    // 关闭意图立即上抛
    expect(src).toContain("onClose();");
    // open=false 时不得再早退（否则壳的退场动画没有可动画的节点）。
    // 只匹配**可执行行**，注释里提到旧实现不算。
    expect(src).not.toMatch(/^\s*if \(!open\) return null;/m);
  });

  it("reduced-motion：genie 入场/退场动画关闭", () => {
    const css = SRC("components/dialogs/ImageManagerDialog.css");
    const all = reducedMotionBlocks(css).join("\n");
    expect(all).not.toBe("");
    expect(all).toContain(".image-mgr-genie-in .image-mgr-dialog");
    expect(all).toContain(".image-mgr-genie-out .image-mgr-dialog");
    expect(all).toMatch(/animation:\s*none/);
  });

  it("App 用 GenieDialogShell 包住 ImageManagerDialog（active=showImageManager）", () => {
    const src = SRC("App.tsx");
    expect(src).toContain("<GenieDialogShell active={showImageManager}>");
    const shellAt = src.indexOf("<GenieDialogShell active={showImageManager}>");
    const dialogAt = src.indexOf("<ImageManagerDialog", shellAt);
    expect(dialogAt).toBeGreaterThan(shellAt);
  });
});
