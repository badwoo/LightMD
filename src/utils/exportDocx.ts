/**
 * G12 导出 Word（.docx）工具
 *
 * 设计原则：
 * - 纯函数优先：将 markdown → 中间结构 Block[] → docx 元素，两个阶段都可单测
 * - 不引入 pandoc：纯前端 docx 库实现
 * - 动态 import docx 库（约 200KB），避免首屏体积
 * - markdown 解析的中间结构（Block[] / InlineRun[]）复用 exportBlocks.ts，
 *   docx / latex 等导出器共用同一套结构
 *
 * 支持的 markdown 元素：
 * - heading h1-h6 → HeadingLevel.HEADING_1 ~ HEADING_6
 * - paragraph → Paragraph + TextRun
 * - bullet_list / ordered_list → Paragraph with bullet/number
 * - code_block (fence) → Paragraph with monospace font + shading
 * - table → Table with header row + body rows
 * - blockquote → Paragraph with left indent
 * - hr → Paragraph with bottom border
 * - 行内格式：bold/italic/strike/code/link
 *
 * R2（v0.10.0）公式/图表保真：
 * - mathBlock → KaTeX 渲染 → html-to-image 截为 PNG → ImageRun（失败降级 LaTeX 源码文本）
 * - fence language=mermaid → mermaid.render SVG → 截为 PNG → ImageRun（失败降级代码块）
 * - 渲染依赖主文档的 KaTeX CSS（index.html /vendor/katex）与 mermaid 包（主 bundle 已含）
 */

import { notifyError, notifySuccess } from "../services/notificationService";
import { t } from "../i18n";
// 复用共用中间结构与解析函数（确保 docx / latex 解析一致）
export {
  parseMarkdownToBlocks,
  parseInlineTokens,
  parseBlockTokens,
  createDefaultMarkdownIt,
} from "./exportBlocks";
export type { Block, InlineRun, ListItem, Token } from "./exportBlocks";

/** 从文件路径推导默认保存目录（用于 Tauri save 对话框的 defaultPath） */
function getDefaultDir(filePath: string | null | undefined): string | undefined {
  if (!filePath) return undefined;
  const idx = filePath.replace(/\\/g, "/").lastIndexOf("/");
  return idx > 0 ? filePath.substring(0, idx) : undefined;
}

// ─── Block[] → docx 元素转换 ──────────────────────

import type { Block, InlineRun } from "./exportBlocks";
// R2：公式/图表渲染与进度类型（mermaid 走统一替换器，KaTeX 本文件内直接渲染）
import katex from "katex";
import { replaceMermaidBlocksInDom, type ExportRenderProgress } from "./exportMathRender";

/** R2 进度回调类型再导出（ExportDialog/调用方使用） */
export type { ExportRenderProgress };

// ─── R2：公式/图表 → PNG ImageRun ──────────────────────

