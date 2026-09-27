use std::path::PathBuf;

use tauri::Manager;

/// 限制读取文件的最大大小 (50MB)
const MAX_FILE_SIZE: u64 = 50 * 1024 * 1024;

/// 去掉 Windows 扩展长度路径前缀（`\\?\` 及其正斜杠形式 `//?/`）。
///
/// `canonicalize()` 在 Windows 上返回 `\\?\D:\dir\file`，前缀一旦泄漏到前端：
/// 1. 侧栏文件树显示成 `//?/D:/...`，路径可读性差；
/// 2. 相对路径图片解析会把它当作普通路径段，转成 asset URL 时被百分号编码为
///    `%3F%2F`（`//?/D:/a/x.png` → `.../%3F%2FD%3A%2Fa/x.png`），
///    Tauri 资源协议随之找不到文件 —— 表现为"通过文件夹打开的 md 图片不渲染"。
/// 因此所有返回给前端的路径都先剥掉该前缀。
fn strip_extended_prefix(path: &str) -> String {
    path.strip_prefix(r"\\?\")
        .or_else(|| path.strip_prefix("//?/"))
        .unwrap_or(path)
        .to_string()
}

/// 将路径规范化为绝对路径
/// v0.8.4：改为 pub(crate)，供 watcher 模块复用，保证各命令的路径解析口径一致
pub(crate) fn resolve_path(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    let resolved = if p.exists() {
        p.canonicalize()
            .map_err(|e| format!("无法解析路径 \"{}\": {}", path, e))?
    } else if p.is_absolute() {
        p
    } else {
        std::env::current_dir()
            .map_err(|e| format!("无法获取当前目录: {}", e))?
            .join(&p)
    };
    // v0.8.2 修复：剥掉 `\\?\` 扩展长度前缀再交给调用方
    Ok(PathBuf::from(strip_extended_prefix(&resolved.to_string_lossy())))
}

#[tauri::command]
pub async fn read_file(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let path = resolve_path(&path)?;
    if !path.exists() {
        return Err(format!("文件不存在: {}", path.display()));
    }
    if !path.is_file() {
        return Err(format!("路径不是文件: {}", path.display()));
    }
    // v0.6.3 S-3：asset 协议作用域已收敛为空，打开文件时动态授权其所在目录（递归），
    // 供 markdown 相对路径图片预览使用；授权失败不阻断文件读取
    if let Some(parent) = path.parent() {
        let _ = app.asset_protocol_scope().allow_directory(parent, true);
    }
    let meta = path
        .metadata()
        .map_err(|e| format!("无法读取文件元数据 \"{}\": {}", path.display(), e))?;
    if meta.len() > MAX_FILE_SIZE {
        return Err(format!(
            "文件过大（{:.1}MB），最大支持 50MB",
            meta.len() as f64 / 1024.0 / 1024.0
        ));
    }
    std::fs::read_to_string(&path)
        .map_err(|e| format!("读取文件失败 \"{}\": {}", path.display(), e))
}

#[tauri::command]
pub async fn write_file(path: String, content: String) -> Result<(), String> {
    let path = resolve_path(&path)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建父目录 \"{}\": {}", parent.display(), e))?;
    }
    std::fs::write(&path, &content)
        .map_err(|e| format!("写入文件失败 \"{}\": {}", path.display(), e))?;
    // v0.9.0 修复：记录本次自身写入的 mtime，抑制紧随其后的 watcher 事件。
    // 否则「应用自己保存」会被前端误判为「文件被外部修改」——保存即弹
    // 「覆盖 / 另存为」、覆盖后再触发，形成无限黄色提示循环。
    super::super::window::open_files::note_file_written(&path.to_string_lossy());
    Ok(())
}

/// 获取文件大小（字节），用于前端大文件检测
#[tauri::command]
pub async fn get_file_size(path: String) -> Result<u64, String> {
    let path = resolve_path(&path)?;
    if !path.exists() {
        return Err(format!("文件不存在: {}", path.display()));
    }
    let meta = path
        .metadata()
        .map_err(|e| format!("无法读取文件元数据 \"{}\": {}", path.display(), e))?;
    Ok(meta.len())
}

#[tauri::command]
pub async fn list_dir(path: String) -> Result<Vec<FileEntry>, String> {
    // v0.8.4 需求7.1：拆出同步核心 list_dir_entries 便于单元测试
    list_dir_entries(&resolve_path(&path)?)
}

