pub mod commands;
pub mod db;
pub mod utils;

use commands::{config, file_ops, image, export};
use std::io::Cursor;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            file_ops::ping,
            file_ops::log_from_frontend,
            file_ops::read_file,
            file_ops::write_file,
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
