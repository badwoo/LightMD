// @vitest-environment jsdom
import React, { useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FileTree, type SidebarView } from "../components/sidebar/FileTree";
import { useEditorStore } from "../stores/useEditorStore";
import { useFileStore } from "../stores/useFileStore";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("../services/fileService", () => ({
  fileService: {
    readFile: vi.fn(async () => ""), listDir: vi.fn(async () => []), exists: vi.fn(async () => false),
    writeFile: vi.fn(async () => {}), getFileSize: vi.fn(async () => 0), createFile: vi.fn(async () => {}),
    createDir: vi.fn(async () => {}), deleteFile: vi.fn(async () => {}), renameFile: vi.fn(async () => {}),
    copyFile: vi.fn(async () => {}), moveFile: vi.fn(async () => {}), revealInFolder: vi.fn(async () => {}),
    watchFolder: vi.fn(async () => {}), unwatchFolder: vi.fn(async () => {}),
    onFolderChanged: vi.fn(async () => () => {}),
  },
  isTauri: () => false,
}));

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});

beforeEach(() => {
  localStorage.clear();
  useFileStore.setState({ openFolders: [], rootPath: null, fileTree: [], tempFiles: [], favorites: [], recentFiles: [], recentFolders: [] });
  useEditorStore.setState({ openTabs: [], activeTabIdx: -1, filePath: null });
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function Harness() {
  const [view, setView] = useState<SidebarView>("files");
  return (
    <>
      <FileTree view={view} onViewChange={setView} />
      <button onClick={() => setView("files")}>关闭特殊面板</button>
      <output data-testid="view">{view}</output>
    </>
  );
}

describe("v0.16.0 侧栏互斥视图", () => {
  it("头部恢复「文件管理」标题 + 六个功能图标（不再有大号「＋ 新建」按钮）", () => {
    const { container } = render(<Harness />);
    const title = container.querySelector(".filetree-title") as HTMLElement | null;
    expect(title?.textContent).toBe("文件管理");
    const buttons = Array.from(container.querySelectorAll(".filetree-actions .filetree-btn"));
    expect(buttons.map((b) => b.getAttribute("title"))).toEqual([
      "新建文件",
      "新建文件夹",
      "打开文件夹",
      "搜索文件",
      "收藏",
      "最近打开",
    ]);
    expect(container.querySelector(".filetree-new-primary")).toBeNull();
  });

  it("新建文件图标复用 file.new 命令", () => {
    const listener = vi.fn();
    window.addEventListener("lightmd:command", listener);
    render(<Harness />);
    fireEvent.click(screen.getByTitle("新建文件"));
    expect(listener.mock.calls[0][0].detail.id).toBe("file.new");
    window.removeEventListener("lightmd:command", listener);
  });

  it("收藏与最近直接互切，文件树保持挂载，关闭返回文件管理", () => {
    const { container } = render(<Harness />);
    const files = container.querySelector(".filetree-scroll");
    fireEvent.click(screen.getByTitle("收藏"));
    expect(screen.getByTestId("view").textContent).toBe("favorites");
    expect(container.querySelector(".favorites-panel")).not.toBeNull();
    expect(container.querySelector(".recent-files-panel")).toBeNull();
    expect(container.querySelector(".filetree-scroll")).toBe(files);
    expect(files?.getAttribute("aria-hidden")).toBe("true");

    fireEvent.click(screen.getByTitle("最近打开"));
    expect(screen.getByTestId("view").textContent).toBe("recent");
    expect(container.querySelector(".recent-files-panel")).not.toBeNull();
    expect(screen.getByText("暂无最近打开记录")).toBeTruthy();

    fireEvent.click(screen.getByText("关闭特殊面板"));
    expect(screen.getByTestId("view").textContent).toBe("files");
    expect(files?.getAttribute("aria-hidden")).toBe("false");
  });

  it("特殊视图中使用共用打开文件夹入口后返回文件管理", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByTitle("收藏"));
    fireEvent.click(screen.getByTitle("打开文件夹"));
    await waitFor(() => expect(screen.getByTestId("view").textContent).toBe("files"));
  });

  it("打开最近文件夹后返回文件管理展示工作区", () => {
    useFileStore.setState({
      recentFolders: [{ path: "C:/workspace", name: "workspace", accessedAt: Date.now() }],
    });
    render(<Harness />);
    fireEvent.click(screen.getByTitle("最近打开"));
    fireEvent.click(screen.getByText("workspace"));
    expect(screen.getByTestId("view").textContent).toBe("files");
  });

  it("减少动态效果时退出面板立即卸载", () => {
    const previous = window.matchMedia;
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: true }) });
    const { container } = render(<Harness />);
    fireEvent.click(screen.getByTitle("收藏"));
    fireEvent.click(screen.getByText("关闭特殊面板"));
    expect(container.querySelector(".favorites-panel")).toBeNull();
    expect(container.querySelector(".sidebar-panel-slide-exit")).toBeNull();
    Object.defineProperty(window, "matchMedia", { configurable: true, value: previous });
  });

  it("特殊面板退出使用向右动画，重开从左侧进入", () => {
    vi.useFakeTimers();
    const { container } = render(<Harness />);
    fireEvent.click(screen.getByTitle("收藏"));
    expect(container.querySelector(".sidebar-panel-slide-enter")).not.toBeNull();
    fireEvent.click(screen.getByText("关闭特殊面板"));
    expect(container.querySelector(".sidebar-panel-slide-exit")).not.toBeNull();
    fireEvent.click(screen.getByTitle("最近打开"));
    expect(container.querySelector(".sidebar-panel-slide-enter .recent-files-panel")).not.toBeNull();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });
});
