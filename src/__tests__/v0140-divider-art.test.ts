/**
 * v0.14.0 需求6 —— 分割线竖排小字「艺术字体 + 更浅颜色 + 金属光泽呼吸」源码契约测试
 *
 * 用户原话：
 *   「分隔线上的竖排小字改为艺术字体，颜色再浅一些，呼吸带点金属光泽，
 *     注意这些动画的实现都要考虑性能开销。」
 *
 * 为什么是「源码文本断言」而不是 DOM/行为断言：
 *   这几条验收点（字体栈、颜色混合、渐变裁字、关键帧里到底动了哪些属性）
 *   全部是 CSS 层的事实，jsdom 不算样式、也不跑合成器，只能读源码锁契约。
 *   性能这条尤其重要 —— 它锁的是「**关键帧里不许出现什么**」，
 *   一旦有人把 background-position / color / box-shadow / filter 加回关键帧，
 *   WebView2 会退回每帧重绘 + 文字栅格化（v0.4.5 空状态 Logo 已经踩过这个坑，
 *   见 editor.css 里 .editor-empty-logo 上方的性能注释）。
 *
 * 断言清单：
 *   1. 竖排语义不变：writing-mode: vertical-rl + text-orientation: upright
 *   2. 艺术字体：系统衬线字体栈（含 serif 与具体衬线族名），且不引 @font-face
 *   3. 颜色更浅：用 color-mix 混色，不再是裸的 color: var(--text-tertiary)
 *   4. 金属渐变：linear-gradient + background-clip: text（含 -webkit- 前缀）
 *   5. 性能：@keyframes splitDividerLabelBreathe 块内**只有** opacity / transform
 *   6. prefers-reduced-motion 降级（且降级后仍可见，不会 opacity:0 消失）
 *   7. 关闭态 18px 硬约束不变（竖排四字必须放得下、不能压到正文）
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const readSrc = (rel: string) => readFileSync(join(here, rel), "utf8");

const css = readSrc("../styles/editor.css");

/** 去掉 CSS 注释 —— 注释里大量出现「禁止 background-position」等字样，会污染正则断言 */
const stripCssComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * 提取某个选择器规则块的声明体（取第一个以行首开始的 `.xxx {`）。
 * 用行首锚定可以避开 @supports 里缩进的同名选择器。
 */
function ruleBody(selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, "m"));
  return m ? m[1] : null;
}

