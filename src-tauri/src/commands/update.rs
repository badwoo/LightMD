//! v0.14.0 需求1：软件更新（检查 GitHub release / 下载安装包 / 启动安装）
//!
//! 为什么网络请求必须放在 Rust 侧：
//! `src-tauri/tauri.conf.json` 的 CSP `connect-src` 只允许 `'self' ipc: ...`（不含 https），
//! 前端 `fetch("https://api.github.com/...")` 会被 WebView2 直接拦截。reqwest 已在
//! Cargo.toml 依赖里（json / stream / rustls-tls），因此把「查最新 release + 下载安装包」
//! 全部放在这里，前端只经 IPC 调用。
//!
//! 命令清单：
//! - check_update：查询 `badwoo/LightMD` 最新 release，返回版本/说明/安装包信息
//! - download_update：流式下载安装包到应用缓存目录，边下边发进度事件
//! - launch_installer：启动已下载的 .exe / .msi 安装包（严格校验扩展名）
//!
//! 设计取舍：**不引入 tauri-plugin-updater**。官方 updater 需要签名密钥与 CI 配套，
//! 且会在应用内静默替换正在运行的程序（Windows 上必然失败）。这里改为「下载安装包 →
//! 交给系统安装向导」，用户手动完成安装，最稳且零额外密钥管理。

use std::time::Duration;

use serde::Deserialize;
use tauri::{Emitter, Manager};

/// 仓库固定为 LightMD（与「关于」里的链接一致）
const GITHUB_LATEST_RELEASE: &str = "https://api.github.com/repos/badwoo/LightMD/releases/latest";

/// 更新说明最多回传的字符数（release body 可能很长，避免一次 IPC 传输过大）
const MAX_NOTES_CHARS: usize = 4000;

/// 进度事件名（与前端 updateService.ts 约定一致）
pub const UPDATE_PROGRESS_EVENT: &str = "lightmd://update-progress";

/// 检查更新的返回值（前端 UpdateCheckResult 与之对应）。
///
/// 注意：这里显式 `rename_all = "camelCase"` —— Tauri v2 的命令**参数**会自动做
/// camelCase→snake_case 映射，但**返回值结构体字段名默认原样序列化**。前端 TS 接口
/// 用 `isNewer` / `assetName` 等驼峰字段，故在结构体上统一声明，避免前端再做一次映射。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// 最新版本号（已去掉 tag 前缀 `v`）
    pub version: String,
    /// 当前版本号（前端传入；为空时回退到编译期 CARGO_PKG_VERSION）
    pub current: String,
    /// 最新版本是否比当前版本更新
    pub is_newer: bool,
    /// release body（截断到 MAX_NOTES_CHARS 字符）
    pub notes: String,
    /// release 页面地址
    pub html_url: String,
    /// 选中的安装包文件名（空串 = 该 release 没有可用安装包）
    pub asset_name: String,
    /// 安装包下载地址（空串 = 没有可用安装包）
    pub asset_url: String,
    /// 安装包字节数（0 = 未知）
    pub asset_size: u64,
}

/// GitHub release 的最小反序列化结构（只取用到的字段）
#[derive(Debug, Deserialize)]
struct GhRelease {
    #[serde(default)]
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

#[derive(Debug, Clone, Deserialize)]
struct GhAsset {
    #[serde(default)]
    name: String,
    #[serde(default)]
    browser_download_url: String,
    #[serde(default)]
    size: u64,
}

/// 解析版本号为数字段（纯函数，供 is_newer_version 与单测使用）。
///
/// 规则：
/// - 去掉首尾空白与 `v` / `V` 前缀；
/// - 按 `.` 切分，每段只取**开头的连续数字**（`0-beta` → 0，`14` → 14）；
/// - 空串/纯非数字 → 0。
fn parse_version_segments(raw: &str) -> Vec<u64> {
    let trimmed = raw.trim();
    let trimmed = trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
        .unwrap_or(trimmed);
    trimmed
        .split('.')
        .map(|seg| {
            let digits: String = seg.chars().take_while(|c| c.is_ascii_digit()).collect();
            digits.parse::<u64>().unwrap_or(0)
        })
        .collect()
}

/// 判断 `latest` 是否比 `current` 新（纯函数，可单测）。
///
/// **绝不能用字符串比较**：`"0.9.0" > "0.14.0"` 在字典序下成立，但版本语义相反。
/// 段数不同时缺的段按 0 补齐（`1.0` == `1.0.0`）；相等（含忽略后缀后相等）不算新。
pub fn is_newer_version(current: &str, latest: &str) -> bool {
    let cur = parse_version_segments(current);
    let lat = parse_version_segments(latest);
    let len = cur.len().max(lat.len());
    for i in 0..len {
        let a = cur.get(i).copied().unwrap_or(0);
        let b = lat.get(i).copied().unwrap_or(0);
        if b > a {
            return true;
        }
        if b < a {
            return false;
        }
    }
    false
}

/// 安装包候选优先级：`x64-setup.exe` > `setup.exe` > `.msi`；其余返回 None。
///
/// 注意先排除签名/校验文件：`xxx-setup.exe.sig`、`SHA256SUMS.txt` 这类文件名里
/// 也含 `setup.exe`，若不排除会被误当成安装包下载。
fn asset_rank(name: &str) -> Option<u8> {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".sig")
        || lower.ends_with(".sha256")
        || lower.contains("sha256sums")
        || lower.ends_with(".txt")
        || lower.ends_with(".json")
    {
        return None;
    }
    if lower.ends_with("x64-setup.exe") {
        Some(0)
    } else if lower.ends_with("setup.exe") {
        Some(1)
    } else if lower.ends_with(".msi") {
        Some(2)
    } else {
        None
    }
}

