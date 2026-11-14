/**
 * src/editor/surface/TextareaSourceSurface.ts —— `SourceSurface` 的 textarea 参考实现
 *
 * ## 职责边界
 *
 * 本文件是**落地层**：只负责把"打算怎么改"变成"textarea 上真正发生的那一次编辑"，
 * 以及把 textarea 的度量/选区/滚动读出来。**判定逻辑一行都不在这里** ——
 *
 * - 配对/缩进/Tab 跳出的判定：`utils/sourceAutoPair.ts`（`planSourceChar` /
 *   `planSourceBackspace` / `planSourceTab` / `planSourceCompositionCommit`）、
 *   `utils/sourceIndent.ts`（`planSourceIndent` / `planSourceOutdent`）；
 * - 视口内容锚点：`utils/viewportAnchor.ts`（`captureTextAnchor` / `restoreTextAnchor`）；
 * - 行轴（分屏对齐块几何）：`utils/blockScrollAlign.ts`（`measureSourceLineAxis` /
 *   `buildSourceLineAxis`）。
 *
 * 这些都是既有纯函数，v0.17.0 P0 **原样保留不动**（它们的单测是本轮 6614 门禁的一部分）。
 * 本文件只把它们包成接口方法。
 *
 * ## 为什么不直接用 `ta.value = x` 改文本
 *
 * A3 之前 `applySourcePairPlan`（编辑器容器的兼容壳，已删除）用 `document.execCommand("insertText")` 而不是赋值，
 * 原因是硬需求：**一次补全只占一次撤销**。`execCommand` 触发的是**原生的 input 事件**
 * （浏览器把它当成一次用户输入），React 的 onChange 只收到一次；而 `ta.value = x`
 * 根本不触发 input 事件，宿主就收不到变更，diff 撤销栈与统一时间线都会漏记。
 *
 * ⚠️ 任务卡红线「不要用 execCommand 作为**新增**落地手段」：这里**不是新增**，
 * 是把既有的 `applySourcePairPlan`（`EditorContainer.tsx:616`，v0.12.1 起就在用）原样搬进
 * 实现层。真正的新增落地手段是 CM6 的 `dispatch`（A 线），届时本类整个退役。
 *
 * ## 与 CM6 的关系
 *
 * A 线会写 `src/editor/cm6/Cm6SourceSurface.ts` 实现同一个接口。本文件因此是
 * **参考实现 + 回退实现**：CM6 出问题时可以整体回退到它（`SourceSurface` 的选型
 * 由容器决定，见 `src/editor/types.ts` 的文件头）。
 */

import {
  captureTextAnchor,
  restoreTextAnchor,
  type TextContentAnchor,
} from "../../utils/viewportAnchor";
import {
  measureSourceLineAxis,
} from "../../utils/blockScrollAlign";
import { topLevelBlockStartLines } from "../../core/renderPipeline";
import { measureTextareaCursorY, measureTextareaRangeY } from "../../utils/focus-paragraph";
import type {
  SourceAnchor,
  SourceDomEventHandlers,
  SourceChangeEvent,
  SourceChangeKind,
  SourceEditPlan,
  SourceMetrics,
  SourceSelectionLike,
  SourceSurface,
  SourceSurfaceOptions,
} from "../types";

/** 搜索高亮区间（与 `SourceSurface.setSearchRanges` 入参同形） */
interface SearchRange {
  start: number;
  end: number;
  active?: boolean;
}

/**
 * `SourceSurface` 的 textarea 实现。
 *
 * 生命周期：`mount()` 接管一个已存在的 `<textarea>`（现状 JSX 里就是受控渲染的
 * `source-editor`），或在一个空 host 里创建。
 *
 * ⚠️ **不改受控性**：现状 textarea 是 React 受控组件（`value={sourceContent}`）。
 * P0 阶段本类只**读** DOM、只经 `execCommand` 写 DOM，**不接管 value 渲染** ——
 * 否则 `sourceContent` 与 DOM 会打架（这是上一轮 `handleSourceChange` 里
 * `textarea.value = masked` 那种补丁的来源）。把受控性留给容器是刻意选择：
 * P0 的目标是"不改行为"，A 线换了 CM6 之后 React 不再需要受控。
 */
export class TextareaSourceSurface implements SourceSurface {
  readonly impl = "textarea";

