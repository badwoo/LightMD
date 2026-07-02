/**
 * 源码模式专注遮罩行定位测试
 *
 * 测试 findParagraphRange、paragraphLineRange 和 resolveLineHeight 的正确性
 * 确保在 edit/split 模式下，专注遮罩能正确定位光标所在行
 *
 * 注意：findParagraphRange 现在按单个 \n 分隔行（行级高亮），而非 \n\n 分隔段落。
 * 这样用户按回车键换行时，专注高亮能立即跟随到新行。
 */
import { describe, it, expect } from "vitest";
import { findParagraphRange, paragraphLineRange, resolveLineHeight } from "../utils/focus-paragraph";

describe("findParagraphRange", () => {
  it("空文档：返回 [0, 0)", () => {
    const text = "";
    const range = findParagraphRange(text, 0);
    expect(range).toEqual({ start: 0, end: 0 });
  });

  it("单段落文档：返回整个文档", () => {
    const text = "hello world";
    const range = findParagraphRange(text, 5);
    expect(range).toEqual({ start: 0, end: 11 });
  });

  it("两行文档：光标在第一行，返回第一行区间", () => {
    const text = "第一段内容\n\n第二段内容";
    // 光标在 "第" 之后（位置 1），第一行是 "第一段内容"（0-5）
    const range = findParagraphRange(text, 1);
    expect(range).toEqual({ start: 0, end: 5 });
  });

  it("两行文档：光标在第二行，返回第二行区间", () => {
    const text = "第一段内容\n\n第二段内容";
    // 文档结构：第一段内容(0-4) + \n(5) + \n(6) + 第二段内容(7-11)，总长度 12
    // 光标在位置 8（"二"），第二行从位置 7 开始，到文档末尾 12 结束
    const range = findParagraphRange(text, 8);
    expect(range).toEqual({ start: 7, end: 12 });
  });

  it("光标在空行（\\n\\n 之间的位置）", () => {
    const text = "第一段\n\n第二段";
    // 文档结构：第一段(0-2) + \n(3) + \n(4) + 第二段(5-7)，总长度 8
    // 光标在位置 4（第二个 \n），位于空行上
    // 向前找 \n：i=3, text[3]='\n'，start=4
    // 向后找 \n：i=4, text[4]='\n'，end=4
    // 返回空行 { start: 4, end: 4 }
    const range = findParagraphRange(text, 4);
    expect(range).toEqual({ start: 4, end: 4 });
  });

  it("光标在第二个 \\n 之后（下一行开头）", () => {
    const text = "第一段\n\n第二段";
    // 光标在位置 5（"第二段" 的 "第"），归入下一行
    // 第二行从位置 5 开始，到文档末尾 8 结束
    const range = findParagraphRange(text, 5);
    expect(range).toEqual({ start: 5, end: 8 });
  });

  it("多行文档：中间行", () => {
    const text = "段落一\n\n段落二\n\n段落三";
    // 文档结构：段落一(0-2) + \n(3) + \n(4) + 段落二(5-7) + \n(8) + \n(9) + 段落三(10-12)
    // 光标在位置 8（\n），位于空行上
    // 向前找 \n：i=7, text[7]='二'...i=4, text[4]='\n'，start=5
    // 向后找 \n：i=8, text[8]='\n'，end=8
    // 返回 { start: 5, end: 8 }（"段落二"）
    const range = findParagraphRange(text, 8);
    expect(range).toEqual({ start: 5, end: 8 });
  });

  it("光标超出文档末尾：钳制到 length", () => {
    const text = "abc";
    const range = findParagraphRange(text, 100);
    expect(range).toEqual({ start: 0, end: 3 });
  });

  it("光标为负数：钳制到 0", () => {
    const text = "abc";
    const range = findParagraphRange(text, -5);
    expect(range).toEqual({ start: 0, end: 3 });
  });

  it("行内含软换行：每行独立高亮", () => {
    // 行级高亮：单 \n 分隔行，"第一行" 和 "第二行" 是不同的行
    const text = "第一行\n第二行\n\n第二段";
    // 文档结构：第一行(0-2) + \n(3) + 第二行(4-6) + \n(7) + \n(8) + 第二段(9-11)
    // 光标在 "第二行" 中（位置 5）
    // 向前找 \n：i=4, text[4]='第'...i=3, text[3]='\n'，start=4
    // 向后找 \n：i=5, text[5]='二'...i=7, text[7]='\n'，end=7
    // 返回 { start: 4, end: 7 }（"第二行"）
    const range = findParagraphRange(text, 5);
    expect(range).toEqual({ start: 4, end: 7 });
  });

  it("文档以空行开头：光标在内容行", () => {
    const text = "\n\n实际内容";
    // 文档结构：\n(0) + \n(1) + 实际内容(2-5)，总长度 6
    // 光标在 "实" 之后（位置 3）
    // 向前找 \n：i=2, text[2]='实'...i=1, text[1]='\n'，start=2
    // 向后找 \n：i=3, text[3]='际'...没有 \n，end=6
    // 返回 { start: 2, end: 6 }（"实际内容"）
    const range = findParagraphRange(text, 3);
    expect(range).toEqual({ start: 2, end: 6 });
  });

  it("文档以空行结尾：光标在内容行", () => {
    const text = "实际内容\n\n";
    // 文档结构：实际内容(0-3) + \n(4) + \n(5)，总长度 6
    // 光标在 "实" 之后（位置 1）
    // 向前找 \n：i=0, text[0]='实'...没有 \n，start=0
    // 向后找 \n：i=1, text[1]='际'...i=4, text[4]='\n'，end=4
    // 返回 { start: 0, end: 4 }（"实际内容"）
    const range = findParagraphRange(text, 1);
    expect(range).toEqual({ start: 0, end: 4 });
  });

  it("多个连续空行：光标在内容行", () => {
    const text = "段落一\n\n\n\n段落二";
    // 文档结构：段落一(0-2) + \n(3) + \n(4) + \n(5) + \n(6) + 段落二(7-9)，总长度 10
    // 光标在 "段落二" 中（位置 8）
    // 向前找 \n：i=7, text[7]='段'...i=6, text[6]='\n'，start=7
    // 向后找 \n：i=8, text[8]='落'...没有 \n，end=10
    // 返回 { start: 7, end: 10 }（"段落二"）
    const range = findParagraphRange(text, 8);
    expect(range).toEqual({ start: 7, end: 10 });
  });
});

