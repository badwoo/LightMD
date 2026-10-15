/**
 * v0.9.0 第二轮修复（问题3）：本应用自身写盘的「内容指纹」。
 *
 * ## 为什么需要它
 *
 * Rust 侧 `window::open_files::note_file_written` 会在 `write_file` 成功后按 mtime
 * 登记一次抑制，让紧随其后的 watcher 事件被去重。但「写盘返回」与「notify 回调线程
 * 被调度」之间始终存在**毫秒级竞态**：事件可能先于抑制登记到达 Rust 回调，于是
 * `lightmd:fileChanged` 被真的 emit 出来，前端在「清脏标记」之前收到它 →
 * 仅凭 `isDirty` 判定就把自己刚保存的文件当成「被外部修改」，右下角弹出
 * 「xxx 已被外部修改，保存前请确认」。
 *
 * ## 做法
 *
 * 记录「最近一次由本应用写盘的内容」，watcher 事件到达时读一次磁盘内容比对：
 * - 磁盘内容 === 本应用刚写入的内容 → 自身回声，直接忽略；
 * - 否则 → 真实外部变更，按既有逻辑处理（脏标签标记 + 提示 / 干净标签重载）。
 *
 * 用内容而非时间戳比对的好处：即使事件迟到（应用卡顿、聚合延迟），只要磁盘上仍是
 * 自己写的那份内容就绝不会误报；而用户随后继续输入（标签内容已变）也不会影响判断
 * ——比的是"我们写下去的内容"，不是"标签当前内容"。
 *
 * 开销：每条一个字符串引用 + 时间戳；上限 [`MAX_ENTRIES`] 条、TTL [`TTL_MS`] 毫秒，
 * 超龄条目在查询/写入时惰性清理。
 */

import { pathCompareKey } from "../utils/path";

/** 指纹保留时长：足够覆盖 watcher 事件的所有正常延迟路径 */
export const TTL_MS = 10_000;

/**
 * v0.13.0 返修（问题8）：**磁盘基线**的保留时长。
 *
 * 与 [`TTL_MS`] 的短 TTL 不同，基线必须活得足够久：自动保存的默认间隔是
 * **60 秒**，而短 TTL 只有 10 秒——若两者共用一张表，第二次自动保存时
 * `getLastSelfWritten` 已经过期返回 null，三路判定会把「磁盘仍是自己上次写的」
 * 误判成「第三方改过」，于是标记 `isExternallyChanged` 并弹
 * 「已在其他窗口保存，自动保存已暂停」。这就是用户报告的问题 8：
 * **没有任何外部程序改过文档，却收到该提示**。
 *
 * 基线只用于「磁盘是否被第三方改过」的判定，不参与 watcher 回声抑制
 * （回声抑制必须用短 TTL，否则会掩盖真实的外部修改）。
 */
export const BASELINE_TTL_MS = 6 * 60 * 60 * 1000;

/** 同时保留的路径数上限（LRU：超限淘汰最旧条目） */
export const MAX_ENTRIES = 32;

interface SelfWriteRecord {
  /** 本应用写入磁盘的完整内容 */
  content: string;
  /** 写入时刻（`Date.now()`） */
  at: number;
}
/** 路径比较键 → 最近一次自身写盘记录（Map 迭代序 = 插入序，用于 LRU 淘汰） */
const records = new Map<string, SelfWriteRecord>();

/**
 * v0.13.0 返修（问题8）：路径 → 「本应用所知的磁盘内容」基线。
 *
 * 写入时机：
 * - 打开文件时（读到的磁盘内容 = 当时的基线）；
 * - 本应用每次写盘后（[`noteSelfWrittenFile`] 内部同步登记）。
 *
 * 用途：自动保存写盘前的三路判定。磁盘内容 === 基线 ⇒ 自上次基线以来
 * 没有第三方改动 ⇒ 可以安全写盘。**没有基线时不能证明安全**，仍然保守放弃
 * （返回 conflict），但打开文件即登记基线，正常流程下不会缺。
 */
const baselines = new Map<string, SelfWriteRecord>();

/** 淘汰超龄条目（惰性调用，避免定时器） */
function prune(now: number): void {
  for (const [key, rec] of records) {
    if (now - rec.at > TTL_MS) records.delete(key);
  }
}

/**
 * 登记一次「本应用刚刚把 content 写入 path」。
 * 调用点集中在 `fileService.writeFile`，故手动保存 / 自动保存 / 另存为 / 批量保存
 * / 导出等所有路径自动覆盖，无需逐处适配。
 */
