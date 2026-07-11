import { useState, useCallback } from "react";
import { useT } from "../../i18n";
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

  const toggleSidebar = useCallback(() => setSidebarCollapsed((v) => !v), []);
  const toggleOutline = useCallback(() => setOutlineCollapsed((v) => !v), []);

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
        </aside>
      )}
      <main className="app-main">{children}</main>
      {outline && (
        <aside className={`app-outline ${outlineCollapsed ? "app-outline-collapsed" : ""}`}>
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