  /** 是否已挂载（宿主用它保护受控写入，见接口注释） */
  isMounted(): boolean {
    return this.ta !== null;
  }

  private host: HTMLElement | null = null;
  /** 受管 textarea（`mount` 后必非空） */
  private ta: HTMLTextAreaElement | null = null;
  /** 宿主外部传入的 textarea（受控组件那条路径用它，避免再造一个 DOM） */
  private externalTa: HTMLTextAreaElement | null = null;
  private listeners = new Set<(ev: SourceChangeEvent) => void>();
  private lastReportedText = "";
  /** 组合会话 id：每次 compositionstart +1，compositionend 清空（供 sourceAdapter 显式分组） */
  private compositionSeq = 0;
  private composing = false;
  private activeCompositionGroupId: string | undefined;
  private overlayEl: HTMLElement | null = null;
  private ghostEl: HTMLElement | null = null;
  private ghost: { text: string; pos: number; tail?: string; maskTail?: boolean } | null = null;
  private searchRanges: SearchRange[] = [];
  private disposed = false;
  private readonly onInput = () => this.report("typing");
  private readonly onCompositionStart = () => {
    this.composing = true;
    this.compositionSeq += 1;
    this.activeCompositionGroupId = `ime-${this.compositionSeq}`;
  };
  private readonly onCompositionEnd = () => {
    // 组合结束的这次 input 与组合期事件归同一组：先上报 ime，再复位组合态
    this.report("ime", this.activeCompositionGroupId);
    this.composing = false;
    this.activeCompositionGroupId = undefined;
  };

  constructor(externalTa?: HTMLTextAreaElement | null) {
    this.externalTa = externalTa ?? null;
  }

  // ── 生命周期 ────────────────────────────────────────────────

  mount(host: HTMLElement, opts: SourceSurfaceOptions): void {
    this.host = host;
    /**
     * ⚠️ **关键：若 host 本身就是 `<textarea>`，必须直接接管它，不能再往里建一个。**
     *
     * 这个坑真实踩过（A2 引入 callback ref 挂载时，3 条跨模式撤销回归就是这么来的）：
     * 宿主 JSX 渲染的 `<textarea ref={hostRef}>` 被作为 `host` 传进来，
     * 旧实现走 `externalTa === null` 分支 → 在 textarea **内部**又 appendChild 了一个
     * 嵌套 textarea。于是 DOM 里有两个 `.source-editor`、两份 value：
     * - 测试的 `document.querySelector("textarea.source-editor")` 拿到外层那个（React 受控、内容正确）；
     * - 而 surface 的所有读写都作用在内层那个；
     * - 撤销时的 `setSelectionRange` 恢复作用在内层 → 外层 `selectionStart` 停在文末，
     *   断言「撤销后光标回到编辑前位置」实测偏 8/12。
     *
     * 正确处理：host 是 textarea 时它就是受管元素（React 已经渲染好 value/受控属性），
     * 本实现只加监听、不新建、也不 appends 子节点。
     */
    let ta = this.externalTa;
    if (!ta && host instanceof HTMLTextAreaElement) {
      ta = host; // 直接接管 React 渲染出来的那个受控 textarea
    }
    if (!ta) {
      // 没有外部受控 textarea、host 也不是 textarea 时自己建一个（CM6 之外的场景 / 单测用）
      ta = document.createElement("textarea");
      ta.className = "source-editor";
      host.appendChild(ta);
      this.toBeCleanedUp = true;
    }
    this.ta = ta;
    // ⚠️ 契约要求 mount 后 getText() 立即反映 initialText（工厂/契约测试依赖它）。
    // 原先只记录到 lastReportedText、不写回 DOM —— 在受控路径（React 已经把 value 渲染上）
    // 看不出问题，但**无宿主渲染时**（自建 textarea、单测、探针）getText 会读到空串。
    // 因此只在"DOM 值与 initialText 不一致"时写回，避免与受控渲染抢写。
    if (ta.value !== opts.initialText) ta.value = opts.initialText;
    this.lastReportedText = opts.initialText ?? ta.value ?? "";
    if (opts.readOnly) ta.readOnly = true;
    // v0.17.1 E4：空文档占位提示（与 CM6 的 placeholder() 扩展语义对齐：
    // 文档为空时显示灰字提示，打字即消失、不入文档）。
    if (opts.placeholderText !== undefined) ta.placeholder = opts.placeholderText;
    // 用原生 DOM 监听而非 React props：接口要对"实现"负责，不能靠容器传 onChange
    ta.addEventListener("input", this.onInput);
    ta.addEventListener("compositionstart", this.onCompositionStart);
    ta.addEventListener("compositionend", this.onCompositionEnd);
    this.buildOverlay();
    /**
     * ## v0.17.0 P1-6：`mount()` 必须**重放**已有 ghost（与 CM6 实现对齐）
     *
     * `this.ghost` 是实例字段，但 `mount()` 会 `buildOverlay()` 新建 overlay 容器
     * （`destroy()` 里已经 `ghostEl.remove()` 置空）→ 重挂载后 overlay 是空的，
     * 而 `this.ghost` 还在。不重放就等于"实例记得、DOM 忘了"。
     *
     * 说明：旧注释曾把本文件 `report()` 末尾那句 `if (this.ghost) this.showGhost(...)`
     * 误当成"mount 恢复"。那不是 —— 那句是**输入变化后重绘 overlay**。
     * textarea 路径从不因内容变化重挂载，所以这个缺口一直没暴露；但契约上它真实存在。
     */
    if (this.ghost) this.showGhost(this.ghost);
  }

