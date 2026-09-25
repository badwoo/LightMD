/**
 * FileNode ── 单个文件/文件夹节点（支持内联重命名）
 */
import { useState, useRef, useEffect, useCallback } from "react";
import { useT } from "../../i18n";
import { fileService } from "../../services/fileService";
// v0.8.0 修复 P3：自制鼠标拖拽（HTML5 DnD 被 Tauri 原生拖放拦截，改用鼠标事件）
import { DROP_DIR_ATTR } from "../../utils/fileDragMouse";
// v0.8.4 反馈1：节点右键"粘贴"项的可用态需在渲染期实时读取内存剪贴板
import { hasClipboard } from "../../utils/fileClipboard";
import "./FileTree.css";

export interface FileNodeData {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  /** v0.8.4 需求7：修改时间（UNIX 毫秒）。可选——存量测试 mock 无需补字段；0/缺失 = 未知，排序时排最后 */
  modifiedMs?: number;
  /** v0.8.4 需求7：创建时间（UNIX 毫秒）。可选——同上，0/缺失 = 未知 */
  createdMs?: number;
  children?: FileNodeData[];
}

interface FileNodeProps {
  node: FileNodeData;
  depth: number;
  activePath: string | null;
  renamingPath: string | null;
  expandedPaths: Set<string>;
  /**
   * v0.8.2 动画优化：以"父文件夹路径"为键的子目录缓存。
   * 与 data flow 解耦——文件夹收起时 children 数据仍在（缓存不随展开状态清空），
   * 因此收起动画可以继续渲染子节点快照，播完才由 TreeChildrenWrap 卸载。
   * 缺省（未提供）时回退为直接用 node.children。
   */
  childrenByPath?: Map<string, FileNodeData[]>;
  onSelect: (node: FileNodeData) => void;
  onToggleExpand: (path: string) => void;
  onRenameStart: (path: string) => void;
  onRenameConfirm: (path: string, newName: string) => void;
  onRenameCancel: () => void;
  onDelete: (node: FileNodeData) => void;
  onNewFile: (parentPath: string) => void;
  onNewFolder: (parentPath: string) => void;
  /** v0.8.0 修复 P3：节点上按下鼠标 → 启动自制拖拽（v0.8.4 需求1：文件夹同样可拖） */
  onFileDragStart?: (node: FileNodeData, e: React.MouseEvent) => void;
  /**
   * v0.8.4 需求10 S7 修复：文件夹右键"刷新"以 node.path（右键目标自身）调用——
   * 刷谁的子树就传谁的路径；folderPath 缺省 = 刷全部打开文件夹（refreshTree 语义）。
   */
  onRefresh?: (folderPath?: string) => void;
  /** v0.8.0 WP2 需求6：在左侧栏打开该文件所在文件夹工作区 */
  onOpenWorkspace?: (filePath: string) => void;
  /**
   * v0.8.4 需求2：树内节点右键"复制"（文件/文件夹通用）。
   * FileNode 自身无 toast 通道，由 FileTree 注入：内部写剪贴板 + showMessage 反馈。
   */
  onCopyNode?: (node: FileNodeData) => void;
  /** v0.8.4 需求2：树内节点右键"剪切"（文件/文件夹通用），注入方式同上 */
  onCutNode?: (node: FileNodeData) => void;
  /**
   * v0.8.4 反馈1：树内**文件夹**节点右键"粘贴"——以本节点路径为落点执行粘贴
   * （剪贴板为空时菜单项置灰）。FileNode 无粘贴通道，由 FileTree 注入共用链路。
   */
  onPasteInto?: (targetDir: string) => void;
  /**
   * v0.8.2 动画优化：由 FileTree 注入的文件树子节点动画容器
   * （展开滑入 + 高度展开 / 收起滑出 + 高度收起）。
   * 参数为 (父文件夹路径, 是否可见, 子节点内容)；通过注入而非直接 import，
   * 便于单测独立渲染本组件。
   */
  childrenWrap?: (path: string, visible: boolean, children: React.ReactNode) => React.ReactNode;
}

