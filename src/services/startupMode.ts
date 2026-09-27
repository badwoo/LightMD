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

/**
 * v0.9.0 第二轮修复（问题1）：窗口引导流程结束时，是否应当结束「会话恢复期」
 * （即复位 `sessionRestoringRef`）。
 *
 * 为什么 legacy 必须延后：`legacy` 模式的恢复流程（临时标签 → 最近文件 → 活跃标签）
 * 是在 `setStartupMode("legacy")` **之后**才由 App 的 effect 启动的。若引导流程的
 * finally 当场复位标志，恢复期派发的 `lightmd:openFile` 就会走「首次打开 → 清空浏览
 * 进度」分支，把刚刚 `loadSnapshot()` 注入的跨会话阅读位置逐个清掉——用户感知为
 * "重开软件后所有标签的阅读位置都重置了"。legacy 的复位因此交给「最近文件恢复」
 * effect 的 finally。
 *
 * `session` / `skip`（含 `null` = 尚未决定，例如引导流程异常）都必须在这里复位，
 * 否则窗口会永久停在恢复期：冲突检测失效、重新打开文件不再重置浏览进度。
 */
export function shouldEndRestoreWindowOnBoot(appliedMode: StartupMode | null): boolean {
  return appliedMode !== "legacy";
}
