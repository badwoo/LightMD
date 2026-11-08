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
pub async fn write_file(
    window: tauri::WebviewWindow,
    path: String,
    content: String,
) -> Result<(), String> {
    let path = resolve_path(&path)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建父目录 \"{}\": {}", parent.display(), e))?;
    }
    std::fs::write(&path, &content)
        .map_err(|e| format!("写入文件失败 \"{}\": {}", path.display(), e))?;
    // v0.9.0 修复：记录本次自身写入（带写入窗口 label），watcher 事件据此把
    // 「写入窗口的回声」与「其他窗口需要刷新」区分开：
    // - 写入窗口：事件带 source=自己 → 前端忽略，不会误报「文件已被外部修改」
    //   （否则保存即弹「覆盖 / 另存为」、覆盖后再触发，形成无限黄色提示循环）；
    // - 其他窗口（同文件多开）：事件照常处理 → 标签内容立即刷新
    //   （v0.9.0 第四轮问题1：主窗口打开 a，新窗口保存 a，主窗口没刷新）。
    super::super::window::open_files::note_file_written(&path.to_string_lossy(), window.label());
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

/// 构造 Windows `explorer.exe` 的 `/select,` 参数。
///
/// ## v0.15.3 修复：`/select,` 后面必须**紧跟**一个**带引号**的路径
///
/// explorer 不接受"把 `/select,` 与路径分开成两个参数"，也不接受
/// `std::process::Command::arg()` 自动加的那层引号 —— 因为 `arg()` 生成的是
/// `"/select,C:\dir with space\a.md"`：**引号把 `/select,` 一起包住了**，
/// explorer 于是把整个字符串当成**一个路径**，既不是选项也不是有效路径，
/// 结果是**静默失败**：spawn 返回 Ok、无错误提示、资源管理器什么都不做
/// （这正是用户报的"点了没反应"）。
///
/// ### 触发条件：路径**含空格**（实测边界，别扩大也别缩小）
/// `Command::arg()` 走 MSVCRT 引用规则，**只有参数含空格/制表符才加引号**。
/// 所以在旧实现下：
/// - 路径**不含空格**（含纯中文目录）→ 不加引号 → `/select,C:\...` 能work ✅
/// - 路径**含空格**（`D:\AI\markdown view\...`、`LightMD 测试 目录`、
///   `Program Files` 等）→ 整串加引号 → **静默失败** ❌ ← 用户踩的就是这种
///
/// 实测四种形态（目标 `...\LightMD 测试 目录\中文 文件.md`，用 Shell.Application
/// 枚举窗口 + SelectedItems 判定，而非看进程名）：
/// - `arg("/select,"+path)`（旧实现）  → spawn Ok，无窗口、无选中  ❌
/// - `arg("/select,").arg(path)` 两参   → spawn Ok，无窗口、无选中  ❌
/// - `/select,C:\space path`（无引号）  → 空格切断路径            ❌
/// - **`raw_arg("/select,\"path\"")`**  → 打开父目录并选中目标文件 ✅
///
/// 且该形态对「含空格/中文的 `\` 路径」「正斜杠路径」「无空格路径」均有效。
///
/// 因此这里必须用 `raw_arg`：它按字面量塞进命令行，**不**做 MSVCRT 引用，
/// 保证 explorer 收到的是 `/select,"<路径>"`（引号只包住路径本身）。
#[cfg(target_os = "windows")]
fn explorer_select_arg(path: &std::path::Path) -> String {
    format!("/select,\"{}\"", path.display())
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
        use std::os::windows::process::CommandExt;
        // v0.15.3：必须用 raw_arg —— 见 explorer_select_arg 的实测记录。
        // 旧写法 `.arg(format!("/select,{}", ...))` 会让 explorer 静默失败
        // （含空格的路径尤其必踩：引号把 `/select,` 也包进去了）。
        std::process::Command::new("explorer")
            .raw_arg(explorer_select_arg(&path))
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

// ─── v0.16.0：收藏候选范围扩展所需的工作区文件枚举 ─────────────────

/// 「收藏」候选范围扩展（v0.16.0）：递归列出已打开工作区文件夹中的全部文件。
///
/// 前端 `Favorites` 面板点击「+」时，候选 = 已打开标签 ∪ 各工作区文件夹下的文件
/// （含子目录）。本次只负责**提供数据源**：不做扩展名过滤（可打开文本类型的判定
/// 留给前端 `isSupportedTextFile`），也不做内容读取，仅吐 `{ name, path }`。
///
/// 口径与 `list_dir_entries` / `workspace_search::collect_files` 保持一致：
/// - 跳过 `.` 开头的隐藏条目（文件与目录一视同仁，与 `list_dir_entries` 同口径）；
/// - 跳过 `EXCLUDED_DIRS`（大小写不敏感：Windows 下 `Target` / `Node_Modules` 同样命中）；
/// - 目录遍历用**显式栈**（非递归），每个目录用 canonicalize 后的真实路径做环检测，
///   符号链接形成的环不会进入死循环（同一真实目录只访问一次）；
/// - 符号链接指向目录时按目录继续遍历（`entry.metadata()` 跟随链接判定，坏链跳过）；
/// - 返回路径统一正斜杠（`\` → `/`），与 `list_dir_entries` 一致，前端可直接复用；
/// - roots 静默跳过不存在/非目录项；先 canonicalize 去重，再剔除被其它根覆盖的
///   嵌套根（避免同一子树被扫两遍产出重复条目）；
/// - 硬上限 `MAX_WORKSPACE_FILES`：达到立即停止并置 `truncated = true`，
///   防止超大仓库把 IPC 载荷（2 万 × 2 字段）撑爆；
/// - 结果按 `path` 排序，保证同一目录树下多次调用结果确定。
const MAX_WORKSPACE_FILES: usize = 20_000;

/// 明确排除的重目录（不依赖"隐藏目录"规则，因为它们在 Windows 上不一定以 `.` 开头）。
/// 与 `workspace_search::EXCLUDED_DIRS` 同一清单（按大小写不敏感比较）。
const EXCLUDED_DIRS: &[&str] = &["node_modules", "target", "dist", "build", ".git"];

/// 工作区内的一个文件条目（相对「收藏候选」展示所需的最小信息）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileEntry {
    pub name: String,
    pub path: String,
}

