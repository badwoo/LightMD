//! Windows 实现：离屏 `WebviewWindow` + `with_webview` 取 `ICoreWebView2`，
//! 用 `ICoreWebView2_7::PrintToPdf` 在进程内打印。
//!
//! ## 线程模型
//!
//! 所有 WebView2 COM 调用都在 **UI 线程**上发生：`with_webview` 闭包由 Tauri 派发到
//! 事件循环线程，WebView2 的事件回调也由它 PostMessage 回同一线程。因此本模块不存在
//! 跨线程 COM 调用；[`SendCom`] 只是为满足 Rust 的 `Send` 约束（COM 句柄要放进
//! `Arc<Mutex<..>>` 交给后续 `with_webview` 闭包），不代表真的跨线程共享。
//!
//! 等待用 `std::sync::mpsc` 的带超时接收；整个流程跑在 Tauri 的 async 命令里，
//! `recv_timeout` 只在短间隔内阻塞，不会卡死 tokio worker。
//!
//! ## 就绪信号为什么用「Rust 侧轮询 `eval_with_callback`」而不是 `postMessage`
//!
//! 这是 pdf_smoke 真机跑出来的硬约束。`wry` 给**每个** webview 都装了它自己的
//! `WebMessageReceived` 处理器（用于 Tauri IPC），其中这一步
//! （wry-0.55.1 `src/webview2/mod.rs:910`）：
//!
//! ```ignore
//! let url = { let mut url = PWSTR::null(); args.Source(&mut url)?; take_pwstr(url) };
//! ipc_handler(Request::builder().uri(url).body(js).unwrap());   // <- unwrap
//! ```
//!
//! `file:///D:/...` 不是合法 `http::Uri`，`.uri(url)` 返回 `InvalidUri`，而那里
//! `unwrap()` 且位于 `extern "system"` 回调边界 → **不可 unwind → 进程 abort**。
//! 换句话说：导出页只要用 `chrome.webview.postMessage(...)` 上报就绪，
//! 用户一导出 PDF 应用就会崩。
//!
//! 所以本模块**完全不发 web message**：Rust 侧定时 `eval_with_callback` 求值一个
//! **返回 JSON 字符串**的探测表达式（[`READY_PROBE_JS`]），回调解析结果决定
//! "继续等 / 开始打印"。既绕开 wry 的 IPC 处理器，也不依赖页面主动喊话。

use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use webview2_com::{
    NavigationCompletedEventHandler, NewWindowRequestedEventHandler, PrintToPdfCompletedHandler,
};
use windows_core::{Interface, HSTRING};

use super::settings::{parse_page_setup, PdfPrintOptions};
use super::{
    file_url, validate_pdf_output, ExportTempDir, PdfPrintReport, ERR_PDF_IO, ERR_PDF_NAV,
    ERR_PDF_RENDER, ERR_PDF_TIMEOUT, ERR_PDF_UNSUPPORTED, PRINT_TIMEOUT_MS, READY_TIMEOUT_MS,
};

/// 离屏窗口的视口尺寸：只影响布局视口，不影响打印（打印走 `@page`/PrintSettings）。
/// 取 1024x768 让"视口相关"的 CSS（max-width、栅格）与桌面版接近。
const OFFSCREEN_W: f64 = 1024.0;
const OFFSCREEN_H: f64 = 768.0;
/// 离屏窗口的"站位"：放到虚拟桌面之外，用户永远看不到，但 Chromium 认为页面可见
/// （避免不可见窗口被节流 rAF/定时器；部分 Runtime 上隐藏 WebView 的 PrintToPdf
/// 会打空白页）。
const OFFSCREEN_X: f64 = -32_000.0;
const OFFSCREEN_Y: f64 = -32_000.0;

/// 轮询就绪的间隔（ms）
const READY_POLL_MS: u64 = 100;

// ------------------------- 就绪探测表达式 -------------------------

