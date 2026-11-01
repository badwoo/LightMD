import type { AiConnectionProfile, AiModelCatalogEntry, ApiProtocol } from "./aiProfiles";

/** 左侧「服务商」页签的内置连接预设；自定义 Provider 不在此处出现。 */
export interface AiProviderPreset {
  id: string;
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
    nameKey: "settings.ai.provider.ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    protocol: "openai-chat",
    authMode: "none",
    temperature: 0.1,
    models: [],
  },
  {
    id: "deepseek",
    nameKey: "settings.translate.provider.deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: models(["deepseek-v4-flash", "deepseek-v4-pro"]),
  },
  {
    id: "zhipu",
    nameKey: "settings.translate.provider.zhipu",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: models(["glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5.1", "glm-5", "glm-4.7", "glm-4.7-flash"]),
  },
  {
    id: "zhipu-coding-plan",
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
    nameKey: "settings.translate.provider.minimax",
    baseUrl: "https://api.minimax.cn/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: models(["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5"]),
  },
  {
    id: "alibaba",
    nameKey: "settings.translate.provider.alibaba",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: models(["qwen3.8-max", "qwen3.8-flash", "qwen3.7-plus", "qwen3.7-flash", "qwen-plus", "qwen-flash"]),
  },
  {
    id: "alibaba-token-plan",
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
    nameKey: "settings.translate.provider.kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 1,
    models: models(["kimi-k3", "kimi-k2.6", "kimi-k2.7-code", "kimi-k2.7-code-highspeed"]),
  },
  {
    id: "kimicode",
    nameKey: "settings.translate.provider.kimicode",
    baseUrl: "https://api.kimi.com/coding/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 1,
    models: models(["k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed"]),
  },
  {
    id: "kimi-plan",
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
    nameKey: "settings.translate.provider.volcengine",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: models(["doubao-seed-2-1-pro-260628", "doubao-seed-2-1-turbo-260628", "doubao-seed-2-0-lite-260428", "doubao-seed-2-0-mini-260428"]),
  },
  {
    id: "volcengine-coding-plan",
    nameKey: "settings.ai.provider.volcenginePlan",
    baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: [],
  },
  {
    id: "doubao",
    nameKey: "settings.translate.provider.doubao",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: models(["doubao-seed-evolving", "doubao-seed-2-1-pro-260628", "doubao-seed-2-1-turbo-260628"]),
  },
  {
    id: "hunyuan",
    nameKey: "settings.translate.provider.hunyuan",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: models(["hunyuan-turbos-latest", "hunyuan-turbo", "hunyuan-lite"]),
  },
  {
    id: "xunfei",
    nameKey: "settings.translate.provider.xunfei",
    baseUrl: "https://spark-api-open.xf-yun.com/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: models(["4.0Ultra", "max-32k", "lite"]),
  },
  {
    id: "stepfun",
    nameKey: "settings.translate.provider.stepfun",
    baseUrl: "https://api.stepfun.com/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: models(["step-3.7-flash", "step-3.5-flash"]),
  },
  {
    id: "baidu",
    nameKey: "settings.translate.provider.baidu",
    baseUrl: "https://qianfan.baidubce.com/v2",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: models(["ernie-5.0", "ernie-4.5-turbo-128k", "ernie-4.5-turbo-32k"]),
  },
  {
    id: "lingyi",
    nameKey: "settings.translate.provider.lingyi",
    baseUrl: "https://api.lingyiwanwu.com/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: models(["yi-lightning", "yi-large"]),
  },
  {
    id: "baichuan",
    nameKey: "settings.translate.provider.baichuan",
    baseUrl: "https://api.baichuan-ai.com/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: models(["Baichuan4-Turbo", "Baichuan4-Air", "Baichuan4"]),
  },
  {
    id: "sensenova",
    nameKey: "settings.translate.provider.sensenova",
    baseUrl: "https://api.sensenova.cn/compatible-mode/v2",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: models(["SenseChat-5", "SenseChat-Turbo"]),
  },
  {
    id: "antling",
    nameKey: "settings.translate.provider.antling",
    baseUrl: "https://api.ant-ling.com/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: models(["Ling-3.0-flash", "Ling-2.6-1T", "Ling-2.6-flash", "Ring-2.6-1T"]),
  },
  {
    id: "gemini",
    nameKey: "settings.translate.provider.gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: models(["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3-pro", "gemini-2.5-flash", "gemini-2.5-pro"]),
  },
  {
    id: "claude",
    nameKey: "settings.translate.provider.claude",
    baseUrl: "https://api.anthropic.com",
    protocol: "anthropic-messages",
    authMode: "required",
    temperature: 0.1,
    models: models(["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-7"]),
  },
  {
    id: "modelscope",
    nameKey: "settings.translate.provider.modelscope",
    baseUrl: "https://api-inference.modelscope.cn/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: models(["Qwen/Qwen3-235B-A22B", "deepseek-ai/DeepSeek-V3.1"]),
  },
  {
    id: "siliconflow",
    nameKey: "settings.translate.provider.siliconflow",
    baseUrl: "https://api.siliconflow.cn/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: models(["deepseek-ai/DeepSeek-V4-Flash", "moonshotai/Kimi-K2.6", "Qwen/Qwen3.6-35B-A3B"]),
  },
  {
    id: "openai",
    nameKey: "settings.translate.provider.openai",
    baseUrl: "https://api.openai.com/v1",
    protocol: "openai-chat",
    authMode: "required",
    temperature: 0.1,
    models: models(["gpt-5.2", "gpt-5-mini", "gpt-5.1", "gpt-4.1-mini"]),
  },
]);

export function findAiProviderPreset(id: string): AiProviderPreset | null {
  return AI_PROVIDER_PRESETS.find((preset) => preset.id === id) ?? null;
}
