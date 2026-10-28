/**
 * v0.15.0 F1：图片灯箱的**纯数学**（缩放 / 平移 / 适配 / 分组）。
 *
 * 为什么单独抽成工具模块：
 * - 灯箱交互（指针锚点缩放、边界钳制、切图复位）全是纯几何计算，写进 React 组件会
 *   与渲染、事件、portal 纠缠在一起，无法单测；
 * - 本文件**不依赖 React / DOM**（只用普通对象与数值），可直接在 Node 环境单测。
 *
 * 坐标系约定（组件侧必须一致）：
 * - `scale`：相对图片**自然像素**的缩放倍率（1 = 100% 原始尺寸）；
 * - `offsetX / offsetY`：图片**中心**相对显示区中心的平移量（px，右/下为正）；
 * - `cx / cy`：缩放锚点相对显示区中心的坐标（px，右/下为正）。
 *
 * 由此得到屏幕映射：`屏幕点 = 显示区中心 + offset + 局部坐标 * scale`。
 * 缩放锚定"光标下的像素不动"就是保持上式中的 `offset + 局部坐标 * scale` 不变，
 * 于是新偏移 = `c + (offset - c) * (s' / s)`（c 为锚点相对中心的坐标）。
 */

/**
 * v0.15.1 需求7：双击判定的**唯一口径**（时间窗 + 位移窗）。
 *
 * 为什么放在纯函数模块：双击要在三处生效 ——
 * 1. `ImageLightbox` 内「双击 fit ⇄ 100%」（指针手势，pointerdown 自行判定）；
 * 2. 编辑模式 `ImageView` 的「双击图片 → 打开灯箱」（mousedown 已被
 *    preventDefault/stopPropagation，原生 dblclick 不可靠，故同口径自行判定）；
 * 3. 采集层（阅读面 / iframe 预览面）用原生 `dblclick` 事件，浏览器口径与此接近。
 *
 * 三处共用同一组常量，避免"灯箱内 300ms、入口 250ms"这种体感不一致。
 */
export const DOUBLE_CLICK_MS = 300;
/** 双击判定的位移窗（px）：两次按下位置距离小于此值视为同一次双击 */
export const DOUBLE_CLICK_PX = 8;

/** 一次指针按下的时间与坐标（双击判定的输入） */
export interface ClickPoint {
  /** 事件时刻（`Date.now()` / `event.timeStamp` 同一时基即可） */
  at: number;
  /** 视口坐标 X（px） */
  x: number;
  /** 视口坐标 Y（px） */
  y: number;
}

/**
 * 两个按下点是否构成一次双击。
 *
 * @param prev 上一次按下的点（null / undefined = 没有上一次 → 一定不是双击）
 * @param next 本次按下的点
 * @param ms 时间窗（默认 {@link DOUBLE_CLICK_MS}）
 * @param px 位移窗（默认 {@link DOUBLE_CLICK_PX}）
 *
 * 语义：**严格小于**两个窗口才算双击（与 `ImageLightbox` 既有实现一致，
 * 边界值不升级为双击，避免"慢速两次单击"被误判成双击而弹出灯箱）。
 */
export function isDoubleClick(
  prev: ClickPoint | null | undefined,
  next: ClickPoint,
  ms: number = DOUBLE_CLICK_MS,
  px: number = DOUBLE_CLICK_PX,
): boolean {
  if (!prev) return false;
  if (!Number.isFinite(prev.at) || !Number.isFinite(next?.at)) return false;
  if (!Number.isFinite(prev.x) || !Number.isFinite(prev.y)) return false;
  if (!Number.isFinite(next.x) || !Number.isFinite(next.y)) return false;
  const dt = next.at - prev.at;
  // 时间倒流（事件乱序 / 系统时钟回拨）不当作双击
  if (dt < 0 || dt >= ms) return false;
  return Math.hypot(next.x - prev.x, next.y - prev.y) < px;
}

/** 最小缩放倍率（25%） */
export const MIN_SCALE = 0.25;
/** 最大缩放倍率（800%） */
export const MAX_SCALE = 8;
/** 按钮 / 键盘单步缩放倍率 */
export const ZOOM_STEP = 1.2;
/** 滚轮单档缩放倍率（近似） */
export const WHEEL_ZOOM_FACTOR = 1.1;

/** 二维尺寸（px） */
export interface Size {
  w: number;
  h: number;
}

/** 灯箱内的一张图片（从 DOM 采集出的纯数据，不含 DOM 引用） */
export interface LightboxImage {
  src: string;
  alt: string;
  title?: string;
}

