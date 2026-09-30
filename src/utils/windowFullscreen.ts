/**
 * 窗口全屏切换（v0.9.0 F11 / `window.full`；v0.9.1 显式 set + 状态查询）。
 *
 * 背景（实施计划 P8 探针结论）：Tauri 在 Windows 上用 WebView2。因此
 * `document.documentElement.requestFullscreen()` 只会让元素铺满 webview 视口，
 * 不会让系统窗口进入全屏——F11 看起来「没反应」。
 * 正确做法是用 Tauri 窗口 API 切换窗口全屏（decorations 已是 false，无需再处理边框）。
 *
 * v0.9.1 需求6：沉浸式全屏需要「明确进入 / 明确退出」两个动作（进入时机由
 * 「全屏模式」大字动画决定，退出由 F11/Esc 决定），因此新增
 * [`setWindowFullscreen`]；[`toggleWindowFullscreen`] 保留给命令面板等只关心
 * 「切一下」的入口。
 *
 * 非 Tauri 环境（vitest / 纯浏览器预览）回退 DOM Fullscreen API。
 * 权限：需 src-tauri/capabilities/default.json 授予
 * `core:window:allow-is-fullscreen` 与 `core:window:allow-set-fullscreen`。
 */
import { isTauri } from "../services/fileService";

/** 显式进入/退出全屏；返回是否成功发起（失败静默，不影响其它功能）。 */
export async function setWindowFullscreen(on: boolean): Promise<boolean> {
  if (isTauri()) {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().setFullscreen(on);
      return true;
    } catch (err) {
      // 权限缺失 / 平台不支持：继续尝试 DOM 回退，避免完全无反应
      console.warn("[fullscreen] Tauri 窗口全屏失败，回退 DOM Fullscreen API:", err);
    }
  }
  try {
    if (on) {
      // 已在全屏则不重复请求（重复 requestFullscreen 会 reject）
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    } else if (document.fullscreenElement) {
      await document.exitFullscreen();
    }
    return true;
  } catch (err) {
    console.warn("[fullscreen] 当前环境不支持全屏:", err);
    return false;
  }
}

/** 当前窗口是否处于全屏（Tauri 优先，DOM 回退）。查询失败按「否」处理。 */
export async function isWindowFullscreen(): Promise<boolean> {
  if (isTauri()) {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      return await getCurrentWindow().isFullscreen();
    } catch (err) {
      console.warn("[fullscreen] 读取窗口全屏状态失败:", err);
    }
  }
  return !!document.fullscreenElement;
}
