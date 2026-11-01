/**
 * @vitest-environment jsdom
 * v0.15.3：设置窗口的 AI 树状布局与翻译专属配置。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SettingsDialog } from "../components/dialogs/SettingsDialog";
import {
  DEFAULT_TRANSLATE_SETTINGS,
  useSettingsStore,
} from "../stores/useSettingsStore";
import { createDefaultAiSettings } from "../services/aiProfiles";

const hasKey = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string) => command === "has_ai_credential_key" ? hasKey() : Promise.resolve(),
  Channel: class { onmessage?: (chunk: string) => void; },
}));

function renderSettings() {
  return render(<SettingsDialog onClose={() => {}} />);
}

describe("v0.15.3 AI 设置树", () => {
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

  it("总开关开启后按模型配置 → AI 翻译 → AI 指令库排列", () => {
    const { container } = renderSettings();
    expect(screen.getByTestId("ai-enabled")).toBeTruthy();
    expect(screen.getByTestId("ai-model-settings")).toBeTruthy();
    expect(screen.getByTestId("translate-section")).toBeTruthy();
    expect(screen.getByTestId("ai-instruction-section")).toBeTruthy();
    const sections = Array.from(container.querySelectorAll(".ai-tree-children > section"));
    expect(sections.map((section) => section.getAttribute("data-testid"))).toEqual([
      "ai-model-settings",
      "translate-section",
      "ai-instruction-section",
    ]);
  });

  it("总开关关闭时隐藏整棵子树，开启后恢复", () => {
    renderSettings();
    fireEvent.change(screen.getByTestId("ai-enabled"), { target: { value: "off" } });
    expect(useSettingsStore.getState().aiEnabled).toBe(false);
    expect(screen.queryByTestId("ai-model-settings")).toBeNull();
    expect(screen.queryByTestId("translate-section")).toBeNull();
    expect(screen.queryByTestId("ai-instruction-section")).toBeNull();
    fireEvent.change(screen.getByTestId("ai-enabled"), { target: { value: "on" } });
    expect(screen.getByTestId("ai-model-settings")).toBeTruthy();
  });

  it("翻译入口下仅保留翻译专属配置，不重复模型连接字段", () => {
    renderSettings();
    for (const id of [
      "translate-target-lang",
      "translate-tone",
      "translate-result-mode",
      "translate-bubble-color",
      "translate-custom-prompt",
    ]) expect(screen.getByTestId(id)).toBeTruthy();
    expect(screen.queryByTestId("translate-provider")).toBeNull();
    expect(screen.queryByTestId("translate-model")).toBeNull();
    expect(screen.queryByTestId("translate-temperature")).toBeNull();
  });

  it("翻译子开关关闭时收起其子项，开启后恢复", () => {
    renderSettings();
    fireEvent.change(screen.getByTestId("translate-enabled"), { target: { value: "off" } });
    expect(useSettingsStore.getState().translate.translateEnabled).toBe(false);
    expect(screen.queryByTestId("translate-target-lang")).toBeNull();
    fireEvent.change(screen.getByTestId("translate-enabled"), { target: { value: "on" } });
    expect(screen.getByTestId("translate-target-lang")).toBeTruthy();
  });

  it("目标语言、语体、结果模式、气泡颜色和 Prompt 实时写入同一翻译设置", () => {
    renderSettings();
    fireEvent.change(screen.getByTestId("translate-target-lang"), { target: { value: "English" } });
    fireEvent.change(screen.getByTestId("translate-tone"), { target: { value: "技术文档" } });
    fireEvent.change(screen.getByTestId("translate-result-mode"), { target: { value: "bilingual" } });
    fireEvent.change(screen.getByTestId("translate-bubble-color"), { target: { value: "#123456" } });
    fireEvent.change(screen.getByTestId("translate-custom-prompt"), {
      target: { value: "翻译为{target_lang}，语体{tone}" },
    });
    expect(useSettingsStore.getState().translate).toMatchObject({
      translateTargetLang: "English",
      translateTone: "技术文档",
      translateResultMode: "bilingual",
      translateBubbleColor: "#123456",
      translateCustomPrompt: "翻译为{target_lang}，语体{tone}",
    });
  });
});
