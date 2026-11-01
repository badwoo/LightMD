// @vitest-environment jsdom

/**
 * v0.15.4：AI 模型配置 1~6 项修复的行为测试。
 *
 * 覆盖：
 * 1. 自定义档案支持「本地部署类型」：选中预填端点/协议/鉴权，档案持久化 localKind；
 * 2. Ollama 列表并集（后端单测见 translate::ai_client，这里测前端把并集结果落库）;
 * 3. 服务商下拉只列 AI_PROVIDER_PRESETS；自定义档案自动切自定义页签；
 * 4. 自定义页签对等：获取模型列表 / 测试连接 / 上下文滑条 / 当前模型选择；
 * 5. 「获取模型列表」「测试连接」在模型名称输入框右侧（两页签）；
 * 6. 模型配置区下方「当前启用模型」= 服务商 - 模型名称 - 推理等级。
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
  LOCAL_DEPLOYMENT_PRESETS,
  mergeModelCatalog,
  upsertProviderProfile,
} from "../services/aiModelCatalog";
import { AI_PROVIDER_PRESETS, findAiProviderPreset } from "../services/aiProviderPresets";
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

beforeEach(() => {
  cleanup();
  listModelsMock.mockReset();
  testConnectionMock.mockReset();
  setAi([]);
});

afterEach(() => cleanup());

describe("需求1 不变量：本地部署预设与「服务商」预设必须自洽", () => {
  /**
   * 为什么钉这条：`inferProviderId` 用端点**精确匹配**来反推 Provider。
   * 两个本地运行时共用同一 baseUrl 时（llama.cpp 与 LocalAI 都曾写 8080），
   * 用户自建档案会被判成另一个 Provider → 服务商下拉显示错名字。
   */
  it("LOCAL_DEPLOYMENT_PRESETS 的 baseUrl 互不重复", () => {
    const seen = new Map<string, string>();
    for (const preset of LOCAL_DEPLOYMENT_PRESETS) {
      const base = preset.baseUrl.replace(/\/+$/, "").toLowerCase();
      const dup = seen.get(base);
      expect(dup, `baseUrl 重复：${preset.kind} 与 ${dup} 都是 ${base}`).toBeUndefined();
      seen.set(base, preset.kind);
    }
  });

  it("本地部署预设与 AI_PROVIDER_PRESETS 的同名运行时端点一致（llama.cpp 取上游默认 9931）", () => {
    const pairs: Array<[string, string]> = [
      ["ollama", "ollama"],
      ["lmstudio", "lmstudio"],
      ["vllm", "vllm"],
      ["llamacpp", "llama-cpp"],
      ["localai", "localai"],
    ];
    for (const [kind, presetId] of pairs) {
      const local = LOCAL_DEPLOYMENT_PRESETS.find((p) => p.kind === kind);
      const preset = findAiProviderPreset(presetId);
      expect(local, `缺少本地部署预设 ${kind}`).toBeTruthy();
      expect(preset, `缺少服务商预设 ${presetId}`).toBeTruthy();
      expect(local!.baseUrl.replace(/\/+$/, "")).toBe(preset!.baseUrl.replace(/\/+$/, ""));
    }
  });

  it("本地部署预设一律 authMode=none（本地服务无 API Key，optional 会白跑一次凭据解析）", () => {
    for (const preset of LOCAL_DEPLOYMENT_PRESETS) {
      expect(preset.authMode, `${preset.kind} 应为 none`).toBe("none");
    }
  });

  it("服务商预设里的本地运行时同样 authMode=none", () => {
    for (const presetId of ["ollama", "lmstudio", "vllm", "llama-cpp", "localai", "textgen-webui", "jan", "xinference", "sglang"]) {
      const preset = findAiProviderPreset(presetId);
      expect(preset, `缺少预设 ${presetId}`).toBeTruthy();
      expect(preset!.authMode, `${presetId} 应为 none`).toBe("none");
    }
  });
});

