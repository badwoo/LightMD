/**
 * TranslateUndoToast —— "取消翻译"浮动气泡（v0.6.1 问题2）
 *
 * 行为：
 * - 翻译回写（直接替换/双语对照）成功后出现，点击恢复原文
 * - 固定悬浮于编辑区域右上角（全文翻译按钮下方），不随文档滚动
 * - 样式复用 full-translate-btn 的变量体系，自动适配 6 主题
 */
import { useT } from "../../i18n";
import { useEditorStore, isTranslateSnapshotForFile } from "../../stores/useEditorStore";
import "./FullTranslateButton.css";

interface TranslateUndoToastProps {
  /** 恢复原文（取消翻译） */
  onUndo: () => void;
}

export function TranslateUndoToast({ onUndo }: TranslateUndoToastProps) {
  const t = useT();
  const snapshot = useEditorStore((s) => s.translateUndoSnapshot);
  // v0.7.4 问题4：快照按 filePath 归属过滤（与 undoTranslation 恢复判定共用同一规则）——
  // 切换文档时快照被保留，仅在当前激活文档与快照所属文档一致时才渲染，
  // 避免 A 文档的气泡在切换到 B 文档时误显示。
  const currentFilePath = useEditorStore((s) => s.filePath);
  if (!isTranslateSnapshotForFile(snapshot, currentFilePath)) return null;

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
