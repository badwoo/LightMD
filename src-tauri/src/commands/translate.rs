//! AI 翻译 Tauri 命令层（v0.6.0）
//!
//! 命令清单：
//! - translate_text：选中翻译（流式 Channel 推送，单任务模型）
//! - cancel_translate：中断进行中的任务
//! - test_translate_connection：1-token 最小请求验证 Key
//! - set_translate_key / has_translate_key：keyring Key 写入/存在性检查
//!   （v0.7.2 P1：按 provider 参数独立存取，切换厂商不再互相覆盖）
//! - list_translate_models：动态拉取厂商模型列表（v0.7.2 P2）
//!
//! 安全约定：API Key 仅存于系统凭据管理器（keyring），
//! 前端永远拿不到明文（has_translate_key 只回布尔值）。
//! 配置（base_url/model/语言/语体）由前端设置 store 持有，经参数传入。

use tauri::ipc::Channel;
use tauri::State;

use crate::translate::ai_client::stream_ai_request;
use crate::translate::ai_request::{
    merge_system_prompt, AiRequest, ApiProtocol, ChatMessage as AiChatMessage, ReasoningEffort,
    RequestPolicy, TokenField,
};
use crate::translate::credential::{resolve_credential_with, AuthMode, Credential};
use crate::translate::prompt::build_prompt;
use crate::translate::provider::{
    estimate_max_tokens, OpenAiCompatibleProvider, TranslateError, TranslateResult,
};
use crate::translate::segment;
use crate::translate::TranslateState;

/// keyring 条目（Windows 凭据管理器）
const KEYRING_SERVICE: &str = "LightMD";
/// v0.7.2 P1 之前的全局单 Key 条目（保留作兼容回退：升级后老 Key 仍可读）
const KEYRING_LEGACY_ACCOUNT: &str = "translate_api_key";

/// v0.7.2 P1：按厂商独立存 Key。
/// account 形如 `translate_api_key::deepseek`；provider 名做白名单清洗
/// （仅字母数字-_），空/异常值落回 custom 槽，防止凭据管理器出现乱码条目。
fn sanitize_provider(provider: &str) -> String {
    let p: String = provider
        .trim()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if p.is_empty() { "custom".to_string() } else { p }
}

fn keyring_entry(provider: &str) -> Result<keyring::Entry, String> {
    let account = format!("translate_api_key::{}", sanitize_provider(provider));
    keyring::Entry::new(KEYRING_SERVICE, &account)
        .map_err(|e| format!("AUTH|凭据管理器不可用: {}", e))
}

/// v0.15.0：profile.id 独立槽位，与旧 provider 槽位分开，防止同 provider 双端点串 Key。
fn profile_keyring_entry(credential_id: &str) -> Result<keyring::Entry, String> {
    let account = format!("ai_credential::{}", sanitize_provider(credential_id));
    keyring::Entry::new(KEYRING_SERVICE, &account)
        .map_err(|e| format!("AUTH|凭据管理器不可用: {}", e))
}

fn legacy_keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_LEGACY_ACCOUNT)
        .map_err(|e| format!("AUTH|凭据管理器不可用: {}", e))
}

/// 读取单个 keyring 条目：NoEntry → None（调用方回退/报 NO_KEY），其余错误转 AUTH 码
fn entry_password(entry: keyring::Entry) -> Result<Option<String>, String> {
    match entry.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("AUTH|凭据读取失败: {}", e)),
    }
}

/// 读取 API Key（v0.7.2 P1：按 provider 读取独立条目）：
/// - keyring 操作是阻塞调用，用 spawn_blocking 包裹，避免占住 async runtime 工作线程
/// - Key 未配置（NoEntry）产出 NO_KEY 码，与 AUTH（Key 无效/凭据管理器故障）区分
/// - 兼容回退：provider 条目不存在时读 v0.7.2 及之前的全局条目
///   （升级后老 Key 无需重填；用户为该厂商保存新 Key 后即固化到独立条目）
/// - v0.7.0：改为 pub(crate)，AI 助手命令（ai_assist.rs）复用（一个 Key 服务全部 AI 功能）
fn read_legacy_api_key(provider: &str) -> Result<Option<String>, String> {
    if let Some(key) = keyring_entry(provider).and_then(entry_password)? {
        return Ok(Some(key));
    }
    legacy_keyring_entry().and_then(entry_password)
}

