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

  const handleMove = (ev: MouseEvent) => {
    // 自然方向：往下拖 delta>0 → 上区变高（核心：不取反）
    const delta = ev.clientY - startY;
    const { top, bottom } =
      options?.maxBottom !== undefined
        ? computeSplitExtendable(startTop, startBottom, delta, minHeight, options.maxBottom)
        : computeSplit(startTop, startBottom, delta, minHeight);
    setPair(topKey, bottomKey, top, bottom);
  };
  const handleUp = () => {
    document.removeEventListener("mousemove", handleMove);
    document.removeEventListener("mouseup", handleUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    onEnd?.();
  };
  document.body.style.cursor = "row-resize";
  document.body.style.userSelect = "none";
  document.addEventListener("mousemove", handleMove);
  document.addEventListener("mouseup", handleUp);
}

export interface UseSectionSplitOptions {
  /** 本区 key（标题栏属于本区，拖拽改变"上区 + 本区"的高度分配） */
  selfKey: string;
  /** 上方相邻可见区 key；为空表示本区是最上面一个区域 → 标题栏不可拖拽 */
  prevKey?: string;
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
      // v0.8.0 修复 P9-1：本区是最上面一个可见区域（无上方邻区）→ 标题栏不可拖拽
      const prevKey = opts.prevKey;
      if (!ctx || !prevKey) return;
      const selfKey = opts.selfKey;
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
    },
    [ctx, opts.selfKey, opts.prevKey, opts.maxHeight, minHeight],
  );

  return { onMouseDown, isDragging };
}
