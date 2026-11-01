// @vitest-environment jsdom

/**
 * v0.15.5：用户实测反馈「自定义配置完看不到记录」的回归测试 + 自定义条目列表。
 *
 * 根因（已复现）：v0.15.4 的 `isCustomProfile()` 是
 * `!findAiProviderPreset(inferProviderId(profile))`。用户在服务商页签选了 deepseek 后
 * 去自定义页签配置，很自然把 Provider ID 也填成 "deepseek"；保存后该档案
 * `providerId="deepseek"` → `inferProviderId` 命中预设 → 判定为非自定义 →
 * ① 不进自定义下拉；② 服务商下拉自 v0.15.4 起只列预设、也不显示它 →
 * **配置在任何 UI 入口都看不到**，正是用户说的「配置完就看不到这条记录」。
 * 同类隐患：老档案 providerId 为空但 baseUrl 恰好等于某预设端点。
 *
 * 修复：档案加可选 `source: "preset" | "custom"`，判定优先看它；缺失时回退兼容推断。
 *
 * 覆盖：
 * - A. providerId 撞预设 id 的自定义档案仍算自定义、并出现在条目列表；
 * - B. 老档案（无 source）baseUrl 撞预设端点也出现在列表；
 * - C. 真预设档案（source:"preset"）绝不进列表；
 * - D. 条目列表交互：点击载入、绿点仅在启用条目、删除、删除启用后 activeProfileId 回落；
 * - E. 空列表引导文案；新 testid 契约。
 */

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
  inferProviderId,
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

/**
 * 由内置预设建出的档案。
 * @param source 显式给出时覆盖；**传 `null` 表示「老档案」（不带 source 字段）**，
 *   用于验证 0.15.5 之前的 persist 数据仍能被正确归类。
 */
function presetProfile(
  providerId: string,
  source: "preset" | "custom" | null = "preset",
): AiConnectionProfile {
  const preset = findAiProviderPreset(providerId);
  if (!preset) throw new Error(`测试缺少预设 ${providerId}`);
  const profile = upsertProviderProfile(emptySettings(), preset, providerId).profile;
  if (source === null) {
    const legacy = { ...profile };
    delete legacy.source;
    return legacy;
  }
  return { ...profile, source };
}

function customProfile(overrides: Partial<AiConnectionProfile> = {}): AiConnectionProfile {
  return {
    ...createCustomProfileDraft(),
    id: "acme",
    providerId: "acme",
    credentialId: "acme",
    name: "Acme 本地",
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "model-a",
    modelCatalog: [{ id: "model-a", name: "Model A", contextWindowTokens: 32_768 }],
    source: "custom",
    ...overrides,
  };
}

function mount(credentialStore?: AiCredentialStore) {
  const store = credentialStore ?? createMemoryCredentialStore();
  return { store, ...render(<AiModelSettings credentialStore={store} />) };
}

function openCustomTab() {
  fireEvent.click(screen.getByRole("tab", { name: "settings.ai.model.tabs.custom" }));
}

/** 列表条目 testid（排除 select / delete / active 子 testid）。 */
function listedProfileIds(): string[] {
  return Array.from(document.querySelectorAll('[data-testid^="ai-model-custom-item-"]'))
    .map((element) => element.getAttribute("data-testid")!)
    .filter((id) => !["-select-", "-delete-", "-active-"].some((marker) => id.includes(marker)))
    .map((id) => id.replace("ai-model-custom-item-", ""));
}

/** 填充并保存一条自定义配置（providerId 可任意，含撞预设 id 的情形）。 */
async function saveCustomProfile(options: {
  providerId: string;
  name: string;
  baseUrl?: string;
  modelId?: string;
}) {
  fireEvent.change(screen.getByTestId("ai-model-custom-provider-id"), {
    target: { value: options.providerId },
  });
  fireEvent.change(screen.getByTestId("ai-model-custom-name"), {
    target: { value: options.name },
  });
  fireEvent.change(screen.getByTestId("ai-model-custom-base-url"), {
    target: { value: options.baseUrl ?? "https://proxy.test/v1" },
  });
  fireEvent.click(screen.getByTestId("ai-model-custom-add-model"));
  const modelId = options.modelId ?? "proxy-model";
  fireEvent.change(screen.getByTestId("ai-model-custom-model-id-0"), { target: { value: modelId } });
  fireEvent.change(screen.getByTestId("ai-model-custom-model-name-0"), { target: { value: "Proxy Model" } });
  fireEvent.click(screen.getByTestId("ai-model-custom-select-0"));
  fireEvent.click(screen.getByTestId("ai-model-custom-save"));
}

beforeEach(() => {
  cleanup();
  listModelsMock.mockReset();
  testConnectionMock.mockReset();
  setAi([]);
});

afterEach(() => cleanup());

