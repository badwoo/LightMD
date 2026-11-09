/**
 * src/editor/types.ts —— 编辑器抽象层契约（v0.17.0 P0-2 冻结）
 *
 * ## 职责边界
 *
 * 本文件**只放类型**，不含任何实现、不 import 任何运行时模块（全部 `import type`）。
 * 它定义两个面：
 *
 * - `SourceSurface`：源码编辑面（textarea 参考实现 → 未来 CM6 实现）；
 * - `SourceChangeEvent`：源码面每次编辑向上报告的事件（含输入意图 kind）。
 *
 * ## 为什么要有这层
 *
 * P0 之前，`EditorContainer.tsx` 直接 `import` textarea 的 DOM 细节
 * （`sourceTextareaRef`、`textarea.value`、`selectionStart/End`、`execCommand`、
 * `measureSourceLineAxis(textarea)`…），共 79 处直接读 ref。这使「换成 CM6」
 * 不是替换一个模块，而是重写整个容器。SourceSurface 把这些调用点收敛成一个
 * 接口，A 线（CM6）只需再实现一份，容器与各 pane 一行不用改。
 *
 * 接口的每个方法都对应现状一个**真实调用点**（不是理想化设计）：
 *
 * | 方法 | 现状调用点 |
 * |---|---|
 * | `getText` / `setText` | `sourceContent` state 同步、模式切换整篇同步 |
 * | `getSelection` / `setSelection` | `lastTextareaCursorRef`、`pendingSourceSelectionRef` |
 * | `getScrollTop` / `setScrollTop` | `lastSourceScrollTopRef`、`scrollFreezeRef` |
 * | `captureViewportAnchor` | `captureTextAnchor(ta, clientHeight/2)`（预览开合补偿） |
 * | `scrollToOffset` | 搜索跳转、撤销恢复 |
 * | `onDidChange` | `handleSourceChange`（diff 撤销栈 + 统一时间线） |
 * | `applyEdit` | `applySourcePairPlan`（配对 / 缩进 / Tab 跳出） |
 * | `measureBlockTops` | `measureSourceLineAxis`（分屏对齐块几何） |
 * | `getMetrics` | `sourceCursorRafRef` / 滚动百分比 / 行轴缓存键 |
 * | `isComposing` | IME 组合态守卫（Backspace/Tab 分支） |
 * | `setSearchRanges` | `SearchReplace` 的源码 overlay |
 * | `showGhost` / `clearGhost` | AI 续写 ghost、格式 ghost overlay |
 * | `focus` / `isFocused` | 圆括号自动跳出、spellcheck 重检 |
 * | `legacyTextareaRef` | `SearchReplace.tsx` 现有 `sourceTextareaRef` prop（过渡能力） |
 *
 * ⚠️ 依赖方向：`components/editor/**` → 本文件 ← `editor/surface/**`。
 * 容器与 pane **只能**依赖本接口，不得 import `TextareaSourceSurface` 具体实现。
 */

import type { ContentAnchor } from "../utils/contentScrollMap";
import type { SourcePairPlan } from "../utils/sourceAutoPair";

// ────────────────────────────────────────────────────────────────
// 内容锚点 / 选区 / 编辑计划
// ────────────────────────────────────────────────────────────────

/**
 * 源码面的视口中央内容锚点（模式切换、预览开合、排版变化时保持"眼前内容"）。
 *
 * 直接复用 `utils/contentScrollMap` 的 `ContentAnchor`：它已经是"块序号 + 块内比例 +
 * 可选行号"的既有口径，模式切换的恢复链路按该结构反算，换成别的形状会引入第二套
 * 语义。CM6 实现用 `coordsAtPos` 构造它的 `line`/`blockIndex` 字段即可。
 */
export type SourceAnchor = ContentAnchor;

/** 源码面选区（masked UTF-16 坐标，与 `SourceSelection.start/end` 同一口径） */
export interface SourceSelectionLike {
  start: number;
  end: number;
}

