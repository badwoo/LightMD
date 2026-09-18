/**
 * v0.8.0 WP2 需求6：打开所在文件夹工作区
 *
 * 纯逻辑（不依赖 React），便于单测。UI 组件把 store / 事件派发注入为 deps。
 */
import { getParentDir } from "./path";

export interface OpenWorkspaceDeps {
  /** 当前已打开的文件夹列表（仅需 path 字段） */
  openFolders: { path: string }[];
  /** 判断某路径是否已挂载在侧栏（含其祖先） */
  isPathInOpenFolders: (p: string) => boolean;
  /** 展开某路径及其所有祖先目录 */
  expandTo: (p: string) => void;
  /** 未挂载时挂载该文件夹（通常 dispatch `lightmd:openFolder` 事件） */
  openFolder: (p: string) => void;
  /** 定位高亮某个文件（可选） */
  setActive?: (p: string) => void;
}

export interface OpenWorkspaceResult {
  /** true=已在侧栏挂载（仅展开定位）；false=触发了挂载事件 */
  mounted: boolean;
  /** 文件所在的父目录（即要挂载/已挂载的工作区根） */
  parentDir: string;
}

/**
 * 计算文件所在父目录，并决定是"仅展开定位"还是"派发挂载事件"。
 * 返回 mounted 供调用方决定提示文案。
 */
export function openContainingWorkspace(
  filePath: string,
  deps: OpenWorkspaceDeps,
): OpenWorkspaceResult {
  const parentDir = getParentDir(filePath);
  if (deps.isPathInOpenFolders(parentDir)) {
    deps.expandTo(parentDir);
    deps.setActive?.(filePath);
    return { mounted: true, parentDir };
  }
  deps.openFolder(parentDir);
  return { mounted: false, parentDir };
}
