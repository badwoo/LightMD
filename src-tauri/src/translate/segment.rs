//! 占位符提取/回填/校验 —— AI 翻译第二层防御（v0.6.0）
//!
//! 设计：翻译前将 markdown 片段中的敏感片段（块级代码、行内代码、链接 URL）
//! 提取为 {{N}} 占位符，译文回填后保证标记 100% 不丢。
//!
//! 提取顺序（顺序敏感，不可调换）：
//! 1. 块级代码围栏（``` 围栏，含 mermaid）
//! 2. 行内代码（`x` 与 ``x``——与前端 serializer 的 applyMark 规则一致）
//! 3. 链接 URL（`[text](url)` 与 `![alt](src)` 的 URL 部分）
//! 4. 裸 URL（v0.6.2：句中出现的 http(s):// 或 www. 开头链接，无法翻译，
//!    占位符化避免 LLM 破坏，同时省去翻译 URL 的 token）
//!
//! LLM 兼容：回填与校验均容忍 `{0}`、`{{ 0 }}` 等花括号变体（归一化处理）。

/// 提取结果：占位符化文本 + 原始 token 列表
pub struct Segments {
    /// 含 {{N}} 占位符的待译文本
    pub masked_text: String,
    /// tokens[N] 对应 {{N}} 的原始内容
    pub tokens: Vec<String>,
}

/// 对文本做占位符提取（纯函数，无副作用）
pub fn mask(text: &str) -> Segments {
    // 依次应用多层提取，每层吃掉上一层输出中的敏感片段
    let pass1 = mask_fenced_code(text);
    let pass2 = mask_inline_code(&pass1.text, pass1.tokens);
    // v0.6.4：图片语法整体占位符化（alt + URL 均不翻译——alt 译成外文会破坏
    // 图片语义，纯图片块更会让 LLM 返回空内容导致段失败）
    let pass2b = mask_images(&pass2.text, pass2.tokens);
    let pass3 = mask_link_urls(&pass2b.text, pass2b.tokens);
    // v0.6.2：第四层裸 URL（] (url) 形式已被第三层处理，这里兜底句中裸链接）
    let pass4 = mask_bare_urls(&pass3.text, pass3.tokens);
    Segments {
        masked_text: pass4.text,
        tokens: pass4.tokens,
    }
}

/// 将译文中的占位符（含变体）回填为原始内容
pub fn unmask(masked: &str, tokens: &[String]) -> String {
    let mut result = masked.to_string();
    // 从大到小替换不是必须的（我们按精确数字匹配），但逐个 token 处理
    for (n, token) in tokens.iter().enumerate() {
        if let Some((start, end)) = find_placeholder(&result, n) {
            result.replace_range(start..end, token);
        }
        // 找不到占位符时保留原样（校验阶段会标记失败）
    }
    result
}

/// 校验译文中 {{0}}..{{N-1}} 每个恰好出现一次（归一化匹配）
pub fn validate(result: &str, expected_count: usize) -> bool {
    if expected_count == 0 {
        return true;
    }
    let mut counts = vec![0usize; expected_count];
    for (_, _, n) in scan_placeholders(result) {
        if n < expected_count {
            counts[n] += 1;
        }
    }
    counts.iter().all(|&c| c == 1)
}

// ─── 扫描出的占位符：(字节起始, 字节结束, 数字) ─────────────────

/// 扫描文本中所有占位符形态：{{N}} / {{ N }} / {N} / { N }
/// 优先匹配双花括号（避免 {{0}} 被 {0} 部分匹配）
fn scan_placeholders(text: &str) -> Vec<(usize, usize, usize)> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'{' {
            i += 1;
            continue;
        }
        // 尝试双花括号 {{ ws? digits ws? }}
        if let Some((end, n)) = try_parse_double_brace(bytes, i) {
            out.push((i, end, n));
            i = end;
            continue;
        }
        // 尝试单花括号 { ws? digits ws? }
        if let Some((end, n)) = try_parse_single_brace(bytes, i) {
            out.push((i, end, n));
            i = end;
            continue;
        }
        i += 1;
    }
    out
}

