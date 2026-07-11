/**
 * 启动恢复工具模块
 *
 * 把 F2（多文件恢复）和 F3（文件夹恢复）的核心逻辑抽取为纯函数，
 * 便于在 App.tsx 的 useEffect 中调用，也便于单元测试 mock。
 *
 * 设计要点：
 * 1. 直接从 localStorage 读取设置和 recentFiles/recentFolders，
 *    避免 zustand persist hydration 时机问题（与 App.tsx 现有启动恢复逻辑一致）
 * 2. 串行 await 打开文件，避免标签顺序混乱
 * 3. 失败文件/文件夹静默跳过并从 store 中移除该条目
 */

import { fileService as defaultFileService, isTauri } from "../services/fileService";

export interface RestoreResult {
  /** 实际成功恢复的条目数 */
  restored: number;
  /** 静默跳过的失败条目数 */
  skipped: number;
}

/** 从路径中提取文件名（兼容 Windows / Unix 路径） */
function getFileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** 从文件夹路径中提取名称 */
function getFolderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || path;
}

/** localStorage 的最小接口（便于测试注入） */
interface StorageLike {
  getItem(key: string): string | null;
}

/** fileService 的最小接口（便于测试注入） */
interface FileServiceLike {
  readFile(path: string): Promise<string>;
  exists?(path: string): Promise<boolean>;
  listDir?(path: string): Promise<unknown[]>;
}

/** 解析 localStorage 中的 lightmd-settings，返回 loadLastFile 相关字段 */
function readSettings(storage: StorageLike): {
  loadLastFileOnStartup: boolean;
  loadLastFileCount: number;
  loadLastFolderOnStartup: boolean;
  loadLastFolderCount: number;
} {
  // 默认值：loadLastFileOnStartup=true / loadLastFileCount=1 / loadLastFolderOnStartup=false / loadLastFolderCount=1
  const defaults = {
    loadLastFileOnStartup: true,
    loadLastFileCount: 1,
    loadLastFolderOnStartup: false,
    loadLastFolderCount: 1,
  };
  try {
    const raw = storage.getItem("lightmd-settings");
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    const s = parsed?.state || {};
    return {
      loadLastFileOnStartup: s.loadLastFileOnStartup ?? defaults.loadLastFileOnStartup,
      loadLastFileCount: s.loadLastFileCount ?? defaults.loadLastFileCount,
      loadLastFolderOnStartup: s.loadLastFolderOnStartup ?? defaults.loadLastFolderOnStartup,
      loadLastFolderCount: s.loadLastFolderCount ?? defaults.loadLastFolderCount,
    };
  } catch {
    return defaults;
  }
}

/** 解析 localStorage 中的 lightmd-file-store，返回 recentFiles 和 recentFolders */
function readFileStore(storage: StorageLike): {
  recentFiles: { path: string; name: string; accessedAt: number }[];
  recentFolders: { path: string; name: string; accessedAt: number }[];
} {
  try {
    const raw = storage.getItem("lightmd-file-store");
    if (!raw) return { recentFiles: [], recentFolders: [] };
    const parsed = JSON.parse(raw);
    const s = parsed?.state || {};
    return {
      recentFiles: Array.isArray(s.recentFiles) ? s.recentFiles : [],
      recentFolders: Array.isArray(s.recentFolders) ? s.recentFolders : [],
    };
  } catch {
    return { recentFiles: [], recentFolders: [] };
  }
}

