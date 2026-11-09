/**
 * src/editor/surface/sourceLineAxis.ts —— 源码面「按行轴」的统一测量入口（A3）
 *
 * ## 为什么需要这一层
 *
 * A3 要把分屏对齐的**数据源**从 `measureSourceLineAxis`（mirror div + 零宽标记）
 * 换成 CM6 的 `coordsAtPos`。但下游有 **3 处**独立调用它：
 * - `HistoryHost.measureSourceBlocks`（源码块几何缓存）
 * - `EditorContainer.textareaTopFromContentAnchor`（内容锚点 → scrollTop）
 * - `PreviewPane`（分屏双向映射的行轴）
 *
 * 若各自改一遍，`coordsAtPos` 的**兜底策略**会写 3 份、且必然漂移。因此把
 * 「测量源（谁去量）」与「行轴构建（怎么算）」拆开：
 *
 * ```
 * 测量源                             行轴构建（纯函数，一行未改）
 * ─────────────────────────          ──────────────────────────────
 * textarea → measureSourceLineAxis → buildSourceLineAxis
 * surface  → measureBlockTops      → buildSourceLineAxis
 * ```
 *
 * ⚠️ `buildSourceLineAxis` / `estimateTopSourceLine` / `maxScrollLine` 等
 * **纯函数层一行都不改**（Lead 明确要求）—— 本文件只负责"喂数据"。
 *
 * ## R2：必须保留估算兜底，且降级要可观测
 *
 * 设计稿 R2 警告：CM6 的虚拟视口之外，`coordsAtPos` 结果不稳（未渲染的行可能
 * 测不到）。因此：
 * - 测量失败 → 返回 null，调用方退回百分比映射（与旧行为一致，不会更差）；
 * - **降级必须可观测**：通过 `onDegrade` 回调报告原因，避免"分屏对齐不准"被误判成
 *   对齐算法坏了、而实际是视口外测量失败。
 */

import type { SourceSurface } from "../types";
import {
  buildSourceLineAxis,
  measureSourceLineAxis,
} from "../../utils/blockScrollAlign";

/** 行轴测量结果（与 `measureSourceLineAxis` 的返回同形） */
export interface MeasuredLineAxis {
  totalLines: number;
  /** 非递减的「行 → 像素顶部」插值轴 */
  axis: number[];
}

/**
 * 测量源：只回答"这些行的顶部在哪"以及"内容/视口多高"。
 *
 * 两个实现：textarea（mirror 测量）与 Surface（CM6 `coordsAtPos`）。
 */
export interface LineAxisMeasureSource {
  /** 实测若干行号的像素顶部（无法测量返回 null） */
  measureBlockTops(blockLines: number[]): number[] | null;
  /** 内容总高 / 视口高（行轴归一化上限） */
  metrics(): { scrollHeight: number; clientHeight: number; totalLines: number };
}

/** 降级原因（可观测：调用方/探针据此判断是"测量失败"还是"算法坏了"） */
export type LineAxisDegradeReason =
  | "axis_source_unavailable"
  | "no_block_lines"
  | "no_measured_tops"
  | "build_axis_failed"
  | "max_scroll_zero";

/** 把 textarea 包成测量源（**行为与 A3 之前完全一致**，用于回退实现） */
export function textareaMeasureSource(ta: HTMLTextAreaElement): LineAxisMeasureSource {
  return {
    measureBlockTops(blockLines: number[]): number[] | null {
      const measured = measureSourceLineAxis({ textarea: ta, blockLines });
      if (!measured) return null;
      // measureSourceLineAxis 已经把"行 → 顶部"插值成整轴；这里按入参行号回取，
      // 与 surface 实现（逐行实测）语义对齐 —— 上层因此对两种源一视同仁。
      return blockLines.map((line) => {
        const idx = Math.max(0, Math.min(measured.totalLines - 1, Math.floor(line)));
        const v = measured.axis[idx];
        return Number.isFinite(v) ? v : Number.NaN;
      });
    },
    metrics() {
      return {
        scrollHeight: ta.scrollHeight,
        clientHeight: ta.clientHeight,
        totalLines: ta.value.split("\n").length,
      };
    },
  };
}

/** 把 `SourceSurface` 包成测量源（CM6 路径走 `coordsAtPos`） */
export function surfaceMeasureSource(surface: SourceSurface): LineAxisMeasureSource {
  return {
    measureBlockTops(blockLines: number[]): number[] | null {
      return surface.measureBlockTops(blockLines);
    },
    metrics() {
      const m = surface.getMetrics();
      return {
        scrollHeight: m.scrollHeight,
        clientHeight: m.clientHeight,
        totalLines: m.totalLines,
      };
    },
  };
}

/**
 * 用指定测量源构建按行轴。
 *
 * @param source 测量源（textarea 或 surface）
 * @param blockLines 顶层块起始行（升序）
 * @param onDegrade 降级回调（**可观测性**：R2 要求能区分"测量失败"与"算法坏了"）
 * @returns 行轴；任一环节不可用时返回 null（调用方退回百分比映射）
 */
export function measureLineAxis(
  source: LineAxisMeasureSource,
  blockLines: number[],
  onDegrade?: (reason: LineAxisDegradeReason) => void,
): MeasuredLineAxis | null {
  if (!Array.isArray(blockLines) || blockLines.length === 0) {
    onDegrade?.("no_block_lines");
    return null;
  }
  const m = source.metrics();
  // 不可见（高度/宽度为 0）或空文档：旧实现同样返回 null，交给百分比兜底
  const maxScroll = Math.max(0, m.scrollHeight - m.clientHeight);
  if (!(maxScroll > 0)) {
    onDegrade?.("max_scroll_zero");
    return null;
  }

  const tops = source.measureBlockTops(blockLines);
  if (!tops || tops.length === 0) {
    onDegrade?.("axis_source_unavailable");
    return null;
  }
  // 有测量但全是 NaN（CM6 视口外全部测不到）也要报出来
  if (!tops.some((t) => Number.isFinite(t))) {
    onDegrade?.("no_measured_tops");
    return null;
  }

  const axis = buildSourceLineAxis({
    totalLines: m.totalLines,
    blockLines,
    blockTops: tops,
    maxScroll,
  });
  if (!axis) {
    onDegrade?.("build_axis_failed");
    return null;
  }
  return { totalLines: m.totalLines, axis };
}
