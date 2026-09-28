/**
 * v0.9.0 第三轮用户反馈（多窗口功能优化与修复）的回归用例。
 *
 * 覆盖：
 * 1. **需求1 打开的文件右键** —— 「打开的文件」条目右键菜单新增「在新窗口中打开」，
 *    与文件树右键走同一命令（filetree.openInNewWindow）。
 * 2. **需求2 标签拖出标签栏** —— fileDragMouse 新增「拖出源区域」分支；
 *    TabBar 所有标签（含未落盘临时标签）拖出 → onMoveToNewWindow。
 * 3. **需求2 窗口拖到主窗口标签栏** —— Rust 侧 merge_detect 几何检测由 cargo 单测
 *    覆盖；此处验证前端接线（mergeOffer 监听 → askChoice → 合并流程）与
 *    forgetWindowState IPC。
 * 4. **需求3 逐个关窗退出恢复** —— Rust 侧退出快照语义由 cargo 单测覆盖
 *    （window::tests::exit_snapshot_restores_windows_closed_before_the_last_one）；
 *    此处验证 finalize_session 的 live>0 守卫（防止覆盖退出快照的回归再次出现）。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi, beforeAll } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ─── mocks（必须在 import 业务模块之前）───────────────────────
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...(args as [])),
  Channel: class {},
}));

import { beginFileDrag } from "../utils/fileDragMouse";
import { TabBar } from "../components/layout/TabBar";
import { useEditorStore, type TabInfo } from "../stores/useEditorStore";
import { windowService } from "../services/windowService";
import { __setWindowLabelForTest } from "../utils/windowLabel";

const appSrc = readFileSync(resolve(__dirname, "../App.tsx"), "utf-8").replace(/\r\n/g, "\n");
const tabbarSrc = readFileSync(
  resolve(__dirname, "../components/layout/TabBar.tsx"),
  "utf-8",
).replace(/\r\n/g, "\n");
const filetreeSrc = readFileSync(
  resolve(__dirname, "../components/sidebar/FileTree.tsx"),
  "utf-8",
).replace(/\r\n/g, "\n");
const fileDragSrc = readFileSync(resolve(__dirname, "../utils/fileDragMouse.ts"), "utf-8").replace(
  /\r\n/g,
  "\n",
);
const zhLocaleSrc = readFileSync(resolve(__dirname, "../i18n/locales/zh-CN.ts"), "utf-8");
const enLocaleSrc = readFileSync(resolve(__dirname, "../i18n/locales/en-US.ts"), "utf-8");
const libRsSrc = readFileSync(resolve(__dirname, "../../src-tauri/src/lib.rs"), "utf-8");
const windowCmdsRsSrc = readFileSync(
  resolve(__dirname, "../../src-tauri/src/commands/window_cmds.rs"),
  "utf-8",
);

function enterTauri(label = "main") {
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    metadata: { currentWebview: { label } },
  };
}

function exitTauri() {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

// jsdom 无 ResizeObserver，TabBar 的滚动按钮显隐依赖它
beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  invokeMock.mockReset();
  __setWindowLabelForTest(null);
});

afterEach(() => {
  cleanup();
  useEditorStore.setState({ openTabs: [], activeTabIdx: 0 });
  exitTauri();
  vi.restoreAllMocks();
});

// ───────────────────────── 需求2：fileDragMouse 拖出源区域 ─────────────────────────

describe("需求2：fileDragMouse「拖出源区域」分支", () => {
  function makeFolderTarget(dir: string): HTMLElement {
    const el = document.createElement("div");
    el.setAttribute("data-drop-dir", dir);
    document.body.appendChild(el);
    return el;
  }

  function drag(
    handlers: Parameters<typeof beginFileDrag>[2],
    opts?: {
      hitTest?: (x: number, y: number) => Element | null;
      move?: { x: number; y: number };
      up?: { x: number; y: number };
    },
  ) {
    beginFileDrag(
      { path: "D:/docs/a.md", name: "a.md" },
      { clientX: 100, clientY: 10, button: 0 },
      handlers,
      opts?.hitTest,
    );
    fireEvent.mouseMove(document, {
      clientX: opts?.move?.x ?? 160,
      clientY: opts?.move?.y ?? 60,
    });
    fireEvent.mouseUp(document, {
      clientX: opts?.up?.x ?? 400,
      clientY: opts?.up?.y ?? 500,
    });
  }

  it("拖出源区域松手 → onDropOutsideSource 触发，onDrop 不触发", () => {
    const onDrop = vi.fn();
    const onDropOutside = vi.fn();
    drag({
      onDrop,
      isOutsideSourceArea: () => true,
      onDropOutsideSource: onDropOutside,
    });
    expect(onDropOutside).toHaveBeenCalledTimes(1);
    expect(onDropOutside.mock.calls[0][0]).toEqual({ path: "D:/docs/a.md", name: "a.md" });
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("源区域内松手（未命中文件夹）→ 两类回调都不触发（原语义不变）", () => {
    const onDrop = vi.fn();
    const onDropOutside = vi.fn();
    drag({
      onDrop,
      isOutsideSourceArea: () => false,
      onDropOutsideSource: onDropOutside,
    });
    expect(onDrop).not.toHaveBeenCalled();
    expect(onDropOutside).not.toHaveBeenCalled();
  });

  it("命中投放文件夹优先：即使已判定在源区域外，仍走 onDrop", () => {
    const target = makeFolderTarget("D:/target");
    const onDrop = vi.fn();
    const onDropOutside = vi.fn();
    drag(
      {
        onDrop,
        isOutsideSourceArea: () => true,
        onDropOutsideSource: onDropOutside,
      },
      { hitTest: () => target },
    );
    expect(onDrop).toHaveBeenCalledWith(
      { path: "D:/docs/a.md", name: "a.md" },
      "D:/target",
      "copy",
    );
    expect(onDropOutside).not.toHaveBeenCalled();
  });

  it("未提供 isOutsideSourceArea → 拖到任何位置都不触发 onDropOutsideSource（向后兼容）", () => {
    const onDrop = vi.fn();
    const onDropOutside = vi.fn();
    drag({ onDrop, onDropOutsideSource: onDropOutside });
    expect(onDrop).not.toHaveBeenCalled();
    expect(onDropOutside).not.toHaveBeenCalled();
    // FileTree（树节点/打开的文件条目）不传 outside 处理器，行为不变
    expect(fileDragSrc).toContain("handlers.isOutsideSourceArea?.(ev.clientX, ev.clientY)");
  });

  it("拖拽期间浮层跟随 outside 状态切换样式与提示文案", () => {
    let outside = false;
    beginFileDrag(
      { path: "D:/docs/a.md", name: "a.md" },
      { clientX: 100, clientY: 10, button: 0 },
      {
        onDrop: vi.fn(),
        isOutsideSourceArea: () => outside,
        outsideHint: "松开以移动到新窗口",
      },
    );
    // 移出阈值启动拖拽（outside=false）→ 浮层只有文件名
    fireEvent.mouseMove(document, { clientX: 160, clientY: 60 });
    const ghost = document.querySelector(".file-drag-ghost") as HTMLElement | null;
    expect(ghost).not.toBeNull();
    expect(ghost!.classList.contains("file-drag-ghost-outside")).toBe(false);
    expect(ghost!.textContent).toBe("a.md");
    // 移到源区域外 → 浮层加 outside 类 + 追加提示文案
    outside = true;
    fireEvent.mouseMove(document, { clientX: 300, clientY: 400 });
    expect(ghost!.classList.contains("file-drag-ghost-outside")).toBe(true);
    expect(ghost!.textContent).toBe("a.md · 松开以移动到新窗口");
    // 拖回源区域内 → 样式与文案还原
    outside = false;
    fireEvent.mouseMove(document, { clientX: 200, clientY: 100 });
    expect(ghost!.classList.contains("file-drag-ghost-outside")).toBe(false);
    expect(ghost!.textContent).toBe("a.md");
    fireEvent.mouseUp(document, { clientX: 200, clientY: 100 });
  });
});

// ───────────────────────── 需求2：TabBar 标签拖出 → 移动到新窗口 ─────────────────────────

describe("需求2：TabBar 标签拖出标签栏 → 移动到新窗口", () => {
  const TABS: TabInfo[] = [
    { path: "/a.md", name: "a.md", content: "A" },
    { path: "/b.md", name: "b.md", content: "B" },
  ];

  it("拖拽真实文件标签到标签栏外松手 → onMoveToNewWindow（带正确标签与下标）", () => {
    useEditorStore.setState({ openTabs: TABS, activeTabIdx: 0 });
    const onMove = vi.fn();
    const { container } = render(<TabBar onMoveToNewWindow={onMove} />);
    const item = container.querySelectorAll(".tab-item")[1] as HTMLElement; // b.md
    fireEvent.mouseDown(item, { button: 0, clientX: 100, clientY: 10 });
    fireEvent.mouseMove(document, { clientX: 200, clientY: 200 });
    fireEvent.mouseUp(document, { clientX: 400, clientY: 500 });
    expect(onMove).toHaveBeenCalledTimes(1);
    const [tab, idx] = onMove.mock.calls[0];
    expect(tab.name).toBe("b.md");
    expect(idx).toBe(1);
  });

  it("未落盘（untitled）标签也能拖出：拖到文件夹恒被拒（canDrop=false）", () => {
    const untitled: TabInfo = {
      path: "",
      name: "草稿",
      content: "X",
      isUntitled: true,
      id: "u-1",
    };
    useEditorStore.setState({ openTabs: [untitled], activeTabIdx: 0 });
    const onMove = vi.fn();
    const { container } = render(<TabBar onMoveToNewWindow={onMove} />);
    const item = container.querySelector(".tab-item") as HTMLElement;
    fireEvent.mouseDown(item, { button: 0, clientX: 100, clientY: 10 });
    fireEvent.mouseMove(document, { clientX: 300, clientY: 300 });
    fireEvent.mouseUp(document, { clientX: 400, clientY: 500 });
    expect(onMove).toHaveBeenCalledTimes(1);
    const [tab] = onMove.mock.calls[0];
    expect(tab.isUntitled).toBe(true);
    // 源码：临时标签 canDrop 恒 false（无磁盘路径，不能投放文件夹）
    expect(tabbarSrc).toContain("canDrop: isUntitled ? () => false : undefined");
  });

  it("拖回标签栏内松手 → 不触发移动（区域内取消，原语义）", () => {
    useEditorStore.setState({ openTabs: TABS, activeTabIdx: 0 });
    const onMove = vi.fn();
    // jsdom 的 getBoundingClientRect 全 0：stub 出一个覆盖拖拽点位的标签栏矩形
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 2000,
      bottom: 40,
      width: 2000,
      height: 40,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    const { container } = render(<TabBar onMoveToNewWindow={onMove} />);
    const item = container.querySelector(".tab-item") as HTMLElement;
    fireEvent.mouseDown(item, { button: 0, clientX: 100, clientY: 10 });
    fireEvent.mouseMove(document, { clientX: 150, clientY: 20 });
    fireEvent.mouseUp(document, { clientX: 150, clientY: 20 });
    expect(onMove).not.toHaveBeenCalled();
  });

  it("源码接线：TabBar 传入 outside 判定与提示文案", () => {
    expect(tabbarSrc).toContain("isOutsideSourceArea: isOutsideTabArea");
    expect(tabbarSrc).toContain('outsideHint: t("multiwindow.dragOutsideHint")');
    expect(tabbarSrc).toContain("onDropOutsideSource");
  });
});

// ───────────────────────── 需求3：合并除名 + mergeOffer 前端接线 ─────────────────────────

describe("需求2/3：forgetWindowState 与合并询问的前端接线", () => {
  it("windowService.forgetWindowState → invoke forget_window_state（Tauri 环境）", async () => {
    enterTauri("sec-1");
    await windowService.forgetWindowState();
    expect(invokeMock).toHaveBeenCalledWith("forget_window_state");
  });

  it("非 Tauri 环境 no-op（不抛错、不 invoke）", async () => {
    await windowService.forgetWindowState();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("合并流程在关闭自身前先除名（App.tsx 源码接线）", () => {
    const forget = appSrc.indexOf("await windowService.forgetWindowState();");
    const close = appSrc.indexOf(
      "await windowService.confirmClose().catch(() => undefined);\n  }, [askChoice, t]);",
    );
    expect(forget).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(forget);
  });

  it("mergeOffer 监听：按 target 过滤 → 空窗口跳过 → askChoice 确认后合并（源码接线）", () => {
    expect(appSrc).toContain('listen<unknown>("lightmd:mergeOffer"');
    expect(appSrc).toContain("if (useEditorStore.getState().openTabs.length === 0) return;");
    expect(appSrc).toContain('askChoice(\n          "mergeOffer",');
    expect(appSrc).toContain('if (choice !== "merge") return;');
    expect(appSrc).toContain("await handleMergeToPrimary();");
    // 对话框类型注册（标题 key）
    expect(appSrc).toContain("case \"mergeOffer\":");
  });

  it("Rust 侧：confirm_close 退出快照 + forget_window_state 命令（源码接线）", () => {
    expect(windowCmdsRsSrc).toContain(
      "mgr.snapshot_after_close(window_count_after == 0, window::now_ms())",
    );
    expect(windowCmdsRsSrc).toContain("pub fn forget_window_state");
  });

  it("Rust 侧：finalize_session 仅在仍有存活窗口时落盘（防覆盖退出快照的回归）", () => {
    expect(libRsSrc).toContain("if live > 0 {");
    expect(libRsSrc).toContain("window_cmds::persist_session(app, ever_multi, &snapshot);");
    expect(libRsSrc).toContain("merge_detect::note_window_moved");
  });
});

// ───────────────────────── 需求1：打开的文件右键「在新窗口中打开」 ─────────────────────────

describe("需求1：「打开的文件」右键菜单新增在新窗口中打开", () => {
  it("FileTree 源码：tempContextMenu 含该菜单项并派发 filetree.openInNewWindow", () => {
    expect(filetreeSrc).toContain('data-testid="temp-open-in-new-window"');
    expect(filetreeSrc).toContain(
      'detail: { id: "filetree.openInNewWindow", path: tempContextMenu.file.path }',
    );
    // 与文件树右键复用同一命令（App 侧已有处理器：新窗口打开文件，本窗口标签不动）
    expect(appSrc).toContain('detail?.id === "filetree.openInNewWindow"');
  });

  it("i18n：两语言均含拖拽提示与合并询问文案", () => {
    for (const src of [zhLocaleSrc, enLocaleSrc]) {
      expect(src).toContain('"multiwindow.dragOutsideHint"');
      expect(src).toContain('"multiwindow.mergeOffer.title"');
      expect(src).toContain('"multiwindow.mergeOffer.message"');
      expect(src).toContain('"multiwindow.mergeOffer.confirm"');
    }
  });
});
