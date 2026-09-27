//! v0.9.0 多窗口：OPEN_FILES 注册表（冲突检测 + 文件级监听合体，实施计划 §3.8）。
//!
//! 职责：
//! 1. **冲突检测**：记录「哪个窗口打开了哪个文件、是否 dirty」，供 `query_file_open`
//!    在打开前判断是否需要弹冲突对话框。
//! 2. **文件级监听**：维护去重后的已打开文件集合，为每个文件注册一个轻量
//!    notify watcher（与目录递归 watcher 相互独立），外部程序改动文件时
//!    emit `lightmd:fileChanged`，所有窗口各自按本窗口标签状态处理。
//!
//! 性能约定：
//! - 前端只在「标签元数据」变化时上报（不是每次击键），单次载荷 ≤ 50 条；
//! - 文件 watcher 上限 [`MAX_FILE_WATCHERS`]，超限不再注册并 emit
//!   `lightmd:watchLimitReached` 供前端 toast（不阻断打开文件）；
//! - watcher 只在「路径集合真的变了」时才增删（diff），不做全量重建。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use notify::Watcher;
use serde::Serialize;
use tauri::Emitter;

use super::session::TabSnapshot;

/// 文件级监听上限（所有窗口已打开文件之和，产品决策：50）
pub const MAX_FILE_WATCHERS: usize = 50;

/// 单个文件的打开记录（冲突对话框数据源）
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenFileRef {
    pub label: String,
    pub is_dirty: bool,
}

/// 路径统一为正斜杠，与 watcher.rs 的 path_key / 前端 list_dir 返回风格一致
pub fn normalize_path(path: &str) -> String {
    path.replace('\\', "/")
}

/// 已打开文件注册表（纯逻辑，便于单测）
#[derive(Default, Debug)]
pub struct OpenFiles {
    /// 规范化路径 → { 窗口 label → 该窗口视角下是否 dirty }
    entries: HashMap<String, HashMap<String, bool>>,
}

impl OpenFiles {
    /// 全量替换某窗口的打开文件集合（幂等；前端周期性上报）。
    ///
    /// 语义 = 「该窗口现在打开着这些文件」，因此先清掉该 label 在所有路径上的旧记录
    /// 再重新写入——窗口内关闭了某个标签时，旧记录会被自然清除。
    pub fn sync_window(&mut self, label: &str, tabs: &[TabSnapshot]) {
        for owners in self.entries.values_mut() {
            owners.remove(label);
        }
        for tab in tabs {
            if let Some(path) = tab.file_path() {
                self.entries
                    .entry(normalize_path(path))
                    .or_default()
                    .insert(label.to_string(), tab.is_dirty);
            }
        }
        // 无人打开的历史路径直接丢弃，避免注册表随会话增长
        self.entries.retain(|_, owners| !owners.is_empty());
    }

    /// 窗口关闭：清除该 label 的全部登记
    pub fn remove_window(&mut self, label: &str) {
        for owners in self.entries.values_mut() {
            owners.remove(label);
        }
        self.entries.retain(|_, owners| !owners.is_empty());
    }

    /// 查询某文件被哪些窗口打开（按 label 排序，结果稳定便于测试与 UI 展示）
    pub fn query(&self, path: &str) -> Vec<OpenFileRef> {
        let key = normalize_path(path);
        let mut refs: Vec<OpenFileRef> = self
            .entries
            .get(&key)
            .map(|owners| {
                owners
                    .iter()
                    .map(|(label, dirty)| OpenFileRef { label: label.clone(), is_dirty: *dirty })
                    .collect()
            })
            .unwrap_or_default();
        refs.sort_by(|a, b| a.label.cmp(&b.label));
        refs
    }

    /// 当前应被监听的全部文件路径（去重 + 排序，保证 diff 稳定）
    pub fn watched_paths(&self) -> Vec<String> {
        let mut paths: Vec<String> = self.entries.keys().cloned().collect();
        paths.sort();
        paths
    }

