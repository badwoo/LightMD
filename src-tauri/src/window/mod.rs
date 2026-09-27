//! v0.9.0 多窗口：窗口管理器（固定槽位 label 方案，实施计划 §3.1）。
//!
//! ## 标签空间
//!
//! `main`（tauri.conf.json 默认窗口）+ `sec-1` ~ `sec-7`，共 [`MAX_WINDOWS`] 个。
//! 分配规则：取最小未占用槽位；窗口关闭释放槽位。
//!
//! 固定槽位带来三个收益（替代 PRD 的 nanoid 随机 label）：
//! 1. 窗口级 localStorage key（`-sec-N` 后缀）为有限集合，无 GC 负担；
//! 2. `tauri-plugin-window-state` 按 label 记录几何 → 槽位复用即几何跨会话恢复，
//!    故 `session.json` **不存几何**（避免双轨打架）；
//! 3. 会话恢复直接复用旧 label，临时标签/滚动进度等按 label 存储的数据不丢。
//!
//! ## 职责
//!
//! - 槽位分配/释放、Primary 追踪与晋升、`ever_multi_window` 标记；
//! - 各窗口上报的标签/文件夹概要（窗口菜单列表 + 会话快照数据源）；
//! - 跨窗口的文件打开登记（[`open_files::OpenFiles`]，冲突检测 + 文件级监听）。
//!
//! ## 并发约定
//!
//! [`AppWindowManager`] 是 `Mutex<WindowManager>`。**任何持锁期间都不得调用会阻塞
//! 主线程的 API**（`WebviewWindowBuilder::build` / `set_focus` 等）——主线程同时会
//! 在 `CloseRequested` 回调里取同一把锁，持锁阻塞主线程会造成死锁。
//! 因此创建窗口采用「先 reserve 槽位 → 释放锁 → build → 再取锁登记」的两段式。

pub mod open_files;
pub mod session;

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use open_files::OpenFiles;
pub use session::{SessionSnapshot, TabSnapshot, WindowSession};

/// 主窗口 label（tauri.conf.json 未指定 label，Tauri 默认即 "main"）
pub const PRIMARY_LABEL: &str = "main";

/// 窗口上限（产品决策：main + sec-1 ~ sec-7 = 8）
pub const MAX_WINDOWS: usize = 8;

/// 新建辅助窗口的默认尺寸（与主窗口配置一致的无边框窗口）
const SECONDARY_WIDTH: f64 = 1000.0;
const SECONDARY_HEIGHT: f64 = 700.0;
const SECONDARY_MIN_WIDTH: f64 = 600.0;
const SECONDARY_MIN_HEIGHT: f64 = 400.0;
/// 新窗口相对主窗口的级联偏移步长（逻辑像素）
const CASCADE_STEP: f64 = 32.0;

/// 窗口上限提示（前端按 `LIMIT|` 前缀转 toast；其它 `Err` 为真实故障）
pub const ERR_WINDOW_LIMIT: &str = "LIMIT|窗口数量已达上限（最多 8 个）";

/// 当前 UNIX 毫秒时间戳
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 窗口元数据
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowMeta {
    pub label: String,
    pub created_at: u64,
}

/// 由其他窗口迁移过来的标签（「移动到新窗口」/「合并到主窗口」）。
///
/// 真实文件只带 `path`；临时标签带 `content`（未落盘，只能随载荷搬运）。
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MovedTab {
    /// Some = 真实文件；None = 临时标签
    #[serde(default)]
    pub path: Option<String>,
    pub name: String,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub is_dirty: bool,
    #[serde(default)]
    pub is_untitled: bool,
    #[serde(default)]
    pub pinned: bool,
    /// 临时标签 id（迁移后保持同一 id，滚动进度键连续）
    #[serde(default)]
    pub untitled_id: Option<String>,
}

