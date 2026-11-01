import { describe, expect, it } from "vitest";
import {
  applyModelSelection,
  contextSliderStops,
  createCustomProfileDraft,
  formatTokenCount,
  inferProviderId,
  upsertProviderProfile,
} from "../services/aiModelCatalog";
import { createDefaultAiSettings, validateAiConnectionProfile } from "../services/aiProfiles";
import { findAiProviderPreset } from "../services/aiProviderPresets";

describe("v0.15.3 AI 模型目录", () => {
  it("全新设置默认使用本地 Ollama，且无需 Key", () => {
    const state = createDefaultAiSettings();
    const profile = state.profiles[0]!;
    expect(state.activeProfileId).toBe("ollama");
    expect(profile.providerId).toBe("ollama");
    expect(profile.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(profile.authMode).toBe("none");
  });

  it("切换服务商创建独立凭据槽，再次切换会复用原服务商档案", () => {
    const initial = createDefaultAiSettings();
    const kimi = findAiProviderPreset("kimi-plan")!;
    const next = upsertProviderProfile(initial, kimi, "Kimi Plan");
    expect(next.profile.id).toBe("kimi-plan");
    expect(next.profile.credentialId).toBe("kimi-plan");
    expect(next.profile.protocol).toBe("anthropic-messages");
    expect(next.settings.profiles).toHaveLength(2);

    const back = upsertProviderProfile(next.settings, findAiProviderPreset("ollama")!, "Ollama");
    const kimiAgain = upsertProviderProfile(back.settings, kimi, "Kimi Plan");
    expect(kimiAgain.settings.profiles).toHaveLength(2);
    expect(kimiAgain.profile.id).toBe("kimi-plan");
  });

  it("选择带元数据的模型后，上下文默认到最大档并应用模型级推理档", () => {
    const initial = createDefaultAiSettings();
    const next = upsertProviderProfile(initial, findAiProviderPreset("kimi-plan")!, "Kimi Plan");
    const selected = applyModelSelection({
      ...next.profile,
      modelCatalog: [{ id: "custom", name: "Custom", contextWindowTokens: 1_000_000, reasoningEffort: "high" }],
    }, "custom");
    expect(selected.model).toBe("custom");
    expect(selected.contextWindowTokens).toBe(1_000_000);
    expect(selected.requestPolicy.reasoningEffort).toBe("high");
  });

  it("普通模型为最小/最大两档，1M 模型增加 600K 中档", () => {
    expect(contextSliderStops({ contextWindowTokens: 262_144 })).toEqual([8192, 262_144]);
    expect(contextSliderStops({ contextWindowTokens: 1_000_000 })).toEqual([8192, 600_000, 1_000_000]);
    expect(contextSliderStops({ contextWindowTokens: 1_048_576, minContextWindowTokens: 32_768 }))
      .toEqual([32_768, 600_000, 1_048_576]);
    expect(formatTokenCount(600_000)).toBe("600K");
  });

  it("自定义草稿与三协议通过类型校验，off 不进入请求策略", () => {
    const draft = createCustomProfileDraft();
    expect(draft.providerId).toBe("");
    expect(draft.modelCatalog).toEqual([]);
    const initial = createDefaultAiSettings();
    const profile = applyModelSelection({
      ...initial.profiles[0]!,
      protocol: "openai-responses",
      modelCatalog: [{ id: "m", name: "M", reasoningEffort: "off" }],
    }, "m");
    expect(profile.requestPolicy.reasoningEffort).toBeUndefined();
    expect(validateAiConnectionProfile(profile)).not.toContain("profile.protocol.invalid");
  });

  it("无法识别端点的旧档案归入自定义，不猜 Provider", () => {
    const profile = { ...createDefaultAiSettings().profiles[0]!, providerId: undefined, baseUrl: "https://example.invalid/v1" };
    expect(inferProviderId(profile)).toBe("custom");
  });
});