/// `list_workspace_files` 的返回载荷：`files` + 是否因上限被截断。
#[derive(Debug, Clone, serde::Serialize)]
pub struct WorkspaceFileList {
    pub files: Vec<WorkspaceFileEntry>,
    pub truncated: bool,
}

/// 递归列出已打开工作区文件夹中的文件（收藏候选范围扩展的数据源）。
///
/// 不存在的根、非目录根一律静默跳过（工作区可能已被删除/移走，不该让收藏面板报错）；
/// 全部根无效时返回空列表而非 `Err`。
#[tauri::command]
pub async fn list_workspace_files(roots: Vec<String>) -> Result<WorkspaceFileList, String> {
    // 与 list_dir 同风格：同步核心逻辑抽成可单测函数，命令只做薄封装
    Ok(list_workspace_files_core(&roots))
}

/// `list_workspace_files` 的同步核心（供命令与单测共用）。
fn list_workspace_files_core(roots: &[String]) -> WorkspaceFileList {
    collect_workspace_files(roots, MAX_WORKSPACE_FILES)
}

/// 实际遍历实现。`max_files` 显式传入（生产用 `MAX_WORKSPACE_FILES`，单测用极小值
/// 验证截断分支，无需真的造 2 万个文件）。
fn collect_workspace_files(roots: &[String], max_files: usize) -> WorkspaceFileList {
    let roots = normalize_workspace_roots(roots);
    let mut files: Vec<WorkspaceFileEntry> = Vec::new();
    let mut truncated = false;
    if roots.is_empty() {
        return WorkspaceFileList { files, truncated };
    }

    // 环检测集合：canonicalize 后的真实目录路径（跨根共享，嵌套根已在上一步剔除）
    let mut visited_dirs: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();

    'outer: for root in &roots {
        // 显式栈：禁止递归函数（超深目录树会爆栈）
        let mut stack: Vec<PathBuf> = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            // 环检测：同一真实目录只访问一次（symlink 环不会无限展开）
            let real = dir.canonicalize().unwrap_or_else(|_| dir.clone());
            if !visited_dirs.insert(real) {
                continue;
            }
            // 读取失败（权限/网络盘等）静默跳过该目录，不影响其它子树
            let entries = match std::fs::read_dir(&dir) {
                Ok(e) => e,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                // 隐藏条目（`.` 开头）文件与目录都跳过（与 list_dir_entries 同口径）
                if name.starts_with('.') {
                    continue;
                }
                let path = entry.path();
                let file_type = match entry.file_type() {
                    Ok(t) => t,
                    Err(_) => continue,
                };
                // 目录判定：file_type 判不出时（符号链接）用 metadata() 跟随链接；
                // 指向目录的链接按目录继续遍历，坏链（metadata 失败）直接跳过
                let is_dir = if file_type.is_dir() {
                    true
                } else if file_type.is_symlink() {
                    match entry.metadata() {
                        Ok(m) => m.is_dir(),
                        Err(_) => continue,
                    }
                } else {
                    false
                };
                if is_dir {
                    // 重目录大小写不敏感比对（Windows 常见 `Target`/`Node_Modules`）
                    if EXCLUDED_DIRS.iter().any(|d| d.eq_ignore_ascii_case(&name)) {
                        continue;
                    }
                    stack.push(path);
                    continue;
                }
                // 硬上限：还有文件未收集时立即停止并标记截断（恰好等于上限不算截断）
                if files.len() >= max_files {
                    truncated = true;
                    break 'outer;
                }
                // 文件（含指向文件的符号链接）
                files.push(WorkspaceFileEntry {
                    name,
                    path: path.to_string_lossy().replace('\\', "/"),
                });
            }
        }
    }

    // 按 path 排序：同一目录树下多次调用结果确定（前端去重/展示都依赖稳定性）
    files.sort_by(|a, b| a.path.cmp(&b.path));
    WorkspaceFileList { files, truncated }
}

