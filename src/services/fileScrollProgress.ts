/**
 * fileScrollProgress —— 按文件路径记录浏览进度（v0.7.0 bug 修复）
 *
 * 需求：切换不同打开的文件（标签页切换）时浏览进度保留；
 * 重新打开该文件（文件树点击/关闭标签后再打开）时进度重置。
 *
 * 设计：
 * - 模块级 Map<path, percent>，scroll 事件实时写入（同 key 覆盖，O(1)）
 * - 标签切换：EditorContainer 读 Map 恢复滚动位置
 * - 重新打开/关闭标签：App 层调用 clear 清除该文件记录
 * - 上限保护：超过 MAX_ENTRIES 删除最旧条目（Map 迭代序 = 插入序），
 *   每条仅一个 number，内存开销可忽略
 */

const progressMap = new Map<string, number>();
const MAX_ENTRIES = 60;

export const fileScrollProgress = {
  /** 读取文件浏览进度（0-1）；无记录返回 null（不恢复，保持顶部） */
  get(path: string | null | undefined): number | null {
    return path ? progressMap.get(path) ?? null : null;
  },

  /** 记录文件浏览进度（scroll 事件实时调用） */
  set(path: string | null | undefined, percent: number): void {
    if (!path) return;
    progressMap.set(path, percent);
    if (progressMap.size > MAX_ENTRIES) {
      const oldest = progressMap.keys().next().value;
      // 防御：oldest === path 时删除自身无意义（单条超限不可能），跳过
      if (oldest !== undefined && oldest !== path) progressMap.delete(oldest);
    }
  },

  /** 清除文件进度（重新打开 / 关闭标签时调用） */
  clear(path: string | null | undefined): void {
    if (path) progressMap.delete(path);
  },
};
