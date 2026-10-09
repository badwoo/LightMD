/**
 * WYSIWYG 核心插件 —— 光标驱动的源码/渲染切换
 *
 * v0.12.0 需求3：块级标记改用 Decoration.node + CSS 伪元素（绝对定位）。
 * 原实现用 Decoration.widget 插入真实 <span>（marker-reveal）参与行内布局——
 * 光标进入标题/引用/代码块时文本被右移、离开时左移（用户报告的"标题符号抖动"）。
 * 绝对定位伪元素完全脱离文档流，布局零影响。
 *
 * v0.12.1 需求1：**标题**不再显示 `#`/`##` 语法井号，改为可点击的 H1~H6 级别徽标
 * （点击展开级别下拉菜单改级别）。徽标必须可点击 → 不能再用 CSS 伪元素，
 * 改用绝对定位的 Decoration.widget 按钮（同样脱离文档流，零布局影响）：
 *   · 位置：标题节点起始处的 widget（side:-1），DOM 落在 <h2> 内部；
 *   · 定位：依赖节点装饰给标题加 .pm-heading-marker { position: relative }，
 *     徽标 right:100% 贴到标题左缘外（与旧伪元素几何完全一致）；
 *   · 交互：mousedown preventDefault → 不移动光标、不打断选区，点击回调上抛给
 *     EditorContainer 渲染 React 菜单（与 PmContextMenu 同款 portal 模式）。
 * 引用块 `> `、代码块 ``` 仍走 v0.12.0 的伪元素路径（它们不是"可点选项"）。
 *
 * 历史修复保留：
 * - 装饰位置使用 $from.before(depth) / $from.after(depth)（节点边界）
 * - 简化内联标记装饰，避免位置冲突
 */
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { EditorView } from "prosemirror-view";
import type { EditorState, Transaction } from "prosemirror-state";
import type { Node } from "prosemirror-model";
import { t } from "../../i18n/state";

export const wysiwygKey = new PluginKey("wysiwyg");

/** v0.12.0 需求3：可显示标记的块类型。
 * 其余块（段落/列表项等）不作为查找终点——继续向外层找最近的标记块，
 * 否则引用块内的段落会抢先命中导致 "> " 标记永远不可达（旧实现的缺陷） */
const MARKABLE_BLOCKS = new Set(["heading", "blockquote", "code_block"]);

/** v0.12.1 需求1：标题级别徽标回调（headingPos = 标题节点起始位置） */
export interface WysiwygOptions {
  onHeadingBadgeClick?: (headingPos: number, currentLevel: number, anchor: DOMRect) => void;
}

/**
 * 获取光标所在（或最近外层）的**可标记块级节点**及其节点边界
 */
function getActiveBlockNode(
  state: EditorState
): { node: Node; start: number; end: number } | null {
  const { $from } = state.selection;

  for (let depth = $from.depth; depth >= 1; depth--) {
    const node = $from.node(depth);
    if (MARKABLE_BLOCKS.has(node.type.name)) {
      // v0.12.0 需求3：Decoration.node 需要**节点边界**（before/after）——
      // 不能用 $from.start(depth)（内容起点，装饰范围会偏移一个节点、标记挂到错误位置）。
      // focus-mode.ts 的 $from.start(d) - 1 即同一语义，可作参照。
      return { node, start: $from.before(depth), end: $from.after(depth) };
    }
  }
  return null;
}

// ─── 标题级别徽标 ────────────────────────────────────────

/**
 * 构建标题级别徽标（真实 DOM 按钮）。
 *
 * `getPos` 由 ProseMirror 注入：返回 widget 在文档中的位置。
 * widget 插在 heading 的**首个内容位置**（start + 1），故标题节点位置 = getPos() - 1。
 * 用 getPos 而非闭包捕获的 start：DecorationSet 在 docChanged 但选区未变时走
 * `map()` 复用（见 apply），闭包里捕获的坐标会过期。
 */
