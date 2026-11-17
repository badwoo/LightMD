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
import {
  isPreviewGeometrySane as isPreviewGeometrySaneFn,
  previewGeometryOf,
} from "../../../../utils/previewGeometry";
import { previewAllowedMove, clampPreviewTarget } from "../../../../utils/scrollSyncPolicy";
import { shouldContinuePreviewRealign, PREVIEW_REALIGN_DELAYS } from "../../../../utils/textOffsetRemap";
import type { EditorView as EditorView } from "prosemirror-view";
import type { ViewMode as ViewMode } from "../../../../stores/useEditorStore";
import type { SourceSurface } from "../../../../editor/types";
import {
  renderMarkdownToHtml,
  traceScroll,
} from "../../EditorContainer";
import type { PreviewPaneParams, PreviewPaneResult } from "./types";

/* ═══════════════════════════════════════════════════════════════════════════
 * P1-3（v0.17.0 修复）：**判「是不是真 textarea」只能用类型判定**
 *
 * ## 缺陷（本题本体）
 *
 * A3 把源码面宿主从受控 `<textarea>` 换成中性 `<div class="source-editor-cm6">`，
 * 但宿主 ref 的**类型标注仍是 `RefObject<HTMLTextAreaElement>`**
 * （`EditorContainer.tsx` 里 `sourceTextareaRef = sourceHostElRef`）。
 * TypeScript 因此全程沉默，于是下面这种**真值性判断**被当成了"类型判断"：
 *
 * ```ts
 * const source = textarea ? textareaMeasureSource(textarea) : surfaceMeasureSource(sourceSurface);
 * //                ^^^^^^^^ div 是 truthy（非 null）→ 永远走左边
 * ```
 *
 * 左边那条路读 `textarea.value` 得 `undefined` → 返回 null →
 * **专为 CM6 写的 `surfaceMeasureSource` 永远不会被调用** →
 * 分屏对齐的行轴恒为 null → 退回"按总行数线性插值"（软换行感知归零）→
 * **左右两屏显示的不是同一段正文**（实测文字同源 0/4，最差 31 行 ≈ 932px）。
 *
 * ## 为什么它会骗过上一轮的护栏
 *
 * 上一轮的静态守卫扫的是「对可能是 div 的元素**裸调** textarea 专属成员」
 * （`setSelectionRange` / `.value.length` 等）。`div ?` 这个写法不含任何成员调用，
 * 于是**完全扫不到** —— 这也正是本轮补的门禁规则（见
 * `src/__tests__/v0170-div-as-textarea-guard.test.ts`）所针对的形态。
 *
 * ## 本文件采用的写法（项目既有正确范式：`SourcePane.tsx:454`）
 *
 * ```ts
 * const isRealTextarea = !!el && typeof (el as { value?: unknown }).value === "string";
 * ```
 *
 * 并且**把结论收成一个返回值**（`asRealTextarea`），调用点因此拿到的是
 * `HTMLTextAreaElement | null` —— 类型系统重新变得可信：真 textarea 与 CM6 宿主
 * 从此在类型上就是两个世界，忘写 CM6 分支会**编译报错**而不是静默降级。
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 类型判定：传入的是真 `<textarea>` 吗？
 *
 * div 宿主上 `value` 是 `undefined`（不是抛错），所以**必须**用
 * `typeof … === "string"` 而不是 `if (el)`。
 */
function asRealTextarea(el: Element | null | undefined): HTMLTextAreaElement | null {
  if (!el) return null;
  return typeof (el as unknown as { value?: unknown }).value === "string"
    ? (el as HTMLTextAreaElement)
    : null;
}

/* ─── 行轴诊断钩子（**opt-in 接收器**模式，与 `editorHistory/historyTrace.ts` 同款）───
 *
 * ## 为什么要这个钩子
 * P1-3 的判定关键就是「行轴到底走了哪条测量源、为什么没建成」：
 * 修复前 `surfaceMeasureSource` **永远不会被调用**（`textarea ?` 恒真），
 * 而这种"静默降级"没有任何异常、没有任何日志。探针必须能从页面侧读到
 * 「本次行轴用的是 textarea 源还是 surface 源」与「降级原因」，否则
 * 只能靠"结果偏了多少"反推根因 —— 那既慢又会误导（缺陷详报 §3 的教训）。
 *
 * ## 为什么**不**用 `import.meta.env.DEV` 门控（也没有无条件写 window）
 * 两个理由缺一不可：
 * 1. **必须在 release exe 上可读**：本缺陷只在打包产物 + 真 WebView2 上复现
 *    （jsdom 恒走 textarea 实现、无布局），dev server 下时序也完全不同 →
 *    门控掉就等于"永远无法取证"。
 * 2. **不能在生产包无条件写全局**：那会让用户安装版平白多出全局状态，
 *    且热路径（每次行轴重建）都会写一次属性。
 *
 * 结论：采用 **opt-in 接收器** —— 探针先安装 `window.__LMD_AXIS = { source, degrade: [] }`，
 * 我们才写；**没安装时只做一次 `typeof` 判定就返回**（零日志、零字符串拼接、零副作用）。
 * 这与 `historyTrace.ts` 的 `histTraceEnabled()` 完全同一套契约。
 *
 * ⚠️ 这两个字段是**诊断钩子，不是业务状态**：任何业务代码都不得读取它们。
 *
 * ```js
 * // 探针侧（CDP evaluate）
 * window.__LMD_AXIS = { source: "", degrade: [] };
 * ```
 */
interface AxisDiagnosticsSink {
  /** 最近一次行轴测量实际走的源 */
  source?: "textarea" | "surface";
  /** 行轴降级原因（有上限，防长时间运行吃内存） */
  degrade?: string[];
}

/** 单次会话最多累积多少条降级原因 */
const AXIS_DEGRADE_LIMIT = 200;

/** 取接收器：**未安装时返回 null**（生产环境恒为 null → 后续一行都不执行） */
function axisSink(): AxisDiagnosticsSink | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { __LMD_AXIS?: unknown };
  const s = w.__LMD_AXIS;
  return s && typeof s === "object" ? (s as AxisDiagnosticsSink) : null;
}

/** 探针取证：记录「行轴测量实际走了哪条源」（textarea / surface） */
function markAxisSource(source: "textarea" | "surface"): void {
  const s = axisSink();
  if (!s) return;
  s.source = source;
}

/** 降级可观测：把「行轴为什么没建成」报给探针（不是静默返回 null） */
function reportAxisDegrade(reason: string): void {
  const s = axisSink();
  if (!s) return;
  if (!Array.isArray(s.degrade)) s.degrade = [];
  if (s.degrade.length < AXIS_DEGRADE_LIMIT) s.degrade.push(reason);
}