/// 新窗口挂载后通过 `take_window_boot` 取走的引导数据。
///
/// 采用「新窗口主动取」而不是「Rust 延时 emit」：彻底消除 sleep + 事件丢失竞态
/// （实施计划 P2 的修正）。
#[derive(Default, Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBoot {
    pub label: String,
    pub is_primary: bool,
    /// 会话恢复窗口：按 `get_window_session` 的返回恢复标签/文件夹
    pub restore: bool,
    /// 该槽位是首次分配（前端据此清理上一会话残留的窗口级 localStorage key）
    pub fresh: bool,
    /// 需要打开的文件（右键「在新窗口中打开」/ 外部文件策略）
    pub files: Vec<String>,
    /// 由其他窗口迁移过来的标签
    pub moved_tabs: Vec<MovedTab>,
}

/// 窗口菜单列表项
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSummary {
    pub label: String,
    pub is_primary: bool,
    pub created_at: u64,
    pub active_tab_idx: usize,
    pub tabs: Vec<TabSnapshot>,
}

pub struct WindowManager {
    /// 已存在的窗口：label → meta
    windows: HashMap<String, WindowMeta>,
    /// 正在创建中的槽位（防止并发创建抢同一 label）
    reserved: HashSet<String>,
    primary_label: String,
    /// 本会话是否出现过 ≥2 窗口（决定退出时是否写 session.json）
    ever_multi_window: bool,
    /// label → 待前端取走的引导数据
    pending_boot: HashMap<String, PendingBoot>,
    /// 已确认关闭的窗口 label（放行 CloseRequested，防重复拦截）
    approved_close: HashSet<String>,
    /// 已有未决关闭确认流程的窗口（防用户连点关闭按钮弹出多个确认框）
    close_pending: HashSet<String>,
    /// 跨窗口文件打开登记（冲突检测 + 文件级监听）
    open_files: OpenFiles,
    /// label → 该窗口最新上报的标签/文件夹/活跃下标。
    ///
    /// 只保留**存活窗口**的条目：会话快照据此生成，用户主动关闭的窗口必须从快照中
    /// 消失（否则下次启动会把已关闭的窗口复活）。
    window_state: HashMap<String, WindowSession>,
    /// 是否已就「文件监听超限」提示过（只在上升沿 emit，避免反复 toast）
    watch_limit_warned: bool,
}

#[derive(Default, Clone, Debug)]
struct PendingBoot {
    files: Vec<String>,
    restore: bool,
    moved_tabs: Vec<MovedTab>,
}

impl Default for WindowManager {
    fn default() -> Self {
        Self::new()
    }
}

impl WindowManager {
    /// 初始状态：Primary = main，但 main 尚未登记（由 `setup` 里的 `register` 完成）
    pub fn new() -> Self {
        Self {
            windows: HashMap::new(),
            reserved: HashSet::new(),
            primary_label: PRIMARY_LABEL.to_string(),
            ever_multi_window: false,
            pending_boot: HashMap::new(),
            approved_close: HashSet::new(),
            close_pending: HashSet::new(),
            open_files: OpenFiles::default(),
            window_state: HashMap::new(),
            watch_limit_warned: false,
        }
    }

    // ───────────── 槽位与登记 ─────────────

    /// 登记一个已存在的窗口。
    ///
    /// 槽位复用时会丢弃上一轮该槽位残留的上报数据——新窗口从零开始。
    pub fn register(&mut self, label: &str, created_at: u64) {
        self.reserved.remove(label);
        self.window_state.remove(label);
        // 槽位复用：清掉上一轮的关闭标记，避免新窗口首次关闭被静默放行
        self.approved_close.remove(label);
        self.close_pending.remove(label);
        self.windows.insert(
            label.to_string(),
            WindowMeta { label: label.to_string(), created_at },
        );
        if self.windows.len() >= 2 {
            self.ever_multi_window = true;
        }
    }

    pub fn contains(&self, label: &str) -> bool {
        self.windows.contains_key(label)
    }

    pub fn window_count(&self) -> usize {
        self.windows.len()
    }

    pub fn ever_multi_window(&self) -> bool {
        self.ever_multi_window
    }

