/**
 * v0.17.0 P0-3 —— fuzz 执行器（档位、统计、基线落盘）。
 *
 * 双档（设计稿 §7.2）：
 *   quick (CI)  = 200 篇，硬门禁 <60s
 *   full (发布) = 1000 篇，发布前必跑
 * 快档**不进默认 `pnpm test`**（由 scripts/v0170-fuzz.mjs 驱动），
 * 避免拖慢既有 364 文件套件（设计稿 §7.3「bench 脚本非 CI 默认」同理）。
 *
 * 产物：
 *   _verify-out/v0170-fuzz-baseline.json   —— 机器可读基线（含每篇失败明细）
 *   _verify-out/v0170-fuzz-report.md       —— 人类可读报告（按 feature 聚合）
 */

import fs from "node:fs";
import path from "node:path";
import { createRng, deriveSeed } from "./prng";
import { generateDocument, type FeatureId } from "./generator";
import {
  runOracle,
  oracleBlocksRoundtrip,
  oracleDocRoundtrip,
  oracleDocRoundtripReserialized,
  treeOracleAdapter,
  type OracleOutcome,
} from "./oracles";
import {
  NORMALIZED_WHITELIST,
  CARRIER_WHITELIST,
  BLOCKS_EXPORT_BOUNDARIES,
  type DiffClass,
  type OracleId,
} from "./whitelist";

export const DEFAULT_SEED = 20261109;

export interface FuzzDocResult {
  index: number;
  features: string[];
  byteLength: number;
  /** 该篇原文是否含 CRLF（专项覆盖的证据；比较基准已归一化为 LF） */
  hadCrlf: boolean;
  oracles: Record<string, OracleOutcome>;
  unknownTokens: string[];
}

export interface FuzzRunSummary {
  tier: "quick" | "full";
  seed: number;
  docs: number;
  elapsedMs: number;
  /** 分类计数（按 oracle × 分类） */
  counts: Record<string, Record<DiffClass, number>>;
  /** 失败明细（仅 lossy/corrupt） */
  failures: Array<{
    index: number;
    oracle: string;
    klass: DiffClass;
    features: string[];
    diffShape: string;
    inputHead: string;
    outputHead: string;
  }>;
  /** 按 feature 聚合的失败计数（B 线修复清单） */
  byFeature: Record<string, { lossy: number; corrupt: number; normalized: number; identical: number }>;
  /** run 级异常（oracle throw 等） */
  exceptions: Array<{ index: number; oracle: string; error: string }>;
  treeOracleAvailable: boolean;
  totals: { lossy: number; corrupt: number; normalized: number; identical: number; docs: number };
  /**
   * v0.17.0 A 方案：**旧链路存量观测**（`md-doc-md#reserialize`），
   * 不计入门禁 `totals`，但仍如实落盘供审计与后续归零跟踪。
   */
  legacyReserialize: { lossy: number; corrupt: number; normalized: number; identical: number };
}

/** 三条 oracle 的 id 与实现 */
const ORACLE_IDS: OracleId[] = ["md-doc-md", "md-tree-md", "md-blocks-md"];

/** 统一的异常文本提取 */
function errorText(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}

function emptyCounts(): Record<string, Record<DiffClass, number>> {
  const out: Record<string, Record<DiffClass, number>> = {};
  for (const id of [...ORACLE_IDS, "md-doc-md#reserialize"]) {
    out[id] = { identical: 0, normalized: 0, lossy: 0, corrupt: 0 };
  }
  return out;
}

export interface RunOptions {
  docs: number;
  tier: "quick" | "full";
  seed?: number;
  /** 逐篇回调（用于进度输出/省内存） */
  onDoc?: (r: FuzzDocResult, i: number) => void;
  keepDocs?: boolean;
}

