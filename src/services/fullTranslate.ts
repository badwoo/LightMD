/**
 * fullTranslate —— 全文翻译核心逻辑（v0.6.1）
 *
 * 职责（纯函数，无 React/PM 依赖，便于单测）：
 * - splitDocumentForTranslation：按 markdown 块切分待译单元
 *   （代码围栏/公式块/frontmatter 原样跳过；超长块按句子边界二次切分；
 *   纯符号块过滤；相邻块合并到 MERGE_TARGET_CHARS 减少请求次数）
 * - rebuildTranslatedDocument：按单元偏移重组译文与原文
 * - runFullTranslateLoop：逐段串行翻译循环（依赖注入 translate 回调与中止判断）
 *
 * 设计约束：
 * - 复用 translateService 的单任务模型（Rust 侧一次一段，零后端改动）
 * - 完成后一次性重组回写，任何失败/中断路径原文零破坏
 */

/** 待译单元：start/end 为在原文中的字符偏移（end 不含） */
export interface TranslateUnit {
  start: number;
  end: number;
  text: string;
}

/** 单段翻译结果校验所需的最小字段（与 TranslateResultData 结构对齐） */
export interface UnitTranslateResult {
  translated: string;
  placeholdersIntact: boolean;
  finishReason: string;
}

/** 循环执行结果：translations 与 units 一一对应，失败项为 null */
export interface FullTranslateOutcome {
  translations: (string | null)[];
  /** 用户取消或外部中止（如切换标签页） */
  cancelled: boolean;
  /** 翻译失败（保留原文）的段数 */
  failedCount: number;
  /** 首个错误码（仅系统性错误如 AUTH/RATE 中止时非空） */
  errorCode: string | null;
  /** v0.6.3 P1-5：最后一个段级失败的错误码（全部段落失败时上报，不再固定 STREAM） */
  lastErrorCode: string | null;
}

/** 单块最大字符数（与选中翻译 MAX_SELECTION_CHARS 一致） */
export const MAX_BLOCK_CHARS = 4000;

/**
 * 相邻单元合并目标字符数（v0.6.1 优化）：
 * 间隙无文字（空行/纯符号块/空代码块）的相邻块合并为一个请求单元，
 * 摊薄每段请求的 system prompt 开销，减少请求次数
 */
export const MERGE_TARGET_CHARS = 2000;

/**
 * 裸 URL / 邮箱匹配 source（v0.6.2 优化）：
 * 这些内容无法翻译，从"是否可译"判断中剔除。
 * URL 以空白/括号/引号/中文标点为终止边界（避免贪婪吞掉后面的正文文字）
 * v0.6.3 P2-13：只存 source 不带 g 标志，使用时新建正则——
 * 避免模块级带 g 正则被误用于 .test()/.exec() 时的跨调用 lastIndex 状态泄漏
 */
const URL_OR_EMAIL_SOURCE =
  String.raw`(?:https?:\/\/|www\.)[^\s<>"')\]}，。；！？、]+|[\w.+-]+@[\w-]+\.[\w.-]+`;

/**
 * Markdown 链接语法匹配 source（v0.6.3 P1-6）：
 * `[text](url)` → 剔除语法结构，仅保留链接文字参与可译判断
 */
const MD_LINK_SOURCE = String.raw`\[([^\]]*)\]\([^)]*\)`;

/**
 * Markdown 图片语法匹配 source（v0.6.4）：
 * `![alt](url)` → 整体剔除（含 alt）——与 Rust mask_images 层对齐，图片不参与翻译
 */
const MD_IMAGE_SOURCE = String.raw`!\[[^\]]*\]\([^)]*\)`;

/**
 * 判断文本是否含可翻译内容（Unicode 字母）。
 * - v0.6.1 优化：纯符号块（--- 分割线、- 空列表项、*** 等）不含文字，跳过翻译避免 token 浪费
 * - v0.6.2 优化：裸 URL / 邮箱剔除后再判断——纯链接块（参考链接列表等）无可译文字，
 *   跳过不发请求；URL 夹杂在句子中时仍正常翻译（Rust mask 层占位符保护）
 * - v0.6.3 P1-6：纯数字块（如 "2024"）无字母文字，同样跳过
 * - v0.6.4：图片语法 ![alt](url) 整体剔除（含 alt）——纯图片块发请求会让 LLM
 *   因无可译正文返回空内容导致段失败；alt 是图片说明，不应参与可译性判断
 *   （与 Rust mask_images 层对齐：图片整体占位符化，alt 不翻译）
 */
