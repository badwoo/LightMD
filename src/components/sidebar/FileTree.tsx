/**
 * FileTree ── 侧边栏文件树（带工具栏和最近文件）
 */
import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { open as dialogOpen, save } from "@tauri-apps/plugin-dialog";
import { useFileStore } from "../../stores/useFileStore";
import { useEditorStore } from "../../stores/useEditorStore";
import { fileService, isTauri, type FileEntry } from "../../services/fileService";
import { FileEntryNode, type FileNodeData } from "./FileNode";
import { RecentFiles } from "./RecentFiles";
import { isSupportedTextFile } from "../../utils/constants";
import "./FileTree.css";

/** 将 Rust 返回的 FileEntry (snake_case) 转为 store 的 FileNode (camelCase) */
function mapToFileNode(entry: FileEntry): FileNodeData {
  return {
    name: entry.name,
    path: entry.path,
    isDir: entry.is_dir,
    size: entry.size,
    children: [],
  };
}

// ─── 工具函数 ──────────────────────────────────────────

// 文件类型判断统一使用 constants.ts 中的 isSupportedTextFile

/** 递归排序文件树（文件夹在前，字母序） */
function sortTree(tree: FileNodeData[]): FileNodeData[] {
  return [...tree]
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .map((node) => ({
      ...node,
      children: node.children ? sortTree(node.children) : node.children,
    }));
}

/** 从路径中提取父目录（兼容 Windows 和 Unix 路径） */
function getParentDir(path: string): string {
  const idx = path.replace(/\\/g, "/").lastIndexOf("/");
  return idx > 0 ? path.substring(0, idx) : path;
}

/** 拼接路径（兼容 Windows） */
function joinPath(...parts: string[]): string {
  return parts.join("/");
}

// ─── 组件 ────────────────────────────────────────────────

