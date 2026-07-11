/**
 * SettingsDialog —— 设置面板
 *
 * F1：界面语言切换（实时生效）
 * F2：载入文件数量（实时生效，钳制 1-50）
 * F3：载入文件夹开关 + 数量（实时生效，钳制 1-5）
 * 其他字段（fontSize/fontFamily/autoSaveInterval/customCss）点击"保存设置"才提交
 */
import { useState } from "react";
import { useSettingsStore, THEMES, type Theme } from "../../stores/useSettingsStore";
import { useT } from "../../i18n";
import "./SettingsDialog.css";

interface SettingsDialogProps {
  onClose: () => void;
}

export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const settings = useSettingsStore();
  const t = useT();

  // 这些字段保持"保存后生效"行为
  const [fontSize, setFontSize] = useState(settings.fontSize);
  const [fontFamily, setFontFamily] = useState(settings.fontFamily);
  const [autoSaveInterval, setAutoSaveInterval] = useState(settings.autoSaveIntervalMs / 1000);
  const [customCss, setCustomCss] = useState(settings.customCss);

  const handleSave = () => {
    settings.setFontSize(fontSize);
    settings.setFontFamily(fontFamily);
    settings.setAutoSaveInterval(autoSaveInterval * 1000);
    settings.setCustomCss(customCss);
    onClose();
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>{t("settings.title")}</h2>
          <button className="settings-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="settings-body">
          {/* 外观 */}
          <section className="settings-section">
            <h3>{t("settings.appearance")}</h3>

            {/* F1：界面语言下拉（实时生效） */}
            <div className="settings-field">
              <label>{t("settings.language")}</label>
              <select
                className="settings-select"
                value={settings.language}
                onChange={(e) => settings.setLanguage(e.target.value as "zh-CN" | "en-US")}
              >
                <option value="zh-CN">{t("settings.language.zhCN")}</option>
                <option value="en-US">{t("settings.language.enUS")}</option>
              </select>
            </div>

            {/* G6：主题下拉（6 主题，实时生效） */}
            <div className="settings-field">
              <label>{t("settings.theme")}</label>
              <select
                className="settings-select"
                value={settings.theme}
                onChange={(e) => settings.setTheme(e.target.value as Theme)}
              >
                {THEMES.map((th) => (
                  <option key={th} value={th}>
                    {t(`settings.theme.${th}`)}
                  </option>
                ))}
              </select>
            </div>

            <div className="settings-field">
              <label>{t("settings.fontSize")}</label>
              <div className="settings-range">
                <input
                  type="range"
                  min={12}
                  max={28}
                  value={fontSize}
                  onChange={(e) => setFontSize(Number(e.target.value))}
                />
                <span className="range-value">{fontSize}px</span>
              </div>
            </div>

            <div className="settings-field">
              <label>{t("settings.fontFamily")}</label>
              <select
                className="settings-select"
                value={fontFamily}
                onChange={(e) => setFontFamily(e.target.value)}
              >
                <option value="var(--font-sans)">{t("settings.fontFamily.systemDefault")}</option>
                <option value='"Microsoft YaHei", sans-serif'>{t("settings.fontFamily.microsoftYaHei")}</option>
                <option value='"PingFang SC", sans-serif'>{t("settings.fontFamily.pingFangSC")}</option>
                <option value='Consolas, "Courier New", monospace'>{t("settings.fontFamily.consolas")}</option>
                <option value='"Fira Code", monospace'>{t("settings.fontFamily.firaCode")}</option>
                <option value='"Cascadia Code", monospace'>{t("settings.fontFamily.cascadiaCode")}</option>
              </select>
            </div>
          </section>

          {/* 编辑器 */}
          <section className="settings-section">
            <h3>{t("settings.editor")}</h3>

            <div className="settings-field">
              <label>{t("settings.autoSaveInterval")}</label>
              <div className="settings-range">
                <input
                  type="range"
                  min={0}
                  max={600}
                  step={1}
                  value={autoSaveInterval}
                  onChange={(e) => setAutoSaveInterval(Number(e.target.value))}
                />
                <span className="range-value">
                  {autoSaveInterval === 0 ? t("settings.autoSaveInterval.off") : `${autoSaveInterval}${t("settings.seconds")}`}
                </span>
              </div>
            </div>

            {/* F2：启动时载入上次打开的文件（实时生效） */}
            <div className="settings-field">
              <label>{t("settings.loadLastFile")}</label>
              <label className="settings-switch">
                <input
                  type="checkbox"
                  checked={settings.loadLastFileOnStartup}
                  onChange={(e) => settings.setLoadLastFileOnStartup(e.target.checked)}
                />
                <span className="settings-switch-slider"></span>
                <span className="settings-switch-label">
                  {settings.loadLastFileOnStartup ? t("settings.on") : t("settings.off")}
                </span>
              </label>
              {/* F2：开关开启时显示载入文件数量输入框 */}
              {settings.loadLastFileOnStartup && (
                <div className="settings-field" style={{ marginTop: 8 }}>
                  <label>{t("settings.loadLastFileCount")}</label>
                  <input
                    type="number"
                    min={1}
                    max={50}
                    step={1}
                    value={settings.loadLastFileCount}
                    onChange={(e) => settings.setLoadLastFileCount(Number(e.target.value))}
                    className="settings-select"
                    style={{ width: "auto", maxWidth: 120 }}
                  />
                </div>
              )}
            </div>

            {/* F3：启动时载入上次打开的文件夹（实时生效，默认关闭） */}
            <div className="settings-field">
              <label>{t("settings.loadLastFolder")}</label>
              <label className="settings-switch">
                <input
                  type="checkbox"
                  checked={settings.loadLastFolderOnStartup}
                  onChange={(e) => settings.setLoadLastFolderOnStartup(e.target.checked)}
                />
                <span className="settings-switch-slider"></span>
                <span className="settings-switch-label">
                  {settings.loadLastFolderOnStartup ? t("settings.on") : t("settings.off")}
                </span>
              </label>
              {/* F3：开关开启时显示载入文件夹数量输入框 */}
              {settings.loadLastFolderOnStartup && (
                <div className="settings-field" style={{ marginTop: 8 }}>
                  <label>{t("settings.loadLastFolderCount")}</label>
                  <input
                    type="number"
                    min={1}
                    max={5}
                    step={1}
                    value={settings.loadLastFolderCount}
                    onChange={(e) => settings.setLoadLastFolderCount(Number(e.target.value))}
                    className="settings-select"
                    style={{ width: "auto", maxWidth: 120 }}
                  />
                </div>
              )}
            </div>

            {/* G9：显示代码行号（实时生效） */}
            <div className="settings-field">
              <label>{t("settings.showCodeLineNumbers")}</label>
              <label className="settings-switch">
                <input
                  type="checkbox"
                  checked={settings.showCodeLineNumbers}
                  onChange={(e) => settings.setShowCodeLineNumbers(e.target.checked)}
                />
                <span className="settings-switch-slider"></span>
                <span className="settings-switch-label">
                  {settings.showCodeLineNumbers ? t("settings.on") : t("settings.off")}
                </span>
              </label>
            </div>

            {/* G10：拼写检查开关（实时生效，使用浏览器原生 spellcheck） */}
            <div className="settings-field">
              <label>{t("settings.spellcheck")}</label>
              <label className="settings-switch">
                <input
                  type="checkbox"
                  checked={settings.spellcheckEnabled}
                  onChange={(e) => settings.setSpellcheckEnabled(e.target.checked)}
                />
                <span className="settings-switch-slider"></span>
                <span className="settings-switch-label">
                  {settings.spellcheckEnabled ? t("settings.on") : t("settings.off")}
                </span>
              </label>
            </div>
          </section>

          {/* 自定义 CSS */}
          <section className="settings-section">
            <h3>{t("settings.customCss")}</h3>
            <textarea
              className="settings-css-input"
              rows={6}
              placeholder={t("settings.customCss.placeholder")}
              value={customCss}
              onChange={(e) => setCustomCss(e.target.value)}
              spellCheck={false}
            />
          </section>
        </div>

        <div className="settings-footer">
          <button className="settings-btn secondary" onClick={onClose}>
            {t("settings.cancel")}
          </button>
          <button className="settings-btn primary" onClick={handleSave}>
            {t("settings.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
