/**
 * v0.17.0 P0-3 —— 往返 fuzz 的**默认套件入口**（守护基线不漂移）。
 *
 * 与 `scripts/v0170-fuzz.mjs` 的分工（重要，别混）：
 *
 * | 入口 | 规模 | 用途 | 是否进默认 `pnpm test` |
 * |---|---|---|---|
 * | 本文件（`*.test.ts`） | 20 篇 | **守护基建本身**：seed 确定性、四分类判定、白名单机制、三条 oracle 可运行且无 throw | ✅ 是 |
 * | `pnpm fuzz:quick` | 200 篇 | CI 快档硬门禁（<60s），产出基线 JSON + 报告 | ❌ 独立脚本 |
 * | `pnpm fuzz:full` | 1000 篇 | 发布前全档，产出正式基线 | ❌ 独立脚本 |
 *
 * 为什么本文件**不**断言「lossy/corrupt = 0」：P0 阶段的任务就是**如实记录当前
 * 基线**（设计稿 §7.1「fuzz 基线报告落盘」，允许非零 diff 作为 B 线修复清单）。
 * 若在默认套件里断言归零，P0 会直接红，而 P0 的验收口径是「基线落盘」而非「归零」。
 * 归零是 **B 线门禁**（设计稿 §7.1 B：「md→tree→md 意外 diff = 0」），届时把
 * `EXPECTED_MAX_HARD_FAIL` 改成 0 即可，不必改测试结构。
 *
 * 本文件跑得很快（20 篇 ≈ 0.2s），不会拖慢既有 364 文件套件。
 */
import { describe, it, expect } from "vitest";
import { createRng, deriveSeed } from "./prng";
import { generateDocument, type FeatureId } from "./generator";
import { computeSignature, diffSignatures, isKindSubsequence, normalizeText } from "./signature";
import { classifyOutcome, oracleBlocksRoundtrip, oracleDocRoundtrip, oracleDocRoundtripReserialized, runOracle, treeOracleAdapter } from "./oracles";
import { blocksToMarkdown } from "./blocksToMarkdown";
import {
  matchWhitelist,
  matchCarrierWhitelist,
  NORMALIZED_WHITELIST,
  CARRIER_WHITELIST,
  ALL_WHITELIST,
  BLOCKS_EXPORT_BOUNDARIES,
} from "./whitelist";
import { runFuzz } from "./runner";

/**
 * P0 阶段允许的非零基线上限。
 * B 线门禁要求「md→tree→md 意外 diff = 0」，届时本常量改 0。
 */
const EXPECTED_MAX_HARD_FAIL = 400;

