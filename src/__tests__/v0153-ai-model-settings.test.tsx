// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiModelSettings } from "../components/settings/AiModelSettings";
import {
  createMemoryCredentialStore,
  type AiCredentialStore,
} from "../components/settings/aiCredentialStore";
import { aiConnectionService } from "../services/aiConnectionService";
import {
  createCustomProfileDraft,
  upsertProviderProfile,
} from "../services/aiModelCatalog";
import { findAiProviderPreset } from "../services/aiProviderPresets";
import type { AiConnectionProfile, AiSettings } from "../services/aiProfiles";
import { useSettingsStore } from "../stores/useSettingsStore";

vi.mock("../i18n", () => ({
  useT: () => (key: string) => key,
}));

vi.mock("../services/aiConnectionService", () => ({
  aiConnectionService: {
    listModels: vi.fn(),
    testConnection: vi.fn(),
  },
}));

const listModelsMock = vi.mocked(aiConnectionService.listModels);
const testConnectionMock = vi.mocked(aiConnectionService.testConnection);

function emptySettings(): AiSettings {
  return { profiles: [], activeProfileId: "", instructions: [] };
}

function setAi(profiles: AiConnectionProfile[], activeProfileId?: string): AiSettings {
  const ai: AiSettings = {
    profiles,
    activeProfileId: activeProfileId ?? profiles[0]?.id ?? "",
    instructions: [],
  };
  useSettingsStore.setState({ ai });
  return ai;
}

function currentAi(): AiSettings {
  return useSettingsStore.getState().ai;
}

function activeProfile(): AiConnectionProfile {
  const ai = currentAi();
  const profile = ai.profiles.find((item) => item.id === ai.activeProfileId);
  if (!profile) throw new Error("测试缺少 activeProfile");
  return profile;
}

function presetProfile(providerId: string): AiConnectionProfile {
  const preset = findAiProviderPreset(providerId);
  if (!preset) throw new Error(`测试缺少预设 ${providerId}`);
  return upsertProviderProfile(emptySettings(), preset, providerId).profile;
}

function mount(credentialStore?: AiCredentialStore) {
  const store = credentialStore ?? createMemoryCredentialStore();
  return {
    store,
    ...render(<AiModelSettings credentialStore={store} />),
  };
}

function openCustomTab() {
  fireEvent.click(screen.getByRole("tab", { name: "settings.ai.model.tabs.custom" }));
}

/** v0.15.6：自定义表单只在展开条目体内渲染；展开「新建」草稿条目。 */
function openNewCustomDraft() {
  fireEvent.click(screen.getByTestId("ai-model-custom-new"));
}

/** v0.15.6：从「添加服务商」下拉新增一条预设档案（会自动展开）。 */
function addProvider(presetId: string) {
  fireEvent.change(screen.getByTestId("ai-model-provider-add-select"), { target: { value: presetId } });
}

function fillRequiredCustomFields(providerId = "acme-api") {
  fireEvent.change(screen.getByTestId("ai-model-custom-provider-id"), {
    target: { value: providerId },
  });
  fireEvent.change(screen.getByTestId("ai-model-custom-name"), {
    target: { value: "Acme API" },
  });
  fireEvent.change(screen.getByTestId("ai-model-custom-base-url"), {
    target: { value: "https://api.acme.test/v1" },
  });
  fireEvent.click(screen.getByTestId("ai-model-custom-add-model"));
  fireEvent.change(screen.getByTestId("ai-model-custom-model-id-0"), {
    target: { value: "model-a" },
  });
  fireEvent.change(screen.getByTestId("ai-model-custom-model-name-0"), {
    target: { value: "Model A" },
  });
  fireEvent.click(screen.getByTestId("ai-model-custom-select-0"));
}

beforeEach(() => {
  cleanup();
  listModelsMock.mockReset();
  testConnectionMock.mockReset();
  setAi([]);
});

afterEach(() => {
  cleanup();
});

