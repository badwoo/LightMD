/**
 * v0.15.0 需求2（R2 阅读区标题折叠）：**DOM / ProseMirror 渲染适配层**。
 *
 * 纯逻辑（标题收集、折叠区间、状态迁移）在 `src/utils/headingFold.ts`；
 * 本层只负责把「折叠状态」画到两个阅读面上，并**绝不触碰文档**：
 *
 * | 面 | 做法 | 为什么 |
 * |---|---|---|
 * | 阅读态 ProseMirror（`viewMode === "preview"`） | `Decoration.node` 加 class/`data-lmd-fold-hidden`；标题加 `Decoration.widget` 折叠按钮 | **不能直接改 PM 管理的 DOM 属性**：`Outline.tsx` 已有实测先例——给标题写 `id` 属性会被 PM 的 MutationObserver 捕获 → `markDirty → updateState` → DOM 整节点重建，阅读模式每次按键闪一次。Decoration 是 PM 自己管理的属性通道，零 mutation。 |
 * | 编辑模式右侧 iframe 预览 | 直接给顶层元素注入同一组 `data`/class + `<button>` | iframe 不是 PM 文档，只能 DOM 注入；复用 `tagWhenBodyReady` 的幂等重贴纪律（body 未就绪时 0/160/480ms + load 重试）。 |
 *
 * ## 三条硬纪律（设计冻结稿 §2.1 / §2.4）
 * 1. **折叠只是 `display:none`**：不 `delete/replace` 节点、不改 doc、不写 Markdown、
 *    不产生撤销历史。折叠操作只 dispatch **空事务**（仅用于刷新装饰）。
 * 2. 状态只存 `docKey + headingId`（会话内），**跨渲染面只用 id 对齐**：
 *    PM 的顶层块下标含"空行还原的空段落 + 末尾垫段落"，iframe 的顶层元素不含，
 *    所以块下标不能共享，id 才是唯一共同键。
 * 3. 状态变化后用标题 id 复算（`reconcileFoldState`），标题被删/改文本即自动清理。
 */

import { Plugin } from "prosemirror-state";
import type { EditorState } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { t } from "../../i18n/state";
// 与 iframe 贴 `data-src-line` 共用**同一个**「正文内容元素」判定（不复制粘贴：
// 两处口径一旦漂移，折叠块下标与行号贴标就会错位）
import { isAnchorablePreviewChild } from "../../utils/blockScrollAlign";
// 本模块专属样式（不动 editor.css 这个多人共用热点文件）
import "../../styles/readingFold.css";
import {
  collectDocChildBlocks,
  collectHeadings,
  expandAll as expandAllFold,
  expandAncestors,
  foldableHeadingIds,
  hiddenBlockIndexes,
  reconcileFoldState,
  toggleFold,
  type FoldBlock,
  type FoldState,
  type HeadingInfo,
} from "../../utils/headingFold";

/** 折叠隐藏块的 class（样式见 `src/styles/readingFold.css`：高度 0 + 裁切 + 不可见） */
export const FOLD_HIDDEN_CLASS = "lmd-fold-hidden";
/** 标记"这个标题带折叠按钮"的 class（CSS 用它给标题 `position:relative`） */
export const FOLD_HEADING_CLASS = "lmd-fold-heading";
/** 隐藏块的 data 属性（DOM 断言 / 导出测试 / 滚动映射可见性判据） */
export const FOLD_HIDDEN_ATTR = "data-lmd-fold-hidden";
/** 标题块的 data 属性：值是稳定 headingId（跨渲染面 / 测试定位用） */
export const FOLD_HEADING_ATTR = "data-lmd-fold-id";
/**
 * 标题块的折叠态属性（v0.15.1 需求2）：`"true"` = 已折叠。
 *
 * 为什么状态挂在**标题节点**上而不是只靠按钮的 `aria-expanded`：三角旋转要靠
 * `transform` 过渡，前提是按钮 DOM **不被重建**。PM 的 widget 装饰在 key 变化时
 * 会重建 DOM（新元素没有「旧样式 → 新样式」的变化，转不起来），而**节点装饰的
 * 属性是 `patchAttributes` 原地改的**（同一元素、只改 attr）。因此把折叠态写进
 * 标题节点装饰的属性通道，三角的旋转由父级属性驱动 → 零 DOM 重建、可过渡。
 */
export const FOLD_COLLAPSED_ATTR = "data-lmd-fold-collapsed";
/** 折叠按钮 class（按钮上的 `data-fold-id` 即 headingId） */
export const FOLD_BTN_CLASS = "lmd-fold-toggle";
/** iframe 内注入样式表的 data 标记（幂等判据） */
export const FOLD_STYLE_ATTR = "data-lmd-fold-style";

/** 折叠按钮的可访问文案。默认**复用**已有的 `outline.collapse/expand`（无新增 key）。 */
export interface ReadingFoldLabels {
  collapse: string;
  expand: string;
}

/**
 * 默认文案 = 复用大纲面板的既有 key（v0.13.0 需求9 `outline.collapse/expand`）。
 *
 * 为什么复用而不是新增 `fold.*`：`t()` 对缺失 key 会 `console.warn` 并回退成 key 本身，
 * 若引入新 key 而字典未同步，**每次渲染都会刷警告**、按钮上还会显示英文 key。
 * 「折叠子标题 / 展开子标题」对阅读区标题折叠是准确文案；将来要区分口径时，
 * 在 `setLabels()` 里传专属 key 即可（调用方一处改动，不动本模块）。
 */
export function defaultReadingFoldLabels(): ReadingFoldLabels {
  return {
    collapse: t("outline.collapse"),
    expand: t("outline.expand"),
  };
}

// ─── 模型（一个渲染面的块结构 + 标题）────────────────────────

export interface ReadingFoldModel {
  blocks: FoldBlock[];
  headings: HeadingInfo[];
  /** 每个顶层块的文档区间（仅 PM 面有；iframe 面为空数组） */
  positions: Array<{ from: number; to: number }>;
}

/**
 * 阅读态 PM doc → 折叠模型。
 *
 * `blockIndex` 就是 PM doc 的子节点下标（含空段落与末尾 pad 段落），
 * **不能拿去和 iframe 的块下标比较**——两者只在 headingId 上对齐。
 */
