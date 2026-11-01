import { invoke } from "@tauri-apps/api/core";
import type { AiConnectionProfile, AiModelCatalogEntry } from "./aiProfiles";
import { isTauri } from "./fileService";
import { parseTranslateError, TranslateServiceError } from "./translateService";

function connectionArgs(profile: AiConnectionProfile) {
  return {
    credentialId: profile.credentialId,
    provider: profile.providerId ?? profile.id,
    protocol: profile.protocol,
    baseUrl: profile.baseUrl,
    model: profile.model,
    authMode: profile.authMode,
  };
}

function listModelsArgs(profile: AiConnectionProfile) {
  return {
    ...connectionArgs(profile),
    // v0.15.4：本地部署类型让后端知道要额外探测 Ollama 原生 /api/tags。
    // 未设置时传 null，后端按 0.15.3 行为处理（只有 provider=ollama 才探测）。
    localKind: profile.localKind ?? null,
  };
}

function normalizeModel(entry: AiModelCatalogEntry): AiModelCatalogEntry | null {
  if (!entry || typeof entry.id !== "string" || !entry.id.trim()) return null;
  const context = Number(entry.contextWindowTokens);
  const min = Number(entry.minContextWindowTokens);
  return {
    id: entry.id,
    name: typeof entry.name === "string" && entry.name.trim() ? entry.name : entry.id,
    ...(Number.isSafeInteger(context) && context > 0 ? { contextWindowTokens: context } : {}),
    ...(Number.isSafeInteger(min) && min > 0 && min <= context ? { minContextWindowTokens: min } : {}),
    ...(entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {}),
  };
}

export const aiConnectionService = {
  async listModels(profile: AiConnectionProfile): Promise<AiModelCatalogEntry[]> {
    if (!isTauri()) throw new TranslateServiceError({ code: "NETWORK", detail: "non-tauri" });
    try {
      const result = await invoke<AiModelCatalogEntry[]>("list_ai_models", listModelsArgs(profile));
      return result.map(normalizeModel).filter((entry): entry is AiModelCatalogEntry => entry !== null);
    } catch (error) {
      throw new TranslateServiceError(parseTranslateError(error));
    }
  },

  async testConnection(profile: AiConnectionProfile): Promise<void> {
    if (!isTauri()) throw new TranslateServiceError({ code: "NETWORK", detail: "non-tauri" });
    try {
      await invoke("test_ai_connection", connectionArgs(profile));
    } catch (error) {
      throw new TranslateServiceError(parseTranslateError(error));
    }
  },
};
