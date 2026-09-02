/**
 * v0.6.1 全文翻译核心逻辑测试
 *
 * 覆盖：
 * 1. splitDocumentForTranslation：段落切分、代码围栏/公式块/frontmatter 跳过、
 *    列表整体单元、偏移正确性、空文档、超长块句子切分（splitLongText）
 * 2. rebuildTranslatedDocument：译文替换、间隙/尾部原文保留、null 译文回退
 * 3. runFullTranslateLoop：成功、段级失败容错、CANCELLED 中止、AUTH 系统性中止、
 *    shouldAbort 中止、占位符失配/截断视为失败、进度回调
 * 4. fullTranslateStore：状态流转
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  splitDocumentForTranslation,
  splitLongText,
  rebuildTranslatedDocument,
  runFullTranslateLoop,
  MAX_BLOCK_CHARS,
  MERGE_TARGET_CHARS,
} from "../services/fullTranslate";
import { useFullTranslateStore } from "../stores/fullTranslateStore";

// ─── splitDocumentForTranslation ─────────────────────────

describe("v0.6.1 splitDocumentForTranslation", () => {
  it("普通多段落文档：相邻块合并为一个请求单元（v0.6.1 优化）", () => {
    const md = "# 标题\n\n第一段内容。\n\n第二段内容。";
    const units = splitDocumentForTranslation(md);
    expect(units.map((u) => u.text)).toEqual(["# 标题\n\n第一段内容。\n\n第二段内容。"]);
  });

  it("代码围栏块整体跳过（含 mermaid）", () => {
    const md = "前文。\n\n```mermaid\ngraph TD;\n  A-->B;\n```\n\n后文。";
    const units = splitDocumentForTranslation(md);
    expect(units.map((u) => u.text)).toEqual(["前文。", "后文。"]);
  });

  it("波浪线围栏（~~~）跳过", () => {
    const md = "前文。\n\n~~~\ncode here\n~~~\n\n后文。";
    const units = splitDocumentForTranslation(md);
    expect(units.map((u) => u.text)).toEqual(["前文。", "后文。"]);
  });

  it("frontmatter 整体跳过", () => {
    const md = "---\ntitle: Test\n---\n\n正文内容。";
    const units = splitDocumentForTranslation(md);
    expect(units.map((u) => u.text)).toEqual(["正文内容。"]);
  });

  it("公式块（$$）整体跳过", () => {
    const md = "前文。\n\n$$\nE = mc^2\n$$\n\n后文。";
    const units = splitDocumentForTranslation(md);
    expect(units.map((u) => u.text)).toEqual(["前文。", "后文。"]);
  });

  it("连续非空行（列表）与相邻段落合并为一个单元", () => {
    const md = "引言段落。\n\n- 第一项\n- 第二项\n- 第三项";
    const units = splitDocumentForTranslation(md);
    expect(units.map((u) => u.text)).toEqual(["引言段落。\n\n- 第一项\n- 第二项\n- 第三项"]);
  });

  it("纯符号块（--- / - / ***）不产生翻译单元（v0.6.1 优化）", () => {
    const md = "第一段。\n\n---\n\n- \n\n***\n\n第二段。";
    const units = splitDocumentForTranslation(md);
    // 纯符号块被过滤，两段因间隙无文字合并为一个单元
    expect(units.map((u) => u.text)).toEqual(["第一段。\n\n---\n\n- \n\n***\n\n第二段。"]);
  });

  it("相邻块合并超过 MERGE_TARGET_CHARS 时不合并", () => {
    // 两个 1200 字符的块，间隙空行，合并后 > 2000 → 保持独立单元
    const a = "甲".repeat(1200);
    const b = "乙".repeat(1200);
    const md = `${a}\n\n${b}`;
    const units = splitDocumentForTranslation(md);
    expect(units.length).toBe(2);
    expect(units[0].text).toBe(a);
    expect(units[1].text).toBe(b);
  });

  it("间隙含文字的代码块阻止合并", () => {
    const md = "前文。\n\n```js\nconst a = 1;\n```\n\n后文。";
    const units = splitDocumentForTranslation(md);
    expect(units.map((u) => u.text)).toEqual(["前文。", "后文。"]);
  });

  it("偏移正确：unit.text 与原文 slice 一致（含合并单元）", () => {
    const md = "# 标题\n\n```js\nconst a = 1;\n```\n\n中间段。\n\n结尾。";
    const units = splitDocumentForTranslation(md);
    expect(units.length).toBeGreaterThanOrEqual(2);
    for (const u of units) {
      expect(md.slice(u.start, u.end)).toBe(u.text);
    }
    // 单元偏移递增且不重叠
    for (let i = 1; i < units.length; i++) {
      expect(units[i].start).toBeGreaterThan(units[i - 1].end - 1);
    }
  });

  it("空文档/纯空白返回空数组", () => {
    expect(splitDocumentForTranslation("")).toEqual([]);
    expect(splitDocumentForTranslation("\n\n\n")).toEqual([]);
  });

  it("纯符号文档返回空数组（无可译内容）", () => {
    expect(splitDocumentForTranslation("---\n\n- \n\n***")).toEqual([]);
  });

  it("纯代码块文档返回空数组（无可译内容）", () => {
    const md = "```js\nconst a = 1;\nconst b = 2;\n```";
    expect(splitDocumentForTranslation(md)).toEqual([]);
  });

  it("超长块按句子边界切分为多个单元（每段 ≤ 4000 字符）", () => {
    // 构造 >4000 字符的段落：句子 + 大量句号分隔
    const sentence = "这是一句用于测试切分逻辑的话。";
    const repeat = Math.ceil((MAX_BLOCK_CHARS + 100) / sentence.length);
    const longBlock = sentence.repeat(repeat);
    const md = `前文。\n\n${longBlock}`;
    const units = splitDocumentForTranslation(md);
    expect(units.length).toBeGreaterThan(1); // 前文 + 多个切片
    for (const u of units) {
      expect(u.text.length).toBeLessThanOrEqual(MAX_BLOCK_CHARS);
    }
    // 重组切分后的单元应还原原块（切分点在句子边界，无字符丢失）
    const blockUnits = units.filter((u) => u.text.startsWith("这是"));
    const joined = blockUnits.map((u) => u.text).join("");
    // splitLongText 会跳过切点后的空白，句号后无空白则完整还原
    expect(joined).toBe(longBlock);
  });

  it("用户文档样例：6 段降为 3 段（纯符号过滤 + 相邻合并）", () => {
    const md = [
      "# Saved from LightMD",
      "",
      "```mermaid",
      "graph TD",
      "    A[开始] --> B[结束]",
      "```",
      "",
      "Test content",
      "",
      "## 标题二ds",
      "",
      "---",
      "",
      "- ",
      "",
      "```python",
      "",
      "```",
      "",
      "## name: find-skills description: helps users",
    ].join("\n");
    const units = splitDocumentForTranslation(md);
    // mermaid（含中文节点）与 python（语言标注含字母）围栏有文字 → 阻止跨块合并；
    // --- 与 "- " 纯符号块被过滤不再单独成段；Test content 与 ## 标题二ds 合并
    expect(units.length).toBe(3);
    expect(units[0].text).toBe("# Saved from LightMD");
    expect(units[1].text).toBe("Test content\n\n## 标题二ds");
    expect(units[2].text).toBe("## name: find-skills description: helps users");
  });
});

// ─── splitLongText ───────────────────────────────────────

describe("v0.6.1 splitLongText", () => {
  it("无句子边界时按 max 硬切", () => {
    const text = "a".repeat(100);
    const parts = splitLongText(text, 40);
    expect(parts.length).toBe(3);
    expect(parts.map((p) => p.text).join("")).toBe(text);
    expect(parts.every((p) => p.text.length <= 40)).toBe(true);
  });

  it("句子边界优先：片段不超 max 且拼接还原原文", () => {
    const text = "第一句。第二句。第三句。第四句。第五句。第六句。";
    const parts = splitLongText(text, 12);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((p) => p.text).join("")).toBe(text);
    expect(parts.every((p) => p.text.length <= 12)).toBe(true);
    // 每个片段以句号结尾（除硬切兜底场景外）
    expect(parts[0].text.endsWith("。")).toBe(true);
  });

  it("短文本不切分", () => {
    const parts = splitLongText("短文本", 40);
    expect(parts.length).toBe(1);
    expect(parts[0].text).toBe("短文本");
  });
});

// ─── rebuildTranslatedDocument ────────────────────────────

describe("v0.6.1 rebuildTranslatedDocument", () => {
  const md = "# Title\n\nHello world.\n\n```js\ncode\n```\n\nTail.";

  it("译文替换原文，代码块与间隙原样保留", () => {
    const units = splitDocumentForTranslation(md);
    // units: ["# Title\n\nHello world.", "Tail."]（前两块合并，代码块阻隔）
    expect(units.length).toBe(2);
    const translations = ["# 标题\n\n你好，世界。", "尾部。"];
    const result = rebuildTranslatedDocument(md, units, translations);
    expect(result).toBe("# 标题\n\n你好，世界。\n\n```js\ncode\n```\n\n尾部。");
  });

  it("null 译文保留原文", () => {
    const units = splitDocumentForTranslation(md);
    // 单元2（Tail.）译文为 null → 保留原文
    const translations = ["# 标题\n\n你好，世界。", null];
    const result = rebuildTranslatedDocument(md, units, translations);
    expect(result).toContain("Tail.");
    expect(result).toContain("# 标题");
    expect(result).toContain("你好，世界。");
  });

  it("空译文保留原文", () => {
    const units = splitDocumentForTranslation(md);
    const translations = ["", "尾部。"];
    const result = rebuildTranslatedDocument(md, units, translations);
    expect(result).toContain("# Title");
  });

  it("尾部原文（最后单元之后）完整保留", () => {
    const md2 = "第一段。\n\n```js\ncode\n```";
    const units = splitDocumentForTranslation(md2);
    const result = rebuildTranslatedDocument(md2, units, ["First."]);
    expect(result).toBe("First.\n\n```js\ncode\n```");
  });
});

// ─── runFullTranslateLoop ────────────────────────────────

/** 构造成功翻译结果 */
const ok = (text: string) => ({
  translated: text,
  placeholdersIntact: true,
  finishReason: "stop",
});

