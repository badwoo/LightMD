/**
 * v0.14.0 需求6 —— 分割线竖排小字「艺术字体 + 更浅颜色 + 金属光泽呼吸」源码契约测试
 *
 * ⚠️ v0.14.0 第三批改版说明（本文件必须跟着改，不能删）：
 *   本文件原来锁的是第二批的实现口径 ——「系统衬线艺术字（Palatino/Georgia/宋体）
 *   + 静态七段金属色带 + background-clip:text」。第三批用户明确改口：
 *     「竖排小字艺术化再换个字体样式和风格，简单的呼吸渐变就行，不要求金属光泽了。」
 *   于是同一批验收点全部改判：
 *     衬线艺术字 → 等宽/几何「轻线条」风格（Cascadia Code/Consolas + 雅黑/PingFang）
 *     七段金属色带 → 单层极淡静态浅色带（--label-sheen，只画一次、不参与动画）
 *     多层 background-clip:text,text,padding-box → 单层 text + padding-box
 *   **保留不变的**（下面继续锁）：竖排语义、更浅的 color-mix 基色、
 *   关键帧只允许 opacity/transform 的性能硬约束、reduced-motion 降级、关闭态 18px。
 *   每一项为什么改、改成了什么，逐条注释在对应断言上方。
 *
 * 为什么是「源码文本断言」而不是 DOM/行为断言：
 *   这几条验收点（字体栈、颜色混合、渐变裁字、关键帧里到底动了哪些属性）
 *   全部是 CSS 层的事实，jsdom 不算样式、也不跑合成器，只能读源码锁契约。
 *   性能这条尤其重要 —— 它锁的是「**关键帧里不许出现什么**」，
 *   一旦有人把 background-position / color / box-shadow / filter 加回关键帧，
 *   WebView2 会退回每帧重绘 + 文字栅格化（v0.4.5 空状态 Logo 已经踩过这个坑，
 *   见 editor.css 里 .editor-empty-logo 上方的性能注释）。
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

/** 取「.split-divider-label 主规则 → 呼吸关键帧」之间的整段（含 @supports 浅色带层） */
function labelRegion(): string {
  const start = css.indexOf(".split-divider-label {");
  const end = css.indexOf("@keyframes splitDividerLabelBreathe");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return css.slice(start, end);
}

// ─────────────────────────────────────────────────────────
// 1. 竖排语义：v0.14.0 需求1 的交互契约不能被后续改版改坏
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
// 2. 字体风格（第三批改判）：等宽/几何「轻线条」，不再是衬线艺术字
//
//    为什么改：用户第三批原话「再换个字体样式和风格」——第二批那套
//    Palatino/Georgia + 华文中宋/宋体的衬线艺术字被明确要求换掉。
//    新风格选「等宽/几何轻线条」：西文等宽（笔画等粗、直线直角，机械精确，
//    与"分割条/尺寸标注"的语义同族），中文配无衬线几何体（雅黑/PingFang，
//    等粗方正骨架），字重 400 细线条 + letter-spacing 3px 拉开留白。
// ─────────────────────────────────────────────────────────

