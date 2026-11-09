/**
 * LightMD v0.17.0 P0-3 —— 往返 fuzz 驱动脚本（**正式交付脚本**）。
 *
 * 与默认测试套件的分工（重要）：
 *   - `pnpm test`（vitest）走 `src/__tests__/fuzz/roundtrip-fuzz.test.ts`
 *     —— 20 篇冒烟，守护**基建本身**（seed 确定性、四分类判定、白名单机制），快速不拖累既有套件。
 *   - 本脚本走 200/1000 篇，产出**正式基线**（`_verify-out/v0170-fuzz-baseline.json` + 报告 md）。
 *
 * 为什么用 vite 的 ssrLoadModule 而不是 vitest：
 *  - 快档硬门禁是 **<60s 独立脚本**，塞进 vitest 会连带既有 364 文件套件的
 *    收集/变换开销（设计稿 §7.2/§7.3 要求「不进默认 pnpm test」）；
 *  - 三条 oracle 链路都是 src/ 内的 ESM+TS，需要 vite 的 TS 变换 + 依赖解析；
 *  - 脚本必须在 lightmd 目录内跑（既有测试与 vite 配置都按 process.cwd() 拼路径）。
 *
 * 用法（在 lightmd 目录内）：
 *   node scripts/v0170-fuzz.mjs --tier=quick        # 200 篇（CI 快档，硬门禁 <60s）
 *   node scripts/v0170-fuzz.mjs --tier=full         # 1000 篇（发布前全档）
 *   node scripts/v0170-fuzz.mjs --docs=500          # 自定义篇数
 *   node scripts/v0170-fuzz.mjs --seed=20261109     # 指定 seed 复现某次基线
 *   node scripts/v0170-fuzz.mjs --no-write          # 只跑不落盘（冒烟）
 *   node scripts/v0170-fuzz.mjs --quiet             # 静默（只要汇总）
 *   node scripts/v0170-fuzz.mjs --help              # 帮助
 *
 * 等价 npm 脚本：`pnpm fuzz:quick` / `pnpm fuzz:full`
 *
 * 产物（固定路径，供门禁与审计引用）：
 *   _verify-out/v0170-fuzz-baseline.json   机器可读基线（含每篇失败明细、白名单、git HEAD）
 *   _verify-out/v0170-fuzz-report.md       人类可读报告（按 oracle × 分类 × 特征聚合）
 *
 * 退出码：0 = 无 lossy/corrupt（P0 门禁满足）；1 = 有 lossy/corrupt（打印清单）；
 *         2 = 运行本身失败，或快档耗时 ≥60s（硬门禁失败）。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..");
const OUT_DIR = path.resolve(PROJECT_ROOT, "..", "_verify-out");

const TIERS = { quick: 200, full: 1000 };

function parseArgs(argv) {
  const args = { tier: "quick", docs: null, seed: null, write: true, quiet: false };
  for (const a of argv.slice(2)) {
    if (a.startsWith("--tier=")) args.tier = a.slice(7);
    else if (a.startsWith("--docs=")) args.docs = Number(a.slice(7));
    else if (a.startsWith("--seed=")) args.seed = Number(a.slice(7));
    else if (a === "--no-write") args.write = false;
    else if (a === "--quiet") args.quiet = true;
    else if (a === "--help" || a === "-h") {
      console.log("用法: node scripts/v0170-fuzz.mjs [--tier=quick|full] [--docs=N] [--seed=N] [--no-write] [--quiet]");
      process.exit(0);
    } else {
      console.error(`未知参数: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

const args = parseArgs(process.argv);
const docs = args.docs ?? TIERS[args.tier] ?? 200;

if (!Number.isFinite(docs) || docs <= 0) {
  console.error(`篇数非法: ${docs}`);
  process.exit(2);
}

const t0 = Date.now();

const server = await createServer({
  root: PROJECT_ROOT,
  configFile: path.join(PROJECT_ROOT, "vite.config.ts"),
  server: { middlewareMode: true, hmr: false, watch: null },
  appType: "custom",
  logLevel: "error",
});

let exitCode = 0;
try {
  const runner = await server.ssrLoadModule("/src/__tests__/fuzz/runner.ts");

  const bootMs = Date.now() - t0;
  if (!args.quiet) {
    console.log(`[fuzz] 项目根：${PROJECT_ROOT}`);
    console.log(`[fuzz] 档位=${args.tier} 篇数=${docs} 启动耗时=${(bootMs / 1000).toFixed(2)}s`);
  }

  let lastPct = -1;
  const { summary } = runner.runFuzz({
    docs,
    tier: args.docs ? "full" : args.tier,
    seed: args.seed ?? undefined,
    onDoc: (_r, i) => {
      if (args.quiet) return;
      const pct = Math.floor(((i + 1) / docs) * 100);
      if (pct >= lastPct + 10 || i === docs - 1) {
        lastPct = pct;
        process.stdout.write(`\r[fuzz] 进度 ${pct}%（${i + 1}/${docs}）`);
      }
    },
  });
  if (!args.quiet) process.stdout.write("\n");

  const elapsed = Date.now() - t0;
  const total = summary.totals;

  console.log(`[fuzz] 完成：${docs} 篇 / ${(elapsed / 1000).toFixed(2)}s`);
  for (const [id, c] of Object.entries(summary.counts)) {
    if (id === "md-tree-md" && !summary.treeOracleAvailable) {
      console.log(`[fuzz]   ${id}: 未接入（桩，不参与计数）`);
      continue;
    }
    const t = c.identical + c.normalized + c.lossy + c.corrupt;
    console.log(
      `[fuzz]   ${id}: identical=${c.identical} normalized=${c.normalized} lossy=${c.lossy} corrupt=${c.corrupt} (n=${t})`,
    );
  }
  console.log(
    `[fuzz] 合计：lossy=${total.lossy} corrupt=${total.corrupt} normalized=${total.normalized} identical=${total.identical}`,
  );

  if (summary.failures.length > 0) {
    console.log(`[fuzz] lossy/corrupt 明细（前 12 条，完整清单见 baseline.json）：`);
    for (const f of summary.failures.slice(0, 12)) {
      console.log(`  doc #${f.index} ${f.oracle} ${f.klass} features=[${f.features.join(",")}]`);
      console.log(`    shape: ${f.diffShape.slice(0, 200)}`);
    }
  }

  if (args.write) {
    const baselinePath = runner.writeBaseline({ outDir: OUT_DIR, projectRoot: PROJECT_ROOT, summary });
    const reportPath = runner.writeReport({ outDir: OUT_DIR, summary, baselinePath });
    console.log(`[fuzz] 基线已写入：${baselinePath}`);
    console.log(`[fuzz] 报告已写入：${reportPath}`);
  }

  exitCode = total.lossy + total.corrupt > 0 ? 1 : 0;
  if (args.tier === "quick" && elapsed > 60_000) {
    console.error(`[fuzz] ⚠ 快档硬门禁失败：耗时 ${(elapsed / 1000).toFixed(1)}s ≥ 60s`);
    exitCode = 2;
  }
} catch (e) {
  console.error(`[fuzz] 运行失败：${e && e.stack ? e.stack : e}`);
  exitCode = 2;
} finally {
  await server.close();
}

process.exit(exitCode);
