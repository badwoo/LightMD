/**
 * v0.12.0 需求4：视口锚点工具测试（jsdom）
 *
 * jsdom 无真实布局（rect 全 0、scrollHeight 恒 0），因此对目标元素
 * mock getBoundingClientRect / scrollHeight / clientHeight 后验证纯逻辑：
 * 1. captureAnchor：取视口首个可见顶层块（含部分滚出的块）；不足一屏 → null
 * 2. restoreAnchor：按偏移差补偿 scrollTop（clamp）；元素已移除 → 放弃
 * 3. 行锚点：capture/restore roundtrip（行高变化后按新行高还原）
 */
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import {
  captureAnchor,
  restoreAnchor,
  captureLineAnchor,
  restoreLineAnchor,
  findFirstOffsetAtOrBelow,
} from "../utils/viewportAnchor";

/** 覆盖元素 rect（jsdom 默认全 0） */
function mockRect(el: Element, top: number, bottom: number) {
  (el as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
    ({
      top,
      bottom,
      left: 0,
      right: 0,
      width: 0,
      height: bottom - top,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
}

function mockScrollSize(el: Element, clientHeight: number, scrollHeight: number) {
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("v0.12.0 需求4：块锚点", () => {
  it("captureAnchor：选视口内第一个底部可见的块（含部分滚出的块）", () => {
    const container = document.createElement("div");
    const a = document.createElement("p");
    const b = document.createElement("p");
    container.append(a, b);
    document.body.appendChild(container);
    mockScrollSize(container, 400, 2000);
    mockRect(container, 0, 400);
    // a 部分滚出视口（bottom=50 > 容器顶 0+1）→ 应为锚点
    mockRect(a, -50, 50);
    mockRect(b, 50, 150);

    const anchor = captureAnchor(container);
    expect(anchor?.el).toBe(a);
    expect(anchor?.offsetTop).toBe(-50);
  });

  it("captureAnchor：首个块完全滚出时选下一个块", () => {
    const container = document.createElement("div");
    const a = document.createElement("p");
    const b = document.createElement("p");
    container.append(a, b);
    document.body.appendChild(container);
    mockScrollSize(container, 400, 2000);
    mockRect(container, 100, 500); // 容器顶部在 100
    mockRect(a, -80, 90); // a.bottom=90 < 101 → 不可见
    mockRect(b, 100, 200);

    expect(captureAnchor(container)?.el).toBe(b);
  });

  it("captureAnchor：内容不足一屏 → null（不报错不抖动）", () => {
    const container = document.createElement("div");
    const a = document.createElement("p");
    container.append(a);
    document.body.appendChild(container);
    mockScrollSize(container, 400, 400);
    mockRect(container, 0, 400);
    mockRect(a, 0, 100);
    expect(captureAnchor(container)).toBeNull();
  });

  it("restoreAnchor：按偏移差补偿 scrollTop", () => {
    const container = document.createElement("div");
    const a = document.createElement("p");
    container.appendChild(a);
    document.body.appendChild(container);
    mockScrollSize(container, 400, 2000);
    mockRect(container, 0, 400);
    container.scrollTop = 100;
    // 重排后 a 下移 80（原来 top=-50，现在 top=30）
    mockRect(a, 30, 130);
    restoreAnchor(container, { el: a, offsetTop: -50 });
    expect(container.scrollTop).toBe(180);
  });

  it("restoreAnchor：偏移差在原位（<0.5px）时不改 scrollTop", () => {
    const container = document.createElement("div");
    const a = document.createElement("p");
    container.appendChild(a);
    document.body.appendChild(container);
    mockScrollSize(container, 400, 2000);
    mockRect(container, 0, 400);
    container.scrollTop = 100;
    mockRect(a, -50, 50); // 与记录一致
    restoreAnchor(container, { el: a, offsetTop: -50 });
    expect(container.scrollTop).toBe(100);
  });

  it("restoreAnchor：锚点元素已从文档移除（isConnected=false）→ 放弃", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    mockScrollSize(container, 400, 2000);
    mockRect(container, 0, 400);
    container.scrollTop = 100;
    const orphan = document.createElement("p"); // 未挂载
    restoreAnchor(container, { el: orphan, offsetTop: 0 });
    expect(container.scrollTop).toBe(100);
  });

  it("restoreAnchor：空锚点/内容不足一屏 → 安全返回", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    mockScrollSize(container, 400, 400);
    mockRect(container, 0, 400);
    container.scrollTop = 50;
    restoreAnchor(container, null);
    restoreAnchor(container, { el: container, offsetTop: 10 });
    expect(container.scrollTop).toBe(50);
  });
});

describe("v0.12.0 需求4：行锚点（textarea）", () => {
  function makeTextarea(scrollTop: number, clientH = 400, scrollH = 2000) {
    const ta = document.createElement("textarea");
    ta.style.fontSize = "16px";
    ta.style.lineHeight = "28px";
    ta.style.paddingTop = "0px";
    document.body.appendChild(ta);
    mockScrollSize(ta, clientH, scrollH);
    ta.scrollTop = scrollTop;
    return ta;
  }

  it("capture/restore roundtrip：行索引乘以当前行高还原", () => {
    const ta = makeTextarea(280);
    const idx = captureLineAnchor(ta);
    expect(idx).toBeCloseTo(10, 5); // 280 / 28
    ta.scrollTop = 0;
    restoreLineAnchor(ta, idx);
    expect(ta.scrollTop).toBeCloseTo(280, 3);
  });

  it("行高变化（缩放）后：同一行索引 → 新行高的像素位置", () => {
    const ta = makeTextarea(280); // 行高 28 → 行索引 10
    const idx = captureLineAnchor(ta);
    // 模拟缩放：行高变大到 42（1.5 倍）
    ta.style.lineHeight = "42px";
    restoreLineAnchor(ta, idx);
    expect(ta.scrollTop).toBeCloseTo(420, 3); // 10 × 42
  });

  it("同样乘回 padding-top（scrollTop 在前导 padding 内时为负行索引也稳定）", () => {
    const ta = makeTextarea(0);
    ta.style.paddingTop = "20px";
    const idx = captureLineAnchor(ta);
    expect(idx).toBeCloseTo(-20 / 28, 5);
    ta.style.lineHeight = "56px";
    restoreLineAnchor(ta, idx);
    expect(ta.scrollTop).toBeCloseTo(0, 3); // clamp 到 0（20 + (-20/28)*56 = 20-40 = -20 → 0）
  });

  it("内容不足一屏 → capture 返回 null；restore 安全返回", () => {
    const ta = makeTextarea(0, 400, 400);
    expect(captureLineAnchor(ta)).toBeNull();
    ta.scrollTop = 10;
    restoreLineAnchor(ta, null);
    expect(ta.scrollTop).toBe(10);
  });
});

describe("v0.12.0 返修（问题2）：textarea 内容锚点的二分查找", () => {
  /**
   * 构造"Y 单调不减"的模拟测量函数：每行 4 个字符、行高 30，
   * 即 Y(offset) = floor(offset / 4) * 30。
   */
  const measureY = (offset: number) => Math.floor(offset / 4) * 30;

  it("目标 Y=0 → 返回第一个 Y >= 0 的偏移（0）", () => {
    expect(findFirstOffsetAtOrBelow(100, 0, measureY)).toBe(0);
  });

  it("目标 Y 落在行内 → 返回该行起始偏移", () => {
    // 行 Y 序列 0,30,60,90…（每 4 个字符一行）
    // Y=30 → 偏移 4；Y=65 落在 60 与 90 之间 → 首个 >= 65 的是 90 → 偏移 12
    expect(findFirstOffsetAtOrBelow(100, 30, measureY)).toBe(4);
    expect(findFirstOffsetAtOrBelow(100, 65, measureY)).toBe(12);
  });

  it("目标 Y 超出全部内容 → 返回最后一个偏移", () => {
    expect(findFirstOffsetAtOrBelow(100, 9999, measureY)).toBe(99);
  });

  it("空文档（length=0）→ 0", () => {
    expect(findFirstOffsetAtOrBelow(0, 10, measureY)).toBe(0);
  });

  it("单调性：结果偏移的 Y 一定 >= 目标，且前一个偏移的 Y < 目标", () => {
    for (const target of [0, 7, 30, 31, 59, 60, 90, 120]) {
      const off = findFirstOffsetAtOrBelow(200, target, measureY);
      expect(measureY(off)).toBeGreaterThanOrEqual(target);
      if (off > 0) expect(measureY(off - 1)).toBeLessThan(target);
    }
  });
});