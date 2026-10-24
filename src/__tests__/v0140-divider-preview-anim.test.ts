/**
 * v0.14.0 需求3 —— 编辑模式「关闭/打开预览」动画放慢 50% + 顺滑化（CSS 契约测试）
 *
 * 用户原话：「关闭预览 / 打开预览的动画太快，要放慢 50%；而且还不够顺滑。」
 *
 * ── 为什么是源码文本断言 ─────────────────────────────────────────
 * 时长、曲线、`contain`、`will-change` 都是 CSS 层事实；jsdom 不算样式、更不跑
 * 合成器，无法用 DOM 断言。与既有 v0140-divider-*.test.ts / v0140-two-modes.test.tsx
 * 同款做法：读 editor.css 正则断言。
 *
 * ── 本文件锁什么（对应实机取证结论）───────────────────────────────
 * 实机 CDP 逐帧采样（scripts/v0140-probe-preview-anim.mjs，真机打包产物）暴露了
 * 三处**与时长无关**的不顺滑，本文件逐条锁住修复：
 *
 *   ① 时长 0.28s → 0.42s（精确 +50%），且**两栏 + 分割条三者完全一致**
 *      （同曲线同时长；任何一处不同就会出现"一栏先动"）。
 *   ② 曲线从「起步极猛」的 cubic-bezier(0.22,0.61,0.36,1) 换成对称 smoothstep
 *      cubic-bezier(0.33,0,0.67,1)：实测逐帧位移 jerk 2.81 → 1.55，
 *      最大单帧位移 166.86px → 60.3px；25%/50%/75% 进度 57.4/85.6/96.7%
 *      → 14.5/52.4/84.8%（老曲线 25% 时间就跑掉 57% 位移 = "猛弹一下"）。
 *   ③ 左栏宽度改由 flex 派生：打开方向原来内联 width 从 `auto` 变 `calc()`，
 *      **auto↔calc 不可插值 → 首帧直接 snap**（实测跳变 -996px，左栏/分割条
 *      第一帧就跳到终态，只有右屏在动）。这正是"不顺滑"的主因，调时长治不好。
 *      改后首帧跳变 → 0px，且几何与 calc 版本等价（五比例实测差 ≤0.01px）。
 *   ④ 分割条自身宽度 6px↔18px 也要过渡（原来瞬间跳 12px，是第二处可见突变）。
 *
 * ── 同时锁住「不加什么」（避免后人无脑堆属性）─────────────────────
 * 实测 `contain: layout paint` 与 `will-change: width` 对帧数据**零收益**
 * （jerk 1.54 vs 1.54、最大帧位移 59.79 vs 59.79px），故明确断言它们不在。
 *
 * ── 必须保住的既有行为（回归锁）──────────────────────────────────
 *   · 拖拽分割条时无过渡（body.split-resizing）
 *   · prefers-reduced-motion 仍禁用动画
 *   · 关闭后右屏宽度 0 不占位（overflow:hidden + width 0）
 *   · 重开时 iframe 常驻（内容现成，不先空白）
 *   · 阅读模式/无预览布局不变（左栏 flex 派生只在 preview-open 时生效）
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rawCss = readFileSync(join(here, "../styles/editor.css"), "utf8");
/** 去掉注释再断言：本需求的注释里大量出现 "0.28s" / "contain" / "will-change"
 *  等字样（都在解释"为什么不用"），不去掉会误判。 */
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, "");

/** 取某个选择器的规则体（`^selector {` 精确匹配，避免匹配到后代规则） */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, "m"));
  return m ? m[1] : "";
}

/** 取所有 @media (prefers-reduced-motion: reduce) 块（花括号配平） */
function reducedMotionBlocks(): string[] {
  const out: string[] = [];
  const needle = "@media (prefers-reduced-motion: reduce)";
  let from = 0;
  for (;;) {
    const start = css.indexOf(needle, from);
    if (start < 0) break;
    const open = css.indexOf("{", start);
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") {
        depth--;
        if (depth === 0) {
          out.push(css.slice(open + 1, i));
          from = i + 1;
          break;
        }
      }
    }
    if (from <= start) break;
  }
  return out;
}

const TRANSITION_RE = /transition\s*:\s*([^;]+);/;
const EASE = "cubic-bezier(0.33, 0, 0.67, 1)";

// ═══════════════════════════════════════════════════════════════════
// 1. 时长精确 +50%：0.28s → 0.42s，且两栏与分割条严格一致
// ═══════════════════════════════════════════════════════════════════

