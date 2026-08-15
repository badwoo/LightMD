/**
 * v0.4.2 编辑器与表格修复测试
 *
 * 覆盖三个 Issue 的核心纯函数：
 * - Issue 6: 非md文件搜索替换（findMatches + 替换逻辑）
 * - Issue 7: 非md文件模式切换内容不丢失（shouldSkipProseMirrorSync）
 * - Issue 8: 表格列宽拖拽只调整相邻列，总宽度不变（computeResizedWidths）
 *
 * 测试范围：纯函数部分（不涉及 DOM 交互、React 组件渲染）
 * DOM 交互（textarea 高亮、模式切换副作用）依赖运行时环境，不在单测覆盖
 */
import { describe, it, expect } from "vitest";
import { findMatches } from "../components/editor/SearchReplace";
import { shouldSkipProseMirrorSync } from "../components/editor/EditorContainer";
import { computeResizedWidths, setColumnWidths } from "../core/plugins/table-editor";
import { EditorState } from "prosemirror-state";
import { Node } from "prosemirror-model";
import { lightMDSchema as schema } from "../core/schema";

// ─── Issue 6: 非md文件搜索替换 ──────────────────────────────────

describe("Issue 6: 非md文件搜索替换 - findMatches", () => {
  // ─── 搜索匹配 ───────────────────────────────────────────
  it("在普通文本中搜索匹配项，返回所有匹配起始位置", () => {
    // 模拟非 md 文件的 sourceContent（如 .txt 文件内容）
    const text = "hello world\nhello again\nworld hello";
    const matches = findMatches(text, "hello");
    // "hello" 出现在位置 0, 12, 30
    // 0: "hello" 开头
    // 12: 第二行 "hello" 开头（"hello world\n" 共 12 字符）
    // 30: 第三行 "world hello" 中的 "hello"（前两行共 24 字符 + "world " 6 字符）
    expect(matches).toEqual([0, 12, 30]);
    expect(matches.length).toBe(3);
  });

  it("在代码文件内容中搜索匹配项（含特殊字符）", () => {
    // 模拟 .js 文件内容
    const code = "function foo() {\n  return foo + foo;\n}";
    const matches = findMatches(code, "foo");
    // "foo" 出现在位置 9, 26, 32
    expect(matches).toEqual([9, 26, 32]);
  });

  it("无匹配时返回空数组", () => {
    const text = "hello world";
    expect(findMatches(text, "xyz")).toEqual([]);
  });

  it("空搜索词返回空数组", () => {
    const text = "hello world";
    expect(findMatches(text, "")).toEqual([]);
  });

  // ─── 区分大小写 ─────────────────────────────────────────
  it("默认不区分大小写：Hello 和 hello 都匹配", () => {
    const text = "Hello hello HELLO";
    const matches = findMatches(text, "hello");
    expect(matches.length).toBe(3);
    expect(matches).toEqual([0, 6, 12]);
  });

  it("区分大小写模式：只匹配大小写完全一致的", () => {
    const text = "Hello hello HELLO";
    const matches = findMatches(text, "hello", true);
    expect(matches).toEqual([6]);
  });

  // ─── 特殊字符转义 ───────────────────────────────────────
  it("搜索含正则特殊字符的文本时正确转义", () => {
    // 搜索 "a.b" 不应匹配 "axb"（. 不应作为通配符）
    const text = "a.b axb a.b";
    const matches = findMatches(text, "a.b");
    expect(matches).toEqual([0, 8]);
  });

  it("搜索含括号的文本时正确转义", () => {
    const text = "foo(test) bar(test)";
    const matches = findMatches(text, "(test)");
    expect(matches).toEqual([3, 13]);
  });

  // ─── 替换当前匹配（模拟 textarea 替换逻辑）──────────────
  it("替换当前匹配：用字符串操作模拟 replaceCurrent", () => {
    // 模拟 SearchReplace.replaceCurrent 的逻辑：
    // const pos = matches[currentMatch - 1];
    // const newContent = sourceContent.substring(0, pos) + replaceText + sourceContent.substring(pos + searchText.length);
    const sourceContent = "hello world hello";
    const searchText = "hello";
    const replaceText = "hi";
    const matches = findMatches(sourceContent, searchText);
    expect(matches).toEqual([0, 12]);

    // 替换第一个匹配（currentMatch = 1）
    const pos1 = matches[0];
    const after1 = sourceContent.substring(0, pos1) + replaceText + sourceContent.substring(pos1 + searchText.length);
    expect(after1).toBe("hi world hello");

    // 替换第二个匹配（currentMatch = 2）
    const pos2 = matches[1];
    const after2 = sourceContent.substring(0, pos2) + replaceText + sourceContent.substring(pos2 + searchText.length);
    expect(after2).toBe("hello world hi");
  });

  // ─── 全部替换（模拟 textarea 全部替换逻辑）──────────────
  it("全部替换：用正则替换模拟 replaceAll", () => {
    // 模拟 SearchReplace.replaceAll 的逻辑：
    // const regex = new RegExp(searchText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
    // const newContent = sourceContent.replace(regex, replaceText);
    const sourceContent = "hello world\nhello again";
    const searchText = "hello";
    const replaceText = "hi";
    const caseSensitive = false;
    const flags = caseSensitive ? "g" : "gi";
    const regex = new RegExp(searchText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
    const newContent = sourceContent.replace(regex, replaceText);
    expect(newContent).toBe("hi world\nhi again");
  });

  it("全部替换（区分大小写）：只替换大小写匹配的", () => {
    const sourceContent = "Hello hello HELLO";
    const searchText = "hello";
    const replaceText = "hi";
    const regex = new RegExp(searchText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    const newContent = sourceContent.replace(regex, replaceText);
    expect(newContent).toBe("Hello hi HELLO");
  });

  // ─── 下一个/上一个导航（模拟 goToMatch）─────────────────
  it("下一个/上一个导航：循环遍历匹配项", () => {
    const text = "a b a b a";
    const matches = findMatches(text, "a");
    expect(matches).toEqual([0, 4, 8]);

    // 模拟 goToMatch(1) 下一个：currentMatch 从 1 → 2 → 3 → 1（循环）
    let currentMatch = 1; // 初始为第一个
    const goNext = () => {
      const newIdx = currentMatch - 1 + 1;
      currentMatch = ((newIdx % matches.length) + matches.length) % matches.length + 1;
    };
    goNext();
    expect(currentMatch).toBe(2);
    goNext();
    expect(currentMatch).toBe(3);
    goNext();
    expect(currentMatch).toBe(1); // 循环回第一个
  });

  it("下一个/上一个导航：Shift+Enter 上一个，循环遍历", () => {
    const text = "a b a b a";
    const matches = findMatches(text, "a");
    expect(matches).toEqual([0, 4, 8]);

    let currentMatch = 1;
    const goPrev = () => {
      const newIdx = currentMatch - 1 - 1;
      currentMatch = ((newIdx % matches.length) + matches.length) % matches.length + 1;
    };
    goPrev();
    expect(currentMatch).toBe(3); // 从 1 循环到最后一个
    goPrev();
    expect(currentMatch).toBe(2);
    goPrev();
    expect(currentMatch).toBe(1);
  });
});

// ─── Issue 7: 非md文件模式切换内容不丢失 ──────────────────────────

describe("Issue 7: 非md文件模式切换 - shouldSkipProseMirrorSync", () => {
  // ─── Bug 复现：非 md 文件所有模式切换都应跳过 ProseMirror ──
  it("非md文件：预览→编辑 应跳过 ProseMirror doc 转换", () => {
    // Bug 场景：非 md 文件 ProseMirror 为空，getMarkdownFromDoc 返回空字符串覆盖 sourceContent
    // 修复后：shouldSkipProseMirrorSync 返回 true，直接保留 sourceContent
    expect(shouldSkipProseMirrorSync(false, false, true)).toBe(true);
  });

  it("非md文件：编辑→预览 应跳过 ProseMirror doc 转换", () => {
    // Bug 场景：非 md 文件 markdownToDoc 解析非 md 内容为错误的 doc
    // 修复后：跳过 doc 转换，sourceContent 不变
    expect(shouldSkipProseMirrorSync(false, true, false)).toBe(true);
  });

  it("非md文件：分屏→预览 应跳过 ProseMirror doc 转换", () => {
    expect(shouldSkipProseMirrorSync(false, true, false)).toBe(true);
  });

  it("非md文件：预览→分屏 应跳过 ProseMirror doc 转换", () => {
    expect(shouldSkipProseMirrorSync(false, false, true)).toBe(true);
  });

  it("非md文件：编辑↔分屏 应跳过（内容已在 textarea 中）", () => {
    expect(shouldSkipProseMirrorSync(false, true, true)).toBe(true);
  });

  // ─── md 文件：保持原有逻辑 ───────────────────────────────
  it("md文件：编辑↔分屏 应跳过（内容已同步）", () => {
    expect(shouldSkipProseMirrorSync(true, true, true)).toBe(true);
  });

  it("md文件：预览→编辑 不应跳过（需从 ProseMirror 同步到 textarea）", () => {
    expect(shouldSkipProseMirrorSync(true, false, true)).toBe(false);
  });

  it("md文件：编辑→预览 不应跳过（需从 textarea 同步到 ProseMirror）", () => {
    expect(shouldSkipProseMirrorSync(true, true, false)).toBe(false);
  });

  // ─── 循环切换场景：预览→编辑→预览→分屏 ─────────────────
  it("循环切换：非md文件在所有切换组合下都跳过，sourceContent 始终保留", () => {
    // 模拟预览→编辑→预览→分屏→预览 的循环切换
    // 每次切换都应跳过 ProseMirror doc 转换，sourceContent 不被覆盖
    const scenarios: Array<[boolean, boolean]> = [
      // [fromSource, toSource] 对应 预览→编辑
      [false, true],
      // 编辑→预览
      [true, false],
      // 预览→分屏
      [false, true],
      // 分屏→预览
      [true, false],
    ];

    for (const [fromSource, toSource] of scenarios) {
      expect(shouldSkipProseMirrorSync(false, fromSource, toSource)).toBe(true);
    }
  });

  it("循环切换：md文件在预览↔编辑/分屏 之间切换时需要同步", () => {
    // md 文件预览↔编辑 需要同步内容
    expect(shouldSkipProseMirrorSync(true, false, true)).toBe(false); // 预览→编辑
    expect(shouldSkipProseMirrorSync(true, true, false)).toBe(false); // 编辑→预览
    // md 文件编辑↔分屏 不需要同步
    expect(shouldSkipProseMirrorSync(true, true, true)).toBe(true);
  });
});

// ─── Issue 8: 表格列宽拖拽 ──────────────────────────────────────

describe("Issue 8: 表格列宽拖拽 - computeResizedWidths", () => {
  // ─── Bug 复现：拖拽某列不应导致所有列等比例调整 ─────────────
  it("Bug 复现场景：拖拽非最后一列时，其他列宽度应保持不变", () => {
    // 原实现只修改目标列，table-layout: fixed 重新分配宽度，看起来像等比例调整
    // 修复后：拖拽 colIdx 时，只调整 colIdx 和 colIdx+1，其他列不变
    const startWidths = [100, 100, 100];
    const newWidths = computeResizedWidths(startWidths, 0, 30);
    // colIdx=0 增大 30，colIdx=1 减小 30，colIdx=2 不变
    expect(newWidths[0]).toBe(130);
    expect(newWidths[1]).toBe(70);
    expect(newWidths[2]).toBe(100); // 第三列不变
  });

  // ─── 总宽度不变 ─────────────────────────────────────────
  it("拖拽非最后一列往右：colIdx 增大，colIdx+1 减小，总宽度不变", () => {
    const startWidths = [100, 100, 100];
    const newWidths = computeResizedWidths(startWidths, 0, 30);
    const oldTotal = startWidths.reduce((s, w) => s + w, 0);
    const newTotal = newWidths.reduce((s, w) => s + w, 0);
    expect(newTotal).toBe(oldTotal);
  });

  it("拖拽非最后一列往左：colIdx 减小，colIdx+1 增大，总宽度不变", () => {
    const startWidths = [100, 100, 100];
    const newWidths = computeResizedWidths(startWidths, 0, -30);
    expect(newWidths[0]).toBe(70);
    expect(newWidths[1]).toBe(130);
    const oldTotal = startWidths.reduce((s, w) => s + w, 0);
    const newTotal = newWidths.reduce((s, w) => s + w, 0);
    expect(newTotal).toBe(oldTotal);
  });

  it("拖拽中间列：只影响该列和右侧相邻列", () => {
    const startWidths = [100, 100, 100, 100];
    const newWidths = computeResizedWidths(startWidths, 1, 50);
    expect(newWidths[0]).toBe(100); // 不变
    expect(newWidths[1]).toBe(150); // 增大 50
    expect(newWidths[2]).toBe(50);  // 减小 50
    expect(newWidths[3]).toBe(100); // 不变
  });

  // ─── 最后一列：总宽度可变 ───────────────────────────────
  it("拖拽最后一列：只调整该列，总宽度可变", () => {
    const startWidths = [100, 100, 100];
    const newWidths = computeResizedWidths(startWidths, 2, 50);
    expect(newWidths[0]).toBe(100);
    expect(newWidths[1]).toBe(100);
    expect(newWidths[2]).toBe(150);
    const oldTotal = 300;
    const newTotal = newWidths.reduce((s, w) => s + w, 0);
    expect(newTotal).toBe(350); // 总宽度增大
  });

  it("拖拽最后一列往左：宽度减小但不小于 20px", () => {
    const startWidths = [100, 100, 100];
    const newWidths = computeResizedWidths(startWidths, 2, -150);
    expect(newWidths[2]).toBe(20); // 被钳制为最小宽度
  });

  // ─── 最小宽度限制 ───────────────────────────────────────
  it("拖拽使相邻列小于 20px 时，限制 delta 范围", () => {
    // colIdx=0 宽度 100，colIdx=1 宽度 50
    // 往右拖拽 80：colIdx=0 → 180，colIdx=1 → -30（小于 20）
    // 应限制 delta：colIdx=1 最小 20，所以 delta 最大 = 50 - 20 = 30
    const startWidths = [100, 50];
    const newWidths = computeResizedWidths(startWidths, 0, 80);
    expect(newWidths[0]).toBe(130); // 100 + 30（delta 被限制为 30）
    expect(newWidths[1]).toBe(20);  // 50 - 30 = 20（最小宽度）
  });

  it("拖拽使目标列小于 20px 时，限制 delta 范围", () => {
    // colIdx=0 宽度 50，往左拖拽 80：colIdx=0 → -30（小于 20）
    // 应限制 delta：colIdx=0 最小 20，所以 delta 最小 = 20 - 50 = -30
    const startWidths = [50, 100];
    const newWidths = computeResizedWidths(startWidths, 0, -80);
    expect(newWidths[0]).toBe(20);  // 50 - 30 = 20（最小宽度）
    expect(newWidths[1]).toBe(130); // 100 + 30 = 130
  });

  it("总宽度在最小宽度限制下仍保持不变", () => {
    const startWidths = [100, 50];
    const newWidths = computeResizedWidths(startWidths, 0, 80);
    const oldTotal = startWidths.reduce((s, w) => s + w, 0);
    const newTotal = newWidths.reduce((s, w) => s + w, 0);
    expect(newTotal).toBe(oldTotal);
  });

  // ─── 边界场景 ───────────────────────────────────────────
  it("delta=0 时宽度不变", () => {
    const startWidths = [100, 100, 100];
    const newWidths = computeResizedWidths(startWidths, 0, 0);
    expect(newWidths).toEqual([100, 100, 100]);
  });

  it("空数组返回空数组", () => {
    expect(computeResizedWidths([], 0, 50)).toEqual([]);
  });

  it("无效列索引返回原始宽度（四舍五入）", () => {
    const startWidths = [100, 100];
    expect(computeResizedWidths(startWidths, -1, 50)).toEqual([100, 100]);
    expect(computeResizedWidths(startWidths, 5, 50)).toEqual([100, 100]);
  });

  it("单列表格：拖拽唯一列，总宽度可变", () => {
    const startWidths = [200];
    const newWidths = computeResizedWidths(startWidths, 0, 50);
    expect(newWidths).toEqual([250]);
  });

  // ─── 持久化：setColumnWidths 保存整个宽度数组 ─────────────
  it("setColumnWidths 持久化拖拽后的完整宽度数组（含相邻列调整）", () => {
    // 构造测试表格
    const makeCell = (text: string, isHeader = false) => {
      const type = isHeader ? schema.nodes.table_header : schema.nodes.table_cell;
      return type.create({ align: "left" }, text ? schema.text(text) : []);
    };
    const makeRow = (cells: Node[]) => schema.nodes.table_row.create(null, cells);
    const makeTable = (headRow: Node | null, bodyRows: Node[], columnWidths: number[] | null = null) => {
      const children: Node[] = [];
      if (headRow) children.push(schema.nodes.table_head.create(null, headRow));
      children.push(schema.nodes.table_body.create(null, bodyRows));
      return schema.nodes.table.create({ columnWidths }, children);
    };

    const table = makeTable(
      makeRow([makeCell("H1", true), makeCell("H2", true), makeCell("H3", true)]),
      [makeRow([makeCell("A"), makeCell("B"), makeCell("C")])],
      [100, 100, 100]
    );
    const doc = schema.topNodeType.create(null, [table]);

    // 找到第一个 cell 的位置
    let cellPos: number | null = null;
    doc.descendants((node, pos) => {
      if (cellPos !== null) return false;
      if (node.type.name === "table_header") {
        cellPos = pos + 1;
        return false;
      }
      return true;
    });
    expect(cellPos).not.toBeNull();

    // 模拟拖拽 colIdx=0 往右 30px
    const startWidths = [100, 100, 100];
    const newWidths = computeResizedWidths(startWidths, 0, 30);

    // 通过 setColumnWidths 持久化
    const state = EditorState.create({ doc });
    const tr = state.tr;
    const $pos = doc.resolve(cellPos!);
    const newTr = setColumnWidths(tr, $pos, newWidths);

    expect(newTr).not.toBeNull();
    const newTable = newTr!.doc.firstChild!;
    // 持久化的 columnWidths 应包含相邻列的调整
    expect(newTable.attrs.columnWidths).toEqual([130, 70, 100]);
  });
});
