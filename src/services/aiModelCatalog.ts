import {
  DEFAULT_AI_CONTEXT_WINDOW_TOKENS,
  DEFAULT_AI_MAX_OUTPUT_TOKENS,
  type AiConnectionProfile,
  type AiModelCatalogEntry,
  type AiSettings,
} from "./aiProfiles";
import type { AiProviderPreset } from "./aiProviderPresets";
import { AI_PROVIDER_PRESETS } from "./aiProviderPresets";

export const CUSTOM_PROVIDER_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

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
