/**
 * v0.8.2 反馈修复测试（第二轮）
 *
 * 覆盖用户反馈的 5 个问题中可在单测层锁定的部分：
 * 1. 「打开的文件」栏：点击切换已打开文件 **不**重新置顶（仅新打开时置顶）；
 * 2. 文件夹树点击子文件夹不再卡死（曾因渲染期 setState 触发无限循环）；
 * 3. 标题栏「新建 > 新建文件夹」改走应用内弹框（不再用原生 prompt + 保存对话框）；
 * 4. 拖拽兜底：拖拽中按键已松开 / 窗口失焦都会清理监听（"偶尔拖不动"）。
 *
 * 说明：问题2（通过文件夹打开的文件图片渲染不一致）需要真实 Tauri 资源协议环境复现，
 * 单测层无法覆盖，故本文件只锁定其代码链路上可验证的部分（见最后一个 describe）。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { render, act, cleanup } from "@testing-library/react";
import { FileTree } from "../components/sidebar/FileTree";
import { stripExtendedPathPrefix } from "../utils/imagePath";
import { useFileStore } from "../stores/useFileStore";
import { useEditorStore } from "../stores/useEditorStore";

(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

afterEach(() => cleanup());

const fileTreeSrc = readFileSync(
  resolve(__dirname, "../components/sidebar/FileTree.tsx"),
  "utf-8",
);
const appSrc = readFileSync(resolve(__dirname, "../App.tsx"), "utf-8");

function resetStores() {
  localStorage.removeItem("lightmd-file-store");
  localStorage.removeItem("lightmd-editor-store");
  useFileStore.setState({
    favorites: [],
    recentFiles: [],
    recentFolders: [],
    tempFiles: [],
    fileTree: [],
    rootPath: null,
    openFolders: [],
  });
  useEditorStore.setState({ openTabs: [], activeTabIdx: 0 });
}

// ─── 1. 点击切换不置顶 ──────────────────────────────────────

describe("v0.8.2 修复1：「打开的文件」栏点击切换不重新置顶", () => {
  beforeEach(() => {
    resetStores();
    useEditorStore.setState({
      openTabs: [
        { path: "C:/a.md", name: "a.md", content: "", isDirty: false },
        { path: "C:/b.md", name: "b.md", content: "", isDirty: false },
        { path: "C:/c.md", name: "c.md", content: "", isDirty: false },
      ] as never,
      activeTabIdx: 0,
    });
  });
  afterEach(() => {
    useEditorStore.setState({ openTabs: [], activeTabIdx: 0 });
  });

  const titles = () =>
    Array.from(document.querySelectorAll(".filetree-temp-content > .filetree-node")).map(
      (el) => el.getAttribute("title"),
    );

  it("多次切换标签后顺序始终不变（只更新选中态）", () => {
    render(createElement(FileTree));
    expect(titles()).toEqual(["C:/a.md", "C:/b.md", "C:/c.md"]);

    for (const idx of [2, 1, 0, 2, 1]) {
      act(() => {
        useEditorStore.getState().setActiveTab(idx);
      });
      expect(titles()).toEqual(["C:/a.md", "C:/b.md", "C:/c.md"]);
    }
  });

  it("新打开的文件插到最前，之后切换标签不会再改变它", () => {
    render(createElement(FileTree));
    act(() => {
      useEditorStore.setState({
        openTabs: [
          ...useEditorStore.getState().openTabs,
          { path: "C:/d.md", name: "d.md", content: "", isDirty: false },
        ] as never,
        activeTabIdx: 3,
      });
    });
    expect(titles()).toEqual(["C:/d.md", "C:/a.md", "C:/b.md", "C:/c.md"]);

    act(() => {
      useEditorStore.getState().setActiveTab(1);
    });
    expect(titles()).toEqual(["C:/d.md", "C:/a.md", "C:/b.md", "C:/c.md"]);
  });
});

// ─── 2. 子文件夹点击不再卡死 ────────────────────────────────

describe("v0.8.2 修复2：点击子文件夹不再卡死（渲染期 setState 无限循环）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStores();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("展开含子目录的文件夹：不抛 Too many re-renders，子节点容器正常出现", () => {
    useFileStore.getState().addOpenFolder("/p/root");
    useFileStore.getState().updateFolderTree("/p/root", [
      { name: "sub", path: "/p/root/sub", isDir: true, size: 0 },
      { name: "a.md", path: "/p/root/a.md", isDir: false, size: 10 },
    ]);

    const { container } = render(createElement(FileTree));
    const subNode = Array.from(container.querySelectorAll(".filetree-node")).find(
      (el) => el.getAttribute("title") === "/p/root/sub",
    ) as HTMLElement;
    expect(subNode).toBeTruthy();

    const errors: unknown[][] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    act(() => {
      subNode.click();
    });
    console.error = orig;

    // 关键回归：不得出现无限循环报错
    expect(
      errors.map((a) => String(a[0])).join("\n"),
    ).not.toContain("Too many re-renders");
    // 展开态生效：子节点动画容器出现
    expect(container.querySelector(".filetree-arrow.expanded")).not.toBeNull();
    expect(
      container.querySelectorAll(".filetree-children-slide, .filetree-children-slide-out")
        .length,
    ).toBe(1);
  });

  it("收起已展开的文件夹：容器进入滑出动画，播完卸载", () => {
    useFileStore.getState().addOpenFolder("/p/root");
    useFileStore.getState().updateFolderTree("/p/root", [
      { name: "sub", path: "/p/root/sub", isDir: true, size: 0 },
    ]);
    const { container } = render(createElement(FileTree));
    const subNode = () =>
      Array.from(container.querySelectorAll(".filetree-node")).find(
        (el) => el.getAttribute("title") === "/p/root/sub",
      ) as HTMLElement;

    act(() => {
      subNode().click();
    });
    expect(container.querySelector(".filetree-children-slide")).not.toBeNull();

    act(() => {
      subNode().click();
    });
    // 收起：先滑出（保留内容），动画时长后才卸载
    expect(container.querySelector(".filetree-children-slide-out")).not.toBeNull();
    act(() => vi.advanceTimersByTime(600));
    expect(container.querySelector(".filetree-children-slide-out")).toBeNull();
  });

  it("源码接线：TreeChildrenWrap 的状态更新全部在 effect 内（不得渲染期 setState）", () => {
    const wrapSrc = fileTreeSrc
      .slice(
        fileTreeSrc.indexOf("function TreeChildrenWrap"),
        fileTreeSrc.indexOf("export function makeTreeChildrenWrap"),
      )
      .replace(/\r\n/g, "\n");
    // setRendered(true) 必须被 useEffect 包裹
    expect(wrapSrc).toContain("useEffect(() => {\n    if (visible) setRendered(true);\n  }, [visible]);");
    // 渲染期不得再出现裸的 setRendered / 快照赋值
    const renderBody = wrapSrc.slice(wrapSrc.indexOf("if (!rendered) return null;"));
    expect(renderBody).not.toContain("setRendered(");
    expect(renderBody).not.toContain("snapshotRef.current =");
  });
});

// ─── 3. 标题栏「新建文件夹」走应用内弹框 ─────────────────────

describe("v0.8.2 修复3：标题栏「新建 > 新建文件夹」打开应用内弹框", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStores();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("App 不再使用原生 prompt/save 实现新建文件夹，而是派发命令", () => {
    expect(appSrc).toContain('new CustomEvent("lightmd:command", { detail: { id: "filetree.newFolder" } })');
    const handler = appSrc.slice(
      appSrc.indexOf("const handleNewFolder = useCallback"),
      appSrc.indexOf("// ─── 标签页关闭回调"),
    );
    expect(handler).not.toContain("prompt(");
    expect(handler).not.toContain("fileService.createDir");
  });

  it("FileTree 监听该命令并打开 NewFolderDialog（居中遮罩 + 名称 + 路径）", () => {
    expect(fileTreeSrc).toContain('const CMD_NEW_FOLDER = "filetree.newFolder";');
    expect(fileTreeSrc).toContain("detail?.id === CMD_NEW_FOLDER");

    render(createElement(FileTree));
    expect(document.querySelector(".newfolder-dialog")).toBeNull();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("lightmd:command", { detail: { id: "filetree.newFolder" } }),
      );
    });
    const dialog = document.querySelector(".newfolder-dialog");
    expect(dialog).not.toBeNull();
    // 遮罩层：fixed + 全屏 + flex 居中（弹框显示在屏幕中间）
    const overlay = document.querySelector(".newfolder-overlay") as HTMLElement;
    expect(overlay).not.toBeNull();
    // 名称输入 + 自定义路径输入
    expect(dialog!.querySelector("#newfolder-name")).not.toBeNull();
    expect(dialog!.querySelector("#newfolder-path")).not.toBeNull();
  });

  it("弹框遮罩 CSS 为 fixed 全屏居中", () => {
    const css = readFileSync(
      resolve(__dirname, "../components/dialogs/NewFolderDialog.css"),
      "utf-8",
    );
    expect(css).toMatch(/\.newfolder-overlay \{[^}]*position: fixed;/s);
    expect(css).toMatch(/\.newfolder-overlay \{[^}]*inset: 0;/s);
    expect(css).toMatch(/\.newfolder-overlay \{[^}]*align-items: center;/s);
    expect(css).toMatch(/\.newfolder-overlay \{[^}]*justify-content: center;/s);
  });

  it("只有一个已打开文件夹时默认勾选它（用户只需输入名称）", () => {
    useFileStore.getState().addOpenFolder("D:/only");
    render(createElement(FileTree));
    act(() => {
      window.dispatchEvent(
        new CustomEvent("lightmd:command", { detail: { id: "filetree.newFolder" } }),
      );
    });
    const boxes = Array.from(
      document.querySelectorAll(".newfolder-target-item input[type=checkbox]"),
    ) as HTMLInputElement[];
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.checked).toBe(true);
  });
});

// ─── 4. 拖拽兜底（"偶尔拖不动"） ─────────────────────────────

describe("v0.8.2 修复4：侧栏拖拽兜底清理（防监听器残留导致拖不动）", () => {
  const hookSrc = readFileSync(
    resolve(__dirname, "../hooks/useSectionSplit.ts"),
    "utf-8",
  );

  it("拖拽中检测到按键已松开 → 立即清理监听与 section-dragging 标记", () => {
    expect(hookSrc).toContain("if (ev.buttons === 0)");
    // handleUp 必须同时清理监听、光标、选区与 section-dragging
    const upSrc = hookSrc.slice(
      hookSrc.indexOf("const handleUp = () =>"),
      hookSrc.indexOf("const handleMove = (ev: MouseEvent) =>"),
    );
    expect(upSrc).toContain('document.removeEventListener("mousemove", handleMove)');
    expect(upSrc).toContain('document.removeEventListener("mouseup", handleUp)');
    expect(upSrc).toContain('window.removeEventListener("blur", handleUp)');
    expect(upSrc).toContain('document.body.style.cursor = ""');
    expect(upSrc).toContain('document.body.style.userSelect = ""');
    expect(upSrc).toContain('document.body.classList.remove("section-dragging")');
  });

  it("窗口失焦兜底：blur 监听成对注册/注销", () => {
    expect(hookSrc).toContain('window.addEventListener("blur", handleUp)');
    expect(hookSrc.match(/removeEventListener\("blur", handleUp\)/g)?.length).toBe(1);
  });
});

// ─── 5. 图片渲染链路 ────────────────────────────────────────

describe("v0.8.2 问题2：图片路径解析（根因：Windows 扩展长度前缀泄漏）", () => {
  it("Rust 侧 resolve_path/list_dir 剥离 \\\\?\\ 前缀", () => {
    const rustSrc = readFileSync(
      resolve(__dirname, "../../src-tauri/src/commands/file_ops.rs"),
      "utf-8",
    );
    expect(rustSrc).toContain("fn strip_extended_prefix");
    expect(rustSrc).toContain('path.strip_prefix(r"\\\\?\\")');
    expect(rustSrc).toContain('path.strip_prefix("//?/")');
    // resolve_path 必须经过剥离
    expect(rustSrc).toContain("Ok(PathBuf::from(strip_extended_prefix(&resolved.to_string_lossy())))");
  });

  it("前端兜底：stripExtendedPathPrefix 处理两种前缀形式", () => {
    expect(stripExtendedPathPrefix("//?/D:/a/b.md")).toBe("D:/a/b.md");
    expect(stripExtendedPathPrefix("\\\\?\\D:\\a\\b.md")).toBe("D:\\a\\b.md");
    // 普通路径与 UNC 路径不受影响
    expect(stripExtendedPathPrefix("D:/a/b.md")).toBe("D:/a/b.md");
    expect(stripExtendedPathPrefix("\\\\server\\share\\a.md")).toBe("\\\\server\\share\\a.md");
  });

  it("openFile 事件处理器在写入编辑器内容之前同步设置 currentDocPath", () => {
    const idxSetDocPath = appSrc.indexOf("setCurrentDocPath(detail.path)");
    const idxSetContent = appSrc.indexOf("setContent(targetContent)");
    expect(idxSetDocPath).toBeGreaterThan(-1);
    expect(idxSetContent).toBeGreaterThan(-1);
    expect(idxSetDocPath).toBeLessThan(idxSetContent);
  });

  it("文档路径变化时同步 currentDocPath（覆盖标签切换等非 openFile 路径）", () => {
    expect(appSrc).toContain("setCurrentDocPath(filePath)");
  });

  it("侧栏打开文件与菜单打开文件走同一条 openFile 事件（同一个 path）", () => {
    expect(fileTreeSrc).toContain('new CustomEvent("lightmd:openFile", {');
    expect(fileTreeSrc).toContain("detail: { path: node.path, name: node.name, content }");
  });
});
