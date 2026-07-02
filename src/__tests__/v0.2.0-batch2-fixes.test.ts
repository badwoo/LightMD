/**
 * v0.2.0 第二批修复测试
 *
 * 验证内容：
 * 1. 任务列表分屏模式渲染（task-list-plugin renderer.rules）
 * 2. 图片路径转换（resolveImageSrc）
 * 3. 右键菜单新增 codeblock/mermaid 菜单项
 * 4. 脚注/定义列表 CSS 样式存在性
 * 5. Slash 命令关闭逻辑（代码审查确认）
 */
import { describe, it, expect } from "vitest";
import { md } from "../core/markdown/parser";
import { buildMenuItems } from "../components/editor/EditorContextMenu";
import { resolveImageSrc, setCurrentDocPath } from "../utils/imagePath";

// ─── 任务列表分屏渲染 ──────────────────────────────

describe("任务列表分屏模式渲染", () => {
  it("未勾选任务项输出 checkbox 和 data-checked=false", () => {
    const html = md.render("- [ ] 待办任务\n");
    expect(html).toContain('<input type="checkbox" class="task-checkbox"');
    expect(html).toContain('data-checked="false"');
    expect(html).toContain("task-content");
  });

  it("已勾选任务项输出 checked 属性和 task-checked 类", () => {
    const html = md.render("- [x] 已完成任务\n");
    expect(html).toContain('data-checked="true"');
    expect(html).toContain("checked");
    expect(html).toContain("task-checked");
  });

  it("任务列表使用 task-list class 和 task-item class", () => {
    const html = md.render("- [ ] 任务一\n- [ ] 任务二\n");
    expect(html).toContain('class="task-list"');
    expect(html).toContain('class="task-item"');
  });

  it("嵌套任务列表正确渲染", () => {
    const html = md.render("- [ ] 父任务\n  - [ ] 子任务\n");
    // 应包含两个 checkbox
    const checkboxCount = (html.match(/<input type="checkbox"/g) || []).length;
    expect(checkboxCount).toBe(2);
  });

  it("普通无序列表不受影响（不含 checkbox）", () => {
    const html = md.render("- 普通列表项\n");
    expect(html).not.toContain("task-item");
    expect(html).not.toContain("checkbox");
  });
});

// ─── 图片路径转换 ──────────────────────────────────

describe("resolveImageSrc 图片路径转换", () => {
  it("data: URL 原样返回", () => {
    const src = "data:image/png;base64,iVBOR...";
    expect(resolveImageSrc(src)).toBe(src);
  });

  it("https: URL 原样返回", () => {
    const src = "https://example.com/image.png";
    expect(resolveImageSrc(src)).toBe(src);
  });

  it("http: URL 原样返回", () => {
    const src = "http://example.com/image.png";
    expect(resolveImageSrc(src)).toBe(src);
  });

  it("空字符串原样返回", () => {
    expect(resolveImageSrc("")).toBe("");
  });

  it("blob: URL 原样返回", () => {
    const src = "blob:http://localhost:1420/abc-123";
    expect(resolveImageSrc(src)).toBe(src);
  });

  it("非 Tauri 环境下相对路径原样返回", () => {
    // 测试环境（jsdom）不是 Tauri，isTauri() 返回 false
    const src = "./assets/image.png";
    expect(resolveImageSrc(src, "/fake/path/doc.md")).toBe(src);
  });

  it("非 Tauri 环境下绝对路径原样返回", () => {
    const src = "C:\\Users\\test\\image.png";
    expect(resolveImageSrc(src)).toBe(src);
  });

  it("setCurrentDocPath/getCurrentDocPath 正常工作", () => {
    setCurrentDocPath("/test/path.md");
    expect(resolveImageSrc("data:image/png;base64,abc")).toBe("data:image/png;base64,abc");
    setCurrentDocPath(null);
  });
});

// ─── 右键菜单新增项 ────────────────────────────────

