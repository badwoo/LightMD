/**
 * v0.6.0：translateService 测试
 *
 * 覆盖：
 * 1. parseTranslateError：Rust 错误码协议解析（全部前缀 + 未识别回退）
 * 2. translate 前置校验：空文本 EMPTY / 超长 TOO_LONG / 非 Tauri NETWORK（均不发 invoke）
 * 3. translate 正常流：invoke 参数来自 settings、Channel onChunk 转发、返回结果
 * 4. translate 单任务模型：发起前先 cancel_translate
 * 5. translate 错误包装：invoke 抛错 → TranslateServiceError
 * 6. isTaskActive：任务期间 true，结束 false
 * 7. cancel 幂等静默失败 / testConnection / setKey / hasKey 封装
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

// ─── mocks（必须在 import 服务之前） ───────────────────────
const { mockInvoke, mockIsTauri } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockIsTauri: vi.fn(),
}));

/** Channel mock：记录最后创建的实例，测试通过 onmessage 模拟 Rust 推流 */
const { MockChannel } = vi.hoisted(() => {
  // 注：真实 Channel<string> 经 vi.mock 替换后运行时即本类，无需泛型
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

import {
  translateService,
  parseTranslateError,
  MAX_SELECTION_CHARS,
  TranslateServiceError,
} from "../services/translateService";
import { useSettingsStore } from "../stores/useSettingsStore";

describe("v0.6.0 translateService", () => {
  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockReset();
    mockIsTauri.mockReset();
    mockIsTauri.mockReturnValue(true);
    MockChannel.last = null;
    // 重置翻译配置为默认值
    useSettingsStore.getState().setTranslateConfig({
      translateBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
      translateModel: "glm-4-flash",
      translateTargetLang: "auto",
      translateTone: "正式",
      translateCustomPrompt: "",
    });
  });

  // ─── parseTranslateError 协议解析 ──────────────────────
  describe("parseTranslateError", () => {
    it("NETWORK| 前缀", () => {
      expect(parseTranslateError("NETWORK|timeout")).toEqual({
        code: "NETWORK",
        detail: "timeout",
      });
    });

    it("AUTH| 前缀", () => {
      expect(parseTranslateError("AUTH|invalid key")).toEqual({
        code: "AUTH",
        detail: "invalid key",
      });
    });

    it("RATE| 前缀", () => {
      expect(parseTranslateError("RATE|429")).toEqual({
        code: "RATE",
        detail: "429",
      });
    });

    it("NO_KEY| 前缀（v0.6.3 P2-1：Key 未配置与 AUTH 区分）", () => {
      expect(parseTranslateError("NO_KEY|未设置 API Key")).toEqual({
        code: "NO_KEY",
        detail: "未设置 API Key",
      });
    });

    it("TRUNCATED| 前缀", () => {
      expect(parseTranslateError("TRUNCATED|max tokens")).toEqual({
        code: "TRUNCATED",
        detail: "max tokens",
      });
    });

    it("STREAM| 前缀", () => {
      expect(parseTranslateError("STREAM|connection reset")).toEqual({
        code: "STREAM",
        detail: "connection reset",
      });
    });

    it("CANCELLED 精确匹配（无 detail）", () => {
      expect(parseTranslateError("CANCELLED")).toEqual({
        code: "CANCELLED",
        detail: "",
      });
    });

    it("PLACEHOLDER| 前缀归一化为 PROVIDER", () => {
      expect(parseTranslateError("PLACEHOLDER|missing {{0}}")).toEqual({
        code: "PROVIDER",
        detail: "missing {{0}}",
      });
    });

    it("PROVIDER|{status}|{message} 三段式", () => {
      expect(parseTranslateError("PROVIDER|401|unauthorized")).toEqual({
        code: "PROVIDER",
        detail: "401: unauthorized",
      });
    });

    it("PROVIDER|{status} 两段式（无 message）", () => {
      expect(parseTranslateError("PROVIDER|500")).toEqual({
        code: "PROVIDER",
        detail: "500",
      });
    });

    it("未识别格式回退 NETWORK", () => {
      expect(parseTranslateError("some random error")).toEqual({
        code: "NETWORK",
        detail: "some random error",
      });
    });

    it("非字符串输入（null/undefined/对象）", () => {
      expect(parseTranslateError(null).code).toBe("NETWORK");
      expect(parseTranslateError(undefined).code).toBe("NETWORK");
      expect(parseTranslateError({ err: 1 }).code).toBe("NETWORK");
    });
  });

  // ─── translate 前置校验 ────────────────────────────────
  describe("translate 前置校验", () => {
    it("空文本抛 EMPTY 且不发 invoke", async () => {
      await expect(translateService.translate("", () => {})).rejects.toMatchObject({
        info: { code: "EMPTY" },
      });
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("纯空白文本抛 EMPTY", async () => {
      await expect(translateService.translate("   \n  ", () => {})).rejects.toMatchObject({
        info: { code: "EMPTY" },
      });
    });

    it("超过 4000 字符抛 TOO_LONG 且不发 invoke", async () => {
      const long = "a".repeat(MAX_SELECTION_CHARS + 1);
      await expect(translateService.translate(long, () => {})).rejects.toMatchObject({
        info: { code: "TOO_LONG" },
      });
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("正好 4000 字符通过校验（边界）", async () => {
      mockInvoke.mockResolvedValue({
        translated: "ok",
        placeholdersIntact: true,
        finishReason: "stop",
        promptTokens: 1,
        completionTokens: 1,
      });
      const text = "a".repeat(MAX_SELECTION_CHARS);
      await expect(translateService.translate(text, () => {})).resolves.toBeTruthy();
    });

    it("非 Tauri 环境抛 NETWORK", async () => {
      mockIsTauri.mockReturnValue(false);
      await expect(translateService.translate("hello", () => {})).rejects.toMatchObject({
        info: { code: "NETWORK", detail: "non-tauri" },
      });
      expect(mockInvoke).not.toHaveBeenCalled();
    });
  });

  // ─── translate 正常流 ──────────────────────────────────
  describe("translate 正常流", () => {
    const fakeResult = {
      translated: "你好",
      placeholdersIntact: true,
      finishReason: "stop",
      promptTokens: 10,
      completionTokens: 5,
    };

    it("invoke 参数来自 settings 配置", async () => {
      useSettingsStore.getState().setTranslateConfig({
        translateBaseUrl: "https://api.deepseek.com/v1",
        translateModel: "deepseek-chat",
        translateTargetLang: "en",
        translateTone: "口语",
        translateCustomPrompt: "自定义模板",
      });
      mockInvoke.mockResolvedValue(fakeResult);

      await translateService.translate("你好", () => {});

      const call = mockInvoke.mock.calls.find(([cmd]) => cmd === "translate_text");
      expect(call).toBeTruthy();
      expect(call![1]).toMatchObject({
        text: "你好",
        baseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
        targetLang: "en",
        tone: "口语",
        customPrompt: "自定义模板",
      });
    });

    it("customPrompt 为空串时传 null", async () => {
      mockInvoke.mockResolvedValue(fakeResult);
      await translateService.translate("你好", () => {});
      const call = mockInvoke.mock.calls.find(([cmd]) => cmd === "translate_text");
      expect(call![1].customPrompt).toBeNull();
    });

    it("Channel onChunk 转发流式增量", async () => {
      mockInvoke.mockImplementation(async () => {
        // 模拟 Rust 在 resolve 前通过 channel 推流
        MockChannel.last!.onmessage!("你");
        MockChannel.last!.onmessage!("好");
        return fakeResult;
      });
      const chunks: string[] = [];
      const result = await translateService.translate("hello", (c) => chunks.push(c));

      expect(chunks).toEqual(["你", "好"]);
      expect(result).toEqual(fakeResult);
    });

    it("单任务模型：发起前先 cancel_translate", async () => {
      mockInvoke.mockResolvedValue(fakeResult);
      await translateService.translate("hello", () => {});

      const commands = mockInvoke.mock.calls.map(([cmd]) => cmd);
      expect(commands.indexOf("cancel_translate")).toBeLessThan(
        commands.indexOf("translate_text")
      );
    });

    it("translateService 不再暴露 isTaskActive（v0.6.3 P2-3 删除死代码）", () => {
      expect((translateService as Record<string, unknown>).isTaskActive).toBeUndefined();
    });
  });

  // ─── translate 错误包装 ────────────────────────────────
  describe("translate 错误包装", () => {
    it("invoke 抛 Rust 错误码协议时转为 TranslateServiceError", async () => {
      mockInvoke.mockRejectedValue("AUTH|invalid api key");
      await expect(translateService.translate("hello", () => {})).rejects.toBeInstanceOf(
        TranslateServiceError
      );
      await expect(translateService.translate("hello", () => {})).rejects.toMatchObject({
        info: { code: "AUTH", detail: "invalid api key" },
      });
    });

    it("任务失败后正常抛错（无 taskActive 残留状态）", async () => {
      mockInvoke.mockRejectedValue("CANCELLED");
      await expect(translateService.translate("hello", () => {})).rejects.toBeTruthy();
    });
  });

  // ─── cancel ────────────────────────────────────────────
  describe("cancel", () => {
    it("调用 cancel_translate 命令", async () => {
      mockInvoke.mockResolvedValue(undefined);
      await translateService.cancel();
      expect(mockInvoke).toHaveBeenCalledWith("cancel_translate");
    });

    it("非 Tauri 环境直接返回（不发 invoke）", async () => {
      mockIsTauri.mockReturnValue(false);
      await translateService.cancel();
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("invoke 失败时静默（不抛错）", async () => {
      mockInvoke.mockRejectedValue(new Error("boom"));
      await expect(translateService.cancel()).resolves.toBeUndefined();
    });
  });

  // ─── testConnection / setKey / hasKey ──────────────────
  describe("testConnection", () => {
    it("透传 baseUrl/model 到 test_translate_connection", async () => {
      mockInvoke.mockResolvedValue(undefined);
      await translateService.testConnection("https://api.test.com", "model-x");
      expect(mockInvoke).toHaveBeenCalledWith("test_translate_connection", {
        baseUrl: "https://api.test.com",
        model: "model-x",
      });
    });

    it("错误包装为 TranslateServiceError", async () => {
      mockInvoke.mockRejectedValue("AUTH|bad key");
      await expect(
        translateService.testConnection("https://api.test.com", "model-x")
      ).rejects.toMatchObject({ info: { code: "AUTH" } });
    });

    it("非 Tauri 环境抛 NETWORK", async () => {
      mockIsTauri.mockReturnValue(false);
      await expect(
        translateService.testConnection("https://api.test.com", "model-x")
      ).rejects.toMatchObject({ info: { code: "NETWORK" } });
    });
  });

  describe("setKey", () => {
    it("透传 key 到 set_translate_key", async () => {
      mockInvoke.mockResolvedValue(undefined);
      await translateService.setKey("sk-test");
      expect(mockInvoke).toHaveBeenCalledWith("set_translate_key", { key: "sk-test" });
    });

    it("错误包装为 TranslateServiceError", async () => {
      mockInvoke.mockRejectedValue("NETWORK|os error");
      await expect(translateService.setKey("sk-test")).rejects.toMatchObject({
        info: { code: "NETWORK" },
      });
    });
  });

  describe("hasKey", () => {
    it("返回 keyring 检查结果", async () => {
      mockInvoke.mockResolvedValue(true);
      await expect(translateService.hasKey()).resolves.toBe(true);
      expect(mockInvoke).toHaveBeenCalledWith("has_translate_key");
    });

    it("invoke 失败时返回 false（不抛错）", async () => {
      mockInvoke.mockRejectedValue(new Error("boom"));
      await expect(translateService.hasKey()).resolves.toBe(false);
    });

    it("非 Tauri 环境返回 false", async () => {
      mockIsTauri.mockReturnValue(false);
      await expect(translateService.hasKey()).resolves.toBe(false);
      expect(mockInvoke).not.toHaveBeenCalled();
    });
  });
});
