/**
 * EditorContainer —— ProseMirror EditorView 的 React 挂载点（v0.17.0 组装层）
 *
 * ## v0.17.0 P0-1 拆分后的职责
 *
 * 本文件只做三件事：
 * 1. **持有跨 pane 共享的作用域**（87 条 BASE 声明 + 21 条提升语句）；
 * 2. **按固定顺序调用七个 pane hook**，并把结果解构回原作用域名；
 * 3. **渲染 JSX 骨架**（DOM 结构一字未改）。
 *
 * 所有业务逻辑已搬到 `panes/`：
 * - `panes/historyhost/HistoryHost.tsx`（useHistoryHost）
 * - `panes/modesync/ModeSync.tsx`（useModeSync）
 * - `panes/sourcepane/SourcePane.tsx`（useSourcePane）
 * - `panes/aiassistpane/AiAssistPane.tsx`（useAiAssistPane）
 * - `panes/searchhost/SearchHost.tsx`（useSearchHost）
 * - `panes/aichatpane/AiChatPane.tsx`（useAiChatPane）
 * - `panes/formatmenuhost/FormatMenuHost.tsx`（useFormatMenuHost）
 * - `panes/previewpane/PreviewPane.tsx`（usePreviewPane）
 *
 * ## 为什么 hook 调用必须在这个位置
 *
 * BASE 层实测**不消费任何 pane 产物**（拆分前专门校验：BASE → pane 的引用数为 0），
 * 所以 hook 调用可以在全部 BASE 声明之后、JSX 之前，且顺序取原文件中语句出现的顺序。
 * hook 体逐字节原样（含 useEffect 顺序），因此 React 的 effect 执行次序与拆分前完全一致。
 *
 * ## 为什么这些名字留在容器（提升语句）
 *
 * 21 条原属于某个 pane 的声明被提升到容器，唯一原因是**多个 pane 都要用它**
 * （例如 `previewIframeRef` 被 PreviewPane 建、被 ModeSync 的滚动恢复读）。
 * 提升语句同样逐字节原样，只是换了宿主作用域。
 */

import { readAutoPairConfig } from "../../core/plugins/auto-pair";
import { EmojiState } from "../../core/plugins/emoji-complete";
import { SlashState } from "../../core/plugins/slash-command";
import { AI_BUBBLE_DEFS, AiAssistTask } from "../../core/plugins/translateTooltip";
import { renderMarkdownHtml, topLevelBlockStartLines } from "../../core/renderPipeline";
import { useAutoSave } from "../../hooks/useAutoSave";
import { useResizable } from "../../hooks/useResizable";
import { t as translate, useT } from "../../i18n";
import { AiTask } from "../../services/aiAssistService";
import { translateService } from "../../services/translateService";
import { useEditorStore } from "../../stores/useEditorStore";
import { useFileStore } from "../../stores/useFileStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useTypographyPreviewStore, withPreview } from "../../stores/useTypographyPreviewStore";
import { Base64Tokens, unmaskBase64Images } from "../../utils/base64ImageMask";
import { buildBlockMenuItems } from "../../utils/blockActionMenu";
import { measureSourceLineAxis } from "../../utils/blockScrollAlign";
import { isMarkdownFile } from "../../utils/constants";
import { ContentAnchor, blockGeometryFromLineAxis, restoreTextareaContentAnchor } from "../../utils/contentScrollMap";
import { isInInlineCodeOrMath } from "../../utils/inlineContext";
import { SourcePairInput, SourcePairPlan } from "../../utils/sourceAutoPair";
import { UNTITLED_PROGRESS_PREFIX } from "../../utils/tabKey";
import { computeRestoreScrollTop } from "../../utils/typewriter";
import { TextContentAnchor } from "../../utils/viewportAnchor";
import { ImageEditDialog } from "../dialogs/ImageEditDialog";
import { ImageInsertDialog } from "../dialogs/ImageInsertDialog";
import { LinkDialog } from "../dialogs/LinkDialog";
import { TableDialog } from "../dialogs/TableDialog";
import { ImageLightbox } from "../image/ImageLightbox";
import { AiAssistBubble } from "./AiAssistBubble";
import { AiChatDialog } from "./AiChatDialog";
import { EditorContextMenu } from "./EditorContextMenu";
import { EmojiCompletePm } from "./EmojiCompletePm";
import { FullTranslateButton } from "./FullTranslateButton";
import { HeadingLevelMenu } from "./HeadingLevelMenu";
import { ImageManagerButton } from "./ImageManagerButton";
import { MiniContextMenu, MiniMenuItem } from "./MiniContextMenu";
import { ModeSwitchButton } from "./ModeSwitchButton";
import { PmContextMenu } from "./PmContextMenu";
import { GenieSearchDialog } from "./SearchReplace";
import { InsertMode, SlashCommand, isInCodeBlock } from "./SlashCommand";
import { SlashCommandPm } from "./SlashCommandPm";
import { TranslateBubble } from "./TranslateBubble";
import { TranslateUndoToast } from "./TranslateUndoToast";
import { ZoomRuler } from "./ZoomRuler";
import { FORMAT_BUTTONS as formatButtons, MERMAID_TEMPLATES, formatButtonTitle } from "./sourceFormat";
import { Node as PMNode } from "prosemirror-model";
import { EditorState, Transaction } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHistoryHost } from "./panes/historyhost/HistoryHost";
import { useModeSync } from "./panes/modesync/ModeSync";
import { useSourcePane } from "./panes/sourcepane/SourcePane";
import { useAiAssistPane } from "./panes/aiassistpane/AiAssistPane";
import { useSearchHost } from "./panes/searchhost/SearchHost";
import { useAiChatPane } from "./panes/aichatpane/AiChatPane";
import { useFormatMenuHost } from "./panes/formatmenuhost/FormatMenuHost";
import { usePreviewPane } from "./panes/previewpane/PreviewPane";
import { createSourceSurface } from "../../editor/createSourceSurface";
import type { SourceSurface } from "../../editor/types";

export function shouldOpenImageEditor(img: { getAttribute(name: string): string | null }, isReadonly: boolean): boolean {
  if (img.getAttribute("data-editable") !== "true") return false;
  return !isReadonly;
}

export interface HistoryEntry {
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

export const MAX_HISTORY = 30;

export function sameTaskList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  if (x.length !== y.length) return false;
  return x.every((item) => y.includes(item));
}

export const AI_BUBBLE_GLYPHS: Record<AiAssistTask, string> = Object.fromEntries(
  AI_BUBBLE_DEFS.map((d) => [d.task, d.text])
) as Record<AiAssistTask, string>;

export function canReplaceDocument(currentText: string | null, snapshot: string): boolean {
  return currentText !== null && currentText === snapshot;
}

export function isPmSelectionSnapshotValid(
  snapshotDoc: PMNode | undefined,
  currentDoc: PMNode | undefined
): snapshotDoc is PMNode {
  return !!snapshotDoc && snapshotDoc === currentDoc;
}

export function isSourceSelectionSnapshotValid(
  snapshot: string | undefined,
  current: string
): boolean {
  return snapshot !== undefined && snapshot === current;
}

export function computeDiff(oldText: string, newText: string): { start: number; deleted: string; inserted: string } {
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

function applyDiff(text: string, entry: HistoryEntry, reverse: boolean): string {
  const deleted = reverse ? entry.inserted : entry.deleted;
  const inserted = reverse ? entry.deleted : entry.inserted;
  return text.substring(0, entry.start) + inserted + text.substring(entry.start + deleted.length);
}

export function renderMarkdownToHtml(markdown: string): string {
  try {
    // R1(v0.10.0)：分屏预览统一走渲染管线——markdown-it 配置（typographer false +
    // validateLink 白名单 + HTML 白名单）与编辑器/导出同源，mermaid 包装与 Prism 高亮
    // 步骤也与导出管线共用（此前为分屏/导出各复制一份，是渲染漂移温床）
    return renderMarkdownHtml(markdown);
  } catch {
    return `<p>${translate("editor.renderFailed")}</p>`;
  }
}

export function shouldSkipProseMirrorSync(isMdFile: boolean, fromSource: boolean, toSource: boolean): boolean {
  // 编辑 ↔ 分屏：不需要同步内容，只恢复滚动位置
  if (fromSource && toSource) return true;
  // 非 md 文件：ProseMirror 为空，跳过 doc 转换，避免内容丢失
  if (!isMdFile) return true;
  return false;
}

export function shouldReplacePmDoc(sourceMarkdown: string, pmMarkdown: string): boolean {
  return sourceMarkdown !== pmMarkdown;
}

export function shouldResetSourceUndoStack(prevText: string, syncedText: string): boolean {
  return prevText !== syncedText;
}

export function crossFileEditMatches(recordText: string, currentText: string): boolean {
  return recordText === currentText;
}

export const SCROLL_RESTORE_RETRY_MS = 60;

export const SCROLL_RESTORE_MAX_RETRIES = 24;

export const SCROLL_RESTORE_GUARD_MS = 400;

export const MODE_SLIDE_MS = 380;

export function traceScroll(event: string, data: Record<string, unknown>): void {
  try {
    const w = window as unknown as { __LMD_SCROLL_TRACE?: unknown[] };
    const trace = w.__LMD_SCROLL_TRACE;
    if (!Array.isArray(trace)) return;
    if (trace.length > 4000) return;
    trace.push({ event, t: Math.round(performance.now() * 10) / 10, ...data });
  } catch {
    /* 诊断埋点绝不影响功能 */
  }
}

export interface ScrollRestoreTarget {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}

export interface ScrollRestorePlan {
  /** 目标容器已可滚动 → 写入 top */
  apply: boolean;
  /** 尚不可滚动但期望非顶部 → 稍后重试 */
  retry: boolean;
  /** 写入值（apply 为 false 时为 0，调用方不应写入） */
  top: number;
}

export function planScrollRestore(
  percent: number,
  scrollHeight: number,
  clientHeight: number,
  attempt: number,
  maxAttempts: number = SCROLL_RESTORE_MAX_RETRIES,
): ScrollRestorePlan {
  const top = computeRestoreScrollTop(percent, scrollHeight, clientHeight);
  if (top !== null) return { apply: true, retry: false, top };
  const wantNonTop = Number.isFinite(percent) && percent > 0;
  return { apply: false, retry: wantNonTop && attempt < maxAttempts, top: 0 };
}

export function sourceUndoBoundaryMessage(undoStackLength: number): string | null {
  return undoStackLength === 0 ? translate("editor.undoBoundary") : null;
}

export const TRANSLATE_SNAPSHOT_THROTTLE_MS = 10 * 60 * 1000;

export let lastTranslateSnapshot = { path: "", at: 0 };

export function buildSourcePairInput(
  ta: HTMLTextAreaElement,
  start: number,
  end: number,
): SourcePairInput {
  return {
    value: ta.value,
    start,
    end,
    cfg: readAutoPairConfig(),
    inDisabledContext: isInCodeBlock(ta.value, start) || isInInlineCodeOrMath(ta.value, start),
  };
}

export interface EditorContainerProps {
  content?: string;
  filePath?: string | null;
  forceUpdateKey?: number;
  onEditorReady?: (view: EditorView) => void;
  onContentChange?: (markdown: string) => void;
  /**
   * 强制源码面实现（**仅测试/探针用**）。
   *
   * 为什么需要：jsdom 下工厂 `isJsdomLike()` 恒为真 → 一律回退 textarea
   * → **CM6 装配路径在自动化测试里从未被执行过**。这正是"实机 CM6 被 React 抹掉"
   * 这个缺陷能逃过 6600+ 条测试的根本原因（契约测了、装配没测）。
   *
   * 传 "cm6" 后可断言：在真实 React 装配下 mount 后，经过多次 re-render，
   * `.cm-editor` 仍然存在（见 `v0170-cm6/assembly-host-contract`）。
   */
  forceSurfaceImpl?: "textarea" | "cm6";
}

export const PM_MARK_BY_ACTION: Record<string, string> = {
  bold: "strong",
  italic: "em",
  strikethrough: "strike",
  code: "code",
  highlight: "mark",
  underline: "underline",
};

export function applyHeadingLevelToView(
  view: { state: EditorState; dispatch: (tr: Transaction) => void },
  pos: number,
  level: number,
): boolean {
  const node = view.state.doc.nodeAt(pos);
  if (!node || node.type.name !== "heading") return false;
  if (Number(node.attrs.level) === level) return false;
  view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, level }));
  return true;
}

