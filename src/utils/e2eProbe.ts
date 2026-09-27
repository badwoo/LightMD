/**
 * v0.9.0：E2E 就绪标记（仅写入 `<html>` 的 data-* 属性，不参与任何业务逻辑）。
 *
 * 背景：多窗口的定向事件（关闭请求 / 激活标签 / 跨窗口迁移标签 / 外部文件路由）
 * 都依赖「窗口挂载后异步注册 Tauri 事件监听」。若某个监听注册失败，症状是
 * **静默失效**（点关闭按钮没反应、双击文件不打开），在打包后的应用里既没有
 * 控制台也没有日志，极难定位。
 *
 * 因此把「关键监听是否就绪」暴露成 DOM 属性，供实机 E2E 测试断言：
 * `document.documentElement.dataset.lightmdListeners` 形如 `"close,activateTab"`。
 */

const READY = new Set<string>();

/** 标记某个事件监听已注册成功 */
export function markListenerReady(name: string): void {
  READY.add(name);
  try {
    if (typeof document !== "undefined") {
      document.documentElement.dataset.lightmdListeners = [...READY].sort().join(",");
    }
  } catch {
    // 忽略（非 DOM 环境）
  }
}

/** 标记某个事件监听注册失败（E2E 可据此断言，避免"静默失效"） */
export function markListenerFailed(name: string, error: unknown): void {
  try {
    if (typeof document !== "undefined") {
      document.documentElement.dataset.lightmdListenerErrors =
        `${document.documentElement.dataset.lightmdListenerErrors ?? ""}${name}:${String(error)};`;
    }
  } catch {
    // 忽略
  }
}

/** 测试用：已就绪的监听名集合 */
export function readyListeners(): string[] {
  return [...READY].sort();
}

/**
 * 记录一次事件到达（含判定结果），滚动保留最近 8 条。
 *
 * 用于 E2E 断言「定向事件是否被正确过滤」——打包后的应用里既没有控制台也
 * 没有日志文件，这条记录是定位「事件到了但没处理 / 事件没到」的唯一线索。
 */
export function noteEventReceived(name: string, detail: string): void {
  try {
    if (typeof document === "undefined") return;
    const el = document.documentElement;
    const prev = el.dataset.lightmdEvents ? el.dataset.lightmdEvents.split("|") : [];
    prev.push(`${name}:${detail}`);
    el.dataset.lightmdEvents = prev.slice(-8).join("|");
  } catch {
    // 忽略
  }
}