export function buildPmFoldModel(doc: PMNode): ReadingFoldModel {
  const blocks = collectDocChildBlocks(doc);
  const positions: Array<{ from: number; to: number }> = [];
  let pos = 0;
  for (let i = 0; i < doc.childCount; i++) {
    const node = doc.child(i);
    positions.push({ from: pos, to: pos + node.nodeSize });
    pos += node.nodeSize;
  }
  return { blocks, headings: collectHeadings(blocks), positions };
}

/** iframe body 顶层元素 → 折叠模型（元素下标 = **过滤后**的正文元素顺序） */
export function buildIframeFoldModel(body: Element | null): ReadingFoldModel {
  const blocks: FoldBlock[] = [];
  if (!body) return { blocks, headings: [], positions: [] };
  for (const el of Array.from(body.children)) {
    if (!isContentElement(el)) continue;
    blocks.push(blockFromElement(el));
  }
  return { blocks, headings: collectHeadings(blocks), positions: [] };
}

/**
 * 单个 iframe 元素 → 块描述。
 *
 * ⚠️ 必须把 `<h1>~<h6>` 归一成 `type: "heading"`：`headingFold` 的口径是
 * 「`type === "heading"` 的顶层块才是标题」，iframe 里标题的元素名却是 h1/h2…
 * （PM 侧节点名恰好就叫 `heading`）。不归一 → iframe 面一个标题都认不出。
 */
function blockFromElement(el: Element): FoldBlock {
  const tag = String(el.tagName ?? "").toUpperCase();
  if (/^H[1-6]$/.test(tag)) {
    const id = el.getAttribute("id") ?? "";
    const block: FoldBlock = {
      type: "heading",
      level: Number(tag.slice(1)),
      // 有 id 时不读 textContent（幂等重贴时 body 已含我们注入的按钮节点，
      // 读题面文本既慢又可能把按钮字符混进来）
      text: id ? "" : (el.textContent ?? "").trim(),
    };
    if (id) block.headingId = id;
    return block;
  }
  return { type: tag.toLowerCase(), text: "" };
}

/**
 * 单个 iframe 元素是否为"正文内容元素"。
 *
 * 直接复用 `blockScrollAlign.isAnchorablePreviewChild`（iframe 贴 `data-src-line`
 * 的同一判据）——mermaid/katex 注入的 `<script>` 与 `div.mermaidTooltip` 排除在外，
 * 否则折叠块下标与行号表会整体错位。
 */
function isContentElement(el: Element): boolean {
  const tag = String(el.tagName ?? "").toUpperCase();
  const cls = typeof el.className === "string" ? el.className : "";
  return isAnchorablePreviewChild(tag, cls);
}

// ─── 折叠状态控制器（docKey + headingId，会话内）───────────────

export interface ReadingFoldSnapshot {
  docKey: string;
  /** 已折叠标题 id（有序数组，便于 `useSyncExternalStore` 浅比较） */
  collapsed: string[];
  /** 每次状态变化 +1（订阅者的刷新信号） */
  version: number;
}

export interface ReadingFoldControllerOptions {
  labels?: ReadingFoldLabels;
  /** 初始 docKey（可后改；换文档时自动清空折叠态） */
  docKey?: string;
  /** 是否允许在阅读面上显示折叠 UI（编辑 WYSIWYG 必须关闭） */
  enabled?: boolean;
}

