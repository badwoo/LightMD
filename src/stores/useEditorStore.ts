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
  /** 回写时的 forceUpdateKey（外部内容替换计数，版本恢复/磁盘重载会变化） */
  key: number;
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

  openFile: (path) => set({ filePath: path, isDirty: false, suppressAutoSave: false, translateUndoSnapshot: null, cursorLine: 0 }),
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
  // v0.6.3 P0-2/P2-4：切换/关闭激活标签时清除翻译撤销快照并解除自动保存抑制。
  // 结构性防御：当前 App 层切换路径最终都会调 openFile（已清理），
  // 但 store 是公共 API，任何未走 openFile 的调用方不应留下跨文档的快照/抑制状态
  setActiveTab: (idx) =>
    set((s) => (idx === s.activeTabIdx
      ? { activeTabIdx: idx }
      : { activeTabIdx: idx, translateUndoSnapshot: null, suppressAutoSave: false })),
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
      // v0.6.3 P0-2：关闭的是激活标签 → 活跃文档变化，清除翻译快照/保存抑制
      const clearTranslateState = idx === s.activeTabIdx;
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
