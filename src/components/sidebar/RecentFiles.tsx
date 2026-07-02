/**
 * RecentFiles ── 最近打开文件列表
 */
import { useFileStore, type FileNode } from "../../stores/useFileStore";
import "./FileTree.css";

interface RecentFilesProps {
  onOpen: (node: FileNode) => void;
}

export function RecentFiles({ onOpen }: RecentFilesProps) {
  const recentFiles = useFileStore((s) => s.recentFiles);

  if (recentFiles.length === 0) return null;

  return (
    <div className="recent-files">
      <div className="recent-files-header">
        <span className="filetree-title">最近打开</span>
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
              <span className="recent-file-time">{formatTime(file.accessedAt)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
