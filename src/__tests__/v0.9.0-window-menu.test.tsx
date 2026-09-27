/**
 * v0.9.0 WP2：标题栏「窗口」菜单。
 *
 * 覆盖：
 * - `windowDisplayName` 的命名规则（主窗口 / 窗口 N / 槽位缺失兜底）
 * - 菜单展开时拉取窗口列表并渲染（窗口项 + 标签子项 + dirty 圆点）
 * - 窗口项点击 = 激活窗口；标签子项点击 = 激活窗口 + 切标签（§3.7）
 * - 「合并到主窗口」在当前 Primary 上禁用
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

const listWindowsMock = vi.fn();

vi.mock("../services/windowService", async () => {
  const actual = await vi.importActual<typeof import("../services/windowService")>(
    "../services/windowService",
  );
  return {
    ...actual,
    windowService: {
      ...actual.windowService,
      listWindows: (...args: unknown[]) => listWindowsMock(...args),
      focusWindow: vi.fn(async () => {}),
    },
  };
});

import { TitleBar, windowDisplayName } from "../components/layout/TitleBar";
import { __setWindowLabelForTest } from "../utils/windowLabel";
import { t } from "../i18n";

const tr = (key: string, params?: Record<string, string | number>) => t(key, params);

beforeEach(() => {
  __setWindowLabelForTest(null);
  listWindowsMock.mockReset();
});

afterEach(() => {
  cleanup();
  __setWindowLabelForTest(null);
  vi.restoreAllMocks();
});

describe("v0.9.0 WP2：windowDisplayName", () => {
  it("Primary 显示为「主窗口」", () => {
    expect(windowDisplayName("main", true, ["main", "sec-1"], tr)).toBe(tr("multiwindow.primary"));
    // 晋升后 Primary 可能是 sec-*，仍显示「主窗口」
    expect(windowDisplayName("sec-1", true, ["main", "sec-1"], tr)).toBe(
      tr("multiwindow.primary"),
    );
  });

  it("sec-N 显示为「窗口 N」（编号取自槽位，不跳号）", () => {
    expect(windowDisplayName("sec-3", false, [], tr)).toBe(tr("multiwindow.windowN", { n: 3 }));
  });

  it("非标准 label 按列表顺序兜底编号", () => {
    expect(windowDisplayName("weird", false, ["main", "weird"], tr)).toBe(
      tr("multiwindow.windowN", { n: 2 }),
    );
  });
});

describe("v0.9.0 WP2：窗口菜单交互", () => {
  it("展开时拉取并渲染窗口列表（含标签与 dirty 圆点）", async () => {
    listWindowsMock.mockResolvedValue([
      {
        label: "main",
        isPrimary: true,
        createdAt: 1,
        activeTabIdx: 0,
        tabs: [
          { kind: "file", path: "D:/a.md", untitledId: null, name: "a.md", pinned: false, isDirty: true },
        ],
      },
      {
        label: "sec-1",
        isPrimary: false,
        createdAt: 2,
        activeTabIdx: 0,
        tabs: [
          { kind: "untitled", path: null, untitledId: "untitled-1", name: "新文件1", pinned: false, isDirty: false },
        ],
      },
    ]);
    render(<TitleBar fileName="a.md" />);

    fireEvent.mouseEnter(screen.getByTestId("titlebar-window-menu-btn"));
    await waitFor(() => expect(listWindowsMock).toHaveBeenCalled());

    expect(screen.getByTestId("window-menu-window-main")).toBeTruthy();
    expect(screen.getByTestId("window-menu-window-sec-1")).toBeTruthy();
    // 标签子项（dirty 带圆点）
    expect(screen.getByTestId("window-menu-tab-main-0").textContent).toContain("a.md ●");
    expect(screen.getByTestId("window-menu-tab-sec-1-0").textContent).toContain("新文件1");
  });

  it("窗口项点击（非自身）激活该窗口", async () => {
    listWindowsMock.mockResolvedValue([
      { label: "sec-1", isPrimary: true, createdAt: 1, activeTabIdx: 0, tabs: [] },
    ]);
    const onFocusWindow = vi.fn();
    render(<TitleBar fileName="a.md" onFocusWindow={onFocusWindow} />);
    fireEvent.mouseEnter(screen.getByTestId("titlebar-window-menu-btn"));
    await waitFor(() => expect(listWindowsMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("window-menu-window-sec-1"));
    expect(onFocusWindow).toHaveBeenCalledWith("sec-1");
  });

  it("标签子项点击 = 激活该窗口 + 切到对应标签", async () => {
    listWindowsMock.mockResolvedValue([
      {
        label: "sec-2",
        isPrimary: false,
        createdAt: 2,
        activeTabIdx: 1,
        tabs: [
          { kind: "file", path: "D:/a.md", untitledId: null, name: "a.md", pinned: false, isDirty: false },
          { kind: "file", path: "D:/b.md", untitledId: null, name: "b.md", pinned: false, isDirty: false },
        ],
      },
    ]);
    const onActivateTab = vi.fn();
    render(<TitleBar fileName="x" onActivateTab={onActivateTab} />);
    fireEvent.mouseEnter(screen.getByTestId("titlebar-window-menu-btn"));
    await waitFor(() => expect(listWindowsMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("window-menu-tab-sec-2-1"));
    expect(onActivateTab).toHaveBeenCalledWith("sec-2", {
      kind: "file",
      path: "D:/b.md",
      untitledId: null,
    });
  });

  it("当前活跃标签子项带 is-active 标记", async () => {
    listWindowsMock.mockResolvedValue([
      {
        label: "sec-1",
        isPrimary: false,
        createdAt: 1,
        activeTabIdx: 1,
        tabs: [
          { kind: "file", path: "D:/a.md", untitledId: null, name: "a.md", pinned: false, isDirty: false },
          { kind: "file", path: "D:/b.md", untitledId: null, name: "b.md", pinned: false, isDirty: false },
        ],
      },
    ]);
    render(<TitleBar fileName="x" />);
    fireEvent.mouseEnter(screen.getByTestId("titlebar-window-menu-btn"));
    await waitFor(() => expect(listWindowsMock).toHaveBeenCalled());
    expect(screen.getByTestId("window-menu-tab-sec-1-1").className).toContain("is-active");
    expect(screen.getByTestId("window-menu-tab-sec-1-0").className).not.toContain("is-active");
  });

  it("无标签的窗口显示占位文案", async () => {
    listWindowsMock.mockResolvedValue([
      { label: "sec-1", isPrimary: false, createdAt: 1, activeTabIdx: 0, tabs: [] },
    ]);
    render(<TitleBar fileName="x" />);
    fireEvent.mouseEnter(screen.getByTestId("titlebar-window-menu-btn"));
    await waitFor(() => expect(listWindowsMock).toHaveBeenCalled());
    expect(screen.getAllByText(tr("multiwindow.emptyWindow")).length).toBeGreaterThan(0);
  });

  it("当前窗口为 Primary 时「合并到主窗口」禁用", async () => {
    listWindowsMock.mockResolvedValue([
      { label: "main", isPrimary: true, createdAt: 1, activeTabIdx: 0, tabs: [] },
    ]);
    render(<TitleBar fileName="x" isPrimaryWindow />);
    fireEvent.mouseEnter(screen.getByTestId("titlebar-window-menu-btn"));
    await waitFor(() => expect(listWindowsMock).toHaveBeenCalled());
    const merge = screen.getByText(tr("multiwindow.mergeToPrimary")) as HTMLButtonElement;
    expect(merge.disabled).toBe(true);
  });

  it("提供「新建窗口」与「关闭当前窗口」入口（与快捷键同源）", async () => {
    listWindowsMock.mockResolvedValue([]);
    const onNewWindow = vi.fn();
    const onCloseWindow = vi.fn();
    render(
      <TitleBar fileName="x" onNewWindow={onNewWindow} onCloseWindow={onCloseWindow} />,
    );
    fireEvent.mouseEnter(screen.getByTestId("titlebar-window-menu-btn"));
    await waitFor(() => expect(listWindowsMock).toHaveBeenCalled());
    fireEvent.click(screen.getByText(tr("multiwindow.newWindow")));
    expect(onNewWindow).toHaveBeenCalledTimes(1);
    fireEvent.mouseEnter(screen.getByTestId("titlebar-window-menu-btn"));
    fireEvent.click(screen.getByText(tr("multiwindow.closeWindow")));
    expect(onCloseWindow).toHaveBeenCalledTimes(1);
  });
});