/// SystemTime → UNIX 纪元毫秒时间戳。
/// 读取失败（平台不支持）或早于 UNIX_EPOCH 时统一置 0。
fn system_time_to_ms(time: Option<std::time::SystemTime>) -> u64 {
    time.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 读取目录内容（同步核心，供 list_dir 命令与单测共用）。
/// 返回条目按"目录在前 + 名称升序"排序；隐藏文件（`.` 开头）被过滤。
fn list_dir_entries(path: &std::path::Path) -> Result<Vec<FileEntry>, String> {
    if !path.exists() {
        return Err(format!("目录不存在: {}", path.display()));
    }
    if !path.is_dir() {
        return Err(format!("路径不是目录: {}", path.display()));
    }
    let mut entries = Vec::new();
    let dir = std::fs::read_dir(path)
        .map_err(|e| format!("读取目录失败 \"{}\": {}", path.display(), e))?;
    for entry in dir {
        let entry =
            entry.map_err(|e| format!("读取目录条目失败 \"{}\": {}", path.display(), e))?;
        let metadata = entry
            .metadata()
            .map_err(|e| format!("读取文件元数据失败: {}", e))?;
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name.starts_with('.') {
            continue;
        }
        entries.push(FileEntry {
            name: file_name,
            path: entry.path().to_string_lossy().to_string().replace('\\', "/"),
            is_dir: metadata.is_dir(),
            size: metadata.len(),
            // v0.8.4 需求7.1：修改/创建时间（毫秒），供前端排序
            modified_ms: system_time_to_ms(metadata.modified().ok()),
            created_ms: system_time_to_ms(metadata.created().ok()),
        });
    }
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(entries)
}

#[tauri::command]
pub async fn create_file(path: String) -> Result<(), String> {
    let path = resolve_path(&path)?;
    if path.exists() {
        return Err(format!("文件已存在: {}", path.display()));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建父目录 \"{}\": {}", parent.display(), e))?;
    }
    std::fs::write(&path, "").map_err(|e| format!("创建文件失败 \"{}\": {}", path.display(), e))
}

/// 创建目录。
/// v0.8.0 修复 P2-5：改用 `create_dir` 而非 `create_dir_all`——旧实现对**已存在**
/// 的目录静默成功，前端"新建文件夹"会提示"已创建"而其实什么都没发生。
/// 现在目录已存在会返回明确错误，由前端按"部分失败"提示用户。
#[tauri::command]
pub async fn create_dir(path: String) -> Result<(), String> {
    let path = resolve_path(&path)?;
    std::fs::create_dir(&path).map_err(|e| {
        if path.exists() {
            format!("目录已存在 \"{}\"", path.display())
        } else {
            format!("创建目录失败 \"{}\": {}", path.display(), e)
        }
    })
}

/// v0.8.5 需求2：删除文件/目录 = 移到系统回收站（可从回收站还原），不再永久删除。
#[tauri::command]
pub async fn delete_file(path: String) -> Result<(), String> {
    // v0.8.5 需求2：拆出同步核心 delete_path 便于单元测试（同 list_dir/move_file 模式）
    delete_path(&resolve_path(&path)?)
}

/// delete_file 的同步核心（供单测复用）。
/// v0.8.5 需求2：删除 = 移到系统回收站（可从回收站还原）。文件与目录统一走
/// `trash::delete`（Windows 走 IFileOperation，文件/目录进入回收站而非永久删除），
/// 命令名与参数签名保持不变，前端零改动调用，仅语义由"永久删除"变为"可还原"。
fn delete_path(path: &std::path::Path) -> Result<(), String> {
    // trash::delete 对不存在的路径会报错，此处先行校验以给出一致的友好错误
    if !path.exists() {
        return Err(format!("文件不存在: {}", path.display()));
    }
    trash::delete(path).map_err(|e| format!("移到回收站失败 \"{}\": {}", path.display(), e))
}

#[tauri::command]
pub async fn rename_file(old_path: String, new_path: String) -> Result<(), String> {
    let old_path = resolve_path(&old_path)?;
    let new_path = resolve_path(&new_path)?;
    if !old_path.exists() {
        return Err(format!("源文件不存在: {}", old_path.display()));
    }
    if new_path.exists() {
        return Err(format!("目标文件已存在: {}", new_path.display()));
    }
    if let Some(parent) = new_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建目标目录 \"{}\": {}", parent.display(), e))?;
    }
    std::fs::rename(&old_path, &new_path).map_err(|e| {
        format!(
            "重命名失败 \"{}\" -> \"{}\": {}",
            old_path.display(),
            new_path.display(),
            e
        )
    })
}

