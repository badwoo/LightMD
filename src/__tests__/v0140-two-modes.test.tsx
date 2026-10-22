/**
 * v0.14.0 需求1 回归测试：三模式合并为二模式 + 编辑模式内的预览面板
 *
 * 用户需求（原文）：
 * 「原来3模式改为2模式，编辑模式和分屏模式合并，具体做法为菜单入口只留阅读和编辑两个模式，
 *  点击编辑模式默认进入的是原来的分屏模式，保留双击shift键切换，鼠标移动到右屏时在中间的
 *  分割线会隐约出现一列呼吸律动的灰色竖排小字"关闭预览"，点击"关闭预览"右屏会顺滑的往右
 *  滑到语法辅助栏左侧，此时"关闭预览"文字变成"打开预览"，点击则右屏顺滑从右往左滑出，
 *  恢复分屏的样子。」
 *
 * 覆盖：
 * 1. store：ViewMode 只剩 preview/edit；splitPreviewOpen 默认 true；setViewMode 不改开关；
 * 2. TitleBar：模式按钮组只剩「阅读 / 编辑」，点「编辑」会打开预览面板；
 * 3. EditorContainer：编辑模式下预览面板 + 分割条 + 竖排文字存在且文案随开关切换；
 * 4. 点竖排文字 → 预览关闭（外壳宽度 0、文案变「打开预览」），再点 → 恢复；
 * 5. 阅读模式下不渲染分割条/预览外壳；
 * 6. CSS 契约：竖排（writing-mode）、呼吸动画、宽度过渡（滑出/滑回）。
 *
 * ⚠️ 为什么要有第 6 条源码级断言：jsdom 不算 CSS，`writing-mode: vertical-rl`、
 * 动画 keyframes、width transition 这些"观感类"约定无法用 DOM 断言，
 * 但它们正是用户肉眼验收的点（竖排 + 呼吸 + 顺滑滑动），必须锁住。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { useEditorStore } from "../stores/useEditorStore";
import { EditorContainer } from "../components/editor/EditorContainer";
import type { ViewMode } from "../stores/useEditorStore";

// TitleBar 会渲染 WindowControls（无边框窗口自绘三键），它直接调 Tauri 的
// getCurrentWindow()；jsdom 没有该运行时 → 必须 mock，否则整组标题栏用例挂掉。
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize: async () => {},
    toggleMaximize: async () => {},
    close: async () => {},
    isMaximized: async () => false,
    onResized: async () => () => {},
    label: "main",
  }),
}));

// TitleBar 放在 mock 之后动态 import，保证拿到桩模块
const { TitleBar } = await import("../components/layout/TitleBar");

const readSrc = (p: string) => readFileSync(`src/${p}`, "utf-8");

/** Tauri 运行时桩（EditorContainer 内多处 isTauri 分支） */
function installTauriStub() {
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    metadata: { currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async () => 0,
    unregisterListener: async () => {},
    convertFileSrc: (p: string) => `asset://localhost/${p}`,
    plugins: {},
  };
}
function removeTauriStub() {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

const DOC = "# 标题\n\n正文内容。\n";

function mountEditor(viewMode: ViewMode, splitPreviewOpen = true) {
  act(() => {
    useEditorStore.setState({ viewMode, splitPreviewOpen });
  });
  return render(
    <EditorContainer content={DOC} filePath="D:/tmp/a.md" forceUpdateKey={1} />,
  );
}

beforeEach(() => {
  localStorage.clear();
  installTauriStub();
  act(() => {
    useEditorStore.setState({ viewMode: "preview", splitPreviewOpen: true });
  });
});

afterEach(() => {
  cleanup();
  removeTauriStub();
});

// ─── 1. store 语义 ────────────────────────────────────────

describe("v0.14.0 需求1：ViewMode 与预览开关", () => {
  it("ViewMode 只有 preview / edit（类型层约束，运行时表现为不再接受 split）", () => {
    const src = readSrc("stores/useEditorStore.ts");
    expect(src).toContain('export type ViewMode = "preview" | "edit";');
    expect(src).not.toContain('export type ViewMode = "preview" | "edit" | "split";');
  });

  it("splitPreviewOpen 默认 true（点编辑默认就是旧分屏）", () => {
    // store 初值在模块加载时已定，直接查源码常量（避免受本文件已 setState 影响）
    const src = readSrc("stores/useEditorStore.ts");
    expect(src).toMatch(/splitPreviewOpen:\s*true/);
  });

  it("setViewMode 不改预览开关（关掉预览后切阅读再切回编辑仍记得）", () => {
    act(() => {
      useEditorStore.getState().setSplitPreviewOpen(false);
      useEditorStore.getState().setViewMode("preview");
      useEditorStore.getState().setViewMode("edit");
    });
    expect(useEditorStore.getState().splitPreviewOpen).toBe(false);
    expect(useEditorStore.getState().viewMode).toBe("edit");
  });

  it("toggleSplitPreview 只翻转开关，不动 viewMode", () => {
    act(() => {
      useEditorStore.setState({ viewMode: "edit", splitPreviewOpen: true });
    });
    act(() => useEditorStore.getState().toggleSplitPreview());
    expect(useEditorStore.getState().splitPreviewOpen).toBe(false);
    expect(useEditorStore.getState().viewMode).toBe("edit");
    act(() => useEditorStore.getState().toggleSplitPreview());
    expect(useEditorStore.getState().splitPreviewOpen).toBe(true);
  });
});

// ─── 2. TitleBar：只有两个模式入口 ────────────────────────

describe("v0.14.0 需求1：标题栏只剩「阅读 / 编辑」", () => {
  it("模式按钮组恰好两个按钮，文案为 阅读 / 编辑", () => {
    render(<TitleBar fileName="a.md" />);
    const group = document.querySelector(".titlebar-mode-switch")!;
    const buttons = Array.from(group.querySelectorAll("button"));
    expect(buttons).toHaveLength(2);
    expect(buttons.map((b) => b.textContent)).toEqual(["阅读", "编辑"]);
  });

  it("不再有「分屏」按钮（第三格已删除）", () => {
    render(<TitleBar fileName="a.md" />);
    const group = document.querySelector(".titlebar-mode-switch")!;
    const labels = Array.from(group.querySelectorAll("button")).map((b) => b.textContent);
    expect(labels).not.toContain("分屏");
  });

  it("点「编辑」→ viewMode=edit 且预览打开；点「阅读」→ viewMode=preview", () => {
    render(<TitleBar fileName="a.md" />);
    const group = document.querySelector(".titlebar-mode-switch")!;
    const [readBtn, editBtn] = Array.from(group.querySelectorAll("button"));

    // 先人为关掉预览，验证「点编辑」会重新打开（用户口径：点编辑默认进分屏）
    act(() => useEditorStore.getState().setSplitPreviewOpen(false));
    fireEvent.click(editBtn);
    expect(useEditorStore.getState().viewMode).toBe("edit");
    expect(useEditorStore.getState().splitPreviewOpen).toBe(true);

    fireEvent.click(readBtn);
    expect(useEditorStore.getState().viewMode).toBe("preview");
    // 切阅读不改变开关状态（下次进编辑还记得）
    expect(useEditorStore.getState().splitPreviewOpen).toBe(true);
  });

  it("当前模式按钮带 active 类", () => {
    act(() => useEditorStore.setState({ viewMode: "edit", splitPreviewOpen: true }));
    render(<TitleBar fileName="a.md" />);
    const group = document.querySelector(".titlebar-mode-switch")!;
    const [readBtn, editBtn] = Array.from(group.querySelectorAll("button"));
    expect(editBtn.className).toContain("active");
    expect(readBtn.className).not.toContain("active");
  });
});

// ─── 3/4. EditorContainer：预览面板与竖排开关 ──────────────

describe("v0.14.0 需求1：编辑模式的预览面板与竖排开关", () => {
  it("编辑模式 + 预览开：存在分割条、竖排按钮与预览外壳，文案「关闭预览」", () => {
    mountEditor("edit", true);
    const divider = document.querySelector(".split-divider");
    expect(divider).toBeTruthy();
    expect(divider!.className).toContain("split-divider-open");

    const label = screen.getByTestId("split-preview-toggle");
    expect(label.textContent).toBe("关闭预览");
    expect(label.getAttribute("aria-pressed")).toBe("true");

    const shell = document.querySelector(".split-preview-shell");
    expect(shell).toBeTruthy();
    expect(shell!.className).toContain("split-preview-open");
    // 展开时宽度按分割比例（默认 0.5 → calc(50% - 3px)）
    expect((shell as HTMLElement).style.width).toBe("calc(50% - 3px)");
  });

  it("点「关闭预览」→ 外壳收成 0 宽、文案变「打开预览」、模式仍是 edit", () => {
    mountEditor("edit", true);
    fireEvent.click(screen.getByTestId("split-preview-toggle"));

    const shell = document.querySelector(".split-preview-shell") as HTMLElement;
    expect(shell.style.width).toBe("0px");
    expect(shell.className).toContain("split-preview-closed");
    expect(shell.getAttribute("aria-hidden")).toBe("true");

    const label = screen.getByTestId("split-preview-toggle");
    expect(label.textContent).toBe("打开预览");
    expect(label.getAttribute("aria-pressed")).toBe("false");
    // 关闭预览不能把用户踢回阅读模式（只是腾宽度）
    expect(useEditorStore.getState().viewMode).toBe("edit");
    // 关闭态不可拖拽：分割条不应挂 mousedown 处理器（React 合成事件体现在没有 cursor）
    expect(document.querySelector(".split-divider")!.className).toContain("split-divider-closed");
  });

  it("再点「打开预览」→ 恢复分屏（宽度回到分割比例）", () => {
    mountEditor("edit", false);
    expect(screen.getByTestId("split-preview-toggle").textContent).toBe("打开预览");
    fireEvent.click(screen.getByTestId("split-preview-toggle"));

    const shell = document.querySelector(".split-preview-shell") as HTMLElement;
    expect(shell.style.width).toBe("calc(50% - 3px)");
    expect(screen.getByTestId("split-preview-toggle").textContent).toBe("关闭预览");
  });

  it("阅读模式：不渲染分割条与预览外壳", () => {
    mountEditor("preview", true);
    expect(document.querySelector(".split-divider")).toBeNull();
    expect(document.querySelector(".split-preview-shell")).toBeNull();
    expect(screen.queryByTestId("split-preview-toggle")).toBeNull();
  });

  it("编辑模式 + 预览关：iframe 仍在 DOM（滑出时内容现成，不空白）", () => {
    mountEditor("edit", false);
    const iframe = document.querySelector(".split-preview-shell iframe");
    expect(iframe).toBeTruthy();
    // 隐藏时也不卸载（aria-hidden 表达不可见）
    expect(document.querySelector(".split-preview-shell")!.getAttribute("aria-hidden")).toBe("true");
  });
});

// ─── 5. 双击 Shift / 命令面板入口 ─────────────────────────

describe("v0.14.0 需求1：双击 Shift 与命令入口", () => {
  it("App 的双击 Shift 分支改为「编辑模式内切换预览」（不再有 split 视图）", () => {
    const src = readSrc("App.tsx");
    expect(src).not.toContain('setViewMode("split")');
    // 阅读模式下双击 Shift 先进编辑并打开预览
    expect(src).toMatch(/if \(viewMode === "preview"\) \{\s*\n\s*useEditorStore\.getState\(\)\.setSplitPreviewOpen\(true\);\s*\n\s*setViewMode\("edit"\);/);
    // 已在编辑模式时走 toggleSplitPreview
    expect(src).toContain("toggleSplitPreview();");
  });

  it("命令面板：view.split 改为 view.togglePreview（总数不变）", () => {
    const src = readSrc("core/commands.ts");
    expect(src).not.toContain('id: "view.split"');
    expect(src).toContain('id: "view.togglePreview"');
    expect(src).toContain('titleKey: "command.view.togglePreview"');
  });

  it("App 的命令路由：view.togglePreview → toggleSplitPreview", () => {
    const src = readSrc("App.tsx");
    expect(src).toContain('if (id === "view.togglePreview") { toggleSplitPreview(); return; }');
  });
});

// ─── 6. CSS / i18n 契约 ───────────────────────────────────

describe("v0.14.0 需求1：竖排呼吸字与滑出动画的 CSS 契约", () => {
  const css = readSrc("styles/editor.css");

  it("竖排：writing-mode: vertical-rl + text-orientation: upright", () => {
    const block = css.match(/^\.split-divider-label\s*\{([^}]*)\}/m);
    expect(block).toBeTruthy();
    expect(block![1]).toContain("writing-mode: vertical-rl");
    expect(block![1]).toContain("text-orientation: upright");
  });

  it("呼吸律动：hover 显现时挂呼吸动画；默认不可见（「隐约」）", () => {
    expect(css).toContain("@keyframes splitDividerLabelBreathe");
    expect(css).toMatch(/animation:\s*splitDividerLabelBreathe/);
    const block = css.match(/^\.split-divider-label\s*\{([^}]*)\}/m);
    expect(block![1]).toMatch(/opacity:\s*0/);
  });

  it("鼠标移到右屏也要浮出（:has(.split-preview-shell:hover)）", () => {
    expect(css).toContain(".editor-main-area:has(.split-preview-shell:hover) .split-divider-label");
  });

  it("滑出/滑回：外壳有 width 过渡，拖拽期间禁用过渡", () => {
    const block = css.match(/\.split-preview-shell\s*\{([^}]*)\}/);
    expect(block).toBeTruthy();
    expect(block![1]).toMatch(/transition:\s*width/);
    expect(css).toContain("body.split-resizing .split-preview-shell");
  });

  it("i18n 双语文案齐备", () => {
    const zh = readSrc("i18n/locales/zh-CN.ts");
    const en = readSrc("i18n/locales/en-US.ts");
    expect(zh).toContain('"preview.toggle.close": "关闭预览"');
    expect(zh).toContain('"preview.toggle.open": "打开预览"');
    expect(en).toContain('"preview.toggle.close": "Close preview"');
    expect(en).toContain('"preview.toggle.open": "Open preview"');
    // 新增键必须成对存在
    for (const key of ["preview.toggle.close", "preview.toggle.open", "mode.switch.toEdit", "command.view.togglePreview"]) {
      expect(zh).toContain(`"${key}"`);
      expect(en).toContain(`"${key}"`);
    }
  });
});
