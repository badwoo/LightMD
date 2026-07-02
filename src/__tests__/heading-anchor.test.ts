/**
 * 标题锚点（heading id）测试（P21）
 *
 * 验证：
 * 1. slugify 规则：小写、空格转连字符、移除特殊字符、保留中文
 * 2. 分屏预览渲染时 h1~h6 自动带 id 属性
 * 3. 同名标题去重（-1、-2 后缀）
 * 4. id 与正文文本一致（[链接](#id) 可跳转）
 */
import { describe, it, expect } from "vitest";
import { md } from "../core/markdown/parser";
import { slugify } from "../core/markdown/heading-anchor";

describe("slugify 规则", () => {
  it("英文转小写、空格转连字符", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("移除标点但保留文本", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
  });

  it("保留中文", () => {
    expect(slugify("标题一")).toBe("标题一");
  });

  it("中英混排，空格转连字符", () => {
    expect(slugify("Hello 世界")).toBe("hello-世界");
  });

  it("中文与符号：符号被移除，空格转连字符", () => {
    expect(slugify("标题 & 测试")).toBe("标题-测试");
  });

  it("合并连续连字符、去除首尾连字符", () => {
    expect(slugify("  Hello   World  ")).toBe("hello-world");
    expect(slugify("---Hello---")).toBe("hello");
  });

  it("空文本兜底为空字符串（由调用方处理）", () => {
    expect(slugify("")).toBe("");
    expect(slugify("!!!")).toBe("");
  });

  it("数字保留", () => {
    expect(slugify("Chapter 1")).toBe("chapter-1");
  });
});

describe("标题 id 自动生成（分屏预览渲染）", () => {
  it("h1~h6 应带 id 属性", () => {
    const html = md.render("# 标题一\n## 标题二\n### 标题三\n#### H4\n##### H5\n###### H6\n");
    expect(html).toMatch(/<h1 id="标题一">/);
    expect(html).toMatch(/<h2 id="标题二">/);
    expect(html).toMatch(/<h3 id="标题三">/);
    expect(html).toMatch(/<h4 id="h4">/);
    expect(html).toMatch(/<h5 id="h5">/);
    expect(html).toMatch(/<h6 id="h6">/);
  });

  it("英文标题转小写连字符", () => {
    const html = md.render("# Hello World\n");
    expect(html).toMatch(/<h1 id="hello-world">/);
  });

  it("含代码的标题文本被纳入 id", () => {
    const html = md.render("# Hello `Code`\n");
    expect(html).toMatch(/<h1 id="hello-code">/);
  });

  it("同名标题去重：第二次加 -1，第三次加 -2", () => {
    const html = md.render("# Intro\n# Intro\n# Intro\n");
    expect(html).toMatch(/<h1 id="intro">/);
    expect(html).toMatch(/<h1 id="intro-1">/);
    expect(html).toMatch(/<h1 id="intro-2">/);
  });

  it("不同标题互不影响", () => {
    const html = md.render("# A\n## A\n### B\n## A\n");
    // A / A / B / A: A 出现 3 次（不区分层级），B 出现 1 次
    expect(html).toMatch(/<h1 id="a">/);
    expect(html).toMatch(/<h2 id="a-1">[^]*<h3 id="b">/);
    expect(html).toMatch(/<h3 id="b">/);
    expect(html).toMatch(/<h2 id="a-2">/);
  });

  it("特殊字符被移除", () => {
    const html = md.render("# C++ & Java!\n");
    expect(html).toMatch(/<h1 id="c-java">/);
  });

  it("ProseMirror 解析不受影响（markdownToDoc 仍正常）", async () => {
    const { markdownToDoc } = await import("../core/markdown/parser");
    const doc = markdownToDoc("# 标题\n\n正文\n");
    const heading = doc.firstChild!;
    expect(heading.type.name).toBe("heading");
    expect(heading.attrs.level).toBe(1);
  });
});
