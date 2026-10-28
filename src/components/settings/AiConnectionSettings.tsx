/**
 * v0.15.0 R3c：AI 连接档案管理（设计 §1.1 的 profile 管理 UI）。
 *
 * ## 职责边界
 * - 只读写 `useSettingsStore.ai`（经 `setAiSettings`），**不改 store / aiProfiles / locales**；
 * - **不持有任何 API Key 明文**：Key 只在输入框里短暂存在，保存后立刻清空，
 *   且只经 `AiCredentialStore` 写入系统凭据库，绝不进 persist；
 * - 校验全部委托 `validateAiConnectionProfile`（机器码），文案映射见 `aiValidationMessages`。
 *
 * ## 几个刻意的取舍
 * 1. **温度/推理档位可空**（设计 §1.1：`undefined` = 请求里不发送）。空输入框是
 *    合法状态，不是"未填写"—— 推理类模型对 temperature 敏感，默认就不该发；
 * 2. **Ollama 预设 `authMode: "none"`**：UI 不显示 Key 输入区，也不写任何占位 Key
 *    （Rust 侧 `authorization_header` 对 none 直接返回 None）；
 * 3. **预设只填端点与协议，模型 ID 留空**：不硬编码未核实的模型名（设计 §6）；
 * 4. **复制档案换新 credentialId**：否则两个档案共用同一 keyring 槽位。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useSettingsStore } from "../../stores/useSettingsStore";
import {
  isAiTokenBudgetValid,
  validateAiConnectionProfile,
  type AiConnectionProfile,
  type AiSettings,
  type ApiProtocol,
  type ReasoningEffort,
  type TokenField,
} from "../../services/aiProfiles";
import {
  AI_PROFILE_PRESETS,
  appendProfile,
  createProfileFromPreset,
  duplicateProfile,
  hasProfiles,
  moveProfile,
  parsePositiveIntInput,
  parseTemperatureInput,
  removeProfile,
  setActiveProfile,
  updateProfile,
} from "./aiProfileOps";
import { credentialErrorKey, type AiCredentialStore } from "./aiCredentialStore";
import { validationErrorKey } from "./aiValidationMessages";
import "./aiSettingsShared.css";
import "./AiConnectionSettings.css";

/** 推理档位选项（仅 openai-chat 有效；anthropic 不发送、不做臆测映射） */
const REASONING_EFFORTS: readonly ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];

export interface AiConnectionSettingsProps {
  /**
   * 凭据存取实现。默认用 `createDefaultCredentialStore()`（复用翻译服务的 keyring 通道）。
   * 传入内存实现即可在测试/预览里完全脱离系统凭据库。
   */
  credentialStore?: AiCredentialStore;
}

/** 温度输入框的本地文本状态（提交后才写 store，避免中间态 NaN 落库） */
function temperatureText(profile: AiConnectionProfile): string {
  const value = profile.requestPolicy.temperature;
  return value === undefined ? "" : String(value);
}

