/**
 * v0.11.0 B1-3：图片 Typora 尺寸语法 `![alt|300](src)` 在渲染管线全链路生效。
 *
 * 缺陷背景（P0）：
 *   `parser.ts` 的 PM 解析层支持 `![alt|300](src)` 语法（v0.9.3 E11a，解析出
 *   alt="alt" + width=300），但**渲染管线**（分屏预览 / HTML / PDF / PNG 导出）
 *   走的是 markdown-it，markdown-it 原生不认识 `|W` 后缀 →
 *   实测 `renderMarkdownHtml("![alt|300](a.png)")` 输出
 *   `<img src="a.png" alt="alt|300" />`：**宽度丢失，且 alt 被污染成 `alt|300`**。
 *
 * 修复口径：在渲染管线实例上加一个 core rule 后处理 image token，
 * 把 alt 尾部的 `|数字` 拆出来改写为 width 属性。**不污染 alt**。
 *
 * 作用域说明：
 *   - 本插件只挂在 html:true 的渲染实例（分屏预览 + HTML/PDF/PNG 导出）；
 *   - DOCX/LaTeX 走 exportBlocks 的 Block[] 中间结构，其图片处理见 B5（另议）。
 */
import { describe, it, expect } from "vitest";
import { renderMarkdownHtml } from "../core/renderPipeline";

describe("v0.11.0 B1-3 图片 |W 尺寸语法在渲染管线生效", () => {
  it("带 |W 后缀的 alt 被拆分，width 生效且 alt 不被污染", () => {
    const html = renderMarkdownHtml("![alt|300](a.png)");
    // alt 必须是纯净的 "alt"，不含 |300
    expect(html).toContain('alt="alt"');
    expect(html).not.toContain('alt="alt|300"');
    // 宽度以 width 属性表达
    expect(html).toMatch(/width="?300"?/);
  });

  it("无 |W 后缀的图片输出保持原样（无回归）", () => {
    const html = renderMarkdownHtml("![plain](a.png)");
    expect(html).toContain('alt="plain"');
    expect(html).toContain('src="a.png"');
    expect(html).not.toMatch(/width=/);
  });

  it("alt 本身含竖线但非尺寸后缀时不做拆分（避免误伤）", () => {
    // "a|b" 不以 |数字 结尾 → 不拆
    const html = renderMarkdownHtml("![a|b](a.png)");
    expect(html).toContain('alt="a|b"');
    expect(html).not.toMatch(/width=/);
  });

  it("多段文字 + 尺寸后缀正确拆分", () => {
    const html = renderMarkdownHtml("![图 1|640](pic/x.png)");
    expect(html).toContain('alt="图 1"');
    expect(html).toMatch(/width="?640"?/);
  });

  it("标题与尺寸后缀共存时只影响 alt", () => {
    const html = renderMarkdownHtml('![cap|200](a.png "The Title")');
    expect(html).toContain('alt="cap"');
    expect(html).toMatch(/width="?200"?/);
    expect(html).toContain('title="The Title"');
  });
});