pub(crate) async fn read_api_key(provider: &str) -> Result<String, String> {
    let provider = sanitize_provider(provider);
    tauri::async_runtime::spawn_blocking(move || {
        read_legacy_api_key(&provider)?.ok_or_else(|| "NO_KEY|未设置 API Key".to_string())
    })
    .await
    .map_err(|e| format!("AUTH|{}", e))?
}

/// AI profile 凭据：优先 ai_credential::{credentialId}，未命中才回退旧 provider 槽。
/// 旧调用没有 credentialId 时直接走旧槽；none 完全不读 Key，也不会发认证头。
pub(crate) async fn read_ai_credential(
    credential_id: Option<String>,
    provider: String,
    auth_mode: AuthMode,
) -> Result<Credential, String> {
    if auth_mode == AuthMode::None {
        return Ok(Credential { api_key: None, auth_mode });
    }
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(id) = credential_id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
            return resolve_credential_with(
                id,
                Some(&provider),
                auth_mode,
                |id| profile_keyring_entry(id).and_then(entry_password),
                read_legacy_api_key,
            );
        }
        let api_key = read_legacy_api_key(&provider)?.and_then(|key| {
            let key = key.trim();
            (!key.is_empty()).then(|| key.to_string())
        });
        if auth_mode == AuthMode::Required && api_key.is_none() {
            return Err("NO_KEY|未设置 API Key".to_string());
        }
        Ok(Credential { api_key, auth_mode })
    })
    .await
    .map_err(|e| format!("AUTH|{}", e))?
}

/// 选中翻译（流式）：text 为 markdown 片段（edit/split）或纯文本（preview）
///
/// 单任务模型（v0.9.0 起按窗口分桶）：**同一窗口内**新任务自动取消旧任务，
/// 不同窗口的任务互不影响。
/// on_chunk 推送增量译文（含 {{N}} 占位符原样透传）。
///
/// v0.7.3 改进9(P4-2)：新增 concurrent_id 参数——全文翻译并发批量调用时传入，
///   注册为独立的并发任务槽位（与其他并发任务互不取消）；缺省（None）保持
///   原有的单任务互斥语义（选中翻译 / AI 助手）。
#[tauri::command]
pub async fn translate_text(
    state: State<'_, TranslateState>,
    text: String,
    provider: String,
    base_url: String,
    model: String,
    target_lang: String,
    tone: String,
    custom_prompt: Option<String>,
    // Option 同时兼容旧数值调用与 profile「不发送 temperature」配置。
    temperature: Option<f32>,
    // v0.15.3：以下均为可选，缺省保持旧 OpenAI Chat 行为。
    credential_id: Option<String>,
    protocol: Option<String>,
    context_window_tokens: Option<u32>,
    max_output_tokens: Option<u32>,
    token_field: Option<String>,
    reasoning_effort: Option<String>,
    include_stream_usage: Option<bool>,
    system_prompt: Option<String>,
    auth_mode: Option<String>,
    // v0.9.0：调用方窗口 label（单任务槽/并发槽按窗口分桶）
    window_label: String,
    // v0.7.3 改进9：全文翻译并发槽位标识（None = 单任务互斥）
    concurrent_id: Option<String>,
    on_chunk: Channel<String>,
) -> Result<TranslateResult, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("STREAM|无可翻译内容".to_string());
    }
    let protocol = ApiProtocol::parse(protocol.as_deref())?;
    let auth_mode = AuthMode::parse(auth_mode.as_deref())?;
    let credential = read_ai_credential(credential_id, provider, auth_mode).await?;

    let cancel_flag = match &concurrent_id {
        Some(id) => state.begin_concurrent_task(id, &window_label),
        None => state.begin_task(&window_label),
    };
    let task_id = concurrent_id;

    let built_in = build_prompt(&text, &target_lang, &tone, custom_prompt.as_deref());
    let seg = segment::mask(&text);
    let request = AiRequest {
        protocol,
        base_url,
        model,
        system: merge_system_prompt(&built_in, system_prompt.as_deref()),
        messages: vec![AiChatMessage { role: "user".into(), content: seg.masked_text.clone() }],
        max_output_tokens: max_output_tokens
            .unwrap_or_else(|| estimate_max_tokens(text.chars().count())),
        policy: RequestPolicy {
            token_field: TokenField::parse(token_field.as_deref()),
            temperature,
            reasoning_effort: ReasoningEffort::parse(reasoning_effort.as_deref()),
            include_stream_usage: include_stream_usage.unwrap_or(true),
        },
    };
    // 上下文窗口属于 profile 的预算元数据，不是任何三协议的请求体字段。
    let _ = context_window_tokens;

    let result = stream_ai_request(&request, &credential, &|chunk| {
        let _ = on_chunk.send(chunk);
    }, &cancel_flag)
    .await;

    match (&task_id, &result) {
        (Some(id), _) => state.end_concurrent_task(id, &cancel_flag),
        (None, _) => state.end_task(&window_label, &cancel_flag),
    }

    match result {
        Ok(result) => {
            // 校验针对模型实际返回的 masked 文本；随后再 unmask，保持旧翻译语义。
            let intact = segment::validate(&result.translated, seg.tokens.len());
            Ok(TranslateResult {
                translated: segment::unmask(&result.translated, &seg.tokens),
                placeholders_intact: intact,
                finish_reason: result.finish_reason,
                prompt_tokens: result.prompt_tokens,
                completion_tokens: result.completion_tokens,
            })
        }
        Err(e) => Err(e.to_code_string()),
    }
}