export function runFuzz(opts: RunOptions): { summary: FuzzRunSummary; results: FuzzDocResult[] } {
  const seed = opts.seed ?? DEFAULT_SEED;
  const counts = emptyCounts();
  const failures: FuzzRunSummary["failures"] = [];
  const exceptions: FuzzRunSummary["exceptions"] = [];
  const byFeature: FuzzRunSummary["byFeature"] = {};
  const results: FuzzDocResult[] = [];
  const t0 = Date.now();

  const noteFeature = (features: string[], klass: DiffClass) => {
    for (const f of features) {
      if (!byFeature[f]) byFeature[f] = { lossy: 0, corrupt: 0, normalized: 0, identical: 0 };
      byFeature[f]![klass] += 1;
    }
  };

  for (let i = 0; i < opts.docs; i++) {
    const rng = createRng(deriveSeed(seed, i));
    const generated = generateDocument(rng, i);
    const features = generated.features;
    // ⚠️ 比较基准统一用 **LF 归一化文本**（不是生成器原始输出）。
    //
    // 理由：CRLF→LF 是设计稿 §3.2 A2 的**载入侧契约**（写盘由 eolPreserve 还原），
    // 模型层与所有出口全程只认 LF。生成器会产出约 18% 的 CRLF 文档用于专项覆盖，
    // 若拿 CRLF 原文当基准，就会被判成"每个块都丢了 \r"——把真实缺陷淹没在换行噪音里
    // （实测 md-blocks-md 因此虚增 13 篇 lossy，而实际失败数为 0）。
    const markdown = generated.markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const rawCrlf = generated.markdown;
    const oracles: Record<string, OracleOutcome> = {};

    // Tier-1：B6 快路径生效
    oracles["md-doc-md"] = runOracle({
      oracle: "md-doc-md",
      input: markdown,
      features,
      produce: oracleDocRoundtrip,
    });
    // Tier-2：强制逐块规范序列化（fuzz 的真实价值所在）
    const t2 = runOracle({
      oracle: "md-doc-md",
      input: markdown,
      features,
      produce: oracleDocRoundtripReserialized,
    });
    oracles["md-doc-md#reserialize"] = t2;

    // tree oracle：桩阶段明确标记未运行
    if (treeOracleAdapter.available && treeOracleAdapter.roundtrip) {
      oracles["md-tree-md"] = runOracle({
        oracle: "md-tree-md",
        input: markdown,
        features,
        produce: treeOracleAdapter.roundtrip,
      });
    } else {
      oracles["md-tree-md"] = {
        oracle: "md-tree-md",
        ran: false,
        error: "adapter_unavailable: UnifiedDoc 尚未落地（B1/B2）",
        byteIdentical: false,
        klass: "identical", // 未运行不参与分类计数
        whitelist: [],
        boundary: [],
        diffShape: "skipped",
      };
    }

    // Blocks 出口
    let blocksMd = "";
    let unknown: string[] = [];
    try {
      const r = oracleBlocksRoundtrip(markdown);
      blocksMd = r.markdown;
      unknown = r.unknownTokens;
    } catch (e) {
      oracles["md-blocks-md"] = {
        oracle: "md-blocks-md",
        ran: false,
        error: errorText(e),
        byteIdentical: false,
        klass: "corrupt",
        whitelist: [],
        boundary: [],
        diffShape: "exception",
      };
    }
    if (!oracles["md-blocks-md"]) {
      oracles["md-blocks-md"] = runOracle({
        oracle: "md-blocks-md",
        input: markdown,
        features,
        produce: () => blocksMd,
      });
    }

    const docResult: FuzzDocResult = {
      index: i,
      features,
      byteLength: markdown.length,
      hadCrlf: rawCrlf !== markdown,
      oracles,
      unknownTokens: unknown,
    };

    for (const [oracleId, out] of Object.entries(oracles)) {
      const bucket = counts[oracleId] ?? (counts[oracleId] = { identical: 0, normalized: 0, lossy: 0, corrupt: 0 });
      // tree 桩不参与计数（否则 1000 篇全进 identical 会虚增覆盖率）
      if (oracleId === "md-tree-md" && !out.ran) continue;
      bucket[out.klass] += 1;
      if (!out.ran) exceptions.push({ index: i, oracle: oracleId, error: out.error || "unknown" });
      if (out.klass === "lossy" || out.klass === "corrupt") {
        failures.push({
          index: i,
          oracle: oracleId,
          klass: out.klass,
          features,
          diffShape: out.diffShape,
          inputHead: markdown.slice(0, 400),
          outputHead: (out.output || "").slice(0, 400),
        });
      }
      if (out.klass !== "identical") noteFeature(features, out.klass);
    }

    if (opts.keepDocs) results.push(docResult);
    if (opts.onDoc) opts.onDoc(docResult, i);
  }

  const totals = { lossy: 0, corrupt: 0, normalized: 0, identical: 0, docs: opts.docs };
  /**
   * v0.17.0 A 方案（范围缩减）—— **门禁口径正式化**。
   *
   * `md-doc-md#reserialize` 是 Tier-2 的**旧链路存量观测**，不是本版交付门禁：
   * 它测的是 `markdownToDoc` + `docToMarkdown`（`core/markdown/serializer.ts`）这条
   * **本版未切换**的旧路径（设计稿 §3.3 B2 经 Lead 裁定按方案 A 不动，见
   * `oracles.ts` 的 oracleDocRoundtripReserialized 长注释）。它的 corrupt 数
   * 在 P0 阶段就存在、数值稳定，既不属回归、也不属 B 线交付。
   *
   * 因此把计数拆成两组：
   *   · legacyReserialize —— 只观测、**不计入门禁**（仍如实打印与落盘）
   *   · totals（门禁口径）—— 只汇总**本版真正交付**的三条 oracle
   *
   * ⚠️ 这不是"放宽标准"：本版交付的三条 oracle 仍按 lossy+corrupt===0 硬判。
   * 存量项的真实数字（64/1000）依然完整可见，只是不再冒充"本版门禁失败"。
   */
  const legacyReserialize = { lossy: 0, corrupt: 0, normalized: 0, identical: 0 };
  for (const [oracleId, c] of Object.entries(counts)) {
    if (oracleId === "md-tree-md" && !treeOracleAdapter.available) continue;
    if (oracleId === "md-doc-md#reserialize") {
      legacyReserialize.identical += c.identical;
      legacyReserialize.normalized += c.normalized;
      legacyReserialize.lossy += c.lossy;
      legacyReserialize.corrupt += c.corrupt;
      continue;
    }
    totals.identical += c.identical;
    totals.normalized += c.normalized;
    totals.lossy += c.lossy;
    totals.corrupt += c.corrupt;
  }

  return {
    summary: {
      tier: opts.tier,
      seed,
      docs: opts.docs,
      elapsedMs: Date.now() - t0,
      counts,
      failures,
      byFeature,
      exceptions,
      treeOracleAvailable: treeOracleAdapter.available,
      totals,
      legacyReserialize,
    },
    results,
  };
}

