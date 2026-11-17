import { describe, it, expect } from "vitest";
import {
  clampPreviewTarget,
  previewAllowedMove,
  ALLOW_ABS,
  ALLOW_RATIO,
} from "../utils/scrollSyncPolicy";
import {
  isPreviewGeometrySane,
  previewGeometryOf,
  PREVIEW_MIN_SANE_WIDTH_PX,
  PREVIEW_MAX_SANE_ASPECT,
} from "../utils/previewGeometry";

/**
 * v0.17.1 第三轮：**双击 Shift 开/关预览后两屏不对齐** 的纯函数契约
 *
 * ## 用户问题
 * > 「双击 ctrl 切换模式，文档对齐和阅读进度丢失问题貌似是解决了，但在编辑模式
 * >  通过双击 shift 键来打开或关闭预览文档又没对齐了」
 * > 「双击shift开关，右屏会比左屏超前好几段内容，但通过鼠标滚动文档，
 * >  左右屏文档又慢慢对齐了」
 *
 * ## 实测根因（`scripts/_tmp-q1.mjs` trace，用户真实文档）
 * ```
 * next=21826（映射算出的正确目标）
 * clamped: 23918 → ... → 23424 → 23408 → 23392 → 23376   ← 每帧只走 16px
 * realign 链在 1600ms 结束 → 停在 23376，永远到不了 21826
 * ```
 * `bounded-chase` 每帧只允许 `ALLOW_ABS=16px`（因为左屏已跳完，`dLeft=0`），
 * 要跨 2090px 需 131 帧 ≈ 2.2s，而 realign 链 1600ms 就结束。
 *
 * "滚动一下又对齐"的解释：滚动时 `dLeft` 变大 → `allowed = dLeft×3` 变大
 * → 单帧走得更多 → 若干帧后追上。**不是自愈，是让 allowed 变大而已。**
 *
 * ## 修复
 * `clampPreviewTarget` 新增 `force` 参数：开合预览后的**程序主动对齐**跳过逐帧钳制。
 * 用户滚动路径不传 force，平滑跟随语义一字未变。
 */

describe("修复核心：clampPreviewTarget 的 force 旁路", () => {
  it("★ 用户滚动（force=false）保持逐帧钳制 —— 防抖语义不变", () => {
    // 目标差 2090px，但只允许走 16px
    expect(clampPreviewTarget(23376, 21826, 16)).toBe(23376 - 16);
    expect(clampPreviewTarget(100, 1000, 16)).toBe(116);
    expect(clampPreviewTarget(1000, 100, 16)).toBe(984);
  });

  it("★ 程序强制对齐（force=true）直接写目标值 —— 这是修复点", () => {
    // 同一次调用，force=true 时不再被钳制
    expect(clampPreviewTarget(23376, 21826, 16, true)).toBe(21826);
    expect(clampPreviewTarget(0, 25795, 16, true)).toBe(25795);
  });

  it("★ 回归证据：旧行为在 realign 链的帧预算内追不上", () => {
    /**
     * 模拟实测时序：defect 起点 23918，目标 21826，每帧 16px，
     * realign 只在 0/160/480/1000/1600ms 这 5 个时点写（外加 bounded-chase 若干帧）。
     * 旧行为在 1600ms 内最多推进 1600/16 ≈ 100 帧 × 16px = 1600px，
     * 而差距是 2092px ⇒ **追不上**（实测停在 23376，仍差 1550px）。
     */
    const start = 23918;
    const target = 21826;
    const need = Math.abs(target - start);
    const perFrame = ALLOW_ABS;
    const framesInWindow = Math.floor(1600 / 16);   // ≈100 帧
    const maxTravel = perFrame * framesInWindow;
    expect(need, "差距必须大于窗口内能走的距离，才复现缺陷").toBeGreaterThan(maxTravel);

    // force 一次到位
    expect(clampPreviewTarget(start, target, perFrame, true)).toBe(target);
  });

  it("force=true 仍保留「非有限值不写垃圾」的护栏", () => {
    // 映射算坏时绝不写 NaN 进去（宁可原地不动）
    expect(clampPreviewTarget(500, Number.NaN, 16, true)).toBe(500);
    expect(clampPreviewTarget(500, Number.POSITIVE_INFINITY, 16, true)).toBe(500);
    expect(clampPreviewTarget(null, Number.NaN, 16, true)).toBe(0);
  });

  it("force 默认值为 false（不破坏既有调用点语义）", () => {
    // 四参不传 = 旧三参行为
    expect(clampPreviewTarget(100, 1000, 16)).toBe(clampPreviewTarget(100, 1000, 16, false));
  });

  it("首帧（lastAccepted=null）原值放行 —— 既有契约", () => {
    expect(clampPreviewTarget(null, 1234, 16)).toBe(1234);
    expect(clampPreviewTarget(null, 1234, 16, false)).toBe(1234);
  });

  it("previewAllowedMove 在左屏已跳完（dLeft=0）时退化为 ALLOW_ABS", () => {
    // 这正是开合场景的输入：左屏已就位，dLeft=0 → 只有 16px 预算
    expect(previewAllowedMove(0)).toBe(ALLOW_ABS);
    expect(previewAllowedMove(100)).toBe(100 * ALLOW_RATIO);
  });
});

