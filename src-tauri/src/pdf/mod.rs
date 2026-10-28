//! v0.15.0 C2：Windows 导出 PDF —— 用 Tauri 托管的 WebView2 `PrintToPdf` 取代
//! Edge/Chrome headless 子进程。
//!
//! ## 为什么需要本模块
//!
//! v0.10.0 ~ v0.14.0 的 PDF 导出走 `msedge --headless --print-to-pdf`：
//! - 依赖用户机器上装有 Edge/Chrome（`find_edge_path`），且**外部进程崩溃/卡住
//!   无法从 Rust 侧观测**；
//! - 临时 HTML 页面在独立浏览器进程里加载，Mermaid/KaTeX 渲染完成时机只能靠
//!   `--virtual-time-budget` 猜（v0.10.0 因此把预算从 5s 加到 10s），
//!   大文档仍可能被截在渲染中途；
//! - 默认页眉页脚要靠 `--no-pdf-header-footer` 打补丁（v0.11.0 返修）。
//!
//! 改为**进程内**打印后：渲染完成时机由页面内脚本显式上报（真实判据，不靠 sleep），
//! 打印设置由 `COREWEBVIEW2_PRINT_SETTINGS` 精确控制，失败按层给出错误码。
//!
//! ## 实现路径选择：隐藏 `WebviewWindow` + `with_webview`（而非复用主窗口）
//!
//! 两条路都试过/评估过：
//!
//! | 方案 | 结论 |
//! | --- | --- |
//! | 主编辑 WebView 上 `with_webview` + `Navigate` 到临时 HTML | ❌ 会把主窗口导航走，编辑器状态（未保存内容、撤销栈、滚动位置）全部丢失；`PrintToPdf` 打印的是编辑器 UI 而不是文档 |
//! | 独立 `ICoreWebView2Environment` + 自己建 Controller | ❌ 需要自建 HWND、消息泵与 COM 初始化，与 Tauri 的事件循环重复；wry/Tauri 已托管好环境，自建等于抄一遍 |
//! | **临时隐藏 `WebviewWindow`（`visible(false)`+`skip_taskbar`）+ 其上 `with_webview` 取 `ICoreWebView2Controller`** | ✅ 复用 Tauri 已托管的 WebView2 环境（系统依赖不变）；窗口独立、不可见、不占任务栏、不进窗口管理与会话恢复；导出后 `destroy()` 释放；与主编辑 WebView 完全隔离，并发导出各持一个窗口互不干扰 |
//!
//! 因此本模块的 Windows 实现在 [`windows`] 里，走「隐藏窗口 + `with_webview`」：
//! `with_webview` 只用来拿 `ICoreWebView2Controller`/`ICoreWebView2Environment`
//! 这两个 COM 句柄（与 `window::disable_browser_accelerator_keys` 同一写法）。
//!
//! ## 就绪判据（缺一不可）
//!
//! 1. `NavigationCompleted` 且 `IsSuccess` —— 页面加载本身成功；
//! 2. 页面内注入脚本（`document_start` 执行）等待：
//!    - `document.fonts.ready`（字体到位，中文/等宽字体不跳行）；
//!    - 所有 `<img>` 的 `complete`/`decode()` 完成（坏图 `error` 也算「已确定」，
//!      不让一张 404 图把整次导出拖到超时）；
//!    - Mermaid 每个 `.mermaid` 已渲染出 `<svg>`、KaTeX 每个 `[data-math]` 已渲染出
//!      `.katex`（连续 2 个 rAF 帧都成立才算稳，避免 Mermaid 先画半截再补全）；
//! 3. 上述条件全部满足后脚本置 `window.__LMD_PDF_READY = true` 并
//!    `window.chrome.webview.postMessage("LMD_PDF_READY")` 作为**就绪上报**。
//!
//! Rust 侧只认 ②③ 上报 + ① 成功：**没有任何 sleep 等待**；上报迟迟不到 →
//! `PDF_TIMEOUT|`。第 ③ 步若页面自己已置位（前端 HTML 内嵌脚本），注入脚本直接跳过。
//!
//! ## 错误分层（前端 `notifyError` 原样展示）
//!
//! - `PDF_NAV|` 导航失败 / 页面加载成功但未出就绪信号的前置失败
//! - `PDF_RENDER|` 打印完成但 `success=false`、输出非 PDF、0 字节
//! - `PDF_IO|` 临时目录/输出路径不可写、读文件失败
//! - `PDF_TIMEOUT|` 等待就绪或等待打印完成超时（默认各 30s）
//! - `PDF_UNSUPPORTED|` 非 Windows，或 WebView2 Runtime 过旧缺 `PrintToPdf`（< 1.0.1210）
//!
//! ## 临时目录与并发
//!
//! 每次导出独立 `<tmp>/lightmd-pdf-<唯一 id>/index.html`；[`ExportTempDir`] 的 `Drop`
//! 负责在成功/失败/超时/`?` 提前返回等**所有退出路径**清掉目录。窗口 label 也带
//! 同一唯一 id，故并发导出的窗口、目录、通道互不覆盖。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub mod settings;
pub use settings::{mm_to_inch, parse_page_setup, PdfPaper, PdfPrintOptions};