/// 规范化 roots：跳过无效项、canonicalize 去重、剔除嵌套根。
///
/// 返回按真实路径排序的根列表（父目录一定排在子孙目录前），因此"先收录的根覆盖
/// 后出现的嵌套根"这条判断可以单向前缀比较，无需双向扫描。
///
/// 返回的根是 canonicalize（跟随符号链接）后**剥掉 Windows 扩展前缀**的绝对路径，
/// 因此遍历产出的 path 一定是绝对路径且不带 `\\?\`（前端相对路径解析依赖这一点）。
fn normalize_workspace_roots(roots: &[String]) -> Vec<PathBuf> {
    // (小写规范路径键, 交给遍历用的根路径)
    let mut candidates: Vec<(String, PathBuf)> = Vec::new();
    for r in roots {
        let p = PathBuf::from(r);
        // 不存在的根、文件根静默跳过（与"全部无效返回空列表"一致）
        if !p.exists() || !p.is_dir() {
            continue;
        }
        let real = p.canonicalize().unwrap_or_else(|_| p.clone());
        let real = PathBuf::from(strip_extended_prefix(&real.to_string_lossy()));
        // Windows 路径大小写不敏感：用小写键做去重/嵌套比较（canonicalize 保留原大小写）
        // 去掉末尾分隔符，让"父目录覆盖子目录"能统一用 `${key}/` 前缀判断
        let key = real
            .to_string_lossy()
            .replace('\\', "/")
            .to_ascii_lowercase()
            .trim_end_matches('/')
            .to_string();
        if candidates.iter().any(|(k, _)| k == &key) {
            continue;
        }
        candidates.push((key, real));
    }
    candidates.sort_by(|a, b| a.0.cmp(&b.0));

    let mut kept: Vec<PathBuf> = Vec::new();
    let mut kept_keys: Vec<String> = Vec::new();
    for (key, root) in candidates {
        // 已被收录的某个根覆盖（前缀 + 分隔符）→ 当前根是嵌套根，跳过
        let covered = kept_keys
            .iter()
            .any(|k| key.starts_with(&format!("{}/", k)));
        if covered {
            continue;
        }
        kept_keys.push(key);
        kept.push(root);
    }
    kept
}

#[cfg(test)]
mod tests {
    use super::*;

