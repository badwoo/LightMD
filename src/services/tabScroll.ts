/**
 * v0.8.0 WP3 需求5：标签溢出滚动的纯函数判定。
 * 抽成纯函数便于单元测试，组件只负责把 DOM 量喂进来。
 */

/**
 * 计算滚轮滚动后的 scrollLeft。
 * 滚轮往下（deltaY > 0）→ 看右侧标签 → scrollLeft 增大；往上 → 减小。
 */
export function applyWheelScroll(currentScrollLeft: number, deltaY: number): number {
  return currentScrollLeft + deltaY;
}

/**
 * v0.8.0 修复 P12-2：滚轮增量归一化。
 *
 * 不同设备/浏览器的 WheelEvent.deltaMode 不同（像素 / 行 / 页）。旧实现直接使用
 * deltaY：对"按行滚动"的鼠标，每格只移动 3px，手感很涩；对"按页"的设备又过大。
 * 统一换算为像素后，滚轮速度才在各种设备上一致。
 *
 * @param deltaMode  0=像素 1=行 2=页
 * @param lineHeight 一行的高度（标签栏一行 ≈ 16px）
 * @param pageHeight 一页的高度（默认按 10 行估算）
 */
export function normalizeWheelDelta(
  deltaY: number,
  deltaMode: number,
  lineHeight = 16,
  pageHeight = 0,
): number {
  if (deltaMode === 1) return deltaY * lineHeight;
  if (deltaMode === 2) return deltaY * (pageHeight > 0 ? pageHeight : lineHeight * 10);
  return deltaY;
}

/** 把 scrollLeft 钳制到 [0, scrollWidth - clientWidth] */
export function clampScrollLeft(
  left: number,
  clientWidth: number,
  scrollWidth: number,
): number {
  const max = Math.max(0, scrollWidth - clientWidth);
  return Math.min(max, Math.max(0, left));
}

/**
 * v0.8.0 修复 P12-2：缓动逼近目标位置（每个动画帧调用一次）。
 *
 * 指数衰减：next = current + (target - current) * factor。
 * 单帧剩余位移小于 1px 时直接吸附到目标 —— 调用方据此结束动画，
 * 因此只在滚动过程中有开销（一个 rAF 循环），静止时零开销、无定时器。
 */
export function computeSmoothedScroll(current: number, target: number, factor = 0.3): number {
  const diff = target - current;
  if (Math.abs(diff) < 1) return target;
  return current + diff * factor;
}

/**
 * v0.8.0 修复 P12-3：把指定标签滚动到可视区。
 *
 * 覆盖"打开新文档 / 切换标签 / 新建临时文件"三种场景（都会改变活跃标签）。
 * 已完全可见时返回 null（不滚动，避免无意义的视口抖动）。
 *
 * @returns 需要设置的 scrollLeft；无需滚动时返回 null
 */
export function computeScrollToReveal(
  itemLeft: number,
  itemWidth: number,
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number,
): number | null {
  if (clientWidth <= 0) return null;
  const itemRight = itemLeft + itemWidth;
  const viewRight = scrollLeft + clientWidth;
  if (itemLeft >= scrollLeft && itemRight <= viewRight) return null;
  // 标签在左侧被遮住 → 对齐到左边缘；在右侧被遮住 → 对齐到右边缘
  const target = itemLeft < scrollLeft ? itemLeft : itemRight - clientWidth;
  return clampScrollLeft(target, clientWidth, scrollWidth);
}

/**
 * v0.8.0 修复 P5-1：标签是否已铺满（横向溢出）。
 *
 * 需求5 问题1：用户期望"标签铺满后，最右侧成对出现 < > 两个按钮"。
 * 旧实现用 shouldShowLeftBtn(scrollLeft>0) 决定左按钮是否渲染，
 * 起始位置 scrollLeft=0 时左按钮根本不渲染 → 用户只看到一个 ">"。
 * 现改为"溢出即同时显示两个按钮"，到边界时用禁用态表示不可再滚。
 */
export function hasOverflow(clientWidth: number, scrollWidth: number): boolean {
  return scrollWidth > clientWidth + 1;
}

/** 是否已滚到最左端（左按钮禁用） */
export function isAtStart(scrollLeft: number): boolean {
  return scrollLeft <= 0;
}

/** 是否已滚到最右端（右按钮禁用） */
export function isAtEnd(scrollLeft: number, clientWidth: number, scrollWidth: number): boolean {
  return scrollLeft + clientWidth >= scrollWidth - 1;
}

/** 是否显示"向左滚动"按钮：已向右滚动（scrollLeft > 0）才需要 */
export function shouldShowLeftBtn(scrollLeft: number): boolean {
  return scrollLeft > 0;
}

/** 是否显示"向右滚动"按钮：右侧仍有未显示内容（scrollLeft + clientWidth < scrollWidth - 1） */
export function shouldShowRightBtn(
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number
): boolean {
  return scrollLeft + clientWidth < scrollWidth - 1;
}
