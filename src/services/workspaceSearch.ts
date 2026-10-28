/**
 * workspaceSearch —— 工作区全文搜索的前端服务层（v0.15.0 需求 R6b）。
 *
 * ## 职责边界
 * 本模块**只做**「调 Rust 命令 + 流式累积 + 竞态裁决 + 脏文档覆盖」这四件事，
 * 不认识 React、不碰 store、不渲染 UI：
 * - Rust 侧（`commands/workspace_search.rs`）负责扫盘、逐行匹配、批量推帧；
 * - `SearchReplace.tsx` 负责作用域切换与条幅渲染，通过回调消费本模块的结果。
 *
 * 这样分层的原因：条幅 UI 有大量既有逻辑（替换/跳转/选区），把搜索编排混进去会
 * 让两件事互相绑死；而"竞态裁决"（queryId 过期丢弃）与"脏文档覆盖"是纯粹的
 * 数据变换，必须能脱离 jsdom 精确单测。
 *
 * ## 三条硬纪律（设计 §5.3）
 *
 * 1. **`hits` 是增量，不是快照**：Rust 每次 flush 用 `std::mem::take` 把待发命中
 *    取走再发（见 workspace_search.rs 的 `hits: std::mem::take(&mut all_hits)`），
 *    所以前端**必须逐帧累加**。若当快照整批替换，用户会看到结果列表在最后一帧
 *    突然塌成"只剩最后 200 条"。
 *
 * 2. **旧帧绝不允许覆盖新结果**：换词/继续输入会立刻产生新 queryId；上一个查询的
 *    迟到帧（Rust 侧可能还在推，取消是协作式的）必须整体丢弃，否则用户刚清空的
 *    结果列表里会冒出上一次查询的命中。判定用「当前活跃 queryId」而不是时间戳：
 *    时间戳在快速连打时会误杀合法帧。
 *
 * 3. **脏文档覆盖**：工作区结果算的是**磁盘内容**。用户改了某个已打开文件但没保存时，
 *    磁盘上的文本与编辑器里的文本不一致 → 条幅显示"这行有"，点进去却看不到。
 *    因此对**已打开文件**必须用内存文本重新算命中；未打开的文件才信磁盘结果。
 *
 * ## 与既有 `searchEngine` 的关系
 * 脏文档重算直接复用 `collectFileResults`（同一套匹配/裁剪/occurrence 口径），
 * 这样工作区结果与「查找所有打开文件」的结果在**同一个文件上必然一致** ——
 * 用户不会因为换了作用域就看到同一行命中数不同。
 */

import { Channel, invoke } from "@tauri-apps/api/core";
import { collectFileResults, type SearchFileResult, type SearchLineSegment } from "../utils/searchEngine";
import { pathCompareKey } from "../utils/path";

// ─── 与 Rust DTO 对齐的类型（serde rename_all = "camelCase"）────────────

/** 单条命中（与 Rust `WorkspaceHit` 同构；字段已 camelCase） */
export interface WorkspaceHit {
  filePath: string;
  /** 1 基行号 */
  line: number;
  /** 1 基列号（按**字符**计，不是字节 —— 中文文档下字节列号无意义） */
  column: number;
  /** 命中长度（字符数） */
  length: number;
  /**
   * 该命中在**本文件全部命中**中的 0 基序号。
   *
   * 跳转必须靠它而不是行号：工作时结果算在磁盘源码空间，跳过去后目标文档可能处于
   * 阅读模式（PM 渲染文本空间），行号必然错位，而"第 N 次出现"的次序是稳定的。
   * 与 `SearchJumpTarget.occurrence` 同口径，可直接透传。
   */
  occurrence: number;
  /** 行摘要（超长行已按命中处裁剪，可直接展示） */
  snippet: string;
}

/** 跳过原因计数（与 Rust `SkipSummary` 同构） */
export interface SkipSummary {
  hiddenDir: number;
  excludedDir: number;
  extFiltered: number;
  tooLarge: number;
  binary: number;
  readError: number;
  symlinkLoop: number;
}

