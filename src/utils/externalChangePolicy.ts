/**
 * v0.13.0 需求2：文件被**外部**修改后的处理策略（纯逻辑层）。
 *
 * ## 背景
 *
 * v0.9.0 以来只有一条规则：干净标签自动重载，脏标签只标记「保存前请确认」。
 * 用户反馈「外部改了就该以最新为准」，但自动重载脏标签会**静默丢弃本地未保存
 * 修改**——那同样是数据丢失。所以策略必须让用户在两者之间**知情选择**。
 *
 * ## 三选一
 *
 * | 策略 | 干净标签 | 脏标签 |
 * | --- | --- | --- |
 * | `reload-clean`（默认，v0.9.0 行为） | 自动重载 | 仅标记 + 提示 |
 * | `always-reload` | 自动重载 | 弹「取最新 / 保留本地 / 另存为」 |
 * | `ask` | 弹「取最新 / 保留本地」 | 弹「取最新 / 保留本地 / 另存为」 |
 */

export type ExternalChangePolicy = "reload-clean" | "always-reload" | "ask";

/** 一个标签被外部修改时应该采取的动作 */
export type ExternalChangeAction =
  /** 自动重载（干净标签、无本地修改可丢） */
  | "reload"
  /** 只标记「保存前请确认」，不动内容 */
  | "markOnly"
  /** 弹三选对话框：取最新 / 保留本地 / 另存为 */
  | "askThreeWay";

/**
 * 决定某个标签遇到外部修改时的动作。
 *
 * @param policy 用户设置的处理策略
 * @param tabIsDirty 该标签是否有未保存修改
 * @returns 应执行的动作
 */
export function decideExternalChangeAction(
  policy: ExternalChangePolicy,
  tabIsDirty: boolean,
): ExternalChangeAction {
  if (policy === "ask") return "askThreeWay";
  if (policy === "always-reload") return tabIsDirty ? "askThreeWay" : "reload";
  // reload-clean（默认）
  return tabIsDirty ? "markOnly" : "reload";
}

/** 「取最新」三选对话框的结果 */
export type ExternalChangeChoice = "takeLatest" | "keepLocal" | "saveAs";

/**
 * 把对话框返回值映射为后续动作（纯函数，便于单测）。
 *
 * @returns
 * - `"reload"`：用磁盘内容替换标签内容并清脏标记；
 * - `"none"`：什么都不做（保留本地编辑，标记已在弹窗前置好）；
 * - `"saveAs"`：把本地编辑另存到新文件（随后由调用方接管）。
 */
export function applyExternalChangeChoice(
  choice: ExternalChangeChoice,
): "reload" | "none" | "saveAs" {
  if (choice === "takeLatest") return "reload";
  if (choice === "saveAs") return "saveAs";
  return "none";
}
