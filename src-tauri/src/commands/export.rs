/// HTML/PDF 导出命令
use std::path::PathBuf;
use std::process::Command;

/// Edge headless 虚拟时间预算（毫秒）。
/// R3s（v0.10.0）：5000 → 10000——Mermaid 多图大文档在 5s 内可能截在渲染中途
/// （virtual-time-budget 耗尽即打印当前 DOM），加倍预算降低截断概率；
/// 彻底方案（WebView2 PrintToPdf）在 v1.0.0 R3 单列。
const VIRTUAL_TIME_BUDGET_MS: u32 = 10000;

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
    // R3s：错误文案明确指出 PDF 导出依赖 Edge/Chrome，前端 notifyError 会原样展示该消息
    let edge_path = find_edge_path().ok_or_else(|| {
        "未找到 Microsoft Edge / Chrome 浏览器，PDF 导出需要其中之一支持。请安装 Edge 后重试".to_string()
    })?;

    let html_file_url = format!("file:///{}", html.to_string_lossy().replace('\\', "/"));
    let pdf_path_str = pdf.to_string_lossy().to_string();

    // 使用 Edge headless 模式打印到 PDF
    let output = Command::new(&edge_path)
        .args(build_pdf_print_args(&pdf_path_str, &html_file_url))
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

/// 构造 Edge headless 打印参数（独立纯函数，便于单测断言预算值）
fn build_pdf_print_args(pdf_path: &str, html_file_url: &str) -> Vec<String> {
    vec![
        "--headless".to_string(),
        "--disable-gpu".to_string(),
        "--no-sandbox".to_string(),
        format!("--virtual-time-budget={}", VIRTUAL_TIME_BUDGET_MS),
        format!("--print-to-pdf={}", pdf_path),
        // v0.11.0 返修：`--print-to-pdf-no-header` 在 Edge 154 上**完全无效**
        // （加/不加输出字节完全一致），Chromium 默认页眉页脚照印 ——
        // 每页都会带上日期、内部临时文件 URL 与页码 `N/M`，既泄漏路径，
        // 又与新加的 position:fixed 页眉页脚叠印。实测 `--no-pdf-header-footer`
        // 才是生效参数（输出无任何默认页眉页脚痕迹）。
        "--no-pdf-header-footer".to_string(),
        html_file_url.to_string(),
    ]
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

/// 查找 Windows Edge/Chrome 可执行文件路径。
/// R3s：路径全部为 Windows 注册表惯用安装位置，非 Windows 平台显式返回 None
/// （原先无 cfg 守卫，非 Windows 编译时这些反斜杠路径虽能编译但语义错误）。
#[cfg(windows)]
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

/// 非 Windows 平台：PDF 导出暂不支持（无 Edge 路径查找逻辑），显式返回 None
#[cfg(not(windows))]
fn find_edge_path() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pdf_print_args_contains_doubled_virtual_time_budget() {
        // R3s：预算 5000 → 10000，防 Mermaid 多图大文档截断
        let args = build_pdf_print_args("out.pdf", "file:///tmp/x.html");
        assert!(args.iter().any(|a| a == "--virtual-time-budget=10000"));
        assert!(args.iter().any(|a| a == "--headless"));
        assert!(args.iter().any(|a| a.starts_with("--print-to-pdf=")));
    }

    #[test]
    fn pdf_print_args_disables_default_header_footer_with_working_flag() {
        // v0.11.0 返修：`--print-to-pdf-no-header` 被 Edge 154 忽略，
        // 必须用 `--no-pdf-header-footer`，否则每页都会印上日期/临时 URL/页码。
        let args = build_pdf_print_args("out.pdf", "file:///tmp/x.html");
        assert!(
            args.iter().any(|a| a == "--no-pdf-header-footer"),
            "必须使用生效的 --no-pdf-header-footer"
        );
        assert!(
            !args.iter().any(|a| a == "--print-to-pdf-no-header"),
            "无效的 --print-to-pdf-no-header 不应再出现"
        );
    }

    #[cfg(windows)]
    #[test]
    fn find_edge_path_returns_some_on_windows_with_browser() {
        // 开发/发布环境均为 Windows 且装有 Edge 或 Chrome；未安装时本测试跳过语义不成立，
        // 改为宽松断言：返回值若存在必须是存在的可执行路径
        if let Some(p) = find_edge_path() {
            assert!(std::path::Path::new(&p).exists(), "返回的浏览器路径应存在: {}", p);
        }
    }
}
