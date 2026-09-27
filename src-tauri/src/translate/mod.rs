//! AI 翻译模块（v0.6.0）
//!
//! 模块组成：
//! - segment：占位符提取/回填/校验（第二层防御）
//! - prompt：Prompt 模板组装（含 auto 中英互译判向）
//! - provider：OpenAI 兼容客户端 + SSE 解析
//!
//! 任务状态：
//! - v0.6.0～0.8.5：单任务槽为 App 级唯一——多窗口下窗口 A 的划词翻译会顶掉
//!   窗口 B 的 AI 对话。
//! - v0.9.0：**单任务槽按窗口分桶**（`window_label → 取消标志`），窗口之间互不影响；
//!   同一窗口内新任务仍自动取消旧任务（v0.6.0 语义不变）。
//! - 全文翻译并发槽位（v0.7.3）同时记录所属窗口，使「取消本窗口任务」能精确
//!   覆盖本窗口的并发批次，而不误杀其他窗口正在跑的批次。

pub mod prompt;
pub mod provider;
pub mod segment;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// 并发任务槽条目：取消标志 + 所属窗口（窗口关闭/取消本窗口任务时定向清理）
#[derive(Clone)]
pub struct ConcurrentTask {
    pub window_label: String,
    pub flag: Arc<AtomicBool>,
}

/// 翻译任务状态（tauri::State 托管）
#[derive(Default)]
pub struct TranslateState {
    /// 单任务槽（选中翻译 / AI 续写 / 润色 / 摘要 / AI 对话）：按窗口 label 分桶。
    ///
    /// 每个窗口任一时刻最多一个在途任务；同窗口发起新任务自动取消该窗口的旧任务。
    pub cancel_flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// v0.7.3：全文翻译并发任务槽位（task_id → 任务），多个可同时存在
    pub concurrent_tasks: Mutex<HashMap<String, ConcurrentTask>>,
}

