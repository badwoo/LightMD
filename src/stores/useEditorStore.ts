import { create } from "zustand";
import type { WordCountResult } from "../utils/wordCount";

export type ViewMode = "preview" | "edit" | "split";

export interface TabInfo {
  path: string;
  name: string;
  content?: string;
  isDirty?: boolean;
}

/**
 * v0.6.3 P0-2：翻译撤销快照——绑定文档上下文。
 * 恢复原文前校验 filePath/key 与当前文档一致，防止跨文件/跨版本恢复（A 的原文灌进 B）。
 */
export interface TranslateUndoSnapshot {
  /** 回写前的原文全文 */
  content: string;
  /** 回写时的文件路径（null = 未保存的新文件） */
  filePath: string | null;
  /**
   * 回写时的 forceUpdateKey（保留字段，仅作记录）。
   * v0.7.4 问题4：不再用于归属校验——切标签会递增该计数（App.handleTabSwitch），
   * "全文翻译 → 切走 → 切回" 属正常操作却会让 key 变化，用它校验会导致
   * "取消翻译"按钮可见但点击无效。归属判定统一走 isTranslateSnapshotForFile。
   */
  key: number;
}

/**
 * v0.7.4 问题4：判断翻译撤销快照是否属于指定文档。
 *
 * 只按 filePath 判定归属：filePath 是文档的稳定标识，而 key（forceUpdateKey）
 * 会因切换标签/窗口等外部更新递增，不能代表"换了文档"。
 * 该判定被"取消翻译"气泡渲染（TranslateUndoToast）与恢复逻辑（undoTranslation）
 * 共用，避免两处规则不一致导致按钮可见却点击无效。
 *
 * filePath 为 null 时（未保存的新文件，仅浏览器演示态可能出现）仅有一个文档实例，
 * 同为 null 即视为归属一致。
 */
export function isTranslateSnapshotForFile(
  snapshot: TranslateUndoSnapshot | null,
  filePath: string | null | undefined,
): boolean {
  return snapshot !== null && snapshot.filePath === (filePath ?? null);
}

interface EditorState {
  filePath: string | null;
  isDirty: boolean;
  /**
   * v0.6.1 问题3：翻译回写（直接替换/双语对照）产生的修改不自动保存，
   * 仅在用户手动保存（Ctrl+S / 菜单）或继续手动编辑后恢复自动保存
   */
  suppressAutoSave: boolean;
  /**
   * v0.6.1 问题2：翻译回写前的原文全文快照。
   * 非空时显示浮动"取消翻译"气泡，点击恢复原文；
   * 用户手动编辑/手动保存/切换文件后清除
   * v0.6.3 P0-2：绑定文档上下文（filePath/key），恢复前校验归属
   */
  translateUndoSnapshot: TranslateUndoSnapshot | null;
  cursorLine: number;
  /** 字数统计详情（G11：扩展为对象，含字数/字符数/行数/段落数/阅读时长） */
  wordCount: WordCountResult;
  viewMode: ViewMode;
  /** 上一个非分屏模式，用于双击Shift切回 */
  prevViewMode: ViewMode;
  focusMode: boolean;
  // 源码模式下的语法插入回调，由 EditorContainer 注册
  sourceInsertHandler: ((syntax: string, cursorOffset?: number) => void) | null;
  // 撤销/恢复回调，由 EditorContainer 注册
  undoHandler: (() => void) | null;
  redoHandler: (() => void) | null;
  // 搜索/替换
  showSearch: boolean;
  showSearchReplace: boolean;
  /** 搜索框聚焦触发器：每次开启搜索时递增，SearchReplaceDialog 监听变化重新聚焦 */
  searchFocusKey: number;
  // 多标签页
  openTabs: TabInfo[];
  activeTabIdx: number;
  /** v0.4.0：当前文件语言标识（如 "javascript"/"python"/"markdown"），用于代码文件语法高亮 */
  currentLanguage: string;

