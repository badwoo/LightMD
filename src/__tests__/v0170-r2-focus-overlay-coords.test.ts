// @vitest-environment jsdom
/**
 * v0.17.0 第二轮 · 缺陷 #4「专注遮罩不跟随光标」—— 坐标系换算回归测试
 *
 * ## 缺陷与根因（一句话）
 *
 * `updateOverlay()` 把 `measureRangeContentY()` 返回的**内容坐标系** Y 直接当
 * overlay 像素坐标用，漏了「减 scrollTop」和「加静态原点偏移 originOffset」两项
 * → 遮罩恒贴在视口顶部附近，光标一滚出视野就落到"屏幕中央 3 行窗"兜底
 * → 用户看到的是「3 行高亮固定在页面中间」。
 *
 * ## 为什么必须有**破坏性对照**（本文件的核心价值）
 *
 * 这个 bug 有个恶劣性质：**改错了测试也能全绿**。
 * 如果只断言"返回值是个对象/是个数"，那么把换算整个删掉、或者只实现一半
 *（只减 scrollTop、漏 originOffset），测试依然通过 —— 因为它不检查**具体数值**。
 *
 * 所以本文件对每条换算都成对地写：
 * - 正向：给定输入 → 断言**精确**输出；
 * - 破坏性：显式算出"写错时会得到的值" → 断言**不等于**正向输出。
 * 第二类断言就是"如果有人把实现改回旧行为，这里必红"的护栏。
 *
 * ## 数值约定（与探针实测一致）
 *
 * 实测（`scripts/v0170-r2-focus-overlay.mjs`，CM6 分屏态）：
 * `originOffset = 44`（= scroller padding 40 + content padding 4），
 * 且它与滚动无关（极差 0）。任务书要求的 `{300,380}` + `scrollTop=200`
 * 在 `originOffset=0` 的简化场景下即得 `[100,180]`。
 */
import { describe, it, expect } from "vitest";
import {
  contentRangeToOverlayViewportY,
  measureOverlayGeometry,
  estimateLineHeightFromYs,
} from "../components/editor/panes/formatmenuhost/FormatMenuHost";

