/**
 * aiChatStore —— AI 对话浮动窗状态（v0.7.5 功能1）
 *
 * 非 persist：仅管理窗口存活期内的 UI 状态（开关/位置/消息/流式）。
 * 窗口位置与尺寸的**持久化**在 useSettingsStore.aiChatWindow（功能6）；
 * 配置（Provider/Key）复用 useSettingsStore.translate 与 keyring。
 *
 * 关键决策（与实施计划 §2.4 一致）：
 * - 多轮但**不持久化**：关闭窗口即清空历史（窗口存活期内可多轮指代消解）
 * - 状态机与 translateStore/aiAssistStore 一致：idle → loading → streaming → done | error
 * - 上下文范围与预览快照存于本 store：实际文本在**发送那一刻**由入口层重新提取，
 *   预览仅供 chip 展示（可能因选区丢失而降级，见 degraded）
 */
import { create } from "zustand";
import type { AiChatContextScope, AiChatMessage } from "../services/aiChatService";
import type { TranslateResultData } from "./translateStore";
import type { AiChatWindowRect } from "./useSettingsStore";

export type AiChatStatus = "idle" | "loading" | "streaming" | "done" | "error";

/** 上下文 chip 展示快照（预览；实际发送时重新提取） */
export interface AiChatContextPreview {
  /** 用户选择的范围 */
  scope: AiChatContextScope;
  /** 实际生效范围（scope=selection 但选区已丢失 → document） */
  actualScope: AiChatContextScope;
  /** 预览文本字数 */
  chars: number;
  /** 是否因超上限被截断（chip 标注「已截断」） */
  truncated: boolean;
  /** 是否发生了选区丢失降级（chip 明示） */
  degraded: boolean;
}

/** 重新生成所需的上下文（由 store 派生，入口层据此重发） */
export interface AiChatRegenerateContext {
  /** 最后一条 user 消息之前的全部消息 */
  history: AiChatUiMessage[];
  /** 最后一条 user 指令（裸指令，不含上下文） */
  instruction: string;
}

/**
 * UI 层消息（在传输结构上附加生成元信息）
 *
 * meta 只在 UI 侧使用：动作条据此决定展示「替换选区」（发送时确有选区）与
 * 「替换全文」（来自「改写全文」模板）。发往 Rust 的 payload 由
 * aiChatService.buildChatRequestMessages 重建为仅 {role, content}，不带 meta。
 */
export interface AiChatUiMessage extends AiChatMessage {
  meta?: {
    /** 发送时是否携带了选区上下文 */
    hadSelection: boolean;
    /** 发送时的上下文范围 */
    scope: AiChatContextScope;
    /** 发送时所选的快捷指令模板 id（未用模板则为 null） */
    templateId: string | null;
  };
}

interface AiChatState {
  /** 窗口是否打开 */
  open: boolean;
  /** 是否收起为输入条 */
  minimized: boolean;
  /** 窗口位置/尺寸（null = 由组件按视口计算默认居中布局） */
  rect: AiChatWindowRect | null;
  /** 对话历史（user 存"裸指令"，不含文档上下文——见 aiChatService 注释） */
  messages: AiChatUiMessage[];
  status: AiChatStatus;
  /** 当前流式中的 assistant 文本（done 后并入 messages） */
  streamedText: string;
  errorCode: string | null;
  errorDetail: string | null;
  result: TranslateResultData | null;
  /** 上下文范围（chip 一键切换） */
  contextScope: AiChatContextScope;
  /** 上下文 chip 预览快照 */
  contextPreview: AiChatContextPreview | null;
  /** 归属文档路径（切文档时作废残留会话，防跨文档串写） */
  filePath: string | null;
  /** 本次请求的生成元信息（发起时写入，finish 时挂到 assistant 消息上） */
  pendingMeta: AiChatUiMessage["meta"] | null;

