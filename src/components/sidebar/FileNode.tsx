/**
 * FileNode ── 单个文件/文件夹节点（支持内联重命名）
 */
import { useState, useRef, useEffect, useCallback } from "react";
import "./FileTree.css";

export interface FileNodeData {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  children?: FileNodeData[];
}

interface FileNodeProps {
  node: FileNodeData;
  depth: number;
  activePath: string | null;
  renamingPath: string | null;
  expandedPaths: Set<string>;
  onSelect: (node: FileNodeData) => void;
  onToggleExpand: (path: string) => void;
  onRenameStart: (path: string) => void;
  onRenameConfirm: (path: string, newName: string) => void;
  onRenameCancel: () => void;
  onDelete: (node: FileNodeData) => void;
  onNewFile: (parentPath: string) => void;
  onNewFolder: (parentPath: string) => void;
  onDragStart?: (node: FileNodeData, e: React.DragEvent) => void;
  onRefresh?: () => void;
}

export function FileEntryNode({
  node,
  depth,
  activePath,
  renamingPath,
  expandedPaths,
  onSelect,
  onToggleExpand,
  onRenameStart,
  onRenameConfirm,
  onRenameCancel,
  onDelete,
  onNewFile,
  onNewFolder,
  onDragStart,
  onRefresh,
}: FileNodeProps) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(node.name);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isExpanded = expandedPaths.has(node.path);
  const isActive = activePath === node.path;

  // 外部触发的重命名
  useEffect(() => {
    if (renamingPath === node.path) {
      setIsRenaming(true);
      setRenameValue(node.name);
    } else {
      setIsRenaming(false);
    }
  }, [renamingPath, node.path, node.name]);

  // 重命名输入框自动聚焦
  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus();
      // 选中文件名（不含扩展名）
      const dotIdx = node.name.lastIndexOf(".");
      const selEnd = node.isDir ? node.name.length : (dotIdx > 0 ? dotIdx : node.name.length);
      inputRef.current.setSelectionRange(0, selEnd);
    }
  }, [isRenaming, node.name, node.isDir]);

  // 关闭右键菜单
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [contextMenu]);

  const handleClick = useCallback(() => {
    if (isRenaming) return;
    if (node.isDir) {
      onToggleExpand(node.path);
    } else {
      onSelect(node);
    }
  }, [isRenaming, node, onToggleExpand, onSelect]);

  const handleRenameSubmit = useCallback(() => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== node.name) {
      onRenameConfirm(node.path, trimmed);
    } else {
      onRenameCancel();
    }
    setIsRenaming(false);
  }, [renameValue, node.name, node.path, onRenameConfirm, onRenameCancel]);

  const handleRenameKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") handleRenameSubmit();
      if (e.key === "Escape") {
        setIsRenaming(false);
        onRenameCancel();
      }
    },
    [handleRenameSubmit, onRenameCancel]
  );

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const handleDoubleClick = useCallback(() => {
    if (!node.isDir) {
      onSelect(node);
    }
    // 双击文件夹 = 切换展开
    // 双击文件 = 打开（已由单击处理，此处做额外触发）
  }, [node, onSelect]);

  // 文件/文件夹图标
  const icon = node.isDir
    ? isExpanded
      ? "📂"
      : "📁"
    : getFileIcon(node.name);

  return (
    <div className={`filetree-node-wrapper ${isActive ? "active" : ""}`}>
      <div
        className={`filetree-node ${isActive ? "active" : ""}`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        draggable={!node.isDir}
        onDragStart={(e) => onDragStart?.(node, e)}
        title={node.path}
      >
        {/* 展开/折叠箭头（仅文件夹） */}
        {node.isDir && (
          <span
            className={`filetree-arrow ${isExpanded ? "expanded" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand(node.path);
            }}
          >
            ▶
          </span>
        )}

        {/* 图标 */}
        <span className="filetree-icon">{icon}</span>

        {/* 文件名 / 重命名输入框 */}
        {isRenaming ? (
          <input
            ref={inputRef}
            className="filetree-rename-input"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={handleRenameSubmit}
            onKeyDown={handleRenameKeyDown}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="filetree-name">{node.name}</span>
        )}

        {/* 文件大小 */}
        {!node.isDir && node.size > 0 && (
          <span className="filetree-size">{formatSize(node.size)}</span>
        )}
      </div>

      {/* 展开的子节点 */}
      {node.isDir && isExpanded && node.children && (
        <div className="filetree-children">
          {node.children.map((child) => (
            <FileEntryNode
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              renamingPath={renamingPath}
              expandedPaths={expandedPaths}
              onSelect={onSelect}
              onToggleExpand={onToggleExpand}
              onRenameStart={onRenameStart}
              onRenameConfirm={onRenameConfirm}
              onRenameCancel={onRenameCancel}
              onDelete={onDelete}
              onNewFile={onNewFile}
              onNewFolder={onNewFolder}
              onDragStart={onDragStart}
              onRefresh={onRefresh}
            />
          ))}
          {node.children.length === 0 && (
            <div
              className="filetree-empty"
              style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
            >
              空文件夹
            </div>
          )}
        </div>
      )}

      {/* 右键菜单 */}
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
          {node.isDir && (
            <>
              <button
                className="context-menu-item"
                onClick={() => {
                  onNewFile(node.path);
                  setContextMenu(null);
                }}
              >
                📄 新建文件
              </button>
              <button
                className="context-menu-item"
                onClick={() => {
                  onNewFolder(node.path);
                  setContextMenu(null);
                }}
              >
                📁 新建文件夹
              </button>
              <button
                className="context-menu-item"
                onClick={() => {
                  onRefresh?.();
                  setContextMenu(null);
                }}
              >
                🔄 刷新
              </button>
              <div className="context-menu-divider" />
            </>
          )}
          <button
            className="context-menu-item"
            onClick={() => {
              onRenameStart(node.path);
              setContextMenu(null);
            }}
          >
            ✏️ 重命名
          </button>
          <button
            className="context-menu-item danger"
            onClick={() => {
              onDelete(node);
              setContextMenu(null);
            }}
          >
            🗑️ 删除
          </button>
        </div>
      )}
    </div>
  );
}

// ─── 工具函数 ──────────────────────────────────────────

function getFileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "md":
    case "markdown":
    case "mdown":
      return "📝";
    case "js":
    case "ts":
    case "jsx":
    case "tsx":
      return "🟨";
    case "css":
    case "scss":
    case "less":
      return "🎨";
    case "html":
    case "htm":
      return "🌐";
    case "json":
      return "📋";
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "svg":
    case "webp":
      return "🖼️";
    case "py":
      return "🐍";
    case "rs":
      return "🦀";
    case "toml":
    case "yaml":
    case "yml":
      return "⚙️";
    case "gitignore":
      return "🔧";
    default:
      return "📄";
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
