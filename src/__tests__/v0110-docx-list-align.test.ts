/**
 * v0.11.0 B5-2 / B5-4 / B5-6：DOCX 与 HTML 导出补齐。
 *
 * 缺陷背景：
 * - B5-2（P1）有序列表起始序号丢失：exportBlocks 已解析 markdown-it 的 start
 *   写入 block.start，但 exportDocx 统一用 `reference: "default-numbering"`
 *   → `5. x` 导出到 Word 后**从 1 开始**，原文编号被改写。
 * - B5-4（P1）嵌套列表仅 2 层：只展开一层 item.children，第 3 层起被扁平化。
 * - B5-6（P1）导出 HTML 图片未内联：PDF 路径调了 convertImagesToDataUrlInHtml，
 *   HTML 路径没调 → 导出的单文件被移动后**相对/本地路径图片全裂**。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { convertBlocksToDocxElements } from "../utils/exportDocx";
import { createDefaultMarkdownIt, parseBlockTokensDetailed } from "../utils/exportBlocks";
import { Paragraph, TextRun } from "docx";

const rawDocx = readFileSync("src/utils/exportDocx.ts", "utf-8");
const rawDialog = readFileSync("src/components/dialogs/ExportDialog.tsx", "utf-8");

/** 剔除注释，只留代码 */
function stripComments(raw: string): string {
  let out = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  out = out.split("\n").map((l) => {
    const i = l.indexOf("//");
    return i >= 0 ? l.slice(0, i) : l;
  }).join("\n");
  return out;
}

const docxCode = stripComments(rawDocx);
const dialogCode = stripComments(rawDialog);

function parseBlocks(md: string) {
  const inst = createDefaultMarkdownIt();
  const tokens = inst.parse(md, {});
  return parseBlockTokensDetailed(tokens, 0, tokens.length).blocks;
}

describe("v0.11.0 B5-2 DOCX 有序列表起始序号", () => {
  it("exportBlocks 已解析 start（前提）", () => {
    const blocks = parseBlocks("5. five\n6. six\n");
    const ol = blocks.find((b) => b.kind === "orderedList") as { start: number } | undefined;
    expect(ol).toBeDefined();
    expect(ol!.start).toBe(5);
  });

  it("按 start 生成不同 numbering reference", () => {
    expect(docxCode).toContain("function orderedListNumberingRef");
    expect(docxCode).toMatch(/ol-start-\$\{s\}/);
  });

  it("numbering 配置含 start 字段", () => {
    expect(docxCode).toMatch(/levels:\s*\[[\s\S]{0,400}?start,/);
  });

  it("收集文档中所有起始序号并逐个生成配置", () => {
    expect(docxCode).toContain("collectOrderedListStarts");
    expect(docxCode).toMatch(/for \(const st of starts\)[\s\S]{0,200}?buildNumberingConfigFor\(st\)/);
  });

  it("无序列表有独立 numbering 定义（递归时按层级引用）", () => {
    expect(docxCode).toContain('reference: "default-bullet"');
  });
});

describe("v0.11.0 B5-4 DOCX 嵌套列表递归", () => {
  it("改用递归 appendListItems（不再只展开一层）", () => {
    expect(docxCode).toContain("function appendListItems");
    expect(docxCode).toContain("await appendListItems(item.children");
  });

  it("bulletList 与 orderedList 均走递归", () => {
    expect(docxCode).toMatch(/case "bulletList"[\s\S]{0,200}?appendListItems/);
    expect(docxCode).toMatch(/case "orderedList"[\s\S]{0,300}?appendListItems/);
  });

  it("三层嵌套全部产出元素（第 3 层不再被丢弃）", async () => {
    const blocks = parseBlocks("- a\n  - b\n    - c\n");
    const els = (await convertBlocksToDocxElements(blocks)) as Paragraph[];
    // 三个层级 → 三个 Paragraph（修复前第 3 层被扁平化/丢弃，只有 2 个）
    expect(els.length).toBe(3);
    // 注：不校验具体文本内容 —— docx 的 TextRun 把文本放在内部缓冲
    // （非直接可读字段），按字段遍历取不到。此处断言**元素数量**即可覆盖
    // 「第 3 层不再被丢弃」这一核心回归点。
    expect(els.filter((e) => e instanceof Paragraph).length).toBe(3);
  });

  it("超过 3 层的嵌套被钳到最深层级（不抛错）", async () => {
    const deep = "- a\n  - b\n    - c\n      - d\n        - e\n";
    const blocks = parseBlocks(deep);
    await expect(convertBlocksToDocxElements(blocks)).resolves.toBeDefined();
  });
});

describe("v0.11.0 B5-6 导出 HTML 图片内联", () => {
  it("HTML 导出路径也调用 convertImagesToDataUrlInHtml", () => {
    // PDF 路径原本就有；现 HTML 路径也必须有
    const calls = dialogCode.match(/convertImagesToDataUrlInHtml\(/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("图片转换在 body 渲染之后、mermaid/math 检测之前", () => {
    // 顺序很重要：若在检测之后转换，检测的是未转换的 body
    const iRender = dialogCode.indexOf("renderMarkdownToHTML");
    const iConvert = dialogCode.indexOf("convertImagesToDataUrlInHtml(bodyRaw");
    const iDetect = dialogCode.indexOf('hasMermaid = body.includes');
    expect(iConvert).toBeGreaterThan(iRender);
    expect(iDetect).toBeGreaterThan(iConvert);
  });

  it("HTML 与 PDF 两条路径都做图片内联", () => {
    // PDF 路径原有：bodyWithImages
    expect(dialogCode).toContain("bodyWithImages");
    // HTML 路径新增：body 由 bodyRaw 转换而来
    expect(dialogCode).toContain("const body = await convertImagesToDataUrlInHtml(bodyRaw, filePath)");
  });
});
