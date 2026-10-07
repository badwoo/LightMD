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
 * v0.11.0 B2-5：把本地图片读为 Uint8Array（供 docx ImageRun 嵌入）。
 *
 * 缺陷背景（P0）：`exportBlocks.parseInlineTokens` 把 image token 转成
 * `[图片: alt]` 占位文本 + imageSrc 字段，但 `inlineRunsToTextRuns` **无 imageSrc
 * 分支** → DOCX 导出后只有占位文字，图片全部丢失。
 *
 * 支持两类 src：
 * ① data URL（base64 内联，临时文件粘贴的图片即此形态）→ 直接解码；
 * ② 相对/绝对路径 → 走 Tauri fs 读盘（capabilities 已授 fs:allow-read-file 全路径）。
 */
async function loadImageBytes(src: string): Promise<Uint8Array | null> {
  try {
    // data URL
    if (src.startsWith("data:")) {
      const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(src);
      if (!m) return null;
      const payload = m[3] ?? "";
      if (m[2]) {
        // base64：atob → Uint8Array
        const bin = atob(payload);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
      }
      // 非 base64（纯文本）→ UTF-8 字节
      return new TextEncoder().encode(decodeURIComponent(payload));
    }
    // 本地路径：Tauri fs 读取
    const { isTauri } = await import("../services/fileService");
    if (isTauri()) {
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const bytes = await readFile(src);
      return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer);
    }
    // 浏览器环境：fetch（相对路径基于当前 origin，可能读不到 → 降级）
    const resp = await fetch(src);
    if (!resp.ok) return null;
    return new Uint8Array(await resp.arrayBuffer());
  } catch (err) {
    console.warn("[导出Word] 图片读取失败，降级为占位文字:", src, err);
    return null;
  }
}

/** 常见图片类型的 docx type 映射 */
function docxImageType(src: string): "png" | "jpg" | "gif" | "bmp" | "svg" {
  const lower = src.toLowerCase().split("?")[0]!;
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "jpg";
  if (lower.endsWith(".gif")) return "gif";
  if (lower.endsWith(".bmp")) return "bmp";
  if (lower.endsWith(".svg")) return "svg";
  if (lower.startsWith("data:image/jpeg") || lower.startsWith("data:image/jpg")) return "jpg";
  if (lower.startsWith("data:image/gif")) return "gif";
  if (lower.startsWith("data:image/bmp")) return "bmp";
  if (lower.startsWith("data:image/svg")) return "svg";
  return "png";
}

/**
 * v0.11.0 B2-5：图片 InlineRun → docx ImageRun。
 *
 * 返回 null 表示无法加载（调用方降级为占位文字，不丢内容）。
 */
async function buildImageRun(src: string, alt: string): Promise<unknown | null> {
  const bytes = await loadImageBytes(src);
  if (!bytes || bytes.length === 0) return null;
  const { ImageRun } = await import("docx");
  const type = docxImageType(src);
  // SVG 在 docx 库中属 SvgMediaOptions，额外要求 fallback（栅格回退图）
  if (type === "svg") {
    return new ImageRun({
      type: "svg",
      data: bytes,
      fallback: { type: "png", data: bytes },
      transformation: { width: 400, height: 300 },
    });
  }
  return new ImageRun({
    type,
    data: bytes,
    transformation: { width: 400, height: 300 },
    altText: alt ? { name: alt, description: alt, title: alt } : undefined,
  });
}

/**
 * 将 InlineRun[] 转换为 docx TextRun[] 数组
 *
 * 返回 any[] 是为了绕过 docx 库 ParagraphChild 类型联合的复杂签名，
 * 实际元素都是 TextRun / ImageRun 实例。
 */