describe("问题1 根因：providerId 撞预设 id 不再导致配置消失", () => {
  it("复现：旧口径下该档案被判为非自定义（证明 bug 基线存在）", () => {
    // 直接钉住旧口径行为：providerId="deepseek" → inferProviderId 命中预设 → 旧口径 false。
    const saved: AiConnectionProfile = {
      ...createCustomProfileDraft(),
      id: "deepseek",
      providerId: "deepseek",
      credentialId: "deepseek",
      name: "我的代理",
      baseUrl: "https://proxy.test/v1",
      model: "m",
      modelCatalog: [{ id: "m", name: "M" }],
    };
    expect(inferProviderId(saved)).toBe("deepseek");
    expect(findAiProviderPreset(inferProviderId(saved)))?.not.toBeNull();
    // == 旧 isCustomProfile 的返回值：false（于是两个页签都看不到它）
    expect(!findAiProviderPreset(inferProviderId(saved))).toBe(false);
  });

  it("修复后：在服务商选 deepseek 后，自定义里把 Provider ID 填成 deepseek → 保存成功且出现在列表", async () => {
    setAi([presetProfile("ollama")]);
    mount();
    openCustomTab();

    await saveCustomProfile({ providerId: "deepseek", name: "我的 DeepSeek 代理" });

    await screen.findByText("settings.ai.model.status.customSaved");
    const saved = currentAi().profiles.find((profile) => profile.id === "deepseek")!;
    expect(saved.source, "保存自定义必须打 source=custom").toBe("custom");
    expect(saved.baseUrl).toBe("https://proxy.test/v1");
    expect(listedProfileIds(), "撞预设 id 的自定义档案必须出现在条目列表").toContain("deepseek");
    expect(screen.getByTestId("ai-model-custom-item-deepseek")).not.toBeNull();
  });

  it("老档案（无 source）providerId 为空但 baseUrl 撞预设端点 → 仍出现在列表", () => {
    const legacy: AiConnectionProfile = {
      ...presetProfile("ollama", null),
      id: "legacy-proxy",
      credentialId: "legacy-proxy",
      name: "老代理",
      providerId: undefined,
      baseUrl: "https://api.deepseek.com/v1",
      model: "x",
      modelCatalog: [{ id: "x", name: "X" }],
    };
    expect(inferProviderId(legacy)).toBe("deepseek");
    setAi([legacy, presetProfile("ollama")], "legacy-proxy");

    mount();
    openCustomTab();
    expect(listedProfileIds()).toContain("legacy-proxy");
  });

  it("真预设档案（source=preset）绝不进自定义列表，即使 providerId 命中预设", () => {
    setAi([presetProfile("deepseek", "preset"), presetProfile("ollama")], "deepseek");
    mount();
    openCustomTab();
    expect(listedProfileIds()).not.toContain("deepseek");
    expect(screen.queryByTestId("ai-model-custom-item-deepseek")).toBeNull();
  });

  it("source 优先于 providerId：source=custom + 预设端点 → 仍算自定义", () => {
    const contradiction = {
      ...presetProfile("deepseek", "custom"),
      baseUrl: "https://api.deepseek.com/v1",
    };
    setAi([contradiction, presetProfile("ollama")], contradiction.id);
    mount();
    // 自定义档案激活 → 自动切自定义页签
    expect(screen.getByRole("tab", { name: "settings.ai.model.tabs.custom" }).getAttribute("aria-selected"))
      .toBe("true");
    expect(listedProfileIds()).toContain("deepseek");
  });
});

