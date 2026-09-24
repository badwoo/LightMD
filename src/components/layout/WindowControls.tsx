/**
 * v0.8.1 需求6：自绘窗口控制按钮（最小化 / 最大化-还原 / 关闭）
 *
 * 背景：窗口已改为无边框（tauri.conf.json → decorations: false），原生标题栏上的
 * 三个系统按钮随之消失，改由应用 TitleBar 右侧自绘 —— 配色参考 macOS 交通灯
 * （黄 / 绿 / 红），排列顺序沿用用户习惯的「最小化 → 窗口化 → 关闭」。
 *
 * 权限：capabilities/default.json 已放行
 *   core:window:allow-minimize / allow-toggle-maximize / allow-close /
 *   allow-start-dragging / allow-is-maximized
 *
 * 非 Tauri 环境（浏览器 dev / jsdom）不渲染，避免调用 IPC 报错。
 */
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "../../services/fileService";
import { useT } from "../../i18n";
import "./WindowControls.css";

export function WindowControls() {
  const t = useT();
  const [maximized, setMaximized] = useState(false);
  const tauri = isTauri();

  // 最大化态跟踪：拖动 / 双击 / Win+方向键 / 系统菜单都会改变窗口状态，
  // 用 onResized 兜底刷新，保证「最大化 ↔ 还原」图标与语义正确
  useEffect(() => {
    if (!tauri) return;
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    const sync = () => {
      win.isMaximized().then(setMaximized).catch(() => undefined);
    };
    sync();
    win
      .onResized(sync)
      .then((un) => {
        unlisten = un;
      })
      .catch(() => undefined);
    return () => {
      unlisten?.();
    };
  }, [tauri]);

  if (!tauri) return null;

  const win = getCurrentWindow();

  return (
    <div className="window-controls" data-testid="window-controls">
      <button
        type="button"
        className="wc-btn wc-min"
        title={t("window.minimize")}
        aria-label={t("window.minimize")}
        data-testid="window-minimize"
        onClick={() => {
          win.minimize().catch(() => undefined);
        }}
      />
      <button
        type="button"
        className="wc-btn wc-max"
        title={maximized ? t("window.restore") : t("window.maximize")}
        aria-label={maximized ? t("window.restore") : t("window.maximize")}
        data-testid="window-maximize"
        onClick={() => {
          win.toggleMaximize().catch(() => undefined);
        }}
      />
      <button
        type="button"
        className="wc-btn wc-close"
        title={t("window.close")}
        aria-label={t("window.close")}
        data-testid="window-close"
        onClick={() => {
          win.close().catch(() => undefined);
        }}
      />
    </div>
  );
}
