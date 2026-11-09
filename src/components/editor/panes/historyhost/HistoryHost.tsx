/**
 * src/components/editor/panes/HistoryHost/HistoryHost.tsx —— HistoryHost pane
 *
 * ## 职责边界
 *
 * 撤销/恢复时间线接线（documentHistory + editorHistory coordinator + sourceAdapter/pmAdapter）
 *
 * ## 从哪搬来的（v0.17.0 P0-1）
 *
 * 搬自 `src/components/editor/EditorContainer.tsx` 的 组件体 951-1909 行。
 * **hook 体逐字节原样**（连缩进、注释、空行都没动）——这是本轮拆分的硬约束：
 * 判定"无逻辑改写"靠的是文本不变，不是靠肉眼审。
 *
 * 参数经 `Params` 解构到本地同名绑定 → 函数体内引用与拆分前完全一致；
 * 产物以 `Result` 对象返回给容器。两边字段都由 TypeChecker 生成真类型。
 *
 * ⚠️ 本文件**不得**直接 import textarea 具体实现：源码面一律经 `SourceSurface`
 * 接口访问（见 src/editor/types.ts）。
 */
import {
  useRef,
  useCallback,
  useEffect,
  useState,
  useLayoutEffect,
  useMemo,
} from "react";
import { t as translate } from "../../../../i18n";
import { useEditorStore, ViewMode } from "../../../../stores/useEditorStore";
import { UNTITLED_PROGRESS_PREFIX } from "../../../../utils/tabKey";
import { HistoryHost, HistoryCoordinator, makeHistoryCoordinator } from "../../../../editorHistory/coordinator";
import { getMarkdownFromDoc } from "../../../../core/editor";
import { unmaskBase64Images, maskBase64Images } from "../../../../utils/base64ImageMask";
import { readingFold } from "../.././readingFold";
import { ContentAnchor, collectPmBlockGeometry, captureContentAnchor, blockGeometryFromLineAxis } from "../../../../utils/contentScrollMap";
import { topLevelBlockStartLines } from "../../../../core/renderPipeline";
import { measureSourceLineAxis } from "../../../../utils/blockScrollAlign";
import { documentHistory } from "../../../../services/documentHistory";
import { withTrailingParagraph } from "../../../../core/plugins/trailing-paragraph";
import { markdownToDoc } from "../../../../core/markdown/parser";
import { createSourceAdapter } from "../../../../editorHistory/sourceAdapter";
import { createPmAdapter } from "../../../../editorHistory/pmAdapter";
import { notifyWarning } from "../../../../services/notificationService";
import { setHostUndoRedo } from "../../../../core/keymap";
import type { EditorView as EditorView } from "prosemirror-view";
import {
  HistoryEntry,
  traceScroll,
  MAX_HISTORY,
  computeDiff,
  sourceUndoBoundaryMessage,
} from "../../EditorContainer";
import type { HistoryHostParams, HistoryHostResult } from "./types";

