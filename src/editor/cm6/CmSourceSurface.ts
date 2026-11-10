/**
 * src/editor/cm6/CmSourceSurface.ts —— `SourceSurface` 的 CodeMirror 6 实现（A 线）
 *
 * ## 职责边界
 *
 * 与 `TextareaSourceSurface` **同一契约、同一职责**：把"打算怎么改"变成真正的编辑、
 * 把度量/选区/滚动读出来。判定逻辑一行都不在这里 ——
 *
 * - 缩进判定：`utils/sourceIndent.ts`（`planSourceIndent` / `planSourceOutdent`）
 * - 配对判定：`utils/sourceAutoPair.ts`（`planSourceChar` / `planSourceBackspace` /
 *   `planSourceTab` / `planSourceCompositionCommit`）
 * - 行轴构建：`utils/blockScrollAlign.ts`（`buildSourceLineAxis` 等**纯函数不动**，
 *   本实现只换"数据源"：用 `coordsAtPos` 取代 mirror div）
 *
 * ## 三条硬约束（任务卡原文，逐条对应实现）
 *
 * 1. **禁用 CM6 自带的 undo/redo 与 search**。撤销归 `documentHistory` /
 *    `editorHistory` 统一时间线（现状结构不许改）。实现方式：
 *    `EditorState.create` **不装** `history()`，并在 keymap 里把
 *    `Mod-z` / `Mod-Shift-z` / `Mod-y` 拦下返回 `false`
 *    （返回 false = 不处理 = 事件冒泡到宿主窗口监听 → `EditorContainer.handleUndo`
 *    走统一时间线）。
 *
 * 2. **Tab 完全接管**。`Tab` / `Shift-Tab` 走 `planSourceIndent` / `planSourceOutdent`，
 *    经 `applyEdit` **单事务**落地（一次 Tab = 一步撤销）。优先级保持：
 *    AI ghost 采纳 > 配对跳出 > 缩进。
 *
 * 3. **视觉/状态对齐**：缩放走 `theme` compartment 设 `fontSize`（**禁用 CSS zoom** ——
 *    zoom 会分裂 rect(视觉) 与 scrollTop(布局) 两个坐标系，打坏打字机/专注遮罩测量）；
 *    spellcheck 走 `EditorView.contentAttributes`；只读走 `EditorState.readOnly` +
 *    `EditorView.editable`。
 *
 * ## 为什么 `applyEdit` 一定是"单事务单步"
 *
 * CM6 每次 `dispatch` 就是一个事务；一次编辑只 dispatch 一次，撤销栈天然只有一步。
 * 这比 textarea 实现**更强**：textarea 版必须靠 `document.execCommand("insertText")`
 * 制造一次原生 input 事件才能做到"一次补全 = 一步"（那是 workaround）。
 * A2 之后 `execCommand` 从 insertText 路径**彻底退役**。
 */

import {
  Compartment,
  EditorState,
  Prec,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  crosshairCursor,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  type DecorationSet,
} from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import {
  HighlightStyle,
  bracketMatching,
  foldGutter,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";

import type {
  SourceAnchor,
  SourceChangeEvent,
  SourceDomEventHandlers,
  SourceKeyEventLike,
  SourceChangeKind,
  SourceEditPlan,
  SourceMetrics,
  SourceSelectionLike,
  SourceSurface,
  SourceSurfaceOptions,
} from "../types";
import { planSourceIndent, planSourceOutdent } from "../../utils/sourceIndent";
import { buildSourceLineAxis } from "../../utils/blockScrollAlign";
import { captureTextAnchor, restoreTextAnchor } from "../../utils/viewportAnchor";

/** 搜索命中区间（与 `SourceSurface.setSearchRanges` 入参同形） */
interface SearchRange {
  start: number;
  end: number;
  active?: boolean;
}

/** ghost 占位（AI 续写 / 格式提示，不写入文档） */
interface GhostSpec {
  text: string;
  pos: number;
  tail?: string;
  maskTail?: boolean;
}

// ─── 搜索高亮：StateEffect + StateField（A3）──────────────────────────────────

const setSearchEffect = StateEffect.define<SearchRange[]>();

const searchMark = Decoration.mark({ class: "cm-source-search-hit" });
const searchActiveMark = Decoration.mark({
  class: "cm-source-search-hit cm-source-search-hit-active",
});

/**
 * 搜索命中用 **mark decoration**：命中区间是真实文档范围，底色由 CSS 提供。
 *
 * 与 textarea 实现的根本差别（这也是 A3 的核心收益）：textarea 版必须在控件**之上**
 * 叠一层与它排版逐像素对齐的 div（字不是 DOM 节点，只能"假装"上色）；
 * CM6 版是真的把范围标在文档上，**不再需要对排版的镜像** —— 换行/缩放/字体变化
 * 都不会让高亮错位。
 */
const searchField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setSearchEffect)) continue;
      const len = tr.newDoc.length;
      const ranges = e.value
        .map((r) => ({
          start: Math.max(0, Math.min(len, r.start)),
          end: Math.max(0, Math.min(len, r.end)),
          active: !!r.active,
        }))
        .filter((r) => r.start < r.end)
        .sort((a, b) => a.start - b.start);
      const builder = new RangeSetBuilder<Decoration>();
      for (const r of ranges) {
        builder.add(r.start, r.end, r.active ? searchActiveMark : searchMark);
      }
      return builder.finish();
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ─── ghost：Decoration.widget（A3）───────────────────────────────────────────

const setGhostEffect = StateEffect.define<GhostSpec | null>();

/** ghost 占位元素：`pointer-events:none`（CSS），不参与命中/选区 */
class GhostWidget extends WidgetType {
  constructor(private readonly spec: GhostSpec) {
    super();
  }
  eq(other: GhostWidget): boolean {
    return (
      other.spec.text === this.spec.text &&
      other.spec.tail === this.spec.tail &&
      other.spec.pos === this.spec.pos
    );
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-source-ghost";
    el.setAttribute("aria-hidden", "true");
    const head = this.spec.text;
    const tail = this.spec.tail ?? "";
    el.textContent = head + tail;
    return el;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

const ghostField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setGhostEffect)) continue;
      if (!e.value) return Decoration.none;
      const pos = Math.max(0, Math.min(tr.newDoc.length, e.value.pos));
      return Decoration.set([
        Decoration.widget({
          widget: new GhostWidget(e.value),
          side: 1,
        }).range(pos),
      ]);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ─── 语法高亮：把现有 Prism token 语义映射到 lezer tag ─────────────────────────