/// 在文本中查找数字 n 对应的第一个占位符（含变体），返回字节范围
fn find_placeholder(text: &str, n: usize) -> Option<(usize, usize)> {
    scan_placeholders(text)
        .into_iter()
        .find(|(_, _, num)| *num == n)
        .map(|(s, e, _)| (s, e))
}

/// 解析 {{ ws? digits ws? }}（起点 i 指向第一个 '{'）
fn try_parse_double_brace(bytes: &[u8], i: usize) -> Option<(usize, usize)> {
    let mut j = i + 1;
    if j >= bytes.len() || bytes[j] != b'{' {
        return None;
    }
    j += 1;
    j = skip_ws(bytes, j);
    let (j2, n) = parse_digits(bytes, j)?;
    j = skip_ws(bytes, j2);
    if j < bytes.len() && bytes[j] == b'}' && j + 1 < bytes.len() && bytes[j + 1] == b'}' {
        Some((j + 2, n))
    } else {
        None
    }
}

/// 解析 { ws? digits ws? }（起点 i 指向 '{'）
fn try_parse_single_brace(bytes: &[u8], i: usize) -> Option<(usize, usize)> {
    let mut j = i + 1;
    j = skip_ws(bytes, j);
    let (j2, n) = parse_digits(bytes, j)?;
    j = skip_ws(bytes, j2);
    if j < bytes.len() && bytes[j] == b'}' {
        Some((j + 1, n))
    } else {
        None
    }
}

fn skip_ws(bytes: &[u8], mut i: usize) -> usize {
    while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
        i += 1;
    }
    i
}

/// 解析连续数字（不允许为空），返回 (结束位置, 数值)。溢出按 usize::MAX 截断。
fn parse_digits(bytes: &[u8], mut i: usize) -> Option<(usize, usize)> {
    let start = i;
    let mut n: usize = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        n = n.saturating_mul(10).saturating_add((bytes[i] - b'0') as usize);
        i += 1;
    }
    if i == start {
        None
    } else {
        Some((i, n))
    }
}

// ─── 三层提取实现 ─────────────────────────────────────────────

struct MaskPass {
    text: String,
    tokens: Vec<String>,
}

/// 第一层：块级代码围栏（行首 ``` 围栏，含语言标注与 mermaid）
/// 序列化器输出形如 "```rust\ncode\n```\n"，整体提取为占位符。
fn mask_fenced_code(text: &str) -> MaskPass {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out: Vec<String> = Vec::new();
    let mut tokens: Vec<String> = Vec::new();
    let mut in_fence = false;
    let mut fence_content: Vec<&str> = Vec::new();

    for line in &lines {
        let trimmed = line.trim_start();
        if !in_fence && trimmed.starts_with("```") {
            in_fence = true;
            fence_content = vec![line];
            continue;
        }
        if in_fence {
            fence_content.push(line);
            if trimmed.starts_with("```") {
                // 围栏结束：整体作为占位符（含首尾换行由外层拼接处理）
                let block = fence_content.join("\n");
                tokens.push(block.clone());
                out.push(format!("{{{{{}}}}}", tokens.len() - 1));
                in_fence = false;
            }
            continue;
        }
        out.push((*line).to_string());
    }
    if in_fence {
        // 未闭合围栏（异常输入）：原样保留，不做保护
        let tail = fence_content.join("\n");
        out.push(tail);
    }
    MaskPass {
        text: out.join("\n"),
        tokens,
    }
}

