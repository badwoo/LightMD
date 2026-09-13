/**
 * v0.7.4 摘要气泡：store 文档归属 + 摘要辅助函数
 *
 * 覆盖：
 * 1. aiAssistStore：openBubble 记录所属文档 filePath；close 清除
 * 2. 摘要辅助纯函数（isFullDocSummary / aiTaskApplyKey / aiTaskTitleKey）
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { useAiAssistStore } from "../stores/aiAssistStore";
import {
  isFullDocSummary,
  aiTaskApplyKey,
  aiTaskTitleKey,
} from "../components/editor/AiAssistBubble";

describe("v0.7.4 aiAssistStore 文档归属", () => {
  beforeEach(() => {
    useAiAssistStore.setState({
      status: "idle", task: "summary", sourceMode: "pm",
      streamedText: "", errorCode: null, errorDetail: null, result: null,
      anchor: null, filePath: null,
    });
  });

  it("openBubble 记录所属文档 filePath", () => {
    // 需要 anchor 非空（Tipper？不，原样式）；openBubble(task, mode, anchor, filePath)
    useAiAssistStore.getState().openBubble("summary", "pm", { x: 1, y: 2 }, "D:\\docs\\a.md");
    const s = useAiAssistStore.getState();
    expect(s.filePath).toBe("D:\\docs\\a.md");
    expect(s.task).toBe("summary");
  });

  it("openBubble 缺省 filePath 时为 null", () => {
    useAiAssistStore.getState().openBubble("polish", "pm", { x: 1, y: 2 });
    expect(useAiAssistStore.getState().filePath).toBeNull();
  });

  it("close 清除 filePath", () => {
    useAiAssistStore.getState().openBubble("summary", "pm", { x: 1, y: 2 }, "a.md");
    useAiAssistStore.getState().close();
    expect(useAiAssistStore.getState().filePath).toBeNull();
  });

  // 问题1回归：translateConcurrent 参数契约已在该文件另一测试文件覆盖，这里放纯函数
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