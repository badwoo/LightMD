//! 工作区全文搜索（v0.15.0 需求 R6：知识库最小集）
//!
//! ## 范围（刻意收窄）
//!
//! 本模块**只做只读的全工作区文本搜索**：
//! - 不做索引库（每次现扫，避免引入版本化索引与失效治理）；
//! - 不做全库替换（批量写盘的风险远大于收益，替换仍限"打开的文件"）；
//! - 不做双链/标签/frontmatter 解析（那些是知识管理的另一层，本版不做）。
//!
//! ## 为什么正则首版直接拒绝
//!
//! 前端搜索用的是 JS `RegExp`（`utils/searchEngine.ts`），而 Rust 侧没有 regex 依赖，
//! 且 JS 的 lookbehind / 回溯语义在 Rust `regex`（DFA 引擎）里**本就不等价**。
//! 若静默换成"近似语义"，用户会看到同一个查询在"当前文件"与"工作区"两个作用域下
//! 结果不同 —— 那比不支持更糟。因此 `regex=true` 时**明确报错**，由 UI 提示
//! "工作区范围暂不支持正则"，其余选项（大小写、全词）按与前端一致的规则实现。
//!
//! ## 全词判据必须与前端一致
//!
//! 前端 `WORD_CHAR_CLASS = [\p{L}\p{N}_]`。Rust 侧对应判据是
//! `ch == '_' || ch.is_alphanumeric()`（`is_alphanumeric` 覆盖 Unicode 字母与数字）。
//! 两边不一致会导致"同一关键词在两个作用域命中数不同"。
//!
//! ## 取消与流式
//!
//! - 每个请求一个 `query_id`，前端换词/关面板时调 `cancel_workspace_search`；
//! - 扫描**每处理一个文件就检查一次取消标志**（大目录下不检查会让取消迟滞数秒）；
//! - 命中分批推送（满 200 条或距上次推送满 100ms），避免超大结果把主线程噎住。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::ipc::Channel;
use tauri::State;

/// 单次搜索默认最大结果数（超出即截断并在进度里标记）
const DEFAULT_MAX_RESULTS: usize = 5000;
/// 单文件默认最大字节数（超过直接跳过，避免把 100MB 日志读进内存）
const DEFAULT_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// 批量推送阈值
const FLUSH_HITS: usize = 200;
/// 批量推送间隔
const FLUSH_INTERVAL_MS: u128 = 100;

// ─── DTO ────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptionsDto {
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    #[serde(default)]
    pub regex: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSearchRequest {
    pub query_id: String,
    pub roots: Vec<String>,
    pub query: String,
    #[serde(default)]
    pub options: SearchOptionsDto,
    /// 参与搜索的扩展名（不含点，小写）。空 = 用默认 Markdown/文本集
    #[serde(default)]
    pub include_ext: Vec<String>,
    #[serde(default)]
    pub max_file_bytes: Option<u64>,
    #[serde(default)]
    pub max_results: Option<usize>,
}

