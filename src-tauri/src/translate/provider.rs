//! OpenAI 兼容 Provider —— AI 翻译 / AI 对话 HTTP 客户端与 SSE 解析（v0.6.0）
//!
//! 要点：
//! - 全局复用一个 reqwest::Client（OnceLock，连接池复用省 TLS 握手）
//! - 流式 SSE：按 data: 行切分，仅取 choices[0].delta.content，
//!   忽略 reasoning_content（DeepSeek-R1 类推理模型兼容）
//! - 取消：SSE 读取循环每次 chunk 前检查 AtomicBool
//! - max_tokens 按输入长度估算封顶，finish_reason=length 视为截断失败
//! - v0.7.5：SSE 读取循环提取为私有方法 stream_chat_completions，
//!   翻译（translate_stream）与自由对话（chat_stream）共用；两者仅请求体不同
//!
//! 错误编码协议（前端 translateService 按前缀解析）：
//! NETWORK| / AUTH| / RATE| / TRUNCATED| / STREAM| / CANCELLED /
//! PLACEHOLDER| / PROVIDER|{status}|{message}

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use serde::Deserialize;
use serde_json::json;

use crate::translate::segment;

/// 超时策略：连接 10s；整体 120s（覆盖整个流式读取，防挂死）
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(120);

// ─── 错误类型 ─────────────────────────────────────────────────

#[derive(Debug)]
pub enum TranslateError {
    /// 网络不可达/连接超时
    Network,
    /// 401/403 → 提示检查 Key
    Unauthorized,
    /// 429 → 提示稍后重试
    RateLimited,
    /// 其他 HTTP 错误，透出厂商 message（不含请求头/Key）
    ProviderError(u16, String),
    /// finish_reason=length：译文被截断，禁止写回文档
    ResponseTruncated,
    /// SSE 流中断或空响应
    StreamInterrupted,
    /// 用户中断（静默处理）
    Cancelled,
}

impl TranslateError {
    /// 编码为前端协议字符串（translateService 按前缀解析显示差异化文案）
    pub fn to_code_string(&self) -> String {
        match self {
            TranslateError::Network => "NETWORK|".to_string(),
            TranslateError::Unauthorized => "AUTH|".to_string(),
            TranslateError::RateLimited => "RATE|".to_string(),
            TranslateError::ProviderError(status, msg) => {
                format!("PROVIDER|{}|{}", status, msg)
            }
            TranslateError::ResponseTruncated => "TRUNCATED|".to_string(),
            TranslateError::StreamInterrupted => "STREAM|".to_string(),
            TranslateError::Cancelled => "CANCELLED".to_string(),
        }
    }
}

impl std::fmt::Display for TranslateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.to_code_string())
    }
}

impl std::error::Error for TranslateError {}

// ─── 结果模型 ─────────────────────────────────────────────────

/// 翻译结果（序列化给前端）
/// v0.6.1 修复：Tauri v2 命令返回值不会自动转 camelCase，
/// 前端 TranslateResultData 按 camelCase 读取（finishReason/placeholdersIntact），
/// 此前 snake_case 序列化导致全文翻译段校验全部失败（误报"连接中断"）
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateResult {
    /// 完整译文（已回填占位符）
    pub translated: String,
    /// {{N}} 占位符校验结果（失败时前端降级走双语插入）
    pub placeholders_intact: bool,
    /// "stop" 正常；"length" 视为截断失败
    pub finish_reason: String,
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
}

/// max_tokens 估算：min(8192, max(1024, 输入字符数 × 3))，防失控输出与费用意外
pub fn estimate_max_tokens(input_chars: usize) -> u32 {
    (input_chars.saturating_mul(3)).clamp(1024, 8192) as u32
}

/// v0.7.5：AI 对话单条消息（前端 aiChatService 组装角色语义后传入）
///
/// role 仅接受 "user" / "assistant"；system 由 Rust 侧注入
/// （见 ai_chat 命令的过滤逻辑，防前端伪造 system 覆盖内置约束）。
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// AI 对话输出上限（字符生成空间；自由指令可能生成图表/长文，比翻译预算更宽）
pub const CHAT_MAX_TOKENS: u32 = 4096;

