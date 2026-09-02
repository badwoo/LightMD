/**
 * TranslateUndoToast —— "取消翻译"浮动气泡（v0.6.1 问题2）
 *
 * 行为：
 * - 翻译回写（直接替换/双语对照）成功后出现，点击恢复原文
 * - 固定悬浮于编辑区域右上角（全文翻译按钮下方），不随文档滚动
 * - 样式复用 full-translate-btn 的变量体系，自动适配 6 主题
 */
import { useT } from "../../i18n";
import { useEditorStore } from "../../stores/useEditorStore";
import "./FullTranslateButton.css";

interface TranslateUndoToastProps {
  /** 恢复原文（取消翻译） */
  onUndo: () => void;
}

export function TranslateUndoToast({ onUndo }: TranslateUndoToastProps) {
  const t = useT();
  const snapshot = useEditorStore((s) => s.translateUndoSnapshot);
  if (snapshot === null) return null;

  return (
    <button
      type="button"
      className="translate-undo-toast"
      title={t("translate.undo.tip")}
      onClick={onUndo}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {/* 逆时针撤销箭头 */}
        <path d="M3 7v6h6" />
        <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
      </svg>
      {t("translate.undo.label")}
    </button>
  );
}
