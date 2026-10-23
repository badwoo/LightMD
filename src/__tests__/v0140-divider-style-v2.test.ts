/**
 * v0.14.0 第三批 需求5 —— 竖排小字换风格 v2 契约测试
 *
 * 用户原话（第三批）：
 *   「竖排小字艺术化再换个字体样式和风格，简单的呼吸渐变就行，不要求金属光泽了。」
 *
 * 这一条是对**第二批**（衬线艺术字 + 七段金属色带 + background-clip 多层裁字）的
 * 改判，所以本文件单独锁"新口径"，与 v0140-divider-art.test.ts（已按新需求更新）
 * 互补：那边锁竖排语义/性能/reduced-motion/18px 等长期约束，这边锁"风格确实换了、
 * 金属光泽确实没了、动画确实只剩 opacity/transform"。
 *
 * 为什么是源码文本断言：字体栈、渐变层数、关键帧属性都是 CSS 层事实，
 * jsdom 不算样式更不跑合成器，只能读源码锁契约（与既有 v0140 测试同款做法）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "../styles/editor.css"), "utf8");
const stripCssComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "");

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, "m"));
  return m ? m[1] : "";
}

/** @keyframes 块体（花括号配平，抗嵌套） */
function keyframesBody(name: string): string {
  const start = css.indexOf(`@keyframes ${name}`);
  if (start < 0) return "";
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return "";
}

/** .split-divider-label 主规则 → 呼吸关键帧 之间的整段（含 @supports 裁字层） */
function labelRegion(): string {
  const start = css.indexOf(".split-divider-label {");
  const end = css.indexOf("@keyframes splitDividerLabelBreathe");
  return css.slice(start, end);
}

// ═══════════════════════════════════════════════════════════
// 1. 风格换了：从「衬线艺术字」换成「等宽/几何轻线条」
// ═══════════════════════════════════════════════════════════