/// AI 对话采样温度下限（v0.7.5）
///
/// 翻译固定低温（默认 0.1）求确定性；对话需要一定生成力，故在用户配置温度
/// 基础上抬到 ≥0.3。取 max 而非硬编码，是为了兼容 kimi 等仅允许
/// temperature=1 的厂商（v0.7.3 修复的 400 invalid temperature 问题不复发）。
pub fn chat_temperature(configured: f32) -> f32 {
    configured.max(0.3)
}

// ─── 模型列表响应（v0.7.2 P2：GET /models） ─────────────────────

#[derive(Deserialize)]
struct ModelsResponse {
    #[serde(default)]
    data: Vec<ModelsResponseItem>,
}

#[derive(Deserialize)]
struct ModelsResponseItem {
    id: Option<String>,
}

// ─── SSE 行解析（纯函数，供单测） ─────────────────────────────

/// 一行 SSE data 的解析结果（多个字段可同时出现）
#[derive(Debug, Default, PartialEq)]
pub struct ParsedLine {
    pub delta: Option<String>,
    pub finish_reason: Option<String>,
    pub usage: Option<(u32, u32)>,
}

#[derive(Deserialize)]
struct SseChunk {
    #[serde(default)]
    choices: Vec<SseChoice>,
    #[serde(default)]
    usage: Option<SseUsage>,
}

#[derive(Deserialize)]
struct SseChoice {
    #[serde(default)]
    delta: Option<SseDelta>,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct SseDelta {
    #[serde(default)]
    content: Option<String>,
    // reasoning_content 显式忽略（推理模型兼容）
}

#[derive(Deserialize)]
struct SseUsage {
    #[serde(default)]
    prompt_tokens: u32,
    #[serde(default)]
    completion_tokens: u32,
}

/// 解析一条 SSE data 载荷（JSON）；解析失败返回 None（跳过坏行不中断整流）
pub fn parse_sse_data(data: &str) -> Option<ParsedLine> {
    let chunk: SseChunk = serde_json::from_str(data).ok()?;
    let mut out = ParsedLine::default();
    if let Some(choice) = chunk.choices.into_iter().next() {
        if let Some(delta) = choice.delta {
            out.delta = delta.content.filter(|c| !c.is_empty());
        }
        out.finish_reason = choice.finish_reason.filter(|r| !r.is_empty());
    }
    if let Some(u) = chunk.usage {
        out.usage = Some((u.prompt_tokens, u.completion_tokens));
    }
    if out.delta.is_none() && out.finish_reason.is_none() && out.usage.is_none() {
        return None; // 空行（如纯 role chunk）
    }
    Some(out)
}

// ─── Provider ─────────────────────────────────────────────────

/// OpenAI 兼容端点客户端（v0.6.0 唯一实现，具体类型无 trait）
pub struct OpenAiCompatibleProvider {
    pub base_url: String,
    pub model: String,
    pub api_key: String,
    /// 采样温度（v0.7.3：由设置传入，不再硬编码 0.1）。
    /// 多数端点接受 [0, 2]；部分厂商/推理模型（如 kimi 部分模型）仅允许 1，
    /// 故须支持按厂商定制，否则会收到 400 invalid temperature。
    pub temperature: f32,
}

/// 全局复用 Client（连接池复用，翻译频繁时省 TLS 握手）
fn shared_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(TOTAL_TIMEOUT)
            .build()
            .expect("failed to build reqwest client")
    })
}

impl OpenAiCompatibleProvider {
    /// 测试连接：发送 max_tokens=1 的最小请求验证 Key 有效性
    pub async fn test_connection(&self) -> Result<(), TranslateError> {
        let url = format!("{}/chat/completions", self.base_url.trim_end_matches('/'));
        let body = json!({
            "model": self.model,
            "stream": false,
            "max_tokens": 1,
            "messages": [{"role": "user", "content": "hi"}],
        });
        let resp = shared_client()
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .json(&body)
            .send()
            .await
            .map_err(map_reqwest_err)?;
        check_status(resp).await?;
        Ok(())
    }