export function useHistoryHost(p: HistoryHostParams): HistoryHostResult {
  // 解构到本地同名绑定：函数体因此可以逐字节原样
  const {
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
  } = p;

  const undoStackRef = useRef<HistoryEntry[]>([]);

  const redoStackRef = useRef<HistoryEntry[]>([]);

  const isUndoRedoRef = useRef(false);

  const undoDocKey = useCallback((): string | null => {
    const st = useEditorStore.getState();
    const tab = st.openTabs[st.activeTabIdx];
    if (!tab) return null;
    return tab.isUntitled
      ? `${UNTITLED_PROGRESS_PREFIX}${tab.id ?? st.activeTabIdx}`
      : tab.path || null;
  }, []);

  const historyDocKeyOrEmpty = useCallback((): string => undoDocKey() ?? "", [undoDocKey]);

  const historyHostRef = useRef<HistoryHost | null>(null);

  const historyCoordinatorRef = useRef<HistoryCoordinator | null>(null);

  const currentRealText = useCallback((): string => {
    if (viewMode === "preview" && isMdFile) {
      const view = viewRef.current;
      if (!view || view.isDestroyed) return "";
      try {
        return getMarkdownFromDoc(view.state.doc);
      } catch {
        return "";
      }
    }
    return unmaskBase64Images(sourceContentRef.current, base64TokensRef.current);
  }, [viewMode, isMdFile]);

  const lastRealTextRef = useRef<string>("");

  useEffect(() => {
    readingFold.setEnabled(viewMode === "preview");
  }, [viewMode]);

  useEffect(() => {
    // 与撤销同一口径：真实文件 = 路径 / 临时标签 = untitled:<id>。
    // 不用 `currentDocKeyFromStore`（定义在 2900 行之后，同样会 TDZ）。
    readingFold.setDocKey(undoDocKey());
  }, [filePath, forceUpdateKey, undoDocKey]);

  const docKeyRef = useRef<string | null>(null);

  const lastHistoryContentRef = useRef<string>("");

  const pmScrollPercentRef = useRef(0);

  const textareaScrollPercentRef = useRef(0);

  const isSyncingScrollRef = useRef(false);

  const pendingScrollRef = useRef<{
    targetMode: ViewMode;
    percent: number;
    /** 光标所在行号（0-based）；null/undefined 表示无锚点 */
    anchorLine?: number | null;
    /**
     * v0.12.0 返修（问题6）：行内列偏移（光标相对行首的字符数）。
     * 阅读 → 编辑切换时，PM 选区只精确到"行号 + 行内 doc 文本偏移"，
     * 此前一律落到行首——用户读到"abc"后切换，输入光标却在行首。
     * 有值时恢复光标 = 行首 + anchorColumn（clamp 到源行长度）。
     */
    anchorColumn?: number | null;
    /**
     * v0.15.0 需求（阅读↔编辑内容对齐）：模式切换瞬间采到的**内容锚点**。
     *
     * 为什么不再只用百分比：百分比在"同一份内容的同一套排版"下才等价；阅读模式与
     * 编辑模式的正文宽度、行高、块间距都不同，长段落软换行数也不同 → 同一百分比
     * 指向的是**不同内容**（0.14.0 实测有数行几何差）。
     * 锚点记的是「视口中央是哪个块 + 块内比例」，与排版几何无关，
     * 换到另一套排版后反算 scrollTop 仍是同一处内容。
     */
    contentAnchor?: ContentAnchor | null;
  } | null>(null);

  const prevViewModeRef = useRef<ViewMode>(viewMode);

  const isRestoringScrollRef = useRef(false);

  const historyScrollGuardUntilRef = useRef(0);

  const HISTORY_SCROLL_GUARD_MS = 400;

  const inHistoryScrollGuard = useCallback(
    () => performance.now() < historyScrollGuardUntilRef.current,
    [],
  );

  const scrollRestoreGenRef = useRef(0);

  const anchorCapturedForModeRef = useRef<string | null>(null);

  const [modeAnim, setModeAnim] = useState<"to-edit" | "to-preview" | null>(null);

  const modeAnimGenRef = useRef(0);

  const captureContentAnchorRef = useRef<(() => ContentAnchor | null) | null>(null);

  const modeSwitchAnchorRef = useRef<ContentAnchor | null>(null);

  const pmGeomCacheRef = useRef<{
    blocks: import("../../../../utils/contentScrollMap").BlockGeometry[];
    scrollTop: number;
    clientHeight: number;
    scrollHeight: number;
  } | null>(null);

  const captureReaderContentAnchor = useCallback((): ContentAnchor | null => {
    const cache = pmGeomCacheRef.current;
    const container = editorRef.current;
    // 阅读面此刻仍可见（render 期）→ 现读实时几何；不可见时退回缓存快照
    const live = container && container.clientHeight > 0 ? container : null;
    const scrollTop = live ? live.scrollTop : cache ? cache.scrollTop : 0;
    const clientHeight = live ? live.clientHeight : cache ? cache.clientHeight : 0;
    const scrollHeight = live ? live.scrollHeight : cache ? cache.scrollHeight : 0;
    // 实时可见时**重新量块几何**（比缓存更准：缓存可能是滚动中途采的）
    const fresh = live ? collectPmBlockGeometry(live) : null;
    const blocks = fresh ?? cache?.blocks ?? null;
    if (!blocks) {
      traceScroll("cap-reader", { ok: false, live: !!live });
      return null;
    }
    const anchor = captureContentAnchor(blocks, scrollTop, clientHeight, {
      contentHeight: scrollHeight,
    });
    traceScroll("cap-reader", {
      ok: !!anchor,
      live: !!live,
      fresh: !!fresh,
      top: scrollTop,
      h: clientHeight,
      sh: scrollHeight,
      n: blocks.length,
      idx: anchor?.blockIndex,
      ratio: anchor?.ratioWithinBlock,
      hid: anchor?.headingId,
      atTop: anchor?.atTop,
      atBottom: anchor?.atBottom,
    });
    return anchor;
  }, []);

  const cachePmGeometry = useCallback(() => {
    const container = editorRef.current;
    if (!container || container.clientHeight <= 0) return;
    const blocks = collectPmBlockGeometry(container);
    if (!blocks) return;
    pmGeomCacheRef.current = {
      blocks,
      scrollTop: container.scrollTop,
      clientHeight: container.clientHeight,
      scrollHeight: container.scrollHeight,
    };
  }, []);

  const srcGeomCacheRef = useRef<{
    blocks: import("../../../../utils/contentScrollMap").BlockGeometry[];
    scrollTop: number;
    clientHeight: number;
    scrollHeight: number;
    /** textarea.clientWidth：宽度变了软换行位置就变，块几何作废 */
    clientWidth: number;
    /** 缓存时的正文长度：内容变了行轴作废 */
    textLength: number;
  } | null>(null);

  const measureSourceBlocks = useCallback((): {
    blocks: import("../../../../utils/contentScrollMap").BlockGeometry[];
    markdown: string;
  } | null => {
    const textarea = sourceTextareaRef.current;
    if (!textarea) return null;
    // 不可见时高度/宽度为 0 → 量不出可信行轴
    if (!(textarea.clientHeight > 0) || !(textarea.clientWidth > 0)) return null;
    if (!(textarea.scrollHeight > 0)) return null;
    const markdown = unmaskBase64Images(sourceContentRef.current, base64TokensRef.current);
    if (!markdown) return null;
    try {
      const blockLines = topLevelBlockStartLines(markdown);
      const measured = measureSourceLineAxis({ textarea, blockLines });
      if (!measured) return null;
      const blocks = blockGeometryFromLineAxis({
        totalLines: measured.totalLines,
        lineAxis: measured.axis,
        blockLines,
        contentHeight: textarea.scrollHeight,
        maxScroll: Math.max(0, textarea.scrollHeight - textarea.clientHeight),
      });
      return blocks ? { blocks, markdown } : null;
    } catch {
      return null;
    }
  }, []);

  const cacheSourceGeometry = useCallback(() => {
    const textarea = sourceTextareaRef.current;
    if (!textarea) return;
    const measured = measureSourceBlocks();
    if (!measured) return;
    srcGeomCacheRef.current = {
      blocks: measured.blocks,
      scrollTop: textarea.scrollTop,
      clientHeight: textarea.clientHeight,
      scrollHeight: textarea.scrollHeight,
      clientWidth: textarea.clientWidth,
      textLength: measured.markdown.length,
    };
  }, [measureSourceBlocks]);

  const captureSourceContentAnchor = useCallback((): ContentAnchor | null => {
    const textarea = sourceTextareaRef.current;
    const canMeasureLive = !!(textarea && textarea.clientHeight > 0 && textarea.clientWidth > 0);
    if (canMeasureLive) {
      const measured = measureSourceBlocks();
      if (measured) {
        // 顺手刷新缓存（下一次切换若量不到可直接用）
        srcGeomCacheRef.current = {
          blocks: measured.blocks,
          scrollTop: textarea.scrollTop,
          clientHeight: textarea.clientHeight,
          scrollHeight: textarea.scrollHeight,
          clientWidth: textarea.clientWidth,
          textLength: measured.markdown.length,
        };
        const anchor = captureContentAnchor(
          measured.blocks,
          textarea.scrollTop,
          textarea.clientHeight,
          { contentHeight: textarea.scrollHeight },
        );
        traceScroll("cap-source", {
          ok: !!anchor,
          live: true,
          fresh: true,
          top: textarea.scrollTop,
          h: textarea.clientHeight,
          sh: textarea.scrollHeight,
          n: measured.blocks.length,
          idx: anchor?.blockIndex,
          ratio: anchor?.ratioWithinBlock,
          line: anchor?.sourceLine,
          atTop: anchor?.atTop,
          atBottom: anchor?.atBottom,
        });
        return anchor;
      }
    }
    // ── 兜底：读可见期间缓存的块几何 ──
    const cache = srcGeomCacheRef.current;
    if (!cache) {
      traceScroll("cap-source", { ok: false, why: "no-cache" });
      return null;
    }
    // 缓存必须与当前正文一致：内容改过（行数/长度变）时行轴已失效。
    // 用 unmask 后的真实文本长度比较（`sourceContentRef` 是 mask 后的展示文本）。
    const markdown = unmaskBase64Images(sourceContentRef.current, base64TokensRef.current);
    if (!markdown || markdown.length !== cache.textLength) {
      traceScroll("cap-source", { ok: false, why: "text-changed", len: markdown.length, cached: cache.textLength });
      return null;
    }
    /**
     * ⚠️ v0.15.1 需求3（**第三次返修的关键点**）：`scrollTop` 必须取**实时值**，
     * 不能用缓存里的快照。
     *
     * 踩过的坑（实机探针实测到的"交替漂移"）：缓存是滚动时写的，而恢复流程会在
     * 切换之后**再校正**若干次（rAF / 60ms / 160ms）。若锚点用缓存里的旧 `scrollTop`，
     * 第二轮切换就会以**上一轮校正前**的位置当基准 → 恢复值在新旧两个位置之间来回跳
     * （实测 3179 → 7958 → 3179 → 7958），用户感知就是"每切一次偏一点"。
     * 现在只从缓存取**块几何**（行轴与滚动位置无关），`scrollTop` / `clientHeight` 现读。
     */
    const liveScrollTop = textarea && textarea.clientHeight > 0 ? textarea.scrollTop : cache.scrollTop;
    const liveClientHeight =
      textarea && textarea.clientHeight > 0 ? textarea.clientHeight : cache.clientHeight;
    const anchor = captureContentAnchor(cache.blocks, liveScrollTop, liveClientHeight, {
      contentHeight: cache.scrollHeight,
    });
    traceScroll("cap-source", {
      ok: !!anchor,
      live: !!(textarea && textarea.clientHeight > 0),
      fresh: false,
      top: liveScrollTop,
      h: liveClientHeight,
      sh: cache.scrollHeight,
      n: cache.blocks.length,
      idx: anchor?.blockIndex,
      ratio: anchor?.ratioWithinBlock,
      line: anchor?.sourceLine,
      atTop: anchor?.atTop,
      atBottom: anchor?.atBottom,
    });
    return anchor;
  }, [measureSourceBlocks]);

  if (
    typeof window !== "undefined" &&
    prevViewModeRef.current !== viewMode &&
    anchorCapturedForModeRef.current !== viewMode
  ) {
    anchorCapturedForModeRef.current = viewMode;
    const anchor =
      prevViewModeRef.current === "preview"
        ? captureReaderContentAnchor()
        : captureSourceContentAnchor();
    modeSwitchAnchorRef.current = anchor ?? null;
  }

  useLayoutEffect(() => {
    const prev = prevViewModeRef.current;
    if (prev === viewMode) return;
    // 正常路径：render 期已采到（此时旧面仍可见，几何可信），这里只兜底。
    // 兜底时旧面已 display:none，只能读各自缓存 —— 比没锚点好，但不如 render 期准。
    if (modeSwitchAnchorRef.current) return;
    const anchor =
      prev === "preview" ? captureReaderContentAnchor() : captureSourceContentAnchor();
    if (anchor) modeSwitchAnchorRef.current = anchor;
    traceScroll("cap-layout-fallback", { prev, mode: viewMode, ok: !!anchor });
  }, [viewMode, captureReaderContentAnchor, captureSourceContentAnchor]);

  useLayoutEffect(() => {
    const pending = pendingSourceSelectionRef.current;
    if (!pending) return;
    if (Date.now() > pending.until) {
      pendingSourceSelectionRef.current = null;
      return;
    }
    const ta = sourceTextareaRef.current;
    if (!ta) return;
    const len = ta.value.length;
    const start = Math.min(pending.start, len);
    const end = Math.min(pending.end, len);
    try {
      ta.setSelectionRange(start, end);
      if (pending.scrollTop !== null) ta.scrollTop = pending.scrollTop;
      lastTextareaCursorRef.current = start;
    } catch {
      /* textarea 已卸载 / 只读：忽略 */
    }
  }, [sourceContent]);

  useEffect(() => {
    if (viewMode !== "preview") {
      pmGeomCacheRef.current = null;
      return;
    }
    // rAF 等布局稳定后采（刚切进阅读面时块高可能尚未定）
    const raf = requestAnimationFrame(() => cachePmGeometry());
    return () => cancelAnimationFrame(raf);
  }, [viewMode, content, forceUpdateKey, cachePmGeometry]);

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
    } else if (lastMaskFilePathRef.current !== filePath) {
      // v0.9.5 问题5：阅读模式下文件切换（含新建空临时文件）——sourceContent
      // 立即同步新文件内容。原先仅在源码/非 md 模式同步，阅读模式下新建空文件时
      // sourceContent 残留上一文档内容，切分屏后预览面板渲染出上一个文档。
      // 仅按路径变化触发（打字不进此分支，避免每键 mask 的 O(n) 开销）；
      // PM doc 由文件切换 effect 重建，B6 未编辑块序列化即原文，与 content 一致。
      base64TokensRef.current = new Map();
      lastMaskFilePathRef.current = filePath;
      const { text: masked } = maskBase64Images(content, base64TokensRef.current);
      setSourceContent(masked);
      sourceContentRef.current = masked;
      // 分屏模式下立即刷新防抖渲染，消除 300ms 内旧内容闪现
      setDebouncedSourceContent(masked);
    }
  }, [content, isSourceMode, isMdFile, filePath]);

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

  const recordUndoEntry = useCallback((oldContent: string, newContent: string, cursorPos: number, scrollTop: number) => {
    if (isUndoRedoRef.current) return;
    const diff = computeDiff(oldContent, newContent);
    if (diff.deleted === "" && diff.inserted === "") return; // 无变化
    const entry: HistoryEntry = { ...diff, cursorPos, scrollTop };
    pushUndoEntry(entry);
  }, [pushUndoEntry]);

  const recordDiscreteSourceEdit = useCallback(
    (
      beforeMasked: string,
      afterMasked: string,
      caret: number,
      scrollTop: number,
      /**
       * 落点光标（可选，默认与 `caret` 相同）。翻译回写 / AI 润色这类"整段替换"里
       * 撤销要回到**原选区起点**、重做要回到**译文末尾**，两者不是同一个位置。
       */
      afterCaret?: number,
    ) => {
      const beforeReal = unmaskBase64Images(beforeMasked, base64TokensRef.current);
      const afterReal = unmaskBase64Images(afterMasked, base64TokensRef.current);
      if (beforeReal === afterReal) return;
      const key = historyDocKeyOrEmpty();
      if (!key) return;
      // 基线纠偏：离散操作之前可能已有别的路径改过文本（如翻译回写），
      // 以宿主为准 rebase，避免 commit 被静默拒绝后"这一步永远撤不回来"。
      if (documentHistory.currentText(key) !== beforeReal) {
        documentHistory.rebaseText(key, beforeReal, { force: true });
      }
      const after = typeof afterCaret === "number" ? afterCaret : caret;
      documentHistory.commit(
        {
          before: beforeReal,
          after: afterReal,
          origin: "source",
          beforeSelection: { start: caret, end: caret, scrollTop },
          afterSelection: { start: after, end: after, scrollTop },
        },
        key,
      );
      lastRealTextRef.current = afterReal;
    },
    [historyDocKeyOrEmpty],
  );

  const writeBackCurrentDoc = useCallback((newText: string) => {
    const view = viewRef.current;
    const liveMd = viewMode === "preview" && isMdFile;
    // v0.15.0 需求（跨模式撤销统一）：写回前先取真实旧文本，写回后作为一条
    // `origin:"replace"` 条目提交到统一时间线（搜索/替换/跨文件替换共用）。
    // ⚠️ 不要再依赖 `addToHistory:true` 让 PM 栈顺带记录：那会让同一次替换
    // 同时进 PM 栈与统一时间线 → 一次 Ctrl+Z 撤两步（评审 §1.7 第 7 项）。
    const beforeReal = currentRealText();
    if (liveMd) {
      if (!view) return;
      try {
        const newDoc = withTrailingParagraph(markdownToDoc(newText));
        const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, newDoc.content);
        // 阅读模式立即生效；但**不进** PM 历史（由统一时间线记录这一步）
        tr.setMeta("addToHistory", false);
        // 注意**不要**设 fileSwitch（那会让 onDocChange 跳过序列化与脏标记）
        view.dispatch(tr);
      } catch (e) {
        console.error("[EditorContainer] 阅读模式整篇写回失败:", e);
      }
    } else {
      // 源码模式 / 非 md 阅读模式：走 textarea 状态通道
      setSourceContent(newText);
      sourceContentRef.current = newText;
      onContentChangeRef.current?.(newText);
      setDirtyRef.current(true);
      // v0.6.6 问题4：lastContentRef 与 content prop 同为真实坐标（unmask 后）
      lastContentRef.current = unmaskBase64Images(newText, base64TokensRef.current);
    }
    // 统一记录这一步（源码/阅读同一入口）。文本无变化时 commit 内部返回 null。
    //
    // ⚠️ `beforeReal` 必须与时间线的 knownText 逐字节一致，否则 commit 会**静默拒绝**
    // （安全语义：不允许把基于旧文本的改动接在新文本后面）。而 knownText 可能因
    // 模式切换重解析 / trailing-paragraph / 外部重载而与当前宿主文本不同 ——
    // 此时必须先 rebase 把基线对齐，否则"搜索替换"这一步根本不会进撤销栈
    //（实机探针实测：A 上撤销替换无任何反应）。
    const key = historyDocKeyOrEmpty();
    if (key) {
      if (documentHistory.currentText(key) !== beforeReal) {
        documentHistory.rebaseText(key, beforeReal, { force: true });
      }
      documentHistory.commit(
        { before: beforeReal, after: newText, origin: "replace" },
        key,
      );
      lastRealTextRef.current = newText;
    }
    if (liveMd) {
      // 阅读模式的 setDirty/序列化由 onDocChange 完成，与既有行为一致
      setDirtyRef.current(true);
    }
  }, [viewMode, isMdFile, currentRealText, historyDocKeyOrEmpty]);

  const sourceAdapterRef = useRef(createSourceAdapter());

  const pmAdapterRef = useRef(
    createPmAdapter({
      // 只序列化 doc：`view.state.doc` 是 PM doc；时间线存真实 Markdown
      serialize: (doc) => {
        try {
          return getMarkdownFromDoc(doc as Parameters<typeof getMarkdownFromDoc>[0]);
        } catch {
          return "";
        }
      },
      commit: (plan) => historyCoordinatorRef.current?.commitFromPm(plan),
      // 非用户编辑（fileSwitch / 翻译回写 / trailing-paragraph）只推进基线，不产生条目
      rebase: (textValue) => {
        const key = historyDocKeyOrEmpty();
        if (key) documentHistory.rebaseText(key, textValue);
      },
    }),
  );

  const historyHost = useMemo<HistoryHost>(() => ({
    docKey: () => historyDocKeyOrEmpty(),
    currentText: () => currentRealText(),
    // 读 store 的实时值而非闭包：协调器长期存活，闭包会停在创建时
    currentMode: () => (useEditorStore.getState().viewMode === "preview" ? "pm" : "source"),
    applyText: (text, restore, meta) => {
      // 落地实现体在下方 `applyHistoryText`（依赖阅读/源码两套既有写回链路）
      applyHistoryTextRef.current?.(text, restore, meta);
    },
    notifyBoundary: (kind) => {
      if (kind === "undo") {
        const boundaryMsg = sourceUndoBoundaryMessage(0);
        if (boundaryMsg) notifyWarning(boundaryMsg);
      } else if (kind === "cross-file-stale") {
        notifyWarning(translate("editor.undoCrossFileStale"));
      }
    },
    afterApply: (textValue, direction) => {
      lastRealTextRef.current = textValue;
      setDirtyRef.current(true);
      if (direction === "undo") formatGhostHandlersRef.current.clear("undo");
    },
  }), [historyDocKeyOrEmpty, currentRealText]);

  historyHostRef.current = historyHost;

  historyCoordinatorRef.current = useMemo(
    () => makeHistoryCoordinator({
      api: documentHistory,
      host: historyHost,
      // 撤销前必须把 PM 侧的节流队列落地，否则丢最后一段打字
      flushPending: () => {
        pmAdapterRef.current.flush();
      },
      // v0.15.1 需求1：undo/redo 落地后把 PM adapter 基线前移到实际文本。
      //
      // 不做的后果（用户实测的「撤几次后撤销/恢复全废」）：bridge 事务被 pmAdapter
      // 整批忽略（这是对的，否则撤销动作本身会被记成新编辑），但它的 baseline 仍停在
      // 撤销前的文本 → 用户一打字，commit 的 before 与时间线 knownText 失配 →
      // 协调器 force-rebase → truncateRedo 把 redo 分支整段删掉 → 恢复失效，
      // 反复几次后连撤销也失效并误报「已到本模式撤销边界」。
      syncAdapterBaseline: (textValue) => {
        pmAdapterRef.current.setBaseline(textValue);
      },
    }),
    [historyHost],
  );

  const applyHistoryTextRef = useRef<
    ((text: string, restore: unknown, meta: unknown) => void) | null
  >(null);

  const sourceComposingRef = useRef(false);

  const sourceJustPairedRef = useRef(false);

  const sourceJustPastedRef = useRef(false);

  const doLocalUndo = useCallback((): boolean => {
    return historyCoordinatorRef.current?.handleUndo() ?? false;
  }, []);

  const doLocalRedo = useCallback((): boolean => {
    return historyCoordinatorRef.current?.handleRedo() ?? false;
  }, []);

  const canUndoUnified = useCallback((): boolean => {
    const key = historyDocKeyOrEmpty();
    return key ? documentHistory.canUndo(key) : false;
  }, [historyDocKeyOrEmpty]);

  const canRedoUnified = useCallback((): boolean => {
    const key = historyDocKeyOrEmpty();
    return key ? documentHistory.canRedo(key) : false;
  }, [historyDocKeyOrEmpty]);

  const handleUndo = useCallback(() => {
    doLocalUndo();
  }, [doLocalUndo]);

  const handleRedo = useCallback(() => {
    doLocalRedo();
  }, [doLocalRedo]);

  useEffect(() => {
    setUndoHandler(handleUndo);
    setRedoHandler(handleRedo);
    // v0.14.0 续修 需求1：同一条处理器再注册给 PM 动态键位表。
    // 阅读模式按 Ctrl+Z 时 `core/keymap.ts` 的 `dynamicShortcutsPlugin` 先接管，
    // 它必须把动作**交回这里**（doLocalUndo/doLocalRedo），否则会走原生
    // prosemirror-history 的 undo —— 而那是「按内容重建、resetHistory 清空」的栈，
    // 跨文件替换写下的记录（docHistoryStore.crossFileUndo）永远不会被消费。
    setHostUndoRedo({ undo: handleUndo, redo: handleRedo });
    return () => {
      setUndoHandler(null);
      setRedoHandler(null);
      setHostUndoRedo(null);
    };
  }, [handleUndo, handleRedo, setUndoHandler, setRedoHandler]);

  return {
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
    handleRedo
  };
}
