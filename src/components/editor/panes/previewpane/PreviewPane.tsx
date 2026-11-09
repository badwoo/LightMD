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
import { isAnchorablePreviewChild, shouldTagPreview, PreviewAnchorSet, lineAtMaxScroll, measureSourceLineAxis, estimateTopSourceLine, mapSourceLineToPreviewScroll, mapPreviewScrollToSourceLine, mapSourceLineToScrollTop } from "../../../../utils/blockScrollAlign";
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

  useEffect(() => {
    anchorSuppressUntilRef.current = performance.now() + 600;
  }, [viewMode, filePath, forceUpdateKey]);

  useEffect(() => {
    anchorSuppressUntilRef.current = performance.now() + 300;
  }, [docZoom]);

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

  useEffect(() => {
    if (!isSourceMode) return;
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

  useEffect(() => {
    if (!isSourceMode) return;
    const ta = sourceTextareaRef.current;
    if (!ta) return;
    const raf = requestAnimationFrame(() => {
      restoreTextAnchor(ta, textAnchorRef.current);
      textAnchorRef.current = captureTextAnchor(ta);
    });
    return () => cancelAnimationFrame(raf);
  }, [docZoom, isSourceMode]);

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

  useEffect(() => {
    setMermaidTheme(isDarkTheme(theme));
  }, [theme]);

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

  useEffect(() => {
    if (!typewriterMode || viewMode === "preview") return;
    const textarea = sourceTextareaRef.current;
    if (!textarea) return;
    // 不设置 scrollBehavior = "smooth"，与 ProseMirror 模式保持一致：
    // 避免全局 CSS 影响所有滚动操作，改用 scrollTo({ behavior: "smooth" }) 显式控制

    const scrollCursorToCenter = () => {
      requestAnimationFrame(() => {
        if (!typewriterModeRef.current) return;
        const cursorPos = textarea.selectionStart;
        // 使用 mirror div 测量光标所在位置的实际 Y 坐标（准确处理软换行）
        // 早期实现基于硬换行行号 * lineHeight 计算，软换行场景下 Y 坐标偏小，居中位置不准
        const cursorY = measureTextareaCursorY(textarea, cursorPos);
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
        // 普通字符：检查光标是否偏离中央
        const cursorPos = textarea.selectionStart;
        const cursorY = measureTextareaCursorY(textarea, cursorPos);
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

  const prevPreviewShownRef = useRef(false);

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

  const freezePrevViewModeRef = useRef(viewMode);

  const freezePrevShownRef = useRef(previewShown);

  const syncPreviewAfterToggleRef = useRef<(() => void) | null>(null);

  const previewRealignGenRef = useRef(0);

  const requestPreviewRealignRef = useRef<(() => void) | null>(null);

  const isFrozenRestoreRef = useRef(false);

  const PREVIEW_TOGGLE_FREEZE_MS = 620;

  const previewIframeInitRef = useRef<{ mermaid: boolean; math: boolean; theme: string }>({
    mermaid: false,
    math: false,
    theme: "",
  });

  const lastIframeHtmlRef = useRef("");

  const lastIframeTypoKeyRef = useRef("");

  useEffect(() => {
    if (previewShown && !prevPreviewShownRef.current) {
      justEnteredSplitRef.current = true;
      // 重新展开预览时重置 iframe 初始化状态，确保首次完整加载
      previewIframeInitRef.current = { mermaid: false, math: false, theme: "" };
    }
    prevPreviewShownRef.current = previewShown;
  }, [previewShown]);

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

  const previewSourceMarkdown = useMemo(
    () =>
      previewShown && isMdFile
        ? unmaskBase64Images(debouncedSourceContent, base64TokensRef.current)
        : "",
    [previewShown, isMdFile, debouncedSourceContent],
  );

  const codePreviewHtml = useMemo(() => {
    if (isMdFile || viewMode !== "preview") return "";
    // v0.6.6 问题4：unmask 还原 base64（显示层短标记不进预览）
    return renderCodeFilePreview(unmaskBase64Images(sourceContent, base64TokensRef.current), currentLanguage);
  }, [sourceContent, isMdFile, viewMode, currentLanguage]);

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

  const foldBridge = useMemo(
    () =>
      createIframeFoldBridge({
        getIframeDocument: () => previewIframeRef.current?.contentDocument ?? null,
        isActive: () => previewShown && isMdFile,
      }),
    [previewShown, isMdFile],
  );

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

  useEffect(() => {
    if (!previewShown) return;
    const textarea = sourceTextareaRef.current;
    const iframe = previewIframeRef.current;
    if (!textarea || !iframe) return;
    const previewWin = iframe.contentWindow;
    if (!previewWin) return;

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

    /** 左屏可滚动上限（末尾锚点要用它算"滚到底时视口顶所在行"） */
    const maxSourceScroll = (): number =>
      Math.max(0, textarea.scrollHeight - textarea.clientHeight);

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
      const key = `${previewSourceMarkdown.length}|${textarea.clientWidth}|${textarea.clientHeight}|${textarea.scrollHeight}`;
      if (axisCache && axisCache.key === key) return axisCache.axis;
      let axis: number[] | null = null;
      try {
        const measured = measureSourceLineAxis({
          textarea,
          blockLines: topLevelBlockStartLines(previewSourceMarkdown),
        });
        // 长度必须与"当前逻辑行数"严格一致，否则是过期测量（内容刚变、DOM 未更新）→ 丢弃
        if (measured && measured.totalLines === total) axis = measured.axis;
      } catch {
        axis = null;
      }
      axisCache = { key, axis };
      return axis;
    };

    /** 左屏视口顶对应的源码行（浮点） */
    const currentTopSourceLine = (): number =>
      estimateTopSourceLine({
        scrollTop: textarea.scrollTop,
        scrollHeight: textarea.scrollHeight,
        clientHeight: textarea.clientHeight,
        totalSourceLines: totalSourceLines(),
        // v0.14.0 需求4：软换行感知（null 时纯函数层自动退回线性公式）
        lineTops: getSourceLineAxis() ?? undefined,
      });

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
          preview.scrollTop = computeSyncScrollTop(
            textarea.scrollTop, textarea.scrollHeight, textarea.clientHeight,
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
          const pct = computeSyncScrollTop(
            preview.scrollTop, preview.scrollHeight, preview.clientHeight,
            textarea.scrollHeight, textarea.clientHeight,
          );
          const max = Math.max(0, textarea.scrollHeight - textarea.clientHeight);
          textarea.scrollTop = Math.min(Math.max(0, pct), max);
        } else {
          const top = mapSourceLineToScrollTop(
            {
              scrollTop: textarea.scrollTop,
              scrollHeight: textarea.scrollHeight,
              clientHeight: textarea.clientHeight,
              totalSourceLines: totalSourceLines(),
              // v0.14.0 需求4：与左→右用**同一根**实测轴，保证两向往返互逆
              lineTops: getSourceLineAxis() ?? undefined,
            },
            line,
          );
          if (top !== null) textarea.scrollTop = top;
        }
      } catch {
        /* 测量异常：放弃本次同步（不写坏滚动位置） */
      } finally {
        isSyncingScrollRef.current = false;
      }
    };

    // ⚠️ 必须包一层：`syncToPreview` 现在有 force 参数，直接把函数当事件监听器
    // 会被传入 Event 对象（truthy）→ 每次都跳过方向锁。
    const onSourceScroll = () => syncToPreview();
    textarea.addEventListener("scroll", onSourceScroll, { passive: true });
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
    textarea.addEventListener("wheel", markRealignUser, { passive: true });
    textarea.addEventListener("pointerdown", markRealignUser, { passive: true });
    textarea.addEventListener("touchstart", markRealignUser, { passive: true });
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
          taSH: textarea.scrollHeight,
          taW: textarea.clientWidth,
          previewTop: getPreviewScroller()?.scrollTop ?? null,
        });
      } catch {
        /* 右屏尚未就绪 */
      }
    };
    let resizeRaf = 0;
    let resizeSettleTimer: ReturnType<typeof setTimeout> | null = null;
    let lastLayoutKey = `${textarea.scrollHeight}|${textarea.clientWidth}|${textarea.clientHeight}`;
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
            const key = `${textarea.scrollHeight}|${textarea.clientWidth}|${textarea.clientHeight}`;
            if (key === lastLayoutKey) return;
            lastLayoutKey = key;
            scheduleLayoutRealign();
          })
        : null;
    layoutObserver?.observe(textarea);
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
      textarea.removeEventListener("wheel", markRealignUser);
      textarea.removeEventListener("pointerdown", markRealignUser);
      textarea.removeEventListener("touchstart", markRealignUser);
      cancelAnimationFrame(raf);
      textarea.removeEventListener("scroll", onSourceScroll);
      previewWin.removeEventListener("scroll", syncToSource);
      previewDocNow?.removeEventListener("scroll", syncToSource, { capture: true } as EventListenerOptions);
      if (syncPreviewAfterToggleRef.current === syncPreviewAfterToggle) {
        syncPreviewAfterToggleRef.current = null;
      }
      resetScrollDirectionLock(lock);
      isSyncingScrollRef.current = false;
    };
  }, [viewMode, previewHtml, previewSourceMarkdown]); // 依赖 previewHtml / 源码文本，因为 iframe 内容更新后需要重新同步

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