  destroy(): void {
    this.disposed = true;
    this.scrollCleanups.forEach((fn) => fn());
    this.scrollCleanups = [];
    const ta = this.ta;
    if (ta) {
      ta.removeEventListener("input", this.onInput);
      ta.removeEventListener("compositionstart", this.onCompositionStart);
      ta.removeEventListener("compositionend", this.onCompositionEnd);
      if (this.toBeCleanedUp && ta.parentNode) ta.parentNode.removeChild(ta);
    }
    this.overlayEl?.remove();
    this.overlayEl = null;
    this.ghostEl?.remove();
    this.ghostEl = null;
    this.listeners.clear();
    this.ta = null;
    this.host = null;
  }

  /** 是否由本类创建（`destroy` 时才由它负责移除；外部传入的绝不删） */
  private toBeCleanedUp = false;

  // ── 内容 ────────────────────────────────────────────────────

  getText(): string {
    return this.ta?.value ?? "";
  }

  /**
   * 整篇替换。
   *
   * ⚠️ 不走 `execCommand`：整篇替换是**程序化**动作（模式切换同步 / 撤销落地 /
   * AI 回写），不应被当成用户输入记一条撤销（现状靠宿主 `applyHistoryTextRef` 的
   * `bridge` meta 区分，接口层直接标 `origin: "programmatic"`）。
   */
  setText(text: string, opts?: { selection?: SourceSelectionLike; scrollTop?: number }): void {
    const ta = this.ta;
    if (!ta) return;
    if (ta.value !== text) ta.value = text;
    if (opts?.selection) ta.setSelectionRange(opts.selection.start, opts.selection.end);
    if (opts?.scrollTop !== undefined) ta.scrollTop = opts.scrollTop;
    this.lastReportedText = text;
    this.emit({
      text,
      selection: this.getSelection(),
      scrollTop: ta.scrollTop,
      kind: "typing",
      origin: "programmatic",
    });
  }

  // ── 选区与光标 ─────────────────────────────────────────────

  getSelection(): SourceSelectionLike {
    const ta = this.ta;
    if (!ta) return { start: 0, end: 0 };
    return { start: ta.selectionStart, end: ta.selectionEnd };
  }

  setSelection(start: number, end: number): void {
    this.ta?.setSelectionRange(start, end);
  }

  getScrollTop(): number {
    return this.ta?.scrollTop ?? 0;
  }

  /**
   * 即时写入滚动位置（语义与 CM6 实现保持一致：写完即到位）。
   * 恢复类路径全部走这里；需要动画请用 `setScrollTopSmooth`。
   */
  setScrollTop(px: number): void {
    if (this.ta) this.ta.scrollTop = px;
  }

