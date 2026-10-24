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

/** 把任意错误收敛成可读字符串（不把原始 JSON / 异常对象丢给用户） */
function toReadableError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  // 注意 JSON.stringify(undefined) 返回 undefined（不是字符串），必须兜底，
  // 否则后续 .startsWith 会抛 TypeError（IPC 抛 undefined 时真会走到这里）。
  if (err === undefined || err === null) return "";
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

// ─── v0.14.0 需求1 修复：网络层失败 vs 业务失败 ─────────────────────
/**
 * 网络层失败的稳定错误码（与 Rust `update.rs` 的 `UPDATE_NETWORK_ERROR_CODE` 逐字一致）。
 *
 * 背景：Tauri 的 `Err(String)` 只有一段文本，前端无法从 reqwest 的英文原始串里
 * 可靠区分「网络不可达」与「GitHub 返回 404」。而这两者对用户的意义完全不同：
 * 前者必须显示「暂时无法检查更新（网络不可用）」，**绝不能**显示「已是最新版本」
 * （那是在谎报版本状态）。因此 Rust 侧把网络层失败编码成
 * `LIGHTMD_UPDATE_NETWORK|<scope>|<detail>`，这里解析后抛专用错误类型。
 */
export const UPDATE_NETWORK_ERROR_CODE = "LIGHTMD_UPDATE_NETWORK";

/** 失败发生在哪个阶段（决定 UI 文案与「重试」按钮重跑什么） */
export type UpdateErrorScope = "check" | "download";

/** 解析后的失败信息（纯数据，便于单测） */
export interface UpdateFailure {
  /** network = 连接/DNS/TLS/超时（用户侧「断网」）；server = HTTP 4xx/5xx、解析失败等 */
  kind: "network" | "server";
  scope: UpdateErrorScope;
  /** 原始细节（只用于排查，UI 展示走 i18n 文案） */
  detail: string;
}

/**
 * 把 IPC 抛出的错误解析成结构化失败信息（**纯函数**，可单测）。
 *
 * 只有以 `LIGHTMD_UPDATE_NETWORK|` 开头且带作用域分隔符的错误才算网络层；
 * 其余（HTTP 403/404、JSON 解析失败、缺 tag_name、空串……）一律算业务失败，
 * 保持既有可读文案。
 */
export function parseUpdateFailure(raw: unknown): UpdateFailure {
  const text = toReadableError(raw);
  const prefix = `${UPDATE_NETWORK_ERROR_CODE}|`;
  if (text.startsWith(prefix)) {
    const rest = text.slice(prefix.length);
    const sep = rest.indexOf("|");
    const scopeRaw = sep === -1 ? rest : rest.slice(0, sep);
    const detail = sep === -1 ? "" : rest.slice(sep + 1);
    return {
      kind: "network",
      scope: scopeRaw === "download" ? "download" : "check",
      detail,
    };
  }
  return { kind: "server", scope: "check", detail: text };
}

/**
 * 网络不可达专用错误（连接 / DNS / TLS 握手 / 超时）。
 *
 * 调用方（SettingsDialog）用 `instanceof` 区分它与普通错误：前者进入独立的
 * 「暂时无法检查更新（网络不可用）」状态，**不显示任何版本结论**；后者沿用
 * `settings.update.failed` 文案 + 重试。
 */
export class UpdateNetworkError extends Error {
  readonly scope: UpdateErrorScope;
  readonly detail: string;

  constructor(scope: UpdateErrorScope, detail: string) {
    super(detail || "network unavailable");
    this.name = "UpdateNetworkError";
    this.scope = scope;
    this.detail = detail;
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
 * 网络不可达 → 抛 `UpdateNetworkError`（scope="check"），由 UI 显示
 * 「暂时无法检查更新（网络不可用）」；其它错误 → 普通 Error，沿用既有文案。
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
    const failure = parseUpdateFailure(err);
    if (failure.kind === "network") {
      throw new UpdateNetworkError(failure.scope, failure.detail);
    }
    throw new Error(failure.detail);
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
    let path: string;
    try {
      path = await invoke<string>("download_update", { assetUrl, assetName });
    } catch (err) {
      // 下载阶段的网络层失败同样要能被 UI 识别（→「暂时无法下载更新（网络不可用）」），
      // 不能只是把英文原始串拼进「下载安装包失败：」后面。
      const failure = parseUpdateFailure(err);
      if (failure.kind === "network") {
        throw new UpdateNetworkError("download", failure.detail);
      }
      throw new Error(`下载安装包失败：${failure.detail}`);
    }
    if (!path) {
      throw new Error("下载安装包失败：未返回安装包路径");
    }
    onProgress?.(100);
    // 启动安装向导；用户按提示完成安装（不静默覆盖正在运行的程序）。
    // 安全：Rust 侧 launch_installer 只接受「已下载到 app_cache_dir()/updates/ 下
    // 且扩展名为 .exe/.msi」的路径 —— 这里传的 path 就是 download_update 刚返回的
    // 缓存路径；远端 JSON 的 asset_url 永远不会直接成为被执行的目标。
    try {
      await invoke("launch_installer", { path });
    } catch (err) {
      // 下载成功但启动失败：文件已落盘，报错要说明这一点（用户可手动去装）
      throw new Error(
        `安装包已下载到 ${path}，但启动安装程序失败：${toReadableError(err)}`,
      );
    }
    return path;
  } finally {
    if (unlisten) unlisten();
  }
}
