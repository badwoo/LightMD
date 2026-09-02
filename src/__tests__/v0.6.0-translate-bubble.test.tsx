/**
 * v0.6.0：TranslateBubble 气泡组件测试
 *
 * 覆盖：
 * 1. translateErrorKey：错误码 → i18n 键映射
 * 2. computeBubblePosition：正常/右溢出/底溢出定位
 * 3. 渲染状态机：idle 不渲染 / loading / streaming 流式文本 / done 操作按钮
 * 4. preview 模式隐藏替换/双语
 * 5. 错误态 + 重试回调
 * 6. Esc 关闭并取消（mock translateService.cancel）
 * 7. onApply/onCopy 回调
 * 8. 占位符失配警告
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { useTranslateStore } from "../stores/translateStore";
import {
  TranslateBubble,
  translateErrorKey,
  computeBubblePosition,
} from "../components/editor/TranslateBubble";

// mock translateService（cancel 不发 invoke）
vi.mock("../services/translateService", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../services/translateService")>();
  return {
    ...orig,
    translateService: {
      ...orig.translateService,
      cancel: vi.fn().mockResolvedValue(undefined),
    },
  };
});

import { translateService } from "../services/translateService";

/** 渲染气泡（固定回调） */
function renderBubble(handlers?: {
  onApply?: (mode: string, text: string) => void;
  onCopy?: (text: string) => void;
  onRetry?: () => void;
}) {
  return render(
    <TranslateBubble
      onApply={handlers?.onApply ?? (() => {})}
      onCopy={handlers?.onCopy ?? (() => {})}
      onRetry={handlers?.onRetry ?? (() => {})}
    />
  );
}

