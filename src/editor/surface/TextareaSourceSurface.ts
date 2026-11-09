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
 * 现状 `applySourcePairPlan` 用 `document.execCommand("insertText")` 而不是赋值，
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
import type {
  SourceAnchor,
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
    let ta = this.externalTa;
    if (!ta) {
      // 没有外部受控 textarea 时自己建一个（CM6 之外的场景 / 单测用）
      ta = document.createElement("textarea");
      ta.className = "source-editor";
      host.appendChild(ta);
      this.toBeCleanedUp = true;
    }
    this.ta = ta;
    this.lastReportedText = opts.initialText ?? ta.value ?? "";
    if (opts.readOnly) ta.readOnly = true;
    // 用原生 DOM 监听而非 React props：接口要对"实现"负责，不能靠容器传 onChange
    ta.addEventListener("input", this.onInput);
    ta.addEventListener("compositionstart", this.onCompositionStart);
    ta.addEventListener("compositionend", this.onCompositionEnd);
    this.buildOverlay();
  }

  destroy(): void {
    this.disposed = true;
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

  setScrollTop(px: number): void {
    if (this.ta) this.ta.scrollTop = px;
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

  // ── 过渡能力 ───────────────────────────────────────────────

  /**
   * ⚠️ 过渡能力，A3 后删除。返回底层 textarea ref（`SearchReplace` 的既有 prop 需要它）。
   * CM6 实现返回 null。
   */
  legacyTextareaRef(): { current: HTMLTextAreaElement | null } | null {
    if (!this.ta) return null;
    // 注意：这里返回的是**只读视图**对象，不是 React ref。调用方只读 `.current`。
    const ta = this.ta;
    return { current: ta };
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
