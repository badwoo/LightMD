//! v0.9.0 多窗口：窗口生命周期与跨窗口协作命令。
//!
//! 命令分组：
//! - **创建/引导**：`create_window` / `create_window_with_files` / `take_window_boot`
//! - **状态上报与查询**：`sync_window_state` / `query_file_open` / `list_windows` / `focus_window`
//! - **关闭流程**：`abort_close` / `confirm_close`（配合 lib.rs 的 `CloseRequested` 拦截）
//! - **会话**：`has_session` / `get_window_session` / `restore_windows` / `discard_session`
//!
//! 约定：凡是「对调用者自身窗口生效」的命令都通过 `WebviewWindow` 参数拿到调用者 label
//! （Tauri 自动注入），前端无需传 label —— 避免前端自报 label 与真实窗口不一致。

use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use crate::commands::watcher;
use crate::translate::TranslateState;
use crate::window::open_files::{self, OpenFileRef};
use crate::window::session::{self, SessionSnapshot, WindowSession};
use crate::window::{
    self, AppWindowManager, MovedTab, WindowBoot, WindowSummary, ERR_WINDOW_LIMIT, PRIMARY_LABEL,
};

/// 会话恢复：单窗口允许恢复的标签数上限（防御异常大的会话文件）
const MAX_RESTORE_TABS: usize = 200;

// ───────────────────────── 创建与引导 ─────────────────────────

/// 创建辅助窗口。
///
/// `files`：新窗口创建后要打开的文件（右键「在新窗口中打开」/ 外部文件策略）。
/// `movedTabs`：从其他窗口迁移过来的标签（「移动到新窗口」）。
///
/// 返回新窗口 label（= 固定槽位 `sec-N`）。
#[tauri::command]
pub async fn create_window(
    app: AppHandle,
    files: Option<Vec<String>>,
    moved_tabs: Option<Vec<MovedTab>>,
) -> Result<String, String> {
    create_secondary(
        &app,
        None,
        files.unwrap_or_default(),
        false,
        moved_tabs.unwrap_or_default(),
    )
}

/// 同 `create_window`：独立入口供「询问」策略对话框调用（语义更明确）
#[tauri::command]
pub async fn create_window_with_files(app: AppHandle, files: Vec<String>) -> Result<String, String> {
    create_secondary(&app, None, files, false, Vec::new())
}

/// 内部共用：选/校验槽位 → 建窗（不持锁）→ 登记；失败回滚槽位。
///
/// `requested_label` 用于会话恢复（必须复用原 label，否则窗口级 localStorage key
/// 与 untitled 内容/滚动进度对不上）。
fn create_secondary(
    app: &AppHandle,
    requested_label: Option<String>,
    files: Vec<String>,
    restore: bool,
    moved_tabs: Vec<MovedTab>,
) -> Result<String, String> {
    let state = app.state::<AppWindowManager>();
    let label = {
        let mut mgr = state.lock();
        if mgr.is_full() {
            return Err(ERR_WINDOW_LIMIT.to_string());
        }
        let label = match requested_label {
            Some(l) => {
                if !mgr.is_label_free(&l) {
                    return Err(format!("窗口槽位已占用: {}", l));
                }
                l
            }
            None => mgr
                .allocate_label()
                .ok_or_else(|| ERR_WINDOW_LIMIT.to_string())?,
        };
        mgr.reserve(&label);
        mgr.set_pending_boot(&label, files, restore, moved_tabs);
        label
    };
    eprintln!("[LightMD] create window: {} (restore={})", label, restore);

    // build 内部会 run_on_main_thread 等待，故此处绝不持锁（否则与主线程的
    // CloseRequested 回调争锁造成死锁）
    match window::build_secondary_window(app, &label) {
        Ok(_) => {
            state.lock().register(&label, window::now_ms());
            Ok(label)
        }
        Err(e) => {
            state.lock().discard(&label);
            Err(e)
        }
    }
}

/// 新窗口挂载后取走引导数据（幂等：取走后清空，重复调用返回空壳）。
#[tauri::command]
pub fn take_window_boot(window: WebviewWindow, state: State<'_, AppWindowManager>) -> WindowBoot {
    let label = window.label().to_string();
    let boot = state.lock().take_boot(&label);
    // 低量诊断：每个窗口一生只打一行（用于确认前端已挂载并取到引导数据）
    eprintln!(
        "[LightMD] window ready: label={} primary={} restore={} fresh={} files={} moved={}",
        boot.label,
        boot.is_primary,
        boot.restore,
        boot.fresh,
        boot.files.len(),
        boot.moved_tabs.len()
    );
    boot
}

