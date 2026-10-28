/**
 * SearchReplaceDialog —— 搜索和替换对话框（浮动窗口）
 *
 * 支持 Ctrl+F 搜索和 Ctrl+H 查找替换
 * 在阅读模式下搜索 ProseMirror 内容，在编辑模式下搜索 textarea 内容
 *
 * v0.3.5 改进：
 * - 浮动窗口，支持拖拽移动
 * - Ctrl+F 重复按可重新激活搜索框
 * - 搜索框编辑时保持焦点（不被 ProseMirror focus 抢走）
 * - 修复阅读模式搜索高亮与匹配位置不一致（buildOffsetBlocks 同时构建 text，保证偏移一致）
 *
 * 性能优化：
 * - buildOffsetMap 从每字符 Map 改为块级数组 + 二分查找
 * - 100KB 文档：内存从 4-8MB 降至 20-80KB
 *
 * v0.14.0 需求2（搜索增强）：
 * - 选项区改为 4 个勾选框：全词匹配 / 匹配大小写 / 选取范围内 / 正则（默认全不勾）
 * - 「选取范围内」= **勾选瞬间**捕获一次选区作为范围快照，之后随替换增量平移
 *   （不平移就会在第一次替换后失效，用户会看到「替换越界」）
 * - 「查找所有打开文件」：条幅列出每个文件的命中行，点条目跳到对应文件/位置
 * - 替换（单个/全部）与查找共用同一份 SearchOptions，范围外的文本永不被改写
 * - 纯函数层抽到 utils/searchEngine.ts（本文件只保留组件与兼容包装）
 */
import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from "react";
import type { Node as PMNode } from "prosemirror-model";
import { searchHighlightKey, searchMatchesKey, type SearchHighlightRange } from "../../core/editor";
// v0.15.1 需求5：源码模式（textarea）搜索高亮的 overlay 构建（纯函数，可单测）
import { buildSearchOverlayHtml, SOURCE_SEARCH_OVERLAY_CLASS, SEARCH_MATCH_CURRENT_CLASS } from "../../utils/highlight";
import { syncTextareaMetrics } from "../../utils/focus-paragraph";
import { useEditorStore } from "../../stores/useEditorStore";
import { useT, getCurrentLanguage } from "../../i18n";
import {
  lookupPmPos,
  pmPosToTextOffset,
  buildSearchRegexEx,
  findMatchRangesEx,
  buildRawOffsetMap,
  rawOffsetToNormalized,
  applyReplacementToRange,
  collectFileResults,
  resolveJumpOffset,
  resolveJumpByOccurrence,
  pmLineColumnOfOffset,
  MAX_FILES,
  type MatchRange,
  type OffsetBlock,
  type SearchOptions,
  type SearchFileResult,
} from "../../utils/searchEngine";
import {
  requestSearchJump,
  peekSearchJump,
  peekSearchJumpSeq,
  takeSearchJump,
  jumpOccurrenceOf,
  SEARCH_JUMP_EVENT,
  type SearchJumpTarget,
} from "../../utils/searchJump";
import { pathCompareKey } from "../../utils/path";
import { UNTITLED_PROGRESS_PREFIX } from "../../utils/tabKey";
import {
  cancelWorkspaceSearch,
  createWorkspaceQueryId,
  searchWorkspace,
  skipSummaryTotal,
  WorkspaceSearchError,
  type WorkspaceFileResult,
  type WorkspaceSearchSnapshot,
} from "../../services/workspaceSearch";
import "./SearchReplace.css";

// R4 起 MatchRange 就由本文件导出（既有测试/调用方按此路径 import），
// v0.14.0 实现搬到 utils/searchEngine.ts 后这里保持同名再导出，避免改调用方。
export type { MatchRange };

/**
 * v0.15.0 R6b：**工作区结果里的路径显示与跳转**。
 *
 * 为什么不能只用文件名：`D:/ws/a/README.md` 与 `D:/ws/b/README.md` 文件名完全一样，
 * 只显示文件名无法区分；必须显示相对工作区根的路径（如 `a/README.md`），
 * 否则用户根本定位不到是哪一个。
 *
 * 取**最深匹配根**：多根同时打开时（如 `D:/ws` 与 `D:/ws/proj`），同一个文件
 * 应相对更具体的那个根来显示——与 v0.15.0 F2「嵌套根取最深」同一口径。
 *
 * 不做任何覆盖：源文件路径原样返回，仅用于展示；跳转仍用完整绝对路径。
 */
function relPathOf(filePath: string, roots: string[]): string {
  if (!filePath) return "";
  const norm = filePath.replace(/\\/g, "/");
  const lower = norm.toLowerCase();
  let best: string | null = null;
  for (const r of roots) {
    if (!r) continue;
    const root = r.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (!root) continue;
    if (lower === root || lower.startsWith(root + "/")) {
      if (best === null || root.length > best.length) best = root;
    }
  }
  if (best === null) return norm;
  const rest = norm.slice(best.length).replace(/^\/+/, "");
  return rest || norm;
}

/**
 * v0.15.1 需求4：**跳转键归一化**（面板内唯一比较口径）。
 *
 * 真因（复核确认）：工作区结果的 `fileKey` 来自 `services/workspaceSearch.ts`
 * 的 `fileKeyOf()` = `pathCompareKey(filePath)`（反斜杠→正斜杠 + 全小写），
 * 而面板这一侧的 `docKey` 是宿主直接给的原始路径（`D:\ws\a.md` 这种原生形态）。
 * 两边直接 `===` 永远不相等 → 接收端 effect 里 `pending.fileKey !== key` 恒真 →
 * pending 永不被消费 → 用户点结果"没反应"。
 *
 * 归一化只对**真实文件路径**成立；临时标签的键是 `untitled:<id>`（无路径语义），
 * 归一化会把它小写化（本来也全小写），但为免将来 id 带大写被误伤，这里显式放行。
 * 空串（未落盘且无 id 的兜底）原样返回，避免把两个"无键"文档误判成同一份。
 */
function jumpKeyOf(key: string | null | undefined): string {
  const raw = key ?? "";
  if (!raw) return "";
  if (raw.startsWith(UNTITLED_PROGRESS_PREFIX)) return raw;
  return pathCompareKey(raw);
}

/** 两个跳转键是否指向同一文档（空键永不相等） */
function sameJumpKey(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = jumpKeyOf(a);
  const kb = jumpKeyOf(b);
  return ka !== "" && ka === kb;
}

/**
 * v0.15.1 需求6：结果条幅的「高度平滑」外壳。
 *
 * 为什么需要 JS 而不是纯 CSS：条幅内容在收起时会被**卸载**（既有交互契约：
 * 收起后 `search-results` 节点必须不存在）。纯 CSS 的 height:auto ↔ 0 过渡在
 * "内容一卸载高度就已经塌了"的情况下没有起点可插值，还是会一帧跳变。
 * 因此这里在展开/收起切换的那一帧用 useLayoutEffect：
 * 1. 先把外壳高度**锁**成收起前的实测值（`height: <px>`）；
 * 2. 强制读一次布局（reflow）让浏览器记住这个起点；
 * 3. 下一帧再切到目标值（展开 = auto，收起 = 0），过渡才有得插值。
 *
 * 退化路径：浏览器不支持 `interpolate-size: allow-keywords` 时，`height:auto` 不可插值，
 * 浏览器会在过渡结束后直接落到 auto —— 观感上是"很快就出现"，功能与布局完全正确。
 * `prefers-reduced-motion` 下 CSS 关掉过渡，本组件也不做任何额外动作（幂等）。
 */
function ResultsShell({
  open,
  testId,
  children,
}: {
  open: boolean;
  testId: string;
  children?: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  /** 上一帧是否是展开态（用于区分"展开/收起"两个方向） */
  const prevOpenRef = useRef(open);
  /** 最近一次展开时实测的内容高度（收起动画的起点） */
  const lastHeightRef = useRef(0);

  useLayoutEffect(() => {
    const el = ref.current;
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;
    if (!el) return;
    if (open) {
      // 展开：起点锁 0 → 目标 auto（allow-keywords 支持时可插值）
      el.style.height = "0px";
      // 强制 reflow，确保浏览器以 0 作为过渡起点
      void el.offsetHeight;
      el.style.height = "";
      // 记录本次展开后的真实高度（下次收起时作为起点）
      const raf = requestAnimationFrame(() => {
        lastHeightRef.current = el.offsetHeight;
      });
      return () => cancelAnimationFrame(raf);
    }
    if (!wasOpen) return; // 一直是收起态：不需要动画
    // 收起：起点锁住上次展开高度 → 目标 0
    el.style.height = `${lastHeightRef.current || el.offsetHeight}px`;
    void el.offsetHeight;
    el.style.height = "0px";
    return;
  }, [open]);

  return (
    <div
      ref={ref}
      className={`search-results-shell${open ? " is-open" : ""}`}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

/** 「查找所有打开文件」的数据来源：一个可搜索的已打开文件 */
export interface SearchableFile {
  /** 文件稳定标识（当前文件夹用 `tab.id ?? tab.path`） */
  fileKey: string;
  /** 绝对路径（临时文件为空串） */
  filePath: string;
  /** 展示用文件名 */
  fileName: string;
  /**
   * 返回**实时**文本（不能是渲染时的快照）。
   * 为什么是函数而不是字符串：条幅可能要过一会儿才展开/刷新，
   * 期间用户可能已经改了当前文档或切了标签；传字符串会把旧内容搜出来。
   *
   * 注意：这里返回的必须是**未归一化**的原文（可含 CRLF），
   * collectFileResults 内部会自己做换行归一化并算行号。
   */
  getText: () => string;
}

interface SearchReplaceProps {
  onClose: () => void;
  editorView: import("prosemirror-view").EditorView | null;
  sourceTextareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  sourceContent?: string;
  onSourceContentChange?: (content: string) => void;
  /** 初始是否显示替换行（Ctrl+H 时为 true） */
  initialShowReplace?: boolean;
  /** Issue 6：是否为 Markdown 文件。非 md 文件总是走 sourceContent 搜索分支（ProseMirror 为空） */
  isMdFile?: boolean;
  /**
   * v0.14.0：当前文档稳定标识（App 侧传 `activeTab.id ?? activeTab.path`）。
   * 用途：切文件 / 切模式时判定「选取范围内」的旧快照失效。
   * 缺省时退化为只按模式判断（独立测试用）。
   */
  docKey?: string;
  /**
   * v0.14.0：「查找所有打开文件」的数据来源。
   * 缺省时功能退化为「仅搜索当前文档」（保证面板可独立测试、也保证未接线时不崩）。
   */
  collectFiles?: () => SearchableFile[];
  /** v0.14.0：跨文件跳转回调（切标签由 App 负责；缺省只派发 lightmd:search-jump 事件） */
  onJumpToFile?: (t: SearchJumpTarget) => void;
  /**
   * v0.14.0：编辑模式下右侧预览是否打开（两模式合并后由 Lead 接线；缺省按 true）。
   * 用途：右侧没有预览面板时条幅可以给更高（不存在「遮住预览」的顾虑）。
   */
  splitPreviewOpen?: boolean;
  /**
   * v0.14.0 需求4：把**任意标签**的新内容写回（跨文件批量替换用）。
   *
   * 为什么需要它：`onSourceContentChange` 只能改**当前**文档（它直连编辑区状态）。
   * 「查找所有打开文件 → 全部替换」要改的是**所有命中的文件**，其中大部分是
   * 未激活的标签 —— 它们的内容只存在于 `openTabs[i].content` 里，必须由宿主
   * （EditorContainer / App）统一写回并置脏，面板拿不到 store 写权限。
   *
   * 约定（宿主必须遵守）：
   * - `fileKey` 与 `collectFiles()` 给出的 fileKey **同一口径**（真实文件 = 路径、
   *   临时标签 = `untitled:<id>`）；
   * - 若 fileKey 是当前文档 → 必须走与 `onSourceContentChange` 同一条写回路径
   *   （否则编辑区 state 与标签内容会分叉）；
   * - 非当前文档 → 写回该标签 content 并置脏（不要静默丢改动）。
   *
   * 缺省时「全部替换」退化为只替换当前文档（保证面板可独立测试、未接线不崩）。
   */
  applyFileText?: (fileKey: string, newText: string) => void;
  /**
   * v0.14.0 需求5：内容版本号（宿主传 `forceUpdateKey`）。
   *
   * 作用：搜索面板打开期间切换文档时，**立即**在新文档上重跑一次搜索。
   *
   * 为什么不能只靠 `sourceContent` 变化触发：阅读模式下换文档时 PM 的
   * `editorView` 是**同一个对象**、`sourceContent`（源码侧 state）也不会变
   * （它只在编辑/切模式时同步），所以 `performSearch` 的依赖全都没变 →
   * 搜索永远停在旧文档上（用户看到「切了文档但搜索没跟过去」）。
   * 这个版本号每次换文档 +1，是唯一可靠的「文档已换」信号。
   */
  contentVersion?: number;
  /**
   * v0.15.0 需求 R6b：**工作区搜索**的数据来源（`openFolders` 根目录，宿主传）。
   *
   * - 缺省（undefined / 空数组）→ 「工作区」作用域按钮**不渲染**，面板行为与 v0.14.0
   *   完全一致（保证未接线时不崩、也不出现点了没反应的按钮）。
   * - 由宿主从 `useFileStore.getState().openFolders` 取值传入（本面板不读 store：
   *   文件系统状态属于宿主职责，面板只做展示与转发）。
   */
  workspaceRoots?: string[];
  /**
   * v0.15.0 需求 R6b：已打开文件的内存文本（**脏文档覆盖**用）。
   *
   * 工作区结果算的是磁盘内容；用户改了已打开文件但没保存时，条幅会显示"这行有"、
   * 点进去却没有。传入本回调后，服务层会对**已打开文件**改用内存文本重算命中。
   *
   * 缺省时不覆盖（结果 = 纯磁盘内容），功能可用但存在上述不一致。
   * 实现建议：复用既有的 `collectFiles()` 结果转成 `{ filePath, getText }`。
   */
  openFileTexts?: () => Array<{ filePath: string; getText: () => string }>;
}

// ─── 块级偏移映射（v0.14.0：实现已抽到 utils/searchEngine.ts）──────────

/**
 * 偏移映射结果类型（保留在本文件的理由：既有测试按 `interface OffsetMap` 锁定，
 * 且组件内多处按此结构标注；实现见 utils/searchEngine.ts 的 buildOffsetMap）。
 */
interface OffsetMap {
  text: string;
  blocks: OffsetBlock[];
}

/**
 * 构建块级偏移映射数组，同时构建 textContent。
 *
 * 问题2修复（v0.3.5）：text 和 blocks 必须在**同一次遍历**中构建，保证偏移量完全一致。
 * 旧实现用 textBetween 取 text、另一趟构建 blocks，两边的换行插入逻辑不一致 →
 * 阅读模式高亮位置整体偏移。
 *
 * ⚠️ v0.14.0：同一份逻辑在 utils/searchEngine.ts 里也有一份（纯函数层需要它，
 * 而纯函数层不能反向依赖本组件）。两处必须逐字一致，由 v0140-search-engine.test.ts
 * 的「两份 buildOffsetMap 输出一致」用例守护；改这里务必同步改那边。
 * 之所以不在这里只写一行 `return buildOffsetMapCore(doc)`：v0.3.5 的防回退用例
 * 按本文件的函数体锁定「同趟遍历」这一性质，留薄封装会让该用例失去实际保护力。
 */
function buildOffsetMap(doc: PMNode): OffsetMap {
  const blocks: OffsetBlock[] = [];
  let textOffset = 0;
  let lastBlockPos = -1;
  let text = "";

  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      // 块边界换行符：textContent 在块边界插入换行符
      if (lastBlockPos >= 0) {
        textOffset += 1;
        text += "\n";
        lastBlockPos = -1;
      }
      blocks.push({
        textStart: textOffset,
        textEnd: textOffset + node.text.length,
        pmStart: pos,
      });
      text += node.text;
      textOffset += node.text.length;
    } else if (node.isBlock && !node.isInline && pos > 0) {
      lastBlockPos = pos;
    }
    return true;
  });

  return { text, blocks };
}

/**
 * v0.15.1 需求5：把文本偏移空间的命中区间映射为 **PM 文档区间**（纯函数）。
 *
 * 为什么单独抽出来：`performSearch`（把全部命中推给 Decoration 插件）与
 * `highlightMatch`（只更新当前项）都要做这件事，两处必须用**同一套映射规则**，
 * 否则"全量高亮"和"当前项高亮"会落在不同字符上（用户会看到当前项框住了别的词）。
 *
 * 映射规则（与既有单区间实现逐条一致，不能改）：
 * - 起点：`lookupPmPos(blocks, start)`
 * - 终点：`lookupPmPos(blocks, end - 1)` 再 `+1`（`end-1` 是为了让"恰好结束在块末尾"
 *   的命中落在同一块内，而不是越到下一块开头）
 * - 任一端落在块间隙（换行符）或越界 → 该命中**跳过**（无法在 PM 里表达）
 *
 * @returns 与 `ranges` 同序的 `{from,to}` 数组（跳过项不出现在结果里），
 *   以及在结果中的「当前项下标」（原始 current 找不到时为 -1 → 调用方回退到 0）
 */
function mapRangesToPm(
  blocks: OffsetBlock[],
  ranges: ReadonlyArray<MatchRange>,
  docSize: number,
): { ranges: SearchHighlightRange[]; currentOf: Map<number, number> } {
  const out: SearchHighlightRange[] = [];
  const currentOf = new Map<number, number>();
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    const pmStart = lookupPmPos(blocks, r.start);
    if (pmStart === undefined) continue;
    const pmEnd = lookupPmPos(blocks, r.end - 1);
    if (pmEnd === undefined) continue;
    const to = Math.min(pmEnd + 1, docSize);
    if (to <= pmStart) continue;
    currentOf.set(i, out.length);
    out.push({ from: pmStart, to });
  }
  return { ranges: out, currentOf };
}

/**
 * v0.15.1 需求5：在「匹配下标 → PM 区间下标」换算表里找**最近的**已映射项。
 *
 * 为什么需要：某些命中在 PM 空间里无法表达（起点/终点落在块间隙，例如跨段落的
 * 命中在 `offsetMap.text` 里是连续的、在 PM 里却跨两个块）。这类命中没有对应
 * 区间，若直接回退到"第 0 处"，用户点「下一个」会看到醒目色**跳回文档开头**，
 * 像是按钮失灵。这里取"同方向最近的一处"作为当前项，视觉上连续、不会误导。
 *
 * @returns 有换算表时返回最近的已映射下标；表为空时返回 -1
 */
