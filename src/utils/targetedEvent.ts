/**
 * v0.9.0：定向事件载荷的解包与过滤。
 *
 * ## 为什么需要它（实机测试发现的缺陷）
 *
 * Tauri v2 的 `emit_to(label, event, payload)` **不能**把事件限制在单个 webview 内：
 * 它只过滤「监听器注册时声明的目标」，而 JS 侧 `listen(name)` 注册的目标是
 * `EventTarget::Any`，于是**所有窗口**都会收到本该只发给某一个窗口的定向事件。
 *
 * 症状（v0.9.0 实机测试实际观察到的）：
 * - 关闭主窗口 → 所有窗口一起确认关闭 → 应用整体退出（AC-16 失败）；
 * - 双击一个关联文件 → 每个窗口都打开同一个文件（AC-4 失效）；
 * - 「跨窗口移动标签」→ 全部窗口重复接收迁移标签。
 *
 * 解法：定向事件一律由 Rust 侧包成 `{ target, payload }`，前端按自身 label 过滤。
 */

import { getWindowLabel } from "./windowLabel";

/** Rust 侧 `emit_to_window` 产生的定向事件载荷外壳 */
export interface TargetedEnvelope<T> {
  target: string;
  payload: T;
}

/**
 * 解包定向事件载荷。
 *
 * - 带 `target` 且与**本窗口 label 不同** → 返回 `null`（调用方应直接忽略）；
 * - 带 `target` 且匹配 → 返回内层 `payload`；
 * - 无 `target`（旧式广播载荷/兼容路径）→ 原样返回，避免漏事件。
 */
export function unwrapTargetedEvent<T>(raw: unknown): T | null {
  if (raw === null || raw === undefined) return null;
  // 原始类型载荷不可能是定向事件外壳（Rust 侧一律包成对象）→ 按兼容路径原样返回
  if (typeof raw !== "object") return raw as T;
  const obj = raw as { target?: unknown; payload?: unknown };
  if (typeof obj.target === "string") {
    if (obj.target !== getWindowLabel()) return null;
    return (obj.payload ?? null) as T | null;
  }
  return raw as T;
}

/** 构造定向事件载荷（前端 → Rust `emit_to_window` 命令的入参，自测/工具用） */
export function targetedEnvelope<T>(target: string, payload: T): TargetedEnvelope<T> {
  return { target, payload };
}
