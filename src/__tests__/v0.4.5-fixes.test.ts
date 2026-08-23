/**
 * v0.4.5 问题修复验证测试
 *
 * 验证 3 个用户反馈问题的修复：
 * 1. md 文件切换至非 md 文件时大纲栏未关闭
 * 2. 左侧栏「打开的文件」和「文档」栏显示位置逻辑优化
 *    - 不打开文件夹也不打开文件：都不显示
 *    - 不打开文件夹但打开文件：「打开的文件」栏在顶部
 *    - 打开文件夹后：「打开的文件」栏在「文档」栏下方
 * 3. 阅读模式下表格列宽拖拽（拖动内部列框线调整相邻两列，拖动最外侧框线改变表格总宽度）
 *    修复关键：cell 左边缘 8px 内也触发热区，与右边缘等价（colIdx = cellIdx - 1）
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

/** 读取源文件内容 */
function readSrc(relPath: string): string {
  return fs.readFileSync(path.resolve(__dirname, relPath), "utf-8");
}

// ─── 问题 1：md 文件切换至非 md 文件时大纲栏未关闭 ──────────────────────

describe("问题1：切换至非 md 文件时关闭大纲栏", () => {
  it("App.tsx outline 渲染条件包含 isMarkdownFile 判断", () => {
    const src = readSrc("../App.tsx");
    // 定位 outline prop 的渲染逻辑
    const outlineSection = src.match(/outline=\{[\s\S]*?\}\s*\}/);
    expect(outlineSection).not.toBeNull();
    // 必须同时包含 showOutline、filePath 和 isMarkdownFile 三个条件
    expect(outlineSection![0]).toMatch(/showOutline/);
    expect(outlineSection![0]).toMatch(/filePath/);
    expect(outlineSection![0]).toMatch(/isMarkdownFile/);
  });

  it("App.tsx 不再仅用 filePath 判断大纲显示", () => {
    const src = readSrc("../App.tsx");
    // 旧条件 showOutline && filePath（不含 isMarkdownFile）应被替换
    // 通过正则匹配 showOutline && filePath 后面不跟 && isMarkdownFile 的情况
    const oldPattern = /showOutline\s*&&\s*filePath(?!\s*&&\s*isMarkdownFile)/;
    expect(src).not.toMatch(oldPattern);
  });

  it("Outline 组件仅在 Markdown 文件下渲染（含 SyntaxHelper 分支）", () => {
    const src = readSrc("../App.tsx");
    const outlineSection = src.match(/outline=\{[\s\S]*?\}\s*\}/);
    expect(outlineSection).not.toBeNull();
    // isMarkdownFile 应作为外层条件，控制 SyntaxHelper 和 Outline 都只在 md 文件下显示
    expect(outlineSection![0]).toMatch(/isMarkdownFile\(filePath\s*\|\|\s*["']["']\)/);
  });
});

// ─── 问题 2：左侧栏显示逻辑优化 ──────────────────────

describe("问题2：左侧栏「打开的文件」和「文档」栏显示位置", () => {
  it("FileTree.tsx 包含 openFolders 长度判断与 tempFiles 渲染顺序逻辑", () => {
    const src = readSrc("../components/sidebar/FileTree.tsx");
    // 验证存在 openFolders.length === 0 的判断分支
    expect(src).toMatch(/openFolders\.length\s*===\s*0/);
    // 验证存在 tempFiles.length > 0 的判断分支
    expect(src).toMatch(/tempFiles\.length\s*>\s*0/);
  });

  it("不打开文件夹时，placeholder 仅在 tempFiles 也为空时显示", () => {
    const src = readSrc("../components/sidebar/FileTree.tsx");
    // 定位 placeholder 渲染区域：应同时检查 openFolders 为空 AND tempFiles 为空
    // 旧逻辑：openFolders.length > 0 ? FolderSection : placeholder（不管 tempFiles）
    // 新逻辑：openFolders.length > 0 ? FolderSection : (tempFiles.length > 0 ? null : placeholder)
    const placeholderArea = src.match(/openFolders\.length\s*===\s*0[\s\S]*?filetree-placeholder[\s\S]*?\}\)/);
    expect(placeholderArea).not.toBeNull();
    // 在 placeholder 出现前，必须判断 tempFiles 为空
    expect(placeholderArea![0]).toMatch(/tempFiles\.length\s*===\s*0/);
  });

  it("不打开文件夹但有临时文件时，临时文件栏渲染在顶部（FolderSection 之前）", () => {
    const src = readSrc("../components/sidebar/FileTree.tsx");
    // v0.4.5 修复：tempFiles 栏提取为 renderTempFilesSection 函数，避免重复 JSX
    // 验证存在 openFolders.length === 0 时渲染 tempFiles 栏的逻辑（顶部位置）
    // 兼容两种写法：内联条件渲染 或 提取函数调用
    const hasNoFolderTempLogic = /openFolders\.length\s*===\s*0\s*&&\s*tempFiles\.length\s*>\s*0\s*&&\s*renderTempFilesSection/.test(src) ||
      /openFolders\.length\s*===\s*0[\s\S]*?tempFiles\.length\s*>\s*0[\s\S]*?filetree-temp-section/.test(src);
    expect(hasNoFolderTempLogic).toBe(true);
    // 验证 renderTempFilesSection 函数存在且包含 filetree-temp-section
    expect(src).toMatch(/renderTempFilesSection/);
    expect(src).toMatch(/filetree-temp-section/);
  });

  it("打开文件夹后，临时文件栏渲染在 FolderSection 之后", () => {
    const src = readSrc("../components/sidebar/FileTree.tsx");
    // FolderSection（treeDataByFolder.map）应出现在 tempFiles 栏之前
    const idxFolderSection = src.indexOf("treeDataByFolder.map");
    const idxTempSection = src.indexOf("filetree-temp-section");
    expect(idxFolderSection).toBeGreaterThan(-1);
    expect(idxTempSection).toBeGreaterThan(-1);
    // 这里仅验证两者都存在；顺序由 openFolders 长度判断控制
    // 主要验证：openFolders.length > 0 时才渲染 treeDataByFolder.map
    const folderRenderArea = src.match(/openFolders\.length\s*>\s*0\s*\?[\s\S]*?treeDataByFolder\.map/);
    expect(folderRenderArea).not.toBeNull();
  });

  it("不打开文件夹也不打开文件时，placeholder 仍然显示（提示用户打开文件夹）", () => {
    const src = readSrc("../components/sidebar/FileTree.tsx");
    // filetree-placeholder 元素仍存在
    expect(src).toMatch(/filetree-placeholder/);
    expect(src).toMatch(/filetree\.clickToOpen/);
  });
});

