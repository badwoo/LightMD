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
  // v0.7.2 P0：模型目录按各厂商 2026-09 官方在售型号刷新（最新 + 上一代；datalist 可自由输入，列表仅作快捷选择）
  // 注意：各厂商会持续下线旧模型（如 Kimi k2 系列 2026-05 已全部下线），过时列表请用"获取模型列表"按钮动态拉取
  deepseek: { baseUrl: "https://api.deepseek.com/v1", models: ["deepseek-v4-flash", "deepseek-v4-pro"] },
  zhipu: { baseUrl: "https://open.bigmodel.cn/api/paas/v4", models: ["glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5.1", "glm-5", "glm-4.7", "glm-4.7-flash"] },
  minimax: { baseUrl: "https://api.minimax.cn/v1", models: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5"] },
  alibaba: { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", models: ["qwen3.8-max", "qwen3.8-flash", "qwen3.7-plus", "qwen3.7-flash", "qwen-plus", "qwen-flash"] },
  kimi: { baseUrl: "https://api.moonshot.cn/v1", models: ["kimi-k3", "kimi-k2.6", "kimi-k2.7-code", "kimi-k2.7-code-highspeed"] },
  volcengine: { baseUrl: "https://ark.cn-beijing.volces.com/api/v3", models: ["doubao-seed-2-1-pro-260628", "doubao-seed-2-1-turbo-260628", "doubao-seed-2-0-lite-260428", "doubao-seed-2-0-mini-260428"] },
  doubao: { baseUrl: "https://ark.cn-beijing.volces.com/api/v3", models: ["doubao-seed-evolving", "doubao-seed-2-1-pro-260628", "doubao-seed-2-1-turbo-260628"] },
  // v0.7.2：补全国内主流厂商（均为 OpenAI 兼容端点；模型目录以"获取模型列表"动态拉取为准）
  // 各端点均按 2026-09 官方文档核实：
  // - kimicode：Kimi 会员编程套餐（api.kimi.com/coding/v1），官方 4 个模型 ID 全量收录
  // - baidu：千帆 ModelBuilder v2（支持 GET /models 动态拉取，ernie-5.0 为最新旗舰）
  // - xunfei：v1 端点仅支持 4.0Ultra/max-32k/lite（x1 等新模型需 v2 端点，不适配）
  // - antling：蚂蚁百灵官方 OpenAI 兼容端点（api.ant-ling.com）
  kimicode: { baseUrl: "https://api.kimi.com/coding/v1", models: ["k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed"] },
  hunyuan: { baseUrl: "https://api.hunyuan.cloud.tencent.com/v1", models: ["hunyuan-turbos-latest", "hunyuan-turbo", "hunyuan-lite"] },
  xunfei: { baseUrl: "https://spark-api-open.xf-yun.com/v1", models: ["4.0Ultra", "max-32k", "lite"] },
  stepfun: { baseUrl: "https://api.stepfun.com/v1", models: ["step-3.7-flash", "step-3.5-flash"] },
  baidu: { baseUrl: "https://qianfan.baidubce.com/v2", models: ["ernie-5.0", "ernie-4.5-turbo-128k", "ernie-4.5-turbo-32k"] },
  lingyi: { baseUrl: "https://api.lingyiwanwu.com/v1", models: ["yi-lightning", "yi-large"] },
  baichuan: { baseUrl: "https://api.baichuan-ai.com/v1", models: ["Baichuan4-Turbo", "Baichuan4-Air", "Baichuan4"] },
  sensenova: { baseUrl: "https://api.sensenova.cn/compatible-mode/v2", models: ["SenseChat-5", "SenseChat-Turbo"] },
  antling: { baseUrl: "https://api.ant-ling.com/v1", models: ["Ling-3.0-flash", "Ling-2.6-1T", "Ling-2.6-flash", "Ring-2.6-1T"] },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", models: ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3-pro", "gemini-2.5-flash", "gemini-2.5-pro"] },
  claude: { baseUrl: "https://api.anthropic.com/v1", models: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-7"] },
  modelscope: { baseUrl: "https://api-inference.modelscope.cn/v1", models: ["Qwen/Qwen3-235B-A22B", "deepseek-ai/DeepSeek-V3.1"] },
  siliconflow: { baseUrl: "https://api.siliconflow.cn/v1", models: ["deepseek-ai/DeepSeek-V4-Flash", "moonshotai/Kimi-K2.6", "Qwen/Qwen3.6-35B-A3B"] },
  openai: { baseUrl: "https://api.openai.com/v1", models: ["gpt-5.2", "gpt-5-mini", "gpt-5.1", "gpt-4.1-mini"] },
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
  // v0.7.3：kimi / kimicode（Moonshot 系）部分模型仅允许 temperature=1，
  // 切换预设时默认置 1，否则请求会收到 400 invalid temperature
  const temperature =
    preset === "kimi" || preset === "kimicode" ? 1 : (current.translateTemperature ?? 0.1);
  return {
    translateProviderPreset: preset,
    translateBaseUrl: p.baseUrl,
    translateModel: p.models[0],
    translateTemperature: temperature,
  };
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
  // v0.7.2 P2：动态模型列表（拉取成功后替换 datalist；null = 使用静态预设列表）
  const [dynamicModels, setDynamicModels] = useState<string[] | null>(null);
  const [fetchStatus, setFetchStatus] = useState<"idle" | "fetching" | "ok" | "fail">("idle");
  const [fetchDetail, setFetchDetail] = useState("");
  // v0.7.2 修复：datalist 原生行为会按输入框已有文本过滤选项（切预设默认模型后只显示 1 项），
  // 拉取成功后改用完整候选浮层展示全部模型，点击选择；datalist 仅保留给手动输入联想
  const [modelMenuOpen, setModelMenuOpen] = useState(false);

  const providerPreset = settings.translate.translateProviderPreset;

  // v0.7.2 修复：切换厂商或修改 baseUrl 后，旧动态列表不再适用，重置回静态预设
  useEffect(() => {
    setDynamicModels(null);
    setFetchStatus("idle");
    setFetchDetail("");
    setModelMenuOpen(false);
  }, [providerPreset, settings.translate.translateBaseUrl]);

  // 打开时/切换厂商时检查 keyring 是否已配置当前厂商的 Key（v0.7.2 P1：按 provider 独立存储）
  useEffect(() => {
    let alive = true;
    setKeyStatus("unknown");
    translateService.hasKey(providerPreset).then((ok) => {
      if (alive) setKeyStatus(ok ? "configured" : "not-configured");
    });
    // 切换厂商后动态列表失效（属于上一厂商端点的模型），回到静态预设列表
    setDynamicModels(null);
    setFetchStatus("idle");
    setFetchDetail("");
    return () => { alive = false; };
  }, [providerPreset]);

  /** v0.7.2 P1：保存 API Key 到当前厂商的 keyring 条目（成功后清空输入并显示已配置） */
  const handleSaveKey = async () => {
    const key = apiKey.trim();
    if (!key) return;
    try {
      await translateService.setKey(providerPreset, key);
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
      await translateService.testConnection(providerPreset, settings.translate.translateBaseUrl, settings.translate.translateModel);
      setTestStatus("ok");
    } catch (e) {
      setTestStatus("fail");
      const detail = e instanceof Error ? e.message.split(": ").slice(1).join(": ") : String(e);
      setTestDetail(detail);
    }
  };

  /**
   * v0.7.2 P2：获取模型列表（GET {baseUrl}/models）。
   * 成功 → 动态列表填充下拉；失败/空列表 → 回退静态预设列表并提示原因。
   */
  const handleFetchModels = async () => {
    setFetchStatus("fetching");
    setFetchDetail("");
    try {
      const ids = await translateService.listModels(providerPreset, settings.translate.translateBaseUrl);
      if (ids.length > 0) {
        setDynamicModels(ids);
        setFetchStatus("ok");
        // 自动展开完整候选浮层（datalist 会按输入框文本过滤，无法展示全量）
        setModelMenuOpen(true);
      } else {
        // 端点返回空列表：视为不支持，回退静态列表
        setDynamicModels(null);
        setFetchStatus("fail");
        setFetchDetail(t("settings.translate.fetchModelsEmpty"));
      }
    } catch (e) {
      setDynamicModels(null);
      setFetchStatus("fail");
      setFetchDetail(e instanceof Error ? e.message.split(": ").slice(1).join(": ") : String(e));
    }
  };

  /** 翻译配置统一实时生效 */
  const setTranslate = (patch: Partial<TranslateSettings>) => {
    settings.setTranslateConfig(patch);
  };

  /** v0.7.0 修复1/2：全局 AI 总开关（实时生效） */
  const setAiEnabled = (v: boolean) => {
    settings.setAiEnabled(v);
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

            {/* v0.7.0 修复1/2：全局 AI 总开关（关闭后翻译/续写/润色/摘要全部入口静默，
                底部栏 AI 图标变灰；关闭时联动关闭下方翻译子开关） */}
            <div className="settings-field">
              <label>{t("settings.translate.enabled")}</label>
              <select
                className="settings-select"
                value={settings.aiEnabled ? "on" : "off"}
                onChange={(e) => setAiEnabled(e.target.value === "on")}
                data-testid="ai-enabled"
              >
                <option value="on">{t("settings.on")}</option>
                <option value="off">{t("settings.off")}</option>
              </select>
            </div>

            {/* v0.7.0 修复2：AI 翻译子开关（仅总开关开启后可操作）
                v0.7.3 U2：收纳为总开关下的缩进子项，总开关关闭时置灰并注明"由总开关控制" */}
            <div className="settings-field translate-sub-group">
              <label>
                {t("settings.translate.enabled.translate")}
                {!settings.aiEnabled && (
                  <span className="settings-hint" data-testid="translate-controlled-by-master">
                    {t("settings.translate.controlledByMaster")}
                  </span>
                )}
              </label>
              <select
                className="settings-select"
                value={settings.translate.translateEnabled ? "on" : "off"}
                onChange={(e) => setTranslate({ translateEnabled: e.target.value === "on" })}
                disabled={!settings.aiEnabled}
                data-testid="translate-enabled"
              >
                <option value="on">{t("settings.on")}</option>
                <option value="off">{t("settings.off")}</option>
              </select>
            </div>

            {/* 关闭时其余配置置灰（CSS pointer-events + opacity）；v0.7.0：跟随全局 AI 总开关
                v0.7.3 U2：配置块与子开关统一左缩进，体现"总开关 → 子功能"层级 */}
            <div className={`translate-config-fields translate-sub-group${settings.aiEnabled ? "" : " disabled"}`}>
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
                <option value="kimicode">{t("settings.translate.provider.kimicode")}</option>
                <option value="hunyuan">{t("settings.translate.provider.hunyuan")}</option>
                <option value="xunfei">{t("settings.translate.provider.xunfei")}</option>
                <option value="stepfun">{t("settings.translate.provider.stepfun")}</option>
                <option value="baidu">{t("settings.translate.provider.baidu")}</option>
                <option value="lingyi">{t("settings.translate.provider.lingyi")}</option>
                <option value="baichuan">{t("settings.translate.provider.baichuan")}</option>
                <option value="sensenova">{t("settings.translate.provider.sensenova")}</option>
                <option value="antling">{t("settings.translate.provider.antling")}</option>
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

            {/* 模型角色（点击输入框展开全量候选浮层；datalist 仅保留给手动输入联想） */}
            <div className="settings-field" style={{ position: "relative" }}>
              <label>{t("settings.translate.model")}</label>
              <div className="settings-inline-row">
                <input
                  type="text"
                  className="settings-select"
                  style={{ flex: 1, width: "auto" }}
                  list="translate-model-options"
                  value={settings.translate.translateModel}
                  onChange={(e) => setTranslate({ translateModel: e.target.value })}
                  onFocus={() => setModelMenuOpen(true)}
                  onBlur={() => setModelMenuOpen(false)}
                  spellCheck={false}
                  data-testid="translate-model"
                />
                {/* v0.7.2 P2：动态拉取厂商模型列表（厂商上下线模型后用户可自行刷新） */}
                <button
                  className="settings-btn secondary"
                  disabled={fetchStatus === "fetching" || !settings.translate.translateBaseUrl}
                  onClick={handleFetchModels}
                  data-testid="translate-fetch-models"
                >
                  {fetchStatus === "fetching" ? t("settings.translate.fetchingModels") : t("settings.translate.fetchModels")}
                </button>
              </div>
              <datalist id="translate-model-options" data-testid="translate-model-options">
                {(dynamicModels ?? TRANSLATE_PROVIDERS[providerPreset]?.models ?? []).map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              {/* v0.7.2 修复：datalist 原生行为会按输入框已有文本过滤选项（如 deepseek 拉取到
                  2 个模型但输入框已有值时只能看到 1 个），改为全量候选浮层：
                  点击输入框或拉取成功后展开，动态列表优先、无动态列表时显示静态预设 */}
              {modelMenuOpen && (dynamicModels ?? TRANSLATE_PROVIDERS[providerPreset]?.models ?? []).length > 0 && (
                <div className="translate-model-menu" data-testid="translate-model-menu">
                  <div className="translate-model-menu-header">
                    <span>
                      {dynamicModels
                        ? t("settings.translate.fetchModelsOk", { count: dynamicModels.length })
                        : t("settings.translate.modelMenuPreset")}
                    </span>
                    <button
                      type="button"
                      className="translate-model-menu-close"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => setModelMenuOpen(false)}
                      aria-label="close"
                      data-testid="translate-model-menu-close"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="translate-model-menu-list">
                    {(dynamicModels ?? TRANSLATE_PROVIDERS[providerPreset]?.models ?? []).map((m) => (
                      <button
                        key={m}
                        type="button"
                        className="translate-model-menu-item"
                        /* 阻止 mousedown 抢走 input 焦点（onBlur 会关浮层导致 click 不触发） */
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          setTranslate({ translateModel: m });
                          setModelMenuOpen(false);
                        }}
                        data-testid="translate-model-menu-item"
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {/* 拉取结果提示：成功显示数量；失败回退静态预设列表并显示原因 */}
              {fetchStatus === "ok" && (
                <div className="settings-hint translate-test-status ok" data-testid="translate-fetch-status">
                  {t("settings.translate.fetchModelsOk", { count: dynamicModels?.length ?? 0 })}
                </div>
              )}
              {fetchStatus === "fail" && (
                <div className="settings-hint translate-test-status fail" data-testid="translate-fetch-status">
                  {t("settings.translate.fetchModelsFail")}{fetchDetail ? `：${fetchDetail}` : ""}
                </div>
              )}
              {/* v0.7.2：kimi 海外端点说明（国内默认 api.moonshot.cn，海外手动切换地址） */}
              {providerPreset === "kimi" && (
                <div className="settings-hint" data-testid="translate-kimi-oversea-hint">
                  {t("settings.translate.kimiOverseaHint")}
                </div>
              )}
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

            {/* v0.7.3：采样温度（0~2）。修复 kimi 等仅允许 temperature=1 的厂商 400 报错 */}
            <div className="settings-field">
              <label>{t("settings.translate.temperature")}</label>
              <div className="settings-inline-row">
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.1}
                  value={settings.translate.translateTemperature}
                  onChange={(e) => setTranslate({ translateTemperature: Number(e.target.value) })}
                  style={{ flex: 1 }}
                  data-testid="translate-temperature"
                />
                <code className="settings-hint" style={{ minWidth: 34, textAlign: "right" }}>
                  {settings.translate.translateTemperature.toFixed(1)}
                </code>
              </div>
              {providerPreset === "kimi" || providerPreset === "kimicode" ? (
                <div className="settings-hint" data-testid="translate-temperature-kimi-hint">
                  {t("settings.translate.temperatureKimiHint")}
                </div>
              ) : (
                <div className="settings-hint" data-testid="translate-temperature-hint">
                  {t("settings.translate.temperatureHint")}
                </div>
              )}
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

            {/* v0.7.5 功能3：「译」选区浮动气泡颜色（空串 = 跟随主题默认色）。
                与「译」入口子设置面板（FullTranslateButton）读写同一字段，单源。 */}
            <div className="settings-field">
              <label>{t("settings.translate.bubbleColor")}</label>
              <div className="settings-inline-row">
                <input
                  type="color"
                  value={settings.translate.translateBubbleColor || "#4a9eff"}
                  onChange={(e) => setTranslate({ translateBubbleColor: e.target.value })}
                  data-testid="translate-bubble-color"
                />
                <button
                  type="button"
                  className="settings-btn secondary"
                  onClick={() => setTranslate({ translateBubbleColor: "" })}
                  data-testid="translate-bubble-color-reset"
                >
                  {t("settings.translate.bubbleColorReset")}
                </button>
                <span className="settings-hint">{t("settings.translate.bubbleColorHint")}</span>
              </div>
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
