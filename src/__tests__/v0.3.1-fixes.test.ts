/**
 * v0.3.1 问题修复验证测试
 *
 * 验证 7 个用户反馈问题的修复：
 * 1. 通过打开文件夹里打开的文件，显示方式改为显示文档名称+文档路径方式
 * 2. 导出图片没有显示内容
 * 3. 表格可视化编辑中拖拽调整列宽仍未实现
 * 4. 阅读模式下的大纲拖拽目前可以将下面的大纲往上拖拽，但上面的大纲往下拖拽却不生效
 * 5. 文档中插入图片，在编辑模式和分屏模式的编辑下会有大量字符占用页面篇幅过大
 * 6. 点击状态栏字数弹出详情面板，行数、段落数、阅读时长均错误，而且阅读时长没有更新
 * 7. 拼写检查功能开关开启后，好似没生效
 */
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { EditorState } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import { lightMDSchema as schema } from "../core/schema";
import {
  calculateDragTransaction,
  getSectionRange,
} from "../utils/outlineDrag";
import { calculateWordCount } from "../utils/wordCount";

/** 在文档中查找指定文本的标题节点的 pos */
function findHeadingPos(doc: PMNode, text: string): number {
  let result = -1;
  doc.forEach((child, offset) => {
    if (child.type.name === "heading" && child.textContent === text) {
      result = offset;
    }
  });
  if (result < 0) throw new Error(`未找到标题: ${text}`);
  return result;
}

/** 创建 EditorState */
function makeState(doc: PMNode): EditorState {
  return EditorState.create({ doc, schema });
}

/** 应用 transaction 并返回新文档的 markdown */
function applyTrAndGetMarkdown(state: EditorState, tr: any): string {
  const newState = state.apply(tr);
  return docToMarkdown(newState.doc).trim();
}

// ─── 问题 1：TabBar 标签只显示文件名（不显示路径） ──────────────────────

describe("问题1：TabBar 标签只显示文件名", () => {
  it("TabBar.tsx 只显示 tab.name，不显示路径", () => {
    const tsxPath = path.resolve(__dirname, "../components/layout/TabBar.tsx");
    const src = fs.readFileSync(tsxPath, "utf-8");
    // 验证只渲染 tab.name，不包含路径文本
    expect(src).toMatch(/\{tab\.name\}/);
    expect(src).not.toMatch(/tab-name-text/);
    expect(src).not.toMatch(/tab-name-path/);
    expect(src).not.toMatch(/-\s*\{tab\.path\}/);
  });

  it("TabBar.css 不包含 tab-name-text 和 tab-name-path 样式", () => {
    const cssPath = path.resolve(__dirname, "../components/layout/TabBar.css");
    const css = fs.readFileSync(cssPath, "utf-8");
    expect(css).not.toMatch(/\.tab-name-text/);
    expect(css).not.toMatch(/\.tab-name-path/);
  });

  it("TabBar.css max-width 回滚到 180px", () => {
    const cssPath = path.resolve(__dirname, "../components/layout/TabBar.css");
    const css = fs.readFileSync(cssPath, "utf-8");
    const match = css.match(/\.tab-item\s*\{[^}]*max-width:\s*(\d+)px/);
    expect(match).not.toBeNull();
    const maxWidth = parseInt(match![1], 10);
    expect(maxWidth).toBe(180);
  });
});

// ─── 问题 2：导出图片内容为空（PNG 空白）+ 含图片报错 ──────────────────────