  openFile: (path: string | null) => void;
  /** v0.4.0：设置当前文件语言标识（由 App.tsx 在打开文件时根据扩展名设置） */
  setCurrentLanguage: (lang: string) => void;
  setDirty: (dirty: boolean) => void;
  /** v0.6.1 问题3：设置翻译回写后的自动保存抑制标志 */
  setSuppressAutoSave: (v: boolean) => void;
  /** v0.6.1 问题2：设置/清除翻译取消快照（v0.6.3 P0-2：绑定文档上下文） */
  setTranslateUndoSnapshot: (v: TranslateUndoSnapshot | null) => void;
  setCursorLine: (line: number) => void;
  /** 更新字数统计详情（接收 calculateWordCount 的结果） */
  setWordCount: (count: WordCountResult) => void;
  setViewMode: (mode: ViewMode) => void;
  toggleFocusMode: () => void;
  setSourceInsertHandler: (handler: ((syntax: string, cursorOffset?: number) => void) | null) => void;
  setUndoHandler: (handler: (() => void) | null) => void;
  setRedoHandler: (handler: (() => void) | null) => void;
  setShowSearch: (show: boolean) => void;
  /** 切换搜索框开关（底部栏按钮使用） */
  toggleSearch: () => void;
  setShowSearchReplace: (show: boolean) => void;
  markSaved: () => void;
  addTab: (tab: TabInfo) => void;
  setActiveTab: (idx: number) => void;
  closeTab: (idx: number) => TabInfo | null;
  updateTabContent: (idx: number, content: string) => void;
  updateTabDirty: (idx: number, isDirty: boolean) => void;
  getTabByPath: (path: string) => number;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  filePath: null,
  isDirty: false,
  suppressAutoSave: false,
  translateUndoSnapshot: null,
  cursorLine: 0,
  wordCount: { words: 0, chars: 0, charsNoSpaces: 0, lines: 0, paragraphs: 0, readingTimeMin: 0 },
  viewMode: "preview",
  prevViewMode: "preview",
  focusMode: false,
  sourceInsertHandler: null,
  undoHandler: null,
  redoHandler: null,
  showSearch: false,
  showSearchReplace: false,
  searchFocusKey: 0,
  openTabs: [],
  activeTabIdx: 0,
  // v0.4.0：默认 markdown，打开非 md 文件时由 App.tsx 设置为对应语言
  currentLanguage: "markdown",