export interface ReadingFoldController {
  getSnapshot(): ReadingFoldSnapshot;
  subscribe(listener: () => void): () => void;
  /** 换文档：docKey 变化时清空折叠态（同文档不重复清） */
  setDocKey(docKey: string | null): void;
  /** 阅读面闸门（`viewMode === "preview"` 时 true）；变化会通知订阅者 */
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
  getLabels(): ReadingFoldLabels;
  setLabels(labels: ReadingFoldLabels): void;
  /**
   * 记录**当前活动渲染面**的标题模型（祖先展开 / 全部折叠要用）。
   * 阅读模式传 PM 模型；分屏预览面传 `applyReadingFoldToIframe(...).model`。
   * 两个面同一时刻只会有一个在显示，故只留一个槽位。
   */
  setModel(model: ReadingFoldModel): void;
  getModel(): ReadingFoldModel | null;
  toggle(headingId: string): void;
  expandAll(): void;
  collapseAll(): void;
  /** 搜索命中 / TOC 跳转前：按目标块下标展开全部祖先 */
  expandAncestorsForBlockIndex(blockIndex: number): void;
  /** 同上，按标题 id（锚点链接给的是 id） */
  expandForHeadingId(headingId: string): void;
  /** 文档修改后按 id 复算（标题删除即清理）；会通知订阅者 */
  reconcile(headings: readonly HeadingInfo[]): void;
  /**
   * 静默版 `reconcile`（不通知订阅者）。
   * 只在 PM `props.decorations` 渲染路径里用——避免「更新中再 dispatch」的重入。
   */
  syncFromHeadings(headings: readonly HeadingInfo[]): void;
  /** 状态是否真的变化（内部判断用，导出便于测试） */
  hasState(): boolean;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * 创建折叠状态控制器（模块级单例由 `readingFold` 导出；测试可另建实例）。
 *
 * 状态变化 → `subscribe` 回调 → PM 插件 dispatch 空事务（只刷新装饰，不进历史），
 * iframe 侧由调用方重新 `applyReadingFoldToIframe`。
 *
 * ⚠️ `syncFromHeadings` 是**静默**版本（不通知订阅者）：它只在 PM 渲染路径
 * （`props.decorations`）里调用——那次调用本身就在 view 更新中，若再 commit →
 * notify → dispatch 会造成「更新中再派发事务」的重入。渲染路径的当前这一步
 * 已经用同步后的集合算装饰，故无需额外刷新。
 */
export function createReadingFoldController(
  options: ReadingFoldControllerOptions = {},
): ReadingFoldController {
  let docKey = String(options.docKey ?? "");
  let state: FoldState = { docKey, collapsed: new Set() };
  let enabled = options.enabled ?? false;
  let labels: ReadingFoldLabels = options.labels ?? defaultReadingFoldLabels();
  let version = 0;
  let model: ReadingFoldModel | null = null;
  const listeners = new Set<() => void>();

  /**
   * 快照**对象缓存**。
   *
   * ⚠️ 为什么不能每次 `getSnapshot()` 都返回新对象：React 的 `useSyncExternalStore`
   * 用 `Object.is` 判断"快照是否变化"，每次新建对象会判定为永远变化 → **死循环重渲染**
   * （React 会直接抛 "The result of getSnapshot should be cached to avoid an infinite loop"）。
   * 这里只在 version 真的变化时重建，其余时刻返回同一个引用。
   */
  let snapshotCache: ReadingFoldSnapshot = { docKey, collapsed: [], version: 0 };

  const refreshSnapshot = () => {
    snapshotCache = {
      docKey: state.docKey,
      collapsed: Array.from(state.collapsed).sort(),
      version,
    };
  };

  const notify = () => {
    version++;
    refreshSnapshot();
    for (const listener of Array.from(listeners)) {
      try {
        listener();
      } catch {
        /* 单个订阅者异常不能拖垮其余订阅者 */
      }
    }
  };

  const commit = (next: FoldState) => {
    if (next === state) return false;
    state = next;
    notify();
    return true;
  };

  return {
    getSnapshot() {
      return snapshotCache;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setDocKey(nextDocKey) {
      const key = String(nextDocKey ?? "");
      if (key === docKey) return;
      docKey = key;
      // 换文档一律全展开（设计稿 §2.1：状态按 docKey 会话内保存）
      state = { docKey: key, collapsed: new Set() };
      model = null;
      notify();
    },
    setEnabled(next) {
      const value = !!next;
      if (value === enabled) return;
      enabled = value;
      notify();
    },
    isEnabled() {
      return enabled;
    },
    getLabels() {
      return labels;
    },
    setLabels(next) {
      const value = next ?? defaultReadingFoldLabels();
      if (value.collapse === labels.collapse && value.expand === labels.expand) return;
      labels = value;
      notify();
    },
    setModel(next) {
      model = next ?? null;
    },
    getModel() {
      return model;
    },
    toggle(headingId) {
      commit(toggleFold(state, headingId));
    },
    expandAll() {
      commit(expandAllFold(state));
    },
    collapseAll() {
      if (!model) return;
      const ids = foldableHeadingIds(model.headings, model.blocks.length);
      if (ids.size === 0) return;
      if (sameIds(Array.from(state.collapsed).sort(), Array.from(ids).sort())) return;
      commit({ docKey: state.docKey, collapsed: ids });
    },
    expandAncestorsForBlockIndex(blockIndex) {
      if (!model) return;
      commit(expandAncestors(state, model.headings, blockIndex));
    },
    expandForHeadingId(headingId) {
      if (!model) return;
      const heading = model.headings.find((item) => item.id === headingId);
      if (!heading) return;
      commit(expandAncestors(state, model.headings, heading.blockIndex));
    },
    reconcile(headings) {
      commit(reconcileFoldState(state, headings));
    },
    syncFromHeadings(headings) {
      // 静默（不通知订阅者，渲染路径专用，见函数头注释）；但**快照缓存必须刷新**，
      // 否则下游读到的是清理前的旧折叠集合。
      state = reconcileFoldState(state, headings);
      refreshSnapshot();
    },
    hasState() {
      return state.collapsed.size > 0;
    },
  };
}

/** 会话单例（阅读区折叠状态；重启不恢复，符合 0.14.0 阅读进度口径） */
export const readingFold = createReadingFoldController();

// ─── 阅读态 PM：装饰 + 按钮 ─────────────────────────────────

export interface ReadingFoldPluginOptions {
  controller: ReadingFoldController;
  /** 是否启用（阅读面）。默认读 `controller.isEnabled()` */
  enabled?: () => boolean;
}

/**
 * 已渲染的折叠按钮（headingId → 元素）。
 *
 * ⚠️ 为什么需要它（v0.15.1 需求2）：三角朝向要从「切换 `content`」改成
 * 「固定字符 + `transform: rotate()` 过渡」，而**新创建的元素不会过渡**
 * （没有「旧样式 → 新样式」的变化）。所以折叠态变化时必须**复用同一个
 * `<button>` 元素**、只改属性：PM 的 widget 装饰在 `key` 变化时会重建 DOM，
 * 因此 widget key 只含 headingId（不含折叠态），折叠态改由本表命令式同步
 * `aria-expanded` / `aria-label` / `title`。
 *
 * 清理：widget 的 `destroy` 回调把对应条目删掉（切面 / 关闸 / 换文档）。
 */
const liveFoldButtons = new Map<string, HTMLButtonElement>();

/** 把折叠态同步到**已存在**的按钮上（不存在则什么都不做，等 toDOM 创建） */
export function syncFoldButtonState(
  btn: HTMLButtonElement | null | undefined,
  headingId: string,
  isCollapsed: boolean,
  labels: ReadingFoldLabels,
): void {
  if (!btn) return;
  const expanded = isCollapsed ? "false" : "true";
  if (btn.getAttribute("aria-expanded") !== expanded) btn.setAttribute("aria-expanded", expanded);
  const label = isCollapsed ? labels.expand : labels.collapse;
  if (btn.getAttribute("aria-label") !== label) btn.setAttribute("aria-label", label);
  if (btn.title !== label) btn.title = label;
  if (btn.dataset.foldId !== headingId) btn.dataset.foldId = headingId;
}

/**
 * 计算 PM 阅读面的折叠装饰（纯函数，可单测）。
 *
 * - 标题块 → `Decoration.widget`（按钮，`stopEvent` 拦截 PM 事件、`mousedown` 阻止选区移动）；
 * - 被折叠区间内的块 → `Decoration.node` 加 `lmd-fold-hidden`（`display:none`）。
 */
export function computePmFoldDecorations(
  model: ReadingFoldModel,
  collapsed: ReadonlySet<string>,
  labels: ReadingFoldLabels,
  onToggle: { toggle(headingId: string): void },
): Array<Decoration> {
  const decorations: Decoration[] = [];
  const total = model.blocks.length;

  // ① 隐藏块（纯 CSS display:none，不碰 doc）
  const hidden = hiddenBlockIndexes(model.headings, total, collapsed);
  for (const blockIndex of hidden) {
    const range = model.positions[blockIndex];
    if (!range) continue;
    decorations.push(
      Decoration.node(range.from, range.to, {
        class: FOLD_HIDDEN_CLASS,
        [FOLD_HIDDEN_ATTR]: "true",
      }),
    );
  }

  // ② 折叠按钮（只给"真能藏起内容"的标题；空标题不显示三角）
  const foldable = foldableHeadingIds(model.headings, total);
  for (const heading of model.headings) {
    if (!foldable.has(heading.id)) continue;
    const range = model.positions[heading.blockIndex];
    if (!range) continue;
    // 被外层折叠隐藏的标题不显示按钮（它自己不可见，按钮也无意义）
    if (hidden.has(heading.blockIndex)) continue;
    const isCollapsed = collapsed.has(heading.id);
    // 标题节点装饰：`position:relative` 的定位上下文 class（与 v0.12.1 标题徽标
    // `.pm-heading-marker` 同一套几何）**+ 折叠态属性**。
    //
    // v0.15.1 需求2：`data-lmd-fold-collapsed` 是三角旋转的**状态来源**。
    // 为什么挂标题节点而不挂按钮：按钮是 `Decoration.widget` 创建的独立 DOM，
    // 改它的属性属于"手改 PM 管理的 DOM"（会触发 MutationObserver → markDirty →
    // 整节点重建，阅读模式每次按键闪一次；见 v0.12.1 给标题写 id 的实测先例）。
    // 而节点装饰的属性由 PM 自己 patch（`patchAttributes`），零 mutation、零 doc 改动。
    // CSS 用后代选择器 `[data-lmd-fold-collapsed="true"] .lmd-fold-toggle::before`
    // 读它 → 标题与其按钮在同一个子树里，选择器天然成立。
    decorations.push(
      Decoration.node(range.from, range.to, {
        class: FOLD_HEADING_CLASS,
        [FOLD_HEADING_ATTR]: heading.id,
        ...(isCollapsed ? { [FOLD_COLLAPSED_ATTR]: "true" } : {}),
      }),
    );
    // widget 位置：标题内容起点（= 标题节点起点 + 1），与标题徽标同一套定位几何
    decorations.push(
      Decoration.widget(
        range.from + 1,
        () => createFoldButton(heading.id, isCollapsed, labels, onToggle),
        {
          side: -1,
          marks: [],
          ignoreSelection: true,
          // ⚠️ key **只含 headingId**，刻意不含折叠态（v0.15.1 需求2）：
          // 含折叠态会让 PM 在每次折叠/展开时销毁并新建按钮元素 —— 新元素没有
          // 「旧 transform → 新 transform」的变化，CSS transition 不会启动，
          // 三角只能硬跳（这正是要修掉的观感问题）。
          // 折叠态改由 `syncFoldButtons` 命令式同步到**已存在的**按钮上。
          key: heading.id,
          stopEvent: () => true,
        },
      ),
    );
  }

  // ③ 把折叠态同步到已渲染的按钮元素（key 不含折叠态 → 按钮不会因折叠而重建，
  //    过渡才能启动；但 aria/朝向仍必须跟着状态变）
  syncFoldButtons(model, collapsed, labels);

  return decorations;
}

/**
 * 把折叠态同步到**已经渲染出来**的按钮元素上（v0.15.1 需求2）。
 *
 * 为什么需要这一步：widget key 不再含折叠态（见上），所以折叠态变化**不会**重建
 * 按钮 DOM。PM 只在装饰集变化时调用 widget 的 `update`（我们没自定义 widget 的
 * `update`，默认 `eq` 命中就复用原元素且不再回调）—— 因此必须由装饰计算函数在
 * 返回前**遍历一遍已渲染的按钮**，把 `aria-expanded` / `aria-label` / `title`
 * 改成新状态。这样：
 * - 按钮元素被复用 → 三角的 `transform` 有「旧值 → 新值」的连续变化 → 过渡成立；
 * - 无障碍属性仍与状态同步（屏幕阅读器读到的是 `aria-expanded="false"`）。
 *
 * 幂等：属性已一致时不写（`syncFoldButtonState` 内部逐项比较），重复调用零副作用。
 */
function syncFoldButtons(
  model: ReadingFoldModel,
  collapsed: ReadonlySet<string>,
  labels: ReadingFoldLabels,
): void {
  // 只同步「本面仍然存在」的标题按钮：模型里没有的 id 说明该标题已被删/换文档，
  // 顺手从表里清掉（按钮元素的 destroy 也会清，这里兜一层防泄漏）。
  const alive = new Set(model.headings.map((h) => h.id));
  for (const [headingId, btn] of liveFoldButtons) {
    if (!btn.isConnected || !alive.has(headingId)) {
      if (!btn.isConnected) liveFoldButtons.delete(headingId);
      continue;
    }
    syncFoldButtonState(btn, headingId, collapsed.has(headingId), labels);
  }
}

/** 折叠按钮：垂直居中的小三角，键盘 Enter/Space 可切换 */
export function createFoldButton(
  headingId: string,
  isCollapsed: boolean,
  labels: ReadingFoldLabels,
  onToggle: { toggle(headingId: string): void },
): HTMLElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = FOLD_BTN_CLASS;
  btn.dataset.foldId = headingId;
  btn.setAttribute("contenteditable", "false");
  btn.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
  btn.setAttribute("aria-label", isCollapsed ? labels.expand : labels.collapse);
  btn.title = isCollapsed ? labels.expand : labels.collapse;
  // v0.15.1 需求2：登记进 liveFoldButtons，供 `syncFoldButtons` 在折叠态变化时
  // 原地更新（不重建 DOM → 三角 transform 才能过渡）。
  liveFoldButtons.set(headingId, btn);
  // mousedown 阻止默认：不移动光标 / 不打断选区（与 hit 徽标同一修法）
  btn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onToggle.toggle(headingId);
  });
  btn.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
    e.preventDefault();
    e.stopPropagation();
    onToggle.toggle(headingId);
  });
  return btn;
}

