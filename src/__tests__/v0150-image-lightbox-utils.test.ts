/**
 * v0.15.0 F1：图片灯箱纯函数单测（缩放 / 平移 / 适配 / 分组）。
 *
 * `src/utils/imageLightbox.ts` 无 React / DOM 依赖，故本文件**不需要** jsdom 环境
 * （Node 环境即可跑）；但仍加 jsdom 头注释，保持与同目录组件测试一致的运行环境，
 * 避免将来在纯函数里引入 `document` 时静默崩掉。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import {
  DOUBLE_CLICK_MS,
  DOUBLE_CLICK_PX,
  MAX_SCALE,
  MIN_SCALE,
  clampOffset,
  clampScale,
  clampViewOffsets,
  canPan,
  createLightboxState,
  fitScale,
  fitView,
  goToImage,
  isDoubleClick,
  nextImage,
  normalizeImageIndex,
  panBy,
  prevImage,
  renderedSize,
  resetView,
  scalePercent,
  toggleActualSize,
  toLightboxImage,
  buildImageGroup,
  zoomAt,
  type LightboxImage,
  type LightboxState,
} from "../utils/imageLightbox";

/** 测试用图片分组 */
const IMAGES: LightboxImage[] = [
  { src: "a.png", alt: "甲" },
  { src: "b.png", alt: "乙", title: "tip-b" },
  { src: "c.png", alt: "丙" },
];

/** 初始状态：视口 400×300，自然尺寸 200×200 → fit = min(2, 1.5, 1) = 1 */
function baseState(over: Partial<LightboxState> = {}): LightboxState {
  return { ...createLightboxState(IMAGES, 0, { w: 200, h: 200 }, { w: 400, h: 300 }), ...over };
}

describe("fitScale：适应窗口倍率", () => {
  it("大图按 min(视口/自然) 缩小", () => {
    expect(fitScale({ w: 1600, h: 1200 }, { w: 800, h: 600 })).toBe(0.5);
  });

  it("宽高比不同时取较小的那一维（保证完整可见）", () => {
    // 800/3200=0.25，600/400=1.5 → 取 0.25
    expect(fitScale({ w: 3200, h: 400 }, { w: 800, h: 600 })).toBe(0.25);
  });

  it("小图不放大（上限 1）", () => {
    expect(fitScale({ w: 100, h: 100 }, { w: 1920, h: 1080 })).toBe(1);
  });

  it("结果被钳制在 [MIN_SCALE, MAX_SCALE]", () => {
    const tiny = fitScale({ w: 100000, h: 100000 }, { w: 10, h: 10 });
    expect(tiny).toBe(MIN_SCALE);
    expect(tiny).toBeGreaterThanOrEqual(MIN_SCALE);
    expect(fitScale({ w: 1, h: 1 }, { w: 100000, h: 100000 })).toBeLessThanOrEqual(MAX_SCALE);
  });

  it("尺寸未知（0 / 负数 / 缺字段）时回落 1（坏图、尚未 onload）", () => {
    expect(fitScale({ w: 0, h: 0 }, { w: 800, h: 600 })).toBe(1);
    expect(fitScale({ w: 800, h: 0 }, { w: 800, h: 600 })).toBe(1);
    expect(fitScale({ w: -100, h: -100 }, { w: 800, h: 600 })).toBe(1);
    expect(fitScale({ w: 800, h: 600 }, { w: 0, h: 0 })).toBe(1);
  });
});

describe("clampScale：倍率钳制", () => {
  it("区间内的值原样返回", () => {
    expect(clampScale(1)).toBe(1);
    expect(clampScale(2.5)).toBe(2.5);
  });

  it("超过上下限被钳制（25% ~ 800%）", () => {
    expect(clampScale(0.01)).toBe(MIN_SCALE);
    expect(clampScale(100)).toBe(MAX_SCALE);
  });

  it("非法值（NaN / 0 / 负数）回落 1；正无穷视作最大", () => {
    expect(clampScale(NaN)).toBe(1);
    expect(clampScale(Infinity)).toBe(MAX_SCALE);
    expect(clampScale(0)).toBe(1);
    expect(clampScale(-2)).toBe(1);
  });
});