/** dataURL → Uint8Array（docx ImageRun 需要） */
function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.substring(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * 将元素截为 PNG dataURL（html-to-image，与 exportElementAsPng 同款能力）。
 * 元素挂载到视口内隐藏容器（visibility:hidden → 截图前转 visible），
 * 依赖主文档样式表（KaTeX 字体等由 html-to-image 自动内联）。
 *
 * @returns dataURL 与像素尺寸；失败返回 null（调用方降级）
 */
async function renderElementToPng(el: HTMLElement): Promise<{ dataUrl: string; width: number; height: number } | null> {
  const { toPng } = await import("html-to-image");
  const wrapper = document.createElement("div");
  wrapper.style.position = "fixed";
  wrapper.style.left = "0";
  wrapper.style.top = "0";
  wrapper.style.zIndex = "-1";
  wrapper.style.background = "#ffffff";
  wrapper.style.visibility = "hidden";
  wrapper.appendChild(el);
  document.body.appendChild(wrapper);
  try {
    wrapper.style.visibility = "visible";
    // 等一帧确保布局与字体应用完成
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    const rect = el.getBoundingClientRect();
    const width = Math.ceil(rect.width);
    const height = Math.ceil(rect.height);
    if (width <= 0 || height <= 0) return null;
    const dataUrl = await toPng(el, { width, height, pixelRatio: 2, backgroundColor: "#ffffff" });
    return { dataUrl, width, height };
  } catch (err) {
    console.warn("[导出Word] 公式/图表截图失败，降级为文本:", err);
    return null;
  } finally {
    wrapper.remove();
  }
}

/** 数学公式 → PNG ImageRun（KaTeX 渲染；失败返回 null 降级为 LaTeX 文本） */
async function renderLatexToImageRun(latex: string): Promise<unknown | null> {
  try {
    const { ImageRun } = await import("docx");
    const el = document.createElement("div");
    el.style.color = "#1a1a1a";
    el.style.fontSize = "16px";
    // 限制宽度避免超宽公式撑爆页面（DOCX 正文区约 6.5in ≈ 624px）
    el.style.maxWidth = "620px";
    el.innerHTML = katex.renderToString(latex, { throwOnError: false, displayMode: true });
    const shot = await renderElementToPng(el);
    if (!shot) return null;
    return new ImageRun({
      type: "png",
      data: dataUrlToBytes(shot.dataUrl),
      transformation: { width: shot.width / 2, height: shot.height / 2 }, // pixelRatio:2 → 缩回逻辑像素
    });
  } catch (err) {
    console.warn("[导出Word] KaTeX 渲染失败，降级为 LaTeX 文本:", err);
    return null;
  }
}

/** mermaid 代码 → PNG ImageRun（统一替换器渲染 SVG；失败返回 null 降级为代码块） */
async function renderMermaidToImageRun(code: string, theme?: string): Promise<unknown | null> {
  try {
    const { ImageRun } = await import("docx");
    const holder = document.createElement("div");
    holder.style.color = "#1a1a1a";
    holder.style.fontSize = "16px";
    const pre = document.createElement("pre");
    pre.className = "mermaid";
    pre.textContent = code;
    holder.appendChild(pre);
    const replaced = await replaceMermaidBlocksInDom(holder, { theme });
    if (replaced === 0) return null;
    const svg = holder.querySelector("svg");
    if (!svg) return null;
    const shot = await renderElementToPng(svg as unknown as HTMLElement);
    if (!shot) return null;
    return new ImageRun({
      type: "png",
      data: dataUrlToBytes(shot.dataUrl),
      transformation: { width: shot.width / 2, height: shot.height / 2 },
    });
  } catch (err) {
    console.warn("[导出Word] mermaid 渲染失败，降级为代码块:", err);
    return null;
  }
}

/**
 * 将 InlineRun[] 转换为 docx TextRun[] 数组
 *
 * 返回 any[] 是为了绕过 docx 库 ParagraphChild 类型联合的复杂签名，
 * 实际元素都是 TextRun 实例。
 */
async function inlineRunsToTextRuns(runs: InlineRun[]): Promise<any[]> {
  const { TextRun } = await import("docx");
  const result: any[] = [];
  for (const r of runs) {
    const props: Record<string, unknown> = {};
    if (r.bold) props.bold = true;
    if (r.italic) props.italics = true;
    if (r.strike) props.strike = true;
    if (r.code) {
      props.font = "Consolas";
      props.shading = { type: "clear", fill: "f4f4f4", color: "auto" };
    }
    // 简化：链接转为带颜色的文本（docx 超链接需要 ExternalHyperlink，实现复杂）
    if (r.href) props.color = "0078d4";
    // 处理文本中的换行符（hardbreak）：按行拆分，每行一个 TextRun，非首行加 break:1
    if (r.text.includes("\n")) {
      const lines = r.text.split("\n");
      lines.forEach((line, idx) => {
        result.push(
          new TextRun({
            ...props,
            text: line,
            break: idx > 0 ? 1 : undefined,
          }),
        );
      });
    } else {
      result.push(new TextRun({ ...props, text: r.text }));
    }
  }
  return result;
}

/**
 * 将 Block[] 转换为 docx 文档元素数组（Paragraph/Table 等）
 *
 * @param blocks Block[] 中间结构
 * @param indentLevel 缩进级别（用于 blockquote 嵌套）
 * @param onProgress R2：公式/图表渲染进度回调（done/total，失败也计数）
 * @returns docx 元素数组（用于 Document 的 sections.children）
 */
export async function convertBlocksToDocxElements(
  blocks: Block[],
  indentLevel: number = 0,
  onProgress?: ExportRenderProgress,
): Promise<unknown[]> {
  const docx = await import("docx");
  const {
    Paragraph,
    TextRun,
    HeadingLevel,
    BorderStyle,
    Table,
    TableRow,
    TableCell,
    WidthType,
    ShadingType,
  } = docx;

  // R2：进度总数 = 公式块 + mermaid 代码块数
  const renderTotal = blocks.filter(
    (b) =>
      b.kind === "mathBlock" ||
      (b.kind === "codeBlock" && b.language === "mermaid"),
  ).length;
  let renderDone = 0;
  const reportProgress = () => {
    renderDone++;
    onProgress?.(renderDone, renderTotal);
  };

  const elements: unknown[] = [];

  for (const block of blocks) {
    switch (block.kind) {
      case "heading": {
        const headingMap: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
          1: HeadingLevel.HEADING_1,
          2: HeadingLevel.HEADING_2,
          3: HeadingLevel.HEADING_3,
          4: HeadingLevel.HEADING_4,
          5: HeadingLevel.HEADING_5,
          6: HeadingLevel.HEADING_6,
        };
        const headingLevel = headingMap[block.level] || HeadingLevel.HEADING_1;
        const textRuns = await inlineRunsToTextRuns(block.runs);
        elements.push(
          new Paragraph({
            heading: headingLevel,
            children: textRuns,
          }),
        );
        break;
      }
      case "paragraph": {
        const textRuns = await inlineRunsToTextRuns(block.runs);
        elements.push(
          new Paragraph({
            children: textRuns,
            indent: indentLevel > 0 ? { left: indentLevel * 720 } : undefined,
          }),
        );
        break;
      }
      case "bulletList": {
        for (const item of block.items) {
          const textRuns = await inlineRunsToTextRuns(item.runs);
          elements.push(
            new Paragraph({
              bullet: { level: 0 },
              children: textRuns,
            }),
          );
          // 嵌套子项
          if (item.children) {
            for (const child of item.children) {
              const childRuns = await inlineRunsToTextRuns(child.runs);
              elements.push(
                new Paragraph({
                  bullet: { level: 1 },
                  children: childRuns,
                }),
              );
            }
          }
        }
        break;
      }
      case "orderedList": {
        for (let idx = 0; idx < block.items.length; idx++) {
          const item = block.items[idx]!;
          const textRuns = await inlineRunsToTextRuns(item.runs);
          elements.push(
            new Paragraph({
              numbering: { reference: "default-numbering", level: 0 },
              children: textRuns,
            }),
          );
          if (item.children) {
            for (const child of item.children) {
              const childRuns = await inlineRunsToTextRuns(child.runs);
              elements.push(
                new Paragraph({
                  numbering: { reference: "default-numbering", level: 1 },
                  children: childRuns,
                }),
              );
            }
          }
        }
        break;
      }
      case "codeBlock": {
        // R2：mermaid 代码块 → SVG 渲染 → PNG ImageRun（保真）；失败降级为普通代码块
        if (block.language === "mermaid") {
          const imageRun = await renderMermaidToImageRun(block.content);
          reportProgress();
          if (imageRun) {
            elements.push(imageRun);
            break;
          }
        }
        // 代码块：每行一个 TextRun，monospace 字体 + 灰色背景
        const lines = block.content.replace(/\n$/, "").split("\n");
        const codeRuns: any[] = [];
        lines.forEach((line, idx) => {
          codeRuns.push(
            new TextRun({
              text: line,
              font: "Consolas",
              break: idx > 0 ? 1 : undefined,
              color: "1a1a1a",
            }),
          );
        });
        elements.push(
          new Paragraph({
            children: codeRuns,
            shading: { type: ShadingType.CLEAR, fill: "f4f4f4", color: "auto" },
          }),
        );
        break;
      }
      case "mathBlock": {
        // R2：KaTeX 渲染 → PNG ImageRun（保真）；失败降级为 LaTeX 源码文本（既有行为）
        const imageRun = await renderLatexToImageRun(block.latex);
        reportProgress();
        if (imageRun) {
          elements.push(imageRun);
          break;
        }
        elements.push(
          new Paragraph({
            children: [
              new TextRun({ text: block.latex, font: "Consolas", italics: true }),
            ],
          }),
        );
        break;
      }
      case "table": {
        // 使用 any[] 绕过 docx 库 TableRow 实例类型在 TS 中的使用限制
        // （TableRow 是值而非类型，无法直接作为类型注解）
        const rows: any[] = [];
        // 表头（三维结构：header[行][单元格][run]）
        for (const headerRow of block.header) {
          const headerCells = headerRow.map(
            (cellRuns) =>
              new TableCell({
                children: [
                  new Paragraph({
                    children: cellRuns.map(
                      (r) =>
                        new TextRun({
                          text: r.text,
                          bold: true,
                        }),
                    ),
                  }),
                ],
                shading: { type: ShadingType.CLEAR, fill: "f5f5f5", color: "auto" },
              }),
          );
          rows.push(new TableRow({ tableHeader: true, children: headerCells }));
        }
        // 表体（三维结构：rows[行][单元格][run]）
        for (const row of block.rows) {
          const cells = row.map(
            (cellRuns) =>
              new TableCell({
                children: [
                  new Paragraph({
                    children: cellRuns.map((r) => new TextRun({ text: r.text })),
                  }),
                ],
              }),
          );
          rows.push(new TableRow({ children: cells }));
        }
        elements.push(
          new Table({
            rows,
            width: { size: 100, type: WidthType.PERCENTAGE },
          }),
        );
        break;
      }
      case "blockquote": {
        // 引用块：递归转换内部块，添加左缩进
        const innerElements = await convertBlocksToDocxElements(
          block.blocks,
          indentLevel + 1,
        );
        elements.push(...innerElements);
        break;
      }
      case "hr": {
        elements.push(
          new Paragraph({
            border: {
              bottom: { color: "999999", space: 1, style: BorderStyle.SINGLE, size: 6 },
            },
          }),
        );
        break;
      }
    }
  }

  return elements;
}

