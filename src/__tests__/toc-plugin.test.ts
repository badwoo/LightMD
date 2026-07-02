/**
 * TOC 自动目录测试（P17）
 *
 * 验证：
 * 1. [toc] / [[toc]] / [TOC] 都能识别
 * 2. 渲染为 <nav class="toc"><ul>...</ul></nav>
 * 3. 每个条目 <a href="#id">文本</a>，与标题 id 一致（锚点链接可跳转）
 * 4. 嵌套结构（h1 > h2 > h3）
 * 5. 无标题时输出空 nav
 * 6. 多个 [toc] 共享同一份 headings（效率）
 */
import { describe, it, expect } from "vitest";
import { md } from "../core/markdown/parser";

describe("TOC 语法识别", () => {
  it("[toc] 渲染为 nav.toc", () => {
    const html = md.render("[toc]\n");
    expect(html).toMatch(/<nav class="toc">/);
    expect(html).toMatch(/<\/nav>/);
  });

  it("[[toc]] 同样渲染", () => {
    const html = md.render("[[toc]]\n");
    expect(html).toMatch(/<nav class="toc">/);
  });

  it("[TOC] 大小写不敏感", () => {
    const html = md.render("[TOC]\n");
    expect(html).toMatch(/<nav class="toc">/);
  });

  it("[ToC] 混合大小写也可识别", () => {
    const html = md.render("[ToC]\n");
    expect(html).toMatch(/<nav class="toc">/);
  });

  it("行内 [toc] 不识别（保留为段落文本）", () => {
    const html = md.render("text [toc] text\n");
    expect(html).not.toMatch(/<nav class="toc">/);
  });
});

describe("TOC 链接与标题 id 一致", () => {
  it("TOC 条目 href 与标题 id 完全一致（可跳转）", () => {
    const src = "[toc]\n\n# Hello World\n## 中文标题\n### C++\n";
    const html = md.render(src);
    // 标题 id
    expect(html).toMatch(/<h1 id="hello-world">/);
    expect(html).toMatch(/<h2 id="中文标题">/);
    expect(html).toMatch(/<h3 id="c">/);
    // TOC 链接
    expect(html).toMatch(/<a href="#hello-world">Hello World<\/a>/);
    expect(html).toMatch(/<a href="#中文标题">中文标题<\/a>/);
    expect(html).toMatch(/<a href="#c">C\+\+<\/a>/);
  });

  it("TOC 出现在标题之后也能正确收集（全文档扫描）", () => {
    const src = "# A\n## B\n\n[toc]\n";
    const html = md.render(src);
    expect(html).toMatch(/<a href="#a">A<\/a>/);
    expect(html).toMatch(/<a href="#b">B<\/a>/);
  });
});

describe("TOC 嵌套结构", () => {
  it("h1 > h2 生成嵌套 ul", () => {
    const src = "[toc]\n\n# A\n## B\n";
    const html = md.render(src);
    // <li><a>A</a> <ul><li><a>B</a></li></ul> </li>
    expect(html).toMatch(/<li><a href="#a">A<\/a>\s*<ul>/);
    expect(html).toMatch(/<li><a href="#b">B<\/a><\/li>\s*<\/ul>\s*<\/li>/);
  });

  it("h1 > h2 > h3 三层嵌套", () => {
    const src = "[toc]\n\n# A\n## B\n### C\n";
    const html = md.render(src);
    expect(html).toMatch(/<li><a href="#a">A<\/a>\s*<ul>\s*<li><a href="#b">B<\/a>\s*<ul>\s*<li><a href="#c">C<\/a><\/li>\s*<\/ul>\s*<\/li>\s*<\/ul>\s*<\/li>/);
  });

  it("同级标题顺序排列", () => {
    const src = "[toc]\n\n# A\n# B\n# C\n";
    const html = md.render(src);
    expect(html).toMatch(/<li><a href="#a">A<\/a><\/li>\s*<li><a href="#b">B<\/a><\/li>\s*<li><a href="#c">C<\/a><\/li>/);
  });

  it("跳级 h1 -> h3 生成两层嵌套 ul", () => {
    const src = "[toc]\n\n# A\n### C\n";
    const html = md.render(src);
    // A 下两层 ul（h1 -> h3 跳过 h2）
    expect(html).toMatch(/<li><a href="#a">A<\/a>\s*<ul>\s*<ul>\s*<li><a href="#c">C<\/a><\/li>/);
  });
});

describe("TOC 边界情况", () => {
  it("无标题时输出空 nav", () => {
    const html = md.render("[toc]\n\n正文内容\n");
    expect(html).toMatch(/<nav class="toc"><\/nav>/);
  });

  it("多个 [toc] 共享同一份 headings", () => {
    const src = "[toc]\n\n# A\n\n[toc]\n";
    const html = md.render(src);
    // 两个 nav
    const navCount = (html.match(/<nav class="toc">/g) || []).length;
    expect(navCount).toBe(2);
    // 两个 nav 都包含 A
    const aLinks = (html.match(/<a href="#a">A<\/a>/g) || []).length;
    expect(aLinks).toBe(2);
  });

  it("标题文本在 a 标签中被 HTML 转义", () => {
    const src = "[toc]\n\n# A&B\n";
    const html = md.render(src);
    // slugify("A&B") = "ab"，文本经 escapeHtml 转义为 A&amp;B
    expect(html).toMatch(/<a href="#ab">A&amp;B<\/a>/);
  });

  it("端到端：多标题 + [toc] + 正文锚点链接协同工作", () => {
    const src = "[toc]\n\n# 标题一\n## 标题二\n[跳转](#标题一)\n";
    const html = md.render(src);
    // 1. heading 自动带 id
    expect(html).toContain('<h1 id="标题一">');
    expect(html).toContain('<h2 id="标题二">');
    // 2. TOC 链接（中文原文，未 URL 编码，与 id 一致）
    expect(html).toContain('<a href="#标题一">标题一</a>');
    expect(html).toContain('<a href="#标题二">标题二</a>');
    // 3. 正文锚点链接被 markdown-it URL 编码，浏览器会自动解码跳转到 id="标题一"
    //    标题一 的 UTF-8 百分号编码：%E6%A0%87%E9%A2%98%E4%B8%80
    expect(html).toContain('<a href="#%E6%A0%87%E9%A2%98%E4%B8%80">跳转</a>');
  });
});
