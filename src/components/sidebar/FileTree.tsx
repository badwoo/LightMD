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
import { Favorites } from "./Favorites";
import { useT } from "../../i18n";
import { isSupportedTextFile } from "../../utils/constants";
import { useResizable } from "../../hooks/useResizable";
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

/**
 * v0.6.6 问题3：焦点是否在可编辑元素上（textarea / input / contenteditable）。
 * 用于 Delete 关闭临时文件快捷键的守卫——焦点在编辑器内打字删除时
 * 不应触发 window 级快捷键误关文件。
 */
export function isFocusInEditable(active: Element | null): boolean {
  return (
    active instanceof HTMLElement &&
    (active.tagName === "TEXTAREA" ||
      active.tagName === "INPUT" ||
      // isContentEditable 在 jsdom 中未实现（undefined），用属性兜底判断
      active.isContentEditable === true ||
      active.hasAttribute("contenteditable"))
  );
}

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
  const openFolders = useFileStore((s) => s.openFolders);
  const tempFiles = useFileStore((s) => s.tempFiles);
  // v0.4.0：多文件夹操作
  const addOpenFolder = useFileStore((s) => s.addOpenFolder);
  const removeOpenFolder = useFileStore((s) => s.removeOpenFolder);
  const updateFolderTree = useFileStore((s) => s.updateFolderTree);
  const isPathInOpenFolders = useFileStore((s) => s.isPathInOpenFolders);
  const addRecentFile = useFileStore((s) => s.addRecentFile);
  const addTempFile = useFileStore((s) => s.addTempFile);
  const removeTempFile = useFileStore((s) => s.removeTempFile);
  // G7：收藏操作（addFavorite/isFavorite 用于右键菜单切换文案）
  const addFavorite = useFileStore((s) => s.addFavorite);
  const removeFavorite = useFileStore((s) => s.removeFavorite);
  const favorites = useFileStore((s) => s.favorites);
  const renameFileEntry = useFileStore((s) => s.renameFileEntry);
  const t = useT();
  // 同步全局 filePath，确保关闭文件时能正确判断当前活跃文件
  const globalFilePath = useEditorStore((s) => s.filePath);

  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const expandedPathsRef = useRef<Set<string>>(new Set());
  // 同步 expandedPaths 到 ref
  useEffect(() => { expandedPathsRef.current = expandedPaths; }, [expandedPaths]);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  // 直接使用 globalFilePath 作为 activePath，避免 useEffect 延迟导致双高亮
  const activePath = globalFilePath;
  const setActivePath = (path: string | null) => {
    // activePath 现在直接从 store 派生，setActivePath 仅在需要即时更新时调用
    // 实际更新通过 openFile/store 完成
  };
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  // 缓存已加载的子目录
  const [childrenMap, setChildrenMap] = useState<Map<string, FileNodeData[]>>(new Map());

  // v0.4.1：收藏/最近区域显示开关（标题栏 toggle 按钮控制）
  // Issue 2 修复：收藏栏默认改为关闭状态
  const [showFavorites, setShowFavorites] = useState(false);
  const [showRecent, setShowRecent] = useState(true);

  // v0.4.3 Issue 2：全局文件搜索
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  // v0.4.1：各功能栏垂直拖拽调整高度（独立 useResizable 实例，钳制 [80,400]）
  const tempResize = useResizable({ direction: "vertical", initialHeight: 200, minHeight: 80, maxHeight: 400 });
  const favResize = useResizable({ direction: "vertical", initialHeight: 200, minHeight: 80, maxHeight: 400 });
  const recentResize = useResizable({ direction: "vertical", initialHeight: 200, minHeight: 80, maxHeight: 400 });

  // v0.4.0：按文件夹分别计算 treeData（每个文件夹独立合并已加载的子目录）
  const treeDataByFolder = useMemo(() => {
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
    return openFolders.map((folder) => ({
      folder,
      nodes: sortTree(mergeChildren(folder.fileTree)),
    }));
  }, [openFolders, childrenMap]);

  // v0.4.3 Issue 2：全局文件搜索结果（递归遍历所有打开文件夹的文件树 + 临时文件 + 收藏文件）
  const searchResults = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return [];
    const results: Array<{ name: string; path: string }> = [];
    const seenPaths = new Set<string>();
    // 递归遍历文件树节点（treeDataByFolder 已合并 childrenMap 缓存的子目录）
    const collect = (nodes: FileNodeData[]) => {
      for (const node of nodes) {
        if (node.isDir) {
          if (node.children) collect(node.children);
        } else {
          if (node.name.toLowerCase().includes(query) && !seenPaths.has(node.path)) {
            seenPaths.add(node.path);
            results.push({ name: node.name, path: node.path });
          }
        }
      }
    };
    for (const { nodes } of treeDataByFolder) collect(nodes);
    for (const file of tempFiles) {
      if (file.name.toLowerCase().includes(query) && !seenPaths.has(file.path)) {
        seenPaths.add(file.path);
        results.push({ name: file.name, path: file.path });
      }
    }
    for (const fav of favorites) {
      if (fav.name.toLowerCase().includes(query) && !seenPaths.has(fav.path)) {
        seenPaths.add(fav.path);
        results.push({ name: fav.name, path: fav.path });
      }
    }
    return results;
  }, [searchQuery, treeDataByFolder, tempFiles, favorites]);

  // v0.4.3 Issue 2：搜索框激活时自动聚焦
  useEffect(() => {
    if (showSearch) {
      searchInputRef.current?.focus();
    } else {
      setSearchQuery("");
    }
  }, [showSearch]);

  // ─── 打开文件夹 ──────────────────────────────

  // 打开指定路径的文件夹（核心逻辑，供按钮点击和拖拽打开复用）
  // v0.4.0：改用 addOpenFolder + updateFolderTree，支持同时打开多个文件夹
  const openFolderAt = useCallback(async (selected: string) => {
    try {
      addOpenFolder(selected);
      const entries = await fileService.listDir(selected);
      const nodes = entries.map(mapToFileNode);
      updateFolderTree(selected, nodes);
      // 缓存根目录子节点（保留其他文件夹的缓存）
      setChildrenMap((prev) => {
        const next = new Map(prev);
        next.set(selected, sortTree(nodes));
        return next;
      });
      setExpandedPaths(new Set());
    } catch (err) {
      showMessage(t("filetree.openFolderFailed"));
      console.error(err);
    }
  }, [addOpenFolder, updateFolderTree, t]);

  const openFolder = useCallback(async () => {
    if (isTauri()) {
      try {
        const selected = await dialogOpen({ directory: true, multiple: false });
        if (selected) {
          await openFolderAt(selected);
        }
      } catch (err) {
        showMessage(t("filetree.openFolderFailed"));
        console.error(err);
      }
    } else {
      const mockPath = "/demo-project";
      addOpenFolder(mockPath);
      const mockTree: FileNodeData[] = [
        { name: "docs", path: "/demo-project/docs", isDir: true, size: 0, children: [] },
        { name: "src", path: "/demo-project/src", isDir: true, size: 0, children: [] },
        { name: "README.md", path: "/demo-project/README.md", isDir: false, size: 2048 },
        { name: "notes.md", path: "/demo-project/notes.md", isDir: false, size: 512 },
        { name: "guide.md", path: "/demo-project/guide.md", isDir: false, size: 1024 },
      ];
      updateFolderTree(mockPath, mockTree);
    }
  }, [addOpenFolder, updateFolderTree, t]);

  // ─── 关闭文件夹 ──────────────────────────────
  // v0.4.0：移除指定文件夹，清理该文件夹相关的 childrenMap 和 expandedPaths
  const closeFolder = useCallback((folderPath: string) => {
    removeOpenFolder(folderPath);
    // 清理该文件夹路径前缀下的缓存和展开状态
    setChildrenMap((prev) => {
      const next = new Map(prev);
      for (const key of Array.from(next.keys())) {
        if (key === folderPath || key.startsWith(folderPath + "/") || key.startsWith(folderPath + "\\")) {
          next.delete(key);
        }
      }
      return next;
    });
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      for (const key of Array.from(next)) {
        if (key === folderPath || key.startsWith(folderPath + "/") || key.startsWith(folderPath + "\\")) {
          next.delete(key);
        }
      }
      return next;
    });
  }, [removeOpenFolder]);

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
        showMessage(t("filetree.unsupportedFileType"));
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
            detail: { path: node.path, name: node.name, content },
          })
        );

        addRecentFile({ path: node.path, name: node.name });

        // v0.4.0：如果文件不在任一已打开文件夹下，添加为临时文件
        if (!isPathInOpenFolders(node.path)) {
          addTempFile({ name: node.name, path: node.path, isDir: false, size: 0 });
        }
      } catch (err) {
        showMessage(t("filetree.openFileFailed"));
        console.error(err);
      }
    },
    [addRecentFile, addTempFile, isPathInOpenFolders, t]
  );

  // v0.4.3 Issue 2：点击搜索结果打开文件
  const handleSearchResultClick = useCallback((result: { name: string; path: string }) => {
    handleSelectFile({ name: result.name, path: result.path, isDir: false, size: 0 });
    setShowSearch(false);
    setSearchQuery("");
  }, [handleSelectFile]);

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
  // v0.4.0：支持指定文件夹路径刷新，不传则刷新所有打开的文件夹

  const refreshTree = useCallback(async (folderPath?: string) => {
    if (!isTauri()) return;
    // v0.4.0：不传 folderPath 时刷新所有打开的文件夹；传参时仅刷新指定文件夹
    const targetPaths = folderPath ? [folderPath] : openFolders.map((f) => f.path);
    if (targetPaths.length === 0) return;
    // 使用 ref 获取最新的 expandedPaths，避免闭包问题
    const currentExpanded = expandedPathsRef.current;

    // 递归加载目录内容
    const loadDir = async (dirPath: string): Promise<FileNodeData[]> => {
      const entries = await fileService.listDir(dirPath);
      return sortTree(entries.map(mapToFileNode));
    };

    // 串行刷新每个文件夹（避免并发 IO 导致状态混乱）
    for (const targetPath of targetPaths) {
      try {
        // 加载根目录
        const rootNodes = await loadDir(targetPath);

        // 构建新的 childrenMap
        const newChildrenMap = new Map<string, FileNodeData[]>();
        newChildrenMap.set(targetPath, rootNodes);

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
          if (key !== targetPath && !validPaths.has(key)) {
            newChildrenMap.delete(key);
          }
        }

        // v0.4.0：更新 store 中该文件夹的 fileTree，并合并到 childrenMap（保留其他文件夹缓存）
        updateFolderTree(targetPath, rootNodes);
        setChildrenMap((prev) => {
          const next = new Map(prev);
          // 删除该文件夹下旧的缓存
          for (const key of Array.from(next.keys())) {
            if (key === targetPath || key.startsWith(targetPath + "/") || key.startsWith(targetPath + "\\")) {
              next.delete(key);
            }
          }
          // 加入新缓存
          for (const [k, v] of newChildrenMap) {
            next.set(k, v);
          }
          return next;
        });
      } catch (err) {
        console.error(`刷新文件夹失败 ${targetPath}:`, err);
      }
    }
  }, [openFolders, updateFolderTree]);

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

        // 联动更新收藏和最近文件中的路径和名称
        renameFileEntry(path, newPath, newName);
        // 同步更新已打开标签页的路径和名称
        const { openTabs, activeTabIdx } = useEditorStore.getState();
        const tabIdx = openTabs.findIndex((t) => t.path === path);
        if (tabIdx !== -1) {
          useEditorStore.setState((s) => ({
            openTabs: s.openTabs.map((t, i) =>
              i === tabIdx ? { ...t, path: newPath, name: newName } : t
            ),
          }));
        }
        // 同步全局 filePath（如果当前活跃文件被重命名）
        if (useEditorStore.getState().filePath === path) {
          useEditorStore.getState().openFile(newPath);
        }

        showMessage(t("filetree.renamed", { name: newName }));
        await refreshTree();
      } catch (err) {
        showMessage(t("filetree.renameFailed"));
        console.error(err);
      }
    },
    [refreshTree, renameFileEntry, t]
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
              defaultPath: t("filetree.newDocName"),
              filters: [{ name: t("app.markdownFilter"), extensions: ["md"] }],
            });
            if (selected) {
              const defaultContent = t("filetree.newDocContent");
              await fileService.writeFile(selected, defaultContent);
              window.dispatchEvent(
                new CustomEvent("lightmd:openFile", {
                  detail: { path: selected, content: defaultContent },
                })
              );
              addRecentFile({ path: selected, name: selected.split(/[\\/]/).pop() || t("filetree.newDocName") });
              showMessage(t("filetree.created", { name: selected.split(/[\\/]/).pop() || "" }));
            }
          } catch (err) {
            showMessage(t("filetree.createFileFailed"));
            console.error(err);
          }
        } else {
          showMessage(t("filetree.pleaseOpenFolder"));
        }
        return;
      }

      const name = prompt(t("filetree.inputFileName"), t("filetree.newDocName"));
      if (!name) return;

      try {
        const filePath = joinPath(parentPath, name);

        if (isTauri()) {
          await fileService.createFile(filePath);
        }

        showMessage(t("filetree.created", { name }));
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
        showMessage(t("filetree.createFileFailed"));
        console.error(err);
      }
    },
    [refreshTree, addRecentFile, t]
  );

  const handleNewFolder = useCallback(
    async (parentPath: string) => {
      // 没有父目录时，弹出选择文件夹对话框
      if (!parentPath) {
        showMessage(t("filetree.pleaseOpenFolderFirst"));
        return;
      }

      const name = prompt(t("filetree.inputFolderName"), t("filetree.newFolderDefault"));
      if (!name) return;

      try {
        const dirPath = joinPath(parentPath, name);

        if (isTauri()) {
          await fileService.createDir(dirPath);
        }

        showMessage(t("filetree.createdFolder", { name }));
        // 确保父目录展开
        setExpandedPaths((prev) => {
          const next = new Set(prev);
          next.add(parentPath);
          return next;
        });
        // 刷新目录树
        await refreshTree();
      } catch (err) {
        showMessage(t("filetree.createFolderFailed"));
        console.error(err);
      }
    },
    [refreshTree, t]
  );

  // ─── 删除文件 ────────────────────────────────

  const handleDelete = useCallback(
    async (node: FileNodeData) => {
      const confirmed = confirm(t("filetree.confirmDelete", { type: node.isDir ? t("filetree.folderType") : t("filetree.fileType"), name: node.name }));
      if (!confirmed) return;

      try {
        if (isTauri()) {
          await fileService.deleteFile(node.path);
        }

        showMessage(t("filetree.deleted", { name: node.name }));
        await refreshTree();
      } catch (err) {
        showMessage(t("filetree.deleteFailed"));
        console.error(err);
      }
    },
    [refreshTree, t]
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
      // 联动更新收藏和最近文件中的路径和名称
      renameFileEntry(file.path, newPath, newName);
      removeTempFile(file.path);
      addTempFile({ name: newName, path: newPath, isDir: false, size: 0 });
      // 同步更新已打开标签页的路径和名称
      const { openTabs } = useEditorStore.getState();
      const tabIdx = openTabs.findIndex((t) => t.path === file.path);
      if (tabIdx !== -1) {
        useEditorStore.setState((s) => ({
          openTabs: s.openTabs.map((t, i) =>
            i === tabIdx ? { ...t, path: newPath, name: newName } : t
          ),
        }));
      }
      // 同步全局 filePath
      if (useEditorStore.getState().filePath === file.path) {
        useEditorStore.getState().openFile(newPath);
      }
      if (activePath === file.path) setActivePath(newPath);
      showMessage(t("filetree.renamed", { name: newName }));
    } catch (err) {
      showMessage(t("filetree.renameFailed"));
      console.error(err);
    }
  }, [tempRenameValue, removeTempFile, addTempFile, activePath, renameFileEntry, t]);

  // 查看文件属性
  const handleViewProperties = useCallback((file: FileNodeData) => {
    const parentDir = file.path.replace(/\\/g, "/").replace(/\/[^/]*$/, "");
    const ext = file.name.split(".").pop()?.toLowerCase() || "";
    const info = [
      t("filetree.propFileName", { name: file.name }),
      t("filetree.propFilePath", { path: file.path }),
      t("filetree.propFileDir", { dir: parentDir }),
      ext ? t("filetree.propFileType", { ext }) : t("filetree.propUnknownType"),
      file.size > 0 ? t("filetree.propFileSize", { size: formatFileSize(file.size) }) : "",
    ].filter(Boolean).join("\n");
    alert(info);
  }, [t]);

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
      // v0.6.6 问题3修复：焦点在可编辑元素（源码 textarea / ProseMirror / 输入框）时
      // 不响应 Delete 快捷键——此前 window 级监听会在用户编辑文字按 Delete 删字时
      // 误触发 closeTempFile，把正在编辑的文件关闭
      if (isFocusInEditable(document.activeElement)) {
        return;
      }
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

  // v0.4.5 修复：提取 tempFiles 栏渲染为函数，避免在两个位置（顶部/底部）重复 JSX
  // 根据 openFolders 状态决定渲染位置：
  // - 不打开文件夹：渲染在顶部（FolderSection 之前）
  // - 打开文件夹：渲染在 FolderSection 之后
  const renderTempFilesSection = (): React.ReactNode => {
    if (tempFiles.length === 0) return null;
    return (
      <>
        <div className="filetree-v-resizer" onMouseDown={tempResize.onMouseDown} />
        <div className="filetree-temp-section" style={{ height: tempResize.height }}>
          {/* Issue 2：标题栏绑定 tempResize.onMouseDown 实现上下拖拽 */}
          <div className="filetree-temp-header" onMouseDown={tempResize.onMouseDown}>
            <span className="filetree-title">{t("filetree.openedFiles")}</span>
            {/* Issue 5：查看版本快照按钮入口（临时文件也支持快照功能） */}
            <button
              className="filetree-btn filetree-temp-snapshot-btn"
              title={t("snapshot.viewSnapshots")}
              onClick={(e) => {
                e.stopPropagation();
                // 优先使用当前活跃文件路径，否则用第一个临时文件路径
                const targetPath = activePath || tempFiles[0]?.path;
                if (targetPath) {
                  window.dispatchEvent(new CustomEvent("lightmd:showSnapshotDialog", { detail: { filePath: targetPath } }));
                }
              }}
            >
              {/* Issue 5 修复：更换为相机/快照图标，避免与"最近打开"的时钟图标重复 */}
              <svg width="14" height="14" viewBox="0 0 16 16">
                <path d="M5 3h6l1 2h2v8H2V5h2z" fill="none" stroke="currentColor" strokeWidth="1.2"/>
                <circle cx="8" cy="9" r="2.5" fill="none" stroke="currentColor" strokeWidth="1.2"/>
              </svg>
            </button>
          </div>
          {/* v0.4.1：临时文件列表独立滚动容器 */}
          <div className="filetree-temp-content">
            {tempFiles.map((file, idx) => {
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
                  {/* 关闭按钮 */}
                  <button
                    className="filetree-temp-close"
                    title={t("filetree.closeTitle")}
                    onClick={(e) => { e.stopPropagation(); closeTempFile(file); }}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </>
    );
  };

  return (
    <div className="filetree">
      {/* 头部工具栏 */}
      <div className="filetree-header">
        <span className="filetree-title">{t("filetree.title")}</span>
        <div className="filetree-actions">
          <button className="filetree-btn" title={t("filetree.newFileTitle")} onClick={() => handleNewFile(rootPath || "")}>
            <svg width="14" height="14" viewBox="0 0 16 16"><path d="M9.5 1.1l3.4 3.5.1.4v4h-1V6H8V2H3v12h5v1H2.5l-.5-.5v-13l.5-.5h6.7l.3.1zM9 2v3h2.9L9 2z" fill="#5c9dff"/><path d="M14 8v2h2v1h-2v2h-1v-2h-2v-1h2V8h1z" fill="#4caf50"/></svg>
          </button>
          {/* v0.4.1：新建文件夹图标重设计——蓝色文件夹 + 绿色加号（右下角叠加） */}
          <button className="filetree-btn" title={t("filetree.newFolderTitle")} onClick={() => handleNewFolder(rootPath || "")}>
            <svg width="14" height="14" viewBox="0 0 16 16">
              <path d="M1.5 2h4.3l1 1H14.5l.5.5v9l-.5.5h-13l-.5-.5v-10l.5-.5z" fill="#42a5f5"/>
              <path d="M2 3v8h12V4H6.7l-1-1H2z" fill="#90caf9"/>
              <path d="M10 9v2h2v1h-2v2H9v-2H7v-1h2V9z" fill="#4caf50"/>
            </svg>
          </button>
          {/* v0.4.1：打开文件夹图标重设计——橙色文件夹 + 放大镜（区别于新建文件夹） */}
          <button className="filetree-btn" title={t("filetree.openFolderTitle")} onClick={openFolder}>
            <svg width="14" height="14" viewBox="0 0 16 16">
              <path d="M1.5 2h4.3l1 1H14.5l.5.5v9l-.5.5h-13l-.5-.5v-10l.5-.5z" fill="#ff9800"/>
              <path d="M2 3v8h12V4H6.7l-1-1H2z" fill="#ffb74d"/>
              <circle cx="10" cy="9" r="2" fill="none" stroke="#e65100" strokeWidth="1.2"/>
              <path d="M11.5 10.5l1.8 1.8" stroke="#e65100" strokeWidth="1.2" fill="none" strokeLinecap="round"/>
            </svg>
          </button>
          {rootPath && (
            <button className="filetree-btn" title={t("filetree.refreshTitle")} onClick={() => refreshTree()}>
              <svg width="14" height="14" viewBox="0 0 16 16"><path d="M13.451 5.67l-.724-.69A5.5 5.5 0 008 2.5 5.5 5.5 0 002.5 8a5.5 5.5 0 009.227 4.077l-.69-.724A4.5 4.5 0 013.5 8 4.5 4.5 0 018 3.5a4.5 4.5 0 013.751 2h-2.25v1h4V2.5h-1v3.17z" fill="#66bb6a"/></svg>
            </button>
          )}
          {/* v0.4.3 Issue 2：全局文件搜索按钮 */}
          <button
            className={`filetree-btn ${showSearch ? "active" : ""}`}
            title={t("filetree.searchTitle")}
            onClick={() => setShowSearch((v) => !v)}
          >
            <svg width="14" height="14" viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5" fill="none" stroke={showSearch ? "#5c9dff" : "#888"} strokeWidth="1.5"/><path d="M10.5 10.5l3 3" stroke={showSearch ? "#5c9dff" : "#888"} strokeWidth="1.5" strokeLinecap="round"/></svg>
          </button>
          {/* v0.4.1：收藏/最近区域 toggle 按钮（点击切换显示，再点关闭） */}
          <button
            className={`filetree-btn ${showFavorites ? "active" : ""}`}
            title={t("filetree.favoritesToggle")}
            onClick={() => setShowFavorites((v) => !v)}
          >
            <svg width="14" height="14" viewBox="0 0 16 16"><path d="M8 1l2.2 4.5 5 .7-3.6 3.5.9 5L8 12.8 3.5 14.7l.9-5L.8 6.2l5-.7z" fill={showFavorites ? "#ffa726" : "#888"}/></svg>
          </button>
          <button
            className={`filetree-btn ${showRecent ? "active" : ""}`}
            title={t("filetree.recentToggle")}
            onClick={() => setShowRecent((v) => !v)}
          >
            <svg width="14" height="14" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke={showRecent ? "#5c9dff" : "#888"} strokeWidth="1.5"/><path d="M8 4v4l3 2" fill="none" stroke={showRecent ? "#5c9dff" : "#888"} strokeWidth="1.5" strokeLinecap="round"/></svg>
          </button>
        </div>
      </div>

      {/* v0.4.3 Issue 2：全局文件搜索面板 */}
      {showSearch && (
        <div className="filetree-search-panel">
          <div className="filetree-search-box">
            <input
              ref={searchInputRef}
              type="text"
              className="filetree-search-input"
              placeholder={t("filetree.searchPlaceholder")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setShowSearch(false); }}
            />
            {searchQuery && (
              <button className="filetree-search-clear" onClick={() => setSearchQuery("")}>✕</button>
            )}
          </div>
          {searchQuery && searchResults.length > 0 && (
            <div className="filetree-search-results">
              {searchResults.map((result) => (
                <div
                  key={result.path}
                  className={`filetree-search-result ${result.path === activePath ? "active" : ""}`}
                  onClick={() => handleSearchResultClick(result)}
                >
                  <span className="filetree-search-result-name">{result.name}</span>
                  <span className="filetree-search-result-path">{result.path}</span>
                </div>
              ))}
            </div>
          )}
          {searchQuery && searchResults.length === 0 && (
            <div className="filetree-search-empty">{t("filetree.searchNoResult")}</div>
          )}
        </div>
      )}

      {/* 状态消息 */}
      {statusMessage && (
        <div className="filetree-status">{statusMessage}</div>
      )}

      {/* v0.4.5 修复：左侧栏「打开的文件」和「文档」栏显示位置逻辑
          - 不打开文件夹但有 tempFiles：tempFiles 栏渲染在顶部（FolderSection 之前），不显示 placeholder
          - 打开文件夹：FolderSection（文档栏）在前，tempFiles 栏在后
          - 不打开文件夹且无 tempFiles：仅显示 placeholder 提示用户打开文件夹
          - 不打开文件夹也不打开文件：不显示文档栏和打开的文件栏（仅 placeholder） */}
      {openFolders.length === 0 && tempFiles.length > 0 && renderTempFilesSection()}

      {/* Issue 1 修复：每个文件夹独立浏览区域，含放大缩小按钮，支持上下拖拽调整高度 */}
      {openFolders.length > 0 ? (
        treeDataByFolder.map(({ folder, nodes }) => (
          <FolderSection
            key={folder.path}
            folder={folder}
            nodes={nodes}
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
            onClose={closeFolder}
          />
        ))
      ) : (
        /* v0.4.5 修复：不打文件夹且无 tempFiles 时才显示 placeholder（提示用户打开文件夹） */
        tempFiles.length === 0 ? (
          <div className="filetree-list">
            <div className="filetree-placeholder">
              <p>{t("filetree.clickToOpen")}</p>
              <p className="filetree-hint">{t("filetree.dragHint")}</p>
            </div>
          </div>
        ) : null
      )}

      {/* v0.4.5 修复：打开文件夹后，tempFiles 栏渲染在 FolderSection 之后 */}
      {openFolders.length > 0 && tempFiles.length > 0 && renderTempFilesSection()}

      {/* 临时文件右键菜单（fixed 定位，放在 filetree 容器中不影响布局） */}
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
          {/* G7：收藏切换项（已收藏显示"从收藏移除"，未收藏显示"添加到收藏"） */}
          {favorites.some((f) => f.path === tempContextMenu.file.path) ? (
            <button
              className="context-menu-item"
              onClick={() => {
                removeFavorite(tempContextMenu.file.path);
                setTempContextMenu(null);
              }}
            >
              {t("sidebar.removeFromFavorites")}
            </button>
          ) : (
            <button
              className="context-menu-item"
              onClick={() => {
                addFavorite({ path: tempContextMenu.file.path, name: tempContextMenu.file.name });
                setTempContextMenu(null);
              }}
            >
              {t("sidebar.addToFavorites")}
            </button>
          )}
          <button
            className="context-menu-item danger"
            onClick={() => {
              closeTempFile(tempContextMenu.file);
              setTempContextMenu(null);
            }}
          >
            {t("filetree.closeFile")}
          </button>
          <button
            className="context-menu-item"
            onClick={() => {
              setTempRenamingPath(tempContextMenu.file.path);
              setTempRenameValue(tempContextMenu.file.name);
              setTempContextMenu(null);
            }}
          >
            {t("filetree.rename")}
          </button>
          {/* v0.4.1：查看版本快照（修复临时文件缺少入口的问题5） */}
          <button
            className="context-menu-item"
            onClick={() => {
              window.dispatchEvent(new CustomEvent("lightmd:showSnapshotDialog", { detail: { filePath: tempContextMenu.file.path } }));
              setTempContextMenu(null);
            }}
          >
            {t("snapshot.viewSnapshots")}
          </button>
          {/* N5：在资源管理器中显示并选中该文件 */}
          <button
            className="context-menu-item"
            onClick={() => {
              fileService.revealInFolder(tempContextMenu.file.path).catch(() => {});
              setTempContextMenu(null);
            }}
          >
            {t("common.revealInFolder")}
          </button>
          <button
            className="context-menu-item"
            onClick={() => {
              handleViewProperties(tempContextMenu.file);
              setTempContextMenu(null);
            }}
          >
            {t("filetree.viewProperties")}
          </button>
        </div>
      )}

      {/* v0.4.1：收藏区段（toggle 按钮控制显示，分隔条拖拽调整高度） */}
      {showFavorites && (
        <>
          <div className="filetree-v-resizer" onMouseDown={favResize.onMouseDown} />
          <Favorites
            onOpen={handleSelectFile}
            height={favResize.height}
            onClose={() => setShowFavorites(false)}
          />
        </>
      )}

      {/* v0.4.1：最近文件（toggle 按钮控制显示，分隔条拖拽调整高度） */}
      {showRecent && (
        <>
          <div className="filetree-v-resizer" onMouseDown={recentResize.onMouseDown} />
          <RecentFiles
            onOpen={handleSelectFile}
            height={recentResize.height}
            onClose={() => setShowRecent(false)}
          />
        </>
      )}
    </div>
  );
}

