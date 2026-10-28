/**
 * v0.15.0 R3c：AI 连接档案的**纯操作函数**（增删改/复制/排序/预设）。
 *
 * 为什么把这些操作从组件里抽出来：
 * - 「复制档案」要换新 id 且 credentialId 必须同步跟着换（凭据按 credentialId 分槽，
 *   漏换会让两个档案共用同一 Key —— 正是设计 §0 审计里"同 provider 双 baseUrl 串 Key"的同类缺陷）；
 * - 「删除默认档案」要顺带选出新的默认档案，空列表时 activeProfileId 必须清空而不是留悬空 id；
 * - 这些不变量极容易在 JSX 里写错，抽成纯函数后可直接单测。
 *
 * 本模块**不读 store、不碰 DOM、不碰 API Key**：只做 AiSettings/AiConnectionProfile 的不可变变换。
 */
import {
  DEFAULT_AI_CONTEXT_WINDOW_TOKENS,
  DEFAULT_AI_MAX_OUTPUT_TOKENS,
  type AiConnectionProfile,
  type AiSettings,
  type ApiProtocol,
} from "../../services/aiProfiles";

/** 新建档案时生成稳定随机 ID（与 aiProfiles.ts 同口径：优先 Web Crypto） */
export function newProfileId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  // 仅给无 Web Crypto 的旧宿主/测试环境用；正常应用始终走 randomUUID。
  return `ai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** 预设模板：只预填端点/协议/认证模式，**模型 ID 一律留空** */
export interface AiProfilePreset {
  /** 稳定标识（测试与文案 key 用） */
  id: "blank" | "ollama" | "volc-anthropic" | "volc-openai";
  /** 预设名（用户可改；用 i18n key 由组件翻译，纯函数只给 key） */
  nameKey: string;
  protocol: ApiProtocol;
  baseUrl: string;
  authMode: AiConnectionProfile["authMode"];
  /** 预设说明的 i18n key（写在选择器旁边，解释"为什么模型要自己填"） */
  hintKey: string;
}

/**
 * 内置预设。
 *
 * 设计 §3 / §6 明确：**不硬编码任何未核实的模型名**，也不按模型名猜能力
 * —— 因此所有预设的 `model` 都是空串，由用户照自己的账户文档填写。
 * Ollama 预设 `authMode: "none"`（本地服务不需要 Key，也绝不写入假 Key）。
 */
export const AI_PROFILE_PRESETS: readonly AiProfilePreset[] = Object.freeze([
  {
    id: "blank",
    nameKey: "settings.ai.preset.blank.name",
    protocol: "openai-chat",
    baseUrl: "",
    authMode: "required",
    hintKey: "settings.ai.preset.blank.hint",
  },
  {
    id: "ollama",
    nameKey: "settings.ai.preset.ollama.name",
    protocol: "openai-chat",
    baseUrl: "http://127.0.0.1:11434/v1",
    authMode: "none",
    hintKey: "settings.ai.preset.ollama.hint",
  },
  {
    id: "volc-anthropic",
    nameKey: "settings.ai.preset.volcAnthropic.name",
    protocol: "anthropic-messages",
    baseUrl: "https://ark.cn-beijing.volces.com/api/plan",
    authMode: "required",
    hintKey: "settings.ai.preset.volc.hint",
  },
  {
    id: "volc-openai",
    nameKey: "settings.ai.preset.volcOpenai.name",
    protocol: "openai-chat",
    baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
    authMode: "required",
    hintKey: "settings.ai.preset.volc.hint",
  },
]);

/** 取预设定义（未知 id 返回 null，不静默回落到别的端点） */
export function findPreset(id: string): AiProfilePreset | null {
  return AI_PROFILE_PRESETS.find((preset) => preset.id === id) ?? null;
}

/** 空白档案的字段默认值（非预设时使用） */
export function createBlankProfile(
  name = "",
  id: string = newProfileId(),
): AiConnectionProfile {
  return {
    id,
    name,
    protocol: "openai-chat",
    baseUrl: "",
    model: "",
    // credentialId 必须等于 id：凭据按它分槽（aiProfiles.validateAiConnectionProfile 会校验这条）
    credentialId: id,
    authMode: "required",
    contextWindowTokens: DEFAULT_AI_CONTEXT_WINDOW_TOKENS,
    maxOutputTokens: DEFAULT_AI_MAX_OUTPUT_TOKENS,
    requestPolicy: {
      tokenField: "max_tokens",
      // undefined = 请求里不发送 temperature（推理类模型对温度敏感，默认不发）
      temperature: undefined,
      // undefined = 不发送 reasoning_effort；只在用户显式选择档位时才发
      reasoningEffort: undefined,
      includeStreamUsage: true,
    },
    systemPrompt: undefined,
  };
}

/**
 * 按预设创建档案。
 *
 * 注意 `name` 传的是**已翻译**的文案（组件用 `t(preset.nameKey)` 传入），
 * 纯函数不依赖 i18n 运行时，测试可直接断言。
 */
export function createProfileFromPreset(
  presetId: string,
  name: string,
  id: string = newProfileId(),
): AiConnectionProfile {
  const preset = findPreset(presetId);
  const base = createBlankProfile(name, id);
  if (!preset) return base;
  return {
    ...base,
    protocol: preset.protocol,
    baseUrl: preset.baseUrl,
    authMode: preset.authMode,
    // model 保持空串：不硬编码未核实的模型名（设计 §6）
    model: "",
  };
}

/**
 * 复制档案。
 *
 * **id 与 credentialId 必须同时换成新值**：否则两个档案共用同一个 keyring 槽位，
 * 删掉其中一个（或改它的 Key）会牵连另一个。新档案的 Key 由用户重新设置。
 */
export function duplicateProfile(
  profile: AiConnectionProfile,
  name: string,
  id: string = newProfileId(),
): AiConnectionProfile {
  return {
    ...profile,
    id,
    credentialId: id,
    name,
    requestPolicy: { ...profile.requestPolicy },
  };
}

/** 追加档案；activeProfileId 为空时自动选中新档案（空列表首次新增的场景） */
export function appendProfile(settings: AiSettings, profile: AiConnectionProfile): AiSettings {
  return {
    ...settings,
    profiles: [...settings.profiles, profile],
    activeProfileId: settings.activeProfileId || profile.id,
  };
}

/** 局部更新某个档案（不改 id/credentialId，避免凭据槽位漂移） */
export function updateProfile(
  settings: AiSettings,
  id: string,
  patch: Partial<AiConnectionProfile>,
): AiSettings {
  return {
    ...settings,
    profiles: settings.profiles.map((profile) =>
      profile.id === id ? { ...profile, ...patch, id: profile.id, credentialId: profile.credentialId } : profile,
    ),
  };
}

/**
 * 删除档案并修正 activeProfileId。
 *
 * 删除的是当前默认档案时：优先选中原位置的下一项，否则上一项；列表空则清空
 * activeProfileId（**不保留悬空 id**，否则 resolveAiConnection 会静默返回 null 而 UI 仍显示"已选中"）。
 */
export function removeProfile(settings: AiSettings, id: string): AiSettings {
  const index = settings.profiles.findIndex((profile) => profile.id === id);
  if (index < 0) return settings;
  const profiles = settings.profiles.filter((profile) => profile.id !== id);
  if (settings.activeProfileId !== id) {
    return { ...settings, profiles };
  }
  const fallback = profiles[index] ?? profiles[index - 1] ?? null;
  return { ...settings, profiles, activeProfileId: fallback?.id ?? "" };
}

/** 设为默认档案（id 不存在时原样返回，不产生悬空 activeProfileId） */
export function setActiveProfile(settings: AiSettings, id: string): AiSettings {
  if (!settings.profiles.some((profile) => profile.id === id)) return settings;
  return { ...settings, activeProfileId: id };
}

/** 上移/下移档案（边界处原样返回；顺序即列表展示顺序，与 activeProfileId 无关） */
export function moveProfile(settings: AiSettings, id: string, direction: -1 | 1): AiSettings {
  const index = settings.profiles.findIndex((profile) => profile.id === id);
  if (index < 0) return settings;
  const target = index + direction;
  if (target < 0 || target >= settings.profiles.length) return settings;
  const profiles = [...settings.profiles];
  const [moved] = profiles.splice(index, 1);
  profiles.splice(target, 0, moved!);
  return { ...settings, profiles };
}

/** 整体替换指令库（指令编辑器走这里） */
export function replaceInstructions(settings: AiSettings, instructions: AiSettings["instructions"]): AiSettings {
  return { ...settings, instructions };
}

/** 当前是否已配置任何档案（空态引导的判据） */
export function hasProfiles(settings: AiSettings | null | undefined): boolean {
  return Boolean(settings && Array.isArray(settings.profiles) && settings.profiles.length > 0);
}

/**
 * 温度输入框的文本 → policy.temperature（空 = undefined = 请求里不发送）。
 *
 * 语义：**空串是合法输入**（用户明确要求"不发送"），不是"填错"。
 * 非法数字返回 `{ ok: false }`，由调用方就地报错，不写进 store。
 */
export function parseTemperatureInput(
  raw: string,
): { ok: true; value: number | undefined } | { ok: false; value: undefined } {
  const text = raw.trim();
  if (text === "") return { ok: true, value: undefined };
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0 || value > 2) return { ok: false, value: undefined };
  return { ok: true, value };
}

/**
 * 整数输入框的文本 → 正整数（空/非法返回 null，由调用方决定不提交）。
 *
 * 用于 contextWindowTokens / maxOutputTokens：用户输入过程中会有 ""、"3" 这类
 * 中间态，此时**不能**把 NaN 或 0 写进 persist，保持上次有效值并就地报错。
 */
export function parsePositiveIntInput(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}
