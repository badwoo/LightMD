import { create } from "zustand";

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
  wordCount: number;
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
  // 多标签页
  openTabs: TabInfo[];
  activeTabIdx: number;

  openFile: (path: string | null) => void;
  setDirty: (dirty: boolean) => void;
  setCursorLine: (line: number) => void;
  setWordCount: (count: number) => void;
  setViewMode: (mode: ViewMode) => void;
  toggleFocusMode: () => void;
  setSourceInsertHandler: (handler: ((syntax: string, cursorOffset?: number) => void) | null) => void;
  setUndoHandler: (handler: (() => void) | null) => void;
  setRedoHandler: (handler: (() => void) | null) => void;
  setShowSearch: (show: boolean) => void;
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
  wordCount: 0,
  viewMode: "preview",
  prevViewMode: "preview",
  focusMode: false,
  sourceInsertHandler: null,
  undoHandler: null,
  redoHandler: null,
  showSearch: false,
  showSearchReplace: false,
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
  setShowSearch: (show) => set({ showSearch: show, showSearchReplace: false }),
  setShowSearchReplace: (show) => set({ showSearchReplace: show, showSearch: show }),
  markSaved: () => set({ isDirty: false }),
  addTab: (tab) => set((s) => {
    // 如果标签已存在（path 相同），切换到该标签
    const existIdx = s.openTabs.findIndex((t) => t.path === tab.path);
    if (existIdx !== -1) {
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
