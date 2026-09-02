import { useState, useEffect, useCallback, useRef } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useSettingsStore, THEMES, type Theme } from "./stores/useSettingsStore";
import { useEditorStore, type TabInfo } from "./stores/useEditorStore";
import { useFileStore } from "./stores/useFileStore";
import { AppShell } from "./components/layout/AppShell";
import { TitleBar } from "./components/layout/TitleBar";
import { StatusBar } from "./components/layout/StatusBar";
import { TabBar } from "./components/layout/TabBar";
import { EditorContainer } from "./components/editor/EditorContainer";
import { FileTree } from "./components/sidebar/FileTree";
import { Outline } from "./components/editor/Outline";
import { SyntaxHelper } from "./components/editor/SyntaxHelper";
import { SettingsDialog } from "./components/dialogs/SettingsDialog";
import { ExportDialog } from "./components/dialogs/ExportDialog";
import { ImagePasteDialog } from "./components/dialogs/ImagePasteDialog";
import { CommandPalette } from "./components/dialogs/CommandPalette";
import { VersionSnapshotDialog } from "./components/dialogs/VersionSnapshotDialog";
import { setImageHandler, insertImageAtCursor } from "./core/plugins/image-paste";
import { fileService, isTauri, type FileEntry } from "./services/fileService";
import { versionSnapshotService } from "./services/versionSnapshotService";
import { safeSetItem } from "./utils/safeStorage";
import { setCurrentDocPath } from "./utils/imagePath";
import { isSupportedTextFile, isMarkdownFile, ALL_SUPPORTED_EXTENSIONS, HUGE_FILE_THRESHOLD, getFileLanguage } from "./utils/constants";
import { evalDoublePress } from "./utils/modeSwitch";
import {
  setNotificationHandler,
  type Notification,
} from "./services/notificationService";
import { useT } from "./i18n";
import type { EditorView } from "prosemirror-view";
import "./App.css";

const DEMO_MARKDOWN = `# 欢迎使用 LightMD

LightMD 是一款**轻量级**的 Markdown 编辑器，支持实时阅读模式。

## 特性

- 即时渲染 —— 输入 Markdown 语法，即刻看到渲染效果
- 主题切换 —— 支持亮色/暗色主题
- 代码高亮 —— 支持多种编程语言语法高亮

## 代码示例

\`\`\`javascript
function greet(name) {
  return \`Hello, \${name}!\`;
}

console.log(greet("LightMD"));
\`\`\`

## 表格

| 功能 | 状态 | 说明 |
|------|------|------|
| 实时阅读 | 已完成 | 光标所在行显示源码 |
| 文件管理 | 已完成 | 侧边栏文件树 |
| 主题切换 | 已完成 | Light/Dark |

> LightMD 致力于成为 Windows 平台上最好用的 Markdown 编辑器。

---

*祝你使用愉快！*
`;

/** 从路径中提取文件名（兼容 Windows 和 Unix 路径） */
function getFileName(path: string): string {
  return path.split(/[\\/]/).pop() || "Untitled.md";
}

/**
 * G8：格式/插入命令的 markdown 语法映射
 * 用于源码模式（edit/split）下通过 sourceInsertHandler 插入语法
 * cursorOffset 表示插入后光标位置（相对于插入起点的偏移）
 */
const COMMAND_SYNTAX: Record<string, { syntax: string; cursorOffset?: number }> = {
  "format.bold": { syntax: "****", cursorOffset: 2 },
  "format.italic": { syntax: "**", cursorOffset: 1 },
  "format.strikethrough": { syntax: "~~~~", cursorOffset: 2 },
  "format.inlineCode": { syntax: "``", cursorOffset: 1 },
  "format.highlight": { syntax: "====", cursorOffset: 2 },
  "format.heading1": { syntax: "# " },
  "format.heading2": { syntax: "## " },
  "format.heading3": { syntax: "### " },
  "insert.table": { syntax: "\n| 列1 | 列2 |\n|------|------|\n| 内容 | 内容 |\n" },
  "insert.link": { syntax: "[](url)", cursorOffset: 1 },
  "insert.image": { syntax: "![](url)", cursorOffset: 2 },
  "insert.codeblock": { syntax: "\n```\n\n```\n", cursorOffset: 5 },
  "insert.mermaid": { syntax: "\n```mermaid\n\n```\n", cursorOffset: 11 },
  "insert.taskList": { syntax: "\n- [ ] " },
  "insert.footnote": { syntax: "[^1]: " },
};

// ─── NotificationToast 组件 ──────────────────────────

function NotificationToast({ notifications }: { notifications: Notification[] }) {
  if (notifications.length === 0) return null;
  return (
    <div className="notification-toast-container">
      {notifications.map((n) => (
        <div key={n.id} className={`notification-toast notification-${n.type}`}>
          <span className="notification-icon">
            {n.type === "error" ? "❌" : n.type === "warning" ? "⚠️" : n.type === "success" ? "✅" : "ℹ️"}
          </span>
          <span className="notification-message">{n.message}</span>
        </div>
      ))}
    </div>
  );
}

