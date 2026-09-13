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

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

/// 翻译任务状态（tauri::State 托管）
///
/// v0.6.0～0.7.2：单任务模型——全局唯一取消标志，新任务触发时置旧标志为 true 并替换。
/// v0.7.3 改进9(P4-2)：新增并发任务槽位（全文翻译 2~3 路并发提速），
///   取消标志按 task_id 维度管理，不与选中翻译的全局单任务槽互相干扰。
/// v0.7.5：单任务槽的成员扩展为「选中翻译 / AI 续写 / 润色 / 摘要 / AI 对话」，
///   五者任一时刻仅一个在途（发起新任务自动取消旧任务，防并发滥用）。
#[derive(Default)]
pub struct TranslateState {
    /// 单任务槽（选中翻译 / AI 续写 / 润色 / 摘要 / AI 对话）：全局唯一取消标志
    pub cancel_flag: std::sync::Mutex<Option<Arc<AtomicBool>>>,
    /// v0.7.3：全文翻译并发任务槽位（task_id → 取消标志），多个可同时存在
    pub concurrent_tasks: std::sync::Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl TranslateState {
    /// 开始新任务：取消旧任务（若有）并注册新的取消标志（单任务槽）
    pub fn begin_task(&self) -> Arc<AtomicBool> {
        let mut guard = self.cancel_flag.lock().unwrap();
        if let Some(old) = guard.take() {
            old.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        let flag = Arc::new(AtomicBool::new(false));
        *guard = Some(flag.clone());
        flag
    }

    /// v0.7.3：注册/复用并发任务槽位（全文翻译 batch）。不取消其它任务；
    /// 同一 task_id 重复注册时先取消旧任务（防止孤儿任务占着槽位继续跑）。
    pub fn begin_concurrent_task(&self, id: &str) -> Arc<AtomicBool> {
        let mut guard = self.concurrent_tasks.lock().unwrap();
        let flag = Arc::new(AtomicBool::new(false));
        if let Some(old) = guard.insert(id.to_string(), flag.clone()) {
            old.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        flag
    }

    /// v0.7.3：并发任务正常完成时清理槽位（仅当 map 中仍指向本 flag 才移除，
    /// 防止晚到的旧任务误清新注册任务的槽位）
    pub fn end_concurrent_task(&self, id: &str, flag: &Arc<AtomicBool>) {
        let mut guard = self.concurrent_tasks.lock().unwrap();
        if guard.get(id).is_some_and(|f| std::sync::Arc::ptr_eq(f, flag)) {
            guard.remove(id);
        }
    }

    /// 取消全部任务（单任务槽 + 全部并发槽位）
    pub fn cancel_all(&self) {
        self.cancel_current();
        let guard = self.concurrent_tasks.lock().unwrap();
        for f in guard.values() {
            f.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    }

    /// v0.7.3：取消指定并发任务（全文翻译按批次定向取消）
    pub fn cancel_concurrent_ids(&self, ids: &[String]) {
        let guard = self.concurrent_tasks.lock().unwrap();
        for id in ids {
            if let Some(f) = guard.get(id) {
                f.store(true, std::sync::atomic::Ordering::Relaxed);
            }
        }
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

    // v0.7.3 改进9：并发任务槽位
    #[test]
    fn test_begin_concurrent_task_does_not_cancel_others() {
        let state = TranslateState::default();
        let a = state.begin_concurrent_task("t1");
        let b = state.begin_concurrent_task("t2");
        // 并发任务互不取消
        assert!(!a.load(std::sync::atomic::Ordering::Relaxed));
        assert!(!b.load(std::sync::atomic::Ordering::Relaxed));
        assert_eq!(state.concurrent_tasks.lock().unwrap().len(), 2);
    }

    #[test]
    fn test_begin_concurrent_same_id_cancels_old() {
        let state = TranslateState::default();
        let a = state.begin_concurrent_task("t1");
        let b = state.begin_concurrent_task("t1"); // 同 id 重复注册
        assert!(a.load(std::sync::atomic::Ordering::Relaxed)); // 旧任务被取消
        assert!(!b.load(std::sync::atomic::Ordering::Relaxed));
        assert_eq!(state.concurrent_tasks.lock().unwrap().len(), 1);
    }

    #[test]
    fn test_end_concurrent_task_removes_own_only() {
        let state = TranslateState::default();
        let a = state.begin_concurrent_task("t1");
        state.begin_concurrent_task("t2");
        let b = state.begin_concurrent_task("t1"); // 旧 t1 被顶掉
        state.end_concurrent_task("t1", &a); // 旧 a 迟到完成，不应移除新 b 的槽位
        assert_eq!(state.concurrent_tasks.lock().unwrap().len(), 2);
        assert!(!b.load(std::sync::atomic::Ordering::Relaxed));
        state.end_concurrent_task("t1", &b);
        assert_eq!(state.concurrent_tasks.lock().unwrap().len(), 1);
    }

    #[test]
    fn test_cancel_all_cancels_concurrent_and_single() {
        let state = TranslateState::default();
        let f = state.begin_task();
        let c1 = state.begin_concurrent_task("t1");
        let c2 = state.begin_concurrent_task("t2");
        state.cancel_all();
        assert!(f.load(std::sync::atomic::Ordering::Relaxed));
        assert!(c1.load(std::sync::atomic::Ordering::Relaxed));
        assert!(c2.load(std::sync::atomic::Ordering::Relaxed));
    }

    #[test]
    fn test_cancel_concurrent_ids_selective() {
        let state = TranslateState::default();
        let c1 = state.begin_concurrent_task("t1");
        let c2 = state.begin_concurrent_task("t2");
        state.cancel_concurrent_ids(&["t1".to_string()]);
        assert!(c1.load(std::sync::atomic::Ordering::Relaxed));
        assert!(!c2.load(std::sync::atomic::Ordering::Relaxed));
    }
}
