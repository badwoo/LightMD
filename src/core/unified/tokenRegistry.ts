/**
 * src/core/unified/tokenRegistry.ts —— 结构 token 清单（**零依赖**模块）。
 *
 * ## 为什么单独建一个文件（不是"过度拆分"，是破循环依赖）
 *
 * `unified/parse.ts` 需要这份清单（判定哪些 token 不算 unknown），
 * 而 `utils/exportBlocks.ts` 的 Block[] 出口要切到 `unified/treeToBlocks.ts` ——
 * 这是**双向依赖**：ESM 循环在模块顶层求值时会有一边拿到未初始化绑定（TDZ 抛错）。
 *
 * 三种破法：
 * - (a) 惰性注入（我先试的）：要求每个调用方必经某个初始化入口，漏了会**静默退回旧路径**
 *   —— 这是最难排查的那类隐患（数字看着对、实际没走新路径），**已放弃**。
 * - (b) 把共享常量下沉到无依赖的最小子模块：**零运行时依赖 → 循环不可能发生**。
 * - (c) 让 exportBlocks 直接 import unified：会拖入 markdown-it 等重依赖，且方向反了。
 *
 * 本文件即 (b)。它只含一个 `Set<string>`，不 import 任何东西 —— 任何模块引它都安全。
 *
 * ⚠️ 清单口径来源：v0.11.0 B2-4 的 `STRUCTURAL_TOKENS` 原注释（"结构/容器类 token，
 * 内容由专门分支处理，不应计入 unknownTokens，否则含脚注的文档每次导出都误报
 * 「部分内容无法导出」"）。本文件的清单与 `exportBlocks` 的那份**必须一致**，
 * 由 `src/__tests__/v0170-unified/token-registry.test.ts` 断言（防止两份漂移）。
 */

/**
 * 结构/容器类 token：落到 default 分支属正常，内容由专门分支或后续迭代处理。
 * 不计入 `unknownTokens`（否则含脚注的文档每次导出都会误报"部分内容无法导出"）。
 */
export const STRUCTURAL_TOKENS: ReadonlySet<string> = new Set([
  "footnote_block_open",
  "footnote_block_close",
  "footnote_open",
  "footnote_close",
  "footnote_anchor",
  "footnote_tail",
  "footnote_ref",
  "inline",
  "text",
  "softbreak",
  "hardbreak",
]);

/**
 * 该 token 类型是否应计入 `unknownTokens`（"未能映射"上报）。
 *
 * 口径与 `exportBlocks.parseBlockTokensDetailed` 的 `markUnknown` 一致：
 * - `*_close`：配对标记，由对应 open 处理 → 不计
 * - 结构类（见 `STRUCTURAL_TOKENS`）→ 不计
 * - 其余计入（如未知插件产出的新块类型）
 */
export function isUnknownTokenType(type: string): boolean {
  if (type.endsWith("_close")) return false;
  if (STRUCTURAL_TOKENS.has(type)) return false;
  return true;
}
