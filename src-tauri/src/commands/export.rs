/// HTML/PDF 导出命令
use std::path::PathBuf;
use std::process::Command;

/// 将 HTML 内容导出为 PDF 文件
/// 使用 Windows Edge (msedge) 的 headless 模式将 HTML 转换为 PDF
#[tauri::command]
pub async fn export_pdf(html_path: String, pdf_path: String) -> Result<(), String> {
    let html = PathBuf::from(&html_path);
    let pdf = PathBuf::from(&pdf_path);

    if !html.exists() {
        return Err(format!("HTML 文件不存在: {}", html.display()));
    }

    // 确保输出目录存在
    if let Some(parent) = pdf.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建输出目录 \"{}\": {}", parent.display(), e))?;
    }

    // 查找 Edge 可执行文件路径
    let edge_path = find_edge_path()
        .ok_or_else(|| "未找到 Microsoft Edge 浏览器，PDF 导出需要 Edge 支持".to_string())?;

    let html_file_url = format!("file:///{}", html.to_string_lossy().replace('\\', "/"));
    let pdf_path_str = pdf.to_string_lossy().to_string();

    // 使用 Edge headless 模式打印到 PDF
    let print_to_pdf_arg = format!("--print-to-pdf={}", pdf_path_str);
    let output = Command::new(&edge_path)
        .args([
            "--headless",
            "--disable-gpu",
            "--no-sandbox",
            "--virtual-time-budget=5000",
            &print_to_pdf_arg,
            "--print-to-pdf-no-header",
            &html_file_url,
        ])
        .output()
        .map_err(|e| format!("执行 Edge 命令失败: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Edge PDF 导出失败: {}", stderr));
    }

    // 验证 PDF 文件已生成
    if !pdf.exists() {
        return Err("PDF 文件未生成，请检查 Edge 是否正常运行".to_string());
    }

    Ok(())
}

/// 将 HTML 内容保存为临时文件并导出为 PDF
#[tauri::command]
pub async fn export_html_to_pdf(html_content: String, pdf_path: String) -> Result<(), String> {
    let pdf = PathBuf::from(&pdf_path);

    // 确保输出目录存在
    if let Some(parent) = pdf.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建输出目录 \"{}\": {}", parent.display(), e))?;
    }

    // 创建临时 HTML 文件
    let temp_dir = std::env::temp_dir().join("lightmd-export");
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("无法创建临时目录: {}", e))?;

    let temp_html = temp_dir.join("export_temp.html");
    std::fs::write(&temp_html, &html_content)
        .map_err(|e| format!("写入临时 HTML 文件失败: {}", e))?;

    // 调用 export_pdf
    export_pdf(
        temp_html.to_string_lossy().to_string(),
        pdf_path,
    )
    .await?;

    // 清理临时文件
    let _ = std::fs::remove_file(&temp_html);

    Ok(())
}

/// 查找 Windows Edge 可执行文件路径
fn find_edge_path() -> Option<String> {
    // 常见 Edge 安装路径
    let candidates = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files (x86)\Microsoft\Edge Dev\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge Dev\Application\msedge.exe",
    ];

    for path in &candidates {
        if std::path::Path::new(path).exists() {
            return Some(path.to_string());
        }
    }

    // 尝试通过 where 命令查找
    if let Ok(output) = Command::new("where").arg("msedge").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout);
            let first_line = path.lines().next().unwrap_or("").trim();
            if !first_line.is_empty() && std::path::Path::new(first_line).exists() {
                return Some(first_line.to_string());
            }
        }
    }

    // 尝试 Chrome（如果 Edge 不可用）
    let chrome_candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ];

    for path in &chrome_candidates {
        if std::path::Path::new(path).exists() {
            return Some(path.to_string());
        }
    }

    None
}