/// v0.8.0 WP2 需求1：复制文件或目录。
/// - 文件：标准 copy。
/// - 目录：递归复制。
/// - 目标已存在则报错（防静默覆盖，重名处理交给前端生成不冲突的名字）。
#[tauri::command]
pub async fn copy_file(src: String, dst: String) -> Result<(), String> {
    let src = resolve_path(&src)?;
    let dst = resolve_path(&dst)?;
    if !src.exists() {
        return Err(format!("源路径不存在: {}", src.display()));
    }
    if dst.exists() {
        return Err(format!("目标已存在: {}", dst.display()));
    }
    if src.is_dir() {
        copy_dir_recursive(&src, &dst)
    } else {
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("无法创建目标父目录 \"{}\": {}", parent.display(), e))?;
        }
        std::fs::copy(&src, &dst).map_err(|e| {
            format!(
                "复制文件失败 \"{}\" -> \"{}\": {}",
                src.display(),
                dst.display(),
                e
            )
        })?;
        Ok(())
    }
}

/// 递归复制目录（含子目录与文件）。目标已存在由调用方（copy_file）先行检查。
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dst)
        .map_err(|e| format!("无法创建目录 \"{}\": {}", dst.display(), e))?;
    let dir = std::fs::read_dir(src)
        .map_err(|e| format!("读取目录失败 \"{}\": {}", src.display(), e))?;
    for entry in dir {
        let entry = entry.map_err(|e| format!("读取目录条目失败: {}", e))?;
        let entry_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if entry_path.is_dir() {
            copy_dir_recursive(&entry_path, &dst_path)?;
        } else {
            std::fs::copy(&entry_path, &dst_path).map_err(|e| {
                format!(
                    "复制文件失败 \"{}\" -> \"{}\": {}",
                    entry_path.display(),
                    dst_path.display(),
                    e
                )
            })?;
        }
    }
    Ok(())
}

/// v0.8.4 需求1：移动文件或目录（拖拽 Shift 移动）。
/// 同盘直接 rename（快）；失败（典型为跨卷）降级为"递归复制 + 删除源"。
/// 目标已存在则报错（防静默覆盖）。
#[tauri::command]
pub async fn move_file(src: String, dst: String) -> Result<(), String> {
    move_path(&resolve_path(&src)?, &resolve_path(&dst)?)
}

/// move_file 的同步核心（供单测复用）。
/// - 检查 src 存在、dst 不存在；
/// - dst 父目录不存在时先 create_dir_all；
/// - rename 失败时按 src 类型降级：目录 copy_dir_recursive + remove_dir_all，
///   文件 fs::copy + remove_file。
fn move_path(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    if !src.exists() {
        return Err(format!("源路径不存在: {}", src.display()));
    }
    if dst.exists() {
        return Err(format!("目标已存在: {}", dst.display()));
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建目标目录 \"{}\": {}", parent.display(), e))?;
    }
    // 同盘 rename 极快且原子；跨卷（如 D: → C:）rename 会失败，走降级路径
    match std::fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(_) => {
            if src.is_dir() {
                copy_dir_recursive(src, dst)?;
                std::fs::remove_dir_all(src)
                    .map_err(|e| format!("删除源目录失败 \"{}\": {}", src.display(), e))
            } else {
                std::fs::copy(src, dst).map_err(|e| {
                    format!(
                        "移动文件失败 \"{}\" -> \"{}\": {}",
                        src.display(),
                        dst.display(),
                        e
                    )
                })?;
                std::fs::remove_file(src)
                    .map_err(|e| format!("删除源文件失败 \"{}\": {}", src.display(), e))
            }
        }
    }
}

#[tauri::command]
pub async fn ping() -> String {
    "pong".to_string()
}

#[tauri::command]
pub async fn log_from_frontend(level: String, message: String) {
    match level.as_str() {
        "error" => eprintln!("[Frontend ERROR] {}", message),
        "warn" => println!("[Frontend WARN] {}", message),
        _ => println!("[Frontend] {}", message),
    }
}

#[tauri::command]
pub async fn exists(path: String) -> bool {
    PathBuf::from(&path).exists()
}

