/**
 * src/components/editor/panes/SourcePane/SourcePane.tsx —— SourcePane pane
 *
 * ## 职责边界
 *
 * 源码面输入链路（textarea 变更/按键/粘贴/斜杠插入/打字机/专注遮罩）
 *
 * ## 从哪搬来的（v0.17.0 P0-1）
 *
 * 搬自 `src/components/editor/EditorContainer.tsx` 的 组件体 2951-3994 行。
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
  useState,
  useEffect,
} from "react";
import { hasRawBase64Image, maskBase64Images, adjustCursorForMask, unmaskBase64Images } from "../../../../utils/base64ImageMask";
import { inferSourceEditKind } from "../../../../editorHistory/sourceAdapter";
import { documentHistory } from "../../../../services/documentHistory";
import { useEditorStore } from "../../../../stores/useEditorStore";
import { calculateWordCount } from "../../../../utils/wordCount";
import { findSlashTrigger, isInCodeBlock, InsertMode } from "../.././SlashCommand";
import { ContentAnchor, collectPmBlockGeometry, restoreContentAnchor, captureContentAnchor } from "../../../../utils/contentScrollMap";
import { withTrailingParagraph } from "../../../../core/plugins/trailing-paragraph";
import { markdownToDoc } from "../../../../core/markdown/parser";
import { captureTextAnchor, restoreTextAnchor } from "../../../../utils/viewportAnchor";
import { remapOffsetAcrossTextChange, decideSourceScrollRestore } from "../../../../utils/textOffsetRemap";
import { Slice } from "prosemirror-model";
import { useFormatPainterStore } from "../../../../stores/useFormatPainterStore";
import { resolveImageSrc } from "../../../../utils/imagePath";
import { anchorMatchesHeading, resolveLinkAction } from "../../../../utils/linkNav";
import { openExternalHref } from "../../../../utils/openExternal";
import { removeLinePrefix as removeLinePrefixFn, liftListLineToTask as liftListLineToTaskFn, getHeadingPrefix, setLinePrefix as setLinePrefixFn, getLineRange, HEADING_GHOST_TEXTS, buildFormatReplacement, computeGhostTail, parseShortcut } from "../.././sourceFormat";
import { isHttpUrl } from "../../../../core/plugins/smart-paste";
import { planSourceTab, planSourceBackspace } from "../../../../utils/sourceAutoPair";
import { indentUnitString, useSettingsStore } from "../../../../stores/useSettingsStore";
import { planSourceOutdent, planSourceIndent } from "../../../../utils/sourceIndent";
import type { EditorView as EditorView } from "prosemirror-view";
import type { HistoryCoordinator as HistoryCoordinator } from "../../../../editorHistory/coordinator";
import {
  HistoryEntry,
  traceScroll,
  computeSlashInsert,
  buildSourcePairInput,
} from "../../EditorContainer";
import type { SourcePaneParams, SourcePaneResult } from "./types";
import type { SourceSurface } from "../../../../editor/types";

/**
 * 计算把 `from` 文本改成 `to` 文本的**最小连续替换**（公共前缀 + 公共后缀夹逼）。
 *
 * ## 为什么需要（v0.17.0 第二轮 · 用户第 3 项「撤销时页面跳动」的真正修法）
 *
 * 撤销/恢复落地原本走 `setSourceContent(text)` → CM6 `setText()`，而 `setText`
 * 的实现是**整篇替换事务**（`changes: {from: 0, to: doc.length, insert: text}`）。
 *
 * 实测（`scripts/_tmp-dispatch-test2.mjs`，60 段文档滚到 50%）：
 * ```
 * 全文替换                    scrollTop 2781 → 86   （Δ-2695，跳到顶部）
 * 全文替换 + scrollIntoView:false  scrollTop 2406 → 85   （Δ-2321，**依然跳**）
 * 最小变更（只删 3 字符）      scrollTop 2388 → 2388 （Δ0，**纹丝不动**）
 * 最小变更 + 选区设到视口外    scrollTop 2781 → 2781 （Δ0）
 * ```
 * ⇒ **根因是"整篇替换"这个事务形态**，不是 `scrollIntoView` effect，也不是我们的
 * 恢复顺序。整篇替换会让 CM6 的 heightMap 认为**整块布局全变了** → 重估 →
 * `measure()` 里把 `scrollTop` 钳到新坐标系（实测归到 23/63）。
 * 而**最小变更**只影响局部区块，heightMap 增量更新，CM6 完全不会改写 `scrollTop`。
 *
 * 因此修法不是"事后把视口拉回来"（那是遮，且必然有可见中间态），
 * 而是**别用整篇替换**：算最小 diff，走 `applyEdit`（单事务、最小 changes）。
 *
 * 兜底：diff 过大（比如跨文件替换、两侧毫无公共前后缀）时返回 null，
 * 调用方退回原有的整篇写入路径（此时再叠加内容锚恢复）。
 *
 * @returns 可直接喂给 `SourceSurface.applyEdit` 的计划；无法/不值得做最小化时 null
 */
/**
 * 判断一个元素**是不是真的 textarea**（有字符串 `value`）。
 *
 * ## 为什么这个守卫必须是**共享的导出版本**
 *
 * P0 崩溃（v0.17.0 R4）的根因就是：CM6 下 `sourceTextareaRef.current` 指向
 * 中性宿主 `<div class="source-editor source-editor-cm6">`，它**truthy 但没有 `.value`**，
 * 于是 `if (!el)` 守卫完全失效 → `.value.substring(...)` 抛 TypeError →
 * 因为发生在 render 期，ErrorBoundary 接管**整棵树**。
 *
 * 本项目已在 `v0170-div-as-textarea-guard.test.ts` 里登记了这类缺陷，
 * 历史上修过 `captureSourceContentAnchor` / `applyHistoryText` 等处，但**每一处都各写了一遍判断**。
 * 本轮把判断收成一个导出函数，`SlashCommand.tsx` 也从这里 import ——
 * **两处必须同语义**，否则"改一处漏一处"必然重演。
 *
 * ⚠️ 判据必须是 `typeof .value === "string"`，**不能**用真值性判断：
 * CM6 下宿主 div 是 truthy 的，`if (el)` 恒成立（这个坑本项目踩过两次以上）。
 */
export function isRealTextarea(el: unknown): el is HTMLTextAreaElement {
  return !!el && typeof (el as HTMLTextAreaElement).value === "string";
}

