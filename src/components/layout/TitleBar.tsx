import { useState, useRef, useEffect } from "react";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useEditorStore, type ViewMode } from "../../stores/useEditorStore";
import "./TitleBar.css";

interface TitleBarProps {
  fileName?: string;
  onNew?: () => void;
  onNewFile?: () => void;
  onNewFolder?: () => void;
  onOpen?: () => void;
  onSave?: () => void;
  onSaveAs?: () => void;
  onExport?: () => void;
  onSettings?: () => void;
}

export function TitleBar({ fileName, onNew, onNewFile, onNewFolder, onOpen, onSave, onSaveAs, onExport, onSettings }: TitleBarProps) {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const viewMode = useEditorStore((s) => s.viewMode);
  const setViewMode = useEditorStore((s) => s.setViewMode);
  const [showNewMenu, setShowNewMenu] = useState(false);
  const newMenuRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭新建菜单
  useEffect(() => {
    if (!showNewMenu) return;
    const close = (e: MouseEvent) => {
      if (newMenuRef.current && !newMenuRef.current.contains(e.target as Node)) {
        setShowNewMenu(false);
      }
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [showNewMenu]);

  const handleModeClick = (mode: ViewMode) => {
    if (viewMode !== mode) setViewMode(mode);
  };

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-left">
        <span className="titlebar-brand">LightMD</span>
        {/* 模式切换按钮组：预览 / 编辑 / 分屏 */}
        <div className="titlebar-mode-switch">
          <button
            className={`titlebar-mode-btn ${viewMode === "preview" ? "active" : ""}`}
            title="预览模式"
            onClick={() => handleModeClick("preview")}
          >
            预览
          </button>
          <button
            className={`titlebar-mode-btn ${viewMode === "edit" ? "active" : ""}`}
            title="编辑模式"
            onClick={() => handleModeClick("edit")}
          >
            编辑
          </button>
          <button
            className={`titlebar-mode-btn ${viewMode === "split" ? "active" : ""}`}
            title="分屏模式 (双击Shift)"
            onClick={() => handleModeClick("split")}
          >
            分屏
          </button>
        </div>
        <div className="titlebar-menu">
          <div className="titlebar-new-menu" ref={newMenuRef}>
            <button className="titlebar-menu-btn" title="新建 (Ctrl+N)" onClick={() => setShowNewMenu(!showNewMenu)}>
              新建 ▾
            </button>
            {showNewMenu && (
              <div className="titlebar-dropdown">
                <button className="titlebar-dropdown-item" onClick={() => { setShowNewMenu(false); onNewFile?.(); }}>
                  📄 新建文件
                </button>
                <button className="titlebar-dropdown-item" onClick={() => { setShowNewMenu(false); onNewFolder?.(); }}>
                  📁 新建文件夹
                </button>
              </div>
            )}
          </div>
          <button className="titlebar-menu-btn" title="打开文件 (Ctrl+O)" onClick={onOpen}>
            打开
          </button>
          <button className="titlebar-menu-btn" title="保存 (Ctrl+S)" onClick={onSave}>
            保存
          </button>
          <button className="titlebar-menu-btn" title="另存为 (Ctrl+Shift+S)" onClick={onSaveAs}>
            另存为
          </button>
        </div>
      </div>

      <div className="titlebar-center" data-tauri-drag-region>
        <span className="titlebar-title">{fileName || "LightMD"}</span>
      </div>

      <div className="titlebar-right">
        <button
          className="titlebar-icon-btn"
          title={theme === "light" ? "切换暗色主题 (Ctrl+Shift+T)" : "切换亮色主题 (Ctrl+Shift+T)"}
          onClick={() => setTheme(theme === "light" ? "dark" : "light")}
        >
          {theme === "light" ? "🌙" : "☀️"}
        </button>

        <button
          className="titlebar-icon-btn"
          title="导出 (Ctrl+Shift+E)"
          onClick={onExport}
        >
          📤
        </button>

        <button
          className="titlebar-icon-btn"
          title="设置 (Ctrl+,)"
          onClick={onSettings}
        >
          ⚙️
        </button>
      </div>
    </div>
  );
}