//
// 目的：**避免视觉突变**。源码面此前用 Prism 的 class（`.token.keyword` 等），
// 这里把 lezer 的 tag 映射到同一套视觉语义；具体颜色仍由 CSS 变量控制，
// 因此主题切换（浅色/暗色）行为与既有编辑器一致。

/**
 * Markdown 源码面的语法高亮样式。
 *
 * 用**语义化 CSS 类名**（`cm-md-heading` / `cm-md-code` / …）而不是内联颜色：
 * 这样浅色/暗色主题切换只需要改 CSS 变量，与既有的 `.source-editor` 主题体系同源，
 * 不会在源码面引入第二套配色真相。
 */
const markdownHighlightStyle = HighlightStyle.define([
  { tag: tags.heading1, class: "cm-md-heading cm-md-heading1" },
  { tag: tags.heading2, class: "cm-md-heading cm-md-heading2" },
  { tag: tags.heading3, class: "cm-md-heading cm-md-heading3" },
  { tag: [tags.heading4, tags.heading5, tags.heading6], class: "cm-md-heading" },
  { tag: tags.strong, class: "cm-md-strong" },
  { tag: tags.emphasis, class: "cm-md-emphasis" },
  { tag: tags.strikethrough, class: "cm-md-strikethrough" },
  { tag: tags.link, class: "cm-md-link" },
  { tag: tags.url, class: "cm-md-url" },
  { tag: tags.monospace, class: "cm-md-code" },
  { tag: tags.keyword, class: "cm-md-keyword" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], class: "cm-md-comment" },
  { tag: [tags.string, tags.special(tags.string)], class: "cm-md-string" },
  { tag: [tags.number, tags.bool, tags.null], class: "cm-md-number" },
  { tag: tags.processingInstruction, class: "cm-md-punct" },
]);

/**
 * `SourceSurface` 的 CodeMirror 6 实现。
 *
 * 生命周期：`mount()` 在 host 里建 `EditorView`；`destroy()` 销毁它。
 * **不改受控性约定**：宿主仍持有"当前文本"的事实源（`content`/`sourceContent` 状态），
 * 本实现通过 `setText` 接收程序化替换、通过 `onDidChange` 报告用户编辑。
 */
export class CmSourceSurface implements SourceSurface {
  readonly impl = "cm6";

  /** 是否已挂载（宿主用它保护受控写入，见接口注释） */
  isMounted(): boolean {
    return this.view !== null;
  }
  private static seq = 0;
  private readonly uid = ++CmSourceSurface.seq;

  private view: EditorView | null = null;
  private host: HTMLElement | null = null;
  private listeners = new Set<(ev: SourceChangeEvent) => void>();
  private composing = false;
  private compositionSeq = 0;
  private activeCompositionGroupId: string | undefined;
  /** 最近一次程序化 setText：用于区分 origin=dom / programmatic，并防回环 */
  private lastProgrammaticText = "";
  private searchRanges: SearchRange[] = [];
  private ghost: GhostSpec | null = null;
  private readonly readOnlyCompartment = new Compartment();
  private readonly themeCompartment = new Compartment();
  private readonly attrsCompartment = new Compartment();
  private disposed = false;
  /** 原生 DOM 监听清理函数（composition 事件） */
  private cleanupDom: Array<() => void> = [];

  // ── 生命周期 ────────────────────────────────────────────────

  mount(host: HTMLElement, opts: SourceSurfaceOptions): void {
    this.host = host;
    const state = EditorState.create({
      doc: opts.initialText ?? "",
      extensions: this.buildExtensions(opts),
    });
    // 可重挂载：复位 disposed（destroy 后 React 可能再次挂载同一个实例）
    this.disposed = false;
    this.view = new EditorView({ state, parent: host });
    this.lastProgrammaticText = state.doc.toString();
    this.attachCompositionHandlers();
    // 后置能力复核：jsdom 下构造是成功的，但布局测量不可用（`coordsAtPos` 会抛）。
    // 记录一下便于探针判定；不在此处抛（抛了会让本来就只跑逻辑的测试全挂）。
    this.layoutAvailable = this.probeLayout();
  }

  /**
   * 布局是否可用（`coordsAtPos` 能否求值）。
   *
   * 实测：jsdom 下 `new EditorView` **不抛**，但 `coordsAtPos` 会抛。
   * 因此度量类方法（`measureBlockTops` / `captureViewportAnchor`）必须先看这个标志，
   * 不可用时返回 null/0 让宿主退回百分比映射，而不是让异常冒到渲染流程里。
   */
  private layoutAvailable = false;

  private probeLayout(): boolean {
    const view = this.view;
    if (!view) return false;
    try {
      const r = view.coordsAtPos(0);
      return !!r && Number.isFinite(r.top);
    } catch {
      return false;
    }
  }

  /**
   * 卸载（**可重挂载**）。
   *
   * ## ⚠️ 这里有两个必须保留订阅与可恢复性的理由（实机缺陷定位）
   *
   * 实机探针拿到的完整证据链：
   * ```
   * mount(instance=1, disposed=false)          ← 首次挂载
   * subscribe effect → onDidChange(instance=1) ← 宿主 effect 建立订阅
   * destroy(instance=1)                        ← React 卸载/重挂（StrictMode 双调用、
   *                                              或 callback ref 因元素变化重跑）
   * mount(instance=1, disposed=true)           ← 又挂回来了，但 disposed 仍是 true
   * emit listeners=0                           ← 订阅在 destroy 里被清空，且 effect 不会重跑
   * ```
   * 结果：**CM6 的所有编辑都不再上报** → `applySourceInput` 不执行 → 统一时间线为空
   * → **Ctrl+Z 完全无效**（G6 撤销契约违反）。
   *
   * 因此：
   * 1. **不清空 `listeners`** —— 订阅是"宿主 ↔ 实例"的关系，不随 view 生命周期结束；
   *    清空后宿主没有可观测的重订阅时机（effect 依赖 `sourceSurface` 本身不变）。
   * 2. **`disposed` 必须可恢复** —— `mount()` 里复位为 false，否则 `report()` 首行的
   *    `if (this.disposed) return` 会静默吞掉所有变更上报（又一个"功能静默消失"）。
   */
  destroy(): void {
    this.disposed = true;
    this.cleanupDom.forEach((fn) => fn());
    this.cleanupDom = [];
    // A3：滚动订阅必须在 view 销毁前解绑（scrollDOM 会随 view 一起被丢弃）
    this.scrollCleanups.forEach((fn) => fn());
    this.scrollCleanups = [];
    this.view?.destroy();
    this.view = null;
    this.host = null;
    // ⚠️ 刻意**不**清空 this.listeners（见上方注释）
  }