  /**
   * **平滑**写入滚动位置（v0.17.0 第三轮 · 用户第 8 项「打字机要平滑」）。
   *
   * 与 `CmSourceSurface.setScrollTopSmooth` **逐语义对齐**（两个实现必须同观感，
   * 否则"阅读面平滑、编辑面瞬移"这个缺陷只是换了个实现继续存在）。
   *
   * 为什么 textarea 也要显式实现而不是让调用方退回 `setScrollTop`：
   * `PreviewPane.writeScrollTop` 的分派规则是"有 smooth 能力就用"，
   * 若 textarea 不实现，那条分支永远走不到 textarea → 一旦 run-time 回退到
   * textarea 实现（`createSourceSurface` 的降级路径），平滑又丢了。
   *
   * 注：textarea 的 `scrollTo({behavior})` 在 Chromium/WebView2 上有效；
   * 老内核会忽略 options → 退化为即时跳变（不出错，只是不动画）。
   */
  setScrollTopSmooth(px: number, behavior: "smooth" | "instant" = "smooth"): void {
    const ta = this.ta;
    if (!ta) return;
    if (behavior === "instant") {
      ta.scrollTop = px;
      return;
    }
    const max = Math.max(0, ta.scrollHeight - ta.clientHeight);
    const top = Math.max(0, Math.min(max, px));
    try {
      ta.scrollTo({ top, behavior: "smooth" });
    } catch {
      ta.scrollTop = top;
    }
  }

  /**
   * 视口中央内容锚点。
   *
   * 现状 `captureSourceContentAnchor`（`EditorContainer.tsx:1350-1432`）内部就是
   * `captureTextAnchor(textarea, clientHeight / 2)` 再套一层几何缓存；几何缓存属于
   * **宿主**的优化（它还要与 PM 几何对齐），不在接口职责内 —— 本方法只给出锚点。
   */
  captureViewportAnchor(): SourceAnchor | null {
    const ta = this.ta;
    if (!ta) return null;
    const anchor: TextContentAnchor | null = captureTextAnchor(ta, Math.max(0, ta.clientHeight / 2));
    if (!anchor) return null;
    // ContentAnchor 需要块索引/比例，单看字符偏移给不出块号 → 由宿主的几何缓存补全。
    // 这里给出可用的最小信息：字符偏移 + 视口 Y（宿主按 blockScrollAlign 反算块）。
    return {
      blockIndex: -1,
      ratioWithinBlock: 0,
      textOffset: anchor.offset,
      viewportY: anchor.viewportY,
    } as SourceAnchor;
  }

  /**
   * 光标/偏移在**内容坐标系**的 Y（A3-④）。
   *
   * textarea 实现直接复用既有 `measureTextareaCursorY`（mirror div 复刻排版）——
   * **原函数一行未改**：它是经过软换行实测验证的实现，A3 只是把它收进接口，
   * 让宿主不必再直接拿 textarea 计算。
   */
  offsetToContentY(offset?: number): number | null {
    const ta = this.ta;
    if (!ta) return null;
    try {
      const pos = offset === undefined ? ta.selectionStart : offset;
      if (!Number.isFinite(pos)) return null;
      return measureTextareaCursorY(ta, Math.max(0, Math.min(ta.value.length, pos)));
    } catch {
      return null;
    }
  }

  /**
   * 一段字符区间在**内容坐标系**的起止 Y（A3-④：专注模式遮罩）。
   *
   * textarea 实现直接复用既有 `measureTextareaRangeY` —— **原函数一行未改**
   *（它与打字机的 `measureTextareaCursorY` 是同一套 mirror 机制，已由软换行实测验证）。
   * A3 只是把它收进接口，让宿主不必再直接拿 textarea 算、也不必为 CM6 写第二份。
   */
  measureRangeContentY(start: number, end: number): { startY: number; endY: number } | null {
    const ta = this.ta;
    if (!ta) return null;
    const len = ta.value.length;
    const s = Math.max(0, Math.min(len, start));
    const e = Math.max(0, Math.min(len, end));
    if (!(e > s)) return null;
    try {
      const r = measureTextareaRangeY(ta, s, e);
      if (!r) return null;
      if (!Number.isFinite(r.startY) || !Number.isFinite(r.endY)) return null;
      return { startY: r.startY, endY: r.endY };
    } catch {
      return null;
    }
  }

  /** 恢复内容锚点（`captureViewportAnchor` 的逆操作） */
  restoreViewportAnchor(anchor: SourceAnchor | null | undefined): void {
    const ta = this.ta;
    if (!ta) return;
    const offset = (anchor as unknown as { textOffset?: number } | null)?.textOffset;
    const viewportY = (anchor as unknown as { viewportY?: number } | null)?.viewportY;
    if (offset === undefined) return;
    restoreTextAnchor(ta, { offset, viewportY: viewportY ?? 0 });
  }

