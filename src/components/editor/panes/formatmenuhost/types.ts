/**
 * src/components/editor/panes/FormatMenuHost/types.ts —— FormatMenuHost pane 的入参/出参类型
 *
 * ⚠️ 由 v0.17.0 P0-1 拆分生成：字段类型全部是 TypeChecker 实测（`typeToString`），
 * 没有 any / Record<string,any> 兜底。字段含义见 FormatMenuHost.tsx 文件头与字段名。
 *
 * 这是「纯搬运」的必要成本：hook 体必须逐字节原样，因此它引用的每个外部名字
 * 都要在入参/出参里有显式落点。
 */

import type { SourceSurface } from "../../../../editor/types";
import type { RefObject, MutableRefObject, Dispatch, SetStateAction } from "react";
import type * as React from "react";
import type { SlashState } from "../../../../core/plugins/slash-command";
import type { AiTask } from "../../../../services/aiAssistService";
import type { ViewMode } from "../../../../stores/useEditorStore";
import type { Theme } from "../../../../stores/useSettingsStore";
import type { Base64Tokens } from "../../../../utils/base64ImageMask";
import type { FormatPainterMode } from "../../../../utils/formatPainter";
import type { EditorView } from "prosemirror-view";

/** 容器传给 FormatMenuHost 的全部入参（解构到本地名后 hook 体与拆分前逐字节一致） */
 export interface FormatMenuHostParams {
  /** 源码面契约实现（A2）。光标/选区/滚动的恢复经它落地。 */
  sourceSurface: SourceSurface;
  isSourceMode: boolean;
  isMdFile: boolean;
  sourceTextareaRef: RefObject<HTMLTextAreaElement>;
  setContextMenu: Dispatch<SetStateAction<{ open: boolean; x: number; y: number; hasSelection: boolean; }>>;
  handleUndo: () => void;
  handleRedo: () => void;
  openLinkDialog: () => void;
  insertTextAtCursor: (text: string, cursorOffset?: number | undefined) => void;
  startTranslateRef: MutableRefObject<(fallbackToFull?: boolean | undefined) => void>;
  handleFormatAction: MutableRefObject<(action: string) => void>;
  setImageDialogOpen: Dispatch<SetStateAction<boolean>>;
  setTableDialogOpen: Dispatch<SetStateAction<boolean>>;
  setMermaidMenuOpen: Dispatch<SetStateAction<boolean>>;
  viewMode: ViewMode;
  viewRef: MutableRefObject<EditorView | null>;
  sourceContentRef: MutableRefObject<string>;
  recordDiscreteSourceEdit: (beforeMasked: string, afterMasked: string, caret: number, scrollTop: number, afterCaret?: number | undefined) => void;
  setSourceContent: Dispatch<SetStateAction<string>>;
  onContentChangeRef: MutableRefObject<((markdown: string) => void) | undefined>;
  setDirtyRef: MutableRefObject<(dirty: boolean) => void>;
  lastContentRef: MutableRefObject<string>;
  base64TokensRef: MutableRefObject<Base64Tokens>;
  editorRef: RefObject<HTMLDivElement>;
  formatPainterMode: FormatPainterMode;
  filePath: string | null | undefined;
  setPmContextMenu: Dispatch<SetStateAction<{ open: boolean; x: number; y: number; hasSelection: boolean; nodeKind: string | null; hasBlockClipboard: boolean; hasTextClipboard: boolean; }>>;
  setBlockKebabMenu: Dispatch<SetStateAction<{ open: boolean; x: number; y: number; pos: number; hasClipboard: boolean; }>>;
  blockKebabMenu: { open: boolean; x: number; y: number; pos: number; hasClipboard: boolean; };
  t: (key: string, params?: Record<string, string | number> | undefined) => string;
  insertMarkdownIntoPM: (md: string) => void;
  startAiAssistRef: MutableRefObject<(task: AiTask) => void>;
  mermaidMenuOpen: boolean;
  setTaskStyleMenuOpen: Dispatch<SetStateAction<boolean>>;
  taskStyleMenuOpen: boolean;
  setSlashCommandOpen: Dispatch<SetStateAction<boolean>>;
  setPmSlash: Dispatch<SetStateAction<SlashState | null>>;
  focusMode: boolean;
  forceUpdateKey: number | undefined;
  theme: Theme;
  focusOverlayRef: RefObject<HTMLDivElement>;
  lineHeight: number;
  sourceContent: string;
}

/** FormatMenuHost 交回容器的全部产物（容器与其它 pane 只通过这些名字使用它） */
export interface FormatMenuHostResult {
  handleTextareaContextMenu: (e: React.MouseEvent<HTMLTextAreaElement>) => void;
  handleContextMenuAction: (action: string) => void;
  armFormatPainterRef: MutableRefObject<(persistent: boolean) => void>;
  applyHeadingLevel: (pos: number, level: number) => void;
  handleBlockKebabAction: (action: string) => void;
  handlePmMenuAction: (action: string) => void;
  handleMermaidTemplateSelect: (syntax: string) => void;
  handleTaskStyleSelect: (style: "square" | "circle") => void;
  handleSlashClose: () => void;
}
