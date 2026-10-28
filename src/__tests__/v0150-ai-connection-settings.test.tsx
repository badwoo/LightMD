/**
 * @vitest-environment jsdom
 *
 * v0.15.0 R3c：AiConnectionSettings 组件行为测试。
 *
 * 覆盖（对应任务卡验收项）：
 * 1. 空态引导：无档案时给预设入口，点击后建出档案并写 store；
 * 2. 预设语义：Ollama 预填本地端点 + authMode none + **模型留空**；火山两个端点各自正确；
 * 3. 档案管理：新增/复制（换 credentialId）/删除（修正默认）/改名/设为默认/排序；
 * 4. 字段：协议、baseUrl、model、token 预算、tokenField、温度可空、推理档位可空、
 *    includeStreamUsage、systemPrompt；
 * 5. API Key：**只有设置/清除入口，绝不回显明文**；Ollama（none）不显示 Key 区；
 *    未提供 clear 实现时清除按钮禁用并说明；
 * 6. 校验：机器码 → 中英 key（这里断言 key 渲染与错误列表存在，文案由 locales 决定）。
 *
 * 全程用内存版 credentialStore：不接触系统凭据库，也不写任何持久化存储。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

// i18n mock 必须在组件 import 之前：把 key 原样返回，测试即可断言"渲染了哪个 key"，
// 不依赖 locales 里是否已加词条（文案由 Lead 统一加入）。
// 带 params 时把参数附在 key 后面（`key[name=值]`），以便断言参数确实被传进来了 ——
// 真实 locales 的文案里含 `{name}` 占位符，mock 不模拟替换、只暴露参数。
vi.mock("../i18n", () => ({
  useT: () => (key: string, params?: Record<string, string | number>) => {
    if (!params) return key;
    const args = Object.entries(params)
      .map(([name, value]) => `${name}=${String(value)}`)
      .join(",");
    return `${key}[${args}]`;
  },
}));

import {
  AiConnectionSettings,
} from "../components/settings/AiConnectionSettings";
import { createMemoryCredentialStore, type AiCredentialStore } from "../components/settings/aiCredentialStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { createBlankProfile } from "../components/settings/aiProfileOps";
import type { AiConnectionProfile, AiSettings } from "../services/aiProfiles";

/** 把 store 的 ai 段置为指定配置（每次测试开头调用） */
function setAi(profiles: AiConnectionProfile[], activeProfileId?: string) {
  const ai: AiSettings = {
    profiles,
    activeProfileId: activeProfileId ?? profiles[0]?.id ?? "",
    instructions: [],
  };
  useSettingsStore.setState({ ai });
  return ai;
}

/** 当前 store 里的 ai 配置 */
function ai(): AiSettings {
  return useSettingsStore.getState().ai;
}

function mount(store?: AiCredentialStore) {
  return render(<AiConnectionSettings credentialStore={store ?? createMemoryCredentialStore()} />);
}

beforeEach(() => {
  cleanup();
  setAi([]);
});

afterEach(() => {
  cleanup();
});

describe("空态引导", () => {
  it("无档案时显示空态与预设入口（不显示编辑区）", () => {
    mount();
    expect(screen.getByTestId("ai-empty-state")).toBeTruthy();
    expect(screen.queryByTestId("ai-profile-name")).toBeNull();
    for (const preset of ["blank", "ollama", "volc-anthropic", "volc-openai"]) {
      expect(screen.getByTestId(`ai-empty-add-${preset}`), preset).toBeTruthy();
    }
  });

  it("空态点 Ollama → 建出档案并写进 store，且 authMode=none / 模型留空", () => {
    mount();
    fireEvent.click(screen.getByTestId("ai-empty-add-ollama"));

    const state = ai();
    expect(state.profiles).toHaveLength(1);
    const profile = state.profiles[0]!;
    expect(profile.authMode).toBe("none");
    expect(profile.baseUrl).toBe("http://127.0.0.1:11434/v1");
    // 【核心】预设不硬编码模型名
    expect(profile.model).toBe("");
    expect(profile.credentialId).toBe(profile.id);
    // 新建即成为默认
    expect(state.activeProfileId).toBe(profile.id);
  });

  it("空态点火山 Anthropic → /api/plan + anthropic-messages", () => {
    mount();
    fireEvent.click(screen.getByTestId("ai-empty-add-volc-anthropic"));
    const profile = ai().profiles[0]!;
    expect(profile.baseUrl).toBe("https://ark.cn-beijing.volces.com/api/plan");
    expect(profile.protocol).toBe("anthropic-messages");
    expect(profile.model).toBe("");
  });

  it("空态点火山 OpenAI → /api/plan/v3 + openai-chat", () => {
    mount();
    fireEvent.click(screen.getByTestId("ai-empty-add-volc-openai"));
    const profile = ai().profiles[0]!;
    expect(profile.baseUrl).toBe("https://ark.cn-beijing.volces.com/api/plan/v3");
    expect(profile.protocol).toBe("openai-chat");
  });
});

