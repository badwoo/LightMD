/**
 * 启动恢复工具模块
 *
 * 把 F2（多文件恢复）和 F3（文件夹恢复）的核心逻辑抽取为纯函数，
 * 便于在 App.tsx 的 useEffect 中调用，也便于单元测试 mock。
 *
 * 设计要点：
 * 1. 直接从 localStorage 读取设置和恢复数据源，避免 zustand persist hydration 时机问题
 *    （与 App.tsx 现有启动恢复逻辑一致）
 * 2. 串行 await 打开文件，避免标签顺序混乱
 * 3. v0.8.5 需求6：最近打开为纯历史记录（永不删除）——文件/文件夹恢复失败时
 *    仅回调注入的标 stale action（⚠ 提示条目已失效），不再从清单中移除条目
 * 4. v0.8.5 需求6：文件夹恢复数据源 = sessionFolders（上次会话结束时的打开文件夹快照），
 *    与 recentFolders（纯历史）解耦；旧版本数据无 sessionFolders 时回退 recentFolders
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
  readFile(path: string, opts?: { silent?: boolean }): Promise<string>;
  exists?(path: string): Promise<boolean>;
  listDir?(path: string): Promise<unknown[]>;
}

/**
 * v0.9.5 问题2：localStorage key——退出时刻仍打开的「文件标签」快照
 * （App 层在 openTabs 变化时同步写入）。legacy 启动恢复以此优先为数据源,
 * 手动关闭的标签不再被恢复；无快照(旧版本升级)时回退 recentFiles 历史。
 */
export const OPEN_FILE_TABS_KEY = "lightmd-open-file-tabs";

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

/**
 * 解析 localStorage 中的 lightmd-file-store，返回启动恢复所需数据：
 * - recentFiles：最近打开文件（文件恢复数据源）
 * - sessionFolders：上次会话打开文件夹快照（文件夹恢复数据源，v0.8.5 需求6）。
 *   null = 持久化数据中无此字段（旧版本数据），由调用方回退到 recentFolders
 * - recentFolders：最近打开文件夹历史（仅作旧数据回退源，不再作为恢复数据源）
 */
