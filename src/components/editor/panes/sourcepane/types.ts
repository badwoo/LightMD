/**
 * src/components/editor/panes/SourcePane/types.ts —— SourcePane pane 的入参/出参类型
 *
 * ⚠️ 由 v0.17.0 P0-1 拆分生成：字段类型全部是 TypeChecker 实测（`typeToString`），
 * 没有 any / Record<string,any> 兜底。字段含义见 SourcePane.tsx 文件头与字段名。
 *
 * 这是「纯搬运」的必要成本：hook 体必须逐字节原样，因此它引用的每个外部名字
 * 都要在入参/出参里有显式落点。
 */

import type { RefObject, MutableRefObject, Dispatch, SetStateAction } from "react";
import type * as React from "react";
import type { HistoryCoordinator } from "../../../../editorHistory/coordinator";
import type { SourceAdapter } from "../../../../editorHistory/sourceAdapter";
import type { ViewMode } from "../../../../stores/useEditorStore";
import type { Base64Tokens } from "../../../../utils/base64ImageMask";
import type { FormatPainterMode } from "../../../../utils/formatPainter";
import type { WordCountResult } from "../../../../utils/wordCount";
import type { InsertMode } from "../.././SlashCommand";
import type { EditorView } from "prosemirror-view";
import type { HistoryEntry } from "../../EditorContainer";

/** 容器传给 SourcePane 的全部入参（解构到本地名后 hook 体与拆分前逐字节一致） */
 export interface SourcePaneParams {
  pendingSourceSelectionRef: MutableRefObject<{ start: number; end: number; scrollTop: number | null; until: number; } | null>;
  sourceSelectionRestoreTokenRef: MutableRefObject<number>;
  sourceGhostHandlersRef: MutableRefObject<{ accept: () => boolean; cancel: () => boolean; invalidate: () => void; }>;
  formatGhostHandlersRef: MutableRefObject<{ render: () => void; clear: (kind: string) => void; remove: () => boolean; }>;
  base64TokensRef: MutableRefObject<Base64Tokens>;
  sourceContentRef: MutableRefObject<string>;
  sourceAdapterRef: MutableRefObject<SourceAdapter>;
  sourceComposingRef: MutableRefObject<boolean>;
  sourceJustPairedRef: MutableRefObject<boolean>;
  sourceJustPastedRef: MutableRefObject<boolean>;
  lastSourceScrollTopRef: MutableRefObject<number>;
  historyCoordinatorRef: MutableRefObject<HistoryCoordinator | null>;
  historyDocKeyOrEmpty: () => string;
  lastRealTextRef: MutableRefObject<string>;
  setSourceContent: Dispatch<SetStateAction<string>>;
  onContentChangeRef: MutableRefObject<((markdown: string) => void) | undefined>;
  setDirtyRef: MutableRefObject<(dirty: boolean) => void>;
  lastContentRef: MutableRefObject<string>;
  lastTextareaCursorRef: MutableRefObject<number>;
  wordCountTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  setWordCountRef: MutableRefObject<(count: WordCountResult) => void>;
  editorRef: RefObject<HTMLDivElement>;
  applyHistoryTextRef: MutableRefObject<((text: string, restore: unknown, meta: unknown) => void) | null>;
  viewMode: ViewMode;
  isMdFile: boolean;
  viewRef: MutableRefObject<EditorView | null>;
  historyScrollGuardUntilRef: MutableRefObject<number>;
  HISTORY_SCROLL_GUARD_MS: 400;
  sourceTextareaRef: RefObject<HTMLTextAreaElement>;
  pushUndoEntry: (entry: HistoryEntry) => void;
  recordDiscreteSourceEdit: (beforeMasked: string, afterMasked: string, caret: number, scrollTop: number, afterCaret?: number | undefined) => void;
  filePath: string | null | undefined;
  formatGhostRef: MutableRefObject<{ text: string; pos: number; start: number; end: number; content: string; tail?: string | undefined; maskTail?: boolean | undefined; } | null>;
  isSourceMode: boolean;
  autoPairEnabled: boolean;
  sourceGhostActiveRef: MutableRefObject<boolean>;
}

/** SourcePane 交回容器的全部产物（容器与其它 pane 只通过这些名字使用它） */
export interface SourcePaneResult {
  handleSourceChange: MutableRefObject<(e: React.ChangeEvent<HTMLTextAreaElement>) => void>;
  insertTextAtCursor: (text: string, cursorOffset?: number | undefined) => void;
  insertMarkdownIntoPM: (md: string) => void;
  handleSlashInsert: (markdown: string, mode: InsertMode) => void;
  linkDialogOpen: boolean;
  setLinkDialogOpen: Dispatch<SetStateAction<boolean>>;
  linkInitialText: string;
  setLinkInitialText: Dispatch<SetStateAction<string>>;
  tableDialogOpen: boolean;
  setTableDialogOpen: Dispatch<SetStateAction<boolean>>;
  imageDialogOpen: boolean;
  setImageDialogOpen: Dispatch<SetStateAction<boolean>>;
  imageEditDialogOpen: boolean;
  setImageEditDialogOpen: Dispatch<SetStateAction<boolean>>;
  imageEditSrc: string;
  setImageEditSrc: Dispatch<SetStateAction<string>>;
  imageEditAlt: string;
  setImageEditAlt: Dispatch<SetStateAction<string>>;
  imageEditWidth: number | null;
  setImageEditWidth: Dispatch<SetStateAction<number | null>>;
  imageEditAlign: "left" | "center" | "right";
  setImageEditAlign: Dispatch<SetStateAction<"left" | "center" | "right">>;
  setImageEditPos: Dispatch<SetStateAction<number | null>>;
  contextMenu: { open: boolean; x: number; y: number; hasSelection: boolean; };
  setContextMenu: Dispatch<SetStateAction<{ open: boolean; x: number; y: number; hasSelection: boolean; }>>;
  pmContextMenu: { open: boolean; x: number; y: number; hasSelection: boolean; nodeKind: string | null; hasBlockClipboard: boolean; hasTextClipboard: boolean; };
  setPmContextMenu: Dispatch<SetStateAction<{ open: boolean; x: number; y: number; hasSelection: boolean; nodeKind: string | null; hasBlockClipboard: boolean; hasTextClipboard: boolean; }>>;
  blockKebabMenu: { open: boolean; x: number; y: number; pos: number; hasClipboard: boolean; };
  setBlockKebabMenu: Dispatch<SetStateAction<{ open: boolean; x: number; y: number; pos: number; hasClipboard: boolean; }>>;
  formatPainterMode: FormatPainterMode;
  mermaidMenuOpen: boolean;
  setMermaidMenuOpen: Dispatch<SetStateAction<boolean>>;
  taskStyleMenuOpen: boolean;
  setTaskStyleMenuOpen: Dispatch<SetStateAction<boolean>>;
  slashCommandOpen: boolean;
  setSlashCommandOpen: Dispatch<SetStateAction<boolean>>;
  openLinkDialog: () => void;
  handleImageEditConfirm: (newSrc: string, meta: { alt: string; width: number | null; align: "left" | "center" | "right"; }) => void;
  handleFormatAction: MutableRefObject<(action: string) => void>;
  handleSourcePaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  handleSourceKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}
