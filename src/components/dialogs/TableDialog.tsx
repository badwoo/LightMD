/**
 * TableDialog —— 表格插入对话框
 *
 * 功能：
 * - 数字输入：行数（1-20）、列数（1-10）
 * - 可选：是否包含表头行（默认勾选）
 * - 实时预览生成的 Markdown 表格
 * - 快捷键：Enter 插入，Esc 取消
 *
 * 输出示例（2 行 3 列，含表头）：
 *   | 列1 | 列2 | 列3 |
 *   |------|------|------|
 *   | 内容 | 内容 | 内容 |
 */
import { useState, useEffect, useMemo, useCallback } from "react";
import { useT } from "../../i18n";
import "./TableDialog.css";

export interface TableDialogProps {
  /** 是否显示对话框 */
  open: boolean;
  /** 插入回调，返回生成的 Markdown */
  onInsert: (markdown: string) => void;
  /** 关闭回调 */
  onClose: () => void;
}

/** 表格行/列取值范围常量 */
const MIN_ROWS = 1;
const MAX_ROWS = 20;
const MIN_COLS = 1;
const MAX_COLS = 10;

/** 默认表头单元格内容前缀，例如"列1" */
const HEADER_PREFIX = "列";
/** 默认数据单元格内容 */
const CELL_PLACEHOLDER = "内容";
/** 分隔行单元格（Markdown 表格必需） */
const SEPARATOR = "------";

/** 限制数字在 [min, max] 区间 */
function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * 生成 Markdown 表格字符串
 *
 * @param rows 总行数（含表头）
 * @param cols 列数
 * @param withHeader 是否将第一行作为表头（true 时表头单元格显示"列N"，false 时表头单元格显示"内容"）
 * @returns Markdown 表格文本
 */
export function buildTableMarkdown(rows: number, cols: number, withHeader: boolean): string {
  const r = clamp(rows, MIN_ROWS, MAX_ROWS);
  const c = clamp(cols, MIN_COLS, MAX_COLS);
  if (r <= 0 || c <= 0) return "";

  const headerCells: string[] = [];
  for (let i = 0; i < c; i++) {
    headerCells.push(withHeader ? `${HEADER_PREFIX}${i + 1}` : CELL_PLACEHOLDER);
  }

  const separatorCells: string[] = Array.from({ length: c }, () => SEPARATOR);

  // 数据行数：表头行始终占 1 行（Markdown 表格语法必需），数据行 = rows - 1
  // withHeader 仅决定表头单元格显示"列N"还是"内容"
  const dataRowCount = Math.max(0, r - 1);
  const dataCells: string[] = Array.from({ length: c }, () => CELL_PLACEHOLDER);

  const lines: string[] = [];
  // 表头行与数据行单元格之间用 " | " 分隔
  lines.push(`| ${headerCells.join(" | ")} |`);
  // 分隔行不加空格，符合 Markdown 标准格式 |---|---|
  lines.push(`|${separatorCells.join("|")}|`);
  for (let i = 0; i < dataRowCount; i++) {
    lines.push(`| ${dataCells.join(" | ")} |`);
  }
  return lines.join("\n");
}

export function TableDialog({ open, onInsert, onClose }: TableDialogProps) {
  const [rows, setRows] = useState(3);
  const [cols, setCols] = useState(3);
  const [withHeader, setWithHeader] = useState(true);
  const t = useT();

  // 对话框打开时重置为默认值
  useEffect(() => {
    if (open) {
      setRows(3);
      setCols(3);
      setWithHeader(true);
    }
  }, [open]);

  const preview = useMemo(
    () => buildTableMarkdown(rows, cols, withHeader),
    [rows, cols, withHeader]
  );

  const handleInsert = useCallback(() => {
    const md = buildTableMarkdown(rows, cols, withHeader);
    if (md) onInsert(md);
  }, [rows, cols, withHeader, onInsert]);

  // 全局快捷键：Esc 取消，Enter（无修饰键且非 textarea）插入
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const target = e.target as HTMLElement;
        if (target?.tagName === "TEXTAREA") return;
        e.preventDefault();
        handleInsert();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose, handleInsert]);

  if (!open) return null;

  return (
    <div className="table-dialog-overlay" onClick={onClose}>
      <div className="table-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="table-dialog-header">
          <h3>{t("table.title")}</h3>
        </div>

        <div className="table-dialog-body">
          <div className="table-dialog-row">
            <div className="table-dialog-field">
              <label>{t("table.rows")}</label>
              <input
                type="number"
                className="table-dialog-number"
                min={MIN_ROWS}
                max={MAX_ROWS}
                value={rows}
                onChange={(e) => setRows(clamp(Number(e.target.value), MIN_ROWS, MAX_ROWS))}
                autoFocus
              />
              <span className="table-dialog-hint">{MIN_ROWS}-{MAX_ROWS}</span>
            </div>
            <div className="table-dialog-field">
              <label>{t("table.cols")}</label>
              <input
                type="number"
                className="table-dialog-number"
                min={MIN_COLS}
                max={MAX_COLS}
                value={cols}
                onChange={(e) => setCols(clamp(Number(e.target.value), MIN_COLS, MAX_COLS))}
              />
              <span className="table-dialog-hint">{MIN_COLS}-{MAX_COLS}</span>
            </div>
          </div>

          <div className="table-dialog-field">
            <label className="table-dialog-checkbox">
              <input
                type="checkbox"
                checked={withHeader}
                onChange={(e) => setWithHeader(e.target.checked)}
              />
              <span>{t("table.includeHeader")}</span>
            </label>
          </div>

          <div className="table-dialog-preview">
            <div className="table-dialog-preview-label">{t("table.preview")}</div>
            <pre className="table-dialog-preview-code">{preview}</pre>
          </div>
        </div>

        <div className="table-dialog-footer">
          <button className="table-dialog-btn secondary" onClick={onClose}>
            {t("table.cancel")}
            <span className="table-dialog-kbd">Esc</span>
          </button>
          <button className="table-dialog-btn primary" onClick={handleInsert}>
            {t("table.insert")}
            <span className="table-dialog-kbd">Enter</span>
          </button>
        </div>
      </div>
    </div>
  );
}
