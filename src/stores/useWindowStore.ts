/**
 * v0.9.0 WP0/WP3：窗口级运行时状态。
 *
 * ## 为什么需要这个 store
 *
 * 每个 Tauri Webview 是独立 JS 上下文，因此所有 zustand store 的**内存态天然是
 * 窗口级**的。真正跨窗口共享的只有 localStorage。本 store 存放「必须显式归属到
 * 某个窗口」的运行时数据：
 *
 * - `folderPaths`：本窗口侧栏打开的文件夹列表（`useFileStore.openFolders` 的
 *   内存态已是窗口级，这里存一份**规范化镜像**，作为上报会话快照 / 增删 watcher
 *   的单一数据源）；
 * - `isPrimary`：本窗口当前是否 Primary（随 Rust 的 `lightmd:becamePrimary` 变更）。
 *
 * ## 为什么不 persist
 *
 * 持久化由两处承担：
 * - main 窗口的文件夹列表：沿用 `useFileStore.sessionFolders`（v0.8.5 行为不变）；
 * - sec-* 窗口的文件夹列表：由会话快照 `session.json` 承担（Rust 侧）。
 */

import { create } from "zustand";

interface WindowState {
  /** 本窗口侧栏打开的文件夹路径（与 fileStore.openFolders 同序，头插 = 最新在前） */
  folderPaths: string[];
  /** 本窗口当前是否为 Primary（Rust 晋升时通过事件通知） */
  isPrimary: boolean;
  /** 整表替换（由 fileStore.openFolders 的镜像 effect 调用） */
  setFolderPaths: (paths: string[]) => void;
  /** 加入一个文件夹（去重，头插；上限由 fileStore 的 MAX_OPEN_FOLDERS 统一约束） */
  addFolderPath: (path: string) => void;
  /** 移除一个文件夹（仅影响本窗口渲染与 watcher 引用） */
  removeFolderPath: (path: string) => void;
  clearFolderPaths: () => void;
  setPrimary: (v: boolean) => void;
}

export const useWindowStore = create<WindowState>((set) => ({
  folderPaths: [],
  isPrimary: false,

  setFolderPaths: (paths) => set({ folderPaths: paths }),

  addFolderPath: (path) =>
    set((s) => (s.folderPaths.includes(path) ? s : { folderPaths: [path, ...s.folderPaths] })),

  removeFolderPath: (path) =>
    set((s) => ({ folderPaths: s.folderPaths.filter((p) => p !== path) })),

  clearFolderPaths: () => set({ folderPaths: [] }),

  setPrimary: (v) => set({ isPrimary: v }),
}));