describe("档案列表与编辑区", () => {
  it("有档案时渲染列表项，默认档案带标记", () => {
    setAi([createBlankProfile("档案甲", "id-a"), createBlankProfile("档案乙", "id-b")], "id-a");
    mount();
    expect(screen.getByTestId("ai-profile-item-id-a")).toBeTruthy();
    expect(screen.getByTestId("ai-profile-item-id-b")).toBeTruthy();
    expect(screen.getByTestId("ai-profile-active-badge")).toBeTruthy();
  });

  it("点列表项切换编辑对象（编辑区字段随之变化）", () => {
    setAi([createBlankProfile("档案甲", "id-a"), createBlankProfile("档案乙", "id-b")], "id-a");
    mount();
    const nameInput = screen.getByTestId("ai-profile-name") as HTMLInputElement;
    expect(nameInput.value).toBe("档案甲");

    fireEvent.click(screen.getByTestId("ai-profile-item-id-b"));
    expect((screen.getByTestId("ai-profile-name") as HTMLInputElement).value).toBe("档案乙");
  });

  it("改名字段写回 store，且不改 id/credentialId", () => {
    setAi([createBlankProfile("旧名", "id-a")]);
    mount();
    fireEvent.change(screen.getByTestId("ai-profile-name"), { target: { value: "新名" } });
    const profile = ai().profiles[0]!;
    expect(profile.name).toBe("新名");
    expect(profile.id).toBe("id-a");
    expect(profile.credentialId).toBe("id-a");
  });

  it("复制档案：追加新档案并换新 credentialId（共用 Key 槽位会串凭据）", () => {
    setAi([createBlankProfile("甲", "id-a")]);
    mount();
    fireEvent.click(screen.getByTestId("ai-profile-duplicate"));

    const profiles = ai().profiles;
    expect(profiles).toHaveLength(2);
    const copied = profiles[1]!;
    expect(copied.id).not.toBe("id-a");
    expect(copied.credentialId).toBe(copied.id);
    // 名字走 copyName 文案且带原档案名参数
    expect(copied.name).toContain("settings.ai.profile.copyName");
    expect(copied.name).toContain("name=甲");
  });

  it("删除当前档案：列表减少，默认档案被修正", () => {
    setAi([createBlankProfile("甲", "id-a"), createBlankProfile("乙", "id-b")], "id-a");
    mount();
    fireEvent.click(screen.getByTestId("ai-profile-remove"));
    const state = ai();
    expect(state.profiles.map((p) => p.id)).toEqual(["id-b"]);
    expect(state.activeProfileId).toBe("id-b");
  });

  it("删除到空列表：回到空态引导", () => {
    setAi([createBlankProfile("唯一", "id-only")]);
    mount();
    fireEvent.click(screen.getByTestId("ai-profile-remove"));
    expect(ai().profiles).toEqual([]);
    expect(screen.getByTestId("ai-empty-state")).toBeTruthy();
  });

  it("设为默认：写 activeProfileId", () => {
    setAi([createBlankProfile("甲", "id-a"), createBlankProfile("乙", "id-b")], "id-a");
    mount();
    fireEvent.click(screen.getByTestId("ai-profile-item-id-b"));
    fireEvent.click(screen.getByTestId("ai-profile-set-active"));
    expect(ai().activeProfileId).toBe("id-b");
  });

  it("排序：下移改变列表顺序但不改默认档案", () => {
    setAi([createBlankProfile("甲", "id-a"), createBlankProfile("乙", "id-b")], "id-a");
    mount();
    fireEvent.click(screen.getByTestId("ai-profile-move-down"));
    expect(ai().profiles.map((p) => p.id)).toEqual(["id-b", "id-a"]);
    expect(ai().activeProfileId).toBe("id-a");
  });

  it("从工具条预设下拉新增档案", () => {
    setAi([createBlankProfile("甲", "id-a")]);
    mount();
    fireEvent.change(screen.getByTestId("ai-add-profile-preset"), { target: { value: "ollama" } });
    expect(ai().profiles).toHaveLength(2);
    expect(ai().profiles[1]!.authMode).toBe("none");
  });
});

