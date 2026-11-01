//! 统一 AI HTTP 客户端：OpenAI Chat / OpenAI Responses / Anthropic Messages。
//!
//! 请求只按显式协议与 RequestPolicy 组装一次；非 2xx 直接返回，绝不在 400 后
//! 自动删参或换字段重试。凭据由 credential.rs 解析，本模块只负责选择性附加头。

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use serde_json::Value;

use crate::translate::ai_request::{
    auth_header, build_body, endpoint_url, models_url, models_url_fallback, ollama_native_url,
    parse_ai_sse_data, AiRequest, AiStreamEvent, ApiProtocol, ANTHROPIC_DEFAULT_VERSION,
};
use crate::translate::credential::{authorization_header, AuthMode, Credential};
use crate::translate::provider::{
    check_status, map_reqwest_err, shared_client, TranslateError, TranslateResult,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModel {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_context_window_tokens: Option<u64>,
}

fn number_field(value: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter().find_map(|key| {
        let value = value.get(*key)?;
        value
            .as_u64()
            .or_else(|| value.as_str()?.trim().parse().ok())
    })
}

fn string_field<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| value.get(*key)?.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn model_from_value(value: &Value) -> Option<AiModel> {
    let id = string_field(value, &["id", "model", "name"])?.to_string();
    let name = string_field(
        value,
        &["display_name", "displayName", "name", "model", "id"],
    )
    .unwrap_or(&id)
    .to_string();
    Some(AiModel {
        id,
        name,
        context_window_tokens: number_field(
            value,
            &[
                "context_window_tokens",
                "contextWindowTokens",
                "context_length",
                "contextLength",
                "context_window",
                "contextWindow",
            ],
        ),
        min_context_window_tokens: number_field(
            value,
            &[
                "min_context_window_tokens",
                "minContextWindowTokens",
                "min_context_length",
                "minContextLength",
            ],
        ),
    })
}

/// OpenAI 与 Anthropic 都使用顶层 data；同时接受 Ollama 原生 models 便于纯函数测试。
pub fn parse_models_payload(payload: &Value) -> Vec<AiModel> {
    let mut models: Vec<AiModel> = payload
        .get("data")
        .or_else(|| payload.get("models"))
        .and_then(|items| items.as_array())
        .into_iter()
        .flatten()
        .filter_map(model_from_value)
        .collect();
    models.sort_by(|a, b| a.id.cmp(&b.id));
    models.dedup_by(|a, b| a.id == b.id);
    models
}

/// 用 Ollama 原生 /api/tags 响应构造模型条目：id 取 `model`（退回 `name`），
/// 上下文来自 `details.context_length`。原生接口本身就是「本机已安装的全部模型」，
/// 因此它不仅能补元数据，还能补齐 /v1/models 漏掉的条目（如 embedding 模型）。
pub fn parse_ollama_tags_payload(payload: &Value) -> Vec<AiModel> {
    let mut models: Vec<AiModel> = payload
        .get("models")
        .and_then(|items| items.as_array())
        .into_iter()
        .flatten()
        .filter_map(|native| {
            let id = string_field(native, &["model", "name", "id"])?.to_string();
            let name = string_field(native, &["name", "model", "id"])
                .unwrap_or(&id)
                .to_string();
            let details = native.get("details");
            Some(AiModel {
                id,
                name,
                context_window_tokens: details.and_then(|details| {
                    number_field(details, &["context_length", "contextLength"])
                }),
                min_context_window_tokens: details.and_then(|details| {
                    number_field(
                        details,
                        &[
                            "min_context_length",
                            "minContextLength",
                            "min_context_window_tokens",
                        ],
                    )
                }),
            })
        })
        .collect();
    models.sort_by(|a, b| a.id.cmp(&b.id));
    models.dedup_by(|a, b| a.id == b.id);
    models
}

/// 按 id 求并集：两端各有的模型都要出现，同 id 只补缺失元数据、不覆盖已有显示名。
pub fn union_models(models: &mut Vec<AiModel>, extra: Vec<AiModel>) {
    for candidate in extra {
        match models.iter_mut().find(|model| model.id == candidate.id) {
            Some(existing) => {
                if existing.context_window_tokens.is_none() {
                    existing.context_window_tokens = candidate.context_window_tokens;
                }
                if existing.min_context_window_tokens.is_none() {
                    existing.min_context_window_tokens = candidate.min_context_window_tokens;
                }
            }
            None => models.push(candidate),
        }
    }
    models.sort_by(|a, b| a.id.cmp(&b.id));
    models.dedup_by(|a, b| a.id == b.id);
}

/// 宽容判定「这个端点就是本机 Ollama」：显式 localKind=ollama / provider=ollama /
/// 标准 11434 端口。只按端点特征识别，不从模型名猜测能力。
fn looks_like_ollama(provider: &str, base_url: &str, local_kind: Option<&str>) -> bool {
    if local_kind
        .map(|kind| kind.trim().eq_ignore_ascii_case("ollama"))
        .unwrap_or(false)
    {
        return true;
    }
    if provider.trim().eq_ignore_ascii_case("ollama") {
        return true;
    }
    base_url.trim().to_ascii_lowercase().contains(":11434")
}


fn with_protocol_headers(
    mut builder: reqwest::RequestBuilder,
    protocol: ApiProtocol,
    credential: &Credential,
) -> reqwest::RequestBuilder {
    if credential.auth_mode != AuthMode::None {
        if let Some(key) = credential
            .api_key
            .as_deref()
            .filter(|key| !key.trim().is_empty())
        {
            match protocol {
                ApiProtocol::AnthropicMessages => {
                    let (name, value) = auth_header(protocol, key);
                    builder = builder.header(name, value);
                }
                ApiProtocol::OpenaiChat | ApiProtocol::OpenaiResponses => {
                    if let Some(value) = authorization_header(credential) {
                        builder = builder.header("Authorization", value);
                    }
                }
            }
        }
    }
    if protocol == ApiProtocol::AnthropicMessages {
        builder = builder.header("anthropic-version", ANTHROPIC_DEFAULT_VERSION);
    }
    builder
}

/// 发送一次 AI 请求。
///
/// **绝不重发**：这里不做任何「换 URL / 删参 / 换字段」的二次发送。
/// 404 也不兜底——对话与测试连接拿到 404 就原样报错，由用户核对端点
/// （本地运行时的 `/v1` 兜底只在「获取模型列表」路径提供，见 `list_models`）。
/// 理由：对话请求一旦发出就可能已产生 token 消耗，重发有重复计费风险。
async fn send_ai_request(
    request: &AiRequest,
    credential: &Credential,
    stream: bool,
) -> Result<reqwest::Response, TranslateError> {
    let response = with_protocol_headers(
        shared_client().post(endpoint_url(request.protocol, &request.base_url)),
        request.protocol,
        credential,
    )
    .json(&build_body(request, stream))
    .send()
    .await
    .map_err(map_reqwest_err)?;
    check_status(response).await
}

#[derive(Default)]
struct SseState {
    full: String,
    finish_reason: String,
    prompt_tokens: u32,
    completion_tokens: u32,
    done: bool,
}

impl SseState {
    fn apply(&mut self, event: AiStreamEvent, on_chunk: &(dyn Fn(String) + Send + Sync)) {
        if let Some(delta) = event.delta {
            on_chunk(delta.clone());
            self.full.push_str(&delta);
        }
        if let Some(reason) = event.finish_reason {
            self.finish_reason = reason;
        }
        if let Some(usage) = event.usage {
            if let Some(value) = usage.prompt_tokens {
                self.prompt_tokens = value;
            }
            if let Some(value) = usage.completion_tokens {
                self.completion_tokens = value;
            }
        }
        if event.done {
            self.done = true;
        }
    }

    fn consume_line(
        &mut self,
        protocol: ApiProtocol,
        line: &str,
        on_chunk: &(dyn Fn(String) + Send + Sync),
    ) -> Result<(), TranslateError> {
        let line = line.trim_end_matches(['\n', '\r']);
        let Some(data) = line
            .strip_prefix("data: ")
            .or_else(|| line.strip_prefix("data:"))
        else {
            return Ok(());
        };
        let data = data.trim();
        if data == "[DONE]" {
            self.done = true;
            return Ok(());
        }
        if let Some(event) = parse_ai_sse_data(protocol, data) {
            if let Some(error) = event.error.clone() {
                return Err(TranslateError::ProviderError(200, error));
            }
            self.apply(event, on_chunk);
        }
        Ok(())
    }
}

pub async fn stream_ai_request(
    request: &AiRequest,
    credential: &Credential,
    on_chunk: &(dyn Fn(String) + Send + Sync),
    cancelled: &AtomicBool,
) -> Result<TranslateResult, TranslateError> {
    let mut response = send_ai_request(request, credential, true).await?;
    let mut state = SseState::default();
    // 按字节缓冲完整行，避免多字节 UTF-8 字符跨 TCP chunk 时被 lossy 解码破坏。
    let mut buffer = Vec::<u8>::new();
    while !state.done {
        if cancelled.load(Ordering::Relaxed) {
            return Err(TranslateError::Cancelled);
        }
        match response.chunk().await {
            Ok(Some(bytes)) => {
                buffer.extend_from_slice(&bytes);
                while let Some(pos) = buffer.iter().position(|byte| *byte == b'\n') {
                    let line: Vec<u8> = buffer.drain(..=pos).collect();
                    state.consume_line(
                        request.protocol,
                        &String::from_utf8_lossy(&line),
                        on_chunk,
                    )?;
                    if state.done {
                        break;
                    }
                }
            }
            Ok(None) => break,
            Err(error) => return Err(map_reqwest_err(error)),
        }
    }
    if !state.done && !buffer.is_empty() {
        state.consume_line(
            request.protocol,
            &String::from_utf8_lossy(&buffer),
            on_chunk,
        )?;
    }
    if state.full.is_empty() {
        return Err(TranslateError::StreamInterrupted);
    }
    let finish_reason = if state.finish_reason.is_empty() {
        "stop".to_string()
    } else {
        state.finish_reason
    };
    if finish_reason == "length" {
        return Err(TranslateError::ResponseTruncated);
    }
    Ok(TranslateResult {
        translated: state.full,
        placeholders_intact: true,
        finish_reason,
        prompt_tokens: state.prompt_tokens,
        completion_tokens: state.completion_tokens,
    })
}

/// 最小非流式请求：只验证状态码，不解析或二次改写请求体。
pub async fn test_ai_request(
    request: &AiRequest,
    credential: &Credential,
) -> Result<(), TranslateError> {
    send_ai_request(request, credential, false).await?;
    Ok(())
}

async fn fetch_models_payload(
    protocol: ApiProtocol,
    url: &str,
    credential: &Credential,
) -> Result<Value, TranslateError> {
    let response = with_protocol_headers(shared_client().get(url), protocol, credential)
        .send()
        .await
        .map_err(map_reqwest_err)?;
    check_status(response)
        .await?
        .json()
        .await
        .map_err(|_| TranslateError::StreamInterrupted)
}

/// 主 URL 是否值得用 `/v1` 兜底：只有 404（端点不存在）才算「路径写少了」。
/// 401/403/429/其它 4xx/5xx 一律不透支兜底，避免把鉴权或限流错误伪装成「模型列表为空」。
fn should_probe_v1_fallback(error: &TranslateError) -> bool {
    match error {
        TranslateError::ProviderError(404, _) => true,
        _ => false,
    }
}

/// 拉取模型目录（**唯一允许 URL 兜底的路径**）。
///
/// 三条规则（都是用户实测踩出来的，不按模型名猜）：
/// 1. 主 URL **404** 且 base 未带 `/v1` 时，用 `{base}/v1/models` 兜底探测一次
///    （LM Studio / vLLM / llama.cpp server 的文档端点都是 `/v1`，用户常只填端口）；
///    仅限 404——401/403/429/5xx 直接原样报错，不把鉴权/限流错误伪装成「没有模型」；
/// 2. 端点像 Ollama 时，额外拉原生 `/api/tags` 并**按 id 求并集**：
///    `/v1/models` 常漏掉 embedding 类模型、且完全没有上下文元数据；
/// 3. `/v1/models` 完全失败但 `/api/tags` 成功时，以原生结果作为返回值
///    （Ollama 原生接口可用就说明本机在跑，没必要因 OpenAI 兼容层未开而报错）。
///
/// 模型列表是只读探测，因此这里允许兜底重发；对话/测试连接**一律不重发**。
pub async fn list_models(
    protocol: ApiProtocol,
    provider: &str,
    base_url: &str,
    credential: &Credential,
    local_kind: Option<&str>,
) -> Result<Vec<AiModel>, TranslateError> {
    let url = models_url(protocol, base_url)
        .ok_or_else(|| TranslateError::ProviderError(400, "协议不支持模型列表".to_string()))?;
    let mut primary_error: Option<TranslateError> = None;
    let mut models: Vec<AiModel> = Vec::new();

    match fetch_models_payload(protocol, &url, credential).await {
        Ok(payload) => models = parse_models_payload(&payload),
        Err(error) => {
            let fallback = if should_probe_v1_fallback(&error) {
                models_url_fallback(protocol, base_url)
            } else {
                None
            };
            match fallback {
                Some(fallback_url) => match fetch_models_payload(protocol, &fallback_url, credential).await {
                    Ok(payload) => models = parse_models_payload(&payload),
                    Err(_) => primary_error = Some(error),
                },
                None => primary_error = Some(error),
            }
        }
    }

    if looks_like_ollama(provider, base_url, local_kind) {
        let native_url = ollama_native_url(base_url, "/api/tags");
        if let Ok(native_payload) = fetch_models_payload(protocol, &native_url, credential).await {
            // 原生接口失败时不报错：能拿到的部分列表优先，上下文字段自然缺省。
            union_models(&mut models, parse_ollama_tags_payload(&native_payload));
            primary_error = None;
        }
    }

    match primary_error {
        Some(error) => Err(error),
        None => Ok(models),
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::translate::ai_request::{ChatMessage, RequestPolicy};

    #[test]
    fn v1_fallback_is_probed_only_on_404() {
        // 只有「端点不存在」值得换 URL；鉴权/限流/服务端错误必须原样抛出。
        assert!(should_probe_v1_fallback(&TranslateError::ProviderError(
            404,
            "not found".into()
        )));
        assert!(!should_probe_v1_fallback(&TranslateError::ProviderError(
            401,
            "unauthorized".into()
        )));
        assert!(!should_probe_v1_fallback(&TranslateError::ProviderError(
            400,
            "bad request".into()
        )));
        assert!(!should_probe_v1_fallback(&TranslateError::ProviderError(
            429,
            "rate limited".into()
        )));
        assert!(!should_probe_v1_fallback(&TranslateError::ProviderError(
            500,
            "server error".into()
        )));
        assert!(!should_probe_v1_fallback(&TranslateError::Network));
        assert!(!should_probe_v1_fallback(&TranslateError::RateLimited));
    }

    #[test]
    fn model_dto_uses_camel_case_and_omits_unknown_context() {
        let models = parse_models_payload(&serde_json::json!({
            "data": [
                {"id":"b", "context_window_tokens":65536, "min_context_window_tokens":4096},
                {"id":"a", "display_name":"Model A"}
            ]
        }));
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].name, "Model A");
        assert_eq!(models[1].context_window_tokens, Some(65536));
        assert_eq!(models[1].min_context_window_tokens, Some(4096));
        let unknown = serde_json::to_value(&models[0]).unwrap();
        assert!(unknown.get("contextWindowTokens").is_none());
        assert!(unknown.get("minContextWindowTokens").is_none());
        let known = serde_json::to_value(&models[1]).unwrap();
        assert_eq!(known["contextWindowTokens"], 65536);
        assert_eq!(known["minContextWindowTokens"], 4096);
    }

    #[test]
    fn ollama_details_enrich_without_model_name_guessing() {
        let mut models = parse_models_payload(&serde_json::json!({
            "data":[{"id":"qwen:latest"}]
        }));
        union_models(
            &mut models,
            parse_ollama_tags_payload(&serde_json::json!({
                "models":[{
                    "name":"qwen:latest",
                    "details":{"context_length":131072}
                }]
            })),
        );
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].context_window_tokens, Some(131072));
        assert_eq!(models[0].min_context_window_tokens, None);
    }

    /// v0.15.4 需求 2：ollama 必须返回本机全部模型。
    /// 真机数据：/v1/models 只有 4 条且无上下文；/api/tags 有 details.context_length。
    #[test]
    fn ollama_union_returns_every_installed_model_with_context() {
        let mut models = parse_models_payload(&serde_json::json!({
            "object":"list",
            "data":[
                {"id":"qwen3-vl:8b-instruct","object":"model"},
                {"id":"qwen3-vl:8b","object":"model"}
            ]
        }));
        union_models(
            &mut models,
            parse_ollama_tags_payload(&serde_json::json!({
                "models":[
                    {"name":"qwen3-vl:8b-instruct","model":"qwen3-vl:8b-instruct",
                     "details":{"context_length":262144}},
                    {"name":"qwen3-vl:8b","model":"qwen3-vl:8b",
                     "details":{"context_length":262144}},
                    {"name":"guoxuter/ov_intent_analysis_sft:v7_q8",
                     "model":"guoxuter/ov_intent_analysis_sft:v7_q8",
                     "details":{"context_length":262144}},
                    {"name":"bge-m3:latest","model":"bge-m3:latest",
                     "details":{"context_length":8192}}
                ]
            })),
        );
        let ids: Vec<&str> = models.iter().map(|model| model.id.as_str()).collect();
        assert_eq!(ids.len(), 4, "必须按 id 求并集，不能只增强已有条目");
        assert!(ids.contains(&"bge-m3:latest"), "/v1/models 漏掉的条目也要补上");
        assert!(ids.contains(&"guoxuter/ov_intent_analysis_sft:v7_q8"));
        let vl = models.iter().find(|m| m.id == "qwen3-vl:8b").unwrap();
        assert_eq!(vl.context_window_tokens, Some(262144));
        let embedding = models.iter().find(|m| m.id == "bge-m3:latest").unwrap();
        assert_eq!(embedding.context_window_tokens, Some(8192));
        // 已有条目的显示名不被原生接口覆盖
        assert_eq!(models.iter().find(|m| m.id == "qwen3-vl:8b").unwrap().name, "qwen3-vl:8b");
    }

    #[test]
    fn ollama_tags_payload_is_tolerated_when_v1_list_is_empty() {
        let mut models: Vec<AiModel> = Vec::new();
        union_models(
            &mut models,
            parse_ollama_tags_payload(&serde_json::json!({
                "models":[
                    {"name":"bge-m3:latest","details":{"context_length":8192}},
                    {"model":"qwen3-vl:8b"}
                ]
            })),
        );
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "bge-m3:latest");
        assert_eq!(models[0].context_window_tokens, Some(8192));
        assert_eq!(models[1].id, "qwen3-vl:8b");
        assert_eq!(models[1].context_window_tokens, None);
    }

    #[test]
    fn ollama_detection_uses_explicit_kind_or_standard_port() {
        assert!(looks_like_ollama("ollama", "http://x/v1", None));
        assert!(looks_like_ollama("acme", "http://127.0.0.1:11434/v1", None));
        assert!(looks_like_ollama("acme", "http://127.0.0.1:11434/v1", Some("OLLAMA")));
        assert!(!looks_like_ollama("acme", "http://127.0.0.1:1234/v1", None));
    }

    #[test]
    fn no_key_or_auth_none_emits_no_authorization() {
        let optional = Credential {
            api_key: None,
            auth_mode: AuthMode::Optional,
        };
        let request = with_protocol_headers(
            shared_client().get("http://127.0.0.1/models"),
            ApiProtocol::OpenaiChat,
            &optional,
        )
        .build()
        .unwrap();
        assert!(request.headers().get("Authorization").is_none());

        let none = Credential {
            api_key: Some("must-not-send".into()),
            auth_mode: AuthMode::None,
        };
        let request = with_protocol_headers(
            shared_client().get("http://127.0.0.1/models"),
            ApiProtocol::AnthropicMessages,
            &none,
        )
        .build()
        .unwrap();
        assert!(request.headers().get("Authorization").is_none());
        assert!(request.headers().get("x-api-key").is_none());
        assert_eq!(
            request.headers().get("anthropic-version").unwrap(),
            ANTHROPIC_DEFAULT_VERSION
        );
    }

    #[test]
    fn sse_state_merges_partial_usage_and_text() {
        let mut state = SseState::default();
        let chunks = std::sync::Mutex::new(Vec::new());
        let on_chunk = |chunk| chunks.lock().unwrap().push(chunk);
        state
            .consume_line(
                ApiProtocol::AnthropicMessages,
                r#"data: {"type":"message_start","message":{"usage":{"input_tokens":8}}}"#,
                &on_chunk,
            )
            .unwrap();
        state
            .consume_line(
                ApiProtocol::AnthropicMessages,
                r#"data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}"#,
                &on_chunk,
            )
            .unwrap();
        state
            .consume_line(
                ApiProtocol::AnthropicMessages,
                r#"data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}"#,
                &on_chunk,
            )
            .unwrap();
        assert_eq!(state.full, "ok");
        assert_eq!(state.prompt_tokens, 8);
        assert_eq!(state.completion_tokens, 2);
        assert_eq!(*chunks.lock().unwrap(), vec!["ok"]);
    }

    #[test]
    fn minimal_request_helper_uses_one_token() {
        let request = AiRequest {
            protocol: ApiProtocol::OpenaiResponses,
            base_url: "http://localhost/v1".into(),
            model: "m".into(),
            system: None,
            messages: vec![ChatMessage {
                role: "user".into(),
                content: "hi".into(),
            }],
            max_output_tokens: 1,
            policy: RequestPolicy::default(),
        };
        let body = build_body(&request, false);
        assert_eq!(body["stream"], false);
        assert_eq!(body["max_output_tokens"], 1);
        assert_eq!(body["input"][0]["content"][0]["text"], "hi");
    }
}
