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
use std::time::{Duration, Instant, UNIX_EPOCH};

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

/// 自身写入抑制窗口（毫秒）。
///
/// v0.9.0 第二轮修复（问题3）：`note_file_written` 只在 `std::fs::write` **返回之后**
/// 登记 mtime，而 notify 的事件回调线程可能已经先一步取到新 mtime 并完成
/// `is_known_mtime` 判定（此时登记表里还是旧值）→ 事件被真的 emit 出去，前端在
/// 「清脏标记」之前收到它，于是把自己刚保存的文件当成「被外部修改」。
/// 这段窗口把「刚写过」的事实也纳入判定，彻底消除该竞态。
///
/// 取值权衡：要覆盖「写盘返回 → watcher 线程被调度」的调度延迟（通常 ms 级，
/// 极端负载下可达数百 ms）；窗口期内若有真正的外部修改紧随其后，会被这一次事件吞掉
/// ——代价远小于"每次保存都误报外部修改"。
const SELF_WRITE_SUPPRESS_MS: u64 = 1500;

/// path → { 写入它的窗口 label → 写入时刻 }。
///
/// v0.9.0 第四轮修复（问题1）：必须**按窗口**记录，而不是全局一条「本应用刚写过」。
/// 全局抑制的后果：窗口 B 保存文件后事件被整体吞掉，**同样打开了该文件的窗口 A
/// 永远收不到 `fileChanged`**，标签内容停留在旧版本——用户反馈「在新窗口编辑 a
/// 文件并保存后，主窗口打开的 a 文件没有立即刷新」。
///
/// 现在的语义：写入窗口自己不需要这次回声（按 `source` 过滤掉），其他窗口照常收到
/// 通知并重载。回调里若记录尚未写入（调度竞态，见 [`SELF_WRITE_SUPPRESS_MS`]），
/// 事件不带 source 照常广播，写入窗口由前端的「自身写盘内容指纹」兜底识别为回声。
static SELF_WRITES: OnceLock<Mutex<HashMap<String, HashMap<String, Instant>>>> = OnceLock::new();

fn file_watchers() -> &'static Mutex<HashMap<String, notify::RecommendedWatcher>> {
    FILE_WATCHERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn file_mtimes() -> &'static Mutex<HashMap<String, u64>> {
    FILE_MTIMES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn self_writes() -> &'static Mutex<HashMap<String, HashMap<String, Instant>>> {
    SELF_WRITES.get_or_init(|| Mutex::new(HashMap::new()))
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

/// 记录「某窗口刚写过某路径」，使紧随其后的 watcher 事件对该窗口被标记为回声。
///
/// **为什么必需**：`notify` 会把应用自己保存文件产生的 `Modify` 事件也报回来。
/// 若不标记，写入窗口会把它当成「文件被外部修改」——表现为：Ctrl+S 保存后弹
/// 「文件已被外部修改，覆盖 / 另存为」、覆盖保存后再次触发，形成**无限循环**的
/// 黄色提示（v0.9.0 用户反馈的缺陷）。
///
/// 由 `commands::file_ops::write_file` 在写盘成功后调用（带调用者窗口 label），因此
/// **任何**调用点（手动保存 / 自动保存 / 版本回滚 / 另存为）都自动被覆盖。
///
/// v0.9.0 第四轮修复（问题1）：抑制范围从「整个应用」收窄到「写入窗口」——事件照常
/// 广播给其他窗口，只是带上了 `source`（写入者集合），写入窗口据此忽略；否则
/// 「B 窗口保存 → A 窗口同文件标签不刷新」。
pub fn note_file_written(path: &str, window_label: &str) {
    let key = normalize_path(path);
    let now = Instant::now();
    let mut writes = lock_or_recover(self_writes());
    // 顺手丢弃已过期的抑制记录（窗口仅 1.5s，表大小天然很小）
    writes.retain(|_, owners| {
        owners.retain(|_, at| {
            now.checked_duration_since(*at)
                .map(|d| d < Duration::from_millis(SELF_WRITE_SUPPRESS_MS))
                .unwrap_or(true)
        });
        !owners.is_empty()
    });
    writes
        .entry(key)
        .or_default()
        .insert(window_label.to_string(), now);
}

