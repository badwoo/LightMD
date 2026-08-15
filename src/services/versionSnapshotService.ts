/**
 * 版本快照服务 —— v0.4.0 功能4
 *
 * 存储策略（性能优先）：
 * - 快照内容存文件系统：{appDataDir}/lightmd-snapshots/{filePathHash}/{timestamp}.md
 * - 快照元数据存 localStorage（key: lightmd-snapshots）：{ [filePath: string]: SnapshotMeta[] }
 *
 * 快照规则：
 * - 每文件最多 5 条
 * - 第1条为初始版本（isInitial=true，受保护不销毁）
 * - 超过 5 条时销毁第2条（index=1），保留第1条
 * - 内容去重：与最新一条 hash 相同则不记录
 */
import { invoke } from "@tauri-apps/api/core";
import { appDataDir } from "@tauri-apps/api/path";
import { isTauri } from "./fileService";

const STORAGE_KEY = "lightmd-snapshots";
const MAX_SNAPSHOTS = 5;
/** diff 行数上限，超过则截断（性能保障） */
const DIFF_LINE_LIMIT = 5000;
/** 超过此行数降级为简单 diff（避免 LCS O(n*m) 内存爆炸） */
const LCS_MAX_LINES = 1500;

export interface SnapshotMeta {
  id: string;
  filePath: string;
  timestamp: number;
  size: number;
  contentPath: string;
  isInitial: boolean;
  contentHash: string;
}

export interface DiffLine {
  type: "add" | "remove" | "context";
  oldLineNo?: number;
  newLineNo?: number;
  content: string;
}

export interface SnapshotDiff {
  added: number;
  removed: number;
  lines: DiffLine[];
}

/**
 * djb2 字符串哈希（自实现，不引入 crypto）
 * 相同内容必然产生相同 hash，用于内容去重
 */
export function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

/** 根据基础路径的分隔符拼接路径，兼容 Windows/Unix */
function joinPath(base: string, ...parts: string[]): string {
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return [base, ...parts].join(sep);
}

/** 读取所有文件的快照元数据（localStorage 同步读取，O(1)） */
function loadAllMeta(): Record<string, SnapshotMeta[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** 写入所有文件的快照元数据（JSON.stringify 异常时静默跳过） */
function saveAllMeta(all: Record<string, SnapshotMeta[]>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // 配额不足或序列化失败，静默处理
  }
}

/** 创建目录（已存在则忽略） */
async function ensureDir(dir: string): Promise<void> {
  try {
    await invoke("create_dir", { path: dir });
  } catch {
    // 目录已存在或其他错误，忽略
  }
}

/**
 * LCS 行级 diff（小文件专用，行数 <= LCS_MAX_LINES）
 * 用 Uint16Array 节省内存（LCS 长度上限 1500，远小于 65535）
 */
function lcsDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const m = oldLines.length;
  const n = newLines.length;
  // dp[i][j] = oldLines[0..i-1] 与 newLines[0..j-1] 的 LCS 长度
  const dp: Uint16Array[] = [];
  for (let i = 0; i <= m; i++) dp.push(new Uint16Array(n + 1));
  for (let i = 1; i <= m; i++) {
    const row = dp[i];
    const prev = dp[i - 1];
    for (let j = 1; j <= n; j++) {
      row[j] = oldLines[i - 1] === newLines[j - 1]
        ? prev[j - 1] + 1
        : (prev[j] >= row[j - 1] ? prev[j] : row[j - 1]);
    }
  }
  // 回溯生成 diff
  const lines: DiffLine[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      lines.unshift({ type: "context", oldLineNo: i, newLineNo: j, content: oldLines[i - 1] });
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      lines.unshift({ type: "remove", oldLineNo: i, content: oldLines[i - 1] });
      i--;
    } else {
      lines.unshift({ type: "add", newLineNo: j, content: newLines[j - 1] });
      j--;
    }
  }
  while (i > 0) {
    lines.unshift({ type: "remove", oldLineNo: i, content: oldLines[i - 1] });
    i--;
  }
  while (j > 0) {
    lines.unshift({ type: "add", newLineNo: j, content: newLines[j - 1] });
    j--;
  }
  return lines;
}

/**
 * 简单 diff（大文件专用，O(n) 时间/空间）
 * 提取公共前缀和后缀，中间部分标记为 remove + add
 */
function simpleDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const lines: DiffLine[] = [];
  // 公共前缀
  let p = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (p < minLen && oldLines[p] === newLines[p]) {
    lines.push({ type: "context", oldLineNo: p + 1, newLineNo: p + 1, content: oldLines[p] });
    p++;
  }
  // 公共后缀
  let oEnd = oldLines.length - 1;
  let nEnd = newLines.length - 1;
  const suffix: DiffLine[] = [];
  while (oEnd >= p && nEnd >= p && oldLines[oEnd] === newLines[nEnd]) {
    suffix.unshift({ type: "context", oldLineNo: oEnd + 1, newLineNo: nEnd + 1, content: oldLines[oEnd] });
    oEnd--;
    nEnd--;
  }
  // 中间差异：先删除旧行，再新增新行
  for (let k = p; k <= oEnd; k++) {
    lines.push({ type: "remove", oldLineNo: k + 1, content: oldLines[k] });
  }
  for (let k = p; k <= nEnd; k++) {
    lines.push({ type: "add", newLineNo: k + 1, content: newLines[k] });
  }
  lines.push(...suffix);
  return lines;
}