/**
 * 阅读面折叠插件（**只渲染，不碰 doc**）。
 *
 * 注册方式（Lead 接线）：
 * 1. `core/editor.ts` 的 plugins 数组（`trailingParagraphPlugin()` 之后）加：
 *    `createReadingFoldPlugin({ controller: readingFold })`；
 * 2. `EditorContainer` 在 `viewMode` 变化时：
 *    `readingFold.setEnabled(viewMode === "preview")`
 *    （阅读面>0；编辑 WYSIWYG 必须关闭——插件也只在 enabled 时出装饰）；
 * 3. 换文档时 `readingFold.setDocKey(currentDocKeyFromStore())`。
 *
 * 状态变化 → 订阅回调 dispatch **空事务** → 装饰重算（不进撤销历史）。
 */
export function createReadingFoldPlugin(options: ReadingFoldPluginOptions): Plugin {
  const { controller } = options;
  const isEnabled = options.enabled ?? (() => controller.isEnabled());
  let unsub: (() => void) | null = null;
  /** 上一次算好的装饰集（doc + 折叠态 + labels 都未变时直接复用，长文档零重算） */
  let cached: DecorationSet = DecorationSet.empty;
  let cachedDoc: PMNode | null = null;
  let cachedStateKey = "";

  return new Plugin({
    props: {
      decorations(state: EditorState): DecorationSet {
        if (!isEnabled()) {
          cached = DecorationSet.empty;
          cachedDoc = null;
          cachedStateKey = "";
          return cached;
        }
        const snapshot = controller.getSnapshot();
        const labels = controller.getLabels();
        // 判据必须含 doc 对象同一性：PM 每按键都换 doc；但若只换选区（纯点击）
        // doc 不变 → 装饰集原样复用（Escape 与点击不应触发全量重算）。
        const key = `${snapshot.version}:${snapshot.collapsed.length}:${labels.collapse}|${labels.expand}`;
        if (cachedDoc === state.doc && cachedStateKey === key) return cached;

        const model = buildPmFoldModel(state.doc);
        // 用最新模型刷新控制器缓存（祖先展开 / 全部折叠要用）
        controller.setModel(model);
        // 文档改动后按 headingId 复算：标题被删 / 文本改动 → 旧 id 失效即清理。
        // 用**静默**版本：这里已经在 view 更新中，再 notify→dispatch 会重入。
        controller.syncFromHeadings(model.headings);
        // 复算可能清掉了失效 id（version 不变，因为 sync 是静默的）→ 用同步后的集合
        const collapsed = new Set(controller.getSnapshot().collapsed);
        cached = DecorationSet.create(
          state.doc,
          computePmFoldDecorations(model, collapsed, labels, controller),
        );
        cachedDoc = state.doc;
        cachedStateKey = key;
        return cached;
      },
    },

    view(editorView: EditorView) {
      unsub = controller.subscribe(() => {
        if (editorView.isDestroyed) return;
        // 空事务：只刷新装饰，docChanged=false → 不序列化、不进历史。
        // **不按 enabled 提前 return**：闸门关闭（切到编辑 WYSIWYG 面）时也必须
        // 派发一次，否则上一次算出的隐藏/按钮会残留在 DOM 上（折叠面切走没清）。
        editorView.dispatch(editorView.state.tr);
      });
      return {
        destroy() {
          unsub?.();
          unsub = null;
        },
      };
    },
  });
}

