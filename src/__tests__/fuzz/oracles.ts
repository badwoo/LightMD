/**
 * v0.17.0 P0-3 —— 三条 oracle 与四分类判定。
 *
 * 三条链路（设计稿 §7.2）：
 *   md→doc→md    : parser.markdownToDoc  → serializer.docToMarkdown（PM 出口）
 *   md→tree→md   : UnifiedDoc tree → md（**本阶段留桩**，B 线接入；桩必须
 *                  明确失败/跳过而不是"假装通过" —— 见 TreeOracleAdapter）
 *   md→Blocks→md : exportBlocks.parseMarkdownToBlocks → blocksToMarkdown（导出出口）
 *
 * 四级分类（设计稿 §7.2）：
 *   identical  : 字节级相同
 *   normalized : 语义等价、写法归一化（**必须白名单登记**）
 *   lossy      : 内容丢失（数据安全级，必修）
 *   corrupt    : 结构破坏（块种类序列被重排/替换，或凭空生成内容）
 *
 * 「Tier-2」为什么存在（关键设计决策）：
 *   docToMarkdown 有一条 **B6 快路径** —— 未编辑文档直接返回原文（零 diff）。
 *   只比 Tier-1 的话，PM 出口永远全绿，fuzz 形同虚设。故对每篇文档额外跑一次
 *   「PM 内编辑过等价物」：`schema.nodeFromJSON(doc.toJSON())` 重建 doc，
 *   使 blockSourceMap 的 WeakMap 全 miss，强制走**逐块规范序列化**路径。
 *   这才是 B 线要收敛的真实序列化口径。Tier-1 的失败若是 Tier-2 的超集说明是
 *   快路径之外的缺陷，两级都记录。
 *
 * 编辑等价性：nodeFromJSON(doc.toJSON()) 与「PM 内实际编辑一个块」后走逐块路径
 * 的形态一致（WeakMap 按对象身份存，克隆后全 miss），不额外注入内容变更 ——
 * 避免把「内容被我们改了」算成「序列化失真」。
 */

import { markdownToDoc } from "../../core/markdown/parser";
import { docToMarkdown } from "../../core/markdown/serializer";
import { lightMDSchema } from "../../core/schema";
import { parseMarkdownToBlocksDetailed } from "../../utils/exportBlocks";
import { blocksToMarkdown } from "./blocksToMarkdown";
import {
  computeSignature,
  diffSignatures,
  isKindMultisetSubset,
  type SignatureDiff,
} from "./signature";
import {
  matchWhitelist,
  matchCarrierWhitelist,
  matchBoundary,
  type DiffClass,
  type OracleId,
  type WhitespaceEntry,
} from "./whitelist";

// ─── tree oracle 桩（B 线接入点） ─────────────────────────────

/**
 * TODO(v0.17.0 B 线)：`src/core/unified/parse.ts` + `serialize.ts` 落地后，
 * 把下面两个函数替换为真实实现：
 *   tree = unifiedParse(markdown)        // MdNode[]（带 span/lines/raw）
 *   md   = unifiedSerialize(tree)        // tree → source
 *
 * 本阶段**明确标记 unavailable**，绝不返回输入原文冒充通过（那会让 P0 门禁
 * 假绿，正是设计稿 §7.4「口径要诚实可审计」反对的）。
 */
export interface TreeOracleAdapter {
  available: boolean;
  label: string;
  roundtrip?: (markdown: string) => string;
}

export const treeOracleAdapter: TreeOracleAdapter = {
  available: false,
  label: "md→tree→md（UnifiedDoc 桩：B1/B2 未落地）",
};

/** 供 B 线实现后注入（保持 P0 与 B 线解耦） */
export function setTreeOracleRoundtrip(fn: (markdown: string) => string): void {
  treeOracleAdapter.available = true;
  treeOracleAdapter.roundtrip = fn;
}

// ─── 单 oracle 执行 ────────────────────────────────────────

export interface OracleOutcome {
  oracle: OracleId;
  /** 该 oracle 是否真的跑过（桩/异常时为 false 或 error） */
  ran: boolean;
  error?: string;
  output?: string;
  /** 字节级相同 */
  byteIdentical: boolean;
  /** 语义签名差异 */
  diff?: SignatureDiff;
  /** 最终分类 */
  klass: DiffClass;
  /** 命中的白名单条目 */
  whitelist: WhitespaceEntry[];
  boundary: string[];
  /** 差异形态（白名单匹配用，也写进报告） */
  diffShape: string;
}