    pub fn primary_label(&self) -> &str {
        &self.primary_label
    }

    /// 取最小未占用槽位 label（同时避开正在创建中的槽位）；满员返回 None
    pub fn allocate_label(&self) -> Option<String> {
        (1..MAX_WINDOWS)
            .map(|i| format!("sec-{i}"))
            .find(|label| !self.windows.contains_key(label) && !self.reserved.contains(label))
    }

    /// 预留槽位（创建窗口前调用；创建失败需 `unreserve` 回滚）
    pub fn reserve(&mut self, label: &str) {
        self.reserved.insert(label.to_string());
    }

    /// 指定 label 是否可分配（会话恢复时要求复用原 label）
    pub fn is_label_free(&self, label: &str) -> bool {
        !self.windows.contains_key(label) && !self.reserved.contains(label)
    }

    pub fn unreserve(&mut self, label: &str) {
        self.reserved.remove(label);
    }

    /// 是否达到窗口上限（含正在创建中的）
    pub fn is_full(&self) -> bool {
        self.windows.len() + self.reserved.len() >= MAX_WINDOWS
    }

    // ───────────── 引导数据 ─────────────

    pub fn set_pending_boot(
        &mut self,
        label: &str,
        files: Vec<String>,
        restore: bool,
        moved_tabs: Vec<MovedTab>,
    ) {
        self.pending_boot
            .insert(label.to_string(), PendingBoot { files, restore, moved_tabs });
    }

    /// 新窗口挂载后取走引导数据（幂等：取走后清空，重复调用返回空壳）。
    ///
    /// `fresh` = 「该槽位是本次全新分配、可以安全清理上一会话残留的窗口级 key」：
    /// 仅对非 Primary 且非会话恢复的窗口成立。Primary（main）的窗口级 key 沿用
    /// v0.8.5 的无后缀旧 key，**绝不能清理**（否则老用户数据全丢）。
    pub fn take_boot(&mut self, label: &str) -> WindowBoot {
        let pending = self.pending_boot.remove(label).unwrap_or_default();
        let is_primary = self.primary_label == label;
        WindowBoot {
            label: label.to_string(),
            is_primary,
            restore: pending.restore,
            fresh: !pending.restore && label != PRIMARY_LABEL,
            files: pending.files,
            moved_tabs: pending.moved_tabs,
        }
    }

    // ───────────── 关闭确认 ─────────────

    /// 标记「该窗口已走完前端确认流程，可直接销毁」
    pub fn approve_close(&mut self, label: &str) {
        self.approved_close.insert(label.to_string());
        self.close_pending.remove(label);
    }

    /// 取出并消费「已确认关闭」标记
    pub fn take_approved_close(&mut self, label: &str) -> bool {
        self.approved_close.remove(label)
    }

    /// 取消关闭（前端点「取消」）：清掉关闭标记与未决状态
    pub fn abort_close(&mut self, label: &str) {
        self.approved_close.remove(label);
        self.close_pending.remove(label);
    }

    /// 标记「该窗口已有未决的关闭确认流程」。
    /// 返回 true 表示这是首次进入未决态（应向前端 emit `closeRequested`）；
    /// 返回 false 表示已有未决流程（用户连点关闭按钮）——只拦截不重复派发，
    /// 避免弹出多个确认框。
    pub fn mark_close_pending(&mut self, label: &str) -> bool {
        self.close_pending.insert(label.to_string())
    }

    // ───────────── 窗口状态上报 ─────────────

    /// 更新某窗口上报的标签/文件夹（同时刷新 OPEN_FILES 登记）
    pub fn sync_window(&mut self, label: &str, report: WindowSession) {
        self.open_files.sync_window(label, &report.tabs);
        self.window_state.insert(label.to_string(), report);
    }

    /// 取某窗口最新上报的状态（会话快照要包含即将关闭的窗口）
    pub fn window_session_of(&self, label: &str) -> Option<WindowSession> {
        self.window_state.get(label).cloned()
    }

