/**
 * src/components/editor/panes/PreviewPane/PreviewPane.tsx —— PreviewPane pane
 *
 * ## 职责边界
 *
 * 预览 iframe 渲染、data-src-line 贴标、分屏双向滚动联动、预览开合冻结
 *
 * ## 从哪搬来的（v0.17.0 P0-1）
 *
 * 搬自 `src/components/editor/EditorContainer.tsx` 的 组件体 7052-9395 行。
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
  useCallback,
  useLayoutEffect,
  useRef,
  useEffect,
  useMemo,
} from "react";
import { captureAnchor, captureTextAnchor, ViewportAnchor, restoreAnchor, restoreTextAnchor, TextContentAnchor } from "../../../../utils/viewportAnchor";
import { computeScrollPercent, computeRestoreScrollTop, computeTypewriterScrollTop, createScrollKeyBaseline, isCursorOutsideViewport, markScrollKeyDown, consumeScrollKeyUp, isModifierKey, shouldSkipScrollForCharInput, shouldSkipInitialScrollToCenter, isTypewriterTriggerKey, computeSyncScrollTop } from "../../../../utils/typewriter";
import { DOC_ZOOM_STEP } from "../../../../stores/useSettingsStore";
import { setMermaidTheme } from "../../../../core/plugins/mermaid-block";
import { isDarkTheme, mermaidThemeName } from "../../../../utils/themeTone";
import { measureTextareaCursorY } from "../../../../utils/focus-paragraph";
import { LARGE_FILE_THRESHOLD } from "../../../../utils/constants";
import { renderCodeFilePreview, getPrismCss } from "../../../../utils/highlight";
import { unmaskBase64Images } from "../../../../utils/base64ImageMask";
import { resolveImageSrc } from "../../../../utils/imagePath";
import { isAnchorablePreviewChild, shouldTagPreview, PreviewAnchorSet, lineAtMaxScroll, estimateTopSourceLine, mapSourceLineToPreviewScroll, mapPreviewScrollToSourceLine, mapSourceLineToScrollTop } from "../../../../utils/blockScrollAlign";
import { measureLineAxis, surfaceMeasureSource, textareaMeasureSource } from "../../../../editor/surface/sourceLineAxis";
import { topLevelBlockStartLines } from "../../../../core/renderPipeline";
import { createIframeFoldBridge, readingFold } from "../.././readingFold";
import { bindPreviewLightbox } from "../../../../core/plugins/image-lightbox";
import { createScrollDirectionLock, shouldAcceptScroll, markScrollSource, resetScrollDirectionLock } from "../../../../utils/splitScrollSync";
import { shouldContinuePreviewRealign, PREVIEW_REALIGN_DELAYS } from "../../../../utils/textOffsetRemap";
import type { EditorView as EditorView } from "prosemirror-view";
import type { ViewMode as ViewMode } from "../../../../stores/useEditorStore";
import {
  renderMarkdownToHtml,
  traceScroll,
} from "../../EditorContainer";
import type { PreviewPaneParams, PreviewPaneResult } from "./types";

export function usePreviewPane(p: PreviewPaneParams): PreviewPaneResult {
  // 解构到本地同名绑定：函数体因此可以逐字节原样
  const {
    viewMode,
    isMdFile,
    isSourceMode,
    previewShown,
    editorRef,
    sourceSurface,
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
  } = p;


  // ─── v0.12.1 需求9（二轮）：排版变化时保持阅读焦点 ────────────────
  //
  // 用户反馈：在设置里调字号 / 行高 / 段间距 / 内容区宽度时，文档会重排，视口内容漂移
  // （和没做窗口缩放焦点保持之前一样）。字号/行高只改文本高度、内容区宽度只改
  // `.ProseMirror` 的 max-width —— 外层滚动容器的**盒子尺寸都没变**，所以既有的
  // ResizeObserver 锚点（只在容器宽度变化时补偿）在这里不会生效，必须显式补偿。
  //
  // 做法：**在同一个 layout effect 里完成「先量旧位置 → 写新变量 → 立刻量新位置 → 补 scrollTop」**。
  // 用 useLayoutEffect 而非 useEffect，整段发生在浏览器绘制之前 → 不会闪一帧。
  // 量 getBoundingClientRect 会强制同步布局，所以写变量后立刻测量拿到的一定是新排版。
  //   · 阅读模式 → 块锚点（视口内首个顶层块 + 其相对视口顶的偏移）
  //   · 编辑/分屏左侧 → textarea 内容锚点（视口顶部字符偏移 + 视口 Y）
  // 内容不足一屏（无可滚动空间）时两个 capture 都返回 null，安全跳过。
  const captureTypographyAnchor = useCallback(() => {
    const container = viewMode === "preview" && isMdFile ? editorRef.current : null;
    const blockAnchor = container ? captureAnchor(container, ".ProseMirror > *") : null;
    const ta = isSourceMode ? sourceTextareaRef.current : null;
    const textAnchor = ta ? captureTextAnchor(ta) : null;
    // v0.12.2 P8：分屏右侧 iframe 也要参与锚点补偿。
    // 此前只处理了「preview 的阅读容器」与「edit/split 左侧 textarea」，
    // 分屏右侧 iframe 的行高/段间距/内容宽度变化**完全没有补偿**
    // → 拖设置滑条时只有右侧预览的阅读焦点丢失（三模式行为不一致）。
    // 与既有 iframe 锚点效应同口径：锚 iframe 文档滚动元素内的 body > *。
    let iframeScroller: Element | null = null;
    let iframeBlockAnchor: ViewportAnchor | null = null;
    if (previewShown) {
      const doc = previewIframeRef.current?.contentDocument;
      const s = (doc?.scrollingElement ?? doc?.documentElement) ?? null;
      if (s) {
        iframeScroller = s;
        iframeBlockAnchor = captureAnchor(s, "body > *");
      }
    }
    return { container, blockAnchor, ta, textAnchor, iframeScroller, iframeBlockAnchor };
  }, [viewMode, isMdFile, isSourceMode, previewShown]);


  const restoreTypographyAnchor = useCallback(
    (anchor: ReturnType<typeof captureTypographyAnchor>) => {
      if (anchor.container && anchor.blockAnchor) restoreAnchor(anchor.container, anchor.blockAnchor);
      if (anchor.ta && anchor.textAnchor) restoreTextAnchor(anchor.ta, anchor.textAnchor);
      // v0.12.2 P8：分屏右侧 iframe 同步补偿
      if (anchor.iframeScroller && anchor.iframeBlockAnchor) {
        restoreAnchor(anchor.iframeScroller, anchor.iframeBlockAnchor);
      }
    },
    [],
  );


  // ─── 字体 ──────────────────────────────────────
  // v0.11.0 B4-1：字号/字体同时写到 **:root**（原先只写在 .ProseMirror 元素上）。
  //
  // 缺陷背景（P1）：collectCssVars 从 `document.documentElement`（即 :root）读取
  // `--editor-font-size/family` 来生成 iframe 的分屏预览样式，但变量只设在
  // .ProseMirror 上 → 取不到，回落 "16px"/"sans-serif" → **改设置后左右两侧
  // 字号不一致**（所见非所得）。
  //
  // 修复：写到 :root，:root 与 .ProseMirror 都能取到；collectCssVars 无需改动。
  // 同时保留 .ProseMirror 上的设置（局部覆盖，语义更明确）。
  //
  // v0.12.1 需求9：排版预览值优先（设置弹窗里拖滑条 → 立即改用预览值，
  // 未拖动时 preview 为 null，行为与以前完全一致）。
  // v0.12.1 需求9（二轮）：改为 useLayoutEffect，并在写变量前后做一次视口锚点补偿
  // （见上方 captureTypographyAnchor 的说明）——保证调字号/字体时阅读焦点不丢。
  useLayoutEffect(() => {
    const anchor = captureTypographyAnchor();
    const root = document.documentElement;
    root.style.setProperty("--editor-font-size", `${effFontSize}px`);
    root.style.setProperty("--editor-font-family", effFontFamily);
    const editorDom = editorRef.current?.querySelector(".ProseMirror") as HTMLElement | null;
    if (editorDom) {
      editorDom.style.setProperty("--editor-font-size", `${effFontSize}px`);
      editorDom.style.setProperty("--editor-font-family", effFontFamily);
    }
    restoreTypographyAnchor(anchor);
  }, [effFontSize, effFontFamily, captureTypographyAnchor, restoreTypographyAnchor]);


  // v0.11.0 B4-10：排版三项（行高 / 段间距 / 内容区最大宽度）注入 CSS 变量。
  // 机制与上面字号/字体一致（写到 :root，iframe 预览的 collectCssVars 也能取到）。
  // 值为 0 表示「跟随主题默认」→ 此时清空属性，让 CSS 的 var() 兜底值生效。
  // v0.12.1 需求9：同样支持预览值覆盖（实时预览）。
  // v0.12.1 需求9（二轮）：同样改为 useLayoutEffect + 视口锚点补偿
  // （行高/段间距只改文本高度、内容区宽度只改 .ProseMirror 的 max-width，
  //  外层滚动容器盒子不变 → 既有 ResizeObserver 锚点不会触发，必须在这里显式补偿）。
  useLayoutEffect(() => {
    const anchor = captureTypographyAnchor();
    const root = document.documentElement;
    const setOrClear = (name: string, value: number, unit: string) => {
      if (value > 0) root.style.setProperty(name, `${value}${unit}`);
      else root.style.removeProperty(name);
    };
    setOrClear("--editor-line-height", effLineHeight, "");
    setOrClear("--editor-paragraph-spacing", effParagraphSpacing, "");
    setOrClear("--editor-content-max-width", effContentMaxWidth, "px");
    restoreTypographyAnchor(anchor);
  }, [effLineHeight, effParagraphSpacing, effContentMaxWidth, captureTypographyAnchor, restoreTypographyAnchor]);


  // v0.12.0 需求5：文档缩放比例注入 --doc-zoom（:root，值为比例：1 = 100%）。
  // 消费方：阅读 .ProseMirror 的 CSS zoom、分屏 iframe body 的 zoom（经 collectCssVars）、
  // 编辑 textarea 的字号 calc（见 textarea 内联样式）、table-editor 的 rect→布局值换算。
  //
  // v0.12.0 返修（问题3）：缩放同样要求"阅读焦点不偏移"。
  // zoom 是布局属性——内容整体按比例变高/变矮，而 scrollTop 是绝对像素，
  // 不动它时放大后视口会落到更靠前的内容（用户看到"内容往回流"）。
  // 纯缩放是**等比变换**：滚动百分比天然守恒，所以在写入新 --doc-zoom 之前记下百分比、
  // 布局生效后（rAF）按新高度还原即可。两类阅读容器都走百分比：
  //   · 阅读模式 → .editor-container；
  //   · 分屏模式 → iframe 文档滚动元素（iframe 的 body innerHTML 会随缩放被重写，
  //     块锚点的元素引用会失效，故不能用块锚点）。
  // 编辑/分屏左侧 textarea 的字号换算另由下方内容锚点效应处理（字体变化会重排，
  // 百分比不守恒）。
  const lastDocZoomRef = useRef(docZoom);

  useEffect(() => {
    // 仅"缩放真的变了"才补偿：模式/文件切换也会触发本效应，
    // 那时若做百分比还原会与 applyScroll 抢滚动位置
    const zoomChanged = lastDocZoomRef.current !== docZoom;
    lastDocZoomRef.current = docZoom;

    const previewContainer =
      zoomChanged && viewMode === "preview" && isMdFile ? editorRef.current : null;
    const previewPercent = previewContainer
      ? computeScrollPercent(
          previewContainer.scrollHeight,
          previewContainer.clientHeight,
          previewContainer.scrollTop,
        )
      : null;
    const iframeDoc =
      zoomChanged && previewShown ? previewIframeRef.current?.contentDocument : null;
    const iframeScroller = (iframeDoc?.scrollingElement ??
      iframeDoc?.documentElement ??
      null) as HTMLElement | null;
    const iframePercent = iframeScroller
      ? computeScrollPercent(
          iframeScroller.scrollHeight,
          iframeScroller.clientHeight,
          iframeScroller.scrollTop,
        )
      : null;

    document.documentElement.style.setProperty("--doc-zoom", String(docZoom / 100));

    if (!zoomChanged) return;
    const raf = requestAnimationFrame(() => {
      if (previewContainer && previewPercent !== null) {
        const top = computeRestoreScrollTop(
          previewPercent,
          previewContainer.scrollHeight,
          previewContainer.clientHeight,
        );
        if (top !== null) previewContainer.scrollTop = top;
      }
      if (iframeScroller && iframePercent !== null) {
        const top = computeRestoreScrollTop(
          iframePercent,
          iframeScroller.scrollHeight,
          iframeScroller.clientHeight,
        );
        if (top !== null) iframeScroller.scrollTop = top;
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [docZoom, viewMode, isMdFile]);


  // v0.12.0 需求5：Ctrl+滚轮调整文档缩放（阅读/编辑/分屏三模式通用）。
  // 监听挂在 .editor-main-area（不影响侧栏/标签栏）；
  // passive:false + preventDefault 阻止 WebView2 的页面级缩放与默认滚动。
  // 向上滚（deltaY < 0）= 放大，向下滚 = 缩小。
  useEffect(() => {
    const container = mainAreaRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      adjustDocZoom(e.deltaY < 0 ? DOC_ZOOM_STEP : -DOC_ZOOM_STEP);
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [adjustDocZoom]);


  // v0.12.0 返修（需求4/5）：视口锚点补偿的时间抑制 —— 文件切换/模式切换/缩放恢复
  // 期间不补偿（只重建锚点），避免 RO 用"切换前"的锚点抢跑主动恢复。
  useEffect(() => {
    anchorSuppressUntilRef.current = performance.now() + 600;
  }, [viewMode, filePath, forceUpdateKey]);

  // v0.12.0 需求5：缩放恢复（行高/内容尺寸变化）同样抑制，交由下面的锚点效应补偿
  useEffect(() => {
    anchorSuppressUntilRef.current = performance.now() + 300;
  }, [docZoom]);


  // ─── v0.12.0 需求4：视口锚点（窗口/侧栏尺寸变化时保持阅读焦点） ─────────
  // 尺寸变化会重排文本；scrollTop（像素）不变时视口内容漂移。
  // 方案：变化前记录"视口首个可见块 + 偏移"，ResizeObserver 回调（重排完成后）
  // 用差值补偿 scrollTop；rAF 双保险避开侧栏 width transition（250ms）的中间帧。
  // 副作用：补偿触发 scroll → fileScrollProgress 自动记录新百分比，无需处理。
  //
  // v0.12.0 返修（需求4 bug）：最大化→缩小→再放大会跳到文档末尾。
  // 根因：窗口 resize 期间 Chromium 会把焦点光标（阅读模式 PM 选区常在文档末尾）
  // 程序性滚入视口——该滚动先于 RO 回调触发 scroll 事件，把锚点"刷新"成了末尾，
  // 随后的补偿反而把视口恢复到末尾。修复：window resize 事件先于 scroll 步骤
  // 触发，用它打时间标，抑制窗口内的 scroll 锚点刷新。
  // v0.12.0 返修2（问题4/5）：再叠加两道闸门——
  //  ① 仅在**容器宽度变化**时补偿（内容增高/异步渲染引发的 RO 不算，避免抢跑主动恢复）；
  //  ② 主动恢复（切文件/切模式/缩放）后的 600ms 内只重建锚点、不补偿。
  useEffect(() => {
    if (viewMode !== "preview" || !isMdFile) return;
    const container = editorRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const selector = ".ProseMirror > *";
    let anchor = captureAnchor(container, selector);
    let suppressUntil = 0;
    let lastWidth = container.clientWidth;
    const markResize = () => { suppressUntil = performance.now() + 350; };
    // 用户滚动后基准更新为当前视口（resize 抑制窗口内除外）
    const onScroll = () => {
      if (performance.now() < suppressUntil) return;
      anchor = captureAnchor(container, selector);
    };
    const ro = new ResizeObserver(() => {
      const w = container.clientWidth;
      const widthChanged = w !== lastWidth;
      lastWidth = w;
      const suppressed = performance.now() < anchorSuppressUntilRef.current;
      requestAnimationFrame(() => {
        // 宽度未变（如内容增高/图片异步渲染）或处于主动恢复窗口 → 只重建锚点
        if (!suppressed && widthChanged) restoreAnchor(container, anchor);
        anchor = captureAnchor(container, selector);
      });
    });
    ro.observe(container);
    window.addEventListener("resize", markResize);
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", markResize);
      container.removeEventListener("scroll", onScroll);
    };
  }, [viewMode, isMdFile, forceUpdateKey]);


  // v0.12.0 返修（问题2）：textarea 改用**内容锚点**（视口顶部字符偏移 + 视口 Y）。
  // - 捕获：滚动停止 150ms 后（debounce，避免滚动中每帧二分测量）与进入模式时；
  // - 还原：仅在**宽度变化**且不在主动恢复窗口时补偿（软换行重排后准确回到原内容）；
  // - resize 抑制：窗口缩放时浏览器会把光标滚入视口，其 scroll 事件不得刷新锚点。
  useEffect(() => {
    if (!isSourceMode) return;
    // TODO(v0.18): CM6 能力缺口 — 字号/宽度变化时的文本锚点采集（ResizeObserver） — CM6 下不做锚点补偿，缩放后视口可能偏移
    const ta = sourceTextareaRef.current;
    if (!ta || typeof ResizeObserver === "undefined") return;
    textAnchorRef.current = captureTextAnchor(ta);
    let suppressUntil = 0;
    let lastWidth = ta.clientWidth;
    let captureTimer: ReturnType<typeof setTimeout> | null = null;
    const markResize = () => { suppressUntil = performance.now() + 350; };
    const scheduleCapture = () => {
      if (performance.now() < suppressUntil) return;
      if (captureTimer) clearTimeout(captureTimer);
      captureTimer = setTimeout(() => { textAnchorRef.current = captureTextAnchor(ta); }, 150);
    };
    const ro = new ResizeObserver(() => {
      const w = ta.clientWidth;
      const widthChanged = w !== lastWidth;
      lastWidth = w;
      const suppressed = performance.now() < anchorSuppressUntilRef.current;
      requestAnimationFrame(() => {
        // v0.14.0 第六批：**预览开关过渡期间不做锚点补偿**。
        //
        // 缺陷（用户实测：反复双击 Shift 开合预览，左屏每轮上漂 ~28.67px）：
        // 预览开合会让左栏宽度`1002 ↔ 1998` 过渡 → RO 每帧回调；
        // 宽度变化时 `restoreTextAnchor` 用"视口顶部字符偏移"补偿 scrollTop。
        // 但**开关预览并不改变文档内容**（实测 scrollHeight 两态都是 8833，
        // 因为 `.source-editor` 是 flex 布局：宽度变、内容高度不变）→
        // 补偿本不该发生，而 `measureOffsetViewportY` 的 mirror 测量在过渡中间帧
        // （宽度逐帧变化、软换行正在重排）必然带亚像素误差 → 每帧补一点，
        // 累积成"持续上漂、阅读焦点乱动"。
        // 冻结窗口内只允许「重新捕获锚点」，不允许补偿。
        if (scrollFreezeRef.current || isFrozenRestoreRef.current) {
          if (widthChanged) formatGhostHandlersRef.current.render();
          if (captureTimer) clearTimeout(captureTimer);
          captureTimer = setTimeout(() => { textAnchorRef.current = captureTextAnchor(ta); }, 150);
          return;
        }
        if (!suppressed && widthChanged) restoreTextAnchor(ta, textAnchorRef.current);
        // 还原后重新捕获（延迟，避免与后续 RO 抢跑）
        if (captureTimer) clearTimeout(captureTimer);
        captureTimer = setTimeout(() => { textAnchorRef.current = captureTextAnchor(ta); }, 150);
        // v0.12.0 返修：overlay 的内容宽度在渲染时固化（syncTextareaMetrics），
        // 宽度变化后必须重绘，否则 ghost / 续写预览会按旧宽度换行（视觉竖排偏移）
        if (widthChanged) formatGhostHandlersRef.current.render();
      });
    });
    ro.observe(ta);
    window.addEventListener("resize", markResize);
    ta.addEventListener("scroll", scheduleCapture, { passive: true });
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", markResize);
      ta.removeEventListener("scroll", scheduleCapture);
      if (captureTimer) clearTimeout(captureTimer);
    };
  }, [isSourceMode, viewMode, forceUpdateKey]);


  // v0.12.0 需求5：缩放（字号换算）变化后按内容锚点还原 textarea 滚动位置。
  // 字号/缩放变化后行高与换行都变，像素 scrollTop 不变会让视口跳到别处；
  // 用"视口顶部内容偏移"还原，视觉上视口顶部内容保持不动。
  useEffect(() => {
    if (!isSourceMode) return;
    // TODO(v0.18): CM6 能力缺口 — 几何（文本锚点需要真实视口坐标，CM6 需 coordsAtPos 语义）— 当前表现：锚点降级/不精确，非静默失效
    const ta = sourceTextareaRef.current;
    if (!ta) return;
    const raf = requestAnimationFrame(() => {
      restoreTextAnchor(ta, textAnchorRef.current);
      textAnchorRef.current = captureTextAnchor(ta);
    });
    return () => cancelAnimationFrame(raf);
  }, [docZoom, isSourceMode]);


  // v0.11.0 B4-10：阅读进度上报（状态栏显示百分比）。
  //
  // 缺陷背景：此前无任何滚动进度可视化 —— 长文档阅读时完全不知道还剩多少。
  // 注意与 fileScrollProgress（跨会话位置恢复）区分：那是**位置**（像素/行号），
  // 本项是**百分比**（仅供 UI 展示），两者互不干扰。
  //
  // 用 rAF 节流：scroll 事件在拖动滚动条时可达 60+/s，直接 setState 会造成
  // 持续重渲染；且只在百分比变化时（整数）才 dispatch，进一步降低更新次数。
  //
  // ─── v0.12.2 P8 修复：分屏/编辑模式恒显 100% ───
  //
  // 原实现只监听 `editorRef.current`（PM 阅读容器），而该容器在 split 模式
  // 是 `display:none`（见下方 render：仅 preview 模式 flex:1）→
  // `scrollHeight - clientHeight = 0` → 判定为"无可滚动空间" → **恒报 100%**。
  // 分屏实际滚动发生在左侧 textarea 与右侧 iframe，编辑模式发生在 textarea。
  //
  // 现按模式选择真正的滚动容器（阅读 → editor-container，编辑/分屏 → textarea），
  // 分屏时以左侧 textarea 为准（与状态栏"光标行列"同源，语义一致）。
  useEffect(() => {
    const container = isSourceMode ? sourceTextareaRef.current : editorRef.current;
    if (!container) return;
    let raf = 0;
    let lastPct = -1;
    const report = () => {
      raf = 0;
      const { scrollTop, clientHeight, scrollHeight } = container;
      // 无可滚动空间（内容不足一屏）→ 视为 100%（已读完）
      const scrollable = scrollHeight - clientHeight;
      const pct = scrollable <= 1 ? 100 : Math.min(100, (scrollTop / scrollable) * 100);
      const rounded = Math.round(pct);
      // 仅整数变化时才写 store（0.4% 以下的抖动不触发重渲染）
      if (rounded !== lastPct) {
        lastPct = rounded;
        setScrollProgress(rounded);
      }
    };
    const onScroll = () => {
      if (raf === 0) raf = requestAnimationFrame(report);
    };
    // 初次挂载也要上报一次（否则未滚动时状态栏无值）
    report();
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
      if (raf !== 0) cancelAnimationFrame(raf);
    };
    // isSourceMode 变化（切模式）时重新绑定到正确的滚动容器
  }, [setScrollProgress, isSourceMode, viewMode]);


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
    setMermaidTheme(isDarkTheme(theme));
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
    // v0.8.0 修复4：提升为 ref，供 onSelectionChange 在打字机模式下即时居中复用
    scrollToCenterRef.current = scrollToCenter;

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
    // v0.7.5 修复：基线改为 ScrollKeyBaseline 对象，keyup 侧必须先确认"见过配套
    // keydown"再使用（气泡 Esc 会 stopPropagation 吞掉编辑器 keydown，留下陈旧基线，
    // 直接使用会把文档滚回上一次按键位置 —— 表现为"按 Esc 跳回文档开头"）
    const scrollBaseline = createScrollKeyBaseline();
    // 记录按键前光标是否在视口外，用于决定 keyup 时是否恢复 scrollTop
    let cursorWasOutside = false;
    // keydown 必须在捕获阶段注册：ProseMirror 的 keydown 监听器在冒泡阶段执行，
    // 会先处理回车/方向键并移动光标。若在冒泡阶段记录，savedCursorY
    // 会是变化后的 Y，导致 keyup 时 Y 差值始终为 0，回车换行不触发滚动。
    const handleKeyDown = () => {
      const cursorY = getCursorY();
      // 问题2修复：使用 scrollContainer 的 scrollTop
      const scrollTop = scrollContainer.scrollTop;
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
      markScrollKeyDown(scrollBaseline, cursorY, scrollTop, cursorWasOutside);
    };

    // 焦点离开编辑器时作废基线：避免"按下某键后未抬起就切窗"留下的
    // seen=true 被后续无关 keyup 误当成有效基线
    const handleBlur = () => {
      scrollBaseline.seen = false;
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
      // v0.7.5 修复：先消费基线（无论后续是否跳过都要复位 seen，
      // 避免陈旧 seen 被下一个 keyup 误用）
      const paired = consumeScrollKeyUp(scrollBaseline);
      // 模式切换恢复滚动位置期间跳过：applyScroll 正在用 instant 设置恢复滚动位置，
      // 此处若触发 smooth 滚动会覆盖 applyScroll 的设置，导致快捷键切换模式时滚动位置丢失
      // 根因：双击 Ctrl/Shift 切换模式时，keyup 事件冒泡到 ProseMirror 触发此处理器，
      // 若不跳过则可能调用 scrollToCenter（smooth）覆盖 applyScroll 的 instant 设置
      if (isRestoringScrollRef.current) return;
      // 修饰键（Shift/Ctrl/Alt/Meta）不移动光标，不应触发滚动
      // 作为 isRestoringScrollRef 的双重保护，应对 applyScroll effect 尚未执行的时序竞争
      if (isModifierKey(e.key)) return;
      // v0.7.5 修复（按 Esc 跳回文档开头）：本处理器没见过配套 keydown 时基线是
      // 上一次按键的陈旧值，据此恢复 scrollTop 会把文档滚回旧位置。气泡的 Esc 处理
      // 在 window 捕获阶段 stopPropagation，正好造成这种"keydown 被吞、keyup 到达"。
      if (!paired) return;

      const savedCursorY = scrollBaseline.cursorY;
      const savedScrollTop = scrollBaseline.scrollTop;
      const wasOutside = scrollBaseline.cursorWasOutside;

      const cursorY = getCursorY();
      const diff = Math.abs(cursorY - savedCursorY);

      // v0.15.4 需求10：撤销/恢复的滚动窗口内**不允许**按键驱动滚动。
      //
      // 实测（`scripts/v0154-probe-real-keys.mjs`）：Ctrl+Z 之后 keyup 到达，
      // `diff` 很大（整篇换掉、光标也换了）→ 落到下面的 `scrollToVisible()`，
      // 把视口推到光标处（+3448px），而内容锚点恢复的 60ms 校正又拉回来（−3448px）
      // → 用户看到「撤销时文档抖一下」。用户只按了 Ctrl+Z，不该有"光标滚入视口"。
      // 视口位置由 `restorePreviewScrollFromAnchor` 统一负责。
      if (inHistoryScrollGuard()) return;
      // 光标在视口外时按键：浏览器 scrollIntoView 已把光标滚动到可见
      // 不恢复 scrollTop，避免抖动；打字机模式进一步滚动到中央
      if (wasOutside) {
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
    editorDom.addEventListener("blur", handleBlur);
    editorDom.addEventListener("click", handleClick);

    // 打字机模式开启时，初始居中
    // 但模式切换时跳过：applyScroll 正在恢复滚动位置，scrollToCenter 的 smooth
    // 滚动会覆盖 applyScroll 的 instant 设置（smooth 是异步多帧的）
    if (!shouldSkipInitialScrollToCenter(isRestoringScrollRef.current, typewriterModeRef.current)) scrollToCenter();

    return () => {
      editorDom.removeEventListener("keydown", handleKeyDown, { capture: true } as EventListenerOptions);
      editorDom.removeEventListener("keyup", handleKeyUp);
      editorDom.removeEventListener("blur", handleBlur);
      editorDom.removeEventListener("click", handleClick);
    };
  }, [viewMode, forceUpdateKey, typewriterMode]);


  // textarea 打字机滚动（编辑/分屏模式）
  useEffect(() => {
    if (!typewriterMode || viewMode === "preview") return;
    // TODO(v0.18): CM6 能力缺口 — 源码面打字机的 DOM 事件绑定 — CM6 下打字机事件暂不生效（居中不触发），**非静默失败：CM6 自身保持光标可见**
    const textarea = sourceTextareaRef.current;
    if (!textarea) return;
    // 不设置 scrollBehavior = "smooth"，与 ProseMirror 模式保持一致：
    // 避免全局 CSS 影响所有滚动操作，改用 scrollTo({ behavior: "smooth" }) 显式控制

    const scrollCursorToCenter = () => {
      requestAnimationFrame(() => {
        if (!typewriterModeRef.current) return;
        /**
         * v0.17.0 A3-④：光标 Y 的数据源改经 `SourceSurface.offsetToContentY`。
         *
         * **机制完全未改**（`computeTypewriterScrollTop` 纯函数、阈值抖动过滤、
         * smooth/instant 取舍、keydown 基线恢复策略全部照搬）—— 只换"Y 从哪来"：
         * - textarea 实现 → 内部仍用 `measureTextareaCursorY`（mirror，原函数一行未改）；
         * - CM6 实现 → `coordsAtPos - documentTop`，**不再需要 mirror**。
         */
        const cursorPos = sourceSurface.getSelection().start;
        const cursorY = sourceSurface.offsetToContentY(cursorPos);
        /**
         * ⚠️ **布局不可用时必须 return，绝不能退化成 `cursorY = 0`。**
         *
         * 这是一个"看起来无害的默认值实际上是大坑"的典型：
         * `cursorY = 0` 意味着"光标在文档最顶部" → 打字机每次输入都会尝试把视口滚回顶部
         *（`computeTypewriterScrollTop` 会算出 target=0）→ 用户看到的是**文档自己往上跑**。
         * 这比"不居中"（本次跳过、位置不动）严重得多，而且很难归因到"某个测量函数返回了 0"。
         *
         * 同理，下面 handleKeyUp 的普通字符分支也显式处理 null（退回 instant 恢复基线），
         * 而不是让 0 流进计算。
         */
        if (cursorY === null) return;
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
    // v0.7.5 修复：与阅读模式同源——只在"见过配套 keydown"时才允许 keyup 用
    // 基线恢复/滚动，避免气泡 Esc（window 捕获 stopPropagation 吞掉 keydown）
    // 后拿陈旧 scrollTop 把文档滚回旧位置
    const scrollBaseline = createScrollKeyBaseline();
    let savedScrollTop = 0;
    const handleKeyDown = () => {
      savedScrollTop = textarea.scrollTop;
      markScrollKeyDown(scrollBaseline, 0, savedScrollTop, false);
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
      // v0.7.5 修复：先消费基线（保证 seen 一定被复位）
      const paired = consumeScrollKeyUp(scrollBaseline);
      if (!typewriterModeRef.current) return;
      // 模式切换恢复滚动位置期间跳过：applyScroll 正在用 instant 设置恢复滚动位置，
      // 此处若触发 smooth 滚动会覆盖 applyScroll 的设置，导致快捷键切换模式时滚动位置丢失
      // 根因：双击 Ctrl/Shift 切换模式时，keyup 事件在 textarea 上触发（事件冒泡），
      // 若不跳过则会调用 scrollCursorToCenter 或 scrollTo({behavior: "smooth"})
      if (isRestoringScrollRef.current) return;
      // v0.15.4 需求10：撤销/恢复的滚动窗口内不让打字机居中接管（同阅读面口径）。
      if (inHistoryScrollGuard()) return;
      // 修饰键（Shift/Ctrl/Alt/Meta）不移动光标，不应触发滚动
      // 作为 isRestoringScrollRef 的双重保护，应对 applyScroll effect 尚未执行的时序竞争
      if (isModifierKey(e.key)) return;
      // v0.7.5 修复：keydown 被吞（气泡 Esc）→ 基线陈旧，跳过（否则会把文档滚回旧位置）
      if (!paired) return;
      if (isTypewriterTriggerKey(e.key)) {
        // 导航键：smooth 滚动到中央
        scrollCursorToCenter();
      } else {
        // 普通字符：检查光标是否偏离中央（A3-④：Y 数据源改经 surface，机制不变）
        const cursorPos = sourceSurface.getSelection().start;
        const cursorY = sourceSurface.offsetToContentY(cursorPos);
        if (cursorY === null) {
          textarea.scrollTo({ top: savedScrollTop, behavior: "instant" });
          return;
        }
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
    // 焦点离开 textarea 时作废基线（防"按键未抬起就切窗"留下陈旧 seen）
    const handleBlur = () => {
      scrollBaseline.seen = false;
    };

    textarea.addEventListener("keydown", handleKeyDown);
    textarea.addEventListener("keyup", handleKeyUp);
    textarea.addEventListener("click", handleClick);
    textarea.addEventListener("blur", handleBlur);
    // 打字机模式开启时，初始居中
    // 但模式切换时跳过：applyScroll 正在恢复滚动位置，scrollCursorToCenter 的 smooth
    // 滚动会覆盖 applyScroll 的 instant 设置（smooth 是异步多帧的）
    // 修复快捷键切换模式时滚动位置丢失 bug
    if (!shouldSkipInitialScrollToCenter(isRestoringScrollRef.current, typewriterModeRef.current)) scrollCursorToCenter();

    return () => {
      textarea.removeEventListener("keydown", handleKeyDown);
      textarea.removeEventListener("keyup", handleKeyUp);
      textarea.removeEventListener("click", handleClick);
      textarea.removeEventListener("blur", handleBlur);
    };
  }, [typewriterMode, viewMode, forceUpdateKey]);

  const justEnteredSplitRef = useRef(false);

  /**
   * v0.14.0 需求1：右侧预览面板「上一帧是否可见」。
   * 旧实现用 `prevViewModeRef` 判"刚进 split"，但预览开关现在是独立状态
   * （编辑模式内反复开关、阅读↔编辑来回切），必须按 previewShown 的**边沿**判定，
   * 否则从阅读模式切回编辑（预览本来开着）不会触发"立即渲染"，
   * 右屏会先空白 300ms 再出现。
   */
  const prevPreviewShownRef = useRef(false);

  /**
   * v0.14.0 第六批（用户实测缺陷）：**预览开关期间的滚动位置冻结**。
   *
   * ## 缺陷（用户原话）
   * 「文档拉到底，在编辑模式不断重复关闭预览和打开预览（不断双击 Shift），
   *  结果发现文档进度每一次会细微的往上滚动，这样文档不断在滚动就造成了阅读焦点不断变化。」
   *
   * ## 实测根因（`scripts/v0140-probe-toggle-geometry.mjs` / `-scrollwriter.mjs`）
   * 文档在底部时：关闭态 `scrollTop=7582`（gap=1px，到底）；打开预览后变成
   * `scrollTop=7553.198`（gap=29.667px）—— 每轮净丢 **28.67px**，且值是带循环小数的
   * 浮点，证明是 **JS 计算写回** 而非原生滚动（hook `Element.prototype.scrollTop`
   * 抓到调用者是联动同步 `syncToSource`）。
   *
   * 关键事实：开关预览**不改变 textarea 的 scrollHeight**（实测两态都是 8833，
   * `max` 都是 7583 —— 因为 `.source-editor` 是 flex 布局，宽度变但内容高度不变）。
   * 既然内容和可滚动空间都没变，**任何**对左屏 scrollTop 的写入都是多余的，
   * 而左右块锚点映射是**有损往返**（底部 ↔ 底部映射回来少 28.67px），
   * 于是每开合一次就丢一点 → 累积上漂。
   *
   * ## 修法
   * 预览开关（`previewShown` 边沿）触发的这一小段窗口内：
   * 1. **冻结左屏滚动位置**：进入窗口前记下 `textarea.scrollTop`；
   * 2. 窗口内左右联动同步一律不写左屏（见 `syncToSource` 的 `isScrollFrozen` 守卫），
   *    也不让宽度过渡期的 ResizeObserver 锚点补偿改写它；
   * 3. 窗口结束（宽度过渡 420ms + 一帧布局稳定后）**精确还原**到记下的值。
   *
   * 为什么不是"修好映射往返"：映射往返在**中间位置**本来就有损（两个锚点之间的
   * 真实块高与插值必然有亚像素/结构差），要求它对所有位置恒等既不现实也没必要 ——
   * 用户抱怨的是「开关预览会动滚动位置」，而开关预览**根本不应该动它**。
   */
  const scrollFreezeRef = useRef<{
    scrollTop: number;
    /** 冻结窗口截止时间（performance.now() 口径） */
    until: number;
    /**
     * v0.14.0 第六批：冻结时刻是否**处于底部**（`scrollTop` 距 `max` 不足 2px）。
     *
     * 为什么需要：实测（`scripts/v0140-probe-toggle-geometry.mjs`）发现真正的漂移机制
     * 不是"联动同步写错"，而是 **iframe 内容在开关过程中被重写**（`doc.open()/write()`），
     * 左栏 `scrollHeight` 随之从 5954 跳到 8833 —— 浏览器把 `scrollTop` 钳/对齐到新高度，
     * 于是"到底"的 7582 变成 7553.333（差 28.67px）。文档在底部时用户的期望是
     * **保持贴底**，所以还原时若原本在底部，应当对齐到**新的 max**，而不是硬写旧像素值。
     */
    atBottom: boolean;
    /**
     * v0.14.0 第七批：非底部时按**视口中央内容锚点**还原（而不是像素）。
     *
     * 缺陷：分屏左栏与全宽左栏的正文列宽不同，长段落软换行数不同；同一像素
     * `scrollTop` 在关闭预览后会落到更靠后的章节（真机实测中央小节偏移
     * 1152px / 3744px，用户看到 3.1 变成 3.3）。冻结窗口内每个布局稳定点
     * 都用这个锚点把"中央那一行文字"拉回视口中央，开/关两态语义一致。
     * 底部场景仍走上方的 `atBottom`（贴底不能被中央锚点破坏）。
     */
    anchor: TextContentAnchor | null;
    /**
     * 我们上一次写入后的**真实** scrollTop 读数（浏览器会取整/钳位，所以不能直接用目标值）。
     * 保留用于诊断与回归断言；用户主动滚动的判据改为**输入事件**（见 restore 的注释）。
     */
    programTop: number;
  } | null>(null);

  /**
   * v0.14.0 第七批：冻结窗口的**上一个** viewMode / previewShown。
   *
   * 冻结只能用于"编辑模式内**单纯**开合预览"；阅读↔编辑切换时 previewShown 也会翻转
   * （编辑默认带预览），若不排除，冻结窗口会把 applyScroll 刚按百分比恢复好的
   * 阅读进度又拉回开合前的 textarea 位置（实测就是用户报的"阅读模式和分屏模式
   * 的阅读进度联动丢失"）。
   */
  const freezePrevViewModeRef = useRef(viewMode);

  const freezePrevShownRef = useRef(previewShown);

  /**
   * v0.14.0 第七批：解冻后按**块锚点映射**把左屏位置主动推给右屏。
   *
   * 为什么不能继续用百分比：实测重开预览后右屏偏差 6px/37px，且章节越深偏差越大
   * （百分比在长文档上与块锚点映射不等价）。这个 ref 由分屏同步 effect 注册，
   * 指向带 force 的 syncToPreview（跳过方向锁，但保留 isSyncing 重入守卫）。
   */
  const syncPreviewAfterToggleRef = useRef<(() => void) | null>(null);

  /**
   * v0.15.3 返修（缺陷 B）：模式切换进编辑后「延时重对齐右屏」的**代际**。
   *
   * 为什么需要：`PREVIEW_REALIGN_DELAYS` 排了 5 个定时器（末点 1600ms）。用户在
   * 1600ms 内再次切模式 / 内容再次变化时，上一批定时器必须**整批作废**，否则会把
   * 新一轮刚对齐好的右屏又按旧左屏位置写一遍（与 v0.15.1 滚动恢复的"代际"同一套路）。
   */
  const previewRealignGenRef = useRef(0);

  /**
   * v0.15.3 返修（缺陷 B）：**"右屏内容刚就绪"事件 → 重对齐** 的入口。
   *
   * 为什么必须由内容侧主动通知，而不是只靠定时器：
   * iframe 的 `doc.open()/write()` → body 就绪 → 贴标 → mermaid/katex 异步渲染
   * 每一步耗时都在**机器负载**下浮动。实机同一台机器两次跑出：
   *   · 480ms 采样时"已贴标 + Δ0.29 行"（定时器晚于贴标，对齐成功）；
   *   · 480ms 采样时"刚重写完、标签还没贴上 → 定时器跳过 → Δ89.81 行"。
   * 固定时点无法赢过这种调度抖动。由 `tagWhenBodyReady` / 增量贴标处
   * `requestPreviewRealignRef.current?.()` 主动推一次，才是确定性的。
   * 该 ref 由分屏同步 effect 注册，指向同一套带**就绪闸门**的重对齐实现。
   */
  const requestPreviewRealignRef = useRef<(() => void) | null>(null);

  /**
   * v0.14.0 第六批：**本帧的 scrollTop 写入是"冻结还原"而非用户滚动**。
   *
   * 用途：`syncToPreview`（左→右）监听 textarea 的 scroll 事件。冻结还原也会派发
   * scroll 事件，若不加标记会被当成用户滚动 → 又把右屏推一次（右屏本来就不该动）。
   * 置位 → 同步 → 立刻清位（同步派发的 scroll 事件是异步的，故不能用同步标志；
   * 这里改用"时间戳 + 还原后跳过下一次 scroll"的方式，见 syncToPreview 的守卫）。
   */
  const isFrozenRestoreRef = useRef(false);

  /** 预览开关过渡总时长（与 editor.css 的 `transition: width 0.42s` 对齐，留一点余量） */
  const PREVIEW_TOGGLE_FREEZE_MS = 620;

  // iframe 初始化状态追踪：首次进入分屏完整加载脚本，后续只更新 body
  const previewIframeInitRef = useRef<{ mermaid: boolean; math: boolean; theme: string }>({
    mermaid: false,
    math: false,
    theme: "",
  });

  // v0.12.1 需求9：分屏预览的增量判据——区分"正文变了"与"只是排版预览变了"。
  // 纯排版变化只需刷新 iframe 的 <style>，不必重排 body（拖滑条时避免每帧重建 DOM）。
  const lastIframeHtmlRef = useRef("");

  const lastIframeTypoKeyRef = useRef("");


  // 追踪是否刚打开右侧预览面板（v0.14.0 需求1：由「切到 split」改为「预览面板展开」）
  useEffect(() => {
    if (previewShown && !prevPreviewShownRef.current) {
      justEnteredSplitRef.current = true;
      // 重新展开预览时重置 iframe 初始化状态，确保首次完整加载
      previewIframeInitRef.current = { mermaid: false, math: false, theme: "" };
    }
    prevPreviewShownRef.current = previewShown;
  }, [previewShown]);


  /**
   * v0.14.0 第六/七批：**预览开合期间冻结左屏滚动位置**（缺陷见 scrollFreezeRef 的注释）。
   *
   * 只在**编辑模式内单纯开合预览**时随 `previewShown` 的边沿生效（关→开、开→关各一次）；
   * 阅读↔编辑切换虽然也会翻转 previewShown，但由下方的 `modeChanged` 闸门排除，
   * 否则会覆盖 applyScroll 刚恢复的阅读进度。
   *
   * 时序：
   *   t0             记录 scrollTop / 是否贴顶贴底 / 视口中央内容锚点，窗口开启
   *   t0 ~ 稳定      联动同步与 RO 锚点补偿都不许改写左屏；每帧按中央锚点还原
   *   布局稳定后     关窗（ResizeObserver 盯 scrollHeight，静默 320ms；上限 4s），
   *                  关窗后再做 5 次幂等裁决校验，并用块锚点映射主动对齐右屏
   */
  useLayoutEffect(() => {
    // v0.14.0 第七批：**只有"编辑模式内单纯开合预览"才冻结**。
    // 阅读↔编辑切换时 previewShown 也会翻转（编辑默认带预览），而那条路径由
    // pendingScrollRef/applyScroll 按百分比恢复阅读进度；若这里再冻结，会把刚恢复好的
    // 进度又拉回开合前的 textarea 位置 → 用户报的"阅读模式和分屏模式进度联动丢失"。
    const modeChanged = viewMode !== freezePrevViewModeRef.current;
    const shownChanged = previewShown !== freezePrevShownRef.current;
    freezePrevViewModeRef.current = viewMode;
    freezePrevShownRef.current = previewShown;
    if (modeChanged || !shownChanged) return;
    if (viewMode !== "edit") return;
    // TODO(v0.18): CM6 能力缺口 — 预览开合时的滚动冻结（记录开合前像素/锚点） — CM6 下不冻结，开合时可能有一次位置跳动
    const textarea = sourceTextareaRef.current;
    if (!textarea) return;
    // 记录开合前的滚动像素与**视口中央内容锚点**。
    // 必须用 layout effect：此时 DOM 已提交、浏览器尚未绘制，宽度过渡还没走第一帧，
    // 读到的 clientWidth/scrollTop 仍是用户眼前的真实状态。
    const frozenTop = textarea.scrollTop;
    const frozenMax = Math.max(0, textarea.scrollHeight - textarea.clientHeight);
    // 是否"在底部"：滚动位置距 max 不足 2px 视为贴底（用户拖动到底时的亚像素误差）
    const atBottom = frozenMax > 0 && frozenTop >= frozenMax - 2;
    // 顶部同理：贴顶时用户期望继续贴顶，中央锚点反而会把文档往下推
    const atTop = frozenTop <= 2;
    // 非底部/顶部才取中央锚点：两端由 atBottom/atTop 单独处理
    const anchor = atBottom || atTop
      ? null
      : captureTextAnchor(textarea, textarea.clientHeight / 2);
    const until = performance.now() + PREVIEW_TOGGLE_FREEZE_MS;
    scrollFreezeRef.current = { scrollTop: frozenTop, until, atBottom, anchor, programTop: frozenTop };
    let cancelled = false;
    /**
     * 用户在冻结窗口内**主动滚动/输入** → 立即放弃本次还原，以用户为准。
     *
     * v0.14.0 第七批修正：旧实现拿"当前 scrollTop 与上次程序写入值差 >1.5px"当判据，
     * 但宽度变化时浏览器会因 scrollHeight 收缩而**自动钳位** scrollTop（不是用户操作），
     * 旧判据会把自动钳位误判成用户滚动而放弃还原 → 中央内容就跳走。
     * 现在只看真实输入事件；布局导致的钳位继续由锚点纠正。
     */
    let abortedByUser = false;
    const abort = () => {
      abortedByUser = true;
      const cur = scrollFreezeRef.current;
      if (cur && cur.until === until) scrollFreezeRef.current = null;
    };
    textarea.addEventListener("wheel", abort, { passive: true });
    textarea.addEventListener("pointerdown", abort, { passive: true });
    textarea.addEventListener("touchstart", abort, { passive: true });
    /**
     * ⚠️ 不能把任意 keydown 都当"用户滚动"：双击 Shift 开关预览时，
     * 第二次 Shift 的 keydown/keyup 可能落在冻结窗口内 → 会把刚刚开始的还原取消掉，
     * 用户就又能看到"关一次跳一次"。只认真正会滚动或改写内容的键。
     */
    const onKeyDown = (e: KeyboardEvent) => {
      const k = e.key;
      if (k === "Shift" || k === "Control" || k === "Alt" || k === "Meta" || k === "CapsLock") return;
      if (
        k === "PageUp" || k === "PageDown" || k === "Home" || k === "End" ||
        k === "ArrowUp" || k === "ArrowDown" || k === " " || k === "Enter" ||
        k === "Backspace" || k === "Delete" || k === "Tab" ||
        (typeof k === "string" && k.length === 1)
      ) {
        abort();
      }
    };
    textarea.addEventListener("keydown", onKeyDown);
    /**
     * 单次还原：只**定位**，**不清窗口**。
     *
     * ⚠️ 第一版实现把 `scrollFreezeRef.current = null` 放在这里 —— 结果是第一次 rAF
     * （约 30ms）就把冻结窗口清掉了，之后 iframe 内容变高（实测 ~470ms）时联动同步
     * 与 RO 补偿照常写入，漂移照旧。**窗口必须由最后的定时器统一关闭**（见下方
     * `finalize`）。
     *
     * 三种口径（实测决定，见 scrollFreezeRef 的字段注释）：
     * - 原来**在底部** → 对齐到**当前新的** `max`（贴底语义，不能离底）；
     * - 非底部且有中央锚点 → 用 `restoreTextAnchor` 把"中央那行文字"拉回中央
     *   （宽度过渡每一帧都调用，长段落重排后仍锁定同一内容）；
     * - 测量不可用 → 退回原像素值（安全兜底）。
     */
    const restore = () => {
      if (cancelled || abortedByUser) return;
      // TODO(v0.18): CM6 能力缺口 — 滚动冻结窗口内的恢复 — CM6 下跳过，同上一项
      const ta = sourceTextareaRef.current;
      if (!ta) return;
      // 确认窗口确实还属于本次（复开关时会被新值覆盖 → 交给最新那次）
      const cur = scrollFreezeRef.current;
      if (!cur || cur.until !== until) return;
      isFrozenRestoreRef.current = true;
      try {
        if (cur.atBottom) {
          const max = Math.max(0, ta.scrollHeight - ta.clientHeight);
          if (Math.abs(ta.scrollTop - max) > 0.5) ta.scrollTop = max;
        } else if (cur.anchor) {
          restoreTextAnchor(ta, cur.anchor);
        } else {
          const max = Math.max(0, ta.scrollHeight - ta.clientHeight);
          const target = Math.min(Math.max(0, cur.scrollTop), max);
          if (Math.abs(ta.scrollTop - target) > 0.5) ta.scrollTop = target;
        }
      } finally {
        isFrozenRestoreRef.current = false;
      }
      // 记录写入后的**真实**读数（浏览器可能钳位/取整），供诊断与测试断言
      cur.programTop = ta.scrollTop;
    };

    /**
     * 收尾：最后再还原一次并**关闭窗口**。整个窗口期间（到此刻为止）
     * `isScrollFrozen()` 一直为真，联动同步与 RO 补偿都不会改写左屏。
     *
     * ⚠️ 关闭时机不能只看固定时长：实测发现 f≈1427ms（比 1320ms 更晚）还有一次
     * iframe 异步渲染（mermaid/katex → 字体/尺寸回填）引起的同步写入，把左屏又带走了
     * 7.33px。所以这里除了固定兜底定时器，还用 **ResizeObserver 盯 `scrollHeight`**：
     * 只要它在变，就把窗口继续往后推（每次 +200ms，上限 PREVIEW_TOGGLE_MAX_MS），
     * 连续 PREVIEW_TOGGLE_SETTLE_MS 没变化才真正关窗。这样"窗口结束"等价于
     * "布局已经稳定"，最后一次还原一定是最后一次写入。
     */
    const finalize = () => {
      if (cancelled) return;
      const frozen = scrollFreezeRef.current;
      const expected = frozen ? frozen.scrollTop : 0;
      const wasAtBottom = frozen ? frozen.atBottom : false;
      const centerAnchor = frozen ? frozen.anchor : null;
      restore();
      const cur = scrollFreezeRef.current;
      if (cur && cur.until === until) scrollFreezeRef.current = null;
      /**
       * v0.14.0 第七批：**解冻后用块锚点映射主动对齐右屏**。
       *
       * 旧实现这里按"左屏像素 / 可滚高度 × 右屏可滚高度"算百分比，实测重开预览后
       * 右屏偏差 6px（3.1 章）/ 37px（7.3 章），章节越深偏差越大；用户必须再滚一下
       * 左屏，右屏才被 scroll 监听纠正。现在直接调用 register 在分屏同步 effect 里的
       * `syncToPreview(force)`：它走同一套 `data-src-line` 块锚点映射，与用户滚动时
       * 完全同源；并在 iframe 异步渲染的若干时间点重试（内容变高后锚点坐标会变）。
       */
      const syncRight = () => {
        if (cancelled || abortedByUser) return;
        try { syncPreviewAfterToggleRef.current?.(); } catch { /* 右屏尚未就绪：下次重试 */ }
      };
      syncRight();
      timerAt(160, syncRight);
      timerAt(480, syncRight);
      timerAt(1000, syncRight);
      // 关窗后的最终裁决：开合流程若还在关窗之后写左屏，这里按**同一内容锚点**拉回
      verifyAfterFinalize(wasAtBottom, centerAnchor, expected, 5);
    };
    const restores: Array<() => void> = [];
    const timerAt = (ms: number, fn: () => void) => {
      const t = setTimeout(fn, ms);
      restores.push(() => clearTimeout(t));
    };

    /**
     * v0.14.0 第六/七批：**关窗后的最终裁决校验**。
     *
     * 实测（`scripts/v0140-probe-open-writer.mjs` 抓调用栈）发现：打开预览时
     * `syncToSource`（右屏→左屏的块锚点映射）会在关窗**之后**再写一次左屏
     * （hook 记为 `7582 → 7553.2`，正是有损映射的 28.67px 缺口）。既然开关预览
     * 不改变左屏内容，左屏位置被开合流程写走就是错的 —— 关窗后再看几眼并拉回。
     *
     * v0.14.0 第七批：非底部不再写"原像素值"，而是**重复应用中央内容锚点**
     * （幂等），这样即使中途发生了宽度重排或同步写入，最终视口中央仍是同一小节。
     *
     * @param atBottom  开合前是否贴底（贴底对齐最新 max）
     * @param anchor    开合前的视口中央内容锚点（非底部时使用）
     * @param expected  原像素值（仅当锚点测量不可用时兜底）
     */
    const verifyAfterFinalize = (
      atBottom: boolean,
      anchor: TextContentAnchor | null,
      expected: number,
      tries = 4,
    ) => {
      if (cancelled || abortedByUser) return;
      // TODO(v0.18): CM6 能力缺口 — 冻结解除后的位置还原 — CM6 下跳过，表现为开合后位置不精确
      const ta = sourceTextareaRef.current;
      if (!ta) return;
      isFrozenRestoreRef.current = true;
      try {
        if (atBottom) {
          const max = Math.max(0, ta.scrollHeight - ta.clientHeight);
          if (Math.abs(ta.scrollTop - max) > 0.5) ta.scrollTop = max;
        } else if (anchor) {
          restoreTextAnchor(ta, anchor);
        } else {
          const max = Math.max(0, ta.scrollHeight - ta.clientHeight);
          const want = Math.min(Math.max(0, expected), max);
          if (Math.abs(ta.scrollTop - want) > 0.5) ta.scrollTop = want;
        }
      } finally {
        isFrozenRestoreRef.current = false;
      }
      if (tries > 1) {
        timerAt(140, () => verifyAfterFinalize(atBottom, anchor, expected, tries - 1));
      }
    };

    // rAF 链：连续 3 帧各还原一次（覆盖内容重写的中间态，窗口保持打开）
    let rafId = 0;
    const rafChain = (n: number) => {
      rafId = requestAnimationFrame(() => {
        restore();
        if (n > 1) rafChain(n - 1);
      });
    };
    rafChain(3);
    restores.push(() => cancelAnimationFrame(rafId));
    // 定时器：覆盖 iframe 异步渲染（mermaid/katex）造成的后续变高
    timerAt(260, restore);
    timerAt(PREVIEW_TOGGLE_FREEZE_MS, restore);
    timerAt(PREVIEW_TOGGLE_FREEZE_MS + 400, restore);

    /**
     * 关窗时机：**等布局真正稳定**，而不是死等一个固定时长。
     *
     * 实测：f≈1427ms 仍有 iframe 异步渲染（mermaid/katex 字体回填）触发的同步写入，
     * 它比固定 1320ms 更晚，于是窗口刚关就被写走 7.33px。
     * 做法：用 ResizeObserver 盯 textarea 的 `scrollHeight`——每次变化就还原一次并把
     * 关窗时间往后推 `PREVIEW_TOGGLE_SETTLE_MS`；连续这么久没变化才真正 finalize。
     * 上限 `PREVIEW_TOGGLE_MAX_MS` 兜底（避免极端情况下窗口长期不关、用户滚动被拖住）。
     */
    const PREVIEW_TOGGLE_SETTLE_MS = 320;
    const PREVIEW_TOGGLE_MAX_MS = 4000;
    let lastScrollHeight = -1;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let ro: ResizeObserver | null = null;
    const armSettle = () => {
      if (cancelled) return;
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        finalize();
        ro?.disconnect();
      }, PREVIEW_TOGGLE_SETTLE_MS);
    };
    const teardown = () => {
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
      ro?.disconnect();
      ro = null;
    };
    restores.push(teardown);
    {
      // TODO(v0.18): CM6 能力缺口 — 几何（CM6 需 coordsAtPos/getMetrics 语义，A3 后能力）
      const ta = sourceTextareaRef.current;
      lastScrollHeight = ta ? ta.scrollHeight : -1;
      if (ta && typeof ResizeObserver !== "undefined") {
        ro = new ResizeObserver(() => {
          const cur = scrollFreezeRef.current;
          if (!cur || cur.until !== until) return;
          const sh = ta.scrollHeight;
          // 只有"内容高度真的变了"才续期（宽度变化只会改 clientWidth，不改内容高度）
          if (Math.abs(sh - lastScrollHeight) < 0.5) return;
          lastScrollHeight = sh;
          restore();
          if (performance.now() - (until - PREVIEW_TOGGLE_FREEZE_MS) > PREVIEW_TOGGLE_MAX_MS) {
            finalize();
            teardown();
            return;
          }
          armSettle();
        });
        ro.observe(ta);
      }
      // 首次等待：固定窗口走完后再给一个"静默期"
      armSettle();
    }
    return () => {
      cancelled = true;
      restores.forEach((f) => f());
      textarea.removeEventListener("wheel", abort);
      textarea.removeEventListener("pointerdown", abort);
      textarea.removeEventListener("touchstart", abort);
      textarea.removeEventListener("keydown", onKeyDown);
      // effect 卸载（再次开关 / 离开编辑模式）：清掉本窗口，避免守卫长期生效
      const cur = scrollFreezeRef.current;
      if (cur && cur.until === until) scrollFreezeRef.current = null;
    };
    // 只在"编辑模式内**单纯**开合预览"时触发：
    // - 依赖 viewMode：阅读↔编辑切换也会让 previewShown 翻转，必须由 modeChanged 排除；
    // - viewMode 变化时上一轮冻结会被 cleanup 清掉，不残留。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewShown, viewMode]);


  // 防抖：首次展开预览立即渲染，编辑时延迟渲染
  // 大文件（>1MB）增加防抖时间到 1000ms，减少渲染开销
  useEffect(() => {
    if (!previewShown) return;
    if (justEnteredSplitRef.current) {
      setDebouncedSourceContent(sourceContent);
      justEnteredSplitRef.current = false;
      return;
    }
    // 根据内容大小动态调整防抖时间
    const debounceMs = sourceContent.length > LARGE_FILE_THRESHOLD ? 1000 : 300;
    const timer = setTimeout(() => setDebouncedSourceContent(sourceContent), debounceMs);
    return () => clearTimeout(timer);
  }, [sourceContent, previewShown]);


  // 右侧预览 HTML（仅预览面板展开时计算，基于防抖内容）
  // Markdown 文件：渲染 markdown + mermaid + 代码高亮
  // 非 Markdown 文件（txt/代码等）：v0.4.0 用 PrismJS 对整个内容语法高亮，不渲染 markdown
  const previewHtml = useMemo(
    () => {
      if (!previewShown) return "";
      if (!isMdFile) {
        // v0.4.0：非 Markdown 文件用 renderCodeFilePreview 生成带语法高亮的 HTML
        // v0.6.6 问题4：unmask 还原 base64（显示层短标记不进预览）
        return renderCodeFilePreview(unmaskBase64Images(debouncedSourceContent, base64TokensRef.current), currentLanguage);
      }
      // v0.6.6 问题4：unmask 还原 base64 后再渲染，短标记会导致预览图裂
      // R1：mermaid 包装与 Prism 高亮已并入 renderMarkdownHtml（管线统一）
      let html = renderMarkdownToHtml(unmaskBase64Images(debouncedSourceContent, base64TokensRef.current));
      // 将相对路径图片 src 转换为 Tauri webview 可访问的 asset:// URL
      html = html.replace(/(<img\s[^>]*src=")([^"]+)(")/g, (_match, prefix: string, src: string, suffix: string) => {
        return `${prefix}${resolveImageSrc(src, filePath)}${suffix}`;
      });
      return html;
    },
    [debouncedSourceContent, previewShown, isMdFile, filePath, currentLanguage]
  );


  /**
   * v0.13.1 需求13（按块定位对齐）：分屏预览所用的**源码文本**。
   *
   * 与 `previewHtml` 同源同表达式，保证"行号表"与"实际渲染出来的 DOM"严格对应。
   * （若两者用了不同的字符串——例如一个 mask 过 base64、一个没有——行号就会整体偏移，
   * 块对齐反而会跳到错误位置。故此处显式抽成一份 memo 复用。）
   * 非 md 文件（代码预览）不参与块对齐：那种预览是整段高亮，没有"块"的概念。
   */
  const previewSourceMarkdown = useMemo(
    () =>
      previewShown && isMdFile
        ? unmaskBase64Images(debouncedSourceContent, base64TokensRef.current)
        : "",
    [previewShown, isMdFile, debouncedSourceContent],
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
      // v0.12.2 P8：分屏右侧 iframe 此前把行高/段间距/内容宽度**硬编码**
      // （line-height:1.8 / max-width:860px / p{margin:.5em 0}），三项排版设置
      // 只作用于阅读区与编辑区 → 分屏右侧不跟随、左右不一致。
      // 现收集这三个变量（由 EditorContainer 写到 :root，与字号同一机制），
      // 供 sharedStyles 用 var() 消费；值为 0 / 空时用兜底保持主题默认观感。
      lineHeight: v("--editor-line-height", "1.8"),
      paragraphSpacing: v("--editor-paragraph-spacing", "1"),
      contentMaxWidth: v("--editor-content-max-width", "860px"),
      // v0.12.0 需求5：文档缩放比例（注入 iframe :root，body 用 var 引用）
      docZoom: v("--doc-zoom", "1"),
      // v0.16.0：缩进单位的 tab 视觉列数（Prism 高亮层的 tab-size 用 var 消费）。
      // iframe 是独立文档，不继承父文档变量 —— 不注入则 getPrismCss() 恒取兜底 2。
      tabSize: v("--lm-tab-size", "2"),
    };
  }, []);


  /**
   * v0.13.1 需求13（按块定位对齐）：给预览文档的**顶层元素**贴上"源码起始行"标签。
   *
   * ## 为什么不改渲染 HTML
   * `renderMarkdownHtml` 同时服务分屏预览、阅读模式与各类导出；往里注入属性会让
   * 导出产物出现无意义的 `data-src-line`（也会破坏"纯管道零 diff"一类的逐字节断言）。
   * 因此这里在 **iframe DOM 层**贴标：`renderMarkdownHtml` 的输出保持逐字节不变。
   *
   * ## 为什么必须数量自校验
   * `topLevelBlockStartLines` 只统计"一个 token 恰好产出一个顶层元素"的块。
   * 本渲染管线 `htmlBlockDisabled: true`（原始 HTML 被转义成段落），实测数量总是相等；
   * 但这条不变量依赖实现细节 —— 一旦开启 html、插件新增无 `map` 的 token，或渲染规则
   * 改成包裹/拆分元素，顺序就会**整体错位**。错位比"退回百分比映射"严重得多
   * （右侧会跳到完全无关的位置），故用一次 O(1) 数量比较把它挡在门外。
   */
  const tagPreviewSourceLines = useCallback(
    (body: HTMLElement, markdownSource: string) => {
      try {
        const children = Array.from(body.children) as HTMLElement[];
        // 先清掉上一次的标签（增量更新复用同一个 body 时可能残留）
        for (const el of children) {
          if (el.dataset.srcLine !== undefined) delete el.dataset.srcLine;
        }
        // v0.14.0 需求4：数量自校验的**右侧基数**必须是"正文内容元素"。
        // 旧实现直接数 body.children —— 而分屏 iframe 的 HTML 会把 mermaid / katex
        // 的 `<script>` 写在 </body> 前，mermaid 还会挂 `div.mermaidTooltip` 工具层，
        // 于是"块数 ≠ 子元素数" → shouldTagPreview 判假 → **整份文档放弃贴标**，
        // 实测含 mermaid 的文档 `[data-src-line]` 数量为 0，只能退回百分比映射
        // （正是用户反馈的"含图表时左右篇幅/滚动对不上"）。
        // 过滤掉非内容标签后，顺序与 markdown-it 顶层块仍然一一对应，
        // 因此贴标时用的是**过滤后**的同一个数组（下标 i 必须与 lines[i] 对齐）。
        const contentEls = children.filter((el) =>
          isAnchorablePreviewChild(el.tagName, el.className),
        );
        const lines = topLevelBlockStartLines(markdownSource);
        if (!shouldTagPreview(lines.length, contentEls.length)) return false;
        contentEls.forEach((el, i) => {
          el.dataset.srcLine = String(lines[i]);
        });
        return true;
      } catch {
        // 标签只是"锦上添花"：任何异常都必须静默退回百分比映射，不影响预览
        return false;
      }
    },
    [],
  );


  /**
   * v0.15.0 需求（阅读区标题折叠）：右侧预览（iframe）的折叠桥。
   *
   * PM 阅读面由插件走 Decoration；iframe 是独立 document、不在 PM 里，
   * 只能 DOM 注入。两个面共享同一份折叠状态（`readingFold`），键用 headingId。
   *
   * `isActive` 只有「编辑模式 + 预览显示 + md 文件」为真——代码文件预览不做标题折叠
   * （它们没有 Markdown 标题语义）。
   */
  const foldBridge = useMemo(
    () =>
      createIframeFoldBridge({
        getIframeDocument: () => previewIframeRef.current?.contentDocument ?? null,
        isActive: () => previewShown && isMdFile,
      }),
    [previewShown, isMdFile],
  );

  /** 折叠状态变化 → 重新应用到 iframe（PM 面由插件自行响应） */
  useEffect(() => readingFold.subscribe(() => foldBridge.apply()), [foldBridge]);


  useEffect(() => {
    if (!previewShown) return;
    const iframe = previewIframeRef.current;
    if (!iframe) return;
    const doc = iframe.contentDocument;
    if (!doc) return;
    // v0.9.5 问题5：空内容（空临时文件）时清空预览残留——iframe 常驻不卸载、
    // 也不随文件切换重建，previewHtml 为空时若直接 return，
    // body 保留的是上一个文档最后写入的 HTML
    if (!previewHtml) {
      if (doc.body) doc.body.innerHTML = "";
      return;
    }
    const cv = collectCssVars();
    // 判断是否包含 mermaid 图表
    const hasMermaid = previewHtml.includes('class="mermaid"');
    // 判断是否包含数学公式
    const hasMath = previewHtml.includes('data-math="inline"') || previewHtml.includes('data-math="block"');

    // 判断是否需要完整重写（首次进入、或脚本需求变化时）
    const init = previewIframeInitRef.current;
    // v0.11.0 B4-3/B4-4：主题明暗判定走单源（night 也是暗色），
    // 并作为 needFullRewrite 的判据之一 —— 主题变化需重写以更新脚本里的
    // mermaid 主题参数（增量分支已另加 initialize 重载，双保险）。
    const mermaidTheme = mermaidThemeName(theme);
    const themeChanged = init.theme !== theme;
    const needFullRewrite = !init.mermaid && !init.math
      || (hasMermaid && !init.mermaid)
      || (hasMath && !init.math)
      || themeChanged;

    // v0.12.1 需求9：区分"正文变了"与"只是排版预览变了"（见两个 ref 的注释）
    const htmlChanged = lastIframeHtmlRef.current !== previewHtml;
    lastIframeHtmlRef.current = previewHtml;
    const typoChanged = lastIframeTypoKeyRef.current !== typographyPreviewKey;
    lastIframeTypoKeyRef.current = typographyPreviewKey;

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
        /* v0.12.0 需求5：文档缩放比例（body zoom 引用，增量更新时由 setProperty 刷新） */
        --doc-zoom: ${cv.docZoom};
        /* v0.12.3（二轮反馈）：**三项排版必须注入 iframe 自己的 :root**。
           iframe 是独立文档，**不继承父文档的 CSS 变量** —— 此前 body/p 写的是
           var(--editor-line-height, 1.8) 等，变量在 iframe 内从未定义，于是恒取兜底值：
           在设置里拖「行高 / 段间距 / 内容区宽度」，分屏右侧预览纹丝不动（v0.12.2 P8
           以为"消费 var() 即跟随"，实际漏了注入这一步）。此处把父文档实测值写好。 */
        --editor-line-height: ${cv.lineHeight};
        --editor-paragraph-spacing: ${cv.paragraphSpacing};
        --editor-content-max-width: ${cv.contentMaxWidth};
        /* v0.16.0：tab 视觉列数（getPrismCss() 的 tab-size 用 var 消费）。
           与上面三项同理 —— iframe 不继承父文档变量，必须显式注入。 */
        --lm-tab-size: ${cv.tabSize};
      }
      body {
        margin: 0; padding: 40px 60px; max-width: var(--editor-content-max-width, 860px); margin: 0 auto;
        background: ${cv.bgPrimary}; color: ${cv.textPrimary};
        font-size: ${cv.fontSize}; font-family: ${cv.fontFamily};
        line-height: var(--editor-line-height, 1.8); word-break: break-word;
        zoom: var(--doc-zoom, 1);
      }
      h1,h2,h3,h4,h5,h6 { color: ${cv.headingColor}; margin: 1.2em 0 0.6em; line-height: 1.3; }
      h1 { font-size: 2em; } h2 { font-size: 1.5em; } h3 { font-size: 1.25em; } h4 { font-size: 1.1em; }
      p { margin: calc(0.8em * var(--editor-paragraph-spacing, 1)) 0; }
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
      li.task-item { display: flex; align-items: flex-start; gap: 6px; margin: 0.3em 0; list-style: none; position: relative; }
      /* v0.12.1 需求4：首段上边距归零，让复选框按"首行盒高"精确居中（与阅读模式同款口径） */
      li.task-item > .task-content > p:first-child { margin-top: 0; }
      .task-item input[type="checkbox"] {
        appearance: none; -webkit-appearance: none; flex-shrink: 0;
        width: 15px; height: 15px; margin: 0; font: inherit;
        margin-top: calc((1.8 * 1em - 15px) / 2);
        border: 1.5px solid ${cv.borderColor}; border-radius: 3px;
        background: ${cv.bgPrimary}; position: relative;
      }
      /* v0.12.1 需求5：圆形样式（源码写作星号 bullet 的任务项） */
      li.task-item-circle input[type="checkbox"] { border-radius: 50%; }
      .task-item input[type="checkbox"]:checked { background: ${cv.accentColor}; border-color: ${cv.accentColor}; }
      .task-item input[type="checkbox"]:checked::after {
        content: ""; position: absolute; left: 4px; top: 1px; width: 4px; height: 7px;
        border: solid #fff; border-width: 0 1.8px 1.8px 0; transform: rotate(42deg);
      }
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
      const prismCss = getPrismCss(isDarkTheme(theme));
      doc.open();
      // v0.9.5 问题3：链接点击桥接——iframe 内相对路径/外部链接点击 postMessage 回主文档。
      // 锚点(#开头)不拦截,交给 iframe 原生 hash 导航滚动(渲染层已生成标题 id)
      doc.write(`<!DOCTYPE html><html><head><style>${sharedStyles}${prismCss}</style>
      <script>
        (function() {
          document.addEventListener('click', function(e) {
            var t = e.target;
            var a = t && t.closest ? t.closest('a[href]') : null;
            if (!a) return;
            var href = a.getAttribute('href') || '';
            if (!href || href.charAt(0) === '#') return;
            e.preventDefault();
            parent.postMessage({ type: 'lightmd-preview-link', href: href }, '*');
          }, true);
        })();
      <\/script>
      ${hasMermaid ? '<script src="/vendor/mermaid/mermaid.min.js"></script>' : ''}
      ${hasMath ? '<link rel="stylesheet" href="/vendor/katex/katex.min.css">' : ''}
      ${hasMath ? '<script src="/vendor/katex/katex.min.js"></script>' : ''}
      </head><body>${previewHtml}
      ${hasMermaid ? `<script>
        mermaid.initialize({ startOnLoad: true, theme: ${isDarkTheme(theme) ? "'dark'" : "'default'"}, securityLevel: 'strict' });
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
      // v0.13.1 需求13：贴"源码起始行"标签，供左→右按块对齐滚动使用
      // v0.14.0 需求4（实测修正）：`doc.close()` 返回时 `doc.body` **可能还是 null** ——
      // 整篇重写注入的 `<head>` 里有非 async 的 mermaid/katex 脚本，解析器会停在那里
      // 等脚本，`<body>` 尚未解析。旧代码直接 `doc.body.children` 会抛 TypeError，
      // 被 catch 静默吞掉 → **含 mermaid 的文档一个 data-src-line 都贴不上**
      // （实测 `[data-src-line]` 数量为 0，只能退回百分比映射，这正是"含图表文档
      //  左右滚动对不齐"的直接原因）。
      // 现在等到 body 真的就绪再贴；三种触发都留着（同步/load/rAF/兜底定时器），
      // 贴标本身幂等（先清旧标签再贴），重复调用无副作用。
      const tagWhenBodyReady = () => {
        const b = doc.body;
        if (b) {
          tagPreviewSourceLines(b, previewSourceMarkdown);
          // v0.15.0 需求（图片灯箱）：右侧预览是独立 document，PM 插件管不到；
          // 每次整篇重写都会清空该 document 上的监听器，故在 body 就绪后幂等重绑。
          bindPreviewLightbox(iframe);
          // v0.15.0 需求（阅读区标题折叠）：iframe 面折叠状态幂等重应用
          foldBridge.apply();
          // v0.15.3 返修（缺陷 B）：**贴标完成就是"右屏可以对齐了"的信号**。
          // 固定延时时点（0/160/480/1000/1600ms）在实机上有时早于贴标、有时晚于
          // 异步渲染撑高，存在竞态（实测同一台机器两次跑出 Δ89.81 / Δ0.29 两种结果）。
          // 由内容就绪这一刻主动触发一次对齐，才不受调度抖动影响。
          requestPreviewRealignRef.current?.();
        }
      };
      if (doc.body) {
        tagWhenBodyReady();
      } else {
        try {
          doc.defaultView?.addEventListener("load", tagWhenBodyReady, { once: true });
        } catch { /* 跨源/已卸载：忽略，后面还有 rAF 与定时器兜底 */ }
        requestAnimationFrame(tagWhenBodyReady);
        setTimeout(tagWhenBodyReady, 120);
      }
      // 记录已加载的脚本状态与主题（供下次增量更新比对是否需重写）
      previewIframeInitRef.current = { mermaid: hasMermaid, math: hasMath, theme };
    } else if (typoChanged && !htmlChanged) {
      // v0.12.1 需求9：**纯排版预览**（设置里拖字号/行高滑条）——只换 iframe 的样式表。
      // 正文未变，重排 body 既浪费又会打断 mermaid/katex 渲染，故这里只刷新 head 里的
      // <style>（首次完整写入时注入的元素）+ --doc-zoom，正文 DOM 原样保留。
      //
      // v0.12.1 需求9（二轮）：分屏右侧预览同样要**保持阅读焦点** ——
      // 换样式表前后按块锚点补偿 iframe 自己的 scrollTop（量 rect 会强制同步布局，
      // 因此写样式后立刻测量拿到的就是新排版）。
      const scroller = (doc.scrollingElement ?? doc.documentElement) as Element | null;
      const anchor = scroller ? captureAnchor(scroller, "body > *") : null;
      const styleEl = doc.querySelector("style");
      if (styleEl) styleEl.textContent = sharedStyles + getPrismCss(isDarkTheme(theme));
      doc.documentElement.style.setProperty("--doc-zoom", cv.docZoom);
      if (scroller) restoreAnchor(scroller, anchor);
      return;
    } else {
      // 增量更新：只替换 body 内容，不重新加载脚本
      // 替换 body 内容（样式通过 :root 变量自动更新）
      // v0.12.0 需求5：缩放变化也走增量分支 —— 刷新 :root 的 --doc-zoom（body zoom 引用它）
      doc.documentElement.style.setProperty("--doc-zoom", cv.docZoom);
      // v0.12.3（二轮反馈）：正文与排版**同时**变化时也要刷新样式表，否则 <style> 里注入的
      // 排版变量（行高 / 段间距 / 内容宽度）会停留在旧值，右侧预览不跟随。
      if (typoChanged) {
        const styleEl = doc.querySelector("style");
        if (styleEl) styleEl.textContent = sharedStyles + getPrismCss(isDarkTheme(theme));
      }
      doc.body.innerHTML = previewHtml;
      // v0.13.1 需求13：增量更新同样要重贴标签（元素被整批替换）
      tagPreviewSourceLines(doc.body, previewSourceMarkdown);
      // v0.15.0 需求（图片灯箱）：body 被整批替换 → 旧 body 的监听器已随节点丢弃，需重绑
      bindPreviewLightbox(iframe);
      // v0.15.0 需求（阅读区标题折叠）：body 整批替换后折叠状态要重新应用
      foldBridge.apply();
      // v0.15.3 返修（缺陷 B）：增量路径同样在**贴标完成时**主动对齐一次（见整篇分支的注释）
      requestPreviewRealignRef.current?.();
      // 重新触发 mermaid 渲染（脚本已加载，直接调用 run）
      if (hasMermaid && (doc as any).defaultView?.mermaid) {
        try {
          // v0.11.0 B4-4：**主题变化时必须先重新 initialize 再 run**。
          // 缺陷背景（P1）：原实现只调 mermaid.run，而 mermaid 的主题在
          // initialize 时确定 → 切换主题后图表配色滞后（仍用旧主题的 SVG）。
          // 判据用 previewIframeInitRef.theme（上次写入的主题）。
          if (init.theme !== mermaidTheme) {
            (doc as any).defaultView.mermaid.initialize({
              startOnLoad: false,
              theme: mermaidTheme,
            });
          }
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
  }, [previewHtml, viewMode, theme, collectCssVars, docZoom, typographyPreviewKey, previewSourceMarkdown, tagPreviewSourceLines]);


  // v0.12.0 需求4：分屏 iframe 尺寸变化时保持预览焦点。
  // iframe 的 contentDocument 有独立滚动盒，不在主文档 ResizeObserver 的观察范围内：
  // ① 对 iframe 元素本身观察（宽度变化会传导，含拖分割条/侧栏折叠）；
  // ② 滚动监听挂在 contentWindow 上（doc.open() 重写文档后 window 对象仍稳定，
  //    而 scroller 元素会被替换 —— 每次捕获/恢复时动态获取 scrollingElement）。
  useEffect(() => {
    if (!previewShown) return;
    const iframe = previewIframeRef.current;
    if (!iframe || typeof ResizeObserver === "undefined") return;

    const getScroller = (): Element | null => {
      const doc = iframe.contentDocument;
      return (doc?.scrollingElement ?? doc?.documentElement) ?? null;
    };
    const capture = (): ViewportAnchor | null => {
      const s = getScroller();
      return s ? captureAnchor(s, "body > *") : null;
    };
    let anchor: ViewportAnchor | null = capture();
    let lastWidth = iframe.clientWidth;

    const win = iframe.contentWindow;
    const onScroll = () => { anchor = capture(); };
    win?.addEventListener("scroll", onScroll, { passive: true });

    const ro = new ResizeObserver(() => {
      const w = iframe.clientWidth;
      const widthChanged = w !== lastWidth;
      lastWidth = w;
      const suppressed = performance.now() < anchorSuppressUntilRef.current;
      requestAnimationFrame(() => {
        const s = getScroller();
        if (!s) return;
        // v0.12.0 返修（问题2/4）：仅宽度变化时补偿，且避开主动恢复窗口
        if (!suppressed && widthChanged) restoreAnchor(s, anchor);
        anchor = capture();
      });
    });
    ro.observe(iframe);

    return () => {
      ro.disconnect();
      win?.removeEventListener("scroll", onScroll);
    };
  }, [viewMode]);


  // ─── 分屏模式：**双向映射**滚动联动（v0.13.2 需求8）──────────────
  //
  // 用户最新要求：「左右屏滚动要跟着联动，但左右屏不是共用滚动条，而是映射关系。
  // 因为左屏的文档长度会比右屏渲染的文档长度小，如果共用滚动条就导致左右看到的
  // 内容不一致或有偏差，所以你要实现这个左右两屏能联动滚动，但左右两屏看到的
  // 内容尽量能对齐。」
  //
  // 与 v0.13.1（仅左 → 右）的差别：**恢复双向**，但两边都不再用"共用百分比"，
  // 而是走**块锚点映射**（`utils/blockScrollAlign.ts`）：
  //   · 左 → 右：源码行 → 所属顶层块 → 该块在右侧的块内比例位置；
  //   · 右 → 左：右侧视口顶 → 所属顶层块 → 块内比例 → 反算源码行 → textarea scrollTop。
  // 由于两侧都锚在**同一个块的同一相对位置**，块高差异再大也能对齐。
  //
  // 防拉扯（v0.13.2 返修的核心）：浏览器对 `el.scrollTop = x` 派发的 scroll 事件是
  // **异步**的（下一帧），同步执行期置位的 `isSyncingScrollRef` 到那时早已被清除，
  // 于是被同步的一侧会把滚动再反推回来 —— 两屏互相拉扯、最终停在随机位置（实测还会
  // 把左屏 scrollTop 写成 0）。现在改用 `utils/splitScrollSync` 的**时间窗方向锁**：
  // 哪一侧先发起滚动，谁在窗口期内拥有同步权，另一侧的 scroll 事件一律按回声忽略。
  useEffect(() => {
    if (!previewShown) return;
    /**
     * v0.17.0 A3 收尾（**B 类·升级自 A 类，已修**）：分屏双向联动的左屏一侧。
     *
     * 原判 A 类（"左屏不驱动右屏，右屏仍可单向"）被 Lead 打回，理由是硬事实：
     * **编辑时用户的手在源码侧（左屏）**，"右屏滚动能带动左屏"这个单向能力在实践中
     * 几乎用不到 → **"单向联动"约等于"联动失效"**，是主用例坏掉，不是精度降级。
     *
     * 修法：左屏滚动来源改经 `sourceSurface.onDidScroll`（CM6 绑 `view.scrollDOM`，
     * textarea 绑元素），**方向锁 `createScrollDirectionLock` 原样保留**。
     */
    const iframe = previewIframeRef.current;
    if (!iframe) return;
    const previewWin = iframe.contentWindow;
    if (!previewWin) return;
    const textarea = sourceTextareaRef.current;

    const lock = createScrollDirectionLock();

    /**
     * 取右侧当前滚动容器。
     *
     * **每次现取**：完整重写预览（`doc.open()/write()`，例如首次进入分屏、主题切换、
     * 首次出现 mermaid）会换掉 documentElement —— 缓存下来的旧引用写 scrollTop 是
     * 写到一个已脱离文档的节点上，right→left / left→right 会"看起来完全没反应"。
     */
    const getPreviewScroller = (): HTMLElement | null => {
      const d = iframe.contentDocument;
      return ((d?.scrollingElement ?? d?.documentElement ?? d?.body) as HTMLElement | null) ?? null;
    };

    /**
     * 采集右侧锚点集合（每次同步时现算，块高会被 mermaid/katex 异步改变）。
     *
     * 用 `getBoundingClientRect().top - previewRectTop + scrollTop` 换算到内容坐标：
     * `scrollTop` 与块高都必须是同一个坐标系，否则对齐会整体偏移。
     */
    const collectAnchors = (): PreviewAnchorSet | null => {
      const preview = getPreviewScroller();
      if (!preview) return null;
      const tagged = preview.querySelectorAll<HTMLElement>("[data-src-line]");
      if (tagged.length === 0) return null;
      const lines: number[] = [];
      const tops: number[] = [];
      const heights: number[] = [];
      // ⚠️ v0.13.2 返修：**不要**减 `documentElement.getBoundingClientRect().top`。
      // 根元素自身的矩形 top 就等于 `-scrollTop`（它随滚动整体上移），
      // 旧写法 `rect.top - previewRectTop + scrollTop` 实际算成了
      // `rect.top + 2 * scrollTop` —— 越往下滚锚点坐标越虚高，右侧直接顶到底、
      // 反算回左屏又变成 0（用户看到"完全不联动 / 乱跳"）。
      // 元素 rect 本来就是**相对 iframe 视口**的坐标，加上 scrollTop 即内容坐标。
      for (const el of tagged) {
        const line = Number(el.dataset.srcLine);
        if (!Number.isFinite(line)) return null;
        const rect = el.getBoundingClientRect();
        lines.push(line);
        tops.push(rect.top + preview.scrollTop);
        heights.push(rect.height);
      }
      // v0.14.0 需求4：把**源码总行数**交给纯函数层 → 它据此追加"末尾锚点"
      // 没有这一项时，源码尾部那堆被 markdown 渲染吞掉的空行无法映射，
      // 右屏会停在最后一个块上，于是"右屏到底了左屏还要滚很长"（用户报的主症状）。
      // 传 0/缺省时纯函数层保持 v0.13.x 行为。
      //
      // ⚠️ v0.14.0 需求4（实测修正 B）：`maxScrollLine` 必须是"滚到最底时**视口顶**
      // 所在的行"，而不是最后一行 —— 滚到底时最后一行只出现在视口**下半部**。
      // 实测（真机）：文档① maxScroll 6489 → 视口顶在第 223.79 行（全篇 266 行）；
      // 旧实现把末尾锚点当作"最后一行 ↔ 右屏 max"，于是左屏到底只映射到右屏 98.6%
      // （差 26px）。改用 maxScrollLine 后两方向都精确 100%。
      return {
        lines,
        tops,
        heights,
        totalHeight: preview.scrollHeight,
        totalSourceLines: totalSourceLines(),
        maxScrollLine: lineAtMaxScroll(getSourceLineAxis(), maxSourceScroll()) ?? undefined,
      };
    };

    /** 左屏可滚动上限（末尾锚点要用它算"滚到底时视口顶所在行"）— A3：经 surface metrics */
    const maxSourceScroll = (): number => {
      const m = sourceSurface.getMetrics();
      return Math.max(0, m.scrollHeight - m.clientHeight);
    };

    // v0.14.0 需求4：用**函数声明**（而非 const 箭头函数）以靠提升免疫 TDZ ——
    // 上面的 collectAnchors 会调用它，若哪天有人在它定义之前调用 collectAnchors，
    // const 版本会抛 ReferenceError，函数声明不会。
    function totalSourceLines(): number {
      return previewSourceMarkdown === "" ? 0 : previewSourceMarkdown.split("\n").length;
    }

    /**
     * v0.14.0 需求4：左屏的**实测按行轴**（软换行感知）。
     *
     * ## 为什么必须有
     * `estimateTopSourceLine` 原先假设"textarea 每行等高、行号与滚动线性"。
     * 但 `.source-editor` 是 `white-space: pre-wrap` —— 长行会**软换行**，
     * 视觉行数 ≠ 逻辑行数（按 `\n` 数）。于是线性公式在长行文档上系统性偏后，
     * 实测偏差可达 10 个块，表现为"左右看到的内容对不上"。
     * 改为实测每个顶层块起始行的真实 Y（mirror div，见 utils/blockScrollAlign），
     * 再按行补全成密集轴 → 段内线性插值即软换行感知。
     *
     * ## 为什么必须缓存
     * 实测要创建 mirror div 并逐块测量（强制布局）。滚动是每帧回调，
     * 每次滚动都测会直接拖垮滚动性能。因此按
     * 「文本长度 + textarea 布局宽高 + scrollHeight」做键缓存：内容变（effect 重跑）
     * 或拖分割条/开关预览导致宽度变，才重测一次。
     *
     * ⚠️ `scrollHeight` 必须在键里（v0.14.0 需求4 复查抓到的真 bug）：
     * 轴依赖字号 / 行高 / 字族 / `--doc-zoom`，这四项都能在设置里**运行时**改。
     * 改完软换行位置全变、`scrollHeight` 变，但 `previewSourceMarkdown.length` 与
     * `clientWidth/clientHeight` **都不变**（textarea 是 flex:1，高度由容器决定）→
     * 只按前三项做键会命中旧缓存，用**旧字号量出来的轴**去映射，偏差反而更大。
     * 而 `measureSourceLineAxis` 内部本就用 `scrollHeight - clientHeight` 做归一化上限，
     * 所以 scrollHeight 变了轴必然该重算 —— 语义上也最贴切。
     *
     * 测量失败（隐藏 / 空文本 / 超大文档 / 无有效点）返回 null →
     * `estimateTopSourceLine` 自动退回旧的线性公式，行为与 v0.13.x 一致。
     */
    let axisCache: { key: string; axis: number[] | null } | null = null;
    const getSourceLineAxis = (): number[] | null => {
      const total = totalSourceLines();
      if (total <= 1) return null;
      // 键：内容长度 + 布局宽高（拖分割条）+ scrollHeight（字号/行高/字族/zoom/内容变化）
      /**
       * 缓存键继续含 **内容长度 + 布局宽高 + scrollHeight**（语义地图 §4-27d，不能丢）：
       * 拖分割条改宽、改字号/行高、内容变化都会让行轴失效。
       * A3 起宽高改从 `sourceSurface.getMetrics()` 取（CM6 下是 scrollDOM 的值）。
       */
      const metrics = sourceSurface.getMetrics();
      const key = `${previewSourceMarkdown.length}|${metrics.clientWidth}|${metrics.clientHeight}|${metrics.scrollHeight}`;
      if (axisCache && axisCache.key === key) return axisCache.axis;
      let axis: number[] | null = null;
      try {
        /**
         * A3：走统一入口 `measureLineAxis`（textarea 源用 mirror；CM6 源用 lineBlockAt 估算，
         * 见 sourceLineAxis.ts 的 R2 处置）。**纯函数层 buildSourceLineAxis 一行未改。**
         */
        const source = textarea ? textareaMeasureSource(textarea) : surfaceMeasureSource(sourceSurface);
        const measured = measureLineAxis(source, topLevelBlockStartLines(previewSourceMarkdown));
        // 长度必须与"当前逻辑行数"严格一致，否则是过期测量（内容刚变、DOM 未更新）→ 丢弃
        if (measured && measured.totalLines === total) axis = measured.axis;
      } catch {
        axis = null;
      }
      axisCache = { key, axis };
      return axis;
    };

    /** 左屏视口顶对应的源码行（浮点） */
    const currentTopSourceLine = (): number => {
      const m = sourceSurface.getMetrics();
      return estimateTopSourceLine({
        scrollTop: sourceSurface.getScrollTop(),
        scrollHeight: m.scrollHeight,
        clientHeight: m.clientHeight,
        totalSourceLines: totalSourceLines(),
        // v0.14.0 需求4：软换行感知（null 时纯函数层自动退回线性公式）
        lineTops: getSourceLineAxis() ?? undefined,
      });
    };

    /**
     * v0.14.0 第六批：当前是否处于「预览开关滚动冻结窗口」内。
     * 见 scrollFreezeRef 的注释（用户实测的反复开合累积上漂缺陷）。
     *
     * ⚠️ 这里**不按时间戳自行过期**：窗口的关闭时机必须由冻结 effect 的 `finalize`
     * 统一决定（它还会先做最后一次还原）。第一版按 `until` 判过期，导致
     * `until`（620ms）与 finalize（1320ms）不一致 → 620ms 后守卫静默失效，
     * iframe 后续变高的写入又漏了进来。
     */
    const isScrollFrozen = (): boolean => scrollFreezeRef.current !== null;

    /**
     * 左 → 右：源码行映射到预览 scrollTop。
     *
     * 回退链：块锚点映射 → 百分比映射 → 无（测量不到就放弃，不写坏滚动位置）。
     */
    const syncToPreview = (force = false) => {
      // v0.14.0 第六批：冻结窗口内不把左屏位置推给右屏。
      // 两道原因：① 开关预览不该动任何一侧的阅读位置；② 冻结还原写 scrollTop
      // 会派发 scroll 事件，若不拦会被误当"用户滚动"而把右屏推走（右屏本来也没该动）。
      if (isScrollFrozen() || isFrozenRestoreRef.current) return;
      if (!force) {
        const now = performance.now();
        if (!shouldAcceptScroll(lock, "source", now)) return;
        markScrollSource(lock, "source", now);
      }
      const preview = getPreviewScroller();
      if (!preview) return;
      if (isSyncingScrollRef.current) return;
      isSyncingScrollRef.current = true;
      try {
        let handled = false;
        try {
          const anchors = collectAnchors();
          if (anchors) {
            const next = mapSourceLineToPreviewScroll(
              anchors,
              currentTopSourceLine(),
              preview.clientHeight,
            );
            if (next !== null && Number.isFinite(next)) {
              preview.scrollTop = next;
              handled = true;
            }
          }
        } catch {
          handled = false;
        }
        if (!handled) {
          const m2 = sourceSurface.getMetrics();
          preview.scrollTop = computeSyncScrollTop(
            sourceSurface.getScrollTop(), m2.scrollHeight, m2.clientHeight,
            preview.scrollHeight, preview.clientHeight,
          );
        }
      } finally {
        isSyncingScrollRef.current = false;
      }
    };

    /**
     * v0.14.0 第七批：给冻结窗口注册"解冻后用块锚点主动对齐右屏"的入口。
     * force=true 跳过方向锁（这是程序主动对齐，不是用户滚动），但仍受
     * isScrollFrozen/isSyncing 守卫约束。
     */
    const syncPreviewAfterToggle = () => syncToPreview(true);
    syncPreviewAfterToggleRef.current = syncPreviewAfterToggle;

    /** 右 → 左：预览 scrollTop 反算源码行，再换算成 textarea scrollTop。 */
    const syncToSource = () => {
      // v0.14.0 第六批：**预览开关过渡期间不许改左屏滚动位置**。
      //
      // 缺陷（用户实测）：文档在底部时反复双击 Shift 开合预览，左屏每轮上漂 ~28.67px。
      // 根因：宽度过渡 + iframe 内容重写会派发右屏 scroll 事件 → 本函数把右屏位置
      // 反算成源码行再写回左屏；而左右映射是**有损往返**（底部 → 底部少 28.67px），
      // 累积起来就是持续上漂。
      // 关键事实：开关预览**不改变** textarea 的 scrollHeight（实测两态都是 8833），
      // 内容与可滚动空间都没变 → 左屏本来就不该被写。
      if (isScrollFrozen()) return;
      const now = performance.now();
      if (!shouldAcceptScroll(lock, "preview", now)) return;
      markScrollSource(lock, "preview", now);
      const preview = getPreviewScroller();
      if (!preview) return;
      if (isSyncingScrollRef.current) return;
      isSyncingScrollRef.current = true;
      try {
        const anchors = collectAnchors();
        let line: number | null = null;
        // v0.14.0 需求4：**必须传 preview.clientHeight**，否则纯函数层拿不到可滚动上限，
        // 无法生成"末尾锚点"，右屏滚到底时反算不出最后一行 → 左屏到底后还剩一截
        // （用户报的"右屏到底了左屏还要滚很长"的反向症状）。
        if (anchors) line = mapPreviewScrollToSourceLine(anchors, preview.scrollTop, preview.clientHeight);
        if (line === null) {
          const m3 = sourceSurface.getMetrics();
          const pct = computeSyncScrollTop(
            preview.scrollTop, preview.scrollHeight, preview.clientHeight,
            m3.scrollHeight, m3.clientHeight,
          );
          const max = Math.max(0, m3.scrollHeight - m3.clientHeight);
          sourceSurface.setScrollTop(Math.min(Math.max(0, pct), max));
        } else {
          const m4 = sourceSurface.getMetrics();
          const top = mapSourceLineToScrollTop(
            {
              scrollTop: sourceSurface.getScrollTop(),
              scrollHeight: m4.scrollHeight,
              clientHeight: m4.clientHeight,
              totalSourceLines: totalSourceLines(),
              // v0.14.0 需求4：与左→右用**同一根**实测轴，保证两向往返互逆
              lineTops: getSourceLineAxis() ?? undefined,
            },
            line,
          );
          if (top !== null) sourceSurface.setScrollTop(top);
        }
      } catch {
        /* 测量异常：放弃本次同步（不写坏滚动位置） */
      } finally {
        isSyncingScrollRef.current = false;
      }
    };

    // ⚠️ 必须包一层：`syncToPreview` 现在有 force 参数，直接把函数当事件监听器
    // 会被传入 Event 对象（truthy）→ 每次都跳过方向锁。
    /**
     * 左屏滚动订阅：经 `sourceSurface.onDidScroll`（A3）。
     * 两个实现都提供该能力，因此 CM6 下分屏联动同样生效。
     */
    const offSourceScroll = sourceSurface.onDidScroll(() => syncToPreview());
    // 右屏滚动：window 上接一份（iframe 文档滚动会在 contentWindow 派发），
    // 再在 contentDocument 上接一份捕获阶段兜底（部分 WebView2 版本只在 document
    // 层派发；捕获阶段对不冒泡的 scroll 同样有效）。
    previewWin.addEventListener("scroll", syncToSource, { passive: true });
    const previewDocNow = iframe.contentDocument;
    previewDocNow?.addEventListener("scroll", syncToSource, { capture: true, passive: true });

    // ─── 内容重渲染后**主动重同步一次** ──────────────
    // 右屏正文被防抖替换后只保留像素 scrollTop，而块高（mermaid/katex 异步渲染）
    // 变了 → 同一像素对应到别的内容。本 effect 依赖 previewHtml，每次内容更新都重跑，
    // 在绑定监听后立刻按左屏位置重算一次；再补一帧覆盖异步渲染。
    syncToPreview();
    const raf = requestAnimationFrame(() => {
      syncToPreview();
    });

    /**
     * ─── v0.15.3 返修（缺陷 B）：模式切换进编辑后，**延时重对齐右屏** ───
     *
     * ## 缺陷（实机取证，打包产物 v0.15.2，`scripts/v0153-probe-align-async.mjs`）
     * 从阅读模式双击 Ctrl 进编辑模式时，右侧 iframe 此刻**还没就绪**：
     * 实测含 mermaid 的文档 ——
     *   · t=0ms：`[data-src-line]` 贴标 **0 个**、右屏 `scrollHeight=0` → 无从对齐；
     *   · t=480ms：贴标 78 个、右屏 `scrollHeight=7868`、mermaid SVG 5 个；
     *   · 稳定后左右仍差 **5.1 个源码行**；用户手动滚一下左屏立刻降到 **0.09 行**。
     * 结论：块锚点映射本身完全正确，**只是切换后没人再触发一次对齐** ——
     * `syncPreviewAfterToggleRef` 的 0/160/480/1000ms 重试只挂在「预览开合冻结窗」的
     * `finalize` 里（见 `finalize`），而 `modeChanged` 会让冻结窗直接 return，
     * 所以模式切换那条路径上**完全没有重对齐**。
     *
     * ## 做法
     * 本 effect 在 `viewMode` / `previewHtml` / 源码文本变化后重跑（模式切换必然命中），
     * 于是就在绑定监听后按 `PREVIEW_REALIGN_DELAYS` 排延时重试。
     * 每次调用 `syncToPreview(true)`（force 跳过方向锁，但仍受 `isScrollFrozen` /
     * `isSyncingScrollRef` 守卫）—— 只读左屏、只写右屏，**幂等**。
     *
     * 三条终止条件由纯函数 `shouldContinuePreviewRealign` 决定：
     * 卸载/新一代接管（token）、**用户主动滚动左屏**、超出 2500ms 窗口。
     * 用户滚动用输入事件判（wheel/pointerdown/touchstart）—— 与 §4-31 的口径一致：
     * 不能用 scrollTop 差值，浏览器钳位会被误判成用户操作。
     */
    const realignGen = ++previewRealignGenRef.current;
    let realignCancelled = false;
    let userScrolledRealign = false;
    const markRealignUser = () => {
      userScrolledRealign = true;
    };
    const realignStartedAt = performance.now();
    // 用户接管判定：需绑具体元素（判据 2）。有 textarea 时绑它；
    // CM6 下改绑 surface 的滚动容器能力尚不覆盖 wheel/pointer，故此处仅在无元素时跳过
    // —— 影响是"realign 期间用户主动滚动的判定不生效"，属 A 类降级（realign 仍会按时序结束）。
    if (textarea) {
      textarea.addEventListener("wheel", markRealignUser, { passive: true });
      textarea.addEventListener("pointerdown", markRealignUser, { passive: true });
      textarea.addEventListener("touchstart", markRealignUser, { passive: true });
    }
    const realignTimers: Array<ReturnType<typeof setTimeout>> = [];
    const runRealign = (delayMs: number) => {
      const timer = setTimeout(() => {
        const cont = shouldContinuePreviewRealign({
          cancelled: realignCancelled || previewRealignGenRef.current !== realignGen,
          userScrolled: userScrolledRealign,
          elapsedMs: performance.now() - realignStartedAt,
        });
        if (!cont) {
          traceScroll("preview-realign-stop", {
            delayMs,
            gen: realignGen,
            user: userScrolledRealign,
            elapsed: Math.round(performance.now() - realignStartedAt),
          });
          return;
        }
        try {
          // 同一个入口：force 跳方向锁 + isScrollFrozen/isSyncing 守卫
          // + **右屏就绪闸门**（贴标为空 / 不可滚动时跳过，见 realignLayoutNow 的注释）
          realignLayoutNow();
          traceScroll("preview-realign", {
            delayMs,
            gen: realignGen,
            previewTop: getPreviewScroller()?.scrollTop ?? null,
          });
        } catch {
          /* 右屏尚未就绪：后面的时点会再试 */
        }
      }, delayMs);
      realignTimers.push(timer);
    };
    for (const d of PREVIEW_REALIGN_DELAYS) runRealign(d);

    /**
     * 布局驱动重对齐（比定时器更权威的那一路）。
     *
     * ## 为什么固定时点还不够（实机抓到的残余）
     * 首版只排 0/160/480/1000/1600ms，实测 A2 仍从 Δ3.81 行漂到 Δ5.1 行：
     * 左屏 `textarea` 的**视口顶行自己在动**（89.81 → 91.1 行）——
     * 原因是 `.source-editor` 的 `padding-inline` 含 `100%`（editor.css 1708-1722），
     * 它自带 **0.42s** 过渡，而 `modeSwitchSlide.css` 的动画窗口只关了
     * wrapper/shell 的宽度过渡、**没关** textarea 自己的 padding 过渡。
     * 于是 380ms 动画窗结束（padding 还差 40ms）之后布局仍在变 → 每一行软换行位置
     * 都在微调 → 按"那一刻"对齐的结果 40ms 后又歪一格。
     *
     * ## 做法：盯**左屏布局量**，一变就重新对齐（幂等 + 有窗口上限）
     * `ResizeObserver` 观察 `textarea.scrollHeight` / `clientWidth` / `clientHeight`：
     * - `scrollHeight` 变 → 软换行数变了（宽度/字体/行高）→ 必须重新映射；
     * - `clientWidth` 变 → 正文列宽变了 → 同上。
     * 每次变化都排一次（rAF 合并，避免过渡期每帧都写右屏）；
     * 静止 320ms 后不再追（`resizeSettleTimer`），并受同一 2500ms 窗口与用户退场约束。
     *
     * 注意这**不会**与用户滚动打架：observer 只在**布局**变化时触发，
     * 用户滚动不改布局；且用户一有输入事件 `userScrolledRealign` 就为真、直接退场。
     */
    /**
     * "右屏没就绪而被跳过"的**补试**机制。
     *
     * 定时器的时点一旦被跳过，光靠后续时点可能都错过（实测：480ms 被跳过、
     * 1000/1600ms 时右屏已就绪且已对齐，但那一档的 Δ 已记录为 89.81 行）。
     * 因此跳过时立刻排一次 60ms 补试（最多 6 次），保证"右屏一就绪就会被对齐"。
     */
    let skipRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let skipRetryCount = 0;
    const scheduleSkipRetry = () => {
      if (skipRetryTimer || skipRetryCount >= 6) return;
      skipRetryCount++;
      skipRetryTimer = setTimeout(() => {
        skipRetryTimer = null;
        realignLayoutNow();
      }, 60);
    };
    const realignLayoutNow = () => {
      const cont = shouldContinuePreviewRealign({
        cancelled: realignCancelled || previewRealignGenRef.current !== realignGen,
        userScrolled: userScrolledRealign,
        elapsedMs: performance.now() - realignStartedAt,
      });
      if (!cont) return;
      /**
       * ⚠️ v0.15.3 实测抓出的**竞态**（第二版才暴露）：
       * 定时器到点时右屏可能"贴标已有、但滚动元素还在 0"或反之 ——
       * 实测同一台机器上 480ms 那次采到 `右屏 scrollHeight=7868 且已贴标 78 个`，
       * 但下一场次 480ms 时右屏刚被 `doc.open()/write()` **整篇重写**，
       * `[data-src-line]` 又变回 0 → 对齐写到一个"还没内容"的滚动元素上 → Δ89.81 行。
       * 判据不能只看时间，必须看**右屏此刻是否真的可对齐**：
       * `[data-src-line] > 0` 且 `scrollHeight > clientHeight`。不满足就**跳过本次**，
       * 交给后续定时器 / 布局 observer / iframe load 事件（它们都会再触发）。
       */
      const preview = getPreviewScroller();
      if (preview) {
        let tagged = 0;
        try {
          tagged = preview.querySelectorAll("[data-src-line]").length;
        } catch {
          tagged = 0;
        }
        if (tagged === 0) {
          traceScroll("preview-realign-skip", { gen: realignGen, reason: "not-tagged", tag: tagged });
          scheduleSkipRetry();
          return;
        }
        if (!(preview.scrollHeight > preview.clientHeight)) {
          traceScroll("preview-realign-skip", {
            gen: realignGen,
            reason: "not-scrollable",
            sh: preview.scrollHeight,
            ch: preview.clientHeight,
          });
          scheduleSkipRetry();
          return;
        }
      }
      try {
        syncPreviewAfterToggle();
        traceScroll("preview-realign-layout", {
          gen: realignGen,
          taSH: sourceSurface.getMetrics().scrollHeight,
          taW: sourceSurface.getMetrics().clientWidth,
          previewTop: getPreviewScroller()?.scrollTop ?? null,
        });
      } catch {
        /* 右屏尚未就绪 */
      }
    };
    let resizeRaf = 0;
    let resizeSettleTimer: ReturnType<typeof setTimeout> | null = null;
    /** 布局键：内容高 + 宽高（A3：经 surface metrics，CM6 下是 scrollDOM 的值） */
    const layoutKeyOf = (): string => {
      const m = sourceSurface.getMetrics();
      return `${m.scrollHeight}|${m.clientWidth}|${m.clientHeight}`;
    };
    let lastLayoutKey = layoutKeyOf();
    const scheduleLayoutRealign = () => {
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        realignLayoutNow();
      });
      if (resizeSettleTimer) clearTimeout(resizeSettleTimer);
      resizeSettleTimer = setTimeout(() => {
        resizeSettleTimer = null;
      }, 320);
    };
    const layoutObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            const key = layoutKeyOf();
            if (key === lastLayoutKey) return;
            lastLayoutKey = key;
            scheduleLayoutRealign();
          })
        : null;
    /**
     * ResizeObserver 必须 observe 一个**真实元素**。有 textarea 时 observe 它（原行为）；
     * CM6 下没有元素可 observe → 跳过。影响：拖分割条时不即时重对齐，
     * 但 `syncPreviewAfterToggle` 与右屏自身 ResizeObserver 仍会触发 → **A 类降级**。
     */
    if (textarea) layoutObserver?.observe(textarea);
    /**
     * 把"内容就绪 → 重对齐"的入口注册出去（见 `requestPreviewRealignRef` 的注释）。
     * 用 `realignLayoutNow` 而不是裸 `syncToPreview`：它带**右屏就绪闸门**
     * （贴标为空 / 不可滚动时跳过并 60ms 补试），避免"贴标刚被清空"那一瞬写坏位置。
     */
    const requestPreviewRealign = () => {
      realignLayoutNow();
    };
    requestPreviewRealignRef.current = requestPreviewRealign;

    return () => {
      realignCancelled = true;
      for (const t of realignTimers) clearTimeout(t);
      realignTimers.length = 0;
      if (skipRetryTimer) clearTimeout(skipRetryTimer);
      skipRetryTimer = null;
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      if (resizeSettleTimer) clearTimeout(resizeSettleTimer);
      layoutObserver?.disconnect();
      if (requestPreviewRealignRef.current === requestPreviewRealign) {
        requestPreviewRealignRef.current = null;
      }
      if (textarea) {
        textarea.removeEventListener("wheel", markRealignUser);
        textarea.removeEventListener("pointerdown", markRealignUser);
        textarea.removeEventListener("touchstart", markRealignUser);
      }
      cancelAnimationFrame(raf);
      offSourceScroll();
      previewWin.removeEventListener("scroll", syncToSource);
      previewDocNow?.removeEventListener("scroll", syncToSource, { capture: true } as EventListenerOptions);
      if (syncPreviewAfterToggleRef.current === syncPreviewAfterToggle) {
        syncPreviewAfterToggleRef.current = null;
      }
      resetScrollDirectionLock(lock);
      isSyncingScrollRef.current = false;
    };
  }, [viewMode, previewHtml, previewSourceMarkdown]); // 依赖 previewHtml / 源码文本，因为 iframe 内容更新后需要重新同步


  // ─── 格式工具栏 ────────────────────────────────
  // link/image/table 打开对应对话框；mermaid 打开模板下拉；其余走 handleFormatAction
  // v0.12.0 需求2：detail=2（双击）用于格式刷的"持续应用"入口
  const onFormatBtnClick = useCallback((action: string, detail = 1) => {
    if (action === "undo") { handleUndo(); return; }
    if (action === "redo") { handleRedo(); return; }
    if (action.startsWith("sep")) return;
    if (action === "link") { openLinkDialog(); return; }
    if (action === "image") { setImageDialogOpen(true); return; }
    if (action === "table") { setTableDialogOpen(true); return; }
    if (action === "mermaid") { setMermaidMenuOpen((v) => !v); return; }
    if (action === "formatPainter") {
      // 单击 = once（Word 默认）；双击 = persistent（再次双击结束，见 armFormatPainter）
      armFormatPainterRef.current(detail >= 2);
      return;
    }
    handleFormatAction.current(action);
  }, [handleUndo, handleRedo, openLinkDialog]);

  return {
    codePreviewHtml,
    onFormatBtnClick
  };
}
