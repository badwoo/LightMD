import { useEditorStore } from "../../stores/useEditorStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import "./StatusBar.css";

export function StatusBar() {
  const isDirty = useEditorStore((s) => s.isDirty);
  const cursorLine = useEditorStore((s) => s.cursorLine);
  const wordCount = useEditorStore((s) => s.wordCount);
  const filePath = useEditorStore((s) => s.filePath);
  const focusMode = useEditorStore((s) => s.focusMode);
  const typewriterMode = useSettingsStore((s) => s.typewriterMode);

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
        {focusMode && <span className="statusbar-badge">🔍 专注</span>}
        {typewriterMode && <span className="statusbar-badge">⌨ 打字机</span>}
      </span>
      <span className="statusbar-item">
        {wordCount > 0 && <span>{wordCount} 字 </span>}
        {cursorLine > 0 && <span>行 {cursorLine}</span>}
      </span>
    </div>
  );
}
