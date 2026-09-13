/**
 * aiChatService —— AI 对话前端服务（v0.7.5 功能1）
 *
 * 职责：
 * - 封装 ai_chat 流式调用（Channel 接收增量，与 AI 翻译/助手同一错误码协议）
 * - 上下文策略（功能4）：三档范围 + 上限截断（选区 4000 字 / 全文 20000 字）
 * - 历史截断：只携带最近 3 轮（6 条消息），控制 token；超出丢弃最早轮次
 * - 消息组装：历史保持"裸指令"（不带文档），文档上下文仅挂在**当前**这条 user
 *   消息上——否则每一轮都重复整篇文档，token 成本随轮数线性膨胀
 * - 前置校验：空指令 / 超长 / 非 Tauri 环境直接抛错（不发 invoke 省 token）
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

/** 对话上下文范围（功能4 三档） */
export type AiChatContextScope = "selection" | "document" | "none";

/** 单条对话消息（与 Rust 侧 ChatMessage 一一对应；system 由 Rust 注入） */
export interface AiChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** 选区上下文上限（字符数，与选中翻译 MAX_SELECTION_CHARS 一致） */
export const MAX_CHAT_SELECTION_CHARS = 4000;
/** 全文上下文上限（字符数；超出截断并在 chip 标注「已截断」） */
export const MAX_CHAT_DOCUMENT_CHARS = 20000;
/** 携带的历史消息条数上限（最近 3 轮 = 3 问 + 3 答） */
export const MAX_CHAT_HISTORY_MESSAGES = 6;
/** 单条指令长度上限（防误粘贴超长文本） */
export const MAX_CHAT_INSTRUCTION_CHARS = 4000;

/** 上下文分隔标记（system 提示词为中文，标记语言与之一致） */
export const CHAT_CONTEXT_MARKER = "【上下文】";

/** 各范围的上下文字符上限 */
export function chatContextLimit(scope: AiChatContextScope): number {
  if (scope === "selection") return MAX_CHAT_SELECTION_CHARS;
  if (scope === "document") return MAX_CHAT_DOCUMENT_CHARS;
  return 0;
}

/** 上下文截断结果 */
export interface ChatContextSlice {
  text: string;
  /** 是否发生截断（chip 据此标注「已截断」） */
  truncated: boolean;
}

/**
 * 按范围截断上下文（纯函数，可测试）。
 * - none：空文本
 * - selection：4000 字上限
 * - document：20000 字上限
 * 截断按"字符"（与中文场景一致，非 UTF-16 码元），避免切断代理对。
 */
export function truncateChatContext(
  text: string,
  scope: AiChatContextScope
): ChatContextSlice {
  const limit = chatContextLimit(scope);
  if (limit <= 0) return { text: "", truncated: false };
  const trimmed = text ?? "";
  const chars = Array.from(trimmed);
  if (chars.length <= limit) return { text: trimmed, truncated: false };
  return { text: chars.slice(0, limit).join(""), truncated: true };
}

/**
 * 历史截断（纯函数，可测试）：保留最近 MAX_CHAT_HISTORY_MESSAGES 条。
 * 截断后若首条是 assistant，则丢弃它——历史必须以 user 开头，
 * 否则部分厂商（OpenAI 兼容层）会因角色顺序异常报 400。
 *
 * 返回值为**重建**的裸消息（仅 role/content）：UI 层消息可能带 meta 等
 * 展示字段，不能直接进 IPC 载荷（避免把无关字段发给厂商）。
 */
export function trimChatHistory(messages: AiChatMessage[]): AiChatMessage[] {
  const bare = messages.map((m) => ({ role: m.role, content: m.content }));
  if (bare.length <= MAX_CHAT_HISTORY_MESSAGES) return bare;
  const tail = bare.slice(bare.length - MAX_CHAT_HISTORY_MESSAGES);
  while (tail.length > 0 && tail[0].role === "assistant") tail.shift();
  return tail;
}

/**
 * 组装本次请求的 messages（纯函数，可测试）
 *
 * 顺序：[...裁断后的历史（裸指令）, 当前 user 消息（指令 + 上下文）]
 * system 由 Rust 侧置于最前，前端不构造 system。
 */
export function buildChatRequestMessages(
  history: AiChatMessage[],
  instruction: string,
  context: ChatContextSlice
): AiChatMessage[] {
  const trimmed = instruction.trim();
  const ctx = context.text.trim();
  const content = ctx ? `${trimmed}\n\n${CHAT_CONTEXT_MARKER}\n${ctx}` : trimmed;
  return [...trimChatHistory(history), { role: "user", content }];
}

/** 选区是否足以作为上下文（非空且非纯空白） */
export function hasUsableContext(text: string | null | undefined): boolean {
  return typeof text === "string" && text.trim().length > 0;
}

export const aiChatService = {
  /**
   * 发送一次对话请求（流式）。
   * @param messages 已组装好的消息（含历史与当前指令；system 由 Rust 注入）
   * @param onChunk  流式增量回调
   */
  async send(
    messages: AiChatMessage[],
    onChunk: (chunk: string) => void
  ): Promise<TranslateResultData> {
    // 前置校验：无 user 消息不发请求（省 token）
    const hasUser = messages.some((m) => m.role === "user" && m.content.trim());
    if (!hasUser) {
      throw new TranslateServiceError({ code: "EMPTY", detail: "" });
    }
    const last = messages[messages.length - 1];
    if (last && last.content.length > MAX_CHAT_INSTRUCTION_CHARS + MAX_CHAT_DOCUMENT_CHARS) {
      throw new TranslateServiceError({ code: "TOO_LONG", detail: "" });
    }
    if (!isTauri()) {
      throw new TranslateServiceError({ code: "NETWORK", detail: "non-tauri" });
    }

    // 单任务模型：新任务自动取消旧任务（与翻译/助手共享任务槽）
    await translateService.cancel().catch(() => undefined);

    const cfg = useSettingsStore.getState().translate;
    const channel = new Channel<string>();
    channel.onmessage = onChunk;

    try {
      return await invoke<TranslateResultData>("ai_chat", {
        messages,
        // v0.7.2 P1：Key 按厂商独立存储，与翻译共用 translateProviderPreset
        provider: cfg.translateProviderPreset,
        baseUrl: cfg.translateBaseUrl,
        model: cfg.translateModel,
        // v0.7.3：采样温度由设置透传（Rust 侧对话再抬到 ≥0.3）
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
