/**
 * v0.12.0 需求2：格式刷状态（zustand）
 *
 * 放 store 而非组件 state 的原因：跨模式共享（PM 采集 → 源码应用、反向亦可），
 * 且采集在 PM 插件/右键菜单侧、应用在 React 事件侧，需要统一的可订阅状态。
 *
 * 状态机：
 * - idle：未激活
 * - once：单击入场（Word 默认语义），应用一次后自动回 idle
 * - persistent：双击入场，可连续应用；每次应用递减 remaining，
 *   归零自动回 idle；Esc / 再次双击 / 切文件切模式 → idle
 */
import { create } from "zustand";
import {
  nextFormatPainterMode,
  FORMAT_PAINTER_MAX_USES,
  type FormatPainterMode,
  type FormatSnapshot,
} from "../utils/formatPainter";

interface FormatPainterState {
  /** 采集到的格式快照（persistent 模式应用后不清空） */
  snapshot: FormatSnapshot | null;
  mode: FormatPainterMode;
  /** persistent 模式剩余可应用次数 */
  remaining: number;
  /** 单击入口：进入 once 模式 */
  armOnce: (snapshot: FormatSnapshot) => void;
  /** 双击入口：进入 persistent 模式（剩余次数重置） */
  armPersistent: (snapshot: FormatSnapshot) => void;
  /** 应用一次后调用：once → idle；persistent → 递减，归零 → idle */
  consume: () => void;
  /** 退出（Esc / 切文件 / 切模式） */
  exit: () => void;
}

export const useFormatPainterStore = create<FormatPainterState>()((set) => ({
  snapshot: null,
  mode: "idle",
  remaining: 0,
  armOnce: (snapshot) =>
    set({ snapshot, mode: nextFormatPainterMode("arm-once", "idle"), remaining: 0 }),
  armPersistent: (snapshot) =>
    set({
      snapshot,
      mode: nextFormatPainterMode("arm-persistent", "idle"),
      remaining: FORMAT_PAINTER_MAX_USES,
    }),
  consume: () =>
    set((s) => {
      if (s.mode !== "persistent") {
        return { mode: nextFormatPainterMode("apply", s.mode), snapshot: null, remaining: 0 };
      }
      const remaining = s.remaining - 1;
      if (remaining <= 0) {
        // 次数归零自动退出（防无限模式误用）
        return { mode: "idle", snapshot: null, remaining: 0 };
      }
      return { remaining };
    }),
  exit: () => set({ mode: "idle", snapshot: null, remaining: 0 }),
}));