export function hasTranslatableText(text: string): boolean {
  const stripped = text
    .replace(new RegExp(MD_IMAGE_SOURCE, "g"), "")
    .replace(new RegExp(MD_LINK_SOURCE, "g"), "$1")
    .replace(new RegExp(URL_OR_EMAIL_SOURCE, "gi"), "");
  return /\p{L}/u.test(stripped);
}

// ─── 切分 ────────────────────────────────────────────────

/** 判断行是否以代码围栏开头（``` 或 ~~~，允许 ≤3 个前导空格），返回围栏标记 */
function fenceMarker(line: string): string | null {
  const m = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
  return m ? m[1][0].repeat(3) : null;
}

/** 行去除首尾空白 */
const trimLine = (line: string) => line.trim();

/**
 * 宽松 YAML 行形态（v0.6.3 P1-1）：key: value / key: / 列表项 / 注释 / 空行。
 * 用于区分「frontmatter」与「以 --- 分割线开篇的正文」
 */
function isYamlLikeLine(line: string): boolean {
  if (!line) return true; // 空行
  if (line.startsWith("#")) return true; // 注释
  if (line === "-" || /^-\s+\S/.test(line)) return true; // 列表项
  // key: value 或 key:（key 允许字母/数字/下划线/连字符/点/中文）
  return /^[\w.\-\u4e00-\u9fa5]+\s*:(\s|$)/.test(line);
}

/**
 * 按块切分 markdown 文档为待译单元列表。
 *
 * 块规则：
 * - 空行分隔的连续非空行为一个普通块（标题/段落/列表/引用/表格等）
 * - 代码围栏块（``` / ~~~）、公式块（$$）、frontmatter（--- 包裹的文件头）跳过
 * - 普通块超过 MAX_BLOCK_CHARS 时按句子边界二次切分
 * - 间隙文本（空行/跳过的块）不出现在单元中，重组时原样保留
 */
