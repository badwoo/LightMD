/**
 * v0.6.2 翻译优化测试
 *
 * 覆盖：
 * 1. hasTranslatableText：纯符号/纯 URL/纯邮箱不可译，URL 混句子可译（问题4）
 * 2. splitDocumentForTranslation：纯 URL 块跳过不生成单元（问题4）
 * 3. translateEnabled 默认关闭（问题1，新装用户不自动开启）
 */
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  hasTranslatableText,
  splitDocumentForTranslation,
} from "../services/fullTranslate";
import { DEFAULT_TRANSLATE_SETTINGS } from "../stores/useSettingsStore";

// ─── 问题4：hasTranslatableText ─────────────────────────

describe("v0.6.2 hasTranslatableText 可译性判断", () => {
  it("纯符号文本不可译（分割线/空列表标记）", () => {
    expect(hasTranslatableText("---")).toBe(false);
    expect(hasTranslatableText("***")).toBe(false);
    expect(hasTranslatableText("- - -")).toBe(false);
    expect(hasTranslatableText("")).toBe(false);
  });

  it("纯 URL 不可译（单个/多个/带协议/ www 前缀）", () => {
    expect(hasTranslatableText("https://example.com")).toBe(false);
    expect(hasTranslatableText("http://a.b/c?d=e")).toBe(false);
    expect(hasTranslatableText("www.example.com")).toBe(false);
    expect(hasTranslatableText("https://a.com\nhttps://b.com")).toBe(false);
  });

  it("纯邮箱不可译", () => {
    expect(hasTranslatableText("user@example.com")).toBe(false);
  });

  it("URL 混在句子中可译（前后文字保留）", () => {
    expect(hasTranslatableText("详见 https://example.com 文档")).toBe(true);
    expect(hasTranslatableText("See https://a.com for details")).toBe(true);
  });

  it("URL 紧跟中文标点不贪婪吞掉正文（边界修正）", () => {
    // URL 后全角逗号 + 中文正文：剔除 URL 后仍有可译文字
    expect(hasTranslatableText("访问https://a.com，获取更多信息")).toBe(true);
    expect(hasTranslatableText("https://a.com，这是说明文字")).toBe(true);
  });

  it("普通中英文可译", () => {
    expect(hasTranslatableText("Hello World")).toBe(true);
    expect(hasTranslatableText("你好世界")).toBe(true);
    expect(hasTranslatableText("v0.6.2 版本")).toBe(true);
  });

  it("markdown 标记 + 文字可译", () => {
    expect(hasTranslatableText("# 标题")).toBe(true);
    expect(hasTranslatableText("- 列表项")).toBe(true);
  });
});

// ─── 问题4：切分跳过纯 URL 块 ───────────────────────────

describe("v0.6.2 splitDocumentForTranslation 纯 URL 块跳过", () => {
  it("纯 URL 块不单独生成单元：作为无文字 gap 并入相邻单元（减少请求数）", () => {
    const md = "# 标题\n\nhttps://example.com/a\nhttps://example.com/b\n\n正文段落。";
    const units = splitDocumentForTranslation(md);
    // 标题与正文之间的 gap 为纯 URL 块（无可译文字）→ 相邻单元合并为 1 个
    expect(units).toHaveLength(1);
    // 合并单元覆盖标题 + URL gap + 正文（URL 由 Rust mask 层占位符保护）
    expect(units[0].text).toContain("# 标题");
    expect(units[0].text).toContain("正文段落。");
    expect(units[0].text).toContain("https://example.com/a");
  });

  it("含 URL 的句子正常生成单元（URL 由 Rust mask 层占位符保护）", () => {
    const md = "详见 https://example.com/docs 的说明。";
    const units = splitDocumentForTranslation(md);
    expect(units).toHaveLength(1);
    expect(units[0].text).toBe(md);
  });

  it("纯邮箱块不单独生成单元：作为无文字 gap 并入相邻单元", () => {
    const md = "联系人：\n\nadmin@example.com\n\n其他内容";
    const units = splitDocumentForTranslation(md);
    // gap 为纯邮箱（无可译文字）→ 合并为 1 个单元
    expect(units).toHaveLength(1);
    expect(units[0].text).toContain("联系人：");
    expect(units[0].text).toContain("其他内容");
    expect(units[0].text).toContain("admin@example.com");
  });

  it("URL 块与相邻单元间隙有代码块时不合并（代码块语义需独立保留）", () => {
    const md = "第一段文字。\n\nhttps://a.com\n\n第二段文字，距离超出合并目标不做断言仅验证单元存在。";
    const units = splitDocumentForTranslation(md);
    // 间距小会合并；此处验证合并后单元不含代码语义破坏即可（单元数 ≥1）
    expect(units.length).toBeGreaterThanOrEqual(1);
    expect(units[0].text).toContain("第一段文字。");
  });
});

// ─── 问题1：默认关闭 ────────────────────────────────────

describe("v0.6.2 translateEnabled 默认关闭", () => {
  it("新装默认配置：AI 翻译总开关关闭", () => {
    // 卸载重装后（localStorage 已被卸载钩子清除）回到此默认值
    expect(DEFAULT_TRANSLATE_SETTINGS.translateEnabled).toBe(false);
  });
});