// ─── Issue 1 修复：每个文件夹独立浏览区域子组件 ──────────
// useResizable 是 hook，不能在 map 中调用，故提取为子组件
interface FolderSectionProps {
  folder: { path: string; name: string };
  nodes: FileNodeData[];
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
  onRefresh: (folderPath: string) => void;
  onClose: (folderPath: string) => void;
}

function FolderSection(props: FolderSectionProps) {
  const { folder, nodes, activePath, renamingPath, expandedPaths, onSelect,
    onToggleExpand, onRenameStart, onRenameConfirm, onRenameCancel,
    onDelete, onNewFile, onNewFolder, onDragStart, onRefresh, onClose } = props;
  const t = useT();
  const [collapsed, setCollapsed] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const folderResize = useResizable({ direction: "vertical", initialHeight: 250, minHeight: 80, maxHeight: 500 });

  const sectionStyle: React.CSSProperties = {};
  if (maximized) {
    sectionStyle.height = 500;
  } else if (folderResize.height !== undefined && !collapsed) {
    sectionStyle.height = folderResize.height;
  }

  return (
    <div className={`filetree-folder-section ${collapsed ? "collapsed" : ""} ${maximized ? "maximized" : ""}`} style={sectionStyle}>
      <div className="filetree-root-path" title={folder.path} onMouseDown={folderResize.onMouseDown}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{verticalAlign:"middle",marginRight:"4px"}}><path d="M8 1.5l.354.353 6 6-.708.708L13 7.707V13.5l-.5.5h-9l-.5-.5V7.707l-.646.354-.708-.708 6-6L8 1.5zM4 7v6h3V9.5l.5-.5h1l.5.5V13h3V7L8 2.707 4 7z"/></svg>
        <span className="filetree-root-name">{folder.name}</span>
        {/* Issue 1：放大缩小按钮 + 刷新 + 关闭，统一放在 section-controls 中 */}
        <div className="section-controls">
          <button
            className="section-btn section-refresh"
            title={t("filetree.refreshTitle")}
            onClick={(e) => { e.stopPropagation(); onRefresh(folder.path); }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16"><path d="M13.451 5.67l-.724-.69A5.5 5.5 0 008 2.5 5.5 5.5 0 002.5 8a5.5 5.5 0 009.227 4.077l-.69-.724A4.5 4.5 0 013.5 8 4.5 4.5 0 018 3.5a4.5 4.5 0 013.751 2h-2.25v1h4V2.5h-1v3.17z" fill="currentColor"/></svg>
          </button>
          <button
            className="section-btn section-minimize"
            title={t("filetree.minimize")}
            onClick={(e) => { e.stopPropagation(); setCollapsed((c) => !c); setMaximized(false); }}
          >
            ▾
          </button>
          <button
            className="section-btn section-maximize"
            title={t("filetree.maximize")}
            onClick={(e) => { e.stopPropagation(); setMaximized((m) => !m); setCollapsed(false); }}
          >
            ▴
          </button>
          <button
            className="section-btn section-close"
            title={t("filetree.closeFolderTitle")}
            onClick={(e) => { e.stopPropagation(); onClose(folder.path); }}
          >
            ×
          </button>
        </div>
      </div>
      {!collapsed && (
        <div className="filetree-folder-content">
          {nodes.length > 0 ? (
            nodes.map((node) => (
              <FileEntryNode
                key={node.path}
                node={node}
                depth={0}
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
                onRefresh={() => onRefresh(folder.path)}
              />
            ))
          ) : (
            <div className="filetree-placeholder">{t("filetree.emptyFolder")}</div>
          )}
        </div>
      )}
    </div>
  );
}
