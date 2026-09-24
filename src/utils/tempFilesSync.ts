/**
 * v0.8.2：「打开的文件」栏条目与打开的标签严格同步
 *
 * 问题背景（用户反馈"打开的文件数量与标签数量不一致"、"激活条目选中色不一致"）：
 * 栏内条目此前源自 tempFiles（语义为"不在已打开文件夹下的文件"），与真实打开
 * 的标签集合（openTabs）不是同一来源——打开文件夹内的文件、另存为晋升（promoteTab）
 * 后的文件都不会进 tempFiles；而 lightmd:closeFile 等关闭路径又会漏清理 tempFiles。
 * 两个集合长期漂移即表现为：栏条目数少于标签数、激活标签在栏中找不到对应条目
 * （于是没有任何条目显示选中色）。
 *
 * 方案：以 openTabs 为**唯一真相源**——所有"已打开的真实文件标签"按标签顺序
 * 映射为栏条目；未落盘临时标签（isUntitled，path 恒为空串）由 untitledTabs 单独渲染，
 * 不参与本映射。
 *
 * 这里只做纯计算（对齐结果 + 是否需要更新），store 写入交给调用方，便于单测。
 */

/** 标签侧的最小结构（避免工具函数依赖 store 类型） */
export interface OpenTabLike {
  path: string;
  name: string;
  isUntitled?: boolean;
}

/** 栏条目侧的最小结构 */
export interface TempFileLike {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

export interface TempFilesSyncResult<T extends TempFileLike> {
  /** 对齐后的条目列表（顺序与打开标签一致） */
  next: T[];
  /** 是否与现有列表不同（不同才需要写 store，避免无意义的重渲染） */
  changed: boolean;
}

/**
 * 把「打开的文件」栏条目对齐到打开的标签集合。
 *
 * - 保留已有条目的 size（属性对话框用），新条目 size 取 0；
 * - 名称以标签为准（重命名后标签名是最新的）；
 * - 顺序与标签顺序一致（切换标签时栏内顺序稳定）。
 */
export function syncTempFilesWithTabs<T extends TempFileLike>(
  tempFiles: readonly T[],
  tabs: readonly OpenTabLike[],
): TempFilesSyncResult<T> {
  const prev = new Map<string, T>();
  for (const f of tempFiles) prev.set(f.path, f);

  const next: T[] = [];
  for (const tab of tabs) {
    // 未落盘标签（path 为空且 isUntitled）不属本栏的真实文件条目
    if (tab.isUntitled || !tab.path) continue;
    const old = prev.get(tab.path);
    next.push({
      name: tab.name || old?.name || "",
      path: tab.path,
      isDir: false,
      size: old?.size ?? 0,
    } as T);
  }

  let changed = next.length !== tempFiles.length;
  if (!changed) {
    for (let i = 0; i < next.length; i++) {
      const a = next[i];
      const b = tempFiles[i];
      if (a.path !== b.path || a.name !== b.name || a.size !== b.size) {
        changed = true;
        break;
      }
    }
  }
  return { next, changed };
}