export function splitDocumentForTranslation(markdown: string): TranslateUnit[] {
  const units: TranslateUnit[] = [];
  const lines = markdown.split("\n");

  // 每行起始偏移
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1; // +1 为 \n
  }

  let i = 0;
  // 普通块收集器：[startLine, endLine)
  let blockStart = -1;

  const flushBlock = (endLine: number) => {
    if (blockStart < 0) return;
    const start = lineStarts[blockStart];
    // 块末尾：最后一行内容结束（去掉该行尾换行）
    const lastLineIdx = endLine - 1;
    const lastLine = lines[lastLineIdx];
    const end = lineStarts[lastLineIdx] + lastLine.length;
    if (end > start) {
      const text = markdown.slice(start, end);
      // v0.6.1 优化：纯符号块（--- / - / *** 等）无文字字符，跳过不翻译
      if (hasTranslatableText(text)) {
        // v0.6.1 优化：相邻块合并 —— 与上一单元间隙无文字（空行/纯符号块/空代码块）
        // 且合并后不超 MERGE_TARGET_CHARS 时并入上一单元，减少请求次数。
        // 间隙中的代码围栏会先经 Rust mask 层占位符化，合并发送安全
        const last = units[units.length - 1];
        if (last) {
          const gap = markdown.slice(last.end, start);
          if (!hasTranslatableText(gap) && end - last.start <= MERGE_TARGET_CHARS) {
            last.end = end;
            last.text = markdown.slice(last.start, end);
            blockStart = -1;
            return;
          }
        }
        pushUnits(units, start, end, text);
      }
    }
    blockStart = -1;
  };

  // frontmatter 检测（v0.6.3 P1-1 修复）：
  // 首行为 --- 且闭合 --- 在合理行数内，且区间内每行均为宽松 YAML 形态。
  // 原实现只看「首行 --- + 后面某处还有 ---」，会把以分割线开篇的正文
  // （如 "---\n正文\n---\n结尾"）误判为 frontmatter，导致大片正文被整体跳过
  let frontmatterEnd = -1;
  if (lines.length > 0 && trimLine(lines[0]) === "---") {
    const maxScan = Math.min(lines.length, 51); // 首行 + 最多 50 行内容
    for (let k = 1; k < maxScan; k++) {
      const line = trimLine(lines[k]);
      if (line === "---") {
        frontmatterEnd = k; // 闭合行索引
        break;
      }
      if (!isYamlLikeLine(line)) {
        frontmatterEnd = -1; // 出现非 YAML 形态行 → 是普通分割线，不是 frontmatter
        break;
      }
    }
  }

  while (i < lines.length) {
    const line = lines[i];

    // frontmatter 区间（含闭合行）整体跳过
    if (frontmatterEnd >= 0 && i <= frontmatterEnd) {
      flushBlock(i);
      i = frontmatterEnd + 1;
      continue;
    }

    const trimmed = trimLine(line);

    // 空行：结束当前块
    if (!trimmed) {
      flushBlock(i);
      i++;
      continue;
    }

    // 代码围栏：收集到闭合围栏行
    const marker = fenceMarker(line);
    if (marker) {
      flushBlock(i);
      let j = i + 1;
      while (j < lines.length && !fenceMarker(lines[j])) j++;
      i = j + 1; // 跳过闭合行（若无闭合则到文件尾）
      continue;
    }

    // 公式块：$$ 单独成行开始，到下一个 $$ 行
    if (trimmed === "$$") {
      flushBlock(i);
      let j = i + 1;
      while (j < lines.length && trimLine(lines[j]) !== "$$") j++;
      i = j + 1;
      continue;
    }

    // 普通行：开启/延续块
    if (blockStart < 0) blockStart = i;
    i++;
  }
  flushBlock(lines.length);

  return units;
}

/** 将一个块加入单元列表：超长块按句子边界切分 */
function pushUnits(units: TranslateUnit[], start: number, end: number, text: string) {
  if (text.length <= MAX_BLOCK_CHARS) {
    units.push({ start, end, text });
    return;
  }
  for (const part of splitLongText(text, MAX_BLOCK_CHARS)) {
    units.push({
      start: start + part.start,
      end: start + part.end,
      text: part.text,
    });
  }
}

/** 句子边界字符（中文句末标点；英文 . ! ? 需后跟空白才算边界，见 splitLongText） */
const SENTENCE_END = /[。．！？…]/;

/**
 * 超长文本按边界切分为 ≤max 的片段（纯函数）。
 *
 * v0.6.3 P1-3 修复：切点优先级由「仅中文句末标点，否则硬切」改为
 *   行边界(\n) > 句末标点(含英文 . ! ? 后跟空白) > 空格 > 硬切
 * - 原实现无 ASCII 句点与换行，英文长段会被硬切在单词中间、
 *   超长表格会被切在行中间，产出结构损坏的 Markdown 片段
 * - 英文句点要求后跟空白/结尾，避免劈开 "3.14"、"example.com"、"Mr."
 */
export function splitLongText(text: string, max: number): { start: number; end: number; text: string }[] {
  const parts: { start: number; end: number; text: string }[] = [];
  let segStart = 0;

  while (segStart < text.length) {
    if (text.length - segStart <= max) {
      parts.push({ start: segStart, end: text.length, text: text.slice(segStart) });
      break;
    }
    const windowEnd = segStart + max;
    let cut = -1;

    // 1) 行边界：窗口内最后一个换行（含换行符），保证表格/列表行不被劈开
    const nl = text.lastIndexOf("\n", windowEnd - 1);
    if (nl > segStart) {
      cut = nl + 1;
    }

    // 2) 句末标点：窗口内最后一个句界（中文标点直接算；英文 . ! ? 需后跟空白/结尾）
    if (cut <= segStart) {
      for (let k = windowEnd; k > segStart; k--) {
        const ch = text[k - 1];
        const isSentenceEnd =
          SENTENCE_END.test(ch) ||
          ((ch === "." || ch === "!" || ch === "?") &&
            (k >= text.length || /\s/.test(text[k])));
        if (isSentenceEnd) {
          cut = k;
          break;
        }
      }
    }

    // 3) 空格：窗口内最后一个空格（不在单词/数字中间劈开）
    if (cut <= segStart) {
      const sp = text.lastIndexOf(" ", windowEnd - 1);
      if (sp > segStart) {
        cut = sp + 1;
      }
    }

    // 4) 无任何边界：硬切
    if (cut <= segStart) cut = windowEnd;

    parts.push({ start: segStart, end: cut, text: text.slice(segStart, cut) });
    // 跳过切点后的空白（换行/空格）
    let next = cut;
    while (next < text.length && /\s/.test(text[next])) next++;
    segStart = next;
  }
  return parts;
}

