// @vitest-environment jsdom
/**
 * v0.17.0 第二轮 #3 / #6：源码面滚动位置稳定性（撤销/恢复 + 格式栏输入辅助）
 *
 * ## 缺陷背景（用户原话）
 * - 第 3 项：「编辑模式下进行撤销或恢复，页面位置会跳动重置。」
 * - 第 6 项：「点击格式栏或语法栏进行输入辅助时，页面会抖动偏离输入区域，页面自动跳到底部。」
 *
 * ## 实测根因（`scripts/v0170-r2-scroll-jump.mjs` / `v0170-r2-toolbar-jump.mjs`，browser probe）
 *
 * ### #3：撤销落地用「整篇替换」→ CM6 重估 heightMap → measure 把 scrollTop 钳到顶部
 * 对照实验（`_tmp-dispatch-test2.mjs`，60 段文档真滚到 50%）：
 * ```
 * 全文替换                    scrollTop 2781 → 86    （Δ-2695，跳到顶）
 * 全文替换 + scrollIntoView:false  scrollTop 2406 → 85    （Δ-2321，**依然跳**）
 * 最小变更（只删 3 字符）      scrollTop 2388 → 2388  （Δ0，纹丝不动）
 * 最小变更 + 选区设在视口外     scrollTop 2781 → 2781  （Δ0）
 * ```
 * ⇒ 根因是**事务形态**（整篇替换），不是 scrollIntoView、不是恢复顺序。
 * 修法：`computeMinimalEdit` 算最小 diff，经 `applyEdit` 走最小事务。
 *
 * ### #6：恢复用**旧像素** + 焦点没夺回
 * ```
 * scrollHeight 8785 → 7316（全文替换让 heightMap 重估）
 * 视口中心 PI30@258 → PI37@258（**内容偏 7 段**：像素拉回了，内容没回来）
 * 光标 caretY 319 → -660（跑出视口）；activeElement = "format-btn"（焦点没回来）
 * ```
 * 修法：内容锚（`captureSurfaceCenterAnchor`）+ 夺回焦点 + 按内容锚恢复滚动。
 *
 * ## 本测试锁什么
 * A. `computeMinimalEdit` 的**最小化契约**（这些是修法的正确性基础，纯函数好测）
 * B. `computeMinimalEdit` 的**兜底契约**（大 diff / 空文本必须返回 null 退回整篇路径）
 * C. `captureSurfaceCenterAnchor` 的**容错契约**（测量返回 null 时不得抛、不得返回假锚点）
 * D. 静态契约：落地路径必须用最小 diff、恢复必须带内容锚 + 夺回焦点
 *
 * ⚠️ 本文件**不测** CM6 真实滚动行为（那要真实浏览器 + 布局）——
 * 那部分由浏览器探针覆盖，两者互补：单测锁"算法与接线形态"，探针锁"真实像素"。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { computeMinimalEdit, captureSurfaceCenterAnchor } from "../components/editor/panes/sourcepane/SourcePane";
import type { SourceSurface } from "../editor/types";

const SRC = readFileSync(
  resolve(__dirname, "../components/editor/panes/sourcepane/SourcePane.tsx"),
  "utf8",
);

// ────────────────────────────────────────────────────────────────
// A. computeMinimalEdit：最小化契约
// ────────────────────────────────────────────────────────────────
describe("computeMinimalEdit —— 撤销落地的『最小 diff』", () => {
  it("尾部插入 3 个字符 → 只插入那 3 个字符（from/to 精确）", () => {
    const before = "第一段\n第二段\n第三段";
    const after = "第一段\n第二段\n第三段xyz";
    const e = computeMinimalEdit(before, after);
    expect(e).not.toBeNull();
    expect(e!.from).toBe(before.length);
    expect(e!.to).toBe(before.length);
    expect(e!.text).toBe("xyz");
  });

  it("删除中间 3 个字符 → 只删那 3 个字符", () => {
    const before = "第aaa一段\n第二段";
    const after = "第一段\n第二段";
    const e = computeMinimalEdit(before, after);
    expect(e).not.toBeNull();
    expect(e!.from).toBe(1);
    expect(e!.to).toBe(4);
    expect(e!.text).toBe("");
  });

  it("前缀 + 后缀都保留 → 改动被夹在中间（不得整篇替换）", () => {
    // 文档要足够大，改动才会落在「1/4 预算」内（见下面的预算契约）
    const before = "HEAD" + "X".repeat(100) + "M".repeat(2000) + "TAIL";
    const after = "HEAD" + "Y".repeat(100) + "M".repeat(2000) + "TAIL";
    const e = computeMinimalEdit(before, after);
    expect(e).not.toBeNull();
    expect(e!.from).toBe(4);
    expect(e!.to).toBe(104);
    expect(e!.text).toBe("Y".repeat(100));
  });

  it("替换后重新拼起来必须**逐字节等于目标文本**（最小化的正确性护栏）", () => {
    const cases: Array<[string, string]> = [
      ["abc", "abcd"],
      ["abcd", "abc"],
      ["abcdef", "abXdef"],
      ["abcdef", "abXXef"],
      ["前面后面", "前面中间后面"],
      ["a\nb\nc", "a\nb\nc\nd"],
      ["x".repeat(50) + "中" + "y".repeat(50), "x".repeat(50) + "文" + "y".repeat(50)],
    ];
    for (const [before, after] of cases) {
      const e = computeMinimalEdit(before, after);
      expect(e, `应能最小化: ${JSON.stringify(before)} → ${JSON.stringify(after)}`).not.toBeNull();
      const rebuilt = before.slice(0, e!.from) + e!.text + before.slice(e!.to);
      expect(rebuilt).toBe(after);
    }
  });

  it("光标位置落在插入内容末尾", () => {
    const before = "abcdef";
    const after = "abcXYZdef";
    const e = computeMinimalEdit(before, after);
    expect(e).not.toBeNull();
    expect(e!.caret).toBe(e!.from + e!.text.length);
  });
});

// ────────────────────────────────────────────────────────────────
// B. computeMinimalEdit：兜底契约（必须退回整篇路径）
// ────────────────────────────────────────────────────────────────
describe("computeMinimalEdit —— 不适用时必须返回 null（退回整篇路径）", () => {
  it("文本完全相同 → null（没有事要做）", () => {
    expect(computeMinimalEdit("同样的内容", "同样的内容")).toBeNull();
  });

  it("空 → 非空 → null（整篇语义，最小化没意义）", () => {
    expect(computeMinimalEdit("", "新内容")).toBeNull();
  });

  it("非空 → 空 → null", () => {
    expect(computeMinimalEdit("旧内容", "")).toBeNull();
  });

  it("整篇换掉（无公共前后缀）→ null（这是切文件/跨文件替换，不是撤销几步）", () => {
    const before = "A".repeat(400);
    const after = "B".repeat(400);
    expect(computeMinimalEdit(before, after)).toBeNull();
  });

  it("改动量超过文档 1/4 → null（避免把整篇语义拆成怪异局部编辑）", () => {
    const before = "x".repeat(1000);
    const after = "y".repeat(1000);
    expect(computeMinimalEdit(before, after)).toBeNull();
  });

  it("小改动（远低于 1/4）仍然最小化 —— 与上一条形成对照", () => {
    const before = "x".repeat(1000);
    const after = "x".repeat(500) + "Z" + "x".repeat(499);
    const e = computeMinimalEdit(before, after);
    expect(e).not.toBeNull();
    expect(e!.text).toBe("Z");
  });

  it("null / undefined 入参不得抛（宿主可能传空镜像）", () => {
    expect(() => computeMinimalEdit(null as unknown as string, "abc")).not.toThrow();
    expect(() => computeMinimalEdit(undefined as unknown as string, "abc")).not.toThrow();
    expect(() => computeMinimalEdit("abc", null as unknown as string)).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────
// C. captureSurfaceCenterAnchor：容错契约
// ────────────────────────────────────────────────────────────────
/** 造一个只有所需方法的假 surface（只实现本函数用到的能力） */
function fakeSurface(opts: {
  textLen: number;
  clientHeight?: number;
  scrollTop?: number;
  /** offset → 内容坐标 Y；返回 undefined 表示"测不到"（模拟 CM6 视口外 coordsAtPos 为 null） */
  yAt: (offset: number) => number | undefined;
}): SourceSurface {
  const clientHeight = opts.clientHeight ?? 800;
  return {
    getText: () => "x".repeat(opts.textLen),
    getScrollTop: () => opts.scrollTop ?? 0,
    getMetrics: () => ({
      totalLines: 1,
      scrollHeight: 10000,
      clientHeight,
      clientWidth: 600,
    }),
    measureRangeContentY: (s: number) => {
      const y = opts.yAt(s);
      return y === undefined ? null : { startY: y, endY: y + 20 };
    },
  } as unknown as SourceSurface;
}