/** 钳制到 [min, max] */
function clamp(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

/**
 * F2：启动恢复上次打开的文件（多文件）
 *
 * 串行打开 recentFiles 前 N 条，失败文件静默跳过并从 recentFiles 移除
 * N=1 时行为与 0.2.0 一致（向后兼容，单文件恢复）
 *
 * @param opts.storage localStorage 注入（默认 globalThis.localStorage）
 * @param opts.fileServiceImpl fileService 注入（默认真实 fileService）
 * @param opts.dispatchOpenFile 派发 openFile 事件
 * @param opts.removeRecentFile 从 recentFiles 中移除条目（store action）
 * @param opts.isTauriEnv 是否 Tauri 环境（默认用 isTauri()）
 */
export async function restoreRecentFiles(opts: {
  storage?: StorageLike;
  fileServiceImpl?: FileServiceLike;
  dispatchOpenFile: (detail: { path: string; content: string }) => void;
  removeRecentFile?: (path: string) => void;
  isTauriEnv?: boolean;
}): Promise<RestoreResult> {
  const storage = opts.storage ?? (typeof localStorage !== "undefined" ? localStorage : { getItem: () => null });
  const fileServiceImpl = opts.fileServiceImpl ?? defaultFileService;
  const isTauriEnv = opts.isTauriEnv ?? isTauri();

  const settings = readSettings(storage);
  if (!settings.loadLastFileOnStartup) {
    return { restored: 0, skipped: 0 };
  }
  if (!isTauriEnv) {
    return { restored: 0, skipped: 0 };
  }

  const { recentFiles } = readFileStore(storage);
  // 钳制 N 到 1-50（与 store setter 一致）
  const N = clamp(settings.loadLastFileCount, 1, 50);
  let filesToRestore = recentFiles.slice(0, N);

  // 回退兼容：旧版本无 recentFiles 持久化，使用 lightmd-last-file
  if (filesToRestore.length === 0) {
    const lastFile = storage.getItem("lightmd-last-file");
    if (lastFile) {
      filesToRestore = [{ path: lastFile, name: getFileName(lastFile), accessedAt: 0 }];
    }
  }

  if (filesToRestore.length === 0) {
    return { restored: 0, skipped: 0 };
  }

  let restored = 0;
  let skipped = 0;

  // 串行 await，避免标签顺序混乱
  for (const file of filesToRestore) {
    try {
      const content = await fileServiceImpl.readFile(file.path);
      opts.dispatchOpenFile({ path: file.path, content });
      restored++;
    } catch {
      // 文件可能已被删除/移动，静默跳过并从 recentFiles 中移除
      skipped++;
      try {
        opts.removeRecentFile?.(file.path);
      } catch {
        // 移除失败忽略
      }
      // 兼容旧版本：同时清除 lightmd-last-file
      if (file.path === storage.getItem("lightmd-last-file")) {
        try {
          (storage as Storage).removeItem?.("lightmd-last-file");
        } catch {
          // 忽略
        }
      }
    }
  }

  return { restored, skipped };
}

/**
 * F3：启动恢复上次打开的文件夹
 *
 * 仅恢复最后一个为活动 rootPath（其他作为历史保留在 recentFolders）
 * 失败时静默跳过并从 recentFolders 移除
 *
 * 修复 v0.3.0：恢复成功后必须派发 openFolder 事件，让 FileTree 重新加载文件树。
 * 仅调用 setRootPath 不会触发文件树加载（fileTree 不在 persist 范围内，重启后为 []）。
 *
 * @param opts.storage localStorage 注入（默认 globalThis.localStorage）
 * @param opts.fileServiceImpl fileService 注入（默认真实 fileService）
 * @param opts.setRootPath 设置当前 rootPath（store action）
 * @param opts.dispatchOpenFolder 派发 openFolder 事件，触发 FileTree 加载文件树
 * @param opts.removeRecentFolder 从 recentFolders 中移除条目（store action）
 * @param opts.isTauriEnv 是否 Tauri 环境（默认用 isTauri()）
 * @param opts.delayMs 启动延迟（等待文件恢复完成，默认 100ms）
 */
export async function restoreRecentFolders(opts: {
  storage?: StorageLike;
  fileServiceImpl?: FileServiceLike;
  setRootPath: (path: string) => void;
  dispatchOpenFolder?: (path: string) => void;
  removeRecentFolder?: (path: string) => void;
  isTauriEnv?: boolean;
  delayMs?: number;
}): Promise<RestoreResult> {
  const storage = opts.storage ?? (typeof localStorage !== "undefined" ? localStorage : { getItem: () => null });
  const fileServiceImpl = opts.fileServiceImpl ?? defaultFileService;
  const isTauriEnv = opts.isTauriEnv ?? isTauri();

  const settings = readSettings(storage);
  if (!settings.loadLastFolderOnStartup) {
    return { restored: 0, skipped: 0 };
  }
  if (!isTauriEnv) {
    return { restored: 0, skipped: 0 };
  }

  // 延迟执行，确保文件恢复完成
  if (opts.delayMs && opts.delayMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, opts.delayMs));
  }

  const { recentFolders } = readFileStore(storage);
  // 钳制 N 到 1-5（与 store setter 一致）
  const N = clamp(settings.loadLastFolderCount, 1, 5);
  const foldersToTry = recentFolders.slice(0, N);

  if (foldersToTry.length === 0) {
    return { restored: 0, skipped: 0 };
  }

  let restored = 0;
  let skipped = 0;

  // 仅恢复最后一个为活动 rootPath；从第一个开始尝试，遇到失败的移除并继续尝试下一个
  // 找到第一个能成功访问的文件夹作为活动 rootPath
  let activePath: string | null = null;
  for (const folder of foldersToTry) {
    try {
      // 检查文件夹是否可访问（listDir 成功即存在且是目录）
      if (fileServiceImpl.listDir) {
        await fileServiceImpl.listDir(folder.path);
      } else if (fileServiceImpl.exists) {
        const ok = await fileServiceImpl.exists(folder.path);
        if (!ok) throw new Error("folder not exists");
      }
      activePath = folder.path;
      restored++;
      break; // 仅恢复最后一个能访问的（按 recentFolders 顺序，第一个即为最近）
    } catch {
      skipped++;
      try {
        opts.removeRecentFolder?.(folder.path);
      } catch {
        // 移除失败忽略
      }
    }
  }

  if (activePath) {
    // 先派发 openFolder 事件，让 FileTree 加载文件树（setRootPath 仅修改 store，不触发文件树加载）
    opts.dispatchOpenFolder?.(activePath);
    opts.setRootPath(activePath);
  }

  return { restored, skipped };
}

/** 测试用：导出 getFileName/getFolderName 以便覆盖 */
export const _pathUtils = { getFileName, getFolderName };