// ─── iframe 预览面：幂等 DOM 注入 ─────────────────────────────

/**
 * iframe 内折叠样式（iframe 是独立文档，**不继承父文档 CSS 变量** —— 见语义地图 §4）。
 *
 * ⚠️ v0.15.1 需求2：本常量与 `src/styles/readingFold.css` **必须同口径**（两个阅读面
 * 的折叠动效要一模一样）。两处的关键声明由单测锁死一致；改一处必须改另一处。
 *
 * 与 PM 面唯一的结构差异：iframe 里**没有** PM 的节点装饰，所以折叠态属性
 * `data-lmd-fold-collapsed` 由 DOM 注入层直接写在标题元素上（见
 * `applyReadingFoldToIframe`）—— 语义与 PM 面完全相同（同一个属性名、同一套 CSS）。
 */
export const FOLD_IFRAME_CSS = `
  /* 插值开关（Chromium 129+）：让 height:auto ↔ 0 可过渡 */
  html { interpolate-size: allow-keywords; }

  /* ① 展开方向：所有正文块的高度 / 透明度 / 间距过渡 */
  body > * {
    transition:
      height 440ms cubic-bezier(0.2, 0, 0.2, 1),
      opacity 440ms ease,
      margin-top 440ms cubic-bezier(0.2, 0, 0.2, 1),
      margin-bottom 440ms cubic-bezier(0.2, 0, 0.2, 1),
      padding-top 440ms cubic-bezier(0.2, 0, 0.2, 1),
      padding-bottom 440ms cubic-bezier(0.2, 0, 0.2, 1);
  }

  /* ② 折叠方向：高度收起 + 立刻裁切 + 收完再隐藏 */
  .${FOLD_HIDDEN_CLASS} {
    box-sizing: border-box !important;
    height: 0 !important;
    min-height: 0 !important;
    max-height: 0 !important;
    margin-top: 0 !important;
    margin-bottom: 0 !important;
    padding-top: 0 !important;
    padding-bottom: 0 !important;
    border-top-width: 0 !important;
    border-bottom-width: 0 !important;
    overflow: hidden !important;
    visibility: hidden !important;
    opacity: 0;
    pointer-events: none;
    transition:
      height 440ms cubic-bezier(0.2, 0, 0.2, 1),
      opacity 440ms ease,
      margin-top 440ms cubic-bezier(0.2, 0, 0.2, 1),
      margin-bottom 440ms cubic-bezier(0.2, 0, 0.2, 1),
      padding-top 440ms cubic-bezier(0.2, 0, 0.2, 1),
      padding-bottom 440ms cubic-bezier(0.2, 0, 0.2, 1),
      overflow 0s linear 0s,
      visibility 0s linear 440ms;
  }

  /* ③ 退化路径：不支持 height 关键字插值 → 瞬时显隐（功能不失效，只是没动画） */
  @supports not (interpolate-size: allow-keywords) {
    .${FOLD_HIDDEN_CLASS} { display: none; }
  }

  h1.${FOLD_HEADING_CLASS}, h2.${FOLD_HEADING_CLASS}, h3.${FOLD_HEADING_CLASS},
  h4.${FOLD_HEADING_CLASS}, h5.${FOLD_HEADING_CLASS}, h6.${FOLD_HEADING_CLASS} {
    position: relative;
  }

  .${FOLD_BTN_CLASS} {
    position: absolute; right: 100%; top: 50%;
    transform: translateY(-50%);
    display: inline-flex; align-items: center; justify-content: center;
    /* 固定尺寸而非 em：标题字号随级别变（H1 = 2em），em 会让 H1 的三角翻倍 */
    width: 16px; height: 16px; padding: 0;
    border: none; border-radius: 3px; background: transparent;
    color: var(--text-tertiary, #999);
    font-size: 12px; line-height: 1; opacity: 0.55;
    cursor: pointer; user-select: none;
    transition: color 150ms ease, background-color 150ms ease;
  }
  .${FOLD_BTN_CLASS}:hover { opacity: 1; color: var(--accent-color, #0078d4); background: var(--code-bg, #f4f4f4); }
  .${FOLD_BTN_CLASS}:focus-visible { outline: 2px solid var(--accent-color, #0078d4); outline-offset: 1px; }

  /* ④ 三角朝向：固定字符 + transform 旋转（与 PM 面同口径） */
  .${FOLD_BTN_CLASS}::before {
    content: "▾";
    display: inline-block;
    transform: rotate(0deg);
    transform-origin: 50% 50%;
    transition: transform 360ms cubic-bezier(0.2, 0, 0.2, 1);
  }
  [${FOLD_COLLAPSED_ATTR}="true"] .${FOLD_BTN_CLASS}::before { transform: rotate(-90deg); }

  /* ⑤ 减少动效偏好：全部过渡归零（功能不变） */
  @media (prefers-reduced-motion: reduce) {
    body > *, .${FOLD_HIDDEN_CLASS}, .${FOLD_BTN_CLASS}, .${FOLD_BTN_CLASS}::before {
      transition: none !important;
    }
  }
`;

