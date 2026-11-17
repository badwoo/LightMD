/**
 * v0.17.1 第三轮：**预览 iframe 几何健全性判据**（单一事实源）
 *
 * ## 为什么需要这个模块（用户问题）
 * > 「双击 ctrl 切换模式，文档对齐和阅读进度丢失问题貌似是解决了，但在编辑模式
 * >  通过双击 shift 键来打开或关闭预览文档又没对齐了」
 *
 * ### 缺陷机制（iframe 布局实测，`scripts/_lead-p4d-iframe-layout.mjs`）
 * 关闭预览时预览外壳宽度过渡到 **0**，iframe 内部文档的布局被撑坏：
 * ```
 * 打开态： scScrollH=6130    p1.rectW=397  p1.rectH=86.4    ← 正常
 * 关闭态： scScrollH=175405  p1.rectW=0    p1.rectH=2879.7  ← 宽度 0，段落高 33 倍
 * 重开态： scScrollH=6130    p1.rectW=397  p1.rectH=86.4    ← 又正常
 * ```
 * 宽度变 0 后每个字符单独折行 → 段落高度暴涨 → `scrollHeight` 涨 29 倍。
 *
 * 而左右联动同步（`syncToPreview` / `syncToSource` / `realignLayoutNow`）
 * 在这个窗口里仍在跑，它们**只查了"贴标 > 0"和"可滚动"** —— 这两个条件在
 * 宽度 0 时**都成立**（61 个贴标、175405 > 759）→ 闸门放行 →
 * 用畸形几何算位置 → 反算出的源码行落在文档开头 → 重开预览后右屏停在顶部。
 *
 * 实测后果（`scripts/_lead-p4b-right-diag.mjs`）：
 * ```
 * 重开预览 3s 后：左屏 PI34（正确） / 右屏 PI3（几乎在顶部）  ← 用户看到的"没对齐"
 * ```
 *
 * ## 判据设计（为什么是这两个阈值）
 * 1. **宽度必须 > 80px**：Markdown 正文在任意合理窗口下都远宽于 80px
 *    （最小分屏壳宽约为窗口的 40%，正常 > 300px）。宽度 ≤ 80 只可能出现在
 *    "开合过渡中 / 已关闭"这两种**没有映射意义**的状态。
 * 2. **高宽比必须 ≤ 500**：正常 Markdown 即使很长，内容高与视口宽之比也极少超过 200。
 *    宽度被压扁时这个比值会爆炸（实测 175405/0 → 无穷；压到 1px 时约 17 万）。
 *    取 500 作为"明显畸形"的界：不误伤超长文档，能挡住压扁。
 *
 * ⚠️ **宁可这一帧不动，也不要用错基数写坏位置** —— 这是本项目反复验证过的取舍
 * （见 `computePreviewTarget` 里"有锚点表但映射不出目标 → 不退回百分比"的同款理由）。
 *
 * ## 为什么抽成独立模块
 * 该判据被 `computePreviewTarget` 与 `realignLayoutNow` **两处**使用；
 * 若各自内联一份，将来必有一处漂移（本项目已因"两套提示并存 / 两套索引体系"
 * 踩过坑）。抽成纯函数后：**生产与测试 import 同一实现**，测试可断言真值表，
 * 不再靠正则匹配源码文本。
 */

/** 宽度下限（px）：低于此值不可能是有映射意义的正文布局 */
export const PREVIEW_MIN_SANE_WIDTH_PX = 80;

/** 高宽比上限：超过即判定为"宽度被压扁导致的高度爆炸" */
export const PREVIEW_MAX_SANE_ASPECT = 500;

export interface PreviewGeometry {
  /** 滚动容器的 clientWidth */
  clientWidth: number;
  /** 滚动容器的 clientHeight */
  clientHeight: number;
  /** 滚动容器的 scrollHeight */
  scrollHeight: number;
}

/**
 * 预览侧几何是否可用于**滚动位置映射**。
 *
 * @returns true = 几何可信，可以映射；false = 布局畸形/未就绪，**本次不要写**
 */
export function isPreviewGeometrySane(g: PreviewGeometry | null | undefined): boolean {
  if (!g) return false;
  const { clientWidth: w, clientHeight: h, scrollHeight: sh } = g;
  if (!Number.isFinite(w) || !Number.isFinite(h) || !Number.isFinite(sh)) return false;
  // 视口/内容必须为正（display:none / 未挂载时全是 0）
  if (!(h > 0) || !(sh > 0)) return false;
  // ① 宽度下限：宽度被压到 0/极窄时，scrollHeight 没有映射意义
  if (!(w > PREVIEW_MIN_SANE_WIDTH_PX)) return false;
  // ② 高宽比上限：挡住"宽度压扁 → 高度爆炸"
  if (sh / w > PREVIEW_MAX_SANE_ASPECT) return false;
  return true;
}

/** 便于调用方直接从元素取几何（DOM 侧薄封装，逻辑仍在纯函数里） */
export function previewGeometryOf(el: {
  clientWidth: number;
  clientHeight: number;
  scrollHeight: number;
} | null | undefined): PreviewGeometry | null {
  if (!el) return null;
  return {
    clientWidth: el.clientWidth,
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
  };
}
