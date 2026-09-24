/**
 * v0.8.1 需求3：文件属性对话框
 *
 * 背景：旧实现用原生 `alert()` 展示属性 —— WebView2 的系统级模态会播放
 * Windows 系统提示音（用户感知为"报警声"），且外观与应用风格割裂。
 * 本组件改为应用内模态：无声音、风格统一、路径可选中复制。
 *
 * 职责边界：只做展示（接收已格式化的数据），数据组装由调用方负责。
 */
import { useEffect } from "react";
import { useT } from "../../i18n";
import "./FilePropertiesDialog.css";

export interface FilePropertiesData {
  name: string;
  path: string;
  /** 所在目录 */
  dir: string;
  /** 扩展名（不含点）；空串表示未知类型 */
  ext: string;
  /** 已格式化的大小文本；空串表示不展示大小行 */
  sizeText: string;
}

export interface FilePropertiesDialogProps {
  /** null 表示不展示 */
  file: FilePropertiesData | null;
  onClose: () => void;
}

/** 组装展示行（导出供单测直接断言，无需渲染） */
export function buildPropertyRows(
  file: FilePropertiesData,
  t: (key: string, params?: Record<string, string | number>) => string,
): { label: string; value: string }[] {
  const rows = [
    { label: t("fileprops.name"), value: file.name },
    { label: t("fileprops.path"), value: file.path },
    { label: t("fileprops.dir"), value: file.dir },
    {
      label: t("fileprops.type"),
      value: file.ext ? `.${file.ext}` : t("filetree.propUnknownType"),
    },
  ];
  if (file.sizeText) {
    rows.push({ label: t("fileprops.size"), value: file.sizeText });
  }
  return rows;
}

export function FilePropertiesDialog({ file, onClose }: FilePropertiesDialogProps) {
  const t = useT();

  // Esc 关闭（仅在有内容时挂监听）
  useEffect(() => {
    if (!file) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [file, onClose]);

  if (!file) return null;

  const rows = buildPropertyRows(file, t);

  return (
    <div className="fileprops-overlay" onClick={onClose} data-testid="file-properties-dialog">
      <div
        className="fileprops-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("fileprops.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="fileprops-header">
          <span>{t("fileprops.title")}</span>
          <button
            className="fileprops-close"
            title={t("fileprops.close")}
            data-testid="file-properties-close"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="fileprops-body">
          {rows.map((row) => (
            <div className="fileprops-row" key={row.label}>
              <span className="fileprops-label">{row.label}</span>
              <span className="fileprops-value" title={row.value}>
                {row.value}
              </span>
            </div>
          ))}
        </div>
        <div className="fileprops-footer">
          <button className="fileprops-btn" onClick={onClose}>
            {t("fileprops.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
