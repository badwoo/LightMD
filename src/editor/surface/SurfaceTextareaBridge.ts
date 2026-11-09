/**
 * src/editor/surface/SurfaceTextareaBridge.ts —— 双实现期的「ref ↔ SourceSurface」桥
 *
 * ## 这个文件为什么存在（它是 A2 最关键的过渡件）
 *
 * P0 拆分后，`sourceTextareaRef` 仍被 **79 处**直接读取：
 *
 * ```ts
 * const ta = sourceTextareaRef.current;   // 79 处
 * ta.value / ta.selectionStart / ta.setSelectionRange() / ta.scrollTop …
 * ```
 *
 * A 线要把源码面换成 CM6，这些读法必须消失（CM6 没有 textarea 句柄）。
 * 但**一次性改写 79 处**风险极高：一处漏改就是运行期 undefined。
 *
 * 因此引入这一层桥：**对外仍然暴露一个"像 textarea 的东西"**，
 * 但它真正落到谁身上由工厂决定：
 *
 * ```
 *                    ┌─ textarea 实现 → 返回真实 HTMLTextAreaElement（行为 100% 不变）
 * sourceTextareaRef ─┤
 * (本桥的 get())     └─ CM6 实现 → 返回 null（调用方走 surface.* 通道）
 * ```
 *
 * ## 为什么这不算"留双路由"（不会违背设计稿 §10.3）
 *
 * 设计稿要求「立即删、不留双路由」指的是**搜索高亮的 overlay**（`SearchReplace`
 * 自建 div 与 CM6 Decoration 并行）。这里不是并行路由，而是**同一个能力的唯一出口**：
 * 本桥是 `legacyTextareaRef()` 的**唯一消费者**，A3/A2 收敛完成后本文件连同
 * `legacyTextareaRef()` 一起删除，删除点是**单点的**（不会散落在 79 处调用点里）。
 *
 * ## 收敛路径（本文件的生命周期）
 *
 * 1. **现在**：79 处继续 `bridge.current` 拿 textarea（jsdom/回退路径行为不变）；
 * 2. **A2 收敛段**：逐个调用点改成 `surface.getText() / setSelection() / …`；
 * 3. **收敛完成后**：删本文件 + 删 `SourceSurface.legacyTextareaRef()`。
 */

import type { SourceSurface } from "../types";

/** 与 React `RefObject` 同形（`ref.current` 可读写），但值由 SourceSurface 提供 */
export interface SurfaceTextareaBridge {
  /**
   * 当前 textarea 句柄（CM6 实现下恒为 `null`）。
   *
   * ⚠️ 这是**过渡能力**：新代码禁止读它，一律走 `SourceSurface` 方法。
   */
  readonly current: HTMLTextAreaElement | null;
}

/**
 * 为某个 `SourceSurface` 建一个 textarea 桥。
 *
 * `mount` 之前 `current` 为 null（与 React ref 的初始语义一致），
 * 因此调用点里既有的 `if (ta) { … }` 守卫不需要改。
 */
export function createSurfaceTextareaBridge(surface: SourceSurface): SurfaceTextareaBridge {
  return {
    get current(): HTMLTextAreaElement | null {
      return surface.legacyTextareaRef()?.current ?? null;
    },
  };
}