describe("captureSurfaceCenterAnchor —— 内容锚的容错口径", () => {
  it("空文本 → null（不得除零/返回假锚点）", () => {
    expect(captureSurfaceCenterAnchor(fakeSurface({ textLen: 0, yAt: () => 0 }))).toBeNull();
  });

  it("clientHeight 为 0（未布局）→ null", () => {
    expect(
      captureSurfaceCenterAnchor(fakeSurface({ textLen: 100, clientHeight: 0, yAt: () => 0 })),
    ).toBeNull();
  });

  it("全部测不到（视口外）→ null（绝不返回 offset=0 的假锚点）", () => {
    expect(captureSurfaceCenterAnchor(fakeSurface({ textLen: 5000, yAt: () => undefined }))).toBeNull();
  });

  it("部分测得到的点里，挑离视口中线最近的那个（不能挑到文档开头）", () => {
    // 只有 offset 1000/2000/3000 可测，Y 分别是 1000/2100/3200；scrollTop=1800 → 中线屏幕 Y = 400
    // 屏幕 Y = 内容Y − scrollTop ⇒ 2000 处 = 300，最接近 400
    const surface = fakeSurface({
      textLen: 4000,
      clientHeight: 800,
      scrollTop: 1800,
      yAt: (o) => {
        if (o === 1000) return 1000;
        if (o === 2000) return 2100;
        if (o === 3000) return 3200;
        return undefined;
      },
    });
    const a = captureSurfaceCenterAnchor(surface);
    expect(a).not.toBeNull();
    expect(a!.offset).toBe(2000);
    // viewportY 必须是**屏幕 Y**（内容Y − scrollTop），与 textarea 的 captureTextAnchor 同口径
    expect(a!.viewportY).toBe(2100 - 1800);
  });

  it("viewportY 是屏幕坐标（同内容锚 + 不同 scrollTop 必须得到不同 viewportY）", () => {
    const mk = (scrollTop: number) =>
      fakeSurface({
        textLen: 2000,
        clientHeight: 800,
        scrollTop,
        yAt: (o) => (o === 1000 ? 3000 : undefined),
      });
    const a1 = captureSurfaceCenterAnchor(mk(2000));
    const a2 = captureSurfaceCenterAnchor(mk(2600));
    expect(a1!.offset).toBe(1000);
    expect(a2!.offset).toBe(1000);
    expect(a1!.viewportY).toBe(1000); // 3000 - 2000
    expect(a2!.viewportY).toBe(400); // 3000 - 2600
  });
});