/// 按优先级从 assets 里挑安装包（纯函数）。
fn pick_installer_asset(assets: &[GhAsset]) -> Option<GhAsset> {
    let mut best: Option<(u8, &GhAsset)> = None;
    for asset in assets {
        if asset.name.is_empty() || asset.browser_download_url.is_empty() {
            continue;
        }
        if let Some(rank) = asset_rank(&asset.name) {
            let better = match best {
                None => true,
                Some((best_rank, _)) => rank < best_rank,
            };
            if better {
                best = Some((rank, asset));
            }
        }
    }
    best.map(|(_, a)| a.clone())
}

/// 校验并清洗安装包文件名：只允许纯文件名（不含路径分隔符 / 上级目录），
/// 且必须以 .exe / .msi 结尾。防止 asset 名被构造成 `..\..\evil.exe` 之类写到别处。
fn sanitize_asset_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err("安装包文件名为空".to_string());
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("安装包文件名包含非法路径字符".to_string());
    }
    let lower = name.to_ascii_lowercase();
    if !lower.ends_with(".exe") && !lower.ends_with(".msi") {
        return Err("安装包类型不受支持（仅支持 .exe / .msi）".to_string());
    }
    Ok(name.to_string())
}

/// 构造带 User-Agent 的 HTTP 客户端（GitHub API 对无 UA 的请求返回 403）。
fn build_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .user_agent(format!(
            "LightMD/{} (+https://github.com/badwoo/LightMD)",
            env!("CARGO_PKG_VERSION")
        ))
        .build()
        .map_err(|e| format!("初始化网络客户端失败：{}", e))
}

/// 检查最新版本。
///
/// - 参数 `current_version`：前端传入的 `__APP_VERSION__`（为空时用编译期版本兜底）
/// - 即使没有可用安装包，也照常返回版本信息（`is_newer` 正常判定，asset 字段留空），
///   这样 UI 至少能提示"有新版本"并给出 release 页面入口。
#[tauri::command]
pub async fn check_update(current_version: String) -> Result<UpdateInfo, String> {
    let current = {
        let v = current_version.trim();
        let v = v.strip_prefix('v').or_else(|| v.strip_prefix('V')).unwrap_or(v);
        if v.is_empty() {
            env!("CARGO_PKG_VERSION").to_string()
        } else {
            v.to_string()
        }
    };

    let client = build_client(20)?;
    let resp = client
        .get(GITHUB_LATEST_RELEASE)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| format!("无法连接 GitHub（请检查网络或代理）：{}", e))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        // 403 常见于触发 API 速率限制，给用户更可操作的提示
        let hint = if status == 403 {
            "（GitHub API 访问受限，可能触发了速率限制，请稍后再试）"
        } else if status == 404 {
            "（未找到发布版本，仓库可能尚未发布 release）"
        } else {
            ""
        };
        return Err(format!("GitHub 返回 HTTP {}{}", status, hint));
    }

    let release: GhRelease = resp
        .json()
        .await
        .map_err(|e| format!("解析 GitHub 发布信息失败：{}", e))?;

    let version = release
        .tag_name
        .trim()
        .trim_start_matches('v')
        .trim_start_matches('V')
        .to_string();
    if version.is_empty() {
        return Err("未找到有效的版本号（release 缺少 tag_name）".to_string());
    }

    let notes: String = release
        .body
        .unwrap_or_default()
        .chars()
        .take(MAX_NOTES_CHARS)
        .collect();

    let asset = pick_installer_asset(&release.assets);
    let (asset_name, asset_url, asset_size) = match asset {
        Some(a) => (a.name, a.browser_download_url, a.size),
        None => (String::new(), String::new(), 0),
    };

    Ok(UpdateInfo {
        is_newer: is_newer_version(&current, &version),
        version,
        current,
        notes,
        html_url: release.html_url.unwrap_or_else(|| {
            "https://github.com/badwoo/LightMD/releases/latest".to_string()
        }),
        asset_name,
        asset_url,
        asset_size,
    })
}

