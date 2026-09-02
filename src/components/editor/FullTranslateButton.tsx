/**
 * FullTranslateButton —— 全文翻译悬浮按钮（v0.6.1 改版）
 *
 * 行为：
 * - 固定悬浮于阅读区域右上角（不随文档滚动）
 * - v0.6.1 问题5：图标改为「译」字气泡（翻译语义更直观），
 *   阅读与分屏模式均显示（两个模式都支持全文翻译）
 * - hover 显示"全文翻译"tooltip（含 Shift+F6 快捷键提示）
 * - 翻译进行中显示 spinner 态（禁用重复触发），点击可取消
 * - 样式全部使用 CSS 变量，自动适配 6 主题
 */
import { useT } from "../../i18n";
import { useFullTranslateStore } from "../../stores/fullTranslateStore";
import "./FullTranslateButton.css";

interface FullTranslateButtonProps {
  /** 触发全文翻译（运行中调用表示取消） */
  onStart: () => void;
}

export function FullTranslateButton({ onStart }: FullTranslateButtonProps) {
  const t = useT();
  const status = useFullTranslateStore((s) => s.status);
  const doneCount = useFullTranslateStore((s) => s.doneCount);
  const totalCount = useFullTranslateStore((s) => s.totalCount);
  const running = status === "running";

  return (
    <button
      type="button"
      className={`full-translate-btn${running ? " running" : ""}`}
      title={running ? t("translate.full.runningTip") : t("translate.full.title")}
      aria-label={t("translate.full.title")}
      onClick={onStart}
    >
      {/* 「译」字气泡：与 PM 选区触发按钮同款图形（v0.6.1 问题5） */}
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor">
        <path d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9l-4.2 3.5c-.5.4-1.3.1-1.3-.6V17H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
        <text x="12" y="13.5" textAnchor="middle" fontSize="10" fontWeight="600" fill="var(--bg-primary)">译</text>
      </svg>
      {running && (
        <span className="full-translate-progress">
          {doneCount}/{totalCount}
        </span>
      )}
    </button>
  );
}
