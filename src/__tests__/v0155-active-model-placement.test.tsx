// @vitest-environment jsdom

/**
 * v0.15.5 用户实测反馈 · 问题 3：
 * 「问题6的启用模型文字显示请放在启用AI功能按钮下面。」
 *
 * 覆盖：
 * ① 总开关开启时摘要可见，且格式为 `服务商 - 模型名称 - 推理等级`（三段）
 * ② 总开关**关闭**时摘要仍可见（它描述配置结果，与开关无关）
 * ③ 切换启用档案后摘要跟随更新（不刷新组件树也跟随）
 * ④ 自定义档案显示 Provider 的**显示名称**（profile.name），不是 Provider ID
 * ⑤ 无模型时给占位文案（settings.ai.model.active.empty）
 * ⑥ 位置契约：摘要挂在 ai-master-node 之后、ai-tree-children 之前，且不在两个页签内部
 */

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "../components/dialogs/SettingsDialog";
import {
  createCustomProfileDraft,
  describeActiveProfile,
  upsertProviderProfile,
} from "../services/aiModelCatalog";
import { findAiProviderPreset } from "../services/aiProviderPresets";
import { createDefaultAiSettings, type AiConnectionProfile, type AiSettings } from "../services/aiProfiles";
import { DEFAULT_TRANSLATE_SETTINGS, useSettingsStore } from "../stores/useSettingsStore";

const hasKey = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string) => command === "has_ai_credential_key" ? hasKey() : Promise.resolve(),
  Channel: class { onmessage?: (chunk: string) => void; },
}));

function emptySettings(): AiSettings {
  return { profiles: [], activeProfileId: "", instructions: [] };
}

function presetProfile(providerId: string, model?: string): AiConnectionProfile {
  const preset = findAiProviderPreset(providerId);
  if (!preset) throw new Error(`测试缺少预设 ${providerId}`);
  const profile = upsertProviderProfile(emptySettings(), preset, providerId).profile;
  return model === undefined ? profile : { ...profile, model };
}

function customProfile(overrides: Partial<AiConnectionProfile> = {}): AiConnectionProfile {
  return {
    ...createCustomProfileDraft(),
    id: "acme",
    providerId: "acme",
    credentialId: "acme",
    name: "本机 LM Studio",
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "model-a",
    modelCatalog: [{ id: "model-a", name: "Model A", contextWindowTokens: 32_768 }],
    ...overrides,
  };
}

function setAi(profiles: AiConnectionProfile[], activeProfileId?: string, aiEnabled = true) {
  useSettingsStore.setState({
    ai: {
      profiles,
      activeProfileId: activeProfileId ?? profiles[0]?.id ?? "",
      instructions: [],
    },
    aiEnabled,
  });
}

function renderDialog() {
  return render(<SettingsDialog onClose={() => {}} />);
}

function summary(): HTMLElement {
  return screen.getByTestId("ai-active-model-summary");
}

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

