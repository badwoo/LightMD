import { useState, useCallback, useEffect } from "react";
import { useT } from "../../i18n";
import { useResizable } from "../../hooks/useResizable";
import { useSettingsStore } from "../../stores/useSettingsStore";
import "./AppShell.css";

interface AppShellProps {
  sidebar?: React.ReactNode;
  outline?: React.ReactNode;
  children?: React.ReactNode;
}

export function AppShell({ sidebar, outline, children }: AppShellProps) {
  const t = useT();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [outlineCollapsed, setOutlineCollapsed] = useState(false);

  // v0.4.0：从 store 读取侧边栏/大纲栏宽度，支持持久化
  const sidebarWidth = useSettingsStore((s) => s.sidebarWidth);
  const outlineWidth = useSettingsStore((s) => s.outlineWidth);
  const setSidebarWidth = useSettingsStore((s) => s.setSidebarWidth);
  const setOutlineWidth = useSettingsStore((s) => s.setOutlineWidth);

  // 初始化时同步 CSS 变量（防止 store 中的值与 :root 默认值不一致）
  useEffect(() => {
    document.documentElement.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
  }, [sidebarWidth]);
  useEffect(() => {
    document.documentElement.style.setProperty("--outline-width", `${outlineWidth}px`);
  }, [outlineWidth]);

  const toggleSidebar = useCallback(() => setSidebarCollapsed((v) => !v), []);
  const toggleOutline = useCallback(() => setOutlineCollapsed((v) => !v), []);

  // v0.4.0：侧边栏分割条（左侧栏，拖右移→宽度增加）
  const sidebarResizer = useResizable({
    initialWidth: sidebarWidth,
    minWidth: 180,
    maxWidth: 480,
    direction: "left",
    onChange: (w) => {
      // 实时更新 CSS 变量，驱动 sidebar 宽度变化
      document.documentElement.style.setProperty("--sidebar-width", `${w}px`);
      // 持久化到 store（setter 内部会钳制）
      setSidebarWidth(w);
    },
  });

  // v0.4.0：大纲栏分割条（右侧栏，拖左移→宽度增加）
  const outlineResizer = useResizable({
    initialWidth: outlineWidth,
    minWidth: 180,
    maxWidth: 480,
    direction: "right",
    onChange: (w) => {
      document.documentElement.style.setProperty("--outline-width", `${w}px`);
      setOutlineWidth(w);
    },
  });

  // 拖拽时给 body 加 class，CSS 据此禁用 transition 避免视觉延迟
  useEffect(() => {
    const dragging = sidebarResizer.isDragging || outlineResizer.isDragging;
    document.body.classList.toggle("resizing", dragging);
    return () => {
      if (dragging) document.body.classList.remove("resizing");
    };
  }, [sidebarResizer.isDragging, outlineResizer.isDragging]);

  return (
    <div className="app-shell">
      {sidebar && (
        <aside className={`app-sidebar ${sidebarCollapsed ? "app-sidebar-collapsed" : ""}`}>
          <button
            className="sidebar-toggle-btn sidebar-toggle-left"
            title={sidebarCollapsed ? t("appshell.expandSidebar") : t("appshell.collapseSidebar")}
            onClick={toggleSidebar}
          >
            {sidebarCollapsed ? "›" : "‹"}
          </button>
          <div className="app-sidebar-content">
            {sidebar}
          </div>
          {/* v0.4.0：侧边栏右边缘分割条，折叠时不渲染 */}
          {!sidebarCollapsed && (
            <div
              className="app-resizer app-resizer-left"
              title={t("appshell.dragToResize")}
              onMouseDown={sidebarResizer.onMouseDown}
            />
          )}
        </aside>
      )}
      <main className="app-main">{children}</main>
      {outline && (
        <aside className={`app-outline ${outlineCollapsed ? "app-outline-collapsed" : ""}`}>
          {/* v0.4.0：大纲栏左边缘分割条，折叠时不渲染 */}
          {!outlineCollapsed && (
            <div
              className="app-resizer app-resizer-right"
              title={t("appshell.dragToResize")}
              onMouseDown={outlineResizer.onMouseDown}
            />
          )}
          <button
            className="sidebar-toggle-btn sidebar-toggle-right"
            title={outlineCollapsed ? t("appshell.expandSidebar") : t("appshell.collapseSidebar")}
            onClick={toggleOutline}
          >
            {outlineCollapsed ? "‹" : "›"}
          </button>
          <div className="app-outline-content">
            {outline}
          </div>
        </aside>
      )}
    </div>
  );
}