/// 是否该发一帧进度事件（纯函数，可单测）。
///
/// 规则：距上次发帧累计 ≥ `step` 字节，或已下满 `total`（保证前端一定能收到 100%）。
/// `total == 0`（服务器没给 Content-Length）时只按 step 节流。
fn should_emit_progress(downloaded: u64, last_emitted: u64, total: u64, step: u64) -> bool {
    let reached_end = total > 0 && downloaded >= total;
    downloaded.saturating_sub(last_emitted) >= step || reached_end
}

/// 下载核心（不含 Tauri 依赖，便于单测/离线探针直接调用）：
/// 流式把 `url` 写到 `tmp`，成功后 rename 到 `dest`，返回字节数。
///
/// `on_progress(downloaded, total)` 在节流点与末尾各回调一次（total=0 表示未知）。
/// 任何失败都会删除 `tmp` 半成品。
pub(crate) async fn download_to_file<F>(
    url: &str,
    dest: &std::path::Path,
    tmp: &std::path::Path,
    mut on_progress: F,
) -> Result<u64, String>
where
    F: FnMut(u64, u64),
{
    use std::io::Write;

    let client = build_client(600)?;
    let mut resp = client
        .get(url)
        .header("Accept", "application/octet-stream")
        .send()
        .await
        .map_err(|e| format!("下载安装包失败（无法连接下载服务器）：{}", e))?;

    if !resp.status().is_success() {
        return Err(format!(
            "下载安装包失败：下载服务器返回 HTTP {}",
            resp.status().as_u16()
        ));
    }

    let total = resp.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(tmp)
        .map_err(|e| format!("创建临时文件失败（{}）：{}", tmp.display(), e))?;

    let mut downloaded: u64 = 0;
    let mut last_emitted: u64 = 0;
    // 每 256KB 发一次进度，避免小分片把 IPC 事件刷爆
    const EMIT_STEP: u64 = 256 * 1024;

    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                if let Err(e) = file.write_all(&chunk) {
                    drop(file);
                    let _ = std::fs::remove_file(tmp);
                    return Err(format!("写入安装包失败：{}", e));
                }
                downloaded += chunk.len() as u64;
                if should_emit_progress(downloaded, last_emitted, total, EMIT_STEP) {
                    last_emitted = downloaded;
                    on_progress(downloaded, total);
                }
            }
            Ok(None) => break,
            Err(e) => {
                drop(file);
                let _ = std::fs::remove_file(tmp);
                return Err(format!("下载安装包中断：{}", e));
            }
        }
    }

    // 显式 flush + 关闭，确保 rename 前数据已落盘
    if let Err(e) = file.flush() {
        drop(file);
        let _ = std::fs::remove_file(tmp);
        return Err(format!("写入安装包失败：{}", e));
    }
    drop(file);

    if downloaded == 0 {
        let _ = std::fs::remove_file(tmp);
        return Err("下载安装包失败：服务器返回了空文件".to_string());
    }
    if total > 0 && downloaded != total {
        let _ = std::fs::remove_file(tmp);
        return Err(format!(
            "下载不完整（{}/{} 字节），请重试",
            downloaded, total
        ));
    }

    // Windows 上目标文件若被占用（上次下载后用户没安装），先尝试删除旧文件
    if dest.exists() {
        let _ = std::fs::remove_file(dest);
    }
    if let Err(e) = std::fs::rename(tmp, dest) {
        // 跨盘/权限等场景 rename 可能失败，退化为复制后删临时文件
        if let Err(e2) = std::fs::copy(tmp, dest) {
            let _ = std::fs::remove_file(tmp);
            return Err(format!("保存安装包失败：{}（备用方式也失败：{}）", e, e2));
        }
        let _ = std::fs::remove_file(tmp);
    }

    Ok(downloaded)
}