export function FileTree() {
  const rootPath = useFileStore((s) => s.rootPath);
  const fileTree = useFileStore((s) => s.fileTree);
  const tempFiles = useFileStore((s) => s.tempFiles);
  const setRootPath = useFileStore((s) => s.setRootPath);
  const setFileTree = useFileStore((s) => s.setFileTree);
  const addRecentFile = useFileStore((s) => s.addRecentFile);
  const addTempFile = useFileStore((s) => s.addTempFile);
  const removeTempFile = useFileStore((s) => s.removeTempFile);
  // 同步全局 filePath，确保关闭文件时能正确判断当前活跃文件
  const globalFilePath = useEditorStore((s) => s.filePath);

  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const expandedPathsRef = useRef<Set<string>>(new Set());
  // 同步 expandedPaths 到 ref
  useEffect(() => { expandedPathsRef.current = expandedPaths; }, [expandedPaths]);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  // 同步 activePath 与全局 filePath（处理拖拽、Ctrl+O 等非 FileTree 途径打开的文件）
  useEffect(() => { setActivePath(globalFilePath); }, [globalFilePath]);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  // 缓存已加载的子目录
  const [childrenMap, setChildrenMap] = useState<Map<string, FileNodeData[]>>(new Map());

  // 将 store 中的 FileNode[] 转为 FileNodeData[]，合并已加载的子目录
  const treeData: FileNodeData[] = useMemo(() => {
    const mergeChildren = (nodes: FileNodeData[]): FileNodeData[] => {
      return nodes.map((f) => {
        const cached = childrenMap.get(f.path);
        return {
          name: f.name,
          path: f.path,
          isDir: f.isDir,
          size: f.size,
          children: f.isDir && cached ? mergeChildren(cached) : [],
        };
      });
    };
    return sortTree(mergeChildren(fileTree));
  }, [fileTree, childrenMap]);

  // ─── 打开文件夹 ──────────────────────────────

  // 打开指定路径的文件夹（核心逻辑，供按钮点击和拖拽打开复用）
  const openFolderAt = useCallback(async (selected: string) => {
    try {
      setRootPath(selected);
      const entries = await fileService.listDir(selected);
      const nodes = entries.map(mapToFileNode);
      setFileTree(nodes);
      // 缓存根目录子节点
      setChildrenMap(new Map([[selected, sortTree(nodes)]]));
      setExpandedPaths(new Set());
    } catch (err) {
      showMessage("打开文件夹失败");
      console.error(err);
    }
  }, [setRootPath, setFileTree]);

  const openFolder = useCallback(async () => {
    if (isTauri()) {
      try {
        const selected = await dialogOpen({ directory: true, multiple: false });
        if (selected) {
          await openFolderAt(selected);
        }
      } catch (err) {
        showMessage("打开文件夹失败");
        console.error(err);
      }
    } else {
      const mockPath = "/demo-project";
      setRootPath(mockPath);
      const mockTree: FileNodeData[] = [
        { name: "docs", path: "/demo-project/docs", isDir: true, size: 0, children: [] },
        { name: "src", path: "/demo-project/src", isDir: true, size: 0, children: [] },
        { name: "README.md", path: "/demo-project/README.md", isDir: false, size: 2048 },
        { name: "notes.md", path: "/demo-project/notes.md", isDir: false, size: 512 },
        { name: "guide.md", path: "/demo-project/guide.md", isDir: false, size: 1024 },
      ];
      setFileTree(mockTree);
    }
  }, [setRootPath, setFileTree]);

  // ─── 关闭文件夹 ──────────────────────────────
  // 清空文件夹相关状态，与"打开的文件"关闭按钮体验一致
  const closeFolder = useCallback(() => {
    setRootPath(null);
    setFileTree([]);
    setChildrenMap(new Map());
    setExpandedPaths(new Set());
  }, [setRootPath, setFileTree]);

  // ─── 拖拽文件夹打开（监听 App.tsx 派发的事件）─────────
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.path) {
        openFolderAt(detail.path);
      }
    };
    window.addEventListener("lightmd:openFolder", handler);
    return () => window.removeEventListener("lightmd:openFolder", handler);
  }, [openFolderAt]);

  // ─── 打开文件 ────────────────────────────────

  const handleSelectFile = useCallback(
    async (node: FileNodeData) => {
      if (node.isDir) return;
      if (!isSupportedTextFile(node.name)) {
        showMessage("不支持的文件类型");
        return;
      }

      setActivePath(node.path);

      try {
        let content = "";
        if (isTauri()) {
          content = await fileService.readFile(node.path);
        } else {
          content = localStorage.getItem("lightmd-content") || "";
        }

        // 空文件使用默认内容
        if (!content.trim()) {
          content = `# ${node.name.replace(/\.md$/i, "")}\n\n`;
        }

        window.dispatchEvent(
          new CustomEvent("lightmd:openFile", {
            detail: { path: node.path, content },
          })
        );

        addRecentFile({ path: node.path, name: node.name });

        // 如果文件不在当前目录树中，添加为临时文件
        if (rootPath && !node.path.startsWith(rootPath)) {
          addTempFile({ name: node.name, path: node.path, isDir: false, size: 0 });
        }
      } catch (err) {
        showMessage(`打开文件失败`);
        console.error(err);
      }
    },
    [addRecentFile, addTempFile, rootPath]
  );

  // ─── 展开/折叠 ───────────────────────────────

  const toggleExpand = useCallback(
    async (path: string) => {
      const next = new Set(expandedPaths);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        // 首次展开时，加载子目录
        if (isTauri() && !childrenMap.has(path)) {
          try {
            const entries = await fileService.listDir(path);
            const childNodes = sortTree(entries.map(mapToFileNode));
            setChildrenMap((prev) => {
              const next = new Map(prev);
              next.set(path, childNodes);
              return next;
            });
          } catch (err) {
            console.error("加载子目录失败:", err);
          }
        }
      }
      setExpandedPaths(next);
    },
    [expandedPaths, childrenMap]
  );

  // ─── 刷新文件树（递归刷新所有已展开的子目录）──────────
  // 注意：refreshTree 必须在其他 useCallback 之前声明，因为它们依赖 refreshTree

  const refreshTree = useCallback(async () => {
    if (!rootPath || !isTauri()) return;
    try {
      // 使用 ref 获取最新的 expandedPaths，避免闭包问题
      const currentExpanded = expandedPathsRef.current;

      // 递归加载目录内容
      const loadDir = async (dirPath: string): Promise<FileNodeData[]> => {
        const entries = await fileService.listDir(dirPath);
        return sortTree(entries.map(mapToFileNode));
      };

      // 加载根目录
      const rootNodes = await loadDir(rootPath);

      // 构建新的 childrenMap
      const newChildrenMap = new Map<string, FileNodeData[]>();
      newChildrenMap.set(rootPath, rootNodes);

      // 递归刷新已展开的子目录
      const refreshExpanded = async (items: FileNodeData[]) => {
        for (const item of items) {
          if (item.isDir && currentExpanded.has(item.path)) {
            try {
              const childNodes = await loadDir(item.path);
              newChildrenMap.set(item.path, childNodes);
              await refreshExpanded(childNodes);
            } catch (err) {
              console.error(`刷新子目录失败 ${item.path}:`, err);
            }
          }
        }
      };

      await refreshExpanded(rootNodes);

      // 清除不再存在的子目录路径
      const validPaths = new Set<string>();
      const collectPaths = (items: FileNodeData[]) => {
        for (const item of items) {
          validPaths.add(item.path);
          if (item.isDir && newChildrenMap.has(item.path)) {
            collectPaths(newChildrenMap.get(item.path)!);
          }
        }
      };
      collectPaths(rootNodes);
      for (const [key] of newChildrenMap) {
        if (key !== rootPath && !validPaths.has(key)) {
          newChildrenMap.delete(key);
        }
      }

      // 同时更新 fileTree 和 childrenMap，避免中间状态导致树消失
      setFileTree(rootNodes);
      setChildrenMap(newChildrenMap);
    } catch (err) {
      console.error("刷新文件树失败:", err);
    }
  }, [rootPath, setFileTree]);

  // ─── 重命名 ──────────────────────────────────

  const handleRenameStart = useCallback((path: string) => {
    setRenamingPath(path);
  }, []);

  const handleRenameConfirm = useCallback(
    async (path: string, newName: string) => {
      setRenamingPath(null);
      try {
        const parentDir = getParentDir(path);
        const newPath = joinPath(parentDir, newName);

        if (isTauri()) {
          await fileService.renameFile(path, newPath);
        }

        showMessage(`已重命名: ${newName}`);
        await refreshTree();
      } catch (err) {
        showMessage("重命名失败");
        console.error(err);
      }
    },
    [refreshTree]
  );

  const handleRenameCancel = useCallback(() => {
    setRenamingPath(null);
  }, []);

  // ─── 新建文件/文件夹 ──────────────────────────

  const handleNewFile = useCallback(
    async (parentPath: string) => {
      // 没有父目录时，弹出另存为对话框选择位置
      if (!parentPath) {
        if (isTauri()) {
          try {
            const selected = await save({
              defaultPath: "新文档.md",
              filters: [{ name: "Markdown", extensions: ["md"] }],
            });
            if (selected) {
              const defaultContent = "# 新文档\n\n";
              await fileService.writeFile(selected, defaultContent);
              window.dispatchEvent(
                new CustomEvent("lightmd:openFile", {
                  detail: { path: selected, content: defaultContent },
                })
              );
              addRecentFile({ path: selected, name: selected.split(/[\\/]/).pop() || "新文档.md" });
              showMessage(`已创建: ${selected.split(/[\\/]/).pop()}`);
            }
          } catch (err) {
            showMessage("创建文件失败");
            console.error(err);
          }
        } else {
          showMessage("请先打开文件夹");
        }
        return;
      }

      const name = prompt("输入文件名（.md）:", "新文档.md");
      if (!name) return;

      try {
        const filePath = joinPath(parentPath, name);

        if (isTauri()) {
          await fileService.createFile(filePath);
        }

        showMessage(`已创建: ${name}`);
        // 确保父目录展开
        setExpandedPaths((prev) => {
          const next = new Set(prev);
          next.add(parentPath);
          return next;
        });
        // 刷新目录树（会递归刷新已展开的目录）
        await refreshTree();
        // 选中新创建的文件
        setActivePath(filePath);
      } catch (err) {
        showMessage("创建文件失败");
        console.error(err);
      }
    },
    [refreshTree, addRecentFile]
  );

  const handleNewFolder = useCallback(
    async (parentPath: string) => {
      // 没有父目录时，弹出选择文件夹对话框
      if (!parentPath) {
        showMessage("请先打开文件夹后再新建文件夹");
        return;
      }

      const name = prompt("输入文件夹名:", "新文件夹");
      if (!name) return;

      try {
        const dirPath = joinPath(parentPath, name);

        if (isTauri()) {
          await fileService.createDir(dirPath);
        }

        showMessage(`已创建文件夹: ${name}`);
        // 确保父目录展开
        setExpandedPaths((prev) => {
          const next = new Set(prev);
          next.add(parentPath);
          return next;
        });
        // 刷新目录树
        await refreshTree();
      } catch (err) {
        showMessage("创建文件夹失败");
        console.error(err);
      }
    },
    [refreshTree]
  );

  // ─── 删除文件 ────────────────────────────────

  const handleDelete = useCallback(
    async (node: FileNodeData) => {
      const confirmed = confirm(`确认删除 ${node.isDir ? "文件夹" : "文件"} "${node.name}"？`);
      if (!confirmed) return;

      try {
        if (isTauri()) {
          await fileService.deleteFile(node.path);
        }

        showMessage(`已删除: ${node.name}`);
        await refreshTree();
      } catch (err) {
        showMessage("删除失败");
        console.error(err);
      }
    },
    [refreshTree]
  );

  // ─── 拖拽（图片等） ──────────────────────────

  const handleDragStart = useCallback(
    (node: FileNodeData, e: React.DragEvent) => {
      e.dataTransfer.setData("text/uri-list", `file://${node.path}`);
      e.dataTransfer.setData("text/plain", node.path);
    },
    []
  );

  // ─── 状态消息 ────────────────────────────────

  function showMessage(msg: string) {
    setStatusMessage(msg);
    setTimeout(() => setStatusMessage(null), 3000);
  }

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  // ─── 临时文件右键菜单 ────────────────────────────

  const [tempContextMenu, setTempContextMenu] = useState<{ x: number; y: number; file: FileNodeData } | null>(null);

  // 关闭临时文件：从列表移除，同步关闭对应标签，如果当前活跃则切换到下一个/上一个文件
  const closeTempFile = useCallback((file: FileNodeData) => {
    const currentIdx = tempFiles.findIndex(f => f.path === file.path);
    removeTempFile(file.path);

    // 同步关闭对应的标签页
    const { openTabs, closeTab, activeTabIdx } = useEditorStore.getState();
    const tabIdx = openTabs.findIndex(t => t.path === file.path);
    if (tabIdx !== -1) {
      closeTab(tabIdx);
      // 如果关闭的是当前激活标签，需要切换内容
      if (tabIdx === activeTabIdx) {
        const remainingTabs = useEditorStore.getState().openTabs;
        const newActiveIdx = useEditorStore.getState().activeTabIdx;
        if (remainingTabs.length > 0 && remainingTabs[newActiveIdx]) {
          // 切换到新的活跃标签
          const activeTab = remainingTabs[newActiveIdx];
          window.dispatchEvent(new CustomEvent("lightmd:openFile", {
            detail: { path: activeTab.path, content: activeTab.content || "" },
          }));
        } else {
          // 没有剩余标签，清空编辑器
          window.dispatchEvent(new CustomEvent("lightmd:closeFile"));
        }
      }
    }

    if (activePath === file.path) {
      // 查找下一个或上一个文件
      const remaining = tempFiles.filter(f => f.path !== file.path);
      let nextFile: FileNodeData | undefined;
      if (currentIdx < remaining.length) {
        nextFile = remaining[currentIdx]; // 下一个
      } else if (currentIdx > 0) {
        nextFile = remaining[currentIdx - 1]; // 上一个
      }

      if (nextFile) {
        setActivePath(nextFile.path);
        // 打开下一个/上一个文件（仅当标签页没有处理时）
        if (tabIdx === -1) {
          handleSelectFile({ ...nextFile, children: [] });
        }
      } else {
        setActivePath(null);
        // 没有其他文件且标签页也没有处理时，清空编辑器
        if (tabIdx === -1) {
          window.dispatchEvent(new CustomEvent("lightmd:closeFile"));
        }
      }
    }
  }, [removeTempFile, activePath, tempFiles, handleSelectFile]);

  // 重命名临时文件
  const [tempRenamingPath, setTempRenamingPath] = useState<string | null>(null);
  const [tempRenameValue, setTempRenameValue] = useState("");
  const tempRenameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (tempRenamingPath && tempRenameInputRef.current) {
      tempRenameInputRef.current.focus();
      const dotIdx = tempRenameValue.lastIndexOf(".");
      tempRenameInputRef.current.setSelectionRange(0, dotIdx > 0 ? dotIdx : tempRenameValue.length);
    }
  }, [tempRenamingPath, tempRenameValue]);

  const handleTempRenameConfirm = useCallback(async (file: FileNodeData) => {
    const newName = tempRenameValue.trim();
    setTempRenamingPath(null);
    if (!newName || newName === file.name) return;
    try {
      const parentDir = file.path.replace(/\\/g, "/").replace(/\/[^/]*$/, "");
      const newPath = joinPath(parentDir, newName);
      if (isTauri()) {
        await fileService.renameFile(file.path, newPath);
      }
      removeTempFile(file.path);
      addTempFile({ name: newName, path: newPath, isDir: false, size: 0 });
      if (activePath === file.path) setActivePath(newPath);
      showMessage(`已重命名: ${newName}`);
    } catch (err) {
      showMessage("重命名失败");
      console.error(err);
    }
  }, [tempRenameValue, removeTempFile, addTempFile, activePath]);

  // 查看文件属性
  const handleViewProperties = useCallback((file: FileNodeData) => {
    const parentDir = file.path.replace(/\\/g, "/").replace(/\/[^/]*$/, "");
    const ext = file.name.split(".").pop()?.toLowerCase() || "";
    const info = [
      `文件名: ${file.name}`,
      `路径: ${file.path}`,
      `目录: ${parentDir}`,
      `类型: ${ext ? `.${ext} 文件` : "未知"}`,
      file.size > 0 ? `大小: ${formatFileSize(file.size)}` : "",
    ].filter(Boolean).join("\n");
    alert(info);
  }, []);

  // 关闭临时文件右键菜单
  useEffect(() => {
    if (!tempContextMenu) return;
    const close = () => setTempContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [tempContextMenu]);

  // 选中的临时文件索引（用于快捷键）
  const [selectedTempIdx, setSelectedTempIdx] = useState<number>(-1);

  // Delete键/Ctrl+2 快捷键关闭临时文件
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Delete 键关闭选中的临时文件
      if (e.key === "Delete" && selectedTempIdx >= 0 && selectedTempIdx < tempFiles.length) {
        e.preventDefault();
        closeTempFile(tempFiles[selectedTempIdx]);
        setSelectedTempIdx(-1);
        return;
      }
      // Ctrl+2 关闭选中的临时文件
      if (e.ctrlKey && e.key === "2" && selectedTempIdx >= 0 && selectedTempIdx < tempFiles.length) {
        e.preventDefault();
        closeTempFile(tempFiles[selectedTempIdx]);
        setSelectedTempIdx(-1);
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedTempIdx, tempFiles, closeTempFile]);

  // ─── Ctrl+R 刷新文件树 ────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "r") {
        e.preventDefault();
        refreshTree();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [refreshTree]);

  // ─── 渲染 ────────────────────────────────────

  return (
    <div className="filetree">
      {/* 头部工具栏 */}
      <div className="filetree-header">
        <span className="filetree-title">文件管理</span>
        <div className="filetree-actions">
          <button className="filetree-btn" title="新建文件" onClick={() => handleNewFile(rootPath || "")}>
            <svg width="14" height="14" viewBox="0 0 16 16"><path d="M9.5 1.1l3.4 3.5.1.4v4h-1V6H8V2H3v12h5v1H2.5l-.5-.5v-13l.5-.5h6.7l.3.1zM9 2v3h2.9L9 2z" fill="#5c9dff"/><path d="M14 8v2h2v1h-2v2h-1v-2h-2v-1h2V8h1z" fill="#4caf50"/></svg>
          </button>
          <button className="filetree-btn" title="新建文件夹" onClick={() => handleNewFolder(rootPath || "")}>
            <svg width="14" height="14" viewBox="0 0 16 16"><path d="M1.5 2h4.3l1 1H14.5l.5.5v9l-.5.5h-13l-.5-.5v-10l.5-.5z" fill="#ffc107"/><path d="M2 3v8h12V4H6.7l-1-1H2z" fill="#ffd54f"/></svg>
          </button>
          <button className="filetree-btn" title="打开文件夹" onClick={openFolder}>
            <svg width="14" height="14" viewBox="0 0 16 16"><path d="M1.5 2h4.3l1 1H14.5l.5.5v9l-.5.5h-13l-.5-.5v-10l.5-.5z" fill="#ffa726"/><path d="M2 3v8h12V4H6.7l-1-1H2z" fill="#ffb74d"/></svg>
          </button>
          {rootPath && (
            <button className="filetree-btn" title="刷新" onClick={refreshTree}>
              <svg width="14" height="14" viewBox="0 0 16 16"><path d="M13.451 5.67l-.724-.69A5.5 5.5 0 008 2.5 5.5 5.5 0 002.5 8a5.5 5.5 0 009.227 4.077l-.69-.724A4.5 4.5 0 013.5 8 4.5 4.5 0 018 3.5a4.5 4.5 0 013.751 2h-2.25v1h4V2.5h-1v3.17z" fill="#66bb6a"/></svg>
            </button>
          )}
        </div>
      </div>

      {/* 根路径显示（含关闭按钮，hover 时显示） */}
      {rootPath && (
        <div className="filetree-root-path" title={rootPath}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{verticalAlign:"middle",marginRight:"4px"}}><path d="M8 1.5l.354.353 6 6-.708.708L13 7.707V13.5l-.5.5h-9l-.5-.5V7.707l-.646.354-.708-.708 6-6L8 1.5zM4 7v6h3V9.5l.5-.5h1l.5.5V13h3V7L8 2.707 4 7z"/></svg>
          <span className="filetree-root-name">{rootPath.replace(/\\/g, "/").split("/").pop() || rootPath}</span>
          <button
            className="filetree-root-close"
            title="关闭文件夹"
            onClick={(e) => { e.stopPropagation(); closeFolder(); }}
          >
            ×
          </button>
        </div>
      )}

      {/* 状态消息 */}
      {statusMessage && (
        <div className="filetree-status">{statusMessage}</div>
      )}

      {/* 文件树列表 */}
      <div className="filetree-list" onContextMenu={(e) => e.preventDefault()}>
        {rootPath ? (
          treeData.length > 0 ? (
            treeData.map((node) => (
              <FileEntryNode
                key={node.path}
                node={node}
                depth={0}
                activePath={activePath}
                renamingPath={renamingPath}
                expandedPaths={expandedPaths}
                onSelect={handleSelectFile}
                onToggleExpand={toggleExpand}
                onRenameStart={handleRenameStart}
                onRenameConfirm={handleRenameConfirm}
                onRenameCancel={handleRenameCancel}
                onDelete={handleDelete}
                onNewFile={handleNewFile}
                onNewFolder={handleNewFolder}
                onDragStart={handleDragStart}
                onRefresh={refreshTree}
              />
            ))
          ) : (
            <div className="filetree-placeholder">此文件夹为空</div>
          )
        ) : (
          <div className="filetree-placeholder">
            <p>点击上方按钮打开文件夹</p>
            <p className="filetree-hint">或拖拽 .md 文件到编辑器</p>
          </div>
        )}

        {/* 临时打开的文件（不在当前目录树中的文件） */}
        {tempFiles.length > 0 && (
          <div className="filetree-temp-section">
            <div className="filetree-temp-header">打开的文件</div>
            {tempFiles.map((file, idx) => {
              const parentDir = file.path.replace(/\\/g, "/").replace(/\/[^/]*$/, "");
              const isActive = activePath === file.path;
              const isSelected = selectedTempIdx === idx;
              const isRenaming = tempRenamingPath === file.path;
              return (
                <div
                  key={file.path}
                  className={`filetree-node filetree-temp-node ${isActive ? "active" : ""} ${isSelected ? "selected" : ""}`}
                  style={{ paddingLeft: "8px" }}
                  onClick={() => { handleSelectFile({ ...file, children: [] }); setSelectedTempIdx(idx); }}
                  onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setTempContextMenu({ x: e.clientX, y: e.clientY, file }); }}
                  title={file.path}
                >
                  <span className="filetree-icon">
                    <svg width="14" height="14" viewBox="0 0 16 16"><path d="M9.5 1.1l3.4 3.5.1.4v10l-.5.5h-9l-.5-.5v-13l.5-.5h6.7l.3.1zM9 2v3h2.9L9 2z" fill="#5c9dff"/></svg>
                  </span>
                  {isRenaming ? (
                    <input
                      ref={tempRenameInputRef}
                      className="filetree-rename-input"
                      value={tempRenameValue}
                      onChange={(e) => setTempRenameValue(e.target.value)}
                      onBlur={() => handleTempRenameConfirm(file)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleTempRenameConfirm(file);
                        if (e.key === "Escape") setTempRenamingPath(null);
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span className="filetree-name">{file.name}</span>
                  )}
                  <span className="filetree-size" style={{ fontSize: "10px" }}>{parentDir}</span>
                  {/* 关闭按钮 */}
                  <button
                    className="filetree-temp-close"
                    title="关闭"
                    onClick={(e) => { e.stopPropagation(); closeTempFile(file); }}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* 临时文件右键菜单 */}
        {tempContextMenu && (
          <div
            className="filetree-context-menu"
            style={{
              left: tempContextMenu.x,
              top: tempContextMenu.y,
              position: "fixed",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="context-menu-item danger"
              onClick={() => {
                closeTempFile(tempContextMenu.file);
                setTempContextMenu(null);
              }}
            >
              关闭文件
            </button>
            <button
              className="context-menu-item"
              onClick={() => {
                setTempRenamingPath(tempContextMenu.file.path);
                setTempRenameValue(tempContextMenu.file.name);
                setTempContextMenu(null);
              }}
            >
              重命名
            </button>
            <button
              className="context-menu-item"
              onClick={() => {
                handleViewProperties(tempContextMenu.file);
                setTempContextMenu(null);
              }}
            >
              查看属性
            </button>
          </div>
        )}
      </div>

      {/* 最近文件 */}
      {!rootPath && <RecentFiles onOpen={handleSelectFile} />}
    </div>
  );
}
