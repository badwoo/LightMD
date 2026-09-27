/**
 * v0.9.0 WP8：窗口启动恢复模式决策（纯函数，便于单测）。
 *
 * 三种模式：
 * - `session`：按 `session.json` 精确恢复（多窗口会话 / 会话恢复窗口）
 * - `legacy`：v0.8.5 路径（临时标签 → 最近文件 → 上次活跃标签 → 最近文件夹）
 * - `skip`：不恢复任何标签（用户关闭了「启动载入上次文件」，或辅助窗口）
 *
 * 规则优先级（顺序即语义）：
 * 1. `bootRestore`（本窗口是会话恢复窗口）→ `session`；
 * 2. 非主窗口 → `skip`（辅助窗口的初始内容只来自引导数据：指定文件 / 迁移标签）；
 * 3. 主窗口关闭了恢复开关 → `skip`（REG-3：不恢复任何标签，含临时标签）；
 * 4. 主窗口存在多窗口会话 → `session`（**替代** v0.8.5 的 recentFiles 近似恢复）；
 * 5. 其余（纯单窗口用户）→ `legacy`（完全保持 v0.8.5 行为，REG-1）。
 */
export type StartupMode = "session" | "legacy" | "skip";

export interface StartupModeInput {
  /** 本窗口是否为主窗口（label === "main"） */
  isMain: boolean;
  /** 引导数据要求本窗口按会话恢复（`WindowBoot.restore`） */
  bootRestore: boolean;
  /** 「启动载入上次文件」开关（`loadLastFileOnStartup`） */
  restoreEnabled: boolean;
  /** 磁盘上是否存在上次多窗口会话（`has_session`） */
  hasSession: boolean;
}

export function decideStartupMode(input: StartupModeInput): StartupMode {
  if (input.bootRestore) return "session";
  if (!input.isMain) return "skip";
  if (!input.restoreEnabled) return "skip";
  if (input.hasSession) return "session";
  return "legacy";
}
