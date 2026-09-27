//! v0.8.4 需求10：目录实时监听（基于 notify crate）。
//! v0.9.0：注册表改为**按窗口引用计数**——多个窗口打开同一目录只注册一个 watcher，
//! 只有最后一个使用该目录的窗口关闭时才真正注销。
//!
//! 结构与生命周期：
//! - 全局注册表 `Mutex<HashMap<PathBuf, WatchedFolder>>`，按根路径注册/注销；
//! - `WatchedFolder.windows` 记录「哪些窗口正在使用该目录」（HashSet 而非计数器：
//!   同一窗口重复注册天然幂等，不会把引用数刷高）；
//! - 每个 watcher 配一个聚合线程：notify 原始事件先进入 mpsc channel，
//!   线程内按 200ms 窗口去抖合并，统一 emit `lightmd://folder-changed`（app.emit
//!   广播到所有窗口，故多窗口 FileTree 天然都能收到，无需改事件分发）；
//! - 引用归零时从注册表移除 watcher → watcher drop 连同其事件闭包（内含
//!   mpsc Sender）一并释放 → 聚合线程 `recv_timeout` 返回 Disconnected，
//!   flush 剩余变更后自然退出，无线程泄漏。

use std::collections::{HashMap, HashSet};
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

/// 被监听的目录：watcher 实例 + 使用该目录的窗口集合
/// （结构由 [`RefRegistry`] 内部持有，此处仅为文档说明字段语义）
///
/// 引用计数结果：调用方据此决定是否需要真正创建/释放 watcher
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RefOutcome {
    /// 首次注册该路径：需要创建 watcher
    NeedsCreate,
    /// 已有 watcher，仅新增了一个使用者
    Attached,
    /// 仍有关联窗口，watcher 保留
    Kept,
    /// 引用归零，watcher 已从注册表移除（drop 由调用方持有的值完成）
    Released,
    /// 该路径本就未注册 / 该窗口本就未关联
    Noop,
}

/// 通用引用计数注册表（与 notify 解耦，便于单测）
#[derive(Debug)]
pub(crate) struct RefRegistry<T> {
    entries: HashMap<PathBuf, (T, HashSet<String>)>,
}

// 手写 Default：`#[derive(Default)]` 会给 T 附加 `T: Default` 约束，
// 而 `notify::RecommendedWatcher` 并未实现 Default。
impl<T> Default for RefRegistry<T> {
    fn default() -> Self {
        Self { entries: HashMap::new() }
    }
}

impl<T> RefRegistry<T> {
    /// 注册表条目数（测试/诊断用）
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// 某路径当前的关联窗口列表（测试/诊断用）
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn users_of(&self, path: &PathBuf) -> Vec<String> {
        let mut v: Vec<String> = self
            .entries
            .get(path)
            .map(|(_, set)| set.iter().cloned().collect())
            .unwrap_or_default();
        v.sort();
        v
    }

    /// 注册引用：路径未注册 → NeedsCreate（调用方创建 watcher 后 `insert`）；
    /// 已注册 → 把 label 加入使用者集合
    pub fn acquire(&mut self, path: &PathBuf, label: &str) -> RefOutcome {
        match self.entries.get_mut(path) {
            None => RefOutcome::NeedsCreate,
            Some((_, set)) => {
                if set.insert(label.to_string()) {
                    RefOutcome::Attached
                } else {
                    RefOutcome::Noop
                }
            }
        }
    }

    /// 创建 watcher 成功后落库（引用集合初始为 {label}）
    pub fn insert(&mut self, path: PathBuf, value: T, label: &str) {
        let mut set = HashSet::new();
        set.insert(label.to_string());
        self.entries.insert(path, (value, set));
    }

    /// 释放引用：归零则移除条目并返回其值（调用方 drop 之）
    pub fn release(&mut self, path: &PathBuf, label: &str) -> (RefOutcome, Option<T>) {
        let Some((_, set)) = self.entries.get_mut(path) else {
            return (RefOutcome::Noop, None);
        };
        if !set.remove(label) {
            return (RefOutcome::Noop, None);
        }
        if set.is_empty() {
            let (value, _) = self.entries.remove(path).expect("条目刚被确认存在");
            (RefOutcome::Released, Some(value))
        } else {
            (RefOutcome::Kept, None)
        }
    }
}

static WATCHERS: OnceLock<Mutex<RefRegistry<notify::RecommendedWatcher>>> = OnceLock::new();

fn watchers() -> &'static Mutex<RefRegistry<notify::RecommendedWatcher>> {
    WATCHERS.get_or_init(|| Mutex::new(RefRegistry::default()))
}

/// 取锁（中毒时退化为内部数据：监听中断不应让整个应用不可用）
fn lock_watchers() -> std::sync::MutexGuard<'static, RefRegistry<notify::RecommendedWatcher>> {
    match watchers().lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    }
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

