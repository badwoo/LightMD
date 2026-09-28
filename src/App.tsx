import { useState, useEffect, useCallback, useRef } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useSettingsStore, THEMES, type Theme } from "./stores/useSettingsStore";
import { useEditorStore, type TabInfo } from "./stores/useEditorStore";
import { useFileStore } from "./stores/useFileStore";
// v0.9.0 WP0：窗口身份（label）与窗口级运行时状态
import { useWindowStore } from "./stores/useWindowStore";
import { getWindowLabel, isMainWindow, MAIN_WINDOW_LABEL } from "./utils/windowLabel";
import { windowService, type WindowSession } from "./services/windowService";
import { evaluateOpenConflict } from "./services/openConflict";
import { decideStartupMode, shouldEndRestoreWindowOnBoot, type StartupMode } from "./services/startupMode";
import { setupBroadcastListeners } from "./utils/broadcast";
import {
  clearSlotResidue,
  readWindowContent,
  CONTENT_KEY_BASE,
  LAST_FILE_KEY_BASE,
} from "./utils/windowSlot";
import { ChoiceDialog, type ChoiceOption } from "./components/dialogs/ChoiceDialog";
import { notify, notifyError } from "./services/notificationService";
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
// v0.9.0 第二轮修复（问题3）：自身写盘内容指纹——抑制 watcher 回声被误判为外部修改
import { isSelfWrittenContent } from "./services/selfWriteGuard";
import { safeSetItem } from "./utils/safeStorage";
// v0.8.0 WP1：临时（未落盘）标签的持久化与启动恢复
import { loadUntitledTabs, saveUntitledTabs, clearUntitledTabs, isUntitledRestoreEnabled } from "./utils/untitledTabs";
// v0.8.3 WP4 需求5：上次会话活跃标签的持久化（临时文件也能被正确定位）
import { saveLastActiveTab, loadLastActiveTab, resolveLastActiveIndex, clearLastActiveTab } from "./utils/lastActiveTab";
// v0.8.3 WP4 需求6：浏览进度的标签键（真实文件 = path，临时标签 = untitled:<id>）
import { tabsProgressKeys, untitledProgressKey } from "./utils/tabKey";
// v0.8.0 WP2 修复2：删除文件后按路径关闭匹配标签
import { collectTabsToClose } from "./utils/tabCleanup";
import { preserveEol } from "./utils/eolPreserve";
import { setCurrentDocPath } from "./utils/imagePath";
import { isSupportedTextFile, isMarkdownFile, ALL_SUPPORTED_EXTENSIONS, HUGE_FILE_THRESHOLD, getFileLanguage } from "./utils/constants";
import { evalDoublePress } from "./utils/modeSwitch";
import { pathCompareKey } from "./utils/path";
import { unwrapTargetedEvent } from "./utils/targetedEvent";
import { markListenerReady, markListenerFailed, noteEventReceived } from "./utils/e2eProbe";
import { tabsNeedingCloseConfirm } from "./utils/dirtyTabs";
import {
  setNotificationHandler,
  type Notification,
} from "./services/notificationService";
import { useT } from "./i18n";
import type { EditorView } from "prosemirror-view";
import "./App.css";

// ─── v0.9.0：窗口级 key 与窗口身份常量 ──────────────────────────
/** 本窗口的「当前内容」scratch key（main 无后缀 = v0.8.5 旧 key） */
const CONTENT_KEY = getWindowLabel() === MAIN_WINDOW_LABEL
  ? CONTENT_KEY_BASE
  : `${CONTENT_KEY_BASE}-${getWindowLabel()}`;
/** 本窗口的「最近打开的文件路径」key */
const LAST_FILE_KEY = getWindowLabel() === MAIN_WINDOW_LABEL
  ? LAST_FILE_KEY_BASE
  : `${LAST_FILE_KEY_BASE}-${getWindowLabel()}`;
