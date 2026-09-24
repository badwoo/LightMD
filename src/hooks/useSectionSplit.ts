/**
 * useSectionSplit —— 侧栏相邻 section 配对拖拽
 *
 * 语义（v0.8.0 修复 P9-1 重新定义）：
 * - 每个 section 的标题栏位于本区**顶部**，拖动它移动的是「本区上边界」，
 *   即改变「上方相邻区 + 本区」这一对的高度分配（与两区之间的分隔条同一对）；
 * - 因此本区若是第一个可见区域（无上方邻区），其标题栏不可拖拽；
 * - 拖拽 delta 取**自然方向（不取反）**：往下拖 → 上区变高、本区变矮，
 *   本区顶部（标题栏）随上区变高而往下移动；往上拖相反；
 * - 双向钳制 minHeight（80px），并保证两区**总和守恒**（任一区触底时另一区吃掉剩余）。
 *
 * 旧实现把「本区 + 下一区」作为配对：拖动标题栏时本区上边界不变（标题栏钉死），
 * 增量全部落到本区内部的 content 上 → 用户看到"标题栏不动，只是底下区域变大"。
 *
 * 暴露：
 * - computeSplit：纯函数（核心方向/钳制/守恒逻辑，便于单测）
 * - beginSectionDrag：非 hook 版拖拽起点（标题栏与分隔条 .filetree-v-resizer 共用）
 * - useSectionSplit：hook 版（section 组件内经 SectionSizeContext 取高度/写入）
 * - SectionSizeContext：由 FileTree 提供 sizeOf 与 setPair
 */
import { createContext, useCallback, useContext, useState } from "react";

/** 相邻 section 拖拽的最小高度（px） */
export const MIN_SECTION_HEIGHT = 80;

export interface SectionSizeContextValue {
  /** 各 section 的当前高度（按 key；仅记录被拖拽过的区域） */
  sizes: Record<string, number>;
  /**
   * 取某区当前高度（含未拖拽过时的默认值）。
   * v0.8.0 修复 P9-1：拖拽起点必须用与渲染一致的高度，
   * 否则未记录在 sizes 里的区域会以 0 起算，产生跳动。
   */
  sizeOf: (key: string) => number;
  /** 写入一对相邻 section（上区、下区）的新高度 */
  setPair: (topKey: string, bottomKey: string, top: number, bottom: number) => void;
  /** 最小高度（默认 80） */
  minHeight?: number;
}

export const SectionSizeContext = createContext<SectionSizeContextValue | null>(null);

export interface SplitResult {
  top: number;
  bottom: number;
}

/**
 * 纯函数：相邻两区高度按 delta 重分配。
 * @param top     本区（上方）当前高度
 * @param bottom  下区（下方）当前高度
 * @param delta   自然方向位移：往下拖 delta>0 → 本区变高、下区变矮
 * @param minHeight 双向最小高度钳制
 * @returns 新高度，保证 top+bottom 守恒，且均 >= minHeight
 */
export function computeSplit(
  top: number,
  bottom: number,
  delta: number,
  minHeight: number,
): SplitResult {
  const total = top + bottom;
  let newTop = top + delta;
  let newBottom = bottom - delta;
  if (newTop < minHeight) {
    // 上区触底：下区吃掉剩余（总和守恒）
    newTop = minHeight;
    newBottom = total - minHeight;
  } else if (newBottom < minHeight) {
    // 下区触底：上区吃掉剩余
    newBottom = minHeight;
    newTop = total - minHeight;
  }
  // 防御：上述分支已保证 >= minHeight，这里再兜一次非负
  if (newTop < minHeight) newTop = minHeight;
  if (newBottom < minHeight) newBottom = minHeight;
  return { top: newTop, bottom: newBottom };
}

/**
 * v0.8.0 修复 P11-4：纯函数——相邻两区高度按 delta 重分配，并允许"下区"在向上拖时
 * 吞掉容器剩余空间。用于**最后一个可见区域**：用户可以把它一直拖到底部。
 *
 * - delta > 0（向下拖）：与 computeSplit 相同（总和守恒 + 双向 minHeight 钳制）；
 * - delta < 0（向上拖）：下区变大，先由上区让出空间；上区触底（minHeight）后，
 *   下区继续增大，直到 maxBottom（= 容器可用高度）→ 实现"放开到底部"。
 *
 * @param maxBottom 下区在这对配对中允许的最大高度（由容器高度与其他区域高度算出）
 */
