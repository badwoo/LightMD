//! 打印设置：纸张 / 边距的纯函数（与 WebView2 `COREWEBVIEW2_PRINT_SETTINGS` 映射）。
//!
//! 设计约束（v0.15.0 C2）：
//! - 前端 `export_html_to_pdf(html, pdfPath)` 签名不变，**不新增前端参数**；
//!   纸张/边距仍由前端 `generatePrintCss` 写进导出 HTML 的 `@page` 规则。
//! - 因此 Rust 侧从 HTML 的 `@page { size: ...; margin: ...mm }` **解析**出
//!   [`PdfPrintOptions`]，再映射到 PrintSettings。解析失败一律回落默认值
//!   （A4 / 20mm），保证「旧版 HTML 或第三方 HTML 也能导出」。
//! - CSS 的 `@page` 与 PrintSettings 同时存在时以 CSS 为准（Chromium 行为），
//!   PrintSettings 是"CSS 未声明时"的兜底；两边取同一份数值，避免观感漂移。
//! - 不恢复 CSS margin box 页码（0.11.0 已判定 Chromium 不支持）。

/// 支持的纸张（与前端 `PaperSize` 一一对应）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PdfPaper {
    A4,
    Letter,
    Legal,
}

impl PdfPaper {
    /// 解析 CSS `size` 关键字（大小写不敏感；兼容 "A4 portrait" 之类写法）
    pub fn parse(value: &str) -> Option<Self> {
        // CSS 允许 `size: A4 portrait`，取第一个 token
        let first = value
            .trim()
            .split_whitespace()
            .next()
            .unwrap_or("")
            .trim_matches('"')
            .trim_matches('\'')
            .to_ascii_lowercase();
        match first.as_str() {
            "a4" => Some(Self::A4),
            "letter" => Some(Self::Letter),
            "legal" => Some(Self::Legal),
            _ => None,
        }
    }

    /// 纸张物理尺寸（英寸）：WebView2 PrintSettings 的 PageWidth / PageHeight 单位
    pub fn size_inches(self) -> (f64, f64) {
        match self {
            // 210mm × 297mm
            Self::A4 => (8.267_716, 11.692_913),
            // 8.5in × 11in
            Self::Letter => (8.5, 11.0),
            // 8.5in × 14in
            Self::Legal => (8.5, 14.0),
        }
    }
}

/// 打印设置（由导出 HTML 的 `@page` 解析而来）
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PdfPrintOptions {
    pub paper: PdfPaper,
    /// 页边距（毫米，0..=50；非法值回落 20）
    pub margin_mm: f64,
    /// 是否打印背景色（保留主题底色；默认 true，与 0.11.0 现状一致）
    pub print_background: bool,
}

impl Default for PdfPrintOptions {
    fn default() -> Self {
        Self {
            paper: PdfPaper::A4,
            margin_mm: 20.0,
            print_background: true,
        }
    }
}

/// 毫米 → 英寸（PrintSettings 的边距单位是英寸）
pub fn mm_to_inch(mm: f64) -> f64 {
    mm / 25.4
}

/// `COREWEBVIEW2_PRINT_SETTINGS` 的**数值快照**（纯数据，可单测）。
///
/// 把这层抽出来，是为了让"纸张/边距/背景/页眉页脚"的映射规则能被测试覆盖，
/// 而 `windows.rs` 里的 [`crate::pdf::windows`] 只负责把这些数值写进 COM 对象
/// （那部分依赖真实 WebView2 Runtime，无法在单测里断言）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PrintSettingsValues {
    /// 纸张宽（英寸）
    pub page_width_in: f64,
    /// 纸张高（英寸）
    pub page_height_in: f64,
    /// 四边页边距（英寸，四边一致——前端 `@page` 只支持单一 margin 值）
    pub margin_in: f64,
    /// 是否打印背景（保留主题底色）
    pub print_background: bool,
    /// 是否打印 WebView2 **默认**页眉页脚 —— 恒 false：
    /// 页眉页脚由导出 HTML 的 `position: fixed` 元素实现（0.11.0 已验证）；
    /// 打开默认页眉页脚会叠印日期/临时文件 URL/`N/M` 页码。
    pub native_header_footer: bool,
    /// 是否纵向
    pub portrait: bool,
}

/// 由 [`PdfPrintOptions`] 计算打印设置的数值（纯函数）
pub fn print_settings_values(opts: PdfPrintOptions) -> PrintSettingsValues {
    let (w, h) = opts.paper.size_inches();
    PrintSettingsValues {
        page_width_in: w,
        page_height_in: h,
        margin_in: mm_to_inch(clamp_margin_mm(opts.margin_mm)),
        print_background: opts.print_background,
        // 恒关：见字段文档
        native_header_footer: false,
        portrait: true,
    }
}

