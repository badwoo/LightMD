use std::path::PathBuf;

use tauri::Manager;

/// 限制读取文件的最大大小 (50MB)
const MAX_FILE_SIZE: u64 = 50 * 1024 * 1024;

/// 将路径规范化为绝对路径
fn resolve_path(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if p.exists() {
        p.canonicalize()
            .map_err(|e| format!("无法解析路径 \"{}\": {}", path, e))
    } else {
        if p.is_absolute() {
            Ok(p)
        } else {
            std::env::current_dir()
                .map(|cwd| cwd.join(&p))
                .map_err(|e| format!("无法获取当前目录: {}", e))
        }
    }
}

#[tauri::command]
pub async fn read_file(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let path = resolve_path(&path)?;
    if !path.exists() {
        return Err(format!("文件不存在: {}", path.display()));
    }
    if !path.is_file() {
        return Err(format!("路径不是文件: {}", path.display()));
    }
    // v0.6.3 S-3：asset 协议作用域已收敛为空，打开文件时动态授权其所在目录（递归），
    // 供 markdown 相对路径图片预览使用；授权失败不阻断文件读取
    if let Some(parent) = path.parent() {
        let _ = app.asset_protocol_scope().allow_directory(parent, true);
    }
    let meta = path
        .metadata()
        .map_err(|e| format!("无法读取文件元数据 \"{}\": {}", path.display(), e))?;
    if meta.len() > MAX_FILE_SIZE {
        return Err(format!(
            "文件过大（{:.1}MB），最大支持 50MB",
            meta.len() as f64 / 1024.0 / 1024.0
        ));
    }
    std::fs::read_to_string(&path)
        .map_err(|e| format!("读取文件失败 \"{}\": {}", path.display(), e))
}

#[tauri::command]
pub async fn write_file(path: String, content: String) -> Result<(), String> {
    let path = resolve_path(&path)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建父目录 \"{}\": {}", parent.display(), e))?;
    }
    std::fs::write(&path, &content)
        .map_err(|e| format!("写入文件失败 \"{}\": {}", path.display(), e))
}

/// 获取文件大小（字节），用于前端大文件检测
#[tauri::command]
pub async fn get_file_size(path: String) -> Result<u64, String> {
    let path = resolve_path(&path)?;
    if !path.exists() {
        return Err(format!("文件不存在: {}", path.display()));
    }
    let meta = path
        .metadata()
        .map_err(|e| format!("无法读取文件元数据 \"{}\": {}", path.display(), e))?;
    Ok(meta.len())
}

#[tauri::command]
pub async fn list_dir(path: String) -> Result<Vec<FileEntry>, String> {
    let path = resolve_path(&path)?;
    if !path.exists() {
        return Err(format!("目录不存在: {}", path.display()));
    }
    if !path.is_dir() {
        return Err(format!("路径不是目录: {}", path.display()));
    }
    let mut entries = Vec::new();
    let dir = std::fs::read_dir(&path)
        .map_err(|e| format!("读取目录失败 \"{}\": {}", path.display(), e))?;
    for entry in dir {
        let entry =
            entry.map_err(|e| format!("读取目录条目失败 \"{}\": {}", path.display(), e))?;
        let metadata = entry
            .metadata()
            .map_err(|e| format!("读取文件元数据失败: {}", e))?;
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name.starts_with('.') {
            continue;
        }
        entries.push(FileEntry {
            name: file_name,
            path: entry.path().to_string_lossy().to_string().replace('\\', "/"),
            is_dir: metadata.is_dir(),
            size: metadata.len(),
        });
    }
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(entries)
}

#[tauri::command]
pub async fn create_file(path: String) -> Result<(), String> {
    let path = resolve_path(&path)?;
    if path.exists() {
        return Err(format!("文件已存在: {}", path.display()));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建父目录 \"{}\": {}", parent.display(), e))?;
    }
    std::fs::write(&path, "").map_err(|e| format!("创建文件失败 \"{}\": {}", path.display(), e))
}

#[tauri::command]
pub async fn create_dir(path: String) -> Result<(), String> {
    let path = resolve_path(&path)?;
    std::fs::create_dir_all(&path)
        .map_err(|e| format!("创建目录失败 \"{}\": {}", path.display(), e))
}

#[tauri::command]
pub async fn delete_file(path: String) -> Result<(), String> {
    let path = resolve_path(&path)?;
    if !path.exists() {
        return Err(format!("文件不存在: {}", path.display()));
    }
    if path.is_dir() {
        std::fs::remove_dir_all(&path)
            .map_err(|e| format!("删除目录失败 \"{}\": {}", path.display(), e))
    } else {
        std::fs::remove_file(&path)
            .map_err(|e| format!("删除文件失败 \"{}\": {}", path.display(), e))
    }
}

#[tauri::command]
pub async fn rename_file(old_path: String, new_path: String) -> Result<(), String> {
    let old_path = resolve_path(&old_path)?;
    let new_path = resolve_path(&new_path)?;
    if !old_path.exists() {
        return Err(format!("源文件不存在: {}", old_path.display()));
    }
    if new_path.exists() {
        return Err(format!("目标文件已存在: {}", new_path.display()));
    }
    if let Some(parent) = new_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建目标目录 \"{}\": {}", parent.display(), e))?;
    }
    std::fs::rename(&old_path, &new_path).map_err(|e| {
        format!(
            "重命名失败 \"{}\" -> \"{}\": {}",
            old_path.display(),
            new_path.display(),
            e
        )
    })
}

#[tauri::command]
pub async fn ping() -> String {
    "pong".to_string()
}

#[tauri::command]
pub async fn log_from_frontend(level: String, message: String) {
    match level.as_str() {
        "error" => eprintln!("[Frontend ERROR] {}", message),
        "warn" => println!("[Frontend WARN] {}", message),
        _ => println!("[Frontend] {}", message),
    }
}

#[tauri::command]
pub async fn exists(path: String) -> bool {
    PathBuf::from(&path).exists()
}

/// 在系统资源管理器中显示并选中指定文件（N5：右键菜单"打开文件所在目录"）
#[tauri::command]
pub async fn reveal_in_folder(path: String) -> Result<(), String> {
    let path = resolve_path(&path)?;
    if !path.exists() {
        return Err(format!("文件不存在: {}", path.display()));
    }
    #[cfg(target_os = "windows")]
    {
        // explorer /select,<path>：打开父目录并选中该文件
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path.display()))
            .spawn()
            .map_err(|e| format!("打开资源管理器失败: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        // open -R：在 Finder 中显示并选中该文件
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("打开 Finder 失败: {}", e))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // Linux 无统一选中协议，退化为打开父目录
        let parent = path.parent().ok_or_else(|| "无父目录".to_string())?;
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| format!("打开文件管理器失败: {}", e))?;
    }
    Ok(())
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}