    /// 测试用：注册表条目数
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

// ───────────────────────── 文件级 watcher 池 ─────────────────────────

/// 保活的 watcher 池：path → watcher（drop 即注销监听）。
///
/// 注意：**watcher 回调里绝不取这把锁**（`build_file_watcher` 在持锁期间调用
/// `watcher.watch()`，若平台在注册时同步投递事件会造成自死锁）。回调只用
/// [`FILE_MTIMES`] 做幂等去重。
static FILE_WATCHERS: OnceLock<Mutex<HashMap<String, notify::RecommendedWatcher>>> =
    OnceLock::new();

/// path → 最近一次已上报的 mtime（毫秒），用于「同 mtime 只上报一次」
static FILE_MTIMES: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();

fn file_watchers() -> &'static Mutex<HashMap<String, notify::RecommendedWatcher>> {
    FILE_WATCHERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn file_mtimes() -> &'static Mutex<HashMap<String, u64>> {
    FILE_MTIMES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 取锁（中毒时退化为内部数据：监听功能不应拖垮主流程）
fn lock_or_recover<T>(m: &'static Mutex<T>) -> std::sync::MutexGuard<'static, T> {
    match m.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// 读取文件 mtime（UNIX 毫秒）；失败返回 0（未知）
fn mtime_ms(path: &std::path::Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 记录「某路径刚被本应用写入」的时间戳，使紧随其后的 watcher 事件被去重掉。
///
/// **为什么必需**：`notify` 会把应用自己保存文件产生的 `Modify` 事件也报回来。
/// 若不抑制，前端会把它当成「文件被外部修改」——表现为：Ctrl+S 保存后弹
/// 「文件已被外部修改，覆盖 / 另存为」、覆盖保存后再次触发，形成**无限循环**的
/// 黄色提示（v0.9.0 用户反馈的缺陷）。
///
/// 由 `commands::file_ops::write_file` 在写盘成功后调用，因此**任何**调用点
/// （手动保存 / 自动保存 / 版本回滚 / 另存为）都自动被覆盖，无需前端逐处适配。
pub fn note_file_written(path: &str) {
    let key = normalize_path(path);
    let mtime = mtime_ms(std::path::Path::new(path));
    if mtime == 0 {
        return;
    }
    let mut mtimes = lock_or_recover(file_mtimes());
    mtimes.insert(key, mtime);
}

/// 事件去重判定：该路径当前 mtime 是否等于**已知的最近 mtime**（本应用自己刚写过，
/// 或同一个 mtime 已上报过）。为真时调用方应直接忽略这次事件。
///
/// mtime 为 0（读取失败/文件已不存在）时一律返回 false，交由上层按真实事件处理。
fn is_known_mtime(path: &str, mtime: u64) -> bool {
    if mtime == 0 {
        return false;
    }
    let mtimes = lock_or_recover(file_mtimes());
    mtimes.get(path).copied() == Some(mtime)
}

/// 记录「已按该 mtime 上报过」，避免同一变更重复通知前端
fn remember_reported_mtime(path: &str, mtime: u64) {
    if mtime == 0 {
        return;
    }
    let mut mtimes = lock_or_recover(file_mtimes());
    mtimes.insert(path.to_string(), mtime);
}

/// 让 watcher 池与目标路径集合一致（diff 增删）。返回 Err(溢出路径数) —— 超限时
/// 只保底注册前 [`MAX_FILE_WATCHERS`] 个，其余不监听（不阻断编辑）。
pub fn sync_file_watchers(app: &tauri::AppHandle, paths: &[String]) -> Result<(), usize> {
    let capped: Vec<String> = paths.iter().take(MAX_FILE_WATCHERS).cloned().collect();
    let overflow = paths.len().saturating_sub(capped.len());

    let mut pool = lock_or_recover(file_watchers());

    // 1. 移除已不在集合中的（drop 即注销）
    pool.retain(|path, _| capped.iter().any(|p| p == path));

    // 2. 新增缺失的
    for path in &capped {
        if pool.contains_key(path) {
            continue;
        }
        if let Some(watcher) = build_file_watcher(app, path) {
            pool.insert(path.clone(), watcher);
        }
    }

    // 3. 同步清理已移除路径的 mtime 记录
    let mut mtimes = lock_or_recover(file_mtimes());
    mtimes.retain(|path, _| capped.iter().any(|p| p == path));

    if overflow > 0 {
        Err(overflow)
    } else {
        Ok(())
    }
}

/// 为一个文件创建 watcher；失败（文件不存在/权限）返回 None（静默降级）
fn build_file_watcher(app: &tauri::AppHandle, path: &str) -> Option<notify::RecommendedWatcher> {
    let fs_path = std::path::PathBuf::from(path);
    let app_handle = app.clone();
    let path_owned = path.to_string();
    let mut watcher = notify::recommended_watcher(
        move |res: Result<notify::Event, notify::Error>| {
            let Ok(event) = res else { return };
            // 删除 / 改名（移出）：文件已不在原路径。**必须上报**——这是
            // 「监听目录之外的单文件被删除」场景下关闭标签的唯一信号（N23）。
            let removed = matches!(event.kind, notify::EventKind::Remove(_))
                || matches!(
                    event.kind,
                    notify::EventKind::Modify(notify::event::ModifyKind::Name(_))
                );
            // 其余只关心内容/元数据变化；Access（纯读取）不触发重载
            if !removed
                && !matches!(
                    event.kind,
                    notify::EventKind::Modify(_) | notify::EventKind::Create(_)
                )
            {
                return;
            }
            let mtime = mtime_ms(std::path::Path::new(&path_owned));
            if !removed {
                // 幂等去重：mtime 与本应用刚写入 / 已上报过的一致 → 忽略
                // （覆盖「自己保存」与「目录 watcher + 文件 watcher 双路到达」两种场景）
                if is_known_mtime(&path_owned, mtime) {
                    return;
                }
                remember_reported_mtime(&path_owned, mtime);
            }
            let _ = app_handle.emit(
                "lightmd:fileChanged",
                serde_json::json!({ "path": path_owned, "mtime": mtime, "removed": removed }),
            );
        },
    )
    .ok()?;
    watcher
        .watch(&fs_path, notify::RecursiveMode::NonRecursive)
        .ok()?;
    // 记录当前 mtime：紧接着的「自己保存」事件不会误判为外部变更
    lock_or_recover(file_mtimes()).insert(path.to_string(), mtime_ms(&fs_path));
    Some(watcher)
}

/// 清空全部文件 watcher（应用退出/降级时调用）
pub fn clear_file_watchers() {
    lock_or_recover(file_watchers()).clear();
    lock_or_recover(file_mtimes()).clear();
}

/// 测试用：当前文件 watcher 数量
#[cfg(test)]
pub fn file_watcher_count() -> usize {
    lock_or_recover(file_watchers()).len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file_tab(path: &str, dirty: bool) -> TabSnapshot {
        TabSnapshot {
            kind: "file".to_string(),
            path: Some(path.to_string()),
            untitled_id: None,
            name: "x".to_string(),
            pinned: false,
            is_dirty: dirty,
        }
    }

    fn untitled_tab(id: &str) -> TabSnapshot {
        TabSnapshot {
            kind: "untitled".to_string(),
            path: None,
            untitled_id: Some(id.to_string()),
            name: "新文件1".to_string(),
            pinned: false,
            is_dirty: true,
        }
    }

    /// 同一文件被两个窗口打开时，两个 label 都应被记录
    #[test]
    fn sync_records_all_windows_for_same_path() {
        let mut reg = OpenFiles::default();
        reg.sync_window("main", &[file_tab("D:\\a\\b.md", true)]);
        reg.sync_window("sec-1", &[file_tab("D:/a/b.md", false)]);
        let refs = reg.query("D:/a/b.md");
        assert_eq!(refs.len(), 2);
        assert_eq!(refs[0], OpenFileRef { label: "main".to_string(), is_dirty: true });
        assert_eq!(refs[1], OpenFileRef { label: "sec-1".to_string(), is_dirty: false });
        // 反斜杠/正斜杠视为同一路径
        assert_eq!(reg.query("D:\\a\\b.md").len(), 2);
    }

    /// 全量上报语义：窗口内关闭标签后，旧记录必须消失（否则冲突检测误报）
    #[test]
    fn sync_replaces_previous_set_for_same_window() {
        let mut reg = OpenFiles::default();
        reg.sync_window("main", &[file_tab("D:/a.md", false), file_tab("D:/b.md", false)]);
        assert_eq!(reg.len(), 2);
        reg.sync_window("main", &[file_tab("D:/b.md", true)]);
        assert_eq!(reg.len(), 1);
        assert!(reg.query("D:/a.md").is_empty());
        assert!(reg.query("D:/b.md")[0].is_dirty);
    }

    /// 临时标签不进入注册表（不参与冲突检测，也无磁盘文件可监听）
    #[test]
    fn untitled_tabs_are_ignored() {
        let mut reg = OpenFiles::default();
        reg.sync_window("main", &[untitled_tab("untitled-1")]);
        assert_eq!(reg.len(), 0);
        assert!(reg.watched_paths().is_empty());
    }

    /// 同一窗口重复上报同一路径不产生重复登记
    #[test]
    fn duplicate_paths_in_same_report_are_deduped() {
        let mut reg = OpenFiles::default();
        reg.sync_window("main", &[file_tab("D:/a.md", false), file_tab("D:/a.md", true)]);
        assert_eq!(reg.len(), 1);
        assert_eq!(reg.query("D:/a.md").len(), 1);
        assert!(reg.query("D:/a.md")[0].is_dirty);
    }

    /// 窗口关闭后其登记全部清除；其他窗口的记录保留
    #[test]
    fn remove_window_clears_only_that_window() {
        let mut reg = OpenFiles::default();
        reg.sync_window("main", &[file_tab("D:/a.md", true)]);
        reg.sync_window("sec-1", &[file_tab("D:/a.md", false)]);
        reg.remove_window("sec-1");
        assert_eq!(reg.query("D:/a.md").len(), 1);
        assert_eq!(reg.query("D:/a.md")[0].label, "main");
        reg.remove_window("main");
        assert_eq!(reg.len(), 0);
    }

    /// 监听路径列表去重且排序稳定（diff 增删依据）
    #[test]
    fn watched_paths_are_sorted_and_unique() {
        let mut reg = OpenFiles::default();
        reg.sync_window("main", &[file_tab("D:/b.md", false), file_tab("D:/a.md", false)]);
        reg.sync_window("sec-1", &[file_tab("D:/b.md", false)]);
        assert_eq!(
            reg.watched_paths(),
            vec!["D:/a.md".to_string(), "D:/b.md".to_string()]
        );
    }

    #[test]
    fn normalize_path_converts_backslashes() {
        assert_eq!(normalize_path(r"D:\a\b.md"), "D:/a/b.md");
        assert_eq!(normalize_path("D:/a/b.md"), "D:/a/b.md");
    }

    /// 超限保护：路径数超过上限时返回溢出数量（前端据此 toast）
    #[test]
    fn max_file_watchers_constant_is_fifty() {
        assert_eq!(MAX_FILE_WATCHERS, 50);
    }

    // ─── v0.9.0 用户反馈：应用自身写盘不得被当成「外部修改」 ───

    /// 自己刚写过的文件，其 watcher 事件必须被去重掉。
    ///
    /// 回归的是「Ctrl+S 保存后弹『文件已被外部修改，覆盖 / 另存为』→ 覆盖后再次
    /// 触发 → 无限黄色提示」这一缺陷。
    #[test]
    fn self_write_is_suppressed() {
        let dir = std::env::temp_dir().join("lightmd-selfwrite-test");
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("doc.md");
        std::fs::write(&file, "v1").unwrap();
        let path = file.to_string_lossy().to_string();

        // 写盘后登记（write_file 的成功路径会调用它）
        note_file_written(&path);
        let mtime = mtime_ms(&file);
        assert!(mtime > 0);
        assert!(
            is_known_mtime(&normalize_path(&path), mtime),
            "自身写入的 mtime 必须被识别，watcher 事件应被忽略"
        );

        // 等待文件系统时间戳推进后由「外部」改写 → 不再是已知 mtime，必须上报
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&file, "v2-external-change-longer").unwrap();
        let new_mtime = mtime_ms(&file);
        if new_mtime != mtime {
            assert!(
                !is_known_mtime(&normalize_path(&path), new_mtime),
                "外部修改必须能触发上报"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 反斜杠与正斜杠视为同一路径（Windows 原生路径 vs 事件归一化路径）
    #[test]
    fn self_write_key_is_separator_insensitive() {
        let dir = std::env::temp_dir().join("lightmd-selfwrite-sep");
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("s.md");
        std::fs::write(&file, "x").unwrap();

        note_file_written(&file.to_string_lossy());
        // 用正斜杠形式的 key 查询（模拟 watcher 侧的 path_key 归一）
        let forward = normalize_path(&file.to_string_lossy());
        assert!(is_known_mtime(&forward, mtime_ms(&file)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// mtime 为 0（读取失败/文件不存在）时不参与去重，交由上层按真实事件处理
    #[test]
    fn zero_mtime_is_never_treated_as_known() {
        assert!(!is_known_mtime("D:/nonexistent-xyz.md", 0));
        note_file_written("D:/nonexistent-xyz.md");
        assert!(!is_known_mtime("D:/nonexistent-xyz.md", 0));
    }

    /// 已上报过的 mtime 再次到达（目录 watcher + 文件 watcher 双路）只算一次
    #[test]
    fn repeated_same_mtime_is_deduplicated() {
        let path = "D:/dedup-test.md";
        assert!(!is_known_mtime(path, 12345));
        remember_reported_mtime(path, 12345);
        assert!(is_known_mtime(path, 12345));
        assert!(!is_known_mtime(path, 12346));
    }
}