describe("档案字段：协议 / 端点 / 预算 / 请求策略", () => {
  function base() {
    const profile = createBlankProfile("甲", "id-a");
    profile.baseUrl = "https://api.example.com/v1";
    profile.model = "user-model";
    setAi([profile]);
    return profile;
  }

  it("切换协议写入 store", () => {
    base();
    mount();
    fireEvent.change(screen.getByTestId("ai-profile-protocol"), { target: { value: "anthropic-messages" } });
    expect(ai().profiles[0]!.protocol).toBe("anthropic-messages");
  });

  it("baseUrl / model 可编辑", () => {
    base();
    mount();
    fireEvent.change(screen.getByTestId("ai-profile-base-url"), { target: { value: "https://new.example/v1" } });
    fireEvent.change(screen.getByTestId("ai-profile-model"), { target: { value: "my-model" } });
    expect(ai().profiles[0]!.baseUrl).toBe("https://new.example/v1");
    expect(ai().profiles[0]!.model).toBe("my-model");
  });

  it("token 预算：正整数写入 store", () => {
    base();
    mount();
    fireEvent.change(screen.getByTestId("ai-profile-context"), { target: { value: "65536" } });
    fireEvent.change(screen.getByTestId("ai-profile-max-output"), { target: { value: "8192" } });
    expect(ai().profiles[0]!.contextWindowTokens).toBe(65536);
    expect(ai().profiles[0]!.maxOutputTokens).toBe(8192);
  });

  it("token 预算：中间态（空串）不落库，保持上次有效值", () => {
    base();
    mount();
    const before = ai().profiles[0]!.contextWindowTokens;
    fireEvent.change(screen.getByTestId("ai-profile-context"), { target: { value: "" } });
    expect(ai().profiles[0]!.contextWindowTokens).toBe(before);
  });

  it("maxOutput >= contextWindow 时给出预算警告文案", () => {
    const profile = createBlankProfile("甲", "id-a");
    profile.contextWindowTokens = 1000;
    profile.maxOutputTokens = 1000;
    setAi([profile]);
    mount();
    expect(screen.getByTestId("ai-budget-hint").textContent).toBe("settings.ai.field.budgetInvalid");
  });

  it("tokenField 切换写入 store", () => {
    base();
    mount();
    fireEvent.change(screen.getByTestId("ai-profile-token-field"), { target: { value: "max_completion_tokens" } });
    expect(ai().profiles[0]!.requestPolicy.tokenField).toBe("max_completion_tokens");
  });

  it("【核心】温度留空 = undefined（请求里不发送），不是 0", () => {
    base();
    mount();
    const input = screen.getByTestId("ai-profile-temperature") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(ai().profiles[0]!.requestPolicy.temperature).toBeUndefined();

    fireEvent.change(input, { target: { value: "0.7" } });
    expect(ai().profiles[0]!.requestPolicy.temperature).toBe(0.7);

    // 再清空 → 回到 undefined（不是 0）
    fireEvent.change(input, { target: { value: "" } });
    expect(ai().profiles[0]!.requestPolicy.temperature).toBeUndefined();
  });

  it("温度越界输入不写库（保持上次有效值）", () => {
    base();
    mount();
    fireEvent.change(screen.getByTestId("ai-profile-temperature"), { target: { value: "0.5" } });
    fireEvent.change(screen.getByTestId("ai-profile-temperature"), { target: { value: "5" } });
    expect(ai().profiles[0]!.requestPolicy.temperature).toBe(0.5);
  });

  it("【核心】推理档位留空 = undefined（不发送）", () => {
    base();
    mount();
    const select = screen.getByTestId("ai-profile-reasoning") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(ai().profiles[0]!.requestPolicy.reasoningEffort).toBeUndefined();

    fireEvent.change(select, { target: { value: "low" } });
    expect(ai().profiles[0]!.requestPolicy.reasoningEffort).toBe("low");

    fireEvent.change(select, { target: { value: "" } });
    expect(ai().profiles[0]!.requestPolicy.reasoningEffort).toBeUndefined();
  });

  it("anthropic 协议下推理档位不可选（该协议不适用，不做臆测映射）", () => {
    const profile = createBlankProfile("甲", "id-a");
    profile.protocol = "anthropic-messages";
    setAi([profile]);
    mount();
    expect((screen.getByTestId("ai-profile-reasoning") as HTMLSelectElement).disabled).toBe(true);
  });

  it("includeStreamUsage 可切换", () => {
    base();
    mount();
    fireEvent.click(screen.getByTestId("ai-profile-include-usage"));
    expect(ai().profiles[0]!.requestPolicy.includeStreamUsage).toBe(false);
  });

  it("systemPrompt 可空：填写写入，清空回到 undefined", () => {
    base();
    mount();
    fireEvent.change(screen.getByTestId("ai-profile-system-prompt"), { target: { value: "你是助手" } });
    expect(ai().profiles[0]!.systemPrompt).toBe("你是助手");

    fireEvent.change(screen.getByTestId("ai-profile-system-prompt"), { target: { value: "" } });
    expect(ai().profiles[0]!.systemPrompt).toBeUndefined();
  });
});

