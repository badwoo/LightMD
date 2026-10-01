/**
 * v0.9.1 回归测试（6 项需求）
 *
 *   需求1 打开设置的快捷键 Ctrl+, 不生效
 *         → 根因在原生层（WebView2 浏览器加速键吞掉 Ctrl+,），前端匹配逻辑本身正确。
 *           本文件用「源码接线断言」锁住 Rust 侧修复（真实按键行为由实机 CDP 冒烟覆盖）。
 *   需求2 打开设置瞬间背景杂乱、不平滑
 *         → 与 v0.8.5 同源：遮罩挂在 overlay 本体上做 opacity，会把弹窗整棵子树
 *           "分组淡化"，背景透过弹窗显形。断言遮罩已移到 ::before 独立层。
 *   需求3 设置弹窗打开/关闭淡入淡出
 *         → 关闭必须走「closing 类 + 延迟卸载」，否则动画来不及播。
 *   需求4 自定义快捷键弹窗改为横向 3×3
 *         → 3 列 × 最多 3 张分类卡片，48 条全部一屏可见。
 *   需求5 快捷键弹窗以窗口横轴中线上下铺开 / 收缩
 *         → clip-path inset 关键帧 + 关闭延迟卸载。
 *   需求6 F11 沉浸式全屏
 *         → 大字「全屏模式」→ 淡出 → 全屏 + 收起上/左/右/下栏；F11 或 Esc 退出。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ─── Tauri 桩（照抄 v0.9.0-app-smoke 的成熟做法） ──────────────────────
const invokeMock = vi.fn(async (cmd: string): Promise<unknown> => {
  if (cmd === "take_window_boot") {
    return { label: "main", isPrimary: true, restore: false, fresh: false, files: [], movedTabs: [] };
  }
  if (cmd === "has_session") return false;
  if (cmd === "list_windows") return [];
  if (cmd === "query_file_open") return [];
  if (cmd === "get_window_session") return null;
  if (cmd === "restore_windows") return [];
  return undefined;
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...(args as [string])),
  Channel: class {
    onmessage: ((c: string) => void) | null = null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async () => () => {},
  emit: async () => {},
  once: async () => () => {},
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "main",
    minimize: async () => {},
    toggleMaximize: async () => {},
    close: async () => {},
    isMaximized: async () => false,
    isFullscreen: async () => false,
    setFullscreen: async () => {},
    onResized: async () => () => {},
  }),
}));
vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children?: unknown }) => children ?? null,
  PointerSensor: class {},
  useSensor: () => ({}),
  useSensors: () => [],
  closestCenter: () => [],
}));
vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children?: unknown }) => children ?? null,
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    transform: null,
    transition: null,
    isDragging: false,
  }),
  verticalListSortingStrategy: () => null,
}));
vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => undefined } },
}));

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (globalThis as unknown as { matchMedia: unknown }).matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
  (window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: unknown }).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => {},
  };
});

import App from "../App";
import { SettingsDialog } from "../components/dialogs/SettingsDialog";
import { ShortcutSettingsDialog } from "../components/dialogs/ShortcutSettingsDialog";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useEditorStore } from "../stores/useEditorStore";
import { __setWindowLabelForTest } from "../utils/windowLabel";

// ─── 源码读取工具 ───────────────────────────────────────────────────
const read = (rel: string) => readFileSync(join(__dirname, rel), "utf-8");
/** 截取选择器规则块（从选择器到配对大括号结束），用于"这条规则里不得再出现 X"断言 */
function rule(css: string, selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `应存在选择器 ${selector}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  return css.slice(start);
}

async function flushStartupMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, i < 4 ? 0 : 5));
  }
}

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockClear();
  useEditorStore.setState({ openTabs: [], activeTabIdx: 0, filePath: null, isDirty: false });
  useSettingsStore.setState({ shortcuts: {} });
  __setWindowLabelForTest(null);
});

afterEach(async () => {
  await flushStartupMicrotasks();
  cleanup();
  await flushStartupMicrotasks();
  __setWindowLabelForTest(null);
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════
describe("v0.9.1 需求1：Ctrl+, 打开设置（根因在输入法保留键）", () => {
  it("Rust 侧已关闭 WebView2 浏览器加速键（F11 等浏览器加速键交还页面）", () => {
    const winMod = read("../../src-tauri/src/window/mod.rs");
    expect(winMod).toContain("SetAreBrowserAcceleratorKeysEnabled(false)");
    expect(winMod).toContain("disable_browser_accelerator_keys");
    // 辅助窗口同样要处理
    expect(winMod).toContain("disable_browser_accelerator_keys(&window)");
    const lib = read("../../src-tauri/src/lib.rs");
    expect(lib).toContain("disable_browser_accelerator_keys");
    const cargo = read("../../src-tauri/Cargo.toml");
    expect(cargo).toContain("webview2-com");
    // windows-core 必须与 tauri-runtime-wry 同版（0.61），否则 COM 接口不互通
    expect(cargo).toContain('windows-core = "0.61"');
  });

  it("Rust 侧用 RegisterHotKey 回收 Ctrl+,（位于输入法之前，唯一稳定的一层）", () => {
    const hotkey = read("../../src-tauri/src/hotkey.rs");
    // 关键 API：注册系统热键（win32k 原始输入层，先于 TSF 保留键与所有用户态钩子）
    expect(hotkey).toContain("RegisterHotKey");
    expect(hotkey).toContain("UnregisterHotKey");
    expect(hotkey).toContain("VK_OEM_COMMA");
    expect(hotkey).toContain("MOD_CONTROL");
    // 线程亲和性：RegisterHotKey 要求窗口属于调用线程（跨线程会 0x80070580）
    expect(hotkey).toContain("WM_SYNC_HOTKEY");
    expect(hotkey).toContain("PostMessageW");
    // 只在本应用前台期间占用
    expect(hotkey).toContain("set_foreground");
    expect(hotkey).toContain("lightmd:accelerator");
    // 曾经的低级钩子方案已弃用（会被 Windows 静默摘掉 / 被输入法插队），只保留说明
    expect(hotkey).not.toContain("SetWindowsHookExW");
    expect(read("../../src-tauri/src/lib.rs")).toContain("hotkey::install");
    expect(read("../../src-tauri/src/lib.rs")).toContain("hotkey::set_foreground");
    expect(read("../../src-tauri/Cargo.toml")).toContain("Win32_UI_WindowsAndMessaging");
  });

  it("前端监听 lightmd:accelerator，且按当前生效键位复核后才打开设置", () => {
    const app = read("../App.tsx");
    expect(app).toContain('"lightmd:accelerator"');
    expect(app).toContain('getShortcutDef("view.settings")');
    expect(app).toContain('normalizeCombo("Ctrl+,")');
  });

  it("前端匹配逻辑保持正确：Ctrl+, → view.settings（未自定义时）", async () => {
    const { comboFromEvent, matchShortcut, setShortcutOverrides } = await import("../core/shortcuts");
    setShortcutOverrides({});
    const combo = comboFromEvent({
      key: ",",
      code: "Comma",
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
      metaKey: false,
    });
    expect(combo).toBe("Ctrl+,");
    const def = matchShortcut(
      { key: ",", code: "Comma", ctrlKey: true, altKey: false, shiftKey: false, metaKey: false },
      ["global", "editor"],
    );
    expect(def?.id).toBe("view.settings");
  });
});

// ═══════════════════════════════════════════════════════════════════
describe("v0.9.1 需求2：设置弹窗出现时背景不再杂乱", () => {
  const css = read("../components/dialogs/SettingsDialog.css");

  it("遮罩移出 overlay 本体，改挂 ::before 独立层（避免父级 opacity 分组淡化弹窗）", () => {
    const overlay = rule(css, ".settings-overlay {");
    expect(overlay).not.toContain("background: rgba(0, 0, 0, 0.4)");
    expect(overlay).not.toContain("animation: fadeIn");
    expect(css).toContain(".settings-overlay::before");
    const before = rule(css, ".settings-overlay::before {");
    expect(before).toContain("background: rgba(0, 0, 0, 0.4)");
    expect(before).toContain("animation: settings-scrim-in");
  });

  it("弹窗入场只做一次淡入 + 极小位移，且全部是合成层属性", () => {
    const dialog = rule(css, ".settings-dialog {");
    expect(dialog).toContain("animation: settings-dialog-in");
    const kf = rule(css, "@keyframes settings-dialog-in {");
    expect(kf).toContain("opacity");
    expect(kf).toContain("translateY(8px)");
    // 旧的 20px 位移（背景"在弹窗里走"的观感来源）已移除
    expect(kf).not.toContain("translateY(20px)");
  });

  it("快捷键弹窗渲染在设置弹窗**外部**（settings-dialog 的 transform 会成为 fixed 包含块）", () => {
    render(<SettingsDialog onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("shortcuts-entry"));
    const overlay = document.querySelector(".shortcut-settings-overlay");
    expect(overlay).toBeTruthy();
    expect(document.querySelector(".settings-dialog .shortcut-settings-overlay")).toBeNull();
    expect(document.querySelector(".settings-overlay > .shortcut-settings-overlay")).toBeTruthy();
  });

  it("slideUp 全局关键帧仍保留（其它 8 个弹窗在用）", () => {
    expect(css).toContain("@keyframes slideUp");
  });
});

// ═══════════════════════════════════════════════════════════════════
describe("v0.9.1 需求3：设置弹窗打开/关闭淡入淡出", () => {
  it("关闭先进入 closing（播放淡出），动画结束才真正 onClose", async () => {
    const onClose = vi.fn();
    render(<SettingsDialog onClose={onClose} />);
    const overlay = document.querySelector(".settings-overlay") as HTMLElement;
    expect(overlay.classList.contains("closing")).toBe(false);

    fireEvent.click(document.querySelector(".settings-close") as HTMLElement);
    expect(overlay.classList.contains("closing")).toBe(true);
    expect(onClose).not.toHaveBeenCalled(); // 动画还没放完

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("点击遮罩 / 取消按钮同样走延迟关闭；Esc 也能关闭", async () => {
    const onClose1 = vi.fn();
    render(<SettingsDialog onClose={onClose1} />);
    fireEvent.click(document.querySelector(".settings-overlay") as HTMLElement);
    expect(document.querySelector(".settings-overlay")!.classList.contains("closing")).toBe(true);
    await waitFor(() => expect(onClose1).toHaveBeenCalled());
    cleanup();

    const onClose2 = vi.fn();
    render(<SettingsDialog onClose={onClose2} />);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(onClose2).toHaveBeenCalled());
  });

  it("关闭动画关键帧与 JS 常量对齐（180ms）", () => {
    const css = read("../components/dialogs/SettingsDialog.css");
    expect(css).toContain("@keyframes settings-dialog-out");
    expect(rule(css, ".settings-overlay.closing .settings-dialog {")).toContain("settings-dialog-out 160ms");
    const src = read("../components/dialogs/SettingsDialog.tsx");
    expect(src).toContain("const SETTINGS_CLOSE_MS = 180");
    expect(src).toContain("setTimeout(() => {");
  });
});

// ═══════════════════════════════════════════════════════════════════
describe("v0.9.1 需求4：自定义快捷键弹窗横向 3×3 布局", () => {
  it("渲染 3 列、每列最多 3 张分类卡片、50 条全在其中(v0.9.3 E8 新增 2 条)", () => {
    render(<ShortcutSettingsDialog onClose={() => {}} />);
    const columns = [...document.querySelectorAll(".shortcut-settings-column")];
    expect(columns.length).toBe(3);
    for (const col of columns) {
      const cards = col.querySelectorAll(".shortcut-settings-group").length;
      expect(cards).toBeGreaterThan(0);
      expect(cards).toBeLessThanOrEqual(3);
    }
    expect(document.querySelectorAll(".shortcut-settings-row").length).toBe(50);
    expect(document.querySelectorAll(".shortcut-settings-group").length).toBe(7);
  });

  it("CSS：3 列网格 + 行高压缩（一屏放下 18 行）+ 小窗口降级", () => {
    const css = read("../components/dialogs/ShortcutSettingsDialog.css");
    const grid = rule(css, ".shortcut-settings-columns {");
    expect(grid).toContain("grid-template-columns: repeat(3, minmax(0, 1fr))");
    expect(css).toContain("@media (max-width: 1120px)");
    expect(css).toContain("@media (max-width: 760px)");
    expect(rule(css, ".shortcut-settings-dialog {")).toContain("width: min(1180px");
    expect(rule(css, ".shortcut-settings-row {")).toContain("min-height: 26px");
  });
});

// ═══════════════════════════════════════════════════════════════════
describe("v0.9.1 需求5：快捷键弹窗以横轴中线上下铺开 / 收缩", () => {
  const css = read("../components/dialogs/ShortcutSettingsDialog.css");

  it("开启：clip-path 从 50%/50% 向 0 铺开；关闭：反向收缩", () => {
    const open = rule(css, "@keyframes shortcut-open {");
    expect(open).toContain("clip-path: inset(50% 0 50% 0)");
    expect(open).toContain("clip-path: inset(0 0 0 0)");
    const close = rule(css, "@keyframes shortcut-close {");
    expect(close).toContain("clip-path: inset(0 0 0 0)");
    expect(close).toContain("clip-path: inset(50% 0 50% 0)");
    // 用 clip-path 而非 scaleY：内容不变形（注释里提到 scaleY 属正常，这里断言声明本身）
    expect(css).not.toMatch(/transform:\s*scaleY\(/);
    // 动画挂在 overlay 上（挂在弹窗上会把 box-shadow 一起裁掉）
    expect(rule(css, ".shortcut-settings-overlay {")).toContain("animation: shortcut-open");
    expect(rule(css, ".shortcut-settings-overlay.closing {")).toContain("shortcut-close");
    expect(rule(css, ".shortcut-settings-dialog {")).not.toContain("animation:");
  });

  it("遮罩同 v0.9.1 需求2 的处理方式（独立 ::before 层）", () => {
    expect(rule(css, ".shortcut-settings-overlay {")).not.toContain("background: rgba");
    expect(rule(css, ".shortcut-settings-overlay::before {")).toContain("background: rgba(0, 0, 0, 0.35)");
  });

  it("关闭走延迟卸载：先 closing，动画放完才 onClose；动画期间遮罩不再可点", async () => {
    const onClose = vi.fn();
    render(<ShortcutSettingsDialog onClose={onClose} />);
    const overlay = document.querySelector(".shortcut-settings-overlay") as HTMLElement;
    expect(overlay.classList.contains("closing")).toBe(false);

    fireEvent.click(screen.getByText("完成"));
    expect(overlay.classList.contains("closing")).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    // 关闭动画期间重复点击只触发一次卸载
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe("v0.9.1 需求6：F11 沉浸式全屏", () => {
  it("F11 → 大字「全屏模式」→ 淡出后全屏并收起四周面板；Esc 退出", async () => {
    render(<App />);
    const root = () => document.querySelector(".app") as HTMLElement;
    expect(root().classList.contains("app-immersive")).toBe(false);

    fireEvent.keyDown(window, { key: "F11" });
    const hint = document.querySelector('[data-testid="fullscreen-hint"]') as HTMLElement;
    expect(hint).toBeTruthy();
    expect(hint.className).toContain("fullscreen-hint-in");
    expect(hint.textContent).toBe("全屏模式");
    // 大字展示期间还没进全屏
    expect(root().classList.contains("app-immersive")).toBe(false);

    // 大字淡出结束（900 + 260ms）后才进沉浸态
    await waitFor(() => expect(root().classList.contains("app-immersive")).toBe(true), {
      timeout: 4000,
    });
    expect(document.querySelector('[data-testid="fullscreen-hint"]')).toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(root().classList.contains("app-immersive")).toBe(false);
  });

  it("再按一次 F11 也能退出；沉浸态下按 F11 不会重复进入", async () => {
    render(<App />);
    const root = () => document.querySelector(".app") as HTMLElement;
    fireEvent.keyDown(window, { key: "F11" });
    await waitFor(() => expect(root().classList.contains("app-immersive")).toBe(true), {
      timeout: 4000,
    });
    fireEvent.keyDown(window, { key: "F11" });
    expect(root().classList.contains("app-immersive")).toBe(false);
    // 退出后大字不应残留
    expect(document.querySelector('[data-testid="fullscreen-hint"]')).toBeNull();
  });

  it("CSS：沉浸态隐藏上栏（标题栏/标签栏）、左栏、右栏、下栏", () => {
    const css = read("../App.css");
    const block = rule(css, ".app-immersive .titlebar,");
    for (const sel of [
      ".app-immersive .tab-bar",
      ".app-immersive .app-sidebar",
      ".app-immersive .app-outline",
      ".app-immersive .statusbar",
    ]) {
      expect(block).toContain(sel);
    }
    expect(block).toContain("display: none !important");
    expect(css).toContain(".fullscreen-hint-text");
    expect(css).toContain("@keyframes fullscreen-text-in");
  });

  it("窗口全屏走显式 set（Tauri 优先 + DOM 回退），不再用 toggle", async () => {
    const util = read("../utils/windowFullscreen.ts");
    expect(util).toContain("export async function setWindowFullscreen");
    expect(util).toContain("export async function isWindowFullscreen");
    const app = read("../App.tsx");
    expect(app).toContain("setWindowFullscreen(true)");
    expect(app).toContain("setWindowFullscreen(false)");
    expect(app).toContain("immersiveRef.current && e.key === \"Escape\"");
  });
});