describe("需求3：过渡时长精确 +50%（0.28s → 0.42s）", () => {
  const shellBlock = ruleBody(".split-preview-shell");

  it("预览外壳的 width 过渡时长是 0.42s", () => {
    expect(shellBlock).toBeTruthy();
    const t = shellBlock.match(TRANSITION_RE);
    expect(t).toBeTruthy();
    expect(t![1]).toMatch(/width\s+0\.42s/);
  });

  it("0.42s 恰好是老值 0.28s 的 1.5 倍（不是随手取的数）", () => {
    // 老值 0.28s 出现在需求文档与本任务描述里；锁住这个比例关系，
    // 防止后人改成 0.4s / 0.45s 这类"差不多"的数。
    expect(0.28 * 1.5).toBeCloseTo(0.42, 10);
    expect(shellBlock).toMatch(/width\s+0\.42s/);
    expect(shellBlock).not.toMatch(/width\s+0\.28s/);
  });

  it("左栏（.source-editor-wrapper）与右栏外壳同曲线同时长 —— 不得一栏先动", () => {
    // 左栏现在由 flex 派生宽度（见第 3 组），但**过渡声明仍必须在**：
    // 预览关闭时它是 flex:1 直接铺满，展开时宽度由布局跟随外壳。
    // 两栏的 transition 值必须逐字符一致，否则会出现相位差。
    const leftBlock = ruleBody(".editor-main-area > .source-editor-wrapper");
    expect(leftBlock).toBeTruthy();
    const leftT = leftBlock.match(TRANSITION_RE)?.[1]?.replace(/\s+/g, " ").trim();
    const shellT = shellBlock.match(TRANSITION_RE)?.[1]?.replace(/\s+/g, " ").trim();
    expect(leftT).toBe(shellT);
  });

  it("分割条的 width / min-width 过渡与两栏同曲线同时长", () => {
    const divBlock = ruleBody(".split-divider");
    expect(divBlock).toBeTruthy();
    expect(divBlock).toMatch(/width\s+0\.42s\s+cubic-bezier\(0\.33,\s*0,\s*0\.67,\s*1\)/);
    // min-width 必须一起过渡，否则被 .split-divider-closed 的 18px 钳住、瞬间跳完
    expect(divBlock).toMatch(/min-width\s+0\.42s\s+cubic-bezier\(0\.33,\s*0,\s*0\.67,\s*1\)/);
  });

  it("全文件不再有 0.28s 的分屏过渡（老值彻底退役）", () => {
    expect(css).not.toMatch(/transition[^;]*0\.28s/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. 顺滑化：曲线换成对称 smoothstep（实测 jerk 2.81 → 1.55）
// ═══════════════════════════════════════════════════════════════════

describe("需求3：缓动曲线换成对称 smoothstep（起步与收尾都减速）", () => {
  const shellBlock = ruleBody(".split-preview-shell");

  it("使用 cubic-bezier(0.33, 0, 0.67, 1)", () => {
    expect(shellBlock).toContain(EASE);
  });

  it("不再使用起步极猛的 cubic-bezier(0.22, 0.61, 0.36, 1)", () => {
    // 老曲线起点斜率 0.61/0.22 ≈ 2.77 → 第一帧就弹出去 166px（占全程 16.6%），
    // 实测 25% 时间走完 57.4% 位移。用户说的"不够顺滑"主要就是它。
    expect(css).not.toContain("cubic-bezier(0.22, 0.61, 0.36, 1)");
    expect(css).not.toContain("cubic-bezier(0.22,0.61,0.36,1)");
  });

  it("新曲线是对称的（首尾切线斜率都为 0 → 起步不弹、收尾不撞墙）", () => {
    // cubic-bezier(x1, y1, x2, y2)：起点斜率 = y1/x1，终点斜率 = (1-y2)/(1-x2)。
    // 两者都为 0 才叫"对称减速"（smoothstep 族）。
    const m = shellBlock.match(/cubic-bezier\(([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\)/);
    expect(m).toBeTruthy();
    const [x1, y1, x2, y2] = m!.slice(1).map(Number);
    expect(y1 / x1).toBe(0); // 起点斜率为 0
    expect((1 - y2) / (1 - x2)).toBe(0); // 终点斜率为 0
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. 顺滑化（主因）：左栏宽度由 flex 派生，消除 auto↔calc 的瞬间 snap
// ═══════════════════════════════════════════════════════════════════

describe("需求3：左栏宽度改 flex 派生（修「打开时左栏第一帧就 snap」）", () => {
  // 实机实测：打开方向首帧跳变 -996px（左栏/分割条在第一帧就跳到打开后的位置），
  // 只有右屏在动 —— 这是"不顺滑"的主因，且与 duration 无关，调时长治不好。
  const rule = css.match(
    /^\.editor-main-area:has\(\.split-preview-shell\.split-preview-open\)\s*>\s*\.source-editor-wrapper\s*\{([^}]*)\}/m,
  );

  it("存在「预览展开时左栏改 flex 派生」的规则", () => {
    expect(rule).toBeTruthy();
  });

  it("同时写 width: auto 与 flex —— 只写 flex 会被内联 width 压住", () => {
    const body = rule![1];
    // 组件在 previewShown 时给左栏写了内联 `width: calc(ratio*100% - 3px)`，
    // 内联样式优先于普通样式；只写 flex:1 实测仍然跳变，必须一起把 width 打回 auto。
    expect(body).toMatch(/width:\s*auto\s*!important/);
    expect(body).toMatch(/flex:\s*1\s+1\s+0%\s*!important/);
  });

  it("只在 preview-open 状态下生效 —— 阅读模式 / 无预览布局不受影响", () => {
    // 选择器里必须带 .split-preview-open：预览关闭时左栏本就该 flex:1 铺满，
    // 阅读模式压根没有 .split-preview-shell，绝不能全局改 .source-editor-wrapper。
    expect(rule![0]).toContain(".split-preview-open");
    // 反向断言：不存在不带状态限定的全局覆盖
    expect(css).not.toMatch(/^\.source-editor-wrapper\s*\{[^}]*flex:\s*1\s+1\s+0%\s*!important/m);
  });

  it("仍保留左栏的 width 过渡声明（同曲线同时长，见第 1 组）", () => {
    const leftBlock = ruleBody(".editor-main-area > .source-editor-wrapper");
    expect(leftBlock).toMatch(/transition:\s*width\s+0\.42s/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. 明确「不堆属性」：contain / will-change / 合成层 hack 均无实测收益
// ═══════════════════════════════════════════════════════════════════

describe("需求3：不为顺滑化堆砌无收益属性（实测结论）", () => {
  const shellBlock = ruleBody(".split-preview-shell");

  it("外壳不再声明 will-change: width（布局属性上无收益，只白占合成层）", () => {
    // 实测有无 will-change 帧数据无差别（jerk 1.57 vs 1.56）。width 是布局属性，
    // will-change 无法避免每帧重排。
    expect(shellBlock).not.toMatch(/will-change\s*:\s*width/);
  });

  it("不加 contain: layout paint（实测 jerk / 最大帧位移与不加完全相同）", () => {
    expect(shellBlock).not.toMatch(/contain\s*:/);
  });

  it("不加 translateZ / backface-visibility（对布局驱动的宽度动画无效）", () => {
    expect(shellBlock).not.toMatch(/translateZ|backface-visibility/);
  });

  it("外壳仍保留 overflow: hidden（关闭态宽度 0 不占位、过渡期不横向闪跳）", () => {
    expect(shellBlock).toMatch(/overflow:\s*hidden/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. 回归锁：既有硬约束一条都不能破
// ═══════════════════════════════════════════════════════════════════

describe("需求3 回归：拖拽分割条期间无过渡", () => {
  it("body.split-resizing 同时禁用左栏、右屏外壳、分割条的过渡", () => {
    const block = css.match(/body\.split-resizing[^{]*\{([^}]*)\}/);
    expect(block).toBeTruthy();
    // 三处都要覆盖：只关两栏、漏掉分割条会让 6↔18px 的过渡在拖拽时残留
    const selectors = css.match(/body\.split-resizing[^{]*\{[^}]*transition:\s*none/);
    expect(selectors).toBeTruthy();
    expect(css).toContain("body.split-resizing .editor-main-area > .source-editor-wrapper");
    expect(css).toContain("body.split-resizing .split-preview-shell");
    expect(css).toContain("body.split-resizing .split-divider");
    expect(block![1]).toMatch(/transition:\s*none/);
  });

  it("拖拽期间仍屏蔽 iframe 指针事件（右拖不冻住的老缺陷兜底）", () => {
    expect(css).toContain("body.split-resizing iframe.split-preview");
    const m = css.match(/body\.split-resizing iframe\.split-preview\s*\{([^}]*)\}/);
    expect(m![1]).toMatch(/pointer-events:\s*none/);
  });
});

describe("需求3 回归：prefers-reduced-motion 仍彻底禁用动画", () => {
  it("存在 reduced-motion 块覆盖三处过渡并置 none", () => {
    const blocks = reducedMotionBlocks();
    const target = blocks.find(
      (b) =>
        /\.split-preview-shell/.test(b) &&
        /\.source-editor-wrapper/.test(b) &&
        /transition:\s*none/.test(b),
    );
    expect(target).toBeTruthy();
  });

  it("分割条也在 reduced-motion 里被关掉（新增的 width/min-width 过渡同样要降级）", () => {
    const blocks = reducedMotionBlocks();
    expect(blocks.some((b) => /\.split-divider\b/.test(b) && /transition:\s*none/.test(b))).toBe(true);
  });
});

describe("需求3 回归：关闭后右屏宽度 0 且不占位 / 重开内容现成", () => {
  it("外壳宽度由内联 style 在 0px 与 calc(...) 之间切换（0 时配合 overflow:hidden 不占位）", () => {
    // 结构事实在 EditorContainer.tsx（Lead 独占），这里只锁 CSS 侧前提：
    // 外壳是 flex-shrink:0 的固定宽度块 + overflow:hidden，宽度 0 时彻底收掉。
    const block = ruleBody(".split-preview-shell");
    expect(block).toMatch(/flex-shrink:\s*0/);
    expect(block).toMatch(/overflow:\s*hidden/);
    expect(block).toMatch(/display:\s*block/);
  });

  it("iframe 由外壳 100% 宽高承载（常驻挂载 → 重开时内容现成，不先空白）", () => {
    const iframeBlock = ruleBody(".split-preview-shell > iframe.split-preview");
    expect(iframeBlock).toMatch(/width:\s*100%/);
    expect(iframeBlock).toMatch(/height:\s*100%/);
    // iframe 自身不做宽度过渡（否则与外层叠加出双段动画）
    expect(iframeBlock).not.toMatch(/transition/);
  });
});
