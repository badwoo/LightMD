/**
 * v0.8.3 WP2 需求3：状态栏实时显示光标行列 + 选中字数
 *
 * 覆盖：
 * 1. 纯函数 computeTextareaCursorPosition（源码模式行列/选中计算 + 边界）
 * 2. useEditorStore 的 cursorColumn / selectedChars 状态与重置语义
 * 3. 阅读模式侧接线：editor.ts 回调签名扩展 + 全文文本改惰性 getter
 * 4. StatusBar 渲染键 + i18n
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeTextareaCursorPosition, computeDocLine, computeBlockColumn } from "../utils/cursorPosition";
import { useEditorStore } from "../stores/useEditorStore";
import { t } from "../i18n/state";
import { markdownToDoc } from "../core/markdown/parser";

const editorSrc = readFileSync(resolve(__dirname, "../core/editor.ts"), "utf-8");
const containerSrc = readFileSync(
  resolve(__dirname, "../components/editor/EditorContainer.tsx"),
  "utf-8",
);
const statusBarSrc = readFileSync(
  resolve(__dirname, "../components/layout/StatusBar.tsx"),
  "utf-8",
);
const zhSrc = readFileSync(resolve(__dirname, "../i18n/locales/zh-CN.ts"), "utf-8");
const enSrc = readFileSync(resolve(__dirname, "../i18n/locales/en-US.ts"), "utf-8");

describe("v0.8.3 需求3：computeTextareaCursorPosition", () => {
  it("空文档 → 行 1 列 1，无选中", () => {
    expect(computeTextareaCursorPosition("", 0, 0)).toEqual({
      line: 1,
      column: 1,
      selectedChars: 0,
    });
  });

  it("首行内游标 → 列号 = 偏移 + 1", () => {
    expect(computeTextareaCursorPosition("hello world", 0)).toEqual({
      line: 1,
      column: 1,
      selectedChars: 0,
    });
    expect(computeTextareaCursorPosition("hello world", 4)).toEqual({
      line: 1,
      column: 5,
      selectedChars: 0,
    });
  });

  it("跨行游标 → 行号按 \\n 计数、列号按当前行内偏移", () => {
    const text = "aaa\nbbbbb\ncc";
    // 第 2 行行首（偏移 4）→ 行 2 列 1
    expect(computeTextareaCursorPosition(text, 4)).toEqual({ line: 2, column: 1, selectedChars: 0 });
    // 第 2 行第 3 字符（偏移 6）→ 行 2 列 3
    expect(computeTextareaCursorPosition(text, 6)).toEqual({ line: 2, column: 3, selectedChars: 0 });
    // 第 3 行行首（偏移 10）→ 行 3 列 1
    expect(computeTextareaCursorPosition(text, 10)).toEqual({ line: 3, column: 1, selectedChars: 0 });
  });

  it("选中文本 → selectedChars = 选区长度（含跨行换行符）", () => {
    const text = "aaa\nbbbbb\ncc";
    expect(computeTextareaCursorPosition(text, 0, 3)).toEqual({ line: 1, column: 1, selectedChars: 3 });
    // 跨行选区 4→9 覆盖 "\nbbbb"
    expect(computeTextareaCursorPosition(text, 4, 9)).toEqual({ line: 2, column: 1, selectedChars: 5 });
  });

  it("越界选区 / 反向选区 / 非数字入参不抛错（钳制到合法区间）", () => {
    expect(computeTextareaCursorPosition("abc", -5, 99)).toEqual({
      line: 1,
      column: 1,
      selectedChars: 3,
    });
    // end < start → 按 start 处理（无选中）
    expect(computeTextareaCursorPosition("abcdef", 4, 2)).toEqual({
      line: 1,
      column: 5,
      selectedChars: 0,
    });
    expect(computeTextareaCursorPosition("abcdef", Number.NaN, Number.NaN)).toEqual({
      line: 1,
      column: 1,
      selectedChars: 0,
    });
  });

  it("性能语义：单趟扫描，不产生 split 数组（实现代码不调用 split）", () => {
    const utilSrc = readFileSync(resolve(__dirname, "../utils/cursorPosition.ts"), "utf-8");
    // 剥离注释后再断言（文档注释里会提到旧实现的 split 写法）
    const code = utilSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/\.split\(/);
    expect(utilSrc).toContain("charCodeAt");
  });

  it("性能语义：阅读模式行号结构化计数，不拼接光标前全文", () => {
    const utilSrc = readFileSync(resolve(__dirname, "../utils/cursorPosition.ts"), "utf-8");
    const code = utilSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    // 行号相关实现（blockLineWeight → computeDocLine）不调用 textBetween
    // （旧实现用它拼接光标前的整篇文本）；列号只取当前块，用 textBetween 是 O(块内)
    const lineSection = code.slice(
      code.indexOf("function tableRowCount"),
      code.indexOf("export function computeBlockColumn"),
    );
    expect(lineSection.length).toBeGreaterThan(0);
    expect(lineSection).not.toContain("textBetween");
    expect(lineSection).toContain("blockLineWeight");
  });
});

describe("v0.8.3 需求3：阅读模式行号（computeDocLine）", () => {
  /** 定位到第 idx 个顶层块的块内偏移 offset 处 */
  function posOfBlock(doc: ReturnType<typeof markdownToDoc>, idx: number, offset = 0): number {
    let p = 0;
    for (let i = 0; i < idx; i++) p += doc.child(i).nodeSize;
    return p + 1 + offset;
  }

  it("验收用例：光标在第 3 行第 5 字符处 → 行 3 列 5", () => {
    const doc = markdownToDoc("# 标题\n\n第一段\n\n第二段文字内容 ABCDEFGHIJ\n");
    const $pos = doc.resolve(posOfBlock(doc, 2, 4));
    expect(computeDocLine($pos)).toBe(3);
    expect(computeBlockColumn($pos)).toBe(5);
  });

  it("旧实现缺陷回归：块之间不再被忽略（旧公式在常规文档里恒为 1）", () => {
    const doc = markdownToDoc("# 标题\n\n第一段\n\n第二段\n");
    const third = doc.resolve(posOfBlock(doc, 2, 0));
    expect(computeDocLine(third)).toBe(3);
    // 旧公式（textBetween 无 blockSeparator）在同一位置只会得到 1
    const legacy = doc.textBetween(0, third.pos).split("\n").length;
    expect(legacy).toBe(1);
  });

  it("文档开头 → 行 1", () => {
    const doc = markdownToDoc("hello\n\nworld\n");
    expect(computeDocLine(doc.resolve(1))).toBe(1);
  });

  it("标题层级/列表/引用：每个块各占一行（容器本身不占行）", () => {
    const doc = markdownToDoc("# H1\n\n- 项目一\n- 项目二\n- 项目三\n\n> 引用内容\n");
    // 顶层块：h1 / bullet_list / blockquote
    // 列表第 2 项所在行 = h1(1) + 第 1 项(1) + 1 = 3
    const list = doc.child(1);
    const secondItem = list.child(1);
    let listStart = doc.child(0).nodeSize + 1;
    const itemPos = listStart + list.child(0).nodeSize + 1;
    expect(computeDocLine(doc.resolve(itemPos))).toBe(3);
    // 引用块在其后：h1(1) + 列表 3 项(3) + 1 = 5
    const quoteStart = listStart + list.nodeSize + 1;
    expect(computeDocLine(doc.resolve(quoteStart))).toBe(5);
    expect(secondItem).toBeTruthy();
  });

  it("代码块按整块计 1 行（块内换行不额外计行）", () => {
    const doc = markdownToDoc("# T\n\n```js\nlet a = 1;\nlet b = 2;\n```\n\n尾段\n");
    // 顶层块：h1 / code_block / p
    expect(computeDocLine(doc.resolve(posOfBlock(doc, 1, 0)))).toBe(2);
    expect(computeDocLine(doc.resolve(posOfBlock(doc, 2, 0)))).toBe(3);
  });

  it("块内硬换行各占 1 行", () => {
    // 行尾反斜杠 = Markdown 硬换行
    const doc = markdownToDoc("# T\n\n第一行\\\n第二行\n");
    const p = doc.child(1);
    // 前提校验：解析结果里确实存在 hard_break
    let hardBreaks = 0;
    p.descendants((n) => {
      if (n.type.name === "hard_break") hardBreaks++;
      return true;
    });
    expect(hardBreaks).toBe(1);
    // 段落内容：文本3 + 硬换行 + 文本3；光标在硬换行之后 → 行 3（h1=1，段落首行=2）
    const pStart = doc.child(0).nodeSize; // 段落节点起始位置
    expect(computeDocLine(doc.resolve(pStart + 5))).toBe(3);
    // 硬换行之前仍是行 2
    expect(computeDocLine(doc.resolve(pStart + 2))).toBe(2);
  });

  it("表格按表行计行（每个表行 1 行，单元格本身不计行）", () => {
    const md = "# T\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n";
    const doc = markdownToDoc(md);
    const tablePos = doc.child(0).nodeSize + 1;
    // 表格整体 4 行（表头 + 分隔行 + 2 数据行；分隔行在解析后并入表头）
    expect(computeDocLine(doc.resolve(tablePos + 1))).toBe(2);
    // 光标落在表格内也不会跳成"每个单元格一行"
    const inside = computeDocLine(doc.resolve(tablePos + 3));
    expect(inside).toBeGreaterThanOrEqual(2);
    expect(inside).toBeLessThanOrEqual(6);
  });
});