    /// 「文件监听超限」是否应当提示：只在从「正常」进入「超限」时返回 true（上升沿）
    pub fn note_watch_overflow(&mut self, overflow: bool) -> bool {
        let should_warn = overflow && !self.watch_limit_warned;
        self.watch_limit_warned = overflow;
        should_warn
    }

    /// 查询某文件被哪些窗口打开
    pub fn query_file_open(&self, path: &str) -> Vec<open_files::OpenFileRef> {
        self.open_files.query(path)
    }

    /// 当前需要文件级监听的路径集合
    pub fn watched_file_paths(&self) -> Vec<String> {
        self.open_files.watched_paths()
    }

    /// 取某窗口上报的文件夹列表（窗口关闭时按它释放 watcher 引用）
    pub fn folder_paths_of(&self, label: &str) -> Vec<String> {
        self.window_state
            .get(label)
            .map(|s| s.folder_paths.clone())
            .unwrap_or_default()
    }

    // ───────────── 关闭 / 晋升 ─────────────

    /// 移除窗口；返回其元数据与「是否原为 Primary」。
    ///
    /// **同时删除该 label 的上报数据**：会话快照只记录「退出时仍存活的窗口」，
    /// 用户主动关闭的窗口不得在下次启动时复活（v0.9.0 用户反馈修正 —— 早先为满足
    /// 「多窗口会话恢复」保留了已关闭窗口的状态，导致「新窗口打开文档 → 关掉新窗口
    /// → 重启」后那个已关闭的窗口又冒出来）。
    pub fn remove_window(&mut self, label: &str) -> (Option<WindowMeta>, bool) {
        let was_primary = self.primary_label == label;
        let meta = self.windows.remove(label);
        self.reserved.remove(label);
        self.pending_boot.remove(label);
        self.approved_close.remove(label);
        self.close_pending.remove(label);
        self.window_state.remove(label);
        self.open_files.remove_window(label);
        (meta, was_primary)
    }

    /// 彻底遗忘某槽位（窗口创建失败回滚用）
    pub fn discard(&mut self, label: &str) {
        self.remove_window(label);
    }

    /// Primary 晋升：取现有窗口中最老的一个（created_at 最小）。
    /// 返回新 Primary label（无剩余窗口时返回 None）。
    pub fn promote_primary(&mut self) -> Option<String> {
        if self.windows.contains_key(&self.primary_label) {
            return Some(self.primary_label.clone());
        }
        let oldest = self
            .windows
            .values()
            .min_by_key(|m| m.created_at)
            .map(|m| m.label.clone());
        if let Some(label) = &oldest {
            self.primary_label = label.clone();
        }
        oldest
    }

    // ───────────── 会话快照 ─────────────

    /// 生成会话快照：**只包含此刻仍存活的窗口**。
    ///
    /// 「用户主动关闭的窗口下次不复活」是 v0.9.0 用户反馈的硬要求：早先版本为满足
    /// 「多窗口会话恢复」把已关闭窗口也写进快照，导致「在新窗口打开文档 → 关掉新窗口
    /// → 重启」后那个窗口又冒出来。
    ///
    /// 想连同多个窗口一起恢复的用户，应使用「退出 LightMD」动作退出（该路径在窗口
    /// 仍存活时落盘）；按窗口逐个关闭时，已关闭者不再记录。
    ///
    /// Primary 排最前，其余按创建时间升序（恢复顺序稳定可预期）。
    pub fn snapshot_with(&self, timestamp: u64) -> SessionSnapshot {
        let primary = self.primary_label.clone();
        let mut entries: Vec<(bool, u64, WindowSession)> = self
            .windows
            .values()
            .filter_map(|meta| {
                self.window_state
                    .get(&meta.label)
                    .map(|session| (meta.label == primary, meta.created_at, session.clone()))
            })
            .collect();
        entries.sort_by(|a, b| {
            b.0.cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.label.cmp(&b.2.label))
        });
        SessionSnapshot::new(timestamp, entries.into_iter().map(|(_, _, s)| s).collect())
    }

    /// 窗口菜单列表（Primary 在前，其余按创建时间升序）
    pub fn summaries(&self) -> Vec<WindowSummary> {
        let mut metas: Vec<WindowMeta> = self.windows.values().cloned().collect();
        let primary = self.primary_label.clone();
        metas.sort_by(|a, b| {
            let a_primary = a.label == primary;
            let b_primary = b.label == primary;
            b_primary.cmp(&a_primary).then(a.created_at.cmp(&b.created_at))
        });
        metas
            .into_iter()
            .map(|meta| {
                let state = self.window_state.get(&meta.label);
                WindowSummary {
                    is_primary: meta.label == primary,
                    label: meta.label.clone(),
                    created_at: meta.created_at,
                    active_tab_idx: state.map(|s| s.active_tab_idx).unwrap_or(0),
                    tabs: state.map(|s| s.tabs.clone()).unwrap_or_default(),
                }
            })
            .collect()
    }
}