export function sourceLineToPos(text: string, lineIndex: number): number {
  const lines = text.split("\n");
  let pos = 0;
  for (let i = 0; i < Math.min(lineIndex, lines.length - 1); i++) {
    pos += lines[i].length + 1;
  }
  return pos;
}

export function docBlockLineToPos(doc: PMNode, lineIndex: number): number | null {
  let currentLine = 0;
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.isBlock && node.type.name !== "doc") {
      const nodeLines = (node.textContent || "").split("\n").length;
      if (currentLine === lineIndex) { found = pos + 1; return false; }
      if (currentLine + nodeLines > lineIndex) { found = pos + 1; return false; }
      currentLine += nodeLines;
    }
    return true;
  });
  return found;
}

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

export function EditorContainer({ content = "", filePath, forceUpdateKey, onEditorReady, onContentChange, forceSurfaceImpl }: EditorContainerProps) {
  const t = useT();
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // v0.12.0 需求4：主内容区 ref（Ctrl+滚轮缩放监听 + ZoomRuler 锚定）
  const mainAreaRef = useRef<HTMLDivElement>(null);
  // v0.12.0 返修（问题2）：textarea **内容锚点**（视口顶部字符偏移 + 视口 Y）。
  // 此前用"行索引锚点"，但软换行下视觉行序号在宽度变化后指向不同内容 → 编辑/分屏
  // 模式窗口缩放时焦点漂移（用户反馈"编辑和分屏模式下还不行"）。
  const textAnchorRef = useRef<TextContentAnchor | null>(null);
  /**
   * v0.12.0 返修（问题4/5）：视口锚点补偿的抑制截止时间戳。
   * 文件切换 / 模式切换 / 缩放恢复会主动设置滚动位置，此刻若 ResizeObserver 用
   * "切换前"的锚点做补偿就会抢跑（用户看到的就是"进度没联动/丢失"）。
   * 这些时点打时间标，窗口内的 RO 回调只重建锚点、不做补偿。
   */
  const anchorSuppressUntilRef = useRef(0);
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
  // v0.11.0 B4-10：阅读进度（状态栏显示）
  const setScrollProgress = useEditorStore((s) => s.setScrollProgress);
  // v0.8.3 需求3：光标列号 / 选中字符数
  const setCursorColumn = useEditorStore((s) => s.setCursorColumn);
  const setSelectedChars = useEditorStore((s) => s.setSelectedChars);
  const setWordCount = useEditorStore((s) => s.setWordCount);
  const focusMode = useEditorStore((s) => s.focusMode);
  const viewMode = useEditorStore((s) => s.viewMode);
  const setViewMode = useEditorStore((s) => s.setViewMode);
  // v0.14.0 需求1：编辑模式内的预览面板开关（双击 Shift / 分割线竖排文字同源）
  const splitPreviewOpen = useEditorStore((s) => s.splitPreviewOpen);
  const toggleSplitPreview = useEditorStore((s) => s.toggleSplitPreview);
  const setSourceInsertHandler = useEditorStore((s) => s.setSourceInsertHandler);
  const setUndoHandler = useEditorStore((s) => s.setUndoHandler);
  const setRedoHandler = useEditorStore((s) => s.setRedoHandler);
  const showSearch = useEditorStore((s) => s.showSearch);
  const setShowSearch = useEditorStore((s) => s.setShowSearch);
  const showSearchReplace = useEditorStore((s) => s.showSearchReplace);
  const setShowSearchReplace = useEditorStore((s) => s.setShowSearchReplace);
  const fontSize = useSettingsStore((s) => s.fontSize);
  // v0.11.0 B4-10：排版三项（0 = 跟随主题默认）
  const lineHeight = useSettingsStore((s) => s.lineHeight);
  const paragraphSpacing = useSettingsStore((s) => s.paragraphSpacing);
  const contentMaxWidth = useSettingsStore((s) => s.contentMaxWidth);
  const fontFamily = useSettingsStore((s) => s.fontFamily);
  // v0.12.1 需求9：设置弹窗拖滑条期间的**临时排版预览**（非持久化）。
  // 预览值为 undefined 时用已保存值——不拖动时行为与以前完全一致。
  const typographyPreview = useTypographyPreviewStore((s) => s.preview);
  const effFontSize = withPreview(fontSize, typographyPreview?.fontSize);
  const effFontFamily = withPreview(fontFamily, typographyPreview?.fontFamily);
  const effLineHeight = withPreview(lineHeight, typographyPreview?.lineHeight);
  const effParagraphSpacing = withPreview(paragraphSpacing, typographyPreview?.paragraphSpacing);
  const effContentMaxWidth = withPreview(contentMaxWidth, typographyPreview?.contentMaxWidth);
  // 供分屏 iframe 判断"这次是不是纯排版预览"（仅刷新样式表，不重排正文）
  const typographyPreviewKey = typographyPreview
    ? `${effFontSize}:${effFontFamily}:${effLineHeight}:${effParagraphSpacing}:${effContentMaxWidth}`
    : "";
  // v0.12.0 需求5：文档整体缩放（百分比；阅读/分屏右用 CSS zoom、编辑 textarea 用字号换算）
  const docZoom = useSettingsStore((s) => s.docZoom);
  const setDocZoom = useSettingsStore((s) => s.setDocZoom);
  const adjustDocZoom = useSettingsStore((s) => s.adjustDocZoom);
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

  /**
   * v0.13.0 返修（问题6）：文档中是否有图片（决定图片管理入口是否显示）。
   *
   * 用 PM 文档而非 content 字符串判断——字符串里可能是代码围栏内的示例
   * `![x](y)`，那并不是真实图片节点。
   */
  const [docHasImageFlag, setDocHasImageFlag] = useState(false);

  // v0.14.0 需求1：三模式合并为二模式后，源码编辑区在**所有非阅读模式**下都可见。
  // （旧写法 `viewMode === "edit" || viewMode === "split"` 已随 split 一起废弃。）
  const isSourceMode = viewMode !== "preview";

  /**
   * v0.14.0 需求1：是否显示右侧预览面板。
   *
   * `viewMode === "edit" && splitPreviewOpen` 等价于旧的三模式里的 `split`；
   * 关掉预览后即为旧的 `edit`（纯源码，左栏铺满）。
   * 非 Markdown 文件也显示代码预览（与旧 split 行为一致）。
   */
  const previewShown = viewMode === "edit" && splitPreviewOpen;
  /**
   * v0.15.0 需求 R6b：工作区搜索可用的根目录（订阅 openFolders）。
   *
   * 用选择器只取 path 数组并 `join` 成字符串再切分，避免 openFolders 每次引用变化
   * 都让 EditorContainer 重渲染（它内部会触发整棵编辑器树的重渲染）。
   */
  const workspaceRoots = useFileStore(
    (s) => s.openFolders.map((f) => f.path).join("\u0000"),
  ).split("\u0000").filter(Boolean);

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
  // v0.14.0 需求3：拖拽期间禁用两栏 width 过渡所需的 `body.split-resizing`
  // 由 `useResizable` 自己挂/摘（见其 handleMouseUp 的 teardown），这里**不再重复管理**——
  // 两处各 toggle 同一个类，会在"一边结束、另一边还以为在拖"时互相清掉标记。
  // 判断当前文件是否为 Markdown 文件
  // 非 Markdown 文件（txt/代码文件）不显示格式栏、不渲染 Markdown
  //
  // v0.8.0 修复 P11-2：临时（未落盘）文档的 filePath 为空串，isMarkdownFile("") 返回 false
  // → 会被当成"非 Markdown 文件"，preview 模式渲染只读的 plaintext-preview（空白文件更只剩
  // 空状态 Logo），用户看到"新建后没跳转、也不能编辑"。未命名文档按 Markdown 处理。
  const isMdFile = filePath ? isMarkdownFile(filePath) : true;

  /**
   * v0.13.0 返修（问题6）：「译」入口是否真的渲染。
   *
   * 必须与下方 JSX 的渲染条件**完全一致**——图片管理入口的槽位取决于它
   * （AI 翻译开启 → 图片管理在第 3 格；未开启 → 接在模式切换之后第 2 格）。
   */
  const translateSlotShown =
    (viewMode === "preview" || previewShown) && isMdFile && translateEnabled;
  // v0.8.0 修复 P11-2：是否有已打开的文档（用于区分"新建的空临时文档"与"确实没打开文件"）
  const openTabCount = useEditorStore((s) => s.openTabs.length);
  // v0.4.0：当前文件语言标识（由 App.tsx 在打开文件时设置），用于代码文件语法高亮
  const currentLanguage = useEditorStore((s) => s.currentLanguage);

  const setDirtyRef = useRef(setDirty);
  const setCursorLineRef = useRef(setCursorLine);
  const setCursorColumnRef = useRef(setCursorColumn);
  const setSelectedCharsRef = useRef(setSelectedChars);
  const setWordCountRef = useRef(setWordCount);
  setDirtyRef.current = setDirty;
  setCursorLineRef.current = setCursorLine;
  setCursorColumnRef.current = setCursorColumn;
  setSelectedCharsRef.current = setSelectedChars;
  setWordCountRef.current = setWordCount;

  const wordCountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastContentRef = useRef(content);
  const lastForceUpdateKeyRef = useRef(forceUpdateKey);
  const lastSyncDiskRef = useRef(content);

  // v0.6.1 问题3：翻译回写进行中标记（PM dispatch 同步触发 onDocChange，用此 ref 区分翻译修改与用户输入）
  const applyingTranslationRef = useRef(false);

  // 源码内容
  const [sourceContent, setSourceContent] = useState(content);
  /**
   * v0.17.0 A2/A3：源码面经 SourceSurface 访问（唯一选型入口 + 唯一实现出口）。
   *
   * - 工厂在 jsdom 下回退 textarea 实现 → 行为与拆分前**完全一致**
   *   （6600+ 条既有测试因此不受影响，这是刻意保住的绿基线）；
   * - 真实浏览器下启用 CM6 → 全部读写经 `surface.*`。
   *
   * ⚠️ A3 收尾起，`sourceTextareaRef` 这个"伪 ref"**已删除**。
   * 容器只保留一个宿主元素 ref（`sourceHostElRef`）用于挂载，
   * pane 一律经 `sourceSurface` 取值/落地。少量仍有几何/事件需求的调用点
   * 显式标注 `TODO(v0.18)`，指明属 CM6 能力缺口而非漏改。
   */
  const sourceSurfaceRef = useRef<SourceSurface | null>(null);
  if (!sourceSurfaceRef.current) {
    sourceSurfaceRef.current = createSourceSurface(
      forceSurfaceImpl ? { impl: forceSurfaceImpl } : {},
    );
  }
  const sourceSurface = sourceSurfaceRef.current;
  /** 源码面宿主元素（仅用于 mount/几何读取；不再对外当 textarea 能力用） */
  const sourceHostElRef = useRef<HTMLTextAreaElement | null>(null);
  /**
   * 兼容别名：少数 pane 仍按 `ref` 形状读宿主元素。
   *
   * ## 它是"过渡"而不是"正式契约"，理由与边界必须写清（避免后人误用）
   *
   * 剩余 60 处直读分三类：
   * - **30 处纯值**（选区/滚动/文本）→ 可换 `surface.*`，正在逐批替换；
   * - **13 处几何**（`clientHeight/scrollHeight/getBoundingClientRect`）→
   *   CM6 下需新的几何能力（部分已在 A3 提供：`getMetrics` / `measureBlockTops` /
   *   `measureRangeContentY` / `offsetToContentY`），尚未全部接完；
   * - **2 处 DOM 事件绑定** → 属 CM6 `domEventHandlers`，A3 后能力。
   *
   * ⚠️ **CM6 路径下本别名为 `null`**。所有使用点必须按"可能为 null"处理，
   * 且**不允许**因为 null 就静默跳过本该发生的副作用 ——
   * 那是"功能消失但测试仍绿"的最坏形态（专注遮罩已踩过一次，见 e694d0b）。
   *
   * @deprecated A3 收尾过渡。目标：`grep sourceTextareaRef` 归零，
   * 或每处残留都带 `TODO(v0.18)` 且能说明"这是已知 CM6 能力缺口"。
   */
  const sourceTextareaRef = sourceHostElRef;
  /**
   * 把 React 渲染出来的宿主元素交给 `SourceSurface`（唯一挂载入口）。
   *
   * - textarea 实现：`mount()` 直接接管该元素；
   * - CM6 实现：该元素作为 CM6 的 host。
   * 卸载时 `destroy()`：CM6 必须显式销毁才释放 DOM 监听，否则多次挂载会泄漏。
   */
  /**
   * 源码面内容的**最新值快照**（供 callback ref 在挂载瞬间读取）。
   *
   * ⚠️ 必须声明在 `sourceHostRef` **之前**：callback ref 在 React 首次挂载时同步执行，
   * 那一刻它要读 `sourceContentRef.current` 作为 CM6 的初始文档。若声明在后面，
   * 挂载时读到的是 `undefined` → CM6 以空文档建 view → **源码面空白**
   * （实机探针 `v0170-probe-cm6` 实测：`.cm-line` 只有一行且内容为空）。
   * 这是 v0.17.0 装配阶段的一个真实缺陷，不是假想风险。
   */
  const sourceContentRef = useRef(content);
  sourceContentRef.current = sourceContent;
  const sourceHostRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      sourceHostElRef.current = el;
      if (el) {
        /**
         * 挂载瞬间的初始文本：
         * - textarea 实现：`mount()` 会在 `DOM 值 !== initialText` 时写回，传空串安全
         *   （受控渲染已把 value 放好，条件不成立则完全不碰 DOM —— 见 A2 那次修复）；
         * - CM6 实现：**这是它唯一能拿到初始文档的时机**，必须传真实内容。
         *
         * 用 `?? content` 兜底：若挂载发生在首帧、`sourceContentRef` 尚未被赋值的前一轮
         * （React 严格模式下可能出现），退回 `content` prop（同一份数据的权威来源）。
         */
        sourceSurface.mount(el, { initialText: sourceContentRef.current ?? content });
      } else sourceSurface.destroy();
    },
    [sourceSurface, content],
  );
  const lastTextareaCursorRef = useRef(0);
  /**
   * v0.15.1 需求1：源码面**最近一次的滚动位置**（编辑前现场）。
   *
   * 为什么需要单独记：`onChange` 触发时 DOM 的 scrollTop 已经是"编辑之后"的值
   * （浏览器可能因内容变高/变矮或光标滚入视口而调整它），拿它当 beforeSelection
   * 会让撤销后的滚动位置对不上。由 scroll 监听持续维护，onChange 里读它才是旧值。
   */
  const lastSourceScrollTopRef = useRef(0);
  /**
   * v0.15.1 需求1：待应用的源码选区（撤销/恢复落地后恢复光标用）。
   *
   * 为什么必须经 `useLayoutEffect([sourceContent])`：`setSourceContent` 是受控组件，
   * React 提交新 value 时会把 textarea 的 selection 重置掉，而那次提交可能晚于
   * 我们在 rAF 里设的光标 → 直接设会被覆盖（实测 12 → 0）。
   * layout effect 在 DOM 提交之后、浏览器绘制之前执行，是唯一"设了就不会被覆盖"的时机。
   *
   * 为什么要带 `until` 时间戳（而不是应用一次就清）：撤销会连带触发
   * `onContentChange → App.setContent → content prop 变化 → 再 setSourceContent`，
   * 也就是**第二次**受控提交，它同样会把选区重置成 0。实测时序是
   * `set 12 → React 提交(重置 0) → 60ms 兜底(12)`，中间有一帧光标在文首。
   * 因此把它保持 ~200ms 的"选区保护窗"，窗口内每次 sourceContent 提交都重新应用；
   * 窗口结束或用户主动输入（onChange / 点击）即失效，不会干扰正常编辑。
   */
  const pendingSourceSelectionRef = useRef<{
    start: number;
    end: number;
    scrollTop: number | null;
    until: number;
  } | null>(null);
  /**
   * v0.15.1 需求6（撤销再审计抓出的缺陷）：撤销选区还原的**代际 token**。
   *
   * 缺陷（实测）：撤销后 60ms 内开始打字，字符本身插对了，但 250ms 后光标会被
   * **撤销的兜底定时器**抢回撤销时的位置 → 下一个字符插到错误位置。
   * 根因：`applyHistoryText` 里除了 pending ref 还排了
   * `requestAnimationFrame(applySelection)` 与 `setTimeout(applySelection, 60)`
   * 两个**定时器**，而 `handleSourceChange` 只清了 pending ref，管不到它们。
   *
   * 修法：用户一旦真实输入就 `++token`；定时器回调里比对代际号，过期即自觉退场。
   */
  const sourceSelectionRestoreTokenRef = useRef(0);

  // 自动保存：需要在 sourceContentRef 声明之后调用
  // v0.6.6 问题4：getter ref 拦截读取——自动保存/版本快照拿到 unmask 后的真实内容
  // （textarea 显示层为短标记，写盘必须还原完整 base64）
  const autoSaveSourceRef = {
    get current() {
      return unmaskBase64Images(sourceContentRef.current, base64TokensRef.current);
    },
  } as React.MutableRefObject<string>;
  useAutoSave(viewRef, autoSaveSourceRef);

  // ─── v0.17.0 P0-1：由 pane 提升到容器的作用域（跨 pane 共享，逐字节原样）───

  // 待恢复的 iframe 滚动百分比：分屏模式下 iframe 内容异步加载，
  // applyScroll 执行时 iframe 可能还未写入内容或 scrollHeight 不准确，
  // 需在 iframe 写入完成后再设置 scrollTop
  const pendingIframeScrollRef = useRef<number | null>(null);
  // ─── v0.6.6 问题2：阅读模式 Slash 触发状态（由 ProseMirror 插件回调更新）───
  const [pmSlash, setPmSlash] = useState<SlashState | null>(null);
  // v0.13.0 需求10：阅读模式 Emoji 短码补全触发状态
  const [pmEmoji, setPmEmoji] = useState<EmojiState | null>(null);
  // ─── v0.12.1 需求1：标题级别下拉菜单状态（点击标题左侧 H1/H2 徽标打开）───
  const [headingMenu, setHeadingMenu] = useState<{
    open: boolean;
    anchor: DOMRect | null;
    /** 当前级别（菜单内高亮） */
    level: number;
    /** 标题节点起始位置（改级别用） */
    pos: number;
  }>({ open: false, anchor: null, level: 1, pos: 0 });
  // startTranslate/handleTranslateApply 的最新引用转发（createEditor 只初始化一次 + 命令监听挂载一次）
  // v0.6.2 问题3：startTranslate 支持 fallbackToFull 参数（「译」按钮无选区时回退全文翻译）
  const startTranslateRef = useRef<(fallbackToFull?: boolean) => void>(() => {});
  const triggerMenuPosRef = useRef<(x: number, y: number) => void>(() => {});
  const aiMenuPosRef = useRef<(x: number, y: number, task: AiAssistTask | null) => void>(() => {});
  const progressKeyRef = useRef<string | null>(null);
  /**
   * v0.13.2 需求5：**同步**读取当前活动文档键。
   *
   * 为什么不用 `activeProgressKey` 这个 React 派生值：换文档 effect 在 React
   * 提交阶段执行，此时 store 里的 activeTabIdx 已更新，但 `activeProgressKey`
   * 是**上一次渲染**的闭包值（切标签是 setActiveTab + setContent 两次 setState，
   * 同一次提交里 effect 读到的仍是旧闭包）。直接从 store 取才是权威值。
   */
  const currentDocKeyFromStore = useCallback((): string | null => {
    const st = useEditorStore.getState();
    const tab = st.openTabs[st.activeTabIdx];
    if (!tab) return null;
    return tab.isUntitled
      ? `${UNTITLED_PROGRESS_PREFIX}${tab.id ?? st.activeTabIdx}`
      : tab.path || null;
  }, []);
  /** source 续写 ghost 活跃标记 */
  const sourceGhostActiveRef = useRef(false);
  /** source ghost 采纳/放弃/失效回调引用（handleSourceKeyDown 仅挂载一次，经 ref 转发最新实现） */
  const sourceGhostHandlersRef = useRef<{
    accept: () => boolean;
    cancel: () => boolean;
    invalidate: () => void;
  }>({ accept: () => false, cancel: () => false, invalidate: () => {} });

  // ─── v0.12.0 需求1：格式 ghost（占位提示，不写入文档） ───
  // 无选区点击格式按钮（粗体/斜体/H1~H6 等）时，文档只插入语法符号（如 `****`），
  // 占位提示（如"粗体文本"）由 overlay 以灰色幽灵文本渲染；用户直接键入即替换之，
  // 不键入则永不落盘（修复"占位文字残留进文件"）。
  // 与 AI ghost 共用 overlay：AI ghost 优先（异步任务不被打断视觉），
  // 格式操作触发时经 sourceGhostHandlersRef.invalidate() 让 AI ghost 让位。
  //
  // v0.12.0 返修：
  // - content：插入语法符号后的全文快照。渲染 overlay 时使用快照而非 textarea.value，
  //   消除"setState 未提交 → rAF 读到旧文本 → ghost 位置漂移（浮动）"的时序问题；
  // - start/end：本次插入的语法符号区间，供退格键整段删除格式符（用户返修需求④）。
  const formatGhostRef = useRef<{
    text: string;
    pos: number;
    start: number;
    end: number;
    content: string;
    /** v0.12.0 返修：光标之后的尾部语法符号（渲染为可见普通色，让占位落在格式符中间） */
    tail?: string;
    /** v0.12.0 返修：是否用底色遮住 textarea 中被占位压住的尾部符号 */
    maskTail?: boolean;
  } | null>(null);

  // 每次渲染转发最新实现（handleFormatAction 为挂载时创建一次的 ref 函数，避免闭包过期）
  const formatGhostHandlersRef = useRef<{
    render: () => void;
    clear: (kind: string) => void;
    remove: () => boolean;
  }>({ render: () => {}, clear: () => {}, remove: () => false });
  // latest-ref 转发（lightmd:command 监听只挂载一次）
  const startAiAssistRef = useRef<(task: AiTask) => void>(() => {});
  const startAiChatRef = useRef<() => void>(() => {});

  // ─── v0.6.1：全文翻译 ────────────────────
  const startFullTranslateRef = useRef<() => void>(() => {});

  // ─── 分屏预览防抖渲染 ──────────────────────────────
  // 首次进入分屏模式立即渲染，编辑时延迟 300ms 防抖，减少连续击键时的渲染开销
  const [debouncedSourceContent, setDebouncedSourceContent] = useState(sourceContent);
  // iframe 引用，用于分屏预览（隔离 DOM，减少主文档节点数）
  const previewIframeRef = useRef<HTMLIFrameElement>(null);

  /**
   * v0.14.0 需求2：按百分比恢复滚动位置，**容器尚不可滚动时短间隔重试**。
   *
   * 为什么必须有重试（P1 的根因）：阅读→编辑切换时 applyScroll 的双 rAF 在 ~44ms
   * 执行，此时左栏 textarea 的 `scrollHeight - clientHeight === 0`（内容还没写入 /
   * 还没布局），`computeRestoreScrollTop` 返回 null；旧代码 `scrollTop = newTop ?? 0`
   * 当场写成 0 且**不再重试** → 左栏停在顶部，splitScrollSync 又把 0 推给右屏
   * iframe → 两屏都掉到 0（实测 iframe=0.006）。
   * 60ms 后内容就绪（实测 +120ms 时 scrollHeight 已 17416），故用 60ms 间隔、
   * 最多 24 次（≈1.5s，覆盖 mermaid/katex 异步渲染继续撑高的场景）。
   *
   * ⚠️ 关键语义：**永远不在"容器不可滚动"时写 0**（那正是旧 bug）。
   * 只在 `plan.append` 为真时写入；期望位置本来就是顶部时直接放弃（不写也是顶部）。
   *
   * @param target 滚动容器（textarea / iframe 文档滚动元素 / .editor-container）
   * @param percent 目标百分比 0~1
   * @param attempt 当前重试次数（首次传 0）
   * @param shouldContinue 每次重试前的守卫（如"已经不在恢复窗口了就别再改用户滚动位置"）
   * @returns 是否已成功写入
   */
  /**
   * v0.15.0 需求（阅读↔编辑内容对齐）：把内容锚点换算成 textarea 的 scrollTop。
   *
   * 源码面没有子元素可量，块几何只能由 `measureSourceLineAxis` 的**实测按行轴**
   * 还原（线性估算在软换行长行上会偏 4 倍）。这里每次现量（测量函数内部带
   * scrollHeight 缓存键，重复调用不贵），量不到就返回 null 交给百分比兜底。
   */
  const textareaTopFromContentAnchor = (
    textarea: HTMLTextAreaElement,
    anchor: ContentAnchor | null | undefined,
  ): number | null => {
    if (!anchor) return null;
    if (!(textarea.clientHeight > 0) || !(textarea.scrollHeight > 0)) return null;
    const markdown = unmaskBase64Images(sourceContentRef.current, base64TokensRef.current);
    if (!markdown) return null;
    try {
      const measured = measureSourceLineAxis({
        textarea,
        blockLines: topLevelBlockStartLines(markdown),
      });
      if (!measured) return null;
      const blocks = blockGeometryFromLineAxis({
        totalLines: measured.totalLines,
        lineAxis: measured.axis,
        blockLines: topLevelBlockStartLines(markdown),
        contentHeight: textarea.scrollHeight,
        maxScroll: Math.max(0, textarea.scrollHeight - textarea.clientHeight),
      });
      if (!blocks) return null;
      return restoreTextareaContentAnchor(blocks, anchor, {
        scrollHeight: textarea.scrollHeight,
        clientHeight: textarea.clientHeight,
      });
    } catch {
      return null;
    }
  };

  const restoreScrollWithRetry = (
    target: ScrollRestoreTarget | null,
    percent: number,
    attempt = 0,
    shouldContinue: () => boolean = () => true,
  ): boolean => {
    if (!target) return false;
    const plan = planScrollRestore(percent, target.scrollHeight, target.clientHeight, attempt);
    if (plan.apply) {
      target.scrollTop = plan.top;
      return true;
    }
    if (!plan.retry) return false;
    window.setTimeout(() => {
      // 重试前重新取容器：重试窗口内可能发生重渲染（textarea 被重建 → 旧引用失效）
      if (!shouldContinue()) return;
      const next = target;
      restoreScrollWithRetry(next, percent, attempt + 1, shouldContinue);
    }, SCROLL_RESTORE_RETRY_MS);
    return false;
  };

  /**
   * v0.14.0 需求2：消费 `pendingIframeScrollRef`（右侧预览的待恢复百分比）。
   *
   * 为什么不能只靠「iframe 内容写入 effect」消费：那个 effect 的依赖是 `previewHtml`，
   * 而阅读→编辑切换时 previewHtml 往往**根本没变**（右屏内容早就渲染好了，只是外壳
   * 宽度从 0 变正）→ effect 不重跑 → pending 永远没人消费 → 右屏停在顶部。
   * 故这里独立做一次"重试直到 iframe 可滚动"，与内容写入 effect 末尾的消费互为双保险
   * （先成功者把 pending 清成 null，后者看到 null 直接返回）。
   */
  const restorePendingIframeScroll = (): void => {
    const target = (): ScrollRestoreTarget | null => {
      const iframe = previewIframeRef.current;
      const doc = iframe?.contentDocument;
      const s = (doc?.scrollingElement ?? doc?.documentElement ?? doc?.body) as
        | (ScrollRestoreTarget & Element)
        | null;
      return s ?? null;
    };
    const start = (attempt: number) => {
      const pending = pendingIframeScrollRef.current;
      if (pending === null) return; // 已被别的路径消费 / 已被新的切换覆盖
      const ok = restoreScrollWithRetry(
        target(),
        pending,
        attempt,
        // 守卫：pending 被清空/改写说明这次恢复已不需要（用户切走了或已成功）
        () => pendingIframeScrollRef.current === pending,
      );
      if (ok) pendingIframeScrollRef.current = null;
    };
    start(0);
  };

  // ─── v0.17.0 P0-1：七个 pane hook（调用顺序 = 原文件语句出现顺序；body 逐字节原样）───
  const historyHost = useHistoryHost({
    sourceSurface,
    viewMode,
    isMdFile,
    viewRef,
    sourceContentRef,
    base64TokensRef,
    filePath,
    forceUpdateKey,
    editorRef,
    sourceTextareaRef,
    sourceContent,
    pendingSourceSelectionRef,
    lastTextareaCursorRef,
    content,
    isSourceMode,
    setSourceContent,
    setDebouncedSourceContent,
    onContentChangeRef,
    setDirtyRef,
    lastContentRef,
    formatGhostHandlersRef,
    setUndoHandler,
    setRedoHandler,
  });
  const {
    undoStackRef,
    redoStackRef,
    historyDocKeyOrEmpty,
    historyCoordinatorRef,
    lastRealTextRef,
    docKeyRef,
    lastHistoryContentRef,
    pmScrollPercentRef,
    textareaScrollPercentRef,
    isSyncingScrollRef,
    pendingScrollRef,
    prevViewModeRef,
    isRestoringScrollRef,
    historyScrollGuardUntilRef,
    HISTORY_SCROLL_GUARD_MS,
    inHistoryScrollGuard,
    scrollRestoreGenRef,
    modeAnim,
    setModeAnim,
    modeAnimGenRef,
    modeSwitchAnchorRef,
    cachePmGeometry,
    cacheSourceGeometry,
    pushUndoEntry,
    recordDiscreteSourceEdit,
    writeBackCurrentDoc,
    sourceAdapterRef,
    pmAdapterRef,
    applyHistoryTextRef,
    sourceComposingRef,
    sourceJustPairedRef,
    sourceJustPastedRef,
    canUndoUnified,
    canRedoUnified,
    handleUndo,
    handleRedo,
  } = historyHost;
  const modeSync = useModeSync({
    sourceSurface,
    isSourceMode,
    setSourceInsertHandler,
    pushUndoEntry,
    sourceTextareaRef,
    sourceContentRef,
    recordDiscreteSourceEdit,
    setSourceContent,
    onContentChangeRef,
    setDirtyRef,
    lastContentRef,
    base64TokensRef,
    formatGhostRef,
    sourceGhostHandlersRef,
    formatGhostHandlersRef,
    lastTextareaCursorRef,
    typewriterMode,
    editorRef,
    filePath,
    docKeyRef,
    currentDocKeyFromStore,
    lastHistoryContentRef,
    content,
    applyingTranslationRef,
    setCursorLineRef,
    setCursorColumnRef,
    setSelectedCharsRef,
    wordCountTimerRef,
    setWordCountRef,
    isRestoringScrollRef,
    viewRef,
    pmAdapterRef,
    sourceAdapterRef,
    lastRealTextRef,
    onEditorReadyRef,
    startTranslateRef,
    triggerMenuPosRef,
    startAiChatRef,
    startAiAssistRef,
    aiMenuPosRef,
    setPmSlash,
    setPmEmoji,
    setHeadingMenu,
    forceUpdateKey,
    pmScrollPercentRef,
    cachePmGeometry,
    progressKeyRef,
    viewMode,
    setDocHasImageFlag,
    cacheSourceGeometry,
    lastSourceScrollTopRef,
    textareaScrollPercentRef,
    isMdFile,
    lastForceUpdateKeyRef,
    lastSyncDiskRef,
    undoStackRef,
    redoStackRef,
    previewShown,
    pendingIframeScrollRef,
    prevViewModeRef,
    modeAnimGenRef,
    setModeAnim,
    pendingScrollRef,
    modeSwitchAnchorRef,
    sourceContent,
    textareaTopFromContentAnchor,
    restoreScrollWithRetry,
    restorePendingIframeScroll,
    scrollRestoreGenRef,
  });
  const {
    typewriterModeRef,
    scrollToCenterRef,
    activeIsReadonly,
  } = modeSync;
  const sourcePane = useSourcePane({
    sourceSurface,
    pendingSourceSelectionRef,
    sourceSelectionRestoreTokenRef,
    sourceGhostHandlersRef,
    formatGhostHandlersRef,
    base64TokensRef,
    sourceContentRef,
    sourceAdapterRef,
    sourceComposingRef,
    sourceJustPairedRef,
    sourceJustPastedRef,
    lastSourceScrollTopRef,
    historyCoordinatorRef,
    historyDocKeyOrEmpty,
    lastRealTextRef,
    setSourceContent,
    onContentChangeRef,
    setDirtyRef,
    lastContentRef,
    lastTextareaCursorRef,
    wordCountTimerRef,
    setWordCountRef,
    editorRef,
    applyHistoryTextRef,
    viewMode,
    isMdFile,
    viewRef,
    historyScrollGuardUntilRef,
    HISTORY_SCROLL_GUARD_MS,
    sourceTextareaRef,
    pushUndoEntry,
    recordDiscreteSourceEdit,
    filePath,
    formatGhostRef,
    isSourceMode,
    autoPairEnabled,
    sourceGhostActiveRef,
  });
  const {
    handleSourceChange,
    insertTextAtCursor,
    insertMarkdownIntoPM,
    handleSlashInsert,
    linkDialogOpen,
    setLinkDialogOpen,
    linkInitialText,
    setLinkInitialText,
    tableDialogOpen,
    setTableDialogOpen,
    imageDialogOpen,
    setImageDialogOpen,
    imageEditDialogOpen,
    setImageEditDialogOpen,
    imageEditSrc,
    setImageEditSrc,
    imageEditAlt,
    setImageEditAlt,
    imageEditWidth,
    setImageEditWidth,
    imageEditAlign,
    setImageEditAlign,
    setImageEditPos,
    contextMenu,
    setContextMenu,
    pmContextMenu,
    setPmContextMenu,
    blockKebabMenu,
    setBlockKebabMenu,
    formatPainterMode,
    mermaidMenuOpen,
    setMermaidMenuOpen,
    taskStyleMenuOpen,
    setTaskStyleMenuOpen,
    slashCommandOpen,
    setSlashCommandOpen,
    openLinkDialog,
    handleImageEditConfirm,
    handleFormatAction,
    handleSourcePaste,
    handleSourceKeyDown,
    applySourceInput,
  } = sourcePane;

  /**
   * ## v0.17.0 A3 装配修复②：CM6 路径的内容同步链路
   *
   * 缺陷：`handleSourceChange` 只接受 React 事件，而 **CM6 的编辑不产生 React onChange**
   * → CM6 里打字，`sourceContent` 永远不更新（表现为"打进去的字存不下来/不预览"）。
   *
   * 修法：订阅 `sourceSurface.onDidChange`，把它转成 `applySourceInput` 的语义入参。
   * 两条路径**共用同一份核心逻辑**（`applySourceInput`），所以撤销归并/IME 分组/
   * base64 mask/字数统计等全部一致，不存在两套写入路径。
   *
   * 为什么要注意"回声"：程序化写入（`setText`）在 CM6 里**不会**触发 onDidChange
   *（我们的 CmSourceSurface 只在真实用户编辑时报告），因此不会与 setText 形成循环。
   */
  /**
   * ## v0.17.0 A3 装配修复③：CM6 路径的**受控写入**
   *
   * textarea 路径靠 JSX 的 `value={sourceContent}` 由 React 同步；CM6 渲染的是中性 div，
   * 没有 `value` 可言 → 必须在这里把 `sourceContent` 的**外部变化**推进 CM6
   * （模式切换、撤销/恢复落地、AI 回写、搜索替换、切文件等全部走这条）。
   *
   * 关键设计：
   * - **比较后再写**：`getText() === sourceContent` 时什么都不做 ——
   *   否则每次用户输入触发的 state 更新都会把整篇重写一遍（丢光标、性能崩）。
   * - **只在 impl === "cm6" 时执行**：textarea 路径的 `value=` 已经做了，重复写会打架。
   * - 不传 selection：外部写入不该抢用户光标（textarea 的 `value=` 同样不保留光标位置，
   *   两者行为一致）。
   */
  useEffect(() => {
    if (sourceSurface.impl !== "cm6") return;
    /**
     * ⚠️ **必须先判"已挂载"**（实机缺陷：打开文件后源码面变空白）。
     *
     * React 的 effect 在 callback ref 之前可能先跑一帧，此时 `getText()` 返回空串、
     * `sourceContent` 已有真实内容 → 比较不等 → `setText(真实内容)` 本应正确，
     * 但反过来当 `sourceContent` 还是空串（内容尚未从 App 传入）时，
     * 会把 **空内容写进 CM6**，随后真实内容到来又被判为"已相等"而跳过。
     * 加 `isMounted()` 后，挂载完成的那一刻（`mount` 已注入 `initialText`）才会进入比较，
     * 语义与 textarea 的"首次 `value=` 渲染"一致。
     */
    if (!sourceSurface.isMounted()) return;
    if (sourceSurface.getText() === sourceContent) return;
    sourceSurface.setText(sourceContent);
  }, [sourceContent, sourceSurface]);


  useEffect(() => {
    /**
     * ⚠️ **只对 CM6 生效** —— 这是本 effect 最关键的约束。
     *
     * textarea 实现的 `report()` 也绑在同一个原生 `input` 事件上，而 React 的
     * `onChange`（`handleSourceChange`）**同样由该事件触发**。
     * 若两条都跑，同一次按键会被处理两遍：时间线记两条、光标补偿两次、
     * 边界提示逻辑被打乱 —— 实测表现为"撤到底不提示边界"（3 条 undo 套件红）。
     *
     * 因此：textarea 路径**只走 React onChange**（原行为，零变化）；
     * CM6 路径**只走 onDidChange**（CM6 不产生 React onChange）。
     * 分工严格互斥，不存在双写。
     */
    if (sourceSurface.impl !== "cm6") return;
    const off = sourceSurface.onDidChange((ev) => {
      // 组合输入期间不落时间线（与 textarea 路径的 nativeComposing 口径一致）：
      // 由 surface 的 compositionGroupId 表达"这是同一次组合"，核心逻辑里照常归并。
      applySourceInput.current(ev.text, ev.selection.start, {
        composing: ev.kind === "ime" || !!ev.compositionGroupId,
      });
    });
    return off;
  }, [sourceSurface, applySourceInput]);
  const aiAssistPane = useAiAssistPane({
    sourceSurface,
    isSourceMode,
    isMdFile,
    sourceTextareaRef,
    triggerMenuPosRef,
    aiMenuPosRef,
    viewRef,
    filePath,
    progressKeyRef,
    forceUpdateKey,
    viewMode,
    startFullTranslateRef,
    sourceContentRef,
    previewShown,
    previewIframeRef,
    startTranslateRef,
    applyingTranslationRef,
    recordDiscreteSourceEdit,
    setSourceContent,
    onContentChangeRef,
    setDirtyRef,
    lastContentRef,
    base64TokensRef,
    sourceGhostActiveRef,
    formatGhostRef,
    formatGhostHandlersRef,
  });
  const {
    triggerMenuPos,
    setTriggerMenuPos,
    aiMenuPos,
    setAiMenuPos,
    hideTranslateTrigger,
    activeFileRef,
    activeKeyRef,
    currentDocKey,
    handleTranslateApply,
    handleTranslateCopy,
    handleTranslateRetry,
    aiCtxRef,
    aiSeqRef,
    ghostActiveRef,
    sourceGhostOverlayRef,
    sourceGhostPlaceholderRef,
    sourceGhostTextRef,
    sourceGhostPosRef,
    runAiBubble,
    runAiGhost,
    renderSourceGhost,
    clearSourceGhost,
  } = aiAssistPane;
  const searchHost = useSearchHost({
    currentDocKey,
    isSourceMode,
    sourceContentRef,
    writeBackCurrentDoc,
  });
  const {
    collectSearchFiles,
    applyFileText,
  } = searchHost;
  const aiChatPane = useAiChatPane({
    sourceSurface,
    renderSourceGhost,
    sourceTextareaRef,
    formatGhostRef,
    sourceGhostActiveRef,
    sourceGhostPosRef,
    sourceGhostPlaceholderRef,
    sourceGhostTextRef,
    aiSeqRef,
    activeFileRef,
    clearSourceGhost,
    recordDiscreteSourceEdit,
    setSourceContent,
    onContentChangeRef,
    setDirtyRef,
    lastContentRef,
    base64TokensRef,
    sourceGhostHandlersRef,
    aiCtxRef,
    viewRef,
    applyingTranslationRef,
    activeKeyRef,
    sourceContentRef,
    content,
    viewMode,
    isMdFile,
    isSourceMode,
    runAiBubble,
    runAiGhost,
    startAiAssistRef,
    forceUpdateKey,
    startAiChatRef,
    editorRef,
    ghostActiveRef,
    sourceGhostOverlayRef,
    lastSyncDiskRef,
    filePath,
    startFullTranslateRef,
    startTranslateRef,
    handleFormatAction,
  });
  const {
    handleAiApply,
    handleAiRetry,
    getChatContextValues,
    undoTranslation,
    sendAiChat,
    stopAiChat,
    regenerateAiChat,
    chatInsertAtCursor,
    chatReplaceSelection,
    chatReplaceDocument,
    chatCopy,
    chatScopeChange,
    segmentFailTip,
    fullTranslateRunning,
  } = aiChatPane;
  const formatMenuHost = useFormatMenuHost({
    sourceSurface,
    isSourceMode,
    isMdFile,
    sourceTextareaRef,
    setContextMenu,
    handleUndo,
    handleRedo,
    openLinkDialog,
    insertTextAtCursor,
    startTranslateRef,
    handleFormatAction,
    setImageDialogOpen,
    setTableDialogOpen,
    setMermaidMenuOpen,
    viewMode,
    viewRef,
    sourceContentRef,
    recordDiscreteSourceEdit,
    setSourceContent,
    onContentChangeRef,
    setDirtyRef,
    lastContentRef,
    base64TokensRef,
    editorRef,
    formatPainterMode,
    filePath,
    setPmContextMenu,
    setBlockKebabMenu,
    blockKebabMenu,
    t,
    insertMarkdownIntoPM,
    startAiAssistRef,
    mermaidMenuOpen,
    setTaskStyleMenuOpen,
    taskStyleMenuOpen,
    setSlashCommandOpen,
    setPmSlash,
    focusMode,
    forceUpdateKey,
    theme,
    focusOverlayRef,
    lineHeight,
    sourceContent,
  });
  const {
    handleTextareaContextMenu,

    handleContextMenuAction,
    armFormatPainterRef,
    applyHeadingLevel,
    handleBlockKebabAction,
    handlePmMenuAction,
    handleMermaidTemplateSelect,
    handleTaskStyleSelect,
    handleSlashClose,
  } = formatMenuHost;

  /**
   * ## v0.17.0 A3 装配修复④：CM6 路径的宿主级事件
   *
   * textarea 路径靠 JSX 的 `onKeyDown` / `onPaste` / `onContextMenu` 绑事件；
   * CM6 编辑区是内部 contenteditable（`.cm-content`），**React 事件绑不到它**
   * → CM6 下 Tab 缩进、粘贴、右键菜单、配对补全全部失效。
   *
   * 这里把同一批处理函数交给 surface（CM6 会经 `EditorView.domEventHandlers` 注册）。
   * **复用同一份 handler**，不分叉成两套逻辑。
   */
  useEffect(() => {
    if (sourceSurface.impl !== "cm6") return;
    sourceSurface.setDomEventHandlers({
      // React 事件类型与 surface 的最小契约形状兼容（都提供 key/shiftKey/…/preventDefault）
      onKeyDown: (e) => handleSourceKeyDown(e as unknown as React.KeyboardEvent<HTMLTextAreaElement>),
      onPaste: (e) => handleSourcePaste(e as unknown as React.ClipboardEvent<HTMLTextAreaElement>),
      onContextMenu: (e) =>
        handleTextareaContextMenu(e as unknown as React.MouseEvent<HTMLTextAreaElement>),
    });
  }, [sourceSurface, handleSourceKeyDown, handleSourcePaste, handleTextareaContextMenu]);
  const previewPane = usePreviewPane({
    sourceSurface,
    viewMode,
    isMdFile,
    isSourceMode,
    previewShown,
    editorRef,
    sourceTextareaRef,
    previewIframeRef,
    effFontSize,
    effFontFamily,
    effLineHeight,
    effParagraphSpacing,
    effContentMaxWidth,
    docZoom,
    adjustDocZoom,
    mainAreaRef,
    filePath,
    forceUpdateKey,
    anchorSuppressUntilRef,
    textAnchorRef,
    formatGhostHandlersRef,
    setScrollProgress,
    spellcheckEnabled,
    theme,
    typewriterMode,
    viewRef,
    scrollToCenterRef,
    isRestoringScrollRef,
    inHistoryScrollGuard,
    typewriterModeRef,
    t,
    sourceContent,
    setDebouncedSourceContent,
    debouncedSourceContent,
    currentLanguage,
    base64TokensRef,
    typographyPreviewKey,
    pendingIframeScrollRef,
    isSyncingScrollRef,
    handleUndo,
    handleRedo,
    openLinkDialog,
    setImageDialogOpen,
    setTableDialogOpen,
    setMermaidMenuOpen,
    armFormatPainterRef,
    handleFormatAction,
  });
  const {
    codePreviewHtml,
    onFormatBtnClick,
  } = previewPane;


  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>
      {/* 空状态（v0.8.0 修复 P11-2：仅在"没有打开任何文档"时显示。
          新建的临时文档 content 为空，此前会被全屏 Logo 遮罩挡住，用户看不到光标、
          误以为"没跳转 / 不能编辑"） */}
      {!content && viewMode === "preview" && openTabCount === 0 && (
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
            // v0.12.1 需求5：任务列表按钮 → 下拉选择两种图标样式（方形 / 圆形）
            if (btn.action === "task") {
              return (
                <div key={btn.action} className="task-style-dropdown-wrap">
                  <button
                    className="format-btn"
                    title={formatButtonTitle(btn)}
                    onClick={() => setTaskStyleMenuOpen((v) => !v)}
                    aria-expanded={taskStyleMenuOpen}
                    aria-haspopup="menu"
                  >
                    {btn.label}
                  </button>
                  {taskStyleMenuOpen && (
                    <div className="mermaid-dropdown-menu" role="menu" data-testid="task-style-dropdown">
                      <button
                        className="mermaid-dropdown-item task-style-option"
                        role="menuitem"
                        data-style="square"
                        onClick={() => handleTaskStyleSelect("square")}
                      >
                        <span className="task-style-preview" />
                        {t("task.style.squareTitle")}
                      </button>
                      <button
                        className="mermaid-dropdown-item task-style-option"
                        role="menuitem"
                        data-style="circle"
                        onClick={() => handleTaskStyleSelect("circle")}
                      >
                        <span className="task-style-preview circle" />
                        {t("task.style.circleTitle")}
                      </button>
                    </div>
                  )}
                </div>
              );
            }
            // Mermaid 按钮：渲染为带下拉菜单的容器
            if (btn.hasDropdown) {
              return (
                <div key={btn.action} className="mermaid-dropdown-wrap">
                  <button
                    className="format-btn"
                    title={formatButtonTitle(btn)}
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
                className={`format-btn ${btn.isUndoRedo ? "format-btn-undo-redo" : ""} ${
                  btn.action === "formatPainter" && formatPainterMode !== "idle" ? "active" : ""
                }`}
                title={formatButtonTitle(btn)}
                onClick={(e) => onFormatBtnClick(btn.action, e.detail)}
              >
                {/* v0.12.0 需求2 返修：刷子形状 SVG 图标（替代 emoji，与工具栏风格统一）
                    v0.12.1 需求7：按用户要求**重绘为一把小油漆刷**——旧图形是斜置的
                    抽象笔刷，缩小到 14px 后辨识度差；现改为「斜向刷柄 + 收口刷头」的
                    经典漆刷轮廓：柄是带圆角端头的旋转矩形，刷头是向下收拢的梯形，
                    两个形状之间留出刷箍缝隙，缩到 14px 仍能一眼看出是刷子。 */}
                {btn.isBrushIcon ? (
                  <svg
                    className="format-btn-brush-icon"
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.9"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    {/* 刷柄（右上，带圆角端头） */}
                    <path d="M20.4 3.6a2.1 2.1 0 0 0-3 0l-5.3 5.3 3 3 5.3-5.3a2.1 2.1 0 0 0 0-3z" />
                    {/* 刷箍（柄与刷头之间的分界） */}
                    <path d="M12.1 8.9 15.1 11.9" />
                    {/* 刷头（向左下收拢的刷毛） */}
                    <path d="M10.9 10.1c-.6-.6-1.5-.6-2.1 0l-1.5 1.5c-1.1 1.1-1.4 2.3-1.6 3.3-.1.9-.5 1.4-1.1 2-.5.5-.3 1.2.3 1.4 1.7.7 3.8.6 5.3-.9l1.6-1.6c.6-.6.6-1.5 0-2.1z" />
                  </svg>
                ) : (
                  btn.label
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* ─── 主内容区域 ──────────────────────────── */}
      <div
        className="editor-main-area"
        ref={mainAreaRef}
        /* v0.15.2 需求1：模式切换滑入动画的方向（CSS 按它选 keyframes；null 时不播） */
        data-lmd-mode-anim={modeAnim ?? undefined}
      >
        {/* v0.12.0 需求5：右下角缩放尺（hover 显现；拖动/点击调整 docZoom） */}
        <ZoomRuler value={docZoom} onChange={setDocZoom} />
        {/* v0.6.1 问题5：模式切换悬浮按钮（阅读=羽毛笔→编辑 / 编辑=书本→阅读）
            v0.14.0 需求1：二模式后语义为「阅读 ↔ 编辑」，进入编辑时默认带右侧预览 */}
        {isMdFile && (
          <ModeSwitchButton
            viewMode={viewMode}
            onSwitch={(m) => {
              // 进编辑模式一律打开右侧预览（与标题栏「编辑」按钮同口径）
              if (m === "edit") useEditorStore.getState().setSplitPreviewOpen(true);
              setViewMode(m);
            }}
          />
        )}

        {/* v0.6.2 问题3：「译」字按钮智能判断——有选中文本时翻译选区，无选区时全文翻译；
            翻译运行中点击 = 取消（startFullTranslate 内部处理）。
            v0.13.2 需求4：槽位**动态**——图片管理入口显示时让到第 3 格（slot=2），
            不显示时补上那个空缺（slot=1，紧跟模式切换按钮），并带 CSS top 过渡。
            ⚠️ v0.13.2 返修：模式切换固定占第 0 格（10px）。旧值 `有图 ? 1 : 0`
            会让「译」与图片管理（slot=1）完全重合、无图时又与模式切换按钮（slot=0）
            完全重合 —— 用户实机看到的就是"译字图标和分屏编辑图标重叠"。 */}
        {/* v0.14.0 需求1：二模式后「译」在阅读模式与编辑模式都显示
            （旧口径是 preview 或 split；现在编辑模式关掉预览也照样能全文翻译） */}
        {(viewMode === "preview" || isSourceMode) && isMdFile && translateEnabled && (
          <FullTranslateButton
            slot={docHasImageFlag ? 2 : 1}
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

        {/* v0.13.0 返修（问题6）：图片管理悬浮入口。
          v0.13.1 需求7：槽位固定为第 1 格（=50px），即**始终排在「译」按钮上方**。
          v0.13.2 需求4：改为**淡入淡出**——组件常驻（只是切 is-hidden），
          这样"文档里删掉所有图片"时图标能淡出而不是瞬间消失，
          「译」按钮同时顺滑上移补位。
          v0.13.2 需求6：`data-genie-anchor` 让弹窗能测到按钮矩形，
          从而"从这个按钮里顺滑跑出来 / 再顺滑跑回去"（与底部搜索框同一机制）。 */}
      {isMdFile && (
        <span data-genie-anchor="image-manager">
          <ImageManagerButton
            slot={1}
            visible={docHasImageFlag}
            onOpen={() => window.dispatchEvent(
              new CustomEvent("lightmd:command", { detail: { id: "view.imageManager" } }),
            )}
          />
        </span>
      )}

      {/* v0.7.0 修复1：选区「译」浮动按钮右键快捷菜单（关闭 AI 翻译 / 隐藏翻译小气泡） */}
        {triggerMenuPos && (
          <MiniContextMenu
            x={triggerMenuPos.x}
            y={triggerMenuPos.y}
            items={[
              {
                action: "disable-ai-translate",
                label: t("translate.menu.disableAI"),
                onClick: () => {
                  // 关闭 AI 翻译子开关 + 取消进行中任务 + 立即隐藏已显示的浮动按钮
                  useSettingsStore.getState().setTranslateConfig({ translateEnabled: false });
                  translateService.cancel().catch(() => undefined);
                  hideTranslateTrigger();
                },
              },
              {
                action: "hide-bubble",
                label: t("translate.menu.hideBubble"),
                onClick: () => {
                  // 隐藏选中文本翻译小气泡（「译」入口子设置面板可重新打开）
                  useSettingsStore.getState().setTranslateConfig({ translateBubbleHidden: true });
                  translateService.cancel().catch(() => undefined);
                  hideTranslateTrigger();
                },
              },
            ]}
            onClose={() => setTriggerMenuPos(null)}
          />
        )}

        {/* v0.7.4 功能7 / v0.7.5 功能2：任一 AI 气泡右键快捷菜单。
            菜单文案按被右键的按钮动态生成（隐藏「润」气泡 / 隐藏「问」气泡…），
            只隐藏该一个任务（加入 aiAssistBubbleHiddenTasks），其余气泡照常显示；
            与「译」按钮的隐藏机制（translateBubbleHidden）互相独立 */}
        {aiMenuPos && (
          <MiniContextMenu
            x={aiMenuPos.x}
            y={aiMenuPos.y}
            items={[
              {
                action: "hide-ai-bubble",
                label: t("settings.translate.hideBubbleTask", {
                  glyph: AI_BUBBLE_GLYPHS[aiMenuPos.task ?? "continue"] ?? "",
                }),
                onClick: () => {
                  const task = aiMenuPos.task;
                  if (!task) return;
                  const cur = useSettingsStore.getState().translate.aiAssistBubbleHiddenTasks;
                  if (!cur.includes(task)) {
                    useSettingsStore
                      .getState()
                      .setTranslateConfig({ aiAssistBubbleHiddenTasks: [...cur, task] });
                  }
                  // 设置变化不产生 PM 事务，此处直接隐藏被点的那一个按钮 DOM
                  // （其余气泡不动——这是与 v0.7.4「一刀切隐藏」的核心差异）
                  document
                    .querySelectorAll<HTMLElement>(`.translate-ai-trigger[data-task="${task}"]`)
                    .forEach((el) => {
                      el.style.display = "none";
                    });
                },
              },
            ]}
            onClose={() => setAiMenuPos(null)}
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

        {/* 源码编辑区：v0.14.0 需求1 后所有非阅读模式都可见；
            预览面板展开时左栏按分割比例收窄，关闭时铺满整个编辑区 */}
        {/* 外层 wrapper 提供相对定位上下文，供专注遮罩 overlay 使用 */}
        <div
          className="source-editor-wrapper"
          style={{
            // v0.14.0 需求1：previewShown 时用 width 控制宽度（ratio 来自拖拽），
            // 否则铺满（flex:1）——即旧「编辑模式」的观感。
            flex: previewShown ? "none" : isSourceMode ? 1 : 0,
            width: previewShown ? `calc(${effectiveSplitRatio * 100}% - 3px)` : undefined,
            display: isSourceMode ? "flex" : "none",
            // v0.12.1 需求3：编辑模式的可滚动区域改为**整个编辑区**（滚动条贴最右），
            // 与阅读模式一致。实现方式：wrapper 不再收窄/居中（旧实现在这里加
            // maxWidth + margin:auto，滚动条因此停在正文右缘），改由 .source-editor
            // 用左右内边距把正文居中（见 editor.css 的 padding-inline: max(...)）。
            // 分屏模式不参与（宽度由分割比例决定，滚动条本就贴分栏右缘）。
          }}
        >
          {/**
            * ## v0.17.0 A3 装配修复①（头号缺陷）：宿主元素按实现分流
            *
            * 缺陷：此前**无条件**渲染受控 `<textarea value={sourceContent}>` 当宿主，
            * 而 `mount()` 把 CM6 挂到它**内部**。受控 textarea 的 `value` 让 React
            * 认为"这个节点的内容由我管" → 后续任何 re-render 都会重写其子节点，
            * **把 CM6 注入的 `.cm-editor` 整体清掉**。
            *
            * 实机探针证据链：mount 后 `.cm-editor: true` → 约 2.5s 后 `false`，
            * 而 `destroy()` 零调用（是 React 覆写，不是我们销毁）。
            *
            * 修法（设计稿 §2.2 的原始意图）：CM6 需要的是**干净容器**，
            * 不是"React 认为自己在管内容"的受控控件 → 渲染中性 `<div>`。
            * textarea 路径**保持原样**（受控 value 是它的核心同步机制，不能动）。
            */
          }
          {sourceSurface.impl === "cm6" ? (
            <div
              ref={sourceHostRef as unknown as React.RefCallback<HTMLDivElement>}
              className={`source-editor source-editor-cm6 ${previewShown ? "split-editor" : ""}`}
              style={{
                flex: isSourceMode ? 1 : 0,
                display: isSourceMode ? "block" : "none",
                // 排版口径必须与 textarea 一致（否则分屏对齐/专注遮罩测量全部偏移）：
                // 字号缩放、字族、行高都走同一套 CSS 变量。
                fontSize: `calc(${fontSize}px * var(--doc-zoom, 1))`,
                fontFamily: `${fontFamily}, "Cascadia Code", "Consolas", monospace`,
                borderRight: "none",
              }}
              aria-readonly={activeIsReadonly || undefined}
            />
          ) : (
          <textarea
            ref={sourceHostRef}
            className={`source-editor ${previewShown ? "split-editor" : ""}`}
            value={sourceContent}
            onChange={handleSourceChange.current}
            onKeyDown={handleSourceKeyDown}
            onPaste={handleSourcePaste}
            onContextMenu={handleTextareaContextMenu}
            spellCheck={spellcheckEnabled}
            /* v0.9.0 WP9：只读标签的源码模式同样禁止编辑 */
            readOnly={activeIsReadonly}
            aria-readonly={activeIsReadonly || undefined}
            style={{
              flex: isSourceMode ? 1 : 0,
              display: isSourceMode ? "block" : "none",
              // v0.12.0 需求5：编辑模式用字号换算实现缩放（不 zoom textarea——textarea
              // 是自带滚动的一体容器，zoom 会分裂 rect(视觉)/scrollTop(布局) 坐标系，
              // 打坏专注遮罩与打字机测量；字号放大后行高/换行/测量体系天然一致）。
              fontSize: `calc(${fontSize}px * var(--doc-zoom, 1))`,
              fontFamily: `${fontFamily}, "Cascadia Code", "Consolas", monospace`,
              // v0.4.0：分屏模式下右边框由分割条替代，避免双线
              borderRight: "none",
            }}
          />
          )}
          {/* 专冔模式遮罩：仅在编辑模式 + focusMode 开启时显示 */}
          {focusMode && isSourceMode && (
            <div ref={focusOverlayRef} className="source-focus-overlay" />
          )}
          {/* v0.7.3 改进10(U3)：source 续写 ghost overlay（前置在 textarea 之上，
              仅 sourceGhostActiveRef 活跃时填充内容，pointer-events:none 不拦截交互） */}
          <div ref={sourceGhostOverlayRef} className="source-ghost-overlay" />
        </div>

        {/* ─── 分割条 / 预览开关（v0.14.0 需求1）────────────────────────
            · 预览展开时：6px 可拖拽分割条，悬停（或悬停右屏）时浮出竖排小字「关闭预览」；
            · 预览关闭后：这条 rail 仍留在编辑区右缘（紧贴语法辅助栏左侧），
              悬停浮出「打开预览」，点击右屏从右往左滑回。
            · 关闭状态下不再可拖拽（没有右屏可调比例），故只在展开时挂 onMouseDown。 */}
        {isSourceMode && (
          <div
            className={`split-divider ${previewShown ? "split-divider-open" : "split-divider-closed"}`}
            title={previewShown ? t("appshell.dragToResize") : t("preview.toggle.open")}
            // v0.14.0 需求1：只有预览展开时才可拖拽（关闭态没有右屏可调比例）。
            // 「鼠标移到右屏时分割线显出竖排小字」完全由 CSS 的 `:has()` 实现
            // （见 editor.css 的 `.editor-main-area:has(.split-preview-shell:hover)`），
            // 不引入任何 React state，避免 hover 引发整棵编辑器重渲染。
            onMouseDown={(e) => {
              // ⚠️ 实测踩坑：竖排小字是分割条的**子元素**，若在这里启动拖拽，
              // useResizable 会 setPointerCapture 把指针捕获到分割条上，
              // 随后派发的 click 被重定向到分割条 → 按钮的 onClick 永远不触发
              // （表现为「点『关闭预览』毫无反应」，实机 CDP 已复现并证实）。
              // 因此凡是落在开关按钮上的按下，一律不启动拖拽，交给按钮自己处理。
              if ((e.target as HTMLElement | null)?.closest?.(".split-divider-label")) return;
              if (!previewShown) return;
              splitResizer.onMouseDown(e);
            }}
          >
            <button
              type="button"
              className="split-divider-label"
              data-testid="split-preview-toggle"
              aria-pressed={previewShown}
              title={previewShown ? t("preview.toggle.close") : t("preview.toggle.open")}
              onClick={(e) => {
                // 阻止冒泡到分割条：否则一次点击会同时触发拖拽起始逻辑
                e.stopPropagation();
                toggleSplitPreview();
              }}
            >
              {previewShown ? t("preview.toggle.close") : t("preview.toggle.open")}
            </button>
          </div>
        )}

        {/* 右侧预览面板：使用 iframe 隔离 DOM，减少主文档节点数和 GC 压力。
            v0.14.0 需求1：外壳宽度过渡 → 关闭时右屏「往右滑到语法辅助栏左侧」，
            重新打开时「从右往左滑出」。iframe 常驻挂载（宽度 0），
            这样滑出动画期间内容是现成的，不会先空白再出现。 */}
        {isSourceMode && (
          <div
            className={`split-preview-shell ${previewShown ? "split-preview-open" : "split-preview-closed"}`}
            style={{
              width: previewShown ? `calc(${(1 - effectiveSplitRatio) * 100}% - 3px)` : "0px",
            }}
            aria-hidden={!previewShown}
          >
            <iframe
              ref={previewIframeRef}
              className="split-preview ProseMirror"
              title={t("editor.preview")}
              sandbox="allow-same-origin allow-scripts"
            />
          </div>
        )}
      </div>

      {/* 搜索/替换（v0.8.5 需求7：由 GenieSearchDialog 包裹，active 驱动呼出/收回动画，
          收回动画结束后才真正卸载面板；props 与原条件渲染完全一致） */}
      <GenieSearchDialog
        active={showSearch || showSearchReplace}
        onClose={() => { setShowSearch(false); setShowSearchReplace(false); }}
        editorView={viewRef.current}
        sourceTextareaRef={sourceTextareaRef}
        sourceSurface={sourceSurface}
        sourceContent={sourceContent}
        onSourceContentChange={(newContent) => {
          // v0.14.0 需求1+2：统一走 `writeBackCurrentDoc`。
          //
          // 这个 prop 有**两个**调用方，必须都能正确处理：
          // ① SearchReplace 自己的「替换 / 全部替换」在**源码模式**下调用 →
          //    它要的正是「写 textarea 状态 + 记撤销记录」；
          // ② `replaceAllAcrossFiles`（条幅展开时的「全部替换（所有文件）」）对
          //    **当前文档**也调用它 —— 而这条路径**在阅读模式下也会发生**！
          //    旧实现无条件只写 state（隐藏的 textarea），阅读视图由 ProseMirror
          //    渲染 → 用户眼前一个字都不变（这就是需求1「没有立即生效」）。
          //    更糟：之后切模式会用 PM 内容反序列化回写，把替换结果**冲掉**
          //    （实机 T2 实测：替换后切编辑模式源码又变回 cat）。
          // `writeBackCurrentDoc` 按视图模式分流，两个调用方都正确。
          writeBackCurrentDoc(newContent);
        }}
        initialShowReplace={showSearchReplace}
        isMdFile={isMdFile}
        // v0.14.0 需求2：「选取范围内」的选区快照按文档归属校验
        docKey={currentDocKey() ?? undefined}
        // v0.14.0 需求2：「查找所有打开文件」的数据源（实时取文本，不传快照）
        collectFiles={collectSearchFiles}
        // v0.14.0 需求4：跨文件批量替换的写回通道（未激活标签只能经宿主写）
        applyFileText={applyFileText}
        // v0.14.0 需求5：换文档/换内容时让搜索立即在新文档上重跑
        // （阅读模式下 editorView 与 sourceContent 都不变，只有这个版本号会变）
        contentVersion={forceUpdateKey}
        // v0.14.0 需求2：编辑模式关掉右侧预览时，结果条幅可用更高空间
        splitPreviewOpen={previewShown}
        // v0.15.0 需求 R6b：工作区全文搜索的作用域来源。
        // ⚠️ 必须**订阅** openFolders（不能只在 JSX 里 getState()）：用户打开/关闭
        // 文件夹后，「工作区」作用域的可用性要立即跟着变，否则按钮状态是死的。
        // 传空数组时面板不渲染该按钮 → 未接线时也不会出现"点了没反应"的入口。
        workspaceRoots={workspaceRoots}
        // v0.15.0 需求 R6b：脏文档覆盖——已打开文件的命中改用内存文本重算，
        // 避免"搜索说这行有、点进去却没有"（磁盘内容落后于编辑器）。
        openFileTexts={() =>
          collectSearchFiles().map((f) => ({ filePath: f.filePath, getText: f.getText }))
        }
      />

      {/* 链接插入对话框 */}
      <LinkDialog
        open={linkDialogOpen}
        initialText={linkInitialText}
        onInsert={(md) => {
          // E1:阅读模式走 PM 插入(此前 preview 下 textarea 为 null 会静默失败)
          if (viewMode === "preview" && viewRef.current) insertMarkdownIntoPM(md);
          else insertTextAtCursor(md);
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
          // v0.12.0 需求2：PM 模式（阅读模式右键菜单入口）走 PM 插入，与 Link/Image 一致
          if (viewMode === "preview" && viewRef.current) insertMarkdownIntoPM(md);
          else insertTextAtCursor(md);
          setTableDialogOpen(false);
        }}
        onClose={() => setTableDialogOpen(false)}
      />

      {/* 图片插入对话框 */}
      <ImageInsertDialog
        open={imageDialogOpen}
        onInsert={(md) => {
          // E1:阅读模式走 PM 插入
          if (viewMode === "preview" && viewRef.current) insertMarkdownIntoPM(md);
          else insertTextAtCursor(md);
          setImageDialogOpen(false);
        }}
        onClose={() => setImageDialogOpen(false)}
      />

      {/* v0.15.0 需求（图片灯箱）：常驻挂载，未打开时零 DOM。
          行为完全由事件驱动（PM 插件/预览 iframe 采集点击 → 组件 portal 渲染）。 */}
      <ImageLightbox />

      {/* G3：图片编辑对话框 */}
      <ImageEditDialog
        open={imageEditDialogOpen}
        imageSrc={imageEditSrc}
        imageAlt={imageEditAlt}
        imageWidth={imageEditWidth}
        imageAlign={imageEditAlign}
        onConfirm={handleImageEditConfirm}
        onClose={() => {
          setImageEditDialogOpen(false);
          setImageEditPos(null);
          setImageEditSrc("");
          setImageEditAlt("");
          setImageEditWidth(null);
          setImageEditAlign("left");
        }}
      />

      {/* 编辑器右键菜单 */}
      <EditorContextMenu
        open={contextMenu.open}
        x={contextMenu.x}
        y={contextMenu.y}
        hasSelection={contextMenu.hasSelection}
        // v0.15.1 需求1：禁用态必须读**统一时间线**（旧 diff 栈已退休、永远为空，
        // 会让右键菜单的撤销/恢复恒为灰色不可点 —— 用户感知为"撤销彻底坏了"）
        canUndo={canUndoUnified()}
        canRedo={canRedoUnified()}
        isMdFile={isMdFile}
        translateEnabled={translateEnabled}
        onAction={handleContextMenuAction}
        onClose={() => setContextMenu((s) => ({ ...s, open: false }))}
      />

      {/* v0.12.0 需求2：阅读模式（PM）右键菜单（首次为 PM 模式引入自定义菜单） */}
      <PmContextMenu
        open={pmContextMenu.open}
        x={pmContextMenu.x}
        y={pmContextMenu.y}
        hasSelection={pmContextMenu.hasSelection}
        nodeKind={pmContextMenu.nodeKind}
        isMdFile={isMdFile}
        translateEnabled={translateEnabled}
        hasBlockClipboard={pmContextMenu.hasBlockClipboard}
        hasTextClipboard={pmContextMenu.hasTextClipboard}
        onAction={handlePmMenuAction}
        onClose={() => setPmContextMenu((s) => ({ ...s, open: false }))}
      />

      {/* v0.13.0 需求1：块右上角三点菜单（复用 MiniContextMenu 弹层） */}
      {blockKebabMenu.open && (
        <MiniContextMenu
          x={blockKebabMenu.x}
          y={blockKebabMenu.y}
          onClose={() => setBlockKebabMenu((s) => ({ ...s, open: false }))}
          items={(() => {
            const view = viewRef.current;
            const doc = view?.state.doc;
            const isFirst = !doc || blockKebabMenu.pos <= 0;
            const isLast = !doc || blockKebabMenu.pos >= doc.content.size;
            return buildBlockMenuItems({
              hasClipboard: blockKebabMenu.hasClipboard,
              isFirstBlock: isFirst,
              isLastBlock: isLast,
            }).map<MiniMenuItem>((item) => ({
              action: item.id,
              label: t(item.labelKey),
              onClick: () => handleBlockKebabAction(item.id),
              // v0.13.0 返修（问题5）：把纯函数算出的禁用/危险/分隔线**透传给弹层**。
              // 缺陷背景：这三项此前被整体丢弃 → 所有菜单项都渲染成可点、
              // 无分隔线、删除项也不标红；再加上移动/格式刷的实现缺陷，
              // 用户看到的就是「除了删除该块，其余功能都不能用」。
              disabled: item.disabled,
              danger: item.danger,
              separator: item.separatorBefore,
            }));
          })()}
        />
      )}

      {/* v0.12.1 需求1：标题级别下拉菜单（点击标题左侧 H1/H2 徽标打开） */}
      <HeadingLevelMenu
        open={headingMenu.open}
        anchor={headingMenu.anchor}
        current={headingMenu.level}
        onSelect={(level) => applyHeadingLevel(headingMenu.pos, level)}
        onClose={() => setHeadingMenu((s) => ({ ...s, open: false }))}
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

      {/* v0.13.0 需求10：阅读模式 Emoji 短码补全菜单（ProseMirror 插件触发） */}
      {!isSourceMode && isMdFile && pmEmoji && (
        <EmojiCompletePm
          view={viewRef.current}
          emoji={pmEmoji}
          onClose={() => setPmEmoji(null)}
        />
      )}

      {/* v0.6.0：AI 翻译结果气泡（Portal 渲染到 body，idle 时组件内部返回 null） */}
      <TranslateBubble
        onApply={handleTranslateApply}
        onCopy={handleTranslateCopy}
        onRetry={handleTranslateRetry}
      />

      {/* v0.7.0：AI 助手结果气泡（润色/摘要/源码续写；Portal，idle 时组件内部返回 null） */}
      <AiAssistBubble
        onApply={handleAiApply}
        onCopy={handleTranslateCopy}
        onRetry={handleAiRetry}
      />

      {/* v0.7.5 功能1：AI 对话浮动窗口（Portal，关闭时组件内部返回 null）
          v0.15.4 需求7：getContextValues 供自定义指令的 {{selection}}/{{document}} 展开 */}
      <AiChatDialog
        onSend={sendAiChat}
        onStop={stopAiChat}
        onRegenerate={regenerateAiChat}
        onInsertAtCursor={chatInsertAtCursor}
        onReplaceSelection={chatReplaceSelection}
        onReplaceDocument={chatReplaceDocument}
        onCopy={chatCopy}
        onScopeChange={chatScopeChange}
        getContextValues={getChatContextValues}
      />
    </div>
  );
}