/**
 * 一次"离散编辑"计划（配对补全 / 缩进 / 格式化 / AI 回写）。
 *
 * `SourcePairPlan` 是 `utils/sourceAutoPair` 与 `utils/sourceIndent` 规划器的既有返回类型。
 * 实现方（textarea）负责把它落成**单事务单步**（一次撤销 = 一次补全），
 * 这正是 v0.16.0 需求4 的硬要求（`applySourcePairPlan` 用 execCommand 达成的效果）。
 */
export type SourceEditPlan = SourcePairPlan;

/** 源码面实测度量（行轴缓存键 + 滚动百分比计算的输入） */
export interface SourceMetrics {
  /** 总行数（`text.split("\n").length`） */
  totalLines: number;
  /** 内容总高度（px） */
  scrollHeight: number;
  /** 视口高度（px） */
  clientHeight: number;
  /** 视口宽度（px） */
  clientWidth: number;
}

// ────────────────────────────────────────────────────────────────
// 挂载选项
// ────────────────────────────────────────────────────────────────

export interface SourceSurfaceOptions {
  /** 初始展示文本（masked）。CM6 用它建 doc；textarea 实现用它同步 value */
  initialText: string;
  /** 只读（同一文件在其他窗口有未保存修改时"只读打开"） */
  readOnly?: boolean;
  /** 独立撤销栈由宿主管理（Surface 不内置 undo 语义，只负责报告变更） */
  disableNativeUndo?: boolean;
}

// ────────────────────────────────────────────────────────────────
// 变更事件
// ────────────────────────────────────────────────────────────────

/**
 * 源码面一次编辑的完整事件。
 *
 * ## `kind` 为什么是必需的（这是 v0.15.0 起就存在的存量缺陷的修复点）
 *
 * 现状 `EditorContainer` 声明了 `sourceComposingRef` / `sourceJustPairedRef` /
 * `sourceJustPastedRef` 三个"一次性标记"，但**全文件没有任何置 true 的路径**
 * （实测：3 处声明 @1830-1832、3 处读取 @2996-2998、2 处清零 @3011-3012，
 * composition 甚至没清零）。于是 IME / 配对 / 粘贴三类"一步归并"从未生效，
 * 全部落回 `inferSourceEditKind` 的**文本形态猜测** —— 猜测必然误判
 * （例如"I" 与 "l" 形态相似、粘贴后立即打字会被当成连续 typing 合并）。
 *
 * 因此契约要求**事件携带 kind**，由实现方在事件源头判定：
 * - `ime`：composition 事件（同一 `compositionGroupId` 的多事件归一步）；
 * - `pair`：经 `applyEdit` 落地的补全（调用方已知这是离散编辑）；
 * - `paste`：粘贴（一次粘贴 = 一步，不与后续打字合并）；
 * - `delete`：删除类意图（Backspace / Delete / 剪切）；
 * - `typing`：其余普通输入（同 kind + 时间窗内可合并）。
 */
export type SourceChangeKind = "typing" | "ime" | "pair" | "paste" | "delete";

/** 宿主级事件处理（键位/粘贴/右键）。字形接近 React 事件，便于复用同一处理函数。 */
export interface SourceDomEventHandlers {
  onKeyDown?(e: SourceKeyEventLike): boolean | void;
  onPaste?(e: SourceClipboardEventLike): boolean | void;
  onContextMenu?(e: SourceMouseEventLike): boolean | void;
}

/** 键位事件的最小契约（textarea 与 CM6 都能提供） */
export interface SourceKeyEventLike {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  /** IME 组合态（部分输入法组合期 isComposing=false 但 keyCode=229） */
  isComposing: boolean;
  keyCode: number;
  nativeEvent: Event;
  preventDefault(): void;
  stopPropagation(): void;
}

export interface SourceClipboardEventLike {
  clipboardData: { getData(type: string): string } | null;
  preventDefault(): void;
  stopPropagation(): void;
}

export interface SourceMouseEventLike {
  clientX: number;
  clientY: number;
  target: EventTarget | null;
  preventDefault(): void;
  stopPropagation(): void;
}

