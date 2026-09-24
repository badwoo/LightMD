import { create } from "zustand";
import { persist } from "zustand/middleware";

interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  /** v0.8.4 需求7：修改时间（UNIX 毫秒）。可选——0/缺失 = 未知，排序时排最后 */
  modifiedMs?: number;
  /** v0.8.4 需求7：创建时间（UNIX 毫秒）。可选——0/缺失 = 未知，排序时排最后 */
  createdMs?: number;
}

/** v0.4.0：同时打开的文件夹条目 */
export interface OpenFolder {
  path: string;
  name: string;
  fileTree: FileNode[];
}

/** v0.4.0：同时打开文件夹数量上限（与 settings 的 loadLastFolderCount 上限一致） */
const MAX_OPEN_FOLDERS = 5;

/**
 * v0.8.3 需求1：最近打开文件条目上限。
 * 从 50 提升到 66（用户要求"记录最近打开的 66 个文档"）：
 * 头插 + 按 path 去重，超出后丢弃列表最末位（= 最早打开的那条）。
 */
export const MAX_RECENT_FILES = 66;

/**
 * v0.8.4 需求1b：最近打开文件条目。
 * stale = 旧路径已失效（文件被移动/外部删除）：条目保留并标记，
 * UI 显示淡黄 ⚠ + hover 提示；成功再次打开同一路径时清除。
 */
export interface RecentFile {
  path: string;
  name: string;
  accessedAt: number;
  /** 旧路径已失效标记（可选——旧持久化数据无此字段，读出为 undefined 即"正常"） */
  stale?: boolean;
}

interface FileState {
  /** 兼容字段：= openFolders[0]?.path ?? null，旧代码直接读取 */
  rootPath: string | null;
  /** 兼容字段：= openFolders[0]?.fileTree ?? []，旧代码直接读取 */
  fileTree: FileNode[];
  /** v0.4.0：同时打开的文件夹列表 */
  openFolders: OpenFolder[];
  /** 最近打开的文件（最多 MAX_RECENT_FILES=66 条，最新在前；v0.8.4 支持条目级 stale 标记） */
  recentFiles: RecentFile[];
  /** 最近打开的文件夹（最多 10 条，F3 新增） */
  recentFolders: { path: string; name: string; accessedAt: number }[];
  /**
   * 收藏文件列表（后续阶段 G7 使用，预留持久化空数组）。
   * v0.8.4 需求10（P2 拍板）：外部删除/移动时收藏条目同样标 stale（与最近打开行为统一），
   * UI 以 hover tooltip 提示，成功重新打开同一路径时语义上已失效（条目路径未变，暂不自动清除）。
   */
  favorites: { path: string; name: string; addedAt: number; stale?: boolean }[];
  // 临时打开的文件（非文件夹中的文件），在目录树中显示
  tempFiles: FileNode[];

