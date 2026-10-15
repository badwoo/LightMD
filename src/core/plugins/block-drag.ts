/**
 * v0.12.0 需求11：块级拖拽移动（鼠标拖动块调整位置）
 *
 * 为什么自制拖拽而非 PM 原生 DnD：
 * Tauri/WebView2 会拦截 HTML5 原生拖放（项目 fileDragMouse 同因自制），
 * 且需求要求「仅手柄区域响应 + 2px 插入指示线」，自制方案完全可控。
 *
 * 交互（方案 A）：
 * - 选中块（单击 / Esc selectParentNode）后，块左侧外缘出现 ⋮⋮ 手柄
 *   （::before 伪元素，纯视觉提示，不进 PM DOM）；
 * - 在**手柄热区**（块左缘外扩 18px）按住左键拖动 → 拖动期间显示插入指示线；
 * - 松开：把块移动到指示位置（一次事务 = 一次撤销单元）；
 * - 仅顶层块（depth<=1）且在 DRAGGABLE_BLOCKS 白名单内；
 *   列表项/引用内部不开放（与既有 Alt+↑/↓ 键盘移动一致，避免破坏 schema）。
 *
 * 与图片拖拽（行内 image draggable）互不冲突：本插件只处理「已选中的顶层块」。
 */
import { NodeSelection, Plugin, PluginKey } from "prosemirror-state";
import type { EditorState, Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";

export const blockDragKey = new PluginKey("blockDrag");

/** 允许鼠标拖拽的顶层块类型；明确排除 toc（由 [toc] 自动生成，移动无意义） */
export const DRAGGABLE_BLOCKS = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "bullet_list",
  "ordered_list",
  "code_block",
  "mermaid_block",
  "math_block",
  "table",
  "horizontal_rule",
]);

/** 手柄热区宽度（块左缘外扩视觉 px，zoom 时按比例换算） */
export const BLOCK_DRAG_HANDLE_WIDTH = 18;

/** 是否允许拖拽该位置的块：白名单类型 + 顶层 */
export function isDraggableBlock(doc: PMNode, pos: number): boolean {
  if (pos < 0 || pos > doc.content.size) return false;
  const node = doc.nodeAt(pos);
  if (!node || !DRAGGABLE_BLOCKS.has(node.type.name)) return false;
  // 顶层判定：pos 位于 doc 直接子节点上（$pos.depth === 0 表示父为 doc）
  return doc.resolve(pos).depth === 0;
}

/**
 * 纯函数：由鼠标落点计算插入位置。
 *
 * - 落点在某顶层块内：按上半/下半决定插到该块前/后（before(1) / after(1)）；
 * - 落点在块间边界（$pos.depth === 0）：直接使用边界位置；
 * - 结果为原位（插到自身前/后）或非法 → null（松开不移动）。
 */
export function computeDropInsertPos(
  doc: PMNode,
  coordsPos: number,
  inUpperHalf: boolean,
  srcPos: number,
): number | null {
  if (coordsPos < 0 || coordsPos > doc.content.size) return null;
  const srcNode = doc.nodeAt(srcPos);
  if (!srcNode) return null;
  const srcEnd = srcPos + srcNode.nodeSize;

  const $pos = doc.resolve(coordsPos);
  const insertPos = $pos.depth === 0 ? coordsPos : (inUpperHalf ? $pos.before(1) : $pos.after(1));
  if (insertPos === srcPos || insertPos === srcEnd) return null;
  return insertPos;
}

/**
 * 纯函数：把 srcPos 处的顶层块移动到 insertPos（返回事务；结构非法时返回 null）。
 * 一次事务完成删除 + 插入（history 记为一次撤销单元）；
 * 删除发生在 insertPos 之前时插入点经 mapping 修正（assoc=1 取删除区间右侧）。
 */
