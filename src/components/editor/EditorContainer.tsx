/**
 * EditorContainer —— ProseMirror EditorView 的 React 挂载点
 *
 * 核心设计：
 * - 三个区域（ProseMirror 编辑器、textarea、分屏预览）始终渲染在 DOM 中
 * - 用 CSS 控制显隐和布局，确保 ref 始终有效
 * - 滚动联动：用 scroll 事件监听器持续追踪各区域滚动百分比，
 *   切换模式时直接使用已记录的值（而非从已隐藏元素读取）
 * - 任何模式下的修改，切换到其他模式时内容不丢失、滚动位置一致
 */
import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { createEditor, getMarkdownFromDoc, clearSerializationCache } from "../../core/editor";
import { markdownToDoc } from "../../core/markdown/parser";
import { TextSelection } from "prosemirror-state";
import { undo, redo } from "prosemirror-history";
import type { EditorView } from "prosemirror-view";
import { useEditorStore, type ViewMode } from "../../stores/useEditorStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useAutoSave } from "../../hooks/useAutoSave";
import { SearchReplaceDialog } from "./SearchReplace";
import { md } from "../../core/markdown/parser";
import "../../styles/editor.css";

// ─── 源码模式撤销/恢复栈（增量差异存储）──────────────
// 不再存储完整文档快照，只存储变化的片段，大幅节省内存
interface HistoryEntry {
  /** 变化起始位置 */
  start: number;
  /** 被删除的文本 */
  deleted: string;
  /** 被插入的文本 */
  inserted: string;
  /** 恢复后的光标位置 */
  cursorPos: number;
  /** 恢复后的滚动位置 */
  scrollTop: number;
}

const MAX_HISTORY = 30;

/** 计算两个字符串的最小差异（基于简单的前后缀匹配） */
function computeDiff(oldText: string, newText: string): { start: number; deleted: string; inserted: string } {
  // 找公共前缀
  let prefixLen = 0;
  const minLen = Math.min(oldText.length, newText.length);
  while (prefixLen < minLen && oldText[prefixLen] === newText[prefixLen]) {
    prefixLen++;
  }
  // 找公共后缀（不能与前缀重叠）
  let oldSuffixLen = 0;
  let newSuffixLen = 0;
  while (
    oldSuffixLen < (oldText.length - prefixLen) &&
    newSuffixLen < (newText.length - prefixLen) &&
    oldText[oldText.length - 1 - oldSuffixLen] === newText[newText.length - 1 - newSuffixLen]
  ) {
    oldSuffixLen++;
    newSuffixLen++;
  }
  return {
    start: prefixLen,
    deleted: oldText.substring(prefixLen, oldText.length - oldSuffixLen),
    inserted: newText.substring(prefixLen, newText.length - newSuffixLen),
  };
}

/** 将差异应用到文本（正向：撤销时用 deleted 替换 inserted） */
function applyDiff(text: string, entry: HistoryEntry, reverse: boolean): string {
  const deleted = reverse ? entry.inserted : entry.deleted;
  const inserted = reverse ? entry.deleted : entry.inserted;
  return text.substring(0, entry.start) + inserted + text.substring(entry.start + deleted.length);
}

function renderMarkdownToHtml(markdown: string): string {
  try {
    return md.render(markdown);
  } catch {
    return "<p>渲染失败</p>";
  }
}

interface EditorContainerProps {
  content?: string;
  filePath?: string | null;
  forceUpdateKey?: number;
  onEditorReady?: (view: EditorView) => void;
  onContentChange?: (markdown: string) => void;
}

// 格式工具栏按钮配置（静态常量，避免每次渲染重建）
const formatButtons = [
  { action: "undo", label: "↩", title: "撤销 (Ctrl+Z)", isUndoRedo: true },
  { action: "redo", label: "↪", title: "恢复 (Ctrl+Y)", isUndoRedo: true },
  { action: "sep1", label: "|", title: "", isSeparator: true },
  { action: "h1", label: "H1", title: "标题一" },
  { action: "h2", label: "H2", title: "标题二" },
  { action: "h3", label: "H3", title: "标题三" },
  { action: "bold", label: "B", title: "粗体" },
  { action: "italic", label: "I", title: "斜体" },
  { action: "code", label: "<>", title: "行内代码" },
  { action: "codeblock", label: "```", title: "代码块" },
  { action: "ul", label: "•", title: "无序列表" },
  { action: "task", label: "☑", title: "任务列表" },
  { action: "ol", label: "1.", title: "有序列表" },
  { action: "quote", label: "❝", title: "引用" },
  { action: "link", label: "🔗", title: "链接" },
  { action: "image", label: "🖼", title: "图片" },
  { action: "table", label: "⊞", title: "表格" },
  { action: "mermaid", label: "◈", title: "Mermaid 图表" },
  { action: "math", label: "∑", title: "数学公式" },
  { action: "hr", label: "—", title: "分割线" },
];

