//! AI 双协议请求层（v0.15.0 需求：AI 深度配置）
//!
//! ## 为什么需要这一层
//!
//! 0.14.0 及之前，AI 助手/对话只支持「OpenAI 兼容」一种形态，且请求体里把
//! `max_tokens`、`temperature`、`stream_options.include_usage` 全部写死。这对
//! 主流 OpenAI 端点没问题，但用户明确要求适配 **token plan 类配置**：
//! - 不同端点对「输出上限字段名」要求不同（`max_tokens` vs `max_completion_tokens`）；
//! - 推理类模型往往**不接受** `temperature`，硬发会 400；
//! - 火山方舟 Agent Plan 同时提供 OpenAI 兼容与 **Anthropic Messages** 两种协议，
//!   后者路径是 `/v1/messages`、`system` 在顶层、鉴权头是 `x-api-key`。
//!
//! 因此这里按「显式配置的能力」组装请求，**不按模型名猜**：
//! - `token_field`：二选一，永远不同时发两个字段；
//! - `temperature`：`None` = 不发送（推理档默认省略）；
//! - `reasoning_effort`：仅 openai-chat 且显式配置才发；Anthropic 不做臆测映射。
//!
//! ## 明确不做的事
//!
//! **不做「400 后自动换参数重试」**。识别为「参数不受支持」就自动去掉参数再发一次，
//! 会在用户不知情的情况下产生**重复计费**（第一次请求可能已经产生了 token 消耗）。
//! 正确做法是让配置项显式可调，由用户按端点文档改。
//!
//! ## 与既有 provider.rs 的关系
//!
//! 本模块只负责「组装请求体 / 拼 URL / 判 token 字段」，**不负责**发请求与读 SSE
//! ——那部分继续复用 `provider::OpenAiCompatibleProvider` 的连接池与流式循环，
//! 避免两套 HTTP/SSE 实现漂移。

use serde::{Deserialize, Serialize};

/// 协议类型（与前端 `ApiProtocol` 一一对应）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApiProtocol {
    /// OpenAI 兼容：`POST {base}/chat/completions`
    OpenaiChat,
    /// OpenAI Responses：`POST {base}/responses`
    OpenaiResponses,
    /// Anthropic Messages：`POST {base}/v1/messages`
    AnthropicMessages,
}

impl ApiProtocol {
    /// 解析前端字符串；缺省按 openai-chat（向后兼容旧调用点）
    pub fn parse(value: Option<&str>) -> Result<Self, String> {
        match value.unwrap_or("openai-chat") {
            "openai-chat" => Ok(Self::OpenaiChat),
            "openai-responses" => Ok(Self::OpenaiResponses),
            "anthropic-messages" => Ok(Self::AnthropicMessages),
            other => Err(format!("PROVIDER|400|未知协议: {}", other)),
        }
    }
}

/// 输出上限字段名（二选一，绝不同时出现）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenField {
    MaxTokens,
    MaxCompletionTokens,
}

impl TokenField {
    pub fn parse(value: Option<&str>) -> Self {
        match value.unwrap_or("max_tokens") {
            "max_completion_tokens" => Self::MaxCompletionTokens,
            _ => Self::MaxTokens,
        }
    }
    /// JSON 键名
    pub fn key(self) -> &'static str {
        match self {
            Self::MaxTokens => "max_tokens",
            Self::MaxCompletionTokens => "max_completion_tokens",
        }
    }
}

/// 推理强度（仅 openai-chat 有意义）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningEffort {
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl ReasoningEffort {
    pub fn parse(value: Option<&str>) -> Option<Self> {
        match value?.trim() {
            "" | "off" => None,
            "minimal" => Some(Self::Minimal),
            "low" => Some(Self::Low),
            "medium" => Some(Self::Medium),
            "high" => Some(Self::High),
            "xhigh" => Some(Self::Xhigh),
            "max" => Some(Self::Max),
            // 非法值不静默降级为某个档位，而是当作"未配置"（不发送该参数）
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
        }
    }
}

/// 请求策略（前端 `AiRequestPolicy` 的 Rust 侧形态）
#[derive(Debug, Clone, PartialEq)]
pub struct RequestPolicy {
    pub token_field: TokenField,
    /// `None` = 请求体里**不含** temperature
    pub temperature: Option<f32>,
    /// `None` = 不发送 reasoning_effort
    pub reasoning_effort: Option<ReasoningEffort>,
    pub include_stream_usage: bool,
}

