import { useEffect, useMemo, useState } from "react";
import { useFileStore, MAX_RECENT_FILES, type FileNode } from "../../stores/useFileStore";
import { useT } from "../../i18n";
import { fileService } from "../../services/fileService";
import "./FileTree.css";

interface RecentFilesProps {
  onOpen: (node: FileNode) => void;
  onFolderOpened?: () => void;
  /** @deprecated v0.16.0 起特殊面板不再使用内嵌分区属性。 */
  onClose?: () => void;
  height?: number;
  sectionKey?: string;
  prevSectionKey?: string;
  nextSectionKey?: string;
  maxHeight?: number;
  compact?: boolean;
}

export function RecentFiles({ onOpen, onFolderOpened }: RecentFilesProps) {
  const recentFiles = useFileStore((s) => s.recentFiles);
  const recentFolders = useFileStore((s) => s.recentFolders);
  const t = useT();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string } | null>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [contextMenu]);

  const mergedItems = useMemo(
    () => [
      ...recentFiles.map((file) => ({ kind: "file" as const, ...file })),
      ...recentFolders.map((folder) => ({ kind: "folder" as const, ...folder })),
    ].sort((a, b) => b.accessedAt - a.accessedAt).slice(0, MAX_RECENT_FILES),
    [recentFiles, recentFolders],
  );

  return (
    <section className="recent-files recent-files-panel" aria-label={t("recent.title")}>
      <header className="recent-files-header">
        <span className="filetree-title">{t("recent.title")}</span>
      </header>
      {mergedItems.length === 0 ? (
        <div className="recent-files-empty">{t("recent.empty")}</div>
      ) : (
        <div className="recent-files-list">
          {mergedItems.map((item) => {
            const isFolder = item.kind === "folder";
            return (
              <div
                key={`${item.kind}:${item.path}`}
                className="filetree-node recent-file-item"
                onClick={() => {
                  if (isFolder) {
                    window.dispatchEvent(new CustomEvent("lightmd:openFolder", { detail: { path: item.path } }));
                    onFolderOpened?.();
                  } else {
                    onOpen({ name: item.name, path: item.path, isDir: false, size: 0 });
                  }
                }}
                onContextMenu={isFolder ? undefined : (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setContextMenu({ x: event.clientX, y: event.clientY, path: item.path });
                }}
                title={`${item.path}\n${t("recent.lastOpenedAt", { time: formatDateTime(item.accessedAt) })}${item.stale ? `\n${t("recent.staleHint")}` : ""}`}
              >
                <span className="filetree-icon">{isFolder ? "📁" : "📝"}</span>
                <div className="recent-file-info">
                  <span className="filetree-name">{item.name}</span>
                  <span className="recent-file-path">{item.path.replace(/\\/g, "/").replace(/\/[^/]*$/, "")}</span>
                </div>
                <span className="recent-file-time">{formatTime(item.accessedAt, t)}</span>
                {item.stale && <span className="recent-file-stale">⚠</span>}
              </div>
            );
          })}
        </div>
      )}

      {contextMenu && (
        <div className="filetree-context-menu" style={{ left: contextMenu.x, top: contextMenu.y, position: "fixed" }} onClick={(event) => event.stopPropagation()}>
          <button className="context-menu-item" onClick={() => { fileService.revealInFolder(contextMenu.path).catch(() => {}); setContextMenu(null); }}>
            {t("common.revealInFolder")}
          </button>
        </div>
      )}
    </section>
  );
}

function formatTime(ts: number, t: (key: string, params?: Record<string, string | number>) => string): string {
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return t("recent.justNow");
  if (diff < 3600_000) return t("recent.minutesAgo", { count: Math.floor(diff / 60_000) });
  if (diff < 86400_000) return t("recent.hoursAgo", { count: Math.floor(diff / 3600_000) });
  const date = new Date(ts);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function formatDateTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "-";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