describe("需求1：本地部署类型", () => {
  it("自定义页签提供本地部署类型，选中 Ollama 预填端点/协议/鉴权", () => {
    setAi([presetProfile("deepseek")]);
    mount();
    openCustomTab();

    const select = screen.getByTestId("ai-model-custom-local-kind");
    expect((select as HTMLSelectElement).value).toBe("");

    fireEvent.change(select, { target: { value: "ollama" } });
    expect((screen.getByTestId("ai-model-custom-base-url") as HTMLInputElement).value)
      .toBe("http://127.0.0.1:11434/v1");
    fireEvent.change(select, { target: { value: "lmstudio" } });
    expect((screen.getByTestId("ai-model-custom-base-url") as HTMLInputElement).value)
      .toBe("http://127.0.0.1:1234/v1");
    fireEvent.change(select, { target: { value: "vllm" } });
    expect((screen.getByTestId("ai-model-custom-base-url") as HTMLInputElement).value)
      .toBe("http://127.0.0.1:8000/v1");
    expect((screen.getByTestId("ai-model-custom-protocol") as HTMLSelectElement).value)
      .toBe("openai-chat");
  });

  it("保存时把 localKind 写进档案（持久化字段可选，旧档案无此字段仍合法）", async () => {
    setAi([presetProfile("ollama")]);
    const credentials = createMemoryCredentialStore();
    mount(credentials);
    openCustomTab();

    fireEvent.change(screen.getByTestId("ai-model-custom-local-kind"), { target: { value: "ollama" } });
    fireEvent.change(screen.getByTestId("ai-model-custom-provider-id"), { target: { value: "local-ollama" } });
    fireEvent.change(screen.getByTestId("ai-model-custom-name"), { target: { value: "本机 Ollama" } });
    fireEvent.click(screen.getByTestId("ai-model-custom-add-model"));
    fireEvent.change(screen.getByTestId("ai-model-custom-model-id-0"), { target: { value: "qwen3-vl:8b" } });
    fireEvent.change(screen.getByTestId("ai-model-custom-model-name-0"), { target: { value: "qwen3-vl:8b" } });
    fireEvent.click(screen.getByTestId("ai-model-custom-select-0"));
    fireEvent.click(screen.getByTestId("ai-model-custom-save"));

    await waitFor(() => expect(currentAi().activeProfileId).toBe("local-ollama"));
    expect(activeProfile().localKind).toBe("ollama");
    expect(activeProfile().authMode).toBe("none");
    expect(activeProfile().baseUrl).toBe("http://127.0.0.1:11434/v1");
  });
});

describe("需求2：Ollama 本机全部模型", () => {
  it("前端把后端并集结果（含 /api/tags 独有条目）完整落进目录", async () => {
    setAi([presetProfile("ollama")]);
    listModelsMock.mockResolvedValue([
      { id: "qwen3-vl:8b-instruct", name: "qwen3-vl:8b-instruct", contextWindowTokens: 262_144 },
      { id: "qwen3-vl:8b", name: "qwen3-vl:8b", contextWindowTokens: 262_144 },
      { id: "guoxuter/ov_intent_analysis_sft:v7_q8", name: "guoxuter/ov_intent_analysis_sft:v7_q8", contextWindowTokens: 262_144 },
      { id: "bge-m3:latest", name: "bge-m3:latest", contextWindowTokens: 8192 },
    ]);
    mount();

    fireEvent.click(screen.getByTestId("ai-model-fetch"));
    await waitFor(() => expect(activeProfile().modelCatalog).toHaveLength(4));
    expect(activeProfile().modelCatalog?.map((entry) => entry.id)).toEqual([
      "qwen3-vl:8b-instruct",
      "qwen3-vl:8b",
      "guoxuter/ov_intent_analysis_sft:v7_q8",
      "bge-m3:latest",
    ]);
    expect(activeProfile().modelCatalog?.find((e) => e.id === "bge-m3:latest")?.contextWindowTokens)
      .toBe(8192);
  });

  it("再次拉取不会清掉用户手工保留的条目", () => {
    const merged = mergeModelCatalog(
      [{ id: "manual-model", name: "手工模型", contextWindowTokens: 16_384, reasoningEffort: "low" }],
      [{ id: "fetched-model", name: "Fetched" }],
    );
    expect(merged.map((entry) => entry.id)).toEqual(["fetched-model", "manual-model"]);
    expect(merged.find((entry) => entry.id === "manual-model")?.contextWindowTokens).toBe(16_384);
    expect(merged.find((entry) => entry.id === "manual-model")?.reasoningEffort).toBe("low");
  });
});

