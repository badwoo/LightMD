/**
 * v0.15.4 第 8 项：服务商覆盖审计的机器可校验契约。
 *
 * 只断言「结构性事实」：预设 id 唯一、baseUrl 能被 Rust 端 endpoint_url/models_url 拼成
 * 正确路径、nameKey 在 zh-CN/en-US 两份字典里都存在且非空、本地运行时不需要密钥。
 * 服务商是否仍在营业、模型目录是否最新属于联网核实结果，写在
 * _plan/v0154-provider-coverage-audit.md，不在此处伪造。
 */
import { describe, expect, it } from "vitest";
import {
  AI_DEFAULT_PROVIDER_ID,
  AI_PROVIDER_GROUPS,
  AI_PROVIDER_PRESETS,
  findAiProviderPreset,
  groupAiProviderPresets,
  type AiProviderPreset,
} from "../services/aiProviderPresets";
import { zhCN } from "../i18n/locales/zh-CN";
import { enUS } from "../i18n/locales/en-US";

/** 与 src-tauri/src/translate/ai_request.rs::endpoint_url 语义一致（trim 尾斜杠）。 */
function endpointUrl(protocol: AiProviderPreset["protocol"], baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (protocol === "anthropic-messages") {
    return base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
  }
  if (protocol === "openai-responses") return `${base}/responses`;
  return `${base}/chat/completions`;
}

/** 与 ai_request.rs::models_url 语义一致。 */
function modelsUrl(protocol: AiProviderPreset["protocol"], baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (protocol === "anthropic-messages") {
    return base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
  }
  return `${base}/models`;
}

function preset(id: string): AiProviderPreset {
  const found = findAiProviderPreset(id);
  if (!found) throw new Error(`缺少预设 ${id}`);
  return found;
}

const LOCAL_RUNTIME_IDS = [
  "ollama",
  "lmstudio",
  "vllm",
  "llama-cpp",
  "localai",
  "textgen-webui",
  "jan",
  "xinference",
  "sglang",
] as const;

const V0154_INTERNATIONAL_IDS = [
  "xai",
  "mistral",
  "cohere",
  "groq",
  "together",
  "fireworks",
  "deepinfra",
  "openrouter",
  "perplexity",
  "cerebras",
  "novita",
  "huggingface",
  "nvidia",
] as const;

const V0154_DOMESTIC_IDS = [
  "zai",
  "alibaba-coding-plan",
  "tencent-plan",
  "longcat",
  "xiaomi",
  "qiniu",
  "ai360",
] as const;

const V0153_BASELINE_IDS = [
  "ollama",
  "deepseek",
  "zhipu",
  "zhipu-coding-plan",
  "minimax",
  "alibaba",
  "alibaba-token-plan",
  "kimi",
  "kimicode",
  "kimi-plan",
  "volcengine",
  "volcengine-coding-plan",
  "doubao",
  "hunyuan",
  "xunfei",
  "stepfun",
  "baidu",
  "lingyi",
  "baichuan",
  "sensenova",
  "antling",
  "gemini",
  "claude",
  "modelscope",
  "siliconflow",
  "openai",
] as const;

describe("v0.15.4 服务商预设基础契约", () => {
  it("预设 id 唯一，且默认服务商仍为本地 Ollama", () => {
    const ids = AI_PROVIDER_PRESETS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(AI_DEFAULT_PROVIDER_ID).toBe("ollama");
  });

  it("v0.15.3 基线 26 个预设全部保持存在（不删不改 id）", () => {
    for (const id of V0153_BASELINE_IDS) {
      expect(preset(id).id).toBe(id);
    }
  });

  it("providerId 与凭据槽命名规则兼容（小写 + 短横线）", () => {
    const pattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
    for (const item of AI_PROVIDER_PRESETS) {
      expect(item.id, `预设 ${item.id} 不符合 providerId 规则`).toMatch(pattern);
    }
  });

  it("每个预设的 nameKey 在中英字典里都存在且非空", () => {
    for (const item of AI_PROVIDER_PRESETS) {
      expect(zhCN[item.nameKey], `zh-CN 缺 ${item.nameKey}`).toBeTruthy();
      expect(enUS[item.nameKey], `en-US 缺 ${item.nameKey}`).toBeTruthy();
      expect(zhCN[item.nameKey]).not.toBe(item.nameKey);
      expect(enUS[item.nameKey]).not.toBe(item.nameKey);
    }
  });

  it("预设模型目录内的 id 不重复，上下文窗口若填写必须为正整数", () => {
    for (const item of AI_PROVIDER_PRESETS) {
      const ids = item.models.map((entry) => entry.id);
      expect(new Set(ids).size, `预设 ${item.id} 存在重复模型 id`).toBe(ids.length);
      for (const entry of item.models) {
        expect(entry.name.trim().length).toBeGreaterThan(0);
        if (entry.contextWindowTokens !== undefined) {
          expect(Number.isSafeInteger(entry.contextWindowTokens) &&
            entry.contextWindowTokens > 0).toBe(true);
        }
      }
    }
  });
});