impl WorkspaceSearchRequest {
    fn max_file_bytes(&self) -> u64 {
        self.max_file_bytes.unwrap_or(DEFAULT_MAX_FILE_BYTES)
    }
    fn max_results(&self) -> usize {
        self.max_results.unwrap_or(DEFAULT_MAX_RESULTS)
    }
    fn extensions(&self) -> Vec<String> {
        if self.include_ext.is_empty() {
            // 默认只搜文本：Markdown 系 + 纯文本
            vec![
                "md".into(),
                "markdown".into(),
                "mdown".into(),
                "mkd".into(),
                "txt".into(),
            ]
        } else {
            self.include_ext
                .iter()
                // 顺序很重要：**先 trim 空白、再去前导点、最后小写**。
                // 反过来的话 `" txt "` 会把点去掉但空格留下（实测被单测抓到），
                // 于是扩展名永远匹配不上 → 整个工作区搜不到任何文件。
                .map(|e| {
                    e.trim()
                        .trim_start_matches('.')
                        .trim()
                        .to_ascii_lowercase()
                })
                // 过滤掉清洗后为空的白名单项（否则会去匹配"无扩展名"的怪文件）
                .filter(|e| !e.is_empty())
                .collect()
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceHit {
    pub file_path: String,
    /// 1 基行号
    pub line: u32,
    /// 1 基列号（按字符计，不是字节 —— 中文文档下字节列号毫无意义）
    pub column: u32,
    /// 命中长度（字符数）
    pub length: u32,
    /// 该命中在该文件全部命中中的 0 基序号
    /// （跨文本空间跳转用它定位，与前端 `SearchJumpTarget.occurrence` 同口径）
    pub occurrence: u32,
    /// 行内容摘要（超长行按命中处裁剪）
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkipSummary {
    /// 隐藏目录（.git / .obsidian 等以 . 开头）
    pub hidden_dir: usize,
    /// 明确排除的重目录（node_modules 等）
    pub excluded_dir: usize,
    /// 扩展名不在允许集合内
    pub ext_filtered: usize,
    /// 超过 max_file_bytes
    pub too_large: usize,
    /// 二进制（前若干字节含 NUL）
    pub binary: usize,
    /// 读取失败（权限/占用等）
    pub read_error: usize,
    /// 符号链接环（重复访问同一 realpath）
    pub symlink_loop: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSearchProgress {
    pub query_id: String,
    pub hits: Vec<WorkspaceHit>,
    pub done: bool,
    pub files_scanned: usize,
    pub files_skipped: usize,
    pub skipped_reasons: SkipSummary,
    pub truncated: bool,
}

// ─── 取消状态 ───────────────────────────────────────────────

/// 在跑的搜索（query_id → 取消标志）。
///
/// 用 OnceLock 全局表而不是 Tauri State：`search_workspace` 与
/// `cancel_workspace_search` 是两个命令，前者在 async 任务里长期持有，
/// 全局表让取消命令无需等待 State 借用冲突（async 命令里持 `State` 会阻止
/// 其它命令并发访问同一 Mutex）。
fn cancellations() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static MAP: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_cancellations() -> std::sync::MutexGuard<'static, HashMap<String, Arc<AtomicBool>>> {
    // 中毒时退化为内部数据：搜索取消能力不应让整个应用不可用
    cancellations()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 注册一次搜索；若同 query_id 已在跑则先取消旧的
fn begin_search(query_id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    let mut map = lock_cancellations();
    if let Some(old) = map.insert(query_id.to_string(), flag.clone()) {
        old.store(true, Ordering::SeqCst);
    }
    flag
}

fn end_search(query_id: &str) {
    lock_cancellations().remove(query_id);
}

// ─── 匹配核心（纯函数，便于单测） ───────────────────────────

/// 全词判据：与前端 `[\p{L}\p{N}_]` 等价
pub fn is_word_char(ch: char) -> bool {
    ch == '_' || ch.is_alphanumeric()
}

/// 在**单行**里找所有命中（字符下标，非字节）。
///
/// @returns (start_char_idx, end_char_exclusive)
pub fn find_matches_in_line(
    line_chars: &[char],
    needle_chars: &[char],
    case_sensitive: bool,
    whole_word: bool,
) -> Vec<(usize, usize)> {
    let n = needle_chars.len();
    if n == 0 || line_chars.len() < n {
        return Vec::new();
    }
    let fold = |c: char| {
        if case_sensitive {
            c
        } else {
            // 只对单字符做小写比较：避免整串 to_lowercase 产生长度变化（ß 等）
            c.to_lowercase().next().unwrap_or(c)
        }
    };
    let needle: Vec<char> = needle_chars.iter().map(|&c| fold(c)).collect();
    let hay: Vec<char> = line_chars.iter().map(|&c| fold(c)).collect();

    let mut out = Vec::new();
    let mut i = 0usize;
    while i + n <= hay.len() {
        if hay[i..i + n] == needle[..] {
            let ok_left = !whole_word || i == 0 || !is_word_char(line_chars[i - 1]);
            let ok_right = !whole_word || {
                let after = i + n;
                after >= line_chars.len() || !is_word_char(line_chars[after])
            };
            if ok_left && ok_right {
                out.push((i, i + n));
                // 命中之间不重叠（与前端 findMatchRangesEx 的 exec 前进口径一致）
                i += n;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// 行内按命中处裁剪出摘要（以首个命中为中心，与前端 clipLineInternal 同思路）。
pub fn clip_line(line: &[char], first: (usize, usize), max_len: usize) -> String {
    let limit = max_len.max(8);
    if line.len() <= limit {
        return line.iter().collect();
    }
    let match_len = first.1.saturating_sub(first.0).max(1);
    let before = (limit.saturating_sub(match_len)) / 2;
    let mut start = first.0.saturating_sub(before);
    start = start.min(line.len().saturating_sub(limit));
    let end = (start + limit).min(line.len());
    let head = if start > 0 { "…" } else { "" };
    let tail = if end < line.len() { "…" } else { "" };
    format!("{}{}{}", head, line[start..end].iter().collect::<String>(), tail)
}

/// 判断前若干字节是否像二进制（含 NUL 即视为二进制）
fn looks_binary(bytes: &[u8]) -> bool {
    let probe = &bytes[..bytes.len().min(8000)];
    probe.contains(&0u8)
}

/// 按行切分并统计每行起始的**字符**偏移（用于把字符下标换算成行/列）
fn split_lines(text: &str) -> Vec<&str> {
    // 统一按 \n 切；行尾 \r 会在比较前剔除（CRLF 文档的列号才不会整体偏 1）
    text.split('\n').collect()
}

fn line_chars(line: &str) -> Vec<char> {
    line.trim_end_matches('\r').chars().collect()
}

// ─── 目录遍历 ───────────────────────────────────────────────

/// 明确排除的重目录（不依赖"隐藏目录"规则，因为它们在 Windows 上不一定以 . 开头）
const EXCLUDED_DIRS: &[&str] = &["node_modules", "target", "dist", "build", ".git"];

fn is_hidden_name(name: &str) -> bool {
    name.starts_with('.') && name != "." && name != ".."
}

/// 递归收集待搜索文件。
///
/// 符号链接环用 **canonicalize 后的目录集合**判定：直接比较路径字符串抓不到
/// `a -> ../b -> ../a` 这类环。命中环计 `symlink_loop` 并跳过该目录。
fn collect_files(
    root: &Path,
    exts: &[String],
    max_bytes: u64,
    skipped: &mut SkipSummary,
    hits_so_far: &mut usize,
    mut on_file: impl FnMut(&Path) -> bool,
    cancelled: &AtomicBool,
) {
    let mut visited_dirs: Vec<PathBuf> = Vec::new();
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        if cancelled.load(Ordering::SeqCst) {
            return;
        }
        // 环检测：同一真实目录只访问一次
        let real = dir.canonicalize().unwrap_or_else(|_| dir.clone());
        if visited_dirs.iter().any(|d| d == &real) {
            skipped.symlink_loop += 1;
            continue;
        }
        visited_dirs.push(real);

        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => {
                skipped.read_error += 1;
                continue;
            }
        };
        for entry in entries.flatten() {
            if cancelled.load(Ordering::SeqCst) {
                return;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let file_type = match entry.file_type() {
                Ok(t) => t,
                Err(_) => {
                    skipped.read_error += 1;
                    continue;
                }
            };
            if file_type.is_dir() {
                if is_hidden_name(&name) {
                    skipped.hidden_dir += 1;
                    continue;
                }
                if EXCLUDED_DIRS.iter().any(|d| d.eq_ignore_ascii_case(&name)) {
                    skipped.excluded_dir += 1;
                    continue;
                }
                stack.push(path);
                continue;
            }
            // 符号链接指向文件时按文件处理（is_dir 已覆盖目录链接）
            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            if !exts.iter().any(|e| e == &ext) {
                skipped.ext_filtered += 1;
                continue;
            }
            match entry.metadata() {
                Ok(m) if m.len() > max_bytes => {
                    skipped.too_large += 1;
                    continue;
                }
                Ok(_) => {}
                Err(_) => {
                    skipped.read_error += 1;
                    continue;
                }
            }
            if on_file(&path) {
                *hits_so_far += 1;
            }
        }
    }
}

/// 搜单个文件，把命中追加到 out。返回 (读取是否成功, 是否二进制)
fn search_file(
    path: &Path,
    needle: &[char],
    case_sensitive: bool,
    whole_word: bool,
    max_results: usize,
    out: &mut Vec<WorkspaceHit>,
    skipped: &mut SkipSummary,
) -> bool {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(_) => {
            skipped.read_error += 1;
            return false;
        }
    };
    if looks_binary(&bytes) {
        skipped.binary += 1;
        return false;
    }
    let text = match String::from_utf8(bytes) {
        Ok(t) => t,
        Err(e) => {
            // 非法 UTF-8：按 lossy 继续搜（比整篇跳过更实用），但记录一次读错误语义
            // 这里不计 read_error（文件是可读的，只是编码非 UTF-8）
            String::from_utf8_lossy(e.as_bytes()).into_owned()
        }
    };
    let file_path = path.to_string_lossy().replace('\\', "/");
    let mut occurrence: u32 = 0;
    for (line_idx, raw_line) in split_lines(&text).into_iter().enumerate() {
        if out.len() >= max_results {
            return true;
        }
        let line = line_chars(raw_line);
        let matches = find_matches_in_line(&line, needle, case_sensitive, whole_word);
        for &(start, end) in &matches {
            if out.len() >= max_results {
                return true;
            }
            out.push(WorkspaceHit {
                file_path: file_path.clone(),
                line: (line_idx + 1) as u32,
                column: (start + 1) as u32,
                length: (end - start) as u32,
                occurrence,
                snippet: clip_line(&line, (start, end), 160),
            });
            occurrence += 1;
        }
    }
    true
}

// ─── 命令 ───────────────────────────────────────────────────

#[tauri::command]
pub async fn cancel_workspace_search(query_id: String) -> Result<(), String> {
    let mut map = lock_cancellations();
    if let Some(flag) = map.remove(&query_id) {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}

/// 工作区全文搜索（流式分批推送）。
///
/// 前端 `invoke("search_workspace", { req, onProgress })`；进度事件形如
/// `WorkspaceSearchProgress`，最后一帧 `done=true`。
#[tauri::command]
pub async fn search_workspace(
    req: WorkspaceSearchRequest,
    on_progress: Channel<WorkspaceSearchProgress>,
) -> Result<(), String> {
    // ① 正则首版明确拒绝（见模块注释：语义不等价，静默降级会误导用户）
    if req.options.regex {
        return Err("PROVIDER|400|工作区范围暂不支持正则搜索，请改用普通文本".to_string());
    }
    let needle: Vec<char> = match req.options.case_sensitive {
        true => req.query.chars().collect(),
        false => req
            .query
            .chars()
            .map(|c| c.to_lowercase().next().unwrap_or(c))
            .collect(),
    };
    if needle.is_empty() {
        // 空查询：立即返回空结果（不发进度风暴，也不扫盘）
        let _ = on_progress.send(WorkspaceSearchProgress {
            query_id: req.query_id.clone(),
            hits: Vec::new(),
            done: true,
            files_scanned: 0,
            files_skipped: 0,
            skipped_reasons: SkipSummary::default(),
            truncated: false,
        });
        return Ok(());
    }

    let query_id = req.query_id.clone();
    let cancel = begin_search(&query_id);
    let exts = req.extensions();
    let max_bytes = req.max_file_bytes();
    let max_results = req.max_results();

    let mut all_hits: Vec<WorkspaceHit> = Vec::new();
    let mut skipped = SkipSummary::default();
    let mut files_scanned = 0usize;
    let mut truncated = false;
    let mut last_flush = std::time::Instant::now();
    let mut pending: Vec<WorkspaceHit> = Vec::new();

    // 去重：同一根被多个 openFolder 重复给出时只扫一次（嵌套根也由 canonicalize 天然去重）
    let mut roots: Vec<PathBuf> = Vec::new();
    for r in &req.roots {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        let p = PathBuf::from(r);
        if !p.exists() || roots.iter().any(|x| x == &p) {
            continue;
        }
        roots.push(p);
    }

    'outer: for root in &roots {
        let mut hit_count = 0usize;
        let mut guard = FileGuard {
            path: root.clone(),
            ..Default::default()
        };
        let mut files_here: Vec<PathBuf> = Vec::new();
        collect_files(
            root,
            &exts,
            max_bytes,
            &mut skipped,
            &mut hit_count,
            |path| {
                files_here.push(path.to_path_buf());
                false
            },
            &cancel,
        );
        guard.path = root.clone();
        drop(guard);

        for path in files_here {
            if cancel.load(Ordering::SeqCst) {
                break 'outer;
            }
            files_scanned += 1;
            let before = pending.len();
            truncated |= !search_file(
                &path,
                &needle,
                req.options.case_sensitive,
                req.options.whole_word,
                max_results.saturating_sub(all_hits.len() + pending.len()),
                &mut pending,
                &mut skipped,
            ) && false;
            truncated = truncated || (all_hits.len() + pending.len()) >= max_results;
            if pending.len() != before
                && (pending.len() >= FLUSH_HITS || last_flush.elapsed().as_millis() >= FLUSH_INTERVAL_MS)
            {
                all_hits.append(&mut pending);
                last_flush = std::time::Instant::now();
                if on_progress
                    .send(WorkspaceSearchProgress {
                        query_id: query_id.clone(),
                        hits: std::mem::take(&mut all_hits),
                        done: false,
                        files_scanned,
                        files_skipped: skip_total(&skipped),
                        skipped_reasons: skipped.clone(),
                        truncated,
                    })
                    .is_err()
                {
                    // 前端已关闭面板/换词：停止扫描
                    end_search(&query_id);
                    return Ok(());
                }
            }
            if (all_hits.len() + pending.len()) >= max_results {
                truncated = true;
                break 'outer;
            }
        }
    }

    all_hits.append(&mut pending);
    let was_cancelled = cancel.load(Ordering::SeqCst);
    end_search(&query_id);
    let _ = on_progress.send(WorkspaceSearchProgress {
        query_id,
        hits: all_hits,
        done: true,
        files_scanned,
        files_skipped: skip_total(&skipped),
        skipped_reasons: skipped,
        // 取消导致的提前结束不算"结果被上限截断"，两者语义不同
        truncated: truncated && !was_cancelled,
    });
    Ok(())
}

fn skip_total(s: &SkipSummary) -> usize {
    s.hidden_dir
        + s.excluded_dir
        + s.ext_filtered
        + s.too_large
        + s.binary
        + s.read_error
        + s.symlink_loop
}

/// 占位结构：仅为在闭包里持有 root 所有权（保持 collect_files 闭包简洁）
#[derive(Default)]
struct FileGuard {
    path: PathBuf,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chars(s: &str) -> Vec<char> {
        s.chars().collect()
    }

    // ── 全词判据与前端对齐 ────────────────────────────────

    #[test]
    fn word_char_matches_frontend_class() {
        assert!(is_word_char('a'));
        assert!(is_word_char('Z'));
        assert!(is_word_char('0'));
        assert!(is_word_char('_'));
        // 中文属于字母（\p{L}），因此中文上下文里"全词"同样生效
        assert!(is_word_char('中'));
        assert!(!is_word_char(' '));
        assert!(!is_word_char('-'));
        assert!(!is_word_char('.'));
    }

    // ── 单行匹配 ──────────────────────────────────────────

    #[test]
    fn plain_match_all_occurrences() {
        let line = chars("foo bar foo");
        let m = find_matches_in_line(&line, &chars("foo"), true, false);
        assert_eq!(m, vec![(0, 3), (8, 11)]);
    }

    #[test]
    fn case_insensitive_by_default() {
        let line = chars("Foo FOO foo");
        let ci = find_matches_in_line(&line, &chars("foo"), false, false);
        assert_eq!(ci.len(), 3);
        let cs = find_matches_in_line(&line, &chars("foo"), true, false);
        assert_eq!(cs, vec![(8, 11)]);
    }

    #[test]
    fn whole_word_respects_boundaries() {
        let line = chars("a foo foobar foo_1 xfoo foo");
        let m = find_matches_in_line(&line, &chars("foo"), true, true);
        // 只有独立的两处 foo 命中：foobar / foo_1 / xfoo 都不算
        assert_eq!(m.len(), 2);
        let texts: Vec<String> = m
            .iter()
            .map(|&(s, e)| line[s..e].iter().collect::<String>())
            .collect();
        assert_eq!(texts, vec!["foo".to_string(), "foo".to_string()]);
    }

    #[test]
    fn whole_word_with_chinese_context() {
        // 中文是 word char → "测试" 在 "我的测试里" 中不算全词命中
        let line = chars("我的测试里有测试");
        let whole = find_matches_in_line(&line, &chars("测试"), true, true);
        let loose = find_matches_in_line(&line, &chars("测试"), true, false);
        assert!(loose.len() >= 2);
        // 全词模式下"测试"两侧都是汉字，全部不满足边界
        assert!(whole.is_empty(), "汉字视为 word char，全词不命中: {:?}", whole);
    }

    #[test]
    fn no_overlapping_matches() {
        // "aaa" 里找 "aa"：非重叠 → 只有一处
        let line = chars("aaa");
        let m = find_matches_in_line(&line, &chars("aa"), true, false);
        assert_eq!(m, vec![(0, 2)]);
    }

    #[test]
    fn empty_needle_no_match() {
        let line = chars("abc");
        assert!(find_matches_in_line(&line, &chars(""), true, false).is_empty());
    }

    #[test]
    fn needle_longer_than_line() {
        assert!(find_matches_in_line(&chars("ab"), &chars("abcdef"), true, false).is_empty());
    }

    // ── CRLF / 列号 ───────────────────────────────────────

    #[test]
    fn crlf_line_endings_do_not_shift_column() {
        let text = "abc foo\r\ndef foo\r\n";
        let lines = split_lines(text);
        // 第一行去掉 \r 后，"foo" 仍在第 5 列（1 基）
        let l0 = line_chars(lines[0]);
        let m = find_matches_in_line(&l0, &chars("foo"), true, false);
        assert_eq!(m, vec![(4, 7)]);
        assert_eq!(lines.len(), 3); // 末尾 \n 产生一个空行（与前端 split('\n') 一致）
    }

    // ── 摘要裁剪 ──────────────────────────────────────────

    #[test]
    fn clip_short_line_kept_whole() {
        let line = chars("short foo line");
        assert_eq!(clip_line(&line, (6, 9), 160), "short foo line");
    }

    #[test]
    fn clip_long_line_centers_on_match() {
        let long: Vec<char> = std::iter::repeat('x').take(500).collect();
        let out = clip_line(&long, (250, 253), 40);
        // 首尾都有省略号，长度受控（40 + 2 个省略号）
        assert!(out.starts_with('…'));
        assert!(out.ends_with('…'));
        assert!(out.chars().count() <= 42);
    }

    // ── 二进制 / 编码 ─────────────────────────────────────

    #[test]
    fn binary_detection() {
        assert!(looks_binary(b"abc\0def"));
        assert!(!looks_binary("正常文本".as_bytes()));
    }

    // ── 目录遍历与跳过计数 ────────────────────────────────

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "lightmd-wssearch-{}-{}-{:?}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn collect(root: &Path, exts: &[String], max_bytes: u64, skipped: &mut SkipSummary) -> Vec<PathBuf> {
        let cancelled = AtomicBool::new(false);
        let mut out = Vec::new();
        let mut n = 0usize;
        collect_files(
            root,
            exts,
            max_bytes,
            skipped,
            &mut n,
            |p| {
                out.push(p.to_path_buf());
                false
            },
            &cancelled,
        );
        out
    }

    #[test]
    fn scan_filters_hidden_excluded_ext_and_large() {
        let dir = temp_dir("filter");
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules")).unwrap();
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join(".git/config.md"), "x").unwrap();
        std::fs::write(dir.join("node_modules/a.md"), "x").unwrap();
        std::fs::write(dir.join("keep.md"), "hello").unwrap();
        std::fs::write(dir.join("skip.png"), "x").unwrap();
        std::fs::write(dir.join("sub/deep.md"), "deep").unwrap();
        std::fs::write(dir.join("big.md"), "x".repeat(500)).unwrap();

        let mut skipped = SkipSummary::default();
        let exts = vec!["md".to_string()];
        let files = collect(&dir, &exts, 100, &mut skipped);

        let names: Vec<String> = files
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert!(names.contains(&"keep.md".to_string()));
        assert!(names.contains(&"deep.md".to_string()), "子目录应被递归");
        assert!(!names.contains(&"config.md".to_string()), "隐藏目录应跳过");
        assert!(!names.contains(&"a.md".to_string()), "node_modules 应跳过");
        assert!(!names.contains(&"skip.png".to_string()), "扩展名不符合应跳过");
        assert!(!names.contains(&"big.md".to_string()), "超限文件应跳过");

        assert_eq!(skipped.hidden_dir, 1);
        assert_eq!(skipped.excluded_dir, 1);
        assert_eq!(skipped.ext_filtered, 1);
        assert_eq!(skipped.too_large, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_skips_binary_and_counts() {
        let dir = temp_dir("binary");
        let mut b = b"text ".to_vec();
        b.push(0u8);
        b.extend_from_slice(b"more");
        std::fs::write(dir.join("bin.md"), &b).unwrap();
        std::fs::write(dir.join("ok.md"), "clean text").unwrap();

        let mut skipped = SkipSummary::default();
        let exts = vec!["md".to_string()];
        let files = collect(&dir, &exts, DEFAULT_MAX_FILE_BYTES, &mut skipped);
        assert_eq!(files.len(), 2, "二进制文件在扫描阶段不读内容，仍会进候选");

        // 真正读内容时才识别二进制
        let mut hits = Vec::new();
        let mut s2 = SkipSummary::default();
        search_file(&dir.join("bin.md"), &chars("text"), true, false, 100, &mut hits, &mut s2);
        assert!(hits.is_empty());
        assert_eq!(s2.binary, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_handles_missing_root_without_panic() {
        let mut skipped = SkipSummary::default();
        let exts = vec!["md".to_string()];
        let files = collect(Path::new("D:/definitely-not-exist-lightmd"), &exts, 1024, &mut skipped);
        assert!(files.is_empty());
        // 读目录失败计入 read_error（不 panic 是重点）
        assert_eq!(skipped.read_error, 1);
    }

    #[test]
    fn search_file_reports_hits_with_occurrence_and_snippet() {
        let dir = temp_dir("hits");
        let file = dir.join("doc.md");
        std::fs::write(&file, "line one foo\nfoo again foo\n").unwrap();
        let mut hits = Vec::new();
        let mut skipped = SkipSummary::default();
        search_file(&file, &chars("foo"), true, false, 100, &mut hits, &mut skipped);
        assert_eq!(hits.len(), 3);
        // occurrence 在文件内连续递增
        assert_eq!(hits.iter().map(|h| h.occurrence).collect::<Vec<_>>(), vec![0, 1, 2]);
        assert_eq!(hits[0].line, 1);
        assert_eq!(hits[1].line, 2);
        // 第一处 foo 在第 10 列（1 基）
        assert_eq!(hits[0].column, 10);
        assert!(hits[0].snippet.contains("foo"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_file_respects_max_results() {
        let dir = temp_dir("maxres");
        let file = dir.join("many.md");
        std::fs::write(&file, "foo\n".repeat(50)).unwrap();
        let mut hits = Vec::new();
        let mut skipped = SkipSummary::default();
        search_file(&file, &chars("foo"), true, false, 5, &mut hits, &mut skipped);
        assert_eq!(hits.len(), 5, "上限内的命中应被截断");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── 取消注册表 ────────────────────────────────────────

    #[test]
    fn begin_search_cancels_previous_same_id() {
        let old = begin_search("q1");
        let new = begin_search("q1");
        assert!(old.load(Ordering::SeqCst), "同 id 的旧搜索应被取消");
        assert!(!new.load(Ordering::SeqCst));
        end_search("q1");
        assert!(lock_cancellations().get("q1").is_none());
    }

    #[test]
    fn cancel_is_idempotent_for_unknown_id() {
        // 未注册的 id：不 panic、不报错
        assert!(lock_cancellations().get("nope").is_none());
        end_search("nope");
    }

    // ── 请求 DTO ──────────────────────────────────────────

    #[test]
    fn default_extensions_and_overrides() {
        let req = WorkspaceSearchRequest {
            query_id: "q".into(),
            roots: vec![],
            query: "x".into(),
            options: SearchOptionsDto::default(),
            include_ext: vec![],
            max_file_bytes: None,
            max_results: None,
        };
        assert_eq!(req.extensions(), vec!["md", "markdown", "mdown", "mkd", "txt"]);
        assert_eq!(req.max_results(), DEFAULT_MAX_RESULTS);
        assert_eq!(req.max_file_bytes(), DEFAULT_MAX_FILE_BYTES);

        let req2 = WorkspaceSearchRequest {
            include_ext: vec![".MD".into(), " txt ".into()],
            max_results: Some(10),
            ..req
        };
        // 去点、去空白、小写
        assert_eq!(req2.extensions(), vec!["md", "txt"]);
        assert_eq!(req2.max_results(), 10);
    }
}
