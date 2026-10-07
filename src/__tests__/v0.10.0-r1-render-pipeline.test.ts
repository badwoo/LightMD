/**
 * R1（v0.10.0）：统一渲染管线
 *
 * 1. renderMarkdownHtml 输出：公式占位、mermaid 包装、Prism 高亮齐全
 * 2. typographer 恒 false：导出/分屏不再把直引号改写为弯引号（R1 消除漂移）
 * 3. validateLink 白名单全管线：javascript: 链接在渲染 HTML 与 DOCX/LaTeX 解析层均被拦截
 * 4. data:image 放行：base64 图片导出不受白名单影响（v0.9.5 语义回归）
 * 5. breaks 设置贯通渲染管线（GFM/CommonMark）
 * 6. 结构断言：三处调用方均引用 renderPipeline（新增语法只改一处配置）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderMarkdownHtml, getDocxLatexMarkdownIt } from "../core/renderPipeline";
import { parseMarkdownToBlocks } from "../utils/exportBlocks";
import { useSettingsStore } from "../stores/useSettingsStore";

beforeEach(() => {
  // 默认 GFM 段内换行
  useSettingsStore.setState({ paragraphBreaks: "gfm" as never });
});

afterEach(() => {
  useSettingsStore.setState({ paragraphBreaks: "gfm" as never });
});

describe("R1: renderMarkdownHtml 输出结构", () => {
  it("数学公式输出 data-math 占位、mermaid 包装为 pre.mermaid、代码块带 Prism 高亮", () => {
    const md = [
      "# 标题",
      "",
      "行内 $E=mc^2$ 公式",
      "",
      "$$",
      "a^2 + b^2 = c^2",
      "$$",
      "",
      "```mermaid",
      "graph TD; A-->B;",
      "```",
      "",
      "```js",
      "const x = 1;",
      "```",
      "",
    ].join("\n");
    const html = renderMarkdownHtml(md);
    expect(html).toContain('data-math="inline"');
    expect(html).toContain('data-math="block"');
    expect(html).toContain('<pre class="mermaid">');
    expect(html).not.toContain("language-mermaid");
    // Prism 高亮（js 语言类）
    expect(html).toMatch(/<pre[^>]*><code[^>]*language-js/);
  });

  it("typographer 恒 false：直引号不被改写为弯引号（与编辑器一致）", () => {
    const html = renderMarkdownHtml('他说 "hello" 和 \'world\'');
    // markdown-it 输出会把 " 转义为 &quot;——关键是不得出现弯引号实体
    expect(html).toContain("&quot;hello&quot;");
    expect(html).not.toContain("\u201C");
    expect(html).not.toContain("\u201D");
    expect(html).not.toContain("\u2018");
    expect(html).not.toContain("\u2019");
  });
});

describe("R1: validateLink 白名单全管线", () => {
  it("javascript: 链接在渲染 HTML 中被拦截（不输出 <a href=javascript:）", () => {
    const html = renderMarkdownHtml("[点击](javascript:alert(1))");
    expect(html).not.toMatch(/href="javascript:/i);
    // 链接退化为字面文本，内容不丢失
    expect(html).toContain("点击");
  });

  it("javascript: 图片在渲染 HTML 中被拦截", () => {
    const html = renderMarkdownHtml("![x](javascript:alert(1))");
    expect(html).not.toMatch(/src="javascript:/i);
  });

  it("DOCX/LaTeX 管线（exportBlocks）：javascript: 链接不产生 link run", () => {
    const blocks = parseMarkdownToBlocks("[点击](javascript:alert(1))");
    const para = blocks[0];
    expect(para?.kind).toBe("paragraph");
    const runs = para && para.kind === "paragraph" ? para.runs : [];
    // 白名单拒绝后 [点击](url) 保留为字面文本（不丢内容），且无 href 属性
    const hasHref = runs.some((r) => "href" in r && r.href);
    expect(hasHref).toBe(false);
    expect(runs.map((r) => r.text).join("")).toContain("点击");
  });

  it("data:image 放行：base64 图片正常渲染（导出保真回归）", () => {
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    const html = renderMarkdownHtml(`![图](${dataUrl})`);
    expect(html).toContain("<img");
    expect(html).toContain("data:image/png;base64");
  });

  it("正常 http 链接不受白名单影响", () => {
    const html = renderMarkdownHtml("[官网](https://example.com)");
    expect(html).toMatch(/href="https:\/\/example\.com"/);
  });
});

describe("R1: breaks 设置贯通渲染管线", () => {
  it("GFM 模式单换行渲染为 <br>", () => {
    const html = renderMarkdownHtml("第一行\n第二行");
    expect(html).toContain("<br");
  });

  it("CommonMark 模式单换行渲染为空格（设置贯通分屏/导出）", () => {
    useSettingsStore.setState({ paragraphBreaks: "commonmark" as never });
    const html = renderMarkdownHtml("第一行\n第二行");
    expect(html).not.toContain("<br");
    expect(html).toContain("第一行");
  });
});

describe("R1: 结构断言（调用方统一引用管线）", () => {
  const root = resolve(__dirname, "../..");

  it("ExportDialog / exportBlocks / EditorContainer 均引用 renderPipeline，不再独立实例化 markdown-it", () => {
    const exportDialog = readFileSync(resolve(root, "src/components/dialogs/ExportDialog.tsx"), "utf-8");
    const exportBlocks = readFileSync(resolve(root, "src/utils/exportBlocks.ts"), "utf-8");
    const editorContainer = readFileSync(resolve(root, "src/components/editor/EditorContainer.tsx"), "utf-8");

    expect(exportDialog).toContain("renderPipeline");
    expect(exportBlocks).toContain("renderPipeline");
    expect(editorContainer).toContain("renderPipeline");

    // 三处均不再出现 typographer: true / validateLink: false 的独立实例化配置
    expect(exportDialog).not.toContain("typographer: true");
    expect(exportBlocks).not.toContain("validateLink: false");

    // DOCX/LaTeX 仍通过 getDocxLatexMarkdownIt 获得实例
    expect(exportBlocks).toContain("getDocxLatexMarkdownIt");
  });

  it("getDocxLatexMarkdownIt 配置：typographer false + validateLink 白名单开启", () => {
    const md = getDocxLatexMarkdownIt();
    expect(md.options.typographer).toBe(false);
    const html = md.render("[x](javascript:alert(1))");
    expect(html).not.toMatch(/href="javascript:/i);
  });
});
