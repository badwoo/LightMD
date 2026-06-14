/**
 * ExportDialog —— 导出设置对话框
 */
import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { isTauri, fileService } from "../../services/fileService";
import { notifySuccess, notifyError } from "../../services/notificationService";
import "./ExportDialog.css";

interface ExportDialogProps {
  onClose: () => void;
  markdown: string;
  title: string;
  filePath?: string | null;
}

export function ExportDialog({ onClose, markdown, title, filePath }: ExportDialogProps) {
  const [format, setFormat] = useState<"html" | "pdf">(
    useSettingsStore.getState().defaultExportFormat
  );
  const [includeCSS, setIncludeCSS] = useState(true);
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    setExporting(true);
    try {
      if (format === "html") {
        await exportHTML(markdown, title, includeCSS, filePath);
      } else {
        await exportPDF(markdown, title, includeCSS, filePath);
      }
    } catch (err) {
      console.error("导出失败:", err);
      notifyError(`导出失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExporting(false);
      onClose();
    }
  };

  return (
    <div className="export-overlay" onClick={onClose}>
      <div className="export-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="export-header">
          <h2>导出文档</h2>
          <button className="export-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="export-body">
          <div className="export-field">
            <label>文件名</label>
            <input
              className="export-input"
              type="text"
              value={title}
              readOnly
            />
          </div>

          <div className="export-field">
            <label>导出格式</label>
            <div className="export-format-group">
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
            </div>
          </div>

          <div className="export-field">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={includeCSS}
                onChange={(e) => setIncludeCSS(e.target.checked)}
              />
              <span>包含样式（推荐）</span>
            </label>
          </div>

          {format === "pdf" && (
            <div className="export-info">
              PDF 导出将使用 Edge/Chrome 浏览器引擎生成，文件将直接保存到指定路径。
            </div>
          )}
        </div>

        <div className="export-footer">
          <button className="export-btn secondary" onClick={onClose}>
            取消
          </button>
          <button
            className="export-btn primary"
            onClick={handleExport}
            disabled={exporting}
          >
            {exporting ? "导出中..." : `导出 ${format.toUpperCase()}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── 导出实现 ──────────────────────────────────────────

const EXPORT_CSS = `
/* LightMD 导出样式 */
body {
  font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", -apple-system, BlinkMacSystemFont, sans-serif;
  font-size: 16px;
  line-height: 1.8;
  color: #1a1a1a;
  max-width: 860px;
  margin: 40px auto;
  padding: 0 20px;
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
  const MarkdownIt = (await import("markdown-it")).default;
  const mdParser = new MarkdownIt({ html: true, linkify: true, typographer: true });
  // 启用任务列表插件
  const { taskListPlugin } = await import("../../core/markdown/task-list-plugin");
  mdParser.use(taskListPlugin);
  // 启用 KaTeX 数学公式插件
  const { mathPlugin } = await import("../../core/markdown/katex-plugin");
  mdParser.use(mathPlugin);
  const html = mdParser.render(md);
  // 将 mermaid 代码块包装为可渲染的容器
  let result = html.replace(
    /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
    '<pre class="mermaid">$1</pre>'
  );
  // 将 markdown-it katex 插件生成的公式标记保留（导出时用 KaTeX 渲染）
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
  const styles = includeCSS ? `<style>${EXPORT_CSS}</style>` : "";
  // 检测是否包含 mermaid 图表，注入 mermaid 脚本
  const hasMermaid = body.includes('class="mermaid"');
  // 检测是否包含数学公式，注入 KaTeX 脚本
  const hasMath = body.includes('data-math="inline"') || body.includes('data-math="block"');
  const mermaidScript = hasMermaid
    ? '<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>' +
      '<script>mermaid.initialize({startOnLoad:true,theme:"default",securityLevel:"loose"});</script>'
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
        notifySuccess(`已导出 HTML: ${selected}`);
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

async function exportPDF(md: string, title: string, includeCSS: boolean, filePath?: string | null) {
  const body = await renderMarkdownToHTML(md);
  const styles = includeCSS ? `<style>${EXPORT_CSS}</style>` : "";
  // 检测是否包含 mermaid 图表，注入 mermaid 脚本
  const hasMermaid = body.includes('class="mermaid"');
  // 检测是否包含数学公式，注入 KaTeX 脚本
  const hasMath = body.includes('data-math="inline"') || body.includes('data-math="block"');
  const mermaidScript = hasMermaid
    ? '<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>' +
      '<script>mermaid.initialize({startOnLoad:true,theme:"default",securityLevel:"loose"});</script>'
    : "";
  const katexScript = hasMath
    ? '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.17/dist/katex.min.css">' +
      '<script src="https://cdn.jsdelivr.net/npm/katex@0.17/dist/katex.min.js"></script>' +
      '<script>document.querySelectorAll("[data-math=inline]").forEach(function(e){var l=e.getAttribute("data-latex");l&&katex.render(l,e,{throwOnError:false,displayMode:false})});document.querySelectorAll("[data-math=block]").forEach(function(e){var l=e.getAttribute("data-latex");l&&katex.render(l,e,{throwOnError:false,displayMode:true})});</script>'
    : "";
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>${escapeHtml(title)}</title>${styles}${mermaidScript}${katexScript}</head>
<body>${body}</body>
</html>`;

  const baseName = title.replace(/\.md$/i, "");
  const defaultDir = getDefaultDir(filePath);

  if (isTauri()) {
    try {
      // 弹出保存对话框选择 PDF 保存路径
      const selected = await save({
        defaultPath: defaultDir ? `${defaultDir}/${baseName}.pdf` : `${baseName}.pdf`,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (selected) {
        // 调用 Rust 后端命令导出 PDF
        await invoke("export_html_to_pdf", {
          htmlContent: html,
          pdfPath: selected,
        });
        notifySuccess(`已导出 PDF: ${selected}`);
      }
    } catch (err) {
      console.error("PDF 导出失败:", err);
      notifyError(`PDF 导出失败: ${err instanceof Error ? err.message : String(err)}`);
      // 回退到浏览器打印
      fallbackPrint(html);
    }
  } else {
    // 浏览器模式：使用打印功能
    fallbackPrint(html);
  }
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
    notifyError("无法打开打印窗口，请检查浏览器是否拦截了弹窗。");
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
