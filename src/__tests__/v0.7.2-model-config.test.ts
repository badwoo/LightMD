/**
 * v0.7.2：模型配置 service 层测试
 *
 * 覆盖：
 * 1. translateService.listModels：透传 provider/baseUrl / 错误包装 / 非 Tauri
 * 2. aiAssistService.run：invoke 携带 provider（v0.7.2 P1 Key 按厂商独立读取）
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

// ─── mocks（必须在 import 服务之前） ───────────────────────
const { mockInvoke, mockIsTauri } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockIsTauri: vi.fn(),
}));

const { MockChannel } = vi.hoisted(() => {
  class MockChannel {
    static last: MockChannel | null = null;
    onmessage: ((msg: string) => void) | undefined;
    constructor() {
      MockChannel.last = this;
    }
  }
  return { MockChannel };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
  Channel: MockChannel,
}));
vi.mock("../services/fileService", () => ({
  isTauri: mockIsTauri,
}));

import { translateService, TranslateServiceError } from "../services/translateService";
import { aiAssistService } from "../services/aiAssistService";
import { useSettingsStore } from "../stores/useSettingsStore";

describe("v0.7.2 translateService.listModels", () => {
  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockReset();
    mockIsTauri.mockReset();
    mockIsTauri.mockReturnValue(true);
  });

  it("透传 provider/baseUrl 到 list_translate_models", async () => {
    mockInvoke.mockResolvedValue(["deepseek-v4-flash", "deepseek-v4-pro"]);
    await expect(
      translateService.listModels("deepseek", "https://api.deepseek.com/v1")
    ).resolves.toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
    expect(mockInvoke).toHaveBeenCalledWith("list_translate_models", {
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
    });
  });

  it("端点不支持（PROVIDER 错误）时包装为 TranslateServiceError", async () => {
    mockInvoke.mockRejectedValue("PROVIDER|404|not found");
    await expect(
      translateService.listModels("claude", "https://api.anthropic.com/v1")
    ).rejects.toBeInstanceOf(TranslateServiceError);
    await expect(
      translateService.listModels("claude", "https://api.anthropic.com/v1")
    ).rejects.toMatchObject({ info: { code: "PROVIDER", detail: "404: not found" } });
  });

  it("Key 未配置（NO_KEY）时包装为 TranslateServiceError", async () => {
    mockInvoke.mockRejectedValue("NO_KEY|未设置 API Key");
    await expect(
      translateService.listModels("kimi", "https://api.moonshot.cn/v1")
    ).rejects.toMatchObject({ info: { code: "NO_KEY" } });
  });

  it("非 Tauri 环境抛 NETWORK（不发 invoke）", async () => {
    mockIsTauri.mockReturnValue(false);
    await expect(
      translateService.listModels("kimi", "https://api.moonshot.cn/v1")
    ).rejects.toMatchObject({ info: { code: "NETWORK", detail: "non-tauri" } });
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe("v0.7.2 aiAssistService provider 透传", () => {
  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockReset();
    mockIsTauri.mockReset();
    mockIsTauri.mockReturnValue(true);
    MockChannel.last = null;
    useSettingsStore.getState().setTranslateConfig({
      translateProviderPreset: "kimi",
      translateBaseUrl: "https://api.moonshot.cn/v1",
      translateModel: "kimi-k3",
    });
  });

  it("ai_assist_text invoke 携带 provider（Key 按厂商独立读取）", async () => {
    mockInvoke.mockResolvedValue({
      translated: "续写内容",
      placeholdersIntact: true,
      finishReason: "stop",
      promptTokens: 1,
      completionTokens: 1,
    });
    await aiAssistService.run("continue", "上文内容", () => {});
    const call = mockInvoke.mock.calls.find(([cmd]) => cmd === "ai_assist_text");
    expect(call).toBeTruthy();
    expect(call![1]).toMatchObject({
      task: "continue",
      text: "上文内容",
      provider: "kimi",
      baseUrl: "https://api.moonshot.cn/v1",
      model: "kimi-k3",
    });
  });
});