/** 启动恢复模式：null = 等待窗口引导决定 */
type StartupModeState = StartupMode | null;

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
      // v0.9.0：辅助窗口不继承主窗口的 scratch 内容——它的启动内容来自窗口引导
      // （会话恢复的标签 / 指定打开的文件），提前读入主窗口内容会导致闪一下再被覆盖。
      if (!isMainWindow()) return "";
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
      return readWindowContent(CONTENT_KEY);
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

  // ─── v0.9.0 多窗口：启动恢复模式 + 决策对话框状态 ──────────────────────────
  /**
   * 启动恢复模式（由「窗口引导」异步决定后置位）：
   * - `null`：尚未决定（主窗口等待 `take_window_boot` 的结果）
   * - `legacy`：v0.8.5 路径（临时标签 → 最近文件 → 活跃标签 → 最近文件夹）
   * - `session`：按 session.json 精确恢复（多窗口会话）
   * - `skip`：不恢复任何标签（辅助窗口自行处理 / 用户关闭了恢复开关）
   */
  const [startupMode, setStartupMode] = useState<StartupModeState>(isMainWindow() ? null : "skip");
  /** 本窗口引导数据（挂载后取一次；`restore`/`fresh` 供启动分流使用） */
  const bootRef = useRef<{ restore: boolean; fresh: boolean; files: string[] } | null>(null);
  /**
   * v0.9.0 WP9：冲突检测抑制标志。
   * 启动恢复 / 会话恢复 / 跨窗口迁移期间不弹冲突框（这些场景下的"同时打开"
   * 是用户上次的合法状态，不是新冲突）。
   */
  const suppressConflictCheckRef = useRef(true);
  /**
   * v0.9.0 WP9：打开文件前的冲突决策函数（实现见下方，用 ref 转发以避免
   * `lightmd:openFile` 监听 effect 依赖它而反复重建监听）。
   */
  const resolveOpenConflictRef = useRef<
    (path: string, name?: string) => Promise<"ok" | "readonly" | "cancel">
  >(async () => "ok");
  /**
   * v0.9.0 WP2：窗口命令入口（快捷键 / 命令面板 / 标题栏菜单共用）。
   * 用 ref 转发：这些 handler 定义在下方（依赖大量后置回调），而快捷键监听
   * effect 必须早注册且不因依赖变化反复重建。
   */
  const windowCommandsRef = useRef<{
    newWindow: () => void;
    closeWindow: () => void;
    openInNewWindow: () => void;
    mergeToPrimary: () => void;
    quitApp: () => void;
  }>({
    newWindow: () => {},
    closeWindow: () => {},
    openInNewWindow: () => {},
    mergeToPrimary: () => {},
    quitApp: () => {},
  });
  /** v0.9.0 WP2：标签切换（跨窗口「激活标签」事件用；定义在组件尾部，故用 ref 转发） */
  const handleTabSwitchRef = useRef<(tab: TabInfo) => void>(() => {});
  /** v0.9.0 WP9：按路径关闭标签（文件被删除联动用；定义在组件尾部，故用 ref 转发） */
  const closeTabsByPathRef = useRef<(deletedPath: string) => void>(() => {});

  /**
   * v0.9.0：统一的决策对话框状态。
   *
   * 用 Promise resolve 模式把「弹框 → 等用户选择」写成同步风格的 await，
   * 避免为每处交互各写一套 state + effect 通道。
   */
  type PendingDialog = {
    kind: "conflict" | "askOpen" | "closeConfirm" | "externalSave" | "mergeOffer";
    name: string;
    detail: string;
    options: ChoiceOption[];
    resolve: (v: string) => void;
  };
  const [pendingDialog, setPendingDialog] = useState<PendingDialog | null>(null);
  /** 弹决策框并等待用户选择；组件卸载时按「取消」语义解析，避免 Promise 悬挂 */
  const askChoice = useCallback(
    (
      kind: PendingDialog["kind"],
      name: string,
      detail: string,
      options: ChoiceOption[],
    ): Promise<string> =>
      new Promise<string>((resolve) => {
        setPendingDialog({ kind, name, detail, options, resolve } as PendingDialog);
      }),
    [],
  );
  const closePendingDialog = useCallback(
    (choice: string) => {
      setPendingDialog((cur) => {
        cur?.resolve(choice);
        return null;
      });
    },
    [],
  );

  // 是否为源码编辑类模式（edit 或 split）
  const isSourceMode = viewMode === "edit" || viewMode === "split";
  /** v0.9.0 WP9：当前活跃标签是否只读（标题栏标记 + 编辑器可编辑性） */
  const activeIsReadonly = useEditorStore((s) => !!s.openTabs[s.activeTabIdx]?.isReadonly);

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
        // v0.9.0 WP9：打开前做跨窗口冲突检测（同一文件在其他窗口有未保存修改）。
        // detail.skipConflictCheck = 启动恢复/跨窗口迁移等"已知合法"场景跳过检查。
        let openReadonly = !!detail.presetReadonly;
        if (detail.path && !detail.skipConflictCheck && !suppressConflictCheckRef.current) {
          const decision = await resolveOpenConflictRef.current(detail.path, detail.name);
          if (decision === "cancel") return;
          if (decision === "readonly") openReadonly = true;
        }
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
        safeSetItem(CONTENT_KEY, targetContent);
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
          safeSetItem(LAST_FILE_KEY, detail.path);
          // 文件名优先使用 detail.name（来自 FileTree 的 node.name），避免路径解析得到目录名
          const fileName = detail.name || getFileName(detail.path);
          // 已打开：沿用标签的 dirty 状态；首次打开：新标签且非脏
          const wasDirty = alreadyOpen ? !!st0.openTabs[existingIdx].isDirty : false;
          addTab({ path: detail.path, name: fileName, content: targetContent, isDirty: wasDirty });
          // 显式更新标签页 content（使用标签内内容，避免覆盖未保存编辑）
          const { activeTabIdx: newIdx } = useEditorStore.getState();
          updateTabContent(newIdx, targetContent);
          // v0.9.0 WP9：只读打开（冲突对话框选了「只读打开」，或会话恢复带来的只读态）
          if (openReadonly) {
            useEditorStore.getState().setTabReadonly(newIdx, true);
          }
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
        // v0.8.5 需求6：最近打开为纯历史记录，关闭标签不再从 recentFiles 中移除条目
        // （旧 v0.4.5 行为已废弃——关闭文件后历史条目保留，供下次快速找回）
        if (closedTab) {
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
          safeSetItem(CONTENT_KEY, tab.content || "");
          openFile(tab.path);
          // v0.4.0：切换到剩余标签时，根据其路径重新设置语言标识
          // v0.8.0 修复 P11-2：临时文档（path 为空）按 markdown 处理
          const lang = !tab.path || isMarkdownFile(tab.path) ? "markdown" : getFileLanguage(tab.path);
          setCurrentLanguage(lang);
          setForceUpdateKey((k) => k + 1);
        }
      } else {
        setContent("");
        safeSetItem(CONTENT_KEY, "");
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
  // v0.9.0 WP7：策略判断在前端（设置存在 localStorage，Rust 读不到 → F14）。
  // 用 ref 转发实现，避免监听 effect 依赖 t / 设置而反复重建。
  const openExternalFileRef = useRef<(p: string) => Promise<void>>(async () => {});
  useEffect(() => {
    if (!isTauri()) return;
    let unlistenArgv: (() => void) | null = null;
    let cancelled = false;

    const setupArgvListener = async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        // 监听 Rust 端发送的启动文件路径事件
        const un = await listen<{ target?: string; path?: string }>(
          "lightmd:openFileArgv",
          async (event) => {
            const payload = event.payload;
            // ⚠️ Tauri v2 的 emit_to 不能把事件限制在单个 webview 内（JS 监听器
            // 注册目标为 Any，会收到所有定向事件）——必须按 target 自行过滤，
            // 否则一次双击会让每个窗口都打开同一文件。
            if (payload?.target && payload.target !== getWindowLabel()) return;
            if (!payload?.path) return;
            await openExternalFileRef.current(payload.path);
          },
        );
        if (cancelled) un();
        else unlistenArgv = un;
      } catch (err) {
        console.error("设置文件关联监听失败:", err);
      }
    };

    setupArgvListener();
    return () => {
      cancelled = true;
      unlistenArgv?.();
    };
  }, []);

  /**
   * v0.9.0 WP7 N9：按 `openExternalFileIn` 策略打开外部文件。
   * 实现定义在下方多窗口区块（依赖 openFileByPath），此处只做 ref 转发。
   */

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
  // v0.9.0：仅 v0.8.5「legacy」启动模式执行（多窗口会话走 session.json 精确恢复）。
  const startupUntitledRestoreRef = useRef(false);
  useEffect(() => {
    if (startupMode !== "legacy") return;
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
      safeSetItem(CONTENT_KEY, tabs[0].content || "");
      openFile(null);
      setCurrentDocPath("");
      setForceUpdateKey((k) => k + 1);
    }
  }, [startupMode]);

  // ─── 启动载入上次打开的文件（F2：支持多文件恢复） ──────────────────────────
  // 仅在 Tauri 环境、开关开启、且非双击文件启动时载入上次文件
  // 双击文件启动时 lightmd:openFileArgv 事件会处理，此处通过 startupRef 避免重复
  // F2 改造：读取 loadLastFileCount（N），从 recentFiles 取前 N 条，串行打开
  // 问题8修复：恢复完成后显式切换到第一个文件（recentFiles[0]，即最后打开的文件）
  // v0.9.0：仅 v0.8.5「legacy」启动模式执行
  const startupRestoreRef = useRef(false);
  useEffect(() => {
    if (startupMode !== "legacy") return;
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
          // v0.8.5 需求6：恢复失败的文件（已被删除/移动）仅标 stale（⚠ 提示），
          // 不再从 recentFiles 中移除（最近打开 = 纯历史，永不删除）
          markRecentStale: (path) => {
            useFileStore.getState().markRecentStale(path);
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
            safeSetItem(CONTENT_KEY, targetTab.content || "");
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
  }, [startupMode]);

  // ─── 启动载入上次打开的文件夹（F3 / v0.4.0 多文件夹） ──────────────────────────
  // 在文件恢复之后执行（延迟 100ms 确保文件恢复完成）
  // v0.4.0：按 loadLastFolderCount 恢复多个文件夹，每个调用 addOpenFolder + updateFolderTree
  // v0.9.0：仅 v0.8.5「legacy」启动模式执行（多窗口会话的文件夹来自 session.json）
  const startupFolderRestoreRef = useRef(false);
  useEffect(() => {
    if (startupMode !== "legacy") return;
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
          // v0.8.5 需求6：恢复失败的文件夹（已被删除/移动）仅标 stale（⚠ 提示），
          // 不再从 recentFolders 中移除（最近打开 = 纯历史，永不删除）
          markRecentFolderStale: (path) => {
            useFileStore.getState().markRecentFolderStale(path);
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
  }, [startupMode]);

  // ═══════════════════════ v0.9.0 多窗口：窗口引导与跨窗口事件 ═══════════════════════

  /**
   * 打开一个文件（统一入口，供启动恢复 / 跨窗口迁移 / 指定文件打开复用）。
   * 走 `lightmd:openFile` 事件以复用既有全链路（标签去重、大文件降级、快照记录）。
   */
  const openFileByPath = useCallback(
    async (path: string, opts?: { name?: string; skipConflictCheck?: boolean; presetReadonly?: boolean }) => {
      const content = await fileService.readFile(path);
      window.dispatchEvent(
        new CustomEvent("lightmd:openFile", {
          detail: {
            path,
            name: opts?.name || getFileName(path),
            content,
            skipConflictCheck: opts?.skipConflictCheck,
            presetReadonly: opts?.presetReadonly,
          },
        }),
      );
    },
    [],
  );

  /**
   * 取「会话快照」并把标签恢复到本窗口（多窗口精确恢复，§3.5）。
   *
   * 顺序严格按快照的 tabs 顺序重建，保证活跃下标语义一致；
   * 临时标签内容来自本窗口自己的 localStorage key（快照只存 id/name）。
   * 真实文件读取失败（已被删除/移动）→ 标记 recentFiles 为 stale 并跳过。
   */
  const restoreFromSession = useCallback(
    async (session: WindowSession) => {
      const storedUntitled = loadUntitledTabs();
      const untitledById = new Map(storedUntitled.map((u) => [u.id, u]));
      const { addTab } = useEditorStore.getState();

      for (const tab of session.tabs) {
        if (tab.kind === "untitled") {
          const id = tab.untitledId;
          const stored = id ? untitledById.get(id) : undefined;
          // 内容已丢失（开关关闭过/被清理）→ 跳过，避免产生空壳标签
          if (!stored) continue;
          addTab({
            id: stored.id,
            path: "",
            name: stored.name || tab.name,
            content: stored.content,
            isUntitled: true,
            pinned: !!tab.pinned,
            isDirty: stored.content.length > 0,
          });
          continue;
        }
        const path = tab.path;
        if (!path) continue;
        try {
          await openFileByPath(path, {
            name: tab.name,
            skipConflictCheck: true,
          });
          if (tab.pinned) {
            const idx = useEditorStore.getState().getTabByPath(path);
            if (idx !== -1) useEditorStore.getState().togglePin(idx);
          }
        } catch {
          useFileStore.getState().markRecentStale(path);
        }
      }

      // 恢复活跃标签：优先按快照下标对应的标签身份定位（某些标签可能恢复失败）
      const target = session.tabs[session.activeTabIdx];
      const st = useEditorStore.getState();
      let targetIdx = -1;
      if (target) {
        targetIdx =
          target.kind === "untitled" && target.untitledId
            ? st.getTabById(target.untitledId)
            : target.path
              ? st.getTabByPath(target.path)
              : -1;
      }
      if (targetIdx === -1 && st.openTabs.length > 0) targetIdx = 0;
      if (targetIdx !== -1) {
        const tab = st.openTabs[targetIdx];
        st.setActiveTab(targetIdx);
        setCurrentDocPath(tab.path || "");
        setContent(tab.content || "");
        safeSetItem(CONTENT_KEY, tab.content || "");
        openFile(tab.path || null);
        setCurrentLanguage(
          !tab.path || isMarkdownFile(tab.path) ? "markdown" : getFileLanguage(tab.path),
        );
        setForceUpdateKey((k) => k + 1);
        if (tab.isReadonly) {
          useEditorStore.getState().setTabReadonly(targetIdx, true);
        }
      }
      // 恢复该窗口的打开文件夹列表（侧栏）
      for (const folder of session.folderPaths) {
        try {
          useFileStore.getState().addOpenFolder(folder);
          const { fileService: fs } = await import("./services/fileService");
          const entries = await fs.listDir(folder, { silent: true });
          useFileStore.getState().updateFolderTree(
            folder,
            entries.map((e) => ({
              name: e.name,
              path: e.path,
              isDir: e.is_dir,
              size: e.size,
              modifiedMs: e.modified_ms,
              createdMs: e.created_ms,
            })),
          );
          void fileService.watchFolder(folder).catch(() => undefined);
        } catch {
          useFileStore.getState().markRecentFolderStale(folder);
        }
      }
    },
    [openFileByPath, openFile, setCurrentLanguage],
  );

  /**
   * v0.9.0 WP7 N9：按 `openExternalFileIn` 策略打开外部文件（双击关联文件 / 命令行）。
   * - currentWindow：当前（Primary）窗口新标签打开（默认，v0.8.5 行为）
   * - newWindow：新建辅助窗口打开
   * - ask：弹应用内对话框三选一
   *
   * 策略失败（窗口已满等）时**降级为当前窗口打开**：不能因策略问题丢掉用户的双击操作。
   */
  const openExternalFile = useCallback(
    async (filePath: string) => {
      const strategy = useSettingsStore.getState().openExternalFileIn;
      const tryNewWindow = async (): Promise<boolean> => {
        try {
          await windowService.createWindow({ files: [filePath] });
          return true;
        } catch (err) {
          const msg = String((err as Error)?.message ?? err);
          notify(
            msg === "LIMIT"
              ? t("multiwindow.limitReached")
              : t("multiwindow.openToNewWindowFailed", { msg }),
            "warning",
          );
          return false;
        }
      };

      if (isTauri() && strategy === "newWindow") {
        if (await tryNewWindow()) return;
      } else if (isTauri() && strategy === "ask") {
        const choice = await askChoice(
          "askOpen",
          t("multiwindow.askOpen.title"),
          t("multiwindow.askOpen.message", { count: 1 }),
          [
            { id: "current", label: t("multiwindow.askOpen.current") },
            { id: "new", label: t("multiwindow.askOpen.new") },
          ],
        );
        if (choice === "cancel") return;
        if (choice === "new" && (await tryNewWindow())) return;
      }
      try {
        await openFileByPath(filePath);
      } catch (err) {
        console.error("文件关联打开失败:", err);
      }
    },
    [askChoice, openFileByPath, t],
  );
  useEffect(() => {
    openExternalFileRef.current = openExternalFile;
  }, [openExternalFile]);

  // ─── 窗口引导：取一次引导数据并决定启动恢复模式 ──────────────────────
  const bootDoneRef = useRef(false);
  useEffect(() => {
    if (bootDoneRef.current) return;
    bootDoneRef.current = true;
    let cancelled = false;
    (async () => {
      /**
       * 本窗口最终**实际生效**的恢复模式（见下方 v0.9.0 第二轮修复）。
       * - `effectiveMode`：会话快照里没有主窗口条目时回退为 `legacy`；
       * - `appliedMode`：真正 `setStartupMode` 成功的模式——只有它才能证明
       *   「legacy 恢复流程随后一定会跑」，据此决定是否在此处结束「恢复期」。
       */
      let effectiveMode: StartupMode = "skip";
      let appliedMode: StartupMode | null = null;
      // 无论启动流程成功或异常，都必须复位这两个标志：
      // 否则一次异常会让窗口永久停留在「恢复期」——冲突检测永不生效、
      // 首次打开文件不再重置浏览进度。
      try {
        // 全局状态广播（设置/文件库跨窗口同步）——幂等，StrictMode 双挂载安全
        void setupBroadcastListeners();
        const boot = await windowService.takeBoot();
        if (cancelled) return;
      bootRef.current = { restore: boot.restore, fresh: boot.fresh, files: boot.files };
      useWindowStore.getState().setPrimary(boot.isPrimary);
      // 槽位复用：清掉上一轮该槽位的窗口级残留（main 会被跳过，保护 v0.8.5 旧数据）
      if (boot.fresh) clearSlotResidue(boot.label);

      const enabled = isUntitledRestoreEnabled();
      const isMain = isMainWindow();
      const hasSession = enabled && (await windowService.hasSession());
      if (cancelled) return;
      // 启动分流决策（纯函数，见 services/startupMode.ts，单测覆盖三态）
      const mode = decideStartupMode({
        isMain,
        bootRestore: boot.restore,
        restoreEnabled: enabled,
        hasSession,
      });
      effectiveMode = mode;
      /** 是否需要在本次启动后注销遗留会话文件（走出「多窗口语义」） */
      let discardSession = false;

      if (mode === "session") {
        // ① 按 session.json 精确恢复本窗口的标签/打开文件夹
        fileScrollProgress.loadSnapshot();
        const session = await windowService.getWindowSession(boot.label);
        if (session && !cancelled) {
          await restoreFromSession(session);
        } else if (isMain && enabled && !cancelled) {
          // v0.9.0 第二轮修复（问题4）：会话快照里**没有主窗口条目**时不能让主窗口
          // 空着——旧版本「先关主窗口、再关辅助窗口」会写出这种残缺快照，用户重开
          // 软件看到的是"所有标签都被关闭了"（含临时文件）。
          // 回退到 v0.8.5 的恢复路径（最近文件 + 临时标签），至少把标签找回来。
          effectiveMode = "legacy";
        }
        if (isMain && !cancelled && effectiveMode === "session") {
          // v0.9.0（用户反馈）：是否连同其他窗口一起恢复由设置决定。
          // - 开启：重建会话快照里记录的辅助窗口；
          // - 关闭（默认）：只保留主窗口条目、裁掉快照里的辅助窗口，避免残留数据在
          //   下次开启开关时又复活一批早已关闭的窗口。
          //   ⚠ 只裁剪辅助窗口而不是整份丢弃：整份丢弃会把主窗口退回「最近文件」
          //   近似恢复（默认只回 1 个文件），用户感知为"标签变少/丢失"。
          if (useSettingsStore.getState().restoreOtherWindows) {
            await windowService.restoreWindows();
          } else {
            await windowService.pruneSecondarySessions();
          }
        }
      } else if (isMain) {
        // ② 不恢复：清掉遗留会话，保证纯单窗口用户回到 v0.8.5 语义
        discardSession = true;
        if (!enabled) {
          // REG-3：关闭「启动载入上次文件」→ 不恢复任何标签（含临时标签）
          fileScrollProgress.clearAll();
        }
      }
      if (discardSession && !cancelled) await windowService.discardSession();
      if (cancelled) return;

      // ③ 引导指定的文件（右键「在新窗口中打开」/ 外部文件策略「新窗口」）
      for (const f of boot.files) {
        try {
          await openFileByPath(f, { skipConflictCheck: true });
        } catch (err) {
          console.error("打开引导文件失败:", err);
        }
      }

      // ④ 跨窗口迁移过来的标签（「移动到新窗口」/「合并到主窗口」）
      for (const moved of boot.movedTabs) {
        if (moved.isUntitled || !moved.path) {
          useEditorStore.getState().addTab({
            id: moved.untitledId || undefined,
            path: "",
            name: moved.name,
            content: moved.content ?? "",
            isUntitled: true,
            pinned: !!moved.pinned,
            isDirty: !!moved.isDirty,
          });
        } else {
          try {
            await openFileByPath(moved.path, { name: moved.name, skipConflictCheck: true });
          } catch (err) {
            console.error("迁移标签失败:", err);
          }
        }
      }
      // 引导文件/迁移标签到达后即为活跃标签，需同步编辑器内容
      if (boot.files.length > 0 || boot.movedTabs.length > 0) {
        const st = useEditorStore.getState();
        const last = st.openTabs[st.activeTabIdx];
        if (last) {
          setCurrentDocPath(last.path || "");
          setContent(last.content || "");
          safeSetItem(CONTENT_KEY, last.content || "");
          openFile(last.path || null);
          setForceUpdateKey((k) => k + 1);
        }
      }

      if (cancelled) return;
      // ⑤ 决定 v0.8.5 遗留恢复路径是否执行（辅助窗口恒为 skip）
      //    v0.9.0 第二轮修复：以 effectiveMode 为准（会话残缺时回退 legacy），
      //    并把「真正置位」记录下来供 finally 判断恢复期由谁结束。
      if (isMain) {
        setStartupMode(effectiveMode);
        appliedMode = effectiveMode;
      }
      } catch (err) {
        // 启动流程异常也必须放行后续交互（否则窗口永久卡在「恢复期」）
        console.error("[启动] 窗口引导流程失败:", err);
      } finally {
        // v0.9.0 第二轮修复（问题1）：legacy 模式的恢复流程**在 setStartupMode 之后**
        // 才由下方「启动恢复临时标签 / 最近文件」两个 effect 启动，它们每次派发
        // lightmd:openFile 时都要靠 `sessionRestoringRef` 跳过「重新打开 → 清空浏览
        // 进度」分支。若在此处提前复位，刚 loadSnapshot 注入的跨会话阅读位置会被
        // 逐个清掉——用户感知为"重开软件后所有标签的阅读位置都重置了"。
        // 故 legacy 的复位交给「最近文件恢复」effect 的 finally（见下方），
        // 其余情况（含异常路径）必须在这里复位，否则窗口会永久停在恢复期。
        if (shouldEndRestoreWindowOnBoot(appliedMode)) {
          sessionRestoringRef.current = false;
        }
        // 冲突检测再延后一拍：等辅助窗口完成各自的上报，避免恢复期的假冲突
        setTimeout(() => {
          suppressConflictCheckRef.current = false;
        }, 1200);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── v0.9.0 WP5：跨窗口全局状态广播（订阅由 boot 流程启动，此处只做卸载清理） ──
  useEffect(() => {
    return () => {
      // 仅卸载时清理：广播订阅是进程级资源，组件卸载后不应继续持有
      void import("./utils/broadcast").then(({ teardownBroadcastListeners }) => teardownBroadcastListeners());
    };
  }, []);

  // ─── v0.9.0 WP3：窗口级文件夹列表（fileStore.openFolders 的规范化镜像） ────────
  // 内存态本已按窗口隔离，这里维护一份显式列表作为「上报会话快照 / 增删 watcher」的
  // 单一数据源，避免在各调用点分散判断。
  const openFoldersForMirror = useFileStore((s) => s.openFolders);
  const folderPathsMirror = useWindowStore((s) => s.folderPaths);
  useEffect(() => {
    const paths = openFoldersForMirror.map((f) => f.path);
    if (
      paths.length !== folderPathsMirror.length ||
      paths.some((p, i) => p !== folderPathsMirror[i])
    ) {
      useWindowStore.getState().setFolderPaths(paths);
    }
  }, [openFoldersForMirror, folderPathsMirror]);

  // ─── 窗口列表「窗口」菜单所需的 Primary 状态同步 ──────────────────────────
  const [isPrimaryWindow, setIsPrimaryWindow] = useState(isMainWindow());
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const un = await listen<{ label: string }>("lightmd:becamePrimary", (ev) => {
        if (ev.payload?.label !== getWindowLabel()) return;
        setIsPrimaryWindow(true);
        useWindowStore.getState().setPrimary(true);
        notify(t("multiwindow.becamePrimary"));
      });
      if (cancelled) un();
      else unlisten = un;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [t]);

  // ─── v0.9.0 WP9：外部修改检测（`lightmd:fileChanged`） ──────────────────────
  // 幂等：Rust 侧已按 mtime 去重（同 mtime 只上报一次），此处再按路径记录最近
  // 处理的 mtime，防止目录 watcher 与文件 watcher 双路到达造成重复重载。
  const lastFileChangedMtimeRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const un = await listen<{ path: string; mtime: number; removed?: boolean }>(
        "lightmd:fileChanged",
        (ev) => {
        const { path, mtime, removed } = ev.payload || { path: "", mtime: 0, removed: false };
        if (!path) return;
        // 本窗口保存自己触发的变更：mtime 已记录，跳过
        const seen = lastFileChangedMtimeRef.current.get(path);
        if (mtime && seen === mtime) return;
        lastFileChangedMtimeRef.current.set(path, mtime);

        const st = useEditorStore.getState();
        // v0.9.0：路径比较必须归一化——Rust 事件里的 path 是正斜杠，
        // 而「用原生对话框打开」的标签可能存的是反斜杠（实机测试发现的缺陷）
        const key = pathCompareKey(path);
        const idx = st.openTabs.findIndex((tb) => !tb.isUntitled && tb.path && pathCompareKey(tb.path) === key);
        if (idx === -1) return; // 本窗口未打开该文件
        const tab = st.openTabs[idx];
        /** 事件处理期间标签可能被关闭/重排，故每次按路径重新定位 */
        const findIdx = () => {
          const s = useEditorStore.getState();
          return s.openTabs.findIndex(
            (tb) => !tb.isUntitled && tb.path && pathCompareKey(tb.path) === key,
          );
        };

        // v0.9.0 AC-18（N23）：文件被删除 / 移出 → 关闭标签并提示。
        // 这条路径覆盖「监听目录之外的单文件」（目录内文件另有 folder-changed 联动）。
        if (removed) {
          // 改名 / 移动同样会产生「移出」事件：先确认文件真的不存在，避免把
          // 重命名误判为删除而关掉标签。
          void fileService
            .exists(path)
            .then((stillThere) => {
              if (stillThere) return;
              const idx2 = findIdx();
              if (idx2 === -1) return;
              closeTabsByPathRef.current(path);
              void import("./services/notificationService").then(({ notify: n }) =>
                n(t("multiwindow.fileChanged.missing", { name: tab.name }), "warning"),
              );
            })
            .catch(() => undefined);
          return;
        }

        if (tab.isDirty) {
          // 脏标签：不自动重载（会丢用户编辑），标记「脏状态下被外部修改」，
          // 保存时由 handleSaveFile 弹「覆盖 / 另存为 / 取消」（N22）。
          //
          // v0.9.0 第二轮修复（问题3）：必须先排除「自己保存的回声」。
          // Rust 侧 `note_file_written` 的 mtime 去重与 watcher 线程调度之间存在
          // 毫秒级竞态，事件可能赶在「清脏标记」之前到达——此时仅凭 isDirty 判定
          // 会误报「已被外部修改，保存前请确认」（保存后右下角仍弹提示）。
          // 实证手段：读一次磁盘，内容等于本应用刚写入的内容 → 纯回声，忽略。
          void fileService
            .readFile(path)
            .then((fresh) => {
              if (isSelfWrittenContent(path, fresh)) return;
              const idx2 = findIdx();
              if (idx2 === -1) return;
              useEditorStore.getState().setTabExternallyChanged(idx2, true);
              void import("./services/notificationService").then(({ notify: n }) =>
                n(t("multiwindow.fileChanged.dirtyHint", { name: tab.name }), "warning"),
              );
            })
            .catch(() => undefined);
          return;
        }
        // 干净标签：自动重载并保留滚动位置
        fileService
          .readFile(path)
          .then((fresh) => {
            const idx2 = findIdx();
            if (idx2 === -1) return;
            // v0.9.0 第二轮修复（问题3）：磁盘内容与标签内容一致（含自身保存的回声、
            // 以及编辑器已是最新的重复事件）→ 无需重载，也不弹「已自动重新载入」。
            const current = useEditorStore.getState().openTabs[idx2];
            if (current && current.content === fresh) return;
            useEditorStore.getState().updateTabContent(idx2, fresh);
            if (useEditorStore.getState().activeTabIdx === idx2) {
              setContent(fresh);
              safeSetItem(CONTENT_KEY, fresh);
              setForceUpdateKey((k) => k + 1);
            }
            void import("./services/notificationService").then(({ notify: n }) =>
              n(t("multiwindow.fileChanged.reloaded", { name: tab.name }), "info"),
            );
          })
          .catch(() => {
            // 文件已被删除/移动：关闭对应标签并提示
            const idx2 = findIdx();
            if (idx2 === -1) return;
            useEditorStore.getState().closeTab(idx2);
            const rest = useEditorStore.getState().openTabs;
            const active = rest[useEditorStore.getState().activeTabIdx];
            if (active) {
              setContent(active.content || "");
              openFile(active.path || null);
            } else {
              setContent("");
              openFile(null);
            }
            setForceUpdateKey((k) => k + 1);
            void import("./services/notificationService").then(({ notify: n }) =>
              n(t("multiwindow.fileChanged.missing", { name: tab.name }), "warning"),
            );
          });
      });
      if (cancelled) un();
      else unlisten = un;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [openFile, t]);

  // ─── v0.9.0 WP2：跨窗口「激活标签」事件（窗口列表子项点击） ──────────────
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const un = await listen<{ kind: string; path: string | null; untitledId: string | null }>(
        "lightmd:activateTab",
        (ev) => {
          const target = unwrapTargetedEvent<{ kind: string; path: string | null; untitledId: string | null }>(ev.payload);
          if (!target) return;
          const st = useEditorStore.getState();
          const idx =
            target.kind === "untitled" && target.untitledId
              ? st.getTabById(target.untitledId)
              : target.path
                ? st.getTabByPath(target.path)
                : -1;
          if (idx === -1) return;
          handleTabSwitchRef.current(st.openTabs[idx]);
        },
      );
      if (cancelled) un();
      else unlisten = un;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // ─── v0.9.0 WP9：文件监听超限提示 ──────────────────────────────────────────
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const un = await listen<{ limit: number; overflow: number }>(
        "lightmd:watchLimitReached",
        (ev) => notify(t("multiwindow.watchLimit", { limit: ev.payload?.limit ?? 50 }), "warning"),
      );
      if (cancelled) un();
      else unlisten = un;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [t]);

  // ─── v0.9.0 WP9：跨窗口「打开文件 / 迁移标签」事件（合并到主窗口等） ─────────
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const un = await listen<unknown>("lightmd:openFileInWindow", async (ev) => {
        const payload = unwrapTargetedEvent<{
          files?: string[];
          movedTabs?: Array<{
            path?: string | null;
            name: string;
            content?: string | null;
            isUntitled?: boolean;
            isDirty?: boolean;
            pinned?: boolean;
            untitledId?: string | null;
          }>;
        }>(ev.payload);
        if (!payload) return;
        for (const f of payload.files || []) {
          try {
            await openFileByPath(f, { skipConflictCheck: true });
          } catch (err) {
            console.error("跨窗口打开文件失败:", err);
          }
        }
        for (const moved of payload.movedTabs || []) {
          if (moved.isUntitled || !moved.path) {
            useEditorStore.getState().addTab({
              id: moved.untitledId || undefined,
              path: "",
              name: moved.name,
              content: moved.content ?? "",
              isUntitled: true,
              pinned: !!moved.pinned,
              isDirty: !!moved.isDirty,
            });
          } else {
            try {
              await openFileByPath(moved.path, { name: moved.name, skipConflictCheck: true });
            } catch (err) {
              console.error("跨窗口迁移标签失败:", err);
            }
          }
        }
        const st = useEditorStore.getState();
        const active = st.openTabs[st.activeTabIdx];
        if (active) {
          setCurrentDocPath(active.path || "");
          setContent(active.content || "");
          safeSetItem(CONTENT_KEY, active.content || "");
          openFile(active.path || null);
          setForceUpdateKey((k) => k + 1);
        }
      });
      if (cancelled) un();
      else unlisten = un;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [openFile, openFileByPath]);

  // ─── v0.9.0 WP0/WP9：窗口状态上报（会话快照 + OPEN_FILES 冲突检测数据源） ────
  // 只上报「标签元数据」（path/id/name/pinned/dirty）+ 文件夹 + 活跃下标，
  // **不含正文内容**；并用指纹跳过无变化的重复上报（避免每次击键都发 IPC）。
  const windowStateFingerprintRef = useRef<string>("");
  const activeTabIdxForSync = useEditorStore((s) => s.activeTabIdx);
  useEffect(() => {
    if (!isTauri()) return;
    const timer = setTimeout(() => {
      const st = useEditorStore.getState();
      const folders = useWindowStore.getState().folderPaths;
      const tabs = st.openTabs.map((t) => ({
        kind: (t.isUntitled ? "untitled" : "file") as "file" | "untitled",
        path: t.isUntitled ? null : t.path || null,
        untitledId: t.isUntitled ? t.id ?? null : null,
        name: t.name,
        pinned: !!t.pinned,
        isDirty: !!t.isDirty,
      }));
      const report = {
        label: getWindowLabel(),
        activeTabIdx: st.activeTabIdx,
        tabs,
        folderPaths: folders,
      };
      const fingerprint = JSON.stringify(report);
      if (fingerprint === windowStateFingerprintRef.current) return;
      windowStateFingerprintRef.current = fingerprint;
      void windowService.syncWindowState(report);
    }, 300);
    return () => clearTimeout(timer);
  }, [openTabs, activeTabIdxForSync, folderPathsMirror]);

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
          if (idx !== -1) {
            updateTabDirty(idx, false);
            // v0.9.0 WP9：另存为成功后本标签不再处于「外部修改未处理」状态
            // （否则再次 Ctrl+S 仍会弹「覆盖 / 另存为」）
            useEditorStore.getState().setTabExternallyChanged(idx, false);
          }
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
    // v0.9.0 D7：CRLF 文档的序列化输出统一转回 CRLF（B6 快路径已逐字节
    // 返回原文不受影响，此处兜底重新序列化的块）
    const markdown = isSourceMode
      ? contentRef.current
      : preserveEol(getMarkdownFromDoc(view.state.doc), contentRef.current);

    if (isTauri() && filePath) {
      // v0.9.0 WP9 N22：脏状态下磁盘已被外部修改 → 保存会静默覆盖别人的改动，
      // 先让用户确认（覆盖 / 另存为 / 取消）
      const activeTabForSave = useEditorStore.getState().openTabs[useEditorStore.getState().activeTabIdx];
      if (activeTabForSave?.isExternallyChanged) {
        const choice = await askChoice(
          "externalSave",
          t("multiwindow.externalSave.title"),
          t("multiwindow.externalSave.message", { name: getFileName(filePath) }),
          [
            { id: "overwrite", label: t("multiwindow.externalSave.overwrite"), tone: "danger" as const },
            { id: "saveAs", label: t("multiwindow.externalSave.saveAs") },
          ],
        );
        if (choice === "cancel") return;
        if (choice === "saveAs") {
          await handleSaveAsFile();
          return;
        }
        // 覆盖：继续走下面的写盘流程
      }
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
        // v0.9.0 WP9：覆盖后本标签不再处于「外部修改未处理」状态
        useEditorStore.getState().setTabExternallyChanged(activeTabIdx, false);
        // v0.4.0 功能4：保存成功后记录版本快照（内容去重由服务内部处理）
        versionSnapshotService.recordSnapshot(filePath, markdown).catch(() => {});
      } catch (err) {
        console.error("保存失败:", err);
      }
    } else if (isTauri() && !filePath) {
      await handleSaveAsFile();
    } else {
      safeSetItem(CONTENT_KEY, markdown);
      setDirty(false);
      // v0.6.1 问题3：手动保存成功后解除翻译回写的自动保存抑制
      useEditorStore.getState().setSuppressAutoSave(false);
      // v0.6.1 问题2：手动保存 = 接受译文，清除"取消翻译"气泡
      useEditorStore.getState().setTranslateUndoSnapshot(null);
      // 清除当前标签页的脏标记（修复：浏览器环境保存后小蓝点未消失）
      const { activeTabIdx } = useEditorStore.getState();
      updateTabDirty(activeTabIdx, false);
    }
  }, [filePath, setDirty, handleSaveAsFile, updateTabDirty, askChoice, t]);

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
    safeSetItem(CONTENT_KEY, newTab?.content ?? "");
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
      // v0.8.5 需求6：最近打开为纯历史记录，关闭标签不再从 recentFiles 中移除条目
      // （旧 v0.4.5 行为已废弃——关闭后历史条目保留，供下次快速找回）
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
      safeSetItem(CONTENT_KEY, activeTab.content || "");
      openFile(activeTab.path);
      setDirty(activeTab.isDirty || false);
    } else {
      setContent("");
      safeSetItem(CONTENT_KEY, "");
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
        // v0.8.5 需求6：最近打开为纯历史记录，批量关闭不再从 recentFiles 中移除条目
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
      safeSetItem(CONTENT_KEY, active.content || "");
      openFile(active.path);
      setDirty(active.isDirty || false);
    } else {
      setContent("");
      safeSetItem(CONTENT_KEY, "");
      openFile(null);
      setDirty(false);
    }
    setForceUpdateKey((k) => k + 1);
  }, [closeTab, openFile, setDirty]);

  // ═══════════════ v0.9.0 多窗口：冲突检测 · 窗口命令 · 关闭流程 ═══════════════

  /**
   * v0.9.0 WP9：打开文件前的跨窗口冲突检测。
   *
   * Rust 侧 OPEN_FILES 注册表记录「哪个窗口打开了哪个文件、是否 dirty」。
   * 只有**其他窗口**且 dirty 才算冲突（同一文件多窗口非脏打开本身合法）。
   */
  const resolveOpenConflict = useCallback(
    async (path: string, name?: string): Promise<"ok" | "readonly" | "cancel"> => {
      if (!isTauri() || !path) return "ok";
      const self = getWindowLabel();
      let refs: Array<{ label: string; isDirty: boolean }> = [];
      try {
        refs = await windowService.queryFileOpen(path);
      } catch {
        return "ok";
      }
      const { hasConflict, dirtyLabels } = evaluateOpenConflict(refs, self);
      if (!hasConflict) return "ok";

      const choice = await askChoice(
        "conflict",
        t("multiwindow.conflict.title"),
        dirtyLabels
          .map((label) => t("multiwindow.conflict.dirtyIn", { label }))
          .join("、"),
        [
          {
            id: "readonly",
            label: t("multiwindow.conflict.readonly"),
            description: t("multiwindow.conflict.readonlyDesc"),
          },
          {
            id: "force",
            label: t("multiwindow.conflict.force"),
            description: t("multiwindow.conflict.forceDesc"),
          },
          {
            id: "focus",
            label: t("multiwindow.conflict.focus"),
            description: t("multiwindow.conflict.focusDesc"),
          },
        ],
      );
      if (choice === "readonly") return "readonly";
      if (choice === "force") return "ok";
      if (choice === "focus") {
        // 激活已有窗口；该窗口的标签由用户自行切换
        await windowService.focusWindow(dirtyLabels[0]);
        return "cancel";
      }
      void name;
      return "cancel";
    },
    [askChoice, t],
  );
  // 用 ref 转发给早先注册的 lightmd:openFile 监听（避免其依赖变化反复重建监听）
  useEffect(() => {
    resolveOpenConflictRef.current = resolveOpenConflict;
  }, [resolveOpenConflict]);

  /** v0.9.0 WP2：激活目标窗口并让其切到指定标签（窗口列表子项点击） */
  const handleActivateTabInWindow = useCallback(
    async (
      label: string,
      target: { kind: string; path: string | null; untitledId: string | null },
    ) => {
      if (!isTauri()) return;
      if (label !== getWindowLabel()) {
        await windowService.focusWindow(label);
      }
      await windowService.emitToWindow(label, "lightmd:activateTab", target);
    },
    [],
  );

  /** v0.9.0 WP2：新建辅助窗口（Ctrl+Shift+N / 窗口菜单 / 命令面板） */
  const handleNewWindow = useCallback(async () => {
    if (!isTauri()) return;
    try {
      await windowService.createWindow();
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      notify(msg === "LIMIT" ? t("multiwindow.limitReached") : t("multiwindow.createFailed", { msg }), "error");
    }
  }, [t]);

  /** v0.9.0 WP2：在**新窗口**中打开文件（文件树右键 / Ctrl+Alt+O） */
  const handleOpenFileInNewWindow = useCallback(
    async (path: string) => {
      if (!isTauri()) return;
      try {
        await windowService.createWindow({ files: [path] });
      } catch (err) {
        const msg = String((err as Error)?.message ?? err);
        notify(
          msg === "LIMIT"
            ? t("multiwindow.limitReached")
            : t("multiwindow.openToNewWindowFailed", { msg }),
          "error",
        );
      }
    },
    [t],
  );

  /**
   * v0.9.0 WP2 N7：把标签**移动**到新窗口。
   * - 真实文件带 dirty → 先提示保存/放弃（保存失败则中止移动）
   * - 临时标签直接携带内容迁移（未落盘，无别处可存）
   * 迁移成功后在原窗口关闭该标签（不触发脏确认——已在前置步骤处理）。
   */
  const handleMoveTabToNewWindow = useCallback(
    async (tab: TabInfo, idx: number) => {
      if (!isTauri()) return;
      let content = tab.content ?? "";
      if (!tab.isUntitled && tab.path) {
        if (tab.isDirty) {
          const choice = await askChoice(
            "closeConfirm",
            t("multiwindow.closeConfirm.title"),
            t("app.confirmCloseDirty", { name: tab.name }),
            [
              {
                id: "save",
                label: t("multiwindow.closeConfirm.saveAll"),
                description: t("multiwindow.closeConfirm.saveAllDesc"),
              },
              {
                id: "discard",
                label: t("multiwindow.closeConfirm.discard"),
                description: t("multiwindow.closeConfirm.discardDesc"),
                tone: "danger" as const,
              },
            ],
          );
          if (choice === "cancel") return;
          if (choice === "save") {
            try {
              await fileService.writeFile(tab.path, content);
              updateTabDirty(idx, false);
            } catch {
              return; // 保存失败：中止移动，避免丢内容
            }
          }
        }
        content = "";
      }
      const moved = {
        path: tab.isUntitled ? null : tab.path,
        name: tab.name,
        content: tab.isUntitled ? content : null,
        isDirty: !!tab.isDirty,
        isUntitled: !!tab.isUntitled,
        pinned: !!tab.pinned,
        untitledId: tab.id ?? null,
      };
      try {
        await windowService.createWindow({ movedTabs: [moved] });
      } catch (err) {
        const msg = String((err as Error)?.message ?? err);
        notify(
          msg === "LIMIT"
            ? t("multiwindow.limitReached")
            : t("multiwindow.createFailed", { msg }),
          "error",
        );
        return;
      }
      // 迁移成功：关闭原标签（清理进度键，与常规关闭一致）
      if (tab.isUntitled) {
        fileScrollProgress.clear(untitledProgressKey(tab.id));
      } else if (tab.path) {
        fileScrollProgress.clear(tab.path);
      }
      closeTab(idx);
      const st = useEditorStore.getState();
      const active = st.openTabs[st.activeTabIdx];
      if (active) {
        setContent(active.content || "");
        safeSetItem(CONTENT_KEY, active.content || "");
        openFile(active.path || null);
        setDirty(active.isDirty || false);
      } else {
        setContent("");
        safeSetItem(CONTENT_KEY, "");
        openFile(null);
        setDirty(false);
      }
      setForceUpdateKey((k) => k + 1);
    },
    [askChoice, t, closeTab, openFile, setDirty, updateTabDirty],
  );

  /**
   * v0.9.0 WP2 N10：把本窗口全部标签合并到 Primary 窗口，然后关闭自身。
   * 传输走 `lightmd:openFileInWindow` 事件（真实文件传 path，临时标签传内容）。
   */
  const handleMergeToPrimary = useCallback(async () => {
    if (!isTauri()) return;
    const st = useEditorStore.getState();
    const lists = await windowService.listWindows();
    const primary = lists.find((w) => w.isPrimary && w.label !== getWindowLabel());
    if (!primary) {
      notify(t("multiwindow.createFailed", { msg: "no primary" }), "warning");
      return;
    }
    // 脏标签先统一确认（与关闭窗口同一语义：只算已落盘且未保存的文件）
    const dirty = tabsNeedingCloseConfirm(st.openTabs);
    if (dirty.length > 0) {
      const choice = await askChoice(
        "closeConfirm",
        t("multiwindow.closeConfirm.title"),
        t("multiwindow.closeConfirm.message", { count: dirty.length }),
        [
          {
            id: "save",
            label: t("multiwindow.closeConfirm.saveAll"),
            description: t("multiwindow.closeConfirm.saveAllDesc"),
          },
          {
            id: "discard",
            label: t("multiwindow.closeConfirm.discard"),
            description: t("multiwindow.closeConfirm.discardDesc"),
            tone: "danger" as const,
          },
        ],
      );
      if (choice === "cancel") return;
      if (choice === "save") {
        const saved = await saveDirtyTabsRef.current(dirty);
        if (!saved) return; // 有保存失败 → 中止合并
      }
    }
    const current = useEditorStore.getState();
    await windowService.emitToWindow(primary.label, "lightmd:openFileInWindow", {
      files: current.openTabs.filter((tb) => !tb.isUntitled && tb.path).map((tb) => tb.path),
      movedTabs: current.openTabs
        .filter((tb) => tb.isUntitled)
        .map((tb) => ({
          path: null,
          name: tb.name,
          content: tb.content ?? "",
          isUntitled: true,
          isDirty: !!tb.isDirty,
          pinned: !!tb.pinned,
          untitledId: tb.id ?? null,
        })),
    });
    // v0.9.0 第三轮：把自己从会话「最后状态」中除名——合并意味着标签已全部转移到
    // 目标窗口，若不除名，「逐个关窗退出」生成的完整快照会把这个窗口原样复活，
    // 同一批标签在两个窗口重复出现。
    await windowService.forgetWindowState();
    // 请求关闭自身（走 CloseRequested → 此处已处理过脏确认，直接确认关闭）
    await windowService.confirmClose().catch(() => undefined);
  }, [askChoice, t]);

  // ─── v0.9.0 第三轮（需求2）：辅助窗口拖到主窗口标签栏 → 询问是否合并 ─────────
  //
  // Rust 侧持续检测窗口几何（WindowEvent::Moved + 建窗忽略期 + 焦点闸门 + 静止
  // 去抖，见 src-tauri/src/window/merge_detect.rs），把窗口拖到主窗口顶部并松手后
  // emit 本事件。前端按 `target` 过滤（emit_to 的广播语义要求自行过滤，见
  // window_cmds::emit_to_window 注释），确认后复用既有「合并到主窗口」流程。
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const un = await listen<unknown>("lightmd:mergeOffer", async (ev) => {
        const payload = unwrapTargetedEvent<Record<string, never>>(ev.payload);
        if (!payload) return;
        // 空窗口没有可合并的标签，不打扰
        if (useEditorStore.getState().openTabs.length === 0) return;
        const choice = await askChoice(
          "mergeOffer",
          t("multiwindow.mergeOffer.message"),
          "",
          [{ id: "merge", label: t("multiwindow.mergeOffer.confirm") }],
        );
        if (choice !== "merge") return;
        await handleMergeToPrimary();
      });
      if (cancelled) un();
      else unlisten = un;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [askChoice, t, handleMergeToPrimary]);

  /**
   * v0.9.0 WP1 N2：关闭当前窗口（Ctrl+Shift+W / 窗口菜单）。
   * 复用原生 CloseRequested 流程（Rust 拦截 → 前端 dirty 确认 → confirm_close）。
   */
  const handleCloseWindow = useCallback(async () => {
    if (!isTauri()) return;
    await windowService.requestCloseWindow(getWindowLabel());
  }, []);

  /**
   * v0.9.0（用户反馈新增）：退出整个应用（窗口菜单 / 命令面板 `Ctrl+Q`）。
   *
   * 与「关闭当前窗口」的区别：退出时全部窗口仍存活，Rust 会记录**完整窗口集合**，
   * 下次启动若开启「恢复其他窗口」即可全部还原；用户主动关掉的窗口不会复活。
   *
   * 只对「已落盘且未保存」的文件确认——临时（未命名）标签的内容由窗口级
   * localStorage 记忆、下次启动自动恢复，不参与版本快照，无需阻断退出。
   */
  const handleQuitApp = useCallback(async () => {
    if (!isTauri()) return;
    const dirty = tabsNeedingCloseConfirm(useEditorStore.getState().openTabs);
    if (dirty.length > 0) {
      const choice = await askChoice(
        "closeConfirm",
        t("multiwindow.quitConfirm.title"),
        t("multiwindow.quitConfirm.message", { count: dirty.length }),
        [
          {
            id: "save",
            label: t("multiwindow.quitConfirm.saveAll"),
            description: t("multiwindow.closeConfirm.saveAllDesc"),
          },
          {
            id: "discard",
            label: t("multiwindow.quitConfirm.discard"),
            description: t("multiwindow.closeConfirm.discardDesc"),
            tone: "danger" as const,
          },
        ],
      );
      if (choice === "cancel") return;
      if (choice === "save") {
        const ok = await saveDirtyTabsRef.current(dirty);
        if (!ok) return; // 有保存失败/取消 → 中止退出
      }
    }
    // 退出前冲刷本窗口的窗口级持久化数据（其余窗口在各自 vitals 落盘时已写入）
    try {
      const cur = useEditorStore.getState();
      if (isUntitledRestoreEnabled()) {
        saveUntitledTabs(cur.openTabs);
        saveLastActiveTab(cur.openTabs[cur.activeTabIdx] ?? null);
      }
      fileScrollProgress.saveSnapshot(tabsProgressKeys(cur.openTabs));
    } catch (err) {
      console.warn("[退出应用] 持久化冲刷失败（忽略）:", err);
    }
    await windowService.quitApp().catch((err) => {
      console.error("[退出应用] 失败:", err);
    });
  }, [askChoice, t]);

  /**
   * 为指定标签走一次「另存为」（保存成功返回 true；用户取消返回 false）。
   * 与 handleSaveAsFile 的区别：不依赖编辑器视图，直接落盘标签内已同步的内容，
   * 供关闭窗口前的批量保存使用。
   */
  const saveAsForTab = useCallback(
    async (tab: TabInfo): Promise<boolean> => {
      try {
        const selected = await save({
          defaultPath: getFileName(tab.path || t("app.unnamed")),
          filters: [{ name: t("app.markdownFilter"), extensions: ["md"] }],
        });
        if (!selected) return false;
        await fileService.writeFile(selected, tab.content ?? "");
        const st = useEditorStore.getState();
        const idx = tab.isUntitled && tab.id ? st.getTabById(tab.id) : st.getTabByPath(tab.path);
        if (idx !== -1) {
          const old = useEditorStore.getState().openTabs[idx];
          fileScrollProgress.move(untitledProgressKey(old?.id), selected);
          useEditorStore.getState().promoteTab(idx, selected, getFileName(selected));
        }
        addRecentFile({ path: selected, name: getFileName(selected) });
        return true;
      } catch (err) {
        notifyError(String(err));
        return false;
      }
    },
    [t, addRecentFile],
  );

  /**
   * 保存一批脏标签。真实文件按各自最新内容写盘；临时标签走另存为对话框。
   * @returns 是否全部保存成功（false = 用户取消或有失败，调用方应中止关闭流程）
   */
  const saveDirtyTabs = useCallback(
    async (tabs: TabInfo[]): Promise<boolean> => {
      for (const tab of tabs) {
        const st = useEditorStore.getState();
        const idx = tab.isUntitled && tab.id ? st.getTabById(tab.id) : st.getTabByPath(tab.path);
        if (idx === -1) continue;
        const current = useEditorStore.getState().openTabs[idx];
        if (!current?.isDirty) continue;
        if (current.isUntitled || !current.path) {
          // 临时标签：跑「另存为」对话框（用户取消则整体中止）
          const ok = await saveAsForTab(current);
          if (!ok) return false;
        } else {
          try {
            await fileService.writeFile(current.path, current.content ?? "");
            updateTabDirty(idx, false);
            versionSnapshotService.recordSnapshot(current.path, current.content ?? "").catch(() => {});
          } catch {
            return false;
          }
        }
      }
      return true;
    },
    [updateTabDirty, saveAsForTab],
  );
  const saveDirtyTabsRef = useRef(saveDirtyTabs);
  useEffect(() => {
    saveDirtyTabsRef.current = saveDirtyTabs;
  }, [saveDirtyTabs]);

  /** v0.9.0 WP2：Ctrl+Alt+O / 命令面板「打开到新窗口」——先选文件再开新窗口 */
  const handleOpenToNewWindowDialog = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const extensions = ALL_SUPPORTED_EXTENSIONS.map((ext) => ext.slice(1));
      const selected = await open({
        multiple: false,
        filters: [
          { name: t("app.markdownFilter"), extensions: ["md", "markdown", "mdown", "mkd"] },
          { name: t("app.allSupportedFiles"), extensions },
        ],
      });
      if (selected) await handleOpenFileInNewWindow(selected);
    } catch (err) {
      console.error("打开文件到新窗口失败:", err);
    }
  }, [t, handleOpenFileInNewWindow]);

  // v0.9.0 WP2：把窗口命令暴露给早先注册的快捷键 / 命令面板监听
  useEffect(() => {
    windowCommandsRef.current = {
      newWindow: () => void handleNewWindow(),
      closeWindow: () => void handleCloseWindow(),
      openInNewWindow: () => void handleOpenToNewWindowDialog(),
      mergeToPrimary: () => void handleMergeToPrimary(),
      quitApp: () => void handleQuitApp(),
    };
  }, [
    handleNewWindow,
    handleCloseWindow,
    handleOpenToNewWindowDialog,
    handleMergeToPrimary,
    handleQuitApp,
  ]);

  /**
   * v0.9.0 WP1：窗口关闭请求处理（Rust 拦截 CloseRequested 后派发）。
   *
   * 流程：脏标签确认 → 冲刷临时标签/滚动进度（destroy 路径不保证
   * `beforeunload` 触发，故显式 flush，见 R2）→ confirm_close。
   */
  const handleCloseRequested = useCallback(async () => {
    const st = useEditorStore.getState();
    // v0.9.0 用户反馈修正：只对「已落盘且未保存」的文件确认。
    // 临时（未命名）标签的内容由窗口级 localStorage 记忆、下次启动会恢复，
    // 且不参与版本快照，无需阻断关闭流程。
    const dirty = tabsNeedingCloseConfirm(st.openTabs);
    // 诊断：确认项数 > 0 时本窗口会停在确认对话框上等待用户选择
    // （E2E 遇到「点关闭没反应」时先看这条记录）
    noteEventReceived("closeFlow", `dirty=${dirty.length}`);
    if (dirty.length > 0) {
      const choice = await askChoice(
        "closeConfirm",
        t("multiwindow.closeConfirm.title"),
        t("multiwindow.closeConfirm.message", { count: dirty.length }),
        [
          {
            id: "save",
            label: t("multiwindow.closeConfirm.saveAll"),
            description: t("multiwindow.closeConfirm.saveAllDesc"),
          },
          {
            id: "discard",
            label: t("multiwindow.closeConfirm.discard"),
            description: t("multiwindow.closeConfirm.discardDesc"),
            tone: "danger" as const,
          },
        ],
      );
      if (choice === "cancel") {
        await windowService.abortClose();
        return;
      }
      if (choice === "save") {
        const ok = await saveDirtyTabsRef.current(dirty);
        if (!ok) {
          await windowService.abortClose();
          return;
        }
      }
    }
    // R2：destroy 路径不保证 beforeunload 触发，此处显式冲刷窗口级持久化数据
    try {
      const cur = useEditorStore.getState();
      if (isUntitledRestoreEnabled()) {
        saveUntitledTabs(cur.openTabs);
        saveLastActiveTab(cur.openTabs[cur.activeTabIdx] ?? null);
      }
      fileScrollProgress.saveSnapshot(tabsProgressKeys(cur.openTabs));
    } catch (err) {
      console.warn("[关闭窗口] 持久化冲刷失败（忽略）:", err);
    }
    noteEventReceived("closeFlow", "flushed");
    await windowService.confirmClose().catch((err) => {
      console.error("[关闭窗口] 确认关闭失败:", err);
    });
    noteEventReceived("closeFlow", "confirmed");
  }, [askChoice, t]);
  const handleCloseRequestedRef = useRef(handleCloseRequested);
  useEffect(() => {
    handleCloseRequestedRef.current = handleCloseRequested;
  }, [handleCloseRequested]);

  // ─── v0.9.0 WP1：监听 Rust 的关闭请求 ──────────────────────────────────────
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const un = await listen<{ label?: string }>("lightmd:closeRequested", (ev) => {
          // ⚠️ Tauri v2 的 emit_to 不能把事件限制在单个 webview 内：
          // 不过滤 label 会导致「关闭主窗口 → 所有窗口一起关闭」（实机测试发现的缺陷）。
          const target = ev.payload?.label;
          const self = getWindowLabel();
          noteEventReceived("close", `${String(target)}/${self}/${String(target === self)}`);
          if (target && target !== self) return;
          void handleCloseRequestedRef.current();
        });
        if (cancelled) un();
        else {
          unlisten = un;
          markListenerReady("close");
        }
      } catch (err) {
        // 注册失败会让「关闭按钮无反应」静默发生，必须显式暴露（E2E 断言 + 提示）
        markListenerFailed("close", err);
        console.error("[关闭窗口] 监听注册失败:", err);
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

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

      // ─── v0.9.0 WP2：窗口命令（标题栏菜单 / 命令面板共用） ───
      if (id === "window.new") { windowCommandsRef.current.newWindow(); return; }
      if (id === "window.close") { windowCommandsRef.current.closeWindow(); return; }
      if (id === "window.openInNew") { windowCommandsRef.current.openInNewWindow(); return; }
      if (id === "window.mergeToPrimary") { windowCommandsRef.current.mergeToPrimary(); return; }
      if (id === "window.quit") { windowCommandsRef.current.quitApp(); return; }

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
      // ─── v0.9.0 WP2：多窗口快捷键（已核实与既有绑定无冲突） ───
      // Ctrl+Shift+N 新建辅助窗口
      if (e.ctrlKey && e.shiftKey && (e.key === "N" || e.key === "n")) {
        e.preventDefault();
        windowCommandsRef.current.newWindow();
        return;
      }
      // Ctrl+Shift+W 关闭当前窗口（Ctrl+W 仍是关闭标签，语义分离）
      if (e.ctrlKey && e.shiftKey && (e.key === "W" || e.key === "w")) {
        e.preventDefault();
        windowCommandsRef.current.closeWindow();
        return;
      }
      // Ctrl+Alt+O 打开文件到**新窗口**（Ctrl+Shift+O 已被大纲栏占用，见 App.tsx 快捷键清单）
      if (e.ctrlKey && e.altKey && (e.key === "O" || e.key === "o")) {
        e.preventDefault();
        windowCommandsRef.current.openInNewWindow();
        return;
      }
      // Ctrl+Q 退出应用（写完整窗口集合并退出，供「恢复其他窗口」下次还原）
      if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "q" || e.key === "Q")) {
        e.preventDefault();
        windowCommandsRef.current.quitApp();
        return;
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
        safeSetItem(CONTENT_KEY, nextTab.content || "");
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
      safeSetItem(CONTENT_KEY, pendingMdRef.current);
      lsTimerRef.current = null;
    }, 500);
  }, [updateTabContent, updateTabDirty]);

  // 关闭浏览器前刷新 pending 的 localStorage 写入，防止数据丢失
  useEffect(() => {
    const handler = () => {
      if (lsTimerRef.current && pendingMdRef.current) {
        safeSetItem(CONTENT_KEY, pendingMdRef.current);
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
    safeSetItem(CONTENT_KEY, tab.content || "");
    openFile(tab.path);
    // v0.4.0：切换标签时同步语言标识，确保代码文件正确高亮
    // v0.8.0 修复 P11-2：临时文档（path 为空）按 markdown 处理
          const lang = !tab.path || isMarkdownFile(tab.path) ? "markdown" : getFileLanguage(tab.path);
    setCurrentLanguage(lang);
    setDirty(tab.isDirty || false);
    setForceUpdateKey((k) => k + 1);
  }, [openFile, setDirty, updateTabContent, setActiveTab, setCurrentLanguage]);

  // v0.9.0 WP2：把标签切换暴露给早先注册的跨窗口「激活标签」监听
  useEffect(() => {
    handleTabSwitchRef.current = handleTabSwitch;
  }, [handleTabSwitch]);

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
        // v0.8.5 需求6：最近打开为纯历史记录，文件删除后不再从 recentFiles 中移除条目；
        // 条目的失效提示由 FileTree watcher 的删除事件（markRecentStale）标记 ⚠
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
      safeSetItem(CONTENT_KEY, active.content || "");
      openFile(active.path);
      setDirty(active.isDirty || false);
    } else {
      setContent("");
      safeSetItem(CONTENT_KEY, "");
      openFile(null);
      setDirty(false);
    }
    setForceUpdateKey((k) => k + 1);
  }, [openFile, setDirty]);

  // v0.9.0 WP9：把「按路径关闭标签」暴露给早先注册的文件变更监听（定义在其后，故用 ref）
  useEffect(() => {
    closeTabsByPathRef.current = closeTabsByPath;
  }, [closeTabsByPath]);

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
      } else if (detail?.id === "filetree.openInNewWindow" && typeof detail.path === "string") {
        // v0.9.0 WP2：文件树右键「在新窗口中打开」
        void handleOpenFileInNewWindow(detail.path);
      }
      // v0.8.2 调整：「打开的文件」栏去掉标题栏关闭按钮，temp.closeAll 命令随之移除——
      // 该栏随文件数据自动出现/消失（所有文件都关闭后自动隐藏）
    };
    window.addEventListener("lightmd:command", handler);
    return () => window.removeEventListener("lightmd:command", handler);
  }, [handleTabSwitch, handleTabClose, closeTabsByPath, handleOpenFileInNewWindow]);

  return (
    <div className="app" data-theme={theme}>
      <TitleBar
        // v0.9.0 WP9：只读标签在标题上显式标记，避免用户误以为可以编辑
        fileName={`${activeIsReadonly ? `${t("multiwindow.readonlyBadge")} ` : ""}${fileName}${isDirty ? " ●" : ""}`}
        onNew={handleNewFile}
        onNewFile={handleNewFile}
        onNewFolder={handleNewFolder}
        onOpen={handleOpenFile}
        onSave={handleSaveFile}
        onSaveAs={handleSaveAsFile}
        onExport={() => setShowExport(true)}
        onSettings={() => setShowSettings(true)}
        // v0.9.0 WP2：窗口菜单
        onNewWindow={handleNewWindow}
        onCloseWindow={handleCloseWindow}
        onMergeToPrimary={handleMergeToPrimary}
        onFocusWindow={(label) => void windowService.focusWindow(label)}
        onActivateTab={(label, target) => void handleActivateTabInWindow(label, target)}
        onQuitApp={() => void handleQuitApp()}
        isPrimaryWindow={isPrimaryWindow}
      />
      <TabBar
        onTabSwitch={handleTabSwitch}
        onTabClose={handleTabClose}
        onSaveAs={handleSaveAsFile}
        onCloseMany={handleCloseMany}
        onNewUntitled={handleNewUntitled}
        // v0.9.0 WP2：「移动到新窗口」右键项
        onMoveToNewWindow={handleMoveTabToNewWindow}
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
            safeSetItem(CONTENT_KEY, newContent);
            setForceUpdateKey((k) => k + 1);
            setDirty(false);
            const { activeTabIdx } = useEditorStore.getState();
            updateTabContent(activeTabIdx, newContent);
            updateTabDirty(activeTabIdx, false);
          }}
        />
      )}

      {/* v0.9.0：统一的决策对话框（冲突检测 / 外部文件策略 / 关闭确认 / 保存竞态） */}
      <ChoiceDialog
        open={pendingDialog !== null}
        title={pendingDialog ? t(dialogTitleKey(pendingDialog.kind)) : ""}
        message={pendingDialog?.name ?? ""}
        detail={pendingDialog?.detail ?? ""}
        options={pendingDialog?.options ?? []}
        cancelLabel={t("common.cancel")}
        onChoose={closePendingDialog}
        onCancel={() => closePendingDialog("cancel")}
      />
    </div>
  );
}

/** v0.9.0：决策对话框类型 → i18n 标题 key */
function dialogTitleKey(
  kind: "conflict" | "askOpen" | "closeConfirm" | "externalSave" | "mergeOffer",
): string {
  switch (kind) {
    case "conflict":
      return "multiwindow.conflict.title";
    case "askOpen":
      return "multiwindow.askOpen.title";
    case "closeConfirm":
      return "multiwindow.closeConfirm.title";
    case "mergeOffer":
      return "multiwindow.mergeOffer.title";
    default:
      return "multiwindow.externalSave.title";
  }
}

export default App;
