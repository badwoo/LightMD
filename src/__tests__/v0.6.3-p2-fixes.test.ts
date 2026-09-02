/**
 * v0.6.3 批次3 P2 清扫测试
 *
 * 覆盖审核报告（docs/CODE_REVIEW_v0.6.2.md）：
 * - P1-6：hasTranslatableText 图片/链接语法剔除 + 纯数字块不可译
 * - P2-1：NO_KEY 错误码接线（parseTranslateError / translateErrorKey）
 * - P2-2：CANCELLED 文案不可达（回退 NETWORK）
 * - P2-3：translateService 删除 isTaskActive 死代码
 * - P2-13：URL_OR_EMAIL 不再有模块级带 g 状态正则（行为回归）
 */
import { describe, it, expect } from "vitest";
import { hasTranslatableText } from "../services/fullTranslate";
import { parseTranslateError } from "../services/translateService";
import { translateErrorKey } from "../components/editor/TranslateBubble";

// ─── P1-6：图片/链接语法与纯数字块 ───────────────────────

describe("v0.6.3 P1-6 hasTranslatableText 图片/链接/数字", () => {
  it("审核报告实证用例：纯数字块不可译", () => {
    expect(hasTranslatableText("2024")).toBe(false);
    expect(hasTranslatableText("3.14")).toBe(false);
  });

  it("无 alt 图片整块不可译", () => {
    expect(hasTranslatableText("![](a.png)")).toBe(false);
    expect(hasTranslatableText("![](https://example.com/i.png)")).toBe(false);
  });

  it("有 alt 图片：v0.6.4 起整体剔除（alt 不再参与判断——图片整体不翻译）", () => {
    expect(hasTranslatableText("![截图说明](a.png)")).toBe(false);
    expect(hasTranslatableText("![img](a.png)")).toBe(false);
  });

  it("纯链接块：链接文字参与判断（无文字不可译 / 有文字可译）", () => {
    expect(hasTranslatableText("[link](https://a.com)")).toBe(true);
    expect(hasTranslatableText("[](https://a.com)")).toBe(false);
  });

  it("数字夹在文字中仍可译", () => {
    expect(hasTranslatableText("v0.6.3 版本")).toBe(true);
    expect(hasTranslatableText("2024 年报告")).toBe(true);
    expect(hasTranslatableText("Chapter 2024")).toBe(true);
  });

  it("图片与正文混排可译", () => {
    expect(hasTranslatableText("![x](a.png)\n\n这是一段正文。")).toBe(true);
  });
});

// ─── P2-13：行为回归（多次调用结果一致） ─────────────────

describe("v0.6.3 P2-13 URL 剔除无跨调用状态", () => {
  it("连续调用结果一致（模块级无 lastIndex 泄漏）", () => {
    const a = hasTranslatableText("https://example.com");
    const b = hasTranslatableText("详见 https://example.com 文档");
    const c = hasTranslatableText("https://example.com");
    expect(a).toBe(false);
    expect(b).toBe(true);
    expect(c).toBe(false);
  });
});

// ─── P2-1 / P2-2：错误码接线 ────────────────────────────

describe("v0.6.3 P2-1/P2-2 错误码接线", () => {
  it("parseTranslateError 解析 NO_KEY 协议串", () => {
    expect(parseTranslateError("NO_KEY|未设置 API Key")).toEqual({
      code: "NO_KEY",
      detail: "未设置 API Key",
    });
  });

  it("translateErrorKey：NO_KEY 映射专属文案键", () => {
    expect(translateErrorKey("NO_KEY")).toBe("translate.error.NO_KEY");
  });

  it("translateErrorKey：CANCELLED 回退 NETWORK（文案不可达已删除）", () => {
    expect(translateErrorKey("CANCELLED")).toBe("translate.error.NETWORK");
  });
});