describe("#4 内容坐标 → overlay 视口坐标：scrollTop 必须被扣除", () => {
  it("★ 任务书指定用例：{300,380} + scrollTop=200 + originOffset=0 → [100,180]", () => {
    const r = contentRangeToOverlayViewportY(300, 380, 200, 0);
    expect(r.startY).toBe(100);
    expect(r.endY).toBe(180);
  });

  it("★ 破坏性对照：只减 scrollTop（漏 originOffset）≠ 正确换算", () => {
    // 实测值：originOffset = 44。正确结果是 [100+44, 180+44]
    const correct = contentRangeToOverlayViewportY(300, 380, 200, 44);
    expect(correct.startY).toBe(144);
    expect(correct.endY).toBe(224);

    // "写错版"：把 originOffset 当成 0（= 原缺陷的一半，很多人会这么"修"）
    const forgottenOffset = contentRangeToOverlayViewportY(300, 380, 200, 0);
    expect(forgottenOffset.startY).not.toBe(correct.startY);
    expect(forgottenOffset.endY).not.toBe(correct.endY);
    // 差值必须恰好是 originOffset（说明它是个独立的平移项，不是舍入误差）
    expect(correct.startY - forgottenOffset.startY).toBe(44);
  });

  it("★ 破坏性对照：完全不减 scrollTop（= 修复前的原行为）不可接受", () => {
    const correct = contentRangeToOverlayViewportY(300, 380, 200, 44);
    // 修复前是"直接拿内容坐标当视口坐标"，在无滚动时偶然正确、一滚就错
    const buggy = { startY: 300, endY: 380 };
    expect(correct.startY).not.toBe(buggy.startY);
    // 滚动越多，偏差越大 —— 这正是"滚动后完全错位"的量化解释
    const more = contentRangeToOverlayViewportY(300, 380, 2000, 44);
    expect(Math.abs(more.startY - buggy.startY)).toBeGreaterThan(
      Math.abs(correct.startY - buggy.startY),
    );
  });

  it("scrollTop=0 且 originOffset=0 时是恒等变换（textarea 语义的等价情形）", () => {
    const r = contentRangeToOverlayViewportY(120, 200, 0, 0);
    expect(r).toEqual({ startY: 120, endY: 200 });
  });

  it("区间高度在换算中保持不变（刚体平移，不许缩放）", () => {
    const r = contentRangeToOverlayViewportY(300, 380, 777, 44);
    expect(r.endY - r.startY).toBe(80);
  });

  it("允许结果为负（区间滚到视口上方）—— 由调用方钳位，不是换算的职责", () => {
    // 内容 Y=50、已滚 300 → 该区间在视口上方 250px（再 +44 原点偏移）
    const r = contentRangeToOverlayViewportY(50, 130, 300, 44);
    expect(r.startY).toBe(-206);
    expect(r.endY).toBe(-126);
    // 换算层不做 max(0,…)：钳位会丢失"整个区间都在视口上方"这一信息，
    // 而调用方正是靠未钳位的原值判断该不该走中央兜底窗。
  });

  it("平移不变量：ΔscrollTop 引起等量反向位移（= 探针 B1 的算法内核）", () => {
    const a = contentRangeToOverlayViewportY(1000, 1080, 200, 44);
    const b = contentRangeToOverlayViewportY(1000, 1080, 400, 44);
    expect(b.startY - a.startY).toBe(-200);
    expect(b.endY - a.endY).toBe(-200);
  });

  it("originOffset 与 scrollTop 相互独立（不可互相抵消成同一个数）", () => {
    // 同一 scrollTop、不同 originOffset → 结果必须不同（防止把两者写成和/差混用）
    const withOffset = contentRangeToOverlayViewportY(100, 180, 250, 44).startY;
    const noOffset = contentRangeToOverlayViewportY(100, 180, 250, 0).startY;
    // 同一 originOffset、不同 scrollTop → 结果也必须不同
    const noScroll = contentRangeToOverlayViewportY(100, 180, 0, 44).startY;
    expect(withOffset).not.toBe(noOffset);
    expect(withOffset).not.toBe(noScroll);
    // 数值关系：originOffset 是加项、scrollTop 是减项
    expect(withOffset).toBe(100 + 44 - 250);
  });
});