// ───────────────────────── 状态上报与查询 ─────────────────────────

/// 前端上报本窗口的标签集合/打开文件夹/活跃下标。
///
/// 调用时机：标签元数据（path/id/name/pinned/dirty）、打开文件夹或活跃标签变化时
/// ——**不含正文内容**，且前端会先做指纹比对，因此实际调用频率很低。
#[tauri::command]
pub fn sync_window_state(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppWindowManager>,
    report: WindowSession,
) -> Result<(), String> {
    let label = window.label().to_string();
    let paths = {
        let mut mgr = state.lock();
        mgr.sync_window(&label, report);
        mgr.watched_file_paths()
    };

    // 文件级监听池与已打开文件集合保持一致；超限只在上升沿提示一次
    let overflow = open_files::sync_file_watchers(&app, &paths).err();
    let warn = state.lock().note_watch_overflow(overflow.is_some());
    if warn {
        let _ = app.emit(
            "lightmd:watchLimitReached",
            serde_json::json!({
                "limit": open_files::MAX_FILE_WATCHERS,
                "overflow": overflow.unwrap_or(0),
            }),
        );
    }
    Ok(())
}

/// 打开文件前查询：该文件当前被哪些窗口打开、是否 dirty（冲突检测数据源）
#[tauri::command]
pub fn query_file_open(state: State<'_, AppWindowManager>, path: String) -> Vec<OpenFileRef> {
    state.lock().query_file_open(&path)
}

/// 窗口列表（标题栏「窗口」菜单数据源）
#[tauri::command]
pub fn list_windows(state: State<'_, AppWindowManager>) -> Vec<WindowSummary> {
    state.lock().summaries()
}

/// 激活指定窗口（窗口列表点击 / 冲突对话框「切换到已有窗口」）
#[tauri::command]
pub fn focus_window(app: AppHandle, label: String) -> Result<(), String> {
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("窗口不存在: {}", label))?;
    let _ = window.unminimize();
    let _ = window.show();
    window
        .set_focus()
        .map_err(|e| format!("激活窗口失败: {}", e))
}

/// 请求关闭指定窗口（走 `close()` → 触发 `CloseRequested` 拦截 → 前端确认流程）
#[tauri::command]
pub fn request_close_window(app: AppHandle, label: String) -> Result<(), String> {
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("窗口不存在: {}", label))?;
    window.close().map_err(|e| format!("关闭窗口失败: {}", e))
}

/// 向指定窗口发送一条事件（「切换到已有窗口」/「跨窗口迁移标签」等定向事件）。
///
/// ⚠️ Tauri v2 语义陷阱：JS 侧 `listen(name)` 注册的目标是 `EventTarget::Any`，
/// 而 `emit_to(label, ...)` 只过滤**监听器注册时的目标**，不过滤接收 webview 集合
/// —— 即 **所有**窗口都会收到定向事件。故这里把目标 label 注入载荷
/// （`{ target, payload }`），由前端按自身 label 过滤（`unwrapTargetedEvent`）。
#[tauri::command]
pub fn emit_to_window(
    app: AppHandle,
    label: String,
    event: String,
    payload: serde_json::Value,
) -> Result<(), String> {
    if app.get_webview_window(&label).is_none() {
        return Err(format!("窗口不存在: {}", label));
    }
    app.emit_to(
        &label,
        &event,
        serde_json::json!({ "target": label, "payload": payload }),
    )
    .map_err(|e| format!("发送事件失败: {}", e))
}

// ───────────────────────── 关闭流程 ─────────────────────────

/// 前端取消关闭（dirty 确认框点「取消」）
#[tauri::command]
pub fn abort_close(window: WebviewWindow, state: State<'_, AppWindowManager>) {
    state.lock().abort_close(window.label());
}

