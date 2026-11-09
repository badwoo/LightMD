/**
 * scripts/v0170-gen-source-snapshot.mjs —— 生成「源码文本快照」
 *
 * ## 为什么需要这个脚本（而不是一个手写的 .ts 文件）
 *
 * v0.17.0 P0-1 把 `EditorContainer.tsx`（10083 行）拆成「1701 行组装层 + 8 个 pane」。
 * 但仓库里有 **36 个测试文件**用 `readFileSync` 读这个文件的源码，做**文本形态断言**
 * （例如「onPaste 绑到 handleSourcePaste」「补全入口走 beforeinput + 规划器」）。
 * 拆分后那些文本搬进了 pane，这些断言会 ENOENT / 断言失败。
 *
 * 逐个把 111 条断言搬到具体 pane 路径是有风险的：判断错一个去处就会**假绿**
 * （断言读到不相干的文本仍然 toContain 通过）。因此采取「**生成式快照**」：
 * 把容器 + 全部 pane 的源码按固定顺序拼成一个**被测文本联合体**，测试继续读它。
 *
 * ## 关键：它必须是生成的，不能是手抄的
 *
 * 纯静态副本是**化石**：改 pane 逻辑，副本不变，断言永远绿 → 回归护栏退化成装饰。
 * 所以：
 * 1. 本脚本是唯一产出者（改 pane 后必须重跑）；
 * 2. `src/__tests__/v0170-source-snapshot-guard.test.ts` 守卫：
 *    仓库里的快照 == 当场重新拼接的结果，不等即**红灯**并提示运行 `pnpm gen:snapshot`。
 *
 * ## 用法
 *
 * ```bash
 * pnpm gen:snapshot          # 重新生成
 * pnpm gen:snapshot --check  # 只校验（CI / 测试用；不等则 exit 1）
 * ```
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const EDITOR_DIR = join(ROOT, "src", "components", "editor");

/**
 * 拼接顺序（**必须稳定**：顺序变了快照字节就变，守卫会红）。
 *
 * 用「组装层在前、pane 按原文件语句出现顺序在后」，与拆分前的阅读顺序一致。
 */
const PANE_ORDER = [
  "historyhost/HistoryHost.tsx",
  "modesync/ModeSync.tsx",
  "sourcepane/SourcePane.tsx",
  "aiassistpane/AiAssistPane.tsx",
  "searchhost/SearchHost.tsx",
  "aichatpane/AiChatPane.tsx",
  "formatmenuhost/FormatMenuHost.tsx",
  "previewpane/PreviewPane.tsx",
];

const CONTAINER = join(EDITOR_DIR, "EditorContainer.tsx");
const OUT = join(EDITOR_DIR, "EditorContainerSource.ts.txt");

/** 归一化换行：仓库在 Windows 上可能是 CRLF，统一成 LF 才能跨平台字节稳定 */
function normalize(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function rel(abs) {
  return relative(ROOT, abs).replace(/\\/g, "/");
}

/** 拼出快照全文（纯函数：同样输入必然同样输出，守卫测试直接复用） */
export function buildSnapshot() {
  const parts = [];
  parts.push(
    "/* ════════════════════════════════════════════════════════════════════════\n" +
      " * EditorContainerSource.ts.txt —— 「源码文本快照」（v0.17.0 P0-1）\n" +
      " *\n" +
      " * ⚠️ **此文件由 scripts/v0170-gen-source-snapshot.mjs 生成，禁止手改。**\n" +
      " *    改动 EditorContainer.tsx 或任何 panes/**/*.tsx 之后，必须重新运行：\n" +
      " *        pnpm gen:snapshot\n" +
      " *    否则 src/__tests__/v0170-source-snapshot-guard.test.ts 会红灯。\n" +
      " *\n" +
      " * ## 这个文件是干什么的\n" +
      " *\n" +
      " * 36 个既有测试用 readFileSync 读取「EditorContainer 的源码文本」做形态断言\n" +
      " * （例如 onPaste 是否绑到 handleSourcePaste、补全入口是否走 beforeinput + 规划器）。\n" +
      " * 拆分后这些文本搬进了 panes/，但断言的**语义**（\"那段代码长这样\"）没变。\n" +
      " * 因此本文件把「组装层 + 全部 pane」的当前源码按固定顺序拼在一起，\n" +
      " * 让那些断言继续以同一份**当前**文本做校验 —— 不是读一份化石。\n" +
      " *\n" +
      " * 运行时**零引用**；扩展名 .ts.txt 使它不参与 tsc / vite 编译。\n" +
      " * ════════════════════════════════════════════════════════════════════════ */\n",
  );

  const addFile = (absPath) => {
    parts.push(`\n/* ── ${rel(absPath)} ──────────────────────────────────────────────── */\n`);
    parts.push(normalize(readFileSync(absPath, "utf8")));
  };

  addFile(CONTAINER);
  for (const relPath of PANE_ORDER) addFile(join(EDITOR_DIR, "panes", relPath));

  return parts.join("\n");
}

// ─── CLI ────────────────────────────────────────────────────────────────────
//
// ⚠️ 必须只在「被 node 直接执行」时跑 CLI，不能在被 import 时跑。
// 守卫测试 `v0170-source-snapshot-guard.test.ts` import 本文件是为了复用
// `buildSnapshot()`；若 import 就执行写盘，测试会在跑的过程中**改写仓库**，
// 于是"校验过期"变成"顺手修好然后再校验" —— 守卫永远绿，等于没有守卫。
// 判据：`process.argv[1]` 是否就是本文件（node 直接执行时会指向脚本自身；
// vitest 里指向 vitest 的入口）。
const isDirectRun =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").endsWith("v0170-gen-source-snapshot.mjs");

if (!isDirectRun) {
  // 被 import：只导出 buildSnapshot，不产生任何副作用
} else {

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");

const generated = buildSnapshot();

if (checkOnly) {
  let current = "";
  try {
    current = normalize(readFileSync(OUT, "utf8"));
  } catch {
    console.error(`✗ 快照文件不存在：${rel(OUT)}`);
    console.error("  请运行：pnpm gen:snapshot");
    process.exit(1);
  }
  if (current !== generated) {
    console.error(`✗ 快照已过期：${rel(OUT)} 与当前源码不一致。`);
    console.error("  请运行：pnpm gen:snapshot");
    process.exit(1);
  }
  console.log(`✓ 快照与当前源码一致（${generated.split("\n").length} 行）`);
} else {
  writeFileSync(OUT, generated, "utf8");
  const lines = generated.split("\n").length;
  console.log(`✓ 已生成 ${rel(OUT)}`);
  console.log(`  ${lines} 行（${1 + PANE_ORDER.length} 个源文件拼接：组装层 + ${PANE_ORDER.length} 个 pane）`);
}

} // end if (isDirectRun)