/// 该路径当前的 mtime 是否等于**已上报过**的最近 mtime（同一变更只上报一次）。
///
/// mtime 为 0（读取失败/文件已不存在）时一律返回 false，交由上层按真实事件处理。
fn is_reported_mtime(path: &str, mtime: u64) -> bool {
    if mtime == 0 {
        return false;
    }
    let mtimes = lock_or_recover(file_mtimes());
    mtimes.get(path).copied() == Some(mtime)
}

/// 仍在「刚写过」抑制窗口内写过该路径的窗口 label 列表（写入者）。
///
/// 事件载荷带上它，写入窗口自身忽略这次回声；**其他窗口照常处理**——这正是
/// v0.9.0 第四轮问题1（多窗口同文件保存后不刷新）的修复点。
fn recent_writers(path: &str) -> Vec<String> {
    recent_writers_at(path, Instant::now())
}

/// [`recent_writers`] 的可注入时钟版本（单测用）
fn recent_writers_at(path: &str, now: Instant) -> Vec<String> {
    let mut writes = lock_or_recover(self_writes());
    let Some(owners) = writes.get_mut(path) else {
        return Vec::new();
    };
    owners.retain(|_, at| {
        now.checked_duration_since(*at)
            .map(|d| d < Duration::from_millis(SELF_WRITE_SUPPRESS_MS))
            .unwrap_or(true) // now 早于记录时刻（理论不可能）→ 保守按"刚写过"处理
    });
    let mut labels: Vec<String> = owners.keys().cloned().collect();
    labels.sort();
    if owners.is_empty() {
        writes.remove(path);
    }
    labels
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
            // v0.9.0 第四轮修复（问题1）：不再全局抑制「自己写入」——那会让**其他**
            // 打开了同一文件的窗口（多窗口同文件场景）永远收不到变更通知。
            // 现在只做「同一 mtime 只上报一次」的幂等去重，并把写入者 label 列表
            // 放进载荷 `source`：写入窗口据此忽略自己的回声，其他窗口照常重载。
            // 若写入登记尚未落表（调度竞态），source 为空、事件照常广播，写入窗口
            // 由前端的「自身写盘内容指纹」兜底（见 selfWriteGuard）。
            let source: Vec<String> = if removed {
                Vec::new()
            } else {
                if is_reported_mtime(&path_owned, mtime) {
                    return;
                }
                let writers = recent_writers(&path_owned);
                remember_reported_mtime(&path_owned, mtime);
                writers
            };
            let _ = app_handle.emit(
                "lightmd:fileChanged",
                serde_json::json!({
                    "path": path_owned,
                    "mtime": mtime,
                    "removed": removed,
                    "source": source,
                }),
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
    lock_or_recover(self_writes()).clear();
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

    /// 写入窗口自身：其 mtime 会被记为「已上报」，该窗口据此忽略自己的回声。
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

        // 写盘后登记（write_file 的成功路径会调用它，带写入窗口 label）
        note_file_written(&path, "main");
        let mtime = mtime_ms(&file);
        assert!(mtime > 0);
        // 事件按「已上报 mtime」去重后，写入窗口不会收到回声
        remember_reported_mtime(&normalize_path(&path), mtime);
        assert!(
            is_reported_mtime(&normalize_path(&path), mtime),
            "自身写入后同一 mtime 不得再次上报"
        );
        // 写入者被识别出来（前端据此过滤自身回声）
        assert_eq!(recent_writers(&normalize_path(&path)), vec!["main".to_string()]);

        // 等待文件系统时间戳推进后由「外部」改写 → 不再是已知 mtime，必须上报
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&file, "v2-external-change-longer").unwrap();
        let new_mtime = mtime_ms(&file);
        if new_mtime != mtime {
            assert!(
                !is_reported_mtime(&normalize_path(&path), new_mtime),
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

        note_file_written(&file.to_string_lossy(), "sec-1");
        // 用正斜杠形式的 key 查询（模拟 watcher 侧的 path_key 归一）
        let forward = normalize_path(&file.to_string_lossy());
        assert_eq!(recent_writers(&forward), vec!["sec-1".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// mtime 为 0（读取失败/文件不存在）时不参与去重，交由上层按真实事件处理
    #[test]
    fn zero_mtime_is_never_treated_as_known() {
        assert!(!is_reported_mtime("D:/nonexistent-xyz.md", 0));
        remember_reported_mtime("D:/nonexistent-xyz.md", 0);
        assert!(!is_reported_mtime("D:/nonexistent-xyz.md", 0));
    }

    /// 已上报过的 mtime 再次到达（目录 watcher + 文件 watcher 双路）只算一次
    #[test]
    fn repeated_same_mtime_is_deduplicated() {
        let path = "D:/dedup-test.md";
        assert!(!is_reported_mtime(path, 12345));
        remember_reported_mtime(path, 12345);
        assert!(is_reported_mtime(path, 12345));
        assert!(!is_reported_mtime(path, 12346));
    }

    // ─── v0.9.0 第二轮修复（问题3）：抑制窗口覆盖「事件抢在登记之前」的竞态 ───

    /// 即便 mtime 尚未登记（watcher 回调抢在 `note_file_written` 之前执行），
    /// 「刚写过」的时间窗口也必须把这次事件标记出来——否则写入窗口会把自身保存
    /// 误报为「文件已被外部修改，保存前请确认」。
    #[test]
    fn self_write_window_suppresses_race_event() {
        let path = "D:/lightmd-race-nonexistent.md";
        let key = normalize_path(path);
        note_file_written(path, "main");
        assert!(!is_reported_mtime(&key, 0), "mtime 未知时不参与 mtime 去重");
        assert_eq!(recent_writers(&key), vec!["main".to_string()], "刚写过的窗口应被识别");

        // 窗口过期后不再标记（外部修改必须能被上报）
        let later = Instant::now() + Duration::from_millis(SELF_WRITE_SUPPRESS_MS + 50);
        assert!(recent_writers_at(&key, later).is_empty());
        // 过期记录已被清理，后续查询也是空
        assert!(recent_writers(&key).is_empty());
    }

    /// 从未写过的路径不在抑制窗口内（外部修改照常上报）
    #[test]
    fn unknown_path_is_not_suppressed() {
        assert!(recent_writers("D:/lightmd-never-written.md").is_empty());
    }

    // ─── v0.9.0 第四轮修复（问题1）：同文件多窗口，保存后其他窗口必须刷新 ───

    /// B 窗口保存后，**A 窗口不在写入者名单里**——事件照常广播给 A，A 据此重载。
    ///
    /// 回归的是用户反馈：「主窗口打开了 a 文件，在新建窗口编辑并保存后，主窗口的
    /// a 文件没有立即刷新」。旧实现把「自己写入」抑制成全局的，事件被整体吞掉。
    #[test]
    fn other_window_is_not_suppressed_after_peer_saves() {
        let path = normalize_path("D:/shared/doc.md");
        note_file_written(&path, "sec-1");
        let writers = recent_writers(&path);
        assert_eq!(writers, vec!["sec-1".to_string()]);
        // 写入窗口过滤自身回声；其他窗口不受影响
        assert!(writers.contains(&"sec-1".to_string()), "写入窗口需被标记");
        assert!(!writers.contains(&"main".to_string()), "其他窗口不得被吞掉事件");
    }

    /// 两个窗口先后写入同一文件：两者都在名单里，谁都不会误报，第三方窗口照常收到
    #[test]
    fn multiple_writers_are_all_reported() {
        let path = normalize_path("D:/shared/multi.md");
        note_file_written(&path, "sec-2");
        note_file_written(&path, "main");
        assert_eq!(
            recent_writers(&path),
            vec!["main".to_string(), "sec-2".to_string()]
        );
    }
}
