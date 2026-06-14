use std::path::PathBuf;

/// 将 base64 编码的图片数据保存到指定目录
/// 返回保存后的文件路径（可用于 Markdown 图片引用）
#[tauri::command]
pub async fn save_image(
    base64_data: String,
    file_name: String,
    target_dir: String,
) -> Result<String, String> {
    // 解码 base64（支持 "data:image/png;base64,xxx" 格式）
    let data = if base64_data.contains(";base64,") {
        let parts: Vec<&str> = base64_data.splitn(2, ";base64,").collect();
        if parts.len() != 2 {
            return Err("无效的 Base64 图片数据格式".to_string());
        }
        base64_decode(parts[1])?
    } else {
        base64_decode(&base64_data)?
    };

    // 构建目标路径
    let dir = PathBuf::from(&target_dir);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("无法创建 assets 目录 \"{}\": {}", dir.display(), e))?;

    // 确保安全的文件名
    let safe_name = sanitize_filename(&file_name);
    let file_path = dir.join(&safe_name);

    std::fs::write(&file_path, &data)
        .map_err(|e| format!("保存图片失败 \"{}\": {}", file_path.display(), e))?;

    Ok(file_path.to_string_lossy().to_string().replace('\\', "/"))
}

/// 获取项目的 assets 目录路径（相对于打开的 Markdown 文件所在目录）
#[tauri::command]
pub async fn get_assets_dir(md_file_path: String) -> Result<String, String> {
    let md_path = PathBuf::from(&md_file_path);
    let parent = md_path
        .parent()
        .ok_or_else(|| format!("无法获取文件父目录: {}", md_path.display()))?;
    let assets = parent.join("assets");
    Ok(assets.to_string_lossy().to_string().replace('\\', "/"))
}

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(input)
        .map_err(|e| format!("Base64 解码失败: {}", e))
}

/// 清理文件名中的不安全字符
fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c => c,
        })
        .collect()
}