/** 用花括号配平提取 @keyframes 块体（比非贪婪正则稳，嵌套 keyframe 步也正确） */
function keyframesBody(name: string): string | null {
  const start = css.indexOf(`@keyframes ${name}`);
  if (start < 0) return null;
  const open = css.indexOf("{", start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return null;
}

/** 取「.split-divider-label 主规则 → 呼吸关键帧」之间的整段（含 @supports 金属渐变层） */
function labelRegion(): string {
  const start = css.indexOf(".split-divider-label {");
  const end = css.indexOf("@keyframes splitDividerLabelBreathe");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return css.slice(start, end);
}

// ─────────────────────────────────────────────────────────
// 1. 竖排语义：v0.14.0 需求1 的交互契约不能被需求6 改坏
// ─────────────────────────────────────────────────────────

describe("v0.14.0 需求6：竖排语义保持（不回退需求1）", () => {
  const block = ruleBody(".split-divider-label") ?? "";

  it("仍有 writing-mode: vertical-rl", () => {
    expect(block).toContain("writing-mode: vertical-rl");
  });

  it("仍有 text-orientation: upright", () => {
    expect(block).toContain("text-orientation: upright");
  });

  it("默认仍不可见（opacity: 0，hover 才浮现）", () => {
    expect(block).toMatch(/opacity:\s*0\s*;/);
  });

  it("仍靠 :has(.split-preview-shell:hover) 从右屏悬停浮出", () => {
    expect(css).toContain(".editor-main-area:has(.split-preview-shell:hover) .split-divider-label");
  });
});

// ─────────────────────────────────────────────────────────
// 2. 艺术字体：系统自带衬线字体栈，零外部字体文件
// ─────────────────────────────────────────────────────────

describe("v0.14.0 需求6：艺术字体（系统衬线栈，不引字体文件）", () => {
  const block = ruleBody(".split-divider-label") ?? "";

  it("字体栈以 serif 兜底（衬线 = 艺术感）", () => {
    expect(block).toMatch(/font-family:[^;]*\bserif\b/);
  });

  it("字体栈含具体衬线族名（Palatino / Georgia 等系统自带）", () => {
    const family = block.match(/font-family:([^;]*);/);
    expect(family).toBeTruthy();
    expect(family![1]).toMatch(/Palatino Linotype|Book Antiqua|Palatino|Georgia/);
  });

  it("中文侧有衬线回退（宋体系，保证竖排中文不是黑体）", () => {
    const family = block.match(/font-family:([^;]*);/);
    expect(family).toBeTruthy();
    expect(family![1]).toMatch(/STZhongsong|华文中宋|Songti SC|SimSun|Noto Serif CJK SC/);
  });

  it("不引入 @font-face / 外部字体文件（离线 + 体积敏感）", () => {
    // 去注释后再断言：注释里会提到「@font-face 加载抖动」这类说明文字
    const code = stripCssComments(css);
    expect(code).not.toMatch(/@font-face/);
    expect(code).not.toMatch(/\.woff2?|\.ttf|\.otf/);
  });

  it("font-weight 500 + small-caps（拉丁文艺术化，中文无害）", () => {
    expect(block).toMatch(/font-weight:\s*500/);
    expect(block).toMatch(/font-variant:\s*small-caps/);
  });

  it("浮雕感来自静态金属带，而非 text-shadow（引擎实测会被吃掉字形）", () => {
    // 实测：background-clip:text + text-shadow 在 WebView2/Chromium 下会把字形吃掉
    // （白+黑两道阴影时墨迹像素从 ~8000 掉到 ~240）。所以"可选加分"的浮雕项放弃，
    // 改由 --label-metal 的明暗交替表达。这里锁住"不要把它加回来"。
    const block = ruleBody(".split-divider-label") ?? "";
    expect(block).not.toMatch(/text-shadow\s*:/);
    expect(keyframesBody("splitDividerLabelBreathe")!).not.toMatch(/text-shadow/);
  });
});

// ─────────────────────────────────────────────────────────
// 3. 颜色更浅：color-mix 混色，不再是裸的 text-tertiary
// ─────────────────────────────────────────────────────────

describe("v0.14.0 需求6：颜色更浅（color-mix 半透明）", () => {
  const block = ruleBody(".split-divider-label") ?? "";

  it("color 使用 color-mix 混入 transparent（比三级文字更淡）", () => {
    expect(block).toMatch(/color:\s*color-mix\(\s*in srgb,\s*var\(--text-tertiary\)[^;]*transparent/);
  });

  it("不再直接是 color: var(--text-tertiary)", () => {
    expect(block).not.toMatch(/color:\s*var\(--text-tertiary\)\s*;/);
  });

  it("hover 态仍会提亮到 --text-secondary / --accent-color", () => {
    const region = labelRegion();
    expect(region).toMatch(/color:\s*var\(--text-secondary\)/);
    expect(css).toMatch(/\.split-divider-label:hover\s*\{[^}]*color:\s*var\(--accent-color\)/);
  });
});

// ─────────────────────────────────────────────────────────
// 4. 金属光泽：静态渐变裁进字形
// ─────────────────────────────────────────────────────────

describe("v0.14.0 需求6：金属渐变（background-clip: text）", () => {
  const region = labelRegion();

  it("有金属色带 linear-gradient", () => {
    expect(region).toMatch(/--label-metal:\s*linear-gradient\(/);
  });

  it("渐变有多次明暗交替的金属节点（≥5 个色标，竖排四字上多处高光带）", () => {
    const metal = region.match(/--label-metal:\s*linear-gradient\(([\s\S]*?)\);/);
    expect(metal).toBeTruthy();
    // 色标数量（每个 color-mix(...) NN% 算一个）
    expect((metal![1].match(/color-mix\(/g) ?? []).length).toBeGreaterThanOrEqual(5);
    // 百分比色标齐全（0% 与 100% 都要有，渐变才闭合）
    expect(metal![1]).toContain("0%");
    expect(metal![1]).toContain("100%");
  });

  it("用 background-clip: text + -webkit-background-clip: text 裁进字形", () => {
    expect(region).toContain("-webkit-background-clip: text");
    expect(region).toContain("background-clip: text");
  });

  it("渐变用 currentColor 派生（6 套主题自动适配，不写死单一主题色）", () => {
    const metal = region.match(/--label-metal:\s*linear-gradient\(([\s\S]*?)\);/);
    expect(metal![1]).toContain("currentColor");
  });

  it("金属带混向 var(--bg-primary) 而非 #ffffff（深色主题才不会越改越亮）", () => {
    // 实测：混白在 dark/night 下对比度飙到 12:1（比旧版抢眼 2 倍），违反"更浅"；
    // 混背景色则是"朝背景方向变淡"，深浅主题行为一致。
    const metal = region.match(/--label-metal:\s*linear-gradient\(([\s\S]*?)\);/);
    expect(metal![1]).toContain("var(--bg-primary)");
    expect(metal![1]).not.toMatch(/#ffffff|#fff\b/i);
  });

  it("金属带色标不含 transparent（alpha 相乘会让字彻底看不见）", () => {
    const metal = region.match(/--label-metal:\s*linear-gradient\(([\s\S]*?)\);/);
    expect(metal![1]).not.toContain("transparent");
  });

  it("文字填充透明让渐变透出字形（-webkit-text-fill-color: transparent）", () => {
    expect(region).toContain("-webkit-text-fill-color: transparent");
  });

  it("药丸底并进同一 background 的 padding-box 层（不能用 ::before，会被字形背景盖住）", () => {
    // 实测：background-clip:text 让字形成为元素自身背景，负 z-index 的 ::before
    // 会画在金属渐变**之上**，把色带冲成一片浅灰。正确做法是 background 多层 +
    // 最后一层用 padding-box 裁剪。
    expect(region).toMatch(/background-clip:\s*text,\s*text,\s*padding-box/);
    expect(region).not.toMatch(/\.split-divider-label::before/);
  });
});

// ─────────────────────────────────────────────────────────
// 5. 性能硬约束：关键帧内只有 opacity / transform
// ─────────────────────────────────────────────────────────

describe("v0.14.0 需求6：呼吸动画性能（合成层属性白名单）", () => {
  const body = keyframesBody("splitDividerLabelBreathe");

  it("关键帧存在且非空", () => {
    expect(body).toBeTruthy();
    expect(body!.trim().length).toBeGreaterThan(0);
  });

  it("关键帧内只出现 opacity 与 transform 两个属性", () => {
    const props = [...body!.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1].trim());
    expect(props.length).toBeGreaterThan(0);
    expect([...new Set(props)].sort()).toEqual(["opacity", "transform"]);
  });

  it("关键帧内没有 background-position（v0.4.5 踩过的重绘根因）", () => {
    expect(body!).not.toMatch(/background-position/);
  });

  it("关键帧内没有 color（避免每帧重算 currentColor 金属渐变）", () => {
    expect(body!).not.toMatch(/(^|[^-\w])color\s*:/);
  });

  it("关键帧内没有 box-shadow / filter（额外 render surface）", () => {
    expect(body!).not.toMatch(/box-shadow/);
    expect(body!).not.toMatch(/filter\s*:/);
  });

  it("关键帧内没有 background / background-size（渐变重绘）", () => {
    expect(body!).not.toMatch(/background(-size|-image|-color)?\s*:/);
  });

  it("用 will-change 提示合成层（并说明元素很小、常驻可接受）", () => {
    const block = ruleBody(".split-divider-label") ?? "";
    expect(block).toMatch(/will-change:\s*opacity,\s*transform/);
    expect(labelRegion()).toMatch(/合成层/);
  });

  it("动画只挂在使用态（hover/focus 与关闭态），默认态不空转", () => {
    // 默认规则块内不得有 animation 声明（只有 hover 与 .split-divider-closed 才挂）
    const block = ruleBody(".split-divider-label") ?? "";
    expect(block).not.toMatch(/animation:/);
    expect(css).toMatch(/animation:\s*splitDividerLabelBreathe/);
  });

  it("窗口失焦时暂停呼吸（app-blurred，与空状态 Logo 同款）", () => {
    expect(css).toMatch(/\.app-blurred\s+\.split-divider-label\s*\{[^}]*animation-play-state:\s*paused/);
  });
});

// ─────────────────────────────────────────────────────────
// 6. 可访问性降级：去掉动画后仍然可见
// ─────────────────────────────────────────────────────────

describe("v0.14.0 需求6：prefers-reduced-motion 降级", () => {
  /** 取出包含 .split-divider-label 的 reduced-motion 块 */
  const blocks = [...css.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\n\}/g)].map(
    (m) => m[0],
  );

  it("存在针对 .split-divider-label 的 reduced-motion 块", () => {
    expect(blocks.some((b) => /\.split-divider-label/.test(b))).toBe(true);
  });

  it("降级时 animation: none（停止呼吸）", () => {
    const b = blocks.find((x) => /\.split-divider-label/.test(x))!;
    expect(b).toMatch(/animation:\s*none/);
  });

  it("降级后仍可见：关闭态保持常驻 0.45，展开态 hover 仍为 opacity: 1", () => {
    // 关闭态常驻半可见不能被降级规则改成 0
    const closed = css.match(/\.split-divider-closed \.split-divider-label\s*\{([^}]*)\}/);
    expect(closed).toBeTruthy();
    expect(closed![1]).toMatch(/opacity:\s*0\.45/);
    // 降级块本身不得把 opacity 压到 0（那会让入口彻底消失）
    const b = blocks.find((x) => /\.split-divider-label/.test(x))!;
    expect(b).not.toMatch(/opacity:\s*0\s*;/);
  });

  it("降级时释放合成层（will-change: auto）", () => {
    const b = blocks.find((x) => /\.split-divider-label/.test(x))!;
    expect(b).toMatch(/will-change:\s*auto/);
  });
});

// ─────────────────────────────────────────────────────────
// 7. 宽度硬约束：关闭态 18px 不变
// ─────────────────────────────────────────────────────────

describe("v0.14.0 需求6：关闭态 18px 宽度硬约束", () => {
  const closed = css.match(/\.split-divider-closed\s*\{([^}]*)\}/);

  it(".split-divider-closed 规则存在", () => {
    expect(closed).toBeTruthy();
  });

  it("关闭态仍是 width: 18px（竖排四字放得下、不压正文）", () => {
    expect(closed![1]).toMatch(/width:\s*18px/);
    expect(closed![1]).toMatch(/min-width:\s*18px/);
  });

  it("展开态仍是 6px（不改拖拽手感）", () => {
    const open = css.match(/^\.split-divider\s*\{([^}]*)\}/m);
    expect(open).toBeTruthy();
    expect(open![1]).toMatch(/width:\s*6px/);
  });

  it("字号 / 字距没有放大到撑破 18px（font-size ≤ 12px，letter-spacing ≤ 3px）", () => {
    const block = ruleBody(".split-divider-label") ?? "";
    const fs = block.match(/font-size:\s*(\d+)px/);
    const ls = block.match(/letter-spacing:\s*(\d+)px/);
    expect(fs).toBeTruthy();
    expect(Number(fs![1])).toBeLessThanOrEqual(12);
    expect(ls).toBeTruthy();
    expect(Number(ls![1])).toBeLessThanOrEqual(3);
  });
});
