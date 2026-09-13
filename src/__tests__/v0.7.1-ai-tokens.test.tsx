/**
 * v0.7.1 问题3验证：AI 气泡 token 统计显示（输入/输出分开）
 *
 * 背景：合计单个数字（如 150 tokens）让用户误以为"几十个字上百 token
 * 统计不准"。实际构成 = 系统提示词 + 输入文本（promptTokens）+ 输出
 * （completionTokens）。改为 ↑输入 ↓输出 分开显示，构成一目了然。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { useAiAssistStore } from "../stores/aiAssistStore";
import { AiAssistBubble } from "../components/editor/AiAssistBubble";

// mock aiAssistService（cancel 不发 invoke）
vi.mock("../services/aiAssistService", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../services/aiAssistService")>();
  return {
    ...orig,
    aiAssistService: {
      ...orig.aiAssistService,
      cancel: vi.fn().mockResolvedValue(undefined),
    },
  };
});

beforeEach(() => {
  cleanup();
  useAiAssistStore.getState().close();
});

describe("v0.7.1 问题3：AI 气泡 token 显示", () => {
  it("完成态显示 ↑输入 ↓输出 分开的 token 用量（润色场景）", () => {
    const store = useAiAssistStore.getState();
    act(() => {
      store.openBubble("polish", "pm", { x: 100, y: 100 });
      store.finish({
        translated: "润色结果",
        placeholdersIntact: true,
        finishReason: "stop",
        promptTokens: 128,
        completionTokens: 45,
      });
    });
    render(
      <AiAssistBubble
        onApply={() => {}}
        onCopy={() => {}}
        onRetry={() => {}}
      />
    );

    // 显示格式：↑128 ↓45 tokens（输入构成可见，不再是一个合计数）
    expect(screen.getByText(/↑128 ↓45 tokens/)).toBeTruthy();
    // hover 提示含输入/输出本地化标签与数值
    const el = screen.getByText(/↑128 ↓45 tokens/);
    expect(el.getAttribute("title")).toContain("128");
    expect(el.getAttribute("title")).toContain("45");
  });
});
