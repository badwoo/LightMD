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
import { measureLineAxis, textareaMeasureSource } from "../../../../editor/surface/sourceLineAxis";
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


  // 分屏预览容器
  // iframe 引用在 previewIframeRef 中管理

  // ─── 撤销/恢复栈 ────────────────────────────────
  const undoStackRef = useRef<HistoryEntry[]>([]);

  const redoStackRef = useRef<HistoryEntry[]>([]);

  const isUndoRedoRef = useRef(false);

  /**
   * v0.14.0 需求2：撤销/恢复专用的「当前文档键」读取器。
   *
   * 必须在这里**提前声明**：`doLocalUndo` / `doLocalRedo` 要用它去查跨文件替换记录，
   * 而组件里那两个同口径的 `currentDocKey()` / `currentDocKeyFromStore()` 定义在
   * 2700 行之后（引用会踩 TDZ：tsc 报 "used before declaration"）。
   * 直接读 store 而不是 React 派生值，也顺带避开切标签时"新 key + 旧闭包"的错配。
   */
  const undoDocKey = useCallback((): string | null => {
    const st = useEditorStore.getState();
    const tab = st.openTabs[st.activeTabIdx];
    if (!tab) return null;
    return tab.isUntitled
      ? `${UNTITLED_PROGRESS_PREFIX}${tab.id ?? st.activeTabIdx}`
      : tab.path || null;
  }, []);

  /**
   * v0.15.0 需求（跨模式撤销统一）：**统一时间线**的宿主与协调器。
   *
   * 背景（评估报告 §六.1）：v0.14.0 之前阅读模式用 `prosemirror-history`（PM 栈），
   * 源码模式用组件内 diff 栈（`undoStackRef`），两套**物理隔离** —— 在编辑模式改完
   * 切到阅读模式，Ctrl+Z 撤不掉刚才的编辑（只能切回去撤）。v0.14.0 做了"入口路由 +
   * 按文档独立 + 跨文件记录"三层缓解，本质未变。
   *
   * 从本版起：**每个文档一条逻辑时间线**（`services/documentHistory`），源码与 PM
   * 都只是"往同一条时间线上提交条目"的 adapter，撤销/恢复全部经
   * `editorHistory/coordinator` 决策后由本组件的 host 落地。
   *
   * 两条铁律：
   * 1. **时间线只存真实内容**：源码侧必须 unmask（`sourceContentRef` 是显示层短标记文本，
   *    直接喂会把 base64 永久退化成 `image-1.png`，用户存盘即损坏）；
   * 2. **bridge 事务不进历史**：协调器写回阅读模式时 dispatch 的事务必须带
   *    `addToHistory:false` + `historyBridge:true`，否则"撤销动作本身"又被记一条 → 死循环。
   */
  const historyDocKeyOrEmpty = useCallback((): string => undoDocKey() ?? "", [undoDocKey]);

  const historyHostRef = useRef<HistoryHost | null>(null);

  const historyCoordinatorRef = useRef<HistoryCoordinator | null>(null);

  /** 当前文档的真实文本（源码 unmask 后 / 阅读 getMarkdownFromDoc）——时间线与护栏的唯一事实来源 */
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

  /** 上一次已同步进时间线的真实文本（避免重复 begin / 无变化 commit） */
  const lastRealTextRef = useRef<string>("");

  // ─── v0.15.0 需求（阅读区标题折叠）────────────────────────────
  // 折叠**只作用于阅读面**：阅读模式（PM）+ 编辑模式的右侧预览（iframe）。
  // 编辑区 WYSIWYG 与源码 textarea 都不折叠（本版明确范围）。
  //
  // 状态键只用 headingId，不按块下标：两个渲染面的块下标口径不同
  // （PM 含空行还原的空段落与末尾 pad 段落，iframe 不含），按下标存会串位。
  //
  // ⚠️ 这两个 effect 必须放在 `undoDocKey` 声明**之后**：它内部调用 `undoDocKey()`，
  // 提前引用会踩 TDZ（tsc: "used before declaration"）。
  useEffect(() => {
    readingFold.setEnabled(viewMode === "preview");
  }, [viewMode]);

  useEffect(() => {
    // 与撤销同一口径：真实文件 = 路径 / 临时标签 = untitled:<id>。
    // 不用 `currentDocKeyFromStore`（定义在 2900 行之后，同样会 TDZ）。
    readingFold.setDocKey(undoDocKey());
  }, [filePath, forceUpdateKey, undoDocKey]);

  /**
   * v0.13.2 需求5：撤销历史按**文档**保管（跨标签保留）。
   * - `docKeyRef`：当前活动文档键（真实文件 = 路径 / 临时标签 = untitled:<id>）。
   *   必须用 ref：换文档 effect 与撤销处理器都要读它，而它由 store 计算得出。
   * - `lastHistoryContentRef`：离开时该文档的内容快照，回来时据此判断
   *   "能否安全装回历史"（位置敏感，内容不一致就丢弃，见 docHistoryStore）。
   */
  const docKeyRef = useRef<string | null>(null);

  const lastHistoryContentRef = useRef<string>("");


  // ─── 滚动联动（核心修复）────────────────────────
  // 持续追踪各区域的滚动百分比，切换模式时直接使用已记录的值
  // 而非从已隐藏（display:none）的元素上读取（此时 scrollHeight=0 无法计算）
  const pmScrollPercentRef = useRef(0);

  const textareaScrollPercentRef = useRef(0);

  const isSyncingScrollRef = useRef(false);

  // 待恢复的滚动信息：模式切换后需要延迟恢复滚动位置
  // v0.8.0 修复 P1-2：anchorLine 改为"切换模式的瞬间从当前光标现算"，
  // 不再由每次编辑上报维护全局 ref（旧实现有跨文件残留、且每次击键都 textBetween 计行号）
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

  // 追踪上一个模式，用于判断切换方向
  const prevViewModeRef = useRef<ViewMode>(viewMode);

  // 标记正在恢复滚动位置（模式切换后 applyScroll 尚未执行完）
  // 打字机 effect 的初始 scrollToCenter 检查此标志，避免 smooth 滚动覆盖 applyScroll 的 scrollTop
  const isRestoringScrollRef = useRef(false);

  /**
   * v0.15.4 需求10：**撤销/恢复落地后的滚动执行窗口**（单位 = `performance.now()` 时刻）。
   *
   * ## 缺陷（实机取证 `scripts/v0154-probe-real-keys.mjs`）
   * 用户在阅读模式按 Ctrl+Z，探针 8ms 采样的内容坐标序列是
   * `… 145 → 146 → 294.03 → 294.03 → 146 …`（一次方向反转，振幅 149 块），
   * scrollTop 写入序列：
   * ```
   * t=117.4  2853.33 → 2853.33  (Δ0)      ← restorePreviewScrollFromAnchor 的 apply(rAF)
   * t=150.9  2853.33 → 6301.61  (Δ+3448)  ← keyup 处理器的 scrollToVisible()
   * t=186.1  6301.33 → 2853.33  (Δ−3448)  ← apply(60ms) 按内容锚拉回
   * t=279.7  2853.33 → 2853.33  (Δ0)      ← apply(160ms)
   * ```
   * 即：锚点先把视口放对，**同一批 keyup 又把视口推到光标所在处**（校验窗外的
   * 3448px），60ms 后锚点再拉回来。用户看到的就是「撤销时文档抖一下」。
   *
   * ## 为什么 keyup 会跑
   * `Ctrl+Z` 的 keyup 冒泡到 `.ProseMirror` 的 keyup 监听器；此时
   * `diff = |cursorY - savedCursorY|` 很大（撤销把整篇换掉、光标位置也换了），
   * 既不是 `wasOutside`，也不满足 `diff <= 5` 的同行分支，于是落到
   * 「触发滚动 → scrollToVisible()」。
   *
   * ## 修法
   * 撤销/恢复的窗口内**禁止** keyup/click/select 主动滚动：这些滚动不是用户意图
   * （用户只按了 Ctrl+Z），且它们会和内容锚点恢复互相踩。窗口用时刻戳而不是布尔，
   * 避免异常路径下永久卡死；每次撤销落地都重置窗口。
   */
  const historyScrollGuardUntilRef = useRef(0);

  /**
   * v0.15.4 需求10：撤销/恢复的滚动窗口长度。
   *
   * 必须覆盖 `restorePreviewScrollFromAnchor` 的三段校正（rAF / 60ms / 160ms）加上
   * 一次布局重排余量 —— 实测最后一次校正落在 t≈279ms，留 100ms 安全量取 400ms。
   * 取值不影响正确性（窗口外用户滚动立刻生效），只影响"多久之内屏蔽旧滚动意图"。
   */
  const HISTORY_SCROLL_GUARD_MS = 400;

  /**
   * v0.15.4 需求10：当前是否处于「撤销/恢复的滚动窗口」。
   *
   * keyup / click / select 这类**非用户主动滚动**的自动滚动动作在窗口内必须让位：
   * 视口位置由内容锚点恢复统一负责（见 `historyScrollGuardUntilRef` 的实测取证）。
   */
  const inHistoryScrollGuard = useCallback(
    () => performance.now() < historyScrollGuardUntilRef.current,
    [],
  );

  /**
   * v0.15.1 需求3（二次修复）：滚动恢复的**代际**计数。
   *
   * 用途：恢复保护窗用 `setTimeout` 收尾，而期间用户可能又切了一次模式（新一代恢复开始）。
   * 若旧一代的收尾定时器照样跑，它会把 `isRestoringScrollRef` 清成 false 并覆盖新一代的
   * 几何缓存 → 又回到"校正值被当基准"的老问题。用代际号让旧定时器自觉退场。
   */
  const scrollRestoreGenRef = useRef(0);

  /**
   * v0.15.1 需求3：render 期锚点捕获的**去重标记**（记录已经捕获过锚点的那次 viewMode）。
   *
   * 为什么需要：render 可能因其它 state 变化重跑多次；若每次都捕获，后一次会覆盖前一次，
   * 而后面真正用于恢复的那次可能已经落在 textarea 隐藏之后（采到 null）。
   * 只让**第一次**（textarea 仍可见那一帧）生效。
   */
  const anchorCapturedForModeRef = useRef<string | null>(null);

  /**
   * v0.15.2 需求1：模式切换滑入动画的**方向**（null = 不播）。
   *
   * 值直接写进 `.editor-main-area` 的 `data-lmd-mode-anim`，由
   * `styles/modeSwitchSlide.css` 按方向选择 keyframes：
   * - `"to-edit"`：编辑区（左栏 + 右屏）从**左**滑入；
   * - `"to-preview"`：阅读面从**右**滑回。
   */
  const [modeAnim, setModeAnim] = useState<"to-edit" | "to-preview" | null>(null);

  /**
   * 动画收尾定时器的**代际**：快速连切时旧定时器必须作废，否则会把新一轮动画腰斩
   * （与 scrollRestoreGenRef 同一套路）。
   */
  const modeAnimGenRef = useRef(0);

  /**
   * v0.15.0 需求（阅读↔编辑内容对齐）：模式切换**前**采集来源侧的内容锚点。
   *
   * 必须在切换前的 effect 里同步调用（此时来源面还有真实布局、块几何可量）；
   * 切完再采集就只能拿到目标面了。经 ref 暴露给模式切换 effect 使用。
   */
  const captureContentAnchorRef = useRef<(() => ContentAnchor | null) | null>(null);

  /**
   * v0.15.0 需求（阅读↔编辑内容对齐）：在**模式切换的那次渲染之前**把来源面锚点存下来。
   *
   * 为什么用 `useLayoutEffect` 而不是普通 effect：普通 effect 在 DOM 更新（面已切换）
   * 之后才跑，那时阅读面可能已卸载/隐藏，块几何全是 0 → 采到 null。
   * `useLayoutEffect` 在浏览器绘制前、依赖变化的那次提交里同步执行，此时**旧面仍在**。
   */
  const modeSwitchAnchorRef = useRef<ContentAnchor | null>(null);

  /**
   * 阅读面（`.ProseMirror`）块几何的**滚动期缓存**。
   *
   * 为什么不能在切换瞬间现量（这是复核抓出的 P0）：
   * `useLayoutEffect` 在 DOM commit 之后执行，此时 `.editor-container` 已被
   * `display: none`（非阅读面），`getBoundingClientRect()` 全是 0 → 每块 height=0
   * → `visible:false` → 采集返回 null，整条对齐链路变成死代码。
   * 因此在阅读面**真实可见**期间（滚动时）持续缓存，切换时只读缓存。
   */
  const pmGeomCacheRef = useRef<{
    blocks: import("../../../../utils/contentScrollMap").BlockGeometry[];
    scrollTop: number;
    clientHeight: number;
    scrollHeight: number;
  } | null>(null);

  /**
   * v0.15.1 需求3（第三次返修）：为「阅读→编辑」取锚点。
   *
   * ## 为什么不能直接用 `pmGeomCacheRef.scrollTop`
   *
   * 缓存是**滚动时**写的，而恢复流程会在切换后再校正若干次（rAF / 60ms / 160ms）。
   * 若锚点用缓存里的旧 `scrollTop`，下一轮就以"上一轮校正前"的位置当基准 →
   * 每轮叠加一点（实测 ratio=0.2 时 +45/+103/+170，ratio=0.8 时 −78/−163/−274，
   * 呈**单调同向累积** —— 正是用户报的"连续多次后阅读面开始跟着偏"）。
   *
   * 正确做法与源码面同款：**块几何取缓存（与滚动位置无关），滚动位置现读实时值**。
   * 捕获发生在 render 期（此时阅读面仍可见），现读是可信的。
   */
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


  /** 采一次当前阅读面几何并写入缓存（阅读面可见时调用） */
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

  /**
   * v0.15.1 需求3（二次修复）：**双向**采集模式切换前的「视口中央内容锚点」。
   *
   * ## 缺陷（用户原话：「不断双击 Ctrl 键进行阅读模式和编辑模式切换时…屏幕不断会滚动位置偏移」）
   *
   * v0.15.0 只给**阅读→编辑**这个方向采了内容锚点，反向的 **编辑→阅读** 退回
   * 「滚动百分比」恢复。两种排版几何完全不同（正文列宽 / 行高 / 块间距 / 软换行数），
   * 同一百分比指向的是**不同内容** → 每轮偏差被当作下一轮基准 → 累积漂移。
   *
   * ## 为什么第一版「双向采集」没生效（实测抓出的真凶）
   *
   * 第一版在 `useLayoutEffect` 里对 textarea 现量块几何。但那个 effect 跑在
   * **React 已把新 DOM 提交之后**：切到阅读模式时 textarea 已经是 `display: none`，
   * 实测 `clientWidth === 0 && clientHeight === 0` → `measureSourceLineAxis` 首行
   * 守卫 `if (!(textarea.clientWidth > 0) || !(textarea.clientHeight > 0)) return null`
   * 直接返回 null → 锚点为 null → 该方向**始终**退回百分比。
   * 也就是说「双向」只在纸面上成立，实际只有单向。
   * （这与 PM 面当年踩的坑一模一样：语义地图 §4-30 记录的"切走之后量不到几何"。）
   *
   * ## 修法：与 PM 面同款 —— **可见期间**缓存几何，切换瞬间只读缓存
   *
   * - `srcGeomCacheRef`：textarea 在**可见时**（滚动 / 布局变化）缓存
   *   「按行轴还原的块几何 + scrollTop + clientHeight + scrollHeight」；
   * - 切换瞬间（useLayoutEffect，textarea 已隐藏）只读缓存做 `captureContentAnchor`，
   *   与恢复侧 `textareaTopFromContentAnchor` 用同一套 `blockGeometryFromLineAxis`
   *   坐标系，往返才自洽；
   * - 缓存键含 `scrollHeight`（字号/行高/宽度变化都会改变软换行位置，必须失效）。
   */
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


  /**
   * 现量源码面块几何（**只在 textarea 可见时**有效）。
   *
   * 为什么抽成独立函数：它有两个用途 —— ①滚动/切换期间刷新缓存；
   * ②切换的那一帧（render 期，textarea 仍可见）**直接现量**取锚点。
   * 后者最关键：`measureSourceLineAxis` 用镜像 div 实测软换行后的行轴，
   * 与 `textareaTopFromContentAnchor` 恢复侧完全同一套坐标系，往返才自洽。
   *
   * 量不到（隐藏 / 空文档 / 只读 / 超长文本）返回 null，调用方自行兜底。
   */
  const measureSourceBlocks = useCallback((): {
    blocks: import("../../../../utils/contentScrollMap").BlockGeometry[];
    markdown: string;
  } | null => {
    // TODO(v0.18): CM6 能力缺口 — 几何（CM6 需 coordsAtPos/getMetrics 语义，A3 后能力）
    const textarea = sourceTextareaRef.current;
    if (!textarea) return null;
    // 不可见时高度/宽度为 0 → 量不出可信行轴
    if (!(textarea.clientHeight > 0) || !(textarea.clientWidth > 0)) return null;
    if (!(textarea.scrollHeight > 0)) return null;
    const markdown = unmaskBase64Images(sourceContentRef.current, base64TokensRef.current);
    if (!markdown) return null;
    try {
      const blockLines = topLevelBlockStartLines(markdown);
      /**
       * v0.17.0 A3：行轴测量改经统一入口（`measureLineAxis`）。
       *
       * 为什么不是直接换 `surface.measureBlockTops`：下游有 3 处独立在量，
       * 各写一份兜底必然漂移。适配层把「测量源」与「行轴构建（纯函数不动）」拆开，
       * 并且**降级可观测**（R2）：走 textarea 源时与 A3 之前行为完全一致；
       * 走 surface 源时 CM6 用 `lineBlockAt` 覆盖全文档（含视口外）。
       *
       * 当前仍用 textarea 源 —— 因为本函数在 `previewShown` 分屏路径里，
       * 而 CM6 的 `coordsAtPos` 需要真实布局；待 A3 第 4 项把分屏联动整体
       * 切到 `getMetrics()` 后再换源（此处留好接口，换源只改一行）。
       */
      const measured = measureLineAxis(textareaMeasureSource(textarea), blockLines, (reason) => {
        // 降级可观测：探针可据此判定"是测量失败"而非"对齐算法坏了"
        if (typeof window !== "undefined") {
          const w = window as unknown as { __LMD_AXIS_DEGRADE?: string[] };
          if (Array.isArray(w.__LMD_AXIS_DEGRADE) && w.__LMD_AXIS_DEGRADE.length < 200) {
            w.__LMD_AXIS_DEGRADE.push(reason);
          }
        }
      });
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


  /**
   * 采一次源码面块几何并写入缓存（**只在 textarea 可见时调用**）。
   * 量不到（隐藏 / 空文档 / 只读）就保持旧缓存不动，绝不写 null 把缓存打坏。
   */
  const cacheSourceGeometry = useCallback(() => {
    // TODO(v0.18): CM6 能力缺口 — 几何（CM6 需 coordsAtPos/getMetrics 语义，A3 后能力）
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


  /**
   * 取「编辑→阅读」方向的锚点。
   *
   * ## 优先**现量**（v0.15.1 需求3 第四次返修）
   *
   * 捕获发生在 **render 期**（`viewMode` 已变成 "preview"、DOM 还没提交）——
   * 这一帧 textarea 仍然可见，可以像滚动时那样直接量行轴。于是根本不必依赖
   * 「编辑期间每敲一个字就重测一遍缓存」（那是 O(全文) 的镜像测量，大文档会卡输入）。
   * 缓存只在"量不到的时候"兜底（例如 render 期已被别的原因隐藏）。
   *
   * @returns null = 无可用几何（调用方退回百分比——与旧行为一致，不会更差）
   */
  const captureSourceContentAnchor = useCallback((): ContentAnchor | null => {
    // TODO(v0.18): CM6 能力缺口 — 几何（CM6 需 coordsAtPos/getMetrics 语义，A3 后能力）
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


  /**
   * v0.15.1 需求3（**第四次返修**）：**两个方向**都在渲染期捕获锚点。
   *
   * ## 为什么不能用 `useLayoutEffect`（前三版都栽在这）
   *
   * `useLayoutEffect` 的语义是"React 已经把新 DOM 提交之后、绘制之前"。切到阅读模式时
   * 那次提交已经把 textarea 设成 `display: none`；切到编辑模式时那次提交已经把
   * `.editor-container` 设成 `display: none`。于是：
   * - 「编辑→阅读」方向在 effect 里读 `textarea.clientHeight` 拿到 **0**，
   *   `measureSourceLineAxis` 首行守卫直接返回 null → 该方向从来没拿到过内容锚点；
   * - 「阅读→编辑」方向在 effect 里读 `.editor-container` 同样是 0 →
   *   `collectPmBlockGeometry` 量出全 0 高度 → 只能退回**滚动期缓存**的旧快照，
   *   而旧快照的块几何与真实布局有亚像素差 → 每轮往返叠一点点（探针实测
   *   ratio=0.2 时 +45/+103/+170，ratio=0.8 时 −78/−163/−274，**单调同向累积**，
   *   正是用户报的"连续多次双击后编辑面先偏、阅读面跟着偏"）。
   *
   * ## 做法
   *
   * 在 render 阶段（`viewMode` 已变、DOM 还没提交、**旧面仍可见**）当场捕获，存进
   * `modeSwitchAnchorRef`；`useLayoutEffect` 只做"没采到就补一次"的兜底，恢复 effect
   * 只读这个 ref。
   *
   * 为什么 render 期读 DOM 可以接受：这里只**读**布局（`clientHeight` / `scrollTop` /
   * `getBoundingClientRect`），不写样式、不 setState —— 不会引起 reflow 环，也不改变
   * 渲染输出。读的是"当前已提交的 DOM"（还是旧面），正是需要的那一帧。
   * 用 `anchorCapturedForModeRef` 防止同一轮内因其它 state 重渲染而重复覆盖。
   */
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


  /**
   * v0.15.1 需求1：撤销/恢复落地后，在 **React 提交完 DOM、绘制之前** 恢复源码选区。
   *
   * 为什么必须在这里（而不是 rAF）：`setSourceContent` 是受控组件，React 提交新
   * value 时会把 textarea 的 selection 重置掉；那次提交可能晚于我们的 rAF，
   * 于是 rAF 里设好的光标被覆盖（实测 12 → 0，用户看到"撤销后光标跳回文首"）。
   * `useLayoutEffect` 跑在 DOM 提交之后、浏览器绘制之前 → 设了就一定生效。
   */
  useLayoutEffect(() => {
    const pending = pendingSourceSelectionRef.current;
    if (!pending) return;
    if (Date.now() > pending.until) {
      pendingSourceSelectionRef.current = null;
      return;
    }
    // TODO(v0.18): CM6 能力缺口 — 纯值，可换 surface.*，待逐处确认无复合用途
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


  /**
   * 进入阅读模式时缓存一次几何（用户没滚动就直接切走的情况），并在内容换新时清空旧缓存
   * （避免用上一份文档的块几何去映射新文档）。
   */
  useEffect(() => {
    if (viewMode !== "preview") {
      pmGeomCacheRef.current = null;
      return;
    }
    // rAF 等布局稳定后采（刚切进阅读面时块高可能尚未定）
    const raf = requestAnimationFrame(() => cachePmGeometry());
    return () => cancelAnimationFrame(raf);
  }, [viewMode, content, forceUpdateKey, cachePmGeometry]);

  /**
   * 修正 iframe 采集坐标系（复核抓出的 P0 #2）：
   * 根元素 `getBoundingClientRect().top === -scrollTop`，若再 `- scrollerRect.top`
   * 就等价于 `rect.top + 2*scrollTop`（v0.13.2 已踩过同款坑）。
   * 该逻辑在 `contentScrollMap.collectIframeBlockGeometry` 内，见那里的一行修正。
   */

  // 当 content prop 变化（文件切换）时，同步 sourceContent
  // 编辑/分屏模式需要同步；非 md 文件在阅读模式下也需要同步（纯文本预览依赖 sourceContent）
  // v0.6.6 问题4：同步进入源码显示层前 mask base64 图片（短标记），
  // tokens 跨 content 更新保留（标记复用、序号稳定），文件切换时清空重建
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


  // ─── 撤销/恢复 ────────────────────────────────
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


  /** 记录编辑差异，直接推入 undoStack（合并连续操作） */
  const recordUndoEntry = useCallback((oldContent: string, newContent: string, cursorPos: number, scrollTop: number) => {
    if (isUndoRedoRef.current) return;
    const diff = computeDiff(oldContent, newContent);
    if (diff.deleted === "" && diff.inserted === "") return; // 无变化
    const entry: HistoryEntry = { ...diff, cursorPos, scrollTop };
    pushUndoEntry(entry);
  }, [pushUndoEntry]);


  /**
   * v0.15.1 需求1（**关键修复**）：源码模式「离散编辑」写入**统一时间线**。
   *
   * ## 缺陷背景（用户实测：「随便编辑撤销恢复几次后就说到了边界，然后撤销和恢复都不能用了」）
   *
   * v0.15.0 把 `doLocalUndo/doLocalRedo` 改成只走 `documentHistory`（统一时间线），
   * 但**只把 `handleSourceChange`（普通打字）接了过去**，其余 8 处源码编辑仍调
   * `pushUndoEntry` 写进**已退休的旧 diff 栈**（`undoStackRef`，现在没有任何人消费它）：
   * 格式工具栏（加粗/标题/行内代码…）、斜杠命令插入、`insertTextAtCursor`（对话框插入）、
   * 格式 ghost 退格删除、格式刷应用、块级复制粘贴回写…
   *
   * 双重后果：
   * 1. 这些操作**不可撤销**（Ctrl+Z 看不到它们）——功能回归；
   * 2. 更严重：它们改了 `sourceContent` 却**没有推进时间线的 knownText** →
   *    下一次普通打字的 `commit({ before: 旧文本 })` 与 knownText 失配 →
   *    协调器 `rebaseText(force:true)` 强制对齐 → `truncateRedo` **把 redo 分支整段删掉**
   *    （而 `force` 也会把游标位置推平）→ 反复几次后时间线彻底失效，
   *    于是每次撤销都走"空栈"分支，弹出「已到本模式撤销边界」，恢复也一并失效。
   *
   * ## 做法
   * 与 `handleSourceChange` 同一口径：**时间线只存真实内容**（unmask 后），
   * 并把编辑前的光标/滚动作为 `beforeSelection`（撤销要回到这里）。
   */
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


  /**
   * v0.14.0 需求1+2：**整篇文本写回的单一入口**（搜索替换 / 跨文件替换复用）。
   *
   * ## 为什么必须收口成一处（两个用户报的缺陷同源）
   *
   * 用户原话：
   * ① 「阅读模式下进行搜索和替换，文本没有立即生效。」
   * ② 「通过搜索替换也要进入到撤销栈中，当前没有生效，而且跨文件搜索和替换，
   *     切换到对应文件后也能使用撤销或恢复。」
   *
   * 实机取证（`scripts/v0140-probe-req1-crossfile-preview.mjs`，T1 vs T3）：
   * - 条幅**收起**时点「全部替换」→ SearchReplace 走自己的 PM 分支 → 阅读视图立即变 ✔
   * - 条幅**展开**时点「全部替换（所有文件）」→ `replaceAllAcrossFiles` 对**当前文档**
   *   也走 `onSourceContentChange`（源码态写回通道）→ 只改了 `sourceContent` 这个隐藏
   *   textarea 的状态和 localStorage，**ProseMirror 一个字都没动**
   *   → 用户眼前的阅读视图完全没反应（需求1），且这条路径没有记录任何撤销步骤（需求2）。
   *   更糟的是下一次切模式/换文档会用 store 内容重建 PM，替换结果可能被冲掉。
   *
   * ## 分支规则（与「用户在哪儿看」严格对应）
   * - **编辑（源码）模式**：写 textarea 状态 + 记一条 diff 撤销记录（与格式工具栏、
   *   斜杠命令同一套 `recordUndoEntry` 口径 → Ctrl+Z 可撤）。
   * - **阅读模式 + md 文件**：dispatch 一条 PM 事务（`addToHistory: true`）→
   *   阅读视图立即更新 **且** 进 PM 撤销栈；`onDocChange` 会顺带完成
   *   序列化 / 标签内容 / 脏标记 / 基线更新，不需要在这里重复。
   * - **阅读模式 + 非 md 文件**：可见的是 `.plaintext-preview`（由 `sourceContent`
   *   派生渲染），所以写 state + 记撤销记录即可。
   *
   * ⚠️ 不要把这里改成"只改 state 再靠 effect 同步 PM"：那条路是异步的（rAF + 解析
   * 全文），阅读模式下用户会先看到旧文字，正是本次要修的"没有立即生效"。
   */
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


  /**
   * v0.15.0 需求（跨模式撤销统一）：**统一撤销系统的安装点**。
   *
   * 在首次渲染前（useMemo，不产生副作用依赖）建三样东西：
   * - `pmAdapter`：PM 事务 → 时间线条目（节流序列化 + 忽略 historyBridge）；
   * - `sourceAdapter`：源码 textarea 编辑归并（typing/IME/paste/pair 分组）；
   * - `coordinator`：undo/redo 唯一决策出口（护栏/边界/落地）。
   *
   * ⚠️ host 的三个方法来**读 ref** 而不是闭包捕获 state：协调器是"长期存活对象"，
   * 若捕获 `viewMode`/`sourceContent` 会永久停在创建那一刻的值（切模式后撤销走错分支）。
   */
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

  /** 阅读/源码「把历史文本写回宿主」的实现（稍后定义，经 ref 供上面 host 调用） */
  const applyHistoryTextRef = useRef<
    ((text: string, restore: unknown, meta: unknown) => void) | null
  >(null);

  /**
   * v0.15.0 源码编辑归并的一次性标记（每个只描述"刚刚发生的那一次输入"，
   * 由 `handleSourceChange` 消费后复位）：
   * - `sourceComposingRef`：IME 组合输入进行中（一次 composition = 一条历史）；
   * - `sourceJustPairedRef`：刚由自动配对补全（`()` 一次插入 = 一条历史）；
   * - `sourceJustPastedRef`：刚发生粘贴（一次粘贴 = 一条历史，不与后续打字合并）。
   */
  const sourceComposingRef = useRef(false);

  const sourceJustPairedRef = useRef(false);

  const sourceJustPastedRef = useRef(false);


  /**
   * v0.13.2 需求5（返修后口径）：执行一次**当前文档**的撤销。
   *
   * v0.15.0 需求（跨模式撤销统一）：实现体改为**委托统一协调器**。
   * 阅读模式（PM）与源码模式（diff 栈）过去各有一套物理隔离的栈，切模式后
   * Ctrl+Z 撤不掉另一侧的改动；现在两者共用同一条逻辑时间线，
   * 撤销可以穿过任意多次模式切换。
   *
   * @returns 是否真的撤销了一步（false = 当前文档撤销栈已空）
   */
  const doLocalUndo = useCallback((): boolean => {
    return historyCoordinatorRef.current?.handleUndo() ?? false;
  }, []);


  /**
   * v0.13.2 需求5（返修后口径）：执行一次**当前文档**的恢复（不跨文档）。
   *
   * v0.14.0 需求2：与 `doLocalUndo` 对称——先看有没有「跨文件替换」的待恢复记录
   * （用户刚撤销掉一次批量替换，接着按 Ctrl+Y 要能把它恢复回来）。
   */
  const doLocalRedo = useCallback((): boolean => {
    return historyCoordinatorRef.current?.handleRedo() ?? false;
  }, []);


  /**
   * v0.15.1 需求1：菜单/右键菜单的**撤销/恢复可用性**必须读统一时间线。
   *
   * 旧实现读 `undoStackRef.length > 0`（已退休的 diff 栈），它永远是 0 →
   * 右键菜单里「撤销/恢复」恒为灰色不可点，用户感知为"撤销彻底坏了"。
   */
  const canUndoUnified = useCallback((): boolean => {
    const key = historyDocKeyOrEmpty();
    return key ? documentHistory.canUndo(key) : false;
  }, [historyDocKeyOrEmpty]);

  const canRedoUnified = useCallback((): boolean => {
    const key = historyDocKeyOrEmpty();
    return key ? documentHistory.canRedo(key) : false;
  }, [historyDocKeyOrEmpty]);

  /**
   * v0.13.2 需求5（返修后口径）：**撤销/恢复总入口**（Ctrl+Z / Ctrl+Y / 菜单 / 工具栏共用）。
   *
   * 用户复测要求：撤销/恢复**只在当前文档生效**，切到别的文档后各自操作自己的历史，
   * 互不干扰。因此这里直接执行当前文档的本地撤销；当前文档已撤到底时给出边界提示，
   * **不**切换到其他文档（跨文档顺序撤销账本已移除）。
   *
   * v0.15.1 需求1：**边界提示的职责已收归协调器**（`historyHost.notifyBoundary`），
   * 这里不再补一条。旧实现在 `doLocalUndo()` 返回 false 时无条件再弹一次
   * 「已到本模式撤销边界」，造成两个问题：
   * 1. **重复提示**（协调器已经弹过，用户一次撤销看到两条）；
   * 2. **误报**：`false` 也可能是「docKey 为空」「跨文件条目过期被丢弃」等原因，
   *    那些场景与"撤到底"无关，弹边界文案是错的。
   */
  const handleUndo = useCallback(() => {
    doLocalUndo();
  }, [doLocalUndo]);


  const handleRedo = useCallback(() => {
    doLocalRedo();
  }, [doLocalRedo]);


  // ─── 注册撤销/恢复回调到 store ─────────────────
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