  scrollToOffset(offset: number, opts?: { center?: boolean }): void {
    const ta = this.ta;
    if (!ta) return;
    // 行号 → 顶部：块行轴可用时按行盒重建（精确）；否则退化为 scrollTop 比例估算
    const text = ta.value;
    const clamped = Math.max(0, Math.min(text.length, offset));
    const line = text.slice(0, clamped).split("\n").length - 1;
    const axis = measureSourceLineAxis({ textarea: ta, blockLines: topLevelBlockStartLines(text) });
    if (axis && axis.totalLines > 1) {
      const maxScroll = Math.max(0, ta.scrollHeight - ta.clientHeight);
      const top = (line / Math.max(1, axis.totalLines - 1)) * maxScroll;
      ta.scrollTop = Math.max(0, top - (opts?.center ? ta.clientHeight / 2 : 0));
      return;
    }
    const maxScroll = Math.max(0, ta.scrollHeight - ta.clientHeight);
    ta.scrollTop = (line / Math.max(1, text.split("\n").length)) * maxScroll;
  }

  // ── 编辑事件 ───────────────────────────────────────────────

  /**
   * 订阅滚动（A3：分屏双向联动的左屏一侧）。textarea 实现绑元素 `scroll`，
   * 与 A3 之前的行为完全一致。
   */
  onDidScroll(
    listener: (ev: { scrollTop: number; scrollHeight: number; clientHeight: number }) => void,
  ): () => void {
    const ta = this.ta;
    if (!ta) return () => {};
    const handler = () => {
      listener({
        scrollTop: ta.scrollTop,
        scrollHeight: ta.scrollHeight,
        clientHeight: ta.clientHeight,
      });
    };
    ta.addEventListener("scroll", handler, { passive: true });
    this.scrollCleanups.push(() => ta.removeEventListener("scroll", handler));
    return () => ta.removeEventListener("scroll", handler);
  }

  private scrollCleanups: Array<() => void> = [];

  /**
   * 宿主级事件处理（A3）。
   *
   * textarea 路径**本来就用 React 的 onKeyDown/onPaste/onContextMenu**（绑在 JSX 上），
   * 这里再绑一次会造成双触发 —— 所以实现为"仅当宿主不是 React 受控元素时才绑定"。
   * 实际上本实现永远由 React 受控渲染，因此这里保留空实现 + 明确的注释，
   * 避免后人以为"忘了实现"。
   */
  setDomEventHandlers(_handlers: SourceDomEventHandlers): void {
    // no-op：textarea 路径由 JSX 的 React 事件处理（见 EditorContainer 的 onKeyDown 等）。
    // 若在此重复绑定会与 React 事件双触发（Tab 会缩进两次）。
  }