export function createHeadingBadge(
  level: number,
  getPos: () => number | undefined,
  options: WysiwygOptions,
): HTMLElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "pm-heading-badge";
  el.dataset.headingLevel = String(level);
  el.textContent = `H${level}`;
  el.setAttribute("aria-haspopup", "menu");
  el.setAttribute("aria-label", t("heading.badge.title", { level }));
  el.title = t("heading.badge.title", { level });

  // mousedown 阻止默认：不移动光标、不打断当前选区，否则菜单还没开光标就跳走了
  el.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  el.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const view = (el as HTMLElement & { __pmView?: EditorView }).__pmView;
    // 只读标签（contenteditable=false）不允许改级别
    if (view && !view.editable) return;
    const widgetPos = getPos();
    // getPos() 在 widget 已被移除时返回 undefined（文档被替换）→ 无动作
    if (widgetPos == null) return;
    // widget 插在 heading 内容起点（start + 1）→ 标题节点位置 = widgetPos - 1
    options.onHeadingBadgeClick?.(widgetPos - 1, level, el.getBoundingClientRect());
  });
  return el;
}

// ─── 装饰计算 ────────────────────────────────────────────

function computeDecorations(state: EditorState, options: WysiwygOptions): DecorationSet {
  const decorations: Decoration[] = [];
  const { empty } = state.selection;

  if (!empty) return DecorationSet.empty;

  // 块级标记装饰（引用的 >、代码块的 ```；标题改为级别徽标）
  const activeBlock = getActiveBlockNode(state);
  if (activeBlock) {
    addBlockDecorations(decorations, activeBlock.node, activeBlock.start, activeBlock.end, options);
  }

  return DecorationSet.create(state.doc, decorations);
}

// ─── 块级装饰 ────────────────────────────────────────────

function addBlockDecorations(
  decos: Decoration[],
  node: Node,
  start: number,
  end: number,
  options: WysiwygOptions
): void {
  // v0.12.1 需求1：标题 → 节点装饰只提供定位上下文，标记由可点击徽标 widget 承担
  if (node.type.name === "heading") {
    const level = Number(node.attrs.level) || 1;
    decos.push(Decoration.node(start, end, { class: "pm-heading-marker" }));
    if (level >= 1 && level <= 6) {
      decos.push(
        Decoration.widget(
          start + 1,
          (view, getPos) => {
            const badge = createHeadingBadge(level, getPos, options);
            // 供 click 处理器判断只读态（widget DOM 不在 React 树里，无法用 context）
            (badge as HTMLElement & { __pmView?: EditorView }).__pmView = view;
            return badge;
          },
          { side: -1, marks: [], ignoreSelection: true },
        ),
      );
    }
    return;
  }

  // 按块类型决定标记文本（不需要标记的块直接返回）
  let marker: string;
  switch (node.type.name) {
    case "blockquote":
      marker = "> ";
      break;
    case "code_block": {
      const lang = node.attrs.language || "";
      marker = "```" + lang;
      break;
    }
    default:
      return;
  }
  // v0.12.0 需求3：Decoration.node 装饰整个节点（PM 会把 class/data 属性应用到
  // 节点 DOM 上，含自定义 NodeView 的 dom——updateInner→updateOuterDeco 自动完成），
  // 标记文本由 CSS ::before 以绝对定位渲染（脱离文档流，零布局影响）
  decos.push(
    Decoration.node(start, end, {
      class: "pm-block-marker",
      "data-md-block-open": marker,
    })
  );
}

// ─── 插件定义 ────────────────────────────────────────────

/**
 * v0.12.1 需求1：工厂化——需要注入标题徽标回调。
 * `wysiwygPlugin`（无回调实例）保留给不关心徽标交互的调用方（如既有单测）。
 */
export function createWysiwygPlugin(options: WysiwygOptions = {}): Plugin<DecorationSet> {
  return new Plugin({
    key: wysiwygKey,

    state: {
      init(_config, state) {
        return computeDecorations(state, options);
      },

      apply(tr, oldDecos, _oldState, newState) {
        // 如果没有文档变化且没有选区变化，复用旧装饰
        if (!tr.docChanged && !tr.selectionSet) {
          return oldDecos;
        }

        // 文档变化时映射旧装饰
        if (tr.docChanged) {
          const mapped = oldDecos.map(tr.mapping, tr.doc);
          // 选区也变化时重新计算
          if (tr.selectionSet) {
            return computeDecorations(newState, options);
          }
          return mapped;
        }

        // 仅选区变化，重新计算
        if (tr.selectionSet) {
          return computeDecorations(newState, options);
        }

        return oldDecos;
      },
    },

    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
  });
}

/** 默认实例（无徽标回调：徽标可见但点击无动作） */
export const wysiwygPlugin = createWysiwygPlugin();