describe("v0.14.0 第三批：字体风格改为等宽/几何「轻线条」", () => {
  const block = ruleBody(".split-divider-label") ?? "";

  it("西文用系统等宽栈（Cascadia Code / Consolas / ui-monospace）", () => {
    const family = block.match(/font-family:([^;]*);/);
    expect(family).toBeTruthy();
    expect(family![1]).toMatch(/Cascadia Code|Cascadia Mono|Consolas/);
    expect(family![1]).toMatch(/ui-monospace|monospace/);
  });

  it("不再使用衬线艺术字栈（Palatino / Georgia / 宋体 全部退出）", () => {
    // 这是第三批改判的核心：衬线 + 艺术字是上一版口径，用户已要求换风格。
    // 注意只查 font-family 声明本身，不查注释（注释里会提到"上一版是衬线"）。
    const family = block.match(/font-family:([^;]*);/);
    expect(family).toBeTruthy();
    const fam = family![1];
    expect(fam).not.toMatch(/Palatino|Georgia|Book Antiqua|STZhongsong|华文中宋|Songti|SimSun|Noto Serif/);
    // serif 兜底也必须消失（否则等宽/几何栈一旦全落空就退回衬线，风格又变回去）
    expect(fam).not.toMatch(/\bserif\b/);
  });

  it("中文回退是无衬线几何体（雅黑 / PingFang SC），不能落回宋体", () => {
    // 中文标签「关闭预览/打开预览」四个汉字：等宽西文字体不含汉字字形，必然逐字回退。
    // 显式指定无衬线中文体，保证与等宽西文同族（等粗、方正），而不是又回到衬线宋体。
    const family = block.match(/font-family:([^;]*);/);
    expect(family).toBeTruthy();
    expect(family![1]).toMatch(/Microsoft YaHei|微软雅黑|PingFang SC|Hiragino Sans GB/);
  });

  it("细字重 400 = 轻线条（不再用 500 的中等粗细）", () => {
    expect(block).toMatch(/font-weight:\s*400/);
  });

  it("font-variant: full-width 让拉丁按全角方框排（与汉字同宽）", () => {
    // 第三批不再用 small-caps（那是衬线艺术字的修饰），改为 full-width。
    expect(block).toMatch(/font-variant:\s*full-width/);
    expect(block).not.toMatch(/font-variant:\s*small-caps/);
  });

  it("不引入 @font-face / 外部字体文件（离线 + 体积敏感）", () => {
    // 去注释后再断言：注释里会提到「@font-face 加载抖动」这类说明文字
    const code = stripCssComments(css);
    expect(code).not.toMatch(/@font-face/);
    expect(code).not.toMatch(/\.woff2?|\.ttf|\.otf/);
  });
});

// ─────────────────────────────────────────────────────────
// 3. 颜色（沿用第二批口径，用户没要求改回深色）
// ─────────────────────────────────────────────────────────