/** 统一的异常文本提取（unknown catch 变量在 strict 下不可直接取 .message） */
function errorText(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}

/** 把 diff 压成一个可读的差异形态串（供白名单匹配与报告） */
function diffShapeOf(diff: SignatureDiff): string {
  const parts: string[] = [];
  if (!diff.kindsEqual) parts.push("kinds:!" + diff.kindsOnlyInInput.join(",") + "→" + diff.kindsOnlyInOutput.join(","));
  if (diff.missingAtoms.length) parts.push("atoms:missing=" + diff.missingAtoms.slice(0, 3).join("⏐"));
  if (diff.extraAtoms.length) parts.push("atoms:extra=" + diff.extraAtoms.slice(0, 3).join("⏐"));
  if (diff.attrsOnlyInInput.length) parts.push("attr:" + diff.attrsOnlyInInput.slice(0, 3).join("⏐"));
  if (diff.attrsOnlyInOutput.length) parts.push("attr:+" + diff.attrsOnlyInOutput.slice(0, 3).join("⏐"));
  return parts.join(" ; ");
}

/**
 * 分类核心（纯函数，可单测）：
 *
 * 优先级（高 → 低）：
 *   1. corrupt : output 结构不是 input 的子序列（重排/替换），或凭空多出内容
 *   2. lossy   : 内容丢失且**未被白名单/边界**解释
 *   3. normalized : 语义等价（签名无差异 / 命中白名单 / Blocks 已声明边界）
 *   4. identical : 字节相同（最高优先，覆盖以上）
 */
export function classifyOutcome(args: {
  oracle: OracleId;
  input: string;
  output: string;
  features: string[];
  diff: SignatureDiff;
}): { klass: DiffClass; whitelist: WhitespaceEntry[]; boundary: string[]; diffShape: string } {
  const { oracle, input, output, features, diff } = args;
  const byteIdentical = input === output;
  const diffShape = diffShapeOf(diff);

  if (byteIdentical) {
    return { klass: "identical", whitelist: [], boundary: [], diffShape: "" };
  }

  const isBlocks = oracle === "md-blocks-md";
  const sigIn = computeSignature(input);
  const sigOut = computeSignature(output);

  // ── 1. 结构破坏判定 ──
  // Blocks 出口用「只减不增」的子序列判定（导出链路的已声明能力边界）；
  // 其余 oracle 要求 kinds 序列全等。
  let structuralBreak: boolean;
  if (isBlocks) {
    structuralBreak = !isKindMultisetSubset(sigIn.kindsRaw, sigOut.kindsRaw);
  } else {
    structuralBreak = !diff.kindsEqual;
  }
  const contentAdded = diff.extraAtoms.length > 0;

  // ── 先算边界命中：Blocks 出口的能力边界也可能表现为「块被移动/替换」
  // （例：脚注定义被摊平成普通段落并挪到文末），那属于边界而不是结构破坏。
  const lostKinds = diff.kindsOnlyInInput;
  const boundaryEntries = isBlocks
    ? matchBoundary(features, lostKinds, [...diff.missingAtoms, ...diff.extraAtoms])
    : [];
  const boundary = boundaryEntries.map((b) => b.id);

  if (contentAdded) {
    return { klass: "corrupt", whitelist: [], boundary, diffShape };
  }
  if (structuralBreak) {
    // Blocks 出口：所有缺失种类都被已声明边界覆盖 → 记边界，不算结构破坏
    const explained = isBlocks && boundary.length > 0 && lostKinds.length > 0;
    if (!explained) {
      return { klass: "corrupt", whitelist: [], boundary, diffShape };
    }
  }

  if (diff.missingAtoms.length > 0) {
    // Blocks 出口：若内容缺失完全由已声明边界解释，则降级为 normalized（记 boundary）
    const hasUnexplainedAtoms = !isBlocks || boundary.length === 0;
    if (hasUnexplainedAtoms) {
      return { klass: "lossy", whitelist: [], boundary, diffShape };
    }
  }

  // 结构上有 kind 缺失但内容全在（例如 footnote_block 丢了、正文段落还在）
  if (lostKinds.length > 0 && !isBlocks) {
    // 非 Blocks 出口丢 kind = 结构破坏（已在上面判 corrupt，理论上不会到这里）
    return { klass: "corrupt", whitelist: [], boundary, diffShape };
  }

  // ── 3. 归一化判定（分两条路，见 whitelist.ts 头注释）──
  // 3a. 形态匹配类：diffShape 里确实有语义属性差异，但属已知等价写法
  const wl = matchWhitelist({ oracle, features, diffShape });
  if (wl.length > 0) {
    return { klass: "normalized", whitelist: wl, boundary, diffShape };
  }
  if (isBlocks && boundary.length > 0) {
    // Blocks 出口：差异完全由**已声明能力边界**解释
    return { klass: "normalized", whitelist: [], boundary, diffShape };
  }
  // 3b. 纯载体类：签名全等（kinds/atoms/attrs），仅字节不同 —— 必须登记才算 normalized
  if (!diff.anyDiff) {
    const carrier = matchCarrierWhitelist(oracle, features);
    if (carrier.length > 0) {
      return { klass: "normalized", whitelist: carrier, boundary, diffShape };
    }
    // 未登记的纯载体差异：不静默放过（报告里单列，B 线要么补登记要么修）
    return { klass: "normalized", whitelist: [], boundary, diffShape: "carrier-unregistered" };
  }

  // 剩余：内容与结构都对，但语义属性（heading level/align/start/delim/href/format）不同
  // —— 属性是语义的一部分，未登记即判 lossy（信息丢失）
  return { klass: "lossy", whitelist: [], boundary, diffShape };
}