export function computeSplitExtendable(
  top: number,
  bottom: number,
  delta: number,
  minHeight: number,
  maxBottom: number,
): SplitResult {
  if (delta >= 0) return computeSplit(top, bottom, delta, minHeight);
  // v0.8.0 修复 P12-4/5：上限不得低于本区当前高度。
  // 旧实现直接用 maxBottom 钳制，当上限被算成 minHeight 而本区已高于它时，
  // "向上拖"会反过来把本区压缩（方向反转）——表现为"拖不动/乱跳"。
  const cap = Math.max(bottom, maxBottom);
  const finalBottom = Math.min(bottom - delta, cap);
  const grown = finalBottom - bottom;
  const newTop = Math.max(minHeight, top - grown);
  return { top: newTop, bottom: finalBottom };
}

/**
 * v0.8.0 修复 P11-4：纯函数——某区域可占用的最大高度。
 * = 容器可视高度 - 其他区域高度之和 - 分隔条总高 - 预留空间（不低于 minHeight）。
 *
 * @param reserved v0.8.0 修复 P12-4/5：额外预留的空间。
 *   - 拖拽上限场景传 minHeight（配对中"上区"至少要留 minHeight，否则总高会溢出容器）；
 *   - 自动填充场景传 0（本区正好填满容器底部）。
 */
export function computeMaxSelfHeight(
  containerHeight: number,
  otherHeights: readonly number[],
  resizerHeight: number,
  resizerCount: number,
  minHeight: number,
  reserved = 0,
): number {
  const used = otherHeights.reduce((s, h) => s + h, 0) + resizerHeight * resizerCount + reserved;
  return Math.max(minHeight, containerHeight - used);
}

/**
 * v0.8.0 修复 P12-4/5：纯函数——最后一个可见区域"向上拖拽"时的最大高度。
 *
 * 取两者中的较大值，保证两个诉求同时成立：
 * ① 守恒上限 = 本区当前高 + (上区当前高 - minHeight)：
 *    即使容器已溢出（多个区域叠加超出可视区），也能通过压缩上区来放大本区。
 *    旧实现只算容器上限，容器溢出时上限被钳到 minHeight，
 *    导致"收藏 + 最近打开"同时打开时最近打开栏拖不动、只有一个文件夹 + 打开的文件时
 *    打开的文件栏也拖不动。
 * ② 容器上限 = 容器高 - 其他区域 - 分隔条 - minHeight：
 *    容器还有空白时，本区可以一直放大到填满底部（需求"放开到底部"）。
 */
export function computeExtendableMaxHeight(
  containerHeight: number,
  topHeight: number,
  bottomHeight: number,
  otherHeights: readonly number[],
  resizerHeight: number,
  resizerCount: number,
  minHeight: number,
): number {
  const conserved = bottomHeight + Math.max(0, topHeight - minHeight);
  const containerLimit = computeMaxSelfHeight(
    containerHeight,
    otherHeights,
    resizerHeight,
    resizerCount,
    minHeight,
    minHeight,
  );
  return Math.max(conserved, containerLimit);
}