/// 就绪探测表达式：**返回**一个 JSON 字符串（不发 web message，理由见模块文档）。
///
/// 判据（全部满足 → `ready: true`）：
/// 1. `document.readyState === "complete"`；
/// 2. 字体就绪（`document.fonts.ready` 已 resolve，或 `status === "loaded"`）；
/// 3. 所有 `<img>` 已 decode（坏图 `complete` 视为"已确定"；10s 后仍未完成的图
///    记为告警并放行，不让一张图拖死整次导出）；
/// 4. 若存在 `.mermaid` 且 mermaid 已加载：每个节点都已渲染出 `<svg>`
///    （mermaid 根本没加载成功则告警放行，不干等）；
/// 5. 若存在 `[data-math]` 且 KaTeX 已加载：每个占位元素已有渲染子节点；
/// 6. 以上条件需在**连续 2 次探测**成立（Mermaid 可能先画半截再补全）；
/// 7. 硬上限 25s（< Rust 侧 30s 超时）到点立即带告警放行 —— 用户至少拿到一份
///    接近完整的 PDF，而不是 30s 后整体失败。
///
/// 兼容前端自带的 `window.__LMD_PDF_READY === true`（设计稿 §1.3 的内嵌脚本方案）：
/// 页面自己已声明就绪时跳过 4/5 的内容判据，只等 readyState 与字体。
///
/// 注意：必须是**单个表达式**（IIFE 包起来并 `return`）：ExecuteScript 取最后表达式的值，
/// 该值会再序列化成 JSON 字符串交给回调。
const READY_PROBE_JS: &str = r#"(function () {
  try {
    if (location.protocol !== 'file:') { return JSON.stringify({ ready: false, notFile: true }); }
    var st = window.__LMD_PDF_PROBE__;
    if (!st) { st = window.__LMD_PDF_PROBE__ = { t0: Date.now(), stable: 0, warnedImg: false }; }
    var HARD_MS = 25000;
    var IMG_TIMEOUT_MS = 10000;
    var warnings = [];
    var elapsed = Date.now() - st.t0;
    var hard = elapsed > HARD_MS;

    var complete = document.readyState === 'complete';

    var fontsOk = window.__LMD_FONTS_READY__ === true;
    if (!fontsOk) {
      try {
        if (!document.fonts) { fontsOk = true; }
        else {
          fontsOk = document.fonts.status === 'loaded';
          if (document.fonts.ready && !document.fonts.__lmdHooked) {
            document.fonts.__lmdHooked = true;
            document.fonts.ready.then(function () {
              window.__LMD_FONTS_READY__ = true;
            }).catch(function () { window.__LMD_FONTS_READY__ = true; });
          }
        }
      } catch (e) { fontsOk = true; }
    }

    var imgOk = true;
    var pendingImgs = 0;
    var imgs = document.images || [];
    for (var i = 0; i < imgs.length; i++) { if (!imgs[i].complete) { pendingImgs++; } }
    if (pendingImgs > 0) {
      if (elapsed > IMG_TIMEOUT_MS) {
        if (!st.warnedImg) {
          st.warnedImg = true;
          warnings.push('仍有 ' + pendingImgs + ' 张图片未加载完成，已按超时放行');
        }
      } else { imgOk = false; }
    }

    var preReady = window.__LMD_PDF_READY === true;
    var merOk = true;
    var ktxOk = true;
    if (!preReady) {
      var mNodes = document.querySelectorAll('.mermaid');
      if (mNodes.length) {
        if (typeof window.mermaid === 'undefined') {
          warnings.push('Mermaid 脚本未加载，图表留白');
        } else {
          var mPending = 0;
          for (var m = 0; m < mNodes.length; m++) { if (!mNodes[m].querySelector('svg')) { mPending++; } }
          if (mPending > 0) {
            merOk = false;
            if (hard) { warnings.push('Mermaid 仍有 ' + mPending + ' 个未渲染完成'); }
          }
        }
      }
      var kNodes = document.querySelectorAll('[data-math]');
      if (kNodes.length) {
        if (typeof window.katex === 'undefined') {
          warnings.push('KaTeX 脚本未加载，公式留白');
        } else {
          var kPending = 0;
          for (var k = 0; k < kNodes.length; k++) { if (!kNodes[k].childElementCount) { kPending++; } }
          if (kPending > 0) {
            ktxOk = false;
            if (hard) { warnings.push('KaTeX 仍有 ' + kPending + ' 个未渲染完成'); }
          }
        }
      }
    }

    var settled = complete && fontsOk && imgOk && merOk && ktxOk;
    st.stable = settled ? (st.stable + 1) : 0;
    var ready = (settled && st.stable >= 2) || hard;
    if (hard && !(complete && fontsOk)) { warnings.push('页面在 25s 内未完全就绪，已按超时放行'); }
    return JSON.stringify({ ready: ready, warnings: warnings, elapsedMs: elapsed });
  } catch (e) {
    return JSON.stringify({ ready: false, error: String((e && e.message) || e) });
  }
})()"#;

