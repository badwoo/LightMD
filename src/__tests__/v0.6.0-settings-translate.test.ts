/**
 * v0.6.0：useSettingsStore.translate 配置测试
 *
 * 覆盖：
 * 1. 默认配置（DeepSeek deepseek-v4-flash 预设 + 总开关默认开启）
 * 2. setTranslateConfig 浅合并（部分更新不丢其他字段）
 * 3. persist merge：旧 localStorage 无 translate 字段时回退默认值
 * 4. persist merge：translate 部分字段缺失时字段级回退（含 translateEnabled 新字段迁移）
 * 5. setTranslateConfig 未知字段被忽略（类型安全）
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  useSettingsStore,
  DEFAULT_TRANSLATE_SETTINGS,
} from "../stores/useSettingsStore";

describe("v0.6.0 useSettingsStore.translate", () => {
  beforeEach(() => {
    localStorage.clear();
    // 重置到默认配置
    useSettingsStore.getState().setTranslateConfig({ ...DEFAULT_TRANSLATE_SETTINGS });
  });

  it("默认配置：DeepSeek deepseek-v4-flash 预设、auto 中英互译、bubble 模式、开关默认关闭（v0.6.2）", () => {
    const t = useSettingsStore.getState().translate;
    expect(t).toEqual(DEFAULT_TRANSLATE_SETTINGS);
    // v0.6.2 问题1：新装用户 AI 翻译默认关闭，需手动开启
    expect(t.translateEnabled).toBe(false);
    expect(t.translateProviderPreset).toBe("deepseek");
    expect(t.translateBaseUrl).toBe("https://api.deepseek.com/v1");
    expect(t.translateModel).toBe("deepseek-v4-flash");
    expect(t.translateTargetLang).toBe("auto");
    expect(t.translateTone).toBe("正式");
    expect(t.translateResultMode).toBe("bubble");
    expect(t.translateCustomPrompt).toBe("");
  });

  it("setTranslateConfig 部分更新（浅合并，未指定字段保留）", () => {
    useSettingsStore.getState().setTranslateConfig({
      translateModel: "deepseek-v4-pro",
      translateTargetLang: "en",
    });
    const t = useSettingsStore.getState().translate;
    expect(t.translateModel).toBe("deepseek-v4-pro");
    expect(t.translateTargetLang).toBe("en");
    // 未指定的字段保持原值
    expect(t.translateProviderPreset).toBe("deepseek");
    expect(t.translateBaseUrl).toBe(DEFAULT_TRANSLATE_SETTINGS.translateBaseUrl);
    expect(t.translateTone).toBe("正式");
  });

  it("切换 Provider 预设：同时更新 URL 和模型", () => {
    useSettingsStore.getState().setTranslateConfig({
      translateProviderPreset: "zhipu",
      translateBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
      translateModel: "glm-4-flash",
    });
    const t = useSettingsStore.getState().translate;
    expect(t.translateProviderPreset).toBe("zhipu");
    expect(t.translateBaseUrl).toBe("https://open.bigmodel.cn/api/paas/v4");
    expect(t.translateModel).toBe("glm-4-flash");
  });

  it("总开关切换：translateEnabled 独立更新", () => {
    useSettingsStore.getState().setTranslateConfig({ translateEnabled: false });
    expect(useSettingsStore.getState().translate.translateEnabled).toBe(false);
    // 其他配置不受影响
    expect(useSettingsStore.getState().translate.translateModel).toBe("deepseek-v4-flash");
  });

  it("自定义 Prompt 模板设置", () => {
    useSettingsStore
      .getState()
      .setTranslateConfig({ translateCustomPrompt: "请翻译成日语文体：{text}" });
    expect(useSettingsStore.getState().translate.translateCustomPrompt).toBe(
      "请翻译成日语文体：{text}"
    );
  });

  it("结果模式切换：bubble → replace", () => {
    useSettingsStore.getState().setTranslateConfig({ translateResultMode: "replace" });
    expect(useSettingsStore.getState().translate.translateResultMode).toBe("replace");
  });

  it("persist merge：旧 localStorage 无 translate 字段时回退默认值", async () => {
    // 模拟旧版本持久化数据（无 translate 键）
    localStorage.setItem(
      "lightmd-settings",
      JSON.stringify({ state: { theme: "dark", fontSize: 18 }, version: 0 })
    );
    // 重新创建 store 触发 rehydrate（动态 import 确保模块重新初始化）
    vi.resetModules();
    const { useSettingsStore: freshStore } = await import("../stores/useSettingsStore");
    // Zustand persist 异步 rehydrate 完成后读取
    await new Promise((r) => setTimeout(r, 50));
    const state = freshStore.getState();
    // 旧字段正常恢复
    expect(state.theme).toBe("dark");
    // translate 回退默认值
    expect(state.translate).toEqual(DEFAULT_TRANSLATE_SETTINGS);
  });

  it("persist merge：translate 部分字段缺失时字段级回退（含 translateEnabled 迁移）", async () => {
    // 模拟 0.6.0 初版数据：translate 无 translateEnabled 字段（升级场景）
    const partial = { translateModel: "glm-4-air", translateProviderPreset: "zhipu" };
    localStorage.setItem(
      "lightmd-settings",
      JSON.stringify({ state: { translate: partial }, version: 0 })
    );
    vi.resetModules();
    const { useSettingsStore: freshStore } = await import("../stores/useSettingsStore");
    await new Promise((r) => setTimeout(r, 50));
    const t = freshStore.getState().translate;
    // 已有字段保留
    expect(t.translateModel).toBe("glm-4-air");
    expect(t.translateProviderPreset).toBe("zhipu");
    // 缺失字段回退默认值（v0.6.2 起 translateEnabled 默认关闭，升级迁移后也保持关闭）
    expect(t.translateEnabled).toBe(false);
    expect(t.translateBaseUrl).toBe(DEFAULT_TRANSLATE_SETTINGS.translateBaseUrl);
  });
});