describe("问题2：导出图片内容为空修复", () => {
  it("ExportDialog.tsx 的 EXPORT_CSS 包含 .markdown-body 选择器", () => {
    const tsxPath = path.resolve(__dirname, "../components/dialogs/ExportDialog.tsx");
    const src = fs.readFileSync(tsxPath, "utf-8");
    // 临时 div 用 <div class="markdown-body">，需要 .markdown-body 选择器
    expect(src).toMatch(/body,\s*\.markdown-body\s*\{/);
  });

  it("ExportDialog.tsx .markdown-body 重置 max-width/margin/padding 避免截宽异常", () => {
    const tsxPath = path.resolve(__dirname, "../components/dialogs/ExportDialog.tsx");
    const src = fs.readFileSync(tsxPath, "utf-8");
    const match = src.match(/\.markdown-body\s*\{[^}]*max-width:\s*100%[^}]*\}/);
    expect(match).not.toBeNull();
    const rule = match![0];
    expect(rule).toMatch(/max-width:\s*100%/);
    expect(rule).toMatch(/margin:\s*0/);
    expect(rule).toMatch(/padding:\s*0/);
  });

  it("exportImage 函数等待图片加载完成（querySelectorAll img + onload）", () => {
    const tsxPath = path.resolve(__dirname, "../components/dialogs/ExportDialog.tsx");
    const src = fs.readFileSync(tsxPath, "utf-8");
    expect(src).toMatch(/querySelectorAll\(["']img["']\)/);
    expect(src).toMatch(/img\.onload/);
    expect(src).toMatch(/requestAnimationFrame/);
  });

  it("exportImage.ts 设置 skipFonts: true 避免字体嵌入导致空白", () => {
    const tsPath = path.resolve(__dirname, "../utils/exportImage.ts");
    const src = fs.readFileSync(tsPath, "utf-8");
    expect(src).toMatch(/skipFonts:\s*true/);
  });

  it("ExportDialog.tsx 包含 convertImagesToDataUrl 函数（图片转 dataURL 避免跨域报错）", () => {
    const tsxPath = path.resolve(__dirname, "../components/dialogs/ExportDialog.tsx");
    const src = fs.readFileSync(tsxPath, "utf-8");
    expect(src).toMatch(/async function convertImagesToDataUrl/);
    expect(src).toMatch(/readFile/);
    expect(src).toMatch(/bytesToBase64/);
  });

  it("ExportDialog.tsx exportImage 在截图前调用 convertImagesToDataUrl", () => {
    const tsxPath = path.resolve(__dirname, "../components/dialogs/ExportDialog.tsx");
    const src = fs.readFileSync(tsxPath, "utf-8");
    // convertImagesToDataUrl 应在 exportElementAsPng 之前调用
    const idxConvert = src.indexOf("convertImagesToDataUrl(container");
    const idxExport = src.indexOf("exportElementAsPng(container");
    expect(idxConvert).toBeGreaterThan(-1);
    expect(idxExport).toBeGreaterThan(-1);
    expect(idxConvert).toBeLessThan(idxExport);
  });

  it("ExportDialog.tsx 临时 div 使用 fixed + visibility:hidden 替代 left:-9999px", () => {
    const tsxPath = path.resolve(__dirname, "../components/dialogs/ExportDialog.tsx");
    const src = fs.readFileSync(tsxPath, "utf-8");
    expect(src).toMatch(/position\s*=\s*"fixed"/);
    expect(src).toMatch(/visibility\s*=\s*"hidden"/);
    expect(src).not.toMatch(/left:\s*"-9999px"/);
  });
});

// ─── 问题 3：表格列宽拖拽 ──────────────────────

describe("问题3：表格列宽拖拽修复", () => {
  it("table-editor.ts ignoreMutation 返回 true（避免 PM 监听 style 变化死循环）", () => {
    const tsPath = path.resolve(__dirname, "../core/plugins/table-editor.ts");
    const src = fs.readFileSync(tsPath, "utf-8");
    const match = src.match(/ignoreMutation\(\)\s*:\s*boolean\s*\{([^}]*)\}/);
    expect(match).not.toBeNull();
    expect(match![1]).toMatch(/return\s+true/);
  });

  it("table-editor.ts update 方法在拖拽进行中跳过 applyColumnWidths", () => {
    const tsPath = path.resolve(__dirname, "../core/plugins/table-editor.ts");
    const src = fs.readFileSync(tsPath, "utf-8");
    expect(src).toMatch(/if\s*\(!this\.resizing\)/);
  });

  it("table-editor.ts onMouseMove 实时更新 cell 宽度（不只是指示线）", () => {
    const tsPath = path.resolve(__dirname, "../core/plugins/table-editor.ts");
    const src = fs.readFileSync(tsPath, "utf-8");
    // v0.3.5第三阶段：onMouseMove 使用 newWidths 数组设置 cell width
    expect(src).toMatch(/style\.width\s*=\s*`\$\{newWidths\[i\]\}px`/);
  });

  it("table-editor.ts 添加 stopEvent 方法（cell 右边缘 8px 阻止 PM 处理 mousedown）", () => {
    const tsPath = path.resolve(__dirname, "../core/plugins/table-editor.ts");
    const src = fs.readFileSync(tsPath, "utf-8");
    expect(src).toMatch(/stopEvent\(event:\s*Event\)/);
    // v0.4.5 修复：变量名变更 offsetX → offsetXRight/offsetXLeft
    // 验证 stopEvent 中有 cell 右边缘检测逻辑（兼容新旧变量名）
    expect(src).toMatch(/stopEvent[\s\S]*?offsetXRight\s*=\s*event\.clientX\s*-\s*rect\.right|stopEvent[\s\S]*?offsetX\s*=\s*event\.clientX\s*-\s*rect\.right/);
    expect(src).toMatch(/stopEvent[\s\S]*?Math\.abs\(offsetXRight\)\s*<=\s*8|stopEvent[\s\S]*?Math\.abs\(offsetX\)\s*<=\s*8/);
  });
});

// ─── 问题 4：大纲向下拖拽不生效 ──────────────────────

describe("问题4：大纲向下拖拽修复", () => {
  it("向下拖拽：H1 A 拖到 H1 B 位置 → A 应在 B 之后", () => {
    // 文档：# A, 段A, # B, 段B
    // 拖 A 到 B 位置（向下拖拽）→ A 应移到 B 之后
    const doc = markdownToDoc("# A\n段A\n# B\n段B\n");
    const posA = findHeadingPos(doc, "A");
    const posB = findHeadingPos(doc, "B");
    const state = makeState(doc);

    const tr = calculateDragTransaction(state, posA, posB);
    expect(tr).not.toBeNull();
    const md = applyTrAndGetMarkdown(state, tr!);
    // B 应在 A 之前（A 被移到 B 之后）
    const idxB = md.indexOf("B");
    const idxA = md.indexOf("A");
    expect(idxB).toBeLessThan(idxA);
    expect(md).toContain("段A");
    expect(md).toContain("段B");
  });

  it("向下拖拽：H1 A 拖到 H1 B 位置，B 在 A 之前且 A 的内容完整", () => {
    const doc = markdownToDoc("# A\n段A内容\n# B\n段B内容\n");
    const posA = findHeadingPos(doc, "A");
    const posB = findHeadingPos(doc, "B");
    const state = makeState(doc);

    const tr = calculateDragTransaction(state, posA, posB);
    expect(tr).not.toBeNull();
    const md = applyTrAndGetMarkdown(state, tr!);
    // 验证 A 的内容（段A内容）仍在 A 之后
    const idxA = md.indexOf("A");
    const idxAContent = md.indexOf("段A内容");
    expect(idxAContent).toBeGreaterThan(idxA);
    // B 在 A 之前
    const idxB = md.indexOf("B");
    expect(idxB).toBeLessThan(idxA);
  });

  it("向下拖拽多 section 场景：A 拖到 B 位置，C 仍在最后", () => {
    // 文档：# A, 段A, # B, 段B, # C, 段C
    // 拖 A 到 B 位置 → # B, 段B, # A, 段A, # C, 段C
    const doc = markdownToDoc("# A\n段A\n# B\n段B\n# C\n段C\n");
    const posA = findHeadingPos(doc, "A");
    const posB = findHeadingPos(doc, "B");
    const state = makeState(doc);

    const tr = calculateDragTransaction(state, posA, posB);
    expect(tr).not.toBeNull();
    const md = applyTrAndGetMarkdown(state, tr!);
    // 顺序应为 B → A → C
    const idxB = md.indexOf("B");
    const idxA = md.indexOf("A");
    const idxC = md.indexOf("C");
    expect(idxB).toBeLessThan(idxA);
    expect(idxA).toBeLessThan(idxC);
  });

  it("向上拖拽仍正常工作：B 拖到 A 位置 → B 在 A 之前", () => {
    // 回归测试：向上拖拽不应被破坏
    const doc = markdownToDoc("# A\n段A\n# B\n段B\n");
    const posA = findHeadingPos(doc, "A");
    const posB = findHeadingPos(doc, "B");
    const state = makeState(doc);

    const tr = calculateDragTransaction(state, posB, posA);
    expect(tr).not.toBeNull();
    const md = applyTrAndGetMarkdown(state, tr!);
    const idxB = md.indexOf("B");
    const idxA = md.indexOf("A");
    expect(idxB).toBeLessThan(idxA);
  });

  it("向下拖拽到末尾 section：A 拖到 C 位置 → B, C, A 顺序", () => {
    // 文档：# A, 段A, # B, 段B, # C, 段C
    // 拖 A 到 C 位置 → # B, 段B, # C, 段C, # A, 段A
    const doc = markdownToDoc("# A\n段A\n# B\n段B\n# C\n段C\n");
    const posA = findHeadingPos(doc, "A");
    const posC = findHeadingPos(doc, "C");
    const state = makeState(doc);

    const tr = calculateDragTransaction(state, posA, posC);
    expect(tr).not.toBeNull();
    const md = applyTrAndGetMarkdown(state, tr!);
    const idxB = md.indexOf("B");
    const idxC = md.indexOf("C");
    const idxA = md.indexOf("A");
    // B → C → A
    expect(idxB).toBeLessThan(idxC);
    expect(idxC).toBeLessThan(idxA);
  });
});

// ─── 问题 5：图片插入默认 assets 模式 ──────────────────────

describe("问题5：图片插入占用篇幅过大（默认 assets 模式）", () => {
  it("ImageInsertDialog.tsx 默认 mode 根据 isTauri() 决定", () => {
    const tsxPath = path.resolve(__dirname, "../components/dialogs/ImageInsertDialog.tsx");
    const src = fs.readFileSync(tsxPath, "utf-8");
    // 验证初始 useState 使用 isTauri() 三元判断
    expect(src).toMatch(/isTauri\(\)\s*\?\s*["']assets["']\s*:\s*["']base64["']/);
  });

  it("ImageInsertDialog.tsx 对话框打开重置时也根据 isTauri() 决定", () => {
    const tsxPath = path.resolve(__dirname, "../components/dialogs/ImageInsertDialog.tsx");
    const src = fs.readFileSync(tsxPath, "utf-8");
    // 验证 useEffect 重置中也使用 isTauri() 三元判断
    expect(src).toMatch(/setMode\(isTauri\(\)\s*\?\s*["']assets["']\s*:\s*["']base64["']\)/);
  });

  it("buildImageMarkdown 仍正确生成简短路径引用", () => {
    // 验证 assets 模式下生成的 markdown 是简短的相对路径
    const tsxPath = path.resolve(__dirname, "../components/dialogs/ImageInsertDialog.tsx");
    const src = fs.readFileSync(tsxPath, "utf-8");
    // copyToAssets 返回 assets/${fileName} 格式的相对路径
    expect(src).toMatch(/return\s*`assets\/\$\{fileName\}`/);
  });
});

// ─── 问题 6：字数统计面板错误 ──────────────────────

describe("问题6：字数统计面板行数/段落数/阅读时长错误", () => {
  it("editor.ts 移除了节流逻辑（lastWordCountTime）", () => {
    const tsPath = path.resolve(__dirname, "../core/editor.ts");
    const src = fs.readFileSync(tsPath, "utf-8");
    // 验证不再有 lastWordCountTime 变量
    expect(src).not.toMatch(/lastWordCountTime/);
    // 验证不再有 Date.now() 节流判断
    expect(src).not.toMatch(/now\s*-\s*lastWordCountTime/);
  });

  it("editor.ts onSelectionChange 每次都直接调用（不节流）", () => {
    const tsPath = path.resolve(__dirname, "../core/editor.ts");
    const src = fs.readFileSync(tsPath, "utf-8");
    // 验证选区变化时直接调用 onSelectionChange（不通过节流判断）
    expect(src).toMatch(/if\s*\(\s*tr\.selectionSet\s*&&\s*onSelectionChange\s*\)/);
    // 验证直接调用，无节流条件包裹
    expect(src).toMatch(/onSelectionChange\(lineCount,\s*allText\)/);
  });

  it("calculateWordCount 行数计算正确", () => {
    const text = "第一行\n第二行\n第三行";
    const result = calculateWordCount(text);
    expect(result.lines).toBe(3);
  });

  it("calculateWordCount 段落数计算正确（空行分隔）", () => {
    const text = "段落一\n\n段落二\n\n段落三";
    const result = calculateWordCount(text);
    expect(result.paragraphs).toBe(3);
  });

  it("calculateWordCount 阅读时长正确（中文 300 字/分）", () => {
    // 600 字 = 2 分钟
    const text = "字".repeat(600);
    const result = calculateWordCount(text);
    expect(result.words).toBe(600);
    expect(result.readingTimeMin).toBe(2);
  });

  it("calculateWordCount 空文档返回 0", () => {
    const result = calculateWordCount("");
    expect(result.words).toBe(0);
    expect(result.lines).toBe(0);
    expect(result.paragraphs).toBe(0);
    expect(result.readingTimeMin).toBe(0);
  });

  it("calculateWordCount 阅读时长最少 1 分钟（非空文档）", () => {
    const text = "少量文字";
    const result = calculateWordCount(text);
    expect(result.words).toBeGreaterThan(0);
    expect(result.readingTimeMin).toBe(1);
  });
});

// ─── 问题 7：拼写检查开关未生效 ──────────────────────

describe("问题7：拼写检查开关未生效", () => {
  it("EditorContainer.tsx spellcheck 切换时触发 blur + focus 让浏览器重新检查", () => {
    const tsxPath = path.resolve(__dirname, "../components/editor/EditorContainer.tsx");
    const src = fs.readFileSync(tsxPath, "utf-8");
    // 验证 spellcheck useEffect 中有 blur + focus 逻辑
    expect(src).toMatch(/editorDom\.blur\(\)/);
    expect(src).toMatch(/editorDom\.focus\(\)/);
  });

  it("EditorContainer.tsx spellcheck 切换时恢复滚动位置", () => {
    const tsxPath = path.resolve(__dirname, "../components/editor/EditorContainer.tsx");
    const src = fs.readFileSync(tsxPath, "utf-8");
    // v0.3.5第三阶段：滚动容器从 editorDom 改为 scrollContainer（editorRef.current）
    expect(src).toMatch(/const\s+scrollTop\s*=\s*scrollContainer\s*\?\s*scrollContainer\.scrollTop/);
    expect(src).toMatch(/scrollContainer\.scrollTop\s*=\s*scrollTop/);
  });

  it("EditorContainer.tsx 仅在编辑器处于焦点时才 blur + focus", () => {
    const tsxPath = path.resolve(__dirname, "../components/editor/EditorContainer.tsx");
    const src = fs.readFileSync(tsxPath, "utf-8");
    // 验证有 document.activeElement === editorDom 检查
    expect(src).toMatch(/document\.activeElement\s*===\s*editorDom/);
  });

  it("editor.ts 创建时通过 attributes.spellcheck 设置初始值", () => {
    const tsPath = path.resolve(__dirname, "../core/editor.ts");
    const src = fs.readFileSync(tsPath, "utf-8");
    // 验证 attributes 中有 spellcheck 设置
    expect(src).toMatch(/spellcheck:\s*spellcheckEnabled\s*\?\s*["']true["']\s*:\s*["']false["']/);
  });
});
