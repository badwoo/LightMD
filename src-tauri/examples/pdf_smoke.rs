//! 真机烟囱测试（v0.15.0 C2）：进程内 WebView2 `PrintToPdf` 端到端验证。
//!
//! 不是单元测试：需要真实 WebView2 Runtime + GUI 会话，手动运行：
//!
//! ```bash
//! cd src-tauri && cargo run --bin pdf_smoke
//! ```
//!
//! 覆盖：三种纸张 × 三档边距（含 PDF MediaBox 尺寸抽检）、连续导出覆盖写同一路径、
//! 3 路并发导出互不干扰、不可写目标路径必须返回 `PDF_IO`。
//! 退出码 0 = 全部通过；1 = 有失败（原因打在 stderr）。

use std::path::PathBuf;

use lightmd_lib::pdf::{self, PdfPaper};

fn build_html(paper: PdfPaper, margin_mm: f64) -> String {
    let size = match paper {
        PdfPaper::A4 => "A4",
        PdfPaper::Letter => "Letter",
        PdfPaper::Legal => "Legal",
    };
    let dot = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
    format!(
        r#"<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>PDF 验收</title>
<style>
@page {{ size: {size}; margin: {margin_mm}mm; }}
.pdf-header {{ position: fixed; top: 0; left: 0; right: 0; text-align: center; font-size: 9pt; color: #666; }}
.pdf-footer {{ position: fixed; bottom: 0; left: 0; right: 0; text-align: center; font-size: 9pt; color: #666; }}
body {{ font-family: "Segoe UI", "Microsoft YaHei", sans-serif; font-size: 12pt; line-height: 1.6; background: #fdfdfd; }}
table {{ border-collapse: collapse; width: 100%; }}
th, td {{ border: 1px solid #ddd; padding: 8px 12px; text-align: left; }}
</style></head><body>
<div class="pdf-header">LightMD 导出验收</div>
<div class="pdf-footer">2026-10-26</div>
<h1>LightMD PDF 导出验收</h1>
<p>中文段落：轻量级 Markdown 编辑器，验证字体、行高与断行。</p>
<p>English: The quick brown fox jumps over the lazy dog.</p>
<p><img src="{dot}" width="8" height="8" alt="dot"> 图片 decode 判据（data URL）。</p>
<table><thead><tr><th>项目</th><th>值</th></tr></thead>
<tbody><tr><td>纸张</td><td>{size}</td></tr><tr><td>页边距</td><td>{margin_mm}mm</td></tr></tbody></table>
<div style="page-break-before: always;"></div>
<h2>第二页</h2><p>分页验证：这一段必须落在第二页。</p>
</body></html>"#
    )
}

/// 从 PDF 头部抽检 MediaBox（pt）。解析失败返回 None（仅诊断）
fn first_mediabox(bytes: &[u8]) -> Option<(f64, f64)> {
    let text = String::from_utf8_lossy(&bytes[..bytes.len().min(200_000)]);
    let idx = text.find("/MediaBox")?;
    let after = &text[idx + "/MediaBox".len()..];
    let open = after.find('[')?;
    let close = after[open..].find(']')?;
    let nums: Vec<f64> = after[open + 1..open + close]
        .split_whitespace()
        .filter_map(|n| n.parse::<f64>().ok())
        .collect();
    (nums.len() == 4).then(|| (nums[2] - nums[0], nums[3] - nums[1]))
}

fn main() {
    let out_dir = std::env::temp_dir().join("lightmd-pdf-smoke");
    if let Err(e) = std::fs::create_dir_all(&out_dir) {
        eprintln!("[SMOKE] 无法创建输出目录 {}: {e}", out_dir.display());
        std::process::exit(1);
    }
    let failures = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));

    let fails = failures.clone();
    let out = out_dir.clone();
    let app = tauri::Builder::default()
        .setup(move |app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                run_cases(&handle, &out, &fails).await;
                handle.exit(0);
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("构建最小 Tauri 应用失败");

    app.run(move |_app, event| {
        if let tauri::RunEvent::Exit = event {
            let fails = failures.lock().unwrap();
            if fails.is_empty() {
                println!("\n[SMOKE] ✅ 全部通过");
                std::process::exit(0);
            }
            eprintln!("\n[SMOKE] ❌ 失败 {} 项", fails.len());
            for f in fails.iter() {
                eprintln!("  - {f}");
            }
            std::process::exit(1);
        }
    });
}

async fn run_cases(
    app: &tauri::AppHandle,
    out_dir: &PathBuf,
    failures: &std::sync::Mutex<Vec<String>>,
) {
    // 用例 1：三种纸张 × 三档边距 + MediaBox 抽检
    for paper in [PdfPaper::A4, PdfPaper::Letter, PdfPaper::Legal] {
        for margin_mm in [10.0_f64, 20.0, 30.0] {
            let html = build_html(paper, margin_mm);
            let path = out_dir.join(format!("{paper:?}-{margin_mm}mm.pdf"));
            let _ = std::fs::remove_file(&path);
            let t0 = std::time::Instant::now();
            match pdf::print_to_pdf(app, html, path.to_string_lossy().to_string()).await {
                Ok(report) => {
                    println!(
                        "[SMOKE] ✓ {:?} / {}mm → {} 字节，约 {:?} 页，{}ms → {}",
                        paper,
                        margin_mm,
                        report.bytes,
                        report.pages_hint,
                        t0.elapsed().as_millis(),
                        path.display()
                    );
                    let bytes = std::fs::read(&path).unwrap();
                    if let Some((mw, mh)) = first_mediabox(&bytes) {
                        let (w, h) = paper.size_inches();
                        let (want_w, want_h) = (w * 72.0, h * 72.0);
                        if (mw - want_w).abs() > 2.0 || (mh - want_h).abs() > 2.0 {
                            failures.lock().unwrap().push(format!(
                                "{paper:?} MediaBox 不匹配：期望 ({want_w:.1},{want_h:.1})pt，实际 ({mw},{mh})pt"
                            ));
                        }
                    }
                }
                Err(e) => failures
                    .lock()
                    .unwrap()
                    .push(format!("{paper:?}/{margin_mm}mm 导出失败: {e}")),
            }
        }
    }

    // 用例 2：连续导出同一路径（覆盖写，第二次必须成功且文件仍有效）
    let same = out_dir.join("same-path.pdf");
    for round in 1..=2 {
        match pdf::print_to_pdf(
            app,
            build_html(PdfPaper::A4, 20.0),
            same.to_string_lossy().to_string(),
        )
        .await
        {
            Ok(r) => println!("[SMOKE] ✓ 连续导出第 {round} 次：{} 字节", r.bytes),
            Err(e) => failures
                .lock()
                .unwrap()
                .push(format!("连续导出第 {round} 次失败: {e}")),
        }
    }

    // 用例 3：并发导出（各自隐藏窗口 + 唯一临时目录，互不干扰）
    let mut tasks = Vec::new();
    for i in 0..3 {
        let app = app.clone();
        let path = out_dir.join(format!("concurrent-{i}.pdf"));
        let _ = std::fs::remove_file(&path);
        let html = build_html(
            if i % 2 == 0 { PdfPaper::A4 } else { PdfPaper::Letter },
            20.0,
        );
        let path_str = path.to_string_lossy().to_string();
        tasks.push(tauri::async_runtime::spawn(async move {
            (i, path, pdf::print_to_pdf(&app, html, path_str).await)
        }));
    }
    for task in tasks {
        match task.await {
            Ok((i, path, Ok(r))) => println!(
                "[SMOKE] ✓ 并发导出 #{i}: {} 字节 → {}",
                r.bytes,
                path.display()
            ),
            Ok((i, _p, Err(e))) => failures
                .lock()
                .unwrap()
                .push(format!("并发导出 #{i} 失败: {e}")),
            Err(e) => failures
                .lock()
                .unwrap()
                .push(format!("并发导出任务异常: {e}")),
        }
    }

    // 用例 4：不可写目标路径 → PDF_IO
    let blocker = out_dir.join("blocker-file");
    std::fs::write(&blocker, b"x").unwrap();
    let impossible = blocker.join("child").join("x.pdf");
    match pdf::print_to_pdf(
        app,
        build_html(PdfPaper::A4, 20.0),
        impossible.to_string_lossy().to_string(),
    )
    .await
    {
        Err(e) if e.starts_with("PDF_IO|") => println!("[SMOKE] ✓ 不可写路径正确返回 PDF_IO"),
        Err(e) => failures
            .lock()
            .unwrap()
            .push(format!("不可写路径错误码不符（期望 PDF_IO）: {e}")),
        Ok(r) => failures
            .lock()
            .unwrap()
            .push(format!("不可写路径竟导出成功（{} 字节）", r.bytes)),
    }
}