/** 拖拽起点（非 hook，供标题栏与分隔条复用） */
export function beginSectionDrag(
  topKey: string,
  bottomKey: string,
  getHeights: () => { top: number; bottom: number },
  setPair: (topKey: string, bottomKey: string, top: number, bottom: number) => void,
  minHeight: number,
  e: React.MouseEvent,
  onStart?: () => void,
  onEnd?: () => void,
  /** v0.8.0 修复 P11-4：给出时启用"可扩展"模式（下区可吞掉剩余空间直到该上限） */
  options?: { maxBottom?: number },
): void {
  if (e.button !== 0) return;
  // 控制按钮（最小化/最大化/关闭等）不触发拖拽，避免误触
  const target = e.target as HTMLElement | null;
  if (target && target.closest("button")) return;
  e.preventDefault();
  e.stopPropagation();

  const { top: startTop, bottom: startBottom } = getHeights();
  const startY = e.clientY;
  onStart?.();

  const handleUp = () => {
    document.removeEventListener("mousemove", handleMove);
    document.removeEventListener("mouseup", handleUp);
    window.removeEventListener("blur", handleUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    // v0.8.2 动画优化：恢复 section 高度过渡
    document.body.classList.remove("section-dragging");
    onEnd?.();
  };
  const handleMove = (ev: MouseEvent) => {
    // v0.8.2 修复："标题栏偶尔拖不动"主根因——拖拽中窗口失焦（Alt+Tab/系统通知/Win 键）
    // 时 mouseup 事件丢失，mousemove 监听器永久残留，残留监听器用旧 startY 持续改写
    // 栏高，新拖拽被旧监听器干扰，直到重启软件才恢复。
    // 检测到鼠标按键已全部松开（buttons === 0）说明拖拽早已结束，立即清理监听。
    if (ev.buttons === 0) {
      handleUp();
      return;
    }
    // 自然方向：往下拖 delta>0 → 上区变高（核心：不取反）
    const delta = ev.clientY - startY;
    const { top, bottom } =
      options?.maxBottom !== undefined
        ? computeSplitExtendable(startTop, startBottom, delta, minHeight, options.maxBottom)
        : computeSplit(startTop, startBottom, delta, minHeight);
    setPair(topKey, bottomKey, top, bottom);
  };
  document.body.style.cursor = "row-resize";
  document.body.style.userSelect = "none";
  // v0.8.2 动画优化：拖拽期间禁用 section 高度过渡（CSS 据此关闭），保证拖拽跟手
  document.body.classList.add("section-dragging");
  document.addEventListener("mousemove", handleMove);
  document.addEventListener("mouseup", handleUp);
  // v0.8.2：窗口失焦兜底——失焦瞬间结束拖拽（mouseup 可能丢失）
  window.addEventListener("blur", handleUp);
}

export interface UseSectionSplitOptions {
  /** 本区 key（标题栏属于本区，拖拽改变"上区 + 本区"的高度分配） */
  selfKey: string;
  /** 上方相邻可见区 key；为空表示本区是最上面一个区域 */
  prevKey?: string;
  /**
   * v0.8.2 功能4：下方相邻可见区 key。
   * 本区无上方邻区（prevKey 为空）且存在下方邻区时，标题栏拖拽改为
   * 调整「本区 + 下区」的高度分配（往下拖 → 本区变高、下区变矮），
   * 修复"第一个可见区域的标题栏拖不动"（如未开文件夹时的"打开的文件"栏）。
   */
  nextKey?: string;
  /** 覆盖最小高度（默认 80） */
  minHeight?: number;
  /**
   * v0.8.0 修复 P11-4：本区高度上限（仅最后一个可见区域会给出）。
   * 给出后启用"可扩展"模式：向上拖标题栏时本区可吞掉容器剩余空间一直拖到底部。
   */
  maxHeight?: number;
}

export interface UseSectionSplitResult {
  onMouseDown: (e: React.MouseEvent) => void;
  isDragging: boolean;
}

/** hook 版：经 SectionSizeContext 取得高度并写入（section 组件内使用） */
export function useSectionSplit(opts: UseSectionSplitOptions): UseSectionSplitResult {
  const ctx = useContext(SectionSizeContext);
  const minHeight = opts.minHeight ?? ctx?.minHeight ?? MIN_SECTION_HEIGHT;
  const [isDragging, setIsDragging] = useState(false);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!ctx) return;
      const selfKey = opts.selfKey;
      // v0.8.0 修复 P9-1：有上方邻区 → 拖「上区 + 本区」，标题栏随上区变高而下移（跟随鼠标）
      if (opts.prevKey) {
        const prevKey = opts.prevKey;
        beginSectionDrag(
          prevKey,
          selfKey,
          () => ({ top: ctx.sizeOf(prevKey), bottom: ctx.sizeOf(selfKey) }),
          ctx.setPair,
          minHeight,
          e,
          () => setIsDragging(true),
          () => setIsDragging(false),
          // v0.8.0 修复 P11-4：最后一个可见区域可一直拖到底部（吞掉容器剩余空间）
          opts.maxHeight !== undefined ? { maxBottom: opts.maxHeight } : undefined,
        );
        return;
      }
      // v0.8.2 功能4：本区是第一个可见区域 → 改拖「本区 + 下区」。
      // 往下拖 delta>0 → 本区变高、下区变矮（与分隔条方向一致）；
      // 本区是唯一可见区域（无上无下）时仍不可拖（无配对对象，高度已自适应）。
      if (opts.nextKey) {
        const nextKey = opts.nextKey;
        beginSectionDrag(
          selfKey,
          nextKey,
          () => ({ top: ctx.sizeOf(selfKey), bottom: ctx.sizeOf(nextKey) }),
          ctx.setPair,
          minHeight,
          e,
          () => setIsDragging(true),
          () => setIsDragging(false),
        );
      }
    },
    [ctx, opts.selfKey, opts.prevKey, opts.nextKey, opts.maxHeight, minHeight],
  );

  return { onMouseDown, isDragging };
}

