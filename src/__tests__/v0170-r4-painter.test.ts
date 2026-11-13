import { describe, it, expect } from "vitest";
import {
  wrapRangeWithMarks,
  SOURCE_MARK_WRAPPERS,
  isSnapshotEmpty,
  collectSourceSnapshot,
} from "../utils/formatPainter";

/**
 * v0.17.0 第四轮 · T5 · 第 7 项：格式刷纯函数层测试
 *
 * ## 为什么这些测试必须存在（本项目踩过的坑）
 * `v0152-mode-slide.test.ts` 曾用 `readFileSync` 断言 CSS **内容**正确，
 * 但那份 CSS **全仓零 import** —— 单测全绿、功能完全不可用。
 * 所以：
 * - **本文件只测纯函数契约**（输入→输出），不假装验证了端到端；
 * - **端到端**由 `scripts/v0170-r4-painter-*.mjs` 在真实浏览器里验证；
 * - 两者互补，报告里分开写。
 */

describe("D1：isSnapshotEmpty —— 空快照判定口径", () => {
  it("null / undefined → 空", () => {
    expect(isSnapshotEmpty(null)).toBe(true);
    expect(isSnapshotEmpty(undefined)).toBe(true);
  });

  it("有行内 mark → 非空", () => {
    expect(isSnapshotEmpty({ marks: ["strong"], blockType: "paragraph" })).toBe(false);
    expect(isSnapshotEmpty({ marks: ["em"], blockType: null })).toBe(false);
  });

  it("有任务列表样式 → 非空（图标样式也是格式）", () => {
    expect(isSnapshotEmpty({ marks: [], blockType: "bullet_list", taskStyle: "circle" })).toBe(false);
  });

  it("★ 只有 paragraph 块型 + 无 mark → **空**（这是 D1 的核心口径）", () => {
    // 普通段落是"默认态"，不算可复制的格式。
    // 若这条判成非空，D1 就修不好：用户选普通文字仍会 arm 成功然后点了没反应。
    expect(isSnapshotEmpty({ marks: [], blockType: "paragraph" })).toBe(true);
  });

  it("非 paragraph 块型 → 非空", () => {
    for (const bt of ["heading1", "heading2", "heading6", "bullet_list", "ordered_list", "blockquote"]) {
      expect(isSnapshotEmpty({ marks: [], blockType: bt })).toBe(false);
    }
  });

  it("真实采集路径：普通文字 → 空（回归 D1 的实际输入）", () => {
    const snap = collectSourceSnapshot("普通文字段落甲", 0, 7);
    expect(snap.marks).toEqual([]);
    expect(snap.blockType).toBe("paragraph");
    expect(isSnapshotEmpty(snap)).toBe(true);
  });

  it("真实采集路径：**粗体源** → 非空（不误伤）", () => {
    const text = "源一：**粗体源** 供采集。";
    const start = text.indexOf("**");
    const end = text.indexOf("供采集") - 1; // 到最后一个 * 之后
    const snap = collectSourceSnapshot(text, start, end);
    expect(snap.marks).toContain("strong");
    expect(isSnapshotEmpty(snap)).toBe(false);
  });

  it("真实采集路径：## 标题 → 非空", () => {
    const snap = collectSourceSnapshot("## 标题二级源", 0, 8);
    expect(snap.blockType).toBe("heading2");
    expect(isSnapshotEmpty(snap)).toBe(false);
  });
});