describe("问题3 纯函数口径：describeActiveProfile", () => {
  it("内置服务商：providerLabel 走 nameKey 翻译，modelLabel 取目录 name，reasoning 缺省为 off", () => {
    const profile = presetProfile("deepseek");
    const description = describeActiveProfile(
      { profiles: [profile], activeProfileId: profile.id },
      (key) => `t(${key})`,
    )!;
    expect(description.providerNameKey).toBe("settings.translate.provider.deepseek");
    expect(description.providerLabel).toBe("t(settings.translate.provider.deepseek)");
    expect(description.modelLabel).toBe("deepseek-v4-flash");
    expect(description.reasoning).toBe("off");
  });

  it("无 translator 时内置服务商退到 provider id（纯函数不依赖 i18n）", () => {
    const profile = presetProfile("openai");
    const description = describeActiveProfile({ profiles: [profile], activeProfileId: profile.id })!;
    expect(description.providerLabel).toBe("openai");
    expect(description.providerNameKey).toBe("settings.translate.provider.openai");
  });

  it("自定义服务商：providerLabel 用显示名称，不用 Provider ID", () => {
    const profile = customProfile({ name: "公司内网网关" });
    const description = describeActiveProfile({ profiles: [profile], activeProfileId: "acme" })!;
    expect(description.providerNameKey).toBeUndefined();
    expect(description.providerLabel).toBe("公司内网网关");
    expect(description.modelLabel).toBe("Model A");
  });

  it("显示名称为空时逐级退到 providerId、再退到档案 id（不显示空段）", () => {
    // 注意：baseUrl 不能落在任一预设端点上，否则 inferProviderId 会按端点反推成内置服务商。
    const noName = customProfile({
      name: "",
      providerId: "acme-gw",
      baseUrl: "https://gateway.internal.example/v1",
    });
    expect(describeActiveProfile({ profiles: [noName], activeProfileId: "acme" })!.providerLabel)
      .toBe("acme-gw");

    const noNameNoProvider = customProfile({
      name: "",
      providerId: undefined,
      baseUrl: "https://gateway.internal.example/v1",
    });
    expect(
      describeActiveProfile({ profiles: [noNameNoProvider], activeProfileId: "acme" })!.providerLabel,
    ).toBe("acme");
  });

  it("无模型时 modelLabel 为空串（由 UI 显示占位，纯函数不编造名字）", () => {
    const profile = { ...presetProfile("ollama"), model: "" };
    const description = describeActiveProfile({ profiles: [profile], activeProfileId: "ollama" })!;
    expect(description.modelLabel).toBe("");
  });

  it("模型 id 不在目录里时退到模型 id 本身（目录可能还没拉过）", () => {
    const profile = { ...presetProfile("deepseek"), modelCatalog: [], model: "custom-model-x" };
    expect(describeActiveProfile({ profiles: [profile], activeProfileId: profile.id })!.modelLabel)
      .toBe("custom-model-x");
  });

  it("推理等级取 requestPolicy.reasoningEffort，off 明确返回 'off'", () => {
    const profile = {
      ...presetProfile("deepseek"),
      requestPolicy: { ...presetProfile("deepseek").requestPolicy, reasoningEffort: "high" as const },
    };
    expect(describeActiveProfile({ profiles: [profile], activeProfileId: profile.id })!.reasoning)
      .toBe("high");
  });

  it("无档案 / activeProfileId 找不到时返回 null（UI 显示 .none）", () => {
    expect(describeActiveProfile(null)).toBeNull();
    expect(describeActiveProfile(undefined)).toBeNull();
    expect(describeActiveProfile({ profiles: [], activeProfileId: "" })).toBeNull();
    expect(describeActiveProfile({ profiles: [presetProfile("ollama")], activeProfileId: "missing" }))
      .toBeNull();
  });

  it("不读 React / store：同一输入两次调用结果一致（纯函数）", () => {
    const profile = presetProfile("zhipu-coding-plan");
    const settings = { profiles: [profile], activeProfileId: profile.id };
    const first = describeActiveProfile(settings)!;
    const second = describeActiveProfile(settings)!;
    expect(first.providerLabel).toBe(second.providerLabel);
    expect(first.modelLabel).toBe(second.modelLabel);
    expect(first.reasoning).toBe(second.reasoning);
  });
});

