/**
 * v0.7.2：模型配置 UI 测试（SettingsDialog）
 *
 * 覆盖：
 * 1. 获取模型列表：成功填充动态 datalist / 失败回退静态预设列表并提示 / 空列表回退
 * 2. 切换厂商后动态列表失效（回退静态）+ Key 状态按厂商重新探测
 * 3. kimi 海外端点提示：仅 kimi 预设显示
 * 4. 模型候选浮层：聚焦展开全量列表（修复 datalist 按输入框文本过滤）、失焦关闭、点击填入
 * 5. 新增厂商配置（kimicode/antling/baidu 等 2026-09 官方文档核实的端点与模型 ID）
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";

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

import { SettingsDialog, TRANSLATE_PROVIDERS } from "../components/dialogs/SettingsDialog";
import { useSettingsStore, DEFAULT_TRANSLATE_SETTINGS } from "../stores/useSettingsStore";

/** 读取当前 datalist 的选项值 */
function datalistOptions(): string[] {
  return Array.from(
    (screen.getByTestId("translate-model-options") as HTMLDataListElement).querySelectorAll("option")
  ).map((o) => o.value);
}

describe("v0.7.2 获取模型列表（动态 datalist）", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.getState().setTranslateConfig({ ...DEFAULT_TRANSLATE_SETTINGS });
    mockSetKey.mockReset().mockResolvedValue(undefined);
    mockHasKey.mockReset().mockResolvedValue(false);
    mockTestConnection.mockReset().mockResolvedValue(undefined);
    mockListModels.mockReset().mockResolvedValue([]);
  });

  afterEach(() => cleanup());

  it("拉取成功：动态列表替换 datalist 并显示数量", async () => {
    mockListModels.mockResolvedValue(["glm-5.3", "glm-5.3-flash", "glm-4.7"]);
    render(<SettingsDialog onClose={() => {}} />);
    // 初始为静态预设列表
    expect(datalistOptions()).toEqual(TRANSLATE_PROVIDERS.deepseek.models);
    fireEvent.click(screen.getByTestId("translate-fetch-models"));
    // 参数：当前 provider + baseUrl
    await waitFor(() => {
      expect(mockListModels).toHaveBeenCalledWith(
        "deepseek",
        "https://api.deepseek.com/v1"
      );
    });
    await waitFor(() => {
      expect(datalistOptions()).toEqual(["glm-5.3", "glm-5.3-flash", "glm-4.7"]);
    });
    expect(screen.getByTestId("translate-fetch-status").textContent).toContain("3");
  });

  it("拉取失败：回退静态预设列表并显示失败提示", async () => {
    mockListModels.mockRejectedValue(new Error("PROVIDER: 404: not found"));
    render(<SettingsDialog onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("translate-fetch-models"));
    await waitFor(() => {
      expect(screen.getByTestId("translate-fetch-status").textContent).toContain("获取失败");
    });
    // datalist 保持静态预设列表（回退）
    expect(datalistOptions()).toEqual(TRANSLATE_PROVIDERS.deepseek.models);
  });

  it("接口返回空列表：视为不支持，回退静态预设列表", async () => {
    mockListModels.mockResolvedValue([]);
    render(<SettingsDialog onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("translate-fetch-models"));
    await waitFor(() => {
      expect(screen.getByTestId("translate-fetch-status").textContent).toContain("获取失败");
    });
    expect(datalistOptions()).toEqual(TRANSLATE_PROVIDERS.deepseek.models);
  });

  it("拉取成功后切换厂商：动态列表失效，回到新厂商的静态列表", async () => {
    mockListModels.mockResolvedValue(["m-a", "m-b"]);
    render(<SettingsDialog onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("translate-fetch-models"));
    await waitFor(() => {
      expect(datalistOptions()).toEqual(["m-a", "m-b"]);
    });
    // 切换到 kimi：动态列表失效，datalist 跟随 kimi 静态预设
    fireEvent.change(screen.getByTestId("translate-provider"), { target: { value: "kimi" } });
    await waitFor(() => {
      expect(datalistOptions()).toEqual(TRANSLATE_PROVIDERS.kimi.models);
    });
  });

  it("baseUrl 为空时按钮禁用", () => {
    render(<SettingsDialog onClose={() => {}} />);
    fireEvent.change(screen.getByTestId("translate-base-url"), { target: { value: "" } });
    expect((screen.getByTestId("translate-fetch-models") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("v0.7.2 Key 状态按厂商独立探测", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.getState().setTranslateConfig({ ...DEFAULT_TRANSLATE_SETTINGS });
    mockSetKey.mockReset().mockResolvedValue(undefined);
    mockHasKey.mockReset().mockResolvedValue(false);
    mockTestConnection.mockReset().mockResolvedValue(undefined);
    mockListModels.mockReset().mockResolvedValue([]);
  });

  afterEach(() => cleanup());

  it("打开对话框探测当前厂商（deepseek），切换厂商后重新探测（kimi）", async () => {
    render(<SettingsDialog onClose={() => {}} />);
    await waitFor(() => {
      expect(mockHasKey).toHaveBeenCalledWith("deepseek");
    });
    fireEvent.change(screen.getByTestId("translate-provider"), { target: { value: "kimi" } });
    await waitFor(() => {
      expect(mockHasKey).toHaveBeenCalledWith("kimi");
    });
  });

  it("切换到未配置 Key 的厂商时状态显示未配置", async () => {
    mockHasKey.mockImplementation(async (p: string) => p === "deepseek");
    render(<SettingsDialog onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByTestId("translate-key-status").textContent).toContain("已配置");
    });
    fireEvent.change(screen.getByTestId("translate-provider"), { target: { value: "kimi" } });
    await waitFor(() => {
      expect(screen.getByTestId("translate-key-status").textContent).toContain("未配置");
    });
  });
});