describe("v0.14.0 需求6：颜色更浅（color-mix 半透明，沿用）", () => {
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
// 4. 呼吸渐变（第三批改判）：简单一层静态浅色带，不要金属光泽
//
//    为什么改：用户原话「简单的呼吸渐变就行，不要求金属光泽了」。
//    所以：① 七段金属色带（--label-metal）必须消失；
//          ② 不再有多层裁字（金属层 + 径向柔光 + padding-box 三层裁剪）；
//          ③ 不出现 filter / text-shadow 浮雕；
//          ④ 最多保留**一层静态**极淡线性渐变（--label-sheen）作为底色感，
//             它不参与动画 —— 明灭完全由关键帧里的 opacity 负责。
// ─────────────────────────────────────────────────────────

describe("v0.14.0 第三批：简单呼吸渐变（去金属光泽）", () => {
  const region = labelRegion();
  const block = ruleBody(".split-divider-label") ?? "";

  it("金属色带 --label-metal 已删除（用户明确不再要金属光泽）", () => {
    const code = stripCssComments(css);
    expect(code).not.toContain("--label-metal");
  });

  it("也没有任何 radial-gradient / 多层裁字柔光（简单就只留一层线性渐变）", () => {
    const code = stripCssComments(labelRegion());
    expect(code).not.toMatch(/radial-gradient/);
  });

  it("静态底色感是一层极淡的线性渐变（--label-sheen），只有两个色标", () => {
    // "简单"的量化口径：单层、≤2 个色标、竖向（180deg）。
    // 保留它的理由：纯色字形+纯 opacity 太素，一层静态渐变给字形一点底色层次；
    // 它只画一次，不参与动画，性能开销为零（合成器只插值 opacity/transform）。
    expect(region).toMatch(/--label-sheen:\s*linear-gradient\(\s*180deg/);
    const sheen = region.match(/--label-sheen:\s*linear-gradient\(([\s\S]*?)\);/);
    expect(sheen).toBeTruthy();
    // 色标数量 = color-mix(...) 出现次数（每个色标一个）。上限 2。
    expect((sheen![1].match(/color-mix\(/g) ?? []).length).toBeLessThanOrEqual(2);
    // 渐变的 currentColor 派生（6 套主题自动适配，不写死主题灰）
    expect(sheen![1]).toContain("currentColor");
  });

  it("渐变色标混向 var(--bg-primary) 而非 #ffffff（深色主题才不会越改越亮）", () => {
    const sheen = region.match(/--label-sheen:\s*linear-gradient\(([\s\S]*?)\);/);
    expect(sheen![1]).toContain("var(--bg-primary)");
    expect(sheen![1]).not.toMatch(/#ffffff|#fff\b/i);
  });

  it("色标不含 transparent（alpha 相乘会让字彻底看不见）", () => {
    const sheen = region.match(/--label-sheen:\s*linear-gradient\(([\s\S]*?)\);/);
    expect(sheen![1]).not.toContain("transparent");
  });

  it("裁字只用「text + padding-box」两层，不再有三层 text,text,padding-box", () => {
    // 第三批：金属层 + 径向柔光两层裁字是第二批的产物，现在只剩
    // 静态浅色带（text）+ 药丸底（padding-box）。
    expect(region).toContain("-webkit-background-clip: text, padding-box");
    expect(region).toContain("background-clip: text, padding-box");
    expect(region).not.toContain("background-clip: text, text, padding-box");
  });

  it("文字填充透明让渐变透出字形（-webkit-text-fill-color: transparent）", () => {
    expect(region).toContain("-webkit-text-fill-color: transparent");
  });

  it("药丸底并进同一 background 的 padding-box 层（不能用 ::before，会被字形背景盖住）", () => {
    // 实测：background-clip:text 让字形成为元素自身背景，负 z-index 的 ::before
    // 会画在渐变**之上**，把色带冲成一片浅灰。正确做法是 background 多层 +
    // 最后一层用 padding-box 裁剪。
    expect(region).not.toMatch(/\.split-divider-label::before/);
  });

  it("没有 filter / text-shadow 浮雕（本引擎下会吃掉字形，用户也不要）", () => {
    expect(block).not.toMatch(/text-shadow\s*:/);
    expect(block).not.toMatch(/[^-]filter\s*:/);
    expect(keyframesBody("splitDividerLabelBreathe")!).not.toMatch(/text-shadow|filter/);
  });
});

// ─────────────────────────────────────────────────────────
// 5. 性能硬约束：关键帧内只有 opacity / transform（沿用第二批，不放松）
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

  it("关键帧内没有 color（避免每帧重算 currentColor 渐变）", () => {
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
// 7. 宽度硬约束：关闭态 18px 不变（第三批换字体风格后仍必须成立）
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
    // 第三批把 letter-spacing 从 2px 提到上限 3px（拉出"轻线条"的留白感），
    // 但仍必须守住 18px：横向占位 ≈ 11px 字形 + 2×3px padding = 17px < 18px。
    const block = ruleBody(".split-divider-label") ?? "";
    const fs = block.match(/font-size:\s*(\d+)px/);
    const ls = block.match(/letter-spacing:\s*(\d+)px/);
    expect(fs).toBeTruthy();
    expect(Number(fs![1])).toBeLessThanOrEqual(12);
    expect(ls).toBeTruthy();
    expect(Number(ls![1])).toBeLessThanOrEqual(3);
  });

  it("竖排四字总高在合理范围（4×11 + 3×3 + 20 padding ≈ 73px，远小于半屏）", () => {
    // 这条不是死数字，而是把"padding 别乱加"锁住：上下 padding 各 10px 是硬值。
    const block = ruleBody(".split-divider-label") ?? "";
    expect(block).toMatch(/padding:\s*10px\s+3px/);
  });
});