describe("问题3 位置契约：摘要在「启用 AI 功能」总开关下方", () => {
  it("总开关开启时摘要可见，且位于 ai-master-node 之后、ai-tree-children 之前", () => {
    setAi([presetProfile("deepseek")]);
    const { container } = renderDialog();

    const tree = container.querySelector('[data-testid="ai-tree"]')!;
    const masterNode = tree.querySelector(".ai-master-node")!;
    const summaryNode = summary();
    const children = tree.querySelector(".ai-tree-children");

    expect(masterNode).not.toBeNull();
    // 摘要紧跟在总开关那一段之后（同一 section 内、children 之前）
    expect(masterNode.compareDocumentPosition(summaryNode) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    if (children) {
      expect(summaryNode.compareDocumentPosition(children) & Node.DOCUMENT_POSITION_FOLLOWING)
        .toBeTruthy();
    }
    // 它在总开关所在 settings-field 里是**兄弟**而不是嵌套（保证不随开关隐藏）
    expect(summaryNode.parentElement).toBe(tree);
  });

  it("摘要不再渲染在两个页签内部（页签面板里查不到它）", () => {
    setAi([presetProfile("deepseek")]);
    renderDialog();
    const providerPanel = screen.getByTestId("ai-model-provider-panel");
    expect(within(providerPanel).queryByTestId("ai-active-model-summary")).toBeNull();
  });

  it("总开关关闭时摘要仍可见（这是本次需求的核心）", () => {
    setAi([presetProfile("deepseek")], undefined, false);
    renderDialog();

    // 总开关本身是 off
    expect((screen.getByTestId("ai-enabled") as HTMLSelectElement).value).toBe("off");
    // 但摘要照常显示
    expect(summary()).not.toBeNull();
    expect(screen.getByTestId("ai-active-provider").textContent).toBeTruthy();
  });
});

describe("问题3 内容：服务商 - 模型名称 - 推理等级", () => {
  it("总开关开启时三段齐全，分隔符为 '-'", () => {
    setAi([presetProfile("deepseek")]);
    renderDialog();

    const provider = screen.getByTestId("ai-active-provider");
    const model = screen.getByTestId("ai-active-model");
    const reasoning = screen.getByTestId("ai-active-reasoning");
    expect(provider.textContent).toBeTruthy();
    expect(model.textContent).toBe("deepseek-v4-flash");
    expect(reasoning.textContent).toBe("off");

    const separators = summary().querySelectorAll(".ai-active-model-separator");
    expect(separators).toHaveLength(2);
    expect(Array.from(separators).map((node) => node.textContent)).toEqual(["-", "-"]);
  });

  it("内置服务商显示其本地化名称（不是 provider id）", () => {
    setAi([presetProfile("zhipu-coding-plan")]);
    renderDialog();
    // 真实字典：settings.ai.provider.zhipuPlan = 智谱 GLM Coding Plan
    expect(screen.getByTestId("ai-active-provider").textContent).toBe("智谱 GLM Coding Plan");
  });

  it("自定义档案显示 Provider 显示名称与目录里的模型 name", () => {
    setAi([customProfile({ name: "公司内网网关" })], "acme");
    renderDialog();
    expect(screen.getByTestId("ai-active-provider").textContent).toBe("公司内网网关");
    expect(screen.getByTestId("ai-active-model").textContent).toBe("Model A");
    expect(screen.getByTestId("ai-active-reasoning").textContent).toBe("off");
  });

  it("模型名称优先取目录 name（用户可改名），不是原始 id", () => {
    setAi([customProfile({ name: "Acme", modelCatalog: [{ id: "model-a", name: "友好名称" }] })], "acme");
    renderDialog();
    expect(screen.getByTestId("ai-active-model").textContent).toBe("友好名称");
  });

  it("无模型时显示占位文案而不是空白或假名", () => {
    setAi([{ ...presetProfile("ollama"), model: "" }]);
    renderDialog();
    expect(screen.getByTestId("ai-active-model").textContent).toBe("未选择模型");
    expect(screen.getByTestId("ai-active-provider").textContent).toBe("Ollama（本地，默认）");
  });

  it("完全没有启用档案时显示 .none 占位并给独立 testid", () => {
    // 总开关关闭时 AiModelSettings 不渲染，也就不会触发它「空配置补给 Ollama」的副作用，
    // 这是 .none 分支在真实 UI 里可达的唯一路径；同时也验证了「关闭时摘要仍在」。
    useSettingsStore.setState({ ai: emptySettings(), aiEnabled: false });
    renderDialog();
    expect((screen.getByTestId("ai-enabled") as HTMLSelectElement).value).toBe("off");
    expect(screen.getByTestId("ai-active-model-empty").textContent).toBe("尚未配置任何连接");
    expect(screen.queryByTestId("ai-active-model-value")).toBeNull();
  });

  it("总开关开启 + 空配置时，AiModelSettings 的防御性补给让摘要显示默认 Ollama", () => {
    useSettingsStore.setState({ ai: emptySettings(), aiEnabled: true });
    renderDialog();
    // 既有行为（本次不改）：组件内 useEffect 把空配置补成默认 Ollama，
    // 于是摘要走「有档案但没模型」分支，显示 Ollama + 未选择模型占位。
    expect(screen.getByTestId("ai-active-provider").textContent).toBe("Ollama（本地，默认）");
    expect(screen.getByTestId("ai-active-model").textContent).toBe("未选择模型");
    expect(screen.queryByTestId("ai-active-model-empty")).toBeNull();
  });
});

describe("问题3 联动：切换启用档案后摘要跟随", () => {
  it("在页签内切换服务商后，总开关下方摘要同步更新", () => {
    setAi([presetProfile("ollama")]);
    renderDialog();
    expect(screen.getByTestId("ai-active-model").textContent).toBe("未选择模型");

    fireEvent.change(screen.getByTestId("ai-model-provider"), { target: { value: "deepseek" } });
    expect(screen.getByTestId("ai-active-provider").textContent).toBe("DeepSeek（默认）");
    expect(screen.getByTestId("ai-active-model").textContent).toBe("deepseek-v4-flash");
    expect(screen.getByTestId("ai-active-reasoning").textContent).toBe("off");
  });

  it("切换回原档案后摘要回到原值（不是只增不减）", () => {
    setAi([presetProfile("ollama"), presetProfile("deepseek")], "deepseek");
    renderDialog();
    expect(screen.getByTestId("ai-active-model").textContent).toBe("deepseek-v4-flash");

    fireEvent.change(screen.getByTestId("ai-model-provider"), { target: { value: "ollama" } });
    expect(screen.getByTestId("ai-active-provider").textContent).toBe("Ollama（本地，默认）");
    expect(screen.getByTestId("ai-active-model").textContent).toBe("未选择模型");
  });

  it("外部直接改 store 的 activeProfileId 后摘要跟随（不依赖页签内部状态）", () => {
    const kimi = presetProfile("kimi");
    setAi([presetProfile("ollama"), kimi], "ollama");
    renderDialog();
    expect(screen.getByTestId("ai-active-provider").textContent).toBe("Ollama（本地，默认）");

    act(() => {
      useSettingsStore.setState({
        ai: { profiles: [presetProfile("ollama"), kimi], activeProfileId: kimi.id, instructions: [] },
      });
    });
    // settings = useSettingsStore() 是整店订阅，setState 会触发重渲染
    expect(screen.getByTestId("ai-active-provider").textContent).toBe("Kimi（月之暗面）");
    expect(screen.getByTestId("ai-active-model").textContent).toBe("kimi-k3");
  });

  it("推理等级跟随 requestPolicy 变化", () => {
    const base = presetProfile("deepseek");
    setAi([base, { ...base, id: "deepseek-high", requestPolicy: { ...base.requestPolicy, reasoningEffort: "high" } }], "deepseek");
    renderDialog();
    expect(screen.getByTestId("ai-active-reasoning").textContent).toBe("off");

    act(() => {
      useSettingsStore.setState({
        ai: {
          profiles: [
            { ...base, id: "deepseek-high", requestPolicy: { ...base.requestPolicy, reasoningEffort: "high" } },
          ],
          activeProfileId: "deepseek-high",
          instructions: [],
        },
      });
    });
    expect(screen.getByTestId("ai-active-reasoning").textContent).toBe("high");
  });
});