describe("需求3：服务商下拉不泄漏自定义项", () => {
  it("下拉只含 AI_PROVIDER_PRESETS 的 id", () => {
    setAi([customProfile(), presetProfile("deepseek")], "acme");
    mount();

    // 自定义档案激活时自动停在自定义页签，先回到服务商页签检查下拉。
    fireEvent.click(screen.getByRole("tab", { name: "settings.ai.model.tabs.provider" }));
    const select = screen.getByTestId("ai-model-provider") as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll("option")).map((option) => option.value);
    expect(options.sort()).toEqual(AI_PROVIDER_PRESETS.map((preset) => preset.id).sort());
    expect(options).not.toContain("acme");
    // 自定义档案激活时值为内置默认，且给出提示（不是显示自定义名混在下拉里）
    expect(select.value).toBe("ollama");
    expect(screen.getByTestId("ai-model-provider-custom-hint")).not.toBeNull();
  });

  it("当前启用自定义档案时自动切到自定义页签，并载入该档案", () => {
    setAi([presetProfile("deepseek"), customProfile()], "acme");
    mount();

    expect(screen.getByRole("tab", { name: "settings.ai.model.tabs.custom" }).getAttribute("aria-selected"))
      .toBe("true");
    // v0.15.5：下拉已替换为条目列表；自动切页签后该档案既是列表条目、也载入编辑区。
    expect(screen.getByTestId("ai-model-custom-item-acme")).not.toBeNull();
    expect(screen.getByTestId("ai-model-custom-item-active-acme")).not.toBeNull();
    expect((screen.getByTestId("ai-model-custom-base-url") as HTMLInputElement).value)
      .toBe("http://127.0.0.1:1234/v1");
  });

  it("启用内置服务商时仍停在服务商页签", () => {
    setAi([presetProfile("ollama"), customProfile()], "ollama");
    mount();
    expect(screen.getByRole("tab", { name: "settings.ai.model.tabs.provider" }).getAttribute("aria-selected"))
      .toBe("true");
    expect(screen.queryByTestId("ai-model-provider-custom-hint")).toBeNull();
  });
});

describe("task-4：服务商下拉按 optgroup 分组", () => {
  it("下拉有 3 个 optgroup（本地/国内/国际），label 走 i18n 且互不相同", () => {
    setAi([presetProfile("deepseek")]);
    mount();

    const select = screen.getByTestId("ai-model-provider") as HTMLSelectElement;
    const groups = Array.from(select.querySelectorAll("optgroup"));
    expect(groups.map((group) => group.dataset.testid)).toEqual([
      "ai-model-provider-group-local",
      "ai-model-provider-group-cn",
      "ai-model-provider-group-intl",
    ]);
    // 本文件 mock 了 useT 为恒等函数，所以 label 就是 i18n key 本身。
    expect(groups.map((group) => group.label)).toEqual([
      "settings.ai.model.providerGroup.local",
      "settings.ai.model.providerGroup.cn",
      "settings.ai.model.providerGroup.intl",
    ]);
  });

  it("optgroup 内的 option 仍覆盖全部预设（既有「只含预设 id」断言在新结构下成立）", () => {
    setAi([presetProfile("ollama")]);
    mount();

    const select = screen.getByTestId("ai-model-provider") as HTMLSelectElement;
    // 每条 option 都必须挂在某个 optgroup 下，不能散落在 select 顶层。
    const strayOptions = Array.from(select.children).filter((child) => child.tagName === "OPTION");
    expect(strayOptions).toHaveLength(0);

    const groupedIds = Array.from(select.querySelectorAll("optgroup option")).map(
      (option) => (option as HTMLOptionElement).value,
    );
    expect(groupedIds.sort()).toEqual(AI_PROVIDER_PRESETS.map((preset) => preset.id).sort());
  });

  it("分组数量与预设的 group 字段一致（不另写第二份 id→分组清单）", () => {
    setAi([presetProfile("ollama")]);
    mount();

    const select = screen.getByTestId("ai-model-provider") as HTMLSelectElement;
    for (const group of Array.from(select.querySelectorAll("optgroup"))) {
      const key = group.dataset.testid!.replace("ai-model-provider-group-", "") as
        "local" | "cn" | "intl";
      const expected = AI_PROVIDER_PRESETS.filter((preset) => preset.group === key).map(
        (preset) => preset.id,
      );
      const actual = Array.from(group.querySelectorAll("option")).map(
        (option) => (option as HTMLOptionElement).value,
      );
      expect(actual, `分组 ${key} 的成员应与 preset.group 字段一致`).toEqual(expected);
    }
  });

  it("切换分组内任一项仍能正确建立档案（optgroup 不影响 onChange 取值）", () => {
    setAi([presetProfile("ollama")]);
    mount();

    fireEvent.change(screen.getByTestId("ai-model-provider"), { target: { value: "xai" } });
    expect(currentAi().activeProfileId).toBe("xai");
    expect(activeProfile().providerId).toBe("xai");
    expect(activeProfile().baseUrl).toBe("https://api.x.ai/v1");

    fireEvent.change(screen.getByTestId("ai-model-provider"), { target: { value: "vllm" } });
    expect(currentAi().activeProfileId).toBe("vllm");
    expect(activeProfile().authMode).toBe("none");
    expect(activeProfile().baseUrl).toBe("http://127.0.0.1:8000/v1");
  });
});

