/**
 * v0.8.4 需求5+9（WP5）：新建文件弹框（替代原生 prompt()，WebView2 下 prompt 贴顶显示）
 *
 * 结构对齐 NewFolderDialog（居中 overlay），差异：
 * - 无目标多选 —— parentPath 由调用方传入且**只读展示**（让用户确认"落在哪个子文件夹"）；
 * - 默认名由调用方预填（经 makeUniqueName 避让重名）；
 * - P1 扩展名策略：输入不含有效扩展名（无 "." 或 "." 在开头）时确认自动补 ".md"，
 *   带扩展名（如 notes.txt）完全尊重；
 * - 重名校验：确认回调（调用方 createFile）抛错时在弹框内联显示。
 *
 * 设计：本组件只负责"收集与校验"，实际创建由调用方注入 onConfirm（可 reject 报错），
 * 可在 jsdom 下直接单测校验 / 扩展名策略 / 错误内联。
 */
import { useEffect, useState } from "react";
import { useT } from "../../i18n";

/** Windows 下非法的文件名字符（与 NewFolderDialog 同一套） */
export const ILLEGAL_FILE_CHARS = /[\\/:*?"<>|]/;

/**
 * 校验文件名（不含扩展名补全）。
 * @returns 出错时返回 i18n 键，通过时返回 null
 */
export function validateFileName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "newFile.nameRequired";
  if (ILLEGAL_FILE_CHARS.test(trimmed)) return "newFile.invalidName";
  return null;
}

/**
 * P1 扩展名策略：不含有效扩展名（"." 在开头如 .gitignore 不算扩展名分隔，
 * 与 makeUniqueName 的判定一致）→ 补 ".md"；带扩展名完全尊重。
 */
export function ensureMdExtension(name: string): string {
  const dotIdx = name.lastIndexOf(".");
  return dotIdx > 0 ? name : `${name}.md`;
}

export interface NewFileDialogProps {
  open: boolean;
  /** 创建目标目录（调用方传入，只读展示） */
  parentPath: string;
  /** 默认预填名（调用方已用 makeUniqueName 避让重名） */
  defaultName?: string;
  onClose: () => void;
  /** 确认创建：name 已补全扩展名；reject 时弹框内联显示错误并保持打开 */
  onConfirm: (name: string) => Promise<void>;
}

export function NewFileDialog({
  open,
  parentPath,
  defaultName = "",
  onClose,
  onConfirm,
}: NewFileDialogProps) {
  const t = useT();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null); // 存"最终显示文本"（校验错误已过 t()，运行时错误为原始信息）
  const [busy, setBusy] = useState(false);

  // 打开时重置表单并应用默认名
  useEffect(() => {
    if (!open) return;
    setName(defaultName);
    setError(null);
    setBusy(false);
  }, [open, defaultName]);

  if (!open) return null;

  const handleConfirm = async () => {
    const nameError = validateFileName(name);
    if (nameError) {
      setError(t(nameError));
      return;
    }
    setBusy(true);
    try {
      // P1：无有效扩展名自动补 .md，带扩展名尊重
      await onConfirm(ensureMdExtension(name.trim()));
    } catch (err) {
      // 重名（Rust create_file 报"文件已存在: ..."）在弹框内联显示；
      // 其他错误透出原始信息，弹框保持打开便于改名重试
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg.includes("已存在") || msg.toLowerCase().includes("exists") ? t("newFile.exists") : msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    // 视觉复用 newfolder 居中 overlay（同一 CSS 文件已随 NewFolderDialog 引入），
    // 附加 newfile-overlay 标识类供测试/样式钩子定位
    <div className="newfolder-overlay newfile-overlay" onClick={onClose}>
      <div className="newfolder-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="newfolder-header">
          <span>{t("newFile.title")}</span>
          <button className="newfolder-close" onClick={onClose} title={t("newFolder.cancel")}>
            ×
          </button>
        </div>
        <div className="newfolder-body">
          <div className="newfolder-field">
            <label htmlFor="newfile-name">{t("newFile.nameLabel")}</label>
            <input
              id="newfile-name"
              className="newfolder-input"
              value={name}
              autoFocus
              placeholder={t("filetree.newDocName")}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleConfirm();
                if (e.key === "Escape") onClose();
              }}
            />
          </div>

          {/* 目标目录只读展示：给用户"落在哪个子文件夹"的确认感（需求5） */}
          <div className="newfolder-field">
            <label>{t("newFile.target")}</label>
            <div className="newfolder-hint newfile-target" title={parentPath}>
              {parentPath}
            </div>
          </div>

          {error && <div className="newfolder-error">{error}</div>}
        </div>
        <div className="newfolder-footer">
          <button className="newfolder-btn secondary" onClick={onClose}>
            {t("newFolder.cancel")}
          </button>
          <button className="newfolder-btn primary" disabled={busy} onClick={handleConfirm}>
            {t("newFile.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
