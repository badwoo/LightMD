import { useEffect, useRef, useState } from "react";
import { useEditorStore } from "../../stores/useEditorStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useT } from "../../i18n";
// v0.6.1：全文翻译进度（状态栏显示 + 取消）
import { useFullTranslateStore } from "../../stores/fullTranslateStore";
import { translateService } from "../../services/translateService";
import { translateErrorKey } from "../editor/TranslateBubble";
import "./StatusBar.css";

export function StatusBar() {
  const t = useT();
  const isDirty = useEditorStore((s) => s.isDirty);
  const cursorLine = useEditorStore((s) => s.cursorLine);
  const wordCount = useEditorStore((s) => s.wordCount);
  const filePath = useEditorStore((s) => s.filePath);
  const focusMode = useEditorStore((s) => s.focusMode);
  const toggleFocusMode = useEditorStore((s) => s.toggleFocusMode);
  const typewriterMode = useSettingsStore((s) => s.typewriterMode);
  const toggleTypewriter = useSettingsStore((s) => s.toggleTypewriter);
  const setShowSearch = useEditorStore((s) => s.setShowSearch);
  // 问题5：底部栏搜索按钮切换开关（已开启则关闭）
  const showSearch = useEditorStore((s) => s.showSearch);
  const toggleSearch = useEditorStore((s) => s.toggleSearch);
  // v0.6.1：全文翻译进度状态
  const ftStatus = useFullTranslateStore((s) => s.status);
  const ftDone = useFullTranslateStore((s) => s.doneCount);
  const ftTotal = useFullTranslateStore((s) => s.totalCount);
  const ftErrorCode = useFullTranslateStore((s) => s.errorCode);
  const ftRequestCancel = useFullTranslateStore((s) => s.requestCancel);
  const ftReset = useFullTranslateStore((s) => s.reset);

  // G11：字数详情面板展开状态
  const [showDetail, setShowDetail] = useState(false);
  const wordWrapRef = useRef<HTMLDivElement>(null);

  // v0.6.4：翻译完成态 2 秒后自动消失（取消/切换文档走 reset，同样离开 done 态）
  useEffect(() => {
    if (ftStatus !== "done") return;
    const timer = setTimeout(() => ftReset(), 2000);
    return () => clearTimeout(timer);
  }, [ftStatus, ftReset]);

  const fileName = filePath
    ? filePath.replace(/\\/g, "/").split("/").pop() || t("statusbar.untitled")
    : t("statusbar.untitled");

  // 点击外部关闭详情面板（监听 mousedown，与下拉菜单关闭逻辑一致）
  useEffect(() => {
    if (!showDetail) return;
    const handle = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (wordWrapRef.current && !wordWrapRef.current.contains(target)) {
        setShowDetail(false);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [showDetail]);

  return (
    <div className="statusbar">
      <span className="statusbar-item">
        {fileName}
        {isDirty && <span className="statusbar-dirty"> ●</span>}
      </span>
      <span className="statusbar-item statusbar-center">
        {/* v0.6.1：全文翻译进度；v0.6.4：完成态显示"翻译完成 ✓"2 秒自动消失，
            段级失败不在底部栏显示（编辑器内气泡逐段提示），仅系统性错误保留提示 */}
        {ftStatus === "running" && (
          <span className="statusbar-ft-progress">
            <span className="statusbar-ft-spinner" aria-hidden="true" />
            {t("translate.full.progress", { done: ftDone, total: ftTotal })}
            <button
              type="button"
              className="statusbar-ft-cancel"
              title={t("translate.full.cancel")}
              onClick={() => {
                ftRequestCancel();
                translateService.cancel().catch(() => undefined);
              }}
            >
              ✕
            </button>
          </span>
        )}
        {ftStatus === "done" && (
          <span className="statusbar-ft-progress statusbar-ft-done" data-testid="statusbar-ft-done">
            {t("translate.full.done")}
            <span className="statusbar-ft-check" aria-hidden="true">✓</span>
          </span>
        )}
        {ftStatus === "error" && ftErrorCode && (
          <span className="statusbar-ft-progress statusbar-ft-error">
            {t(translateErrorKey(ftErrorCode))}
            <button
              type="button"
              className="statusbar-ft-cancel"
              title={t("translate.full.dismiss")}
              onClick={ftReset}
            >
              ✕
            </button>
          </span>
        )}
        {/* 搜索入口：放大镜图标 + "搜索"文字，点击切换开关 */}
        <button
          className={`statusbar-toggle ${showSearch ? "active" : ""}`}
          title={t("search.placeholder")}
          onClick={toggleSearch}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="7" cy="7" r="5" />
            <line x1="10.5" y1="10.5" x2="14" y2="14" stroke-linecap="round" />
          </svg>
          {t("search.placeholder")}
        </button>
        {/* 专注模式：靶心图标 + "专注模式（F8）"文字 */}
        <button
          className={`statusbar-toggle ${focusMode ? "active" : ""}`}
          title={t("statusbar.focusModeTitle")}
          onClick={toggleFocusMode}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            {/* 靶心：同心圆 */}
            <circle cx="8" cy="8" r="6" />
            <circle cx="8" cy="8" r="4" />
            <circle cx="8" cy="8" r="2" />
            {/* 中心命中点 */}
            <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
          </svg>
          {t("statusbar.focusMode")}
        </button>
        {/* 打字机模式（问题4：文字改为"打字机（F9）"） */}
        <button
          className={`statusbar-toggle ${typewriterMode ? "active" : ""}`}
          title={t("statusbar.typewriterTitle")}
          onClick={toggleTypewriter}
        >
          {t("statusbar.typewriter")}
        </button>
      </span>
      <span className="statusbar-item">
        {wordCount.words > 0 && (
          <div className="statusbar-word-wrap" ref={wordWrapRef}>
            <span
              className="statusbar-word-trigger"
              title={t("statusbar.words")}
              onClick={() => setShowDetail((v) => !v)}
            >
              {wordCount.words} {t("statusbar.words")}
            </span>
            {/* G11：字数详情面板（向上弹出） */}
            {showDetail && (
              <div className="statusbar-detail-popover" role="dialog">
                <div className="statusbar-detail-row">
                  <span className="statusbar-detail-label">{t("statusbar.words")}</span>
                  <span className="statusbar-detail-value">{wordCount.words}</span>
                </div>
                <div className="statusbar-detail-row">
                  <span className="statusbar-detail-label">{t("statusbar.chars")}</span>
                  <span className="statusbar-detail-value">{wordCount.chars}</span>
                </div>
                <div className="statusbar-detail-row">
                  <span className="statusbar-detail-label">{t("statusbar.charsNoSpaces")}</span>
                  <span className="statusbar-detail-value">{wordCount.charsNoSpaces}</span>
                </div>
                <div className="statusbar-detail-row">
                  <span className="statusbar-detail-label">{t("statusbar.lines")}</span>
                  <span className="statusbar-detail-value">{wordCount.lines}</span>
                </div>
                <div className="statusbar-detail-row">
                  <span className="statusbar-detail-label">{t("statusbar.paragraphs")}</span>
                  <span className="statusbar-detail-value">{wordCount.paragraphs}</span>
                </div>
                <div className="statusbar-detail-row">
                  <span className="statusbar-detail-label">{t("statusbar.readingTime")}</span>
                  <span className="statusbar-detail-value">{wordCount.readingTimeMin} {t("statusbar.minutes")}</span>
                </div>
              </div>
            )}
          </div>
        )}
        {cursorLine > 0 && <span>{t("statusbar.line", { line: cursorLine })}</span>}
      </span>
    </div>
  );
}
