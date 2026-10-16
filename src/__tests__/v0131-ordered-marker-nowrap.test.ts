// @vitest-environment jsdom
/**
 * v0.13.1 需求15：阅读模式块级源码标记（灰色语法小字）**不得折行**。
 *
 * 缺陷背景（用户报告）：「阅读模式下编辑有序列表会有灰色格式语法小字，但超过两位数后，
 * 例如 12，灰色语法小字变成纵向排列了，不美观，要改为横向。」
 *
 * 根因（CSS 2.1 §10.3.7 shrink-to-fit）：
 *   `.ProseMirror .pm-block-marker::before` 是绝对定位且只给了 `right: 100%`
 *   （`left` 为 auto），因此 shrink-to-fit 的可用宽度 =
 *   包含块宽度 − right(= 包含块宽度) = **0** → width 退化为 **min-content**；
 *   而 `.ProseMirror` 的 `word-break: break-word` 被继承下来，允许任意字符间断行
 *   → "12. " 被逐字竖排（1 / 2 / . 各自一行）。
 *
 * 修法：给该伪元素加 `white-space: nowrap`（与既有 `pm-heading-badge`、emoji 短码同款），
 * 盒子改按 max-content 计算并整体向左伸展（right:100% 的定位方向）。
 *
 * ─── 为什么用"加载真实 CSS + 检查规则"来断言 ───
 * jsdom **不做真实排版**（没有 shrink-to-fit、没有 word-break 折行计算），
 * 所以无法通过 getBoundingClientRect 量出"两行还是三行"。可测的、且与真实渲染
 * 因果一致的事实是：**该选择器是否声明了 nowrap**。真实 Chromium 下 nowrap 直接
 * 决定盒子宽度取 max-content（不会折行），因此这条规则断言就是折行的直接回归锁。
 * 这里显式加载真实 editor.css 后按选择器断言，避免"源码字符串匹配"式的脆弱断言。
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { computeBlockMarker, orderedListMarker } from "../utils/blockMarkers";

/** 注入真实 editor.css 到文档，返回可查询的样式表 */
function loadRealEditorCss(): CSSStyleSheet {
  const cssPath = path.resolve(__dirname, "../styles/editor.css");
  const css = fs.readFileSync(cssPath, "utf8");
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  const sheet = style.sheet;
  if (!sheet) throw new Error("样式表未生效");
  return sheet as CSSStyleSheet;
}

/** 找出声明了指定属性的规则体（按选择器精确匹配） */
function ruleFor(sheet: CSSStyleSheet, selector: string): CSSStyleRule | null {
  const rules = Array.from(sheet.cssRules);
  for (const r of rules) {
    if (r instanceof CSSStyleRule && r.selectorText === selector) return r;
  }
  return null;
}

beforeAll(() => {
  loadRealEditorCss();
});

describe("v0.13.1 需求15：块级标记伪元素必须 nowrap", () => {
  it("`.pm-block-marker::before` 声明 white-space: nowrap（两位数序号不再竖排）", () => {
    const sheet = loadRealEditorCss();
    const rule = ruleFor(sheet, ".ProseMirror .pm-block-marker::before");
    expect(rule, "未找到 .ProseMirror .pm-block-marker::before 规则").toBeTruthy();
    const ws = rule!.style.getPropertyValue("white-space").trim();
    expect(ws).toBe("nowrap");
  });

  it("该规则仍保留 right:100% 的向左伸展定位（nowrap 后盒子靠左生长，不压住正文）", () => {
    const sheet = loadRealEditorCss();
    const rule = ruleFor(sheet, ".ProseMirror .pm-block-marker::before");
    expect(rule!.style.getPropertyValue("right").trim()).toBe("100%");
    // left 必须保持 auto：若被设为 0 则 nowrap 的盒子会向右覆盖正文
    const left = rule!.style.getPropertyValue("left").trim();
    expect(left === "" || left === "auto").toBe(true);
  });

  it("对照：标题徽标同样是 nowrap（既有修法一致，不是孤例）", () => {
    const sheet = loadRealEditorCss();
    const rule = ruleFor(sheet, ".ProseMirror .pm-heading-badge");
    expect(rule, "未找到 .ProseMirror .pm-heading-badge 规则").toBeTruthy();
    expect(rule!.style.getPropertyValue("white-space").trim()).toBe("nowrap");
  });
});

describe("v0.13.1 需求15：两位数序号的 marker 文本本身是横向单行字符串", () => {
  it("序号 12 → '12. '（含空格与分隔符，供 ::before 单行渲染）", () => {
    expect(orderedListMarker(12, {})).toBe("12. ");
    expect(orderedListMarker(120, {})).toBe("120. ");
  });

  it("从中间起始的列表（order=12）也给出两位数", () => {
    // ordinal=1 表示同级第 1 项，列表自身从 12 开始 → 实际显示 12
    expect(orderedListMarker(1, { order: 12 })).toBe("12. ");
    expect(orderedListMarker(1, { order: 12, delim: ")" })).toBe("12) ");
  });

  it("marker 文本不含任何换行字符（竖排只可能来自 CSS 折行）", () => {
    for (const n of [9, 10, 12, 99, 100, 1000]) {
      const m = orderedListMarker(n, {});
      expect(m).not.toMatch(/[\n\r\u2028\u2029]/);
      expect(m).toContain(String(n));
    }
  });

  it("computeBlockMarker 对有序列表项给出带数字的 marker（两位数路径可达）", () => {
    const r = computeBlockMarker({
      type: "list_item",
      attrs: {},
      ordinal: 12,
      parentType: "ordered_list",
    });
    expect(r).toBeTruthy();
    expect(r!.marker).toBe("12. ");
  });
});