describe("v0.7.2 kimi 海外端点提示", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.getState().setTranslateConfig({ ...DEFAULT_TRANSLATE_SETTINGS });
    mockSetKey.mockReset().mockResolvedValue(undefined);
    mockHasKey.mockReset().mockResolvedValue(false);
    mockTestConnection.mockReset().mockResolvedValue(undefined);
    mockListModels.mockReset().mockResolvedValue([]);
  });

  afterEach(() => cleanup());

  it("默认（deepseek）不显示，切换到 kimi 显示海外端点说明", () => {
    render(<SettingsDialog onClose={() => {}} />);
    expect(screen.queryByTestId("translate-kimi-oversea-hint")).toBeNull();
    fireEvent.change(screen.getByTestId("translate-provider"), { target: { value: "kimi" } });
    const hint = screen.getByTestId("translate-kimi-oversea-hint");
    expect(hint.textContent).toContain("api.moonshot.ai/v1");
  });
});

describe("v0.7.2 模型候选浮层（修复 datalist 按输入框文本过滤）", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.getState().setTranslateConfig({ ...DEFAULT_TRANSLATE_SETTINGS });
    mockSetKey.mockReset().mockResolvedValue(undefined);
    mockHasKey.mockReset().mockResolvedValue(false);
    mockTestConnection.mockReset().mockResolvedValue(undefined);
    mockListModels.mockReset().mockResolvedValue([]);
  });

  afterEach(() => cleanup());

  it("聚焦输入框展开静态预设全量浮层（不受输入框已有文本过滤），点击候选项填入并关闭", () => {
    render(<SettingsDialog onClose={() => {}} />);
    // 初始未聚焦：浮层不显示
    expect(screen.queryByTestId("translate-model-menu")).toBeNull();
    // 聚焦输入框：展开全量候选（deepseek 2 个模型全显示）
    fireEvent.focus(screen.getByTestId("translate-model"));
    const menu = screen.getByTestId("translate-model-menu");
    const items = within(menu).getAllByTestId("translate-model-menu-item");
    expect(items.map((i) => i.textContent)).toEqual(TRANSLATE_PROVIDERS.deepseek.models);
    // 静态列表头部为"推荐模型"文案
    expect(menu.textContent).toContain("推荐模型");
    // 点击第二个候选项：填入输入框并关闭浮层
    fireEvent.click(items[1]);
    expect((screen.getByTestId("translate-model") as HTMLInputElement).value).toBe(
      TRANSLATE_PROVIDERS.deepseek.models[1]
    );
    expect(screen.queryByTestId("translate-model-menu")).toBeNull();
  });

  it("失焦关闭浮层；拉取成功后自动展开动态列表浮层并显示数量标题", async () => {
    mockListModels.mockResolvedValue(["m-a", "m-b"]);
    render(<SettingsDialog onClose={() => {}} />);
    fireEvent.focus(screen.getByTestId("translate-model"));
    expect(screen.getByTestId("translate-model-menu")).toBeTruthy();
    fireEvent.blur(screen.getByTestId("translate-model"));
    expect(screen.queryByTestId("translate-model-menu")).toBeNull();
    // 拉取成功：自动展开动态列表浮层（数量标题）
    fireEvent.click(screen.getByTestId("translate-fetch-models"));
    await waitFor(() => {
      const menu = screen.getByTestId("translate-model-menu");
      const items = within(menu).getAllByTestId("translate-model-menu-item");
      expect(items.map((i) => i.textContent)).toEqual(["m-a", "m-b"]);
    });
    expect(screen.getByTestId("translate-model-menu").textContent).toContain("2");
  });

  it("custom 预设无静态列表：聚焦不弹浮层", () => {
    render(<SettingsDialog onClose={() => {}} />);
    fireEvent.change(screen.getByTestId("translate-provider"), { target: { value: "custom" } });
    fireEvent.focus(screen.getByTestId("translate-model"));
    expect(screen.queryByTestId("translate-model-menu")).toBeNull();
  });
});