function App() {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const t = useT();
  const filePath = useEditorStore((s) => s.filePath);
  const isDirty = useEditorStore((s) => s.isDirty);
  const focusMode = useEditorStore((s) => s.focusMode);
  const toggleFocusMode = useEditorStore((s) => s.toggleFocusMode);
  const toggleTypewriter = useSettingsStore((s) => s.toggleTypewriter);
  const openFile = useEditorStore((s) => s.openFile);
  const setDirty = useEditorStore((s) => s.setDirty);
  const viewMode = useEditorStore((s) => s.viewMode);
  const prevViewMode = useEditorStore((s) => s.prevViewMode);
  const setViewMode = useEditorStore((s) => s.setViewMode);
  const sourceInsertHandler = useEditorStore((s) => s.sourceInsertHandler);
  const undoHandler = useEditorStore((s) => s.undoHandler);
  const redoHandler = useEditorStore((s) => s.redoHandler);
  const setShowSearch = useEditorStore((s) => s.setShowSearch);
  const setShowSearchReplace = useEditorStore((s) => s.setShowSearchReplace);
  const addTab = useEditorStore((s) => s.addTab);
  const closeTab = useEditorStore((s) => s.closeTab);
  const updateTabContent = useEditorStore((s) => s.updateTabContent);
  const updateTabDirty = useEditorStore((s) => s.updateTabDirty);
  const openTabs = useEditorStore((s) => s.openTabs);
  const activeTabIdx = useEditorStore((s) => s.activeTabIdx);
  const setActiveTab = useEditorStore((s) => s.setActiveTab);
  // v0.4.0：设置当前文件语言标识，供 EditorContainer 渲染代码高亮
  const setCurrentLanguage = useEditorStore((s) => s.setCurrentLanguage);
  const addRecentFile = useFileStore((s) => s.addRecentFile);
  const addTempFile = useFileStore((s) => s.addTempFile);
  const rootPath = useFileStore((s) => s.rootPath);

  const [content, setContent] = useState(() => {
    if (typeof window !== "undefined") {
      // 直接从 localStorage 读取设置，避免 Zustand persist hydration 时机问题
      // 若关闭"启动载入上次打开"，则不载入任何内容（空白）
      try {
        const settingsRaw = localStorage.getItem("lightmd-settings");
        if (settingsRaw) {
          const parsed = JSON.parse(settingsRaw);
          if (parsed?.state?.loadLastFileOnStartup === false) {
            return "";
          }
        }
      } catch {
        // 读取失败，使用默认行为（载入上次内容）
      }
      return localStorage.getItem("lightmd-content") || "";
    }
    return "";
  });
  // 强制更新 key：每次打开文件时递增，确保编辑器内容被更新
  const [forceUpdateKey, setForceUpdateKey] = useState(0);
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  // 双击 Ctrl 检测用 ref，避免 useEffect 重新执行时重置
  const lastCtrlTimeRef = useRef(0);
  // 双击 Shift 检测用 ref
  const lastShiftTimeRef = useRef(0);
  const DOUBLE_CLICK_THRESHOLD = 300;
  const handleEditorReady = useCallback((v: EditorView) => {
    editorViewRef.current = v;
    setEditorView(v);
  }, []);
  const [showSettings, setShowSettings] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showOutline, setShowOutline] = useState(true);
  // G8：命令面板开关
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  // v0.4.0 功能4：版本快照窗口开关 + 目标文件路径
  const [showSnapshotDialog, setShowSnapshotDialog] = useState(false);
  const [snapshotFilePath, setSnapshotFilePath] = useState<string | null>(null);
  const [imageFiles, setImageFiles] = useState<File[] | null>(null);
  const [notifications, setNotifications] = useState<Notification[]>([]);

  // 是否为源码编辑类模式（edit 或 split）
  const isSourceMode = viewMode === "edit" || viewMode === "split";

  // ─── 通知处理器 ──────────────────────────
  useEffect(() => {
    setNotificationHandler((n) => {
      setNotifications((prev) => [...prev, n]);
      setTimeout(() => {
        setNotifications((prev) => prev.filter((x) => x.id !== n.id));
      }, 3500);
    });
    return () => setNotificationHandler(null);
  }, []);

  // ─── G6 主题应用到 documentElement ──────────────────────────
  // 同步 data-theme 到 <html> 元素，使 :root[data-theme="x"] 选择器生效
  // 同时让 body/html 继承主题 CSS 变量（如 newsprint 的衬线字体）
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // ─── 文件打开事件 ──────────────────────────
  useEffect(() => {
    const handler = async (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.content !== undefined) {
        // 问题8修复：先同步设置文档路径，确保 ProseMirror 渲染图片时能正确解析相对路径
        // React useEffect 执行顺序是子组件先于父组件，若依赖 useEffect 设置 currentDocPath，
        // EditorContainer 的 useEffect（更新 ProseMirror）会先执行，导致图片用旧路径渲染失败
        if (detail.path) {
          setCurrentDocPath(detail.path);
        }
        // 只通过 React 状态更新编辑器内容，避免双重 dispatch
        // EditorContainer 的 useEffect([content, forceUpdateKey]) 会统一处理 ProseMirror 更新
        setContent(detail.content);
        safeSetItem("lightmd-content", detail.content);
        setForceUpdateKey((k) => k + 1);

        // 设置文件路径和清除 dirty 标记
        if (detail.path) {
          openFile(detail.path);
          // v0.4.0：根据文件扩展名设置语言标识，供 EditorContainer 渲染代码高亮
          // md 文件为 "markdown"，其他代码文件为对应语言（如 "javascript"/"python"）
          const lang = isMarkdownFile(detail.name || detail.path)
            ? "markdown"
            : getFileLanguage(detail.name || detail.path);
          setCurrentLanguage(lang);
          // 记录上次打开的文件路径，供启动时恢复使用
          safeSetItem("lightmd-last-file", detail.path);
          // 文件名优先使用 detail.name（来自 FileTree 的 node.name），避免路径解析得到目录名
          const fileName = detail.name || getFileName(detail.path);
          // 添加到标签页（若已存在则切换到该标签，但不更新 content）
          addTab({ path: detail.path, name: fileName, content: detail.content, isDirty: false });
          // 显式更新标签页 content，确保已存在标签页也能加载最新内容
          const { activeTabIdx: newIdx } = useEditorStore.getState();
          updateTabContent(newIdx, detail.content);
          addRecentFile({
            path: detail.path,
            name: fileName,
          });
          // v0.4.0：如果文件不在任一已打开文件夹下，添加为临时文件
          if (!useFileStore.getState().isPathInOpenFolders(detail.path)) {
            addTempFile({
              name: fileName,
              path: detail.path,
              isDir: false,
              size: 0,
            });
          }

          // ─── 大文件性能优化 ───
          // 超过 5MB 的文件强制切换到编辑模式，禁用阅读模式渲染
          // 避免 ProseMirror 创建巨大 DOM 导致页面卡顿或崩溃
          if (isTauri()) {
            try {
              const fileSize = await fileService.getFileSize(detail.path);
              if (fileSize > HUGE_FILE_THRESHOLD) {
                const currentMode = useEditorStore.getState().viewMode;
                if (currentMode !== "edit") {
                  setViewMode("edit");
                }
                // 通过通知服务提示用户
                const { notify } = await import("./services/notificationService");
                notify(t("app.largeFileNotify", { size: (fileSize / 1024 / 1024).toFixed(1) }));
              }
            } catch {
              // 获取文件大小失败，忽略
            }
          }
          // v0.4.0 功能4：记录初始版本快照（去重：已有 initial 则跳过）
          if (isTauri()) {
            versionSnapshotService.recordSnapshot(detail.path, detail.content, true).catch(() => {});
          }
        }
      }
    };
    window.addEventListener("lightmd:openFile", handler);
    return () => window.removeEventListener("lightmd:openFile", handler);
  }, [openFile, addRecentFile, addTempFile, setViewMode, setCurrentLanguage, t]);

  // ─── v0.4.0 功能4：版本快照窗口事件 ──────────────────────────
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.filePath) {
        setSnapshotFilePath(detail.filePath);
        setShowSnapshotDialog(true);
      }
    };
    window.addEventListener("lightmd:showSnapshotDialog", handler);
    return () => window.removeEventListener("lightmd:showSnapshotDialog", handler);
  }, []);

  // ─── 同步当前文档路径到 imagePath 模块 ──────────
  // 供 schema.ts 的 image toDOM 和分屏预览的 img src 转换使用
  useEffect(() => {
    setCurrentDocPath(filePath);
  }, [filePath]);

  // ─── 文件关闭事件 ──────────────────────────
  useEffect(() => {
    const handler = () => {
      // 关闭当前活跃标签
      if (openTabs.length > 0) {
        const closedTab = closeTab(activeTabIdx);
        // v0.4.5 修复：同步从 recentFiles 中移除，避免下次启动时恢复已被用户关闭的文件
        if (closedTab) {
          useFileStore.getState().removeRecentFile(closedTab.path);
        }
      }
      const remainingTabs = useEditorStore.getState().openTabs;
      if (remainingTabs.length > 0) {
        const newActiveIdx = useEditorStore.getState().activeTabIdx;
        const tab = remainingTabs[newActiveIdx];
        if (tab) {
          setContent(tab.content || "");
          safeSetItem("lightmd-content", tab.content || "");
          openFile(tab.path);
          // v0.4.0：切换到剩余标签时，根据其路径重新设置语言标识
          const lang = isMarkdownFile(tab.path) ? "markdown" : getFileLanguage(tab.path);
          setCurrentLanguage(lang);
          setForceUpdateKey((k) => k + 1);
        }
      } else {
        setContent("");
        safeSetItem("lightmd-content", "");
        openFile(null);
        // v0.4.0：无剩余标签时重置为 markdown
        setCurrentLanguage("markdown");
        setForceUpdateKey((k) => k + 1);
      }
    };
    window.addEventListener("lightmd:closeFile", handler);
    return () => window.removeEventListener("lightmd:closeFile", handler);
  }, [openFile, closeTab, openTabs, activeTabIdx, setCurrentLanguage]);

  // ─── 图片粘贴处理器 ───────────────────────
  useEffect(() => {
    setImageHandler((files) => setImageFiles(files));
    return () => setImageHandler(null);
  }, []);

  // ─── 拖拽文件/文件夹打开（使用 Tauri 事件系统） ──────
  useEffect(() => {
    // 阻止浏览器默认拖拽行为，避免文件被当作链接打开
    const preventDefaults = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener("dragover", preventDefaults);
    document.addEventListener("drop", preventDefaults);

    if (!isTauri()) {
      return () => {
        document.removeEventListener("dragover", preventDefaults);
        document.removeEventListener("drop", preventDefaults);
      };
    }

    let unlisten: (() => void) | null = null;
    let cancelled = false;

    const setupDragDrop = async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const unlistenFn = await listen<{ paths: string[]; position: { x: number; y: number } }>("tauri://drag-drop", async (event) => {
          const paths = event.payload.paths;
          if (!paths || paths.length === 0) return;

          const firstPath = paths[0];
          // 先判断扩展名：是支持的文本文件就直接读取，避免触发 listDir 错误提示
          if (isSupportedTextFile(firstPath)) {
            try {
              const content = await fileService.readFile(firstPath);
              window.dispatchEvent(
                new CustomEvent("lightmd:openFile", {
                  detail: { path: firstPath, content },
                })
              );
            } catch (err) {
              console.error("拖拽打开文件失败:", err);
            }
          } else {
            // 非已知文本文件，尝试作为文件夹打开（silent 避免文件路径触发错误提示）
            try {
              await fileService.listDir(firstPath, { silent: true });
              window.dispatchEvent(
                new CustomEvent("lightmd:openFolder", { detail: { path: firstPath } })
              );
            } catch {
              // 既不是支持的文件也不是目录，忽略
              console.warn("拖拽路径既不是支持的文件也不是目录:", firstPath);
            }
          }
        });
        // 修复 StrictMode 竞态：组件可能在 listen 返回前已卸载
        if (cancelled) {
          unlistenFn();
        } else {
          unlisten = unlistenFn;
        }
      } catch (err) {
        console.error("设置拖拽监听失败:", err);
      }
    };

    setupDragDrop();
    return () => {
      cancelled = true;
      document.removeEventListener("dragover", preventDefaults);
      document.removeEventListener("drop", preventDefaults);
      unlisten?.();
    };
  }, []);

  // ─── 文件关联：监听启动参数打开文件（双击 .md 文件启动应用）──────
  useEffect(() => {
    if (!isTauri()) return;
    let unlistenArgv: (() => void) | null = null;

    const setupArgvListener = async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        // 监听 Rust 端发送的启动文件路径事件
        unlistenArgv = await listen<string>("lightmd:openFileArgv", async (event) => {
          const filePath = event.payload;
          if (!filePath) return;
          try {
            const content = await fileService.readFile(filePath);
            window.dispatchEvent(
              new CustomEvent("lightmd:openFile", {
                detail: { path: filePath, content },
              })
            );
          } catch (err) {
            console.error("文件关联打开失败:", err);
          }
        });
      } catch (err) {
        console.error("设置文件关联监听失败:", err);
      }
    };

    setupArgvListener();
    return () => {
      unlistenArgv?.();
    };
  }, []);

  // ─── 启动载入上次打开的文件（F2：支持多文件恢复） ──────────────────────────
  // 仅在 Tauri 环境、开关开启、且非双击文件启动时载入上次文件
  // 双击文件启动时 lightmd:openFileArgv 事件会处理，此处通过 startupRef 避免重复
  // F2 改造：读取 loadLastFileCount（N），从 recentFiles 取前 N 条，串行打开
  // 问题8修复：恢复完成后显式切换到第一个文件（recentFiles[0]，即最后打开的文件）
  const startupRestoreRef = useRef(false);
  useEffect(() => {
    if (startupRestoreRef.current) return;
    startupRestoreRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const { restoreRecentFiles } = await import("./utils/startupRestore");
        if (cancelled) return;
        const result = await restoreRecentFiles({
          dispatchOpenFile: (detail) => {
            window.dispatchEvent(
              new CustomEvent("lightmd:openFile", { detail })
            );
          },
          removeRecentFile: (path) => {
            useFileStore.getState().removeRecentFile(path);
          },
        });
        // 问题8修复：恢复完成后，切换到第一个打开的文件（即 recentFiles[0]，最后打开的文件）
        // restoreRecentFiles 串行打开，最后打开的成为活跃标签，但用户期望最后打开的文件为活跃文件
        if (result.restored > 0 && !cancelled) {
          const { openTabs, setActiveTab, openFile, setCurrentLanguage } = useEditorStore.getState();
          if (openTabs.length > 0) {
            const firstTab = openTabs[0];
            setActiveTab(0);
            // 同步 content 和 filePath，并同步设置 currentDocPath 确保图片渲染正确
            setCurrentDocPath(firstTab.path);
            setContent(firstTab.content || "");
            safeSetItem("lightmd-content", firstTab.content || "");
            openFile(firstTab.path);
            // v0.4.0：启动恢复时同步语言标识
            const lang = isMarkdownFile(firstTab.path) ? "markdown" : getFileLanguage(firstTab.path);
            setCurrentLanguage(lang);
            setForceUpdateKey((k) => k + 1);
          }
        }
      } catch (err) {
        console.warn("[启动恢复] 文件恢复失败:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ─── 启动载入上次打开的文件夹（F3 / v0.4.0 多文件夹） ──────────────────────────
  // 在文件恢复之后执行（延迟 100ms 确保文件恢复完成）
  // v0.4.0：按 loadLastFolderCount 恢复多个文件夹，每个调用 addOpenFolder + updateFolderTree
  const startupFolderRestoreRef = useRef(false);
  useEffect(() => {
    if (startupFolderRestoreRef.current) return;
    startupFolderRestoreRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const { restoreRecentFolders } = await import("./utils/startupRestore");
        if (cancelled) return;
        // v0.4.0：从 settings 读取恢复数量，传入 addOpenFolder + updateFolderTree 启用多文件夹模式
        const { loadLastFolderCount } = useSettingsStore.getState();
        await restoreRecentFolders({
          count: loadLastFolderCount,
          addOpenFolder: (path) => {
            useFileStore.getState().addOpenFolder(path);
          },
          updateFolderTree: (path, entries) => {
            // 将 listDir 原始结果（FileEntry[]）转为 store 的 FileNode[] 后更新
            const nodes = (entries as FileEntry[]).map((e) => ({
              name: e.name,
              path: e.path,
              isDir: e.is_dir,
              size: e.size,
            }));
            useFileStore.getState().updateFolderTree(path, nodes);
          },
          removeRecentFolder: (path) => {
            useFileStore.getState().removeRecentFolder(path);
          },
          delayMs: 100,
        });
      } catch (err) {
        console.warn("[启动恢复] 文件夹恢复失败:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ─── 打开文件（Ctrl+O）──────────────────────
  const handleOpenFile = useCallback(async () => {
    try {
      if (isTauri()) {
        // 支持所有文本/代码文件，以 Markdown 为主
        const extensions = ALL_SUPPORTED_EXTENSIONS.map((ext) => ext.slice(1));
        const selected = await open({
          multiple: false,
          filters: [
            { name: t("app.markdownFilter"), extensions: ["md", "markdown", "mdown", "mkd"] },
            { name: t("app.allSupportedFiles"), extensions },
          ],
        });
        if (selected) {
          const fileContent = await fileService.readFile(selected);
          window.dispatchEvent(
            new CustomEvent("lightmd:openFile", {
              detail: { path: selected, content: fileContent },
            })
          );
        }
      } else {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ALL_SUPPORTED_EXTENSIONS.join(",");
        input.onchange = async () => {
          const file = input.files?.[0];
          if (file) {
            const text = await file.text();
            window.dispatchEvent(
              new CustomEvent("lightmd:openFile", {
                detail: { path: file.name, content: text },
              })
            );
          }
        };
        input.click();
      }
    } catch (err) {
      console.error("打开文件失败:", err);
    }
  }, [t]);

  // ─── 另存为（Ctrl+Shift+S）── 定义在 handleSaveFile 之前 ──
  const handleSaveAsFile = useCallback(async () => {
    const view = editorViewRef.current;
    if (!view) return;

    // 根据当前模式选择数据源（与 handleSaveFile 一致）
    const { getMarkdownFromDoc } = await import("./core/editor");
    const currentMode = useEditorStore.getState().viewMode;
    const isSourceMode = currentMode === "edit" || currentMode === "split";
    const markdown = isSourceMode ? contentRef.current : getMarkdownFromDoc(view.state.doc);

    if (isTauri()) {
      try {
        const selected = await save({
          defaultPath: getFileName(filePath || t("app.unnamed")),
          filters: [{ name: t("app.markdownFilter"), extensions: ["md"] }],
        });
        if (selected) {
          await fileService.writeFile(selected, markdown);
          openFile(selected);
          setDirty(false);
          // 清除当前标签页的脏标记（修复：另存为后小蓝点未消失）
          const { activeTabIdx } = useEditorStore.getState();
          updateTabDirty(activeTabIdx, false);
          addRecentFile({ path: selected, name: getFileName(selected) });
          // v0.4.0 功能4：对新路径记录初始版本快照
          versionSnapshotService.recordSnapshot(selected, markdown, true).catch(() => {});
        }
      } catch (err) {
        console.error("另存为失败:", err);
      }
    } else {
      const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = getFileName(filePath || t("app.unnamed"));
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      // 清除当前标签页的脏标记（修复：浏览器环境保存后小蓝点未消失）
      const { activeTabIdx: browserIdx } = useEditorStore.getState();
      updateTabDirty(browserIdx, false);
    }
  }, [filePath, openFile, setDirty, addRecentFile, updateTabDirty, t]);

  // ─── 保存文件（Ctrl+S）── 依赖 handleSaveAsFile ──
  const handleSaveFile = useCallback(async () => {
    const view = editorViewRef.current;
    if (!view) return;

    // 根据当前模式选择数据源：
    // - 编辑/分屏模式：content state 是最新的（textarea 内容已通过 onContentChange 同步）
    // - 阅读模式：从 ProseMirror doc 序列化
    const { getMarkdownFromDoc } = await import("./core/editor");
    const currentMode = useEditorStore.getState().viewMode;
    const isSourceMode = currentMode === "edit" || currentMode === "split";
    // 编辑/分屏模式直接用 content state（已是最新的 textarea 内容）
    // 阅读模式从 ProseMirror doc 序列化
    const markdown = isSourceMode ? contentRef.current : getMarkdownFromDoc(view.state.doc);

    if (isTauri() && filePath) {
      try {
        await fileService.writeFile(filePath, markdown);
        setDirty(false);
        // v0.6.1 问题3：手动保存成功后解除翻译回写的自动保存抑制
        useEditorStore.getState().setSuppressAutoSave(false);
        // v0.6.1 问题2：手动保存 = 接受译文，清除"取消翻译"气泡
        useEditorStore.getState().setTranslateUndoSnapshot(null);
        // 清除当前标签页的脏标记
        const { activeTabIdx } = useEditorStore.getState();
        updateTabDirty(activeTabIdx, false);
        // v0.4.0 功能4：保存成功后记录版本快照（内容去重由服务内部处理）
        versionSnapshotService.recordSnapshot(filePath, markdown).catch(() => {});
      } catch (err) {
        console.error("保存失败:", err);
      }
    } else if (isTauri() && !filePath) {
      await handleSaveAsFile();
    } else {
      safeSetItem("lightmd-content", markdown);
      setDirty(false);
      // v0.6.1 问题3：手动保存成功后解除翻译回写的自动保存抑制
      useEditorStore.getState().setSuppressAutoSave(false);
      // v0.6.1 问题2：手动保存 = 接受译文，清除"取消翻译"气泡
      useEditorStore.getState().setTranslateUndoSnapshot(null);
      // 清除当前标签页的脏标记（修复：浏览器环境保存后小蓝点未消失）
      const { activeTabIdx } = useEditorStore.getState();
      updateTabDirty(activeTabIdx, false);
    }
  }, [filePath, setDirty, handleSaveAsFile, updateTabDirty]);

  // ─── 新建文件（Ctrl+N）──────────────────────
  const handleNewFile = useCallback(async () => {
    if (isDirty && filePath) {
      if (!window.confirm(t("app.confirmNewWithUnsaved"))) {
        return;
      }
    }

    if (isTauri()) {
      // Tauri 环境：弹出另存为对话框，让用户选择新文件的位置
      try {
        const selected = await save({
          defaultPath: t("app.unnamed"),
          filters: [{ name: t("app.markdownFilter"), extensions: ["md"] }],
        });
        if (selected) {
          // 创建空文件
          const defaultContent = t("app.unnamedDoc");
          await fileService.writeFile(selected, defaultContent);
          // 打开新创建的文件
          window.dispatchEvent(
            new CustomEvent("lightmd:openFile", {
              detail: { path: selected, content: defaultContent },
            })
          );
          addRecentFile({ path: selected, name: getFileName(selected) });
        }
      } catch (err) {
        console.error("新建文件失败:", err);
      }
    } else {
      // 浏览器环境：直接重置编辑器内容
      setContent(DEMO_MARKDOWN);
      safeSetItem("lightmd-content", DEMO_MARKDOWN);
      setForceUpdateKey((k) => k + 1);
      openFile(null);
      setDirty(false);
    }
  }, [filePath, isDirty, openFile, setDirty, addRecentFile, t]);

  // ─── 新建文件夹 ──────────────────────────────
  const handleNewFolder = useCallback(async () => {
    if (isTauri()) {
      const name = prompt(t("app.inputFolderName"), t("app.newFolderDefault"));
      if (!name) return;
      try {
        const selected = await save({
          defaultPath: name,
          filters: [{ name: "All", extensions: ["*"] }],
        });
        if (selected) {
          // 使用选择的路径创建文件夹
          const folderPath = selected.replace(/[^/\\]*$/, name);
          await fileService.createDir(folderPath);
        }
      } catch (err) {
        console.error("新建文件夹失败:", err);
      }
    }
  }, [t]);

  // ─── 标签页关闭回调 ──────────────────────────
  const handleTabClose = useCallback((tab: TabInfo, idx: number) => {
    // 检查脏标记
    if (tab.isDirty) {
      if (!window.confirm(t("app.confirmCloseDirty", { name: tab.name }))) {
        return;
      }
    }
    // 关闭标签
    closeTab(idx);
    // v0.4.5 修复：同步从 recentFiles 中移除，避免下次启动时恢复已被用户关闭的文件
    useFileStore.getState().removeRecentFile(tab.path);
    // 同步移除左侧"打开的文件"中的临时文件
    const { tempFiles } = useFileStore.getState();
    if (tempFiles.some(f => f.path === tab.path)) {
      useFileStore.getState().removeTempFile(tab.path);
    }
    const remainingTabs = useEditorStore.getState().openTabs;
    const newActiveIdx = useEditorStore.getState().activeTabIdx;
    if (remainingTabs.length > 0 && remainingTabs[newActiveIdx]) {
      const activeTab = remainingTabs[newActiveIdx];
      setContent(activeTab.content || "");
      safeSetItem("lightmd-content", activeTab.content || "");
      openFile(activeTab.path);
      setDirty(activeTab.isDirty || false);
    } else {
      setContent("");
      safeSetItem("lightmd-content", "");
      openFile(null);
      setDirty(false);
    }
    setForceUpdateKey((k) => k + 1);
  }, [closeTab, openFile, setDirty, t]);

  // ─── G8：命令面板事件路由 ──────────────────────────
  // 监听 'lightmd:command' 事件，根据 id 执行对应操作
  // 文件/视图/编辑/导出命令复用现有 handler
  // 格式/插入命令通过 sourceInsertHandler（源码模式）或 editorView（阅读模式）处理
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const id: string = detail?.id;
      if (!id) return;

      // 文件命令
      if (id === "file.new") { handleNewFile(); return; }
      if (id === "file.open") { handleOpenFile(); return; }
      if (id === "file.save") { handleSaveFile(); return; }
      if (id === "file.saveAs") { handleSaveAsFile(); return; }

      // 编辑命令
      if (id === "edit.undo") { undoHandler?.(); return; }
      if (id === "edit.redo") { redoHandler?.(); return; }
      if (id === "edit.find") { setShowSearch(true); return; }
      if (id === "edit.replace") { setShowSearchReplace(true); return; }

      // 视图命令
      if (id === "view.preview") { setViewMode("preview"); return; }
      if (id === "view.edit") { setViewMode("edit"); return; }
      if (id === "view.split") { setViewMode("split"); return; }
      if (id === "view.toggleTheme") {
        const idx = THEMES.indexOf(theme as Theme);
        setTheme(THEMES[(idx + 1) % THEMES.length]);
        return;
      }
      if (id === "view.toggleFocusMode") { toggleFocusMode(); return; }
      if (id === "view.toggleTypewriter") { toggleTypewriter(); return; }
      if (id === "view.toggleOutline") { setShowOutline((v) => !v); return; }
      if (id === "view.settings") { setShowSettings(true); return; }

      // 导出命令
      if (id === "export.html" || id === "export.pdf") { setShowExport(true); return; }

      // 格式/插入命令：通过 sourceInsertHandler（源码模式）或 editorView（阅读模式）处理
      const syntaxEntry = COMMAND_SYNTAX[id];
      if (syntaxEntry) {
        const currentMode = useEditorStore.getState().viewMode;
        const isSource = currentMode === "edit" || currentMode === "split";
        if (isSource && sourceInsertHandler) {
          // 源码模式：通过 sourceInsertHandler 插入语法
          sourceInsertHandler(syntaxEntry.syntax, syntaxEntry.cursorOffset);
        } else if (editorViewRef.current) {
          // 阅读模式：通过 ProseMirror 插入文本
          const view = editorViewRef.current;
          const tr = view.state.tr.insertText(syntaxEntry.syntax);
          view.dispatch(tr);
          view.focus();
        }
      }
    };
    window.addEventListener("lightmd:command", handler);
    return () => window.removeEventListener("lightmd:command", handler);
  }, [
    theme, setTheme, toggleFocusMode, toggleTypewriter, setViewMode,
    handleNewFile, handleOpenFile, handleSaveFile, handleSaveAsFile,
    undoHandler, redoHandler, setShowSearch, setShowSearchReplace,
    setShowSettings, setShowExport, sourceInsertHandler,
  ]);

  // ─── 快捷键 ────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // 双击 Ctrl 切换阅读/编辑模式
      // v0.6.1 修复：长按 Ctrl 时浏览器持续派发 repeat keydown 导致模式连续切换，
      // 使用 evalDoublePress 三态判定（skip 时完全忽略，不刷新时间戳）
      if (e.key === "Control") {
        const now = Date.now();
        const r = evalDoublePress(now, lastCtrlTimeRef.current, DOUBLE_CLICK_THRESHOLD, e.repeat);
        if (r === "toggle") {
          e.preventDefault();
          // 在阅读和编辑之间切换
          if (viewMode === "preview") {
            setViewMode("edit");
          } else if (viewMode === "edit") {
            setViewMode("preview");
          } else {
            // 分屏模式切回阅读
            setViewMode("preview");
          }
          lastCtrlTimeRef.current = 0;
        } else if (r === "record") {
          lastCtrlTimeRef.current = now;
        }
        return;
      }

      // 双击 Shift 切换分屏模式（同样过滤长按 repeat 事件）
      if (e.key === "Shift" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const now = Date.now();
        const r = evalDoublePress(now, lastShiftTimeRef.current, DOUBLE_CLICK_THRESHOLD, e.repeat);
        if (r === "toggle") {
          e.preventDefault();
          // 如果当前是分屏模式，切回上一个模式；否则切到分屏
          if (viewMode === "split") {
            setViewMode(prevViewMode);
          } else {
            setViewMode("split");
          }
          lastShiftTimeRef.current = 0;
        } else if (r === "record") {
          lastShiftTimeRef.current = now;
        }
        return;
      }

      // 应用级快捷键（Ctrl+O/S/N 等）需要在任何地方都能触发，
      // 不能因为编辑器 contentEditable 而被拦截。
      // 只对 INPUT/TEXTAREA 中的普通按键放行，不拦截带 Ctrl 的组合键。
      const target = e.target as HTMLElement;
      const isInputField = target.tagName === "INPUT" || target.tagName === "TEXTAREA";

      // 撤销 Ctrl+Z
      if (e.ctrlKey && !e.shiftKey && e.key === "z") {
        if (isInputField && target.tagName === "TEXTAREA") {
          // textarea 中：阻止浏览器原生撤销，使用自定义撤销
          e.preventDefault();
          if (undoHandler) undoHandler();
        }
        // ProseMirror 中由其 keymap 处理，不拦截
        return;
      }
      // 恢复 Ctrl+Y / Ctrl+Shift+Z
      if ((e.ctrlKey && !e.shiftKey && e.key === "y") ||
          (e.ctrlKey && e.shiftKey && e.key === "Z")) {
        if (isInputField && target.tagName === "TEXTAREA") {
          // textarea 中：阻止浏览器原生行为，使用自定义恢复
          e.preventDefault();
          if (redoHandler) redoHandler();
        }
        // ProseMirror 中由其 keymap 处理，不拦截
        return;
      }

      if (e.ctrlKey && !e.shiftKey && e.key === "o") {
        e.preventDefault();
        handleOpenFile();
        return;
      }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === "s") {
        // 排除 Alt 修饰键：Ctrl+Alt+S 已在 EditorContainer 中映射为「删除线」
        e.preventDefault();
        handleSaveFile();
        return;
      }
      if (e.ctrlKey && e.shiftKey && e.key === "S") {
        e.preventDefault();
        handleSaveAsFile();
        return;
      }
      if (e.ctrlKey && !e.shiftKey && e.key === "n") {
        e.preventDefault();
        handleNewFile();
        return;
      }
      if (e.ctrlKey && e.shiftKey && e.key === "T") {
        e.preventDefault();
        // G6：循环切换 6 个主题（light → dark → github → newsprint → night → solarized → light）
        const idx = THEMES.indexOf(theme as Theme);
        const nextTheme = THEMES[(idx + 1) % THEMES.length];
        setTheme(nextTheme);
      }
      if (e.ctrlKey && e.key === ",") {
        e.preventDefault();
        setShowSettings(true);
      }
      if (e.ctrlKey && e.shiftKey && e.key === "E") {
        e.preventDefault();
        setShowExport(true);
      }
      if (e.key === "F8") {
        e.preventDefault();
        toggleFocusMode();
      }
      if (e.key === "F9") {
        e.preventDefault();
        toggleTypewriter();
      }
      if (e.ctrlKey && e.shiftKey && e.key === "O") {
        e.preventDefault();
        setShowOutline((v) => !v);
      }
      // G8：Ctrl+Shift+P 打开命令面板
      if (e.ctrlKey && e.shiftKey && (e.key === "P" || e.key === "p")) {
        e.preventDefault();
        setShowCommandPalette(true);
      }
      // v0.4.0 功能4：Ctrl+Shift+V 打开版本快照窗口
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "v") {
        e.preventDefault();
        const { openTabs, activeTabIdx } = useEditorStore.getState();
        const activeTab = openTabs[activeTabIdx];
        if (activeTab) {
          setSnapshotFilePath(activeTab.path);
          setShowSnapshotDialog(true);
        }
        return;
      }
      // Ctrl+Tab 切换到下一个标签，Ctrl+Shift+Tab 切换到上一个标签
      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        const { openTabs, activeTabIdx } = useEditorStore.getState();
        if (openTabs.length <= 1) return;
        // 保存当前标签内容
        updateTabContent(activeTabIdx, contentRef.current);
        const nextIdx = e.shiftKey
          ? (activeTabIdx - 1 + openTabs.length) % openTabs.length
          : (activeTabIdx + 1) % openTabs.length;
        const nextTab = openTabs[nextIdx];
        setActiveTab(nextIdx);
        setContent(nextTab.content || "");
        safeSetItem("lightmd-content", nextTab.content || "");
        openFile(nextTab.path);
        setDirty(nextTab.isDirty || false);
        setForceUpdateKey((k) => k + 1);
        return;
      }
      // Ctrl+W 关闭当前标签
      if (e.ctrlKey && !e.shiftKey && e.key === "w") {
        e.preventDefault();
        const { openTabs, activeTabIdx } = useEditorStore.getState();
        if (openTabs.length > 0 && openTabs[activeTabIdx]) {
          handleTabClose(openTabs[activeTabIdx], activeTabIdx);
        }
        return;
      }
      // Ctrl+F 搜索
      if (e.ctrlKey && !e.shiftKey && e.key === "f") {
        e.preventDefault();
        setShowSearch(true);
      }
      // Ctrl+H 查找替换
      if (e.ctrlKey && !e.shiftKey && e.key === "h") {
        e.preventDefault();
        setShowSearchReplace(true);
      }
      // v0.6.0：F6 AI 翻译选中内容（统一走 lightmd:command 事件，由 EditorContainer 处理）
      if (e.key === "F6" && !e.shiftKey) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "edit.translate" } }));
      }
      // v0.6.1：Shift+F6 全文翻译（统一走 lightmd:command 事件，由 EditorContainer 处理）
      if (e.key === "F6" && e.shiftKey) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "edit.translateDocument" } }));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [theme, setTheme, toggleFocusMode, toggleTypewriter, viewMode, prevViewMode, setViewMode, handleOpenFile, handleSaveFile, handleSaveAsFile, handleNewFile, setShowSearch, setShowSearchReplace, undoHandler, redoHandler, handleTabClose, updateTabContent, setActiveTab]);

  // ─── 内容变化回调（localStorage 防抖写入，减少同步大字符串写入的内存峰值）──
  const lsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingMdRef = useRef<string>("");
  // 追踪当前 content state，避免 ProseMirror 编辑时 setContent 触发不必要的重渲染
  const contentRef = useRef(content);
  contentRef.current = content;

  const handleContentChange = useCallback((markdown: string) => {
    // 仅在内容真正变化时才更新 React state 和脏标记
    // 修复：原代码无条件 updateTabDirty(true)，导致保存后若触发 onContentChange（如模式切换同步）
    // 会重新设置脏标记，小蓝点不消失
    if (markdown !== contentRef.current) {
      setContent(markdown);
      // 同步更新当前标签页的内容和脏标记（仅内容真正变化时才标记为脏）
      const { openTabs, activeTabIdx } = useEditorStore.getState();
      if (openTabs.length > 0 && openTabs[activeTabIdx]) {
        updateTabContent(activeTabIdx, markdown);
        updateTabDirty(activeTabIdx, true);
      }
    }
    pendingMdRef.current = markdown;
    if (lsTimerRef.current) clearTimeout(lsTimerRef.current);
    lsTimerRef.current = setTimeout(() => {
      safeSetItem("lightmd-content", pendingMdRef.current);
      lsTimerRef.current = null;
    }, 500);
  }, [updateTabContent, updateTabDirty]);

  // 关闭浏览器前刷新 pending 的 localStorage 写入，防止数据丢失
  useEffect(() => {
    const handler = () => {
      if (lsTimerRef.current && pendingMdRef.current) {
        safeSetItem("lightmd-content", pendingMdRef.current);
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  // ─── v0.4.5 性能优化：窗口失焦/页面隐藏时暂停空状态 Logo 动画 ──────
  // 软件在后台时无需持续渲染 CSS 动画，通过 body.app-blurred class 暂停
  // 与 editor.css 的 .app-blurred .editor-empty-logo { animation-play-state: paused } 配合
  useEffect(() => {
    const setBlurred = (blurred: boolean) => {
      document.body.classList.toggle("app-blurred", blurred);
    };
    const onVisibilityChange = () => setBlurred(document.hidden);
    const onBlur = () => setBlurred(true);
    const onFocus = () => setBlurred(false);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  // ─── 图片插入回调 ─────────────────────────
  const handleImageInsert = useCallback(
    async (images: Array<{ src: string; alt: string }>) => {
      if (!editorView) return;
      for (const img of images) {
        insertImageAtCursor(editorView, img.src, img.alt);
      }
      setImageFiles(null);
    },
    [editorView]
  );

  const fileName = filePath ? getFileName(filePath) : t("app.untitled");

  // ─── 标签页切换回调 ──────────────────────────
  const handleTabSwitch = useCallback((tab: TabInfo) => {
    // 切换到目标标签：先保存当前内容，再加载目标标签内容
    const { openTabs, activeTabIdx, getTabByPath } = useEditorStore.getState();
    // 保存当前标签的内容（activeTabIdx 此时仍是旧标签的索引）
    if (openTabs[activeTabIdx]) {
      updateTabContent(activeTabIdx, contentRef.current);
    }
    // 切换到目标标签
    const targetIdx = getTabByPath(tab.path);
    if (targetIdx !== -1) {
      setActiveTab(targetIdx);
    }
    // 加载目标标签内容
    setContent(tab.content || "");
    safeSetItem("lightmd-content", tab.content || "");
    openFile(tab.path);
    // v0.4.0：切换标签时同步语言标识，确保代码文件正确高亮
    const lang = isMarkdownFile(tab.path) ? "markdown" : getFileLanguage(tab.path);
    setCurrentLanguage(lang);
    setDirty(tab.isDirty || false);
    setForceUpdateKey((k) => k + 1);
  }, [openFile, setDirty, updateTabContent, setActiveTab, setCurrentLanguage]);

  return (
    <div className="app" data-theme={theme}>
      <TitleBar
        fileName={isDirty ? `${fileName} ●` : fileName}
        onNew={handleNewFile}
        onNewFile={handleNewFile}
        onNewFolder={handleNewFolder}
        onOpen={handleOpenFile}
        onSave={handleSaveFile}
        onSaveAs={handleSaveAsFile}
        onExport={() => setShowExport(true)}
        onSettings={() => setShowSettings(true)}
      />
      <TabBar
        onTabSwitch={handleTabSwitch}
        onTabClose={handleTabClose}
      />
      <AppShell
        sidebar={<FileTree />}
        outline={
          // v0.4.5 修复：仅 md 文件才显示大纲，切换至非 md 文件时自动关闭大纲栏
          // 旧逻辑仅用 filePath 判断，非 md 文件也会显示 Outline，导致切换文件时大纲栏未关闭
          showOutline && filePath && isMarkdownFile(filePath || "")
            ? (isSourceMode
                ? <SyntaxHelper onInsert={sourceInsertHandler || undefined} />
                : <Outline editorView={editorView} />)
            : undefined
        }
      >
        <EditorContainer
          content={content}
          filePath={filePath}
          forceUpdateKey={forceUpdateKey}
          onEditorReady={handleEditorReady}
          onContentChange={handleContentChange}
        />
      </AppShell>
      <StatusBar />

      <NotificationToast notifications={notifications} />

      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      {showExport && (
        <ExportDialog
          onClose={() => setShowExport(false)}
          markdown={content}
          title={fileName}
          filePath={filePath}
        />
      )}
      {imageFiles && (
        <ImagePasteDialog
          files={imageFiles}
          filePath={filePath}
          onInsert={handleImageInsert}
          onCancel={() => setImageFiles(null)}
        />
      )}
      {/* G8：命令面板（Ctrl+Shift+P） */}
      {showCommandPalette && (
        <CommandPalette onClose={() => setShowCommandPalette(false)} />
      )}
      {/* v0.4.0 功能4：版本快照窗口（Ctrl+Shift+V） */}
      {showSnapshotDialog && snapshotFilePath && (
        <VersionSnapshotDialog
          filePath={snapshotFilePath}
          currentContent={content}
          onClose={() => {
            setShowSnapshotDialog(false);
            setSnapshotFilePath(null);
          }}
          onApply={(newContent) => {
            // 应用版本后同步编辑器内容（文件已由 applySnapshot 写回磁盘）
            setContent(newContent);
            safeSetItem("lightmd-content", newContent);
            setForceUpdateKey((k) => k + 1);
            setDirty(false);
            const { activeTabIdx } = useEditorStore.getState();
            updateTabContent(activeTabIdx, newContent);
            updateTabDirty(activeTabIdx, false);
          }}
        />
      )}
    </div>
  );
}

export default App;
