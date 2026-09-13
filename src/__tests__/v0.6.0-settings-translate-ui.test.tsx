/**
 * v0.6.0：设置界面「AI 翻译」分组测试
 *
 * 覆盖：
 * 1. applyProviderPreset 纯函数：预设切换自动填充 / custom 保留当前值 / 未知预设
 * 2. SettingsDialog 渲染：翻译分组字段齐全（Provider/Key/baseUrl/model/语言/语体/结果模式/Prompt）
 * 3. 交互：Provider 切换写 store、Key 保存调 setKey、测试连接状态流转、配置实时生效
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

// ─── mocks（必须在 import 组件之前） ───────────────────────
const { mockSetKey, mockHasKey, mockTestConnection, mockListModels } = vi.hoisted(() => ({
  mockSetKey: vi.fn(),
  mockHasKey: vi.fn(),
  mockTestConnection: vi.fn(),
  mockListModels: vi.fn(),
}));

vi.mock("../services/translateService", () => ({
  translateService: {
    setKey: mockSetKey,
    hasKey: mockHasKey,
    testConnection: mockTestConnection,
    listModels: mockListModels,
  },
}));

import { SettingsDialog, TRANSLATE_PROVIDERS, applyProviderPreset } from "../components/dialogs/SettingsDialog";
import { useSettingsStore, DEFAULT_TRANSLATE_SETTINGS, type TranslateSettings } from "../stores/useSettingsStore";

describe("v0.6.0 applyProviderPreset（纯函数）", () => {
  const current: TranslateSettings = { ...DEFAULT_TRANSLATE_SETTINGS };

  it("包含 22 个预设（deepseek 默认 + 国内主流厂商 + 国际厂商 + custom）", () => {
    expect(Object.keys(TRANSLATE_PROVIDERS).sort()).toEqual([
      "alibaba", "antling", "baichuan", "baidu", "claude", "custom", "deepseek",
      "doubao", "gemini", "hunyuan", "kimi", "kimicode", "lingyi", "minimax",
      "modelscope", "openai", "sensenova", "siliconflow", "stepfun",
      "volcengine", "xunfei", "zhipu",
    ]);
  });

  it("已知预设：自动填充 baseUrl/默认模型（models[0]）并更新 preset", () => {
    const patch = applyProviderPreset("kimi", current);
    expect(patch).toEqual({
      translateProviderPreset: "kimi",
      translateBaseUrl: "https://api.moonshot.cn/v1",
      translateModel: "kimi-k3",
      // v0.7.3：kimi/kimicode 系仅允许 temperature=1（否则 400），切预设默认置 1
      translateTemperature: 1,
    });
  });

  it("deepseek 预设：默认模型角色为 deepseek-v4-flash", () => {
    const patch = applyProviderPreset("deepseek", current);
    expect(patch.translateModel).toBe("deepseek-v4-flash");
    // 模型角色列表包含 pro 与 flash 两档
    expect(TRANSLATE_PROVIDERS.deepseek.models).toEqual(
      expect.arrayContaining(["deepseek-v4-flash", "deepseek-v4-pro"])
    );
  });

  it("custom：只更新 preset，保留当前 baseUrl/model", () => {
    const patch = applyProviderPreset("custom", {
      ...current,
      translateBaseUrl: "https://my-llm.example.com/v1",
      translateModel: "my-model",
    });
    expect(patch).toEqual({ translateProviderPreset: "custom" });
  });

  it("未知预设：返回空对象（不修改任何配置）", () => {
    expect(applyProviderPreset("unknown", current)).toEqual({});
  });

  it("每个非 custom 预设都带 baseUrl 和至少一个模型角色", () => {
    for (const [name, p] of Object.entries(TRANSLATE_PROVIDERS)) {
      if (name === "custom") continue;
      expect(p.baseUrl).toMatch(/^https:\/\//);
      expect(p.models.length).toBeGreaterThan(0);
      expect(p.models[0].length).toBeGreaterThan(0);
    }
  });
});

describe("v0.6.0 SettingsDialog AI 翻译分组", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.getState().setTranslateConfig({ ...DEFAULT_TRANSLATE_SETTINGS });
    mockSetKey.mockReset().mockResolvedValue(undefined);
    mockHasKey.mockReset().mockResolvedValue(false);
    mockTestConnection.mockReset().mockResolvedValue(undefined);
    mockListModels.mockReset().mockResolvedValue([]);
  });

  afterEach(() => cleanup());

  it("渲染全部翻译配置字段（默认值来自 store）", async () => {
    render(<SettingsDialog onClose={() => {}} />);
    // 分组标题（getByText 找不到会抛错，即存在性断言）
    // v0.7.0：API 配置从"AI 翻译"分组升级为全局"AI"分组（翻译/续写/润色/摘要共用）
    expect(screen.getByText("AI").tagName).toBe("H3");
    // Provider 默认 deepseek
    const provider = screen.getByTestId("translate-provider") as HTMLSelectElement;
    expect(provider.value).toBe("deepseek");
    // baseUrl/model 默认值
    expect((screen.getByTestId("translate-base-url") as HTMLInputElement).value).toBe(
      DEFAULT_TRANSLATE_SETTINGS.translateBaseUrl
    );
    expect((screen.getByTestId("translate-model") as HTMLInputElement).value).toBe(
      DEFAULT_TRANSLATE_SETTINGS.translateModel
    );
    // 目标语言/语体/结果模式默认
    expect((screen.getByTestId("translate-target-lang") as HTMLSelectElement).value).toBe("auto");
    expect((screen.getByTestId("translate-tone") as HTMLSelectElement).value).toBe("正式");
    expect((screen.getByTestId("translate-result-mode") as HTMLSelectElement).value).toBe("bubble");
    // Key 状态异步探测为"未配置"
    await waitFor(() => {
      expect(screen.getByTestId("translate-key-status").textContent).toContain("未配置");
    });
  });

  it("Provider 切换：自动填充 baseUrl/默认模型并实时写 store", () => {
    render(<SettingsDialog onClose={() => {}} />);
    fireEvent.change(screen.getByTestId("translate-provider"), { target: { value: "kimi" } });
    // store 实时更新（kimi 预设默认模型 kimi-k3）
    const cfg = useSettingsStore.getState().translate;
    expect(cfg.translateProviderPreset).toBe("kimi");
    expect(cfg.translateBaseUrl).toBe("https://api.moonshot.cn/v1");
    expect(cfg.translateModel).toBe("kimi-k3");
    // UI 同步
    expect((screen.getByTestId("translate-base-url") as HTMLInputElement).value).toBe(
      "https://api.moonshot.cn/v1"
    );
  });

  it("v0.6.3 S-4：http:// 地址显示明文传输警告，https:// 不显示", () => {
    render(<SettingsDialog onClose={() => {}} />);
    // 默认 https 地址：无警告
    expect(screen.queryByTestId("translate-base-url-warning")).toBeNull();
    // 改为 http://：警告出现
    fireEvent.change(screen.getByTestId("translate-base-url"), {
      target: { value: "http://192.168.1.10:8080/v1" },
    });
    expect(screen.getByTestId("translate-base-url-warning").textContent).toContain("http://");
    // 改回 https://：警告消失
    fireEvent.change(screen.getByTestId("translate-base-url"), {
      target: { value: "https://api.deepseek.com/v1" },
    });
    expect(screen.queryByTestId("translate-base-url-warning")).toBeNull();
  });

  it("模型角色 datalist：渲染当前供应商的推荐模型列表", () => {
    render(<SettingsDialog onClose={() => {}} />);
    // 默认 deepseek → 2 个模型角色选项（v0.7.2 P0 刷新后的列表）
    const datalist = screen.getByTestId("translate-model-options") as HTMLDataListElement;
    const options = Array.from(datalist.querySelectorAll("option")).map((o) => o.value);
    expect(options).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
    // 切换供应商后 datalist 跟随更新
    fireEvent.change(screen.getByTestId("translate-provider"), { target: { value: "gemini" } });
    const optionsAfter = Array.from(
      (screen.getByTestId("translate-model-options") as HTMLDataListElement).querySelectorAll("option")
    ).map((o) => o.value);
    expect(optionsAfter).toEqual(TRANSLATE_PROVIDERS.gemini.models);
  });

  it("总开关：切换为关闭实时写 store", () => {
    render(<SettingsDialog onClose={() => {}} />);
    // v0.6.2 问题1：默认关闭
    expect((screen.getByTestId("translate-enabled") as HTMLSelectElement).value).toBe("off");
    // 开启
    fireEvent.change(screen.getByTestId("translate-enabled"), { target: { value: "on" } });
    expect(useSettingsStore.getState().translate.translateEnabled).toBe(true);
    // 再关闭
    fireEvent.change(screen.getByTestId("translate-enabled"), { target: { value: "off" } });
    expect(useSettingsStore.getState().translate.translateEnabled).toBe(false);
  });

  it("总开关关闭时：其余翻译配置置灰（disabled class）", () => {
    render(<SettingsDialog onClose={() => {}} />);
    fireEvent.change(screen.getByTestId("translate-enabled"), { target: { value: "off" } });
    const section = screen.getByTestId("translate-section");
    const fields = section.querySelector(".translate-config-fields");
    expect(fields?.className).toContain("disabled");
  });

  it("API Key 保存：调 setKey（带当前 provider）后清空输入并显示已配置", async () => {
    mockHasKey.mockResolvedValue(false);
    render(<SettingsDialog onClose={() => {}} />);
    const input = screen.getByTestId("translate-api-key-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-test-123" } });
    fireEvent.click(screen.getByTestId("translate-api-key-save"));
    await waitFor(() => {
      // v0.7.2 P1：默认 provider 为 deepseek，Key 写入其独立条目
      expect(mockSetKey).toHaveBeenCalledWith("deepseek", "sk-test-123");
    });
    // 输入清空（不回显）+ 状态变为已配置
    await waitFor(() => {
      expect(input.value).toBe("");
      expect(screen.getByTestId("translate-key-status").textContent).toContain("已配置");
    });
  });

  it("空 Key 时保存按钮禁用", () => {
    render(<SettingsDialog onClose={() => {}} />);
    expect((screen.getByTestId("translate-api-key-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("测试连接成功：显示连接成功状态", async () => {
    mockTestConnection.mockResolvedValue(undefined);
    render(<SettingsDialog onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("translate-test-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("translate-test-status").textContent).toContain("连接成功");
    });
    // v0.7.2 P1：测试连接同样带 provider
    expect(mockTestConnection).toHaveBeenCalledWith(
      "deepseek",
      DEFAULT_TRANSLATE_SETTINGS.translateBaseUrl,
      DEFAULT_TRANSLATE_SETTINGS.translateModel
    );
  });

  it("测试连接失败：显示失败状态与错误详情", async () => {
    mockTestConnection.mockRejectedValue(new Error("AUTH: invalid key"));
    render(<SettingsDialog onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("translate-test-btn"));
    await waitFor(() => {
      const status = screen.getByTestId("translate-test-status").textContent ?? "";
      expect(status).toContain("连接失败");
      expect(status).toContain("invalid key");
    });
  });

  it("v0.7.2 修复回归：获取模型列表成功后浮层显示全部模型，点击填入并关闭（datalist 文本过滤 bug）", async () => {
    // 复现条件：输入框已有默认模型文本，datalist 原生行为会按其过滤导致只显示 1 项
    mockListModels.mockResolvedValue(["deepseek-v4-flash", "deepseek-v4-pro"]);
    render(<SettingsDialog onClose={() => {}} />);
    const modelInput = screen.getByTestId("translate-model") as HTMLInputElement;
    expect(modelInput.value).toBe("deepseek-v4-flash"); // 前置：输入框已有文本
    fireEvent.click(screen.getByTestId("translate-fetch-models"));
    // 候选浮层展示全量 2 项（不因输入框文本被过滤）
    await waitFor(() => {
      expect(screen.getAllByTestId("translate-model-menu-item").length).toBe(2);
    });
    expect(screen.getByTestId("translate-fetch-status").textContent).toContain("2");
    // 点击第 2 项 → 填入输入框，浮层关闭
    fireEvent.click(screen.getAllByTestId("translate-model-menu-item")[1]);
    expect(modelInput.value).toBe("deepseek-v4-pro");
    expect(screen.queryByTestId("translate-model-menu")).toBeNull();
    expect(useSettingsStore.getState().translate.translateModel).toBe("deepseek-v4-pro");
  });

  it("获取模型列表失败：回退静态预设列表并显示原因", async () => {
    mockListModels.mockRejectedValue(new Error("NETWORK: timeout"));
    render(<SettingsDialog onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("translate-fetch-models"));
    await waitFor(() => {
      expect(screen.getByTestId("translate-fetch-status").textContent).toContain("获取失败");
    });
    // 不出现候选浮层，datalist 回退静态预设
    expect(screen.queryByTestId("translate-model-menu")).toBeNull();
    const options = screen.getByTestId("translate-model-options").children;
    expect(Array.from(options).map((o) => o.getAttribute("value"))).toEqual(
      TRANSLATE_PROVIDERS.deepseek.models
    );
  });

  it("结果模式切换实时写 store", () => {
    render(<SettingsDialog onClose={() => {}} />);
    fireEvent.change(screen.getByTestId("translate-result-mode"), { target: { value: "bilingual" } });
    expect(useSettingsStore.getState().translate.translateResultMode).toBe("bilingual");
  });

  it("目标语言切换实时写 store", () => {
    render(<SettingsDialog onClose={() => {}} />);
    fireEvent.change(screen.getByTestId("translate-target-lang"), { target: { value: "English" } });
    expect(useSettingsStore.getState().translate.translateTargetLang).toBe("English");
  });

  it("自定义 Prompt 输入实时写 store", () => {
    render(<SettingsDialog onClose={() => {}} />);
    fireEvent.change(screen.getByTestId("translate-custom-prompt"), {
      target: { value: "翻译为{target_lang}，语体{tone}" },
    });
    expect(useSettingsStore.getState().translate.translateCustomPrompt).toBe("翻译为{target_lang}，语体{tone}");
  });
});