/** 一帧进度（与 Rust `WorkspaceSearchProgress` 同构） */
export interface WorkspaceSearchProgress {
  queryId: string;
  /** ⚠️ **增量**：只包含这次 flush 新产出的命中（见模块头纪律 1） */
  hits: WorkspaceHit[];
  done: boolean;
  filesScanned: number;
  filesSkipped: number;
  skippedReasons: SkipSummary;
  truncated: boolean;
}

/** 搜索选项（与 Rust `SearchOptionsDto` 同构） */
export interface WorkspaceSearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  /**
   * 正则。**首版禁用**：Rust 侧 `regex=true` 直接返回错误，因为 JS `RegExp`
   * 的 lookbehind/回溯语义在 Rust DFA 引擎里不等价，静默换语义会让同一关键词在
   * 两个作用域下结果不同（比不支持更糟）。UI 必须显式提示而不是静默失败。
   */
  regex: boolean;
}

/** 搜索请求（与 Rust `WorkspaceSearchRequest` 同构） */
export interface WorkspaceSearchRequest {
  queryId: string;
  /** 搜索根（`openFolders`）。Rust 侧会自行去重/跳过不存在项 */
  roots: string[];
  query: string;
  options: WorkspaceSearchOptions;
  /** 参与搜索的扩展名（**不含点**、小写）；空数组 = 用 Rust 默认 Markdown/文本集 */
  includeExt?: string[];
  /** 单文件字节上限；缺省 2 MiB */
  maxFileBytes?: number;
  /** 结果上限；缺省 5000 */
  maxResults?: number;
}

// ─── 结果模型 ──────────────────────────────────────────────────

/**
 * 工作区结果里的一行命中（按文件分组后的一行）。
 *
 * 为什么复用 `SearchFileResult` 的字段而不是自己造一套：条幅 UI（高亮分段、文件名、
 * 行号、occurrence）在「打开的文件」与「工作区」两档必须长得一样，复用同一个形状
 * 才能共用渲染代码，也避免两套 occurrence 口径漂移。
 *
 * 与 `SearchFileResult` 的唯一差别：`segments` 由 `snippet` 生成（磁盘侧），
 * 而非 `collectFileResults` 的整行裁剪；脏文档覆盖时则整条换成本地重算的结果。
 */
export interface WorkspaceFileResult {
  /** 归一化路径比较键（`pathCompareKey`）；分组/合并/去重都按它 */
  fileKey: string;
  filePath: string;
  fileName: string;
  /** 该文件的全部命中（按行升序） */
  rows: SearchFileResult[];
  /** 该文件的命中总数（含同文件同行的多处命中；> rows.length 时表示一行多处） */
  matchCount: number;
}

/** 搜索最终结果 */
export interface WorkspaceSearchResult {
  /** 按文件分组（顺序 = 首次出现顺序，即 Rust 扫描顺序） */
  files: WorkspaceFileResult[];
  /** 命中总数（**文件级**口径，与条幅汇总一致） */
  totalHits: number;
  filesScanned: number;
  filesSkipped: number;
  skippedReasons: SkipSummary;
  /** 结果被上限截断（Rust `truncated`） */
  truncated: boolean;
  /** 被取消（用户换词/关面板）；结果可能不完整 */
  cancelled: boolean;
  /**
   * 被"脏文档覆盖"剔除的**命中数**（磁盘旧值被内存真值替换掉的量）。
   *
   * 用途：诊断/单测精确断言"改写了多少条"。UI 展示请用 `reconciledFiles`
   * （用户关心"几个文件按内存校正了"，而不是命中条数）。
   */
  reconciledDropped: number;
  /**
   * 被"脏文档覆盖"重算的**文件数**。
   *
   * 用途：UI 提示"其中 N 个已打开文件按内存内容校正"（i18n
   * `search.workspaceReconciled` 的 `{count}` 就是这个值）。
   * >0 说明磁盘与编辑器不一致 —— 用户看到的结果已是内存真值，不会出现
   * "搜索说这行有、点进去却没有"。
   */
  reconciledFiles: number;
}

/** 已打开文件的内存文本来源（脏文档覆盖用） */
export interface OpenFileText {
  /** 文件绝对路径（用于与 Rust 结果按 `pathCompareKey` 匹配） */
  filePath: string;
  /** 该文件的**实时**内存文本（可含 CRLF；`collectFileResults` 内部会归一化） */
  getText: () => string;
}