describe("v0.6.1 runFullTranslateLoop", () => {
  const units = [
    { start: 0, end: 4, text: "第一段" },
    { start: 6, end: 10, text: "第二段" },
    { start: 12, end: 16, text: "第三段" },
  ];
  const baseOpts = {
    onProgress: () => {},
    shouldAbort: () => false,
    errorCodeOf: (e: unknown) => String((e as Error)?.message ?? e),
  };

  it("全部成功：译文一一对应", async () => {
    const outcome = await runFullTranslateLoop(units, {
      ...baseOpts,
      translateUnit: async (text) => ok(`译:${text}`),
    });
    expect(outcome.translations).toEqual(["译:第一段", "译:第二段", "译:第三段"]);
    expect(outcome.failedCount).toBe(0);
    expect(outcome.cancelled).toBe(false);
    expect(outcome.errorCode).toBeNull();
  });

  it("段级失败容错：失败段为 null，继续后续段", async () => {
    const outcome = await runFullTranslateLoop(units, {
      ...baseOpts,
      translateUnit: async (text) => {
        if (text === "第二段") throw new Error("NETWORK|x");
        return ok(`译:${text}`);
      },
    });
    expect(outcome.translations).toEqual(["译:第一段", null, "译:第三段"]);
    expect(outcome.failedCount).toBe(1);
    expect(outcome.cancelled).toBe(false);
  });

  it("CANCELLED 中止：标记 cancelled，后续段不再翻译", async () => {
    const calls: string[] = [];
    const outcome = await runFullTranslateLoop(units, {
      ...baseOpts,
      translateUnit: async (text) => {
        calls.push(text);
        if (text === "第一段") throw new Error("CANCELLED");
        return ok(`译:${text}`);
      },
    });
    expect(outcome.cancelled).toBe(true);
    expect(calls).toEqual(["第一段"]); // 第一段被取消后中止
  });

  it("AUTH 系统性错误立即中止并返回错误码", async () => {
    const calls: string[] = [];
    const outcome = await runFullTranslateLoop(units, {
      ...baseOpts,
      translateUnit: async (text) => {
        calls.push(text);
        if (text === "第一段") throw new Error("AUTH");
        return ok(`译:${text}`);
      },
      errorCodeOf: (e) => String((e as Error).message),
    });
    expect(outcome.errorCode).toBe("AUTH");
    expect(outcome.cancelled).toBe(false);
    expect(calls.length).toBe(1); // 不继续后续段
  });

  // v0.6.3 说明：本用例只验证 runFullTranslateLoop 对注入 shouldAbort 的契约（返回 true 即中止），
  // 不代表生产代码的标签切换保护。真实的上下文中止检测（P0-1 修复）由
  // createContextAbortChecker 覆盖，见 v0.6.3-p0-fixes.test.ts
  it("shouldAbort 回调契约：返回 true 时循环中止", async () => {
    let call = 0;
    const outcome = await runFullTranslateLoop(units, {
      ...baseOpts,
      translateUnit: async (text) => {
        call++;
        return ok(`译:${text}`);
      },
      shouldAbort: () => call >= 1, // 第一段完成后中止
    });
    expect(outcome.cancelled).toBe(true);
    expect(outcome.translations[1]).toBeNull(); // 第二、三段未翻译
  });

  it("占位符失配（placeholdersIntact=false）视为失败", async () => {
    const outcome = await runFullTranslateLoop([units[0]], {
      ...baseOpts,
      translateUnit: async () => ({
        translated: "译文",
        placeholdersIntact: false,
        finishReason: "stop",
      }),
    });
    expect(outcome.translations[0]).toBeNull();
    expect(outcome.failedCount).toBe(1);
  });

  it("finishReason=length（截断）视为失败", async () => {
    const outcome = await runFullTranslateLoop([units[0]], {
      ...baseOpts,
      translateUnit: async () => ({
        translated: "译文",
        placeholdersIntact: true,
        finishReason: "length",
      }),
    });
    expect(outcome.translations[0]).toBeNull();
    expect(outcome.failedCount).toBe(1);
  });

  it("空译文视为失败", async () => {
    const outcome = await runFullTranslateLoop([units[0]], {
      ...baseOpts,
      translateUnit: async () => ok("  \n  "),
    });
    expect(outcome.translations[0]).toBeNull();
    expect(outcome.failedCount).toBe(1);
  });

  it("onProgress 每段回调一次（含失败段）", async () => {
    const progress: number[] = [];
    const outcome = await runFullTranslateLoop(units, {
      ...baseOpts,
      onProgress: (d) => progress.push(d),
      translateUnit: async (text) => {
        if (text === "第三段") throw new Error("RATE|429");
        return ok(`译:${text}`);
      },
    });
    expect(progress).toEqual([1, 2, 3]);
    expect(outcome.failedCount).toBe(1);
  });
});

