/**
 * 撤销时间线的**诊断埋点**（v0.17.0 P1-2 取证期临时插桩）
 *
 * ## 为什么需要它
 *
 * P1-2（交替 undo/redo 每两次只有一次生效）的现象只能在**实机**复现：
 * `documentHistory` 是 ESM 模块，打包产物里拿不到句柄，探针无法从页面侧读游标。
 * 唯一可靠的取证方式是**在源码的关键决策点上记录事件**，再让探针从页面读回。
 *
 * ## 开关语义（务必保持）
 *
 * 埋点**只在宿主显式安装接收器时**才有任何行为：
 *
 * ```js
 * // 探针侧（CDP evaluate）
 * window.__LMD_HIST_TRACE = [];
 * ```
 *
 * 未安装时 `histTrace()` 只做一次 `Array.isArray` 判定就返回 —— 生产环境
 * （用户安装版）永远不装这个数组，因此**零日志、零字符串拼接、零副作用**。
 * 这也是它没有被 `import.meta.env.DEV` 包起来的原因：那样就没法在 release exe 上取证了
 * （而 P1-2 恰恰只能在 release exe 上复现 —— dev server 下时序不同）。
 *
 * ## 清理约定
 *
 * 取证完成后，调用点应删除；若保留，必须维持"无接收器即无操作"的性质。
 */

/** 单次会话最多累积多少条（防止长时间运行把内存吃穿） */
export const HISTORY_TRACE_LIMIT = 8000;

/** 事件形状：`event` + 单调时钟 + 任意字段 */
export interface HistoryTraceRecord {
  event: string;
  t: number;
  [key: string]: unknown;
}

/** 时间线状态摘要（每条 trace 都带上，便于对齐"键击 ↔ 游标"） */
export interface TimelineSnapshot {
  /** 条目总数 */
  n: number;
  /** 游标（`entries[0..cursor)` 已应用） */
  cur: number;
  /** 时间线认为的宿主文本长度 */
  known: number;
  /** 栈顶条目 id（诊断合并/新增用） */
  topId: number | null;
}

function sink(): unknown[] | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { __LMD_HIST_TRACE?: unknown };
  return Array.isArray(w.__LMD_HIST_TRACE) ? (w.__LMD_HIST_TRACE as unknown[]) : null;
}

/** 是否已安装接收器（热路径可以先判一次再决定要不要算参数） */
export function histTraceEnabled(): boolean {
  return sink() !== null;
}

/** 记一条事件；未安装接收器时立即返回 */
export function histTrace(event: string, data?: Record<string, unknown>): void {
  const s = sink();
  if (!s) return;
  if (s.length >= HISTORY_TRACE_LIMIT) return;
  s.push({ event, t: Math.round(performance.now() * 10) / 10, ...data });
}