describe("需求5（第三批）：字体样式与风格确实换了一种", () => {
  const block = ruleBody(".split-divider-label");

  it("字体栈是等宽/几何风格（Cascadia Code / Consolas / ui-monospace）", () => {
    const family = block.match(/font-family:([^;]*);/);
    expect(family).toBeTruthy();
    expect(family![1]).toMatch(/Cascadia Code|Cascadia Mono|Consolas/);
    expect(family![1]).toMatch(/ui-monospace|SFMono-Regular|monospace/);
  });

  it("中文回退是无衬线几何体（雅黑/PingFang），且明确不落回宋体系", () => {
    const family = block.match(/font-family:([^;]*);/);
    expect(family![1]).toMatch(/Microsoft YaHei|微软雅黑|PingFang SC|Hiragino Sans GB/);
    expect(family![1]).not.toMatch(/SimSun|Songti|STZhongsong|华文中宋|Noto Serif CJK/);
  });

  it("上一版那套衬线艺术字栈已彻底退出（Palatino / Georgia / serif 兜底）", () => {
    const family = block.match(/font-family:([^;]*);/);
    expect(family![1]).not.toMatch(/Palatino|Georgia|Book Antiqua/);
    // 若还留 serif 兜底，等宽/几何栈一旦落空就会退回衬线，风格白换
    expect(family![1]).not.toMatch(/\bserif\b/);
  });

  it("轻线条：细字重 400 + 拉开字距（letter-spacing 3px，上限值）", () => {
    expect(block).toMatch(/font-weight:\s*400/);
    expect(block).toMatch(/letter-spacing:\s*3px/);
  });

  it("用 full-width（拉丁全角方框）而非 small-caps（衬线艺术字的旧修饰）", () => {
    expect(block).toMatch(/font-variant:\s*full-width/);
    expect(block).not.toMatch(/font-variant:\s*small-caps/);
  });

  it("零外部字体文件（@font-face / woff / ttf / otf 一律没有）", () => {
    const code = stripCssComments(css);
    expect(code).not.toMatch(/@font-face/);
    expect(code).not.toMatch(/\.woff2?\b|\.ttf\b|\.otf\b/);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. 金属光泽没了（用户明确「不要求金属光泽了」）
// ═══════════════════════════════════════════════════════════

describe("需求5（第三批）：金属光泽彻底移除", () => {
  it("--label-metal 变量已删除", () => {
    expect(stripCssComments(css)).not.toContain("--label-metal");
  });

  it("没有多层 background-clip:text 裁字（旧版是 text,text,padding-box 三层）", () => {
    const region = stripCssComments(labelRegion());
    expect(region).not.toMatch(/background-clip:\s*text\s*,\s*text\s*,/);
    // 新实现只允许「text + padding-box」两层：字形一层 + 药丸底一层
    expect(region).toContain("background-clip: text, padding-box");
  });

  it("没有 radial-gradient（旧版第二层是金属径向柔光）", () => {
    expect(stripCssComments(labelRegion())).not.toMatch(/radial-gradient/);
  });

  it("没有 text-shadow / filter（浮雕用不着，且本引擎会吃掉字形）", () => {
    const block = ruleBody(".split-divider-label");
    expect(block).not.toMatch(/text-shadow\s*:/);
    expect(block).not.toMatch(/(^|[^-\w])filter\s*:/);
  });

  it("用户可见文案里不再出现「金属」字样（i18n 文案未被污染）", () => {
    const zh = readFileSync(join(here, "../i18n/locales/zh-CN.ts"), "utf8");
    const en = readFileSync(join(here, "../i18n/locales/en-US.ts"), "utf8");
    // 只查标签文案本身，不查注释
    const zhPreview = zh.split("\n").filter((l) => /preview\.toggle/.test(l)).join("\n");
    const enPreview = en.split("\n").filter((l) => /preview\.toggle/.test(l)).join("\n");
    expect(zhPreview).not.toContain("金属");
    expect(enPreview.toLowerCase()).not.toContain("metal");
  });
});

// ═══════════════════════════════════════════════════════════
// 3. 简单呼吸渐变：一层静态极淡线性渐变 + 只动 opacity
// ═══════════════════════════════════════════════════════════

describe("需求5（第三批）：简单呼吸渐变（静态底层 + opacity 呼吸）", () => {
  const block = ruleBody(".split-divider-label");
  const region = labelRegion();

  it("保留一层静态极淡线性渐变 --label-sheen（180deg 竖向）", () => {
    expect(region).toMatch(/--label-sheen:\s*linear-gradient\(\s*180deg/);
  });

  it("该渐变最多 2 个色标（「简单」的量化口径），且由 currentColor 派生", () => {
    const sheen = region.match(/--label-sheen:\s*linear-gradient\(([\s\S]*?)\);/);
    expect(sheen).toBeTruthy();
    expect((sheen![1].match(/color-mix\(/g) ?? []).length).toBeLessThanOrEqual(2);
    expect((sheen![1].match(/color-mix\(/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect(sheen![1]).toContain("currentColor");
  });

  it("渐变是静态的：不进 keyframes、不挂 background-position 动画", () => {
    const kf = stripCssComments(keyframesBody("splitDividerLabelBreathe"));
    expect(kf).not.toMatch(/background/);
    expect(block).not.toMatch(/animation:[^;]*\bbackground/);
    // 整份 CSS 里没有任何 background-position 关键帧（v0.4.5 的根因）
    expect(stripCssComments(css)).not.toMatch(/@keyframes[^{]*\{[^}]*background-position/);
  });

  it("呼吸只动 opacity（+ 允许极微小 transform scale）", () => {
    const kf = keyframesBody("splitDividerLabelBreathe");
    const props = [...kf.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1].trim());
    expect([...new Set(props)].sort()).toEqual(["opacity", "transform"]);
    // 关键帧里只有 opacity 明暗变化（0.55 ↔ 1），没有颜色/背景/位移抖动
    expect(kf).toMatch(/opacity:\s*0\.55/);
    expect(kf).toMatch(/opacity:\s*1\s*;/);
    expect(kf).toMatch(/scale\(0\.9[0-9]\)|scale\(1\)/);
  });

  it("动画挂在 hover/focus 与关闭态，默认态不空转", () => {
    expect(block).not.toMatch(/animation:/);
    expect(css).toMatch(/\.split-divider-closed \.split-divider-label\s*\{[^}]*animation:\s*splitDividerLabelBreathe/);
    expect(css).toMatch(/animation:\s*splitDividerLabelBreathe 2\.4s/);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. 性能契约不回退（沿用第二批的硬约束）
// ═══════════════════════════════════════════════════════════

describe("需求5（第三批）：性能契约（关键帧属性白名单）", () => {
  it("关键帧内只允许 opacity / transform", () => {
    const kf = keyframesBody("splitDividerLabelBreathe");
    const props = [...kf.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1].trim());
    expect(props.length).toBeGreaterThan(0);
    expect([...new Set(props)].sort()).toEqual(["opacity", "transform"]);
  });

  it("关键帧内没有 color / box-shadow / filter / background-size", () => {
    const kf = keyframesBody("splitDividerLabelBreathe");
    expect(kf).not.toMatch(/(^|[^-\w])color\s*:/);
    expect(kf).not.toMatch(/box-shadow/);
    expect(kf).not.toMatch(/filter\s*:/);
    expect(kf).not.toMatch(/background(-size|-image|-color|-position)?\s*:/);
  });

  it("will-change 只提示合成层属性", () => {
    expect(ruleBody(".split-divider-label")).toMatch(/will-change:\s*opacity,\s*transform/);
  });

  it("app-blurred 时暂停动画（后台不持续合成）", () => {
    expect(css).toMatch(/\.app-blurred\s+\.split-divider-label\s*\{[^}]*animation-play-state:\s*paused/);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. 可访问性 + 18px 硬约束（换风格后仍必须成立）
// ═══════════════════════════════════════════════════════════

describe("需求5（第三批）：reduced-motion 降级仍生效", () => {
  const blocks = [...css.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\n\}/g)].map(
    (m) => m[0],
  );
  const target = blocks.find((b) => /\.split-divider-label/.test(b));

  it("有 reduced-motion 块且 animation: none", () => {
    expect(target).toBeTruthy();
    expect(target!).toMatch(/animation:\s*none/);
  });

  it("降级后仍可见（不把 opacity 压到 0），并释放合成层", () => {
    expect(target!).not.toMatch(/opacity:\s*0\s*;/);
    expect(target!).toMatch(/will-change:\s*auto/);
  });
});

describe("需求5（第三批）：关闭态 18px 硬约束（四字不溢出、不压正文）", () => {
  it("关闭态 18px / 展开态 6px 不变", () => {
    expect(css.match(/\.split-divider-closed\s*\{([^}]*)\}/)![1]).toMatch(/width:\s*18px/);
    expect(css.match(/^\.split-divider\s*\{([^}]*)\}/m)![1]).toMatch(/width:\s*6px/);
  });

  it("字号 ≤ 12px、字距 ≤ 3px（新字体风格不许把文字撑出 18px）", () => {
    const block = ruleBody(".split-divider-label");
    const fs = Number(block.match(/font-size:\s*(\d+)px/)![1]);
    const ls = Number(block.match(/letter-spacing:\s*(\d+)px/)![1]);
    expect(fs).toBeLessThanOrEqual(12);
    expect(ls).toBeLessThanOrEqual(3);
    // 横向占位 = 字形 1em + 左右 padding 3px×2 = 17px < 18px
    expect(fs + 6).toBeLessThanOrEqual(18);
  });

  it("竖排语义没被换风格改坏（vertical-rl + upright 仍在）", () => {
    const block = ruleBody(".split-divider-label");
    expect(block).toContain("writing-mode: vertical-rl");
    expect(block).toContain("text-orientation: upright");
  });
});