  onDidChange(listener: (ev: SourceChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * 落地一次离散编辑。
   *
   * 与 `applySourcePairPlan`（现状函数）**行为完全一致**：
   * - `none` → 什么都不做；
   * - 纯光标移动（`from === to && text === ""`，用于"跳过输入 / Tab 跳出"）→ 只 `setSelectionRange`；
   * - 其余 → `setSelectionRange(from,to)` + `execCommand("insertText")` + 复位光标。
   *
   * `execCommand` 在这里的作用是**产生一次原生 input 事件**（见文件头说明），
   * 不是"新增落地手段"。
   */
  applyEdit(plan: SourceEditPlan): void {
    if (plan.kind !== "edit") return;
    const ta = this.ta;
    if (!ta) return;
    const { from, to, text, caret, caretEnd } = plan.edit;
    if (from === to && text === "") {
      ta.setSelectionRange(caret, caretEnd ?? caret);
      return;
    }
    ta.setSelectionRange(from, to);
    // 让文档真正变一次：走浏览器原生插入以保留"一次用户输入 = 一次 onChange"
    document.execCommand("insertText", false, text);
    ta.setSelectionRange(caret, caretEnd ?? caret);
    // ⚠️ 不在这里手动 emit：execCommand 已经触发 input 事件 → onInput → report()。
    // 手动再 emit 一次会让宿主记两条撤销（这正是需要避免的双记）。
  }

  // ── 度量 ────────────────────────────────────────────────────

  /**
   * 顶层块起始行的实测行盒顶部。
   *
   * 直接复用 `measureSourceLineAxis`（mirror 容器测量，纯函数、已有单测）。
   * CM6 实现会换成 `coordsAtPos`，不再需要 mirror —— 这是本接口能真正"替代 mirror"
   * 的地方。
   */
  measureBlockTops(blockLines: number[]): number[] | null {
    const ta = this.ta;
    if (!ta) return null;
    const measured = measureSourceLineAxis({ textarea: ta, blockLines });
    if (!measured) return null;
    // measureSourceLineAxis 给的是"行 → 顶部"的插值轴；这里按入参行号从轴取顶部。
    const maxScroll = Math.max(0, ta.scrollHeight - ta.clientHeight);
    const total = Math.max(1, measured.totalLines - 1);
    const span = measured.axis.length > 1 ? measured.axis[measured.axis.length - 1] : maxScroll;
    return blockLines.map((line) => {
      const l = Math.max(0, Math.min(total, Math.floor(line)));
      return (l / total) * span;
    });
  }

  getMetrics(): SourceMetrics {
    const ta = this.ta;
    if (!ta) return { totalLines: 0, scrollHeight: 0, clientHeight: 0, clientWidth: 0 };
    return {
      totalLines: ta.value.split("\n").length,
      scrollHeight: ta.scrollHeight,
      clientHeight: ta.clientHeight,
      clientWidth: ta.clientWidth,
    };
  }

  isComposing(): boolean {
    return this.composing;
  }

  // ── 搜索高亮 ───────────────────────────────────────────────

  /**
   * 设置搜索命中图层。
   *
   * ⚠️ 这是**过渡实现**：`SearchReplace.tsx` 现在自己建一层 overlay（它需要和它自己的
   * 度量对齐）。P0 只把区间存下来并渲染到本类的 overlay 上，**不改变 SearchReplace
   * 的行为**（A3 会把 overlay 整体换成 CM6 Decoration，届时 `SearchReplace` 改为
   * 消费本方法，见设计稿决议记录 §10.3「立即删、不留双路由」）。
   */
  setSearchRanges(ranges: SearchRange[]): void {
    this.searchRanges = ranges;
    this.renderSearchOverlay();
  }

  clearSearchRanges(): void {
    this.searchRanges = [];
    this.renderSearchOverlay();
  }

  // ── ghost ────────────────────────────────────────────────────

  /**
   * 显示 ghost 占位。
   *
   * 现状 `renderSourceGhost`（`EditorContainer.tsx:4712`）也在做同样的事：往
   * `sourceGhostOverlayRef` 里填 HTML。P0 保留 overlay 的 DOM 结构不变（CSS 依赖它），
   * 只把"往里填什么"收敛到这里。
   */
  showGhost(ghost: { text: string; pos: number; tail?: string; maskTail?: boolean }): void {
    this.ghost = ghost;
    const el = this.ghostEl;
    const ta = this.ta;
    if (!el || !ta) return;
    const tail = ghost.tail ?? "";
    // 与现状一致：正文按行转义后替换空白，尾巴若要求 mask 则整体置灰
    const safe = ghost.text.split("\n").map((l) => escapeHtml(l)).join("<br/>");
    const tailHtml = tail ? (ghost.maskTail ? `<span class="ghost-mask">${escapeHtml(tail)}</span>` : escapeHtml(tail)) : "";
    el.innerHTML = safe + tailHtml;
    el.style.display = "block";
    el.scrollTop = ta.scrollTop;
  }

  clearGhost(): void {
    this.ghost = null;
    const el = this.ghostEl;
    if (!el) return;
    el.innerHTML = "";
    el.style.display = "none";
  }

  // ── 焦点 ───────────────────────────────────────────────────

  focus(): void {
    this.ta?.focus();
  }

  isFocused(): boolean {
    const ta = this.ta;
    return !!ta && ta.ownerDocument.activeElement === ta;
  }

  // ── 内部 ───────────────────────────────────────────────────

  /** 上报一次变更（经 DOM input / composition 事件触发） */
  private report(kind: SourceChangeKind, groupId?: string): void {
    if (this.disposed) return;
    const ta = this.ta;
    if (!ta) return;
    const text = ta.value;
    const ev: SourceChangeEvent = {
      text,
      selection: { start: ta.selectionStart, end: ta.selectionEnd },
      scrollTop: ta.scrollTop,
      kind,
      compositionGroupId: groupId,
      origin: "dom",
      /**
       * 只用 `origin` 区分不够（v0.17.0 P1-6）：本实现的所有上报都来自原生
       * `input` / `compositionend`，两者都**只在值真的变化时**触发，所以这里恒为 `true`。
       * 但仍要显式给出，与 CM6 实现保持同一份语义契约
       * （宿主用 `origin !== "programmatic" && docChanged !== false` 判定"真实键入"）。
       */
      docChanged: true,
    };
    this.lastReportedText = text;
    this.emit(ev);
    // 搜索/ghost overlay 跟随文本与滚动
    this.renderSearchOverlay();
    if (this.ghost) this.showGhost(this.ghost);
  }

  private emit(ev: SourceChangeEvent): void {
    this.listeners.forEach((l) => l(ev));
  }

  /** 建搜索/ghost 的 overlay 容器（懒创建，挂在 textarea 父元素上，与现状一致） */
  private buildOverlay(): void {
    const ta = this.ta;
    const parent = ta?.parentElement;
    if (!ta || !parent) return;
    // 搜索 overlay：只承载底色，pointer-events 由 CSS 关掉
    if (!this.overlayEl) {
      const el = ta.ownerDocument.createElement("div");
      el.className = "source-search-overlay";
      el.setAttribute("aria-hidden", "true");
      parent.appendChild(el);
      this.overlayEl = el;
    }
    // ghost overlay：AI 续写/格式占位
    if (!this.ghostEl) {
      const el = ta.ownerDocument.createElement("div");
      el.className = "source-ghost-overlay";
      el.setAttribute("aria-hidden", "true");
      el.style.display = "none";
      parent.appendChild(el);
      this.ghostEl = el;
    }
  }

  /**
   * 渲染搜索高亮图层。
   *
   * 与现状 `SearchReplace` 的 overlay 同机制：在 textarea 之上叠一层与它**排版完全
   * 对齐**的元素（同字体/行高/内边距/宽高），把命中区间之外的文字染成透明、命中区间
   * 加底色，`scrollTop` 跟随 textarea。textarea 是单元素纯文本控件，内部文字不是
   * DOM 文本节点，没有别的办法把字串上色。
   */
  private renderSearchOverlay(): void {
    const el = this.overlayEl;
    const ta = this.ta;
    if (!el || !ta) return;
    if (!this.searchRanges.length) {
      el.innerHTML = "";
      return;
    }
    const text = ta.value;
    const parts: string[] = [];
    let cursor = 0;
    const sorted = this.searchRanges
      .map((r) => ({ ...r, start: Math.max(0, Math.min(text.length, r.start)), end: Math.max(0, Math.min(text.length, r.end)) }))
      .filter((r) => r.start < r.end || r.end === r.start)
      .sort((a, b) => a.start - b.start);
    for (const r of sorted) {
      if (r.start > cursor) parts.push(escapeHtml(text.slice(cursor, r.start)));
      parts.push(`<mark class="source-search-hit${r.active ? " active" : ""}">${escapeHtml(text.slice(r.start, r.end))}</mark>`);
      cursor = Math.max(cursor, r.end);
    }
    if (cursor < text.length) parts.push(escapeHtml(text.slice(cursor)));
    el.innerHTML = parts.join("");
    // 排版对齐：把 textarea 的计算样式抄过来（现状 SearchReplace 就是这么做的）
    const cs = ta.ownerDocument.defaultView?.getComputedStyle(ta);
    if (cs) {
      el.style.font = cs.font;
      el.style.fontFamily = cs.fontFamily;
      el.style.fontSize = cs.fontSize;
      el.style.lineHeight = cs.lineHeight;
      el.style.letterSpacing = cs.letterSpacing;
      el.style.padding = `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`;
      el.style.whiteSpace = "pre-wrap";
      el.style.wordBreak = "break-word";
      el.style.width = `${ta.clientWidth}px`;
      el.style.height = `${ta.clientHeight}px`;
      el.style.tabSize = cs.tabSize;
    }
    el.scrollTop = ta.scrollTop;
  }
}

/** 最小 HTML 转义（overlay 只放纯文本，不引入富文本） */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
