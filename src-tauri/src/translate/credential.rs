//! AI profile 凭据策略。凭据明文只停留在 Rust/keyring，不进入 persist 或前端返回值。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthMode {
    Required,
    Optional,
    None,
}

impl AuthMode {
    /// Tauri command 的可选字符串参数；缺失沿用旧云端的 required 行为。
    pub fn parse(value: Option<&str>) -> Result<Self, String> {
        match value.unwrap_or("required") {
            "required" => Ok(Self::Required),
            "optional" => Ok(Self::Optional),
            "none" => Ok(Self::None),
            _ => Err("PROVIDER|400|无效的 authMode".to_string()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Credential {
    pub api_key: Option<String>,
    pub auth_mode: AuthMode,
}

/// 从按账号隔离的 keyring 中解析 profile 凭据。
///
/// `credential_id` 为主键；仅当它没有条目时才尝试 `legacy_provider` 一次。
/// legacy_provider 的 reader 已封装旧 provider/全局回退，避免这里产生多套迁移规则。
pub fn resolve_credential_with<F, G>(
    credential_id: &str,
    legacy_provider: Option<&str>,
    auth_mode: AuthMode,
    read_profile: F,
    read_legacy: G,
) -> Result<Credential, String>
where
    F: FnOnce(&str) -> Result<Option<String>, String>,
    G: FnOnce(&str) -> Result<Option<String>, String>,
{
    let id = credential_id.trim();
    if id.is_empty() {
        return Err("NO_KEY|缺少 credentialId".to_string());
    }
    let mut api_key = read_profile(id)?;
    if api_key.is_none() {
        if let Some(provider) = legacy_provider.filter(|p| !p.trim().is_empty()) {
            api_key = read_legacy(provider)?;
        }
    }
    let api_key = api_key.and_then(|key| {
        let trimmed = key.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    });
    if auth_mode == AuthMode::Required && api_key.is_none() {
        return Err("NO_KEY|未设置 API Key".to_string());
    }
    Ok(Credential { api_key, auth_mode })
}

/// HTTP Authorization 值；none 或无可用 Key 都返回 None，绝不生成占位 Key。
pub fn authorization_header(credential: &Credential) -> Option<String> {
    if credential.auth_mode == AuthMode::None {
        return None;
    }
    credential.api_key.as_deref().map(|key| format!("Bearer {key}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile_reader(value: Option<&str>) -> impl FnOnce(&str) -> Result<Option<String>, String> + '_ {
        move |id| {
            assert_eq!(id, "profile-a");
            Ok(value.map(str::to_string))
        }
    }

    #[test]
    fn required_without_key_returns_no_key() {
        let error = resolve_credential_with(
            "profile-a",
            None,
            AuthMode::Required,
            profile_reader(None),
            |_| panic!("没有 legacy provider 时不应读取旧槽"),
        )
        .unwrap_err();
        assert!(error.starts_with("NO_KEY|"));
    }

    #[test]
    fn missing_profile_key_falls_back_to_legacy_once() {
        let mut legacy_reads = 0;
        let credential = resolve_credential_with(
            "profile-a",
            Some("custom"),
            AuthMode::Required,
            profile_reader(None),
            |provider| {
                legacy_reads += 1;
                assert_eq!(provider, "custom");
                Ok(Some("legacy-secret".to_string()))
            },
        )
        .unwrap();
        assert_eq!(legacy_reads, 1);
        assert_eq!(credential.api_key.as_deref(), Some("legacy-secret"));
    }

    #[test]
    fn profile_key_wins_and_does_not_read_legacy() {
        let credential = resolve_credential_with(
            "profile-a",
            Some("same-provider"),
            AuthMode::Required,
            profile_reader(Some("profile-secret")),
            |_| panic!("profile 命中后不得读取同 provider 的旧 Key"),
        )
        .unwrap();
        assert_eq!(credential.api_key.as_deref(), Some("profile-secret"));
    }

    #[test]
    fn ollama_none_does_not_require_key_or_emit_authorization() {
        let credential = resolve_credential_with(
            "profile-a",
            None,
            AuthMode::None,
            profile_reader(None),
            |_| unreachable!(),
        )
        .unwrap();
        assert_eq!(credential.api_key, None);
        assert_eq!(authorization_header(&credential), None);
    }

    #[test]
    fn none_ignores_legacy_key_and_optional_uses_it() {
        let none = Credential { api_key: Some("secret".into()), auth_mode: AuthMode::None };
        assert_eq!(authorization_header(&none), None);
        let optional = resolve_credential_with(
            "profile-a",
            None,
            AuthMode::Optional,
            profile_reader(Some(" secret ")),
            |_| unreachable!(),
        )
        .unwrap();
        assert_eq!(authorization_header(&optional).as_deref(), Some("Bearer secret"));
        let absent = Credential { api_key: None, auth_mode: AuthMode::Optional };
        assert_eq!(authorization_header(&absent), None);
    }

    #[test]
    fn credential_id_is_required_and_auth_mode_is_checked() {
        assert!(resolve_credential_with(
            " ",
            None,
            AuthMode::None,
            |_| unreachable!(),
            |_| unreachable!(),
        )
        .is_err());
        assert_eq!(AuthMode::parse(None).unwrap(), AuthMode::Required);
        assert_eq!(AuthMode::parse(Some("none")).unwrap(), AuthMode::None);
        assert!(AuthMode::parse(Some("guess")).is_err());
    }
}
