/**
 * src/editor/surface/SurfaceTextareaBridge.ts —— 双实现期的「DOM 元素 ↔ SourceSurface」桥
 *
 * ## 这个文件为什么存在（A2 最关键的过渡件）
 *
 * P0 拆分后，`sourceTextareaRef` 仍被 **79 处**直接读取：
 *
 * ```ts
 * const ta = sourceTextareaRef.current;   // 79 处
 * ta.value / ta.selectionStart / ta.setSelectionRange() / ta.scrollTop …
 * ```
 *
 * A 线要把源码面换成 CM6，这些读法必须消失（CM6 没有 textarea 句柄）。
 * 但**一次性改写 79 处**风险极高：漏一处就是运行期 undefined。
 *
 * 因此这一层桥对外仍然暴露一个"像 textarea 的东西"，但真正落到谁身上由工厂决定：
 *
 * ```
 *                    ┌─ textarea 实现 → 返回真实 HTMLTextAreaElement（行为 100% 不变）
 * sourceTextareaRef ─┤
 * (本桥)             └─ CM6 实现 → 返回 null（调用方走 surface.* 通道）
 * ```
 *
 * ## 为什么不违背设计稿 §10.3「立即删、不留双路由」
 *
 * 那条要求指的是**搜索高亮的 overlay**（`SearchReplace` 自建 div 与 CM6 Decoration 并行）。
 * 本桥不是并行路由，而是**同一个能力的唯一出口**：它是
 * `SourceSurface.legacyTextareaRef()` 的**唯一消费者**。A2 收敛完成后，
 * 本文件与那个方法**一起单点删除**（删除点不会散落在 79 处调用点里）。
 *
 * ## 生命周期（本文件是临时的）
 *
 * 1. **现在**：79 处继续 `bridge.current` 拿 textarea（jsdom/回退路径行为不变）；
 * 2. **A2 收敛段**：逐个调用点改成 `surface.getText() / setSelection() / …`；
 * 3. **收敛完成后**：删本文件 + 删 `legacyTextareaRef()`。
 */

import type { SourceSurface } from "../types";

/**
 * 与 React `RefObject` 同形的桥。
 *
 * 除 `current` 外还有 `attach`/`detach`：用来把 React 渲染出来的宿主元素交给
 * `SourceSurface.mount()`（CM6 需要把那个元素当 host，textarea 实现直接接管它）。
 */
export interface SurfaceTextareaBridge {
  /**
   * 当前宿主元素（CM6 实现下恒为 `null`，因为 CM6 不提供 textarea 句柄）。
   *
   * ⚠️ **过渡能力**：新代码禁止读它，一律走 `SourceSurface` 方法。
   */
  readonly current: HTMLTextAreaElement | null;

  /** React callback ref 用：元素挂载时把宿主交给 surface */
  attach(el: HTMLTextAreaElement | null): void;
  /** React callback ref 用：元素卸载时销毁 surface */
  detach(): void;
}

/**
 * 为某个 `SourceSurface` 建桥。
 *
 * `mount` 之前 `current` 为 null（与 React ref 初始语义一致），
 * 因此既有的 `if (ta) { … }` 守卫不需要改。
 */
export function createSurfaceTextareaBridge(surface: SourceSurface): SurfaceTextareaBridge {
  return {
    get current(): HTMLTextAreaElement | null {
      return surface.legacyTextareaRef()?.current ?? null;
    },
    attach(el: HTMLTextAreaElement | null): void {
      if (!el) {
        surface.destroy();
        return;
      }
      /**
       * v0.17.0 A2 修复：`initialText` 必须取**宿主元素当前的值**，不能用
       * `surface.getText()`。
       *
       * ## 为什么（实测过的缺陷，不是推测）
       *
       * `getText()` 在 `mount()` **之前**调用时 `this.ta === null` → 返回 `""`。
       * 而 `TextareaSourceSurface.mount()` 里有一句契约要求的写回：
       *
       * ```ts
       * if (ta.value !== opts.initialText) ta.value = opts.initialText;
       * ```
       *
       * 于是启动时序变成：
       * 1. React 受控渲染把 `value={sourceContent}` 写进 textarea（24 字节）；
       * 2. callback ref 触发 `attach()` → `initialText = surface.getText() = ""`；
       * 3. `mount()` 发现 `"# Title…" !== ""` → **`ta.value = ""`**（清空，光标归 0）；
       * 4. React 下一次提交把 `value` 写回同一条内容 —— 但**给 `textarea.value`
       *    赋等长新值会把选区推到文末**（jsdom/浏览器一致，实测
       *    `value=''` 再 `value=<原文>` 后 `selectionStart` 从 12 变 24）。
       *
       * 用户可见后果：撤销后光标不在编辑前位置（`v0151-cross-mode-undo` 实测
       * `abs(pos - mid) = 12`，即跳到文末），三个撤销现场恢复用例全挂。
       *
       * ## 修法
       *
       * 传 `el.value`（React 刚渲染的真实内容）→ `mount()` 的写回条件
       * `ta.value !== opts.initialText` 恒为 false → **完全不碰 DOM**，
       * 受控渲染与选区都不被破坏。同时 `getText()` 在 mount 后立刻正确
       * （`this.ta` 已赋值），契约要求仍然满足。
       *
       * 空元素（新建文档/无内容）时 `el.value === ""` 与 `getText()` 结果相同，无差异。
       */
      surface.mount(el, { initialText: el.value });
    },
    detach(): void {
      surface.destroy();
    },
  };
}
