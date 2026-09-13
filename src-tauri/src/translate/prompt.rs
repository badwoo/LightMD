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

// ─── AI 助手 Prompt（v0.7.0：续写 / 润色 / 摘要）────────────────

/// AI 助手任务类型常量（前端 aiAssistService 传入，与 TS 侧 AiTask 一一对应）
pub const AI_TASK_CONTINUE: &str = "continue";
pub const AI_TASK_POLISH: &str = "polish";
pub const AI_TASK_SUMMARY: &str = "summary";

/// 续写：基于上文自然衔接（用户消息 = 光标前文本，截尾由前端完成）
/// v0.7.1 精简：单行指令保留全部关键约束（语言风格跟随/段数/占位符/
/// Markdown/无前后缀），系统提示词每次请求都计费，压缩冗余措辞省 token
const AI_PROMPT_CONTINUE: &str = concat!(
    "基于用户上文续写 1~3 段：沿用上文的语气、风格、人称与语言，",
    "不复述上文；原样保留 {{N}} 占位符与所有 Markdown 标记",
    "（**、*、#、- 等）；直接输出续写内容，无任何前后缀与解释，不用代码块包裹"
);

/// 润色：保持原意，改进表达（用户消息 = 选中文本）
/// v0.7.1 精简：同上（保留原意/段落结构/占位符/Markdown/无前后缀全部约束）
const AI_PROMPT_POLISH: &str = concat!(
    "润色选中文字：保持原意与段落结构，不增删段落，令表达更流畅并修正错别字标点；",
    "原样保留 {{N}} 占位符（包括花括号）与所有 Markdown 标记（**、*、#、- 等）；",
    "直接输出润色结果，无任何前后缀与解释，不用代码块包裹"
);

/// 摘要：整篇/选区内容生成连贯摘要（用户消息 = 文档全文或选区）
/// v0.7.1 精简：同上（保留同语言/字数/占位符/无前后缀全部约束）
const AI_PROMPT_SUMMARY: &str = concat!(
    "为用户提供的内容生成一段 150~300 字的连贯摘要，概括核心要点：",
    "使用与原文相同的语言；原样保留 {{N}} 占位符（包括花括号）；",
    "直接输出摘要本身，无任何前后缀与解释，不用引用块或代码块包裹"
);

/// 组装 AI 助手 Prompt（v0.7.0）
/// - `task`：AI_TASK_CONTINUE / AI_TASK_POLISH / AI_TASK_SUMMARY
/// - 返回 Err 时为错误码协议字符串（未知任务类型，防前端传参异常）
pub fn build_ai_assist_prompt(task: &str) -> Result<String, String> {
    match task {
        AI_TASK_CONTINUE => Ok(AI_PROMPT_CONTINUE.to_string()),
        AI_TASK_POLISH => Ok(AI_PROMPT_POLISH.to_string()),
        AI_TASK_SUMMARY => Ok(AI_PROMPT_SUMMARY.to_string()),
        // 未知任务：STREAM 前缀（前端按"请求异常"处理），不透出内部细节
        other => Err(format!("STREAM|未知任务类型: {}", other)),
    }
}

// ─── AI 对话 Prompt（v0.7.5：自由指令浮动窗口）────────────────────

/// AI 对话任务常量（前端 aiChatService 使用；对话通道的用户指令为自由形态，
/// 不参与 build_ai_assist_prompt 的分支匹配，此处仅作任务标识统一）
pub const AI_TASK_CHAT: &str = "chat";

/// AI 对话 system 提示词（v0.7.5）
///
/// 与续写/润色/摘要的"单轮指令拼 user 消息"不同，对话通道由前端携带多轮
/// messages（role/content），本常量作为唯一 system 消息注入，用于把自由指令
/// 约束成可直接落盘的 Markdown：
/// - 图表统一 mermaid 围栏、公式统一 $$，插回文档后被 v0.4.x 的
///   mermaid-block / math-block 实时预览自动渲染（"文生图表"零额外渲染代码）
/// - 默认无前言后语，避免客套话污染文档
pub const AI_CHAT_SYSTEM_PROMPT: &str = concat!(
    "你是 Markdown 编辑器 LightMD 的内置 AI 助手。用户会给出指令，可能附带文档内容。\n",
    "规则：\n",
    "1. 默认输出合法 Markdown，直接输出内容本身，无前言、后语、解释\n",
    "2. 生成图表一律使用 ```mermaid 围栏代码块（编辑器可实时渲染）\n",
    "3. 生成公式使用 $$ 块级语法（编辑器可实时渲染）\n",
    "4. 用户要求分析/概括/评价时，可直接输出结构化 Markdown（标题/列表/表格）\n",
    "5. 除非用户要求，不复述输入内容"
);

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

    // ─── v0.7.0：AI 助手 Prompt ─────────────────────────────

    #[test]
    fn test_ai_prompt_continue() {
        let p = build_ai_assist_prompt(AI_TASK_CONTINUE).unwrap();
        assert!(p.contains("续写"));
        assert!(p.contains("1~3 段"));
        // 占位符规则中的 {{N}} 不应被破坏
        assert!(p.contains("{{N}}"));
        assert!(p.contains("Markdown 标记"));
        assert!(p.contains("不用代码块包裹"));
    }

    #[test]
    fn test_ai_prompt_polish() {
        let p = build_ai_assist_prompt(AI_TASK_POLISH).unwrap();
        assert!(p.contains("润色"));
        assert!(p.contains("保持原意"));
        assert!(p.contains("{{N}}"));
        // 润色规则：占位符与 Markdown 标记一并保护
        assert!(p.contains("Markdown 标记"));
        assert!(p.contains("段落结构"));
    }

    #[test]
    fn test_ai_prompt_summary() {
        let p = build_ai_assist_prompt(AI_TASK_SUMMARY).unwrap();
        assert!(p.contains("摘要"));
        assert!(p.contains("150~300 字"));
        assert!(p.contains("{{N}}"));
        assert!(p.contains("不用引用块或代码块包裹"));
    }

    #[test]
    fn test_ai_prompt_unknown_task() {
        // 未知任务类型返回 STREAM| 错误码协议（防前端传参异常）
        let err = build_ai_assist_prompt("translate").unwrap_err();
        assert!(err.starts_with("STREAM|"));
        assert!(build_ai_assist_prompt("").is_err());
    }

    // ─── v0.7.5：AI 对话 system prompt ─────────────────────

    /// 对话提示词必须显式约束 mermaid 围栏与 $$ 公式，
    /// 否则"文生图表/公式"无法被编辑器实时渲染管线接管
    #[test]
    fn test_ai_chat_system_prompt_has_render_constraints() {
        let p = AI_CHAT_SYSTEM_PROMPT;
        assert!(p.contains("```mermaid"), "必须声明 mermaid 围栏约束");
        assert!(p.contains("$$"), "必须声明 $$ 公式约束");
        assert!(p.contains("Markdown"));
        // 无前言后语（避免客套话污染文档）
        assert!(p.contains("无前言、后语、解释"));
        // 分析类任务允许结构化输出
        assert!(p.contains("表格"));
    }

    #[test]
    fn test_ai_chat_task_constant() {
        // 对话任务标识独立于续写/润色/摘要，避免误入 build_ai_assist_prompt 分支
        assert_eq!(AI_TASK_CHAT, "chat");
        assert!(build_ai_assist_prompt(AI_TASK_CHAT).is_err());
    }
}
