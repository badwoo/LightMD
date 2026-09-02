/**
 * v0.6.0 入口接线测试：translateBridge 的 source（textarea）通道支持
 *
 * 覆盖：
 * - computeTextareaAnchor：多行行号偏移、滚动补偿、x 封顶（长行）
 * - buildSourceRewrite：replace 替换、bilingual 引用块追加（多行译文 "> " 前缀）、
 *   空译文/纯前后缀译文返回 null、光标位置
 */
import { describe, it, expect } from "vitest";
import { computeTextareaAnchor, buildSourceRewrite } from "../services/translateBridge";

// ─── computeTextareaAnchor ────────────────────────────────

describe("computeTextareaAnchor", () => {
  const baseRect = { left: 100, top: 200, width: 400 };
  const baseGeo = { lineHeight: 24, paddingTop: 10, paddingLeft: 12, charWidth: 8.4, scrollTop: 0 };

  it("第一行光标：锚点在 textarea 内边距起点", () => {
    const anchor = computeTextareaAnchor({
      rect: baseRect,
      geo: baseGeo,
      valueUpToCursor: "hello",
    });
    expect(anchor.x).toBeCloseTo(100 + 12 + 5 * 8.4);
    expect(anchor.y).toBeCloseTo(200 + 10);
  });

  it("多行文本：y 按行号 × 行高偏移", () => {
    const anchor = computeTextareaAnchor({
      rect: baseRect,
      geo: baseGeo,
      valueUpToCursor: "line1\nline2\nline3\nab",
    });
    // 第 4 行（行号 3），行内 2 字符
    expect(anchor.x).toBeCloseTo(100 + 12 + 2 * 8.4);
    expect(anchor.y).toBeCloseTo(200 + 10 + 3 * 24);
  });

  it("滚动偏移：scrollTop 从 y 中扣除", () => {
    const anchor = computeTextareaAnchor({
      rect: baseRect,
      geo: { ...baseGeo, scrollTop: 48 },
      valueUpToCursor: "line1\nline2\nab",
    });
    // 行号 2：200 + 10 + 2*24 - 48
    expect(anchor.y).toBeCloseTo(200 + 10 + 2 * 24 - 48);
  });

  it("长行：x 偏移封顶不越出右边界", () => {
    const anchor = computeTextareaAnchor({
      rect: baseRect,
      geo: baseGeo,
      valueUpToCursor: "x".repeat(500),
    });
    // 封顶：width - paddingLeft - 24 = 400 - 12 - 24 = 364
    expect(anchor.x).toBeCloseTo(100 + 12 + 364);
    expect(anchor.x).toBeLessThanOrEqual(baseRect.left + baseRect.width);
  });

  it("空文本：锚点在内边距起点", () => {
    const anchor = computeTextareaAnchor({ rect: baseRect, geo: baseGeo, valueUpToCursor: "" });
    expect(anchor.x).toBeCloseTo(112);
    expect(anchor.y).toBeCloseTo(210);
  });
});

// ─── buildSourceRewrite ───────────────────────────────────

describe("buildSourceRewrite", () => {
  const content = "# 标题\n\nHello **world**.\n\n尾部段落";

  it("replace：选区文本替换为译文，光标在译文末尾", () => {
    const start = content.indexOf("Hello");
    const end = start + "Hello **world**.".length;
    const rewrite = buildSourceRewrite(content, start, end, "你好**世界**。", "replace");
    expect(rewrite).not.toBeNull();
    expect(rewrite!.content).toBe("# 标题\n\n你好**世界**。\n\n尾部段落");
    expect(rewrite!.cursor).toBe(start + "你好**世界**。".length);
  });

  it("bilingual：原文保留，其后追加引用块译文", () => {
    const start = content.indexOf("Hello");
    const end = start + "Hello **world**.".length;
    const original = content.slice(start, end);
    const rewrite = buildSourceRewrite(content, start, end, "你好世界。", "bilingual");
    expect(rewrite).not.toBeNull();
    expect(rewrite!.content.startsWith(content.slice(0, end))).toBe(true);
    expect(rewrite!.content).toContain(`\n\n> 你好世界。\n`);
    // 原文仍在译文的引用块之前
    expect(rewrite!.content.indexOf(original)).toBeLessThan(rewrite!.content.indexOf("> 你好世界。"));
  });

  it("bilingual：多行译文每行都加 '> ' 前缀", () => {
    const start = 0;
    const end = 4; // "# 标题"
    const rewrite = buildSourceRewrite(content, start, end, "第一行\n\n第二段", "bilingual");
    expect(rewrite).not.toBeNull();
    expect(rewrite!.content).toContain("# 标题\n\n> 第一行\n>\n> 第二段\n");
  });

  it("空译文（清洗后为空）返回 null", () => {
    expect(buildSourceRewrite(content, 0, 4, "", "replace")).toBeNull();
    expect(buildSourceRewrite(content, 0, 4, "   \n  ", "replace")).toBeNull();
  });

  it("纯客套后缀译文清洗后为空返回 null", () => {
    expect(buildSourceRewrite(content, 0, 4, "希望对你有帮助。", "replace")).toBeNull();
  });

  it("带围栏包裹的译文被剥离后正常替换", () => {
    const start = content.indexOf("Hello");
    const end = content.indexOf("world") + 5;
    const rewrite = buildSourceRewrite(content, start, end, "```\n你好世界。\n```", "replace");
    expect(rewrite).not.toBeNull();
    expect(rewrite!.content).toContain("你好世界。");
    expect(rewrite!.content).not.toContain("```");
  });

  it("bilingual 光标位于译文引用块末尾", () => {
    const start = 0;
    const end = 4;
    const rewrite = buildSourceRewrite(content, start, end, "你好", "bilingual");
    expect(rewrite).not.toBeNull();
    expect(rewrite!.content[rewrite!.cursor]).toBe("\n"); // 光标后是结尾换行
    expect(rewrite!.content.slice(0, rewrite!.cursor).endsWith("> 你好")).toBe(true);
  });
});
