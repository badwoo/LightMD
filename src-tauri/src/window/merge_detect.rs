//! v0.9.0 第三轮（需求2）：把辅助窗口**拖到主窗口的标签栏** → 询问是否「合并回主窗口」。
//!
//! 检测在 Rust 侧完成（Webview 无从得知其他窗口的几何）：
//!
//! 1. [`note_window_moved`] 挂在 `WindowEvent::Moved` 上（高频触发，内部有廉价闸门）：
//!    仅当「被拖窗口 ≠ Primary、建窗忽略期已过、窗口有焦点、压在 Primary 顶部
//!    『标题栏 + 标签栏』条带内」时才记入候选；
//! 2. 候选需**静止 [`HOLD_MS`] 才生效**——真实拖拽期间 Moved 连发会不断刷新时间戳，
//!    只有真正把窗口停在条带上（松手）才到达静止期，路径扫过不会弹窗；
//! 3. 到期后用**当前**几何复核一次（用户可能又拖走了），再 emit
//!    `lightmd:mergeOffer`（载荷带 `target`，前端按自身 label 过滤——见
//!    `window_cmds::emit_to_window` 的 emit_to 广播语义注释），确认后走前端
//!    既有「合并到主窗口」流程。
//!
//! 防误触设计：
//! - **建窗忽略期**：`tauri-plugin-window-state` 在启动/建窗时恢复几何也会发
//!   `Moved`，[`CREATE_GRACE_MS`] 内的事件一律忽略；
//! - **焦点闸门**：几何恢复/程序化移动的窗口通常无焦点，真正的手工拖拽必有焦点；
//! - **静止去抖**：拖动中永不弹窗（时间戳一直被刷新）。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition};

use super::{now_ms, AppWindowManager};

/// 「标题栏 + 标签栏」条带的逻辑高度（px）：主窗口顶部即目标区域
const STRIP_LOGICAL_PX: f64 = 90.0;
/// 候选需静止多久才弹询问（ms）
const HOLD_MS: u64 = 500;
/// 静止检测轮询间隔（ms）
const POLL_MS: u64 = 150;
/// 建窗后的忽略期（ms）：窗口几何恢复（window-state 插件）也会触发 Moved
const CREATE_GRACE_MS: u64 = 3000;

/// 物理像素矩形（窗口 outer 位置 + outer 尺寸）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Rect {
    pub fn new(x: i32, y: i32, width: u32, height: u32) -> Self {
        Self { x, y, width, height }
    }
}

/// 两矩形是否相交（边缘恰好相接不算）
pub fn rects_intersect(a: Rect, b: Rect) -> bool {
    a.x < b.x + b.width as i32
        && b.x < a.x + a.width as i32
        && a.y < b.y + b.height as i32
        && b.y < a.y + a.height as i32
}

/// 窗口顶部的目标条带（物理像素；高度按 DPI 缩放，且不超过窗口自身高度）
pub fn tab_strip(win: Rect, strip_logical: f64, scale: f64) -> Rect {
    let h = (strip_logical * scale).round().max(1.0) as u32;
    Rect {
        height: h.min(win.height),
        ..win
    }
}

/// 被拖窗口是否压在目标窗口的标签栏条带上
pub fn overlaps_tab_strip(moved: Rect, primary: Rect, scale: f64) -> bool {
    rects_intersect(moved, tab_strip(primary, STRIP_LOGICAL_PX, scale))
}

/// 候选表：label → 最近一次「压在条带上」的 Moved 时间
fn pending() -> &'static Mutex<HashMap<String, Instant>> {
    static PENDING: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 已在本次「驻留」（压在条带上未离开）期间发出过询问的窗口。
///
/// 用户点「取消」后若仍在条带上小幅挪动窗口，不应反复弹同一个询问；
/// 只有把窗口**拖离条带再拖回来**（新的驻留），下一次才重新询问。
fn offered() -> &'static Mutex<HashMap<String, Instant>> {
    static OFFERED: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    OFFERED.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 移除候选（拖离条带 / 不满足闸门时调用）
