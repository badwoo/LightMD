/**
 * G3 图片编辑纯函数测试
 *
 * 覆盖：
 * - clampCropRect：裁剪区域边界检查
 * - cropImage：裁剪图片，返回新 dataUrl
 * - rotateImage：90°/180°/270° 旋转
 * - flipImage：水平/垂直翻转
 * - 无效输入处理（空 dataUrl、负数等）
 *
 * 测试环境（jsdom）通过 mock 实现：
 * - global.Image：mock 构造函数，设置 naturalWidth/naturalHeight，src setter 异步触发 onload
 * - HTMLCanvasElement.prototype.getContext：返回 mock ctx（含 drawImage/translate/rotate/scale）
 * - HTMLCanvasElement.prototype.toDataURL：返回固定 dataUrl 便于断言
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  cropImage,
  rotateImage,
  flipImage,
  clampCropRect,
  loadImage,
  type CropRect,
} from "../utils/imageEdit";

// ─── Mock Image 构造函数 ────────────────────────────
// jsdom 的 Image 不加载真实图片，naturalWidth/Height 始终为 0
// 此处 mock：src setter 后异步触发 onload，naturalWidth/Height 由全局变量控制
let mockNaturalWidth = 100;
let mockNaturalHeight = 100;

class MockImage {
  naturalWidth = mockNaturalWidth;
  naturalHeight = mockNaturalHeight;
  width = mockNaturalWidth;
  height = mockNaturalHeight;
  crossOrigin = "";
  _src = "";
  onload: (() => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  set src(value: string) {
    this._src = value;
    if (value) {
      // 异步触发 onload（模拟图片加载完成）
      Promise.resolve().then(() => {
        if (this.onload) this.onload();
      });
    }
  }
  get src() {
    return this._src;
  }
}

// ─── Mock Canvas 2D 上下文 ────────────────────────────
const mockCtx = {
  drawImage: vi.fn(),
  translate: vi.fn(),
  rotate: vi.fn(),
  scale: vi.fn(),
  save: vi.fn(),
  restore: vi.fn(),
  fillRect: vi.fn(),
  clearRect: vi.fn(),
};

const MOCK_OUTPUT_DATAURL = "data:image/png;base64,MOCK_CANVAS_OUTPUT";

beforeEach(() => {
  // 重置全局图片尺寸
  mockNaturalWidth = 100;
  mockNaturalHeight = 100;

  // 替换全局 Image 构造函数
  vi.stubGlobal("Image", MockImage);

  // mock Canvas getContext 与 toDataURL
  HTMLCanvasElement.prototype.getContext = vi.fn(() => mockCtx) as any;
  HTMLCanvasElement.prototype.toDataURL = vi.fn(() => MOCK_OUTPUT_DATAURL) as any;

  // 重置 mock 调用记录
  mockCtx.drawImage.mockClear();
  mockCtx.translate.mockClear();
  mockCtx.rotate.mockClear();
  mockCtx.scale.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── clampCropRect：裁剪区域边界检查 ────────────────────────────
describe("clampCropRect", () => {
  it("正常输入原样返回", () => {
    const rect: CropRect = { x: 10, y: 20, width: 50, height: 60 };
    const result = clampCropRect(rect, 100, 100);
    expect(result).toEqual(rect);
  });

  it("负数 x/y 归零", () => {
    const rect: CropRect = { x: -10, y: -20, width: 50, height: 60 };
    const result = clampCropRect(rect, 100, 100);
    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
    // width/height 仍为原值（因为 x/y 归零后仍有空间）
    expect(result.width).toBe(50);
    expect(result.height).toBe(60);
  });

  it("x + width 超出右边界时截断 width", () => {
    const rect: CropRect = { x: 80, y: 0, width: 50, height: 60 };
    const result = clampCropRect(rect, 100, 100);
    expect(result.x).toBe(80);
    expect(result.width).toBe(20); // 100 - 80 = 20
  });

  it("y + height 超出下边界时截断 height", () => {
    const rect: CropRect = { x: 0, y: 80, width: 50, height: 60 };
    const result = clampCropRect(rect, 100, 100);
    expect(result.y).toBe(80);
    expect(result.height).toBe(20); // 100 - 80 = 20
  });

  it("负数 width/height 归零", () => {
    const rect: CropRect = { x: 10, y: 10, width: -20, height: -30 };
    const result = clampCropRect(rect, 100, 100);
    expect(result.width).toBe(0);
    expect(result.height).toBe(0);
  });

  it("x 超出 maxW 时钳制到 maxW，width 归零", () => {
    const rect: CropRect = { x: 150, y: 0, width: 50, height: 60 };
    const result = clampCropRect(rect, 100, 100);
    expect(result.x).toBe(100);
    expect(result.width).toBe(0); // 100 - 100 = 0
  });
});

// ─── loadImage：图片加载 ────────────────────────────
describe("loadImage", () => {
  it("加载 dataUrl 成功", async () => {
    const img = await loadImage("data:image/png;base64,abc");
    expect(img).toBeTruthy();
    expect(img.naturalWidth).toBe(100);
  });

  it("空 src 抛错", async () => {
    await expect(loadImage("")).rejects.toThrow("图片 src 为空");
  });
});

// ─── cropImage：裁剪图片 ────────────────────────────
describe("cropImage", () => {
  it("正常裁剪返回新 dataUrl", async () => {
    const result = await cropImage("data:image/png;base64,abc", {
      x: 10, y: 20, width: 50, height: 60,
    });
    expect(result).toBe(MOCK_OUTPUT_DATAURL);
    // drawImage 应被调用
    expect(mockCtx.drawImage).toHaveBeenCalledTimes(1);
  });

  it("裁剪区域超出图片范围时自动钳制", async () => {
    // 图片 100x100，裁剪区域 (80, 80, 50, 50) → 钳制为 (80, 80, 20, 20)
    const result = await cropImage("data:image/png;base64,abc", {
      x: 80, y: 80, width: 50, height: 50,
    });
    expect(result).toBe(MOCK_OUTPUT_DATAURL);
    expect(mockCtx.drawImage).toHaveBeenCalledTimes(1);
  });

  it("空 dataUrl 抛错", async () => {
    await expect(
      cropImage("", { x: 0, y: 0, width: 50, height: 50 })
    ).rejects.toThrow("图片 dataUrl 为空");
  });

  it("crop 为 null 抛错", async () => {
    await expect(
      cropImage("data:image/png;base64,abc", null as unknown as CropRect)
    ).rejects.toThrow("裁剪区域无效");
  });

  it("width <= 0 抛错", async () => {
    await expect(
      cropImage("data:image/png;base64,abc", { x: 0, y: 0, width: 0, height: 50 })
    ).rejects.toThrow("裁剪区域宽高必须大于 0");
  });

  it("height <= 0 抛错", async () => {
    await expect(
      cropImage("data:image/png;base64,abc", { x: 0, y: 0, width: 50, height: -10 })
    ).rejects.toThrow("裁剪区域宽高必须大于 0");
  });

  it("裁剪区域完全在图片外（钳制后为零尺寸）抛错", async () => {
    // 图片 100x100，裁剪区域 (200, 200, 50, 50) 钳制后为零尺寸
    await expect(
      cropImage("data:image/png;base64,abc", { x: 200, y: 200, width: 50, height: 50 })
    ).rejects.toThrow("裁剪区域超出图片范围");
  });
});

// ─── rotateImage：旋转图片 ────────────────────────────
describe("rotateImage", () => {
  it("90° 旋转调用 drawImage", async () => {
    const result = await rotateImage("data:image/png;base64,abc", 90);
    expect(result).toBe(MOCK_OUTPUT_DATAURL);
    expect(mockCtx.drawImage).toHaveBeenCalledTimes(1);
    // 90° 旋转：translate + rotate
    expect(mockCtx.translate).toHaveBeenCalled();
    expect(mockCtx.rotate).toHaveBeenCalledWith(Math.PI / 2);
  });

  it("270° 旋转调用 drawImage", async () => {
    const result = await rotateImage("data:image/png;base64,abc", 270);
    expect(result).toBe(MOCK_OUTPUT_DATAURL);
    expect(mockCtx.drawImage).toHaveBeenCalledTimes(1);
    // 270° 旋转：translate + rotate(-π/2)
    expect(mockCtx.rotate).toHaveBeenCalledWith(-Math.PI / 2);
  });

  it("180° 旋转：尺寸不变，scale(-1,-1)", async () => {
    const result = await rotateImage("data:image/png;base64,abc", 180);
    expect(result).toBe(MOCK_OUTPUT_DATAURL);
    expect(mockCtx.drawImage).toHaveBeenCalledTimes(1);
    // 180° 旋转：translate(w,h) + scale(-1,-1)
    expect(mockCtx.scale).toHaveBeenCalledWith(-1, -1);
  });

  it("0° 旋转原样返回（不调用 Canvas）", async () => {
    const src = "data:image/png;base64,abc";
    const result = await rotateImage(src, 0);
    expect(result).toBe(src);
    expect(mockCtx.drawImage).not.toHaveBeenCalled();
  });

  it("360° 等价于 0° 原样返回", async () => {
    const src = "data:image/png;base64,abc";
    const result = await rotateImage(src, 360);
    expect(result).toBe(src);
  });

  it("450° 等价于 90°", async () => {
    const result = await rotateImage("data:image/png;base64,abc", 450);
    expect(result).toBe(MOCK_OUTPUT_DATAURL);
    expect(mockCtx.rotate).toHaveBeenCalledWith(Math.PI / 2);
  });

  it("空 dataUrl 抛错", async () => {
    await expect(rotateImage("", 90)).rejects.toThrow("图片 dataUrl 为空");
  });

  it("非数字角度抛错", async () => {
    await expect(
      rotateImage("data:image/png;base64,abc", NaN)
    ).rejects.toThrow("旋转角度无效");
  });

  it("非 90/180/270 倍数角度抛错", async () => {
    await expect(
      rotateImage("data:image/png;base64,abc", 45)
    ).rejects.toThrow("仅支持 90°/180°/270° 旋转");
  });

  it("270° 旋转非正方形图片时宽高互换", async () => {
    // 设置 mock 图片为 200x100
    mockNaturalWidth = 200;
    mockNaturalHeight = 100;
    // 重新 stub Image（因为 beforeEach 已 stub，但 mockNaturalWidth 已变）
    // 实际上 MockImage 在构造时读取 mockNaturalWidth，需要重新创建实例
    // 此用例验证 canvas.width/height 设置：90°/270° 时宽高互换
    const createSpy = vi.spyOn(document, "createElement");
    await rotateImage("data:image/png;base64,abc", 270);
    // 找到 canvas 元素的 width/height 设置
    const canvasCalls = createSpy.mock.results
      .map((r) => r.value as HTMLCanvasElement)
      .filter((c) => c.tagName === "CANVAS");
    if (canvasCalls.length > 0) {
      const canvas = canvasCalls[0];
      // 90°/270° 旋转：canvas.width = h = 100, canvas.height = w = 200
      expect(canvas.width).toBe(100);
      expect(canvas.height).toBe(200);
    }
    createSpy.mockRestore();
  });
});

// ─── flipImage：翻转图片 ────────────────────────────
describe("flipImage", () => {
  it("水平翻转调用 scale(-1, 1)", async () => {
    const result = await flipImage("data:image/png;base64,abc", true);
    expect(result).toBe(MOCK_OUTPUT_DATAURL);
    expect(mockCtx.drawImage).toHaveBeenCalledTimes(1);
    expect(mockCtx.scale).toHaveBeenCalledWith(-1, 1);
    // 水平翻转：translate(w, 0)
    expect(mockCtx.translate).toHaveBeenCalledWith(100, 0);
  });

  it("垂直翻转调用 scale(1, -1)", async () => {
    const result = await flipImage("data:image/png;base64,abc", false);
    expect(result).toBe(MOCK_OUTPUT_DATAURL);
    expect(mockCtx.drawImage).toHaveBeenCalledTimes(1);
    expect(mockCtx.scale).toHaveBeenCalledWith(1, -1);
    // 垂直翻转：translate(0, h)
    expect(mockCtx.translate).toHaveBeenCalledWith(0, 100);
  });

  it("空 dataUrl 抛错", async () => {
    await expect(flipImage("", true)).rejects.toThrow("图片 dataUrl 为空");
  });

  it("非布尔值参数抛错", async () => {
    await expect(
      flipImage("data:image/png;base64,abc", "yes" as unknown as boolean)
    ).rejects.toThrow("翻转方向参数必须为布尔值");
  });
});
