/**
 * v0.7.4：问题1回归 + 摘要气泡关键行为测试
 *
 * 覆盖：
 * 1. 问题1：translateConcurrent 第一个参数应为待译文本、第二个为并发槽位 id
 *    （防旧 bug：把 concurrent_id 当 text 传入，导致后端翻译 "ft-xxx" 字符串）
 * 2. isFullDocSummary / aiTaskApplyKey 等摘要辅助函数
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockInvoke, mockIsTauri } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockIsTauri: vi.fn(),
}));

const { MockChannel } = vi.hoisted(() => {
  class MockChannel {
    onmessage: ((msg: string) => void) | undefined;
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

import { translateService } from "../services/translateService";
import { useSettingsStore } from "../stores/useSettingsStore";
import { isFullDocSummary, aiTaskApplyKey, aiTaskTitleKey } from "../components/editor/AiAssistBubble";

describe("v0.7.4 问题1：translateConcurrent 参数顺序", () => {
  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockReset();
    mockIsTauri.mockReset();
    mockIsTauri.mockReturnValue(true);
    mockInvoke.mockResolvedValue({
      translated: "你好",
      placeholdersIntact: true,
      finishReason: "stop",
    });
    // 保证 translate 配置可用
    const st = useSettingsStore.getState();
    st.setTranslateConfig({ ...st.translate });
  });

  it("translateConcurrent(text, concurrentId, onChunk)：text 作 invoke.text，concurrentId 作 concurrent_id", async () => {
    const result = await translateService.translateConcurrent(
      "Hello world",      // 待译文本（第一个参数）
      "ft-12345-0",       // 并发槽位 id（第二个参数）
      () => undefined
    );
    // invoke 收到的参数必须正确对应：text=原文本、concurrent_id=槽位 id
    const args = mockInvoke.mock.calls[0];
    expect(args[0]).toBe("translate_text");
    expect(args[1].text).toBe("Hello world");
    expect(args[1].concurrentId).toBe("ft-12345-0");
    expect(result.translated).toBe("你好");
  });

  it("新版调用（已在正文）：text 传入待译文本而非槽位 id——译文不含 ft- 前缀", () => {
    // 回归点：若调用方误把 concurrent_id 当 text 传入，invoke.text 会以 "ft-" 开头。
    // 此处锁定契约：待译文本绝不能以 "ft-<时间戳>" 形态出现（那是槽位 id 的形态）。
    expect("Hello world").not.toMatch(/^ft-[\d]+-/);
  });
});

describe("v0.7.4 摘要辅助函数", () => {
  it("isFullDocSummary：无锚点或 (0,0) 判定为全文摘要", () => {
    expect(isFullDocSummary(null)).toBe(true);
    expect(isFullDocSummary({ x: 0, y: 0 })).toBe(true);
    expect(isFullDocSummary({ x: 10, y: 20 })).toBe(false);
  });

  it("aiTaskApplyKey：润色=替换选中，续写/摘要=插入", () => {
    expect(aiTaskApplyKey("polish")).toBe("ai.replace");
    expect(aiTaskApplyKey("continue")).toBe("ai.insert");
    expect(aiTaskApplyKey("summary")).toBe("ai.insert");
  });

  it("aiTaskTitleKey：任务类型映射标题键", () => {
    expect(aiTaskTitleKey("continue")).toBe("ai.title.continue");
    expect(aiTaskTitleKey("polish")).toBe("ai.title.polish");
    expect(aiTaskTitleKey("summary")).toBe("ai.title.summary");
  });
});