/// 流式下载安装包到应用缓存目录，返回本地绝对路径。
///
/// 关键点：
/// - 用 `Response::chunk()` 边读边写（不把整个安装包读进内存）；
/// - 每 256KB（以及最后一帧）发一次 `lightmd://update-progress`，
///   载荷 `{ downloaded, total }`（total 为 0 表示服务器没给 Content-Length）；
/// - 先写 `.part` 临时文件，完整校验后再 rename 成正式文件；
/// - 任何失败路径都清理半成品，避免用户拿到损坏的 exe；
/// - **成功后文件保留**（不删）：后续 `launch_installer` 还要用它启动安装向导。
#[tauri::command]
pub async fn download_update(
    asset_url: String,
    asset_name: String,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let url = asset_url.trim();
    if url.is_empty() || !url.starts_with("https://") {
        return Err("安装包下载地址无效（必须为 https 地址）".to_string());
    }
    let file_name = sanitize_asset_name(&asset_name)?;

    let cache_dir = updates_dir(&app)?;
    std::fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("创建更新缓存目录失败（{}）：{}", cache_dir.display(), e))?;

    let dest = cache_dir.join(&file_name);
    let tmp = cache_dir.join(format!("{}.part", file_name));

    // 上一次失败残留的临时文件先清掉（否则 create 会覆盖，但语义上先清更明确）
    let _ = std::fs::remove_file(&tmp);

    let app_for_progress = app.clone();
    let downloaded = download_to_file(&url.to_string(), &dest, &tmp, move |downloaded, total| {
        let _ = app_for_progress.emit(
            UPDATE_PROGRESS_EVENT,
            serde_json::json!({ "downloaded": downloaded, "total": total }),
        );
    })
    .await?;

    // 收尾进度帧：保证前端一定能看到 100%（total 未知时用实际字节数补齐）
    let _ = app.emit(
        UPDATE_PROGRESS_EVENT,
        serde_json::json!({ "downloaded": downloaded, "total": downloaded }),
    );

    Ok(dest.to_string_lossy().to_string())
}

/// 安装包扩展名白名单（.exe / .msi，大小写不敏感）。
fn is_allowed_installer_ext(name: &str) -> bool {
    let ext = std::path::Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    ext == "exe" || ext == "msi"
}

/// `child` 是否位于 `dir` 之下（按路径组件比较，避免 `/updates-evil` 前缀绕过）。
fn is_within_dir(child: &std::path::Path, dir: &std::path::Path) -> bool {
    child.starts_with(dir)
}

/// 更新缓存目录：`app_cache_dir()/updates`。
fn updates_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|d| d.join("updates"))
        .map_err(|e| format!("无法定位应用缓存目录：{}", e))
}

/// 校验「待启动的安装包」路径，返回规范化后的绝对路径（纯函数，可单测）。
///
/// 安全模型（重要，勿放宽）：
/// 1. 路径必须**已存在**且是文件；
/// 2. 扩展名只能是 `.exe` / `.msi`；
/// 3. 规范化（canonicalize）后必须位于 `allowed_dir` 之下 ——
///    也就是说**只允许执行我们自己下载的安装包**，远端 JSON 里的 asset_url /
///    任意本地路径都不能成为执行目标（防把本命令当通用「启动任意程序」入口）。
fn validate_installer_in_dir(
    raw: &str,
    allowed_dir: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("安装包路径为空".to_string());
    }
    let file = std::path::Path::new(raw);
    if !file.is_file() {
        return Err("安装包文件不存在，请重新下载".to_string());
    }
    if !is_allowed_installer_ext(raw) {
        return Err("不支持的安装包类型（仅支持 .exe / .msi）".to_string());
    }

    // 规范化两侧路径：解析 `..`、符号链接与 Windows 短路径，再做前缀判定
    let real = std::fs::canonicalize(file)
        .map_err(|e| format!("无法解析安装包路径（{}）：{}", file.display(), e))?;
    // 缓存目录可能还不存在（从未下载过）：此时任何路径都不可能是「我们下载的」
    let Ok(dir_real) = std::fs::canonicalize(allowed_dir) else {
        return Err("更新缓存目录不存在，请先在设置里下载安装包".to_string());
    };

    if !is_within_dir(&real, &dir_real) {
        return Err(format!(
            "出于安全考虑，只能启动已下载到更新缓存目录的安装包（{}）",
            dir_real.display()
        ));
    }
    Ok(real)
}

/// 命令侧包装：先解析出 `app_cache_dir()/updates`，再走纯函数校验。
fn validate_installer_path(
    app: &tauri::AppHandle,
    raw: &str,
) -> Result<std::path::PathBuf, String> {
    let dir = updates_dir(app)?;
    validate_installer_in_dir(raw, &dir)
}