// ------------------------- 事件与共享状态 -------------------------

/// 一次导出会话的事件（来自 UI 线程回调 / 就绪探测回调）
#[derive(Debug)]
enum PdfEvent {
    /// 页面就绪（含告警）
    Ready { warnings: Vec<String> },
    /// 失败（消息**已带错误码前缀**，直接上抛，不重复加码）
    Failed { message: String },
    /// 打印完成
    PrintDone { success: bool, detail: String },
}

/// 让 COM 接口能进 `Arc<Mutex<..>>`（仅 UI 线程访问，见模块文档）
struct SendCom<T>(T);
// SAFETY: 值只在 WebView2 的 UI 线程上被使用；该包装器仅满足 Rust 的 `Send` 约束，
// 不构成跨线程共享。
unsafe impl<T> Send for SendCom<T> {}
unsafe impl<T> Sync for SendCom<T> {}

fn err(code: &str, message: impl AsRef<str>) -> String {
    format!("{}|{}", code, message.as_ref())
}

/// 错误规格化：内部各层已用 [`err`] 造出 `CODE|message`，不能再叠一层码
/// （否则前端按第一个 `|` 切码会拿到默认码而非真实码）。
fn with_code_default(code: &str, message: String) -> String {
    if message.contains('|') {
        message
    } else {
        err(code, message)
    }
}

/// 打印设置槽位：第一次 `with_webview` 里创建，第二次 `with_webview` 里取用
type SettingsSlot = Arc<Mutex<Option<SendCom<ICoreWebView2PrintSettings>>>>;

// ------------------------- 主流程 -------------------------

/// Windows 下的打印入口（见 [`super::print_to_pdf`]）。
pub async fn print_to_pdf_windows(
    app: &AppHandle,
    html: String,
    pdf_path: String,
) -> Result<PdfPrintReport, String> {
    // 1) 输出目录先建好（无权限在这里就报 PDF_IO，而不是打完才失败）
    let pdf = std::path::PathBuf::from(&pdf_path);
    if let Some(parent) = pdf.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| {
                err(
                    ERR_PDF_IO,
                    format!("无法创建 PDF 输出目录 \"{}\": {}", parent.display(), e),
                )
            })?;
        }
    }

    // 2) 唯一临时目录 + 自包含 HTML（Drop 时整目录清理，覆盖所有退出路径）
    let temp = ExportTempDir::create()?;
    let html_file = temp.write_index_html(&html)?;
    let file_url = file_url(&html_file).ok_or_else(|| {
        err(
            ERR_PDF_IO,
            format!("无法把临时 HTML 转成 file:// URL: {}", html_file.display()),
        )
    })?;
    let opts: PdfPrintOptions = parse_page_setup(&html);

    // 2b) 先打到临时文件、校验后再拷到用户选的路径：
    //     PrintToPdf 对"已存在"目标的行为是实现细节，失败时可能留下半截文件，
    //     先暂存能保证失败产物永远污染不到用户路径。
    let staged_pdf = temp.path().join("out.pdf");

    // 3) 离屏窗口（label 带唯一 id -> 并发导出互不覆盖）
    let label = super::aux_window_label();
    let window = build_offscreen_window(app, &label)?;

    let (tx, rx) = mpsc::channel::<PdfEvent>();
    let settings_slot: SettingsSlot = Arc::new(Mutex::new(None));

    // 4) 第一次 with_webview：建打印设置 + 挂导航事件 + 导航到临时 HTML
    let setup = {
        let w = window.clone();
        let file_url = file_url.clone();
        let tx = tx.clone();
        let slot = settings_slot.clone();
        w.with_webview(move |platform| {
            // SAFETY: 闭包由 Tauri 派发到 WebView2 的 UI 线程
            let r = unsafe { install_and_navigate(&platform, &tx, &slot, &file_url, opts) };
            if let Err(message) = r {
                let _ = tx.send(PdfEvent::Failed {
                    message: with_code_default(ERR_PDF_NAV, message),
                });
            }
        })
        .map_err(|e| err(ERR_PDF_NAV, format!("无法取得离屏 WebView 的 WebView2 句柄: {e}")))
    };

    // 5) 等就绪 -> 打印到临时路径 -> 校验 -> 拷到用户路径
    //    整段放到 spawn_blocking：mpsc::Receiver 不是 Sync，且 recv_timeout 是阻塞调用，
    //    若直接在 async 上下文里跑会既阻塞 worker 又让命令 Future 变成 !Send。
    let outcome: Result<PdfPrintReport, String> = match setup {
        Err(e) => Err(e),
        Ok(()) => {
            let window = window.clone();
            let tx = tx.clone();
            let slot = settings_slot.clone();
            let staged = staged_pdf.clone();
            let final_pdf = pdf.clone();
            match tauri::async_runtime::spawn_blocking(move || {
                drive_export(&window, &tx, &rx, &slot, &staged, &final_pdf, opts)
            })
            .await
            {
                Ok(r) => r,
                Err(e) => Err(err(ERR_PDF_NAV, format!("PDF 导出等待任务异常结束: {e}"))),
            }
        }
    };

    // 6) 窗口必须销毁（destroy 不发 CloseRequested，绕过应用关闭确认流程）
    if let Err(e) = window.destroy() {
        eprintln!("[LightMD] 销毁 PDF 导出离屏窗口失败 {}: {}", label, e);
    }

    // 7) 临时目录由 ExportTempDir::Drop 清理
    outcome
}