export const versionSnapshotService = {
  /**
   * 记录快照（保存时调用）
   * - isInitial=true 时，若已有初始版本则不重复记录
   * - 内容 hash 与最新快照相同时不记录
   * - 超过 5 条时销毁第2条（保留第1条初始版本）
   */
  async recordSnapshot(filePath: string, content: string, isInitial = false): Promise<void> {
    if (!isTauri()) return;
    const all = loadAllMeta();
    const list = all[filePath] || [];
    const hash = hashString(content);

    // 初始版本去重：已有 initial 则跳过
    if (isInitial && list.some((m) => m.isInitial)) return;
    // 内容去重：与最新一条 hash 相同则跳过
    if (list.length > 0 && list[list.length - 1].contentHash === hash) return;

    const timestamp = Date.now();
    const id = `${timestamp}`;
    const dirHash = hashString(filePath);
    const appDir = await appDataDir();
    const rootDir = joinPath(appDir, "lightmd-snapshots");
    const subDir = joinPath(rootDir, dirHash);
    // 确保目录存在（两级）
    await ensureDir(rootDir);
    await ensureDir(subDir);
    const contentPath = joinPath(subDir, `${timestamp}.md`);

    // 写入快照内容文件（顺序 IO，极快）
    await invoke("write_file", { path: contentPath, content });

    const meta: SnapshotMeta = {
      id,
      filePath,
      timestamp,
      size: content.length,
      contentPath,
      isInitial,
      contentHash: hash,
    };
    list.push(meta);

    // 超过上限：保留第1条（index=0 受保护），从第2条（index=1）开始销毁
    while (list.length > MAX_SNAPSHOTS) {
      const victim = list[1];
      if (victim) {
        try {
          await invoke("delete_file", { path: victim.contentPath });
        } catch {
          // 文件可能已不存在，忽略
        }
      }
      list.splice(1, 1);
    }

    all[filePath] = list;
    saveAllMeta(all);
  },

  /** 获取某文件的所有快照元数据（按时间升序，第1条=初始版本） */
  getSnapshots(filePath: string): SnapshotMeta[] {
    const all = loadAllMeta();
    return all[filePath] || [];
  },

  /** 读取某快照的内容（惰性加载，不预加载） */
  async readSnapshotContent(meta: SnapshotMeta): Promise<string> {
    return await invoke<string>("read_file", { path: meta.contentPath });
  },

  /**
   * 计算两个内容的行级 diff
   * - 小文件（<= LCS_MAX_LINES 行）：LCS 动态规划，结果最优
   * - 大文件（> LCS_MAX_LINES 行）：简单前缀/后缀 diff，O(n)
   * - 超过 DIFF_LINE_LIMIT 行：只 diff 前 DIFF_LINE_LIMIT 行
   */
  diffContent(oldContent: string, newContent: string): SnapshotDiff {
    const oldAll = oldContent.split("\n");
    const newAll = newContent.split("\n");
    // 大文件截断（性能保障）
    const truncated =
      oldAll.length > DIFF_LINE_LIMIT || newAll.length > DIFF_LINE_LIMIT;
    const oldLines = truncated ? oldAll.slice(0, DIFF_LINE_LIMIT) : oldAll;
    const newLines = truncated ? newAll.slice(0, DIFF_LINE_LIMIT) : newAll;

    // 根据规模选择算法
    const lines =
      oldLines.length <= LCS_MAX_LINES && newLines.length <= LCS_MAX_LINES
        ? lcsDiff(oldLines, newLines)
        : simpleDiff(oldLines, newLines);

    let added = 0;
    let removed = 0;
    for (const l of lines) {
      if (l.type === "add") added++;
      else if (l.type === "remove") removed++;
    }
    return { added, removed, lines };
  },

  /** 使用某版本替换当前文件（读取快照内容并写回原文件路径） */
  async applySnapshot(meta: SnapshotMeta): Promise<string> {
    const content = await invoke<string>("read_file", { path: meta.contentPath });
    await invoke("write_file", { path: meta.filePath, content });
    return content;
  },

  /** 删除某文件的所有快照（文件被删除时清理） */
  async clearSnapshots(filePath: string): Promise<void> {
    const all = loadAllMeta();
    const list = all[filePath] || [];
    for (const m of list) {
      try {
        await invoke("delete_file", { path: m.contentPath });
      } catch {
        // 忽略单个文件删除失败
      }
    }
    delete all[filePath];
    saveAllMeta(all);
  },
};