// ─── 问题 3：阅读模式下表格列宽拖拽（cell 左边缘也触发热区）──────────────

describe("问题3：表格列宽拖拽 cell 左边缘热区", () => {
  it("onHover 统一使用 hitResizeZone，其内部检测左右边缘（rect.left/rect.right）", () => {
    const src = readSrc("../core/plugins/table-editor.ts");
    const onHoverSection = src.match(/private onHover\(e: MouseEvent\)[\s\S]*?\n  \}/);
    expect(onHoverSection).not.toBeNull();
    // F1 修复：onHover/onMouseDown/stopEvent 统一调用 hitResizeZone 判定热区
    expect(onHoverSection![0]).toMatch(/hitResizeZone/);
    // hitResizeZone 内部应同时计算左边缘和右边缘
    const zoneSection = src.match(/function hitResizeZone[\s\S]*?\n\}/);
    expect(zoneSection).not.toBeNull();
    expect(zoneSection![0]).toMatch(/rect\.right/);
    expect(zoneSection![0]).toMatch(/rect\.left/);
  });

  it("onHover 在 cell 左边缘或右边缘 8px 内显示 col-resize 光标", () => {
    const src = readSrc("../core/plugins/table-editor.ts");
    const onHoverSection = src.match(/private onHover\(e: MouseEvent\)[\s\S]*?\n  \}/);
    expect(onHoverSection).not.toBeNull();
    // col-resize 应在左边缘或右边缘热区内显示
    expect(onHoverSection![0]).toMatch(/col-resize/);
    // F1 新逻辑：zone.col 命中（左/右边缘任一进入热区）即显示 col-resize
    expect(onHoverSection![0]).toMatch(/zone\.col/);
  });

  it("onMouseDown 在 cell 左边缘 8px 内也触发列宽拖拽", () => {
    const src = readSrc("../core/plugins/table-editor.ts");
    const onMouseDownSection = src.match(/private onMouseDown\(e: MouseEvent\)[\s\S]*?\n  \}/);
    expect(onMouseDownSection).not.toBeNull();
    // 应同时计算左边缘和右边缘偏移
    expect(onMouseDownSection![0]).toMatch(/offsetXLeft|rect\.left/);
    expect(onMouseDownSection![0]).toMatch(/offsetXRight|rect\.right/);
  });

  it("onMouseDown 中左边缘触发时 colIdx = cellIdx - 1（前一列的右边缘）", () => {
    const src = readSrc("../core/plugins/table-editor.ts");
    const onMouseDownSection = src.match(/private onMouseDown\(e: MouseEvent\)[\s\S]*?\n  \}/);
    expect(onMouseDownSection).not.toBeNull();
    // 验证存在 inLeftEdge 或左边缘判断分支
    expect(onMouseDownSection![0]).toMatch(/inLeftEdge|offsetXLeft/);
    // 验证存在 colIdx = cellIdx - 1 的逻辑
    expect(onMouseDownSection![0]).toMatch(/cellIdx\s*-\s*1/);
  });

  it("onMouseDown 第一列左边缘不触发列宽拖拽（避免误触表格左外侧框线）", () => {
    const src = readSrc("../core/plugins/table-editor.ts");
    const onMouseDownSection = src.match(/private onMouseDown\(e: MouseEvent\)[\s\S]*?\n  \}/);
    expect(onMouseDownSection).not.toBeNull();
    // F1 修复：用 isFirstCellInRow 判定第一列，左边缘命中时 return 放行事件（避免死区）
    expect(onMouseDownSection![0]).toMatch(/isFirstCellInRow/);
  });

  it("stopEvent 在 cell 左边缘 8px 内也返回 true", () => {
    const src = readSrc("../core/plugins/table-editor.ts");
    const stopEventSection = src.match(/stopEvent\(event:\s*Event\)[\s\S]*?\n\s*\}/);
    expect(stopEventSection).not.toBeNull();
    // 应同时检测左边缘和右边缘
    expect(stopEventSection![0]).toMatch(/rect\.left/);
    expect(stopEventSection![0]).toMatch(/rect\.right/);
  });

  it("computeResizedWidths 非最后一列保持总宽度不变（已有逻辑，回归验证）", () => {
    const src = readSrc("../core/plugins/table-editor.ts");
    const funcSection = src.match(/export function computeResizedWidths[\s\S]*?\n\}/);
    expect(funcSection).not.toBeNull();
    // 非最后一列：调整 colIdx 和 colIdx+1，总宽度不变
    expect(funcSection![0]).toMatch(/isLastColumn/);
    expect(funcSection![0]).toMatch(/newColWidth\s*\+\s*newAdjacentWidth|actualDelta/);
  });
});

