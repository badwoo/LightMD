//! 统一 AI HTTP 客户端：OpenAI Chat / OpenAI Responses / Anthropic Messages。
//!
//! 请求只按显式协议与 RequestPolicy 组装一次；非 2xx 直接返回，绝不在 400 后
//! 自动删参或换字段重试。凭据由 credential.rs 解析，本模块只负责选择性附加头。

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use serde_json::Value;

use crate::translate::ai_request::{
    auth_header, build_body, endpoint_url, models_url, ollama_native_url, parse_ai_sse_data,
    AiRequest, AiStreamEvent, ApiProtocol, ANTHROPIC_DEFAULT_VERSION,
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

/// 用 Ollama 原生 details.context_length 补充元数据；没有该字段就保持 None。
pub fn merge_ollama_details(models: &mut [AiModel], payload: &Value) {
    let Some(native_models) = payload.get("models").and_then(|m| m.as_array()) else {
        return;
    };
    for native in native_models {
        let Some(native_id) = string_field(native, &["model", "name", "id"]) else {
            continue;
        };
        let Some(details) = native.get("details") else {
            continue;
        };
        let context = number_field(details, &["context_length", "contextLength"]);
        let min_context = number_field(
            details,
            &[
                "min_context_length",
                "minContextLength",
                "min_context_window_tokens",
            ],
        );
        if context.is_none() && min_context.is_none() {
            continue;
        }
        if let Some(model) = models
            .iter_mut()
            .find(|model| model.id == native_id || model.name == native_id)
        {
            if context.is_some() {
                model.context_window_tokens = context;
            }
            if min_context.is_some() {
                model.min_context_window_tokens = min_context;
            }
        }
    }
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

pub async fn list_models(
    protocol: ApiProtocol,
    provider: &str,
    base_url: &str,
    credential: &Credential,
) -> Result<Vec<AiModel>, TranslateError> {
    let url = models_url(protocol, base_url)
        .ok_or_else(|| TranslateError::ProviderError(400, "协议不支持模型列表".to_string()))?;
    let response = with_protocol_headers(shared_client().get(url), protocol, credential)
        .send()
        .await
        .map_err(map_reqwest_err)?;
    let payload: Value = check_status(response)
        .await?
        .json()
        .await
        .map_err(|_| TranslateError::StreamInterrupted)?;
    let mut models = parse_models_payload(&payload);

    // Ollama 的 OpenAI /models 不含上下文元数据；原生 /api/tags 仅作增强，
    // 失败时保留已取得的模型列表，上下文字段自然缺省。
    if provider.trim().eq_ignore_ascii_case("ollama") {
        let native_url = ollama_native_url(base_url, "/api/tags");
        let native = with_protocol_headers(shared_client().get(native_url), protocol, credential)
            .send()
            .await;
        if let Ok(response) = native {
            if let Ok(response) = check_status(response).await {
                if let Ok(native_payload) = response.json::<Value>().await {
                    merge_ollama_details(&mut models, &native_payload);
                }
            }
        }
    }
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::translate::ai_request::{ChatMessage, RequestPolicy};

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
        merge_ollama_details(
            &mut models,
            &serde_json::json!({
                "models":[{
                    "name":"qwen:latest",
                    "details":{"context_length":131072}
                }]
            }),
        );
        assert_eq!(models[0].context_window_tokens, Some(131072));
        assert_eq!(models[0].min_context_window_tokens, None);
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
