/**
 * Favorites ── 收藏文件列表（G7）
 *
 * 显示在 RecentFiles 上方，列出已收藏的文件。
 * - 点击：调用 onOpen 打开文件
 * - 右键：显示"从收藏移除"菜单
 * - 空状态：显示"暂无收藏"
 * - v0.4.1：标题栏新增缩小/放大/关闭按钮（hover 浮现），支持折叠/最大化/关闭
 */
import { useState, useEffect } from "react";
import { useFileStore, type FileNode } from "../../stores/useFileStore";
import { useT } from "../../i18n";
import "./FileTree.css";

interface FavoritesProps {
  onOpen: (node: FileNode) => void;
  /** 可选高度（由父组件拖拽控制） */
  height?: number;
  /** 关闭回调（点击 × 按钮触发，父组件隐藏整个区域） */
  onClose?: () => void;
}

export function Favorites({ onOpen, height, onClose }: FavoritesProps) {
  const favorites = useFileStore((s) => s.favorites);
  const removeFavorite = useFileStore((s) => s.removeFavorite);
  const t = useT();

  // 右键菜单状态
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  // v0.4.1：折叠/最大化状态
  const [collapsed, setCollapsed] = useState(false);
  const [maximized, setMaximized] = useState(false);

  // 点击外部关闭右键菜单
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [contextMenu]);

  // 计算 section 高度样式：最大化时固定 500px，否则用传入 height（折叠时不设高度，自适应标题栏）
  const sectionStyle: React.CSSProperties = {};
  if (maximized) {
    sectionStyle.height = 500;
  } else if (height !== undefined && !collapsed) {
    sectionStyle.height = height;
  }

  return (
    <div
      className={`favorites-section ${collapsed ? "collapsed" : ""} ${maximized ? "maximized" : ""}`}
      style={sectionStyle}
    >
      <div className="favorites-header">
        <span className="filetree-title">
          {favorites.length > 0
            ? t("sidebar.favoritesCount", { count: favorites.length })
            : t("sidebar.favorites")}
        </span>
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
      {/* 折叠时隐藏列表和空状态提示 */}
      {!collapsed && favorites.length === 0 && (
        <div className="favorites-empty">{t("sidebar.noFavorites")}</div>
      )}
      {!collapsed && favorites.length > 0 && (
        <div className="favorites-list">
          {favorites.map((file) => {
            // 兼容 Windows 路径：取父目录用于显示
            const dir = file.path.replace(/\\/g, "/").replace(/\/[^/]*$/, "");
            return (
              <div
                key={file.path}
                className="filetree-node favorite-item"
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
                <span className="filetree-icon favorite-star">★</span>
                <div className="favorite-info">
                  <span className="filetree-name">{file.name}</span>
                  <span className="favorite-path">{dir}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 右键菜单：从收藏移除 */}
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
            className="context-menu-item danger"
            onClick={() => {
              removeFavorite(contextMenu.path);
              setContextMenu(null);
            }}
          >
            {t("sidebar.removeFromFavorites")}
          </button>
        </div>
      )}
    </div>
  );
}