export interface SourceChangeEvent {
  /** 编辑后展示文本（masked，= `getText()` 同一坐标系） */
  text: string;
  /** 编辑后选区 */
  selection: SourceSelectionLike;
  /** 编辑后视口滚动位置（px；供 SourceSelection.scrollTop 与进度恢复） */
  scrollTop: number;
  /** 输入意图。见 `SourceChangeKind` 的说明：必须由实现方在源头判定，不得靠文本形态猜 */
  kind: SourceChangeKind;
  /**
   * 组合会话 id：同一 `compositionstart`→`compositionend` 周期内的多个事件共享同一 id。
   *
   * 供 `sourceAdapter` 显式设 `groupId`（现状靠 `inferSourceEditKind` 的时间窗猜测，
   * 会把"打完拼音立刻打字"误合并）。仅 `kind === "ime"` 时有意义。
   */
  compositionGroupId?: string;
  /**
   * 触发本次变更的输入源（诊断用，可选）。
   *
   * `"dom"` = 浏览器原生输入（input/textarea 默认行为）；
   * `"programmatic"` = 经 `applyEdit` / `setText` 落地。宿主据此跳过不必要的
   * change 处理（例如 `setText` 引起的整篇替换不应进 diff 撤销栈）。
   */
  origin?: "dom" | "programmatic";
}

// ────────────────────────────────────────────────────────────────
// SourceSurface 接口
// ────────────────────────────────────────────────────────────────

/**
 * 源码编辑面的统一契约。CM6 与回退 textarea 各出一个实现。
 *
 * 实现约定（每个方法都必须满足，否则 A 线迁移会踩隐性坑）：
 *
 * 1. **坐标系**：所有 offset 都是**展示文本（masked）**的 UTF-16 偏移，与
 *    `sourceContent` / `sourceContentRef` 同一坐标系。真实文本（unmask 后）
 *    归宿主管（`base64TokensRef`），Surface 不感知 mask 语义。
 * 2. **不内置撤销**：Surface 只**报告**变更（`onDidChange`），撤销归
 *    `documentHistory` / `editorHistory` 时间线。textarea 实现故意用
 *    `execCommand("insertText")` 触发原生 input 事件正是为了"一条落地 = 一次 onChange"，
 *    而不是为了让浏览器管撤销栈。
 * 3. **不感知 React**：接口方法都是命令式的，实现内部可持有 DOM ref；
 *    宿主负责在 effect 里调用，不得在 render 期调用（`measureBlockTops` 除外，
 *    它本身是纯测量）。
 */
export interface SourceSurface {
  // ── 生命周期 ────────────────────────────────────────────────

  /** 挂载（容器 div；CM6 建 EditorView，textarea 实现建/接管 textarea） */
  mount(host: HTMLElement, opts: SourceSurfaceOptions): void;
  /** 卸载并释放监听器（**不**清空宿主文本） */
  destroy(): void;

  // ── 内容（masked 展示坐标）────────────────────────────────

  /** 当前展示文本（= `sourceContentRef` 同一坐标系：base64 已 mask） */
  getText(): string;
  /**
   * 整篇替换（模式切换同步 / 撤销落地 / AI 回写 / 搜索替换）。
   *
   * 实现必须把它当作**程序化替换**上报（`SourceChangeEvent.origin === "programmatic"`），
   * 否则宿主会把"模式切换同步"误记成一条用户编辑。
   */
  setText(text: string, opts?: { selection?: SourceSelectionLike; scrollTop?: number }): void;

  // ── 选区与光标（masked UTF-16 坐标）────────────────────────

  getSelection(): SourceSelectionLike;
  setSelection(start: number, end: number): void;
  /** 视口滚动位置（px，供 SourceSelection.scrollTop 与进度恢复） */
  getScrollTop(): number;
  setScrollTop(px: number): void;

  /**
   * 视口中央内容锚点（模式切换 / 预览开合用）。
   *
   * CM6 用 `coordsAtPos` 构造；textarea 复用 `utils/viewportAnchor.captureTextAnchor`
   * （现状在 `captureSourceContentAnchor` 里就是包它）。内容不足一屏 / 空文本时返回 null。
   */
  captureViewportAnchor(): SourceAnchor | null;

