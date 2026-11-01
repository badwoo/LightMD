import {
  DEFAULT_AI_CONTEXT_WINDOW_TOKENS,
  DEFAULT_AI_MAX_OUTPUT_TOKENS,
  type AiConnectionProfile,
  type AiModelCatalogEntry,
  type AiSettings,
  type ApiProtocol,
  type LocalDeploymentKind,
} from "./aiProfiles";
import type { AiProviderPreset } from "./aiProviderPresets";
import { AI_PROVIDER_PRESETS } from "./aiProviderPresets";

export const CUSTOM_PROVIDER_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * v0.15.4 需求 1：本地部署方案模板。
 *
 * 只预填「端点 + 协议 + 鉴权 + localKind」——模型目录一律留空，由「获取模型列表」
 * 从运行时真实探测（不硬编码未核实的模型名）。所有值都来自各运行时的官方文档端点。
 */
export interface LocalDeploymentPreset {
  kind: LocalDeploymentKind;
  /** i18n key（名称为运行时品牌，两种语言可同值） */
  nameKey: string;
  baseUrl: string;
  protocol: ApiProtocol;
  authMode: AiConnectionProfile["authMode"];
  /** 提示文案 key：说明该运行时是否支持原生接口 / 需要的端口 */
  hintKey: string;
}

export const LOCAL_DEPLOYMENT_PRESETS: readonly LocalDeploymentPreset[] = Object.freeze([
  {
    kind: "ollama",
    nameKey: "settings.ai.model.local.ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    protocol: "openai-chat",
    authMode: "none",
    hintKey: "settings.ai.model.localHint.ollama",
  },
  {
    kind: "lmstudio",
    nameKey: "settings.ai.model.local.lmstudio",
    baseUrl: "http://127.0.0.1:1234/v1",
    protocol: "openai-chat",
    authMode: "none",
    hintKey: "settings.ai.model.localHint.generic",
  },
  {
    kind: "vllm",
    nameKey: "settings.ai.model.local.vllm",
    baseUrl: "http://127.0.0.1:8000/v1",
    protocol: "openai-chat",
    authMode: "none",
    hintKey: "settings.ai.model.localHint.generic",
  },
  {
    kind: "llamacpp",
    nameKey: "settings.ai.model.local.llamacpp",
    /**
     * v0.15.4：与 `aiProviderPresets.ts` 的 `llama-cpp` 预设**必须是同一个端口**。
     *
     * 上游 `tools/server/README.md` 的 `--port` 编译期默认值是 9931（Docker 示例惯用 8080）。
     * 若这里写 8080，会与 LocalAI 撞 baseUrl —— 而 `inferProviderId`（本文件下方）是按
     * `normalizedBase(preset.baseUrl) === base` 做端点精确匹配的，于是「用户自建的
     * llama.cpp 档案」会被误判成 LocalAI 档案，服务商下拉里显示错名字。
     */
    baseUrl: "http://127.0.0.1:9931/v1",
    protocol: "openai-chat",
    authMode: "none",
    hintKey: "settings.ai.model.localHint.generic",
  },
  {
    kind: "localai",
    nameKey: "settings.ai.model.local.localai",
    baseUrl: "http://127.0.0.1:8080/v1",
    protocol: "openai-chat",
    authMode: "none",
    hintKey: "settings.ai.model.localHint.generic",
  },
]);

export function findLocalDeploymentPreset(kind: string): LocalDeploymentPreset | null {
  return LOCAL_DEPLOYMENT_PRESETS.find((preset) => preset.kind === kind) ?? null;
}

/** 选中「本地部署类型」后应用预填字段（不改 Provider ID / 名称 / 模型目录）。 */
export function applyLocalDeployment(
  profile: AiConnectionProfile,
  kind: LocalDeploymentKind,
): AiConnectionProfile {
  const preset = findLocalDeploymentPreset(kind);
  if (!preset) return profile;
  return {
    ...profile,
    localKind: kind,
    baseUrl: preset.baseUrl,
    protocol: preset.protocol,
    authMode: preset.authMode,
  };
}

