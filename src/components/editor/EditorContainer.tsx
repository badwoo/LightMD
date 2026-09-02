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
import { focusModeKey } from "../../core/plugins/focus-mode";
import { setMermaidTheme } from "../../core/plugins/mermaid-block";
import { TextSelection } from "prosemirror-state";
import { undo, redo } from "prosemirror-history";
import type { EditorView } from "prosemirror-view";
import { useEditorStore, type ViewMode } from "../../stores/useEditorStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useAutoSave } from "../../hooks/useAutoSave";
import { useResizable } from "../../hooks/useResizable";
import { useT, t as translate } from "../../i18n";
import { SearchReplaceDialog } from "./SearchReplace";
import { LinkDialog } from "../dialogs/LinkDialog";
import { TableDialog } from "../dialogs/TableDialog";
import { ImageInsertDialog } from "../dialogs/ImageInsertDialog";
import { ImageEditDialog } from "../dialogs/ImageEditDialog";
import { EditorContextMenu } from "./EditorContextMenu";
import { SlashCommand, findSlashTrigger, isInCodeBlock, type InsertMode } from "./SlashCommand";
import { SlashCommandPm } from "./SlashCommandPm";
import type { SlashState } from "../../core/plugins/slash-command";
import { PAIR_MAP, PAIR_CLOSERS } from "../../core/plugins/auto-pair";
import { isHttpUrl } from "../../core/plugins/smart-paste";
import {
  buildFormatReplacement,
  parseShortcut,
  getHeadingPrefix,
  setLinePrefix as setLinePrefixFn,
  removeLinePrefix as removeLinePrefixFn,
  MERMAID_TEMPLATES,
  FORMAT_BUTTONS as formatButtons,
} from "./sourceFormat";
import { md } from "../../core/markdown/parser";
import { highlightCodeBlocksInHtml, getPrismCss, renderCodeFilePreview } from "../../utils/highlight";
import { isMarkdownFile, LARGE_FILE_THRESHOLD } from "../../utils/constants";
import { resolveImageSrc } from "../../utils/imagePath";
import { calculateWordCount } from "../../utils/wordCount";
import { findParagraphRange, measureTextareaRangeY, measureTextareaCursorY, destroyMirror, resolveLineHeight } from "../../utils/focus-paragraph";
import { isTypewriterTriggerKey, isModifierKey, computeTypewriterScrollTop, shouldSkipScrollForCharInput, computeScrollPercent, isCursorOutsideViewport, computeSyncScrollTop, shouldSkipInitialScrollToCenter, computeRestoreScrollTop, computeViewportCenter } from "../../utils/typewriter";
// v0.6.6 问题4：源码显示层 base64 内联图片短标记（mask/unmask/光标补偿）
import {
  maskBase64Images,
  unmaskBase64Images,
  hasRawBase64Image,
  adjustCursorForMask,
  type Base64Tokens,
} from "../../utils/base64ImageMask";
// v0.6.0：AI 翻译（气泡 + 桥接 + 服务）
import { TranslateBubble } from "./TranslateBubble";
import { useTranslateStore, type TranslateSourceMode, type BubbleAnchor } from "../../stores/translateStore";
import { translateService, TranslateServiceError, parseTranslateError } from "../../services/translateService";
import {
  extractFromSelection,
  extractFromIframe,
  applyTranslation,
  getTextareaSelectionAnchor,
  buildSourceRewrite,
} from "../../services/translateBridge";
// v0.6.1：全文翻译（悬浮按钮 + 切分/重组/循环 + 进度状态 + 版本快照）
import { FullTranslateButton } from "./FullTranslateButton";
import { ModeSwitchButton } from "./ModeSwitchButton";
import { TranslateUndoToast } from "./TranslateUndoToast";
import { useFullTranslateStore } from "../../stores/fullTranslateStore";
import {
  hasTranslatableText,
  splitDocumentForTranslation,
  rebuildTranslatedDocument,
  runFullTranslateLoop,
  createContextAbortChecker,
} from "../../services/fullTranslate";
import { versionSnapshotService } from "../../services/versionSnapshotService";
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
    return `<p>${translate("editor.renderFailed")}</p>`;
  }
}

/**
 * Issue 7：判断模式切换时是否跳过 ProseMirror doc 转换（纯函数，便于单元测试）
 *
 * 非 md 文件 ProseMirror 始终为空，切换模式时若走 getMarkdownFromDoc 会取到空字符串，
 * 覆盖 sourceContent 导致内容丢失。此函数封装跳过决策，保证非 md 文件直接保留 sourceContent。
 *
 * @param isMdFile 是否为 Markdown 文件
 * @param fromSource 来源模式是否为源码模式（edit/split）
 * @param toSource 目标模式是否为源码模式（edit/split）
 * @returns true 表示跳过 ProseMirror doc 转换，直接保留 sourceContent
 */
export function shouldSkipProseMirrorSync(isMdFile: boolean, fromSource: boolean, toSource: boolean): boolean {
  // 编辑 ↔ 分屏：不需要同步内容，只恢复滚动位置
  if (fromSource && toSource) return true;
  // 非 md 文件：ProseMirror 为空，跳过 doc 转换，避免内容丢失
  if (!isMdFile) return true;
  return false;
}

// v0.6.3 P2-14：翻译前快照时间节流（模块级，同一文件 10 分钟内只记录一次）
const TRANSLATE_SNAPSHOT_THROTTLE_MS = 10 * 60 * 1000;
let lastTranslateSnapshot = { path: "", at: 0 };

interface EditorContainerProps {
  content?: string;
  filePath?: string | null;
  forceUpdateKey?: number;
  onEditorReady?: (view: EditorView) => void;
  onContentChange?: (markdown: string) => void;
}

