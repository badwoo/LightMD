import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
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
  AI_PROVIDER_PRESETS,
  findAiProviderPreset,
  groupAiProviderPresets,
} from "../../services/aiProviderPresets";
import {
  isAiProfileSource,
  isLocalDeploymentKind,
  LOCAL_DEPLOYMENT_KINDS,
  validateAiConnectionProfile,
  type AiConnectionProfile,
  type AiModelCatalogEntry,
  type AiProfileSource,
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

/**
 * v0.15.5 问题1：判定档案是否属于「自定义」页签。
 *
 * **以 `source` 标记为准，而不是 providerId 是否撞预设 id**。
 * 0.15.4 的旧口径 `!findAiProviderPreset(inferProviderId(profile))` 会让
 * 「Provider ID 恰好写成 deepseek 的自定义档案」被判成预设 → 配置在两个页签都消失
 * （这正是用户反馈的「配置完就看不到这条记录」）。
 *
 * 没有 `source` 的老档案（0.15.5 之前写入 persist 的）走下面的兼容推断：
 * - 有 providerId：与 0.15.4 完全一致（providerId 是用户显式写的，尊重它）；
 * - 无 providerId 且端点命中某预设：**只有预设建档才会用的 id 形态**才算预设
 *   （`upsertProviderProfile` 用 `preset.id` 或 `preset.id-<随机后缀>` 作为档案 id，
 *   旧迁移用 `ai-default` + name 命中），否则视为「用户手填端点撞预设」的自定义档案。
 * - 其它（端点不命中任何预设）→ 自定义。
 */
function isCustomProfile(profile: AiConnectionProfile): boolean {
  if (isAiProfileSource(profile.source)) return profile.source === "custom";
  if (profile.providerId) return !findAiProviderPreset(inferProviderId(profile));
  const inferred = inferProviderId(profile);
  const preset = findAiProviderPreset(inferred);
  if (!preset) return true;
  // 无 providerId 但端点撞预设：按「id 是否像预设建档产物」区分。
  if (profile.id === preset.id) return false;
  if (profile.id.startsWith(`${preset.id}-`)) return false;
  if (profile.id === "ai-default" && profile.name === preset.id) return false;
  return true;
}

/** 把某条档案标记为来源；已带合法 source 时原样返回（不覆盖）。 */
function withProfileSource(
  profile: AiConnectionProfile,
  source: AiProfileSource,
): AiConnectionProfile {
  return isAiProfileSource(profile.source) ? profile : { ...profile, source };
}

function clampOutputTokens(maxOutputTokens: number, contextWindowTokens: number): number {
  return Math.max(1, Math.min(maxOutputTokens, contextWindowTokens - 1));
}

/** 用户可编辑字段的指纹，用于判断草稿是否有未保存改动。 */
function draftFingerprint(profile: AiConnectionProfile): string {
  return JSON.stringify([
    profile.name,
    profile.providerId ?? "",
    profile.baseUrl,
    profile.protocol,
    profile.authMode,
    profile.model,
    profile.contextWindowTokens,
    profile.maxOutputTokens,
    profile.requestPolicy,
    profile.modelCatalog ?? [],
    profile.localKind ?? "",
    profile.systemPrompt ?? "",
  ]);
}

/**
 * 把自定义草稿归一为可落库的档案（保留目标档案的 id/credentialId/source）。
 * 校验失败返回 null —— 调用方据此决定「不覆盖、保留草稿」。
 */
function normalizeCustomDraft(
  draft: AiConnectionProfile,
  target: AiConnectionProfile,
): AiConnectionProfile | null {
  const catalog = (draft.modelCatalog ?? []).map((entry) => ({
    ...entry,
    id: entry.id.trim(),
    name: entry.name.trim(),
  }));
  const normalized: AiConnectionProfile = {
    ...target,
    ...draft,
    id: target.id,
    credentialId: target.credentialId,
    providerId: draft.providerId?.trim() || target.providerId,
    name: draft.name.trim(),
    baseUrl: draft.baseUrl.trim(),
    model: draft.model.trim(),
    modelCatalog: catalog,
    source: target.source ?? "custom",
  };
  const applied = applyModelSelection(normalized, normalized.model);
  return validateAiConnectionProfile(applied).length > 0 ? null : applied;
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

interface ProfileListItemProps {
  /** testid 前缀：`provider` | `custom`（拼成 ai-model-${variant}-item-*）。 */
  variant: "provider" | "custom";
  profile: AiConnectionProfile;
  isActive: boolean;
  isExpanded: boolean;
  onToggleExpanded: () => void;
  onToggleActive: () => void;
  onDelete: () => void;
  enableLabel: string;
  disableLabel: string;
  activeDotLabel: string;
  deleteLabel: string;
  body?: ReactNode;
}

/**
 * 两个页签共用的条目行（避免行为漂移）。
 *
 * DOM 顺序（Lead 的实机探针依赖它）：
 *   条目主体按钮 → 启用/关闭按钮 → 绿色圆点（仅启用时） → 删除按钮
 * 绿点必须在 toggle **之后**（用户原话「绿色亮点左边再增加一个启用或关闭按钮」）。
 * 展开体渲染在同一个 <li> 内（探针用 body.offsetHeight 判可见）。
 */
function ProfileListItem({
  variant,
  profile,
  isActive,
  isExpanded,
  onToggleExpanded,
  onToggleActive,
  onDelete,
  enableLabel,
  disableLabel,
  activeDotLabel,
  deleteLabel,
  body,
}: ProfileListItemProps) {
  const itemTestId = `ai-model-${variant}-item-${profile.id}`;
  return (
    <li
      className={`ai-model-profile-item${isActive ? " is-active" : ""}${isExpanded ? " is-expanded" : ""}`}
      data-testid={itemTestId}
    >
      <div className="ai-model-profile-item-row">
        <button
          type="button"
          className="ai-model-profile-item-main"
          aria-expanded={isExpanded}
          onClick={onToggleExpanded}
          data-testid={`ai-model-${variant}-item-select-${profile.id}`}
        >
          <span className="ai-model-profile-item-name">{profile.name || profile.providerId || profile.id}</span>
          <span className="ai-model-profile-item-meta">
            <span className="ai-model-profile-item-provider">{profile.providerId || profile.id}</span>
            <span className="ai-model-profile-item-endpoint">{profile.baseUrl}</span>
          </span>
        </button>
        <button
          type="button"
          className={`ai-model-profile-toggle${isActive ? " is-on" : ""}`}
          aria-pressed={isActive}
          onClick={onToggleActive}
          title={isActive ? disableLabel : enableLabel}
          data-testid={`ai-model-${variant}-item-toggle-${profile.id}`}
        >
          {isActive ? disableLabel : enableLabel}
        </button>
        {isActive && (
          <span
            className="ai-model-profile-active-dot"
            role="img"
            aria-label={activeDotLabel}
            title={activeDotLabel}
            data-testid={`ai-model-${variant}-item-active-${profile.id}`}
          />
        )}
        <button
          type="button"
          className="ai-btn ai-model-icon-button"
          onClick={onDelete}
          aria-label={deleteLabel}
          data-testid={`ai-model-${variant}-item-delete-${profile.id}`}
        >
          ×
        </button>
      </div>
      {body}
    </li>
  );
}

export function AiModelSettings({ credentialStore }: AiModelSettingsProps = {}) {
  const t = useT();
  const idPrefix = useId();
  const ai = useSettingsStore((state) => state.ai);
  const setAiSettings = useSettingsStore((state) => state.setAiSettings);
  const profiles = useMemo(() => ai?.profiles ?? [], [ai?.profiles]);
  /**
   * v0.15.6：**启用是可选的**（允许「全部关闭」）。
   * 因此这里不再 `?? profiles[0]` —— activeProfileId 为空时必须真的解析为 null，
   * 不能把第一条档案当成「当前启用」。
   */
  const activeProfile = useMemo(
    () => profiles.find((profile) => profile.id === ai?.activeProfileId) ?? null,
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

  /**
   * accordion 状态：同时只展开一条。
   * - provider：`expandedProviderId`（null = 全部收起）
   * - custom：`expandedCustomId`（null = 全部收起；`""` = 展开「新建」草稿）
   */
  const [expandedProviderId, setExpandedProviderId] = useState<string | null>(() =>
    activeProfile && !isCustomProfile(activeProfile) ? activeProfile.id : null,
  );
  const [expandedCustomId, setExpandedCustomId] = useState<string | null>(() =>
    activeProfile && isCustomProfile(activeProfile) ? activeProfile.id : null,
  );
  const [addProviderId, setAddProviderId] = useState("");

  const defaultStoreRef = useRef<AiCredentialStore | null>(null);
  const store = useMemo<AiCredentialStore>(() => {
    if (credentialStore) return credentialStore;
    if (!defaultStoreRef.current) defaultStoreRef.current = createLazyDefaultStore();
    return defaultStoreRef.current;
  }, [credentialStore]);

  const customProfiles = useMemo(() => profiles.filter(isCustomProfile), [profiles]);
  const providerProfiles = useMemo(() => profiles.filter((profile) => !isCustomProfile(profile)), [profiles]);

  const [customDraft, setCustomDraft] = useState<AiConnectionProfile>(() =>
    activeProfile && isCustomProfile(activeProfile)
      ? asCustomDraft(activeProfile)
      : createCustomProfileDraft(),
  );
  const customIsNew = customDraft.id === "";
  /** 「新建」草稿在切换到其他条目时暂存，回来还能继续编辑。 */
  const pendingNewDraftRef = useRef<AiConnectionProfile | null>(null);

  const expandedProvider = useMemo(
    () => profiles.find((profile) => profile.id === expandedProviderId) ?? null,
    [expandedProviderId, profiles],
  );
  const expandedCustom = useMemo(
    () => (expandedCustomId ? profiles.find((profile) => profile.id === expandedCustomId) ?? null : null),
    [expandedCustomId, profiles],
  );

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

  /**
   * 空配置只在新装/被清空的防御路径出现；默认仍落到本地 Ollama。
   *
   * 判据是 `profiles.length > 0` 就 return —— **不会**在「全部条目被关闭」
   * （activeProfileId 为空但仍有档案）时擅自重新启用任何档案。
   */
  useEffect(() => {
    if (profiles.length > 0) return;
    const preset = findAiProviderPreset(AI_DEFAULT_PROVIDER_ID);
    if (!preset) return;
    const latest = useSettingsStore.getState().ai ?? emptyAiSettings();
    if (latest.profiles.length > 0) return;
    const next = upsertProviderProfile(latest, preset, t(preset.nameKey));
    setAiSettings({
      ...next.settings,
      profiles: next.settings.profiles.map((profile) =>
        profile.id === next.profile.id ? withProfileSource(profile, "preset") : profile
      ),
    });
    // 空配置时初始 accordion 无条目可展开（初始 state 建立时 profiles 还是空的），
    // 补建档后同步展开这条默认档案，保证「新装即见表单」与 0.15.5 一致。
    setExpandedProviderId((previous) => previous ?? next.profile.id);
  }, [profiles.length, setAiSettings, t]);

  const customKeyScope = customDraft.id || "new";
  const customCredentialId = tab === "custom" && !customIsNew ? customDraft.credentialId : "";
  const providerCredentialId =
    tab === "provider" && expandedProvider && expandedProvider.authMode !== "none"
      ? expandedProvider.credentialId
      : "";

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

  /**
   * v0.15.6：启用/关闭一条档案（与展开/收起完全无关）。
   * - 点击已启用条目 → 关闭它（activeProfileId 置空，允许「全部关闭」）
   * - 点击未启用条目 → 启用它（同一时刻最多一条启用，其它自动变未启用）
   */
  const handleToggleActive = useCallback((profileId: string) => {
    const latest = useSettingsStore.getState().ai ?? emptyAiSettings();
    if (!latest.profiles.some((profile) => profile.id === profileId)) return;
    const nextActiveProfileId = latest.activeProfileId === profileId ? "" : profileId;
    setAiSettings({ ...latest, activeProfileId: nextActiveProfileId });
    setProviderNotice(null);
    setCustomNotice(null);
  }, [setAiSettings]);

  /**
   * v0.15.5 不变量（两个页签共用）：删除一条档案。
   *
   * 1. 删的是当前启用档案 → activeProfileId 移交：优先回落 ollama 档案，没有就现场建一个，
   *    绝不留悬空 id（置空 `""` 也是合法状态，但只在确实没有任何可用档案时才用）；
   * 2. 草稿/展开状态若指向被删档案 → 一并复位，避免继续编辑不存在的记录；
   * 3. 清凭据槽，失败容错不阻断。
   */
  const handleDeleteProfile = useCallback(async (profileId: string) => {
    const latest = useSettingsStore.getState().ai ?? emptyAiSettings();
    const target = latest.profiles.find((profile) => profile.id === profileId);
    if (!target) return;

    const remaining = latest.profiles.filter((profile) => profile.id !== profileId);
    let nextProfiles = remaining;
    let nextActiveProfileId = latest.activeProfileId;

    if (latest.activeProfileId === profileId) {
      const ollama = remaining.find((profile) => inferProviderId(profile) === AI_DEFAULT_PROVIDER_ID);
      if (ollama) {
        nextActiveProfileId = ollama.id;
      } else {
        const preset = findAiProviderPreset(AI_DEFAULT_PROVIDER_ID);
        if (preset) {
          const created = upsertProviderProfile(
            { ...latest, profiles: remaining, activeProfileId: "" },
            preset,
            t(preset.nameKey),
          );
          nextProfiles = created.settings.profiles.map((profile) =>
            profile.id === created.profile.id ? withProfileSource(profile, "preset") : profile
          );
          nextActiveProfileId = created.profile.id;
        } else {
          nextActiveProfileId = remaining[0]?.id ?? "";
        }
      }
    }

    setAiSettings({ ...latest, profiles: nextProfiles, activeProfileId: nextActiveProfileId });

    if (expandedProviderId === profileId) {
      setExpandedProviderId(null);
      setProviderKeyDraft({ credentialId: "", value: "" });
      setProviderNotice(null);
    }
    if (expandedCustomId === profileId) {
      setExpandedCustomId(null);
      setCustomDraft(createCustomProfileDraft());
      setCustomKeyDraft({ credentialId: "", value: "" });
      setCustomNotice(null);
    }
    if (customDraft.id === profileId) {
      setCustomDraft(createCustomProfileDraft());
      setCustomKeyDraft({ credentialId: "", value: "" });
    }
    setCustomNotice(null);

    if (store.clear && target.authMode !== "none") {
      try {
        await store.clear(target.credentialId);
        setKeyConfigured((previous) => ({ ...previous, [target.credentialId]: false }));
      } catch {
        /* 凭据管理器不可用 / 条目不存在：删除配置本身已经成功，忽略即可 */
      }
    }
  }, [
    customDraft.id,
    expandedCustomId,
    expandedProviderId,
    setAiSettings,
    store,
    t,
  ]);

  /* ── 服务商页签 ─────────────────────────────────────────── */

  const configuredProviderIds = useMemo(
    () => new Set(providerProfiles.map((profile) => inferProviderId(profile))),
    [providerProfiles],
  );
  /** 「添加服务商」下拉只列**尚未配置过**的预设（按 group 分 optgroup）。 */
  const addablePresetGroups = useMemo(() => {
    const addable = AI_PROVIDER_PRESETS.filter((preset) => !configuredProviderIds.has(preset.id));
    return groupAiProviderPresets(addable);
  }, [configuredProviderIds]);

  const handleToggleProviderExpanded = useCallback((profileId: string) => {
    setExpandedProviderId((previous) => (previous === profileId ? null : profileId));
    setProviderKeyDraft({ credentialId: "", value: "" });
    setProviderNotice(null);
  }, []);

  /** 添加服务商：新建一条该预设的档案（source:"preset"）并自动展开它。 */
  const handleAddProvider = useCallback((presetId: string) => {
    const preset = findAiProviderPreset(presetId);
    if (!preset) return;
    const latest = useSettingsStore.getState().ai ?? emptyAiSettings();
    const previousActiveProfileId = latest.activeProfileId;
    const next = upsertProviderProfile(latest, preset, t(preset.nameKey));
    const nextProfiles = next.settings.profiles.map((profile) =>
      profile.id === next.profile.id ? withProfileSource(profile, "preset") : profile
    );
    setAiSettings({
      ...next.settings,
      profiles: nextProfiles,
      // 新增**不自动启用**：启用是条目上「启用/关闭」按钮的职责（用户口径）。
      // upsertProviderProfile 为了「切换服务商即生效」会把 activeProfileId 指过去，
      // 这里必须显式还原，否则「添加一条」就等于偷偷启用了它。
      activeProfileId: previousActiveProfileId,
    });
    setExpandedProviderId(next.profile.id);
    setAddProviderId("");
    setProviderKeyDraft({ credentialId: "", value: "" });
    setProviderNotice(null);
  }, [setAiSettings, t]);

  /** 服务商页签的所有编辑都作用于**展开的那条档案**，不是 activeProfile。 */
  const patchExpandedProvider = useCallback((patch: Partial<AiConnectionProfile>) => {
    if (!expandedProvider) return;
    updateProfile(expandedProvider.id, (profile) => ({ ...profile, ...patch }));
  }, [expandedProvider, updateProfile]);

  const handleFetchModels = useCallback(async (profile: AiConnectionProfile | null) => {
    if (!profile || fetchingModels) return;
    const profileId = profile.id;
    setFetchingModels(true);
    setProviderNotice(null);
    try {
      const models = await aiConnectionService.listModels(profile);
      updateProfile(profileId, (current) => {
        // 服务商页签的目录是「端点的镜像」，没有手工编辑入口，因此以探测结果为准。
        const withCatalog = { ...current, modelCatalog: models };
        return models.some((entry) => entry.id === current.model)
          ? applyModelSelection(withCatalog, current.model)
          : withCatalog;
      });
      setProviderNotice({ kind: "success", key: "settings.ai.model.status.fetchSuccess" });
    } catch {
      setProviderNotice({ kind: "error", key: "settings.ai.model.status.fetchError" });
    } finally {
      setFetchingModels(false);
    }
  }, [fetchingModels, updateProfile]);

  const handleTestConnection = useCallback(async (profile: AiConnectionProfile | null) => {
    if (!profile || testingConnection) return;
    setTestingConnection(true);
    setProviderNotice(null);
    try {
      await aiConnectionService.testConnection(profile);
      setProviderNotice({ kind: "success", key: "settings.ai.model.status.testSuccess" });
    } catch {
      setProviderNotice({ kind: "error", key: "settings.ai.model.status.testError" });
    } finally {
      setTestingConnection(false);
    }
  }, [testingConnection]);

  const handleSaveProviderKey = useCallback(async () => {
    if (!expandedProvider || expandedProvider.authMode === "none" || providerKeyBusy) return;
    const credentialId = expandedProvider.credentialId;
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
  }, [expandedProvider, providerKeyBusy, providerKeyDraft, store]);

  const handleClearProviderKey = useCallback(async () => {
    if (!expandedProvider || !store.clear || providerKeyBusy) return;
    const credentialId = expandedProvider.credentialId;
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
  }, [expandedProvider, providerKeyBusy, store]);

  /* ── 自定义页签 ─────────────────────────────────────────── */

  const patchCustom = useCallback((patch: Partial<AiConnectionProfile>) => {
    setCustomDraft((previous) => ({ ...previous, ...patch }));
    setCustomNotice(null);
  }, []);

  /**
   * 离开当前自定义草稿时尽力把它写回所属档案（**不改变启用状态**）。
   *
   * 取舍：自定义页签保留「保存并启用」的草稿语义，但展开另一条时若不提交，
   * 用户刚改的内容会凭空消失。因此这里做 best-effort 提交：
   * - 草稿属于已存在档案且通过校验 → 静默写回（只改该档案，不启用）；
   * - 校验不通过（例如把模型清空了）→ **不覆盖**，由调用方阻止切换并提示先修好。
   * - 草稿是「新建」且尚未落库 → 暂存到 pendingNewDraftRef，回来可继续编辑。
   *
   * @returns true = 可以安全切换；false = 有未保存且无法提交的改动，应留在原条目。
   */
  const commitCustomDraft = useCallback((): boolean => {
    const draft = customDraft;
    if (!draft.id) {
      if (draftFingerprint(draft) !== draftFingerprint(createCustomProfileDraft())) {
        pendingNewDraftRef.current = cloneProfile(draft);
      }
      return true;
    }
    const latest = useSettingsStore.getState().ai ?? emptyAiSettings();
    const target = latest.profiles.find((profile) => profile.id === draft.id);
    if (!target) return true;
    if (draftFingerprint(draft) === draftFingerprint(asCustomDraft(target))) return true;
    const normalized = normalizeCustomDraft(draft, target);
    if (!normalized) return false;
    setAiSettings({
      ...latest,
      profiles: latest.profiles.map((profile) => (profile.id === draft.id ? normalized : profile)),
    });
    setCustomDraft(cloneProfile(normalized));
    return true;
  }, [customDraft, setAiSettings]);

  /** 点击条目主体：展开/收起（accordion，同时只展开一条）。 */
  const handleToggleCustomExpanded = useCallback((profileId: string) => {
    setCustomNotice(null);
    if (expandedCustomId === profileId) {
      setExpandedCustomId(null);
      return;
    }
    if (!commitCustomDraft()) {
      setCustomNotice({ kind: "error", key: "settings.ai.model.error.unsavedDraft" });
      return;
    }
    if (profileId === "") {
      const pending = pendingNewDraftRef.current;
      pendingNewDraftRef.current = null;
      setCustomDraft(pending ? cloneProfile(pending) : createCustomProfileDraft());
      setCustomKeyDraft({ credentialId: "", value: "" });
      setExpandedCustomId("");
      return;
    }
    const latest = useSettingsStore.getState().ai ?? emptyAiSettings();
    const profile = latest.profiles.find((item) => item.id === profileId);
    if (!profile || !isCustomProfile(profile)) return;
    setCustomDraft(asCustomDraft(profile));
    setCustomKeyDraft({ credentialId: "", value: "" });
    setExpandedCustomId(profileId);
  }, [commitCustomDraft, expandedCustomId]);

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

  const effectiveCustomCredentialId = customDraft.credentialId?.trim()
    || customDraft.providerId?.trim()
    || "custom-draft";

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

  /** 「保存并启用」：写库 + 启用该条目 + 保持它展开。 */
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
      // v0.15.5 问题1：自定义页签保存 → 永远算自定义，与 Provider ID 是否撞预设 id 无关。
      source: "custom",
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
      pendingNewDraftRef.current = null;
      setExpandedCustomId(profileId);
      setCustomKeyDraft({ credentialId: "", value: "" });
      if (key) setKeyConfigured((previous) => ({ ...previous, [credentialId]: true }));
      setCustomNotice({ kind: "success", key: "settings.ai.model.status.customSaved" });
    } catch (error) {
      setCustomNotice({ kind: "error", key: credentialErrorKey(error) });
    } finally {
      setSavingCustom(false);
    }
  }, [customDraft, customIsNew, customKeyDraft, savingCustom, setAiSettings, store, validateCustom]);

  /** 新建自定义配置：展开「新建」草稿（不落库）。 */
  const handleNewCustomProfile = useCallback(() => {
    if (expandedCustomId !== null && !commitCustomDraft()) {
      setCustomNotice({ kind: "error", key: "settings.ai.model.error.unsavedDraft" });
      return;
    }
    const pending = pendingNewDraftRef.current;
    pendingNewDraftRef.current = null;
    setCustomDraft(pending ? cloneProfile(pending) : createCustomProfileDraft());
    setCustomKeyDraft({ credentialId: "", value: "" });
    setCustomNotice(null);
    setExpandedCustomId("");
  }, [commitCustomDraft, expandedCustomId]);

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

  const providerKeyValue = expandedProvider && providerKeyDraft.credentialId === expandedProvider.credentialId
    ? providerKeyDraft.value
    : "";
  const providerModelEntry = expandedProvider?.modelCatalog?.find(
    (entry) => entry.id === expandedProvider.model,
  );
  const providerSliderStops = providerModelEntry ? contextSliderStops(providerModelEntry) : [];
  const providerExactSliderIndex = expandedProvider
    ? providerSliderStops.indexOf(expandedProvider.contextWindowTokens)
    : -1;
  const providerSliderIndex = providerExactSliderIndex >= 0
    ? providerExactSliderIndex
    : Math.max(0, providerSliderStops.length - 1);

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

  const providerTabId = `${idPrefix}-provider-tab`;
  const customTabId = `${idPrefix}-custom-tab`;
  const providerPanelId = `${idPrefix}-provider-panel`;
  const customPanelId = `${idPrefix}-custom-panel`;

  const enableLabel = t("settings.ai.model.profile.enable");
  const disableLabel = t("settings.ai.model.profile.disable");
  const activeDotLabel = t("settings.ai.model.profile.activeDot");
  const deleteLabel = t("settings.ai.model.profile.delete");

  /**
   * 自定义页签的编辑表单。渲染在「展开条目」的 body 内；
   * 未展开任何条目时不渲染（accordion 语义）。
   */
  const renderCustomForm = (isNewDraft: boolean): ReactNode => (
    <div className="ai-model-profile-body-inner">
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
            readOnly={!isNewDraft}
            aria-readonly={!isNewDraft}
            onChange={(event) => isNewDraft && patchCustom({ providerId: event.target.value })}
            data-testid="ai-model-custom-provider-id"
          />
          {isNewDraft && <small className="settings-hint">{t("settings.ai.model.custom.providerIdHint")}</small>}
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
          {!isNewDraft && (
            <small className="ai-model-key-status">
              {keyConfigured[customDraft.credentialId] !== undefined
                ? t(keyConfigured[customDraft.credentialId]
                  ? "settings.ai.model.field.keyConfigured"
                  : "settings.ai.model.field.keyNotConfigured")
                : t("settings.ai.model.field.keyChecking")}
            </small>
          )}
        </div>

        {customDraft.authMode === "none" && (
          <div className="ai-model-static-value" data-testid="ai-model-custom-no-auth">
            {t("settings.ai.model.field.noAuth")}
          </div>
        )}

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
    </div>
  );

  const renderProviderForm = (profile: AiConnectionProfile): ReactNode => (
    <div className="ai-model-profile-body-inner">
      <div className="ai-model-tree">
        <div className="ai-model-field">
          <label htmlFor={`${idPrefix}-provider-key`}>{t("settings.ai.model.field.apiKey")}</label>
          {profile.authMode === "none" ? (
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
                  onChange={(event) => setProviderKeyDraft({
                    credentialId: profile.credentialId,
                    value: event.target.value,
                  })}
                  disabled={providerKeyBusy}
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
                {keyConfigured[profile.credentialId] && store.clear && (
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
                {keyConfigured[profile.credentialId] !== undefined
                  ? t(keyConfigured[profile.credentialId]
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
            value={profile.baseUrl}
            onChange={(event) => patchExpandedProvider({ baseUrl: event.target.value })}
            data-testid="ai-model-base-url"
          />
        </div>

        {/* v0.15.4 需求 5：两个按钮在「模型名称」输入框右侧。 */}
        <div className="ai-model-field">
          <label htmlFor={`${idPrefix}-provider-model`}>{t("settings.ai.model.field.model")}</label>
          <div className="ai-model-inline ai-model-model-row">
            <input
              id={`${idPrefix}-provider-model`}
              className="ai-input ai-input-mono"
              type="text"
              list={`${idPrefix}-provider-models`}
              value={profile.model}
              onChange={(event) => updateProfile(
                profile.id,
                (current) => applyModelSelection(current, event.target.value),
              )}
              data-testid="ai-model-name"
            />
            <button
              type="button"
              className="ai-btn"
              onClick={() => handleFetchModels(profile)}
              disabled={fetchingModels}
              data-testid="ai-model-fetch"
            >
              {t(fetchingModels ? "settings.ai.model.action.fetching" : "settings.ai.model.action.fetch")}
            </button>
            <button
              type="button"
              className="ai-btn"
              onClick={() => handleTestConnection(profile)}
              disabled={testingConnection}
              data-testid="ai-model-test"
            >
              {t(testingConnection ? "settings.ai.model.action.testing" : "settings.ai.model.action.test")}
            </button>
          </div>
          <datalist id={`${idPrefix}-provider-models`}>
            {(profile.modelCatalog ?? []).map((entry) => (
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
            value={profile.requestPolicy.temperature ?? ""}
            onChange={(event) => {
              const raw = event.target.value;
              const parsed = Number(raw);
              patchExpandedProvider({
                requestPolicy: {
                  ...profile.requestPolicy,
                  temperature: raw === "" || !Number.isFinite(parsed)
                    ? undefined
                    : Math.max(0, Math.min(2, parsed)),
                },
              });
            }}
            data-testid="ai-model-temperature"
          />
        </div>

        {providerSliderStops.length > 0 && (
          <div className="ai-model-field ai-model-context" data-testid="ai-model-context">
            <div className="ai-model-context-heading">
              <label htmlFor={`${idPrefix}-provider-context`}>{t("settings.ai.model.field.context")}</label>
              <output htmlFor={`${idPrefix}-provider-context`}>
                {formatTokenCount(profile.contextWindowTokens)}
              </output>
            </div>
            <input
              id={`${idPrefix}-provider-context`}
              type="range"
              min="0"
              max={providerSliderStops.length - 1}
              step="1"
              value={providerSliderIndex}
              onChange={(event) => {
                const nextContext = providerSliderStops[Number(event.target.value)];
                if (nextContext === undefined) return;
                updateProfile(profile.id, (current) => ({
                  ...current,
                  contextWindowTokens: nextContext,
                  maxOutputTokens: clampOutputTokens(current.maxOutputTokens, nextContext),
                }));
              }}
              data-testid="ai-model-context-slider"
            />
            <div className="ai-model-context-stops" aria-hidden="true">
              {providerSliderStops.map((stop) => <span key={stop}>{formatTokenCount(stop)}</span>)}
            </div>
          </div>
        )}
      </div>
    </div>
  );

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
          {/* v0.15.6：服务商页签只列**已配置过**的服务商；上方「添加服务商」只给未配置预设。 */}
          <div className="ai-model-profile-add-row">
            <label htmlFor={`${idPrefix}-provider-add`} className="ai-model-profile-add-label">
              {t("settings.ai.model.provider.add")}
            </label>
            <select
              id={`${idPrefix}-provider-add`}
              className="settings-select ai-model-profile-add-select"
              value={addProviderId}
              onChange={(event) => handleAddProvider(event.target.value)}
              data-testid="ai-model-provider-add-select"
            >
              <option value="">{t("settings.ai.model.provider.addPlaceholder")}</option>
              {addablePresetGroups.map((section) => (
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
            <button
              type="button"
              className="ai-btn"
              onClick={() => document.getElementById(`${idPrefix}-provider-add`)?.focus()}
              data-testid="ai-model-provider-add"
            >
              {t("settings.ai.model.provider.addAction")}
            </button>
          </div>

          {!providerProfiles.length ? (
            <p className="ai-model-profile-list-empty" data-testid="ai-model-provider-list-empty">
              {t("settings.ai.model.provider.listEmpty")}
            </p>
          ) : (
            <ul className="ai-model-profile-list" data-testid="ai-model-provider-list">
              {providerProfiles.map((profile) => {
                const isActive = profile.id === activeProfile?.id;
                const isExpanded = profile.id === expandedProviderId;
                return (
                  <ProfileListItem
                    key={profile.id}
                    variant="provider"
                    profile={profile}
                    isActive={isActive}
                    isExpanded={isExpanded}
                    onToggleExpanded={() => handleToggleProviderExpanded(profile.id)}
                    onToggleActive={() => handleToggleActive(profile.id)}
                    onDelete={() => handleDeleteProfile(profile.id)}
                    enableLabel={enableLabel}
                    disableLabel={disableLabel}
                    activeDotLabel={activeDotLabel}
                    deleteLabel={deleteLabel}
                    body={isExpanded ? (
                      <div
                        className="ai-model-profile-body"
                        data-testid={`ai-model-provider-body-${profile.id}`}
                      >
                        {renderProviderForm(profile)}
                      </div>
                    ) : null}
                  />
                );
              })}
            </ul>
          )}

          {providerNotice && (
            <p
              className={`ai-model-notice is-${providerNotice.kind}`}
              role={providerNotice.kind === "error" ? "alert" : "status"}
              data-testid="ai-model-provider-notice"
            >
              {t(providerNotice.key)}
            </p>
          )}
        </div>
      ) : (
        <div
          id={customPanelId}
          role="tabpanel"
          aria-labelledby={customTabId}
          className="ai-model-panel"
          data-testid="ai-model-custom-panel"
        >
          <div className="ai-model-custom-list-block">
            <div className="ai-model-custom-list-heading">
              <span className="ai-model-custom-list-title">{t("settings.ai.model.custom.listTitle")}</span>
              <button
                type="button"
                className="ai-btn"
                onClick={handleNewCustomProfile}
                disabled={customIsNew && expandedCustomId === ""}
                data-testid="ai-model-custom-new"
              >
                {t("settings.ai.model.custom.new")}
              </button>
            </div>
            {!customProfiles.length ? (
              <p className="ai-model-custom-list-empty" data-testid="ai-model-custom-list-empty">
                {t("settings.ai.model.custom.listEmpty")}
              </p>
            ) : (
              <ul className="ai-model-profile-list" data-testid="ai-model-custom-list">
                {customProfiles.map((profile) => {
                  const isActive = profile.id === activeProfile?.id;
                  const isExpanded = profile.id === expandedCustomId;
                  return (
                    <ProfileListItem
                      key={profile.id}
                      variant="custom"
                      profile={profile}
                      isActive={isActive}
                      isExpanded={isExpanded}
                      onToggleExpanded={() => handleToggleCustomExpanded(profile.id)}
                      onToggleActive={() => handleToggleActive(profile.id)}
                      onDelete={() => handleDeleteProfile(profile.id)}
                      enableLabel={enableLabel}
                      disableLabel={disableLabel}
                      activeDotLabel={activeDotLabel}
                      deleteLabel={deleteLabel}
                      body={isExpanded ? (
                        <div
                          className="ai-model-profile-body"
                          data-testid={`ai-model-custom-body-${profile.id}`}
                        >
                          {renderCustomForm(false)}
                        </div>
                      ) : null}
                    />
                  );
                })}
              </ul>
            )}

            {expandedCustomId === "" && (
              <div className="ai-model-profile-body is-standalone" data-testid="ai-model-custom-body-new">
                {renderCustomForm(true)}
              </div>
            )}
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
        </div>
      )}
    </section>
  );
}

export default AiModelSettings;