  /**
   * 光标（或指定偏移）在**内容坐标系**里的 Y 像素位置（A3：专注模式/打字机）。
   *
   * 语义与 `utils/focus-paragraph.measureTextareaCursorY(ta, pos)` 一致：
   * 返回「该偏移相对**文档内容顶部**的 Y」（不含 scrollTop），供打字机计算居中目标
   * 与专注遮罩绘制。
   *
   * 为什么要收进接口：现状源码面的打字机**只有 mirror 一条路**
   *（`measureTextareaCursorY` 建 mirror div 复刻排版）。CM6 下 `coordsAtPos` 能直接
   * 给出真实坐标，不需要 mirror —— 这正是 A3-④「数据源换 scrollDOM/coordsAtPos，
   * 机制照搬」的落点。切到 CM6 后 mirror 那条路对源码面不再需要。
   *
   * @param offset 字符偏移（缺省 = 当前主选区光标）
   * @returns 内容坐标 Y；布局不可用/越界时返回 null（调用方跳过居中，不写 0）
   */
  offsetToContentY(offset?: number): number | null;

  /**
   * 一段字符区间在**内容坐标系**里的起止 Y（A3-④：专注模式遮罩）。
   *
   * 语义与 `utils/focus-paragraph.measureTextareaRangeY(ta, start, end)` 一致：
   * 返回 `{ startY, endY }`（相对**文档内容顶部**，不含 scrollTop）。
   *
   * 为什么单点能力（`offsetToContentY`）不够：专注模式要画的是一条**连续行区间的
   * 遮罩带**（光标行 ±1 行，`findFocusRowRange` 给的是 `[start, end)` 字符区间），
   * 用两个单点拼是错的 —— 软换行时区间中间可能跨行，两端点的 Y 之差 != 区间高度。
   *
   * @returns 布局不可用/区间无效时返回 null（调用方走"屏幕中央 3 行窗"兜底，
   *          这是既有行为，不能改成"不画遮罩"）
   */
  measureRangeContentY(start: number, end: number): { startY: number; endY: number } | null;

  /** 滚动到某字符偏移附近（搜索跳转 / 撤销恢复） */
  scrollToOffset(offset: number, opts?: { center?: boolean }): void;

  // ── 编辑事件 ───────────────────────────────────────────────

  /**
   * 实现标识（A3 装配修复）。
   *
   * **宿主必须据此决定渲染什么元素**：
   * - `"textarea"` → 渲染**受控 `<textarea>`**（React 管内容，值经 `value` 同步）；
   * - `"cm6"` → 渲染**中性 `<div>`**，绝不能渲染受控 textarea ——
   *   受控 `<textarea>` 的 `value` 让 React 认为"这个节点的内容由我管"，
   *   后续任何 re-render 都会重写它的子节点，**把 CM6 注入的 `.cm-editor` 清掉**。
   *
   * 实机探针实测：CM6 mount 成功后约 2.5s（首次 state 变化）被抹掉，
   * 且 `destroy()` 从未被调用（是 React 覆写，不是我们销毁）。
   * 这是 v0.17.0 的头号缺陷，也是 jsdom 全量测试**永久掩盖**的盲区
   * （jsdom 下工厂一律回退 textarea，CM6 装配路径从未被执行）。
   */
  readonly impl: "textarea" | "cm6";

  /**
   * 挂接**宿主级 DOM 事件处理**（A3 装配修复：CM6 路径）。
   *
   * 为什么需要：宿主原先靠 JSX 的 `onKeyDown` / `onPaste` / `onContextMenu` 绑事件，
   * 这些**只对真实 textarea 生效**。CM6 渲染的是内部 `.cm-content`（contenteditable），
   * React 事件绑不到它 → **CM6 下 Tab 缩进、粘贴、右键菜单全部失效**。
   *
   * 实现约束：
   * - CM6 → 通过 `EditorView.domEventHandlers` 注册到 view（重挂载时需保留）；
   * - textarea → 绑定元素事件（与 JSX 行为等价）。
   *
   * 回调签名刻意接近 React 事件（`target.value` / `key` / `preventDefault`），
   * 便于宿主复用同一份处理函数，避免"CM6 一套、textarea 一套"分叉。
   */
  setDomEventHandlers(handlers: SourceDomEventHandlers): void;

