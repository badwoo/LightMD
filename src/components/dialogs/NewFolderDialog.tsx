/**
 * v0.8.0 WP2 需求4(2)：新建文件夹弹框
 *
 * 相比旧的原生 prompt()，本弹框支持：
 * - 输入文件夹名（必填 + 非法字符校验）
 * - 勾选目标文件夹（当前已打开的文件夹，支持单选/多选）
 * - 自定义保存路径（与勾选互斥：填了自定义路径则其优先，勾选区置灰）
 *
 * 设计：本组件只负责"收集与校验"，实际创建（createDir）由调用方注入 onConfirm 处理，
 * 因此可在 jsdom 下直接单测校验与目标解析逻辑。
 */
import { useLayoutEffect, useMemo, useState } from "react";
import { useT } from "../../i18n";
import "./NewFolderDialog.css";

/** Windows 下非法的文件名字符 */
export const ILLEGAL_FOLDER_CHARS = /[\\/:*?"<>|]/;

/**
 * 校验文件夹名。
 * @returns 出错时返回 i18n 键，通过时返回 null
 */
export function validateFolderName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "newFolder.nameRequired";
  if (ILLEGAL_FOLDER_CHARS.test(trimmed)) return "newFolder.invalidName";
  return null;
}

/**
 * 解析最终要创建的目标目录（父目录列表）。
 * 自定义路径优先；都为空时返回空数组（由调用方提示"至少选一个"）。
 */
export function resolveTargetDirs(selected: string[], customPath: string): string[] {
  const custom = customPath.trim();
  if (custom) return [custom];
  return selected.filter((p) => !!p);
}

export interface NewFolderDialogProps {
  open: boolean;
  /** 可选的目标文件夹（当前已打开的文件夹） */
  openFolders: { path: string; name: string }[];
  /** 从某个具体文件夹入口打开时的预选项 */
  preselected?: string | null;
  /** 浏览自定义路径（由调用方注入，避免本组件依赖 Tauri） */
  onBrowse?: () => Promise<string | null>;
  onClose: () => void;
  /** 确认创建：targetDirs 为父目录列表 */
  onConfirm: (targetDirs: string[], folderName: string) => void | Promise<void>;
}

export function NewFolderDialog({
  open,
  openFolders,
  preselected,
  onBrowse,
  onClose,
  onConfirm,
}: NewFolderDialogProps) {
  const t = useT();
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [customPath, setCustomPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const customActive = customPath.trim().length > 0;

  // 打开时重置表单并应用预选（只有一个文件夹时默认勾选它）
  // v0.8.5 反馈（第二版）：改用 useLayoutEffect —— 重置在浏览器绘制前完成，
  // 避免"弹窗已经画出来、打开动画跑到一半又改一次勾选/输入态"造成的闪烁
  useLayoutEffect(() => {
    if (!open) return;
    setName("");
    setCustomPath("");
    setError(null);
    setBusy(false);
    if (preselected) {
      setSelected([preselected]);
    } else if (openFolders.length === 1) {
      setSelected([openFolders[0]!.path]);
    } else {
      setSelected([]);
    }
  }, [open, preselected, openFolders]);

  const targets = useMemo(
    () => resolveTargetDirs(selected, customPath),
    [selected, customPath],
  );

  if (!open) return null;

  const toggleFolder = (path: string) => {
    setSelected((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path],
    );
    setError(null);
  };

  const handleBrowse = async () => {
    if (!onBrowse) return;
    const picked = await onBrowse();
    if (picked) {
      setCustomPath(picked);
      setError(null);
    }
  };

  const handleConfirm = async () => {
    const nameError = validateFolderName(name);
    if (nameError) {
      setError(nameError);
      return;
    }
    if (targets.length === 0) {
      setError("newFolder.needTarget");
      return;
    }
    setBusy(true);
    try {
      await onConfirm(targets, name.trim());
    } finally {
      setBusy(false);
    }
  };

  return (
    // v0.8.5 需求6：打开过渡动画（overlay 淡入 + 本体 pop-in），条件渲染挂载即自动播放
    <div className="newfolder-overlay dialog-overlay-in" onClick={onClose}>
      <div className="newfolder-dialog dialog-pop-in" onClick={(e) => e.stopPropagation()}>
        <div className="newfolder-header">
          <span>{t("newFolder.title")}</span>
          <button className="newfolder-close" onClick={onClose} title={t("newFolder.cancel")}>
            ×
          </button>
        </div>
        <div className="newfolder-body">
          <div className="newfolder-field">
            <label htmlFor="newfolder-name">{t("newFolder.nameLabel")}</label>
            <input
              id="newfolder-name"
              className="newfolder-input"
              value={name}
              autoFocus
              placeholder={t("filetree.newFolderDefault")}
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

          <div className="newfolder-field">
            <label>{t("newFolder.targetLabel")}</label>
            <div className={`newfolder-targets ${customActive ? "disabled" : ""}`}>
              {openFolders.length === 0 ? (
                <div className="newfolder-empty">{t("newFolder.noOpenFolder")}</div>
              ) : (
                openFolders.map((folder) => (
                  <label key={folder.path} className="newfolder-target-item" title={folder.path}>
                    <input
                      type="checkbox"
                      disabled={customActive}
                      checked={selected.includes(folder.path)}
                      onChange={() => toggleFolder(folder.path)}
                    />
                    <span>{folder.name}</span>
                  </label>
                ))
              )}
            </div>
          </div>

          <div className="newfolder-field">
            <label htmlFor="newfolder-path">{t("newFolder.customPathLabel")}</label>
            <div className="newfolder-path-row">
              <input
                id="newfolder-path"
                className="newfolder-input"
                value={customPath}
                onChange={(e) => {
                  setCustomPath(e.target.value);
                  setError(null);
                }}
              />
              {onBrowse && (
                <button className="newfolder-browse" onClick={handleBrowse}>
                  {t("newFolder.browse")}
                </button>
              )}
            </div>
            <div className="newfolder-hint">{t("newFolder.customPathHint")}</div>
          </div>

          {error && <div className="newfolder-error">{t(error)}</div>}
        </div>
        <div className="newfolder-footer">
          <button className="newfolder-btn secondary" onClick={onClose}>
            {t("newFolder.cancel")}
          </button>
          <button className="newfolder-btn primary" disabled={busy} onClick={handleConfirm}>
            {t("newFolder.create")}
          </button>
        </div>
      </div>
    </div>
  );
}
