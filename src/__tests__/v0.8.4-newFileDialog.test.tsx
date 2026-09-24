/**
 * v0.8.4 需求5+9（WP5）：NewFileDialog 新建文件弹框测试
 *
 * 覆盖：
 * 1. validateFileName：必填、非法字符（\ / : * ? " < > |）、通过
 * 2. ensureMdExtension（P1 扩展名策略）：无扩展名补 .md、带扩展名尊重、
 *    "." 在开头（如 .gitignore）视为无扩展名（与 makeUniqueName 判定一致）
 * 3. 组件行为：空名/非法字符不提交、扩展名补全后交给 onConfirm、
 *    重名错误内联显示（onConfirm reject → newFile.exists）且弹框保持打开、
 *    居中 overlay 渲染（.newfile-overlay 含输入框）+ 目标目录只读展示
 * 4. 默认名自动避让（FileTree 集成）：listDir 返回已有"新文档.md"时预填"新文档 - 副本.md"
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, act } from "@testing-library/react";

// mock fileService：默认避让用例（用例 4）需要 FileTree 真正调用 listDir
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
    // v0.8.4 需求10：watch 接入（FileTree 挂载即订阅事件）
    watchFolder: vi.fn(async () => {}),
    unwatchFolder: vi.fn(async () => {}),
    onFolderChanged: vi.fn(async () => () => {}),
  },
  isTauri: () => true,
}));

import { NewFileDialog, validateFileName, ensureMdExtension } from "../components/dialogs/NewFileDialog";
import { FileTree } from "../components/sidebar/FileTree";
import { useFileStore } from "../stores/useFileStore";
import { useEditorStore } from "../stores/useEditorStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { fileService } from "../services/fileService";
import { clearClipboard } from "../utils/fileClipboard";

// jsdom 未实现 ResizeObserver（FileTree 依赖），mock 空实现
beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

// vitest 未开启 globals → 手动 cleanup，避免 DOM 残留
afterEach(() => cleanup());

afterEach(() => {
  vi.clearAllMocks();
});

/** FileEntry mock 工厂（snake_case，与 Rust 返回一致） */
function entry(name: string, path: string, isDir: boolean) {
  return { name, path, is_dir: isDir, size: 0, modified_ms: 0, created_ms: 0 };
}

/** 渲染一个打开状态的 NewFileDialog */
function renderDialog(props: Partial<Parameters<typeof NewFileDialog>[0]> = {}) {
  const onConfirm = vi.fn(async () => {});
  const onClose = vi.fn();
  render(
    <NewFileDialog
      open
      parentPath="C:/proj/sub"
      defaultName="新文档.md"
      onClose={onClose}
      onConfirm={onConfirm}
      {...props}
    />,
  );
  const overlay = document.querySelector(".newfile-overlay") as HTMLElement;
  const input = overlay.querySelector("input") as HTMLInputElement;
  return { onConfirm, onClose, overlay, input };
}

/** 点击弹框底部"创建"按钮 */
function clickCreate(overlay: HTMLElement) {
  const btn = Array.from(overlay.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === "创建",
  ) as HTMLButtonElement;
  expect(btn).toBeTruthy();
  fireEvent.click(btn);
  return btn;
}

// ─── 1. 校验纯函数 ─────────────────────────────
describe("v0.8.4 validateFileName", () => {
  it("空名字 → 必填提示", () => {
    expect(validateFileName("")).toBe("newFile.nameRequired");
    expect(validateFileName("   ")).toBe("newFile.nameRequired");
  });

  it("非法字符 → 非法提示（\\ / : * ? \" < > |）", () => {
    for (const bad of ["a/b", "a\\b", "a:b", "a*b", "a?b", 'a"b', "a<b", "a>b", "a|b"]) {
      expect(validateFileName(bad)).toBe("newFile.invalidName");
    }
  });

  it("合法名字 → null", () => {
    expect(validateFileName("笔记")).toBeNull();
    expect(validateFileName("notes.txt")).toBeNull();
  });
});

// ─── 2. P1 扩展名策略 ──────────────────────────
describe("v0.8.4 ensureMdExtension（P1）", () => {
  it("无扩展名 → 自动补 .md", () => {
    expect(ensureMdExtension("notes")).toBe("notes.md");
    expect(ensureMdExtension("新文档")).toBe("新文档.md");
  });

  it("带扩展名 → 完全尊重", () => {
    expect(ensureMdExtension("notes.txt")).toBe("notes.txt");
    expect(ensureMdExtension("新文档.md")).toBe("新文档.md");
  });

  it("\".\" 在开头（.gitignore）不算扩展名分隔 → 补 .md（与 makeUniqueName 判定一致）", () => {
    expect(ensureMdExtension(".gitignore")).toBe(".gitignore.md");
  });
});