impl Default for RequestPolicy {
    fn default() -> Self {
        Self {
            token_field: TokenField::MaxTokens,
            // 与旧版行为一致：默认不显式指定温度时由调用方给值；这里 None 表示"不发"
            temperature: None,
            reasoning_effort: None,
            include_stream_usage: true,
        }
    }
}

/// 一次 AI 请求的完整描述
#[derive(Debug, Clone)]
pub struct AiRequest {
    pub protocol: ApiProtocol,
    pub base_url: String,
    pub model: String,
    /// 合并后的 system（内置约束 + profile.systemPrompt + 指令后缀）
    pub system: Option<String>,
    /// 历史 + 当前指令（仅 user/assistant，system 已在上方单列）
    pub messages: Vec<ChatMessage>,
    pub max_output_tokens: u32,
    pub policy: RequestPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// 内置约束始终在前，profile.systemPrompt 只能追加，不能覆盖或经 messages 注入。
pub fn merge_system_prompt(base: &str, custom: Option<&str>) -> Option<String> {
    let base = base.trim();
    let custom = custom.map(str::trim).filter(|s| !s.is_empty());
    match (base.is_empty(), custom) {
        (false, Some(custom)) => Some(format!("{}\n\n{}", base, custom)),
        (false, None) => Some(base.to_string()),
        (true, Some(custom)) => Some(custom.to_string()),
        (true, None) => None,
    }
}

// ─── URL 拼装 ────────────────────────────────────────────────

/// 去掉尾部斜杠（`/` 与 `\` 都算，兼容用户粘贴 Windows 风格串）
fn trim_base(base: &str) -> &str {
    base.trim().trim_end_matches(['/', '\\'])
}

/// 是否已以 `/v1` 结尾（避免拼出 `/v1/v1/messages`）
fn ends_with_v1(base: &str) -> bool {
    base.to_ascii_lowercase().ends_with("/v1")
}

/// 组装请求 URL。
///
/// 规则（火山 Agent Plan 是验收样例）：
/// - openai-chat：`{base}/chat/completions`
///   - `https://ark.cn-beijing.volces.com/api/plan/v3` → `.../api/plan/v3/chat/completions`
/// - anthropic-messages：`{base}/v1/messages`
///   - `https://ark.cn-beijing.volces.com/api/plan` → `.../api/plan/v1/messages`
///   - base 已含 `/v1`（如 `https://api.anthropic.com/v1`）→ `.../v1/messages`（不重复）
pub fn endpoint_url(protocol: ApiProtocol, base_url: &str) -> String {
    let base = trim_base(base_url);
    match protocol {
        ApiProtocol::OpenaiChat => format!("{}/chat/completions", base),
        ApiProtocol::OpenaiResponses => format!("{}/responses", base),
        ApiProtocol::AnthropicMessages => {
            if ends_with_v1(base) {
                format!("{}/messages", base)
            } else {
                format!("{}/v1/messages", base)
            }
        }
    }
}

/// 模型列表 URL。Anthropic 与 Messages 一样，base 已含 `/v1` 时不得重复。
pub fn models_url(protocol: ApiProtocol, base_url: &str) -> Option<String> {
    let base = trim_base(base_url);
    match protocol {
        ApiProtocol::OpenaiChat | ApiProtocol::OpenaiResponses => {
            Some(format!("{}/models", base))
        }
        ApiProtocol::AnthropicMessages => Some(if ends_with_v1(base) {
            format!("{}/models", base)
        } else {
            format!("{}/v1/models", base)
        }),
    }
}

/// OpenAI 兼容 base 未以 `/v1` 结尾时的**模型列表兜底候选**。
///
/// 本地运行时（LM Studio / vLLM / llama.cpp server / LocalAI / Ollama）文档基本都写
/// `http://127.0.0.1:PORT/v1`，但用户常只填 `http://127.0.0.1:PORT`；此时主 URL
/// `{base}/models` 会 404。仅当主请求 **404** 时补 `/v1` 再探测一次，
/// 绝不因参数类 400 做「删参重试」（那会带来重复计费风险）。
///
/// **仅用于「获取模型列表」**：模型列表是只读探测，重发无副作用；
/// 对话/测试连接不提供任何兜底（见 `ai_client::send_ai_request`）。
pub fn models_url_fallback(protocol: ApiProtocol, base_url: &str) -> Option<String> {
    let base = trim_base(base_url);
    match protocol {
        ApiProtocol::OpenaiChat | ApiProtocol::OpenaiResponses if !ends_with_v1(base) => {
            Some(format!("{}/v1/models", base))
        }
        _ => None,
    }
}

/// Ollama 原生 API 根路径：OpenAI 兼容 base 通常以 `/v1` 结尾。
pub fn ollama_native_url(base_url: &str, path: &str) -> String {
    let base = trim_base(base_url);
    let root = if ends_with_v1(base) {
        &base[..base.len() - 3]
    } else {
        base
    };
    format!("{}/{}", root, path.trim_start_matches('/'))
}

// ─── 请求体组装 ─────────────────────────────────────────────

/// 组装 OpenAI 兼容请求体。
///
/// 硬约束：
/// - `max_tokens` 与 `max_completion_tokens` **互斥**（同一请求只出现一个）；
/// - `temperature` 为 `None` 时**不写该键**（推理类模型会 400）；
/// - `reasoning_effort` 仅在显式配置时写；
/// - `stream_options` 仅当 `include_stream_usage` 为真时写。
pub fn build_openai_body(req: &AiRequest, stream: bool) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": req.model,
        "stream": stream,
    });
    if stream && req.policy.include_stream_usage {
        body["stream_options"] = serde_json::json!({ "include_usage": true });
    }
    // token 字段二选一
    body[req.policy.token_field.key()] = serde_json::json!(req.max_output_tokens);
    if let Some(t) = req.policy.temperature {
        body["temperature"] = serde_json::json!(t.clamp(0.0, 2.0));
    }
    if let Some(effort) = req.policy.reasoning_effort {
        body["reasoning_effort"] = serde_json::json!(effort.as_str());
    }
    // messages：system 置于最前（若有），其后为历史与当前指令
    let mut messages: Vec<serde_json::Value> = Vec::with_capacity(req.messages.len() + 1);
    if let Some(system) = req.system.as_deref().filter(|s| !s.trim().is_empty()) {
        messages.push(serde_json::json!({"role":"system","content":system}));
    }
    for m in &req.messages {
        messages.push(serde_json::json!({"role":m.role,"content":m.content}));
    }
    body["messages"] = serde_json::Value::Array(messages);
    body
}