    /// v0.7.2 P2：拉取模型列表（GET {base}/models，OpenAI 兼容格式 {"data":[{"id":...}]}）
    /// 用于设置页动态刷新 datalist，避免静态预设列表随厂商上下线模型而过时。
    /// 不支持该端点的厂商（如部分兼容层）返回 PROVIDER 错误，前端回退静态列表。
    pub async fn list_models(&self) -> Result<Vec<String>, TranslateError> {
        let url = format!("{}/models", self.base_url.trim_end_matches('/'));
        let resp = shared_client()
            .get(&url)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .send()
            .await
            .map_err(map_reqwest_err)?;
        let resp = check_status(resp).await?;
        let body: ModelsResponse = resp
            .json()
            .await
            .map_err(|_| TranslateError::StreamInterrupted)?;
        let mut ids: Vec<String> = body.data.into_iter().filter_map(|m| m.id).collect();
        ids.sort();
        ids.dedup();
        Ok(ids)
    }

    /// 流式翻译：每收到一个增量 chunk 回调 on_chunk（内容为含 {{N}} 的原文透传）
    /// 返回 (完整译文[已回填], finish_reason, prompt_tokens, completion_tokens)
    ///
    /// v0.6.5 P0 修复：占位符提取（segment::mask）必须在构造请求体**之前**完成。
    /// 修复前原文未经占位符化就发给 LLM，却在收到译文后才 mask 生成 tokens 去校验，
    /// 导致凡含链接/行内代码/代码围栏/图片的段落，译文里根本不可能出现 {{N}}，
    /// validate 恒为 false → 该段判失败保留原文；只有完全无占位符的纯文本段才
    /// 能翻译成功。表现为全文翻译只剩末尾几段（如 TO-DO 后那段）被译出。
    pub async fn translate_stream(
        &self,
        prompt: String,
        source_text: String,
        on_chunk: &(dyn Fn(String) + Send + Sync),
        cancelled: &AtomicBool,
    ) -> Result<TranslateResult, TranslateError> {
        // v0.6.5 P0：占位符化必须在构造请求体之前完成（见函数文档注释）
        let seg = segment::mask(&source_text);
        // max_tokens 按原文长度估算（回填的 URL/代码不计入译文，预算偏保守更安全）
        let max_tokens = estimate_max_tokens(source_text.chars().count());
        // 每次任务均为独立请求：messages 仅 [system, user]，不携带任何历史会话；
        // temperature 低温：翻译为确定性任务，抑制模型自由发挥（省 token 且更稳）
        let body = build_translate_body(
            &self.model,
            &prompt,
            &seg.masked_text,
            max_tokens,
            self.temperature,
        );

        // 流式读取（与对话通道共用同一实现，见 stream_chat_completions）
        let (full, finish, usage) =
            self.stream_chat_completions(body, on_chunk, cancelled).await?;

        // 占位符回填 + 校验（tokens 来自发送前的同一次 mask，索引一一对应）
        let translated = segment::unmask(&full, &seg.tokens);
        let intact = segment::validate(&full, seg.tokens.len());

        Ok(TranslateResult {
            translated,
            placeholders_intact: intact,
            finish_reason: finish,
            prompt_tokens: usage.0,
            completion_tokens: usage.1,
        })
    }

    /// v0.7.5：AI 对话流式（自由指令 + 多轮 messages）
    ///
    /// 与 translate_stream 的差别：
    /// - messages 由调用方给出（system 由 Rust 侧置于最前），支持多轮指代消解
    /// - 不做 .<N> 占位符抽取/回填（对话指令与输出均为自由形态，
    ///   占位符化反而干扰模型；结果由用户显式决定插入，无需防御链）
    /// - max_tokens 固定 CHAT_MAX_TOKENS（自由生成空间），温度抬到 ≥0.3
    /// - placeholders_intact 恒为 true（前端按任务忽略该字段）
    pub async fn chat_stream(
        &self,
        messages: Vec<ChatMessage>,
        on_chunk: &(dyn Fn(String) + Send + Sync),
        cancelled: &AtomicBool,
    ) -> Result<TranslateResult, TranslateError> {
        let body = build_chat_body(
            &self.model,
            &messages,
            CHAT_MAX_TOKENS,
            chat_temperature(self.temperature),
        );
        let (full, finish, usage) =
            self.stream_chat_completions(body, on_chunk, cancelled).await?;

        Ok(TranslateResult {
            translated: full,
            placeholders_intact: true,
            finish_reason: finish,
            prompt_tokens: usage.0,
            completion_tokens: usage.1,
        })
    }