// ─── 重组 ────────────────────────────────────────────────

/**
 * 按单元偏移重组译文与原文。
 * translations 与 units 一一对应；null/空译文项保留原文。
 */
export function rebuildTranslatedDocument(
  original: string,
  units: TranslateUnit[],
  translations: (string | null)[]
): string {
  let result = "";
  let cursor = 0;
  for (let k = 0; k < units.length; k++) {
    const unit = units[k];
    const translated = translations[k];
    // 间隙文本原样保留
    if (unit.start > cursor) {
      result += original.slice(cursor, unit.start);
    }
    if (translated && translated.trim()) {
      result += translated;
    } else {
      result += original.slice(unit.start, unit.end);
    }
    cursor = unit.end;
  }
  if (cursor < original.length) {
    result += original.slice(cursor);
  }
  return result;
}

// ─── 任务上下文守卫（v0.6.3 P0-1）────────────────────────

/** 任务启动时的文档上下文快照 */
export interface TranslateContext {
  filePath: string | null | undefined;
  /** 外部内容替换计数（forceUpdateKey），同一文件被外部重载也会变化 */
  key: number;
}

/**
 * 构造「标签切换中止」判断（v0.6.3 P0-1 修复）。
 *
 * 原缺陷：shouldAbort 拿任务启动时闭包捕获的 filePath 与启动时写入的 ref 比较，
 * 两者恒等，中止检测结构性失效，切标签后译文会写入新文档。
 *
 * 正确模式：启动上下文（闭包快照）vs 当前活跃上下文（每次渲染刷新的 ref）。
 * 用户切走再切回同一文件时返回 false（写回原文档安全）。
 */
export function createContextAbortChecker(
  start: TranslateContext,
  getActive: () => TranslateContext,
  isCancelRequested: () => boolean,
): () => boolean {
  return () => {
    if (isCancelRequested()) return true;
    const active = getActive();
    return start.filePath !== active.filePath || start.key !== active.key;
  };
}

// ─── 执行循环 ────────────────────────────────────────────

/** v0.6.3 P1-4：RATE 退避基础间隔与重试上限（1s / 2s，单段最多 3 次尝试） */
const RATE_BACKOFF_BASE_MS = 1000;
const RATE_MAX_ATTEMPTS = 3;
/** v0.6.3 P1-4：连续 N 段因 RATE 重试耗尽失败 → 中止整轮（避免烧完配额） */
const RATE_CONSECUTIVE_ABORT = 3;
/** v0.6.3 P2-12：系统性 finish_reason，继续跑只会浪费配额 → 中止整轮 */
const SYSTEMATIC_FINISH_REASONS = new Set(["content_filter", "tool_calls"]);

/**
 * 逐段串行翻译循环（依赖注入，便于单测）。
 *
 * 失败策略：
 * - AUTH（Key 无效）系统性错误 → 立即中止，不继续浪费请求
 * - RATE（限流）→ 指数退避重试（1s/2s，单段最多 3 次）；
 *   连续 3 段重试耗尽 → 中止整轮并上报 RATE（v0.6.3 P1-4）
 * - 单段其他失败（网络/截断/占位符失配/finishReason 非 stop）→ 保留原文继续
 * - content_filter / tool_calls 等系统性 finish_reason → 中止整轮（v0.6.3 P2-12）
 * - shouldAbort() 为 true（用户取消/切换标签/退避期间中止）→ 中止并标记 cancelled
 */
