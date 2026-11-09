/**
 * src/editor/createSourceSurface.ts —— SourceSurface 工厂（唯一选型入口）
 *
 * ## 职责边界
 *
 * 只做一件事：**决定这一次该用哪个实现**。它不知道 CM6 细节、也不知道 textarea 细节
 * —— 它是两条实现的**唯一交叉点**。
 *
 * ## 为什么必须有这个工厂（A 线生命线）
 *
 * P0 有 6600+ 条既有测试，**绝大部分跑在 jsdom 里**。实测（见下方「实测依据」）
 * jsdom 下 CM6 **可以构造**但**测不了布局**（`coordsAtPos` 直接抛）。
 * 如果 CM6 写死在容器里，A1 一落地就会大面积红，且无法区分"拆分错了"与"环境不支持"。
 *
 * 因此选型在**运行时**判定，且**拿不准时退回 textarea**：
 *
 * ```
 *                        ┌─ jsdom / 无 DOM ──────────────→ TextareaSourceSurface（回退）
 * createSourceSurface ───┼─ 真实浏览器 + 能力探测通过 ──→ CmSourceSurface
 *                        └─ 探测失败 ───────────────────→ TextareaSourceSurface（回退）
 * ```
 *
 * ⚠️ **回退是静默的、必须的**：它是**双实现期的正式选型策略**，也是设计稿 §8
 * 要求的「回退开关」——任何时候都能整体换回 textarea。
 *
 * ## 实测依据（2026-11-09 在 vitest jsdom 环境实测，不是推测）
 *
 * | 探测手段 | jsdom 实测值 | 能否当判据 |
 * |---|---|---|
 * | `new EditorView({...})` 是否抛 | **不抛** | ❌ 不能 —— jsdom 下构造是成功的 |
 * | `view.scrollDOM.clientHeight` | **0** | ❌ 不能 —— 真实浏览器里容器未挂载/隐藏时也是 0 |
 * | `view.coordsAtPos(0)` 是否抛 | **抛** | ✅ 能，但只能在**已挂载后**探测 |
 * | `navigator.userAgent` 含 jsdom | 是 | ✅ 能，零代价、最直接 |
 *
 * 结论：**UA 判定为主**（零代价、确定），`coordsAtPos` 作为挂载后的补充复核。
 * 绝不把 `clientHeight === 0` 当判据 —— 那会把真实浏览器的合法状态误判成 jsdom，
 * 导致 CM6 永远不启用（静默退化，比直接报错更难发现）。
 *
 * ## 显式 override（测试与探针用）
 *
 * `createSourceSurface({ impl: "textarea" | "cm6" })` 强制选型：
 * - 契约测试用 `"textarea"` 在 jsdom 里跑同一套**行为**断言（不依赖 CM6 可用性）；
 * - 冒烟探针用 `"cm6"` 在真实浏览器里验证 CM6 路径；
 * - 不传 = 自动判定（生产路径）。
 */

import type { SourceSurface } from "./types";
import { TextareaSourceSurface } from "./surface/TextareaSourceSurface";
import { CmSourceSurface } from "./cm6/CmSourceSurface";

export type SourceSurfaceImpl = "cm6" | "textarea";

export interface CreateSourceSurfaceOptions {
  /**
   * 强制实现（**仅测试 / 探针使用**；生产不传 = 自动判定）。
   *
   * 刻意保留的逃生口：契约测试必须能在 jsdom 里断言"接口行为"，
   * 而不是被迫依赖真实浏览器的 CM6 能不能跑。
   */
  impl?: SourceSurfaceImpl;
}

/**
 * 是否跑在 jsdom / 非浏览器环境（零代价判定）。
 *
 * 判据：
 * 1. UA 含 jsdom（vitest 的 jsdom 环境就这么标，最直接且确定）；
 * 2. 根本没有 document/window（node 直跑逻辑测试）。
 */
export function isJsdomLike(): boolean {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent ?? "" : "";
  if (/jsdom/i.test(ua)) return true;
  if (typeof document === "undefined" || typeof window === "undefined") return true;
  return false;
}

/**
 * CM6 是否可以启用（**廉价**探测，不构造实例）。
 *
 * 只做"明显不可用"的排除；真正的布局可用性由 `CmSourceSurface.mount()` 内的
 * 后置复核兜底（见文件头实测表格）。
 */
export function canUseCm6(): boolean {
  if (isJsdomLike()) return false;
  if (typeof document === "undefined" || typeof window === "undefined") return false;
  // jsdom 缺 Range.getClientRects（CM6 的 TextTile.coordsIn 直接调用它 → 抛）。
  // 这条是比 UA 更强的能力判据，作为双保险：UA 可能被环境改写，缺 API 是硬事实。
  try {
    const r = document.createRange();
    if (typeof r.getClientRects !== "function") return false;
    // 再探一次：jsdom 的 getClientRects 存在但返回空 DOMRectList 且无 layout
    const rects = r.getClientRects?.();
    if (!rects || typeof rects.length !== "number") return false;
  } catch {
    return false;
  }
  // CM6 依赖的浏览器 API；缺任一都不必尝试
  if (typeof MutationObserver !== "function") return false;
  if (typeof Range !== "function") return false;
  if (typeof requestAnimationFrame !== "function") return false;
  return true;
}

/**
 * 创建一个 SourceSurface（**尚未 mount**）。
 *
 * 调用方拿到实例后自己 `mount(host, opts)` —— 与既有 textarea 路径的时序一致
 * （A 线不改宿主的挂载时机）。
 */
export function createSourceSurface(opts: CreateSourceSurfaceOptions = {}): SourceSurface {
  const forced = opts.impl;

  if (forced === "textarea") return new TextareaSourceSurface();

  if (forced === "cm6") {
    // 强制 CM6 时**不静默回退**：测试/探针要的是"CM6 到底能不能跑"的明确结论，
    // 静默回退会让探针误判为"CM6 已启用"。
    return new CmSourceSurface();
  }

  // 生产路径：能力足够才用 CM6，否则回退（正式策略，非错误兜底）
  if (canUseCm6()) return new CmSourceSurface();
  return new TextareaSourceSurface();
}
