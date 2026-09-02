/**
 * fullTranslateStore —— 全文翻译进度状态（v0.6.1）
 *
 * 非 persist：仅管理全文翻译任务的进度/错误 UI 状态（状态栏显示用）。
 * v0.6.4：状态机调整为 idle → running → done（含段级失败也算完成，失败段
 * 由编辑器内气泡逐段提示，底部栏不再显示"段翻译失败"）；系统性错误（AUTH 等）
 * 仍走 error 态。done 态由 StatusBar 2 秒后自动 reset。
 */
import { create } from "zustand";

export type FullTranslateStatus = "idle" | "running" | "done" | "error";

interface FullTranslateState {
  status: FullTranslateStatus;
  /** 已完成段数（含失败段） */
  doneCount: number;
  /** 总段数 */
  totalCount: number;
  /** 系统性错误码（i18n 文案键索引） */
  errorCode: string | null;
  /** 部分段失败的提示文案参数（0 = 无） */
  failedCount: number;
  /** 用户取消请求标志（执行循环每次迭代前检查） */
  cancelRequested: boolean;

  /** 开始全文翻译任务 */
  start: (total: number) => void;
  /** 完成一段 */
  tick: () => void;
  /** 任务正常结束（成功或含段级失败收尾）→ done 态（底部栏"翻译完成 ✓"） */
  finish: (failedCount: number) => void;
  /** 系统性失败 */
  fail: (errorCode: string) => void;
  /** 请求取消（配合 translateService.cancel 由调用方执行） */
  requestCancel: () => void;
  /** 清除提示（状态栏 ✕ 点击 / done 2 秒自动消失 / 切换文档） */
  reset: () => void;
}

const IDLE = {
  status: "idle" as FullTranslateStatus,
  doneCount: 0,
  totalCount: 0,
  errorCode: null,
  failedCount: 0,
  cancelRequested: false,
};

export const useFullTranslateStore = create<FullTranslateState>((set) => ({
  ...IDLE,

  start: (total) =>
    set({ status: "running", doneCount: 0, totalCount: total, errorCode: null, failedCount: 0, cancelRequested: false }),

  tick: () => set((s) => ({ doneCount: s.doneCount + 1 })),

  // v0.6.4：段级失败不再置 error（底部栏不显示失败）；failedCount 供编辑器气泡提示
  finish: (failedCount) =>
    set({ status: "done", failedCount, cancelRequested: false }),

  fail: (errorCode) => set({ status: "error", errorCode, cancelRequested: false }),

  requestCancel: () => set({ cancelRequested: true }),

  reset: () => set({ ...IDLE }),
}));