/// 注册对指定目录（含整棵子树）的监听。
///
/// v0.9.0：加 `window_label` 引用计数——同一目录被多个窗口打开时只创建一个 watcher，
/// 重复注册（同窗口）为 no-op。
#[tauri::command]
pub async fn watch_folder(
    app: tauri::AppHandle,
    path: String,
    window_label: String,
) -> Result<(), String> {
    let root = resolve_path(&path)?;
    let mut registry = lock_watchers();
    match registry.acquire(&root, &window_label) {
        RefOutcome::NeedsCreate => {}
        // 已有 watcher（新窗口接入 / 同窗口重复调用）都是 no-op
        RefOutcome::Attached | RefOutcome::Noop => return Ok(()),
        // 枚举完备性：acquire 不会返回这两个
        RefOutcome::Kept | RefOutcome::Released => return Ok(()),
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
    registry.insert(root, watcher, &window_label);
    Ok(())
}

/// 注销对指定目录的监听（引用归零才真正释放）；未注册/未关联时 no-op。
#[tauri::command]
pub async fn unwatch_folder(path: String, window_label: String) -> Result<(), String> {
    release_folder_for_window(&path, &window_label);
    Ok(())
}

/// 释放某窗口对某目录的引用（窗口关闭流程直接调用，不走 IPC）。
/// 返回是否真正注销了 watcher（供测试/诊断）。
pub(crate) fn release_folder_for_window(path: &str, window_label: &str) -> bool {
    let Ok(root) = resolve_path(path) else {
        return false;
    };
    let mut registry = lock_watchers();
    // `release` 返回的 watcher 值在此 drop → 聚合线程感知通道关闭后自行退出
    matches!(registry.release(&root, window_label).0, RefOutcome::Released)
}

/// 测试用：当前 watcher 注册表条目数
#[cfg(test)]
pub(crate) fn watcher_count() -> usize {
    lock_watchers().len()
}

/// 测试用：某路径的关联窗口列表
#[cfg(test)]
pub(crate) fn watcher_users(path: &str) -> Vec<String> {
    let Ok(root) = resolve_path(path) else {
        return Vec::new();
    };
    lock_watchers().users_of(&root)
}

/// 测试用：清空注册表（避免用例间相互影响）
#[cfg(test)]
pub(crate) fn clear_watchers() {
    lock_watchers().entries.clear();
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

    // ─── v0.9.0：watcher 引用计数 ───

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    /// 首个窗口注册返回 NeedsCreate；落库后第二个窗口返回 Attached（复用同一 watcher）
    #[test]
    fn refcount_shares_one_watcher_across_windows() {
        let mut reg: RefRegistry<u8> = RefRegistry::default();
        assert_eq!(reg.acquire(&p("D:/docs"), "main"), RefOutcome::NeedsCreate);
        reg.insert(p("D:/docs"), 1, "main");
        assert_eq!(reg.len(), 1);
        assert_eq!(reg.acquire(&p("D:/docs"), "sec-1"), RefOutcome::Attached);
        // AC-17：两个窗口共用同一个 watcher
        assert_eq!(reg.len(), 1);
        assert_eq!(reg.users_of(&p("D:/docs")), vec!["main", "sec-1"]);
    }

    /// 同一窗口重复注册幂等（不会把引用刷高，关窗后仍能正确归零）
    #[test]
    fn refcount_is_idempotent_for_same_window() {
        let mut reg: RefRegistry<u8> = RefRegistry::default();
        reg.acquire(&p("D:/docs"), "main");
        reg.insert(p("D:/docs"), 1, "main");
        assert_eq!(reg.acquire(&p("D:/docs"), "main"), RefOutcome::Noop);
        assert_eq!(reg.users_of(&p("D:/docs")), vec!["main"]);
        assert_eq!(reg.release(&p("D:/docs"), "main").0, RefOutcome::Released);
        assert_eq!(reg.len(), 0);
    }

    /// A 关闭后 B 仍在使用 → watcher 保留（AC-17）
    #[test]
    fn refcount_keeps_watcher_when_another_window_remains() {
        let mut reg: RefRegistry<u8> = RefRegistry::default();
        reg.insert(p("D:/docs"), 1, "main");
        reg.acquire(&p("D:/docs"), "sec-1");
        let (outcome, value) = reg.release(&p("D:/docs"), "main");
        assert_eq!(outcome, RefOutcome::Kept);
        assert!(value.is_none());
        assert_eq!(reg.len(), 1);
        assert_eq!(reg.users_of(&p("D:/docs")), vec!["sec-1"]);
        // 最后一个窗口关闭 → 真正释放
        let (outcome2, value2) = reg.release(&p("D:/docs"), "sec-1");
        assert_eq!(outcome2, RefOutcome::Released);
        assert_eq!(value2, Some(1));
        assert_eq!(reg.len(), 0);
    }

    /// 释放未注册路径 / 未关联窗口都是 no-op（不 panic、不误删他人引用）
    #[test]
    fn refcount_release_is_safe_for_unknown_inputs() {
        let mut reg: RefRegistry<u8> = RefRegistry::default();
        assert_eq!(reg.release(&p("D:/nope"), "main").0, RefOutcome::Noop);
        reg.insert(p("D:/docs"), 1, "main");
        assert_eq!(reg.release(&p("D:/docs"), "sec-9").0, RefOutcome::Noop);
        assert_eq!(reg.len(), 1);
        assert_eq!(reg.users_of(&p("D:/docs")), vec!["main"]);
    }

    /// 关闭 8 个窗口的压力场景：逐个释放后注册表必须为空（无 watcher 泄漏）
    #[test]
    fn refcount_releases_all_after_eight_windows_close() {
        let mut reg: RefRegistry<u8> = RefRegistry::default();
        reg.insert(p("D:/docs"), 1, "main");
        let labels: Vec<String> = (1..8).map(|i| format!("sec-{i}")).collect();
        for l in &labels {
            reg.acquire(&p("D:/docs"), l);
        }
        // 每个窗口还各自开了一个独享目录
        for l in &labels {
            let own = p(&format!("D:/own/{}", l));
            reg.insert(own, 2, l);
        }
        assert_eq!(reg.len(), 8);
        reg.release(&p("D:/docs"), "main");
        for l in &labels {
            reg.release(&p("D:/docs"), l);
            reg.release(&p(&format!("D:/own/{}", l)), l);
        }
        assert_eq!(reg.len(), 0);
    }
}
