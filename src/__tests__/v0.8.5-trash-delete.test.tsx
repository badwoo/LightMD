/**
 * v0.8.5 需求2 —— 文件树删除 = 移到系统回收站（前端语义）
 *
 * 覆盖：
 * 1. 确认弹窗文案改为回收站语义（「确定将 文件/文件夹 "xxx" 移到回收站？」），
 *    确认后调用 fileService.deleteFile，成功 toast 为「已移到回收站: xxx」
 * 2. 取消确认 → 不调用 deleteFile（无副作用）
 * 3. 文件夹节点：确认文案 type 参数为「文件夹」，同样走回收站语义
 * 4. deleteFile 失败 → 失败 toast 为「移到回收站失败」
 *
 * 注：删除链路 handleDelete → fileService.deleteFile → Rust delete_file（trash::delete），
 *     前端仅语义变化（文案走 i18n），Rust 端行为见 file_ops.rs 单测。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { render, fireEvent, cleanup, act } from "@testing-library/react";

// mock fileService：isTauri=true 让 handleDelete 真正走到 deleteFile 调用
vi.mock("../services/fileService", () => ({
  fileService: {
    readFile: vi.fn(async () => ""),
    listDir: vi.fn(async () => []),
    exists: vi.fn(async () => false),
    writeFile: vi.fn(async () => {}),
    getFileSize: vi.fn(async () => 0),
    createFile: vi.fn(async () => {}),
    createDir: vi.fn(async () => {}),
    deleteFile: vi.fn(async () => {}),
    renameFile: vi.fn(async () => {}),
    copyFile: vi.fn(async () => {}),
    moveFile: vi.fn(async () => {}),
    revealInFolder: vi.fn(async () => {}),
    watchFolder: vi.fn(async () => {}),
    unwatchFolder: vi.fn(async () => {}),
    onFolderChanged: vi.fn(async () => () => {}),
  },
  isTauri: () => true,
}));

import { FileTree } from "../components/sidebar/FileTree";
import { useFileStore } from "../stores/useFileStore";
import { useEditorStore } from "../stores/useEditorStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { fileService } from "../services/fileService";

// jsdom 未实现 ResizeObserver（SidebarScrollArrows 用其监听尺寸），mock 空实现
beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

// vitest 未开启 globals → @testing-library/react 的 auto-cleanup 不生效，
// 组件渲染类测试需在 afterEach 手动 cleanup + 还原 confirm 的 spy
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const FILE_PATH = "C:/proj/a.md";
const DIR_PATH = "C:/proj/sub";

/** 打开一个含"文件 + 子文件夹"的文件夹，并复位编辑器 / 设置状态 */
function setupFolder() {
  useEditorStore.setState({ openTabs: [], activeTabIdx: 0 });
  useSettingsStore.setState({ fileTreeSort: {} });
  useFileStore.setState({
    favorites: [],
    recentFiles: [],
    recentFolders: [],
    tempFiles: [],
    fileTree: [],
    rootPath: null,
    openFolders: [
      {
        path: "C:/proj",
        name: "proj",
        fileTree: [
          { name: "a.md", path: FILE_PATH, isDir: false, size: 10 },
          { name: "sub", path: DIR_PATH, isDir: true, size: 0 },
        ],
      },
    ],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setupFolder();
});

/** 渲染 FileTree，对指定节点触发右键并点击菜单中的「删除」项 */
async function clickDeleteMenuItem(nodeTitle: string) {
  render(createElement(FileTree));
  const node = document.querySelector(`.filetree-node[title="${nodeTitle}"]`) as HTMLElement | null;
  expect(node).toBeTruthy();
  fireEvent.contextMenu(node!);
  const menu = document.querySelector(".filetree-context-menu") as HTMLElement | null;
  expect(menu).toBeTruthy();
  // 删除项是 danger 样式的菜单按钮（文案 = common.delete「删除」）
  const deleteBtn = Array.from(menu!.querySelectorAll("button.danger")).find(
    (b) => (b.textContent ?? "").trim() === "删除",
  ) as HTMLButtonElement;
  expect(deleteBtn).toBeTruthy();
  await act(async () => {
    fireEvent.click(deleteBtn);
  });
}

// ─── 1. 确认弹窗 + 成功链路 ──────────────────────────
describe("v0.8.5 需求2：文件树删除 = 移到回收站", () => {
  it("删除文件：确认文案为回收站语义，确认后调用 deleteFile，toast 为「已移到回收站」", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    await clickDeleteMenuItem(FILE_PATH);

    // 确认弹窗文案：类型为「文件」+ 文件名 + 回收站语义
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0][0]).toBe('确定将 文件 "a.md" 移到回收站？');
    // 确认后走删除命令（Rust 端 trash::delete 移到回收站）
    expect(vi.mocked(fileService.deleteFile)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fileService.deleteFile)).toHaveBeenCalledWith(FILE_PATH);
    // 成功 toast 同步回收站语义
    const toast = document.querySelector(".filetree-toast");
    expect(toast?.textContent).toContain("已移到回收站: a.md");
  });

  it("取消确认 → 不调用 deleteFile（无删除副作用）", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    await clickDeleteMenuItem(FILE_PATH);

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0][0]).toBe('确定将 文件 "a.md" 移到回收站？');
    expect(vi.mocked(fileService.deleteFile)).not.toHaveBeenCalled();
    // 无成功 toast
    expect(document.querySelector(".filetree-toast")).toBeNull();
  });

  it("删除文件夹：确认文案 type 为「文件夹」，同样走回收站语义", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    await clickDeleteMenuItem(DIR_PATH);

    expect(confirmSpy.mock.calls[0][0]).toBe('确定将 文件夹 "sub" 移到回收站？');
    expect(vi.mocked(fileService.deleteFile)).toHaveBeenCalledWith(DIR_PATH);
    const toast = document.querySelector(".filetree-toast");
    expect(toast?.textContent).toContain("已移到回收站: sub");
  });

  it("deleteFile 失败 → 失败 toast 为「移到回收站失败」", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(fileService.deleteFile).mockRejectedValueOnce(new Error("mock error"));
    await clickDeleteMenuItem(FILE_PATH);

    expect(vi.mocked(fileService.deleteFile)).toHaveBeenCalledTimes(1);
    const toast = document.querySelector(".filetree-toast");
    expect(toast?.textContent).toContain("移到回收站失败");
  });
});
