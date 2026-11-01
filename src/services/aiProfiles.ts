/**
 * AI 连接档案 DTO、旧设置迁移与发送前校验。
 *
 * 本模块不读取/写入 API Key：credentialId 只是系统凭据库条目的稳定标识。
 * 连接能力由用户显式配置，不根据 provider 或 model 名称猜测。
 */

export type ApiProtocol = "openai-chat" | "openai-responses" | "anthropic-messages";
export type TokenField = "max_tokens" | "max_completion_tokens";
/** off 是 UI 默认值；写入请求前会归一为 undefined（不发送推理参数）。 */
export type ReasoningEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AiRequestPolicy {
  tokenField: TokenField;
  /** undefined = 请求中不发送 temperature。 */
  temperature?: number;
  /** 未配置不发送；仅 openai-chat 有效。 */
  reasoningEffort?: ReasoningEffort;
  includeStreamUsage: boolean;
}

export interface AiModelCatalogEntry {
  id: string;
  name: string;
  /** 服务端或用户明确提供的最大上下文；缺失时不按模型名猜测。 */
  contextWindowTokens?: number;
  /** 服务端明确提供的最小上下文；缺失时滑条使用应用下限。 */
  minContextWindowTokens?: number;
  /** 每个模型独立的默认推理档；off 表示不发送推理参数。 */
  reasoningEffort?: ReasoningEffort;
}

export interface AiConnectionProfile {
  id: string;
  name: string;
  /** 预设或自定义 Provider ID；旧档案缺失时由 UI 按端点推断。 */
  providerId?: string;
  protocol: ApiProtocol;
  baseUrl: string;
  model: string;
  /** 等于 profile.id；不是凭据明文。 */
  credentialId: string;
  authMode: "required" | "optional" | "none";
  contextWindowTokens: number;
  maxOutputTokens: number;
  requestPolicy: AiRequestPolicy;
  systemPrompt?: string;
  /** 当前服务商的模型目录（静态预设、动态探测或用户自定义）。 */
  modelCatalog?: AiModelCatalogEntry[];
}

export interface AiSettings {
  profiles: AiConnectionProfile[];
  activeProfileId: string;
  instructions: AiInstruction[];
  /** token plan 用量仅会话内展示，不持久化。 */
}

export interface AiInstruction {
  id: string;
  name: string;
  scope: "selection" | "document" | "none";
  systemSuffix?: string;
  userTemplate: string;
}

/** 旧 translate 配置中迁移 AI 连接所需的最小结构，避免反向依赖 settings store。 */
export interface LegacyAiConnectionSettings {
  translateProviderPreset?: unknown;
  translateBaseUrl?: unknown;
  translateModel?: unknown;
  translateTemperature?: unknown;
}

export interface LegacySettingsWithAi {
  translate?: LegacyAiConnectionSettings;
  ai?: AiSettings;
}

export const DEFAULT_AI_CONTEXT_WINDOW_TOKENS = 32 * 1024;
export const DEFAULT_AI_MAX_OUTPUT_TOKENS = 4 * 1024;