describe("zoomAt：以指针点为锚缩放", () => {
  it("视口中心缩放只改倍率，偏移按比例缩放（中心对齐时保持 0）", () => {
    const s = baseState({ scale: 1, offsetX: 0, offsetY: 0 });
    const next = zoomAt(s, 2, 0, 0);
    expect(next.scale).toBe(2);
    expect(next.offsetX).toBe(0);
    expect(next.offsetY).toBe(0);
  });

  it("锚点不为中心时，锚点下的图片内容保持不动", () => {
    // 屏幕坐标映射：屏幕 = 中心 + offset + 局部*scale
    // 取锚点 c=(100,50)，缩放前该点对应的局部坐标 l = (c - offset)/scale
    const s = baseState({ scale: 1, offsetX: 20, offsetY: -10 });
    const factor = 1.5;
    const cx = 100;
    const cy = 50;
    const next = zoomAt(s, factor, cx, cy);
    const localXBefore = (cx - s.offsetX) / s.scale;
    const localYBefore = (cy - s.offsetY) / s.scale;
    const localXAfter = (cx - next.offsetX) / next.scale;
    const localYAfter = (cy - next.offsetY) / next.scale;
    expect(localXAfter).toBeCloseTo(localXBefore, 6);
    expect(localYAfter).toBeCloseTo(localYBefore, 6);
  });

  it("逐次缩放与一次缩放的倍率一致", () => {
    const s = baseState({ scale: 1 });
    const once = zoomAt(s, 1.2 * 1.2, 0, 0);
    const twice = zoomAt(zoomAt(s, 1.2, 0, 0), 1.2, 0, 0);
    expect(twice.scale).toBeCloseTo(once.scale, 10);
  });

  it("缩放后 mode 变为 custom", () => {
    expect(zoomAt(baseState(), 1.2).mode).toBe("custom");
  });

  it("到达上限后再放大 → 状态不变（幂等，避免每帧产生新对象）", () => {
    const s = baseState({ scale: MAX_SCALE });
    expect(zoomAt(s, 2)).toBe(s);
  });

  it("非法 factor（0 / 负数 / NaN）→ 状态不变", () => {
    const s = baseState();
    expect(zoomAt(s, 0)).toBe(s);
    expect(zoomAt(s, -2)).toBe(s);
    expect(zoomAt(s, NaN)).toBe(s);
  });

  it("传 metrics 时钳制平移量（图片小于视口 → 偏移归 0）", () => {
    const s = baseState({ scale: 1, offsetX: 300, offsetY: -300 });
    const next = zoomAt(s, 1.2, 0, 0, { natural: { w: 200, h: 200 }, viewport: { w: 400, h: 300 } });
    // 200*1.2=240 < 400 → 无平移空间
    expect(next.offsetX).toBe(0);
    expect(next.offsetY).toBe(0);
  });
});

describe("panBy：平移（含边界钳制）", () => {
  it("无 metrics 时按增量线性累加", () => {
    const s = baseState({ offsetX: 10, offsetY: 20, scale: 2 });
    const next = panBy(s, -30, 5);
    expect(next.offsetX).toBe(-20);
    expect(next.offsetY).toBe(25);
  });

  it("非法增量（NaN）按 0 处理", () => {
    const s = baseState({ offsetX: 10, offsetY: 20 });
    const next = panBy(s, NaN, NaN);
    expect(next.offsetX).toBe(10);
    expect(next.offsetY).toBe(20);
  });

  it("图片放大后拖拽到边缘被钳制，不出现空白", () => {
    // 自然 200×200，scale=4 → 渲染 800×800；视口 400×300
    // max = (rendered - viewport)/2：X=200，Y=250
    const s = baseState({ scale: 4 });
    const metrics = { natural: { w: 200, h: 200 }, viewport: { w: 400, h: 300 } };
    const next = panBy(s, 9999, -9999, metrics);
    expect(next.offsetX).toBe(200);
    expect(next.offsetY).toBe(-250);
  });
});

describe("clampOffset / clampViewOffsets / canPan", () => {
  it("图片小于视口 → 偏移恒为 0（居中）", () => {
    expect(clampOffset(500, 100, 400)).toBe(0);
    expect(clampOffset(-500, 100, 400)).toBe(0);
  });

  it("图片大于视口 → 允许 ±(rendered-viewport)/2", () => {
    expect(clampOffset(9999, 800, 400)).toBe(200);
    expect(clampOffset(-9999, 800, 400)).toBe(-200);
    expect(clampOffset(100, 800, 400)).toBe(100);
  });

  it("非法 offset（NaN）回落 0", () => {
    expect(clampOffset(NaN, 800, 400)).toBe(0);
  });

  it("clampViewOffsets 同时钳制两轴", () => {
    const s = baseState({ scale: 4, offsetX: 9999, offsetY: 9999 });
    const next = clampViewOffsets(s, { natural: { w: 200, h: 200 }, viewport: { w: 400, h: 300 } });
    expect(next.offsetX).toBe(200);
    expect(next.offsetY).toBe(250);
  });

  it("canPan：仅当图片在某方向超出视口时为真", () => {
    const metrics = { natural: { w: 200, h: 200 }, viewport: { w: 400, h: 300 } };
    expect(canPan(baseState({ scale: 1 }), metrics)).toBe(false);
    expect(canPan(baseState({ scale: 2 }), metrics)).toBe(true);
  });
});

