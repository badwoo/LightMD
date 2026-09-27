export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * v0.9.0：路径**比较键**——分隔符归一 + Windows 语义下大小写不敏感。
 *
 * 用途：把「来自 Rust 的路径」（`lightmd:fileChanged` / `lightmd://folder-changed`
 * 均已在 Rust 侧统一为正斜杠）与「标签里存的路径」比对。
 * 后者可能是反斜杠：原生文件对话框（`@tauri-apps/plugin-dialog` 的 open/save）
 * 返回的是操作系统原生路径，而文件树 / 命令行参数给的是正斜杠。
 *
 * 若不做这层归一，会出现「用对话框打开的文件收不到外部变更/删除联动」——
 * 表现为 `getTabByPath` 匹配失败后静默 return（v0.9.0 实机测试发现的缺陷）。
 */
export function pathCompareKey(p: string): string {
  return normalizePath(p).toLowerCase();
}

/** 两个路径是否指向同一文件（比较键一致） */
export function isSamePath(a: string, b: string): boolean {
  if (!a || !b) return false;
  return pathCompareKey(a) === pathCompareKey(b);
}

/**
 * v0.8.0 WP2：判断 child 是否就是 parent 本身、或位于 parent 目录之内。
 * 用于"删除文件夹 → 关闭其下所有已打开标签"这类父子路径匹配。
 * 统一分隔符并忽略结尾斜杠，保证 "D:/a" / "D:\a\" / "D:/a/b.md" 判断一致。
 * v0.8.0 修复 P2-4：按 Windows 语义做**大小写不敏感**比较，
 * 避免 "D:/Docs" 与 "D:/docs" 指向同一目录却被判为不同而漏关标签。
 */
export function isSameOrInsidePath(child: string, parent: string): boolean {
  if (!child || !parent) return false;
  const c = normalizePath(child).replace(/\/+$/, "").toLowerCase();
  const p = normalizePath(parent).replace(/\/+$/, "").toLowerCase();
  if (!c || !p) return false;
  return c === p || c.startsWith(p + "/");
}

export function getFileName(filePath: string): string {
  const parts = normalizePath(filePath).split("/");
  return parts[parts.length - 1] || "无标题.md";
}

/**
 * v0.8.0 WP2 需求6：从路径提取父目录（兼容 Windows / Unix 路径）。
 * 供 FileTree、workspace 等模块共用（原本散落在各处的本地实现统一收敛到此）。
 */
export function getParentDir(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx > 0 ? normalized.substring(0, idx) : normalized;
}

/**
 * v0.8.0 WP2：拼接路径（兼容 Windows，统一用 "/"）。
 */
export function joinPath(...parts: string[]): string {
  return parts.join("/");
}
