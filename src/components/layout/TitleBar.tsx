import { useState, useRef, useEffect, useCallback } from "react";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useEditorStore, type ViewMode } from "../../stores/useEditorStore";
import { useT } from "../../i18n";
// v0.9.0 自定义快捷键：菜单键位展示读生效键位表
import { getShortcutLabel } from "../../core/shortcuts";
// v0.8.1 需求6：无边框窗口下自绘的最小化/最大化/关闭三键
import { WindowControls } from "./WindowControls";
// v0.9.0 WP2：窗口菜单（新建/关闭/列表/合并到主窗口）
import { windowService, type WindowSummary } from "../../services/windowService";
import { getWindowLabel, isMainWindow } from "../../utils/windowLabel";
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
  /** v0.9.0 WP2：窗口菜单动作 */
  onNewWindow?: () => void;
  onCloseWindow?: () => void;
  onMergeToPrimary?: () => void;
  /** v0.9.0：退出整个应用（记录完整窗口集合，供「恢复其他窗口」下次还原） */
  onQuitApp?: () => void;
  onFocusWindow?: (label: string) => void;
  /** v0.9.0 WP2：激活另一窗口并切换到其指定标签（窗口列表子项点击） */
  onActivateTab?: (
    label: string,
    target: { kind: string; path: string | null; untitledId: string | null },
  ) => void;
  /** 本窗口是否 Primary（仅用于给窗口列表里的自身项加标记） */
  isPrimaryWindow?: boolean;
}

/**
 * v0.9.0 WP2：窗口菜单列表项的显示名。
 * - Primary → 「主窗口」
 * - 其余 → 「窗口 N」，N 取自槽位标签 sec-N（固定槽位保证编号稳定且不跳号）
 * - Primary 不在 sec 槽位时（晋升场景）按创建顺序兜底为「窗口 1」
 */
export function windowDisplayName(
  label: string,
  isPrimary: boolean,
  slots: string[],
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (isPrimary) return t("multiwindow.primary");
  const m = /^sec-(\d+)$/.exec(label);
  if (m) return t("multiwindow.windowN", { n: Number(m[1]) });
  const idx = slots.indexOf(label);
  return t("multiwindow.windowN", { n: Math.max(idx + 1, 1) });
}

