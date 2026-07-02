pub mod commands;
pub mod db;
pub mod utils;

use commands::{config, file_ops, image, export};
use std::io::Cursor;
use tauri::{Emitter, Manager};

/// 判断给定路径是否为 Markdown 文件（按扩展名匹配）
/// 支持 .md / .markdown / .mdown 三种常见扩展名
fn is_markdown_path(arg: &str) -> bool {
    let lower = arg.to_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".mdown")
}

/// 从命令行参数中提取第一个 Markdown 文件路径
/// 跳过程序自身路径和以 `-` / `--` 开头的 Tauri 内部参数
fn extract_md_arg(args: &[String]) -> Option<String> {
    for arg in args.iter().skip(1) {
        if arg.starts_with('-') {
            continue;
        }
        if is_markdown_path(arg) {
            return Some(arg.clone());
        }
    }
    None
}

pub fn run() {
    tauri::Builder::default()
        // 单实例插件：后续启动时不再创建新窗口，而是将 argv 转发给主实例
        // 主实例收到事件后以新标签方式打开文件，实现"双击 .md 文件以标签打开"的体验
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // 后续实例启动时触发：提取文件参数并转发给前端
            if let Some(path) = extract_md_arg(&argv) {
                // 使用 emit_to 主窗口，确保事件能被前端接收
                let _ = app.emit_to("main", "lightmd:openFileArgv", path);
                // 将主窗口提到前台，避免用户感知不到打开动作
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
        }))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_sql::Builder::new().build())
        .setup(|app| {
            // 设置窗口图标
            if let Some(window) = app.get_webview_window("main") {
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
            // 双击 .md 文件首次启动应用时，系统以命令行参数形式传入文件路径
            // 后续双击由 single-instance 插件回调处理（见上方 init）
            let args: Vec<String> = std::env::args().collect();
            if let Some(path) = extract_md_arg(&args) {
                // 延迟发送事件，确保前端已就绪
                // 使用独立线程避免阻塞主线程，同时不依赖 tokio
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    let _ = app_handle.emit("lightmd:openFileArgv", path);
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
            file_ops::exists,
            image::save_image,
            image::get_assets_dir,
            config::get_config,
            config::set_config,
            export::export_pdf,
            export::export_html_to_pdf,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LightMD");
}