export function buildBlockMoveTr(
  state: EditorState,
  srcPos: number,
  insertPos: number,
): Transaction | null {
  const node = state.doc.nodeAt(srcPos);
  if (!node) return null;
  const tr = state.tr.delete(srcPos, srcPos + node.nodeSize);
  const mapped = tr.mapping.map(insertPos, 1);
  try {
    tr.insert(mapped, node);
  } catch {
    // 结构不合法（理论上不会发生：插入点为顶层边界）→ 取消移动
    return null;
  }
  tr.setSelection(NodeSelection.create(tr.doc, mapped));
  return tr;
}

/**
 * v0.13.0 返修（问题5）：把 srcPos 处的顶层块与相邻块交换（dir = -1 上移 / +1 下移）。
 *
 * 缺陷背景：三点菜单此前把 `dir`（-1/1）**当成文档位置**传给 [`buildBlockMoveTr`]，
 * 后者的第二参数是「插入点位置」而非方向：
 *   - 上移传 -1 → `tr.insert(-1, node)` 抛错 → 被 catch 吞掉 → 返回 null → **静默无反应**；
 *   - 下移传 1  → 把块插到文档位置 1（首个块内部）→ 结构非法 → 同样返回 null。
 * 于是「移动到上方 / 移动到下方」两项完全不可用。这里按方向正确算出插入点。
 *
 * @returns 事务；已在首/末块或结构非法时返回 null
 */
export function buildBlockMoveByDir(
  state: EditorState,
  srcPos: number,
  dir: -1 | 1,
): Transaction | null {
  const doc = state.doc;
  const node = doc.nodeAt(srcPos);
  if (!node) return null;
  // 找到 srcPos 对应的顶层子节点下标（nodeAt 对非顶层位置也会命中，故显式校验）
  let index = -1;
  let acc = 0;
  for (let i = 0; i < doc.childCount; i++) {
    if (acc === srcPos) {
      index = i;
      break;
    }
    acc += doc.child(i).nodeSize;
  }
  if (index < 0) return null;
  const target = index + dir;
  if (target < 0 || target >= doc.childCount) return null;

  // 插入点：上移 = 前一个块的起点；下移 = 后一个块的终点
  const insertPos =
    dir === -1
      ? srcPos - doc.child(index - 1).nodeSize
      : srcPos + node.nodeSize + doc.child(index + 1).nodeSize;
  return buildBlockMoveTr(state, srcPos, insertPos);
}

/** 当前缩放比例（视觉坐标 → 布局坐标换算；jsdom 下回退 1） */
function docZoomRatio(): number {
  try {
    const v = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--doc-zoom"),
    );
    return Number.isFinite(v) && v > 0 ? v : 1;
  } catch {
    return 1;
  }
}

/** 拖拽中的插入指示线（模块级：同一时间仅一个拖拽） */
let dragIndicator: HTMLElement | null = null;

function ensureIndicator(): HTMLElement {
  if (!dragIndicator) {
    dragIndicator = document.createElement("div");
    dragIndicator.className = "block-drag-indicator";
    document.body.appendChild(dragIndicator);
  }
  return dragIndicator;
}

function removeIndicator(): void {
  if (dragIndicator) {
    dragIndicator.remove();
    dragIndicator = null;
  }
}

interface BlockDragState {
  view: EditorView;
  /** 源块起点 */
  srcPos: number;
  /** 当前指示的插入位置（文档坐标）；null = 无效/原位（松开不移动） */
  insertPos: number | null;
}

/**
 * 开始块级拖拽（mousedown 在手柄热区内时调用）。
 * 用 document 级 mousemove/mouseup 跟踪；拖动只做 posAtCoords + 单块 rect 测量
 * （不做全文档测量），大文档下开销可控。
 */
