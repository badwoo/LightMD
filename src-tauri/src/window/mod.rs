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

pub mod merge_detect;
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
    /// label → 该窗口最后一次上报的状态（v0.9.0 第三轮修复）。
    ///
    /// 条目在窗口关闭后**保留**，成为该窗口在本会话内的「最后状态」，供
    /// 「关掉最后一个窗口 = 退出应用」时生成完整退出快照（用户逐个点关闭按钮
    /// 退出，开启「启动时恢复其他窗口」后应整体还原，而不是只剩主窗口）。
    /// 两条清除路径：槽位被新窗口复用（`register`）；被「合并到主窗口」的窗口
    /// 显式除名（`forget_window`）——合并的标签已转移，不得原样复活。
    ///
    /// 注意：「存活窗口」的判定始终以 `windows`（注册表）为准，本表可能含有
    /// 本会话已关闭窗口的条目；`snapshot_with` 等只按注册表过滤。
    window_state: HashMap<String, ReportedState>,
    /// 已被「合并到主窗口」除名的窗口（迟到的状态上报一律忽略，防止复活）
    forgotten: HashSet<String>,
    /// 是否已就「文件监听超限」提示过（只在上升沿 emit，避免反复 toast）
    watch_limit_warned: bool,
}

#[derive(Default, Clone, Debug)]
struct PendingBoot {
    files: Vec<String>,
    restore: bool,
    moved_tabs: Vec<MovedTab>,
}