describe("D2：wrapRangeWithMarks 覆盖式语义（先清后套）", () => {
  /**
   * ## 缺陷回顾（M6 实测）
   * 采集 `**粗体源**`（strong）→ 刷到 `*已斜体目标*。`
   * 实际 `***已斜体目标*。**`（畸形），期望 `**已斜体目标。**`
   *
   * 根因：剥离循环只认「整段首尾被同一符号包裹」，
   * 目标行尾是"。"不是 `*` → 剥离失败 → 外层再包一层。
   */
  it("★ D2 主用例：句尾带标点的斜体应被清除（覆盖式）", () => {
    const text = "*已斜体目标*。";
    const r = wrapRangeWithMarks(text, 0, text.length, ["strong"]);
    expect(r).not.toBeNull();
    expect(r!.text).toBe("**已斜体目标。**");
  });

  it("★ 句尾带逗号的粗体应被清除", () => {
    const text = "**已加粗目标**，";
    const r = wrapRangeWithMarks(text, 0, text.length, ["em"]);
    expect(r).not.toBeNull();
    expect(r!.text).toBe("*已加粗目标，*");
  });

  it("★ 删除线应被清除（不应叠加）", () => {
    const text = "~~已有删除线~~。";
    const r = wrapRangeWithMarks(text, 0, text.length, ["strong"]);
    expect(r).not.toBeNull();
    expect(r!.text).toBe("**已有删除线。**");
  });

  it("★ 句中多个格式片段：全部已知符号都被剥离", () => {
    const text = "*甲* 和 **乙** 混排。";
    const r = wrapRangeWithMarks(text, 0, text.length, ["strong"]);
    expect(r).not.toBeNull();
    // 两个片段的符号都应被剥离，再整体包一层 strong
    expect(r!.text).toBe("**甲 和 乙 混排。**");
  });

  it("纯文本目标：直接包裹", () => {
    const r = wrapRangeWithMarks("普通目标甲。", 0, 6, ["strong"]);
    expect(r!.text).toBe("**普通目标甲。**");
  });

  it("嵌套形态 ***粗斜体***：剥离干净后重包，结果与原文等价 → 返回 null（无变化）", () => {
    /**
     * ⚠️ 这里曾写错断言（要求非 null），实际 **null 才是正确行为**：
     * 剥离得 `粗斜体`，再按 `[strong, em]` 逆序包裹 →
     * `em` 先包得 `*粗斜体*`，`strong` 后包得 `***粗斜体***` ——
     * **与原文完全相同** → `wrapRangeWithMarks` 的契约是"无变化返回 null"。
     *
     * 这条测试的价值在于：它证明**嵌套符号被完整剥离了**（否则重包会叠加出
     * `*****粗斜体*****` 之类的畸形）。null 正是"剥离+重包恰好幂等"的证据。
     */
    const r = wrapRangeWithMarks("***粗斜体***", 0, 9, ["strong", "em"]);
    expect(r, "剥离后重包恰好等于原文 → 应返回 null（无变化）").toBeNull();

    // 反向验证：只刷单一格式时，必须产生变化（证明另一层符号确实被剥掉了）
    const r2 = wrapRangeWithMarks("***粗斜体***", 0, 9, ["strong"]);
    expect(r2).not.toBeNull();
    expect(r2!.text, "斜体符号应被剥掉，只留粗体").toBe("**粗斜体**");
  });

  it("★ 保守：字面星号（2*3=6）不应被当成格式符号删掉", () => {
    const r = wrapRangeWithMarks("2*3=6", 0, 5, ["strong"]);
    // 落单的 * 不构成成对符号 → 保留
    expect(r!.text).toBe("**2*3=6**");
  });

  it("★ 保守：不成对的落单符号保留", () => {
    const r = wrapRangeWithMarks("a * b * c", 0, 9, ["strong"]);
    expect(r!.text).toBe("**a * b * c**");
  });

  it("空区间返回 null", () => {
    expect(wrapRangeWithMarks("abc", 1, 1, ["strong"])).toBeNull();
  });

  it("无变化（已是唯一目标格式）→ 返回 null 或等价结果", () => {
    // 已经在 **[0,5) 包裹的文本，再套 strong：结果文本应等于原文（函数可能返回 null）
    const r = wrapRangeWithMarks("**abc**", 0, 7, ["strong"]);
    if (r) expect(r.text).toBe("**abc**");
    else expect(r).toBeNull();
  });

  it("源码外层符号表完整性（防止漏了某个 mark 类型）", () => {
    // PAINTER_MARKS 里每个 mark 都必须有对应源码符号，否则源码面永远刷不上
    for (const m of ["strong", "em", "strike", "code", "underline", "mark"]) {
      expect(SOURCE_MARK_WRAPPERS[m], `缺少 ${m} 的源码包裹符号`).toBeTruthy();
    }
  });
});

describe("D2：applyBlockTypeToLine 前缀替换（块级格式刷）", () => {
  it("普通段落 → H2", async () => {
    const { applyBlockTypeToLine } = await import("../utils/formatPainter");
    const r = applyBlockTypeToLine("普通目标。", 0, 5, "heading2");
    expect(r!.text).toBe("## 普通目标。");
  });

  it("H2 → 普通段落（去掉前缀）", async () => {
    const { applyBlockTypeToLine } = await import("../utils/formatPainter");
    const r = applyBlockTypeToLine("## 已是标题", 0, 8, "paragraph");
    expect(r!.text).toBe("已是标题");
  });

  it("H1 → H3（替换而非叠加）", async () => {
    const { applyBlockTypeToLine } = await import("../utils/formatPainter");
    const r = applyBlockTypeToLine("# 标题", 0, 4, "heading3");
    expect(r!.text).toBe("### 标题");
  });

  it("列表 → 引用", async () => {
    const { applyBlockTypeToLine } = await import("../utils/formatPainter");
    const r = applyBlockTypeToLine("- 列表项", 0, 5, "blockquote");
    expect(r!.text).toBe("> 列表项");
  });

  it("无变化返回 null", async () => {
    const { applyBlockTypeToLine } = await import("../utils/formatPainter");
    expect(applyBlockTypeToLine("普通段落", 0, 4, "paragraph")).toBeNull();
  });
});

describe("D1/D2：状态机（既有契约，防回归）", () => {
  it("once 应用后回 idle；persistent 应用后保持", async () => {
    const { nextFormatPainterMode } = await import("../utils/formatPainter");
    expect(nextFormatPainterMode("arm-once", "idle")).toBe("once");
    expect(nextFormatPainterMode("apply", "once")).toBe("idle");
    expect(nextFormatPainterMode("apply", "persistent")).toBe("persistent");
    expect(nextFormatPainterMode("exit", "persistent")).toBe("idle");
  });
});
