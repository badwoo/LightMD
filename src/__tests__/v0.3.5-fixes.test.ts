/**
 * v0.3.5 问题修复验证测试
 *
 * 验证 7 个用户反馈问题的修复：
 * 1. 表格列宽拖拽（保持其他列宽度不变）
 * 2. 阅读模式搜索高亮不一致（buildOffsetMap 同时构建 text 和 blocks）
 * 3. Ctrl+F 重复按激活搜索窗口（searchFocusKey）
 * 4. 搜索框浮动窗口（position: fixed + 拖拽）
 * 5. 底部栏搜索按钮切换开关（toggleSearch）
 * 6. 底部栏图标加文字 + 飞镖正中靶心图标
 * 补充需求：中间阅读区整体可滚动（移除 ProseMirror overflow-y: auto）
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

// ─── mock localStorage 和 fileService ──────────
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

import { useEditorStore } from "../stores/useEditorStore";

/** 读取源文件内容 */
function readSrc(relPath: string): string {
  return fs.readFileSync(path.resolve(__dirname, relPath), "utf-8");
}

// ─── 问题 1：表格列宽拖拽保持其他列不变 ──────────────────────

describe("问题1：表格列宽拖拽", () => {
  it("resizing 状态包含 startWidths 字段", () => {
    const src = readSrc("../core/plugins/table-editor.ts");
    expect(src).toMatch(/startWidths:\s*number\[\]/);
  });

  it("startResize 记录所有列的初始宽度", () => {
    const src = readSrc("../core/plugins/table-editor.ts");
    const startResizeSection = src.match(/private startResize[\s\S]*?\n  \}/);
    expect(startResizeSection).not.toBeNull();
    expect(startResizeSection![0]).toMatch(/firstRow\.querySelectorAll\(["']td, th["']\)/);
    expect(startResizeSection![0]).toMatch(/startWidths\s*=/);
    expect(startResizeSection![0]).toMatch(/getBoundingClientRect\(\)\.width/);
  });

  it("onMouseMove 保持其他列宽度不变，只修改目标列", () => {
    const src = readSrc("../core/plugins/table-editor.ts");
    const onMouseMoveSection = src.match(/private onMouseMove = \(e: MouseEvent\) =>[\s\S]*?  \};/);
    expect(onMouseMoveSection).not.toBeNull();
    // 验证目标列设置新宽度（通过 newWidths 数组）
    expect(onMouseMoveSection![0]).toMatch(/i === colIdx \? Math\.round\(newWidth\)/);
    expect(onMouseMoveSection![0]).toMatch(/\$\{newWidths\[i\]\}px/);
    // 验证其他列保持初始宽度（通过 Math.round(w)）
    expect(onMouseMoveSection![0]).toMatch(/Math\.round\(w\)/);
  });

  it("onMouseMove 设置 table 总宽度为列宽之和（修复列宽按比例分配）", () => {
    const src = readSrc("../core/plugins/table-editor.ts");
    const onMouseMoveSection = src.match(/private onMouseMove = \(e: MouseEvent\) =>[\s\S]*?  \};/);
    expect(onMouseMoveSection).not.toBeNull();
    // 验证设置 contentDOM.style.width 为 totalWidth
    expect(onMouseMoveSection![0]).toMatch(/contentDOM\.style\.width/);
    expect(onMouseMoveSection![0]).toMatch(/totalWidth/);
  });

  it("applyColumnWidths 设置 table width 为列宽之和", () => {
    const src = readSrc("../core/plugins/table-editor.ts");
    const applySection = src.match(/private applyColumnWidths\(node: Node\)[\s\S]*?\n  \}/);
    expect(applySection).not.toBeNull();
    // 有 columnWidths 时设置 table width 为列宽之和
    expect(applySection![0]).toMatch(/contentDOM\.style\.width.*totalWidth/);
    // 无 columnWidths 时恢复 width: 100%
    expect(applySection![0]).toMatch(/contentDOM\.style\.width.*100%/);
  });

  it("CSS 中 .ProseMirror table 不再有 width: 100%", () => {
    const src = readSrc("../styles/editor.css");
    const tableSection = src.match(/\.ProseMirror table \{[\s\S]*?\}/);
    expect(tableSection).not.toBeNull();
    // 去除注释后不应有 width: 100% 声明
    const codeWithoutComments = tableSection![0]
      .split("\n")
      .filter((line) => !line.trim().startsWith("/*") && !line.trim().startsWith("*") && !line.trim().startsWith("//"))
      .join("\n");
    expect(codeWithoutComments).not.toMatch(/^\s*width:\s*100%/m);
  });
});