describe("resetView / toggleActualSize：复位与双击切换", () => {
  it("resetView 回到 fit 并把偏移归零", () => {
    const s = baseState({ scale: 4, offsetX: 120, offsetY: -80, mode: "custom" });
    const next = resetView(s);
    expect(next.scale).toBe(s.fit);
    expect(next.offsetX).toBe(0);
    expect(next.offsetY).toBe(0);
    expect(next.mode).toBe("fit");
  });

  it("fit 态双击 → 100%（custom）", () => {
    const s = baseState({ scale: 0.5, fit: 0.5, mode: "fit" });
    const next = toggleActualSize(s);
    expect(next.scale).toBe(1);
    expect(next.mode).toBe("custom");
    expect(next.offsetX).toBe(0);
  });

  it("非 fit 态双击 → 回 fit", () => {
    const s = baseState({ scale: 3, fit: 0.5, mode: "custom", offsetX: 30 });
    const next = toggleActualSize(s);
    expect(next.scale).toBe(0.5);
    expect(next.mode).toBe("fit");
  });

  it("mode=custom 但倍率恰好等于 fit 时，仍视为 fit 态 → 切 100%", () => {
    const s = baseState({ scale: 0.5, fit: 0.5, mode: "custom" });
    expect(toggleActualSize(s).scale).toBe(1);
  });
});

describe("图片分组与索引切换", () => {
  it("normalizeImageIndex：越界回环", () => {
    expect(normalizeImageIndex(0, 3)).toBe(0);
    expect(normalizeImageIndex(2, 3)).toBe(2);
    expect(normalizeImageIndex(3, 3)).toBe(0);
    expect(normalizeImageIndex(-1, 3)).toBe(2);
    expect(normalizeImageIndex(-4, 3)).toBe(2);
  });

  it("normalizeImageIndex：空分组 / 非法值", () => {
    expect(normalizeImageIndex(5, 0)).toBe(0);
    expect(normalizeImageIndex(NaN, 3)).toBe(0);
  });

  it("nextImage / prevImage 循环切换", () => {
    const s = baseState({ index: 2 });
    expect(nextImage(s).index).toBe(0);
    expect(prevImage(s).index).toBe(1);
  });

  it("单图时切图 clamp 到自身", () => {
    const one = createLightboxState([IMAGES[0]!], 0, { w: 200, h: 200 }, { w: 400, h: 300 });
    expect(nextImage(one).index).toBe(0);
    expect(prevImage(one).index).toBe(0);
  });

  it("切图复位视图：scale/offset 归零，fit 归 1（新图尺寸未知，等 onload 重算）", () => {
    const s = baseState({ index: 0, scale: 4, offsetX: 120, offsetY: 60, mode: "custom", fit: 0.5 });
    const next = goToImage(s, 1);
    expect(next.index).toBe(1);
    expect(next.scale).toBe(1);
    expect(next.fit).toBe(1);
    expect(next.offsetX).toBe(0);
    expect(next.offsetY).toBe(0);
    expect(next.mode).toBe("fit");
    // 新图加载后按真实尺寸重算 fit（这里 1600×1200 / 800×600 → 0.5）
    const afterLoad = fitView(next, { w: 1600, h: 1200 }, { w: 800, h: 600 });
    expect(afterLoad.fit).toBeCloseTo(0.5, 10);
    expect(afterLoad.scale).toBeCloseTo(0.5, 10);
  });

  it("buildImageGroup：保持 DOM 顺序并把点中项归一到索引", () => {
    const g = buildImageGroup(IMAGES, 1);
    expect(g.images.map((i) => i.src)).toEqual(["a.png", "b.png", "c.png"]);
    expect(g.index).toBe(1);
    // 点中项被剔除时有调用方（collectLightboxGroup 传 0），这里验证越界回环
    expect(buildImageGroup(IMAGES, 9).index).toBe(0);
  });

  it("buildImageGroup：空分组返回 index=0", () => {
    expect(buildImageGroup([], 2)).toEqual({ images: [], index: 0 });
  });
});