/// 第二层：行内代码（`x` 与 ``x``）
/// 与前端 serializer 规则一致：内容含反引号时用双反引号包裹。
fn mask_inline_code(text: &str, mut tokens: Vec<String>) -> MaskPass {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'`' {
            // 原样拷贝一个 UTF-8 字符
            let ch_len = utf8_len(bytes[i]);
            out.push_str(&text[i..i + ch_len]);
            i += ch_len;
            continue;
        }
        // 数连续反引号数量（行内代码最多 2 个；3+ 为围栏，理论上已被第一层处理）
        let mut ticks = 0;
        let tick_start = i;
        while i < bytes.len() && bytes[i] == b'`' && ticks < 3 {
            ticks += 1;
            i += 1;
        }
        if ticks >= 3 {
            // 未被第一层处理的围栏残余，原样保留
            out.push_str(&text[tick_start..i]);
            continue;
        }
        // 向后找相同数量的连续反引号
        if let Some(end_ticks) = find_tick_run(bytes, i, ticks) {
            // token 含首尾反引号（回填后格式标记完整保留）
            let full = &text[tick_start..end_ticks + ticks];
            tokens.push(full.to_string());
            out.push_str(&format!("{{{{{}}}}}", tokens.len() - 1));
            i = end_ticks + ticks;
        } else {
            // 未闭合：原样保留反引号
            out.push_str(&text[tick_start..i]);
        }
    }
    MaskPass { text: out, tokens }
}

/// 从 from 开始找连续 tick_count 个反引号的起始位置
fn find_tick_run(bytes: &[u8], from: usize, tick_count: usize) -> Option<usize> {
    let mut i = from;
    while i < bytes.len() {
        if bytes[i] == b'`' {
            let mut n = 0;
            let start = i;
            while i < bytes.len() && bytes[i] == b'`' {
                n += 1;
                i += 1;
            }
            if n == tick_count {
                return Some(start);
            }
            // 数量不匹配（如 `` 遇到 `），继续向后找
        } else {
            i += 1;
        }
    }
    None
}

// ─── 图片整体提取（v0.6.4）──────────────────────────────

/// 第三层前置：图片语法 `![alt](url)` 整体提取为占位符（alt + URL 均不翻译）。
/// - alt 是图片说明，翻译成目标语言会破坏原文档语义（图片路径/说明应保持原样）
/// - 纯图片块 mask 后只剩一个占位符，LLM 无可译内容易返回空 → 段失败
/// URL 中的配对括号按括号计数处理（与 mask_link_urls 一致）。
fn mask_images(text: &str, mut tokens: Vec<String>) -> MaskPass {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        // 检测 "![" 起始
        if bytes[i] == b'!' && i + 1 < bytes.len() && bytes[i + 1] == b'[' {
            // 向后找 alt 结束的 "]"（alt 内不嵌套 "["）
            if let Some(close) = text[i + 2..].find(']').map(|p| i + 2 + p) {
                // "]" 后紧跟 "("
                if close + 1 < bytes.len() && bytes[close + 1] == b'(' {
                    // 括号计数扫描 URL（与 mask_link_urls 相同）
                    let mut depth = 1;
                    let mut j = close + 2;
                    while j < bytes.len() {
                        if bytes[j] == b'(' {
                            depth += 1;
                        } else if bytes[j] == b')' {
                            depth -= 1;
                            if depth == 0 {
                                break;
                            }
                        }
                        j += 1;
                    }
                    if j < bytes.len() && depth == 0 {
                        // 整体（![alt](url)）提取为占位符
                        let full = &text[i..j + 1];
                        tokens.push(full.to_string());
                        out.push_str(&format!("{{{{{}}}}}", tokens.len() - 1));
                        i = j + 1;
                        continue;
                    }
                }
            }
        }
        let ch_len = utf8_len(bytes[i]);
        out.push_str(&text[i..i + ch_len]);
        i += ch_len;
    }
    MaskPass { text: out, tokens }
}