#[cfg(windows)]
mod windows;
#[cfg(not(windows))]
mod windows {
    //! 非 Windows 平台：占位模块，保持 [`print_to_pdf`] 签名一致（架构无关代码照常编译）。
    //! 真正的实现在 [`super::print_to_pdf`] 的 `cfg(not(windows))` 分支里。
}

pub const ERR_PDF_NAV: &str = "PDF_NAV";
pub const ERR_PDF_RENDER: &str = "PDF_RENDER";
pub const ERR_PDF_IO: &str = "PDF_IO";
pub const ERR_PDF_TIMEOUT: &str = "PDF_TIMEOUT";
pub const ERR_PDF_UNSUPPORTED: &str = "PDF_UNSUPPORTED";

/// 等待「页面就绪」的默认超时（毫秒）
pub const READY_TIMEOUT_MS: u64 = 30_000;
/// 等待 `PrintToPdf` 完成回调的默认超时（毫秒）
pub const PRINT_TIMEOUT_MS: u64 = 30_000;

/// 导出结果（供前端日志/验收断言；命令本身仍返回 `Result<(), String>` 以保持前端契约）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PdfPrintReport {
    /// 输出 PDF 字节数（已校验 > 0 且以 `%PDF-` 开头）
    pub bytes: u64,
    /// PDF 页数**估算**（扫描 `/Type /Page` 对象；流式压缩时可能缺失，仅作诊断）
    pub pages_hint: Option<u64>,
}

/// PDF 导出辅助窗口的 label 前缀。
///
/// 这类窗口是**瞬时**的打印靶子：离屏、不占任务栏、不进窗口管理器，
/// 也不应被 `tauri-plugin-window-state` 记录几何，更不应出现在会话恢复里。
pub const AUX_LABEL_PREFIX: &str = "pdf-";

/// 是否为 PDF 导出辅助窗口的 label
pub fn is_aux_label(label: &str) -> bool {
    label.starts_with(AUX_LABEL_PREFIX)
}

/// 生成本次导出的辅助窗口 label（唯一，保证并发导出互不覆盖）
pub fn aux_window_label() -> String {
    format!("{}{}", AUX_LABEL_PREFIX, unique_export_id())
}

/// 打印到 PDF 的统一入口。
///
/// `app` 由 Tauri 自动注入（前端 `invoke("export_html_to_pdf", { htmlContent, pdfPath })`
/// **不需要**传，签名对前端保持不变）。
pub async fn print_to_pdf(
    app: &tauri::AppHandle,
    html: String,
    pdf_path: String,
) -> Result<PdfPrintReport, String> {
    #[cfg(windows)]
    {
        windows::print_to_pdf_windows(app, html, pdf_path).await
    }
    #[cfg(not(windows))]
    {
        let _ = (app, html, pdf_path);
        Err(format!(
            "{}|当前平台不是 Windows，PDF 导出依赖 WebView2 打印能力",
            ERR_PDF_UNSUPPORTED
        ))
    }
}

