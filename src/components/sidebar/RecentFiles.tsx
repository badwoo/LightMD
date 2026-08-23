/**
 * RecentFiles ── 最近打开文件列表
 *
 * v0.4.1：标题栏新增缩小/放大/关闭按钮（hover 浮现），支持折叠/最大化/关闭
 */
import { useState, useEffect } from "react";
import { useFileStore, type FileNode } from "../../stores/useFileStore";
import { useT } from "../../i18n";
import { fileService } from "../../services/fileService";
import "./FileTree.css";

interface RecentFilesProps {
  onOpen: (node: FileNode) => void;
  /** 可选高度（由父组件拖拽控制） */
  height?: number;
  /** 关闭回调（点击 × 按钮触发，父组件隐藏整个区域） */
  onClose?: () => void;
}

export function RecentFiles({ onOpen, height, onClose }: RecentFilesProps) {
  const recentFiles = useFileStore((s) => s.recentFiles);
  const t = useT();

  // v0.4.1：折叠/最大化状态
  const [collapsed, setCollapsed] = useState(false);
  const [maximized, setMaximized] = useState(false);
  // N5：右键菜单状态
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string } | null>(null);

  // 点击外部关闭右键菜单
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [contextMenu]);

  // 空状态返回 null（保持现有行为，由父组件 toggle 按钮控制显示）
  if (recentFiles.length === 0) return null;

  // 计算 section 高度样式
  const sectionStyle: React.CSSProperties = {};
  if (maximized) {
    sectionStyle.height = 500;
  } else if (height !== undefined && !collapsed) {
    sectionStyle.height = height;
  }

  return (
    <div
      className={`recent-files ${collapsed ? "collapsed" : ""} ${maximized ? "maximized" : ""}`}
      style={sectionStyle}
    >
      <div className="recent-files-header">
        <span className="filetree-title">{t("recent.title")}</span>
        {/* v0.4.1：标题栏控制按钮（hover 浮现） */}
        <div className="section-controls">
          <button
            className="section-btn section-minimize"
            title={t("filetree.minimize")}
            onClick={() => { setCollapsed((c) => !c); setMaximized(false); }}
          >
            ▾
          </button>
          <button
            className="section-btn section-maximize"
            title={t("filetree.maximize")}
            onClick={() => { setMaximized((m) => !m); setCollapsed(false); }}
          >
            ▴
          </button>
          {onClose && (
            <button
              className="section-btn section-close"
              title={t("filetree.closeSection")}
              onClick={onClose}
            >
              ×
            </button>
          )}
        </div>
      </div>
      {!collapsed && (
        <div className="recent-files-list">
          {recentFiles.slice(0, 10).map((file) => {
            const name = file.name;
            const dir = file.path.substring(0, file.path.lastIndexOf("/"));
            return (
              <div
                key={file.path}
                className="filetree-node recent-file-item"
                onClick={() =>
                  onOpen({
                    name: file.name,
                    path: file.path,
                    isDir: false,
                    size: 0,
                  })
                }
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setContextMenu({ x: e.clientX, y: e.clientY, path: file.path });
                }}
                title={file.path}
              >
                <span className="filetree-icon">📝</span>
                <div className="recent-file-info">
                  <span className="filetree-name">{name}</span>
                  <span className="recent-file-path">{dir}</span>
                </div>
                <span className="recent-file-time">{formatTime(file.accessedAt, t)}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* N5：右键菜单：打开文件所在目录 */}
      {contextMenu && (
        <div
          className="filetree-context-menu"
          style={{
            left: contextMenu.x,
            top: contextMenu.y,
            position: "fixed",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="context-menu-item"
            onClick={() => {
              fileService.revealInFolder(contextMenu.path).catch(() => {});
              setContextMenu(null);
            }}
          >
            {t("common.revealInFolder")}
          </button>
        </div>
      )}
    </div>
  );
}

function formatTime(ts: number, t: (key: string, params?: Record<string, string | number>) => string): string {
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return t("recent.justNow");
  if (diff < 3600_000) return t("recent.minutesAgo", { count: Math.floor(diff / 60_000) });
  if (diff < 86400_000) return t("recent.hoursAgo", { count: Math.floor(diff / 3600_000) });
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