  // ── 扩展装配 ────────────────────────────────────────────────

  private buildExtensions(opts: SourceSurfaceOptions) {
    const v = this;
    return [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      // 折叠：按 Markdown 标题 / 围栏（A1 要求）
      foldGutter(),
      drawSelection(),
      /**
       * ## v0.17.0 修复：**软换行对齐 textarea 行为**
       *
       * 缺陷：原 textarea 源码面是 `white-space: pre-wrap`，长行会**软换行**；
       * 而 CM6 的 `EditorView` **默认不折行** —— 必须显式加 `lineWrapping`
       * 扩展，否则长行只占一个视觉行、超出部分靠**水平滚动**才能看全。
       *
       * 实机证据（`scripts/v0170-probe-caret-geometry.mjs`）：
       * 一行 1000 个字符的中文，`.cm-line` 的 `getBoundingClientRect().height`
       * 等于 1 个行高（29px，visualRows=1）→ **确认未折行**。
       *
       * 连带影响：
       * 1. 用户看长段落要横向拖，体验明显劣于 textarea 版；
       * 2. CSS 里 `.source-editor` 的注释专门讨论过"软换行行数突变导致
       *    scrollHeight 跳变"——说明折行是**既有设计的一部分**，不是可选项；
       * 3. IME 候选框跟随也依赖光标视觉位置正确（折行影响竖向位置）。
       */
      EditorView.lineWrapping,
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      // 语法高亮：Markdown 语言支持 + lezer tag → 既有 CSS 类映射。
      //
      // ⚠️ 这里**必须**经 @codemirror/lang-markdown 的 `markdown()`，不能直接把
      // @lezer/markdown 的 parser 塞给 `new Language(...)`：后者会抛
      // `nodeSet.types is not iterable`（lezer 的裸 parser 没有 CM6 需要的 NodeSet 包装）。
      // 这是设计稿 §2.1「新依赖只有一个包族，加 @lezer/markdown 即可」的一处疏漏，
      // 已由 Lead 校准并装上 @codemirror/lang-markdown 6.5.2。
      // `addKeymap: false`：Markdown 自带的键位（如 `Mod-Enter`）不接管 ——
      // 源码面的键位由本文件的 keymap 与宿主统一时间线负责。
      markdown({ base: markdownLanguage, addKeymap: false }),
      // 诊断开关（`scripts/v0170-diag-5mb-complex.mjs` 用于隔离"高亮 vs 卡死"的因果关系）。
      // 生产环境该全局变量恒为 undefined → 高亮始终开启。
      ...(typeof window !== "undefined" && (window as unknown as { __LMD_DISABLE_HIGHLIGHT__?: boolean }).__LMD_DISABLE_HIGHLIGHT__
        ? []
        : [syntaxHighlighting(markdownHighlightStyle)]),
      // ⚠️ 硬约束 1：**不装 history()**，撤销归统一时间线
      // 只保留基础编辑键位（去掉 history 相关的默认绑定由下面 keymap 再拦一次）
      keymap.of([...defaultKeymap]),
      // ⚠️ 硬约束 1 的第二道保险：把撤销/恢复键显式拦下并返回 false
      /**
       * ⚠️ `Prec.highest` 是必须的（实机探针 `v0170-probe-cm6` 判定项 3 实证）：
       *
       * 普通 `keymap.of()` 的 Tab 绑定**会输给** CM6 内建的 contenteditable Tab 处理
       * ——实测按 Tab 后文本确实插入了两个空格，但本类的 `handleTab` **一次都没被调用**
       * （探针在该方法入口打日志，零命中），即缩进来自浏览器默认行为而非
       * `planSourceIndent`。
       *
       * 后果：缩进行为与设置里的「缩进单位」（Tab / 2 / 4 空格）完全脱钩 ——
       * 用户设成 Tab 或 4 空格时源码面**仍然是 2 空格**，且 `sourceJustPairedRef`
       * 不置位 → 撤销粒度也不对。
       *
       * `Prec.highest` 把本 keymap 提到所有扩展之前，保证 Tab 一定进 `handleTab`。
       */
      /**
       * 撤销/恢复/搜索键位：返回 false = 不处理 = 让事件冒泡到宿主 window 监听
       * → EditorContainer.handleUndo → 统一时间线。
       */
      keymap.of([
        { key: "Mod-z", run: () => false },
        { key: "Mod-Shift-z", run: () => false },
        { key: "Mod-y", run: () => false },
        { key: "Mod-f", run: () => false },
      ]),
      // 搜索高亮 / ghost 两个 decoration 层
      searchField,
      ghostField,
      // 外部变更通知
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) {
          // 选区/滚动等仍要报告（宿主用它更新光标行列、进度）
          if (u.selectionSet || u.focusChanged) v.report("typing", undefined, "dom", false);
          return;
        }
        v.onDocsChanged(u);
      }),
      // 只读 / 主题 / 属性三个 compartment（运行时可重配，避免重建 view）
      this.readOnlyCompartment.of([
        EditorState.readOnly.of(!!opts.readOnly),
        EditorView.editable.of(!opts.readOnly),
      ]),
      this.attrsCompartment.of(EditorView.contentAttributes.of({ spellcheck: "true" })),
      // A3：宿主级事件（Tab/粘贴/右键）——CM6 下 React 事件绑不到 .cm-content
      this.domHandlersCompartment.of(this.buildDomHandlerExt()),
      this.themeCompartment.of(
        EditorView.theme({
          "&": { height: "100%" },
          ".cm-scroller": { overflow: "auto" },
        }),
      ),
    ];
  }

  // ── 变更上报 ──────────────────────────────────────────────────

  private onDocsChanged(u: import("@codemirror/view").ViewUpdate): void {
    const view = this.view;
    if (!view) return;
    const text = u.state.doc.toString();

    // 程序化替换（setText）不应被当成用户编辑 —— 否则宿主会记一条假撤销
    if (this.programmaticUpdate) {
      this.programmaticUpdate = false;
      this.lastProgrammaticText = text;
      this.emit({
        text,
        selection: this.getSelection(),
        scrollTop: this.getScrollTop(),
        kind: "typing",
        origin: "programmatic",
      });
      return;
    }

    // 输入意图：composition 期一律 ime（同一 groupId），其余按 DOM 事件推断
    let kind: SourceChangeKind = "typing";
    if (this.composing || this.activeCompositionGroupId) kind = "ime";
    else if (this.pendingPaste) kind = "paste";
    else if (this.pendingDelete) kind = "delete";
    else if (this.pendingApplyEdit) kind = "pair";
    this.pendingPaste = false;
    this.pendingDelete = false;
    this.pendingApplyEdit = false;

    this.lastProgrammaticText = text;
    this.report(kind, this.activeCompositionGroupId, "dom", true, text);
  }

  /** setText 触发的更新：标记为程序化，交给 updateListener 区分 */
  private programmaticUpdate = false;
  /** 一次性意图标记（DOM 事件里置位，随下一次 docChanged 消费后复位） */
  private pendingPaste = false;
  private pendingDelete = false;
  private pendingApplyEdit = false;

  private report(
    kind: SourceChangeKind,
    groupId: string | undefined,
    origin: "dom" | "programmatic",
    _docChanged: boolean,
    textArg?: string,
  ): void {
    if (this.disposed) return;
    const view = this.view;
    if (!view) return;
    this.emit({
      text: textArg ?? view.state.doc.toString(),
      selection: this.getSelection(),
      scrollTop: this.getScrollTop(),
      kind,
      compositionGroupId: groupId,
      origin,
    });
  }

  private emit(ev: SourceChangeEvent): void {
    this.listeners.forEach((l) => l(ev));
  }

  // ── IME 组合态（修复 C14：compositionGroupId 由事件源头给出）──────────────

  private attachCompositionHandlers(): void {
    const view = this.view;
    if (!view) return;
    const target = view.contentDOM;

    const onStart = () => {
      this.composing = true;
      this.compositionSeq += 1;
      this.activeCompositionGroupId = `ime-${this.compositionSeq}`;
    };
    const onEnd = () => {
      // compositionend 之后还会有一次 input/docChanged：先记 it 属于当前组
      this.composing = false;
      // groupId 延迟清空：紧随其后的那次更新要带上它（一次组合 = 一组）
      const gid = this.activeCompositionGroupId;
      window.setTimeout(() => {
        if (this.activeCompositionGroupId === gid) this.activeCompositionGroupId = undefined;
      }, 0);
    };

    target.addEventListener("compositionstart", onStart, true);
    target.addEventListener("compositionend", onEnd, true);

    /**
     * ## Tab / Shift-Tab：**捕获阶段**的原生监听（v0.15.6 焦点口径修复）
     *
     * ### 为什么既不用 `keymap` 也不用 `domEventHandlers`
     * 实机探针两次失败，且 `__TABCALLS` 证明 `handleTab` **从未被调用**：
     * 1. `keymap.of([{key:"Tab"}])` → 输给 contenteditable 内建 Tab（缩进不是我们做的）；
     * 2. `Prec.highest(keymap.of(...))` → 缩进生效但**焦点逃逸到 BODY**，
     *    且之后 Shift-Tab 完全无效（Δ0）——"消费"与"阻止默认行为"是两件事；
     * 3. `Prec.highest(EditorView.domEventHandlers(...))` → **同样没被调用**
     *    （`__TABCALLS = undefined`），缩进仍来自浏览器内建行为。
     *
     * ### 采用：捕获阶段的原生监听
     * 在 `contentDOM` 上以 `capture: true` 拦截 keydown，**先于** CM6 的任何 handler
     * 与浏览器默认行为执行，拿到的就是原生事件，可以精确 `preventDefault()`。
     * 这与本类已有的 composition 事件绑定是同一模式（同一元素、同一清理机制）。
     *
     * ### 语义（对齐 v0.15.6 口径）
     * - Tab/Shift-Tab **永不把焦点移出编辑器**；
     * - 缩进/反缩进/ghost 采纳/配对跳出 全部交给 `handleTab`（三态优先级在其内部）；
     * - 即使 `handleTab` 返回 false（无可缩进内容）**也要 preventDefault** ——
     *   焦点不能因为"这次没缩进"就跳出编辑器。
     */
    const onTabKeydown = (e: KeyboardEvent) => {
      if (e.key !== "Tab" && e.code !== "Tab") return;
      if (this.disposed) return;
      // IME 组合态：让输入法自己处理（不抢 Tab）
      if (e.isComposing || this.composing) return;
      /**
       * ⚠️ **`preventDefault()` 必须在 `handleTab()` 之前**（实测定位的缺陷）
       *
       * 页面内三层监听实测（`doc-capture` / `content-capture` / 我们的 handler）：
       * 我们的 handler **确实被调用**（`content-capture:Tab` 命中），
       * 但焦点仍逃逸到 `BODY` —— 说明 `preventDefault()` 没执行到。
       *
       * 原因：`handleTab()` 内部要跑 `planSourceIndent/planSourceOutdent`
       * 与 `applyEdit`，其中任何一步抛异常，都会让后面的 `preventDefault()` **被跳过**
       * （异常沿调用栈冒泡，浏览器照常执行 Tab 的默认焦点移动）。
       *
       * 因此顺序改为：**先无条件阻止默认行为，再尝试缩进** ——
       * 缩进失败最多是"这次没缩进"，而焦点逃逸会让整个编辑器失焦、
       * 后续按键全部落到 body 上（正是探针里 Shift-Tab Δ0 的成因）。
       * `handleTab` 也一并 try/catch，避免异常冒到 CM6 的事件循环里。
       */
      e.preventDefault();
      e.stopPropagation();
      try {
        this.handleTab(e.shiftKey);
      } catch (err) {
        // 缩进失败不影响焦点保持；记录以便诊断（不弹窗、不打断输入）
        console.error("[CmSourceSurface] Tab 缩进失败:", err);
      }
      /**
       * ## 焦点夺回：必须在 `handleTab` **之后**异步做，且要保留光标
       *
       * ### 为什么需要（实机确证的缺陷）
       * `preventDefault()` 确实被执行且 `defaultPrevented === true`（探针在调用后立刻读到），
       * 事件也 `cancelable`，`contentDOM` 就是 `activeElement`、节点身份一致 —— 但焦点
       * 仍然离开到 `BODY`。对照实验（普通 input、裸 contenteditable 都能被保住）证明
       * 这不是 CDP 局限，而是 **CM6 内部在 keydown 之后另有机制移动焦点**。
       *
       * 因此不依赖"阻止默认行为"这一层，改为**主动夺回**。
       *
       * ### 为什么必须 rAF 而不是同步
       * 同步夺回无效（实测）：焦点移动发生在本次事件分发结束之后，
       * 同步 `focus()` 会被随后的默认行为再次覆盖。放到下一帧才稳。
       *
       * ### 为什么必须保存/恢复选区（**这条是第二次才发现的**）
       * 直接 `contentDOM.focus()` 会把光标**重置到文档开头**（实测：Tab 后
       * `plan.start=15` 正确，但下一次按键 `plan.start=0`）。
       * 后果是 Shift-Tab 拿到 `start=0` → `planSourceOutdent` 判定
       * 「光标前不是纯空白」→ 返回 `kind:none` → **反缩进静默失效**。
       * 所以夺回焦点后必须把 CM6 的 selection 一并写回去。
       */
      const view = this.view;
      if (view) {
        const sel = view.state.selection.main;
        window.requestAnimationFrame(() => {
          const v = this.view;
          if (!v || this.disposed) return;
          const doc = v.contentDOM.ownerDocument;
          if (doc.activeElement === v.contentDOM) return; // 焦点没丢，什么都不做
          v.contentDOM.focus({ preventScroll: true });
          // 焦点恢复后把光标放回原处（等同 "只把焦点还回来，不动编辑状态"）
          try {
            v.dispatch({ selection: { anchor: sel.from, head: sel.to } });
          } catch {
            /* view 已销毁等：忽略 */
          }
        });
      }
    };
    target.addEventListener("keydown", onTabKeydown, true);

    this.cleanupDom.push(() => {
      target.removeEventListener("compositionstart", onStart, true);
      target.removeEventListener("compositionend", onEnd, true);
      target.removeEventListener("keydown", onTabKeydown, true);
    });
  }

  // ── 内容 ────────────────────────────────────────────────────

  getText(): string {
    return this.view?.state.doc.toString() ?? "";
  }

  setText(text: string, opts?: { selection?: SourceSelectionLike; scrollTop?: number }): void {
    const view = this.view;
    if (!view) return;
    /**
     * ⚠️ 相等判定**不能**用 `view.state.doc.toString()`（v0.17.0 性能修复）。
     *
     * 原实现：`if (text === view.state.doc.toString() && !opts?.selection) return;`
     * ——每调用一次就把**全文**序列化成字符串。5MB 文档 = 约 300 万字符的 O(n) 展开。
     *
     * 而这个方法在**每次按键**都会被调用：`sourceContent` 一变化，
     * EditorContainer 的受控写入 effect 就会跑一次（见其注释「比较后再写」）。
     * 于是每键都额外付一次 3MB 字符串构造 + 全量比较 —— 实机 5MB 输入延迟
     * p95=18.0ms 中就有它的份额。
     *
     * 修法：先用**长度**快速排除（`doc.length` 是 O(1)），长度相同再退化到
     * 「与上次本类写入/报告的文本做引用或值比较」——命中就不必展开全文。
     * 只有长度相同且内容来源不明时才真正做全文比较（罕见）。
     */
    const sameLength = text.length === view.state.doc.length;
    if (sameLength && !opts?.selection) {
      // 命中"刚由本类写入过的同一份文本"（引用相等或值相等）→ 直接跳过
      if (text === this.lastProgrammaticText) return;
      // 长度相同但来源不同：这才是唯一需要真正展开全文比较的情形
      if (text === view.state.doc.toString()) return;
    }
    try {
      this.programmaticUpdate = true;
      const tr = view.state.update({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: opts?.selection
          ? { anchor: opts.selection.start, head: opts.selection.end }
          : undefined,
      });
      view.dispatch(tr);
    } finally {
      // 即使 dispatch 因相等被优化掉也要复位，避免下一次用户输入被误标 programmatic
      setTimeout(() => {
        this.programmaticUpdate = false;
      }, 0);
    }
    if (opts?.scrollTop !== undefined) this.setScrollTop(opts.scrollTop);
  }

  // ── 选区与光标 ─────────────────────────────────────────────

  getSelection(): SourceSelectionLike {
    const view = this.view;
    if (!view) return { start: 0, end: 0 };
    // 多光标：返回**主选区**（任务卡口径），kind 仍报 typing
    const main = view.state.selection.main;
    return { start: Math.min(main.from, main.to), end: Math.max(main.from, main.to) };
  }

  setSelection(start: number, end: number): void {
    const view = this.view;
    if (!view) return;
    const len = view.state.doc.length;
    const from = Math.max(0, Math.min(len, start));
    const to = Math.max(0, Math.min(len, end));
    view.dispatch({
      selection: { anchor: from, head: to },
      scrollIntoView: false,
    });
  }

  getScrollTop(): number {
    return this.view?.scrollDOM.scrollTop ?? 0;
  }

  setScrollTop(px: number): void {
    const view = this.view;
    if (!view) return;
    view.scrollDOM.scrollTop = px;
  }

  captureViewportAnchor(): SourceAnchor | null {
    if (!this.layoutAvailable) return null;
    const view = this.view;
    if (!view) return null;
    try {
      const scroller = view.scrollDOM;
      const centerY = view.documentTop + scroller.clientHeight / 2;
      // 视口中央对应的行 → line.from
      const block = view.lineBlockAtHeight(centerY);
      const line = view.state.doc.lineAt(block.from);
      const coords = view.coordsAtPos(block.from);
      return {
        blockIndex: -1,
        ratioWithinBlock: 0,
        textOffset: block.from,
        viewportY: coords ? coords.top - view.documentTop : 0,
        line: line.number - 1,
      } as SourceAnchor;
    } catch {
      return null;
    }
  }

  /**
   * 光标/偏移在**内容坐标系**的 Y（A3-④：打字机与专注遮罩的数据源）。
   *
   * CM6 的 `coordsAtPos` 直接给出视口坐标，减 `documentTop` 即"相对内容顶"，
   * 与 textarea 版的 `measureTextareaCursorY` 同语义 —— 但**不需要 mirror div**
   *（那正是换实现要消掉的东西：mirror 必须与控件排版逐像素对齐，是漂移温床）。
   */
  offsetToContentY(offset?: number): number | null {
    if (!this.layoutAvailable) return null;
    const view = this.view;
    if (!view) return null;
    try {
      const pos = offset === undefined
        ? view.state.selection.main.from
        : Math.max(0, Math.min(view.state.doc.length, offset));
      const coords = view.coordsAtPos(pos);
      if (!coords || !Number.isFinite(coords.top)) return null;
      return coords.top - view.documentTop;
    } catch {
      return null;
    }
  }

  /**
   * 一段字符区间在**内容坐标系**的起止 Y（A3-④：专注模式遮罩）。
   *
   * CM6 用 `coordsAtPos(start)` / `coordsAtPos(end)` 各减 `documentTop`，
   * **不需要 mirror div**（textarea 版必须复刻排版才能测，那是漂移温床）。
   *
   * 两个细节（都容易踩）：
   * 1. **end 要取"区间最后一个字符之后"的位置**：字符区间是闭开的 `[start, end)`，
   *    若直接对 `end` 求坐标，在多行区间里会拿到**下一行行首**的 top，
   *    导致遮罩带比实际行窗高一整行。这里用 `end - 1` 求"最后一字符"的 top，
   *    再取它的 bottom 作为区间底 —— 这样软换行跨行时高度才正确。
   * 2. `coordsAtPos` 越界会抛 → clamp 到文档范围。
   */
  measureRangeContentY(start: number, end: number): { startY: number; endY: number } | null {
    if (!this.layoutAvailable) return null;
    const view = this.view;
    if (!view) return null;
    const docLen = view.state.doc.length;
    const s = Math.max(0, Math.min(docLen, start));
    const e = Math.max(0, Math.min(docLen, end));
    if (!(e > s)) return null;
    try {
      const startCoords = view.coordsAtPos(s);
      // 区间最后一个字符的位置（闭开区间 → end-1）
      const lastCharCoords = view.coordsAtPos(Math.max(s, e - 1));
      if (!startCoords || !lastCharCoords) return null;
      if (!Number.isFinite(startCoords.top) || !Number.isFinite(lastCharCoords.bottom)) return null;
      return {
        startY: startCoords.top - view.documentTop,
        endY: lastCharCoords.bottom - view.documentTop,
      };
    } catch {
      return null;
    }
  }

  /** 恢复锚点（`captureViewportAnchor` 的逆操作） */
  restoreViewportAnchor(anchor: SourceAnchor | null | undefined): void {
    if (!anchor || !this.layoutAvailable) return;
    const view = this.view;
    if (!view) return;
    const off = (anchor as unknown as { textOffset?: number }).textOffset;
    if (off === undefined) return;
    try {
      const coords = view.coordsAtPos(Math.max(0, Math.min(view.state.doc.length, off)));
      if (!coords) return;
      const delta = coords.top - view.documentTop;
      view.scrollDOM.scrollTop += delta;
    } catch {
      /* 布局不可用时不补偿，宿主会退回百分比映射 */
    }
  }

  scrollToOffset(offset: number, opts?: { center?: boolean }): void {
    const view = this.view;
    if (!view) return;
    const pos = Math.max(0, Math.min(view.state.doc.length, offset));
    if (this.layoutAvailable) {
      try {
        view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: opts?.center ? "center" : "start" }) });
        return;
      } catch {
        /* 退化到按行号估算 */
      }
    }
    const line = view.state.doc.lineAt(pos);
    const total = view.state.doc.lines;
    const maxScroll = Math.max(0, view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight);
    view.scrollDOM.scrollTop = ((line.number - 1) / Math.max(1, total - 1)) * maxScroll;
  }

  // ── 编辑事件 ───────────────────────────────────────────────

  /**
   * 订阅滚动（A3：分屏双向联动的左屏一侧）。
   *
   * ⚠️ **必须绑 `view.scrollDOM`** —— CM6 的唯一滚动容器。
   * 绑 `.cm-content`（那是不滚动的编辑区）或 `host`（外层）都收不到滚动事件，
   * 表现为"左屏滚动右屏完全不动"，且没有任何报错。
   */
  onDidScroll(
    listener: (ev: { scrollTop: number; scrollHeight: number; clientHeight: number }) => void,
  ): () => void {
    const view = this.view;
    if (!view) return () => {};
    const scroller = view.scrollDOM;
    const handler = () => {
      listener({
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
      });
    };
    scroller.addEventListener("scroll", handler, { passive: true });
    this.scrollCleanups.push(() => scroller.removeEventListener("scroll", handler));
    return () => {
      scroller.removeEventListener("scroll", handler);
    };
  }

  /** 滚动订阅清理（destroy 时统一解绑，防 view 销毁后残留引用泄漏） */
  private scrollCleanups: Array<() => void> = [];

  /** 宿主级事件处理（A3：CM6 下 Tab/粘贴/右键必须接到 .cm-content 上） */
  private domHandlers: SourceDomEventHandlers = {};
  private readonly domHandlersCompartment = new Compartment();

  /**
   * 挂接宿主级事件（A3 装配修复）。
   *
   * CM6 编辑区是内部 contenteditable（`.cm-content`），React 的 `onKeyDown` 等
   * **绑不到它** —— 这就是"CM6 下 Tab 不缩进、粘贴无效、右键菜单不出"的根因。
   *
   * 实现走 `EditorView.domEventHandlers`，是 CM6 官方提供的事件接入点
   * （比在 `.cm-content` 上手动 addEventListener 更稳：CM6 重绘/替换 contentDOM 时
   * 会自动保留这些 handler）。
   *
   * ⚠️ handlers 必须存成字段并在 `buildExtensions()` 里引用同一个对象 ——
   * `setDomEventHandlers` 可能在 mount 之后才被调用（React effect 顺序），
   * 闭包捕获 `this.domHandlers` 才能读到最新值。
   */
  setDomEventHandlers(handlers: SourceDomEventHandlers): void {
    this.domHandlers = handlers;
    // 已挂载时需重建扩展才生效
    if (this.view) {
      try {
        this.view.dispatch({ effects: this.domHandlersCompartment.reconfigure(this.buildDomHandlerExt()) });
      } catch {
        /* view 可能已销毁 */
      }
    }
  }

  /** 把 SourceDomEventHandlers 包装成 CM6 的 domEventHandlers 扩展 */
  private buildDomHandlerExt() {
    const toKeyLike = (e: KeyboardEvent): SourceKeyEventLike => ({
      key: e.key,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
      isComposing: e.isComposing,
      keyCode: e.keyCode,
      nativeEvent: e,
      preventDefault: () => e.preventDefault(),
      stopPropagation: () => e.stopPropagation(),
    });
    return EditorView.domEventHandlers({
      keydown: (e) => {
        /**
         * ## v0.17.0 修复：Tab / Shift-Tab 必须**显式** `preventDefault()`
         *
         * ### 缺陷（实机探针确证，v0.15.6 口径回归）
         * ```
         * PASS [2] Tab 在行首插入缩进单位 — Δ2      ← 缩进本身生效
         * FAIL [3] Tab 后焦点仍在编辑器内 — 焦点=BODY  ← 焦点逃逸到 body
         * FAIL [4] Shift-Tab 反缩进 — Δ0            ← 反缩进完全无效
         * ```
         * `handleTab` 确实被调用且返回 `true`（缩进 Δ2 证明它跑了），
         * 但浏览器仍执行了 Tab 的**默认焦点移动** → 焦点离开编辑区 →
         * 后续 Shift-Tab 落到 body 上，`handleTab(true)` 根本没机会跑（Δ0）。
         *
         * ### 根因（CM6 源码机制）
         * CM6 的 keymap 本身是 `Prec.default(EditorView.domEventHandlers({...}))`，
         * handler 返回 true 时**由 `runHandlers` 统一 `preventDefault()`**。
         * 但我们的 keymap 用 `Prec.highest` 提到了**更高优先级** —— 它先于
         * CM6 那层 domEventHandlers 消费掉事件并返回 true，`runHandlers` 的
         * preventDefault 分支因此没轮到我们这条绑定。
         * CM6 的原生 Tab 缩进靠 `indentWithTab`（**我们刻意未装**，因为 Tab 要归
         * `handleTab` 做 ghost 采纳/配对跳出/缩进三态），所以也没有现成的
         * preventDefault 路径兜底。
         *
         * ### 修法
         * 在我们自己的 `domEventHandlers.keydown` 里**显式阻止** Tab 系列键的默认行为。
         * 这一层我们有完整控制权（`e` 是原生事件），且必须在转发给宿主之前做 ——
         * 否则宿主的 `handleSourceKeyDown` 可能再次消费并改变判断。
         *
         * 注意：**只拦 Tab 系列**。其它键的 preventDefault 语义保持原样
         *（宿主 React 风格 handler 会用 `preventDefault` 表达"已处理"，见下方判定）。
         */
        const h = this.domHandlers.onKeyDown;
        if (!h) return false;
        /**
         * ⚠️ 这里**不能只看返回值**判断"是否已处理"。
         *
         * 宿主的 `handleSourceKeyDown` 是 React 风格：处理时调 `e.preventDefault()` 然后
         * 裸 `return`（返回 undefined），**从不返回 true**。若我们按 `=== true` 判断，
         * 所有已处理的键都会被当成"未处理" → 交回 CM6 再处理一次 →
         * **Tab 会缩进两次、Esc 关两次 ghost**。
         *
         * 正确判据：**返回值是 `true`，或者事件已被 `preventDefault()`**。
         */
        const before = e.defaultPrevented;
        const ret = h(toKeyLike(e));
        return ret === true || (!before && e.defaultPrevented);
      },
      paste: (e) => {
        const h = this.domHandlers.onPaste;
        if (!h) return false;
        // 同 keydown：宿主是 React 风格，已处理的表现是 preventDefault，不是返回 true
        const before = e.defaultPrevented;
        const ret = h({
          clipboardData: e.clipboardData,
          preventDefault: () => e.preventDefault(),
          stopPropagation: () => e.stopPropagation(),
        });
        return ret === true || (!before && e.defaultPrevented);
      },
      contextmenu: (e) => {
        const h = this.domHandlers.onContextMenu;
        if (!h) return false;
        const before = e.defaultPrevented;
        const ret = h({
          clientX: e.clientX,
          clientY: e.clientY,
          target: e.target,
          preventDefault: () => e.preventDefault(),
          stopPropagation: () => e.stopPropagation(),
        });
        return ret === true || (!before && e.defaultPrevented);
      },
    });
  }

  onDidChange(listener: (ev: SourceChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 落地一次离散编辑（配对 / 缩进 / Tab 跳出 / 格式化 / AI 回写）。
   *
   * **单事务**：一次 dispatch = 一次撤销步。这是 CM6 相对 textarea 的核心优势 ——
   * 不需要 `document.execCommand` 那个"制造一次原生 input 事件"的 workaround。
   */
  applyEdit(plan: SourceEditPlan): void {
    if (plan.kind !== "edit") return;
    const view = this.view;
    if (!view) return;
    const { from, to, text, caret, caretEnd } = plan.edit;
    const len = view.state.doc.length;
    const f = Math.max(0, Math.min(len, from));
    const t = Math.max(0, Math.min(len, to));
    this.pendingApplyEdit = true;
    view.dispatch({
      changes: { from: f, to: t, insert: text },
      selection: {
        anchor: Math.max(0, Math.min(len, caret)),
        head: Math.max(0, Math.min(len, caretEnd ?? caret)),
      },
      // 标记为"离散编辑"，宿主据此把一次补全归为一步
      userEvent: "input.pair",
    });
  }

  // ── Tab 接管（硬约束 2）──────────────────────────────────────

  /**
   * Tab / Shift-Tab 处理。
   *
   * 优先级（任务卡要求）：**AI ghost 采纳 > 配对跳出 > 缩进**。
   * - ghost 采纳与配对跳出由宿主通过 `takeOverTab` 钩子注入（它们在宿主手里，
   *   ghost 状态在 AiAssistPane / ghost 字段里；本实现不复制这些状态）；
   * - 都没有时执行缩进（`planSourceIndent` / `planSourceOutdent`，纯函数原样复用）。
   *
   * @returns true = 已处理（阻止默认）；false = 不处理，让事件继续传播
   */
  private handleTab(outdent: boolean): boolean {

    const tabInterceptor = this.tabInterceptor;
    if (tabInterceptor) {
      const handled = tabInterceptor(outdent);
      if (handled) return true;
    }
    const view = this.view;
    if (!view) return false;
    const value = view.state.doc.toString();
    const sel = view.state.selection.main;
    const unit = this.indentUnit;
    const input = { value, start: Math.min(sel.from, sel.to), end: Math.max(sel.from, sel.to), unit };
    const plan = outdent ? planSourceOutdent(input) : planSourceIndent(input);
    if (plan.kind === "none") return false;
    this.applyEdit(plan);
    return true;
  }

  /**
   * 宿主注入的 Tab 拦截器（AI ghost 采纳 / 配对跳出）。
   *
   * 为什么要留这个钩子而不是把 ghost 状态搬进本类：ghost 的**状态与判定**属于
   * AiAssistPane（它有 `sourceGhostActiveRef` / `formatGhostRef` 等），
   * 搬到 Surface 会制造第二份事实源。Surface 只负责"Tab 被按下时先问一句"。
   */
  private tabInterceptor: ((outdent: boolean) => boolean) | null = null;

  /** 设置 Tab 拦截器（宿主在 AiAssistPane / SourcePane 挂载后注入） */
  setTabInterceptor(fn: ((outdent: boolean) => boolean) | null): void {
    this.tabInterceptor = fn;
  }

  /** 缩进单位（由宿主按设置同步；默认两个空格，与既有 `indentUnitString` 缺省一致） */
  private indentUnit = "  ";
  setIndentUnit(unit: string): void {
    this.indentUnit = unit;
  }

  // ── 度量（A3：coordsAtPos 取代 mirror）─────────────────────

  /**
   * 顶层块起始行的实测行盒顶部。
   *
   * **A3 的核心替换点**：textarea 版必须建一个 mirror div 逐行测量（见
   * `blockScrollAlign.measureSourceLineAxis`）；CM6 直接 `coordsAtPos` 拿到每行的
   * 真实视口位置，**不需要 mirror**，也不再受"mirror 排版必须与控件逐像素对齐"约束。
   */
  measureBlockTops(blockLines: number[]): number[] | null {
    if (!this.layoutAvailable) return null;
    const view = this.view;
    if (!view) return null;
    try {
      /**
       * ## 为什么用 `lineBlockAt` 而不是 `coordsAtPos`（这是 R2 的具体处置）
       *
       * 设计稿 R2 警告：CM6 的**虚拟视口之外**未渲染的行，`coordsAtPos` 结果不稳
       * （可能返回 null 或退化的 0 高度）。而分屏对齐恰恰需要**整篇所有块起始行**的
       * 顶部 —— 大文档里绝大多数块都在视口外，直接逐行 `coordsAtPos` 会大面积失败，
       * 表现为"对齐随机不准"，而根因是测量失败（不是对齐算法坏了）。
       *
       * `view.lineBlockAt(pos)` 走的是 CM6 的**行高估算表**（heightMap），
       * 它对整个文档都可用（视口内是实测高、视口外是估算高），且返回的 `top`
       * 是相对文档顶的累计值 —— 正是分屏对齐要的"行 → 像素顶部"。
       * 代价：视口外的行是**估算**而非实测（行高不一致时略偏），这比"测不到返回 null
       * 退回百分比"好得多（百分比在软换行长行上会偏 4 倍，见旧注释）。
       *
       * 兜底顺序：lineBlockAt（全文档可用）→ 若该行块高度为 0（未测且不可估）
       * 则该点记 NaN，由 `buildSourceLineAxis` 过滤，最终由上层决定是否降级。
       */
      const doc = view.state.doc;
      const total = doc.lines;
      const tops = blockLines.map((lineNo) => {
        const n = Math.max(1, Math.min(total, Math.floor(lineNo) + 1));
        const line = doc.line(n);
        const block = view.lineBlockAt(line.from);
        if (!block || !Number.isFinite(block.top)) return Number.NaN;
        // 视口内优先用实测（coordsAtPos）修正估算偏差；视口外保留估算。
        try {
          const coords = view.coordsAtPos(line.from);
          if (coords && Number.isFinite(coords.top)) {
            return coords.top - view.documentTop;
          }
        } catch {
          /* 视口外/不可测：保留 lineBlockAt 的估算值 */
        }
        return block.top;
      });
      return tops.some((t) => Number.isFinite(t)) ? tops : null;
    } catch {
      return null;
    }
  }

  getMetrics(): SourceMetrics {
    const view = this.view;
    if (!view) return { totalLines: 0, scrollHeight: 0, clientHeight: 0, clientWidth: 0 };
    return {
      totalLines: view.state.doc.lines,
      scrollHeight: view.scrollDOM.scrollHeight,
      clientHeight: view.scrollDOM.clientHeight,
      clientWidth: view.scrollDOM.clientWidth,
    };
  }

  isComposing(): boolean {
    return this.composing;
  }

  // ── 搜索高亮 ───────────────────────────────────────────────

  setSearchRanges(ranges: SearchRange[]): void {
    this.searchRanges = ranges;
    const view = this.view;
    if (!view) return;
    view.dispatch({ effects: setSearchEffect.of(ranges) });
  }

  clearSearchRanges(): void {
    this.setSearchRanges([]);
  }

  // ── ghost ───────────────────────────────────────────────────

  showGhost(ghost: { text: string; pos: number; tail?: string; maskTail?: boolean }): void {
    this.ghost = ghost;
    const view = this.view;
    if (!view) return;
    view.dispatch({ effects: setGhostEffect.of(ghost) });
  }

  clearGhost(): void {
    this.ghost = null;
    const view = this.view;
    if (!view) return;
    view.dispatch({ effects: setGhostEffect.of(null) });
  }

  // ── 焦点 ───────────────────────────────────────────────────

  focus(): void {
    this.view?.focus();
  }

  isFocused(): boolean {
    return !!this.view?.hasFocus;
  }


  // ── 运行时重配（避免重建 view）───────────────────────────────

  /** 只读状态（任务卡 A1 ④） */
  setReadOnly(readOnly: boolean): void {
    const view = this.view;
    if (!view) return;
    view.dispatch({
      effects: this.readOnlyCompartment.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }

  /** 字号缩放（任务卡 A1 ①：走 theme，**禁用 CSS zoom**） */
  setFontSize(px: number): void {
    const view = this.view;
    if (!view) return;
    view.dispatch({
      effects: this.themeCompartment.reconfigure(
        EditorView.theme({
          "&": { height: "100%", fontSize: `${px}px` },
          ".cm-scroller": { overflow: "auto" },
        }),
      ),
    });
  }

  /** spellcheck（任务卡 A1 ②：走 contentAttributes） */
  setSpellcheck(enabled: boolean): void {
    const view = this.view;
    if (!view) return;
    view.dispatch({
      effects: this.attrsCompartment.reconfigure(
        EditorView.contentAttributes.of({ spellcheck: enabled ? "true" : "false" }),
      ),
    });
  }

  /** 粘贴 / 拖拽意图标记（A2：kind="paste"，修复 C14 第三处） */
  markPasteIntent(): void {
    this.pendingPaste = true;
  }
}

// 保留 `buildSourceLineAxis` 的引用语义说明：本实现在 `measureBlockTops` 给出
// 「行 → 顶部」原始数据，行轴构建仍由宿主的 `buildSourceLineAxis`（纯函数，不动）完成。
void buildSourceLineAxis;
// 同上：textarea 版的锚点纯函数在 CM6 下由 coordsAtPos 取代，但纯函数本身保留
// （textarea 回退实现仍在用，且其单测是回归护栏的一部分）。
void captureTextAnchor;
void restoreTextAnchor;
