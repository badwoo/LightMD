/**
 * aiAssistService —— AI 助手前端服务（v0.7.0：续写 / 润色 / 摘要）
 *
 * 职责：
 * - 封装 ai_assist_text 流式调用（Channel 接收增量）
 * - 前置校验：空文本 / 超长直接抛错（不发 invoke，省 token）
 * - 复用 AI 翻译的错误码协议解析（parseTranslateError / TranslateServiceError）
 * - 复用翻译配置（baseUrl/model，与翻译共用同一 Key 与 Provider）
 *
 * 单任务模型：与翻译共享同一任务槽（Rust 侧 TranslateState），
 * 新任务自动取消旧任务；取消复用 translateService.cancel。
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { isTauri } from "./fileService";
import { useSettingsStore } from "../stores/useSettingsStore";
import {
  translateService,
  parseTranslateError,
  TranslateServiceError,
} from "./translateService";
import type { TranslateResultData } from "../stores/translateStore";

/** AI 助手任务类型（与 Rust 侧 build_ai_assist_prompt 一一对应） */
export type AiTask = "continue" | "polish" | "summary";

/** 润色 / 续写输入上限（字符数，与选中翻译 MAX_SELECTION_CHARS 一致） */
export const MAX_AI_INPUT_CHARS = 4000;

/** 摘要输入上限（整篇文档单请求；超长文档建议分段） */
export const MAX_AI_SUMMARY_CHARS = 20000;

/** 各任务的输入长度上限 */
export function aiTaskInputLimit(task: AiTask): number {
  return task === "summary" ? MAX_AI_SUMMARY_CHARS : MAX_AI_INPUT_CHARS;
}

export const aiAssistService = {
  /**
   * 执行 AI 助手任务（流式）。
   * - continue：text = 光标前上文（调用方已截尾）
   * - polish：text = 选中文本
   * - summary：text = 文档全文或选区
   * @returns 完整结果（已回填占位符；续写/摘要的 placeholdersIntact 无意义，由 UI 忽略）
   */
  async run(
    task: AiTask,
    text: string,
    onChunk: (chunk: string) => void,
  ): Promise<TranslateResultData> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new TranslateServiceError({ code: "EMPTY", detail: "" });
    }
    if (trimmed.length > aiTaskInputLimit(task)) {
      throw new TranslateServiceError({ code: "TOO_LONG", detail: "" });
    }
    if (!isTauri()) {
      throw new TranslateServiceError({ code: "NETWORK", detail: "non-tauri" });
    }

    // 单任务模型：新任务自动取消旧任务（与翻译共享任务槽）
    await translateService.cancel().catch(() => undefined);

    const cfg = useSettingsStore.getState().translate;
    const channel = new Channel<string>();
    channel.onmessage = onChunk;

    try {
      return await invoke<TranslateResultData>("ai_assist_text", {
        task,
        text: trimmed,
        // v0.7.2 P1：Key 按厂商独立存储，与翻译共用 translateProviderPreset
        provider: cfg.translateProviderPreset,
        baseUrl: cfg.translateBaseUrl,
        model: cfg.translateModel,
        // v0.7.3：采样温度由设置透传（kimi 等厂商仅允许 1）
        temperature: cfg.translateTemperature,
        onChunk: channel,
      });
    } catch (e) {
      throw new TranslateServiceError(parseTranslateError(e));
    }
  },

  /** 中断进行中的任务（与翻译共用 cancel_translate，幂等；静默失败） */
  cancel(): Promise<void> {
    return translateService.cancel();
  },
};