/// 第 5 步：轮询就绪 -> 触发打印 -> 等完成 -> 校验并搬运产物。
///
/// **同步**函数：整体在 `spawn_blocking` 里跑。`mpsc::Receiver` 不是 `Sync`，
/// 若是 async fn 里借用它，命令返回的 Future 会 `!Send`（Tauri 要求 Send）。
fn drive_export(
    window: &WebviewWindow,
    tx: &mpsc::Sender<PdfEvent>,
    rx: &mpsc::Receiver<PdfEvent>,
    settings_slot: &SettingsSlot,
    staged_pdf: &std::path::Path,
    final_pdf: &std::path::Path,
    opts: PdfPrintOptions,
) -> Result<PdfPrintReport, String> {
    // 5a) 轮询就绪（每次探测结果经同一通道回来，不 sleep 盲等）
    let deadline = std::time::Instant::now() + Duration::from_millis(READY_TIMEOUT_MS);
    let ready_warnings: Vec<String> = loop {
        // 先看通道里有没有已到达的失败/就绪
        match rx.try_recv() {
            Ok(PdfEvent::Failed { message }) => return Err(message),
            Ok(PdfEvent::Ready { warnings }) => break warnings,
            Ok(PdfEvent::PrintDone { .. }) => {
                return Err(err(ERR_PDF_RENDER, "打印在页面就绪前就返回了（不应发生）"))
            }
            Err(mpsc::TryRecvError::Disconnected) => {
                return Err(err(ERR_PDF_NAV, "PDF 导出会话在就绪前关闭"))
            }
            Err(mpsc::TryRecvError::Empty) => {}
        }
        if std::time::Instant::now() >= deadline {
            return Err(err(
                ERR_PDF_TIMEOUT,
                format!(
                    "等待页面就绪超时（{}s）：临时 HTML 未在期限内满足就绪判据（检查 WebView2 是否正常、页面是否有死循环脚本）",
                    READY_TIMEOUT_MS / 1000
                ),
            ));
        }

        // 一次探测：eval_with_callback 的结果经回调送回通道
        let probe_tx = tx.clone();
        if let Err(e) = window.eval_with_callback(READY_PROBE_JS, move |raw| {
            if let Some(warnings) = probe_ready(&raw) {
                let _ = probe_tx.send(PdfEvent::Ready { warnings });
            }
        }) {
            return Err(err(ERR_PDF_NAV, format!("执行就绪探测失败: {e}")));
        }

        // 等探测回调或导航失败事件；超时即进入下一轮探测
        match rx.recv_timeout(Duration::from_millis(READY_POLL_MS)) {
            Ok(PdfEvent::Failed { message }) => return Err(message),
            Ok(PdfEvent::Ready { warnings }) => break warnings,
            Ok(PdfEvent::PrintDone { .. }) => {
                return Err(err(ERR_PDF_RENDER, "打印在页面就绪前就返回了（不应发生）"))
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(err(ERR_PDF_NAV, "PDF 导出会话在就绪前关闭"))
            }
        }
    };

    for w in &ready_warnings {
        eprintln!("[LightMD] PDF 就绪告警：{}", w);
    }
    let paper_name = match opts.paper {
        super::PdfPaper::A4 => "A4",
        super::PdfPaper::Letter => "Letter",
        super::PdfPaper::Legal => "Legal",
    };
    eprintln!(
        "[LightMD] PDF 页面就绪（纸张 {}，边距 {}mm，背景 {}，告警 {} 条）",
        paper_name,
        opts.margin_mm,
        if opts.print_background { "打印" } else { "不打印" },
        ready_warnings.len()
    );

    // 5b) 第二次 with_webview：在 UI 线程发起 PrintToPdf（目标是临时文件）
    let staged_path = HSTRING::from(staged_pdf.to_string_lossy().to_string());
    let print_start = {
        let w = window.clone();
        let slot = settings_slot.clone();
        let tx = tx.clone();
        w.with_webview(move |platform| {
            let settings = {
                let guard = slot.lock().unwrap_or_else(|p| p.into_inner());
                guard.as_ref().map(|s| s.0.clone())
            };
            let Some(settings) = settings else {
                let _ = tx.send(PdfEvent::Failed {
                    message: err(ERR_PDF_UNSUPPORTED, "打印设置未初始化（内部状态异常）"),
                });
                return;
            };
            // SAFETY: 闭包由 Tauri 派发到 WebView2 的 UI 线程
            if let Err(message) = unsafe { start_print(&platform, &staged_path, &settings, tx.clone()) } {
                let _ = tx.send(PdfEvent::Failed {
                    message: with_code_default(ERR_PDF_UNSUPPORTED, message),
                });
            }
        })
        .map_err(|e| err(ERR_PDF_NAV, format!("无法取得离屏 WebView 的 WebView2 句柄: {e}")))
    };
    print_start?;

    // 5c) 等打印完成回调
    loop {
        match rx.recv_timeout(Duration::from_millis(PRINT_TIMEOUT_MS)) {
            Ok(PdfEvent::PrintDone { success: false, detail }) => {
                return Err(err(
                    ERR_PDF_RENDER,
                    format!("WebView2 PrintToPdf 返回失败（{detail}）"),
                ))
            }
            Ok(PdfEvent::PrintDone { success: true, .. }) => break,
            Ok(PdfEvent::Failed { message }) => return Err(message),
            Ok(PdfEvent::Ready { .. }) => continue,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return Err(err(
                    ERR_PDF_TIMEOUT,
                    format!("等待 PrintToPdf 完成超时（{}s）", PRINT_TIMEOUT_MS / 1000),
                ))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(err(ERR_PDF_NAV, "PDF 导出会话在打印完成前关闭"))
            }
        }
    }

    // 5d) 校验临时产物 -> 搬到用户选择的路径
    let report = validate_pdf_output(staged_pdf)?;
    super::copy_pdf_to_target(staged_pdf, final_pdf)?;
    eprintln!(
        "[LightMD] PDF 导出完成 {} 字节（页数≈{:?}）→ {}",
        report.bytes,
        report.pages_hint,
        final_pdf.display()
    );
    Ok(report)
}