    /// SSE 流式读取公共实现（v0.7.5：由 translate_stream / chat_stream 共用，
    /// 提取前两处各有一份约 80 行的同构循环）
    ///
    /// 返回 (完整增量文本, finish_reason, (prompt_tokens, completion_tokens))。
    /// 空响应 → StreamInterrupted；finish_reason=length → ResponseTruncated
    /// （截断内容禁止写回文档，由调用方按错误码处理）。
    async fn stream_chat_completions(
        &self,
        body: serde_json::Value,
        on_chunk: &(dyn Fn(String) + Send + Sync),
        cancelled: &AtomicBool,
    ) -> Result<(String, String, (u32, u32)), TranslateError> {
        let url = format!("{}/chat/completions", self.base_url.trim_end_matches('/'));
        let resp = shared_client()
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .json(&body)
            .send()
            .await
            .map_err(map_reqwest_err)?;
        let mut resp = check_status(resp).await?;

        // ─── SSE 流读取循环 ───
        let mut full = String::new();
        let mut finish_reason = String::new();
        let mut usage: (u32, u32) = (0, 0);
        let mut buf = String::new();
        let mut done = false;

        while !done {
            if cancelled.load(Ordering::Relaxed) {
                return Err(TranslateError::Cancelled);
            }
            match resp.chunk().await {
                Ok(Some(bytes)) => {
                    buf.push_str(&String::from_utf8_lossy(&bytes));
                    // 按行切分处理完整行
                    while let Some(pos) = buf.find('\n') {
                        let line: String = buf.drain(..=pos).collect();
                        let line = line.trim_end_matches(['\n', '\r']);
                        let Some(data) = strip_data_prefix(line) else {
                            continue; // 非 data 行（注释/空行）直接跳过
                        };
                        let data = data.trim();
                        if data == "[DONE]" {
                            done = true;
                            break;
                        }
                        if let Some(parsed) = parse_sse_data(data) {
                            if let Some(d) = parsed.delta {
                                on_chunk(d.clone());
                                full.push_str(&d);
                            }
                            if let Some(fr) = parsed.finish_reason {
                                finish_reason = fr;
                            }
                            if let Some(u) = parsed.usage {
                                usage = u;
                            }
                        }
                    }
                }
                Ok(None) => break, // 流自然结束（部分端点不发 [DONE]）
                Err(e) => {
                    // 已有部分内容时网络中断：视为流不完整，避免半截译文
                    return Err(map_reqwest_err(e));
                }
            }
        }

        if full.is_empty() {
            return Err(TranslateError::StreamInterrupted);
        }
        // 部分兼容端点不返回 finish_reason：有完整内容即视为正常结束
        let finish = if finish_reason.is_empty() {
            "stop".to_string()
        } else {
            finish_reason
        };
        if finish == "length" {
            return Err(TranslateError::ResponseTruncated);
        }
        Ok((full, finish, usage))
    }
}

/// 组装翻译请求体（纯函数，便于单测断言 messages 顺序/温度/预算）
///
/// v0.7.1 修复：stream_options.include_usage —— OpenAI 官方及多数兼容端点
/// 流式模式默认不返回 usage（token 统计恒为 0）；显式开启后最后一条事件
/// 携带 usage，前端 token 统计对全部端点精确可用（DeepSeek 等默认返回的
/// 端点不受影响，usage 取流中最后一次值）。
pub fn build_translate_body(
    model: &str,
    prompt: &str,
    masked_text: &str,
    max_tokens: u32,
    temperature: f32,
) -> serde_json::Value {
    json!({
        "model": model,
        "stream": true,
        "stream_options": { "include_usage": true },
        "max_tokens": max_tokens,
        // v0.7.3：temperature 由设置透传（不再硬编码 0.1），
        // 兼容 kimi 等仅允许 temperature=1 的厂商
        "temperature": temperature,
        "messages": [
            {"role": "system", "content": prompt},
            {"role": "user", "content": masked_text},
        ],
    })
}

/// 组装 AI 对话请求体（纯函数，便于单测断言角色顺序/温度/预算）
///
/// messages 顺序即入参顺序（前端已把多轮历史按时间序排好），
/// system 由调用方置于首位（见 ai_chat 命令）。
pub fn build_chat_body(
    model: &str,
    messages: &[ChatMessage],
    max_tokens: u32,
    temperature: f32,
) -> serde_json::Value {
    json!({
        "model": model,
        "stream": true,
        "stream_options": { "include_usage": true },
        "max_tokens": max_tokens,
        "temperature": temperature,
        "messages": messages,
    })
}

