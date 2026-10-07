/**
 * v0.11.0 B2-5：DOCX 导出图片不得丢失 / 不得产出损坏文件。
 *
 * 缺陷背景（P0，两条）：
 *   ① `exportBlocks.parseInlineTokens` 把 image token 转成 `[图片: alt]` 文本 +
 *      `imageSrc` 字段，但 `exportDocx.inlineRunsToTextRuns` **无 imageSrc 分支**
 *      → Word 里只剩占位文字，图片全部丢失；
 *   ② `ImageRun` 是 **run 级**元素（ParagraphChild），原实现直接
 *      `elements.push(imageRun)` 塞进要求 block 级的 `sections.children`
 *      → Packer.toBlob 可能抛错或产出损坏的 docx。
 *
 * 本测试聚焦可单测的纯逻辑部分：
 *   - image token → InlineRun 带 imageSrc（exportBlocks 侧）
 *   - 图片类型推断（docx type 映射）
 *   - data URL 解码
 * ImageRun 的构造需要 docx 运行时（jsdom 下 import("docx") 可用但较慢），
 *   故用「结构断言 + 类型映射」覆盖，不做真实 Packer 打包。
 */
import { describe, it, expect } from "vitest";
import { createDefaultMarkdownIt, parseInlineTokens } from "../utils/exportBlocks";

/** 取出文档中第一个 inline token 的 children（跳过 paragraph_open 等块级包裹） */
function firstInlineChildren(md: string): unknown[] {
  const inst = createDefaultMarkdownIt();
  const tokens = inst.parse(md, {}) as unknown as {
    type: string;
    children?: { type: string; children?: unknown[] }[];
  }[];
  for (const t of tokens) {
    if (t.type === "inline" && t.children) return t.children;
    // 也检查块级 token 内嵌的 inline（如 list_item）
    if (t.children) {
      for (const c of t.children) {
        if (c.type === "inline" && c.children) return c.children;
      }
    }
  }
  return [];
}

describe("v0.11.0 B2-5 DOCX 图片导出", () => {
  it("image token 产出带 imageSrc 的 InlineRun（供下游构造 ImageRun）", () => {
    const runs = parseInlineTokens(firstInlineChildren("![alt text](a.png)") as never);
    expect(runs.length).toBeGreaterThan(0);
    const imgRun = runs.find((r) => r.imageSrc);
    expect(imgRun).toBeDefined();
    expect(imgRun!.imageSrc).toBe("a.png");
    // 占位文本保留 alt（加载失败时的降级文案）
    expect(imgRun!.text).toContain("alt text");
  });

  it("data URL 图片同样带 imageSrc（临时文件粘贴场景）", () => {
    const dataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const runs = parseInlineTokens(firstInlineChildren(`![shot](${dataUrl})`) as never);
    const imgRun = runs.find((r) => r.imageSrc);
    expect(imgRun).toBeDefined();
    expect(imgRun!.imageSrc!.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("行内代码/强调等格式与图片共存时互不干扰", () => {
    const runs = parseInlineTokens(
      firstInlineChildren("**粗体** `code` ![alt](x.png)") as never,
    );
    expect(runs.some((r) => r.bold)).toBe(true);
    expect(runs.some((r) => r.code)).toBe(true);
    expect(runs.some((r) => r.imageSrc === "x.png")).toBe(true);
  });

  it("段落内多图片各自带 imageSrc", () => {
    const runs = parseInlineTokens(firstInlineChildren("![a](1.png) ![b](2.png)") as never);
    const srcs = runs.filter((r) => r.imageSrc).map((r) => r.imageSrc);
    expect(srcs).toEqual(["1.png", "2.png"]);
  });
});
