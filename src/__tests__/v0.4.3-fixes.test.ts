/**
 * v0.4.3 问题修复验证测试
 *
 * 验证 3 个用户反馈问题的修复：
 * 1. 表格列宽拖拽无反应（table.style.width 设为 auto 替代固定 tableStartWidth）
 * 2. 左侧文件管理标题栏增加全局搜索功能
 * 3. 非 md 文件阅读模式搜索无法高亮选中（TreeWalker + Range 在 .plaintext-preview 中高亮）
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

/** 读取源文件内容 */
function readSrc(relPath: string): string {
  return fs.readFileSync(path.resolve(__dirname, relPath), "utf-8");
}

// ─── Issue 1：表格列宽拖拽修复（v0.4.4 改为 table.width = cellWidthSum） ──────────────────────

describe("Issue 1：表格列宽拖拽（table width = newWidths 之和）", () => {
  it("onMouseMove 中 table.style.width 设为 newWidths 之和而非 auto", () => {
    const src = readSrc("../core/plugins/table-editor.ts");
    const onMouseMoveSection = src.match(/private onMouseMove = \(e: MouseEvent\) =>[\s\S]*?  \};/);
    expect(onMouseMoveSection).not.toBeNull();
    // v0.4.4 修复：使用 newWidths 之和替代 width:auto，避免表格坍缩
    expect(onMouseMoveSection![0]).toMatch(/totalWidth\s*=\s*newWidths\.reduce/);
    expect(onMouseMoveSection![0]).toMatch(/contentDOM\.style\.width\s*=\s*`\$\{totalWidth\}px`/);
    // 不应使用 width:auto
    expect(onMouseMoveSection![0]).not.toMatch(/["']auto["']/);
    // 不应再使用 tableStartWidth 设置固定宽度
    expect(onMouseMoveSection![0]).not.toMatch(/tableStartWidth/);
  });

  it("resizing 状态不再包含 tableStartWidth 字段", () => {
    const src = readSrc("../core/plugins/table-editor.ts");
    // resizing 接口中不应有 tableStartWidth
    const resizingMatch = src.match(/private resizing:\s*\{[\s\S]*?\}\s*\|\s*null/);
    expect(resizingMatch).not.toBeNull();
    expect(resizingMatch![0]).not.toMatch(/tableStartWidth/);
  });

  it("startResize 使用 Math.round 取整 startWidths", () => {
    const src = readSrc("../core/plugins/table-editor.ts");
    const startResizeSection = src.match(/private startResize[\s\S]*?\n  \}/);
    expect(startResizeSection).not.toBeNull();
    expect(startResizeSection![0]).not.toMatch(/tableStartWidth/);
    expect(startResizeSection![0]).not.toMatch(/offsetWidth/);
    // v0.4.4：Math.round 确保整数像素
    expect(startResizeSection![0]).toMatch(/Math\.round\(c\.getBoundingClientRect\(\)\.width\)/);
  });

  it("applyColumnWidths 设置 table width 为 widths 之和", () => {
    const src = readSrc("../core/plugins/table-editor.ts");
    const applySection = src.match(/private applyColumnWidths\(node: Node\)[\s\S]*?\n  \}/);
    expect(applySection).not.toBeNull();
    // v0.4.4：widths 之和替代 width:auto
    expect(applySection![0]).toMatch(/totalWidth\s*=\s*widths\.reduce/);
    expect(applySection![0]).toMatch(/\$\{totalWidth\}px/);
    expect(applySection![0]).not.toMatch(/["']auto["']/);
  });
});

// ─── Issue 2：全局文件搜索功能 ──────────────────────

describe("Issue 2：文件管理标题栏全局搜索", () => {
  it("FileTree.tsx 包含搜索状态 showSearch 和 searchQuery", () => {
    const src = readSrc("../components/sidebar/FileTree.tsx");
    expect(src).toMatch(/showSearch/);
    expect(src).toMatch(/searchQuery/);
    expect(src).toMatch(/searchInputRef/);
  });

  it("FileTree.tsx 包含 searchResults useMemo 搜索逻辑", () => {
    const src = readSrc("../components/sidebar/FileTree.tsx");
    expect(src).toMatch(/const searchResults = useMemo/);
    // 递归遍历文件树
    expect(src).toMatch(/node\.name\.toLowerCase\(\)\.includes\(query\)/);
    // 搜索临时文件
    expect(src).toMatch(/tempFiles/);
    // 搜索收藏文件
    expect(src).toMatch(/favorites/);
  });

  it("FileTree.tsx 包含搜索按钮 UI", () => {
    const src = readSrc("../components/sidebar/FileTree.tsx");
    // 搜索按钮的 onClick 切换 showSearch
    expect(src).toMatch(/setShowSearch\(\(v\) => !v\)/);
    expect(src).toMatch(/filetree\.searchTitle/);
  });

  it("FileTree.tsx 包含搜索面板 UI（输入框 + 结果列表）", () => {
    const src = readSrc("../components/sidebar/FileTree.tsx");
    expect(src).toMatch(/filetree-search-panel/);
    expect(src).toMatch(/filetree-search-input/);
    expect(src).toMatch(/filetree-search-results/);
    expect(src).toMatch(/handleSearchResultClick/);
  });

  it("FileTree.css 包含搜索面板样式", () => {
    const src = readSrc("../components/sidebar/FileTree.css");
    expect(src).toMatch(/\.filetree-search-panel/);
    expect(src).toMatch(/\.filetree-search-input/);
    expect(src).toMatch(/\.filetree-search-results/);
    expect(src).toMatch(/\.filetree-search-result/);
  });

  it("i18n 包含搜索相关文案", () => {
    const zhSrc = readSrc("../i18n/locales/zh-CN.ts");
    expect(zhSrc).toMatch(/filetree\.searchTitle/);
    expect(zhSrc).toMatch(/filetree\.searchPlaceholder/);
    expect(zhSrc).toMatch(/filetree\.searchNoResult/);

    const enSrc = readSrc("../i18n/locales/en-US.ts");
    expect(enSrc).toMatch(/filetree\.searchTitle/);
    expect(enSrc).toMatch(/filetree\.searchPlaceholder/);
    expect(enSrc).toMatch(/filetree\.searchNoResult/);
  });
});

// ─── Issue 3：非 md 文件阅读模式搜索高亮 ──────────────────────

describe("Issue 3：非 md 文件阅读模式搜索高亮", () => {
  it("SearchReplace.tsx highlightMatch 包含非 md 文件阅读模式分支", () => {
    const src = readSrc("../components/editor/SearchReplace.tsx");
    // 检测 !isMdFile && viewMode === "preview" 分支
    expect(src).toMatch(/!isMdFile && viewMode === ["']preview["']/);
    // 使用 .plaintext-preview 容器
    expect(src).toMatch(/\.plaintext-preview/);
  });

  it("highlightMatch 使用 TreeWalker 遍历文本节点定位匹配位置", () => {
    const src = readSrc("../components/editor/SearchReplace.tsx");
    expect(src).toMatch(/createTreeWalker/);
    expect(src).toMatch(/NodeFilter\.SHOW_TEXT/);
    expect(src).toMatch(/startNode/);
    expect(src).toMatch(/endNode/);
  });

  it("highlightMatch 使用 Range + window.getSelection 高亮选区", () => {
    const src = readSrc("../components/editor/SearchReplace.tsx");
    expect(src).toMatch(/document\.createRange/);
    expect(src).toMatch(/range\.setStart/);
    expect(src).toMatch(/range\.setEnd/);
    expect(src).toMatch(/window\.getSelection\(\)/);
    expect(src).toMatch(/addRange/);
  });

  it("performSearch 清除时也清除非 md 文件阅读模式的选区", () => {
    const src = readSrc("../components/editor/SearchReplace.tsx");
    // 在 performSearch 的清除逻辑中，非 md 文件 + preview 模式时 removeAllRanges
    const performSearchSection = src.match(/const performSearch = useCallback[\s\S]*?\}, \[[\s\S]*?\]\);/);
    expect(performSearchSection).not.toBeNull();
    expect(performSearchSection![0]).toMatch(/!isMdFile && viewMode === ["']preview["']/);
    expect(performSearchSection![0]).toMatch(/removeAllRanges/);
  });

  it("组件卸载时清除非 md 文件的选区高亮", () => {
    const src = readSrc("../components/editor/SearchReplace.tsx");
    // 卸载 useEffect 中清除选区
    const unmountSection = src.match(/组件卸载时清除[\s\S]*?\}, \[editorView, isSourceMode, isMdFile\]\)/);
    expect(unmountSection).not.toBeNull();
    expect(unmountSection![0]).toMatch(/!isMdFile/);
    expect(unmountSection![0]).toMatch(/removeAllRanges/);
  });

  // v0.4.4 修复：performSearch 中规范化换行符 \r\n → \n
  it("performSearch 规范化 sourceContent 的换行符（v0.4.4 修复高亮位置偏移）", () => {
    const src = readSrc("../components/editor/SearchReplace.tsx");
    const performSearchSection = src.match(/const performSearch = useCallback[\s\S]*?\}, \[[\s\S]*?\]\);/);
    expect(performSearchSection).not.toBeNull();
    // 验证 isSourceMode 分支中有换行符规范化：\r\n → \n 和 \r → \n
    expect(performSearchSection![0]).toMatch(/replace\(.\\r\\n./);
    expect(performSearchSection![0]).toMatch(/replace\(.\\r./);
  });
});