/// 去除 SSE 行的 "data: " / "data:" 前缀
fn strip_data_prefix(line: &str) -> Option<&str> {
    if let Some(rest) = line.strip_prefix("data: ") {
        Some(rest)
    } else if let Some(rest) = line.strip_prefix("data:") {
        Some(rest)
    } else {
        None
    }
}

/// 分类 reqwest 运输层错误（纯函数，便于单测）。
/// v0.7.3 改进4(D3)：修复原死分支（if/else 两分支同返 Network）。
/// - connect/timeout → Network（连不上服务器，多数短期不可恢复，重试也无益）
/// - 其余运输层错误（TLS/协议/流中途断连）→ StreamInterrupted（传输中断后重试可能成功）
fn classify_reqwest_error(timeout: bool, connect: bool) -> TranslateError {
    if timeout || connect {
        TranslateError::Network
    } else {
        TranslateError::StreamInterrupted
    }
}

/// reqwest 错误 → TranslateError（不含请求头信息）
fn map_reqwest_err(e: reqwest::Error) -> TranslateError {
    classify_reqwest_error(e.is_timeout(), e.is_connect())
}

/// 检查 HTTP 状态；非 2xx 提取厂商 message（仅 message 字段，脱敏）
async fn check_status(resp: reqwest::Response) -> Result<reqwest::Response, TranslateError> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }
    let code = status.as_u16();
    // 尽力提取厂商错误 message；失败仅透出状态码
    let msg = resp
        .text()
        .await
        .ok()
        .and_then(|body| {
            serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| {
                    v.get("error")
                        .and_then(|e| e.get("message"))
                        .and_then(|m| m.as_str())
                        .map(|s| s.to_string())
                })
        })
        .unwrap_or_default();
    // v0.6.3 P2-11：厂商 message 截断至 200 字符——HTML 错误页等超长内容不灌入气泡 UI
    let msg = if msg.chars().count() > 200 {
        msg.chars().take(200).collect::<String>()
    } else {
        msg
    };
    match code {
        401 | 403 => Err(TranslateError::Unauthorized),
        429 => Err(TranslateError::RateLimited),
        _ => Err(TranslateError::ProviderError(code, msg)),
    }
}

