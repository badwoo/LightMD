import { create } from "zustand";
import type { WordCountResult } from "../utils/wordCount";

export type ViewMode = "preview" | "edit" | "split";

export interface TabInfo {
  path: string;
  name: string;
  content?: string;
  isDirty?: boolean;
}

interface EditorState {
  filePath: string | null;
  isDirty: boolean;
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

  openFile: (path: string | null) => void;
  setDirty: (dirty: boolean) => void;
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

  openFile: (path) => set({ filePath: path, isDirty: false, cursorLine: 0 }),
  setDirty: (dirty) => set({ isDirty: dirty }),
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
  markSaved: () => set({ isDirty: false }),
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
  setActiveTab: (idx) => set({ activeTabIdx: idx }),
  closeTab: (idx) => {
    const state = get();
    const closedTab = state.openTabs[idx] || null;
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
      return { openTabs: newTabs, activeTabIdx: newActiveIdx };
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