  // v0.7.4 修复：不再清 translateUndoSnapshot——全文翻译/润色的"取消"快照应
  // 跨标签切换保留（切走再切回同一文档、且文档未编辑/未关闭时气泡仍在）。
  // 快照本身绑定 filePath/key，恢复时按归属校验；Toast 显示也按文件归属过滤，
  // 故跨文档不会误恢复/误显示。
  openFile: (path) => set({ filePath: path, isDirty: false, suppressAutoSave: false, cursorLine: 0 }),
  setCurrentLanguage: (lang) => set({ currentLanguage: lang }),
  setDirty: (dirty) => set({ isDirty: dirty }),
  setSuppressAutoSave: (v) => set({ suppressAutoSave: v }),
  setTranslateUndoSnapshot: (v) => set({ translateUndoSnapshot: v }),
  setCursorLine: (line) => set({ cursorLine: line }),
  setWordCount: (count) => set({ wordCount: count }),
  setViewMode: (mode) => set((s) => {
    // 记录上一个非分屏模式
    const prevMode = s.viewMode !== "split" ? s.viewMode : s.prevViewMode;
    return { viewMode: mode, prevViewMode: prevMode };
  }),
  toggleFocusMode: () => set((s) => ({ focusMode: !s.focusMode })),
  setSourceInsertHandler: (handler) => set({ sourceInsertHandler: handler }),
  setUndoHandler: (handler) => set({ undoHandler: handler }),
  setRedoHandler: (handler) => set({ redoHandler: handler }),
  // 开启搜索时递增 searchFocusKey，触发 SearchReplaceDialog 重新聚焦（解决 Ctrl+F 重复按无反应）
  setShowSearch: (show) => set((s) => show
    ? { showSearch: true, showSearchReplace: false, searchFocusKey: s.searchFocusKey + 1 }
    : { showSearch: false }),
  // 底部栏按钮切换：已开启则关闭，未开启则开启并聚焦
  toggleSearch: () => set((s) => s.showSearch
    ? { showSearch: false }
    : { showSearch: true, showSearchReplace: false, searchFocusKey: s.searchFocusKey + 1 }),
  setShowSearchReplace: (show) => set((s) => show
    ? { showSearchReplace: true, showSearch: true, searchFocusKey: s.searchFocusKey + 1 }
    : { showSearchReplace: false }),
  // 手动保存完成：同时解除翻译回写的自动保存抑制与取消快照（v0.6.1 问题2/3）
  markSaved: () => set({ isDirty: false, suppressAutoSave: false, translateUndoSnapshot: null }),
  addTab: (tab) => set((s) => {
    // 如果标签已存在（path 相同），切换到该标签并同步更新 name/content
    // 修复：通过文件夹打开文件时，旧逻辑仅切换不更新 name，导致标签显示目录名
    const existIdx = s.openTabs.findIndex((t) => t.path === tab.path);
    if (existIdx !== -1) {
      const existTab = s.openTabs[existIdx];
      const needUpdateName = existTab.name !== tab.name && tab.name;
      const needUpdateContent = tab.content !== undefined && existTab.content !== tab.content;
      if (needUpdateName || needUpdateContent) {
        return {
          openTabs: s.openTabs.map((t, i) =>
            i === existIdx
              ? {
                  ...t,
                  name: needUpdateName ? tab.name! : t.name,
                  content: needUpdateContent ? tab.content : t.content,
                }
              : t
          ),
          activeTabIdx: existIdx,
        };
      }
      return { activeTabIdx: existIdx };
    }
    // 否则添加新标签
    return {
      openTabs: [...s.openTabs, tab],
      activeTabIdx: s.openTabs.length,
    };
  }),
  // v0.6.3 P0-2/P2-4：切换激活标签时清除翻译撤销快照并解除自动保存抑制。……
  // v0.7.4 修复：切换激活标签不再清 translateUndoSnapshot——"取消翻译"气泡应
  // 在切走再切回同一文档时保留（恢复时按 filePath/key 归属校验，跨文档不会误恢复）。
  setActiveTab: (idx) =>
    set((s) => (idx === s.activeTabIdx
      ? { activeTabIdx: idx }
      : { activeTabIdx: idx, suppressAutoSave: false })),
  closeTab: (idx) => {
    const state = get();
    const closedTab = state.openTabs[idx] || null;
    // v0.7.4：清翻译快照仅当关闭的就是快照所属文件——保证"取消翻译"气泡跨标签
    // 切换保留（恢复时按 filePath/key 归属校验），且该文档被真正关闭后快照不残留
    const closedPath = closedTab?.path ?? null;
    const snap = state.translateUndoSnapshot;
    const clearTranslateState =
      idx === state.activeTabIdx || (snap !== null && snap.filePath === closedPath);
    set((s) => {
      const newTabs = s.openTabs.filter((_, i) => i !== idx);
      // 调整激活索引
      let newActiveIdx = s.activeTabIdx;
      if (idx < s.activeTabIdx) {
        newActiveIdx = s.activeTabIdx - 1;
      } else if (idx === s.activeTabIdx) {
        // 关闭当前标签，优先激活右侧，否则激活左侧
        newActiveIdx = Math.min(idx, Math.max(0, newTabs.length - 1));
      }
      if (newActiveIdx >= newTabs.length) {
        newActiveIdx = Math.max(0, newTabs.length - 1);
      }
      return {
        openTabs: newTabs,
        activeTabIdx: newActiveIdx,
        ...(clearTranslateState ? { translateUndoSnapshot: null, suppressAutoSave: false } : {}),
      };
    });
    return closedTab;
  },
  updateTabContent: (idx, content) => set((s) => ({
    openTabs: s.openTabs.map((t, i) => i === idx ? { ...t, content } : t),
  })),
  updateTabDirty: (idx, isDirty) => set((s) => ({
    openTabs: s.openTabs.map((t, i) => i === idx ? { ...t, isDirty } : t),
  })),
  getTabByPath: (path) => {
    return get().openTabs.findIndex((t) => t.path === path);
  },
}));
