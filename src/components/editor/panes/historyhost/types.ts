/**
 * src/components/editor/panes/HistoryHost/types.ts —— HistoryHost pane 的入参/出参类型
 *
 * ⚠️ 由 v0.17.0 P0-1 拆分生成：字段类型全部是 TypeChecker 实测（`typeToString`），
 * 没有 any / Record<string,any> 兜底。字段含义见 HistoryHost.tsx 文件头与字段名。
 *
 * 这是「纯搬运」的必要成本：hook 体必须逐字节原样，因此它引用的每个外部名字
 * 都要在入参/出参里有显式落点。
 */

import type { RefObject, MutableRefObject, Dispatch, SetStateAction } from "react";
import type { HistoryCoordinator } from "../../../../editorHistory/coordinator";
import type { PmAdapter } from "../../../../editorHistory/pmAdapter";
import type { SourceAdapter } from "../../../../editorHistory/sourceAdapter";
import type { ViewMode } from "../../../../stores/useEditorStore";
import type { Base64Tokens } from "../../../../utils/base64ImageMask";
import type { ContentAnchor } from "../../../../utils/contentScrollMap";
import type { EditorView } from "prosemirror-view";
import type { HistoryEntry } from "../../EditorContainer";

/** 容器传给 HistoryHost 的全部入参（解构到本地名后 hook 体与拆分前逐字节一致） */
 export interface HistoryHostParams {
  viewMode: ViewMode;
  isMdFile: boolean;
  viewRef: MutableRefObject<EditorView | null>;
  sourceContentRef: MutableRefObject<string>;
  base64TokensRef: MutableRefObject<Base64Tokens>;
  filePath: string | null | undefined;
  forceUpdateKey: number | undefined;
  editorRef: RefObject<HTMLDivElement>;
  sourceTextareaRef: RefObject<HTMLTextAreaElement>;
  sourceContent: string;
  pendingSourceSelectionRef: MutableRefObject<{ start: number; end: number; scrollTop: number | null; until: number; } | null>;
  lastTextareaCursorRef: MutableRefObject<number>;
  content: string;
  isSourceMode: boolean;
  setSourceContent: Dispatch<SetStateAction<string>>;
  setDebouncedSourceContent: Dispatch<SetStateAction<string>>;
  onContentChangeRef: MutableRefObject<((markdown: string) => void) | undefined>;
  setDirtyRef: MutableRefObject<(dirty: boolean) => void>;
  lastContentRef: MutableRefObject<string>;
  formatGhostHandlersRef: MutableRefObject<{ render: () => void; clear: (kind: string) => void; remove: () => boolean; }>;
  setUndoHandler: (handler: (() => void) | null) => void;
  setRedoHandler: (handler: (() => void) | null) => void;
}

/** HistoryHost 交回容器的全部产物（容器与其它 pane 只通过这些名字使用它） */
export interface HistoryHostResult {
  undoStackRef: MutableRefObject<HistoryEntry[]>;
  redoStackRef: MutableRefObject<HistoryEntry[]>;
  historyDocKeyOrEmpty: () => string;
  historyCoordinatorRef: MutableRefObject<HistoryCoordinator | null>;
  lastRealTextRef: MutableRefObject<string>;
  docKeyRef: MutableRefObject<string | null>;
  lastHistoryContentRef: MutableRefObject<string>;
  pmScrollPercentRef: MutableRefObject<number>;
  textareaScrollPercentRef: MutableRefObject<number>;
  isSyncingScrollRef: MutableRefObject<boolean>;
  pendingScrollRef: MutableRefObject<{ targetMode: ViewMode; percent: number; anchorLine?: number | null | undefined; anchorColumn?: number | null | undefined; contentAnchor?: ContentAnchor | null | undefined; } | null>;
  prevViewModeRef: MutableRefObject<ViewMode>;
  isRestoringScrollRef: MutableRefObject<boolean>;
  historyScrollGuardUntilRef: MutableRefObject<number>;
  HISTORY_SCROLL_GUARD_MS: 400;
  inHistoryScrollGuard: () => boolean;
  scrollRestoreGenRef: MutableRefObject<number>;
  modeAnim: "to-edit" | "to-preview" | null;
  setModeAnim: Dispatch<SetStateAction<"to-edit" | "to-preview" | null>>;
  modeAnimGenRef: MutableRefObject<number>;
  modeSwitchAnchorRef: MutableRefObject<ContentAnchor | null>;
  cachePmGeometry: () => void;
  cacheSourceGeometry: () => void;
  pushUndoEntry: (entry: HistoryEntry) => void;
  recordDiscreteSourceEdit: (beforeMasked: string, afterMasked: string, caret: number, scrollTop: number, afterCaret?: number | undefined) => void;
  writeBackCurrentDoc: (newText: string) => void;
  sourceAdapterRef: MutableRefObject<SourceAdapter>;
  pmAdapterRef: MutableRefObject<PmAdapter>;
  applyHistoryTextRef: MutableRefObject<((text: string, restore: unknown, meta: unknown) => void) | null>;
  sourceComposingRef: MutableRefObject<boolean>;
  sourceJustPairedRef: MutableRefObject<boolean>;
  sourceJustPastedRef: MutableRefObject<boolean>;
  canUndoUnified: () => boolean;
  canRedoUnified: () => boolean;
  handleUndo: () => void;
  handleRedo: () => void;
}
