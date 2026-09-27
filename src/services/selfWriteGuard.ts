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

/** 测试用：清空指纹表 */
export function __resetSelfWriteGuardForTest(): void {
  records.clear();
}

/** 测试用：当前指纹条目数 */
export function __selfWriteGuardSize(): number {
  return records.size;
}