/** 进度回调（UI 累计显示：已扫描 / 跳过 / 命中） */
export interface WorkspaceSearchCallbacks {
  /** 每帧回调（**已累加**之后的进度 + 当前累计分组结果） */
  onProgress?: (snapshot: WorkspaceSearchSnapshot) => void;
  /** 正常结束（done 帧到达）；取消也会走这里，`cancelled=true` */
  onDone?: (result: WorkspaceSearchResult) => void;
  /** 出错（含 Rust 返回的 regex 拒绝错误） */
  onError?: (err: WorkspaceSearchError) => void;
}

/** 流式快照（UI 渲染用；不可变，别在 UI 里改它） */
export interface WorkspaceSearchSnapshot {
  queryId: string;
  files: WorkspaceFileResult[];
  totalHits: number;
  filesScanned: number;
  filesSkipped: number;
  skippedReasons: SkipSummary;
  truncated: boolean;
}

// ─── 错误 ──────────────────────────────────────────────────────

/**
 * 错误码。Rust 侧统一用 `"CODE|status|message"` 三元组（与 translateService 同协议），
 * `PROVIDER|400|工作区范围暂不支持正则搜索…` 就是 regex 拒绝。
 */
export type WorkspaceSearchErrorCode =
  /** 正则被禁用（首版）—— UI 必须显式提示，不是静默失败 */
  | "REGEX_UNSUPPORTED"
  /** 未在 Tauri 环境（纯浏览器/单测未 mock） */
  | "NOT_TAURI"
  /** 其他（IPC 失败、参数错误等）；`detail` 原样带出以便排查 */
  | "OTHER";

export class WorkspaceSearchError extends Error {
  readonly code: WorkspaceSearchErrorCode;
  readonly detail: string;