/// 在系统资源管理器中显示并选中指定文件（N5：右键菜单"打开文件所在目录"）
#[tauri::command]
pub async fn reveal_in_folder(path: String) -> Result<(), String> {
    let path = resolve_path(&path)?;
    if !path.exists() {
        return Err(format!("文件不存在: {}", path.display()));
    }
    #[cfg(target_os = "windows")]
    {
        // explorer /select,<path>：打开父目录并选中该文件
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path.display()))
            .spawn()
            .map_err(|e| format!("打开资源管理器失败: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        // open -R：在 Finder 中显示并选中该文件
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("打开 Finder 失败: {}", e))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // Linux 无统一选中协议，退化为打开父目录
        let parent = path.parent().ok_or_else(|| "无父目录".to_string())?;
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| format!("打开文件管理器失败: {}", e))?;
    }
    Ok(())
}

/// 目录条目（v0.8.4 需求7.1：新增修改/创建时间毫秒字段，供前端标题栏排序）
#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// 修改时间（UNIX 纪元毫秒）；metadata.modified() 失败或早于纪元时为 0
    pub modified_ms: u64,
    /// 创建时间（UNIX 纪元毫秒）；平台不支持 metadata.created() 时为 0
    pub created_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// v0.8.2 修复：Windows 扩展长度前缀必须被剥掉，
    /// 否则前端相对路径图片会被编码成 `%3F%2F...` 导致渲染失败。
    #[test]
    fn strip_extended_prefix_removes_backslash_form() {
        assert_eq!(
            strip_extended_prefix(r"\\?\D:\docs\a.md"),
            r"D:\docs\a.md"
        );
    }

    #[test]
    fn strip_extended_prefix_removes_forward_slash_form() {
        assert_eq!(strip_extended_prefix("//?/D:/docs/a.md"), "D:/docs/a.md");
    }

    #[test]
    fn strip_extended_prefix_keeps_unc_path() {
        // UNC 路径 `\\server\share` 没有 `?` 段，不能被改动
        assert_eq!(
            strip_extended_prefix(r"\\server\share\a.md"),
            r"\\server\share\a.md"
        );
    }

    #[test]
    fn strip_extended_prefix_keeps_plain_path() {
        assert_eq!(strip_extended_prefix("D:/docs/a.md"), "D:/docs/a.md");
        assert_eq!(strip_extended_prefix("/home/u/a.md"), "/home/u/a.md");
    }

    /// list_dir 返回的路径不得再带扩展长度前缀
    #[test]
    fn list_dir_paths_have_no_extended_prefix() {
        let dir = std::env::temp_dir().join("lightmd_ext_prefix_test");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("probe.md"), "x").unwrap();
        let resolved = resolve_path(&dir.to_string_lossy()).unwrap();
        assert!(
            !resolved.to_string_lossy().starts_with(r"\\?\"),
            "resolve_path 不应保留 \\\\?\\ 前缀: {}",
            resolved.display()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// v0.8.4 需求7.1：list_dir 必须填充修改时间毫秒字段（> 0，供前端时间排序）；
    /// created 平台不支持时允许为 0（仅断言修改时间）。
    #[test]
    fn list_dir_fills_time_fields() {
        let dir = std::env::temp_dir().join("lightmd_time_fields_test");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("t.md"), "x").unwrap();
        let entries = list_dir_entries(&dir).unwrap();
        let entry = entries
            .iter()
            .find(|e| e.name == "t.md")
            .expect("目录条目 t.md 应存在");
        assert!(entry.modified_ms > 0, "modified_ms 应为有效毫秒时间戳");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// v0.8.4 需求7.1：时间转换兜底——None（平台不支持）与早于纪元的时间均置 0
    #[test]
    fn system_time_to_ms_falls_back_to_zero() {
        assert_eq!(system_time_to_ms(None), 0);
        assert_eq!(
            system_time_to_ms(Some(std::time::SystemTime::UNIX_EPOCH)),
            0
        );
        // 早于 UNIX_EPOCH 的时间（duration_since 失败）也应为 0
        let before_epoch = std::time::SystemTime::UNIX_EPOCH - std::time::Duration::from_secs(1);
        assert_eq!(system_time_to_ms(Some(before_epoch)), 0);
    }

    /// v0.8.4 需求1：同盘移动文件（rename 成功路径）
    #[test]
    fn move_path_renames_file_same_volume() {
        let dir = std::env::temp_dir().join("lightmd_move_file_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("a.md");
        let dst = dir.join("b.md");
        std::fs::write(&src, "hello").unwrap();
        move_path(&src, &dst).unwrap();
        assert!(dst.exists(), "目标文件应存在");
        assert!(!src.exists(), "源文件应已移除");
        assert_eq!(std::fs::read_to_string(&dst).unwrap(), "hello");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// v0.8.4 需求1：移动整个目录（含嵌套子树）
    #[test]
    fn move_path_moves_directory_tree() {
        let dir = std::env::temp_dir().join("lightmd_move_dir_test");
        let _ = std::fs::remove_dir_all(&dir);
        let src = dir.join("src_dir");
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::write(src.join("sub").join("x.md"), "content").unwrap();
        let dst = dir.join("dst_dir");
        move_path(&src, &dst).unwrap();
        assert!(
            dst.join("sub").join("x.md").exists(),
            "嵌套子文件应随目录整体移动"
        );
        assert!(!src.exists(), "源目录应已移除");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// v0.8.4 需求1：目标父目录不存在时应自动创建
    #[test]
    fn move_path_creates_missing_dst_parent() {
        let dir = std::env::temp_dir().join("lightmd_move_parent_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("a.md");
        std::fs::write(&src, "x").unwrap();
        let dst = dir.join("new_parent").join("a.md");
        move_path(&src, &dst).unwrap();
        assert!(dst.exists(), "目标父目录缺失时应自动创建并完成移动");
        assert!(!src.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// v0.8.4 需求1：目标已存在必须报错（防静默覆盖）
    #[test]
    fn move_path_errors_when_dst_exists() {
        let dir = std::env::temp_dir().join("lightmd_move_dst_exists_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("a.md");
        let dst = dir.join("b.md");
        std::fs::write(&src, "x").unwrap();
        std::fs::write(&dst, "y").unwrap();
        let err = move_path(&src, &dst).unwrap_err();
        assert!(err.contains("目标已存在"), "错误信息应包含'目标已存在': {}", err);
        // 失败时双方均不得被破坏
        assert!(src.exists() && dst.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// v0.8.4 需求1：源不存在必须报错
    #[test]
    fn move_path_errors_when_src_missing() {
        let dir = std::env::temp_dir().join("lightmd_move_src_missing_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("ghost.md");
        let dst = dir.join("b.md");
        let err = move_path(&src, &dst).unwrap_err();
        assert!(err.contains("源路径不存在"), "错误信息应包含'源路径不存在': {}", err);
        assert!(!dst.exists(), "报错后不应产生目标文件");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// v0.8.4 需求1：跨盘降级路径——目录 copy_dir_recursive + remove_dir_all 的
    /// 组合行为（rename 在单卷测试环境难以强制失败，此处直接验证降级组合的正确性）
    #[test]
    fn move_fallback_combo_copies_then_removes_dir() {
        let dir = std::env::temp_dir().join("lightmd_move_fallback_test");
        let _ = std::fs::remove_dir_all(&dir);
        let src = dir.join("src_dir");
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::write(src.join("sub").join("x.md"), "c").unwrap();
        let dst = dir.join("dst_dir");
        copy_dir_recursive(&src, &dst).unwrap();
        std::fs::remove_dir_all(&src).unwrap();
        assert!(dst.join("sub").join("x.md").exists());
        assert!(!src.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// v0.8.5 需求2：删除文件 = 移到回收站——delete_path 成功后原路径消失
    /// （文件进入系统回收站而非永久删除，可从回收站还原）
    #[test]
    fn delete_path_moves_file_to_trash() {
        let dir = std::env::temp_dir().join("lightmd_trash_file_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("a.md");
        std::fs::write(&f, "hello").unwrap();
        delete_path(&f).unwrap();
        assert!(!f.exists(), "删除后原路径应消失（文件已进入回收站）");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// v0.8.5 需求2：删除目录 = 整目录移到回收站——delete_path 成功后原目录消失，
    /// 且与文件走同一 trash::delete 通道（无需按类型分流）
    #[test]
    fn delete_path_moves_dir_to_trash() {
        let dir = std::env::temp_dir().join("lightmd_trash_dir_test");
        let _ = std::fs::remove_dir_all(&dir);
        let sub = dir.join("sub_dir");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("x.md"), "c").unwrap();
        delete_path(&sub).unwrap();
        assert!(!sub.exists(), "删除后原目录应消失（整目录已进入回收站）");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// v0.8.5 需求2：路径不存在时先给出与旧实现一致的友好错误（trash::delete
    /// 对不存在路径也会报错，前置校验统一错误口径）
    #[test]
    fn delete_path_errors_when_missing() {
        let dir = std::env::temp_dir().join("lightmd_trash_missing_test");
        let _ = std::fs::remove_dir_all(&dir);
        let ghost = dir.join("ghost.md");
        let err = delete_path(&ghost).unwrap_err();
        assert!(err.contains("文件不存在"), "错误信息应包含'文件不存在': {}", err);
    }
}
