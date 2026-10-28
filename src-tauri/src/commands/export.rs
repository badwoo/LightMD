//! HTML / PDF 导出命令
//!
//! v0.15.0 C2：PDF 导出不再启动 Edge/Chrome headless 子进程，改为在 Tauri 托管的
//! WebView2 内 `PrintToPdf`（实现见 [`crate::pdf`]）。
//!
//! 前端契约**未变**：`invoke("export_html_to_pdf", { htmlContent, pdfPath })`，
//! `PdfExportOptions` 的语义（纸张/边距/固定页眉页脚）也仍由前端写进
//! 导出 HTML 的 `@page` CSS，Rust 侧从 HTML 解析后映射到打印设置。
//!
//! 已移除（保留说明，防止有人按 git 历史原样恢复）：
//! - `find_edge_path`：探测 `msedge.exe` / `chrome.exe` 安装路径；
//! - `build_pdf_print_args`：拼 `--headless --print-to-pdf` 等参数（含
//!   v0.10.0 的 `--virtual-time-budget=10000`、v0.11.0 返修的 `--no-pdf-header-footer`）；
//! - `std::process::Command` 及其 `where msedge` 探测。
//!
//! 这些之所以整体删除而不是"保留为回退"：外部进程的渲染完成时机只能靠虚拟时间
//! 预算猜，默认页眉页脚也只能靠参数打补丁；保留一条不可观测的回退路径只会让两类
//! 失败混在一起。现在失败按 `PDF_NAV| / PDF_RENDER| / PDF_IO| / PDF_TIMEOUT| / PDF_UNSUPPORTED|`
//! 分层返回，前端 `notifyError` 原样展示。

/// 将 HTML 内容保存到**本次导出独占的**临时目录并打印为 PDF。
///
/// `app` 由 Tauri 自动注入，前端调用签名不变。
#[tauri::command]
pub async fn export_html_to_pdf(
    app: tauri::AppHandle,
    html_content: String,
    pdf_path: String,
) -> Result<(), String> {
    // 临时目录创建/写入/清理全部由 pdf 模块负责（唯一目录 + Drop 清理），
    // 此处不再自己拼 `%TEMP%/lightmd-export`（旧实现用固定文件名，并发导出互相覆盖）。
    crate::pdf::print_to_pdf(&app, html_content, pdf_path)
        .await
        .map(|_| ())
}

/// 将已存在的 HTML 文件打印为 PDF（保留命令，内部同样走 WebView2）。
///
/// 与 [`export_html_to_pdf`] 的差别仅在输入是文件路径；此命令未被前端使用，
/// 但属既有公开命令，保留以免破坏外部调用方。
#[tauri::command]
pub async fn export_pdf(
    app: tauri::AppHandle,
    html_path: String,
    pdf_path: String,
) -> Result<(), String> {
    let html = std::path::PathBuf::from(&html_path);
    if !html.is_file() {
        return Err(format!(
            "{}|HTML 文件不存在: {}",
            crate::pdf::ERR_PDF_IO,
            html.display()
        ));
    }
    let content = std::fs::read_to_string(&html).map_err(|e| {
        format!(
            "{}|读取 HTML 文件失败 \"{}\": {}",
            crate::pdf::ERR_PDF_IO,
            html.display(),
            e
        )
    })?;
    crate::pdf::print_to_pdf(&app, content, pdf_path)
        .await
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    //! 旧测试（`pdf_print_args_contains_doubled_virtual_time_budget`、
    //! `pdf_print_args_disables_default_header_footer_with_working_flag`、
    //! `find_edge_path_returns_some_on_windows_with_browser`）断言的是已删除的
    //! Edge 参数与浏览器路径探测，随主路径一并删除。
    //!
    //! 新的纯函数断言在 `crate::pdf` 与 `crate::pdf::settings` 的测试模块里：
    //! 纸张/边距解析、mm→inch、唯一临时目录与清理、PDF 产物校验、错误码前缀。

    #[test]
    fn export_commands_keep_frontend_contract() {
        // 契约：前端只传 htmlContent + pdfPath；`app` 由 Tauri 注入。
        // 源码级断言，防止改签名时没同步前端
        // （前端调用点在 src/components/dialogs/ExportDialog.tsx 的 export_html_to_pdf）。
        let src = include_str!("export.rs");
        assert!(src.contains("html_content: String"));
        assert!(src.contains("pdf_path: String"));
    }

    #[test]
    fn edge_headless_main_path_is_gone() {
        // 只断言**代码形态**（定义/调用），不断言文档注释里「已移除」的说明文字
        let src = include_str!("export.rs");
        let edge_finder_def = ["fn find_edge", "_path"].concat();
        let arg_builder_def = ["fn build_pdf", "_print_args"].concat();
        let process_import = ["use std::process", "::Command"].concat();
        let process_spawn = ["Command", "::new("].concat();
        let budget = ["VIRTUAL_TIME", "_BUDGET"].concat();
        assert!(!src.contains(&edge_finder_def), "Edge 路径探测必须已移除");
        assert!(!src.contains(&arg_builder_def), "Edge 打印参数构造必须已移除");
        assert!(!src.contains(&process_import), "不应导入外部进程 API");
        assert!(!src.contains(&process_spawn), "PDF 导出不应再启动外部进程");
        assert!(!src.contains(&budget), "虚拟时间预算已随外部进程路径删除");
    }
}