  constructor(code: WorkspaceSearchErrorCode, detail: string) {
    super(detail || code);
    this.name = "WorkspaceSearchError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * 把 Rust 的错误串归一成 `WorkspaceSearchError`。
 *
 * 为什么按**内容**而不仅按 code 判 regex：Rust 的拒绝串是
 * `PROVIDER|400|工作区范围暂不支持正则搜索…`，首个字段是 `PROVIDER`（复用了
 * provider 错误码族），只看 code 会误判成普通 provider 错误。这里同时检查中文关键词，
 * 确保即使将来 Rust 改了 code 也能认出"这是正则拒绝"并给出正确提示。
 */
export function parseWorkspaceSearchError(err: unknown): WorkspaceSearchError {
  const raw =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : String(err ?? "");
  if (/正则|regex/i.test(raw) && /不支持|禁用|not\s*support/i.test(raw)) {
    return new WorkspaceSearchError("REGEX_UNSUPPORTED", raw);
  }
  return new WorkspaceSearchError("OTHER", raw);
}

// ─── queryId 与活跃查询管理 ──────────────────────────────────────

/**
 * 生成一次性查询 id。
 *
 * 为什么不用 `crypto.randomUUID()` 兜底：该 API 在部分 WebView2 老版本与非安全上下文
 * 下缺失，而 queryId 只是**进程内**去重键（不跨设备、不做安全用途），时间戳 + 递增
 * 计数已足够且零依赖、零异常分支。
 */
let querySeq = 0;
export function createWorkspaceQueryId(prefix = "ws"): string {
  querySeq = (querySeq + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}-${querySeq.toString(36)}`;
}

/**
 * 活跃查询登记表（调用侧单例）。
 *
 * 为什么是模块级而不是每次调用传参：`cancel` 必须能从**任意**调用点（面板关闭、
 * 换词、组件卸载）生效，而关闭路径往往拿不到当初那次 `searchWorkspace` 的局部变量。
 *
 * 只存"当前活跃的那一个"：工作区搜索是单任务模型（用户换词就是换查询），同时开多个
 * 会让结果列表互相干扰，也没有 UI 能表达"两个并行的搜索"。
 */
let activeQueryId: string | null = null;

/** 当前活跃查询 id（测试/诊断用；无活跃查询时为 null） */
export function getActiveWorkspaceQueryId(): string | null {
  return activeQueryId;
}

/**
 * 取消当前活跃的工作区搜索。
 *
 * 语义：**立刻**把活跃查询清空（本地竞态裁决立即生效——旧帧来了也不再被接受），
 * 然后尽力通知 Rust 停止扫描。通知失败（面板已卸载/非 Tauri 环境）不影响本地状态，
 * 因为 Rust 侧取消是协作式的、且下一帧到达时也会被 queryId 判定丢弃。
 *
 * @param queryId 可选：只取消指定查询。不传则取消当前活跃查询。
 *   为什么要这个参数：换词时序是「先 start 新查询 → 再 cancel 旧的」，
 *   此时活跃 id 已经是新的，不带 id 调用会把新查询误杀。
 * @returns 是否确实取消了一个查询
 */
export async function cancelWorkspaceSearch(queryId?: string): Promise<boolean> {
  const target = queryId ?? activeQueryId;
  if (!target) return false;
  if (activeQueryId === target) activeQueryId = null;
  try {
    await invoke("cancel_workspace_search", { queryId: target });
  } catch {
    // Rust 侧已结束 / IPC 不可用：本地裁决已完成，忽略
  }
  return true;
}

// ─── 结果合并与脏文档覆盖（纯函数，可精确单测）──────────────────

/** 把路径归一成 fileKey（分组、去重、与内存文本匹配都用它） */
function fileKeyOf(filePath: string): string {
  return pathCompareKey(filePath || "");
}

/** 取展示用文件名（POSIX/Windows 分隔符都认） */
function fileNameOf(filePath: string): string {
  if (!filePath) return "";
  const norm = filePath.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

/**
 * 把一个 `snippet`（Rust 侧已裁剪的行摘要）切成高亮分段。
 *
 * 为什么用 `snippet.indexOf(query)` 而不是按 Rust 的 column 精确切：
 * Rust 的 snippet 是**按字符列**裁剪过的（可能带前后省略号），column 是整行的列号，
 * 两者坐标系不同；而 snippet 内部第几处出现直接可见。首处出现即该行首个命中
 * （Rust 每行按命中顺序产出，且 snippet 围绕该命中裁剪），因此按内容定位是等价的，
 * 且对"省略号导致列号偏移"免疫。
 *
 * 大小写口径必须与搜索一致（caseSensitive=false 时忽略大小写）。
 */
function segmentsFromSnippet(
  snippet: string,
  query: string,
  caseSensitive: boolean,
): { segments: SearchLineSegment[]; matchStart: number; matchEnd: number } {
  const text = snippet ?? "";
  const q = query ?? "";
  if (!text || !q) {
    return { segments: [{ text, match: false }], matchStart: 0, matchEnd: 0 };
  }
  const hay = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? q : q.toLowerCase();
  let at = hay.indexOf(needle);
  if (at < 0) at = 0;
  const end = Math.min(text.length, at + q.length);
  const segments: SearchLineSegment[] = [];
  if (at > 0) segments.push({ text: text.slice(0, at), match: false });
  segments.push({ text: text.slice(at, end), match: true });
  if (end < text.length) segments.push({ text: text.slice(end), match: false });
  return { segments, matchStart: at, matchEnd: end };
}

/** 把一条 Rust 命中转成条幅行（磁盘口径） */
function rowFromHit(hit: WorkspaceHit, query: string, caseSensitive: boolean): SearchFileResult {
  const snippet = hit.snippet ?? "";
  const { segments, matchStart, matchEnd } = segmentsFromSnippet(
    snippet,
    query,
    caseSensitive,
  );
  return {
    fileKey: fileKeyOf(hit.filePath),
    filePath: hit.filePath,
    fileName: fileNameOf(hit.filePath),
    line: hit.line,
    column: hit.column,
    matchStart,
    matchEnd,
    lineText: snippet,
    segments,
    ranges: [{ start: matchStart, end: matchEnd }],
    /**
     * ⚠️ 本行**不填** `hitOffsets`（逐处全文偏移），这是有意的。
     *
     * Rust 只给 `line`/`column`/`snippet`，**没有**全文偏移；而 snippet 是按命中处裁剪
     * 过的摘要（可能带前后省略号），`matchStart` 只是 snippet 内坐标 —— 拿它冒充全文
     * 偏移会让「就地跳转」落到完全无关的位置（比不跳更糟）。
     *
     * 所以工作区行只靠两条定位：
     * 1. 跨文本空间 → `occurrence`（Rust 的文件级 0 基序号）+ 本行 `hitIndex`；
     * 2. 同一文本空间 → `line`/`column`（Rust 每处命中一条 hit，`column` 是**逐处**的，
     *    不像「打开的文件」那样一行一条、只给首处）。
     */
    occurrence: hit.occurrence,
  };
}

/**
 * 累积器：把**增量**帧合并成按文件分组的结果。
 *
 * 与"每帧整批替换"的区别见模块头纪律 1。这里还有一个容易忽略的点：
 * **同文件的多次 flush 必须保留 occurrence 连续性** —— Rust 给每条命中算的是
 * "该文件全部命中中的序号"，跨 flush 也是连续的，所以直接信任 Rust 的 occurrence，
 * 前端不重编号（重编号会在"脏文档覆盖"时与本地重算的 occurrence 打架）。
 */
export interface WorkspaceAccumulator {
  addFrame(frame: WorkspaceSearchProgress): void;
  /** 当前快照（不可变拷贝，供 UI 渲染） */
  snapshot(): WorkspaceSearchSnapshot;
  /** 最终结果（含 cancel/truncated 标记） */
  finish(extra: { cancelled: boolean; reconciledDropped: number }): WorkspaceSearchResult;
  /** 累计命中数（= totalHits）。UI 进度用它，避免每帧遍历 */
  readonly totalHits: number;
}

/**
 * 创建累积器。
 *
 * @param req 原始请求（query / options 用于生成高亮分段；queryId 用于快照）
 */
export function createWorkspaceAccumulator(req: WorkspaceSearchRequest): WorkspaceAccumulator {
  /** fileKey → 分组（Map 保持插入顺序 = Rust 扫描顺序，用户看到"先扫到的在前"） */
  const groups = new Map<string, { filePath: string; rows: SearchFileResult[]; matchCount: number }>();
  let totalHits = 0;
  let filesScanned = 0;
  let filesSkipped = 0;
  let skippedReasons: SkipSummary = emptySkipSummary();
  let truncated = false;

  const addFrame = (frame: WorkspaceSearchProgress): void => {
    // 逐帧累加（纪律 1）：hits 是增量
    for (const hit of frame.hits ?? []) {
      if (!hit || !hit.filePath) continue;
      const key = fileKeyOf(hit.filePath);
      let g = groups.get(key);
      if (!g) {
        g = { filePath: hit.filePath, rows: [], matchCount: 0 };
        groups.set(key, g);
      }
      g.rows.push(rowFromHit(hit, req.query, !!req.options.caseSensitive));
      // 命中计数用 1（一处命中）而不是重算：Rust 的 occurrence 已经是文件级序号，
      // span 长度可能与 query 不等（全词/多字节），按 1 计最稳且与"命中数"语义一致
      g.matchCount += 1;
      totalHits += 1;
    }
    // 进度取**最新帧**（Rust 的 filesScanned/filesSkipped 是累计值，不是增量）
    if (Number.isFinite(frame.filesScanned)) filesScanned = Math.max(filesScanned, frame.filesScanned);
    if (Number.isFinite(frame.filesSkipped)) filesSkipped = Math.max(filesSkipped, frame.filesSkipped);
    if (frame.skippedReasons) skippedReasons = frame.skippedReasons;
    if (frame.truncated) truncated = true;
  };

  const toFiles = (): WorkspaceFileResult[] =>
    Array.from(groups.entries()).map(([key, g]) => ({
      fileKey: key,
      filePath: g.filePath,
      fileName: fileNameOf(g.filePath),
      rows: g.rows.slice(),
      matchCount: g.matchCount,
    }));

  return {
    addFrame,
    snapshot(): WorkspaceSearchSnapshot {
      return {
        queryId: req.queryId,
        files: toFiles(),
        totalHits,
        filesScanned,
        filesSkipped,
        skippedReasons,
        truncated,
      };
    },
    finish({ cancelled, reconciledDropped }): WorkspaceSearchResult {
      return {
        files: toFiles(),
        totalHits,
        filesScanned,
        filesSkipped,
        skippedReasons,
        truncated,
        cancelled,
        reconciledDropped,
        // 累积器本身不做脏文档覆盖（那是 `reconcileOpenFiles` 的职责），
        // 因此这里只有 `finish()` 的调用方显式传了命中数；文件数留给上层填。
        reconciledFiles: 0,
      };
    },
    get totalHits() {
      return totalHits;
    },
  };
}

/** 全零跳过统计（Rust 缺省值的 JS 同构） */
export function emptySkipSummary(): SkipSummary {
  return {
    hiddenDir: 0,
    excludedDir: 0,
    extFiltered: 0,
    tooLarge: 0,
    binary: 0,
    readError: 0,
    symlinkLoop: 0,
  };
}

/** 跳过总数（UI 汇总显示用；与 Rust `skip_total` 同口径） */
export function skipSummaryTotal(s: SkipSummary | null | undefined): number {
  if (!s) return 0;
  return (
    (s.hiddenDir || 0) +
    (s.excludedDir || 0) +
    (s.extFiltered || 0) +
    (s.tooLarge || 0) +
    (s.binary || 0) +
    (s.readError || 0) +
    (s.symlinkLoop || 0)
  );
}

/**
 * **脏文档覆盖**：用内存文本重算已打开文件的命中（纯函数核心）。
 *
 * ## 为什么必须做
 * 工作区结果是**磁盘**内容。用户改了已打开文件但没保存时：
 * - 磁盘有旧文本 → 条幅显示"第 42 行有"，点进去（编辑器是内存内容）却发现没有；
 * - 或内存有新增文本 → 明明搜得到却没出现在条幅里。
 * 两种都是"搜索结果与所见不一致"，用户会直接判定功能坏了。
 *
 * ## 规则
 * - 对**已打开**的文件（`openFiles` 里能按 `pathCompareKey` 匹配到）→ 丢弃该文件的
 *   全部磁盘命中，改用 `collectFileResults(memoryText, ...)` 重算（同一套口径）；
 * - 内存重算后**零命中** → 整个文件从结果里移除（不要留一个"0 处"的空分组）；
 * - 未打开的文件 → 原样保留磁盘结果（那里磁盘就是真值）。
 *
 * 顺带解决了"分组重复"：Rust 结果里同一文件可能因路径大小写/分隔符差异出现在
 * 两个 key 下；这里统一按 `pathCompareKey` 重组，天然合并。
 *
 * @param files        累积器产出的分组（磁盘口径）
 * @param req          原始请求（query / options 用于重算）
 * @param openFiles    已打开文件的内存文本（宿主提供；缺省则跳过覆盖，结果等同纯磁盘）
 * @returns 校正后的分组 + 被剔除的命中数
 */
export function reconcileOpenFiles(
  files: WorkspaceFileResult[],
  req: WorkspaceSearchRequest,
  openFiles: OpenFileText[] | null | undefined,
): { files: WorkspaceFileResult[]; dropped: number; reconciledFiles: number } {
  if (!Array.isArray(files) || files.length === 0) return { files: files ?? [], dropped: 0, reconciledFiles: 0 };
  if (!Array.isArray(openFiles) || openFiles.length === 0) {
    return { files, dropped: 0, reconciledFiles: 0 };
  }

  // 内存文本按 pathCompareKey 建索引（宿主可能同时给同一路径多次，取第一个）
  const memoryByKey = new Map<string, OpenFileText>();
  for (const f of openFiles) {
    if (!f || !f.filePath) continue;
    const key = fileKeyOf(f.filePath);
    if (!memoryByKey.has(key)) memoryByKey.set(key, f);
  }
  if (memoryByKey.size === 0) return { files, dropped: 0, reconciledFiles: 0 };

  const out: WorkspaceFileResult[] = [];
  let dropped = 0;
  // 被重算的文件数（UI 文案口径："其中 N 个已打开文件按内存内容校正"）
  let reconciledFiles = 0;
  for (const group of files) {
    const key = fileKeyOf(group.filePath || group.fileKey);
    const mem = memoryByKey.get(key);
    if (!mem) {
      // 未打开：磁盘即真值
      out.push(group);
      continue;
    }
    // 已打开：内存即真值 → 丢掉全部磁盘命中，按内存文本重算
    dropped += group.matchCount;
    reconciledFiles += 1;
    let content = "";
    try {
      content = mem.getText() ?? "";
    } catch {
      // getText 抛错（宿主实现异常）：宁可保留磁盘结果，也不要让整个搜索崩掉
      out.push(group);
      continue;
    }
    const res = collectFileResults(
      content,
      {
        query: req.query,
        caseSensitive: !!req.options.caseSensitive,
        wholeWord: !!req.options.wholeWord,
        useRegex: !!req.options.regex,
      },
      { fileKey: key, filePath: group.filePath, fileName: fileNameOf(group.filePath) },
    );
    if (res.results.length === 0) {
      // 内存里已无此命中 → 整个文件移除（不留"0 处"空分组）
      continue;
    }
    out.push({
      fileKey: key,
      filePath: group.filePath,
      fileName: fileNameOf(group.filePath),
      rows: res.results,
      matchCount: res.matchCount,
    });
  }
  return { files: out, dropped, reconciledFiles };
}

// ─── 主入口：执行一次工作区搜索 ──────────────────────────────────

/**
 * 在一个不存在的 root 下发一次空查询来探测 IPC 是否可用（未使用；保留说明）。
 *
 * 为什么不用它做能力探测：Rust 在"空 query"路径会立即返回 done 帧、不扫盘，
 * 但那仍是真实 IPC 往返，探测本身会产生副作用（登记/取消一次查询）。
 * 直接在实际请求上处理错误更简单、也更准确（`isTauri()` 已能覆盖绝大多数场景）。
 */

/**
 * 执行一次工作区搜索（流式）。
 *
 * ## 竞态裁决（纪律 2）
 * 调用即把本次 `queryId` 设为**活跃**；此后：
 * - 任何帧的 `queryId !== 活跃 id` → 整体丢弃（不回调、不累积）；
 * - 正常结束（done 帧）后清空活跃 id；
 * - 新查询自动取消旧查询（`activeQueryId` 被覆盖，旧帧靠 id 判定出局）；
 * - 被显式 `cancelWorkspaceSearch()` 取消时，**仍会回调 onDone** 但带 `cancelled=true`
 *   —— UI 需要知道"搜索结束了，只是结果不完整"，否则会一直转圈。
 *
 * ## 脏文档覆盖的时机
 * 只在**最终结果**上做一次（不是每帧）：每帧都重算所有已打开文件会把流式变成
 * O(N×帧) 的重计算，且中途结果本来就会变，覆盖意义不大。
 *
 * @returns 最终结果（正常/取消/截断）；出错时 throw `WorkspaceSearchError`
 */
export async function searchWorkspace(
  req: WorkspaceSearchRequest,
  callbacks: WorkspaceSearchCallbacks & { openFiles?: OpenFileText[] | null } = {},
): Promise<WorkspaceSearchResult> {
  // ① 正则：本地先行拦截（与 Rust 拒绝同口径），避免一次无意义的 IPC 往返
  if (req.options?.regex) {
    const err = new WorkspaceSearchError(
      "REGEX_UNSUPPORTED",
      "工作区范围暂不支持正则搜索，请改用普通文本",
    );
    callbacks.onError?.(err);
    // 关键：也要把本地状态清干净（若有旧的活跃查询）
    await cancelWorkspaceSearch().catch(() => undefined);
    throw err;
  }

  // 空查询：双方都立即返回空结果；本地直接给结果，不扫盘（省一次 IPC）
  if (!req.query) {
    const acc = createWorkspaceAccumulator(req);
    const result = acc.finish({ cancelled: false, reconciledDropped: 0 });
    callbacks.onDone?.(result);
    return result;
  }

  // ② 新查询取代旧查询：先本地切活跃 id（旧帧立即失效），再尽力通知 Rust
  const previous = activeQueryId;
  activeQueryId = req.queryId;
  if (previous && previous !== req.queryId) {
    void invoke("cancel_workspace_search", { queryId: previous }).catch(() => undefined);
  }

  const acc = createWorkspaceAccumulator(req);
  let finalSeen = false;
  let cancelled = false;
  let lastSnapshot: WorkspaceSearchSnapshot | null = null;
  /** 该帧是否仍属于本次查询（过期判定；纪律 2） */
  const isCurrent = (frameQueryId: string | undefined): boolean =>
    activeQueryId === req.queryId && (frameQueryId ?? req.queryId) === req.queryId;

  /**
   * 把"累积器快照"落成最终结果（含脏文档覆盖）。
   *
   * 单点构造的理由：done 帧路径、取消路径、invoke 正常返回但无 done 帧路径
   * 三者必须产出**同构**对象，否则 `onDone` 回调与 promise 返回值会不一致
   * （UI 用回调渲染、调用方用返回值判断，两处打架极难排查）。
   */
  const buildResult = (
    snap: WorkspaceSearchSnapshot,
    isCancelled: boolean,
  ): WorkspaceSearchResult => {
    const { files, dropped, reconciledFiles } = reconcileOpenFiles(snap.files, req, callbacks.openFiles);
    return {
      files,
      totalHits: files.reduce((n, f) => n + f.matchCount, 0),
      filesScanned: snap.filesScanned,
      filesSkipped: snap.filesSkipped,
      skippedReasons: snap.skippedReasons,
      truncated: snap.truncated,
      cancelled: isCancelled,
      reconciledDropped: dropped,
      reconciledFiles,
    };
  };

  /** done 帧到达时已构造好的结果（供 promise 返回同一份对象） */
  let doneResult: WorkspaceSearchResult | null = null;

  const channel = new Channel<WorkspaceSearchProgress>();
  channel.onmessage = (frame) => {
    if (!frame) return;
    // 旧帧/已取消：丢弃，绝不覆盖新结果（纪律 2）
    if (!isCurrent(frame.queryId)) return;
    if (finalSeen) return; // done 之后不应再有帧；防御性忽略

    acc.addFrame(frame);
    const snap = acc.snapshot();
    lastSnapshot = snap;
    callbacks.onProgress?.(snap);

    if (frame.done) {
      finalSeen = true;
      // done 帧到达：清活跃 id（此后任何迟到帧都会被 isCurrent 判假）
      if (activeQueryId === req.queryId) activeQueryId = null;
      doneResult = buildResult(snap, false);
      callbacks.onDone?.(doneResult);
    }
  };

  try {
    await invoke("search_workspace", { req, onProgress: channel });
  } catch (e) {
    // 本次查询已不是活跃查询 → 这是上一次查询的迟到错误，丢弃（不打扰用户）
    if (activeQueryId !== req.queryId && activeQueryId !== null) {
      if (lastSnapshot) {
        // 已有部分结果：按取消收尾，让 UI 不至于一直转圈
        const result = buildResult(lastSnapshot, true);
        callbacks.onDone?.(result);
        return result;
      }
      throw new WorkspaceSearchError("OTHER", "查询已被新的搜索取代");
    }
    if (activeQueryId === req.queryId) activeQueryId = null;
    // 已取消的查询报错属正常（Rust 侧可能因取消中断）：按取消收尾而非报错
    if (cancelled && lastSnapshot) {
      const result = buildResult(lastSnapshot, true);
      callbacks.onDone?.(result);
      return result;
    }
    const err = parseWorkspaceSearchError(e);
    callbacks.onError?.(err);
    throw err;
  }

  if (doneResult) return doneResult;

  // invoke 正常返回但没收到 done 帧：Rust 取消路径会 `return Ok(())` 提前结束
  if (activeQueryId === req.queryId) activeQueryId = null;
  cancelled = true;
  const result = buildResult(lastSnapshot ?? acc.snapshot(), true);
  callbacks.onDone?.(result);
  return result;
}

/** 测试用：重置模块级活跃查询状态 */
export function __resetWorkspaceSearchForTest(): void {
  activeQueryId = null;
  querySeq = 0;
}
