/**
 * SettingsDialog —— 设置面板
 */
import { useState } from "react";
import { useSettingsStore } from "../../stores/useSettingsStore";
import "./SettingsDialog.css";

interface SettingsDialogProps {
  onClose: () => void;
}

export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const settings = useSettingsStore();

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
          <h2>偏好设置</h2>
          <button className="settings-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="settings-body">
          {/* 外观 */}
          <section className="settings-section">
            <h3>外观</h3>

            <div className="settings-field">
              <label>主题</label>
              <div className="theme-toggle">
                <button
                  className={`theme-btn ${settings.theme === "light" ? "active" : ""}`}
                  onClick={() => settings.setTheme("light")}
                >
                  ☀️ 亮色
                </button>
                <button
                  className={`theme-btn ${settings.theme === "dark" ? "active" : ""}`}
                  onClick={() => settings.setTheme("dark")}
                >
                  🌙 暗色
                </button>
              </div>
            </div>

            <div className="settings-field">
              <label>字体大小</label>
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
              <label>字体</label>
              <select
                className="settings-select"
                value={fontFamily}
                onChange={(e) => setFontFamily(e.target.value)}
              >
                <option value="var(--font-sans)">系统默认</option>
                <option value='"Microsoft YaHei", sans-serif'>微软雅黑</option>
                <option value='"PingFang SC", sans-serif'>苹方</option>
                <option value='Consolas, "Courier New", monospace'>Consolas</option>
                <option value='"Fira Code", monospace'>Fira Code</option>
                <option value='"Cascadia Code", monospace'>Cascadia Code</option>
              </select>
            </div>
          </section>

          {/* 编辑器 */}
          <section className="settings-section">
            <h3>编辑器</h3>

            <div className="settings-field">
              <label>自动保存间隔（秒）</label>
              <div className="settings-range">
                <input
                  type="range"
                  min={0}
                  max={60}
                  step={1}
                  value={autoSaveInterval}
                  onChange={(e) => setAutoSaveInterval(Number(e.target.value))}
                />
                <span className="range-value">
                  {autoSaveInterval === 0 ? "关闭" : `${autoSaveInterval}s`}
                </span>
              </div>
            </div>
          </section>

          {/* 自定义 CSS */}
          <section className="settings-section">
            <h3>自定义 CSS</h3>
            <textarea
              className="settings-css-input"
              rows={6}
              placeholder={`/* 自定义编辑器样式 */\n/* 例如: */\n/* h1 { color: red; } */`}
              value={customCss}
              onChange={(e) => setCustomCss(e.target.value)}
              spellCheck={false}
            />
          </section>
        </div>

        <div className="settings-footer">
          <button className="settings-btn secondary" onClick={onClose}>
            取消
          </button>
          <button className="settings-btn primary" onClick={handleSave}>
            保存设置
          </button>
        </div>
      </div>
    </div>
  );
}