export function TitleBar({
  fileName,
  onNew,
  onNewFile,
  onNewFolder,
  onOpen,
  onSave,
  onSaveAs,
  onExport,
  onSettings,
  onNewWindow,
  onCloseWindow,
  onMergeToPrimary,
  onFocusWindow,
  onActivateTab,
  onQuitApp,
  isPrimaryWindow,
}: TitleBarProps) {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const viewMode = useEditorStore((s) => s.viewMode);
  const setViewMode = useEditorStore((s) => s.setViewMode);
  const t = useT();
  const [showNewMenu, setShowNewMenu] = useState(false);
  const newMenuRef = useRef<HTMLDivElement>(null);
  // v0.9.0 WP2：窗口菜单
  const [showWindowMenu, setShowWindowMenu] = useState(false);
  const [windowList, setWindowList] = useState<WindowSummary[]>([]);
  const windowMenuRef = useRef<HTMLDivElement>(null);

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

  // 点击外部关闭窗口菜单
  useEffect(() => {
    if (!showWindowMenu) return;
    const close = (e: MouseEvent) => {
      if (windowMenuRef.current && !windowMenuRef.current.contains(e.target as Node)) {
        setShowWindowMenu(false);
      }
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [showWindowMenu]);

  /**
   * 打开窗口菜单时拉取一次窗口列表。
   * 只在展开瞬间查一次（而非轮询）——窗口数量与标签概要在人机操作频率下足够新。
   */
  const refreshWindowList = useCallback(async () => {
    const list = await windowService.listWindows();
    setWindowList(list);
  }, []);

  useEffect(() => {
    if (showWindowMenu) void refreshWindowList();
  }, [showWindowMenu, refreshWindowList]);

  const handleModeClick = (mode: ViewMode) => {
    if (viewMode !== mode) setViewMode(mode);
  };

  const slots = windowList.map((w) => w.label);

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-left">
        {/* v0.8.1 需求6：无边框窗口靠 data-tauri-drag-region 拖动，
            直接命中的元素需自带该属性（子元素不会继承），故逐个补齐 */}
        <span className="titlebar-brand" data-tauri-drag-region>LightMD</span>
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
          <div
            className="titlebar-new-menu"
            ref={newMenuRef}
            // v0.8.2 需求6：鼠标移出"新建+子菜单"整体区域后自动收起
            onMouseLeave={() => setShowNewMenu(false)}
          >
            {/* v0.8.2 需求6：鼠标移入"新建"自动展开子菜单；点击保持展开（收起走移出/点外部/选中项） */}
            <button
              className="titlebar-menu-btn"
              title={t("titlebar.newTitle")}
              onMouseEnter={() => setShowNewMenu(true)}
              onClick={() => setShowNewMenu(true)}
            >
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

          {/* v0.9.0 WP2：窗口菜单（新建/关闭/动态窗口列表/合并到主窗口） */}
          <div
            className="titlebar-new-menu"
            ref={windowMenuRef}
            onMouseLeave={() => setShowWindowMenu(false)}
          >
            <button
              className="titlebar-menu-btn"
              title={t("multiwindow.menuTitle")}
              data-testid="titlebar-window-menu-btn"
              onMouseEnter={() => setShowWindowMenu(true)}
              onClick={() => setShowWindowMenu(true)}
            >
              {t("multiwindow.menu")}
            </button>
            {showWindowMenu && (
              <div className="titlebar-dropdown titlebar-window-dropdown">
                <button
                  className="titlebar-dropdown-item"
                  onClick={() => { setShowWindowMenu(false); onNewWindow?.(); }}
                >
                  {t("multiwindow.newWindow")}
                  <span className="titlebar-dropdown-shortcut">{getShortcutLabel("window.new")}</span>
                </button>
                <button
                  className="titlebar-dropdown-item"
                  onClick={() => { setShowWindowMenu(false); onCloseWindow?.(); }}
                >
                  {t("multiwindow.closeWindow")}
                  <span className="titlebar-dropdown-shortcut">{getShortcutLabel("window.close")}</span>
                </button>
                <div className="titlebar-dropdown-sep" />
                <div className="titlebar-dropdown-label">{t("multiwindow.list")}</div>
                {windowList.length === 0 && (
                  <div className="titlebar-dropdown-empty">{t("multiwindow.emptyWindow")}</div>
                )}
                {windowList.map((w) => {
                  const self = w.label === getWindowLabel();
                  const tabsLabel =
                    w.tabs.length === 0
                      ? t("multiwindow.emptyWindow")
                      : w.tabs.map((tb) => tb.name).join(", ");
                  return (
                    <div key={w.label} className="titlebar-window-group">
                      <button
                        className={`titlebar-dropdown-item titlebar-window-item${self ? " is-self" : ""}`}
                        title={tabsLabel}
                        data-testid={`window-menu-window-${w.label}`}
                        onClick={() => {
                          setShowWindowMenu(false);
                          if (!self) onFocusWindow?.(w.label);
                        }}
                      >
                        <span className="titlebar-window-name">
                          {windowDisplayName(w.label, w.isPrimary || (self && !!isPrimaryWindow), slots, t)}
                          {self ? " •" : ""}
                        </span>
                        <span className="titlebar-window-tabs">{tabsLabel}</span>
                      </button>
                      {/* v0.9.0 WP2 §3.7：子项点击 = 激活该窗口 + 切换到对应标签 */}
                      {w.tabs.map((tb, i) => (
                        <button
                          key={`${w.label}-${tb.kind}-${tb.path ?? tb.untitledId ?? i}`}
                          className={`titlebar-dropdown-item titlebar-tab-item${
                            w.activeTabIdx === i ? " is-active" : ""
                          }`}
                          data-testid={`window-menu-tab-${w.label}-${i}`}
                          onClick={() => {
                            setShowWindowMenu(false);
                            onActivateTab?.(w.label, {
                              kind: tb.kind,
                              path: tb.path ?? null,
                              untitledId: tb.untitledId ?? null,
                            });
                          }}
                        >
                          <span className="titlebar-tab-name">
                            {tb.isDirty ? `${tb.name} ●` : tb.name}
                          </span>
                        </button>
                      ))}
                    </div>
                  );
                })}
                <div className="titlebar-dropdown-sep" />
                <button
                  className="titlebar-dropdown-item"
                  data-testid="window-menu-merge-primary"
                  onClick={() => { setShowWindowMenu(false); onMergeToPrimary?.(); }}
                  disabled={isPrimaryWindow || isMainWindow()}
                >
                  {t("multiwindow.mergeToPrimary")}
                </button>
                <div className="titlebar-dropdown-sep" />
                <button
                  className="titlebar-dropdown-item"
                  data-testid="window-menu-quit"
                  onClick={() => { setShowWindowMenu(false); onQuitApp?.(); }}
                >
                  {t("multiwindow.quit")}
                  <span className="titlebar-dropdown-shortcut">{getShortcutLabel("window.quit")}</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="titlebar-center" data-tauri-drag-region>
        <span className="titlebar-title" data-tauri-drag-region>{fileName || "LightMD"}</span>
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

        {/* v0.8.1 需求6：窗口三键（macOS 交通灯配色）紧随设置按钮右侧 */}
        <WindowControls />
      </div>
    </div>
  );
}
