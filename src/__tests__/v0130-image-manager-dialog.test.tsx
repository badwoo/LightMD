/**
 * v0.13.0 需求11：图片管理面板组件测试
 *
 * 覆盖（行为断言，非源码正则）：
 * - 文档图片页签：列出图片 + 引用计数 + 空态
 * - 「转 assets」：外部图（绝对路径）→ 写 assets + onRewriteRefs 回调
 * - 「重命名」：rename_file + onRewriteRefs 回调；空输入禁用按钮
 * - 「未引用清理」：差集列表 + 勾选 + window.confirm + delete_file（回收站）
 * - 未保存文档 → 显示提示、操作按钮禁用
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

// ─── Tauri mock（vi.hoisted 保证引用稳定，与 image-insert-dialog.test.tsx 同型）──
const mockListDir = vi.hoisted(() => vi.fn());
const mockCopyFile = vi.hoisted(() => vi.fn());
const mockRenameFile = vi.hoisted(() => vi.fn());
const mockDeleteFile = vi.hoisted(() => vi.fn());
const mockExists = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());
const mockWriteFile = vi.hoisted(() => vi.fn());

vi.mock("../services/fileService", () => ({
  fileService: {
    listDir: mockListDir,
    copyFile: mockCopyFile,
    renameFile: mockRenameFile,
    deleteFile: mockDeleteFile,
  },
  isTauri: () => true,
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: mockExists,
  readFile: mockReadFile,
  writeFile: mockWriteFile,
}));

// path 插件在 jsdom 下无真实实现：用 POSIX 拼接桩（组件只做目录拼接，
// 返回值需可预测以便断言调用参数）
const mockJoin = vi.hoisted(() => vi.fn((...parts: string[]) => parts.join("/").replace(/\/+/g, "/")));
const mockDirname = vi.hoisted(() => vi.fn((p: string) => p.replace(/[\\/][^\\/]*$/, "")));
vi.mock("@tauri-apps/api/path", () => ({
  join: mockJoin,
  dirname: mockDirname,
}));

import { ImageManagerDialog } from "../components/dialogs/ImageManagerDialog";
import { markdownToDoc } from "../core/markdown/parser";

const DOC_PATH = "D:/docs/readme.md";

function renderPanel(overrides?: {
  markdown?: string;
  docPath?: string | null;
  onRewriteRefs?: (ops: Array<{ oldSrc: string; newSrc: string }>) => void;
}) {
  const md = overrides?.markdown ?? "![图](./assets/a.png)\n\n![图2](./assets/a.png)\n";
  const doc = markdownToDoc(md);
  const onRewriteRefs = overrides?.onRewriteRefs ?? vi.fn();
  const utils = render(
    <ImageManagerDialog
      open
      doc={doc}
      docPath={overrides?.docPath === undefined ? DOC_PATH : overrides.docPath}
      onRewriteRefs={onRewriteRefs}
      onClose={vi.fn()}
    />,
  );
  return { ...utils, onRewriteRefs };
}

beforeEach(() => {
  cleanup();
  mockListDir.mockReset();
  mockCopyFile.mockReset();
  mockRenameFile.mockReset();
  mockDeleteFile.mockReset();
  mockExists.mockReset();
  mockReadFile.mockReset();
  mockWriteFile.mockReset();
  mockListDir.mockResolvedValue([]);
  mockExists.mockResolvedValue(false);
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = true;
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("v0.13.0 需求11 图片管理面板：文档图片页签", () => {
  it("列出文档图片与合并后的引用计数", () => {
    renderPanel();
    expect(screen.getByTestId("image-manager")).toBeTruthy();
    // 同 src 两处引用 → 列表一行、计数 2
    expect(screen.getByText("图")).toBeTruthy();
    const counts = screen.getAllByText("2");
    expect(counts.length).toBeGreaterThanOrEqual(1);
  });

  it("文档无图片 → 空态提示", () => {
    renderPanel({ markdown: "纯文本\n" });
    expect(screen.getByText(/当前文档没有图片/)).toBeTruthy();
  });

  it("未保存文档 → 提示先保存，转 assets 按钮禁用", () => {
    renderPanel({ docPath: null });
    expect(screen.getByText(/请先保存/)).toBeTruthy();
    const migrateBtn = screen.getByTitle(/复制到文档同级/);
    expect((migrateBtn as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("v0.13.0 需求11 转 assets", () => {
  it("绝对路径图 → 读源写 assets + onRewriteRefs 改写为 assets/ 相对路径", async () => {
    mockExists.mockResolvedValue(true);
    mockListDir.mockResolvedValue([{ name: "old.png", path: "D:/docs/assets/old.png", is_dir: false, size: 1, modified_ms: 0, created_ms: 0 }]);
    mockReadFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
    mockWriteFile.mockResolvedValue(undefined);

    const { onRewriteRefs } = renderPanel({ markdown: "![图](D:/pic/a.png)\n" });
    fireEvent.click(screen.getByTitle(/复制到文档同级/));

    await waitFor(() => expect(mockWriteFile).toHaveBeenCalledTimes(1));
    expect(mockReadFile).toHaveBeenCalledTimes(1);
    expect(onRewriteRefs).toHaveBeenCalledWith([{ oldSrc: "D:/pic/a.png", newSrc: "assets/a.png" }]);
    expect(screen.getByText(/已转存为 a\.png/)).toBeTruthy();
  });

  it("data URL 图 → 无文件名，提示失败且不改写引用", async () => {
    mockWriteFile.mockResolvedValue(undefined);
    const { onRewriteRefs } = renderPanel({
      markdown: "![图](data:image/png;base64,iVBORw0KGgo=)\n",
    });
    fireEvent.click(screen.getByTitle(/复制到文档同级/));
    await waitFor(() => expect(screen.getByText(/转存失败/)).toBeTruthy());
    // data URL 没有文件名（末段是 base64 载荷）→ 不得写盘、不得改写引用
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockReadFile).not.toHaveBeenCalled();
    expect(onRewriteRefs).not.toHaveBeenCalled();
  });

  it("相对路径图 → 直接 copyFile（不删源文件，v1 决策）", async () => {
    mockExists.mockResolvedValue(true);
    mockListDir.mockResolvedValue([]);
    mockCopyFile.mockResolvedValue(undefined);
    const { onRewriteRefs } = renderPanel({ markdown: "![图](./pic/a.png)\n" });
    fireEvent.click(screen.getByTitle(/复制到文档同级/));
    await waitFor(() => expect(mockCopyFile).toHaveBeenCalledTimes(1));
    expect(mockReadFile).not.toHaveBeenCalled();
    expect(onRewriteRefs).toHaveBeenCalledWith([{ oldSrc: "./pic/a.png", newSrc: "assets/a.png" }]);
  });
});

describe("v0.13.0 需求11 重命名", () => {
  it("输入新名 → rename_file + onRewriteRefs", async () => {
    mockRenameFile.mockResolvedValue(undefined);
    const { onRewriteRefs } = renderPanel({ markdown: "![图](./assets/a.png)\n" });
    const input = screen.getByPlaceholderText("a.png");
    fireEvent.change(input, { target: { value: "b.png" } });
    fireEvent.click(screen.getByTitle(/重命名文件/));
    await waitFor(() => expect(mockRenameFile).toHaveBeenCalledTimes(1));
    expect(onRewriteRefs).toHaveBeenCalledWith([{ oldSrc: "./assets/a.png", newSrc: "./assets/b.png" }]);
    expect(screen.getByText(/已重命名为 b\.png/)).toBeTruthy();
  });

  it("空输入 → 重命名按钮禁用", () => {
    renderPanel({ markdown: "![图](./assets/a.png)\n" });
    const btn = screen.getByTitle(/重命名文件/) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});

describe("v0.13.0 需求11 未引用清理", () => {
  it("assets 中未被本文档引用的文件被列出", async () => {
    mockExists.mockResolvedValue(true);
    mockListDir.mockResolvedValue([
      { name: "a.png", path: "D:/docs/assets/a.png", is_dir: false, size: 1, modified_ms: 0, created_ms: 0 },
      { name: "ghost.png", path: "D:/docs/assets/ghost.png", is_dir: false, size: 1, modified_ms: 0, created_ms: 0 },
    ]);
    renderPanel({ markdown: "![图](./assets/a.png)\n" });
    fireEvent.click(screen.getByRole("tab", { name: /未引用清理/ }));
    await waitFor(() => expect(screen.getByText("ghost.png")).toBeTruthy());
    // 被引用的 a.png 不出现在清理列表
    expect(screen.queryByText("a.png")).toBeNull();
  });

  it("勾选 + 确认 → delete_file（回收站）", async () => {
    mockExists.mockResolvedValue(true);
    mockListDir.mockResolvedValue([
      { name: "ghost.png", path: "D:/docs/assets/ghost.png", is_dir: false, size: 1, modified_ms: 0, created_ms: 0 },
    ]);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    mockDeleteFile.mockResolvedValue(undefined);
    renderPanel({ markdown: "![图](./assets/a.png)\n" });
    fireEvent.click(screen.getByRole("tab", { name: /未引用清理/ }));
    await waitFor(() => expect(screen.getByText("ghost.png")).toBeTruthy());
    fireEvent.click(screen.getByText("ghost.png"));
    fireEvent.click(screen.getByText(/清理所选/));
    await waitFor(() => expect(mockDeleteFile).toHaveBeenCalledTimes(1));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });

  it("取消确认 → 不删除", async () => {
    mockExists.mockResolvedValue(true);
    mockListDir.mockResolvedValue([
      { name: "ghost.png", path: "D:/docs/assets/ghost.png", is_dir: false, size: 1, modified_ms: 0, created_ms: 0 },
    ]);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPanel({ markdown: "![图](./assets/a.png)\n" });
    fireEvent.click(screen.getByRole("tab", { name: /未引用清理/ }));
    await waitFor(() => expect(screen.getByText("ghost.png")).toBeTruthy());
    fireEvent.click(screen.getByText("ghost.png"));
    fireEvent.click(screen.getByText(/清理所选/));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    expect(mockDeleteFile).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("无未引用文件 → 空态提示", async () => {
    mockExists.mockResolvedValue(true);
    mockListDir.mockResolvedValue([
      { name: "a.png", path: "D:/docs/assets/a.png", is_dir: false, size: 1, modified_ms: 0, created_ms: 0 },
    ]);
    renderPanel({ markdown: "![图](./assets/a.png)\n" });
    fireEvent.click(screen.getByRole("tab", { name: /未引用清理/ }));
    await waitFor(() =>
      expect(screen.getByText("assets/ 中没有未被本文档引用的图片")).toBeTruthy(),
    );
  });
});