export function beginBlockDrag(view: EditorView, srcPos: number, startEvent: MouseEvent): void {
  const node = view.state.doc.nodeAt(srcPos);
  if (!node) return;
  const state: BlockDragState = { view, srcPos, insertPos: null };

  document.body.style.cursor = "grabbing";
  document.body.style.userSelect = "none";

  const updateFromEvent = (e: MouseEvent) => {
    const coords = view.posAtCoords({ left: e.clientX, top: e.clientY });
    if (!coords) {
      state.insertPos = null;
      removeIndicator();
      return;
    }
    const doc = view.state.doc;
    const $pos = doc.resolve(coords.pos);

    // 目标块几何与"上半/下半"判定（指示线画在目标块的 top/bottom）
    let inUpperHalf = true;
    let lineY = 0;
    let lineLeft = 0;
    let lineWidth = 0;
    if ($pos.depth > 0) {
      const before = $pos.before(1);
      const dom = view.nodeDOM(before) as HTMLElement | null;
      if (!dom || !dom.getBoundingClientRect) {
        state.insertPos = null;
        removeIndicator();
        return;
      }
      const rect = dom.getBoundingClientRect();
      inUpperHalf = e.clientY < rect.top + rect.height / 2;
      lineY = inUpperHalf ? rect.top : rect.bottom;
      lineLeft = rect.left;
      lineWidth = rect.width;
    } else {
      const next = view.nodeDOM(coords.pos);
      const el =
        (next instanceof HTMLElement ? next : null) ?? (view.dom as HTMLElement);
      const rect = el.getBoundingClientRect();
      lineY = next ? rect.top : rect.bottom;
      lineLeft = rect.left;
      lineWidth = rect.width;
    }

    const insertPos = computeDropInsertPos(doc, coords.pos, inUpperHalf, srcPos);
    if (insertPos === null) {
      state.insertPos = null;
      removeIndicator();
      return;
    }
    state.insertPos = insertPos;
    const ind = ensureIndicator();
    ind.style.top = `${lineY - 1}px`;
    ind.style.left = `${lineLeft}px`;
    ind.style.width = `${lineWidth}px`;
    ind.style.display = "block";
  };

  const onMove = (e: MouseEvent) => {
    e.preventDefault();
    updateFromEvent(e);
  };

  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    removeIndicator();

    const insertPos = state.insertPos;
    if (insertPos === null) return;
    const tr = buildBlockMoveTr(view.state, srcPos, insertPos);
    if (tr) view.dispatch(tr);
  };

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
  startEvent.preventDefault();
}

/**
 * 拖拽插件：在编辑器内 mousedown 时判定「手柄热区 + 可拖块」→ 开始拖拽。
 * 其余 mousedown 一律放行（不影响选文字/点击）；mousemove 仅在热区显示 grab 光标。
 *
 * v0.13.0 返修（问题3）：**不再要求先有 NodeSelection**。
 *
 * 缺陷背景：v0.12.0 要求「块已被 NodeSelection 选中」才允许从手柄拖拽；而
 * v0.13.0 的「单击即编辑」让普通块单击只放光标（TextSelection），块几乎永远不会
 * 进入 NodeSelection → 手柄虽然显示却拖不动，用户感知为「手柄失效/被去掉」。
 *
 * 现在改为：mousedown 落在「某顶层块的左缘热区」内即开始拖拽该块，与当前选区无关。
 */
