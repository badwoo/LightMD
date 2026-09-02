/**
 * v0.6.3 P1 修复测试
 *
 * 覆盖审核报告（docs/CODE_REVIEW_v0.6.2.md）P1 缺陷：
 * - P1-1：frontmatter 误判（首行 --- 分割线开篇时正文被整体跳过）
 * - P1-3：超长块切分缺英文句点/换行边界，硬切在单词/表格行中间
 * - P1-4：RATE 限流指数退避重试 + 连续限流中止整轮
 * - P1-5：全部段落失败时 lastErrorCode 透传（不再固定 STREAM）
 * - P2-12：content_filter 等系统性 finish_reason 中止整轮
 */
import { describe, it, expect, vi } from "vitest";
import {
  splitDocumentForTranslation,
  splitLongText,
  runFullTranslateLoop,
  type TranslateUnit,
  type UnitTranslateResult,
} from "../services/fullTranslate";

const ok = (t: string): UnitTranslateResult => ({
  translated: `译:${t}`,
  placeholdersIntact: true,
  finishReason: "stop",
});

const baseOpts = {
  onProgress: () => {},
  shouldAbort: () => false,
  // 模拟生产接线 parseTranslateError 的错误码提取（"RATE|xxx" → "RATE"）
  errorCodeOf: (e: unknown) => String((e as Error).message).split("|")[0],
  sleep: () => Promise.resolve(), // 注入即时 sleep，测试不真实等待
};

// ─── P1-1：frontmatter 误判 ───────────────────────────────

describe("v0.6.3 P1-1 frontmatter 检测", () => {
  it("审核报告实证用例：分割线开篇的正文不再被整体跳过", () => {
    // 原实现输出 ["结尾"]——两段正文全部丢失
    const md = "---\n第一段正文应该被翻译\n第二段正文应该被翻译\n---\n结尾";
    const units = splitDocumentForTranslation(md);
    const all = units.map((u) => u.text).join("\n");
    expect(all).toContain("第一段正文应该被翻译");
    expect(all).toContain("第二段正文应该被翻译");
    expect(all).toContain("结尾");
  });

  it("真实 frontmatter（key: value 形态）整体跳过不翻译", () => {
    const md = "---\ntitle: 测试文档\nauthor: someone\ndate: 2026-01-01\n---\n\n正文段落";
    const units = splitDocumentForTranslation(md);
    expect(units.length).toBe(1);
    expect(units[0].text).toBe("正文段落");
  });

  it("frontmatter 含列表项与注释（宽松 YAML 形态）正常识别", () => {
    const md = "---\ntitle: 测试\ntags:\n  - a\n  - b\n# 注释\n---\n\n正文";
    const units = splitDocumentForTranslation(md);
    expect(units.length).toBe(1);
    expect(units[0].text).toBe("正文");
  });

  it("首行 --- 无闭合：按普通分割线处理，后续正文正常翻译", () => {
    const md = "---\ntitle: x\n正文内容";
    const units = splitDocumentForTranslation(md);
    const all = units.map((u) => u.text).join("\n");
    expect(all).toContain("正文内容");
  });

  it("普通正文里单独出现的 --- 分割线前后段落都翻译", () => {
    const md = "上段。\n\n---\n\n下段。";
    const units = splitDocumentForTranslation(md);
    const all = units.map((u) => u.text).join("\n");
    expect(all).toContain("上段。");
    expect(all).toContain("下段。");
  });
});

// ─── P1-3：超长块切分边界 ─────────────────────────────────

