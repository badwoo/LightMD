/**
 * v0.8.3 需求2：「打开的文件」栏键盘选中项（selectedTempIdx）的失效判定。
 *
 * 背景（双高亮根因）：
 * - 栏内点击条目 A：A 同时获得 `active`（activeItemKey 派生）与 `selected`
 *   （selectedTempIdx）两个类，两者背景色相同 → 视觉上只有一个高亮，正常；
 * - 之后从**标签栏**切到文件 B：`active` 移到 B，而 selectedTempIdx 仍停留在 A，
 *   A 继续显示 `selected` 背景 → 栏内两个条目同时高亮，视觉混乱。
 *
 * 修复原则：selectedTempIdx 是"键盘操作目标"（Delete / Ctrl+2 / 右键菜单），
 * 必须跟随激活条目失效；但**不能**在"栏内点击自己导致激活"时误清，
 * 否则"点击 A → 直接按 Delete"会失去目标（键盘语义回退）。
 *
 * 因此需要一个来源判据：本次激活是否由栏内点击产生（clickOriginKey）。
 * 判定抽为纯函数以便单测覆盖，避免把时序逻辑埋在 effect 里无法验证。
 */

/**
 * 激活条目变化时是否应清空键盘选中项。
 *
 * @param activeItemKey 当前激活条目的统一判定键（null = 无激活标签）
 * @param clickOriginKey 最近一次栏内点击的条目键（null = 最近一次激活不来自栏内点击）
 * @returns true = 清空 selectedTempIdx
 */
export function shouldResetTempSelection(
  activeItemKey: string | null,
  clickOriginKey: string | null,
): boolean {
  // 无激活标签（全部关闭）→ 键盘目标必然失效
  if (activeItemKey === null) return true;
  // 激活正是本次栏内点击产生的 → 保留键盘目标
  return activeItemKey !== clickOriginKey;
}
