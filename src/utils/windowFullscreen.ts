/**
 * 窗口全屏切换（v0.9.0 F11 / `window.full`）。
 *
 * 背景（实施计划 P8 探针结论）：Tauri 在 Windows 上用 WebView2，wry 只设置了
 * `AreBrowserAcceleratorKeysEnabled(false)`（浏览器加速键让给页面），**没有**处理
 * `ContainsFullScreenElementChanged`。因此 `document.documentElement.requestFullscreen()`
 * 只会让元素铺满 webview 视口，不会让系统窗口进入全屏——F11 看起来「没反应」。
 * 正确做法是用 Tauri 窗口 API 切换窗口全屏（decorations 已是 false，无需再处理边框）。
 *
 * 非 Tauri 环境（vitest / 纯浏览器预览）回退 DOM Fullscreen API。
 * 权限：需 src-tauri/capabilities/default.json 授予
 * `core:window:allow-is-fullscreen` 与 `core:window:allow-set-fullscreen`。
 */
import { isTauri } from "../services/fileService";

/** 切换当前窗口全屏；返回是否成功发起（失败静默，不影响其它功能）。 */
export async function toggleWindowFullscreen(): Promise<boolean> {
  if (isTauri()) {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      const next = !(await win.isFullscreen());
      await win.setFullscreen(next);
      return true;
    } catch (err) {
      // 权限缺失 / 平台不支持：继续尝试 DOM 回退，避免 F11 完全无反应
      console.warn("[fullscreen] Tauri 窗口全屏失败，回退 DOM Fullscreen API:", err);
    }
  }
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
    return true;
  } catch (err) {
    console.warn("[fullscreen] 当前环境不支持全屏:", err);
    return false;
  }
}