export function EditorContainer({ content = "", filePath, forceUpdateKey, onEditorReady, onContentChange }: EditorContainerProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onContentChangeRef = useRef(onContentChange);
  const onEditorReadyRef = useRef(onEditorReady);
  onContentChangeRef.current = onContentChange;
  onEditorReadyRef.current = onEditorReady;

  const setDirty = useEditorStore((s) => s.setDirty);
  const setCursorLine = useEditorStore((s) => s.setCursorLine);
  const setWordCount = useEditorStore((s) => s.setWordCount);
  const focusMode = useEditorStore((s) => s.focusMode);
  const viewMode = useEditorStore((s) => s.viewMode);
  const setSourceInsertHandler = useEditorStore((s) => s.setSourceInsertHandler);
  const setUndoHandler = useEditorStore((s) => s.setUndoHandler);
  const setRedoHandler = useEditorStore((s) => s.setRedoHandler);
  const showSearch = useEditorStore((s) => s.showSearch);
  const setShowSearch = useEditorStore((s) => s.setShowSearch);
  const showSearchReplace = useEditorStore((s) => s.showSearchReplace);
  const setShowSearchReplace = useEditorStore((s) => s.setShowSearchReplace);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const fontFamily = useSettingsStore((s) => s.fontFamily);
  const typewriterMode = useSettingsStore((s) => s.typewriterMode);

  const isSourceMode = viewMode === "edit" || viewMode === "split";

  useAutoSave(viewRef);

  const setDirtyRef = useRef(setDirty);
  const setCursorLineRef = useRef(setCursorLine);
  const setWordCountRef = useRef(setWordCount);
  setDirtyRef.current = setDirty;
  setCursorLineRef.current = setCursorLine;
  setWordCountRef.current = setWordCount;

  const wordCountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastContentRef = useRef(content);
  const lastForceUpdateKeyRef = useRef(forceUpdateKey);
  const lastSyncDiskRef = useRef(content);

  // 源码内容
  const [sourceContent, setSourceContent] = useState(content);
  const sourceTextareaRef = useRef<HTMLTextAreaElement>(null);
  const sourceContentRef = useRef(content);
  sourceContentRef.current = sourceContent;
  const lastTextareaCursorRef = useRef(0);

  // 分屏预览容器
  // iframe 引用在 previewIframeRef 中管理

  // ─── 撤销/恢复栈 ────────────────────────────────
  const undoStackRef = useRef<HistoryEntry[]>([]);
  const redoStackRef = useRef<HistoryEntry[]>([]);
  const isUndoRedoRef = useRef(false);

  // ─── 滚动联动（核心修复）────────────────────────
  // 持续追踪各区域的滚动百分比，切换模式时直接使用已记录的值
  // 而非从已隐藏（display:none）的元素上读取（此时 scrollHeight=0 无法计算）
  const pmScrollPercentRef = useRef(0);
  const textareaScrollPercentRef = useRef(0);
  const isSyncingScrollRef = useRef(false);
  // 待恢复的滚动信息：模式切换后需要延迟恢复滚动位置
  const pendingScrollRef = useRef<{ targetMode: ViewMode; percent: number } | null>(null);
  // 追踪上一个模式，用于判断切换方向
  const prevViewModeRef = useRef<ViewMode>(viewMode);

  // 当 content prop 变化（文件切换）时，同步 sourceContent
  useEffect(() => {
    if (isSourceMode) {
      setSourceContent(content);
      sourceContentRef.current = content;
    }
  }, [content, isSourceMode]);

  // ─── 撤销/恢复 ────────────────────────────────
  const pushUndoEntry = useCallback((entry: HistoryEntry) => {
    if (isUndoRedoRef.current) return;
    const stack = undoStackRef.current;
    const top = stack[stack.length - 1];

    // 尝试与栈顶合并连续的纯插入（连续打字）或纯删除（连续退格）
    if (top && entry.deleted === "" && top.deleted === "" &&
        entry.start === top.start + top.inserted.length) {
      // 连续纯插入：合并
      stack[stack.length - 1] = { ...top, inserted: top.inserted + entry.inserted };
    } else if (top && entry.inserted === "" && top.inserted === "" &&
               entry.start + entry.deleted.length === top.start) {
      // 连续向前删除（退格）：合并
      stack[stack.length - 1] = { ...top, start: entry.start, deleted: entry.deleted + top.deleted };
    } else if (top && entry.inserted === "" && top.inserted === "" &&
               entry.start === top.start) {
      // 连续向后删除（Delete键）：合并
      stack[stack.length - 1] = { ...top, deleted: top.deleted + entry.deleted };
    } else {
      stack.push(entry);
      if (stack.length > MAX_HISTORY) stack.shift();
    }
    redoStackRef.current = [];
  }, []);

  /** 记录编辑差异，直接推入 undoStack（合并连续操作） */
  const recordUndoEntry = useCallback((oldContent: string, newContent: string, cursorPos: number, scrollTop: number) => {
    if (isUndoRedoRef.current) return;
    const diff = computeDiff(oldContent, newContent);
    if (diff.deleted === "" && diff.inserted === "") return; // 无变化
    const entry: HistoryEntry = { ...diff, cursorPos, scrollTop };
    pushUndoEntry(entry);
  }, [pushUndoEntry]);

  const handleUndo = useCallback(() => {
    if (viewMode === "preview") {
      const view = viewRef.current;
      if (view) undo(view.state, view.dispatch);
      return;
    }
    const textarea = sourceTextareaRef.current;
    if (!textarea || undoStackRef.current.length === 0) return;
    // 将当前状态推入恢复栈（记录差异，正向：当前→撤销目标）
    const currentContent = sourceContentRef.current;
    const undoEntry = undoStackRef.current.pop()!;
    const undoneContent = applyDiff(currentContent, undoEntry, true);
    // 恢复栈存储反向差异（从撤销后状态恢复到当前状态）
    const redoDiff = computeDiff(undoneContent, currentContent);
    redoStackRef.current.push({ ...redoDiff, cursorPos: textarea.selectionStart, scrollTop: textarea.scrollTop });
    isUndoRedoRef.current = true;
    setSourceContent(undoneContent);
    sourceContentRef.current = undoneContent;
    onContentChangeRef.current?.(undoneContent);
    setDirtyRef.current(true);
    lastContentRef.current = undoneContent;
    requestAnimationFrame(() => {
      const ta = sourceTextareaRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(undoEntry.cursorPos, undoEntry.cursorPos);
        ta.scrollTop = undoEntry.scrollTop;
      }
      isUndoRedoRef.current = false;
    });
  }, [viewMode]);

  const handleRedo = useCallback(() => {
    if (viewMode === "preview") {
      const view = viewRef.current;
      if (view) redo(view.state, view.dispatch);
      return;
    }
    const textarea = sourceTextareaRef.current;
    if (!textarea || redoStackRef.current.length === 0) return;
    const currentContent = sourceContentRef.current;
    const redoEntry = redoStackRef.current.pop()!;
    const redoneContent = applyDiff(currentContent, redoEntry, false);
    // 撤销栈存储差异：从当前状态到恢复后状态，撤销时反向应用即可回到当前状态
    const undoDiff = computeDiff(currentContent, redoneContent);
    undoStackRef.current.push({ ...undoDiff, cursorPos: textarea.selectionStart, scrollTop: textarea.scrollTop });
    isUndoRedoRef.current = true;
    setSourceContent(redoneContent);
    sourceContentRef.current = redoneContent;
    onContentChangeRef.current?.(redoneContent);
    setDirtyRef.current(true);
    lastContentRef.current = redoneContent;
    requestAnimationFrame(() => {
      const ta = sourceTextareaRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(redoEntry.cursorPos, redoEntry.cursorPos);
        ta.scrollTop = redoEntry.scrollTop;
      }
      isUndoRedoRef.current = false;
    });
  }, [viewMode]);

  // ─── 注册撤销/恢复回调到 store ─────────────────
  useEffect(() => {
    setUndoHandler(handleUndo);
    setRedoHandler(handleRedo);
    return () => {
      setUndoHandler(null);
      setRedoHandler(null);
    };
  }, [handleUndo, handleRedo, setUndoHandler, setRedoHandler]);

  // ─── 语法插入回调 ────────────────────────────────
  useEffect(() => {
    if (isSourceMode) {
      const insertHandler = (syntax: string, cursorOffset?: number) => {
        const textarea = sourceTextareaRef.current;
        if (!textarea) return;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const currentContent = sourceContentRef.current;
        const selected = currentContent.substring(start, end);
        const newContent = currentContent.substring(0, start) + syntax + currentContent.substring(end);
        const scrollTop = textarea.scrollTop;
        // 直接推入差异（不用防抖，格式操作是离散的）
        const diff = computeDiff(currentContent, newContent);
        pushUndoEntry({ ...diff, cursorPos: start, scrollTop });
        setSourceContent(newContent);
        sourceContentRef.current = newContent;
        onContentChangeRef.current?.(newContent);
        setDirtyRef.current(true);
        lastContentRef.current = newContent;
        const cursorPos = selected ? start + syntax.length : (cursorOffset !== undefined ? start + cursorOffset : start + Math.floor(syntax.length / 2));
        const restore = () => {
          const ta = sourceTextareaRef.current;
          if (ta) {
            ta.focus();
            ta.setSelectionRange(cursorPos, cursorPos);
            ta.scrollTop = scrollTop;
            lastTextareaCursorRef.current = cursorPos;
          }
        };
        requestAnimationFrame(restore);
        setTimeout(restore, 50);
      };
      setSourceInsertHandler(insertHandler);
    } else {
      setSourceInsertHandler(null);
    }
    return () => setSourceInsertHandler(null);
  }, [isSourceMode, setSourceInsertHandler, pushUndoEntry]);

  // ─── 初始化编辑器（只执行一次）──────────────────
  useEffect(() => {
    const parent = editorRef.current;
    if (!parent) return;
    const view = createEditor({
      parent,
      initialContent: content,
      onDocChange: (markdown: string) => {
        // 更新 lastContentRef 防止 useEffect([content]) 重复解析
        lastContentRef.current = markdown;
        onContentChangeRef.current?.(markdown);
        setDirtyRef.current(true);
      },
      onSelectionChange: (line, wc) => {
        setCursorLineRef.current(line);
        if (wordCountTimerRef.current) clearTimeout(wordCountTimerRef.current);
        wordCountTimerRef.current = setTimeout(() => setWordCountRef.current(wc), 300);
      },
      onReady: (v) => {
        viewRef.current = v;
        onEditorReadyRef.current?.(v);
      },
    });
    if (view) viewRef.current = view;
    return () => {
      if (view) view.destroy();
      viewRef.current = null;
      // 清理字数统计定时器
      if (wordCountTimerRef.current) clearTimeout(wordCountTimerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── 持续追踪 ProseMirror 滚动百分比 ──────────
  // 编辑器创建后设置监听，在滚动时实时记录百分比
  useEffect(() => {
    const pmEditor = editorRef.current?.querySelector(".ProseMirror") as HTMLElement;
    if (!pmEditor) return;
    const handler = () => {
      const max = pmEditor.scrollHeight - pmEditor.clientHeight;
      pmScrollPercentRef.current = max > 0 ? pmEditor.scrollTop / max : 0;
    };
    pmEditor.addEventListener("scroll", handler);
    return () => pmEditor.removeEventListener("scroll", handler);
  }, [content, forceUpdateKey]); // 文件切换时 .ProseMirror 可能重建，重新绑定

  // ─── 持续追踪 textarea 滚动百分比 ──────────────
  useEffect(() => {
    const textarea = sourceTextareaRef.current;
    if (!textarea) return;
    const handler = () => {
      const max = textarea.scrollHeight - textarea.clientHeight;
      textareaScrollPercentRef.current = max > 0 ? textarea.scrollTop / max : 0;
    };
    textarea.addEventListener("scroll", handler);
    return () => textarea.removeEventListener("scroll", handler);
  }, []); // textarea 始终在 DOM 中，只需绑定一次

  // ─── 文件切换：更新编辑器内容 ──────────────────
  useEffect(() => {
    const view = viewRef.current;
    const forceUpdate = forceUpdateKey !== lastForceUpdateKeyRef.current;
    if (!view || content === undefined) return;
    if (!forceUpdate && content === lastContentRef.current) return;
    lastContentRef.current = content;
    lastForceUpdateKeyRef.current = forceUpdateKey;
    if (forceUpdate) lastSyncDiskRef.current = content;
    // 文件切换时清除序列化缓存，因为 doc 对象会变化
    if (forceUpdate) clearSerializationCache();
    try {
      const newDoc = markdownToDoc(content);
      const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, newDoc.content);
      tr.setSelection(TextSelection.atStart(tr.doc));
      tr.setMeta("fileSwitch", true);
      view.dispatch(tr);
    } catch (e) {
      console.error("更新编辑器内容失败:", e);
    }
  }, [content, forceUpdateKey]);

  // ─── 模式切换时同步内容 ──────────────────────
  // 核心原则：三个模式操作同一个文件，切换时内容不丢失
  // 滚动百分比已在 scroll 事件中持续追踪，此处直接使用
  //
  // 切换方向逻辑：
  // - 预览 → 编辑/分屏：从 ProseMirror 同步到 textarea（ProseMirror 是最新的）
  // - 编辑/分屏 → 预览：从 textarea 同步到 ProseMirror（textarea 是最新的）
  // - 编辑 ↔ 分屏：不需要同步内容（textarea 内容已经是最新的，只恢复滚动位置）
  useEffect(() => {
    const view = viewRef.current;
    const prevMode = prevViewModeRef.current;
    prevViewModeRef.current = viewMode;

    if (!view) return;

    // 判断切换方向
    const fromPreview = prevMode === "preview";
    const toPreview = viewMode === "preview";
    const fromSource = prevMode === "edit" || prevMode === "split";
    const toSource = isSourceMode;

    // 编辑 ↔ 分屏：不需要同步内容，只恢复滚动位置
    if (fromSource && toSource) {
      // textarea 内容已经是最新的，只需恢复滚动位置
      pendingScrollRef.current = {
        targetMode: viewMode,
        percent: textareaScrollPercentRef.current,
      };
      return;
    }

    // 确定来源模式的滚动百分比
    const sourcePercent = fromPreview
      ? pmScrollPercentRef.current
      : textareaScrollPercentRef.current;

    if (fromPreview && toSource) {
      // ── 预览 → 编辑/分屏：从 ProseMirror 同步到 textarea ──
      try {
        const mdText = getMarkdownFromDoc(view.state.doc);
        setSourceContent(mdText);
        sourceContentRef.current = mdText;

        // 映射光标位置
        const { from } = view.state.selection;
        const textBefore = view.state.doc.textBetween(0, from, "\n", "\n");
        const lineIndex = textBefore.split("\n").length - 1;

        pendingScrollRef.current = { targetMode: viewMode, percent: sourcePercent };

        requestAnimationFrame(() => {
          const textarea = sourceTextareaRef.current;
          if (textarea) {
            const lines = mdText.split("\n");
            let pos = 0;
            for (let i = 0; i < Math.min(lineIndex, lines.length - 1); i++) {
              pos += lines[i].length + 1;
            }
            textarea.focus();
            textarea.setSelectionRange(pos, pos);
          }
        });
      } catch {
        setSourceContent(content);
        sourceContentRef.current = content;
        pendingScrollRef.current = { targetMode: viewMode, percent: sourcePercent };
      }

      undoStackRef.current = [];
      redoStackRef.current = [];
    } else if (fromSource && toPreview) {
      // ── 编辑/分屏 → 预览：从 textarea 同步到 ProseMirror ──
      if (sourceContent) {
        try {
          const newDoc = markdownToDoc(sourceContent);
          const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, newDoc.content);

          // 映射光标位置
          const textarea = sourceTextareaRef.current;
          let targetPos = 1;
          const cursorPos = textarea?.selectionStart ?? lastTextareaCursorRef.current;
          if (textarea && textarea.selectionStart > 0) {
            lastTextareaCursorRef.current = textarea.selectionStart;
          }
          const textBefore = sourceContent.substring(0, cursorPos);
          const lineIndex = textBefore.split("\n").length - 1;

          let currentLine = 0;
          let found = false;
          newDoc.descendants((node, pos) => {
            if (found) return false;
            if (node.isBlock && node.type.name !== "doc") {
              if (currentLine === lineIndex) { targetPos = pos + 1; found = true; return false; }
              const nodeLines = (node.textContent || "").split("\n").length;
              if (currentLine + nodeLines > lineIndex) { targetPos = pos + 1; found = true; return false; }
              currentLine += nodeLines;
            }
            return true;
          });

          const safePos = Math.min(targetPos, tr.doc.content.size - 1);
          tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(1, safePos))));
          tr.setMeta("fileSwitch", true);
          view.dispatch(tr);

          pendingScrollRef.current = { targetMode: viewMode, percent: sourcePercent };

          onContentChangeRef.current?.(sourceContent);
          lastContentRef.current = sourceContent;
        } catch (e) {
          console.error("同步源码内容到预览模式失败:", e);
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode]);

  // ─── 延迟恢复滚动位置 ──────────────────────────
  // 等内容渲染完成后再恢复滚动，使用 sourceContent 和 viewMode 作为触发
  // 双重 rAF 确保浏览器完成布局计算
  useEffect(() => {
    if (!pendingScrollRef.current) return;
    const { targetMode, percent } = pendingScrollRef.current;
    pendingScrollRef.current = null;

    const applyScroll = () => {
      if (targetMode === "preview") {
        const pmEditor = editorRef.current?.querySelector(".ProseMirror") as HTMLElement;
        if (pmEditor) {
          const max = pmEditor.scrollHeight - pmEditor.clientHeight;
          pmEditor.scrollTop = max > 0 ? percent * max : 0;
        }
        viewRef.current?.focus();
      } else {
        const textarea = sourceTextareaRef.current;
        if (textarea) {
          const max = textarea.scrollHeight - textarea.clientHeight;
          textarea.scrollTop = max > 0 ? percent * max : 0;
          // 光标已在上面设置，此处不再重复 focus/setSelectionRange
        }
      }
    };

    // 双重 rAF：第一帧等 React 渲染完成，第二帧等浏览器布局完成
    requestAnimationFrame(() => {
      requestAnimationFrame(applyScroll);
    });
  }, [sourceContent, viewMode]);

  // ─── 源码编辑内容变化 ──────────────────────────
  const handleSourceChange = useRef((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newContent = e.target.value;
    const textarea = e.target;
    recordUndoEntry(
      sourceContentRef.current,
      newContent,
      textarea.selectionStart,
      textarea.scrollTop,
    );
    setSourceContent(newContent);
    onContentChangeRef.current?.(newContent);
    setDirtyRef.current(true);
    lastContentRef.current = newContent;
    lastTextareaCursorRef.current = textarea.selectionStart;
  });

  // ─── 格式工具栏操作 ────────────────────────────
  const handleFormatAction = useRef((action: string) => {
    const textarea = sourceTextareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const currentContent = sourceContentRef.current;
    const selected = currentContent.substring(start, end);
    const scrollTop = textarea.scrollTop;

    let replacement = "";
    let cursorOffset = 0;

    switch (action) {
      case "bold": replacement = `**${selected || "粗体文本"}**`; cursorOffset = selected ? replacement.length : 2; break;
      case "italic": replacement = `*${selected || "斜体文本"}*`; cursorOffset = selected ? replacement.length : 1; break;
      case "code": replacement = `\`${selected || "代码"}\``; cursorOffset = selected ? replacement.length : 1; break;
      case "codeblock": replacement = `\n\`\`\`\n${selected || "代码内容"}\n\`\`\`\n`; cursorOffset = selected ? 4 + selected.length + 5 : 5; break;
      case "h1": replacement = `# ${selected || "标题一"}`; cursorOffset = selected ? replacement.length : 2; break;
      case "h2": replacement = `## ${selected || "标题二"}`; cursorOffset = selected ? replacement.length : 3; break;
      case "h3": replacement = `### ${selected || "标题三"}`; cursorOffset = selected ? replacement.length : 4; break;
      case "ul": replacement = `- ${selected || "列表项"}`; cursorOffset = selected ? replacement.length : 2; break;
      case "task": replacement = `- [ ] ${selected || "任务项"}`; cursorOffset = selected ? replacement.length : 6; break;
      case "ol": replacement = `1. ${selected || "列表项"}`; cursorOffset = selected ? replacement.length : 3; break;
      case "quote": replacement = `> ${selected || "引用文本"}`; cursorOffset = selected ? replacement.length : 2; break;
      case "link": replacement = `[${selected || "链接文本"}](url)`; cursorOffset = selected ? selected.length + 3 : 1; break;
      case "image": replacement = `![${selected || "图片描述"}](url)`; cursorOffset = selected ? selected.length + 4 : 2; break;
      case "table": replacement = `\n| 列1 | 列2 | 列3 |\n|------|------|------|\n| 内容 | 内容 | 内容 |\n`; cursorOffset = 2; break;
      case "mermaid": replacement = `\n\`\`\`mermaid\ngraph TD\n    A[开始] --> B[结束]\n\`\`\`\n`; cursorOffset = 15; break;
      case "math": replacement = `\n$$\n\\sum_{i=1}^{n} x_i\n$$\n`; cursorOffset = 5; break;
      case "hr": replacement = `\n---\n`; cursorOffset = replacement.length; break;
      default: return;
    }

    // 直接推入差异（格式操作是离散的，不需要防抖）
    const diff = computeDiff(currentContent, currentContent.substring(0, start) + replacement + currentContent.substring(end));
    pushUndoEntry({ ...diff, cursorPos: start, scrollTop });
    const newContent = currentContent.substring(0, start) + replacement + currentContent.substring(end);
    setSourceContent(newContent);
    onContentChangeRef.current?.(newContent);
    setDirtyRef.current(true);
    lastContentRef.current = newContent;

    const newCursorPos = start + cursorOffset;
    const restore = () => {
      const ta = sourceTextareaRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(newCursorPos, newCursorPos);
        ta.scrollTop = scrollTop;
        lastTextareaCursorRef.current = newCursorPos;
      }
    };
    requestAnimationFrame(restore);
    setTimeout(restore, 50);
  });

  // ─── 专注模式 ──────────────────────────────────
  useEffect(() => {
    const editorDom = editorRef.current?.querySelector(".ProseMirror");
    if (editorDom) editorDom.classList.toggle("focus-mode", focusMode);
  }, [focusMode]);

  // ─── 字体 ──────────────────────────────────────
  useEffect(() => {
    const editorDom = editorRef.current?.querySelector(".ProseMirror") as HTMLElement;
    if (editorDom) {
      editorDom.style.setProperty("--editor-font-size", `${fontSize}px`);
      editorDom.style.setProperty("--editor-font-family", fontFamily);
    }
  }, [fontSize, fontFamily]);

  // ─── 打字机模式 ────────────────────────────────
  useEffect(() => {
    const editorDom = editorRef.current?.querySelector(".ProseMirror") as HTMLElement;
    if (editorDom) {
      editorDom.style.scrollBehavior = typewriterMode ? "smooth" : "auto";
      editorDom.style.scrollPaddingTop = typewriterMode ? "40vh" : "";
      editorDom.style.scrollPaddingBottom = typewriterMode ? "60vh" : "";
    }
  }, [typewriterMode]);

  // ─── 分屏预览防抖渲染 ──────────────────────────────
  // 首次进入分屏模式立即渲染，编辑时延迟 300ms 防抖，减少连续击键时的渲染开销
  const [debouncedSourceContent, setDebouncedSourceContent] = useState(sourceContent);
  const justEnteredSplitRef = useRef(false);
  // iframe 引用，用于分屏预览（隔离 DOM，减少主文档节点数）
  const previewIframeRef = useRef<HTMLIFrameElement>(null);

  // 追踪是否刚切换到分屏模式
  useEffect(() => {
    if (viewMode === "split" && prevViewModeRef.current !== "split") {
      justEnteredSplitRef.current = true;
    }
  }, [viewMode]);

  // 防抖：首次进入 split 立即渲染，编辑时延迟 300ms
  useEffect(() => {
    if (viewMode !== "split") return;
    if (justEnteredSplitRef.current) {
      setDebouncedSourceContent(sourceContent);
      justEnteredSplitRef.current = false;
      return;
    }
    const timer = setTimeout(() => setDebouncedSourceContent(sourceContent), 300);
    return () => clearTimeout(timer);
  }, [sourceContent, viewMode]);

  // 分屏预览 HTML（仅分屏模式才计算，基于防抖内容）
  // 将 mermaid 代码块转换为 mermaid 可识别的 <pre class="mermaid"> 格式
  // 将数学公式标记转换为 KaTeX 可渲染格式
  const previewHtml = useMemo(
    () => {
      if (viewMode !== "split") return "";
      let html = renderMarkdownToHtml(debouncedSourceContent);
      // 将 markdown-it 生成的 mermaid 代码块转换为 mermaid 渲染格式
      html = html.replace(
        /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
        '<pre class="mermaid">$1</pre>'
      );
      // 将 markdown-it katex 插件生成的公式标记转换为 KaTeX 渲染格式
      // 行内公式：<span data-math="inline" data-latex="..."> → 用 katex 渲染
      // 块级公式：<div data-math="block" data-latex="..."> → 用 katex 渲染
      return html;
    },
    [debouncedSourceContent, viewMode]
  );

  // 将预览 HTML 写入 iframe，隔离 DOM 减少 GC 压力
  // 支持 Mermaid 图表渲染：注入 mermaid 脚本并自动执行
  useEffect(() => {
    if (viewMode !== "split" || !previewHtml) return;
    const iframe = previewIframeRef.current;
    if (!iframe) return;
    const doc = iframe.contentDocument;
    if (!doc) return;
    // 获取当前主题的 CSS 变量
    const rootStyle = getComputedStyle(document.documentElement);
    const bgColor = rootStyle.getPropertyValue("--bg-primary").trim() || "#fff";
    const textColor = rootStyle.getPropertyValue("--text-primary").trim() || "#333";
    const fontSize = rootStyle.getPropertyValue("--editor-font-size").trim() || "16px";
    const fontFamily = rootStyle.getPropertyValue("--editor-font-family").trim() || "sans-serif";
    // 判断是否包含 mermaid 图表
    const hasMermaid = previewHtml.includes('class="mermaid"');
    // 判断是否包含数学公式
    const hasMath = previewHtml.includes('data-math="inline"') || previewHtml.includes('data-math="block"');
    doc.open();
    doc.write(`<!DOCTYPE html><html><head><style>
      body { margin: 16px; background: ${bgColor}; color: ${textColor}; font-size: ${fontSize}; font-family: ${fontFamily}; line-height: 1.6; }
      pre { background: var(--bg-secondary, #f5f5f5); padding: 12px; border-radius: 6px; overflow-x: auto; }
      code { font-family: "Cascadia Code", "Consolas", monospace; font-size: 0.9em; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 1px solid var(--border-color, #ddd); padding: 8px; text-align: left; }
      blockquote { border-left: 3px solid var(--accent-color, #5c9dff); padding-left: 12px; margin-left: 0; color: var(--text-secondary, #666); }
      img { max-width: 100%; }
      .mermaid-preview-container { text-align: center; margin: 1em 0; }
      .mermaid-preview-container svg { max-width: 100%; }
      .math-block-preview { text-align: center; margin: 1em 0; overflow-x: auto; }
      ul.task-list { list-style: none; padding-left: 0; }
      li.task-item { display: flex; align-items: flex-start; gap: 6px; margin: 0.3em 0; }
      .task-item input[type="checkbox"] { margin-top: 5px; accent-color: #5c9dff; }
      .task-item .task-checked { text-decoration: line-through; color: #999; }
    </style>
    ${hasMermaid ? '<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>' : ''}
    ${hasMath ? '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.17/dist/katex.min.css">' : ''}
    ${hasMath ? '<script src="https://cdn.jsdelivr.net/npm/katex@0.17/dist/katex.min.js"></script>' : ''}
    </head><body>${previewHtml}
    ${hasMermaid ? `<script>
      mermaid.initialize({ startOnLoad: true, theme: 'default', securityLevel: 'loose' });
    </script>` : ''}
    ${hasMath ? `<script>
      // 渲染行内公式
      document.querySelectorAll('[data-math="inline"]').forEach(function(el) {
        var latex = el.getAttribute('data-latex');
        if (latex) {
          try { katex.render(latex, el, { throwOnError: false, displayMode: false }); }
          catch(e) { el.textContent = '⚠ ' + e.message; }
        }
      });
      // 渲染块级公式
      document.querySelectorAll('[data-math="block"]').forEach(function(el) {
        var latex = el.getAttribute('data-latex');
        if (latex) {
          try { katex.render(latex, el, { throwOnError: false, displayMode: true }); }
          catch(e) { el.textContent = '⚠ ' + e.message; }
        }
      });
    </script>` : ''}
    </body></html>`);
    doc.close();
  }, [previewHtml, viewMode]);

  // ─── 分屏模式：左右滚动联动 ──────────────────
  useEffect(() => {
    if (viewMode !== "split") return;
    const textarea = sourceTextareaRef.current;
    const iframe = previewIframeRef.current;
    if (!textarea || !iframe) return;
    // iframe 预览区的滚动目标是其 contentDocument.documentElement
    const previewDoc = iframe.contentDocument;
    const preview = previewDoc?.documentElement || previewDoc?.body;
    if (!preview) return;

    const onTextareaScroll = () => {
      if (isSyncingScrollRef.current) return;
      isSyncingScrollRef.current = true;
      const maxScroll = textarea.scrollHeight - textarea.clientHeight;
      const percent = maxScroll > 0 ? textarea.scrollTop / maxScroll : 0;
      const previewMax = preview.scrollHeight - preview.clientHeight;
      preview.scrollTop = percent * previewMax;
      requestAnimationFrame(() => { isSyncingScrollRef.current = false; });
    };

    const onPreviewScroll = () => {
      if (isSyncingScrollRef.current) return;
      isSyncingScrollRef.current = true;
      const maxScroll = preview.scrollHeight - preview.clientHeight;
      const percent = maxScroll > 0 ? preview.scrollTop / maxScroll : 0;
      const textareaMax = textarea.scrollHeight - textarea.clientHeight;
      textarea.scrollTop = percent * textareaMax;
      requestAnimationFrame(() => { isSyncingScrollRef.current = false; });
    };

    textarea.addEventListener("scroll", onTextareaScroll);
    preview.addEventListener("scroll", onPreviewScroll);
    return () => {
      textarea.removeEventListener("scroll", onTextareaScroll);
      preview.removeEventListener("scroll", onPreviewScroll);
    };
  }, [viewMode, previewHtml]); // 依赖 previewHtml，因为 iframe 内容更新后需要重新绑定

  // ─── 格式工具栏 ────────────────────────────────
  const onFormatBtnClick = useCallback((action: string) => {
    if (action === "undo") { handleUndo(); return; }
    if (action === "redo") { handleRedo(); return; }
    if (action.startsWith("sep")) return;
    handleFormatAction.current(action);
  }, [handleUndo, handleRedo]);

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>
      {/* 空状态 */}
      {!content && viewMode === "preview" && (
        <div className="editor-empty-state">
          <div className="editor-empty-logo">LightMD</div>
          <div className="editor-empty-hint">打开文件或拖拽 .md 文件开始编辑</div>
        </div>
      )}

      {/* 格式工具栏（编辑/分屏模式） */}
      {isSourceMode && (
        <div className="source-format-toolbar">
          {formatButtons.map((btn) => {
            if (btn.isSeparator) return <span key={btn.action} className="format-separator">{btn.label}</span>;
            return (
              <button
                key={btn.action}
                className={`format-btn ${btn.isUndoRedo ? "format-btn-undo-redo" : ""}`}
                title={btn.title}
                onClick={() => onFormatBtnClick(btn.action)}
              >
                {btn.label}
              </button>
            );
          })}
        </div>
      )}

      {/* ─── 主内容区域 ──────────────────────────── */}
      <div className="editor-main-area">
        {/* ProseMirror 编辑器：预览模式可见 */}
        <div
          ref={editorRef}
          className="editor-container"
          style={{
            flex: viewMode === "preview" ? 1 : 0,
            display: viewMode === "preview" ? "flex" : "none",
            flexDirection: "column",
            overflow: "auto",
          }}
        />

        {/* textarea：编辑/分屏模式可见，始终渲染确保 ref 有效 */}
        <textarea
          ref={sourceTextareaRef}
          className={`source-editor ${viewMode === "split" ? "split-editor" : ""}`}
          value={sourceContent}
          onChange={handleSourceChange.current}
          spellCheck={false}
          style={{
            flex: isSourceMode ? 1 : 0,
            display: isSourceMode ? "block" : "none",
            fontSize: `${fontSize}px`,
            fontFamily: `${fontFamily}, "Cascadia Code", "Consolas", monospace`,
            borderRight: viewMode === "split" ? "1px solid var(--border-color)" : "none",
          }}
        />

        {/* 分屏预览区：使用 iframe 隔离 DOM，减少主文档节点数和 GC 压力 */}
        <iframe
          ref={previewIframeRef}
          className="split-preview ProseMirror"
          style={{
            flex: viewMode === "split" ? 1 : 0,
            display: viewMode === "split" ? "block" : "none",
            border: "none",
            width: viewMode === "split" ? "100%" : "0",
          }}
          title="预览"
          sandbox="allow-same-origin allow-scripts"
        />
      </div>

      {/* 搜索/替换 */}
      {(showSearch || showSearchReplace) && (
        <SearchReplaceDialog
          onClose={() => { setShowSearch(false); setShowSearchReplace(false); }}
          editorView={viewRef.current}
          sourceTextareaRef={sourceTextareaRef}
          sourceContent={sourceContent}
          onSourceContentChange={(newContent) => {
            setSourceContent(newContent);
            onContentChangeRef.current?.(newContent);
            setDirtyRef.current(true);
            lastContentRef.current = newContent;
          }}
        />
      )}
    </div>
  );
}
