/**
 * v0.13.2 需求8（返修）：分屏「左右两屏联动滚动」的**方向锁**。
 *
 * ## 用户报告
 * 「分屏模式联动滚动优化完全没有达到要求，现在滚动左屏右屏根本没有跟着联动，
 *  目标是左右两屏能联动滚动，并且左右两屏看到的内容尽量能对齐。」
 *
 * ## 为什么上一版会"根本不联动"/来回跳
 * 上一版用 `isSyncingScrollRef`（同步执行期间置位 + 下一帧解锁）做重入保护。
 * 但浏览器对 `el.scrollTop = x` 派发的 `scroll` 事件是**异步**的（通常下一帧），
 * 等到事件到达时锁早已被 rAF 清掉 → 被同步的一侧把滚动又反推回去：
 *
 *   左滚 → 写右.scrollTop → 右的 scroll 事件（锁已释放）→ 反算并写左.scrollTop
 *   → 左的 scroll 事件 → 再写右 …… 两屏互相拉扯，最终停在随机位置；
 *   实测还会把左屏 `scrollTop` 直接写成 0（用户看到"滚了没反应 / 跳回顶部"）。
 *
 * ## 做法
 * 用一个**带时间窗的方向锁**：谁先发起滚动，谁在 `LOCK_MS` 内拥有同步权；
 * 另一侧在这段时间内收到的 `scroll` 事件一律视为"程序写入的回声"并忽略。
 * 同一侧持续滚动（滚轮连续事件）会不断续期，因此不会中途被回声抢走。
 *
 * 纯逻辑放在这里，`EditorContainer` 只负责读 DOM 度量与写入 scrollTop。
 */

/** 滚动方向（source = 左屏源码 / preview = 右屏渲染） */
export type SplitScrollDirection = "source" | "preview";

/**
 * 方向锁窗口（毫秒）。
 *
 * 必须覆盖浏览器派发程序性 scroll 事件的延迟（下一帧 ≈ 16ms，异步渲染后可能更晚）。
 * 250ms 兼顾两端：足够吃掉回声，又不会让用户"换另一侧滚动"感到明显延迟。
 */
export const SPLIT_SCROLL_LOCK_MS = 250;

export interface ScrollDirectionLock {
  /** 当前拥有同步权的一侧；null = 无 */
  active: SplitScrollDirection | null;
  /** 锁到期时间（performance.now() 口径） */
  until: number;
}

/** 新建一个空锁（每次 effect 重新绑定监听时使用） */
export function createScrollDirectionLock(): ScrollDirectionLock {
  return { active: null, until: 0 };
}

/**
 * 是否接受来自 `dir` 的这次滚动事件。
 *
 * - 同一侧：接受（用户还在滚这一侧，续期由 `markScrollSource` 负责）；
 * - 另一侧 + 锁未过期：拒绝（这是程序写入产生的回声）；
 * - 另一侧 + 锁已过期：接受（用户切换了滚动的那一屏）。
 */
export function shouldAcceptScroll(
  lock: ScrollDirectionLock,
  dir: SplitScrollDirection,
  now: number,
): boolean {
  if (lock.active === dir) return true;
  if (!Number.isFinite(now)) return true;
  return now >= lock.until;
}

/** 登记/续期同步权（在真正执行同步之前调用） */
export function markScrollSource(
  lock: ScrollDirectionLock,
  dir: SplitScrollDirection,
  now: number,
): void {
  lock.active = dir;
  lock.until = (Number.isFinite(now) ? now : 0) + SPLIT_SCROLL_LOCK_MS;
}

/** 清空锁（effect 清理 / 模式切换时） */
export function resetScrollDirectionLock(lock: ScrollDirectionLock): void {
  lock.active = null;
  lock.until = 0;
}
