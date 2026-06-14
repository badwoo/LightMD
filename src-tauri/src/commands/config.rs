use serde::{Deserialize, Serialize};

/// 应用配置结构
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub theme: String,
    pub font_size: u32,
    pub font_family: String,
    pub auto_save_interval_ms: u64,
    pub default_export_format: String,
    pub custom_css: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            theme: "light".to_string(),
            font_size: 16,
            font_family: "var(--font-sans)".to_string(),
            auto_save_interval_ms: 3000,
            default_export_format: "html".to_string(),
            custom_css: String::new(),
        }
    }
}

/// 加载配置（从 SQLite 数据库或返回默认值）
#[tauri::command]
pub async fn get_config(app_handle: tauri::AppHandle) -> Result<AppConfig, String> {
    // 尝试从 SQLite 读取配置，失败则返回默认值
    // 当前版本使用默认配置，后续可通过 SQLite 持久化
    let _ = app_handle;
    Ok(AppConfig::default())
}

/// 保存配置到 SQLite 数据库
#[tauri::command]
pub async fn set_config(
    app_handle: tauri::AppHandle,
    config: AppConfig,
) -> Result<(), String> {
    // 后续版本实现 SQLite 持久化
    let _ = app_handle;
    let _ = config;
    Ok(())
}