export function AiConnectionSettings({ credentialStore }: AiConnectionSettingsProps = {}) {
  const t = useT();
  const ai = useSettingsStore((s) => s.ai);
  const setAiSettings = useSettingsStore((s) => s.setAiSettings);

  /** 当前选中的档案（列表点击项；默认跟随 activeProfileId） */
  const [selectedId, setSelectedId] = useState<string>(() => ai?.activeProfileId ?? "");

  /** 默认凭据实现（懒建一次；测试传入 mock 时完全不创建） */
  const defaultStoreRef = useRef<AiCredentialStore | null>(null);
  const store = useMemo<AiCredentialStore>(() => {
    if (credentialStore) return credentialStore;
    if (!defaultStoreRef.current) {
      // 动态 import 太重，这里直接引用模块级工厂（无副作用）
      defaultStoreRef.current = createLazyDefaultStore();
    }
    return defaultStoreRef.current;
  }, [credentialStore]);

  /** 每个 credentialId 的 Key 状态（只存布尔，绝无明文） */
  const [keyConfigured, setKeyConfigured] = useState<Record<string, boolean>>({});
  /** 用户正在输入的 Key（提交后立刻清空，不留存） */
  const [keyInput, setKeyInput] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyMessage, setKeyMessage] = useState<{ kind: "ok" | "error"; key: string } | null>(null);

  const profiles = ai?.profiles ?? [];
  const current = useMemo(
    () => profiles.find((profile) => profile.id === selectedId) ?? profiles[0] ?? null,
    [profiles, selectedId],
  );

  // activeProfileId 变化（切档案/迁移）时同步选中项；选中的档案被删时回落到第一个
  useEffect(() => {
    if (!profiles.length) {
      if (selectedId !== "") setSelectedId("");
      return;
    }
    if (!profiles.some((profile) => profile.id === selectedId)) {
      setSelectedId(ai?.activeProfileId && profiles.some((p) => p.id === ai.activeProfileId) ? ai.activeProfileId : profiles[0]!.id);
    }
  }, [profiles, selectedId, ai?.activeProfileId]);

  // 选中档案变化时探测 Key 状态（authMode=none 不探测）
  useEffect(() => {
    if (!current || current.authMode === "none") return;
    const id = current.credentialId;
    let alive = true;
    store
      .has(id)
      .then((ok) => {
        if (alive) setKeyConfigured((prev) => ({ ...prev, [id]: ok }));
      })
      .catch(() => {
        if (alive) setKeyConfigured((prev) => ({ ...prev, [id]: false }));
      });
    return () => {
      alive = false;
    };
  }, [current, store]);

  // 切档案时清掉上一条的 Key 输入与提示（避免串档案）
  useEffect(() => {
    setKeyInput("");
    setKeyMessage(null);
  }, [selectedId]);

  /** 写回整个 ai 配置（唯一出口；不改 store 定义） */
  const commit = useCallback(
    (next: AiSettings) => {
      setAiSettings(next);
    },
    [setAiSettings],
  );

  /** 带类型守卫的 ai 配置（store 迁移保证存在，这里只做防御） */
  const ensureAi = useCallback((): AiSettings => {
    if (ai) return ai;
    return { profiles: [], activeProfileId: "", instructions: [] };
  }, [ai]);

  // ─── 档案增删改 ──────────────────────────────────────────
  const handleAdd = useCallback(
    (presetId: string) => {
      const preset = AI_PROFILE_PRESETS.find((item) => item.id === presetId);
      const name = preset ? t(preset.nameKey) : t("settings.ai.profile.newName");
      const created = createProfileFromPreset(presetId, name);
      const next = appendProfile(ensureAi(), created);
      commit(next);
      setSelectedId(created.id);
    },
    [commit, ensureAi, t],
  );

  const handleDuplicate = useCallback(() => {
    if (!current) return;
    const copied = duplicateProfile(current, t("settings.ai.profile.copyName", { name: current.name }));
    commit(appendProfile(ensureAi(), copied));
    setSelectedId(copied.id);
  }, [commit, current, ensureAi, t]);

  const handleRemove = useCallback(() => {
    if (!current) return;
    const next = removeProfile(ensureAi(), current.id);
    commit(next);
    setSelectedId(next.activeProfileId || next.profiles[0]?.id || "");
  }, [commit, current, ensureAi]);

  const handleSetActive = useCallback(() => {
    if (!current) return;
    commit(setActiveProfile(ensureAi(), current.id));
  }, [commit, current, ensureAi]);

  const handleMove = useCallback(
    (direction: -1 | 1) => {
      if (!current) return;
      commit(moveProfile(ensureAi(), current.id, direction));
    },
    [commit, current, ensureAi],
  );

  /** 字段更新（不改 id/credentialId） */
  const patch = useCallback(
    (patchValue: Partial<AiConnectionProfile>) => {
      if (!current) return;
      commit(updateProfile(ensureAi(), current.id, patchValue));
    },
    [commit, current, ensureAi],
  );

  /** requestPolicy 局部更新（温度空值要真的变成 undefined = 不发送） */
  const patchPolicy = useCallback(
    (patchValue: Partial<AiConnectionProfile["requestPolicy"]>) => {
      if (!current) return;
      patch({ requestPolicy: { ...current.requestPolicy, ...patchValue } });
    },
    [current, patch],
  );

  // ─── Key 设置 / 清除 ────────────────────────────────────
  const handleSaveKey = useCallback(async () => {
    if (!current) return;
    const key = keyInput.trim();
    if (!key) return;
    setKeyBusy(true);
    setKeyMessage(null);
    try {
      await store.save(current.credentialId, key);
      setKeyInput("");
      setKeyConfigured((prev) => ({ ...prev, [current.credentialId]: true }));
      setKeyMessage({ kind: "ok", key: "settings.ai.apiKey.saved" });
    } catch (error) {
      setKeyMessage({ kind: "error", key: credentialErrorKey(error) });
    } finally {
      setKeyBusy(false);
    }
  }, [current, keyInput, store]);

  const handleClearKey = useCallback(async () => {
    if (!current || !store.clear) return;
    setKeyBusy(true);
    setKeyMessage(null);
    try {
      await store.clear(current.credentialId);
      setKeyConfigured((prev) => ({ ...prev, [current.credentialId]: false }));
      setKeyMessage({ kind: "ok", key: "settings.ai.apiKey.cleared" });
    } catch (error) {
      setKeyMessage({ kind: "error", key: credentialErrorKey(error) });
    } finally {
      setKeyBusy(false);
    }
  }, [current, store]);

  // ─── 校验 ──────────────────────────────────────────────
  const errors = current ? validateAiConnectionProfile(current) : [];
  const budgetValid = current ? isAiTokenBudgetValid(current) : true;
  const sortedErrors = useMemo(() => {
    // 去重：contextWindow/maxOutput 会一起报，展示上按顺序更易读
    const seen = new Set<string>();
    const keys: string[] = [];
    for (const code of errors) {
      const key = validationErrorKey(code);
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
    return keys;
  }, [errors]);

  // ─── 空态 ─────────────────────────────────────────────
  if (!hasProfiles(ai)) {
    return (
      <section className="settings-section ai-settings" data-testid="ai-connection-section">
        <h3>{t("settings.ai.title")}</h3>
        <div className="ai-empty" data-testid="ai-empty-state">
          <p className="ai-empty-title">{t("settings.ai.empty.title")}</p>
          <p className="ai-empty-hint">{t("settings.ai.empty.hint")}</p>
          <div className="ai-empty-actions">
            {AI_PROFILE_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className="ai-btn ai-btn-primary"
                onClick={() => handleAdd(preset.id)}
                data-testid={`ai-empty-add-${preset.id}`}
              >
                {t(preset.nameKey)}
              </button>
            ))}
          </div>
        </div>
      </section>
    );
  }

  if (!current) return null;

  const isActive = ai?.activeProfileId === current.id;
  const needsKey = current.authMode !== "none";
  const hasKey = keyConfigured[current.credentialId] === true;
  const keyStatusUnknown = needsKey && keyConfigured[current.credentialId] === undefined;
  const clearSupported = typeof store.clear === "function";

  return (
    <section className="settings-section ai-settings" data-testid="ai-connection-section">
      <h3>{t("settings.ai.title")}</h3>
      <small className="settings-hint">{t("settings.ai.hint")}</small>

      <div className="ai-layout">
        {/* 左：档案列表 */}
        <div className="ai-profile-list" role="listbox" aria-label={t("settings.ai.profiles")}>
          {profiles.map((profile) => {
            const selected = profile.id === current.id;
            const active = profile.id === ai?.activeProfileId;
            return (
              <button
                key={profile.id}
                type="button"
                role="option"
                aria-selected={selected}
                className={`ai-profile-item${selected ? " is-selected" : ""}`}
                onClick={() => setSelectedId(profile.id)}
                data-testid={`ai-profile-item-${profile.id}`}
              >
                <span className="ai-profile-name">{profile.name || t("settings.ai.profile.unnamed")}</span>
                {active && (
                  <span className="ai-profile-badge" data-testid="ai-profile-active-badge">
                    {t("settings.ai.profile.active")}
                  </span>
                )}
                {profile.authMode === "none" && (
                  <span className="ai-profile-badge ai-profile-badge-muted">{t("settings.ai.profile.noAuth")}</span>
                )}
              </button>
            );
          })}
        </div>

        {/* 右：编辑区 */}
        <div className="ai-profile-editor">
          <div className="ai-profile-toolbar">
            <select
              className="settings-select ai-preset-select"
              value=""
              onChange={(e) => {
                if (e.target.value) handleAdd(e.target.value);
              }}
              data-testid="ai-add-profile-preset"
              aria-label={t("settings.ai.profile.add")}
            >
              <option value="">{t("settings.ai.profile.add")}</option>
              {AI_PROFILE_PRESETS.filter((preset) => preset.id !== "blank").map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {t(preset.nameKey)}
                </option>
              ))}
            </select>
            <button type="button" className="ai-btn" onClick={handleDuplicate} data-testid="ai-profile-duplicate">
              {t("settings.ai.profile.duplicate")}
            </button>
            <button
              type="button"
              className="ai-btn"
              onClick={handleRemove}
              data-testid="ai-profile-remove"
            >
              {t("settings.ai.profile.remove")}
            </button>
            <button
              type="button"
              className="ai-btn"
              onClick={() => handleMove(-1)}
              data-testid="ai-profile-move-up"
              aria-label={t("settings.ai.profile.moveUp")}
            >
              ↑
            </button>
            <button
              type="button"
              className="ai-btn"
              onClick={() => handleMove(1)}
              data-testid="ai-profile-move-down"
              aria-label={t("settings.ai.profile.moveDown")}
            >
              ↓
            </button>
            <button
              type="button"
              className="ai-btn"
              onClick={handleSetActive}
              disabled={isActive}
              data-testid="ai-profile-set-active"
            >
              {isActive ? t("settings.ai.profile.isActive") : t("settings.ai.profile.setActive")}
            </button>
          </div>

          {/* 基础字段 */}
          <div className="settings-field">
            <label htmlFor="ai-profile-name">{t("settings.ai.field.name")}</label>
            <input
              id="ai-profile-name"
              className="ai-input"
              type="text"
              value={current.name}
              onChange={(e) => patch({ name: e.target.value })}
              data-testid="ai-profile-name"
            />
          </div>

          <div className="settings-field">
            <label htmlFor="ai-profile-protocol">{t("settings.ai.field.protocol")}</label>
            <select
              id="ai-profile-protocol"
              className="settings-select"
              value={current.protocol}
              onChange={(e) => patch({ protocol: e.target.value as ApiProtocol })}
              data-testid="ai-profile-protocol"
            >
              <option value="openai-chat">{t("settings.ai.protocol.openaiChat")}</option>
              <option value="anthropic-messages">{t("settings.ai.protocol.anthropicMessages")}</option>
            </select>
          </div>

          <div className="settings-field">
            <label htmlFor="ai-profile-base-url">{t("settings.ai.field.baseUrl")}</label>
            <input
              id="ai-profile-base-url"
              className="ai-input ai-input-mono"
              type="text"
              value={current.baseUrl}
              placeholder="https://host/api/plan[/v3]"
              onChange={(e) => patch({ baseUrl: e.target.value })}
              spellCheck={false}
              data-testid="ai-profile-base-url"
            />
            <small className="settings-hint">{t("settings.ai.field.baseUrlHint")}</small>
          </div>

          <div className="settings-field">
            <label htmlFor="ai-profile-model">{t("settings.ai.field.model")}</label>
            <input
              id="ai-profile-model"
              className="ai-input ai-input-mono"
              type="text"
              value={current.model}
              // 预设一律留空：模型 ID 以用户账户/文档为准，不硬编码
              placeholder={t("settings.ai.field.modelPlaceholder")}
              onChange={(e) => patch({ model: e.target.value })}
              spellCheck={false}
              data-testid="ai-profile-model"
            />
            <small className="settings-hint">{t("settings.ai.field.modelHint")}</small>
          </div>

          {/* Token 预算 */}
          <div className="ai-field-row">
            <div className="settings-field">
              <label htmlFor="ai-profile-context">{t("settings.ai.field.contextWindow")}</label>
              <input
                id="ai-profile-context"
                className="ai-input"
                type="number"
                min={1}
                step={1024}
                value={current.contextWindowTokens}
                onChange={(e) => {
                  const parsed = parsePositiveIntInput(e.target.value);
                  // 中间态（空串/"3"）不落库：保持上次有效值，等用户输完
                  if (parsed !== null) patch({ contextWindowTokens: parsed });
                }}
                data-testid="ai-profile-context"
              />
            </div>
            <div className="settings-field">
              <label htmlFor="ai-profile-max-output">{t("settings.ai.field.maxOutput")}</label>
              <input
                id="ai-profile-max-output"
                className="ai-input"
                type="number"
                min={1}
                step={256}
                value={current.maxOutputTokens}
                onChange={(e) => {
                  const parsed = parsePositiveIntInput(e.target.value);
                  if (parsed !== null) patch({ maxOutputTokens: parsed });
                }}
                data-testid="ai-profile-max-output"
              />
            </div>
          </div>
          <small className={`settings-hint${budgetValid ? "" : " settings-hint-warning"}`} data-testid="ai-budget-hint">
            {budgetValid ? t("settings.ai.field.budgetHint") : t("settings.ai.field.budgetInvalid")}
          </small>

          {/* 请求策略 */}
          <div className="ai-field-row">
            <div className="settings-field">
              <label htmlFor="ai-profile-token-field">{t("settings.ai.field.tokenField")}</label>
              <select
                id="ai-profile-token-field"
                className="settings-select"
                value={current.requestPolicy.tokenField}
                onChange={(e) => patchPolicy({ tokenField: e.target.value as TokenField })}
                data-testid="ai-profile-token-field"
              >
                <option value="max_tokens">max_tokens</option>
                <option value="max_completion_tokens">max_completion_tokens</option>
              </select>
            </div>
            <div className="settings-field">
              <label htmlFor="ai-profile-temperature">{t("settings.ai.field.temperature")}</label>
              <input
                id="ai-profile-temperature"
                className="ai-input"
                type="text"
                inputMode="decimal"
                value={temperatureText(current)}
                // 空 = 不发送 temperature（推理类模型默认），placeholder 说明这一点
                placeholder={t("settings.ai.field.temperaturePlaceholder")}
                onChange={(e) => {
                  const parsed = parseTemperatureInput(e.target.value);
                  // 非法输入不写库（0~2 之外），保持上次有效值
                  if (parsed.ok) patchPolicy({ temperature: parsed.value });
                }}
                data-testid="ai-profile-temperature"
              />
            </div>
          </div>

          <div className="settings-field">
            <label htmlFor="ai-profile-reasoning">{t("settings.ai.field.reasoningEffort")}</label>
            <select
              id="ai-profile-reasoning"
              className="settings-select"
              value={current.requestPolicy.reasoningEffort ?? ""}
              onChange={(e) =>
                patchPolicy({
                  // 空选项 = undefined = 请求里不发送
                  reasoningEffort: (e.target.value || undefined) as ReasoningEffort | undefined,
                })
              }
              disabled={current.protocol !== "openai-chat"}
              data-testid="ai-profile-reasoning"
            >
              <option value="">{t("settings.ai.field.reasoningEffortNone")}</option>
              {REASONING_EFFORTS.map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </select>
            <small className="settings-hint">
              {current.protocol === "openai-chat"
                ? t("settings.ai.field.reasoningEffortHint")
                : t("settings.ai.field.reasoningEffortNotApplicable")}
            </small>
          </div>

          <div className="settings-field">
            <label className="settings-switch">
              <input
                type="checkbox"
                checked={current.requestPolicy.includeStreamUsage}
                onChange={(e) => patchPolicy({ includeStreamUsage: e.target.checked })}
                data-testid="ai-profile-include-usage"
              />
              <span className="settings-switch-slider" />
              <span className="settings-switch-label">{t("settings.ai.field.includeStreamUsage")}</span>
            </label>
            <small className="settings-hint">{t("settings.ai.field.includeStreamUsageHint")}</small>
          </div>

          {/* 本档案 system prompt（可空） */}
          <div className="settings-field">
            <label htmlFor="ai-profile-system-prompt">{t("settings.ai.field.systemPrompt")}</label>
            <textarea
              id="ai-profile-system-prompt"
              className="ai-textarea"
              rows={4}
              value={current.systemPrompt ?? ""}
              placeholder={t("settings.ai.field.systemPromptPlaceholder")}
              onChange={(e) => patch({ systemPrompt: e.target.value || undefined })}
              spellCheck={false}
              data-testid="ai-profile-system-prompt"
            />
            <small className="settings-hint">{t("settings.ai.field.systemPromptHint")}</small>
          </div>

          {/* API Key：只有"设置/清除"入口，绝不回显明文 */}
          <div className="settings-field ai-key-field">
            <label htmlFor="ai-profile-key">{t("settings.ai.apiKey.label")}</label>
            {!needsKey ? (
              <small className="settings-hint" data-testid="ai-key-not-needed">
                {t("settings.ai.apiKey.notNeeded")}
              </small>
            ) : (
              <>
                <div className="ai-key-row">
                  <input
                    id="ai-profile-key"
                    className="ai-input ai-input-mono"
                    type="password"
                    autoComplete="off"
                    value={keyInput}
                    placeholder={t("settings.ai.apiKey.placeholder")}
                    onChange={(e) => setKeyInput(e.target.value)}
                    // 明文只在内存里存活于输入框；提交后立刻清空
                    spellCheck={false}
                    data-testid="ai-profile-key-input"
                  />
                  <button
                    type="button"
                    className="ai-btn ai-btn-primary"
                    onClick={() => void handleSaveKey()}
                    disabled={keyBusy || !keyInput.trim()}
                    data-testid="ai-profile-key-save"
                  >
                    {t("settings.ai.apiKey.save")}
                  </button>
                  <button
                    type="button"
                    className="ai-btn"
                    onClick={() => void handleClearKey()}
                    disabled={keyBusy || !hasKey || !clearSupported}
                    title={clearSupported ? undefined : t("settings.ai.apiKey.clearUnsupported")}
                    data-testid="ai-profile-key-clear"
                  >
                    {t("settings.ai.apiKey.clear")}
                  </button>
                </div>
                <small className="settings-hint" data-testid="ai-key-status">
                  {keyStatusUnknown
                    ? t("settings.ai.apiKey.statusChecking")
                    : hasKey
                      ? t("settings.ai.apiKey.statusConfigured")
                      : t("settings.ai.apiKey.statusNotConfigured")}
                </small>
                {!clearSupported && (
                  <small className="settings-hint settings-hint-warning" data-testid="ai-key-clear-unsupported">
                    {t("settings.ai.apiKey.clearUnsupported")}
                  </small>
                )}
              </>
            )}
            <small className="settings-hint">{t("settings.ai.apiKey.neverShown")}</small>
            {keyMessage && (
              <small
                className={`ai-key-message${keyMessage.kind === "error" ? " is-error" : ""}`}
                data-testid="ai-key-message"
              >
                {t(keyMessage.key)}
              </small>
            )}
          </div>

          {/* 校验提示 */}
          {sortedErrors.length > 0 && (
            <ul className="ai-error-list" data-testid="ai-error-list">
              {sortedErrors.map((key) => (
                <li key={key}>{t(key)}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * 默认凭据实现（懒建一次）。
 *
 * 不在模块顶部直接 `createDefaultCredentialStore()`：那会在**模块加载时**就
 * import translateService（连带拉起 Tauri IPC 链）。测试里虽然注入了 mock，
 * 但任何只 import 本模块的用例都会白白拉起这条链；延迟到真正需要时才建。
 */
function createLazyDefaultStore(): AiCredentialStore {
  let real: AiCredentialStore | null = null;
  const ensure = async (): Promise<AiCredentialStore> => {
    if (!real) {
      const mod = await import("./aiCredentialStore");
      real = mod.createDefaultCredentialStore();
    }
    return real;
  };
  return {
    has: async (credentialId: string) => (await ensure()).has(credentialId),
    save: async (credentialId: string, key: string) => (await ensure()).save(credentialId, key),
    // clear 仍不提供（后端无删除 keyring 条目的命令）；组件据 store.clear 是否存在禁用按钮
  };
}

export default AiConnectionSettings;