  /** 兼容方法：替换 openFolders[0]（旧调用点保留） */
  setRootPath: (path: string | null) => void;
  /** 兼容方法：更新 openFolders[0].fileTree（旧调用点保留） */
  setFileTree: (tree: FileNode[]) => void;
  /** v0.4.0：添加打开的文件夹（去重，按 MAX_OPEN_FOLDERS 截断） */
  addOpenFolder: (path: string) => void;
  /** v0.4.0：移除指定文件夹 */
  removeOpenFolder: (path: string) => void;
  /** v0.4.0：更新指定文件夹的 fileTree */
  updateFolderTree: (path: string, tree: FileNode[]) => void;
  /** v0.4.0：检查路径是否在任一已打开文件夹下 */
  isPathInOpenFolders: (path: string) => boolean;
  setRecentFiles: (files: RecentFile[]) => void;
  addRecentFile: (file: { path: string; name: string }) => void;
  /**
   * v0.8.4 需求1b：把路径匹配的最近打开条目标记为 stale（文件已移动/外部删除，
   * 旧路径失效）。条目保留不清除，供用户找回文件。
   * 应用内移动场景由 renameFileEntry 调用；外部删除场景由 watcher 删除事件调用。
   */
  markRecentStale: (oldPath: string) => void;
  /**
   * v0.8.4 需求10（P2 拍板）：把路径匹配的收藏条目标记为 stale（文件已移动/外部删除）。
   * 与 markRecentStale 同构：路径归一化（\ → /）后比较；条目保留不清除。
   * 外部删除场景由 watcher 删除事件调用。
   */
  markFavoriteStale: (oldPath: string) => void;
  /** F3：新增最近打开的文件夹 */
  addRecentFolder: (folder: { path: string; name: string }) => void;
  /** F3：设置 recentFolders（用于启动恢复失败时移除条目） */
  setRecentFolders: (folders: { path: string; name: string; accessedAt: number }[]) => void;
  /** F3：从 recentFolders 中移除指定路径 */
  removeRecentFolder: (path: string) => void;
  /** 从 recentFiles 中移除指定路径（启动恢复失败时使用） */
  removeRecentFile: (path: string) => void;
  /** G7：添加到收藏（按 path 去重，头插，最多 50 条） */
  addFavorite: (file: { path: string; name: string }) => void;
  /** G7：从收藏中移除指定路径 */
  removeFavorite: (path: string) => void;
  /** G7：查询指定路径是否已收藏 */
  isFavorite: (path: string) => boolean;
  /** 重命名时联动更新收藏和最近文件中的路径和名称 */
  renameFileEntry: (oldPath: string, newPath: string, newName: string) => void;
  addTempFile: (file: FileNode) => void;
  removeTempFile: (path: string) => void;
  clearTempFiles: () => void;
  /** v0.8.2：整表写入「打开的文件」栏条目（与打开的标签同步） */
  setTempFiles: (files: FileNode[]) => void;
}

export type { FileNode };

/** 从文件夹路径中提取名称（兼容 Windows / Unix 路径） */
function getFolderName(path: string): string {
  // 去掉末尾分隔符再取末段
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || path;
}