/** 灯箱视图状态（设计 §2.2 的 LightboxState） */
export interface LightboxState {
  /** 当前分组（当前文档 DOM 顺序） */
  images: LightboxImage[];
  /** 当前索引 */
  index: number;
  /** 当前缩放倍率，范围 [MIN_SCALE, MAX_SCALE] */
  scale: number;
  /** 图片中心相对显示区中心的平移量（px） */
  offsetX: number;
  offsetY: number;
  /** fit = 处于"适应窗口"态；custom = 用户缩放过 */
  mode: "fit" | "custom";
  /**
   * 当前图片的"适应窗口"倍率（打开 / 切图 / 窗口尺寸变化时按视口与自然尺寸算）。
   * 界面上不展示，仅供 `resetView` / 双击切换复原使用；设计文档的 LightboxState
   * 未列此字段，是纯函数自我完备所必需的扩展。
   */
  fit: number;
}

/** 缩放/平移的边界计算上下文：自然尺寸 + 可用显示区尺寸 */
export interface LightboxMetrics {
  natural: Size;
  viewport: Size;
}

/** 把缩放倍率钳制到 [MIN_SCALE, MAX_SCALE]（无效值回落 1，正无穷视作"放到最大"） */
export function clampScale(scale: number): number {
  if (scale === Number.POSITIVE_INFINITY) return MAX_SCALE;
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * "适应窗口"倍率：让图片在显示区内完整可见。
 *
 * 规则：
 * - 大图按 `min(显示区/自然尺寸)` 缩小；
 * - 小图**不放大**（上限 1）——点击小图标不应被强行拉成马赛克，这也是各家
 *   灯箱的通行做法；用户仍可手动缩放到 100% 以上；
 * - 尺寸未知（自然尺寸为 0，例如坏图 / 尚未 onload）时返回 1。
 */
export function fitScale(natural: Size, viewport: Size): number {
  const nw = natural?.w ?? 0;
  const nh = natural?.h ?? 0;
  const vw = viewport?.w ?? 0;
  const vh = viewport?.h ?? 0;
  if (!(nw > 0 && nh > 0 && vw > 0 && vh > 0)) return 1;
  return clampScale(Math.min(vw / nw, vh / nh, 1));
}

/** 索引归一化：越界回环、非法值取 0（空分组返回 0） */
export function normalizeImageIndex(index: number, length: number): number {
  if (!Number.isFinite(length) || length <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  const i = Math.trunc(index);
  return ((i % length) + length) % length;
}

/** 由自然尺寸/视口创建初始状态（打开灯箱、切换图片时用） */
export function createLightboxState(
  images: LightboxImage[],
  index: number,
  natural: Size,
  viewport: Size,
): LightboxState {
  const fit = fitScale(natural, viewport);
  return {
    images,
    index: normalizeImageIndex(index, images.length),
    scale: fit,
    offsetX: 0,
    offsetY: 0,
    mode: "fit",
    fit,
  };
}

/** 按图片自然尺寸重新计算 fit 并复位（onload / 切图 / 窗口 resize 后调用） */
export function fitView(state: LightboxState, natural: Size, viewport: Size): LightboxState {
  const fit = fitScale(natural, viewport);
  return { ...state, scale: fit, offsetX: 0, offsetY: 0, mode: "fit", fit };
}

/**
 * 以指针点为中心缩放（设计 §2.2 的 `zoomAt`）。
 *
 * @param factor 缩放倍率（>1 放大，<1 缩小）
 * @param cx/cx 锚点相对**显示区中心**的坐标（px）。不传时为 (0,0) = 视口中心缩放。
 * @param metrics 可选的边界上下文；传入时会钳制平移量，避免图片被拖出视野。
 */
export function zoomAt(
  state: LightboxState,
  factor: number,
  cx = 0,
  cy = 0,
  metrics?: LightboxMetrics,
): LightboxState {
  if (!Number.isFinite(factor) || factor <= 0) return state;
  const nextScale = clampScale(state.scale * factor);
  if (nextScale === state.scale) return state;
  const ratio = nextScale / state.scale;
  const offsetX = cx + (state.offsetX - cx) * ratio;
  const offsetY = cy + (state.offsetY - cy) * ratio;
  const next: LightboxState = {
    ...state,
    scale: nextScale,
    offsetX,
    offsetY,
    mode: "custom",
  };
  return metrics ? clampViewOffsets(next, metrics) : next;
}

/** 平移（设计 §2.2 的 `panBy`）：dx/dy 为屏幕像素增量 */
export function panBy(
  state: LightboxState,
  dx: number,
  dy: number,
  metrics?: LightboxMetrics,
): LightboxState {
  const next: LightboxState = {
    ...state,
    offsetX: state.offsetX + (Number.isFinite(dx) ? dx : 0),
    offsetY: state.offsetY + (Number.isFinite(dy) ? dy : 0),
    mode: "custom",
  };
  return metrics ? clampViewOffsets(next, metrics) : next;
}

/** 复位到"适应窗口"（Home 键 / 复位按钮） */
export function resetView(state: LightboxState): LightboxState {
  return { ...state, scale: state.fit, offsetX: 0, offsetY: 0, mode: "fit" };
}

/**
 * 双击切换：fit ⇄ 100%（设计 §2.3「双击 fit↔100%」）。
 *
 * 处于 fit 态（或倍率恰好等于 fit）→ 切 100%；否则回 fit。
 */
export function toggleActualSize(state: LightboxState, metrics?: LightboxMetrics): LightboxState {
  const isFit = state.mode === "fit" || Math.abs(state.scale - state.fit) < 1e-6;
  if (!isFit) return resetView(state);
  const next: LightboxState = {
    ...state,
    scale: clampScale(1),
    offsetX: 0,
    offsetY: 0,
    mode: "custom",
  };
  return metrics ? clampViewOffsets(next, metrics) : next;
}

/**
 * 切图：索引回环 + 视图复位。
 *
 * 新图片的自然尺寸此时**未知**，故把 fit 一并归 1（与 `fitScale` 的未知回落同口径），
 * 等组件拿到新图 `onload` 后再调 `fitView` 算出真实 fit。若沿用上一张图的 fit，
 * 新图会先以错误倍率闪一下再跳变。
 */
export function goToImage(state: LightboxState, index: number): LightboxState {
  return {
    ...state,
    index: normalizeImageIndex(index, state.images.length),
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    mode: "fit",
    fit: 1,
  };
}

/** 下一张（右方向键 / 右按钮），单图时 clamp 到自身 */
export function nextImage(state: LightboxState): LightboxState {
  return goToImage(state, state.index + 1);
}

/** 上一张（左方向键 / 左按钮），单图时 clamp 到自身 */
export function prevImage(state: LightboxState): LightboxState {
  return goToImage(state, state.index - 1);
}

/** 渲染尺寸 = 自然尺寸 × 缩放倍率 */
export function renderedSize(state: LightboxState, natural: Size): Size {
  return { w: (natural?.w ?? 0) * state.scale, h: (natural?.h ?? 0) * state.scale };
}

/** 单轴平移钳制：图片比显示区小 → 居中（0）；比显示区大 → 允许拖到边缘对齐 */
export function clampOffset(offset: number, rendered: number, viewport: number): number {
  if (!Number.isFinite(offset)) return 0;
  const max = Math.max(0, (rendered - viewport) / 2);
  if (max === 0) return 0;
  const clamped = Math.min(max, Math.max(-max, offset));
  // 归一化 -0（`-0 === 0` 但 Object.is 不等，会让状态比较/快照断言出现噪音）
  return clamped === 0 ? 0 : clamped;
}

/** 按上下文钳制 offsetX/offsetY（图片居中时不产生越界空白） */
export function clampViewOffsets(state: LightboxState, metrics: LightboxMetrics): LightboxState {
  const size = renderedSize(state, metrics.natural);
  return {
    ...state,
    offsetX: clampOffset(state.offsetX, size.w, metrics.viewport.w),
    offsetY: clampOffset(state.offsetY, size.h, metrics.viewport.h),
  };
}

/** 是否允许拖拽平移：放大后的图片某个方向超出显示区才有可拖空间 */
export function canPan(state: LightboxState, metrics: LightboxMetrics): boolean {
  const size = renderedSize(state, metrics.natural);
  return size.w > metrics.viewport.w + 0.5 || size.h > metrics.viewport.h + 0.5;
}

/** 倍率 → 百分比整数（界面右上角 "125%"） */
export function scalePercent(scale: number): number {
  return Math.round(clampScale(scale) * 100);
}

/** 从图片元素属性构造纯数据（DOM 采集在插件侧，本函数只做字段归一） */
export function toLightboxImage(source: {
  src?: string | null;
  currentSrc?: string | null;
  alt?: string | null;
  title?: string | null;
}): LightboxImage {
  const src = source.currentSrc || source.src || "";
  return {
    src,
    alt: source.alt ?? "",
    title: source.title || undefined,
  };
}

/**
 * 构造切图分组（设计 §2.3「分组 = 当前文档 DOM 顺序」）。
 *
 * 传入的是当前文档里**全部**可点击图片（DOM 顺序）与点击命中的索引；
 * 返回值保证 index 落在 [0, length) 内（空分组 → 0）。
 */
export function buildImageGroup(
  images: LightboxImage[],
  activeIndex: number,
): { images: LightboxImage[]; index: number } {
  if (images.length === 0) return { images: [], index: 0 };
  return { images, index: normalizeImageIndex(activeIndex, images.length) };
}