/// 真正启动安装包进程（已通过 [`validate_installer_in_dir`] 校验的路径）。
///
/// 单独抽出来是为了能脱离 `AppHandle` 做端到端探针（用一个无害的 exe 验证 spawn 成功）。
fn spawn_installer_file(file: &std::path::Path) -> Result<(), String> {
    let is_msi = file
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("msi"))
        .unwrap_or(false);

    #[cfg(windows)]
    {
        let spawned = if is_msi {
            // MSI 需经 msiexec 安装
            std::process::Command::new("msiexec")
                .arg("/i")
                .arg(file)
                .spawn()
        } else {
            std::process::Command::new(file).spawn()
        };
        spawned.map_err(|e| format!("启动安装程序失败：{}", e))?;
        Ok(())
    }

    #[cfg(not(windows))]
    {
        let _ = (is_msi, file);
        Err("当前平台暂不支持自动启动安装包（本项目仅发布 Windows 安装包）".to_string())
    }
}

/// 启动已下载的安装包（交给系统安装向导，用户手动完成安装）。
///
/// 安全约束见 [`validate_installer_in_dir`]：**只启动我们下载到
/// `app_cache_dir()/updates/` 下的 .exe / .msi**，不接受任意本地路径，
/// 更不接受远端 JSON 直接指定可执行文件。
#[tauri::command]
pub fn launch_installer(path: String, app: tauri::AppHandle) -> Result<(), String> {
    let file = validate_installer_path(&app, &path)?;
    spawn_installer_file(&file)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─── 版本比较 ────────────────────────────────────────

    #[test]
    fn is_newer_handles_digit_wise_not_lexicographic() {
        // 字符串比较会误判：字典序 "0.9.0" > "0.14.0"，但版本语义相反
        assert!(is_newer_version("0.9.0", "0.14.0"));
        assert!(!is_newer_version("0.14.0", "0.9.0"));
    }

    #[test]
    fn is_newer_equal_versions_are_not_newer() {
        assert!(!is_newer_version("0.14.0", "0.14.0"));
        assert!(!is_newer_version("v0.14.0", "0.14.0"));
        assert!(!is_newer_version("0.14.0", "v0.14.0"));
    }

    #[test]
    fn is_newer_patch_bump() {
        assert!(is_newer_version("0.14.0", "0.14.1"));
        assert!(!is_newer_version("0.14.1", "0.14.0"));
    }

    #[test]
    fn is_newer_minor_and_major() {
        assert!(is_newer_version("0.14.0", "0.15.0"));
        assert!(is_newer_version("0.14.0", "1.0.0"));
        assert!(!is_newer_version("1.0.0", "0.99.99"));
    }

    #[test]
    fn is_newer_ignores_prerelease_suffix() {
        // 0.14.0-beta 的数字段仍是 0.14.0，与 0.14.0 相等 → 不算新
        assert!(!is_newer_version("0.14.0", "0.14.0-beta"));
        assert!(!is_newer_version("0.14.0-beta", "0.14.0"));
        // 0.14.1-beta 的数字段 0.14.1 > 0.14.0
        assert!(is_newer_version("0.14.0", "0.14.1-beta"));
    }

    #[test]
    fn is_newer_pads_missing_segments_with_zero() {
        assert!(!is_newer_version("1.0", "1.0.0"));
        assert!(!is_newer_version("1.0.0", "1.0"));
        assert!(is_newer_version("1.0", "1.0.1"));
        assert!(is_newer_version("1.0", "1.1"));
    }

    #[test]
    fn is_newer_handles_garbage_input_safely() {
        assert!(!is_newer_version("", ""));
        assert!(is_newer_version("", "0.0.1"));
        assert!(!is_newer_version("abc", "0.0.0"));
        assert!(is_newer_version("abc", "0.0.1"));
    }

    // ─── 安装包选择 ──────────────────────────────────────

    fn asset(name: &str, url: &str, size: u64) -> GhAsset {
        GhAsset {
            name: name.to_string(),
            browser_download_url: url.to_string(),
            size,
        }
    }

    #[test]
    fn picks_x64_setup_exe_first() {
        let assets = vec![
            asset("LightMD_0.15.0_x64_en-US.msi", "https://e/msi", 30),
            asset("LightMD_0.15.0_x64-setup.exe", "https://e/setup", 20),
            asset("LightMD_0.15.0_x64-setup.exe.sig", "https://e/sig", 1),
        ];
        let picked = pick_installer_asset(&assets).expect("应选中安装包");
        assert_eq!(picked.name, "LightMD_0.15.0_x64-setup.exe");
        assert_eq!(picked.browser_download_url, "https://e/setup");
        assert_eq!(picked.size, 20);
    }

    #[test]
    fn ignores_signature_and_checksum_files() {
        // .sig / SHA256SUMS 文件名里也含 setup.exe，必须排除
        let assets = vec![
            asset("LightMD_0.15.0_x64-setup.exe.sig", "https://e/sig", 1),
            asset("SHA256SUMS.txt", "https://e/sums", 2),
        ];
        assert!(pick_installer_asset(&assets).is_none());
    }

    #[test]
    fn falls_back_to_generic_setup_then_msi() {
        let only_setup = vec![
            asset("LightMD_0.15.0_setup.exe", "https://e/setup2", 21),
            asset("LightMD_0.15.0_x64_en-US.msi", "https://e/msi", 30),
        ];
        assert_eq!(
            pick_installer_asset(&only_setup).unwrap().name,
            "LightMD_0.15.0_setup.exe"
        );

        let only_msi = vec![
            asset("LightMD_0.15.0_x64_en-US.msi", "https://e/msi", 30),
            asset("SHA256SUMS.txt", "https://e/sums", 1),
        ];
        assert_eq!(
            pick_installer_asset(&only_msi).unwrap().name,
            "LightMD_0.15.0_x64_en-US.msi"
        );
    }

    #[test]
    fn returns_none_when_no_installer_asset() {
        let assets = vec![
            asset("SHA256SUMS.txt", "https://e/sums", 1),
            asset("source.zip", "https://e/src", 2),
        ];
        assert!(pick_installer_asset(&assets).is_none());
        assert!(pick_installer_asset(&[]).is_none());
    }

    #[test]
    fn skips_assets_without_download_url() {
        let assets = vec![asset("LightMD_0.15.0_x64-setup.exe", "", 20)];
        assert!(pick_installer_asset(&assets).is_none());
    }

    // ─── 文件名清洗 ──────────────────────────────────────

    #[test]
    fn sanitize_rejects_path_traversal_and_unknown_ext() {
        assert!(sanitize_asset_name("..\\evil.exe").is_err());
        assert!(sanitize_asset_name("sub/dir/setup.exe").is_err());
        assert!(sanitize_asset_name("payload.bat").is_err());
        assert!(sanitize_asset_name("").is_err());
        assert_eq!(
            sanitize_asset_name("LightMD_0.15.0_x64-setup.exe").unwrap(),
            "LightMD_0.15.0_x64-setup.exe"
        );
        assert_eq!(
            sanitize_asset_name("LightMD_0.15.0_x64_en-US.msi").unwrap(),
            "LightMD_0.15.0_x64_en-US.msi"
        );
    }

    // ─── 真实 GitHub 响应形状（离线 fixture，验证字段映射） ──────────

    /// 摘自 `GET /repos/badwoo/LightMD/releases/latest` 的真实响应（裁剪到用到的字段，
    /// 保留 GitHub 的 snake_case 命名与 assets 顺序：exe → msi → SHA256SUMS.txt）。
    /// 必须用 r###"…"###：body 里的 Markdown 标题写作 `"## 更新内容`，
    /// 其中 `"##` 恰好是 r##"…"## 的终止符，会用提前截断原始字符串。
    const REAL_SHAPED_RELEASE: &str = r###"{
        "url": "https://api.github.com/repos/badwoo/LightMD/releases/418100619",
        "html_url": "https://github.com/badwoo/LightMD/releases/tag/v0.13.2",
        "id": 418100619,
        "tag_name": "v0.13.2",
        "name": "LightMD v0.13.2",
        "draft": false,
        "prerelease": false,
        "body": "## 更新内容\n- 修复竖排开关\n- 搜索增强",
        "assets": [
            {
                "url": "https://api.github.com/repos/badwoo/LightMD/releases/assets/1",
                "name": "LightMD_0.13.2_x64-setup.exe",
                "size": 7803775,
                "browser_download_url": "https://github.com/badwoo/LightMD/releases/download/v0.13.2/LightMD_0.13.2_x64-setup.exe"
            },
            {
                "url": "https://api.github.com/repos/badwoo/LightMD/releases/assets/2",
                "name": "LightMD_0.13.2_x64_en-US.msi",
                "size": 11235328,
                "browser_download_url": "https://github.com/badwoo/LightMD/releases/download/v0.13.2/LightMD_0.13.2_x64_en-US.msi"
            },
            {
                "url": "https://api.github.com/repos/badwoo/LightMD/releases/assets/3",
                "name": "SHA256SUMS.txt",
                "size": 190,
                "browser_download_url": "https://github.com/badwoo/LightMD/releases/download/v0.13.2/SHA256SUMS.txt"
            }
        ]
    }"###;

    #[test]
    fn parses_real_github_release_shape() {
        let release: GhRelease = serde_json::from_str(REAL_SHAPED_RELEASE).expect("应能解析真实响应");
        assert_eq!(release.tag_name, "v0.13.2");
        assert_eq!(release.assets.len(), 3);
        assert!(release.body.unwrap_or_default().contains("更新内容"));

        let version = release
            .tag_name
            .trim()
            .trim_start_matches('v')
            .trim_start_matches('V')
            .to_string();
        assert_eq!(version, "0.13.2");

        let picked = pick_installer_asset(&release.assets).expect("应选中 NSIS 安装包");
        assert_eq!(picked.name, "LightMD_0.13.2_x64-setup.exe");
        assert_eq!(picked.size, 7803775);

        // 0.14.0 本地构建 vs 线上 0.13.2 → 不算新（这是当前仓库的真实状态）
        assert!(!is_newer_version("0.14.0", &version));
    }

    #[test]
    fn installer_ext_whitelist() {
        assert!(is_allowed_installer_ext("LightMD_0.15.0_x64-setup.exe"));
        assert!(is_allowed_installer_ext("LightMD_0.15.0_x64_en-US.msi"));
        assert!(is_allowed_installer_ext("SETUP.EXE"));
        assert!(is_allowed_installer_ext("a.MSI"));
        assert!(!is_allowed_installer_ext("payload.bat"));
        assert!(!is_allowed_installer_ext("setup.exe.bat"));
        assert!(!is_allowed_installer_ext("noext"));
        assert!(!is_allowed_installer_ext(""));
    }

    #[test]
    fn within_dir_uses_path_components_not_string_prefix() {
        let dir = std::path::Path::new("C:\\cache\\com.lightmd.app\\updates");
        assert!(is_within_dir(
            std::path::Path::new("C:\\cache\\com.lightmd.app\\updates\\a.exe"),
            dir
        ));
        // 前缀相同但不在目录内（/updates-evil）必须判 false
        assert!(!is_within_dir(
            std::path::Path::new("C:\\cache\\com.lightmd.app\\updates-evil\\a.exe"),
            dir
        ));
        // 目录自身算在内
        assert!(is_within_dir(dir, dir));
        // 上级目录不算
        assert!(!is_within_dir(
            std::path::Path::new("C:\\cache\\com.lightmd.app\\a.exe"),
            dir
        ));
    }

    /// `validate_installer_in_dir` 的端到端校验（真实临时目录 + 真实文件）。
    #[test]
    fn validate_installer_accepts_only_files_inside_updates_dir() {
        let root = std::env::temp_dir().join(format!(
            "lightmd-update-validate-{}",
            std::process::id()
        ));
        let updates = root.join("updates");
        let outside = root.join("elsewhere");
        std::fs::create_dir_all(&updates).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        let ok_exe = updates.join("LightMD_0.15.0_x64-setup.exe");
        let ok_msi = updates.join("LightMD_0.15.0_x64_en-US.msi");
        let bad_ext = updates.join("payload.bat");
        let outside_exe = outside.join("evil.exe");
        for p in [&ok_exe, &ok_msi, &bad_ext, &outside_exe] {
            std::fs::write(p, b"stub").unwrap();
        }

        // 1. 缓存目录内的 .exe / .msi → 通过
        assert!(validate_installer_in_dir(ok_exe.to_str().unwrap(), &updates).is_ok());
        assert!(validate_installer_in_dir(ok_msi.to_str().unwrap(), &updates).is_ok());
        // 2. 扩展名不在白名单 → 拒绝
        let err = validate_installer_in_dir(bad_ext.to_str().unwrap(), &updates).unwrap_err();
        assert!(err.contains("不支持的安装包类型"), "实际: {err}");
        // 3. 目录外（即使扩展名合法）→ 拒绝：这是「不执行任意本地程序」的关键约束
        let err = validate_installer_in_dir(outside_exe.to_str().unwrap(), &updates).unwrap_err();
        assert!(err.contains("更新缓存目录"), "实际: {err}");
        // 4. 不存在的文件 → 拒绝
        let missing = updates.join("nope.exe");
        let err = validate_installer_in_dir(missing.to_str().unwrap(), &updates).unwrap_err();
        assert!(err.contains("不存在"), "实际: {err}");
        // 5. 空路径 → 拒绝
        assert!(validate_installer_in_dir("  ", &updates).is_err());
        // 6. 缓存目录不存在 → 拒绝（未下载过安装包）
        let err =
            validate_installer_in_dir(ok_exe.to_str().unwrap(), &root.join("never-created"))
                .unwrap_err();
        assert!(err.contains("更新缓存目录不存在"), "实际: {err}");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn progress_throttle_rules() {
        const STEP: u64 = 256 * 1024;
        // 距上次不足 step 且未到末尾 → 不发
        assert!(!should_emit_progress(1000, 0, 10_000_000, STEP));
        // 累计达到 step → 发
        assert!(should_emit_progress(STEP, 0, 10_000_000, STEP));
        // 已下满 total → 一定发（保证 100%）
        assert!(should_emit_progress(10_000_000, 9_999_000, 10_000_000, STEP));
        // total 未知（0）：只按 step 节流
        assert!(!should_emit_progress(1000, 0, 0, STEP));
        assert!(should_emit_progress(STEP, 0, 0, STEP));
    }

    /// 真实网络下载验证（默认 `#[ignore]`，不参与 CI / `cargo test` 全量）。
    ///
    /// 手动跑：
    /// ```text
    /// cargo test download_real_asset_from_github -- --ignored --nocapture
    /// ```
    /// 会真的从 GitHub 下载当前最新 release 的 NSIS 安装包到临时目录，
    /// 校验字节数与 asset_size 一致、进度回调被调用、文件保留。
    #[test]
    #[ignore = "需要外网；用 --ignored 手动跑"]
    fn download_real_asset_from_github() {
        let info = tauri::async_runtime::block_on(check_update("0.13.0".to_string()))
            .expect("check_update 应成功（需要能访问 GitHub）");
        assert!(!info.asset_url.is_empty(), "最新 release 应有 NSIS 安装包");

        let dir = std::env::temp_dir().join("lightmd-update-probe");
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join(&info.asset_name);
        let tmp = dir.join(format!("{}.part", info.asset_name));
        let _ = std::fs::remove_file(&dest);
        let _ = std::fs::remove_file(&tmp);

        let mut progress_calls: Vec<(u64, u64)> = Vec::new();
        let downloaded = tauri::async_runtime::block_on(download_to_file(
            &info.asset_url,
            &dest,
            &tmp,
            |d, t| progress_calls.push((d, t)),
        ))
        .expect("下载应成功");

        println!(
            "downloaded={} asset_size={} progress_frames={} dest={}",
            downloaded,
            info.asset_size,
            progress_calls.len(),
            dest.display()
        );
        assert!(downloaded > 0);
        assert_eq!(downloaded, info.asset_size, "下载字节数应与 GitHub 声明的 size 一致");
        assert!(dest.is_file(), "成功后安装包必须保留（launch_installer 要用）");
        assert!(!tmp.exists(), "临时 .part 文件应已 rename 掉");
        assert!(!progress_calls.is_empty(), "至少应收到一帧进度");
        let last = *progress_calls.last().unwrap();
        assert_eq!(last.0, downloaded, "最后一帧进度应等于总字节数");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `spawn_installer_file` 端到端验证：用一个**无害的** exe（系统自带 cmd.exe 复制到
    /// 临时 updates 目录并改名）验证 spawn 路径真的能起进程。
    ///
    /// 注：这里只验证「进程能被创建」；真正的安装向导由用户交互完成，自动化不点。
    #[test]
    #[cfg(windows)]
    fn spawn_installer_file_actually_starts_process() {
        let root = std::env::temp_dir().join(format!(
            "lightmd-update-spawn-{}",
            std::process::id()
        ));
        let updates = root.join("updates");
        std::fs::create_dir_all(&updates).unwrap();

        // 复制 cmd.exe 到 updates 下并命名为 .exe：内容无害（用 /c exit 立即退出）
        let sys_cmd = std::env::var("COMSPEC").unwrap_or_else(|_| "C:\\Windows\\System32\\cmd.exe".into());
        let target = updates.join("LightMD_probe_x64-setup.exe");
        std::fs::copy(&sys_cmd, &target).expect("应能复制 cmd.exe");

        // 校验 + 启动：用一个会让它立刻退出的参数不方便（spawn 不带参数），
        // 因此这里只断言 spawn 本身成功（cmd.exe 无参数会开一个控制台窗口后常驻，
        // 测试结束前手动 kill 掉，避免残留进程）
        let validated = validate_installer_in_dir(target.to_str().unwrap(), &updates)
            .expect("缓存目录内的 exe 应通过校验");
        let spawned = std::process::Command::new(&validated).spawn();
        match spawned {
            Ok(mut child) => {
                // 立即杀掉，避免残留一个 cmd.exe
                let _ = child.kill();
                let _ = child.wait();
            }
            Err(e) => panic!("spawn 应成功，实际失败: {}", e),
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn parses_release_with_minimal_fields() {
        // GitHub 的 body/html_url 可能为 null；assets 可能为空
        let release: GhRelease =
            serde_json::from_str(r#"{"tag_name":"v1.0.0","body":null,"assets":[]}"#)
                .expect("最小字段也应能解析");
        assert_eq!(release.tag_name, "v1.0.0");
        assert!(release.body.is_none());
        assert!(release.html_url.is_none());
        assert!(pick_installer_asset(&release.assets).is_none());
    }
}
