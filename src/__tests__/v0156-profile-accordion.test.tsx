// @vitest-environment jsdom

/**
 * v0.15.6：两个页签统一为「条目展开/收起 + 启用关闭按钮 + 绿点」。
 *
 * 用户口径（以原话为准，覆盖任务书的推测）：
 * - 点击**条目主体** = 只展开/收起（不启用、不产生别的副作用）；同屏只展开一条（accordion）。
 * - 点击条目上的**启用/关闭按钮** = 只启停，与展开互不影响；允许「全部关闭」（activeProfileId 置空）。
 * - 绿点在启用/关闭按钮**右边**。
 * - 服务商页签只列**已配置过**的服务商，顶部「添加服务商」只给未配置预设。
 *
 * 覆盖（对应任务书 ①~⑥）：
 * ① 每条目点击展开/收起，且同时只展开一条
 * ② 启用/关闭按钮独立于展开（关掉展开中的条目仍在展开态）
 * ③ 绿点仅启用条目有，且位于启用按钮右侧（DOM 顺序）
 * ④ 允许全部关闭且 activeProfileId 置空（且不会被空态兜底 effect 擅自重启）
 * ⑤ 服务商页签只列已配置条目 + 添加下拉只给未配置预设 + 添加后自动展开并打 source:"preset"
 * ⑥ 服务商展开条目编辑的是该条目，不是当前启用条目
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

/** activeProfileId 显式传 null 表示「全部关闭」空串（不自动取第一条）。 */
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