    /// v0.15.3 修复：explorer 的 `/select,` 参数必须是 **`/select,"<路径>"`** 形态
    /// （`/select,` 后紧跟一个带引号的路径，引号只包住路径本身）。
    ///
    /// 回归意义：旧实现 `.arg(format!("/select,{}", path))` 让 Command 按 MSVCRT
    /// 规则把**整串**（含 `/select,`）包进引号 → explorer 把整串当路径 → 静默失败
    /// （用户报的"右键打开文件所在目录没反应"）。本测试锁死参数形态，防止改回去。
    #[cfg(target_os = "windows")]
    #[test]
    fn explorer_select_arg_quotes_only_the_path() {
        // 含空格 + 中文的真实场景路径
        let p = std::path::PathBuf::from(r"C:\Users\x\Temp\LightMD 测试 目录\中文 文件.md");
        let arg = explorer_select_arg(&p);
        assert_eq!(
            arg,
            r#"/select,"C:\Users\x\Temp\LightMD 测试 目录\中文 文件.md""#,
            "explorer 参数必须是 /select,\"<path>\"（引号只包路径）"
        );
        // 关键契约：`/select,` 后立刻是引号，且引号成对包住整条路径
        assert!(arg.starts_with("/select,\""), "必须紧跟引号: {}", arg);
        assert!(arg.ends_with('"'), "必须以引号收尾: {}", arg);
        // 不得出现「引号把 /select, 也包进去」的错误形态
        assert!(
            !arg.starts_with("\"/select,"),
            "引号不得包住 /select, 本身（旧 bug 的形态）: {}",
            arg
        );
        // 不得出现无引号的裸路径形态（含空格必被切断）
        assert!(
            !arg.starts_with("/select,C:"),
            "路径必须带引号（含空格的路径无引号会被切断）: {}",
            arg
        );
    }

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

    // ── v0.16.0：list_workspace_files（收藏候选数据源）──

