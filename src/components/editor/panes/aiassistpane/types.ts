/**
 * src/components/editor/panes/AiAssistPane/types.ts —— AiAssistPane pane 的入参/出参类型
 *
 * ⚠️ 由 v0.17.0 P0-1 拆分生成：字段类型全部是 TypeChecker 实测（`typeToString`），
 * 没有 any / Record<string,any> 兜底。字段含义见 AiAssistPane.tsx 文件头与字段名。
 *
 * 这是「纯搬运」的必要成本：hook 体必须逐字节原样，因此它引用的每个外部名字
 * 都要在入参/出参里有显式落点。
 */

import type { RefObject, MutableRefObject, Dispatch, SetStateAction } from "react";
import type { AiAssistTask } from "../../../../core/plugins/translateTooltip";
import type { AiTask } from "../../../../services/aiAssistService";
import type { AiAssistSourceMode } from "../../../../stores/aiAssistStore";
import type { BubbleAnchor } from "../../../../stores/translateStore";
import type { ViewMode } from "../../../../stores/useEditorStore";
import type { Base64Tokens } from "../../../../utils/base64ImageMask";
import type { EditorView } from "prosemirror-view";
import type { SourceSurface } from "../../../../editor/types";

/** 容器传给 AiAssistPane 的全部入参（解构到本地名后 hook 体与拆分前逐字节一致） */
 export interface AiAssistPaneParams {
  /**
   * 源码面契约实现（A2）。配对落地必须经 `applyEdit()`（单事务单步），
   * 不再走 `document.execCommand("insertText")`（任务卡 G7 退役路径）。
   */
  sourceSurface: SourceSurface;
  isSourceMode: boolean;
  isMdFile: boolean;
  sourceTextareaRef: RefObject<HTMLTextAreaElement>;
  triggerMenuPosRef: MutableRefObject<(x: number, y: number) => void>;
  aiMenuPosRef: MutableRefObject<(x: number, y: number, task: AiAssistTask | null) => void>;
  viewRef: MutableRefObject<EditorView | null>;
  filePath: string | null | undefined;
  progressKeyRef: MutableRefObject<string | null>;
  forceUpdateKey: number | undefined;
  viewMode: ViewMode;
  startFullTranslateRef: MutableRefObject<() => void>;
  sourceContentRef: MutableRefObject<string>;
  previewShown: boolean;
  previewIframeRef: RefObject<HTMLIFrameElement>;
  startTranslateRef: MutableRefObject<(fallbackToFull?: boolean | undefined) => void>;
  applyingTranslationRef: MutableRefObject<boolean>;
  recordDiscreteSourceEdit: (beforeMasked: string, afterMasked: string, caret: number, scrollTop: number, afterCaret?: number | undefined) => void;
  setSourceContent: Dispatch<SetStateAction<string>>;
  onContentChangeRef: MutableRefObject<((markdown: string) => void) | undefined>;
  setDirtyRef: MutableRefObject<(dirty: boolean) => void>;
  lastContentRef: MutableRefObject<string>;
  base64TokensRef: MutableRefObject<Base64Tokens>;
  sourceGhostActiveRef: MutableRefObject<boolean>;
  formatGhostRef: MutableRefObject<{ text: string; pos: number; start: number; end: number; content: string; tail?: string | undefined; maskTail?: boolean | undefined; } | null>;
  formatGhostHandlersRef: MutableRefObject<{ render: () => void; clear: (kind: string) => void; remove: () => boolean; }>;
}

/** AiAssistPane 交回容器的全部产物（容器与其它 pane 只通过这些名字使用它） */
export interface AiAssistPaneResult {
  triggerMenuPos: { x: number; y: number; } | null;
  setTriggerMenuPos: Dispatch<SetStateAction<{ x: number; y: number; } | null>>;
  aiMenuPos: { x: number; y: number; task: AiAssistTask | null; } | null;
  setAiMenuPos: Dispatch<SetStateAction<{ x: number; y: number; task: AiAssistTask | null; } | null>>;
  hideTranslateTrigger: () => void;
  activeFileRef: MutableRefObject<string | null | undefined>;
  activeKeyRef: MutableRefObject<number>;
  currentDocKey: () => string | null;
  handleTranslateApply: (mode: "replace" | "bilingual", translated: string) => void;
  handleTranslateCopy: (text: string) => void;
  handleTranslateRetry: () => void;
  aiCtxRef: MutableRefObject<{ task: AiTask; text: string; sourceMode: AiAssistSourceMode; anchor: BubbleAnchor; start?: number | undefined; end?: number | undefined; insertPos?: number | undefined; filePath: string | null; } | null>;
  aiSeqRef: MutableRefObject<number>;
  ghostActiveRef: MutableRefObject<boolean>;
  sourceGhostOverlayRef: RefObject<HTMLDivElement>;
  sourceGhostPlaceholderRef: MutableRefObject<boolean>;
  sourceGhostTextRef: MutableRefObject<string>;
  sourceGhostPosRef: MutableRefObject<number>;
  runAiBubble: (task: AiTask, text: string, sourceMode: AiAssistSourceMode, anchor: BubbleAnchor, start?: number | undefined, end?: number | undefined, insertPos?: number | undefined) => void;
  runAiGhost: (head: string, pos: number) => void;
  renderSourceGhost: () => void;
  clearSourceGhost: () => void;
}