/// 中断进行中的翻译任务。
///
/// v0.9.0 起按窗口分桶，三种粒度：
/// - `concurrent_ids = Some(ids)`：仅取消指定并发批次（全文翻译定向取消）；
/// - `concurrent_ids = None` + `window_label = Some(label)`：取消**该窗口**的
///   单任务槽与全部并发批次（划词翻译/AI 助手的「取消」按钮走这条）；
/// - 两者皆为 None：取消全部窗口的全部任务（仅应用退出等全局场景使用）。
#[tauri::command]
pub async fn cancel_translate(
    state: State<'_, TranslateState>,
    concurrent_ids: Option<Vec<String>>,
    window_label: Option<String>,
) -> Result<(), String> {
    match (concurrent_ids, window_label) {
        (Some(ids), _) if !ids.is_empty() => state.cancel_concurrent_ids(&ids),
        (_, Some(label)) => state.cancel_window_tasks(&label),
        _ => state.cancel_all(),
    }
    Ok(())
}

/// 测试连接：发送 max_tokens=1 的最小请求验证 Key 有效性
#[tauri::command]
pub async fn test_translate_connection(
    provider: String,
    base_url: String,
    model: String,
) -> Result<(), String> {
    let api_key = read_api_key(&provider).await?;
    let provider_impl = OpenAiCompatibleProvider {
        base_url,
        model,
        temperature: 0.1, // 测试连接与 /models 不涉及生成，温度无影响
        api_key,
    };
    provider_impl
        .test_connection()
        .await
        .map_err(|e: TranslateError| e.to_code_string())
}

/// v0.7.2 P2：拉取厂商模型列表（GET {base}/models），供设置页动态刷新下拉
#[tauri::command]
pub async fn list_translate_models(
    provider: String,
    base_url: String,
) -> Result<Vec<String>, String> {
    let api_key = read_api_key(&provider).await?;
    let provider_impl = OpenAiCompatibleProvider {
        base_url,
        model: String::new(), // /models 不需要 model，占位
        temperature: 0.1,
        api_key,
    };
    provider_impl
        .list_models()
        .await
        .map_err(|e: TranslateError| e.to_code_string())
}

/// 写入 API Key（v0.7.2 P1：按 provider 写独立条目；写入失败返回明确错误，不静默）
#[tauri::command]
pub async fn set_translate_key(provider: String, key: String) -> Result<(), String> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("AUTH|Key 不能为空".to_string());
    }
    let provider = sanitize_provider(&provider);
    // v0.6.3 P2-6：keyring 写入是阻塞调用，spawn_blocking 包裹
    tauri::async_runtime::spawn_blocking(move || {
        keyring_entry(&provider)?.set_password(&key).map_err(|e| format!("AUTH|Key 保存失败: {}", e))
    })
    .await
    .map_err(|e| format!("AUTH|{}", e))?
}