function readFileStore(storage: StorageLike): {
  recentFiles: { path: string; name: string; accessedAt: number }[];
  sessionFolders: string[] | null;
  recentFolders: { path: string; name: string; accessedAt: number }[];
} {
  try {
    const raw = storage.getItem("lightmd-file-store");
    if (!raw) return { recentFiles: [], sessionFolders: null, recentFolders: [] };
    const parsed = JSON.parse(raw);
    const s = parsed?.state || {};
    return {
      recentFiles: Array.isArray(s.recentFiles) ? s.recentFiles : [],
      // 旧版本数据无 sessionFolders 字段 → 返回 null 触发回退；
      // 新版本数据显式空数组（用户上次没开文件夹）→ 保持空数组不回退
      sessionFolders: Array.isArray(s.sessionFolders) ? (s.sessionFolders as string[]) : null,
      recentFolders: Array.isArray(s.recentFolders) ? s.recentFolders : [],
    };
  } catch {
    return { recentFiles: [], sessionFolders: null, recentFolders: [] };
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
 * 串行打开 recentFiles 前 N 条，失败文件静默跳过并标记该条目 stale。
 * N=1 时行为与 0.2.0 一致（向后兼容，单文件恢复）
 *
 * v0.8.5 需求6：最近打开为纯历史——失败的文件（已被删除/移动）不再从 recentFiles
 * 中移除条目，改为回调注入的 markRecentStale 标记 ⚠ 提示。
 *
 * @param opts.storage localStorage 注入（默认 globalThis.localStorage）
 * @param opts.fileServiceImpl fileService 注入（默认真实 fileService）
 * @param opts.dispatchOpenFile 派发 openFile 事件
 * @param opts.markRecentStale 把恢复失败的文件条目标记为 stale（store action 注入）
 * @param opts.isTauriEnv 是否 Tauri 环境（默认用 isTauri()）
 */
export async function restoreRecentFiles(opts: {
  storage?: StorageLike;
  fileServiceImpl?: FileServiceLike;
  dispatchOpenFile: (detail: { path: string; content: string }) => void;
  markRecentStale?: (path: string) => void;
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

  // v0.9.5 问题2：优先以「退出时刻打开的文件标签快照」为恢复源——
  // recentFiles 是纯打开历史（关闭标签不移除），用它恢复会让手动关闭的
  // 标签在重启后复活；快照由 App 层在 openTabs 每次变化时同步写入。
  let filesToRestore: { path: string; name: string; accessedAt: number }[] = [];
  try {
    const raw = storage.getItem(OPEN_FILE_TABS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        filesToRestore = arr
          .filter((t: unknown): t is { path: string; name?: string } => {
            const e = t as { path?: unknown };
            return !!e && typeof e.path === "string" && e.path.length > 0;
          })
          .map((t) => ({
            path: t.path,
            name: typeof t.name === "string" && t.name ? t.name : getFileName(t.path),
            accessedAt: 0,
          }));
      }
    }
  } catch {
    // 快照损坏：清空后走历史回退
    filesToRestore = [];
  }

  // 回退兼容：无标签快照（旧版本升级）→ 按最近 N 条历史（旧行为）
  if (filesToRestore.length === 0) {
    // 钳制 N 到 1-50（与 store setter 一致）
    const N = clamp(settings.loadLastFileCount, 1, 50);
    filesToRestore = recentFiles.slice(0, N);
  }

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
      // v0.9.5 问题3：启动恢复读取失败(文件已删除/移动)静默处理——
      // 只标 ⚠ 供用户从最近打开自行知晓，不弹红色"读取文件失败"提示
      const content = await fileServiceImpl.readFile(file.path, { silent: true });
      opts.dispatchOpenFile({ path: file.path, content });
      restored++;
    } catch {
      // 文件可能已被删除/移动，静默跳过并标 stale（v0.8.5 需求6：条目永不删除）
      skipped++;
      try {
        opts.markRecentStale?.(file.path);
      } catch {
        // 标记失败忽略
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
 * F3 / v0.4.0：启动恢复上次打开的文件夹（支持多个）
 *
 * 行为分两种模式：
 * - 多文件夹模式（推荐，v0.4.0）：传入 addOpenFolder + updateFolderTree 时，
 *   按 count（或 settings.loadLastFolderCount）串行恢复 N 个文件夹，
 *   每个成功访问的文件夹调用 addOpenFolder + updateFolderTree。
 * - 兼容模式（旧调用）：未传入 addOpenFolder 时，仅恢复第一个能访问的文件夹为 rootPath，
 *   行为与 v0.3.0 完全一致（向后兼容，不破坏现有测试）。
 *
 * v0.8.5 需求6：恢复数据源 = sessionFolders（上次会话结束时的打开文件夹快照），
 * 与 recentFolders（最近打开历史）彻底解耦——关闭文件夹只更新快照，历史条目保留；
 * 旧版本持久化数据无 sessionFolders 字段时回退读取 recentFolders（升级无缝）。
 * 失败的文件夹静默跳过并标记该条目 stale（v0.8.5：不再从清单中移除）。
 *
 * @param opts.storage localStorage 注入（默认 globalThis.localStorage）
 * @param opts.fileServiceImpl fileService 注入（默认真实 fileService）
 * @param opts.setRootPath 设置当前 rootPath（兼容模式使用）
 * @param opts.dispatchOpenFolder 派发 openFolder 事件（兼容模式使用，触发 FileTree 加载文件树）
 * @param opts.markRecentFolderStale 把恢复失败的文件夹条目标记为 stale（store action 注入）
 * @param opts.isTauriEnv 是否 Tauri 环境（默认用 isTauri()）
 * @param opts.delayMs 启动延迟（等待文件恢复完成，默认 100ms）
 * @param opts.count v0.4.0：显式指定恢复数量（覆盖 settings.loadLastFolderCount）
 * @param opts.addOpenFolder v0.4.0：添加打开的文件夹（store action，传入则启用多文件夹模式）
 * @param opts.updateFolderTree v0.4.0：更新指定文件夹的 fileTree（接收 listDir 原始结果）
 * @param opts.watchFolder v0.8.4 需求10：恢复成功后注册文件夹 watcher（可选注入；
 *   启动恢复不走 openFolderAt，需在此补 watch 才能实时刷新；失败静默，不阻断恢复）
 */
export async function restoreRecentFolders(opts: {
  storage?: StorageLike;
  fileServiceImpl?: FileServiceLike;
  setRootPath?: (path: string) => void;
  dispatchOpenFolder?: (path: string) => void;
  markRecentFolderStale?: (path: string) => void;
  isTauriEnv?: boolean;
  delayMs?: number;
  /** v0.4.0：显式指定恢复数量（默认从 settings 读取） */
  count?: number;
  /** v0.4.0：传入则启用多文件夹恢复模式 */
  addOpenFolder?: (path: string) => void;
  /** v0.4.0：更新指定文件夹的 fileTree（接收 listDir 原始结果） */
  updateFolderTree?: (path: string, entries: unknown[]) => void;
  /** v0.8.4 需求10：恢复成功后注册文件夹 watcher */
  watchFolder?: (path: string) => Promise<void>;
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

  const store = readFileStore(storage);
  // v0.8.5 需求6：恢复数据源 = sessionFolders 会话快照（上次会话结束时的打开文件夹）；
  // 旧版本数据无该字段（null）时回退到 recentFolders 历史记录（升级无缝，行为与旧版一致）
  const folderPaths =
    store.sessionFolders ?? store.recentFolders.map((f) => f.path);
  // v0.4.0：count 优先，否则从 settings 读取，钳制到 1-5
  const N = opts.count != null ? clamp(opts.count, 1, 5) : clamp(settings.loadLastFolderCount, 1, 5);
  const foldersToTry = folderPaths.slice(0, N);

  if (foldersToTry.length === 0) {
    return { restored: 0, skipped: 0 };
  }

  let restored = 0;
  let skipped = 0;

  // v0.4.0 多文件夹模式：传入 addOpenFolder 时，串行恢复多个文件夹
  if (opts.addOpenFolder) {
    for (const path of foldersToTry) {
      try {
        // listDir 成功即文件夹存在且可访问，同时获取目录内容
        let entries: unknown[] = [];
        if (fileServiceImpl.listDir) {
          entries = await fileServiceImpl.listDir(path);
        } else if (fileServiceImpl.exists) {
          const ok = await fileServiceImpl.exists(path);
          if (!ok) throw new Error("folder not exists");
        }
        opts.addOpenFolder(path);
        opts.updateFolderTree?.(path, entries);
        // v0.8.4 需求10：多文件夹恢复模式不走 openFolderAt，在此补注册 watcher
        // （fire-and-forget：失败静默，与"恢复失败静默跳过"的整体风格一致，不阻断恢复）
        try {
          await opts.watchFolder?.(path);
        } catch {
          // watch 注册失败忽略（可用工具栏刷新/右键刷新兜底）
        }
        restored++;
      } catch {
        skipped++;
        // v0.8.5 需求6：恢复失败 = 文件夹可能已被删除/移动，仅标 stale（条目永不删除）
        try {
          opts.markRecentFolderStale?.(path);
        } catch {
          // 标记失败忽略
        }
      }
    }
    return { restored, skipped };
  }

  // 兼容模式（旧逻辑）：仅恢复第一个能访问的文件夹为 rootPath
  let activePath: string | null = null;
  for (const path of foldersToTry) {
    try {
      // 检查文件夹是否可访问（listDir 成功即存在且是目录）
      if (fileServiceImpl.listDir) {
        await fileServiceImpl.listDir(path);
      } else if (fileServiceImpl.exists) {
        const ok = await fileServiceImpl.exists(path);
        if (!ok) throw new Error("folder not exists");
      }
      activePath = path;
      restored++;
      break; // 仅恢复最后一个能访问的（按快照顺序，第一个即为最近）
    } catch {
      skipped++;
      // v0.8.5 需求6：恢复失败仅标 stale（条目永不删除）
      try {
        opts.markRecentFolderStale?.(path);
      } catch {
        // 标记失败忽略
      }
    }
  }

  if (activePath) {
    // 先派发 openFolder 事件，让 FileTree 加载文件树（setRootPath 仅修改 store，不触发文件树加载）
    opts.dispatchOpenFolder?.(activePath);
    opts.setRootPath?.(activePath);
  }

  return { restored, skipped };
}

/** 测试用：导出 getFileName/getFolderName 以便覆盖 */
export const _pathUtils = { getFileName, getFolderName };