function normalizedBase(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

/** 旧档案没有 providerId 时只按已保存端点识别；无法确定就归入自定义，不按模型名猜。 */
export function inferProviderId(profile: AiConnectionProfile): string {
  if (profile.providerId) return profile.providerId;
  const base = normalizedBase(profile.baseUrl);
  const exact = AI_PROVIDER_PRESETS.find((preset) => normalizedBase(preset.baseUrl) === base);
  if (exact) return exact.id;
  if (profile.id === "ai-default" && profile.name === "deepseek") return "deepseek";
  return "custom";
}

function fallbackProfileId(settings: AiSettings, preferred: string): string {
  if (!settings.profiles.some((profile) => profile.id === preferred)) return preferred;
  const suffix = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `${preferred}-${suffix}`;
}

/** 一个 Provider 复用一个档案和凭据槽，切换服务商绝不把旧 Key 带到新端点。 */
export function upsertProviderProfile(
  settings: AiSettings,
  preset: AiProviderPreset,
  displayName: string,
): { settings: AiSettings; profile: AiConnectionProfile } {
  const existing = settings.profiles.find((profile) => inferProviderId(profile) === preset.id);
  if (existing) {
    const profile = existing.providerId ? existing : { ...existing, providerId: preset.id };
    const profiles = settings.profiles.map((item) => item.id === profile.id ? profile : item);
    return {
      settings: { ...settings, profiles, activeProfileId: profile.id },
      profile,
    };
  }

  const id = fallbackProfileId(settings, preset.id);
  const first = preset.models[0];
  const contextWindowTokens = first?.contextWindowTokens ?? DEFAULT_AI_CONTEXT_WINDOW_TOKENS;
  const profile: AiConnectionProfile = {
    id,
    name: displayName,
    providerId: preset.id,
    protocol: preset.protocol,
    baseUrl: preset.baseUrl,
    model: first?.id ?? "",
    credentialId: id,
    authMode: preset.authMode,
    contextWindowTokens,
    maxOutputTokens: Math.max(1, Math.min(DEFAULT_AI_MAX_OUTPUT_TOKENS, contextWindowTokens - 1)),
    requestPolicy: {
      tokenField: "max_tokens",
      temperature: preset.temperature,
      reasoningEffort: undefined,
      includeStreamUsage: true,
    },
    modelCatalog: preset.models.map((entry) => ({ ...entry })),
  };
  return {
    settings: {
      ...settings,
      profiles: [...settings.profiles, profile],
      activeProfileId: id,
    },
    profile,
  };
}

/**
 * 把「刚探测到的目录」合并进现有目录。
 *
 * 规则：探测结果为准（新条目优先），但**已有条目的用户编辑不丢**——
 * 用户手工填的 name / contextWindowTokens / reasoningEffort 在没有新数据的维度上保留。
 * 这样「再拉一次列表」不会把自定义备注冲掉。
 */
export function mergeModelCatalog(
  existing: readonly AiModelCatalogEntry[] | undefined,
  fetched: readonly AiModelCatalogEntry[],
): AiModelCatalogEntry[] {
  const previousById = new Map((existing ?? []).map((entry) => [entry.id, entry]));
  const merged = fetched.map((entry) => {
    const previous = previousById.get(entry.id);
    if (!previous) return { ...entry };
    return {
      ...entry,
      name: entry.name || previous.name,
      contextWindowTokens: entry.contextWindowTokens ?? previous.contextWindowTokens,
      minContextWindowTokens: entry.minContextWindowTokens ?? previous.minContextWindowTokens,
      reasoningEffort: entry.reasoningEffort ?? previous.reasoningEffort,
    };
  });
  // 探测结果里没有、但用户手工保留的条目继续留下（避免「拉列表」把手工模型清掉）。
  for (const entry of existing ?? []) {
    if (!merged.some((item) => item.id === entry.id)) merged.push({ ...entry });
  }
  return merged;
}

/** 选择模型时同时应用其上下文与模型级推理档，并默认停在最大上下文档。 */
export function applyModelSelection(profile: AiConnectionProfile, modelId: string): AiConnectionProfile {
  const selected = profile.modelCatalog?.find((entry) => entry.id === modelId);
  const contextWindowTokens = selected?.contextWindowTokens ?? profile.contextWindowTokens;
  const maxOutputTokens = Math.max(1, Math.min(profile.maxOutputTokens, contextWindowTokens - 1));
  return {
    ...profile,
    model: modelId,
    contextWindowTokens,
    maxOutputTokens,
    requestPolicy: {
      ...profile.requestPolicy,
      reasoningEffort: selected?.reasoningEffort && selected.reasoningEffort !== "off"
        ? selected.reasoningEffort
        : undefined,
    },
  };
}

/** 两档为应用下限/模型上限；1M 及以上模型按需求在 600K 增加中间档。 */
export function contextSliderStops(entry: Pick<AiModelCatalogEntry, "contextWindowTokens" | "minContextWindowTokens">): number[] {
  const max = entry.contextWindowTokens;
  if (!max || !Number.isSafeInteger(max) || max <= 0) return [];
  const min = Math.min(max, Math.max(1, entry.minContextWindowTokens ?? 8192));
  const stops = [min];
  if (max >= 1_000_000 && min < 600_000 && max > 600_000) stops.push(600_000);
  if (max !== min) stops.push(max);
  return stops;
}

export function formatTokenCount(value: number): string {
  const format = (n: number, suffix: string) => `${n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2).replace(/\.0+$|(?<=\.[0-9])0+$/, "")}${suffix}`;
  if (value >= 1_000_000) return format(value / 1_000_000, "M");
  if (value >= 1_000) return format(value / 1_000, "K");
  return String(value);
}

/** 新建自定义 Provider 的本地草稿；保存时由 UI 将 Provider ID 同时写入 id/credentialId。 */
export function createCustomProfileDraft(): AiConnectionProfile {
  return {
    id: "",
    name: "",
    providerId: "",
    protocol: "openai-chat",
    baseUrl: "",
    model: "",
    credentialId: "",
    authMode: "required",
    contextWindowTokens: DEFAULT_AI_CONTEXT_WINDOW_TOKENS,
    maxOutputTokens: DEFAULT_AI_MAX_OUTPUT_TOKENS,
    requestPolicy: {
      tokenField: "max_tokens",
      temperature: 0.1,
      reasoningEffort: undefined,
      includeStreamUsage: true,
    },
    modelCatalog: [],
  };
}