/// 检查 API Key 是否已配置（只回布尔值，绝不回明文）
/// v0.7.2 P1：与 read_api_key 同源的回退逻辑（独立条目或旧全局条目任一存在即视为已配置）
#[tauri::command]
pub async fn has_translate_key(provider: String) -> Result<bool, String> {
    let provider = sanitize_provider(&provider);
    // v0.6.3 P2-6：keyring 读取是阻塞调用，spawn_blocking 包裹
    tauri::async_runtime::spawn_blocking(move || {
        let provider_ok = keyring_entry(&provider)
            .map(|e| e.get_password().is_ok())
            .unwrap_or(false);
        if provider_ok {
            return Ok(true);
        }
        // 回退旧全局条目
        let legacy_ok = legacy_keyring_entry()
            .map(|e| e.get_password().is_ok())
            .unwrap_or(false);
        Ok(legacy_ok)
    })
    .await
    .map_err(|e| format!("AUTH|{}", e))?
}

// ─── v0.15.0 需求（AI 深度配置）：按 profile 隔离的凭据命令 ─────────────
//
// 为什么必须新增而不是复用 `set_translate_key(provider)`：
// 旧槽位是 `translate_api_key::{provider}` —— 同一 provider 配两个不同 base_url
// （如火山 Anthropic 与 OpenAI 兼容两个端点、或自建与官方）时会**串用同一个 Key**。
// 新槽位 `ai_credential::{credentialId}` 以 profile 稳定 ID 为键，天然隔离。
//
// `clear_ai_credential_key` 是新增能力：此前 set_translate_key 拒绝空 Key，
// 全仓没有删除 keyring 条目的命令，UI 的"清除 Key"无法实现。

/// 保存某 **AI 连接档案** 的 Key（槽位 `ai_credential::{credentialId}`）
#[tauri::command]
pub async fn set_ai_credential_key(credential_id: String, key: String) -> Result<(), String> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("AUTH|Key 不能为空".to_string());
    }
    let credential_id = sanitize_provider(&credential_id);
    if credential_id.is_empty() {
        return Err("AUTH|凭据标识为空".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        profile_keyring_entry(&credential_id)?
            .set_password(&key)
            .map_err(|e| format!("AUTH|Key 保存失败: {}", e))
    })
    .await
    .map_err(|e| format!("AUTH|{}", e))?
}

/// 检查某 AI 档案是否已配置 Key（只回布尔，绝不回明文）
#[tauri::command]
pub async fn has_ai_credential_key(credential_id: String) -> Result<bool, String> {
    let credential_id = sanitize_provider(&credential_id);
    tauri::async_runtime::spawn_blocking(move || {
        Ok(profile_keyring_entry(&credential_id)
            .map(|e| e.get_password().is_ok())
            .unwrap_or(false))
    })
    .await
    .map_err(|e| format!("AUTH|{}", e))?
}

/// 删除某 AI 档案的 Key（条目本就不存在时视为成功——幂等）
#[tauri::command]
pub async fn clear_ai_credential_key(credential_id: String) -> Result<(), String> {
    let credential_id = sanitize_provider(&credential_id);
    tauri::async_runtime::spawn_blocking(move || {
        let entry = profile_keyring_entry(&credential_id)?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            // 条目不存在 = 已是目标状态，不报错（UI 可安全重复点）
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("AUTH|Key 清除失败: {}", e)),
        }
    })
    .await
    .map_err(|e| format!("AUTH|{}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// v0.7.2 P1：provider 名白名单清洗（凭据管理器条目名仅允许字母数字-_，
    /// 空值/纯非法字符落回 custom 槽，防止出现乱码条目）
    #[test]
    fn test_sanitize_provider() {
        assert_eq!(sanitize_provider("deepseek"), "deepseek");
        assert_eq!(sanitize_provider("  kimi  "), "kimi"); // trim 空白
        assert_eq!(sanitize_provider("a-b_c"), "a-b_c"); // - _ 保留
        assert_eq!(sanitize_provider("my provider!"), "myprovider"); // 过滤空格与特殊字符
        assert_eq!(sanitize_provider(""), "custom"); // 空值回退
        assert_eq!(sanitize_provider("中文"), "custom"); // 非 ASCII 全过滤后为空 → custom
    }
}
