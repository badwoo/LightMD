/**
 * v0.17.0 P1（右屏回声返修）：分屏左 → 右滚动同步的**物理约束策略**。
 *
 * ## 为什么抽这个模块（本轮返修记录）
 * 阈值 `ALLOW_RATIO` / `ALLOW_ABS` 原先内联在 `PreviewPane.tsx` 的
 * `computePreviewTarget` 里，测试只能用**源码文本正则**断言
 * `const ALLOW_ABS = 60;` —— R5 把 60 改成 16 后测试变确定性失败
 * （不是 flaky，是断言与实现永远对不上）。
 * 现在：**生产与测试 import 同一常量、同一纯函数**，测试断言行为
 * （连续钳制的真值表 + 时序回放），不再断言源码文本里的数值。
 *
 * ## 判据来源（全部实测，不是推演）
 * 两屏是同一份内容的两种排版，左屏平移 `ΔL` 像素时右屏只应在
 * `ΔL × 高度比` 同量级移动。实测比值：
 *
 * | 场景 | 左屏 Δ | 右屏 Δ | 比值 |
 * |---|---|---|---|
 * | 正常跟随（回车，打字机开） | +28 | +20 | 0.68 |
 * | 正常跟随（光标下移） | +15 | +11 | 0.73 |
 * | 用户滚轮 | 大 | 同量级 | 0.6~0.8 |
 * | **R4 异常猛跳** | **+13** | **+188** | **14.5** |
 * | **R5 残余错跳** | **+1.34** | **+28.66** | **21.4** |
 *
 * ⇒ `ALLOW_RATIO = 3`（正常比值的 4 倍余量）。
 *
 * ## `ALLOW_ABS` 为什么是 16（v0.17.0 第五轮真机验证，60 → 16）
 * 它兜"`ΔL≈0` 但右屏需要小幅吸附"的正常场景（文档首尾、块间距跳变处）。
 * **实测这类吸附是 4~11px** → 16 留 ~45% 余量；
 * 而 60 曾在动画起始帧（`ΔL=1.34` → `allowed=60`）放过一次 **28.66px** 的
 * 残余错跳 —— 60 比"真正要拦的量级"还大，等于把防线关掉了。
 *
 * | 场景 | ΔL | allowed | 判定 |
 * |---|---|---|---|
 * | 正常吸附（首尾/块间距） | ~0 | **16** | 4~11px 原值放行 ✅ |
 * | 动画起始帧错写（R5 残余缺陷） | 1.34 | 16 | **28.66px 钳到 16** ✅ |
 * | 正常跟随（打字一行） | ~28 | 84 | 原值放行 ✅ |
 * | 正常跟随（插入代码块） | ~58 | 174 | 原值放行 ✅ |
 * | R4 修掉的猛跳 | ~13 | 39 | 188px 钳到 39 ✅ |
 *
 * ## 二值拒绝 → 有界连续钳制（P1 返修的本体）
 * 旧逻辑（R4/R5）：`dRight > allowed` 时 `return null` **拒写**，但
 * `lastAcceptedPreviewTarget/lastAcceptedSourceTop` 两个基准**不更新**：
 * 下一帧 `dLeft` 从陈旧基准累积 → `allowed = max(ALLOW_ABS, dLeft×3)` 越攒越大
 * → 累计跳变被**整包放行**（实测 3 个非内容驱动脱同步帧 + 1 次方向反转，
 * 单帧最大 46px）—— 用户看到"右屏先不动、再猛跳"的延迟释放。
 *
 * 新逻辑（本模块）：每帧最多走 `allowed`，余量由后续帧逐帧追上：
 * - 位移在阈值内 → 原值放行（正常跟随零损失）；
 * - 超阈值 → 本帧只走 `allowed`，右屏**平滑追上**而非不动后猛跳；
 * - 基准每帧更新（含被钳制的帧）→ 基准永不陈旧，延迟释放在机制上不可能发生。
 */

/**
 * 两屏位移幅度比上限（正常 0.68/0.73 的 4 倍余量）。
 * 由 `PreviewPane.tsx`（生产）与 `v0170-r4-enter.test.ts`（测试）共享。
 */
export const ALLOW_RATIO = 3;

/**
 * 绝对量兜底（px）：兜"`ΔL≈0` 但右屏需要小幅吸附"的场景。
 * 实测吸附 4~11px → 16 留 ~45% 余量；见文件头推导表。
 */
export const ALLOW_ABS = 16;

/**
 * 本帧允许的右屏位移上限（含绝对量兜底）：
 * `allowed = max(ALLOW_ABS, |ΔL| × ALLOW_RATIO)`。
 *
 * ⚠️ 是**取大者**（不是取小者）：`ΔL` 小时绝对量兜底占优，
 * 这是"左屏几乎没动时也允许小幅吸附"这道防线的直接体现。
 *
 * @param dLeft 同期左屏 scrollTop 变化量（内部取绝对值）
 */
export function previewAllowedMove(dLeft: number): number {
  return Math.max(ALLOW_ABS, Math.abs(dLeft) * ALLOW_RATIO);
}

/**
 * 有界连续钳制：返回本帧右屏应写入的目标值。
 *
 * - `lastAccepted === null`（首帧）→ 原值放行；
 * - `|next - lastAccepted| <= allowed` → 原值放行（正常跟随零损失）；
 * - 超出 → 沿 `next` 方向最多走 `allowed`（平滑追上，不是拒写）；
 * - `next` / `allowed` 非有限 → **原地不动**（映射算坏时绝不写入垃圾值）。
 *
 * @param lastAccepted 上一帧已接受（写入）的右屏目标值；首帧为 null
 * @param next         本帧映射出的原始目标值
 * @param allowed      本帧允许的位移上限（`previewAllowedMove` 给出）
 */
export function clampPreviewTarget(
  lastAccepted: number | null,
  next: number,
  allowed: number,
): number {
  if (lastAccepted === null) return next;
  const delta = next - lastAccepted;
  if (!Number.isFinite(delta) || !Number.isFinite(allowed) || allowed < 0) {
    return lastAccepted;
  }
  return lastAccepted + Math.sign(delta) * Math.min(Math.abs(delta), allowed);
}
