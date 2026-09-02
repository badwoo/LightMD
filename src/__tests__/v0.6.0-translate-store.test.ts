/**
 * v0.6.0 AI 翻译：translateStore 状态机测试
 *
 * 覆盖：openBubble → appendChunk（loading→streaming）→ finish/fail → close 全路径
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useTranslateStore } from "../stores/translateStore";

describe("v0.6.0 translateStore 状态机", () => {
  beforeEach(() => {
    // 重置到初始状态
    useTranslateStore.getState().close();
  });

  it("初始状态为 idle", () => {
    const s = useTranslateStore.getState();
    expect(s.status).toBe("idle");
    expect(s.streamedText).toBe("");
    expect(s.result).toBeNull();
    expect(s.errorCode).toBeNull();
    expect(s.anchor).toBeNull();
  });

  it("openBubble 进入 loading 并记录来源与锚点", () => {
    useTranslateStore.getState().openBubble("pm", { x: 100, y: 200 });
    const s = useTranslateStore.getState();
    expect(s.status).toBe("loading");
    expect(s.sourceMode).toBe("pm");
    expect(s.anchor).toEqual({ x: 100, y: 200 });
  });

  it("首次 appendChunk 切换到 streaming，后续增量累加", () => {
    const store = useTranslateStore.getState();
    store.openBubble("preview", { x: 0, y: 0 });
    store.appendChunk("你");
    expect(useTranslateStore.getState().status).toBe("streaming");
    useTranslateStore.getState().appendChunk("好");
    expect(useTranslateStore.getState().streamedText).toBe("你好");
  });

  it("finish 写入结果并进入 done", () => {
    const store = useTranslateStore.getState();
    store.openBubble("pm", { x: 0, y: 0 });
    store.finish({
      translated: "hello",
      placeholdersIntact: true,
      finishReason: "stop",
      promptTokens: 10,
      completionTokens: 5,
    });
    const s = useTranslateStore.getState();
    expect(s.status).toBe("done");
    expect(s.result?.translated).toBe("hello");
    expect(s.result?.placeholdersIntact).toBe(true);
  });

  it("fail 记录错误码与详情", () => {
    const store = useTranslateStore.getState();
    store.openBubble("pm", { x: 0, y: 0 });
    store.fail("AUTH", "未设置 API Key");
    const s = useTranslateStore.getState();
    expect(s.status).toBe("error");
    expect(s.errorCode).toBe("AUTH");
    expect(s.errorDetail).toBe("未设置 API Key");
  });

  it("close 重置全部状态", () => {
    const store = useTranslateStore.getState();
    store.openBubble("pm", { x: 1, y: 1 });
    store.appendChunk("x");
    store.fail("NETWORK");
    useTranslateStore.getState().close();
    const s = useTranslateStore.getState();
    expect(s.status).toBe("idle");
    expect(s.streamedText).toBe("");
    expect(s.errorCode).toBeNull();
    expect(s.result).toBeNull();
    expect(s.anchor).toBeNull();
  });

  it("reopen 清理上一轮残留（流式文本/错误/结果）", () => {
    const store = useTranslateStore.getState();
    store.openBubble("pm", { x: 1, y: 1 });
    store.appendChunk("旧内容");
    store.fail("NETWORK");
    useTranslateStore.getState().openBubble("preview", { x: 2, y: 2 });
    const s = useTranslateStore.getState();
    expect(s.status).toBe("loading");
    expect(s.streamedText).toBe("");
    expect(s.errorCode).toBeNull();
    expect(s.sourceMode).toBe("preview");
  });

  it("setAnchor 更新锚点（选区/滚动变化）", () => {
    useTranslateStore.getState().openBubble("pm", { x: 1, y: 1 });
    useTranslateStore.getState().setAnchor({ x: 50, y: 60 });
    expect(useTranslateStore.getState().anchor).toEqual({ x: 50, y: 60 });
  });
});
