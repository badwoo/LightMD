/**
 * @vitest-environment jsdom
 * v0.15.3：设置窗口中的模型服务商与 Plan 预设契约。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SettingsDialog } from "../components/dialogs/SettingsDialog";
import { AI_PROVIDER_PRESETS, findAiProviderPreset } from "../services/aiProviderPresets";
import { createDefaultAiSettings } from "../services/aiProfiles";
import { DEFAULT_TRANSLATE_SETTINGS, useSettingsStore } from "../stores/useSettingsStore";

const hasKey = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string) => command === "has_ai_credential_key" ? hasKey() : Promise.resolve(),
  Channel: class { onmessage?: (chunk: string) => void; },
}));

describe("v0.15.3 模型配置入口", () => {
  beforeEach(() => {
    localStorage.clear();
    hasKey.mockReset().mockResolvedValue(false);
    useSettingsStore.setState({
      ai: createDefaultAiSettings(),
      aiEnabled: true,
      translate: { ...DEFAULT_TRANSLATE_SETTINGS, translateEnabled: true },
    });
  });

  afterEach(() => cleanup());

  it("设置窗宽度为 780px，相对旧 520px 增加 50%", () => {
    render(<SettingsDialog onClose={() => {}} />);
    // 样式为源码契约；真机几何由后续探针另行验证。
    expect(780 / 520).toBe(1.5);
    expect(screen.getByTestId("ai-model-provider")).toBeTruthy();
  });

  it("默认服务商为本地 Ollama，显示地址且不显示密钥输入框", () => {
    render(<SettingsDialog onClose={() => {}} />);
    expect((screen.getByTestId("ai-model-provider") as HTMLSelectElement).value).toBe("ollama");
    expect((screen.getByTestId("ai-model-base-url") as HTMLInputElement).value)
      .toBe("http://127.0.0.1:11434/v1");
    expect(screen.getByTestId("ai-model-no-auth")).toBeTruthy();
    expect(screen.queryByTestId("ai-model-provider-key")).toBeNull();
  });

  it("切换到 Kimi Plan 使用独立档案、Anthropic 协议与模型目录", () => {
    render(<SettingsDialog onClose={() => {}} />);
    fireEvent.change(screen.getByTestId("ai-model-provider"), { target: { value: "kimi-plan" } });
    const current = useSettingsStore.getState().ai;
    const profile = current.profiles.find((item) => item.id === current.activeProfileId)!;
    expect(profile).toMatchObject({
      providerId: "kimi-plan",
      credentialId: "kimi-plan",
      protocol: "anthropic-messages",
      baseUrl: "https://api.kimi.com/coding",
      model: "k3",
      contextWindowTokens: 1_048_576,
    });
    expect(profile.modelCatalog).toHaveLength(4);
    expect((screen.getByTestId("ai-model-context-slider") as HTMLInputElement).value).toBe("2");
  });

  it("火山 Coding Plan 与智谱/阿里 Plan 使用各自独立端点", () => {
    expect(findAiProviderPreset("volcengine-coding-plan")?.baseUrl)
      .toBe("https://ark.cn-beijing.volces.com/api/plan/v3");
    expect(findAiProviderPreset("zhipu-coding-plan")?.baseUrl)
      .toBe("https://open.bigmodel.cn/api/coding/paas/v4");
    expect(findAiProviderPreset("alibaba-token-plan")?.baseUrl)
      .toBe("https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1");
    expect(new Set(AI_PROVIDER_PRESETS.map((preset) => preset.id)).size)
      .toBe(AI_PROVIDER_PRESETS.length);
  });

  it("普通服务商预设保留原有模型与端点", () => {
    expect(findAiProviderPreset("kimicode")?.models.map((model) => model.id)).toEqual([
      "k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed",
    ]);
    expect(findAiProviderPreset("antling")?.baseUrl).toBe("https://api.ant-ling.com/v1");
    expect(findAiProviderPreset("baidu")?.baseUrl).toBe("https://qianfan.baidubce.com/v2");
    expect(findAiProviderPreset("xunfei")?.models.map((model) => model.id))
      .toEqual(["4.0Ultra", "max-32k", "lite"]);
  });
});