fn drop_pending(label: &str) {
    if let Ok(mut p) = pending().lock() {
        p.remove(label);
    }
}

/// 窗口离开条带：重新武装询问（下次压回条带会再问）
fn leave_strip(label: &str) {
    drop_pending(label);
    if let Ok(mut o) = offered().lock() {
        o.remove(label);
    }
}

/// `WindowEvent::Moved` 入口（lib.rs `on_window_event` 调用；主线程高频回调，须廉价）
pub fn note_window_moved(app: &AppHandle, label: &str, pos: PhysicalPosition<i32>) {
    let state = app.state::<AppWindowManager>();
    let (primary, created_at) = {
        let mgr = state.lock();
        (mgr.primary_label().to_string(), mgr.created_at_of(label))
    };

    // 主窗口自身被拖 → 不构成「合并到主窗口」手势
    if label == primary {
        leave_strip(label);
        return;
    }
    // 建窗忽略期：几何恢复阶段的 Moved 一律不算
    match created_at {
        Some(at) if now_ms().saturating_sub(at) >= CREATE_GRACE_MS => {}
        _ => {
            leave_strip(label);
            return;
        }
    }

    let (Some(moved_win), Some(primary_win)) =
        (app.get_webview_window(label), app.get_webview_window(&primary))
    else {
        return;
    };
    // 焦点闸门：真正的手工拖拽必有焦点（几何恢复/程序化移动无焦点）
    if !moved_win.is_focused().unwrap_or(false) {
        leave_strip(label);
        return;
    }

    let (Ok(moved_size), Ok(pp), Ok(ps), Ok(scale)) = (
        moved_win.outer_size(),
        primary_win.outer_position(),
        primary_win.outer_size(),
        primary_win.scale_factor(),
    ) else {
        return;
    };
    let moved = Rect::new(pos.x, pos.y, moved_size.width, moved_size.height);
    let primary_rect = Rect::new(pp.x, pp.y, ps.width, ps.height);
    let overlaps = overlaps_tab_strip(moved, primary_rect, scale);

    if overlaps {
        if let Ok(mut p) = pending().lock() {
            p.insert(label.to_string(), Instant::now());
        }
        ensure_checker(app);
    } else {
        leave_strip(label);
    }
}

/// 启动静止检测线程（整个进程一次；空闲轮询 150ms，开销可忽略）
fn ensure_checker(app: &AppHandle) {
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.set(()).is_err() {
        return; // 已启动
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(POLL_MS));
        // 取出到期候选（静止满 HOLD_MS；拖动中时间戳被持续刷新，不会到期）
        let due: Vec<String> = {
            let Ok(p) = pending().lock() else { continue };
            p.iter()
                .filter(|(_, at)| at.elapsed() >= Duration::from_millis(HOLD_MS))
                .map(|(k, _)| k.clone())
                .collect()
        };
        for label in due {
            drop_pending(&label);
            verify_and_offer(&app, &label);
        }
    });
}

