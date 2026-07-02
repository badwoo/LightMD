/// 规范化文件路径（统一使用正斜杠）
pub fn normalize_path(path: &str) -> String {
    path.replace('\\', "/")
}

/// 从完整路径提取文件名
pub fn extract_filename(path: &str) -> String {
    let normalized = normalize_path(path);
    normalized.rsplit('/').next().unwrap_or("无标题.md").to_string()
}

/// 检查文件扩展名是否为 Markdown 文件
pub fn is_markdown_file(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".md")
        || lower.ends_with(".markdown")
        || lower.ends_with(".mdown")
        || lower.ends_with(".mkd")
}
