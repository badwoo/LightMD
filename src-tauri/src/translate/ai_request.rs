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
    /// Anthropic Messages：`POST {base}/v1/messages`
    AnthropicMessages,
}

impl ApiProtocol {
    /// 解析前端字符串；缺省按 openai-chat（向后兼容旧调用点）
    pub fn parse(value: Option<&str>) -> Result<Self, String> {
        match value.unwrap_or("openai-chat") {
            "openai-chat" => Ok(Self::OpenaiChat),
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
}

impl ReasoningEffort {
    pub fn parse(value: Option<&str>) -> Option<Self> {
        match value?.trim() {
            "" => None,
            "minimal" => Some(Self::Minimal),
            "low" => Some(Self::Low),
            "medium" => Some(Self::Medium),
            "high" => Some(Self::High),
            "xhigh" => Some(Self::Xhigh),
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
        ApiProtocol::AnthropicMessages => {
            if ends_with_v1(base) {
                format!("{}/messages", base)
            } else {
                format!("{}/v1/messages", base)
            }
        }
    }
}

/// 模型列表 URL（仅 openai-chat 端点通常支持；anthropic 返回 None）
pub fn models_url(protocol: ApiProtocol, base_url: &str) -> Option<String> {
    match protocol {
        ApiProtocol::OpenaiChat => Some(format!("{}/models", trim_base(base_url))),
        // Anthropic 协议没有 `/models` 端点（模型需手填），不构造假 URL
        ApiProtocol::AnthropicMessages => None,
    }
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
        ApiProtocol::AnthropicMessages => build_anthropic_body(req, stream),
    }
}

/// 鉴权头：(头名, 值)。Anthropic 用 `x-api-key`，OpenAI 兼容用 `Bearer`。
pub fn auth_header(protocol: ApiProtocol, api_key: &str) -> (&'static str, String) {
    match protocol {
        ApiProtocol::OpenaiChat => ("Authorization", format!("Bearer {}", api_key)),
        ApiProtocol::AnthropicMessages => ("x-api-key", api_key.to_string()),
    }
}

/// Anthropic 必带的协议版本头（可被 profile 覆盖时由调用方拼接）
pub const ANTHROPIC_DEFAULT_VERSION: &str = "2023-06-01";

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
    fn models_url_only_for_openai() {
        assert_eq!(
            models_url(ApiProtocol::OpenaiChat, "https://x/v1").as_deref(),
            Some("https://x/v1/models")
        );
        // Anthropic 协议没有 /models，不构造假 URL
        assert!(models_url(ApiProtocol::AnthropicMessages, "https://x/v1").is_none());
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
        assert_eq!(ApiProtocol::parse(Some("anthropic-messages")).unwrap(), ApiProtocol::AnthropicMessages);
        assert!(ApiProtocol::parse(Some("grpc")).is_err());
    }
}
