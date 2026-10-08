/**
 * v0.12.0 需求9：专注模式 3 行聚焦窗测试
 *
 * 覆盖 findFocusRowRange：
 * - 中间行 → 光标行 ±1 行（含行间换行符）
 * - 首/末行 → 自动收缩为 2 行
 * - 单行文档 / 空文档 → rows=1
 * - 空行、行尾（光标恰在 \n 上）、radius=0 退化单行
 * - 越界光标钳制
 */
import { describe, it, expect } from "vitest";
import { findFocusRowRange, findParagraphRange } from "../utils/focus-paragraph";

// 5 行文档：l1(0-1) \n(2) l2(3-4) \n(5) l3(6-7) \n(8) l4(9-10) \n(11) l5(12-13)
const FIVE_LINES = "l1\nl2\nl3\nl4\nl5";

describe("findFocusRowRange", () => {
  it("中间行（第 3 行 l3）→ 第 2/3/4 行，rows=3，区间含行间换行符", () => {
    const range = findFocusRowRange(FIVE_LINES, 6, 1);
    // [3, 11) = "l2\nl3\nl4"
    expect(range).toEqual({ start: 3, end: 11, rows: 3 });
    expect(FIVE_LINES.substring(range.start, range.end)).toBe("l2\nl3\nl4");
  });

  it("第 5 行（第 4/5/6 行场景取中间）：光标在第 3 行时上/下各 1 行", () => {
    // 用 7 行文档模拟"光标在第 5 行 → 亮 4/5/6 行"
    const text = "a\nb\nc\nd\ne\nf\ng";
    // d 行起点 6，e 行在 pos=8
    const range = findFocusRowRange(text, 8, 1);
    expect(text.substring(range.start, range.end)).toBe("d\ne\nf");
    expect(range.rows).toBe(3);
  });

  it("第 1 行 → 第 1/2 行，边界自动收缩", () => {
    const range = findFocusRowRange(FIVE_LINES, 0, 1);
    expect(range).toEqual({ start: 0, end: 5, rows: 2 });
  });

  it("最后一行 → 倒数第 2 行 + 最后行，边界自动收缩", () => {
    const range = findFocusRowRange(FIVE_LINES, 12, 1);
    expect(range).toEqual({ start: 9, end: 14, rows: 2 });
  });

  it("单行文档 → rows=1 且区间为全文", () => {
    const range = findFocusRowRange("abc", 1, 1);
    expect(range).toEqual({ start: 0, end: 3, rows: 1 });
  });

  it("空文档 → [0, 0) rows=1", () => {
    const range = findFocusRowRange("", 0, 1);
    expect(range).toEqual({ start: 0, end: 0, rows: 1 });
  });

  it("光标在空行（连续 \\n）→ 上下行全部包含", () => {
    // "a\n\nb"：a(0) \n(1) \n(2) b(3)；光标在位置 2（空行）
    const text = "a\n\nb";
    const range = findFocusRowRange(text, 2, 1);
    expect(range).toEqual({ start: 0, end: 4, rows: 3 });
  });

  it("光标恰在行尾 \\n 上 → 计入当前行，向下扩 1 行", () => {
    const text = "a\nb\nc";
    // 位置 1 是第 1 行末尾的 \n
    const range = findFocusRowRange(text, 1, 1);
    expect(range).toEqual({ start: 0, end: 3, rows: 2 });
  });

  it("radius=0 退化为单行（与 findParagraphRange 一致）", () => {
    const text = "l1\nl2\nl3";
    const range = findFocusRowRange(text, 4, 0);
    const single = findParagraphRange(text, 4);
    expect(range).toEqual({ start: single.start, end: single.end, rows: 1 });
  });

  it("radius=2 → 5 行窗；越界时收缩", () => {
    const range = findFocusRowRange(FIVE_LINES, 6, 2);
    // 光标在 l3，向上 2 行到 l1 起点 0，向下 2 行到 l5 末尾 14
    expect(range).toEqual({ start: 0, end: 14, rows: 5 });
  });

  it("越界光标钳制到合法范围", () => {
    expect(findFocusRowRange(FIVE_LINES, -5, 1)).toEqual({ start: 0, end: 5, rows: 2 });
    expect(findFocusRowRange(FIVE_LINES, 100, 1)).toEqual({ start: 9, end: 14, rows: 2 });
  });
});