  /** 订阅变更。返回取消订阅函数（宿主在 effect cleanup 里调用） */
  onDidChange(listener: (ev: SourceChangeEvent) => void): () => void;

  /**
   * 订阅**滚动**（A3：分屏双向联动）。
   *
   * 为什么必须是能力而不是让宿主自己 `addEventListener`：
   * - textarea 实现绑元素 `scroll`；
   * - CM6 实现必须绑 **`view.scrollDOM`**（CM6 的单滚动容器；绑 `.cm-content` 或
   *   `.cm-scroller` 之外的节点都收不到滚动）—— 宿主无法知道该绑哪个节点。
   *
   * 回调带 `scrollTop / scrollHeight / clientHeight` 三个值：分屏映射要算比例，
   * 只给 scrollTop 不够。
   *
   * ⚠️ 订阅者（`PreviewPane` 的双向联动）**必须继续走既有的
   * `createScrollDirectionLock` 时间窗方向锁** —— 那个防拉扯机制不能因为换数据源而丢：
   * 浏览器对 `scrollTop = x` 派发的 scroll 事件是异步的，同步期的标志到那时已清除，
   * 两屏会互推、停在随机位置（v0.13.2 实测）。
   */
  onDidScroll(
    listener: (ev: { scrollTop: number; scrollHeight: number; clientHeight: number }) => void,
  ): () => void;

  /**
   * 落地一次"离散编辑"（配对 / 缩进 / Tab 跳出 / 格式化 / AI 回写）。
   *
   * 硬要求：**单事务单步** —— 用户按一次 `(` 得到 `()` 时，撤销栈里只能有一步。
   * textarea 实现通过 `document.execCommand("insertText")` 达成（浏览器把整段
   * 替换当一次输入事件）；CM6 实现用单个 `dispatch`。
   */
  applyEdit(plan: SourceEditPlan): void;

  // ── 度量（分屏对齐 C8）─────────────────────────────────────

  /**
   * 顶层块起始行的实测行盒顶部（替代 `measureSourceLineAxis` 的 mirror 容器）。
   *
   * 入参是升序行号数组，返回与之一一对应的 px 顶部数组；无法测量时返回 null
   * （调用方退回百分比映射）。CM6 实现用 `coordsAtPos` 逐行测量，不再需要 mirror。
   */
  measureBlockTops(blockLines: number[]): number[] | null;

  /** 总行数与内容/视口尺寸（行轴缓存键） */
  getMetrics(): SourceMetrics;

  /** 输入法组合态（CM6 `compositionend` / textarea `compositionstart` 的原生事件口径） */
  isComposing(): boolean;

  // ── 搜索高亮（C13）──────────────────────────────────────────

  /** 设置搜索命中区间（`active` 为当前命中，需与其它命中区分高亮） */
  setSearchRanges(ranges: Array<{ start: number; end: number; active?: boolean }>): void;
  clearSearchRanges(): void;

  // ── ghost（C13b：AI 续写 / 格式占位）────────────────────────

  /**
   * 显示 ghost 占位（AI 续写 / 格式提示，**不写入文档**）。
   *
   * `text` 为要显示的建议文本；`pos` 为落点偏移；`tail` 需要额外接上的遮蔽尾巴
   * （部分场景要在建议后补 `\n`）；`maskTail` 为 true 时该尾巴按 mask 处理。
   */
  showGhost(ghost: { text: string; pos: number; tail?: string; maskTail?: boolean }): void;
  clearGhost(): void;

  // ── 焦点 ───────────────────────────────────────────────────

  focus(): void;
  isFocused(): boolean;

  // ── 过渡能力（仅 textarea 参考实现提供）──────────────────────

}
