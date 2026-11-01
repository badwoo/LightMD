import type { AiConnectionProfile, AiModelCatalogEntry, ApiProtocol } from "./aiProfiles";

/**
 * 服务商下拉的分组维度。只在这里定义一次，UI 按 group 分 `<optgroup>`，
 * 不再手写第二份「id → 分组」清单（那样迟早和 AI_PROVIDER_PRESETS 对不上）。
 *
 * - local：本机部署运行时（loopback 端点，无需 API Key）
 * - cn：国内厂商（含各自的 Coding/Token Plan 端点）
 * - intl：国际厂商（含聚合网关与推理托管商）
 */
export type AiProviderGroup = "local" | "cn" | "intl";

/** 下拉分组顺序与 i18n label key；顺序即 UI 呈现顺序（本地优先，因为默认服务商是 Ollama）。 */
export const AI_PROVIDER_GROUPS: readonly { group: AiProviderGroup; labelKey: string }[] =
  Object.freeze([
    { group: "local", labelKey: "settings.ai.model.providerGroup.local" },
    { group: "cn", labelKey: "settings.ai.model.providerGroup.cn" },
    { group: "intl", labelKey: "settings.ai.model.providerGroup.intl" },
  ]);

/** 左侧「服务商」页签的内置连接预设；自定义 Provider 不在此处出现。 */
export interface AiProviderPreset {
  id: string;
  /** 下拉分组；见 AiProviderGroup。 */
  group: AiProviderGroup;
  nameKey: string;
  baseUrl: string;
  protocol: ApiProtocol;
  authMode: AiConnectionProfile["authMode"];
  temperature: number;
  models: AiModelCatalogEntry[];
}

function model(id: string, name = id, contextWindowTokens?: number): AiModelCatalogEntry {
  return { id, name, ...(contextWindowTokens ? { contextWindowTokens } : {}) };
}

function models(ids: readonly string[]): AiModelCatalogEntry[] {
  return ids.map((id) => model(id));
}

export const AI_DEFAULT_PROVIDER_ID = "ollama";

/**
 * Plan 预设与 0.15.0 的火山端点、DeepSeek Harness 随附 pi-ai 模型目录保持一致。
 * 上下文只填写有明确目录数据的项目；其他模型等待 /models 或 Ollama 原生接口探测。
 */