async function inlineRunsToTextRuns(runs: InlineRun[]): Promise<any[]> {
  const { TextRun } = await import("docx");
  const result: any[] = [];
  for (const r of runs) {
    const props: Record<string, unknown> = {};
    if (r.bold) props.bold = true;
    if (r.italic) props.italics = true;
    if (r.strike) props.strike = true;
    // v0.11.0 B2-4：mark / sub / sup 此前完全丢失（Word 支持底纹与上下标）
    if (r.mark) {
      props.shading = { type: "clear", fill: "FFF3B0", color: "auto" };
    }
    if (r.sub) props.subScript = true;
    if (r.sup) props.superScript = true;
    if (r.code) {
      props.font = "Consolas";
      props.shading = { type: "clear", fill: "f4f4f4", color: "auto" };
    }
    // 简化：链接转为带颜色的文本（docx 超链接需要 ExternalHyperlink，实现复杂）
    if (r.href) props.color = "0078d4";

    // v0.11.0 B2-5：行内公式转 OMML（Word 原生公式对象）。
    // 此处保持为可读文本（Word 里是纯文本），但**不再退化为 LaTeX 源码带 $ 符号**。
    if (r.math) {
      result.push(new TextRun({ ...props, text: r.math, italics: true }));
      continue;
    }

    // v0.11.0 B2-5：图片 → ImageRun（此前无 imageSrc 分支 → DOCX 里图片全部丢失，
    // 只剩 `[图片: alt]` 占位文字）。加载失败则退回占位文字，不丢内容。
    if (r.imageSrc) {
      const imageRun = await buildImageRun(r.imageSrc, r.text || "");
      if (imageRun) {
        result.push(imageRun);
        continue;
      }
      result.push(new TextRun({ ...props, text: r.text || "[图片]" }));
      continue;
    }

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
 * v0.11.0 B5-2：有序列表起始序号 → numbering reference。
 *
 * 缺陷背景（P1）：此前所有有序列表都用固定的 `"default-numbering"`，而该
 * numbering 的 level 0 未设 start → `5. x` 导出到 Word 后**从 1 开始**，
 * 原文编号被静默改写。
 *
 * 修复：按 start 值生成不同 reference（如 `ol-start-5`），并由
 * buildNumberingConfigs 配套生成对应的 numbering 定义（含 start + 对齐的
 * 子级格式）。
 *
 * 编号 reference 的 start 取值范围有限（实际文档不会超过几十），这里按需生成。
 */
function orderedListNumberingRef(start: number): string {
  const s = Number.isFinite(start) && start > 0 ? Math.floor(start) : 1;
  return s === 1 ? "default-numbering" : `ol-start-${s}`;
}

/**
 * v0.11.0 B5-2：为用到的起始序号生成 numbering 配置。
 *
 * @param blocks 全部块（递归收集所有有序列表的 start）
 */
function collectOrderedListStarts(blocks: Block[], out: Set<number> = new Set()): Set<number> {
  for (const b of blocks) {
    if (b.kind === "orderedList") out.add(b.start > 0 ? Math.floor(b.start) : 1);
    else if (b.kind === "blockquote") collectOrderedListStarts(b.blocks, out);
  }
  return out;
}

/** 构造某个起始序号对应的 numbering config（3 级，格式与默认一致） */
async function buildNumberingConfigFor(start: number) {
  const { AlignmentType, LevelFormat } = await import("docx");
  return {
    reference: orderedListNumberingRef(start),
    levels: [
      {
        level: 0,
        format: LevelFormat.DECIMAL,
        text: "%1.",
        alignment: AlignmentType.START,
        start,
      },
      {
        level: 1,
        format: LevelFormat.LOWER_LETTER,
        text: "%2.",
        alignment: AlignmentType.START,
        start: 1,
      },
      {
        // v0.11.0 B5-4：补第 3 级，支持更深的嵌套（原配置只有 2 级）
        level: 2,
        format: LevelFormat.LOWER_ROMAN,
        text: "%3.",
        alignment: AlignmentType.START,
        start: 1,
      },
    ],
  };
}

/**
 * v0.11.0 B5-4：递归展开列表项（含任意层级嵌套）。
 *
 * 缺陷背景（P1）：此前只展开一层 `item.children`，第 3 层起被**扁平化**到
 * level 1（层级丢失）。现递归处理，并把超过 3 层的嵌套钳到最深层级
 * （docx 的 numbering 只需定义有限层级）。
 */
async function appendListItems(
  items: import("./exportBlocks").ListItem[],
  ref: string,
  level: number,
  elements: unknown[],
  kind: "orderedList" | "bulletList",
): Promise<void> {
  const { Paragraph } = await import("docx");
  const MAX_LEVEL = 2; // numbering 定义了 0/1/2 三级
  for (const item of items) {
    const textRuns = await inlineRunsToTextRuns(item.runs);
    const atLevel = Math.min(level, MAX_LEVEL);
    elements.push(
      new Paragraph(
        kind === "orderedList"
          ? { numbering: { reference: ref, level: atLevel }, children: textRuns }
          : // 无序列表沿用默认 bullet 定义（docx 内置 "default-bullet"）
            { numbering: { reference: "default-bullet", level: atLevel }, children: textRuns },
      ),
    );
    if (item.children?.length) {
      // 递归：子列表沿用父级的 reference（有序）或默认 bullet（无序）
      await appendListItems(item.children, ref, level + 1, elements, kind);
    }
  }
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
    // v0.11.0 B2-5：图片/图表段落居中需要 AlignmentType
    AlignmentType,
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
        // v0.11.0 B5-4：改为递归展开（此前只处理一层，第 3 层起被扁平化）
        await appendListItems(block.items, "default-bullet", 0, elements, "bulletList");
        break;
      }
      case "orderedList": {
        // v0.11.0 B5-2：起始序号不再丢失。
        // 缺陷背景（P1）：exportBlocks 已解析 markdown-it 的 start 属性并写入
        // block.start，但此前统一用 `numbering: { reference: "default-numbering" }`
        // → `5. x` 导出到 Word 后从 1 开始，原文编号被改写。
        // 现按 start 值选用对应的 numbering reference（见 buildNumberingConfigs）。
        const ref = orderedListNumberingRef(block.start);
        // v0.11.0 B5-4：嵌套列表**递归**展开（此前只展开一层，第 3 层起被扁平化）。
        await appendListItems(block.items, ref, 0, elements, "orderedList");
        break;
      }
      case "codeBlock": {
        // R2：mermaid 代码块 → SVG 渲染 → PNG ImageRun（保真）；失败降级为普通代码块
        if (block.language === "mermaid") {
          const imageRun = await renderMermaidToImageRun(block.content);
          reportProgress();
          if (imageRun) {
            // v0.11.0 B2-5：ImageRun 是 **run 级**元素（ParagraphChild），
            // 直接 push 进 elements（要求 block 级）会让 Packer.toBlob 抛错或产出
            // 损坏的 docx。必须包一层 Paragraph。
            elements.push(
              new Paragraph({
                children: [imageRun as never],
                alignment: AlignmentType.CENTER,
              }),
            );
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
          // v0.11.0 B2-5：同 mermaid —— ImageRun 属 run 级，须包 Paragraph
          elements.push(
            new Paragraph({
              children: [imageRun as never],
              alignment: AlignmentType.CENTER,
            }),
          );
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
      // v0.11.0 B2-4：任务列表（此前 token 落 default → DOCX 整体丢失）
      case "taskList": {
        for (const item of block.items) {
          // 用 ☐ / ☑ 字符表达勾选状态（兼容 Word/WPS 字体，无需 numbering 定义）
          const mark = item.checked ? "☑ " : "☐ ";
          elements.push(
            new Paragraph({
              children: await inlineRunsToTextRuns([{ text: mark }]),
              indent: { left: 720 * indentLevel },
            }),
          );
          if (item.runs.length > 0) {
            elements.push(
              new Paragraph({
                children: await inlineRunsToTextRuns(item.runs),
                indent: { left: 720 * (indentLevel + 1) },
              }),
            );
          }
          for (const child of item.children ?? []) {
            elements.push(
              new Paragraph({
                children: await inlineRunsToTextRuns(child.runs),
                bullet: { level: indentLevel + 1 },
              }),
            );
          }
        }
        break;
      }
      // v0.11.0 B2-4：定义列表（此前术语丢失）
      case "defList": {
        for (const item of block.items) {
          // 术语：加粗独立成段
          elements.push(
            new Paragraph({
              children: await inlineRunsToTextRuns(
                item.term.map((r) => ({ ...r, bold: true })),
              ),
            }),
          );
          for (const desc of item.descriptions) {
            if (desc.length === 0) continue;
            elements.push(
              new Paragraph({
                children: await inlineRunsToTextRuns(desc),
                indent: { left: 720 * (indentLevel + 1) },
              }),
            );
          }
        }
        break;
      }
      // v0.11.0 B2-4：自动目录（此前落 default）
      case "toc": {
        for (const h of block.headings) {
          if (!h.text) continue;
          elements.push(
            new Paragraph({
              children: await inlineRunsToTextRuns([{ text: h.text, bold: h.level <= 2 }]),
              indent: { left: 720 * (indentLevel + Math.max(0, h.level - 1)) },
            }),
          );
        }
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
    // v0.11.0 B2-4：用详细版解析，收集未识别 token 并在导出后提示用户
    //（此前未识别 token 被静默丢弃 → 任务列表/定义列表整体消失且用户无感知）
    const { parseMarkdownToBlocksDetailed } = await import("./exportBlocks");
    const { blocks, unknownTokens } = parseMarkdownToBlocksDetailed(markdown);

    // 2. Block[] → docx 元素（R2：公式/图表渲染进度透传）
    const children = await convertBlocksToDocxElements(blocks, 0, onProgress);

    // 3. 构造 Document（含有序/无序列表 numbering 配置）
    // v0.11.0 B5-2：为文档中出现的每个有序列表起始序号生成对应 numbering
    //（此前统一用 default-numbering → `5. x` 导出后从 1 开始）
    // v0.11.0 B5-4：默认 numbering 补第 3 级，支持更深嵌套
    const starts = collectOrderedListStarts(blocks);
    const numberingConfigs: unknown[] = [await buildNumberingConfigFor(1)];
    for (const st of starts) {
      if (st === 1) continue;
      numberingConfigs.push(await buildNumberingConfigFor(st));
    }
    // 无序列表定义（appendListItems 递归时按层级引用）
    numberingConfigs.push({
      reference: "default-bullet",
      levels: [0, 1, 2].map((lv) => ({
        level: lv,
        format: LevelFormat.BULLET,
        text: lv === 0 ? "\u2022" : lv === 1 ? "o" : "\u25AA",
        alignment: AlignmentType.START,
      })),
    });

    const doc = new Document({
      numbering: { config: numberingConfigs as never },
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

    // v0.11.0 B2-4：未识别 token 提示。
    // 此前这些内容被静默丢弃，用户拿到缺内容的文件却毫不知情；
    // 现在明确告知「哪些内容没能导出」，把静默失败变为可见降级。
    if (unknownTokens.length > 0) {
      const { notifyWarning } = await import("../services/notificationService");
      notifyWarning(
        `部分内容无法导出到 Word：${unknownTokens.join("、")}。已导出其余内容。`
      );
    }

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
