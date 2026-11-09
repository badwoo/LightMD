/**
 * v0.17.0 B2 —— 接上 fuzz 的 `md→tree→md` oracle 桩。
 *
 * P0-B 阶段留的桩（`src/__tests__/fuzz/oracles.ts` 的 `treeOracleAdapter`）在这里注入
 * 真实实现：`parseUnified(md)` → `treeToSource(tree)`。
 *
 * ## 为什么这是"自己审判自己"（很重要）
 *
 * fuzz 的 signature 裁判是**独立第三方**：它直接吃 markdown-it token 流，
 * 不与被测出口共用任何代码路径。现在 tree 链路接上后：
 * - 裁判仍独立（不受我实现影响）→ 它对 tree 输出的判定是可信的
 * - 但**被测对象是我写的 parse + serialize** → 它会毫不留情地指出我哪里错了
 *
 * 交接要求（Lead 明确交代）：**不要为了让 fuzz 绿而放松 signature 裁判**。
 * 那条护栏一旦放松，整条 fuzz 就退化成"自己说自己对"。本文件只注入 adapter，不改裁判。
 */

import { parseUnified } from "../../core/unified/parse";
import { treeToSource } from "../../core/unified/serialize";
import { setTreeOracleRoundtrip } from "./oracles";

let installed = false;

/**
 * 注入 tree oracle 的真实实现（幂等；重复调用无副作用）。
 *
 * 由 fuzz 运行器（`scripts/v0170-fuzz.mjs` 加载的 runner）在跑前调用一次。
 */
export function installTreeOracle(): void {
  if (installed) return;
  installed = true;
  setTreeOracleRoundtrip((markdown: string) => {
    const parsed = parseUnified(markdown);
    return treeToSource(parsed.tree, { source: markdown, raw: parsed.raw });
  });
}

/** 测试用：重置安装状态（避免用例间互相影响） */
export function resetTreeOracleForTest(): void {
  installed = false;
}