/// 把本地路径转成 `file://` URL（供隐藏 WebView 导航）。
///
/// 用 `url` 的 `from_file_path` 而不是手工拼 `file:///` + 反斜杠替换：
/// 后者不做百分号编码，中文/空格目录会导航失败（v0.14.0 之前主路径的隐患）。
pub fn file_url(path: &Path) -> Option<String> {
    tauri::Url::from_file_path(path).ok().map(|u| u.to_string())
}

/// 生成一次导出用的唯一 id（进程内单调 + 纳秒 + 原子计数）。
///
/// 刻意不引入 `uuid` 依赖：唯一性只需在当前进程内保证（并发导出、同一毫秒连发），
/// 而 `<pid>-<nanos>-<counter>` 已足够，且无新增 Cargo 依赖/锁文件变更。
pub fn unique_export_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    format!("{}-{}-{}", std::process::id(), nanos, seq)
}

/// 一次导出的**唯一临时目录**，`Drop` 时整目录删除。
///
/// 覆盖所有退出路径：正常完成、打印失败、导航失败、超时、以及 `?` 提前返回
/// （`Drop` 在栈展开前必然执行）。`remove_dir_all` 失败只记日志——
/// `%TEMP%` 会被 Windows 磁盘清理兜底，绝不让清理失败冒泡成导出失败。
pub struct ExportTempDir {
    path: PathBuf,
}