/// 第三层：链接 URL（`](` 之后到配对 `)` 的部分，同时覆盖图片 `!](`）
/// URL 中的配对括号（如 wiki 链接）按括号计数处理。
fn mask_link_urls(text: &str, mut tokens: Vec<String>) -> MaskPass {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        // 检测 "](" 模式
        if bytes[i] == b']' && i + 1 < bytes.len() && bytes[i + 1] == b'(' {
            // 括号计数扫描 URL（从 '(' 之后开始，深度 1）
            let mut depth = 1;
            let mut j = i + 2;
            while j < bytes.len() {
                if bytes[j] == b'(' {
                    depth += 1;
                } else if bytes[j] == b')' {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                j += 1;
            }
            if j < bytes.len() && depth == 0 {
                // 提取 URL 为占位符，保留 "](" 与 ")"
                let url = &text[i + 2..j];
                if !url.is_empty() {
                    tokens.push(url.to_string());
                    out.push_str("](");
                    out.push_str(&format!("{{{{{}}}}}", tokens.len() - 1));
                    out.push(')');
                    i = j + 1;
                    continue;
                }
            }
        }
        let ch_len = utf8_len(bytes[i]);
        out.push_str(&text[i..i + ch_len]);
        i += ch_len;
    }
    MaskPass { text: out, tokens }
}

/// 返回 UTF-8 字符长度（首字节前导 1 的数量）
fn utf8_len(first_byte: u8) -> usize {
    if first_byte < 0x80 {
        1
    } else if first_byte >> 5 == 0b110 {
        2
    } else if first_byte >> 4 == 0b1110 {
        3
    } else if first_byte >> 3 == 0b11110 {
        4
    } else {
        1 // 非法字节，按 1 处理避免死循环
    }
}

// ─── 第四层：裸 URL（v0.6.2）──────────────────────────────

/// 检测位置 i 处的 URL 前缀（https:// | http:// | www.），返回前缀长度
fn url_prefix_at(text: &str, i: usize) -> Option<usize> {
    let rest = &text[i..];
    if rest.starts_with("https://") {
        Some(8)
    } else if rest.starts_with("http://") {
        Some(7)
    } else if rest.starts_with("www.") {
        Some(4)
    } else {
        None
    }
}

/// URL 主体允许的 ASCII 字符（RFC 3986 常见子集）。
/// 刻意不含括号/引号/感叹号/星号/方括号：这些字符用作 URL 周围的
/// 自然语言标点（如 "(https://a.com)"），词边界判断需要它们"不是 URL 字符"
fn is_url_char(b: u8) -> bool {
    b.is_ascii_alphanumeric()
        || matches!(b,
            b'-' | b'.' | b'_' | b'~' | b':' | b'/' | b'?' | b'#'
            | b'@' | b'$' | b'&' | b'+' | b',' | b';' | b'=' | b'%')
}

/// 第四层：裸 URL（v0.6.2）
/// 句中出现的 http(s):// 或 www. 开头链接（非 `](url)` 链接语法形式），
/// 整体提取为占位符：URL 无法翻译，占位符化省 token 且防止 LLM 破坏。
/// 词边界：前一字符非 URL 组成字符（UTF-8 多字节字符天然满足）；
/// 尾部悬挂标点（. , ; : ! ? ) ] } " '）剥离后不计入 URL。
fn mask_bare_urls(text: &str, mut tokens: Vec<String>) -> MaskPass {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        if let Some(prefix_len) = url_prefix_at(text, i) {
            let at_word_boundary = i == 0 || !is_url_char(bytes[i - 1]);
            if at_word_boundary {
                // 向后扫描 URL 主体
                let mut j = i + prefix_len;
                while j < bytes.len() && is_url_char(bytes[j]) {
                    j += 1;
                }
                // 剥离尾部悬挂标点（如 "见 https://a.com。" 中的句号）
                let mut end = j;
                while end > i + prefix_len
                    && matches!(bytes[end - 1],
                        b'.' | b',' | b';' | b':' | b'!' | b'?'
                        | b')' | b']' | b'}' | b'"' | b'\'')
                {
                    end -= 1;
                }
                // www. 前缀要求主体中还有至少一个点（排除 "wwwfoo" 类误报）
                let url = &text[i..end];
                let has_dot = prefix_len == 4 && url[4..].contains('.');
                if !url.is_empty() && (prefix_len != 4 || has_dot) {
                    tokens.push(url.to_string());
                    out.push_str(&format!("{{{{{}}}}}", tokens.len() - 1));
                    i = end;
                    continue;
                }
            }
        }
        let ch_len = utf8_len(bytes[i]);
        out.push_str(&text[i..i + ch_len]);
        i += ch_len;
    }
    MaskPass { text: out, tokens }
}

