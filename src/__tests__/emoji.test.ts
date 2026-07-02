/**
 * Emoji 功能测试（P9）
 *
 * 验证：:smile: 等 emoji 短码被解析为 unicode 字符
 * emoji 直接输出 unicode，无需 ProseMirror 节点
 */
import { describe, it, expect } from "vitest";
import { markdownToDoc, markdownToInline } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import { md } from "../core/markdown/parser";

describe("Emoji :smile:", () => {
  it("markdown-it-emoji 应将 :smile: 渲染为 unicode 字符", () => {
    const html = md.render(":smile:");
    // 😄 是 smile 的 unicode
    expect(html).toContain("😄");
  });

  it("markdownToDoc 解析后 emoji 作为普通文本节点存在", () => {
    const doc = markdownToDoc(":smile:\n");
    const para = doc.firstChild!;
    const text = para.textContent;
    expect(text).toContain("😄");
  });

  it("序列化时 emoji unicode 保持原样", () => {
    const src = "我笑了😄\n";
    const doc = markdownToDoc(src);
    const out = docToMarkdown(doc);
    expect(out).toContain("😄");
  });

  it("支持多种 emoji 短码", () => {
    const html = md.render(":heart: :+1: :100:");
    expect(html).toContain("❤");
    expect(html).toContain("👍");
    expect(html).toContain("💯");
  });

  it("未知 emoji 短码保持原样", () => {
    // 未知短码不会被转换
    const html = md.render(":unknown_emoji_xyz:");
    expect(html).toContain(":unknown_emoji_xyz:");
  });
});
