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

use crate::translate::prompt::build_prompt;
use crate::translate::provider::{OpenAiCompatibleProvider, TranslateError, TranslateResult};
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
pub(crate) async fn read_api_key(provider: &str) -> Result<String, String> {
    let provider = sanitize_provider(provider);
    tauri::async_runtime::spawn_blocking(move || {
        // 1. 厂商独立条目
        if let Some(key) = keyring_entry(&provider).and_then(entry_password)? {
            return Ok(key);
        }
        // 2. 回退旧全局条目（v0.7.2 及之前）
        match legacy_keyring_entry().and_then(entry_password)? {
            Some(key) => Ok(key),
            None => Err("NO_KEY|未设置 API Key".to_string()),
        }
    })
    .await
    .map_err(|e| format!("AUTH|{}", e))?
}

/// 选中翻译（流式）：text 为 markdown 片段（edit/split）或纯文本（preview）
///
/// 单任务模型：新任务自动取消旧任务。
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
    // v0.7.3：采样温度（由设置透传；kimi 等厂商仅允许 1）
    temperature: f32,
    // v0.7.3 改进9：全文翻译并发槽位标识（None = 单任务互斥）
    concurrent_id: Option<String>,
    on_chunk: Channel<String>,
) -> Result<TranslateResult, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("STREAM|无可翻译内容".to_string());
    }

    // 读 Key（仅 Rust 侧内存，不回传前端）
    let api_key = read_api_key(&provider).await?;

    // v0.7.3 改进9：按 concurrent_id 区分「并发任务槽位」与「单任务互斥」
    let cancel_flag = match &concurrent_id {
        Some(id) => state.begin_concurrent_task(id),
        None => state.begin_task(),
    };
    let task_id = concurrent_id;

    let sys_prompt = build_prompt(&text, &target_lang, &tone, custom_prompt.as_deref());
    let provider = OpenAiCompatibleProvider {
        base_url,
        model,
        api_key,
        // v0.7.3：温度钳制到 [0, 2]，防止前端越界导致厂商 400
        temperature: temperature.clamp(0.0, 2.0),
    };

    let result = provider
        .translate_stream(sys_prompt, text, &|chunk| {
            // 推送增量（失败静默：前端可能已关闭气泡）
            let _ = on_chunk.send(chunk);
        }, &cancel_flag)
        .await;

    // 完成/失败统一清理对应槽位
    match (&task_id, &result) {
        (Some(id), _) => state.end_concurrent_task(id, &cancel_flag),
        (None, _) => state.end_task(&cancel_flag),
    }

    match result {
        Ok(r) => Ok(r),
        Err(e) => Err(e.to_code_string()),
    }
}

/// 中断进行中的翻译任务（v0.6.0 单任务模型，无需 task_id）。
/// v0.7.3 改进9：concurrent_ids=None 取消全部任务（单任务槽 + 所有并发槽），
/// concurrent_ids=Some(ids) 仅取消指定并发任务（全文翻译定向取消）。
#[tauri::command]
pub async fn cancel_translate(
    state: State<'_, TranslateState>,
    concurrent_ids: Option<Vec<String>>,
) -> Result<(), String> {
    match concurrent_ids {
        Some(ids) if !ids.is_empty() => state.cancel_concurrent_ids(&ids),
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