export interface ApplyIframeFoldOptions {
  /** 已折叠标题 id */
  collapsed: ReadonlySet<string>;
  labels?: ReadingFoldLabels;
  /** 点击按钮时的回调（由调用方重新应用折叠态） */
  onToggle?: (headingId: string) => void;
  /** 控制器（提供默认 labels / onToggle 时可直接传） */
  controller?: ReadingFoldController;
}

export interface ApplyIframeFoldResult {
  /** body 是否就绪（false 表示本次什么都没做，调用方应重试） */
  applied: boolean;
  /** 应用的隐藏块数 */
  hidden: number;
  /** 折叠按钮数 */
  buttons: number;
  /** 本面标题列表 */
  headings: HeadingInfo[];
  /**
   * 本面的折叠模型（`blockIndex` 是**本面自己**的口径）。
   * `applyReadingFoldToIframeWhenReady` 会在成功后把它写进 controller ——
   * 两个面互斥（`previewShown = viewMode==="edit" && splitPreviewOpen`，
   * 阅读模式恒 false），所以"谁被显示谁写模型"不会互相踩。
   */
  model: ReadingFoldModel;
}

/** 幂等注入折叠样式表（同一 document 只注一次；文档被重写后重注） */
export function ensureIframeFoldStyle(doc: Document | null): boolean {
  if (!doc) return false;
  const head = doc.head;
  if (!head) return false;
  const existing = head.querySelector(`style[${FOLD_STYLE_ATTR}]`);
  if (existing) {
    if (existing.textContent !== FOLD_IFRAME_CSS) existing.textContent = FOLD_IFRAME_CSS;
    return true;
  }
  const style = doc.createElement("style");
  style.setAttribute(FOLD_STYLE_ATTR, "true");
  style.textContent = FOLD_IFRAME_CSS;
  head.appendChild(style);
  return true;
}

/**
 * 清掉上一次注入的全部折叠痕迹。
 *
 * **幂等的前提**：任何一次 apply 都先整体复位再重新按状态写入，于是
 * 「增量更新 / 重试 / 切主题」反复调用后 DOM 与单次调用完全一致。
 * 顺序也很重要：必须**先复位**再取 `textContent` 算块描述，否则按钮文本会
 * 混进标题文本里（第二次调用算出的 id 就不再是 markdown-it 那个 id）。
 */
function resetIframeFold(body: Element): void {
  // 按钮是我们注入的子元素，**保留**它们（v0.15.1 需求2）：
  // 若在这里 `.remove()`，下面会为每个标题新建 `<button>` —— 新元素没有
  // 「旧 transform → 新 transform」的变化，三角旋转过渡不会启动（只能硬跳）。
  // 因此复位只清「状态属性 / class」，按钮元素按 headingId 原地复用（见下方 ③）。
  // 通知遍历到的孤儿按钮（标题已被删 / 不再可折叠）在这一步清掉。
  const keep = new Set<string>();
  for (const el of Array.from(body.children)) {
    el.classList.remove(FOLD_HIDDEN_CLASS);
    el.removeAttribute(FOLD_HIDDEN_ATTR);
    el.classList.remove(FOLD_HEADING_CLASS);
    el.removeAttribute(FOLD_HEADING_ATTR);
    el.removeAttribute(FOLD_COLLAPSED_ATTR);
    for (const btn of Array.from(el.querySelectorAll(`.${FOLD_BTN_CLASS}`))) {
      const id = (btn as HTMLElement).dataset.foldId;
      if (id) keep.add(id);
    }
  }
  // 极少数被挪到 body 直下的按钮（防御性清理）：body 直属按钮不参与复用，直接移除
  for (const btn of Array.from(body.querySelectorAll(`:scope > .${FOLD_BTN_CLASS}`))) {
    btn.remove();
  }
  void keep;
}

/**
 * 把折叠态幂等地应用到 iframe 预览文档。
 *
 * 幂等意味着：任意时刻重复调用（增量更新 / 重试 / 切主题）结果 DOM 相同，
 * 不会泄漏按钮、不会重复隐藏。`doc.body` 未就绪时返回 `applied:false`，
 * 调用方用 `applyReadingFoldToIframeWhenReady` 重试。
 */
