/**
 * v0.8.0 WP3 需求8：重命名服务（供 TabBar 与 FileTree 共用）
 *
 * 说明：受"不可修改 src/components/sidebar/**"约束，本任务不改动 FileTree.tsx，
 * 仅新建本服务供 TabBar 的"重命名"菜单项复用其核心逻辑（磁盘重命名 + store 联动）。
 * FileTree.tsx 既有的 handleRenameConfirm 保持不变，后续可平滑迁移到本服务。
 */
import { fileService, isTauri } from "./fileService";
import { useFileStore } from "../stores/useFileStore";
import { useEditorStore } from "../stores/useEditorStore";
import { getParentDir, joinPath } from "../utils/path";

/**
 * 同步已打开标签页的路径与名称到新路径（重命名联动）。
 * 同时同步全局 filePath（若当前活跃文件正是被重命名的那个）。
 */
export function syncOpenTabsAfterRename(
  oldPath: string,
  newPath: string,
  newName: string
): void {
  const { openTabs, filePath } = useEditorStore.getState();
  const tabIdx = openTabs.findIndex((t) => t.path === oldPath);
  if (tabIdx !== -1) {
    useEditorStore.setState((s) => ({
      openTabs: s.openTabs.map((t, i) =>
        i === tabIdx ? { ...t, path: newPath, name: newName } : t
      ),
    }));
  }
  if (filePath === oldPath) {
    useEditorStore.getState().openFile(newPath);
  }
}

/**
 * 磁盘文件重命名（含未挂载真实文件）。
 * 调用 Rust 重命名命令（Tauri 下）+ 同步收藏/最近文件 + 同步已打开标签页/全局 filePath。
 * @returns 是否成功（Tauri 下磁盘重命名失败返回 false）
 */
export async function renameFile(path: string, newName: string): Promise<boolean> {
  // 临时（untitled）标签 path 为空串，不走磁盘重命名，由调用方走 renameUntitledTab
  if (!path) return false;
  const newPath = joinPath(getParentDir(path), newName);
  if (isTauri()) {
    try {
      await fileService.renameFile(path, newPath);
    } catch {
      return false;
    }
  }
  useFileStore.getState().renameFileEntry(path, newPath, newName);
  syncOpenTabsAfterRename(path, newPath, newName);
  // v0.8.0 WP2 任务2.5：通知侧栏文件树刷新（否则重命名后树里仍是旧文件名，
  // 需手动刷新才更新）
  try {
    window.dispatchEvent(
      new CustomEvent("lightmd:fileRenamed", { detail: { oldPath: path, newPath, newName } }),
    );
  } catch {
    // 非浏览器环境（测试）忽略
  }
  return true;
}
