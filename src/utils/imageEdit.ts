/**
 * 图片编辑纯函数模块（G3）
 *
 * 提供 Canvas 操作的纯函数封装：
 * - cropImage：按裁剪区域裁剪图片
 * - rotateImage：旋转图片（90°/180°/270°）
 * - flipImage：水平/垂直翻转图片
 *
 * 设计原则：
 * - 所有函数均为纯函数（输入相同则输出相同），便于单元测试
 * - 不依赖 DOM 状态，仅依赖参数传入的 dataUrl
 * - 内部通过 loadImage 加载图片到 HTMLImageElement，再用 Canvas 进行变换
 * - 输出 PNG dataUrl（无损，且与 Canvas 原生支持）
 *
 * 测试环境（jsdom）通过 mock HTMLImageElement / HTMLCanvasElement 实现：
 * - mock 中 HTMLImageElement 的 naturalWidth/naturalHeight 直接取自 dataUrl 头部尺寸
 * - HTMLCanvasElement.toDataURL mock 返回固定 dataUrl
 */

/** 裁剪矩形（基于原图坐标，单位 px） */
export interface CropRect {
  /** 裁剪区域左上角 X 坐标 */
  x: number;
  /** 裁剪区域左上角 Y 坐标 */
  y: number;
  /** 裁剪区域宽度 */
  width: number;
  /** 裁剪区域高度 */
  height: number;
}

/**
 * 加载图片 dataUrl 为 HTMLImageElement
 *
 * 通过 new Image() + onload 异步加载，resolve 后 img.naturalWidth/Height 可用。
 * 测试环境（jsdom）通过 mock HTMLImageElement 实现同步加载。
 */
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (!src) {
      reject(new Error("图片 src 为空"));
      return;
    }
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片加载失败"));
    // crossOrigin 设为 anonymous，避免 canvas tainted（针对 http(s) URL）
    // data: URL 不受跨域限制，直接加载
    if (!/^data:/i.test(src)) {
      img.crossOrigin = "anonymous";
    }
    img.src = src;
  });
}

/**
 * 将裁剪矩形钳制到 [0, maxW] × [0, maxH] 范围内
 *
 * 处理边界情况：
 * - x/y 为负数时归零
 * - width/height 为负数时返回零尺寸
 * - x + width 超出 maxW 时截断 width
 * - y + height 超出 maxH 时截断 height
 */
export function clampCropRect(rect: CropRect, maxW: number, maxH: number): CropRect {
  const x = Math.max(0, Math.min(rect.x, maxW));
  const y = Math.max(0, Math.min(rect.y, maxH));
  const width = Math.max(0, Math.min(rect.width, maxW - x));
  const height = Math.max(0, Math.min(rect.height, maxH - y));
  return { x, y, width, height };
}

/**
 * 裁剪图片
 *
 * @param imageDataUrl 原始图片 dataUrl（data:image/...;base64,... 或 http(s)/asset URL）
 * @param crop 裁剪区域（基于原图坐标）
 * @returns 裁剪后的 PNG dataUrl
 * @throws 输入无效时抛出错误
 */
export async function cropImage(imageDataUrl: string, crop: CropRect): Promise<string> {
  if (!imageDataUrl) throw new Error("图片 dataUrl 为空");
  if (!crop || typeof crop !== "object") throw new Error("裁剪区域无效");
  if (crop.width <= 0 || crop.height <= 0) throw new Error("裁剪区域宽高必须大于 0");

  const img = await loadImage(imageDataUrl);
  const maxW = img.naturalWidth || img.width;
  const maxH = img.naturalHeight || img.height;
  if (maxW <= 0 || maxH <= 0) throw new Error("图片尺寸无效");

  // 钳制裁剪区域到图片范围内
  const clamped = clampCropRect(crop, maxW, maxH);
  if (clamped.width <= 0 || clamped.height <= 0) {
    throw new Error("裁剪区域超出图片范围");
  }

  const canvas = document.createElement("canvas");
  canvas.width = clamped.width;
  canvas.height = clamped.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法获取 Canvas 2D 上下文");

  // 从原图 (clamped.x, clamped.y) 位置裁剪 clamped.width × clamped.height 区域
  ctx.drawImage(
    img,
    clamped.x, clamped.y, clamped.width, clamped.height,
    0, 0, clamped.width, clamped.height
  );

  return canvas.toDataURL("image/png");
}

/**
 * 旋转图片
 *
 * @param imageDataUrl 原始图片 dataUrl
 * @param deg 旋转角度（仅支持 90 / 180 / 270，其他值取模处理）
 * @returns 旋转后的 PNG dataUrl
 * @throws 输入无效时抛出错误
 */
export async function rotateImage(imageDataUrl: string, deg: number): Promise<string> {
  if (!imageDataUrl) throw new Error("图片 dataUrl 为空");
  if (typeof deg !== "number" || !isFinite(deg)) throw new Error("旋转角度无效");

  // 规范化到 [0, 360)，并取整
  const normalized = ((Math.round(deg) % 360) + 360) % 360;
  if (normalized === 0) {
    // 0° 不旋转，原样返回
    return imageDataUrl;
  }
  // 仅支持 90 / 180 / 270
  if (normalized !== 90 && normalized !== 180 && normalized !== 270) {
    throw new Error("仅支持 90°/180°/270° 旋转");
  }

  const img = await loadImage(imageDataUrl);
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (w <= 0 || h <= 0) throw new Error("图片尺寸无效");

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法获取 Canvas 2D 上下文");

  if (normalized === 180) {
    // 180°：尺寸不变
    canvas.width = w;
    canvas.height = h;
    // translate 到右下角，再 scale(-1,-1) 实现翻转
    ctx.translate(w, h);
    ctx.scale(-1, -1);
    ctx.drawImage(img, 0, 0);
  } else {
    // 90° 或 270°：宽高互换
    canvas.width = h;
    canvas.height = w;
    if (normalized === 90) {
      // 顺时针 90°：translate 到新画布右边界，旋转后再绘制
      ctx.translate(h, 0);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(img, 0, 0);
    } else {
      // 270°（即逆时针 90°）：translate 到新画布下边界，反向旋转
      ctx.translate(0, w);
      ctx.rotate(-Math.PI / 2);
      ctx.drawImage(img, 0, 0);
    }
  }

  return canvas.toDataURL("image/png");
}

/**
 * 翻转图片
 *
 * @param imageDataUrl 原始图片 dataUrl
 * @param horizontal true=水平翻转（左右翻转），false=垂直翻转（上下翻转）
 * @returns 翻转后的 PNG dataUrl
 * @throws 输入无效时抛出错误
 */
export async function flipImage(imageDataUrl: string, horizontal: boolean): Promise<string> {
  if (!imageDataUrl) throw new Error("图片 dataUrl 为空");
  if (typeof horizontal !== "boolean") throw new Error("翻转方向参数必须为布尔值");

  const img = await loadImage(imageDataUrl);
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (w <= 0 || h <= 0) throw new Error("图片尺寸无效");

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法获取 Canvas 2D 上下文");

  if (horizontal) {
    // 水平翻转：沿 Y 轴翻转（左右翻转）
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  } else {
    // 垂直翻转：沿 X 轴翻转（上下翻转）
    ctx.translate(0, h);
    ctx.scale(1, -1);
  }
  ctx.drawImage(img, 0, 0);

  return canvas.toDataURL("image/png");
}
