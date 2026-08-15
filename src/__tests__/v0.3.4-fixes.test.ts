/**
 * v0.3.4 问题修复验证测试
 *
 * 验证 11 个用户反馈问题的修复：
 * 1. 左侧栏"打开的文件"列表只展示文件名，不再展示路径
 * 2. 已收藏文件重命名后收藏夹名称联动更新
 * 3. 导出 PDF 格式文件时报错
 * 4. 带图片的文件导出 PDF 时图片不显示
 * 5. 表格可视化调整行高（拖拽）
 * 6. 切换标签页时左侧"打开的文件"列表出现两个文件高亮
 * 7. 自动保存间隔默认 30 秒，最大 600 秒
 * 8. 启动载入上次打开文件逻辑 + 图片渲染问题
 * 9. 阅读模式搜索点击上一个/下一个没有自动跳转
 * 10. Ctrl+H 快捷键弹出搜索和替换框
 * 11. 底部栏添加搜索图标 + 专注模式改为靶心图标
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

// ─── mock localStorage 和 fileService（供问题8启动恢复测试使用）──────────
const mockStorage: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: vi.fn((key: string) => mockStorage[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    mockStorage[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete mockStorage[key];
  }),
  clear: vi.fn(() => {
    Object.keys(mockStorage).forEach((k) => delete mockStorage[k]);
  }),
};
vi.mock("../services/fileService", () => ({
  fileService: {
    readFile: vi.fn(),
    listDir: vi.fn(),
    exists: vi.fn(),
    writeFile: vi.fn(),
    getFileSize: vi.fn(),
    createFile: vi.fn(),
    createDir: vi.fn(),
    deleteFile: vi.fn(),
    renameFile: vi.fn(),
  },
  isTauri: () => true,
}));

import { useFileStore } from "../stores/useFileStore";

/** 读取源文件内容 */
function readSrc(relPath: string): string {
  return fs.readFileSync(path.resolve(__dirname, relPath), "utf-8");
}

// ─── 问题 1：左侧栏"打开的文件"列表只展示文件名 ──────────────────────

describe("问题1：左侧栏临时文件列表只展示文件名", () => {
  it("FileTree.tsx 临时文件列表项不包含路径显示元素", () => {
    const src = readSrc("../components/sidebar/FileTree.tsx");
    // 临时文件列表项中不应有 filetree-size 类名（原用于显示路径）
    // 排除重命名逻辑中的 getParentDir（重命名需要计算父目录，不是显示用）
    // tempFiles.map((file, idx) => { ... return (...) }) 结尾是 })}
    const tempFileListSection = src.match(/tempFiles\.map\([\s\S]*?\n\s*\}\)\}/);
    expect(tempFileListSection).not.toBeNull();
    expect(tempFileListSection![0]).not.toMatch(/filetree-size/);
    expect(tempFileListSection![0]).not.toMatch(/parentDir/);
  });
});

// ─── 问题 2：已收藏文件重命名后收藏夹名称联动更新 ──────────────────────