describe("v0.6.3 P1-3 splitLongText 切分边界", () => {
  it("英文长段：切点在句末（. 后跟空白），不劈开单词", () => {
    const sentence = "The quick brown fox jumps over the lazy dog. ";
    const text = sentence.repeat(200); // ~9600 字符
    const parts = splitLongText(text, 4000);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts.slice(0, -1)) {
      // 非末段必须以句点结尾（句子边界），而不是切在单词中间
      expect(p.text.endsWith(".")).toBe(true);
      expect(p.text).not.toMatch(/dog\. [a-z]*$/); // 切点后无残缺词（此正则匹配空残缺）
    }
    // 具体回归：原实现把 "lazy dog" 劈成 "lazy " / "dog."
    for (const p of parts) {
      expect(p.text).not.toMatch(/(?:^|\s)lazy$/); // 段尾不能是半个词
    }
  });

  it("超长表格：切点在行边界（\\n），行不被劈开", () => {
    const row = "| 列一 | 列二 | 列三 |\n";
    const text = `| 表头1 | 表头2 | 表头3 |\n|---|---|---|\n${row.repeat(300)}`;
    const parts = splitLongText(text, 4000);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts.slice(0, -1)) {
      expect(p.text.endsWith("\n")).toBe(true); // 非末段以整行结束
    }
  });

  it("无任何边界（连续无空格长串）：按 max 硬切", () => {
    const text = "a".repeat(9000);
    const parts = splitLongText(text, 4000);
    expect(parts.map((p) => p.text.length)).toEqual([4000, 4000, 1000]);
  });

  it("小数点不误判为句边界：3.14 / example.com 不被劈开", () => {
    const chunk = "value 3.14159 plus value 2.71828 makes end. ";
    const text = chunk.repeat(150);
    const parts = splitLongText(text, 4000);
    for (const p of parts) {
      // 段尾不能是数字（数字结尾 = 劈在了小数/数字中间）
      expect(p.text).not.toMatch(/\d$/);
    }
  });

  it("中文句末标点仍为边界", () => {
    const text = "这是第一句话。".repeat(1000);
    const parts = splitLongText(text, 4000);
    for (const p of parts.slice(0, -1)) {
      expect(p.text.endsWith("。")).toBe(true);
    }
  });

  it("片段拼接（含跳过的空白）与原文内容一致：重建无损", () => {
    const text = "第一句。第二句！\n换行内容 word word. " + "x".repeat(3900) + " tail";
    const parts = splitLongText(text, 4000);
    // 各片段互不重叠且均不超过 max
    for (let i = 1; i < parts.length; i++) {
      expect(parts[i].start).toBeGreaterThanOrEqual(parts[i - 1].end);
    }
    for (const p of parts) {
      expect(p.end - p.start).toBeLessThanOrEqual(4000);
      expect(p.text).toBe(text.slice(p.start, p.end));
    }
  });
});

// ─── P1-4 / P1-5 / P2-12：执行循环 ───────────────────────

describe("v0.6.3 P1-4 RATE 限流退避重试", () => {
  const units: TranslateUnit[] = [
    { start: 0, end: 3, text: "第一段" },
    { start: 4, end: 7, text: "第二段" },
    { start: 8, end: 11, text: "第三段" },
  ];

  it("单段 RATE 首次失败后重试成功：译文正常，退避 1s", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    let calls = 0;
    const outcome = await runFullTranslateLoop(units, {
      ...baseOpts,
      sleep,
      translateUnit: async (text) => {
        if (text === "第一段" && calls++ === 0) throw new Error("RATE|限流");
        return ok(text);
      },
    });
    expect(outcome.translations[0]).toBe("译:第一段");
    expect(outcome.failedCount).toBe(0);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("单段 RATE 重试 3 次耗尽：该段失败，退避 1s/2s，继续后续段", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const outcome = await runFullTranslateLoop(units, {
      ...baseOpts,
      sleep,
      translateUnit: async (text) => {
        if (text === "第一段") throw new Error("RATE|限流");
        return ok(text);
      },
    });
    expect(outcome.translations[0]).toBeNull(); // 重试耗尽，段失败保留原文
    expect(outcome.translations[1]).toBe("译:第二段"); // 不影响后续段
    expect(outcome.failedCount).toBe(1);
    expect(sleep).toHaveBeenCalledTimes(2); // 1s + 2s
    expect(outcome.errorCode).toBeNull(); // 连续 1 段不中止整轮
  });

  it("连续 3 段 RATE 重试耗尽：中止整轮并上报 RATE", async () => {
    const calls: string[] = [];
    const outcome = await runFullTranslateLoop(units, {
      ...baseOpts,
      translateUnit: async (text) => {
        calls.push(text);
        throw new Error("RATE|限流");
      },
    });
    expect(outcome.errorCode).toBe("RATE");
    expect(outcome.cancelled).toBe(false);
    // 每段重试 3 次耗尽（3 段 × 3 次 = 9），第三段耗尽即中止整轮
    expect(calls.length).toBe(9);
    expect(calls[8]).toBe("第三段");
    expect(outcome.failedCount).toBe(3);
  });

  it("非 RATE 错误不重试（NETWORK 立即失败）", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    let calls = 0;
    const outcome = await runFullTranslateLoop([units[0]], {
      ...baseOpts,
      sleep,
      translateUnit: async () => {
        calls++;
        throw new Error("NETWORK|x");
      },
    });
    expect(calls).toBe(1); // 无重试
    expect(sleep).not.toHaveBeenCalled();
    expect(outcome.failedCount).toBe(1);
  });

  it("退避期间用户取消：不再重试，标记 cancelled", async () => {
    let cancel = false;
    const outcome = await runFullTranslateLoop([units[0]], {
      ...baseOpts,
      shouldAbort: () => cancel,
      sleep: () => {
        cancel = true; // 第一次退避等待期间用户取消
        return Promise.resolve();
      },
      translateUnit: async () => {
        throw new Error("RATE|限流");
      },
    });
    expect(outcome.cancelled).toBe(true);
    expect(outcome.translations[0]).toBeNull();
  });

  it("RATE 失败后被成功段打断：连续计数清零", async () => {
    // 段1 RATE 耗尽（连续1），段2 成功（清零），段3 RATE 耗尽（连续1）→ 不中止
    const fiveUnits: TranslateUnit[] = [1, 2, 3, 4, 5].map((n) => ({
      start: 0, end: 1, text: `段${n}`,
    }));
    const outcome = await runFullTranslateLoop(fiveUnits, {
      ...baseOpts,
      translateUnit: async (text) => {
        if (text === "段1" || text === "段3") throw new Error("RATE|限流");
        return ok(text);
      },
    });
    expect(outcome.errorCode).toBeNull();
    expect(outcome.failedCount).toBe(2);
    expect(outcome.translations[4]).toBe("译:段5");
  });
});

