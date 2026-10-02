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
import { useSectionSplit } from "../../hooks/useSectionSplit";
import "./FileTree.css";

interface FavoritesProps {
  onOpen: (node: FileNode) => void;
  /** 可选高度（由父组件拖拽控制） */
  height?: number;
  /** 关闭回调（点击 × 按钮触发，父组件隐藏整个区域） */
  onClose?: () => void;
  /** 本区 key（相邻配对拖拽用） */
  sectionKey?: string;
  /** 上方相邻可见区 key（为空 = 本区最靠上，标题栏不可拖） */
  prevSectionKey?: string;
  /** v0.8.2 功能4：下方相邻可见区 key（本区最靠上时标题栏改拖「本区+下区」） */
  nextSectionKey?: string;
  /** v0.8.0 修复 P11-4：本区高度上限（仅最后一个可见区域给出 → 可拖到底部） */
  maxHeight?: number;
  /** v0.9.5 问题6：紧凑内嵌形态——无标题栏、高度自适应、单行条目,
      紧跟「打开的文件」栏列表之下（顶部空一个条目位） */
  compact?: boolean;
}

export function Favorites({ onOpen, height, onClose, sectionKey, prevSectionKey, nextSectionKey, maxHeight, compact }: FavoritesProps) {
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
  if (compact) {
    // v0.9.5 问题6：紧凑内嵌形态高度自适应内容,不参与固定分区
  } else if (maximized) {
    sectionStyle.height = 500;
  } else if (height !== undefined && !collapsed) {
    sectionStyle.height = height;
  }

  // v0.8.0 修复 P9-1：标题栏拖拽移动本区上边界 → 配对「上方邻区 + 本区」
  // v0.8.2 功能4：无上方邻区时改拖「本区 + 下区」（nextSectionKey）
  const { onMouseDown } = useSectionSplit({
    selfKey: sectionKey ?? "favorites",
    prevKey: prevSectionKey,
    nextKey: nextSectionKey,
    maxHeight,
  });

  // v0.8.2 功能2：双击标题栏切换缩小/放大（对应缩小按钮），折叠时禁用拖拽
  const handleHeaderDoubleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    setCollapsed((c) => !c);
    setMaximized(false);
  };

  return (
    <div
      className={`favorites-section ${collapsed ? "collapsed" : ""} ${maximized ? "maximized" : ""}`}
      style={sectionStyle}
      // v0.8.2 功能5：data-section-key 供内容高度测量（重新打开栏时上一栏收缩到内容高度）
      data-section-key={sectionKey ?? "favorites"}
    >
      <div
        className="favorites-header"
        style={compact ? { display: "none" } : undefined}
        onMouseDown={(e) => { if (!collapsed && !maximized) onMouseDown(e); }}
        onDoubleClick={handleHeaderDoubleClick}
      >
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
      {/* v0.9.5 问题6：与「打开的文件」栏列表之间空一个条目位（空收藏时同样保持间距） */}
      {!collapsed && compact && <div className="filetree-temp-spacer" />}
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
                className={`filetree-node favorite-item ${compact ? "compact" : ""}`}
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
                // v0.8.4 需求10（P2 拍板）：stale 条目（外部删除/移动）在 hover tooltip
                // 追加失效提示（复用 RecentFiles 的 staleHint 文案，最小实现不加 ⚠ 图标）
                title={`${file.path}${file.stale ? `\n${t("recent.staleHint")}` : ""}`}
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