describe("API Key：只设置/清除，绝不回显明文", () => {
  function keyed(authMode: AiConnectionProfile["authMode"] = "required") {
    const profile = createBlankProfile("甲", "id-a");
    profile.baseUrl = "https://api.example.com/v1";
    profile.model = "m";
    profile.authMode = authMode;
    setAi([profile]);
    return profile;
  }

  it("已配置 Key 时状态显示 configured，且输入框始终为空（不回显明文）", async () => {
    keyed();
    const store = createMemoryCredentialStore({ "id-a": "sk-secret" });
    mount(store);

    await waitFor(() => {
      expect(screen.getByTestId("ai-key-status").textContent).toBe("settings.ai.apiKey.statusConfigured");
    });
    // 【核心】页面任何地方都不出现明文
    expect(document.body.textContent).not.toContain("sk-secret");
    const input = screen.getByTestId("ai-profile-key-input") as HTMLInputElement;
    expect(input.value).toBe("");
    // 密码型输入框
    expect(input.type).toBe("password");
  });

  it("保存 Key：调用 store.save，成功后清空输入框", async () => {
    keyed();
    const store = createMemoryCredentialStore();
    const save = vi.spyOn(store, "save");
    mount(store);

    fireEvent.change(screen.getByTestId("ai-profile-key-input"), { target: { value: "sk-new" } });
    fireEvent.click(screen.getByTestId("ai-profile-key-save"));

    await waitFor(() => {
      expect(save).toHaveBeenCalledWith("id-a", "sk-new");
    });
    await waitFor(() => {
      expect((screen.getByTestId("ai-profile-key-input") as HTMLInputElement).value).toBe("");
    });
    expect(store.stored.get("id-a")).toBe("sk-new");
    // 提示"已保存"
    expect(screen.getByTestId("ai-key-message").textContent).toBe("settings.ai.apiKey.saved");
  });

  it("保存失败时显示错误文案，输入框保留（可重试）", async () => {
    keyed();
    const store: AiCredentialStore = {
      has: async () => false,
      save: async () => {
        throw new Error("AUTH|凭据管理器不可用");
      },
    };
    mount(store);

    fireEvent.change(screen.getByTestId("ai-profile-key-input"), { target: { value: "sk-bad" } });
    fireEvent.click(screen.getByTestId("ai-profile-key-save"));

    await waitFor(() => {
      expect(screen.getByTestId("ai-key-message").textContent).toBe("settings.ai.apiKey.error.auth");
    });
    expect((screen.getByTestId("ai-profile-key-input") as HTMLInputElement).value).toBe("sk-bad");
  });

  it("空 Key 时保存按钮禁用", () => {
    keyed();
    mount();
    const button = screen.getByTestId("ai-profile-key-save") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("ai-profile-key-input"), { target: { value: "   " } });
    expect(button.disabled).toBe(true);
  });

  it("store 未实现 clear 时：清除按钮禁用并给出说明（不假装能清除）", async () => {
    keyed();
    const store = createMemoryCredentialStore();
    // 显式构造一个没有 clear 的实现
    const noClear: AiCredentialStore = { has: store.has, save: store.save };
    mount(noClear);

    const clearButton = screen.getByTestId("ai-profile-key-clear") as HTMLButtonElement;
    expect(clearButton.disabled).toBe(true);
    expect(screen.getByTestId("ai-key-clear-unsupported")).toBeTruthy();
  });

  it("store 实现 clear 时：已配置状态下可清除，清除后状态变未配置", async () => {
    keyed();
    const store = createMemoryCredentialStore({ "id-a": "sk-secret" });
    mount(store);

    await waitFor(() => {
      expect((screen.getByTestId("ai-profile-key-clear") as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByTestId("ai-profile-key-clear"));

    await waitFor(() => {
      expect(screen.getByTestId("ai-key-status").textContent).toBe("settings.ai.apiKey.statusNotConfigured");
    });
    expect(store.stored.has("id-a")).toBe(false);
    expect(screen.getByTestId("ai-key-message").textContent).toBe("settings.ai.apiKey.cleared");
  });

  it("【核心】authMode=none（Ollama）不显示 Key 输入区，也不探测凭据", async () => {
    keyed("none");
    const store = createMemoryCredentialStore();
    const has = vi.spyOn(store, "has");
    mount(store);

    expect(screen.queryByTestId("ai-profile-key-input")).toBeNull();
    expect(screen.getByTestId("ai-key-not-needed")).toBeTruthy();
    // 不调用 has（Ollama 无需 Key）
    expect(has).not.toHaveBeenCalled();
  });

  it("切换档案时清空上一条的 Key 输入（避免串档案）", async () => {
    const a = createBlankProfile("甲", "id-a");
    a.baseUrl = "u";
    a.model = "m";
    const b = createBlankProfile("乙", "id-b");
    b.baseUrl = "u2";
    b.model = "m2";
    setAi([a, b], "id-a");
    mount();

    fireEvent.change(screen.getByTestId("ai-profile-key-input"), { target: { value: "typing" } });
    expect((screen.getByTestId("ai-profile-key-input") as HTMLInputElement).value).toBe("typing");

    fireEvent.click(screen.getByTestId("ai-profile-item-id-b"));
    await waitFor(() => {
      expect((screen.getByTestId("ai-profile-key-input") as HTMLInputElement).value).toBe("");
    });
  });
});

describe("校验提示：机器码映射成文案 key", () => {
  it("空 baseUrl/model 时报出对应错误 key（不显示裸机器码）", () => {
    setAi([createBlankProfile("甲", "id-a")]);
    mount();
    const list = screen.getByTestId("ai-error-list");
    expect(list.textContent).toContain("settings.ai.error.baseUrlRequired");
    expect(list.textContent).toContain("settings.ai.error.modelRequired");
    // 裸机器码不得出现在界面上
    expect(list.textContent).not.toContain("profile.baseUrl.required");
  });

  it("字段补全后错误列表消失", () => {
    const profile = createBlankProfile("甲", "id-a");
    profile.baseUrl = "https://api.example.com/v1";
    profile.model = "m";
    setAi([profile]);
    mount();
    expect(screen.queryByTestId("ai-error-list")).toBeNull();
  });

  it("credentialId 不一致（数据被外部改坏）时报出专用错误，不静默吞掉", () => {
    const profile = createBlankProfile("甲", "id-a");
    profile.baseUrl = "u";
    profile.model = "m";
    profile.credentialId = "wrong";
    setAi([profile]);
    mount();
    expect(screen.getByTestId("ai-error-list").textContent).toContain("settings.ai.error.credentialIdMismatch");
  });
});
