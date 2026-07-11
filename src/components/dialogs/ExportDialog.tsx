/**
 * ExportDialog —— 导出设置对话框
 *
 * G5：PDF 导出排版增强（页眉/页脚/页码/边距/纸张大小）
 * G12：导出格式扩展（HTML / PDF / PNG 长图 / Word .docx）
 *
 * 工作流：
 * - HTML / 图片 / Word：直接导出
 * - PDF：先弹出 PdfExportDialog 配置选项，确认后再导出
 */
import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { isTauri, fileService } from "../../services/fileService";
import { notifySuccess, notifyError } from "../../services/notificationService";
import { highlightCodeBlocksInHtml, getPrismCss } from "../../utils/highlight";
import {
  generateFullPrintStylesheet,
  type PdfExportOptions,
} from "../../utils/pdfExport";
import { exportElementAsPng } from "../../utils/exportImage";
import { markdownToDocx } from "../../utils/exportDocx";
import { useT, t } from "../../i18n";
import { PdfExportDialog } from "./PdfExportDialog";
import "./ExportDialog.css";

type ExportFormat = "html" | "pdf" | "image" | "word";

interface ExportDialogProps {
  onClose: () => void;
  markdown: string;
  title: string;
  filePath?: string | null;
}

export function ExportDialog({ onClose, markdown, title, filePath }: ExportDialogProps) {
  const [format, setFormat] = useState<ExportFormat>(
    useSettingsStore.getState().defaultExportFormat === "pdf" ? "pdf" : "html",
  );
  const [includeCSS, setIncludeCSS] = useState(true);
  const [exporting, setExporting] = useState(false);
  // G5：PDF 选项对话框显示状态
  const [showPdfOptions, setShowPdfOptions] = useState(false);
  const tt = useT();

  const handleExport = async () => {
    // PDF 格式：先打开选项对话框，由 PdfExportDialog 确认后执行导出
    if (format === "pdf") {
      setShowPdfOptions(true);
      return;
    }

    setExporting(true);
    try {
      if (format === "html") {
        await exportHTML(markdown, title, includeCSS, filePath);
      } else if (format === "image") {
        await exportImage(markdown, title, filePath);
      } else if (format === "word") {
        const baseName = title.replace(/\.md$/i, "");
        await markdownToDocx(markdown, baseName, filePath);
      }
    } catch (err) {
      console.error("导出失败:", err);
      notifyError(t("export.exportFailed", { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setExporting(false);
      // 非 PDF 格式导出后直接关闭对话框（PDF 由 handlePdfOptionsConfirm 处理关闭）
      onClose();
    }
  };

  // G5：PDF 选项确认后执行导出
  const handlePdfOptionsConfirm = async (options: PdfExportOptions) => {
    setShowPdfOptions(false);
    setExporting(true);
    try {
      await exportPDFWithOptions(markdown, title, includeCSS, filePath, options);
    } catch (err) {
      console.error("PDF 导出失败:", err);
      notifyError(t("export.pdfExportFailed", { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setExporting(false);
      onClose();
    }
  };

  return (
    <>
      <div className="export-overlay" onClick={onClose}>
        <div className="export-dialog" onClick={(e) => e.stopPropagation()}>
          <div className="export-header">
            <h2>{tt("export.title")}</h2>
            <button className="export-close" onClick={onClose}>
              ✕
            </button>
          </div>

          <div className="export-body">
            <div className="export-field">
              <label>{tt("export.fileName")}</label>
              <input
                className="export-input"
                type="text"
                value={title}
                readOnly
              />
            </div>

            <div className="export-field">
              <label>{tt("export.format")}</label>
              <div className="export-format-group export-format-group-grid">
                <button
                  className={`export-format-btn ${format === "html" ? "active" : ""}`}
                  onClick={() => setFormat("html")}
                >
                  HTML
                </button>
                <button
                  className={`export-format-btn ${format === "pdf" ? "active" : ""}`}
                  onClick={() => setFormat("pdf")}
                >
                  PDF
                </button>
                <button
                  className={`export-format-btn ${format === "image" ? "active" : ""}`}
                  onClick={() => setFormat("image")}
                >
                  {tt("export.image")}
                </button>
                <button
                  className={`export-format-btn ${format === "word" ? "active" : ""}`}
                  onClick={() => setFormat("word")}
                >
                  {tt("export.word")}
                </button>
              </div>
            </div>

            <div className="export-field">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={includeCSS}
                  onChange={(e) => setIncludeCSS(e.target.checked)}
                />
                <span>{tt("export.includeCSS")}</span>
              </label>
            </div>

            {format === "pdf" && (
              <div className="export-info">
                {tt("export.pdfInfo")}
              </div>
            )}
            {format === "image" && (
              <div className="export-info">
                {tt("export.imageInfo")}
              </div>
            )}
            {format === "word" && (
              <div className="export-info">
                {tt("export.wordInfo")}
              </div>
            )}
          </div>

          <div className="export-footer">
            <button className="export-btn secondary" onClick={onClose}>
              {tt("export.cancel")}
            </button>
            <button
              className="export-btn primary"
              onClick={handleExport}
              disabled={exporting}
            >
              {exporting
                ? tt("export.exporting")
                : format === "pdf"
                  ? tt("export.pdf.configure")
                  : tt("export.exportFormat", { format: formatLabel(format, tt) })}
            </button>
          </div>
        </div>
      </div>

      {/* G5：PDF 选项对话框（覆盖在 ExportDialog 之上） */}
      {showPdfOptions && (
        <PdfExportDialog
          onClose={() => setShowPdfOptions(false)}
          onConfirm={handlePdfOptionsConfirm}
          title={title.replace(/\.md$/i, "")}
        />
      )}
    </>
  );
}

/** 格式标签（用于导出按钮文案） */
function formatLabel(format: ExportFormat, tt: (key: string, params?: Record<string, string | number>) => string): string {
  switch (format) {
    case "html": return "HTML";
    case "pdf": return "PDF";
    case "image": return tt("export.image");
    case "word": return tt("export.word");
  }
}

// ─── 导出实现 ──────────────────────────────────────────

const EXPORT_CSS = `
/* LightMD 导出样式 */
/* body 选择器用于 HTML/PDF 导出；.markdown-body 选择器用于图片导出（临时 div 无 body 元素） */
body, .markdown-body {
  font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", -apple-system, BlinkMacSystemFont, sans-serif;
  font-size: 16px;
  line-height: 1.8;
  color: #1a1a1a;
  max-width: 860px;
  margin: 40px auto;
  padding: 0 20px;
}
/* 图片导出场景下 .markdown-body 作为容器，max-width/margin auto 会导致截宽异常，重置为 100% 宽度自适应 */
.markdown-body {
  max-width: 100%;
  margin: 0;
  padding: 0;
}
h1 { font-size: 2em; margin: 0.8em 0 0.4em; border-bottom: 1px solid #eee; padding-bottom: 0.3em; }
h2 { font-size: 1.5em; margin: 0.7em 0 0.3em; border-bottom: 1px solid #eee; padding-bottom: 0.3em; }
h3 { font-size: 1.25em; margin: 0.6em 0 0.2em; }
h4 { font-size: 1.1em; margin: 0.5em 0 0.2em; }
blockquote {
  border-left: 4px solid #0078d4; margin: 0.8em 0;
  padding: 0.4em 1em; background: #f8f9fa; color: #555;
}
pre {
  background: #f4f4f4; border: 1px solid #e0e0e0; border-radius: 6px;
  padding: 1em; overflow-x: auto; font-family: "Cascadia Code", "Consolas", monospace;
  font-size: 0.9em; line-height: 1.5;
}
code {
  background: #f4f4f4; color: #d63384; padding: 0.15em 0.4em;
  border-radius: 3px; font-size: 0.9em;
}
pre code { background: none; color: inherit; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: 0.8em 0; }
th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
th { background: #f5f5f5; font-weight: 600; }
hr { border: none; border-top: 2px solid #e0e0e0; margin: 1.5em 0; }
a { color: #0078d4; text-decoration: none; }
a:hover { text-decoration: underline; }
img { max-width: 100%; border-radius: 4px; }
ul, ol { padding-left: 2em; }
ul.task-list { list-style: none; padding-left: 0; }
li.task-item { display: flex; align-items: flex-start; gap: 6px; margin: 0.3em 0; }
.task-item input[type="checkbox"] { margin-top: 5px; accent-color: #5c9dff; }
.task-item .task-checked { text-decoration: line-through; color: #999; }
`;

async function renderMarkdownToHTML(md: string): Promise<string> {
  // 复用主解析器的配置（html:false, breaks:true, linkify:true, typographer:true）
  // 确保导出结果与阅读/分屏模式一致
  const MarkdownIt = (await import("markdown-it")).default;
  const mdParser = new MarkdownIt("commonmark", {
    html: false,
    breaks: true,
    linkify: true,
    typographer: true,
  });
  mdParser.enable(["table", "strikethrough"]);
  // 启用任务列表插件
  const { taskListPlugin } = await import("../../core/markdown/task-list-plugin");
  mdParser.use(taskListPlugin);
  // 启用 KaTeX 数学公式插件
  const { mathPlugin } = await import("../../core/markdown/katex-plugin");
  mdParser.use(mathPlugin);
  // 标题锚点 id + [toc] 自动目录（与主解析器保持一致）
  const { headingAnchorPlugin } = await import("../../core/markdown/heading-anchor");
  const { tocPlugin } = await import("../../core/markdown/toc-plugin");
  mdParser.use(headingAnchorPlugin);
  mdParser.use(tocPlugin);
  // 启用高亮标记、上下标、emoji、脚注、定义列表插件（与主解析器保持一致）
  const markPlugin = (await import("markdown-it-mark")).default;
  const subPlugin = (await import("markdown-it-sub")).default;
  const supPlugin = (await import("markdown-it-sup")).default;
  const emojiPlugin = (await import("markdown-it-emoji")).full;
  const footnotePlugin = (await import("markdown-it-footnote")).default;
  const deflistPlugin = (await import("markdown-it-deflist")).default;
  mdParser.use(markPlugin);
  mdParser.use(subPlugin);
  mdParser.use(supPlugin);
  mdParser.use(emojiPlugin);
  mdParser.use(footnotePlugin);
  mdParser.use(deflistPlugin);
  const html = mdParser.render(md);
  // 将 mermaid 代码块包装为可渲染的容器
  let result = html.replace(
    /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
    '<pre class="mermaid">$1</pre>'
  );
  // 对代码块进行 PrismJS 语法高亮（跳过 mermaid 代码块）
  // 确保导出的 HTML/PDF 代码高亮与阅读/分屏模式一致
  result = highlightCodeBlocksInHtml(result);
  return result;
}

/** 获取默认导出目录（基于当前文件路径） */
function getDefaultDir(filePath: string | null | undefined): string | undefined {
  if (!filePath) return undefined;
  const idx = filePath.replace(/\\/g, "/").lastIndexOf("/");
  return idx > 0 ? filePath.substring(0, idx) : undefined;
}

async function exportHTML(md: string, title: string, includeCSS: boolean, filePath?: string | null) {
  const body = await renderMarkdownToHTML(md);
  // 获取当前主题，生成对应的 PrismJS 高亮 CSS
  const theme = useSettingsStore.getState().theme;
  const prismCss = getPrismCss(theme === "dark");
  const styles = includeCSS ? `<style>${EXPORT_CSS}\n${prismCss}</style>` : "";
  // 检测是否包含 mermaid 图表，注入 mermaid 脚本
  const hasMermaid = body.includes('class="mermaid"');
  // 检测是否包含数学公式，注入 KaTeX 脚本
  const hasMath = body.includes('data-math="inline"') || body.includes('data-math="block"');
  // 修复：mermaid 主题根据当前主题动态选择，原硬编码 "default" 在暗色主题下图表渲染异常
  const mermaidTheme = theme === "dark" ? "dark" : "default";
  const mermaidScript = hasMermaid
    ? '<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>' +
      `<script>mermaid.initialize({startOnLoad:true,theme:"${mermaidTheme}",securityLevel:"loose"});</script>`
    : "";
  const katexScript = hasMath
    ? '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.17/dist/katex.min.css">' +
      '<script src="https://cdn.jsdelivr.net/npm/katex@0.17/dist/katex.min.js"></script>' +
      '<script>document.querySelectorAll("[data-math=inline]").forEach(function(e){var l=e.getAttribute("data-latex");l&&katex.render(l,e,{throwOnError:false,displayMode:false})});document.querySelectorAll("[data-math=block]").forEach(function(e){var l=e.getAttribute("data-latex");l&&katex.render(l,e,{throwOnError:false,displayMode:true})});</script>'
    : "";
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  ${styles}
  ${mermaidScript}
  ${katexScript}
</head>
<body>
  ${body}
</body>
</html>`;

  const baseName = title.replace(/\.md$/i, "");
  const defaultDir = getDefaultDir(filePath);

  if (isTauri()) {
    try {
      const selected = await save({
        defaultPath: defaultDir ? `${defaultDir}/${baseName}.html` : `${baseName}.html`,
        filters: [{ name: "HTML", extensions: ["html"] }],
      });
      if (selected) {
        await fileService.writeFile(selected, html);
        notifySuccess(t("export.exportedHtml", { path: selected }));
      }
    } catch (err) {
      console.error("Tauri 导出 HTML 失败:", err);
      // 回退到浏览器下载
      downloadBlob(new Blob([html], { type: "text/html;charset=utf-8" }), `${baseName}.html`);
    }
  } else {
    // 浏览器模式：下载文件
    downloadBlob(new Blob([html], { type: "text/html;charset=utf-8" }), `${baseName}.html`);
  }
}

/**
 * G5：导出 PDF（带排版选项）
 *
 * 流程：
 * 1. 渲染 markdown 为 HTML
 * 2. 生成 @page CSS（含页眉/页脚/页码/边距/纸张大小）
 * 3. Tauri 模式：调用后端 export_html_to_pdf 命令
 * 4. 浏览器模式：使用打印功能（用户在打印对话框选择"另存为 PDF"）
 */
async function exportPDFWithOptions(
  md: string,
  title: string,
  includeCSS: boolean,
  filePath: string | null | undefined,
  options: PdfExportOptions,
) {
  const body = await renderMarkdownToHTML(md);
  const theme = useSettingsStore.getState().theme;
  const prismCss = getPrismCss(theme === "dark");
  const baseName = title.replace(/\.md$/i, "");

  // G5：根据用户选项生成 @page 打印 CSS
  // 包含：size（纸张大小）、margin（边距）、@top-center（页眉）、@bottom-center/right（页脚/页码）
  const printCss = generateFullPrintStylesheet(options, baseName);

  // 组合样式：打印 CSS + 主题样式 + PrismJS 高亮 CSS
  // 注意：@page 规则必须放在 <style> 中且作用于整个文档
  const styles = `<style>${printCss}\n${includeCSS ? EXPORT_CSS + "\n" + prismCss : ""}</style>`;

  // 检测是否包含 mermaid 图表，注入 mermaid 脚本
  const hasMermaid = body.includes('class="mermaid"');
  const hasMath = body.includes('data-math="inline"') || body.includes('data-math="block"');
  const mermaidTheme = theme === "dark" ? "dark" : "default";
  const mermaidScript = hasMermaid
    ? '<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>' +
      `<script>mermaid.initialize({startOnLoad:true,theme:"${mermaidTheme}",securityLevel:"loose"});</script>`
    : "";
  const katexScript = hasMath
    ? '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.17/dist/katex.min.css">' +
      '<script src="https://cdn.jsdelivr.net/npm/katex@0.17/dist/katex.min.js"></script>' +
      '<script>document.querySelectorAll("[data-math=inline]").forEach(function(e){var l=e.getAttribute("data-latex");l&&katex.render(l,e,{throwOnError:false,displayMode:false})});document.querySelectorAll("[data-math=block]").forEach(function(e){var l=e.getAttribute("data-latex");l&&katex.render(l,e,{throwOnError:false,displayMode:true})});</script>'
    : "";

  // 将 HTML 中的图片 src 转为 data URL
  // Edge headless 打开临时 HTML 文件时，相对/本地路径的图片无法正确加载
  const bodyWithImages = await convertImagesToDataUrlInHtml(body, filePath);

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>${escapeHtml(title)}</title>${styles}${mermaidScript}${katexScript}</head>
<body>${bodyWithImages}</body>
</html>`;

  const defaultDir = getDefaultDir(filePath);

  if (isTauri()) {
    try {
      const selected = await save({
        defaultPath: defaultDir ? `${defaultDir}/${baseName}.pdf` : `${baseName}.pdf`,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (selected) {
        await invoke("export_html_to_pdf", {
          htmlContent: html,
          pdfPath: selected,
        });
        notifySuccess(t("export.exportedPdf", { path: selected }));
      }
    } catch (err) {
      console.error("PDF 导出失败:", err);
      notifyError(t("export.pdfExportFailed", { error: err instanceof Error ? err.message : String(err) }));
      // 回退到浏览器打印
      fallbackPrint(html);
    }
  } else {
    // 浏览器模式：使用打印功能
    fallbackPrint(html);
  }
}

/**
 * G12：导出图片（PNG 长图）
 *
 * 实现：
 * 1. 创建隐藏的临时 div（宽度 860px，与 EXPORT_CSS 的 max-width 一致）
 * 2. 渲染 markdown + 主题样式到 div
 * 3. 将所有 <img> 的 src 转为 dataURL（避免跨域/相对路径导致截图空白或报错）
 * 4. 等待图片加载完成 + 浏览器布局
 * 5. 调用 exportElementAsPng 截图
 * 6. 移除临时 div
 *
 * 注意：Mermaid/KaTeX 在图片中作为代码块或原始 HTML 显示（不渲染图表），
 * 因为 html-to-image 截图时不会等待异步脚本执行。
 */
async function exportImage(md: string, title: string, filePath?: string | null) {
  const body = await renderMarkdownToHTML(md);
  const theme = useSettingsStore.getState().theme;
  const prismCss = getPrismCss(theme === "dark");

  // 创建临时隐藏 div
  // 使用 fixed + visibility:hidden 替代 left:-9999px，确保元素在视口内能正确渲染
  const container = document.createElement("div");
  container.style.position = "fixed";
  container.style.left = "0";
  container.style.top = "0";
  container.style.width = "860px";
  container.style.padding = "20px";
  container.style.background = "#fff";
  container.style.color = "#1a1a1a";
  container.style.boxSizing = "border-box";
  container.style.zIndex = "-1";
  container.style.visibility = "hidden";
  // 注入样式（EXPORT_CSS 已包含 .markdown-body 选择器，确保临时 div 也能应用基础排版样式）
  container.innerHTML = `<style>${EXPORT_CSS}\n${prismCss}</style><div class="markdown-body">${body}</div>`;
  document.body.appendChild(container);

  try {
    // 将所有 <img> 的 src 转为 dataURL，避免 html-to-image 内部 fetch 跨域失败
    await convertImagesToDataUrl(container, filePath);

    // 等待所有图片加载完成（data URL 也需要 decode），避免截图空白
    const images = Array.from(container.querySelectorAll("img"));
    if (images.length > 0) {
      await Promise.all(
        images.map((img) => {
          if (img.complete) return Promise.resolve();
          return new Promise<void>((resolve) => {
            img.onload = () => resolve();
            img.onerror = () => resolve(); // 加载失败也继续，避免卡死
          });
        }),
      );
    }
    // 再等一帧让浏览器完成布局
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    // 额外等待 50ms 确保样式完全应用
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 截图前设为可见（html-to-image 需要元素可见才能正确渲染）
    container.style.visibility = "visible";
    const baseName = title.replace(/\.md$/i, "");
    await exportElementAsPng(container, baseName, { filePath });
  } finally {
    // 移除临时 div
    document.body.removeChild(container);
  }
}

/**
 * 将容器内所有 <img> 的 src 转为 dataURL
 *
 * html-to-image 内部用 fetch 获取图片转 dataURL，但：
 * - 相对路径在临时 div 中无法解析（没有 base URL）
 * - file:// 协议被 CORS 阻止
 * - 外部 URL 可能跨域
 *
 * 因此在截图前统一转换：
 * - data URL：跳过
 * - http(s) URL：fetch → blob → FileReader → dataURL
 * - 本地路径（相对/绝对）：Tauri readFile → base64 → dataURL
 */
async function convertImagesToDataUrl(container: HTMLElement, docPath: string | null | undefined): Promise<void> {
  const images = Array.from(container.querySelectorAll("img"));
  for (const img of images) {
    const src = img.getAttribute("src") || "";
    if (!src) continue;
    // data URL 无需转换
    if (src.startsWith("data:")) continue;

    try {
      if (src.startsWith("http://") || src.startsWith("https://")) {
        // 外部 URL：fetch → blob → dataURL
        const response = await fetch(src);
        const blob = await response.blob();
        const dataUrl = await blobToDataUrl(blob);
        img.setAttribute("src", dataUrl);
      } else if (isTauri()) {
        // 本地文件：解析为绝对路径后用 Tauri readFile 读取
        const absPath = resolveImagePath(src, docPath);
        if (!absPath) continue;
        const { readFile } = await import("@tauri-apps/plugin-fs");
        const bytes = await readFile(absPath);
        const mime = guessMimeFromPath(absPath);
        const base64 = bytesToBase64(bytes);
        img.setAttribute("src", `data:${mime};base64,${base64}`);
      }
    } catch (err) {
      console.warn("[导出图片] 图片转换 dataURL 失败:", src, err);
    }
  }
}

/** 解析图片 src 为绝对路径（基于文档所在目录） */
function resolveImagePath(src: string, docPath: string | null | undefined): string | null {
  // 绝对路径（Unix / 或 Windows 盘符）
  if (src.startsWith("/") || /^[A-Za-z]:/.test(src)) {
    return src;
  }
  // file:// 协议
  if (src.startsWith("file://")) {
    return src.replace("file://", "");
  }
  // 相对路径：基于文档目录解析
  if (docPath) {
    const normalized = docPath.replace(/\\/g, "/");
    const dir = normalized.substring(0, normalized.lastIndexOf("/"));
    if (dir) return `${dir}/${src}`;
  }
  return null;
}

/** Blob 转 dataURL */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/** 根据文件扩展名猜测 MIME 类型 */
function guessMimeFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  const mimeMap: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    webp: "image/webp",
    bmp: "image/bmp",
  };
  return mimeMap[ext] || "image/png";
}

/** Uint8Array 转 base64（分块处理避免大文件栈溢出） */
function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, Array.from(chunk) as unknown as number[]);
  }
  return btoa(binary);
}

/**
 * 将 HTML 字符串中所有 <img> 的 src 转为 data URL
 *
 * 用于 PDF 导出：Edge headless 打开临时 HTML 文件时，
 * 相对路径/本地路径的图片无法正确加载，需预先转为 data URL 嵌入 HTML
 */
async function convertImagesToDataUrlInHtml(html: string, docPath: string | null | undefined): Promise<string> {
  // 匹配 <img ... src="..." ...> 中的 src
  const imgRegex = /<img\s[^>]*src="([^"]*)"[^>]*>/gi;
  const matches: { src: string; fullMatch: string }[] = [];
  let match;
  while ((match = imgRegex.exec(html)) !== null) {
    matches.push({ src: match[1], fullMatch: match[0] });
  }

  let result = html;
  for (const { src, fullMatch } of matches) {
    if (!src || src.startsWith("data:")) continue;
    try {
      let dataUrl: string | null = null;
      if (src.startsWith("http://") || src.startsWith("https://")) {
        const response = await fetch(src);
        const blob = await response.blob();
        dataUrl = await blobToDataUrl(blob);
      } else if (isTauri()) {
        const absPath = resolveImagePath(src, docPath);
        if (!absPath) continue;
        const { readFile } = await import("@tauri-apps/plugin-fs");
        const bytes = await readFile(absPath);
        const mime = guessMimeFromPath(absPath);
        const base64 = bytesToBase64(bytes);
        dataUrl = `data:${mime};base64,${base64}`;
      }
      if (dataUrl) {
        result = result.replace(fullMatch, fullMatch.replace(src, dataUrl));
      }
    } catch (err) {
      console.warn("[导出PDF] 图片转换 dataURL 失败:", src, err);
    }
  }
  return result;
}

/** 回退方案：使用浏览器打印 */
function fallbackPrint(html: string) {
  const printWindow = window.open("", "_blank");
  if (printWindow) {
    printWindow.document.write(html);
    printWindow.document.close();
    printWindow.focus();
    printWindow.onload = () => {
      setTimeout(() => printWindow.print(), 300);
    };
    setTimeout(() => {
      try { printWindow.print(); } catch { /* 忽略 */ }
    }, 1500);
  } else {
    notifyError(t("export.printWindowBlocked"));
  }
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
