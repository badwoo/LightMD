use serde::{Deserialize, Serialize};

/// 最近打开的文件记录
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentFile {
    pub id: i64,
    pub path: String,
    pub name: String,
    pub accessed_at: i64,
}

/// 编辑器设置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditorSetting {
    pub key: String,
    pub value: String,
}

/// 文件元数据（用于搜索和索引）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileMeta {
    pub id: i64,
    pub path: String,
    pub title: Option<String>,
    pub word_count: u32,
    pub modified_at: i64,
}
