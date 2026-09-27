pub mod commands;
pub mod db;
pub mod translate;
pub mod utils;
pub mod window;

use commands::{config, export, file_ops, image, watcher, window_cmds};
use std::io::Cursor;
use tauri::{Emitter, Manager, WindowEvent};
use translate::TranslateState;
use window::{AppWindowManager, PRIMARY_LABEL};

/// 判断给定路径是否为支持的文本/代码文件（按扩展名匹配）
/// v0.4.0：扩展为支持所有常见代码文件，使双击 .js/.py 等文件也能启动应用
fn is_supported_text_path(arg: &str) -> bool {
    let lower = arg.to_lowercase();
    let exts = [
        ".md", ".markdown", ".mdown", ".mkd",
        ".txt", ".log", ".csv", ".ini", ".conf", ".toml", ".properties",
        ".js", ".mjs", ".cjs", ".ts", ".jsx", ".tsx",
        ".json", ".html", ".htm", ".css", ".scss", ".less", ".sass",
        ".xml", ".svg", ".py", ".rs", ".go", ".java", ".c", ".cpp", ".cc", ".h", ".hpp",
        ".sh", ".bash", ".zsh", ".bat", ".cmd", ".ps1",
        ".yml", ".yaml", ".sql", ".vue", ".svelte",
        ".php", ".rb", ".swift", ".kt", ".kts", ".dart", ".lua", ".r", ".scala", ".pl",
    ];
    exts.iter().any(|ext| lower.ends_with(ext))
}

/// 从命令行参数中提取第一个支持的文本/代码文件路径
/// 跳过程序自身路径和以 `-` / `--` 开头的 Tauri 内部参数
/// v0.4.0：由仅识别 md 扩展为识别所有支持的代码/文本文件
fn extract_file_arg(args: &[String]) -> Option<String> {
    for arg in args.iter().skip(1) {
        if arg.starts_with('-') {
            continue;
        }
        if is_supported_text_path(arg) {
            return Some(arg.clone());
        }
    }
    None
}