/// 某窗口最后一次上报的状态（含上报时窗口的创建时间，退出快照按它稳定排序）。
///
/// v0.9.0 第三轮修复：`main_state`（第二轮）与本表合并——所有窗口的最后状态
/// 在本会话内统一保留，见 [`WindowManager::window_state`] 的说明。
#[derive(Clone, Debug)]
pub struct ReportedState {
    pub created_at: u64,
    pub session: WindowSession,
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
            forgotten: HashSet::new(),
            watch_limit_warned: false,
        }
    }

    // ───────────── 槽位与登记 ─────────────

    /// 登记一个已存在的窗口。
    ///
    /// 槽位复用时会丢弃上一轮该槽位残留的上报数据——新窗口从零开始
    /// （同时清掉「合并除名」标记，新窗口不受上一轮同槽位窗口的影响）。
    pub fn register(&mut self, label: &str, created_at: u64) {
        self.reserved.remove(label);
        self.window_state.remove(label);
        self.forgotten.remove(label);
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

    /// 更新某窗口上报的标签/文件夹（同时刷新 OPEN_FILES 登记）。
    ///
    /// v0.9.0 第三轮：条目在窗口关闭后仍保留（退出快照的数据源）；
    /// 已被「合并到主窗口」除名（`forget_window`）的窗口迟到上报一律忽略。
    pub fn sync_window(&mut self, label: &str, report: WindowSession) {
        self.open_files.sync_window(label, &report.tabs);
        if self.forgotten.contains(label) {
            return;
        }
        let created_at = self
            .windows
            .get(label)
            .map(|m| m.created_at)
            .or_else(|| self.window_state.get(label).map(|r| r.created_at))
            .unwrap_or_else(now_ms);
        self.window_state.insert(
            label.to_string(),
            ReportedState { created_at, session: report },
        );
    }

    /// 取某窗口最后一次上报的状态（含本会话已关闭的窗口）
    pub fn window_session_of(&self, label: &str) -> Option<WindowSession> {
        self.window_state.get(label).map(|r| r.session.clone())
    }

    /// 把某窗口从「本会话最后状态」中除名（「合并到主窗口」后、关闭自身前调用）。
    ///
    /// 合并意味着该窗口的标签已全部转移到目标窗口：若保留其最后状态，「逐个关窗
    /// 退出」生成的完整快照会把它原样复活，同一批标签在两个窗口重复出现。
    pub fn forget_window(&mut self, label: &str) {
        self.window_state.remove(label);
        self.forgotten.insert(label.to_string());
    }

    /// 某窗口的创建时间（未登记返回 None）
    pub fn created_at_of(&self, label: &str) -> Option<u64> {
        self.windows.get(label).map(|m| m.created_at)
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
            .map(|r| r.session.folder_paths.clone())
            .unwrap_or_default()
    }

    // ───────────── 关闭 / 晋升 ─────────────

    /// 移除窗口；返回其元数据与「是否原为 Primary」。
    ///
    /// v0.9.0 第三轮修复：**不再删除**该 label 的上报数据（它成为本会话的「最后
    /// 状态」，退出快照要用）；仅从注册表摘除。真正的清除只有两条路径：
    /// 槽位复用（`register`）与「合并到主窗口」（`forget_window`）。
    pub fn remove_window(&mut self, label: &str) -> (Option<WindowMeta>, bool) {
        let was_primary = self.primary_label == label;
        let meta = self.windows.remove(label);
        self.reserved.remove(label);
        self.pending_boot.remove(label);
        self.approved_close.remove(label);
        self.close_pending.remove(label);
        self.open_files.remove_window(label);
        (meta, was_primary)
    }

    /// 彻底遗忘某槽位（窗口创建失败回滚用）：连保留的「最后状态」一起清掉
    pub fn discard(&mut self, label: &str) {
        self.remove_window(label);
        self.window_state.remove(label);
        self.forgotten.remove(label);
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

    /// 生成「存活窗口」快照：只包含此刻仍存活的窗口（外加主窗口的最后状态）。
    ///
    /// 这是**运行中**的会话口径：用户中途主动关掉的辅助窗口不进入快照
    /// （v0.9.0 第一轮用户反馈：关掉的窗口不得在下次启动复活）。注意与
    /// [`Self::snapshot_after_close`] 的**退出**口径区分——退出（关掉最后一个
    /// 窗口）时本会话出现过的全部窗口都入表。
    ///
    /// 主窗口（`main`）例外：它由 `tauri.conf.json` 在每次启动时必定重建，
    /// `restore_windows` 也明确跳过它，保留其最后状态不会多建窗口——但若剔除，
    /// "先关主窗口 → 再关辅助窗口"这一最常见的退出顺序会让下次启动的主窗口空白
    /// （v0.9.0 第二轮用户反馈）。
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
                    .map(|r| (meta.label == primary, r.created_at, r.session.clone()))
            })
            .collect();
        // 主窗口已关闭（未存活）→ 补入它保留的最后状态
        if !self.windows.contains_key(PRIMARY_LABEL) {
            if let Some(r) = self.window_state.get(PRIMARY_LABEL) {
                entries.push((true, r.created_at, r.session.clone()));
            }
        }
        entries.sort_by(|a, b| {
            b.0.cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.label.cmp(&b.2.label))
        });
        SessionSnapshot::new(timestamp, entries.into_iter().map(|(_, _, s)| s).collect())
    }

    /// 关闭某个窗口后应当落盘的会话快照。
    ///
    /// - `is_last_window = false`（还有窗口存活）：走 [`Self::snapshot_with`]，
    ///   即「存活窗口 + 主窗口最后状态」——中途主动关掉的辅助窗口不复活
    ///   （第一轮用户反馈的口径不变）。
    /// - `is_last_window = true`（关掉它应用就退出）：**退出快照**——本会话
    ///   出现过的**全部**窗口（各取最后上报状态）都入表。用户「逐个点右上角
    ///   关闭」正是在退出，开启「启动时恢复其他窗口」后应整体还原，而不是只剩
    ///   主窗口（v0.9.0 第三轮用户反馈：多窗口逐个关闭后重开，其他窗口没有恢复）。
    ///   空窗口（无标签且无文件夹）不入表：恢复它只会多弹一个空壳。
    ///   已被「合并到主窗口」除名的窗口不入表（其标签已转移到目标窗口）。
    pub fn snapshot_after_close(&self, is_last_window: bool, timestamp: u64) -> SessionSnapshot {
        if !is_last_window {
            return self.snapshot_with(timestamp);
        }
        let primary = self.primary_label.clone();
        let mut entries: Vec<(bool, u64, WindowSession)> = self
            .window_state
            .values()
            .filter(|r| !r.session.tabs.is_empty() || !r.session.folder_paths.is_empty())
            .map(|r| {
                (
                    r.session.label == PRIMARY_LABEL || r.session.label == primary,
                    r.created_at,
                    r.session.clone(),
                )
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
                    active_tab_idx: state.map(|r| r.session.active_tab_idx).unwrap_or(0),
                    tabs: state.map(|r| r.session.tabs.clone()).unwrap_or_default(),
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

    // ─── v0.9.0 第二轮修复（问题2 / 问题4）：主窗口状态必须留在会话里 ───

    /// 主窗口**先**被关闭时，它的标签/文件夹仍要进入快照。
    ///
    /// 回归的是用户反馈：「多窗口编辑 → 所有窗口关闭 → 重新打开，主窗口的所有标签
    /// 和文件夹都关闭了」。旧实现把 main 也当普通窗口剔除，于是最常见的退出顺序
    /// （先关主窗口、再关辅助窗口）写出的快照没有主窗口条目，下次启动主窗口空白。
    #[test]
    fn snapshot_keeps_main_state_after_primary_closed() {
        let mut mgr = WindowManager::new();
        mgr.register(PRIMARY_LABEL, 1);
        mgr.sync_window(
            PRIMARY_LABEL,
            WindowSession {
                label: PRIMARY_LABEL.to_string(),
                active_tab_idx: 1,
                tabs: vec![tab("D:/a.md"), tab("D:/a2.md")],
                folder_paths: vec!["D:/docs".to_string()],
            },
        );
        mgr.register("sec-1", 2);
        mgr.sync_window("sec-1", report("sec-1", &["D:/b.md"]));

        // 用户先关闭主窗口（slot 释放，sec-1 晋升为 Primary）
        mgr.remove_window(PRIMARY_LABEL);
        assert_eq!(mgr.promote_primary().as_deref(), Some("sec-1"));
        // 主窗口已不在存活集合里
        assert!(!mgr.contains(PRIMARY_LABEL));
        // 但其最后状态必须保留可供快照使用
        assert!(mgr.window_session_of(PRIMARY_LABEL).is_some());

        let snap = mgr.snapshot_with(10);
        let labels: Vec<&str> = snap.windows.iter().map(|w| w.label.as_str()).collect();
        assert_eq!(labels, vec!["main", "sec-1"], "main 必须在快照里且排最前");
        let main = snap
            .windows
            .iter()
            .find(|w| w.label == PRIMARY_LABEL)
            .expect("主窗口条目");
        assert_eq!(main.tabs.len(), 2);
        assert_eq!(main.folder_paths, vec!["D:/docs".to_string()]);
    }

    /// 关掉**最后一个**窗口（主窗口）后快照仍非空——`confirm_close` 据此写出
    /// 「用户看到的最后画面」，否则重开软件会退回上一次会话的旧数据甚至空白
    /// （用户反馈：关闭时选"不保存"后重开，所有标签都被关闭了）。
    #[test]
    fn snapshot_survives_closing_last_window() {
        let mut mgr = WindowManager::new();
        mgr.register(PRIMARY_LABEL, 1);
        mgr.sync_window(PRIMARY_LABEL, report(PRIMARY_LABEL, &["D:/a.md", "D:/b.md"]));
        mgr.remove_window(PRIMARY_LABEL);
        let snap = mgr.snapshot_after_close(true, 7);
        assert_eq!(snap.windows.len(), 1);
        assert_eq!(snap.windows[0].label, PRIMARY_LABEL);
        assert_eq!(snap.windows[0].tabs.len(), 2);
    }

    /// 窗口重新登记（进程启动/槽位复用）时清掉上一轮残留的最后状态，避免串数据
    #[test]
    fn register_clears_previous_reported_state() {
        let mut mgr = WindowManager::new();
        mgr.register(PRIMARY_LABEL, 1);
        mgr.sync_window(PRIMARY_LABEL, report(PRIMARY_LABEL, &["D:/a.md"]));
        mgr.register(PRIMARY_LABEL, 2);
        assert!(mgr.window_session_of(PRIMARY_LABEL).is_none());
    }

    /// 关掉**最后一个**窗口时，本次会话出现过的全部窗口都进入退出快照。
    ///
    /// 回归场景：主窗口先被关、sec-1 晋升为 Primary，用户再关掉 sec-1（应用退出）。
    /// 若只保留 main，重开软件会凭空少一个窗口——而用户只是"逐个关窗退出"。
    #[test]
    fn close_snapshot_includes_last_closing_window() {
        let mut mgr = WindowManager::new();
        mgr.register(PRIMARY_LABEL, 1);
        mgr.sync_window(PRIMARY_LABEL, report(PRIMARY_LABEL, &["D:/a.md"]));
        mgr.register("sec-1", 2);
        mgr.sync_window("sec-1", report("sec-1", &["D:/b.md"]));

        // 关主窗口（此时 sec-1 仍存活 → 运行中口径：只含存活窗口 + main）
        mgr.remove_window(PRIMARY_LABEL);
        mgr.promote_primary();
        let snap1 = mgr.snapshot_after_close(false, 1);
        assert_eq!(
            snap1.windows.iter().map(|w| w.label.as_str()).collect::<Vec<_>>(),
            vec!["main", "sec-1"]
        );

        // 关 sec-1（最后一个窗口 = 退出应用）→ 本会话全部窗口都保留
        mgr.remove_window("sec-1");
        let snap2 = mgr.snapshot_after_close(true, 2);
        let labels: Vec<&str> = snap2.windows.iter().map(|w| w.label.as_str()).collect();
        assert_eq!(labels, vec!["main", "sec-1"]);
        let sec = snap2.windows.iter().find(|w| w.label == "sec-1").unwrap();
        assert_eq!(sec.tabs.len(), 1);
    }

    /// 关掉某个辅助窗口时（还有其他窗口存活）**不得**把它写进快照——否则用户主动
    /// 关掉的窗口下次启动又冒出来（v0.9.0 第一轮用户反馈的回归保护）。
    #[test]
    fn close_snapshot_skips_closed_secondary_when_others_live() {
        let mut mgr = WindowManager::new();
        mgr.register(PRIMARY_LABEL, 1);
        mgr.register("sec-1", 2);
        mgr.sync_window(PRIMARY_LABEL, report(PRIMARY_LABEL, &["D:/a.md"]));
        mgr.sync_window("sec-1", report("sec-1", &["D:/b.md"]));

        mgr.remove_window("sec-1");
        let snap = mgr.snapshot_after_close(false, 3);
        assert_eq!(
            snap.windows.iter().map(|w| w.label.as_str()).collect::<Vec<_>>(),
            vec!["main"]
        );
    }

    // ─── v0.9.0 第三轮修复（问题3）：逐个关窗退出 → 全部窗口随会话恢复 ───

    /// 用户反馈场景：多窗口 → 逐个点右上角关闭（先关辅助窗口、最后关主窗口）→
    /// 重开软件后其他窗口没有恢复。退出快照必须包含本会话出现过的**全部**窗口。
    #[test]
    fn exit_snapshot_restores_windows_closed_before_the_last_one() {
        let mut mgr = WindowManager::new();
        mgr.register(PRIMARY_LABEL, 1);
        mgr.sync_window(PRIMARY_LABEL, report(PRIMARY_LABEL, &["D:/a.md"]));
        mgr.register("sec-1", 2);
        mgr.sync_window("sec-1", report("sec-1", &["D:/b.md"]));
        mgr.register("sec-2", 3);
        mgr.sync_window("sec-2", report("sec-2", &["D:/c.md"]));

        // 先关 sec-1（还有窗口存活 → 运行中口径，sec-1 不入表）
        mgr.remove_window("sec-1");
        let running = mgr.snapshot_after_close(false, 10);
        assert_eq!(
            running.windows.iter().map(|w| w.label.as_str()).collect::<Vec<_>>(),
            vec!["main", "sec-2"]
        );

        // 再关 sec-2、最后关 main（每关一个都重新判定 is_last_window）
        mgr.remove_window("sec-2");
        let running2 = mgr.snapshot_after_close(false, 11);
        assert_eq!(
            running2.windows.iter().map(|w| w.label.as_str()).collect::<Vec<_>>(),
            vec!["main"]
        );
        mgr.remove_window(PRIMARY_LABEL);
        let exit = mgr.snapshot_after_close(true, 12);
        // 退出快照：本会话全部窗口（含中途关掉的 sec-1 / sec-2），main 最前
        assert_eq!(
            exit.windows.iter().map(|w| w.label.as_str()).collect::<Vec<_>>(),
            vec!["main", "sec-1", "sec-2"]
        );
    }

    /// 「合并到主窗口」的窗口从退出快照中除名（标签已转移，原样复活会重复），
    /// 且合并后迟到的状态上报一律忽略。
    #[test]
    fn forgotten_window_is_excluded_from_exit_snapshot() {
        let mut mgr = WindowManager::new();
        mgr.register(PRIMARY_LABEL, 1);
        mgr.sync_window(PRIMARY_LABEL, report(PRIMARY_LABEL, &["D:/a.md"]));
        mgr.register("sec-1", 2);
        mgr.sync_window("sec-1", report("sec-1", &["D:/b.md"]));

        // 合并到主窗口：先除名，再（可能迟到地）上报一次状态
        mgr.forget_window("sec-1");
        mgr.sync_window("sec-1", report("sec-1", &["D:/b.md", "D:/late.md"]));
        assert!(mgr.window_session_of("sec-1").is_none(), "迟到的上报不得复活已除名的窗口");

        mgr.remove_window("sec-1");
        mgr.remove_window(PRIMARY_LABEL);
        let exit = mgr.snapshot_after_close(true, 20);
        assert_eq!(
            exit.windows.iter().map(|w| w.label.as_str()).collect::<Vec<_>>(),
            vec!["main"]
        );
    }

    /// 槽位复用后新窗口从零开始：被除名（合并）的槽位再次分配时，除名标记清空
    #[test]
    fn forgotten_flag_is_cleared_on_slot_reuse() {
        let mut mgr = WindowManager::new();
        mgr.register(PRIMARY_LABEL, 1);
        mgr.register("sec-1", 2);
        mgr.forget_window("sec-1");
        // 同槽位新窗口：上报应正常入表
        mgr.register("sec-1", 3);
        mgr.sync_window("sec-1", report("sec-1", &["D:/new.md"]));
        assert_eq!(mgr.window_session_of("sec-1").map(|s| s.tabs.len()), Some(1));
    }

    /// 空窗口（无标签且无文件夹）不进入退出快照：恢复它只会多弹一个空壳
    #[test]
    fn exit_snapshot_skips_empty_windows() {
        let mut mgr = WindowManager::new();
        mgr.register(PRIMARY_LABEL, 1);
        mgr.sync_window(PRIMARY_LABEL, report(PRIMARY_LABEL, &["D:/a.md"]));
        mgr.register("sec-1", 2);
        mgr.sync_window("sec-1", report("sec-1", &[])); // 空窗口

        mgr.remove_window("sec-1");
        mgr.remove_window(PRIMARY_LABEL);
        let exit = mgr.snapshot_after_close(true, 30);
        assert_eq!(
            exit.windows.iter().map(|w| w.label.as_str()).collect::<Vec<_>>(),
            vec!["main"]
        );
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