function presetProfile(providerId: string, source: "preset" | "custom" | null = "preset"): AiConnectionProfile {
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

function openTab(next: "provider" | "custom") {
  fireEvent.click(screen.getByRole("tab", { name: `settings.ai.model.tabs.${next}` }));
}

beforeEach(() => {
  cleanup();
  listModelsMock.mockReset();
  testConnectionMock.mockReset();
  setAi([]);
});

afterEach(() => cleanup());

describe("① accordion：点击条目主体只展开/收起，同屏只展开一条", () => {
  it("自定义页签：展开 A → 展开 B 时 A 收起；再点 B 收起", () => {
    setAi([
      customProfile(),
      customProfile({ id: "other", providerId: "other", credentialId: "other", name: "另一条" }),
      presetProfile("ollama"),
    ], "acme");
    mount();

    const selectA = screen.getByTestId("ai-model-custom-item-select-acme");
    const selectB = screen.getByTestId("ai-model-custom-item-select-other");
    // 默认展开当前启用的 acme
    expect(selectA.getAttribute("aria-expanded")).toBe("true");
    expect(selectB.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("ai-model-custom-body-acme")).not.toBeNull();
    expect(screen.queryByTestId("ai-model-custom-body-other")).toBeNull();

    fireEvent.click(selectB);
    expect(selectB.getAttribute("aria-expanded")).toBe("true");
    expect(selectA.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("ai-model-custom-body-other")).not.toBeNull();
    expect(screen.queryByTestId("ai-model-custom-body-acme")).toBeNull();

    fireEvent.click(selectB);
    expect(selectB.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("ai-model-custom-body-other")).toBeNull();
    // 全部收起后编辑表单整体消失
    expect(screen.queryByTestId("ai-model-custom-name")).toBeNull();
  });

  it("展开体在对应条目的 <li> 内（实机探针用 body.offsetHeight 判可见）", () => {
    setAi([customProfile(), presetProfile("ollama")], "acme");
    mount();
    const li = screen.getByTestId("ai-model-custom-item-acme");
    const body = screen.getByTestId("ai-model-custom-body-acme");
    expect(li.tagName).toBe("LI");
    expect(li.contains(body), "展开体必须是该条目的后代节点").toBe(true);
  });

  it("服务商页签同样是 accordion", () => {
    setAi([presetProfile("ollama"), presetProfile("deepseek")], "ollama");
    mount();

    const ollama = screen.getByTestId("ai-model-provider-item-select-ollama");
    const deepseek = screen.getByTestId("ai-model-provider-item-select-deepseek");
    expect(ollama.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(deepseek);
    expect(deepseek.getAttribute("aria-expanded")).toBe("true");
    expect(ollama.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("ai-model-provider-body-ollama")).toBeNull();
    expect(screen.getByTestId("ai-model-provider-body-deepseek")).not.toBeNull();
  });
});

describe("② 启用/关闭按钮独立于展开", () => {
  it("关闭正在展开的条目：仍保持展开态，只是不再启用", () => {
    setAi([customProfile(), presetProfile("ollama")], "acme");
    mount();

    const toggle = screen.getByTestId("ai-model-custom-item-toggle-acme");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    // 展开态不受影响
    expect(screen.getByTestId("ai-model-custom-item-select-acme").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("ai-model-custom-body-acme")).not.toBeNull();
    expect(currentAi().activeProfileId).toBe("");
  });

  it("启用未展开的条目：不会自动展开它", () => {
    setAi([customProfile(), customProfile({ id: "other", providerId: "other", credentialId: "other", name: "另一条" })], "acme");
    mount();

    const toggleOther = screen.getByTestId("ai-model-custom-item-toggle-other");
    expect(toggleOther.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(toggleOther);
    expect(toggleOther.getAttribute("aria-pressed")).toBe("true");
    expect(currentAi().activeProfileId).toBe("other");
    // 展开态仍停在 acme，没有跟着启用项跳动
    expect(screen.getByTestId("ai-model-custom-item-select-other").getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("ai-model-custom-body-acme")).not.toBeNull();
  });

  it("点击条目主体不会改变启用状态", () => {
    setAi([customProfile(), presetProfile("ollama")], "acme");
    mount();

    fireEvent.click(screen.getByTestId("ai-model-custom-item-select-acme"));
    expect(currentAi().activeProfileId).toBe("acme");

    fireEvent.click(screen.getByTestId("ai-model-custom-item-select-acme"));
    expect(currentAi().activeProfileId, "收起不会关闭启用").toBe("acme");
  });

  it("同一时刻最多一条启用：启用 B 后 A 自动变未启用", () => {
    setAi([customProfile(), customProfile({ id: "other", providerId: "other", credentialId: "other", name: "另一条" })], "acme");
    mount();

    fireEvent.click(screen.getByTestId("ai-model-custom-item-toggle-other"));
    expect(currentAi().activeProfileId).toBe("other");
    expect(screen.getByTestId("ai-model-custom-item-toggle-acme").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("ai-model-custom-item-toggle-other").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("③ 绿点：仅启用条目有，且在启用按钮右侧", () => {
  it("绿点 DOM 顺序位于 toggle 之后、delete 之前", () => {
    setAi([customProfile(), presetProfile("ollama")], "acme");
    mount();

    const row = screen.getByTestId("ai-model-custom-item-toggle-acme").parentElement!;
    const children = Array.from(row.children) as HTMLElement[];
    const toggleIndex = children.findIndex(
      (element) => element.getAttribute("data-testid") === "ai-model-custom-item-toggle-acme",
    );
    const dotIndex = children.findIndex(
      (element) => element.getAttribute("data-testid") === "ai-model-custom-item-active-acme",
    );
    const deleteIndex = children.findIndex(
      (element) => element.getAttribute("data-testid") === "ai-model-custom-item-delete-acme",
    );

    expect(toggleIndex).toBeGreaterThanOrEqual(0);
    expect(dotIndex, "绿点必须存在").toBeGreaterThanOrEqual(0);
    expect(dotIndex, "绿点必须在启用按钮右边").toBeGreaterThan(toggleIndex);
    expect(deleteIndex).toBeGreaterThan(dotIndex);
  });

  it("未启用条目没有绿点；关闭后绿点消失", () => {
    setAi([
      customProfile(),
      customProfile({ id: "other", providerId: "other", credentialId: "other", name: "另一条" }),
    ], "acme");
    mount();

    expect(screen.queryByTestId("ai-model-custom-item-active-other")).toBeNull();

    fireEvent.click(screen.getByTestId("ai-model-custom-item-toggle-acme"));
    expect(screen.queryByTestId("ai-model-custom-item-active-acme")).toBeNull();
  });

  it("服务商页签绿点同样在 toggle 右边", () => {
    setAi([presetProfile("ollama"), presetProfile("deepseek")], "deepseek");
    mount();

    const row = screen.getByTestId("ai-model-provider-item-toggle-deepseek").parentElement!;
    const children = Array.from(row.children) as HTMLElement[];
    const toggleIndex = children.findIndex(
      (element) => element.getAttribute("data-testid") === "ai-model-provider-item-toggle-deepseek",
    );
    const dotIndex = children.findIndex(
      (element) => element.getAttribute("data-testid") === "ai-model-provider-item-active-deepseek",
    );
    expect(dotIndex).toBeGreaterThan(toggleIndex);
    expect(screen.queryByTestId("ai-model-provider-item-active-ollama")).toBeNull();
  });
});

describe("④ 允许全部关闭", () => {
  it("关闭唯一条目后 activeProfileId 置空，且摘要显示 .none（由 SettingsDialog 兜底）", () => {
    setAi([customProfile()], "acme");
    mount();
    openTab("custom");

    fireEvent.click(screen.getByTestId("ai-model-custom-item-toggle-acme"));
    expect(currentAi().activeProfileId).toBe("");
    expect(screen.queryByTestId("ai-model-custom-item-active-acme")).toBeNull();
  });

  it("全部关闭后等一拍，空态兜底 effect 不会擅自重新启用（profiles.length > 0 即 return）", async () => {
    setAi([customProfile(), presetProfile("ollama")], "acme");
    mount();
    openTab("custom");

    fireEvent.click(screen.getByTestId("ai-model-custom-item-toggle-acme"));

    await waitFor(() => expect(currentAi().activeProfileId).toBe(""));
    // 再等一拍，确认没有任何 effect 把启用项「补」回来
    await waitFor(() => expect(currentAi().activeProfileId).toBe(""), { timeout: 1000 });
    expect(currentAi().profiles).toHaveLength(2);
    expect(currentAi().profiles.map((profile) => profile.id)).toEqual(["acme", "ollama"]);
  });

  it("全部关闭是合法持久化状态：不会留下悬空 activeProfileId", () => {
    setAi([customProfile()], "acme");
    mount();
    openTab("custom");
    fireEvent.click(screen.getByTestId("ai-model-custom-item-toggle-acme"));

    const id = currentAi().activeProfileId;
    expect(id).toBe("");
    expect(currentAi().profiles.some((profile) => profile.id === id)).toBe(false);
  });
});

describe("⑤ 服务商页签只列已配置 + 添加下拉只给未配置预设", () => {
  it("列表只含已配置服务商；未配置的预设不出现", () => {
    setAi([presetProfile("ollama"), presetProfile("deepseek")], "ollama");
    mount();

    const items = Array.from(document.querySelectorAll('[data-testid^="ai-model-provider-item-"]'))
      .map((element) => element.getAttribute("data-testid")!)
      .filter((id) => ["-select-", "-toggle-", "-active-", "-delete-"].every((marker) => !id.includes(marker)))
      .map((id) => id.replace("ai-model-provider-item-", ""));
    expect(items).toEqual(["ollama", "deepseek"]);
    expect(screen.getByTestId("ai-model-provider-list")).not.toBeNull();
  });

  it("空列表显示引导文案；添加下拉只列未配置预设（含 optgroup 分组）", () => {
    setAi([]);
    mount();
    // 空配置兜底 effect 会补一个 ollama，因此这里先断言它被补上后的状态
    expect(screen.getByTestId("ai-model-provider-item-ollama")).not.toBeNull();

    const addSelect = screen.getByTestId("ai-model-provider-add-select") as HTMLSelectElement;
    const optionIds = Array.from(addSelect.querySelectorAll("optgroup option")).map(
      (option) => (option as HTMLOptionElement).value,
    );
    // ollama 已配置 → 不出现在可添加列表
    expect(optionIds).not.toContain("ollama");
    expect(optionIds.sort()).toEqual(
      AI_PROVIDER_PRESETS.filter((preset) => preset.id !== "ollama").map((preset) => preset.id).sort(),
    );

    const groups = Array.from(addSelect.querySelectorAll("optgroup")).map((group) => group.dataset.testid);
    expect(groups).toEqual([
      "ai-model-provider-group-local",
      "ai-model-provider-group-cn",
      "ai-model-provider-group-intl",
    ]);
  });

  it("添加后自动展开、打 source:\"preset\"、但不自动启用", () => {
    setAi([presetProfile("ollama")], "ollama");
    mount();

    fireEvent.change(screen.getByTestId("ai-model-provider-add-select"), { target: { value: "xai" } });

    const added = currentAi().profiles.find((profile) => profile.providerId === "xai")!;
    expect(added.source, "预设新增必须打 source=preset").toBe("preset");
    expect(added.providerId).toBe("xai");
    // 新增不自动启用（启用是 toggle 的职责）
    expect(currentAi().activeProfileId).toBe("ollama");
    // 自动展开新条目
    expect(screen.getByTestId("ai-model-provider-item-select-xai").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("ai-model-provider-body-xai")).not.toBeNull();
  });

  it("添加下拉在全部预设都配置完后只剩占位项", () => {
    const all = AI_PROVIDER_PRESETS.map((preset) => presetProfile(preset.id));
    setAi(all, all[0]!.id);
    mount();

    const addSelect = screen.getByTestId("ai-model-provider-add-select") as HTMLSelectElement;
    const optionIds = Array.from(addSelect.querySelectorAll("option")).map(
      (option) => (option as HTMLOptionElement).value,
    );
    expect(optionIds).toEqual([""]);
  });
});

describe("⑥ 服务商展开条目编辑的是该条目，不是当前启用条目", () => {
  it("展开未启用的 deepseek 后改 baseUrl，只改 deepseek（ollama 不动）", () => {
    setAi([presetProfile("ollama"), presetProfile("deepseek")], "ollama");
    mount();

    fireEvent.click(screen.getByTestId("ai-model-provider-item-select-deepseek"));
    expect(screen.getByTestId("ai-model-provider-body-deepseek")).not.toBeNull();

    fireEvent.change(screen.getByTestId("ai-model-base-url"), {
      target: { value: "https://deepseek-proxy.test/v1" },
    });

    const deepseek = currentAi().profiles.find((profile) => profile.id === "deepseek")!;
    const ollama = currentAi().profiles.find((profile) => profile.id === "ollama")!;
    expect(deepseek.baseUrl).toBe("https://deepseek-proxy.test/v1");
    expect(ollama.baseUrl, "启用的 ollama 必须不被改").toBe(
      findAiProviderPreset("ollama")!.baseUrl,
    );
    // 启用项也没被「切」到 deepseek
    expect(currentAi().activeProfileId).toBe("ollama");
  });

  it("展开未启用条目的模型名称/温度编辑同样落该条目", () => {
    setAi([presetProfile("ollama"), presetProfile("deepseek")], "ollama");
    mount();

    fireEvent.click(screen.getByTestId("ai-model-provider-item-select-deepseek"));
    fireEvent.change(screen.getByTestId("ai-model-name"), { target: { value: "deepseek-v4-pro" } });
    fireEvent.change(screen.getByTestId("ai-model-temperature"), { target: { value: "0.4" } });

    const deepseek = currentAi().profiles.find((profile) => profile.id === "deepseek")!;
    expect(deepseek.model).toBe("deepseek-v4-pro");
    expect(deepseek.requestPolicy.temperature).toBe(0.4);
    const ollama = currentAi().profiles.find((profile) => profile.id === "ollama")!;
    expect(ollama.model).toBe("");
  });

  it("获取模型列表作用于展开条目（非启用条目）", async () => {
    setAi([presetProfile("ollama"), presetProfile("deepseek")], "ollama");
    listModelsMock.mockResolvedValue([
      { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", contextWindowTokens: 1_000_000 },
    ]);
    mount();

    fireEvent.click(screen.getByTestId("ai-model-provider-item-select-deepseek"));
    fireEvent.click(screen.getByTestId("ai-model-fetch"));

    await waitFor(() => expect(listModelsMock).toHaveBeenCalledTimes(1));
    expect(listModelsMock).toHaveBeenCalledWith(expect.objectContaining({ id: "deepseek" }));
    await waitFor(() => expect(
      currentAi().profiles.find((profile) => profile.id === "deepseek")!.modelCatalog,
    ).toHaveLength(1));
    expect(currentAi().profiles.find((profile) => profile.id === "ollama")!.modelCatalog)
      .toHaveLength(0);
  });

  it("P5 加固：启用项 ≠ 展开项时，编辑/切展开只作用于展开项，启用项不被误改", () => {
    // 直接对应 Lead 重写后的 P5 场景：先把启用切到 ollama，展开的仍是 deepseek。
    setAi([presetProfile("ollama"), presetProfile("deepseek")], "deepseek");
    mount();

    // 初始：启用 deepseek 且它默认展开。前置条件 P5a —— 把启用切到 ollama，
    // 展开态不受影响（deepseek 仍展开）→ 此时「展开条目 ≠ 启用条目」。
    fireEvent.click(screen.getByTestId("ai-model-provider-item-toggle-ollama"));

    const deepseekSelect = screen.getByTestId("ai-model-provider-item-select-deepseek");
    expect(deepseekSelect.getAttribute("aria-expanded"), "deepseek 仍展开").toBe("true");
    expect(screen.getByTestId("ai-model-provider-item-toggle-deepseek").getAttribute("aria-pressed"))
      .toBe("false");
    expect(screen.getByTestId("ai-model-provider-item-toggle-ollama").getAttribute("aria-pressed"))
      .toBe("true");
    expect(screen.getByTestId("ai-model-provider-body-deepseek"), "展开体是 deepseek").not.toBeNull();
    expect(currentAi().activeProfileId).toBe("ollama");

    // P5b：编辑展开条目（deepseek）的 baseUrl
    const ollamaBefore = currentAi().profiles.find((profile) => profile.id === "ollama")!.baseUrl;
    fireEvent.change(screen.getByTestId("ai-model-base-url"), {
      target: { value: "https://probe-edited.test/v1" },
    });

    expect(currentAi().profiles.find((profile) => profile.id === "deepseek")!.baseUrl,
      "P5b：展开条目自己的 baseUrl 被改").toBe("https://probe-edited.test/v1");
    // P5c：当前启用条目（ollama）的 baseUrl 没被误改
    expect(currentAi().profiles.find((profile) => profile.id === "ollama")!.baseUrl,
      "P5c：启用条目不得被误改").toBe(ollamaBefore);
    expect(currentAi().activeProfileId, "启用项不变").toBe("ollama");
  });

  it("测试连接作用于展开条目", async () => {
    setAi([presetProfile("ollama"), presetProfile("deepseek")], "ollama");
    testConnectionMock.mockResolvedValue(undefined);
    mount();

    fireEvent.click(screen.getByTestId("ai-model-provider-item-select-deepseek"));
    fireEvent.click(screen.getByTestId("ai-model-test"));

    await waitFor(() => expect(testConnectionMock).toHaveBeenCalledTimes(1));
    expect(testConnectionMock).toHaveBeenCalledWith(expect.objectContaining({ id: "deepseek" }));
  });
});

describe("删除：两个页签共用同一套不变量", () => {
  it("服务商页签删除启用条目 → activeProfileId 回落 ollama 档案", async () => {
    setAi([presetProfile("deepseek"), presetProfile("ollama")], "deepseek");
    mount();

    // 删除 deepseek（当前启用）；ollama 在列表里 → 回落过去
    fireEvent.click(screen.getByTestId("ai-model-provider-item-delete-deepseek"));
    await waitFor(() => expect(currentAi().profiles.map((profile) => profile.id)).toEqual(["ollama"]));
    expect(currentAi().activeProfileId).toBe("ollama");
  });

  it("服务商页签删除唯一条目 → 现场建 Ollama 回落，绝不留悬空 id", async () => {
    setAi([presetProfile("deepseek")], "deepseek");
    mount();

    fireEvent.click(screen.getByTestId("ai-model-provider-item-delete-deepseek"));
    await waitFor(() => expect(currentAi().profiles).toHaveLength(1));
    expect(currentAi().activeProfileId).toBe("ollama");
    expect(currentAi().profiles[0]!.providerId).toBe("ollama");
    expect(currentAi().profiles.some((profile) => profile.id === currentAi().activeProfileId)).toBe(true);
  });
});

describe("自定义页签草稿：收起不丢改动、关闭不影响草稿", () => {
  it("编辑草稿后切到另一条（收起原条）→ 原条改动已写回", () => {
    setAi([
      customProfile(),
      customProfile({ id: "other", providerId: "other", credentialId: "other", name: "另一条" }),
    ], "acme");
    mount();

    fireEvent.change(screen.getByTestId("ai-model-custom-name"), { target: { value: "改名后的 Acme" } });
    expect(currentAi().profiles.find((profile) => profile.id === "acme")!.name).toBe("Acme 本地");

    fireEvent.click(screen.getByTestId("ai-model-custom-item-select-other"));
    expect(currentAi().profiles.find((profile) => profile.id === "acme")!.name).toBe("改名后的 Acme");
  });

  it("草稿校验不通过时切条目会被拒绝并提示（不静默丢改动）", () => {
    setAi([
      customProfile(),
      customProfile({ id: "other", providerId: "other", credentialId: "other", name: "另一条" }),
    ], "acme");
    mount();

    // 把模型清空 → 归一化校验失败
    fireEvent.change(screen.getByTestId("ai-model-custom-model"), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("ai-model-custom-item-select-other"));

    expect(screen.getByTestId("ai-model-custom-notice").textContent)
      .toBe("settings.ai.model.error.unsavedDraft");
    // 仍停在 acme 的展开态与草稿
    expect(screen.getByTestId("ai-model-custom-item-select-acme").getAttribute("aria-expanded")).toBe("true");
    expect((screen.getByTestId("ai-model-custom-model") as HTMLInputElement).value).toBe("");
    expect(currentAi().profiles.find((profile) => profile.id === "acme")!.model, "未校验通过不得覆盖原档案")
      .toBe("model-a");
  });

  it("关闭条目不影响正在编辑的草稿内容", () => {
    setAi([customProfile(), presetProfile("ollama")], "acme");
    mount();

    fireEvent.change(screen.getByTestId("ai-model-custom-name"), { target: { value: "编辑中" } });
    fireEvent.click(screen.getByTestId("ai-model-custom-item-toggle-acme"));

    expect(currentAi().activeProfileId).toBe("");
    // 草稿仍在编辑区且保留用户输入（关闭 ≠ 丢弃）
    expect(screen.getByTestId("ai-model-custom-body-acme")).not.toBeNull();
    expect((screen.getByTestId("ai-model-custom-name") as HTMLInputElement).value).toBe("编辑中");
  });
});
