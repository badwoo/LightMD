/**
 * v0.8.1 需求6：无边框窗口 + 自绘窗口三键（macOS 交通灯配色）
 *
 * 覆盖：
 * 1. 非 Tauri 环境不渲染三键（避免 IPC 报错）
 * 2. Tauri 环境渲染三键，顺序为 最小化 → 窗口化 → 关闭
 * 3. 三键分别调用 window.minimize / toggleMaximize / close
 * 4. 三键位于 TitleBar 设置按钮右侧（.titlebar-right 末尾）
 * 5. 配置与权限防回归：decorations=false、maximized=true、core:window:* 权限
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (rel: string) => readFileSync(resolve(__dirname, rel), "utf-8");

const mocks = vi.hoisted(() => {
  const minimize = vi.fn().mockResolvedValue(undefined);
  const toggleMaximize = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn().mockResolvedValue(undefined);
  const isMaximized = vi.fn().mockResolvedValue(false);
  const onResized = vi.fn().mockResolvedValue(() => {});
  return { minimize, toggleMaximize, close, isMaximized, onResized, tauri: true };
});

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize: mocks.minimize,
    toggleMaximize: mocks.toggleMaximize,
    close: mocks.close,
    isMaximized: mocks.isMaximized,
    onResized: mocks.onResized,
  }),
}));

// 默认视为 Tauri 环境；需要测"浏览器环境"时把 tauri 置 false
vi.mock("../services/fileService", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../services/fileService")>();
  return { ...orig, isTauri: () => mocks.tauri };
});

import { WindowControls } from "../components/layout/WindowControls";
import { TitleBar } from "../components/layout/TitleBar";

beforeEach(() => {
  mocks.tauri = true;
  vi.clearAllMocks();
  mocks.isMaximized.mockResolvedValue(false);
  mocks.onResized.mockResolvedValue(() => {});
});

afterEach(() => {
  cleanup();
});

describe("v0.8.1 需求6：窗口三键", () => {
  it("Tauri 环境渲染三键，顺序为 最小化 → 窗口化 → 关闭", () => {
    render(<WindowControls />);
    const wc = screen.getByTestId("window-controls");
    const ids = Array.from(wc.querySelectorAll("button")).map((b) => b.dataset.testid);
    expect(ids).toEqual(["window-minimize", "window-maximize", "window-close"]);
  });

  it("点击三键分别调用 minimize / toggleMaximize / close", () => {
    render(<WindowControls />);
    fireEvent.click(screen.getByTestId("window-minimize"));
    expect(mocks.minimize).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("window-maximize"));
    expect(mocks.toggleMaximize).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("window-close"));
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("非 Tauri 环境（浏览器 dev）不渲染三键", () => {
    mocks.tauri = false;
    render(<WindowControls />);
    expect(screen.queryByTestId("window-controls")).toBeNull();
  });

  it("三键位于 TitleBar 设置按钮右侧（.titlebar-right 末尾）", () => {
    render(<TitleBar />);
    const right = document.querySelector(".titlebar-right") as HTMLElement;
    expect(right).toBeTruthy();
    expect(right.lastElementChild?.className).toContain("window-controls");
  });
});

describe("v0.8.1 需求6：配置与权限防回归", () => {
  it("窗口配置：decorations=false（去原生标题栏）+ maximized=true（默认最大化）", () => {
    const conf = JSON.parse(read("../../src-tauri/tauri.conf.json"));
    expect(conf.app.windows[0].decorations).toBe(false);
    expect(conf.app.windows[0].maximized).toBe(true);
  });

  it("capabilities 放行三键与拖拽所需权限", () => {
    const caps = JSON.parse(read("../../src-tauri/capabilities/default.json"));
    expect(caps.permissions).toContain("core:window:allow-minimize");
    expect(caps.permissions).toContain("core:window:allow-toggle-maximize");
    expect(caps.permissions).toContain("core:window:allow-close");
    expect(caps.permissions).toContain("core:window:allow-start-dragging");
    expect(caps.permissions).toContain("core:window:allow-is-maximized");
  });

  it("TitleBar 拖拽区域覆盖品牌与标题文字（无边框下才能拖动窗口）", () => {
    const src = read("../components/layout/TitleBar.tsx");
    expect(src).toMatch(/className="titlebar-brand"\s+data-tauri-drag-region/);
    expect(src).toMatch(/className="titlebar-title"\s+data-tauri-drag-region/);
  });
});