/** 等待 rAF flush */
async function waitForFrame(): Promise<void> {
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("v0.6.0 TranslateBubble - translateErrorKey", () => {
  it("已知错误码映射到对应键", () => {
    expect(translateErrorKey("NETWORK")).toBe("translate.error.NETWORK");
    expect(translateErrorKey("AUTH")).toBe("translate.error.AUTH");
    expect(translateErrorKey("RATE")).toBe("translate.error.RATE");
    expect(translateErrorKey("TRUNCATED")).toBe("translate.error.TRUNCATED");
    expect(translateErrorKey("STREAM")).toBe("translate.error.STREAM");
    // v0.6.3 P2-1：NO_KEY 接线（Key 未配置）
    expect(translateErrorKey("NO_KEY")).toBe("translate.error.NO_KEY");
    // v0.6.3 P2-2：CANCELLED 文案不可达（runTranslate 静默返回），回退 NETWORK
    expect(translateErrorKey("CANCELLED")).toBe("translate.error.NETWORK");
    expect(translateErrorKey("PROVIDER")).toBe("translate.error.PROVIDER");
    expect(translateErrorKey("TOO_LONG")).toBe("translate.error.TOO_LONG");
    expect(translateErrorKey("EMPTY")).toBe("translate.error.EMPTY");
  });

  it("未知错误码回退 NETWORK", () => {
    expect(translateErrorKey("SOMETHING")).toBe("translate.error.NETWORK");
    expect(translateErrorKey("")).toBe("translate.error.NETWORK");
  });
});

describe("v0.6.0 TranslateBubble - computeBubblePosition", () => {
  it("默认锚点右下方", () => {
    const pos = computeBubblePosition({ x: 100, y: 100 }, { width: 1920, height: 1080 });
    expect(pos).toEqual({ left: 100, top: 108 });
  });

  it("右侧溢出时左移", () => {
    const pos = computeBubblePosition({ x: 1900, y: 100 }, { width: 1920, height: 1080 });
    expect(pos.left).toBe(1920 - 380 - 8);
  });

  it("底部溢出时显示在上方", () => {
    const pos = computeBubblePosition({ x: 100, y: 1000 }, { width: 1920, height: 1080 });
    expect(pos.top).toBe(1000 - 8 - 220);
  });

  it("小视口不越界（clamp 到边距）", () => {
    const pos = computeBubblePosition({ x: 0, y: 0 }, { width: 300, height: 200 });
    expect(pos.left).toBe(8);
    expect(pos.top).toBeGreaterThanOrEqual(8);
  });
});

describe("v0.6.0 TranslateBubble - 渲染状态机", () => {
  beforeEach(() => {
    cleanup();
    useTranslateStore.getState().close();
  });

  it("idle 状态不渲染", () => {
    const { container } = renderBubble();
    expect(container.querySelector('[data-testid="translate-bubble"]')).toBeNull();
  });

  it("loading 状态渲染标题", () => {
    useTranslateStore.getState().openBubble("pm", { x: 100, y: 100 });
    renderBubble();
    expect(screen.getByText("AI 翻译")).toBeTruthy();
    // 无操作按钮
    expect(screen.queryByText("替换")).toBeNull();
  });

  it("streaming 状态显示流式文本（rAF 合并刷新）", async () => {
    const store = useTranslateStore.getState();
    store.openBubble("pm", { x: 100, y: 100 });
    renderBubble();

    act(() => {
      store.appendChunk("你好");
      store.appendChunk("，");
      store.appendChunk("世界");
    });
    await waitForFrame();

    expect(screen.getByText("你好，世界")).toBeTruthy();
  });

  it("done 状态显示译文 + 三个操作按钮 + token 用量", () => {
    const store = useTranslateStore.getState();
    store.openBubble("pm", { x: 100, y: 100 });
    act(() => {
      store.appendChunk("部分");
      store.finish({
        translated: "完整译文",
        placeholdersIntact: true,
        finishReason: "stop",
        promptTokens: 100,
        completionTokens: 50,
      });
    });
    renderBubble();

    expect(screen.getByText("完整译文")).toBeTruthy();
    expect(screen.getByText("替换")).toBeTruthy();
    expect(screen.getByText("双语")).toBeTruthy();
    expect(screen.getByText("复制")).toBeTruthy();
    expect(screen.getByText(/150 tokens/)).toBeTruthy();
  });

  it("preview 模式只有复制按钮（无替换/双语）", () => {
    const store = useTranslateStore.getState();
    store.openBubble("preview", { x: 100, y: 100 });
    act(() => {
      store.finish({
        translated: "译文",
        placeholdersIntact: true,
        finishReason: "stop",
        promptTokens: 10,
        completionTokens: 5,
      });
    });
    renderBubble();

    expect(screen.queryByText("替换")).toBeNull();
    expect(screen.queryByText("双语")).toBeNull();
    expect(screen.getByText("复制")).toBeTruthy();
  });

  it("错误态显示本地化文案 + 重试按钮", () => {
    const store = useTranslateStore.getState();
    store.openBubble("pm", { x: 100, y: 100 });
    act(() => {
      store.fail("AUTH", "invalid key");
    });
    renderBubble();

    expect(screen.getByText("API Key 无效或未配置，请在设置中填写")).toBeTruthy();
    expect(screen.getByText("invalid key")).toBeTruthy();
    expect(screen.getByText("重试")).toBeTruthy();
  });

  it("占位符失配时显示警告", () => {
    const store = useTranslateStore.getState();
    store.openBubble("pm", { x: 100, y: 100 });
    act(() => {
      store.finish({
        translated: "译文",
        placeholdersIntact: false,
        finishReason: "stop",
        promptTokens: 10,
        completionTokens: 5,
      });
    });
    renderBubble();

    expect(
      screen.getByText("部分格式标记可能丢失，建议使用双语模式")
    ).toBeTruthy();
  });
});

describe("v0.6.0 TranslateBubble - 交互", () => {
  beforeEach(() => {
    cleanup();
    useTranslateStore.getState().close();
    vi.clearAllMocks();
  });

  it("替换按钮触发 onApply('replace', translated)", () => {
    const onApply = vi.fn();
    const store = useTranslateStore.getState();
    store.openBubble("pm", { x: 100, y: 100 });
    act(() => {
      store.finish({
        translated: "译文内容",
        placeholdersIntact: true,
        finishReason: "stop",
        promptTokens: 10,
        completionTokens: 5,
      });
    });
    renderBubble({ onApply });

    fireEvent.click(screen.getByText("替换"));
    expect(onApply).toHaveBeenCalledWith("replace", "译文内容");
  });

  it("复制按钮触发 onCopy", () => {
    const onCopy = vi.fn();
    const store = useTranslateStore.getState();
    store.openBubble("pm", { x: 100, y: 100 });
    act(() => {
      store.finish({
        translated: "复制内容",
        placeholdersIntact: true,
        finishReason: "stop",
        promptTokens: 10,
        completionTokens: 5,
      });
    });
    renderBubble({ onCopy });

    fireEvent.click(screen.getByText("复制"));
    expect(onCopy).toHaveBeenCalledWith("复制内容");
  });

  it("Esc 关闭气泡并取消任务", () => {
    const store = useTranslateStore.getState();
    store.openBubble("pm", { x: 100, y: 100 });
    renderBubble();
    expect(useTranslateStore.getState().status).toBe("loading");

    fireEvent.keyDown(window, { key: "Escape", cancelable: true });

    expect(translateService.cancel).toHaveBeenCalled();
    expect(useTranslateStore.getState().status).toBe("idle");
  });

  // ─── v0.6.0 优化：双击空白关闭 ────────────────
  it("双击气泡外空白处关闭气泡", () => {
    const store = useTranslateStore.getState();
    store.openBubble("pm", { x: 100, y: 100 });
    renderBubble();
    expect(useTranslateStore.getState().status).toBe("loading");

    // 双击气泡外元素（如编辑器空白区域）→ 关闭
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    fireEvent.dblClick(outside);
    expect(useTranslateStore.getState().status).toBe("idle");
    outside.remove();
  });

  it("双击气泡内部不关闭", () => {
    const store = useTranslateStore.getState();
    store.openBubble("pm", { x: 100, y: 100 });
    renderBubble();
    expect(useTranslateStore.getState().status).toBe("loading");

    // 双击气泡自身（如标题区域）→ 保持打开
    fireEvent.dblClick(screen.getByTestId("translate-bubble"));
    expect(useTranslateStore.getState().status).toBe("loading");
  });

  it("关闭按钮（×）关闭并取消", () => {
    const store = useTranslateStore.getState();
    store.openBubble("pm", { x: 100, y: 100 });
    renderBubble();

    fireEvent.click(screen.getByTitle("关闭"));

    expect(translateService.cancel).toHaveBeenCalled();
    expect(useTranslateStore.getState().status).toBe("idle");
  });
});
