/**
 * v0.14.0 需求1：软件更新服务
 *
 * 与 Rust 侧 `src-tauri/src/commands/update.rs` 的三个命令对应：
 * - check_update     → checkForUpdate
 * - download_update  → downloadAndInstall（内含 launch_installer）
 * - launch_installer → 由 downloadAndInstall 在下载完成后调用
 *
 * 为什么不在前端直接请求 GitHub：
 * `tauri.conf.json` 的 CSP `connect-src` 不含 https，WebView2 会直接拦截
 * `fetch("https://api.github.com/...")`。网络请求全部走 Rust（reqwest）。
 *
 * 纯逻辑与副作用分离：版本比较 / 安装包挑选是无副作用的纯函数（可单测），
 * IPC 调用集中在 checkForUpdate / downloadAndInstall。
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./fileService";

/** Rust 侧进度事件名（与 update.rs 的 UPDATE_PROGRESS_EVENT 保持一致） */
export const UPDATE_PROGRESS_EVENT = "lightmd://update-progress";

/** 进度事件载荷（Rust 侧 emit 的字段为 snake_case 之外的普通 JSON） */
export interface UpdateProgressPayload {
  downloaded: number;
  /** 0 = 服务器未提供 Content-Length（无法算百分比） */
  total: number;
}

/** 检查更新的结果（对应 Rust 的 UpdateInfo，字段为 camelCase） */
export interface UpdateCheckResult {
  version: string;
  current: string;
  isNewer: boolean;
  notes: string;
  htmlUrl: string;
  assetName: string;
  assetUrl: string;
  assetSize: number;
}

/** 安装包候选（供 pickInstallerAsset 使用） */
export interface InstallerAsset {
  name: string;
  url: string;
  size: number;
}

/**
 * 比较两个版本号：返回 -1（current < latest）/ 0（相等）/ 1（current > latest）。
 *
 * ⚠️ 语义与 Rust 侧 `is_newer_version` 完全一致（按 `.` 分段、逐段取数字、
 * 缺段补 0、忽略 `v` 前缀与非数字后缀）。**权威判定在 Rust**——这里只用于
 * 前端二次校验 / 单测，避免 UI 因后端返回异常而误显示"有新版本"。
 */
export function compareVersions(current: string, latest: string): number {
  const parse = (raw: string): number[] => {
    let s = String(raw ?? "").trim();
    if (s.startsWith("v") || s.startsWith("V")) s = s.slice(1);
    return s.split(".").map((seg) => {
      const m = /^\d+/.exec(seg);
      return m ? Number(m[0]) : 0;
    });
  };
  const a = parse(current);
  const b = parse(latest);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (y > x) return -1;
    if (y < x) return 1;
  }
  return 0;
}

/**
 * 安装包优先级：`x64-setup.exe` > `setup.exe` > `.msi`；其余返回 null。
 *
 * 先排除签名/校验文件（`xxx-setup.exe.sig`、`SHA256SUMS.txt` 等）——
 * 它们文件名里也含 `setup.exe`，不排除会被误当成安装包。
 */
function assetRank(name: string): number | null {
  const lower = name.toLowerCase();
  if (
    lower.endsWith(".sig") ||
    lower.endsWith(".sha256") ||
    lower.includes("sha256sums") ||
    lower.endsWith(".txt") ||
    lower.endsWith(".json")
  ) {
    return null;
  }
  if (lower.endsWith("x64-setup.exe")) return 0;
  if (lower.endsWith("setup.exe")) return 1;
  if (lower.endsWith(".msi")) return 2;
  return null;
}

/**
 * 按优先级挑选安装包（与 Rust 侧 `pick_installer_asset` 同一套规则）。
 * 纯函数，便于测试；实际下载以 Rust 侧返回的 assetUrl 为准。
 */
export function pickInstallerAsset(assets: InstallerAsset[]): InstallerAsset | null {
  let best: { rank: number; asset: InstallerAsset } | null = null;
  for (const asset of assets) {
    if (!asset.name || !asset.url) continue;
    const rank = assetRank(asset.name);
    if (rank === null) continue;
    if (!best || rank < best.rank) best = { rank, asset };
  }
  return best ? best.asset : null;
}

/** 把任意错误收敛成可读中文（不把原始 JSON / 异常对象丢给用户） */
function toReadableError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** 非 Tauri 环境（浏览器 dev / 单测）的降级错误文案 */
const NOT_TAURI_MESSAGE = "当前环境不支持检查更新（请使用 LightMD 桌面客户端）";

/**
 * 检查更新。
 *
 * 非 Tauri 环境（浏览器 dev / 单测）抛一个明确的可读错误，
 * 由调用方显示在失败文案里（设置弹窗在浏览器 dev 下仍能正常渲染）。
 *
 * 注意：错误信息**不带**「检查更新失败：」前缀 —— 该前缀由 UI 的
 * `settings.update.failed` 模板统一添加，避免出现两层前缀。
 */
export async function checkForUpdate(currentVersion: string): Promise<UpdateCheckResult> {
  if (!isTauri()) {
    throw new Error(NOT_TAURI_MESSAGE);
  }
  try {
    return await invoke<UpdateCheckResult>("check_update", { currentVersion });
  } catch (err) {
    throw new Error(toReadableError(err));
  }
}

/**
 * 下载并启动安装包。
 *
 * 流程：监听进度事件 → invoke download_update（Rust 流式下载并发进度）→
 * 拿到本地路径 → invoke launch_installer 启动安装向导。
 *
 * @param onProgress 进度回调（0-100；服务器未给 Content-Length 时按 0 处理）
 * @returns 下载到本地的安装包绝对路径
 */
export async function downloadAndInstall(
  assetUrl: string,
  assetName: string,
  onProgress?: (pct: number) => void
): Promise<string> {
  if (!isTauri()) {
    throw new Error(NOT_TAURI_MESSAGE);
  }

  // 事件订阅失败不阻断下载：没有进度条总比下载不了好
  let unlisten: (() => void) | null = null;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    unlisten = await listen<UpdateProgressPayload>(UPDATE_PROGRESS_EVENT, (event) => {
      const payload = event.payload;
      if (!payload) return;
      const { downloaded, total } = payload;
      if (!onProgress) return;
      if (total > 0) {
        const pct = Math.min(100, Math.max(0, Math.round((downloaded / total) * 100)));
        onProgress(pct);
      } else {
        // 无总长：无法算百分比，回调 0 让 UI 显示"正在下载"
        onProgress(0);
      }
    });
  } catch (err) {
    console.error("订阅更新进度事件失败:", err);
    unlisten = null;
  }

  try {
    const path = await invoke<string>("download_update", { assetUrl, assetName });
    if (!path) {
      throw new Error("下载完成但未返回安装包路径");
    }
    onProgress?.(100);
    // 启动安装向导；用户按提示完成安装（不静默覆盖正在运行的程序）。
    // 安全：Rust 侧 launch_installer 只接受「已下载到 app_cache_dir()/updates/ 下
    // 且扩展名为 .exe/.msi」的路径 —— 这里传的 path 就是 download_update 刚返回的
    // 缓存路径；远端 JSON 的 asset_url 永远不会直接成为被执行的目标。
    await invoke("launch_installer", { path });
    return path;
  } catch (err) {
    throw new Error(`下载安装包失败：${toReadableError(err)}`);
  } finally {
    if (unlisten) unlisten();
  }
}
