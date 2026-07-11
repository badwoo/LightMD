/**
 * LinkDialog —— 链接插入对话框
 *
 * 功能：
 * - 输入链接文本、URL，可选输入标题（对应 Markdown title 属性）
 * - 实时预览生成的 Markdown `[text](url "title")`
 * - 快捷键：Enter 插入，Esc 取消
 *
 * 输出格式：
 * - 有 title：`[text](url "title")`
 * - 无 title：`[text](url)`
 *
 * 当用户选中文本后调用对话框时，通过 initialText 预填选中文本。
 */
import { useState, useEffect, useMemo, useCallback } from "react";
import { useT } from "../../i18n";
import "./LinkDialog.css";

export interface LinkDialogProps {
  /** 是否显示对话框 */
  open: boolean;
  /** 插入回调，返回生成的 Markdown */
  onInsert: (markdown: string) => void;
  /** 关闭回调 */
  onClose: () => void;
  /** 预填的链接文本（如编辑器选中文本） */
  initialText?: string;
  /** 预填的 URL */
  initialUrl?: string;
}

/**
 * 生成链接 Markdown 字符串
 * - text 为空时使用 url 作为显示文本
 * - title 为空时输出 `[text](url)`，否则输出 `[text](url "title")`
 * - url 为空时返回空串，表示不可插入
 */
export function buildLinkMarkdown(text: string, url: string, title: string): string {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) return "";
  const displayText = text.trim() || trimmedUrl;
  const trimmedTitle = title.trim();
  // 转义 title 中的双引号，避免破坏 Markdown 语法
  const escapedTitle = trimmedTitle.replace(/"/g, '\\"');
  return trimmedTitle
    ? `[${displayText}](${trimmedUrl} "${escapedTitle}")`
    : `[${displayText}](${trimmedUrl})`;
}

export function LinkDialog({ open, onInsert, onClose, initialText = "", initialUrl = "" }: LinkDialogProps) {
  const [text, setText] = useState(initialText);
  const [url, setUrl] = useState(initialUrl);
  const [title, setTitle] = useState("");
  const t = useT();

  // 对话框打开时同步初始值（每次 open 由 false 变 true 时重置）
  useEffect(() => {
    if (open) {
      setText(initialText);
      setUrl(initialUrl);
      setTitle("");
    }
  }, [open, initialText, initialUrl]);

  // 实时预览
  const preview = useMemo(() => buildLinkMarkdown(text, url, title), [text, url, title]);

  const canInsert = url.trim().length > 0;

  const handleInsert = useCallback(() => {
    if (!canInsert) return;
    const md = buildLinkMarkdown(text, url, title);
    if (md) onInsert(md);
  }, [canInsert, text, url, title, onInsert]);

  // 全局快捷键：Esc 取消，Enter（无修饰键且非 textarea）插入
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // 避免在多行输入框中触发
        const target = e.target as HTMLElement;
        if (target?.tagName === "TEXTAREA") return;
        e.preventDefault();
        if (canInsert) handleInsert();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose, canInsert, handleInsert]);

  if (!open) return null;

  return (
    <div className="link-dialog-overlay" onClick={onClose}>
      <div className="link-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="link-dialog-header">
          <h3>{t("link.title")}</h3>
        </div>

        <div className="link-dialog-body">
          <div className="link-dialog-field">
            <label>{t("link.text")}</label>
            <input
              type="text"
              className="link-dialog-input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t("link.textPlaceholder")}
              autoFocus
            />
          </div>

          <div className="link-dialog-field">
            <label>{t("link.url")}</label>
            <input
              type="text"
              className="link-dialog-input"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com"
            />
          </div>

          <div className="link-dialog-field">
            <label>{t("link.titleField")}</label>
            <input
              type="text"
              className="link-dialog-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("link.titlePlaceholder")}
            />
          </div>

          <div className="link-dialog-preview">
            <div className="link-dialog-preview-label">{t("link.preview")}</div>
            <code className="link-dialog-preview-code">
              {preview || t("link.previewEmpty")}
            </code>
          </div>
        </div>

        <div className="link-dialog-footer">
          <button className="link-dialog-btn secondary" onClick={onClose}>
            {t("link.cancel")}
            <span className="link-dialog-kbd">Esc</span>
          </button>
          <button
            className="link-dialog-btn primary"
            onClick={handleInsert}
            disabled={!canInsert}
          >
            {t("link.insert")}
            <span className="link-dialog-kbd">Enter</span>
          </button>
        </div>
      </div>
    </div>
  );
}