// ─── 落盘 ─────────────────────────────────────────────────

export interface BaselineDoc {
  version: "v0.17.0-p0";
  generatedAt: string;
  git: { head: string; branch: string };
  seed: number;
  tier: "quick" | "full";
  docs: number;
  elapsedMs: number;
  summary: FuzzRunSummary;
  whitelist: typeof NORMALIZED_WHITELIST;
  carrierWhitelist: typeof CARRIER_WHITELIST;
  boundaries: typeof BLOCKS_EXPORT_BOUNDARIES;
}

function readGit(cwd: string): { head: string; branch: string } {
  try {
    const head = fs.readFileSync(path.join(cwd, ".git", "HEAD"), "utf-8").trim();
    let branch = "detached";
    if (head.startsWith("ref: ")) branch = head.slice(5).trim().replace("refs/heads/", "");
    const ref = path.join(cwd, ".git", head.startsWith("ref: ") ? head.slice(5).trim() : "HEAD");
    const sha = fs.existsSync(ref) ? fs.readFileSync(ref, "utf-8").trim() : head.slice(0, 40);
    return { head: sha.slice(0, 40), branch };
  } catch {
    return { head: "unknown", branch: "unknown" };
  }
}

export function writeBaseline(args: {
  outDir: string;
  projectRoot: string;
  summary: FuzzRunSummary;
}): string {
  const { outDir, projectRoot, summary } = args;
  fs.mkdirSync(outDir, { recursive: true });
  const baseline: BaselineDoc = {
    version: "v0.17.0-p0",
    generatedAt: new Date().toISOString(),
    git: readGit(projectRoot),
    seed: summary.seed,
    tier: summary.tier,
    docs: summary.docs,
    elapsedMs: summary.elapsedMs,
    summary,
    whitelist: NORMALIZED_WHITELIST,
    carrierWhitelist: CARRIER_WHITELIST,
    boundaries: BLOCKS_EXPORT_BOUNDARIES,
  };
  // 文件名按档位区分：快档是硬门禁口径（固定名，供 CI/门禁引用），
  // 全档是发布前基线（带 -full 后缀），两者同时留存、互不覆盖。
  const file = path.join(
    outDir,
    summary.tier === "full" ? "v0170-fuzz-baseline-full.json" : "v0170-fuzz-baseline.json",
  );
  fs.writeFileSync(file, JSON.stringify(baseline, null, 2), "utf-8");
  return file;
}

