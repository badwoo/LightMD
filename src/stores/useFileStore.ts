import { create } from "zustand";
import { persist } from "zustand/middleware";

interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

interface FileState {
  rootPath: string | null;
  fileTree: FileNode[];
  /** 最近打开的文件（最多 50 条，F2 扩展上限） */
  recentFiles: { path: string; name: string; accessedAt: number }[];
  /** 最近打开的文件夹（最多 10 条，F3 新增） */
  recentFolders: { path: string; name: string; accessedAt: number }[];
  /** 收藏文件列表（后续阶段 G7 使用，预留持久化空数组） */
  favorites: { path: string; name: string; addedAt: number }[];
  // 临时打开的文件（非文件夹中的文件），在目录树中显示
  tempFiles: FileNode[];

  setRootPath: (path: string | null) => void;
  setFileTree: (tree: FileNode[]) => void;
  setRecentFiles: (files: { path: string; name: string; accessedAt: number }[]) => void;
  addRecentFile: (file: { path: string; name: string }) => void;
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
      recentFiles: [],
      recentFolders: [],
      favorites: [],
      tempFiles: [],

      setRootPath: (path) => {
        // F3：同时更新 rootPath 和 recentFolders（去重 + 头插 + 截断 10 条）
        // 合并到一次 set 调用，避免多次状态变更触发多次订阅通知
        if (path) {
          const name = getFolderName(path);
          set((state) => ({
            rootPath: path,
            recentFolders: [
              { path, name, accessedAt: Date.now() },
              ...state.recentFolders.filter((f) => f.path !== path),
            ].slice(0, 10),
          }));
        } else {
          set({ rootPath: null });
        }
      },
      setFileTree: (tree) => set({ fileTree: tree }),
      setRecentFiles: (files) => set({ recentFiles: files }),
      addRecentFile: (file) =>
        set((state) => {
          const filtered = state.recentFiles.filter((f) => f.path !== file.path);
          return {
            recentFiles: [
              { ...file, accessedAt: Date.now() },
              ...filtered,
            ].slice(0, 50),
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
      renameFileEntry: (oldPath, newPath, newName) =>
        set((state) => ({
          favorites: state.favorites.map((f) =>
            f.path === oldPath ? { ...f, path: newPath, name: newName } : f
          ),
          recentFiles: state.recentFiles.map((f) =>
            f.path === oldPath ? { ...f, path: newPath, name: newName } : f
          ),
        })),
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
    }),
    {
      name: "lightmd-file-store",
      // 仅持久化 recentFiles / recentFolders / favorites，不持久化动态数据
      partialize: (state) => ({
        recentFiles: state.recentFiles,
        recentFolders: state.recentFolders,
        favorites: state.favorites,
      }),
    }
  )
);