export type AiProfileValidationError =
  | "profile.id.required"
  | "profile.name.required"
  | "profile.protocol.invalid"
  | "profile.baseUrl.required"
  | "profile.model.required"
  | "profile.credentialId.mismatch"
  | "profile.authMode.invalid"
  | "profile.contextWindowTokens.invalid"
  | "profile.maxOutputTokens.invalid"
  | "profile.requestPolicy.invalid"
  | "profile.temperature.invalid"
  | "profile.providerId.invalid"
  | "profile.modelCatalog.invalid";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function newProfileId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  // 仅给无 Web Crypto 的旧测试/宿主环境使用；正常应用始终走 randomUUID。
  return `ai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function migratedTemperature(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 2
    ? value
    : undefined;
}

/**
 * 从旧 translate 连接创建一个 AI profile。
 * 保守的 32K/4K 是待用户核对的配置默认值，不是对任何模型能力的断言。
 */
export function createAiProfileFromLegacy(
  legacy: LegacyAiConnectionSettings = {},
  id: string = newProfileId(),
): AiConnectionProfile {
  const provider = text(legacy.translateProviderPreset);
  return {
    id,
    name: provider || "AI connection",
    providerId: provider || "custom",
    protocol: "openai-chat",
    baseUrl: text(legacy.translateBaseUrl),
    model: text(legacy.translateModel),
    credentialId: id,
    authMode: "required",
    contextWindowTokens: DEFAULT_AI_CONTEXT_WINDOW_TOKENS,
    maxOutputTokens: DEFAULT_AI_MAX_OUTPUT_TOKENS,
    requestPolicy: {
      tokenField: "max_tokens",
      temperature: migratedTemperature(legacy.translateTemperature),
      includeStreamUsage: true,
    },
  };
}

export function createAiSettingsFromLegacy(
  legacy: LegacyAiConnectionSettings = {},
  id?: string,
): AiSettings {
  const profile = createAiProfileFromLegacy(legacy, id);
  return { profiles: [profile], activeProfileId: profile.id, instructions: [] };
}

/** v0.15.3：全新安装默认使用本地 Ollama；旧用户仍由 migrateAiSettings 保留原连接。 */
export function createDefaultAiSettings(): AiSettings {
  const profile: AiConnectionProfile = {
    id: "ollama",
    name: "Ollama（本地）",
    providerId: "ollama",
    protocol: "openai-chat",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "",
    credentialId: "ollama",
    authMode: "none",
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
  return { profiles: [profile], activeProfileId: profile.id, instructions: [] };
}

/**
 * persist 迁移纯函数：已有 ai（包括用户后来清空的 profiles）原样保留；
 * 只有 ai 缺失时才从 translate 复制，因此重复执行不会再次复制或生成新 ID。
 */
export function migrateAiSettings(
  persisted: LegacySettingsWithAi | null | undefined,
  id?: string,
): AiSettings {
  if (persisted && Object.prototype.hasOwnProperty.call(persisted, "ai") && persisted.ai !== undefined) {
    return persisted.ai;
  }
  return createAiSettingsFromLegacy(persisted?.translate ?? {}, id);
}

/** 取 activeProfileId 指向的连接；无匹配返回 null，不静默改用其他 profile。 */
export function resolveAiConnection(settings: AiSettings): AiConnectionProfile | null {
  if (!settings || !Array.isArray(settings.profiles)) return null;
  return settings.profiles.find((profile) => profile.id === settings.activeProfileId) ?? null;
}

export function isAiTokenBudgetValid(
  profile: Pick<AiConnectionProfile, "contextWindowTokens" | "maxOutputTokens">,
): boolean {
  const { contextWindowTokens, maxOutputTokens } = profile;
  return (
    Number.isSafeInteger(contextWindowTokens) &&
    contextWindowTokens > 0 &&
    Number.isSafeInteger(maxOutputTokens) &&
    maxOutputTokens >= 1 &&
    maxOutputTokens < contextWindowTokens
  );
}

/** 设置页/发送前共用的完整校验；返回机器可读错误码，空数组表示可发送。 */
export function validateAiConnectionProfile(profile: AiConnectionProfile): AiProfileValidationError[] {
  const errors: AiProfileValidationError[] = [];
  if (!text(profile.id)) errors.push("profile.id.required");
  if (!text(profile.name)) errors.push("profile.name.required");
  if (!["openai-chat", "openai-responses", "anthropic-messages"].includes(profile.protocol)) {
    errors.push("profile.protocol.invalid");
  }
  if (profile.providerId !== undefined && !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(profile.providerId)) {
    errors.push("profile.providerId.invalid");
  }
  if (!text(profile.baseUrl)) errors.push("profile.baseUrl.required");
  if (!text(profile.model)) errors.push("profile.model.required");
  if (!text(profile.credentialId) || profile.credentialId !== profile.id) {
    errors.push("profile.credentialId.mismatch");
  }
  if (!["required", "optional", "none"].includes(profile.authMode)) {
    errors.push("profile.authMode.invalid");
  }
  if (!isAiTokenBudgetValid(profile)) {
    if (!Number.isSafeInteger(profile.contextWindowTokens) || profile.contextWindowTokens <= 0) {
      errors.push("profile.contextWindowTokens.invalid");
    }
    if (
      !Number.isSafeInteger(profile.maxOutputTokens) ||
      profile.maxOutputTokens < 1 ||
      profile.maxOutputTokens >= profile.contextWindowTokens
    ) {
      errors.push("profile.maxOutputTokens.invalid");
    }
  }
  if (profile.modelCatalog !== undefined) {
    const ids = new Set<string>();
    const valid = Array.isArray(profile.modelCatalog) && profile.modelCatalog.every((entry) => {
      const contextValid = entry.contextWindowTokens === undefined ||
        (Number.isSafeInteger(entry.contextWindowTokens) && entry.contextWindowTokens > 0);
      const minValid = entry.minContextWindowTokens === undefined ||
        (Number.isSafeInteger(entry.minContextWindowTokens) && entry.minContextWindowTokens > 0 &&
          (entry.contextWindowTokens === undefined || entry.minContextWindowTokens <= entry.contextWindowTokens));
      const duplicate = ids.has(entry.id);
      ids.add(entry.id);
      return Boolean(text(entry.id)) && !duplicate && Boolean(text(entry.name)) && contextValid && minValid;
    });
    if (!valid) errors.push("profile.modelCatalog.invalid");
  }
  const policy = profile.requestPolicy;
  if (!policy || (policy.tokenField !== "max_tokens" && policy.tokenField !== "max_completion_tokens")) {
    errors.push("profile.requestPolicy.invalid");
  }
  const temperature = policy?.temperature;
  if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    errors.push("profile.temperature.invalid");
  }
  return errors;
}