// ─── fullTranslateStore ──────────────────────────────────

describe("v0.6.1 fullTranslateStore", () => {
  beforeEach(() => {
    useFullTranslateStore.getState().reset();
  });

  it("start/tick/finish 全成功流转", () => {
    const s = useFullTranslateStore.getState();
    s.start(3);
    expect(useFullTranslateStore.getState().status).toBe("running");
    expect(useFullTranslateStore.getState().totalCount).toBe(3);
    useFullTranslateStore.getState().tick();
    useFullTranslateStore.getState().tick();
    expect(useFullTranslateStore.getState().doneCount).toBe(2);
    useFullTranslateStore.getState().finish(0);
    // v0.6.4：全成功 → done 态（底部栏"翻译完成 ✓"，2 秒后由 StatusBar 自动 reset）
    expect(useFullTranslateStore.getState().status).toBe("done");
    expect(useFullTranslateStore.getState().failedCount).toBe(0);
  });

  it("finish 部分失败：v0.6.4 起 done 态（不再置 error，失败由编辑器气泡提示）", () => {
    const s = useFullTranslateStore.getState();
    s.start(5);
    useFullTranslateStore.getState().finish(2);
    const after = useFullTranslateStore.getState();
    expect(after.status).toBe("done");
    expect(after.failedCount).toBe(2);
  });

  it("fail 记录错误码，reset 清空", () => {
    const s = useFullTranslateStore.getState();
    s.start(2);
    useFullTranslateStore.getState().fail("AUTH");
    expect(useFullTranslateStore.getState().status).toBe("error");
    expect(useFullTranslateStore.getState().errorCode).toBe("AUTH");
    useFullTranslateStore.getState().reset();
    expect(useFullTranslateStore.getState().status).toBe("idle");
  });

  it("requestCancel 置位取消标志（start 时清除）", () => {
    const s = useFullTranslateStore.getState();
    s.start(2);
    useFullTranslateStore.getState().requestCancel();
    expect(useFullTranslateStore.getState().cancelRequested).toBe(true);
    s.start(2); // 新任务重置取消标志
    expect(useFullTranslateStore.getState().cancelRequested).toBe(false);
  });
});