impl ExportTempDir {
    /// 创建 `<tmp>/lightmd-pdf-<id>/`
    pub fn create() -> Result<Self, String> {
        let path = std::env::temp_dir().join(format!("lightmd-pdf-{}", unique_export_id()));
        std::fs::create_dir_all(&path).map_err(|e| {
            format!(
                "{}|无法创建 PDF 导出临时目录 \"{}\": {}",
                ERR_PDF_IO,
                path.display(),
                e
            )
        })?;
        Ok(Self { path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 写入待打印的自包含 HTML，返回文件路径
    pub fn write_index_html(&self, html: &str) -> Result<PathBuf, String> {
        let file = self.path.join("index.html");
        std::fs::write(&file, html).map_err(|e| {
            format!(
                "{}|写入 PDF 导出临时 HTML 失败 \"{}\": {}",
                ERR_PDF_IO,
                file.display(),
                e
            )
        })?;
        Ok(file)
    }
}

impl Drop for ExportTempDir {
    fn drop(&mut self) {
        if let Err(e) = std::fs::remove_dir_all(&self.path) {
            // 目录可能已被外部清理；仅诊断输出，不影响导出结果
            eprintln!(
                "[LightMD] 清理 PDF 导出临时目录失败 {}: {}",
                self.path.display(),
                e
            );
        }
    }
}

/// 校验输出 PDF：必须存在、非空、以 `%PDF-` 开头；返回字节数与页数估算
pub fn validate_pdf_output(pdf_path: &Path) -> Result<PdfPrintReport, String> {
    let bytes = std::fs::read(pdf_path).map_err(|e| {
        format!(
            "{}|读取导出的 PDF 失败 \"{}\": {}",
            ERR_PDF_IO,
            pdf_path.display(),
            e
        )
    })?;
    if bytes.is_empty() {
        return Err(format!(
            "{}|导出的 PDF 为空文件：{}",
            ERR_PDF_RENDER,
            pdf_path.display()
        ));
    }
    if !bytes.starts_with(b"%PDF-") {
        return Err(format!(
            "{}|输出文件不是有效 PDF（缺少 %PDF- 头）：{}",
            ERR_PDF_RENDER,
            pdf_path.display()
        ));
    }
    Ok(PdfPrintReport {
        bytes: bytes.len() as u64,
        pages_hint: pdf_page_hint(&bytes),
    })
}

/// 页数估算：扫描未压缩的 `/Type /Page` 对象（`/Type /Pages` 不计）。
///
/// Chromium/WebView2 输出的页对象字典通常未压缩，因此对真实产物可用；
/// 但 PDF 允许对象流压缩，所以这里只作为**诊断提示**，不参与成功判定。
pub fn pdf_page_hint(bytes: &[u8]) -> Option<u64> {
    const NEEDLE: &[u8] = b"/Type /Page";
    let mut count = 0u64;
    let mut from = 0usize;
    while from + NEEDLE.len() <= bytes.len() {
        let Some(rel) = find_bytes(&bytes[from..], NEEDLE) else {
            break;
        };
        let at = from + rel;
        let after = at + NEEDLE.len();
        // `/Type /Pages` 是页面树节点，不是页
        if bytes.get(after) != Some(&b's') {
            count += 1;
        }
        from = after;
    }
    (count > 0).then_some(count)
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// 把临时产物 PDF 搬到用户选择的路径。
///
/// 为什么需要重试：`PrintToPdf` 的完成回调触发时，WebView2 的打印管线
/// 可能还短暂持有文件句柄（Windows 上表现为 `ERROR_SHARING_VIOLATION`/os error 32，
/// 读也读不到、拷也拷不动）。这里退避重试 5 次（共 ~1.5s），
/// 仍失败才报 `PDF_IO`；用户看到的是明确错误而不是"文件不存在"。
pub fn copy_pdf_to_target(src: &Path, dst: &Path) -> Result<u64, String> {
    const ATTEMPTS: u32 = 5;
    let mut last_err = String::new();
    for attempt in 0..ATTEMPTS {
        match std::fs::copy(src, dst) {
            Ok(bytes) => return Ok(bytes),
            Err(e) => {
                last_err = e.to_string();
                if attempt + 1 < ATTEMPTS {
                    std::thread::sleep(std::time::Duration::from_millis(50 * (attempt as u64 + 1)));
                }
            }
        }
    }
    Err(format!(
        "{}|把导出的 PDF 写入目标路径失败 \"{}\"（来源 \"{}\"，重试 {} 次仍失败）: {}",
        ERR_PDF_IO,
        dst.display(),
        src.display(),
        ATTEMPTS,
        last_err
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unique_ids_differ_even_when_issued_in_a_tight_loop() {
        // 并发导出互不干扰的前提：同一时刻连发也必须拿到不同 id
        let a = unique_export_id();
        let b = unique_export_id();
        assert_ne!(a, b);
        assert!(a.split('-').count() >= 3, "id 形态应为 pid-nanos-seq: {}", a);
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    }

    #[test]
    fn file_url_percent_encodes_non_ascii_and_spaces() {
        let p = PathBuf::from(r"D:\AI\markdown view\临时 目录\index.html");
        let url = file_url(&p).expect("Windows/Unix 绝对路径都应可转换");
        assert!(url.starts_with("file:///"), "{}", url);
        // 中文与空格必须被百分号编码，否则 WebView 导航失败
        assert!(!url.contains(' '), "{}", url);
        assert!(!url.contains('临'), "{}", url);
        assert!(url.contains("%20") || url.contains("%E4"), "{}", url);
    }

    #[test]
    fn temp_dir_is_unique_and_written_under_system_tmp() {
        let a = ExportTempDir::create().expect("创建临时目录");
        let b = ExportTempDir::create().expect("创建临时目录");
        assert_ne!(a.path(), b.path());
        assert!(a.path().starts_with(std::env::temp_dir()));
        assert!(a
            .path()
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .starts_with("lightmd-pdf-"));
        let html = a.write_index_html("<html>ok</html>").expect("写入 HTML");
        assert_eq!(std::fs::read_to_string(html).unwrap(), "<html>ok</html>");
        let a_path = a.path().to_path_buf();
        drop(a);
        drop(b);
        assert!(!a_path.exists(), "Drop 必须清理临时目录");
    }

    #[test]
    fn validate_rejects_empty_missing_and_non_pdf() {
        let dir = ExportTempDir::create().unwrap();
        let empty = dir.path().join("empty.pdf");
        std::fs::write(&empty, b"").unwrap();
        let err = validate_pdf_output(&empty).unwrap_err();
        assert!(err.starts_with(ERR_PDF_RENDER), "{}", err);

        let junk = dir.path().join("junk.pdf");
        std::fs::write(&junk, b"<html>not a pdf</html>").unwrap();
        let err = validate_pdf_output(&junk).unwrap_err();
        assert!(err.starts_with(ERR_PDF_RENDER), "{}", err);

        let missing = dir.path().join("missing.pdf");
        let err = validate_pdf_output(&missing).unwrap_err();
        assert!(err.starts_with(ERR_PDF_IO), "{}", err);
    }

    #[test]
    fn validate_accepts_header_and_reports_bytes_and_pages() {
        let dir = ExportTempDir::create().unwrap();
        let ok = dir.path().join("ok.pdf");
        let body = b"%PDF-1.7\n1 0 obj << /Type /Pages /Count 2 >>\n\
2 0 obj << /Type /Page /Parent 1 0 R >>\n\
3 0 obj << /Type /Page /Parent 1 0 R >>\n%%EOF\n";
        std::fs::write(&ok, body).unwrap();
        let report = validate_pdf_output(&ok).unwrap();
        assert_eq!(report.bytes, body.len() as u64);
        assert_eq!(report.pages_hint, Some(2));
    }

    #[test]
    fn page_hint_none_for_stream_without_page_objects() {
        assert_eq!(pdf_page_hint(b"%PDF-1.7\n%%EOF"), None);
    }

    #[test]
    fn copies_staged_pdf_to_target_and_reports_bytes() {
        let dir = ExportTempDir::create().unwrap();
        let src = dir.path().join("out.pdf");
        let body = b"%PDF-1.7\n%%EOF\n";
        std::fs::write(&src, body).unwrap();
        let dst = dir.path().join("用户选择 的.pdf");
        let n = copy_pdf_to_target(&src, &dst).unwrap();
        assert_eq!(n, body.len() as u64);
        assert_eq!(std::fs::read(&dst).unwrap(), body);
    }

    #[test]
    fn copy_failure_is_pdf_io_layered() {
        let dir = ExportTempDir::create().unwrap();
        let missing = dir.path().join("不存在.pdf");
        let dst = dir.path().join("out.pdf");
        let err = copy_pdf_to_target(&missing, &dst).unwrap_err();
        assert!(err.starts_with(ERR_PDF_IO), "{}", err);
        assert!(err.contains("重试"), "错误里应说明重试过: {}", err);
    }

    #[test]
    fn aux_window_labels_are_unique_and_recognizable() {
        let a = aux_window_label();
        let b = aux_window_label();
        assert_ne!(a, b);
        assert!(is_aux_label(&a), "{}", a);
        assert!(is_aux_label(&b), "{}", b);
        // 必须与真实窗口 label 空间区分开：main / sec-N 都不能被误判
        for real in ["main", "sec-1", "sec-7"] {
            assert!(!is_aux_label(real), "{} 不应被判为 PDF 辅助窗口", real);
        }
    }

    #[test]
    fn error_codes_are_machine_readable_prefixes() {
        for code in [
            ERR_PDF_NAV,
            ERR_PDF_RENDER,
            ERR_PDF_IO,
            ERR_PDF_TIMEOUT,
            ERR_PDF_UNSUPPORTED,
        ] {
            assert!(code.starts_with("PDF_"));
            assert!(!code.contains('|'), "前缀本身不应含分隔符");
        }
    }
}