/** 每个逻辑行行首的字符偏移（`starts[i]` = 第 i 行首字符偏移） */
function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/** 字符偏移 → 逻辑行号（0-based） */
function lineIndexAtOffset(text: string, offset: number): number {
  const p = Math.max(0, Math.min(text.length, offset));
  let line = 0;
  for (let i = 0; i < p; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/**
 * 源码面几何门面（P1-3）：把「读像素 / 写像素 / 采锚点 / 还锚点」收成一套，
 * 两个实现（textarea / CM6）共用**同一批调用点**。
 *
 * ## 为什么需要它
 *
 * `PreviewPane` 里有 6 处「按 textarea 语义读几何」的代码（预览开合冻结、
 * 排版变化补偿、缩放补偿、打字机、分屏行轴……）。若每处都自己写
 * `textarea ? … : …`，就会重演本缺陷（有的写对、有的写错、没人发现）。
 * 收成门面后，CM6 的实现只在**一个地方**出现。
 *
 * ## textarea 分支一行未改
 * 真 textarea 走既有的 mirror 实现（`captureTextAnchor` / `restoreTextAnchor`），
 * 行为与 v0.16.0 完全相同。
 *
 * ## CM6 分支：行轴 + `coordsAtPos`
 * - 锚点用**字符偏移**（与排版/字号/软换行无关，这正是"锚内容不锚像素"）；
 * - 「偏移 ↔ 内容坐标 Y」走 `SourceSurface.offsetToContentY`（`coordsAtPos`）；
 * - 偏移落在视口外（`coordsAtPos` 测不到）时，退回**行轴**估算
 *   （`lineBlockAt` 全文档可用，代价是视口外为估算 —— 源码 R2 已说明）。
 */
interface SourceGeometry {
  /** 源码面宿主元素（textarea 实现是 textarea 本身；CM6 是中性 div，事件会从内部冒泡上来） */
  host(): HTMLElement | null;
  /** 真 textarea（类型判定后）；CM6 下恒为 null */
  realTextarea(): HTMLTextAreaElement | null;
  scrollTop(): number;
  setScrollTop(px: number): void;
  metrics(): { scrollHeight: number; clientHeight: number; clientWidth: number; totalLines: number };
  /** 行号 → 内容坐标顶部（行轴）；不可用时 null */
  lineAxis(): number[] | null;
  /** 采「视口 Y 处那段内容」的锚点 */
  captureAt(viewportY: number): TextContentAnchor | null;
  /** 把锚点那段内容拉回它原来的视口 Y */
  restore(anchor: TextContentAnchor | null | undefined): void;
  /** 只计算"把锚点拉回原位"所需的 scrollTop，**不写入**（用于先算后写的防抖策略） */
  scrollTopForAnchor(anchor: TextContentAnchor | null | undefined): number | null;
}

function createSourceGeometry(
  surface: SourceSurface,
  hostRef: { current: HTMLTextAreaElement | null },
): SourceGeometry {
  let axisCache: { key: string; axis: number[] | null } | null = null;
  let offsetsCache: { text: string; starts: number[] } | null = null;

  const host = (): HTMLElement | null =>
    (hostRef.current as unknown as HTMLElement | null) ?? null;
  const realTextarea = (): HTMLTextAreaElement | null => asRealTextarea(hostRef.current);
  const metrics = () => surface.getMetrics();

  const startsOf = (text: string): number[] => {
    if (offsetsCache && offsetsCache.text === text) return offsetsCache.starts;
    const starts = lineStartOffsets(text);
    offsetsCache = { text, starts };
    return starts;
  };

  /**
   * 行轴：`axis[line]` = 该行行盒顶部在**内容坐标系**的位置。
   *
   * 缓存键含「文本长度 + 宽高 + scrollHeight」：内容变、拖分割条、改字号/行高/
   * `--doc-zoom` 都会让软换行位置变，轴必须重算（与分屏联动侧同一条口径）。
   */
  const lineAxis = (): number[] | null => {
    const text = surface.getText();
    const total = text.split("\n").length;
    if (total <= 1) return null;
    const m = metrics();
    const key = `${text.length}|${m.clientWidth}|${m.clientHeight}|${m.scrollHeight}`;
    if (axisCache && axisCache.key === key) return axisCache.axis;
    let axis: number[] | null = null;
    try {
      const measured = measureLineAxis(
        surfaceMeasureSource(surface),
        topLevelBlockStartLines(text),
        reportAxisDegrade,
      );
      if (measured && measured.totalLines === total) axis = measured.axis;
    } catch {
      axis = null;
    }
    axisCache = { key, axis };
    return axis;
  };

  const captureAt = (viewportY: number): TextContentAnchor | null => {
    // ── textarea 实现：mirror 路径，原实现一行未改 ──
    const ta = realTextarea();
    if (ta) return captureTextAnchor(ta, viewportY);
    // ── CM6 实现：行轴定行 → 行首偏移 → coordsAtPos 定 Y ──
    const m = metrics();
    if (!(m.scrollHeight > m.clientHeight)) return null;
    const text = surface.getText();
    if (!text) return null;
    const axis = lineAxis();
    if (!axis) return null;
    const scrollTop = surface.getScrollTop();
    const targetY = scrollTop + (Number.isFinite(viewportY) ? viewportY : 0);
    const total = text.split("\n").length;
    const line = estimateTopSourceLine({
      scrollTop: targetY,
      scrollHeight: m.scrollHeight,
      clientHeight: m.clientHeight,
      totalSourceLines: total,
      lineTops: axis,
    });
    const starts = startsOf(text);
    const idx = Math.max(0, Math.min(starts.length - 1, Math.floor(line)));
    const offset = starts[idx];
    /**
     * 行首字符的真实内容坐标 Y：优先 `coordsAtPos`（实测），
     * 测不到（该行此刻不在渲染视口内）时用行轴值（估算）。
     * **两者都不可用时返回 null，绝不返回 0** —— 0 会被当成"文档最顶部"，
     * 后续补偿会把视口拉到文首（与打字机那条 `cursorY = 0` 的坑同源）。
     */
    let contentY = surface.offsetToContentY(offset);
    if (contentY === null) {
      const v = axis[Math.max(0, Math.min(axis.length - 1, idx))];
      contentY = Number.isFinite(v) ? v : null;
    }
    if (contentY === null || !Number.isFinite(contentY)) return null;
    return { offset, viewportY: contentY - scrollTop };
  };

  /**
   * 把锚点送回原位**所需的 scrollTop**（只计算、不写入）。
   *
   * ## 为什么需要"只算不写"（v0.17.0 第三轮 · 用户第 12 项）
   *
   * 预览开合的宽度过渡期间（420ms，每帧布局都在变），原来每帧都无条件
   * `restore(anchor)`：写一次就产生一次可见位移，随后 CM6 的 `measure()`
   * 又按新的渲染事实钳位 —— 两个写者互相覆盖。
   * 实测 `scrollTop` 单帧跳变 **231px**、方向反转 **4 次**，用户看到"文档抖一下"。
   *
   * 改成"先算目标、与当前值比较、只有偏离超阈值才写"之后，
   * 大部分帧**一次都不写** → 没有往复 → 抖动消失；
   * 真正跑偏（>阈值）时仍然纠正 → 保住"视野不能被拽走"的下限。
   *
   * @returns 目标 scrollTop；锚点测量不可用时 null（调用方跳过，绝不当成 0）
   */
  const scrollTopForAnchor = (anchor: TextContentAnchor | null | undefined): number | null => {
    if (!anchor) return null;
    const ta = realTextarea();
    const m = metrics();
    const max = Math.max(0, m.scrollHeight - m.clientHeight);
    if (!(max > 0)) return null;
    const text = surface.getText();
    if (!text) return null;
    const offset = Math.max(0, Math.min(text.length - 1, anchor.offset));
    let contentY = surface.offsetToContentY(offset);
    if (contentY === null) {
      // 重排后该偏移已滚出渲染视口（CM6 只渲染视口附近）→ 用行轴估算兜底
      const axis = lineAxis();
      if (!axis) return null;
      const line = lineIndexAtOffset(text, offset);
      const v = axis[Math.max(0, Math.min(axis.length - 1, line))];
      contentY = Number.isFinite(v) ? v : null;
    }
    if (contentY === null || !Number.isFinite(contentY)) return null;
    void ta;
    return Math.max(0, Math.min(max, contentY - anchor.viewportY));
  };

  const restore = (anchor: TextContentAnchor | null | undefined): void => {
    if (!anchor) return;
    const ta = realTextarea();
    if (ta) {
      restoreTextAnchor(ta, anchor);
      return;
    }
    const m = metrics();
    const max = Math.max(0, m.scrollHeight - m.clientHeight);
    if (!(max > 0)) return;
    const text = surface.getText();
    if (!text) return;
    const offset = Math.max(0, Math.min(text.length - 1, anchor.offset));
    let contentY = surface.offsetToContentY(offset);
    if (contentY === null) {
      // 重排后该偏移已滚出渲染视口（CM6 只渲染视口附近）→ 用行轴估算兜底
      const axis = lineAxis();
      if (!axis) return;
      const line = lineIndexAtOffset(text, offset);
      const v = axis[Math.max(0, Math.min(axis.length - 1, line))];
      contentY = Number.isFinite(v) ? v : null;
    }
    if (contentY === null || !Number.isFinite(contentY)) return;
    const want = Math.max(0, Math.min(max, contentY - anchor.viewportY));
    if (Math.abs(surface.getScrollTop() - want) > 0.5) surface.setScrollTop(want);
  };

  return {
    host,
    realTextarea,
    scrollTop: () => surface.getScrollTop(),
    setScrollTop: (px: number) => surface.setScrollTop(px),
    metrics,
    lineAxis,
    captureAt,
    restore,
    scrollTopForAnchor,
  };
}

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


  /**
   * P1-3：源码面几何门面（唯一入口）。
   *
   * 本 pane 里所有「按 textarea 语义读/写源码面几何」的调用点（排版补偿、
   * 宽度锚点、缩放补偿、预览开合冻结、打字机、分屏行轴）**一律经它**，
   * 内部按类型判定分派到两个实现。这样"CM6 分支漏写"只可能发生在一个地方，
   * 而不是在 6 个调用点各写一遍真值性判断（那正是本缺陷的成因）。
   *
   * 依赖只给 `sourceSurface`：宿主 ref 是对象引用，取值时机由 `host()` 决定，
   * 不需要（也不应该）作为 effect 依赖 —— 它就是 ref 的语义。
   */
  const sourceGeometry = useMemo(
    () => createSourceGeometry(sourceSurface, sourceTextareaRef),
    [sourceSurface, sourceTextareaRef],
  );

  /**
   * ## ═══ v0.17.0 第四轮 · 用户第 4 项：「编辑模式下按回车页面明显抖动」═══
   *
   * 根因与修法的完整推导见 `syncToPreview` / `syncToSource` 上方的注释。
   * 这里只保留修复所需的**唯一状态**：一个时间窗口。
   *
   * ### 为什么是"时间窗口"而不是更聪明的耦合（试过，否掉）
   * 抖动的本质是**右屏动完又回去**（回弹），不是"右屏动了" ——
   * 明细：左屏 smooth 28px/5 帧（正确），右屏跟随 189→12→3→2（也正确），
   * 最后 `−185px` 那一下才是缺陷。所以只需要拦住"回声反向接管"，
   * **逐帧跟随必须保留**（否掉"合并成一次写"的原因见 `syncToPreview` 注释）。
   *
   * ### 为什么放 ref 而不是 state
   * 它在 scroll 事件处理器里被读写。滚动路径上一旦触发 React 重渲染，
   * 单个 smooth 动画的帧预算就会被吃掉 —— 那本身就能被感知成"抖"。
   */
  const TYPEWRITER_SMOOTH_WINDOW_MS = 320;
  /**
   * 打字机平滑动画窗口的结束时刻（`performance.now()` 口径；已过期为 0 语义）。
   *
   * 取值依据：一次 `scrollTo({behavior:"smooth"})` 在 Chromium 里实测约 218~283ms
   * （R3 #8 的逐帧数据），取 **320ms** 留出掉帧余量；同时**小于**用户"接着滚一下"
   * 的最快反应时间（人手连续两动作的间隔下限约 350~400ms），所以不会把
   * 紧接着的真实滚动误判成回声。
   */
  const typewriterSmoothUntilRef = useRef(0);
  /**
   * 标记一次打字机平滑写入。**只在"我们主动发起 smooth 动画"的三处调用**：
   * 1. `scrollCursorToCenter`（其后的 writeScrollTop，CM6/textarea 两条实现）
   * 2. `handleKeyUp` 的普通字符偏离中央分支
   * 3. 阅读面 `scrollToCenter`（ProseMirror）
   *
   * ⚠️ 用户滚轮 / 拖动滚动条 / instant 恢复 / 预览开合冻结还原**都不开窗**，
   * 因此双向联动的响应速度与 `isRestoringScrollRef` / `inHistoryScrollGuard`
   * 两道历史防线语义**一行未改**。
   */
  const markTypewriterSmooth = useCallback(() => {
    typewriterSmoothUntilRef.current = performance.now() + TYPEWRITER_SMOOTH_WINDOW_MS;
  }, [TYPEWRITER_SMOOTH_WINDOW_MS]);

  /**
   * v0.17.2 问题1：判断"右屏当前 scrollTop 是否就是我刚写下去的值"的取整容差（px）。
   *
   * `scrollTop` 在 DPR≠1 与亚像素布局下会被浏览器取整到 1/64 或 0.5 的倍数，
   * 读回来与写进去可能差不到 1px。取 2px：
   * - 足够吸收取整/亚像素误差；
   * - 远小于用户滚一格滚轮的位移（默认 ≥ 40px），不会把真实滚动误判成回声。
   */
  const PROGRAMMATIC_ECHO_EPSILON_PX = 2;


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
  //   · 编辑/分屏左侧 → 内容锚点（视口顶部字符偏移 + 视口 Y）
  // 内容不足一屏（无可滚动空间）时两个 capture 都返回 null，安全跳过。
  //
  // ⚠️ v0.17.0 P1-3：源码侧锚点改经 `sourceGeometry`（类型判定分派）。
  // 原写法 `const ta = …; const textAnchor = ta ? captureTextAnchor(ta) : null;`
  // 在 CM6 下拿到 div（truthy）→ 进函数 → 读 `div.value` 得 undefined → 返回 null。
  // **结果看似"没锚点就跳过"（无害），实际是"排版补偿在 CM6 下从未生效"**
  // —— 这正是 C 流实测"改行高/内容宽度后视觉位置丢 5–12 行"的机制缺口。
  const captureTypographyAnchor = useCallback(() => {
    const container = viewMode === "preview" && isMdFile ? editorRef.current : null;
    const blockAnchor = container ? captureAnchor(container, ".ProseMirror > *") : null;
    /**
     * ⚠️ v0.17.0 P1-3：`ta` 必须经**类型判定**取得（不是 `sourceTextareaRef.current`）。
     *
     * 旧写法 `const ta = isSourceMode ? sourceTextareaRef.current : null;` 声明类型是
     * `HTMLTextAreaElement | null`，CM6 下拿到的却是 `<div>`（truthy）→
     * `ta ? captureTextAnchor(ta) : null` **进了函数**、读 `div.value` 得 undefined、
     * 返回 null。于是表面上"没锚点就跳过"（无害），**实际上排版补偿在 CM6 下从未生效**
     * —— 这正是 C 流实测"改行高/内容宽度后视觉位置丢 5–12 行"的机制缺口。
     *
     * `sourceGeometry.realTextarea()` 内部就是 `typeof el.value === "string"` 判定，
     * 返回 **类型为真的** `HTMLTextAreaElement | null` —— 这里 `ta ? … : …` 因此是
     * 一次**真·类型分派**，而不是"div 恰好 truthy"的巧合。
     */
    const ta = isSourceMode ? sourceGeometry.realTextarea() : null;
    const textAnchor = ta
      ? captureTextAnchor(ta)
      : isSourceMode
        ? sourceGeometry.captureAt(0)
        : null;
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
  }, [viewMode, isMdFile, isSourceMode, previewShown, sourceGeometry]);


  const restoreTypographyAnchor = useCallback(
    (anchor: ReturnType<typeof captureTypographyAnchor>) => {
      if (anchor.container && anchor.blockAnchor) restoreAnchor(anchor.container, anchor.blockAnchor);
      // 真 textarea 走既有 mirror 还原；CM6 走 surface（`coordsAtPos` / 行轴估算）
      if (anchor.ta) restoreTextAnchor(anchor.ta, anchor.textAnchor);
      else sourceGeometry.restore(anchor.textAnchor);
      // v0.12.2 P8：分屏右侧 iframe 同步补偿
      if (anchor.iframeScroller && anchor.iframeBlockAnchor) {
        restoreAnchor(anchor.iframeScroller, anchor.iframeBlockAnchor);
      }
    },
    [sourceGeometry],
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
  //
  // ⚠️ v0.17.0 P1-3：**CM6 分支此前完全不存在**（旧写法 `const ta = sourceTextareaRef.current;
  // if (!ta) return;` 拿到 div 后继续执行，`captureTextAnchor(div)` 是空操作）。
  // 现在按类型判定分成两条**都真的会生效**的路径：
  //   · 真 textarea → 原 mirror 实现，一行未改；
  //   · CM6 宿主   → `ResizeObserver` 观察宿主 div（它本来就是真实元素），
  //                  锚点/还原走 `sourceGeometry`，滚动订阅走 `sourceSurface.onDidScroll`
  //                  （CM6 的滚动发生在 `view.scrollDOM` 上，绑宿主 div 收不到事件）。
  useEffect(() => {
    if (!isSourceMode) return;
    const host = sourceGeometry.host();
    if (!host || typeof ResizeObserver === "undefined") return;
    /** 真 textarea（类型判定）；CM6 下为 null —— 下面的 mirror 快路径只对它生效 */
    const ta = sourceGeometry.realTextarea();
    const captureAnchorNow = () => sourceGeometry.captureAt(0);
    textAnchorRef.current = captureAnchorNow();
    let suppressUntil = 0;
    let lastWidth = sourceGeometry.metrics().clientWidth;
    let captureTimer: ReturnType<typeof setTimeout> | null = null;
    const markResize = () => { suppressUntil = performance.now() + 350; };
    const captureSoon = () => {
      if (captureTimer) clearTimeout(captureTimer);
      captureTimer = setTimeout(() => { textAnchorRef.current = captureAnchorNow(); }, 150);
    };
    const scheduleCapture = () => {
      if (performance.now() < suppressUntil) return;
      captureSoon();
    };
    const ro = new ResizeObserver(() => {
      const w = sourceGeometry.metrics().clientWidth;
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
          captureSoon();
          return;
        }
        if (!suppressed && widthChanged) {
          if (ta) restoreTextAnchor(ta, textAnchorRef.current);
          else sourceGeometry.restore(textAnchorRef.current);
        }
        // 还原后重新捕获（延迟，避免与后续 RO 抢跑）
        captureSoon();
        // v0.12.0 返修：overlay 的内容宽度在渲染时固化（syncTextareaMetrics），
        // 宽度变化后必须重绘，否则 ghost / 续写预览会按旧宽度换行（视觉竖排偏移）
        if (widthChanged) formatGhostHandlersRef.current.render();
      });
    });
    /**
     * 观察谁：
     * - 真 textarea → 观察它（原行为，宽度变化的直接载体）；
     * - CM6 → 观察**宿主 div**（`host` 是真实元素，且宽度变化同样体现在它身上；
     *   之前 `if (ta) ro.observe(ta)` 在 CM6 下意味着**既没观察也没补偿**）。
     */
    ro.observe(ta ?? host);
    window.addEventListener("resize", markResize);
    /**
     * 滚动订阅：textarea 绑元素；CM6 必须绑 `view.scrollDOM`（宿主 div 不滚）。
     * 这就是 `SourceSurface.onDidScroll` 存在的理由（接口注释已写明）。
     */
    const offScroll = sourceSurface.onDidScroll(() => scheduleCapture());
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", markResize);
      offScroll();
      if (captureTimer) clearTimeout(captureTimer);
    };
  }, [isSourceMode, viewMode, forceUpdateKey, sourceGeometry, sourceSurface]);


  // v0.12.0 需求5：缩放（字号换算）变化后按内容锚点还原 textarea 滚动位置。
  // 字号/缩放变化后行高与换行都变，像素 scrollTop 不变会让视口跳到别处；
  // 用"视口顶部内容偏移"还原，视觉上视口顶部内容保持不动。
  //
  // ⚠️ v0.17.0 P1-3：旧写法 `const ta = sourceTextareaRef.current; if (!ta) return;`
  // 在 CM6 下拿到 div（非 null）→ 继续执行 → `restoreTextAnchor(div, …)` 读
  // `div.value` 得 undefined → 内部 `if (!text) return` 恰好兜住 → **静默空操作**。
  // 现在真 textarea 走原路，CM6 走 surface（`coordsAtPos` + 行轴估算）。
  useEffect(() => {
    if (!isSourceMode) return;
    const ta = sourceGeometry.realTextarea();
    const raf = requestAnimationFrame(() => {
      if (ta) restoreTextAnchor(ta, textAnchorRef.current);
      else sourceGeometry.restore(textAnchorRef.current);
      textAnchorRef.current = sourceGeometry.captureAt(0);
    });
    return () => cancelAnimationFrame(raf);
  }, [docZoom, isSourceMode, sourceGeometry]);


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
          /**
           * v0.17.0 第四轮 · 用户第 4 项：阅读面打字机的 smooth 也要开窗。
           *
           * 阅读面虽然不驱动分屏右屏（它就是右屏本身），但**编辑模式下右屏
           * 用的是同一份 iframe**；不在这里开窗会让"阅读↔编辑"两条路径的
           * 分屏联动行为不一致，将来排查时无法用同一套判据。语义上仍成立：
           * 这确实是一次"我们的平滑动画"，期间右→左回声不该反向接管。
           */
          markTypewriterSmooth();
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

      /**
       * ## ═══ v0.17.0 R3 · 用户第 1 项：Backspace 不能走"恢复旧 scrollTop"分支 ═══
       *
       * ### 缺陷（A/B 单变量 + 写入打桩实测）
       * 用户：「阅读模式下开启打字机模式使用退格键删除文字时，页面会抖动。」
       *
       * | 组 | scrollTop 单帧最大跳变 | 方向反转 | 写入次数 |
       * |---|---|---|---|
       * | 打字机开 | **1442px** | **29** | **30** |
       * | 打字机关 | **0px** | **0** | **0** |
       *
       * 打桩抓到两笔**互相独立**的写入：
       * ```
       * 1442 → 1433  [scrollTo(smooth)]  我们的 scrollToCenter（打字机居中）
       *    0 → 1442  [scrollTop=]        CM6 内部 measure
       * ```
       * 单变量：把我们的 `scrollTo` 打桩成不执行 → **「归 0」仍然存在**
       * ⇒ 归 0 是**原生/CM6 滚动**，不是我们写的（两笔要分开归因）。
       *
       * ### 根因
       * `Backspace` **不在** `isTypewriterTriggerKey` 的 NAV_KEYS 里
       *（只有 Enter/Arrow/PageUp/PageDown/Home/End）⇒ 退格走"**普通字符输入**"分支：
       * ```
       * if (diff <= 5) { scrollContainer.scrollTop = savedScrollTop; return; }   ← 恢复旧像素
       * ```
       * 但删字会让**内容变短** → CM6 重新排版 → 浏览器把 `scrollTop` 往新坐标系钳位。
       * 我们随后把**旧像素**写回去，下一帧 CM6 又钳一次 → **两个写者往复**
       *（与 #12 同一类机制）。
       *
       * 实测「时跳时不跳」正对应 `diff <= 5` 判据在删字场景下**是否恰好成立**，
       * 于是表现为 29 次方向反转而不是稳定抖动。
       *
       * ### 为什么修法不是"把 Backspace 加进 NAV_KEYS"
       * 试过：加了之后退格改走"每次重新居中"，**更差** ——
       * 实测 30 次反转、且 `caretY` 净漂移 **+1400px**（视口被一路推下去）。
       * 因为退格的语义是"往回删"，把它当导航键会让打字机每次都试图重新居中，
       * 而内容同时在变短 → 目标值每帧都在动。**该实验已回退**。
       *
       * ### 采用的修法
       * 退格时**不恢复旧 `scrollTop`**（不让两个写者打架），
       * 但保留"光标离开视口时拉回可见"这一层保护（真正的可用性下限）。
       * 语义上：删字后视口跟随浏览器/CM6 的钳位结果（那是渲染事实），
       * 我们只在光标真的跑出视口时才出手。
       */
      const isBackspace = e.key === "Backspace";

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
        /**
         * 同行输入：恢复 scrollTop，防止 dispatchTransaction 后的异步 scrollIntoView。
         *
         * ⚠️ v0.17.0 R3 · 第 1 项：**退格不走这条路**。
         * 退格会让内容变短 → CM6 重排 → `scrollTop` 被钳到新坐标系；
         * 我们把旧像素写回去 → 下一帧 CM6 又钳 → 两个写者往复（实测 1442px / 29 次反转）。
         * 所以退格时**只接受浏览器的结果**，见下面 `isBackspace` 分支。
         */
        if (!isBackspace && scrollContainer.scrollTop !== savedScrollTop) {
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
          // ⚠️ 同上：退格不恢复（内容变短时旧像素已失效）
          if (!isBackspace && scrollContainer.scrollTop !== savedScrollTop) {
            scrollContainer.scrollTop = savedScrollTop;
          }
          return;
        }
      }

      /**
       * 触发滚动：导航键 或 光标在视口外。
       *
       * ⚠️ v0.17.0 R3 · 第 1 项：退格**也不触发居中**。
       * 试过把 Backspace 加进 NAV_KEYS（改走 `scrollToCenter`）——**更差**：
       * 实测 30 次反转、`caretY` 净漂移 +1400px。因为退格每次都在缩短内容，
       * 居中目标值每帧都在变，等于让打字机追一个移动靶。
       * 退格时唯一该保证的是"光标仍可见"，那由浏览器原生行为 + `cursorWasOutside`
       * 分支（上方）负责，不需要我们再居中。
       */
      if (isBackspace) return;
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
    /**
     * ═══ v0.17.0 P1-3：源码面打字机在 CM6 下的接线（迁移回归修复）═══════════
     *
     * ## 缺陷（实测）
     * 光标距中线 425px → 开打字机（开关值已 true）→ 仍 425px；敲字后
     * `scrollTop` 全程 **0→0**。即「开了打字机但源码面毫无反应」。
     *
     * ## 根因：**迁移回归**，不是 CM6 本来没这个能力
     * 旧实现取 `const textarea = sourceTextareaRef.current; if (!textarea) return;`
     * —— CM6 下拿到的是 `<div class="source-editor-cm6">`（**非 null**），
     * 于是代码继续执行，但：
     *   ① `measureTextareaCursorY(div)` 建 mirror 复刻 textarea 排版 → 读 `div.value`
     *      得 undefined → 无输出；
     *   ② `div.clientHeight / scrollHeight / scrollTop` 是**宿主 div 的**，
     *      而 CM6 真正的滚动容器是 `view.scrollDOM`（宿主 div 的 `scrollHeight
     *      === clientHeight`，即"无可滚动空间"）→ `computeTypewriterScrollTop`
     *      直接返回 null；
     *   ③ 事件绑在宿主 div 上 —— CM6 的 keydown/keyup 发生在 `.cm-content` 内部，
     *      **会冒泡到宿主**，所以这一条其实还能工作（`sourceGeometry.host()` 同样绑它）。
     *
     * ## 修法（与专注遮罩 `e694d0b`/`88868f4` 完全同一套）
     * **机制一行未改**（`computeTypewriterScrollTop` 纯函数、5px 抖动阈值、
     * smooth/instant 取舍、keydown 基线恢复、`isRestoringScrollRef` /
     * `inHistoryScrollGuard` 闸门全部照搬）—— 只换三样"从哪来/写到哪"：
     *   · 光标内容坐标 Y → `sourceSurface.offsetToContentY(offset)`（CM6 用 `coordsAtPos`）
     *   · 视口尺寸/滚动位置 → `sourceSurface.getMetrics()` / `getScrollTop()`
     *   · 写滚动 → `sourceSurface.setScrollTop()`
     *
     * ## 「抑制 textarea 自动滚动」那套 keydown/keyup 监听还要不要？
     * **keydown 基线 + keyup 判定必须保留**（不只是为了抑制自动滚动）：
     * 它是打字机的**触发入口** —— 用户敲字/按方向键后要即时居中，靠的就是它。
     * 但"抑制浏览器 scrollIntoView"这个**动机**在 CM6 下不成立：
     * CM6 自己的 `scrollIntoView` 由事务驱动，`setSelection(…, scrollIntoView:false)`
     * 与宿主的事务策略already 管住了，我们额外的 instant 回写反而会与它抢。
     * 因此分支这样分：
     *   · 真 textarea → **原样保留** instant 恢复（抑制原生 scrollIntoView，v0.7.x 的修复）；
     *   · CM6 → 只在"确实需要居中"时写一次 smooth，**不再做 instant 回写**
     *     （CM6 没有"input 后同步 scrollIntoView"那个时序，回写只会引入抖动）。
     */
    const host = sourceGeometry.host();
    if (!host) return;
    /** 真 textarea（类型判定）—— 只有它需要 mirror 测量与"抑制自动滚动"那套 */
    const textarea = sourceGeometry.realTextarea();
    /**
     * 滚动器：textarea → 元素本身；CM6 → 无独立元素，一律经 surface 读写。
     * （CM6 的真实滚动容器是 `view.scrollDOM`，宿主 div 不滚 —— 直接读宿主
     *  的 scrollTop/scrollHeight 会得到"无可滚动空间"的假象。）
     */
    const readMetrics = () =>
      textarea
        ? { scrollTop: textarea.scrollTop, scrollHeight: textarea.scrollHeight, clientHeight: textarea.clientHeight }
        : {
            scrollTop: sourceSurface.getScrollTop(),
            scrollHeight: sourceGeometry.metrics().scrollHeight,
            clientHeight: sourceGeometry.metrics().clientHeight,
          };
    /**
     * 写滚动位置：textarea 需要 behavior 控制；surface 只有像素接口。
     *
     * ## ═══ v0.17.0 第三轮 · 用户第 8 项：`behavior` 被静默丢弃（机制级根因）═══
     *
     * ### 缺陷现象
     * 「编辑模式下开启打字机模式，画面居中时要跟阅读模式一样，要有平滑的移动效果，
     *  而不是突然页面就居中，而且回车换行时画面也应该平滑移动。」
     *
     * ### 根因（不是阈值问题 —— 这一条推翻了"5px 阈值导致突然居中"的假设）
     * 上一版本函数是：
     * ```ts
     * if (textarea) { textarea.scrollTo({ top, behavior }); return; }
     * sourceSurface.setScrollTop(top);      // ← behavior 在这里被丢弃
     * ```
     * 而 `CmSourceSurface.setScrollTop` 是**裸赋值** `scrollDOM.scrollTop = px`
     * = 瞬时。阅读面（ProseMirror）走 `scrollTo({ behavior: "smooth" })` 一直是平滑的。
     * 于是**同一份打字机逻辑，两种实现两种观感**：阅读面平滑、源码面瞬移。
     * 这与 `computeTypewriterScrollTop` 的 5px 阈值**无关**（阈值只决定"要不要滚"，
     * 不决定"怎么滚"）。
     *
     * ### 修法
     * 经接口的**可选**平滑能力 `setScrollTopSmooth`（见 `src/editor/types.ts` 的注释，
     * 那里写了为什么**不能**给 `setScrollTop` 加 behavior 参数 ——
     * 几十处恢复类调用点必须保持 instant，否则会重演
     * "smooth 覆盖 applyScroll 的 instant → 模式切换后滚动位置丢失"那个历史 bug）。
     *
     * ⚠️ 既有 `writeScrollTop(x, "instant")` 的调用点语义**一行没变**：
     * - 有 `setScrollTopSmooth` → 传 `"instant"`，实现内部就是裸赋值；
     * - 没有（第三方/测试替身）→ 退回 `setScrollTop`（同样是 instant）。
     */
    const writeScrollTop = (top: number, behavior: "smooth" | "instant") => {
      if (textarea) {
        // 不设置 scrollBehavior = "smooth"，与 ProseMirror 模式保持一致：
        // 避免全局 CSS 影响所有滚动操作，改用 scrollTo({ behavior }) 显式控制
        textarea.scrollTo({ top, behavior });
        return;
      }
      // CM6：优先走平滑能力通道；实现缺失时退回即时写入（保持旧语义，不静默丢动画以外的行为）
      if (sourceSurface.setScrollTopSmooth) {
        sourceSurface.setScrollTopSmooth(top, behavior);
        return;
      }
      sourceSurface.setScrollTop(top);
    };

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
        const m = readMetrics();
        // 使用纯函数计算目标滚动位置（内置视口溢出检查和阈值抖动过滤）
        const target = computeTypewriterScrollTop(
          cursorY,
          m.clientHeight,
          m.scrollHeight,
          m.scrollTop,
        );
        if (target !== null) {
          /**
           * ⚠️ v0.17.0 第四轮 · 用户第 4 项：**必须在写之前开窗**。
           *
           * `writeScrollTop(target, "smooth")` 只在**动画开始**时写一次，
           * 之后位移全部由浏览器补间产生（没有 JS 写入）。所以窗口只能在这里开，
           * 由时间长度覆盖整个动画。若改成"每次 scroll 事件时续期"，
           * 窗口结束时刻会被不断推迟 → 右屏永远不写（比抖动更糟）。
           */
          markTypewriterSmooth();
          writeScrollTop(target, "smooth");
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
      savedScrollTop = readMetrics().scrollTop;
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
    //
    // ⚠️ v0.17.0 P1-3：「instant 恢复 savedScrollTop」这个动作**只对真 textarea 有意义**
    // （CM6 没有 input 后同步 scrollIntoView，回写只会把刚居中的位置再拉回去）。
    const isRealTextarea = textarea !== null;
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
          if (isRealTextarea) writeScrollTop(savedScrollTop, "instant");
          return;
        }
        const m = readMetrics();
        const target = computeTypewriterScrollTop(
          cursorY,
          m.clientHeight,
          m.scrollHeight,
          savedScrollTop,
        );
        if (target !== null) {
          // 光标偏离中央超过阈值（软换行等场景），smooth 滚动到中央
          // v0.17.0 第四轮 · 用户第 4 项：同样要开窗（理由见 scrollCursorToCenter 处）
          markTypewriterSmooth();
          writeScrollTop(target, "smooth");
        } else if (isRealTextarea) {
          // 光标在中央附近（同行输入），instant 恢复 savedScrollTop，抑制浏览器自动滚动。
          // CM6 下不写：它没有"input 后同步 scrollIntoView"这个时序，
          // 回写只会把 CM6 自己维护的光标可见性策略打乱（且会与上面的 smooth 抢）。
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

    host.addEventListener("keydown", handleKeyDown);
    host.addEventListener("keyup", handleKeyUp);
    host.addEventListener("click", handleClick);
    host.addEventListener("blur", handleBlur);
    // 打字机模式开启时，初始居中
    // 但模式切换时跳过：applyScroll 正在恢复滚动位置，scrollCursorToCenter 的 smooth
    // 滚动会覆盖 applyScroll 的 instant 设置（smooth 是异步多帧的）
    // 修复快捷键切换模式时滚动位置丢失 bug
    if (!shouldSkipInitialScrollToCenter(isRestoringScrollRef.current, typewriterModeRef.current)) scrollCursorToCenter();

    return () => {
      host.removeEventListener("keydown", handleKeyDown);
      host.removeEventListener("keyup", handleKeyUp);
      host.removeEventListener("click", handleClick);
      host.removeEventListener("blur", handleBlur);
    };
  }, [typewriterMode, viewMode, forceUpdateKey, sourceGeometry, sourceSurface]);


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
    /**
     * ═══ v0.17.0 P1-3：冻结分支的**第二处同源缺陷**（"结果巧合、机制未生效"）═══
     *
     * 旧写法：
     * ```ts
     * const textarea = sourceTextareaRef.current;
     * if (!textarea) return;                       // CM6 下是 div（非 null）→ 不 return
     * const frozenTop = textarea.scrollTop;         // 读的是**宿主 div** 的 scrollTop（恒 0）
     * const anchor = captureTextAnchor(textarea, textarea.clientHeight / 2);  // 空操作
     * ```
     * 后果：A 流 E1「关/开预览后左屏位置保留，Δ=0px」判 PASS，**其实是巧合**
     * （开合只改宽度、宿主 div 的 scrollHeight 未变、浏览器没有钳位），
     * 一旦宽度变化引起重排就会暴露。这类「结果对了但机制没跑」的 PASS 比 FAIL 更危险
     * —— 它会给后续维护者虚假信心（缺陷详报 §6 的原话）。
     *
     * 现在：
     * - `ta` 经**类型判定**（CM6 下为 null），镜像/锚点路径只对它生效；
     * - `host` 是事件宿主（CM6 下事件从 `.cm-content` 冒泡上来，滚轮/按键都能收到）；
     * - 读像素/写像素/采锚/还锚一律经 `sourceGeometry`（CM6 走 `scrollDOM` + `coordsAtPos`）。
     */
    const host = sourceGeometry.host();
    if (!host) return;
    /** 真 textarea（类型判定）；CM6 下为 null —— 下面的 mirror 路径只对它生效 */
    const ta = sourceGeometry.realTextarea();
    // 记录开合前的滚动像素与**视口中央内容锚点**。
    // 必须用 layout effect：此时 DOM 已提交、浏览器尚未绘制，宽度过渡还没走第一帧，
    // 读到的 clientWidth/scrollTop 仍是用户眼前的真实状态。
    const frozenTop = sourceGeometry.scrollTop();
    const frozenMetrics = sourceGeometry.metrics();
    const frozenMax = Math.max(0, frozenMetrics.scrollHeight - frozenMetrics.clientHeight);
    // 是否"在底部"：滚动位置距 max 不足 2px 视为贴底（用户拖动到底时的亚像素误差）
    const atBottom = frozenMax > 0 && frozenTop >= frozenMax - 2;
    // 顶部同理：贴顶时用户期望继续贴顶，中央锚点反而会把文档往下推
    const atTop = frozenTop <= 2;
    // 非底部/顶部才取中央锚点：两端由 atBottom/atTop 单独处理
    const anchor = atBottom || atTop
      ? null
      : ta
        ? captureTextAnchor(ta, ta.clientHeight / 2)
        : sourceGeometry.captureAt(frozenMetrics.clientHeight / 2);
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
    host.addEventListener("wheel", abort, { passive: true });
    host.addEventListener("pointerdown", abort, { passive: true });
    host.addEventListener("touchstart", abort, { passive: true });
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
    host.addEventListener("keydown", onKeyDown);
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
     * - 非底部且有中央锚点 → 把"中央那行文字"拉回中央
     *   （宽度过渡每一帧都调用，长段落重排后仍锁定同一内容）；
     * - 测量不可用 → 退回原像素值（安全兜底）。
     *
     * ## ═══ v0.17.0 第三轮 · 用户第 12 项：**别跟 CM6 的 measure 对着拉** ═══
     *
     * ### 缺陷（逐帧 + scrollTop 写入打桩实测，`scripts/_tmp-toggle-writer.mjs`）
     * 开合期间同一帧里出现**两笔方向相反**的写入：
     * ```
     * 4788 → 4615   我们的 setScrollTop（还原到锚点）
     * 4615 → 4557   CM6 内部 On.measure（宽度变化后 heightMap 重估，它自己钳位）
     * 4557 → 4615   我们的 setScrollTop（又拉回来）
     * ```
     * 逐帧结果：`scrollTop` 单帧最大跳变 **231px**、**方向反转 4 次**。
     * 用户看到的就是"文档抖一下"。
     *
     * ### 为什么不能靠"每帧硬拉回"
     * CM6 的 `measure()` 是**渲染事实**：宽度变了 → 行高/软换行变了 → 滚动坐标系的
     * 换算基准变了，它必须钳位才不至于让视口悬在文档外。
     * 我们每帧都把它拉回"旧像素对应的位置"，它下一帧又钳一次 →
     * **两个写者互相覆盖**，形成 231px 的往复。这正是 R2 「多个写入者」教训的又一次复用。
     *
     * ### 采用的策略：**接受钳位，但守护内容**
     * 1. 写完立刻**回读真实值**（浏览器/CM6 可能钳位）；
     * 2. 用**内容锚**（视口中央那一行的字符偏移）复核：钳位后中央内容是否还落在
     *    `TOLERANCE_PI` 段以内；
     * 3. 只有**真的偏离**时才补一次修正，并把目标夹到 `[0, max]` 的合法区间。
     *
     * 这样：CM6 钳位不会被打断（无往复），而用户视野也不会被拽到别处
     *（偏离超阈值仍然纠正 —— 满足"保住下限"的要求）。
     */
    /**
     * 钳位容忍度：目标位置与"CM6 钳位后的真实位置"相差超过这么多**像素**才补修正。
     *
     * 为什么必须有容忍度、且不能是 0（这是本项的核心取舍）：
     * 宽度过渡期间 CM6 每帧都要 `measure()`。它按**渲染事实**钳位 scrollTop，
     * 我们若每帧把它拽回"旧像素对应的位置"，就形成两个写者互相覆盖 ——
     * 实测 `scrollTop` 单帧跳变 **231px**、方向反转 **4 次**（用户看到的"抖"）。
     *
     * 取值依据：一行 ≈ 28.8px（默认字号），2 行 ≈ 58px，取 **60px** 作为
     * "用户能明显察觉视口跑偏"的门槛。低于它的钳位一律**接受**
     *（CM6 的测量比我们的像素换算更接近渲染事实）。
     */
    const CLAMP_TOLERANCE_PX = 60;

    /**
     * 本帧是否已经写过一次（每帧最多写一次）。
     *
     * ## 为什么需要"每帧一写"上限（实测决定性证据）
     *
     * 逐帧 + scrollTop 写入打桩（`scripts/_tmp-toggle-writer.mjs`）抓到，关闭预览期间
     * **同一段窗口内两方交替写了 7 次**：
     * ```
     * 4788 → 4615   我们 setScrollTop
     * 4615 → 4557   CM6 Tn.measure   ← 按新布局钳位
     * 4557 → 4471   CM6 Tn.measure
     * 4471 → 4442   我们 setScrollTop  ← 又拉
     * 4442 → 4558   我们 setScrollTop  ← 反方向再拉（阈值判断抖动导致的来回）
     * ```
     * 我们是 `rAF 链 ×3 + 260ms + 620ms + 1020ms` 五个入口，
     * 而 CM6 的 `measure()` 也在同一时间段跑 —— 写入次数越多，往复越多。
     *
     * 因此：**每个动画帧最多写一次**，把写者数量降到最低。
     * CM6 的 measure 仍然可以写（它是渲染事实），我们只负责"偏太多时纠一次"。
     */
    let lastWriteFrame = -1;
    const canWriteThisFrame = () => {
      const f = Math.round(performance.now() / 16);
      if (f === lastWriteFrame) return false;
      lastWriteFrame = f;
      return true;
    };

    /**
     * 只在**真的偏了**的时候还原（而不是每帧无条件还原）。
     *
     * @param force finalize 时用 true：无论如何都还原一次（收尾必须是精确的）
     */
    const restore = (force = false) => {
      if (cancelled || abortedByUser) return;
      // 确认窗口确实还属于本次（复开关时会被新值覆盖 → 交给最新那次）
      const cur = scrollFreezeRef.current;
      if (!cur || cur.until !== until) return;
      // 非收尾的中间帧：每帧最多写一次（见 canWriteThisFrame 的注释）
      if (!force && !canWriteThisFrame()) return;
      const m = sourceGeometry.metrics();
      isFrozenRestoreRef.current = true;
      try {
        if (cur.atBottom) {
          const max = Math.max(0, m.scrollHeight - m.clientHeight);
          if (force || Math.abs(sourceGeometry.scrollTop() - max) > CLAMP_TOLERANCE_PX) {
            sourceGeometry.setScrollTop(max);
          }
          return;
        }
        if (cur.anchor) {
          /**
           * 先算"把锚点送回原位"需要写多少（不写），再决定要不要写。
           *
           * 这与"先写再回读"不同：写一次就已经产生了视觉位移，
           * 哪怕随后又拉回来，用户也看到了那一帧的抖。所以**先算后写**。
           */
          const want = sourceGeometry.scrollTopForAnchor(cur.anchor);
          const now = sourceGeometry.scrollTop();
          if (want !== null && (force || Math.abs(now - want) > CLAMP_TOLERANCE_PX)) {
            // 夹到合法区间，避免把越界值交给 CM6 再被它钳一次（又是一次可见跳变）
            const max = Math.max(0, m.scrollHeight - m.clientHeight);
            sourceGeometry.setScrollTop(Math.max(0, Math.min(max, want)));
          }
          return;
        }
        const max = Math.max(0, m.scrollHeight - m.clientHeight);
        const target = Math.min(Math.max(0, cur.scrollTop), max);
        if (force || Math.abs(sourceGeometry.scrollTop() - target) > CLAMP_TOLERANCE_PX) {
          sourceGeometry.setScrollTop(target);
        }
      } finally {
        isFrozenRestoreRef.current = false;
      }
      // 记录写入后的**真实**读数（浏览器可能钳位/取整），供诊断与测试断言
      cur.programTop = sourceGeometry.scrollTop();
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
      // 收尾必须是精确的 → force=true 绕过容忍度
      restore(true);
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
      // v0.17.0 P1-3：同一处同源缺陷（旧写法 `if (!ta) return;` 在 CM6 下拿到 div
      // 继续执行、`restoreTextAnchor(div, …)` 空操作）→ 现在经 `sourceGeometry` 分派。
      const m = sourceGeometry.metrics();
      isFrozenRestoreRef.current = true;
      try {
        if (atBottom) {
          const max = Math.max(0, m.scrollHeight - m.clientHeight);
          if (Math.abs(sourceGeometry.scrollTop() - max) > 0.5) sourceGeometry.setScrollTop(max);
        } else if (anchor) {
          if (ta) restoreTextAnchor(ta, anchor);
          else sourceGeometry.restore(anchor);
        } else {
          const max = Math.max(0, m.scrollHeight - m.clientHeight);
          const want = Math.min(Math.max(0, expected), max);
          if (Math.abs(sourceGeometry.scrollTop() - want) > 0.5) sourceGeometry.setScrollTop(want);
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
      /**
       * v0.17.0 P1-3：关窗时机靠 `ResizeObserver` 盯"内容高度变没变"。
       *
       * 旧写法 `const ta = sourceTextareaRef.current; if (ta) ro.observe(ta);`
       * 在 CM6 下观察的是**宿主 div**：它的 `scrollHeight === clientHeight`（不滚），
       * 内容变高体现在 `view.scrollDOM` 上 → **观察器永远收不到回调** →
       * 关窗只会按固定定时器走，实测 f≈1427ms 的 iframe 异步渲染写入就漏了。
       *
       * 现在：观察**真实滚动容器**——真 textarea 就是它自己；CM6 是宿主 div 也不行，
       * 因此改用「轮询式校验」：`restore()` 本身幂等且只读 surface metrics，
       * 由 rAF 链 + 定时器按 `PREVIEW_TOGGLE_SETTLE_MS` 的静默窗口判断即可。
       * 保留 `ro` 只为「真 textarea」这条既有实现（一行未改）。
       */
      const hostEl = ta; // 只有真 textarea 才具备"内容高度在自身 scrollHeight 上体现"的语义
      lastScrollHeight = ta ? ta.scrollHeight : sourceGeometry.metrics().scrollHeight;
      if (hostEl && typeof ResizeObserver !== "undefined") {
        ro = new ResizeObserver(() => {
          const cur = scrollFreezeRef.current;
          if (!cur || cur.until !== until) return;
          const sh = hostEl.scrollHeight;
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
        ro.observe(hostEl);
      }
      // 首次等待：固定窗口走完后再给一个"静默期"
      armSettle();
    }
    return () => {
      cancelled = true;
      restores.forEach((f) => f());
      host.removeEventListener("wheel", abort);
      host.removeEventListener("pointerdown", abort);
      host.removeEventListener("touchstart", abort);
      host.removeEventListener("keydown", onKeyDown);
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
      /**
       * ⚠️ v0.17.1 修复（用户问题1）：**`init` 必须等 body 真的就绪才提交**。
       *
       * ## 缺陷（真机复现，`scripts/v0171-lead-i1-cause.mjs`）
       * ```
       * 错误：TypeError: Cannot set properties of null (setting 'innerHTML')
       * 触发：打开含 mermaid / 数学公式的文档 → 双击 Ctrl 进编辑模式
       * ```
       * 实测时序（逐帧采样）：
       * ```
       * t=106ms  iframe 出现，contentDocument.readyState = "loading"
       * t=129ms  doc.body === null   ← 解析器停在 <head> 等 mermaid/katex 脚本
       * t=196ms  doc.body === null
       * t≈210ms  body 就绪
       * ```
       * 旧代码在 `doc.close()` **之后立刻**写 `previewIframeInitRef.current`（原先在
       * 本函数末尾无条件赋值），于是造出一个 **「init 已更新、body 仍为 null」** 的窗口。
       * 该窗口内只要跑第二次本 effect（依赖项任一变化），`needFullRewrite` 就会算出
       * `false` → 走**增量分支** → `doc.body.innerHTML = previewHtml` 对 null 赋值 → 抛错。
       *
       * ## 为什么只有「含 mermaid / 公式」的文档会崩
       * `needFullRewrite` 的首项是 `!init.mermaid && !init.math`：
       * 纯文本文档的 init 恒为 `{mermaid:false, math:false}` → 该式恒真 →
       * **每次都整篇重写**，结构上永远进不了增量分支。
       * 破坏性对照已验：同一操作换纯文本文档 `body===null` 帧数 = 0、不报错。
       *
       * ## 修法
       * 1. **把 init 提交推迟到 body 就绪那一刻**（找回来了也不会重复触发，幂等）——
       *    窗口内任何二次运行都会重新走整篇重写分支（安全路径）；
       * 2. 增量分支再加一道 body 守卫兜底（见下方 else 分支），保证即便未来
       *    有别的路径把 init 提前写脏，也不会对 null 赋值。
       *
       * 为什么不用"等 body 就绪再整篇重写"：那要重新 `doc.open()/write()` 一遍，
       * 会把刚加载的 mermaid/katex 脚本全部作废，代价远大于收益。
       */
      const commitIframeInit = () => {
        previewIframeInitRef.current = { mermaid: hasMermaid, math: hasMath, theme };
      };

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
          // ★ v0.17.1：body 就绪即视为本轮整篇重写**真正完成**，此时才允许后续走增量
          commitIframeInit();
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
        // 兜底：某些环境下 load 与 rAF 都拿不到就绪信号（如脚本被沙箱拦截），
        // 用一个宽松的轮询保证 init 最终仍会提交，不会让预览永远停在"每次整篇重写"。
        setTimeout(tagWhenBodyReady, 1000);
      }
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
      /**
       * v0.17.1 修复（用户问题1）——**增量分支的 null 守卫**。
       *
       * 走到这里说明 `needFullRewrite` 为假（init 认为"脚本该有的都有了"）。
       * 但如果 `doc.body` 仍为 null，就意味着这份 iframe 文档**还没解析到 body**
       * （正常情况已被上面的「init 推迟提交」拦住；这里是第二道兜底）。
       *
       * 对 null 赋 `innerHTML` 会抛
       * `TypeError: Cannot set properties of null (setting 'innerHTML')`，
       * 而该 effect 在**渲染期**抛错 → ErrorBoundary 接管整棵树 →
       * 用户看到「界面渲染出错」整屏（文档内容本身没坏，这正是提示语的由来）。
       *
       * 为什么要"把 init 打回未初始化 + 重新整篇重写"而不是直接 return：
       * 直接 return 会让预览停在**旧内容**上（body 就绪后也不会再被写），
       * 用户看到的是"右侧预览不更新"，比崩一下更难察觉。
       * 打回 init 后本次同步走整篇重写分支，语义正确且不再依赖时序。
       */
      if (!doc.body) {
        previewIframeInitRef.current = { mermaid: false, math: false, theme: "" };
        // 不再自己重画：把"这次增量写入"推迟到 body 就绪，然后原地补写一次。
        // 三种触发与整篇分支同款（load / rAF / 兜底定时器），幂等（重复写入同内容无害）。
        const doIncremental = () => {
          const d = iframe.contentDocument;
          if (!d || d !== doc || !d.body) return;
          if (!previewShown) return;
          d.documentElement?.style.setProperty("--doc-zoom", cv.docZoom);
          d.body.innerHTML = previewHtml;
          tagPreviewSourceLines(d.body, previewSourceMarkdown);
          bindPreviewLightbox(iframe);
          foldBridge.apply();
          requestPreviewRealignRef.current?.();
        };
        try {
          doc.defaultView?.addEventListener("load", () => requestAnimationFrame(doIncremental), { once: true });
        } catch { /* 跨源/已卸载：忽略，rAF 与定时器兜底 */ }
        requestAnimationFrame(doIncremental);
        setTimeout(doIncremental, 120);
        setTimeout(doIncremental, 1000);
        return;
      }
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
    /**
     * v0.17.0 P1-3：这一处旧写法是 `const textarea = sourceTextareaRef.current;`
     * （类型标注骗人，CM6 下是 div）。它在下面只被用于三件**与 DOM 元素有关**的事：
     * ① 绑 wheel/pointerdown/touchstart 判"用户接管"；② `ResizeObserver.observe`。
     * 旧代码两处都套 `if (textarea)`，CM6 下因此**双双跳过** →
     * 「realign 期间用户主动滚动的判定不生效」+「拖分割条不即时重对齐」。
     *
     * 现在：事件宿主用 `sourceGeometry.host()`（CM6 的事件从 `.cm-content` 冒泡到宿主，
     * 与 textarea 语义一致）；宽度变化观察**宿主 div**（宽度变化本来就体现在它身上）。
     * 真 textarea 得到的仍是它自己，行为不变。
     */
    const textarea = sourceGeometry.realTextarea();
    /** 事件/布局宿主：真 textarea 就是它自己；CM6 是中性 div（同样能收到冒泡事件） */
    const sourceHostEl = sourceGeometry.host();

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
         *
         * ═══ v0.17.0 P1-3：**本缺陷本体**（旧写法 `textarea ? … : …`）═══
         *
         * `textarea` 来自 `const textarea = sourceTextareaRef.current;`，其**标注类型**
         * 是 `HTMLTextAreaElement | null`，但 CM6 路径下装着 `<div class="source-editor-cm6">`
         * —— div 是 **truthy（非 null）**，于是这个三元**永远走左边**：
         *
         * ```
         * ① 判真 → 走 textareaMeasureSource(div)
         * ② 其内部 measureSourceLineAxis 读 div.value → undefined → 首行守卫返回 null
         * ③ 行轴 axis = null
         * ④ estimateTopSourceLine 的 `lineTops === undefined` → 退回纯线性公式
         *    （软换行感知归零）
         * ⑤ 右屏位置 = 总行数 × 滚动百分比 → 与左屏真实内容脱钩
         * ```
         *
         * 决定性证据（缺陷详报 §1.3）：线性公式预测 56.7/114/171/228 vs 实测右屏顶块
         * 55/114/170/228（差 ≤1.7 行）—— **行轴一行都没被使用**。
         * 最荒诞的地方：`surfaceMeasureSource`（专为 CM6 写的 `lineBlockAt` 实现，
         * 含完整的「视口内实测 + 视口外估算」R2 处置）**写好了，但永远不会被调用**。
         *
         * ## 为什么不写 `textarea ? … : …` 的"修好版"
         * 正确的类型判定是 `typeof el.value === "string"`（项目范式：`SourcePane.tsx:454`），
         * 而不是"有没有值"。本文件把它收在 `sourceGeometry.realTextarea()` 里，
         * 并把 **CM6 分支写成 `else` 的默认路径** —— 这样"忘写 CM6 分支"在结构上
         * 不可能发生（不是靠人记得写三元）。
         *
         * 同时**保留** textarea 的 mirror 快路径（真 textarea 下行为与 v0.16.0 逐字节一致），
         * 只有明确判定"不是真 textarea"时才走 surface 源。
         */
        const realTextarea = asRealTextarea(textarea);
        const source = realTextarea
          ? textareaMeasureSource(realTextarea)
          : surfaceMeasureSource(sourceSurface);
        markAxisSource(realTextarea ? "textarea" : "surface");
        const measured = measureLineAxis(
          source,
          topLevelBlockStartLines(previewSourceMarkdown),
          reportAxisDegrade,
        );
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
    /**
     * 上一次"已被接受"的右屏目标值 + 当时的左屏 scrollTop。
     *
     * ## 为什么要记这两个数（本轮最关键的判据来源）
     * 前两种判据都试过、都拦不住那个 +188px 猛跳：
     * - **自洽性校验**（正向映射→逆映射回源码行）**无效** —— 锚点表整体平移后，
     *   正向与反向是同一张表的互逆运算，反算回去仍然"自洽"。
     * - **看 `tags` / `scrollHeight`** 也无效 —— 实测这两者全程恒定
     *   （`tags=61`、`iframe scrollHeight=6130` 一帧都没变），表已经被换成另一套几何了。
     *
     * 唯一还站得住的判据是**物理约束**：两屏是同一份内容的两种排版，
     * 左屏平移 `ΔL` 像素时右屏只应在 `ΔL × 高度比` 同量级移动。
     * 实测那次猛跳：左屏 **+13px**，右屏 **+188px** = 14.5 倍，物理上不可能。
     * （块锚点映射在正常时比值 ≈ 0.68，见右屏 20px / 左屏 28px 的实测。）
     *
     * ## ═══ v0.17.0 P1 返修：两个基准**每帧都更新（含被钳制的帧）** ═══
     * 旧二值拒绝在拒写时不动基准 → `dLeft` 从陈旧基准累积、`allowed` 越攒越大
     * → 累计跳变整包放行（延迟释放，实测单帧最大 46px + 1 次方向反转）。
     * 连续钳制下基准跟帧走，"欠账"每帧清偿，陈旧基准不可能出现。
     */
    let lastAcceptedPreviewTarget: number | null = null;
    let lastAcceptedSourceTop = 0;

    /**
     * ## ═══ v0.17.2 问题1：**右屏程序写入的"回声"必须被识别出来** ═══
     *
     * ### 缺陷（真机 trace 取证，`scripts/_lead-i1d-writestack.mjs`）
     * 用户文档（含大表格）「阅读 50% → 双击 Ctrl 进编辑」后，左屏被写回文档顶部：
     * ```
     * t=13284 cm   5 → 8127.3   ← res-source（模式切换恢复，**正确**）
     * t=13317 cm 8127 → 8103.9  ← CM6 measure（-23px，正常）
     * t=13754 cm 8104 → 3.9     ← HTMLDocument.Ne ★★★ 罪魁祸首
     * t=14290 cm    4 → 5       ← 再被写成 5
     * ```
     * 栈里的 `HTMLDocument.Ne` 经符号核对就是本文件的 `syncToSource`（绑在
     * iframe 的 `contentDocument` 上，捕获阶段）。也就是说：
     *
     * 1. 我们恢复左屏 → 左屏 scroll → `syncToPreview` 写右屏；
     * 2. 右屏（iframe 内部文档）的 scroll 事件**经跨文档队列晚 ~437ms 才到**
     *    （本文件 `syncToPreview` 的注释里早已记录过这个延迟，实测 140~440ms）；
     * 3. 到达时方向锁 `SPLIT_SCROLL_LOCK_MS = 250ms` **早已过期** →
     *    `shouldAcceptScroll` 判成"用户滚了右屏" → `syncToSource` 反算源码行；
     * 4. 而此刻右屏刚被建出来、`scrollTop` 还在 0~80 附近（`preview-realign`
     *    的 bounded-chase 正在从 0 往 11651 爬）→ 反算出**源码第 0 行**
     *    → 把左屏写成 ~4px。
     *
     * ⇒ 用户感知正是「来回几次切换，阅读进度丢失，直接跳到文档顶部」。
     * 而且这不是"偏一点"：一旦左屏被写成 0，下一轮切换的锚点就是顶部，
     * 于是**永久丢失**（i1 探针 6/6 轮全部 top=0，且 localStorage 进度被冲成 0.0002）。
     *
     * ### 为什么不能只靠"加大方向锁窗口"
     * 那条路会被否掉（见 `syncToPreview` 注释里"试过但否掉的修法②"）：
     * 锁是**全局共享语义**，调大会把"用户真的切去滚右屏"也判成回声 →
     * 双向联动出现最长 N 百毫秒死区。而且跨文档延迟本身随内容/机器浮动，
     * 任何固定窗口都只是把概率往后推。
     *
     * ### 修法：不猜时间，**按值识别自己的写入**
     * 右屏的所有程序写入都收敛在 `syncToPreview` 的 `preview.scrollTop = target`
     * 这一行（`realignLayoutNow` 也走同一个入口）。把"我们最后写下的值"记下来，
     * `syncToSource` 见到右屏当前值与它一致 → **这就是回声，不是用户滚动**，直接忽略。
     *
     * 判据强度：只认"值相等"（±{@link PROGRAMMATIC_ECHO_EPSILON_PX} px 取整误差），
     * 用户真去滚右屏几乎不可能正好停在我们写下的同一像素上；
     * 即使偶然撞上，下一次滚动事件就会正常接管 —— 失败方向是"少同步一次"，
     * 而不是"把阅读进度清成 0"。
     */
    let lastProgrammaticPreviewTop: number | null = null;

    /**
     * 布局可信性判据改用**共享纯函数**（`utils/previewGeometry.ts`）。
     * 详见该模块文件头：关闭预览时宽度→0 会让 scrollHeight 涨 29 倍，
     * 而旧的"贴标>0 且可滚动"闸门在这种情况下**照样放行**，
     * 于是用畸形几何映射 → 重开预览后右屏停在顶部。
     */
    const isPreviewGeometrySane = (el: HTMLElement | null): boolean =>
      isPreviewGeometrySaneFn(previewGeometryOf(el));

    /**
     * 计算"当前左屏位置应指挥右屏到哪"（**纯计算，不写 DOM**）。
     *
     * @param preview 右屏滚动容器
     * @param force   true = **程序强制对齐**（开合预览后的主动重新对齐），
     *                跳过"每帧最多走 allowed"的逐帧钳制。
     *                详见 `clampPreviewTarget` 的 `force` 注释：
     *                开合瞬间右屏停在一个**完全过期**的位置（相差可达 2000px），
     *                逐帧 16px 需要 2.2 秒才追上，而 realign 链 1600ms 就结束了
     *                ⇒ 永远停在错的位置（这就是用户报的"两屏没对齐"）。
     *                用户滚动路径**不传** force，逐帧平滑跟随语义一字未变。
     * @returns 目标 scrollTop；**测不出映射时返回 null**（调用方跳过本次写入，绝不写 0）
     */
    const computePreviewTarget = (preview: HTMLElement, force = false): number | null => {
      const sourceTop = sourceSurface.getScrollTop();
      /**
       * v0.17.1 第三轮：**布局不可信时绝不计算目标**。
       * 详见 `isPreviewGeometrySane` 的注释（关闭预览时宽度 0 →
       * scrollHeight 暴涨 29 倍 → 任何映射都是错基数）。
       */
      if (!isPreviewGeometrySane(preview)) {
        traceScroll("preview-geom-unreliable", {
          w: preview.clientWidth,
          h: preview.clientHeight,
          sh: preview.scrollHeight,
          where: "computePreviewTarget",
        });
        return null;
      }
      try {
        const anchors = collectAnchors();
        if (anchors) {
          const topLine = currentTopSourceLine();
          const next = mapSourceLineToPreviewScroll(
            anchors,
            topLine,
            preview.clientHeight,
          );
          if (next !== null && Number.isFinite(next)) {
            /**
             * ## ═══ v0.17.0 P1（右屏回声返修）：二值拒绝 → **有界连续钳制** ═══
             *
             * ### R5 之后仍实测到的"延迟释放"（本返修的根因）
             * 旧逻辑（R4/R5）在 `dRight > allowed` 时 `return null` **拒写**，但
             * `lastAcceptedPreviewTarget / lastAcceptedSourceTop` 两个基准**都不更新**：
             * - 下一帧 `dLeft` 从**陈旧基准**开始累积 → `allowed = max(ALLOW_ABS, dLeft×3)`
             *   越攒越大 → 累计的跳变最终被**整包放行**；
             * - 实测残留：3 个非内容驱动脱同步帧 + 1 次方向反转，单帧最大 **46px**
             *   —— 用户看到"右屏先不动、再猛跳"的回声观感。
             *
             * ### 新逻辑：每帧最多走 `allowed`，平滑追上
             * const delta = next - lastAcceptedPreviewTarget;
             * const clamped = lastAcceptedPreviewTarget + sign(delta) * min(|delta|, allowed);
             * - 位移在阈值内 → 原值放行（正常跟随零损失）；
             * - 超阈值 → 本帧只走 `allowed`，余量由后续帧逐帧追上（右屏**连续移动**，
             *   不再"停一停再猛跳"，也天然消除方向反转）；
             * - **两个基准每帧都更新（含被钳制的帧）**→ 基准永不陈旧，
             *   "拒写攒欠账 → 整包放行"的延迟释放在机制上不可能再发生。
             *
             * 阈值沿用 R5 真机验证结论：`ALLOW_RATIO = 3`、`ALLOW_ABS = 16`
             * （60 曾在动画起始帧放过 28.66px 残余错跳）。常量与钳制公式由
             * `src/utils/scrollSyncPolicy.ts` 共享模块提供 —— **生产与测试同源**，
             * 测试断言行为（真值表 + 时序回放），不再硬编码源码文本里的数值。
             * 推导表见该模块文件头。
             */
            const dLeft = Math.abs(sourceTop - lastAcceptedSourceTop);
            const allowed = previewAllowedMove(dLeft);
            const clamped = clampPreviewTarget(lastAcceptedPreviewTarget, next, allowed, force);
            if (lastAcceptedPreviewTarget !== null && clamped !== next) {
              // 被钳制的帧（有界追帧进行中）留痕，便于真机探针确认"逐帧追上"形态
              traceScroll("preview-sync-clamp", {
                reason: "bounded-chase",
                topLine, next, clamped, dLeft, allowed,
              });
            }
            lastAcceptedPreviewTarget = clamped;
            lastAcceptedSourceTop = sourceTop;
            return clamped;
          }
          /**
           * 有锚点表但映射不出目标（表为空/退化）→ **不退回百分比**：
           * 纯比例映射完全无视块边界，在两屏高度比不同的文档上必然偏一大截
           * （实测百分比给 3213、块锚点给 3032，差 181px —— 正是那次猛跳的量级）。
           * 跳过一帧的代价是"右屏这一帧不动"，远小于"动错再弹回"。
           */
          return null;
        }
      } catch {
        /* 测量异常 → 落到下面 */
      }
      /**
       * **只有完全拿不到锚点表**（`collectAnchors` 返回 null，例如 iframe 还没贴标）
       * 时才退回百分比。这是 v0.13.x 的兜底语义，保留不动。
       */
      const m2 = sourceSurface.getMetrics();
      const pct = computeSyncScrollTop(
        sourceTop, m2.scrollHeight, m2.clientHeight,
        preview.scrollHeight, preview.clientHeight,
      );
      if (!Number.isFinite(pct)) return null;
      lastAcceptedPreviewTarget = pct;
      lastAcceptedSourceTop = sourceTop;
      return pct;
    };

    /**
     * 左 → 右同步。
     *
     * ## ═══ v0.17.0 第四轮 · 用户第 4 项：「编辑模式下按回车页面明显抖动」═══
     *
     * ### 缺陷（逐帧 + iframe-realm 写入打桩实测，`scripts/v0170-r4-enter-writer.mjs`）
     * 打字机开启、光标在视口下部时按回车，**左屏是平滑的（5 帧 / 28px / 反转 0）**，
     * 但**右屏分屏预览先单帧猛跳、214ms 后又反向弹回**：
     * ```
     * 左屏 st : 4243 → 4248 → 4263 → 4268 → 4270 → 4271     （smooth，正确）
     * 右屏 deST: 3014 → 3203 → 3215 → 3218 → 3220 → 3035
     *            ↑ +189（一帧）                ↑ −185（回弹）← 用户看到的"抖"
     * 同帧对照：右屏 +188 那一帧，左屏只 +15px ⇒ 比值 12.5
     * ```
     * 抓到的写入栈（**未压缩构建**才能读出的符号名）：
     * ```
     * +189 帧：setScrollTop ← syncToPreview ← handler2（CM6 onDidScroll）
     * −185 帧：setScrollTop ← syncToPreview ← realignLayoutNow ← syncPreviewAfterToggle
     * ```
     *
     * ### 机制（**不是打字机的错，也不是右屏渲染的错**）
     * 1. 打字机 `smooth` 让左屏 `scrollTop` 每帧变化 → CM6 派发 scroll →
     *    `syncToPreview()` 被调用 5 次。**这部分是对的**（右屏应当逐帧跟随，
     *    实测就是 189→12→3→2 的递减跟随，观感平滑）；
     * 2. 但**右屏那几次 `preview.scrollTop =` 派发的 scroll 事件要晚很多才到**。
     *    它们到达时，方向锁 `SPLIT_SCROLL_LOCK_MS = 250ms` 已经过期
     *    （`splitScrollSync.ts` 文件头写过：这道锁是为吃"程序写入的回声"，
     *    但一次 smooth 动画比 250ms 还长）→ `syncToSource()` 把回声**当成用户滚右屏**
     *    → 反算写左屏 → 触发 `realignLayoutNow()` → `syncPreviewAfterToggle()`（force）
     *    → 用动画结束后的正确映射**再写一次右屏** = 视觉上的"弹回去"。
     *
     * 一句话：**抖动不是"动了"，而是"动完又回去"** —— 回弹来自右→左回声反向接管。
     *
     * ### 修法（**只加一道时间闸，不动任何映射数学、不动联动逐帧跟随**）
     * 打字机 smooth 写入时开一个 `TYPEWRITER_SMOOTH_WINDOW_MS` 窗口；
     * **窗口内 `syncToSource` 直接 return**（见该函数注释）。
     * 于是回声不会被当成用户操作，`realignLayoutNow` 也不再被误触发。
     *
     * ⚠️ **试过但否掉的两种修法**（记下来，别再试）：
     * - ①「窗口内把右屏写入合并成动画结束后写一次」：回弹确实归 0，但右屏变成
     *   "左屏停了之后才跳一下"，实测单帧位移 114px 且与左屏不同帧 —— 观感从"抖"
     *   变成"顿"，不满足用户"平滑"的诉求。**已回退**。
     * - ②「把方向锁 `SPLIT_SCROLL_LOCK_MS` 从 250ms 调大到 600ms」：会连带把
     *   **用户真的切换去滚右屏**也判成回声 → 双向联动出现最长 600ms 死区。
     *   方向锁是全局共享语义，不该为一个局部动画改它。
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
        /**
         * v0.17.1 第三轮：`force` 同时用于**跳过逐帧钳制**。
         * 开合预览后右屏停在一个完全过期的位置（实测差 2090px），
         * 逐帧 16px 需要 2.2s 才追上，而 realign 链 1600ms 就结束 ⇒ 永远错着。
         * 详见 `clampPreviewTarget` 的 force 注释。
         */
        const target = computePreviewTarget(preview, force);
        if (target !== null) {
          preview.scrollTop = target;
          /**
           * v0.17.2 问题1：记下"我们刚写下的右屏值"。
           *
           * `syncToSource` 据此识别"这是我自己写入的回声，不是用户滚动"。
           * 必须在这里记（`realignLayoutNow` 也走同一个写入点），否则
           * 模式切换后的 bounded-chase 追帧会产生一串回声，逐个把左屏反算回顶部。
           * 详见 `lastProgrammaticPreviewTop` 的注释。
           */
          lastProgrammaticPreviewTop = preview.scrollTop;
          /**
           * ### 关键：窗口必须从**每一次动画期写入**续期（不是只在动画发起时开一次）
           *
           * 实测时序（`scripts/v0170-r4-enter-rightcause.mjs`）：
           * ```
           * t=223ms  左屏 smooth 动画首帧（我们发起）
           * t≈300ms  动画最后一帧 → 我们最后一次写右屏
           * t=441ms  右屏回声 scroll 事件到达 → 若未拦住就反弹 −185px
           * ```
           * 也就是说**回声比"动画最后一帧"还晚约 140ms**（iframe 内部文档的 scroll
           * 事件经跨文档队列派发，比主文档慢）。
           *
           * 若窗口只在发起时开一次（`t=223 + 320 = 543ms`）尚可覆盖，但若动画因
           * 掉帧拖长到 400ms，末次写入 + 回声就会滑出窗口 → 回弹复现（实测过）。
           * 因此：**只要还在窗口内（说明这次写入是动画驱动的），就按本次写入时刻续期**。
           * 于是窗口终点自动变成"最后一次动画写入 + 320ms"，与动画真实时长无关。
           *
           * ⚠️ 续期条件必须带 `performance.now() < 窗口` 这个判断，不能无条件续期：
           * 否则**用户滚轮滚动**（每次滚都写右屏）也会不断续期 → 双向联动被永久
           * 屏蔽成单向，那是比抖动严重得多的回归。
           */
          if (!force && performance.now() < typewriterSmoothUntilRef.current) {
            typewriterSmoothUntilRef.current = performance.now() + TYPEWRITER_SMOOTH_WINDOW_MS;
          }
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
      /**
       * ## ═══ v0.17.0 第四轮 · 用户第 4 项：**拦下"右屏回声"反向接管左屏** ═══
       *
       * ⚠️ **诚实记录（破坏性对照 ② 的结论，很重要）**：单独把这一行关掉，
       * 探针 `v0170-r4-enter-rightpane.mjs` **仍然 PASS**（右屏 maxJump=20 / 反转 0）。
       * 原因是：真正的大幅误写已被 `computePreviewTarget` 的**物理约束
       * （有界连续钳制）**压成"每帧 ≤ allowed"的有界追帧，写不出 188px 的错跳，
       * 也就没有"回声 → 反向接管 → 再纠回"这条链。
       *
       * ⇒ 这道闸是**纵深防御，不是主修复**。保留它的理由：
       * 1. 物理约束的 `ALLOW_ABS` 是容忍度，不是绝对正确性 —— 若某天出现
       *    一次"左屏 ΔL 很大、右屏错写但仍在 `ALLOW_ABS`~3×ΔL 内"的漏网，这道闸还能兜住；
       *    （v0.17.0 R5：`ALLOW_ABS` 已由 60 降到 16 —— 60 曾放过 28.66px 的残余错跳，
       *      详见 `computePreviewTarget` 里的推导表。这里不写死数值，避免再次不同步。）
       * 2. 它与"程序写入的回声不该被当成用户操作"这条既有原则一致
       *    （`splitScrollSync.ts` 的方向锁本来就是同一个目的，只是 250ms 不够长）。
       *
       * 判据用时间窗口而不是 `isSyncingScrollRef`：后者是**同步重入**守卫，
       * 而这些 scroll 事件在下一个任务里才到，那时 ref 早已复位
       * （与 `splitScrollSync.ts` 文件头记的"异步 scroll 事件绕过同步锁"是同一类问题）。
       *
       * ⚠️ 只在"打字机平滑窗口"内屏蔽，**不动方向锁本身**：
       * 用户真去滚右屏时窗口早已结束（窗口最长 320ms，且只在打字机写入时开启），
       * 双向联动语义不变。
       */
      if (performance.now() < typewriterSmoothUntilRef.current) return;
      const now = performance.now();
      /**
       * ## ═══ v0.17.2 问题1：按**值**识别"我自己写入的回声"（这是主修复） ═══
       *
       * 上面的时间窗（320ms）与方向锁（250ms）都是**时间**判据，而 iframe 内部文档的
       * scroll 事件经跨文档队列派发，实测延迟 **140~440ms 且随内容浮动** ——
       * 任何固定窗口都只能把概率往后推，不能根治。
       *
       * 实测证据（`scripts/_lead-i1d-writestack.mjs`，hook 了 `Element.prototype.scrollTop`）：
       * ```
       * t=13284 cm   5 → 8127.3   ← res-source（模式切换恢复，正确）
       * t=13317 cm 8127 → 8103.9  ← CM6 measure
       * t=13754 cm 8104 → 3.9     ← HTMLDocument.Ne = 本函数 ★ 把左屏写回顶部
       * ```
       * 从我们写下右屏（t≈13295）到回声到达（t=13754）相隔 **459ms**，
       * 方向锁（250ms）与打字机窗（320ms）**双双已过期** → 被当成用户滚动。
       *
       * 而此刻右屏还处在"刚建出来、bounded-chase 正从 0 往 11651 爬"的阶段
       * （`preview-realign-layout` 记录 previewTop 16/32/48/64/78），
       * 于是反算出的源码行是**第 0 行** → 左屏被写成 4px。
       *
       * ### 判据
       * 右屏的所有程序写入都收敛在 `syncToPreview` 的 `preview.scrollTop = target`，
       * 那里把写下的值记进 `lastProgrammaticPreviewTop`。这里若读到右屏当前值
       * 与它相等（±取整容差），就**确定这是回声** → 直接返回，不动左屏。
       *
       * ### 失败方向（为什么这样是安全的）
       * - 误判成回声 → 少同步一次，用户再滚一下右屏立刻恢复接管（可自愈）；
       * - 漏判 → 左屏被清到顶部、**阅读进度永久丢失**（不可自愈，就是用户报的缺陷）。
       * 两者代价不对称，所以宁可偏保守。
       * 用户真去滚右屏时几乎不可能正好停在我们写下的同一像素上；
       * 且用户一旦滚动，`preview.scrollTop` 立刻偏离该值 → 下一次事件正常接管。
       */
      {
        const p = getPreviewScroller();
        if (
          p &&
          lastProgrammaticPreviewTop !== null &&
          Math.abs(p.scrollTop - lastProgrammaticPreviewTop) <= PROGRAMMATIC_ECHO_EPSILON_PX
        ) {
          // 回声：这是我自己刚写下去的右屏位置，不是用户滚动 → 绝不反算写左屏
          traceScroll("sync-to-source-echo-skip", {
            previewTop: Math.round(p.scrollTop * 10) / 10,
            wrote: Math.round(lastProgrammaticPreviewTop * 10) / 10,
          });
          return;
        }
      }
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
    /**
     * 用户接管判定：绑**源码面宿主**（真 textarea 就是它自己；CM6 是中性 div，
     * 滚轮/指针事件从 `.cm-scroller` / `.cm-content` 冒泡到宿主 → 同样能收到）。
     *
     * v0.17.0 P1-3：旧代码是 `if (textarea) textarea.addEventListener(...)` ——
     * CM6 下 `textarea` 是 div（truthy），所以**这行其实也生效了**（绑到宿主 div）。
     * 但那个 `textarea` 变量声明类型是 `HTMLTextAreaElement`，语义上是"类型谎言"；
     * 现在改成显式 `sourceHostEl`，让"绑宿主"这件事是**有意的**而不是巧合。
     */
    if (sourceHostEl) {
      sourceHostEl.addEventListener("wheel", markRealignUser, { passive: true });
      sourceHostEl.addEventListener("pointerdown", markRealignUser, { passive: true });
      sourceHostEl.addEventListener("touchstart", markRealignUser, { passive: true });
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
        /**
         * ## v0.17.1 第三轮（用户问题：双击 Shift 开/关预览后不对齐）：几何健全性闸门
         *
         * 上面两条只查"贴标 > 0"和"可滚动"，但**关闭预览时两者都成立**：
         * 宽度被压成 0，每个字单独折行 → `scrollHeight` 从 6130 涨到 175405
         * （实测 `scripts/_lead-p4d-iframe-layout.mjs`）。
         * 于是"就绪闸门"照样放行，用畸形几何做映射 → 重开预览后右屏停在顶部。
         *
         * 这里用与 `computePreviewTarget` **同一套**判据（单一事实源），
         * 保证两条路径不会一个放行一个拒绝。
         */
        if (!isPreviewGeometrySane(preview)) {
          traceScroll("preview-realign-skip", {
            gen: realignGen,
            reason: "geom-unreliable",
            w: preview.clientWidth,
            h: preview.clientHeight,
            sh: preview.scrollHeight,
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
     * ResizeObserver 必须 observe 一个**真实元素**。
     *
     * v0.17.0 P1-3：旧代码 `if (textarea) layoutObserver?.observe(textarea);`
     * —— CM6 下 `textarea` 是宿主 div（truthy）→ 其实也 observe 了；
     * 但那不是"内容宽度变化"的正确观察对象：CM6 的正文列宽变化体现在
     * `view.scrollDOM` 上（padLeft 变化 → `.cm-line` 重排 → scrollDOM 的 scrollHeight 变），
     * 而宿主 div 的盒子尺寸在开合预览时也会变，所以**观察宿主仍然有效**
     * （`layoutKeyOf()` 读的是 surface metrics，任一处变化都会让 key 变）。
     * 现在显式写成 `sourceHostEl`：语义是"观察源码面可见宿主"，不再是类型巧合。
     */
    if (sourceHostEl) layoutObserver?.observe(sourceHostEl);
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
      /**
       * 解绑必须与上面 `addEventListener` 的**宿主一致**（都用 `sourceHostEl`）。
       *
       * v0.17.0 P1-3 自查修正：绑定时已改为显式 `sourceHostEl`，
       * 但解绑仍写着 `textarea`。当前两者在 textarea / CM6 两种实现下恰好指向同一元素
       * （真 textarea 时 `sourceHostEl === textarea`；CM6 时 `textarea` 是同一个宿主 div），
       * 所以**没有实际泄漏**；但这是"靠巧合成立"，一旦将来两者分叉就会静默泄漏监听器
       * （effect 每次重跑都叠加一组，用户滚一次会触发 N 次 markRealignUser）。
       * 由 `v0153-preview-realign.test.ts` 的静态契约锁定必须一致。
       */
      if (sourceHostEl) {
        sourceHostEl.removeEventListener("wheel", markRealignUser);
        sourceHostEl.removeEventListener("pointerdown", markRealignUser);
        sourceHostEl.removeEventListener("touchstart", markRealignUser);
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