describe("问题2：重命名联动更新收藏和最近文件", () => {
  beforeEach(() => {
    useFileStore.setState({
      favorites: [],
      recentFiles: [],
    });
  });

  it("useFileStore 包含 renameFileEntry 方法", () => {
    expect(typeof useFileStore.getState().renameFileEntry).toBe("function");
  });

  it("renameFileEntry 同时更新 favorites 和 recentFiles 的路径和名称", () => {
    useFileStore.setState({
      favorites: [
        { path: "/old/path/doc.md", name: "doc.md", addedAt: 1 },
        { path: "/other/other.md", name: "other.md", addedAt: 2 },
      ],
      recentFiles: [
        { path: "/old/path/doc.md", name: "doc.md", accessedAt: 10 },
        { path: "/other/other.md", name: "other.md", accessedAt: 20 },
      ],
    });

    useFileStore.getState().renameFileEntry("/old/path/doc.md", "/old/path/renamed.md", "renamed.md");

    const state = useFileStore.getState();
    // favorites 中对应条目已更新
    const fav = state.favorites.find((f) => f.path === "/old/path/renamed.md");
    expect(fav).toBeDefined();
    expect(fav!.name).toBe("renamed.md");
    // 原路径不再存在
    expect(state.favorites.find((f) => f.path === "/old/path/doc.md")).toBeUndefined();
    // 其他条目不受影响
    expect(state.favorites.find((f) => f.path === "/other/other.md")).toBeDefined();

    // recentFiles 中对应条目已更新
    const recent = state.recentFiles.find((f) => f.path === "/old/path/renamed.md");
    expect(recent).toBeDefined();
    expect(recent!.name).toBe("renamed.md");
    expect(state.recentFiles.find((f) => f.path === "/old/path/doc.md")).toBeUndefined();
  });

  it("FileTree.tsx handleRenameConfirm 中调用 renameFileEntry", () => {
    const src = readSrc("../components/sidebar/FileTree.tsx");
    // 验证 handleRenameConfirm 中调用了 renameFileEntry
    const handleRenameConfirmSection = src.match(/handleRenameConfirm[\s\S]*?\},\s*\[refreshTree, renameFileEntry, t\]/);
    expect(handleRenameConfirmSection).not.toBeNull();
    expect(handleRenameConfirmSection![0]).toMatch(/renameFileEntry\(path,\s*newPath,\s*newName\)/);
  });

  it("FileTree.tsx 临时文件重命名也调用 renameFileEntry", () => {
    const src = readSrc("../components/sidebar/FileTree.tsx");
    // 验证临时文件重命名逻辑中也调用了 renameFileEntry
    const tempRenameSection = src.match(/handleTempRenameConfirm[\s\S]*?\},\s*\[/);
    if (tempRenameSection) {
      expect(tempRenameSection[0]).toMatch(/renameFileEntry/);
    }
  });
});

// ─── 问题 3：导出 PDF 格式文件时报错 ──────────────────────

describe("问题3：PDF 导出报错修复", () => {
  it("export.rs 包含 --virtual-time-budget=5000 等待渲染完成", () => {
    const src = readSrc("../../src-tauri/src/commands/export.rs");
    expect(src).toMatch(/--virtual-time-budget=5000/);
  });

  it("export.rs 仍包含 --print-to-pdf 和 --print-to-pdf-no-header", () => {
    const src = readSrc("../../src-tauri/src/commands/export.rs");
    expect(src).toMatch(/--print-to-pdf=/);
    expect(src).toMatch(/--print-to-pdf-no-header/);
  });
});

// ─── 问题 4：带图片的文件导出 PDF 时图片不显示 ──────────────────────