export function EditorContainer({ content = "", filePath, forceUpdateKey, onEditorReady, onContentChange }: EditorContainerProps) {
  const t = useT();
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // 专注模式遮罩层 ref（源码模式下使用）
  const focusOverlayRef = useRef<HTMLDivElement>(null);
  const onContentChangeRef = useRef(onContentChange);
  const onEditorReadyRef = useRef(onEditorReady);
  // v0.6.6 问题4：源码显示层 base64 短标记表（marker → dataUrl，会话内有效，不落盘）
  const base64TokensRef = useRef<Base64Tokens>(new Map());
  // 出口统一 unmask：上层（App.tsx 的 content state / Ctrl+S 保存 / localStorage）
  // 拿到的始终是真实内容（含完整 base64），磁盘格式不受显示层折叠影响
  onContentChangeRef.current = (masked: string) => {
    onContentChange?.(unmaskBase64Images(masked, base64TokensRef.current));
  };
  onEditorReadyRef.current = onEditorReady;

  const setDirty = useEditorStore((s) => s.setDirty);
  const setCursorLine = useEditorStore((s) => s.setCursorLine);
  const setWordCount = useEditorStore((s) => s.setWordCount);
  const focusMode = useEditorStore((s) => s.focusMode);
  const viewMode = useEditorStore((s) => s.viewMode);
  const setViewMode = useEditorStore((s) => s.setViewMode);
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
  const theme = useSettingsStore((s) => s.theme);
  // G10：拼写检查开关，控制 textarea 与 ProseMirror contenteditable 的 spellcheck 属性
  const spellcheckEnabled = useSettingsStore((s) => s.spellcheckEnabled);
  // N1：自动配对补全开关（textarea 源码模式；PM 端插件内部读取 store）
  const autoPairEnabled = useSettingsStore((s) => s.autoPairEnabled);
  // v0.4.0：分屏比例（持久化），用于 split 模式左右宽度分配
  const splitRatio = useSettingsStore((s) => s.splitRatio);
  const setSplitRatio = useSettingsStore((s) => s.setSplitRatio);
  // v0.6.0：AI 翻译总开关（右键菜单项显示 + 入口判断）
  const translateEnabled = useSettingsStore((s) => s.translate.translateEnabled);

  const isSourceMode = viewMode === "edit" || viewMode === "split";

  // v0.4.0：分屏分割条拖拽 hook（direction="split"，按容器总宽计算 ratio）
  const splitResizer = useResizable({
    initialWidth: 0,
    minWidth: 0,
    maxWidth: 0,
    direction: "split",
    initialRatio: splitRatio,
    onSplitChange: (r) => setSplitRatio(r),
  });
  // 分屏比例（优先用拖拽中的实时值，确保拖拽过程跟手）
  const effectiveSplitRatio = splitResizer.isDragging ? splitResizer.ratio : splitRatio;
  // 判断当前文件是否为 Markdown 文件
  // 非 Markdown 文件（txt/代码文件）不显示格式栏、不渲染 Markdown
  const isMdFile = isMarkdownFile(filePath || "");
  // v0.4.0：当前文件语言标识（由 App.tsx 在打开文件时设置），用于代码文件语法高亮
  const currentLanguage = useEditorStore((s) => s.currentLanguage);

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

  // v0.6.1 问题3：翻译回写进行中标记（PM dispatch 同步触发 onDocChange，用此 ref 区分翻译修改与用户输入）
  const applyingTranslationRef = useRef(false);

  // 源码内容
  const [sourceContent, setSourceContent] = useState(content);
  const sourceTextareaRef = useRef<HTMLTextAreaElement>(null);
  const sourceContentRef = useRef(content);
  sourceContentRef.current = sourceContent;
  const lastTextareaCursorRef = useRef(0);

  // 自动保存：需要在 sourceContentRef 声明之后调用
  // v0.6.6 问题4：getter ref 拦截读取——自动保存/版本快照拿到 unmask 后的真实内容
  // （textarea 显示层为短标记，写盘必须还原完整 base64）
  const autoSaveSourceRef = {
    get current() {
      return unmaskBase64Images(sourceContentRef.current, base64TokensRef.current);
    },
  } as React.MutableRefObject<string>;
  useAutoSave(viewRef, autoSaveSourceRef);

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
  // 待恢复的 iframe 滚动百分比：分屏模式下 iframe 内容异步加载，
  // applyScroll 执行时 iframe 可能还未写入内容或 scrollHeight 不准确，
  // 需在 iframe 写入完成后再设置 scrollTop
  const pendingIframeScrollRef = useRef<number | null>(null);
  // 追踪上一个模式，用于判断切换方向
  const prevViewModeRef = useRef<ViewMode>(viewMode);
  // 标记正在恢复滚动位置（模式切换后 applyScroll 尚未执行完）
  // 打字机 effect 的初始 scrollToCenter 检查此标志，避免 smooth 滚动覆盖 applyScroll 的 scrollTop
  const isRestoringScrollRef = useRef(false);

  // 当 content prop 变化（文件切换）时，同步 sourceContent
  // 编辑/分屏模式需要同步；非 md 文件在阅读模式下也需要同步（纯文本预览依赖 sourceContent）
  // v0.6.6 问题4：同步进入源码显示层前 mask base64 图片（短标记），
  // tokens 跨 content 更新保留（标记复用、序号稳定），文件切换时清空重建
  const lastMaskFilePathRef = useRef(filePath);
  useEffect(() => {
    if (isSourceMode || !isMdFile) {
      if (lastMaskFilePathRef.current !== filePath) {
        base64TokensRef.current = new Map();
        lastMaskFilePathRef.current = filePath;
      }
      const { text: masked } = maskBase64Images(content, base64TokensRef.current);
      setSourceContent(masked);
      sourceContentRef.current = masked;
    }
  }, [content, isSourceMode, isMdFile, filePath]);

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
    // v0.6.6 问题4：lastContentRef 与 content prop 同为真实坐标（unmask 后）
    lastContentRef.current = unmaskBase64Images(undoneContent, base64TokensRef.current);
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
    // v0.6.6 问题4：lastContentRef 与 content prop 同为真实坐标（unmask 后）
    lastContentRef.current = unmaskBase64Images(redoneContent, base64TokensRef.current);
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
        // v0.6.6 问题4：lastContentRef 与 content prop 同为真实坐标（unmask 后）
        lastContentRef.current = unmaskBase64Images(newContent, base64TokensRef.current);
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

  // ─── 打字机模式 ref ──────────────────────────────
  // 提前定义，供 createEditor 的 dispatchTransaction 拦截 ProseMirror 自动滚动
  // 原理：在特定操作（回车换行/方向键/点击）后滚动，使光标所在行位于视口中央
  // 注意：不监听 input 事件，避免每输入一个字符就跳动；
  //       内容未超出视口时不滚动，保证单行/少量内容时屏幕稳定
  // 核心判断逻辑已提取到 utils/typewriter.ts，便于单元测试
  const typewriterModeRef = useRef(typewriterMode);
  typewriterModeRef.current = typewriterMode;

  // ─── 初始化编辑器（只执行一次）──────────────────
  useEffect(() => {
    const parent = editorRef.current;
    if (!parent) return;
    const view = createEditor({
      parent,
      typewriterModeRef,
      // G10：传入 spellcheck 初始值，创建时即设置 .ProseMirror 的 spellcheck 属性
      spellcheckEnabled: useSettingsStore.getState().spellcheckEnabled,
      initialContent: content,
      onDocChange: (markdown: string) => {
        // 更新 lastContentRef 防止 useEffect([content]) 重复解析
        lastContentRef.current = markdown;
        onContentChangeRef.current?.(markdown);
        setDirtyRef.current(true);
        // v0.6.1 问题3：翻译回写（替换/双语）的修改不自动保存；
        // 用户手动输入则恢复正常自动保存
        useEditorStore.getState().setSuppressAutoSave(applyingTranslationRef.current);
        // v0.6.1 问题2：用户手动编辑后原文快照失效，清除"取消翻译"气泡
        if (!applyingTranslationRef.current) {
          useEditorStore.getState().setTranslateUndoSnapshot(null);
        }
      },
      onSelectionChange: (line, text) => {
        setCursorLineRef.current(line);
        if (wordCountTimerRef.current) clearTimeout(wordCountTimerRef.current);
        // G11：调用 calculateWordCount 计算字数详情（含字符数/行数/段落数/阅读时长）
        wordCountTimerRef.current = setTimeout(() => setWordCountRef.current(calculateWordCount(text)), 300);
      },
      onReady: (v) => {
        viewRef.current = v;
        onEditorReadyRef.current?.(v);
      },
      // v0.6.0：PM 选区「译」浮动按钮触发（ref 转发最新闭包，编辑器只创建一次）
      onTranslateTrigger: () => startTranslateRef.current(),
      // v0.6.0：总开关关闭时不显示选区浮动按钮（动态读取设置）
      translateEnabledGetter: () => useSettingsStore.getState().translate.translateEnabled,
      // v0.6.6 问题2：阅读模式 Slash 命令触发状态（插件检测后回调，驱动 SlashCommandPm 渲染）
      onSlashStateChange: (s) => setPmSlash(s),
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
  // 注意：元素变为 display:none 时 scrollHeight/clientHeight 均为 0，max=0，
  // 此时不应更新百分比（否则会被错误地置为 0，导致模式切换后滚动位置丢失）
  useEffect(() => {
    // 问题4修复：滚动容器从 .ProseMirror 改为 .editor-container
    // 移除 .ProseMirror overflow-y: auto 后，滚动发生在 editor-container 上
    const container = editorRef.current;
    if (!container) return;
    const handler = () => {
      const percent = computeScrollPercent(container.scrollHeight, container.clientHeight, container.scrollTop);
      if (percent !== null) {
        pmScrollPercentRef.current = percent;
      }
    };
    container.addEventListener("scroll", handler);
    return () => container.removeEventListener("scroll", handler);
  }, [content, forceUpdateKey]);

  // ─── 持续追踪 textarea 滚动百分比 ──────────────
  useEffect(() => {
    const textarea = sourceTextareaRef.current;
    if (!textarea) return;
    const handler = () => {
      const percent = computeScrollPercent(textarea.scrollHeight, textarea.clientHeight, textarea.scrollTop);
      if (percent !== null) {
        textareaScrollPercentRef.current = percent;
      }
    };
    textarea.addEventListener("scroll", handler);
    return () => textarea.removeEventListener("scroll", handler);
  }, []); // textarea 始终在 DOM 中，只需绑定一次

  // ─── 文件切换：更新编辑器内容 ──────────────────
  // 非 md 文件不需要更新 ProseMirror（阅读模式使用纯文本视图）
  useEffect(() => {
    if (!isMdFile) return;
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
  }, [content, forceUpdateKey, isMdFile]);

  // ─── 模式切换时同步内容 ──────────────────────
  // 核心原则：三个模式操作同一个文件，切换时内容不丢失
  // 滚动百分比已在 scroll 事件中持续追踪，此处直接使用
  //
  // 切换方向逻辑：
    // - 阅读 → 编辑/分屏：从 ProseMirror 同步到 textarea（ProseMirror 是最新的）
    // - 编辑/分屏 → 阅读：从 textarea 同步到 ProseMirror（textarea 是最新的）
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
    // Issue 7：非 md 文件也不走 ProseMirror doc 转换（ProseMirror 为空）
    // 用 shouldSkipProseMirrorSync 统一判断，保证非 md 文件直接保留 sourceContent
    if (shouldSkipProseMirrorSync(isMdFile, fromSource, toSource)) {
      const sourcePercent = fromPreview
        ? pmScrollPercentRef.current
        : textareaScrollPercentRef.current;
      pendingScrollRef.current = {
        targetMode: viewMode,
        percent: sourcePercent,
      };
      return;
    }

    // 确定来源模式的滚动百分比
    const sourcePercent = fromPreview
      ? pmScrollPercentRef.current
      : textareaScrollPercentRef.current;

    if (fromPreview && toSource) {
      // ── 阅读 → 编辑/分屏：从 ProseMirror 同步到 textarea ──
      try {
        // v0.6.6 问题4：PM 序列化输出含完整 base64 → 显示层 mask 为短标记
        // （data URL 不含换行，mask 不改变行结构，光标行号映射不受影响）
        const { text: mdMasked } = maskBase64Images(getMarkdownFromDoc(view.state.doc), base64TokensRef.current);
        setSourceContent(mdMasked);
        sourceContentRef.current = mdMasked;

        // 映射光标位置
        const { from } = view.state.selection;
        const textBefore = view.state.doc.textBetween(0, from, "\n", "\n");
        const lineIndex = textBefore.split("\n").length - 1;

        pendingScrollRef.current = { targetMode: viewMode, percent: sourcePercent };

        requestAnimationFrame(() => {
          const textarea = sourceTextareaRef.current;
          if (textarea) {
            const lines = mdMasked.split("\n");
            let pos = 0;
            for (let i = 0; i < Math.min(lineIndex, lines.length - 1); i++) {
              pos += lines[i].length + 1;
            }
            textarea.focus();
            textarea.setSelectionRange(pos, pos);
          }
        });
      } catch {
        const { text: fallbackMasked } = maskBase64Images(content, base64TokensRef.current);
        setSourceContent(fallbackMasked);
        sourceContentRef.current = fallbackMasked;
        pendingScrollRef.current = { targetMode: viewMode, percent: sourcePercent };
      }

      undoStackRef.current = [];
      redoStackRef.current = [];
    } else if (fromSource && toPreview) {
      // ── 编辑/分屏 → 阅读：从 textarea 同步到 ProseMirror ──
      if (sourceContent) {
        try {
          // v0.6.6 问题4：textarea 显示层是短标记 → 还原完整 base64 后再解析 PM doc
          const newDoc = markdownToDoc(unmaskBase64Images(sourceContent, base64TokensRef.current));
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
          console.error("同步源码内容到阅读模式失败:", e);
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
    // 标记正在恢复滚动位置，阻止打字机 effect 的初始 scrollToCenter 覆盖
    // 根因：打字机 effect 的 scrollToCenter 使用 smooth 滚动，是异步多帧的，
    // 会在 applyScroll（instant 设置）之后继续滚动，覆盖滚动位置
    isRestoringScrollRef.current = true;

    const applyScroll = () => {
      if (targetMode === "preview") {
        // 问题4修复：滚动容器从 .ProseMirror 改为 .editor-container
        const container = editorRef.current;
        if (container) {
          viewRef.current?.focus();
          const newTop = computeRestoreScrollTop(percent, container.scrollHeight, container.clientHeight);
          container.scrollTop = newTop ?? 0;
        }
        // 清理 iframe 待恢复标记，避免残留值影响后续切换
        pendingIframeScrollRef.current = null;
      } else {
        const textarea = sourceTextareaRef.current;
        if (textarea) {
          const newTop = computeRestoreScrollTop(percent, textarea.scrollHeight, textarea.clientHeight);
          textarea.scrollTop = newTop ?? 0;
        }
        // 修复：分屏模式下同步恢复 iframe 滚动位置
        // 根因：原代码只恢复 textarea，iframe 滚动位置丢失，需鼠标滚动一下才同步
        // iframe 内容在另一个 useEffect 中异步写入，此时可能尚未写入或 scrollHeight 不准确，
        // 因此先记录待恢复百分比，由 iframe 写入完成后再设置
        if (targetMode === "split") {
          pendingIframeScrollRef.current = percent;
          // 尝试立即设置（覆盖 iframe 已就绪的场景，如增量更新）
          const iframe = previewIframeRef.current;
          const preview = iframe?.contentDocument?.documentElement || iframe?.contentDocument?.body;
          if (preview) {
            const newTop = computeRestoreScrollTop(percent, preview.scrollHeight, preview.clientHeight);
            if (newTop !== null) {
              preview.scrollTop = newTop;
              pendingIframeScrollRef.current = null;
            }
          }
        }
      }
      // 恢复完成，允许打字机 effect 后续的 scrollToCenter
      isRestoringScrollRef.current = false;
    };

    // 双重 rAF：第一帧等 React 渲染完成，第二帧等浏览器布局完成
    requestAnimationFrame(() => {
      requestAnimationFrame(applyScroll);
    });
  }, [sourceContent, viewMode]);

  // ─── 源码编辑内容变化 ──────────────────────────
  const handleSourceChange = useRef((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const textarea = e.target;
    let newContent = textarea.value;
    let cursorPos = textarea.selectionStart;
    // v0.6.6 问题4：粘贴/输入 base64 图片 → 实时替换为短标记并补偿光标
    if (hasRawBase64Image(newContent)) {
      const { text: masked, replacements } = maskBase64Images(newContent, base64TokensRef.current);
      if (replacements.length > 0) {
        cursorPos = adjustCursorForMask(cursorPos, replacements);
        newContent = masked;
        // 受控组件：直接同步 DOM value 与光标（React setState 相同值不重渲染）
        textarea.value = masked;
        textarea.setSelectionRange(cursorPos, cursorPos);
      }
    }
    recordUndoEntry(
      sourceContentRef.current,
      newContent,
      cursorPos,
      textarea.scrollTop,
    );
    setSourceContent(newContent);
    onContentChangeRef.current?.(newContent);
    setDirtyRef.current(true);
    // v0.6.1 问题3：用户手动编辑恢复正常自动保存（解除翻译回写抑制）
    useEditorStore.getState().setSuppressAutoSave(false);
    // v0.6.1 问题2：用户手动编辑后原文快照失效，清除"取消翻译"气泡
    useEditorStore.getState().setTranslateUndoSnapshot(null);
    // lastContentRef 与 content prop 同为真实坐标（出口 unmask 后的值），
    // 保证行 551 的相等检查不会因坐标系不同而误触发 PM 全量重建
    lastContentRef.current = unmaskBase64Images(newContent, base64TokensRef.current);
    lastTextareaCursorRef.current = cursorPos;

    // G11：源码模式下更新字数统计（防抖 300ms，与 ProseMirror 模式一致）
    if (wordCountTimerRef.current) clearTimeout(wordCountTimerRef.current);
    wordCountTimerRef.current = setTimeout(() => setWordCountRef.current(calculateWordCount(newContent)), 300);

    // SlashCommand 触发检测：行首 / 且不在代码块内
    // 后续 query 更新和失效关闭由 SlashCommand 组件内部监听 input 处理
    const trigger = findSlashTrigger(newContent, cursorPos);
    if (trigger.trigger && !isInCodeBlock(newContent, cursorPos)) {
      setSlashCommandOpen(true);
    }
  });

  // ─── 在光标处插入文本（统一入口，供对话框 onInsert 复用）────────────
  // 复用 sourceInsertHandler 的差异记录与光标恢复逻辑
  const insertTextAtCursor = useCallback((text: string, cursorOffset?: number) => {
    const textarea = sourceTextareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const currentContent = sourceContentRef.current;
    const selected = currentContent.substring(start, end);
    const newContent = currentContent.substring(0, start) + text + currentContent.substring(end);
    const scrollTop = textarea.scrollTop;
    // v0.6.6 问题4：插入内容含 base64 图片（如 ImageInsertDialog）→ mask 为短标记
    let finalContent = newContent;
    let newCursorPos = selected ? start + text.length : (cursorOffset !== undefined ? start + cursorOffset : start + text.length);
    if (hasRawBase64Image(newContent)) {
      const { text: masked, replacements } = maskBase64Images(newContent, base64TokensRef.current);
      if (replacements.length > 0) {
        finalContent = masked;
        newCursorPos = adjustCursorForMask(newCursorPos, replacements);
      }
    }
    // 直接推入差异（对话框插入是离散操作，无需防抖）
    const diff = computeDiff(currentContent, finalContent);
    pushUndoEntry({ ...diff, cursorPos: start, scrollTop });
    setSourceContent(finalContent);
    sourceContentRef.current = finalContent;
    onContentChangeRef.current?.(finalContent);
    setDirtyRef.current(true);
    lastContentRef.current = unmaskBase64Images(finalContent, base64TokensRef.current);
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
  }, [pushUndoEntry]);

  // ─── SlashCommand 插入回调 ────────────────────────
  // mode="block"：删除当前行从行首（含 / 和过滤文字）到光标的内容，在行首插入 markdown
  // mode="inline"：用 markdown 替换当前选中文本（markdown 已是完整包裹字符串）
  // 菜单关闭由 SlashCommand 组件内部调用 onClose 处理，此处不主动关闭
  // 核心字符串变换逻辑提取为纯函数 computeSlashInsert（文件底部导出），便于单元测试
  const handleSlashInsert = useCallback((markdown: string, mode: InsertMode) => {
    const textarea = sourceTextareaRef.current;
    if (!textarea) return;
    const cursorPos = textarea.selectionStart;
    const selectionEnd = textarea.selectionEnd;
    const currentContent = sourceContentRef.current;
    const scrollTop = textarea.scrollTop;

    // 调用纯函数计算新内容与光标位置
    const { newContent, newCursorPos } = computeSlashInsert(
      currentContent,
      cursorPos,
      selectionEnd,
      markdown,
      mode
    );

    // 推入 undo 栈（离散操作，无需防抖）
    const diff = computeDiff(currentContent, newContent);
    pushUndoEntry({ ...diff, cursorPos, scrollTop });

    setSourceContent(newContent);
    sourceContentRef.current = newContent;
    onContentChangeRef.current?.(newContent);
    setDirtyRef.current(true);
    // v0.6.6 问题4：lastContentRef 与 content prop 同为真实坐标（unmask 后）
    lastContentRef.current = unmaskBase64Images(newContent, base64TokensRef.current);

    // 恢复光标位置（rAF + setTimeout 双保险，与 insertTextAtCursor 一致）
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
  }, [pushUndoEntry]);

  // ─── 对话框 open 状态 ────────────────────────────
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [linkInitialText, setLinkInitialText] = useState("");
  const [tableDialogOpen, setTableDialogOpen] = useState(false);
  const [imageDialogOpen, setImageDialogOpen] = useState(false);
  // ─── G3：图片编辑对话框状态 ────────────────────
  // imageEditSrc 为 resolve 后的可显示 URL（asset:// 或 data:）
  // imageEditPos 为 ProseMirror 文档中图片节点的位置，确认后通过 setNodeMarkup 修改 attrs.src
  const [imageEditDialogOpen, setImageEditDialogOpen] = useState(false);
  const [imageEditSrc, setImageEditSrc] = useState("");
  const [imageEditPos, setImageEditPos] = useState<number | null>(null);
  // ─── 右键菜单状态 ────────────────────────────────
  const [contextMenu, setContextMenu] = useState<{ open: boolean; x: number; y: number; hasSelection: boolean }>({
    open: false, x: 0, y: 0, hasSelection: false,
  });
  // ─── Mermaid 模板下拉状态 ────────────────────────
  const [mermaidMenuOpen, setMermaidMenuOpen] = useState(false);
  // ─── SlashCommand 菜单 open 状态 ───────────────────
  // 仅在源码模式 + Markdown 文件 + 行首输入 / 时打开
  const [slashCommandOpen, setSlashCommandOpen] = useState(false);
  // ─── v0.6.6 问题2：阅读模式 Slash 触发状态（由 ProseMirror 插件回调更新）───
  const [pmSlash, setPmSlash] = useState<SlashState | null>(null);

  // ─── 打开链接对话框（携带选中文本作为 initialText）────
  const openLinkDialog = useCallback(() => {
    const textarea = sourceTextareaRef.current;
    if (textarea) {
      const selected = sourceContentRef.current.substring(textarea.selectionStart, textarea.selectionEnd);
      setLinkInitialText(selected);
    }
    setLinkDialogOpen(true);
  }, []);

  // ─── G3：阅读模式图片点击监听 ────────────────────
  // 仅在 preview 模式监听 ProseMirror 容器的 click 事件，
  // 点击 img[data-editable] 时打开 ImageEditDialog，传入 resolve 后的 src
  // 确认编辑后通过 setNodeMarkup 修改 image 节点 attrs.src，自动触发 onDocChange 同步 sourceContent
  useEffect(() => {
    if (viewMode !== "preview") return;
    const container = editorRef.current;
    if (!container) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target || target.tagName !== "IMG") return;
      const img = target as HTMLImageElement;
      if (img.getAttribute("data-editable") !== "true") return;
      const view = viewRef.current;
      if (!view) return;
      // 通过 posAtDOM 找到图片节点位置
      const pos = view.posAtDOM(img, 0);
      if (pos < 0) return;
      // 阻止 ProseMirror 默认选择行为
      e.preventDefault();
      e.stopPropagation();
      // img.src 是 resolveImageSrc 后的 URL（asset:// 或 data: 或 http(s)）
      setImageEditSrc(img.src);
      setImageEditPos(pos);
      setImageEditDialogOpen(true);
    };
    container.addEventListener("click", handler, true);
    return () => container.removeEventListener("click", handler, true);
  }, [viewMode]);

  /** G3：图片编辑确认回调 —— 通过 setNodeMarkup 修改 image 节点 src attrs */
  const handleImageEditConfirm = useCallback((newSrc: string) => {
    const view = viewRef.current;
    if (!view || imageEditPos === null) {
      setImageEditDialogOpen(false);
      return;
    }
    try {
      const node = view.state.doc.nodeAt(imageEditPos);
      if (node && node.type.name === "image") {
        // 保留原 alt/title，仅替换 src 为编辑后的 Base64 dataUrl
        const tr = view.state.tr.setNodeMarkup(imageEditPos, undefined, {
          ...node.attrs,
          src: newSrc,
        });
        view.dispatch(tr);
      }
    } catch {
      // 节点位置无效时静默失败（避免编辑过程中文档已变更导致崩溃）
    }
    setImageEditDialogOpen(false);
    setImageEditPos(null);
    setImageEditSrc("");
  }, [imageEditPos]);

  // ─── 格式工具栏操作 ────────────────────────────
  // 通过 buildFormatReplacement 纯函数生成 replacement + cursorOffset，
  // 减少 switch 重复代码；mermaid 按钮点击改为打开下拉，不走此路径
  const handleFormatAction = useRef((action: string) => {
    // 归一化 H1-H6 按钮 action（"h1"~"h6"）到 heading 前缀路径（"heading1"~"heading6"），
    // 与快捷键 Ctrl+1~6 一致走行首替换逻辑，而非在光标位置插入文本
    if (/^h[1-6]$/.test(action)) {
      action = `heading${action[1]}`;
    }
    const textarea = sourceTextareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const currentContent = sourceContentRef.current;
    const selected = currentContent.substring(start, end);
    const scrollTop = textarea.scrollTop;

    // 行首类操作：Ctrl+1~6 在行首插入/替换标题，Ctrl+0 移除标题
    if (action === "paragraph") {
      const { replacement: newText, cursorOffset } = removeLinePrefixFn(currentContent, start);
      if (newText === currentContent) return; // 非标题行，无变化
      const diff = computeDiff(currentContent, newText);
      pushUndoEntry({ ...diff, cursorPos: start, scrollTop });
      setSourceContent(newText);
      sourceContentRef.current = newText;
      onContentChangeRef.current?.(newText);
      setDirtyRef.current(true);
      // v0.6.6 问题4：lastContentRef 与 content prop 同为真实坐标（unmask 后）
      lastContentRef.current = unmaskBase64Images(newText, base64TokensRef.current);
      const newCursorPos = start + cursorOffset;
      const restore = () => {
        const ta = sourceTextareaRef.current;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(newCursorPos, newCursorPos);
          ta.scrollTop = scrollTop;
        }
      };
      requestAnimationFrame(restore);
      setTimeout(restore, 50);
      return;
    }
    if (action.startsWith("heading")) {
      // heading1 ~ heading6：在行首插入/替换标题前缀
      const level = parseInt(action.slice("heading".length), 10);
      const prefix = getHeadingPrefix(level);
      const { replacement: newText, cursorOffset } = setLinePrefixFn(currentContent, start, prefix);
      const diff = computeDiff(currentContent, newText);
      pushUndoEntry({ ...diff, cursorPos: start, scrollTop });
      setSourceContent(newText);
      sourceContentRef.current = newText;
      onContentChangeRef.current?.(newText);
      setDirtyRef.current(true);
      // v0.6.6 问题4：lastContentRef 与 content prop 同为真实坐标（unmask 后）
      lastContentRef.current = unmaskBase64Images(newText, base64TokensRef.current);
      const newCursorPos = start + cursorOffset;
      const restore = () => {
        const ta = sourceTextareaRef.current;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(newCursorPos, newCursorPos);
          ta.scrollTop = scrollTop;
        }
      };
      requestAnimationFrame(restore);
      setTimeout(restore, 50);
      return;
    }

    // 通用行内/块级格式：调用纯函数生成 replacement
    const result = buildFormatReplacement(action, selected);
    if (!result) return;
    const { replacement, cursorOffset } = result;

    // 直接推入差异（格式操作是离散的，不需要防抖）
    const diff = computeDiff(currentContent, currentContent.substring(0, start) + replacement + currentContent.substring(end));
    pushUndoEntry({ ...diff, cursorPos: start, scrollTop });
    const newContent = currentContent.substring(0, start) + replacement + currentContent.substring(end);
    setSourceContent(newContent);
    onContentChangeRef.current?.(newContent);
    setDirtyRef.current(true);
    // v0.6.6 问题4：lastContentRef 与 content prop 同为真实坐标（unmask 后）
    lastContentRef.current = unmaskBase64Images(newContent, base64TokensRef.current);

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

  // ─── N2：智能粘贴 URL→链接（源码模式） ──────────
  // 粘贴单个 http(s) URL 时转为 Markdown 链接：无选区 → [url](url)；
  // 有选区 → [选中文字](url)。代码块内不处理。
  const handleSourcePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const ta = sourceTextareaRef.current;
    const text = e.clipboardData.getData("text/plain").trim();
    if (!ta || !isHttpUrl(text)) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    if (isInCodeBlock(ta.value, start)) return;
    e.preventDefault();
    const selected = ta.value.slice(start, end);
    // execCommand 触发 input 事件 → React onChange → undo 记录/内容同步
    document.execCommand("insertText", false, `[${selected || text}](${text})`);
  }, []);

  // ─── 源码模式快捷键处理器 ────────────────────────
  // 在 textarea 的 keydown 中拦截 Ctrl/Cmd 组合键，分发到对应 action
  // 注意：Ctrl+Shift+S 已被 App.tsx 占用为「另存为」，删除线改用 Ctrl+Alt+S
  const handleSourceKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!isSourceMode || !isMdFile) return;

    // N1：自动配对补全（先于快捷键解析：仅单字符、无修饰键）
    // 开符号 → 插入配对（有选区则包裹并保持选中）；闭符号与下一字符相同 → 跳过（光标右移）
    if (
      autoPairEnabled &&
      e.key.length === 1 &&
      !e.ctrlKey && !e.metaKey && !e.altKey
    ) {
      const ta = sourceTextareaRef.current;
      const key = e.key;
      const close = PAIR_MAP[key];
      const start = ta?.selectionStart ?? 0;
      const end = ta?.selectionEnd ?? 0;
      // 代码块内不配对（与 SlashCommand 的代码块判定一致）
      const inCode = ta ? isInCodeBlock(ta.value, start) : false;

      if (ta && !inCode && close) {
        e.preventDefault();
        const selected = ta.value.slice(start, end);
        // execCommand 触发 input 事件 → React onChange → undo 记录/内容同步
        ta.setSelectionRange(start, end);
        document.execCommand("insertText", false, key + selected + close);
        // 光标置于开符号后；有选区时保持原选中文本选中
        ta.setSelectionRange(start + 1, start + 1 + selected.length);
        return;
      }
      if (ta && !close && PAIR_CLOSERS.has(key) && ta.value[end] === key) {
        e.preventDefault();
        ta.setSelectionRange(end + 1, end + 1);
        return;
      }
    }

    const action = parseShortcut(e.nativeEvent);
    if (!action) return;
    e.preventDefault();
    // 阻止冒泡到 window，避免 App.tsx 的全局快捷键误触发
    e.stopPropagation();
    if (action === "math") {
      handleFormatAction.current("math");
    } else if (action === "paragraph") {
      handleFormatAction.current("paragraph");
    } else if (action.startsWith("heading")) {
      handleFormatAction.current(action);
    } else {
      handleFormatAction.current(action);
    }
  }, [isSourceMode, isMdFile, autoPairEnabled]);

  // ─── v0.6.0：AI 翻译入口接线 ────────────────────
  /** 当前翻译任务上下文（原文/来源通道/textarea 选区位置；重试与回写用） */
  const translateCtxRef = useRef<{
    text: string;
    sourceMode: TranslateSourceMode;
    anchor: BubbleAnchor;
    start?: number;
    end?: number;
  } | null>(null);
  // startTranslate/handleTranslateApply 的最新引用转发（createEditor 只初始化一次 + 命令监听挂载一次）
  // v0.6.2 问题3：startTranslate 支持 fallbackToFull 参数（「译」按钮无选区时回退全文翻译）
  const startTranslateRef = useRef<(fallbackToFull?: boolean) => void>(() => {});
  const handleTranslateApplyRef = useRef<(mode: "replace" | "bilingual", translated: string) => void>(() => {});

  // v0.6.3 P0-1/P0-2：当前活跃文档上下文（latest-ref，每次渲染刷新）。
  // - 全文翻译 shouldAbort 用「任务启动闭包快照 vs 此 ref」检测标签切换
  // - 翻译撤销快照的写入/校验用它读写当前 filePath/forceUpdateKey
  //   （handleTranslateApply 等空依赖 useCallback 拿不到最新 props，必须走 ref）
  const activeFileRef = useRef<string | null | undefined>(undefined);
  activeFileRef.current = filePath;
  const activeKeyRef = useRef<number>(0);
  activeKeyRef.current = forceUpdateKey ?? 0;

  /** 执行翻译任务：打开气泡 → 流式调用 → finish/fail；resultMode 非 bubble 时自动应用结果 */
  const runTranslate = useCallback((
    text: string,
    sourceMode: TranslateSourceMode,
    anchor: BubbleAnchor,
    start?: number,
    end?: number,
  ) => {
    // v0.6.2 问题4：无可译文字（纯符号/纯链接选区）静默返回，不发请求省 token
    if (!hasTranslatableText(text)) return;
    translateCtxRef.current = { text, sourceMode, anchor, start, end };
    useTranslateStore.getState().openBubble(sourceMode, anchor);

    const cfg = useSettingsStore.getState().translate;
    translateService
      .translate(text, (chunk) => useTranslateStore.getState().appendChunk(chunk))
      .then((result) => {
        useTranslateStore.getState().finish(result);
        const mode = cfg.translateResultMode;
        // preview 通道无回写能力，强制气泡交互；clipboard 模式对任何通道均直接复制
        if (mode === "clipboard") {
          navigator.clipboard?.writeText(result.translated).catch(() => undefined);
          useTranslateStore.getState().close();
        } else if (sourceMode !== "preview" && (mode === "replace" || mode === "bilingual")) {
          handleTranslateApplyRef.current(mode, result.translated);
        }
      })
      .catch((e) => {
        const info = e instanceof TranslateServiceError ? e.info : parseTranslateError(e);
        // CANCELLED 静默：新任务已 openBubble 重置状态，旧任务的 fail 会污染新任务
        if (info.code === "CANCELLED") return;
        useTranslateStore.getState().fail(info.code, info.detail);
      });
  }, []);

  /**
   * 翻译触发入口（右键菜单 / F6 / 命令面板 / PM 选区浮动按钮统一走这里）。
   * 总开关关闭时所有入口静默返回。
   * 按当前模式选择提取通道：
   * - preview+md：PM 选区（Markdown 结构保真，可回写）
   * - edit/split：textarea 选区（Markdown 源码直接回写）
   * - split 且 textarea 无选区：iframe 预览选区（纯文本，仅复制）
   * - preview+非 md：DOM 选区（纯文本，仅复制）
   * v0.6.2 问题3：fallbackToFull=true 时（「译」按钮入口），所有通道均无有效选区
   * 则回退到全文翻译（非 md 文件全文翻译不支持，静默返回）
   */
  const startTranslate = useCallback((fallbackToFull?: boolean) => {
    // 总开关关闭：所有翻译入口不响应
    if (!useSettingsStore.getState().translate.translateEnabled) return;
    // v0.6.3 P1-2：全文翻译运行中不响应选中翻译——translateService.translate 无条件取消旧任务，
    // 会导致整篇翻译被静默中止且已完成段落的译文全部作废
    if (useFullTranslateStore.getState().status === "running") return;

    // 1. PM 阅读模式（md 文件）
    if (viewMode === "preview" && isMdFile) {
      const view = viewRef.current;
      if (!view) return;
      const extract = extractFromSelection(view);
      if (!extract) {
        // v0.6.2 问题3：无有效选区且来自「译」按钮 → 回退全文翻译
        if (fallbackToFull) startFullTranslateRef.current();
        return;
      }
      let anchor: BubbleAnchor;
      try {
        const coords = view.coordsAtPos(view.state.selection.to);
        anchor = { x: coords.left, y: coords.bottom };
      } catch {
        anchor = { x: window.innerWidth / 2, y: 100 };
      }
      runTranslate(extract.text, "pm", anchor);
      return;
    }

    // 2. 源码模式（edit/split）：textarea 选区优先
    if (isSourceMode) {
      const textarea = sourceTextareaRef.current;
      if (textarea && textarea.selectionStart !== textarea.selectionEnd) {
        const text = sourceContentRef.current.slice(textarea.selectionStart, textarea.selectionEnd);
        if (text.trim()) {
          runTranslate(text, "source", getTextareaSelectionAnchor(textarea), textarea.selectionStart, textarea.selectionEnd);
          return;
        }
      }
      // 3. split 模式 textarea 无选区 → iframe 预览选区（纯文本通道）
      if (viewMode === "split") {
        const iframe = previewIframeRef.current;
        const doc = iframe?.contentDocument;
        const text = doc ? extractFromIframe(doc) : null;
        if (doc && text) {
          const sel = doc.getSelection();
          const iframeRect = iframe!.getBoundingClientRect();
          let anchor: BubbleAnchor = { x: iframeRect.left + 100, y: iframeRect.top + 100 };
          if (sel && sel.rangeCount > 0) {
            const rect = sel.getRangeAt(0).getBoundingClientRect();
            anchor = { x: iframeRect.left + rect.right, y: iframeRect.top + rect.bottom };
          }
          runTranslate(text, "preview", anchor);
          return;
        }
      }
      // v0.6.2 问题3：textarea 与 iframe 均无选区且来自「译」按钮 → 回退全文翻译
      if (fallbackToFull) startFullTranslateRef.current();
      return;
    }

    // 4. preview+非 md 文件：主文档 DOM 选区（纯文本通道）
    if (viewMode === "preview" && !isMdFile) {
      const sel = document.getSelection();
      const text = sel ? sel.toString().trim() : "";
      if (sel && text && sel.rangeCount > 0) {
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        runTranslate(text, "preview", { x: rect.right, y: rect.bottom });
      }
    }
  }, [viewMode, isMdFile, isSourceMode, runTranslate]);
  startTranslateRef.current = startTranslate;

  /** 译文回写：pm 通道走 translateBridge（replace 失败降级 bilingual）；source 通道走 buildSourceRewrite */
  const handleTranslateApply = useCallback((mode: "replace" | "bilingual", translated: string) => {
    const ctx = translateCtxRef.current;
    if (!ctx || !translated.trim()) return;

    if (ctx.sourceMode === "pm") {
      const view = viewRef.current;
      if (!view) return;
      // v0.6.1 问题2：记录回写前全文快照（取消翻译恢复用）
      let original: string | null = null;
      try {
        original = getMarkdownFromDoc(view.state.doc);
      } catch {
        original = null;
      }
      // replace 失败（结构失配/解析失败）自动降级 bilingual 引用块插入
      // v0.6.1 问题3：标记翻译回写中，onDocChange 据此抑制自动保存
      applyingTranslationRef.current = true;
      let ok = false;
      try {
        ok = applyTranslation(view, translated, mode) ||
          (mode === "replace" && applyTranslation(view, translated, "bilingual"));
      } finally {
        applyingTranslationRef.current = false;
      }
      if (ok) {
        useTranslateStore.getState().close();
        translateCtxRef.current = null;
        // v0.6.1 问题2：回写成功后记录原文快照，显示"取消翻译"气泡
        // v0.6.3 P0-2：快照绑定文档上下文（filePath/key），恢复前校验归属
        if (original !== null) {
          useEditorStore.getState().setTranslateUndoSnapshot({
            content: original,
            filePath: activeFileRef.current ?? null,
            key: activeKeyRef.current,
          });
        }
      }
      // 失败保留气泡，用户可复制译文
      return;
    }

    if (ctx.sourceMode === "source" && ctx.start !== undefined && ctx.end !== undefined) {
      const rewrite = buildSourceRewrite(sourceContentRef.current, ctx.start, ctx.end, translated, mode);
      if (!rewrite) return;
      // v0.6.1 问题2：记录回写前全文快照（取消翻译恢复用）
      const original = sourceContentRef.current;
      setSourceContent(rewrite.content);
      onContentChangeRef.current?.(rewrite.content);
      setDirtyRef.current(true);
      // v0.6.1 问题3：翻译回写的修改不自动保存
      useEditorStore.getState().setSuppressAutoSave(true);
      // v0.6.1 问题2：记录原文快照，显示"取消翻译"气泡
      // v0.6.3 P0-2：快照绑定文档上下文（filePath/key），恢复前校验归属
      useEditorStore.getState().setTranslateUndoSnapshot({
        content: original,
        filePath: activeFileRef.current ?? null,
        key: activeKeyRef.current,
      });
      // v0.6.6 问题4：lastContentRef 与 content prop 同为真实坐标（unmask 后）
      lastContentRef.current = unmaskBase64Images(rewrite.content, base64TokensRef.current);
      useTranslateStore.getState().close();
      translateCtxRef.current = null;
      // 光标移到译文末尾并聚焦
      const textarea = sourceTextareaRef.current;
      if (textarea) {
        requestAnimationFrame(() => {
          textarea.focus();
          textarea.setSelectionRange(rewrite.cursor, rewrite.cursor);
        });
      }
    }
  }, []);
  handleTranslateApplyRef.current = handleTranslateApply;

  /** 复制译文到剪贴板 */
  const handleTranslateCopy = useCallback((text: string) => {
    navigator.clipboard?.writeText(text).catch(() => undefined);
  }, []);

  /** 重试上次翻译（复用任务上下文的原文与来源通道，锚点取当前气泡位置） */
  const handleTranslateRetry = useCallback(() => {
    const ctx = translateCtxRef.current;
    if (!ctx) return;
    const anchor = useTranslateStore.getState().anchor ?? ctx.anchor;
    runTranslate(ctx.text, ctx.sourceMode, anchor, ctx.start, ctx.end);
  }, [runTranslate]);

  // ─── v0.6.1：全文翻译 ────────────────────
  const startFullTranslateRef = useRef<() => void>(() => {});

  /**
   * 全文翻译回写（一次性替换整篇文档）。
   * - preview+md：直接替换 PM doc（单事务，Ctrl+Z 可整体撤销）
   * - 任意模式：同步 sourceContent 与 App 层 content state，置脏
   * - v0.6.1 问题2：undoSnapshot 非空时记录原文快照（显示"取消翻译"气泡）
   */
  const applyFullTranslation = useCallback((newContent: string, undoSnapshot?: string) => {
    // v0.6.6 问题4：坐标归一化——输入可能来自全文翻译（真实内容）或
    // 选中翻译回写的快照（masked 坐标），先 unmask 统一为真实内容
    const realContent = unmaskBase64Images(newContent, base64TokensRef.current);
    // PM 模式直接替换 doc；设置 lastContentRef 防止 content effect 重复替换
    if (viewMode === "preview" && viewRef.current) {
      try {
        const view = viewRef.current;
        const newDoc = markdownToDoc(realContent);
        const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, newDoc.content);
        tr.setSelection(TextSelection.atStart(tr.doc));
        tr.setMeta("fileSwitch", true); // 整篇替换后滚动交由联动逻辑处理
        // v0.6.1 问题3：标记翻译回写中，onDocChange 据此抑制自动保存
        applyingTranslationRef.current = true;
        try {
          view.dispatch(tr);
        } finally {
          applyingTranslationRef.current = false;
        }
      } catch {
        // PM 解析失败：仍写入 sourceContent（切模式时同步），不阻断
      }
    }
    // 显示层 mask（无 base64 时零开销原样返回）；lastContentRef 存真实坐标
    const { text: masked } = maskBase64Images(realContent, base64TokensRef.current);
    setSourceContent(masked);
    sourceContentRef.current = masked;
    lastContentRef.current = realContent;
    // 出口统一 unmask：onContentChange 拿到的是真实内容（masked → realContent）
    onContentChangeRef.current?.(masked);
    setDirtyRef.current(true);
    // v0.6.1 问题3：全文翻译回写的修改不自动保存，等待用户手动保存或继续编辑
    useEditorStore.getState().setSuppressAutoSave(true);
    // v0.6.1 问题2：记录原文快照（undefined 表示不更新，如恢复原文场景）
    // v0.6.3 P0-2：快照绑定文档上下文（filePath/key），恢复前校验归属
    if (undoSnapshot !== undefined) {
      useEditorStore.getState().setTranslateUndoSnapshot({
        content: undoSnapshot,
        filePath: activeFileRef.current ?? null,
        key: activeKeyRef.current,
      });
    }
  }, [viewMode]);

  /**
   * v0.6.1 问题2：取消翻译 —— 用原文快照整体恢复文档。
   * 恢复的是原文（磁盘已知内容），不抑制自动保存；
   * 恢复后内容与最近磁盘同步一致时清除脏标记
   */
  const undoTranslation = useCallback(() => {
    const snap = useEditorStore.getState().translateUndoSnapshot;
    if (snap === null) return;
    // v0.6.3 P0-2：快照绑定文档上下文——文件路径或外部更新计数不匹配时快照已失效，
    // 拒绝恢复并清除（防止 A 文件的原文灌进 B 文件/覆盖版本恢复的内容）
    if (snap.filePath !== (activeFileRef.current ?? null) || snap.key !== activeKeyRef.current) {
      useEditorStore.getState().setTranslateUndoSnapshot(null);
      useEditorStore.getState().setSuppressAutoSave(false);
      return;
    }
    const original = snap.content;
    // 恢复原文：不记录新快照（清除气泡）、解除自动保存抑制
    // v0.6.6 问题4：快照可能是 masked 坐标（选中翻译回写场景），
    // applyFullTranslation 内部归一化；与磁盘内容比较也需统一为真实坐标
    applyFullTranslation(original);
    useEditorStore.getState().setTranslateUndoSnapshot(null);
    useEditorStore.getState().setSuppressAutoSave(false);
    // 恢复后内容与最近磁盘内容一致 → 不再是脏状态
    if (unmaskBase64Images(original, base64TokensRef.current) === lastSyncDiskRef.current) {
      setDirtyRef.current(false);
      const { activeTabIdx } = useEditorStore.getState();
      useEditorStore.getState().updateTabDirty(activeTabIdx, false);
    }
  }, [applyFullTranslation]);

  // ── v0.6.4 问题1c：失败段气泡 ──────────────────────────────
  // 翻译失败的段在内容首处以气泡提示（底部栏不再显示失败），5 秒后自动消失
  const [segmentFailTip, setSegmentFailTip] = useState<{ text: string; count: number } | null>(null);
  const segmentFailTipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 显示失败段气泡（重复调用重置计时；切文档/再次翻译时由调用方清除） */
  const showSegmentFailTip = useCallback((failedText: string, totalFailed: number) => {
    if (segmentFailTipTimerRef.current) clearTimeout(segmentFailTipTimerRef.current);
    setSegmentFailTip({ text: failedText, count: totalFailed });
    segmentFailTipTimerRef.current = setTimeout(() => setSegmentFailTip(null), 5000);
  }, []);

  /**
   * 全文翻译入口（悬浮按钮 / Shift+F6 / 命令面板统一走这里）。
   * 流程：取全文 → 切分 → 快照 → 逐段串行翻译（进度/取消）→ 一次性重组回写。
   * 失败安全：任何失败/中断/标签切换路径均不写入，原文零破坏。
   */
  const startFullTranslate = useCallback(() => {
    const ftStore = useFullTranslateStore.getState();
    // 运行中再次触发 = 取消
    if (ftStore.status === "running") {
      ftStore.requestCancel();
      translateService.cancel().catch(() => undefined);
      return;
    }
    if (!useSettingsStore.getState().translate.translateEnabled) return;
    if (!isMdFile) return; // 非 md 代码文件不支持全文翻译

    // 取当前全文内容（preview 走 PM 序列化；edit/split 走 sourceContent）
    // v0.6.6 问题4：sourceContent 是 masked 短标记坐标 → unmask 还原真实内容，
    // 保证版本快照、回写校验与译文重组都在真实坐标系进行
    let fullText: string;
    if (viewMode === "preview") {
      const view = viewRef.current;
      if (!view) return;
      try {
        fullText = getMarkdownFromDoc(view.state.doc);
      } catch {
        return;
      }
    } else {
      fullText = unmaskBase64Images(sourceContentRef.current, base64TokensRef.current);
    }

    const units = splitDocumentForTranslation(fullText);
    if (units.length === 0) return; // 无可译内容（纯代码/空文档）静默返回

    // 快照先行（有文件路径时），支持从版本历史恢复原文
    // v0.6.3 P2-14：时间节流——同一文件 10 分钟内不重复记录翻译前快照，
    // 避免反复触发全文翻译把用户真实的版本历史挤掉（上限 5 条）
    if (
      filePath &&
      (lastTranslateSnapshot.path !== filePath ||
        Date.now() - lastTranslateSnapshot.at > TRANSLATE_SNAPSHOT_THROTTLE_MS)
    ) {
      lastTranslateSnapshot = { path: filePath, at: Date.now() };
      versionSnapshotService.recordSnapshot(filePath, fullText).catch(() => undefined);
    }

    // v0.6.3 P0-1：中止判断 = 任务启动上下文（闭包快照）vs 当前活跃上下文（latest-ref）。
    // 原实现拿闭包捕获值与启动时写入的 ref 比较，结构性恒 false，切标签后译文会写入错误文档
    ftStore.start(units.length);
    const shouldAbort = createContextAbortChecker(
      { filePath, key: forceUpdateKey ?? 0 },
      () => ({ filePath: activeFileRef.current, key: activeKeyRef.current }),
      () => useFullTranslateStore.getState().cancelRequested,
    );

    runFullTranslateLoop(units, {
      // 复用选中翻译通道（Rust 单任务模型，一次一段；流式 chunk 不展示）
      translateUnit: (text) => translateService.translate(text, () => undefined),
      onProgress: () => useFullTranslateStore.getState().tick(),
      shouldAbort,
      errorCodeOf: (e) =>
        e instanceof TranslateServiceError ? e.info.code : parseTranslateError(e).code,
    }).then((outcome) => {
      const s = useFullTranslateStore.getState();
      if (outcome.cancelled) {
        s.reset();
        return;
      }
      if (outcome.errorCode) {
        s.fail(outcome.errorCode);
        return;
      }
      // 全部段落失败：视为整体失败（不写入）
      // v0.6.3 P1-5：上报真实错误码（如 RATE/AUTH），不再固定 STREAM 误导排查
      if (outcome.failedCount >= units.length) {
        s.fail(outcome.lastErrorCode ?? "STREAM");
        return;
      }
      // 写入前再次确认未发生标签切换
      if (shouldAbort()) {
        s.reset();
        return;
      }
      // v0.6.3 P0-3：回写前校验文档未被编辑——当前内容与启动时快照一致才允许整体回写，
      // 不一致则放弃回写（整篇替换会静默丢弃翻译期间的用户编辑）
      let currentText: string | null;
      try {
        if (viewMode === "preview" && viewRef.current) {
          currentText = getMarkdownFromDoc(viewRef.current.state.doc);
        } else {
          // v0.6.6 问题4：与 fullText 同坐标系（真实内容）比较
          currentText = unmaskBase64Images(sourceContentRef.current, base64TokensRef.current);
        }
      } catch {
        currentText = null;
      }
      if (currentText !== fullText) {
        s.fail("DOC_CHANGED");
        return;
      }
      const newContent = rebuildTranslatedDocument(fullText, units, outcome.translations);
      // v0.6.1 问题2：传入原文快照，回写后显示"取消翻译"气泡
      applyFullTranslation(newContent, fullText);
      s.finish(outcome.failedCount);
      // v0.6.4 问题1c：失败段在内容首处以气泡提示（底部栏不再显示失败）
      if (outcome.failedCount > 0) {
        const idx = outcome.translations.indexOf(null);
        const firstFailed = idx >= 0 ? units[idx] : null;
        showSegmentFailTip(firstFailed?.text ?? "", outcome.failedCount);
      }
    });
  }, [viewMode, isMdFile, filePath, forceUpdateKey, applyFullTranslation, showSegmentFailTip]);
  startFullTranslateRef.current = startFullTranslate;

  // v0.6.4 问题1b：切换文档时清除上一文档的翻译状态（done 提示/系统性错误/运行进度
  // 均不跨文档残留；运行中的任务由 shouldAbort 上下文检测中止）
  useEffect(() => {
    const s = useFullTranslateStore.getState();
    if (s.status !== "idle") s.reset();
    if (segmentFailTipTimerRef.current) clearTimeout(segmentFailTipTimerRef.current);
    setSegmentFailTip(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  // 全文翻译运行中：Esc 中断
  const fullTranslateRunning = useFullTranslateStore((s) => s.status === "running");
  useEffect(() => {
    if (!fullTranslateRunning) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        const s = useFullTranslateStore.getState();
        s.requestCancel();
        translateService.cancel().catch(() => undefined);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullTranslateRunning]);

  // v0.6.2 问题2：翻译回写成功后（"取消翻译"气泡可见期间），Esc 恢复原文。
  // 翻译气泡打开时（status 非 idle）Esc 优先关闭气泡，不触发恢复原文
  const translateUndoSnapshot = useEditorStore((s) => s.translateUndoSnapshot);
  useEffect(() => {
    if (translateUndoSnapshot === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (useTranslateStore.getState().status !== "idle") return;
      e.preventDefault();
      undoTranslation();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [translateUndoSnapshot, undoTranslation]);

  // 监听命令面板/快捷键转发的 edit.translate 命令（App.tsx 派发，统一入口 startTranslate）
  useEffect(() => {
    const handler = (e: Event) => {
      const id = (e as CustomEvent).detail?.id;
      if (id === "edit.translate") startTranslateRef.current();
      // v0.6.1：全文翻译（Shift+F6 / 命令面板 / 悬浮按钮共用入口）
      if (id === "edit.translateDocument") startFullTranslateRef.current();
    };
    window.addEventListener("lightmd:command", handler);
    return () => window.removeEventListener("lightmd:command", handler);
  }, []);

  // ─── textarea 右键菜单 ──────────────────────────
  const handleTextareaContextMenu = useCallback((e: React.MouseEvent<HTMLTextAreaElement>) => {
    if (!isSourceMode || !isMdFile) return;
    e.preventDefault();
    const textarea = sourceTextareaRef.current;
    const hasSelection = !!textarea && textarea.selectionStart !== textarea.selectionEnd;
    setContextMenu({ open: true, x: e.clientX, y: e.clientY, hasSelection });
  }, [isSourceMode, isMdFile]);

  // ─── 右键菜单 action 分发 ─────────────────────────
  // 撤销/恢复走 handleUndo/handleRedo；行内格式走 handleFormatAction；
  // 插入链接/图片/表格打开对应对话框；剪切/复制/粘贴调用原生命令
  const handleContextMenuAction = useCallback((action: string) => {
    switch (action) {
      case "undo": handleUndo(); return;
      case "redo": handleRedo(); return;
      // v0.6.0：AI 翻译当前选区（textarea 通道）
      case "translate": startTranslateRef.current(); return;
      case "bold":
      case "italic":
      case "strikethrough":
      case "code":
        handleFormatAction.current(action);
        return;
      case "link": openLinkDialog(); return;
      case "image": setImageDialogOpen(true); return;
      case "table": setTableDialogOpen(true); return;
      case "codeblock":
        insertTextAtCursor("\n```\n\n```\n");
        return;
      case "mermaid":
        setMermaidMenuOpen(true);
        return;
      case "cut":
      case "copy":
        // 同步命令：仅对选中文本生效，失败静默
        try { document.execCommand(action); } catch { /* ignore */ }
        return;
      case "paste":
        // 异步读取剪贴板并插入到光标位置
        try {
          navigator.clipboard?.readText().then((text) => {
            if (text) insertTextAtCursor(text);
          }).catch(() => { /* ignore clipboard permission */ });
        } catch { /* ignore */ }
        return;
    }
  }, [handleUndo, handleRedo, openLinkDialog, insertTextAtCursor]);

  // ─── Mermaid 模板插入 ──────────────────────────────
  const handleMermaidTemplateSelect = useCallback((syntax: string) => {
    setMermaidMenuOpen(false);
    insertTextAtCursor(syntax);
  }, [insertTextAtCursor]);

  // 关闭 Mermaid 下拉：失焦或外部点击时
  useEffect(() => {
    if (!mermaidMenuOpen) return;
    const handle = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".mermaid-dropdown-wrap")) {
        setMermaidMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [mermaidMenuOpen]);

  // ─── SlashCommand 菜单关闭回调 ──────────────────
  // 根因：onClose 调用 setSlashCommandOpen(false) + handleSourceChange 调用 setSourceContent
  // 触发 React 重新渲染，textarea 的 value 被重设，浏览器把 selectionStart 重置到文档末尾。
  // 修复：关闭前保存光标位置和滚动位置，在 rAF（重新渲染后）恢复。
  const handleSlashClose = useCallback(() => {
    const textarea = sourceTextareaRef.current;
    const savedCursor = textarea?.selectionStart ?? 0;
    const savedScroll = textarea?.scrollTop ?? 0;
    setSlashCommandOpen(false);
    if (textarea) {
      requestAnimationFrame(() => {
        const ta = sourceTextareaRef.current;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(savedCursor, savedCursor);
          ta.scrollTop = savedScroll;
        }
      });
    }
  }, []);

  // ─── 切换文件/模式时关闭 SlashCommand 菜单（防止残留）─────────
  // 根因：SlashCommand 通过 portal 渲染到 body，模式切换时 textarea 隐藏但菜单可能残留；
  // 文件切换时 textarea 内容变化但不会触发 input 事件，菜单 query 与新内容脱节
  // 注意：依赖 filePath 而非 content，因为用户输入 "/" 时会触发 onContentChange → content 变化，
  // 如果依赖 content 会导致菜单刚打开就被关闭（菜单一闪而过）
  useEffect(() => {
    setSlashCommandOpen(false);
    // v0.6.6 问题2：阅读模式 Slash 菜单同步关闭（防止模式/文件切换后残留）
    setPmSlash(null);
  }, [filePath, viewMode]);

  // ─── 专注模式 ──────────────────────────────────
  // 通过 ProseMirror 插件状态控制 decoration，CSS 类用于样式触发
  useEffect(() => {
    const editorDom = editorRef.current?.querySelector(".ProseMirror") as HTMLElement | null;
    if (editorDom) editorDom.classList.toggle("focus-mode", focusMode);
    // 同步 ProseMirror 插件状态，触发 decoration 重新计算
    const view = viewRef.current;
    if (view) {
      // 修复问题5：进入专注模式时，检查光标是否在可视区域
      // 如果光标不在可视区域（如用户在阅读模式下浏览到中间，但光标在文档开头），
      // focus-mode 插件高亮的活跃块也不在可视区域，用户看不到高亮内容。
      // 此时将 selection 设置到屏幕中央的块，使 focus-mode 插件高亮可见区域。
      if (focusMode && !isSourceMode && editorDom) {
        const selection = view.state.selection;
        const coords = view.coordsAtPos(selection.from);
        // 问题2修复：使用 editor-container（editorRef.current）的 rect，
        // 因为 .ProseMirror 移除 overflow 后不再是滚动容器，rect.height 是内容高度而非视口高度
        const rect = editorRef.current?.getBoundingClientRect() || editorDom.getBoundingClientRect();
        const cursorTop = coords.top - rect.top;
        const cursorBottom = coords.bottom - rect.top;
        if (isCursorOutsideViewport(cursorTop, cursorBottom, rect.height)) {
          // 光标不在可视区域，将 selection 设置到屏幕中央
          const center = computeViewportCenter(rect);
          const posInfo = view.posAtCoords({ left: center.left, top: center.top });
          if (posInfo) {
            try {
              const $pos = view.state.doc.resolve(posInfo.pos);
              const newSelection = TextSelection.near($pos);
              const selTr = view.state.tr.setSelection(newSelection);
              selTr.setMeta("addToHistory", false);
              view.dispatch(selTr);
            } catch {
              // posAtCoords 可能返回无效位置（如文档边界），忽略错误
            }
          }
        }
      }
      const tr = view.state.tr.setMeta(focusModeKey, focusMode ? "enable" : "disable");
      // 不触发历史记录
      tr.setMeta("addToHistory", false);
      view.dispatch(tr);
    }
  }, [focusMode, isSourceMode]);

  // ─── 源码模式（edit/split）专注遮罩 ──────────────────
  // textarea 无法像 ProseMirror 那样对部分文本加装饰，因此用 overlay div 实现：
  // 覆盖在 textarea 之上（pointer-events:none 不影响交互），
  // 通过线性渐变 background-image 在活跃段落位置开窗（transparent），
  // 其余位置覆盖半透明遮罩，使非活跃段落视觉变暗，达到与阅读模式专注效果一致的体验。
  // 段落定义：以空行（\n\n）分隔的连续文本块，与 Markdown 段落语义一致。
  //
  // ─── 修复：使用 mirror div 准确测量段落 Y 坐标 ──────────
  // 早期实现基于硬换行（\n）计算行号，再乘以 lineHeight 得到 Y 坐标。
  // 但 textarea 配置 `white-space: pre-wrap; word-break: break-word;` 会导致长行软换行，
  // 实际显示行数多于硬换行行数，导致高亮 Y 坐标偏上（用户报告"高亮在点击位置的上一行"）。
  //
  // 修复方案：使用 mirror div（与 textarea 样式一致的隐藏 div），复制文本内容，
  // 通过 getBoundingClientRect 测量段落起止位置的实际 Y 坐标，准确处理软换行。
  //
  // ─── 修复：移除 rAF 节流，立即重绘 ──────────────────
  // 早期实现使用 rAF 节流，导致回车换行时高亮延迟一帧重绘（用户报告"输入文字后才高亮"）。
  // 现在改为同步立即重绘，确保光标位置变化时高亮即时跟随。
  //
  // 关键设计：事件监听与 sourceContent 解耦
  // useEffect 只依赖 focusMode/isSourceMode/viewMode/forceUpdateKey，
  // updateOverlay 通过 sourceContentRef.current 读取最新内容；
  // 内容变化时通过单独的 useEffect 调用 updateOverlayRef.current() 触发重绘，
  // 不重绑事件、不清空遮罩。
  const updateOverlayRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const textarea = sourceTextareaRef.current;
    const overlay = focusOverlayRef.current;
    // 仅在 focusMode 开启 + 源码模式 + 元素就绪时启用
    if (!focusMode || !isSourceMode || !textarea || !overlay) {
      updateOverlayRef.current = null;
      return;
    }

    /** 计算光标所在段落的 [startY, endY) 视口 Y 坐标，并更新 overlay 遮罩 */
    const updateOverlay = () => {
      const ta = sourceTextareaRef.current;
      const ov = focusOverlayRef.current;
      if (!ta || !ov) return;

      const text = ta.value;
      const cursorPos = ta.selectionStart;

      // 调用纯函数查找段落字符区间
      const range = findParagraphRange(text, cursorPos);

      // 使用 mirror div 测量段落起止位置的实际 Y 坐标（准确处理软换行）
      const { startY: rawStartY, endY: rawEndY } = measureTextareaRangeY(ta, range.start, range.end);

      const height = ta.clientHeight;

      // 限制到可视区域内，避免遮罩溢出
      const startY = Math.max(0, rawStartY);
      const endY = Math.min(height, rawEndY);

      // 修复：暗色主题下遮罩颜色适配，避免 rgba(0,0,0,0.45) 在深色背景上过暗
      const dimColor = theme === "dark" ? "rgba(0,0,0,0.28)" : "rgba(0,0,0,0.45)";

      // 若段落不在可视区域（如光标在文档开头但已滚动到中间），默认高亮屏幕中央的一行
      // 修复：原代码整个视口遮罩，用户看不到高亮内容；改为高亮屏幕中央
      if (endY <= 0 || startY >= height) {
        const cs = getComputedStyle(ta);
        const lineHeight = resolveLineHeight(cs);
        const centerY = height / 2;
        const centerStartY = Math.max(0, centerY - lineHeight / 2);
        const centerEndY = Math.min(height, centerY + lineHeight / 2);
        ov.style.backgroundImage = `linear-gradient(to bottom,
          ${dimColor} 0px,
          ${dimColor} ${centerStartY}px,
          transparent ${centerStartY}px,
          transparent ${centerEndY}px,
          ${dimColor} ${centerEndY}px,
          ${dimColor} ${height}px
        )`;
        return;
      }

      // 三段渐变：上方遮罩、中间透明（活跃段落）、下方遮罩
      ov.style.backgroundImage = `linear-gradient(to bottom,
        ${dimColor} 0px,
        ${dimColor} ${startY}px,
        transparent ${startY}px,
        transparent ${endY}px,
        ${dimColor} ${endY}px,
        ${dimColor} ${height}px
      )`;
    };

    // 暴露给外部 useEffect（sourceContent 变化时）调用，避免重绑事件
    updateOverlayRef.current = updateOverlay;

    // 立即重绘（不使用 rAF 节流，确保光标位置变化时高亮即时跟随）
    // measureTextareaRangeY 内部使用 getBoundingClientRect，浏览器会强制布局计算，
    // 但仅在 focusMode 开启时执行，性能开销可控
    const scheduleUpdate = () => {
      updateOverlay();
    };

    // 监听光标位置变化和滚动
    textarea.addEventListener("keyup", scheduleUpdate);
    textarea.addEventListener("click", scheduleUpdate);
    textarea.addEventListener("input", scheduleUpdate);
    textarea.addEventListener("scroll", scheduleUpdate);
    // select 事件覆盖键盘方向键移动选区的情况
    textarea.addEventListener("select", scheduleUpdate);

    // 初始绘制
    updateOverlay();

    return () => {
      textarea.removeEventListener("keyup", scheduleUpdate);
      textarea.removeEventListener("click", scheduleUpdate);
      textarea.removeEventListener("input", scheduleUpdate);
      textarea.removeEventListener("scroll", scheduleUpdate);
      textarea.removeEventListener("select", scheduleUpdate);
      updateOverlayRef.current = null;
      // 清空遮罩，避免残留
      const ov = focusOverlayRef.current;
      if (ov) ov.style.backgroundImage = "";
      // 销毁 mirror div，避免内存泄漏
      destroyMirror(textarea);
    };
  }, [focusMode, isSourceMode, viewMode, forceUpdateKey, theme]);

  // ─── sourceContent 变化时重绘专注遮罩（不重绑事件）────────
  // 解耦后：内容变化仅触发 updateOverlay 重绘，避免事件重绑和遮罩清空
  useEffect(() => {
    if (!updateOverlayRef.current) return;
    updateOverlayRef.current();
  }, [sourceContent]);

  // ─── 字体 ──────────────────────────────────────
  useEffect(() => {
    const editorDom = editorRef.current?.querySelector(".ProseMirror") as HTMLElement;
    if (editorDom) {
      editorDom.style.setProperty("--editor-font-size", `${fontSize}px`);
      editorDom.style.setProperty("--editor-font-family", fontFamily);
    }
  }, [fontSize, fontFamily]);

  // ─── G10：ProseMirror spellcheck 属性同步 ──────
  // 浏览器原生 spellcheck 通过 contenteditable 元素的 spellcheck 属性控制
  // 切换开关时同步更新 .ProseMirror 的 spellcheck 属性，
  // 开启后浏览器自动渲染拼写错误的红色波浪下划线，右键菜单原生提供纠正建议
  useEffect(() => {
    const editorDom = editorRef.current?.querySelector(".ProseMirror") as HTMLElement;
    if (editorDom) {
      editorDom.setAttribute("spellcheck", spellcheckEnabled ? "true" : "false");
      // 浏览器对 contenteditable 的 spellcheck 变化是惰性响应：
      // 修改 spellcheck 属性后不会立即重新检查已有内容，需要触发 blur + focus
      // 让浏览器重新执行拼写检查并渲染红色波浪下划线
      if (document.activeElement === editorDom) {
        // 问题2修复：滚动发生在 editor-container 上，保存/恢复其 scrollTop
        const scrollContainer = editorRef.current;
        const scrollTop = scrollContainer ? scrollContainer.scrollTop : 0;
        const scrollLeft = scrollContainer ? scrollContainer.scrollLeft : 0;
        editorDom.blur();
        editorDom.focus();
        // 恢复滚动位置（focus 可能触发 scrollIntoView）
        if (scrollContainer) {
          scrollContainer.scrollTop = scrollTop;
          scrollContainer.scrollLeft = scrollLeft;
        }
      }
    }
  }, [spellcheckEnabled]);

  // ─── 主题变化时更新 mermaid 主题 ──────────────────
  // 修复：原 mermaid 主题硬编码为 'default'，暗色主题下图表渲染异常
  useEffect(() => {
    setMermaidTheme(theme === "dark");
  }, [theme]);

  // ─── ProseMirror 滚动处理（阅读模式）──────────────────
  // 统一处理键盘输入后的滚动行为，彻底解决编辑时屏幕闪动问题
  //
  // 闪动根因与解决：
  // ProseMirror updateState 内部调用 selectionToDOM 将 state.selection 同步到
  // DOM 选区，浏览器原生 selection 滚动会改变 scrollTop。由于 scroll 事件是
  // 异步触发的，无法在浏览器重绘前恢复 scrollTop，用户会看到中间状态（闪动）。
  //
  // 解决方案：在 editor.ts 的 dispatchTransaction 中，updateState 前后同步
  // 保存/恢复 scrollTop。浏览器不会在 updateState 内部重绘，所以用户看不到
  // 中间状态。此处的 keyup/click 监听只负责"主动滚动"（换行后跟随光标）。
  //
  // 滚动策略（由 keyup/click 监听统一处理）：
  // - 光标 Y 不变（同行输入）：scrollTop 已被 dispatchTransaction 同步恢复，无需处理
  // - 光标 Y 变化（换行/软换行）：
  //   * 打字机开启：smooth 滚动到中央
  //   * 打字机关闭：instant 滚动让光标可见
  useEffect(() => {
    if (viewMode !== "preview") return;
    const editorDom = editorRef.current?.querySelector(".ProseMirror") as HTMLElement;
    if (!editorDom) return;
    // 问题2修复：滚动容器从 .ProseMirror 改为 .editor-container
    // 移除 .ProseMirror overflow-y: auto 后，滚动发生在 editor-container 上
    const scrollContainer = editorRef.current;
    if (!scrollContainer) return;

    // 禁用 ProseMirror 的 storeScrollPos/resetScrollPos 机制（双保险）
    editorDom.style.overflowAnchor = "none";

    // 获取光标相对内容顶部的 Y 坐标（不受 scrollTop 影响）
    // 问题2修复：使用 scrollContainer 的 rect 和 scrollTop，因为滚动发生在 editor-container 上
    const getCursorY = () => {
      const view = viewRef.current;
      if (!view) return 0;
      const { from } = view.state.selection;
      const coords = view.coordsAtPos(from);
      const containerRect = scrollContainer.getBoundingClientRect();
      return coords.top - containerRect.top + scrollContainer.scrollTop;
    };

    // 打字机模式：smooth 滚动使光标居中
    // 问题2修复：使用 scrollContainer 的滚动属性
    const scrollToCenter = () => {
      requestAnimationFrame(() => {
        const cursorY = getCursorY();
        const target = computeTypewriterScrollTop(
          cursorY,
          scrollContainer.clientHeight,
          scrollContainer.scrollHeight,
          scrollContainer.scrollTop
        );
        if (target !== null) {
          scrollContainer.scrollTo({ top: target, behavior: "smooth" });
        }
      });
    };

    // 非打字机模式：instant 滚动让光标可见（光标在视口外时）
    // 问题2修复：使用 scrollContainer 的滚动属性
    const scrollToVisible = () => {
      const view = viewRef.current;
      if (!view) return;
      const { from } = view.state.selection;
      const coords = view.coordsAtPos(from);
      const containerRect = scrollContainer.getBoundingClientRect();
      const cursorTop = coords.top - containerRect.top;
      const cursorBottom = cursorTop + (coords.bottom - coords.top);
      if (cursorBottom > scrollContainer.clientHeight) {
        scrollContainer.scrollTop += cursorBottom - scrollContainer.clientHeight + 20;
      } else if (cursorTop < 0) {
        scrollContainer.scrollTop += cursorTop - 20;
      }
    };

    // keydown 时记录光标 Y（必须在捕获阶段，详见下方注释）
    let savedCursorY = 0;
    let savedScrollTop = 0;
    // 记录按键前光标是否在视口外，用于决定 keyup 时是否恢复 scrollTop
    let cursorWasOutside = false;
    // keydown 必须在捕获阶段注册：ProseMirror 的 keydown 监听器在冒泡阶段执行，
    // 会先处理回车/方向键并移动光标。若在冒泡阶段记录，savedCursorY
    // 会是变化后的 Y，导致 keyup 时 Y 差值始终为 0，回车换行不触发滚动。
    const handleKeyDown = () => {
      savedCursorY = getCursorY();
      // 问题2修复：使用 scrollContainer 的 scrollTop
      savedScrollTop = scrollContainer.scrollTop;
      // 检测光标是否在视口外
      // 根因：光标在视口外时按键，浏览器原生 selection 变化会触发 scrollIntoView，
      // 把 scrollTop 改为光标位置。如果 keyup 恢复 scrollTop，用户会看到抖动
      // （scrollTop 跳到光标位置再跳回）。通过记录 cursorWasOutside，keyup 时不
      // 恢复 scrollTop，让 scrollIntoView 生效，光标进入视口，下次按键不抖动。
      const view = viewRef.current;
      if (view) {
        const { from } = view.state.selection;
        const coords = view.coordsAtPos(from);
        const containerRect = scrollContainer.getBoundingClientRect();
        const cursorTop = coords.top - containerRect.top;
        const cursorBottom = cursorTop + (coords.bottom - coords.top);
        cursorWasOutside = isCursorOutsideViewport(cursorTop, cursorBottom, scrollContainer.clientHeight);
      } else {
        cursorWasOutside = false;
      }
    };

    // keyup 时根据光标 Y 变化决定是否滚动
    // scrollTop 已被 dispatchTransaction 同步恢复，无需再处理同行输入的情况
    //
    // ─── 修复：普通字符输入时只在光标离开视口才滚动 ──────────
    // 根因：软换行（white-space: pre-wrap 导致长行自动换行）时，光标 Y 可能
    // 减小一行高度（约 28.8px），因为输入字符后行 N-1 的内容被挤到行 N，
    // 光标跟随内容上移。早期实现只要 |cursorY - savedCursorY| > 5 就触发
    // scrollToVisible，会强制让光标可见，造成 scrollTop 大幅跳跃（用户报告
    // "屏幕闪烁抖动"）。
    //
    // 修复策略（提取为 shouldSkipScrollForCharInput 纯函数，便于单元测试）：
    // - 导航键（回车/方向键/翻页键）：始终触发滚动，确保光标可见
    // - 普通字符输入：只在光标离开视口时才触发滚动，避免软换行误触发
    //
    // ─── 修复：光标在视口外时按键不恢复 scrollTop ──────────
    // 根因：光标在视口外时按键，浏览器 scrollIntoView 把 scrollTop 改为光标
    // 位置。keyup 恢复 scrollTop 到旧值，用户看到抖动（跳到光标再跳回）。
    // 修复：cursorWasOutside 时不恢复 scrollTop，让 scrollIntoView 生效；
    // 打字机模式开启时进一步 smooth 滚动到中央。
    const handleKeyUp = (e: KeyboardEvent) => {
      // 模式切换恢复滚动位置期间跳过：applyScroll 正在用 instant 设置恢复滚动位置，
      // 此处若触发 smooth 滚动会覆盖 applyScroll 的设置，导致快捷键切换模式时滚动位置丢失
      // 根因：双击 Ctrl/Shift 切换模式时，keyup 事件冒泡到 ProseMirror 触发此处理器，
      // 若不跳过则可能调用 scrollToCenter（smooth）覆盖 applyScroll 的 instant 设置
      if (isRestoringScrollRef.current) return;
      // 修饰键（Shift/Ctrl/Alt/Meta）不移动光标，不应触发滚动
      // 作为 isRestoringScrollRef 的双重保护，应对 applyScroll effect 尚未执行的时序竞争
      if (isModifierKey(e.key)) return;

      const cursorY = getCursorY();
      const diff = Math.abs(cursorY - savedCursorY);

      // 光标在视口外时按键：浏览器 scrollIntoView 已把光标滚动到可见
      // 不恢复 scrollTop，避免抖动；打字机模式进一步滚动到中央
      if (cursorWasOutside) {
        if (typewriterModeRef.current) {
          scrollToCenter();
        }
        return;
      }

      if (diff <= 5) {
        // 同行输入：恢复 scrollTop，防止 dispatchTransaction 后的异步 scrollIntoView
        // 问题2修复：使用 scrollContainer 的 scrollTop
        if (scrollContainer.scrollTop !== savedScrollTop) {
          scrollContainer.scrollTop = savedScrollTop;
        }
        return;
      }

      const view = viewRef.current;
      if (view) {
        const { from } = view.state.selection;
        const coords = view.coordsAtPos(from);
        // 问题2修复：使用 scrollContainer 的 rect 和 clientHeight
        const containerRect = scrollContainer.getBoundingClientRect();
        const cursorTop = coords.top - containerRect.top;
        const cursorBottom = cursorTop + (coords.bottom - coords.top);
        // 普通字符输入且光标在视口内：跳过滚动（避免软换行 cursorY 减小误触发）
        if (shouldSkipScrollForCharInput(e.key, cursorTop, cursorBottom, scrollContainer.clientHeight)) {
          // 光标在视口内：恢复 scrollTop，防止异步 scrollIntoView
          if (scrollContainer.scrollTop !== savedScrollTop) {
            scrollContainer.scrollTop = savedScrollTop;
          }
          return;
        }
      }

      // 触发滚动：导航键 或 光标在视口外
      if (typewriterModeRef.current) {
        scrollToCenter();
      } else {
        scrollToVisible();
      }
    };

    // 点击时：打字机模式 smooth 居中，非打字机模式不处理
    const handleClick = () => {
      if (typewriterModeRef.current) scrollToCenter();
    };

    editorDom.addEventListener("keydown", handleKeyDown, { capture: true });
    editorDom.addEventListener("keyup", handleKeyUp);
    editorDom.addEventListener("click", handleClick);

    // 打字机模式开启时，初始居中
    // 但模式切换时跳过：applyScroll 正在恢复滚动位置，scrollToCenter 的 smooth
    // 滚动会覆盖 applyScroll 的 instant 设置（smooth 是异步多帧的）
    if (!shouldSkipInitialScrollToCenter(isRestoringScrollRef.current, typewriterModeRef.current)) scrollToCenter();

    return () => {
      editorDom.removeEventListener("keydown", handleKeyDown, { capture: true } as EventListenerOptions);
      editorDom.removeEventListener("keyup", handleKeyUp);
      editorDom.removeEventListener("click", handleClick);
    };
  }, [viewMode, forceUpdateKey]);

  // textarea 打字机滚动（编辑/分屏模式）
  useEffect(() => {
    if (!typewriterMode || viewMode === "preview") return;
    const textarea = sourceTextareaRef.current;
    if (!textarea) return;
    // 不设置 scrollBehavior = "smooth"，与 ProseMirror 模式保持一致：
    // 避免全局 CSS 影响所有滚动操作，改用 scrollTo({ behavior: "smooth" }) 显式控制

    const scrollCursorToCenter = () => {
      requestAnimationFrame(() => {
        if (!typewriterModeRef.current) return;
        const cursorPos = textarea.selectionStart;
        // 使用 mirror div 测量光标所在位置的实际 Y 坐标（准确处理软换行）
        // 早期实现基于硬换行行号 * lineHeight 计算，软换行场景下 Y 坐标偏小，居中位置不准
        const cursorY = measureTextareaCursorY(textarea, cursorPos);
        // 使用纯函数计算目标滚动位置（内置视口溢出检查和阈值抖动过滤）
        const target = computeTypewriterScrollTop(
          cursorY,
          textarea.clientHeight,
          textarea.scrollHeight,
          textarea.scrollTop
        );
        if (target !== null) {
          // 使用 scrollTo 显式指定 smooth，避免全局 scrollBehavior 影响其他滚动操作
          textarea.scrollTo({ top: target, behavior: "smooth" });
        }
      });
    };

    // keydown 时保存 scrollTop（自动滚动前的值），供 keyup 恢复使用
    let savedScrollTop = 0;
    const handleKeyDown = () => {
      if (!typewriterModeRef.current) return;
      savedScrollTop = textarea.scrollTop;
    };

    // 抑制 textarea 输入时的自动滚动（打字机模式核心修复）
    //
    // 根因：textarea 在 input 事件后、keyup 事件前会同步执行 scrollIntoView
    // 使光标可见，导致普通字符输入时屏幕跳动（与 ProseMirror 通过
    // dispatchTransaction 拦截不同，textarea 无法在事务层面阻止自动滚动）。
    //
    // 修复方案：keydown 时保存 scrollTop，keyup 时若是普通字符则用 instant 滚动恢复。
    //
    // 时序验证（通过 chrome-devtools 实测）：
    // 1. keydown: scrollTop=原值（保存 savedScrollTop）
    // 2. input: scrollTop=原值（尚未自动滚动）
    // 3. textarea 自动滚动: scrollTop 变化（input 后、keyup 前，同步）
    // 4. keyup:
    //    - 导航键：smooth 滚动到中央
    //    - 普通字符：检查光标是否偏离中央
    //      * 偏离超过阈值（软换行场景）：smooth 滚动到中央
    //      * 偏离不超过阈值（同行输入）：instant 恢复 savedScrollTop，抑制浏览器自动滚动
    //   用 savedScrollTop（scrollIntoView 前的位置）计算，避免 scrollIntoView 影响
    const handleKeyUp = (e: KeyboardEvent) => {
      if (!typewriterModeRef.current) return;
      // 模式切换恢复滚动位置期间跳过：applyScroll 正在用 instant 设置恢复滚动位置，
      // 此处若触发 smooth 滚动会覆盖 applyScroll 的设置，导致快捷键切换模式时滚动位置丢失
      // 根因：双击 Ctrl/Shift 切换模式时，keyup 事件在 textarea 上触发（事件冒泡），
      // 若不跳过则会调用 scrollCursorToCenter 或 scrollTo({behavior: "smooth"})
      if (isRestoringScrollRef.current) return;
      // 修饰键（Shift/Ctrl/Alt/Meta）不移动光标，不应触发滚动
      // 作为 isRestoringScrollRef 的双重保护，应对 applyScroll effect 尚未执行的时序竞争
      if (isModifierKey(e.key)) return;
      if (isTypewriterTriggerKey(e.key)) {
        // 导航键：smooth 滚动到中央
        scrollCursorToCenter();
      } else {
        // 普通字符：检查光标是否偏离中央
        const cursorPos = textarea.selectionStart;
        const cursorY = measureTextareaCursorY(textarea, cursorPos);
        const target = computeTypewriterScrollTop(
          cursorY,
          textarea.clientHeight,
          textarea.scrollHeight,
          savedScrollTop
        );
        if (target !== null) {
          // 光标偏离中央超过阈值（软换行等场景），smooth 滚动到中央
          textarea.scrollTo({ top: target, behavior: "smooth" });
        } else {
          // 光标在中央附近（同行输入），instant 恢复 savedScrollTop，抑制浏览器自动滚动
          textarea.scrollTo({ top: savedScrollTop, behavior: "instant" });
        }
      }
    };
    const handleClick = () => {
      if (typewriterModeRef.current) scrollCursorToCenter();
    };

    textarea.addEventListener("keydown", handleKeyDown);
    textarea.addEventListener("keyup", handleKeyUp);
    textarea.addEventListener("click", handleClick);
    // 打字机模式开启时，初始居中
    // 但模式切换时跳过：applyScroll 正在恢复滚动位置，scrollCursorToCenter 的 smooth
    // 滚动会覆盖 applyScroll 的 instant 设置（smooth 是异步多帧的）
    // 修复快捷键切换模式时滚动位置丢失 bug
    if (!shouldSkipInitialScrollToCenter(isRestoringScrollRef.current, typewriterModeRef.current)) scrollCursorToCenter();

    return () => {
      textarea.removeEventListener("keydown", handleKeyDown);
      textarea.removeEventListener("keyup", handleKeyUp);
      textarea.removeEventListener("click", handleClick);
    };
  }, [typewriterMode, viewMode, forceUpdateKey]);

  // ─── 分屏预览防抖渲染 ──────────────────────────────
  // 首次进入分屏模式立即渲染，编辑时延迟 300ms 防抖，减少连续击键时的渲染开销
  const [debouncedSourceContent, setDebouncedSourceContent] = useState(sourceContent);
  const justEnteredSplitRef = useRef(false);
  // iframe 引用，用于分屏预览（隔离 DOM，减少主文档节点数）
  const previewIframeRef = useRef<HTMLIFrameElement>(null);
  // iframe 初始化状态追踪：首次进入分屏完整加载脚本，后续只更新 body
  const previewIframeInitRef = useRef<{ mermaid: boolean; math: boolean }>({ mermaid: false, math: false });

  // 追踪是否刚切换到分屏模式
  useEffect(() => {
    if (viewMode === "split" && prevViewModeRef.current !== "split") {
      justEnteredSplitRef.current = true;
      // 进入分屏时重置 iframe 初始化状态，确保首次完整加载
      previewIframeInitRef.current = { mermaid: false, math: false };
    }
  }, [viewMode]);

  // 防抖：首次进入 split 立即渲染，编辑时延迟渲染
  // 大文件（>1MB）增加防抖时间到 1000ms，减少渲染开销
  useEffect(() => {
    if (viewMode !== "split") return;
    if (justEnteredSplitRef.current) {
      setDebouncedSourceContent(sourceContent);
      justEnteredSplitRef.current = false;
      return;
    }
    // 根据内容大小动态调整防抖时间
    const debounceMs = sourceContent.length > LARGE_FILE_THRESHOLD ? 1000 : 300;
    const timer = setTimeout(() => setDebouncedSourceContent(sourceContent), debounceMs);
    return () => clearTimeout(timer);
  }, [sourceContent, viewMode]);

  // 分屏预览 HTML（仅分屏模式才计算，基于防抖内容）
  // Markdown 文件：渲染 markdown + mermaid + 代码高亮
  // 非 Markdown 文件（txt/代码等）：v0.4.0 用 PrismJS 对整个内容语法高亮，不渲染 markdown
  const previewHtml = useMemo(
    () => {
      if (viewMode !== "split") return "";
      if (!isMdFile) {
        // v0.4.0：非 Markdown 文件用 renderCodeFilePreview 生成带语法高亮的 HTML
        // v0.6.6 问题4：unmask 还原 base64（显示层短标记不进预览）
        return renderCodeFilePreview(unmaskBase64Images(debouncedSourceContent, base64TokensRef.current), currentLanguage);
      }
      // v0.6.6 问题4：unmask 还原 base64 后再渲染，短标记会导致预览图裂
      let html = renderMarkdownToHtml(unmaskBase64Images(debouncedSourceContent, base64TokensRef.current));
      // 将相对路径图片 src 转换为 Tauri webview 可访问的 asset:// URL
      html = html.replace(/(<img\s[^>]*src=")([^"]+)(")/g, (_match, prefix: string, src: string, suffix: string) => {
        return `${prefix}${resolveImageSrc(src, filePath)}${suffix}`;
      });
      // 将 markdown-it 生成的 mermaid 代码块转换为 mermaid 渲染格式
      html = html.replace(
        /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
        '<pre class="mermaid">$1</pre>'
      );
      // 对代码块进行 PrismJS 语法高亮（跳过 mermaid 代码块）
      html = highlightCodeBlocksInHtml(html);
      return html;
    },
    [debouncedSourceContent, viewMode, isMdFile, filePath, currentLanguage]
  );

  // v0.4.0：阅读模式下非 Markdown 文件的语法高亮 HTML（用 useMemo 缓存避免重复计算）
  // 仅在阅读模式 + 非 md 文件时计算，依赖 sourceContent 和 currentLanguage
  const codePreviewHtml = useMemo(() => {
    if (isMdFile || viewMode !== "preview") return "";
    // v0.6.6 问题4：unmask 还原 base64（显示层短标记不进预览）
    return renderCodeFilePreview(unmaskBase64Images(sourceContent, base64TokensRef.current), currentLanguage);
  }, [sourceContent, isMdFile, viewMode, currentLanguage]);

  // 将预览 HTML 写入 iframe，隔离 DOM 减少 GC 压力
  // 优化：首次进入分屏写入完整 HTML（含脚本），后续只更新 body 内容并重新触发渲染
  // 避免 CDN 脚本反复加载，大幅减少闪烁和卡顿

  // 收集主文档的 CSS 变量，注入 iframe 使分屏样式与阅读模式一致
  const collectCssVars = useCallback(() => {
    const s = getComputedStyle(document.documentElement);
    const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
    return {
      bgPrimary: v("--bg-primary", "#fff"),
      textPrimary: v("--text-primary", "#333"),
      textSecondary: v("--text-secondary", "#666"),
      textTertiary: v("--text-tertiary", "#999"),
      headingColor: v("--heading-color", "#1a1a1a"),
      codeBg: v("--code-bg", "#f4f4f4"),
      codeText: v("--code-text", "#d63384"),
      blockquoteBorder: v("--blockquote-border", "#0078d4"),
      blockquoteBg: v("--blockquote-bg", "#f8f9fa"),
      tableBorder: v("--table-border", "#ddd"),
      tableHeaderBg: v("--table-header-bg", "#f5f5f5"),
      hrColor: v("--hr-color", "#e0e0e0"),
      linkColor: v("--link-color", "#0078d4"),
      borderColor: v("--border-color", "#e0e0e0"),
      accentColor: v("--accent-color", "#0078d4"),
      fontMono: v("--font-mono", "'Cascadia Code', 'Consolas', monospace"),
      fontSize: v("--editor-font-size", "16px"),
      fontFamily: v("--editor-font-family", "sans-serif"),
    };
  }, []);

  useEffect(() => {
    if (viewMode !== "split" || !previewHtml) return;
    const iframe = previewIframeRef.current;
    if (!iframe) return;
    const doc = iframe.contentDocument;
    if (!doc) return;
    const cv = collectCssVars();
    // 判断是否包含 mermaid 图表
    const hasMermaid = previewHtml.includes('class="mermaid"');
    // 判断是否包含数学公式
    const hasMath = previewHtml.includes('data-math="inline"') || previewHtml.includes('data-math="block"');

    // 判断是否需要完整重写（首次进入、或脚本需求变化时）
    const init = previewIframeInitRef.current;
    const needFullRewrite = !init.mermaid && !init.math
      || (hasMermaid && !init.mermaid)
      || (hasMath && !init.math);

    // 与阅读模式（editor.css .ProseMirror）保持一致的元素样式
    const sharedStyles = `
      :root {
        --bg-primary: ${cv.bgPrimary}; --text-primary: ${cv.textPrimary};
        --text-secondary: ${cv.textSecondary}; --text-tertiary: ${cv.textTertiary};
        --heading-color: ${cv.headingColor}; --code-bg: ${cv.codeBg}; --code-text: ${cv.codeText};
        --blockquote-border: ${cv.blockquoteBorder}; --blockquote-bg: ${cv.blockquoteBg};
        --table-border: ${cv.tableBorder}; --table-header-bg: ${cv.tableHeaderBg};
        --hr-color: ${cv.hrColor}; --link-color: ${cv.linkColor};
        --border-color: ${cv.borderColor}; --accent-color: ${cv.accentColor};
        --font-mono: ${cv.fontMono};
      }
      body {
        margin: 0; padding: 40px 60px; max-width: 860px; margin: 0 auto;
        background: ${cv.bgPrimary}; color: ${cv.textPrimary};
        font-size: ${cv.fontSize}; font-family: ${cv.fontFamily};
        line-height: 1.8; word-break: break-word;
      }
      h1,h2,h3,h4,h5,h6 { color: ${cv.headingColor}; margin: 1.2em 0 0.6em; line-height: 1.3; }
      h1 { font-size: 2em; } h2 { font-size: 1.5em; } h3 { font-size: 1.25em; } h4 { font-size: 1.1em; }
      p { margin: 0.5em 0; }
      ul, ol { padding-left: 2em; margin: 0.4em 0; }
      li { margin: 0.2em 0; }
      code { background: ${cv.codeBg}; color: ${cv.codeText}; padding: 0.15em 0.4em; border-radius: 3px; font-family: ${cv.fontMono}; font-size: 0.9em; }
      pre { background: ${cv.codeBg}; border: 1px solid ${cv.borderColor}; border-radius: 6px; padding: 1em; margin: 0.8em 0; overflow-x: auto; font-family: ${cv.fontMono}; font-size: 0.9em; line-height: 1.5; }
      pre code { background: none; color: inherit; padding: 0; border-radius: 0; }
      blockquote { border-left: 3px solid ${cv.blockquoteBorder}; margin: 0.8em 0; padding: 0.4em 1em; background: ${cv.blockquoteBg}; color: ${cv.textSecondary}; }
      table { border-collapse: collapse; margin: 0.8em 0; width: 100%; }
      th, td { border: 1px solid ${cv.tableBorder}; padding: 6px 12px; text-align: left; min-width: 80px; }
      th { background: ${cv.tableHeaderBg}; font-weight: 600; }
      hr { border: none; border-top: 2px solid ${cv.hrColor}; margin: 1.5em 0; }
      a { color: ${cv.linkColor}; }
      img { max-width: 100%; border-radius: 4px; }
      ul.task-list { list-style: none; padding-left: 0; margin: 0.4em 0; }
      li.task-item { display: flex; align-items: flex-start; gap: 6px; margin: 0.3em 0; list-style: none; }
      .task-item input[type="checkbox"] { margin-top: 5px; accent-color: ${cv.accentColor}; flex-shrink: 0; width: 16px; height: 16px; }
      .task-item .task-checked { text-decoration: line-through; color: ${cv.textTertiary}; }
      .footnote-ref { font-size: 0.8em; vertical-align: super; line-height: 0; }
      .footnote-ref a { color: ${cv.linkColor}; text-decoration: none; }
      .footnote-ref a:hover { text-decoration: underline; }
      .footnote-def { font-size: 0.875em; color: ${cv.textSecondary}; border-top: 1px solid ${cv.borderColor}; margin-top: 1.5em; padding-top: 0.5em; }
      .footnote-def::before { content: attr(data-label) ": "; font-weight: 600; color: ${cv.linkColor}; }
      dl { margin: 1em 0; padding-left: 0; }
      dt { font-weight: 600; margin-top: 0.6em; color: ${cv.headingColor}; }
      dd { margin-left: 1.5em; margin-top: 0.2em; color: ${cv.textSecondary}; }
      .mermaid-preview-container { text-align: center; margin: 1em 0; }
      .mermaid-preview-container svg { max-width: 100%; }
      .math-block-preview { text-align: center; margin: 1em 0; overflow-x: auto; }
    `;

    if (needFullRewrite) {
      // 完整写入：包含脚本标签和完整样式
      // 注入 PrismJS 语法高亮 CSS，使分屏模式代码高亮与阅读模式一致
      const prismCss = getPrismCss(theme === "dark");
      doc.open();
      doc.write(`<!DOCTYPE html><html><head><style>${sharedStyles}${prismCss}</style>
      ${hasMermaid ? '<script src="/vendor/mermaid/mermaid.min.js"></script>' : ''}
      ${hasMath ? '<link rel="stylesheet" href="/vendor/katex/katex.min.css">' : ''}
      ${hasMath ? '<script src="/vendor/katex/katex.min.js"></script>' : ''}
      </head><body>${previewHtml}
      ${hasMermaid ? `<script>
        mermaid.initialize({ startOnLoad: true, theme: ${theme === "dark" ? "'dark'" : "'default'"}, securityLevel: 'loose' });
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
      // 记录已加载的脚本状态
      previewIframeInitRef.current = { mermaid: hasMermaid, math: hasMath };
    } else {
      // 增量更新：只替换 body 内容，不重新加载脚本
      // 替换 body 内容（样式通过 :root 变量自动更新）
      doc.body.innerHTML = previewHtml;
      // 重新触发 mermaid 渲染（脚本已加载，直接调用 run）
      if (hasMermaid && (doc as any).defaultView?.mermaid) {
        try {
          (doc as any).defaultView.mermaid.run({ nodes: doc.querySelectorAll('pre.mermaid') });
        } catch { /* 忽略 mermaid 渲染错误 */ }
      }
      // 重新触发 katex 渲染
      if (hasMath && (doc as any).defaultView?.katex) {
        try {
          const katex = (doc as any).defaultView.katex;
          doc.querySelectorAll('[data-math="inline"]').forEach(function(el: Element) {
            const latex = el.getAttribute('data-latex');
            if (latex) {
              try { katex.render(latex, el, { throwOnError: false, displayMode: false }); }
              catch(e) { el.textContent = '⚠ ' + (e as Error).message; }
            }
          });
          doc.querySelectorAll('[data-math="block"]').forEach(function(el: Element) {
            const latex = el.getAttribute('data-latex');
            if (latex) {
              try { katex.render(latex, el, { throwOnError: false, displayMode: true }); }
              catch(e) { el.textContent = '⚠ ' + (e as Error).message; }
            }
          });
        } catch { /* 忽略 katex 渲染错误 */ }
      }
    }

    // 修复：iframe 写入完成后恢复待恢复的滚动位置
    // 根因：applyScroll 执行时 iframe 可能尚未写入内容或 mermaid/katex 脚本异步渲染
    // 导致 scrollHeight 不准确，scrollTop 设置无效。此处待 iframe 内容就绪后再设置。
    const pendingPercent = pendingIframeScrollRef.current;
    if (pendingPercent !== null) {
      // 完整重写含异步脚本（mermaid/katex）时，脚本加载和渲染需要时间，
      // 使用更长延迟确保 scrollHeight 稳定；增量更新时 rAF 即可
      const delay = needFullRewrite && (hasMermaid || hasMath) ? 300 : 0;
      const setScroll = () => {
        const cur = previewIframeRef.current?.contentDocument?.documentElement
          || previewIframeRef.current?.contentDocument?.body;
        if (!cur) return;
        const newTop = computeRestoreScrollTop(pendingPercent, cur.scrollHeight, cur.clientHeight);
        if (newTop !== null) {
          cur.scrollTop = newTop;
        }
        pendingIframeScrollRef.current = null;
      };
      if (delay > 0) {
        setTimeout(setScroll, delay);
      } else {
        requestAnimationFrame(setScroll);
      }
    }
  }, [previewHtml, viewMode, theme, collectCssVars]);

  // ─── 分屏模式：左右滚动联动 ──────────────────
  useEffect(() => {
    if (viewMode !== "split") return;
    const textarea = sourceTextareaRef.current;
    const iframe = previewIframeRef.current;
    if (!textarea || !iframe) return;
    // iframe 预览区的滚动目标是其 contentDocument.documentElement
    const previewDoc = iframe.contentDocument;
    const preview = previewDoc?.documentElement || previewDoc?.body;
    if (!preview || !previewDoc) return;

    const onTextareaScroll = () => {
      if (isSyncingScrollRef.current) return;
      isSyncingScrollRef.current = true;
      preview.scrollTop = computeSyncScrollTop(
        textarea.scrollTop, textarea.scrollHeight, textarea.clientHeight,
        preview.scrollHeight, preview.clientHeight
      );
      requestAnimationFrame(() => { isSyncingScrollRef.current = false; });
    };

    const onPreviewScroll = () => {
      if (isSyncingScrollRef.current) return;
      isSyncingScrollRef.current = true;
      textarea.scrollTop = computeSyncScrollTop(
        preview.scrollTop, preview.scrollHeight, preview.clientHeight,
        textarea.scrollHeight, textarea.clientHeight
      );
      requestAnimationFrame(() => { isSyncingScrollRef.current = false; });
    };

    textarea.addEventListener("scroll", onTextareaScroll);
    // ─── 修复：iframe scroll 事件监听错位 ──────────
    // 根因：iframe 的 scroll 事件触发在 contentDocument/contentWindow 上，
    // 而不是 documentElement 上（实测：documentElement 上 scroll 事件不触发）。
    // 原代码 preview.addEventListener("scroll", onPreviewScroll) 监听的是
    // documentElement，导致 onPreviewScroll 永远不触发，textarea 不联动
    // iframe 滚动。切换模式时 textareaScrollPercentRef 仍是旧值，滚动位置丢失。
    // 修复：在 contentDocument 上监听 scroll 事件。
    previewDoc.addEventListener("scroll", onPreviewScroll);
    return () => {
      textarea.removeEventListener("scroll", onTextareaScroll);
      previewDoc.removeEventListener("scroll", onPreviewScroll);
    };
  }, [viewMode, previewHtml]); // 依赖 previewHtml，因为 iframe 内容更新后需要重新绑定

  // ─── 格式工具栏 ────────────────────────────────
  // link/image/table 打开对应对话框；mermaid 打开模板下拉；其余走 handleFormatAction
  const onFormatBtnClick = useCallback((action: string) => {
    if (action === "undo") { handleUndo(); return; }
    if (action === "redo") { handleRedo(); return; }
    if (action.startsWith("sep")) return;
    if (action === "link") { openLinkDialog(); return; }
    if (action === "image") { setImageDialogOpen(true); return; }
    if (action === "table") { setTableDialogOpen(true); return; }
    if (action === "mermaid") { setMermaidMenuOpen((v) => !v); return; }
    handleFormatAction.current(action);
  }, [handleUndo, handleRedo, openLinkDialog]);

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>
      {/* 空状态 */}
      {!content && viewMode === "preview" && (
        <div className="editor-empty-state">
          <div className="editor-empty-logo">LightMD</div>
          <div className="editor-empty-hint">{t("editor.emptyHint")}</div>
        </div>
      )}

      {/* 格式工具栏（编辑/分屏模式，仅 Markdown 文件显示） */}
      {isSourceMode && isMdFile && (
        <div className="source-format-toolbar">
          {formatButtons.map((btn) => {
            if (btn.isSeparator) return <span key={btn.action} className="format-separator">{btn.label}</span>;
            // Mermaid 按钮：渲染为带下拉菜单的容器
            if (btn.hasDropdown) {
              return (
                <div key={btn.action} className="mermaid-dropdown-wrap">
                  <button
                    className="format-btn"
                    title={btn.title}
                    onClick={() => onFormatBtnClick(btn.action)}
                    aria-expanded={mermaidMenuOpen}
                    aria-haspopup="menu"
                  >
                    {btn.label}
                  </button>
                  {mermaidMenuOpen && (
                    <div className="mermaid-dropdown-menu" role="menu">
                      {MERMAID_TEMPLATES.map((tpl) => (
                        <button
                          key={tpl.label}
                          className="mermaid-dropdown-item"
                          role="menuitem"
                          onClick={() => handleMermaidTemplateSelect(tpl.syntax)}
                        >
                          {tpl.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            }
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
        {/* v0.6.1 问题5：模式切换悬浮按钮（阅读=羽毛笔→分屏 / 分屏=书本→阅读） */}
        {(viewMode === "preview" || viewMode === "split") && isMdFile && (
          <ModeSwitchButton
            viewMode={viewMode}
            onSwitch={(m) => setViewMode(m)}
          />
        )}

        {/* v0.6.2 问题3：「译」字按钮智能判断——有选中文本时翻译选区，无选区时全文翻译；
            翻译运行中点击 = 取消（startFullTranslate 内部处理） */}
        {(viewMode === "preview" || viewMode === "split") && isMdFile && translateEnabled && (
          <FullTranslateButton
            onStart={() => {
              if (fullTranslateRunning) {
                startFullTranslateRef.current(); // 运行中点击 = 取消
                return;
              }
              // 有选区 → 部分翻译；无选区（fallback）→ 全文翻译
              startTranslateRef.current(true);
            }}
          />
        )}

        {/* v0.6.1 问题2：翻译回写后浮动"取消翻译"气泡，点击恢复原文 */}
        <TranslateUndoToast onUndo={undoTranslation} />

        {/* v0.6.4 问题1c：翻译失败的段在内容首处以气泡提示（5 秒自动消失） */}
        {segmentFailTip && (
          <div className="segment-fail-tip" role="status" data-testid="segment-fail-tip">
            <span className="segment-fail-icon" aria-hidden="true">⚠</span>
            <span className="segment-fail-msg">
              {t("translate.full.segmentFailedCount", { count: segmentFailTip.count })}
            </span>
            {segmentFailTip.text && (
              <span className="segment-fail-preview" title={segmentFailTip.text}>
                {segmentFailTip.text.replace(/\s+/g, " ").slice(0, 60)}
              </span>
            )}
          </div>
        )}

        {/* ProseMirror 编辑器：阅读模式可见（仅 Markdown 文件） */}
        <div
          ref={editorRef}
          className="editor-container"
          style={{
            flex: (viewMode === "preview" && isMdFile) ? 1 : 0,
            display: (viewMode === "preview" && isMdFile) ? "flex" : "none",
            flexDirection: "column",
            overflow: "auto",
          }}
        />

        {/* v0.4.0：非 Markdown 文件的代码视图（阅读模式，带 PrismJS 语法高亮） */}
        {viewMode === "preview" && !isMdFile && content && (
          <div
            className="plaintext-preview"
            style={{
              flex: 1,
              overflow: "auto",
              padding: "16px",
              background: "var(--bg-primary)",
            }}
            dangerouslySetInnerHTML={{ __html: codePreviewHtml }}
          />
        )}

        {/* textarea：编辑/分屏模式可见，始终渲染确保 ref 有效 */}
        {/* 外层 wrapper 提供相对定位上下文，供专注遮罩 overlay 使用 */}
        <div
          className="source-editor-wrapper"
          style={{
            // v0.4.0：split 模式下用 width 控制宽度（ratio 来自拖拽），edit 模式用 flex:1
            flex: viewMode === "split" ? "none" : isSourceMode ? 1 : 0,
            width: viewMode === "split" ? `calc(${effectiveSplitRatio * 100}% - 3px)` : undefined,
            display: isSourceMode ? "flex" : "none",
          }}
        >
          <textarea
            ref={sourceTextareaRef}
            className={`source-editor ${viewMode === "split" ? "split-editor" : ""}`}
            value={sourceContent}
            onChange={handleSourceChange.current}
            onKeyDown={handleSourceKeyDown}
            onPaste={handleSourcePaste}
            onContextMenu={handleTextareaContextMenu}
            spellCheck={spellcheckEnabled}
            style={{
              flex: isSourceMode ? 1 : 0,
              display: isSourceMode ? "block" : "none",
              fontSize: `${fontSize}px`,
              fontFamily: `${fontFamily}, "Cascadia Code", "Consolas", monospace`,
              // v0.4.0：split 模式下右边框由分割条替代，避免双线
              borderRight: viewMode === "split" ? "none" : "none",
            }}
          />
          {/* 专注模式遮罩：仅在 edit/split 模式 + focusMode 开启时显示 */}
          {focusMode && isSourceMode && (
            <div ref={focusOverlayRef} className="source-focus-overlay" />
          )}
        </div>

        {/* v0.4.0：分屏分割条（仅 split 模式渲染，6px 宽，可拖拽调整左右比例） */}
        {viewMode === "split" && (
          <div
            className="split-divider"
            title={t("appshell.dragToResize")}
            onMouseDown={splitResizer.onMouseDown}
          />
        )}

        {/* 分屏预览区：使用 iframe 隔离 DOM，减少主文档节点数和 GC 压力 */}
        <iframe
          ref={previewIframeRef}
          className="split-preview ProseMirror"
          style={{
            // v0.4.0：split 模式下用 width 控制宽度（1-ratio），其他模式 flex:0 隐藏
            flex: viewMode === "split" ? "none" : 0,
            display: viewMode === "split" ? "block" : "none",
            border: "none",
            width: viewMode === "split" ? `calc(${(1 - effectiveSplitRatio) * 100}% - 3px)` : "0",
          }}
          title={t("editor.preview")}
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
            // v0.6.6 问题4：lastContentRef 与 content prop 同为真实坐标（unmask 后）
            lastContentRef.current = unmaskBase64Images(newContent, base64TokensRef.current);
          }}
          initialShowReplace={showSearchReplace}
          isMdFile={isMdFile}
        />
      )}

      {/* 链接插入对话框 */}
      <LinkDialog
        open={linkDialogOpen}
        initialText={linkInitialText}
        onInsert={(md) => {
          insertTextAtCursor(md);
          setLinkDialogOpen(false);
        }}
        onClose={() => {
          setLinkDialogOpen(false);
          setLinkInitialText("");
        }}
      />

      {/* 表格插入对话框 */}
      <TableDialog
        open={tableDialogOpen}
        onInsert={(md) => {
          insertTextAtCursor(md);
          setTableDialogOpen(false);
        }}
        onClose={() => setTableDialogOpen(false)}
      />

      {/* 图片插入对话框 */}
      <ImageInsertDialog
        open={imageDialogOpen}
        onInsert={(md) => {
          insertTextAtCursor(md);
          setImageDialogOpen(false);
        }}
        onClose={() => setImageDialogOpen(false)}
      />

      {/* G3：图片编辑对话框 */}
      <ImageEditDialog
        open={imageEditDialogOpen}
        imageSrc={imageEditSrc}
        onConfirm={handleImageEditConfirm}
        onClose={() => {
          setImageEditDialogOpen(false);
          setImageEditPos(null);
          setImageEditSrc("");
        }}
      />

      {/* 编辑器右键菜单 */}
      <EditorContextMenu
        open={contextMenu.open}
        x={contextMenu.x}
        y={contextMenu.y}
        hasSelection={contextMenu.hasSelection}
        canUndo={undoStackRef.current.length > 0}
        canRedo={redoStackRef.current.length > 0}
        isMdFile={isMdFile}
        translateEnabled={translateEnabled}
        onAction={handleContextMenuAction}
        onClose={() => setContextMenu((s) => ({ ...s, open: false }))}
      />

      {/* SlashCommand 菜单：仅源码模式 + Markdown 文件 + 行首 / 触发时渲染 */}
      {isSourceMode && isMdFile && slashCommandOpen && (
        <SlashCommand
          textarea={sourceTextareaRef.current}
          onInsert={handleSlashInsert}
          onClose={handleSlashClose}
        />
      )}

      {/* v0.6.6 问题2：阅读模式 SlashCommand 菜单（ProseMirror 插件触发） */}
      {!isSourceMode && isMdFile && pmSlash && (
        <SlashCommandPm
          view={viewRef.current}
          slash={pmSlash}
          onClose={() => setPmSlash(null)}
        />
      )}

      {/* v0.6.0：AI 翻译结果气泡（Portal 渲染到 body，idle 时组件内部返回 null） */}
      <TranslateBubble
        onApply={handleTranslateApply}
        onCopy={handleTranslateCopy}
        onRetry={handleTranslateRetry}
      />
    </div>
  );
}

// ─── SlashCommand 插入逻辑（纯函数，便于单元测试）─────────────
// 与 handleSlashInsert 的字符串变换逻辑一致：
// - mode="block"：删除光标所在行从行首（含触发的 / 和过滤文字）到光标的内容，
//   在行首插入 markdown
// - mode="inline"：用 markdown 替换选中文本 [cursorPos, selectionEnd)
//
// 提取为独立导出函数的目的：
// 1. 让 handleSlashInsert 的核心逻辑可被单元测试覆盖（回调本身绑定 ref 无法直接测试）
// 2. 与 SlashCommand.tsx 中的 findSlashTrigger / buildInsertText 等纯函数风格一致
export function computeSlashInsert(
  currentContent: string,
  cursorPos: number,
  selectionEnd: number,
  markdown: string,
  mode: InsertMode
): { newContent: string; newCursorPos: number } {
  if (mode === "block") {
    // 找到光标所在行的起点（向前查找到 \n）
    let lineStart = cursorPos;
    while (lineStart > 0 && currentContent[lineStart - 1] !== "\n") lineStart--;
    // 删除 [lineStart, cursorPos) 并在 lineStart 处插入 markdown
    const newContent =
      currentContent.substring(0, lineStart) + markdown + currentContent.substring(cursorPos);
    return { newContent, newCursorPos: lineStart + markdown.length };
  }
  // inline：用 markdown 替换选中文本 [cursorPos, selectionEnd)
  const newContent =
    currentContent.substring(0, cursorPos) + markdown + currentContent.substring(selectionEnd);
  return { newContent, newCursorPos: cursorPos + markdown.length };
}