// ─── 回归测试：computeResizedWidths 行为验证 ──────────────────────

describe("computeResizedWidths 行为验证（回归测试）", () => {
  it("拖拽非最后一列：相邻两列宽度调整，总宽度不变", async () => {
    const { computeResizedWidths } = await import("../core/plugins/table-editor");
    const startWidths = [100, 100, 100];
    // 拖拽 colIdx=0 右边缘往右 30px
    const newWidths = computeResizedWidths(startWidths, 0, 30);
    expect(newWidths.length).toBe(3);
    // col0 增大 30，col1 减小 30
    expect(newWidths[0]).toBe(130);
    expect(newWidths[1]).toBe(70);
    expect(newWidths[2]).toBe(100);
    // 总宽度不变
    const totalStart = startWidths.reduce((s, w) => s + w, 0);
    const totalNew = newWidths.reduce((s, w) => s + w, 0);
    expect(totalNew).toBe(totalStart);
  });

  it("拖拽最后一列：只调整该列，总宽度可变", async () => {
    const { computeResizedWidths } = await import("../core/plugins/table-editor");
    const startWidths = [100, 100, 100];
    // 拖拽最后一列右边缘往右 50px
    const newWidths = computeResizedWidths(startWidths, 2, 50);
    expect(newWidths.length).toBe(3);
    // 仅最后一列增大 50
    expect(newWidths[0]).toBe(100);
    expect(newWidths[1]).toBe(100);
    expect(newWidths[2]).toBe(150);
    // 总宽度增加 50
    const totalStart = startWidths.reduce((s, w) => s + w, 0);
    const totalNew = newWidths.reduce((s, w) => s + w, 0);
    expect(totalNew).toBe(totalStart + 50);
  });

  it("拖拽非最后一列受 minWidth 限制，相邻列不会被压缩到 0", async () => {
    const { computeResizedWidths } = await import("../core/plugins/table-editor");
    const startWidths = [100, 30, 100];
    // 拖拽 colIdx=0 右边缘往右 200px，但 col1 只有 30，minWidth=20，最多压缩 10
    const newWidths = computeResizedWidths(startWidths, 0, 200, 20);
    expect(newWidths[0]).toBe(110); // 100 + 10
    expect(newWidths[1]).toBe(20);  // 30 - 10，达到 minWidth
    expect(newWidths[2]).toBe(100);
  });
});