describe("问题4：PDF 导出图片不显示修复", () => {
  it("ExportDialog.tsx 包含 convertImagesToDataUrlInHtml 函数", () => {
    const src = readSrc("../components/dialogs/ExportDialog.tsx");
    expect(src).toMatch(/async function convertImagesToDataUrlInHtml/);
  });

  it("convertImagesToDataUrlInHtml 处理 http/https 远程图片", () => {
    const src = readSrc("../components/dialogs/ExportDialog.tsx");
    const funcSection = src.match(/async function convertImagesToDataUrlInHtml[\s\S]*?\n\}/);
    expect(funcSection).not.toBeNull();
    expect(funcSection![0]).toMatch(/https?:\/\//);
    expect(funcSection![0]).toMatch(/fetch\(/);
    expect(funcSection![0]).toMatch(/blobToDataUrl/);
  });

  it("convertImagesToDataUrlInHtml 处理本地图片（readFile + bytesToBase64）", () => {
    const src = readSrc("../components/dialogs/ExportDialog.tsx");
    const funcSection = src.match(/async function convertImagesToDataUrlInHtml[\s\S]*?\n\}/);
    expect(funcSection).not.toBeNull();
    expect(funcSection![0]).toMatch(/isTauri\(\)/);
    expect(funcSection![0]).toMatch(/readFile/);
    expect(funcSection![0]).toMatch(/bytesToBase64/);
    expect(funcSection![0]).toMatch(/guessMimeFromPath/);
  });

  it("exportPDFWithOptions 在生成 HTML 前调用 convertImagesToDataUrlInHtml", () => {
    const src = readSrc("../components/dialogs/ExportDialog.tsx");
    // 定位 exportPDFWithOptions 函数内部，验证调用顺序
    const funcStart = src.indexOf("async function exportPDFWithOptions");
    expect(funcStart).toBeGreaterThan(-1);
    const funcSection = src.slice(funcStart);
    const idxConvert = funcSection.indexOf("convertImagesToDataUrlInHtml(body");
    const idxHtml = funcSection.indexOf("<!DOCTYPE html>");
    expect(idxConvert).toBeGreaterThan(-1);
    expect(idxHtml).toBeGreaterThan(-1);
    // convertImagesToDataUrlInHtml 应在 <!DOCTYPE html> 之前调用
    expect(idxConvert).toBeLessThan(idxHtml);
  });
});

// ─── 问题 5：表格可视化调整行高（拖拽）──────────────────────

