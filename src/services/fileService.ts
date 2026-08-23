/**
 * 文件系统服务 —— 通过 invoke() 调用 Rust 后端命令
 *
 * 使用 Tauri v2 标准 IPC 机制（invoke），而非 window.__TAURI__.fs 插件 API。
 * Rust 端命令定义在 src-tauri/src/commands/file_ops.rs
 */
import { invoke } from "@tauri-apps/api/core";
import { notifyError } from "./notificationService";

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}

function wrapError(context: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `${context}: ${msg}`;
}

export const fileService = {
  async readFile(path: string): Promise<string> {
    try {
      return await invoke<string>("read_file", { path });
    } catch (err) {
      const msg = wrapError("读取文件失败", err);
      notifyError(msg);
      throw new Error(msg);
    }
  },

  async writeFile(path: string, content: string): Promise<void> {
    try {
      await invoke("write_file", { path, content });
    } catch (err) {
      const msg = wrapError("保存文件失败", err);
      notifyError(msg);
      throw new Error(msg);
    }
  },

  /** 获取文件大小（字节），用于大文件检测 */
  async getFileSize(path: string): Promise<number> {
    try {
      return await invoke<number>("get_file_size", { path });
    } catch {
      return 0;
    }
  },

  /**
   * 列出目录内容
   * @param opts.silent 静默模式：true 时不弹出错误提示（用于拖拽场景的类型探测）
   */
  async listDir(path: string, opts?: { silent?: boolean }): Promise<FileEntry[]> {
    try {
      return await invoke<FileEntry[]>("list_dir", { path });
    } catch (err) {
      const msg = wrapError("读取目录失败", err);
      // 静默模式下不弹 toast，仅抛错（用于拖拽时探测路径类型）
      if (!opts?.silent) {
        notifyError(msg);
      }
      throw new Error(msg);
    }
  },

  async createFile(path: string): Promise<void> {
    try {
      await invoke("create_file", { path });
    } catch (err) {
      const msg = wrapError("创建文件失败", err);
      notifyError(msg);
      throw new Error(msg);
    }
  },

  async createDir(path: string): Promise<void> {
    try {
      await invoke("create_dir", { path });
    } catch (err) {
      const msg = wrapError("创建文件夹失败", err);
      notifyError(msg);
      throw new Error(msg);
    }
  },

  async deleteFile(path: string): Promise<void> {
    try {
      await invoke("delete_file", { path });
    } catch (err) {
      const msg = wrapError("删除失败", err);
      notifyError(msg);
      throw new Error(msg);
    }
  },

  async renameFile(oldPath: string, newPath: string): Promise<void> {
    try {
      await invoke("rename_file", { oldPath, newPath });
    } catch (err) {
      const msg = wrapError("重命名失败", err);
      notifyError(msg);
      throw new Error(msg);
    }
  },

  async exists(path: string): Promise<boolean> {
    try {
      return await invoke<boolean>("exists", { path });
    } catch {
      return false;
    }
  },

  /** 在系统资源管理器中显示并选中指定文件（N5：右键菜单"打开文件所在目录"） */
  async revealInFolder(path: string): Promise<void> {
    try {
      await invoke("reveal_in_folder", { path });
    } catch (err) {
      const msg = wrapError("打开文件所在目录失败", err);
      notifyError(msg);
      throw new Error(msg);
    }
  },
};

export function isTauri(): boolean {
  return typeof window !== "undefined" && !!(window as any).__TAURI__;
}