export const useFileStore = create<FileState>()(
  persist(
    (set, get) => ({
      rootPath: null,
      fileTree: [],
      openFolders: [],
      recentFiles: [],
      recentFolders: [],
      favorites: [],
      tempFiles: [],

      // 兼容方法：替换 openFolders[0]（旧调用点保留，单文件夹语义）
      setRootPath: (path) => {
        // F3：同时更新 rootPath 和 recentFolders（去重 + 头插 + 截断 10 条）
        // v0.4.0：改为操作 openFolders[0]，同步维护 rootPath/fileTree
        if (path) {
          const name = getFolderName(path);
          set((state) => {
            const folder: OpenFolder = { path, name, fileTree: [] };
            return {
              // 替换为单个文件夹（兼容旧行为）
              openFolders: [folder],
              rootPath: path,
              fileTree: [],
              recentFolders: [
                { path, name, accessedAt: Date.now() },
                ...state.recentFolders.filter((f) => f.path !== path),
              ].slice(0, 10),
            };
          });
        } else {
          set({ rootPath: null, fileTree: [], openFolders: [] });
        }
      },
      // 兼容方法：更新 openFolders[0].fileTree（旧调用点保留）
      setFileTree: (tree) =>
        set((state) => {
          if (state.openFolders.length === 0) {
            // 没有已打开文件夹时仅同步 fileTree（极端兼容场景）
            return { fileTree: tree };
          }
          const openFolders = state.openFolders.map((f, i) =>
            i === 0 ? { ...f, fileTree: tree } : f
          );
          return { fileTree: tree, openFolders };
        }),
      // v0.4.0：添加打开的文件夹（去重，按 MAX_OPEN_FOLDERS 截断）
      // v0.8.2：**头插** —— 最新打开的文件夹排在第一位（侧栏该栏渲染在最上方），
      // 超出上限时丢弃最久未打开的那个（列表末位），与"最新在上"的语义一致。
      addOpenFolder: (path) => {
        if (!path) return;
        const name = getFolderName(path);
        set((state) => {
          // 去重：已存在则不重复添加（仅更新 recentFolders）
          if (state.openFolders.some((f) => f.path === path)) {
            return {
              recentFolders: [
                { path, name, accessedAt: Date.now() },
                ...state.recentFolders.filter((f) => f.path !== path),
              ].slice(0, 10),
            };
          }
          const folder: OpenFolder = { path, name, fileTree: [] };
          const openFolders = [folder, ...state.openFolders].slice(0, MAX_OPEN_FOLDERS);
          return {
            openFolders,
            // 同步兼容字段指向第一个文件夹（= 最新打开的那个）
            rootPath: openFolders[0]?.path ?? null,
            fileTree: openFolders[0]?.fileTree ?? [],
            recentFolders: [
              { path, name, accessedAt: Date.now() },
              ...state.recentFolders.filter((f) => f.path !== path),
            ].slice(0, 10),
          };
        });
      },
      // v0.4.0：移除指定文件夹，同步 rootPath/fileTree 指向新的第一个
      // v0.4.5 修复：同时从 recentFolders 中移除，避免下次启动时恢复已被用户关闭的文件夹
      // （recentFolders 仅用于启动恢复，不在 UI 中显示，因此同步移除无副作用）
      removeOpenFolder: (path) => {
        set((state) => {
          const openFolders = state.openFolders.filter((f) => f.path !== path);
          return {
            openFolders,
            rootPath: openFolders[0]?.path ?? null,
            fileTree: openFolders[0]?.fileTree ?? [],
            // 同步移除 recentFolders 中的对应条目，确保启动恢复不会载入已关闭的文件夹
            recentFolders: state.recentFolders.filter((f) => f.path !== path),
          };
        });
      },
      // v0.4.0：更新指定文件夹的 fileTree（若为第一个则同步 fileTree 兼容字段）
      updateFolderTree: (path, tree) => {
        set((state) => {
          const idx = state.openFolders.findIndex((f) => f.path === path);
          if (idx === -1) return state;
          const openFolders = state.openFolders.map((f, i) =>
            i === idx ? { ...f, fileTree: tree } : f
          );
          // 若更新的是第一个文件夹，同步 fileTree 兼容字段
          const fileTree = idx === 0 ? tree : state.fileTree;
          return { openFolders, fileTree };
        });
      },
      // v0.4.0：检查路径是否在任一已打开文件夹下
      // 严格匹配：路径等于文件夹路径，或以"文件夹路径+分隔符"开头，避免 /a/b 误匹配 /a/b-c
      isPathInOpenFolders: (path) =>
        get().openFolders.some(
          (f) => path === f.path || path.startsWith(f.path + "/") || path.startsWith(f.path + "\\")
        ),
      setRecentFiles: (files) => set({ recentFiles: files }),
      // v0.8.3 需求1：头插 + 按 path 去重 + 按 MAX_RECENT_FILES(66) 截断
      // （最新在首位；超出上限时列表末位 = 最早打开的那条被清除）
      // v0.8.4 需求1b：同路径成功再次打开时，匹配的旧条目被过滤、头插的新条目
      // 不带 stale 字段（= stale: false）——stale 清除逻辑天然由本入口完成
      addRecentFile: (file) =>
        set((state) => {
          const filtered = state.recentFiles.filter((f) => f.path !== file.path);
          return {
            recentFiles: [
              { ...file, accessedAt: Date.now() },
              ...filtered,
            ].slice(0, MAX_RECENT_FILES),
          };
        }),
      // v0.8.4 需求1b：路径匹配的条目标 stale: true（不删除条目）。
      // 路径归一化（\ → /）后比较，避免 Windows 下分隔符混用导致漏标。
      markRecentStale: (oldPath) =>
        set((state) => {
          const target = oldPath.replace(/\\/g, "/");
          return {
            recentFiles: state.recentFiles.map((f) =>
              f.path.replace(/\\/g, "/") === target ? { ...f, stale: true } : f
            ),
          };
        }),
      // v0.8.4 需求10（P2 拍板）：外部删除/移动时收藏条目同样标 stale，
      // 匹配逻辑与 markRecentStale 同构（归一化后精确匹配）
      markFavoriteStale: (oldPath) =>
        set((state) => {
          const target = oldPath.replace(/\\/g, "/");
          return {
            favorites: state.favorites.map((f) =>
              f.path.replace(/\\/g, "/") === target ? { ...f, stale: true } : f
            ),
          };
        }),
      addRecentFolder: (folder) =>
        set((state) => {
          const filtered = state.recentFolders.filter((f) => f.path !== folder.path);
          return {
            recentFolders: [
              { ...folder, accessedAt: Date.now() },
              ...filtered,
            ].slice(0, 10),
          };
        }),
      setRecentFolders: (recentFolders) => set({ recentFolders }),
      removeRecentFolder: (path) =>
        set((state) => ({
          recentFolders: state.recentFolders.filter((f) => f.path !== path),
        })),
      removeRecentFile: (path) =>
        set((state) => ({
          recentFiles: state.recentFiles.filter((f) => f.path !== path),
        })),
      // G7：添加收藏（按 path 去重，头插，最多保留 50 条）
      addFavorite: (file) =>
        set((state) => {
          // 已存在则不重复添加
          if (state.favorites.some((f) => f.path === file.path)) return state;
          return {
            favorites: [
              { ...file, addedAt: Date.now() },
              ...state.favorites,
            ].slice(0, 50),
          };
        }),
      // G7：移除收藏（按 path 过滤；不存在时无副作用，不报错）
      removeFavorite: (path) =>
        set((state) => ({
          favorites: state.favorites.filter((f) => f.path !== path),
        })),
      // G7：查询是否已收藏（读取最新状态，不触发订阅）
      isFavorite: (path) => get().favorites.some((f) => f.path === path),
      // 重命名时联动更新收藏和最近文件中的路径和名称
      // v0.8.4 需求1b：拆分原「favorites/recentFiles/tempFiles 统一原地更新」实现——
      // - tempFiles：原地改路径（「打开的文件」面板 = 活标签镜像，必须跟随新路径）
      // - favorites：原地改路径（用户维护的清单，不宜自动复制成两条——与最近打开刻意不同，S19）
      // - recentFiles：改为 stale 双条目语义——旧条目保留标 stale（⚠ 提示可能已变更位置），
      //   新路径条目经 addRecentFile 头插入列（按 path 去重，天然不冲突）。
      // 接口签名不变，调用方无需修改。
      renameFileEntry: (oldPath, newPath, newName) => {
        set((state) => ({
          favorites: state.favorites.map((f) =>
            f.path === oldPath ? { ...f, path: newPath, name: newName } : f
          ),
          // v0.8.0 修复 P11-1：侧栏"打开的文件"面板同步骤更新，
          // 否则重命名/移动后该条目仍指向旧路径（旧文件已不存在 → 幽灵条目）
          tempFiles: state.tempFiles.map((f) =>
            f.path === oldPath ? { ...f, path: newPath, name: newName } : f
          ),
        }));
        // 最近打开：先标旧条目 stale，再让新条目头插入列（顺序保证新条目在列表头部）
        get().markRecentStale(oldPath);
        get().addRecentFile({ path: newPath, name: newName });
      },
      addTempFile: (file) =>
        set((state) => {
          // 避免重复
          if (state.tempFiles.some((f) => f.path === file.path)) return state;
          return { tempFiles: [...state.tempFiles, file] };
        }),
      removeTempFile: (path) =>
        set((state) => ({
          tempFiles: state.tempFiles.filter((f) => f.path !== path),
        })),
      clearTempFiles: () => set({ tempFiles: [] }),
      // v0.8.2：「打开的文件」栏条目整表写入（与打开的标签严格同步，见 utils/tempFilesSync.ts）
      setTempFiles: (files) => set({ tempFiles: files }),
    }),
    {
      name: "lightmd-file-store",
      // 持久化 recentFiles / recentFolders / favorites（fileTree 清空，启动时重新读取）
      // Issue 1 修复：不再持久化 openFolders，避免 zustand persist 启动时自动恢复文件夹，
      // 绕过 startupRestore.ts 中 loadLastFolderOnStartup 开关检查。
      // 启动恢复逻辑只由 restoreRecentFolders 控制，确保开关关闭时不恢复任何文件夹。
      partialize: (state) => ({
        recentFiles: state.recentFiles,
        recentFolders: state.recentFolders,
        favorites: state.favorites,
      }),
    }
  )
);