/**
 * 将 markdown 转换为 .docx 文件并下载
 *
 * @param markdown markdown 源码
 * @param filename 下载文件名（不含扩展名）
 * @returns 成功返回 true，失败返回 false
 *
 * 修复 v0.3.0：Tauri 环境下使用 save 对话框选择保存路径，writeFile 写入二进制
 *
 * @param opts.filePath 当前编辑文件路径，用于推导默认保存目录
 * @param onProgress R2：公式/图表渲染进度回调（done/total，失败也计数）
 */
export async function markdownToDocx(
  markdown: string,
  filename: string,
  filePath?: string | null,
  onProgress?: ExportRenderProgress,
): Promise<boolean> {
  try {
    const { Document, Packer, AlignmentType, LevelFormat } = await import("docx");

    // 1. markdown → Block[]
    const { parseMarkdownToBlocks } = await import("./exportBlocks");
    const blocks = parseMarkdownToBlocks(markdown);

    // 2. Block[] → docx 元素（R2：公式/图表渲染进度透传）
    const children = await convertBlocksToDocxElements(blocks, 0, onProgress);

    // 3. 构造 Document（含有序列表 numbering 配置）
    const doc = new Document({
      numbering: {
        config: [
          {
            reference: "default-numbering",
            levels: [
              {
                level: 0,
                format: LevelFormat.DECIMAL,
                text: "%1.",
                alignment: AlignmentType.START,
              },
              {
                level: 1,
                format: LevelFormat.LOWER_LETTER,
                text: "%2.",
                alignment: AlignmentType.START,
              },
            ],
          },
        ],
      },
      sections: [
        {
          properties: {},
          children: children as any,
        },
      ],
    });

    // 4. 生成 Blob 并下载
    const blob = await Packer.toBlob(doc);
    const finalName = filename.endsWith(".docx") ? filename : `${filename}.docx`;

    // Tauri 环境：使用 save 对话框选择保存路径，writeFile 写入二进制
    const { isTauri } = await import("../services/fileService");
    if (isTauri()) {
      try {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const { writeFile } = await import("@tauri-apps/plugin-fs");
        const defaultDir = getDefaultDir(filePath);
        const selected = await save({
          defaultPath: defaultDir ? `${defaultDir}/${finalName}` : finalName,
          filters: [{ name: "Word", extensions: ["docx"] }],
        });
        if (selected) {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          await writeFile(selected, bytes);
          notifySuccess(t("export.word.exported", { name: finalName }));
          return true;
        }
        return false; // 用户取消
      } catch (err) {
        console.error("Tauri 导出 Word 失败，回退到浏览器下载:", err);
        // 回退到浏览器下载
      }
    }

    // 浏览器模式：触发下载
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = finalName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    notifySuccess(t("export.word.exported", { name: finalName }));
    return true;
  } catch (err) {
    console.error("Word 导出失败:", err);
    notifyError(
      t("export.word.exportFailed", {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return false;
  }
}