// ─── 单元测试 ─────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mask_empty_and_plain() {
        let seg = mask("");
        assert_eq!(seg.masked_text, "");
        assert!(seg.tokens.is_empty());

        let seg = mask("普通文本，无任何标记");
        assert_eq!(seg.masked_text, "普通文本，无任何标记");
        assert!(seg.tokens.is_empty());
        assert!(validate(&seg.masked_text, 0));
    }

    #[test]
    fn test_mask_inline_code() {
        let seg = mask("使用 `cargo build` 构建");
        assert_eq!(seg.masked_text, "使用 {{0}} 构建");
        // token 含反引号（回填后标记完整）
        assert_eq!(seg.tokens, vec!["`cargo build`"]);
        assert!(validate(&seg.masked_text, 1));
    }

    #[test]
    fn test_mask_inline_code_double_ticks() {
        // 内容含反引号时 serializer 用双反引号包裹
        let seg = mask("运行 ``a`b`` 命令");
        assert_eq!(seg.masked_text, "运行 {{0}} 命令");
        assert_eq!(seg.tokens, vec!["``a`b``"]);
    }

    #[test]
    fn test_mask_unclosed_backtick_unchanged() {
        let seg = mask("单个反引号 ` 未闭合");
        assert_eq!(seg.masked_text, "单个反引号 ` 未闭合");
        assert!(seg.tokens.is_empty());
    }

    #[test]
    fn test_mask_link_url() {
        let seg = mask("见 [文档](https://doc.rs) 与 [教程](https://a.b/c)");
        assert_eq!(seg.masked_text, "见 [文档]({{0}}) 与 [教程]({{1}})");
        assert_eq!(seg.tokens, vec!["https://doc.rs", "https://a.b/c"]);
        assert!(validate(&seg.masked_text, 2));
    }

    #[test]
    fn test_mask_image_url() {
        // v0.6.4：图片语法整体占位符化（alt + URL 均不翻译）
        let seg = mask("图片 ![alt](https://img.example.com/a.png) 结束");
        assert_eq!(seg.masked_text, "图片 {{0}} 结束");
        assert_eq!(seg.tokens, vec!["![alt](https://img.example.com/a.png)"]);
    }

    #[test]
    fn test_mask_image_whole_block() {
        // v0.6.4：纯图片块（用户实证场景）——整体一个占位符，alt 不参与翻译
        let seg = mask("![截图](./images/流程图.png)");
        assert_eq!(seg.masked_text, "{{0}}");
        assert_eq!(seg.tokens, vec!["![截图](./images/流程图.png)"]);
        // roundtrip：占位符保留即原文 100% 不破坏
        let restored = unmask(&seg.masked_text, &seg.tokens);
        assert_eq!(restored, "![截图](./images/流程图.png)");
    }

    #[test]
    fn test_mask_image_with_parens_url() {
        // URL 含配对括号：括号计数正确处理
        let seg = mask("![x](https://a.com/img_(1).png) 后文");
        assert_eq!(seg.masked_text, "{{0}} 后文");
        assert_eq!(seg.tokens, vec!["![x](https://a.com/img_(1).png)"]);
    }

    #[test]
    fn test_mask_image_alt_with_brackets_url() {
        // alt 含 URL 样式内容：整体按图片处理
        let seg = mask("![src=https://a.com](b.png)");
        assert_eq!(seg.masked_text, "{{0}}");
        assert_eq!(seg.tokens, vec!["![src=https://a.com](b.png)"]);
    }

    #[test]
    fn test_mask_link_url_with_parens() {
        let seg = mask("维基 [页面](https://en.wikipedia.org/wiki/Foo_(bar)) 结束");
        assert_eq!(seg.masked_text, "维基 [页面]({{0}}) 结束");
        assert_eq!(seg.tokens, vec!["https://en.wikipedia.org/wiki/Foo_(bar)"]);
    }

    #[test]
    fn test_mask_fenced_code_block() {
        let src = "前文\n```rust\nfn main() {}\n```\n后文";
        let seg = mask(src);
        assert_eq!(seg.masked_text, "前文\n{{0}}\n后文");
        assert_eq!(seg.tokens, vec!["```rust\nfn main() {}\n```"]);
        assert!(validate(&seg.masked_text, 1));
    }

    #[test]
    fn test_mask_mermaid_block() {
        let src = "说明\n```mermaid\ngraph TD; A-->B;\n```\n结束";
        let seg = mask(src);
        assert_eq!(seg.masked_text, "说明\n{{0}}\n结束");
        assert!(seg.tokens[0].starts_with("```mermaid"));
    }

    #[test]
    fn test_mask_mixed_priority() {
        // 行内代码内的链接语法不应被链接层重复提取（已被占位符替换）
        let seg = mask("用 `[a](b)` 语法");
        assert_eq!(seg.masked_text, "用 {{0}} 语法");
        assert_eq!(seg.tokens, vec!["`[a](b)`"]);
    }

    #[test]
    fn test_unmask_basic_roundtrip() {
        let seg = mask("使用 `cargo build`，见 [文档](https://doc.rs)");
        let translated = "Use {{0}}, see [docs]({{1}})";
        let restored = unmask(translated, &seg.tokens);
        assert_eq!(restored, "Use `cargo build`, see [docs](https://doc.rs)");
    }

    #[test]
    fn test_unmask_variant_braces() {
        // LLM 输出 {0} 单花括号变体
        let restored = unmask("Use {0} now", &["`x`".to_string()]);
        assert_eq!(restored, "Use `x` now");
        // LLM 输出 {{ 0 }} 带空格变体
        let restored2 = unmask("Use {{ 0 }} now", &["`x`".to_string()]);
        assert_eq!(restored2, "Use `x` now");
    }

    #[test]
    fn test_unmask_missing_placeholder_kept() {
        // 占位符丢失时原样保留（由 validate 标记失败）
        let restored = unmask("no placeholder", &["`x`".to_string()]);
        assert_eq!(restored, "no placeholder");
    }

    #[test]
    fn test_validate_ok() {
        assert!(validate("a {{0}} b {{1}} c", 2));
        assert!(validate("a {0} b {{ 1 }} c", 2));
        assert!(validate("no placeholder", 0));
    }

    #[test]
    fn test_validate_missing() {
        assert!(!validate("a {{0}} b", 2)); // 缺 {{1}}
    }

    #[test]
    fn test_validate_duplicated() {
        assert!(!validate("a {{0}} b {{0}} c {{1}}", 2)); // {{0}} 出现两次
    }

    #[test]
    fn test_validate_out_of_range_ignored() {
        // 多出的 {{5}} 不影响 0..2 的校验（LLM 幻觉数字，按失败计数内规则）
        assert!(validate("a {{0}} {{1}} {{5}}", 2));
    }

    #[test]
    fn test_mask_cjk_multibyte_safety() {
        let seg = mask("中文「测试」`code`与链接 [x](https://y.z)");
        assert_eq!(seg.masked_text, "中文「测试」{{0}}与链接 [x]({{1}})");
        assert_eq!(seg.tokens, vec!["`code`", "https://y.z"]);
        let roundtrip = unmask(&seg.masked_text, &seg.tokens);
        assert_eq!(roundtrip, "中文「测试」`code`与链接 [x](https://y.z)");
    }

    #[test]
    fn test_scan_placeholders_priority() {
        // {{0}} 不应被 {0} 拆开部分匹配（{{0}} 为 5 字节：2..7）
        let found = scan_placeholders("x {{0}} y");
        assert_eq!(found, vec![(2, 7, 0)]);
        // 混合形态
        let found2 = scan_placeholders("{0} {{1}}");
        assert_eq!(found2, vec![(0, 3, 0), (4, 9, 1)]);
    }

    // ─── 第四层：裸 URL（v0.6.2）────────────────────────

    #[test]
    fn test_mask_bare_url_in_sentence() {
        // 句中裸 URL：占位符化，前后文字保留
        let seg = mask("访问 https://example.com/docs 查看");
        assert_eq!(seg.masked_text, "访问 {{0}} 查看");
        assert_eq!(seg.tokens, vec!["https://example.com/docs"]);
    }

    #[test]
    fn test_mask_bare_url_with_trailing_punctuation() {
        // 尾部悬挂标点（句号/逗号）不计入 URL
        let seg = mask("见 https://a.com。然后 https://b.com，结束");
        assert_eq!(seg.masked_text, "见 {{0}}。然后 {{1}}，结束");
        assert_eq!(seg.tokens, vec!["https://a.com", "https://b.com"]);
    }

    #[test]
    fn test_mask_bare_url_in_parens() {
        // 半角括号包裹的 URL（词边界正确识别）
        let seg = mask("详见 (https://a.com/x) 文档");
        assert_eq!(seg.masked_text, "详见 ({{0}}) 文档");
        assert_eq!(seg.tokens, vec!["https://a.com/x"]);
    }

    #[test]
    fn test_mask_bare_url_www_prefix() {
        let seg = mask("去 www.example.com 看看");
        assert_eq!(seg.masked_text, "去 {{0}} 看看");
        assert_eq!(seg.tokens, vec!["www.example.com"]);
    }

    #[test]
    fn test_mask_bare_url_www_requires_dot() {
        // "wwwfoo" 无点：非 URL，原样保留
        let seg = mask("这是 wwwfoo 不是链接");
        assert_eq!(seg.masked_text, "这是 wwwfoo 不是链接");
        assert!(seg.tokens.is_empty());
    }

    #[test]
    fn test_mask_bare_url_not_after_word_char() {
        // "abcwww.example.com"：前一字符是字母 → 非词边界，不提取
        let seg = mask("abcwww.example.com 保持原样");
        assert_eq!(seg.masked_text, "abcwww.example.com 保持原样");
    }

    #[test]
    fn test_mask_bare_url_link_syntax_not_double_processed() {
        // ](url) 链接语法已被第三层处理，第四层不重复提取
        let seg = mask("见 [文档](https://doc.rs) 与裸链 https://bare.com");
        assert_eq!(seg.masked_text, "见 [文档]({{0}}) 与裸链 {{1}}");
        assert_eq!(seg.tokens, vec!["https://doc.rs", "https://bare.com"]);
        // 回填 roundtrip
        let restored = unmask(&seg.masked_text, &seg.tokens);
        assert_eq!(restored, "见 [文档](https://doc.rs) 与裸链 https://bare.com");
    }

    #[test]
    fn test_mask_bare_url_roundtrip_cjk() {
        // 中文紧邻 URL（多字节字符天然词边界）
        let seg = mask("官网https://a.com首页");
        // URL 前是中文 → 词边界 ✓；URL 后中文终止扫描
        assert_eq!(seg.masked_text, "官网{{0}}首页");
        assert_eq!(seg.tokens, vec!["https://a.com"]);
    }
}
