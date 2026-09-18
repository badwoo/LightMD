/**
 * FileTree ── 侧边栏文件树（带工具栏和最近文件）
 */
import { useState, useCallback, useMemo, useRef, useEffect, Fragment } from "react";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import { useFileStore } from "../../stores/useFileStore";
import { useEditorStore } from "../../stores/useEditorStore";
import { fileService, isTauri, type FileEntry } from "../../services/fileService";
import { FileEntryNode, type FileNodeData } from "./FileNode";
import { RecentFiles } from "./RecentFiles";
import { Favorites } from "./Favorites";
import { useT } from "../../i18n";
import { isSupportedTextFile } from "../../utils/constants";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useSectionSplit, SectionSizeContext, beginSectionDrag, computeMaxSelfHeight, computeExtendableMaxHeight, MIN_SECTION_HEIGHT } from "../../hooks/useSectionSplit";
import { SidebarScrollArrows } from "./SidebarScrollArrows";
// v0.8.0 WP2 需求6：打开所在文件夹工作区（纯逻辑，UI 注入 deps）
import { openContainingWorkspace } from "../../utils/workspace";
// v0.8.0 WP2 需求4(2)：新建文件夹弹框
import { NewFolderDialog } from "../dialogs/NewFolderDialog";
// v0.8.0 WP2 需求1：文件复制/粘贴（内存剪贴板 + 重名自动副本）
import { setClipboard, getClipboard, hasClipboard, clearClipboard, clipboardTransferMode, resolveTransferName, resolvePasteTargetDir } from "../../utils/fileClipboard";
// v0.8.0 修复 P3：自制鼠标拖拽（HTML5 DnD 被 Tauri 原生拖放拦截）
import { beginFileDrag, DROP_DIR_ATTR } from "../../utils/fileDragMouse";
import { syncOpenTabsAfterRename } from "../../services/renameService";
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
  // v0.8.0 修复 P12-4：布局列表需要知道"最近打开"栏是否会真正渲染（空列表时该栏返回 null）
  const recentFiles = useFileStore((s) => s.recentFiles);
  const renameFileEntry = useFileStore((s) => s.renameFileEntry);
  const t = useT();
  // 同步全局 filePath，确保关闭文件时能正确判断当前活跃文件
  const globalFilePath = useEditorStore((s) => s.filePath);
  // v0.8.0 WP1：临时（未落盘）标签需一并显示在"打开的文件"面板中
  const editorOpenTabs = useEditorStore((s) => s.openTabs);
  const editorActiveTabIdx = useEditorStore((s) => s.activeTabIdx);
  const untitledTabs = useMemo(
    () => editorOpenTabs
      .map((tab, idx) => ({ tab, idx }))
      .filter((item) => item.tab.isUntitled),
    [editorOpenTabs],
  );

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
  
  // v0.8.0 修复 P1-2：文件粘贴的目标文件夹。
  // 旧实现只用"当前活跃文件所在目录 / 第一个打开文件夹"，与用户点选的文件夹无关，
  // 导致"在某个打开的文件夹里 Ctrl+V 却不生效（文件跑到别处）"。
  // 现在点击任一文件夹区域（标题栏、空白处、文件项）即把该文件夹设为粘贴目标。
  const [pasteTargetDir, setPasteTargetDir] = useState<string | null>(null);

  // v0.8.0 修复 P12-1：文件夹空白区右键菜单（粘贴）
  // canPaste 在打开菜单的瞬间从内存剪贴板读取 —— 剪贴板是模块级变量，
  // 不进 React 状态，因此这里快照一次用于决定菜单项是否置灰。
  const [folderCtxMenu, setFolderCtxMenu] = useState<
    { x: number; y: number; dir: string; canPaste: boolean } | null
  >(null);

  // v0.8.0 修复 P11-8：侧栏文件操作的浮动提示（显示在侧栏右侧，不占布局、不抖动）
  const rootRef = useRef<HTMLDivElement>(null);
  const toastSeq = useRef(0);
  const [toasts, setToasts] = useState<{ id: number; msg: string; error: boolean }[]>([]);
  const [toastLeft, setToastLeft] = useState(272);

  // v0.8.0 WP2 需求4(2)：新建文件夹弹框状态（preselected = 从具体文件夹入口进入时的预选）
  const [showNewFolderDialog, setShowNewFolderDialog] = useState(false);
  const [newFolderPreselected, setNewFolderPreselected] = useState<string | null>(null);
  // 缓存已加载的子目录
  const [childrenMap, setChildrenMap] = useState<Map<string, FileNodeData[]>>(new Map());

  // v0.8.0 修复 P1-2：粘贴目标必须仍是"已打开的文件夹"，关闭该文件夹后自动失效
  useEffect(() => {
    if (pasteTargetDir && !openFolders.some((f) => f.path === pasteTargetDir)) {
      setPasteTargetDir(null);
    }
  }, [openFolders, pasteTargetDir]);

  // v0.4.1：收藏/最近区域显示开关（标题栏 toggle 按钮控制）
  // Issue 2 修复：收藏栏默认改为关闭状态
  const [showFavorites, setShowFavorites] = useState(false);
  const [showRecent, setShowRecent] = useState(true);

  // v0.4.3 Issue 2：全局文件搜索
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  // v0.8.0 WP4 修复1：相邻配对分配的分栏拖拽（替代旧 useResizable 垂直分支）
  // 各 section 高度集中管理；拖拽时本区+delta、下区-delta，总和守恒，双向钳制 80px。
  const settingsSectionSizes = useSettingsStore((s) => s.sidebarSectionSizes);
  const setSidebarSectionSizes = useSettingsStore((s) => s.setSidebarSectionSizes);
  const [sectionSizes, setSectionSizes] = useState<Record<string, number>>(
    () => ({ ...settingsSectionSizes }),
  );
  const scrollRef = useRef<HTMLDivElement>(null);

  const sizeOf = useCallback(
    (key: string) => sectionSizes[key] ?? (key.startsWith("folder:") ? 250 : 200),
    [sectionSizes],
  );
  const setPair = useCallback(
    (topKey: string, bottomKey: string, top: number, bottom: number) => {
      setSectionSizes((prev) => ({ ...prev, [topKey]: top, [bottomKey]: bottom }));
    },
    [],
  );
  // 拖拽过程中去抖持久化，避免每帧写 localStorage
  const persistTimer = useRef<number | null>(null);
  useEffect(() => {
    if (persistTimer.current) window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => {
      setSidebarSectionSizes(sectionSizes);
    }, 250);
    return () => {
      if (persistTimer.current) window.clearTimeout(persistTimer.current);
    };
  }, [sectionSizes, setSidebarSectionSizes]);

  // 可见 section 的顺序（决定相邻配对与分隔条位置）
  const tempVisible = tempFiles.length > 0 || untitledTabs.length > 0;
  const ordered: string[] = [];
  if (openFolders.length > 0) {
    openFolders.forEach((f) => ordered.push(`folder:${f.path}`));
  } else if (tempVisible) {
    ordered.push("temp");
  }
  if (openFolders.length > 0 && tempVisible) ordered.push("temp");
  if (showFavorites) ordered.push("favorites");
  // v0.8.0 修复 P12-4：最近文件为空时该栏不渲染（RecentFiles 返回 null），
  // 布局列表需与"实际渲染的栏"一致，否则分隔条/拖拽配对与自动填充会指向不存在的栏。
  if (showRecent && recentFiles.length > 0) ordered.push("recent");
  const indexOfKey = (k: string) => ordered.indexOf(k);
  const prevOf = (k: string) => {
    const i = indexOfKey(k);
    return i > 0 ? ordered[i - 1] : undefined;
  };
  // v0.8.0 修复 P11-4：分隔条高度（用于计算末区可扩展空间）
  const RESIZER_HEIGHT = 4;
  /**
   * v0.8.0 修复 P12-4/5：拖拽时"下方区域"的高度上限，仅**最后一个可见区域**给出。
   *
   * 上限取"守恒上限"与"容器上限"的较大值（见 computeExtendableMaxHeight）：
   * - 容器已溢出（多区域叠加超出可视区）时仍可通过压缩上区放大本区
   *   → 修复"收藏 + 最近打开同时打开时最近打开拖不动"、
   *     "只有一个文件夹 + 打开的文件时打开的文件栏拖不动"；
   * - 容器还有空白时可一直放大到填满底部。
   */
  const maxBottomFor = (topKey: string | undefined, bottomKey: string): number | undefined => {
    if (!topKey) return undefined;
    if (ordered.length === 0 || ordered[ordered.length - 1] !== bottomKey) return undefined;
    const el = scrollRef.current;
    if (!el) return undefined;
    const others = ordered
      .filter((k) => k !== topKey && k !== bottomKey)
      .map((k) => sizeOf(k));
    return computeExtendableMaxHeight(
      el.clientHeight,
      sizeOf(topKey),
      sizeOf(bottomKey),
      others,
      RESIZER_HEIGHT,
      Math.max(0, ordered.length - 1),
      MIN_SECTION_HEIGHT,
    );
  };
  const resizerDrag = (topKey: string, bottomKey: string) => (e: React.MouseEvent) => {
    const maxBottom = maxBottomFor(topKey, bottomKey);
    beginSectionDrag(
      topKey,
      bottomKey,
      () => ({ top: sizeOf(topKey), bottom: sizeOf(bottomKey) }),
      setPair,
      MIN_SECTION_HEIGHT,
      e,
      undefined,
      undefined,
      maxBottom !== undefined ? { maxBottom } : undefined,
    );
  };

  // v0.8.0 修复 P12-4 / P13-2：可见区域集合变化后的高度自适应。
  // ① 关闭末栏 → 上一栏自动撑满到底部；
  // ② 之后再打开一个栏 → 先把之前被撑满的栏**还原为原高度**，
  //    让新开的栏紧跟在上一栏内容之后出现（否则上一栏占满整屏，新栏被挤到可视区外，
  //    用户只能看到"栏没出现"或需要滚动）。
  // 仅响应"区域集合变化"（不含首次挂载，避免改变既有默认布局）。
  const orderedKey = ordered.join("|");
  const skipAutoFillRef = useRef(true);
  /** 记录上一次由自适应撑满的栏及其原高度，便于下次集合变化时还原 */
  const autoFillRef = useRef<{ key: string; prevHeight: number; filledHeight: number } | null>(
    null,
  );
  useEffect(() => {
    if (skipAutoFillRef.current) {
      skipAutoFillRef.current = false;
      return;
    }
    const el = scrollRef.current;
    if (!el || ordered.length === 0) return;
    const raf = requestAnimationFrame(() => {
      const container = el.clientHeight;
      if (container <= 0) return;
      const resizerCount = Math.max(0, ordered.length - 1);
      const lastKey = ordered[ordered.length - 1];
      setSectionSizes((prev) => {
        const next = { ...prev };
        const heightOf = (k: string) => next[k] ?? sizeOf(k);

        // ① 之前被撑满的栏不再是末栏 → 还原它的原高度
        const filled = autoFillRef.current;
        if (filled && filled.key !== lastKey) {
          // 用户已手动拖拽过则尊重用户设置（当前值 ≠ 撑满值时不还原）
          if (heightOf(filled.key) === filled.filledHeight) next[filled.key] = filled.prevHeight;
          autoFillRef.current = null;
        }

        // ② 末栏总高不足容器时撑满到底部（已溢出则保持现状，交给滚动条）
        const total =
          ordered.reduce((sum, k) => sum + heightOf(k), 0) + RESIZER_HEIGHT * resizerCount;
        if (total < container) {
          const others = ordered.filter((k) => k !== lastKey).map(heightOf);
          const target = computeMaxSelfHeight(
            container,
            others,
            RESIZER_HEIGHT,
            resizerCount,
            MIN_SECTION_HEIGHT,
          );
          const current = heightOf(lastKey);
          if (target > current) {
            autoFillRef.current = { key: lastKey, prevHeight: current, filledHeight: target };
            next[lastKey] = target;
          }
        }
        return next;
      });
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderedKey]);
  // v0.8.0 修复 P9-1：context 额外提供 sizeOf（含默认高度），
  // 保证标题栏拖拽以"渲染中的实际高度"为起点，不会从 0 起算而跳变
  const sectionSplitCtx = { sizes: sectionSizes, sizeOf, setPair, minHeight: MIN_SECTION_HEIGHT };

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
      showError(t("filetree.openFolderFailed"));
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
        showError(t("filetree.openFolderFailed"));
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

  // ─── v0.8.0 WP2 需求6：打开所在文件夹工作区 ──────────────────────────
  // 已在侧栏挂载 → 仅展开定位；未挂载 → 挂载该文件夹为工作区并定位
  const handleOpenWorkspace = useCallback(
    (filePath: string) => {
      if (!filePath) return;
      const store = useFileStore.getState();
      const expandAncestors = (target: string) => {
        setExpandedPaths((prev) => {
          const next = new Set(prev);
          let cur = target;
          // 逐级向上展开（加步数上限防路径异常时死循环）
          for (let i = 0; i < 64 && cur; i++) {
            next.add(cur);
            const parent = getParentDir(cur);
            if (!parent || parent === cur) break;
            cur = parent;
          }
          return next;
        });
      };
      const result = openContainingWorkspace(filePath, {
        openFolders: store.openFolders,
        isPathInOpenFolders: store.isPathInOpenFolders,
        expandTo: expandAncestors,
        openFolder: (p) =>
          window.dispatchEvent(new CustomEvent("lightmd:openFolder", { detail: { path: p } })),
        setActive: (p) => setActivePath(p),
      });
      const name = result.parentDir.split(/[\\/]/).pop() || result.parentDir;
      showMessage(t("filetree.workspaceOpened", { name }));
    },
    [t],
  );

  // v0.8.0 WP2 需求6：标签栏等外部入口通过命令总线复用同一套"打开所在文件夹工作区"逻辑
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.id === "workspace.open" && typeof detail.path === "string") {
        handleOpenWorkspace(detail.path);
      }
    };
    window.addEventListener("lightmd:command", handler);
    return () => window.removeEventListener("lightmd:command", handler);
  }, [handleOpenWorkspace]);

  // ─── 打开文件 ────────────────────────────────

  const handleSelectFile = useCallback(
    async (node: FileNodeData) => {
      if (node.isDir) return;
      if (!isSupportedTextFile(node.name)) {
        showError(t("filetree.unsupportedFileType"));
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
        showError(t("filetree.openFileFailed"));
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
        showError(t("filetree.renameFailed"));
        console.error(err);
      }
    },
    [refreshTree, renameFileEntry, t]
  );

  const handleRenameCancel = useCallback(() => {
    setRenamingPath(null);
  }, []);

  // ─── 新建文件/文件夹 ──────────────────────────

  // v0.8.0 修复 P4-1：调用点只剩"具体文件夹行内的 + 按钮"（工具栏已改为新建临时文件），
  // 因此这里恒有 parentPath，落盘语义（先命名 → 落盘 → 打开）保持不变。
  const handleNewFile = useCallback(
    async (parentPath: string) => {
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
        // v0.8.0 WP2 需求7：在具体文件夹下新建的文件直接打开（落盘语义，
        // 与工具栏"新建临时文件"区分：用户已在目标文件夹上操作，意图明确）
        window.dispatchEvent(
          new CustomEvent("lightmd:openFile", { detail: { path: filePath, content: "" } }),
        );
      } catch (err) {
        showError(t("filetree.createFileFailed"));
        console.error(err);
      }
    },
    [refreshTree, t]
  );

  // v0.8.0 WP2 需求4(2)：改为自定义弹框（支持多选目标文件夹 + 自定义路径），
  // 不再用原生 prompt()（原生无法选择落点，且无文件夹打开时直接失败）
  const handleNewFolder = useCallback(
    (_parentPath: string) => {
      setNewFolderPreselected(_parentPath || null);
      setShowNewFolderDialog(true);
    },
    []
  );

  // 弹框确认：对每个目标目录创建同名文件夹，部分失败给出明细
  const handleCreateFolder = useCallback(
    async (targets: string[], folderName: string) => {
      const failed: string[] = [];
      for (const dir of targets) {
        try {
          if (isTauri()) {
            await fileService.createDir(joinPath(dir, folderName));
          }
        } catch (err) {
          failed.push(`${dir}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      setShowNewFolderDialog(false);
      if (failed.length === 0) {
        showMessage(t("newFolder.created", { name: folderName }));
      } else {
        showError(t("newFolder.partialFailed", { detail: failed.join("; ") }));
      }
      // 展开目标目录并刷新文件树
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        targets.forEach((d) => next.add(d));
        return next;
      });
      await refreshTree();
    },
    [refreshTree, t],
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
        // v0.8.0 WP2 修复2：通知 App 关闭该文件（或该文件夹下所有文件）已打开的标签，
        // 否则被删除的文件仍停留在编辑器里形成"幽灵标签"
        window.dispatchEvent(
          new CustomEvent("lightmd:command", { detail: { id: "file.deleted", path: node.path } }),
        );
      } catch (err) {
        showError(t("filetree.deleteFailed"));
        console.error(err);
      }
    },
    [refreshTree, t]
  );

  // ── 拖拽（图片等） ──────────────────────────
  // 说明：v0.8.0 修复 P3 起，绘制拖拽统一走自制鼠标拖拽（见下方 handleFileDragStart），
  // 原 HTML5 onDragStart 在 Tauri 下不会触发，已移除。

  // ─── 状态消息 ────────────────────────────────

  // v0.8.0 修复 P11-8：侧栏所有文件操作的提示统一显示在"侧栏旁边"
  // （fixed 定位于侧栏右侧、不占布局 → 既不抖动，也不会跑到软件右下角）。
  function pushToast(msg: string, error = false) {
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect?.right) setToastLeft(rect.right + 12);
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev, { id, msg, error }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((x) => x.id !== id));
    }, 3000);
  }

  function showMessage(msg: string) {
    pushToast(msg, false);
  }

  /** 失败/警告类提示（错误色） */
  function showError(msg: string) {
    pushToast(msg, true);
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
      showError(t("filetree.renameFailed"));
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

  // v0.8.0 修复 P12-1：关闭文件夹空白区右键菜单
  useEffect(() => {
    if (!folderCtxMenu) return;
    const close = () => setFolderCtxMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, [folderCtxMenu]);

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

  // ─── v0.8.0 WP2 需求1：复制 / 移动（粘粘贴与拖拽共用）──────────────────
  // 重名时自动生成" - 副本"后缀，避免覆盖目标目录已有文件。
  const transferTo = useCallback(
    async (
      srcPath: string,
      targetDir: string,
      mode: "copy" | "move",
      opts?: { isClipboardPaste?: boolean },
    ) => {
      if (!srcPath || !targetDir) return;
      if (!isTauri()) return;
      // 不允许把文件放回它自己所在的目录（移动语义下是 no-op，复制语义下会生成副本）
      const name = srcPath.split(/[\\/]/).pop() || "";
      try {
        let existing = new Set<string>();
        try {
          const entries = await fileService.listDir(targetDir);
          existing = new Set(entries.map((en) => en.name));
        } catch {
          // 目标目录读取失败时不阻断，直接尝试原始名字
        }
        // v0.8.0 修复 P1-7：移动到自身所在目录 → resolveTransferName 返回 null（no-op）
        const unique = resolveTransferName(srcPath, targetDir, mode, existing);
        if (!unique) return;
        const dst = joinPath(targetDir, unique);
        if (mode === "move") {
          await fileService.renameFile(srcPath, dst);
          // v0.8.0 修复 P11-1：移动后打开的文件自动变成"新路径下的文件"——
          // 同步标签 path/name、全局 filePath（编辑器跟随）以及侧栏"打开的文件"条目
          syncOpenTabsAfterRename(srcPath, dst, unique);
          useFileStore.getState().renameFileEntry(srcPath, dst, unique);
          // 移动后内存剪贴板里的路径失效（把剪贴板更新为新路径）
          const clip = getClipboard();
          if (clip?.path === srcPath) setClipboard({ path: dst, name: unique, mode: clip.mode });
          // 移动语义使用专用提示（此前误用"已粘贴到"）
          showMessage(t("filetree.moved", { name: targetDir }));
        } else {
          await fileService.copyFile(srcPath, dst);
          showMessage(t("filetree.pasted", { name: targetDir }));
        }
        // v0.8.0 修复 P13-1：来自剪贴板的"剪切"粘贴成功后清空剪贴板
        // （与系统资源管理器的"剪切→粘贴后就清空"行为一致）
        if (opts?.isClipboardPaste && mode === "move") clearClipboard();
        await refreshTree();
      } catch (err) {
        showError(
          t("filetree.copyFailed", { error: err instanceof Error ? err.message : String(err) }),
        );
        console.error(err);
      }
    },
    [refreshTree, t],
  );

  // v0.8.0 修复 P3：拖拽源启动（自制鼠标拖拽）——默认复制，按住 Shift 移动
  const handleFileDragStart = useCallback(
    (node: FileNodeData, e: React.MouseEvent) => {
      beginFileDrag({ path: node.path, name: node.name }, e, {
        onDrop: (payload, targetDir, mode) => void transferTo(payload.path, targetDir, mode),
      });
    },
    [transferTo],
  );

  // v0.8.0 修复 P3：接收标签栏拖拽的落点（跨组件用事件解耦，避免把 transferTo 提升到 App）
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (!d?.srcPath || !d?.targetDir) return;
      void transferTo(d.srcPath, d.targetDir, d.mode === "move" ? "move" : "copy");
    };
    window.addEventListener("lightmd:fileDrop", handler);
    return () => window.removeEventListener("lightmd:fileDrop", handler);
  }, [transferTo]);

  // Ctrl+C 复制选中项；Ctrl+V 粘贴到点选的文件夹
  // （目标解析见 utils/fileClipboard.resolvePasteTargetDir，优先级：点选 > 当前文件所在目录 > 首个文件夹）
  const currentPasteTarget = useCallback(
    (): string =>
      resolvePasteTargetDir(pasteTargetDir, activePath, openFolders.map((f) => f.path)),
    [pasteTargetDir, activePath, openFolders],
  );

  // v0.8.0 修复 P1-6：文件复制/粘贴快捷键的作用域门控（仅悬停侧栏时生效）
  const sidebarHoverRef = useRef(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // 焦点在编辑器/输入框时不拦截（与 Delete 快捷键同一守卫）
      if (isFocusInEditable(document.activeElement)) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      // v0.8.0 修复 P1-5：Ctrl+Alt+V 是版本快照快捷键，不能触发文件粘贴
      if (e.altKey) return;
      // v0.8.0 修复 P1-6：仅鼠标悬停在侧栏内时才接管文件级 Ctrl+C/V，
      // 避免全局劫持文本复制、避免在不知情时向文件夹复制文件
      if (!sidebarHoverRef.current) return;
      const key = e.key.toLowerCase();

      if (key === "c") {
        const selected = selectedTempIdx >= 0 ? tempFiles[selectedTempIdx] : undefined;
        const src = selected?.path || activePath || "";
        if (!src) return;
        e.preventDefault();
        const name = src.split(/[\\/]/).pop() || src;
        setClipboard({ path: src, name });
        showMessage(t("filetree.copied", { name }));
        return;
      }

      if (key === "v") {
        const clip = getClipboard();
        if (!clip) return;
        const targetDir = currentPasteTarget();
        if (!targetDir) return;
        e.preventDefault();
        // v0.8.0 修复 P13-1：剪贴板为"剪切"时粘贴 = 移动
        void transferTo(clip.path, targetDir, clipboardTransferMode(clip), {
          isClipboardPaste: true,
        });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedTempIdx, tempFiles, activePath, currentPasteTarget, transferTo, t]);

  // v0.8.0 WP2 任务2.5：标签栏重命名文件后刷新侧栏文件树（否则树中仍是旧名）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.newPath) return;
      void refreshTree();
    };
    window.addEventListener("lightmd:fileRenamed", handler);
    return () => window.removeEventListener("lightmd:fileRenamed", handler);
  }, [refreshTree]);

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
    // v0.8.0 WP1：面板同时承载"临时标签（未落盘）"与"未挂载到打开文件夹的真实文件"
    if (tempFiles.length === 0 && untitledTabs.length === 0) return null;
    // v0.8.0 修复 P9-1：temp 区标题栏拖动改变「上方邻区 + temp」的高度分配
    const tempPrevKey = prevOf("temp");
    return (
      <>
        <div
          className="filetree-temp-section"
          style={{ height: sizeOf("temp") }}
        >
          {/* 标题栏绑定相邻配对拖拽：上方邻区 +delta、本区 -delta（自然方向，标题栏随之上/下移动） */}
          <div
            className="filetree-temp-header"
            onMouseDown={(e) => {
              if (!tempPrevKey) return;
              // v0.8.0 修复 P11-4 / P12-4/5：temp 是最后一个可见区域时可一直拖到底部
              const maxBottom = maxBottomFor(tempPrevKey, "temp");
              beginSectionDrag(
                tempPrevKey,
                "temp",
                () => ({ top: sizeOf(tempPrevKey), bottom: sizeOf("temp") }),
                setPair,
                MIN_SECTION_HEIGHT,
                e,
                undefined,
                undefined,
                maxBottom !== undefined ? { maxBottom } : undefined,
              );
            }}
          >
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
            {/* v0.8.0 WP1：临时（未落盘）标签 —— 无磁盘路径，点击切换、× 关闭 */}
            {untitledTabs.map(({ tab, idx }) => {
              const isActive = idx === editorActiveTabIdx && !globalFilePath;
              return (
                <div
                  key={tab.id ?? `untitled-${idx}`}
                  className={`filetree-node filetree-temp-node filetree-untitled-node ${isActive ? "active" : ""}`}
                  style={{ paddingLeft: "8px" }}
                  onClick={() => {
                    window.dispatchEvent(
                      new CustomEvent("lightmd:command", { detail: { id: "tab.activate", index: idx } }),
                    );
                  }}
                  title={t("filetree.untitledHint")}
                >
                  <span className="filetree-icon">
                    <svg width="14" height="14" viewBox="0 0 16 16"><path d="M9.5 1.1l3.4 3.5.1.4v10l-.5.5h-9l-.5-.5v-13l.5-.5h6.7l.3.1zM9 2v3h2.9L9 2z" fill="#e0a458"/></svg>
                  </span>
                  <span className="filetree-name">{tab.name}</span>
                  {tab.isDirty ? <span className="filetree-untitled-dirty">●</span> : null}
                  <button
                    className="filetree-temp-close"
                    title={t("filetree.closeTitle")}
                    onClick={(e) => {
                      e.stopPropagation();
                      window.dispatchEvent(
                        new CustomEvent("lightmd:command", { detail: { id: "tab.close", index: idx } }),
                      );
                    }}
                  >
                    ×
                  </button>
                </div>
              );
            })}
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
                  // v0.8.0 修复 P3：自制鼠标拖拽（默认复制 / 按住 Shift 移动）
                  onMouseDown={(e) => {
                    beginFileDrag({ path: file.path, name: file.name }, e, {
                      onDrop: (payload, targetDir, mode) =>
                        void transferTo(payload.path, targetDir, mode),
                    });
                  }}
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
    <div
      ref={rootRef}
      className="filetree"
      // v0.8.0 修复 P1-6：Ctrl+C/V 文件复制粘贴仅在鼠标悬停侧栏时接管，
      // 不再全局劫持（配合下方 keydown 里的 sidebarHoverRef 门控）
      onMouseEnter={() => { sidebarHoverRef.current = true; }}
      onMouseLeave={() => { sidebarHoverRef.current = false; }}
    >
      {/* 头部工具栏 */}
      <div className="filetree-header">
        <span className="filetree-title">{t("filetree.title")}</span>
        <div className="filetree-actions">
          {/* v0.8.0 修复 P4-1：工具栏"新增文件"改为立即新建临时（未落盘）文件，
              不再固定落到第一个打开的文件夹；保存时才由用户选择路径与命名。
              复用 App 的 file.new 命令（与 Ctrl+N 同一路径，保证编辑器上下文同步） */}
          <button
            className="filetree-btn"
            title={t("filetree.newFileTitle")}
            onClick={() => {
              window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "file.new" } }));
            }}
          >
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

      

      {/* v0.8.0 WP2 需求4(2)：新建文件夹弹框（多选目标文件夹 / 自定义路径） */}
      <NewFolderDialog
        open={showNewFolderDialog}
        openFolders={openFolders.map((f) => ({ path: f.path, name: f.name }))}
        preselected={newFolderPreselected}
        onBrowse={async () => {
          try {
            const picked = await dialogOpen({ directory: true, multiple: false });
            return typeof picked === "string" ? picked : null;
          } catch {
            return null;
          }
        }}
        onClose={() => setShowNewFolderDialog(false)}
        onConfirm={handleCreateFolder}
      />

      <SectionSizeContext.Provider value={sectionSplitCtx}>
        <div className="filetree-scroll" ref={scrollRef}>
          {/* v0.4.5 修复：左侧栏「打开的文件」和「文档」栏显示位置逻辑（见 WP4 施工图） */}
          {openFolders.length === 0 && tempVisible && (
            <>
              {prevOf("temp") && (
                <div className="filetree-v-resizer" onMouseDown={resizerDrag(prevOf("temp")!, "temp")} />
              )}
              {renderTempFilesSection()}
            </>
          )}

          {/* Issue 1 修复：每个文件夹独立浏览区域，含放大缩小按钮，支持上下拖拽调整高度 */}
          {openFolders.length > 0 ? (
            treeDataByFolder.map(({ folder, nodes }) => {
              const fkey = `folder:${folder.path}`;
              return (
                <Fragment key={folder.path}>
                  {prevOf(fkey) && (
                    <div className="filetree-v-resizer" onMouseDown={resizerDrag(prevOf(fkey)!, fkey)} />
                  )}
                  <FolderSection
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
                    onFileDragStart={handleFileDragStart}
                    onRefresh={refreshTree}
                    onClose={closeFolder}
                    onOpenWorkspace={handleOpenWorkspace}
                    onActivateFolder={setPasteTargetDir}
                    onFolderContextMenu={(dir, x, y) => {
                      setPasteTargetDir(dir);
                      setFolderCtxMenu({ x, y, dir, canPaste: hasClipboard() });
                    }}
                    height={sizeOf(fkey)}
                    sectionKey={fkey}
                    prevSectionKey={prevOf(fkey)}
                    maxHeight={maxBottomFor(prevOf(fkey), fkey)}
                  />
                </Fragment>
              );
            })
          ) : (
            /* v0.4.5 修复：不打文件夹且无 temp/未落盘标签时才显示 placeholder（提示用户打开文件夹） */
            tempFiles.length === 0 && untitledTabs.length === 0 ? (
              <div className="filetree-list">
                <div className="filetree-placeholder">
                  <p>{t("filetree.clickToOpen")}</p>
                  <p className="filetree-hint">{t("filetree.dragHint")}</p>
                </div>
              </div>
            ) : null
          )}

          {/* v0.4.5 修复：打开文件夹后，tempFiles 栏渲染在 FolderSection 之后 */}
          {openFolders.length > 0 && tempVisible && (
            <>
              {prevOf("temp") && (
                <div className="filetree-v-resizer" onMouseDown={resizerDrag(prevOf("temp")!, "temp")} />
              )}
              {renderTempFilesSection()}
            </>
          )}

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
          {/* v0.8.0 WP2 需求1：复制（配合 Ctrl+V 粘贴到任一打开的文件夹） */}
          <button
            className="context-menu-item"
            onClick={() => {
              setClipboard({ path: tempContextMenu.file.path, name: tempContextMenu.file.name });
              showMessage(t("filetree.copied", { name: tempContextMenu.file.name }));
              setTempContextMenu(null);
            }}
          >
            {t("filetree.copy")}
          </button>
          {/* v0.8.0 修复 P13-1：剪切（粘贴时移动原文件，成功后清空剪贴板） */}
          <button
            className="context-menu-item"
            onClick={() => {
              setClipboard({
                path: tempContextMenu.file.path,
                name: tempContextMenu.file.name,
                mode: "cut",
              });
              showMessage(t("filetree.cutted", { name: tempContextMenu.file.name }));
              setTempContextMenu(null);
            }}
          >
            {t("filetree.cut")}
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
          {/* v0.8.0 WP2 需求6：在左侧栏打开该文件所在的文件夹工作区 */}
          <button
            className="context-menu-item"
            onClick={() => {
              handleOpenWorkspace(tempContextMenu.file.path);
              setTempContextMenu(null);
            }}
          >
            {t("filetree.openWorkspace")}
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
          {prevOf("favorites") && (
            <div className="filetree-v-resizer" onMouseDown={resizerDrag(prevOf("favorites")!, "favorites")} />
          )}
          <Favorites
            onOpen={handleSelectFile}
            height={sizeOf("favorites")}
            sectionKey="favorites"
            prevSectionKey={prevOf("favorites")}
            maxHeight={maxBottomFor(prevOf("favorites"), "favorites")}
            onClose={() => setShowFavorites(false)}
          />
        </>
      )}

      {/* v0.4.1：最近文件（toggle 按钮控制显示，分隔条拖拽调整高度） */}
      {showRecent && (
        <>
          {prevOf("recent") && (
            <div className="filetree-v-resizer" onMouseDown={resizerDrag(prevOf("recent")!, "recent")} />
          )}
          <RecentFiles
            onOpen={handleSelectFile}
            height={sizeOf("recent")}
            sectionKey="recent"
            prevSectionKey={prevOf("recent")}
            maxHeight={maxBottomFor(prevOf("recent"), "recent")}
            onClose={() => setShowRecent(false)}
          />
        </>
      )}
        </div>
        <SidebarScrollArrows scrollRef={scrollRef} />
      </SectionSizeContext.Provider>

      {/* v0.8.0 修复 P12-1：文件夹空白区右键菜单（粘贴；剪贴板为空时置灰） */}
      {folderCtxMenu && (
        <div
          className="filetree-context-menu"
          style={{ left: folderCtxMenu.x, top: folderCtxMenu.y, position: "fixed" }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="context-menu-item"
            disabled={!folderCtxMenu.canPaste}
            title={folderCtxMenu.canPaste ? t("filetree.paste") : t("filetree.pasteEmpty")}
            onClick={() => {
              const clip = getClipboard();
              // v0.8.0 修复 P13-1：剪贴板为"剪切"时粘贴 = 移动（cut → move），成功后清空剪贴板
              if (clip) {
                void transferTo(clip.path, folderCtxMenu.dir, clipboardTransferMode(clip), {
                  isClipboardPaste: true,
                });
              }
              setFolderCtxMenu(null);
            }}
          >
            {t("filetree.paste")}
          </button>
        </div>
      )}

      {/* v0.8.0 修复 P11-8：侧栏文件操作的浮动提示（贴侧栏右侧显示，fixed 不占布局） */}
      {toasts.length > 0 && (
        <div className="filetree-toast-stack" style={{ left: toastLeft }}>
          {toasts.map((item) => (
            <div
              key={item.id}
              className={`filetree-toast ${item.error ? "error" : ""}`}
            >
              {item.msg}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Issue 1 修复：每个文件夹独立浏览区域子组件 ──────────
// useSectionSplit 是 hook，不能在 map 中调用，故提取为子组件
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
  /** v0.8.0 修复 P3：文件节点按下鼠标 → 启动自制拖拽 */
  onFileDragStart?: (node: FileNodeData, e: React.MouseEvent) => void;
  onRefresh: (folderPath: string) => void;
  onClose: (folderPath: string) => void;
  /** 当前高度（px），由父组件按 sectionSizes 注入 */
  height?: number;
  /** 本区 key（用于相邻配对拖拽） */
  sectionKey?: string;
  /** 上方相邻可见区 key（为空说明本区是最上面一个区域 → 标题栏不可拖拽） */
  prevSectionKey?: string;
  /** v0.8.0 修复 P11-4：本区高度上限（仅最后一个可见区域给出 → 可拖到底部） */
  maxHeight?: number;
  /** v0.8.0 WP2 需求6：在左侧栏打开文件所在文件夹工作区 */
  onOpenWorkspace?: (filePath: string) => void;
  /** v0.8.0 修复 P1-2：点击本区域（含空白处）即把本文件夹设为粘贴目标 */
  onActivateFolder?: (dir: string) => void;
  /** v0.8.0 修复 P12-1：在文件夹空白区右键 → 打开"粘贴"菜单 */
  onFolderContextMenu?: (dir: string, x: number, y: number) => void;
}

function FolderSection(props: FolderSectionProps) {
  const { folder, nodes, activePath, renamingPath, expandedPaths, onSelect,
    onToggleExpand, onRenameStart, onRenameConfirm, onRenameCancel,
    onDelete, onNewFile, onNewFolder, onFileDragStart, onRefresh, onClose,
    height, sectionKey, prevSectionKey, maxHeight, onOpenWorkspace, onActivateFolder,
    onFolderContextMenu } = props;
  const t = useT();
  const [collapsed, setCollapsed] = useState(false);
  const [maximized, setMaximized] = useState(false);
  // v0.8.0 修复 P9-1：标题栏在本区顶部，拖动它移动的是本区上边界，
  // 因此配对为「上方邻区 + 本区」；第一个区域无上方邻区 → 不可拖
  const { onMouseDown } = useSectionSplit({
    selfKey: sectionKey ?? `folder:${folder.path}`,
    prevKey: prevSectionKey,
    maxHeight,
  });

  const sectionStyle: React.CSSProperties = {};
  if (maximized) {
    sectionStyle.height = 500;
  } else if (height !== undefined && !collapsed) {
    sectionStyle.height = height;
  }

  return (
    <div
      className={`filetree-folder-section ${collapsed ? "collapsed" : ""} ${maximized ? "maximized" : ""}`}
      style={sectionStyle}
      // v0.8.0 修复 P1-2：capture 阶段记录"当前点选的文件夹"作为 Ctrl+V 粘贴目标
      // （capture 先于标题栏拖拽的 stopPropagation，点标题栏/空白处/文件项都能生效）
      onMouseDownCapture={() => onActivateFolder?.(folder.path)}
      // v0.8.0 修复 P3：本区整体作为自制拖拽的落点（拖到标题栏/空白处也算）
      {...{ [DROP_DIR_ATTR]: folder.path }}
    >
      <div className="filetree-root-path" title={folder.path} onMouseDown={onMouseDown}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{verticalAlign:"middle",marginRight:"4px"}}><path d="M8 1.5l.354.353 6 6-.708.708L13 7.707V13.5l-.5.5h-9l-.5-.5V7.707l-.646.354-.708-.708 6-6L8 1.5zM4 7v6h3V9.5l.5-.5h1l.5.5V13h3V7L8 2.707 4 7z"/></svg>
        <span className="filetree-root-name">{folder.name}</span>
        {/* Issue 1：放大缩小按钮 + 刷新 + 关闭，统一放在 section-controls 中 */}
        {/* v0.8.0 WP2 需求7：增加"新建文件/新建文件夹"入口（针对本文件夹，直接落盘） */}
        <div className="section-controls">
          <button
            className="section-btn section-new-file"
            title={t("filetree.newFileTitle")}
            onClick={(e) => { e.stopPropagation(); onNewFile(folder.path); }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16"><path d="M7.5 2h1v5.5H14v1H8.5V14h-1V8.5H2v-1h5.5V2z" fill="currentColor"/></svg>
          </button>
          <button
            className="section-btn section-new-folder"
            title={t("filetree.newFolderTitle")}
            onClick={(e) => { e.stopPropagation(); onNewFolder(folder.path); }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16"><path d="M1.5 3h4.6l1.4 1.6h6.9l.6.5v8l-.5.5h-13l-.5-.5v-9.6l.5-.5zm.5 1v8.6h12V5.6H7.1L5.7 4H2z" fill="currentColor"/><path d="M7.5 7h1v1.5H10v1H8.5V11h-1V9.5H6v-1h1.5V7z" fill="currentColor"/></svg>
          </button>
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
        <div
          className="filetree-folder-content"
          // 拖拽落点由根节点的 data-drop-dir 统一承载（v0.8.0 修复 P3 自制拖拽）
          // v0.8.0 修复 P12-1：空白区右键 → "粘贴"菜单（文件项自身的右键会 stopPropagation）
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onFolderContextMenu?.(folder.path, e.clientX, e.clientY);
          }}
        >
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
                onFileDragStart={onFileDragStart}
                onRefresh={() => onRefresh(folder.path)}
                onOpenWorkspace={onOpenWorkspace}
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