impl TranslateState {
    /// 取锁（中毒时退化为内部数据：AI 任务状态不应让整个应用不可用）
    fn flags(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<AtomicBool>>> {
        match self.cancel_flags.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn concurrent(&self) -> std::sync::MutexGuard<'_, HashMap<String, ConcurrentTask>> {
        match self.concurrent_tasks.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// 开始新任务：取消**该窗口**的旧任务（若有）并注册新的取消标志。
    pub fn begin_task(&self, window_label: &str) -> Arc<AtomicBool> {
        let mut guard = self.flags();
        if let Some(old) = guard.remove(window_label) {
            old.store(true, Ordering::Relaxed);
        }
        let flag = Arc::new(AtomicBool::new(false));
        guard.insert(window_label.to_string(), flag.clone());
        flag
    }

    /// 任务正常完成/失败时清理标志：仅当注册的仍是本任务的标志时才移除
    /// （旧任务晚到完成不得误清新任务的槽位）。
    pub fn end_task(&self, window_label: &str, flag: &Arc<AtomicBool>) {
        let mut guard = self.flags();
        if guard.get(window_label).is_some_and(|f| Arc::ptr_eq(f, flag)) {
            guard.remove(window_label);
        }
    }

    /// 取消某窗口当前任务（若有）
    pub fn cancel_current(&self, window_label: &str) {
        if let Some(flag) = self.flags().get(window_label) {
            flag.store(true, Ordering::Relaxed);
        }
    }

    /// 窗口关闭 / 取消本窗口全部任务：取消该窗口的单任务槽 + 该窗口的全部并发批次。
    pub fn cancel_window_tasks(&self, window_label: &str) {
        if let Some(flag) = self.flags().remove(window_label) {
            flag.store(true, Ordering::Relaxed);
        }
        let mut guard = self.concurrent();
        guard.retain(|_, task| {
            if task.window_label == window_label {
                task.flag.store(true, Ordering::Relaxed);
                false
            } else {
                true
            }
        });
    }

    /// v0.7.3：注册/复用并发任务槽位（全文翻译 batch）。不取消其它任务；
    /// 同一 task_id 重复注册时先取消旧任务（防止孤儿任务占着槽位继续跑）。
    pub fn begin_concurrent_task(&self, id: &str, window_label: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        let task = ConcurrentTask { window_label: window_label.to_string(), flag: flag.clone() };
        let mut guard = self.concurrent();
        if let Some(old) = guard.insert(id.to_string(), task) {
            old.flag.store(true, Ordering::Relaxed);
        }
        flag
    }

    /// v0.7.3：并发任务正常完成时清理槽位（仅当 map 中仍指向本 flag 才移除，
    /// 防止晚到的旧任务误清新注册任务的槽位）
    pub fn end_concurrent_task(&self, id: &str, flag: &Arc<AtomicBool>) {
        let mut guard = self.concurrent();
        if guard.get(id).is_some_and(|t| Arc::ptr_eq(&t.flag, flag)) {
            guard.remove(id);
        }
    }

    /// 取消全部任务（单任务槽 + 全部并发槽位）。仅在真正需要全局中止时使用
    /// （如应用退出）；窗口级取消请用 [`Self::cancel_window_tasks`]。
    pub fn cancel_all(&self) {
        for flag in self.flags().values() {
            flag.store(true, Ordering::Relaxed);
        }
        for task in self.concurrent().values() {
            task.flag.store(true, Ordering::Relaxed);
        }
    }

    /// v0.7.3：取消指定并发任务（全文翻译按批次定向取消）
    pub fn cancel_concurrent_ids(&self, ids: &[String]) {
        let guard = self.concurrent();
        for id in ids {
            if let Some(task) = guard.get(id) {
                task.flag.store(true, Ordering::Relaxed);
            }
        }
    }

    /// 测试/诊断：某窗口当前是否登记了单任务槽
    pub fn has_task(&self, window_label: &str) -> bool {
        self.flags().contains_key(window_label)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const W1: &str = "main";
    const W2: &str = "sec-1";

    #[test]
    fn test_begin_task_cancels_previous_in_same_window() {
        let state = TranslateState::default();
        let f1 = state.begin_task(W1);
        assert!(!f1.load(Ordering::Relaxed));
        let f2 = state.begin_task(W1);
        // 同窗口旧任务被自动取消（v0.6.0 语义不变）
        assert!(f1.load(Ordering::Relaxed));
        assert!(!f2.load(Ordering::Relaxed));
    }

    /// v0.9.0 AC-14：窗口 A 的任务不受窗口 B 发起任务影响
    #[test]
    fn test_begin_task_is_isolated_between_windows() {
        let state = TranslateState::default();
        let a = state.begin_task(W1);
        let b = state.begin_task(W2);
        assert!(!a.load(Ordering::Relaxed), "窗口 B 发起任务不得取消窗口 A 的任务");
        assert!(!b.load(Ordering::Relaxed));
        assert_eq!(state.cancel_flags.lock().unwrap().len(), 2);
    }

    #[test]
    fn test_cancel_current_is_window_scoped() {
        let state = TranslateState::default();
        state.cancel_current(W1); // 无任务时不 panic
        let a = state.begin_task(W1);
        let b = state.begin_task(W2);
        state.cancel_current(W1);
        assert!(a.load(Ordering::Relaxed));
        assert!(!b.load(Ordering::Relaxed), "取消窗口 A 不得影响窗口 B");
    }

    #[test]
    fn test_cancel_window_tasks_only_touches_target_window() {
        let state = TranslateState::default();
        let a = state.begin_task(W1);
        let b = state.begin_task(W2);
        let ca = state.begin_concurrent_task("ft-main-1", W1);
        let cb = state.begin_concurrent_task("ft-sec-1-1", W2);
        state.cancel_window_tasks(W1);
        assert!(a.load(Ordering::Relaxed));
        assert!(ca.load(Ordering::Relaxed));
        assert!(!b.load(Ordering::Relaxed), "窗口 B 的单任务槽不受影响");
        assert!(!cb.load(Ordering::Relaxed), "窗口 B 的并发批次不受影响");
        // 窗口 A 的槽位被彻底清空
        assert!(!state.has_task(W1));
        assert!(state.has_task(W2));
        assert_eq!(state.concurrent_tasks.lock().unwrap().len(), 1);
    }

    #[test]
    fn test_end_task_clears_own_flag_without_deadlock() {
        // v0.6.0 bug 回归测试：end_task 必须单次 lock 完成（此前双重 lock 死锁，
        // 本测试若死锁将超时不通过）
        let state = TranslateState::default();
        let f = state.begin_task(W1);
        state.end_task(W1, &f);
        assert!(!state.has_task(W1));
        // end_task 后可继续开启新任务（锁已正确释放）
        let f2 = state.begin_task(W1);
        assert!(!f2.load(Ordering::Relaxed));
    }

    #[test]
    fn test_end_task_does_not_clear_newer_task_flag() {
        // 旧任务晚到完成时不误清新任务的标志
        let state = TranslateState::default();
        let old = state.begin_task(W1);
        let new = state.begin_task(W1); // old 已被自动取消
        state.end_task(W1, &old); // 旧任务完成，注册的已是 new
        assert!(state.has_task(W1));
        assert!(!new.load(Ordering::Relaxed));
    }

    #[test]
    fn test_end_task_from_other_window_does_not_clear() {
        // 窗口 A 的任务完成回调不得清掉窗口 B 的槽位（label 已不同）
        let state = TranslateState::default();
        let a = state.begin_task(W1);
        let b = state.begin_task(W2);
        state.end_task(W2, &a);
        assert!(state.has_task(W2));
        assert!(!b.load(Ordering::Relaxed));
    }

    // v0.7.3 改进9：并发任务槽位
    #[test]
    fn test_begin_concurrent_task_does_not_cancel_others() {
        let state = TranslateState::default();
        let a = state.begin_concurrent_task("t1", W1);
        let b = state.begin_concurrent_task("t2", W1);
        // 并发任务互不取消
        assert!(!a.load(Ordering::Relaxed));
        assert!(!b.load(Ordering::Relaxed));
        assert_eq!(state.concurrent_tasks.lock().unwrap().len(), 2);
    }

    #[test]
    fn test_begin_concurrent_same_id_cancels_old() {
        let state = TranslateState::default();
        let a = state.begin_concurrent_task("t1", W1);
        let b = state.begin_concurrent_task("t1", W1); // 同 id 重复注册
        assert!(a.load(Ordering::Relaxed)); // 旧任务被取消
        assert!(!b.load(Ordering::Relaxed));
        assert_eq!(state.concurrent_tasks.lock().unwrap().len(), 1);
    }

    #[test]
    fn test_end_concurrent_task_removes_own_only() {
        let state = TranslateState::default();
        let a = state.begin_concurrent_task("t1", W1);
        state.begin_concurrent_task("t2", W1);
        let b = state.begin_concurrent_task("t1", W1); // 旧 t1 被顶掉
        state.end_concurrent_task("t1", &a); // 旧 a 迟到完成，不应移除新 b 的槽位
        assert_eq!(state.concurrent_tasks.lock().unwrap().len(), 2);
        assert!(!b.load(Ordering::Relaxed));
        state.end_concurrent_task("t1", &b);
        assert_eq!(state.concurrent_tasks.lock().unwrap().len(), 1);
    }

    #[test]
    fn test_cancel_all_cancels_concurrent_and_single() {
        let state = TranslateState::default();
        let f = state.begin_task(W1);
        let g = state.begin_task(W2);
        let c1 = state.begin_concurrent_task("t1", W1);
        let c2 = state.begin_concurrent_task("t2", W2);
        state.cancel_all();
        assert!(f.load(Ordering::Relaxed));
        assert!(g.load(Ordering::Relaxed));
        assert!(c1.load(Ordering::Relaxed));
        assert!(c2.load(Ordering::Relaxed));
    }

    #[test]
    fn test_cancel_concurrent_ids_selective() {
        let state = TranslateState::default();
        let c1 = state.begin_concurrent_task("t1", W1);
        let c2 = state.begin_concurrent_task("t2", W1);
        state.cancel_concurrent_ids(&["t1".to_string()]);
        assert!(c1.load(Ordering::Relaxed));
        assert!(!c2.load(Ordering::Relaxed));
    }
}
