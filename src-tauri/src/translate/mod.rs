//! AI 翻译模块（v0.6.0）
//!
//! 模块组成：
//! - segment：占位符提取/回填/校验（第二层防御）
//! - prompt：Prompt 模板组装（含 auto 中英互译判向）
//! - provider：OpenAI 兼容客户端 + SSE 解析
//!
//! 任务状态：v0.6.0 为单任务模型——同一时刻仅一个选中翻译任务，
//! 新任务开始时自动取消旧任务（见 TranslateState）。

pub mod prompt;
pub mod provider;
pub mod segment;

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

/// 翻译任务状态（tauri::State 托管）
/// 单任务模型：全局唯一取消标志，新任务触发时置旧标志为 true 并替换
#[derive(Default)]
pub struct TranslateState {
    pub cancel_flag: std::sync::Mutex<Option<Arc<AtomicBool>>>,
}

impl TranslateState {
    /// 开始新任务：取消旧任务（若有）并注册新的取消标志
    pub fn begin_task(&self) -> Arc<AtomicBool> {
        let mut guard = self.cancel_flag.lock().unwrap();
        if let Some(old) = guard.take() {
            old.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        let flag = Arc::new(AtomicBool::new(false));
        *guard = Some(flag.clone());
        flag
    }

    /// 取消当前任务（若有）
    pub fn cancel_current(&self) {
        if let Some(flag) = self.cancel_flag.lock().unwrap().as_ref() {
            flag.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    }

    /// 任务正常完成时清理标志：仅当注册的仍是本任务的标志时才置 None
    ///
    /// 注意：必须在单次 lock 内完成判断与清理——此前在 if let 借用 guard 的块内
    /// 再次 lock 同一 Mutex 导致同线程死锁（v0.6.0 bug：首次翻译完成后 invoke
    /// 永久挂起，后续任务 begin_task 也无法获锁，翻译功能失效）。
    pub fn end_task(&self, flag: &Arc<AtomicBool>) {
        let mut guard = self.cancel_flag.lock().unwrap();
        if guard.as_ref().is_some_and(|f| std::sync::Arc::ptr_eq(f, flag)) {
            *guard = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_begin_task_cancels_previous() {
        let state = TranslateState::default();
        let f1 = state.begin_task();
        assert!(!f1.load(std::sync::atomic::Ordering::Relaxed));
        let f2 = state.begin_task();
        // 旧任务被自动取消
        assert!(f1.load(std::sync::atomic::Ordering::Relaxed));
        assert!(!f2.load(std::sync::atomic::Ordering::Relaxed));
    }

    #[test]
    fn test_cancel_current() {
        let state = TranslateState::default();
        state.cancel_current(); // 无任务时不 panic
        let f = state.begin_task();
        state.cancel_current();
        assert!(f.load(std::sync::atomic::Ordering::Relaxed));
    }

    #[test]
    fn test_end_task_clears_own_flag_without_deadlock() {
        // v0.6.0 bug 回归测试：end_task 必须单次 lock 完成（此前双重 lock 死锁，
        // 本测试若死锁将超时不通过）
        let state = TranslateState::default();
        let f = state.begin_task();
        state.end_task(&f);
        assert!(state.cancel_flag.lock().unwrap().is_none());
        // end_task 后可继续开启新任务（锁已正确释放）
        let f2 = state.begin_task();
        assert!(!f2.load(std::sync::atomic::Ordering::Relaxed));
    }

    #[test]
    fn test_end_task_does_not_clear_newer_task_flag() {
        // 旧任务晚到完成时不误清新任务的标志
        let state = TranslateState::default();
        let old = state.begin_task();
        let new = state.begin_task(); // old 已被自动取消
        state.end_task(&old); // 旧任务完成，注册的已是 new
        assert!(state.cancel_flag.lock().unwrap().is_some());
        assert!(!new.load(std::sync::atomic::Ordering::Relaxed));
    }
}
