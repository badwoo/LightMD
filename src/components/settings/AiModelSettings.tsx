import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { aiConnectionService } from "../../services/aiConnectionService";
import {
  applyLocalDeployment,
  applyModelSelection,
  contextSliderStops,
  createCustomProfileDraft,
  CUSTOM_PROVIDER_ID_PATTERN,
  findLocalDeploymentPreset,
  formatTokenCount,
  inferProviderId,
  mergeModelCatalog,
  upsertProviderProfile,
} from "../../services/aiModelCatalog";
import {
  AI_DEFAULT_PROVIDER_ID,
  findAiProviderPreset,
  groupAiProviderPresets,
} from "../../services/aiProviderPresets";
import {
  isLocalDeploymentKind,
  LOCAL_DEPLOYMENT_KINDS,
  validateAiConnectionProfile,
  type AiConnectionProfile,
  type AiModelCatalogEntry,
  type AiSettings,
  type ApiProtocol,
  type LocalDeploymentKind,
  type ReasoningEffort,
} from "../../services/aiProfiles";
import { credentialErrorKey, type AiCredentialStore } from "./aiCredentialStore";
import "./aiSettingsShared.css";
import "./AiModelSettings.css";

const CUSTOM_REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "off",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const PROTOCOLS: readonly ApiProtocol[] = [
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
];

type ModelTab = "provider" | "custom";
type Notice = { kind: "success" | "error"; key: string };
type KeyDraft = { credentialId: string; value: string };

export interface AiModelSettingsProps {
  /** 测试或预览可注入内存实现；组件只接触布尔状态，不读取凭据明文。 */
  credentialStore?: AiCredentialStore;
}

function emptyAiSettings(): AiSettings {
  return { profiles: [], activeProfileId: "", instructions: [] };
}

function cloneProfile(profile: AiConnectionProfile): AiConnectionProfile {
  return {
    ...profile,
    requestPolicy: { ...profile.requestPolicy },
    modelCatalog: profile.modelCatalog?.map((entry) => ({ ...entry })),
  };
}

function asCustomDraft(profile: AiConnectionProfile): AiConnectionProfile {
  return { ...cloneProfile(profile), providerId: inferProviderId(profile) };
}

function isCustomProfile(profile: AiConnectionProfile): boolean {
  return !findAiProviderPreset(inferProviderId(profile));
}

function clampOutputTokens(maxOutputTokens: number, contextWindowTokens: number): number {
  return Math.max(1, Math.min(maxOutputTokens, contextWindowTokens - 1));
}

/** 默认凭据实现延迟到首次使用时加载，纯 UI 测试不会因此拉起 Tauri IPC。 */
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
    has: async (credentialId) => (await ensure()).has(credentialId),
    save: async (credentialId, key) => (await ensure()).save(credentialId, key),
    clear: async (credentialId) => {
      const store = await ensure();
      await store.clear?.(credentialId);
    },
  };
}