/// 组装 OpenAI Responses 请求体。
///
/// Responses 使用 `input` / `instructions` / `max_output_tokens`，推理强度位于
/// `reasoning.effort`；不会误发 Chat Completions 的 token 字段或 stream_options。
pub fn build_openai_responses_body(req: &AiRequest, stream: bool) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": req.model,
        "stream": stream,
        "max_output_tokens": req.max_output_tokens,
    });
    if let Some(system) = req.system.as_deref().filter(|s| !s.trim().is_empty()) {
        body["instructions"] = serde_json::json!(system);
    }
    if let Some(t) = req.policy.temperature {
        body["temperature"] = serde_json::json!(t.clamp(0.0, 2.0));
    }
    if let Some(effort) = req.policy.reasoning_effort {
        body["reasoning"] = serde_json::json!({ "effort": effort.as_str() });
    }
    let input: Vec<serde_json::Value> = req
        .messages
        .iter()
        .filter(|m| m.role != "system" && !m.content.trim().is_empty())
        .map(|m| {
            let assistant = m.role == "assistant";
            serde_json::json!({
                "role": if assistant { "assistant" } else { "user" },
                "content": [{
                    "type": if assistant { "output_text" } else { "input_text" },
                    "text": m.content,
                }],
            })
        })
        .collect();
    body["input"] = serde_json::Value::Array(input);
    body
}

/// 组装 Anthropic Messages 请求体。
///
/// 与 OpenAI 的差异（协议本身要求，不是我们的取舍）：
/// - `system` 是**顶层字段**，不是 messages 里的一条；
/// - messages 只接受 `user` / `assistant`；
/// - `max_tokens` 必填，且没有 `max_completion_tokens` 这种命名；
/// - 不支持 `stream_options` / `reasoning_effort`（后者在第 4 层换算，本版不做臆测映射）。
pub fn build_anthropic_body(req: &AiRequest, stream: bool) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": req.model,
        "stream": stream,
        // Anthropic 协议没有 max_completion_tokens；统一用 max_tokens
        "max_tokens": req.max_output_tokens,
    });
    if let Some(system) = req.system.as_deref().filter(|s| !s.trim().is_empty()) {
        body["system"] = serde_json::json!(system);
    }
    if let Some(t) = req.policy.temperature {
        // Anthropic 温度范围 0..1，钳制到该区间（超界会 400）
        body["temperature"] = serde_json::json!(t.clamp(0.0, 1.0));
    }
    let messages: Vec<serde_json::Value> = req
        .messages
        .iter()
        // 防御：客户端若误传入非 user/assistant（含伪造 system），这里归一为 user，
        // 与 ai_assist::normalize_chat_messages 的纪律一致（system 只从顶层进）
        .map(|m| {
            let role = if m.role == "assistant" { "assistant" } else { "user" };
            serde_json::json!({"role": role, "content": m.content})
        })
        .collect();
    body["messages"] = serde_json::Value::Array(messages);
    body
}