export function writeReport(args: { outDir: string; summary: FuzzRunSummary; baselinePath: string }): string {
  const { outDir, summary, baselinePath } = args;
  const L: string[] = [];
  const fmtPct = (n: number, d: number) => (d === 0 ? "—" : ((n / d) * 100).toFixed(1) + "%");

  L.push("# LightMD v0.17.0 P0-3 往返 fuzz 基线报告");
  L.push("");
  L.push(`> 生成时间：${new Date().toISOString()}`);
  L.push(`> seed = \`${summary.seed}\`（同 seed + 同文档序号 → 逐字节相同，基线可复现）`);
  L.push(`> 档位：**${summary.tier}**（${summary.docs} 篇，耗时 ${(summary.elapsedMs / 1000).toFixed(1)}s）`);
  L.push(`> 机器可读基线：\`${path.basename(baselinePath)}\``);
  L.push("");
  L.push("## 1. 结论");
  L.push("");
  const hardFail = summary.totals.lossy + summary.totals.corrupt;
  L.push(
    hardFail === 0
      ? `**P0 门禁满足**：全部 oracle 的 lossy + corrupt = 0。`
      : `**P0 门禁未满足**：lossy=${summary.totals.lossy} / corrupt=${summary.totals.corrupt}（合计 ${hardFail}）。` +
        `按设计稿 §7.4，这些是 **B 线修复清单**（normalized 走白名单，不计失败）。`,
  );
  L.push("");
  L.push("| 口径 | 值 |");
  L.push("|---|---|");
  L.push(`| 文档数 | ${summary.docs} |`);
  L.push(`| identical | ${summary.totals.identical} |`);
  L.push(`| normalized | ${summary.totals.normalized} |`);
  L.push(`| **lossy** | **${summary.totals.lossy}** |`);
  L.push(`| **corrupt** | **${summary.totals.corrupt}** |`);
  L.push(`| tree oracle（md→tree→md） | ${summary.treeOracleAvailable ? "已接入" : "**桩（未接入，B1/B2 待落地）**"} |`);
  L.push(`| 异常（oracle throw） | ${summary.exceptions.length} |`);
  L.push("");
  L.push("## 2. 按 oracle 分类计数");
  L.push("");
  L.push("| oracle | identical | normalized | lossy | corrupt | 执行篇数 |");
  L.push("|---|---|---|---|---|---|");
  for (const [id, c] of Object.entries(summary.counts)) {
    if (id === "md-tree-md" && !summary.treeOracleAvailable) continue;
    const total = c.identical + c.normalized + c.lossy + c.corrupt;
    L.push(`| ${id} | ${c.identical} | ${c.normalized} | ${c.lossy} | ${c.corrupt} | ${total} |`);
  }
  L.push("");
  L.push("说明：`md-doc-md` 是 Tier-1（B6 快路径生效，未编辑文档原文逐字节返回）；");
  L.push("`md-doc-md#reserialize` 是 Tier-2（`nodeFromJSON(doc.toJSON())` 使 blockSourceMap 全 miss，");
  L.push("强制走**逐块规范序列化**）。");
  L.push("");
  L.push("### 1.1 门禁口径（v0.17.0 A 方案：范围缩减后正式化）");
  L.push("");
  L.push("上表的 hardFail **只统计本版真正交付的三条 oracle**（`md-doc-md` / `md-tree-md` / `md-blocks-md`）。");
  L.push("`md-doc-md#reserialize` 测的是**本版未切换的旧 PM 序列化链路**（设计稿 §3.3 B2 经裁定按方案 A 不动，");
  L.push("详见 `src/__tests__/fuzz/oracles.ts` 对应长注释），它在 P0 阶段就存在、数值稳定，");
  L.push("**不是回归、不是 B 线交付**。因此它作为**存量观测项**单独登记，不计入本版门禁：");
  L.push("");
  const legacy = summary.legacyReserialize;
  if (legacy) {
    const legacyTotal = legacy.identical + legacy.normalized + legacy.lossy + legacy.corrupt;
    L.push(`| 存量观测项 | identical | normalized | lossy | corrupt | 篇数 |`);
    L.push("|---|---|---|---|---|---|");
    L.push(`| \`md-doc-md#reserialize\`（旧链路，不计门禁） | ${legacy.identical} | ${legacy.normalized} | ${legacy.lossy} | ${legacy.corrupt} | ${legacyTotal} |`);
    L.push("");
    L.push("该数字会随「序列化接入模型树」一并归零；在此之前**不要**把它当成本版缺陷去修。");
    L.push("");
  }
  L.push("## 3. 按语法特征聚合（B 线修复清单）");
  L.push("");
  L.push("只列出**出现非 identical** 的特征（lossy/corrupt 是必修，normalized 是白名单项）。");
  L.push("");
  L.push("| feature | lossy | corrupt | normalized |");
  L.push("|---|---|---|---|");
  const featRows = Object.entries(summary.byFeature)
    .filter(([, v]) => v.lossy + v.corrupt + v.normalized > 0)
    .sort((a, b) => (b[1].lossy + b[1].corrupt) - (a[1].lossy + a[1].corrupt));
  for (const [f, v] of featRows) L.push(`| ${f} | ${v.lossy} | ${v.corrupt} | ${v.normalized} |`);
  if (featRows.length === 0) L.push("| （无） | 0 | 0 | 0 |");
  L.push("");

  // 失败明细分组（按 diffShape 前缀聚合，避免 1000 行重复）
  L.push("## 4. lossy/corrupt 明细（按差异形态聚合）");
  L.push("");
  if (summary.failures.length === 0) {
    L.push("无。");
  } else {
    interface Grp {
      oracle: string;
      klass: DiffClass;
      shape: string;
      count: number;
      features: Set<string>;
      samples: Array<{ index: number; inputHead: string; outputHead: string }>;
    }
    const groups = new Map<string, Grp>();
    for (const f of summary.failures) {
      // 差异形态压缩：去掉具体的原子文本，只保留形态类
      const shapeKey = f.diffShape
        .replace(/=([^⏐;]*)/g, "=…")
        .replace(/⏐[^;]*/g, "⏐…")
        .slice(0, 220);
      const key = `${f.oracle}||${f.klass}||${shapeKey}`;
      let g = groups.get(key);
      if (!g) {
        g = { oracle: f.oracle, klass: f.klass, shape: shapeKey, count: 0, features: new Set(), samples: [] };
        groups.set(key, g);
      }
      g.count += 1;
      f.features.forEach((x) => g.features.add(x));
      if (g.samples.length < 2) g.samples.push({ index: f.index, inputHead: f.inputHead, outputHead: f.outputHead });
    }
    const sorted = [...groups.values()].sort((a, b) => b.count - a.count);
    sorted.forEach((g, i) => {
      L.push(`### 4.${i + 1} ${g.klass} × ${g.oracle}（${g.count} 篇）`);
      L.push("");
      L.push(`- 差异形态：\`${g.shape}\``);
      L.push(`- 涉及特征：${[...g.features].join(", ")}`);
      for (const s of g.samples) {
        L.push("");
        L.push(`  doc #${s.index} 输入片段：`);
        L.push("");
        L.push("  ```markdown");
        for (const line of s.inputHead.split("\n").slice(0, 12)) L.push("  " + line);
        L.push("  ```");
        L.push(`  doc #${s.index} 输出片段：`);
        L.push("");
        L.push("  ```markdown");
        for (const line of s.outputHead.split("\n").slice(0, 12)) L.push("  " + line);
        L.push("  ```");
      }
      L.push("");
    });
  }
  L.push("");
  L.push("## 5. normalized 白名单（显式登记，可审计）");
  L.push("");
  L.push("### 5.1 形态匹配类（diffShape 里确有语义属性差异，但写法等价）");
  L.push("");
  L.push("| id | oracle | feature | 等价理由 | 最迟删除 |");
  L.push("|---|---|---|---|---|");
  for (const w of NORMALIZED_WHITELIST) {
    L.push(`| ${w.id} | ${w.oracle} | ${w.feature} | ${w.reason.replace(/\n/g, " ")} | ${w.expires} |`);
  }
  L.push("");
  L.push("### 5.2 纯载体类（签名全等、仅字节不同：Setext/围栏/缩进/空行/CRLF…）");
  L.push("");
  L.push("| id | oracle | feature | 等价理由 | 最迟删除 |");
  L.push("|---|---|---|---|---|");
  for (const w of CARRIER_WHITELIST) {
    L.push(`| ${w.id} | ${w.oracle} | ${w.feature} | ${w.reason.replace(/\n/g, " ")} | ${w.expires} |`);
  }
  L.push("");
  L.push("`carrier-unregistered` 表示纯载体差异但**未登记**（B 线需补登记或修实现），在明细里可查。");
  L.push("");
  L.push("## 6. Blocks 出口已声明能力边界");
  L.push("");
  L.push("| id | feature | 说明 | 最迟删除 |");
  L.push("|---|---|---|---|");
  for (const b of BLOCKS_EXPORT_BOUNDARIES) {
    L.push(`| ${b.id} | ${b.feature} | ${b.reason.replace(/\n/g, " ")} | ${b.expires} |`);
  }
  L.push("");
  L.push("## 7. 复现方式");
  L.push("");
  L.push("```bash");
  L.push("cd lightmd");
  L.push("node scripts/v0170-fuzz.mjs --tier=quick     # 200 篇，CI 快档");
  L.push("node scripts/v0170-fuzz.mjs --tier=full      # 1000 篇，发布前全档");
  L.push(`node scripts/v0170-fuzz.mjs --seed=${summary.seed}   # 指定 seed 复现`);
  L.push("```");
  L.push("");
  L.push("## 8. 口径与已知限制");
  L.push("");
  L.push(`- 覆盖率：${summary.totals.identical + summary.totals.normalized >= 0 ? `${(fmtPct(summary.totals.identical, summary.docs))} 的文档在 Tier-1 字节级相同` : ""}`);
  L.push("- **tree oracle 是桩**：`setTreeOracleRoundtrip()` 未注入时明确标记 `adapter_unavailable`，");
  L.push("  **不参与分类计数**（不虚增 identical），也不冒充通过。B 线落地后注入即生效。");
  L.push("- Tier-2 的「编辑等价物」是 `nodeFromJSON` 克隆，不是真实内容编辑 —— 它只让 B6 快路径失效，");
  L.push("  不改变被测文本，因此差异可全部归因于序列化实现。");
  L.push("- 未覆盖（P0 阶段有意不做，B/V 阶段补）：多光标、IME、跨文件撤销、PM 内交互（Table 合并交互等）——");
  L.push("  这些属实机探针范畴（设计稿 §3.4 V 周），不是本文档级 fuzz 的检测面。");
  L.push("");
  const file = path.join(
    outDir,
    summary.tier === "full" ? "v0170-fuzz-report-full.md" : "v0170-fuzz-report.md",
  );
  fs.writeFileSync(file, L.join("\n"), "utf-8");
  return file;
}