export const AI_PROVIDER_PRESETS: readonly AiProviderPreset[] = Object.freeze([
  {
    id: "ollama",
    group: "local",
    nameKey: "settings.ai.provider.ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    protocol: "openai-chat",
    authMode: "none",
    temperature: 0.1,
    models: [],
  },
  {
    id: "deepseek",
    group: "cn",
    nameKey: "settings.translate.provider.deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: models(["deepseek-v4-flash", "deepseek-v4-pro"]),
  },
  {
    id: "zhipu",
    group: "cn",
    nameKey: "settings.translate.provider.zhipu",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: models(["glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5.1", "glm-5", "glm-4.7", "glm-4.7-flash"]),
  },
  {
    id: "zhipu-coding-plan",
    group: "cn",
    nameKey: "settings.ai.provider.zhipuPlan",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: [
      model("glm-5.3", "GLM-5.3", 1_000_000),
      model("glm-5.3-flash", "GLM-5.3 Flash", 1_000_000),
      model("glm-5.3-highspeed", "GLM-5.3 Highspeed", 1_000_000),
      model("glm-4.6v", "GLM-4.6V", 128_000),
    ],
  },
  {
    id: "minimax",
    group: "cn",
    nameKey: "settings.translate.provider.minimax",
    baseUrl: "https://api.minimax.cn/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: models(["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5"]),
  },
  {
    id: "alibaba",
    group: "cn",
    nameKey: "settings.translate.provider.alibaba",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: models(["qwen3.8-max", "qwen3.8-flash", "qwen3.7-plus", "qwen3.7-flash", "qwen-plus", "qwen-flash"]),
  },
  {
    id: "alibaba-token-plan",
    group: "cn",
    nameKey: "settings.ai.provider.alibabaPlan",
    baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: [
      model("deepseek-v4-flash", "DeepSeek V4 Flash", 1_000_000),
      model("deepseek-v4-pro", "DeepSeek V4 Pro", 1_000_000),
      model("deepseek-v4.1-flash", "DeepSeek V4.1 Flash", 1_000_000),
      model("qwen3.8-max", "Qwen3.8 Max", 1_000_000),
      model("qwen3.8-flash", "Qwen3.8 Flash", 1_000_000),
      model("glm-5.3", "GLM-5.3", 1_000_000),
      model("kimi-k2.7-code", "Kimi K2.7 Code", 262_144),
      model("MiniMax-M2.5", "MiniMax M2.5", 196_608),
    ],
  },
  {
    id: "kimi",
    group: "cn",
    nameKey: "settings.translate.provider.kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 1,
    models: models(["kimi-k3", "kimi-k2.6", "kimi-k2.7-code", "kimi-k2.7-code-highspeed"]),
  },
  {
    id: "kimicode",
    group: "cn",
    nameKey: "settings.translate.provider.kimicode",
    baseUrl: "https://api.kimi.com/coding/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 1,
    models: models(["k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed"]),
  },
  {
    id: "kimi-plan",
    group: "cn",
    nameKey: "settings.ai.provider.kimiPlan",
    baseUrl: "https://api.kimi.com/coding",
    protocol: "anthropic-messages",
    authMode: "required",
    temperature: 1,
    models: [
      model("k3", "Kimi K3", 1_048_576),
      model("k3-256k", "Kimi K3-256K", 262_144),
      model("kimi-for-coding", "kimi-for-coding", 1_048_576),
      model("kimi-for-coding-highspeed", "Kimi For Coding HighSpeed", 262_144),
    ],
  },
  {
    id: "volcengine",
    group: "cn",
    nameKey: "settings.translate.provider.volcengine",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: models(["doubao-seed-2-1-pro-260628", "doubao-seed-2-1-turbo-260628", "doubao-seed-2-0-lite-260428", "doubao-seed-2-0-mini-260428"]),
  },
  {
    id: "volcengine-coding-plan",
    group: "cn",
    nameKey: "settings.ai.provider.volcenginePlan",
    baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: [],
  },
  {
    id: "doubao",
    group: "cn",
    nameKey: "settings.translate.provider.doubao",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: models(["doubao-seed-evolving", "doubao-seed-2-1-pro-260628", "doubao-seed-2-1-turbo-260628"]),
  },
  {
    id: "hunyuan",
    group: "cn",
    nameKey: "settings.translate.provider.hunyuan",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: models(["hunyuan-turbos-latest", "hunyuan-turbo", "hunyuan-lite"]),
  },
  {
    id: "xunfei",
    group: "cn",
    nameKey: "settings.translate.provider.xunfei",
    baseUrl: "https://spark-api-open.xf-yun.com/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: models(["4.0Ultra", "max-32k", "lite"]),
  },
  {
    id: "stepfun",
    group: "cn",
    nameKey: "settings.translate.provider.stepfun",
    baseUrl: "https://api.stepfun.com/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: models(["step-3.7-flash", "step-3.5-flash"]),
  },
  {
    id: "baidu",
    group: "cn",
    nameKey: "settings.translate.provider.baidu",
    baseUrl: "https://qianfan.baidubce.com/v2",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: models(["ernie-5.0", "ernie-4.5-turbo-128k", "ernie-4.5-turbo-32k"]),
  },
  {
    id: "lingyi",
    group: "cn",
    nameKey: "settings.translate.provider.lingyi",
    baseUrl: "https://api.lingyiwanwu.com/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: models(["yi-lightning", "yi-large"]),
  },
  {
    id: "baichuan",
    group: "cn",
    nameKey: "settings.translate.provider.baichuan",
    baseUrl: "https://api.baichuan-ai.com/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: models(["Baichuan4-Turbo", "Baichuan4-Air", "Baichuan4"]),
  },
  {
    id: "sensenova",
    group: "cn",
    nameKey: "settings.translate.provider.sensenova",
    baseUrl: "https://api.sensenova.cn/compatible-mode/v2",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: models(["SenseChat-5", "SenseChat-Turbo"]),
  },
  {
    id: "antling",
    group: "cn",
    nameKey: "settings.translate.provider.antling",
    baseUrl: "https://api.ant-ling.com/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: models(["Ling-3.0-flash", "Ling-2.6-1T", "Ling-2.6-flash", "Ring-2.6-1T"]),
  },
  {
    id: "gemini",
    group: "intl",
    nameKey: "settings.translate.provider.gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: models(["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3-pro", "gemini-2.5-flash", "gemini-2.5-pro"]),
  },
  {
    id: "claude",
    group: "intl",
    nameKey: "settings.translate.provider.claude",
    baseUrl: "https://api.anthropic.com",
    protocol: "anthropic-messages",
    authMode: "required",
    temperature: 0.1,
    models: models(["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-7"]),
  },
  {
    id: "modelscope",
    group: "cn",
    nameKey: "settings.translate.provider.modelscope",
    baseUrl: "https://api-inference.modelscope.cn/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: models(["Qwen/Qwen3-235B-A22B", "deepseek-ai/DeepSeek-V3.1"]),
  },
  {
    id: "siliconflow",
    group: "cn",
    nameKey: "settings.translate.provider.siliconflow",
    baseUrl: "https://api.siliconflow.cn/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: models(["deepseek-ai/DeepSeek-V4-Flash", "moonshotai/Kimi-K2.6", "Qwen/Qwen3.6-35B-A3B"]),
  },
  {
    id: "openai",
    group: "intl",
    nameKey: "settings.translate.provider.openai",
    baseUrl: "https://api.openai.com/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: models(["gpt-5.2", "gpt-5-mini", "gpt-5.1", "gpt-4.1-mini"]),
  },
  // ─── v0.15.4 服务商覆盖：国际厂商 ────────────────────────────────
  // 端点均以「OpenAI 兼容 base」为准，由 ai_request.rs 的 endpoint_url 追加协议路径。
  {
    id: "xai",
    group: "intl",
    nameKey: "settings.ai.provider.xai",
    baseUrl: "https://api.x.ai/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: [
      model("grok-4.7", "Grok 4.7", 500_000),
      model("grok-4.6", "Grok 4.6", 500_000),
      model("grok-4.5", "Grok 4.5", 500_000),
      model("grok-4.3", "Grok 4.3", 1_000_000),
    ],
  },
  {
    id: "mistral",
    group: "intl",
    nameKey: "settings.ai.provider.mistral",
    baseUrl: "https://api.mistral.ai/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: [
      model("mistral-large-4", "Mistral Large 4", 1_048_576),
      model("mistral-small-latest", "Mistral Small", 262_144),
      model("devstral-medium-latest", "Devstral 2", 262_144),
      model("ministral-14b-2512", "Ministral 3 14B", 262_144),
    ],
  },
  {
    id: "cohere",
    group: "intl",
    nameKey: "settings.ai.provider.cohere",
    baseUrl: "https://api.cohere.ai/compatibility/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: [
      model("command-a-plus-05-2026", "Command A Plus", 128_000),
      model("command-a-03-2025", "Command A", 256_000),
      model("north-mini-code-1-0", "North Mini Code", 256_000),
    ],
  },
  {
    id: "groq",
    group: "intl",
    nameKey: "settings.ai.provider.groq",
    baseUrl: "https://api.groq.com/openai/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: [
      model("llama-3.3-70b-versatile", "Llama 3.3 70B", 131_072),
      model("openai/gpt-oss-120b", "GPT OSS 120B", 131_072),
      model("qwen/qwen3.8-27b", "Qwen3.8 27B", 131_072),
    ],
  },
  {
    id: "together",
    group: "intl",
    nameKey: "settings.ai.provider.together",
    baseUrl: "https://api.together.xyz/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: [
      model("deepseek-ai/DeepSeek-V4.1-Flash", "DeepSeek V4.1 Flash", 1_048_576),
      model("MiniMaxAI/MiniMax-M3", "MiniMax-M3", 524_288),
      model("meta-llama/Llama-3.3-70B-Instruct-Turbo", "Llama 3.3 70B", 131_072),
    ],
  },
  {
    id: "fireworks",
    group: "intl",
    nameKey: "settings.ai.provider.fireworks",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: [
      model("accounts/fireworks/models/deepseek-v4p1-flash", "DeepSeek V4.1 Flash", 1_000_000),
      model("accounts/fireworks/models/kimi-k3", "Kimi K3", 1_048_576),
      model("accounts/fireworks/models/glm-5p3", "GLM-5.3", 1_048_573),
    ],
  },
  {
    id: "deepinfra",
    group: "intl",
    nameKey: "settings.ai.provider.deepinfra",
    // DeepInfra 的 OpenAI 兼容前缀是 /v1/openai，与 /v1 原生接口不同。
    baseUrl: "https://api.deepinfra.com/v1/openai",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: [
      model("deepseek-ai/DeepSeek-V4.1-Flash", "DeepSeek V4.1 Flash", 1_048_576),
      model("MiniMaxAI/MiniMax-M3", "MiniMax-M3", 524_288),
      model("thinkingmachines/Inkling", "Inkling", 524_288),
    ],
  },
  {
    id: "openrouter",
    group: "intl",
    nameKey: "settings.ai.provider.openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: [
      model("deepseek/deepseek-v4.1-flash", "DeepSeek V4.1 Flash", 1_048_576),
      model("anthropic/claude-sonnet-4.6", "Claude Sonnet 4.6", 1_000_000),
      model("openai/gpt-5.5", "GPT-5.5", 1_050_000),
      model("google/gemini-3.8-flash", "Gemini 3.8 Flash", 1_048_576),
    ],
  },
  {
    id: "perplexity",
    group: "intl",
    nameKey: "settings.ai.provider.perplexity",
    // base 不含 /v1：Perplexity 的兼容路径是 /chat/completions。
    baseUrl: "https://api.perplexity.ai",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: [
      model("sonar-pro", "Sonar Pro", 200_000),
      model("sonar", "Sonar", 128_000),
      model("sonar-reasoning-pro", "Sonar Reasoning Pro", 128_000),
    ],
  },
  {
    id: "cerebras",
    group: "intl",
    nameKey: "settings.ai.provider.cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: [
      model("gpt-oss-120b", "GPT OSS 120B", 131_072),
      model("qwen-3.8-27b", "Qwen3.8 27B", 131_072),
    ],
  },
  {
    id: "novita",
    group: "intl",
    nameKey: "settings.ai.provider.novita",
    // Novita 的兼容前缀是 /openai（不是 /v1）。
    baseUrl: "https://api.novita.ai/openai",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: [
      model("deepseek/deepseek-v4.1-flash", "DeepSeek V4.1 Flash", 1_048_576),
      model("minimax/minimax-m3", "MiniMax-M3", 1_000_000),
      model("baidu/ernie-4.5-21B-a3b", "ERNIE 4.5 21B A3B", 120_000),
    ],
  },
  {
    id: "huggingface",
    group: "intl",
    nameKey: "settings.ai.provider.huggingface",
    baseUrl: "https://router.huggingface.co/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: [
      model("deepseek-ai/DeepSeek-V4.1-Flash", "DeepSeek V4.1 Flash", 1_048_576),
      model("zai-org/GLM-5.3", "GLM-5.3", 1_048_576),
      model("moonshotai/Kimi-K3", "Kimi K3", 1_000_000),
      model("Qwen/Qwen3-Coder-480B-A35B-Instruct", "Qwen3 Coder 480B", 262_144),
    ],
  },
  {
    id: "nvidia",
    group: "intl",
    nameKey: "settings.ai.provider.nvidia",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: [
      model("z-ai/glm-5.3", "GLM-5.3", 1_000_000),
      model("deepseek-ai/deepseek-v4.1-flash", "DeepSeek V4.1 Flash", 1_000_000),
    ],
  },
  // ─── v0.15.4 服务商覆盖：国内补充厂商 ────────────────────────────
  {
    id: "zai",
    group: "cn",
    nameKey: "settings.ai.provider.zai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: [
      model("glm-5.3", "GLM-5.3", 1_000_000),
      model("glm-5.2", "GLM-5.2", 1_000_000),
      model("glm-5", "GLM-5", 204_800),
    ],
  },
  {
    id: "alibaba-coding-plan",
    group: "cn",
    nameKey: "settings.ai.provider.alibabaCodingPlan",
    baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: [
      model("qwen3-coder-plus", "Qwen3 Coder Plus", 1_000_000),
      model("qwen3.7-plus", "Qwen3.7 Plus", 1_000_000),
      model("glm-4.7", "GLM-4.7", 202_752),
      model("kimi-k2.5", "Kimi K2.5", 262_144),
    ],
  },
  {
    id: "tencent-plan",
    group: "cn",
    nameKey: "settings.ai.provider.tencentPlan",
    baseUrl: "https://api.lkeap.cloud.tencent.com/plan/v3",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: [
      model("hy4-preview", "Hy4 Preview", 1_024_000),
      model("hy3", "Hy3", 256_000),
    ],
  },
  {
    id: "longcat",
    group: "cn",
    nameKey: "settings.ai.provider.longcat",
    baseUrl: "https://api.longcat.chat/openai",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: [
      model("LongCat-2.5-Preview", "LongCat-2.5 Preview", 1_048_576),
      model("LongCat-2.0", "LongCat-2.0", 1_048_576),
    ],
  },
  {
    id: "xiaomi",
    group: "cn",
    nameKey: "settings.ai.provider.xiaomi",
    baseUrl: "https://api.xiaomimimo.com/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: [
      model("mimo-v2.6-pro", "MiMo-V2.6-Pro", 1_048_576),
      model("mimo-v2.6-flash", "MiMo-V2.6-Flash", 1_048_576),
      model("mimo-v2.5-pro", "MiMo-V2.5-Pro", 1_048_576),
    ],
  },
  {
    id: "qiniu",
    group: "cn",
    nameKey: "settings.ai.provider.qiniu",
    baseUrl: "https://api.qnaigc.com/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: [
      model("deepseek-r1", "DeepSeek R1", 128_000),
      model("doubao-seed-2.0-code", "Doubao Seed 2.0 Code", 256_000),
      model("claude-4.5-sonnet", "Claude 4.5 Sonnet", 200_000),
    ],
  },
  {
    id: "ai360",
    group: "cn",
    nameKey: "settings.ai.provider.ai360",
    // 端点公开可探测（未鉴权返回 401 鉴权失败），但无公开模型目录。
    baseUrl: "https://api.360.cn/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: [],
  },
  // ─── v0.15.4 服务商覆盖：本地部署运行时 ──────────────────────────
  // 本机地址由用户自行改端口；模型目录一律留空，交给「获取模型列表」动态探测。
  {
    id: "lmstudio",
    group: "local",
    nameKey: "settings.ai.provider.lmstudio",
    baseUrl: "http://127.0.0.1:1234/v1",
    protocol: "openai-chat",
    authMode: "none",
    temperature: 0.1,
    models: [],
  },
  {
    id: "vllm",
    group: "local",
    nameKey: "settings.ai.provider.vllm",
    baseUrl: "http://127.0.0.1:8000/v1",
    protocol: "openai-chat",
    authMode: "none",
    temperature: 0.1,
    models: [],
  },
  {
    id: "llama-cpp",
    group: "local",
    nameKey: "settings.ai.provider.llamaCpp",
    // 上游 tools/server/README.md：`--port` 的编译期默认值是 9931（Docker 示例惯用 8080）。
    // 这里取上游默认值，同时避免与 LocalAI 的 8080 撞 baseUrl（旧档案按端点反推 Provider 会歧义）。
    baseUrl: "http://127.0.0.1:9931/v1",
    protocol: "openai-chat",
    authMode: "none",
    temperature: 0.1,
    models: [],
  },
  {
    id: "localai",
    group: "local",
    nameKey: "settings.ai.provider.localai",
    baseUrl: "http://127.0.0.1:8080/v1",
    protocol: "openai-chat",
    authMode: "none",
    temperature: 0.1,
    models: [],
  },
  {
    id: "textgen-webui",
    group: "local",
    nameKey: "settings.ai.provider.textgen",
    baseUrl: "http://127.0.0.1:5000/v1",
    protocol: "openai-chat",
    authMode: "none",
    temperature: 0.1,
    models: [],
  },
  {
    id: "jan",
    group: "local",
    nameKey: "settings.ai.provider.jan",
    baseUrl: "http://127.0.0.1:1337/v1",
    protocol: "openai-chat",
    authMode: "none",
    temperature: 0.1,
    models: [],
  },
  {
    id: "xinference",
    group: "local",
    nameKey: "settings.ai.provider.xinference",
    baseUrl: "http://127.0.0.1:9997/v1",
    protocol: "openai-chat",
    authMode: "none",
    temperature: 0.1,
    models: [],
  },
  {
    id: "sglang",
    group: "local",
    nameKey: "settings.ai.provider.sglang",
    baseUrl: "http://127.0.0.1:30000/v1",
    protocol: "openai-chat",
    authMode: "none",
    temperature: 0.1,
    models: [],
  },
]);

export function findAiProviderPreset(id: string): AiProviderPreset | null {
  return AI_PROVIDER_PRESETS.find((preset) => preset.id === id) ?? null;
}

/**
 * 按 AI_PROVIDER_GROUPS 的顺序把预设切成 optgroup 用的分段。
 * 分组清单来自 AI_PROVIDER_GROUPS 本身（不是另写一份 id 表），
 * 所以新增预设只要写对 `group` 字段就会自动落到正确的组里。
 */
export function groupAiProviderPresets(
  presets: readonly AiProviderPreset[] = AI_PROVIDER_PRESETS,
): { group: AiProviderGroup; labelKey: string; presets: AiProviderPreset[] }[] {
  return AI_PROVIDER_GROUPS.map(({ group, labelKey }) => ({
    group,
    labelKey,
    presets: presets.filter((preset) => preset.group === group),
  })).filter((section) => section.presets.length > 0);
}
