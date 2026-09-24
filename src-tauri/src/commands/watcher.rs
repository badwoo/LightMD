//! v0.8.4 需求10：目录实时监听（基于 notify crate）。
//!
//! 结构与生命周期：
//! - 全局注册表 `Mutex<HashMap<PathBuf, RecommendedWatcher>>`，按根路径注册/注销；
//! - 每个 watcher 配一个聚合线程：notify 原始事件先进入 mpsc channel，
//!   线程内按 200ms 窗口去抖合并，统一 emit `lightmd://folder-changed`；
//! - unwatch 时从注册表移除 watcher → watcher drop 连同其事件闭包（内含
//!   mpsc Sender）一并释放 → 聚合线程 `recv_timeout` 返回 Disconnected，
//!   flush 剩余变更后自然退出，无线程泄漏。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tauri::Emitter;

// Watcher trait：提供 watch/unwatch 方法（RecommendedWatcher 为 trait object 封装）
use notify::Watcher;

use super::file_ops::resolve_path;

/// 事件聚合窗口宽度（毫秒）：窗口内多次变更合并为一次 emit，
/// 与前端 300ms 二次去抖配合，避免事件风暴（§9.3 P1）
const AGGREGATE_WINDOW_MS: u64 = 200;

/// 全局 watcher 注册表：被监听的根路径 → watcher 实例。
/// watcher 实例必须保活（drop 即注销监听），故由注册表统一持有。
static WATCHERS: OnceLock<Mutex<HashMap<PathBuf, notify::RecommendedWatcher>>> = OnceLock::new();

fn watchers() -> &'static Mutex<HashMap<PathBuf, notify::RecommendedWatcher>> {
    WATCHERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// watch 事件载荷。
/// derive camelCase：前端消费 root / paths / hasRemove 字段。
/// （Clone 为 tauri Emitter::emit 的约束要求）
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEvent {
    /// 被监听的文件夹根路径
    pub root: String,
    /// 本窗口内变更的文件/目录绝对路径（去重，统一正斜杠风格）
    pub paths: Vec<String>,
    /// 窗口内是否含删除/移出事件（供前端标记"最近打开"条目 stale）
    pub has_remove: bool,
}

/// 注册对指定目录（含整棵子树）的监听；重复注册同一路径为 no-op。
#[tauri::command]
pub async fn watch_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let root = resolve_path(&path)?;
    let mut map = watchers().lock().expect("watcher 注册表锁中毒");
    if map.contains_key(&root) {
        // 重复注册同一路径：no-op
        return Ok(());
    }
    // mpsc 通道：notify 回调线程 → 聚合线程
    let (tx, rx) = std::sync::mpsc::channel::<notify::Event>();
    let event_tx = tx.clone();
    let mut watcher = notify::recommended_watcher(
        move |res: Result<notify::Event, notify::Error>| {
            // 单个事件解析失败（平台瞬时错误）忽略，不影响整体监听
            if let Ok(ev) = res {
                let _ = event_tx.send(ev);
            }
        },
    )
    .map_err(|e| format!("创建文件监听器失败 \"{}\": {}", root.display(), e))?;
    watcher
        .watch(&root, notify::RecursiveMode::Recursive)
        .map_err(|e| format!("监听目录失败 \"{}\": {}", root.display(), e))?;
    // 聚合线程：200ms 窗口合并后 emit；注册表移除 watcher 后自动退出
    let root_key = path_key(&root);
    std::thread::spawn(move || aggregate_loop(app, root_key, rx));
    map.insert(root, watcher);
    Ok(())
}

/// 注销对指定目录的监听；未注册时 no-op。
#[tauri::command]
pub async fn unwatch_folder(path: String) -> Result<(), String> {
    let root = resolve_path(&path)?;
    // 从注册表移除即 drop watcher → 聚合线程感知通道关闭后自行退出
    watchers()
        .lock()
        .expect("watcher 注册表锁中毒")
        .remove(&root);
    Ok(())
}