/**
 * v0.8.2 功能5：按 section key 在 DOM 中查找 section 根元素。
 * key 可能含特殊字符（如 `folder:D:\path`），属性选择器转义繁琐，
 * 故遍历 [data-section-key] 比较值，稳定可靠。
 */
export function findSectionByKey(
  root: Document | HTMLElement,
  key: string,
): HTMLElement | null {
  const all = root.querySelectorAll("[data-section-key]");
  for (const el of Array.from(all)) {
    if ((el as HTMLElement).dataset.sectionKey === key) return el as HTMLElement;
  }
  return null;
}

/**
 * v0.8.2 功能5：纯函数——按"两层 offsetHeight"估算 section 的内容自然高度。
 *
 * 为什么不能直接用 scrollHeight：列表容器被 flex 拉伸（上一栏被撑满）时
 * scrollHeight = max(clientHeight, 内容高) = 拉伸后的高度，测不出真实内容。
 *
 * 两层规则（对 section 的每个直接子元素 child）：
 * - 第一个子元素 = 标题栏（temp/folder/favorites/recent 的 DOM 结构约定），
 *   直接取自身高度（padding 完整计入）；
 * - 其余为内容容器，取 min(容器高, Σ 内部条目高)：
 *   - 被 flex 拉伸（撑满）时：条目之和 = 真实内容高度（小于容器高）→ 取条目和 ✓；
 *   - 无拉伸（内容恰好/压缩）时：本函数只服务于"撑满栏的还原"，此场景下
 *     与 min(prevHeight, ·) 组合结果仍正确（见 FileTree 调用处）；
 *   - 条目为 0（空态提示/折叠 display:none）→ 取容器自身高度。
 * - 树形列表：顶层 wrapper 的 offsetHeight 已包含展开的子树。
 *
 * 子元素为空或总高为 0 时返回 null（无法测量）。
 * 用结构类型（而非 HTMLElement）以便单测注入假 DOM 树。
 */
export interface HeightNode {
  offsetHeight: number;
  children: ArrayLike<HeightNode>;
}

export function measureContentHeight(node: HeightNode | null): number | null {
  if (!node) return null;
  const kids = Array.from(node.children);
  if (kids.length === 0) return null;
  let total = 0;
  kids.forEach((k, idx) => {
    const grandSum = Array.from(k.children).reduce((s, g) => s + g.offsetHeight, 0);
    const h =
      idx > 0 && grandSum > 0 ? Math.min(k.offsetHeight, grandSum) : k.offsetHeight;
    total += h;
  });
  return total > 0 ? total + 2 : null; // +2：section 自身上下 border
}

/**
 * v0.8.2 功能5：测量 section 的内容自然高度（标题栏 + 内容，不含被撑高产生的空白）。
 * 找不到元素或测不出时返回 null。
 */
export function measureSectionContentHeight(section: HTMLElement | null): number | null {
  if (!section) return null;
  // DOM 的 HTMLCollection 元素类型在 TS 层面是 Element（无 offsetHeight 定义），
  // 运行时读取是安全的；此处收敛为 HeightNode 结构后再复用纯函数
  const kids: HeightNode[] = Array.from(section.children).map((el) => {
    const he = el as HTMLElement;
    return {
      offsetHeight: he.offsetHeight,
      children: Array.from(he.children).map((g): HeightNode => ({
        offsetHeight: (g as HTMLElement).offsetHeight,
        children: [],
      })),
    };
  });
  return measureContentHeight({ offsetHeight: section.offsetHeight, children: kids });
}