// ─── 单元测试 ─────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_sse_normal_delta() {
        let data = r#"{"choices":[{"delta":{"content":"你好"}}]}"#;
        let p = parse_sse_data(data).unwrap();
        assert_eq!(p.delta.as_deref(), Some("你好"));
        assert!(p.finish_reason.is_none());
    }

    #[test]
    fn test_parse_sse_reasoning_content_ignored() {
        // 推理模型：reasoning_content 忽略，仅取 content
        let data = r#"{"choices":[{"delta":{"reasoning_content":"思考中...","content":"译文"}}]}"#;
        let p = parse_sse_data(data).unwrap();
        assert_eq!(p.delta.as_deref(), Some("译文"));
    }

    #[test]
    fn test_parse_sse_finish_reason() {
        let data = r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#;
        let p = parse_sse_data(data).unwrap();
        assert_eq!(p.finish_reason.as_deref(), Some("stop"));
        assert!(p.delta.is_none());
    }

    #[test]
    fn test_parse_sse_finish_reason_length() {
        let data = r#"{"choices":[{"delta":{},"finish_reason":"length"}]}"#;
        let p = parse_sse_data(data).unwrap();
        assert_eq!(p.finish_reason.as_deref(), Some("length"));
    }

    #[test]
    fn test_parse_sse_usage() {
        let data = r#"{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":20}}"#;
        let p = parse_sse_data(data).unwrap();
        assert_eq!(p.usage, Some((10, 20)));
    }

    #[test]
    fn test_parse_sse_bad_json_returns_none() {
        assert!(parse_sse_data("not json").is_none());
        assert!(parse_sse_data("{}").is_none()); // 空事件
        assert!(parse_sse_data(r#"{"choices":[{"delta":{"role":"assistant"}}]}"#).is_none()); // 纯 role chunk
    }

    #[test]
    fn test_parse_sse_null_finish_reason() {
        let data = r#"{"choices":[{"delta":{"content":"x"},"finish_reason":null}]}"#;
        let p = parse_sse_data(data).unwrap();
        assert_eq!(p.delta.as_deref(), Some("x"));
        assert!(p.finish_reason.is_none());
    }

    #[test]
    fn test_strip_data_prefix() {
        assert_eq!(strip_data_prefix("data: {json}"), Some("{json}"));
        assert_eq!(strip_data_prefix("data:{json}"), Some("{json}"));
        assert_eq!(strip_data_prefix("event: ping"), None);
        assert_eq!(strip_data_prefix(""), None);
    }

    #[test]
    fn test_estimate_max_tokens() {
        assert_eq!(estimate_max_tokens(0), 1024);
        assert_eq!(estimate_max_tokens(100), 1024);
        assert_eq!(estimate_max_tokens(1000), 3000);
        assert_eq!(estimate_max_tokens(10000), 8192); // 封顶
    }

    /// v0.7.3 改进4(D3)：stream 途中断连等非 connect/timeout 错误应归
    /// StreamInterrupted 而非 Network（重试可能成功），修复原死分支。
    #[test]
    fn test_classify_reqwest_error() {
        // connect/timeout → Network（连不上服务器）
        assert!(matches!(
            classify_reqwest_error(true, false),
            TranslateError::Network
        ));
        assert!(matches!(
            classify_reqwest_error(false, true),
            TranslateError::Network
        ));
        assert!(matches!(
            classify_reqwest_error(true, true),
            TranslateError::Network
        ));
        // 其余运输层错误（TLS/协议/流中断）→ StreamInterrupted
        assert!(matches!(
            classify_reqwest_error(false, false),
            TranslateError::StreamInterrupted
        ));
    }

    #[test]
    fn test_error_code_string() {
        assert_eq!(TranslateError::Network.to_code_string(), "NETWORK|");
        assert_eq!(TranslateError::Unauthorized.to_code_string(), "AUTH|");
        assert_eq!(TranslateError::RateLimited.to_code_string(), "RATE|");
        assert_eq!(TranslateError::Cancelled.to_code_string(), "CANCELLED");
        assert_eq!(
            TranslateError::ProviderError(500, "boom".into()).to_code_string(),
            "PROVIDER|500|boom"
        );
        assert_eq!(TranslateError::ResponseTruncated.to_code_string(), "TRUNCATED|");
        assert_eq!(TranslateError::StreamInterrupted.to_code_string(), "STREAM|");
    }

    /// v0.6.1 回归测试：TranslateResult 必须序列化为 camelCase，
    /// 否则前端 finishReason/placeholdersIntact 读到 undefined，
    /// 全文翻译段校验全部失败（误报"连接中断"）
    #[test]
    fn test_translate_result_serializes_camel_case() {
        let r = TranslateResult {
            translated: "你好".to_string(),
            placeholders_intact: true,
            finish_reason: "stop".to_string(),
            prompt_tokens: 10,
            completion_tokens: 5,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert!(v.get("translated").is_some());
        assert!(v.get("placeholdersIntact").is_some());
        assert!(v.get("finishReason").is_some());
        assert!(v.get("promptTokens").is_some());
        assert!(v.get("completionTokens").is_some());
        // snake_case 字段不应存在
        assert!(v.get("finish_reason").is_none());
        assert!(v.get("placeholders_intact").is_none());
    }

    // ─── v0.6.5 P0 回归测试：占位符必须在发送前提取 ──────────

    /// 复合片段（标题 + 链接 + 行内代码）：mask 后不含裸 URL/反引号内容，
    /// 且 tokens 可原样回填
    #[test]
    fn test_mask_source_removes_raw_urls_and_inline_code() {
        let src = "# ComfyUI Workflows\n\nA repository for [ComfyUI](https://github.com/comfyanonymous/ComfyUI), see `experiments` dir.";
        let seg = segment::mask(src);
        assert!(!seg.masked_text.contains("https://github.com"));
        assert!(!seg.masked_text.contains("experiments"));
        // 3 个占位符：代码围栏无、行内代码 1、链接 URL 1 → 实际顺序为行内代码先
        assert!(!seg.tokens.is_empty());
        let restored = segment::unmask(&seg.masked_text, &seg.tokens);
        assert_eq!(restored, src);
    }

    /// 忠实保留占位符的译文必须通过校验，且回填后标记 100% 复原
    #[test]
    fn test_validate_accepts_translation_keeping_placeholders() {
        let src = "See [docs](https://doc.rs) and `cargo build` first.";
        let seg = segment::mask(src);
        // 模拟 LLM：只翻译自然语言，占位符原样保留
        let llm = seg
            .masked_text
            .replace("See", "参见")
            .replace("and", "和")
            .replace("first", "首先");
        assert!(segment::validate(&llm, seg.tokens.len()));
        let restored = segment::unmask(&llm, &seg.tokens);
        assert!(restored.contains("https://doc.rs"));
        assert!(restored.contains("`cargo build`"));
    }

    /// 反例（修复前的缺陷）：原文未占位符化就发送时，LLM 输出不含 {{N}}，
    /// 校验必然失败 → 该段被判失败保留原文。这正是"只有无占位符的段能译出"的原因。
    #[test]
    fn test_validate_fails_when_source_not_masked_before_send() {
        let src = "See [docs](https://doc.rs) and `cargo build` first.";
        let seg = segment::mask(src);
        // 修复前发给 LLM 的是原文，译文里自然没有占位符
        let llm = "参见 [文档](https://doc.rs) 和 `cargo build` 首先。";
        assert!(!segment::validate(llm, seg.tokens.len()));
    }

    // ─── v0.7.5：AI 对话请求体与温度 ─────────────────────────

    /// 对话温度下限 0.3：翻译默认 0.1 太死，自由指令需要生成力
    #[test]
    fn test_chat_temperature_floor() {
        assert_eq!(chat_temperature(0.1), 0.3);
        assert_eq!(chat_temperature(0.0), 0.3);
        assert_eq!(chat_temperature(0.3), 0.3);
        // kimi 等仅允许 1 的厂商：不得被压低
        assert_eq!(chat_temperature(1.0), 1.0);
        assert_eq!(chat_temperature(2.0), 2.0);
    }

    /// 对话请求体：messages 顺序原样透传（system 在最前由调用方保证）、
    /// stream/usage/max_tokens/temperature 齐备
    #[test]
    fn test_build_chat_body_assembly() {
        let msgs = vec![
            ChatMessage {
                role: "system".to_string(),
                content: "SYS".to_string(),
            },
            ChatMessage {
                role: "user".to_string(),
                content: "把这段改成表格".to_string(),
            },
            ChatMessage {
                role: "assistant".to_string(),
                content: "| a | b |".to_string(),
            },
            ChatMessage {
                role: "user".to_string(),
                content: "再压缩一半".to_string(),
            },
        ];
        let body = build_chat_body("deepseek-chat", &msgs, CHAT_MAX_TOKENS, 0.3);
        assert_eq!(body["model"], "deepseek-chat");
        assert_eq!(body["stream"], true);
        assert_eq!(body["stream_options"]["include_usage"], true);
        assert_eq!(body["max_tokens"], 4096);
        // f32 → JSON number 存在精度误差（0.3 → 0.30000001），按容差断言
        assert!((body["temperature"].as_f64().unwrap() - 0.3).abs() < 1e-6);
        let arr = body["messages"].as_array().unwrap();
        assert_eq!(arr.len(), 4);
        assert_eq!(arr[0]["role"], "system");
        assert_eq!(arr[1]["role"], "user");
        assert_eq!(arr[2]["role"], "assistant");
        assert_eq!(arr[3]["role"], "user");
        assert_eq!(arr[3]["content"], "再压缩一半");
    }

    /// 翻译请求体保持既有结构（提取 build_translate_body 后不得回归）
    #[test]
    fn test_build_translate_body_assembly() {
        let body = build_translate_body("m", "SYS_PROMPT", "MASKED", 2048, 0.1);
        assert_eq!(body["model"], "m");
        assert_eq!(body["stream"], true);
        assert_eq!(body["max_tokens"], 2048);
        // f32 → JSON number 精度误差，按容差断言
        assert!((body["temperature"].as_f64().unwrap() - 0.1).abs() < 1e-6);
        let arr = body["messages"].as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["role"], "system");
        assert_eq!(arr[0]["content"], "SYS_PROMPT");
        assert_eq!(arr[1]["role"], "user");
        assert_eq!(arr[1]["content"], "MASKED");
    }

    /// ChatMessage 反序列化：前端 camelCase/snake_case 字段名均为 role/content
    #[test]
    fn test_chat_message_deserializes() {
        let m: ChatMessage =
            serde_json::from_str(r#"{"role":"user","content":"hi"}"#).unwrap();
        assert_eq!(m.role, "user");
        assert_eq!(m.content, "hi");
    }
}
