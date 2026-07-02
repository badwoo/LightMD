import { useEditorStore } from "../../stores/useEditorStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import "./StatusBar.css";

export function StatusBar() {
  const isDirty = useEditorStore((s) => s.isDirty);
  const cursorLine = useEditorStore((s) => s.cursorLine);
  const wordCount = useEditorStore((s) => s.wordCount);
  const filePath = useEditorStore((s) => s.filePath);
  const focusMode = useEditorStore((s) => s.focusMode);
  const toggleFocusMode = useEditorStore((s) => s.toggleFocusMode);
  const typewriterMode = useSettingsStore((s) => s.typewriterMode);
  const toggleTypewriter = useSettingsStore((s) => s.toggleTypewriter);

  const fileName = filePath
    ? filePath.replace(/\\/g, "/").split("/").pop() || "无标题"
    : "无标题";

  return (
    <div className="statusbar">
      <span className="statusbar-item">
        {fileName}
        {isDirty && <span className="statusbar-dirty"> ●</span>}
      </span>
      <span className="statusbar-item statusbar-center">
        {/* 专注/打字机模式入口：始终可见，激活时高亮，点击切换 */}
        <button
          className={`statusbar-toggle ${focusMode ? "active" : ""}`}
          title="专注模式 (F8) — 当前编辑段落高亮，其余段落变暗；阅读/编辑/分屏三模式通用"
          onClick={toggleFocusMode}
        >
          🔍 专注
        </button>
        <button
          className={`statusbar-toggle ${typewriterMode ? "active" : ""}`}
          title="打字机模式 (F9) — 光标始终保持在视口中央；阅读/编辑/分屏三模式通用"
          onClick={toggleTypewriter}
        >
          ⌨ 打字机
        </button>
      </span>
      <span className="statusbar-item">
        {wordCount > 0 && <span>{wordCount} 字 </span>}
        {cursorLine > 0 && <span>行 {cursorLine}</span>}
      </span>
    </div>
  );
}
