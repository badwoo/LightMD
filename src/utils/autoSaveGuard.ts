/**
 * v0.13.0 需求3：自动保存写盘前的「三路判定」纯逻辑。
 *
 * ## 为什么需要它
 *
 * `useAutoSave` 此前只在 `isDirty` 时启动定时器（v0.8.2 需求7 起就是这样），
 * 看似已满足「只对有编辑改动的文档保存」。但真正的数据丢失点在于
 * **`save()` 写盘前从不读盘**：外部软件改了文件、而 LightMD 正开着它时，
 * 自动保存会把内存里的旧内容写回磁盘，外部编辑被**静默覆盖回退**。
 *
 * 已有的 `externallyChanged` 标记**不够**——它依赖 watcher 事件先到达前端，
 * 而事件可能因「目录未挂载」「mtime 去重命中」「Rust 回调调度晚于定时器」
 * 而迟到或缺失。所以必须在写盘前**直接读一次磁盘**自己判断。
 *
 * ## 三路判定
 *
 * | 磁盘内容 | 判定 | 动作 |
 * | --- | --- | --- |
 * | === 本应用最后一次写入的内容 | 无外部改动 | 正常写盘 |
 * | === 本次将要写入的内容 | 已是目标状态 | 跳过（免一次无效写盘） |
 * | 其它（第三方改动） | **冲突** | 不写盘 + 标记外部变更 + 提示 |
 *
 * 保守优先：任何无法确定的情况（读盘失败）都不写盘。
 */

/** 判定结果 */
export type AutoSaveDecision = "write" | "skip" | "conflict";

export interface AutoSaveJudgeInput {
  /** 刚从磁盘读到的内容（读盘失败时为 null） */
  diskContent: string | null;
  /** 本次准备写入的内容 */
  targetContent: string;
  /** 本应用最后一次写入该路径的内容（无记录时为 null） */
  lastSelfWritten: string | null;
}

/**
 * 三路判定（纯函数，便于单测真值表）。
 *
 * @returns
 * - `"write"`：磁盘无外部改动，可以安全写盘；
 * - `"skip"`：磁盘已是目标内容，无需写盘（省一次 IO + 一次版本快照）；
 * - `"conflict"`：磁盘已被第三方改动，**必须放弃本次自动保存**。
 */
export function judgeAutoSaveWrite(input: AutoSaveJudgeInput): AutoSaveDecision {
  const { diskContent, targetContent, lastSelfWritten } = input;
  // 读盘失败（文件被删/被锁/权限，或读到非字符串）→ 保守：不写盘
  if (typeof diskContent !== "string") return "conflict";
  // 磁盘已经是我们要写的内容 → 无需写盘
  if (diskContent === targetContent) return "skip";
  // 磁盘仍是本应用最后一次写的那份 → 无外部改动，正常写盘
  if (lastSelfWritten !== null && diskContent === lastSelfWritten) return "write";
  // 其余情况：磁盘内容既不是我们的目标、也不是我们上次写的 →
  // 一定是第三方改过（或我们从未写过此文件而磁盘已有不同内容）。
  // 保守放弃，交由用户手动 Ctrl+S 走「覆盖 / 另存为 / 取消」确认。
  return "conflict";
}

/** 读盘结果的短时缓存（避免连续两次自动保存之间的重复 IO） */
const DISK_READ_CACHE_MS = 200;

interface DiskReadCacheEntry {
  content: string | null;
  at: number;
}

const diskReadCache = new Map<string, DiskReadCacheEntry>();

/** 取缓存的读盘结果；过期条目惰性清理 */
export function getCachedDiskRead(path: string, now: number): string | null | undefined {
  const hit = diskReadCache.get(path);
  if (!hit) return undefined;
  if (now - hit.at > DISK_READ_CACHE_MS) {
    diskReadCache.delete(path);
    return undefined;
  }
  return hit.content;
}

/** 记录一次读盘结果（content 为 null 表示读盘失败） */
export function putCachedDiskRead(path: string, content: string | null, now: number): void {
  diskReadCache.set(path, { content, at: now });
}

/** 测试用：清空读盘缓存 */
export function __resetDiskReadCacheForTest(): void {
  diskReadCache.clear();
}
