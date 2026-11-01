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

// ─── v0.15.4 需求9：对话上下文「自动跟随选区」的纯逻辑 ─────────────
//
// 背景（用户实测 bug）：未选内容打开对话时上下文永远停在「全文」，
// 之后在编辑器里选中文本也不生效。根因有三：
// 1. 打开时按「有无选区」只算一次默认范围（document），之后从不跟随；
// 2. 选区变化监听里只要焦点在对话框内就整体 `return` —— 用户点过输入框后
//    焦点长期在窗内，之后在编辑器选区变化**再也不会刷新**；
// 3. chip 一旦是 document 就不会自动回到 selection。
//
// 修法把决策抽成纯函数（EditorContainer 只负责取签名/取文本）：
// - 用「选区签名」辨别**真实选区变化**：只有非空选区才带 from/to；
//   光标移动（空选区）与对话框内的选字都不改变签名 → 绝不动用户的选择；
// - 真实变化 → 自动跟随（有选区→选区；无选区→回落全文），并解除手动锁定；
// - 用户手动点 chip / 指令作用域 → 锁定，直到下一次真实选区变化；
// - 发送那一刻按当下选区再判一次（chip 的 250ms 防抖可能滞后）。

/** 选区签名（mode 用于区分 PM 与源码 textarea 两条通道） */
export function chatSelectionSignature(mode: "pm" | "source", from: number, to: number): string {
  // 空选区（光标）统一成一个值：光标移动不算「选区变化」
  const anchor = to > from ? `${from}:${to}` : "";
  return `${mode}:${anchor}`;
}

/** 自动跟随的目标范围：有可用选区 → 选区；否则回落全文 */
export function resolveAutoFollowScope(hasSelection: boolean): AiChatContextScope {
  return hasSelection ? "selection" : "document";
}

/**
 * 选区变化后的范围决策（纯函数，可测试）。
 *
 * @returns 需要切换到的范围；`null` = 这不是一次真实选区变化，不要覆盖用户当前选择
 */
export function planChatSelectionChange(input: {
  prevSignature: string;
  nextSignature: string;
  hasSelection: boolean;
}): AiChatContextScope | null {
  if (input.nextSignature === input.prevSignature) return null;
  return resolveAutoFollowScope(input.hasSelection);
}

/**
 * 发送那一刻实际使用的范围（纯函数，可测试）。
 *
 * - 自动跟随中 → 以发送时的真实选区重判（防 250ms 防抖窗口内 chip 尚未刷新）；
 * - 用户手动锁定 → 尊重用户点 chip / 指令作用域的决定，不擅自改。
 */
export function resolveChatSendScope(
  currentScope: AiChatContextScope,
  autoFollow: boolean,
  hasSelection: boolean
): AiChatContextScope {
  if (!autoFollow) return currentScope;
  return resolveAutoFollowScope(hasSelection);
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

    // v0.15.0 需求（AI 深度配置）：对话同样改用独立连接档案 `settings.ai`。
    // AI 对话是"护城河"功能，与翻译共用配置会让用户改翻译时意外改坏对话模型。
    const { ai } = useSettingsStore.getState();
    const profile = resolveAiConnection(ai);
    if (!profile) {
      throw new TranslateServiceError({ code: "NO_KEY", detail: "ai-profile-missing" });
    }
    const channel = new Channel<string>();
    channel.onmessage = onChunk;

    try {
      return await invoke<TranslateResultData>("ai_chat", {
        messages,
        // v0.15.0：凭据按 profile 隔离；协议/预算/推理档随档案透传
        credentialId: profile.credentialId,
        provider: profile.providerId ?? profile.id,
        authMode: profile.authMode,
        baseUrl: profile.baseUrl,
        model: profile.model,
        // null = Rust 侧不发送 temperature（推理端点会因 temperature 400）
        temperature: profile.requestPolicy.temperature ?? null,
        contextWindowTokens: profile.contextWindowTokens,
        maxOutputTokens: profile.maxOutputTokens,
        tokenField: profile.requestPolicy.tokenField,
        reasoningEffort: profile.requestPolicy.reasoningEffort ?? null,
        includeStreamUsage: profile.requestPolicy.includeStreamUsage,
        protocol: profile.protocol,
        // 自定义 system：显式参数注入（messages 里的伪造 system 仍由 Rust 过滤）
        systemPrompt: profile.systemPrompt ?? null,
        // v0.9.0：单任务槽按窗口分桶（AC-14：窗口 A 全文翻译时 B 仍可对话）
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