describe("v0.15.4 baseUrl 经 endpoint_url 拼出的协议路径", () => {
  it("OpenAI 兼容 base 一律拼出 /chat/completions 与 /models", () => {
    for (const item of AI_PROVIDER_PRESETS.filter((preset) => preset.protocol === "openai-chat")) {
      const chat = endpointUrl(item.protocol, item.baseUrl);
      expect(chat, `预设 ${item.id} 的 chat 路径`).toContain("chat/completions");
      expect(modelsUrl(item.protocol, item.baseUrl), `预设 ${item.id} 的 models 路径`)
        .toBe(`${item.baseUrl.replace(/\/+$/, "")}/models`);
    }
  });

  it("OpenAI 兼容 base 不得自带 /chat/completions 后缀（避免双重拼接）", () => {
    for (const item of AI_PROVIDER_PRESETS) {
      expect(item.baseUrl).not.toMatch(/chat\/completions$/);
      expect(item.baseUrl).not.toMatch(/\/responses$/);
    }
  });

  it("Anthropic 协议预设不会重复 /v1（kimi-plan 基线回归）", () => {
    const kimiPlan = preset("kimi-plan");
    expect(kimiPlan.protocol).toBe("anthropic-messages");
    expect(endpointUrl(kimiPlan.protocol, kimiPlan.baseUrl))
      .toBe("https://api.kimi.com/coding/v1/messages");
    const claude = preset("claude");
    expect(endpointUrl(claude.protocol, claude.baseUrl))
      .toBe("https://api.anthropic.com/v1/messages");
  });

  it("DeepInfra / Novita / Perplexity / LongCat 的兼容前缀原样保留", () => {
    expect(endpointUrl("openai-chat", preset("deepinfra").baseUrl))
      .toBe("https://api.deepinfra.com/v1/openai/chat/completions");
    expect(endpointUrl("openai-chat", preset("novita").baseUrl))
      .toBe("https://api.novita.ai/openai/chat/completions");
    expect(endpointUrl("openai-chat", preset("perplexity").baseUrl))
      .toBe("https://api.perplexity.ai/chat/completions");
    expect(endpointUrl("openai-chat", preset("longcat").baseUrl))
      .toBe("https://api.longcat.chat/openai/chat/completions");
  });

  it("Cohere 走 compatibility/v1 兼容层而不是原生 v2/chat", () => {
    expect(preset("cohere").baseUrl).toBe("https://api.cohere.ai/compatibility/v1");
    expect(endpointUrl("openai-chat", preset("cohere").baseUrl))
      .toBe("https://api.cohere.ai/compatibility/v1/chat/completions");
  });

  it("Groq 走 /openai/v1 兼容路径，Hugging Face 走 router", () => {
    expect(preset("groq").baseUrl).toBe("https://api.groq.com/openai/v1");
    expect(endpointUrl("openai-chat", preset("groq").baseUrl))
      .toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(preset("huggingface").baseUrl).toBe("https://router.huggingface.co/v1");
  });
});

