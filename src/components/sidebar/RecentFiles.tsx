/**
 * RecentFiles ── 最近打开文件列表
 *
 * v0.4.1：标题栏新增缩小/放大/关闭按钮（hover 浮现），支持折叠/最大化/关闭
 */
import { useState, useEffect } from "react";
import { useFileStore, type FileNode } from "../../stores/useFileStore";
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
          {/* v0.8.3 需求1：渲染全量 recentFiles（上限由数据层 MAX_RECENT_FILES=66 保证），
              不再 slice(0,10)；列表超出栏高时由 .recent-files-list 内部滚动 */}
          {recentFiles.map((file) => {
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
                // v0.8.3 需求1：悬停提示 = 完整路径 + 最近打开日期时间
                // v0.8.4 需求1b：stale 条目（文件被移动/外部删除）追加失效提示行
                title={`${file.path}\n${t("recent.lastOpenedAt", { time: formatDateTime(file.accessedAt) })}${file.stale ? `\n${t("recent.staleHint")}` : ""}`}
              >
                <span className="filetree-icon">📝</span>
                <div className="recent-file-info">
                  <span className="filetree-name">{name}</span>
                  <span className="recent-file-path">{dir}</span>
                </div>
                <span className="recent-file-time">{formatTime(file.accessedAt, t)}</span>
                {/* v0.8.4 需求1b：旧路径已失效标记（淡黄 ⚠，颜色走主题变量） */}
                {file.stale && <span className="recent-file-stale">⚠</span>}
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
