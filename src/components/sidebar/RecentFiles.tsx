/**
 * RecentFiles ── 最近打开文件列表
 */
import { useFileStore, type FileNode } from "../../stores/useFileStore";
import { useT } from "../../i18n";
import "./FileTree.css";

interface RecentFilesProps {
  onOpen: (node: FileNode) => void;
}

export function RecentFiles({ onOpen }: RecentFilesProps) {
  const recentFiles = useFileStore((s) => s.recentFiles);
  const t = useT();

  if (recentFiles.length === 0) return null;

  return (
    <div className="recent-files">
      <div className="recent-files-header">
        <span className="filetree-title">{t("recent.title")}</span>
      </div>
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