/// 解析探测表达式返回的 JSON（`ExecuteScript` 给的通常是一个 JSON 字符串字面量）。
///
/// 返回 `Some(warnings)` 表示"已就绪"；`None` 表示继续等（或探测本身异常）。
fn probe_ready(raw: &str) -> Option<Vec<String>> {
    let trimmed = raw.trim();
    // ExecuteScript 把结果再序列化一层：字符串结果带引号与转义。
    // 不同 WebView2 版本可能只给裸 JSON，这里两种都接受。
    let inner = serde_json::from_str::<String>(trimmed).unwrap_or_else(|_| trimmed.to_string());
    let v: serde_json::Value = serde_json::from_str(&inner).ok()?;
    if v.get("ready").and_then(|r| r.as_bool()) != Some(true) {
        if let Some(e) = v.get("error").and_then(|e| e.as_str()) {
            eprintln!("[LightMD] PDF 就绪探测异常：{}", e);
        }
        return None;
    }
    let warnings = v
        .get("warnings")
        .and_then(|w| w.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Some(warnings)
}

// ------------------------- 窗口与 COM 装配 -------------------------

/// 创建**离屏、不进任务栏、不可聚焦**的临时窗口，导航到 about:blank。
///
/// 先停在 about:blank，在 `with_webview` 里挂好事件后再显式 `Navigate` 到临时 HTML：
/// 否则 `build()` 会立刻导航，可能在我们挂 `NavigationCompleted` 之前就加载完
/// （本地 file:// 极快）-> 事件丢失。
///
/// 可见性：窗口放在虚拟桌面之外但 `visible(true)` —— 让 Chromium 认为页面可见，
/// 不节流 rAF/定时器，且 PrintToPdf 正常出页。用户看不到：位置在屏外、
/// `skip_taskbar` 无任务栏按钮、`focusable(false)` 不抢焦点、`decorations(false)` 无边框。
fn build_offscreen_window(app: &AppHandle, label: &str) -> Result<WebviewWindow, String> {
    let blank = WebviewUrl::External(
        "about:blank"
            .parse()
            .map_err(|e| err(ERR_PDF_NAV, format!("about:blank URL 解析失败: {e}")))?,
    );
    WebviewWindowBuilder::new(app, label, blank)
        .title("LightMD PDF")
        .inner_size(OFFSCREEN_W, OFFSCREEN_H)
        .position(OFFSCREEN_X, OFFSCREEN_Y)
        .decorations(false)
        .skip_taskbar(true)
        .focusable(false)
        .resizable(false)
        .visible(true)
        .build()
        .map_err(|e| err(ERR_PDF_NAV, format!("创建 PDF 导出离屏窗口失败: {e}")))
}

/// 在 UI 线程装配：打印设置 + 安全设置 + 导航事件 + 发起导航。
///
/// # Safety
/// 必须在 WebView2 的 UI 线程上调用（`with_webview` 闭包内），COM 对象不跨线程。
unsafe fn install_and_navigate(
    platform: &tauri::webview::PlatformWebview,
    tx: &mpsc::Sender<PdfEvent>,
    settings_slot: &SettingsSlot,
    file_url: &str,
    opts: PdfPrintOptions,
) -> Result<(), String> {
    let controller = platform.controller();
    let core = unsafe { controller.CoreWebView2() }
        .map_err(|e| err(ERR_PDF_NAV, format!("取 CoreWebView2 失败: {e}")))?;

    // 打印设置：需要 ICoreWebView2Environment6（WebView2 Runtime >= 1.0.1210）
    let env6 = platform
        .environment()
        .cast::<ICoreWebView2Environment6>()
        .map_err(|e| {
            err(
                ERR_PDF_UNSUPPORTED,
                format!("当前 WebView2 Runtime 不支持打印设置 API（需 >=1.0.1210 覆盖）：{e}"),
            )
        })?;
    let settings = unsafe { env6.CreatePrintSettings() }
        .map_err(|e| err(ERR_PDF_UNSUPPORTED, format!("创建打印设置失败: {e}")))?;
    apply_print_settings(&settings, opts)?;
    *settings_slot.lock().unwrap_or_else(|p| p.into_inner()) = Some(SendCom(settings));

    // 安全设置：导出页只是"打印靶子"。单项失败不致命（Runtime 版本差异），记日志继续。
    if let Ok(s) = unsafe { core.Settings() } {
        let failed: Vec<String> = [
            ("SetAreDefaultScriptDialogsEnabled", unsafe {
                s.SetAreDefaultScriptDialogsEnabled(false)
            }),
            ("SetAreDevToolsEnabled", unsafe { s.SetAreDevToolsEnabled(false) }),
            ("SetAreDefaultContextMenusEnabled", unsafe {
                s.SetAreDefaultContextMenusEnabled(false)
            }),
            ("SetIsStatusBarEnabled", unsafe { s.SetIsStatusBarEnabled(false) }),
        ]
        .iter()
        .filter_map(|(name, r)| r.as_ref().err().map(|e| format!("{name}: {e}")))
        .collect();
        if !failed.is_empty() {
            eprintln!(
                "[LightMD] PDF 离屏窗口部分安全设置失败（不影响打印）: {:?}",
                failed
            );
        }
    }

    // 禁止 JS window.open 开新窗口（打印页不应弹出任何窗口）
    let _ = unsafe {
        core.add_NewWindowRequested(
            &NewWindowRequestedEventHandler::create(Box::new(|_sender, args| {
                if let Some(args) = args {
                    args.SetHandled(true)?;
                }
                Ok(())
            })),
            std::ptr::null_mut(),
        )
    };

    // 导航失败是唯一需要主动上报的导航事件（成功由就绪轮询确认）
    let nav_tx = tx.clone();
    unsafe {
        core.add_NavigationCompleted(
            &NavigationCompletedEventHandler::create(Box::new(move |_sender, args| {
                if let Some(args) = args {
                    let mut ok = windows_core::BOOL(0);
                    args.IsSuccess(&mut ok)?;
                    if !ok.as_bool() {
                        let mut status = COREWEBVIEW2_WEB_ERROR_STATUS(0);
                        let _ = args.WebErrorStatus(&mut status);
                        let _ = nav_tx.send(PdfEvent::Failed {
                            message: err(
                                ERR_PDF_NAV,
                                format!("临时 HTML 导航失败（WebErrorStatus={}）", status.0),
                            ),
                        });
                    }
                }
                Ok(())
            })),
            std::ptr::null_mut(),
        )
        .map_err(|e| err(ERR_PDF_NAV, format!("注册 NavigationCompleted 失败: {e}")))?;
    }

    // 最后才导航：事件已就位，无丢失竞态
    let url = HSTRING::from(file_url);
    unsafe { core.Navigate(&url) }
        .map_err(|e| err(ERR_PDF_NAV, format!("导航到临时 HTML 失败: {e}")))?;
    Ok(())
}

/// 把 [`PdfPrintOptions`] 映射到 `COREWEBVIEW2_PRINT_SETTINGS`。
///
/// 数值来自纯函数 [`super::settings::print_settings_values`]（可单测），这里只写进 COM。
/// 单位：`PageWidth/PageHeight/*Margin` 均为**英寸**。
/// `ShouldPrintHeaderAndFooter=false` 关掉 WebView2 的**默认**页眉页脚
/// （日期 / 临时 URL / `N/M` 页码 —— 0.11.0 在 Edge 上要靠 `--no-pdf-header-footer`
/// 才消掉的东西）；页眉页脚继续由导出 HTML 的 `position: fixed` 元素承担。
fn apply_print_settings(
    settings: &ICoreWebView2PrintSettings,
    opts: PdfPrintOptions,
) -> Result<(), String> {
    let v = super::settings::print_settings_values(opts);
    let margin = v.margin_in;
    let empty = HSTRING::from("");
    let orientation = if v.portrait {
        COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT
    } else {
        COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE
    };
    // 注意：闭包参数不能叫 `err`（会遮蔽同名函数 `err`）
    let apply = |op: &str, r: windows_core::Result<()>| {
        r.map_err(|e| err(ERR_PDF_RENDER, format!("{op} 失败: {e}")))
    };
    unsafe {
        apply("SetOrientation", settings.SetOrientation(orientation))?;
        apply("SetPageWidth", settings.SetPageWidth(v.page_width_in))?;
        apply("SetPageHeight", settings.SetPageHeight(v.page_height_in))?;
        apply("SetMarginTop", settings.SetMarginTop(margin))?;
        apply("SetMarginBottom", settings.SetMarginBottom(margin))?;
        apply("SetMarginLeft", settings.SetMarginLeft(margin))?;
        apply("SetMarginRight", settings.SetMarginRight(margin))?;
        apply(
            "SetShouldPrintBackgrounds",
            settings.SetShouldPrintBackgrounds(v.print_background),
        )?;
        apply(
            "SetShouldPrintHeaderAndFooter",
            settings.SetShouldPrintHeaderAndFooter(v.native_header_footer),
        )?;
        // 双保险：即使某些 Runtime 忽略上面的开关，标题/URI 也是空的
        apply("SetHeaderTitle", settings.SetHeaderTitle(&empty))?;
        apply("SetFooterUri", settings.SetFooterUri(&empty))?;
    }
    Ok(())
}

/// 发起 `PrintToPdf`（需要 `ICoreWebView2_7`，Runtime >= 1.0.1210）
///
/// # Safety
/// 必须在 WebView2 的 UI 线程上调用。
fn start_print(
    platform: &tauri::webview::PlatformWebview,
    path: &HSTRING,
    settings: &ICoreWebView2PrintSettings,
    tx: mpsc::Sender<PdfEvent>,
) -> Result<(), String> {
    let core = unsafe { platform.controller().CoreWebView2() }
        .map_err(|e| format!("取 CoreWebView2 失败: {e}"))?;
    let webview7 = core
        .cast::<ICoreWebView2_7>()
        .map_err(|e| format!("当前 WebView2 Runtime 不支持 PrintToPdf（需 >=1.0.1210）: {e}"))?;
    unsafe {
        webview7
            .PrintToPdf(
                path,
                settings,
                &PrintToPdfCompletedHandler::create(Box::new(move |hr, success| {
                    let _ = tx.send(PdfEvent::PrintDone {
                        success: hr.is_ok() && success,
                        detail: match hr {
                            Ok(()) => format!("success={success}"),
                            Err(e) => format!("{e}"),
                        },
                    });
                    Ok(())
                })),
            )
            .map_err(|e| format!("调用 PrintToPdf 失败: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_probe_is_a_single_json_returning_expression() {
        // 必须是"单个表达式"：ExecuteScript 只取最后表达式的值
        assert!(READY_PROBE_JS.trim_start().starts_with("(function ()"));
        assert!(READY_PROBE_JS.trim_end().ends_with(")()"));
        // 必须有真实判据，而不是 sleep/固定延时
        assert!(READY_PROBE_JS.contains("document.readyState === 'complete'"));
        assert!(READY_PROBE_JS.contains("document.fonts"));
        assert!(READY_PROBE_JS.contains("document.images"));
        assert!(READY_PROBE_JS.contains(".mermaid"));
        assert!(READY_PROBE_JS.contains("[data-math]"));
        assert!(READY_PROBE_JS.contains("__LMD_PDF_READY"));
        // 连续 2 次探测稳定 + 25s 硬上限放行
        assert!(READY_PROBE_JS.contains("st.stable >= 2"));
        assert!(READY_PROBE_JS.contains("HARD_MS = 25000"));
        // 绝不能用 postMessage 上报（会让 wry 的 IPC 处理器 abort 进程）
        assert!(
            !READY_PROBE_JS.contains("postMessage"),
            "就绪上报不得走 chrome.webview.postMessage（wry file:// IPC 会 abort 进程）"
        );
        // 脚本内硬上限必须早于 Rust 侧超时，否则"告警放行"路径永远走不到
        assert!(READY_TIMEOUT_MS > 25_000);
    }

    #[test]
    fn probe_ready_parses_double_encoded_json() {
        // ExecuteScript 把结果再序列化一层：外层是 JSON 字符串字面量
        let inner = r#"{"ready":true,"warnings":["仍有 1 张图片未加载完成"],"elapsedMs":1200}"#;
        let raw = serde_json::to_string(inner).unwrap();
        assert_eq!(
            probe_ready(&raw),
            Some(vec!["仍有 1 张图片未加载完成".to_string()])
        );
        // 也容忍"未再包一层"的形态（不同 WebView2 版本序列化行为不同）
        assert_eq!(
            probe_ready(inner),
            Some(vec!["仍有 1 张图片未加载完成".to_string()])
        );
    }

    #[test]
    fn probe_ready_returns_none_until_ready_and_ignores_bad_json() {
        assert_eq!(probe_ready(r#"{"ready":false}"#), None);
        assert_eq!(probe_ready(r#"{"ready":false,"error":"boom"}"#), None);
        assert_eq!(probe_ready(r#""""#), None);
        assert_eq!(probe_ready("not json at all"), None);
        assert_eq!(probe_ready(r#"{"ready":true}"#), Some(Vec::new()));
    }

    #[test]
    fn offscreen_geometry_keeps_desktop_like_viewport() {
        // 视口与打印无关，但改太小会让 max-width 类排版明显偏离桌面观感
        assert!(OFFSCREEN_W >= 800.0);
        assert!(OFFSCREEN_H >= 600.0);
        // 必须真的在屏幕外（任何真实显示器坐标都不可能到这里）
        assert!(OFFSCREEN_X <= -10_000.0);
        assert!(OFFSCREEN_Y <= -10_000.0);
    }

    #[test]
    fn error_codes_are_prefixed_and_not_double_prefixed() {
        assert!(err(ERR_PDF_TIMEOUT, "x").starts_with("PDF_TIMEOUT|"));
        let already = err(ERR_PDF_UNSUPPORTED, "Runtime 过旧");
        assert_eq!(with_code_default(ERR_PDF_NAV, already.clone()), already);
        assert_eq!(
            with_code_default(ERR_PDF_NAV, "裸文本".to_string()),
            "PDF_NAV|裸文本"
        );
        assert_eq!(
            with_code_default(ERR_PDF_NAV, already).split('|').next(),
            Some("PDF_UNSUPPORTED")
        );
    }
}