describe("需求4：自定义页签与内置页签对等", () => {
  it("自定义页签获取模型列表成功后会写进草稿目录", async () => {
    setAi([presetProfile("ollama")]);
    const credentials = createMemoryCredentialStore();
    listModelsMock.mockResolvedValue([
      { id: "qwen3-vl:8b", name: "qwen3-vl:8b", contextWindowTokens: 262_144 },
    ]);
    mount(credentials);
    openCustomTab();

    fireEvent.change(screen.getByTestId("ai-model-custom-local-kind"), { target: { value: "ollama" } });
    fireEvent.change(screen.getByTestId("ai-model-custom-provider-id"), { target: { value: "draft-ollama" } });
    fireEvent.change(screen.getByTestId("ai-model-custom-name"), { target: { value: "草稿 Ollama" } });
    fireEvent.click(screen.getByTestId("ai-model-custom-fetch"));

    await waitFor(() => expect(listModelsMock).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("ai-model-custom-notice").textContent).toBe("settings.ai.model.status.fetchSuccess");
    // 拉到的模型进入草稿目录（radio 可选）
    await waitFor(() => expect((screen.getByTestId("ai-model-custom-model-id-0") as HTMLInputElement).value)
      .toBe("qwen3-vl:8b"));
  });

  it("自定义页签测试连接走草稿档案；未选模型时直接给出错误提示，不发请求", async () => {
    setAi([presetProfile("ollama")]);
    mount();
    openCustomTab();

    fireEvent.change(screen.getByTestId("ai-model-custom-provider-id"), { target: { value: "draft-api" } });
    fireEvent.change(screen.getByTestId("ai-model-custom-name"), { target: { value: "草稿 API" } });
    fireEvent.change(screen.getByTestId("ai-model-custom-base-url"), { target: { value: "https://draft.test/v1" } });
    fireEvent.click(screen.getByTestId("ai-model-custom-test"));
    expect(testConnectionMock).not.toHaveBeenCalled();
    await screen.findByText("settings.ai.model.error.selectModel");

    testConnectionMock.mockResolvedValue(undefined);
    fireEvent.click(screen.getByTestId("ai-model-custom-add-model"));
    fireEvent.change(screen.getByTestId("ai-model-custom-model-id-0"), { target: { value: "m" } });
    fireEvent.change(screen.getByTestId("ai-model-custom-model-name-0"), { target: { value: "M" } });
    fireEvent.click(screen.getByTestId("ai-model-custom-select-0"));
    fireEvent.click(screen.getByTestId("ai-model-custom-test"));

    await waitFor(() => expect(testConnectionMock).toHaveBeenCalledTimes(1));
    expect(testConnectionMock).toHaveBeenCalledWith(expect.objectContaining({
      id: "draft-api",
      providerId: "draft-api",
      credentialId: "draft-api",
      baseUrl: "https://draft.test/v1",
      model: "m",
    }));
    await screen.findByText("settings.ai.model.status.testSuccess");
  });

  it("自定义页签有上下文滑条，拖动写回草稿的上下文与输出上限", () => {
    setAi([presetProfile("ollama")]);
    mount();
    openCustomTab();

    fireEvent.change(screen.getByTestId("ai-model-custom-provider-id"), { target: { value: "draft-api" } });
    fireEvent.change(screen.getByTestId("ai-model-custom-name"), { target: { value: "草稿 API" } });
    fireEvent.click(screen.getByTestId("ai-model-custom-add-model"));
    fireEvent.change(screen.getByTestId("ai-model-custom-model-id-0"), { target: { value: "m" } });
    fireEvent.change(screen.getByTestId("ai-model-custom-model-name-0"), { target: { value: "M" } });
    fireEvent.change(screen.getByTestId("ai-model-custom-model-context-0"), { target: { value: "1000000" } });
    fireEvent.click(screen.getByTestId("ai-model-custom-select-0"));

    expect(screen.getByTestId("ai-model-custom-context")).not.toBeNull();
    const slider = screen.getByTestId("ai-model-custom-context-slider") as HTMLInputElement;
    expect(slider.max).toBe("2"); // 8192 / 600K / 1M
    expect(slider.value).toBe("2");
    fireEvent.change(slider, { target: { value: "1" } });
    expect(screen.getByTestId("ai-model-custom-context")).not.toBeNull();
    expect(screen.getAllByText("600K").length).toBeGreaterThan(0);
  });
});

