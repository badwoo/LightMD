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
import { getWindowLabel } from "../utils/windowLabel";
import { useSettingsStore } from "../stores/useSettingsStore";
import {
  translateService,
  parseTranslateError,
  TranslateServiceError,
} from "./translateService";
import type { TranslateResultData } from "../stores/translateStore";
// v0.15.0 需求（AI 深度配置）：AI 连接档案解析（与翻译解耦）
import { resolveAiConnection } from "./aiProfiles";

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

    // v0.15.0 需求（AI 深度配置）：AI 助手改用**独立连接档案**（`settings.ai`），
    // 不再复用翻译的 provider/baseUrl/model —— 两者从此可以分别配置、互不影响。
    // 无可用档案时明确报错，而不是静默回退到翻译配置（那会让用户以为改的是 AI）。
    const { ai } = useSettingsStore.getState();
    const profile = resolveAiConnection(ai);
    if (!profile) {
      throw new TranslateServiceError({ code: "NO_KEY", detail: "ai-profile-missing" });
    }
    const channel = new Channel<string>();
    channel.onmessage = onChunk;

    try {
      return await invoke<TranslateResultData>("ai_assist_text", {
        task,
        text: trimmed,
        // v0.15.0：凭据按 profile 隔离（同 provider 不同 endpoint 不串 Key）
        credentialId: profile.credentialId,
        provider: profile.providerId ?? profile.id,
        authMode: profile.authMode,
        baseUrl: profile.baseUrl,
        model: profile.model,
        // 采样温度：未配置（undefined）时**不发**——推理档默认省略，
        // 由 Rust 侧按 requestPolicy 决定是否写进请求体
        // null = Rust 侧不发送 temperature（推理端点会因 temperature 400）
        temperature: profile.requestPolicy.temperature ?? null,
        // 上下文/输出预算（Rust 侧据此裁剪与限制 max tokens）
        contextWindowTokens: profile.contextWindowTokens,
        maxOutputTokens: profile.maxOutputTokens,
        tokenField: profile.requestPolicy.tokenField,
        reasoningEffort: profile.requestPolicy.reasoningEffort ?? null,
        includeStreamUsage: profile.requestPolicy.includeStreamUsage,
        protocol: profile.protocol,
        // 自定义 system：**显式参数**注入（不走 messages，不放宽 Rust 的 system 过滤）
        systemPrompt: profile.systemPrompt ?? null,
        // v0.9.0：单任务槽按窗口分桶（窗口 A 的续写/润色不顶掉窗口 B 的任务）
        windowLabel: getWindowLabel(),
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
