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
import {
  setNotificationHandler,
  type Notification,
} from "./services/notificationService";
import type { EditorView } from "prosemirror-view";
import "./App.css";

const DEMO_MARKDOWN = `# 欢迎使用 LightMD

LightMD 是一款**轻量级**的 Markdown 编辑器，支持实时预览模式。

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
| 实时预览 | 已完成 | 光标所在行显示源码 |
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
        localStorage.setItem("lightmd-content", detail.content);
        setForceUpdateKey((k) => k + 1);

        // 设置文件路径和清除 dirty 标记
        if (detail.path) {
          openFile(detail.path);
          // 添加到标签页
          addTab({ path: detail.path, name: getFileName(detail.path), content: detail.content, isDirty: false });
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
        }
      }
    };
    window.addEventListener("lightmd:openFile", handler);
    return () => window.removeEventListener("lightmd:openFile", handler);
  }, [openFile, addRecentFile, addTempFile, rootPath]);

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
          localStorage.setItem("lightmd-content", tab.content || "");
          openFile(tab.path);
          setForceUpdateKey((k) => k + 1);
        }
      } else {
        setContent("");
        localStorage.setItem("lightmd-content", "");
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

  // ─── 拖拽文件打开（使用 Tauri 事件系统） ──────
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

    const setupDragDrop = async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<{ paths: string[]; position: { x: number; y: number } }>("tauri://drag-drop", async (event) => {
          const paths = event.payload.paths;
          if (!paths || paths.length === 0) return;

          // 查找第一个 .md 文件
          for (const filePath of paths) {
            const name = filePath.toLowerCase();
            if (name.endsWith(".md") || name.endsWith(".markdown") || name.endsWith(".mdown") || name.endsWith(".txt")) {
              try {
                const content = await fileService.readFile(filePath);
                window.dispatchEvent(
                  new CustomEvent("lightmd:openFile", {
                    detail: { path: filePath, content },
                  })
                );
              } catch (err) {
                console.error("拖拽打开文件失败:", err);
              }
              break;
            }
          }
        });
      } catch (err) {
        console.error("设置拖拽监听失败:", err);
      }
    };

    setupDragDrop();
    return () => {
      document.removeEventListener("dragover", preventDefaults);
      document.removeEventListener("drop", preventDefaults);
      unlisten?.();
    };
  }, []);

  // ─── 打开文件（Ctrl+O）──────────────────────
  const handleOpenFile = useCallback(async () => {
    try {
      if (isTauri()) {
        const selected = await open({
          multiple: false,
          filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "txt"] }],
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
        input.accept = ".md,.markdown,.mdown,.txt";
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

    const { getMarkdownFromDoc } = await import("./core/editor");
    const markdown = getMarkdownFromDoc(view.state.doc);

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
    }
  }, [filePath, openFile, setDirty, addRecentFile]);

  // ─── 保存文件（Ctrl+S）── 依赖 handleSaveAsFile ──
  const handleSaveFile = useCallback(async () => {
    const view = editorViewRef.current;
    if (!view) return;

    const { getMarkdownFromDoc } = await import("./core/editor");
    const markdown = getMarkdownFromDoc(view.state.doc);

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
      localStorage.setItem("lightmd-content", markdown);
      setDirty(false);
    }
  }, [filePath, setDirty, handleSaveAsFile]);

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
      localStorage.setItem("lightmd-content", DEMO_MARKDOWN);
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
      localStorage.setItem("lightmd-content", activeTab.content || "");
      openFile(activeTab.path);
      setDirty(activeTab.isDirty || false);
    } else {
      setContent("");
      localStorage.setItem("lightmd-content", "");
      openFile(null);
      setDirty(false);
    }
    setForceUpdateKey((k) => k + 1);
  }, [closeTab, openFile, setDirty]);

  // ─── 快捷键 ────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // 双击 Ctrl 切换预览/编辑模式
      if (e.key === "Control") {
        const now = Date.now();
        if (now - lastCtrlTimeRef.current < DOUBLE_CLICK_THRESHOLD) {
          e.preventDefault();
          // 在预览和编辑之间切换
          if (viewMode === "preview") {
            setViewMode("edit");
          } else if (viewMode === "edit") {
            setViewMode("preview");
          } else {
            // 分屏模式切回预览
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
      if (e.ctrlKey && !e.shiftKey && e.key === "s") {
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
        localStorage.setItem("lightmd-content", nextTab.content || "");
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
  }, [theme, setTheme, toggleFocusMode, viewMode, prevViewMode, setViewMode, handleOpenFile, handleSaveFile, handleSaveAsFile, handleNewFile, setShowSearch, setShowSearchReplace, undoHandler, redoHandler, handleTabClose, updateTabContent, setActiveTab]);

  // ─── 内容变化回调（localStorage 防抖写入，减少同步大字符串写入的内存峰值）──
  const lsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingMdRef = useRef<string>("");
  // 追踪当前 content state，避免 ProseMirror 编辑时 setContent 触发不必要的重渲染
  const contentRef = useRef(content);
  contentRef.current = content;

  const handleContentChange = useCallback((markdown: string) => {
    // 仅在内容真正变化时才更新 React state，避免 ProseMirror 编辑时的冗余重渲染
    if (markdown !== contentRef.current) {
      setContent(markdown);
    }
    // 同步更新当前标签页的内容和脏标记
    const { openTabs, activeTabIdx } = useEditorStore.getState();
    if (openTabs.length > 0 && openTabs[activeTabIdx]) {
      updateTabContent(activeTabIdx, markdown);
      updateTabDirty(activeTabIdx, true);
    }
    pendingMdRef.current = markdown;
    if (lsTimerRef.current) clearTimeout(lsTimerRef.current);
    lsTimerRef.current = setTimeout(() => {
      localStorage.setItem("lightmd-content", pendingMdRef.current);
      lsTimerRef.current = null;
    }, 500);
  }, [updateTabContent, updateTabDirty]);

  // 关闭浏览器前刷新 pending 的 localStorage 写入，防止数据丢失
  useEffect(() => {
    const handler = () => {
      if (lsTimerRef.current && pendingMdRef.current) {
        localStorage.setItem("lightmd-content", pendingMdRef.current);
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
    const { openTabs, activeTabIdx } = useEditorStore.getState();
    // 保存当前标签的内容
    if (openTabs[activeTabIdx]) {
      updateTabContent(activeTabIdx, contentRef.current);
    }
    // 加载目标标签内容
    setContent(tab.content || "");
    localStorage.setItem("lightmd-content", tab.content || "");
    openFile(tab.path);
    setDirty(tab.isDirty || false);
    setForceUpdateKey((k) => k + 1);
  }, [openFile, setDirty, updateTabContent]);

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
          showOutline
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
    </div>
  );
}

export default App;