/// 边距合法性：与前端 `resolveMarginMm` 同口径（0..=50，越界回落 20）
pub fn clamp_margin_mm(v: f64) -> f64 {
    if !v.is_finite() || !(0.0..=50.0).contains(&v) {
        20.0
    } else {
        v
    }
}

/// 从导出 HTML 中解析 `@page` 设置（找不到 / 解析失败 → 默认 A4·20mm）
pub fn parse_page_setup(html: &str) -> PdfPrintOptions {
    let mut opts = PdfPrintOptions::default();
    let Some(block) = first_page_block(html) else {
        return opts;
    };
    for decl in block.split(';') {
        let Some((name, value)) = decl.split_once(':') else {
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        match name.as_str() {
            "size" => {
                if let Some(paper) = PdfPaper::parse(value) {
                    opts.paper = paper;
                }
            }
            "margin" => {
                // 允许 1~4 个值（CSS 简写）；页面按「上边距」取值，与页眉页脚定位口径一致
                if let Some(mm) = parse_length_mm(value) {
                    opts.margin_mm = clamp_margin_mm(mm);
                }
            }
            _ => {}
        }
    }
    opts
}

/// 取第一个 `@page { ... }` 的块内容（不含花括号本身）。
/// 手写扫描而非正则：`@page` 体内还可能嵌 `@top-center { }`（历史 HTML），
/// 需要按花括号配对，不能先出现 `}` 就截断。
fn first_page_block(html: &str) -> Option<&str> {
    let lower = html.to_ascii_lowercase();
    let mut search_from = 0usize;
    while let Some(rel) = lower[search_from..].find("@page") {
        let at = search_from + rel;
        let after = at + "@page".len();
        // `@page` 之后必须是空白再跟 `{`（避免误匹配 `@page-group` 之类）
        let rest = &html[after..];
        let brace_rel = rest.find('{')?;
        // 花括号之间只允许空白
        if !rest[..brace_rel].trim().is_empty() {
            search_from = after;
            continue;
        }
        let body_start = after + brace_rel + 1;
        let mut depth = 1usize;
        for (i, ch) in html[body_start..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(&html[body_start..body_start + i]);
                    }
                }
                _ => {}
            }
        }
        search_from = after;
    }
    None
}