/// 前端确认关闭：清理 → 落盘会话 → 晋升 Primary → 销毁窗口。
///
/// 清理项（实施计划 §3.11）：
/// 1. 该窗口的 AI 任务槽（防孤儿流式请求继续输出）
/// 2. 该窗口的目录 watcher 引用计数
/// 3. OPEN_FILES 登记 + 窗口表
/// 4. 若原为 Primary → 晋升最老辅助窗口
/// 5. 会话快照落盘（`ever_multi_window` 规则）
#[tauri::command]
pub fn confirm_close(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppWindowManager>,
) -> Result<(), String> {
    let label = window.label().to_string();
    let folders = state.lock().folder_paths_of(&label);

    // 1. AI 任务槽按窗口分桶清理
    app.state::<TranslateState>().cancel_window_tasks(&label);
    // 2. 目录 watcher 引用释放（其他窗口仍开着同一目录时 watcher 保留）
    for path in &folders {
        watcher::release_folder_for_window(path, &label);
    }

    // 3+4. 登记清理与 Primary 晋升
    let (new_primary, was_primary, ever_multi, window_count_after, snapshot) = {
        let mut mgr = state.lock();
        // 关闭前的最后上报：关掉最后一个窗口（= 退出应用）时要把它一并写进快照
        let closing_state = mgr.window_session_of(&label);
        let (_, was_primary) = mgr.remove_window(&label);
        if was_primary {
            mgr.promote_primary();
        }
        let new_primary = mgr.primary_label().to_string();
        let ever_multi = mgr.ever_multi_window();
        let window_count_after = mgr.window_count();
        // 关闭的这个窗口已从注册表移除，故快照天然只含存活窗口（+ 主窗口最后状态）；
        // 关掉最后一个时额外补上它自己（见 `snapshot_after_close`）
        let snapshot = mgr.snapshot_after_close(
            closing_state.as_ref(),
            window_count_after == 0,
            window::now_ms(),
        );
        // 放行标记最后设置（`remove_window` 会清除它）：万一某平台 destroy 也会
        // 触发 CloseRequested，此处兜底放行，避免形成「拦截 → 再确认」死循环
        mgr.approve_close(&label);
        (new_primary, was_primary, ever_multi, window_count_after, snapshot)
    };

    // 5. 会话落盘：v0.9.0 第二轮修复——**关掉最后一个窗口时也必须重写**。
    //    快照 = 仍存活的窗口 + 主窗口最后状态（`main_state`）+（关掉最后一个时）
    //   这个即将消失的窗口自身，因此它正是"用户看到的最后画面"。
    //    旧实现跳过这一步，导致「单窗口（或最后关掉主窗口）关掉应用」后磁盘上仍是
    //    上一次会话的旧数据——用户重开软件看到的是过期的标签集合，甚至一片空白
    //    （用户反馈：关闭时选择"不保存"后重开，所有标签都被关闭了）。
    persist_session(&app, ever_multi, &snapshot);
    eprintln!(
        "[LightMD] confirm close: {} primary={} everMulti={} live_after={} snapshot={}",
        label,
        new_primary,
        ever_multi,
        window_count_after,
        snapshot.windows.len()
    );

    // 6. 通知晋升后的 Primary（前端据此更新窗口菜单/提示）
    if was_primary {
        window::emit_became_primary(&app, &new_primary);
    }

    // 7. destroy 不再触发 CloseRequested，避免二次拦截形成死循环
    window.destroy().map_err(|e| format!("销毁窗口失败: {}", e))
}

/// 会话落盘规则（v0.9.0 第二轮修订）：
///
/// - **出现过 ≥2 窗口的本会话**，或**磁盘上已有上一次会话**（回访的多窗口用户即便
///   这次只开了主窗口，也应继续按会话快照精确恢复标签，而不是退回 v0.8.5 的「最近
///   文件」近似恢复）→ 写入快照；
/// - 其余情况（纯单窗口用户，从未有过会话文件）→ 删除会话文件，保持 v0.8.5 语义
///   （REG-1：最近文件 + 临时标签恢复）；
/// - 空快照永不写盘：宁可保留上一次有效会话，也不要把「会话记录」清成空。
pub(crate) fn persist_session(app: &AppHandle, ever_multi: bool, snapshot: &SessionSnapshot) {
    let had_session = matches!(session::read_session(app), Ok(Some(_)));
    if ever_multi || had_session {
        if snapshot.windows.is_empty() {
            return;
        }
        if let Err(e) = session::write_session(app, snapshot) {
            eprintln!("[LightMD] 会话保存失败: {}", e);
        }
    } else if let Err(e) = session::remove_session(app) {
        eprintln!("[LightMD] 会话清理失败: {}", e);
    }
}

