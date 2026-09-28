/**
 * v0.9.0 WP0/WP1/WP8/WP9：多窗口 IPC 服务层。
 *
 * 统一封装所有窗口相关命令，避免 invoke 字符串散落在各组件里。
 * 非 Tauri 环境（浏览器 dev / jsdom 单测）返回安全默认值，绝不抛错。
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./fileService";
import { getWindowLabel } from "../utils/windowLabel";

/** 标签概要（会话快照 / 窗口列表共用） */
export interface TabBrief {
  kind: "file" | "untitled";
  path?: string | null;
  untitledId?: string | null;
  name: string;
  pinned: boolean;
  isDirty: boolean;
}

/** 单窗口会话数据 */
export interface WindowSession {
  label: string;
  activeTabIdx: number;
  tabs: TabBrief[];
  folderPaths: string[];
}

/** 新窗口引导数据（`take_window_boot` 返回） */
export interface WindowBoot {
  label: string;
  isPrimary: boolean;
  /** 会话恢复窗口：按 `getWindowSession` 的返回恢复标签/文件夹 */
  restore: boolean;
  /** 该槽位为全新分配：可安全清理上一会话残留的窗口级 localStorage key */
  fresh: boolean;
  files: string[];
  movedTabs: MovedTab[];
}

/** 从其他窗口迁移过来的标签 */
export interface MovedTab {
  path?: string | null;
  name: string;
  content?: string | null;
  isDirty?: boolean;
  isUntitled?: boolean;
  pinned?: boolean;
  untitledId?: string | null;
}

/** 冲突检测：某文件的打开记录 */
export interface OpenFileRef {
  label: string;
  isDirty: boolean;
}

/** 窗口菜单列表项 */
export interface WindowSummary {
  label: string;
  isPrimary: boolean;
  createdAt: number;
  activeTabIdx: number;
  tabs: TabBrief[];
}

/** 标签拖拽松手时的落点窗口（v0.9.0 第四轮问题2） */
export interface MergeDropTarget {
  label: string;
  /** 是否为主窗口（是 → 弹「合并回主窗口」询问） */
  isPrimary: boolean;
}

/** 会话恢复窗口数上限（与 Rust 侧一致：main + sec-1~sec-7） */
export const WINDOW_BOOT_FALLBACK: WindowBoot = {
  label: "main",
  isPrimary: true,
  restore: false,
  fresh: false,
  files: [],
  movedTabs: [],
};

