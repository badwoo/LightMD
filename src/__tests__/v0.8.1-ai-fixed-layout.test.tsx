/**
 * v0.8.1 需求5：固定 AI 按钮时底栏整组按钮顺滑居中
 *
 * 覆盖：
 * 1. 未固定：抽屉保持悬浮（无 fixed / inline 类），原 hover 交互不受影响
 * 2. 开启固定：抽屉进入文档流并带宽度过渡容器（fixed + inline + .ai-entry-fixed-wrap）
 * 3. 关闭固定：宽度动画期间保留 inline，动画结束后再脱离文档流（避免按钮组瞬移）
 * 4. AI 总开关关闭时，即使勾选固定也不进入固定态
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup, waitFor } from "@testing-library/react";
import { StatusBar } from "../components/layout/StatusBar";
import { useSettingsStore } from "../stores/useSettingsStore";

// StatusBar 依赖 translateService.cancel（mock 掉，避免真发 invoke）
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

/** 设置「固定 AI 入口」开关（同时可指定 AI 总开关） */
function setAiFixed(fixed: boolean, aiEnabled = true) {
  const cur = useSettingsStore.getState();
  act(() => {
    useSettingsStore.setState({
      aiEnabled,
      translate: { ...cur.translate, aiEntryFixed: fixed },
    });
  });
}

beforeEach(() => {
  const cur = useSettingsStore.getState();
  useSettingsStore.setState({
    aiEnabled: false,
    translate: { ...cur.translate, aiEntryFixed: false },
  });
});

afterEach(() => {
  cleanup();
});

describe("v0.8.1 需求5：固定 AI 按钮时底栏顺滑居中", () => {
  it("未固定：ai-entry 无 fixed / inline 类（抽屉仍为悬浮态）", () => {
    render(<StatusBar />);
    const entry = screen.getByTestId("ai-entry");
    expect(entry.className).not.toContain("fixed");
    expect(entry.className).not.toContain("inline");
    // 宽度过渡容器始终存在（未固定时保持 0fr，不占位）
    expect(entry.querySelector(".ai-entry-fixed-wrap")).toBeTruthy();
  });

  it("开启固定：ai-entry 带 fixed 与 inline（抽屉占位参与布局）", () => {
    setAiFixed(true);
    render(<StatusBar />);
    const entry = screen.getByTestId("ai-entry");
    expect(entry.className).toContain("fixed");
    expect(entry.className).toContain("inline");
  });

  it("关闭固定：先保留 inline 让宽度收回，随后脱离文档流", async () => {
    setAiFixed(true);
    render(<StatusBar />);
    const entry = screen.getByTestId("ai-entry");
    expect(entry.className).toContain("inline");

    setAiFixed(false);
    // fixed 立即移除（宽度开始 1fr → 0fr 过渡）
    expect(entry.className).not.toContain("fixed");
    // 延迟期内仍保持 inline，避免瞬移
    expect(entry.className).toContain("inline");

    await waitFor(() => expect(entry.className).not.toContain("inline"), { timeout: 1500 });
  });

  it("AI 总开关关闭时，即使勾选固定也不进入固定态", () => {
    setAiFixed(true, false);
    render(<StatusBar />);
    const entry = screen.getByTestId("ai-entry");
    expect(entry.className).not.toContain("fixed");
  });
});