export function blockDragPlugin(): Plugin {
  /** 由鼠标坐标找出落点所在的顶层块起点（不在任何块内 → null） */
  function topLevelBlockAt(view: EditorView, clientX: number, clientY: number): number | null {
    const coords = view.posAtCoords({ left: clientX, top: clientY });
    if (!coords) return null;
    const doc = view.state.doc;
    const $pos = doc.resolve(coords.pos);
    // 落点在块间边界（depth 0）时取其后紧邻的块
    if ($pos.depth === 0) {
      const node = doc.nodeAt(coords.pos);
      return node ? coords.pos : null;
    }
    return $pos.before(1);
  }

  /** 顶层块的起点位置列表（用于候选回退） */
  function topLevelStarts(doc: EditorView["state"]["doc"]): number[] {
    const out: number[] = [];
    let acc = 0;
    for (let i = 0; i < doc.childCount; i++) {
      out.push(acc);
      acc += doc.child(i).nodeSize;
    }
    return out;
  }

  /** 坐标是否落在该块的「手柄热区」内（块左缘外扩 BLOCK_DRAG_HANDLE_WIDTH） */
  function inHandleZone(view: EditorView, pos: number, clientX: number, clientY: number): boolean {
    const dom = view.nodeDOM(pos) as HTMLElement | null;
    if (!dom || !dom.getBoundingClientRect) return false;
    const rect = dom.getBoundingClientRect();
    const handleW = BLOCK_DRAG_HANDLE_WIDTH * docZoomRatio();
    return (
      clientX >= rect.left - handleW &&
      clientX <= rect.left + 2 &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    );
  }

  /**
   * 找出「手柄热区包含该坐标」的顶层块。
   *
   * 为什么要候选回退：`posAtCoords` 返回的是**离坐标最近的文档位置**，而手柄热区
   * 在块的左缘**外**（正文区之外）。鼠标停在 A 块左缘外时，最近位置可能是上一块
   * 的末尾而不是 A 的开头 → 直接判定会落到错误的块（拖错块或干脆拖不动）。
   * 因此以解析结果为中心，连同前后各 2 个顶层块一起试，取第一个热区命中的。
   * 只做常数个 `getBoundingClientRect`，大文档下开销可控（不遍历全文档）。
   */
  function handleZoneBlockAt(
    view: EditorView,
    clientX: number,
    clientY: number,
  ): number | null {
    const starts = topLevelStarts(view.state.doc);
    if (starts.length === 0) return null;
    const hit = topLevelBlockAt(view, clientX, clientY);
    const center = hit == null ? 0 : starts.indexOf(hit);
    const base = center < 0 ? 0 : center;
    for (const delta of [0, -1, 1, -2, 2]) {
      const idx = base + delta;
      if (idx < 0 || idx >= starts.length) continue;
      const pos = starts[idx];
      if (!isDraggableBlock(view.state.doc, pos)) continue;
      if (inHandleZone(view, pos, clientX, clientY)) return pos;
    }
    return null;
  }

  return new Plugin({
    key: blockDragKey,
    props: {
      handleDOMEvents: {
        mousedown(view, event) {
          if (event.button !== 0) return false;
          // 落在块内交互控件（三点菜单 / 语言下拉 / 表格工具栏）上时放行
          const target = event.target as HTMLElement | null;
          if (target?.closest?.("button, select, input, textarea, a, .table-toolbar")) return false;
          // v0.13.0 返修（问题3）：按「热区命中」找块（posAtCoords 在块外会吸附到邻块）
          const pos = handleZoneBlockAt(view, event.clientX, event.clientY);
          if (pos == null) return false;
          beginBlockDrag(view, pos, event);
          return true;
        },
        // hover 到手柄热区时显示 grab 光标（伪元素不能单独设 cursor，按坐标判定）
        mousemove(view, event) {
          const dom0 = view.dom as HTMLElement;
          const pos = handleZoneBlockAt(view, event.clientX, event.clientY);
          const want = pos != null ? "grab" : "";
          if (dom0.style.cursor !== want) dom0.style.cursor = want;
          return false;
        },
      },
      // v0.13.0 需求1：光标/选区落在某块内时，给该块加 `.pm-block-active`
      // （手柄与三点菜单的「常驻」显示条件之一）。选中态（NodeSelection）另由
      // 各 NodeView 的 selectNode 加 `.pm-block-selected`，两者在 CSS 里并列。
      decorations(state) {
        const { selection } = state;
        // NodeSelection 已由 selectNode 处理，跳过（避免重复劳动）
        if (selection instanceof NodeSelection) return null;
        const $from = selection.$from;
        // 光标在文本节点内部（表格单元格等）：取深度为 1 的顶层块
        let depth = $from.depth;
        while (depth > 0 && $from.node(depth).isInline) depth--;
        if (depth < 1) return null;
        const pos = $from.before(1);
        const dom = state.doc.nodeAt(pos);
        if (!dom) return null;
        return DecorationSet.create(state.doc, [
          Decoration.node(pos, pos + dom.nodeSize, { class: "pm-block-active" }),
        ]);
      },
    },
  });
}