describe("v0.7.2 新增厂商配置（2026-09 官方文档核实）", () => {
  it("kimicode：官方 4 个模型 ID 全量收录", () => {
    expect(TRANSLATE_PROVIDERS.kimicode).toEqual({
      baseUrl: "https://api.kimi.com/coding/v1",
      models: ["k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed"],
    });
  });

  it("antling：蚂蚁百灵官方 OpenAI 兼容端点与在售模型", () => {
    expect(TRANSLATE_PROVIDERS.antling.baseUrl).toBe("https://api.ant-ling.com/v1");
    expect(TRANSLATE_PROVIDERS.antling.models).toEqual([
      "Ling-3.0-flash", "Ling-2.6-1T", "Ling-2.6-flash", "Ring-2.6-1T",
    ]);
  });

  it("baidu：千帆 ModelBuilder v2 端点（支持 GET /models）", () => {
    expect(TRANSLATE_PROVIDERS.baidu.baseUrl).toBe("https://qianfan.baidubce.com/v2");
    expect(TRANSLATE_PROVIDERS.baidu.models).toEqual([
      "ernie-5.0", "ernie-4.5-turbo-128k", "ernie-4.5-turbo-32k",
    ]);
  });

  it("xunfei：v1 端点不含 x1（x1 需 v2 端点，避免配置后调用失败）", () => {
    expect(TRANSLATE_PROVIDERS.xunfei.baseUrl).toBe("https://spark-api-open.xf-yun.com/v1");
    expect(TRANSLATE_PROVIDERS.xunfei.models).toEqual(["4.0Ultra", "max-32k", "lite"]);
  });

  it("sensenova：compatible-mode v2 端点", () => {
    expect(TRANSLATE_PROVIDERS.sensenova.baseUrl).toBe("https://api.sensenova.cn/compatible-mode/v2");
    expect(TRANSLATE_PROVIDERS.sensenova.models).toContain("SenseChat-5");
  });

  it("stepfun / hunyuan：模型 ID 为在售型号", () => {
    expect(TRANSLATE_PROVIDERS.stepfun.models).toEqual(["step-3.7-flash", "step-3.5-flash"]);
    expect(TRANSLATE_PROVIDERS.hunyuan.models).toEqual([
      "hunyuan-turbos-latest", "hunyuan-turbo", "hunyuan-lite",
    ]);
  });
});