describe("fitView / renderedSize / scalePercent / toLightboxImage", () => {
  it("fitView 按新自然尺寸重算 fit 并复位", () => {
    const s = baseState({ scale: 4, offsetX: 90, offsetY: 90, mode: "custom" });
    const next = fitView(s, { w: 4000, h: 2000 }, { w: 800, h: 600 });
    // min(800/4000=0.2, 600/2000=0.3, 1) = 0.2，但 0.2 < MIN_SCALE(0.25) → 钳到 0.25
    // （缩放区间是硬约束：超出 25%~800% 就不可达，宁可裁一点边也不越界）
    expect(next.fit).toBeCloseTo(MIN_SCALE, 10);
    expect(next.scale).toBeCloseTo(MIN_SCALE, 10);
    expect(next.offsetX).toBe(0);
    expect(next.mode).toBe("fit");
  });

  it("fitView 在区间内时按实际比例（不越界）", () => {
    const s = baseState({ scale: 4, offsetX: 90, offsetY: 90, mode: "custom" });
    const next = fitView(s, { w: 1600, h: 1200 }, { w: 800, h: 600 });
    expect(next.fit).toBeCloseTo(0.5, 10);
    expect(next.scale).toBeCloseTo(0.5, 10);
    expect(next.mode).toBe("fit");
  });

  it("renderedSize = 自然尺寸 × 倍率", () => {
    expect(renderedSize(baseState({ scale: 2 }), { w: 300, h: 150 })).toEqual({ w: 600, h: 300 });
  });

  it("scalePercent 取整数百分比", () => {
    expect(scalePercent(1)).toBe(100);
    expect(scalePercent(0.25)).toBe(25);
    expect(scalePercent(8)).toBe(800);
    expect(scalePercent(1.234)).toBe(123);
  });

  it("toLightboxImage 优先 currentSrc，缺失字段归一为空串/undefined", () => {
    expect(toLightboxImage({ src: "x.png", currentSrc: "cur.png", alt: "a", title: "t" })).toEqual({
      src: "cur.png",
      alt: "a",
      title: "t",
    });
    expect(toLightboxImage({ src: "x.png", alt: null })).toEqual({
      src: "x.png",
      alt: "",
      title: undefined,
    });
    expect(toLightboxImage({})).toEqual({ src: "", alt: "", title: undefined });
  });
});

// ═══════════════════════════════════════════════════════════════════
// v0.15.1 需求7：双击判定的唯一口径（灯箱入口 / 灯箱内 fit⇄100% 共用）
// ═══════════════════════════════════════════════════════════════════
describe("v0.15.1 isDoubleClick：双击判定口径", () => {
  it("常量口径：300ms / 8px（三处共用同一组数值）", () => {
    expect(DOUBLE_CLICK_MS).toBe(300);
    expect(DOUBLE_CLICK_PX).toBe(8);
  });

  it("没有上一次按下 → 不是双击（首次单击）", () => {
    expect(isDoubleClick(null, { at: 1000, x: 0, y: 0 })).toBe(false);
    expect(isDoubleClick(undefined, { at: 1000, x: 0, y: 0 })).toBe(false);
  });

  it("时间窗内 + 位移窗内 → 是双击", () => {
    expect(isDoubleClick({ at: 1000, x: 10, y: 10 }, { at: 1100, x: 12, y: 13 })).toBe(true);
    // 边界内：299ms、位移 7.9px
    expect(isDoubleClick({ at: 0, x: 0, y: 0 }, { at: 299, x: 0, y: 7.9 })).toBe(true);
  });

  it("超出时间窗 → 不是双击（慢速两次单击不弹灯箱）", () => {
    expect(isDoubleClick({ at: 1000, x: 10, y: 10 }, { at: 1300, x: 10, y: 10 })).toBe(false);
    expect(isDoubleClick({ at: 1000, x: 10, y: 10 }, { at: 5000, x: 10, y: 10 })).toBe(false);
  });

  it("超出位移窗 → 不是双击（两次点在不同位置，可能是两次独立单击）", () => {
    expect(isDoubleClick({ at: 1000, x: 10, y: 10 }, { at: 1100, x: 30, y: 10 })).toBe(false);
    // 恰好 8px 不算（严格小于）
    expect(isDoubleClick({ at: 0, x: 0, y: 0 }, { at: 100, x: 8, y: 0 })).toBe(false);
  });

  it("时间倒流（事件乱序 / 时钟回拨）不当作双击", () => {
    expect(isDoubleClick({ at: 2000, x: 0, y: 0 }, { at: 1000, x: 0, y: 0 })).toBe(false);
  });

  it("非法数值（NaN）不当作双击", () => {
    expect(isDoubleClick({ at: NaN, x: 0, y: 0 }, { at: 100, x: 0, y: 0 })).toBe(false);
    expect(isDoubleClick({ at: 0, x: 0, y: 0 }, { at: 100, x: NaN, y: 0 })).toBe(false);
  });

  it("自定义窗口参数生效（灯箱内可覆盖口径）", () => {
    const a = { at: 0, x: 0, y: 0 };
    const b = { at: 500, x: 0, y: 0 };
    expect(isDoubleClick(a, b)).toBe(false);
    expect(isDoubleClick(a, b, 600, 8)).toBe(true);
  });
});

