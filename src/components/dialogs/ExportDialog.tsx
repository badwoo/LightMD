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
import { useState, useCallback } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { isTauri, fileService } from "../../services/fileService";
import { notifySuccess, notifyError } from "../../services/notificationService";
import { getPrismCss } from "../../utils/highlight";
import {
  generateFullPrintStylesheet,
  generateFixedMarginBoxHtml,
  type PdfExportOptions,
} from "../../utils/pdfExport";
import { exportElementAsPng } from "../../utils/exportImage";
// v0.11.0 B4-3：主题明暗判定单源（night 也是暗色）
import { isDarkTheme, mermaidThemeName } from "../../utils/themeTone";
// v0.11.0 B2-1：导出资源内联（离线可用；此前走 CDN → 离线公式图表全空白）
import {
  collectInlineAssets,
  buildKatexRenderScript,
  buildMermaidInitScript,
  EXPORT_ASSETS_DIR,
} from "../../utils/vendorAssets";
// R2(v0.10.0)：导出前公式/图表渲染（PNG 保真；EPUB/DOCX 的替换在各自工具内实现）
import {
  replaceMathPlaceholdersInDom,
  replaceMermaidBlocksInDom,
} from "../../utils/exportMathRender";
import { markdownToDocx } from "../../utils/exportDocx";
import { useT, t } from "../../i18n";
import { PdfExportDialog } from "./PdfExportDialog";
import "./ExportDialog.css";

