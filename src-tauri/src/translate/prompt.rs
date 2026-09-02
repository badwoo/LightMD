//! Prompt 模板组装 —— AI 翻译（v0.6.0）
//!
//! 内置模板含四条防破坏规则（占位符保留 / Markdown 标记保留 /
//! 无前后缀 / 段落结构保留），用户可在设置中自定义覆盖。
//! `{target_lang}` / `{tone}` 为保留变量，组装时替换。

/// 内置 Prompt 模板（v0.6.0）
pub const DEFAULT_PROMPT_TEMPLATE: &str = concat!(
    "你是专业翻译。将用户内容翻译为{target_lang}，语体：{tone}。\n",
    "规则：\n",
    "1. 必须原样保留 {{N}} 占位符（包括花括号），位置语义对应即可\n",
    "2. 保留所有 Markdown 标记（**、*、#、- 等）\n",
    "3. 直接输出译文本身：不要任何前言、后语、解释，不要用代码块包裹输出\n",
    "4. 保留原文的段落结构"
);

/// 组装翻译 Prompt
/// - `target_lang`：目标语言；传 "auto" 时按源文本 CJK 占比判向（中英互译）
/// - `tone`：语体（"正式" / "口语" / "技术文档"）
/// - `custom`：用户自定义模板（None 时用内置模板）
pub fn build_prompt(source_text: &str, target_lang: &str, tone: &str, custom: Option<&str>) -> String {
    let resolved_lang = resolve_target_lang(source_text, target_lang);
    let template = custom.unwrap_or(DEFAULT_PROMPT_TEMPLATE);
    template
        .replace("{target_lang}", resolved_lang)
        .replace("{tone}", tone)
}

/// 目标语言解析："auto" → 按源文本判向，其他原样返回
fn resolve_target_lang<'a>(source_text: &str, target_lang: &'a str) -> &'a str {
    if target_lang.eq_ignore_ascii_case("auto") {
        if is_chinese_dominant(source_text) {
            "English"
        } else {
            "简体中文"
        }
    } else {
        target_lang
    }
}

/// 判断文本是否以中文为主：CJK 字符数占非空白字符比例 > 50%
fn is_chinese_dominant(text: &str) -> bool {
    let mut cjk = 0usize;
    let mut other = 0usize;
    for ch in text.chars() {
        if ch.is_whitespace() {
            continue;
        }
        // CJK 统一表意文字 + 扩展A + 中文标点
        let is_cjk = matches!(ch as u32,
            0x4E00..=0x9FFF | 0x3400..=0x4DBF |
            0x3000..=0x303F | 0xFF00..=0xFFEF);
        if is_cjk {
            cjk += 1;
        } else {
            other += 1;
        }
    }
    let total = cjk + other;
    total > 0 && cjk * 2 > total
}

// ─── 单元测试 ─────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_prompt_default() {
        let p = build_prompt("hello", "简体中文", "正式", None);
        assert!(p.contains("翻译为简体中文"));
        assert!(p.contains("语体：正式"));
        // 占位符规则中的 {{N}} 不应被变量替换机制破坏
        assert!(p.contains("{{N}}"));
        assert!(p.contains("保留所有 Markdown 标记"));
    }

    #[test]
    fn test_build_prompt_custom() {
        let p = build_prompt("hello", "English", "口语", Some("译成{target_lang}，风格{tone}"));
        assert_eq!(p, "译成English，风格口语");
    }

    #[test]
    fn test_auto_lang_chinese_to_english() {
        let p = build_prompt("这是一段中文内容", "auto", "正式", None);
        assert!(p.contains("翻译为English"));
    }

    #[test]
    fn test_auto_lang_english_to_chinese() {
        let p = build_prompt("This is English content", "auto", "正式", None);
        assert!(p.contains("翻译为简体中文"));
    }

    #[test]
    fn test_auto_lang_mixed_majority() {
        // 中文占多数 → 译英
        let p = build_prompt("这段文字主体是中文内容，仅有 ok 一个英文词", "auto", "正式", None);
        assert!(p.contains("翻译为English"));
    }

    #[test]
    fn test_is_chinese_dominant() {
        assert!(is_chinese_dominant("你好世界"));
        assert!(!is_chinese_dominant("hello world"));
        assert!(!is_chinese_dominant("")); // 空文本不算中文为主
        // 中文标点也计入 CJK
        assert!(is_chinese_dominant("「引号」"));
    }
}