export function FileEntryNode({
  node,
  depth,
  activePath,
  renamingPath,
  expandedPaths,
  childrenByPath,
  onSelect,
  onToggleExpand,
  onRenameStart,
  onRenameConfirm,
  onRenameCancel,
  onDelete,
  onNewFile,
  onNewFolder,
  onFileDragStart,
  onRefresh,
  onOpenWorkspace,
  onCopyNode,
  onCutNode,
  onPasteInto,
  childrenWrap,
}: FileNodeProps) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(node.name);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isExpanded = expandedPaths.has(node.path);
  const isActive = activePath === node.path;
  const t = useT();

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
        // v0.8.0 修复 P3：按下鼠标启动自制拖拽。
        // v0.8.4 需求1：去掉 !node.isDir 限制，文件夹节点同样可拖（拖到其他
        // 文件夹 = 复制/Shift 移动）。4px 拖拽阈值天然区分"点击展开/拖拽"：
        // 普通点击不达阈值仍走 onClick 展开；拖拽结束后 click 被抑制不会误展开。
        onMouseDown={(e) => onFileDragStart?.(node, e)}
        // 文件夹节点可作为拖拽落点（嵌套时内层优先，closest 取最近者）
        {...(node.isDir ? { [DROP_DIR_ATTR]: node.path } : {})}
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

      {/* 展开的子节点（v0.8.2 动画优化：展开滑入 + 高度展开 / 收起滑出 + 高度收起） */}
      {node.isDir && (() => {
        const children = childrenByPath?.get(node.path) ?? node.children ?? [];
        const childNodes = children.map((child) => (
          <FileEntryNode
            key={child.path}
            node={child}
            depth={depth + 1}
            activePath={activePath}
            renamingPath={renamingPath}
            expandedPaths={expandedPaths}
            childrenByPath={childrenByPath}
            onSelect={onSelect}
            onToggleExpand={onToggleExpand}
            onRenameStart={onRenameStart}
            onRenameConfirm={onRenameConfirm}
            onRenameCancel={onRenameCancel}
            onDelete={onDelete}
            onNewFile={onNewFile}
            onNewFolder={onNewFolder}
            onFileDragStart={onFileDragStart}
            onRefresh={onRefresh}
            onOpenWorkspace={onOpenWorkspace}
            onCopyNode={onCopyNode}
            onCutNode={onCutNode}
            onPasteInto={onPasteInto}
            childrenWrap={childrenWrap}
          />
        ));
        const body = (
          <div
            className="filetree-children"
            // v0.8.4 需求3 修复：子列表容器承载"该文件夹"的投放语义——
            // 拖到子文件夹内的行/空白 = 落到**该子文件夹**（同目录则重排、跨目录则复制/移动），
            // 而不是被最外层的区域根（data-drop-dir=文件夹根）截获而误判为"传输到根目录"。
            // closest 天然取最近者：拖到本层某个子文件夹行上时仍优先命中该子文件夹自身，
            // 拖到本层文件行/空白时命中本容器（= 本文件夹），与外层区域根互不冲突。
            {...{ [DROP_DIR_ATTR]: node.path }}
          >
            {childNodes}
            {children.length === 0 && (
              <div
                className="filetree-empty"
                style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
              >
                {t("filetree.emptySubfolder")}
              </div>
            )}
          </div>
        );
        // v0.8.2：树节点动画容器由 FileTree 注入；未注入时退化为直接渲染（单测场景）
        return childrenWrap
          ? childrenWrap(node.path, isExpanded, body)
          : isExpanded
            ? body
            : null;
      })()}

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
                {t("titlebar.newFile")}
              </button>
              <button
                className="context-menu-item"
                onClick={() => {
                  onNewFolder(node.path);
                  setContextMenu(null);
                }}
              >
                {t("titlebar.newFolder")}
              </button>
              <button
                className="context-menu-item"
                onClick={() => {
                  // v0.8.4 需求10 S7 修复：传 node.path —— 右键深层子文件夹仅刷其自身子树，
                  // 不再误刷整个 section 根（旧实现 onRefresh 无参闭包固定为根）
                  onRefresh?.(node.path);
                  setContextMenu(null);
                }}
              >
                {t("filetree.refreshTitle")}
              </button>
              <div className="context-menu-divider" />
            </>
          )}
          {/* v0.4.0 功能4：查看版本快照（仅文件） */}
          {!node.isDir && (
            <button
              className="context-menu-item"
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent("lightmd:showSnapshotDialog", {
                    detail: { filePath: node.path },
                  })
                );
                setContextMenu(null);
              }}
            >
              {t("snapshot.viewSnapshots")}
            </button>
          )}
          {/* v0.8.0 WP2 需求6：在左侧栏打开该文件所在的文件夹工作区（仅文件） */}
          {!node.isDir && onOpenWorkspace && (
            <button
              className="context-menu-item"
              onClick={() => {
                onOpenWorkspace(node.path);
                setContextMenu(null);
              }}
            >
              {t("filetree.openWorkspace")}
            </button>
          )}
          {/* N5：在资源管理器中显示并选中该文件（仅文件） */}
          {!node.isDir && (
            <button
              className="context-menu-item"
              onClick={() => {
                fileService.revealInFolder(node.path).catch(() => {});
                setContextMenu(null);
              }}
            >
              {t("common.revealInFolder")}
            </button>
          )}
          {/* v0.8.4 需求2：复制/剪切（文件与文件夹通用，写剪贴板 + toast 反馈由 FileTree 注入） */}
          {onCopyNode && (
            <button
              className="context-menu-item"
              onClick={() => {
                onCopyNode(node);
                setContextMenu(null);
              }}
            >
              {t("filetree.copy")}
            </button>
          )}
          {onCutNode && (
            <button
              className="context-menu-item"
              onClick={() => {
                onCutNode(node);
                setContextMenu(null);
              }}
            >
              {t("filetree.cut")}
            </button>
          )}
          {/* v0.8.4 反馈1：粘贴（仅文件夹节点——对文件粘贴无意义，不渲染）。
              紧接"复制/剪切"组，与空白区右键菜单的粘贴项语义一致。
              disabled 在渲染期实时读取 hasClipboard()：菜单打开本身即触发一次渲染，
              因此复制/剪切后重开菜单必然是可用态（不再有快照过期导致的错误置灰）。 */}
          {node.isDir && onPasteInto && (
            <button
              className="context-menu-item"
              disabled={!hasClipboard()}
              title={hasClipboard() ? t("filetree.paste") : t("filetree.pasteEmpty")}
              onClick={() => {
                onPasteInto(node.path);
                setContextMenu(null);
              }}
            >
              {t("filetree.paste")}
            </button>
          )}
          <button
            className="context-menu-item"
            onClick={() => {
              onRenameStart(node.path);
              setContextMenu(null);
            }}
          >
            {t("filetree.rename")}
          </button>
          <button
            className="context-menu-item danger"
            onClick={() => {
              onDelete(node);
              setContextMenu(null);
            }}
          >
            {t("common.delete")}
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