describe("#4 measureOverlayGeometry：originOffset 必须实测，不能硬编码", () => {
  /**
   * 构造一棵与生产 DOM 同构的最小树：
   *   overlay（inset:0，与 wrapper 同框）
   *   scroller（在 overlay 内，top 偏移 → 贡献常量项）
   *     .cm-content（有自己的 paddingTop）
   *
   * ⚠️ jsdom **没有布局引擎**：`getBoundingClientRect()` 恒返回全 0。
   * 因此这里用 `getBoundingClientRect` 打桩来模拟"真实排版测出来的几何"，
   * 断言的是**换算公式**（44 = 容器偏移 + scroller padding + content padding），
   * 而不是"浏览器会算出几像素"。真几何由浏览器探针负责（两者互为交叉验证）。
   */
  function buildTree(opts: {
    scrollerTopOffset?: number;
    scrollerPadTop?: number;
    contentPadTop?: number;
    overlayHeight?: number;
    scrollerHeight?: number;
  }) {
    const {
      scrollerTopOffset = 0,
      scrollerPadTop = 40,
      contentPadTop = 4,
      overlayHeight = 760,
      scrollerHeight = 679,
    } = opts;

    const overlay = document.createElement("div");
    overlay.className = "source-focus-overlay";
    const scroller = document.createElement("div");
    scroller.className = "cm-scroller";
    scroller.style.paddingTop = `${scrollerPadTop}px`;
    const content = document.createElement("div");
    content.className = "cm-content";
    content.style.paddingTop = `${contentPadTop}px`;
    const host = document.createElement("div");

    scroller.appendChild(content);
    host.appendChild(scroller);
    overlay.appendChild(host); // 结构上放进 overlay，便于 closest 链成立
    document.body.appendChild(overlay);

    overlay.getBoundingClientRect = () =>
      ({ top: 100, left: 0, width: 800, height: overlayHeight, bottom: 100 + overlayHeight, right: 800, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect;
    scroller.getBoundingClientRect = () => {
      const top = 100 + scrollerTopOffset;
      return { top, left: 0, width: 800, height: scrollerHeight, bottom: top + scrollerHeight, right: 800, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    };
    return { overlay, host, cleanup: () => overlay.remove() };
  }

  it("★ originOffset = 容器偏移 + scroller paddingTop + content paddingTop（实测 0+40+4=44）", () => {
    const { overlay, host, cleanup } = buildTree({});
    try {
      const g = measureOverlayGeometry(overlay, host);
      expect(g).not.toBeNull();
      expect(g!.originOffset).toBe(44);
      expect(g!.viewportTop).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("★ 破坏性对照：把 originOffset 当 0（硬编码省略）会与实测值不同 44px", () => {
    const { overlay, host, cleanup } = buildTree({});
    try {
      const g = measureOverlayGeometry(overlay, host)!;
      // "省略 originOffset"的写法等价于恒返回 0：
      const buggy = 0;
      expect(g.originOffset).not.toBe(buggy);
      expect(g.originOffset - buggy).toBe(44);
    } finally {
      cleanup();
    }
  });

  it("★ 硬编码 44 会被抓出来：改内边距后实测值必须跟着变", () => {
    // 这正是"为什么不许硬编码"的证明：样式一变，硬编码就静默错位
    const { overlay, host, cleanup } = buildTree({ scrollerPadTop: 20, contentPadTop: 0 });
    try {
      const g = measureOverlayGeometry(overlay, host)!;
      expect(g.originOffset).toBe(20); // 20 + 0，而不是写死的 44
      expect(g.originOffset).not.toBe(44);
    } finally {
      cleanup();
    }
  });

  it("容器在 overlay 内下移（分栏/内缩）时 originOffset 同步反映", () => {
    const { overlay, host, cleanup } = buildTree({ scrollerTopOffset: 30 });
    try {
      expect(measureOverlayGeometry(overlay, host)!.originOffset).toBe(74); // 30+40+4
    } finally {
      cleanup();
    }
  });

  it("★ 结构不符时返回 null（调用方走中央兜底），绝不返回一个「看着能用」的 0", () => {
    const overlay = document.createElement("div");
    document.body.appendChild(overlay);
    overlay.getBoundingClientRect = () => ({ top: 0, left: 0, width: 800, height: 600, bottom: 600, right: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const bare = document.createElement("div");
    try {
      // ① host 为空
      expect(measureOverlayGeometry(overlay, null)).toBeNull();
      // ② host 里没有 .cm-content（结构不符）
      expect(measureOverlayGeometry(overlay, bare)).toBeNull();
    } finally {
      overlay.remove();
    }
  });

  it("布局未就绪（高度为 0，例如宿主 display:none）时返回 null", () => {
    const { overlay, host, cleanup } = buildTree({ overlayHeight: 0 });
    try {
      expect(measureOverlayGeometry(overlay, host)).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe("#4 兜底窗行高：必须取「最小」间距（一个视觉行），不能被标题/软换行带偏", () => {
  it("★ 纯正文：所有间距相等 → 返回该行高", () => {
    expect(estimateLineHeightFromYs([0, 28.8, 57.6, 86.4])).toBeCloseTo(28.8, 5);
  });

  it("★ 破坏性对照：文档以 H1 开头（首间距 1.4 倍）时，结果必须是正文行高", () => {
    // 实测场景：`.cm-md-heading1 { font-size: 1.4em }` → 首行高 40.3 vs 正文 28.8
    const ys = [0, 40.32, 69.12, 97.92, 126.72, 155.52];
    const lh = estimateLineHeightFromYs(ys)!;
    expect(lh).toBeCloseTo(28.8, 5);
    // 若用旧的"第 0 行到第 1 行"算法，会得到 40.32 → 3 行窗被画宽 40%
    const oldAlgorithm = ys[1] - ys[0];
    expect(oldAlgorithm).toBeCloseTo(40.32, 5);
    expect(lh).not.toBeCloseTo(oldAlgorithm, 2);
    // 量化影响：3 行窗 121px（旧）vs 86px（新）
    expect(Math.round(oldAlgorithm * 3)).toBe(121);
    expect(Math.round(lh * 3)).toBe(86);
  });

  it("★★ 破坏性对照（第二次踩坑）：软换行段落占多数时，中位数会被带偏，最小值才对", () => {
    /**
     * 真实实测的行盒高度序列（`scripts/v0170-r2-focus-overlay.mjs` 同款文档）：
     *   [40.3, 28.8, 86.4, 28.8, 86.4, ...]
     * 其中 86.4 = **3 个视觉行**（软换行的段落在 DOM 里是一个 .cm-line 行盒），
     * 且它的**个数多于** 28.8 的空行 → 中位数落在 86.4 一侧。
     *
     * 这正是我第一版实现（取中位数）被打回的原因：实测兜底窗画成 115px。
     * 这条断言把"中位数是错的"钉死，防止后人改回去。
     */
    const ys: number[] = [0];
    const heights = [40.32, 28.8, 86.4, 28.8, 86.4, 28.8, 86.4, 28.8, 86.4, 28.8, 86.4];
    for (const h of heights) ys.push(ys[ys.length - 1] + h);

    const lh = estimateLineHeightFromYs(ys)!;
    expect(lh).toBeCloseTo(28.8, 5); // 正确：单视觉行

    // 中位数（错误实现）会得到 28.8 或 86.4 之一 —— 这里证明它**不可靠**
    const gaps = heights.slice();
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    // 本样本里中位数恰好也是 28.8，但"最小值"是**结构性保证**、中位数是巧合：
    // 换一份以长段落为主的文档，中位数就变 86.4。下面构造那种情形。
    expect(lh).toBeCloseTo(28.8, 5);

    // 构造"长段落占绝对多数"的文档：中位数必然是 86.4（= 3 倍行高）→ 明显错
    // （注意：最小行高需 ≥2 个样本支持才采信，所以这里保留两个 28.8 的单行间距）
    const heights2 = [86.4, 86.4, 86.4, 28.8, 86.4, 86.4, 86.4, 28.8, 86.4];
    const ys2: number[] = [0];
    for (const h of heights2) ys2.push(ys2[ys2.length - 1] + h);
    const sorted2 = [...heights2].sort((a, b) => a - b);
    const median2 = sorted2[Math.floor(sorted2.length / 2)];
    expect(median2).toBeCloseTo(86.4, 5); // 中位数在这个分布下是 3 行高 → 不能用
    expect(estimateLineHeightFromYs(ys2)).toBeCloseTo(28.8, 5); // 最小值给出正确答案
  });

  it("单个过小的坏样本不足以决定行高（需 ≥2 个样本支持最小值才采信）", () => {
    // 只有一个 10px 的异常间距，其余都是 28.8 → 不能返回 10
    const ys = [0, 10, 38.8, 67.6, 96.4, 125.2];
    const lh = estimateLineHeightFromYs(ys)!;
    expect(lh).toBeGreaterThan(20); // 未采信孤立的 10
    expect(lh).not.toBe(10);
  });

  it("样本不足 / 全为 null → null（调用方退回 CSS 变量口径）", () => {
    expect(estimateLineHeightFromYs([])).toBeNull();
    expect(estimateLineHeightFromYs([0])).toBeNull();
    expect(estimateLineHeightFromYs([null, null])).toBeNull();
  });

  it("排除零/负间距（同一行内换行、测量失败）与离谱值（>200px 不是一行）", () => {
    expect(estimateLineHeightFromYs([0, 0, 0])).toBeNull();
    expect(estimateLineHeightFromYs([100, 50])).toBeNull(); // 负
    // 500 的跨度被排除后，只剩合法间距
    expect(estimateLineHeightFromYs([0, 28, 56, 556])).toBeCloseTo(28, 5);
  });
});