/// 把文件路径路由给当前 Primary 窗口（外部双击 / 命令行参数）。
///
/// v0.9.0：不再写死 `"main"` —— 主窗口可能已关闭并由最老辅助窗口晋升，
/// Primary 由 [`AppWindowManager`] 实时给出。
/// 策略判断（当前窗口 / 新窗口 / 询问）在前端完成：设置存在 WebView 的
/// localStorage 里，Rust 读不到（实施计划 F14）。
///
/// ⚠️ 载荷必须携带 `target`：Tauri v2 的 `emit_to` 只过滤监听器注册目标，
/// JS 侧 `listen(name)`（target = Any）会让**所有**窗口都收到定向事件，
/// 前端据此字段判断是否应由自己处理（否则每个窗口都会打开同一个文件）。
fn route_file_to_primary(app: &tauri::AppHandle, path: String) {
    let primary = app
        .state::<AppWindowManager>()
        .lock()
        .primary_label()
        .to_string();
    let _ = app.emit_to(
        &primary,
        "lightmd:openFileArgv",
        serde_json::json!({ "target": primary, "path": path }),
    );
    if let Some(window) = app.get_webview_window(&primary) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// 应用退出前收尾：落盘会话快照 + 释放文件 watcher + 取消全部在途 AI 任务。
///
/// 会话规则（v0.9.0 第二轮修订）：
/// - 快照 = 此刻仍存活的窗口 + 主窗口的最后状态副本（`WindowManager::main_state`），
///   因此**无论此刻是否还有存活窗口都写一次**——「逐个关闭窗口直到最后」是最常见的
///   退出方式，主窗口的标签/文件夹必须留在文件里，否则下次启动主窗口空白
///   （用户反馈：关闭窗口选"不保存"后重开，所有标签都被关闭了）；
/// - 纯单窗口且从未有过会话文件的用户：删除会话文件，保持 v0.8.5 语义（REG-1）。
fn finalize_session(app: &tauri::AppHandle) {
    let state = app.state::<AppWindowManager>();
    let (ever_multi, snapshot) = {
        let mgr = state.lock();
        (mgr.ever_multi_window(), mgr.snapshot_with(window::now_ms()))
    };
    window_cmds::persist_session(app, ever_multi, &snapshot);
    window::open_files::clear_file_watchers();
    app.state::<TranslateState>().cancel_all();
}

pub fn run() {
    let app = tauri::Builder::default()
        // 单实例插件：后续启动时不再创建新窗口，而是将 argv 转发给主实例
        // 主实例收到事件后以新标签方式打开文件，实现"双击支持的文件以标签打开"的体验
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // 后续实例启动时触发：提取文件参数并转发给前端
            // v0.4.0：支持所有代码/文本文件，不仅限于 md
            if let Some(path) = extract_file_arg(&argv) {
                route_file_to_primary(app, path);
            }
        }))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_sql::Builder::new().build())
        // v0.8.3 需求4：窗口状态记忆（大小/位置/最大化标志）。
        // 显式收窄 StateFlags：不记忆 FULLSCREEN / DECORATIONS / VISIBLE 等状态，
        // 避免"用户偶发全屏一次，之后每次启动都全屏"之类的怪行为。
        // v0.9.0：插件对 `on_window_ready` 触发的**运行时创建窗口**同样自动
        // restore/save，故辅助窗口按固定槽位 label 天然获得几何跨会话恢复，
        // session.json 不需要（也不应该）再存一份几何。
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        // v0.6.0 AI 翻译：单任务状态托管（v0.9.0 起按窗口分桶）
        .manage(TranslateState::default())
        // v0.9.0 多窗口：窗口管理器
        .manage(AppWindowManager::default())
        // v0.9.0 多窗口：关闭请求统一走前端确认流程（dirty 检查 → 应用内对话框）
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let label = window.label().to_string();
                let state = window.app_handle().state::<AppWindowManager>();
                let mut mgr = state.lock();
                // 已确认关闭（destroy 路径）→ 直接放行
                let approved = mgr.take_approved_close(&label);
                // 已有未决确认流程（连点关闭按钮）→ 继续拦截但不重复派发
                let first = if approved { false } else { mgr.mark_close_pending(&label) };
                let live = mgr.window_count();
                drop(mgr);
                // 诊断：窗口关闭链路的关键状态（release 构建无控制台，无副作用）
                eprintln!(
                    "[LightMD] CloseRequested label={} approved={} first={} live_windows={}",
                    label, approved, first, live
                );
                if approved {
                    return;
                }
                api.prevent_close();
                if first {
                    let _ = window.app_handle().emit_to(
                        &label,
                        "lightmd:closeRequested",
                        serde_json::json!({ "label": label }),
                    );
                }
            }
        })
        .setup(|app| {
            // v0.9.0：登记主窗口（tauri.conf.json 默认 label = "main"）
            app.state::<AppWindowManager>()
                .lock()
                .register(PRIMARY_LABEL, window::now_ms());

            // 设置窗口图标
            if let Some(window) = app.get_webview_window(PRIMARY_LABEL) {
                let icon_bytes = include_bytes!("../icons/icon.ico");
                if let Ok(ico_dir) = ico::IconDir::read(Cursor::new(icon_bytes)) {
                    if let Some(entry) = ico_dir.entries().into_iter().next() {
                        if let Ok(icon_image) = entry.decode() {
                            let img = tauri::image::Image::new_owned(
                                icon_image.rgba_data().to_vec(),
                                icon_image.width(),
                                icon_image.height(),
                            );
                            let _ = window.set_icon(img);
                        }
                    }
                }
            }

            // ─── 文件关联：处理首次启动时传入的文件路径 ───
            // 双击支持的代码/文本文件首次启动应用时，系统以命令行参数形式传入文件路径
            // 后续双击由 single-instance 插件回调处理（见上方 init）
            // v0.4.0：扩展为支持所有代码/文本文件
            // v0.9.0：策略判断在前端（App.tsx 的 lightmd:openFileArgv 监听处）
            let args: Vec<String> = std::env::args().collect();
            if let Some(path) = extract_file_arg(&args) {
                // 延迟发送事件，确保前端已就绪
                // 使用独立线程避免阻塞主线程，同时不依赖 tokio
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    route_file_to_primary(&app_handle, path);
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            file_ops::ping,
            file_ops::log_from_frontend,
            file_ops::read_file,
            file_ops::write_file,
            file_ops::get_file_size,
            file_ops::list_dir,
            file_ops::create_file,
            file_ops::create_dir,
            file_ops::delete_file,
            file_ops::rename_file,
            file_ops::copy_file,
            // v0.8.4 需求1：移动文件/目录（同盘 rename，跨盘降级复制+删除）
            file_ops::move_file,
            // v0.8.4 需求10：目录实时监听（notify）与注销
            // v0.9.0：加 windowLabel 引用计数（多窗口共享同一 watcher）
            watcher::watch_folder,
            watcher::unwatch_folder,
            file_ops::exists,
            file_ops::reveal_in_folder,
            image::save_image,
            image::get_assets_dir,
            config::get_config,
            config::set_config,
            commands::translate::translate_text,
            commands::translate::cancel_translate,
            commands::translate::test_translate_connection,
            commands::translate::set_translate_key,
            commands::translate::has_translate_key,
            // v0.7.2 P2：动态拉取厂商模型列表
            commands::translate::list_translate_models,
            // v0.7.0：AI 助手（续写/润色/摘要，复用翻译基建与单任务模型）
            commands::ai_assist::ai_assist_text,
            // v0.7.5：AI 对话（多轮 messages + 内置 system 提示词，共享同一任务槽）
            commands::ai_assist::ai_chat,
            export::export_pdf,
            export::export_html_to_pdf,
            // ─── v0.9.0 多窗口 ───
            window_cmds::create_window,
            window_cmds::create_window_with_files,
            window_cmds::take_window_boot,
            window_cmds::sync_window_state,
            window_cmds::query_file_open,
            window_cmds::list_windows,
            window_cmds::focus_window,
            window_cmds::request_close_window,
            window_cmds::emit_to_window,
            window_cmds::abort_close,
            window_cmds::confirm_close,
            window_cmds::has_session,
            window_cmds::get_window_session,
            window_cmds::restore_windows,
            window_cmds::discard_session,
            // v0.9.0 第二轮修复：只裁掉会话里的辅助窗口条目（保留主窗口标签/文件夹）
            window_cmds::prune_session_secondaries,
            // v0.9.0：显式退出（写完整窗口集合后退出，供「恢复其他窗口」下次还原）
            window_cmds::quit_app,
        ])
        .build(tauri::generate_context!())
        .expect("error while running LightMD");

    app.run(|app_handle, event| {
        // 退出前收尾：会话落盘 + watcher/AI 任务清理
        if let tauri::RunEvent::ExitRequested { .. } = event {
            finalize_session(app_handle);
        }
    });
}
