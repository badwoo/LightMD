/**
 * HTML 代码块高亮函数测试
 */
import { describe, it, expect } from "vitest";
import { highlightCodeBlocksInHtml, highlightCode, getPrismCss } from "../utils/highlight";

describe("highlightCode", () => {
  it("高亮 JavaScript 代码", () => {
    const code = "const x = 1;";
    const result = highlightCode(code, "javascript");
    // 应该包含 token span
    expect(result).toContain("token");
    expect(result).toContain("keyword");
  });

  it("未知语言返回转义文本", () => {
    const code = "const x = 1;";
    const result = highlightCode(code, "unknownlang");
    // 未知语言返回纯文本（转义后）
    expect(result).toBe("const x = 1;");
  });

  it("HTML 特殊字符被转义", () => {
    const code = "<div>hello</div>";
    const result = highlightCode(code, "plaintext");
    expect(result).toContain("&lt;div&gt;");
  });
});

describe("highlightCodeBlocksInHtml", () => {
  it("高亮 HTML 中的 JavaScript 代码块", () => {
    const html = '<pre><code class="language-javascript">const x = 1;</code></pre>';
    const result = highlightCodeBlocksInHtml(html);
    expect(result).toContain("token");
    expect(result).toContain("language-javascript");
  });

  it("高亮多个代码块", () => {
    const html =
      '<pre><code class="language-js">var a = 1;</code></pre>' +
      '<pre><code class="language-py">print("hello")</code></pre>';
    const result = highlightCodeBlocksInHtml(html);
    expect(result).toContain("token");
    // 两个代码块都应被高亮
    expect(result.match(/token/g)!.length).toBeGreaterThan(2);
  });

  it("跳过 mermaid 代码块", () => {
    const html = '<pre><code class="language-mermaid">graph TD; A-->B;</code></pre>';
    const result = highlightCodeBlocksInHtml(html);
    // mermaid 代码块不应被高亮，保持原样
    expect(result).toBe(html);
    expect(result).not.toContain("token");
  });

  it("处理 HTML 实体编码的代码", () => {
    const html = '<pre><code class="language-html">&lt;div&gt;hello&lt;/div&gt;</code></pre>';
    const result = highlightCodeBlocksInHtml(html);
    // 应该正确反转义并高亮
    expect(result).toContain("token");
  });

  it("无代码块的 HTML 不变", () => {
    const html = "<p>Hello World</p>";
    const result = highlightCodeBlocksInHtml(html);
    expect(result).toBe(html);
  });

  it("保留代码块外的内容", () => {
    const html = '<p>Before</p><pre><code class="language-js">var x = 1;</code></pre><p>After</p>';
    const result = highlightCodeBlocksInHtml(html);
    expect(result).toContain("<p>Before</p>");
    expect(result).toContain("<p>After</p>");
    expect(result).toContain("token");
  });
});

describe("getPrismCss", () => {
  it("生成亮色主题 CSS", () => {
    const css = getPrismCss(false);
    expect(css).toContain("token");
    expect(css).toContain("color:");
    // 亮色主题的颜色值
    expect(css).toContain("#383a42"); // text color
  });

  it("生成暗色主题 CSS", () => {
    const css = getPrismCss(true);
    expect(css).toContain("token");
    expect(css).toContain("color:");
    // 暗色主题的颜色值
    expect(css).toContain("#abb2bf"); // text color
  });

  it("包含代码块背景色", () => {
    const lightCss = getPrismCss(false);
    const darkCss = getPrismCss(true);
    expect(lightCss).toContain("#f4f4f4"); // 亮色代码块背景
    expect(darkCss).toContain("#282c34"); // 暗色代码块背景
  });

  it("包含字体设置", () => {
    const css = getPrismCss(false);
    expect(css).toContain("Cascadia Code");
    expect(css).toContain("Consolas");
  });
});