/// 事件聚合主循环。
/// 窗口语义：自首个事件起持续收集，直到 200ms 内无新事件才统一发出（去抖）。
fn aggregate_loop(
    app: tauri::AppHandle,
    root: String,
    rx: std::sync::mpsc::Receiver<notify::Event>,
) {
    let mut paths: Vec<String> = Vec::new();
    let mut has_remove = false;
    loop {
        match rx.recv_timeout(Duration::from_millis(AGGREGATE_WINDOW_MS)) {
            Ok(ev) => {
                if is_removal(&ev.kind) {
                    has_remove = true;
                }
                paths.extend(ev.paths.iter().map(|p| path_key(p)));
            }
            // 窗口静默到期：有待发变更则合并 emit 一帧
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if !paths.is_empty() {
                    let payload = ChangeEvent {
                        root: root.clone(),
                        paths: dedup_paths(&paths),
                        has_remove,
                    };
                    let _ = app.emit("lightmd://folder-changed", payload);
                    paths.clear();
                    has_remove = false;
                }
            }
            // watcher 已注销 drop，通道关闭：flush 剩余变更后结束线程
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                if !paths.is_empty() {
                    let payload = ChangeEvent {
                        root,
                        paths: dedup_paths(&paths),
                        has_remove,
                    };
                    let _ = app.emit("lightmd://folder-changed", payload);
                }
                break;
            }
        }
    }
}

/// 判定事件是否为"删除/移出"：
/// - `Remove(_)`：文件/目录被删除；
/// - `Modify(Name(From))`：Windows 上 rename 的旧路径事件——文件被移出监听树时
///   只会收到该事件而没有对应 Remove，须一并计入以支撑前端 stale 标记。
fn is_removal(kind: &notify::EventKind) -> bool {
    match kind {
        notify::EventKind::Remove(_) => true,
        notify::EventKind::Modify(notify::event::ModifyKind::Name(mode)) => {
            matches!(mode, notify::event::RenameMode::From)
        }
        _ => false,
    }
}

/// 路径统一为正斜杠字符串，与 list_dir 返回给前端的路径风格一致，便于前端匹配
fn path_key(path: &std::path::Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// 变更路径排序去重，保证同一路径在一个事件帧内只出现一次
fn dedup_paths(paths: &[String]) -> Vec<String> {
    let mut v = paths.to_vec();
    v.sort();
    v.dedup();
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 删除与 rename-From（移出）事件都应标记 has_remove（支撑前端 stale 语义）
    #[test]
    fn is_removal_covers_remove_and_rename_from() {
        assert!(is_removal(&notify::EventKind::Remove(
            notify::event::RemoveKind::File
        )));
        assert!(is_removal(&notify::EventKind::Modify(
            notify::event::ModifyKind::Name(notify::event::RenameMode::From)
        )));
        // 重命名的新路径事件不算删除/移出
        assert!(!is_removal(&notify::EventKind::Modify(
            notify::event::ModifyKind::Name(notify::event::RenameMode::To)
        )));
        // 普通内容修改不算
        assert!(!is_removal(&notify::EventKind::Modify(
            notify::event::ModifyKind::Data(notify::event::DataChange::Any)
        )));
    }

    /// 路径键统一正斜杠（Windows 反斜杠 → /）
    #[test]
    fn path_key_normalizes_separators() {
        assert_eq!(path_key(std::path::Path::new(r"D:\a\b.md")), "D:/a/b.md");
        assert_eq!(path_key(std::path::Path::new("D:/a/b.md")), "D:/a/b.md");
    }

    /// 变更路径去重且排序稳定
    #[test]
    fn dedup_paths_removes_duplicates() {
        assert_eq!(
            dedup_paths(&["b".into(), "a".into(), "b".into()]),
            vec!["a".to_string(), "b".to_string()]
        );
    }
}
