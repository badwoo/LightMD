//! AI 翻译 Tauri 命令层（v0.6.0）
//!
//! 命令清单：
//! - translate_text：选中翻译（流式 Channel 推送，单任务模型）
//! - cancel_translate：中断进行中的任务
//! - test_translate_connection：1-token 最小请求验证 Key
//! - set_translate_key / has_translate_key：keyring Key 写入/存在性检查
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
const KEYRING_ACCOUNT: &str = "translate_api_key";

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| format!("AUTH|凭据管理器不可用: {}", e))
}

/// 读取 API Key（v0.6.3 P2-1/P2-6）：
/// - keyring 操作是阻塞调用，用 spawn_blocking 包裹，避免占住 async runtime 工作线程
/// - Key 未配置（NoEntry）产出 NO_KEY 码，与 AUTH（Key 无效/凭据管理器故障）区分
async fn read_api_key() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        keyring_entry().and_then(|e| match e.get_password() {
            Ok(key) => Ok(key),
            Err(keyring::Error::NoEntry) => Err("NO_KEY|未设置 API Key".to_string()),
            Err(e) => Err(format!("AUTH|凭据读取失败: {}", e)),
        })
    })
    .await
    .map_err(|e| format!("AUTH|{}", e))?
}

/// 选中翻译（流式）：text 为 markdown 片段（edit/split）或纯文本（preview）
///
/// 单任务模型：新任务自动取消旧任务。
/// on_chunk 推送增量译文（含 {{N}} 占位符原样透传）。
#[tauri::command]
pub async fn translate_text(
    state: State<'_, TranslateState>,
    text: String,
    base_url: String,
    model: String,
    target_lang: String,
    tone: String,
    custom_prompt: Option<String>,
    on_chunk: Channel<String>,
) -> Result<TranslateResult, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("STREAM|无可翻译内容".to_string());
    }

    // 读 Key（仅 Rust 侧内存，不回传前端）
    let api_key = read_api_key().await?;

    // 单任务互斥：取消旧任务，注册新取消标志
    let cancel_flag = state.begin_task();

    let sys_prompt = build_prompt(&text, &target_lang, &tone, custom_prompt.as_deref());
    let provider = OpenAiCompatibleProvider {
        base_url,
        model,
        api_key,
    };

    let result = provider
        .translate_stream(sys_prompt, text, &|chunk| {
            // 推送增量（失败静默：前端可能已关闭气泡）
            let _ = on_chunk.send(chunk);
        }, &cancel_flag)
        .await;

    match result {
        Ok(r) => {
            // 任务完成，清理标志（单次 lock，避免同线程重复 lock 死锁）
            state.end_task(&cancel_flag);
            Ok(r)
        }
        Err(e) => {
            // v0.6.3 P2-5：失败/取消路径同样清理标志，否则 cancel_flag 残留 Some(已置位 flag)
            state.end_task(&cancel_flag);
            Err(e.to_code_string())
        }
    }
}

/// 中断进行中的翻译任务（v0.6.0 单任务模型，无需 task_id）
#[tauri::command]
pub async fn cancel_translate(state: State<'_, TranslateState>) -> Result<(), String> {
    state.cancel_current();
    Ok(())
}

/// 测试连接：发送 max_tokens=1 的最小请求验证 Key 有效性
#[tauri::command]
pub async fn test_translate_connection(
    base_url: String,
    model: String,
) -> Result<(), String> {
    let api_key = read_api_key().await?;
    let provider = OpenAiCompatibleProvider {
        base_url,
        model,
        api_key,
    };
    provider
        .test_connection()
        .await
        .map_err(|e: TranslateError| e.to_code_string())
}

/// 写入 API Key（keyring；写入失败返回明确错误，不静默）
#[tauri::command]
pub async fn set_translate_key(key: String) -> Result<(), String> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("AUTH|Key 不能为空".to_string());
    }
    // v0.6.3 P2-6：keyring 写入是阻塞调用，spawn_blocking 包裹
    tauri::async_runtime::spawn_blocking(move || {
        keyring_entry()?.set_password(&key).map_err(|e| format!("AUTH|Key 保存失败: {}", e))
    })
    .await
    .map_err(|e| format!("AUTH|{}", e))?
}

/// 检查 API Key 是否已配置（只回布尔值，绝不回明文）
#[tauri::command]
pub async fn has_translate_key() -> Result<bool, String> {
    // v0.6.3 P2-6：keyring 读取是阻塞调用，spawn_blocking 包裹
    tauri::async_runtime::spawn_blocking(|| {
        match keyring_entry() {
            Ok(entry) => Ok(entry.get_password().map(|_| true).unwrap_or(false)),
            Err(_) => Ok(false),
        }
    })
    .await
    .map_err(|e| format!("AUTH|{}", e))?
}
