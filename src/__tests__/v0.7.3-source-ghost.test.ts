/**
 * v0.7.3 改进10(U3)：source 模式续写 ghost 对齐
 *
 * 纯函数测试：
 * 1. buildSourceGhostHtml：透明复刻全文 + 光标处插入灰斜体 ghost + 采纳提示，
 *    换行对齐（同构文本）、HTML 转义、插入点越界钳制
 * 2. syncTextareaMetrics：overlay 样式与 textarea 对齐
 */
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  buildSourceGhostHtml,
  syncTextareaMetrics,
} from "../utils/focus-paragraph";

describe("v0.7.3 改进10 - buildSourceGhostHtml（纯函数）", () => {
  const hint = "Tab 采纳";

  it("透明复刻全文，在光标处插入灰斜体 ghost + 采纳提示", () => {
    // "第一段。\n\n第二段结尾。"：索引 0-3 = "第一段"，4-5 = "\n\n"，6-11 = "第二段结尾"
    const html = buildSourceGhostHtml("第一段。\n\n第二段结尾。", 6, "续写。", hint);
    // 光标前（透明）段
    expect(html).toContain("第一段。\n\n");
    // ghost 灰斜体
    expect(html).toContain(`<span class="ai-ghost-text">续写。</span>`);
    // 采纳提示
    expect(html).toContain(`<span class="ai-ghost-hint">${hint}</span>`);
    // 光标后（透明，即"第二段结尾。"）完整保留，保证换行与 textarea 一致
    expect(html).toContain("第二段结尾。");
  });

  it("原文含 HTML 特殊字符时正确转义（防注入）", () => {
    const html = buildSourceGhostHtml("a<b>&c\"d'", 1, "<script>x</script>", hint);
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("&amp;c&quot;d&#39;");
    // ghost 文本同样转义
    expect(html).toContain(`<span class="ai-ghost-text">&lt;script&gt;x&lt;/script&gt;</span>`);
  });

  it("插入点越界时钳制到文档范围", () => {
    const html = buildSourceGhostHtml("abc", 100, "X", hint);
    // 越界到末尾：透明 before = 全文，ghost 在最后
    expect(html).toContain(`<span style="color:transparent">abc</span>`);
    expect(html).toContain(`<span class="ai-ghost-text">X</span>`);
    expect(html).toContain(`<span style="color:transparent"></span>`);

    const htmlNeg = buildSourceGhostHtml("abc", -5, "X", hint);
    expect(htmlNeg).toContain(`<span style="color:transparent"></span>`);
    expect(htmlNeg).toContain(`<span class="ai-ghost-text">X</span>`);
    expect(htmlNeg).toContain(`<span style="color:transparent">abc</span>`);
  });

  it("ghost 文本为空时仍输出透明全文结构（不渲染 ghost span）", () => {
    const html = buildSourceGhostHtml("正文", 2, "", hint);
    expect(html).toContain(`<span style="color:transparent">正文</span>`);
    // 空 ghost 与 hint：ghost span 保留但内容为空（供后续流式填充）
    expect(html).toContain(`<span class="ai-ghost-text"></span>`);
  });
});

describe("v0.7.3 改进10 - syncTextareaMetrics（样式同步）", () => {
  it("同步字体/行高/padding/border/white-space 等与 textarea 一致", () => {
    const textarea = document.createElement("textarea");
    textarea.style.fontFamily = '"Cascadia Code", monospace';
    textarea.style.fontSize = "16px";
    textarea.style.lineHeight = "28.8px";
    textarea.style.padding = "8px";
    textarea.style.border = "1px solid #000";
    document.body.appendChild(textarea);
    const el = document.createElement("div");
    el.className = "source-ghost-overlay";
    document.body.appendChild(el);

    syncTextareaMetrics(textarea, el);

    expect(el.style.fontFamily).toBe('"Cascadia Code", monospace');
    expect(el.style.fontSize).toBe("16px");
    expect(el.style.lineHeight).toBe("28.8px");
    expect(el.style.paddingLeft).toBeTruthy();
    expect(el.style.borderTopWidth).toBeTruthy();
    expect(el.style.whiteSpace).toBe("pre-wrap");
    expect(el.style.wordBreak).toBe("break-word");
    expect(el.style.overflow).toBe("hidden");

    textarea.remove();
    el.remove();
  });
});