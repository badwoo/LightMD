/**
 * 文件系统服务 —— 通过 invoke() 调用 Rust 后端命令
 *
 * 使用 Tauri v2 标准 IPC 机制（invoke），而非 window.__TAURI__.fs 插件 API。
 * Rust 端命令定义在 src-tauri/src/commands/file_ops.rs
 */
import { invoke } from "@tauri-apps/api/core";
import { notifyError } from "./notificationService";
import { getWindowLabel } from "../utils/windowLabel";
import { noteSelfWrittenFile } from "./selfWriteGuard";

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  /** v0.8.4 需求7：修改时间（UNIX 毫秒；Rust 侧 metadata.modified()，失败时为 0=未知） */
  modified_ms: number;
  /** v0.8.4 需求7：创建时间（UNIX 毫秒；平台不支持时 Rust 侧置 0=未知） */
  created_ms: number;
}

/**
 * v0.8.4 需求10：watcher 聚合事件载荷（Rust 端 200ms 聚合去抖后 emit）。
 * - root：监听的文件夹根路径
 * - paths：聚合窗口内发生变更的路径（文件/目录）
 * - hasRemove：窗口内是否含删除/移出类事件（供前端 stale 联动）
 */
export interface FolderChangedPayload {
  root: string;
  paths: string[];
  hasRemove: boolean;
}

function wrapError(context: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `${context}: ${msg}`;
}

export const fileService = {
  /**
   * 读取文件内容
   * @param opts.silent 静默模式：true 时不弹出错误提示,仅抛错——
   *   供启动恢复使用:被删除/移动的历史文件恢复失败时只标 ⚠（用户从最近打开
   *   自行知晓），不弹红色"读取文件失败"提示（v0.9.5 问题3）
   */
  async readFile(path: string, opts?: { silent?: boolean }): Promise<string> {
    try {
      return await invoke<string>("read_file", { path });
    } catch (err) {
      const msg = wrapError("读取文件失败", err);
      if (!opts?.silent) {
        notifyError(msg);
      }
      throw new Error(msg);
    }
  },

  async writeFile(path: string, content: string): Promise<void> {
    try {
      await invoke("write_file", { path, content });
      // v0.9.0 第二轮修复（问题3）：登记自身写盘的内容指纹。
      // Rust 侧按 mtime 抑制 watcher 事件存在毫秒级竞态，前端用内容比对兜底，
      // 确保「保存成功」不会被随后的 watcher 回声误判为「文件已被外部修改」。
      noteSelfWrittenFile(path, content);
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

  /** v0.8.0 WP2 需求1：复制文件/目录（目标已存在则 Rust 端报错） */
  async copyFile(src: string, dst: string): Promise<void> {
    try {
      await invoke("copy_file", { src, dst });
    } catch (err) {
      const msg = wrapError("复制失败", err);
      notifyError(msg);
      throw new Error(msg);
    }
  },

  /** v0.8.4 需求1：移动文件/目录（Rust 端 rename 失败时降级为递归复制+删源，支持跨盘） */
  async moveFile(src: string, dst: string): Promise<void> {
    try {
      await invoke("move_file", { src, dst });
    } catch (err) {
      const msg = wrapError("移动文件失败", err);
      notifyError(msg);
      throw new Error(msg);
    }
  },

  /**
   * v0.8.4 需求10：监听文件夹变更（Rust notify 递归监听，200ms 聚合后 emit 事件）。
   * v0.9.0：带窗口 label 做**引用计数**——多个窗口打开同一目录只注册一个 watcher，
   * 只有最后一个使用该目录的窗口关闭时才真正注销。
   * 调用方需 catch 失败场景（网络盘/权限等），走手动刷新兜底，不阻断流程。
   */
  async watchFolder(path: string): Promise<void> {
    try {
      await invoke("watch_folder", { path, windowLabel: getWindowLabel() });
    } catch (err) {
      const msg = wrapError("监听文件夹失败", err);
      notifyError(msg);
      throw new Error(msg);
    }
  },

  /**
   * v0.8.4 需求10 / v0.9.0：取消监听文件夹变更。
   * 只释放**本窗口**对该目录的引用；其他窗口仍在用时 watcher 保留（未注册时 no-op）。
   */
  async unwatchFolder(path: string): Promise<void> {
    try {
      await invoke("unwatch_folder", { path, windowLabel: getWindowLabel() });
    } catch (err) {
      const msg = wrapError("取消监听文件夹失败", err);
      notifyError(msg);
      throw new Error(msg);
    }
  },

  /**
   * v0.8.4 需求10：订阅文件夹变更事件（Rust watcher 200ms 聚合后 emit）。
   * 载荷 { root, paths[], hasRemove }（camelCase，与 Rust 端序列化约定一致）。
   * 返回取消订阅函数；非 Tauri 环境（浏览器/单测）返回 no-op，不抛错。
   */
  async onFolderChanged(
    handler: (payload: FolderChangedPayload) => void
  ): Promise<() => void> {
    // 非 Tauri 环境无事件源：静默返回 no-op（组件卸载时安全调用）
    if (!isTauri()) return () => {};
    try {
      const { listen } = await import("@tauri-apps/api/event");
      return await listen<FolderChangedPayload>("lightmd://folder-changed", (event) => {
        handler(event.payload);
      });
    } catch (err) {
      // 订阅失败不影响主流程（watch 注册成功才有事件；此处兜底不抛错）
      console.error("订阅文件夹变更事件失败:", err);
      return () => {};
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
  // v0.6.3 S-2：withGlobalTauri 已关闭（window.__TAURI__ 不再暴露，防脚本注入直达 IPC），
  // 改检测 Tauri v2 始终注入的内部对象 __TAURI_INTERNALS__
  return (
    typeof window !== "undefined" &&
    !!(window as any).__TAURI_INTERNALS__
  );
}
