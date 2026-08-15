/**
 * useResizable —— 可复用的鼠标拖拽调整宽度/高度/比例 hook
 *
 * 支持四种方向：
 * - "left"：左侧栏（拖右移→宽度增加）
 * - "right"：右侧栏（拖左移→宽度增加）
 * - "split"：分屏模式（按容器总宽计算 ratio，钳制 0.3~0.7）
 * - "vertical"：垂直方向（拖下移→高度增加，钳制 minHeight~maxHeight）
 *
 * 设计要点：
 * - 用 useRef 追踪拖拽中间状态，避免重渲染
 * - 用 useState 触发宽度/高度/比例更新，驱动 UI
 * - 拖拽中锁定 body 光标和用户选择，结束时恢复
 * - 向后兼容：left/right/split 逻辑不变，vertical 为新增能力
 */
import { useCallback, useRef, useState } from "react";

export interface UseResizableOptions {
  /** 初始宽度(px) - left/right 方向用 */
  initialWidth?: number;
  /** 最小宽度(px) - left/right 方向用 */
  minWidth?: number;
  /** 最大宽度(px) - left/right 方向用 */
  maxWidth?: number;
  /** 初始高度(px) - vertical 方向用 */
  initialHeight?: number;
  /** 最小高度(px) - vertical 方向用 */
  minHeight?: number;
  /** 最大高度(px) - vertical 方向用 */
  maxHeight?: number;
  /** 拖拽方向 */
  direction: "left" | "right" | "split" | "vertical";
  /** 初始分屏比例（direction === "split" 时使用，默认 0.5） */
  initialRatio?: number;
  /** 尺寸变化回调（left/right 传 width，vertical 传 height） */
  onChange?: (size: number) => void;
  /** 分屏比例回调（direction === "split" 时触发） */
  onSplitChange?: (ratio: number) => void;
}

export interface UseResizableResult {
  /** 当前宽度(px) - left/right 方向 */
  width: number;
  /** 当前高度(px) - vertical 方向 */
  height: number;
  /** 当前分屏比例（0.3~0.7） */
  ratio: number;
  /** 是否正在拖拽 */
  isDragging: boolean;
  /** 绑定到分割条 mousedown 的事件处理器 */
  onMouseDown: (e: React.MouseEvent) => void;
}

/** 钳制到 [min, max] */
function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

export function useResizable(options: UseResizableOptions): UseResizableResult {
  const {
    initialWidth,
    minWidth,
    maxWidth,
    initialHeight,
    minHeight,
    maxHeight,
    direction,
    initialRatio = 0.5,
    onChange,
    onSplitChange,
  } = options;
  const [width, setWidth] = useState(initialWidth ?? 0);
  const [height, setHeight] = useState(initialHeight ?? 0);
  const [ratio, setRatio] = useState(initialRatio);
  const [isDragging, setIsDragging] = useState(false);

  // 拖拽中间状态（不触发重渲染）
  const dragStateRef = useRef({
    startX: 0,
    startY: 0,
    startWidth: 0,
    startHeight: 0,
    startRatio: 0.5,
    containerWidth: 0,
  });

  // 最新回调引用，避免闭包陈旧
  const onChangeRef = useRef(onChange);
  const onSplitChangeRef = useRef(onSplitChange);
  onChangeRef.current = onChange;
  onSplitChangeRef.current = onSplitChange;

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      const ds = dragStateRef.current;

      if (direction === "vertical") {
        // Issue 3 修复：resizer 在区域上方，往下拖应减小区域高度（上方空间增大），
        // 往上拖应增大区域高度（上方空间减小）。因此 delta 取反。
        const delta = e.clientY - ds.startY;
        const newHeight = clamp(ds.startHeight - delta, minHeight ?? 0, maxHeight ?? Infinity);
        setHeight(newHeight);
        onChangeRef.current?.(newHeight);
      } else if (direction === "split") {
        // split 模式：按容器总宽计算 ratio
        const cw = ds.containerWidth || 1;
        const delta = e.clientX - ds.startX;
        // delta 正→左侧变宽→ratio 增加
        const newRatio = clamp(ds.startRatio + delta / cw, 0.3, 0.7);
        setRatio(newRatio);
        onSplitChangeRef.current?.(newRatio);
      } else if (direction === "left") {
        // 左侧栏：拖右移(delta 正)→宽度增加
        const delta = e.clientX - ds.startX;
        const newWidth = clamp(ds.startWidth + delta, minWidth ?? 0, maxWidth ?? Infinity);
        setWidth(newWidth);
        onChangeRef.current?.(newWidth);
      } else {
        // right 方向：拖左移(delta 正)→宽度增加
        const delta = e.clientX - ds.startX;
        const newWidth = clamp(ds.startWidth - delta, minWidth ?? 0, maxWidth ?? Infinity);
        setWidth(newWidth);
        onChangeRef.current?.(newWidth);
      }
    },
    [direction, minWidth, maxWidth, minHeight, maxHeight]
  );

  const handleMouseUp = useCallback(() => {
    document.removeEventListener("mousemove", handleMouseMove);
    document.removeEventListener("mouseup", handleMouseUp);
    // 恢复 body 样式
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    setIsDragging(false);
  }, [handleMouseMove]);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // 仅响应左键，阻止默认选区行为
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      const ds = dragStateRef.current;
      ds.startX = e.clientX;
      ds.startY = e.clientY;
      ds.startWidth = width;
      ds.startHeight = height;
      ds.startRatio = ratio;
      // split 模式需要容器总宽：取分割条父元素宽度
      if (direction === "split") {
        const parent = (e.currentTarget as HTMLElement).parentElement;
        ds.containerWidth = parent ? parent.getBoundingClientRect().width : 0;
      }

      // 锁定 body 光标和选择（vertical 用 row-resize，其余用 col-resize）
      document.body.style.cursor = direction === "vertical" ? "row-resize" : "col-resize";
      document.body.style.userSelect = "none";
      setIsDragging(true);

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [direction, width, height, ratio, handleMouseMove, handleMouseUp]
  );

  return { width, height, ratio, isDragging, onMouseDown };
}
