/**
 * modeSwitch —— 双击模式切换判定（v0.6.1 问题6）
 *
 * Bug 场景：长按 Ctrl/Shift 时浏览器持续派发 repeat keydown（e.repeat=true），
 * 旧逻辑每次都刷新时间戳并判定"双击"，导致模式连续切换。
 *
 * 修复语义：
 * - "skip"：长按产生的 repeat 事件，完全忽略（不刷新时间戳，
 *   避免长按结束后紧接着的单击被误判为双击）
 * - "toggle"：真实的 300ms 内第二次按下，触发模式切换
 * - "record"：第一次按下，记录时间戳
 */

/** 双击判定三态结果 */
export type DoublePressResult = "skip" | "toggle" | "record";

/** 双击阈值（ms），与 App.tsx 的 DOUBLE_CLICK_THRESHOLD 一致 */
export const DOUBLE_PRESS_THRESHOLD = 300;

/**
 * 判定一次修饰键按下应如何处理（纯函数）。
 * @param now 本次按键时间戳
 * @param lastTime 上次有效按下时间戳（0 表示无）
 * @param threshold 双击判定窗口（ms）
 * @param isRepeat 浏览器自动重复的 keydown（e.repeat）
 */
export function evalDoublePress(
  now: number,
  lastTime: number,
  threshold: number,
  isRepeat: boolean
): DoublePressResult {
  // 长按 repeat：完全忽略，不刷新时间戳
  if (isRepeat) return "skip";
  // 无上次按下记录（lastTime<=0 视为未记录，避免时间起点为 0 时误判）
  if (lastTime <= 0) return "record";
  if (now - lastTime < threshold) return "toggle";
  return "record";
}