export function noteSelfWrittenFile(path: string, content: string): void {
  if (!path || typeof content !== "string") return;
  const now = Date.now();
  prune(now);
  const key = pathCompareKey(path);
  // 重新插入以刷新 LRU 顺序
  records.delete(key);
  records.set(key, { content, at: now });
  while (records.size > MAX_ENTRIES) {
    const oldest = records.keys().next().value;
    if (oldest === undefined) break;
    records.delete(oldest);
  }
  // v0.13.0 返修（问题8）：写盘后磁盘基线同步推进——本应用刚写的即当前磁盘状态。
  noteDiskBaseline(path, content);
}

/**
 * v0.13.0 返修（问题8）：登记「本应用所知的该路径磁盘内容」。
 *
 * **必须只在真正读过/写过磁盘时调用**，且**不能**放在通用的
 * `fileService.readFile` 里：自动保存的写盘前判定本身也要读盘，若读盘顺手
 * 推进基线，判定就会永远看到「磁盘 === 基线」→ 恒判为可写 → 外部编辑被静默覆盖。
 * 因此基线只在「打开文件」（拿到初始磁盘内容）与「本应用写盘成功」两处推进。
 */
export function noteDiskBaseline(path: string, content: string): void {
  if (!path || typeof content !== "string") return;
  const now = Date.now();
  pruneBaselines(now);
  const key = pathCompareKey(path);
  baselines.delete(key);
  baselines.set(key, { content, at: now });
  while (baselines.size > MAX_ENTRIES) {
    const oldest = baselines.keys().next().value;
    if (oldest === undefined) break;
    baselines.delete(oldest);
  }
}

/** 淘汰超龄基线（惰性调用，避免定时器） */
function pruneBaselines(now: number): void {
  for (const [key, rec] of baselines) {
    if (now - rec.at > BASELINE_TTL_MS) baselines.delete(key);
  }
}

/**
 * v0.13.0 返修（问题8）：取「本应用所知的该路径磁盘内容」。
 *
 * 优先返回最近一次**自身写盘**的内容（短 TTL，回声抑制窗口内最精确），
 * 否则回退到**磁盘基线**（长 TTL，打开文件时登记的初始内容）。
 *
 * 为什么需要基线：打开一个文件后编辑它、但**从未保存过**时，`records` 里
 * 没有任何条目 → 三路判定无法证明「磁盘未被第三方改过」→ 判为 conflict →
 * 自动保存被放弃并误报「已在其他窗口保存」。有了基线（= 打开时读到的内容），
 * 磁盘仍等于基线即可安全写盘。
 */
export function getKnownDiskContent(path: string): string | null {
  const self = getLastSelfWritten(path);
  if (self !== null) return self;
  if (!path) return null;
  const key = pathCompareKey(path);
  const rec = baselines.get(key);
  if (!rec) return null;
  if (Date.now() - rec.at > BASELINE_TTL_MS) {
    baselines.delete(key);
    return null;
  }
  return rec.content;
}

/** 测试用：清空磁盘基线 */
export function __resetDiskBaselineForTest(): void {
  baselines.clear();
}

/** 测试用：当前基线条目数 */
export function __diskBaselineSize(): number {
  return baselines.size;
}

/**
 * 给定磁盘内容是否就是本应用最近写入的那一份。
 *
 * @param path 事件里的文件路径（分隔符/大小写差异由 `pathCompareKey` 归一）
 * @param diskContent 刚刚读到的磁盘内容
 * @returns true = 自身写盘的回声，调用方应忽略这次 watcher 事件
 */
export function isSelfWrittenContent(path: string, diskContent: string): boolean {
  if (!path || typeof diskContent !== "string") return false;
  const key = pathCompareKey(path);
  const rec = records.get(key);
  if (!rec) return false;
  if (Date.now() - rec.at > TTL_MS) {
    records.delete(key);
    return false;
  }
  return rec.content === diskContent;
}

/**
 * 取本应用最近一次写入该路径的内容（v0.13.0 需求3）。
 *
 * 供自动保存写盘前的三路判定使用：磁盘内容若仍等于「我们上次写的」，说明期间
 * 没有第三方改过，可以放心写盘；否则说明磁盘已被改动，必须放弃本次自动保存
 * （否则会把外部编辑静默覆盖回退）。
 *
 * @returns 内容字符串；无记录或已过期时返回 null
 */
export function getLastSelfWritten(path: string): string | null {
  if (!path) return null;
  const key = pathCompareKey(path);
  const rec = records.get(key);
  if (!rec) return null;
  if (Date.now() - rec.at > TTL_MS) {
    records.delete(key);
    return null;
  }
  return rec.content;
}

/** 测试用：清空指纹表 */
export function __resetSelfWriteGuardForTest(): void {
  records.clear();
}

/** 测试用：当前指纹条目数 */
export function __selfWriteGuardSize(): number {
  return records.size;
}