/// Tauri State 包装（`Mutex` 中毒时退化为内部数据，不 panic——窗口管理不可致命）
pub struct AppWindowManager(pub Mutex<WindowManager>);

impl Default for AppWindowManager {
    fn default() -> Self {
        Self(Mutex::new(WindowManager::new()))
    }
}

impl AppWindowManager {
    /// 取锁（中毒时仍返回内部数据：窗口管理中断会让整个应用不可用，宁可有损继续）
    pub fn lock(&self) -> std::sync::MutexGuard<'_, WindowManager> {
        match self.0.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

// ───────────────────────── 窗口创建 ─────────────────────────

/// 计算新辅助窗口的级联位置（相对主窗口右下偏移，槽位越大越靠右下）。
/// 主窗口不可用或位置非法时返回 None（交给系统决定位置）。
fn cascade_position(app: &AppHandle, label: &str) -> Option<(f64, f64)> {
    let slot: f64 = label.strip_prefix("sec-")?.parse().ok()?;
    let primary = app.get_webview_window(PRIMARY_LABEL)?;
    let pos = primary.outer_position().ok()?;
    let scale = primary.scale_factor().unwrap_or(1.0);
    let offset = CASCADE_STEP * slot;
    Some((
        (pos.x as f64 + offset) / scale,
        (pos.y as f64 + offset) / scale,
    ))
}

/// 创建无边框辅助窗口（与主窗口配置一致；几何由 window-state 插件按 label 恢复）
pub fn build_secondary_window(app: &AppHandle, label: &str) -> Result<WebviewWindow, String> {
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("LightMD")
        .inner_size(SECONDARY_WIDTH, SECONDARY_HEIGHT)
        .min_inner_size(SECONDARY_MIN_WIDTH, SECONDARY_MIN_HEIGHT)
        .decorations(false)
        .resizable(true);
    if let Some((x, y)) = cascade_position(app, label) {
        builder = builder.position(x, y);
    }
    builder
        .build()
        .map_err(|e| format!("创建窗口失败: {}", e))
}

/// 把 Primary 变更通知给晋升后的窗口（前端据此更新 UI 提示）
pub fn emit_became_primary(app: &AppHandle, label: &str) {
    let _ = app.emit_to(label, "lightmd:becamePrimary", serde_json::json!({ "label": label }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use session::TabSnapshot;

    fn tab(path: &str) -> TabSnapshot {
        TabSnapshot {
            kind: "file".to_string(),
            path: Some(path.to_string()),
            untitled_id: None,
            name: path.to_string(),
            pinned: false,
            is_dirty: false,
        }
    }

    fn report(label: &str, paths: &[&str]) -> WindowSession {
        WindowSession {
            label: label.to_string(),
            active_tab_idx: 0,
            tabs: paths.iter().map(|p| tab(p)).collect(),
            folder_paths: vec![],
        }
    }

    /// 槽位按最小可用分配；关闭后槽位复用
    #[test]
    fn allocates_lowest_free_slot_and_reuses_after_close() {
        let mut mgr = WindowManager::new();
        mgr.register(PRIMARY_LABEL, 1);
        assert_eq!(mgr.allocate_label().as_deref(), Some("sec-1"));
        mgr.reserve("sec-1");
        assert_eq!(mgr.allocate_label().as_deref(), Some("sec-2"));
        mgr.register("sec-1", 2);
        mgr.unreserve("sec-2");
        assert_eq!(mgr.allocate_label().as_deref(), Some("sec-2"));
        // 关闭 sec-1 → 槽位回到可用池
        mgr.remove_window("sec-1");
        assert_eq!(mgr.allocate_label().as_deref(), Some("sec-1"));
    }

    /// 上限：main + sec-1..sec-7 = 8，第 9 个窗口无槽位
    #[test]
    fn window_limit_is_eight() {
        let mut mgr = WindowManager::new();
        mgr.register(PRIMARY_LABEL, 0);
        for i in 1..MAX_WINDOWS {
            let label = format!("sec-{i}");
            mgr.reserve(&label);
            mgr.register(&label, i as u64);
        }
        assert_eq!(mgr.window_count(), MAX_WINDOWS);
        assert!(mgr.is_full());
        assert!(mgr.allocate_label().is_none());
    }

    /// 预留中的槽位不会被重复分配（并发创建保护）
    #[test]
    fn reserved_slots_are_not_allocated_twice() {
        let mut mgr = WindowManager::new();
        mgr.reserve("sec-1");
        assert_eq!(mgr.allocate_label().as_deref(), Some("sec-2"));
        mgr.unreserve("sec-1");
        assert_eq!(mgr.allocate_label().as_deref(), Some("sec-1"));
    }

    /// Primary 关闭后由最老的辅助窗口晋升
    #[test]
    fn promote_picks_oldest_remaining_window() {
        let mut mgr = WindowManager::new();
        mgr.register(PRIMARY_LABEL, 1);
        mgr.register("sec-2", 30);
        mgr.register("sec-1", 20);
        assert_eq!(mgr.primary_label(), "main");
        mgr.remove_window(PRIMARY_LABEL);
        assert_eq!(mgr.promote_primary().as_deref(), Some("sec-1"));
        assert_eq!(mgr.primary_label(), "sec-1");
        // 再次调用（Primary 仍存在）不重复晋升
        assert_eq!(mgr.promote_primary().as_deref(), Some("sec-1"));
    }

    /// 最后一个窗口关闭 → 无晋升目标
    #[test]
    fn promote_returns_none_when_no_window_left() {
        let mut mgr = WindowManager::new();
        mgr.register(PRIMARY_LABEL, 1);
        mgr.remove_window(PRIMARY_LABEL);
        assert_eq!(mgr.promote_primary(), None);
    }

    /// ever_multi_window：只有真的同时在过 2 个窗口才置位
    #[test]
    fn ever_multi_window_only_after_two_live_windows() {
        let mut mgr = WindowManager::new();
        mgr.register(PRIMARY_LABEL, 1);
        assert!(!mgr.ever_multi_window());
        mgr.register("sec-1", 2);
        assert!(mgr.ever_multi_window());
        // 标记只增不减（关掉辅助窗口后仍是「多窗口会话」）
        mgr.remove_window("sec-1");
        assert!(mgr.ever_multi_window());
    }

    /// 会话快照：Primary 排最前，其余按创建时间升序；未上报状态的窗口被跳过
    #[test]
    fn snapshot_orders_primary_first_then_by_creation() {
        let mut mgr = WindowManager::new();
        mgr.register(PRIMARY_LABEL, 10);
        mgr.register("sec-1", 20);
        mgr.register("sec-2", 30);
        mgr.sync_window("sec-2", report("sec-2", &["D:/c.md"]));
        mgr.sync_window(PRIMARY_LABEL, report(PRIMARY_LABEL, &["D:/a.md"]));
        mgr.sync_window("sec-1", report("sec-1", &["D:/b.md"]));
        let snap = mgr.snapshot_with(99);
        let labels: Vec<&str> = snap.windows.iter().map(|w| w.label.as_str()).collect();
        assert_eq!(labels, vec!["main", "sec-1", "sec-2"]);
        assert_eq!(snap.timestamp, 99);
        assert!(snap.is_multi_window());
    }

    /// 会话快照只含存活窗口：用户主动关闭的窗口**不得**在下次启动时复活
    /// （v0.9.0 用户反馈：新窗口打开文档 → 关掉新窗口 → 重启后它又出现了）
    #[test]
    fn snapshot_excludes_closed_windows() {
        let mut mgr = WindowManager::new();
        mgr.register(PRIMARY_LABEL, 1);
        mgr.register("sec-1", 2);
        mgr.sync_window(PRIMARY_LABEL, report(PRIMARY_LABEL, &["D:/a.md"]));
        mgr.sync_window("sec-1", report("sec-1", &["D:/b.md"]));
        assert_eq!(mgr.snapshot_with(1).windows.len(), 2);

        // 用户主动关闭 sec-1 → 快照里只剩 main
        mgr.remove_window("sec-1");
        let snap = mgr.snapshot_with(2);
        assert_eq!(snap.windows.len(), 1);
        assert_eq!(snap.windows[0].label, PRIMARY_LABEL);
        // ever_multi_window 仍为真（决定退出时是否写会话文件）
        assert!(mgr.ever_multi_window());
    }

    /// 槽位复用：新窗口在该 label 上的上报数据从零开始（不带上一轮残留）
    #[test]
    fn slot_reuse_starts_from_clean_state() {
        let mut mgr = WindowManager::new();
        mgr.register(PRIMARY_LABEL, 1);
        mgr.register("sec-1", 2);
        mgr.sync_window("sec-1", report("sec-1", &["D:/b.md"]));
        mgr.remove_window("sec-1");
        mgr.register("sec-1", 50);
        // 尚未上报状态 → 快照里虽包含该 label，但标签为空（不是上一轮的 b.md）
        let snap = mgr.snapshot_with(3);
        let sec = snap.windows.iter().find(|w| w.label == "sec-1");
        assert!(sec.is_none(), "未上报状态的窗口不进入快照（避免写入空壳条目）");
        mgr.sync_window("sec-1", report("sec-1", &[]));
        let snap2 = mgr.snapshot_with(4);
        let sec2 = snap2.windows.iter().find(|w| w.label == "sec-1").unwrap();
        assert!(sec2.tabs.is_empty());
    }

    /// 引导数据取走即清空（幂等，避免重复打开文件）
    #[test]
    fn take_boot_is_consumed_once() {
        let mut mgr = WindowManager::new();
        mgr.register(PRIMARY_LABEL, 1);
        mgr.register("sec-1", 2);
        mgr.set_pending_boot("sec-1", vec!["D:/a.md".to_string()], false, vec![]);
        let boot = mgr.take_boot("sec-1");
        assert_eq!(boot.files, vec!["D:/a.md".to_string()]);
        assert_eq!(boot.label, "sec-1");
        assert!(!boot.is_primary);
        assert!(boot.fresh);
        assert!(!boot.restore);
        let again = mgr.take_boot("sec-1");
        assert!(again.files.is_empty());
    }

    /// Primary 永不标记为 fresh（其窗口级 localStorage key 是无后缀的 v0.8.5 旧数据）
    #[test]
    fn primary_boot_is_never_fresh() {
        let mut mgr = WindowManager::new();
        mgr.register(PRIMARY_LABEL, 1);
        assert!(!mgr.take_boot(PRIMARY_LABEL).fresh);
    }

    /// 会话恢复窗口不标记 fresh（要保留该槽位的临时标签/滚动进度）
    #[test]
    fn restore_boot_is_not_fresh() {
        let mut mgr = WindowManager::new();
        mgr.register("sec-2", 1);
        mgr.set_pending_boot("sec-2", vec![], true, vec![]);
        let boot = mgr.take_boot("sec-2");
        assert!(boot.restore);
        assert!(!boot.fresh);
    }

    /// 按窗口上报的标签刷新 OPEN_FILES 登记（打开前冲突查询的数据源）
    #[test]
    fn sync_window_feeds_open_files_registry() {
        let mut mgr = WindowManager::new();
        mgr.register(PRIMARY_LABEL, 1);
        mgr.sync_window(PRIMARY_LABEL, report(PRIMARY_LABEL, &["D:/a.md"]));
        mgr.register("sec-1", 2);
        mgr.sync_window("sec-1", report("sec-1", &["D:/a.md"]));
        assert_eq!(mgr.query_file_open("D:/a.md").len(), 2);
        assert_eq!(mgr.watched_file_paths(), vec!["D:/a.md".to_string()]);
        // 关闭 sec-1 后登记清空
        mgr.remove_window("sec-1");
        assert_eq!(mgr.query_file_open("D:/a.md").len(), 1);
    }

    /// 关闭确认标记：确认后放行，取消则清除
    #[test]
    fn approved_close_flag_lifecycle() {
        let mut mgr = WindowManager::new();
        mgr.register("sec-1", 2);
        assert!(!mgr.take_approved_close("sec-1"));
        mgr.approve_close("sec-1");
        assert!(mgr.take_approved_close("sec-1"));
        // 已消费
        assert!(!mgr.take_approved_close("sec-1"));
        mgr.approve_close("sec-1");
        mgr.abort_close("sec-1");
        assert!(!mgr.take_approved_close("sec-1"));
    }

    /// 窗口菜单列表：Primary 标记正确、标签概要与上报一致
    #[test]
    fn summaries_expose_primary_and_tabs() {
        let mut mgr = WindowManager::new();
        mgr.register(PRIMARY_LABEL, 1);
        mgr.register("sec-1", 2);
        mgr.sync_window(PRIMARY_LABEL, report(PRIMARY_LABEL, &["D:/a.md"]));
        mgr.sync_window("sec-1", report("sec-1", &[]));
        let list = mgr.summaries();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].label, "main");
        assert!(list[0].is_primary);
        assert_eq!(list[0].tabs.len(), 1);
        assert_eq!(list[1].label, "sec-1");
        assert!(!list[1].is_primary);
    }

    /// take_boot 会标记 Primary（晋升后的窗口前端据此提示）
    #[test]
    fn boot_reports_primary_status() {
        let mut mgr = WindowManager::new();
        mgr.register(PRIMARY_LABEL, 1);
        mgr.register("sec-1", 2);
        mgr.remove_window(PRIMARY_LABEL);
        mgr.promote_primary();
        let boot = mgr.take_boot("sec-1");
        assert!(boot.is_primary);
    }

    /// 监听超限提示只在上升沿触发（避免每次上报都 toast）
    #[test]
    fn watch_overflow_warns_on_rising_edge_only() {
        let mut mgr = WindowManager::new();
        assert!(mgr.note_watch_overflow(true));
        assert!(!mgr.note_watch_overflow(true));
        assert!(!mgr.note_watch_overflow(false));
        assert!(mgr.note_watch_overflow(true));
    }

    /// 回滚失败的窗口创建：槽位与残留状态一并清除
    #[test]
    fn discard_rolls_back_failed_creation() {
        let mut mgr = WindowManager::new();
        mgr.register(PRIMARY_LABEL, 1);
        mgr.reserve("sec-1");
        mgr.set_pending_boot("sec-1", vec!["D:/a.md".to_string()], false, vec![]);
        mgr.discard("sec-1");
        assert_eq!(mgr.allocate_label().as_deref(), Some("sec-1"));
        assert!(mgr.take_boot("sec-1").files.is_empty());
    }
}
