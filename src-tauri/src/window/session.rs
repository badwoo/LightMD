//! v0.9.0 多窗口：会话快照（session.json）的序列化与读写。
//!
//! 设计要点（见实施计划 §3.5）：
//! - **不存窗口几何**：几何唯一归属 `tauri-plugin-window-state`（按 label 记录，
//!   固定槽位 label 使几何跨会话天然复用）。
//! - **不存 dirty 内容**：与 v0.8.5 一致，重启后真实文件回到磁盘版本；
//!   临时（untitled）标签的正文仍在各窗口自己的 localStorage key 里（§3.4）。
//! - 存盘位置：`app_data_dir()/session.json`。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::Manager;

/// 会话文件版本号（结构变更时递增，旧版本直接忽略）
pub const SESSION_VERSION: u32 = 1;

/// 会话文件名（位于 app_data_dir）
pub const SESSION_FILE: &str = "session.json";

/// 标签快照：既是持久化结构，也是前端 `sync_window_state` 的上报结构。
///
/// `kind` = "file"（path 有效）| "untitled"（untitled_id 有效）。
/// 其余字段（name/pinned/isDirty）用于窗口列表 UI 与会话恢复。
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TabSnapshot {
    pub kind: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub untitled_id: Option<String>,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub is_dirty: bool,
}

impl TabSnapshot {
    /// 该标签对应的"打开的文件路径"（临时标签返回 None）
    pub fn file_path(&self) -> Option<&str> {
        match self.kind.as_str() {
            "file" => self.path.as_deref().filter(|p| !p.is_empty()),
            _ => None,
        }
    }
}

/// 单个窗口的会话数据
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WindowSession {
    pub label: String,
    #[serde(default)]
    pub active_tab_idx: usize,
    #[serde(default)]
    pub tabs: Vec<TabSnapshot>,
    /// 该窗口侧栏打开的文件夹（窗口级列表，§3.3）
    #[serde(default)]
    pub folder_paths: Vec<String>,
}

/// 全量会话快照
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub version: u32,
    #[serde(default)]
    pub timestamp: u64,
    #[serde(default)]
    pub windows: Vec<WindowSession>,
}

impl SessionSnapshot {
    pub fn new(timestamp: u64, windows: Vec<WindowSession>) -> Self {
        Self { version: SESSION_VERSION, timestamp, windows }
    }

    /// 是否值得写盘：只有出现过 ≥2 窗口的会话才写（纯单窗口用户走 v0.8.5 原路径）
    pub fn is_multi_window(&self) -> bool {
        self.windows.len() >= 2
    }
}

/// session.json 的完整路径
pub fn session_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join(SESSION_FILE))
        .map_err(|e| format!("无法定位应用数据目录: {}", e))
}

/// 读取 session.json。
/// - 文件不存在 → Ok(None)（v0.8.5 路径）
/// - 解析失败/版本不符 → Ok(None) 并删除损坏文件（防每次启动都读坏数据）
pub fn read_session(app: &tauri::AppHandle) -> Result<Option<SessionSnapshot>, String> {
    let path = session_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("读取会话文件失败: {}", e))?;
    match serde_json::from_str::<SessionSnapshot>(&raw) {
        Ok(snap) if snap.version == SESSION_VERSION => Ok(Some(snap)),
        _ => {
            let _ = std::fs::remove_file(&path);
            Ok(None)
        }
    }
}

/// 写入 session.json（自动创建目录；全量覆盖）
pub fn write_session(app: &tauri::AppHandle, snapshot: &SessionSnapshot) -> Result<(), String> {
    let path = session_path(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建应用数据目录失败: {}", e))?;
    }
    let body =
        serde_json::to_vec_pretty(snapshot).map_err(|e| format!("序列化会话失败: {}", e))?;
    std::fs::write(&path, body).map_err(|e| format!("写入会话文件失败: {}", e))
}

/// 删除 session.json（不存在时视为成功）
pub fn remove_session(app: &tauri::AppHandle) -> Result<(), String> {
    let path = session_path(app)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("删除会话文件失败: {}", e))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tab(kind: &str) -> TabSnapshot {
        TabSnapshot {
            kind: kind.to_string(),
            path: Some("D:/a/b.md".to_string()),
            untitled_id: None,
            name: "b.md".to_string(),
            pinned: false,
            is_dirty: true,
        }
    }

    /// 会话快照 JSON 往返（camelCase 字段名，前端直接消费）
    #[test]
    fn snapshot_roundtrip_preserves_fields() {
        let snap = SessionSnapshot::new(
            123,
            vec![WindowSession {
                label: "sec-1".to_string(),
                active_tab_idx: 2,
                tabs: vec![tab("file")],
                folder_paths: vec!["D:/a".to_string()],
            }],
        );
        let json = serde_json::to_string(&snap).unwrap();
        // 前端按 camelCase 读取
        assert!(json.contains("\"activeTabIdx\""));
        assert!(json.contains("\"folderPaths\""));
        assert!(json.contains("\"untitledId\""));
        assert!(json.contains("\"isDirty\""));
        let back: SessionSnapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(back, snap);
    }

    /// 缺字段的旧/异常数据不应导致解析失败（全部有默认值）
    #[test]
    fn snapshot_tolerates_missing_optional_fields() {
        let raw = r#"{"version":1,"windows":[{"label":"main"}]}"#;
        let snap: SessionSnapshot = serde_json::from_str(raw).unwrap();
        assert_eq!(snap.windows.len(), 1);
        assert!(snap.windows[0].tabs.is_empty());
        assert_eq!(snap.windows[0].active_tab_idx, 0);
    }

    /// 只有 ≥2 窗口的会话才值得写盘（保证纯单窗口用户走 v0.8.5 路径）
    #[test]
    fn only_multi_window_snapshot_is_persisted() {
        let one = SessionSnapshot::new(1, vec![WindowSession::default()]);
        assert!(!one.is_multi_window());
        let two = SessionSnapshot::new(
            1,
            vec![WindowSession::default(), WindowSession::default()],
        );
        assert!(two.is_multi_window());
    }

    /// 临时标签不产生文件路径（供 OPEN_FILES 注册表使用）
    #[test]
    fn tab_snapshot_file_path_only_for_file_kind() {
        let mut t = tab("untitled");
        t.path = Some("D:/a/b.md".to_string());
        assert_eq!(t.file_path(), None);
        let t2 = tab("file");
        assert_eq!(t2.file_path(), Some("D:/a/b.md"));
        let mut t3 = tab("file");
        t3.path = Some(String::new());
        assert_eq!(t3.file_path(), None);
    }
}