describe("paragraphLineRange", () => {
  it("单行段落：起止行号相同", () => {
    const text = "hello";
    const range = findParagraphRange(text, 2);
    const { startLine, endLine } = paragraphLineRange(text, range);
    expect(startLine).toBe(0);
    expect(endLine).toBe(0);
  });

  it("两段落文档：第一段行号 0-0", () => {
    const text = "第一段\n\n第二段";
    const range = findParagraphRange(text, 1);
    const { startLine, endLine } = paragraphLineRange(text, range);
    expect(startLine).toBe(0);
    expect(endLine).toBe(0);
  });

  it("两段落文档：第二段行号 2-2", () => {
    const text = "第一段\n\n第二段";
    const range = findParagraphRange(text, 8);
    const { startLine, endLine } = paragraphLineRange(text, range);
    expect(startLine).toBe(2);
    expect(endLine).toBe(2);
  });

  it("行级高亮：每行独立，行号正确", () => {
    const text = "第一行\n第二行\n\n第二段";
    // 行级高亮：光标在 "第二行"（位置 5），range = { start: 4, end: 7 }
    // "第二行" 在行 1（第一行是行 0）
    const range = findParagraphRange(text, 5);
    const { startLine, endLine } = paragraphLineRange(text, range);
    expect(startLine).toBe(1);
    expect(endLine).toBe(1);
  });

  it("多段落文档：中间段落行号正确", () => {
    const text = "段落一\n\n段落二\n\n段落三";
    // 段落二在行 2，段落三在行 4
    const range = findParagraphRange(text, 8);
    const { startLine, endLine } = paragraphLineRange(text, range);
    expect(startLine).toBe(2);
    expect(endLine).toBe(2);
  });

  it("空文档：行号均为 0", () => {
    const text = "";
    const range = findParagraphRange(text, 0);
    const { startLine, endLine } = paragraphLineRange(text, range);
    expect(startLine).toBe(0);
    expect(endLine).toBe(0);
  });
});