/** 跑单个 oracle */
export function runOracle(args: {
  oracle: OracleId;
  input: string;
  features: string[];
  produce: (md: string) => string;
}): OracleOutcome {
  const { oracle, input, features, produce } = args;
  let output: string;
  try {
    output = produce(input);
  } catch (e) {
    return {
      oracle,
      ran: false,
      error: errorText(e),
      byteIdentical: false,
      klass: "corrupt",
      whitelist: [],
      boundary: [],
      diffShape: "exception",
    };
  }
  const diff = diffSignatures(computeSignature(input), computeSignature(output));
  const c = classifyOutcome({ oracle, input, output, features, diff });
  return {
    oracle,
    ran: true,
    output,
    byteIdentical: input === output,
    diff,
    klass: c.klass,
    whitelist: c.whitelist,
    boundary: c.boundary,
    diffShape: c.diffShape,
  };
}

// ─── 三条 oracle 具体实现 ─────────────────────────────────

/** md→doc→md（Tier-1：B6 快路径生效，未编辑文档零 diff） */
export function oracleDocRoundtrip(markdown: string): string {
  const doc = markdownToDoc(markdown);
  return docToMarkdown(doc);
}

/**
 * md→doc→md（Tier-2：强制逐块规范序列化）。
 *
 * `nodeFromJSON(doc.toJSON())` 重建 doc —— blockSourceMap 的 WeakMap 按对象身份
 * 存，克隆后全部 miss，于是 docToMarkdown 走**逐块规范序列化**路径。
 * 这与「用户在 PM 内编辑过一个块」的序列化形态等价（不注入内容变更，
 * 确保差异全部可归因于序列化实现而非被测数据）。
 */
export function oracleDocRoundtripReserialized(markdown: string): string {
  const doc = markdownToDoc(markdown);
  const clone = lightMDSchema.nodeFromJSON(doc.toJSON());
  return docToMarkdown(clone);
}

/** md→Blocks→md（导出出口重建） */
export function oracleBlocksRoundtrip(markdown: string): { markdown: string; unknownTokens: string[] } {
  // CRLF 归一化（与 tree oracle 同口径）：Block[] 出口产出的是 `\n` 文本，
  // 而输入可能是 CRLF —— 若拿 CRLF 原文做比较基准，**每个块"都"会显示差异，
  // 把真实缺陷淹没在换行噪音里（实测 doc#21/#60 全是这个原因）。
  //
  // 这不是"放宽判定"：CRLF→LF 是设计稿 §3.2 A2 的**载入侧契约**
  // （写盘时由 eolPreserve 还原），模型层与导出层全程只认 LF。
  const normalized = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const r = parseMarkdownToBlocksDetailed(normalized);
  return { markdown: blocksToMarkdown(r.blocks), unknownTokens: r.unknownTokens };
}
