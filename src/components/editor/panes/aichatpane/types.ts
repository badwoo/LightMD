/**
 * src/components/editor/panes/AiChatPane/types.ts —— AiChatPane pane 的入参/出参类型
 *
 * ⚠️ 由 v0.17.0 P0-1 拆分生成：字段类型全部是 TypeChecker 实测（`typeToString`），
 * 没有 any / Record<string,any> 兜底。字段含义见 AiChatPane.tsx 文件头与字段名。
 *
 * 这是「纯搬运」的必要成本：hook 体必须逐字节原样，因此它引用的每个外部名字
 * 都要在入参/出参里有显式落点。
 */

import type { SourceSurface } from "../../../../editor/types";
import type { RefObject, MutableRefObject, Dispatch, SetStateAction } from "react";
import type { AiTask } from "../../../../services/aiAssistService";
import type { AiChatContextScope } from "../../../../services/aiChatService";
import type { AiAssistSourceMode } from "../../../../stores/aiAssistStore";
import type { BubbleAnchor } from "../../../../stores/translateStore";
import type { ViewMode } from "../../../../stores/useEditorStore";
import type { Base64Tokens } from "../../../../utils/base64ImageMask";
import type { EditorView } from "prosemirror-view";

/** 容器传给 AiChatPane 的全部入参（解构到本地名后 hook 体与拆分前逐字节一致） */
 export interface AiChatPaneParams {
  /** 源码面契约实现（A2）。选区/全文/滚动的读取与光标恢复经它落地。 */
  sourceSurface: SourceSurface;
  renderSourceGhost: () => void;
  sourceTextareaRef: RefObject<HTMLTextAreaElement>;
  formatGhostRef: MutableRefObject<{ text: string; pos: number; start: number; end: number; content: string; tail?: string | undefined; maskTail?: boolean | undefined; } | null>;
  sourceGhostActiveRef: MutableRefObject<boolean>;
  sourceGhostPosRef: MutableRefObject<number>;
  sourceGhostPlaceholderRef: MutableRefObject<boolean>;
  sourceGhostTextRef: MutableRefObject<string>;
  aiSeqRef: MutableRefObject<number>;
  activeFileRef: MutableRefObject<string | null | undefined>;
  clearSourceGhost: () => void;
  recordDiscreteSourceEdit: (beforeMasked: string, afterMasked: string, caret: number, scrollTop: number, afterCaret?: number | undefined) => void;
  setSourceContent: Dispatch<SetStateAction<string>>;
  onContentChangeRef: MutableRefObject<((markdown: string) => void) | undefined>;
  setDirtyRef: MutableRefObject<(dirty: boolean) => void>;
  lastContentRef: MutableRefObject<string>;
  base64TokensRef: MutableRefObject<Base64Tokens>;
  sourceGhostHandlersRef: MutableRefObject<{ accept: () => boolean; cancel: () => boolean; invalidate: () => void; }>;
  aiCtxRef: MutableRefObject<{ task: AiTask; text: string; sourceMode: AiAssistSourceMode; anchor: BubbleAnchor; start?: number | undefined; end?: number | undefined; insertPos?: number | undefined; filePath: string | null; } | null>;
  viewRef: MutableRefObject<EditorView | null>;
  applyingTranslationRef: MutableRefObject<boolean>;
  activeKeyRef: MutableRefObject<number>;
  sourceContentRef: MutableRefObject<string>;
  content: string;
  viewMode: ViewMode;
  isMdFile: boolean;
  isSourceMode: boolean;
  runAiBubble: (task: AiTask, text: string, sourceMode: AiAssistSourceMode, anchor: BubbleAnchor, start?: number | undefined, end?: number | undefined, insertPos?: number | undefined) => void;
  runAiGhost: (head: string, pos: number) => void;
  startAiAssistRef: MutableRefObject<(task: AiTask) => void>;
  forceUpdateKey: number | undefined;
  startAiChatRef: MutableRefObject<() => void>;
  editorRef: RefObject<HTMLDivElement>;
  ghostActiveRef: MutableRefObject<boolean>;
  sourceGhostOverlayRef: RefObject<HTMLDivElement>;
  lastSyncDiskRef: MutableRefObject<string>;
  filePath: string | null | undefined;
  startFullTranslateRef: MutableRefObject<() => void>;
  startTranslateRef: MutableRefObject<(fallbackToFull?: boolean | undefined) => void>;
  handleFormatAction: MutableRefObject<(action: string) => void>;
}

/** AiChatPane 交回容器的全部产物（容器与其它 pane 只通过这些名字使用它） */
export interface AiChatPaneResult {
  handleAiApply: (task: AiTask, text: string) => void;
  handleAiRetry: () => void;
  getChatContextValues: () => { selection: string; document: string; };
  undoTranslation: () => void;
  sendAiChat: (instruction: string, templateId: string | null) => void;
  stopAiChat: () => void;
  regenerateAiChat: () => void;
  chatInsertAtCursor: (text: string) => void;
  chatReplaceSelection: (text: string) => void;
  chatReplaceDocument: (text: string) => void;
  chatCopy: (text: string) => void;
  chatScopeChange: (scope: AiChatContextScope) => void;
  segmentFailTip: { text: string; count: number; } | null;
  fullTranslateRunning: boolean;
}
