/**
 * src/components/editor/panes/PreviewPane/types.ts —— PreviewPane pane 的入参/出参类型
 *
 * ⚠️ 由 v0.17.0 P0-1 拆分生成：字段类型全部是 TypeChecker 实测（`typeToString`），
 * 没有 any / Record<string,any> 兜底。字段含义见 PreviewPane.tsx 文件头与字段名。
 *
 * 这是「纯搬运」的必要成本：hook 体必须逐字节原样，因此它引用的每个外部名字
 * 都要在入参/出参里有显式落点。
 */

import type { SourceSurface } from "../../../../editor/types";
import type { RefObject, MutableRefObject, Dispatch, SetStateAction } from "react";
import type { ViewMode } from "../../../../stores/useEditorStore";
import type { Theme } from "../../../../stores/useSettingsStore";
import type { Base64Tokens } from "../../../../utils/base64ImageMask";
import type { TextContentAnchor } from "../../../../utils/viewportAnchor";
import type { EditorView } from "prosemirror-view";

/** 容器传给 PreviewPane 的全部入参（解构到本地名后 hook 体与拆分前逐字节一致） */
 export interface PreviewPaneParams {
  /**
   * 源码面契约实现（A3-④）。打字机/专注遮罩的**光标几何**经它取，
   * 使同一段机制在 textarea（mirror）与 CM6（coordsAtPos）下都成立。
   */
  sourceSurface: SourceSurface;
  viewMode: ViewMode;
  isMdFile: boolean;
  isSourceMode: boolean;
  previewShown: boolean;
  editorRef: RefObject<HTMLDivElement>;
  sourceTextareaRef: RefObject<HTMLTextAreaElement>;
  previewIframeRef: RefObject<HTMLIFrameElement>;
  effFontSize: number;
  effFontFamily: string;
  effLineHeight: number;
  effParagraphSpacing: number;
  effContentMaxWidth: number;
  docZoom: number;
  adjustDocZoom: (delta: number) => void;
  mainAreaRef: RefObject<HTMLDivElement>;
  filePath: string | null | undefined;
  forceUpdateKey: number | undefined;
  anchorSuppressUntilRef: MutableRefObject<number>;
  textAnchorRef: MutableRefObject<TextContentAnchor | null>;
  formatGhostHandlersRef: MutableRefObject<{ render: () => void; clear: (kind: string) => void; remove: () => boolean; }>;
  setScrollProgress: (pct: number) => void;
  spellcheckEnabled: boolean;
  theme: Theme;
  typewriterMode: boolean;
  viewRef: MutableRefObject<EditorView | null>;
  scrollToCenterRef: MutableRefObject<() => void>;
  isRestoringScrollRef: MutableRefObject<boolean>;
  inHistoryScrollGuard: () => boolean;
  typewriterModeRef: MutableRefObject<boolean>;
  t: (key: string, params?: Record<string, string | number> | undefined) => string;
  sourceContent: string;
  setDebouncedSourceContent: Dispatch<SetStateAction<string>>;
  debouncedSourceContent: string;
  currentLanguage: string;
  base64TokensRef: MutableRefObject<Base64Tokens>;
  typographyPreviewKey: string;
  pendingIframeScrollRef: MutableRefObject<number | null>;
  isSyncingScrollRef: MutableRefObject<boolean>;
  handleUndo: () => void;
  handleRedo: () => void;
  openLinkDialog: () => void;
  setImageDialogOpen: Dispatch<SetStateAction<boolean>>;
  setTableDialogOpen: Dispatch<SetStateAction<boolean>>;
  setMermaidMenuOpen: Dispatch<SetStateAction<boolean>>;
  armFormatPainterRef: MutableRefObject<(persistent: boolean) => void>;
  handleFormatAction: MutableRefObject<(action: string) => void>;
}

/** PreviewPane 交回容器的全部产物（容器与其它 pane 只通过这些名字使用它） */
export interface PreviewPaneResult {
  codePreviewHtml: string;
  onFormatBtnClick: (action: string, detail?: number) => void;
}