describe("配套护栏：预览几何健全性判据", () => {
  it("正常分屏布局 → 可信", () => {
    expect(isPreviewGeometrySane({ clientWidth: 517, clientHeight: 759, scrollHeight: 26554 })).toBe(true);
    expect(isPreviewGeometrySane({ clientWidth: 1022, clientHeight: 759, scrollHeight: 8000 })).toBe(true);
  });

  it("★ 关闭预览时的畸形布局（宽度 0、高度暴涨）→ 不可信", () => {
    /**
     * 实测 `scripts/_lead-p4d-iframe-layout.mjs`：
     * ```
     * 打开态： sh=6130    w=397   ← 正常
     * 关闭态： sh=175405  w=0     ← 宽度 0，每字单独折行
     * ```
     * 这种几何下任何映射都是错基数。
     */
    expect(isPreviewGeometrySane({ clientWidth: 0, clientHeight: 759, scrollHeight: 175405 })).toBe(false);
    expect(isPreviewGeometrySane({ clientWidth: 1, clientHeight: 759, scrollHeight: 175405 })).toBe(false);
    expect(isPreviewGeometrySane({ clientWidth: 40, clientHeight: 759, scrollHeight: 175405 })).toBe(false);
  });

  it("宽度阈值边界：恰好等于下限 → 不可信（必须严格大于）", () => {
    expect(isPreviewGeometrySane({
      clientWidth: PREVIEW_MIN_SANE_WIDTH_PX,
      clientHeight: 759,
      scrollHeight: 1000,
    })).toBe(false);
    expect(isPreviewGeometrySane({
      clientWidth: PREVIEW_MIN_SANE_WIDTH_PX + 1,
      clientHeight: 759,
      scrollHeight: 1000,
    })).toBe(true);
  });

  it("高宽比阈值：超过上限 → 不可信（挡住「宽度压扁→高度爆炸」）", () => {
    const w = 517;
    const justOver = Math.floor(w * PREVIEW_MAX_SANE_ASPECT) + 1;
    expect(isPreviewGeometrySane({ clientWidth: w, clientHeight: 759, scrollHeight: justOver })).toBe(false);
    // 正常超长文档不应被误伤
    expect(isPreviewGeometrySane({ clientWidth: w, clientHeight: 759, scrollHeight: 200000 })).toBe(true);
  });

  it("未就绪（全 0 / 负数 / 非有限）→ 不可信", () => {
    expect(isPreviewGeometrySane(null)).toBe(false);
    expect(isPreviewGeometrySane(undefined)).toBe(false);
    expect(isPreviewGeometrySane({ clientWidth: 0, clientHeight: 0, scrollHeight: 0 })).toBe(false);
    expect(isPreviewGeometrySane({ clientWidth: 517, clientHeight: 0, scrollHeight: 1000 })).toBe(false);
    expect(isPreviewGeometrySane({ clientWidth: 517, clientHeight: 759, scrollHeight: 0 })).toBe(false);
    expect(isPreviewGeometrySane({ clientWidth: Number.NaN, clientHeight: 759, scrollHeight: 1000 })).toBe(false);
    expect(isPreviewGeometrySane({ clientWidth: 517, clientHeight: 759, scrollHeight: Number.NaN })).toBe(false);
  });

  it("previewGeometryOf：从元素取几何，null 安全", () => {
    expect(previewGeometryOf(null)).toBeNull();
    expect(previewGeometryOf(undefined)).toBeNull();
    expect(previewGeometryOf({ clientWidth: 517, clientHeight: 759, scrollHeight: 26554 }))
      .toEqual({ clientWidth: 517, clientHeight: 759, scrollHeight: 26554 });
  });
});