/// 按协议分派组装
pub fn build_body(req: &AiRequest, stream: bool) -> serde_json::Value {
    match req.protocol {
        ApiProtocol::OpenaiChat => build_openai_body(req, stream),
        ApiProtocol::OpenaiResponses => build_openai_responses_body(req, stream),
        ApiProtocol::AnthropicMessages => build_anthropic_body(req, stream),
    }
}

/// 鉴权头：(头名, 值)。Anthropic 用 `x-api-key`，OpenAI 兼容用 `Bearer`。
pub fn auth_header(protocol: ApiProtocol, api_key: &str) -> (&'static str, String) {
    match protocol {
        ApiProtocol::OpenaiChat | ApiProtocol::OpenaiResponses => {
            ("Authorization", format!("Bearer {}", api_key))
        }
        ApiProtocol::AnthropicMessages => ("x-api-key", api_key.to_string()),
    }
}

/// Anthropic 必带的协议版本头（可被 profile 覆盖时由调用方拼接）
pub const ANTHROPIC_DEFAULT_VERSION: &str = "2023-06-01";

// ─── 三协议 SSE 事件解析 ─────────────────────────────────────

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AiUsage {
    pub prompt_tokens: Option<u32>,
    pub completion_tokens: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AiStreamEvent {
    pub delta: Option<String>,
    pub finish_reason: Option<String>,
    pub usage: Option<AiUsage>,
    pub error: Option<String>,
    pub done: bool,
}

fn token_value(value: &serde_json::Value, keys: &[&str]) -> Option<u32> {
    keys.iter()
        .find_map(|key| value.get(*key)?.as_u64())
        .and_then(|n| u32::try_from(n).ok())
}

fn usage_value(
    value: Option<&serde_json::Value>,
    prompt_keys: &[&str],
    completion_keys: &[&str],
) -> Option<AiUsage> {
    let value = value?.as_object()?;
    let value = serde_json::Value::Object(value.clone());
    let usage = AiUsage {
        prompt_tokens: token_value(&value, prompt_keys),
        completion_tokens: token_value(&value, completion_keys),
    };
    (usage.prompt_tokens.is_some() || usage.completion_tokens.is_some()).then_some(usage)
}

fn nested_error(value: &serde_json::Value) -> Option<String> {
    value
        .get("error")
        .and_then(|e| e.get("message").or(Some(e)))
        .and_then(|e| e.as_str())
        .or_else(|| value.get("message").and_then(|m| m.as_str()))
        .map(str::to_string)
}

fn anthropic_finish_reason(reason: &str) -> String {
    match reason {
        "end_turn" | "stop_sequence" | "tool_use" => "stop".to_string(),
        "max_tokens" => "length".to_string(),
        other => other.to_string(),
    }
}

/// 解析一条 SSE `data:` JSON。空事件和坏 JSON 返回 None，协议级 failed 保留错误。
pub fn parse_ai_sse_data(protocol: ApiProtocol, data: &str) -> Option<AiStreamEvent> {
    let value: serde_json::Value = serde_json::from_str(data).ok()?;
    let mut out = AiStreamEvent::default();
    match protocol {
        ApiProtocol::OpenaiChat => {
            if let Some(choice) = value
                .get("choices")
                .and_then(|c| c.as_array())
                .and_then(|a| a.first())
            {
                out.delta = choice
                    .get("delta")
                    .and_then(|d| d.get("content"))
                    .and_then(|c| c.as_str())
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);
                out.finish_reason = choice
                    .get("finish_reason")
                    .and_then(|r| r.as_str())
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);
            }
            out.usage = usage_value(
                value.get("usage"),
                &["prompt_tokens", "input_tokens"],
                &["completion_tokens", "output_tokens"],
            );
        }
        ApiProtocol::OpenaiResponses => {
            match value.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                "response.output_text.delta" => {
                    out.delta = value
                        .get("delta")
                        .and_then(|d| d.as_str())
                        .filter(|s| !s.is_empty())
                        .map(str::to_string);
                }
                "response.completed" | "response.failed" | "response.incomplete" => {
                    let response = value.get("response").unwrap_or(&value);
                    out.done = true;
                    out.usage = usage_value(
                        response.get("usage"),
                        &["input_tokens", "prompt_tokens"],
                        &["output_tokens", "completion_tokens"],
                    );
                    match value.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                        "response.completed" => out.finish_reason = Some("stop".to_string()),
                        "response.failed" => {
                            out.error = nested_error(response)
                                .or_else(|| Some("OpenAI Responses 请求失败".to_string()));
                        }
                        _ => {
                            let reason = response
                                .get("incomplete_details")
                                .and_then(|d| d.get("reason"))
                                .and_then(|r| r.as_str())
                                .unwrap_or("");
                            out.finish_reason = Some(if reason == "max_output_tokens" {
                                "length".to_string()
                            } else {
                                "stop".to_string()
                            });
                        }
                    }
                }
                "error" => {
                    out.done = true;
                    out.error = nested_error(&value)
                        .or_else(|| Some("OpenAI Responses 请求失败".to_string()));
                }
                _ => {}
            }
        }
        ApiProtocol::AnthropicMessages => {
            match value.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                "content_block_delta" => {
                    let delta = value.get("delta")?;
                    if delta.get("type").and_then(|t| t.as_str()) == Some("text_delta") {
                        out.delta = delta
                            .get("text")
                            .and_then(|t| t.as_str())
                            .filter(|s| !s.is_empty())
                            .map(str::to_string);
                    }
                }
                "message_start" => {
                    out.usage = usage_value(
                        value.get("message").and_then(|m| m.get("usage")),
                        &["input_tokens"],
                        &["output_tokens"],
                    );
                }
                "message_delta" => {
                    out.usage = usage_value(
                        value.get("usage"),
                        &["input_tokens"],
                        &["output_tokens"],
                    );
                    out.finish_reason = value
                        .get("delta")
                        .and_then(|d| d.get("stop_reason"))
                        .and_then(|r| r.as_str())
                        .map(anthropic_finish_reason);
                }
                "message_stop" => out.done = true,
                "error" => {
                    out.done = true;
                    out.error = nested_error(&value)
                        .or_else(|| Some("Anthropic Messages 请求失败".to_string()));
                }
                _ => {}
            }
        }
    }
    if out.delta.is_none()
        && out.finish_reason.is_none()
        && out.usage.is_none()
        && out.error.is_none()
        && !out.done
    {
        None
    } else {
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(protocol: ApiProtocol, policy: RequestPolicy) -> AiRequest {
        AiRequest {
            protocol,
            base_url: match protocol {
                ApiProtocol::OpenaiChat => {
                    "https://ark.cn-beijing.volces.com/api/plan/v3".to_string()
                }
                ApiProtocol::OpenaiResponses => "https://api.openai.com/v1".to_string(),
                ApiProtocol::AnthropicMessages => {
                    "https://ark.cn-beijing.volces.com/api/plan".to_string()
                }
            },
            model: "test-model".to_string(),
            system: Some("SYS".to_string()),
            messages: vec![
                ChatMessage { role: "user".into(), content: "hi".into() },
                ChatMessage { role: "assistant".into(), content: "hello".into() },
            ],
            max_output_tokens: 4096,
            policy,
        }
    }

    // ── URL 规则（火山两端点是验收样例） ──────────────────────

    #[test]
    fn openai_url_appends_chat_completions() {
        assert_eq!(
            endpoint_url(ApiProtocol::OpenaiChat, "https://ark.cn-beijing.volces.com/api/plan/v3"),
            "https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions"
        );
        // 尾斜杠不产生双斜杠
        assert_eq!(
            endpoint_url(ApiProtocol::OpenaiChat, "https://x/v1/"),
            "https://x/v1/chat/completions"
        );
    }

    #[test]
    fn anthropic_url_adds_v1_messages_once() {
        // 未带 /v1 的 base（火山 Agent Plan）→ 补 /v1
        assert_eq!(
            endpoint_url(ApiProtocol::AnthropicMessages, "https://ark.cn-beijing.volces.com/api/plan"),
            "https://ark.cn-beijing.volces.com/api/plan/v1/messages"
        );
        // 已带 /v1（官方 anthropic base）→ 不重复
        assert_eq!(
            endpoint_url(ApiProtocol::AnthropicMessages, "https://api.anthropic.com/v1"),
            "https://api.anthropic.com/v1/messages"
        );
    }

    #[test]
    fn models_url_supports_all_protocols_without_duplicate_v1() {
        assert_eq!(
            models_url(ApiProtocol::OpenaiChat, "https://x/v1").as_deref(),
            Some("https://x/v1/models")
        );
        assert_eq!(
            models_url(ApiProtocol::OpenaiResponses, "https://x/v1/").as_deref(),
            Some("https://x/v1/models")
        );
        assert_eq!(
            models_url(ApiProtocol::AnthropicMessages, "https://x/v1").as_deref(),
            Some("https://x/v1/models")
        );
        assert_eq!(
            models_url(ApiProtocol::AnthropicMessages, "https://x").as_deref(),
            Some("https://x/v1/models")
        );
        assert_eq!(
            ollama_native_url("http://127.0.0.1:11434/v1/", "/api/tags"),
            "http://127.0.0.1:11434/api/tags"
        );
    }

    /// v0.15.4 需求 1：本地 OpenAI 兼容运行时用户常只填端口（缺 /v1）。
    ///
    /// 兜底**只在模型列表**提供；对话/测试连接由 `ai_client::send_ai_request` 保证不重发。
    #[test]
    fn models_url_fallback_only_for_openai_compatible_without_v1() {
        assert_eq!(
            models_url_fallback(ApiProtocol::OpenaiChat, "http://127.0.0.1:1234").as_deref(),
            Some("http://127.0.0.1:1234/v1/models")
        );
        // 已带 /v1 → 不重复探测
        assert_eq!(
            models_url_fallback(ApiProtocol::OpenaiChat, "http://127.0.0.1:1234/v1"),
            None
        );
        assert_eq!(
            models_url_fallback(ApiProtocol::OpenaiResponses, "http://127.0.0.1:8000").as_deref(),
            Some("http://127.0.0.1:8000/v1/models")
        );
        // Anthropic 已有自己的 /v1 拼接规则，不需要兜底
        assert_eq!(
            models_url_fallback(ApiProtocol::AnthropicMessages, "https://x"),
            None
        );
    }

    #[test]
    fn openai_responses_url_and_body() {
        let r = req(ApiProtocol::OpenaiResponses, RequestPolicy {
            reasoning_effort: Some(ReasoningEffort::Max),
            temperature: None,
            ..Default::default()
        });
        assert_eq!(endpoint_url(r.protocol, &r.base_url), "https://api.openai.com/v1/responses");
        let body = build_body(&r, true);
        assert_eq!(body["max_output_tokens"], 4096);
        assert_eq!(body["reasoning"]["effort"], "max");
        assert_eq!(body["instructions"], "SYS");
        assert_eq!(body["input"][0]["content"][0]["type"], "input_text");
        assert_eq!(body["input"][1]["content"][0]["type"], "output_text");
        assert!(body.get("messages").is_none());
        assert!(body.get("max_tokens").is_none());
        assert!(body.get("max_completion_tokens").is_none());
        assert!(body.get("stream_options").is_none());
        assert!(body.get("temperature").is_none());
    }

    // ── token 字段互斥（最关键的硬约束） ──────────────────────

    #[test]
    fn token_fields_are_mutually_exclusive() {
        let mut policy = RequestPolicy::default();
        policy.token_field = TokenField::MaxTokens;
        let body = build_openai_body(&req(ApiProtocol::OpenaiChat, policy.clone()), true);
        assert!(body.get("max_tokens").is_some());
        assert!(body.get("max_completion_tokens").is_none());

        policy.token_field = TokenField::MaxCompletionTokens;
        let body = build_openai_body(&req(ApiProtocol::OpenaiChat, policy), true);
        assert!(body.get("max_completion_tokens").is_some());
        assert!(
            body.get("max_tokens").is_none(),
            "两个字段绝不可同时出现（部分端点会 400）"
        );
    }

    #[test]
    fn anthropic_always_uses_max_tokens() {
        // 即便 policy 选了 max_completion_tokens，Anthropic 协议也只有 max_tokens
        let mut policy = RequestPolicy::default();
        policy.token_field = TokenField::MaxCompletionTokens;
        let body = build_anthropic_body(&req(ApiProtocol::AnthropicMessages, policy), true);
        assert_eq!(body["max_tokens"], 4096);
        assert!(body.get("max_completion_tokens").is_none());
    }

    // ── temperature / reasoning ──────────────────────────────

    #[test]
    fn temperature_omitted_when_none() {
        let policy = RequestPolicy { temperature: None, ..Default::default() };
        let body = build_openai_body(&req(ApiProtocol::OpenaiChat, policy), true);
        assert!(
            body.get("temperature").is_none(),
            "None 表示不发送（推理类模型会因 temperature 400）"
        );
    }

    #[test]
    fn temperature_sent_when_configured_and_clamped() {
        let policy = RequestPolicy { temperature: Some(0.4), ..Default::default() };
        let body = build_openai_body(&req(ApiProtocol::OpenaiChat, policy), true);
        assert!((body["temperature"].as_f64().unwrap() - 0.4).abs() < 1e-6);

        // 越界钳制（OpenAI 0..2 / Anthropic 0..1）
        let policy = RequestPolicy { temperature: Some(5.0), ..Default::default() };
        let body = build_openai_body(&req(ApiProtocol::OpenaiChat, policy.clone()), true);
        assert_eq!(body["temperature"], 2.0);
        let abody = build_anthropic_body(&req(ApiProtocol::AnthropicMessages, policy), true);
        assert_eq!(abody["temperature"], 1.0);
    }

    #[test]
    fn reasoning_effort_only_when_configured() {
        let policy = RequestPolicy { reasoning_effort: None, ..Default::default() };
        let body = build_openai_body(&req(ApiProtocol::OpenaiChat, policy), true);
        assert!(body.get("reasoning_effort").is_none());

        let policy = RequestPolicy {
            reasoning_effort: Some(ReasoningEffort::Low),
            ..Default::default()
        };
        let body = build_openai_body(&req(ApiProtocol::OpenaiChat, policy.clone()), true);
        assert_eq!(body["reasoning_effort"], "low");

        // Anthropic 协议不做臆测映射：不发送该参数
        let abody = build_anthropic_body(&req(ApiProtocol::AnthropicMessages, policy), true);
        assert!(abody.get("reasoning_effort").is_none());
    }

    #[test]
    fn invalid_reasoning_effort_parsed_as_none() {
        // 非法档位不静默降级为某个档位，而是当作未配置（不发送）
        assert!(ReasoningEffort::parse(Some("ultra")).is_none());
        assert!(ReasoningEffort::parse(Some("")).is_none());
        assert!(ReasoningEffort::parse(None).is_none());
        assert_eq!(ReasoningEffort::parse(Some("high")), Some(ReasoningEffort::High));
    }

    // ── stream_options ──────────────────────────────────────

    #[test]
    fn stream_usage_toggle() {
        let policy = RequestPolicy { include_stream_usage: true, ..Default::default() };
        let body = build_openai_body(&req(ApiProtocol::OpenaiChat, policy), true);
        assert_eq!(body["stream_options"]["include_usage"], true);

        let policy = RequestPolicy { include_stream_usage: false, ..Default::default() };
        let body = build_openai_body(&req(ApiProtocol::OpenaiChat, policy), true);
        assert!(
            body.get("stream_options").is_none(),
            "关闭时整个键都不写，而不是写 false（部分端点不认 false 形态）"
        );
        // 非流式请求也不带 stream_options
        let policy = RequestPolicy { include_stream_usage: true, ..Default::default() };
        let body = build_openai_body(&req(ApiProtocol::OpenaiChat, policy), false);
        assert!(body.get("stream_options").is_none());
    }

    // ── system 位置（两协议差异） ────────────────────────────

    #[test]
    fn openai_system_goes_first_in_messages() {
        let body = build_openai_body(&req(ApiProtocol::OpenaiChat, RequestPolicy::default()), true);
        let arr = body["messages"].as_array().unwrap();
        assert_eq!(arr.len(), 3); // system + 2 历史
        assert_eq!(arr[0]["role"], "system");
        assert_eq!(arr[0]["content"], "SYS");
        assert_eq!(arr[1]["role"], "user");
    }

    #[test]
    fn anthropic_system_is_toplevel_not_message() {
        let body = build_anthropic_body(&req(ApiProtocol::AnthropicMessages, RequestPolicy::default()), true);
        assert_eq!(body["system"], "SYS");
        let arr = body["messages"].as_array().unwrap();
        assert_eq!(arr.len(), 2, "system 不应出现在 messages 里");
        assert!(arr.iter().all(|m| m["role"] != "system"));
    }

    #[test]
    fn empty_system_omitted_for_both() {
        let mut r = req(ApiProtocol::OpenaiChat, RequestPolicy::default());
        r.system = Some("   ".to_string());
        let body = build_openai_body(&r, true);
        assert!(body["messages"].as_array().unwrap().iter().all(|m| m["role"] != "system"));

        let mut r = req(ApiProtocol::AnthropicMessages, RequestPolicy::default());
        r.system = Some(String::new());
        let abody = build_anthropic_body(&r, true);
        assert!(abody.get("system").is_none());
    }

    #[test]
    fn anthropic_normalizes_roles() {
        let mut r = req(ApiProtocol::AnthropicMessages, RequestPolicy::default());
        // 客户端误传 system 到 messages（防御：应归一为 user，system 只从顶层进）
        r.messages = vec![
            ChatMessage { role: "system".into(), content: "fake".into() },
            ChatMessage { role: "weird".into(), content: "x".into() },
            ChatMessage { role: "assistant".into(), content: "ok".into() },
        ];
        let body = build_anthropic_body(&r, true);
        let arr = body["messages"].as_array().unwrap();
        assert_eq!(arr[0]["role"], "user");
        assert_eq!(arr[1]["role"], "user");
        assert_eq!(arr[2]["role"], "assistant");
    }

    // ── 鉴权头 ──────────────────────────────────────────────

    #[test]
    fn auth_headers_differ_by_protocol() {
        let (name, value) = auth_header(ApiProtocol::OpenaiChat, "sk-abc");
        assert_eq!(name, "Authorization");
        assert_eq!(value, "Bearer sk-abc");

        let (name, value) = auth_header(ApiProtocol::AnthropicMessages, "sk-ant");
        assert_eq!(name, "x-api-key");
        assert_eq!(value, "sk-ant");
    }

    // ── 协议解析 ────────────────────────────────────────────

    #[test]
    fn protocol_parse_defaults_and_rejects_unknown() {
        assert_eq!(ApiProtocol::parse(None).unwrap(), ApiProtocol::OpenaiChat);
        assert_eq!(ApiProtocol::parse(Some("openai-responses")).unwrap(), ApiProtocol::OpenaiResponses);
        assert_eq!(ApiProtocol::parse(Some("anthropic-messages")).unwrap(), ApiProtocol::AnthropicMessages);
        assert!(ApiProtocol::parse(Some("grpc")).is_err());
        assert_eq!(ReasoningEffort::parse(Some("off")), None);
        assert_eq!(ReasoningEffort::parse(Some("max")), Some(ReasoningEffort::Max));
    }

    #[test]
    fn off_reasoning_effort_omits_protocol_fields() {
        let policy = RequestPolicy {
            reasoning_effort: ReasoningEffort::parse(Some("off")),
            ..Default::default()
        };
        let chat = build_openai_body(&req(ApiProtocol::OpenaiChat, policy.clone()), true);
        assert!(chat.get("reasoning_effort").is_none());
        let responses = build_openai_responses_body(
            &req(ApiProtocol::OpenaiResponses, policy),
            true,
        );
        assert!(responses.get("reasoning").is_none());
    }

    #[test]
    fn responses_sse_parses_delta_completion_usage_and_failure() {
        let delta = parse_ai_sse_data(
            ApiProtocol::OpenaiResponses,
            r#"{"type":"response.output_text.delta","delta":"你好"}"#,
        )
        .unwrap();
        assert_eq!(delta.delta.as_deref(), Some("你好"));
        let completed = parse_ai_sse_data(
            ApiProtocol::OpenaiResponses,
            r#"{"type":"response.completed","response":{"usage":{"input_tokens":11,"output_tokens":7}}}"#,
        )
        .unwrap();
        assert!(completed.done);
        assert_eq!(completed.finish_reason.as_deref(), Some("stop"));
        assert_eq!(completed.usage.as_ref().unwrap().prompt_tokens, Some(11));
        assert_eq!(completed.usage.as_ref().unwrap().completion_tokens, Some(7));
        let failed = parse_ai_sse_data(
            ApiProtocol::OpenaiResponses,
            r#"{"type":"response.failed","response":{"error":{"message":"bad request"}}}"#,
        )
        .unwrap();
        assert_eq!(failed.error.as_deref(), Some("bad request"));
    }

    #[test]
    fn anthropic_sse_parses_text_stop_and_partial_usage() {
        let delta = parse_ai_sse_data(
            ApiProtocol::AnthropicMessages,
            r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}"#,
        )
        .unwrap();
        assert_eq!(delta.delta.as_deref(), Some("Hello"));
        let message = parse_ai_sse_data(
            ApiProtocol::AnthropicMessages,
            r#"{"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":19}}"#,
        )
        .unwrap();
        assert_eq!(message.finish_reason.as_deref(), Some("length"));
        assert_eq!(message.usage.unwrap().completion_tokens, Some(19));
        let start = parse_ai_sse_data(
            ApiProtocol::AnthropicMessages,
            r#"{"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}"#,
        )
        .unwrap();
        assert_eq!(start.usage.unwrap().prompt_tokens, Some(5));
    }

    #[test]
    fn openai_usage_only_sse_event_is_not_dropped() {
        let event = parse_ai_sse_data(
            ApiProtocol::OpenaiChat,
            r#"{"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4}}"#,
        )
        .unwrap();
        assert_eq!(event.usage.unwrap().prompt_tokens, Some(3));
    }
}