describe("需求5：按钮位置", () => {
  it("服务商页签的获取/测试按钮与模型名称输入框同一行容器", () => {
    setAi([presetProfile("deepseek")]);
    mount();
    const nameInput = screen.getByTestId("ai-model-name");
    const row = nameInput.parentElement!;
    expect(row.className).toContain("ai-model-model-row");
    expect(row.contains(screen.getByTestId("ai-model-fetch"))).toBe(true);
    expect(row.contains(screen.getByTestId("ai-model-test"))).toBe(true);
  });

  it("自定义页签的获取/测试按钮也在模型名称输入框右侧", () => {
    setAi([presetProfile("ollama")]);
    mount();
    openCustomTab();
    const nameInput = screen.getByTestId("ai-model-custom-model");
    const row = nameInput.parentElement!;
    expect(row.className).toContain("ai-model-model-row");
    expect(row.contains(screen.getByTestId("ai-model-custom-fetch"))).toBe(true);
    expect(row.contains(screen.getByTestId("ai-model-custom-test"))).toBe(true);
  });

  it("旧的独立操作区已移除（避免重复按钮）", () => {
    setAi([presetProfile("deepseek")]);
    mount();
    expect(screen.queryByTestId("ai-model-fetch-extra")).toBeNull();
    expect(screen.queryByTestId("ai-model-test-extra")).toBeNull();
  });
});

describe("需求6：当前启用模型（v0.15.5 已移交 SettingsDialog）", () => {
  /**
   * v0.15.5：`ai-model-active-summary` / `ai-model-custom-active-summary` 两处渲染已从
   * AiModelSettings 移除，改由总开关下方的新位置负责（归属 SettingsDialog.tsx，
   * 不在本任务写范围）。因此这里只钉「本组件不再渲染」，三段格式的断言随渲染点一并移交。
   * 迁移对照（原用例期望）：
   *   - 内置服务商：ai-model-active-provider = settings.ai.provider.zhipuPlan
   *                  ai-model-active-model    = GLM-5.3
   *                  ai-model-active-reasoning= high
   *   - 自定义：    ai-model-custom-active-provider = 档案显示名称（如「本机 LM Studio」）
   *                  ai-model-custom-active-model    = 目录里的模型名称（如 Model A）
   *                  ai-model-custom-active-reasoning= off（未配置推理档）
   *   - 无模型：    ai-model-active-model = settings.ai.model.active.empty
   */
  it("服务商页签不再渲染 active summary（已移交）", () => {
    const profile: AiConnectionProfile = {
      ...presetProfile("zhipu-coding-plan"),
      model: "glm-5.3",
      requestPolicy: { ...presetProfile("zhipu-coding-plan").requestPolicy, reasoningEffort: "high" },
    };
    setAi([profile]);
    mount();

    expect(screen.queryByTestId("ai-model-active-summary")).toBeNull();
    expect(screen.queryByTestId("ai-model-active-provider")).toBeNull();
    expect(screen.queryByTestId("ai-model-active-model")).toBeNull();
    expect(screen.queryByTestId("ai-model-active-reasoning")).toBeNull();
  });

  it("自定义页签不再渲染 active summary（已移交）", () => {
    setAi([customProfile({ name: "本机 LM Studio" })]);
    mount();
    expect(screen.queryByTestId("ai-model-custom-active-summary")).toBeNull();
    expect(screen.queryByTestId("ai-model-custom-active-provider")).toBeNull();
    expect(screen.queryByTestId("ai-model-custom-active-model")).toBeNull();
    expect(screen.queryByTestId("ai-model-custom-active-reasoning")).toBeNull();
  });

  it("空模型时也不再有 active summary 占位（占位文案随之移交）", () => {
    const profile: AiConnectionProfile = { ...presetProfile("ollama"), model: "" };
    setAi([profile]);
    mount();
    expect(screen.queryByTestId("ai-model-active-empty")).toBeNull();
  });
});
