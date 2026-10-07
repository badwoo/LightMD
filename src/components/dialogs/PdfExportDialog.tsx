/**
 * PdfExportDialog —— PDF 导出排版选项对话框（G5）
 *
 * 提供：
 * - 页眉文本（含变量 {title}/{date}/{page}）
 * - 页脚文本（同上变量）
 * - 页码格式（无 / 底部居中 / 底部右）
 * - 边距（窄 / 正常 / 宽 / 自定义）
 * - 纸张大小（A4 / Letter / Legal）
 *
 * 用户点击"导出 PDF"后，通过 onConfirm 回调将选项传回 ExportDialog。
 */
import { useState } from "react";
import {
  DEFAULT_PDF_EXPORT_OPTIONS,
  type PdfExportOptions,
  type PageNumberFormat,
  type MarginPreset,
  type PaperSize,
} from "../../utils/pdfExport";
import { useT } from "../../i18n";
import "./PdfExportDialog.css";

interface PdfExportDialogProps {
  /** 关闭对话框 */
  onClose: () => void;
  /** 确认导出，传入用户配置的选项 */
  onConfirm: (options: PdfExportOptions) => void;
  /** 文档标题（用于 {title} 变量提示） */
  title: string;
}

export function PdfExportDialog({ onClose, onConfirm, title }: PdfExportDialogProps) {
  const [options, setOptions] = useState<PdfExportOptions>(DEFAULT_PDF_EXPORT_OPTIONS);
  const tt = useT();

  const updateOption = <K extends keyof PdfExportOptions>(
    key: K,
    value: PdfExportOptions[K],
  ) => {
    setOptions((prev) => ({ ...prev, [key]: value }));
  };

  const handleConfirm = () => {
    onConfirm(options);
    onClose();
  };

  return (
    <div className="pdf-export-overlay" onClick={onClose}>
      <div className="pdf-export-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="pdf-export-header">
          <h2>{tt("export.pdf.title")}</h2>
          <button className="pdf-export-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="pdf-export-body">
          {/* 文档标题预览（用于 {title} 变量） */}
          <div className="pdf-export-field">
            <label>{tt("export.pdf.docTitle")}</label>
            <input
              className="pdf-export-input"
              type="text"
              value={title}
              readOnly
            />
          </div>

          {/* 页眉文本 */}
          <div className="pdf-export-field">
            <label>{tt("export.pdf.header")}</label>
            <input
              className="pdf-export-input"
              type="text"
              value={options.headerText}
              placeholder="{title} — {date}"
              onChange={(e) => updateOption("headerText", e.target.value)}
            />
            <small className="pdf-export-hint">{tt("export.pdf.varsHint")}</small>
          </div>

          {/* 页脚文本 */}
          <div className="pdf-export-field">
            <label>{tt("export.pdf.footer")}</label>
            <input
              className="pdf-export-input"
              type="text"
              value={options.footerText}
              placeholder="{date} — 第 {page} 页"
              onChange={(e) => updateOption("footerText", e.target.value)}
            />
            <small className="pdf-export-hint">{tt("export.pdf.varsHint")}</small>
          </div>

          {/* v0.11.0 B2-2：页码格式选项已移除。
            缺陷背景（P1）：此前该下拉框可选「底部居中 / 底部右」等格式，但导出走
            Chromium --print-to-pdf，**不支持 CSS 分页上下文（margin box）**，
            `counter(page)` 规则被静默忽略 → 用户设置页码后导出结果里根本没有页码，
            属于「看似可选、实则无效」的欺骗性 UI。
            本次决策（用户拍板）：降级为「仅页脚、不含页码」，直接移除该选项。
            未来若改用 WebView2 PrintToPdf（支持 margin box）再恢复。 */}

          {/* 边距 */}
          <div className="pdf-export-field">
            <label>{tt("export.pdf.margin")}</label>
            <select
              className="pdf-export-select"
              value={options.margin}
              onChange={(e) =>
                updateOption("margin", e.target.value as MarginPreset)
              }
            >
              <option value="narrow">{tt("export.pdf.narrow")}</option>
              <option value="normal">{tt("export.pdf.normal")}</option>
              <option value="wide">{tt("export.pdf.wide")}</option>
              <option value="custom">{tt("export.pdf.custom")}</option>
            </select>
            {options.margin === "custom" && (
              <input
                className="pdf-export-input pdf-export-margin-input"
                type="number"
                min={0}
                max={50}
                value={options.customMarginMm}
                onChange={(e) =>
                  updateOption("customMarginMm", Number(e.target.value))
                }
              />
            )}
          </div>

          {/* 纸张大小 */}
          <div className="pdf-export-field">
            <label>{tt("export.pdf.paperSize")}</label>
            <select
              className="pdf-export-select"
              value={options.paperSize}
              onChange={(e) =>
                updateOption("paperSize", e.target.value as PaperSize)
              }
            >
              <option value="A4">A4</option>
              <option value="Letter">Letter</option>
              <option value="Legal">Legal</option>
            </select>
          </div>
        </div>

        <div className="pdf-export-footer">
          <button className="pdf-export-btn secondary" onClick={onClose}>
            {tt("export.cancel")}
          </button>
          <button
            className="pdf-export-btn primary"
            onClick={handleConfirm}
          >
            {tt("export.pdf.export")}
          </button>
        </div>
      </div>
    </div>
  );
}