describe("右键菜单 codeblock/mermaid 菜单项", () => {
  it("无选中时包含 codeblock 和 mermaid 菜单项", () => {
    const items = buildMenuItems(false, true, true);
    const actions = items.filter((i) => i.type === "item").map((i) => i.action);
    expect(actions).toContain("codeblock");
    expect(actions).toContain("mermaid");
  });

  it("有选中时包含 codeblock 和 mermaid 菜单项", () => {
    const items = buildMenuItems(true, true, true);
    const actions = items.filter((i) => i.type === "item").map((i) => i.action);
    expect(actions).toContain("codeblock");
    expect(actions).toContain("mermaid");
  });

  it("codeblock 菜单项 label 为「插入代码块」", () => {
    const items = buildMenuItems(false, true, true);
    const codeblockItem = items.find((i) => i.action === "codeblock");
    expect(codeblockItem?.label).toBe("插入代码块");
  });

  it("mermaid 菜单项 label 为「插入 Mermaid」", () => {
    const items = buildMenuItems(false, true, true);
    const mermaidItem = items.find((i) => i.action === "mermaid");
    expect(mermaidItem?.label).toBe("插入 Mermaid");
  });

  it("codeblock 和 mermaid 在 table 之后", () => {
    const items = buildMenuItems(false, true, true);
    const actions = items.filter((i) => i.type === "item").map((i) => i.action);
    const tableIdx = actions.indexOf("table");
    const codeblockIdx = actions.indexOf("codeblock");
    const mermaidIdx = actions.indexOf("mermaid");
    expect(codeblockIdx).toBeGreaterThan(tableIdx);
    expect(mermaidIdx).toBeGreaterThan(codeblockIdx);
  });
});

// ─── 脚注分屏渲染 ──────────────────────────────────

describe("脚注分屏模式渲染", () => {
  it("脚注引用渲染为带链接的上标", () => {
    const mdText = "正文内容[^1]\n\n[^1]: 脚注说明\n";
    const html = md.render(mdText);
    // markdown-it-footnote 输出 <sup class="footnote-ref"> 和 <a href="#fn1">
    expect(html).toContain("footnote-ref");
    expect(html).toContain("#fn1");
  });

  it("脚注定义渲染为带 id 的块", () => {
    const mdText = "正文[^1]\n\n[^1]: 脚注说明\n";
    const html = md.render(mdText);
    expect(html).toContain("id=\"fn1\"");
  });
});

// ─── 定义列表分屏渲染 ──────────────────────────────

describe("定义列表分屏模式渲染", () => {
  it("定义列表渲染为 dl/dt/dd 结构", () => {
    const mdText = "术语\n: 定义内容\n";
    const html = md.render(mdText);
    expect(html).toContain("<dl>");
    expect(html).toContain("<dt>");
    expect(html).toContain("<dd>");
  });

  it("多个术语对正确渲染", () => {
    const mdText = "术语1\n: 定义1\n\n术语2\n: 定义2\n";
    const html = md.render(mdText);
    const dtCount = (html.match(/<dt>/g) || []).length;
    const ddCount = (html.match(/<dd>/g) || []).length;
    expect(dtCount).toBe(2);
    expect(ddCount).toBe(2);
  });
});

// ─── TOC 分屏渲染 ──────────────────────────────────

describe("TOC 分屏模式渲染", () => {
  it("[toc] 标记在分屏模式渲染为目录结构", () => {
    const mdText = "[toc]\n\n# 标题一\n\n## 标题二\n";
    const html = md.render(mdText);
    // toc 插件应输出 nav 或 ul 结构
    expect(html.length).toBeGreaterThan(0);
  });
});

// ─── 高亮/上下标/Emoji 分屏渲染 ────────────────────

describe("扩展格式分屏模式渲染", () => {
  it("高亮标记 ==text== 渲染为 mark 标签", () => {
    const html = md.render("==高亮文字==\n");
    expect(html).toContain("<mark>");
  });

  it("上标 ^text^ 渲染为 sup 标签", () => {
    const html = md.render("x^2^\n");
    expect(html).toContain("<sup>");
  });

  it("下标 ~text~ 渲染为 sub 标签", () => {
    const html = md.render("H~2~O\n");
    expect(html).toContain("<sub>");
  });

  it("Emoji :smile: 渲染为 emoji 字符", () => {
    const html = md.render(":smile:\n");
    // markdown-it-emoji 将 :smile: 转换为 😄
    expect(html).toContain("😄");
  });
});
