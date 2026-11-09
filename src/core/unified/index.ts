/**
 * src/core/unified/index.ts —— UnifiedDoc 模块的**统一入口**（聚合导出）。
 *
 * ## 循环依赖说明（这里记录一次，避免后来人重新踩）
 *
 * 曾有双向依赖：`unified/parse.ts` 要 `utils/exportBlocks` 的 `STRUCTURAL_TOKENS`，
 * 而 `exportBlocks` 的 Block[] 出口要切到 `unified/treeToBlocks`。
 *
 * 我先试过"惰性注入"（由本文件在加载时把转换函数注册给 exportBlocks）。
 * **放弃了** —— 它要求每个调用方必经本文件的加载副作用，漏了会**静默退回旧路径**
 * （数字看着对、实际没走新路径），这是最难排查的那类隐患。
 *
 * 最终解法：把共享清单**下沉到零依赖的 `tokenRegistry.ts`**，循环就不可能发生。
 * 故 `exportBlocks.ts` 现在可以**静态 import** `unified/treeToBlocks`，无需任何注入。
 *
 * 本文件退化为纯聚合导出（`import { ... } from "@/core/unified"` 的便捷入口）。
 */

export { parseUnified, type UnifiedParseResult, type UnifiedParseOptions } from "./parse";
export { treeToSource, blockToSource, inlineToSource } from "./serialize";
export { treeToBlocks, inlineNodesToRuns, nodeToBlock, type TreeToBlocksResult } from "./treeToBlocks";
export { docStore, createDocStore, MAX_DOCS, type DocSnapshot, type ParagraphBreaks } from "./store";
export { parseImageSuffix, escapeImageAlt, type ImageSuffix } from "./imageSuffix";
export type { MdNode, NodeKind, SourcePosMap, UnifiedDoc, InlineNode, MdRaw, MdSpan, MdLineRange } from "./model";