// ─── 问题 2：阅读模式搜索高亮一致 ──────────────────────

describe("问题2：搜索高亮与匹配位置一致", () => {
  it("SearchReplace.tsx 使用 buildOffsetMap 同时构建 text 和 blocks", () => {
    const src = readSrc("../components/editor/SearchReplace.tsx");
    expect(src).toMatch(/function buildOffsetMap/);
    expect(src).toMatch(/interface OffsetMap/);
    expect(src).toMatch(/\{\s*text:\s*string;\s*blocks:\s*OffsetBlock\[\];\s*\}/);
  });

  it("buildOffsetMap 在同一次遍历中构建 text 和 blocks", () => {
    const src = readSrc("../components/editor/SearchReplace.tsx");
    const funcSection = src.match(/function buildOffsetMap[\s\S]*?\n\}/);
    expect(funcSection).not.toBeNull();
    // text 和 blocks 在同一遍历中构建
    expect(funcSection![0]).toMatch(/text \+= ["']\\n["']/);
    expect(funcSection![0]).toMatch(/text \+= node\.text/);
    expect(funcSection![0]).toMatch(/blocks\.push/);
  });

  it("performSearch 使用 buildOffsetMap 返回的 text", () => {
    const src = readSrc("../components/editor/SearchReplace.tsx");
    const searchSection = src.match(/const performSearch[\s\S]*?\n  \}, \[/);
    expect(searchSection).not.toBeNull();
    expect(searchSection![0]).toMatch(/buildOffsetMap\(editorView\.state\.doc\)/);
    expect(searchSection![0]).toMatch(/offsetMapRef\.current = map/);
    expect(searchSection![0]).toMatch(/text = map\.text/);
  });

  it("highlightMatch 使用 offsetMapRef 中的 blocks", () => {
    const src = readSrc("../components/editor/SearchReplace.tsx");
    const highlightSection = src.match(/const highlightMatch[\s\S]*?\n  \}, \[/);
    expect(highlightSection).not.toBeNull();
    expect(highlightSection![0]).toMatch(/offsetMapRef\.current/);
    expect(highlightSection![0]).toMatch(/lookupPmPos\(offsetMap\.blocks/);
  });

  it("highlightMatch 使用 Decoration 高亮（不依赖编辑器焦点）", () => {
    const src = readSrc("../components/editor/SearchReplace.tsx");
    const highlightSection = src.match(/const highlightMatch[\s\S]*?\n  \}, \[/);
    expect(highlightSection).not.toBeNull();
    // 问题1修复：使用 searchHighlightKey meta 更新 Decoration，不再使用 TextSelection + focus
    expect(highlightSection![0]).toMatch(/searchHighlightKey/);
    expect(highlightSection![0]).toMatch(/tr\.setMeta\(searchHighlightKey/);
    // 不应再使用 editorView.focus() 或 TextSelection
    expect(highlightSection![0]).not.toMatch(/editorView\.focus\(\)/);
    expect(highlightSection![0]).not.toMatch(/TextSelection/);
  });
});

// ─── 问题 3：Ctrl+F 重复按激活搜索窗口 ──────────────────────

describe("问题3：Ctrl+F 重复按激活搜索", () => {
  it("useEditorStore 包含 searchFocusKey 状态", () => {
    const src = readSrc("../stores/useEditorStore.ts");
    expect(src).toMatch(/searchFocusKey:\s*number/);
    expect(src).toMatch(/searchFocusKey:\s*0/);
  });

  it("setShowSearch 开启时递增 searchFocusKey", () => {
    useEditorStore.setState({ showSearch: false, searchFocusKey: 0 });
    useEditorStore.getState().setShowSearch(true);
    expect(useEditorStore.getState().searchFocusKey).toBe(1);
    // 再次开启递增
    useEditorStore.getState().setShowSearch(false);
    useEditorStore.getState().setShowSearch(true);
    expect(useEditorStore.getState().searchFocusKey).toBe(2);
  });

  it("setShowSearchReplace 开启时递增 searchFocusKey", () => {
    useEditorStore.setState({ showSearchReplace: false, searchFocusKey: 0 });
    useEditorStore.getState().setShowSearchReplace(true);
    expect(useEditorStore.getState().searchFocusKey).toBe(1);
  });

  it("SearchReplace.tsx 监听 searchFocusKey 变化重新聚焦", () => {
    const src = readSrc("../components/editor/SearchReplace.tsx");
    expect(src).toMatch(/searchFocusKey/);
    expect(src).toMatch(/useEffect\(\(\) => \{[\s\S]*?searchFocusKey > 0[\s\S]*?searchInputRef\.current\?\.focus/);
  });
});

// ─── 问题 4：搜索框浮动窗口 ──────────────────────

describe("问题4：搜索框浮动窗口", () => {
  it("SearchReplace.css 使用 position: fixed", () => {
    const src = readSrc("../components/editor/SearchReplace.css");
    expect(src).toMatch(/position:\s*fixed/);
  });

  it("SearchReplace.tsx 包含拖拽条 search-drag-handle", () => {
    const src = readSrc("../components/editor/SearchReplace.tsx");
    expect(src).toMatch(/search-drag-handle/);
    expect(src).toMatch(/handleDragStart/);
  });

  it("SearchReplace.tsx 包含拖拽位置状态和事件监听", () => {
    const src = readSrc("../components/editor/SearchReplace.tsx");
    expect(src).toMatch(/const \[position, setPosition\]/);
    // 问题3修复：拖拽事件在 handleDragStart 中注册（不再使用 dragState ref）
    expect(src).toMatch(/handleDragStart/);
    expect(src).toMatch(/document\.addEventListener\(["']mousemove["']/);
    expect(src).toMatch(/document\.addEventListener\(["']mouseup["']/);
  });

  it("初始位置浮动在文档中间", () => {
    const src = readSrc("../components/editor/SearchReplace.tsx");
    const initSection = src.match(/初始位置[\s\S]*?\n  \}, \[initialized\]/);
    expect(initSection).not.toBeNull();
    expect(initSection![0]).toMatch(/window\.innerWidth/);
    expect(initSection![0]).toMatch(/window\.innerHeight/);
  });
});

// ─── 问题 5：底部栏搜索按钮切换开关 ──────────────────────

describe("问题5：底部栏搜索按钮切换", () => {
  it("useEditorStore 包含 toggleSearch 方法", () => {
    const src = readSrc("../stores/useEditorStore.ts");
    expect(src).toMatch(/toggleSearch:/);
  });

  it("toggleSearch 开启时递增 focusKey，关闭时设为 false", () => {
    useEditorStore.setState({ showSearch: false, searchFocusKey: 0 });
    // 开启
    useEditorStore.getState().toggleSearch();
    expect(useEditorStore.getState().showSearch).toBe(true);
    expect(useEditorStore.getState().searchFocusKey).toBe(1);
    // 再次点击关闭
    useEditorStore.getState().toggleSearch();
    expect(useEditorStore.getState().showSearch).toBe(false);
  });

  it("StatusBar.tsx 使用 toggleSearch 而非 setShowSearch(true)", () => {
    const src = readSrc("../components/layout/StatusBar.tsx");
    expect(src).toMatch(/toggleSearch/);
    expect(src).toMatch(/onClick=\{toggleSearch\}/);
  });

  it("StatusBar.tsx 读取 showSearch 状态用于 active 样式", () => {
    const src = readSrc("../components/layout/StatusBar.tsx");
    expect(src).toMatch(/showSearch \? "active"/);
  });
});

// ─── 问题 6：底部栏图标加文字 + 飞镖靶心 ──────────────────────

describe("问题6：底部栏图标和文字", () => {
  it("搜索按钮包含放大镜图标和搜索文字", () => {
    const src = readSrc("../components/layout/StatusBar.tsx");
    const searchBtnSection = src.match(/搜索入口[\s\S]*?<\/button>/);
    expect(searchBtnSection).not.toBeNull();
    // SVG 图标
    expect(searchBtnSection![0]).toMatch(/<circle/);
    expect(searchBtnSection![0]).toMatch(/<line/);
    // 文字（t("search.placeholder") 翻译后为"搜索"）
    expect(searchBtnSection![0]).toMatch(/\{t\(["']search\.placeholder["']\)\}/);
  });

  it("专注模式按钮包含靶心图标（同心圆，无飞镖线）", () => {
    const src = readSrc("../components/layout/StatusBar.tsx");
    const focusBtnSection = src.match(/专注模式：靶心图标[\s\S]*?<\/button>/);
    expect(focusBtnSection).not.toBeNull();
    // 靶心：同心圆（外圆+中圆+内圆+中心点 = 4个 circle）
    const circles = focusBtnSection![0].match(/<circle/g);
    expect(circles!.length).toBeGreaterThanOrEqual(4);
    // 不应再有飞镖线（line 元素）
    const lines = focusBtnSection![0].match(/<line/g);
    expect(lines).toBeNull();
  });

  it("专注按钮包含'专注模式（F8）'文字子元素", () => {
    const src = readSrc("../components/layout/StatusBar.tsx");
    const focusBtnSection = src.match(/专注模式：靶心图标[\s\S]*?<\/button>/);
    expect(focusBtnSection).not.toBeNull();
    // SVG 之后应有 {t("statusbar.focusMode")} 文字子元素
    const afterSvg = focusBtnSection![0].match(/<\/svg>[\s\S]*<\/button>/);
    expect(afterSvg).not.toBeNull();
    expect(afterSvg![0]).toMatch(/\{t\(["']statusbar\.focusMode["']\)\}/);
  });

  it("专注模式 i18n 文字为'专注模式（F8）'", () => {
    const zhSrc = readSrc("../i18n/locales/zh-CN.ts");
    expect(zhSrc).toMatch(/"statusbar\.focusMode":\s*"专注模式（F8）"/);
    const enSrc = readSrc("../i18n/locales/en-US.ts");
    expect(enSrc).toMatch(/"statusbar\.focusMode":\s*"Focus Mode \(F8\)"/);
  });

  it("打字机按钮文字为'打字机（F9）'", () => {
    const zhSrc = readSrc("../i18n/locales/zh-CN.ts");
    expect(zhSrc).toMatch(/"statusbar\.typewriter":\s*"打字机（F9）"/);
    const enSrc = readSrc("../i18n/locales/en-US.ts");
    expect(enSrc).toMatch(/"statusbar\.typewriter":\s*"Typewriter \(F9\)"/);
  });
});

// ─── 补充需求：中间阅读区整体可滚动 ──────────────────────

describe("补充需求：中间阅读区整体可滚动", () => {
  it("ProseMirror 不再有 overflow-y: auto 实际声明（注释中提到移除即可）", () => {
    const src = readSrc("../styles/editor.css");
    const pmSection = src.match(/\.ProseMirror \{[\s\S]*?\}/);
    expect(pmSection).not.toBeNull();
    // 注释中应明确提到"移除 overflow-y: auto"（确认修复意图）
    expect(pmSection![0]).toMatch(/移除\s*overflow-y:\s*auto/);
    // 去除注释后不应有 overflow-y: auto 声明
    const codeWithoutComments = pmSection![0]
      .split("\n")
      .filter((line) => !line.trim().startsWith("/*") && !line.trim().startsWith("*") && !line.trim().startsWith("//"))
      .join("\n");
    expect(codeWithoutComments).not.toMatch(/^\s*overflow-y:\s*auto/m);
  });

  it("editor-container 保持 overflow: auto（在 inline style 中）", () => {
    const src = readSrc("../components/editor/EditorContainer.tsx");
    // 验证 editor-container 的 inline style 包含 overflow: "auto"
    expect(src).toMatch(/overflow:\s*"auto"/);
  });
});

// ─── 问题1续：box-sizing: border-box 修复列宽按比例分配 ──

describe("问题1续：box-sizing 修复列宽拖拽联动", () => {
  it("CSS 中 td/th 有 box-sizing: border-box", () => {
    const src = readSrc("../styles/editor.css");
    const tdSection = src.match(/\.ProseMirror th, \.ProseMirror td \{[\s\S]*?\}/);
    expect(tdSection).not.toBeNull();
    expect(tdSection![0]).toMatch(/box-sizing:\s*border-box/);
  });
});

// ─── 问题2续：搜索高亮选区显示 ──────────────────────

describe("问题2续：搜索高亮 Decoration 方案", () => {
  it("editor.ts 包含 searchHighlight Plugin 和 PluginKey", () => {
    const src = readSrc("../core/editor.ts");
    expect(src).toMatch(/searchHighlightKey/);
    expect(src).toMatch(/searchHighlightPlugin/);
    expect(src).toMatch(/Plugin<DecorationSet>/);
    expect(src).toMatch(/Decoration\.inline/);
  });

  it("searchHighlightPlugin 注册到 EditorState plugins 数组", () => {
    const src = readSrc("../core/editor.ts");
    const pluginsSection = src.match(/plugins:\s*\[[\s\S]*?\]/);
    expect(pluginsSection).not.toBeNull();
    expect(pluginsSection![0]).toMatch(/searchHighlightPlugin/);
  });

  it("SearchReplace.tsx 导入 searchHighlightKey 并在 highlightMatch 中使用", () => {
    const src = readSrc("../components/editor/SearchReplace.tsx");
    expect(src).toMatch(/import.*searchHighlightKey.*from.*editor/);
    expect(src).toMatch(/tr\.setMeta\(searchHighlightKey/);
  });

  it("performSearch 空搜索文本时清除高亮", () => {
    const src = readSrc("../components/editor/SearchReplace.tsx");
    const searchSection = src.match(/const performSearch[\s\S]*?\n  \}, \[/);
    expect(searchSection).not.toBeNull();
    expect(searchSection![0]).toMatch(/searchHighlightKey/);
    expect(searchSection![0]).toMatch(/null/);
  });

  it("组件卸载时清除高亮 Decoration", () => {
    const src = readSrc("../components/editor/SearchReplace.tsx");
    expect(src).toMatch(/组件卸载时清除.*搜索高亮/);
    expect(src).toMatch(/tr\.setMeta\(searchHighlightKey,\s*null\)/);
  });

  it("CSS 包含 .search-highlight 高亮样式", () => {
    const src = readSrc("../styles/editor.css");
    expect(src).toMatch(/\.search-highlight/);
    expect(src).toMatch(/background:/);
  });

  it("不再使用 focusReturnTimerRef 和 TextSelection", () => {
    const src = readSrc("../components/editor/SearchReplace.tsx");
    expect(src).not.toMatch(/focusReturnTimerRef/);
    expect(src).not.toMatch(/TextSelection/);
  });

  it("CSS 包含 ::selection 确保选区可见", () => {
    const src = readSrc("../styles/editor.css");
    expect(src).toMatch(/\.ProseMirror ::selection/);
  });
});

// ─── 问题4：滚动进度联动修复 ──────────────────────

describe("问题4：三模式滚动进度联动", () => {
  it("ProseMirror 滚动百分比追踪使用 editor-container 而非 .ProseMirror", () => {
    const src = readSrc("../components/editor/EditorContainer.tsx");
    const scrollSection = src.match(/持续追踪 ProseMirror 滚动百分比[\s\S]*?\}, \[content, forceUpdateKey\]\)/);
    expect(scrollSection).not.toBeNull();
    // 不应使用 querySelector(".ProseMirror") 获取滚动容器
    expect(scrollSection![0]).not.toMatch(/querySelector.*ProseMirror/);
    // 应直接使用 editorRef.current
    expect(scrollSection![0]).toMatch(/editorRef\.current/);
    expect(scrollSection![0]).toMatch(/container\.addEventListener\(["']scroll/);
  });

  it("滚动恢复使用 editor-container 而非 .ProseMirror", () => {
    const src = readSrc("../components/editor/EditorContainer.tsx");
    const restoreSection = src.match(/问题4修复：滚动容器从 \.ProseMirror 改为 \.editor-container[\s\S]*?pendingIframeScrollRef/);
    expect(restoreSection).not.toBeNull();
    expect(restoreSection![0]).toMatch(/editorRef\.current/);
    expect(restoreSection![0]).toMatch(/container\.scrollTop/);
    expect(restoreSection![0]).toMatch(/container\.scrollHeight/);
  });
});

// ─── 第三阶段问题2：打字机模式修复 ──────────────────────

describe("第三阶段问题2：打字机模式使用 scrollContainer", () => {
  it("打字机 useEffect 块定义 scrollContainer 变量", () => {
    const src = readSrc("../components/editor/EditorContainer.tsx");
    const typewriterSection = src.match(/问题2修复：滚动容器从 \.ProseMirror 改为 \.editor-container[\s\S]*?const scrollContainer = editorRef\.current/);
    expect(typewriterSection).not.toBeNull();
    expect(typewriterSection![0]).toMatch(/scrollContainer = editorRef\.current/);
  });

  it("getCursorY 使用 scrollContainer 的 rect 和 scrollTop", () => {
    const src = readSrc("../components/editor/EditorContainer.tsx");
    const getCursorYSection = src.match(/const getCursorY = \(\) =>[\s\S]*?\n    \};/);
    expect(getCursorYSection).not.toBeNull();
    expect(getCursorYSection![0]).toMatch(/scrollContainer\.getBoundingClientRect/);
    expect(getCursorYSection![0]).toMatch(/scrollContainer\.scrollTop/);
    // 不应使用 editorDom 的滚动属性
    expect(getCursorYSection![0]).not.toMatch(/editorDom\.scrollTop/);
    expect(getCursorYSection![0]).not.toMatch(/editorDom\.getBoundingClientRect/);
  });

  it("scrollToCenter 使用 scrollContainer 的滚动属性", () => {
    const src = readSrc("../components/editor/EditorContainer.tsx");
    const scrollToCenterSection = src.match(/const scrollToCenter = \(\) =>[\s\S]*?\n    \};/);
    expect(scrollToCenterSection).not.toBeNull();
    expect(scrollToCenterSection![0]).toMatch(/scrollContainer\.clientHeight/);
    expect(scrollToCenterSection![0]).toMatch(/scrollContainer\.scrollHeight/);
    expect(scrollToCenterSection![0]).toMatch(/scrollContainer\.scrollTop/);
    expect(scrollToCenterSection![0]).toMatch(/scrollContainer\.scrollTo/);
  });

  it("handleKeyDown 使用 scrollContainer 的 scrollTop 和 rect", () => {
    const src = readSrc("../components/editor/EditorContainer.tsx");
    const handleKeyDownSection = src.match(/const handleKeyDown = \(\) =>[\s\S]*?\n    \};/);
    expect(handleKeyDownSection).not.toBeNull();
    expect(handleKeyDownSection![0]).toMatch(/scrollContainer\.scrollTop/);
    expect(handleKeyDownSection![0]).toMatch(/scrollContainer\.getBoundingClientRect/);
    expect(handleKeyDownSection![0]).toMatch(/scrollContainer\.clientHeight/);
  });

  it("handleKeyUp 使用 scrollContainer 的滚动属性", () => {
    const src = readSrc("../components/editor/EditorContainer.tsx");
    const handleKeyUpSection = src.match(/const handleKeyUp = \(e: KeyboardEvent\) =>[\s\S]*?\n    \};/);
    expect(handleKeyUpSection).not.toBeNull();
    expect(handleKeyUpSection![0]).toMatch(/scrollContainer\.scrollTop/);
    expect(handleKeyUpSection![0]).toMatch(/scrollContainer\.getBoundingClientRect/);
    expect(handleKeyUpSection![0]).toMatch(/scrollContainer\.clientHeight/);
  });

  it("editor.ts dispatchTransaction 使用 parentElement 的 scrollTop", () => {
    const src = readSrc("../core/editor.ts");
    const dispatchSection = src.match(/dispatchTransaction\(tr\)[\s\S]*?view\.updateState\(newState\)/);
    expect(dispatchSection).not.toBeNull();
    expect(dispatchSection![0]).toMatch(/scrollContainer/);
    expect(dispatchSection![0]).toMatch(/editorDom\.parentElement/);
    expect(dispatchSection![0]).toMatch(/scrollContainer\.scrollTop/);
  });
});