describe("v0.6.3 P1-5 lastErrorCode 透传", () => {
  it("全部段落失败：lastErrorCode 为最后段级错误码（供状态栏上报）", async () => {
    const units: TranslateUnit[] = [
      { start: 0, end: 3, text: "a" },
      { start: 4, end: 7, text: "b" },
    ];
    const outcome = await runFullTranslateLoop(units, {
      ...baseOpts,
      translateUnit: async (text) => {
        throw new Error(text === "a" ? "NETWORK|x" : "RATE|限流");
      },
    });
    expect(outcome.failedCount).toBe(2);
    expect(outcome.errorCode).toBeNull(); // 未触发整轮中止（RATE 仅连续 1 段）
    expect(outcome.lastErrorCode).toBe("RATE"); // 最后一次段级失败
  });

  it("无失败：lastErrorCode 为 null", async () => {
    const units: TranslateUnit[] = [{ start: 0, end: 1, text: "a" }];
    const outcome = await runFullTranslateLoop(units, {
      ...baseOpts,
      translateUnit: async (t) => ok(t),
    });
    expect(outcome.lastErrorCode).toBeNull();
    expect(outcome.failedCount).toBe(0);
  });
});

describe("v0.6.3 P2-12 系统性 finish_reason 中止整轮", () => {
  it("content_filter：中止整轮并上报 PROVIDER", async () => {
    const calls: string[] = [];
    const units: TranslateUnit[] = [
      { start: 0, end: 1, text: "a" },
      { start: 2, end: 3, text: "b" },
    ];
    const outcome = await runFullTranslateLoop(units, {
      ...baseOpts,
      translateUnit: async (text) => {
        calls.push(text);
        return { translated: "", placeholdersIntact: true, finishReason: "content_filter" };
      },
    });
    expect(outcome.errorCode).toBe("PROVIDER");
    expect(calls).toEqual(["a"]); // 不继续第二段
  });

  it("length（截断）仍为段级失败，不中止整轮", async () => {
    const units: TranslateUnit[] = [
      { start: 0, end: 1, text: "a" },
      { start: 2, end: 3, text: "b" },
    ];
    const outcome = await runFullTranslateLoop(units, {
      ...baseOpts,
      translateUnit: async (t) => ({ translated: `译:${t}`, placeholdersIntact: true, finishReason: t === "a" ? "length" : "stop" }),
    });
    expect(outcome.errorCode).toBeNull();
    expect(outcome.failedCount).toBe(1);
    expect(outcome.translations[1]).toBe("译:b");
  });
});