export function applyReadingFoldToIframe(
  doc: Document | null,
  options: ApplyIframeFoldOptions,
): ApplyIframeFoldResult {
  const empty: ApplyIframeFoldResult = {
    applied: false,
    hidden: 0,
    buttons: 0,
    headings: [],
    model: { blocks: [], headings: [], positions: [] },
  };
  const body = doc?.body;
  if (!doc || !body) return empty;
  ensureIframeFoldStyle(doc);

  resetIframeFold(body);

  // ① 只统计「正文内容元素」：与 `data-src-line` 贴标同一套过滤，保证下标一致
  const contentEls = Array.from(body.children).filter(isContentElement);
  const blocks: FoldBlock[] = contentEls.map(blockFromElement);
  const headings = collectHeadings(blocks);
  const collapsed = options.collapsed ?? new Set<string>();
  const labels = options.labels ?? options.controller?.getLabels() ?? defaultReadingFoldLabels();

  // ② 隐藏块（class + data 双写：class 负责样式，data 负责断言/导出识别）
  const hidden = hiddenBlockIndexes(headings, contentEls.length, collapsed);
  for (const blockIndex of hidden) {
    const el = contentEls[blockIndex];
    if (!el) continue;
    el.classList.add(FOLD_HIDDEN_CLASS);
    el.setAttribute(FOLD_HIDDEN_ATTR, "true");
  }

  // ③ 标题折叠按钮
  const foldable = foldableHeadingIds(headings, contentEls.length);
  let buttons = 0;
  for (const heading of headings) {
    if (!foldable.has(heading.id)) continue;
    // 被外层折叠隐藏的标题不显示按钮（它自己不可见，按钮无意义；与 PM 面同口径）
    if (hidden.has(heading.blockIndex)) continue;
    const el = contentEls[heading.blockIndex];
    if (!el) continue;
    const isCollapsed = collapsed.has(heading.id);
    el.classList.add(FOLD_HEADING_CLASS);
    el.setAttribute(FOLD_HEADING_ATTR, heading.id);
    // v0.15.1 需求2：折叠态属性（PM 面由节点装饰写同名属性，两处 CSS 同口径）
    if (isCollapsed) el.setAttribute(FOLD_COLLAPSED_ATTR, "true");
    else el.removeAttribute(FOLD_COLLAPSED_ATTR);
    // ③-1 复用同一标题上一次的按钮元素（存在就不重建 → 三角旋转可过渡）
    let btn = el.querySelector<HTMLButtonElement>(`:scope > .${FOLD_BTN_CLASS}`);
    if (!btn) {
      btn = doc.createElement("button");
      btn.type = "button";
      // 键盘（Enter/Space）**不需要**额外监听：这是原生 `<button>`，
      // 浏览器按下 Enter/Space 会派发 click（HTML 规范），与 PM 面手写 keydown
      // 的语义一致；再挂一个 keydown 会变成"一次按键切换两次"。
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        options.onToggle?.(heading.id);
      });
    }
    btn.className = FOLD_BTN_CLASS;
    btn.dataset.foldId = heading.id;
    btn.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
    btn.setAttribute("aria-label", isCollapsed ? labels.expand : labels.collapse);
    btn.title = isCollapsed ? labels.expand : labels.collapse;
    if (btn.parentElement !== el) el.appendChild(btn);
    buttons++;
    if (btn.parentElement !== el) el.appendChild(btn);
  }

  return {
    applied: true,
    hidden: hidden.size,
    buttons,
    headings,
    model: { blocks, headings, positions: [] },
  };
}

/** 重试计划（与 `tagWhenBodyReady` 同款：0 / 160 / 480ms + load 兜底） */
export const IFRAME_FOLD_RETRY_DELAYS = [0, 160, 480] as const;

/**
 * body 未就绪时重试应用折叠（返回取消函数）。
 *
 * 为什么必须重试：`doc.close()` 返回时 `doc.body` 可能仍是 `null`（整篇重写注入的
 * `<head>` 里有非 async 的 mermaid/katex 脚本，解析器会停在那里等脚本）——
 * 语义地图 §4 的实测陷阱；直接读 `body.children` 会抛 TypeError 被 catch 吞掉。
 *
 * 重试契约（与 `tagWhenBodyReady` 同款）：同步一次 → `load` 一次 →
 * 0 / 160 / 480ms 定时兜底；每次调用都是幂等 apply，故重复触发无副作用。
 */
export function applyReadingFoldToIframeWhenReady(
  getDoc: () => Document | null,
  options: ApplyIframeFoldOptions,
): () => void {
  let cancelled = false;
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  /** 已挂过 load 监听的 window（避免每次重试都重复挂） */
  let listenedWin: Window | null = null;

  const onLoad = () => {
    if (!cancelled) attempt();
  };

  const attempt = (): boolean => {
    if (cancelled) return true;
    const doc = getDoc();
    if (!doc) return false;
    const win = doc.defaultView;
    if (win && win !== listenedWin) {
      listenedWin = win;
      try {
        win.addEventListener("load", onLoad, { once: true });
      } catch {
        /* 跨源 / 已卸载：交给定时器兜底 */
      }
    }
    const result = applyReadingFoldToIframe(doc, options);
    if (result.applied) {
      // 让控制器记录**这一面**的模型：祖先展开 / 全部折叠都依赖当前活动面的
      // blockIndex 口径（PM 面与 iframe 面不同，见模块头「跨渲染面只用 id 对齐」）。
      // 两面互斥（previewShown 只在编辑模式成立），不会互相覆盖。
      options.controller?.setModel(result.model);
    }
    return result.applied;
  };

  if (attempt()) {
    return () => {
      cancelled = true;
      if (listenedWin) {
        try {
          listenedWin.removeEventListener("load", onLoad);
        } catch {
          /* 文档已销毁 */
        }
      }
    };
  }

  for (const delay of IFRAME_FOLD_RETRY_DELAYS) {
    timers.push(
      setTimeout(() => {
        if (!cancelled) attempt();
      }, delay),
    );
  }

  return () => {
    cancelled = true;
    for (const timer of timers) clearTimeout(timer);
    if (listenedWin) {
      try {
        listenedWin.removeEventListener("load", onLoad);
      } catch {
        /* 文档已销毁 */
      }
    }
  };
}

/** 服务测试/接线：显式判断两个 id 集合是否一致 */
export function sameCollapsedSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && Array.from(a).every((id) => b.has(id));
}