/// 显式退出应用（窗口菜单 / 命令面板 `Ctrl+Q`）。
///
/// 与「逐个关闭窗口」的关键差异：此刻所有窗口仍存活，因此会话快照记录的是
/// **完整的窗口集合**；下次启动若开启「恢复其他窗口」即可全部还原。
/// 反之，用户主动关掉的窗口不会出现在快照里，也就不会在下次启动时复活。
#[tauri::command]
pub fn quit_app(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppWindowManager>();
    let (ever_multi, snapshot) = {
        let mgr = state.lock();
        (mgr.ever_multi_window(), mgr.snapshot_with(window::now_ms()))
    };
    persist_session(&app, ever_multi, &snapshot);
    eprintln!(
        "[LightMD] quit app: everMulti={} windows={}",
        ever_multi,
        snapshot.windows.len()
    );
    app.exit(0);
    Ok(())
}

// ───────────────────────── 会话恢复 ─────────────────────────

/// 是否存在上次多窗口会话（前端据此决定是否执行恢复）
#[tauri::command]
pub fn has_session(app: AppHandle) -> bool {
    matches!(session::read_session(&app), Ok(Some(_)))
}

/// 取指定窗口的会话数据（标签/文件夹/活跃下标）。
///
/// 返回值已做防御性裁剪：标签数上限 [`MAX_RESTORE_TABS`]、活跃下标钳制到合法范围。
#[tauri::command]
pub fn get_window_session(app: AppHandle, label: String) -> Option<WindowSession> {
    let snap = session::read_session(&app).ok().flatten()?;
    let mut found = snap.windows.into_iter().find(|w| w.label == label)?;
    found.tabs.truncate(MAX_RESTORE_TABS);
    if found.tabs.is_empty() {
        found.active_tab_idx = 0;
    } else if found.active_tab_idx >= found.tabs.len() {
        found.active_tab_idx = found.tabs.len() - 1;
    }
    Some(found)
}

/// 按会话快照重建辅助窗口（Primary 已由 tauri.conf.json 创建，此处只建 sec-*）。
///
/// **必须复用快照中的原 label**：窗口级 localStorage key（`-sec-N` 后缀）与
/// untitled 内容/滚动进度/上次活跃标签都按 label 存储，换 label 等于丢数据。
/// 单个窗口创建失败不影响其余窗口（宁可少恢复一个，也不能让应用起不来）。
#[tauri::command]
pub async fn restore_windows(app: AppHandle) -> Result<Vec<String>, String> {
    let Some(snap) = session::read_session(&app).ok().flatten() else {
        return Ok(Vec::new());
    };

    let mut created = Vec::new();
    for entry in snap.windows {
        let label = entry.label.clone();
        // Primary 由配置创建；非法/未知 label 一律跳过
        if label == PRIMARY_LABEL || !label.starts_with("sec-") {
            continue;
        }
        if app.get_webview_window(&label).is_some() {
            continue;
        }
        match create_secondary(&app, Some(label.clone()), Vec::new(), true, Vec::new()) {
            Ok(_) => created.push(label),
            Err(e) => eprintln!("[LightMD] 恢复窗口 {} 失败: {}", label, e),
        }
    }
    Ok(created)
}

/// 丢弃上次会话（用户关闭「启动载入上次文件」或选择不恢复时调用）
#[tauri::command]
pub fn discard_session(app: AppHandle) -> Result<(), String> {
    open_files::clear_file_watchers();
    session::remove_session(&app)
}

/// 只保留主窗口条目的会话快照（「启动时恢复其他窗口」关闭时的收敛动作）。
///
/// v0.9.0 第二轮修复：旧实现在这里直接 `discard_session`（整份丢弃），结果是主窗口
/// 下次启动退回 v0.8.5 的「最近文件」近似恢复——默认只回 1 个文件，用户感知为
/// "标签丢了/被关闭了"。改为只裁掉辅助窗口条目：既保证不再复活已关闭的辅助窗口，
/// 又让主窗口继续按会话快照精确恢复全部标签与文件夹。
///
/// 快照里若没有主窗口条目（旧版本写坏的残缺快照），保持原文件不动——主窗口本次关闭时
/// `confirm_close` 会把它的最新状态写进去，下一次启动即自愈。
#[tauri::command]
pub fn prune_session_secondaries(app: AppHandle) -> Result<(), String> {
    let Some(mut snapshot) = session::read_session(&app).ok().flatten() else {
        return Ok(());
    };
    let before = snapshot.windows.len();
    snapshot.windows.retain(|w| w.label == PRIMARY_LABEL);
    if snapshot.windows.is_empty() || snapshot.windows.len() == before {
        return Ok(());
    }
    session::write_session(&app, &snapshot)
}
