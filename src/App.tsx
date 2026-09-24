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
// v0.7.0 bug修复：文件浏览进度（重新打开/关闭标签时清除，标签切换保留）
import { fileScrollProgress } from "./services/fileScrollProgress";
import { safeSetItem } from "./utils/safeStorage";
// v0.8.0 WP1：临时（未落盘）标签的持久化与启动恢复
import { loadUntitledTabs, saveUntitledTabs, clearUntitledTabs, isUntitledRestoreEnabled } from "./utils/untitledTabs";
// v0.8.3 WP4 需求5：上次会话活跃标签的持久化（临时文件也能被正确定位）
import { saveLastActiveTab, loadLastActiveTab, resolveLastActiveIndex, clearLastActiveTab } from "./utils/lastActiveTab";
// v0.8.3 WP4 需求6：浏览进度的标签键（真实文件 = path，临时标签 = untitled:<id>）
import { tabsProgressKeys, untitledProgressKey } from "./utils/tabKey";
// v0.8.0 WP2 修复2：删除文件后按路径关闭匹配标签
import { collectTabsToClose } from "./utils/tabCleanup";
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

  /**
   * v0.8.3 WP4 需求6：会话恢复期标志。
   *
   * 启动恢复通过 `lightmd:openFile` 打开每个文件，而该事件处理里对"首次打开"的
   * 文件会 clear 浏览进度（= 重新打开，重置到顶部）。恢复期间 `alreadyOpen=false`
   * 会把刚注入的持久化进度当场清掉 → 需求6失效。
   * 故恢复期内跳过这一次 clear（用户主动打开文件发生在恢复完成之后，不受影响）。
   */
  const sessionRestoringRef = useRef(true);

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
        // v0.8.0 修复 P11-7：切走之前先把当前编辑器内容写回当前标签。
        // 旧实现直接 setContent(新文件)，当前文件刚编辑的内容没进标签就被覆盖 →
        // "编辑 A → 点开 B → 切回 A"时 A 的编辑丢失。
        const st0 = useEditorStore.getState();
        if (st0.openTabs[st0.activeTabIdx]) {
          st0.updateTabContent(st0.activeTabIdx, contentRef.current);
        }
        // v0.8.0 修复 P11-7：目标文件若已打开（已有标签），切回该标签并沿用标签内内容
        // （含未保存编辑），不再用磁盘内容覆盖；只有首次打开才采用磁盘内容。
        const existingIdx = detail.path ? st0.getTabByPath(detail.path) : -1;
        const alreadyOpen = existingIdx !== -1;
        const targetContent: string = alreadyOpen
          ? (st0.openTabs[existingIdx].content ?? detail.content)
          : detail.content;

        // 问题8修复：先同步设置文档路径，确保 ProseMirror 渲染图片时能正确解析相对路径
        // React useEffect 执行顺序是子组件先于父组件，若依赖 useEffect 设置 currentDocPath，
        // EditorContainer 的 useEffect（更新 ProseMirror）会先执行，导致图片用旧路径渲染失败
        if (detail.path) {
          setCurrentDocPath(detail.path);
        }
        // 只通过 React 状态更新编辑器内容，避免双重 dispatch
        // EditorContainer 的 useEffect([content, forceUpdateKey]) 会统一处理 ProseMirror 更新
        setContent(targetContent);
        safeSetItem("lightmd-content", targetContent);
        setForceUpdateKey((k) => k + 1);
        // v0.7.0 bug修复：重新打开文件时清除浏览进度（从文件树点击 = 重新打开，重置到顶部）
        // v0.8.0 修复 P11-7：已打开的文件属于"切回标签"，浏览进度应保留
        // v0.8.3 WP4 需求6：启动恢复期间不清除——否则刚注入的跨会话进度会被当场清掉
        if (detail.path && !alreadyOpen && !sessionRestoringRef.current) {
          fileScrollProgress.clear(detail.path);
        }

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
          // 已打开：沿用标签的 dirty 状态；首次打开：新标签且非脏
          const wasDirty = alreadyOpen ? !!st0.openTabs[existingIdx].isDirty : false;
          addTab({ path: detail.path, name: fileName, content: targetContent, isDirty: wasDirty });
          // 显式更新标签页 content（使用标签内内容，避免覆盖未保存编辑）
          const { activeTabIdx: newIdx } = useEditorStore.getState();
          updateTabContent(newIdx, targetContent);
          // 切换回已修改的文件时标题栏/标签保持脏标记
          setDirty(wasDirty);
          addRecentFile({
            path: detail.path,
            name: fileName,
          });
          // v0.8.2：「打开的文件」栏条目改由 openTabs 统一同步（见 FileTree 的
          // syncTempFilesWithTabs effect）——不再按"是否在打开文件夹下"分流，
          // 否则文件夹内打开的文件、另存为晋升的文件不会出现在栏里，
          // 造成"栏条目数 ≠ 标签数"。

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
  }, [openFile, addRecentFile, setViewMode, setCurrentLanguage, t]);

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
          // v0.7.0 bug修复：关闭标签清除浏览进度（关闭后再打开 = 重新打开，重置到顶部）
          // v0.8.3 WP4 需求6：未落盘标签按 untitled:<id> 键清理（path 为空串，
          // 走 path 分支的 clear 会因空串被 fileScrollProgress 直接忽略）
          fileScrollProgress.clear(closedTab.path || untitledProgressKey(closedTab.id));
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
          // v0.8.0 修复 P11-2：临时文档（path 为空）按 markdown 处理
          const lang = !tab.path || isMarkdownFile(tab.path) ? "markdown" : getFileLanguage(tab.path);
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

  // ─── v0.8.0 WP1：临时标签内容持久化 ──────────────────────────
  // 需求：临时文件只有用户自行保存才落盘，但其编辑内容需在下次启动时恢复。
  // 做法：openTabs 变化后防抖写入 localStorage；窗口关闭前再强制冲刷一次，
  // 避免"最后一次输入后立刻退出"丢失内容。
  // v0.8.3 WP4 需求5：同一节奏顺带记录"上次活跃标签"（deps 增加 activeTabIdx——
  // 仅切标签时 openTabs 引用不变，不加依赖会漏记）。
  const untitledSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (untitledSaveTimerRef.current) clearTimeout(untitledSaveTimerRef.current);
    untitledSaveTimerRef.current = setTimeout(() => {
      const st = useEditorStore.getState();
      // v0.8.0 修复 P2-1：与启动恢复共用开关——关闭时既不写入，也清掉历史残留，
      // 避免"设置里关了恢复，内容却一直留在 localStorage"
      if (!isUntitledRestoreEnabled()) {
        clearUntitledTabs();
        // v0.8.3：开关关闭时上次活跃记录同样清理（无消费方，避免残留误导）
        clearLastActiveTab();
        return;
      }
      saveUntitledTabs(st.openTabs);
      saveLastActiveTab(st.openTabs[st.activeTabIdx] ?? null);
    }, 400);
    return () => {
      if (untitledSaveTimerRef.current) clearTimeout(untitledSaveTimerRef.current);
    };
  }, [openTabs, activeTabIdx]);

  useEffect(() => {
    const flush = () => {
      const st = useEditorStore.getState();
      if (!isUntitledRestoreEnabled()) {
        clearUntitledTabs();
        clearLastActiveTab();
        return;
      }
      saveUntitledTabs(st.openTabs);
      // v0.8.3 WP4 需求5：关闭前记录最后一次活跃标签（最可靠的一次写入）
      saveLastActiveTab(st.openTabs[st.activeTabIdx] ?? null);
    };
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, []);

  // ─── v0.8.3 WP4 需求6：浏览进度跨会话快照 ──────────────────────
  // 写路径：5s 心跳 + 窗口关闭前冲刷；且仅在"进度确实变化"（revision 变化）时
  // 才真正写 localStorage。滚动本身仍是内存 Map.set，**零新增开销**。
  // 不采用"依赖 openTabs 的防抖"：openTabs 每次击键都会变（updateTabContent），
  // 防抖会被无限重置 → 持续输入时快照永不落盘。
  useEffect(() => {
    const snapshot = () => {
      if (!isUntitledRestoreEnabled()) {
        fileScrollProgress.clearAll();
        return;
      }
      if (!fileScrollProgress.hasUnsavedChanges()) return;
      fileScrollProgress.saveSnapshot(tabsProgressKeys(useEditorStore.getState().openTabs));
    };
    const timer = setInterval(snapshot, 5000);
    window.addEventListener("beforeunload", snapshot);
    return () => {
      clearInterval(timer);
      window.removeEventListener("beforeunload", snapshot);
    };
  }, []);

  // ─── v0.8.0 WP1：启动恢复临时标签 ──────────────────────────
  // 与 restoreRecentFiles 同一开关（loadLastFileOnStartup）；直接读 localStorage
  // 判定开关，避免 zustand persist hydration 时机问题。恢复的标签排在正式文件之前。
  const startupUntitledRestoreRef = useRef(false);
  useEffect(() => {
    if (startupUntitledRestoreRef.current) return;
    startupUntitledRestoreRef.current = true;
    // v0.8.0 修复 P2-1：与写盘共用同一开关判定（直接读 localStorage，避免 hydration 时机问题）
    if (!isUntitledRestoreEnabled()) {
      // v0.8.3 WP4 需求6：开关关闭 → 不恢复文件，也不留下 scroll-progress 残留
      fileScrollProgress.clearAll();
      return;
    }
    // v0.8.3 WP4 需求6：先把跨会话的浏览进度注入内存 Map，
    // 供随后的恢复流程（EditorContainer 的 forceUpdateKey 恢复 effect）消费。
    fileScrollProgress.loadSnapshot();
    const stored = loadUntitledTabs();
    if (stored.length === 0) return;
    const { addTab } = useEditorStore.getState();
    for (const item of stored) {
      addTab({
        id: item.id,
        path: "",
        name: item.name,
        content: item.content,
        isUntitled: true,
        // 内容未落盘 → 视为未保存，关闭时需确认
        isDirty: item.content.length > 0,
      });
    }
    // 激活首个临时标签，并同步编辑器内容
    const { openTabs: tabs, setActiveTab, openFile } = useEditorStore.getState();
    if (tabs.length > 0) {
      setActiveTab(0);
      setContent(tabs[0].content || "");
      safeSetItem("lightmd-content", tabs[0].content || "");
      openFile(null);
      setCurrentDocPath("");
      setForceUpdateKey((k) => k + 1);
    }
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
          /**
           * v0.8.3 WP4 需求5：激活上次会话结束时的活跃标签。
           *
           * 旧实现写死"第一个恢复成功的真实文件"（v0.8.0 修复 P1-4），从不参考上次
           * 会话活跃的是哪个标签 → 用户关闭前停留在临时文件时，重启后被强制切到真实
           * 文件，感知为"载入上次打开的文件对临时文件不生效"。
           *
           * 现在优先按 lightmd-last-active-tab 定位（临时标签按 id、真实文件按 path）；
           * 记录缺失/对应标签不存在时回退到既有逻辑（第一个真实文件），
           * 保证旧会话数据与"首次启动"行为不变。
           */
          const lastActiveIdx = resolveLastActiveIndex(loadLastActiveTab(), openTabs);
          const targetIdx = lastActiveIdx !== -1
            ? lastActiveIdx
            // v0.8.0 修复 P1-4：临时（untitled）标签先于正式文件恢复，占用了 openTabs 前部。
            // 激活目标应是"第一个恢复成功的真实文件"，不能写死 openTabs[0]——
            // 否则临时标签会抢占活跃位，并把 currentDocPath 清空。
            : openTabs.findIndex((tb) => !tb.isUntitled && tb.path);
          if (targetIdx !== -1) {
            const targetTab = openTabs[targetIdx];
            setActiveTab(targetIdx);
            // 同步 content 和 filePath；真实文件同步设置 currentDocPath 确保图片渲染正确
            // （v0.8.3：临时标签的 path 为空串，setCurrentDocPath("") 清空即可）
            setCurrentDocPath(targetTab.path || "");
            setContent(targetTab.content || "");
            safeSetItem("lightmd-content", targetTab.content || "");
            openFile(targetTab.path || null);
            // v0.4.0：启动恢复时同步语言标识（v0.8.0 修复 P11-2：临时文档按 markdown 处理）
            const lang = !targetTab.path || isMarkdownFile(targetTab.path) ? "markdown" : getFileLanguage(targetTab.path);
            setCurrentLanguage(lang);
            setForceUpdateKey((k) => k + 1);
          }
        }
      } catch (err) {
        console.warn("[启动恢复] 文件恢复失败:", err);
      } finally {
        // v0.8.3 WP4 需求6：恢复期结束——此后 lightmd:openFile 的"重新打开清进度"
        // 语义恢复正常（用户在恢复完成后主动打开文件仍会重置到顶部）。
        sessionRestoringRef.current = false;
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
          // v0.8.4 需求10：恢复成功的文件夹补注册 watcher（启动恢复不走 openFolderAt）；
          // 失败静默（startupRestore 内已 catch），可用工具栏刷新兜底
          watchFolder: (path) => fileService.watchFolder(path),
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
  // v0.8.0 WP3 需求8：支持可选 targetTab（默认当前活跃标签）。
  // 右键菜单"另存为"会先 setActiveTab 到目标标签再调用，保证上下文一致；
  // 指定 targetTab 时直接使用其 content，避免依赖尚未同步的编辑区内容。
  const handleSaveAsFile = useCallback(async (targetTab?: TabInfo) => {
    const view = editorViewRef.current;
    if (!view) return;

    const { openTabs, activeTabIdx, getTabById, getTabByPath } = useEditorStore.getState();
    const isTargeted = !!targetTab;
    const tab = targetTab ?? openTabs[activeTabIdx];
    if (!tab) return;

    let markdown: string;
    if (isTargeted) {
      // 指定标签：直接取其已同步的 content（最可靠，不依赖当前编辑区）
      markdown = tab.content ?? "";
    } else {
      // 默认：按当前模式从编辑区取内容（与 handleSaveFile 一致）
      const { getMarkdownFromDoc } = await import("./core/editor");
      const currentMode = useEditorStore.getState().viewMode;
      const isSourceMode = currentMode === "edit" || currentMode === "split";
      markdown = isSourceMode ? contentRef.current : getMarkdownFromDoc(view.state.doc);
    }

    // 计算目标标签在 openTabs 中的下标（用于清除脏标记 / 晋升）
    const resolveIdx = (t: TabInfo): number =>
      t.isUntitled && t.id ? getTabById(t.id) : getTabByPath(t.path);

    if (isTauri()) {
      try {
        const selected = await save({
          defaultPath: getFileName(tab.path || t("app.unnamed")),
          filters: [{ name: t("app.markdownFilter"), extensions: ["md"] }],
        });
        if (selected) {
          await fileService.writeFile(selected, markdown);
          openFile(selected);
          setDirty(false);
          // 清除当前标签页的脏标记（修复：另存为后小蓝点未消失）
          const idx = isTargeted ? resolveIdx(tab) : activeTabIdx;
          if (idx !== -1) updateTabDirty(idx, false);
          // v0.8.0 WP1：临时标签保存成功后晋升为正式文件（写真实路径、清 isUntitled/id），
          // 此后自动保存与版本快照对该标签恢复正常生效
          if (idx !== -1) {
            // v0.8.3 WP4 需求6：进度键从 untitled:<id> 迁移到新路径，
            // 否则"刚保存就跳回文档顶部"
            const oldTab = useEditorStore.getState().openTabs[idx];
            fileScrollProgress.move(untitledProgressKey(oldTab?.id), selected);
            useEditorStore.getState().promoteTab(idx, selected, getFileName(selected));
          }
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
      a.download = getFileName(tab.path || t("app.unnamed"));
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      // 清除当前标签页的脏标记（修复：浏览器环境保存后小蓝点未消失）
      const idx = isTargeted ? resolveIdx(tab) : activeTabIdx;
      if (idx !== -1) updateTabDirty(idx, false);
    }
  }, [openFile, setDirty, addRecentFile, updateTabDirty, t]);

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

  // ─── 新建临时文件（Ctrl+N / 标签栏空白双击 / 侧栏"新增文件"）──
  // v0.8.0 WP1：不再直接落盘/弹另存为对话框，改为创建临时（未落盘）标签。
  // 临时标签 path 为空串 → 自动保存与版本快照天然跳过；用户 Ctrl+S 时走
  // handleSaveAsFile 选择路径，保存成功后再晋升为正式文件（promoteTab）。
  //
  // v0.8.0 修复 P2：把"创建 + 同步编辑器上下文"抽成 createUntitledTabAndSync。
  // 旧实现里标签栏双击只调了 store.createUntitledTab()，没有同步 content /
  // filePath / forceUpdateKey，导致新建后既不跳转也无法编辑。
  const createUntitledTabAndSync = useCallback(() => {
    useEditorStore.getState().createUntitledTab();
    const { openTabs: tabs, activeTabIdx: idx } = useEditorStore.getState();
    const newTab = tabs[idx];
    setContent(newTab?.content ?? "");
    safeSetItem("lightmd-content", newTab?.content ?? "");
    // 无路径：自动保存/快照/最近文件等按路径生效的逻辑全部跳过
    openFile(null);
    setDirty(false);
    setCurrentDocPath("");
    setForceUpdateKey((k) => k + 1);
    // v0.8.0 修复 P2：立即持久化临时标签，保证"启动恢复上次打开文件"能拿到最新内容
    saveUntitledTabs(useEditorStore.getState().openTabs);
    // v0.8.0 修复 P11-2：新建后聚焦编辑器，用户可直接输入（无需先点一下编辑区）。
    // 双 rAF 等 ProseMirror 完成内容替换后再聚焦，避免焦点被随后的渲染抢走。
    requestAnimationFrame(() => {
      requestAnimationFrame(() => editorViewRef.current?.focus());
    });
  }, [openFile, setDirty]);

  const handleNewFile = useCallback(async () => {
    if (isDirty && filePath) {
      if (!window.confirm(t("app.confirmNewWithUnsaved"))) {
        return;
      }
    }
    createUntitledTabAndSync();
  }, [filePath, isDirty, createUntitledTabAndSync, t]);

  // v0.8.0 修复 P2：无需确认的新建入口（标签栏空白处双击）——
  // 切换标签时当前内容已存入原标签，不会丢内容，故不打断操作流程
  const handleNewUntitled = useCallback(() => {
    createUntitledTabAndSync();
  }, [createUntitledTabAndSync]);

  // ─── 新建文件夹 ──────────────────────────────
  // v0.8.2 修复：标题栏「新建 > 新建文件夹」改为派发命令，由侧栏（FileTree）
  // 打开应用内 NewFolderDialog（输入名称 + 勾选已打开文件夹或自定义路径，弹框居中）。
  // 旧实现走原生 prompt() + 保存对话框：既不是应用内弹框，也无法选择目标路径，
  // 表现为"点击新建文件夹没反应"。
  const handleNewFolder = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent("lightmd:command", { detail: { id: "filetree.newFolder" } })
    );
  }, []);

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
    // v0.8.0 WP1：临时标签（path 为空）不参与 recentFiles / 滚动进度 / 左侧临时文件列表
    if (tab.path) {
      // v0.4.5 修复：同步从 recentFiles 中移除，避免下次启动时恢复已被用户关闭的文件
      useFileStore.getState().removeRecentFile(tab.path);
      // v0.7.0 bug修复：关闭标签清除浏览进度（关闭后再打开 = 重新打开，重置到顶部）
      fileScrollProgress.clear(tab.path);
      // 同步移除左侧"打开的文件"中的临时文件
      const { tempFiles } = useFileStore.getState();
      if (tempFiles.some(f => f.path === tab.path)) {
        useFileStore.getState().removeTempFile(tab.path);
      }
    } else if (tab.isUntitled) {
      // v0.8.3 WP4 需求6：未落盘标签的进度键是 untitled:<id>，关闭时按同一键清理
      fileScrollProgress.clear(untitledProgressKey(tab.id));
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

  // ─── v0.8.0 WP3 需求8：批量关闭标签 ──
  // 接收待关闭下标数组（已排除固定标签/目标标签、已确认过未保存项），
  // 复用 handleTabClose 的清理逻辑（recentFiles / 滚动进度 / 临时文件列表），
  // 最后统一同步编辑器内容到新的活跃标签，保持与关闭单个标签一致的行为。
  const handleCloseMany = useCallback((indices: number[]) => {
    const sorted = [...indices].sort((a, b) => b - a); // 从后往前关，避免索引漂移
    for (const i of sorted) {
      const tab = useEditorStore.getState().openTabs[i];
      if (!tab) continue;
      if (tab.path) {
        // v0.4.5 修复：同步从 recentFiles 中移除
        useFileStore.getState().removeRecentFile(tab.path);
        // v0.7.0 bug修复：关闭标签清除浏览进度
        fileScrollProgress.clear(tab.path);
        // 同步移除左侧"打开的文件"中的临时文件
        const { tempFiles } = useFileStore.getState();
        if (tempFiles.some((f) => f.path === tab.path)) {
          useFileStore.getState().removeTempFile(tab.path);
        }
      } else if (tab.isUntitled) {
        // v0.8.3 WP4 需求6：未落盘标签按 untitled:<id> 键清理进度
        fileScrollProgress.clear(untitledProgressKey(tab.id));
      }
      closeTab(i);
    }
    // 同步编辑器内容到新的活跃标签
    const st = useEditorStore.getState();
    const active = st.openTabs[st.activeTabIdx];
    if (active) {
      setContent(active.content || "");
      safeSetItem("lightmd-content", active.content || "");
      openFile(active.path);
      setDirty(active.isDirty || false);
    } else {
      setContent("");
      safeSetItem("lightmd-content", "");
      openFile(null);
      setDirty(false);
    }
    setForceUpdateKey((k) => k + 1);
  }, [closeTab, openFile, setDirty]);

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
      // v0.4.0 功能4：打开版本快照窗口
      // v0.8.0 WP2 需求1：快捷键由 Ctrl+Shift+V 改为 Ctrl+Alt+V
      // （Ctrl+Shift+V 与"粘贴"的语义冲突，且 v0.8.0 引入文件复制/粘贴后更易误触）
      if (e.ctrlKey && e.altKey && e.key.toLowerCase() === "v") {
        e.preventDefault();
        const { openTabs, activeTabIdx } = useEditorStore.getState();
        const activeTab = openTabs[activeTabIdx];
        // v0.8.0 WP1：临时（未落盘）文件没有版本快照，直接忽略
        if (activeTab && activeTab.path) {
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
      // v0.7.5 功能1：Ctrl+K（macOS 为 Cmd+K）打开 AI 对话浮动窗。
      // 已全文确认 Mod-k / Ctrl+K 无其他绑定（链接插入走工具栏与智能粘贴，无快捷键）。
      // 注意大小写（Caps Lock 下 key 为 "K"）与输入法组合态（isComposing 时 Enter/字母
      // 用于选词，不能当快捷键）。
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        !e.altKey &&
        (e.key === "k" || e.key === "K") &&
        !e.isComposing
      ) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "ai.chat" } }));
        return;
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
    const { openTabs, activeTabIdx, getTabByPath, getTabById } = useEditorStore.getState();
    // 保存当前标签的内容（activeTabIdx 此时仍是旧标签的索引）
    if (openTabs[activeTabIdx]) {
      updateTabContent(activeTabIdx, contentRef.current);
    }
    // 切换到目标标签
    // v0.8.0 WP1：临时标签的 path 恒为空串，按 path 查找会永远命中第一个临时标签，
    // 故临时标签按 id 定位
    const targetIdx = tab.isUntitled && tab.id ? getTabById(tab.id) : getTabByPath(tab.path);
    if (targetIdx !== -1) {
      setActiveTab(targetIdx);
    }
    // v0.8.3 WP4 需求5：显式记录活跃标签（临时标签按 id / 真实文件按 path）。
    // 不依赖任何 effect 链——切标签时 openTabs 引用不变，防抖 effect 未必触发，
    // 而"上次活跃标签"必须在每次切换时都是最新的，否则重启后定位错误。
    saveLastActiveTab(tab);
    // 加载目标标签内容
    setContent(tab.content || "");
    safeSetItem("lightmd-content", tab.content || "");
    openFile(tab.path);
    // v0.4.0：切换标签时同步语言标识，确保代码文件正确高亮
    // v0.8.0 修复 P11-2：临时文档（path 为空）按 markdown 处理
          const lang = !tab.path || isMarkdownFile(tab.path) ? "markdown" : getFileLanguage(tab.path);
    setCurrentLanguage(lang);
    setDirty(tab.isDirty || false);
    setForceUpdateKey((k) => k + 1);
  }, [openFile, setDirty, updateTabContent, setActiveTab, setCurrentLanguage]);

  // ─── v0.8.0 WP2 修复2：文件被删除后联动关闭对应标签 ──────────
  // 旧逻辑：侧栏删除文件只 refreshTree，已打开的标签仍停留在编辑器里（幽灵标签）。
  // 此处按路径（含被删文件夹下的所有文件）关闭匹配标签，不做脏确认——文件已不存在，
  // 失去确认的意义，用户删除时已经确认过一次。
  const closeTabsByPath = useCallback((deletedPath: string) => {
    if (!deletedPath) return;
    const { openTabs, closeTab } = useEditorStore.getState();
    // 先算出全部待关标签下标，再从后往前关闭（避免关闭过程中索引漂移）
    const toClose = collectTabsToClose(openTabs.map((tb) => tb.path), deletedPath);
    for (let k = toClose.length - 1; k >= 0; k--) {
      const i = toClose[k];
      const p = openTabs[i]?.path;
      closeTab(i);
      if (p) {
        useFileStore.getState().removeRecentFile(p);
        fileScrollProgress.clear(p);
        const { tempFiles } = useFileStore.getState();
        if (tempFiles.some((f) => f.path === p)) useFileStore.getState().removeTempFile(p);
      }
    }
    // 同步编辑器内容到新的活跃标签
    const st = useEditorStore.getState();
    const active = st.openTabs[st.activeTabIdx];
    if (active) {
      setContent(active.content || "");
      safeSetItem("lightmd-content", active.content || "");
      openFile(active.path);
      setDirty(active.isDirty || false);
    } else {
      setContent("");
      safeSetItem("lightmd-content", "");
      openFile(null);
      setDirty(false);
    }
    setForceUpdateKey((k) => k + 1);
  }, [openFile, setDirty]);

  // ─── v0.8.0 WP1：侧栏"打开的文件"中的临时标签点击/关闭 ──────────
  // 临时标签没有磁盘路径，无法复用 handleSelectFile（按路径打开），
  // 故由侧栏派发 tab.activate / tab.close 命令，走与标签栏一致的切换/关闭逻辑。
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const { openTabs } = useEditorStore.getState();
      if (detail?.id === "tab.activate") {
        const tab = openTabs[detail.index];
        if (tab) handleTabSwitch(tab);
      } else if (detail?.id === "tab.close") {
        const tab = openTabs[detail.index];
        if (tab) handleTabClose(tab, detail.index);
      } else if (detail?.id === "file.deleted" && typeof detail.path === "string") {
        // v0.8.0 WP2 修复2：文件/文件夹被删除 → 关闭对应标签
        closeTabsByPath(detail.path);
      }
      // v0.8.2 调整：「打开的文件」栏去掉标题栏关闭按钮，temp.closeAll 命令随之移除——
      // 该栏随文件数据自动出现/消失（所有文件都关闭后自动隐藏）
    };
    window.addEventListener("lightmd:command", handler);
    return () => window.removeEventListener("lightmd:command", handler);
  }, [handleTabSwitch, handleTabClose, closeTabsByPath]);

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
        onSaveAs={handleSaveAsFile}
        onCloseMany={handleCloseMany}
        onNewUntitled={handleNewUntitled}
      />
      <AppShell
        sidebar={<FileTree />}
        outline={
          // v0.4.5 修复：仅 md 文件才显示大纲，切换至非 md 文件时自动关闭大纲栏
          // v0.8.0 修复 P11-2：临时文档（filePath 为空）按 markdown 处理，同样显示大纲
          showOutline && (!filePath || isMarkdownFile(filePath))
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
      {/* v0.4.0 功能4：版本快照窗口（v0.8.0 起快捷键为 Ctrl+Alt+V） */}
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
