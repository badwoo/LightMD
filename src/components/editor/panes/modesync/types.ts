/**
 * src/components/editor/panes/ModeSync/types.ts —— ModeSync pane 的入参/出参类型
 *
 * ⚠️ 由 v0.17.0 P0-1 拆分生成：字段类型全部是 TypeChecker 实测（`typeToString`），
 * 没有 any / Record<string,any> 兜底。字段含义见 ModeSync.tsx 文件头与字段名。
 *
 * 这是「纯搬运」的必要成本：hook 体必须逐字节原样，因此它引用的每个外部名字
 * 都要在入参/出参里有显式落点。
 */

import type { SourceSurface } from "../../../../editor/types";
import type { RefObject, MutableRefObject, Dispatch, SetStateAction } from "react";
import type { EmojiState } from "../../../../core/plugins/emoji-complete";
import type { SlashState } from "../../../../core/plugins/slash-command";
import type { AiAssistTask } from "../../../../core/plugins/translateTooltip";
import type { PmAdapter } from "../../../../editorHistory/pmAdapter";
import type { SourceAdapter } from "../../../../editorHistory/sourceAdapter";
import type { AiTask } from "../../../../services/aiAssistService";
import type { ViewMode } from "../../../../stores/useEditorStore";
import type { Base64Tokens } from "../../../../utils/base64ImageMask";
import type { ContentAnchor } from "../../../../utils/contentScrollMap";
import type { WordCountResult } from "../../../../utils/wordCount";
import type { EditorView } from "prosemirror-view";
import type { HistoryEntry, ScrollRestoreTarget } from "../../EditorContainer";

/** 容器传给 ModeSync 的全部入参（解构到本地名后 hook 体与拆分前逐字节一致） */
 export interface ModeSyncParams {
  /**
   * 源码面契约实现（A2）。模式切换的内容同步与**光标/滚动恢复**经它落地，
   * 使同一段代码在 textarea 与 CM6 两种实现下都成立。
   */
  sourceSurface: SourceSurface;
  isSourceMode: boolean;
  setSourceInsertHandler: (handler: ((syntax: string, cursorOffset?: number | undefined, opts?: { label?: string | undefined; ghost?: string | undefined; } | undefined) => void) | null) => void;
  pushUndoEntry: (entry: HistoryEntry) => void;
  sourceTextareaRef: RefObject<HTMLTextAreaElement>;
  sourceContentRef: MutableRefObject<string>;
  recordDiscreteSourceEdit: (beforeMasked: string, afterMasked: string, caret: number, scrollTop: number, afterCaret?: number | undefined) => void;
  setSourceContent: Dispatch<SetStateAction<string>>;
  onContentChangeRef: MutableRefObject<((markdown: string) => void) | undefined>;
  setDirtyRef: MutableRefObject<(dirty: boolean) => void>;
  lastContentRef: MutableRefObject<string>;
  base64TokensRef: MutableRefObject<Base64Tokens>;
  formatGhostRef: MutableRefObject<{ text: string; pos: number; start: number; end: number; content: string; tail?: string | undefined; maskTail?: boolean | undefined; } | null>;
  sourceGhostHandlersRef: MutableRefObject<{ accept: () => boolean; cancel: () => boolean; invalidate: () => void; }>;
  formatGhostHandlersRef: MutableRefObject<{ render: () => void; clear: (kind: string) => void; remove: () => boolean; }>;
  lastTextareaCursorRef: MutableRefObject<number>;
  typewriterMode: boolean;
  editorRef: RefObject<HTMLDivElement>;
  filePath: string | null | undefined;
  docKeyRef: MutableRefObject<string | null>;
  currentDocKeyFromStore: () => string | null;
  lastHistoryContentRef: MutableRefObject<string>;
  content: string;
  applyingTranslationRef: MutableRefObject<boolean>;
  setCursorLineRef: MutableRefObject<(line: number) => void>;
  setCursorColumnRef: MutableRefObject<(column: number) => void>;
  setSelectedCharsRef: MutableRefObject<(count: number) => void>;
  wordCountTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  setWordCountRef: MutableRefObject<(count: WordCountResult) => void>;
  isRestoringScrollRef: MutableRefObject<boolean>;
  viewRef: MutableRefObject<EditorView | null>;
  pmAdapterRef: MutableRefObject<PmAdapter>;
  sourceAdapterRef: MutableRefObject<SourceAdapter>;
  lastRealTextRef: MutableRefObject<string>;
  onEditorReadyRef: MutableRefObject<((view: EditorView) => void) | undefined>;
  startTranslateRef: MutableRefObject<(fallbackToFull?: boolean | undefined) => void>;
  triggerMenuPosRef: MutableRefObject<(x: number, y: number) => void>;
  startAiChatRef: MutableRefObject<() => void>;
  startAiAssistRef: MutableRefObject<(task: AiTask) => void>;
  aiMenuPosRef: MutableRefObject<(x: number, y: number, task: AiAssistTask | null) => void>;
  setPmSlash: Dispatch<SetStateAction<SlashState | null>>;
  setPmEmoji: Dispatch<SetStateAction<EmojiState | null>>;
  setHeadingMenu: Dispatch<SetStateAction<{ open: boolean; anchor: DOMRect | null; level: number; pos: number; }>>;
  forceUpdateKey: number | undefined;
  pmScrollPercentRef: MutableRefObject<number>;
  cachePmGeometry: () => void;
  progressKeyRef: MutableRefObject<string | null>;
  viewMode: ViewMode;
  setDocHasImageFlag: Dispatch<SetStateAction<boolean>>;
  cacheSourceGeometry: () => void;
  lastSourceScrollTopRef: MutableRefObject<number>;
  textareaScrollPercentRef: MutableRefObject<number>;
  isMdFile: boolean;
  lastForceUpdateKeyRef: MutableRefObject<number | undefined>;
  lastSyncDiskRef: MutableRefObject<string>;
  undoStackRef: MutableRefObject<HistoryEntry[]>;
  redoStackRef: MutableRefObject<HistoryEntry[]>;
  previewShown: boolean;
  pendingIframeScrollRef: MutableRefObject<number | null>;
  prevViewModeRef: MutableRefObject<ViewMode>;
  modeAnimGenRef: MutableRefObject<number>;
  setModeAnim: Dispatch<SetStateAction<"to-edit" | "to-preview" | null>>;
  pendingScrollRef: MutableRefObject<{ targetMode: ViewMode; percent: number; anchorLine?: number | null | undefined; anchorColumn?: number | null | undefined; contentAnchor?: ContentAnchor | null | undefined; } | null>;
  modeSwitchAnchorRef: MutableRefObject<ContentAnchor | null>;
  sourceContent: string;
  textareaTopFromContentAnchor: (textarea: HTMLTextAreaElement, anchor: ContentAnchor | null | undefined) => number | null;
  restoreScrollWithRetry: (target: ScrollRestoreTarget | null, percent: number, attempt?: number, shouldContinue?: () => boolean) => boolean;
  restorePendingIframeScroll: () => void;
  scrollRestoreGenRef: MutableRefObject<number>;
}

/** ModeSync 交回容器的全部产物（容器与其它 pane 只通过这些名字使用它） */
export interface ModeSyncResult {
  typewriterModeRef: MutableRefObject<boolean>;
  scrollToCenterRef: MutableRefObject<() => void>;
  activeIsReadonly: boolean;
}
