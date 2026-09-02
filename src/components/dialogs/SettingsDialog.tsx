/**
 * SettingsDialog —— 设置面板
 *
 * F1：界面语言切换（实时生效）
 * F2：载入文件数量（实时生效，钳制 1-50）
 * F3：载入文件夹开关 + 数量（实时生效，钳制 1-5）
 * v0.6.0：AI 翻译分组（Provider 预设/API Key（keyring）/测试连接/目标语言/语体/结果模式/自定义 Prompt，实时生效）
 * 其他字段（fontSize/fontFamily/autoSaveInterval/customCss）点击"保存设置"才提交
 */
import { useState, useEffect } from "react";
import { useSettingsStore, THEMES, type Theme, type TranslateSettings } from "../../stores/useSettingsStore";
import { translateService } from "../../services/translateService";
import { useT } from "../../i18n";
import "./SettingsDialog.css";

/** v0.6.0：翻译服务商预设（切换时自动填充 baseUrl/默认模型；models 供模型角色下拉选择） */
export interface TranslateProviderPreset {
  baseUrl: string;
  /** 推荐模型角色列表（datalist 选项，首个为切换预设时的默认值） */
  models: string[];
}

export const TRANSLATE_PROVIDERS: Record<string, TranslateProviderPreset> = {
  deepseek: { baseUrl: "https://api.deepseek.com/v1", models: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat"] },
  zhipu: { baseUrl: "https://open.bigmodel.cn/api/paas/v4", models: ["glm-4-flash", "glm-4-air", "glm-4-plus"] },
  minimax: { baseUrl: "https://api.minimaxi.com/v1", models: ["MiniMax-Text-01"] },
  alibaba: { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", models: ["qwen-flash", "qwen-plus", "qwen-turbo", "qwen-max"] },
  kimi: { baseUrl: "https://api.moonshot.cn/v1", models: ["kimi-k2-0905-preview", "moonshot-v1-8k", "moonshot-v1-32k"] },
  volcengine: { baseUrl: "https://ark.cn-beijing.volces.com/api/v3", models: ["doubao-1-5-pro-32k-250115", "doubao-1-5-lite-32k-250115"] },
  doubao: { baseUrl: "https://ark.cn-beijing.volces.com/api/v3", models: ["doubao-seed-1-6-250615", "doubao-seed-1-6-flash-250815"] },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", models: ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-2.5-pro"] },
  claude: { baseUrl: "https://api.anthropic.com/v1", models: ["claude-sonnet-4-20250514", "claude-3-5-haiku-20241022"] },
  modelscope: { baseUrl: "https://api-inference.modelscope.cn/v1", models: ["Qwen/Qwen2.5-7B-Instruct", "deepseek-ai/DeepSeek-V3.1"] },
  siliconflow: { baseUrl: "https://api.siliconflow.cn/v1", models: ["Qwen/Qwen2.5-7B-Instruct", "THUDM/glm-4-9b-chat"] },
  openai: { baseUrl: "https://api.openai.com/v1", models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"] },
  custom: { baseUrl: "", models: [] },
};

/** v0.6.0：Provider 切换后的配置变更（纯函数，供测试）。custom 时保留当前值 */
export function applyProviderPreset(
  preset: string,
  current: TranslateSettings
): Partial<TranslateSettings> {
  const p = TRANSLATE_PROVIDERS[preset];
  if (!p) return {};
  if (preset === "custom") return { translateProviderPreset: preset };
  return { translateProviderPreset: preset, translateBaseUrl: p.baseUrl, translateModel: p.models[0] };
}

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

  // ─── v0.6.0：AI 翻译分组状态 ───────────────────
  // Key 输入不回显已存值（keyring 只写不读明文）；keyStatus 打开对话框时异步探测
  const [apiKey, setApiKey] = useState("");
  const [keyStatus, setKeyStatus] = useState<"unknown" | "configured" | "not-configured">("unknown");
  const [keySaved, setKeySaved] = useState(false);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [testDetail, setTestDetail] = useState("");

  // 打开时检查 keyring 是否已配置 Key
  useEffect(() => {
    let alive = true;
    translateService.hasKey().then((ok) => {
      if (alive) setKeyStatus(ok ? "configured" : "not-configured");
    });
    return () => { alive = false; };
  }, []);

  /** 保存 API Key 到 keyring（成功后清空输入并显示已配置） */
  const handleSaveKey = async () => {
    const key = apiKey.trim();
    if (!key) return;
    try {
      await translateService.setKey(key);
      setApiKey("");
      setKeySaved(true);
      setKeyStatus("configured");
      setTimeout(() => setKeySaved(false), 1500);
    } catch {
      // keyring 写入失败：保持输入，用户可重试
    }
  };

  /** 测试连接（1-token 最小请求，验证 Key + baseUrl + model） */
  const handleTestConnection = async () => {
    setTestStatus("testing");
    setTestDetail("");
    try {
      await translateService.testConnection(settings.translate.translateBaseUrl, settings.translate.translateModel);
      setTestStatus("ok");
    } catch (e) {
      setTestStatus("fail");
      const detail = e instanceof Error ? e.message.split(": ").slice(1).join(": ") : String(e);
      setTestDetail(detail);
    }
  };

  /** 翻译配置统一实时生效 */
  const setTranslate = (patch: Partial<TranslateSettings>) => {
    settings.setTranslateConfig(patch);
  };

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

            {/* N1：自动配对补全开关（括号/引号自动补全，编辑与源码模式同时生效） */}
            <div className="settings-field">
              <label>{t("settings.autoPair")}</label>
              <label className="settings-switch">
                <input
                  type="checkbox"
                  checked={settings.autoPairEnabled}
                  onChange={(e) => settings.setAutoPairEnabled(e.target.checked)}
                />
                <span className="settings-switch-slider"></span>
                <span className="settings-switch-label">
                  {settings.autoPairEnabled ? t("settings.on") : t("settings.off")}
                </span>
              </label>
            </div>
          </section>

          {/* v0.6.0：AI 翻译 */}
          <section className="settings-section" data-testid="translate-section">
            <h3>{t("settings.translate")}</h3>

            {/* 总开关（关闭后所有翻译入口不响应，其余配置置灰仍可查看） */}
            <div className="settings-field">
              <label>{t("settings.translate.enabled")}</label>
              <select
                className="settings-select"
                value={settings.translate.translateEnabled ? "on" : "off"}
                onChange={(e) => setTranslate({ translateEnabled: e.target.value === "on" })}
                data-testid="translate-enabled"
              >
                <option value="on">{t("settings.on")}</option>
                <option value="off">{t("settings.off")}</option>
              </select>
            </div>

            {/* 关闭时其余配置置灰（CSS pointer-events + opacity） */}
            <div className={`translate-config-fields${settings.translate.translateEnabled ? "" : " disabled"}`}>
            {/* 服务商预设（切换自动填充地址与模型） */}
            <div className="settings-field">
              <label>{t("settings.translate.provider")}</label>
              <select
                className="settings-select"
                value={settings.translate.translateProviderPreset}
                onChange={(e) => setTranslate(applyProviderPreset(e.target.value, settings.translate))}
                data-testid="translate-provider"
              >
                <option value="deepseek">{t("settings.translate.provider.deepseek")}</option>
                <option value="zhipu">{t("settings.translate.provider.zhipu")}</option>
                <option value="minimax">{t("settings.translate.provider.minimax")}</option>
                <option value="alibaba">{t("settings.translate.provider.alibaba")}</option>
                <option value="kimi">{t("settings.translate.provider.kimi")}</option>
                <option value="volcengine">{t("settings.translate.provider.volcengine")}</option>
                <option value="doubao">{t("settings.translate.provider.doubao")}</option>
                <option value="gemini">{t("settings.translate.provider.gemini")}</option>
                <option value="claude">{t("settings.translate.provider.claude")}</option>
                <option value="modelscope">{t("settings.translate.provider.modelscope")}</option>
                <option value="siliconflow">{t("settings.translate.provider.siliconflow")}</option>
                <option value="openai">{t("settings.translate.provider.openai")}</option>
                <option value="custom">{t("settings.translate.provider.custom")}</option>
              </select>
            </div>

            {/* API Key（keyring 安全存储，不回显） */}
            <div className="settings-field">
              <label>
                {t("settings.translate.apiKey")}
                {keyStatus === "configured" && (
                  <span className="translate-key-status ok" data-testid="translate-key-status">✓ {t("settings.translate.apiKeyConfigured")}</span>
                )}
                {keyStatus === "not-configured" && (
                  <span className="translate-key-status" data-testid="translate-key-status">{t("settings.translate.apiKeyNotConfigured")}</span>
                )}
              </label>
              <div className="settings-inline-row">
                <input
                  type="password"
                  className="settings-select"
                  style={{ flex: 1, width: "auto" }}
                  placeholder={t("settings.translate.apiKeyPlaceholder")}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  autoComplete="off"
                  data-testid="translate-api-key-input"
                />
                <button
                  className="settings-btn secondary"
                  disabled={!apiKey.trim()}
                  onClick={handleSaveKey}
                  data-testid="translate-api-key-save"
                >
                  {keySaved ? t("settings.translate.apiKeySaved") : t("settings.translate.apiKeySave")}
                </button>
              </div>
            </div>

            {/* API 地址（custom 预设或任意预设均可微调） */}
            <div className="settings-field">
              <label>{t("settings.translate.baseUrl")}</label>
              <input
                type="text"
                className="settings-select"
                style={{ width: "auto" }}
                value={settings.translate.translateBaseUrl}
                onChange={(e) => setTranslate({ translateBaseUrl: e.target.value })}
                spellCheck={false}
                data-testid="translate-base-url"
              />
              {/* v0.6.3 S-4：非 https 地址明文传输 Bearer Key，显式警告 */}
              {/^http:\/\//i.test(settings.translate.translateBaseUrl.trim()) && (
                <div className="settings-hint settings-hint-warning" data-testid="translate-base-url-warning">
                  {t("settings.translate.baseUrlInsecure")}
                </div>
              )}
            </div>

            {/* 模型角色（datalist：当前服务商推荐模型可下拉选择，也可手动输入任意模型名） */}
            <div className="settings-field">
              <label>{t("settings.translate.model")}</label>
              <input
                type="text"
                className="settings-select"
                style={{ width: "auto" }}
                list="translate-model-options"
                value={settings.translate.translateModel}
                onChange={(e) => setTranslate({ translateModel: e.target.value })}
                spellCheck={false}
                data-testid="translate-model"
              />
              <datalist id="translate-model-options" data-testid="translate-model-options">
                {(TRANSLATE_PROVIDERS[settings.translate.translateProviderPreset]?.models ?? []).map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>

            {/* 测试连接 */}
            <div className="settings-field">
              <label>{t("settings.translate.test")}</label>
              <div className="settings-inline-row">
                <button
                  className="settings-btn secondary"
                  disabled={testStatus === "testing" || !settings.translate.translateBaseUrl}
                  onClick={handleTestConnection}
                  data-testid="translate-test-btn"
                >
                  {testStatus === "testing" ? t("settings.translate.testing") : t("settings.translate.test")}
                </button>
                {testStatus === "ok" && (
                  <span className="translate-test-status ok" data-testid="translate-test-status">✓ {t("settings.translate.testOk")}</span>
                )}
                {testStatus === "fail" && (
                  <span className="translate-test-status fail" data-testid="translate-test-status">
                    ✗ {t("settings.translate.testFail")}{testDetail ? `：${testDetail}` : ""}
                  </span>
                )}
              </div>
            </div>

            {/* 目标语言 */}
            <div className="settings-field">
              <label>{t("settings.translate.targetLang")}</label>
              <select
                className="settings-select"
                value={settings.translate.translateTargetLang}
                onChange={(e) => setTranslate({ translateTargetLang: e.target.value })}
                data-testid="translate-target-lang"
              >
                <option value="auto">{t("settings.translate.targetLang.auto")}</option>
                <option value="简体中文">简体中文</option>
                <option value="English">English</option>
                <option value="日本語">日本語</option>
                <option value="한국어">한국어</option>
              </select>
            </div>

            {/* 语体 */}
            <div className="settings-field">
              <label>{t("settings.translate.tone")}</label>
              <select
                className="settings-select"
                value={settings.translate.translateTone}
                onChange={(e) => setTranslate({ translateTone: e.target.value })}
                data-testid="translate-tone"
              >
                <option value="正式">{t("settings.translate.tone.formal")}</option>
                <option value="口语">{t("settings.translate.tone.casual")}</option>
                <option value="技术文档">{t("settings.translate.tone.technical")}</option>
              </select>
            </div>

            {/* 结果模式 */}
            <div className="settings-field">
              <label>{t("settings.translate.resultMode")}</label>
              <select
                className="settings-select"
                value={settings.translate.translateResultMode}
                onChange={(e) => setTranslate({ translateResultMode: e.target.value as TranslateSettings["translateResultMode"] })}
                data-testid="translate-result-mode"
              >
                <option value="bubble">{t("settings.translate.resultMode.bubble")}</option>
                <option value="replace">{t("settings.translate.resultMode.replace")}</option>
                <option value="bilingual">{t("settings.translate.resultMode.bilingual")}</option>
                <option value="clipboard">{t("settings.translate.resultMode.clipboard")}</option>
              </select>
            </div>

            {/* 自定义 Prompt */}
            <div className="settings-field">
              <label>{t("settings.translate.customPrompt")}</label>
              <textarea
                className="settings-css-input"
                rows={3}
                placeholder={t("settings.translate.customPromptPlaceholder")}
                value={settings.translate.translateCustomPrompt}
                onChange={(e) => setTranslate({ translateCustomPrompt: e.target.value })}
                spellCheck={false}
                data-testid="translate-custom-prompt"
              />
            </div>
            </div>{/* /.translate-config-fields */}
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