export const windowService = {
  /** 本窗口挂载后取走引导数据（幂等） */
  async takeBoot(): Promise<WindowBoot> {
    if (!isTauri()) return { ...WINDOW_BOOT_FALLBACK, label: getWindowLabel() };
    try {
      return await invoke<WindowBoot>("take_window_boot");
    } catch (err) {
      console.error("读取窗口引导数据失败:", err);
      return { ...WINDOW_BOOT_FALLBACK, label: getWindowLabel() };
    }
  },

  /**
   * 创建辅助窗口。
   * @returns 新窗口 label；达到上限时抛 `Error("LIMIT")`
   */
  async createWindow(opts?: { files?: string[]; movedTabs?: MovedTab[] }): Promise<string> {
    if (!isTauri()) throw new Error("NO_TAURI");
    try {
      return await invoke<string>("create_window", {
        files: opts?.files ?? null,
        movedTabs: opts?.movedTabs ?? null,
      });
    } catch (err) {
      const msg = String(err);
      // Rust 侧以 `LIMIT|` 前缀区分「窗口上限」与真实故障
      if (msg.startsWith("LIMIT|")) throw new Error("LIMIT");
      throw new Error(msg);
    }
  },

  /** 上报本窗口的标签/文件夹/活跃下标（前端已做指纹比对，实际调用频率很低） */
  async syncWindowState(report: WindowSession): Promise<void> {
    if (!isTauri()) return;
    try {
      await invoke("sync_window_state", { report });
    } catch (err) {
      console.error("上报窗口状态失败:", err);
    }
  },

  /** 打开文件前查询该文件被哪些窗口打开（冲突检测） */
  async queryFileOpen(path: string): Promise<OpenFileRef[]> {
    if (!isTauri()) return [];
    try {
      return await invoke<OpenFileRef[]>("query_file_open", { path });
    } catch (err) {
      console.error("查询文件打开状态失败:", err);
      return [];
    }
  },

  /** 窗口菜单列表 */
  async listWindows(): Promise<WindowSummary[]> {
    if (!isTauri()) {
      return [
        {
          label: getWindowLabel(),
          isPrimary: true,
          createdAt: 0,
          activeTabIdx: 0,
          tabs: [],
        },
      ];
    }
    try {
      return await invoke<WindowSummary[]>("list_windows");
    } catch (err) {
      console.error("读取窗口列表失败:", err);
      return [];
    }
  },

  /** 激活指定窗口 */
  async focusWindow(label: string): Promise<void> {
    if (!isTauri()) return;
    try {
      await invoke("focus_window", { label });
    } catch (err) {
      console.error("激活窗口失败:", err);
    }
  },

  /** 请求关闭指定窗口（走 CloseRequested 拦截 → 前端 dirty 确认流程） */
  async requestCloseWindow(label: string): Promise<void> {
    if (!isTauri()) return;
    try {
      await invoke("request_close_window", { label });
    } catch (err) {
      console.error("请求关闭窗口失败:", err);
    }
  },

  /** 前端取消关闭（dirty 确认框点「取消」） */
  async abortClose(): Promise<void> {
    if (!isTauri()) return;
    try {
      await invoke("abort_close");
    } catch (err) {
      console.error("取消关闭窗口失败:", err);
    }
  },

  /** 前端确认关闭（dirty 处理完毕后调用；Rust 侧清理并销毁窗口） */
  async confirmClose(): Promise<void> {
    if (!isTauri()) return;
    await invoke("confirm_close");
  },

  /** 向指定窗口发送事件（「切换到已有窗口」等） */
  async emitToWindow(label: string, event: string, payload: unknown): Promise<void> {
    if (!isTauri()) return;
    try {
      await invoke("emit_to_window", { label, event, payload });
    } catch (err) {
      console.error("跨窗口发送事件失败:", err);
    }
  },

  /** 是否存在上次多窗口会话 */
  async hasSession(): Promise<boolean> {
    if (!isTauri()) return false;
    try {
      return await invoke<boolean>("has_session");
    } catch {
      return false;
    }
  },

  /** 取指定窗口的会话数据 */
  async getWindowSession(label: string): Promise<WindowSession | null> {
    if (!isTauri()) return null;
    try {
      return await invoke<WindowSession | null>("get_window_session", { label });
    } catch (err) {
      console.error("读取窗口会话失败:", err);
      return null;
    }
  },

  /** 按会话快照重建辅助窗口 */
  async restoreWindows(): Promise<string[]> {
    if (!isTauri()) return [];
    try {
      return await invoke<string[]>("restore_windows");
    } catch (err) {
      console.error("恢复窗口失败:", err);
      return [];
    }
  },

  /** 丢弃上次会话 */
  async discardSession(): Promise<void> {
    if (!isTauri()) return;
    try {
      await invoke("discard_session");
    } catch (err) {
      console.error("丢弃会话失败:", err);
    }
  },

  /**
   * v0.9.0 第二轮修复：只裁掉会话里的辅助窗口条目，保留主窗口条目。
   *
   * 「启动时恢复其他窗口」关闭时使用（替代整份 `discardSession`）：主窗口下次启动
   * 仍能按会话快照精确恢复全部标签/文件夹，而不会退回「最近文件」近似恢复
   * （默认只回 1 个文件，用户感知为"标签丢了"）。
   */
  async pruneSecondarySessions(): Promise<void> {
    if (!isTauri()) return;
    try {
      await invoke("prune_session_secondaries");
    } catch (err) {
      console.error("裁剪会话中的辅助窗口失败:", err);
    }
  },

  /**
   * v0.9.0 第三轮修复：把本窗口从会话「最后状态」中除名。
   *
   * 「合并到主窗口」后、关闭自身前调用：合并窗口的标签已全部转移，若不除名，
   * 「逐个关窗退出」生成的完整退出快照会把它原样复活（同一批标签在两个窗口
   * 重复出现）。调用后迟到的状态上报也会被 Rust 侧忽略。
   */
  async forgetWindowState(): Promise<void> {
    if (!isTauri()) return;
    try {
      await invoke("forget_window_state");
    } catch (err) {
      console.error("清除窗口会话状态失败:", err);
    }
  },

  /**
   * v0.9.0 第四轮（问题2）：标签拖拽松手时，光标是否落在**其他窗口的标签栏**上。
   *
   * 标签拖拽由源窗口捕获鼠标，其 DOM 无法得知指针在屏幕上的位置，因此由 Rust 读
   * 全局光标坐标判断。返回 null 表示没有落在别的窗口标签栏上（调用方回退到
   * 「移动到新窗口」的原行为）。
   */
  async mergeTabDropTarget(): Promise<MergeDropTarget | null> {
    if (!isTauri()) return null;
    try {
      return await invoke<MergeDropTarget | null>("merge_tab_drop_target");
    } catch (err) {
      console.error("检测标签拖拽落点失败:", err);
      return null;
    }
  },

  /**
   * v0.9.0：显式退出应用（窗口菜单 / 命令面板 `Ctrl+Q`）。
   *
   * v0.9.0 第四轮（问题3）语义修订：显式退出表示"这次会话到此为止"——Rust 只把
   * **主窗口**的最后状态写入会话快照（下次启动主窗口的标签/文件夹/浏览进度照常
   * 恢复），其他窗口不再出现。若希望下次整体还原多个窗口，请逐个点右上角关闭
   * （关掉最后一个窗口即自然退出，本会话全部窗口都会写入快照）。
   */
  async quitApp(): Promise<void> {
    if (!isTauri()) return;
    await invoke("quit_app");
  },
};