// ─── resolveLineHeight 测试 ────────────────────────────
// 修复 bug：
// 1. getComputedStyle 对 textarea 可能返回 "normal"，parseFloat 返回 NaN
// 2. CSS line-height 设为无单位相对值（如 1.8）时，getComputedStyle 返回 "1.8"，
//    parseFloat 得到 1.8（不是像素值），导致专注遮罩 Y 坐标累计偏移
describe("resolveLineHeight", () => {
  /** 构造 mock CSSStyleDeclaration，只填充 lineHeight 和 fontSize */
  function mockCS(lineHeight: string, fontSize: string): CSSStyleDeclaration {
    return { lineHeight, fontSize } as unknown as CSSStyleDeclaration;
  }

  it("lineHeight 为像素值时直接返回", () => {
    // 28.8px 是 16px * 1.8 的结果
    const cs = mockCS("28.8px", "16px");
    expect(resolveLineHeight(cs)).toBe(28.8);
  });

  it("lineHeight 为整数像素值时直接返回", () => {
    const cs = mockCS("24px", "16px");
    expect(resolveLineHeight(cs)).toBe(24);
  });

  it('lineHeight 为 "normal" 时回退到 fontSize * 1.8', () => {
    // 这是 bug 的核心场景：textarea 的 getComputedStyle 可能返回 "normal"
    const cs = mockCS("normal", "16px");
    expect(resolveLineHeight(cs)).toBe(28.8);
  });

  it('lineHeight 为 "normal" 且 fontSize 为 18px 时返回 32.4', () => {
    const cs = mockCS("normal", "18px");
    expect(resolveLineHeight(cs)).toBe(32.4);
  });

  it("lineHeight 为空字符串时回退到 fontSize * 1.8", () => {
    const cs = mockCS("", "16px");
    expect(resolveLineHeight(cs)).toBe(28.8);
  });

  it("lineHeight 和 fontSize 都无效时返回 16 * 1.8 = 28.8（最终兜底）", () => {
    const cs = mockCS("normal", "invalid");
    expect(resolveLineHeight(cs)).toBe(28.8);
  });

  it("lineHeight 为 0 时视为无效，回退到 fontSize * 1.8", () => {
    // lineHeight 0 在 CSS 中是非法的，应回退
    const cs = mockCS("0px", "16px");
    expect(resolveLineHeight(cs)).toBe(28.8);
  });

  it("lineHeight 为负值时视为无效，回退到 fontSize * 1.8", () => {
    const cs = mockCS("-10px", "16px");
    expect(resolveLineHeight(cs)).toBe(28.8);
  });

  // ─── 无单位相对值 bug 修复测试（核心场景）──────────────
  // CSS line-height: 1.8 是无单位相对值，浏览器 getComputedStyle 返回字符串 "1.8"
  // 早期实现 parseFloat("1.8") = 1.8，直接返回 1.8（错误！应为 28.8）
  // 导致专注遮罩每行偏移 27px（28.8 - 1.8），多行后高亮位置完全错位
  it('lineHeight 为无单位相对值 "1.8" 时返回 fontSize * 1.8', () => {
    const cs = mockCS("1.8", "16px");
    expect(resolveLineHeight(cs)).toBe(28.8);
  });

  it('lineHeight 为无单位相对值 "1.5" 时返回 fontSize * 1.5', () => {
    const cs = mockCS("1.5", "16px");
    expect(resolveLineHeight(cs)).toBe(24);
  });

  it('lineHeight 为无单位相对值 "2" 时返回 fontSize * 2', () => {
    const cs = mockCS("2", "18px");
    expect(resolveLineHeight(cs)).toBe(36);
  });

  it("lineHeight 为无单位相对值且 fontSize 为 20px 时正确计算", () => {
    const cs = mockCS("1.8", "20px");
    expect(resolveLineHeight(cs)).toBe(36); // 20 * 1.8
  });

  it("验证 bug 修复场景：第 10 行段落高亮位置不偏移（normal 情况）", () => {
    // 修复前：lineHeight=20（错误回退），第 10 行 Y = 10 * 20 = 200
    // 修复后：lineHeight=28.8（fontSize 16 * 1.8），第 10 行 Y = 10 * 28.8 = 288
    // 偏差 = 88px，这正是用户报告的"高亮位置不在编辑区域"的原因
    const cs = mockCS("normal", "16px");
    const lineHeight = resolveLineHeight(cs);
    const line10Y = 10 * lineHeight;
    expect(line10Y).toBe(288);
    expect(line10Y).not.toBe(200); // 修复前的错误值
  });

  it("验证 bug 修复场景：无单位相对值 1.8 不再被错误当作像素值", () => {
    // 修复前：lineHeight=1.8（parseFloat("1.8") 直接返回，错误）
    //         第 10 行 Y = 10 * 1.8 = 18（完全错误，应该是 288）
    // 修复后：lineHeight=28.8（fontSize 16 * 1.8），第 10 行 Y = 288
    // 偏差 = 270px，多行后高亮完全错位到"上一行"
    const cs = mockCS("1.8", "16px");
    const lineHeight = resolveLineHeight(cs);
    const line10Y = 10 * lineHeight;
    expect(line10Y).toBe(288);
    expect(line10Y).not.toBe(18); // 修复前的错误值
    expect(lineHeight).not.toBe(1.8); // 修复前的错误返回值
  });

  it("验证 bug 修复场景：模拟 textarea 实际渲染场景", () => {
    // 模拟 editor.css 中 .source-editor 的实际配置：line-height: 1.8, font-size: 16px
    // 用户点击第 5 行（行号 4，基于 0），期望高亮 Y 在 4 * 28.8 = 115.2
    // 修复前：4 * 1.8 = 7.2（高亮在第 0 行附近，视觉上像"在上一行"）
    const cs = mockCS("1.8", "16px");
    const lineHeight = resolveLineHeight(cs);
    const line4Y = 4 * lineHeight;
    expect(line4Y).toBe(115.2);
    expect(line4Y).not.toBe(7.2); // 修复前的错误值
  });
});