export function AiModelSettings({ credentialStore }: AiModelSettingsProps = {}) {
  const t = useT();
  const idPrefix = useId();
  const ai = useSettingsStore((state) => state.ai);
  const setAiSettings = useSettingsStore((state) => state.setAiSettings);
  const profiles = useMemo(() => ai?.profiles ?? [], [ai?.profiles]);
  const activeProfile = useMemo(
    () => profiles.find((profile) => profile.id === ai?.activeProfileId) ?? profiles[0] ?? null,
    [ai?.activeProfileId, profiles],
  );

  const [tab, setTab] = useState<ModelTab>(() =>
    activeProfile && isCustomProfile(activeProfile) ? "custom" : "provider",
  );
  const [providerNotice, setProviderNotice] = useState<Notice | null>(null);
  const [customNotice, setCustomNotice] = useState<Notice | null>(null);
  const [keyConfigured, setKeyConfigured] = useState<Record<string, boolean>>({});
  const [providerKeyDraft, setProviderKeyDraft] = useState<KeyDraft>({ credentialId: "", value: "" });
  const [customKeyDraft, setCustomKeyDraft] = useState<KeyDraft>({ credentialId: "", value: "" });
  const [providerKeyBusy, setProviderKeyBusy] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [customFetchingModels, setCustomFetchingModels] = useState(false);
  const [customTestingConnection, setCustomTestingConnection] = useState(false);
  const [savingCustom, setSavingCustom] = useState(false);

  const defaultStoreRef = useRef<AiCredentialStore | null>(null);
  const store = useMemo<AiCredentialStore>(() => {
    if (credentialStore) return credentialStore;
    if (!defaultStoreRef.current) defaultStoreRef.current = createLazyDefaultStore();
    return defaultStoreRef.current;
  }, [credentialStore]);

  const customProfiles = useMemo(() => profiles.filter(isCustomProfile), [profiles]);
  const [customDraft, setCustomDraft] = useState<AiConnectionProfile>(() =>
    activeProfile && isCustomProfile(activeProfile)
      ? asCustomDraft(activeProfile)
      : createCustomProfileDraft(),
  );
  const customIsNew = customDraft.id === "";

  /**
   * v0.15.4 需求 3：当前启用的是自定义档案时自动切到自定义页签。
   *
   * 只切页签；仅当草稿指向别的档案时才重载草稿（保存后 draft.id 已是新档案，
   * 因此不会把刚写入的「已保存」提示清掉）。
   */
  useEffect(() => {
    if (!activeProfile || !isCustomProfile(activeProfile)) return;
    setTab("custom");
    if (customDraft.id !== activeProfile.id) {
      setCustomDraft(asCustomDraft(activeProfile));
      setCustomKeyDraft({ credentialId: "", value: "" });
      setCustomNotice(null);
    }
    // customDraft 只作为比较基线，不参与触发条件：草稿输入不应导致页签重载。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProfile?.id]);

  /** 空配置只在新装/被清空的防御路径出现；默认仍落到本地 Ollama。 */
  useEffect(() => {
    if (profiles.length > 0) return;
    const preset = findAiProviderPreset(AI_DEFAULT_PROVIDER_ID);
    if (!preset) return;
    const latest = useSettingsStore.getState().ai ?? emptyAiSettings();
    if (latest.profiles.length > 0) return;
    const next = upsertProviderProfile(latest, preset, t(preset.nameKey));
    setAiSettings(next.settings);
  }, [profiles.length, setAiSettings, t]);

  const effectiveCustomCredentialId = customDraft.credentialId?.trim()
    || customDraft.providerId?.trim()
    || "custom-draft";
  const providerCredentialId = activeProfile && activeProfile.authMode !== "none"
    ? activeProfile.credentialId
    : "";
  const customCredentialId = tab === "custom" && !customIsNew ? customDraft.credentialId : "";

  /** 只探测是否存在，绝不把凭据内容读入 React 状态。 */
  useEffect(() => {
    const ids = Array.from(new Set([providerCredentialId, customCredentialId].filter(Boolean)));
    if (!ids.length) return;
    let alive = true;
    for (const credentialId of ids) {
      store.has(credentialId)
        .then((configured) => {
          if (alive) setKeyConfigured((previous) => ({ ...previous, [credentialId]: configured }));
        })
        .catch(() => {
          if (alive) setKeyConfigured((previous) => ({ ...previous, [credentialId]: false }));
        });
    }
    return () => { alive = false; };
  }, [customCredentialId, providerCredentialId, store]);

  const updateProfile = useCallback((
    profileId: string,
    update: (profile: AiConnectionProfile) => AiConnectionProfile,
  ) => {
    const latest = useSettingsStore.getState().ai ?? emptyAiSettings();
    let found = false;
    const nextProfiles = latest.profiles.map((profile) => {
      if (profile.id !== profileId) return profile;
      found = true;
      return update(profile);
    });
    if (found) setAiSettings({ ...latest, profiles: nextProfiles });
  }, [setAiSettings]);

  const patchActive = useCallback((patch: Partial<AiConnectionProfile>) => {
    if (!activeProfile) return;
    updateProfile(activeProfile.id, (profile) => ({ ...profile, ...patch }));
  }, [activeProfile, updateProfile]);

  const handleProviderChange = useCallback((providerId: string) => {
    const preset = findAiProviderPreset(providerId);
    if (!preset) return;
    const latest = useSettingsStore.getState().ai ?? emptyAiSettings();
    const next = upsertProviderProfile(latest, preset, t(preset.nameKey));
    setAiSettings(next.settings);
    setProviderKeyDraft({ credentialId: "", value: "" });
    setProviderNotice(null);
  }, [setAiSettings, t]);

  const handleFetchModels = useCallback(async () => {
    if (!activeProfile || fetchingModels) return;
    const profileId = activeProfile.id;
    setFetchingModels(true);
    setProviderNotice(null);
    try {
      const models = await aiConnectionService.listModels(activeProfile);
      updateProfile(profileId, (profile) => {
        // 服务商页签的目录是「端点的镜像」，没有手工编辑入口，因此以探测结果为准。
        const withCatalog = { ...profile, modelCatalog: models };
        return models.some((entry) => entry.id === profile.model)
          ? applyModelSelection(withCatalog, profile.model)
          : withCatalog;
      });
      if (useSettingsStore.getState().ai.activeProfileId === profileId) {
        setProviderNotice({ kind: "success", key: "settings.ai.model.status.fetchSuccess" });
      }
    } catch {
      if (useSettingsStore.getState().ai.activeProfileId === profileId) {
        setProviderNotice({ kind: "error", key: "settings.ai.model.status.fetchError" });
      }
    } finally {
      setFetchingModels(false);
    }
  }, [activeProfile, fetchingModels, updateProfile]);

  const handleTestConnection = useCallback(async () => {
    if (!activeProfile || testingConnection) return;
    const profileId = activeProfile.id;
    setTestingConnection(true);
    setProviderNotice(null);
    try {
      await aiConnectionService.testConnection(activeProfile);
      if (useSettingsStore.getState().ai.activeProfileId === profileId) {
        setProviderNotice({ kind: "success", key: "settings.ai.model.status.testSuccess" });
      }
    } catch {
      if (useSettingsStore.getState().ai.activeProfileId === profileId) {
        setProviderNotice({ kind: "error", key: "settings.ai.model.status.testError" });
      }
    } finally {
      setTestingConnection(false);
    }
  }, [activeProfile, testingConnection]);

  const handleSaveProviderKey = useCallback(async () => {
    if (!activeProfile || activeProfile.authMode === "none" || providerKeyBusy) return;
    const credentialId = activeProfile.credentialId;
    const key = providerKeyDraft.credentialId === credentialId ? providerKeyDraft.value.trim() : "";
    if (!key) return;
    setProviderKeyBusy(true);
    setProviderNotice(null);
    try {
      await store.save(credentialId, key);
      setProviderKeyDraft({ credentialId: "", value: "" });
      setKeyConfigured((previous) => ({ ...previous, [credentialId]: true }));
      setProviderNotice({ kind: "success", key: "settings.ai.apiKey.saved" });
    } catch (error) {
      setProviderNotice({ kind: "error", key: credentialErrorKey(error) });
    } finally {
      setProviderKeyBusy(false);
    }
  }, [activeProfile, providerKeyBusy, providerKeyDraft, store]);

  const handleClearProviderKey = useCallback(async () => {
    if (!activeProfile || !store.clear || providerKeyBusy) return;
    const credentialId = activeProfile.credentialId;
    setProviderKeyBusy(true);
    setProviderNotice(null);
    try {
      await store.clear(credentialId);
      setProviderKeyDraft({ credentialId: "", value: "" });
      setKeyConfigured((previous) => ({ ...previous, [credentialId]: false }));
      setProviderNotice({ kind: "success", key: "settings.ai.apiKey.cleared" });
    } catch (error) {
      setProviderNotice({ kind: "error", key: credentialErrorKey(error) });
    } finally {
      setProviderKeyBusy(false);
    }
  }, [activeProfile, providerKeyBusy, store]);

  const loadCustomDraft = useCallback((profileId: string) => {
    if (!profileId) {
      setCustomDraft(createCustomProfileDraft());
    } else {
      const latest = useSettingsStore.getState().ai ?? emptyAiSettings();
      const profile = latest.profiles.find((item) => item.id === profileId);
      if (profile && isCustomProfile(profile)) setCustomDraft(asCustomDraft(profile));
    }
    setCustomKeyDraft({ credentialId: "", value: "" });
    setCustomNotice(null);
  }, []);

  const patchCustom = useCallback((patch: Partial<AiConnectionProfile>) => {
    setCustomDraft((previous) => ({ ...previous, ...patch }));
    setCustomNotice(null);
  }, []);

  /** v0.15.4 需求 1：选中「本地部署类型」即预填端点/协议/鉴权。 */
  const handleCustomLocalKindChange = useCallback((raw: string) => {
    setCustomDraft((previous) => {
      if (!raw) {
        const next = { ...previous };
        delete next.localKind;
        return next;
      }
      return isLocalDeploymentKind(raw)
        ? applyLocalDeployment(previous, raw as LocalDeploymentKind)
        : previous;
    });
    setCustomNotice(null);
  }, []);

  const updateCustomEntry = useCallback((index: number, patch: Partial<AiModelCatalogEntry>) => {
    setCustomDraft((previous) => {
      const catalog = previous.modelCatalog ?? [];
      const oldEntry = catalog[index];
      if (!oldEntry) return previous;
      const nextCatalog = catalog.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, ...patch } : entry,
      );
      return {
        ...previous,
        modelCatalog: nextCatalog,
        model: patch.id !== undefined && Boolean(oldEntry.id) && previous.model === oldEntry.id
          ? patch.id
          : previous.model,
      };
    });
    setCustomNotice(null);
  }, []);

  const handleAddCustomModel = useCallback(() => {
    setCustomDraft((previous) => ({
      ...previous,
      modelCatalog: [
        ...(previous.modelCatalog ?? []),
        { id: "", name: "", reasoningEffort: "off" },
      ],
    }));
    setCustomNotice(null);
  }, []);

  const handleRemoveCustomModel = useCallback((index: number) => {
    setCustomDraft((previous) => {
      const catalog = previous.modelCatalog ?? [];
      const removed = catalog[index];
      return {
        ...previous,
        modelCatalog: catalog.filter((_, entryIndex) => entryIndex !== index),
        model: removed?.id === previous.model ? "" : previous.model,
      };
    });
    setCustomNotice(null);
  }, []);

  /** v0.15.4 需求 4：自定义页签用**草稿档案 + 临时 credentialId**探测模型列表。 */
  const handleCustomFetchModels = useCallback(async () => {
    if (customFetchingModels) return;
    const probeProfile: AiConnectionProfile = {
      ...cloneProfile(customDraft),
      id: customDraft.id || effectiveCustomCredentialId,
      providerId: (customDraft.providerId?.trim() || effectiveCustomCredentialId) as string,
      credentialId: effectiveCustomCredentialId,
    };
    setCustomFetchingModels(true);
    setCustomNotice(null);
    try {
      // 草稿里刚输入、尚未保存的 Key 需要先落到凭据槽，后端才能读到。
      const pendingKey = customKeyDraft.credentialId === (customDraft.id || "new")
        ? customKeyDraft.value.trim()
        : "";
      if (pendingKey && probeProfile.authMode !== "none") {
        await store.save(probeProfile.credentialId, pendingKey);
        setKeyConfigured((previous) => ({ ...previous, [probeProfile.credentialId]: true }));
      }
      const models = await aiConnectionService.listModels(probeProfile);
      setCustomDraft((previous) => {
        const withCatalog = {
          ...previous,
          modelCatalog: mergeModelCatalog(previous.modelCatalog, models),
        };
        return models.some((entry) => entry.id === previous.model)
          ? applyModelSelection(withCatalog, previous.model)
          : withCatalog;
      });
      setCustomNotice({ kind: "success", key: "settings.ai.model.status.fetchSuccess" });
    } catch {
      setCustomNotice({ kind: "error", key: "settings.ai.model.status.fetchError" });
    } finally {
      setCustomFetchingModels(false);
    }
  }, [customDraft, customFetchingModels, customKeyDraft, effectiveCustomCredentialId, store]);

  /** v0.15.4 需求 4：自定义页签测试连接（同样用草稿档案）。 */
  const handleCustomTestConnection = useCallback(async () => {
    if (customTestingConnection) return;
    if (!customDraft.model.trim()) {
      setCustomNotice({ kind: "error", key: "settings.ai.model.error.selectModel" });
      return;
    }
    const probeProfile: AiConnectionProfile = {
      ...cloneProfile(customDraft),
      id: customDraft.id || effectiveCustomCredentialId,
      providerId: (customDraft.providerId?.trim() || effectiveCustomCredentialId) as string,
      credentialId: effectiveCustomCredentialId,
    };
    setCustomTestingConnection(true);
    setCustomNotice(null);
    try {
      const pendingKey = customKeyDraft.credentialId === (customDraft.id || "new")
        ? customKeyDraft.value.trim()
        : "";
      if (pendingKey && probeProfile.authMode !== "none") {
        await store.save(probeProfile.credentialId, pendingKey);
        setKeyConfigured((previous) => ({ ...previous, [probeProfile.credentialId]: true }));
      }
      await aiConnectionService.testConnection(probeProfile);
      setCustomNotice({ kind: "success", key: "settings.ai.model.status.testSuccess" });
    } catch {
      setCustomNotice({ kind: "error", key: "settings.ai.model.status.testError" });
    } finally {
      setCustomTestingConnection(false);
    }
  }, [customDraft, customKeyDraft, customTestingConnection, effectiveCustomCredentialId, store]);

  const validateCustom = useCallback((draft: AiConnectionProfile): string | null => {
    const providerId = draft.providerId?.trim() ?? "";
    if (!CUSTOM_PROVIDER_ID_PATTERN.test(providerId)) return "settings.ai.model.error.providerId";
    const latest = useSettingsStore.getState().ai ?? emptyAiSettings();
    if (customIsNew && latest.profiles.some((profile) =>
      profile.id === providerId || inferProviderId(profile) === providerId
    )) {
      return "settings.ai.model.error.providerIdExists";
    }
    if (!draft.name.trim() || !draft.baseUrl.trim()) return "settings.ai.model.error.required";
    const catalog = draft.modelCatalog ?? [];
    const ids = new Set<string>();
    const validCatalog = catalog.length > 0 && catalog.every((entry) => {
      const id = entry.id.trim();
      const duplicate = ids.has(id);
      ids.add(id);
      const contextValid = entry.contextWindowTokens === undefined ||
        (Number.isSafeInteger(entry.contextWindowTokens) && entry.contextWindowTokens > 0);
      return Boolean(id) && !duplicate && Boolean(entry.name.trim()) && contextValid;
    });
    if (!validCatalog) return "settings.ai.model.error.catalog";
    if (!draft.model.trim() || !catalog.some((entry) => entry.id.trim() === draft.model.trim())) {
      return "settings.ai.model.error.selectModel";
    }
    return null;
  }, [customIsNew]);

  const handleSaveCustom = useCallback(async () => {
    if (savingCustom) return;
    const validationError = validateCustom(customDraft);
    if (validationError) {
      setCustomNotice({ kind: "error", key: validationError });
      return;
    }

    const providerId = customDraft.providerId!.trim();
    const profileId = customIsNew ? providerId : customDraft.id;
    const credentialId = customIsNew ? profileId : customDraft.credentialId;
    const catalog = (customDraft.modelCatalog ?? []).map((entry) => ({
      ...entry,
      id: entry.id.trim(),
      name: entry.name.trim(),
    }));
    let normalized: AiConnectionProfile = {
      ...customDraft,
      id: profileId,
      providerId,
      credentialId,
      name: customDraft.name.trim(),
      baseUrl: customDraft.baseUrl.trim(),
      model: customDraft.model.trim(),
      modelCatalog: catalog,
    };
    normalized = applyModelSelection(normalized, normalized.model);
    if (validateAiConnectionProfile(normalized).length > 0) {
      setCustomNotice({ kind: "error", key: "settings.ai.model.error.invalid" });
      return;
    }

    const draftScope = customDraft.id || "new";
    const key = customKeyDraft.credentialId === draftScope ? customKeyDraft.value.trim() : "";
    setSavingCustom(true);
    setCustomNotice(null);
    try {
      if (key) await store.save(credentialId, key);
      const latest = useSettingsStore.getState().ai ?? emptyAiSettings();
      const nextProfiles = customIsNew
        ? [...latest.profiles, normalized]
        : latest.profiles.map((profile) => profile.id === customDraft.id ? normalized : profile);
      setAiSettings({ ...latest, profiles: nextProfiles, activeProfileId: profileId });
      setCustomDraft(cloneProfile(normalized));
      setCustomKeyDraft({ credentialId: "", value: "" });
      if (key) setKeyConfigured((previous) => ({ ...previous, [credentialId]: true }));
      setCustomNotice({ kind: "success", key: "settings.ai.model.status.customSaved" });
    } catch (error) {
      setCustomNotice({ kind: "error", key: credentialErrorKey(error) });
    } finally {
      setSavingCustom(false);
    }
  }, [customDraft, customIsNew, customKeyDraft, savingCustom, setAiSettings, store, validateCustom]);

  const handleTabKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next: ModelTab = event.key === "Home"
      ? "provider"
      : event.key === "End"
        ? "custom"
        : tab === "provider" ? "custom" : "provider";
    setTab(next);
    document.getElementById(`${idPrefix}-${next}-tab`)?.focus();
  }, [idPrefix, tab]);

  const providerId = activeProfile ? inferProviderId(activeProfile) : AI_DEFAULT_PROVIDER_ID;
  const providerPreset = findAiProviderPreset(providerId);
  const activeIsCustom = Boolean(activeProfile && isCustomProfile(activeProfile));
  // v0.15.4 需求 3：服务商下拉只列内置预设，自定义档案不会混进来。
  // v0.15.4 task-4：按 preset 自带的 group 字段分 optgroup，不另写「id → 分组」清单。
  const providerGroups = useMemo(() => groupAiProviderPresets(), []);
  const providerSelectValue = providerPreset ? providerId : AI_DEFAULT_PROVIDER_ID;
  const providerEditable = Boolean(activeProfile) && !activeIsCustom;
  const selectedModel = activeProfile?.modelCatalog?.find((entry) => entry.id === activeProfile.model);
  const sliderStops = selectedModel ? contextSliderStops(selectedModel) : [];
  const exactSliderIndex = activeProfile ? sliderStops.indexOf(activeProfile.contextWindowTokens) : -1;
  const sliderIndex = exactSliderIndex >= 0 ? exactSliderIndex : Math.max(0, sliderStops.length - 1);
  const providerKeyValue = activeProfile && providerKeyDraft.credentialId === activeProfile.credentialId
    ? providerKeyDraft.value
    : "";
  const customKeyScope = customDraft.id || "new";
  const customKeyValue = customKeyDraft.credentialId === customKeyScope ? customKeyDraft.value : "";
  const customCatalog = customDraft.modelCatalog ?? [];
  const customSelectedModel = customCatalog.find((entry) => entry.id === customDraft.model);
  const customSliderStops = customSelectedModel ? contextSliderStops(customSelectedModel) : [];
  const customExactSliderIndex = customSliderStops.indexOf(customDraft.contextWindowTokens);
  const customSliderIndex = customExactSliderIndex >= 0
    ? customExactSliderIndex
    : Math.max(0, customSliderStops.length - 1);
  const localKindValue = customDraft.localKind && isLocalDeploymentKind(customDraft.localKind)
    ? customDraft.localKind
    : "";
  const localHint = localKindValue
    ? t(`settings.ai.model.localHint.${localKindValue === "ollama" ? "ollama" : "generic"}`)
    : "";

  /** v0.15.4 需求 6：「当前启用模型」= 服务商 - 模型名称 - 推理等级。 */
  const activeSummary = useMemo(() => {
    if (!activeProfile) return null;
    const providerLabel = providerPreset
      ? t(providerPreset.nameKey)
      // 自定义 Provider 用「显示名称」，缺失退到 Provider ID。
      : (activeProfile.name || activeProfile.providerId || activeProfile.id);
    const modelLabel = activeProfile.modelCatalog?.find((entry) => entry.id === activeProfile.model)?.name
      || activeProfile.model;
    const reasoning = activeProfile.requestPolicy.reasoningEffort ?? "off";
    return { providerLabel, modelLabel, reasoning };
  }, [activeProfile, providerPreset, t]);

  const providerTabId = `${idPrefix}-provider-tab`;
  const customTabId = `${idPrefix}-custom-tab`;
  const providerPanelId = `${idPrefix}-provider-panel`;
  const customPanelId = `${idPrefix}-custom-panel`;

  return (
    <section className="settings-section ai-model-settings" data-testid="ai-model-settings">
      <h3>{t("settings.ai.model.title")}</h3>
      <div
        className="ai-model-tabs"
        role="tablist"
        aria-label={t("settings.ai.model.tabs.label")}
        onKeyDown={handleTabKeyDown}
      >
        <button
          id={providerTabId}
          type="button"
          role="tab"
          aria-selected={tab === "provider"}
          aria-controls={providerPanelId}
          tabIndex={tab === "provider" ? 0 : -1}
          className={`ai-model-tab${tab === "provider" ? " is-active" : ""}`}
          onClick={() => setTab("provider")}
        >
          {t("settings.ai.model.tabs.provider")}
        </button>
        <button
          id={customTabId}
          type="button"
          role="tab"
          aria-selected={tab === "custom"}
          aria-controls={customPanelId}
          tabIndex={tab === "custom" ? 0 : -1}
          className={`ai-model-tab${tab === "custom" ? " is-active" : ""}`}
          onClick={() => setTab("custom")}
        >
          {t("settings.ai.model.tabs.custom")}
        </button>
      </div>

      {tab === "provider" ? (
        <div
          id={providerPanelId}
          role="tabpanel"
          aria-labelledby={providerTabId}
          className="ai-model-panel"
          data-testid="ai-model-provider-panel"
        >
          <div className="ai-model-tree">
            <div className="ai-model-field">
              <label htmlFor={`${idPrefix}-provider`}>{t("settings.ai.model.field.provider")}</label>
              <select
                id={`${idPrefix}-provider`}
                className="settings-select"
                value={providerSelectValue}
                onChange={(event) => handleProviderChange(event.target.value)}
                data-testid="ai-model-provider"
              >
                {providerGroups.map((section) => (
                  <optgroup
                    key={section.group}
                    label={t(section.labelKey)}
                    data-testid={`ai-model-provider-group-${section.group}`}
                  >
                    {section.presets.map((preset) => (
                      <option key={preset.id} value={preset.id}>{t(preset.nameKey)}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
              {activeIsCustom && (
                <small className="settings-hint" data-testid="ai-model-provider-custom-hint">
                  {t("settings.ai.model.status.customActiveHint")}
                </small>
              )}
            </div>

            <div className="ai-model-field">
              <label htmlFor={`${idPrefix}-provider-key`}>{t("settings.ai.model.field.apiKey")}</label>
              {activeProfile?.authMode === "none" ? (
                <div className="ai-model-static-value" data-testid="ai-model-no-auth">
                  {t("settings.ai.model.field.noAuth")}
                </div>
              ) : (
                <>
                  <div className="ai-model-inline">
                    <input
                      id={`${idPrefix}-provider-key`}
                      className="ai-input ai-input-mono"
                      type="password"
                      autoComplete="new-password"
                      value={providerKeyValue}
                      placeholder={t("settings.ai.model.field.keyPlaceholder")}
                      onChange={(event) => activeProfile && setProviderKeyDraft({
                        credentialId: activeProfile.credentialId,
                        value: event.target.value,
                      })}
                      disabled={!activeProfile || providerKeyBusy}
                      data-testid="ai-model-provider-key"
                    />
                    <button
                      type="button"
                      className="ai-btn"
                      onClick={handleSaveProviderKey}
                      disabled={!providerKeyValue.trim() || providerKeyBusy}
                      data-testid="ai-model-provider-key-save"
                    >
                      {t(providerKeyBusy ? "settings.ai.model.action.saving" : "settings.ai.model.action.saveKey")}
                    </button>
                    {activeProfile && keyConfigured[activeProfile.credentialId] && store.clear && (
                      <button
                        type="button"
                        className="ai-btn"
                        onClick={handleClearProviderKey}
                        disabled={providerKeyBusy}
                        data-testid="ai-model-provider-key-clear"
                      >
                        {t("settings.ai.model.action.clearKey")}
                      </button>
                    )}
                  </div>
                  <small className="ai-model-key-status">
                    {activeProfile && keyConfigured[activeProfile.credentialId] !== undefined
                      ? t(keyConfigured[activeProfile.credentialId]
                        ? "settings.ai.model.field.keyConfigured"
                        : "settings.ai.model.field.keyNotConfigured")
                      : t("settings.ai.model.field.keyChecking")}
                  </small>
                </>
              )}
            </div>

            <div className="ai-model-field">
              <label htmlFor={`${idPrefix}-provider-url`}>{t("settings.ai.model.field.baseUrl")}</label>
              <input
                id={`${idPrefix}-provider-url`}
                className="ai-input ai-input-mono"
                type="text"
                value={activeProfile?.baseUrl ?? ""}
                onChange={(event) => patchActive({ baseUrl: event.target.value })}
                disabled={!providerEditable}
                data-testid="ai-model-base-url"
              />
            </div>

            {/* v0.15.4 需求 5：两个按钮移到「模型名称」输入框右侧。 */}
            <div className="ai-model-field">
              <label htmlFor={`${idPrefix}-provider-model`}>{t("settings.ai.model.field.model")}</label>
              <div className="ai-model-inline ai-model-model-row">
                <input
                  id={`${idPrefix}-provider-model`}
                  className="ai-input ai-input-mono"
                  type="text"
                  list={`${idPrefix}-provider-models`}
                  value={activeProfile?.model ?? ""}
                  onChange={(event) => activeProfile && updateProfile(
                    activeProfile.id,
                    (profile) => applyModelSelection(profile, event.target.value),
                  )}
                  disabled={!providerEditable}
                  data-testid="ai-model-name"
                />
                <button
                  type="button"
                  className="ai-btn"
                  onClick={handleFetchModels}
                  disabled={!providerEditable || fetchingModels}
                  data-testid="ai-model-fetch"
                >
                  {t(fetchingModels ? "settings.ai.model.action.fetching" : "settings.ai.model.action.fetch")}
                </button>
                <button
                  type="button"
                  className="ai-btn"
                  onClick={handleTestConnection}
                  disabled={!providerEditable || testingConnection}
                  data-testid="ai-model-test"
                >
                  {t(testingConnection ? "settings.ai.model.action.testing" : "settings.ai.model.action.test")}
                </button>
              </div>
              <datalist id={`${idPrefix}-provider-models`}>
                {(activeProfile?.modelCatalog ?? []).map((entry) => (
                  <option key={entry.id} value={entry.id}>{entry.name}</option>
                ))}
              </datalist>
            </div>

            <div className="ai-model-field">
              <label htmlFor={`${idPrefix}-provider-temperature`}>{t("settings.ai.model.field.temperature")}</label>
              <input
                id={`${idPrefix}-provider-temperature`}
                className="ai-input ai-model-number"
                type="number"
                min="0"
                max="2"
                step="0.1"
                value={activeProfile?.requestPolicy.temperature ?? ""}
                onChange={(event) => {
                  if (!activeProfile) return;
                  const raw = event.target.value;
                  const parsed = Number(raw);
                  patchActive({
                    requestPolicy: {
                      ...activeProfile.requestPolicy,
                      temperature: raw === "" || !Number.isFinite(parsed)
                        ? undefined
                        : Math.max(0, Math.min(2, parsed)),
                    },
                  });
                }}
                disabled={!providerEditable}
                data-testid="ai-model-temperature"
              />
            </div>

            {sliderStops.length > 0 && activeProfile && (
              <div className="ai-model-field ai-model-context" data-testid="ai-model-context">
                <div className="ai-model-context-heading">
                  <label htmlFor={`${idPrefix}-provider-context`}>{t("settings.ai.model.field.context")}</label>
                  <output htmlFor={`${idPrefix}-provider-context`}>
                    {formatTokenCount(activeProfile.contextWindowTokens)}
                  </output>
                </div>
                <input
                  id={`${idPrefix}-provider-context`}
                  type="range"
                  min="0"
                  max={sliderStops.length - 1}
                  step="1"
                  value={sliderIndex}
                  onChange={(event) => {
                    const nextContext = sliderStops[Number(event.target.value)];
                    if (nextContext === undefined) return;
                    updateProfile(activeProfile.id, (profile) => ({
                      ...profile,
                      contextWindowTokens: nextContext,
                      maxOutputTokens: clampOutputTokens(profile.maxOutputTokens, nextContext),
                    }));
                  }}
                  data-testid="ai-model-context-slider"
                />
                <div className="ai-model-context-stops" aria-hidden="true">
                  {sliderStops.map((stop) => <span key={stop}>{formatTokenCount(stop)}</span>)}
                </div>
              </div>
            )}
          </div>
          {providerNotice && (
            <p
              className={`ai-model-notice is-${providerNotice.kind}`}
              role={providerNotice.kind === "error" ? "alert" : "status"}
              data-testid="ai-model-provider-notice"
            >
              {t(providerNotice.key)}
            </p>
          )}
          {/* v0.15.4 需求 6：当前启用模型（服务商 - 模型名称 - 推理等级）。 */}
          <div className="ai-model-active-summary" data-testid="ai-model-active-summary">
            <span className="ai-model-active-summary-label">{t("settings.ai.model.active.title")}</span>
            {activeSummary ? (
              <span className="ai-model-active-summary-value">
                <span data-testid="ai-model-active-provider">{activeSummary.providerLabel}</span>
                <span className="ai-model-active-separator">-</span>
                <span data-testid="ai-model-active-model">{activeSummary.modelLabel || t("settings.ai.model.active.empty")}</span>
                <span className="ai-model-active-separator">-</span>
                <span data-testid="ai-model-active-reasoning">{activeSummary.reasoning}</span>
              </span>
            ) : (
              <span className="ai-model-active-summary-value is-empty" data-testid="ai-model-active-empty">
                {t("settings.ai.model.active.none")}
              </span>
            )}
          </div>
        </div>
      ) : (
        <div
          id={customPanelId}
          role="tabpanel"
          aria-labelledby={customTabId}
          className="ai-model-panel"
          data-testid="ai-model-custom-panel"
        >
          <div className="ai-model-custom-picker">
            <label htmlFor={`${idPrefix}-custom-profile`}>{t("settings.ai.model.custom.profile")}</label>
            <div className="ai-model-inline">
              <select
                id={`${idPrefix}-custom-profile`}
                className="settings-select"
                value={customDraft.id}
                onChange={(event) => loadCustomDraft(event.target.value)}
                data-testid="ai-model-custom-profile"
              >
                <option value="">{t("settings.ai.model.custom.new")}</option>
                {customProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>{profile.name || profile.id}</option>
                ))}
              </select>
              <button
                type="button"
                className="ai-btn"
                onClick={() => loadCustomDraft("")}
                disabled={customIsNew}
                data-testid="ai-model-custom-new"
              >
                {t("settings.ai.model.custom.new")}
              </button>
            </div>
          </div>

          <div className="ai-model-tree">
            {/* v0.15.4 需求 1：本地部署类型，选中即预填端点/协议/鉴权。 */}
            <div className="ai-model-field">
              <label htmlFor={`${idPrefix}-custom-local-kind`}>{t("settings.ai.model.local.label")}</label>
              <select
                id={`${idPrefix}-custom-local-kind`}
                className="settings-select"
                value={localKindValue}
                onChange={(event) => handleCustomLocalKindChange(event.target.value)}
                data-testid="ai-model-custom-local-kind"
              >
                <option value="">{t("settings.ai.model.local.none")}</option>
                {LOCAL_DEPLOYMENT_KINDS.map((kind) => {
                  const preset = findLocalDeploymentPreset(kind);
                  return (
                    <option key={kind} value={kind}>
                      {t(preset?.nameKey ?? `settings.ai.model.local.${kind}`)}
                    </option>
                  );
                })}
              </select>
              {localHint && <small className="settings-hint">{localHint}</small>}
            </div>

            <div className="ai-model-field">
              <label htmlFor={`${idPrefix}-custom-provider-id`}>{t("settings.ai.model.custom.providerId")}</label>
              <input
                id={`${idPrefix}-custom-provider-id`}
                className="ai-input ai-input-mono"
                type="text"
                value={customDraft.providerId ?? ""}
                readOnly={!customIsNew}
                aria-readonly={!customIsNew}
                onChange={(event) => customIsNew && patchCustom({ providerId: event.target.value })}
                data-testid="ai-model-custom-provider-id"
              />
              {customIsNew && <small className="settings-hint">{t("settings.ai.model.custom.providerIdHint")}</small>}
            </div>

            <div className="ai-model-field">
              <label htmlFor={`${idPrefix}-custom-name`}>{t("settings.ai.model.custom.displayName")}</label>
              <input
                id={`${idPrefix}-custom-name`}
                className="ai-input"
                type="text"
                value={customDraft.name}
                onChange={(event) => patchCustom({ name: event.target.value })}
                data-testid="ai-model-custom-name"
              />
            </div>

            <div className="ai-model-field">
              <label htmlFor={`${idPrefix}-custom-url`}>{t("settings.ai.model.field.baseUrl")}</label>
              <input
                id={`${idPrefix}-custom-url`}
                className="ai-input ai-input-mono"
                type="text"
                value={customDraft.baseUrl}
                onChange={(event) => patchCustom({ baseUrl: event.target.value })}
                data-testid="ai-model-custom-base-url"
              />
            </div>

            <div className="ai-model-field">
              <label htmlFor={`${idPrefix}-custom-protocol`}>{t("settings.ai.model.custom.protocol")}</label>
              <select
                id={`${idPrefix}-custom-protocol`}
                className="settings-select"
                value={customDraft.protocol}
                onChange={(event) => patchCustom({ protocol: event.target.value as ApiProtocol })}
                data-testid="ai-model-custom-protocol"
              >
                {PROTOCOLS.map((protocol) => <option key={protocol} value={protocol}>{protocol}</option>)}
              </select>
            </div>

            <div className="ai-model-field">
              <label htmlFor={`${idPrefix}-custom-key`}>{t("settings.ai.model.field.apiKey")}</label>
              <input
                id={`${idPrefix}-custom-key`}
                className="ai-input ai-input-mono"
                type="password"
                autoComplete="new-password"
                value={customKeyValue}
                placeholder={t("settings.ai.model.field.keyPlaceholder")}
                onChange={(event) => setCustomKeyDraft({ credentialId: customKeyScope, value: event.target.value })}
                disabled={savingCustom}
                data-testid="ai-model-custom-key"
              />
              {!customIsNew && (
                <small className="ai-model-key-status">
                  {keyConfigured[customDraft.credentialId] !== undefined
                    ? t(keyConfigured[customDraft.credentialId]
                      ? "settings.ai.model.field.keyConfigured"
                      : "settings.ai.model.field.keyNotConfigured")
                    : t("settings.ai.model.field.keyChecking")}
                </small>
              )}
            </div>

            {/* v0.15.4 需求 4+5：对等的模型名称 + 两个按钮；上下文滑条与当前模型选择。 */}
            <div className="ai-model-field">
              <label htmlFor={`${idPrefix}-custom-model`}>{t("settings.ai.model.field.model")}</label>
              <div className="ai-model-inline ai-model-model-row">
                <input
                  id={`${idPrefix}-custom-model`}
                  className="ai-input ai-input-mono"
                  type="text"
                  list={`${idPrefix}-custom-models`}
                  value={customDraft.model}
                  onChange={(event) => setCustomDraft((previous) =>
                    applyModelSelection(previous, event.target.value))}
                  data-testid="ai-model-custom-model"
                />
                <button
                  type="button"
                  className="ai-btn"
                  onClick={handleCustomFetchModels}
                  disabled={customFetchingModels}
                  data-testid="ai-model-custom-fetch"
                >
                  {t(customFetchingModels ? "settings.ai.model.action.fetching" : "settings.ai.model.action.fetch")}
                </button>
                <button
                  type="button"
                  className="ai-btn"
                  onClick={handleCustomTestConnection}
                  disabled={customTestingConnection}
                  data-testid="ai-model-custom-test"
                >
                  {t(customTestingConnection ? "settings.ai.model.action.testing" : "settings.ai.model.action.test")}
                </button>
              </div>
              <datalist id={`${idPrefix}-custom-models`}>
                {customCatalog.map((entry, index) => (
                  <option key={`${entry.id}-${index}`} value={entry.id}>{entry.name}</option>
                ))}
              </datalist>
            </div>

            {customSliderStops.length > 0 && (
              <div className="ai-model-field ai-model-context" data-testid="ai-model-custom-context">
                <div className="ai-model-context-heading">
                  <label htmlFor={`${idPrefix}-custom-context`}>{t("settings.ai.model.field.context")}</label>
                  <output htmlFor={`${idPrefix}-custom-context`}>
                    {formatTokenCount(customDraft.contextWindowTokens)}
                  </output>
                </div>
                <input
                  id={`${idPrefix}-custom-context`}
                  type="range"
                  min="0"
                  max={customSliderStops.length - 1}
                  step="1"
                  value={customSliderIndex}
                  onChange={(event) => {
                    const nextContext = customSliderStops[Number(event.target.value)];
                    if (nextContext === undefined) return;
                    setCustomDraft((previous) => ({
                      ...previous,
                      contextWindowTokens: nextContext,
                      maxOutputTokens: clampOutputTokens(previous.maxOutputTokens, nextContext),
                    }));
                  }}
                  data-testid="ai-model-custom-context-slider"
                />
                <div className="ai-model-context-stops" aria-hidden="true">
                  {customSliderStops.map((stop) => <span key={stop}>{formatTokenCount(stop)}</span>)}
                </div>
              </div>
            )}

            <div className="ai-model-field ai-model-catalog-field">
              <div className="ai-model-catalog-heading">
                <span>{t("settings.ai.model.custom.catalog")}</span>
                <button
                  type="button"
                  className="ai-btn"
                  onClick={handleAddCustomModel}
                  data-testid="ai-model-custom-add-model"
                >
                  {t("settings.ai.model.custom.addModel")}
                </button>
              </div>
              {!customCatalog.length && (
                <p className="ai-model-catalog-empty" data-testid="ai-model-custom-catalog-empty">
                  {t("settings.ai.model.custom.emptyCatalog")}
                </p>
              )}
              <div className="ai-model-catalog" data-testid="ai-model-custom-catalog">
                {customCatalog.map((entry, index) => (
                  <div className="ai-model-catalog-row" key={index} data-testid={`ai-model-custom-row-${index}`}>
                    <input
                      className="ai-model-catalog-radio"
                      type="radio"
                      name={`${idPrefix}-custom-current-model`}
                      checked={Boolean(entry.id) && customDraft.model === entry.id}
                      disabled={!entry.id.trim()}
                      onChange={() => setCustomDraft((previous) => applyModelSelection(previous, entry.id))}
                      aria-label={t("settings.ai.model.custom.selectModel")}
                      data-testid={`ai-model-custom-select-${index}`}
                    />
                    <label className="ai-model-catalog-input">
                      <span>{t("settings.ai.model.custom.modelId")}</span>
                      <input
                        className="ai-input ai-input-mono"
                        type="text"
                        value={entry.id}
                        onChange={(event) => updateCustomEntry(index, { id: event.target.value })}
                        data-testid={`ai-model-custom-model-id-${index}`}
                      />
                    </label>
                    <label className="ai-model-catalog-input">
                      <span>{t("settings.ai.model.custom.modelName")}</span>
                      <input
                        className="ai-input"
                        type="text"
                        value={entry.name}
                        onChange={(event) => updateCustomEntry(index, { name: event.target.value })}
                        data-testid={`ai-model-custom-model-name-${index}`}
                      />
                    </label>
                    <label className="ai-model-catalog-input">
                      <span>{t("settings.ai.model.custom.context")}</span>
                      <input
                        className="ai-input ai-model-number"
                        type="number"
                        min="1"
                        step="1"
                        value={entry.contextWindowTokens ?? ""}
                        onChange={(event) => {
                          const raw = event.target.value;
                          updateCustomEntry(index, raw === ""
                            ? { contextWindowTokens: undefined, minContextWindowTokens: undefined }
                            : { contextWindowTokens: Number(raw) });
                        }}
                        data-testid={`ai-model-custom-model-context-${index}`}
                      />
                    </label>
                    <label className="ai-model-catalog-input">
                      <span>{t("settings.ai.model.custom.reasoning")}</span>
                      <select
                        className="settings-select"
                        value={entry.reasoningEffort ?? "off"}
                        onChange={(event) => updateCustomEntry(index, {
                          reasoningEffort: event.target.value as ReasoningEffort,
                        })}
                        data-testid={`ai-model-custom-model-reasoning-${index}`}
                      >
                        {CUSTOM_REASONING_EFFORTS.map((effort) => (
                          <option key={effort} value={effort}>{effort}</option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      className="ai-btn ai-model-icon-button"
                      onClick={() => handleRemoveCustomModel(index)}
                      aria-label={t("settings.ai.model.custom.removeModel")}
                      data-testid={`ai-model-custom-remove-${index}`}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="ai-model-custom-footer">
            <button
              type="button"
              className="ai-btn ai-btn-primary"
              onClick={handleSaveCustom}
              disabled={savingCustom}
              data-testid="ai-model-custom-save"
            >
              {t(savingCustom ? "settings.ai.model.action.saving" : "settings.ai.model.custom.save")}
            </button>
          </div>
          {customNotice && (
            <p
              className={`ai-model-notice is-${customNotice.kind}`}
              role={customNotice.kind === "error" ? "alert" : "status"}
              data-testid="ai-model-custom-notice"
            >
              {t(customNotice.key)}
            </p>
          )}
          {/* 自定义页签同样展示当前启用模型（服务商显示名称 - 模型名称 - 推理等级）。 */}
          <div className="ai-model-active-summary" data-testid="ai-model-custom-active-summary">
            <span className="ai-model-active-summary-label">{t("settings.ai.model.active.title")}</span>
            {activeSummary ? (
              <span className="ai-model-active-summary-value">
                <span data-testid="ai-model-custom-active-provider">{activeSummary.providerLabel}</span>
                <span className="ai-model-active-separator">-</span>
                <span data-testid="ai-model-custom-active-model">
                  {activeSummary.modelLabel || t("settings.ai.model.active.empty")}
                </span>
                <span className="ai-model-active-separator">-</span>
                <span data-testid="ai-model-custom-active-reasoning">{activeSummary.reasoning}</span>
              </span>
            ) : (
              <span className="ai-model-active-summary-value is-empty">
                {t("settings.ai.model.active.none")}
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

export default AiModelSettings;