function nearestMappedRangeIndex(currentOf: Map<number, number>, matchIdx: number): number {
  if (currentOf.size === 0) return -1;
  const direct = currentOf.get(matchIdx);
  if (direct !== undefined) return direct;
  let bestKey = Number.POSITIVE_INFINITY;
  let bestVal = -1;
  for (const [k, v] of currentOf) {
    // 优先取「匹配下标 ≥ 当前」里最小的那个；没有再取全局最大的
    if (k >= matchIdx && k < bestKey) {
      bestKey = k;
      bestVal = v;
    }
  }
  if (bestVal >= 0) return bestVal;
  for (const [k, v] of currentOf) {
    if (k < bestKey) {
      bestKey = k;
      bestVal = v;
    }
  }
  return bestVal;
}

/**
 * v0.15.1 需求5：构造要推给 Decoration 插件的区间集合（含 2000 处上限）。
 *
 * 输入必须是**已映射到 PM 空间的区间**（`mapRangesToPm` 的输出）。
 * 上限的意义见 `MAX_HIGHLIGHT_MATCHES`；这里只负责"截取前 N 处"并**保留当前项**：
 * 若当前项落在截断范围之外（用户点到了第 2500 处的"下一个"），把它替换进来，
 * 否则用户点了上/下却看不到"当前项"颜色，会以为按钮失灵。
 */
function buildHighlightPayload(
  pmRanges: ReadonlyArray<SearchHighlightRange>,
  currentIdx: number,
): { payload: { ranges: SearchHighlightRange[]; current: number }; truncated: boolean } {
  const truncAt = Math.min(pmRanges.length, MAX_HIGHLIGHT_MATCHES);
  const truncated = pmRanges.length > truncAt;
  const ranges = pmRanges.slice(0, truncAt).map((r) => ({ from: r.from, to: r.to }));
  let current = currentIdx >= 0 && currentIdx < truncAt ? currentIdx : -1;
  if (current < 0 && truncated && pmRanges.length > 0) {
    // 当前项在截断之外：用当前项替换掉最后一处，保证"当前项颜色"一定可见
    const cur = pmRanges[Math.max(0, Math.min(currentIdx, pmRanges.length - 1))];
    if (cur && ranges.length > 0) {
      ranges[ranges.length - 1] = { from: cur.from, to: cur.to };
      current = ranges.length - 1;
    }
  }
  if (current < 0) current = ranges.length > 0 ? 0 : -1;
  return { payload: { ranges, current }, truncated };
}

/**
 * R4（v0.10.0）：按模式构造搜索正则（纯函数，便于单元测试）
 *
 * - 关闭正则：全量转义元字符（v0.4.2 字面量语义回归不变）
 * - 开启正则：直接按正则语义构造；非法正则返回 null（组件据此红字提示、禁用查找，
 *   不抛异常不崩溃）
 *
 * v0.14.0：内部委托 buildSearchRegexEx（多出全词断言能力），签名保持向后兼容。
 *
 * @returns 带全局标志的 RegExp；非法正则返回 null
 */
export function buildSearchRegex(searchText: string, caseSensitive: boolean, useRegex: boolean): RegExp | null {
  // 实现细节：全词匹配不在旧签名里，故此处等价于 buildSearchRegexEx 的「无全词」分支；
  // 需要全词时请直接用 buildSearchRegexEx(searchText, { wholeWord: true }).
  return buildSearchRegexEx(searchText, { caseSensitive, useRegex });
}

/**
 * R4：在文本中搜索匹配区间（纯函数，textarea 与 PM 两条路径共用）
 *
 * @returns 匹配区间数组；开启正则且表达式非法时返回 null；空关键词返回 []
 */
export function findMatchRanges(
  text: string,
  searchText: string,
  caseSensitive = false,
  useRegex = false,
): MatchRange[] | null {
  return findMatchRangesEx(text, searchText, { caseSensitive, useRegex });
}

/**
 * R4：展开替换文本中的捕获组引用（$1/$2/$& 等）
 *
 * - 正则模式：用原生 String.replace 语义展开（与 textarea 路径的
 *   String.replace(replacement) 行为一致）
 * - 字面量模式：替换文本原样输出（保持 v0.4.2 行为，"$1" 不展开）
 */
export function expandReplacement(matchedText: string, regex: RegExp, replacement: string, useRegex: boolean): string {
  if (!useRegex) return replacement;
  return matchedText.replace(regex, replacement);
}

/**
 * Issue 6：在文本中搜索匹配项，返回匹配起始位置数组（纯函数，便于单元测试）
 *
 * 用于 md 文件的 ProseMirror 内容搜索和非 md 文件的 textarea 源码搜索。
 * 特殊字符会被正则转义，避免搜索文本中含 . * + 等时误匹配。
 * R4：内部委托 findMatchRanges（区间 → 起点数组兼容层）；开启正则且非法时返回 []。
 *
 * @param text 待搜索的文本（sourceContent 或 PM textContent）
 * @param searchText 搜索关键词
 * @param caseSensitive 是否区分大小写
 * @param useRegex 是否按正则语义匹配（R4）
 * @returns 匹配起始位置数组（0-indexed），最多返回 10000 个以防无限循环
 */
export function findMatches(text: string, searchText: string, caseSensitive = false, useRegex = false): number[] {
  const ranges = findMatchRanges(text, searchText, caseSensitive, useRegex);
  return ranges ? ranges.map((r) => r.start) : [];
}

/** 「选取范围内」快照的空范围哨兵：无选区时用它把匹配数压成 0（见 toggleInSelection） */
const EMPTY_RANGE: MatchRange = { start: 0, end: 0 };
/** collectFiles 缺省（仅当前文档）时使用的 fileKey */
const FALLBACK_FILE_KEY = "__search_current_doc__";
/**
 * v0.15.1 需求5：**同时高亮的命中处数上限**。
 *
 * 为什么必须有上限：旧实现只给一处上 Decoration，成本是 O(1)；改成"全部高亮"后
 * 每次搜索都要为每处命中建 Decoration 并做 `DecorationSet.create`（内部按位置建树），
 * 几千处尚可（实测 2000 处 ≈ 十几 ms），上万处会明显掉帧，而用户根本看不出
 * 一万个黄框的差别（屏幕里同时可见的也就几十处）。
 *
 * 取 2000：约等于"一屏 40 行 × 50 屏"的可见量，远超实际阅读范围，
 * 又把最坏情况的 Decoration 数量钉死在可预测的量级。
 * **超出时绝不静默**：计数处追加可见提示（见 `highlightTruncated`），
 * 计数本身仍显示全部命中总数（用户知道真实总量）。
 */
const MAX_HIGHLIGHT_MATCHES = 2000;
/** 上限提示用的 i18n key（i18n 由 Lead 统一维护，缺失时走下方兜底文案） */
const HIGHLIGHT_LIMIT_KEY = "search.highlightTruncated";
/**
 * i18n 尚未补该 key 时的兜底文案。
 *
 * 为什么不用 `t()` 的默认行为（缺 key 返回 key 本身）：那会让用户看到
 * `search.highlightTruncated` 这种原始 key，等于没有提示 —— 而需求明确要求
 * "不要静默截断"。这里按当前语言给一句可读的兜底，等 Lead 在 locales 里补上
 * 正式 key 后自动生效（`t()` 命中就不再走兜底）。
 */
const HIGHLIGHT_LIMIT_FALLBACK: Record<string, string> = {
  "zh-CN": "仅高亮前 {count} 处",
  "en-US": "highlighting first {count} only",
};

/**
 * 上限提示文案：优先取 i18n 正式 key，**未配置时用兜底文案**。
 *
 * 为什么要判断返回值是否等于 key 本身：`t()` 的缺失行为是"返回 key 并 console.warn"，
 * 直接用它会让用户看到 `search.highlightTruncated` 这种原始 key（等于没有提示）。
 */
function highlightLimitMessage(t: (k: string, p?: Record<string, string | number>) => string, count: number): string {
  const text = t(HIGHLIGHT_LIMIT_KEY, { count });
  if (text !== HIGHLIGHT_LIMIT_KEY) return text;
  const lang = getCurrentLanguage();
  const fallback = HIGHLIGHT_LIMIT_FALLBACK[lang] ?? HIGHLIGHT_LIMIT_FALLBACK["zh-CN"];
  return fallback.replace("{count}", String(count));
}
/**
 * 搜索面板的**兜底宽度**（CSS 里是固定 620px）。
 *
 * 用途只有两处「测量失败时的降级」：初始居中定位、拖拽 clamp。
 * 必须与 `SearchReplace.css` 的 `.search-replace { width }` 保持一致 ——
 * 不一致会让测量失败的那一帧把面板摆偏/夹错。
 *
 * 版本沿革：460（初版）→ 920（v0.15.1 需求5，导致"又扁又长"）
 * → **620（v0.15.1 需求3 观感重设计，与输入框 38px 高配成协调比例，
 *   且实测中英文都能一行放下所有勾选项与作用域按钮）**。
 */
const SEARCH_PANEL_FALLBACK_WIDTH = 620;
/**
 * 「阅读模式下 doc 变化 → 重算搜索」的防抖时长。
 *
 * 为什么需要：连续打字每一击都是一个新 doc 对象，若每帧全量重扫整篇文档，
 * 长文档（几 MB）会变成稳定的每帧数 ms 开销 → 输入卡顿。
 * 150ms 是「用户停手后立刻看到计数更新」与「不占输入帧」的折中：
 * 慢于人的连续击键间隔（~100ms 内），快于人的感知阈值（~200ms）。
 */
const CONTENT_RESYNC_DEBOUNCE_MS = 150;