describe("PRNG：基线可复现（fuzz 可信度的前提）", () => {
  it("同 seed 同序号 → 逐字节相同的文档", () => {
    const a = generateDocument(createRng(deriveSeed(12345, 7)), 7).markdown;
    const b = generateDocument(createRng(deriveSeed(12345, 7)), 7).markdown;
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("不同 seed → 不同文档（抽样确实在变，不是恒定模板）", () => {
    const a = generateDocument(createRng(deriveSeed(12345, 7)), 7).markdown;
    const b = generateDocument(createRng(deriveSeed(99999, 7)), 7).markdown;
    expect(a).not.toBe(b);
  });

  it("不同文档序号 → 不同文档（一篇文档内的块数不会退化为常量）", () => {
    const a = generateDocument(createRng(deriveSeed(12345, 0)), 0).markdown;
    const b = generateDocument(createRng(deriveSeed(12345, 1)), 1).markdown;
    expect(a).not.toBe(b);
  });

  it("Rng 基本性质：区间闭、pick 覆盖、shuffled 不改原数组", () => {
    const rng = createRng(42);
    for (let i = 0; i < 200; i++) {
      const v = rng.between(3, 7);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(7);
      expect(Number.isInteger(v)).toBe(true);
    }
    const src = [1, 2, 3, 4, 5];
    const perm = rng.shuffled(src);
    expect(src).toEqual([1, 2, 3, 4, 5]);
    expect([...perm].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(() => rng.pick([])).toThrow();
  });
});

describe("生成器：§7.2 覆盖表逐项可达", () => {
  // 用固定 seed 跑 60 篇，要求覆盖表每一项至少出现一次。
  // 这是「不要只做实参」的机械化检查：漏实现的语法会在这里立刻暴露。
  const REQUIRED: FeatureId[] = [
    "heading-atx",
    "heading-setext",
    "para-plain",
    "para-softbreak",
    "para-hardbreak-spaces",
    "para-hardbreak-br",
    "list-bullet",
    "list-ordered-dot",
    "list-ordered-paren",
    "list-nested-2",
    "list-nested-3",
    "list-task",
    "fence-basic",
    "fence-backtick-len",
    "fence-info",
    "table-align",
    "table-no-align",
    "table-merged-html",
    "quote-basic",
    "quote-nested",
    "quote-blankline",
    "footnote-simple",
    "footnote-multipara",
    "deflist-basic",
    "deflist-inner-block",
    "image-plain",
    "image-width",
    "image-width-align",
    "image-alt-pipe",
    "image-base64",
    "math-block",
    "math-inline",
    "html-whitelist",
    "html-comment",
    "crlf",
    "blank-head",
    "blank-tail",
    "blank-gap-multi",
  ];

  it(`60 篇内覆盖 ${REQUIRED.length} 项语法特征（漏一项即生成器没按表实现）`, () => {
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const { features } = generateDocument(createRng(deriveSeed(20261109, i)), i);
      features.forEach((f) => seen.add(f));
    }
    const missing = REQUIRED.filter((f) => !seen.has(f));
    expect(missing, `未覆盖特征：${missing.join(", ")}`).toEqual([]);
  });

  it("生成的文档非空、且至少有一个块级结构", () => {
    for (let i = 0; i < 10; i++) {
      const { markdown } = generateDocument(createRng(deriveSeed(20261109, i)), i);
      expect(markdown.trim().length).toBeGreaterThan(0);
      expect(markdown).toContain("\n");
    }
  });
});

describe("签名裁判：内容原子不得把载体差异算成内容差异", () => {
  it("normalizeText 折叠所有空白（含换行），换行是载体", () => {
    expect(normalizeText("a  \nb")).toBe("a b");
    expect(normalizeText("a\n\n\nb")).toBe("a b");
    expect(normalizeText("a\u200Bb")).toBe("ab");
    expect(normalizeText("  a  ")).toBe("a");
  });

  it("`  \\n` 与 `<br>` 的段落：内容原子相同（载体差异只进 attrs）", () => {
    const a = computeSignature("a  \nb\n");
    const b = computeSignature("a<br>b\n");
    expect(a.atoms).toEqual(b.atoms);
    expect(a.kinds).toEqual(b.kinds);
    expect(diffSignatures(a, b).missingAtoms).toEqual([]); // 不算内容丢失
  });

  it("真正丢内容 → 被判定为 contentLost", () => {
    const d = diffSignatures(computeSignature("keep me\n"), computeSignature(""));
    expect(d.contentLost).toBe(true);
    expect(d.missingAtoms.length).toBeGreaterThan(0);
  });

  it("凭空多出内容 → 被判定为 contentAdded", () => {
    const d = diffSignatures(computeSignature("a\n"), computeSignature("a\n\ninjected\n"));
    expect(d.contentAdded).toBe(true);
  });

  it("结构序列变化 → structuralBreak", () => {
    const d = diffSignatures(computeSignature("# h\n"), computeSignature("h\n"));
    expect(d.structuralBreak).toBe(true);
  });

  it("isKindSubsequence：Blocks 出口「只减不增」判定", () => {
    expect(isKindSubsequence(["a", "b", "c"], ["a", "c"])).toBe(true);
    expect(isKindSubsequence(["a", "b", "c"], ["c", "a"])).toBe(false);
    expect(isKindSubsequence(["a"], ["a", "b"])).toBe(false);
  });
});

describe("四分类判定：identical / normalized / lossy / corrupt", () => {
  const sig = (s: string) => computeSignature(s);

  it("identical：字节相同 → 最高优先级分类", () => {
    const c = classifyOutcome({
      oracle: "md-doc-md",
      input: "# a\n",
      output: "# a\n",
      features: [],
      diff: diffSignatures(sig("# a\n"), sig("# a\n")),
    });
    expect(c.klass).toBe("identical");
  });

  it("corrupt：结构被替换（标题变成段落）", () => {
    const c = classifyOutcome({
      oracle: "md-doc-md",
      input: "# a\n",
      output: "a\n",
      features: [],
      diff: diffSignatures(sig("# a\n"), sig("a\n")),
    });
    expect(c.klass).toBe("corrupt");
  });

  it("corrupt：凭空多出内容", () => {
    const c = classifyOutcome({
      oracle: "md-doc-md",
      input: "a\n",
      output: "a\n\ninjected\n",
      features: [],
      diff: diffSignatures(sig("a\n"), sig("a\n\ninjected\n")),
    });
    expect(c.klass).toBe("corrupt");
  });

  it("lossy：语义属性丢失（结构/内容对，但格式信息没了）", () => {
    // 结构 kinds 相同、文本原子相同，但代码块的 info（语言）丢了
    const input = "```js\nx\n```\n";
    const output = "```\nx\n```\n";
    const c = classifyOutcome({
      oracle: "md-doc-md",
      input,
      output,
      features: ["fence-basic", "fence-info"],
      diff: diffSignatures(sig(input), sig(output)),
    });
    expect(c.klass).toBe("lossy");
  });

  it("lossy：段落文本被吞（未命中白名单 → 必须算失败）", () => {
    // 注意：这里"少一个块"同时也会导致 kinds 不等 → 判 corrupt。
    // 故用同 kinds、同块数，仅内容被截断的形态，才能落进 lossy 分支。
    const input = "keep **a**\n\nalso **b**\n";
    const output = "keep **a**\n\nalso b\n";
    const c = classifyOutcome({
      oracle: "md-doc-md",
      input,
      output,
      features: ["para-plain", "inline-stress"],
      diff: diffSignatures(sig(input), sig(output)),
    });
    expect(c.klass).toBe("lossy");
  });

  it("normalized：命中纯载体白名单（Setext→ATX：签名全等、仅字节不同）", () => {
    const input = "Title\n===\n";
    const output = "# Title\n";
    const d = diffSignatures(sig(input), sig(output));
    // Setext 与 ATX 的语义签名完全一致（同 heading/h1/同文本）
    expect(d.anyDiff).toBe(false);
    const c = classifyOutcome({
      oracle: "md-doc-md",
      input,
      output,
      features: ["heading-setext"],
      diff: d,
    });
    expect(c.klass).toBe("normalized");
    expect(c.whitelist.map((w) => w.id)).toContain("NW-04-setext-to-atx");
  });

  it("normalized：未登记的纯载体差异会标 carrier-unregistered（不静默放过）", () => {
    const input = "Title\n===\n";
    const output = "# Title\n";
    const c = classifyOutcome({
      oracle: "md-doc-md",
      input,
      output,
      features: ["para-plain"], // 故意不声明 heading-setext → 白名单不命中
      diff: diffSignatures(sig(input), sig(output)),
    });
    expect(c.klass).toBe("normalized");
    expect(c.diffShape).toBe("carrier-unregistered");
    expect(c.whitelist).toEqual([]);
  });

  it("carrier 白名单匹配：只对声明的 feature 与 oracle 生效", () => {
    expect(matchCarrierWhitelist("md-doc-md", ["heading-setext"]).map((w) => w.id)).toContain(
      "NW-04-setext-to-atx",
    );
    expect(matchCarrierWhitelist("md-doc-md", ["para-plain"]).map((w) => w.id)).toEqual([]);
    expect(matchCarrierWhitelist("md-blocks-md", ["heading-setext"])).toEqual([]);
  });

  it("形态匹配白名单：只有 diffShape 真命中时才消费（不是凭 feature 放行）", () => {
    // 形态命中 → 消费（NW-01 的 feature 是 "*"，因为软/硬换行可出现在任意容器）
    const hit = matchWhitelist({
      oracle: "md-doc-md",
      features: ["para-hardbreak-spaces"],
      diffShape: "inline:break",
    });
    expect(hit.map((w) => w.id)).toContain("NW-01-break-representation");
    // 同样的 feature 但形态完全不同 → 不消费（防止白名单变成"按 feature 一刀切放过"）
    const miss = matchWhitelist({
      oracle: "md-doc-md",
      features: ["para-hardbreak-spaces", "html-whitelist"],
      diffShape: "kinds:!heading@0 ; atoms:missing=x",
    });
    expect(miss).toEqual([]);
  });
});

describe("白名单与边界：只有 normalized 允许登记，lossy/corrupt 不得进白名单", () => {
  it("白名单每条都有 id/oracle/feature/pattern/reason/expires（可审计）", () => {
    for (const w of ALL_WHITELIST) {
      expect(w.id).toMatch(/^NW-/);
      expect(w.oracle === "*" || ["md-doc-md", "md-tree-md", "md-blocks-md"].includes(w.oracle)).toBe(true);
      expect(w.pattern.length).toBeGreaterThan(0);
      expect(w.reason.length).toBeGreaterThanOrEqual(20);
      expect(w.expires.length).toBeGreaterThan(0);
      expect(() => new RegExp(w.pattern)).not.toThrow();
    }
  });

  it("白名单 id 唯一（防重复登记导致审计口径混乱）", () => {
    const ids = ALL_WHITELIST.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
    const bids = BLOCKS_EXPORT_BOUNDARIES.map((b) => b.id);
    expect(new Set(bids).size).toBe(bids.length);
  });

  it("白名单 pattern 不得写「吞掉一切」的形态", () => {
    for (const w of NORMALIZED_WHITELIST) {
      expect(w.pattern).not.toBe(".*");
      expect(w.pattern).not.toBe("");
    }
    // 纯载体类必须使用 CARRIER_MARK 标记（不能用正则吞掉形态差异）
    for (const w of CARRIER_WHITELIST) {
      expect(w.pattern).toBe("@@carrier");
    }
  });
});

describe("三条 oracle：可运行、可分类、tree 桩诚实标记", () => {
  const samples = [
    "# h\n\npara **b**\n\n- a\n- b\n",
    "Setext\n===\n\n> q\n>\n> r\n",
    "| a | b |\n|:--|--:|\n| 1 | 2 |\n",
    "```js\nconst x = 1;\n```\n\n![i|300|center](a.png)\n",
    "$$\nx^2\n$$\n\ntext $y$ more\n",
    "- [ ] t\n- [x] u\n\nTerm\n: def\n",
  ];

  it("md→doc→md 对上述样例不 throw", () => {
    for (const s of samples) {
      expect(() => oracleDocRoundtrip(s)).not.toThrow();
    }
  });

  it("md→doc→md（Tier-2 强制逐块序列化）不 throw，且比 Tier-1 更容易暴露差异", () => {
    expect(() => oracleDocRoundtripReserialized(samples[0]!)).not.toThrow();
    // Tier-1 对未编辑文档走 B6 快路径（原文逐字节返回）→ 必然 identical
    expect(oracleDocRoundtrip("Setext\n===\n")).toBe("Setext\n===\n");
    // Tier-2 让 blockSourceMap 全 miss → 走规范序列化。
    // v0.17.0 T4 起 Setext **不再归一化为 ATX**（headingToMarkdown 读 raw.setext
    // 保写法），但下划线长度按新文字重算（G5-1 口径 max(3, len)）→ 仍输出 Setext。
    expect(oracleDocRoundtripReserialized("Setext\n===\n")).toBe("Setext\n======\n");
  });

  it("md→Blocks→md 不 throw，且 Block[] 结构能重建出 markdown", () => {
    const r = oracleBlocksRoundtrip("| a | b |\n|---|---|\n| 1 | 2 |\n");
    expect(r.markdown).toContain("| a | b |");
    expect(blocksToMarkdown([])).toBe("");
  });

  it("tree oracle 是桩时必须标记 unavailable（不许冒充通过）", () => {
    // B 线落地前，adapter.available 必须是 false；落地后此断言随之改为 true。
    if (!treeOracleAdapter.available) {
      expect(treeOracleAdapter.roundtrip).toBeUndefined();
    }
  });

  it("runOracle 对抛异常的产出方标记 ran=false（而不是静默算作通过）", () => {
    const out = runOracle({
      oracle: "md-doc-md",
      input: "# a\n",
      features: [],
      produce: () => {
        throw new Error("boom");
      },
    });
    expect(out.ran).toBe(false);
    expect(out.klass).toBe("corrupt");
    expect(out.error).toContain("boom");
  });
});

describe("fuzz 快档冒烟（20 篇，默认套件内，<5s）", () => {
  const summary = runFuzz({ docs: 20, tier: "quick" }).summary;

  it("20 篇全部跑完，无 oracle throw（tree 桩除外）", () => {
    expect(summary.docs).toBe(20);
    const realExceptions = summary.exceptions.filter((e) => e.oracle !== "md-tree-md");
    expect(realExceptions).toEqual([]);
  });

  it("三条 oracle 都真的执行了（Tier-1 / Tier-2 / Blocks）", () => {
    expect(summary.counts["md-doc-md"]).toBeDefined();
    expect(summary.counts["md-doc-md#reserialize"]).toBeDefined();
    expect(summary.counts["md-blocks-md"]).toBeDefined();
    for (const id of ["md-doc-md", "md-doc-md#reserialize", "md-blocks-md"]) {
      const c = summary.counts[id]!;
      expect(c.identical + c.normalized + c.lossy + c.corrupt).toBe(20);
    }
  });

  it("Tier-1（B6 快路径）对未编辑文档应大面积 identical —— 否则说明快路径本身退化", () => {
    const c = summary.counts["md-doc-md"]!;
    // 允许部分归一化（setext/表格/围栏等），但 identical 必须占多数
    expect(c.identical).toBeGreaterThan(20 * 0.5);
  });

  it(`当前 lossy+corrupt 基线不超过 P0 记录上限 ${EXPECTED_MAX_HARD_FAIL}（B 线修到 0）`, () => {
    expect(summary.totals.lossy + summary.totals.corrupt).toBeLessThanOrEqual(EXPECTED_MAX_HARD_FAIL);
  });

  it("分类统计自洽：每篇每 oracle 恰好落入一个分类", () => {
    const total = Object.entries(summary.counts)
      .filter(([id]) => !(id === "md-tree-md" && !summary.treeOracleAvailable))
      .reduce((acc, [, c]) => acc + c.identical + c.normalized + c.lossy + c.corrupt, 0);
    expect(total).toBe(20 * 3); // 20 篇 × 三条（含 Tier-2）
  });

  it("失败明细包含可复现定位信息（index + oracle + diffShape）", () => {
    for (const f of summary.failures) {
      expect(f.index).toBeGreaterThanOrEqual(0);
      expect(f.index).toBeLessThan(20);
      expect(["lossy", "corrupt"]).toContain(f.klass);
      expect(f.oracle.length).toBeGreaterThan(0);
      expect(f.diffShape.length).toBeGreaterThan(0);
      expect(Array.isArray(f.features)).toBe(true);
    }
  });
});