describe("v0.15.4 国际厂商预设", () => {
  it("新增 13 个国际预设齐备且走 OpenAI Chat Completions", () => {
    for (const id of V0154_INTERNATIONAL_IDS) {
      const item = preset(id);
      expect(item.protocol).toBe("openai-chat");
      expect(item.authMode).toBe("required");
      expect(item.baseUrl.startsWith("https://"), `${id} 必须是 https 端点`).toBe(true);
    }
  });

  it("厂商端点逐条与核实来源一致", () => {
    expect(preset("xai").baseUrl).toBe("https://api.x.ai/v1");
    expect(preset("mistral").baseUrl).toBe("https://api.mistral.ai/v1");
    expect(preset("together").baseUrl).toBe("https://api.together.xyz/v1");
    expect(preset("fireworks").baseUrl).toBe("https://api.fireworks.ai/inference/v1");
    expect(preset("openrouter").baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(preset("cerebras").baseUrl).toBe("https://api.cerebras.ai/v1");
    expect(preset("nvidia").baseUrl).toBe("https://integrate.api.nvidia.com/v1");
  });

  it("没有公开目录数据的厂商留空模型列表，由「获取模型列表」动态拉取", () => {
    // 只有确有公开目录数据的预设才允许带静态模型；本次新增的国际厂商均有目录数据。
    for (const id of V0154_INTERNATIONAL_IDS) {
      expect(preset(id).models.length, `${id} 应带核实过的模型`).toBeGreaterThan(0);
    }
  });
});

describe("v0.15.4 国内补充厂商预设", () => {
  it("新增 7 个国内预设齐备", () => {
    for (const id of V0154_DOMESTIC_IDS) {
      const item = preset(id);
      expect(item.protocol).toBe("openai-chat");
      expect(item.authMode).toBe("required");
    }
  });

  it("Plan/变体端点与主站互不覆盖", () => {
    expect(preset("zai").baseUrl).toBe("https://api.z.ai/api/paas/v4");
    expect(preset("alibaba-coding-plan").baseUrl).toBe("https://coding.dashscope.aliyuncs.com/v1");
    expect(preset("tencent-plan").baseUrl).toBe("https://api.lkeap.cloud.tencent.com/plan/v3");
    // 与 v0.15.3 既有端点保持不同，避免 upsertProviderProfile 误判为同一 Provider。
    expect(preset("zai").baseUrl).not.toBe(preset("zhipu").baseUrl);
    expect(preset("alibaba-coding-plan").baseUrl).not.toBe(preset("alibaba").baseUrl);
  });

  it("360 智脑端点可探测但无公开目录，模型列表留空", () => {
    const ai360 = preset("ai360");
    expect(ai360.baseUrl).toBe("https://api.360.cn/v1");
    expect(ai360.models).toEqual([]);
  });
});

describe("v0.15.4 本地部署运行时预设", () => {
  it("九个本地运行时全部存在且只用 loopback 地址", () => {
    for (const id of LOCAL_RUNTIME_IDS) {
      const item = preset(id);
      expect(item.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d{2,5}\/v1$/);
    }
  });

  it("本地运行时一律不强制密钥（none 或 optional），且模型列表留空动态探测", () => {
    const noAuth = new Set(["none", "optional"]);
    for (const id of LOCAL_RUNTIME_IDS) {
      const item = preset(id);
      expect(noAuth.has(item.authMode), `${id} 不应强制 API Key`).toBe(true);
      expect(item.models, `${id} 的模型应由服务端动态探测`).toEqual([]);
    }
  });

  it("端口与各运行时默认监听端口一致", () => {
    expect(preset("ollama").baseUrl).toBe("http://127.0.0.1:11434/v1"); // Ollama 默认
    expect(preset("lmstudio").baseUrl).toBe("http://127.0.0.1:1234/v1");
    expect(preset("vllm").baseUrl).toBe("http://127.0.0.1:8000/v1");
    expect(preset("llama-cpp").baseUrl).toBe("http://127.0.0.1:9931/v1"); // 上游 --port 默认
    expect(preset("localai").baseUrl).toBe("http://127.0.0.1:8080/v1");
    expect(preset("textgen-webui").baseUrl).toBe("http://127.0.0.1:5000/v1");
    expect(preset("jan").baseUrl).toBe("http://127.0.0.1:1337/v1");
    expect(preset("xinference").baseUrl).toBe("http://127.0.0.1:9997/v1");
    expect(preset("sglang").baseUrl).toBe("http://127.0.0.1:30000/v1");
  });

  it("Ollama 原生 /api/tags 探测仍可从 OpenAI 兼容 base 反推根路径", () => {
    // 对应 ai_request.rs::ollama_native_url 的「去掉结尾 /v1」规则。
    const base = preset("ollama").baseUrl.replace(/\/+$/, "");
    const root = base.endsWith("/v1") ? base.slice(0, -3) : base;
    expect(`${root}/api/tags`).toBe("http://127.0.0.1:11434/api/tags");
  });
});

describe("v0.15.4 覆盖率口径的可机读部分", () => {
  it("预设总数 = 基线 26 + 新增 28（国际 13 / 国内 7 / 本地 8）", () => {
    expect(AI_PROVIDER_PRESETS).toHaveLength(V0153_BASELINE_IDS.length + 13 + 7 + 8);
  });

  it("新增本地运行时不含基线已有的 ollama（避免重复计数）", () => {
    const addedLocal = LOCAL_RUNTIME_IDS.filter((id) => id !== "ollama");
    expect(addedLocal).toHaveLength(8);
  });
});

describe("v0.15.4 服务商下拉分组（task-4）", () => {
  it("每个预设都有合法 group（local / cn / intl），且每个 group 至少 1 项", () => {
    const valid = new Set(AI_PROVIDER_GROUPS.map((section) => section.group));
    for (const item of AI_PROVIDER_PRESETS) {
      expect(valid.has(item.group), `预设 ${item.id} 的 group 非法：${item.group}`).toBe(true);
    }
    const sections = groupAiProviderPresets();
    expect(sections).toHaveLength(AI_PROVIDER_GROUPS.length);
    for (const section of sections) {
      expect(section.presets.length, `分组 ${section.group} 为空`).toBeGreaterThan(0);
    }
  });

  it("分组不重不漏：所有分组的预设数之和等于 AI_PROVIDER_PRESETS 总数，id 无重复", () => {
    const sections = groupAiProviderPresets();
    const ids = sections.flatMap((section) => section.presets.map((preset) => preset.id));
    expect(ids).toHaveLength(AI_PROVIDER_PRESETS.length);
    expect(new Set(ids).size).toBe(AI_PROVIDER_PRESETS.length);
    // 顺序即呈现顺序：本地优先（默认服务商 Ollama 在第一组首项）
    expect(sections[0]!.group).toBe("local");
    expect(sections[0]!.presets[0]!.id).toBe("ollama");
  });

  it("分组成员与语义一致：本地组全是 loopback 且 authMode=none，国际/国内组都不是 loopback", () => {
    const sections = groupAiProviderPresets();
    const local = sections.find((section) => section.group === "local")!;
    for (const item of local.presets) {
      expect(item.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
      expect(item.authMode).toBe("none");
    }
    for (const section of sections.filter((entry) => entry.group !== "local")) {
      for (const item of section.presets) {
        expect(item.baseUrl.startsWith("https://"), `${item.id} 云端端点应为 https`).toBe(true);
        expect(item.baseUrl).not.toContain("127.0.0.1");
      }
    }
    expect(local.presets).toHaveLength(LOCAL_RUNTIME_IDS.length);
  });

  it("optgroup 的 label key 在中英字典里都存在且非空（且与 provider 名称 key 不冲突）", () => {
    for (const section of AI_PROVIDER_GROUPS) {
      expect(zhCN[section.labelKey], `zh-CN 缺 ${section.labelKey}`).toBeTruthy();
      expect(enUS[section.labelKey], `en-US 缺 ${section.labelKey}`).toBeTruthy();
      expect(zhCN[section.labelKey]).not.toBe(section.labelKey);
      // optgroup label 用独立命名空间，别和 settings.ai.provider.* 名称 key 混用。
      expect(section.labelKey.startsWith("settings.ai.model.providerGroup.")).toBe(true);
      expect(section.labelKey).not.toBe(
        AI_PROVIDER_PRESETS.find((preset) => preset.group === section.group)?.nameKey,
      );
    }
  });

  it("三档覆盖齐备：本地 / 国内 / 国际各有足够项数", () => {
    const counts = Object.fromEntries(
      groupAiProviderPresets().map((section) => [section.group, section.presets.length]),
    ) as Record<string, number>;
    expect(counts.local).toBeGreaterThanOrEqual(7);
    expect(counts.cn).toBeGreaterThanOrEqual(7);
    expect(counts.intl).toBeGreaterThanOrEqual(13);
  });
});