export function SearchReplaceDialog({
  onClose,
  editorView,
  sourceTextareaRef,
  sourceContent,
  onSourceContentChange,
  initialShowReplace = false,
  isMdFile = true,
  docKey,
  collectFiles,
  onJumpToFile,
  splitPreviewOpen,
  applyFileText,
  contentVersion,
  workspaceRoots,
  openFileTexts,
}: SearchReplaceProps) {
  const t = useT();
  const viewMode = useEditorStore((s) => s.viewMode);
  /**
   * 编辑模式下右侧预览是否打开（v0.14.0 两模式合并后由 store 持有）。
   *
   * 为什么这里既支持 prop 又读 store：
   * - store 里的 `splitPreviewOpen` 是权威值（Lead 已接线），面板独立渲染时也能拿到正确的默认值；
   * - prop 保留作显式覆盖入口（测试/将来把面板复用到其它宿主时用）。
   * 缺省按 `true` 处理（与 store 默认值一致），保证面板不会因未接线而少一块高度。
   */
  const storeSplitPreviewOpen = useEditorStore((s) => s.splitPreviewOpen);
  const previewOpen = splitPreviewOpen ?? storeSplitPreviewOpen ?? true;
  /**
   * 源码模式判定（v0.14.0：两模式合并后**唯一正确**的写法是 `viewMode !== "preview"`）。
   *
   * 为什么不能写 `viewMode === "edit" || viewMode === "split"`：
   * 本版把「编辑/分屏」合并成一个「编辑模式 + 预览开关」，`"split"` 这个值会消失；
   * 任何硬编码 "split" 的判断在合并后都会静默失配（搜索在编辑模式下直接失效）。
   * 非 md 文件永远走源码分支（PM 为空），故仍保留 `|| !isMdFile`。
   */
  const isSourceMode = viewMode !== "preview" || !isMdFile;
  // 问题3：监听 searchFocusKey 变化，重复按 Ctrl+F 时重新聚焦
  const searchFocusKey = useEditorStore((s) => s.searchFocusKey);
  const [searchText, setSearchText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  /**
   * 匹配大小写（沿用的是 R4 以来的同一个 state，v0.14.0 只是把 UI 从按钮换成勾选框）。
   * ⚠️ 不要再新增一份「matchCase」状态：两份状态会让勾选框与搜索行为脱钩。
   */
  const [caseSensitive, setCaseSensitive] = useState(false);
  // R4：正则开关与非法表达式标记（非法时红字提示、禁用查找）
  const [useRegex, setUseRegex] = useState(false);
  // v0.14.0：全词匹配（默认不勾）
  const [wholeWord, setWholeWord] = useState(false);
  // v0.14.0：「选取范围内」勾选状态 + 范围快照（快照 = 勾选瞬间的选区，之后随替换平移）
  const [inSelection, setInSelection] = useState(false);
  const [selectionRange, setSelectionRange] = useState<MatchRange | null>(null);
  // v0.14.0：「查找所有打开文件」条幅
  const [showResults, setShowResults] = useState(false);
  const [fileResults, setFileResults] = useState<SearchFileResult[]>([]);
  const [resultFileCounts, setResultFileCounts] = useState<Record<string, number>>({});
  const [resultMatchTotal, setResultMatchTotal] = useState(0);
  const [resultsTruncated, setResultsTruncated] = useState(false);
  const [regexInvalid, setRegexInvalid] = useState(false);
  const [matchCount, setMatchCount] = useState(0);
  const [currentMatch, setCurrentMatch] = useState(0);
  const [showReplace, setShowReplace] = useState(initialShowReplace);

  /**
   * v0.15.0 R6b：**搜索作用域**三档。
   *
   * - `current`：当前文件（默认，与 v0.14.0 完全一致）；
   * - `openFiles`：打开的文件（v0.14.0 的「查找所有打开文件」条幅）；
   * - `workspace`：工作区（Rust 扫 openFolders，流式结果）。
   *
   * 为什么用单一 state 而不是沿用 `showResults` 布尔：条幅的"显隐"与"数据来源"
   * 是两个维度，用布尔会让"切到工作区但没展开条幅"这类中间态无法表达；
   * 而且三档互斥（同一时刻只有一个生效），单 state 天然保证互斥。
   * `showResults` 保留为"条幅是否展开"的派生值（见 showResults 定义处），
   * 保证既有逻辑与测试不受影响。
   */
  const [scope, setScope] = useState<"current" | "openFiles" | "workspace">("current");
  /** 工作区结果（按文件分组） */
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFileResult[]>([]);
  const [workspaceTotal, setWorkspaceTotal] = useState(0);
  const [workspaceScanned, setWorkspaceScanned] = useState(0);
  const [workspaceSkipped, setWorkspaceSkipped] = useState(0);
  const [workspaceTruncated, setWorkspaceTruncated] = useState(false);
  /** 工作区搜索进行中（进度条/取消按钮的显隐） */
  const [workspaceSearching, setWorkspaceSearching] = useState(false);
  /** 工作区搜索错误提示（正则拒绝等）；null = 无错误 */
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  /** 脏文档覆盖剔除数（提示"已按内存内容校正"） */
  const [workspaceReconciled, setWorkspaceReconciled] = useState(0);
  /** 当前工作区查询 id（换词/关闭时据此 cancel） */
  const workspaceQueryRef = useRef<string | null>(null);

  // 当 initialShowReplace 变化时同步 showReplace（Ctrl+H 在已打开搜索框时切换到替换模式）
  useEffect(() => {
    if (initialShowReplace) setShowReplace(true);
  }, [initialShowReplace]);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // R4：匹配数组升级为区间（正则匹配长度可变），高亮/替换均按区间计算
  const matchesRef = useRef<MatchRange[]>([]);
  // 缓存偏移映射，performSearch 构建后 highlightMatch 复用
  const offsetMapRef = useRef<OffsetMap | null>(null);
  /**
   * v0.15.1 需求5：这批匹配映射到 **PM 区间**后的结果（只读缓存）。
   *
   * 为什么要缓存：`performSearch` 要把全部命中推给 Decoration（O(n) 次二分），
   * `highlightMatch` 只挪"当前项"。若每次 ↑/↓ 都重算全量映射，点一下要扫全文
   * （几 MB 文档上百 ms），手感直接崩。匹配集一变（performSearch 重新赋值）这里就整体覆盖。
   *
   * `currentOf` 是「匹配下标 → PM 区间下标」的换算表：映射时可能有命中落在块间隙
   * 被跳过（换行符位置），两者下标就会错位，绝不能直接混用。
   *
   * `doc` 记录这份缓存属于哪一版文档：PM 位置是**某一版 doc 的坐标**，doc 换了
   * （用户打字/替换/撤销而 performSearch 还没跑完防抖）缓存必须整体作废，
   * 否则 ↑/↓ 会把醒目色框到错误的字上。
   */
  const pmRangesRef = useRef<{
    doc: PMNode;
    ranges: SearchHighlightRange[];
    currentOf: Map<number, number>;
  } | null>(null);
  /**
   * v0.15.1 需求5：源码模式 overlay 用的命中区间（`{start,end}` 文本偏移坐标）。
   * 与 `pmRangesRef` 互斥：哪个模式生效由 `isSourceMode` 决定，切换时另一边会被清空。
   */
  const sourceHighlightRangesRef = useRef<MatchRange[]>([]);
  /** 源码模式搜索高亮 overlay（懒创建，挂在 textarea 的 `.source-editor-wrapper` 里） */
  const sourceOverlayRef = useRef<HTMLDivElement | null>(null);
  /**
   * v0.15.1 需求5：这批匹配是**基于哪一版 doc** 算出来的。
   *
   * 为什么必须有：`highlightMatch` 用 `matchesRef`（文本偏移）+ `offsetMapRef`
   * （块映射）反查 PM 位置，两者都属于"某一版文档的坐标"。用户在阅读模式里打字后，
   * doc 立刻变了，但重算搜索走 150ms 防抖（`CONTENT_RESYNC_DEBOUNCE_MS`）——
   * 这段窗口里若点 ↑/↓，旧偏移套到**新**文档上就会把醒目色框到**别的词**上
   *（实测：在 "cat dog cat" 前面插一个 cat，点「下一个」会把 "dog" 框成当前项）。
   *
   * 因此：doc 与这里记录的不一致时，`highlightMatch` **直接不动高亮**，
   * 等防抖重搜算完再上色。宁可短暂没有醒目色，也不能框错词 —— 框错词会让用户
   * 以为"搜索定位错了"，比"慢半拍"严重得多。
   */
  const matchesDocRef = useRef<PMNode | null>(null);
  // 选区快照所属文档（docKey+m 模式）：与当前文档不一致时快照作废
  const selectionDocKeyRef = useRef<string>("");
  /**
   * collectFiles 走 ref：EditorContainer 很可能用内联箭头函数传（每次渲染新引用），
   * 若进入 useCallback 依赖会导致「重建结果 → 重渲染 → 依赖变化 → 再重建」的死循环。
   */
  const collectFilesRef = useRef(collectFiles);
  collectFilesRef.current = collectFiles;

  // ─── 问题4：浮动窗口拖拽 ──────────────────────────
  const containerRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [initialized, setInitialized] = useState(false);

  // 初始位置：浮动在文档中间
  useEffect(() => {
    if (!initialized && containerRef.current) {
      // v0.15.1 需求3：面板宽度固定 620px（CSS），兜底值同步跟上，
      // 否则测量失败时会按旧的 920 居中 —— 视觉上明显偏右。
      const w = containerRef.current.offsetWidth || SEARCH_PANEL_FALLBACK_WIDTH;
      const h = containerRef.current.offsetHeight || 80;
      setPosition({
        x: Math.max(20, (window.innerWidth - w) / 2),
        y: Math.max(20, (window.innerHeight - h) / 2 - 100),
      });
      setInitialized(true);
    }
  }, [initialized]);

  // 问题3修复：拖拽事件改为在 handleDragStart 中注册，避免 useEffect 挂载时 dragging=false 导致不注册
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    // 不在 input/button 上触发拖拽
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "BUTTON") return;
    const startX = e.clientX;
    const startY = e.clientY;
    const posX = position.x;
    const posY = position.y;

    const handleMove = (ev: MouseEvent) => {
      const newX = posX + ev.clientX - startX;
      const newY = posY + ev.clientY - startY;
      /**
       * 限制在视口范围内。
       *
       * 面板宽度改为 620px（v0.15.1 需求3）后，`innerWidth - 60` 这种"左沿离右边 60px"
       * 的旧口径会把面板右半截拖出视口（右侧内容不可见、拖回来也费劲）。
       * 这里按**面板实测宽度**夹住右沿，保证整块面板始终可见。
       * 面板比视口还宽时（窄窗口 + max-width:92vw 已兜底，正常不会发生）夹到 0。
       */
      const panelW = containerRef.current?.offsetWidth || SEARCH_PANEL_FALLBACK_WIDTH;
      const maxX = Math.max(0, window.innerWidth - panelW);
      const maxY = window.innerHeight - 30;
      setPosition({
        x: Math.max(0, Math.min(newX, maxX)),
        y: Math.max(0, Math.min(newY, maxY)),
      });
    };
    const handleUp = () => {
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
    };
    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
    e.preventDefault();
  }, [position]);

  // 聚焦搜索框（初始 + searchFocusKey 变化时）
  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  // 问题3：searchFocusKey 变化时重新聚焦搜索框
  useEffect(() => {
    if (searchFocusKey > 0) {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }
  }, [searchFocusKey]);

  // 问题1修复：组件卸载时清除 ProseMirror 中的搜索高亮 Decoration
  // v0.15.1 需求5：除当前项那一层，**全部命中**那一层与源码 overlay 也必须清干净，
  // 否则关掉搜索面板后整篇文档还挂着黄框（用户会以为"高亮坏了"）。
  useEffect(() => {
    return () => {
      if (editorView && !isSourceMode) {
        try {
          const tr = editorView.state.tr;
          tr.setMeta(searchHighlightKey, null);
          tr.setMeta(searchMatchesKey, null);
          editorView.dispatch(tr);
        } catch {
          // 忽略清除错误（editorView 可能已销毁）
        }
      }
      // v0.15.1 需求5：移除源码模式的高亮 overlay 节点（懒创建，得自己收尸）
      const overlay = sourceOverlayRef.current;
      if (overlay) {
        overlay.innerHTML = "";
        overlay.remove();
        sourceOverlayRef.current = null;
      }
      pmRangesRef.current = null;
      sourceHighlightRangesRef.current = [];
      // v0.4.3 Issue 3：清除非 md 文件阅读模式的选区高亮
      if (!isMdFile) {
        window.getSelection()?.removeAllRanges();
      }
    };
  }, [editorView, isSourceMode, isMdFile]);

  // ─── v0.14.0：「选取范围内」范围快照 ─────────────────────────

  /** 当前文档标识（docKey 由 App 提供；模式变化也算换文档） */
  const currentDocKey = `${docKey ?? ""}::${isSourceMode ? "source" : "pm"}`;

  /**
   * 读取当前文本（归一化后）与原始串。
   * 源码模式返回原文（可能含 CRLF）+ 归一化文本；阅读模式返回 PM 偏移映射的 text。
   */
  const readCurrentText = useCallback((): { text: string; raw: string | null } => {
    if (isSourceMode) {
      const raw = sourceContent ?? sourceTextareaRef?.current?.value ?? "";
      // v0.4.4 修复：规范化换行符后位置才与 textarea.value 一致
      return { text: raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n"), raw };
    }
    if (editorView) {
      const map = offsetMapRef.current ?? buildOffsetMap(editorView.state.doc);
      offsetMapRef.current = map;
      return { text: map.text, raw: null };
    }
    return { text: "", raw: null };
  }, [isSourceMode, sourceContent, sourceTextareaRef, editorView]);

  /**
   * 捕获当前选区为文本偏移范围。
   *
   * - 编辑模式：textarea.selectionStart/End 是**原始串**坐标，若含 CRLF 必须先换算成
   *   归一化偏移（否则每个 "\r\n" 都让范围错位一格，替换就会越界到范围外）
   * - 阅读模式：PM 的 from/to 用 buildOffsetMap 的 blocks 反查文本偏移
   *   （pmPosToTextOffset 会把落在块间隙的位置收敛到前一块末尾）
   *
   * @returns 有效选区范围；无选区/无法换算时返回 null
   */
  const captureSelectionRange = useCallback((): MatchRange | null => {
    if (isSourceMode) {
      const ta = sourceTextareaRef?.current;
      if (!ta) return null;
      const raw = sourceContent ?? ta.value;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      if (end <= start) return null;
      return { start: rawOffsetToNormalized(raw, start), end: rawOffsetToNormalized(raw, end) };
    }
    if (!editorView) return null;
    const sel = editorView.state.selection;
    if (sel.empty || sel.to <= sel.from) return null;
    const map = buildOffsetMap(editorView.state.doc);
    const start = pmPosToTextOffset(map.blocks, sel.from);
    const end = pmPosToTextOffset(map.blocks, sel.to);
    if (start === undefined || end === undefined || end <= start) return null;
    return { start, end };
  }, [isSourceMode, sourceContent, sourceTextareaRef, editorView]);

  /**
   * 勾选/取消「选取范围内」。
   *
   * 关键语义（用户确认过）：**勾选瞬间**捕获一次选区作为范围快照，之后不再跟随光标。
   * 为什么不做成"实时跟随"：替换会把光标/选区打散，一替换范围就丢了；
   * 也没有"实时快照"这种能力（PM 选区与文本偏移不是同一坐标系）。
   *
   * 无选区时：**保持勾选**但范围置空 → 匹配数 0 + 红字提示。
   * 为什么不静默退化成全文：用户勾了这个框就是明确表示"只在选区内操作"，
   * 若悄悄退化成全文，一次"全部替换"就会改掉整篇文档（不可逆的用户事故）。
   */
  const handleToggleInSelection = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.checked) {
      setInSelection(false);
      setSelectionRange(null);
      setSelectionLostByDocChange(false);
      return;
    }
    const captured = captureSelectionRange();
    selectionDocKeyRef.current = currentDocKey;
    setInSelection(true);
    setSelectionLostByDocChange(false);
    setSelectionRange(captured);
  }, [captureSelectionRange, currentDocKey]);

  // 切文件 / 切模式：旧快照必然错位（那时是另一个文档的坐标），立即丢弃并提示重新选取
  const [selectionLostByDocChange, setSelectionLostByDocChange] = useState(false);
  useEffect(() => {
    if (!selectionDocKeyRef.current || selectionDocKeyRef.current === currentDocKey) return;
    selectionDocKeyRef.current = currentDocKey;
    if (inSelection) {
      setSelectionRange(null);
      // 提示文案区别于「从没选过」：用户刚才明明选过，是切文档导致失效，要说清原因
      setSelectionLostByDocChange(true);
    }
  }, [currentDocKey, inSelection]);

  /**
   * v0.14.0 需求4：跨文件批量替换的结果提示（「已替换 N 个文件」）。
   *
   * 为什么需要提示：跨文件替换改的是**未激活的标签**，用户在当前文档里可能
   * 一处命中都看不到（他的命中都在别的文件），没有提示就会以为"点了没反应"。
   */
  const [crossFileReplaceHint, setCrossFileReplaceHint] = useState("");
  // 就地跳转失败的一次性提示（条幅点击落到无法定位的位置时给出可见反馈，而不是静默无反应）
  const [jumpFailed, setJumpFailed] = useState(false);
  const jumpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * v0.15.1 需求4：**跳转目标的延迟兑现**。
   *
   * 场景：工作区命中的文件常常**还没打开**。点击 → App 打开文件（异步：读盘 → 派发
   * `lightmd:openFile` → 建标签 → 换 docKey）→ 本面板的 docKey effect 消费 pending。
   * 但那一刻目标文档的**文本还没灌进编辑器**（EditorContainer 的 effect 后一步才做），
   * 于是用当前文本算出的落点必然算错；等文本就绪、`performSearch` 重算匹配时，
   * 它又按"高亮第一处"把位置覆盖掉 —— 用户看到的是"文件打开了但停在开头"。
   *
   * 解法：把**目标本身**（query + occurrence，跨文本空间稳定的口径）暂存在这里，
   * `performSearch` 每次算完匹配后优先兑现它（一次即清）。为什么存目标而不存偏移：
   * 偏移是"某一版文本"的坐标，文本换了就作废；occurrence 在新文本空间里可重算。
   * `key` 存目标文档的归一化键：换到**别的**文档时必须作废，否则会把上一个文件的
   * 跳转套到新文本上（跳错比不跳更糟）。
   */
  const pendingJumpRef = useRef<{ key: string; target: SearchJumpTarget } | null>(null);
  /**
   * v0.15.1 需求4 续修：**本次就地跳转要用的「逐处全文偏移」**（临时，用完即清）。
   *
   * 为什么需要：条幅是一行一条，同一行 4 处命中只产生**一条**结果，
   * 行的 `line`/`column` 只描述首处。用户点行内第 2/3/4 个 `<mark>` 时要落到那一处，
   * 唯一精确的坐标是 `SearchFileResult.hitOffsets[hitIndex]`。
   * 它只对「算条幅时那份文本」有效（文本动过就作废，调用方会先校验
   * `matchesTextRef === 当前文本` 再赋值，这里不再重复判断）。
   */
  const pendingHitOffsetsRef = useRef<number[] | null>(null);
  /**
   * `currentMatch` 的**同步**镜像（1 基；0 = 无当前项）。
   *
   * 为什么需要：`performSearch` 会被多条通道延迟重跑（换文档 effect 的双 rAF + 160ms 兜底、
   * MutationObserver 的 150ms 防抖、替换后的 50ms 重算），而这些重跑发生在**用户点了
   * 某处结果之后**。若结尾无条件 `setCurrentMatch(1)`，刚定位好的位置会被瞬间拽回第 1 处
   * （实测：点第 2 个 `<mark>` → 2/4，几十毫秒后变回 1/4 —— 这正是"每一处都跳到第一个"
   * 的另一半成因）。用 ref 读权威值才能在延迟重跑里保住它。
   */
  const currentMatchRef = useRef(0);
  /**
   * `matchesRef` 对应的文本快照（见下方"匹配集是否已跟上当前文本"的判定）。
   * `null` = 还没算过任何匹配（等价于"不一致"）。
   */
  const matchesTextRef = useRef<string | null>(null);
  /**
   * `docKey` 的**同步**镜像：`performSearch` 的依赖里没有 docKey（它只依赖文本来源），
   * 而兑现 pending 落点时要判断"这条落点是不是当前文档的"。用 ref 读权威值，
   * 避免闭包拿到上一次渲染的 docKey。
   */
  const docKeyRef = useRef<string | undefined>(docKey);
  docKeyRef.current = docKey;
  useEffect(() => () => {
    if (jumpTimerRef.current) clearTimeout(jumpTimerRef.current);
  }, []);

  /**
   * 本次搜索/替换使用的选项（唯一真源）。
   *
   * 范围规则：勾选「选取范围内」但没取到快照时传 `EMPTY_RANGE`（{0,0}），
   * 而 findMatchRangesEx 要求匹配**完全落在**范围内 → 任何非零长匹配都不会命中 → 匹配数 0。
   */
  const searchOptions = useMemo<SearchOptions>(() => ({
    caseSensitive,
    useRegex,
    wholeWord,
    range: inSelection ? selectionRange ?? EMPTY_RANGE : null,
  }), [caseSensitive, useRegex, wholeWord, inSelection, selectionRange]);

  // ─── v0.15.1 需求5：全部命中同时高亮 + 当前项醒目色 ─────────────────────
  /**
   * 命中数超过 `MAX_HIGHLIGHT_MATCHES` 时为 true → 计数处显示可见提示。
   * **绝不静默截断**：用户必须知道"屏幕上没有全部标出来"是性能取舍，而不是没搜到。
   */
  const [highlightTruncated, setHighlightTruncated] = useState(false);

  /**
   * 清掉与高亮有关的**本地缓存与 overlay**（不 dispatch 任何事务）。
   *
   * 与 `clearHighlights` 分开的理由：`performSearch` 的空搜索词分支里要自己 dispatch
   * 那两条 meta（保持既有代码形状与 v0.3.5 的结构断言），这里只负责"我们自己记的东西"。
   */
  const clearHighlightRefs = useCallback(() => {
    pmRangesRef.current = null;
    sourceHighlightRangesRef.current = [];
    const overlay = sourceOverlayRef.current;
    if (overlay) overlay.innerHTML = "";
    setHighlightTruncated(false);
  }, []);

  /**
   * 按当前缓存（`sourceHighlightRangesRef` + `matchesTextRef`）重绘 overlay 的**当前项**。
   *
   * 只改"哪一处用醒目色"，不重算匹配、不重建整个区间表 —— ↑/↓ 每次点击只走这一条，
   * 成本是 O(命中数) 的字符串拼接 + 一次 innerHTML，与"点一次扫全文"完全不同量级。
   */
  const paintSourceOverlay = useCallback((current: number) => {
    const ta = sourceTextareaRef?.current;
    const overlay = sourceOverlayRef.current;
    if (!ta || !overlay || !overlay.isConnected) return;
    const ranges = sourceHighlightRangesRef.current;
    if (ranges.length === 0) {
      overlay.innerHTML = "";
      return;
    }
    const text = matchesTextRef.current ?? ta.value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    overlay.innerHTML = buildSearchOverlayHtml(text, ranges, current);
    overlay.scrollTop = ta.scrollTop;
  }, [sourceTextareaRef]);

  /**
   * v0.15.1 需求5：源码模式（textarea）搜索高亮的 **overlay 渲染**。
   *
   * ## 为什么源码模式必须用 overlay 而不是 Decoration
   * textarea 是单元素纯文本控件，内部文字不是 DOM 文本节点，既挂不上 PM 的
   * `Decoration`，也没法用 `<mark>` 包裹。唯一可行做法：在 textarea 之上叠一层与它
   * 排版度量**完全同构**的 div（复刻全文、文字透明，只给命中区间上底色）。
   * 这正是项目里 `source-ghost-overlay` 已验证的手法：`syncTextareaMetrics` 同步
   * 字体/行高/内边距/宽高，`scrollTop` 跟随，视觉上等价于"高亮了 textarea 里的字"。
   *
   * ## 为什么懒创建、挂在 textarea 的父元素上
   * 本组件的写入范围不含 EditorContainer，所以不能在它的 JSX 里加节点；
   * 只能在首次需要时往 `.source-editor-wrapper` 里 append 一个绝对定位层。
   * overlay 只承载"底色"，`pointer-events: none`（见 CSS），不影响 textarea 交互。
   *
   * @param text 计算匹配用的**归一化文本**（与 ranges 同一坐标空间）
   * @param ranges 命中区间（已按上限截断）
   * @param current 当前项在 `ranges` 里的下标（-1 = 无）
   */
  const renderSourceSearchOverlay = useCallback((
    text: string,
    ranges: ReadonlyArray<MatchRange>,
    current: number,
  ) => {
    const ta = sourceTextareaRef?.current;
    const wrapper = ta?.parentElement;
    if (!ta || !wrapper) return;
    let overlay = sourceOverlayRef.current;
    if (!overlay || !overlay.isConnected || overlay.parentElement !== wrapper) {
      overlay = document.createElement("div");
      overlay.className = SOURCE_SEARCH_OVERLAY_CLASS;
      overlay.setAttribute("aria-hidden", "true");
      wrapper.appendChild(overlay);
      sourceOverlayRef.current = overlay;
    }
    // 排版度量与 textarea 完全对齐（否则底色会和文字错位）。
    // 只在"宽度变了"时重算：`syncTextareaMetrics` 内部要读 `getComputedStyle`，
    // 那是强制样式重算，源码模式下每敲一个字符都会走到这里，不能无条件跑。
    // 宽度是这里唯一会随窗口/分屏比例/滚动条出现而变的量，用它做变更闸门即可。
    if (overlay.dataset.mw !== String(ta.clientWidth)) {
      syncTextareaMetrics(ta, overlay);
      overlay.dataset.mw = String(ta.clientWidth);
    }
    overlay.innerHTML = buildSearchOverlayHtml(text, ranges, current);
    // 与 textarea 同步滚动（textarea 自己滚动时由下面的 scroll 监听同步）
    overlay.scrollTop = ta.scrollTop;
  }, [sourceTextareaRef]);

  /**
   * v0.15.1 需求5：**一算出匹配就推全部命中**（PM 两层 Decoration / 源码 overlay）。
   *
   * 两层设计见 `core/editor.ts` 的 `searchMatchesKey` 注释：
   * 全部命中进 `searchMatchesKey`（class `search-match`），当前项进 `searchHighlightKey`
   * （class `search-match-current`）。两层是**两个插件**，互不覆盖。
   *
   * 性能：
   * - PM 路径的文本偏移 → PM 位置映射结果缓存进 `pmRangesRef`，↑/↓ 时不再重算；
   * - 一次 `DecorationSet.create` 建最多 `MAX_HIGHLIGHT_MATCHES` 个 inline deco；
   * - 超限只截前 N 处，但**保留当前项**（否则点了"下一个"看不到醒目色）。
   *
   * @param currentIdx 当前项在 `matchesRef.current` 里的下标（-1 = 无当前项）
   */
  const pushHighlights = useCallback((currentIdx: number) => {
    const matches = matchesRef.current;
    if (matches.length === 0) {
      clearHighlightRefs();
      if (editorView) {
        try {
          const tr = editorView.state.tr;
          tr.setMeta(searchHighlightKey, null);
          tr.setMeta(searchMatchesKey, null);
          editorView.dispatch(tr);
        } catch { /* 视图可能已销毁 */ }
      }
      return;
    }

    setHighlightTruncated(matches.length > MAX_HIGHLIGHT_MATCHES);

    // ── 源码模式：overlay ──
    if (isSourceMode || !editorView) {
      const text = matchesTextRef.current
        ?? (sourceContent || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const kept = matches.slice(0, MAX_HIGHLIGHT_MATCHES);
      let current = currentIdx;
      if (current < 0 || current >= kept.length) {
        // 当前项落在截断之外：替换进最后一处，保证"当前项颜色"一定可见
        const cur = matches[Math.max(0, Math.min(currentIdx, matches.length - 1))];
        if (cur && kept.length > 0) {
          kept[kept.length - 1] = cur;
          current = kept.length - 1;
        } else {
          current = kept.length > 0 ? 0 : -1;
        }
      }
      sourceHighlightRangesRef.current = kept;
      renderSourceSearchOverlay(text, kept, current);
      return;
    }

    // ── 阅读模式：两层 Decoration ──
    const doc = editorView.state.doc;
    const map = offsetMapRef.current ?? buildOffsetMap(doc);
    offsetMapRef.current = map;
    const mapped = mapRangesToPm(map.blocks, matches, doc.content.size);
    pmRangesRef.current = { doc, ranges: mapped.ranges, currentOf: mapped.currentOf };
    // 截断/跳过项会让"匹配下标"与"PM 区间下标"错位，必须经 currentOf 换算
    const currentInPm = mapped.currentOf.get(currentIdx) ?? -1;
    const built = buildHighlightPayload(mapped.ranges, currentInPm);
    try {
      const tr = editorView.state.tr;
      tr.setMeta(searchMatchesKey, built.payload);
      tr.setMeta(searchHighlightKey, built.payload);
      editorView.dispatch(tr);
    } catch { /* 视图可能已销毁 */ }
  }, [clearHighlightRefs, editorView, isSourceMode, sourceContent, renderSourceSearchOverlay]);

  /**
   * 彻底清除高亮（两层 Decoration + 源码 overlay + 本地缓存）。
   * 用在：卸载、关闭搜索、清空搜索词、换文档。
   */
  const clearHighlights = useCallback(() => {
    clearHighlightRefs();
    if (editorView) {
      try {
        const tr = editorView.state.tr;
        tr.setMeta(searchHighlightKey, null);
        tr.setMeta(searchMatchesKey, null);
        editorView.dispatch(tr);
      } catch { /* 视图可能已销毁 */ }
    }
  }, [clearHighlightRefs, editorView]);

  /** `renderSourceSearchOverlay` 的稳定引用（给 scroll/resize effect 用，避免重复绑监听） */
  const renderSourceSearchOverlayRef = useRef<typeof renderSourceSearchOverlay | null>(null);
  renderSourceSearchOverlayRef.current = renderSourceSearchOverlay;

  /**
   * overlay 与 textarea 的滚动 / 尺寸同步。
   *
   * 不同步的后果：
   * - 滚动：用户滚动 textarea 时底色留在原处 → 整篇"错行高亮"，比没有高亮更糟；
   * - 尺寸：窗口缩放或分屏比例变化后 overall 换行位置与 textarea 不一致 → 底色错位。
   *   `renderSourceSearchOverlay` 里按 `clientWidth` 做了闸门，这里把闸门清掉再重绘一次即可。
   *
   * 监听 `scroll` 必须绑在元素上（textarea 的滚动不冒泡到 window）。
   */
  useEffect(() => {
    const ta = sourceTextareaRef?.current;
    if (!ta) return;
    const syncScroll = () => {
      const overlay = sourceOverlayRef.current;
      if (overlay && overlay.isConnected) overlay.scrollTop = ta.scrollTop;
    };
    const syncResize = () => {
      const overlay = sourceOverlayRef.current;
      const ranges = sourceHighlightRangesRef.current;
      if (!overlay || !overlay.isConnected || ranges.length === 0) return;
      // 当前项下标：从 overlay 里已有的醒目 mark 反推，省掉一份重复状态
      const marks = Array.from(overlay.querySelectorAll("mark"));
      const cur = marks.findIndex((m) => m.classList.contains(SEARCH_MATCH_CURRENT_CLASS));
      const text = matchesTextRef.current ?? ta.value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      if (overlay.dataset) overlay.dataset.mw = "";
      renderSourceSearchOverlayRef.current?.(text, ranges, cur);
    };
    ta.addEventListener("scroll", syncScroll, { passive: true });
    window.addEventListener("resize", syncResize);
    return () => {
      ta.removeEventListener("scroll", syncScroll);
      window.removeEventListener("resize", syncResize);
    };
  }, [sourceTextareaRef, isSourceMode]);

  // 搜索
  const performSearch = useCallback(() => {
    if (!searchText) {
      setMatchCount(0);
      setCurrentMatch(0);
      currentMatchRef.current = 0;
      matchesRef.current = [];
      matchesTextRef.current = null;
      // v0.15.1 需求5：清空搜索词 → 两层 Decoration + overlay + 本地缓存全部清干净
      clearHighlightRefs();
      // 问题1修复：清除 ProseMirror 中的搜索高亮 Decoration
      if (editorView && !isSourceMode) {
        const tr = editorView.state.tr;
        tr.setMeta(searchHighlightKey, null);
        tr.setMeta(searchMatchesKey, null);
        editorView.dispatch(tr);
      }
      // v0.4.3 Issue 3：清除非 md 文件阅读模式的选区高亮
      if (!isMdFile && viewMode === "preview") {
        window.getSelection()?.removeAllRanges();
      }
      return;
    }

    let text: string;
    if (isSourceMode) {
      // v0.4.4 修复：规范化换行符 \r\n → \n。
      // textarea.value 和 DOM 文本都会将 \r\n 规范化为 \n，
      // 如果 sourceContent 含 \r\n，findMatches 返回的位置会偏移，导致高亮选中错误内容。
      text = (sourceContent || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      offsetMapRef.current = null;
    } else if (editorView) {
      // 问题2修复：使用 buildOffsetMap 同时构建 text 和 blocks，保证偏移一致
      const map = buildOffsetMap(editorView.state.doc);
      offsetMapRef.current = map;
      text = map.text;
    } else {
      text = "";
    }

    // v0.14.0：统一走 findMatchRangesEx —— 全词/大小写/正则/范围四个约束一次性生效
    const ranges = findMatchRangesEx(text, searchText, searchOptions);
    setRegexInvalid(ranges === null);
    const matches = ranges || [];

    // 上一批匹配对应的文本（在覆盖 `matchesTextRef` **之前**取，用于下面判断"文本有没有变"）
    const prevText = matchesTextRef.current;
    matchesRef.current = matches;
    // 记录这批匹配对应的文本（跨文件跳转的接收端据此判断"匹配集是否已跟上当前文本"）
    matchesTextRef.current = text;
    setMatchCount(matches.length);
    // v0.15.1 需求5：匹配集换了 → PM 区间缓存必须作废（坐标属于上一版文本/上一批匹配）
    pmRangesRef.current = null;
    // 记录这批匹配基于哪一版 doc（highlightMatch 的过期闸门，见 matchesDocRef 注释）
    matchesDocRef.current = editorView ? editorView.state.doc : null;

    // v0.15.1 需求5：若有一条「刚打开文件 / 刚切过来」的跳转目标待兑现，优先落到它上面。
    //
    // 为什么放在这里：跳转接收端消费 pending 时，目标文档的文本/匹配集往往还没就绪，
    // 落点算不出来；本函数是"匹配集刷新"的唯一出口，在这里用 occurrence 在新文本空间
    // 重算落点，才能保证用户看到的最终位置正确。
    // 一次性消费（取完即清）：用户随后手动"下一个/上一个"不应被它拽回。
    // 文档键不一致时**直接丢弃**：换到别的文档了，旧目标毫无意义。
    //
    // ⚠️ 这条兜底路径只走 **occurrence**（跨文本空间稳定），不走 `hitOffsets`
    // （逐处偏移属于"算条幅时那份文本"的坐标，此刻文本已换新，用它会跳到错位置）。
    // 行内第几处由 `jumpOccurrenceOf` 把 `occurrence + hitIndex` 合成全局序号来体现。
    const pendingJump = pendingJumpRef.current;
    if (pendingJump !== null) {
      pendingJumpRef.current = null;
      pendingHitOffsetsRef.current = null;
      if (sameJumpKey(pendingJump.key, docKeyRef.current)) {
        const offset = resolveJumpByOccurrence(
          text,
          pendingJump.target.query,
          jumpOccurrenceOf(pendingJump.target),
          { caseSensitive, useRegex, wholeWord },
        );
        let pendingIdx =
          offset === null ? -1 : matches.findIndex((m) => offset >= m.start && offset < m.end);
        if (pendingIdx < 0 && offset !== null) {
          pendingIdx = matches.findIndex((m) => m.start >= offset);
        }
        if (pendingIdx >= 0) {
          setCurrentMatch(pendingIdx + 1);
          currentMatchRef.current = pendingIdx + 1;
          // 全部命中一次推完（含 pending 落点作为"当前项"）
          pushHighlights(pendingIdx);
          highlightMatch(pendingIdx);
          setJumpFailed(false);
          return;
        }
        // 落点在新文本空间里找不到（内容已变 / 关键词消失）：明确提示，不假装成功
        setJumpFailed(true);
        if (jumpTimerRef.current) clearTimeout(jumpTimerRef.current);
        jumpTimerRef.current = setTimeout(() => setJumpFailed(false), 2000);
        return;
      }
    }

    /**
     * v0.15.1 需求4 续修：**保住用户刚点选的那一处**。
     *
     * 为什么必须做：面板里有多条"重搜"通道（换文档 effect 的双 rAF + 160ms 兜底、
     * MutationObserver 的 150ms 防抖、替换后的 50ms 重算）。用户点了第 2 处结果后，
     * 这些通道随时可能再跑一次 `performSearch` —— 旧实现在结尾无条件
     * `setCurrentMatch(1)` + `highlightMatch(0)`，于是**刚定位好的第 2 处被瞬间拽回第 1 处**。
     * 实测（探针）：点第 2 个 `<mark>` 后计数同步变 2/4，几十毫秒后被重置回 1/4
     * —— 这就是用户报告的「每一处都跳到第一个搜索」在"重搜覆盖"这一侧的成因。
     *
     * 判定条件（三者同时满足才保留）：
     * 1. 文本没变（`matchesTextRef` 上一版文本 === 本版文本）：匹配集仍是同一批，
     *    下标才有意义；换文档/内容被改时必须回到第 1 处。
     * 2. 上一版有当前项（`currentMatchRef >= 1`）。
     * 3. 下标没越界。
     */
    const prevCurrent = currentMatchRef.current;
    const sameTextAsBefore = prevText === text;
    const keepIdx =
      sameTextAsBefore && prevCurrent >= 1 && prevCurrent <= matches.length ? prevCurrent - 1 : 0;
    setCurrentMatch(matches.length > 0 ? keepIdx + 1 : 0);
    currentMatchRef.current = matches.length > 0 ? keepIdx + 1 : 0;

    // v0.15.1 需求5：**搜索一出结果就整篇标出所有命中**（用户不用点 ↑/↓），
    // 当前项以醒目色单独标注。旧实现在这里只 highlightMatch(0)，所以只有 1 处高亮。
    pushHighlights(keepIdx);
    if (matches.length > 0) {
      highlightMatch(keepIdx);
    }
  }, [searchText, searchOptions, isSourceMode, sourceContent, editorView, isMdFile, viewMode, pushHighlights, clearHighlightRefs]);
  // ⚠️ 依赖里**不能**写 `highlightMatch`：它在本函数之后才用 `useCallback` 定义，
  // 而依赖数组在渲染期就被求值 → 会命中 const 的 TDZ。保持与旧实现一致（不列入依赖），
  // 语义上它读的都是 ref，列入与否不影响行为。

  // 搜索文本变化时自动搜索
  useEffect(() => {
    performSearch();
  }, [performSearch]);

  /**
   * v0.14.0 需求5：「换文档后立即在新文档上重新搜索」的**最新闭包引用**。
   *
   * 为什么必须有这个 ref（实测踩到的坑，务必保留注释）：
   * 下面的换文档 effect 只依赖 `[docKey, contentVersion, searchText]`，而换文档时
   * `sourceContent` / `editorView.state.doc` 这些**真正装着文本**的东西是在
   * EditorContainer 的 effect 里后一步才更新的。于是：
   * - 首次渲染（docKey 已变、文本还是旧的）里创建的定时器会捕获**旧的**
   *   `performSearch`（搜旧文本 → 无结果）；
   * - 等文本更新后 `performSearch` 换了新身份，但换文档 effect 的依赖没变
   *   → **不会重跑、也不会 cleanup** → 那个旧定时器照常在 120ms 后触发，
   *   把刚算对的匹配数**覆盖回"无结果"**。
   * 实机复现：文档 A 搜「李四」无结果 → 切到含「李四」的表格文档 → 仍显示"无结果"。
   *
   * 解法：所有延迟执行一律走 `performSearchRef.current()`，永远用**最新**闭包。
   */
  const performSearchRef = useRef(performSearch);
  performSearchRef.current = performSearch;
  /**
   * v0.14.0 需求5：换文档重搜的「世代序号」。
   *
   * 连续快速切多个标签时，每次换文档都会排一组 rAF/定时器。用单调序号让
   * **只有最后一次**生效（过期的回调直接 return），避免"最后一个标签的结果
   * 被前一个标签的迟到回调覆盖"（与 ② 的旧闭包问题同源，但这条防的是抖动）。
   */
  const docChangeSeqRef = useRef(0);

  /**
   * v0.14.0 需求2（续修）：**阅读模式下「内容本身」变化时也要重新搜索**。
   *
   * ## 缺陷（实测取证见 src/__tests__/v0140-search-undo-refresh.test.tsx）
   * 用户动作链：搜索 → 替换 → Ctrl+Z。内容确实恢复了，但搜索框停在替换后的结果上
   * （`cat dog cat` 替换掉第一处 cat 后是 1/1，撤销回来应该是 1/2，实测一直显示 1/1；
   *  高亮 Decoration 也被映射到错位的词上，点「下一个」定位到错误位置）。
   *
   * ## 根因
   * `performSearch` 的依赖是
   * `[searchText, searchOptions, isSourceMode, sourceContent, editorView, isMdFile, viewMode]`，
   * 而阅读模式下的替换与撤销**只改 `editorView.state.doc`**：
   * - `editorView` 永远是同一个对象（视图从不重建）；
   * - `sourceContent`（源码侧 state）在阅读模式**不同步**（只在编辑模式/换文档时更新）；
   * → 依赖一个都没变 → effect 不重跑 → `matchesRef` / `offsetMapRef` 仍是**旧文档的坐标**，
   *   于是匹配数、高亮位置、上下跳转全部错位。
   * 宿主传的 `contentVersion`（forceUpdateKey）只在**换文档**时 +1，撤销不会让它变，
   * 所以靠它也不成立（见上面「换文档重搜」effect 的注释，那是另一件事）。
   *
   * ## 为什么用 MutationObserver，而不是包 `editorView.dispatch`
   * Outline.tsx 已经在包 `editorView.dispatch`，并在卸载时把 `originalDispatch` 装回去；
   * 两处互相覆盖会让「面板开着时侧边栏开关一次」就静默丢掉监听（撤销后搜索框再次失效）。
   * 观察 DOM 与其它组件完全解耦。**用 doc 身份做闸门**是关键：我们自己的高亮 Decoration
   * 事务只改 meta 不改 doc，因此不会自激成环（每次 DOM 抖动都会进 check，但只在
   * doc 换了对象时才真的重算）。
   *
   * ## 性能：doc 变化触发的重搜要**短防抖**（150ms），不能每帧全量重扫
   * 阅读模式下用户连续打字，每一击都是一个新 doc 对象；若每次都立刻跑 `performSearch`
   * （O(全文) 正则扫描，几 MB 文档每帧数 ms），就会变成稳定的输入卡顿。
   * 因此观察器只负责「排一个 150ms 防抖」，连续输入被合并成一次；
   * 用户停手 150ms 后计数/高亮刷新一次 —— 肉眼无感，且不再占输入帧。
   * 替换/全部替换这类**离散操作**不走这条防抖（它们各自 50ms 后直接重算，
   * 见 `runContentResync`），撤销/恢复则走防抖（150ms 后刷新，同样无感）。
   *
   * 延迟执行一律走 `performSearchRef.current()`：永远用最新闭包（搜索词/选项可能刚变过）。
   */
  const lastSeenDocRef = useRef<PMNode | null>(null);
  /** doc 变化重搜的防抖定时器（连续输入合并用；与替换路径的 50ms 定时器互不干扰） */
  const docResyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * 立刻按当前内容重算一次搜索，并把「已见 doc」闸门推到最新。
   *
   * 为什么闸门要在这里推：替换路径自己也会重算（50ms 后），若不同步闸门，
   * 观察器的防抖定时器还会再触发一次重复搜索。推完闸门后那次触发会命中
   * `doc === lastSeenDocRef` 而直接 return。
   */
  const runContentResync = useCallback(() => {
    const view = editorView;
    if (view) lastSeenDocRef.current = view.state.doc;
    performSearchRef.current();
  }, [editorView]);

  useEffect(() => {
    const view = editorView;
    if (!view || isSourceMode) return;
    lastSeenDocRef.current = view.state.doc;
    const check = () => {
      docResyncTimerRef.current = null;
      if (view.state.doc === lastSeenDocRef.current) return;
      lastSeenDocRef.current = view.state.doc;
      performSearchRef.current();
    };
    // MutationObserver 回调本身是微任务；这里再防抖 150ms 把连续输入合并成一次重扫。
    const schedule = () => {
      if (docResyncTimerRef.current) clearTimeout(docResyncTimerRef.current);
      docResyncTimerRef.current = setTimeout(check, CONTENT_RESYNC_DEBOUNCE_MS);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(view.dom, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (docResyncTimerRef.current) {
        clearTimeout(docResyncTimerRef.current);
        docResyncTimerRef.current = null;
      }
    };
  }, [editorView, isSourceMode]);

  // 高亮匹配位置
  const highlightMatch = useCallback((index: number) => {
    if (matchesRef.current.length === 0) return;

    // v0.4.3 Issue 3：非 md 文件阅读模式下 textarea 隐藏（display:none），
    // 需要在 .plaintext-preview 容器中通过 Range 选区高亮匹配文本
    if (!isMdFile && viewMode === "preview") {
      // v0.15.1 需求5 取舍：非 md 阅读面是 Prism 渲染的 HTML，既没有 PM Decoration
      // 也没有 textarea overlay 可挂（改它的 DOM 会破坏 Prism 结构），因此这里
      // **保持现状**（仅用 Range 选区标出当前项）。详见任务报告里的取舍说明。
      const previewEl = document.querySelector(".plaintext-preview");
      if (!previewEl) return;
      const range = matchesRef.current[index];
      const pos = range.start;
      // R4：正则匹配长度可变，按区间计算终点
      const endPos = range.end;
      // TreeWalker 遍历文本节点，定位匹配的起止位置（PrismJS 高亮后文本被分散在多个 span 中）
      const walker = document.createTreeWalker(previewEl, NodeFilter.SHOW_TEXT);
      let charCount = 0;
      let startNode: Text | null = null;
      let startOffset = 0;
      let endNode: Text | null = null;
      let endOffset = 0;
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        const nodeLen = node.nodeValue?.length || 0;
        if (!startNode && charCount + nodeLen > pos) {
          startNode = node;
          startOffset = Math.max(0, pos - charCount);
        }
        if (charCount + nodeLen >= endPos) {
          endNode = node;
          endOffset = Math.max(0, endPos - charCount);
          break;
        }
        charCount += nodeLen;
      }
      if (startNode && endNode) {
        const range = document.createRange();
        range.setStart(startNode, startOffset);
        range.setEnd(endNode, endOffset);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        // 滚动到匹配位置（居中显示）
        const rect = range.getBoundingClientRect();
        const containerRect = previewEl.getBoundingClientRect();
        const targetTop = rect.top - containerRect.top + previewEl.scrollTop - containerRect.height / 2;
        previewEl.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
      }
      return;
    }

    if (isSourceMode && sourceTextareaRef?.current) {
      const textarea = sourceTextareaRef.current;
      // R4：按区间选区（正则匹配长度可变）
      const range = matchesRef.current[index];
      const pos = range.start;
      // Issue 6：非 md 文件在 preview 模式下 textarea 隐藏（display:none），
      // offsetParent === null 表示不可见，此时跳过视觉高亮（仅显示匹配计数）
      if (textarea.offsetParent === null) return;
      textarea.focus();
      textarea.setSelectionRange(pos, range.end);
      // 滚动到匹配位置
      const lines = textarea.value.substring(0, pos).split("\n");
      const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 20;
      textarea.scrollTop = (lines.length - 1) * lineHeight;
      // v0.15.1 需求5：源码模式的"当前项醒目色"在 overlay 里，随当前项一起挪。
      // 这里不重建全量（全量只在 performSearch 时建），只改"哪一处用醒目色"。
      const kept = sourceHighlightRangesRef.current;
      const cur = kept.findIndex((r) => r.start === range.start && r.end === range.end);
      if (cur >= 0) paintSourceOverlay(cur);
    } else if (editorView) {
      // ProseMirror 模式下，使用 offsetMapRef 中的 blocks 映射位置
      try {
        const offsetMap = offsetMapRef.current;
        if (!offsetMap) return;
        // v0.15.1 需求5 过期闸门：`matchesRef`/`offsetMapRef` 是**某一版 doc 的坐标**。
        // 用户在阅读模式里打字后 doc 立刻变了，而重算搜索走 150ms 防抖 —— 这段窗口里
        // 点 ↑/↓ 若照旧把偏移套到新 doc 上，就会把醒目色框到**别的词**上（实测：
        // "cat dog cat" 前面插一个 cat 后点「下一个」，"dog" 被框成当前项）。
        // 宁可这一帧不上色（等防抖重搜），也不框错词。
        if (matchesDocRef.current !== editorView.state.doc) return;
        const range = matchesRef.current[index];

        // v0.15.1 需求5：优先用 performSearch 缓存好的 PM 区间（含下标换算），
        // 缓存缺失（或被文档身份闸门判定过期）时才现算一份（等价于旧行为）。
        // 两条路径用**同一个** mapRangesToPm，保证"当前项"与"全部命中"落在完全相同的字符上。
        //
        // 文档身份闸门：PM 位置是**某一版 doc 的坐标**。用户打字/撤销后 doc 换了对象，
        // 而 performSearch 走 150ms 防抖还没跑完 —— 此时沿用旧缓存会把醒目色框到错字上。
        let cached = pmRangesRef.current;
        if (!cached || cached.doc !== editorView.state.doc) {
          const mapped = mapRangesToPm(
            offsetMap.blocks,
            matchesRef.current,
            editorView.state.doc.content.size,
          );
          cached = { doc: editorView.state.doc, ranges: mapped.ranges, currentOf: mapped.currentOf };
          pmRangesRef.current = cached;
        }
        // `pmStart`/`pmEnd` 沿用旧命名（v0.3.4 的结构断言按 `view.coordsAtPos(pmStart)`
        // 锁定"手动滚动到匹配位置"这一行为，改名会让那条防回退用例失效）
        const pmIdx = cached.currentOf.get(index);
        const pmRange = pmIdx === undefined ? undefined : cached.ranges[pmIdx];
        const pmStart = pmRange?.from ?? lookupPmPos(offsetMap.blocks, range.start) ?? -1;
        if (pmRange === undefined && pmStart < 0) return;
        const pmEndOffset = lookupPmPos(offsetMap.blocks, range.end - 1);
        const endPos = pmRange?.to
          ?? (pmEndOffset === undefined ? undefined : Math.min(pmEndOffset + 1, editorView.state.doc.content.size));
        const resolvedStart = pmRange?.from ?? pmStart;

        if (endPos !== undefined && resolvedStart >= 0 && endPos > resolvedStart) {
          // v0.15.1 需求5：只把**全部命中 + 当前项**的 payload 重推一次，
          // 切当前项就是改 `current` 字段（不改 doc、不动全部命中那一层）。
          //
          // `pmIdx === undefined` 的情形：这条命中在 PM 空间里被跳过了（起点/终点
          // 落在块间隙，例如跨段落的命中）。此时不能让它把"当前项"退回第 0 处
          // （用户点"下一个"却发现醒目色跑回开头）—— 把这条单独补到末尾作为当前项。
          let payload: { ranges: SearchHighlightRange[]; current: number };
          if (pmIdx === undefined) {
            payload = {
              ranges: [...cached.ranges, { from: resolvedStart, to: endPos }],
              current: cached.ranges.length,
            };
          } else {
            payload = buildHighlightPayload(cached.ranges, pmIdx).payload;
          }
          const tr = editorView.state.tr;
          tr.setMeta(searchHighlightKey, payload);
          tr.setMeta(searchMatchesKey, payload);
          tr.scrollIntoView();
          editorView.dispatch(tr);

          // 阅读模式下 handleScrollToSelection 返回 true 会阻止自动滚动
          // 手动滚动到匹配位置（使用 editor-container 作为滚动容器）
          const view = editorView;
          requestAnimationFrame(() => {
            try {
              const coords = view.coordsAtPos(pmStart);
              const scrollContainer = view.dom.parentElement as HTMLElement | null;
              if (scrollContainer) {
                const containerRect = scrollContainer.getBoundingClientRect();
                // 计算目标滚动位置，让匹配位置出现在容器中部
                const targetTop = coords.top - containerRect.top + scrollContainer.scrollTop - containerRect.height / 2;
                scrollContainer.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
              }
            } catch {
              // 忽略滚动错误
            }
          });
        }
      } catch {
        // 忽略位置计算错误
      }
    }
  }, [isSourceMode, sourceTextareaRef, editorView, isMdFile, viewMode, paintSourceOverlay]);

  // 上一个/下一个
  const goToMatch = useCallback((direction: 1 | -1) => {
    if (matchesRef.current.length === 0) return;
    const newIdx = currentMatch - 1 + direction;
    const wrapped = ((newIdx % matchesRef.current.length) + matchesRef.current.length) % matchesRef.current.length;
    setCurrentMatch(wrapped + 1);
    // 同步镜像：延迟重搜据此保住用户的位置（见 currentMatchRef 注释）
    currentMatchRef.current = wrapped + 1;
    highlightMatch(wrapped);
  }, [currentMatch, highlightMatch]);

  // 替换当前
  const replaceCurrent = useCallback(() => {
    if (matchesRef.current.length === 0 || currentMatch === 0) return;

    // R4：正则模式下用展开后的替换文本（支持 $1 捕获组）
    // v0.14.0：正则与匹配集合同源（全词/大小写/范围一致），否则会替换到查找结果之外的文本
    const regex = buildSearchRegexEx(searchText, { caseSensitive, useRegex, wholeWord });
    if (!regex) return;
    const range = matchesRef.current[currentMatch - 1];
    // 匹配文本按路径取源：textarea 路径来自 sourceContent，PM 路径来自 offsetMap.text
    // （R4 修复：阅读模式下 sourceContent 为 undefined，不能作为匹配文本来源）
    // v0.14.0：源码模式必须先做换行归一化再切 —— range 是**归一化文本**的坐标，
    // 直接切含 CRLF 的原文会让 $1/$& 匹配到错位的字符。
    const matched = isSourceMode && sourceContent !== undefined
      ? sourceContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n").substring(range.start, range.end)
      : offsetMapRef.current?.text.substring(range.start, range.end) ?? searchText;
    const expanded = expandReplacement(matched, regex, replaceText, useRegex);

    if (isSourceMode && sourceTextareaRef?.current && sourceContent !== undefined && onSourceContentChange) {
      // v0.14.0：命中偏移是「归一化文本」坐标，写回时必须换算回原始串坐标，
      // 否则含 CRLF 的文档每替换一次就错位一格（后面越替换越偏）。
      const rawMap = buildRawOffsetMap(sourceContent);
      const rawStart = rawMap ? rawMap[Math.min(range.start, rawMap.length - 1)] : range.start;
      const rawEnd = rawMap ? rawMap[Math.min(range.end, rawMap.length - 1)] : range.end;
      const newContent = sourceContent.substring(0, rawStart) + expanded + sourceContent.substring(rawEnd);
      onSourceContentChange(newContent);
    } else if (editorView) {
      // 阅读模式：通过 ProseMirror transaction 替换文本
      try {
        const offsetMap = offsetMapRef.current;
        if (!offsetMap) return;

        const pmStart = lookupPmPos(offsetMap.blocks, range.start);
        const pmEnd = lookupPmPos(offsetMap.blocks, range.end - 1);
        if (pmStart !== undefined && pmEnd !== undefined) {
          const endPos = Math.min(pmEnd + 1, editorView.state.doc.content.size);
          const tr = editorView.state.tr.insertText(expanded, pmStart, endPos);
          tr.setMeta("addToHistory", true);
          editorView.dispatch(tr);
        }
      } catch {
        // 忽略替换错误
      }
    }

    // v0.14.0：替换后平移范围快照（不平移的话第二次替换就会越出原选区，用户在范围外的文本被改）
    if (inSelection && selectionRange) {
      setSelectionRange(applyReplacementToRange(selectionRange, range.start, range.end - range.start, expanded.length));
    }

    // 替换后重新搜索
    // v0.14.0 需求2（续修）：**必须走 performSearchRef.current()**，不能用闭包里的
    // `performSearch`。实测（源码模式）：替换 → 宿主 setSourceContent(新内容) → 新的
    // performSearch 先算出 1/1，随后这个 50ms 定时器用**旧闭包**（旧 sourceContent）
    // 再算一次，把结果覆盖回替换前的 1/2（实测替换后 700ms 仍显示 1/2）。
    // 阅读模式之所以侥幸没暴露，只因闭包里读的是 editorView.state.doc 这个活对象；
    // 同一处代码仍是隐患，一并收口。
    // 走 runContentResync 而不是裸 performSearchRef：它顺带把「已见 doc」闸门推到最新，
    // 免得观察器的 150ms 防抖再补一次重复的全量扫描（替换是离散操作，要立刻出结果）。
    setTimeout(() => runContentResync(), 50);
  }, [isSourceMode, sourceTextareaRef, sourceContent, onSourceContentChange, currentMatch, searchText, replaceText, caseSensitive, useRegex, wholeWord, inSelection, selectionRange, editorView, runContentResync]);

  /**
   * 取某个文件的「本轮搜索选项」。
   *
   * 范围（range）只属于**当前文档**：选区快照是当前文档的文本坐标，套到别的文件上
   * 会误杀该文件所有结果（而且毫无意义）。所以只有 fileKey === 当前文档 key 时才传范围。
   */
  const optionsForFile = useCallback((fileKey: string): SearchOptions => {
    const currentKey = docKey ?? FALLBACK_FILE_KEY;
    return {
      caseSensitive,
      useRegex,
      wholeWord,
      range: inSelection ? (fileKey === currentKey ? selectionRange ?? EMPTY_RANGE : null) : null,
    };
  }, [caseSensitive, useRegex, wholeWord, inSelection, selectionRange, docKey]);

  /**
   * 重建条幅结果（同步执行，不做任何 IO）。
   *
   * 数据来源：props.collectFiles()（App 侧提供所有已打开文件 + 实时 getText）；
   * 缺省时退化成「仅当前文档」——保证面板可独立测试，也保证未接线时不崩。
   *
   * 文本空间口径（与 Lead 的接线约定一致，改动前请先对齐）：
   * - 当前文档：优先用 readCurrentText()（阅读模式 = PM 文本、编辑模式 = 源码文本）。
   *   为什么必须走它：`selectionRange` 是当前文档文本空间的偏移，替换/上一个下一个
   *   全部依赖同一空间；用 getText()（源码）来搜当前文档，在阅读模式下会和替换坐标系打架。
   * - 其他文件：用 getText()（App 传的是该标签的 markdown 源码）。
   * - 「选取范围内」勾选时**跳过其他文件**：选区只有当前文档有，把当前文档的文本偏移
   *   套到别的文件上毫无意义，只会把所有结果误杀成 0（用户会以为"别的文件里没有"）。
   */
  const rebuildResults = useCallback(() => {
    if (!searchText) {
      setFileResults([]);
      setResultFileCounts({});
      setResultMatchTotal(0);
      setResultsTruncated(false);
      return;
    }
    const currentKey = docKey ?? FALLBACK_FILE_KEY;
    const currentText = readCurrentText().text;
    const provided = collectFilesRef.current ? collectFilesRef.current() : null;
    const files: SearchableFile[] = provided
      ? provided
      : [
          {
            fileKey: currentKey,
            filePath: "",
            fileName: docKey ? docKey.split(/[\\/]/).pop() ?? docKey : "",
            getText: () => currentText,
          },
        ];

    const results: SearchFileResult[] = [];
    const counts: Record<string, number> = {};
    let total = 0;
    let truncated = false;
    // MAX_FILES 上限：打开上百个标签时全量搜索会卡死 UI（文本可能上百 MB），
    // 超出部分直接不搜，并在汇总里标记「结果过多」让用户收窄条件。
    const limit = Math.min(files.length, MAX_FILES);
    if (files.length > MAX_FILES) truncated = true;
    /**
     * v0.15.1 需求4 续修（症状 3）：**条幅显示的行列必须与右下角状态栏同口径**。
     *
     * `collectFileResults` 的 `line`/`column` 是"对该份文本按 \n 数的行号"，而状态栏在
     * 阅读模式用 PM **逻辑块**口径（`computeDocLine`）。实测差异（本任务探针）：
     * ```
     *   无序列表 3 项含 foo：条幅 2/3/4  vs 状态栏 1/2/3    （差 1）
     *   表格 2 处 foo：      条幅 4/7    vs 状态栏 2/3      （表格被摊成多块）
     * ```
     * 所以对**当前文档且处于阅读模式**的行，额外算一份状态栏口径的 `statusLine/Column`
     * 供显示用；`line`/`column` 继续作为文本空间坐标参与跳转计算（两者含义不同，不能混）。
     *
     * 其他文件没有 PM doc（未在当前视图里），无从换算，只能显示源码行 —— 这与"双击打开后
     * 状态栏显示的是源码行"在切换完成前是一致的，不会出现更糟的错。
     */
    const pmDocForStatus = !isSourceMode && editorView ? editorView.state.doc : null;
    const pmBlocksForStatus = pmDocForStatus ? buildOffsetMap(pmDocForStatus).blocks : null;
    for (let i = 0; i < limit; i++) {
      const f = files[i];
      const isCurrentDoc = f.fileKey === currentKey;
      // 选取范围内只对当前文档成立 → 其他文件整份跳过（见函数头注释）
      if (inSelection && !isCurrentDoc) continue;
      const content = isCurrentDoc ? currentText : f.getText();
      // 当前文档带 range；其他文件 range 恒为 null（optionsForFile 内部已保证）
      const res = collectFileResults(
        content,
        { query: searchText, ...optionsForFile(f.fileKey) },
        { fileKey: f.fileKey, filePath: f.filePath, fileName: f.fileName },
      );
      if (res.truncated) truncated = true;
      if (res.results.length > 0) {
        counts[f.fileKey] = res.matchCount;
        total += res.matchCount;
      }
      for (const r of res.results) {
        if (isCurrentDoc && pmDocForStatus && pmBlocksForStatus) {
          const hitOffset = r.hitOffsets?.[0];
          const stamp =
            hitOffset === undefined
              ? null
              : pmLineColumnOfOffset(pmDocForStatus, pmBlocksForStatus, hitOffset);
          results.push(
            stamp
              ? { ...r, statusLine: stamp.line, statusColumn: stamp.column }
              : r,
          );
          continue;
        }
        results.push(r);
      }
    }
    setFileResults(results);
    setResultFileCounts(counts);
    setResultMatchTotal(total);
    setResultsTruncated(truncated);
  }, [searchText, optionsForFile, docKey, readCurrentText, isSourceMode, editorView]);

  /**
   * v0.14.0 需求4：把「查找所有打开文件」的结果**批量替换到所有命中的文件**。
   *
   * 用户原话：「点击『查找所有打开文件』查找到多个文件上的内容然后进行内容替换，
   * 那么所有查找到的文件的内容都应该可以被替换。」
   *
   * 实现要点（每条都是踩坑点）：
   * 1. **不能只替换当前文档**：条幅里大部分命中在未激活的标签上，它们的内容只存在于
   *    `openTabs[i].content`，必须经宿主提供的 `applyFileText(fileKey, newText)` 写回；
   * 2. **每个文件按自己的文本重算命中**（不复用条幅里的 `ranges`）：条幅是"上次重建
   *    条幅时"的快照，期间用户可能改过字；而且条幅的 ranges 是**行内**偏移，不是全文偏移；
   * 3. **「选取范围内」只作用于当前文档**：其他文件没有选区坐标，范围恒为 null
   *    （与 rebuildResults / optionsForFile 同一口径，否则别的文件会被全部误杀）；
   * 4. **逆序替换**：从后往前拼，前面的偏移不受影响（与 replaceAll 同一手法）；
   * 5. **CRLF 保真**：命中偏移是归一化文本坐标，写回前用 `buildRawOffsetMap` 换算回原文；
   * 6. 替换完成后**重建条幅**（命中应消失），并刷新当前文档的搜索计数。
   *
   * @returns 实际被改写的文件数（0 表示没有可替换内容）
   */
  const replaceAllAcrossFiles = useCallback((): number => {
    if (!searchText) return 0;
    const regex = buildSearchRegexEx(searchText, { caseSensitive, useRegex, wholeWord });
    if (!regex) return 0;

    const currentKey = docKey ?? FALLBACK_FILE_KEY;
    const provided = collectFilesRef.current ? collectFilesRef.current() : null;
    // 没有 collectFiles（未接线 / 独立测试）：退化为只替换当前文档
    const files: SearchableFile[] = provided && provided.length > 0
      ? provided
      : [
          {
            fileKey: currentKey,
            filePath: "",
            fileName: docKey ? docKey.split(/[\\/]/).pop() ?? docKey : "",
            getText: () => readCurrentText().text,
          },
        ];

    let changedFiles = 0;
    for (const f of files) {
      const isCurrentDoc = f.fileKey === currentKey;
      // 「选取范围内」只属于当前文档 → 其他文件跳过（与查找口径一致）
      if (inSelection && !isCurrentDoc) continue;

      const raw = isCurrentDoc ? (readCurrentText().raw ?? f.getText()) : f.getText();
      const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const opts: SearchOptions = {
        caseSensitive,
        useRegex,
        wholeWord,
        range: inSelection ? (isCurrentDoc ? selectionRange ?? EMPTY_RANGE : null) : null,
      };
      const ranges = findMatchRangesEx(normalized, searchText, opts);
      if (!ranges || ranges.length === 0) continue;

      const rawMap = buildRawOffsetMap(raw);
      let next = raw;
      // 逆序拼接：从后往前改，前面的偏移不受影响
      for (let i = ranges.length - 1; i >= 0; i--) {
        const m = ranges[i];
        const expanded = expandReplacement(
          normalized.substring(m.start, m.end),
          regex,
          replaceText,
          useRegex,
        );
        const rawStart = rawMap ? rawMap[Math.min(m.start, rawMap.length - 1)] : m.start;
        const rawEnd = rawMap ? rawMap[Math.min(m.end, rawMap.length - 1)] : m.end;
        next = next.substring(0, rawStart) + expanded + next.substring(rawEnd);
      }
      if (next === raw) continue;

      if (isCurrentDoc) {
        // 当前文档走与「全部替换」同一条写回路径（编辑区 state + 标签内容 + 脏标记）
        onSourceContentChange?.(next);
      } else {
        // 其他标签：只能经宿主写回（面板没有 store 写权限）
        applyFileText?.(f.fileKey, next);
      }
      changedFiles++;
    }

    // 当前文档的匹配计数 / 条幅都需要重算（条幅是同步纯计算，直接刷）
    // v0.14.0 需求2（续修）：同 replaceCurrent/replaceAll —— 延迟重搜必须用**最新**闭包，
    // 否则批量替换后 50ms 的旧闭包会用替换前的 sourceContent 覆盖掉正确结果。
    setTimeout(() => {
      runContentResync();
      if (showResults) rebuildResults();
    }, 50);
    return changedFiles;
  }, [
    searchText, caseSensitive, useRegex, wholeWord, inSelection, selectionRange,
    docKey, readCurrentText, onSourceContentChange, applyFileText, replaceText,
    showResults, rebuildResults, runContentResync,
  ]);

  // 全部替换
  //
  // v0.14.0 需求4：**条幅展开时**，本按钮改为「替换所有命中的文件」——
  // 用户点「查找所有打开文件」看到多文件命中后，期望一次替换就把这些文件全改掉；
  // 若此时仍只替换当前文档，其余文件的内容与条幅显示的命中就会不一致（用户明确报了这个）。
  // 条幅收起时保持旧的「只替换当前文档」语义，避免误改未展示的文件。
  const replaceAll = useCallback(() => {
    if (!searchText) return;
    if (showResults && collectFilesRef.current) {
      const n = replaceAllAcrossFiles();
      setCrossFileReplaceHint(
        n > 0 ? t("search.replaceAllAcrossFilesDone", { files: n }) : t("search.resultsEmpty"),
      );
      if (jumpTimerRef.current) clearTimeout(jumpTimerRef.current);
      jumpTimerRef.current = setTimeout(() => setCrossFileReplaceHint(""), 3000);
      return;
    }
    if (matchesRef.current.length === 0) return;

    const regex = buildSearchRegexEx(searchText, { caseSensitive, useRegex, wholeWord });
    if (!regex) return;
    const matches = matchesRef.current;
    /** 计算第 i 个命中的替换文本（逐 match 展开捕获组；字面量模式原样替换） */
    const expandedOf = (i: number, sourceText: string): string =>
      expandReplacement(sourceText.substring(matches[i].start, matches[i].end), regex, replaceText, useRegex);

    if (isSourceMode && sourceContent !== undefined && onSourceContentChange) {
      const raw = sourceContent;
      const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const rawMap = buildRawOffsetMap(raw);
      // v0.14.0：只替换 matchesRef 里的命中（已按范围/全词过滤），不再用 String.replace 全文替换。
      // 逆序拼接：从后往前改，前面的偏移量不受影响。
      let next = raw;
      for (let i = matches.length - 1; i >= 0; i--) {
        const expanded = expandedOf(i, normalized);
        const rawStart = rawMap ? rawMap[Math.min(matches[i].start, rawMap.length - 1)] : matches[i].start;
        const rawEnd = rawMap ? rawMap[Math.min(matches[i].end, rawMap.length - 1)] : matches[i].end;
        next = next.substring(0, rawStart) + expanded + next.substring(rawEnd);
      }
      onSourceContentChange(next);
    } else if (editorView) {
      // 阅读模式：从后往前替换，避免位置偏移（v0.14.0：同样只替换过滤后的命中）
      try {
        const offsetMap = offsetMapRef.current;
        if (!offsetMap) return;

        let tr = editorView.state.tr;
        // 从后往前替换，这样前面的偏移量不会受影响
        for (let i = matches.length - 1; i >= 0; i--) {
          const range = matches[i];
          const pmStart = lookupPmPos(offsetMap.blocks, range.start);
          const pmEnd = lookupPmPos(offsetMap.blocks, range.end - 1);
          if (pmStart !== undefined && pmEnd !== undefined) {
            const endPos = Math.min(pmEnd + 1, editorView.state.doc.content.size);
            // R4：逐 match 展开捕获组（字面量模式原样替换）
            tr = tr.insertText(expandedOf(i, offsetMap.text), pmStart, endPos);
          }
        }
        tr.setMeta("addToHistory", true);
        editorView.dispatch(tr);
      } catch {
        // 忽略替换错误
      }
    }

    // v0.14.0：范围快照随「全部替换」平移。
    // 按命中升序逐次套用 applyReplacementToRange（相当于把 N 次替换依次施加到范围上），
    // 因为范围只罩住这些命中，所以起点不动、终点按累计增量伸缩。
    if (inSelection && selectionRange) {
      const normalized = isSourceMode ? (sourceContent ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n") : offsetMapRef.current?.text ?? "";
      let shifted = selectionRange;
      let acc = 0; // 已处理命中造成的累计位移
      for (let i = 0; i < matches.length; i++) {
        const inserted = expandedOf(i, normalized).length;
        const removed = matches[i].end - matches[i].start;
        shifted = applyReplacementToRange(shifted, matches[i].start + acc, removed, inserted);
        acc += inserted - removed;
      }
      setSelectionRange(shifted);
    }

    // v0.14.0 需求2（续修）：同 replaceCurrent —— 延迟重搜必须用最新闭包，
    // 否则「全部替换」后 50ms 的旧闭包会把刚算对的结果覆盖回替换前。
    setTimeout(() => runContentResync(), 50);
  }, [isSourceMode, sourceContent, onSourceContentChange, searchText, replaceText, caseSensitive, useRegex, wholeWord, inSelection, selectionRange, editorView, showResults, replaceAllAcrossFiles, t, runContentResync]);

  // ─── v0.14.0：「查找所有打开文件」结果条幅 ─────────────────────


  /** 搜索词/选项/范围变化时，条幅已展开就自动刷新（跟着查找走，不需要再点一次按钮） */
  useEffect(() => {
    if (!showResults) return;
    rebuildResults();
  }, [showResults, rebuildResults]);

  // ─── v0.15.0 R6b：工作区搜索编排 ────────────────────────────────

  /** 工作区作用域是否可用（宿主传了 roots 且非空） */
  const workspaceAvailable = !!workspaceRoots && workspaceRoots.length > 0;

  /**
   * v0.15.1 需求4 续修（症状 3，工作区侧）：**当前文档**的工作区命中也按状态栏口径显示行列。
   *
   * 为什么需要单独一张表：工作区结果来自 Rust（磁盘源码空间），其 `line` 是源码行号；
   * 而命中的文件若已打开并处于阅读模式，用户对照的是右下角的 PM 逻辑块行号。
   * 两者在列表/表格/空行文档上会差好几行（实测数据见 `pmLineColumnOfOffset` 注释）。
   *
   * 键用 `rootId:occurrence`（文件归一化键 + 该命中的文件级 0 基序号）：
   * - 不能用 `line:column` —— 脏文档覆盖/磁盘旧内容时行号会变，但 occurrence 稳定；
   * - 可以用 occurrence —— Rust 的 occurrence 与本地 `collectFileResults` 的
   *   occurrence 在同一份文本上同口径（都按出现顺序编号）。
   *
   * 换文档 / 换词 / 内容变化时重算（依赖已覆盖这些量）。
   */
  const [workspaceStatusStamps, setWorkspaceStatusStamps] = useState<
    Record<string, { line: number; column: number }>
  >({});
  useEffect(() => {
    const doc = !isSourceMode ? editorView?.state.doc ?? null : null;
    if (!doc || workspaceFiles.length === 0 || !currentDocKey) {
      setWorkspaceStatusStamps({});
      return;
    }
    const curKey = jumpKeyOf(docKey);
    const map = buildOffsetMap(doc);
    const blocks = map.blocks;
    // PM 文本空间的全部命中，用来把 occurrence 换算成偏移
    const text = map.text;
    const ranges = findMatchRangesEx(text, searchText, {
      caseSensitive,
      useRegex,
      wholeWord,
      range: null,
    });
    const out: Record<string, { line: number; column: number }> = {};
    if (ranges) {
      for (const g of workspaceFiles) {
        if (jumpKeyOf(g.fileKey) !== curKey) continue;
        for (const r of g.rows) {
          const occ = jumpOccurrenceOf(r);
          // occurrence 只在"源码出现次数与 PM 文本一致"时能直接索引；
          // 越界就用该行首个命中的 occurrence 兜底（至少行号不会错到别的小节）
          const at = occ < ranges.length ? ranges[occ] : ranges[0];
          if (!at) continue;
          const stamp = pmLineColumnOfOffset(doc, blocks, at.start);
          if (stamp) out[`${curKey}:${occ}`] = stamp;
        }
      }
    }
    setWorkspaceStatusStamps(out);
  }, [
    workspaceFiles, docKey, currentDocKey, isSourceMode, editorView,
    searchText, caseSensitive, useRegex, wholeWord, contentVersion,
  ]);

  /**
   * 执行一次工作区搜索。
   *
   * 竞态：每次调用生成新 `queryId`，服务层据此丢弃旧帧；本组件同时 `cancel` 上一次
   * 查询（双保险：服务层保证旧帧不影响结果，cancel 让 Rust 尽早停止扫盘省 CPU）。
   *
   * 脏文档覆盖：把 `openFileTexts()` 交给服务层（已打开文件用内存重算）。
   */
  const runWorkspaceSearch = useCallback(() => {
    if (!workspaceAvailable) return;
    const query = searchText;
    // 空词：清空结果即可，不发 IPC（Rust 也会立即返回空，但没必要往返）
    if (!query) {
      setWorkspaceFiles([]);
      setWorkspaceTotal(0);
      setWorkspaceScanned(0);
      setWorkspaceSkipped(0);
      setWorkspaceTruncated(false);
      setWorkspaceSearching(false);
      setWorkspaceError(null);
      setWorkspaceReconciled(0);
      return;
    }
    // 正则首版禁用：UI 已禁用勾选（见 regex checkbox 的 disabled），这里再兜一层，
    // 保证即使状态被程序化改动也不会把 regex 请求发出去
    if (useRegex) {
      setWorkspaceError(t("search.workspaceRegexUnsupported"));
      setWorkspaceSearching(false);
      setWorkspaceFiles([]);
      setWorkspaceTotal(0);
      return;
    }

    // 取消上一次（换词/重新点搜索）
    const previous = workspaceQueryRef.current;
    if (previous) void cancelWorkspaceSearch(previous);

    const queryId = createWorkspaceQueryId();
    workspaceQueryRef.current = queryId;
    setWorkspaceSearching(true);
    setWorkspaceError(null);
    setWorkspaceFiles([]);
    setWorkspaceTotal(0);
    setWorkspaceScanned(0);
    setWorkspaceSkipped(0);
    setWorkspaceTruncated(false);
    setWorkspaceReconciled(0);

    let openFiles: Array<{ filePath: string; getText: () => string }> | null = null;
    try {
      openFiles = openFileTexts?.() ?? null;
    } catch {
      openFiles = null; // 宿主实现异常：退化为纯磁盘结果，不影响搜索可用性
    }

    void searchWorkspace(
      {
        queryId,
        roots: workspaceRoots ?? [],
        query,
        options: { caseSensitive, wholeWord, regex: useRegex },
      },
      {
        openFiles,
        onProgress: (snap: WorkspaceSearchSnapshot) => {
          // 过期快照不落地（服务层已过滤，这里再核对一次 queryId：
          // 组件可能在本轮 cancel 之后才收到上一次查询的最后一帧）
          if (workspaceQueryRef.current !== queryId) return;
          setWorkspaceFiles(snap.files);
          setWorkspaceTotal(snap.totalHits);
          setWorkspaceScanned(snap.filesScanned);
          setWorkspaceSkipped(snap.filesSkipped);
          setWorkspaceTruncated(snap.truncated);
        },
        onDone: (result) => {
          if (workspaceQueryRef.current !== queryId) return;
          workspaceQueryRef.current = null;
          setWorkspaceSearching(false);
          setWorkspaceFiles(result.files);
          setWorkspaceTotal(result.totalHits);
          setWorkspaceScanned(result.filesScanned);
          setWorkspaceSkipped(result.filesSkipped);
          setWorkspaceTruncated(result.truncated);
          setWorkspaceReconciled(result.reconciledFiles);
          // 取消导致的收尾：保留已有结果，不报错
        },
        onError: (err) => {
          if (workspaceQueryRef.current !== queryId) return;
          workspaceQueryRef.current = null;
          setWorkspaceSearching(false);
          setWorkspaceFiles([]);
          setWorkspaceTotal(0);
          // 正则拒绝必须有明确提示（不能静默失败）
          setWorkspaceError(
            err.code === "REGEX_UNSUPPORTED"
              ? t("search.workspaceRegexUnsupported")
              : t("search.workspaceSearchFailed", { detail: err.detail || err.message }),
          );
        },
      },
    ).catch(() => {
      // onError 已给出可见提示；这里吞掉 rejection 避免 unhandled rejection
    });
  }, [
    workspaceAvailable,
    workspaceRoots,
    searchText,
    caseSensitive,
    wholeWord,
    useRegex,
    openFileTexts,
    t,
  ]);

  /**
   * 工作区搜索的触发条件：进入工作区作用域 / 搜索词变化 / 选项变化 / roots 变化。
   *
   * 为什么要 debounce（260ms）：`searchText` 每敲一个字符就变，直接搜会把整个工作区
   * 反复扫（1000 文件 × 每次按键），既卡又浪费。用户停止输入 260ms 后才真正开始，
   * 与 IDE 的"边打边搜但节流"体感一致。
   */
  useEffect(() => {
    if (scope !== "workspace") return;
    if (!searchText) {
      setWorkspaceFiles([]);
      setWorkspaceTotal(0);
      setWorkspaceError(null);
      setWorkspaceSearching(false);
      return;
    }
    const timer = setTimeout(() => runWorkspaceSearch(), 260);
    return () => clearTimeout(timer);
  }, [scope, searchText, caseSensitive, wholeWord, useRegex, workspaceRoots, runWorkspaceSearch]);

  /**
   * 卸载 / 关闭面板 → 取消进行中的工作区搜索。
   *
   * 必须做：Rust 侧扫盘是长任务，用户关掉面板后还继续扫会白烧 CPU/IO；
   * 服务层虽然有 queryId 裁决（旧帧不会污染 UI），但**只有 cancel 能真正停下扫描**。
   */
  useEffect(() => {
    return () => {
      const qid = workspaceQueryRef.current;
      if (qid) {
        workspaceQueryRef.current = null;
        void cancelWorkspaceSearch(qid);
      }
    };
  }, []);


  /**
   * v0.14.0 需求5：**换文档后立即在新文档上重新搜索**。
   *
   * 用户原话：「我在 a 文档开启了搜索框，点击内容搜索没搜到，我没关闭搜索框而是切换到
   * 另一个文档，那么这个搜索的内容应该立即激活并作用到切换的文档上进行搜索。」
   *
   * 为什么必须显式监听 `docKey` / `contentVersion`：
   * - 阅读模式下换文档，`editorView` 是**同一个对象**（不重建），`sourceContent`
   *   在阅读模式也不会变 → `performSearch` 的所有依赖都没变，effect 不会重跑；
   * - 而 `docKey` 每次换文档必变、`contentVersion`（宿主传的 forceUpdateKey）必 +1。
   *
   * 用 `contentVersion` 而不是只靠 docKey：同一文件被外部改过 / 切回同一标签
   * 但内容变了，docKey 不变而 contentVersion 变了，也应该重新搜索。
   *
   * ⚠️ 时序（两处坑，都已用实机验证过）：
   * ① 换文档后 PM doc 的替换是在 EditorContainer 的 effect 里**后一步**做的，
   *    本 effect 可能先跑（读到旧 doc）→ 延迟到下一帧再搜；
   * ② **所有延迟执行必须走 `performSearchRef.current()`**，不能直接调 `performSearch`。
   *    原因：换文档瞬间 `sourceContent` 还是旧文本，此刻创建的定时器会捕获旧闭包；
   *    等文本更新后 `performSearch` 换了新身份，但本 effect 依赖
   *    `[docKey, contentVersion, searchText]` 没变 → 不重跑、不 cleanup →
   *    旧定时器照常触发，把刚算对的匹配数覆盖回"无结果"（实机复现过）。
   * ③ 用 `contentVersion` 而不是只靠 docKey：同一文件被外部改过 / 切回同一标签
   *    但内容变了，docKey 不变而 contentVersion 变了，也应该重新搜索。
   */
  useEffect(() => {
    if (!searchText) return;
    // 连续换文档时只保留最后一次的结果：用序号丢弃过期回调
    const seq = ++docChangeSeqRef.current;
    const run = () => {
      if (docChangeSeqRef.current !== seq) return;
      performSearchRef.current();
    };
    // 双 rAF：第一帧等 React 提交完成、第二帧等 EditorContainer 把新 doc 灌进 view
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(run);
    });
    // 兜底：某些环境下 doc 替换在 effect 之后一拍才稳定，再补一次
    const timer = setTimeout(run, 160);
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
      clearTimeout(timer);
    };
    // 只依赖「文档身份 / 内容版本」与搜索词：选项变化由 performSearch 自己的依赖处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, contentVersion, searchText]);

  /**
   * v0.15.1 需求5：**换文档 / 切模式时先清干净残留高亮**。
   *
   * 为什么必须单独一条 effect：换文档的时序是「docKey 先变 → 文本后一步灌进来 →
   * performSearch 再重算」。若不等重算就保留旧高亮，用户会看到**新文档**上挂着
   * **上一个文档**的命中区间（Decoration 位置随新 doc 映射，纯属残影）。
   * 这里在文档身份一变的瞬间清空，随后 `performSearch` 命中新内容时再重新铺。
   *
   * 用 `currentDocKey`（docKey + 源码/阅读模式）而不仅是 docKey：
   * 切模式时 PM 层与 overlay 层要互换，旧那层必须撤掉，否则阅读面留着 overlay、
   * 源码面留着 Decoration，两个面都脏。
   */
  useEffect(() => {
    clearHighlights();
    // 只按「文档身份」触发；clearHighlights 的身份变化不应再触发一次（它在依赖里会被 lint 要求，
    // 但它只依赖 editorView / refs，实际是稳定的）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDocKey]);


  /** 「查找所有打开文件」按钮：展开 ↔ 收起 */
  const toggleResults = useCallback(() => {
    setShowResults((v) => !v);
  }, []);

  /**
   * 在当前文本空间里定位到某个跳转目标并高亮（就地跳转，不派发切标签事件）。
   *
   * ## 落点优先级（v0.15.1 需求4 续修，顺序不可换）
   * 1. **逐处偏移**（`hitOffsets[hitIndex]`）：条幅/工作区行是「一行一条」，同一行有
   *    4 处命中时行/列只能描述首处。`hitOffsets` 是按命中原样记录的全文偏移，
   *    在**同一文本空间**里是精确坐标 → 先命中它，且校验它确实落在某个匹配区间内
   *    （条幅可能是上一版文本算的，文本已改就作废）。
   * 2. **第 N 次出现**（`resolveJumpByOccurrence(occurrence + hitIndex)`）：跨文本空间
   *    （源码 → PM 渲染文本）时唯一稳定口径。
   * 3. **行/列 + 关键词**（`resolveJumpOffset`）：最后兜底，正则等场景下关键词不是字面文本。
   *
   * 为什么不再只用 `resolveJumpOffset`：它把落点钉在「该行首个命中」上
   * （实测：同一行 4 处命中时，无论点第几条都返回行首偏移），这正是用户报告的
   * 「每一处都跳到第一个搜索」在行内多命中时的直接成因。
   *
   * @returns 是否定位成功（失败时不改状态，由调用方给可见提示）
   */
  const jumpWithinCurrentText = useCallback(
    (t: { query: string; line: number; column: number; occurrence: number; hitIndex?: number }) => {
      const { text } = readCurrentText();
      const matches = matchesRef.current;
      if (matches.length === 0 || !t.query) return false;
      const hitIndex = Math.max(0, t.hitIndex ?? 0);

      const indexOfOffset = (offset: number | null | undefined): number => {
        if (offset === null || offset === undefined || !Number.isFinite(offset)) return -1;
        return matches.findIndex((m) => offset >= m.start && offset < m.end);
      };

      // ① 逐处偏移（精确，但只在"这份文本就是算条幅时那份文本"时成立 → 校验落在匹配内）
      const hitOffsets = pendingHitOffsetsRef.current;
      let idx = indexOfOffset(hitOffsets?.[hitIndex]);
      // ② 第 N 次出现
      if (idx < 0) {
        idx = indexOfOffset(
          resolveJumpByOccurrence(text, t.query, t.occurrence + hitIndex, {
            caseSensitive,
            useRegex,
            wholeWord,
          }),
        );
      }
      // ③ 行/列兜底
      if (idx < 0) {
        const offset = resolveJumpOffset(text, { line: t.line, column: t.column, query: t.query });
        idx = indexOfOffset(offset);
        // 行列完全对不上（文本已变）时不要硬跳到"最近的匹配"以外的地方：
        // 取该偏移之后的第一处匹配，仍优于"什么都不发生"
        if (idx < 0) idx = matches.findIndex((m) => m.start >= offset);
      }
      if (idx < 0) return false;
      setCurrentMatch(idx + 1);
      // 同步镜像：否则随后的延迟重搜会把当前项重置回第 1 处（见 currentMatchRef 注释）
      currentMatchRef.current = idx + 1;
      highlightMatch(idx);
      setJumpFailed(false);
      return true;
    },
    [readCurrentText, caseSensitive, useRegex, wholeWord, highlightMatch],
  );

  /**
   * 点击某条结果 → 跳转。
   *
   * 两种分支：
   * - 目标是当前文档：**就地跳转**，用「逐处偏移 → 第 N 次出现 → 行/列」三级定位
   *   （不派发切标签事件，避免 App 多余地重建编辑器导致面板失焦）
   * - 目标是别的文件：把目标（含 `occurrence` + `hitIndex`）写入跨组件跳转契约并派发
   *   事件让 App 切标签。为什么跨文件不用行号：结果算在源码空间，跳过去可能是阅读模式
   *   （PM 文本空间），行号会错位；用「第 N 次出现」定位见 resolveJumpByOccurrence。
   *   定位闭环由接收端 effect / 事件监听在本文件内完成 —— 不依赖 EditorContainer 改定位逻辑。
   *
   * @param r 结果行（一行可能有多处命中）
   * @param hitIndex 点的是该行第几处命中（0 基；条幅的每个 `<mark>` 各自可点）
   */
  const handleResultClick = useCallback(
    (r: SearchFileResult, hitIndex = 0) => {
      const hit = Math.max(0, Math.min(hitIndex, Math.max(0, r.ranges.length - 1)));
      const range = r.ranges[hit] ?? r.ranges[0];
      // 行内第 hit 处命中在原文该行内的偏移 → 1 基列号（`column` 只描述首处）
      const column = range ? range.start + 1 : r.column;
      const target: SearchJumpTarget = {
        fileKey: r.fileKey,
        filePath: r.filePath,
        line: r.line,
        column,
        length: Math.max(1, (range?.end ?? 0) - (range?.start ?? 0)),
        query: searchText,
        occurrence: r.occurrence,
        hitIndex: hit,
      };
      const currentKey = docKey ?? FALLBACK_FILE_KEY;
      // v0.15.1：键比较必须归一化（工作区 fileKey 是 pathCompareKey 形态）
      if (sameJumpKey(r.fileKey, currentKey)) {
        // 逐处偏移只对「当前文本就是算条幅的那份文本」有效
        pendingHitOffsetsRef.current =
          matchesTextRef.current !== null && matchesTextRef.current === readCurrentText().text
            ? r.hitOffsets ?? null
            : null;
        const ok = jumpWithinCurrentText(target);
        pendingHitOffsetsRef.current = null;
        if (!ok) {
          // 找不到落点（例如文本刚被改过、命中已消失）：给出可见提示，而不是点了没反应
          setJumpFailed(true);
          if (jumpTimerRef.current) clearTimeout(jumpTimerRef.current);
          jumpTimerRef.current = setTimeout(() => setJumpFailed(false), 2000);
        }
        return;
      }
      onJumpToFile?.(target);
      requestSearchJump(target);
    },
    [docKey, readCurrentText, searchText, jumpWithinCurrentText, onJumpToFile],
  );

  /**
   * v0.15.0 R6b：点击**工作区**结果 → 跳转。
   *
   * v0.15.1 需求4 续修：**目标就是当前文档时也走就地跳转**（与「打开的文件」完全一致）。
   * 为什么必须补这条：旧实现无条件 `requestSearchJump`，而 App 的监听器在
   * 「目标已是当前标签」时直接 `return`（不切标签）→ 面板的消费 effect 依赖的 `docKey`
   * 没变 → 永远不跑 → pending 一直挂着，用户看到的就是「点了没反应」。
   * 工作区命中的文件**本来就已经打开**（脏文档覆盖按内存重算命中）是常态，
   * 所以这条分支不是边缘情况，而是主要路径。
   *
   * 跨文件（目标不是当前文档）仍走 requestSearchJump：由 App 打开/切换文件后，
   * 接收端（事件监听 + docKey effect）用 occurrence 定位，跨文本空间才稳。
   */
  const handleWorkspaceResultClick = useCallback(
    (group: WorkspaceFileResult, r: SearchFileResult, hitIndex = 0) => {
      const hit = Math.max(0, Math.min(hitIndex, Math.max(0, r.ranges.length - 1)));
      /**
       * 列的取法（工作区特有，别照抄「打开的文件」那条路）：
       * 工作区行的 `ranges` 是 **snippet 内**的偏移（Rust 给的是裁剪过的行摘要，
       * 可能带前导省略号），直接 `range.start + 1` 得到的不是原文列号。
       * 只有一处命中时 Rust 的 `r.column` 就是该处的原文列号（精确）；
       * 一处行内有多处命中时 Rust 也是**每处一条 hit**（各行一条 = 一条 = 一处），
       * 因此 `hitIndex` 在这里恒为 0，`r.column` 始终正确。
       */
      const target: SearchJumpTarget = {
        fileKey: r.fileKey,
        filePath: r.filePath || group.filePath,
        line: r.line,
        column: r.column,
        length: Math.max(
          1,
          (r.ranges[hit]?.end ?? 0) - (r.ranges[hit]?.start ?? 0),
        ),
        query: searchText,
        occurrence: r.occurrence,
        hitIndex: hit,
      };
      if (sameJumpKey(r.fileKey, docKey ?? FALLBACK_FILE_KEY)) {
        pendingHitOffsetsRef.current =
          matchesTextRef.current !== null && matchesTextRef.current === readCurrentText().text
            ? r.hitOffsets ?? null
            : null;
        const ok = jumpWithinCurrentText(target);
        pendingHitOffsetsRef.current = null;
        if (!ok) {
          setJumpFailed(true);
          if (jumpTimerRef.current) clearTimeout(jumpTimerRef.current);
          jumpTimerRef.current = setTimeout(() => setJumpFailed(false), 2000);
        }
        return;
      }
      onJumpToFile?.(target);
      requestSearchJump(target);
    },
    [docKey, readCurrentText, searchText, jumpWithinCurrentText, onJumpToFile],
  );

  /**
   * 跳转接收端的**唯一实现**：判断「这条 pending 是不是我的」，是就消费并定位。
   *
   * 抽成函数（而不是继续写在 effect 体里）的原因：v0.15.1 需求4 续修后有三条通道
   * 会调用它 ——
   * ① `SEARCH_JUMP_EVENT` 监听（目标**已经是**当前文档时唯一能立即生效的通道）；
   * ② `docKey` effect（目标文档刚切/刚打开时的通道）；
   * ③ 模式切换 effect（同一文档从源码面换到阅读面，文本空间变了要重定位）。
   * 三处若各写一份，必然有一天只改一处（改漏的那侧会静默不跳）。
   *
   * @param viaEvent 是否由事件通道触发。事件通道**必须在派发帧同步处理**：
   *   此时目标已是当前文档（App 判断过），但 `matchesTextRef` 可能还是旧文本，
   *   于是走"登记 pendingJumpRef → performSearch 兑现"的兜底路径（保留原设计）。
   * @returns 是否消费了一条 pending
   */
  const consumePendingJump = useCallback((): boolean => {
    const key = docKeyRef.current;
    if (!key) return false;
    const pending = peekSearchJump();
    if (!pending || !sameJumpKey(pending.fileKey, key)) return false;
    // 过滤条件用 pending 自己的键 + 自己的 seq（take 内部是严格相等比较，
    // 传归一化后的键会失配；带 seq 是为了让多条通道安全地"抢同一条请求"）
    const taken = takeSearchJump(pending.fileKey, pending.seq);
    if (!taken) return false;

    /**
     * **匹配集是否已跟上当前文本**。
     *
     * `matchesRef` 是"上一次 performSearch 算出的匹配"，只有它对应的文本
     * （`matchesTextRef`）与当前文本一致时，才能拿它做落点判定。
     * 刚打开文件的那一刻：文本已换新、匹配集还是旧的 → 必须等 performSearch 重算。
     */
    const { text } = readCurrentText();
    const matchesConsistent = matchesTextRef.current !== null && matchesTextRef.current === text;
    if (matchesConsistent) {
      const ok = jumpWithinCurrentText(taken);
      if (ok) return true;
    }
    // 文本/匹配集尚未就绪：只登记目标，由 performSearch 在匹配集刷新后兑现。
    pendingJumpRef.current = { key: jumpKeyOf(key), target: taken };
    // 兜底：目标文档迟迟不出现关键词（文件被改过 / 打开失败）时，不要静默挂着
    if (jumpTimerRef.current) clearTimeout(jumpTimerRef.current);
    jumpTimerRef.current = setTimeout(() => {
      if (pendingJumpRef.current) {
        pendingJumpRef.current = null;
        setJumpFailed(true);
        jumpTimerRef.current = setTimeout(() => setJumpFailed(false), 2000);
      }
    }, 4000);
    return true;
  }, [readCurrentText, jumpWithinCurrentText]);

  /**
   * v0.15.1 需求4 续修（真因 A）：**同一个文档内连续点击结果时，接收端永远不会重跑**。
   *
   * ## 实测复现（修复前，探针日志）
   * 工作区搜到同一文档的 4 处命中，依次点击：
   * ```
   *   click1 → pending=null  count=1/4   ← 第 1 次成功（App 切了标签，docKey 变了）
   *   click2 → pending={...line:2} count=1/4 ← 点了没反应，pending 一直挂着
   *   click3 → pending={...line:3} count=1/4
   *   click4 → pending={...line:4} count=1/4
   * ```
   * 成因：App 的 `lightmd:search-jump` 监听器在「目标已是当前标签」时直接
   * `if (idx === st.activeTabIdx) return;`（不切标签是正确的 —— 没必要重建编辑器），
   * 于是 `docKey` 不变 → 下面那条 docKey effect 的依赖全没变 → 不重跑 →
   * 没有任何人去 `takeSearchJump`。
   *
   * ## 修法
   * 面板自己监听 `SEARCH_JUMP_EVENT`：只要这条请求的目标就是当前文档，就地消费。
   * **不依赖 docKey 变化**，所以连点 4 次每次都能生效。
   *
   * ## 为什么不删掉那条 docKey effect
   * 目标文档**还没打开 / 正在切换**时，事件到达的那一刻文本还是旧的（内容/坐标系都
   * 还没就绪），此时消费必然算错；必须等 docKey 变成目标文件后再消费。
   * 两条通道互补：事件管"已是当前文档"，effect 管"刚变成当前文档"。
   * 二者都经 `consumePendingJump`，且 `takeSearchJump(seq)` 保证同一请求只被消费一次。
   */
  useEffect(() => {
    const onJump = () => {
      // 事件由 requestSearchJump 同步派发（先写 pending 再 dispatch），
      // 因而这里能立刻读到 detail/pending；目标不是当前文档时静默返回（交给 App 切标签）
      consumePendingJump();
      // 若上一步因"匹配集还是旧文本"而走了 pendingJumpRef 兜底，这里再推一次重搜，
      // 免得要等 MutationObserver 的 150ms 防抖（用户会觉得点了半天才动）
      if (pendingJumpRef.current) performSearchRef.current();
    };
    window.addEventListener(SEARCH_JUMP_EVENT, onJump);
    return () => window.removeEventListener(SEARCH_JUMP_EVENT, onJump);
  }, [consumePendingJump]);

  /**
   * 接收端（**文档切换通道**）：目标文档刚成为当前文档时消费 pending。
   *
   * 为什么还要 seq 作为 effect 依赖的一部分（而不是只靠 docKey）：
   * 目标**已经是**当前文档但上次因匹配集未就绪被登记进 `pendingJumpRef` 时，
   * 用户再点同一文档的另一处 → docKey 仍不变 → 只有 seq 变了。把 seq 放进依赖，
   * 保证每次点击都至少尝试一次消费（事件通道通常会先接住，这里是双保险）。
   *
   * 为什么拿 peekSearchJump 再 take：别的窗口/别的面板实例也可能有 pending，
   * 必须先确认 fileKey 与当前 docKey 一致才消费，否则会把别人的跳转请求吃掉
   * （表现为"点了结果但没反应"）。
   *
   * v0.15.1 需求4 修复（真因 a）：比较**必须走归一化键**（`sameJumpKey`）。
   * 工作区结果的 fileKey 是 `pathCompareKey(filePath)`（正斜杠 + 小写），而 docKey 是
   * 宿主给的原始路径（可能反斜杠 + 原大小写）—— 旧代码直接 `!==` 比较，恒不相等，
   * pending 永远不会被消费，于是「点了工作区结果没反应」。
   */
  const jumpSeq = peekSearchJumpSeq();
  useEffect(() => {
    // 依赖里加 seq：同一文档连点时 docKey 不变，只有 seq 变化能触发（见上方注释）。
    // 依赖里仍**不放** matches / readCurrentText：本 effect 的职责只是"尝试消费一次"，
    // 把易变引用放进来会重复触发（pending 已被 take，第二次为空但语义混淆）。
    consumePendingJump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, caseSensitive, useRegex, wholeWord, jumpSeq]);

  // 键盘事件
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      goToMatch(e.shiftKey ? -1 : 1);
    }
    if (e.key === "Escape") {
      onClose();
    }
  }, [goToMatch, onClose]);

  return (
    <div
      ref={containerRef}
      className={`search-replace search-replace-floating${previewOpen ? "" : " search-replace-solo"}`}
      style={initialized ? { left: position.x, top: position.y } : undefined}
      onKeyDown={handleKeyDown}
    >
      {/* 拖拽条 */}
      <div className="search-drag-handle" onMouseDown={handleDragStart}>
        <span className="search-drag-dots">⋮⋮</span>
        <span className="search-drag-title">{t("search.placeholder")}</span>
        <button className="search-close-btn" title={t("search.close")} onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="search-row">
        <input
          ref={searchInputRef}
          className={`search-input${regexInvalid ? " search-input-invalid" : ""}`}
          type="text"
          placeholder={t("search.placeholder")}
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
        />
        <button className="search-nav-btn" title={t("search.previous")} onClick={() => goToMatch(-1)} disabled={matchCount === 0}>
          ↑
        </button>
        <button className="search-nav-btn" title={t("search.next")} onClick={() => goToMatch(1)} disabled={matchCount === 0}>
          ↓
        </button>
        <span
          className={`search-count${regexInvalid ? " search-count-invalid" : ""}`}
          data-testid="search-count"
        >
          {regexInvalid
            ? t("search.regexInvalid")
            : matchCount > 0
              ? `${currentMatch}/${matchCount}`
              : t("search.noResult")}
        </span>
        {/* v0.15.1 需求5：命中超过高亮上限时**必须可见地**告知（不静默截断）。
            刻意与上面的 `search-count` 分开成两个节点：计数节点被既有测试按
            `current/total` 原样解析，混进提示文案会让那些断言全挂。 */}
        {highlightTruncated && matchCount > MAX_HIGHLIGHT_MATCHES && (
          <span
            className="search-highlight-limit"
            data-testid="search-highlight-limit"
            title={highlightLimitMessage(t, MAX_HIGHLIGHT_MATCHES)}
          >
            {highlightLimitMessage(t, MAX_HIGHLIGHT_MATCHES)}
          </span>
        )}
        <button className="search-toggle-btn" title={t("search.toggleReplace")} onClick={() => setShowReplace(!showReplace)}>
          ⟳
        </button>
      </div>
      {/* v0.14.0：4 个勾选框（默认全不勾）+ 右侧两个作用域按钮。
          v0.15.1 需求6：拆成「勾选组 + 右侧动作组」两段固定布局 —— 勾选组可压缩、
          动作组固定尺寸贴右沿，保证结果条幅出现/消失时两个按钮的位置**完全不动**、
          也不会因 flex-wrap 换行掉到第二行（面板宽度变化同理：v0.15.1 需求3 把面板
          从 920px 收到 620px，这层布局语义不变）。
          结构断言见 v0150-search-workspace-ui.test.tsx。 */}
      <div className="search-options-row">
        <div className="search-options-checks" data-testid="search-options-checks">
          <label className="search-check" title={t("search.wholeWord")}>
            <input
              type="checkbox"
              data-testid="search-whole-word"
              checked={wholeWord}
              onChange={(e) => setWholeWord(e.target.checked)}
            />
            <span className="search-check-label">{t("search.wholeWord")}</span>
          </label>
          <label className="search-check" title={t("search.matchCase")}>
            <input
              type="checkbox"
              data-testid="search-match-case"
              checked={caseSensitive}
              onChange={(e) => setCaseSensitive(e.target.checked)}
            />
            <span className="search-check-label">{t("search.matchCase")}</span>
          </label>
          <label className="search-check" title={t("search.inSelection")}>
            <input
              type="checkbox"
              data-testid="search-in-selection"
              checked={inSelection}
              onChange={handleToggleInSelection}
            />
            <span className="search-check-label">{t("search.inSelection")}</span>
          </label>
          {/* 正则：沿用 R4 行为（可 $1 捕获组），沿用旧 title key。
              v0.15.0 R6b：工作区作用域**禁用**正则（Rust 首版拒绝，语义不等价），
              勾选状态下切到工作区会立即给出明确提示，而不是静默返回空结果 */}
          <label className="search-check" title={t("search.useRegex")}>
            <input
              type="checkbox"
              data-testid="search-use-regex"
              checked={useRegex}
              disabled={scope === "workspace"}
              onChange={(e) => setUseRegex(e.target.checked)}
            />
            <span className="search-check-label search-check-mono">.*</span>
          </label>
        </div>
        <div className="search-options-actions" data-testid="search-options-actions">
          <button
            type="button"
            className={`search-find-files-btn${showResults ? " active" : ""}`}
            data-testid="search-find-in-open-files"
            title={t("search.findInOpenFiles")}
            onClick={toggleResults}
          >
            {t("search.findInOpenFiles")}
          </button>
          {/* v0.15.0 R6b：搜索作用域切换。只在宿主传了 workspaceRoots 时出现，
              避免未接线时出现「点了没反应」的按钮 */}
          {workspaceAvailable && (
            <button
              type="button"
              className={`search-find-files-btn${scope === "workspace" ? " active" : ""}`}
              data-testid="search-scope-workspace"
              title={t("search.searchInWorkspace")}
              onClick={() => {
                setScope((prev) => (prev === "workspace" ? "current" : "workspace"));
              }}
            >
              {scope === "workspace"
                ? t("search.scopeWorkspaceActive")
                : t("search.searchInWorkspace")}
            </button>
          )}
        </div>
      </div>
      {/* v0.15.0 R6b：工作区作用域的错误提示（正则被拒 / IPC 失败）——
          必须可见，绝不静默失败 */}
      {scope === "workspace" && workspaceError && (
        <div className="search-hint search-hint-error" data-testid="search-workspace-error">
          {workspaceError}
        </div>
      )}
      {/* 勾了「选取范围内」却没取到选区：红字提示 + 匹配数 0（绝不静默退化成全文） */}
      {inSelection && !selectionRange && (
        <div className="search-hint" data-testid="search-selection-hint">
          {selectionLostByDocChange ? t("search.selectionLost") : t("search.selectionRequired")}
        </div>
      )}
      {jumpFailed && (
        <div className="search-hint" data-testid="search-jump-hint">
          {t("search.jumpFailed")}
        </div>
      )}
      {/* v0.14.0 需求4：跨文件批量替换的结果提示 */}
      {crossFileReplaceHint && (
        <div className="search-hint" data-testid="search-crossfile-hint">
          {crossFileReplaceHint}
        </div>
      )}
      {showReplace && (
        <div className="replace-row">
          <input
            className="search-input"
            type="text"
            placeholder={t("search.replacePlaceholder")}
            value={replaceText}
            onChange={(e) => setReplaceText(e.target.value)}
          />
          <button className="replace-btn" title={t("search.replaceCurrent")} onClick={replaceCurrent} disabled={matchCount === 0}>
            {t("search.replace")}
          </button>
          {/* v0.14.0 需求4：条幅展开时本按钮改文案 → 明确告知"会替换所有文件" */}
          <button
            className="replace-btn"
            data-testid="search-replace-all"
            title={showResults && collectFiles ? t("search.replaceAllAcrossFiles") : t("search.replaceAll")}
            onClick={replaceAll}
            disabled={showResults && collectFiles ? resultMatchTotal === 0 : matchCount === 0}
          >
            {showResults && collectFiles ? t("search.replaceAllAcrossFiles") : t("search.replaceAll")}
          </button>
        </div>
      )}
      {/* 结果条幅：放在替换行**下方**（纵向展开而不是盖住替换行），
          条幅自身可滚动，长结果不影响面板其它控件。

          v0.15.1 需求6：外壳 `.search-results-shell` **常驻**（即使条幅收起也在 DOM 里），
          展开/收起只切 `is-open` 类，靠 height:0 ↔ height:auto 的过渡把面板高度
          平滑地长/缩（`interpolate-size: allow-keywords`，WebView2 155 支持；
          不支持时退化为瞬时显隐，功能不失效）。
          为什么外壳常驻而内容仍条件渲染：收起时立即卸载内容能保证"再点一次立即收起"
          的既有语义与测试契约（`search-results` 节点在收起后必须不存在），
          外壳只负责把高度这一维做平滑。 */}
      <ResultsShell open={showResults} testId="search-results-shell">
        {showResults && (
          <div className="search-results" data-testid="search-results">
            <div className="search-results-summary" data-testid="search-results-summary">
              {fileResults.length === 0
                ? t("search.resultsEmpty")
                : t("search.resultsCount", {
                    count: resultMatchTotal,
                    files: Object.keys(resultFileCounts).length,
                  })}
              {resultsTruncated && fileResults.length > 0
                ? ` · ${t("search.tooManyResults", { count: fileResults.length })}`
                : ""}
            </div>
            {fileResults.map((r, i) => (
              <div
                key={`${r.fileKey}:${r.line}:${i}`}
                className="search-result-item"
                data-testid="search-result-item"
                title={`${r.filePath || r.fileName}:${r.line}`}
                onClick={() => handleResultClick(r, 0)}
              >
                <span className="search-result-file" data-testid="search-result-file" title={r.filePath}>
                  {r.fileName || r.filePath || "—"}
                  <span className="search-result-file-count">
                    ({resultFileCounts[r.fileKey] ?? r.ranges.length})
                  </span>
                  {/* v0.15.1 需求4：显示**状态栏口径**的行列（不是跳转用的文本空间行号），
                      两者在列表/表格/空行文档上会差好几行 —— 用户对照右下角就会发现不一致 */}
                  <span className="search-result-file-line">
                    :{r.statusLine ?? r.line}
                    {r.statusColumn !== undefined ? `:${r.statusColumn}` : ""}
                  </span>
                </span>
                <span className="search-result-line" data-testid="search-result-line">
                  {r.segments.map((seg, si) =>
                    seg.match ? (
                      /* v0.15.1 需求4 续修：**每个 `<mark>` 各自可点**，点哪一个就跳到
                         该行第几处。条幅是一行一条，同一行有 4 处命中时只有这一条结果，
                         若整条只认首处，用户点第 2/3/4 个高亮就只能回到行首
                         （实测症状「每一处都跳到第一个搜索」）。
                         事件要 stopPropagation，否则外层 onClick 又会按首处跳一次，
                         把刚定位好的当前项覆盖掉。 */
                      <mark
                        key={si}
                        className="search-result-match"
                        data-testid="search-result-match"
                        data-hit-index={seg.hitIndex ?? si}
                        style={{ cursor: "pointer" }}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleResultClick(r, seg.hitIndex ?? si);
                        }}
                      >
                        {seg.text}
                      </mark>
                    ) : (
                      <span key={si}>{seg.text}</span>
                    ),
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </ResultsShell>
      {/* v0.15.0 R6b：**工作区**结果条幅。
          与「打开的文件」条幅互斥（同一时刻只有一个作用域生效），
          复用同一套 `.search-results / .search-result-item` 样式，视觉上一致。
          v0.15.1 需求6：同样套常驻外壳，让"进入/离开工作区作用域"引起的高度变化
          也走同一条过渡（否则切作用域时面板高度会一帧跳变）。 */}
      <ResultsShell open={scope === "workspace"} testId="search-workspace-results-shell">
        {scope === "workspace" && (
        <div className="search-results" data-testid="search-workspace-results">
          <div className="search-results-summary" data-testid="search-workspace-summary">
            {workspaceSearching ? (
              <span data-testid="search-workspace-progress">
                {t("search.workspaceSearching", {
                  scanned: workspaceScanned,
                  hits: workspaceTotal,
                  skipped: workspaceSkipped,
                })}
              </span>
            ) : workspaceTotal === 0 ? (
              t("search.resultsEmpty")
            ) : (
              t("search.resultsCount", {
                count: workspaceTotal,
                files: workspaceFiles.length,
              })
            )}
            {/* 进度摘要：跳过数与原因（大工作区时用户要知道"为什么没搜到某些文件"） */}
            {!workspaceSearching && workspaceSkipped > 0 ? (
              ` · ${t("search.workspaceSkippedCount", { count: workspaceSkipped })}`
            ) : (
              ""
            )}
            {/* 结果被 Rust 上限截断 */}
            {workspaceTruncated ? ` · ${t("search.workspaceTruncated")}` : ""}
            {/* 脏文档覆盖：告诉用户"已按内存内容校正"，避免以为结果不全 */}
            {workspaceReconciled > 0
              ? ` · ${t("search.workspaceReconciled", { count: workspaceReconciled })}`
              : ""}
            {/* 取消按钮：只在搜索进行中显示 */}
            {workspaceSearching && (
              <button
                type="button"
                className="search-cancel-btn"
                data-testid="search-workspace-cancel"
                title={t("search.workspaceCancel")}
                onClick={() => {
                  const qid = workspaceQueryRef.current;
                  if (qid) {
                    workspaceQueryRef.current = null;
                    void cancelWorkspaceSearch(qid);
                  }
                  setWorkspaceSearching(false);
                }}
              >
                {t("search.workspaceCancel")}
              </button>
            )}
          </div>
          {workspaceFiles.map((g) =>
            g.rows.map((r, ri) => (
              <div
                key={`${g.fileKey}:${r.line}:${ri}`}
                className="search-result-item"
                data-testid="search-workspace-result-item"
                title={`${r.filePath || g.fileName}:${r.line}`}
                onClick={() => handleWorkspaceResultClick(g, r, 0)}
              >
                <span
                  className="search-result-file"
                  data-testid="search-result-file"
                  // 工作区结果的关键信息：**相对路径**（同名文件在不同目录时靠它区分）
                  title={r.filePath}
                >
                  {g.fileName || r.filePath || "—"}
                  <span className="search-result-file-count">({g.matchCount})</span>
                  {/* v0.15.1 需求4：当前文档的工作区命中显示状态栏口径行列（见上方 stamp 表） */}
                  <span className="search-result-file-line">
                    :{workspaceStatusStamps[`${jumpKeyOf(r.fileKey)}:${jumpOccurrenceOf(r)}`]?.line ?? r.line}
                    {workspaceStatusStamps[`${jumpKeyOf(r.fileKey)}:${jumpOccurrenceOf(r)}`]?.column !== undefined
                      ? `:${workspaceStatusStamps[`${jumpKeyOf(r.fileKey)}:${jumpOccurrenceOf(r)}`]!.column}`
                      : ""}
                  </span>
                  {workspaceRoots && workspaceRoots.length > 0
                    ? <span className="search-result-file-path">{relPathOf(r.filePath, workspaceRoots)}</span>
                    : null}
                </span>
                <span className="search-result-line" data-testid="search-result-line">
                  {r.segments.map((seg, si) =>
                    seg.match ? (
                      /* 同「打开的文件」条幅：每个 `<mark>` 各自可点，落到行内第 hitIndex 处 */
                      <mark
                        key={si}
                        className="search-result-match"
                        data-testid="search-result-match"
                        data-hit-index={seg.hitIndex ?? si}
                        style={{ cursor: "pointer" }}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleWorkspaceResultClick(g, r, seg.hitIndex ?? si);
                        }}
                      >
                        {seg.text}
                      </mark>
                    ) : (
                      <span key={si}>{seg.text}</span>
                    ),
                  )}
                </span>
              </div>
            )),
          )}
        </div>
        )}
      </ResultsShell>
    </div>
  );
}

/**
 * 搜索面板「从搜索按钮顺滑出现 / 顺滑收回」动画的延迟卸载壳（v0.8.5 需求7 第三版）。
 *
 * 链路：StatusBar 搜索按钮 → useEditorStore.showSearch → EditorContainer 渲染本组件
 * （替代原先的条件渲染 SearchReplaceDialog）。
 *
 * 为什么需要壳：SearchReplaceDialog 关闭即被卸载，收回动画来不及播放。
 * 本壳采用「延迟卸载」模式（思路同 FileTree 的 SlideWrap）：
 * - 打开（active=true）→ 挂载内部面板，几何测量完成后播放呼出动画；
 * - 关闭（active=false）→ 先播「面板缩回搜索按钮」，动画结束后才真正卸载；
 * - 未打开过 → 不渲染任何 DOM（与原条件渲染行为一致，不引入常驻节点）。
 *
 * 第三版定稿：验收反馈"尾巴特效观感偏怪"，因此**整体去掉尾巴**，
 * 只保留搜索窗口本体从底栏搜索按钮顺滑冒出、再顺滑缩回按钮这一件事：
 * - --genie-from-y   面板下沿落到按钮上沿所需的位移（动画起点面板正好贴在按钮上）；
 * - --genie-origin-x 按钮中心相对面板左沿的横向位置，作为 transform-origin 的横向原点，
 *   面板收放时会朝按钮那一侧收拢 / 展开 —— 于是"从按钮里冒出来"这件事在视觉上成立。
 * 两个量都在开合瞬间各测一次（无监听、无持续开销），面板只做 transform（合成层属性），
 * 不做 opacity 动画（避免淡入期间背景透出的闪动）。具体编排见 SearchReplace.css。
 */
/**
 * 收回动画总时长：面板 0.38s 缩回按钮，定时留 60ms 余量。
 * 常量名与旧版保持一致（测试与调用方按此判断延迟卸载时机）。
 */
const GENIE_OUT_MS = 440;

export function GenieSearchDialog(props: SearchReplaceProps & { active: boolean }) {
  const { active, ...rest } = props;
  // mounted：内部面板是否挂载；closing：收回动画播放中；ready：几何变量是否已注入
  const [mounted, setMounted] = useState(active);
  const [closing, setClosing] = useState(false);
  const [ready, setReady] = useState(false);
  // effect 内判定"关闭前是否打开过"用 ref 兜底（避免 state 滞后一帧）
  const mountedRef = useRef(active);
  const shellRef = useRef<HTMLDivElement>(null);

  /**
   * 一次测量"按钮 ↔ 面板"的关系，注入出现/收回动画所需的两个 CSS 变量
   * （开合各一次，无监听、无持续开销）：
   * - --genie-from-y   面板下沿对齐按钮上沿所需的纵向位移
   *                    —— 起点即"窗口正好贴在搜索按钮上"，配合纵向压扁呈现"从按钮冒出"
   * - --genie-origin-x 按钮中心 x 相对面板左沿的位置
   *                    —— 作为 transform-origin 的横向原点，让面板朝按钮一侧收放
   * 测量失败（锚点或面板缺失）时退化为屏幕底部的常规上升动画。
   */
  const syncGenieVars = useCallback(() => {
    const shell = shellRef.current;
    // ⚠️ 必须指名搜索按钮：图片管理入口也带 `data-genie-anchor="image-manager"`，
    // 且在 DOM 中更靠前。用泛选择器 `[data-genie-anchor]` 会量到图片管理图标，
    // 搜索面板的出现/收回动画就会锚错位置（用户反馈"尾巴动画没了"）。
    const anchor = document.querySelector<HTMLElement>('[data-genie-anchor="search"]');
    const panel = shell?.querySelector<HTMLElement>(".search-replace");
    if (!shell || !anchor || !panel) return;
    const btn = anchor.getBoundingClientRect();
    const pn = panel.getBoundingClientRect();
    // 兜底：底栏锚点不可见（如被打印样式隐藏）时矩形全 0 —— 用常规上升动画，不至于不动
    const anchored = btn.width > 0 && btn.height > 0 && pn.width > 0;
    if (!anchored) {
      shell.style.setProperty("--genie-from-y", "200px");
      shell.style.setProperty("--genie-origin-x", "50%");
      return;
    }
    // 面板下沿对齐按钮上沿：>0 表示面板在按钮上方（常规情形）；
    // 面板被拖到贴着底栏时夹到 0，退化为"原地收放"而不是反向下坠
    const fromY = Math.max(0, Math.round(btn.top - pn.bottom));
    // 按钮中心相对面板左沿（可能落在面板外，此时面板朝按钮方向整体收拢，方向依然正确）
    const originX = Math.round(btn.left + btn.width / 2 - pn.left);
    shell.style.setProperty("--genie-from-y", `${fromY}px`);
    shell.style.setProperty("--genie-origin-x", `${originX}px`);
  }, []);

  useEffect(() => {
    if (active) {
      // 打开：清掉未完成的收回定时器，立即挂载并（测量后）播放呼出动画
      mountedRef.current = true;
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mountedRef.current) return;
    // 关闭：先播收回动画，结束后再真正卸载（此时组件卸载清理逻辑照常触发）
    setClosing(true);
    const timer = setTimeout(() => {
      mountedRef.current = false;
      setMounted(false);
      setClosing(false);
      setReady(false);
    }, GENIE_OUT_MS);
    return () => clearTimeout(timer);
  }, [active]);

  // 打开：等 SearchReplaceDialog 内部初始定位（居中）effect 完成后再测量——双层 rAF
  // 确保面板已落到最终位置（fixed 定位坐标就绪）；测量到位才挂 in 类开始播放动画，
  // 否则动画首帧会读到还没注入的 --genie-from-y 而跳一下。
  // 期间壳带 pending 类把面板藏起来（≈2 帧，用户不可感）。
  useEffect(() => {
    if (!mounted || closing || ready) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        syncGenieVars();
        // 即使测量失败也放行：面板照常显示（fail-open）
        setReady(true);
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [mounted, closing, ready, syncGenieVars]);

  // 关闭：同步重测（面板可能已被拖拽移动，缩回轨迹须按当前位置连回按钮）。
  // 用 useLayoutEffect：几何变量在浏览器绘制前就位，收回动画的每一帧都按新位置播放
  useLayoutEffect(() => {
    if (closing) syncGenieVars();
  }, [closing, syncGenieVars]);

  if (!mounted) return null;
  const stateClass = closing
    ? "search-genie-out"
    : ready
      ? "search-genie-in"
      : "search-genie-pending";
  return (
    // 壳本身无定位样式（面板自身 fixed 定位），仅承载状态类驱动 CSS 动画
    <div
      ref={shellRef}
      className={`search-genie ${stateClass}`}
      data-testid="search-genie"
    >
      <SearchReplaceDialog {...rest} />
    </div>
  );
}