describe("问题1 需求1：自定义配置条目列表", () => {
  it("列表渲染名称与 Provider ID/端点摘要，空列表显示引导文案", () => {
    setAi([presetProfile("ollama")]);
    mount();
    openCustomTab();

    expect(screen.getByTestId("ai-model-custom-list-empty")).not.toBeNull();
    expect(screen.queryByTestId("ai-model-custom-list")).toBeNull();
    expect(screen.getByTestId("ai-model-custom-new")).not.toBeNull();
  });

  it("有条目时列出每行：名称 + Provider ID + 端点", () => {
    setAi([customProfile(), presetProfile("ollama")], "acme");
    mount();

    const item = screen.getByTestId("ai-model-custom-item-acme");
    expect(item.textContent).toContain("Acme 本地");
    expect(item.textContent).toContain("acme");
    expect(item.textContent).toContain("http://127.0.0.1:1234/v1");
  });

  it("点击行载入该档案到编辑区", () => {
    setAi([
      customProfile(),
      customProfile({ id: "other", providerId: "other", credentialId: "other", name: "另一条", baseUrl: "https://other.test/v1" }),
      presetProfile("ollama"),
    ], "acme");
    mount();

    expect((screen.getByTestId("ai-model-custom-name") as HTMLInputElement).value).toBe("Acme 本地");
    fireEvent.click(screen.getByTestId("ai-model-custom-item-select-other"));
    expect((screen.getByTestId("ai-model-custom-name") as HTMLInputElement).value).toBe("另一条");
    expect((screen.getByTestId("ai-model-custom-base-url") as HTMLInputElement).value)
      .toBe("https://other.test/v1");
  });

  it("绿色圆点只出现在当前启用条目，并带 aria-label", () => {
    setAi([
      customProfile(),
      customProfile({ id: "other", providerId: "other", credentialId: "other", name: "另一条" }),
      presetProfile("ollama"),
    ], "acme");
    mount();

    const dot = screen.getByTestId("ai-model-custom-item-active-acme");
    expect(dot.classList.contains("ai-model-custom-item-active-dot")).toBe(true);
    expect(dot.getAttribute("role")).toBe("img");
    expect(dot.getAttribute("aria-label")).toBe("settings.ai.model.custom.activeDotLabel");
    // 非启用条目没有绿点
    expect(screen.queryByTestId("ai-model-custom-item-active-other")).toBeNull();
    expect(screen.queryByTestId("ai-model-custom-item-active-ollama")).toBeNull();
  });

  it("删除非启用条目：只移除该条目，activeProfileId 不变、凭据槽清理", async () => {
    const credentials = createMemoryCredentialStore({ other: "other-secret" });
    setAi([
      customProfile(),
      customProfile({ id: "other", providerId: "other", credentialId: "other", name: "另一条" }),
      presetProfile("ollama"),
    ], "acme");
    mount(credentials);

    fireEvent.click(screen.getByTestId("ai-model-custom-item-delete-other"));
    await waitFor(() => expect(currentAi().profiles.map((profile) => profile.id)).toEqual(["acme", "ollama"]));
    expect(currentAi().activeProfileId).toBe("acme");
    await waitFor(() => expect(credentials.stored.has("other")).toBe(false));
  });

  it("删除当前启用条目：activeProfileId 回落到 ollama 档案", async () => {
    setAi([customProfile(), presetProfile("ollama")], "acme");
    mount();

    fireEvent.click(screen.getByTestId("ai-model-custom-item-delete-acme"));
    await waitFor(() => expect(currentAi().profiles.map((profile) => profile.id)).toEqual(["ollama"]));
    expect(currentAi().activeProfileId).toBe("ollama");
    expect(activeProfile().providerId).toBe("ollama");
    expect(screen.getByTestId("ai-model-custom-list-empty")).not.toBeNull();
  });

  it("删除当前启用条目且没有 ollama 档案 → 现场建一个 Ollama 档案作为回落", async () => {
    setAi([customProfile()], "acme");
    mount();

    fireEvent.click(screen.getByTestId("ai-model-custom-item-delete-acme"));
    await waitFor(() => expect(currentAi().profiles).toHaveLength(1));
    expect(currentAi().activeProfileId).toBe("ollama");
    expect(currentAi().profiles[0]!.providerId).toBe("ollama");
    expect(currentAi().profiles[0]!.source).toBe("preset");
  });

  it("删除正编辑的条目后草稿回到「新建」", async () => {
    setAi([customProfile(), presetProfile("ollama")], "acme");
    mount();

    fireEvent.click(screen.getByTestId("ai-model-custom-item-delete-acme"));
    await waitFor(() => expect((screen.getByTestId("ai-model-custom-name") as HTMLInputElement).value).toBe(""));
    expect(screen.getByTestId("ai-model-custom-new")).toHaveProperty("disabled", true);
  });

  it("凭据清理失败不阻断删除", async () => {
    const store: AiCredentialStore = {
      has: async () => true,
      save: async () => undefined,
      clear: async () => {
        throw new Error("AUTH|凭据管理器不可用");
      },
    };
    setAi([customProfile(), presetProfile("ollama")], "acme");
    mount(store);

    fireEvent.click(screen.getByTestId("ai-model-custom-item-delete-acme"));
    await waitFor(() => expect(currentAi().profiles.map((profile) => profile.id)).toEqual(["ollama"]));
    expect(currentAi().activeProfileId).toBe("ollama");
  });

  it("authMode=none 的条目删除时不碰凭据库", async () => {
    const credentials = createMemoryCredentialStore();
    const clearSpy = vi.spyOn(credentials, "clear");
    setAi([customProfile({ authMode: "none" }), presetProfile("ollama")], "acme");
    mount(credentials);

    fireEvent.click(screen.getByTestId("ai-model-custom-item-delete-acme"));
    await waitFor(() => expect(currentAi().profiles).toHaveLength(1));
    expect(clearSpy).not.toHaveBeenCalled();
  });
});

describe("问题1 需求4：「当前启用模型」已从模型配置区移除", () => {
  it("服务商页签不再渲染 active summary", () => {
    setAi([presetProfile("ollama")]);
    mount();
    expect(screen.queryByTestId("ai-model-active-summary")).toBeNull();
    expect(screen.queryByTestId("ai-model-active-provider")).toBeNull();
  });

  it("自定义页签不再渲染 active summary", () => {
    setAi([customProfile()], "acme");
    mount();
    expect(screen.queryByTestId("ai-model-custom-active-summary")).toBeNull();
    expect(screen.queryByTestId("ai-model-custom-active-provider")).toBeNull();
  });
});