/// 解析 CSS 长度 → 毫米。支持 mm / cm / in / pt / px（px 按 96dpi）；裸数字按 mm
fn parse_length_mm(value: &str) -> Option<f64> {
    // 只取第一个 token（如 `20mm auto` → 20mm）
    let token = value
        .trim()
        .split_whitespace()
        .next()?
        .trim_matches('"')
        .trim_matches('\'');
    if token.is_empty() {
        return None;
    }
    let lower = token.to_ascii_lowercase();
    let (num_str, unit) = if let Some(s) = lower.strip_suffix("mm") {
        (s, "mm")
    } else if let Some(s) = lower.strip_suffix("cm") {
        (s, "cm")
    } else if let Some(s) = lower.strip_suffix("in") {
        (s, "in")
    } else if let Some(s) = lower.strip_suffix("pt") {
        (s, "pt")
    } else if let Some(s) = lower.strip_suffix("px") {
        (s, "px")
    } else {
        (lower.as_str(), "mm")
    };
    let v: f64 = num_str.trim().parse().ok()?;
    if !v.is_finite() {
        return None;
    }
    let mm = match unit {
        "cm" => v * 10.0,
        "in" => v * 25.4,
        "pt" => v * 25.4 / 72.0,
        "px" => v * 25.4 / 96.0,
        _ => v,
    };
    Some(mm)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HTML_A4_20: &str = r#"<style>@page {
  size: A4;
  margin: 20mm;
}
body{color:#1a1a1a}</style>"#;

    #[test]
    fn parses_a4_and_margin_from_export_html() {
        let opts = parse_page_setup(HTML_A4_20);
        assert_eq!(opts.paper, PdfPaper::A4);
        assert!((opts.margin_mm - 20.0).abs() < 1e-9);
        assert!(opts.print_background, "默认打印背景（保留主题底色）");
    }

    #[test]
    fn parses_letter_legal_and_wide_narrow_margins() {
        let letter = parse_page_setup("<style>@page { size: Letter; margin: 10mm; }</style>");
        assert_eq!(letter.paper, PdfPaper::Letter);
        assert!((letter.margin_mm - 10.0).abs() < 1e-9);

        let legal = parse_page_setup("<style>@page { size: legal; margin: 30mm; }</style>");
        assert_eq!(legal.paper, PdfPaper::Legal);
        assert!((legal.margin_mm - 30.0).abs() < 1e-9);
    }

    #[test]
    fn defaults_when_no_page_rule() {
        let opts = parse_page_setup("<html><body>无 @page</body></html>");
        assert_eq!(opts, PdfPrintOptions::default());
    }

    #[test]
    fn clamps_out_of_range_margin_to_normal() {
        assert!((clamp_margin_mm(0.0) - 0.0).abs() < 1e-9);
        assert!((clamp_margin_mm(50.0) - 50.0).abs() < 1e-9);
        assert!((clamp_margin_mm(60.0) - 20.0).abs() < 1e-9);
        assert!((clamp_margin_mm(-5.0) - 20.0).abs() < 1e-9);
        assert!((clamp_margin_mm(f64::NAN) - 20.0).abs() < 1e-9);
    }

    #[test]
    fn parses_custom_margin_zero_and_other_units() {
        let zero = parse_page_setup("<style>@page { size: A4; margin: 0mm; }</style>");
        assert!((zero.margin_mm - 0.0).abs() < 1e-9);

        let inch = parse_page_setup("<style>@page { size: A4; margin: 1in; }</style>");
        assert!((inch.margin_mm - 25.4).abs() < 1e-6);

        let bare = parse_page_setup("<style>@page { margin: 12; }</style>");
        assert!((bare.margin_mm - 12.0).abs() < 1e-9);
    }

    #[test]
    fn nested_margin_box_does_not_break_parser() {
        // 历史 HTML（0.11.0 之前）带有嵌套 margin box，解析必须跳过整块
        let html = r#"<style>@page {
  size: A4;
  margin: 20mm;
  @top-center { content: "标题"; }
  @bottom-center { content: counter(page); }
}</style>"#;
        let opts = parse_page_setup(html);
        assert_eq!(opts.paper, PdfPaper::A4);
        assert!((opts.margin_mm - 20.0).abs() < 1e-9);
    }

    #[test]
    fn ignores_unrelated_at_rules_before_page() {
        let html = r#"<style>@media print { body { color: #000 } }
@page { size: Legal; margin: 25mm; }</style>"#;
        let opts = parse_page_setup(html);
        assert_eq!(opts.paper, PdfPaper::Legal);
        assert!((opts.margin_mm - 25.0).abs() < 1e-9);
    }

    #[test]
    fn print_settings_map_paper_and_margin_to_inches() {
        // A4 + 20mm（默认值）：纸张 = 210/297mm 换算，边距 = 20/25.4
        let v = print_settings_values(PdfPrintOptions::default());
        assert!((v.page_width_in - 210.0 / 25.4).abs() < 1e-5);
        assert!((v.page_height_in - 297.0 / 25.4).abs() < 1e-5);
        assert!((v.margin_in - 20.0 / 25.4).abs() < 1e-9);
        assert!(v.print_background, "默认打印背景，保留主题底色");
        assert!(!v.native_header_footer, "必须关闭 WebView2 默认页眉页脚");
        assert!(v.portrait);
    }

    #[test]
    fn print_settings_covers_three_papers_and_margin_presets() {
        // 三种纸张 × 前三档边距（10/20/30mm）
        for (paper, w_in, h_in) in [
            (PdfPaper::A4, 210.0 / 25.4, 297.0 / 25.4),
            (PdfPaper::Letter, 8.5, 11.0),
            (PdfPaper::Legal, 8.5, 14.0),
        ] {
            for margin_mm in [10.0_f64, 20.0, 30.0, 0.0, 50.0] {
                let v = print_settings_values(PdfPrintOptions {
                    paper,
                    margin_mm,
                    print_background: true,
                });
                assert!((v.page_width_in - w_in).abs() < 1e-5, "{:?}", paper);
                assert!((v.page_height_in - h_in).abs() < 1e-5, "{:?}", paper);
                assert!((v.margin_in - margin_mm / 25.4).abs() < 1e-9);
                assert!(v.page_height_in >= v.page_width_in, "纵向纸张高度不应小于宽度");
            }
        }
    }

    #[test]
    fn print_settings_clamps_illegal_margin_instead_of_passing_garbage() {
        // 越界/NaN 边距不得原样传给 COM（会让 SetMargin* 返回 E_INVALIDARG）
        for bad in [60.0_f64, -1.0, f64::NAN, f64::INFINITY] {
            let v = print_settings_values(PdfPrintOptions {
                paper: PdfPaper::A4,
                margin_mm: bad,
                print_background: true,
            });
            assert!((v.margin_in - 20.0 / 25.4).abs() < 1e-9, "bad={}", bad);
        }
    }

    #[test]
    fn paper_sizes_match_inch_contract() {
        let a4 = PdfPaper::A4.size_inches();
        assert!((a4.0 - 210.0 / 25.4).abs() < 1e-5);
        assert!((a4.1 - 297.0 / 25.4).abs() < 1e-5);
        assert_eq!(PdfPaper::Letter.size_inches(), (8.5, 11.0));
        assert_eq!(PdfPaper::Legal.size_inches(), (8.5, 14.0));
        assert!((mm_to_inch(25.4) - 1.0).abs() < 1e-9);
    }
}
