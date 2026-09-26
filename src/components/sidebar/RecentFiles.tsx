/**
 * RecentFiles ── 最近打开文件列表
 *
 * v0.4.1：标题栏新增缩小/放大/关闭按钮（hover 浮现），支持折叠/最大化/关闭
 * v0.8.5 需求8：最近打开文件夹与文件按 accessedAt 降序混排在同一列表（总上限 66 条），
 *               文件夹条目带专属图标，点击派发 lightmd:openFolder 事件打开为文件夹栏
 */
import { useState, useEffect, useMemo } from "react";
import { useFileStore, MAX_RECENT_FILES, type FileNode } from "../../stores/useFileStore";
import { useT } from "../../i18n";
import { fileService } from "../../services/fileService";
import { useSectionSplit } from "../../hooks/useSectionSplit";
import "./FileTree.css";

interface RecentFilesProps {
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
}

export function RecentFiles({ onOpen, height, onClose, sectionKey, prevSectionKey, nextSectionKey, maxHeight }: RecentFilesProps) {
  const recentFiles = useFileStore((s) => s.recentFiles);
  // v0.8.5 需求8：最近打开文件夹（数据层 addRecentFolder 保证去重头插 + 上限 10 条）
  const recentFolders = useFileStore((s) => s.recentFolders);
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

  // v0.8.0 修复 P12-4：标题栏拖拽 hook 必须**先于**空状态 return 调用。
  // 旧实现把 `if (recentFiles.length === 0) return null` 放在 hook 之前，
  // 最近文件从"有"变"无"时两次渲染的 hook 数量不同，React 会直接抛错。
  // v0.8.2 功能4：无上方邻区时改拖「本区 + 下区」（nextSectionKey）
  const { onMouseDown } = useSectionSplit({
    selfKey: sectionKey ?? "recent",
    prevKey: prevSectionKey,
    nextKey: nextSectionKey,
    maxHeight,
  });

  // v0.8.2 功能2：双击标题栏切换缩小/放大（对应缩小按钮）
  const handleHeaderDoubleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    setCollapsed((c) => !c);
    setMaximized(false);
  };

  // v0.8.5 需求8：文件与文件夹按 accessedAt 降序混排为同一列表；
  // 总条目上限复用数据层导出的 MAX_RECENT_FILES=66（文件+文件夹合并计数，
  // 超出后截断掉最旧条目；文件夹自身 10 条上限由数据层 addRecentFolder 保证）。
  // v0.8.5 需求6：文件夹条目同样支持 stale 标记（外部删除/移动、启动恢复失败时，
  // 数据层 markRecentFolderStale 标记；条目永不删除，成功重新打开同路径时自动清除）。
  const mergedItems = useMemo(
    () =>
      [
        ...recentFiles.map((f) => ({ kind: "file" as const, ...f })),
        ...recentFolders.map((d) => ({ kind: "folder" as const, ...d })),
      ]
        .sort((a, b) => b.accessedAt - a.accessedAt)
        .slice(0, MAX_RECENT_FILES),
    [recentFiles, recentFolders]
  );

  // 空状态返回 null（保持现有行为，由父组件 toggle 按钮控制显示）
  // v0.8.5 需求8：文件与文件夹记录全空时才不渲染（原仅判断 recentFiles）
  if (recentFiles.length === 0 && recentFolders.length === 0) return null;

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
      // v0.8.2 功能5：data-section-key 供内容高度测量（重新打开栏时上一栏收缩到内容高度）
      data-section-key={sectionKey ?? "recent"}
    >
      <div
        className="recent-files-header"
        onMouseDown={(e) => { if (!collapsed && !maximized) onMouseDown(e); }}
        onDoubleClick={handleHeaderDoubleClick}
      >
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
          {/* v0.8.3 需求1：列表超出栏高时由 .recent-files-list 内部滚动 */}
          {/* v0.8.5 需求8：文件与文件夹混排渲染（mergedItems 已按 accessedAt 降序 + 截断 66 条） */}
          {mergedItems.map((item) => {
            const isFolder = item.kind === "folder";
            const name = item.name;
            const dir = item.path.substring(0, item.path.lastIndexOf("/"));
            return (
              <div
                key={item.path}
                className="filetree-node recent-file-item"
                onClick={() => {
                  if (item.kind === "folder") {
                    // v0.8.5 需求8：点击文件夹条目 → 派发既有 lightmd:openFolder 事件
                    // （FileTree 已监听该事件并调用 openFolderAt 打开为文件夹栏；
                    //   已打开的文件夹重复触发时 addOpenFolder 去重，表现为刷新定位，无副作用）
                    window.dispatchEvent(
                      new CustomEvent("lightmd:openFolder", { detail: { path: item.path } })
                    );
                  } else {
                    onOpen({
                      name: item.name,
                      path: item.path,
                      isDir: false,
                      size: 0,
                    });
                  }
                }}
                onContextMenu={
                  // 文件夹条目暂不提供右键「打开所在目录」（原文件条目行为保持不变）
                  item.kind === "folder"
                    ? undefined
                    : (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setContextMenu({ x: e.clientX, y: e.clientY, path: item.path });
                      }
                }
                // v0.8.3 需求1：悬停提示 = 完整路径 + 最近打开日期时间（文件夹同格式）
                // v0.8.4 需求1b：stale 条目（文件被移动/外部删除）追加失效提示行
                // v0.8.5 需求6：文件夹条目失效（外部删除/移动、恢复失败）时同样追加
                title={`${item.path}\n${t("recent.lastOpenedAt", { time: formatDateTime(item.accessedAt) })}${item.stale ? `\n${t("recent.staleHint")}` : ""}`}
              >
                {/* v0.8.5 需求8：文件夹专属图标（与树内未展开文件夹一致 📁） */}
                <span className="filetree-icon">{isFolder ? "📁" : "📝"}</span>
                <div className="recent-file-info">
                  <span className="filetree-name">{name}</span>
                  <span className="recent-file-path">{dir}</span>
                </div>
                <span className="recent-file-time">{formatTime(item.accessedAt, t)}</span>
                {/* v0.8.4 需求1b：旧路径已失效标记（淡黄 ⚠，颜色走主题变量）
                    v0.8.5 需求6：文件夹条目失效时同样显示（样式与文件条目一致） */}
                {item.stale && <span className="recent-file-stale">⚠</span>}
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

/**
 * v0.8.3 需求1：绝对时间格式化（本地时区），输出 `YYYY/MM/DD HH:mm`。
 *
 * 与右侧常显的相对时间（formatTime）互补：相对时间适合快速扫读，
 * hover tooltip 需要精确到分钟的"最近打开日期"。
 * 时间戳非法/为 0 时返回占位符，不抛错（localStorage 数据可能被外部损坏）。
 */
export function formatDateTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "-";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "-";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
