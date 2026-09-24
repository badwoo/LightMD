/**
 * v0.8.0 WP2 修复2：文件删除后的标签清理辅助
 *
 * 需求：在打开的文件中打开某个文件后，若该文件（或其所属文件夹）被删除，
 * 已打开的标签必须一同消失，不能留下"幽灵标签"。
 *
 * 这里只做纯计算（哪些标签该关），closeTab 的调用交给 App 层，
 * 便于单元测试覆盖父子路径匹配等易错逻辑。
 */

import { isSameOrInsidePath } from "./path";

/**
 * 收集需要因路径删除而关闭的标签下标。
 *
 * - 精确匹配：被删文件自身
 * - 父子匹配：被删文件夹下的所有已打开文件
 * - 空路径（临时标签）永不匹配
 *
 * @returns 升序下标数组；调用方应从后往前关闭以避免索引漂移
 */
export function collectTabsToClose(
  paths: readonly string[],
  deletedPath: string,
): number[] {
  if (!deletedPath) return [];
  const result: number[] = [];
  paths.forEach((p, idx) => {
    if (p && isSameOrInsidePath(p, deletedPath)) result.push(idx);
  });
  return result;
}

// v0.8.2 调整：collectTempTabIndices 已随「打开的文件」栏标题栏关闭按钮移除而删除
// （该栏改为随文件数据自动出现/消失，无需批量关闭入口）
