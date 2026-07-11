/**
 * Favorites ── 收藏文件列表（G7）
 *
 * 显示在 RecentFiles 上方，列出已收藏的文件。
 * - 点击：调用 onOpen 打开文件
 * - 右键：显示"从收藏移除"菜单
 * - 空状态：显示"暂无收藏"
 */
import { useState, useEffect } from "react";
import { useFileStore, type FileNode } from "../../stores/useFileStore";
import { useT } from "../../i18n";
import "./FileTree.css";

interface FavoritesProps {
  onOpen: (node: FileNode) => void;
}

export function Favorites({ onOpen }: FavoritesProps) {
  const favorites = useFileStore((s) => s.favorites);
  const removeFavorite = useFileStore((s) => s.removeFavorite);
  const t = useT();

  // 右键菜单状态
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string } | null>(null);

  // 点击外部关闭右键菜单
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [contextMenu]);

  // 空状态：显示"暂无收藏"（仍渲染区段，便于用户感知功能存在）
  if (favorites.length === 0) {
    return (
      <div className="favorites-section">
        <div className="favorites-header">
          <span className="filetree-title">{t("sidebar.favorites")}</span>
        </div>
        <div className="favorites-empty">{t("sidebar.noFavorites")}</div>
      </div>
    );
  }

  return (
    <div className="favorites-section">
      <div className="favorites-header">
        <span className="filetree-title">{t("sidebar.favoritesCount", { count: favorites.length })}</span>
      </div>
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