// ─── 3. 组件行为 ───────────────────────────────
describe("v0.8.4 NewFileDialog 组件", () => {
  it("居中 overlay 渲染：.newfile-overlay 存在且含输入框，目标目录只读展示", () => {
    const { overlay, input } = renderDialog();
    expect(overlay).toBeTruthy();
    // overlay 仍带 newfolder-overlay 居中样式类（复用视觉）
    expect(overlay.classList.contains("newfolder-overlay")).toBe(true);
    expect(input.tagName).toBe("INPUT");
    expect(input.value).toBe("新文档.md");
    // 目标目录只读展示（newFile.target = 将创建于）
    const target = overlay.querySelector(".newfile-target") as HTMLElement;
    expect(target.textContent).toBe("C:/proj/sub");
    expect(overlay.textContent).toContain("将创建于");
  });

  it("空名不提交并提示", () => {
    const { onConfirm, overlay, input } = renderDialog();
    fireEvent.change(input, { target: { value: "" } });
    clickCreate(overlay);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(overlay.textContent).toContain("请输入文件名");
  });

  it("非法字符不提交并提示", () => {
    const { onConfirm, overlay, input } = renderDialog();
    fireEvent.change(input, { target: { value: "a/b" } });
    clickCreate(overlay);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(overlay.textContent).toContain("不能包含");
  });

  it("无扩展名 → 确认时自动补 .md 后交给 onConfirm", () => {
    const { onConfirm, overlay, input } = renderDialog();
    fireEvent.change(input, { target: { value: "notes" } });
    clickCreate(overlay);
    expect(onConfirm).toHaveBeenCalledWith("notes.md");
  });

  it("带扩展名 → 尊重用户输入", () => {
    const { onConfirm, overlay, input } = renderDialog();
    fireEvent.change(input, { target: { value: "notes.txt" } });
    clickCreate(overlay);
    expect(onConfirm).toHaveBeenCalledWith("notes.txt");
  });

  it("重名错误内联显示且弹框保持打开", async () => {
    const onConfirm = vi.fn(async () => {
      // 模拟 Rust create_file 的"文件已存在"错误
      throw new Error("文件已存在: C:/proj/sub/新文档.md");
    });
    const { overlay, input } = renderDialog({ onConfirm });
    fireEvent.change(input, { target: { value: "新文档.md" } });
    await act(async () => {
      clickCreate(overlay);
    });
    // 错误在弹框内联显示（i18n newFile.exists），弹框未关闭
    expect(overlay.textContent).toContain("文件已存在");
    expect(document.querySelector(".newfile-overlay")).toBeTruthy();
  });

  it("open=false 时不渲染", () => {
    const { container } = render(
      <NewFileDialog open={false} parentPath="C:/proj" onClose={() => {}} onConfirm={async () => {}} />,
    );
    expect(container.querySelector(".newfile-overlay")).toBeNull();
  });
});

// ─── 4. 默认名自动避让（FileTree → handleNewFile 集成） ──────────
describe("v0.8.4 新建文件默认名自动避让", () => {
  beforeEach(() => {
    clearClipboard();
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
          fileTree: [{ name: "a.md", path: "C:/proj/a.md", isDir: false, size: 10 }],
        },
      ],
    });
  });

  it("listDir 返回已有\"新文档.md\"时，弹框预填\"新文档 - 副本.md\"", async () => {
    vi.mocked(fileService.listDir).mockImplementation(async (p: string) =>
      p === "C:/proj" ? [entry("新文档.md", "C:/proj/新文档.md", false)] : [],
    );
    render(<FileTree />);
    const content = document.querySelector(".filetree-folder-content") as HTMLElement;
    expect(content).toBeTruthy();
    fireEvent.contextMenu(content);
    const menu = document.querySelector(".filetree-context-menu") as HTMLElement;
    const newFileBtn = Array.from(menu.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").includes("新建文件"),
    ) as HTMLButtonElement;
    fireEvent.click(newFileBtn);
    // 弹框已打开（同步）
    const overlay = document.querySelector(".newfile-overlay") as HTMLElement;
    expect(overlay).toBeTruthy();
    // 等 silent listDir 的避让名回填
    await act(async () => {});
    const input = overlay.querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("新文档 - 副本.md");
  });
});