  /** 打开窗口并开始新会话（清空历史；rect 来自设置记忆，可为 null） */
  openWindow: (
    filePath: string | null,
    rect: AiChatWindowRect | null,
    contextScope?: AiChatContextScope
  ) => void;
  /** 关闭窗口（清空历史与流式状态；不取消任务——取消由入口层负责） */
  closeWindow: () => void;
  /** 折叠/展开（折叠态不取消进行中任务） */
  toggleMinimize: () => void;
  /** 更新窗口位置/尺寸（拖拽/缩放结束时调用；不落盘，落盘由入口层写设置） */
  setRect: (rect: AiChatWindowRect | null) => void;
  /** 切换上下文范围 */
  setContextScope: (scope: AiChatContextScope) => void;
  /** 更新上下文预览快照 */
  setContextPreview: (preview: AiChatContextPreview) => void;
  /** 整体替换历史（重新生成时裁剪用） */
  setMessages: (messages: AiChatUiMessage[]) => void;
  /** 追加一条用户指令（发起请求前调用，气泡立即显示） */
  appendUser: (content: string, meta?: AiChatUiMessage["meta"]) => void;
  /** 流式增量（loading → streaming 首次收到即切换） */
  appendChunk: (chunk: string) => void;
  /** 任务完成：assistant 消息入历史（带本次生成的 meta），清空流式缓冲 */
  finish: (result: TranslateResultData) => void;
  /** 任务失败 */
  fail: (errorCode: string, errorDetail?: string | null) => void;
  /** 取消/中断：回到可再次发送的状态（保留已有历史） */
  cancelStream: () => void;
  /** 派生出「重新生成」所需的历史与指令；无 user 消息时返回 null */
  regenerateContext: () => AiChatRegenerateContext | null;
}

export const useAiChatStore = create<AiChatState>((set, get) => ({
  open: false,
  minimized: false,
  rect: null,
  messages: [],
  status: "idle",
  streamedText: "",
  errorCode: null,
  errorDetail: null,
  result: null,
  contextScope: "document",
  contextPreview: null,
  filePath: null,
  pendingMeta: null,

  // 每次打开都是新会话：历史清空（v0.7.5 不持久化对话，见 §2.4 决策）
  openWindow: (filePath, rect, contextScope = "document") =>
    set({
      open: true,
      minimized: false,
      rect,
      messages: [],
      status: "idle",
      streamedText: "",
      errorCode: null,
      errorDetail: null,
      result: null,
      contextScope,
      contextPreview: null,
      filePath,
      pendingMeta: null,
    }),

  closeWindow: () =>
    set({
      open: false,
      minimized: false,
      messages: [],
      status: "idle",
      streamedText: "",
      errorCode: null,
      errorDetail: null,
      result: null,
      contextPreview: null,
      filePath: null,
      pendingMeta: null,
    }),

  toggleMinimize: () => set((s) => ({ minimized: !s.minimized })),

  setRect: (rect) => set({ rect }),

  setContextScope: (contextScope) => set({ contextScope }),

  setContextPreview: (contextPreview) => set({ contextPreview }),

  setMessages: (messages) => set({ messages }),

  appendUser: (content, meta) =>
    set((s) => ({
      messages: [...s.messages, meta ? { role: "user", content, meta } : { role: "user", content }],
      // 发起新一轮：清空上一轮的错误与流式缓冲，进入 loading
      status: "loading",
      streamedText: "",
      errorCode: null,
      errorDetail: null,
      pendingMeta: meta ?? null,
    })),

  appendChunk: (chunk) =>
    set((s) => ({
      status: s.status === "loading" ? "streaming" : s.status,
      streamedText: s.streamedText + chunk,
    })),

  finish: (result) =>
    set((s) => ({
      status: "done",
      result,
      // 流式文本并入历史（以回填后的最终文本为准，流式 tail 可能有细微差异）
      messages: [
        ...s.messages,
        s.pendingMeta
          ? { role: "assistant", content: result.translated, meta: s.pendingMeta }
          : { role: "assistant", content: result.translated },
      ],
      streamedText: "",
      pendingMeta: null,
    })),

  fail: (errorCode, errorDetail = null) =>
    set({ status: "error", errorCode, errorDetail, streamedText: "", pendingMeta: null }),

  // 用户主动停止 / 任务被新任务顶掉：保留已产出的可见文本但不入库
  // （半截回答不入历史，避免下一轮携带不完整上下文）
  cancelStream: () =>
    set({ status: "idle", streamedText: "", errorCode: null, errorDetail: null, pendingMeta: null }),

  regenerateContext: () => {
    const { messages } = get();
    // 末条为 assistant（正常情况）时视作待重生成；否则视作仅 user
    const lastUserIdx = (() => {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") return i;
      }
      return -1;
    })();
    if (lastUserIdx < 0) return null;
    return {
      history: messages.slice(0, lastUserIdx),
      instruction: messages[lastUserIdx].content,
    };
  },
}));