// ────────────────────────────────────────────────────────────────
// D. 静态接线契约（防止修法被后人改回"整篇替换 + 旧像素"）
// ────────────────────────────────────────────────────────────────
describe("落地路径的接线契约", () => {
  it("撤销落地必须计算最小 diff（computeMinimalEdit 存在且有调用点）", () => {
    expect(SRC).toMatch(/export function computeMinimalEdit\(/);
    // 调用点：applyHistoryText 的源码分支里
    expect(SRC).toMatch(/const minimal = isRealTextarea \? null : computeMinimalEdit\(beforeText, text\)/);
    // 必须真的用 applyEdit 落地，而不是又回到 setText 整篇
    expect(SRC).toMatch(/sourceSurface\.applyEdit\(\{/);
  });

  it("★ 撤销落地不得再对 CM6 走『整篇 setText』（#3 的根因形态）", () => {
    // applyHistoryText 源码分支里不应出现 surface 的整篇 setText
    // （textarea 路径的受控 value= 是 React 管的，不在此列）
    const applyHistoryBlock = SRC.slice(
      SRC.indexOf("applyHistoryTextRef.current ="),
      SRC.indexOf("insertTextAtCursor"),
    );
    expect(applyHistoryBlock).not.toMatch(/sourceSurface\.setText\(/);
  });

  it("CM6 滚动恢复必须走内容锚（不得只写旧像素）", () => {
    // 恢复块里必须有 scrollToOffset（锚点恢复）
    expect(SRC).toMatch(/sourceSurface\.scrollToOffset\(scrollPlan\.anchor\.offset, \{ center: true \}\)/);
    // 且不得无条件写像素 0
    expect(SRC).not.toMatch(/setScrollTop\(0\)\s*;?\s*\/\/ 恢复/);
  });

  it("格式/语法按钮恢复必须**夺回焦点**（否则点完无法继续打字）", () => {
    // restoreAfterDiscreteEdit 的 apply 里必须 focus()
    const block = SRC.slice(SRC.indexOf("const restoreAfterDiscreteEdit"), SRC.indexOf("const handleFormatAction"));
    expect(block).toMatch(/sourceSurface\.focus\(\)/);
    // 并且先恢复光标再恢复滚动（顺序反了会被 CM6 的 setSelection 覆盖）
    const focusAt = block.indexOf("sourceSurface.focus()");
    const anchorAt = block.indexOf("sourceSurface.scrollToOffset(mapped.offset");
    expect(focusAt).toBeGreaterThan(-1);
    expect(anchorAt).toBeGreaterThan(-1);
    expect(focusAt).toBeLessThan(anchorAt);
  });

  it("内容锚恢复必须幂等重试（rAF / 60ms / 160ms 三段，修正异步布局）", () => {
    // 注意源码里 setTimeout 带 `window.` 前缀
    expect(SRC).toMatch(/requestAnimationFrame\(\(\) => \{\s*\n\s*applyScrollRestore\(\);/);
    expect(SRC).toMatch(/window\.setTimeout\(applyScrollRestore, 60\)/);
    expect(SRC).toMatch(/window\.setTimeout\(applyScrollRestore, 160\)/);
  });

  it("★ 同步阶段不得用历史条目的旧像素（#3 逐帧往返的直接成因）", () => {
    // 曾经的写法：const keep = ... sel.scrollTop ... → 跨模式撤销时 sel.scrollTop=0 主动写顶
    const syncBlock = SRC.slice(
      SRC.indexOf('if (scrollPlan.kind !== "none") {'),
      SRC.indexOf("requestAnimationFrame(() => {\n        applyScrollRestore();"),
    );
    expect(syncBlock).not.toMatch(/sel\s*&&\s*typeof sel\.scrollTop/);
    // 必须用实时位置
    expect(syncBlock).toMatch(/sourceSurface\.getScrollTop\(\)/);
  });

  it("恢复不得在文本长度变化时用像素（锚内容不锚像素，语义地图 §4-33）", () => {
    const block = SRC.slice(SRC.indexOf("const restoreAfterDiscreteEdit"), SRC.indexOf("const handleFormatAction"));
    expect(block).toMatch(/textLenUnchanged/);
    expect(block).toMatch(/pixelScrollTop !== null && textLenUnchanged/);
  });
});