/// 到期复核：用**当前**几何再判定一次（用户可能已拖走），命中则 emit 合并询问。
/// 同一次「驻留」（压在条带上未离开）只问一次——拖离条带后重新武装。
fn verify_and_offer(app: &AppHandle, label: &str) {
    let primary = app
        .state::<AppWindowManager>()
        .lock()
        .primary_label()
        .to_string();
    if label == primary {
        return;
    }
    let (Some(moved_win), Some(primary_win)) =
        (app.get_webview_window(label), app.get_webview_window(&primary))
    else {
        return;
    };
    // 松手后若焦点已被切走（用户立刻点了别的窗口），视为放弃该手势
    if !moved_win.is_focused().unwrap_or(false) {
        return;
    }
    let (Ok(mp), Ok(ms), Ok(pp), Ok(ps), Ok(scale)) = (
        moved_win.outer_position(),
        moved_win.outer_size(),
        primary_win.outer_position(),
        primary_win.outer_size(),
        primary_win.scale_factor(),
    ) else {
        return;
    };
    let moved = Rect::new(mp.x, mp.y, ms.width, ms.height);
    let primary_rect = Rect::new(pp.x, pp.y, ps.width, ps.height);
    if !overlaps_tab_strip(moved, primary_rect, scale) {
        leave_strip(label);
        return;
    }
    // 本次驻留已问过（用户点了「取消」且窗口未离开条带）→ 不再打扰
    if let Ok(mut o) = offered().lock() {
        if o.contains_key(label) {
            return;
        }
        o.insert(label.to_string(), Instant::now());
    }
    // 载荷带 target（emit_to 的广播语义要求前端自行过滤，见 emit_to_window 注释）
    let _ = app.emit_to(
        label,
        "lightmd:mergeOffer",
        serde_json::json!({ "target": label }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intersecting_rects_overlap() {
        let a = Rect::new(100, 100, 800, 600);
        let b = Rect::new(700, 80, 600, 400);
        assert!(rects_intersect(a, b));
    }

    #[test]
    fn disjoint_rects_do_not_overlap() {
        let a = Rect::new(0, 0, 800, 600);
        let b = Rect::new(1920, 1080, 600, 400);
        assert!(!rects_intersect(a, b));
    }

    #[test]
    fn touching_edges_do_not_count() {
        // 边缘恰好相接（无重叠面积）不算命中
        let a = Rect::new(0, 0, 100, 100);
        let b = Rect::new(100, 0, 100, 100);
        assert!(!rects_intersect(a, b));
        let c = Rect::new(0, 100, 100, 100);
        assert!(!rects_intersect(a, c));
    }

    #[test]
    fn strip_height_scales_with_dpi_and_is_capped() {
        // 1x：90 逻辑像素 = 90 物理像素
        assert_eq!(tab_strip(Rect::new(0, 0, 1000, 800), 90.0, 1.0).height, 90);
        // 1.5x（125%/150% DPI）
        assert_eq!(tab_strip(Rect::new(0, 0, 1000, 800), 90.0, 1.5).height, 135);
        // 窗口比条带还矮 → 条带封顶为窗口高度
        assert_eq!(tab_strip(Rect::new(0, 0, 1000, 50), 90.0, 1.0).height, 50);
        // 条带位置与窗口对齐（顶部、同宽）
        let s = tab_strip(Rect::new(10, 20, 300, 400), 90.0, 1.0);
        assert_eq!((s.x, s.y, s.width), (10, 20, 300));
    }

    #[test]
    fn dragging_onto_primary_top_strip_overlaps() {
        // 主窗口在 (0,0) 1200x800；辅助窗口拖到其顶部 → 命中条带
        let primary = Rect::new(0, 0, 1200, 800);
        let moved = Rect::new(200, -20, 900, 650);
        assert!(overlaps_tab_strip(moved, primary, 1.0));
        // 只压在主窗口底部 → 不命中
        let low = Rect::new(300, 700, 900, 650);
        assert!(!overlaps_tab_strip(low, primary, 1.0));
        // 完全在主窗口右侧外 → 不命中
        let right = Rect::new(1300, 10, 900, 650);
        assert!(!overlaps_tab_strip(right, primary, 1.0));
    }

    #[test]
    fn overlap_respects_dpi_scale() {
        // 2x 缩放：条带高 180 物理像素——压到 y=150（1x 时已超出 90px 条带）也命中
        let primary = Rect::new(0, 0, 2400, 1600);
        let moved = Rect::new(600, 100, 1800, 1300);
        assert!(overlaps_tab_strip(moved, primary, 2.0));
        assert!(!overlaps_tab_strip(moved, primary, 1.0));
    }
}