describe("v0.8.3 需求3：useEditorStore 光标状态", () => {
  beforeEach(() => {
    useEditorStore.setState({ cursorLine: 0, cursorColumn: 0, selectedChars: 0 });
  });

  it("默认值为 0", () => {
    const s = useEditorStore.getState();
    expect(s.cursorColumn).toBe(0);
    expect(s.selectedChars).toBe(0);
  });

  it("setter 可写", () => {
    useEditorStore.getState().setCursorColumn(7);
    useEditorStore.getState().setSelectedChars(12);
    expect(useEditorStore.getState().cursorColumn).toBe(7);
    expect(useEditorStore.getState().selectedChars).toBe(12);
  });

  it("openFile 一并重置行列与选中数（切换文件后不残留上一个文件的位置）", () => {
    useEditorStore.getState().setCursorLine(30);
    useEditorStore.getState().setCursorColumn(9);
    useEditorStore.getState().setSelectedChars(5);
    useEditorStore.getState().openFile("C:/a.md");
    const s = useEditorStore.getState();
    expect(s.cursorLine).toBe(0);
    expect(s.cursorColumn).toBe(0);
    expect(s.selectedChars).toBe(0);
  });
});

describe("v0.8.3 需求3：阅读模式（ProseMirror）接线", () => {
  it("回调签名扩展为 (line, column, selectedChars, getText)", () => {
    expect(editorSrc).toMatch(/onSelectionChange\?:\s*\(\s*line:\s*number,\s*column:\s*number,\s*selectedChars:\s*number,\s*getText:\s*\(\)\s*=>\s*string,?\s*\)\s*=>\s*void/);
    expect(editorSrc).toMatch(/onSelectionChange\(lineCount,\s*column,\s*selectedChars,/);
  });

  it("列号只取当前文本块（O(块内)），选中数仅在有选区时计算", () => {
    expect(editorSrc).toContain("computeBlockColumn($from)");
    expect(editorSrc).toContain("computeDocLine($from)");
    expect(editorSrc).toMatch(/sel\.empty\s*\n?\s*\?\s*0/);
    expect(editorSrc).toContain("newState.doc.textBetween(sel.from, sel.to).length");
  });

  it("旧行号公式（块间无分隔符 → 恒为 1）已从实现中移除", () => {
    // 剥离注释后断言（注释里会引用旧写法作为背景说明）
    const code = editorSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code).not.toContain("textBetween(0, $from.pos)");
    expect(code).not.toMatch(/textBetween\(0,[^)]*\)\.split\(/);
  });

  it("全文文本改为惰性 getter（不再每次选区变化全量序列化）", () => {
    expect(editorSrc).toContain("() => newState.doc.textContent");
    // 旧热点：把 allText 直接算好再传（每次击键都 textContent）
    expect(editorSrc).not.toContain("const allText = newState.doc.textContent");
  });

  it("EditorContainer 接线：写入 store 的两个 setter + 字数只在防抖回调里取全文", () => {
    expect(containerSrc).toContain("setCursorColumnRef.current(column)");
    expect(containerSrc).toContain("setSelectedCharsRef.current(selectedChars)");
    expect(containerSrc).toContain("calculateWordCount(getText())");
    // 源码模式（textarea）走纯函数计算
    expect(containerSrc).toContain("computeTextareaCursorPosition(ta.value, ta.selectionStart, ta.selectionEnd)");
    expect(containerSrc).toContain('textarea.addEventListener("select", update)');
  });
});

describe("v0.8.3 需求3：StatusBar 渲染 + i18n", () => {
  it("渲染行/列，并在有选区时追加选中字数", () => {
    expect(statusBarSrc).toContain('t("statusbar.lineColumn", { line: cursorLine, column: cursorColumn })');
    expect(statusBarSrc).toContain('t("statusbar.selected", { count: selectedChars })');
    expect(statusBarSrc).toContain("selectedChars > 0");
    expect(statusBarSrc).toContain('data-testid="statusbar-cursor"');
    expect(statusBarSrc).toContain('data-testid="statusbar-selected"');
  });

  it("i18n 键齐备且插值正确", () => {
    expect(zhSrc).toContain('"statusbar.lineColumn": "行 {line} 列 {column}"');
    expect(zhSrc).toContain('"statusbar.selected": "已选 {count} 字"');
    expect(enSrc).toContain('"statusbar.lineColumn": "Line {line} Col {column}"');
    expect(enSrc).toContain('"statusbar.selected": "{count} selected"');
    expect(t("statusbar.lineColumn", { line: 3, column: 5 })).toBe("行 3 列 5");
    expect(t("statusbar.selected", { count: 10 })).toBe("已选 10 字");
  });
});