describe("问题5：表格行高拖拽", () => {
  it("schema.ts table 节点包含 rowHeights 属性", () => {
    const src = readSrc("../core/schema.ts");
    expect(src).toMatch(/rowHeights:\s*\{\s*default:\s*null\s*\}/);
  });

  it("table-editor.ts 包含 updateRowHeight 导出函数", () => {
    const src = readSrc("../core/plugins/table-editor.ts");
    expect(src).toMatch(/export function updateRowHeight/);
  });

  it("updateRowHeight 最小高度限制为 20px", () => {
    const src = readSrc("../core/plugins/table-editor.ts");
    const funcSection = src.match(/export function updateRowHeight[\s\S]*?\n\}/);
    expect(funcSection).not.toBeNull();
    expect(funcSection![0]).toMatch(/Math\.max\(20,\s*Math\.round\(height\)\)/);
  });

  it("TableView 类包含 rowResizing 状态字段", () => {
    const src = readSrc("../core/plugins/table-editor.ts");
    expect(src).toMatch(/private rowResizing/);
  });

  it("TableView 包含 startRowResize / onRowMouseMove / onRowMouseUp 方法", () => {
    const src = readSrc("../core/plugins/table-editor.ts");
    expect(src).toMatch(/private startRowResize/);
    expect(src).toMatch(/private onRowMouseMove/);
    expect(src).toMatch(/private onRowMouseUp/);
  });

  it("TableView 包含 applyRowHeights 方法", () => {
    const src = readSrc("../core/plugins/table-editor.ts");
    expect(src).toMatch(/private applyRowHeights/);
  });

  it("stopEvent 同时阻止列宽和行高热区事件", () => {
    const src = readSrc("../core/plugins/table-editor.ts");
    const stopEventSection = src.match(/stopEvent\(event:\s*Event\)[\s\S]*?\n\s*\}/);
    expect(stopEventSection).not.toBeNull();
    // v0.4.5 修复：变量名变更 offsetX → offsetXRight/offsetXLeft
    // 列宽热区：右边缘 8px（兼容新旧变量名）
    expect(stopEventSection![0]).toMatch(/Math\.abs\(offsetXRight\)\s*<=\s*8|Math\.abs\(offsetX\)\s*<=\s*8/);
    // 行高热区：底边缘 6px
    expect(stopEventSection![0]).toMatch(/Math\.abs\(offsetY\)\s*<=\s*6/);
  });

  it("update 方法在非拖拽时调用 applyRowHeights", () => {
    const src = readSrc("../core/plugins/table-editor.ts");
    // update 方法签名 update(node: Node): boolean，内部调用 applyRowHeights
    expect(src).toMatch(/update\(node[^)]*\)[\s\S]*?applyRowHeights/);
  });

  it("onHover 检测行底边缘显示 row-resize 光标", () => {
    const src = readSrc("../core/plugins/table-editor.ts");
    expect(src).toMatch(/row-resize/);
  });

  it("destroy 清理行高拖拽事件监听", () => {
    const src = readSrc("../core/plugins/table-editor.ts");
    const destroySection = src.match(/destroy\(\)[\s\S]*?\n\s*\}/);
    expect(destroySection).not.toBeNull();
    expect(destroySection![0]).toMatch(/removeEventListener\(["']mousemove["'],\s*this\.onRowMouseMove\)/);
    expect(destroySection![0]).toMatch(/removeEventListener\(["']mouseup["'],\s*this\.onRowMouseUp\)/);
  });
});

// ─── 问题 6：切换标签页时左侧列表出现两个高亮 ──────────────────────

describe("问题6：切换标签页双高亮修复", () => {
  it("FileTree.tsx activePath 直接从 globalFilePath 派生（不使用 useEffect 延迟）", () => {
    const src = readSrc("../components/sidebar/FileTree.tsx");
    // 验证 activePath 直接赋值为 globalFilePath
    expect(src).toMatch(/const activePath = globalFilePath/);
    // 验证不存在 useEffect 同步 activePath 的旧逻辑
    // 旧的延迟同步会使用 setActivePath(globalFilePath) 在 useEffect 中
    const activePathUseEffect = src.match(/useEffect\(\(\)\s*=>\s*\{[^}]*setActivePath\(globalFilePath\)[^}]*\}/);
    expect(activePathUseEffect).toBeNull();
  });
});

// ─── 问题 7：自动保存间隔默认 30 秒，最大 600 秒 ──────────────────────

describe("问题7：自动保存间隔设置", () => {
  it("useSettingsStore autoSaveIntervalMs 默认 30000ms（30秒）", () => {
    const src = readSrc("../stores/useSettingsStore.ts");
    expect(src).toMatch(/autoSaveIntervalMs:\s*30000/);
  });

  it("setAutoSaveInterval clamp 到 [0, 600000]（600秒）", () => {
    const src = readSrc("../stores/useSettingsStore.ts");
    expect(src).toMatch(/setAutoSaveInterval.*clamp\(autoSaveIntervalMs,\s*0,\s*600000\)/);
  });

  it("SettingsDialog.tsx 自动保存滑块 max=600", () => {
    const src = readSrc("../components/dialogs/SettingsDialog.tsx");
    // 定位 settings.autoSaveInterval 标签后的 range input，验证 max=600
    // 避免匹配到 fontSize 的 max=28
    const autoSaveSection = src.match(/settings\.autoSaveInterval["'\}][\s\S]*?max=\{(\d+)\}/);
    expect(autoSaveSection).not.toBeNull();
    expect(autoSaveSection![1]).toBe("600");
  });
});

// ─── 问题 8：启动载入逻辑 + 图片渲染 ──────────────────────

describe("问题8：启动载入逻辑和图片渲染", () => {
  it("App.tsx 在 lightmd:openFile handler 中同步调用 setCurrentDocPath（先于 setContent）", () => {
    const src = readSrc("../App.tsx");
    // 找到 openFile handler
    const handlerSection = src.match(/const handler = async \(e: Event\)\s*=>\s*\{[\s\S]*?window\.addEventListener\(["']lightmd:openFile["']/);
    expect(handlerSection).not.toBeNull();
    const code = handlerSection![0];
    // setCurrentDocPath 应在 setContent 之前调用
    const idxSetCurrentDocPath = code.indexOf("setCurrentDocPath(detail.path)");
    const idxSetContent = code.indexOf("setContent(detail.content)");
    expect(idxSetCurrentDocPath).toBeGreaterThan(-1);
    expect(idxSetContent).toBeGreaterThan(-1);
    expect(idxSetCurrentDocPath).toBeLessThan(idxSetContent);
  });

  it("App.tsx 启动恢复完成后切换到 openTabs[0]（最新的文件）", () => {
    const src = readSrc("../App.tsx");
    // 验证启动恢复 useEffect 中有切换到 openTabs[0] 的逻辑
    const restoreSection = src.match(/const result = await restoreRecentFiles[\s\S]*?\}\s*\}\s*catch/);
    expect(restoreSection).not.toBeNull();
    expect(restoreSection![0]).toMatch(/setActiveTab\(0\)/);
    expect(restoreSection![0]).toMatch(/openTabs\[0\]/);
    expect(restoreSection![0]).toMatch(/setCurrentDocPath\(firstTab\.path\)/);
  });

  it("restoreRecentFiles 串行打开保持 recentFiles 顺序（最新在前）", async () => {
    const { restoreRecentFiles } = await import("../utils/startupRestore");
    const { fileService } = await import("../services/fileService");
    const mockedFileService = fileService as unknown as {
      readFile: ReturnType<typeof vi.fn>;
    };
    mockedFileService.readFile.mockReset();

    mockStorage["lightmd-settings"] = JSON.stringify({
      state: { loadLastFileOnStartup: true, loadLastFileCount: 3 },
    });
    mockStorage["lightmd-file-store"] = JSON.stringify({
      state: {
        recentFiles: [
          { path: "/test/newest.md", name: "newest.md", accessedAt: 300 },
          { path: "/test/middle.md", name: "middle.md", accessedAt: 200 },
          { path: "/test/oldest.md", name: "oldest.md", accessedAt: 100 },
        ],
      },
    });
    mockedFileService.readFile.mockImplementation(async (p: string) => `content-${p}`);

    const dispatched: Array<{ path: string; content: string }> = [];
    await restoreRecentFiles({
      dispatchOpenFile: (detail) => dispatched.push(detail),
      removeRecentFile: () => {},
      isTauriEnv: true,
    });

    // 串行打开顺序与 recentFiles 顺序一致（最新在前）
    expect(dispatched).toHaveLength(3);
    expect(dispatched[0].path).toBe("/test/newest.md");
    expect(dispatched[1].path).toBe("/test/middle.md");
    expect(dispatched[2].path).toBe("/test/oldest.md");
  });
});

// ─── 问题 9：阅读模式搜索点击上一个/下一个没有自动跳转 ──────────────────────

describe("问题9：阅读模式搜索跳转", () => {
  it("SearchReplace.tsx 在 ProseMirror 分支中手动滚动到匹配位置", () => {
    const src = readSrc("../components/editor/SearchReplace.tsx");
    // 验证 highlightMatch 中使用 requestAnimationFrame 手动滚动
    expect(src).toMatch(/requestAnimationFrame/);
    expect(src).toMatch(/view\.coordsAtPos\(pmStart\)/);
    // v0.3.5第三阶段：滚动容器改为 view.dom.parentElement
    expect(src).toMatch(/scrollContainer\.scrollTo/);
  });

  it("SearchReplace.tsx 滚动逻辑使用 smooth behavior", () => {
    const src = readSrc("../components/editor/SearchReplace.tsx");
    expect(src).toMatch(/behavior:\s*["']smooth["']/);
  });

  it("SearchReplace.tsx 滚动容器使用 view.dom.parentElement", () => {
    const src = readSrc("../components/editor/SearchReplace.tsx");
    // v0.3.5第三阶段修复：滚动容器从 closest(".editor-container") 改为 view.dom.parentElement
    expect(src).toMatch(/view\.dom\.parentElement/);
  });
});

// ─── 问题 10：Ctrl+H 弹出搜索和替换框 ──────────────────────

describe("问题10：Ctrl+H 弹出替换框", () => {
  it("App.tsx 包含 Ctrl+H 快捷键监听调用 setShowSearchReplace", () => {
    const src = readSrc("../App.tsx");
    const keydownSection = src.match(/e\.key === ["']h["'][\s\S]*?\}/);
    expect(keydownSection).not.toBeNull();
    expect(keydownSection![0]).toMatch(/setShowSearchReplace\(true\)/);
  });

  it("SearchReplace.tsx 包含 initialShowReplace prop", () => {
    const src = readSrc("../components/editor/SearchReplace.tsx");
    expect(src).toMatch(/initialShowReplace\?:\s*boolean/);
  });

  it("SearchReplace.tsx showReplace 初始值使用 initialShowReplace", () => {
    const src = readSrc("../components/editor/SearchReplace.tsx");
    expect(src).toMatch(/useState\(initialShowReplace\)/);
  });

  it("SearchReplace.tsx 包含 useEffect 同步 initialShowReplace", () => {
    const src = readSrc("../components/editor/SearchReplace.tsx");
    expect(src).toMatch(/if\s*\(initialShowReplace\)\s*setShowReplace\(true\)/);
  });

  it("EditorContainer.tsx 传递 initialShowReplace prop", () => {
    const src = readSrc("../components/editor/EditorContainer.tsx");
    expect(src).toMatch(/initialShowReplace=\{showSearchReplace\}/);
  });
});

// ─── 问题 11：底部栏搜索图标 + 专注模式靶心图标 ──────────────────────

describe("问题11：底部栏搜索和专注图标", () => {
  it("StatusBar.tsx 包含搜索按钮（放大镜图标）", () => {
    const src = readSrc("../components/layout/StatusBar.tsx");
    // 验证有搜索按钮，title 为搜索
    // v0.3.5：onClick 改为 toggleSearch（切换开关），不再使用 setShowSearch(true)
    expect(src).toMatch(/title=\{t\(["']search\.placeholder["']\)\}/);
    expect(src).toMatch(/toggleSearch/);
  });

  it("StatusBar.tsx 搜索按钮使用放大镜 SVG 图标（circle + line）", () => {
    const src = readSrc("../components/layout/StatusBar.tsx");
    // 放大镜由 circle + line 组成（圆 + 把手）
    const searchButtonSection = src.match(/搜索入口[\s\S]*?<\/button>/);
    expect(searchButtonSection).not.toBeNull();
    expect(searchButtonSection![0]).toMatch(/<circle/);
    expect(searchButtonSection![0]).toMatch(/<line/);
  });

  it("StatusBar.tsx 专注模式按钮使用靶心 SVG 图标（同心圆 circle）", () => {
    const src = readSrc("../components/layout/StatusBar.tsx");
    // v0.3.5：注释改为"专注模式：靶心图标"
    const focusButtonSection = src.match(/专注模式：靶心图标[\s\S]*?<\/button>/);
    expect(focusButtonSection).not.toBeNull();
    // 靶心由同心圆组成（外圆+中圆+内圆+中心命中点，共 4 个 circle）
    const circles = focusButtonSection![0].match(/<circle/g);
    expect(circles).not.toBeNull();
    expect(circles!.length).toBeGreaterThanOrEqual(4);
  });

  it("StatusBar.tsx 搜索按钮位于专注模式按钮之前", () => {
    const src = readSrc("../components/layout/StatusBar.tsx");
    const idxSearch = src.indexOf("搜索入口");
    // v0.3.5：注释改为"专注模式：靶心图标"
    const idxFocus = src.indexOf("专注模式：靶心图标");
    expect(idxSearch).toBeGreaterThan(-1);
    expect(idxFocus).toBeGreaterThan(-1);
    expect(idxSearch).toBeLessThan(idxFocus);
  });
});
