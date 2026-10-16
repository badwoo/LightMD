// @vitest-environment jsdom
/**
 * v0.13.1 需求13（按块定位对齐）：分屏"左 → 右"滚动的块级锚点映射。
 *
 * ## 用户报告
 * 「左屏编辑、右屏渲染因为篇幅问题会出现阅读位置偏差，例如左侧编辑图表，但右侧渲染
 *  要把屏幕往下拉一拉才能看到。所以这个滚动进度不能强绑定……可以考虑是否可以根据块
 *  来定位对齐。」
 *
 * ## 为什么百分比映射不够
 * 左右两侧的"块高"差异可以极大：3 行 mermaid 源码在右侧是几百像素的图。
 * 同一百分比对应的内容完全不同 → 右侧总是差一截。
 *
 * ## 本文件的层次
 * 1. **行号表**（`topLevelBlockStartLines`）——markdown-it token 的 `map[0]`。
 *    关键验证：它必须与**真实渲染出的顶层元素数量**一致（用 jsdom 真解析 HTML 计数），
 *    否则贴标签会整体错位。数量不符时 `shouldTagPreview` 必须拒绝。
 * 2. **算术与选择**（`estimateTopSourceLine` / `pickAnchorIndex` /
 *    `computeBlockAlignedScrollTop`）——纯函数，边界全覆盖。
 * 3. **接线契约**——分屏 effect 必须"先试块对齐、失败退回百分比"。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { renderMarkdownHtml, topLevelBlockStartLines } from "../core/renderPipeline";
import {
  computeBlockAlignedScrollTop,
  estimateTopSourceLine,
  pickAnchorIndex,
  shouldTagPreview,
} from "../utils/blockScrollAlign";

// ═════════════ ① 行号表 ═════════════

describe("需求13 · topLevelBlockStartLines：顶层块的源码起始行", () => {
  it("标题 + 段落 + 代码块 + 表格：行号与源码一致且严格升序", () => {
    const md = [
      "# 标题", //        0
      "", //               1
      "正文一段。", //      2
      "", //               3
      "```js", //          4
      "const a = 1;", //   5
      "```", //            6
      "", //               7
      "| A | B |", //      8
      "| --- | --- |", //  9
      "| 1 | 2 |", //     10
    ].join("\n");
    expect(topLevelBlockStartLines(md)).toEqual([0, 2, 4, 8]);
  });

  it("列表算**一个**顶层块（不把每个 li 都算进去）", () => {
    const md = ["- 一", "- 二", "- 三"].join("\n");
    expect(topLevelBlockStartLines(md)).toEqual([0]);
  });

  it("块引用 / 分隔线 / 缩进代码块各自成一块", () => {
    const md = ["> 引用", "", "---", "", "    indented code"].join("\n");
    expect(topLevelBlockStartLines(md)).toEqual([0, 2, 4]);
  });

  it("空串 / 空文档 → 空表", () => {
    expect(topLevelBlockStartLines("")).toEqual([]);
  });

  it("**与实际渲染的顶层元素数量一致**（jsdom 真解析 HTML 计数）", () => {
    const cases = [
      "# A\n\n段落一。\n\n## B\n\n- x\n- y\n\n```js\nlet a=1;\n```\n",
      "普通段落。\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n> 引用\n",
      "# 只有标题\n",
      "段落 A\n\n段落 B\n\n段落 C\n",
      "1. 一\n2. 二\n\n---\n\n![img](./a.png)\n",
    ];
    for (const md of cases) {
      const lines = topLevelBlockStartLines(md);
      const host = document.createElement("div");
      host.innerHTML = renderMarkdownHtml(md);
      // 只有数量一致时才允许贴标签，否则整体错位
      expect(lines.length, `块数应等于顶层元素数: ${JSON.stringify(md)}`).toBe(
        host.children.length,
      );
      expect(shouldTagPreview(lines.length, host.children.length)).toBe(true);
      // 升序且不越界
      for (let i = 1; i < lines.length; i++) expect(lines[i]).toBeGreaterThan(lines[i - 1]);
      const totalLines = md.split("\n").length;
      for (const l of lines) {
        expect(l).toBeGreaterThanOrEqual(0);
        expect(l).toBeLessThan(totalLines);
      }
    }
  });

  it("原始 HTML 被转义成段落（本管线 htmlBlockDisabled）→ 数量仍然相等", () => {
    // 实测：`htmlBlockDisabled: true` 下 `<div>` 会变成 `&lt;div&gt;` 的段落，
    // 不产生 html_block token，因此不存在"一个块多个元素"的错位风险。
    const md = "段落\n\n<div>a</div>\n<div>b</div>\n";
    const html = renderMarkdownHtml(md);
    expect(html).toContain("&lt;div&gt;");
    const host = document.createElement("div");
    host.innerHTML = html;
    expect(topLevelBlockStartLines(md).length).toBe(host.children.length);
  });

  it("数量自校验：不符或为空时必须拒绝贴标签（应对将来 html_block / 无 map token）", () => {
    expect(shouldTagPreview(0, 0)).toBe(false);
    expect(shouldTagPreview(3, 4)).toBe(false);
    expect(shouldTagPreview(4, 3)).toBe(false);
    expect(shouldTagPreview(3, 3)).toBe(true);
  });

  it("渲染 HTML 本身**不含** data-src-line（导出/预览输出逐字节不变）", () => {
    const md = "# A\n\n段落\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n";
    const html = renderMarkdownHtml(md);
    expect(html).not.toContain("data-src-line");
    // 与"不加行号表"的调用完全同源：同一输入两次调用结果一致
    expect(renderMarkdownHtml(md)).toBe(html);
  });
});

// ═════════════ ② 估算左屏顶部行号 ═════════════

describe("需求13 · estimateTopSourceLine：左屏视口顶部对应的源码行", () => {
  it("顶部 → 第 0 行；底部 → 最后一行", () => {
    const m = { scrollHeight: 2100, clientHeight: 100, totalSourceLines: 101 };
    expect(estimateTopSourceLine({ ...m, scrollTop: 0 })).toBe(0);
    expect(estimateTopSourceLine({ ...m, scrollTop: 2000 })).toBe(100);
  });

  it("中点 → 中位行", () => {
    const line = estimateTopSourceLine({
      scrollTop: 1000,
      scrollHeight: 2100,
      clientHeight: 100,
      totalSourceLines: 101,
    });
    expect(line).toBeCloseTo(50, 5);
  });

  it("内容不足一屏（无可滚动区间）→ 恒为第 0 行", () => {
    expect(
      estimateTopSourceLine({
        scrollTop: 40,
        scrollHeight: 300,
        clientHeight: 300,
        totalSourceLines: 20,
      }),
    ).toBe(0);
  });

  it("scrollTop 越界（回弹/亚像素）→ 钳到区间内", () => {
    const base = { scrollHeight: 2100, clientHeight: 100, totalSourceLines: 101 };
    expect(estimateTopSourceLine({ ...base, scrollTop: -50 })).toBe(0);
    expect(estimateTopSourceLine({ ...base, scrollTop: 99999 })).toBe(100);
  });

  it("单行 / 零行文档 → 0（不产生 NaN）", () => {
    for (const total of [0, 1]) {
      const v = estimateTopSourceLine({
        scrollTop: 500,
        scrollHeight: 1000,
        clientHeight: 100,
        totalSourceLines: total,
      });
      expect(v).toBe(0);
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});

// ═════════════ ③ 选锚点 ═════════════

describe("需求13 · pickAnchorIndex：包含目标行的顶层块", () => {
  const lines = [0, 5, 12, 20];

  it("目标行在某块内部 → 取该块", () => {
    expect(pickAnchorIndex(lines, 0)).toBe(0);
    expect(pickAnchorIndex(lines, 4)).toBe(0);
    expect(pickAnchorIndex(lines, 5)).toBe(1);
    expect(pickAnchorIndex(lines, 11)).toBe(1);
    expect(pickAnchorIndex(lines, 19)).toBe(2);
    expect(pickAnchorIndex(lines, 20)).toBe(3);
  });

  it("目标行在最后一个块之后 → 取最后一块（不越界）", () => {
    expect(pickAnchorIndex(lines, 999)).toBe(3);
  });

  it("目标行在第一个块之前（前导空行）→ 取第 0 块", () => {
    expect(pickAnchorIndex(lines, -1)).toBe(0);
  });

  it("空表 → -1（调用方必须退回百分比映射）", () => {
    expect(pickAnchorIndex([], 3)).toBe(-1);
  });

  it("浮点行号（滚动估算结果是浮点）也能正确落入区间", () => {
    expect(pickAnchorIndex(lines, 4.9)).toBe(0);
    expect(pickAnchorIndex(lines, 5.0)).toBe(1);
  });
});

// ═════════════ ④ 对齐滚动量 ═════════════

describe("需求13 · computeBlockAlignedScrollTop：把锚点块对齐到视口顶", () => {
  it("锚点在视口下方 → 增大 scrollTop（向下滚）", () => {
    const next = computeBlockAlignedScrollTop({
      previewScrollTop: 100,
      anchorTopInViewport: 300,
      viewportTop: 100,
      maxScrollTop: 5000,
    });
    expect(next).toBe(300); // 100 + (300-100)
  });

  it("锚点在视口上方 → 减小 scrollTop（向上滚）", () => {
    const next = computeBlockAlignedScrollTop({
      previewScrollTop: 400,
      anchorTopInViewport: 50,
      viewportTop: 150,
      maxScrollTop: 5000,
    });
    expect(next).toBe(300); // 400 + (50-150)
  });

  it("钳到 [0, maxScrollTop]（不越界）", () => {
    expect(
      computeBlockAlignedScrollTop({
        previewScrollTop: 10,
        anchorTopInViewport: 0,
        viewportTop: 99999,
        maxScrollTop: 500,
      }),
    ).toBe(0);
    expect(
      computeBlockAlignedScrollTop({
        previewScrollTop: 480,
        anchorTopInViewport: 99999,
        viewportTop: 0,
        maxScrollTop: 500,
      }),
    ).toBe(500);
  });

  it("测量值非有限（jsdom / 未布局）→ 原样返回，不写 NaN", () => {
    const next = computeBlockAlignedScrollTop({
      previewScrollTop: 123,
      anchorTopInViewport: Number.NaN,
      viewportTop: 0,
      maxScrollTop: 500,
    });
    expect(next).toBe(123);
  });

  it("无可滚动区间（maxScrollTop=0）→ 0", () => {
    expect(
      computeBlockAlignedScrollTop({
        previewScrollTop: 50,
        anchorTopInViewport: 200,
        viewportTop: 100,
        maxScrollTop: 0,
      }),
    ).toBe(0);
  });
});

// ═════════════ ⑤ 接线契约 ═════════════

describe("需求13 · 分屏接线：先试块对齐、失败退回百分比", () => {
  const src = readFileSync("src/components/editor/EditorContainer.tsx", "utf-8");

  it("左→右同步里先尝试块对齐（data-src-line 锚点）", () => {
    expect(src).toContain('querySelectorAll<HTMLElement>("[data-src-line]")');
    expect(src).toContain("computeBlockAlignedScrollTop({");
    expect(src).toContain("estimateTopSourceLine({");
    expect(src).toContain("pickAnchorIndex(lines, topLine)");
  });

  it("块对齐不可用时**必须**退回百分比映射（增强而非替代）", () => {
    // handled 标志 + 兜底分支同时存在
    expect(src).toContain("if (!handled) {");
    expect(src).toContain("preview.scrollTop = computeSyncScrollTop(");
  });

  it("贴标签走数量自校验，且异常被吞掉（不影响预览）", () => {
    expect(src).toContain("if (!shouldTagPreview(lines.length, children.length)) return false;");
    expect(src).toContain("tagPreviewSourceLines(doc.body, previewSourceMarkdown);");
  });

  it("标签只贴在 iframe DOM 上，渲染管线的 HTML 不含该属性", () => {
    const pipeline = readFileSync("src/core/renderPipeline.ts", "utf-8");
    // renderMarkdownHtml 里不得出现注入 data-src-line 的字符串拼接
    expect(pipeline).not.toContain('data-src-line\\"');
    expect(pipeline).not.toContain("'data-src-line'");
  });
});
