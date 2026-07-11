import { useState, useRef, useEffect } from "react";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useEditorStore, type ViewMode } from "../../stores/useEditorStore";
import { useT } from "../../i18n";
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
  const t = useT();
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
        {/* 模式切换按钮组：阅读 / 编辑 / 分屏 */}
        <div className="titlebar-mode-switch">
          <button
            className={`titlebar-mode-btn ${viewMode === "preview" ? "active" : ""}`}
            title={t("titlebar.readMode")}
            onClick={() => handleModeClick("preview")}
          >
            {t("titlebar.read")}
          </button>
          <button
            className={`titlebar-mode-btn ${viewMode === "edit" ? "active" : ""}`}
            title={t("titlebar.editMode")}
            onClick={() => handleModeClick("edit")}
          >
            {t("titlebar.edit")}
          </button>
          <button
            className={`titlebar-mode-btn ${viewMode === "split" ? "active" : ""}`}
            title={t("titlebar.splitMode")}
            onClick={() => handleModeClick("split")}
          >
            {t("titlebar.split")}
          </button>
        </div>
        <div className="titlebar-menu">
          <div className="titlebar-new-menu" ref={newMenuRef}>
            <button className="titlebar-menu-btn" title={t("titlebar.newTitle")} onClick={() => setShowNewMenu(!showNewMenu)}>
              {t("titlebar.new")}
            </button>
            {showNewMenu && (
              <div className="titlebar-dropdown">
                <button className="titlebar-dropdown-item" onClick={() => { setShowNewMenu(false); onNewFile?.(); }}>
                  {t("titlebar.newFile")}
                </button>
                <button className="titlebar-dropdown-item" onClick={() => { setShowNewMenu(false); onNewFolder?.(); }}>
                  {t("titlebar.newFolder")}
                </button>
              </div>
            )}
          </div>
          <button className="titlebar-menu-btn" title={t("titlebar.openTitle")} onClick={onOpen}>
            {t("titlebar.open")}
          </button>
          <button className="titlebar-menu-btn" title={t("titlebar.saveTitle")} onClick={onSave}>
            {t("titlebar.save")}
          </button>
          <button className="titlebar-menu-btn" title={t("titlebar.saveAsTitle")} onClick={onSaveAs}>
            {t("titlebar.saveAs")}
          </button>
        </div>
      </div>

      <div className="titlebar-center" data-tauri-drag-region>
        <span className="titlebar-title">{fileName || "LightMD"}</span>
      </div>

      <div className="titlebar-right">
        <button
          className="titlebar-icon-btn"
          title={theme === "light" ? t("titlebar.switchDark") : t("titlebar.switchLight")}
          onClick={() => setTheme(theme === "light" ? "dark" : "light")}
        >
          {theme === "light" ? "🌙" : "☀️"}
        </button>

        <button
          className="titlebar-icon-btn"
          title={t("titlebar.export")}
          onClick={onExport}
        >
          📤
        </button>

        <button
          className="titlebar-icon-btn"
          title={t("titlebar.settings")}
          onClick={onSettings}
        >
          ⚙️
        </button>
      </div>
    </div>
  );
}