export function computeMinimalEdit(
  fromText: string,
  toText: string,
): { from: number; to: number; text: string; caret: number } | null {
  const a = fromText ?? "";
  const b = toText ?? "";
  if (a === b) return null;
  const aLen = a.length;
  const bLen = b.length;
  if (aLen === 0 || bLen === 0) return null; // 空↔非空：整篇语义，退回原路径

  // 公共前缀
  let prefix = 0;
  const minLen = Math.min(aLen, bLen);
  while (prefix < minLen && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix++;

  // 公共后缀（不得越过前缀，避免重叠）
  let suffix = 0;
  const maxSuffix = minLen - prefix;
  while (
    suffix < maxSuffix &&
    a.charCodeAt(aLen - 1 - suffix) === b.charCodeAt(bLen - 1 - suffix)
  ) {
    suffix++;
  }

  const delLen = aLen - prefix - suffix;
  const insLen = bLen - prefix - suffix;

  /**
   * 只接受"小改动"：被替换的旧文本 + 新文本合计不超过文档的 1/4，
   * 否则说明这不是"撤销几步输入"而是"整篇换掉"（切文件/跨文件替换），
   * 那种情况下最小化收益低、且容易把一次整篇语义拆成奇怪的局部编辑。
   */
  const changed = delLen + insLen;
  const budget = Math.max(64, Math.floor(Math.max(aLen, bLen) / 4));
  if (changed > budget) return null;

  return {
    from: prefix,
    to: prefix + delLen,
    text: b.slice(prefix, bLen - suffix),
    // 光标落在插入内容末尾（随后宿主还会按历史条目精确恢复光标）
    caret: prefix + insLen,
  };
}

/**
 * 取「视口中央那一行」的**字符偏移** + 该偏移在**内容坐标系**里的 Y。
 *
 * ## 为什么自己算，而不用 `sourceSurface.captureViewportAnchor()`（★ 重要，别改回去）
 *
 * `CmSourceSurface.captureViewportAnchor()` 当前实现（v0.17.0）是：
 * ```ts
 * const centerY = view.documentTop + scroller.clientHeight / 2;
 * const block = view.lineBlockAtHeight(centerY);
 * ```
 * 但 `EditorView.documentTop` 的语义是**屏幕坐标**
 * （源码：`contentDOM.getBoundingClientRect().top + paddingTop`），
 * **滚动后为负值**；而 `lineBlockAtHeight(h)` 要的是**相对文档内容顶**的高度。
 * 两者混用 ⇒ 滚动越深，算出的"中央"越靠文档开头。
 *
 * 实测（`scripts/_tmp-anchor-test.mjs`，60 段文档，滚到 50%）：
 * ```
 * scrollTop=450 clientHeight=759 documentTop=-291
 * lineBlockAtHeight(scrollTop + ch/2 = 830) → from=545   ← 正确（文档中部）
 * lineBlockAtHeight(documentTop + ch/2 = 88) → from=5     ← 现状，文档开头
 * ```
 * 后果：撤销时"锚点"落在文档开头 → 恢复把视口送回顶部（实测 `scrollTop` 4019→0）。
 *
 * `CmSourceSurface.ts` 不在本轮写入范围，因此这里只用**接口已保证能力**
 *（`getScrollTop` / `getMetrics` / `measureRangeContentY`）按正确口径自己算。
 * 该缺陷已在交付报告里单列，建议 Lead 修那一行（改成 `scrollTop + clientHeight/2`）。
 *
 * ## 算法
 * 语义必须与 textarea 的 `captureTextAnchor` **完全一致**：
 * `viewportY` = 该字符**相对视口顶**的屏幕 Y（0 ~ clientHeight）。只有同口径，
 * 下游 `decideSourceScrollRestore` / 恢复公式才能两种实现共用。
 *
 * 由接口能力反推屏幕 Y（不依赖 CM6 内部 `documentTop`，那个字段的坐标系有缺陷）：
 * ```
 * 屏幕Y(off) = 内容Y(off) − scrollTop
 * ```
 * `measureRangeContentY` 给内容坐标 Y（相对文档内容顶），`getScrollTop()` 给滚动量，
 * 两者相减就是该字符在视口里的屏幕 Y。
 *
 * 目标：找「屏幕 Y 最接近 clientHeight/2」的偏移 —— 即视口中央那一行。
 *
 * ⚠️ **不能**对 `[0, len-1]` 二分：CM6 虚拟化渲染，`coordsAtPos` 对视口外偏移
 * 返回 `null`（实测滚到 50% 时 off=200/1000/4000/5000 全 null，只有视口附近可测）。
 * 恰好"可测区域"就在视口附近，所以**只采样可测点、取最接近中线者**既简单又正确。
 */
export function captureSurfaceCenterAnchor(
  surface: SourceSurface,
): { offset: number; viewportY: number } | null {
  const textLen = surface.getText().length;
  if (textLen <= 0) return null;
  const metrics = surface.getMetrics();
  if (!(metrics.clientHeight > 0)) return null;
  const scrollTop = surface.getScrollTop();
  const midScreenY = metrics.clientHeight / 2;
  const yAt = (o: number): number | null => {
    const s = Math.max(0, Math.min(textLen - 1, o));
    const r = surface.measureRangeContentY(s, Math.min(textLen, s + 1));
    return r ? r.startY : null;
  };

  let best: { offset: number; viewportY: number; dist: number } | null = null;
  const N = 96;
  for (let i = 0; i <= N; i++) {
    const off = Math.round((i / N) * (textLen - 1));
    const y = yAt(off);
    if (y === null) continue; // 视口外/不可测：跳过（不放弃）
    const screenY = y - scrollTop;
    const dist = Math.abs(screenY - midScreenY);
    if (!best || dist < best.dist) best = { offset: off, viewportY: screenY, dist };
  }
  if (!best) return null;
  return { offset: best.offset, viewportY: best.viewportY };
}

export function useSourcePane(p: SourcePaneParams): SourcePaneResult {
  // 解构到本地同名绑定：函数体因此可以逐字节原样
  const {
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
    historyBridgeDepthRef,
    HISTORY_SCROLL_GUARD_MS,
    sourceTextareaRef,
    pushUndoEntry,
    recordDiscreteSourceEdit,
    filePath,
    formatGhostRef,
    isSourceMode,
    autoPairEnabled,
    sourceGhostActiveRef,
  } = p;


  // ─── 源码编辑内容变化 ──────────────────────────
  /**
   * ## v0.17.0 A3 装配修复：把"输入落地"从 React 事件抽象成 surface 驱动
   *
   * 原实现只接受 `React.ChangeEvent<HTMLTextAreaElement>`，因此**只有受控 textarea 能触发**
   * —— CM6 路径下这条链路根本走不到（CM6 的编辑不产生 React onChange）。
   * 这就是"CM6 只读不回写"的另一半根因（另一半是宿主被 React 覆写）。
   *
   * 现在拆成两个入口，**核心逻辑共用**：
   * - `applySourceInput`：语义入参（新内容 + 光标 + 是否组合态），由 surface 的
   *   `onDidChange` 调用 → CM6 路径生效；
   * - `handleSourceChange`：React 事件薄包装 → textarea 路径生效（行为不变）。
   */
  const applySourceInput = useRef((
    newContentRaw: string,
    cursorPosRaw: number,
    opts?: { composing?: boolean; origin?: "dom" | "programmatic"; docChanged?: boolean },
  ) => {
    /**
     * ## v0.17.0 P1-6 根因修复：`clear("input")` 只应在**真实键入**时发生
     *
     * ### 缺陷现象（用户报告）
     * 编辑模式用格式栏 / 语法栏加格式时，源码面看不到灰色占位提示（格式 ghost）。
     * 实机 rAF 采样 **0/211 帧完全不可见**，但 MutationObserver 能抓到瞬时 DOM。
     *
     * ### 因果证据（`scripts/v0170-p1-6-diag-causal.mjs`，页内仪器 + 单变量干预）
     * 点一次「标题一」，本函数被调用 **4 次**，每一次都无条件执行下面的
     * `clear("input")` → `formatGhostRef.current = null`；而按钮自己排的
     * `requestAnimationFrame(render)` 在这之后才跑，`renderFormatGhost` 首行
     * `if (!sourceSurface || !ghost) return;` 直接返回 → **ghost 永远不会出现**。
     *
     * 同一条链路上**零个** `isTrusted` 的 beforeinput/input/keydown 事件
     *（即没有任何真实键入），所以这 4 次 `clear("input")` **全是误判**。
     *
     * 干预实验：把 `clear("input")` 包装成"吞掉"，同样的点击 →
     * ghost 出现并**存活 2733ms**（`appeared=true`，可见采样 165/170）。
     * 这就把"相关性"升级成"因果"。
     *
     * ### 为什么判据是「两个条件同时成立」，而不是任选一个
     *
     * | 事件 | `origin` | `docChanged` | 是否应清 ghost |
     * |---|---|---|---|
     * | 真实键入 | `"dom"` | `true` | **是**（占位提示完成使命） |
     * | 只移动光标/点击/焦点变化 | `"dom"` | `false` | 否（语义表：click/arrow → 保留） |
     * | 程序化 setText（撤销/替换/AI 回写） | `"programmatic"` | `true` | 否（由 `getText() !== content` 护栏管） |
     *
     * - **只看 `origin` 不够**：纯选区变更也是 `"dom"`。实测 4 次误清里有 2 次
     *   就来自 selection-only（见 `shouldClearFormatGhost` 文档表：`click`/`arrow` → false）。
     * - **只看 `docChanged` 也不够**：程序化 `setText` 同样改了文档（`docChanged = true`），
     *   但它不是用户输入（撤销/AI 回写不该清掉用户刚点的格式提示）。
     *
     * 两个信号合起来才等价于「**用户在文档里真的敲了东西**」。
     * 注意这**没有放宽** `shouldClearFormatGhost` 的既有语义表 ——
     * 恰恰相反：它让 `"input"` 这个 kind 名副其实。Esc / 撤销 / 切文件 / 切模式
     * 四条清除时机完全不经过本判据，行为零变化。
     *
     * ### textarea 路径为什么不受影响
     * `handleSourceChange`（React onChange）不传 `origin` / `docChanged`
     * → 两者取缺省 → `isRealInput = true`，与修复前完全一致（`input` 事件只在
     * 值真变了时才触发，本来就是真实输入）。
     */
    const isRealInput = opts?.origin !== "programmatic" && opts?.docChanged !== false;
    // v0.15.1 需求1：真实用户输入 = 选区保护窗立即失效（否则撤销后的光标还原
    // 会跟用户的输入抢光标）。
    pendingSourceSelectionRef.current = null;
    // v0.15.1 需求6（再审计缺陷 1）：连带让撤销时排下的 rAF / 60ms 兜底定时器退场，
    // 否则它们会在 250ms 后把光标抢回撤销位置（实测：输入后 selectionStart 9 → 又被拽回 8）。
    sourceSelectionRestoreTokenRef.current++;
    // v0.7.3 改进10(U3)：任何用户编辑（含自动配对/粘贴/撤销）都会使 source
    // 续写 ghost 位置语义失效——取消任务并清除 overlay（与 PM 模式 docChanged 失效一致）
    sourceGhostHandlersRef.current.invalidate();
    // v0.12.0 需求1：任何真实输入使格式 ghost 完成使命（键入即替换占位提示）
    // v0.17.0 P1-6：**必须经 isRealInput 判据**（见上方长注释）——
    // 否则格式按钮自己造成的内容同步会把它刚设置的 ghost 清掉，功能整体不可见。
    if (isRealInput) formatGhostHandlersRef.current.clear("input");
    let newContent = newContentRaw;
    let cursorPos = cursorPosRaw;
    // v0.6.6 问题4：粘贴/输入 base64 图片 → 实时替换为短标记并补偿光标
    /**
     * ## v0.17.0 性能：避免每键 O(n) 全文扫描
     *
     * `hasRawBase64Image(text)` 内部是 `text.includes("base64,")` —— **全文子串搜索**。
     * 实测开销随文档**线性增长**：
     * - 300KB → **0.12ms**
     * - 1MB → **0.42ms**
     * - 5MB → 外推约 **2.0ms**
     *
     * 而它**在每次按键都被调用**（本函数是每键热路径），于是 5MB 文档每键
     * 白白付出约 2ms —— 这正是「每键处理耗时 T ≈ 2.1ms」的主要构成。
     *
     * ### 优化：用"本次改动是否可能引入 base64"做 O(1) 前置判断
     *
     * 只有**粘贴**才可能一次性引入新的 data URL；普通打字/删除不可能凭空造出
     * `base64,` 这个片段（它不是用户会逐字符敲出来的）。
     * 因此：仅当本次输入看起来是批量插入（长度增量 > 1 个字符）时才做全文扫描。
     *
     * @remarks
     * 这个判断是**保守**的：漏判时只会"这次没 mask"，下次粘贴仍会 mask；
     * 而绝不会误判成需要 mask（那会走完整路径，行为不变）。
     */
    /**
     * ### 优化：只在**可能引入 base64** 时才做全文扫描
     *
     * 判据用 `sourceJustPastedRef`（粘贴前由 `handleSourcePaste` 置 true，
     * 本函数末尾（第 ~220 行）才复位 —— 所以此处读到的正是"本次是否粘贴"）。
     *
     * 为什么粘贴是唯一需要检查的入口：
     * - data URL 长达数万字符，**只可能来自粘贴/拖入**；
     * - 普通打字、退格、IME 提交都不可能凭空拼出 `base64,` 这个片段；
     * - 自动配对/缩进只插入 1~几个字符，同样不可能。
     *
     * 因此非粘贴路径跳过 O(n) 扫描是**语义安全**的：
     * 漏判的后果只是"这一次没 mask"（而实际上也不可能出现 base64），
     * 不可能造成"应该 mask 却没 mask"。
     *
     * @remarks 早先的实现无条件调用 `hasRawBase64Image(newContent)`，
     * 那是全文 `includes("base64,")`；实测 **300KB 0.12ms / 1MB 0.42ms /
     * 5MB 约 2.0ms**，而本函数在每键热路径上 —— 这是「T ≈ 2.1ms」的主要构成。
     */
    const maybeIntroducedBase64 = !!sourceJustPastedRef.current;
    if (maybeIntroducedBase64 && hasRawBase64Image(newContent)) {
      const { text: masked, replacements } = maskBase64Images(newContent, base64TokensRef.current);
      if (replacements.length > 0) {
        cursorPos = adjustCursorForMask(cursorPos, replacements);
        newContent = masked;
        // 回写"mask 后的内容 + 补偿后的光标"：经 surface 统一落地
        // （textarea 实现会同步 DOM value 与选区；CM6 实现走 setText+setSelection）
        sourceSurface.setText(masked, { selection: { start: cursorPos, end: cursorPos } });
      }
    }
    /**
     * ═══ v0.17.0 R4 · T1：#5「阅读模式编辑无法保存 / 切模式后消失」的根因修复 ═══
     *
     * ## 缺陷（数据丢失级，100% 触发）
     *
     * 用户在**阅读模式**打字 → 切到编辑模式 → 阅读面刚打的字**全部消失**，保存也写不进去。
     *
     * ## 根因链条（`scripts/v0170-r4-persist-report.mjs` 实测，非读代码推断）
     *
     * ```
     * 阅读模式打字期间：PM doc=77（含新字）  CM6 doc=74（陈旧副本，源码面隐藏着）
     *                   App.content=78（PM 侧 onDocChange 正确上报）
     * ────── 切到编辑模式：CM6 宿主 display:none → block ──────
     * CmSourceSurface.updateListener:
     *   if (!u.docChanged) {
     *     if (u.selectionSet || u.focusChanged)
     *       v.report("typing", undefined, "dom", false)      ← ★ 纯选区/聚焦，但 kind="typing"
     *   }
     *        ↓
     * 本函数：无条件 setSourceContent(newContent) + onContentChangeRef(newContent)
     *        ↑ newContent = CM6 的**陈旧全文 74**
     *        ↓
     * App.handleContentChange(74)：74 !== 78 → setContent(74) + updateTabContent(74) + 落盘 74
     * ```
     *
     * 实测证据：切换窗口内两次 `report(docChanged=false, textLen=74, pm=77)`，
     * 随后 App/tab/localStorage 全部回滚成 74，而 PM 仍是 77（新字还在，但再也传不出去）。
     *
     * ## 为什么**必然**发生（不是偶发）
     * 切模式一定让 CM6 宿主从 `display:none` 变可见 → 一定产生 focus/selectionSet 事件
     * → 一定走 `report(docChanged=false)` → 一定用陈旧全文回写。
     * 这也解释了用户说的"每次都丢"，以及为什么只在"改完就切模式"时暴露。
     *
     * ## 修法边界（**只拦截内容语义，不拦截展示语义**）
     *
     * 判据 `isContentChange`：只有「文档真的变了」或「程序化整篇写入」才算内容变更。
     * - 真实键入：`docChanged=true` → 是内容变更 ✅
     * - 粘贴/自动配对：同为 `docChanged=true` → ✅
     * - 程序化 `setText`（撤销/AI 回写/模式同步）：`origin="programmatic"` → ✅
     * - **纯选区/聚焦**（`docChanged=false` 且非 programmatic）→ ❌ **不是内容变更**
     *
     * ⚠️ **不能用裸 `return`**（第一版草案的错误）：本函数后半段还承担
     * 光标记录 / 字数统计 / slash 触发检测，其中「Esc 关不掉斜杠菜单」正是
     * 在纯选区事件下暴露的（见下方 `docChangedForSlash` 的长注释）——
     * 裸 return 会让那些逻辑收不到纯选区事件，直接引发新回归。
     * 所以这里**只包住内容语义的写入**，展示语义照常执行。
     *
     * ⚠️ 声明必须放在下面「统一时间线」块**之前**：那个块也用同一判据
     * （陈旧全文不能进时间线，否则会提交一条"把阅读面编辑撤掉"的假历史），
     * 放到它后面会触发 TDZ（`ReferenceError: Cannot access before initialization`）。
     */
    const isContentChange = opts?.docChanged !== false || opts?.origin === "programmatic";
    // v0.15.0 需求（跨模式撤销统一）：源码编辑改由 sourceAdapter 归并后提交到**统一时间线**。
    // 旧 `recordUndoEntry`（diff 栈）退休——它与阅读模式的 PM 栈物理隔离，正是"跨模式撤不掉"
    // 的根因。adapter 负责把连续打字/退格合并成一步（900ms 窗口、光标连续），
    // 并把 IME / 自动配对 / 粘贴各自成组。
    //
    // ⚠️ 时间线只存**真实内容**：`sourceContentRef` 是 base64 mask 后的展示文本，
    // 必须 unmask 后再提交，否则一次撤销会把 data URL 永久退化成 `image-1.png`（存盘即损坏）。
    // ⚠️ v0.17.0 R4 · T1（#5）：本块**同属内容语义** —— 纯选区/聚焦事件（`docChanged=false`）
    // 携带的是 CM6 的陈旧全文，若让它进统一时间线，会提交一条"把阅读面编辑撤掉"的假历史，
    // 用户随后按 Ctrl+Z 反而"再也回不来"。因此必须与上面的内容写入同进同退。
    if (isContentChange) {
      const beforeReal = unmaskBase64Images(
        sourceContentRef.current,
        base64TokensRef.current,
      );
      const afterReal = unmaskBase64Images(newContent, base64TokensRef.current);
      /**
       * ## ═══ v0.17.0 P1-2：**撤销/恢复落地不得再写一条新历史** ═══
       *
       * 实机 trace（`_plan/v0170-p1-2-undo-redo-alternating.md`）给出的完整因果链：
       *
       * ```
       * apply.enter      n=1 cur=1 known=22        ← 时间线只有 1 条，游标在顶
       * apply.peek       n=1 cur=1                 ← 正常拿到那一条
       * commit.source.enter   n=1 cur=1 known=22   ← ★ ③ applyText 落地时又进来一次 commit
       * commit.forceRebase    snapBefore n=1       ← 基线失配 → 强制 rebase
       * commit.source.result  n=2 cur=2 entryId=2  ← ★ **时间线多出一条！redo 分支被 truncate**
       * apply.consume    n=2 cur=1                 ← 消费后游标才回到 1
       * ```
       *
       * 后果：每按一次 Ctrl+Z，时间线就多一条"撤销自身造成"的条目并把 redo 分支推平 →
       * 下一次 Ctrl+Y 拿到的不是用户期望的那条 → **交替 undo/redo 每两次只有一次生效**
       * （实测命中 3/6；而单调连按 undo 反而正常，因为它每次都在"往前走"）。
       *
       * 根因：`host.applyText()` 走的是 `setSourceContent(text)` → CM6 `setText`
       * → `onDidChange` → 本函数。虽然协调器传了 `{ bridge: true }`，但**本函数看不到它**
       * —— `applySourceInput` 只收 `(newContent, cursorPos, { composing })`。
       *
       * 修法：把 bridge 期间的上报**只用于同步展示文本，不提交历史**。
       * 用 `historyBridgeDepth` 计数器（不是布尔）的原因：撤销落地过程中还可能嵌套
       * 触发展示层 mask/unmask 的二次 setSourceContent，布尔量会被中途复位。
       */
      if (historyBridgeDepthRef.current > 0) {
        lastRealTextRef.current = afterReal;
        // 不 commit、不 rebase：时间线的 knownText 由协调器在 ④b `syncAdapterBaseline` 维护
        setSourceContent(newContent);
        onContentChangeRef.current?.(newContent);
        setDirtyRef.current(true);
        return;
      }
      /**
       * v0.17.0 A2（修复 C14 第一处）：**输入意图由事件源头判定**，不再靠文本形状猜。
       *
       * 旧实现把 `composing/justPaired/justPasted` 三个一次性标记喂给
       * `inferSourceEditKind`，但这三个标记在原文件里**从未被置 true**（P0 实测确认：
       * 3 处声明、3 处读取、2 处清零，零处置位），所以真正生效的只有它末尾那条
       * "长度变短 → delete，否则 typing" 的猜测 —— 于是 IME/配对/粘贴三类
       * "一步归并"从未生效，一次拼音会拆成多步、一次补全会和后续打字合并。
       *
       * 现在：
       * - IME 直接取原生事件 `isComposing`（composition 期间的 input 事件必为 true），
       *   这是**源头事实**，比任何事后推断都可靠；
       * - 配对/粘贴取落地路径与 DOM 事件处置位（见上方 justPaired/justPasted 的赋值）；
       * - 只有三者都不是时才退回 `inferSourceEditKind`（此时它只剩 delete/typing 判定，
       *   那两条本来就是合法规则，不是猜测）。
       */
      // `nativeEvent` 的静态类型是 Event，但 React 的合成事件在这里一定是 InputEvent
      // （textarea 的 onChange 对应原生 input 事件），InputEvent 有 isComposing。
      const nativeComposing = !!opts?.composing;
      const plan = sourceAdapterRef.current.plan({
        before: beforeReal,
        text: afterReal,
        kind: inferSourceEditKind({
          before: beforeReal,
          after: afterReal,
          composing: nativeComposing || sourceComposingRef.current,
          justPaired: sourceJustPairedRef.current,
          justPasted: sourceJustPastedRef.current,
        }),
        selection: { start: cursorPos, end: cursorPos, scrollTop: sourceSurface.getScrollTop() },
        // v0.15.1 需求1：把**编辑前**的现场也带上（撤销要回到这里）。
        // 光标取"上一次已知光标 + 本次长度增量"反推（onChange 触发时 DOM 选区已在新位置）；
        // 滚动取上一帧记录的 scrollTop（同一行打字时它不变，跨行回车时它才是对的旧值）。
        beforeSelection: {
          start: Math.max(0, cursorPos - (afterReal.length - beforeReal.length)),
          end: Math.max(0, cursorPos - (afterReal.length - beforeReal.length)),
          scrollTop: lastSourceScrollTopRef.current,
        },
      });
      // 三个一次性标记消费后复位：它们只描述"刚刚发生的那一次输入"
      sourceJustPairedRef.current = false;
      sourceJustPastedRef.current = false;
      if (plan) historyCoordinatorRef.current?.commitFromSource(plan);
      else if (beforeReal !== afterReal) {
        // adapter 认为不需要新条目（例如仍是同一组连续输入）→ 只推进时间线基线，
        // 保证下一条 commit 的 before 与宿主逐字节一致（否则会被 commit 拒绝）。
        const key = historyDocKeyOrEmpty();
        if (key) documentHistory.rebaseText(key, afterReal);
      }
      lastRealTextRef.current = afterReal;
    }
    /**
     * 内容语义写入块（`isContentChange` 见上方长注释）。
     *
     * ⚠️ 这里**必须**用同一判据：`docChanged=false` 的纯选区/聚焦上报携带的是
     * CM6 的陈旧全文，直接回写会把 App 的内容状态回滚成源码面副本（数据丢失级）。
     */
    if (isContentChange) {
      setSourceContent(newContent);
      onContentChangeRef.current?.(newContent);
      setDirtyRef.current(true);
      // v0.6.1 问题3：用户手动编辑恢复正常自动保存（解除翻译回写抑制）
      useEditorStore.getState().setSuppressAutoSave(false);
      // v0.6.1 问题2：用户手动编辑后原文快照失效，清除"取消翻译"气泡
      useEditorStore.getState().setTranslateUndoSnapshot(null);
      // lastContentRef 与 content prop 同为真实坐标（出口 unmask 后的值），
      // 保证行 551 的相等检查不会因坐标系不同而误触发 PM 全量重建
      lastContentRef.current = unmaskBase64Images(newContent, base64TokensRef.current);
    }
    // ⚠️ 以下属于**展示语义**，必须在拦截之外照常执行（见上方修法边界）
    lastTextareaCursorRef.current = cursorPos;

    // G11：源码模式下更新字数统计（防抖 300ms，与 ProseMirror 模式一致）
    if (wordCountTimerRef.current) clearTimeout(wordCountTimerRef.current);
    wordCountTimerRef.current = setTimeout(() => setWordCountRef.current(calculateWordCount(newContent)), 300);

    // SlashCommand 触发检测：行首 / 且不在代码块内
    // 后续 query 更新和失效关闭由 SlashCommand 组件内部监听 input 处理
    //
    // ─── v0.17.0 R4 · T2（**Esc 关不掉菜单**的真正根因）───
    // 原实现无条件 `setSlashCommandOpen(true)`，没有区分"文档真的变了"和"只是选区动了"。
    // CM6 下这两者都走本函数（`onDidChange` 对 selection-only 也会上报，`docChanged=false`），
    // 于是产生这条自噬环路（探针 `v0170-r4-slash-verify.mjs` S6 实测 menu 1→1）：
    // ```
    // Esc → SlashCommand.onClose() → setSlashCommandOpen(false)      ← 菜单关了
    //     → handleSlashClose 的 rAF 恢复光标 → surface.setSelection()
    //     → CM6 dispatch 一次**纯选区事务** → onDidChange(docChanged=false)
    //     → 本函数 → findSlashTrigger(文本, col=1) 命中 → setSlashCommandOpen(true)  ← 又开了
    // ```
    // textarea 路径不受影响：`setSelectionRange` 不产生 `input` 事件，本函数根本不会被调。
    // ⇒ 只有 CM6 路径会"Esc 之后菜单立刻弹回来"。
    //
    // 修法：**只有文档内容真的变了**才允许（重新）打开菜单。
    // 纯选区变更（点击/方向键/恢复光标）不该开菜单；程序化写入（`setText` 撤销/替换/AI 回写）
    // 同样不该开 —— 它们都不是"用户在行首敲了 `/`"。
    // textarea 路径不传 `docChanged`（缺省 undefined → 视为 true），行为零变化。
    const docChangedForSlash = opts?.docChanged !== false && opts?.origin !== "programmatic";
    const trigger = findSlashTrigger(newContent, cursorPos);
    if (docChangedForSlash && trigger.trigger && !isInCodeBlock(newContent, cursorPos)) {
      setSlashCommandOpen(true);
    }
  });

  /**
   * React 事件薄包装（**textarea 路径**）：把事件解成语义入参后交给 `applySourceInput`。
   *
   * ⚠️ 这里保留 `e.target` 读值而不是走 surface：React 的 onChange 在 value 更新**之后**
   * 触发，`e.target.value` 就是权威值；而 textarea 实现的 surface 也读同一元素，两者等价。
   * 保留它可以让 textarea 路径**零行为变化**（jsdom 全量测试依赖这一点）。
   */
  const handleSourceChange = useRef((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    applySourceInput.current(e.target.value, e.target.selectionStart ?? 0, {
      composing: !!(e.nativeEvent as InputEvent | undefined)?.isComposing,
    });
  });


  /**
   * v0.15.1 需求1：撤销/恢复落地后**保住阅读面的滚动位置**。
   *
   * 缺陷（用户原话「进行撤销时候文档会滚动底」）：撤销把整篇 doc `replaceWith` 成更短的
   * 内容后，`scrollHeight` 立刻变小 → 浏览器把 `scrollTop` 钳到**新的 max**（= 底部），
   * 而 `editor.ts` 的 dispatchTransaction 里那段"保存/恢复 scrollTop"也会被同一个钳位
   * 打回（它写的是旧像素值，超过新 max 就被钳到 max）。
   * 结果：撤销一次，视口就贴到底。
   *
   * 修法：**锚内容不锚像素**。撤销前采「视口中央是哪个块 + 块内比例」，落地后按新几何
   * 反算 scrollTop；块表在异步布局（图片/mermaid 撑高）里会变，故 0/60/160ms 各校正一次，
   * 用户一旦自己滚了就停手（`userScrolled` 判据用输入事件，不用 scrollTop 差值 ——
   * 浏览器钳位会被误判成用户操作，见语义地图 §4-31）。
   *
   * ## ⚠️ v0.17.0 R4 · T2（用户第 3 项「撤销时页面跳动」的**唯一残留项**）
   *
   * ### 已实测排除的（`scripts/v0170-r4-undo-anchor.mjs`，连续量判据）
   * 用「锁定段落的屏幕 Y」而不是「视口中心 PI 段号」复判（PI 是离散量，
   * 中线跨块边界就翻转，会把"没动"误报成"漂移"，本轮先踩了这个坑）：
   * ```
   * S1 有序列表 Ctrl+T → 撤销（**用户报的场景**）   锚段Y maxJump 0px，反转 0  ← 本来就好的
   * S5 引用        → 撤销                        锚段Y maxJump 0px，反转 0  ← 好
   * S6 删除文字    → 撤销                        锚段Y maxJump 0px，反转 0  ← 好
   * S3 标题 Ctrl+2 → 撤销                        锚段Y maxJump 16px，反转 2 ← **唯一残留**
   * ```
   *
   * ### S3 的机制（`scripts/v0170-r4-undo-attr.mjs` 逐帧 + 写入溯源）
   * ```
   * t2242: st1959 / anchorY 400.67 / sh 5151   ← sh 先塌 23px（标题降级，行高变小）
   * t2259: st1946 / anchorY 413.67 / sh 5151   ← ★ 我们写 st-13，把锚段从正确位置推回 +13px
   * ```
   * 撤销**本身**已经把锚段放对了（400.67，正是编辑前的位置），
   * 但本函数的锚点补偿又把它推走 13px —— 用户看到一次 16px 位移 + 一次回摆。
   *
   * **根因与 #1 同类，是同一个认知错误的第二处**：
   * `capturePreviewScrollAnchor` 在 dispatch **之前**采的是 `{blockIndex, ratioWithinBlock,
   * viewportY}`；而"标题→正文"这类编辑会**改变块自身高度**（H2 行高 ≈ 正文的 1.8 倍）。
   * 于是"块内比例 × 新块高"再反算出的目标值，与用户眼前那一行**不是同一个位置**。
   * 我在 #1 里已经写下过这句话：「拿旧期望比新现实必然偏」——这里栽的是同一个坑。
   *
   * ### 修法：**小偏差不纠**（与本轮 #1 的 `minimalApplied` 兜底同一策略）
   * 撤销路径的 `replaceWith` 是整篇事务，但它**不是** heightMap 重估（PM 没有 heightMap），
   * 且实测"撤销本身已把位置放对"。所以：只在**偏差大到用户会明显觉得视野跑了**时纠一次。
   *
   * 阈值取 `clientHeight / 2`（约 380px），理由：
   * - 正常块高变化（标题↔正文、加/删列表）造成的反算偏差是**一行到几行**（实测 13~23px）；
   * - 半个视口以上的偏差不可能是这种"反算偏差"，只可能是真的跑飞（内容塌陷/贴底）；
   * - 这保留了 v0.15.1 修的那个原始缺陷（撤销后贴底）的防线 —— 那是数百到数千 px 量级。
   *
   * ⚠️ 不改成"完全不纠"：v0.15.1 的「撤销一次就滚到底」是真缺陷，必须留着这条防线。
   *
   * @returns 一个"落地后调用"的还原函数（撤销前先调 `capturePreviewScrollAnchor`）
   */
  const restorePreviewScrollFromAnchor = (
    anchor: ContentAnchor | null,
    userScrolledRef: { current: boolean },
  ): void => {
    if (!anchor) return;
    const apply = () => {
      if (userScrolledRef.current) return;
      const container = editorRef.current;
      if (!container || container.clientHeight <= 0) return;
      const blocks = collectPmBlockGeometry(container);
      if (!blocks) return;
      const top = restoreContentAnchor(blocks, anchor, container.clientHeight, {
        contentHeight: container.scrollHeight,
      });
      if (top === null) return; // 映射不到就放弃（绝不写 0）
      /**
       * 小偏差不纠（见上方长注释的实测依据）。
       * `container.clientHeight / 2` ≈ 380px，正常块高变化只会造成一行到几行（13~23px）的
       * 反算偏差，远达不到这个量级；而 v0.15.1 要防的"贴底"是数百~数千 px。
       */
      const delta = top - container.scrollTop;
      const rescueThreshold = Math.max(120, container.clientHeight / 2);
      if (Math.abs(delta) <= rescueThreshold) return;
      container.scrollTop = top;
    };
    requestAnimationFrame(() => {
      apply();
      // 图片 / mermaid / katex 异步撑高会改块几何，短窗口内再校正两次
      window.setTimeout(apply, 60);
      window.setTimeout(apply, 160);
    });
  };


  /** 撤销前采集阅读面滚动锚点（阅读面此刻可见，几何可信） */
  const capturePreviewScrollAnchor = (): ContentAnchor | null => {
    const container = editorRef.current;
    if (!container || container.clientHeight <= 0) return null;
    const blocks = collectPmBlockGeometry(container);
    if (!blocks) return null;
    return captureContentAnchor(blocks, container.scrollTop, container.clientHeight, {
      contentHeight: container.scrollHeight,
    });
  };


  /**
   * v0.15.0 需求（跨模式撤销统一）：把时间线条目的目标文本**写回宿主**。
   *
   * 这是 coordinator 唯一的落地通道（通过 `applyHistoryTextRef` 注入），必须保证：
   * - 阅读模式：整篇 replaceWith 的 bridge 事务带 `addToHistory:false` + `historyBridge:true`，
   *   否则 pmAdapter 会把"撤销动作本身"当成新编辑再记一条 → 一次按键双撤销/来回弹；
   * - 源码模式：写 `setSourceContent` + `sourceContentRef` + 上层通知，并按 selection 恢复光标；
   * - 两条路径都**不得**再走旧 `pushUndoEntry/recordUndoEntry`（已退休）。
   */
  applyHistoryTextRef.current = (text, restore, meta) => {
    const bridgeMeta = meta as { bridge?: boolean; direction?: "undo" | "redo" } | undefined;
    const isBridge = bridgeMeta?.bridge === true;
    if (viewMode === "preview" && isMdFile) {
      const view = viewRef.current;
      if (!view || view.isDestroyed) return;
      // v0.15.1 需求1：撤销前先记「视口中央是哪块内容」，落地后按新几何还原。
      // 必须在 dispatch 之前采（dispatch 后 doc 已换、几何已变）。
      const scrollAnchor = capturePreviewScrollAnchor();
      /**
       * v0.15.4 需求10：进入**撤销滚动窗口**。
       *
       * 打开窗口后，`.ProseMirror` 的 keyup 处理器不再调用 `scrollToVisible()` /
       * `scrollToCenter()`（用户只按了 Ctrl+Z，不该触发"把光标滚进视口"）；
       * 窗口内的视口位置由下面 `restorePreviewScrollFromAnchor` 的内容锚点统一负责。
       * 不开窗口的后果（实测）：锚点先把视口放对 → keyup 把视口推到光标（+3448px）
       * → 60ms 后锚点拉回（−3448px）= 用户看到的「撤销时文档抖一下」。
       */
      historyScrollGuardUntilRef.current = performance.now() + HISTORY_SCROLL_GUARD_MS;
      const userScrolledRef = { current: false };
      const markUserScrolled = () => {
        userScrolledRef.current = true;
      };
      const container = editorRef.current;
      // 用户接管判据：**输入事件**（wheel/pointerdown/touchstart/滚动键），排除修饰键
      // —— 浏览器钳位产生的 scroll 事件不能算用户操作。
      const onWheel = () => markUserScrolled();
      const onPointer = () => markUserScrolled();
      const onKey = (e: KeyboardEvent) => {
        if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
        if (/^(PageUp|PageDown|Home|End|ArrowUp|ArrowDown|ArrowLeft|ArrowRight| )$/.test(e.key)) {
          markUserScrolled();
        }
      };
      container?.addEventListener("wheel", onWheel, { passive: true });
      container?.addEventListener("pointerdown", onPointer, { passive: true });
      container?.addEventListener("touchstart", onPointer, { passive: true });
      window.addEventListener("keydown", onKey, true);
      try {
        const newDoc = withTrailingParagraph(markdownToDoc(text));
        const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, newDoc.content);
        // 🔴 关键：撤销动作的落地不进 PM 历史；只用 historyBridge 标记让 pmAdapter 忽略整批
        tr.setMeta("addToHistory", false);
        if (isBridge) tr.setMeta("historyBridge", true);
        view.dispatch(tr);
        // v0.15.1 需求1：整篇替换会让 scrollHeight 变小 → 浏览器把 scrollTop 钳到新 max
        // （= 贴底）。这里按内容锚点还原，避免"撤销一次就滚到底"。
        restorePreviewScrollFromAnchor(scrollAnchor, userScrolledRef);
      } catch (e) {
        console.error("[EditorContainer] 统一撤销：阅读模式写回失败:", e);
      } finally {
        // 还原窗口结束（约 200ms）后解绑，避免长期挂监听
        window.setTimeout(() => {
          container?.removeEventListener("wheel", onWheel);
          container?.removeEventListener("pointerdown", onPointer);
          container?.removeEventListener("touchstart", onPointer);
          window.removeEventListener("keydown", onKey, true);
        }, 260);
      }
      return;
    }
    // 源码模式：写 state + 恢复光标/滚动
    //
    // v0.15.4 需求10：源码面同样进入撤销滚动窗口。
    // 源码面没有 keyup 的 scrollToVisible 路径，但 textarea 的**原生动滚动**
    // （`setSelectionRange` 后浏览器把光标滚入视口）会在下面的选区恢复里发生，
    // 与 `applyScrollRestore` 的内容锚校正互相踩 —— 同样一次「先跳后回」。
    // 窗口内不接管具体写入（下面本来就是锚点统一负责），只需要让
    // 其它自动滚动路径（打字机居中 / ResizeObserver 补偿）让位。
    historyScrollGuardUntilRef.current = performance.now() + HISTORY_SCROLL_GUARD_MS;
    //
    // ─── v0.15.3 返修（缺陷 A）：跨模式撤销后源码面「贴底」────
    //
    // ## 缺陷（实机取证，打包产物 v0.15.2，`scripts/v0153-probe-undo-big.mjs`）
    // 用户在**阅读模式**里编辑几步 → 切**源码模式** → Ctrl+Z。
    // 被撤的那条条目是 **PM 条目**，`HistoryEntry.beforeSelection` 是 undefined
    // （PM 侧 `beforeAnchor` 至今未接线，见 `editorHistory/pmAdapter.ts`）。
    // 于是旧实现的 `if (sel)` 不成立 → **完全不恢复滚动**；而文本变短让
    // `scrollHeight` 变小 → 浏览器把 `scrollTop` 钳到新 max = **贴底**。
    // 实测：撤销前 `top=21531 / max=21948`，撤销后 `top=21112 / max=21113`
    // （距底 1px；61 帧采样里 57 帧贴底）；接着切回阅读面 `top=max=11485`（全贴底）。
    // 用户看到的就是「撤销/恢复文档会抖动」+「之后双击 Ctrl 漂移」。
    //
    // ## 修法：锚**内容**不锚像素（与阅读面同一口径）
    // 1. 写入**之前**（此刻 textarea 还是旧文本）采「视口中央那一行字符的偏移」， 
    //    即 `{ offset, viewportY }`；
    // 2. 用 `remapOffsetAcrossTextChange` 把 offset 从旧文本映射到目标文本
    //    （字符偏移与排版、字号、软换行、文本长度全都无关）；
    // 3. 写入后用同一套 rAF / 60ms / 160ms 校正把那一行拉回原视口 Y。
    // 像素只在「文本长度不变」时作快路径；**永不写 0**（写 0 = 丢进度，v0.14.0 P1 老 bug）。
    // TODO(v0.18): CM6 能力缺口 — 撤销滚动的文本框几何。当前 CM6 表现：撤销后滚动位置不精确（退化为像素/不恢复），内容正确 | 用户可感知度：低 | 建议优先级：P2
    const textarea = sourceTextareaRef.current;
    /**
     * ⚠️ v0.17.0：`sourceTextareaRef.current` 在 CM6 下是**中性 div**（非 null）。
     *
     * 于是 `textarea ? textarea.value : ""` 这个三元**取不到 ""** ——
     * div 的 `value` 是 `undefined`，随后 `beforeText.length` 直接抛
     * `TypeError: Cannot read properties of undefined (reading 'length')`。
     *
     * 后果：**任何撤销/恢复在 CM6 下都崩在这一行**（实测：Ctrl+Z 后内容完全不变，
     * 且抛未捕获异常）。这是 undo 时间线在 CM6 下失效的真正原因。
     *
     * 修法：统一判"是不是真 textarea"，并且文本来源优先用权威的 `currentRealText`
     * 语义（`sourceContentRef.current`），div/textarea 两条路径都成立。
     */
    const isRealTextarea =
      !!textarea && typeof (textarea as unknown as { value?: unknown }).value === "string";
    const sel = restore as { start: number; end: number; scrollTop?: number } | undefined;
    /**
     * 写入前采内容锚（必须在 `setSourceContent` 之前 —— 之后 textarea.value 已是新文本，
     * 采到的 offset 就指向新文本的同一偏移，而不是"眼前那一行"）。
     * 取**视口中央**（与阅读面 `capturePreviewScrollAnchor` 同口径：用户判断"阅读焦点"
     * 看的是视口中间）。不可见 / 内容不足一屏时 `captureTextAnchor` 返回 null，
     * 决策函数会安全地退到像素或 none 分支。
     *
     * ## ⚠️ v0.17.0 第二轮（用户第 3 项「撤销/恢复页面位置跳动」的真正根因）
     *
     * 原实现这里写死 `isRealTextarea ? captureTextAnchor(...) : null` ——
     * **CM6 下锚点恒为 null**。于是整条恢复链在 CM6 上全线失效：
     *
     * 1. `decideSourceScrollRestore` 拿不到锚点 + `textLengthChanged=true` → `kind="none"`；
     * 2. 下面 `applyScrollRestore` 首行 `if (!isRealTextarea) return` → **不执行**；
     * 3. 选区通道按设计不写像素（`scrollTopForSelection = null`）。
     *
     * 三条全空 ⇒ **源码面撤销/恢复在 CM6 下没有任何滚动恢复**。
     * 而撤销落地是"整篇 `setText` + 全文替换事务"，CM6 会把**旧选区**映射过全文替换
     * （折叠光标落在替换区间边界附近 → 近似文档开头），再把该选区滚进视口 ⇒
     * 视口被拽到文档顶部。
     *
     * 实测（`scripts/v0170-r2-scroll-jump.mjs`，browser probe，真实滚轮滚到 50%）：
     * ```
     * 撤销前 scrollTop=4019 视口中心 PI30@270
     * Ctrl+Z 后 scrollTop=102  视口中心 PI3@299      ← 跳 3917px（97 帧里单帧 3917px）
     * 页内 scrollTop 打桩：写入 2 次，**两次都来自 CM6 自己的 measure**
     *   （`xn.measure`），我们的代码一次都没写 —— 印证"恢复链整段未执行"
     * ```
     *
     * 修法：CM6 走 `sourceSurface.captureViewportAnchor()`（内部 `coordsAtPos`，
     * 给出"视口中央那一行的字符偏移 + 内容坐标系 Y"），与 textarea 的
     * `captureTextAnchor` **同语义**，因此下游 `remapOffsetAcrossTextChange` /
     * `decideSourceScrollRestore` 一行都不用改。
     */
    const histAnchor = isRealTextarea
      ? captureTextAnchor(textarea as unknown as HTMLTextAreaElement, Math.max(0, (textarea as unknown as HTMLTextAreaElement).clientHeight / 2))
      : captureSurfaceCenterAnchor(sourceSurface);
    // 文本来源：真 textarea 用其 value（与 DOM 完全同步）；否则用权威 state 镜像。
    const beforeText = isRealTextarea
      ? (textarea as unknown as HTMLTextAreaElement).value
      : sourceContentRef.current ?? "";
    const beforeTextLength = beforeText.length;
    /**
     * ## ★ v0.17.0 第二轮：落地改走**最小 diff 事务**（用户第 3 项"撤销抖动"的修法）
     *
     * 原实现是无条件 `setSourceContent(text)` → CM6 `setText()`（**整篇替换事务**）。
     * 实测证明正是"整篇替换"这个形态让 CM6 重估整块 heightMap，进而在
     * `measure()` 里把 `scrollTop` 钳到 23/63（跳到顶部），我们随后才拉回 →
     * 用户看到整屏往返。
     *
     * 换成最小 diff 后：heightMap 只增量更新受影响区块，CM6 **根本不改写 scrollTop**
     *（实测最小变更 Δ0px，即使选区在视口外也是 Δ0）。
     * 这样连内容锚恢复都不必"抢帧"——中间态压根不存在。
     *
     * 仍保留内容锚恢复作为**兜底**：diff 过大（`computeMinimalEdit` 返回 null，
     * 例如跨文件替换/整篇换掉）时退回原整篇路径，那时锚点恢复仍然必要。
     */
    const minimal = isRealTextarea ? null : computeMinimalEdit(beforeText, text);
    setSourceContent(text);
    sourceContentRef.current = text;
    onContentChangeRef.current?.(text);
    setDirtyRef.current(true);
    lastContentRef.current = text;
    lastRealTextRef.current = text;
    /**
     * 最小 diff 落地：经 `applyEdit` 走**单事务最小 changes**，不让 CM6 重估整篇。
     *
     * ⚠️ 这一笔必须在 `setSourceContent` **之后**（先让 React state 与
     * `sourceContentRef` 指向新文本，受控写入 effect 才会认为"已经是目标值"而跳过
     * 整篇 `setText`）。若放在之前，effect 会再写一次整篇，前功尽弃。
     *
     * 用 `applyEdit` 而不是自己 `setText` 的原因：它是接口既有的"离散编辑"通道，
     * 且会在 CM6 侧标记 `userEvent: "input.pair"`，宿主据此把这次落地归为一步
     *（不产生额外的撤销条目——与 `historyBridgeDepthRef` 的语义一致）。
     */
    if (minimal) {
      try {
        sourceSurface.applyEdit({
          kind: "edit",
          edit: {
            from: minimal.from,
            to: minimal.to,
            text: minimal.text,
            caret: minimal.caret,
          },
        });
        traceScroll("undo-source-minimal", {
          from: minimal.from,
          to: minimal.to,
          insLen: minimal.text.length,
          delta: minimal.text.length - (minimal.to - minimal.from),
        });
      } catch {
        /* 最小化落地失败：下面的内容锚恢复仍然兜底 */
      }
    }
    // 时间线只存真实内容，因此 text 已是 unmask 后的完整文本；
    // 展示层需要重新 mask 成短标记，否则 textarea 里会平铺超长 base64。
    const { text: masked } = maskBase64Images(text, base64TokensRef.current);
    if (masked !== text) {
      setSourceContent(masked);
      sourceContentRef.current = masked;
      onContentChangeRef.current?.(masked);
    }
    /**
     * 滚动恢复计划（写入后执行）。
     *
     * 注意 `masked` 才是 textarea 真正会显示的文本：锚点 offset 必须映射到
     * `masked` 而不是 `text`，否则含 base64 图片的文档上偏移会整体错位。
     *
     * 用写入**前**的 `beforeText` 作映射源（而不是写后再读 `textarea.value`）：
     * `setSourceContent` 是 React 受控更新，此刻 DOM 上可能还是旧值、也可能已是
     * 新值，取决于是否在同一个提交里 —— 唯一确定的是我们手里留存的这份旧文本。
     */
    const afterTextLength = masked.length;
    const remapped = histAnchor
      ? {
          offset: remapOffsetAcrossTextChange(histAnchor.offset, beforeText, masked),
          viewportY: histAnchor.viewportY,
        }
      : null;
    const scrollPlan = decideSourceScrollRestore({
      textLengthChanged: afterTextLength !== beforeTextLength,
      anchor: remapped,
      pixelScrollTop: sel && typeof sel.scrollTop === "number" ? sel.scrollTop : null,
    });
    traceScroll("undo-source", {
      histAnchor: histAnchor ? { o: histAnchor.offset, y: Math.round(histAnchor.viewportY * 100) / 100 } : null,
      beforeLen: beforeTextLength,
      afterLen: afterTextLength,
      sel: sel ? { s: sel.start, st: typeof sel.scrollTop === "number" ? sel.scrollTop : null } : null,
      plan: scrollPlan.kind,
      planOffset: scrollPlan.kind === "anchor" ? scrollPlan.anchor.offset : null,
      /**
       * 诊断字段也改用 `isRealTextarea` 判定 —— div 上 `scrollTop/scrollHeight/clientHeight`
       * 都是 `undefined`，`Math.round(undefined * 100)` 会得到 **NaN**，
       * 让 trace 里出现 `taTop: null, taMax: NaN` 这类垃圾数据（不崩但会误导排查）。
       */
      taTop: isRealTextarea ? Math.round((textarea as unknown as HTMLTextAreaElement).scrollTop * 100) / 100 : null,
      taMax: isRealTextarea
        ? Math.max(
            0,
            (textarea as unknown as HTMLTextAreaElement).scrollHeight -
              (textarea as unknown as HTMLTextAreaElement).clientHeight,
          )
        : null,
      taCh: isRealTextarea ? (textarea as unknown as HTMLTextAreaElement).clientHeight : null,
    });
    /**
     * 落地滚动恢复。
     *
     * 为什么 0 / 60 / 160ms 三段：与阅读面 `restorePreviewScrollFromAnchor` 同款 ——
     * `setSourceContent` 是受控组件，React 提交后浏览器还要重排一次（长文尤其明显），
     * 单帧恢复会在重排后被推走。三段全部用**同一锚点**（幂等）。
     */
    const applyScrollRestore = () => {
      const ta = sourceTextareaRef.current;
      /**
       * ⚠️ v0.17.0：这里必须判"是不是真 textarea"，不能只判 `!ta`。
       *
       * CM6 下 `ta` 是 div（非 null），`div.clientHeight` **有值**（不像 value 是 undefined），
       * 所以 `if (!ta || ta.clientHeight <= 0) return` **挡不住**。
       * 继续往下走会调 `restoreTextAnchor(div, …)` —— 那里读 `textarea.value`
       * 得到 undefined，恰好被 `if (!text) return` 兜住（**目前**不崩）。
       * 但这属于"靠 falsy 偶然兜底"，一旦下游改成 `text.length` 就会崩。
       * 故在此显式判定，把语义写清楚。
       */
      const isRealTextarea = !!ta && typeof (ta as unknown as { value?: unknown }).value === "string";
      /**
       * ## ⚠️ v0.17.0 第二轮：CM6 分支（用户第 3 项的真正修法）
       *
       * 原实现 `if (!isRealTextarea) return;` —— **CM6 下整段恢复直接跳过**。
       * 这就是「撤销后视口跳到文档顶部」的直接原因（配合上面 `histAnchor` 的修法）：
       * 内容锚现在有了（`captureViewportAnchor`），恢复也必须真的执行。
       *
       * ### ⚠️ 两个实现的 `viewportY` **不是同一个坐标系**（差点写错，记在这里）
       *
       * - textarea 的 `captureTextAnchor`：`viewportY` 是**相对视口顶**的 Y
       *  （0 ~ clientHeight），所以 `restoreTextAnchor` 里 `delta = y新 − y旧` 直接补偿。
       * - CM6 的 `captureViewportAnchor`：`viewportY = coords.top − view.documentTop`，
       *   是**内容坐标系** Y（相对文档内容顶，含 paddingTop）。
       *
       * 若照抄 textarea 的 `delta` 算法会得到 `delta ≈ 0`（同一行内容 Y 前后几乎不变）
       * → 等于什么都没恢复。**实测印证**：第一版这样写时，撤销后
       * `scrollTop 102 → 107 → 112`（只挪了 10px），视口仍停在 PI3。
       *
       * ### 采用的恢复口径：把锚点偏移送回**视口中央**
       *
       * CM6 的 `captureViewportAnchor` 契约本就是「**视口中央**内容锚点」
       *（见 `src/editor/types.ts` 对该方法的说明）。既然锚点就是"中央那一行"，
       * 逆操作就该是"把这一行放回中央"—— `scrollToOffset(offset, { center: true })`。
       *
       * 为什么它比"自己算 delta 再写 scrollTop"更稳：
       * CM6 的 `coordsAtPos` 对视口外的偏移只能给**估算**（虚拟化渲染），
       * 而 `scrollToOffset` 走 `EditorView.scrollIntoView`，由 CM6 自己完成
       * 测量→滚动→必要时二次校正，是它内部一致的口径。
       */
      if (!isRealTextarea) {
        if (scrollPlan.kind === "anchor") {
          /**
           * 恢复：把锚点偏移送回**原来的内容坐标 Y**。
           *
           * ⚠️ 这里**不能**只靠 `measureRangeContentY` 算 delta（第一版就是这样，失败）：
           * 撤销落地瞬间 CM6 已把视口拽到别处，锚点偏移落到**视口外** →
           * `coordsAtPos` 对视口外偏移返回 `null`（虚拟化渲染）→ `r === null`
           * → 放弃恢复 → 视口留在被拽走的位置（实测 `scrollTop` 3150 → 0）。
           *
           * 正确做法：**先 `scrollToOffset(offset, { center: true })` 把该行送进视口**，
           * 它走 `EditorView.scrollIntoView` effect，由 CM6 自己完成
           * 「测量 → 滚动 → 必要时二次校正」，对视口外位置天然有效。
           *
           * 为什么用 `center: true` 而不是贴顶：锚点本身就是按
           * 「`scrollTop + clientHeight/2` 处那一行」采的（见 `captureSurfaceCenterAnchor`），
           * 所以"把这一行放回视口中央"正是该锚点的逆操作。
           */
          sourceSurface.scrollToOffset(scrollPlan.anchor.offset, { center: true });
          traceScroll("undo-source-cm6", {
            off: scrollPlan.anchor.offset,
            anchorY: Math.round(scrollPlan.anchor.viewportY),
          });
          /**
           * 二次校正：布局稳定后按**屏幕 Y 差**补一次。
           *
           * 公式与 textarea 的 `restoreTextAnchor` 完全一致：
           * `delta = 屏幕Y新 − 屏幕Y旧`，再 `scrollTop += delta`。
           * 此刻该行已进视口，`measureRangeContentY` 才给得出真值；拿不到就跳过
           *（**绝不写 0**）。
           */
          const refine = () => {
            const len = sourceSurface.getText().length;
            const r = sourceSurface.measureRangeContentY(
              Math.max(0, Math.min(scrollPlan.anchor.offset, Math.max(0, len - 1))),
              Math.min(len, scrollPlan.anchor.offset + 1),
            );
            if (!r) return;
            const screenY = r.startY - sourceSurface.getScrollTop();
            const delta = screenY - scrollPlan.anchor.viewportY;
            if (Math.abs(delta) < 0.5) return;
            const m2 = sourceSurface.getMetrics();
            const max2 = Math.max(0, m2.scrollHeight - m2.clientHeight);
            sourceSurface.setScrollTop(Math.max(0, Math.min(max2, sourceSurface.getScrollTop() + delta)));
            traceScroll("undo-source-cm6-refine", { delta: Math.round(delta), st: Math.round(sourceSurface.getScrollTop()) });
          };
          requestAnimationFrame(refine);
          window.setTimeout(refine, 60);
        } else if (scrollPlan.kind === "pixel") {
          const metrics = sourceSurface.getMetrics();
          const max = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
          const want = Math.min(Math.max(0, scrollPlan.scrollTop), max);
          if (Math.abs(sourceSurface.getScrollTop() - want) > 0.5) sourceSurface.setScrollTop(want);
        }
        // kind === "none"：**什么都不做**（绝不写 0，见决策函数注释）
        return;
      }
      const realTa = ta as unknown as HTMLTextAreaElement;
      if (realTa.clientHeight <= 0) return;
      if (scrollPlan.kind === "anchor") {
        restoreTextAnchor(realTa, scrollPlan.anchor);
      } else if (scrollPlan.kind === "pixel") {
        const max = Math.max(0, realTa.scrollHeight - realTa.clientHeight);
        const want = Math.min(Math.max(0, scrollPlan.scrollTop), max);
        if (Math.abs(realTa.scrollTop - want) > 0.5) realTa.scrollTop = want;
      }
      // kind === "none"：**什么都不做**（绝不写 0，见决策函数注释）
    };
    /**
     * ## v0.17.0 第二轮：撤销落地时**先同步恢复一次**，再 rAF/60/160 修正
     *
     * 缺陷（用户第 3 项「撤销时页面跳一下再回来」）：撤销落地是**整篇替换事务**，
     * CM6 提交后会在下一次 measure 里把视口拉到它认为该在的位置
     * （实测 `scrollTop 4019 → 63`，逐帧采样 1 帧就跳 3956px），
     * 而我们的内容锚恢复原本排在 `requestAnimationFrame` 里 ——
     * **中间那一帧已经被画出来了**，用户看到的就是「先跳后回」。
     *
     * 修法：`setSourceContent` 之后**立刻**（同一个任务内）先按内容锚恢复一次。
     * 此时 CM6 的 DOM 已换新、`coordsAtPos` 已可用，滚动写下去后
     * 浏览器只在最后绘制一次，中间"跳到顶部"的帧不会被呈现。
     * 随后的 rAF / 60ms / 160ms 仍然保留：它们负责修正
     * 「布局异步稳定后（图片/字体/heightMap 重估）位置又偏了一点」。
     * 全部幂等（同一锚点），用户一旦自己滚了也不会被拽回（锚点只在落地窗口内写）。
     */
    if (scrollPlan.kind !== "none") {
      /**
       * ① 同步"防跳顶"（**只用实时像素，绝不用历史条目里的像素**）
       *
       * 此刻 `setSourceContent` 是 React 受控更新，CM6 的 doc **可能还没换**
       *（同一任务内尚未 flush）。所以这一步**不能**用内容锚
       *（会在旧文档上定位，与随后 rAF 互相拉扯 —— 实测 `scrollTop` 在
       * 0 / 3681 / 3576 之间反复）。
       *
       * ## ⚠️ 也不能用 `sel.scrollTop`（历史条目里的旧像素）—— 这是 A4 的元凶
       *
       * `sel.scrollTop` 来自**时间线条目**记录的 `beforeSelection`。跨模式撤销时
       * 那条记录可能是 PM 侧写的（`beforeSelection` 缺失或为 0）→ `sel.scrollTop = 0`
       * → 我们主动把视口写到 **0（顶部）**，然后 rAF 再拉回 30 段。
       * 逐帧看就是「4019 → 0 → 3633」的整屏往返（实测 A7 写入序列第一条
       * `4019→0 by rSetScrollTop`，正是这里）。
       *
       * 正确做法：同步阶段只**保住当前实时位置**（不让 CM6 measure 把它留在
       * 它算出的地方）。文本变短时浏览器会自己钳位，那是必然、不是缺陷。
       */
      try {
        const metricsNow = sourceSurface.getMetrics();
        const maxNow = Math.max(0, metricsNow.scrollHeight - metricsNow.clientHeight);
        const liveNow = sourceSurface.getScrollTop();
        sourceSurface.setScrollTop(Math.min(Math.max(0, liveNow), maxNow));
      } catch {
        /* 实现已卸载：忽略 */
      }
      // ② 内容锚恢复：等 DOM/doc 真正换到新文本后（rAF 起）再执行，三段幂等
      requestAnimationFrame(() => {
        applyScrollRestore();
        window.setTimeout(applyScrollRestore, 60);
        window.setTimeout(applyScrollRestore, 160);
      });
    }
    if (sel) {
      const pos = Math.max(0, Math.min(masked.length, sel.start));
      const end = Math.min(masked.length, sel.end);
      /**
       * v0.15.3 返修（缺陷 A 配套）：这里**不再**无条件写历史像素。
       *
       * 旧实现把 `sel.scrollTop`（历史记录里的**旧像素**）交给 `pendingSourceSelectionRef`，
       * 由 `useLayoutEffect` 与 rAF/60ms 兜底各写一次 —— 而它和上面新加的
       * `applyScrollRestore`（内容锚）会互相踩：像素先写一次（文本变短时被浏览器钳到
       * 新 max = 贴底）、锚点再拉回一次 → 61 帧采样里出现「贴底 → 拉回」的往返，
       * 正是用户说的"撤销时文档抖一下"。
       * 现在：滚动统一由 `scrollPlan` 负责，选区通道**只恢复光标**。
       * 唯一例外是 `scrollPlan.kind === "pixel"`（文本长度未变、锚点采不到）——
       * 那种情况下像素就是权威值，由 `applyScrollRestore` 统一写，这里仍不重复写。
       */
      const scrollTopForSelection: number | null = null;
      pendingSourceSelectionRef.current = {
        start: pos,
        end,
        scrollTop: scrollTopForSelection,
        // 选区保护窗：覆盖「撤销 → onContentChange → App.setContent → content prop
        // 变化 → 再 setSourceContent」这条二次受控提交链（实测需要 ~100ms）。
        until: Date.now() + 250,
      };
      /**
       * v0.15.1 需求6（再审计缺陷 1）：这两个定时器必须能被**用户输入作废**。
       *
       * 实测：撤销后 60ms 内打字 → 字符插对了，但 250ms 后光标被这里抢回撤销时的
       * 位置（`selectionStart` 8 → 9 → 又回到 8）→ 下一个字符插到错误位置。
       * `handleSourceChange` 会 `++sourceSelectionRestoreTokenRef`，这里比对代际号即可。
       */
      const restoreToken = ++sourceSelectionRestoreTokenRef.current;
      const applySelection = () => {
        if (sourceSelectionRestoreTokenRef.current !== restoreToken) return;
        // TODO(v0.18): CM6 能力缺口 — `buildSourcePairInput(ta, …)` 签名收 textarea（内部只用 `ta.value`，改签名需动 `utils/sourceAutoPair.ts` + 其单测）。当前 CM6 表现：**Tab 跳出配对 / Backspace 成对删除不生效；缩进本身正常**（CM6 的 `handleTab` 直接调 `planSourceIndent/planSourceOutdent`，不经此函数） | 用户可感知度：中 | 建议优先级：P1
        /**
         * v0.17.0 A3 收尾（**B 类·静默失效 → 已修**）：撤销后光标恢复。
         *
         * 原 `if (!ta) return;` 在 CM6 下让**撤销/恢复后的光标恢复整段不执行** ——
         * 无 fallback，用户看到的是"撤销后光标乱跑"。全部是纯值语义（长度+选区），
         * 改经 surface 后两种实现都成立。
         */
        const len = sourceSurface.getText().length;
        sourceSurface.focus();
        sourceSurface.setSelection(Math.min(pos, len), Math.min(end, len));
        lastTextareaCursorRef.current = Math.min(pos, len);
      };
      applySelection();
      requestAnimationFrame(applySelection);
      window.setTimeout(applySelection, 60);
    }
  };


  /**
   * ## 离散编辑落地：**先算最小 diff，经 `applyEdit` 单事务落地**（v0.17.0 R3 · 用户第 4 项）
   *
   * ### 缺陷（实测，`scripts/v0170-r3-format-backspace.mjs`）
   * 用户：「格式栏或语法栏插入某格式后按退格键删除实现了，但删除动作会导致页面抖动或重置。」
   *
   * 所有格式/语法按钮的落地链都是 `setSourceContent(newText)`（整篇）：
   * ```
   * 点按钮 → setSourceContent(全文) → EditorContainer 受控写入 effect
   *        → CM6 setText(整篇替换事务) → heightMap **整体重估**
   * ```
   * 实测（60 段文档滚到 45%，点「粗体」）：
   * ```
   * scrollHeight  8785 → 7114   (Δ-1671px ★ 整篇替换的指纹)
   * 退格时 scrollTop 单帧最大跳变  192px
   * 点「标题一」时             557px
   * 负对照（点按钮后先输入再退格，ghost 已失效）  0px  ← 只在"ghost 活跃 + 整段删"路径上
   * ```
   * 内容锚（PI 段号）全程不变 ⇒ 用户感知的"重置"不是跑到别段，
   * 而是**那一帧 192~557px 的硬跳**（视线被打断）。
   *
   * ### 为什么"事后拉回滚动位置"不是答案
   * 退格阶段 `scrollTop` 写入 **0 次**（打桩为空）—— 那一跳是 CM6 因内容变短钳位，
   * 不是我们的代码写的。再补一次"拉回来"就变成 R2 的**多写者互斗**
   *（会像 #12 那样产生往复反转）。正解是**不让它整篇重排**。
   *
   * ### 修法（与 R2 #3「撤销抖动」**完全同源**，那里实测 Δ0px）
   * `computeMinimalEdit(before, after)` 算公共前后缀夹逼的最小连续替换，
   * 经 `applyEdit` 走**单事务最小 changes** → heightMap 只增量更新受影响区块，
   * CM6 **根本不改写 `scrollTop`**（对照实验：整篇替换 Δ-2695px / 最小变更 Δ0px）。
   *
   * ⚠️ **必须在 `setSourceContent` 之后调用**（与撤销路径同款）：
   * 先让 React state / `sourceContentRef` 指向新文本，受控写入 effect 才会认为
   * "已经是目标值"而跳过整篇 `setText`；若顺序反了，effect 会再写一次整篇，前功尽弃。
   *
   * @returns 是否走了最小变更（false = 调用方不必额外处理，整篇路径仍会兜底）
   */
  const applyMinimalDiscreteEdit = (
    beforeText: string,
    afterText: string,
    caret: number,
  ): boolean => {
    // 只对 CM6 有意义：textarea 的受控 value 赋值本身就是单次原生写入，不存在 heightMap
    if (sourceSurface.impl !== "cm6") return false;
    const minimal = computeMinimalEdit(beforeText, afterText);
    // diff 过大（跨文件/整篇换掉）→ computeMinimalEdit 返回 null，退回整篇路径
    if (!minimal) return false;
    try {
      sourceSurface.applyEdit({
        kind: "edit",
        edit: {
          from: minimal.from,
          to: minimal.to,
          text: minimal.text,
          // 光标夹到新文本长度内（格式操作会插/删字符，旧 caret 可能越界）
          caret: Math.max(0, Math.min(afterText.length, caret)),
        },
      });
      return true;
    } catch {
      /* 最小化落地失败：调用方的内容锚恢复仍然兜底 */
      return false;
    }
  };

  // ─── 在光标处插入文本（统一入口，供对话框 onInsert 复用）────────────
  // 复用 sourceInsertHandler 的差异记录与光标恢复逻辑
  const insertTextAtCursor = useCallback((text: string, cursorOffset?: number) => {
    // v0.17.0 A2 收敛：只需选区三个纯值 → 经 surface（CM6 下同样成立）
    if (!sourceSurface.getText()) return;
    const sel = sourceSurface.getSelection();
    const start = sel.start;
    const end = sel.end;
    const currentContent = sourceContentRef.current;
    const selected = currentContent.substring(start, end);
    const newContent = currentContent.substring(0, start) + text + currentContent.substring(end);
    const scrollTop = sourceSurface.getScrollTop();
    const centerAnchor = captureCenterAnchorForDiscreteEdit();
    const beforeLenForRestore = currentContent.length;
    // v0.6.6 问题4：插入内容含 base64 图片（如 ImageInsertDialog）→ mask 为短标记
    let finalContent = newContent;
    let newCursorPos = selected ? start + text.length : (cursorOffset !== undefined ? start + cursorOffset : start + text.length);
    if (hasRawBase64Image(newContent)) {
      const { text: masked, replacements } = maskBase64Images(newContent, base64TokensRef.current);
      if (replacements.length > 0) {
        finalContent = masked;
        newCursorPos = adjustCursorForMask(newCursorPos, replacements);
      }
    }
    // 直接推入差异（对话框插入是离散操作，无需防抖）
    // v0.15.1 需求1：改写**统一时间线**（旧 `pushUndoEntry` 已退休，写进去没人消费）
    recordDiscreteSourceEdit(currentContent, finalContent, start, scrollTop);
    setSourceContent(finalContent);
    sourceContentRef.current = finalContent;
    onContentChangeRef.current?.(finalContent);
    setDirtyRef.current(true);
    lastContentRef.current = unmaskBase64Images(finalContent, base64TokensRef.current);
    // v0.17.0 R3 · 第 4 项：最小 diff 落地（避免整篇替换 → heightMap 重估 → 滚动硬跳）
    const minimalOk = applyMinimalDiscreteEdit(currentContent, finalContent, newCursorPos);
    restoreAfterDiscreteEdit(centerAnchor, newCursorPos, scrollTop, currentContent, finalContent, minimalOk);
  }, [pushUndoEntry]);


  // ─── E1(v0.9.2):阅读模式下对话框插入直接写入 ProseMirror ────
  // 此前 LinkDialog/ImageInsertDialog 确认后走 insertTextAtCursor(textarea 通道),
  // 阅读模式无 textarea → 静默失败。preview 模式下改走 markdownToDoc → replaceSelection。
  const insertMarkdownIntoPM = useCallback((md: string) => {
    const view = viewRef.current;
    if (!view) return;
    try {
      // 开放度 0/0:作为整体块插入,不与两侧内容粘连
      const slice = new Slice(markdownToDoc(md).content, 0, 0);
      const tr = view.state.tr.replaceSelection(slice);
      view.dispatch(tr.scrollIntoView());
      view.focus();
    } catch (e) {
      console.warn("[EditorContainer] PM 插入失败,回退文本通道:", e);
      insertTextAtCursor(md);
    }
  }, [insertTextAtCursor]);


  // ─── SlashCommand 插入回调 ────────────────────────
  // mode="block"：删除当前行从行首（含 / 和过滤文字）到光标的内容，在行首插入 markdown
  // mode="inline"：用 markdown 替换当前选中文本（markdown 已是完整包裹字符串）
  // 菜单关闭由 SlashCommand 组件内部调用 onClose 处理，此处不主动关闭
  // 核心字符串变换逻辑提取为纯函数 computeSlashInsert（文件底部导出），便于单元测试
  const handleSlashInsert = useCallback((markdown: string, mode: InsertMode) => {
    // v0.17.0 A2 收敛：纯值语义（选区 + 滚动像素）→ 经 surface
    const sel0 = sourceSurface.getSelection();
    const cursorPos = sel0.start;
    const selectionEnd = sel0.end;
    const currentContent = sourceContentRef.current;
    const scrollTop = sourceSurface.getScrollTop();
    const centerAnchor = captureCenterAnchorForDiscreteEdit();
    const beforeLenForRestore = currentContent.length;

    // 调用纯函数计算新内容与光标位置
    const { newContent, newCursorPos } = computeSlashInsert(
      currentContent,
      cursorPos,
      selectionEnd,
      markdown,
      mode
    );

    // 推入 undo 栈（离散操作，无需防抖）
    // v0.15.1 需求1：改写**统一时间线**（旧 `pushUndoEntry` 已退休）
    recordDiscreteSourceEdit(currentContent, newContent, cursorPos, scrollTop);

    setSourceContent(newContent);
    sourceContentRef.current = newContent;
    onContentChangeRef.current?.(newContent);
    setDirtyRef.current(true);
    // v0.6.6 问题4：lastContentRef 与 content prop 同为真实坐标（unmask 后）
    lastContentRef.current = unmaskBase64Images(newContent, base64TokensRef.current);

    // v0.17.0 R3 · 第 4 项：最小 diff 落地
    const minimalOk = applyMinimalDiscreteEdit(currentContent, newContent, newCursorPos);
    // 恢复光标位置（rAF + setTimeout 双保险，与 insertTextAtCursor 一致）
    restoreAfterDiscreteEdit(centerAnchor, newCursorPos, scrollTop, currentContent, newContent, minimalOk);
  }, [pushUndoEntry]);


  // ─── 对话框 open 状态 ────────────────────────────
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);

  const [linkInitialText, setLinkInitialText] = useState("");

  const [tableDialogOpen, setTableDialogOpen] = useState(false);

  const [imageDialogOpen, setImageDialogOpen] = useState(false);

  // ─── G3：图片编辑对话框状态 ────────────────────
  // imageEditSrc 为 resolve 后的可显示 URL（asset:// 或 data:）
  // imageEditPos 为 ProseMirror 文档中图片节点的位置，确认后通过 setNodeMarkup 修改 attrs.src
  // E11b(v0.9.3)：同时携带节点 alt/width，对话框内可编辑并写回
  const [imageEditDialogOpen, setImageEditDialogOpen] = useState(false);

  const [imageEditSrc, setImageEditSrc] = useState("");

  const [imageEditAlt, setImageEditAlt] = useState("");

  const [imageEditWidth, setImageEditWidth] = useState<number | null>(null);

  /** v0.13.0 需求4：图片水平对齐（打开图片编辑对话框时从节点 attrs 带入） */
  const [imageEditAlign, setImageEditAlign] = useState<"left" | "center" | "right">("left");

  const [imageEditPos, setImageEditPos] = useState<number | null>(null);

  // ─── 右键菜单状态 ────────────────────────────────
  const [contextMenu, setContextMenu] = useState<{ open: boolean; x: number; y: number; hasSelection: boolean }>({
    open: false, x: 0, y: 0, hasSelection: false,
  });

  // v0.12.0 需求2：PM 模式右键菜单状态（选区信息在 rAF 内主动读取后填入）
  const [pmContextMenu, setPmContextMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    hasSelection: boolean;
    nodeKind: string | null;
    /** v0.13.0 需求1：剪贴板是否有块数据（控制「粘贴」禁用态） */
    hasBlockClipboard: boolean;
    /**
     * v0.13.1 需求16：选区是否可剪切/复制（控制「剪切」「复制」禁用态）。
     *
     * 只读编辑器自身选区，**不读系统剪贴板**——v0.13.0 第三轮的教训是
     * `navigator.clipboard.read()` 会让 WebView2 弹出系统授权气泡，
     * 用户只是右键一下就被打断。
     */
    hasTextClipboard: boolean;
  }>({
    open: false,
    x: 0,
    y: 0,
    hasSelection: false,
    nodeKind: null,
    hasBlockClipboard: false,
    hasTextClipboard: false,
  });

  // ─── v0.13.0 需求1：块右上角三点菜单（blockKebab 派发 lightmd:blockAction） ───
  const [blockKebabMenu, setBlockKebabMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    /** 被点块的文档位置 */
    pos: number;
    /** 剪贴板是否有块数据（控制「粘贴」禁用态） */
    hasClipboard: boolean;
  }>({ open: false, x: 0, y: 0, pos: 0, hasClipboard: false });

  // v0.12.0 需求2：格式刷状态（订阅以驱动光标样式 / Esc 监听 / 状态栏提示）
  const formatPainterMode = useFormatPainterStore((s) => s.mode);

  // ─── Mermaid 模板下拉状态 ────────────────────────
  const [mermaidMenuOpen, setMermaidMenuOpen] = useState(false);

  // ─── v0.12.1 需求5：任务列表图标样式下拉（方形 / 圆形）───
  const [taskStyleMenuOpen, setTaskStyleMenuOpen] = useState(false);

  // ─── SlashCommand 菜单 open 状态 ───────────────────
  // 仅在源码模式 + Markdown 文件 + 行首输入 / 时打开
  const [slashCommandOpen, setSlashCommandOpen] = useState(false);


  // ─── 打开链接对话框（携带选中文本作为 initialText）────
  const openLinkDialog = useCallback(() => {
    // v0.17.0 A2 收敛：仅取选区子串 → 经 surface
    {
      const sel = sourceSurface.getSelection();
      const selected = sourceContentRef.current.substring(sel.start, sel.end);
      setLinkInitialText(selected);
    }
    setLinkDialogOpen(true);
  }, []);


  // ─── E1(v0.9.2):命令面板/工具栏在阅读模式下发的链接/图片对话框打开事件 ────
  useEffect(() => {
    const handler = (e: Event) => {
      const kind = (e as CustomEvent).detail?.kind;
      if (kind === "link") {
        openLinkDialog();
      } else if (kind === "image") {
        setImageDialogOpen(true);
      }
    };
    window.addEventListener("lightmd:pm-dialog", handler);
    return () => window.removeEventListener("lightmd:pm-dialog", handler);
  }, [openLinkDialog]);


  // ─── v0.13.2 需求10：图片编辑入口改为「右上角手柄」 ────────────────
  //
  // 用户要求：「原来点击文档中图片会弹窗进入编辑，现在需要在图片右上角加上小手柄按钮，
  // 鼠标移动到图片上就会显现，将弹窗进入编辑的功能放在这个按钮里点击即可进入；
  // 而原来点击图片改为激活该图片，通过鼠标拖拽图片边缘可以进行图片大小调整。」
  //
  // 因此旧的「捕获阶段点击 img → 打开编辑弹窗」整段移除：
  // - 点击/拖拽由 `core/plugins/image-node.ts` 的 ImageView 接管（激活 / 缩放）；
  // - 手柄点击时派发 `lightmd:image-edit`，由本 effect 打开编辑弹窗。
  useEffect(() => {
    const handler = (e: Event) => {
      const pos = (e as CustomEvent).detail?.pos as number | undefined;
      if (typeof pos !== "number") return;
      const view = viewRef.current;
      if (!view) return;
      const node = view.state.doc.nodeAt(pos);
      if (!node || node.type.name !== "image") return;
      // src 用解析后的可显示 URL（asset:// / data: / http(s)），与旧实现同源
      setImageEditSrc(resolveImageSrc(String(node.attrs.src ?? "")));
      setImageEditAlt(String(node.attrs.alt ?? ""));
      setImageEditWidth(typeof node.attrs.width === "number" ? node.attrs.width : null);
      setImageEditAlign(
        node.attrs.align === "center" || node.attrs.align === "right" ? node.attrs.align : "left",
      );
      setImageEditPos(pos);
      setImageEditDialogOpen(true);
    };
    window.addEventListener("lightmd:image-edit", handler);
    return () => window.removeEventListener("lightmd:image-edit", handler);
  }, []);


  // ─── v0.9.5 问题3：文档内链接点击导航 ────────────────
  // 此前全项目无链接点击处理——阅读模式 <a href> 点击被 WebView2 当作页面内导航,
  // 相对路径链接点击无任何反应。统一分发:内部文件 → lightmd:open-path 事件
  // (App 层 openFileByPath 复用打开链路);http(s)/mailto → 外部打开;
  // 锚点 → 编辑器内滚动到标题
  // v0.12.0 需求8：外部打开逻辑抽出为 utils/openExternal（设置弹窗「关于」复用），
  // openExternalHref 现为模块级静态函数，无需 useCallback 包装

  const scrollEditorToAnchor = useCallback((anchor: string) => {
    const container = editorRef.current;
    if (!container) return;
    const headings = container.querySelectorAll("h1, h2, h3, h4, h5, h6");
    for (const h of headings) {
      const el = h as HTMLElement;
      if (el.id === anchor || anchorMatchesHeading(anchor, el.textContent || "")) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
    }
  }, []);


  const handleLinkNav = useCallback(
    (href: string) => {
      const action = resolveLinkAction(href, filePath || "");
      if (action.kind === "open-internal") {
        window.dispatchEvent(new CustomEvent("lightmd:open-path", { detail: { path: action.path } }));
      } else if (action.kind === "open-external") {
        void openExternalHref(action.href);
      } else if (action.kind === "scroll-anchor") {
        scrollEditorToAnchor(action.anchor);
      }
    },
    [filePath, scrollEditorToAnchor]
  );


  // 阅读模式：ProseMirror 容器内链接点击(捕获阶段,先于 PM 的选区处理)
  useEffect(() => {
    if (viewMode !== "preview") return;
    const container = editorRef.current;
    if (!container) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const a = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a) return;
      const href = a.getAttribute("href") || "";
      if (!href) return;
      e.preventDefault();
      e.stopPropagation();
      handleLinkNav(href);
    };
    container.addEventListener("click", handler, true);
    return () => container.removeEventListener("click", handler, true);
  }, [viewMode, handleLinkNav]);


  // 分屏：iframe 内链接点击经 postMessage 桥接回主文档(桥接脚本在完整重写时注入 head)
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type !== "lightmd-preview-link") return;
      const href = e.data.href;
      if (typeof href === "string" && href) handleLinkNav(href);
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [handleLinkNav]);


  /**
   * G3：图片编辑确认回调 —— 通过 setNodeMarkup 修改 image 节点 attrs
   * E11b(v0.9.3)：除 src 外同时写回对话框编辑的 alt 与 width
   * v0.13.0 需求4：同时写回水平对齐（非 left 时序列化为 `<img style>`）
   */
  const handleImageEditConfirm = useCallback((newSrc: string, meta: { alt: string; width: number | null; align: "left" | "center" | "right" }) => {
    const view = viewRef.current;
    if (!view || imageEditPos === null) {
      setImageEditDialogOpen(false);
      return;
    }
    try {
      const node = view.state.doc.nodeAt(imageEditPos);
      if (node && node.type.name === "image") {
        const tr = view.state.tr.setNodeMarkup(imageEditPos, undefined, {
          ...node.attrs,
          src: newSrc,
          alt: meta.alt,
          width: meta.width,
          align: meta.align,
        });
        view.dispatch(tr);
      }
    } catch {
      // 节点位置无效时静默失败（避免编辑过程中文档已变更导致崩溃）
    }
    setImageEditDialogOpen(false);
    setImageEditPos(null);
    setImageEditSrc("");
    setImageEditAlt("");
    setImageEditWidth(null);
    setImageEditAlign("left");
  }, [imageEditPos]);


  // ─── 格式工具栏操作 ────────────────────────────
  // 通过 buildFormatReplacement 纯函数生成 replacement + cursorOffset，
  // 减少 switch 重复代码；mermaid 按钮点击改为打开下拉，不走此路径
  /**
   * ## v0.17.0 第二轮：格式栏/语法栏"抖动偏离输入区域"的修法（用户第 6 项）
   *
   * ### 缺陷链（实测，`scripts/v0170-r2-toolbar-jump.mjs` + `v0170-r2-toolbar-diag.mjs`）
   *
   * 所有格式/语法按钮的落地链都是「整篇 `setSourceContent(newText)`」：
   * ```
   * 点按钮 → 捕获 scrollTop → setSourceContent(全文) → CM6 受控写入 effect
   *   → sourceSurface.setText(整篇替换事务，不带 selection)
   *   → CM6 把旧选区映射过全文替换 → 选区落到文档后部 + 滚进视口（xn.measure 写 scrollTop）
   *   → 我们的 rAF restore() 才用**旧像素**把 scrollTop 拉回
   * ```
   * 实测（60 段文档，滚到 50%，点「粗体」）：
   * ```
   * scrollHeight 8785 → 7316（CM6 heightMap 因全文替换整体失效重估）
   * scrollTop    4019 → 4220 → 4019（先被 CM6 拽走 201px，再被旧像素拉回 = 用户"抖一下"）
   * 视口中心      PI30@258 → PI37@258（**内容偏了 7 段**——像素被拉回但内容没回来）
   * 光标 caretY  319 → -660（**位移 979px，跑出视口** = 用户"偏离输入区域"）
   * ```
   * 根因有二：① 恢复用**像素**（heightMap 重估后同一像素指向不同内容）；
   * ② 光标/选区恢复与滚动恢复是两条独立通道，选区先被 CM6 拽走。
   *
   * ### 修法（遵循语义地图 §4-33「锚内容不锚像素」）
   * 写入**之前**采「视口中央那一行 + 光标偏移」，写入后：
   * 1. 先恢复光标（`setSelection`，CM6 带 `scrollIntoView:false`）；
   * 2. 再把内容锚送回视口中央（`scrollToOffset(offset, {center:true})`），
   *    它走 CM6 自己的 scrollIntoView effect，能处理 heightMap 重估后的布局；
   * 3. 三段幂等重试（rAF / 60ms / 160ms）——与阅读面 `restorePreviewScrollFromAnchor` 同款。
   *
   * 像素只在**文本长度未变**时作为末位兜底；否则**绝不**用像素（更不写 0）。
   */
  const captureCenterAnchorForDiscreteEdit = () => {
    try {
      return captureSurfaceCenterAnchor(sourceSurface);
    } catch {
      return null;
    }
  };

  /**
   * 离散编辑后：恢复光标 + 按内容锚还原视口（幂等，可重复调用）
   *
   * @param minimalApplied 是否已经用**最小 diff 事务**落过地（本轮新增）。
   *
   * ## ⚠️ `minimalApplied` 为什么必须改变滚动恢复策略（v0.17.0 R4 实测）
   *
   * 上一轮把落地换成最小 diff 之后，**滚动恢复这里没跟着改** —— 于是变成
   * "CM6 已经把视口放对了，我们还要再抢一次"：
   *
   * ```
   * +948ms  scrollTop 3617 → 3738   ← CM6 的 scrollIntoView（把光标滚进视口，正确）
   * +949ms  scrollTop 3738 → 3703   ← 我们的 ① 二次精修（setScrollTop 拉回）
   * +1000ms scrollTop 3703 → 3738   ← 60ms 后 CM6 又来一次
   * +1000ms scrollTop 3738 → 3703   ← 我们的 60ms 那轮再拉回
   * +1104ms scrollTop 3703 → 3738   ← 160ms 后第三轮 …
   * +1104ms scrollTop 3738 → 3703
   * ```
   * 实测（`scripts/v0170-r4-writer-attrib.mjs`，右键插入代码块）：
   * **3 个写入者 × 3 轮 = 6 次写入，两个方向交替**，净位移 86px，
   * 且其中一帧 `Δst=86 / Δsh=0`（**高度没变却跳了 86px** = 用户可见的硬跳）。
   *
   * 根因是「**最小 diff 之后不该再抢帧**」——这正是 R3 报告 §4.2 写过的结论：
   * > 换成最小 diff 后：heightMap 只增量更新受影响区块，CM6 **根本不改写 scrollTop**。
   * > 这样连内容锚恢复都不必"抢帧"——中间态压根不存在。
   *
   * 上一轮只把这句用在**撤销路径**（`applyHistoryTextRef`），离散编辑路径漏了。
   *
   * ## 修法
   * - `minimalApplied === true`：**只做"幂等的显示位置校正"** —— 量一次锚点现在在
   *   屏幕上的实际 Y，与期望 Y 差超过 **`DISCRETE_EDIT_SCROLL_TOLERANCE_PX`(24px)**
   *   才写一次；否则**一个字节都不写**。理由：写一次就产生一次可见位移，
   *   哪怕随后拉回，用户也看到那一帧的抖（R3 #12 的结论）。
   * - `minimalApplied === false`（退回整篇路径）：保持原有三段恢复（那时确实需要抢帧）。
   */
  const restoreAfterDiscreteEdit = (
    anchor: { offset: number; viewportY: number } | null,
    caret: number,
    pixelScrollTop: number | null,
    beforeText: string,
    afterText: string,
    minimalApplied = false,
  ) => {
    /**
     * 像素只在**文本长度未变**时才是权威值（同长度时像素与内容一一对应）。
     * 长度变了就绝不用像素 —— 那是「锚内容不锚像素」铁律（语义地图 §4-33）。
     */
    const textLenUnchanged = beforeText.length === afterText.length;
    /**
     * 锚点 offset 是**旧文本**坐标，必须映射到新文本（格式操作会插/删字符，
     * 直接拿旧 offset 去新文档定位会偏几个字符 → 恢复后仍差几行）。
     * `remapOffsetAcrossTextChange` 是既有纯函数（前缀/后缀夹逼 + 距离比较）。
     */
    const mapped = anchor
      ? {
          offset: remapOffsetAcrossTextChange(anchor.offset, beforeText, afterText),
          viewportY: anchor.viewportY,
        }
      : null;

    /**
     * ## 兜底阈值：**半个视口**
     *
     * 第一版我用了 24px（"视野里还能看到同一行就忍"），实测**仍然写了一次 58px**：
     * ```
     * P3 右键插入代码块：scrollTop 2538 → 2596（我们的 setScrollTop）
     *                   scrollHeight 同帧 +57px
     *                   视口中心 PI28 → PI28（内容没跑）
     * ```
     * 那 58px 是**误判**：插入的三行在锚点**上方**，锚点自己必然下移约 3 行高；
     * 而 `mapped.viewportY` 是插入**前**的期望 Y —— 拿旧期望去比新现实，必然"偏"。
     * 于是这个"纠偏"实际上把本来已经正确的视口又动了一次。
     *
     * 结论：**最小 diff 落地后，位置是 CM6 自己算对的，我们不该纠**。
     * 只保留一条真正的兜底：视口跑到"内容锚几乎离开视野"时才救一次。
     * 阈值取**半个视口**（`clientHeight/2`，实测约 380px）——
     * 正常重排（插入 1~5 行）不可能造成这么大偏移，能到这个量级说明真的跑飞了。
     */
    const rescueThreshold = (() => {
      const m = sourceSurface.getMetrics();
      return Math.max(200, Math.round((m.clientHeight || 760) / 2));
    })();

    const apply = () => {
      /**
       * ① 焦点 + 光标优先。
       *
       * ⚠️ `focus()` **不能省**：格式栏/语法栏是真实 `<button>`/`<li>`，
       * mousedown 会把焦点从 `.cm-content` 移走。不夺回焦点的话：
       * - 用户点完按钮**无法继续打字**（按键落到 button/body 上）；
       * - `.cm-cursor` 因失焦不再跟随选区，实测 `caretY` 319 → **-115**（跑出视口）。
       * 实测证据：`ae: "format-btn"`、`focused: false`。
       *
       * `setSelection` 在 CM6 实现里带 `scrollIntoView: false`，所以"夺回焦点 +
       * 还原光标"这一步本身**不会**再改滚动位置（滚动统一由下面 ② 负责）。
       */
      try {
        sourceSurface.focus();
        const len = sourceSurface.getText().length;
        const c = Math.max(0, Math.min(len, caret));
        sourceSurface.setSelection(c, c);
        lastTextareaCursorRef.current = c;
      } catch {
        /* 实现已卸载：忽略 */
      }
      // ② 滚动：有内容锚永远优先；无锚且文本长度未变才用像素；否则不动
      if (mapped) {
        if (minimalApplied) {
          /**
           * 最小 diff 已落地：**只纠偏，不主动滚**（见上方长注释）。
           * 判据用"锚点当前的屏幕 Y vs 期望 Y"，而不是"我记忆中的像素"。
           */
          const len = sourceSurface.getText().length;
          const r = sourceSurface.measureRangeContentY(
            Math.max(0, Math.min(mapped.offset, Math.max(0, len - 1))),
            Math.min(len, mapped.offset + 1),
          );
          if (r) {
            const currentScreenY = r.startY - sourceSurface.getScrollTop();
            const delta = currentScreenY - mapped.viewportY;
            if (Math.abs(delta) > rescueThreshold) {
              const m = sourceSurface.getMetrics();
              const max = Math.max(0, m.scrollHeight - m.clientHeight);
              sourceSurface.setScrollTop(Math.max(0, Math.min(max, sourceSurface.getScrollTop() + delta)));
            }
            // 否则：**一次写入都不产生** —— 最小 diff 已经把视口放对了，我们再动就是抖
          }
          return;
        }
        sourceSurface.scrollToOffset(mapped.offset, { center: true });
        // 二次精修：此刻锚点已在视口内，可量真值 → 按屏幕 Y 差补到位
        const len = sourceSurface.getText().length;
        const r = sourceSurface.measureRangeContentY(
          Math.max(0, Math.min(mapped.offset, Math.max(0, len - 1))),
          Math.min(len, mapped.offset + 1),
        );
        if (r) {
          const delta = (r.startY - sourceSurface.getScrollTop()) - mapped.viewportY;
          if (Math.abs(delta) > 0.5) {
            const m = sourceSurface.getMetrics();
            const max = Math.max(0, m.scrollHeight - m.clientHeight);
            sourceSurface.setScrollTop(Math.max(0, Math.min(max, sourceSurface.getScrollTop() + delta)));
          }
        }
      } else if (pixelScrollTop !== null && textLenUnchanged) {
        const m = sourceSurface.getMetrics();
        const max = Math.max(0, m.scrollHeight - m.clientHeight);
        sourceSurface.setScrollTop(Math.min(Math.max(0, pixelScrollTop), max));
      }
    };
    requestAnimationFrame(apply);
    /**
     * ⚠️ 最小 diff 路径**不需要** 60/160ms 的两轮重试：
     * 中间态压根不存在（CM6 没重估 heightMap），重试只会额外产生写入。
     * 只在退回整篇路径时才保留三段幂等重试（那时图片/mermaid 异步撑高确实需要）。
     */
    if (!minimalApplied) {
      window.setTimeout(apply, 60);
      window.setTimeout(apply, 160);
    }
  };

  const handleFormatAction = useRef((action: string) => {
    // 归一化 H1-H6 按钮 action（"h1"~"h6"）到 heading 前缀路径（"heading1"~"heading6"），
    // 与快捷键 Ctrl+1~6 一致走行首替换逻辑，而非在光标位置插入文本
    if (/^h[1-6]$/.test(action)) {
      action = `heading${action[1]}`;
    }
    // v0.17.0 A2 收敛：纯值语义 → 经 surface
    const sel1 = sourceSurface.getSelection();
    const start = sel1.start;
    const end = sel1.end;
    const currentContent = sourceContentRef.current;
    const selected = currentContent.substring(start, end);
    const scrollTop = sourceSurface.getScrollTop();
    /**
     * 写入前采「视口中央那行」内容锚（第 6 项：点按钮后不偏离/不抖）。
     * 必须在 `setSourceContent` **之前**——之后文档已换、几何已变。
     */
    const centerAnchor = captureCenterAnchorForDiscreteEdit();
    const beforeLenForRestore = currentContent.length;

    // 行首类操作：Ctrl+1~6 在行首插入/替换标题，Ctrl+0 移除标题
    if (action === "paragraph") {
      const { replacement: newText, cursorOffset } = removeLinePrefixFn(currentContent, start);
      if (newText === currentContent) return; // 非标题行，无变化
      // v0.12.0 需求1：Ctrl+0 转段落 → 清除可能残留的标题格式 ghost
      formatGhostHandlersRef.current.clear("input");
      // v0.15.1 需求1：改写**统一时间线**（旧 `pushUndoEntry` 已退休）
      recordDiscreteSourceEdit(currentContent, newText, start, scrollTop);
      setSourceContent(newText);
      sourceContentRef.current = newText;
      onContentChangeRef.current?.(newText);
      setDirtyRef.current(true);
      // v0.6.6 问题4：lastContentRef 与 content prop 同为真实坐标（unmask 后）
      lastContentRef.current = unmaskBase64Images(newText, base64TokensRef.current);
      const newCursorPos = start + cursorOffset;
      // v0.17.0 R3 · 第 4 项：最小 diff 落地
      const minimalOk = applyMinimalDiscreteEdit(currentContent, newText, newCursorPos);
      restoreAfterDiscreteEdit(centerAnchor, newCursorPos, scrollTop, currentContent, newText, minimalOk);
      return;
    }
    // v0.13.2 需求2：源码模式 Ctrl+T —— 把当前行从列表里"提升"为任务项，
    // 任务列表插到原列表之前（与阅读模式 pmCommands 的口径一致）。
    // 不适用（当前行不是列表项）时返回 null → 继续走下面的通用路径
    // （在普通段落里 Ctrl+T 仍然是"新建任务项"，行为零回归）。
    if (action === "taskListLift") {
      const lifted = liftListLineToTaskFn(currentContent, start);
      if (!lifted) {
        // 非列表行：退回既有的语法插入（`\n- [ ] `），保持旧行为
        insertTextAtCursor("\n- [ ] ");
        return;
      }
      const { replacement: newText, cursorOffset } = lifted;
      // v0.15.1 需求1：改写**统一时间线**（旧 `pushUndoEntry` 已退休）
      recordDiscreteSourceEdit(currentContent, newText, start, scrollTop);
      setSourceContent(newText);
      sourceContentRef.current = newText;
      onContentChangeRef.current?.(newText);
      setDirtyRef.current(true);
      lastContentRef.current = unmaskBase64Images(newText, base64TokensRef.current);
      formatGhostHandlersRef.current.clear("input");
      const newCursorPos = Math.max(0, Math.min(newText.length, start + cursorOffset));
      // v0.17.0 R3 · 第 4 项：最小 diff 落地
      const minimalOk = applyMinimalDiscreteEdit(currentContent, newText, newCursorPos);
      restoreAfterDiscreteEdit(centerAnchor, newCursorPos, scrollTop, currentContent, newText, minimalOk);
      return;
    }

    if (action.startsWith("heading")) {
      // heading1 ~ heading6：在行首插入/替换标题前缀
      const level = parseInt(action.slice("heading".length), 10);
      const prefix = getHeadingPrefix(level);
      const { replacement: newText, cursorOffset } = setLinePrefixFn(currentContent, start, prefix);
      // v0.15.1 需求1：改写**统一时间线**（旧 `pushUndoEntry` 已退休）
      recordDiscreteSourceEdit(currentContent, newText, start, scrollTop);
      setSourceContent(newText);
      sourceContentRef.current = newText;
      onContentChangeRef.current?.(newText);
      setDirtyRef.current(true);
      // v0.6.6 问题4：lastContentRef 与 content prop 同为真实坐标（unmask 后）
      lastContentRef.current = unmaskBase64Images(newText, base64TokensRef.current);
      const newCursorPos = start + cursorOffset;
      // v0.17.0 R3 · 第 4 项：最小 diff 落地
      const minimalOk = applyMinimalDiscreteEdit(currentContent, newText, newCursorPos);
      restoreAfterDiscreteEdit(centerAnchor, newCursorPos, scrollTop, currentContent, newText, minimalOk);
      // v0.12.0 需求1：无选中文本且当前行除已有前缀外为空 → 显示标题占位 ghost
      // （已有内容的行不显示，避免"标题一"被误解为要追加的文字）
      // 返修：记录语法符号区间 [行首, 行首+新前缀) 与全文快照，供退格整段删除
      const { start: lineStart, end: lineEnd } = getLineRange(currentContent, start);
      const lineBody = currentContent.substring(lineStart, lineEnd).replace(/^#{1,6}\s*/, "");
      if (start === end && lineBody.trim() === "") {
        formatGhostRef.current = {
          text: HEADING_GHOST_TEXTS[level - 1],
          pos: newCursorPos,
          start: lineStart,
          end: lineStart + prefix.length,
          content: newText,
        };
        sourceGhostHandlersRef.current.invalidate();
        requestAnimationFrame(() => formatGhostHandlersRef.current.render());
      } else {
        formatGhostHandlersRef.current.clear("input");
      }
      return;
    }

    // 通用行内/块级格式：调用纯函数生成 replacement
    const result = buildFormatReplacement(action, selected);
    if (!result) return;
    const { replacement, cursorOffset } = result;

    // 直接推入差异（格式操作是离散的，不需要防抖）
    // v0.15.1 需求1：改写**统一时间线**（旧 `pushUndoEntry` 已退休）
    const newContent = currentContent.substring(0, start) + replacement + currentContent.substring(end);
    recordDiscreteSourceEdit(currentContent, newContent, start, scrollTop);
    setSourceContent(newContent);
    onContentChangeRef.current?.(newContent);
    setDirtyRef.current(true);
    // v0.6.6 问题4：lastContentRef 与 content prop 同为真实坐标（unmask 后）
    lastContentRef.current = unmaskBase64Images(newContent, base64TokensRef.current);

    const newCursorPos = start + cursorOffset;
    // v0.17.0 R3 · 第 4 项：最小 diff 落地（★ 用户报的「粗体」走这条）
    const minimalOk = applyMinimalDiscreteEdit(currentContent, newContent, newCursorPos);
    restoreAfterDiscreteEdit(centerAnchor, newCursorPos, scrollTop, currentContent, newContent, minimalOk);

    // v0.12.0 需求1：无选区行内格式 → 文档只插语法符号，占位提示走格式 ghost；
    // 预填类（代码块/表格/Mermaid 等模板）或其它情况 → 清除残留 ghost。
    // 返修：记录语法符号区间 [start, start+replacement.length) 与全文快照——
    // ghost 渲染基于快照（防时序漂移），退格可整段删除格式符。
    if (result.ghostText) {
      // v0.12.0 返修（问题1）：把光标之后的尾部语法符号交给 overlay 可见渲染，
      // 并用底色遮住 textarea 中被占位压住的符号 → 占位文字恰好落在左右格式符中间
      const gt = computeGhostTail(newContent, newCursorPos, replacement.slice(cursorOffset));
      formatGhostRef.current = {
        text: result.ghostText,
        pos: newCursorPos,
        start,
        end: start + replacement.length,
        content: newContent,
        tail: gt.maskTail ? gt.tail : "",
        maskTail: gt.maskTail,
      };
      // AI ghost 让位（格式操作是用户主动动作，异步任务不打断视觉）
      sourceGhostHandlersRef.current.invalidate();
      requestAnimationFrame(() => formatGhostHandlersRef.current.render());
    } else {
      formatGhostHandlersRef.current.clear("input");
    }
  });


  // ─── N2：智能粘贴 URL→链接（源码模式） ──────────
  // 粘贴单个 http(s) URL 时转为 Markdown 链接：无选区 → [url](url)；
  // 有选区 → [选中文字](url)。代码块内不处理。
  const handleSourcePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    // ⚠️ v0.17.0 A2（修复 C14 第三处）：**在事件源头**标记"这次变更来自粘贴"。
    // 旧实现三个一次性标记（sourceComposingRef/sourceJustPairedRef/sourceJustPastedRef）
    // 全文件**没有任何置 true 的路径**（实测确认），所以 IME/配对/粘贴三类"一步归并"
    // 从未生效，全部落回 inferSourceEditKind 的**文本形态猜测** —— 猜测必然误判。
    // 这里在粘贴真正发生前把标记置上，紧随其后的 onChange 消费后复位。
    sourceJustPastedRef.current = true;
    // TODO(v0.18): CM6 能力缺口 — `buildSourcePairInput(ta, …)` 签名收 textarea（内部只用 `ta.value`，改签名需动 `utils/sourceAutoPair.ts` + 其单测）。当前 CM6 表现：**Tab 跳出配对 / Backspace 成对删除不生效；缩进本身正常**（CM6 的 `handleTab` 直接调 `planSourceIndent/planSourceOutdent`，不经此函数） | 用户可感知度：中 | 建议优先级：P1
    const text = e.clipboardData.getData("text/plain").trim();
    if (!isHttpUrl(text)) return;
    const psel = sourceSurface.getSelection();
    const start = psel.start;
    const end = psel.end;
    const pasteText = sourceSurface.getText();
    if (isInCodeBlock(pasteText, start)) return;
    e.preventDefault();
    const selected = pasteText.slice(start, end);
    /**
     * v0.17.0 A2（G7）：改经 `SourceSurface.applyEdit` 落地 —— **单事务单步**。
     *
     * 旧实现用 `document.execCommand("insertText")` 只是为了"制造一次原生 input
     * 事件"从而让一次粘贴只占一步撤销；CM6 实现下 `applyEdit` 的单个 dispatch
     * 天然就是一步，不需要这个 workaround。统一走接口后这段代码对两种实现都成立。
     *
     * 同时保留"一次粘贴 = 一步"的语义：applyEdit 会带 `userEvent: "input.pair"` 标记，
     * 配合 sourceJustPastedRef（已在函数开头置位）让 adapter 归为 paste 组。
     */
    const inserted = `[${selected || text}](${text})`;
    sourceSurface.applyEdit({
      kind: "edit",
      edit: { from: start, to: end, text: inserted, caret: start + inserted.length },
    });
  }, []);


  // ─── 源码模式快捷键处理器 ────────────────────────
  // 在 textarea 的 keydown 中拦截 Ctrl/Cmd 组合键，分发到对应 action
  // 注意：Ctrl+Shift+S 已被 App.tsx 占用为「另存为」，删除线改用 Ctrl+Alt+S
  const handleSourceKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!isSourceMode || !isMdFile) return;

    // v0.7.3 改进10(U3)：source 续写 ghost 的 Tab 采纳 / Esc 放弃
    // （与 PM 模式 ghost 手势一致）；ghost 未活跃时不拦截，走原有自动配对/快捷键）
    if (sourceGhostActiveRef.current) {
      if (e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        sourceGhostHandlersRef.current.accept();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        sourceGhostHandlersRef.current.cancel();
        return;
      }
      // 其余按键：用户主动编辑 → ghost 位置语义可能失效，交给变更处理器统一判定
    }

    // v0.12.0 需求1：Esc 清除格式 ghost（不回滚已插入的语法符号，用户 Ctrl+Z 自行撤销；
    // AI ghost 活跃时已由上方分支消费本次 Esc）
    if (e.key === "Escape" && formatGhostRef.current) {
      e.preventDefault();
      e.stopPropagation();
      formatGhostHandlersRef.current.clear("escape");
      return;
    }

    // v0.12.0 需求1 返修④：点击格式符/语法辅助栏后未编辑时按退格 → 整段删除格式符
    // （如 `****`/`- [ ] ` 一次删净，而不是逐字符删除）；光标已移动或已编辑则走默认退格。
    // 格式刷/语法辅助栏等其它插入路径的 ghost 同样由此覆盖。
    if (
      e.key === "Backspace" &&
      !e.ctrlKey && !e.metaKey && !e.altKey &&
      formatGhostRef.current &&
      formatGhostHandlersRef.current.remove()
    ) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // v0.12.1 需求4：Tab 跳出配对（光标夹在 ()"" 之间 → 跳到闭符号右侧）。
    // 位置在 ghost 采纳之后：AI 续写 ghost 活跃时 Tab 的语义是「采纳」，优先级更高。
    if (
      autoPairEnabled &&
      e.key === "Tab" &&
      !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey
    ) {
      // TODO(v0.18): CM6 能力缺口 — `buildSourcePairInput(ta, …)` 签名收 textarea（内部只用 `ta.value`，改签名需动 `utils/sourceAutoPair.ts` + 其单测）。当前 CM6 表现：**Tab 跳出配对 / Backspace 成对删除不生效；缩进本身正常**（CM6 的 `handleTab` 直接调 `planSourceIndent/planSourceOutdent`，不经此函数） | 用户可感知度：中 | 建议优先级：P1
      const ta = sourceTextareaRef.current;
      /**
       * ⚠️ 必须判"是不是真 textarea"（不是判 null）。
       *
       * A3 之后该 ref 在 CM6 下是**中性 div**（非 null），`if (ta)` 守卫无效；
       * 而 `buildSourcePairInput` 内部读 `ta.value` → 传给 `isInCodeBlock`
       * → `undefined.substring` 抛异常 → 错误边界接管整个界面。
       * 实测：本分支目前在 CM6 下**不可达**（Tab 被 CmSourceSurface 的捕获监听先接走），
       * 但代码路径存在，将来接线变化即可触发 —— 故按缺陷类统一加守卫。
       */
      if (ta && typeof (ta as unknown as { value?: unknown }).value === "string") {
        const plan = planSourceTab(buildSourcePairInput(ta, ta.selectionStart ?? 0, ta.selectionEnd ?? 0));
        if (plan.kind === "edit") {
          e.preventDefault();
          e.stopPropagation();
          // ⚠️ v0.17.0 A2（修复 C14 第二处）：配对落地的**同一处**标记 justPaired，
          // 使"一次补全 = 一步撤销"成立（而不是事后靠文本形状推）。
          sourceJustPairedRef.current = true;
           sourceSurface.applyEdit(plan);
          return;
        }
      }
    }

    // v0.16.0 需求（Tab 与缩进体系）：源码模式缩进（Tab / Shift+Tab）。
    //
    // 修 D2：v0.15.6 及之前源码模式 Tab 完全不缩进（value 不变、prevented=false、
    // 焦点逃出 textarea）。这里补缩进落地，并**无论是否产出编辑都吞键**，
    // 否则反缩进在"无可删"场景仍会让焦点逃逸。
    if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey && !sourceGhostActiveRef.current) {
      // IME 组合态守卫（与同函数内 Backspace 分支同款）
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      /**
       * v0.17.0 実机探针修复（`scripts/v0170-probe-cm6.mjs` 判定项 3 实测 FAIL）：
       * **原先整段被 `if (ta)` 包住** —— CM6 路径下 `sourceTextareaRef.current` 为 null，
       * 于是 Tab 缩进永远不执行，事件也**不被 preventDefault**，最终 CM6 的默认 keymap
       * 也没接住（`setTabInterceptor` / `setIndentUnit` 都没人调用）→ **Tab 完全不缩进**。
       *
       * 而 A3 报告的结论"CM6 下缩进正常（走 handleTab）"是**错的**：
       * `handleTab` 确实实现了缩进，但它的 keymap 在 `domEventHandlers.keydown` **之后**才跑，
       * 而宿主这段代码先把 Tab 吞掉（`if (ta)` 不成立时又不吞），行为因此不一致。
       *
       * 现在改为**不依赖 textarea 句柄**：文本/选区一律走 `sourceSurface`，
       * 缩进单位走设置 store。textarea 与 CM6 两条路径共用这一份逻辑。
       */
      const input = {
        value: sourceSurface.getText(),
        start: sourceSurface.getSelection().start,
        end: sourceSurface.getSelection().end,
        unit: indentUnitString(useSettingsStore.getState().indentUnit),
      };
      const plan = e.shiftKey ? planSourceOutdent(input) : planSourceIndent(input);
      e.preventDefault();
      e.stopPropagation();
      if (plan.kind === "edit") {
        sourceJustPairedRef.current = true;
        sourceSurface.applyEdit(plan);
      }
      return; // 无论 edit 还是 none 都吞键（否则焦点逃逸依旧存在）
    }

    // ─── v0.12.1 需求4：删除/跳过类交互（输入补全由 beforeinput 监听统一处理）───
    // 为什么补全不在 keydown 里做：IME 提交的中文标点不会以单字符 keydown 到达
    // （Chromium 走 composition 路径），keydown + input 双路径会重复判定。
    // 现在统一为：
    //   · beforeinput（insertText 单字符）→ 补全 / 包围 / 跳过；
    //   · compositionend（组合提交后相位）→ 补一次闭符号；
    //   · keydown → 退格成对删除、Tab 跳出（这两个必须抢在默认行为之前）。
    if (autoPairEnabled && e.key === "Backspace") {
      // TODO(v0.18): CM6 能力缺口 — `buildSourcePairInput(ta, …)` 签名收 textarea（内部只用 `ta.value`，改签名需动 `utils/sourceAutoPair.ts` + 其单测）。当前 CM6 表现：**Tab 跳出配对 / Backspace 成对删除不生效；缩进本身正常**（CM6 的 `handleTab` 直接调 `planSourceIndent/planSourceOutdent`，不经此函数） | 用户可感知度：中 | 建议优先级：P1
      const ta = sourceTextareaRef.current;
      // 同上一处：判"是不是真 textarea"而不是判 null（CM6 下它是 div，非 null）
      if (ta && typeof (ta as unknown as { value?: unknown }).value === "string") {
        // E5(v0.9.2):IME 组合态守卫——组合期按 Backspace 删拼音，不做成对删除
        // （部分输入法组合期 isComposing=false 但 keyCode=229，与 PM 端 auto-pair 对齐）
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        // v0.8.0 修复 P1-3：围栏代码块 + 行内代码/公式内都不做成对删除（在规划器内判定）
        const plan = planSourceBackspace(
          buildSourcePairInput(ta, ta.selectionStart ?? 0, ta.selectionEnd ?? 0),
        );
        if (plan.kind === "edit") {
          e.preventDefault();
          e.stopPropagation();
          // ⚠️ v0.17.0 A2（修复 C14 第二处）：配对落地的**同一处**标记 justPaired，
          // 使"一次补全 = 一步撤销"成立（而不是事后靠文本形状推）。
          sourceJustPairedRef.current = true;
           sourceSurface.applyEdit(plan);
          return;
        }
      }
    }

    const action = parseShortcut(e.nativeEvent);
    if (!action) return;
    e.preventDefault();
    // 阻止冒泡到 window，避免 App.tsx 的全局快捷键误触发
    e.stopPropagation();
    if (action === "math") {
      handleFormatAction.current("math");
    } else if (action === "paragraph") {
      handleFormatAction.current("paragraph");
    } else if (action.startsWith("heading")) {
      handleFormatAction.current(action);
    } else {
      handleFormatAction.current(action);
    }
  }, [isSourceMode, isMdFile, autoPairEnabled]);


  /**
   * ## v0.17.0 R2-⑦ 根因修复：CM6 下「ghost 活跃时退格整段删除格式符」
   *
   * ### 缺陷（用户第 7 项）
   * 点格式栏 / 语法栏的「粗体」→ 文档插入 `****` + 灰色占位「粗体文本」→
   * **什么都不输入**直接按 Backspace → 本应一次删净 `****`、光标回到点击前位置；
   * v0.17.0 迁移到 CM6 后变成「逐字符删除」（`****` → `***`）。
   *
   * ### 实测证据（`scripts/v0170-r2-ghost-backspace.mjs`，浏览器内仪器 + 对照）
   *
   * | 判定 | 实测值 | 结论 |
   * |---|---|---|
   * | ghost 在 Backspace 那一刻是否存活 | `formatGhostRef.current = {pos:13,start:11,end:15}` | **活着**，不是"被提前清掉" |
   * | `ghost.pos` vs CM6 `getSelection()` | 13 vs `{start:13,end:13}` | **完全一致**，坐标语义没问题 |
   * | ghost 快照 vs 文档 | `remove()` 内部 slice 判据通过（直接调用返回 `true`，整段删净、光标回 11） | **判据本身是好的** |
   * | 宿主的 `onKeyDown` 收到 Backspace？ | `handlerCalls = []`（**零次**） | **断在这里** |
   * | 正向对照：F13（CM6 keymap 不管辖） | `handlerCalls = ["F13"]` | 接线本身是通的，不是仪器坏了 |
   * | 反向对照：直接调 `remove()` | `ret=true`，文档 `****` → 空，光标 11 = `ghost.start` | 排查线索 1/2/3 **全部不成立** |
   *
   * ### 根因机制（CM6 源码，已核对 `@codemirror/view` 6.43）
   *
   * CM6 把 keymap 实现在 **`keymap` facet 的 `enables`** 上：
   * ```js
   * const handleKeyEvents = Prec.default(EditorView.domEventHandlers({
   *   keydown(event, view) { return runHandlers(getKeymap(view.state), event, view, "editor"); }
   * }));
   * ```
   * 而 `@codemirror/commands` 的 `defaultKeymap` 里**显式绑定了 Backspace**：
   * ```js
   * { key: "Backspace", run: deleteCharBackward, shift: deleteCharBackward, preventDefault: true }
   * ```
   * `buildExtensions()` 里 `keymap.of([...defaultKeymap])` 在**本类的 domEventHandlers 之前**，
   * 两者同为 `Prec.default` 优先级 → `runHandlers()` 按注册顺序跑：
   * ```js
   * for (let handler of handlers.handlers) {
   *   if (event.defaultPrevented) break;
   *   if (handler(this.view, event)) { event.preventDefault(); break; }
   * }
   * ```
   * `handleKeyEvents` 先跑 → `deleteCharBackward` 返回 true → **preventDefault + break**
   * → 宿主的 `handleSourceKeyDown`（在 `setDomEventHandlers` 注册的第二个 handler）
   * **一次都不会被调用**。于是"退格整段删除"这段代码在 CM6 下是**死代码**。
   *
   * 这解释了为什么"逐字符删除"而不是"完全没反应"：CM6 自己的
   * `deleteCharBackward` 接住了 Backspace —— 删 1 个 `*`，完全符合用户描述。
   *
   * ### 为什么修在**捕获阶段**（而不是去改 keymap 优先级）
   *
   * 同一文件里 `CmSourceSurface` 的 Tab 已经踩过同一个坑并留下结论：
   * `keymap` / `Prec.highest(keymap)` / `Prec.highest(domEventHandlers)` 三种写法
   * **都拿不到一致结果**，最终采用「contentDOM 上的捕获阶段原生监听」。
   * 本缺陷属同一类，故沿用同一模式 —— 且这样做**不改 `CmSourceSurface.ts`**
   * （另一 agent 正在改该文件的邻近区域，避免写冲突）。
   *
   * 捕获阶段在**宿主元素（`.source-editor-cm6`）的祖先链**上跑，
   * 天然早于 CM6 绑在 `.cm-content` 上的任何 listener；`stopPropagation()` 之后
   * CM6 的 `deleteCharBackward` 与浏览器默认退格都不会执行。
   *
   * ### 刻意保留的既有语义（逐条对齐 textarea 路径的 `handleSourceKeyDown`）
   * - **AI 续写 ghost 优先**：`sourceGhostActiveRef` 的 Tab/Esc 语义在上面的
   *   `handleSourceKeyDown` 里，本监听**不碰** Tab/Esc，也不抢 AI ghost；
   *   Backspace 语义与 textarea 路径一致（先由格式 ghost 判据决定，判据不过就走默认）；
   * - **光标已离开插入点 / 用户已输入过字符** → `remove()` 内部判据返回 false
   *   → 本监听什么都不做（`preventDefault` 都不调）→ 退回 CM6 默认逐字符删除；
   * - **`shouldClearFormatGhost` 语义表不动**：清除时机判定一行没改；
   * - **ESC 清 ghost / Tab 采纳** 等手势不受影响（本监听只认 Backspace）；
   * - **textarea 路径零影响**：`impl !== "cm6"` 直接 return（React `onKeyDown` 负责）。
   */
  useEffect(() => {
    if (sourceSurface.impl !== "cm6") return;
    if (!isSourceMode || !isMdFile) return;

    const onKeyDownCapture = (e: KeyboardEvent) => {
      // 只接管「无修饰键的 Backspace」（Ctrl/Cmd/Alt+Backspace 是"按词/按行删除"，语义不同）
      if (e.key !== "Backspace") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // IME 组合态守卫（与 `handleSourceKeyDown` 里配对/缩进分支同款口径）
      if (e.isComposing || e.keyCode === 229) return;
      /**
       * 只处理**落在源码面 CM6 宿主内部**的按键。
       *
       * 用 `document` + 运行时 `contains()` 判定（而不是在 effect 里缓存宿主元素），
       * 这样 CM6 view 重挂载 / 宿主元素被 React 复用重建时都不会绑到旧节点上。
       */
      const host = sourceTextareaRef.current;
      if (!host) return;
      const target = e.target;
      if (!target || !(target instanceof Node) || !host.contains(target)) return;
      // ghost 不存在 → 完全交给 CM6 默认行为（连 preventDefault 都不碰）
      if (!formatGhostRef.current) return;
      // 判据不过（光标已移开 / 快照不符）→ 同样交回 CM6 默认逐字符删除
      if (!formatGhostHandlersRef.current.remove()) return;
      e.preventDefault();
      e.stopPropagation();
    };

    document.addEventListener("keydown", onKeyDownCapture, true);
    return () => document.removeEventListener("keydown", onKeyDownCapture, true);
  }, [sourceSurface, isSourceMode, isMdFile]);

  return {
    handleSourceChange,
    applySourceInput,
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
    handleSourceKeyDown
  };
}