describe("v0.15.3 模型配置双页签", () => {
  it("空配置默认创建 Ollama，页签支持 aria 状态与方向键切换", async () => {
    mount();

    await waitFor(() => expect(currentAi().activeProfileId).toBe("ollama"));
    // v0.15.6：服务商页签是条目列表；默认 Ollama 条目已启用并自动展开。
    expect(screen.getByTestId("ai-model-provider-item-ollama")).not.toBeNull();
    expect(screen.getByTestId("ai-model-provider-item-toggle-ollama").getAttribute("aria-pressed"))
      .toBe("true");
    expect(screen.getByTestId("ai-model-no-auth")).not.toBeNull();
    expect(screen.queryByTestId("ai-model-provider-key")).toBeNull();

    const providerTab = screen.getByRole("tab", { name: "settings.ai.model.tabs.provider" });
    const customTab = screen.getByRole("tab", { name: "settings.ai.model.tabs.custom" });
    expect(providerTab.getAttribute("aria-selected")).toBe("true");
    expect(customTab.getAttribute("aria-selected")).toBe("false");

    fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowRight" });
    expect(customTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: "settings.ai.model.tabs.custom" })).not.toBeNull();

    fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowLeft" });
    expect(providerTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("ai-model-provider-panel")).not.toBeNull();
  });

  it("添加服务商建立独立档案；切回原条目后仍保留已编辑端点", () => {
    setAi([presetProfile("ollama")]);
    mount();

    // v0.15.6：从「添加服务商」下拉新增 → 条目 +1、自动展开，但**不**自动启用。
    addProvider("deepseek");
    expect(currentAi().profiles).toHaveLength(2);
    expect(currentAi().activeProfileId).toBe("ollama");
    expect(screen.getByTestId("ai-model-provider-body-deepseek")).not.toBeNull();

    fireEvent.change(screen.getByTestId("ai-model-base-url"), {
      target: { value: "https://proxy.example.test/v1" },
    });
    // 编辑落在**展开的那条**（deepseek），不是启用的 ollama
    expect(currentAi().profiles.find((profile) => profile.id === "deepseek")!.baseUrl)
      .toBe("https://proxy.example.test/v1");

    // 收起 deepseek → 展开 ollama（各条目各自独立保存）
    fireEvent.click(screen.getByTestId("ai-model-provider-item-select-deepseek"));
    fireEvent.click(screen.getByTestId("ai-model-provider-item-select-ollama"));
    fireEvent.click(screen.getByTestId("ai-model-provider-item-select-deepseek"));
    expect((screen.getByTestId("ai-model-base-url") as HTMLInputElement).value)
      .toBe("https://proxy.example.test/v1");
    expect(currentAi().profiles).toHaveLength(2);
  });

  it("编辑 API 地址、模型名称和采样温度后写入**展开的条目**", () => {
    setAi([presetProfile("deepseek")]);
    mount();

    fireEvent.change(screen.getByTestId("ai-model-base-url"), {
      target: { value: "https://api.deepseek.test/v1" },
    });
    fireEvent.change(screen.getByTestId("ai-model-name"), {
      target: { value: "deepseek-v4-pro" },
    });
    fireEvent.change(screen.getByTestId("ai-model-temperature"), {
      target: { value: "0.7" },
    });

    expect(activeProfile().baseUrl).toBe("https://api.deepseek.test/v1");
    expect(activeProfile().model).toBe("deepseek-v4-pro");
    expect(activeProfile().requestPolicy.temperature).toBe(0.7);
    expect(screen.queryByTestId("ai-model-context")).toBeNull();
  });

  it("获取模型后默认最大上下文档，1M 档包含 600K 中间档", async () => {
    setAi([presetProfile("deepseek")]);
    listModelsMock.mockResolvedValue([
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        contextWindowTokens: 1_000_000,
      },
      { id: "deepseek-reasoner", name: "DeepSeek Reasoner" },
    ]);
    mount();

    fireEvent.click(screen.getByTestId("ai-model-fetch"));
    await waitFor(() => expect(listModelsMock).toHaveBeenCalledTimes(1));
    await screen.findByTestId("ai-model-context");

    const slider = screen.getByTestId("ai-model-context-slider");
    expect(slider.getAttribute("max")).toBe("2");
    expect(slider).toHaveProperty("value", "2");
    expect(activeProfile().contextWindowTokens).toBe(1_000_000);
    expect(screen.getByText("600K")).not.toBeNull();

    fireEvent.change(slider, { target: { value: "1" } });
    expect(activeProfile().contextWindowTokens).toBe(600_000);

    fireEvent.change(screen.getByTestId("ai-model-name"), {
      target: { value: "deepseek-reasoner" },
    });
    expect(screen.queryByTestId("ai-model-context")).toBeNull();
  });

  it("测试连接展示成功/失败，模型获取失败不会清空现有目录", async () => {
    setAi([presetProfile("deepseek")]);
    testConnectionMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("offline"));
    listModelsMock.mockRejectedValue(new Error("offline"));
    mount();
    const originalCatalog = activeProfile().modelCatalog;

    fireEvent.click(screen.getByTestId("ai-model-test"));
    await screen.findByText("settings.ai.model.status.testSuccess");
    expect(testConnectionMock).toHaveBeenCalledWith(expect.objectContaining({ id: "deepseek" }));

    fireEvent.click(screen.getByTestId("ai-model-test"));
    await screen.findByText("settings.ai.model.status.testError");

    fireEvent.click(screen.getByTestId("ai-model-fetch"));
    await screen.findByText("settings.ai.model.status.fetchError");
    expect(activeProfile().modelCatalog).toEqual(originalCatalog);
  });

  it("API Key 只写凭据库，已有密钥不回显，保存后立即清空输入", async () => {
    setAi([presetProfile("deepseek")]);
    const credentials = createMemoryCredentialStore({ deepseek: "server-secret" });
    mount(credentials);

    await screen.findByText("settings.ai.model.field.keyConfigured");
    const input = screen.getByTestId("ai-model-provider-key");
    expect(input).toHaveProperty("value", "");
    expect(input.getAttribute("type")).toBe("password");

    fireEvent.change(input, { target: { value: "new-secret" } });
    fireEvent.click(screen.getByTestId("ai-model-provider-key-save"));
    await waitFor(() => expect(credentials.stored.get("deepseek")).toBe("new-secret"));
    expect(input).toHaveProperty("value", "");
    expect(JSON.stringify(currentAi())).not.toContain("new-secret");
    expect(JSON.stringify(currentAi())).not.toContain("server-secret");

    fireEvent.click(screen.getByTestId("ai-model-provider-key-clear"));
    await waitFor(() => expect(credentials.stored.has("deepseek")).toBe(false));
  });

  it("Ollama 不探测凭据，也不显示 Key 输入", () => {
    setAi([presetProfile("ollama")]);
    const credentials = createMemoryCredentialStore();
    const hasSpy = vi.spyOn(credentials, "has");
    mount(credentials);

    expect(screen.getByTestId("ai-model-no-auth")).not.toBeNull();
    expect(screen.queryByTestId("ai-model-provider-key")).toBeNull();
    expect(hasSpy).not.toHaveBeenCalled();
  });

  it("自定义 Provider 校验 ID，保存三协议/六档目录与密钥并启用", async () => {
    setAi([presetProfile("ollama")]);
    const credentials = createMemoryCredentialStore();
    mount(credentials);
    openCustomTab();
    openNewCustomDraft();

    fillRequiredCustomFields("Bad_ID");
    fireEvent.change(screen.getByTestId("ai-model-custom-protocol"), {
      target: { value: "openai-responses" },
    });
    fireEvent.change(screen.getByTestId("ai-model-custom-model-context-0"), {
      target: { value: "1000000" },
    });
    fireEvent.change(screen.getByTestId("ai-model-custom-model-reasoning-0"), {
      target: { value: "max" },
    });
    fireEvent.change(screen.getByTestId("ai-model-custom-key"), {
      target: { value: "custom-secret" },
    });
    fireEvent.click(screen.getByTestId("ai-model-custom-save"));

    await screen.findByText("settings.ai.model.error.providerId");
    expect(currentAi().profiles).toHaveLength(1);
    expect(credentials.stored.size).toBe(0);

    fireEvent.change(screen.getByTestId("ai-model-custom-provider-id"), {
      target: { value: "acme-api" },
    });
    fireEvent.click(screen.getByTestId("ai-model-custom-save"));

    await waitFor(() => expect(currentAi().activeProfileId).toBe("acme-api"));
    const profile = activeProfile();
    expect(profile.id).toBe("acme-api");
    expect(profile.providerId).toBe("acme-api");
    expect(profile.credentialId).toBe("acme-api");
    expect(profile.protocol).toBe("openai-responses");
    expect(profile.model).toBe("model-a");
    expect(profile.contextWindowTokens).toBe(1_000_000);
    expect(profile.modelCatalog?.[0]?.reasoningEffort).toBe("max");
    expect(profile.requestPolicy.reasoningEffort).toBe("max");
    expect(credentials.stored.get("acme-api")).toBe("custom-secret");
    expect(screen.getByTestId("ai-model-custom-key")).toHaveProperty("value", "");
    expect(screen.getByTestId("ai-model-custom-provider-id")).toHaveProperty("readOnly", true);
    expect(JSON.stringify(currentAi())).not.toContain("custom-secret");
  });

  it("已创建 Provider ID 只读，支持增删模型并切换当前模型", async () => {
    const draft = createCustomProfileDraft();
    const custom: AiConnectionProfile = {
      ...draft,
      id: "acme",
      providerId: "acme",
      credentialId: "acme",
      name: "Acme",
      baseUrl: "https://api.acme.test/v1",
      model: "model-a",
      modelCatalog: [
        { id: "model-a", name: "Model A", contextWindowTokens: 32_768 },
      ],
    };
    setAi([custom]);
    mount();
    openCustomTab();

    // v0.15.5：自定义配置改为条目列表（下拉已移除）；该档案既是列表条目、也载入编辑区。
    expect(screen.getByTestId("ai-model-custom-item-acme")).not.toBeNull();
    expect(screen.getByTestId("ai-model-custom-item-select-acme").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("ai-model-custom-provider-id")).toHaveProperty("readOnly", true);

    fireEvent.change(screen.getByTestId("ai-model-custom-name"), {
      target: { value: "Acme Updated" },
    });
    fireEvent.click(screen.getByTestId("ai-model-custom-add-model"));
    fireEvent.change(screen.getByTestId("ai-model-custom-model-id-1"), {
      target: { value: "model-b" },
    });
    fireEvent.change(screen.getByTestId("ai-model-custom-model-name-1"), {
      target: { value: "Model B" },
    });
    fireEvent.change(screen.getByTestId("ai-model-custom-model-context-1"), {
      target: { value: "128000" },
    });
    fireEvent.click(screen.getByTestId("ai-model-custom-select-1"));
    fireEvent.click(screen.getByTestId("ai-model-custom-remove-0"));
    fireEvent.click(screen.getByTestId("ai-model-custom-save"));

    await screen.findByText("settings.ai.model.status.customSaved");
    expect(currentAi().profiles).toHaveLength(1);
    expect(activeProfile().name).toBe("Acme Updated");
    expect(activeProfile().model).toBe("model-b");
    expect(activeProfile().contextWindowTokens).toBe(128_000);
    expect(activeProfile().modelCatalog?.map((entry) => entry.id)).toEqual(["model-b"]);
  });

  it("新建 Provider 不允许复用已有 Provider ID", async () => {
    setAi([presetProfile("deepseek")]);
    mount();
    openCustomTab();
    openNewCustomDraft();
    fillRequiredCustomFields("deepseek");

    fireEvent.click(screen.getByTestId("ai-model-custom-save"));
    await screen.findByText("settings.ai.model.error.providerIdExists");
    expect(currentAi().profiles).toHaveLength(1);
    expect(currentAi().activeProfileId).toBe("deepseek");
  });
});
