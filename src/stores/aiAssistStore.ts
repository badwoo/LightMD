/**
 * aiAssistStore —— AI 助手气泡状态（v0.7.0：续写 / 润色 / 摘要）
 *
 * 非 persist：仅管理进行中 AI 任务的 UI 状态（任务类型/流式文本/错误/结果）。
 * 配置持久化在 useSettingsStore.translate（与 AI 翻译共用）；Key 在 keyring。
 * 状态机与 translateStore 保持一致（loading → streaming → done | error）。
 */
import { create } from "zustand";
import type { AiTask } from "../services/aiAssistService";
import type { TranslateResultData, BubbleAnchor } from "./translateStore";

export type AiAssistStatus = "idle" | "loading" | "streaming" | "done" | "error";

/**
 * AI 助手来源通道：
 * - pm = ProseMirror 阅读模式（Markdown 结构保真）
 * - source = textarea 源码模式（edit/split，结果为 Markdown 源码直接回写）
 */
export type AiAssistSourceMode = "pm" | "source";

interface AiAssistState {
  status: AiAssistStatus;
  /** 当前任务类型（气泡标题与按钮文案据此切换） */
  task: AiTask;
  sourceMode: AiAssistSourceMode;
  streamedText: string;
  errorCode: string | null;
  errorDetail: string | null;
  result: TranslateResultData | null;
  anchor: BubbleAnchor | null;
  /** v0.7.4：摘要气泡所属文档路径（切到其他文档时不显示，切回仍保留；应用/复制时校验归属） */
  filePath: string | null;

  /** 打开气泡并进入 loading（入口触发任务前调用） */
  openBubble: (task: AiTask, sourceMode: AiAssistSourceMode, anchor: BubbleAnchor, filePath?: string | null) => void;
  /** 流式增量 */
  appendChunk: (chunk: string) => void;
  /** 任务完成 */
  finish: (result: TranslateResultData) => void;
  /** 任务失败 */
  fail: (errorCode: string, errorDetail?: string | null) => void;
  /** 关闭气泡（不取消任务；取消由 aiAssistService.cancel 负责） */
  close: () => void;
  /** v0.7.4 修复5：滚动时更新锚点屏幕坐标（摘要虚线/圆点跟随选区）。
   * 坐标无变化时直接返回原 state，不触发订阅者重渲染。 */
  setAnchor: (anchor: BubbleAnchor) => void;
}

export const useAiAssistStore = create<AiAssistState>((set) => ({
  status: "idle",
  task: "continue",
  sourceMode: "pm",
  streamedText: "",
  errorCode: null,
  errorDetail: null,
  result: null,
  anchor: null,
  filePath: null,

  openBubble: (task, sourceMode, anchor, filePath = null) =>
    set({
      status: "loading",
      task,
      sourceMode,
      streamedText: "",
      errorCode: null,
      errorDetail: null,
      result: null,
      anchor,
      filePath,
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
      filePath: null,
    }),

  // v0.7.4 修复5：坐标未变化时返回原 state（引用不变 → zustand 跳过通知，零重渲染）
  setAnchor: (anchor) =>
    set((s) => {
      const prev = s.anchor;
      if (prev && prev.x === anchor.x && prev.y === anchor.y) return s;
      return { anchor };
    }),
}));
