/**
 * ModeSwitchButton —— 模式切换悬浮按钮（v0.6.1 问题5）
 *
 * 行为：
 * - 阅读模式：显示羽毛笔（书写语义），点击切换到分屏模式
 * - 分屏模式：显示小书本（阅读语义），点击切回阅读模式
 * - 与「译」按钮并排悬浮于编辑区域右上角，不随文档滚动
 * - 样式复用 full-translate-btn 的变量体系，自动适配 6 主题
 */
import { useT } from "../../i18n";
import type { ViewMode } from "../../stores/useEditorStore";
import "./FullTranslateButton.css";

interface ModeSwitchButtonProps {
  /** 当前视图模式（仅 preview/split 时由父组件渲染本按钮） */
  viewMode: ViewMode;
  /** 模式切换：阅读→分屏 / 分屏→阅读 */
  onSwitch: (mode: "preview" | "split") => void;
}

export function ModeSwitchButton({ viewMode, onSwitch }: ModeSwitchButtonProps) {
  const t = useT();
  const isSplit = viewMode === "split";

  return (
    <button
      type="button"
      className="mode-switch-btn"
      title={isSplit ? t("mode.switch.toPreview") : t("mode.switch.toSplit")}
      aria-label={isSplit ? t("mode.switch.toPreview") : t("mode.switch.toSplit")}
      onClick={() => onSwitch(isSplit ? "preview" : "split")}
    >
      {isSplit ? (
        /* 分屏模式：小书本（点击回阅读模式） */
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 7c-2.2-1.6-5-2.2-9-2.2v13.5c4 0 6.8.6 9 2.2 2.2-1.6 5-2.2 9-2.2V4.8c-4 0-6.8.6-9 2.2z" />
          <line x1="12" y1="7" x2="12" y2="20.5" />
        </svg>
      ) : (
        /* 阅读模式：羽毛笔（点击进分屏模式） */
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20.5 3.5a2.1 2.1 0 0 0-3 0L8 13l-1.5 4.5L11 16l9.5-9.5a2.1 2.1 0 0 0 0-3z" />
          <path d="M15 6.5l2.5 2.5" />
          <path d="M4 21h16" />
        </svg>
      )}
    </button>
  );
}
