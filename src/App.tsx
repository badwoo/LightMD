import { useState, useEffect, useCallback, useRef } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useSettingsStore } from "./stores/useSettingsStore";
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
import { setImageHandler, insertImageAtCursor } from "./core/plugins/image-paste";
import { fileService, isTauri } from "./services/fileService";
import { safeSetItem } from "./utils/safeStorage";
import { setCurrentDocPath } from "./utils/imagePath";
import { isSupportedTextFile, isMarkdownFile, ALL_SUPPORTED_EXTENSIONS, HUGE_FILE_THRESHOLD } from "./utils/constants";
import {
  setNotificationHandler,
  type Notification,
} from "./services/notificationService";
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
  return path.split(/[\\/]/).pop() || "无标题.md";
}

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

  // ─── 文件打开事件 ──────────────────────────
  useEffect(() => {
    const handler = async (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.content !== undefined) {
        // 只通过 React 状态更新编辑器内容，避免双重 dispatch
        // EditorContainer 的 useEffect([content, forceUpdateKey]) 会统一处理 ProseMirror 更新
        setContent(detail.content);
        safeSetItem("lightmd-content", detail.content);
        setForceUpdateKey((k) => k + 1);

        // 设置文件路径和清除 dirty 标记
        if (detail.path) {
          openFile(detail.path);
          // 记录上次打开的文件路径，供启动时恢复使用
          safeSetItem("lightmd-last-file", detail.path);
          // 添加到标签页（若已存在则切换到该标签，但不更新 content）
          addTab({ path: detail.path, name: getFileName(detail.path), content: detail.content, isDirty: false });
          // 显式更新标签页 content，确保已存在标签页也能加载最新内容
          const { activeTabIdx: newIdx } = useEditorStore.getState();
          updateTabContent(newIdx, detail.content);
          addRecentFile({
            path: detail.path,
            name: getFileName(detail.path),
          });
          // 如果文件不在当前目录树中，添加为临时文件
          if (!rootPath || !detail.path.startsWith(rootPath)) {
            addTempFile({
              name: getFileName(detail.path),
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
                notify(`文件较大（${(fileSize / 1024 / 1024).toFixed(1)}MB），已切换到编辑模式以保证流畅度`);
              }
            } catch {
              // 获取文件大小失败，忽略
            }
          }
        }
      }
    };
    window.addEventListener("lightmd:openFile", handler);
    return () => window.removeEventListener("lightmd:openFile", handler);
  }, [openFile, addRecentFile, addTempFile, rootPath, setViewMode]);

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
        closeTab(activeTabIdx);
      }
      const remainingTabs = useEditorStore.getState().openTabs;
      if (remainingTabs.length > 0) {
        const newActiveIdx = useEditorStore.getState().activeTabIdx;
        const tab = remainingTabs[newActiveIdx];
        if (tab) {
          setContent(tab.content || "");
          safeSetItem("lightmd-content", tab.content || "");
          openFile(tab.path);
          setForceUpdateKey((k) => k + 1);
        }
      } else {
        setContent("");
        safeSetItem("lightmd-content", "");
        openFile(null);
        setForceUpdateKey((k) => k + 1);
      }
    };
    window.addEventListener("lightmd:closeFile", handler);
    return () => window.removeEventListener("lightmd:closeFile", handler);
  }, [openFile, closeTab, openTabs, activeTabIdx]);

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
          try {
            // 尝试列出目录内容：成功说明是文件夹
            const entries = await fileService.listDir(firstPath);
            window.dispatchEvent(
              new CustomEvent("lightmd:openFolder", { detail: { path: firstPath } })
            );
          } catch {
            // listDir 失败说明是文件，走文件打开逻辑
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

  // ─── 启动载入上次打开的文件 ──────────────────────────
  // 仅在 Tauri 环境、开关开启、且非双击文件启动时载入上次文件
  // 双击文件启动时 lightmd:openFileArgv 事件会处理，此处通过 startupRef 避免重复
  const startupRestoreRef = useRef(false);
  useEffect(() => {
    if (startupRestoreRef.current) return;
    startupRestoreRef.current = true;
    // 直接从 localStorage 读取设置，避免 Zustand persist hydration 时机问题
    let loadLast = true;
    try {
      const settingsRaw = localStorage.getItem("lightmd-settings");
      if (settingsRaw) {
        const parsed = JSON.parse(settingsRaw);
        if (parsed?.state?.loadLastFileOnStartup === false) {
          loadLast = false;
        }
      }
    } catch {
      // 读取失败，使用默认值（开启）
    }
    if (!loadLast) return;
    if (!isTauri()) return;
    const lastFile = localStorage.getItem("lightmd-last-file");
    if (!lastFile) return;
    // 异步读取上次文件内容并触发打开事件
    (async () => {
      try {
        const fileContent = await fileService.readFile(lastFile);
        window.dispatchEvent(
          new CustomEvent("lightmd:openFile", {
            detail: { path: lastFile, content: fileContent },
          })
        );
      } catch (err) {
        // 文件可能已被删除/移动，清除记录并静默失败
        console.warn("[启动恢复] 上次文件打开失败:", err);
        localStorage.removeItem("lightmd-last-file");
      }
    })();
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
            { name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd"] },
            { name: "所有支持的文件", extensions },
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
  }, []);

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
          defaultPath: getFileName(filePath || "未命名.md"),
          filters: [{ name: "Markdown", extensions: ["md"] }],
        });
        if (selected) {
          await fileService.writeFile(selected, markdown);
          openFile(selected);
          setDirty(false);
          // 清除当前标签页的脏标记（修复：另存为后小蓝点未消失）
          const { activeTabIdx } = useEditorStore.getState();
          updateTabDirty(activeTabIdx, false);
          addRecentFile({ path: selected, name: getFileName(selected) });
        }
      } catch (err) {
        console.error("另存为失败:", err);
      }
    } else {
      const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = getFileName(filePath || "未命名.md");
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      // 清除当前标签页的脏标记（修复：浏览器环境保存后小蓝点未消失）
      const { activeTabIdx: browserIdx } = useEditorStore.getState();
      updateTabDirty(browserIdx, false);
    }
  }, [filePath, openFile, setDirty, addRecentFile, updateTabDirty]);

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
        // 清除当前标签页的脏标记
        const { activeTabIdx } = useEditorStore.getState();
        updateTabDirty(activeTabIdx, false);
      } catch (err) {
        console.error("保存失败:", err);
      }
    } else if (isTauri() && !filePath) {
      await handleSaveAsFile();
    } else {
      safeSetItem("lightmd-content", markdown);
      setDirty(false);
      // 清除当前标签页的脏标记（修复：浏览器环境保存后小蓝点未消失）
      const { activeTabIdx } = useEditorStore.getState();
      updateTabDirty(activeTabIdx, false);
    }
  }, [filePath, setDirty, handleSaveAsFile, updateTabDirty]);

  // ─── 新建文件（Ctrl+N）──────────────────────
  const handleNewFile = useCallback(async () => {
    if (isDirty && filePath) {
      if (!window.confirm("当前文件有未保存的更改，是否继续新建？")) {
        return;
      }
    }

    if (isTauri()) {
      // Tauri 环境：弹出另存为对话框，让用户选择新文件的位置
      try {
        const selected = await save({
          defaultPath: "未命名.md",
          filters: [{ name: "Markdown", extensions: ["md"] }],
        });
        if (selected) {
          // 创建空文件
          const defaultContent = "# 未命名文档\n\n开始输入内容...\n";
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
  }, [filePath, isDirty, openFile, setDirty, addRecentFile]);

  // ─── 新建文件夹 ──────────────────────────────
  const handleNewFolder = useCallback(async () => {
    if (isTauri()) {
      const name = prompt("输入文件夹名:", "新文件夹");
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
  }, []);

  // ─── 标签页关闭回调 ──────────────────────────
  const handleTabClose = useCallback((tab: TabInfo, idx: number) => {
    // 检查脏标记
    if (tab.isDirty) {
      if (!window.confirm(`"${tab.name}" 有未保存的更改，确定关闭吗？`)) {
        return;
      }
    }
    // 关闭标签
    closeTab(idx);
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
  }, [closeTab, openFile, setDirty]);

  // ─── 快捷键 ────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // 双击 Ctrl 切换阅读/编辑模式
      if (e.key === "Control") {
        const now = Date.now();
        if (now - lastCtrlTimeRef.current < DOUBLE_CLICK_THRESHOLD) {
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
        } else {
          lastCtrlTimeRef.current = now;
        }
        return;
      }

      // 双击 Shift 切换分屏模式
      if (e.key === "Shift" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const now = Date.now();
        if (now - lastShiftTimeRef.current < DOUBLE_CLICK_THRESHOLD) {
          e.preventDefault();
          // 如果当前是分屏模式，切回上一个模式；否则切到分屏
          if (viewMode === "split") {
            setViewMode(prevViewMode);
          } else {
            setViewMode("split");
          }
          lastShiftTimeRef.current = 0;
        } else {
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
        setTheme(theme === "light" ? "dark" : "light");
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

  const fileName = filePath ? getFileName(filePath) : "无标题.md";

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
    setDirty(tab.isDirty || false);
    setForceUpdateKey((k) => k + 1);
  }, [openFile, setDirty, updateTabContent, setActiveTab]);

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
          // 无文件时不显示大纲（修复：预览模式下关闭文件时大纲未关闭）
          showOutline && filePath
            ? (isSourceMode && isMarkdownFile(filePath || "")
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
    </div>
  );
}

export default App;
