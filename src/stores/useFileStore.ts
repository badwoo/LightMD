import { create } from "zustand";

interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

interface FileState {
  rootPath: string | null;
  fileTree: FileNode[];
  recentFiles: { path: string; name: string; accessedAt: number }[];
  // 临时打开的文件（非文件夹中的文件），在目录树中显示
  tempFiles: FileNode[];

  setRootPath: (path: string | null) => void;
  setFileTree: (tree: FileNode[]) => void;
  setRecentFiles: (files: { path: string; name: string; accessedAt: number }[]) => void;
  addRecentFile: (file: { path: string; name: string }) => void;
  addTempFile: (file: FileNode) => void;
  removeTempFile: (path: string) => void;
  clearTempFiles: () => void;
}

export type { FileNode };

export const useFileStore = create<FileState>((set) => ({
  rootPath: null,
  fileTree: [],
  recentFiles: [],
  tempFiles: [],

  setRootPath: (path) => set({ rootPath: path }),
  setFileTree: (tree) => set({ fileTree: tree }),
  setRecentFiles: (files) => set({ recentFiles: files }),
  addRecentFile: (file) =>
    set((state) => {
      const filtered = state.recentFiles.filter((f) => f.path !== file.path);
      return {
        recentFiles: [
          { ...file, accessedAt: Date.now() },
          ...filtered,
        ].slice(0, 20),
      };
    }),
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
}));