    /// 建一棵固定的测试目录树：
    /// ```text
    /// root/
    ///   a.md              ← 收集
    ///   sub/b.md          ← 收集
    ///   sub/deep/c.md     ← 收集（多层嵌套）
    ///   .hidden.md        ← 跳过（隐藏文件）
    ///   .hidden_dir/d.md  ← 跳过（隐藏目录）
    ///   node_modules/x.md ← 跳过（EXCLUDED_DIRS）
    ///   sub/Target/y.md   ← 跳过（大小写不敏感的 EXCLUDED_DIRS）
    /// ```
    fn build_workspace_tree(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("lightmd_ws_files_{}", tag));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("sub").join("deep")).unwrap();
        std::fs::create_dir_all(root.join(".hidden_dir")).unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::create_dir_all(root.join("sub").join("Target")).unwrap();
        std::fs::write(root.join("a.md"), "a").unwrap();
        std::fs::write(root.join("sub").join("b.md"), "b").unwrap();
        std::fs::write(root.join("sub").join("deep").join("c.md"), "c").unwrap();
        std::fs::write(root.join(".hidden.md"), "h").unwrap();
        std::fs::write(root.join(".hidden_dir").join("d.md"), "d").unwrap();
        std::fs::write(root.join("node_modules").join("x.md"), "x").unwrap();
        std::fs::write(root.join("sub").join("Target").join("y.md"), "y").unwrap();
        root
    }

    fn temp_root_str(p: &std::path::Path) -> String {
        p.to_string_lossy().to_string()
    }

    /// 递归收集：嵌套子目录（含多层）中的文件都被收集，路径为正斜杠绝对路径。
    #[test]
    fn list_workspace_files_collects_nested_files() {
        let root = build_workspace_tree("nested");
        let roots = vec![temp_root_str(&root)];
        let result = list_workspace_files_core(&roots);

        let names: Vec<&str> = result.files.iter().map(|f| f.name.as_str()).collect();
        assert!(names.contains(&"a.md"), "根目录文件应被收集: {:?}", names);
        assert!(names.contains(&"b.md"), "一层子目录文件应被收集: {:?}", names);
        assert!(names.contains(&"c.md"), "多层子目录文件应被收集: {:?}", names);
        assert!(!result.truncated, "小目录树不应触发截断");

        // 路径统一正斜杠、无扩展长度前缀、且是绝对路径
        for f in &result.files {
            assert!(!f.path.contains('\\'), "路径必须为正斜杠: {}", f.path);
            assert!(
                !f.path.starts_with("//?/"),
                "不得泄漏 Windows 扩展长度前缀: {}",
                f.path
            );
            assert!(
                !f.path.contains("/.hidden"),
                "隐藏条目不应出现: {}",
                f.path
            );
        }
        // 结果按 path 排序（确定性）
        let mut sorted = result.files.clone();
        sorted.sort_by(|a, b| a.path.cmp(&b.path));
        let actual: Vec<&str> = result.files.iter().map(|f| f.path.as_str()).collect();
        let expected: Vec<&str> = sorted.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(actual, expected, "结果必须按 path 排序");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 隐藏文件 / 隐藏目录 / EXCLUDED_DIRS（含大小写变体）全部跳过。
    #[test]
    fn list_workspace_files_skips_hidden_and_excluded() {
        let root = build_workspace_tree("skip");
        let result = list_workspace_files_core(&[temp_root_str(&root)]);
        let names: Vec<String> = result.files.iter().map(|f| f.name.clone()).collect();
        assert!(!names.iter().any(|n| n == ".hidden.md"), "隐藏文件应跳过");
        assert!(!names.iter().any(|n| n == "d.md"), "隐藏目录内文件应跳过");
        assert!(!names.iter().any(|n| n == "x.md"), "node_modules 应跳过");
        assert!(
            !names.iter().any(|n| n == "y.md"),
            "Target（大小写变体）应跳过: {:?}",
            names
        );
        assert!(names.iter().any(|n| n == "a.md"), "普通文件应保留");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 重复根（同一目录两种写法）只产出一次；嵌套根不重复扫描。
    #[test]
    fn list_workspace_files_dedups_repeated_and_nested_roots() {
        let root = build_workspace_tree("dedup");
        let sub = root.join("sub");
        let roots = vec![
            temp_root_str(&root),
            // 重复根：末尾多一个分隔符也应识别为同一目录
            format!("{}/", temp_root_str(&root)),
            // 嵌套根：sub 已被 root 覆盖
            temp_root_str(&sub),
        ];
        let result = list_workspace_files_core(&roots);
        let paths: Vec<&str> = result.files.iter().map(|f| f.path.as_str()).collect();
        // 整体不重复（重复根被 canonicalize 去重）
        let mut unique = paths.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(
            unique.len(),
            paths.len(),
            "同一路径不得重复产出: {:?}",
            paths
        );
        // b.md / c.md 只应出现一次（若嵌套根被重复扫描这里会变成两份）
        assert_eq!(
            paths.iter().filter(|p| p.ends_with("/b.md")).count(),
            1,
            "嵌套根与父根同时给出时 b.md 只应出现一次: {:?}",
            paths
        );
        assert_eq!(
            paths.iter().filter(|p| p.ends_with("/c.md")).count(),
            1,
            "c.md 只应出现一次: {:?}",
            paths
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 不存在的根 / 文件根静默跳过：返回空列表且 truncated = false，不报错。
    #[test]
    fn list_workspace_files_missing_roots_return_empty() {
        let dir = std::env::temp_dir().join("lightmd_ws_files_missing");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file_root = dir.join("plain.md");
        std::fs::write(&file_root, "x").unwrap();

        let roots = vec![
            temp_root_str(&dir.join("ghost_dir")),
            temp_root_str(&file_root),
        ];
        let result = list_workspace_files_core(&roots);
        assert!(result.files.is_empty(), "无效根不应产出文件");
        assert!(!result.truncated, "无效根不应标记截断");

        // 全部无效 / 空 roots 同样返回空列表
        let empty = list_workspace_files_core(&[]);
        assert!(empty.files.is_empty() && !empty.truncated);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 硬上限：达上限立即停止并置 truncated = true（用极小上限避免造 2 万个文件）。
    #[test]
    fn collect_workspace_files_marks_truncated_at_limit() {
        let root = build_workspace_tree("truncated");
        // 该树有 3 个应收集文件（a/b/c），上限设 1 → 只收 1 个且 truncated
        let result = collect_workspace_files(&[temp_root_str(&root)], 1);
        assert_eq!(result.files.len(), 1, "达上限应立即停止收集");
        assert!(result.truncated, "达上限必须置 truncated = true");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 上限恰好等于文件数时不应标记截断（避免"刚好 2 万"被误报为不完整）。
    #[test]
    fn collect_workspace_files_no_truncation_at_exact_limit() {
        let root = build_workspace_tree("exact");
        let result = collect_workspace_files(&[temp_root_str(&root)], 3);
        assert_eq!(result.files.len(), 3, "上限等于文件数时应全部收集");
        assert!(!result.truncated, "恰好等于上限不算截断");
        let _ = std::fs::remove_dir_all(&root);
    }
}
