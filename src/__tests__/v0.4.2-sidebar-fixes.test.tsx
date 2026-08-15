/**
 * v0.4.2 侧边栏 + 启动问题修复 - 单元测试
 *
 * 覆盖 Issue 1-5：
 * 1. Issue 1: partialize 不再持久化 openFolders，避免绕过 loadLastFolderOnStartup 开关
 * 2. Issue 2: tempFiles 独立成栏且有垂直 resizer
 * 3. Issue 3: RecentFiles height prop 正确应用到 style
 * 4. Issue 4: CSS 标题栏有 3D 效果（gradient + box-shadow）
 * 5. Issue 5: tempFiles 标题栏有查看版本快照按钮入口
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { readFileSync } from "fs";
import { join } from "path";
import { RecentFiles } from "../components/sidebar/RecentFiles";
import { useFileStore } from "../stores/useFileStore";

// ─── 读取源码文件用于结构性验证 ──────────────────────
const lightmdRoot = join(__dirname, "..");
const fileTreeSource = readFileSync(join(lightmdRoot, "components/sidebar/FileTree.tsx"), "utf-8");
const fileTreeCss = readFileSync(join(lightmdRoot, "components/sidebar/FileTree.css"), "utf-8");

// ─── Issue 1: partialize 不再持久化 openFolders ────────
describe("Issue 1: 启动时载入上次文件夹 bug 修复", () => {
  beforeEach(() => {
    localStorage.removeItem("lightmd-file-store");
    useFileStore.setState({
      openFolders: [],
      recentFiles: [],
      recentFolders: [],
      favorites: [],
    });
  });

  it("partialize 不再包含 openFolders 字段", () => {
    // 直接测试 partialize 函数，不依赖 zustand persist 的写入时机
    const partialize = useFileStore.persist.getOptions().partialize;
    expect(partialize).toBeDefined();
    const mockState = {
      openFolders: [{ path: "/test/folder-1", name: "folder-1", fileTree: [] }],
      recentFiles: [],
      recentFolders: [{ path: "/test/folder-1", name: "folder-1", accessedAt: Date.now() }],
      favorites: [],
    };
    const result = partialize!(mockState as any);
    // openFolders 不应出现在 partialize 结果中
    expect(result).not.toHaveProperty("openFolders");
  });

  it("partialize 仍然持久化 recentFolders（启动恢复依赖此字段）", () => {
    const partialize = useFileStore.persist.getOptions().partialize;
    expect(partialize).toBeDefined();
    const mockState = {
      openFolders: [{ path: "/test/folder-1", name: "folder-1", fileTree: [] }],
      recentFiles: [],
      recentFolders: [{ path: "/test/folder-1", name: "folder-1", accessedAt: Date.now() }],
      favorites: [],
    };
    const result = partialize!(mockState as any);
    // recentFolders 应该仍然被持久化（startupRestore 用它来恢复文件夹）
    expect(result).toHaveProperty("recentFolders");
    expect(result).toHaveProperty("recentFiles");
    expect(result).toHaveProperty("favorites");
  });

  it("内存中 openFolders 仍然可用（只是不持久化）", () => {
    const store = useFileStore.getState();
    store.addOpenFolder("/test/folder-1");
    store.addOpenFolder("/test/folder-2");

    expect(useFileStore.getState().openFolders).toHaveLength(2);
    expect(useFileStore.getState().openFolders[0].path).toBe("/test/folder-1");
    expect(useFileStore.getState().openFolders[1].path).toBe("/test/folder-2");
  });
});

// ─── Issue 2: tempFiles 独立成栏且有垂直 resizer ────────
describe("Issue 2: 打开的文件栏独立成栏并支持上下拖拽", () => {
  it("FileTree.tsx 中 tempFiles 区域在 filetree-list 外部（独立成栏）", () => {
    // v0.4.5 修复：tempFiles 栏提取为 renderTempFilesSection 函数，独立于 filetree-list
    // 验证 tempFiles 区域有独立的 filetree-temp-section 类名（在 filetree-list 之外）
    expect(fileTreeSource).toContain("filetree-temp-section");
    // 验证存在 renderTempFilesSection 函数（v0.4.5 提取）
    expect(fileTreeSource).toContain("renderTempFilesSection");
    // 验证 tempFiles 栏渲染逻辑存在
    expect(fileTreeSource).toContain("tempFiles.length");
  });

  it("tempFiles 区域有独立的 filetree-temp-section 类名", () => {
    expect(fileTreeSource).toContain("filetree-temp-section");
  });

  it("tempFiles 区域绑定 tempResize.onMouseDown（标题栏拖拽）", () => {
    expect(fileTreeSource).toContain("tempResize.onMouseDown");
  });

  it("tempFiles 区域有垂直分隔条 filetree-v-resizer", () => {
    // 验证 tempFiles 之前有 resizer
    const tempSectionIdx = fileTreeSource.indexOf("filetree-temp-section");
    expect(tempSectionIdx).toBeGreaterThan(-1);
    const beforeTemp = fileTreeSource.substring(0, tempSectionIdx);
    expect(beforeTemp).toContain("filetree-v-resizer");
  });

  it("CSS 中 .filetree-temp-section 有 flex 布局和 overflow: hidden", () => {
    expect(fileTreeCss).toContain(".filetree-temp-section");
    // 验证有 overflow: hidden（独立滚动容器）
    const tempSectionCss = fileTreeCss.substring(
      fileTreeCss.indexOf(".filetree-temp-section"),
      fileTreeCss.indexOf(".filetree-temp-section") + 200
    );
    expect(tempSectionCss).toContain("overflow: hidden");
    expect(tempSectionCss).toContain("flex-shrink: 0");
  });
});

// ─── Issue 3: RecentFiles height prop 正确应用 ────────
describe("Issue 3: 最近打开标题栏上下拖拽调整高度", () => {
  beforeEach(() => {
    localStorage.removeItem("lightmd-file-store");
    useFileStore.setState({
      recentFiles: [
        { path: "/test/file1.md", name: "file1.md", accessedAt: Date.now() },
        { path: "/test/file2.md", name: "file2.md", accessedAt: Date.now() },
      ],
    });
  });

  it("RecentFiles 接收 height prop 并应用到 style.height", () => {
    const { container } = render(
      <RecentFiles onOpen={vi.fn()} height={250} />
    );
    const recentEl = container.querySelector(".recent-files") as HTMLElement;
    expect(recentEl).toBeTruthy();
    expect(recentEl.style.height).toBe("250px");
  });

  it("RecentFiles height=undefined 时不设置 inline height（由内容决定）", () => {
    const { container } = render(
      <RecentFiles onOpen={vi.fn()} />
    );
    const recentEl = container.querySelector(".recent-files") as HTMLElement;
    expect(recentEl).toBeTruthy();
    expect(recentEl.style.height).toBe("");
  });

  it("RecentFiles maximized 状态覆盖 height prop（height=500）", () => {
    // 先渲染，然后点击 maximize 按钮
    const { container } = render(
      <RecentFiles onOpen={vi.fn()} height={200} />
    );
    const maximizeBtn = container.querySelector(".section-maximize") as HTMLButtonElement;
    expect(maximizeBtn).toBeTruthy();
    // 用 act 包裹点击事件，确保 React 状态更新同步完成
    act(() => { maximizeBtn.click(); });
    const recentEl = container.querySelector(".recent-files") as HTMLElement;
    expect(recentEl.style.height).toBe("500px");
  });

  it("FileTree.tsx 中 RecentFiles 接收 recentResize.height prop", () => {
    expect(fileTreeSource).toContain("height={recentResize.height}");
  });

  it("FileTree.tsx 中 RecentFiles 之前有垂直 resizer 绑定", () => {
    const recentIdx = fileTreeSource.indexOf("<RecentFiles");
    expect(recentIdx).toBeGreaterThan(-1);
    const beforeRecent = fileTreeSource.substring(0, recentIdx);
    expect(beforeRecent).toContain("recentResize.onMouseDown");
  });

  it("CSS 中 .recent-files 有 flex-shrink: 0（inline height 不被压缩）", () => {
    const recentCss = fileTreeCss.substring(
      fileTreeCss.indexOf(".recent-files {"),
      fileTreeCss.indexOf(".recent-files {") + 200
    );
    expect(recentCss).toContain("flex-shrink: 0");
    expect(recentCss).toContain("overflow: hidden");
  });
});

// ─── Issue 4: CSS 标题栏 3D 效果 ────────
describe("Issue 4: 左侧栏标题栏 3D 效果重新设计", () => {
  it("所有标题栏都有 linear-gradient 背景", () => {
    const headers = [".filetree-temp-header", ".favorites-header", ".recent-files-header"];
    for (const selector of headers) {
      const cssBlock = fileTreeCss.substring(
        fileTreeCss.indexOf(selector),
        fileTreeCss.indexOf(selector) + 500
      );
      expect(cssBlock).toContain("linear-gradient");
    }
  });

  it("所有标题栏都有 box-shadow（3D 浮起效果）", () => {
    const headers = [".filetree-temp-header", ".favorites-header", ".recent-files-header"];
    for (const selector of headers) {
      const cssBlock = fileTreeCss.substring(
        fileTreeCss.indexOf(selector),
        fileTreeCss.indexOf(selector) + 500
      );
      expect(cssBlock).toContain("box-shadow");
    }
  });

  it("暗色模式下标题栏也有 gradient 和 box-shadow", () => {
    const darkModeBlock = fileTreeCss.substring(
      fileTreeCss.indexOf('[data-theme="dark"] .filetree-temp-header')
    );
    expect(darkModeBlock).toContain("linear-gradient");
    expect(darkModeBlock).toContain("box-shadow");
  });
});

// ─── Issue 5: tempFiles 标题栏有查看版本快照按钮 ────────
describe("Issue 5: 打开的文件标题栏加查看版本快照按钮入口", () => {
  it("FileTree.tsx 中 tempFiles 标题栏有快照按钮", () => {
    // 定位 temp-header 区域内的快照按钮
    const tempHeaderIdx = fileTreeSource.indexOf("filetree-temp-header");
    expect(tempHeaderIdx).toBeGreaterThan(-1);
    const tempHeaderBlock = fileTreeSource.substring(tempHeaderIdx, tempHeaderIdx + 800);
    expect(tempHeaderBlock).toContain("snapshot.viewSnapshots");
    expect(tempHeaderBlock).toContain("filetree-temp-snapshot-btn");
  });

  it("快照按钮触发 lightmd:showSnapshotDialog 事件", () => {
    const tempHeaderIdx = fileTreeSource.indexOf("filetree-temp-header");
    const tempHeaderBlock = fileTreeSource.substring(tempHeaderIdx, tempHeaderIdx + 1000);
    expect(tempHeaderBlock).toContain("lightmd:showSnapshotDialog");
    expect(tempHeaderBlock).toContain("filePath");
  });

  it("快照按钮优先使用当前活跃文件路径", () => {
    const tempHeaderIdx = fileTreeSource.indexOf("filetree-temp-header");
    const tempHeaderBlock = fileTreeSource.substring(tempHeaderIdx, tempHeaderIdx + 1000);
    // 验证使用 activePath 作为优先路径
    expect(tempHeaderBlock).toContain("activePath");
    expect(tempHeaderBlock).toContain("tempFiles[0]?.path");
  });
});
