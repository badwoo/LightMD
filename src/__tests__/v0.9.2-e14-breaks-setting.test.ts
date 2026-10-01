/**
 * E14(v0.9.2):段内换行语义设置项(markdown-it 工厂参数化)
 *
 * 修复前:markdown-it 三处独立实例化(parser.ts / exportBlocks.ts / ExportDialog.tsx)
 * 全部硬编码 breaks:true,无任何段内换行设置项。
 * 验收:
 * ①gfm(默认):单换行 → hard_break,序列化 "  \n"(现状回归)
 * ②commonmark:单换行 → 同段空格;"  \n" 仍为硬换行
 * ③两种模式 md→doc→md 往返稳定
 * ④设置项持久化(setter 生效,默认 gfm)
 * ⑤工厂实例配置一致(插件齐备,白名单生效)
 */
import { describe, it, expect, beforeEach } from "vitest";
import { markdownToDoc, getMarkdownIt, createMarkdownIt } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import { lightMDSchema as schema } from "../core/schema";
import { useSettingsStore } from "../stores/useSettingsStore";

/** 手动构造段落(a<hard_break>b),不经解析器(无 B6 原文标记),测 inline 序列化路径 */
function hardBreakDoc() {
  return schema.topNodeType.create(null, [
    schema.nodes.paragraph.create(null, [
      schema.text("a"),
      schema.nodes.hard_break.create(),
      schema.text("b"),
    ]),
  ]);
}

describe("E14: gfm 模式(默认,现状回归)", () => {
  beforeEach(() => {
    useSettingsStore.getState().setParagraphBreaks("gfm");
  });

  it("单换行 → hard_break 节点", () => {
    const doc = markdownToDoc("a\nb");
    let hasHardBreak = false;
    doc.descendants((n) => {
      if (n.type.name === "hard_break") hasHardBreak = true;
    });
    expect(hasHardBreak).toBe(true);
  });

  it("hard_break 节点序列化输出两空格硬换行(inline 路径)", () => {
    expect(docToMarkdown(hardBreakDoc()).trim()).toBe("a  \nb");
  });

  it("md→doc→md 往返稳定(B6 未编辑块保留原文)", () => {
    const once = docToMarkdown(markdownToDoc("a\nb"));
    const twice = docToMarkdown(markdownToDoc(once));
    expect(twice).toBe(once);
  });
});

describe("E14: commonmark 模式", () => {
  beforeEach(() => {
    useSettingsStore.getState().setParagraphBreaks("commonmark");
  });

  it("单换行 → 同段空格(渲染语义)", () => {
    const doc = markdownToDoc("a\nb");
    expect(doc.textContent).toBe("a b");
    let hasHardBreak = false;
    doc.descendants((n) => {
      if (n.type.name === "hard_break") hasHardBreak = true;
    });
    expect(hasHardBreak).toBe(false);
  });

  it('两空格硬换行 "  \\n" 仍为 hard_break', () => {
    const doc = markdownToDoc("a  \nb");
    let hasHardBreak = false;
    doc.descendants((n) => {
      if (n.type.name === "hard_break") hasHardBreak = true;
    });
    expect(hasHardBreak).toBe(true);
    expect(docToMarkdown(hardBreakDoc())).toContain("a  \nb");
  });

  it("md→doc→md 往返稳定(B6 未编辑块保留原文)", () => {
    const once = docToMarkdown(markdownToDoc("a\nb"));
    expect(once).toBe("a\nb"); // B6:未编辑块逐字节返回源文本
    const twice = docToMarkdown(markdownToDoc(once));
    expect(twice).toBe(once);
  });

  it("显式 opts.breaks 覆盖设置(调用方直控)", () => {
    const doc = markdownToDoc("a\nb", { breaks: true });
    expect(doc.textContent).toBe("ab"); // hard_break 无文本内容
    let hasHardBreak = false;
    doc.descendants((n) => {
      if (n.type.name === "hard_break") hasHardBreak = true;
    });
    expect(hasHardBreak).toBe(true);
  });
});

describe("E14: 设置持久化与工厂一致性", () => {
  it("默认值为 gfm,setter 生效", () => {
    useSettingsStore.getState().setParagraphBreaks("commonmark");
    expect(useSettingsStore.getState().paragraphBreaks).toBe("commonmark");
    useSettingsStore.getState().setParagraphBreaks("gfm");
    expect(useSettingsStore.getState().paragraphBreaks).toBe("gfm");
  });

  it("工厂实例:commonmark 实例 breaks 关闭但插件齐备(公式/脚注)", () => {
    const cm = getMarkdownIt(false);
    // 插件齐备:公式/脚注/mark 语法可解析
    expect(cm.render("$x$\n\n[^1]: note")).toContain("data-math");
    expect(getMarkdownIt(true)).toBe(getMarkdownIt(true)); // gfm 实例复用
  });

  it("工厂创建的实例拒绝 javascript: 链接(白名单贯通)", () => {
    const inst = createMarkdownIt({ breaks: true });
    expect(inst.validateLink?.("javascript:alert(1)")).toBe(false);
    expect(inst.validateLink?.("https://example.com")).toBe(true);
  });

  it("无显式 opts 时 markdownToDoc 跟随设置", () => {
    useSettingsStore.getState().setParagraphBreaks("commonmark");
    expect(markdownToDoc("a\nb").textContent).toBe("a b");
    useSettingsStore.getState().setParagraphBreaks("gfm");
    expect(markdownToDoc("a\nb").textContent).toBe("ab");
  });
});
