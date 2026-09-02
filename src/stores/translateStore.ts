/**
 * translateStore —— AI 翻译气泡状态（v0.6.0）
 *
 * 非 persist：仅管理进行中翻译任务的 UI 状态（流式文本/错误/结果）。
 * 配置持久化在 useSettingsStore.translate；Key 在 keyring。
 */
import { create } from "zustand";

export type TranslateStatus = "idle" | "loading" | "streaming" | "done" | "error";
/**
 * 翻译来源通道：
 * - pm = ProseMirror 阅读模式（Markdown 结构保真）
 * - source = textarea 源码模式（edit/split，译文为 Markdown 源码直接回写）
 * - preview = split 模式 iframe 预览（纯文本，仅支持复制）
 */
export type TranslateSourceMode = "pm" | "source" | "preview";

/** 后端返回的翻译结果（translate_text 的返回值） */
export interface TranslateResultData {
  translated: string;
  placeholdersIntact: boolean;
  finishReason: string;
  promptTokens: number;
  completionTokens: number;
}

/** 气泡锚点（视口坐标，浮动按钮/选区末尾位置） */
export interface BubbleAnchor {
  x: number;
  y: number;
}

interface TranslateState {
  status: TranslateStatus;
  sourceMode: TranslateSourceMode;
  streamedText: string;
  /** 展示用错误信息（已按错误码转为本地化文案的原始输入） */
  errorCode: string | null;
  errorDetail: string | null;
  result: TranslateResultData | null;
  anchor: BubbleAnchor | null;

  /** 打开气泡并进入 loading（入口触发翻译前调用） */
  openBubble: (sourceMode: TranslateSourceMode, anchor: BubbleAnchor) => void;
  /** 流式增量（含 {{N}} 占位符透传） */
  appendChunk: (chunk: string) => void;
  /** 翻译完成 */
  finish: (result: TranslateResultData) => void;
  /** 翻译失败 */
  fail: (errorCode: string, errorDetail?: string | null) => void;
  /** 关闭气泡（不取消任务；取消由 translateService.cancel 负责） */
  close: () => void;
  /** 气泡锚点重定位（选区/滚动变化时） */
  setAnchor: (anchor: BubbleAnchor) => void;
}

export const useTranslateStore = create<TranslateState>((set) => ({
  status: "idle",
  sourceMode: "pm",
  streamedText: "",
  errorCode: null,
  errorDetail: null,
  result: null,
  anchor: null,

  openBubble: (sourceMode, anchor) =>
    set({
      status: "loading",
      sourceMode,
      streamedText: "",
      errorCode: null,
      errorDetail: null,
      result: null,
      anchor,
    }),

  appendChunk: (chunk) =>
    set((s) => ({
      // loading → streaming 首次收到增量即切换
      status: s.status === "loading" ? "streaming" : s.status,
      streamedText: s.streamedText + chunk,
    })),

  finish: (result) => set({ status: "done", result }),

  fail: (errorCode, errorDetail = null) =>
    set({ status: "error", errorCode, errorDetail }),

  close: () =>
    set({
      status: "idle",
      streamedText: "",
      errorCode: null,
      errorDetail: null,
      result: null,
      anchor: null,
    }),

  setAnchor: (anchor) => set({ anchor }),
}));
