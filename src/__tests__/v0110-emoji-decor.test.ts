/**
 * v0.11.0 B4-8：Emoji 短码渲染层显示为图形（doc 与序列化不变）。
 *
 * 缺陷背景（P1）：
 *   `parser.ts`（v0.9.0 D9）**故意**保留 `:smile:` 短码原文以保证源码可逆，
 *   但阅读模式（走 PM toDOM）显示短码文字，而分屏/导出（走 markdown-it）
 *   渲染为 😄 → **两种编辑模式不一致**。
 *
 * 修复：NodeView 在渲染层把短码替换为 unicode，**doc 不变**。
 * 本测试验证三件事：
 * ① 渲染层确实把可识别短码换成 unicode；
 * ② 存盘（序列化）仍是短码原文 —— 这是本方案的核心约束；
 * ③ 不可识别短码 / 代码语境不替换。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getMarkdownIt } from "../core/markdown/parser";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import { renderEmojiInText, resolveUnicode, clearEmojiCache, hasRenderableShortcode } from "../core/plugins/emoji-render";

const md = getMarkdownIt(true);

describe("v0.11.0 B4-8 Emoji 渲染层替换", () => {
  beforeEach(() => clearEmojiCache());

  it("可识别短码被替换为 unicode", () => {
    const out = renderEmojiInText("hello :smile: world", md);
    expect(out).not.toContain(":smile:");
    expect(out).toContain("😄");
    expect(out).toContain("hello ");
    expect(out).toContain(" world");
  });

  it("同一文本中的多个短码全部替换", () => {
    const out = renderEmojiInText(":smile: and :heart:", md);
    expect(out).not.toContain(":smile:");
    expect(out).not.toContain(":heart:");
  });

  it("不含短码的文本原样返回（同一引用，零分配）", () => {
    const text = "plain text";
    expect(renderEmojiInText(text, md)).toBe(text);
  });

  it("含冒号但非短码形态的文本不改动", () => {
    const text = "a:b and http://x.com";
    expect(renderEmojiInText(text, md)).toBe(text);
  });

  it("不可识别的短码保持原文（不误替换）", () => {
    const out = renderEmojiInText("x :not_a_real_emoji_xyz: y", md);
    expect(out).toBe("x :not_a_real_emoji_xyz: y");
  });

  it("resolveUnicode 对已知/未知短码返回不同结果", () => {
    expect(resolveUnicode(md, "smile")).toBeTruthy();
    expect(resolveUnicode(md, "definitely_not_emoji_zzz")).toBeNull();
  });

  it("hasRenderableShortcode 判定正确", () => {
    expect(hasRenderableShortcode("hi :smile:", md)).toBe(true);
    expect(hasRenderableShortcode("hi :nope_zzz:", md)).toBe(false);
    expect(hasRenderableShortcode("no colon", md)).toBe(false);
  });

  it("【核心约束】渲染替换不影响 doc 与序列化（存盘仍是短码）", () => {
    const src = "hello :smile: world";
    const doc = markdownToDoc(src);
    // doc 层仍是短码原文
    expect(doc.textContent).toContain(":smile:");
    expect(doc.textContent).not.toContain("😄");
    // 序列化后仍是短码
    expect(docToMarkdown(doc)).toContain(":smile:");
    // 而渲染层显示为图形
    expect(renderEmojiInText(doc.textContent, md)).toContain("😄");
  });

  it("复制/导出拿到的仍是短码（与渲染层解耦）", () => {
    // 分屏预览与导出走 markdown-it，行为一致（都渲染为图形）
    expect(md.render("hello :smile:")).toContain("😄");
    // 而 PM 侧存盘保持短码
    const doc = markdownToDoc("hello :smile:");
    expect(docToMarkdown(doc)).toContain(":smile:");
  });
});