export async function runFullTranslateLoop(
  units: TranslateUnit[],
  opts: {
    /** 翻译单段（调用方接线 translateService.translate 并做结果校验） */
    translateUnit: (text: string) => Promise<UnitTranslateResult>;
    /** 每完成一段回调（含失败段） */
    onProgress: (done: number) => void;
    /** 中止判断（用户取消/外部状态变化） */
    shouldAbort: () => boolean;
    /** 段级错误的错误码提取（TranslateServiceError → code） */
    errorCodeOf: (e: unknown) => string;
    /** v0.6.3 P1-4：退避等待（依赖注入便于测试，默认 setTimeout） */
    sleep?: (ms: number) => Promise<void>;
  }
): Promise<FullTranslateOutcome> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const translations: (string | null)[] = new Array(units.length).fill(null);
  let failedCount = 0;
  let cancelled = false;
  let done = 0;
  // v0.6.3 P1-5：段级失败的最后错误码（全部失败时上报，不再固定 STREAM）
  let lastErrorCode: string | null = null;
  // v0.6.3 P1-4：连续 RATE 重试耗尽段计数
  let consecutiveRate = 0;

  for (let k = 0; k < units.length; k++) {
    if (opts.shouldAbort()) {
      cancelled = true;
      break;
    }

    // v0.6.3 P1-4：RATE 指数退避重试（1s/2s，单段最多 3 次尝试），仅 RATE 重试
    let result: UnitTranslateResult | null = null;
    let errCode: string | null = null;
    let abortedDuringBackoff = false;
    for (let attempt = 0; attempt < RATE_MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await sleep(RATE_BACKOFF_BASE_MS * 2 ** (attempt - 1));
        // 退避期间外部中止（用户取消/切换标签）→ 不再重试
        if (opts.shouldAbort()) {
          abortedDuringBackoff = true;
          break;
        }
      }
      try {
        result = await opts.translateUnit(units[k].text);
        errCode = null;
        break;
      } catch (e) {
        errCode = opts.errorCodeOf(e);
        if (errCode !== "RATE") break; // 仅限流重试，其他错误立即退出重试
      }
    }
    if (abortedDuringBackoff) {
      cancelled = true;
      break;
    }

    if (errCode !== null) {
      // CANCELLED：外部取消（含用户触发新翻译任务），中止整个流程
      if (errCode === "CANCELLED") {
        cancelled = true;
        break;
      }
      // AUTH：Key 系统性错误，继续无意义
      if (errCode === "AUTH" || errCode === "NO_KEY") {
        return { translations, cancelled: false, failedCount, errorCode: errCode, lastErrorCode: errCode };
      }
      lastErrorCode = errCode;
      failedCount++;
      if (errCode === "RATE") {
        consecutiveRate++;
        // 连续多段限流重试耗尽 → 整轮中止，避免 N 段全部撞墙烧完配额
        // （failedCount 已先自增，中止时第三段失败也计入）
        if (consecutiveRate >= RATE_CONSECUTIVE_ABORT) {
          return { translations, cancelled: false, failedCount, errorCode: "RATE", lastErrorCode: "RATE" };
        }
      } else {
        consecutiveRate = 0;
      }
    } else if (result) {
      consecutiveRate = 0;
      // 占位符失配或截断 → 该段视为失败保留原文
      if (result.placeholdersIntact && result.finishReason === "stop" && result.translated.trim()) {
        translations[k] = result.translated;
      } else if (SYSTEMATIC_FINISH_REASONS.has(result.finishReason)) {
        // v0.6.3 P2-12：content_filter / tool_calls 等系统性值，继续跑剩余段只会浪费配额
        const code = result.finishReason === "content_filter" ? "PROVIDER" : "STREAM";
        return { translations, cancelled: false, failedCount, errorCode: code, lastErrorCode: code };
      } else {
        failedCount++;
      }
    }
    done++;
    opts.onProgress(done);
  }

  return { translations, cancelled, failedCount, errorCode: null, lastErrorCode };
}