// ─── 接线辅助：iframe 桥（Lead 接线只需两行调用）─────────────────

export interface IframeFoldBridgeOptions {
  /** 取当前 iframe 的 contentDocument（body 未就绪时可以返回 doc，内部会判 body） */
  getIframeDocument: () => Document | null;
  /** 该 iframe 面当前是否应当显示折叠（编辑模式右侧预览：`previewShown`） */
  isActive: () => boolean;
  /** 折叠状态控制器（默认模块单例 `readingFold`） */
  controller?: ReadingFoldController;
}

export interface IframeFoldBridge {
  /**
   * 把当前折叠态应用到 iframe（**幂等**；body 未就绪时自动按
   * `IFRAME_FOLD_RETRY_DELAYS` 重试）。
   *
   * 调用时机（Lead 接线）：
   * - iframe `previewHtml` 写入 effect 之后（完整重写分支 / 增量分支各一次）；
   * - `readingFold.subscribe` 回调里（用户点了某面按钮 / 大纲折叠变化）。
   *
   * 返回取消函数（换文档 / 组件卸载时调用，作废未完成的重试）。
   */
  apply(): () => void;
  /** 取消所有仍在等待的重试 */
  dispose(): void;
}

/**
 * 建一个 iframe 折叠桥。
 *
 * 为什么不把这段直接塞进 `applyReadingFoldToIframe`：apply 必须是**纯 DOM 应用**
 * （同步、可单测、可反复调用），而"取哪个 iframe / 什么时候该显示 / 重试生命周期"
 * 是调用方的状态问题。桥把后者收在一起，EditorContainer 侧接线只需：
 *
 * ```ts
 * const foldBridge = useMemo(() => createIframeFoldBridge({
 *   getIframeDocument: () => previewIframeRef.current?.contentDocument ?? null,
 *   isActive: () => previewShown && isMdFile,
 * }), [previewShown, isMdFile]);
 * // 写 iframe 的 effect 末尾：foldBridge.apply();
 * // viewMode / previewShown / 折叠状态变化：foldBridge.apply();
 * // 卸载：foldBridge.dispose();
 * ```
 */
export function createIframeFoldBridge(options: IframeFoldBridgeOptions): IframeFoldBridge {
  const controller = options.controller ?? readingFold;
  const cancels = new Set<() => void>();

  const dispose = () => {
    for (const cancel of Array.from(cancels)) cancel();
    cancels.clear();
  };

  const apply = (): (() => void) => {
    // 上一次的等待重试全部作废（内容已被本次覆盖）
    dispose();
    if (!options.isActive()) return () => undefined;
    const cancel = applyReadingFoldToIframeWhenReady(
      () => options.getIframeDocument(),
      {
        collapsed: new Set(controller.getSnapshot().collapsed),
        labels: controller.getLabels(),
        controller,
        onToggle: (headingId) => {
          controller.toggle(headingId);
          // 状态变化会经 subscribe 让调用方再 apply 一次；这里再同步刷新一次，
          // 保证"点了立刻收/展开"不依赖 React 渲染时序（无 React 依赖的兜底）。
          const doc = options.getIframeDocument();
          if (doc?.body) {
            applyReadingFoldToIframe(doc, {
              collapsed: new Set(controller.getSnapshot().collapsed),
              labels: controller.getLabels(),
              controller,
              onToggle: undefined,
            });
          }
        },
      },
    );
    // 注意：`applyReadingFoldToIframeWhenReady` 在 body 已就绪时会**直接完成**，
    // 此时返回的 cancel 仍必须保留（它负责解绑 load 监听），统一收集即可。
    cancels.add(cancel);
    return cancel;
  };

  return { apply, dispose };
}

/**
 * 阅读态 PM 面的快捷入口：给 Lead 接线用（TOC/锚点/搜索跳转前展开祖先）。
 *
 * 为什么需要它：跳转前必须先把目标祖先展开，否则 `scrollIntoView` 会落到
 * 一个 `display:none` 的块上（浏览器的滚动行为对不可见元素无意义）。
 *
 * @param targetBlockIndex 目标在**阅读 PM**块数组中的下标（`buildPmFoldModel` 口径）
 * @returns 是否发生了状态变化（true → 调用方应重算装饰/滚动）
 */
export function expandBeforeJumpToBlockIndex(targetBlockIndex: number): boolean {
  const before = readingFold.getSnapshot().collapsed.length;
  readingFold.expandAncestorsForBlockIndex(targetBlockIndex);
  return readingFold.getSnapshot().collapsed.length !== before;
}

/** 同上，但目标是标题（TOC 条目 / `#锚点` 链接给的是 headingId） */
export function expandBeforeJumpToHeadingId(headingId: string): boolean {
  const before = readingFold.getSnapshot().collapsed.length;
  readingFold.expandForHeadingId(headingId);
  return readingFold.getSnapshot().collapsed.length !== before;
}

/**
 * 同上，但目标用 **PM 文档位置**（`Outline` 的 `pos` / 搜索命中偏移都属于这个坐标）。
 *
 * 折叠层只认「顶层块下标」，故这里把 doc 位置换算成它所在顶层块的下标：
 * `doc.resolve(pos).index(0)`。这样 Lead 在 `Outline.handleClick` / 搜索跳转处
 * 只需一行 `expandBeforeJumpToDocPos(editorView.state.doc, pos)`，不必自己算块下标。
 *
 * @param doc PM 文档
 * @param pos 目标文档位置（0..doc.content.size）
 */
export function expandBeforeJumpToDocPos(doc: PMNode, pos: number): boolean {
  const target = Number(pos);
  if (!doc || !Number.isFinite(target)) return false;
  const clamped = Math.max(0, Math.min(doc.content.size, Math.floor(target)));
  let blockIndex = -1;
  try {
    blockIndex = doc.resolve(clamped).index(0);
  } catch {
    return false;
  }
  if (!Number.isFinite(blockIndex) || blockIndex < 0) return false;
  // 位置落在块边界（= 下一块起点）时 `index(0)` 给的就是下一块；两个候选块的
  // 祖先链只可能相同或更靠后，对"展开祖先"这一诉求无差别，故不额外调整。
  return expandBeforeJumpToBlockIndex(blockIndex);
}
