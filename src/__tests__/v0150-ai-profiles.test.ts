// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  createAiProfileFromLegacy,
  createAiSettingsFromLegacy,
  isAiTokenBudgetValid,
  migrateAiSettings,
  resolveAiConnection,
  validateAiConnectionProfile,
  type AiConnectionProfile,
  type AiSettings,
  type LegacySettingsWithAi,
} from "../services/aiProfiles";

function legacySettings(): LegacySettingsWithAi {
  return {
    translate: {
      translateProviderPreset: "custom",
      translateBaseUrl: "https://legacy.example/v1",
      translateModel: "user-configured-model",
      translateTemperature: 0.4,
    },
  };
}

function profile(patch: Partial<AiConnectionProfile> = {}): AiConnectionProfile {
  return { ...createAiProfileFromLegacy(legacySettings().translate, "profile-a"), ...patch };
}

describe("v0.15.0 AI profile migration", () => {
  it("首次从旧 translate 复制连接，使用保守默认值且不推断模型能力", () => {
    const ai = migrateAiSettings(legacySettings(), "profile-a");
    expect(ai).toEqual({
      profiles: [profile()],
      activeProfileId: "profile-a",
      instructions: [],
    });
    expect(ai.profiles[0]).toMatchObject({
      protocol: "openai-chat",
      authMode: "required",
      credentialId: "profile-a",
      contextWindowTokens: 32768,
      maxOutputTokens: 4096,
      requestPolicy: { tokenField: "max_tokens", temperature: 0.4, includeStreamUsage: true },
    });
  });

  it("已有 ai 时不覆盖，包括用户清空 profiles 的选择；重复迁移保持同一引用", () => {
    const existing: AiSettings = { profiles: [], activeProfileId: "", instructions: [] };
    const persisted = { ...legacySettings(), ai: existing };
    expect(migrateAiSettings(persisted, "new-id")).toBe(existing);
    // 幂等：对**同一个** persisted 再迁一次，仍返回同一引用、不会重新生成 profile。
    // ⚠️ 不要拿上一次的返回值再喂回 migrateAiSettings——返回值是 AiSettings（没有
    // `.ai` 字段），会被当成"旧版本无 ai"而重新从 translate 复制，那是误用而非缺陷。
    expect(migrateAiSettings(persisted, "another-id")).toBe(existing);
  });

  it("迁移后 AI 与 translate 数据解耦，互相修改不联动", () => {
    const persisted = legacySettings();
    const ai = migrateAiSettings(persisted, "profile-a");
    persisted.translate!.translateModel = "translation-only-model";
    expect(ai.profiles[0].model).toBe("user-configured-model");
    ai.profiles[0].baseUrl = "https://ai-only.example/v1";
    expect(persisted.translate!.translateBaseUrl).toBe("https://legacy.example/v1");
  });

  it("空字段安全转换，非法温度不进入请求策略", () => {
    const ai = createAiSettingsFromLegacy({
      translateProviderPreset: null,
      translateBaseUrl: 42,
      translateModel: "  ",
      translateTemperature: Number.NaN,
    }, "profile-a");
    expect(ai.profiles[0].name).toBe("AI connection");
    expect(ai.profiles[0].baseUrl).toBe("");
    expect(ai.profiles[0].model).toBe("");
    expect(ai.profiles[0].requestPolicy.temperature).toBeUndefined();
    expect(validateAiConnectionProfile(ai.profiles[0])).toEqual([
      "profile.baseUrl.required",
      "profile.model.required",
    ]);
  });

  it("配置与序列化结果只允许 credentialId，不包含 API Key", () => {
    // v0.15.0：API Key 绝不允许进入持久化设置——即便旧对象里带着它（历史脏数据 /
    // 未来某次错误的迁移），迁移结果也**不得**把它复制过来。这里用一个额外键
    // 模拟「旧对象被污染」的真实场景，而不是修改 LegacyAiConnectionSettings 类型
    // （类型定义正确：它本来就不接受 apiKey 字段）。
    const pollutedLegacy = {
      ...legacySettings().translate,
      apiKey: "must-not-be-copied",
    } as LegacySettingsWithAi["translate"];
    const ai = createAiSettingsFromLegacy(pollutedLegacy, "profile-a");
    const serialized = JSON.stringify(ai);
    expect(serialized).not.toContain("must-not-be-copied");
    expect(serialized).not.toContain("apiKey");
    expect(ai.profiles[0].credentialId).toBe("profile-a");
  });
});

describe("v0.15.0 AI profile resolution and validation", () => {
  it("仅解析 activeProfileId；失效 ID 不静默切换", () => {
    const settings = createAiSettingsFromLegacy(legacySettings().translate, "profile-a");
    expect(resolveAiConnection(settings)).toBe(settings.profiles[0]);
    expect(resolveAiConnection({ ...settings, activeProfileId: "missing" })).toBeNull();
    expect(resolveAiConnection({ ...settings, profiles: null as never })).toBeNull();
  });

  it("要求 1 <= maxOutputTokens < contextWindowTokens，且均为安全正整数", () => {
    expect(isAiTokenBudgetValid({ contextWindowTokens: 32768, maxOutputTokens: 4096 })).toBe(true);
    for (const budget of [
      { contextWindowTokens: 0, maxOutputTokens: 1 },
      { contextWindowTokens: 4096, maxOutputTokens: 4096 },
      { contextWindowTokens: 4096, maxOutputTokens: 0 },
      { contextWindowTokens: 4096.5, maxOutputTokens: 100 },
      { contextWindowTokens: Number.POSITIVE_INFINITY, maxOutputTokens: 100 },
    ]) {
      expect(isAiTokenBudgetValid(budget)).toBe(false);
    }
  });

  it("校验 credential 与 profile 绑定及非法请求参数", () => {
    const invalid = profile({
      credentialId: "another-profile",
      contextWindowTokens: 100,
      maxOutputTokens: 100,
      requestPolicy: { tokenField: "bad" as never, temperature: 3, includeStreamUsage: true },
    });
    expect(validateAiConnectionProfile(invalid)).toEqual([
      "profile.credentialId.mismatch",
      "profile.maxOutputTokens.invalid",
      "profile.requestPolicy.invalid",
      "profile.temperature.invalid",
    ]);
    expect(validateAiConnectionProfile(profile())).toEqual([]);
  });
});