type ExportFormat = "html" | "pdf" | "image" | "word" | "epub" | "latex";

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
  // R2：导出进度文案（公式/图表逐个渲染时更新，显示在导出按钮上）
  const [progressText, setProgressText] = useState("");
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
    setProgressText("");
    // v0.11.0 B5-7：仅在**真正完成导出**时关闭对话框。
    // 缺陷背景（P2）：原实现无条件 `finally { onClose() }` → 用户在保存对话框
    // 点「取消」时对话框也被关掉（看起来像导出成功）；导出失败时同样关窗，
    // 错误提示与失败现场一起消失、无法重试。
    let succeeded = false;
    try {
      if (format === "html") {
        succeeded = await exportHTML(markdown, title, includeCSS, filePath);
      } else if (format === "image") {
        succeeded = await exportImage(markdown, title, filePath, setProgressText);
      } else if (format === "word") {
        const baseName = title.replace(/\.md$/i, "");
        succeeded = await markdownToDocx(markdown, baseName, filePath, (done, total) =>
          setProgressText(`公式/图表 ${done}/${total}`),
        );
      } else if (format === "epub") {
        const baseName = title.replace(/\.md$/i, "");
        const { exportEpub } = await import("../../utils/exportEpub");
        succeeded = await exportEpub(markdown, baseName, filePath, (done, total) =>
          setProgressText(`公式/图表 ${done}/${total}`),
        );
      } else if (format === "latex") {
        const baseName = title.replace(/\.md$/i, "");
        const { exportLatex } = await import("../../utils/exportLatex");
        succeeded = await exportLatex(markdown, baseName, filePath);
      }
    } catch (err) {
      console.error("导出失败:", err);
      notifyError(t("export.exportFailed", { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setExporting(false);
      setProgressText("");
    }
    if (succeeded) onClose();
  };

  /** 用户主动关闭（点取消/Esc/关闭按钮）—— 不算导出完成 */
  const handleCancel = useCallback(() => {
    if (exporting) return; // 导出中不响应，避免半途中断
    onClose();
  }, [exporting, onClose]);

  // G5：PDF 选项确认后执行导出
  const handlePdfOptionsConfirm = async (options: PdfExportOptions) => {
    setShowPdfOptions(false);
    setExporting(true);
    let succeeded = false;
    try {
      succeeded = await exportPDFWithOptions(markdown, title, includeCSS, filePath, options);
    } catch (err) {
      console.error("PDF 导出失败:", err);
      notifyError(t("export.pdfExportFailed", { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setExporting(false);
    }
    // v0.11.0 B5-7：同 handleExport —— 仅成功时关闭
    if (succeeded) onClose();
  };

  return (
    <>
      <div className="export-overlay" onClick={handleCancel}>
        <div className="export-dialog" onClick={(e) => e.stopPropagation()}>
          <div className="export-header">
            <h2>{tt("export.title")}</h2>
            <button className="export-close" onClick={handleCancel} title={tt("export.cancel")}>
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
                <button
                  className={`export-format-btn ${format === "epub" ? "active" : ""}`}
                  onClick={() => setFormat("epub")}
                >
                  {tt("export.epub")}
                </button>
                <button
                  className={`export-format-btn ${format === "latex" ? "active" : ""}`}
                  onClick={() => setFormat("latex")}
                >
                  {tt("export.latex")}
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
            {format === "epub" && (
              <div className="export-info">
                {tt("export.epubInfo")}
              </div>
            )}
            {format === "latex" && (
              <div className="export-info">
                {tt("export.latexInfo")}
              </div>
            )}
          </div>

          <div className="export-footer">
            <button className="export-btn secondary" onClick={handleCancel} disabled={exporting}>
              {tt("export.cancel")}
            </button>
            <button
              className="export-btn primary"
              onClick={handleExport}
              disabled={exporting}
            >
              {exporting
                ? progressText
                  ? `${tt("export.exporting")} · ${progressText}`
                  : tt("export.exporting")
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
    case "epub": return tt("export.epub");
    case "latex": return tt("export.latex");
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

export async function renderMarkdownToHTML(md: string): Promise<string> {
  // R1(v0.10.0):导出 HTML/PDF/PNG 统一走 renderPipeline——typographer 恒 false
  // (消除弯引号漂移)、validateLink 白名单强制(javascript: 不再进入导出 HTML)。
  // 保留本函数导出：exportEpub 复用此管线产物
  const { renderMarkdownHtml } = await import("../../core/renderPipeline");
  return renderMarkdownHtml(md);
}

/** 获取默认导出目录（基于当前文件路径） */
function getDefaultDir(filePath: string | null | undefined): string | undefined {
  if (!filePath) return undefined;
  const idx = filePath.replace(/\\/g, "/").lastIndexOf("/");
  return idx > 0 ? filePath.substring(0, idx) : undefined;
}

/**
 * v0.11.0 B5-7：返回是否真正完成导出。
 *
 * 缺陷背景（P2）：原实现无返回值，调用方在 `finally` 里无条件 `onClose()`
 * → 用户在「保存」对话框点**取消**时，对话框仍被关掉（看起来像导出完成），
 * 导出失败时也关窗（错误提示与失败现场同时消失）。
 */
async function exportHTML(
  md: string,
  title: string,
  includeCSS: boolean,
  filePath?: string | null,
): Promise<boolean> {
  const bodyRaw = await renderMarkdownToHTML(md);
  // v0.11.0 B5-6：HTML 导出也把图片转为 data URL。
  // 缺陷背景（P1）：PDF 路径调了 convertImagesToDataUrlInHtml，HTML 路径没调
  // → 导出的 HTML 单文件被移动/发送后，相对路径与本地路径图片**全部裂图**。
  // 外部 http(s) 图片在离线打开时同样失效。
  const body = await convertImagesToDataUrlInHtml(bodyRaw, filePath);
  // 获取当前主题，生成对应的 PrismJS 高亮 CSS
  const theme = useSettingsStore.getState().theme;
  const prismCss = getPrismCss(isDarkTheme(theme));
  const styles = includeCSS ? `<style>${EXPORT_CSS}\n${prismCss}</style>` : "";
  // 检测是否包含 mermaid 图表，注入 mermaid 脚本
  const hasMermaid = body.includes('class="mermaid"');
  // 检测是否包含数学公式，注入 KaTeX 脚本
  const hasMath = body.includes('data-math="inline"') || body.includes('data-math="block"');
  // 修复：mermaid 主题根据当前主题动态选择，原硬编码 "default" 在暗色主题下图表渲染异常
  const mermaidTheme = mermaidThemeName(theme);
  const baseName = title.replace(/\.md$/i, "");
  const defaultDir = getDefaultDir(filePath);

  // v0.11.0 B2-1：内联 vendor 资源，实现离线可用（此前走 CDN → 离线公式图表全空白）。
  // mermaid 3.2MB 不内联，改为在导出目录旁置 _assets/mermaid.min.js。
  const assets = hasMermaid || hasMath ? await collectInlineAssets(true) : null;
  const useInline = !!assets?.ok;

  // mermaid：内联不可行（体积），用相对路径引 _assets；无资源时回退 CDN
  let mermaidScript = "";
  let mermaidAssetToWrite: { name: string; content: string } | null = null;
  if (hasMermaid) {
    if (assets?.mermaidJs) {
      mermaidAssetToWrite = { name: "mermaid.min.js", content: assets.mermaidJs };
      mermaidScript =
        `<script src="./${EXPORT_ASSETS_DIR}/mermaid.min.js"></script>` +
        buildMermaidInitScript(mermaidTheme);
    } else {
      mermaidScript =
        '<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>' +
        buildMermaidInitScript(mermaidTheme);
    }
  }

  // KaTeX：CSS（含字体 base64）+ JS 全部内联 → 单文件自包含
  const katexScript =
    hasMath && useInline && assets?.katexCss && assets?.katexJs
      ? `<style>${assets.katexCss}</style>` +
        `<script>${assets.katexJs}</script>` +
        buildKatexRenderScript()
      : hasMath
        ? '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.17/dist/katex.min.css">' +
          '<script src="https://cdn.jsdelivr.net/npm/katex@0.17/dist/katex.min.js"></script>' +
          buildKatexRenderScript()
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

  if (isTauri()) {
    try {
      const selected = await save({
        defaultPath: defaultDir ? `${defaultDir}/${baseName}.html` : `${baseName}.html`,
        filters: [{ name: "HTML", extensions: ["html"] }],
      });
      if (selected) {
        await fileService.writeFile(selected, html);
        // v0.11.0 B2-1：旁置 _assets/mermaid.min.js（体积 3.2M 不内联）
        if (mermaidAssetToWrite) {
          await writeExportAsset(selected, mermaidAssetToWrite.name, mermaidAssetToWrite.content);
        }
        notifySuccess(t("export.exportedHtml", { path: selected }));
        return true;
      }
      // 用户取消保存 → 未完成
      return false;
    } catch (err) {
      console.error("Tauri 导出 HTML 失败:", err);
      // 回退到浏览器下载
      downloadBlob(new Blob([html], { type: "text/html;charset=utf-8" }), `${baseName}.html`);
      return true;
    }
  } else {
    // 浏览器模式：下载文件
    downloadBlob(new Blob([html], { type: "text/html;charset=utf-8" }), `${baseName}.html`);
    return true;
  }
}

/**
 * v0.11.0 B2-1：在导出文件旁写 `_assets/<name>`。
 *
 * mermaid 3.2MB 内联会让 HTML 臃肿，故改为旁置资源目录 + 相对路径引用。
 * 失败时只记日志（不阻断导出——HTML 里的相对路径引用会落空，
 * 但用户仍能得到正文与公式，且会收到提示）。
 */
async function writeExportAsset(
  htmlPath: string,
  name: string,
  content: string,
): Promise<void> {
  try {
    const idx = htmlPath.replace(/\\/g, "/").lastIndexOf("/");
    const dir = idx > 0 ? htmlPath.substring(0, idx) : "";
    const assetDir = dir ? `${dir}/${EXPORT_ASSETS_DIR}` : EXPORT_ASSETS_DIR;
    const { mkdir, writeTextFile, exists } = await import("@tauri-apps/plugin-fs");
    if (!(await exists(assetDir))) await mkdir(assetDir, { recursive: true });
    await writeTextFile(`${assetDir}/${name}`, content);
  } catch (err) {
    console.warn("[导出] 写入资源目录失败，图表可能无法显示:", err);
    notifyError("导出资源写入失败，HTML 中的图表可能无法显示");
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
): Promise<boolean> {
  const body = await renderMarkdownToHTML(md);
  const theme = useSettingsStore.getState().theme;
  const prismCss = getPrismCss(isDarkTheme(theme));
  const baseName = title.replace(/\.md$/i, "");

  // G5：根据用户选项生成 @page 打印 CSS
  // v0.11.0 B2-2：页眉/页脚改用 fixed 常规元素（Chromium 打印每页重复），
  // 不再依赖 @page margin box（Chromium --print-to-pdf 不支持，原实现静默失效）；
  // 页码已降级停用（无法在现有导出引擎下实现）。
  const printCss = generateFullPrintStylesheet(options, baseName);
  // 页眉/页脚的真实 DOM 片段（CSS content 属性只对伪元素生效，故需节点）
  const marginBoxHtml = generateFixedMarginBoxHtml(options, baseName);

  // 组合样式：打印 CSS + 主题样式 + PrismJS 高亮 CSS
  // 注意：@page 规则必须放在 <style> 中且作用于整个文档
  // v0.11.0 B2-2 补充：includeCSS=false 时不再无条件注入 printCss
  //（此前无论用户是否勾选「包含样式」都会拼上 printCss，语义不一致）
  const styles = `<style>${printCss}${includeCSS ? "\n" + EXPORT_CSS + "\n" + prismCss : ""}</style>`;

  // 检测是否包含 mermaid 图表，注入 mermaid 脚本
  const hasMermaid = body.includes('class="mermaid"');
  const hasMath = body.includes('data-math="inline"') || body.includes('data-math="block"');
  const mermaidTheme = mermaidThemeName(theme);

  // v0.11.0 B2-1：内联 vendor 资源。
  // PDF 路径尤其必要——Edge headless 抓取临时 HTML 时若走 CDN，
  // 网络不可达则公式/图表静默空白，且 --virtual-time-budget 到点即截断。
  const assets = hasMermaid || hasMath ? await collectInlineAssets(true) : null;
  const useInline = !!assets?.ok;

  let mermaidScript = "";
  if (hasMermaid) {
    if (assets?.mermaidJs) {
      // PDF 场景的临时 HTML 用完即删（Rust 写在 %TEMP%/lightmd-export/），
      // 旁置资源需改 Rust 侧且临时目录有残留风险，故 mermaid 直接内联
      // （3.2MB 只影响临时文件与 Edge 解析时间，不影响最终 PDF 体积）。
      mermaidScript =
        `<script>${assets.mermaidJs}</script>` + buildMermaidInitScript(mermaidTheme);
    } else {
      mermaidScript =
        '<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>' +
        buildMermaidInitScript(mermaidTheme);
    }
  }

  const katexScript =
    hasMath && useInline && assets?.katexCss && assets?.katexJs
      ? `<style>${assets.katexCss}</style>` +
        `<script>${assets.katexJs}</script>` +
        buildKatexRenderScript()
      : hasMath
        ? '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.17/dist/katex.min.css">' +
          '<script src="https://cdn.jsdelivr.net/npm/katex@0.17/dist/katex.min.js"></script>' +
          buildKatexRenderScript()
        : "";

  // 将 HTML 中的图片 src 转为 data URL
  // Edge headless 打开临时 HTML 文件时，相对/本地路径的图片无法正确加载
  const bodyWithImages = await convertImagesToDataUrlInHtml(body, filePath);

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>${escapeHtml(title)}</title>${styles}${mermaidScript}${katexScript}</head>
<body>${marginBoxHtml}${bodyWithImages}</body>
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
        return true;
      }
      // 用户取消保存
      return false;
    } catch (err) {
      console.error("PDF 导出失败:", err);
      notifyError(t("export.pdfExportFailed", { error: err instanceof Error ? err.message : String(err) }));
      // 回退到浏览器打印
      fallbackPrint(html);
      return false;
    }
  } else {
    // 浏览器模式：使用打印功能（用户可在打印对话框取消）
    fallbackPrint(html);
    return true;
  }
}

/**
 * G12：导出图片（PNG 长图）
 *
 * 实现：
 * 1. 创建隐藏的临时 div（宽度 860px，与 EXPORT_CSS 的 max-width 一致）
 * 2. 渲染 markdown + 主题样式到 div
 * 3. 将所有 <img> 的 src 转为 dataURL（避免跨域/相对路径导致截图空白或报错）
 * 4. R2：将 data-math 占位替换为 KaTeX 渲染结果、pre.mermaid 替换为 SVG
 *    （html-to-image 不等异步脚本，必须在截图前同步完成替换）
 * 5. 等待图片加载完成 + 浏览器布局
 * 6. 调用 exportElementAsPng 截图
 * 7. 移除临时 div
 *
 * @param onProgress 渲染进度回调（R2：mermaid/公式逐个替换时上报）
 */
async function exportImage(
  md: string,
  title: string,
  filePath?: string | null,
  onProgress?: (text: string) => void,
): Promise<boolean> {
  const body = await renderMarkdownToHTML(md);
  const theme = useSettingsStore.getState().theme;
  const prismCss = getPrismCss(isDarkTheme(theme));

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

    // R2：公式与图表截图前渲染——KaTeX 同步替换；mermaid 异步逐个渲染并上报进度
    const mathCount = replaceMathPlaceholdersInDom(container);
    if (mathCount > 0) onProgress?.(`公式 ${mathCount} 个`);
    const mermaidBlocks = container.querySelectorAll("pre.mermaid").length;
    if (mermaidBlocks > 0) {
      await replaceMermaidBlocksInDom(container, {
        theme: mermaidThemeName(theme),
        onProgress: (done, total) => onProgress?.(`图表 ${done}/${total}`),
      });
    }

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
    // v0.11.0 B5-7：透传成功标志（false = 用户取消保存或导出失败）
    const ok = await exportElementAsPng(container, baseName, { filePath });
    return ok;
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
export async function convertImagesToDataUrlInHtml(html: string, docPath: string | null | undefined): Promise<string> {
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
